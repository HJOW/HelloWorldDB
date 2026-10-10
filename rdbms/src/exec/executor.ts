/**
 * 질의 실행.
 *
 * 담당
 *  - 실행 계획(planner.ts)을 따라 행을 만들어 낸다 :
 *    전체 스캔과 인덱스 스캔, 조건, 조인(INNER, LEFT, RIGHT, FULL, CROSS), GROUP BY 와 HAVING,
 *    DISTINCT, 정렬, 집합 연산(UNION, INTERSECT, EXCEPT), 행 수 제한
 *  - 서브쿼리 : 스칼라, 인라인 뷰, IN, EXISTS, ANY, ALL, 상관 서브쿼리
 *  - FROM 절이 없는 SELECT 는 행 하나짜리 결과를 낸다.
 *  - SELECT ... FOR UPDATE 는 읽은 행에 잠금을 건다. (txn/lockManager.ts)
 *  - 결과를 한꺼번에 만들지 않고, 요청하는 만큼씩 꺼내 갈 수 있게 한다.
 *
 * 식의 계산은 expression.ts, 함수는 functions.ts 에 맡긴다.
 * 6단계에서는 자동 커밋의 커밋된 데이터만 읽고 잠금은 걸지 않는다. (잠금은 7단계)
 * 실행 계획은 규칙 기반이다. 앞쪽 컬럼의 동등·범위 조건에 인덱스를 쓴다.
 *
 * 관련 사양 : AGENTS.md 상세 1-4
 * 구현 단계 : 6단계
 */

import { DbError, ERROR_CODES, withPosition } from "../common/errors.js";
import type { SourcePosition } from "../common/errors.js";
import type {
  Expression,
  Query,
  QueryBody,
  Select,
  SelectItem,
} from "../sql/ast.js";
import type { DataType } from "../types/dataType.js";
import { varcharType } from "../types/dataType.js";
import type { TypeContext } from "../types/cast.js";
import { castLiteral, castValue, commonType } from "../types/cast.js";
import { compareForSort, compareValues, isNotDistinct } from "../types/value.js";
import type { SqlValue } from "../types/value.js";
import { decodeRow, encodeKey, prefixUpperBound } from "../types/codec.js";
import type { KeyColumn } from "../types/codec.js";
import type { RowId } from "../storage/format/format.js";
import type { CatalogStore, StoredTable } from "../catalog/catalog.js";
import type { TablespaceManager } from "../catalog/tablespaceManager.js";
import { getDictionaryColumns, getDictionaryRows } from "../catalog/dictionaryViews.js";
import { bindSource, validateGroupBy } from "./analyzer.js";
import type { BoundSource } from "./analyzer.js";
import { chooseIndex } from "./planner.js";
import type { IndexChoice } from "./planner.js";
import { atInnerLevel, containsAggregate, evaluateCondition, evaluateExpression } from "./expression.js";
import type { EvalContext, RowScope } from "./expression.js";
import type { TypedValue } from "./functions.js";

function fail(sqlState: string, code: number, message: string, position?: SourcePosition): never {
  if (position !== undefined) {
    throw withPosition(new DbError(sqlState, code, message), position);
  }
  throw new DbError(sqlState, code, message);
}

/** 질의를 실행할 때의 문맥이다. */
export interface QueryContext {
  readonly manager: TablespaceManager;
  readonly currentTablespace: string;
  readonly currentUser: string;
  readonly typeCtx: TypeContext;
  readonly params: readonly SqlValue[];
  /** 상관 서브쿼리에서 보이는 바깥 행들이다. */
  readonly outerScopes: RowScope[];
  /** 뷰 전개의 순환을 막는다. */
  readonly viewStack: readonly string[];
}

/** 질의 결과이다. 값과 함께 열 이름과 타입을 돌려준다. */
export interface QueryResult {
  columns: { name: string; type: DataType }[];
  rows: SqlValue[][];
}

/** 합친 행이다. 출처마다 범위 하나씩 순서대로 둔다. */
type CombinedRow = RowScope[];

/** 출력 열 하나이다. */
interface OutputColumn {
  name: string;
  type: DataType;
  value: SqlValue;
}

// ---------------------------------------------------------------------------
// 테이블 행 읽기
// ---------------------------------------------------------------------------

/** 테이블의 커밋된 행을 모두 읽는다. */
export function readTableRows(
  catalog: CatalogStore,
  table: StoredTable,
): { id: RowId; values: SqlValue[] }[] {
  const types = table.columns.map((column) => column.dataType);
  return catalog.space.heap(table.heapRoot).scan().map((stored) => ({
    id: stored.id,
    values: decodeRow(stored.data, types),
  }));
}

/** 테이블의 컬럼 타입을 정의 순서대로 돌려준다. */
export function tableColumnTypes(table: StoredTable): DataType[] {
  return table.columns.map((column) => column.dataType);
}

// ---------------------------------------------------------------------------
// 서브쿼리 핸들러
// ---------------------------------------------------------------------------

function dataHandlers(scopes: RowScope[], ctx: QueryContext) {
  const leveled = atInnerLevel(ctx.outerScopes, scopes);
  const outer = [...ctx.outerScopes, ...leveled];
  return {
    scalar: (query: Query): TypedValue => executeScalar(query, scopes, ctx),
    exists: (query: Query): boolean =>
      executeQuery(query, { ...ctx, outerScopes: outer }).rows.length > 0,
    columnValues: (query: Query): { values: SqlValue[]; type: DataType } => {
      const result = executeQuery(query, { ...ctx, outerScopes: outer });
      if (result.columns.length !== 1) {
        fail("21000", ERROR_CODES.CARDINALITY_VIOLATION, "Subquery must return a single column.");
      }
      const type = (result.columns[0] as { type: DataType }).type;
      return { values: result.rows.map((row) => row[0] as SqlValue), type };
    },
  };
}

function typeHandlers(ctx: QueryContext) {
  return {
    scalar: (query: Query): TypedValue => {
      const columns = inferOutputColumns(query, ctx);
      if (columns.length !== 1) {
        fail("21000", ERROR_CODES.CARDINALITY_VIOLATION, "Subquery must return a single column.");
      }
      return { value: null, type: (columns[0] as { type: DataType }).type };
    },
    exists: (_query: Query): boolean => false,
    columnValues: (query: Query): { values: SqlValue[]; type: DataType } => {
      const columns = inferOutputColumns(query, ctx);
      if (columns.length !== 1) {
        fail("21000", ERROR_CODES.CARDINALITY_VIOLATION, "Subquery must return a single column.");
      }
      return { values: [], type: (columns[0] as { type: DataType }).type };
    },
  };
}

/** 식 평가 문맥을 만든다. */
function evalContextFor(scopes: RowScope[], ctx: QueryContext, typeOnly: boolean): EvalContext {
  return {
    typeCtx: ctx.typeCtx,
    params: ctx.params,
    scopes: [...ctx.outerScopes, ...atInnerLevel(ctx.outerScopes, scopes)],
    currentUser: ctx.currentUser,
    subqueries: typeOnly ? typeHandlers(ctx) : dataHandlers(scopes, ctx),
    typeSubqueries: typeHandlers(ctx),
    typeOnly: typeOnly ? true : undefined,
  };
}

/** 집계 그룹 안에서 쓸 식 평가 문맥을 만든다. */
function groupEvalContext(rep: CombinedRow, groupRows: CombinedRow[], ctx: QueryContext): EvalContext {
  return {
    typeCtx: ctx.typeCtx,
    params: ctx.params,
    scopes: [...ctx.outerScopes, ...atInnerLevel(ctx.outerScopes, rep)],
    currentUser: ctx.currentUser,
    subqueries: dataHandlers(rep, ctx),
    typeSubqueries: typeHandlers(ctx),
    groupRows,
    groupWidth: rep.length,
  };
}

/** 스칼라 서브쿼리를 실행한다. 0행이면 NULL, 2행 이상이면 오류이다. */
function executeScalar(query: Query, scopes: RowScope[], ctx: QueryContext): TypedValue {
  const outer = [...ctx.outerScopes, ...atInnerLevel(ctx.outerScopes, scopes)];
  const result = executeQuery(query, { ...ctx, outerScopes: outer });
  if (result.columns.length !== 1) {
    fail("21000", ERROR_CODES.CARDINALITY_VIOLATION, "Scalar subquery must return a single column.");
  }
  if (result.rows.length === 0) {
    return { value: null, type: (result.columns[0] as { type: DataType }).type };
  }
  if (result.rows.length > 1) {
    fail("21000", ERROR_CODES.CARDINALITY_VIOLATION, "Scalar subquery returned more than one row.");
  }
  return { value: (result.rows[0] as SqlValue[])[0] as SqlValue, type: (result.columns[0] as { type: DataType }).type };
}

// ---------------------------------------------------------------------------
// 질의 실행 입구
// ---------------------------------------------------------------------------

/** 질의 하나를 실행한다. */
export function executeQuery(query: Query, ctx: QueryContext): QueryResult {
  const bodyResult = executeBody(query.body, ctx);
  const ordered = applyOrderAndLimit(
    bodyResult.columns,
    bodyResult.rows,
    bodyResult.rowSources,
    query.orderBy,
    query.offset,
    query.fetch,
    ctx,
  );
  return { columns: ordered.columns, rows: ordered.rows };
}

interface BodyResult {
  columns: { name: string; type: DataType }[];
  rows: SqlValue[][];
  /** ORDER BY가 출처 열을 볼 수 있게 행마다 합친 범위를 남긴다. 집합 연산 결과는 비어 있다. */
  rowSources: CombinedRow[];
}

function executeBody(body: QueryBody, ctx: QueryContext): BodyResult {
  if (body.kind === "Select") return executeSelect(body, ctx);
  if (body.kind === "SetOperation") return executeSetOperation(body, ctx);
  const inner = executeQuery(body, ctx);
  return { columns: inner.columns, rows: inner.rows, rowSources: inner.rows.map(() => []) };
}

// ---------------------------------------------------------------------------
// SELECT
// ---------------------------------------------------------------------------

function executeSelect(select: Select, ctx: QueryContext): BodyResult {
  const boundList = select.from.map((reference) => bindSource(ctx.manager, reference, ctx.currentTablespace, ctx.viewStack));
  let rows: CombinedRow[] = [[]];
  for (const bound of boundList) {
    rows = crossWithSource(rows, bound, select.where, ctx);
  }
  // WHERE (인덱스가 걸러낸 나머지를 확정한다)
  if (select.where !== null) {
    const where = select.where;
    rows = rows.filter((row) => evaluateCondition(where, evalContextFor(row, ctx, false)) === true);
  }
  const hasGroupBy = select.groupBy.length > 0;
  const hasAggregate = select.items.some((item) => item.kind === "Expression" && containsAggregate(item.expression)) ||
    (select.having !== null && containsAggregate(select.having));
  if (hasGroupBy || hasAggregate) {
    validateGroupBy(select, selectPosition(select));
    return executeGrouped(select, rows, boundList, ctx);
  }
  // 집계 없음 : 행마다 투영한다.
  let projected = rows.map((row) => projectRow(select.items, row, ctx));
  if (select.distinct) {
    projected = deduplicate(projected);
  }
  const columns = projected.length > 0
    ? (projected[0] as OutputColumn[]).map((column) => ({ name: column.name, type: column.type }))
    : inferSelectColumns(select, boundList, ctx);
  return {
    columns,
    rows: projected.map((output) => output.map((column) => column.value)),
    rowSources: rows,
  };
}

function selectPosition(select: Select): SourcePosition {
  const first = select.items[0];
  if (first !== undefined) {
    if (first.kind === "Star") return first.position;
    return first.expression.position;
  }
  return { offset: 0, line: 1, column: 1 };
}

/** FROM 출처 하나로 곱한다. 조인은 묶음대로 처리한다. */
function crossWithSource(rows: CombinedRow[], bound: BoundSource, where: Expression | null, ctx: QueryContext): CombinedRow[] {
  if (bound.kind === "join") return executeJoin(rows, bound, ctx);
  const sourceRows = scanSource(bound, ctx, where);
  const out: CombinedRow[] = [];
  for (const left of rows) {
    for (const right of sourceRows) {
      out.push([...left, ...right]);
    }
  }
  return out;
}

/** 조인을 실행한다. 중첩 루프로 돌린다. */
function executeJoin(rows: CombinedRow[], bound: Extract<BoundSource, { kind: "join" }>, ctx: QueryContext): CombinedRow[] {
  const leftRows = expandJoinSide(rows, bound.left, ctx);
  const rightScopes = scanSource(bound.right, ctx, null);
  // USING 병합 열은 오른쪽에서 가린다. 왼쪽의 NULL 범위는 열을 그대로 둔다.
  const hide = bound.on !== null ? [] : (bound.using ?? []);
  const nullRight = (source: BoundSource): RowScope[] => hideUsingColumns(nullScopes(source, ctx), hide);
  const nullLeft = (source: BoundSource): RowScope[] => nullScopes(source, ctx);
  const out: CombinedRow[] = [];
  if (bound.type === "CROSS") {
    for (const left of leftRows) {
      for (const right of rightScopes) {
        out.push([...left, ...right]);
      }
    }
    return out;
  }
  if (bound.on !== null) {
    const on = bound.on;
    // 오른쪽 맞물림을 기억하여 RIGHT/FULL에서 쓴다.
    const rightMatched = new Array<boolean>(rightScopes.length).fill(false);
    for (const left of leftRows) {
      let matched = false;
      for (let rightIndex = 0; rightIndex < rightScopes.length; rightIndex++) {
        const right = rightScopes[rightIndex] as CombinedRow;
        const combined = [...left, ...right];
        if (evaluateCondition(on, evalContextFor(combined, ctx, false)) === true) {
          matched = true;
          rightMatched[rightIndex] = true;
          out.push(combined);
        }
      }
      if (!matched && (bound.type === "LEFT" || bound.type === "FULL")) {
        out.push([...left, ...nullRight(bound.right)]);
      }
    }
    if (bound.type === "RIGHT" || bound.type === "FULL") {
      for (let rightIndex = 0; rightIndex < rightScopes.length; rightIndex++) {
        if (rightMatched[rightIndex] !== true) {
          out.push([...nullLeft(bound.left), ...(rightScopes[rightIndex] as CombinedRow)]);
        }
      }
    }
    return out;
  }
  // USING : 나열한 열이 모두 같은 행만 잇고 오른쪽의 그 열은 병합한다.
  const using = (bound.using ?? []) as string[];
  const rightMatchedUsing = new Array<boolean>(rightScopes.length).fill(false);
  for (const left of leftRows) {
    let matched = false;
    for (let rightIndex = 0; rightIndex < rightScopes.length; rightIndex++) {
      const right = rightScopes[rightIndex] as CombinedRow;
      if (usingMatch(left, right, using, ctx)) {
        matched = true;
        rightMatchedUsing[rightIndex] = true;
        out.push([...left, ...hideUsingColumns(right, using)]);
      }
    }
    if (!matched && (bound.type === "LEFT" || bound.type === "FULL")) {
      out.push([...left, ...nullRight(bound.right)]);
    }
  }
  if (bound.type === "RIGHT" || bound.type === "FULL") {
    for (let rightIndex = 0; rightIndex < rightScopes.length; rightIndex++) {
      if (rightMatchedUsing[rightIndex] !== true) {
        const right = rightScopes[rightIndex] as CombinedRow;
        out.push([...fillUsingNulls(nullLeft(bound.left), right, using), ...hideUsingColumns(right, using)]);
      }
    }
  }
  return out;
}

/** 조인의 한쪽을 펼친다. 왼쪽 행렬과 결합하기 전 단계이다. */
function expandJoinSide(rows: CombinedRow[], side: BoundSource, ctx: QueryContext): CombinedRow[] {
  if (side.kind === "join") {
    return executeJoin(rows, side, ctx);
  }
  const sourceRows = scanSource(side, ctx, null);
  const out: CombinedRow[] = [];
  for (const left of rows) {
    for (const right of sourceRows) {
      out.push([...left, ...right]);
    }
  }
  return out;
}

/** USING 열이 모두 같은지 본다. NULL이 섞이면 잇지 않는다. */
function usingMatch(left: CombinedRow, right: CombinedRow, using: string[], ctx: QueryContext): boolean {
  for (const column of using) {
    const leftValue = findColumnValue(left, column);
    const rightValue = findColumnValue(right, column);
    if (leftValue === undefined || rightValue === undefined) {
      throw new DbError("42703", ERROR_CODES.COLUMN_NOT_FOUND, `USING column does not exist: "${column}".`);
    }
    if (leftValue.value === null || rightValue.value === null) return false;
    const common = commonType(leftValue.type, rightValue.type);
    if (common === null) {
      throw new DbError("42804", 2011, `Cannot compare ${leftValue.type.name} and ${rightValue.type.name}.`);
    }
    const leftCasted = castValue(leftValue.value, leftValue.type, common, ctx.typeCtx);
    const rightCasted = castValue(rightValue.value, rightValue.type, common, ctx.typeCtx);
    if (compareValues(leftCasted as Exclude<SqlValue, null>, rightCasted as Exclude<SqlValue, null>, { ignoreTrailingSpaces: common.kind === "CHAR" }) !== 0) {
      return false;
    }
  }
  return true;
}

/** 합친 행에서 이름으로 값을 찾는다. 가려진 열은 빼고 본다. */
function findColumnValue(row: CombinedRow, column: string): { value: SqlValue; type: DataType } | undefined {
  for (let index = row.length - 1; index >= 0; index--) {
    const scope = row[index] as RowScope;
    if (scope.hidden?.includes(column)) continue;
    for (const slot of scope.slots) {
      if (slot.column === column) return { value: slot.value, type: slot.type };
    }
  }
  return undefined;
}

/** USING 병합 열은 오른쪽에서 가린다. 왼쪽의 NULL 범위는 열을 그대로 둔다. */
function hideUsingColumns(right: RowScope[], using: string[]): RowScope[] {
  return right.map((scope) => ({ ...scope, hidden: [...(scope.hidden ?? []), ...using] }));
}

/** 바깥 조인에서 비어 있는 쪽의 병합 열을 살아 있는 쪽 값으로 채운다. */
function fillUsingNulls(nullSide: RowScope[], present: RowScope[], using: string[]): RowScope[] {
  if (using.length === 0) return nullSide;
  const presentValues = new Map<string, { value: SqlValue; type: DataType }>();
  for (const scope of present) {
    for (const slot of scope.slots) {
      if (using.includes(slot.column) && !presentValues.has(slot.column) && slot.value !== null) {
        presentValues.set(slot.column, { value: slot.value, type: slot.type });
      }
    }
  }
  return nullSide.map((scope) => ({
    ...scope,
    slots: scope.slots.map((slot) => {
      if (!using.includes(slot.column) || slot.value !== null) return slot;
      const found = presentValues.get(slot.column);
      return found === undefined ? slot : { ...slot, value: found.value, type: found.type };
    }),
  }));
}

/** 맞지 않은 바깥 조인 쪽을 NULL 범위로 만든다. 신원(테이블·별칭)은 유지한다. */
function nullScopes(source: BoundSource, ctx: QueryContext): RowScope[] {
  switch (source.kind) {
    case "table":
      return [{
        tablespace: source.tablespace,
        table: source.table,
        alias: source.alias,
        slots: source.def.columns.map((column) => ({ column: column.name, value: null, type: column.dataType })),
      }];
    case "view": {
      const columns = inferOutputColumns(source.query, { ...ctx, viewStack: [...ctx.viewStack, `${source.tablespace}.${source.view}`] });
      const names = source.def.columns.length === columns.length ? source.def.columns : columns.map((column) => column.name);
      return [{
        tablespace: source.tablespace,
        table: source.view,
        alias: source.alias,
        slots: columns.map((column, index) => ({ column: (names[index] as string) ?? column.name, value: null, type: column.type })),
      }];
    }
    case "derived": {
      const columns = inferOutputColumns(source.query, ctx);
      const names = source.columns ?? columns.map((column) => column.name);
      return [{
        tablespace: null,
        table: null,
        alias: source.alias,
        slots: columns.map((column, index) => ({ column: (names[index] as string) ?? column.name, value: null, type: column.type })),
      }];
    }
    case "join": {
      const left = nullScopes(source.left, ctx);
      const right = nullScopes(source.right, ctx);
      if (source.on !== null) return [...left, ...right];
      const using = source.using ?? [];
      return [...left, ...right.map((scope) => ({ ...scope, hidden: [...(scope.hidden ?? []), ...using] }))];
    }
    case "dual":
      return [{ tablespace: "SYSTEM", table: "DUAL", alias: null, slots: [{ column: "DUMMY", value: null, type: varcharType(1) }] }];
    case "dictionary": {
      const columns = getDictionaryColumns(source.view);
      return [{ tablespace: "SYSTEM", table: source.view, alias: null, slots: columns.map((column) => ({ column: column.name, value: null, type: column.dataType })) }];
    }
    case "bare":
      return [];
  }
}

// ---------------------------------------------------------------------------
// 출처 스캔
// ---------------------------------------------------------------------------

/** FROM 출처 하나의 행들을 범위로 만든다. */
function scanSource(bound: BoundSource, ctx: QueryContext, where: Expression | null): RowScope[][] {
  switch (bound.kind) {
    case "table":
      return scanTable(bound, ctx, where);
    case "view":
      return scanView(bound, ctx);
    case "derived":
      return scanDerived(bound, ctx);
    case "join":
      // 단독으로 스캔할 때는 빈 왼쪽과 묶는다.
      return executeJoin([[]], bound, ctx).map((row) => [...row]);
    case "dual":
      return [[{ tablespace: "SYSTEM", table: "DUAL", alias: null, slots: [{ column: "DUMMY", value: "X", type: varcharType(1) }] }]];
    case "dictionary": {
      const columns = getDictionaryColumns(bound.view);
      return getDictionaryRows(ctx.manager, bound.view).map((row) => [{
        tablespace: "SYSTEM",
        table: bound.view,
        alias: null,
        slots: columns.map((column, index) => ({ column: column.name, value: row[index] as SqlValue, type: column.dataType })),
      }]);
    }
    case "bare":
      return [[]];
  }
}

/** 테이블을 읽는다. 앞쪽 컬럼 조건에 맞는 인덱스가 있으면 탄다. */
function scanTable(
  bound: Extract<BoundSource, { kind: "table" }>,
  ctx: QueryContext,
  where: Expression | null,
): RowScope[][] {
  const table = bound.def;
  const types = table.columns.map((column) => column.dataType);
  // 상수 평가는 바깥 범위만으로 한다. 행의 열이 섞이면 null 로 보고 pushdown하지 않는다.
  const choice = chooseIndex(bound.catalog, table, bound.alias ?? bound.table, where, (expression) => {
    try {
      return evaluateExpression(expression, evalContextFor([], ctx, true));
    } catch {
      return null;
    }
  });
  if (choice !== null) {
    try {
      return scanWithIndex(bound, choice, types, ctx);
    } catch {
      // 인덱스 스캔에 실패하면 전체 스캔으로 돌아간다.
    }
  }
  return readTableRows(bound.catalog, table).map((stored) => [
    {
      tablespace: bound.tablespace,
      table: bound.table,
      alias: bound.alias,
      slots: table.columns.map((column, index) => ({
        column: column.name,
        value: (stored.values[index] ?? null) as SqlValue,
        type: column.dataType,
      })),
    },
  ]);
}

/** 인덱스로 앞쪽 조건을 만족하는 행만 읽는다. 남은 조건은 호출자가 다시 건다. */
function scanWithIndex(
  bound: Extract<BoundSource, { kind: "table" }>,
  choice: IndexChoice,
  types: DataType[],
  ctx: QueryContext,
): RowScope[][] {
  const table = bound.def;
  const keyColumns: KeyColumn[] = choice.columns.map((column) => ({ type: column.type, descending: column.descending }));
  // 앞쪽 동등값을 컬럼 타입에 맞춘다. 타입 없는 문자열은 리터럴 해석을 쓴다.
  const coercePrefix = (entry: TypedValue, type: DataType): SqlValue => {
    if (entry.value === null) throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, "NULL index prefix.");
    const entryType = entry.type as DataType | null;
    if (entryType === null || (entryType as unknown) === undefined) {
      return castLiteral(entry.value as string, type, ctx.typeCtx);
    }
    return castValue(entry.value, entryType, type, ctx.typeCtx);
  };
  const prefixValues = choice.prefixValues.map((entry, index) => {
    const type = (choice.columns[index] as { type: DataType }).type;
    return coercePrefix(entry, type);
  });
  const space = bound.catalog.space;
  let entries: { key: Buffer; rowId: RowId }[];
  if (choice.prefixCount === choice.columns.length && choice.lower === null && choice.upper === null) {
    const key = encodeKey(prefixValues, keyColumns);
    entries = space.index(choice.indexRoot).find(key).map((rowId) => ({ key, rowId }));
  } else if (choice.prefixCount > 0 && choice.lower === null && choice.upper === null) {
    const prefix = encodeKey(prefixValues, keyColumns.slice(0, choice.prefixCount));
    const upper = prefixUpperBound(prefix);
    entries = space.index(choice.indexRoot).range(
      upper === null ? { lower: prefix, lowerInclusive: true } : { lower: prefix, lowerInclusive: true, upper, upperInclusive: false },
    );
  } else {
    // 범위 조건 : 앞쪽(prefix)과 그 다음 컬럼의 하한·상한으로 범위를 만든다.
    const count = choice.prefixCount + 1;
    const descending = (choice.columns[choice.prefixCount] as { descending: boolean }).descending === true;
    const rangeType = (choice.columns[choice.prefixCount] as { type: DataType }).type;
    const lowerValue = choice.lower === null ? null : coercePrefix(choice.lower.value, rangeType);
    const upperValue = choice.upper === null ? null : coercePrefix(choice.upper.value, rangeType);
    const lowerKey = lowerValue === null
      ? (choice.prefixCount > 0 ? encodeKey(prefixValues, keyColumns.slice(0, choice.prefixCount)) : undefined)
      : encodeKey([...prefixValues, lowerValue], keyColumns.slice(0, count));
    const upperKey = upperValue === null
      ? (choice.prefixCount > 0 ? prefixUpperBound(encodeKey(prefixValues, keyColumns.slice(0, choice.prefixCount))) : undefined)
      : encodeKey([...prefixValues, upperValue], keyColumns.slice(0, count));
    // DESC 컬럼은 바이트 순서가 뒤집히므로 하한·상한을 바꾼다.
    let lower = lowerKey === undefined ? undefined : { key: lowerKey, inclusive: choice.lower !== null ? choice.lower.inclusive : true };
    let upper = upperKey === undefined || upperKey === null ? undefined : { key: upperKey, inclusive: choice.upper !== null ? choice.upper.inclusive : false };
    if (descending) {
      const swapped = lower;
      lower = upper === undefined ? undefined : { key: upper.key, inclusive: upper.inclusive };
      upper = swapped === undefined ? undefined : { key: swapped.key, inclusive: swapped.inclusive };
    }
    entries = space.index(choice.indexRoot).range({
      ...(lower !== undefined ? { lower: lower.key, lowerInclusive: lower.inclusive } : {}),
      ...(upper !== undefined ? { upper: upper.key, upperInclusive: upper.inclusive } : {}),
    });
  }
  const out: RowScope[][] = [];
  for (const entry of entries) {
    const data = bound.catalog.space.heap(table.heapRoot).get(entry.rowId);
    if (data === null) continue;
    const values = decodeRow(data, types);
    out.push([
      {
        tablespace: bound.tablespace,
        table: bound.table,
        alias: bound.alias,
        slots: table.columns.map((column, index) => ({
          column: column.name,
          value: (values[index] ?? null) as SqlValue,
          type: column.dataType,
        })),
      },
    ]);
  }
  return out;
}

/** 뷰를 전개하여 행을 만든다. 정의 안의 생략된 이름은 뷰의 테이블스페이스에서 찾는다. */
function scanView(bound: Extract<BoundSource, { kind: "view" }>, ctx: QueryContext): RowScope[][] {
  const key = `${bound.tablespace}.${bound.view}`;
  const result = executeQuery(bound.query, { ...ctx, currentTablespace: bound.tablespace, viewStack: [...ctx.viewStack, key] });
  const names = bound.def.columns.length === result.columns.length ? bound.def.columns : result.columns.map((column) => column.name);
  return result.rows.map((row) => [
    {
      tablespace: bound.tablespace,
      table: bound.view,
      alias: bound.alias,
      slots: result.columns.map((column, index) => ({
        column: (names[index] as string) ?? column.name,
        value: (row[index] ?? null) as SqlValue,
        type: column.type,
      })),
    },
  ]);
}

/** 인라인 뷰를 실행한다. */
function scanDerived(bound: Extract<BoundSource, { kind: "derived" }>, ctx: QueryContext): RowScope[][] {
  const result = executeQuery(bound.query, ctx);
  const names = bound.columns ?? result.columns.map((column) => column.name);
  if (bound.columns !== null && bound.columns.length !== result.columns.length) {
    fail("42804", ERROR_CODES.SET_OPERATION_MISMATCH, "Derived table column count does not match.");
  }
  return result.rows.map((row) => [
    {
      tablespace: null,
      table: null,
      alias: bound.alias,
      slots: result.columns.map((column, index) => ({
        column: (names[index] as string) ?? column.name,
        value: (row[index] ?? null) as SqlValue,
        type: column.type,
      })),
    },
  ]);
}

// ---------------------------------------------------------------------------
// 투영과 집계
// ---------------------------------------------------------------------------

/** 선택 목록을 한 행에 적용한다. */
function projectRow(items: SelectItem[], row: CombinedRow, ctx: QueryContext): OutputColumn[] {
  const out: OutputColumn[] = [];
  for (const item of items) {
    if (item.kind === "Star") {
      for (const column of expandStar(item.qualifier, row, item.position)) {
        out.push(column);
      }
      continue;
    }
    const bound = evaluateExpression(item.expression, evalContextFor(row, ctx, false));
    const name = item.alias ?? defaultColumnName(item.expression, `COL${out.length + 1}`);
    out.push({ name, type: resultTypeOf(bound), value: bound.value });
  }
  return out;
}

/** 결과 메타데이터에 null 타입이 나가지 않게 한다. 타입 없는 문자열은 VARCHAR이다. */
function resultTypeOf(bound: TypedValue): DataType {
  if (bound.type !== null && bound.type !== undefined) return bound.type;
  const text = typeof bound.value === "string" ? bound.value : "";
  return varcharType(Math.max(1, [...text].length));
}

/** `*` 를 합친 행의 열로 펼친다. */
function expandStar(qualifier: string[], row: CombinedRow, position: SourcePosition): OutputColumn[] {
  const out: OutputColumn[] = [];
  for (const scope of row) {
    if (qualifier.length === 2) {
      if (scope.tablespace !== qualifier[0]) continue;
      if (scope.table !== qualifier[1] && scope.alias !== qualifier[1]) continue;
    } else if (qualifier.length === 1) {
      if (scope.table !== qualifier[0] && scope.alias !== qualifier[0]) continue;
    }
    for (const slot of scope.slots) {
      if (scope.hidden?.includes(slot.column)) continue;
      out.push({ name: slot.column, type: slot.type, value: slot.value });
    }
  }
  if (qualifier.length > 0 && out.length === 0) {
    fail("42703", ERROR_CODES.COLUMN_NOT_FOUND, `Table does not exist for *: "${qualifier.join(".")}".`, position);
  }
  return out;
}

function defaultColumnName(expression: Expression, fallback: string): string {
  if (expression.kind === "Column") return expression.name;
  return fallback;
}

/** 집계 그룹이다. */
interface Group {
  key: SqlValue[];
  keyTypes: DataType[];
  rows: CombinedRow[];
}

/** GROUP BY와 집계를 실행한다. */
function executeGrouped(select: Select, rows: CombinedRow[], boundList: BoundSource[], ctx: QueryContext): BodyResult {
  const groups = groupRows(select.groupBy, rows, ctx);
  // HAVING
  const kept = select.having === null
    ? groups
    : groups.filter((group) => {
      const rep = repScopes(group, boundList, ctx);
      return evaluateCondition(select.having as Expression, groupEvalContext(rep, group.rows, ctx)) === true;
    });
  const outputs = kept.map((group) => {
    const rep = repScopes(group, boundList, ctx);
    return projectRowGrouped(select.items, rep, group.rows, ctx);
  });
  const distinct = select.distinct ? deduplicate(outputs) : outputs;
  const columns = distinct.length > 0
    ? (distinct[0] as OutputColumn[]).map((column) => ({ name: column.name, type: column.type }))
    : inferSelectColumns(select, boundList, ctx);
  return {
    columns,
    rows: distinct.map((output) => output.map((column) => column.value)),
    rowSources: kept.map((group) => (group.rows[0] ?? []) as CombinedRow),
  };
}

/** 그룹의 대표 범위이다. 빈 전역 그룹은 NULL 타입 범위로 만든다. */
function repScopes(group: Group, boundList: BoundSource[], ctx: QueryContext): CombinedRow {
  if (group.rows.length > 0) return group.rows[0] as CombinedRow;
  return typeScopes(boundList, ctx);
}

function projectRowGrouped(items: SelectItem[], rep: CombinedRow, groupRows: CombinedRow[], ctx: QueryContext): OutputColumn[] {
  const out: OutputColumn[] = [];
  for (const item of items) {
    if (item.kind === "Star") {
      for (const column of expandStar(item.qualifier, rep, item.position)) {
        out.push(column);
      }
      continue;
    }
    const bound = evaluateExpression(item.expression, groupEvalContext(rep, groupRows, ctx));
    const name = item.alias ?? defaultColumnName(item.expression, `COL${out.length + 1}`);
    out.push({ name, type: resultTypeOf(bound), value: bound.value });
  }
  return out;
}

/** GROUP BY 키로 행을 나눈다. */
function groupRows(groupBy: Expression[], rows: CombinedRow[], ctx: QueryContext): Group[] {
  if (groupBy.length === 0) {
    // 전역 집계 : 행이 없어도 그룹 하나를 둔다.
    return [{ key: [], keyTypes: [], rows }];
  }
  const groups: Group[] = [];
  for (const row of rows) {
    const evalCtx = evalContextFor(row, ctx, false);
    const key = groupBy.map((expression) => evaluateExpression(expression, evalCtx));
    const found = groups.find((group) => keysEqual(group, key));
    if (found !== undefined) {
      found.rows.push(row);
    } else {
      groups.push({ key: key.map((entry) => entry.value), keyTypes: key.map((entry) => entry.type), rows: [row] });
    }
  }
  return groups;
}

function keysEqual(group: Group, key: TypedValue[]): boolean {
  if (group.key.length !== key.length) return false;
  for (let index = 0; index < key.length; index++) {
    const left = group.key[index] as SqlValue;
    const right = (key[index] as TypedValue).value;
    const type = group.keyTypes[index] as DataType;
    if (!isNotDistinct(left, right, { ignoreTrailingSpaces: type.kind === "CHAR" })) return false;
  }
  return true;
}

/** DISTINCT로 중복 행을 없앤다. */
function deduplicate(rows: OutputColumn[][]): OutputColumn[][] {
  const kept: OutputColumn[][] = [];
  for (const row of rows) {
    if (!kept.some((other) => rowEquals(other, row))) kept.push(row);
  }
  return kept;
}

function rowEquals(left: OutputColumn[], right: OutputColumn[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const leftColumn = left[index] as OutputColumn;
    const rightColumn = right[index] as OutputColumn;
    if (!isNotDistinct(leftColumn.value, rightColumn.value, { ignoreTrailingSpaces: leftColumn.type.kind === "CHAR" })) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 집합 연산
// ---------------------------------------------------------------------------

function executeSetOperation(body: Extract<QueryBody, { kind: "SetOperation" }>, ctx: QueryContext): BodyResult {
  const left = executeBody(body.left, ctx);
  const right = executeBody(body.right, ctx);
  if (left.columns.length !== right.columns.length) {
    fail("42804", ERROR_CODES.SET_OPERATION_MISMATCH, "Set operation queries must have the same number of columns.");
  }
  const columns = left.columns.map((column, index) => {
    const rightType = (right.columns[index] as { type: DataType }).type;
    const common = commonType(column.type, rightType);
    if (common === null) {
      fail("42804", ERROR_CODES.SET_OPERATION_MISMATCH, "Set operation queries have incompatible types.");
    }
    return { name: column.name, type: common as DataType };
  });
  const types = columns.map((column) => column.type);
  const leftRows = left.rows.map((row) => castRow(row, left.columns.map((column) => column.type), types, ctx));
  const rightRows = right.rows.map((row) => castRow(row, right.columns.map((column) => column.type), types, ctx));
  let rows: SqlValue[][];
  if (body.operator === "UNION" && body.all) {
    rows = [...leftRows, ...rightRows];
  } else if (body.operator === "UNION") {
    rows = unionDistinct(leftRows, rightRows, types);
  } else if (body.operator === "INTERSECT") {
    rows = deduplicateTyped(leftRows.filter((row) => rightRows.some((other) => typedRowEquals(row, other, types))), types);
  } else {
    rows = deduplicateTyped(leftRows.filter((row) => !rightRows.some((other) => typedRowEquals(row, other, types))), types);
  }
  return { columns, rows, rowSources: [] };
}

function castRow(row: SqlValue[], from: DataType[], to: DataType[], ctx: QueryContext): SqlValue[] {
  return row.map((value, index) => {
    if (value === null) return null;
    const source = from[index] as DataType;
    const target = to[index] as DataType;
    if (source === target) return value;
    return castValue(value, source, target, ctx.typeCtx);
  });
}

function typedRowEquals(left: SqlValue[], right: SqlValue[], types: DataType[]): boolean {
  for (let index = 0; index < types.length; index++) {
    const type = types[index] as DataType;
    if (!isNotDistinct(left[index] as SqlValue, right[index] as SqlValue, { ignoreTrailingSpaces: type.kind === "CHAR" })) {
      return false;
    }
  }
  return true;
}

function unionDistinct(left: SqlValue[][], right: SqlValue[][], types: DataType[]): SqlValue[][] {
  const kept: SqlValue[][] = [];
  for (const row of [...left, ...right]) {
    if (!kept.some((other) => typedRowEquals(other, row, types))) kept.push(row);
  }
  return kept;
}

function deduplicateTyped(rows: SqlValue[][], types: DataType[]): SqlValue[][] {
  const kept: SqlValue[][] = [];
  for (const row of rows) {
    if (!kept.some((other) => typedRowEquals(other, row, types))) kept.push(row);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// 정렬과 행 수 제한
// ---------------------------------------------------------------------------

function applyOrderAndLimit(
  columns: { name: string; type: DataType }[],
  rows: SqlValue[][],
  rowSources: CombinedRow[],
  orderBy: Query["orderBy"],
  offset: Query["offset"],
  fetch: Query["fetch"],
  ctx: QueryContext,
): { columns: { name: string; type: DataType }[]; rows: SqlValue[][] } {
  let orderedRows = rows;
  if (orderBy.length > 0) {
    const keys = rows.map((row, index) => ({
      row,
      keys: orderBy.map((item) => evaluateOrderKey(item, columns, row, (rowSources[index] ?? []) as CombinedRow, ctx)),
    }));
    keys.sort((left, right) => {
      for (let index = 0; index < orderBy.length; index++) {
        const item = orderBy[index] as Query["orderBy"][number];
        const leftEntry = left.keys[index] as TypedValue;
        const rightEntry = right.keys[index] as TypedValue;
        const order = compareForSort(leftEntry.value, rightEntry.value, {
          descending: item.descending,
          nulls: item.nulls ?? undefined,
          ignoreTrailingSpaces: leftEntry.type.kind === "CHAR" && rightEntry.type.kind === "CHAR",
        });
        if (order !== 0) return order;
      }
      return 0;
    });
    orderedRows = keys.map((entry) => entry.row);
  }
  const offsetCount = offset === null ? 0n : limitValue(offset, ctx);
  if (offsetCount < 0n) {
    fail("22023", ERROR_CODES.TYPE_PARAMETER_INVALID, "OFFSET must not be negative.");
  }
  const fetchCount = fetch === null ? null : fetch.count === null ? 1n : limitValue(fetch.count, ctx);
  if (fetchCount !== null && fetchCount < 0n) {
    fail("22023", ERROR_CODES.TYPE_PARAMETER_INVALID, "FETCH count must not be negative.");
  }
  // LIMIT는 파서가 fetch로 바꾸어 둔다. (sql-syntax.md)
  const limited = fetchCount === null
    ? orderedRows.slice(Number(offsetCount))
    : orderedRows.slice(Number(offsetCount), Number(offsetCount + fetchCount));
  return { columns, rows: limited };
}

/** ORDER BY 식을 한 행에 적용한다. 출력 별칭이 출처 열보다 먼저이다. */
function evaluateOrderKey(
  item: Query["orderBy"][number],
  columns: { name: string; type: DataType }[],
  row: SqlValue[],
  sources: CombinedRow,
  ctx: QueryContext,
): TypedValue {
  // 출력 열과 같은 이름이면 그 값을 쓴다.
  const orderExpr: Expression = item.expression;
  if (orderExpr.kind === "Column" && orderExpr.qualifier.length === 0) {
    const found = columns.findIndex((column) => column.name === (orderExpr as { name: string }).name);
    if (found >= 0) {
      return { value: (row[found] ?? null) as SqlValue, type: (columns[found] as { type: DataType }).type };
    }
  }
  const outputScope: RowScope = {
    tablespace: null,
    table: null,
    alias: null,
    slots: columns.map((column, index) => ({ column: column.name, value: (row[index] ?? null) as SqlValue, type: column.type })),
  };
  return evaluateExpression(item.expression, evalContextFor([...sources, outputScope], ctx, false));
}

/** 행 수 제한 값을 음이 아닌 정수로 바꾼다. */
function limitValue(expression: Expression, ctx: QueryContext): bigint {
  const bound = evaluateExpression(expression, evalContextFor([], ctx, true));
  if (bound.value === null) {
    fail("22023", ERROR_CODES.TYPE_PARAMETER_INVALID, "Row limit must not be NULL.");
  }
  if (typeof bound.value === "bigint") return bound.value;
  if (typeof bound.value === "number") {
    if (!Number.isInteger(bound.value)) {
      fail("22023", ERROR_CODES.TYPE_PARAMETER_INVALID, "Row limit must be an integer.");
    }
    return BigInt(bound.value);
  }
  fail("22023", ERROR_CODES.TYPE_PARAMETER_INVALID, "Row limit must be an integer.");
}

// ---------------------------------------------------------------------------
// 타입 전용 추론 (행이 없을 때의 메타데이터)
// ---------------------------------------------------------------------------

/** 행 없이 질의의 출력 열을 알아본다. */
export function inferOutputColumns(query: Query, ctx: QueryContext): { name: string; type: DataType }[] {
  const body = query.body;
  if (body.kind === "Select") {
    return inferSelectColumns(body, body.from.map((reference) => bindSource(ctx.manager, reference, ctx.currentTablespace, ctx.viewStack)), ctx);
  }
  if (body.kind === "SetOperation") {
    const left = inferBodyColumns(body.left, ctx);
    const right = inferBodyColumns(body.right, ctx);
    if (left.length !== right.length) {
      fail("42804", ERROR_CODES.SET_OPERATION_MISMATCH, "Set operation queries must have the same number of columns.");
    }
    return left.map((column, index) => {
      const common = commonType(column.type, (right[index] as { type: DataType }).type);
      if (common === null) {
        fail("42804", ERROR_CODES.SET_OPERATION_MISMATCH, "Set operation queries have incompatible types.");
      }
      return { name: column.name, type: common as DataType };
    });
  }
  return inferOutputColumns(body, ctx);
}

function inferBodyColumns(body: QueryBody, ctx: QueryContext): { name: string; type: DataType }[] {
  if (body.kind === "Select") {
    return inferSelectColumns(body, body.from.map((reference) => bindSource(ctx.manager, reference, ctx.currentTablespace, ctx.viewStack)), ctx);
  }
  if (body.kind === "SetOperation") {
    return inferOutputColumns({ kind: "Query", body, orderBy: [], offset: null, fetch: null, forUpdate: false }, ctx);
  }
  return inferOutputColumns(body, ctx);
}

/** SELECT의 출력 열을 행 없이 알아본다. */
function inferSelectColumns(select: Select, boundList: BoundSource[], ctx: QueryContext): { name: string; type: DataType }[] {
  const scopes = typeScopes(boundList, ctx);
  const evalCtx = evalContextFor(scopes, ctx, true);
  const out: { name: string; type: DataType }[] = [];
  select.items.forEach((item, index) => {
    if (item.kind === "Star") {
      for (const column of expandStarTypes(item.qualifier, scopes, item.position)) {
        out.push(column);
      }
      return;
    }
    const bound = evaluateExpression(item.expression, evalCtx);
    out.push({ name: item.alias ?? defaultColumnName(item.expression, `COL${index + 1}`), type: bound.type });
  });
  return out;
}

/** 출처들의 타입 전용 범위를 만든다. 값은 모두 NULL 이다. */
function typeScopes(boundList: BoundSource[], ctx: QueryContext): RowScope[] {
  const scopes: RowScope[] = [];
  for (const bound of boundList) {
    scopes.push(...typeScopesOf(bound, ctx));
  }
  return scopes;
}

function typeScopesOf(bound: BoundSource, ctx: QueryContext): RowScope[] {
  switch (bound.kind) {
    case "table":
      return [{
        tablespace: bound.tablespace,
        table: bound.table,
        alias: bound.alias,
        slots: bound.def.columns.map((column) => ({ column: column.name, value: null, type: column.dataType })),
      }];
    case "view": {
      const viewCtx = { ...ctx, currentTablespace: bound.tablespace, viewStack: [...ctx.viewStack, `${bound.tablespace}.${bound.view}`] };
      const columns = inferOutputColumns(bound.query, viewCtx);
      const names = bound.def.columns.length === columns.length ? bound.def.columns : columns.map((column) => column.name);
      return [{
        tablespace: bound.tablespace,
        table: bound.view,
        alias: bound.alias,
        slots: columns.map((column, index) => ({ column: (names[index] as string) ?? column.name, value: null, type: column.type })),
      }];
    }
    case "derived": {
      const columns = inferOutputColumns(bound.query, ctx);
      const names = bound.columns ?? columns.map((column) => column.name);
      return [{
        tablespace: null,
        table: null,
        alias: bound.alias,
        slots: columns.map((column, index) => ({ column: (names[index] as string) ?? column.name, value: null, type: column.type })),
      }];
    }
    case "join": {
      const left = typeScopesOf(bound.left, ctx);
      const right = typeScopesOf(bound.right, ctx);
      if (bound.on !== null) return [...left, ...right];
      const using = bound.using ?? [];
      return [...left, ...right.map((scope) => ({ ...scope, hidden: [...(scope.hidden ?? []), ...using] }))];
    }
    case "dual":
      return [{ tablespace: "SYSTEM", table: "DUAL", alias: null, slots: [{ column: "DUMMY", value: null, type: varcharType(1) }] }];
    case "dictionary": {
      const columns = getDictionaryColumns(bound.view);
      return [{ tablespace: "SYSTEM", table: bound.view, alias: null, slots: columns.map((column) => ({ column: column.name, value: null, type: column.dataType })) }];
    }
    case "bare":
      return [];
  }
}

function expandStarTypes(
  qualifier: string[],
  scopes: RowScope[],
  position: SourcePosition,
): { name: string; type: DataType }[] {
  const out: { name: string; type: DataType }[] = [];
  for (const scope of scopes) {
    if (qualifier.length === 2) {
      if (scope.tablespace !== qualifier[0]) continue;
      if (scope.table !== qualifier[1] && scope.alias !== qualifier[1]) continue;
    } else if (qualifier.length === 1) {
      if (scope.table !== qualifier[0] && scope.alias !== qualifier[0]) continue;
    }
    for (const slot of scope.slots) {
      if (scope.hidden?.includes(slot.column)) continue;
      out.push({ name: slot.column, type: slot.type });
    }
  }
  if (qualifier.length > 0 && out.length === 0) {
    fail("42703", ERROR_CODES.COLUMN_NOT_FOUND, `Table does not exist for *: "${qualifier.join(".")}".`, position);
  }
  return out;
}

/** 출처 하나의 타입 전용 열 목록을 돌려준다. 바깥 조인의 NULL 범위에 쓴다. */
export function inferSourceColumns(source: BoundSource, ctx: QueryContext): { name: string; type: DataType }[] {
  return typeScopesOf(source, ctx).flatMap((scope) =>
    scope.slots
      .filter((slot) => !(scope.hidden?.includes(slot.column) ?? false))
      .map((slot) => ({ name: slot.column, type: slot.type })),
  );
}

/** DML의 WHERE 탐색에 쓸 단일 테이블 스캔이다. 행 식별자와 함께 돌려준다. */
export function scanTableForDml(
  catalog: CatalogStore,
  table: StoredTable,
  tablespace: string,
  alias: string | null,
  where: Expression | null,
  ctx: QueryContext,
): { id: RowId; values: SqlValue[]; scopes: RowScope[] }[] {
  const stored = readTableRows(catalog, table);
  const out: { id: RowId; values: SqlValue[]; scopes: RowScope[] }[] = [];
  for (const row of stored) {
    const scopes: RowScope[] = [{
      tablespace,
      table: table.name,
      alias,
      slots: table.columns.map((column, index) => ({
        column: column.name,
        value: (row.values[index] ?? null) as SqlValue,
        type: column.dataType,
      })),
    }];
    if (where !== null && evaluateCondition(where, evalContextFor(scopes, ctx, false)) !== true) {
      continue;
    }
    out.push({ id: row.id, values: row.values, scopes });
  }
  return out;
}
