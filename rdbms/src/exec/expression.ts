/**
 * 식의 계산.
 *
 * 담당
 *  - 사칙연산, 문자열 연결(||), 비교, AND, OR, NOT. NULL 은 3값 논리로 다룬다.
 *  - BETWEEN, IN, LIKE (ESCAPE 포함), IS NULL
 *  - CASE (단순형, 검색형), CAST
 *  - 파라미터 `?` 에 바인딩된 값
 *  - 0 으로 나누기, 오버플로 같은 실행 중 오류
 *
 * 값의 비교와 형변환 규칙 자체는 types/ 에 있다. 여기서는 그것을 호출한다.
 * 서브쿼리의 실행은 순환 import 를 피하려고 호출자가 넘긴 핸들러로 한다.
 *
 * 관련 사양 : AGENTS.md 상세 1-2, 1-4
 * 구현 단계 : 6단계
 */

import { DbError, ERROR_CODES, withPosition } from "../common/errors.js";
import type { SourcePosition } from "../common/errors.js";
import type {
  ComparisonOperator,
  Expression,
  IntervalQualifier,
  Query,
} from "../sql/ast.js";
import type { DataType } from "../types/dataType.js";
import {
  BIGINT_TYPE,
  BOOLEAN_TYPE,
  DOUBLE_TYPE,
  INTEGER_TYPE,
  varcharType,
  varbinaryType,
} from "../types/dataType.js";
import { resolveIntervalType } from "../types/dataType.js";
import type { TypeContext } from "../types/cast.js";
import {
  assignValue,
  castLiteral,
  castValue,
  commonType,
} from "../types/cast.js";
import { bindArithmetic, bindConcat, bindNegate } from "../types/arithmetic.js";
import {
  DateValue,
  IntervalValue,
  TimestampValue,
  TimeValue,
  civilFromDays,
  conformInterval,
  parseIntervalText,
  parseTimestampText,
  parseTimeText,
  splitLocalMicros,
  splitTimeOfDay,
} from "../types/datetime.js";
import { Decimal } from "../types/numeric.js";
import {
  invalidCastValue,
  quoteForMessage,
  typeMismatch,
} from "../types/errors.js";
import {
  compareValues,
  conformValue,
  isNotDistinct,
  triAnd,
  triNot,
  triOr,
  trimTrailingSpaces,
} from "../types/value.js";
import type { SqlValue, Tri } from "../types/value.js";
import type { NonNullValue } from "../types/value.js";
import { decodeUtf8 } from "../types/codec.js";
import { aggregateGroup, aggregateResultType, evaluateScalarFunction, inferScalarType, likeMatch, substringValue, trimBoth as trimBothLike } from "./functions.js";
import type { TypedValue } from "./functions.js";

/** 한 테이블 출처의 열 목록이다. */
export interface RowScope {
  readonly tablespace: string | null;
  readonly table: string | null;
  readonly alias: string | null;
  readonly slots: ColumnSlot[];
  /** USING 병합으로 바깥 참조와 * 에서 가린 열이다. 한정 참조는 여전히 보인다. */
  readonly hidden?: readonly string[];
  /** 상관 서브쿼리의 바깥쪽과 안쪽을 구분한다. 클수록 안쪽이다. */
  readonly level?: number;
}

/** 범위 안에서 보이는 열 하나이다. */
export interface ColumnSlot {
  readonly column: string;
  readonly value: SqlValue;
  readonly type: DataType;
}

/** 서브쿼리 실행을 호출자가 넘긴다. 바깥 범위는 스코프 스택으로 전달된다. */
export interface SubqueryHandlers {
  scalar(query: Query): TypedValue;
  exists(query: Query): boolean;
  columnValues(query: Query): { values: SqlValue[]; type: DataType };
}

/** 식을 계산할 때의 문맥이다. */
export interface EvalContext {
  readonly typeCtx: TypeContext;
  readonly params: readonly SqlValue[];
  /** 바깥쪽이 먼저, 안쪽이 나중에 쌓인다. */
  readonly scopes: RowScope[];
  readonly currentUser: string;
  readonly subqueries: SubqueryHandlers;
  /** 타입만 알아볼 때 쓰는 서브쿼리 핸들러이다. 행을 읽지 않는다. */
  readonly typeSubqueries: SubqueryHandlers;
  /** 집계 그룹의 행들. 있을 때만 집계 함수를 계산한다. */
  readonly groupRows?: RowScope[][];
  /** 그룹 한 행의 범위 수이다. 집계 인자를 행마다 계산할 때 바깥 범위와 구분한다. */
  readonly groupWidth?: number;
  /** 타입만 알아볼 때 참이다. 행 데이터 없이 결과 타입을 정한다. */
  readonly typeOnly?: boolean;
  /** DEFAULT 자리에서 호출자가 넘긴다. */
  readonly defaultValue?: () => TypedValue;
}

function at<T>(position: SourcePosition, action: T | (() => T)): T {
  try {
    return typeof action === "function" ? (action as () => T)() : action;
  } catch (error) {
    if (error instanceof DbError && error.position === undefined) throw withPosition(error, position);
    throw error;
  }
}

function fail(sqlState: string, code: number, message: string, position: SourcePosition): never {
  throw withPosition(new DbError(sqlState, code, message), position);
}

/** 위치를 빼고 식을 비교할 수 있게 정규화한다. */
export function stripPositions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPositions);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "position") continue;
      out[key] = stripPositions(child);
    }
    return out;
  }
  return value;
}

/** 두 식이 위치만 빼고 같은지 본다. GROUP BY 검사에 쓴다. */
export function sameExpression(left: Expression, right: Expression): boolean {
  return JSON.stringify(stripPositions(left)) === JSON.stringify(stripPositions(right));
}

/** 식 안에 집계 함수가 있는지 본다. 서브쿼리 안은 내려가지 않는다. */
export function containsAggregate(expression: Expression): boolean {
  switch (expression.kind) {
    case "Function":
      if (isAggregateName(expression.name)) return true;
      return expression.arguments.some(containsAggregate);
    case "Unary":
      return containsAggregate(expression.operand);
    case "Binary":
      return containsAggregate(expression.left) || containsAggregate(expression.right);
    case "Logical":
      return expression.operands.some(containsAggregate);
    case "IsNull":
    case "IsBoolean":
      return containsAggregate(expression.operand);
    case "Between":
      return containsAggregate(expression.operand) || containsAggregate(expression.low) || containsAggregate(expression.high);
    case "InList":
      return containsAggregate(expression.operand) || expression.items.some(containsAggregate);
    case "Like":
      return containsAggregate(expression.operand) || containsAggregate(expression.pattern) || (expression.escape !== null && containsAggregate(expression.escape));
    case "Case":
      return (expression.operand !== null && containsAggregate(expression.operand)) ||
        expression.branches.some((branch) => containsAggregate(branch.when) || containsAggregate(branch.then)) ||
        (expression.otherwise !== null && containsAggregate(expression.otherwise));
    case "Cast":
      return containsAggregate(expression.operand);
    case "Extract":
      return containsAggregate(expression.operand);
    case "Trim":
      return (expression.characters !== null && containsAggregate(expression.characters)) || containsAggregate(expression.operand);
    case "InSubquery":
    case "Exists":
    case "Quantified":
    case "Subquery":
      return false;
    default:
      return false;
  }
}

function isAggregateName(name: string): boolean {
  return name === "COUNT" || name === "SUM" || name === "AVG" || name === "MIN" || name === "MAX";
}

/** 파라미터의 JS 값을 타입과 함께 묶는다. 문자열은 타입 없음으로 둔다. */
function paramTyped(raw: SqlValue): { value: SqlValue; type: DataType | null } {
  if (raw === null) return { value: null, type: null };
  if (typeof raw === "string") return { value: raw, type: null };
  if (typeof raw === "bigint") return { value: raw, type: BIGINT_TYPE };
  if (typeof raw === "number") return { value: raw, type: DOUBLE_TYPE };
  if (typeof raw === "boolean") return { value: raw, type: BOOLEAN_TYPE };
  if (Buffer.isBuffer(raw)) return { value: raw, type: varbinaryType(Math.max(1, raw.length)) };
  if (raw instanceof Decimal) {
    const text = raw.toString();
    const parts = text.replace(/^[+-]/, "").split(".");
    const scale = raw.scale;
    const precision = Math.max(1, (parts[0]?.replace(/^0+/, "").length ?? 0) + scale);
    return { value: raw, type: { kind: "DECIMAL", name: "DECIMAL", precision, scale } };
  }
  if (raw instanceof DateValue) return { value: raw, type: { kind: "DATE", name: "DATE" } };
  if (raw instanceof TimeValue) {
    return {
      value: raw,
      type: raw.offsetMinutes === null
        ? { kind: "TIME", name: "TIME", fractionalPrecision: 0, withTimeZone: false }
        : { kind: "TIME", name: "TIME WITH TIME ZONE", fractionalPrecision: 0, withTimeZone: true },
    };
  }
  if (raw instanceof TimestampValue) {
    return {
      value: raw,
      type: raw.offsetMinutes === null
        ? { kind: "TIMESTAMP", name: "TIMESTAMP", fractionalPrecision: 6, withTimeZone: false }
        : { kind: "TIMESTAMP", name: "TIMESTAMP WITH TIME ZONE", fractionalPrecision: 6, withTimeZone: true },
    };
  }
  if (raw instanceof IntervalValue) {
    return {
      value: raw,
      type: raw.intervalClass === "YEAR_MONTH"
        ? { kind: "INTERVAL", name: "INTERVAL", startField: "YEAR", endField: "MONTH", leadingPrecision: 9, fractionalPrecision: null }
        : { kind: "INTERVAL", name: "INTERVAL", startField: "DAY", endField: "SECOND", leadingPrecision: 9, fractionalPrecision: 6 },
    };
  }
  throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, "Unsupported parameter value.");
}

/** 타입 없는 문자열을 기대 타입으로 해석한다. */
function coerceUntyped(text: string | null, expected: DataType, ctx: EvalContext, position: SourcePosition): SqlValue {
  return at(position, () => castLiteral(text, expected, ctx.typeCtx));
}

/** 수 리터럴의 표기를 값과 타입으로 바꾼다. */
function numberLiteral(text: string, kind: "INTEGER" | "DECIMAL" | "FLOAT", position: SourcePosition): TypedValue {
  if (kind === "FLOAT") {
    const value = Number(text);
    if (!Number.isFinite(value)) {
      fail("22003", 2002, `Numeric value out of range: ${quoteForMessage(text)}.`, position);
    }
    return { value, type: DOUBLE_TYPE };
  }
  if (kind === "DECIMAL") {
    const decimal = at(position, () => Decimal.parse(text));
    const parts = text.replace(/^[+-]/, "").split(".");
    const scale = parts[1]?.length ?? 0;
    const intDigits = (parts[0]?.replace(/^0+/, "").length ?? 0) || 1;
    void intDigits;
    const precision = Math.max(1, (parts[0]?.replace(/^0+/, "")?.length ?? 0) + scale || 1);
    return { value: decimal, type: { kind: "DECIMAL", name: "DECIMAL", precision, scale } };
  }
  try {
    const value = BigInt(text);
    if (value >= -(2n ** 31n) && value <= 2n ** 31n - 1n) {
      return { value, type: INTEGER_TYPE };
    }
    if (value >= -(2n ** 63n) && value <= 2n ** 63n - 1n) {
      return { value, type: { kind: "INTEGER", name: "BIGINT", bits: 64 } };
    }
    const decimal = Decimal.parse(text);
    const precision = Math.max(1, text.replace(/^[+-]/, "").replace(/^0+/, "").length || 1);
    return { value: decimal, type: { kind: "DECIMAL", name: "DECIMAL", precision, scale: 0 } };
  } catch (error) {
    if (error instanceof DbError) throw withPosition(error, position);
    throw error;
  }
}

/** 컬럼 참조를 범위에서 찾는다. 안쪽 범위가 바깥을 가린다. 같은 깊이에 둘이면 모호하다. */
function resolveColumn(
  qualifier: string[],
  name: string,
  scopes: RowScope[],
  position: SourcePosition,
): { value: SqlValue; type: DataType } {
  const matches: { value: SqlValue; type: DataType; level: number }[] = [];
  for (const scope of scopes) {
    // 별칭을 준 출처는 별칭으로만 부른다. `FROM K x` 에서 `K.A` 는 x 를 가리키지 않는다.
    // (같은 테이블을 두 번 쓰는 자기 조인에서 테이블 이름이 두 출처에 모두 맞아 모호해지지 않게 한다)
    const visibleName = scope.alias ?? scope.table;
    if (qualifier.length === 2) {
      if (!(scope.tablespace === qualifier[0] && visibleName === qualifier[1])) continue;
    } else if (qualifier.length === 1) {
      if (visibleName !== qualifier[0]) continue;
    }
    for (const slot of scope.slots) {
      if (scope.hidden?.includes(slot.column) && qualifier.length === 0) continue;
      if (slot.column === name) matches.push({ value: slot.value, type: slot.type, level: scope.level ?? 0 });
    }
  }
  if (matches.length === 0) {
    fail("42703", ERROR_CODES.COLUMN_NOT_FOUND, `Column does not exist: "${name}".`, position);
  }
  const deepest = Math.max(...matches.map((match) => match.level));
  const candidates = matches.filter((match) => match.level === deepest);
  if (candidates.length > 1) {
    fail("42702", ERROR_CODES.AMBIGUOUS_COLUMN, `Column is ambiguous: "${name}".`, position);
  }
  return candidates[0] as { value: SqlValue; type: DataType };
}

/** 비교의 공통 타입을 정한다. 타입 없는 문자열은 상대에 맞춘다. */
function comparisonCommon(
  left: TypedValue,
  leftUntyped: string | null,
  right: TypedValue,
  rightUntyped: string | null,
  ctx: EvalContext,
  position: SourcePosition,
): { left: SqlValue; right: SqlValue; type: DataType } {
  let leftType = left.type;
  let rightType = right.type;
  let leftValue = left.value;
  let rightValue = right.value;
  if (leftUntyped !== null && rightUntyped !== null) {
    const common = commonType(varcharType(Math.max(1, leftUntyped.length)), varcharType(Math.max(1, rightUntyped.length)));
    void common;
    return { left: leftUntyped, right: rightUntyped, type: varcharType(1) };
  }
  if (leftUntyped !== null) {
    leftValue = coerceUntyped(leftUntyped, rightType, ctx, position);
    leftType = rightType;
  }
  if (rightUntyped !== null) {
    rightValue = coerceUntyped(rightUntyped, leftType, ctx, position);
    rightType = leftType;
  }
  const common = commonType(leftType, rightType);
  if (common === null) {
    throw at(position, () => typeMismatch(`Cannot compare ${leftType.name} and ${rightType.name}.`));
  }
  const leftCasted = leftValue === null ? null : at(position, () => castValue(leftValue, leftType, common, ctx.typeCtx));
  const rightCasted = rightValue === null ? null : at(position, () => castValue(rightValue, rightType, common, ctx.typeCtx));
  return { left: leftCasted, right: rightCasted, type: common };
}

/** 안쪽 범위를 바깥보다 한 단계 깊게 둔다. */
export function atInnerLevel(outer: RowScope[], inner: RowScope[]): RowScope[] {
  let level = -1;
  for (const scope of outer) {
    if ((scope.level ?? -1) > level) level = scope.level as number;
  }
  return inner.map((scope) => ({ ...scope, level: level + 1 }));
}

/** 식을 평가한다. 기대 타입이 있으면 타입 없는 문자열과 리터럴을 그에 맞춘다. */
export function evaluateExpression(expression: Expression, ctx: EvalContext, expectedType?: DataType): TypedValue {
  switch (expression.kind) {
    case "Literal": {
      if (expression.type === "NULL") {
        return { value: null, type: expectedType ?? varcharType(1) };
      }
      if (expression.type === "BOOLEAN") {
        return { value: expression.value, type: BOOLEAN_TYPE };
      }
      if (expression.type === "STRING") {
        if (expectedType !== undefined) {
          return { value: coerceUntyped(expression.value, expectedType, ctx, expression.position), type: expectedType };
        }
        if (ctx.typeOnly) {
          return { value: expression.value, type: varcharType(Math.max(1, [...expression.value].length)) };
        }
        return { value: expression.value, type: null as unknown as DataType, untyped: expression.value } as TypedValue & { untyped: string } as unknown as TypedValue;
      }
      if (expression.type === "BINARY") {
        const bytes = Buffer.from(expression.hex, "hex");
        const type = varbinaryType(Math.max(1, bytes.length));
        if (expectedType !== undefined) {
          return { value: at(expression.position, () => conformValue(bytes, expectedType)), type: expectedType };
        }
        return { value: bytes, type };
      }
      if (expression.type === "INTEGER" || expression.type === "DECIMAL" || expression.type === "FLOAT") {
        const bound = numberLiteral(expression.text, expression.type, expression.position);
        if (expectedType !== undefined) {
          const assigned = at(expression.position, () => assignValue(bound.value, bound.type, expectedType, ctx.typeCtx));
          return { value: assigned, type: expectedType };
        }
        return bound;
      }
      if (expression.type === "DATE" || expression.type === "TIME" || expression.type === "TIMESTAMP") {
        const bound = datetimeLiteral(expression as { type: "DATE" | "TIME" | "TIMESTAMP"; text: string; withTimeZone: boolean | null }, ctx, expectedType);
        return bound;
      }
      const boundInterval = intervalLiteral(expression as unknown as { text: string; qualifier: IntervalQualifier }, ctx);
      if (expectedType !== undefined && expectedType.kind === "INTERVAL") {
        const conformed = at(expression.position, () => conformValue(boundInterval.value, expectedType));
        return { value: conformed, type: expectedType };
      }
      return boundInterval;
    }
    case "Parameter": {
      const raw = ctx.params[expression.index - 1] as SqlValue;
      const param = paramTyped(raw);
      if (param.type === null) {
        if (expectedType !== undefined) {
          return { value: coerceUntyped(param.value as string, expectedType, ctx, expression.position), type: expectedType };
        }
        if (ctx.typeOnly) {
          const text = param.value as string;
          return { value: text, type: varcharType(Math.max(1, [...text].length)) };
        }
        return { value: param.value, type: null as unknown as DataType } as TypedValue;
      }
      if (expectedType !== undefined) {
        if (typeof param.value === "string") {
          return { value: coerceUntyped(param.value, expectedType, ctx, expression.position), type: expectedType };
        }
        const assigned = at(expression.position, () => assignValue(param.value, param.type as DataType, expectedType, ctx.typeCtx));
        return { value: assigned, type: expectedType };
      }
      return { value: param.value, type: param.type as DataType };
    }
    case "Column": {
      const found = resolveColumn(expression.qualifier, expression.name, ctx.scopes, expression.position);
      if (expectedType !== undefined && found.value !== null) {
        // INSERT 대입처럼 기대 타입이 있으면 그에 맞춘다. (같은 계열만)
        try {
          const assigned = castValue(found.value, found.type, expectedType, ctx.typeCtx);
          return { value: assigned, type: expectedType };
        } catch {
          return found;
        }
      }
      return found;
    }
    case "Unary": {
      if (expression.operator === "NOT") {
        const tri = evaluateCondition(expression.operand, ctx);
        return { value: triNot(tri), type: BOOLEAN_TYPE };
      }
      if (ctx.typeOnly) {
        const operandType = inferNullType(expression.operand, ctx);
        if (expression.operator === "+") {
          if (operandType.kind !== "INTEGER" && operandType.kind !== "DECIMAL" && operandType.kind !== "FLOAT" && operandType.kind !== "INTERVAL") {
            throw at(expression.position, typeMismatch(`Operator + is not defined for ${operandType.name}.`));
          }
          return { value: null, type: operandType };
        }
        const operation = at(expression.position, () => bindNegate(operandType));
        return { value: null, type: operation.resultType };
      }
      const operand = evaluateExpression(expression.operand, ctx);
      if (operand.value === null) return { value: null, type: (operand.type as DataType) ?? DOUBLE_TYPE };
      if (expression.operator === "+") {
        if (operand.type.kind !== "INTEGER" && operand.type.kind !== "DECIMAL" && operand.type.kind !== "FLOAT" && operand.type.kind !== "INTERVAL") {
          throw at(expression.position, typeMismatch(`Operator + is not defined for ${operand.type.name}.`));
        }
        return operand;
      }
      const operation = at(expression.position, () => bindNegate(operand.type));
      return { value: operation.evaluate(operand.value), type: operation.resultType };
    }
    case "Binary": {
      return evaluateBinary(expression, ctx, expectedType);
    }
    case "Logical": {
      let result: Tri = expression.operator === "AND" ? true : false;
      for (const operand of expression.operands) {
        const tri = evaluateCondition(operand, ctx);
        result = expression.operator === "AND" ? triAnd(result, tri) : triOr(result, tri);
        if (expression.operator === "AND" && result === false) break;
        if (expression.operator === "OR" && result === true) break;
      }
      return { value: result, type: BOOLEAN_TYPE };
    }
    case "IsNull": {
      const operand = evaluateExpression(expression.operand, ctx);
      const isNull = operand.value === null;
      return { value: expression.negated ? !isNull : isNull, type: BOOLEAN_TYPE };
    }
    case "IsBoolean": {
      const operand = evaluateExpression(expression.operand, ctx);
      let actual: boolean | null;
      if (operand.value === null) actual = null;
      else if (typeof operand.value === "boolean") actual = operand.value;
      else throw at(expression.position, typeMismatch(`IS test needs a boolean value, but got ${operand.type.name}.`));
      const expected: boolean | null = expression.value;
      const matched = actual === expected;
      return { value: expression.negated ? !matched : matched, type: BOOLEAN_TYPE };
    }
    case "Between": {
      return evaluateBetween(expression, ctx);
    }
    case "InList": {
      return evaluateInList(expression, ctx);
    }
    case "Like": {
      const operand = evaluateExpression(expression.operand, ctx);
      const pattern = evaluateExpression(expression.pattern, ctx);
      const escape = expression.escape === null ? null : evaluateExpression(expression.escape, ctx);
      if (operand.value === null || pattern.value === null || (escape !== null && escape.value === null)) {
        return { value: null, type: BOOLEAN_TYPE };
      }
      if (typeof operand.value !== "string" || typeof pattern.value !== "string" || (escape !== null && typeof escape.value !== "string")) {
        throw at(expression.position, typeMismatch("LIKE needs character values."));
      }
      const matched = at(expression.position, () => likeMatch(operand.value as string, pattern.value as string, escape === null ? null : (escape.value as string)));
      return { value: expression.negated ? !matched : matched, type: BOOLEAN_TYPE };
    }
    case "Exists": {
      const found = ctx.subqueries.exists(expression.query);
      return { value: found, type: BOOLEAN_TYPE };
    }
    case "InSubquery": {
      return evaluateInSubquery(expression.operand, expression.query, expression.negated, ctx, expression.position);
    }
    case "Quantified": {
      return evaluateQuantified(expression, ctx);
    }
    case "Subquery": {
      return ctx.subqueries.scalar(expression.query);
    }
    case "Case": {
      return evaluateCase(expression, ctx, expectedType);
    }
    case "Cast": {
      const operand = evaluateExpression(expression.operand, ctx);
      if (operand.value === null) return { value: null, type: expression.dataType };
      // 타입 없는 문자열은 리터럴 해석을 쓴다.
      const untyped = (operand as TypedValue & { untyped?: string }).untyped;
      if (untyped !== undefined) {
        return { value: at(expression.position, () => castLiteral(untyped, expression.dataType, ctx.typeCtx)), type: expression.dataType };
      }
      return { value: at(expression.position, () => castValue(operand.value, operand.type, expression.dataType, ctx.typeCtx)), type: expression.dataType };
    }
    case "Function": {
      return evaluateFunctionNode(expression, ctx, expectedType);
    }
    case "Extract": {
      if (ctx.typeOnly) {
        const operandType = inferNullType(expression.operand, ctx);
        validateExtractField(expression.field, operandType, expression.position);
        return { value: null, type: BIGINT_TYPE };
      }
      const operand = evaluateExpression(expression.operand, ctx);
      if (operand.value === null) return { value: null, type: BIGINT_TYPE };
      return { value: at(expression.position, () => extractField(expression.field, operand.value as NonNullValue, operand.type)), type: BIGINT_TYPE };
    }
    case "Trim": {
      const operand = evaluateExpression(expression.operand, ctx);
      const chars = expression.characters === null ? null : evaluateExpression(expression.characters, ctx);
      if (operand.value === null || (chars !== null && chars.value === null)) {
        return { value: null, type: operand.type.kind === "CHAR" || operand.type.kind === "VARCHAR" ? operand.type : varcharType(1) };
      }
      if (typeof operand.value !== "string") throw at(expression.position, typeMismatch("TRIM needs a character value."));
      const set = chars === null ? " " : asTrimSet(chars.value as NonNullValue);
      const out = trimBothLike(operand.value, set, expression.side !== "TRAILING", expression.side !== "LEADING");
      void trimTrailingSpaces;
      return { value: out, type: operand.type };
    }
    case "Default": {
      if (ctx.defaultValue === undefined) {
        fail("42601", ERROR_CODES.SYNTAX_ERROR, "DEFAULT can only be used as a value in INSERT ... VALUES or UPDATE ... SET.", expression.position);
      }
      const resolved = ctx.defaultValue();
      if (expectedType !== undefined && resolved.value !== null) {
        return { value: at(expression.position, () => assignValue(resolved.value, resolved.type, expectedType, ctx.typeCtx)), type: expectedType };
      }
      return resolved;
    }
  }
}

/** 타입 없는 문자열인지 본다. 리터럴과 문자열 파라미터가 여기에 든다. */
function untypedText(bound: TypedValue): string | null {
  const extra = (bound as TypedValue & { untyped?: string }).untyped;
  if (extra !== undefined) return extra;
  if (bound.type === null as unknown as DataType && typeof bound.value === "string") return bound.value;
  return null;
}

function evaluateBinary(
  expression: { operator: string; left: Expression; right: Expression; position: SourcePosition },
  ctx: EvalContext,
  expectedType?: DataType,
): TypedValue {
  const operator = expression.operator;
  if (ctx.typeOnly) {
    return evaluateBinaryTypeOnly(expression, ctx);
  }
  if (operator === "||") {
    const left = evaluateExpression(expression.left, ctx);
    const right = evaluateExpression(expression.right, ctx);
    if (left.value === null || right.value === null) {
      const bound = at(expression.position, () => bindConcatForNull(left.type, right.type));
      return { value: null, type: bound };
    }
    const leftText = untypedText(left);
    const rightText = untypedText(right);
    const leftTyped: TypedValue = leftText !== null ? { value: leftText, type: varcharType(Math.max(1, leftText.length)) } : left;
    const rightTyped: TypedValue = rightText !== null ? { value: rightText, type: varcharType(Math.max(1, rightText.length)) } : right;
    const operation = at(expression.position, () => bindConcat(leftTyped.type, rightTyped.type));
    return { value: operation.evaluate(leftTyped.value, rightTyped.value, ctx.typeCtx), type: operation.resultType };
  }
  if (operator === "=" || operator === "<>" || operator === "<" || operator === "<=" || operator === ">" || operator === ">=") {
    return evaluateComparison(expression as { operator: ComparisonOperator; left: Expression; right: Expression; position: SourcePosition }, ctx);
  }
  // 사칙연산
  let left = evaluateExpression(expression.left, ctx);
  let right = evaluateExpression(expression.right, ctx);
  const leftText = untypedText(left);
  const rightText = untypedText(right);
  if (leftText !== null && rightText !== null) {
    // 둘 다 타입 없으면 수로 읽어 본다. 안 되면 문자열 연산이 아니므로 오류이다.
    const coerced = coerceBothUntyped(leftText, rightText, expression.position);
    left = coerced.left;
    right = coerced.right;
  } else if (leftText !== null) {
    left = { value: at(expression.position, () => castLiteral(leftText, right.type, ctx.typeCtx)), type: right.type };
  } else if (rightText !== null) {
    right = { value: at(expression.position, () => castLiteral(rightText, left.type, ctx.typeCtx)), type: left.type };
  }
  const operation = at(expression.position, () => bindArithmetic(operator as "+" | "-" | "*" | "/", left.type, right.type));
  const value = operation.evaluate(left.value, right.value, ctx.typeCtx);
  if (expectedType !== undefined && value !== null) {
    return { value: at(expression.position, () => assignValue(value, operation.resultType, expectedType, ctx.typeCtx)), type: expectedType };
  }
  return { value, type: operation.resultType };
}

/** 행 없이 이항 연산의 결과 타입만 정한다. */
function evaluateBinaryTypeOnly(
  expression: { operator: string; left: Expression; right: Expression; position: SourcePosition },
  ctx: EvalContext,
): TypedValue {
  const operator = expression.operator;
  const leftType = inferNullType(expression.left, ctx);
  const rightType = inferNullType(expression.right, ctx);
  if (operator === "||") {
    const left = leftType.kind === "CHAR" || leftType.kind === "VARCHAR" ? leftType : varcharType(1);
    const right = rightType.kind === "CHAR" || rightType.kind === "VARCHAR" ? rightType : varcharType(1);
    try {
      return { value: null, type: bindConcat(left, right).resultType };
    } catch {
      return { value: null, type: varcharType(1) };
    }
  }
  if (operator === "=" || operator === "<>" || operator === "<" || operator === "<=" || operator === ">" || operator === ">=") {
    const common = commonType(leftType, rightType);
    if (common === null) {
      throw at(expression.position, typeMismatch(`Cannot compare ${leftType.name} and ${rightType.name}.`));
    }
    return { value: null, type: BOOLEAN_TYPE };
  }
  const operation = at(expression.position, () => bindArithmetic(operator as "+" | "-" | "*" | "/", leftType, rightType));
  return { value: null, type: operation.resultType };
}

function bindConcatForNull(leftType: DataType | null, rightType: DataType | null): DataType {
  const left = (leftType ?? varcharType(1)) as DataType;
  const right = (rightType ?? varcharType(1)) as DataType;
  try {
    return bindConcat(left, right).resultType;
  } catch {
    return varcharType(1);
  }
}

function coerceBothUntyped(leftText: string, rightText: string, position: SourcePosition): { left: TypedValue; right: TypedValue } {
  // 정수 표기면 정수로, 그 밖의 수 표기면 DECIMAL 로, 아니면 오류이다.
  const coerceOne = (text: string): TypedValue => {
    if (/^[+-]?\d+$/.test(text.trim())) {
      const bound = numberLiteral(text.trim(), "INTEGER", position);
      return bound;
    }
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text.trim())) {
      const bound = numberLiteral(text.trim(), "DECIMAL", position);
      return bound;
    }
    throw withPosition(typeMismatch(`Operator is not defined for character values: ${quoteForMessage(text)}.`), position);
  };
  return { left: coerceOne(leftText), right: coerceOne(rightText) };
}

function evaluateComparison(
  expression: { operator: ComparisonOperator; left: Expression; right: Expression; position: SourcePosition },
  ctx: EvalContext,
): TypedValue {
  const left = evaluateExpression(expression.left, ctx);
  const right = evaluateExpression(expression.right, ctx);
  // NULL이 섞이면 UNKNOWN이다. 타입이 달라도 오류가 아니다.
  if (left.value === null || right.value === null) return { value: null, type: BOOLEAN_TYPE };
  const leftText = untypedText(left);
  const rightText = untypedText(right);
  const merged = comparisonCommon(
    { value: left.value, type: left.type ?? varcharType(1) },
    leftText,
    { value: right.value, type: right.type ?? varcharType(1) },
    rightText,
    ctx,
    expression.position,
  );
  if (merged.left === null || merged.right === null) return { value: null, type: BOOLEAN_TYPE };
  const bothChar = merged.type.kind === "CHAR";
  void bothChar;
  // CHAR 끼리일 때만 뒤쪽 공백을 무시한다. 공통 타입이 CHAR 일 때가 그 경우이다.
  const order = at(expression.position, () =>
    compareValues(merged.left as NonNullValue, merged.right as NonNullValue, { ignoreTrailingSpaces: merged.type.kind === "CHAR" }),
  );
  let result: boolean;
  switch (expression.operator) {
    case "=":
      result = order === 0;
      break;
    case "<>":
      result = order !== 0;
      break;
    case "<":
      result = order < 0;
      break;
    case "<=":
      result = order <= 0;
      break;
    case ">":
      result = order > 0;
      break;
    case ">=":
      result = order >= 0;
      break;
  }
  return { value: result, type: BOOLEAN_TYPE };
}

/** 조건을 3값 논리로 계산한다. BOOLEAN 이 아니면 오류이다. */
export function evaluateCondition(expression: Expression, ctx: EvalContext): Tri {
  const bound = evaluateExpression(expression, ctx);
  if (bound.value === null) return null;
  if (typeof bound.value !== "boolean") {
    throw withPosition(typeMismatch(`Condition needs a boolean value, but got ${bound.type.name}.`), (expression as { position: SourcePosition }).position);
  }
  return bound.value;
}

function evaluateBetween(
  expression: { operand: Expression; low: Expression; high: Expression; negated: boolean; position: SourcePosition },
  ctx: EvalContext,
): TypedValue {
  const operand = evaluateExpression(expression.operand, ctx);
  const low = evaluateExpression(expression.low, ctx);
  const high = evaluateExpression(expression.high, ctx);
  // NULL이 섞이면 UNKNOWN이다.
  if (operand.value === null || low.value === null || high.value === null) {
    return { value: null, type: BOOLEAN_TYPE };
  }
  // 공통 타입을 정한다. 타입 없는 문자열은 상대에 맞춘다.
  let operandType = operand.type;
  let lowType = low.type;
  let highType = high.type;
  let operandValue = operand.value;
  let lowValue = low.value;
  let highValue = high.value;
  const operandText = untypedText(operand);
  const lowText = untypedText(low);
  const highText = untypedText(high);
  const typed: TypedValue[] = [
    { value: operandValue, type: operandType },
    { value: lowValue, type: lowType },
    { value: highValue, type: highType },
  ];
  const texts = [operandText, lowText, highText];
  // 타입 있는 것끼리 공통 타입을 먼저 정한다.
  let common: DataType | null = null;
  for (let i = 0; i < 3; i++) {
    if (texts[i] !== null) continue;
    const type = typed[i]?.type as DataType;
    common = common === null ? type : commonType(common, type);
    if (common === null) throw at(expression.position, typeMismatch("BETWEEN got incompatible types."));
  }
  if (common === null) {
    // 셋 다 타입 없으면 문자열로 본다.
    common = varcharType(1);
  }
  const coerced = [0, 1, 2].map((i) => {
    const text = texts[i] ?? null;
    if (text !== null) return at(expression.position, () => castLiteral(text, common as DataType, ctx.typeCtx));
    const entry = typed[i] as TypedValue;
    return entry.value === null ? null : at(expression.position, () => castValue(entry.value, entry.type, common as DataType, ctx.typeCtx));
  });
  const [value, lo, hi] = coerced as SqlValue[];
  if (value === null || lo === null || hi === null) return { value: null, type: BOOLEAN_TYPE };
  const bothChar = (common as DataType).kind === "CHAR";
  const lowOrder = compareValues(value as NonNullValue, lo as NonNullValue, { ignoreTrailingSpaces: bothChar });
  const highOrder = compareValues(value as NonNullValue, hi as NonNullValue, { ignoreTrailingSpaces: bothChar });
  const matched = lowOrder >= 0 && highOrder <= 0;
  return { value: expression.negated ? !matched : matched, type: BOOLEAN_TYPE };
}

function evaluateInList(
  expression: { operand: Expression; items: Expression[]; negated: boolean; position: SourcePosition },
  ctx: EvalContext,
): TypedValue {
  const operand = evaluateExpression(expression.operand, ctx);
  // NULL은 어떤 목록과 비교해도 UNKNOWN이다.
  if (operand.value === null) return { value: null, type: BOOLEAN_TYPE };
  const items = expression.items.map((item) => evaluateExpression(item, ctx));
  let common: DataType | null = operand.type;
  const consider = (bound: TypedValue, text: string | null): void => {
    if (text !== null || bound.value === null) return;
    common = common === null ? bound.type : commonType(common, bound.type);
    if (common === null) throw at(expression.position, typeMismatch("IN got incompatible types."));
  };
  consider(operand, untypedText(operand));
  for (const item of items) consider(item, untypedText(item));
  if (common === null) common = varcharType(1);
  const finalCommon = common;
  const coerce = (bound: TypedValue): SqlValue => {
    const text = untypedText(bound);
    if (text !== null) return at(expression.position, () => castLiteral(text, finalCommon, ctx.typeCtx));
    return bound.value === null ? null : at(expression.position, () => castValue(bound.value, bound.type, finalCommon, ctx.typeCtx));
  };
  const target = coerce(operand);
  let unknown = false;
  for (const item of items) {
    const candidate = coerce(item);
    if (target === null || candidate === null) {
      unknown = true;
      continue;
    }
    const order = compareValues(target as NonNullValue, candidate as NonNullValue, { ignoreTrailingSpaces: finalCommon.kind === "CHAR" });
    if (order === 0) return { value: expression.negated ? false : true, type: BOOLEAN_TYPE };
  }
  if (unknown) return { value: null, type: BOOLEAN_TYPE };
  return { value: expression.negated ? true : false, type: BOOLEAN_TYPE };
}

function evaluateInSubquery(
  operand: Expression,
  query: Query,
  negated: boolean,
  ctx: EvalContext,
  position: SourcePosition,
): TypedValue {
  const left = evaluateExpression(operand, ctx);
  const { values, type } = ctx.subqueries.columnValues(query);
  const leftText = untypedText(left);
  const common = leftText !== null ? type : commonType(left.type, type);
  if (common === null) throw at(position, typeMismatch("IN got incompatible types."));
  const target = leftText !== null
    ? at(position, () => castLiteral(leftText, type, ctx.typeCtx))
    : left.value === null
      ? null
      : at(position, () => castValue(left.value, left.type, common, ctx.typeCtx));
  const coercedType = leftText !== null ? type : (common as DataType);
  let unknown = false;
  for (const candidate of values) {
    if (target === null || candidate === null) {
      unknown = true;
      continue;
    }
    const order = compareValues(target as NonNullValue, candidate as NonNullValue, { ignoreTrailingSpaces: coercedType.kind === "CHAR" });
    if (order === 0) return { value: negated ? false : true, type: BOOLEAN_TYPE };
  }
  if (unknown) return { value: null, type: BOOLEAN_TYPE };
  return { value: negated ? true : false, type: BOOLEAN_TYPE };
}

function evaluateQuantified(
  expression: { operator: ComparisonOperator; quantifier: "ANY" | "ALL"; operand: Expression; query: Query; position: SourcePosition },
  ctx: EvalContext,
): TypedValue {
  const left = evaluateExpression(expression.operand, ctx);
  const { values, type } = ctx.subqueries.columnValues(expression.query);
  const leftText = untypedText(left);
  const common = leftText !== null ? type : commonType(left.type, type);
  if (common === null) throw at(expression.position, typeMismatch("Quantified comparison got incompatible types."));
  const target = leftText !== null
    ? at(expression.position, () => castLiteral(leftText, type, ctx.typeCtx))
    : left.value === null
      ? null
      : at(expression.position, () => castValue(left.value, left.type, common, ctx.typeCtx));
  const coercedType = leftText !== null ? type : (common as DataType);
  const compareOne = (candidate: SqlValue): boolean | null => {
    if (target === null || candidate === null) return null;
    const order = compareValues(target as NonNullValue, candidate as NonNullValue, { ignoreTrailingSpaces: coercedType.kind === "CHAR" });
    switch (expression.operator) {
      case "=":
        return order === 0;
      case "<>":
        return order !== 0;
      case "<":
        return order < 0;
      case "<=":
        return order <= 0;
      case ">":
        return order > 0;
      case ">=":
        return order >= 0;
    }
  };
  if (expression.quantifier === "ANY") {
    let unknown = false;
    for (const candidate of values) {
      const result = compareOne(candidate);
      if (result === true) return { value: true, type: BOOLEAN_TYPE };
      if (result === null) unknown = true;
    }
    return { value: unknown ? null : false, type: BOOLEAN_TYPE };
  }
  let unknown = false;
  for (const candidate of values) {
    const result = compareOne(candidate);
    if (result === false) return { value: false, type: BOOLEAN_TYPE };
    if (result === null) unknown = true;
  }
  return { value: unknown ? null : true, type: BOOLEAN_TYPE };
}

function evaluateCase(
  expression: { operand: Expression | null; branches: { when: Expression; then: Expression }[]; otherwise: Expression | null; position: SourcePosition },
  ctx: EvalContext,
  expectedType?: DataType,
): TypedValue {
  let common: DataType | null = expectedType ?? null;
  // THEN과 ELSE의 공통 타입을 먼저 정한다. 값은 계산하지 않고 타입만 본다.
  for (const branch of expression.branches) {
    const branchType = inferNullType(branch.then, ctx);
    common = common === null ? branchType : commonType(common, branchType);
    if (common === null) throw at(expression.position, typeMismatch("CASE got incompatible types."));
  }
  if (expression.otherwise !== null) {
    const otherwiseType = inferNullType(expression.otherwise, ctx);
    common = common === null ? otherwiseType : commonType(common, otherwiseType);
    if (common === null) throw at(expression.position, typeMismatch("CASE got incompatible types."));
  }
  if (common === null) common = expectedType ?? varcharType(1);
  const finalCommon = common;
  const coerce = (bound: TypedValue, text: string | null): SqlValue => {
    if (text !== null) return at(expression.position, () => castLiteral(text, finalCommon, ctx.typeCtx));
    return bound.value === null ? null : at(expression.position, () => castValue(bound.value, bound.type, finalCommon, ctx.typeCtx));
  };
  if (expression.operand !== null) {
    const operand = evaluateExpression(expression.operand, ctx);
    const operandText = untypedText(operand);
    for (const branch of expression.branches) {
      const when = evaluateExpression(branch.when, ctx);
      const whenText = untypedText(when);
      // 단순형은 = 비교와 같다.
      const pairCommon = operandText !== null && whenText !== null
        ? varcharType(1)
        : operandText !== null
          ? when.type
          : whenText !== null
            ? operand.type
            : commonType(operand.type, when.type);
      if (pairCommon === null) throw at(expression.position, typeMismatch("CASE got incompatible types."));
      const left = operandText !== null
        ? at(expression.position, () => castLiteral(operandText, when.type, ctx.typeCtx))
        : operand.value === null ? null : at(expression.position, () => castValue(operand.value, operand.type, pairCommon, ctx.typeCtx));
      const right = whenText !== null
        ? at(expression.position, () => castLiteral(whenText, operandText !== null ? varcharType(1) : operand.type, ctx.typeCtx))
        : when.value === null ? null : at(expression.position, () => castValue(when.value, when.type, pairCommon, ctx.typeCtx));
      if (left === null || right === null) continue;
      const order = compareValues(left as NonNullValue, right as NonNullValue, { ignoreTrailingSpaces: pairCommon.kind === "CHAR" });
      if (order === 0) {
        const then = evaluateExpression(branch.then, ctx);
        return { value: coerce(then, untypedText(then)), type: finalCommon };
      }
    }
  } else {
    for (const branch of expression.branches) {
      const condition = evaluateCondition(branch.when, ctx);
      if (condition === true) {
        const then = evaluateExpression(branch.then, ctx);
        return { value: coerce(then, untypedText(then)), type: finalCommon };
      }
    }
  }
  if (expression.otherwise === null) return { value: null, type: finalCommon };
  const otherwise = evaluateExpression(expression.otherwise, ctx);
  return { value: coerce(otherwise, untypedText(otherwise)), type: finalCommon };
}

function evaluateFunctionNode(
  expression: { name: string; arguments: Expression[]; distinct: boolean; star: boolean; position: SourcePosition },
  ctx: EvalContext,
  expectedType?: DataType,
): TypedValue {
  if (isAggregateName(expression.name)) {
    return evaluateAggregate(expression, ctx);
  }
  const args = expression.arguments.map((arg) => evaluateExpression(arg, ctx));
  if (ctx.typeOnly) {
    try {
      return { value: null, type: inferScalarType(expression.name, args.map((arg) => arg.type)) };
    } catch (error) {
      if (error instanceof DbError && error.position === undefined) throw withPosition(error, expression.position);
      throw error;
    }
  }
  const computed = at(expression.position, () =>
    evaluateScalarFunction(expression.name, args, { typeCtx: ctx.typeCtx, currentUser: ctx.currentUser }),
  );
  // INSERT 대입처럼 기대 타입이 있으면 같은 계열 안에서 맞춘다. (예 : TO_DATE 결과를 DATE에)
  if (expectedType !== undefined && computed.value !== null) {
    try {
      return { value: assignValue(computed.value, computed.type, expectedType, ctx.typeCtx), type: expectedType };
    } catch {
      return computed;
    }
  }
  return computed;
}

/** 집계 함수를 그룹 행들로 계산한다. 타입만 볼 때는 행 없이 결과 타입을 정한다. */
function evaluateAggregate(
  expression: { name: string; arguments: Expression[]; distinct: boolean; star: boolean; position: SourcePosition },
  ctx: EvalContext,
): TypedValue {
  const upper = expression.name.toUpperCase();
  if (upper === "COUNT" && expression.star) {
    if (ctx.typeOnly) return { value: null, type: BIGINT_TYPE };
    if (ctx.groupRows === undefined) {
      fail("42803", ERROR_CODES.GROUPING_ERROR, `Aggregate function "${expression.name}" needs GROUP BY or a group context.`, expression.position);
    }
    return { value: BigInt(ctx.groupRows.length), type: BIGINT_TYPE };
  }
  if (expression.arguments.length !== 1) {
    fail("42883", ERROR_CODES.INVALID_FUNCTION_ARGUMENT, `Aggregate function "${expression.name}" needs one argument.`, expression.position);
  }
  const argExpr = expression.arguments[0] as Expression;
  // 타입만 볼 때는 행 없이 인자 타입으로 결과 타입을 정한다.
  if (ctx.typeOnly) {
    const argType = inferNullType(argExpr, ctx);
    return { value: null, type: aggregateResultTypeFor(upper, argType, expression.position) };
  }
  if (ctx.groupRows === undefined) {
    fail("42803", ERROR_CODES.GROUPING_ERROR, `Aggregate function "${expression.name}" needs GROUP BY or a group context.`, expression.position);
  }
  const groupRows = ctx.groupRows;
  const width = ctx.groupWidth ?? (groupRows[0]?.length ?? 0);
  const outer = ctx.scopes.slice(0, Math.max(0, ctx.scopes.length - width));
  // 빈 그룹이면 NULL(COUNT 제외)이다. 결과 타입은 행 없이 추론한다.
  if (groupRows.length === 0) {
    const argType = inferNullType(argExpr, { ...ctx, groupRows: undefined, groupWidth: undefined });
    return { value: upper === "COUNT" ? 0n : null, type: aggregateResultTypeFor(upper, argType, expression.position) };
  }
  const collected: TypedValue[] = [];
  for (const member of groupRows) {
    const leveled = atInnerLevel(outer, member);
    const memberCtx: EvalContext = { ...ctx, scopes: [...outer, ...leveled], groupRows: undefined, groupWidth: undefined };
    const evaluated = evaluateExpression(argExpr, memberCtx);
    // 타입 없는 문자열은 VARCHAR로 본다.
    collected.push(evaluated.type === null || evaluated.type === undefined
      ? { value: evaluated.value, type: varcharType(Math.max(1, typeof evaluated.value === "string" ? [...evaluated.value].length : 1)) }
      : evaluated);
  }
  const firstType = (collected.find((entry) => entry.value !== null)?.type ?? collected[0]?.type ?? varcharType(1)) as DataType;
  let values = collected.map((entry) => entry.value);
  let argType = firstType;
  // DISTINCT는 NULL을 빼고 중복을 없앤다.
  if (expression.distinct) {
    const seen: TypedValue[] = [];
    for (const entry of collected) {
      if (entry.value === null) continue;
      if (!seen.some((other) => isNotDistinct(entry.value, other.value, charOption(entry.type)))) {
        seen.push(entry);
      }
    }
    values = seen.map((entry) => entry.value);
    if (seen.length > 0) argType = (seen[0] as TypedValue).type;
  } else {
    values = collected.map((entry) => entry.value);
  }
  const resultType = aggregateResultTypeFor(upper, argType, expression.position);
  const computed = aggregateGroupCompute(upper, values, argType, expression.position);
  return { value: computed, type: resultType };
}

function charOption(type: DataType): { ignoreTrailingSpaces?: boolean } {
  return type.kind === "CHAR" ? { ignoreTrailingSpaces: true } : {};
}

/** 행 없이 식의 타입만 알아본다. NULL 값 범위로 평가한다. */
function inferNullType(expression: Expression, ctx: EvalContext): DataType {
  const typeCtx: EvalContext = {
    ...ctx,
    typeOnly: true,
    subqueries: ctx.typeSubqueries,
    groupRows: undefined,
    groupWidth: undefined,
  };
  return evaluateExpression(expression, typeCtx).type;
}

function aggregateResultTypeFor(name: string, argType: DataType, position: SourcePosition): DataType {
  try {
    return aggregateResultType(name, argType, false);
  } catch (error) {
    if (error instanceof DbError && error.position === undefined) throw withPosition(error, position);
    throw error;
  }
}

function aggregateGroupCompute(name: string, values: SqlValue[], argType: DataType, position: SourcePosition): SqlValue {
  try {
    return aggregateGroup(name, values, argType, false, values.length);
  } catch (error) {
    if (error instanceof DbError && error.position === undefined) throw withPosition(error, position);
    throw error;
  }
}

function datetimeLiteral(
  expression: { type: "DATE" | "TIME" | "TIMESTAMP"; text: string; withTimeZone: boolean | null },
  ctx: EvalContext,
  expectedType?: DataType,
): TypedValue {
  const text = expression.text;
  if (expression.type === "DATE") {
    const parsed = at({ offset: 0, line: 1, column: 1 }, () => parseTimestampText(text));
    void parsed;
    // DATE 리터럴은 날짜 부분만 본다.
    const stamp = parseTimestampText(text);
    const days = splitLocalMicros(stamp.localMicros).days;
    const value = new DateValue(days);
    const type = { kind: "DATE", name: "DATE" } as const;
    if (expectedType !== undefined) {
      return { value: at({ offset: 0, line: 1, column: 1 }, () => castValue(value, type, expectedType, ctx.typeCtx)), type: expectedType };
    }
    return { value, type };
  }
  if (expression.type === "TIME") {
    const parsed = parseTimeText(text);
    const withTz = expression.withTimeZone ?? (parsed.offsetMinutes !== null);
    const value = TimeValue.fromLocal(parsed.localMicros, withTz ? (parsed.offsetMinutes ?? 0) : null);
    const type = withTz
      ? { kind: "TIME", name: "TIME WITH TIME ZONE", fractionalPrecision: 6, withTimeZone: true } as const
      : { kind: "TIME", name: "TIME", fractionalPrecision: 6, withTimeZone: false } as const;
    if (expectedType !== undefined) {
      return { value: castValue(value, type, expectedType, ctx.typeCtx), type: expectedType };
    }
    return { value, type };
  }
  const parsed = parseTimestampText(text);
  const withTz = expression.withTimeZone ?? (parsed.offsetMinutes !== null);
  const value = TimestampValue.fromLocal(parsed.localMicros, withTz ? (parsed.offsetMinutes ?? 0) : null);
  const type = withTz
    ? { kind: "TIMESTAMP", name: "TIMESTAMP WITH TIME ZONE", fractionalPrecision: 6, withTimeZone: true } as const
    : { kind: "TIMESTAMP", name: "TIMESTAMP", fractionalPrecision: 6, withTimeZone: false } as const;
  if (expectedType !== undefined) {
    return { value: castValue(value, type, expectedType, ctx.typeCtx), type: expectedType };
  }
  return { value, type };
}

function intervalLiteral(
  expression: { text: string; qualifier: { startField: "YEAR" | "MONTH" | "DAY" | "HOUR" | "MINUTE" | "SECOND"; endField: "YEAR" | "MONTH" | "DAY" | "HOUR" | "MINUTE" | "SECOND" | null; leadingPrecision: number | null; fractionalPrecision: number | null } },
  ctx: EvalContext,
): TypedValue {
  void ctx;
  const qualifier = expression.qualifier;
  // 끝 필드를 생략한 단일 필드(`DAY`)는 resolveIntervalType 에 끝 필드 없이 넘긴다.
  // 시작 필드로 채워 넘기면 `DAY TO DAY` 로 보아 거부한다.
  const endField = qualifier.endField ?? undefined;
  const endsWithSecond = (endField ?? qualifier.startField) === "SECOND";
  const fractional = endsWithSecond ? (qualifier.fractionalPrecision ?? 6) : undefined;
  // 선행 정밀도를 생략했으면 값의 자릿수에 맞추어 넓힌다. (`INTERVAL '100' DAY`) 적은 정밀도는 지킨다.
  const resolveWith = (leading: number): { value: IntervalValue; type: DataType } => {
    const type = resolveIntervalType(qualifier.startField, endField, leading, fractional);
    return { value: conformInterval(parseIntervalText(expression.text, type), type), type };
  };
  if (qualifier.leadingPrecision !== null) return resolveWith(qualifier.leadingPrecision);
  try {
    return resolveWith(2);
  } catch (error) {
    if (error instanceof DbError && error.sqlState === "22015") return resolveWith(9);
    throw error;
  }
}

function validateExtractField(field: string, type: DataType, position: SourcePosition): void {
  const kind = type.kind;
  const dateFields = field === "YEAR" || field === "MONTH" || field === "DAY";
  const timeFields = field === "HOUR" || field === "MINUTE" || field === "SECOND";
  const zoneFields = field === "TIMEZONE_HOUR" || field === "TIMEZONE_MINUTE";
  if (kind === "DATE" && dateFields) return;
  if (kind === "TIME" && (timeFields || (zoneFields && (type as { withTimeZone?: boolean }).withTimeZone === true))) {
    if (zoneFields && (type as { withTimeZone?: boolean }).withTimeZone !== true) {
      throw at(position, typeMismatch(`EXTRACT ${field} needs a time zone.`));
    }
    return;
  }
  if (kind === "TIMESTAMP" && (dateFields || timeFields || zoneFields)) {
    if (zoneFields && (type as { withTimeZone?: boolean }).withTimeZone !== true) {
      throw at(position, typeMismatch(`EXTRACT ${field} needs a time zone.`));
    }
    return;
  }
  throw at(position, typeMismatch(`EXTRACT ${field} is not defined for ${type.name}.`));
}

function extractField(field: string, value: NonNullValue, type: DataType): bigint {
  if (value instanceof DateValue) {
    const civil = civilFromDays(value.days);
    switch (field) {
      case "YEAR":
        return BigInt(civil.year);
      case "MONTH":
        return BigInt(civil.month);
      case "DAY":
        return BigInt(civil.day);
      default:
        throw typeMismatch(`EXTRACT ${field} is not defined for DATE.`);
    }
  }
  if (value instanceof TimeValue) {
    const fields = splitTimeOfDay(value.localMicros);
    switch (field) {
      case "HOUR":
        return BigInt(fields.hour);
      case "MINUTE":
        return BigInt(fields.minute);
      case "SECOND":
        return BigInt(fields.second);
      case "TIMEZONE_HOUR":
      case "TIMEZONE_MINUTE": {
        if (value.offsetMinutes === null) throw typeMismatch(`EXTRACT ${field} needs a time zone.`);
        const offset = value.offsetMinutes;
        return BigInt(field === "TIMEZONE_HOUR" ? Math.trunc(offset / 60) : offset % 60);
      }
      default:
        throw typeMismatch(`EXTRACT ${field} is not defined for TIME.`);
    }
  }
  if (value instanceof TimestampValue) {
    const split = splitLocalMicros(value.localMicros);
    const civil = civilFromDays(split.days);
    const fields = splitTimeOfDay(split.microsOfDay);
    switch (field) {
      case "YEAR":
        return BigInt(civil.year);
      case "MONTH":
        return BigInt(civil.month);
      case "DAY":
        return BigInt(civil.day);
      case "HOUR":
        return BigInt(fields.hour);
      case "MINUTE":
        return BigInt(fields.minute);
      case "SECOND":
        return BigInt(fields.second);
      case "TIMEZONE_HOUR":
      case "TIMEZONE_MINUTE": {
        if (value.offsetMinutes === null) throw typeMismatch(`EXTRACT ${field} needs a time zone.`);
        const offset = value.offsetMinutes;
        return BigInt(field === "TIMEZONE_HOUR" ? Math.trunc(offset / 60) : offset % 60);
      }
      default:
        throw typeMismatch(`EXTRACT ${field} is not defined for TIMESTAMP.`);
    }
  }
  throw typeMismatch(`EXTRACT ${field} is not defined for ${type.name}.`);
}

function asTrimSet(value: NonNullValue): string {
  if (typeof value !== "string") throw typeMismatch("TRIM needs a character value.");
  if (value.length === 0) {
    throw new DbError("22023", ERROR_CODES.TYPE_PARAMETER_INVALID, "Trim character must not be empty.");
  }
  return value;
}

void decodeUtf8;
void invalidCastValue;
