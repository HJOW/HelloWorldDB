/**
 * 연산자의 결과 타입과 계산.
 *
 * 담당
 *  - 사칙연산(`+`, `-`, `*`, `/`), 단항 `-`, 문자열 연결 `||` 의 결과 타입 정하기와 계산
 *  - 수 계열 : 정수끼리의 나눗셈은 정수(0 방향 버림), NUMERIC 은 10진 정확 연산, 0 으로 나누면 오류
 *  - 날짜시간과 INTERVAL 사이의 연산
 *  - 연산에 NULL 이 섞이면 결과는 NULL 이다. (`||` 포함)
 *
 * 연산자는 타입에 따라 한 번 묶어 두고(bind) 행마다 계산만 한다.
 * 결과 타입을 정하는 규칙은 docs/data-types.md 에 정리했다.
 *
 * 관련 사양 : AGENTS.md 상세 1-2, 1-4
 * 구현 단계 : 3단계
 */

import { internalError } from "../common/errors.js";
import { capDecimalType, castValue, commonType, integerAsDecimalType, mergeIntervalTypes } from "./cast.js";
import type { TypeContext } from "./cast.js";
import {
  BINARY_MAX_LENGTH,
  CHAR_MAX_LENGTH,
  DATE_TYPE,
  DOUBLE_TYPE,
  INTEGER_TYPE,
  MAX_INTERVAL_LEADING_PRECISION,
  REAL_TYPE,
  VARBINARY_MAX_LENGTH,
  VARCHAR_MAX_LENGTH,
  binaryType,
  charType,
  formatDataType,
  integerType,
  intervalType,
  timeType,
  timestampType,
  varbinaryType,
  varcharType,
} from "./dataType.js";
import type {
  DataType,
  DateDataType,
  DecimalDataType,
  FloatingPointDataType,
  IntegerDataType,
  IntervalDataType,
  TimeDataType,
  TimestampDataType,
} from "./dataType.js";
import {
  addDaysToDate,
  addIntervals,
  addIntervalToDate,
  addIntervalToTime,
  addIntervalToTimestamp,
  DateValue,
  divideInterval,
  intervalClassOf,
  IntervalValue,
  MICROS_PER_DAY,
  multiplyInterval,
  negateInterval,
  subtractTimes,
  subtractTimestamps,
  TimestampValue,
  TimeValue,
} from "./datetime.js";
import { divisionByZero, typeMismatch } from "./errors.js";
import { Decimal } from "./numeric.js";
import { conformValue } from "./value.js";
import type { NonNullValue, SqlValue } from "./value.js";

export type ArithmeticOperator = "+" | "-" | "*" | "/";

/** 타입에 묶인 이항 연산. */
export interface BinaryOperation {
  readonly resultType: DataType;
  /** 한쪽이라도 NULL 이면 NULL 이다. 결과는 resultType 에 맞춘 값이다. */
  evaluate(left: SqlValue, right: SqlValue, context: TypeContext): SqlValue;
}

/** 타입에 묶인 단항 연산. */
export interface UnaryOperation {
  readonly resultType: DataType;
  /** NULL 이면 NULL 이다. */
  evaluate(value: SqlValue): SqlValue;
}

type NumericType = IntegerDataType | DecimalDataType | FloatingPointDataType;
type Compute = (left: NonNullValue, right: NonNullValue, context: TypeContext) => SqlValue;

function binary(resultType: DataType, compute: Compute): BinaryOperation {
  return {
    resultType,
    evaluate(left, right, context) {
      if (left === null || right === null) return null;
      return conformValue(compute(left, right, context), resultType);
    },
  };
}

function undefinedOperator(operator: string, left: DataType, right: DataType): Error {
  return typeMismatch(
    `Operator ${operator} is not defined for ${formatDataType(left)} and ${formatDataType(right)}.`,
  );
}

function isNumericType(type: DataType): type is NumericType {
  return type.kind === "INTEGER" || type.kind === "DECIMAL" || type.kind === "FLOAT";
}

// ---------------------------------------------------------------------------
// 값을 꺼내는 도우미. 타입과 값의 표현이 어긋나면 내부 오류이다.
// ---------------------------------------------------------------------------

function asBigInt(value: NonNullValue): bigint {
  if (typeof value === "bigint") return value;
  throw internalError("Integer value expected.");
}

function asDecimal(value: NonNullValue): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value === "bigint") return Decimal.fromBigInt(value);
  throw internalError("Exact numeric value expected.");
}

function asNumber(value: NonNullValue): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Decimal) return value.toNumber();
  throw internalError("Numeric value expected.");
}

/** 수 계열 값을 INTERVAL 의 곱셈, 나눗셈에 쓸 10진수로 바꾼다. */
function asFactor(value: NonNullValue): Decimal {
  return typeof value === "number" ? Decimal.fromNumber(value) : asDecimal(value);
}

function asDate(value: NonNullValue): DateValue {
  if (value instanceof DateValue) return value;
  throw internalError("DATE value expected.");
}

function asTime(value: NonNullValue): TimeValue {
  if (value instanceof TimeValue) return value;
  throw internalError("TIME value expected.");
}

function asTimestamp(value: NonNullValue): TimestampValue {
  if (value instanceof TimestampValue) return value;
  throw internalError("TIMESTAMP value expected.");
}

function asInterval(value: NonNullValue): IntervalValue {
  if (value instanceof IntervalValue) return value;
  throw internalError("INTERVAL value expected.");
}

// ---------------------------------------------------------------------------
// 수 계열
// ---------------------------------------------------------------------------

/** 정수끼리의 연산 결과는 두 타입 중 넓은 쪽이며, 적어도 INTEGER 이다. */
function integerResultType(left: IntegerDataType, right: IntegerDataType): IntegerDataType {
  return integerType(Math.max(32, left.bits, right.bits) as 32 | 64);
}

/** NUMERIC 연산의 결과 타입. 정밀도는 38 을 넘지 않는다. */
function decimalResultType(operator: ArithmeticOperator, left: DecimalDataType, right: DecimalDataType): DecimalDataType {
  const leftInteger = left.precision - left.scale;
  const rightInteger = right.precision - right.scale;
  switch (operator) {
    case "+":
    case "-": {
      const scale = Math.max(left.scale, right.scale);
      return capDecimalType(Math.max(leftInteger, rightInteger) + scale + 1, scale);
    }
    case "*":
      return capDecimalType(left.precision + right.precision + 1, left.scale + right.scale);
    case "/": {
      const scale = Math.max(6, left.scale + right.precision + 1);
      return capDecimalType(leftInteger + right.scale + scale, scale);
    }
  }
}

function bindNumeric(operator: ArithmeticOperator, left: NumericType, right: NumericType): BinaryOperation {
  if (left.kind === "FLOAT" || right.kind === "FLOAT") {
    const single = left.kind === "FLOAT" && right.kind === "FLOAT" && left.bits === 32 && right.bits === 32;
    return binary(single ? REAL_TYPE : DOUBLE_TYPE, (l, r) => {
      const a = asNumber(l);
      const b = asNumber(r);
      switch (operator) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/":
          if (b === 0) throw divisionByZero();
          return a / b;
      }
    });
  }

  if (left.kind === "DECIMAL" || right.kind === "DECIMAL") {
    const resultType = decimalResultType(
      operator,
      left.kind === "INTEGER" ? integerAsDecimalType(left) : left,
      right.kind === "INTEGER" ? integerAsDecimalType(right) : right,
    );
    return binary(resultType, (l, r) => {
      const a = asDecimal(l);
      const b = asDecimal(r);
      switch (operator) {
        case "+": return a.add(b);
        case "-": return a.subtract(b);
        case "*": return a.multiply(b);
        case "/": return a.divide(b, resultType.scale);
      }
    });
  }

  return binary(integerResultType(left, right), (l, r) => {
    const a = asBigInt(l);
    const b = asBigInt(r);
    switch (operator) {
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/":
        if (b === 0n) throw divisionByZero();
        // bigint 의 나눗셈은 0 방향으로 버린다.
        return a / b;
    }
  });
}

// ---------------------------------------------------------------------------
// 날짜시간과 INTERVAL
// ---------------------------------------------------------------------------

type DatetimeType = DateDataType | TimeDataType | TimestampDataType;

function isDatetimeType(type: DataType): type is DatetimeType {
  return type.kind === "DATE" || type.kind === "TIME" || type.kind === "TIMESTAMP";
}

/** 계산으로 얻은 INTERVAL 의 타입. 선행 정밀도는 최대값으로 두어 계산 결과가 넘치지 않게 한다. */
function computedIntervalType(type: IntervalDataType): IntervalDataType {
  return intervalType(type.startField, type.endField, MAX_INTERVAL_LEADING_PRECISION, type.fractionalPrecision ?? 0);
}

/** 날짜시간 ± INTERVAL. left 가 날짜시간, right 가 INTERVAL 값이다. */
function bindDatetimeInterval(
  operator: "+" | "-",
  datetime: DatetimeType,
  interval: IntervalDataType,
): BinaryOperation {
  const sign = operator === "+" ? 1 : -1;
  const yearMonth = intervalClassOf(interval) === "YEAR_MONTH";
  const fraction = interval.fractionalPrecision ?? 0;

  if (datetime.kind === "DATE") {
    if (yearMonth || interval.endField === "DAY") {
      return binary(DATE_TYPE, (l, r) => addIntervalToDate(asDate(l), asInterval(r), sign));
    }
    // 시각 필드가 있는 기간을 더하면 결과는 TIMESTAMP 이다.
    return binary(timestampType(fraction, false), (l, r) =>
      addIntervalToTimestamp(
        new TimestampValue(BigInt(asDate(l).days) * BigInt(MICROS_PER_DAY), null),
        asInterval(r),
        sign,
      ));
  }
  if (datetime.kind === "TIMESTAMP") {
    return binary(
      timestampType(Math.max(datetime.fractionalPrecision, fraction), datetime.withTimeZone),
      (l, r) => addIntervalToTimestamp(asTimestamp(l), asInterval(r), sign),
    );
  }
  if (yearMonth) {
    throw undefinedOperator(operator, datetime, interval);
  }
  return binary(
    timeType(Math.max(datetime.fractionalPrecision, fraction), datetime.withTimeZone),
    (l, r) => addIntervalToTime(asTime(l), asInterval(r), sign),
  );
}

/** 인자의 좌우를 바꾼 연산. (INTERVAL + 날짜시간, 수 * INTERVAL 처럼 교환할 수 있는 경우) */
function swapped(operation: BinaryOperation): BinaryOperation {
  return {
    resultType: operation.resultType,
    evaluate: (left, right, context) => operation.evaluate(right, left, context),
  };
}

function bindDatetime(operator: ArithmeticOperator, left: DataType, right: DataType): BinaryOperation | null {
  if (operator === "+" || operator === "-") {
    // DATE ± 정수 일수
    if (left.kind === "DATE" && right.kind === "INTEGER") {
      const sign = operator === "+" ? 1n : -1n;
      return binary(DATE_TYPE, (l, r) => addDaysToDate(asDate(l), sign * asBigInt(r)));
    }
    if (isDatetimeType(left) && right.kind === "INTERVAL") {
      return bindDatetimeInterval(operator, left, right);
    }
    if (left.kind === "INTERVAL" && right.kind === "INTERVAL" && intervalClassOf(left) === intervalClassOf(right)) {
      const sign = operator === "+" ? 1 : -1;
      return binary(computedIntervalType(mergeIntervalTypes(left, right)), (l, r) =>
        addIntervals(asInterval(l), asInterval(r), sign));
    }
  }

  if (operator === "+") {
    if (left.kind === "INTEGER" && right.kind === "DATE") {
      return swapped(bindDatetime("+", right, left) as BinaryOperation);
    }
    if (left.kind === "INTERVAL" && isDatetimeType(right)) {
      return swapped(bindDatetimeInterval("+", right, left));
    }
    return null;
  }

  if (operator === "-") {
    // DATE - DATE 는 일수이다.
    if (left.kind === "DATE" && right.kind === "DATE") {
      return binary(INTEGER_TYPE, (l, r) => BigInt(asDate(l).days - asDate(r).days));
    }
    // TIMESTAMP 가 낀 뺄셈은 두 값을 공통 타입으로 맞춘 뒤 경과 시간을 구한다.
    if ((left.kind === "DATE" || left.kind === "TIMESTAMP") && (right.kind === "DATE" || right.kind === "TIMESTAMP")) {
      const common = commonType(left, right) as TimestampDataType;
      return binary(
        intervalType("DAY", "SECOND", MAX_INTERVAL_LEADING_PRECISION, common.fractionalPrecision),
        (l, r, context) => subtractTimestamps(
          asTimestamp(castValue(l, left, common, context) as NonNullValue),
          asTimestamp(castValue(r, right, common, context) as NonNullValue),
        ),
      );
    }
    if (left.kind === "TIME" && right.kind === "TIME") {
      const common = commonType(left, right) as TimeDataType;
      return binary(
        intervalType("HOUR", "SECOND", MAX_INTERVAL_LEADING_PRECISION, common.fractionalPrecision),
        (l, r, context) => subtractTimes(
          asTime(castValue(l, left, common, context) as NonNullValue),
          asTime(castValue(r, right, common, context) as NonNullValue),
        ),
      );
    }
    return null;
  }

  if (operator === "*") {
    if (left.kind === "INTERVAL" && isNumericType(right)) {
      return binary(computedIntervalType(left), (l, r) => multiplyInterval(asInterval(l), asFactor(r)));
    }
    if (isNumericType(left) && right.kind === "INTERVAL") {
      return swapped(bindDatetime("*", right, left) as BinaryOperation);
    }
    return null;
  }

  if (left.kind === "INTERVAL" && isNumericType(right)) {
    return binary(computedIntervalType(left), (l, r) => divideInterval(asInterval(l), asFactor(r)));
  }
  return null;
}

// ---------------------------------------------------------------------------
// 공개 함수
// ---------------------------------------------------------------------------

/**
 * 사칙연산을 두 인자의 타입에 묶는다. 정의되지 않은 조합이면 42804 이다.
 * 결과 타입은 `resultType` 으로 미리 알 수 있고, 행마다 `evaluate` 만 부른다.
 */
export function bindArithmetic(operator: ArithmeticOperator, left: DataType, right: DataType): BinaryOperation {
  if (isNumericType(left) && isNumericType(right)) {
    return bindNumeric(operator, left, right);
  }
  const operation = bindDatetime(operator, left, right);
  if (operation === null) {
    throw undefinedOperator(operator, left, right);
  }
  return operation;
}

/** 사칙연산을 한 번 계산한다. 같은 타입 조합으로 여러 번 계산할 때는 `bindArithmetic` 을 쓴다. */
export function evaluateArithmetic(
  operator: ArithmeticOperator,
  left: SqlValue,
  leftType: DataType,
  right: SqlValue,
  rightType: DataType,
  context: TypeContext,
): SqlValue {
  return bindArithmetic(operator, leftType, rightType).evaluate(left, right, context);
}

/** 단항 `-` 를 타입에 묶는다. 수 계열과 INTERVAL 에만 정의된다. */
export function bindNegate(type: DataType): UnaryOperation {
  let resultType: DataType;
  let compute: (value: NonNullValue) => SqlValue;
  if (type.kind === "INTEGER") {
    resultType = integerResultType(type, type);
    compute = (value) => -asBigInt(value);
  } else if (type.kind === "DECIMAL") {
    resultType = type;
    compute = (value) => asDecimal(value).negate();
  } else if (type.kind === "FLOAT") {
    resultType = type;
    compute = (value) => -asNumber(value);
  } else if (type.kind === "INTERVAL") {
    resultType = type;
    compute = (value) => negateInterval(asInterval(value));
  } else {
    throw typeMismatch(`Operator - is not defined for ${formatDataType(type)}.`);
  }
  return {
    resultType,
    evaluate: (value) => (value === null ? null : conformValue(compute(value), resultType)),
  };
}

/**
 * 연결 연산자 `||` 를 타입에 묶는다. 문자끼리 또는 이진끼리만 정의된다.
 * 결과 길이는 두 길이의 합이며, 고정 길이끼리이고 상한 안이면 고정 길이이다.
 */
export function bindConcat(left: DataType, right: DataType): BinaryOperation {
  if ((left.kind === "CHAR" || left.kind === "VARCHAR") && (right.kind === "CHAR" || right.kind === "VARCHAR")) {
    const length = left.length + right.length;
    const fixed = left.kind === "CHAR" && right.kind === "CHAR" && length <= CHAR_MAX_LENGTH;
    return binary(fixed ? charType(length) : varcharType(Math.min(length, VARCHAR_MAX_LENGTH)), (l, r) => {
      if (typeof l !== "string" || typeof r !== "string") throw internalError("Character value expected.");
      return l + r;
    });
  }
  if ((left.kind === "BINARY" || left.kind === "VARBINARY") && (right.kind === "BINARY" || right.kind === "VARBINARY")) {
    const length = left.length + right.length;
    const fixed = left.kind === "BINARY" && right.kind === "BINARY" && length <= BINARY_MAX_LENGTH;
    return binary(fixed ? binaryType(length) : varbinaryType(Math.min(length, VARBINARY_MAX_LENGTH)), (l, r) => {
      if (!Buffer.isBuffer(l) || !Buffer.isBuffer(r)) throw internalError("Binary value expected.");
      return Buffer.concat([l, r]);
    });
  }
  throw undefinedOperator("||", left, right);
}
