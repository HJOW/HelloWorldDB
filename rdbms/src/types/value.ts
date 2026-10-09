/**
 * 값의 표현과 비교.
 *
 * 담당
 *  - 실행 중에 SQL 값을 담는 표현. NULL 포함
 *  - 값을 타입의 길이, 정밀도, 범위에 맞추기. 넘는 값은 잘라내지 않고 오류로 처리한다.
 *  - 비교 규칙 : 3값 논리, 문자열은 코드 포인트 순이며 대소문자 구분,
 *    CHAR 끼리는 뒤쪽 공백 무시
 *  - 정렬 규칙 : NULL 을 가장 큰 값으로 취급. NULLS FIRST, NULLS LAST 로 바꿀 수 있다.
 *  - 값을 문자열로 적기 (CAST 와 화면 출력이 함께 쓴다)
 *
 * 값은 타입 꼬리표 없이 다음의 JavaScript 값으로 담는다. 타입 정의(DataType)는 따로 다닌다.
 *
 *   NULL                            null
 *   CHAR, VARCHAR                   string
 *   BINARY, VARBINARY               Buffer
 *   SMALLINT, INTEGER, BIGINT       bigint
 *   DECIMAL                         Decimal
 *   REAL, DOUBLE PRECISION          number
 *   BOOLEAN                         boolean
 *   DATE, TIME, TIMESTAMP, INTERVAL DateValue, TimeValue, TimestampValue, IntervalValue
 *
 * 관련 사양 : AGENTS.md 상세 1-1, 1-2
 * 구현 단계 : 3단계
 */

import { internalError } from "../common/errors.js";
import type { DataType } from "./dataType.js";
import {
  conformDate,
  conformInterval,
  conformTime,
  conformTimestamp,
  DateValue,
  formatDate,
  formatInterval,
  formatTime,
  formatTimestamp,
  IntervalValue,
  TimestampValue,
  TimeValue,
} from "./datetime.js";
import { invalidCastValue, invalidCharacterEncoding, numericOutOfRange, quoteForMessage, stringTooLong } from "./errors.js";
import { Decimal, fitDecimal } from "./numeric.js";

/** NULL 이 아닌 SQL 값. */
export type NonNullValue =
  | string
  | Buffer
  | bigint
  | Decimal
  | number
  | boolean
  | DateValue
  | TimeValue
  | TimestampValue
  | IntervalValue;

/** SQL 값. null 은 SQL 의 NULL 이다. */
export type SqlValue = NonNullValue | null;

/** 3값 논리의 진리값. null 은 UNKNOWN 이다. */
export type Tri = boolean | null;

// ---------------------------------------------------------------------------
// 3값 논리
// ---------------------------------------------------------------------------

export function triAnd(left: Tri, right: Tri): Tri {
  if (left === false || right === false) return false;
  return left === null || right === null ? null : true;
}

export function triOr(left: Tri, right: Tri): Tri {
  if (left === true || right === true) return true;
  return left === null || right === null ? null : false;
}

export function triNot(value: Tri): Tri {
  return value === null ? null : !value;
}

// ---------------------------------------------------------------------------
// 문자열과 바이트열
// ---------------------------------------------------------------------------

const SURROGATE_REGEX = /[\uD800-\uDFFF]/;

/** 짝이 맞지 않는 서러게이트가 없는지 확인한다. 그런 문자열은 UTF-8 로 옮길 수 없다. */
export function isWellFormedString(text: string): boolean {
  if (!SURROGATE_REGEX.test(text)) return true;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** 짝이 맞지 않는 서러게이트가 있으면 22021 이다. */
export function assertWellFormedString(text: string): void {
  if (!isWellFormedString(text)) {
    throw invalidCharacterEncoding("Character string contains an unpaired surrogate.");
  }
}

/** 유니코드 코드 포인트 수. 문자 타입의 길이 단위이다. */
export function codePointLength(text: string): number {
  if (!SURROGATE_REGEX.test(text)) return text.length;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) i++;
    count++;
  }
  return count;
}

/** 앞에서부터 코드 포인트 count 개만 남긴다. */
export function sliceCodePoints(text: string, count: number): string {
  if (!SURROGATE_REGEX.test(text)) return text.slice(0, count);
  let index = 0;
  for (let taken = 0; taken < count && index < text.length; taken++) {
    const unit = text.charCodeAt(index);
    index += unit >= 0xd800 && unit <= 0xdbff ? 2 : 1;
  }
  return text.slice(0, index);
}

/** 뒤쪽 공백(U+0020)을 뗀다. */
export function trimTrailingSpaces(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x20) end--;
  return end === text.length ? text : text.slice(0, end);
}

/**
 * 코드 포인트 순 비교. UTF-8 바이트열을 그대로 비교한 순서와 같다.
 * (JavaScript 의 문자열 비교는 UTF-16 단위라서 보충 평면 문자의 순서가 다르다)
 */
export function compareCodePoints(left: string, right: string): -1 | 0 | 1 {
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    let a = left.charCodeAt(i);
    let b = right.charCodeAt(i);
    if (a !== b) {
      // 서러게이트(보충 평면)는 U+E000 ~ U+FFFF 보다 뒤에 오도록 순서를 바로잡는다.
      if (a >= 0xd800 && b >= 0xd800) {
        a = a >= 0xe000 ? a - 0x800 : a + 0x2000;
        b = b >= 0xe000 ? b - 0x800 : b + 0x2000;
      }
      return a < b ? -1 : 1;
    }
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

/** 바이트열을 대문자 16진 문자열로 적는다. */
export function formatHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex").toUpperCase();
}

/** 16진 문자열을 바이트열로 바꾼다. 자릿수가 홀수이거나 16진 숫자가 아니면 22018 이다. */
export function parseHex(text: string): Buffer {
  const trimmed = text.trim();
  if (trimmed.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(trimmed)) {
    throw invalidCastValue(`Invalid hexadecimal value: ${quoteForMessage(text)}.`);
  }
  return Buffer.from(trimmed, "hex");
}

// ---------------------------------------------------------------------------
// 값을 타입에 맞추기
// ---------------------------------------------------------------------------

const INTEGER_LIMITS: Record<16 | 32 | 64, { min: bigint; max: bigint }> = {
  16: { min: -(2n ** 15n), max: 2n ** 15n - 1n },
  32: { min: -(2n ** 31n), max: 2n ** 31n - 1n },
  64: { min: -(2n ** 63n), max: 2n ** 63n - 1n },
};

function mismatch(value: NonNullValue, type: DataType): Error {
  return internalError(`Value of JavaScript type ${describeValue(value)} does not match SQL type ${type.name}.`);
}

function describeValue(value: NonNullValue): string {
  if (Buffer.isBuffer(value)) return "Buffer";
  return typeof value === "object" ? value.constructor.name : typeof value;
}

/**
 * 길이를 넘는 문자열을 처리한다. 넘는 부분이 모두 공백이면 그 공백만 떼고, 아니면 22001 이다.
 */
function fitCharacterLength(text: string, type: { name: string; length: number }): string {
  const length = codePointLength(text);
  if (length <= type.length) return text;
  const kept = sliceCodePoints(text, type.length);
  if (trimTrailingSpaces(text).length > kept.length) {
    throw stringTooLong(`Value too long for ${type.name}(${type.length}): ${length} characters.`);
  }
  return kept;
}

/**
 * 값을 타입의 제약에 맞춘다. 값은 이미 그 타입의 표현이어야 한다. (계열이 다르면 먼저 형변환한다)
 *  - CHAR 는 공백으로, BINARY 는 0x00 으로 길이를 채운다.
 *  - 길이나 범위를 넘으면 오류이다. NUMERIC 의 소수부와 소수 초만 지정 자릿수로 반올림한다.
 */
export function conformValue(value: SqlValue, type: DataType): SqlValue {
  if (value === null) return null;
  switch (type.kind) {
    case "CHAR": {
      if (typeof value !== "string") throw mismatch(value, type);
      assertWellFormedString(value);
      const fitted = fitCharacterLength(value, type);
      const length = codePointLength(fitted);
      return length < type.length ? fitted + " ".repeat(type.length - length) : fitted;
    }
    case "VARCHAR": {
      if (typeof value !== "string") throw mismatch(value, type);
      assertWellFormedString(value);
      return fitCharacterLength(value, type);
    }
    case "BINARY": {
      if (!Buffer.isBuffer(value)) throw mismatch(value, type);
      if (value.length > type.length) {
        throw stringTooLong(`Value too long for BINARY(${type.length}): ${value.length} bytes.`);
      }
      if (value.length === type.length) return value;
      const padded = Buffer.alloc(type.length);
      value.copy(padded);
      return padded;
    }
    case "VARBINARY": {
      if (!Buffer.isBuffer(value)) throw mismatch(value, type);
      if (value.length > type.length) {
        throw stringTooLong(`Value too long for VARBINARY(${type.length}): ${value.length} bytes.`);
      }
      return value;
    }
    case "INTEGER": {
      if (typeof value !== "bigint") throw mismatch(value, type);
      const limits = INTEGER_LIMITS[type.bits];
      if (value < limits.min || value > limits.max) {
        throw numericOutOfRange(`Value out of range for ${type.name}.`);
      }
      return value;
    }
    case "DECIMAL": {
      if (!(value instanceof Decimal)) throw mismatch(value, type);
      return fitDecimal(value, type.precision, type.scale);
    }
    case "FLOAT": {
      if (typeof value !== "number") throw mismatch(value, type);
      if (!Number.isFinite(value)) {
        throw numericOutOfRange(`Value out of range for ${type.name}.`);
      }
      const stored = type.bits === 32 ? Math.fround(value) : value;
      if (!Number.isFinite(stored)) {
        throw numericOutOfRange(`Value out of range for ${type.name}.`);
      }
      // 음의 0 은 0 으로 통일한다.
      return stored === 0 ? 0 : stored;
    }
    case "BOOLEAN": {
      if (typeof value !== "boolean") throw mismatch(value, type);
      return value;
    }
    case "DATE": {
      if (!(value instanceof DateValue)) throw mismatch(value, type);
      return conformDate(value);
    }
    case "TIME": {
      if (!(value instanceof TimeValue)) throw mismatch(value, type);
      return conformTime(value, type.fractionalPrecision, type.withTimeZone);
    }
    case "TIMESTAMP": {
      if (!(value instanceof TimestampValue)) throw mismatch(value, type);
      return conformTimestamp(value, type.fractionalPrecision, type.withTimeZone);
    }
    case "INTERVAL": {
      if (!(value instanceof IntervalValue)) throw mismatch(value, type);
      return conformInterval(value, type);
    }
  }
}

// ---------------------------------------------------------------------------
// 비교
// ---------------------------------------------------------------------------

export interface CompareOptions {
  /** 두 값이 모두 CHAR 일 때 true 로 준다. 뒤쪽 공백을 떼고 비교한다. */
  ignoreTrailingSpaces?: boolean;
}

export interface SortOptions extends CompareOptions {
  descending?: boolean;
  /** 생략하면 NULL 을 가장 큰 값으로 본다. (ASC 에서 마지막, DESC 에서 처음) */
  nulls?: "FIRST" | "LAST";
}

function isNumeric(value: NonNullValue): value is bigint | Decimal | number {
  return typeof value === "bigint" || typeof value === "number" || value instanceof Decimal;
}

function order(left: number | bigint, right: number | bigint): -1 | 0 | 1 {
  return left === right ? 0 : left < right ? -1 : 1;
}

/** 수 계열 값의 비교. 부동소수가 섞이면 부동소수로, 아니면 10진수로 정확히 비교한다. */
function compareNumeric(left: bigint | Decimal | number, right: bigint | Decimal | number): -1 | 0 | 1 {
  if (typeof left === "bigint" && typeof right === "bigint") {
    return order(left, right);
  }
  if (typeof left === "number" || typeof right === "number") {
    const a = typeof left === "number" ? left : left instanceof Decimal ? left.toNumber() : Number(left);
    const b = typeof right === "number" ? right : right instanceof Decimal ? right.toNumber() : Number(right);
    return order(a, b);
  }
  const a = left instanceof Decimal ? left : Decimal.fromBigInt(left);
  const b = right instanceof Decimal ? right : Decimal.fromBigInt(right);
  return a.compare(b);
}

/**
 * NULL 이 아닌 두 값을 비교한다. 같은 계열의 값이어야 한다. (계열이 다르면 먼저 형변환한다)
 * 수 계열은 정수, 10진수, 부동소수를 섞어 비교할 수 있다.
 */
export function compareValues(left: NonNullValue, right: NonNullValue, options: CompareOptions = {}): -1 | 0 | 1 {
  if (typeof left === "string" && typeof right === "string") {
    return options.ignoreTrailingSpaces === true
      ? compareCodePoints(trimTrailingSpaces(left), trimTrailingSpaces(right))
      : compareCodePoints(left, right);
  }
  if (isNumeric(left) && isNumeric(right)) {
    return compareNumeric(left, right);
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return left === right ? 0 : left ? 1 : -1;
  }
  if (Buffer.isBuffer(left) && Buffer.isBuffer(right)) {
    return Buffer.compare(left, right);
  }
  if (left instanceof DateValue && right instanceof DateValue) {
    return order(left.days, right.days);
  }
  if (left instanceof TimestampValue && right instanceof TimestampValue) {
    if ((left.offsetMinutes === null) === (right.offsetMinutes === null)) {
      return order(left.micros, right.micros);
    }
  } else if (left instanceof TimeValue && right instanceof TimeValue) {
    if ((left.offsetMinutes === null) === (right.offsetMinutes === null)) {
      return order(left.micros, right.micros);
    }
  } else if (left instanceof IntervalValue && right instanceof IntervalValue) {
    if (left.intervalClass === right.intervalClass) {
      return left.intervalClass === "YEAR_MONTH" ? order(left.months, right.months) : order(left.micros, right.micros);
    }
  }
  throw internalError(`Values of ${describeValue(left)} and ${describeValue(right)} cannot be compared.`);
}

/** 3값 논리의 비교. 한쪽이라도 NULL 이면 null(UNKNOWN) 이다. */
export function compareNullable(left: SqlValue, right: SqlValue, options: CompareOptions = {}): -1 | 0 | 1 | null {
  return left === null || right === null ? null : compareValues(left, right, options);
}

/** 정렬용 비교. NULL 끼리는 같다고 본다. */
export function compareForSort(left: SqlValue, right: SqlValue, options: SortOptions = {}): number {
  const descending = options.descending === true;
  if (left === null || right === null) {
    if (left === null && right === null) return 0;
    const nullsFirst = options.nulls === undefined ? descending : options.nulls === "FIRST";
    return (left === null) === nullsFirst ? -1 : 1;
  }
  const result = compareValues(left, right, options);
  return descending ? -result : result;
}

/** 두 값이 구별되지 않는지 본다. NULL 끼리는 같다. (GROUP BY, DISTINCT, 집합 연산의 규칙) */
export function isNotDistinct(left: SqlValue, right: SqlValue, options: CompareOptions = {}): boolean {
  return compareForSort(left, right, options) === 0;
}

// ---------------------------------------------------------------------------
// 문자열로 적기
// ---------------------------------------------------------------------------

/** 단정도 값을 다시 읽었을 때 같은 단정도 값이 되는 가장 짧은 표기로 적는다. */
function formatReal(value: number): string {
  for (let digits = 1; digits <= 9; digits++) {
    const candidate = Number(value.toPrecision(digits));
    if (Math.fround(candidate) === value) {
      return candidate.toString();
    }
  }
  return value.toString();
}

/**
 * NULL 이 아닌 값을 그 타입의 표준 문자열 표기로 적는다.
 * `CAST(값 AS VARCHAR)` 와 화면 출력이 이 표기를 쓴다.
 */
export function formatValue(value: NonNullValue, type: DataType): string {
  switch (type.kind) {
    case "CHAR":
    case "VARCHAR":
      if (typeof value === "string") return value;
      break;
    case "BINARY":
    case "VARBINARY":
      if (Buffer.isBuffer(value)) return formatHex(value);
      break;
    case "INTEGER":
      if (typeof value === "bigint") return value.toString();
      break;
    case "DECIMAL":
      if (value instanceof Decimal) return value.toString();
      break;
    case "FLOAT":
      if (typeof value === "number") return type.bits === 32 ? formatReal(value) : value.toString();
      break;
    case "BOOLEAN":
      if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
      break;
    case "DATE":
      if (value instanceof DateValue) return formatDate(value.days);
      break;
    case "TIME":
      if (value instanceof TimeValue) return formatTime(value, type.fractionalPrecision);
      break;
    case "TIMESTAMP":
      if (value instanceof TimestampValue) return formatTimestamp(value, type.fractionalPrecision);
      break;
    case "INTERVAL":
      if (value instanceof IntervalValue) return formatInterval(value, type);
      break;
  }
  throw mismatch(value, type);
}
