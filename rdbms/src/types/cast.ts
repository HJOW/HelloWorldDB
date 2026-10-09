/**
 * 형변환.
 *
 * 담당
 *  - 암묵적 형변환 : 같은 계열 안에서만 한다. (정수 → NUMERIC → 부동소수, DATE ↔ TIMESTAMP 등)
 *  - 명시적 형변환 : CAST(식 AS 타입)
 *  - 문자열 리터럴을 문맥이 요구하는 타입으로 해석한다. (예 : 날짜 컬럼과 비교하는 '2026-01-01')
 *  - 두 타입을 함께 다룰 때의 공통 타입 정하기 (비교, CASE, 집합 연산)
 *
 * 연산 결과의 타입과 계산은 arithmetic.ts 가 맡는다.
 *
 * 관련 사양 : AGENTS.md 상세 1-2
 * 구현 단계 : 3단계
 */

import {
  DECIMAL_MAX_PRECISION,
  DOUBLE_TYPE,
  MAX_INTERVAL_LEADING_PRECISION,
  REAL_TYPE,
  binaryType,
  charType,
  decimalType,
  formatDataType,
  intervalType,
  timeType,
  timestampType,
  varbinaryType,
  varcharType,
} from "./dataType.js";
import type {
  DataType,
  DecimalDataType,
  IntegerDataType,
  IntervalDataType,
  IntervalField,
  TimeDataType,
  TimestampDataType,
} from "./dataType.js";
import {
  attachTimeZone,
  DateValue,
  detachTimeZone,
  intervalClassOf,
  IntervalValue,
  MICROS_PER_DAY,
  MICROS_PER_HOUR,
  MICROS_PER_MINUTE,
  MICROS_PER_SECOND,
  parseIntervalText,
  parseTimestampText,
  parseTimeText,
  splitLocalMicros,
  TimestampValue,
  TimeValue,
} from "./datetime.js";
import type { TimeZone } from "./datetime.js";
import { castNotSupported, invalidCastValue, numericOutOfRange, quoteForMessage, typeMismatch } from "./errors.js";
import { Decimal } from "./numeric.js";
import { conformValue, formatValue, parseHex } from "./value.js";
import type { NonNullValue, SqlValue } from "./value.js";

/** 형변환과 날짜시간 연산에 필요한 세션 정보. */
export interface TypeContext {
  /** 세션 타임존. */
  readonly timeZone: TimeZone;
  /** 문장을 시작한 시각 (UTC 기준 마이크로초). 한 문장 안에서는 같은 값이다. */
  readonly currentUtcMicros: bigint;
}

/** 암묵적 형변환을 허용하는 단위. 같은 계열 안에서만 암묵적으로 바꾼다. */
export type TypeFamily =
  | "CHARACTER"
  | "BINARY"
  | "NUMERIC"
  | "BOOLEAN"
  | "DATETIME"
  | "TIME"
  | "INTERVAL_YEAR_MONTH"
  | "INTERVAL_DAY_TIME";

export function typeFamily(type: DataType): TypeFamily {
  switch (type.kind) {
    case "CHAR":
    case "VARCHAR":
      return "CHARACTER";
    case "BINARY":
    case "VARBINARY":
      return "BINARY";
    case "INTEGER":
    case "DECIMAL":
    case "FLOAT":
      return "NUMERIC";
    case "BOOLEAN":
      return "BOOLEAN";
    case "DATE":
    case "TIMESTAMP":
      return "DATETIME";
    case "TIME":
      return "TIME";
    case "INTERVAL":
      return intervalClassOf(type) === "YEAR_MONTH" ? "INTERVAL_YEAR_MONTH" : "INTERVAL_DAY_TIME";
  }
}

/** 암묵적 형변환이 되는지 본다. 같은 계열이면 된다. (좁은 타입으로 가는 경우의 범위 검사는 실행 때 한다) */
export function isImplicitlyConvertible(from: DataType, to: DataType): boolean {
  return typeFamily(from) === typeFamily(to);
}

function isSingleFieldInterval(type: IntervalDataType): boolean {
  return type.startField === type.endField;
}

/** `CAST(from AS to)` 를 지원하는지 본다. */
export function isCastSupported(from: DataType, to: DataType): boolean {
  const source = typeFamily(from);
  const target = typeFamily(to);
  if (source === target) return true;
  if (target === "CHARACTER") return source !== "BINARY";
  if (source === "CHARACTER") return target !== "BINARY";
  if (source === "DATETIME" && target === "TIME") return from.kind === "TIMESTAMP";
  if (source === "TIME" && target === "DATETIME") return to.kind === "TIMESTAMP";
  // 정확한 수와 단일 필드 INTERVAL 사이
  if (from.kind === "INTERVAL" && (to.kind === "INTEGER" || to.kind === "DECIMAL")) return isSingleFieldInterval(from);
  if (to.kind === "INTERVAL" && (from.kind === "INTEGER" || from.kind === "DECIMAL")) return isSingleFieldInterval(to);
  return false;
}

// ---------------------------------------------------------------------------
// 수 계열의 타입 계산
// ---------------------------------------------------------------------------

/** 정수 타입을 같은 범위를 담는 DECIMAL 로 본다. */
export function integerAsDecimalType(type: IntegerDataType): DecimalDataType {
  return decimalType(type.bits === 16 ? 5 : type.bits === 32 ? 10 : 19, 0);
}

/**
 * 계산한 정밀도와 소수 자릿수를 최대 정밀도 38 안으로 맞춘다.
 * 넘으면 정수부를 먼저 지키고 소수 자릿수를 줄이되, 소수 자릿수는 min(원래 값, 6) 아래로 줄이지 않는다.
 */
export function capDecimalType(precision: number, scale: number): DecimalDataType {
  if (precision <= DECIMAL_MAX_PRECISION) {
    return decimalType(Math.max(1, precision), scale);
  }
  const integerDigits = precision - scale;
  const reduced = Math.max(DECIMAL_MAX_PRECISION - integerDigits, Math.min(scale, 6));
  return decimalType(DECIMAL_MAX_PRECISION, Math.max(0, Math.min(reduced, DECIMAL_MAX_PRECISION)));
}

const INTERVAL_FIELD_ORDER: readonly IntervalField[] = ["YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND"];

/** 두 INTERVAL 타입의 필드를 모두 담는 타입. 같은 계열이어야 한다. */
export function mergeIntervalTypes(left: IntervalDataType, right: IntervalDataType): IntervalDataType {
  const start = Math.min(INTERVAL_FIELD_ORDER.indexOf(left.startField), INTERVAL_FIELD_ORDER.indexOf(right.startField));
  const end = Math.max(INTERVAL_FIELD_ORDER.indexOf(left.endField), INTERVAL_FIELD_ORDER.indexOf(right.endField));
  const leadingPrecision = left.startField === right.startField
    ? Math.max(left.leadingPrecision, right.leadingPrecision)
    : MAX_INTERVAL_LEADING_PRECISION;
  return intervalType(
    INTERVAL_FIELD_ORDER[start] as IntervalField,
    INTERVAL_FIELD_ORDER[end] as IntervalField,
    leadingPrecision,
    Math.max(left.fractionalPrecision ?? 0, right.fractionalPrecision ?? 0),
  );
}

/**
 * 두 타입을 함께 다룰 때의 공통 타입. 비교, CASE, COALESCE, 집합 연산이 쓴다.
 * 계열이 다르면 null 이다.
 */
export function commonType(left: DataType, right: DataType): DataType | null {
  const family = typeFamily(left);
  if (family !== typeFamily(right)) return null;

  if ((left.kind === "CHAR" || left.kind === "VARCHAR") && (right.kind === "CHAR" || right.kind === "VARCHAR")) {
    const length = Math.max(left.length, right.length);
    return left.kind === "CHAR" && right.kind === "CHAR" ? charType(length) : varcharType(length);
  }
  if ((left.kind === "BINARY" || left.kind === "VARBINARY") && (right.kind === "BINARY" || right.kind === "VARBINARY")) {
    const length = Math.max(left.length, right.length);
    return left.kind === "BINARY" && right.kind === "BINARY" ? binaryType(length) : varbinaryType(length);
  }
  if (left.kind === "BOOLEAN") return left;

  if (family === "NUMERIC") {
    if (left.kind === "FLOAT" || right.kind === "FLOAT") {
      return left.kind === "FLOAT" && right.kind === "FLOAT" && left.bits === 32 && right.bits === 32
        ? REAL_TYPE
        : DOUBLE_TYPE;
    }
    if (left.kind === "INTEGER" && right.kind === "INTEGER") {
      return left.bits >= right.bits ? left : right;
    }
    const a = left.kind === "INTEGER" ? integerAsDecimalType(left) : (left as DecimalDataType);
    const b = right.kind === "INTEGER" ? integerAsDecimalType(right) : (right as DecimalDataType);
    const scale = Math.max(a.scale, b.scale);
    return capDecimalType(Math.max(a.precision - a.scale, b.precision - b.scale) + scale, scale);
  }

  if (family === "DATETIME") {
    if (left.kind === "DATE" && right.kind === "DATE") return left;
    const a = left.kind === "TIMESTAMP" ? left : null;
    const b = right.kind === "TIMESTAMP" ? right : null;
    return timestampType(
      Math.max(a?.fractionalPrecision ?? 0, b?.fractionalPrecision ?? 0),
      (a?.withTimeZone ?? false) || (b?.withTimeZone ?? false),
    );
  }
  if (left.kind === "TIME" && right.kind === "TIME") {
    return timeType(
      Math.max(left.fractionalPrecision, right.fractionalPrecision),
      left.withTimeZone || right.withTimeZone,
    );
  }
  if (left.kind === "INTERVAL" && right.kind === "INTERVAL") {
    return mergeIntervalTypes(left, right);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 값의 변환
// ---------------------------------------------------------------------------

const NUMBER_REGEX = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const MICROS_PER_MINUTE_BIG = BigInt(MICROS_PER_MINUTE);

function unsupported(from: DataType, to: DataType): Error {
  return castNotSupported(`Cannot cast ${formatDataType(from)} to ${formatDataType(to)}.`);
}

function sessionOffsetNow(context: TypeContext): number {
  return context.timeZone.offsetAtUtc(context.currentUtcMicros);
}

/** 세션 타임존에서의 오늘 날짜 (일수). */
function currentLocalDays(context: TypeContext): number {
  const local = context.currentUtcMicros + BigInt(sessionOffsetNow(context)) * MICROS_PER_MINUTE_BIG;
  return splitLocalMicros(local).days;
}

function floorMod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

function toInteger(value: NonNullValue, from: DataType, to: DataType): SqlValue {
  if (typeof value === "bigint") return value;
  if (value instanceof Decimal) return value.toBigInt();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw numericOutOfRange(`Value out of range for ${to.name}.`);
    // 0 에서 먼 쪽으로 반올림한다.
    return BigInt(value < 0 ? -Math.round(-value) : Math.round(value));
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^[+-]?\d+$/.test(text)) {
      throw invalidCastValue(`Invalid integer value: ${quoteForMessage(value)}.`);
    }
    return BigInt(text);
  }
  if (value instanceof IntervalValue && from.kind === "INTERVAL") {
    return intervalToDecimal(value, from).toBigInt();
  }
  throw unsupported(from, to);
}

function toDecimal(value: NonNullValue, from: DataType, to: DataType): SqlValue {
  if (value instanceof Decimal) return value;
  if (typeof value === "bigint") return Decimal.fromBigInt(value);
  if (typeof value === "number") return Decimal.fromNumber(value);
  if (typeof value === "string") return Decimal.parse(value);
  if (value instanceof IntervalValue && from.kind === "INTERVAL") return intervalToDecimal(value, from);
  throw unsupported(from, to);
}

function toFloat(value: NonNullValue, from: DataType, to: DataType): SqlValue {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Decimal) return value.toNumber();
  if (typeof value === "string") {
    const text = value.trim();
    if (!NUMBER_REGEX.test(text)) {
      throw invalidCastValue(`Invalid floating point value: ${quoteForMessage(value)}.`);
    }
    return Number(text);
  }
  throw unsupported(from, to);
}

function toBoolean(value: NonNullValue, from: DataType, to: DataType): SqlValue {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const text = value.trim().toUpperCase();
    if (text === "TRUE") return true;
    if (text === "FALSE") return false;
    if (text === "UNKNOWN") return null;
    throw invalidCastValue(`Invalid boolean value: ${quoteForMessage(value)}.`);
  }
  throw unsupported(from, to);
}

function toDate(value: NonNullValue, from: DataType, to: DataType, context: TypeContext): SqlValue {
  if (value instanceof DateValue) return value;
  let timestamp: TimestampValue;
  if (value instanceof TimestampValue) {
    timestamp = value;
  } else if (typeof value === "string") {
    const parsed = parseTimestampText(value);
    timestamp = TimestampValue.fromLocal(parsed.localMicros, parsed.offsetMinutes);
  } else {
    throw unsupported(from, to);
  }
  return new DateValue(splitLocalMicros(detachTimeZone(timestamp, context.timeZone).micros).days);
}

function toTimestamp(value: NonNullValue, from: DataType, to: TimestampDataType, context: TypeContext): SqlValue {
  let timestamp: TimestampValue;
  if (value instanceof TimestampValue) {
    timestamp = value;
  } else if (value instanceof DateValue) {
    timestamp = new TimestampValue(BigInt(value.days) * BigInt(MICROS_PER_DAY), null);
  } else if (value instanceof TimeValue) {
    // 날짜는 세션 타임존의 오늘이다. 타임존이 있는 TIME 은 세션 타임존의 시각으로 옮긴다.
    const local = value.offsetMinutes === null
      ? value.micros
      : floorMod(value.micros + sessionOffsetNow(context) * MICROS_PER_MINUTE, MICROS_PER_DAY);
    timestamp = new TimestampValue(BigInt(currentLocalDays(context)) * BigInt(MICROS_PER_DAY) + BigInt(local), null);
  } else if (typeof value === "string") {
    const parsed = parseTimestampText(value);
    timestamp = TimestampValue.fromLocal(parsed.localMicros, parsed.offsetMinutes);
  } else {
    throw unsupported(from, to);
  }
  return to.withTimeZone
    ? attachTimeZone(timestamp, context.timeZone)
    : detachTimeZone(timestamp, context.timeZone);
}

function toTime(value: NonNullValue, from: DataType, to: TimeDataType, context: TypeContext): SqlValue {
  let time: TimeValue;
  if (value instanceof TimeValue) {
    time = value;
  } else if (value instanceof TimestampValue) {
    // 타임존 유무를 TIMESTAMP 단계에서 먼저 맞추어, 그 시각의 오프셋을 쓴다.
    const timestamp = to.withTimeZone
      ? attachTimeZone(value, context.timeZone)
      : detachTimeZone(value, context.timeZone);
    time = TimeValue.fromLocal(splitLocalMicros(timestamp.localMicros).microsOfDay, timestamp.offsetMinutes);
  } else if (typeof value === "string") {
    const parsed = parseTimeText(value);
    time = TimeValue.fromLocal(parsed.localMicros, parsed.offsetMinutes);
  } else {
    throw unsupported(from, to);
  }
  if (to.withTimeZone && time.offsetMinutes === null) {
    return TimeValue.fromLocal(time.micros, sessionOffsetNow(context));
  }
  if (!to.withTimeZone && time.offsetMinutes !== null) {
    return new TimeValue(floorMod(time.micros + sessionOffsetNow(context) * MICROS_PER_MINUTE, MICROS_PER_DAY), null);
  }
  return time;
}

const SINGLE_FIELD_MICROS: Record<"DAY" | "HOUR" | "MINUTE" | "SECOND", number> = {
  DAY: MICROS_PER_DAY,
  HOUR: MICROS_PER_HOUR,
  MINUTE: MICROS_PER_MINUTE,
  SECOND: MICROS_PER_SECOND,
};

/** 단일 필드 INTERVAL 을 그 필드 단위의 수로 바꾼다. SECOND 는 소수 6자리까지 가진다. */
function intervalToDecimal(value: IntervalValue, type: IntervalDataType): Decimal {
  if (!isSingleFieldInterval(type)) {
    throw castNotSupported(`Cannot cast ${formatDataType(type)} to a numeric type.`);
  }
  switch (type.startField) {
    case "YEAR":
      return Decimal.fromBigInt(BigInt(Math.trunc(value.months / 12)));
    case "MONTH":
      return Decimal.fromBigInt(BigInt(value.months));
    case "SECOND":
      return new Decimal(value.micros, 6);
    default:
      return Decimal.fromBigInt(value.micros / BigInt(SINGLE_FIELD_MICROS[type.startField]));
  }
}

function toInterval(value: NonNullValue, from: DataType, to: IntervalDataType): SqlValue {
  if (value instanceof IntervalValue) {
    if (value.intervalClass !== intervalClassOf(to)) throw unsupported(from, to);
    return value;
  }
  if (typeof value === "string") {
    return parseIntervalText(value, to);
  }
  if (typeof value === "bigint" || value instanceof Decimal) {
    if (!isSingleFieldInterval(to)) throw unsupported(from, to);
    const amount = typeof value === "bigint" ? Decimal.fromBigInt(value) : value;
    if (to.startField === "YEAR" || to.startField === "MONTH") {
      const months = amount.toBigInt() * (to.startField === "YEAR" ? 12n : 1n);
      if (months > BigInt(Number.MAX_SAFE_INTEGER) || months < -BigInt(Number.MAX_SAFE_INTEGER)) {
        throw numericOutOfRange("Interval value out of range.");
      }
      return IntervalValue.yearMonth(Number(months));
    }
    const unit = Decimal.fromBigInt(BigInt(SINGLE_FIELD_MICROS[to.startField]));
    return IntervalValue.dayTime(amount.multiply(unit).toBigInt());
  }
  throw unsupported(from, to);
}

function convert(value: NonNullValue, from: DataType, to: DataType, context: TypeContext): SqlValue {
  switch (to.kind) {
    case "CHAR":
    case "VARCHAR":
      if (typeof value === "string") return value;
      if (from.kind === "BINARY" || from.kind === "VARBINARY") throw unsupported(from, to);
      return formatValue(value, from);
    case "BINARY":
    case "VARBINARY":
      if (Buffer.isBuffer(value)) return value;
      throw unsupported(from, to);
    case "INTEGER":
      return toInteger(value, from, to);
    case "DECIMAL":
      return toDecimal(value, from, to);
    case "FLOAT":
      return toFloat(value, from, to);
    case "BOOLEAN":
      return toBoolean(value, from, to);
    case "DATE":
      return toDate(value, from, to, context);
    case "TIME":
      return toTime(value, from, to, context);
    case "TIMESTAMP":
      return toTimestamp(value, from, to, context);
    case "INTERVAL":
      return toInterval(value, from, to);
  }
}

/**
 * 값을 대상 타입으로 바꾼다. `CAST(식 AS 타입)` 의 동작이다.
 *  - NULL 은 NULL 이다.
 *  - 지원하지 않는 조합은 42846, 해석할 수 없는 문자열은 22018(수, 논리) · 22007(날짜시간) · 22006(기간),
 *    길이나 범위를 넘으면 22001 · 22003 · 22008 · 22015 이다.
 */
export function castValue(value: SqlValue, from: DataType, to: DataType, context: TypeContext): SqlValue {
  if (!isCastSupported(from, to)) throw unsupported(from, to);
  if (value === null) return null;
  return conformValue(convert(value, from, to, context), to);
}

/**
 * 암묵적 형변환으로 값을 대상 타입에 넣는다. INSERT, UPDATE 의 대입과 인자 전달이 쓴다.
 * 계열이 다르면 42804 이다.
 */
export function assignValue(value: SqlValue, from: DataType, to: DataType, context: TypeContext): SqlValue {
  if (!isImplicitlyConvertible(from, to)) {
    throw typeMismatch(`Cannot convert ${formatDataType(from)} to ${formatDataType(to)} implicitly; use CAST.`);
  }
  if (value === null) return null;
  return conformValue(convert(value, from, to, context), to);
}

const LITERAL_TYPE = varcharType();

/**
 * 타입이 정해지지 않은 문자열(문자열 리터럴, 문자열로 받은 `?` 파라미터)을 문맥이 요구하는 타입으로 해석한다.
 * 이진 타입은 16진 문자열로 읽는다. 그 밖에는 문자열에서의 CAST 와 같다.
 */
export function castLiteral(text: string | null, to: DataType, context: TypeContext): SqlValue {
  if (text === null) return null;
  if (to.kind === "BINARY" || to.kind === "VARBINARY") {
    return conformValue(parseHex(text), to);
  }
  return castValue(text, LITERAL_TYPE, to, context);
}
