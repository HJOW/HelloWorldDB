/**
 * 내장 함수.
 *
 * 담당
 *  - 집계 함수 : COUNT, SUM, AVG, MIN, MAX (DISTINCT 포함)
 *  - ANSI 함수 : UPPER, LOWER, TRIM, SUBSTRING, POSITION, CHAR_LENGTH, EXTRACT, COALESCE, NULLIF,
 *    CURRENT_DATE, CURRENT_TIMESTAMP, CURRENT_USER 등
 *  - 표준은 아니지만 널리 쓰이는 함수 : LENGTH, SUBSTR, REPLACE, LTRIM, RTRIM, CONCAT, ROUND
 *  - Oracle 호환 함수 : NVL, TO_CHAR, TO_DATE
 *    날짜 형식 요소(YYYY, MM, DD, HH24, MI, SS, FF1~FF6 등)와 숫자 형식 요소(9, 0, ., ,, FM)의 해석 포함.
 *    형식을 생략하면 ISO 8601 형태를 쓴다. TO_DATE 는 TIMESTAMP(0) 을 돌려준다.
 *  - 함수 이름으로 구현을 찾는 등록부, 인자의 개수와 타입 검사
 *
 * 관련 사양 : AGENTS.md 상세 1-5
 * 구현 단계 : 6단계
 */

import { DbError, ERROR_CODES } from "../common/errors.js";
import type {
  DataType,
  DecimalDataType,
  IntegerDataType,
  IntervalDataType,
} from "../types/dataType.js";
import {
  BIGINT_TYPE,
  BOOLEAN_TYPE,
  DATE_TYPE,
  DOUBLE_TYPE,
  INTEGER_TYPE,
  REAL_TYPE,
  SMALLINT_TYPE,
  charType,
  decimalType,
  formatDataType,
  integerType,
  intervalType,
  timeType,
  timestampType,
  varcharType,
} from "../types/dataType.js";
import type { TypeContext } from "../types/cast.js";
import { castLiteral, castValue, commonType, isCastSupported } from "../types/cast.js";
import { bindConcat } from "../types/arithmetic.js";
import {
  MICROS_PER_DAY,
  MICROS_PER_MINUTE,
  DateValue,
  IntervalValue,
  TimestampValue,
  TimeValue,
  civilFromDays,
  conformTimestamp,
  daysFromFields,
  formatDate,
  formatTimeOfDay,
  parseTimestampText,
  parseTimeText,
  splitLocalMicros,
  splitTimeOfDay,
  timeOfDayFromFields,
} from "../types/datetime.js";
import { Decimal } from "../types/numeric.js";
import { fitDecimal } from "../types/numeric.js";
import {
  castNotSupported,
  divisionByZero,
  invalidCastValue,
  invalidDatetimeFormat,
  numericOutOfRange,
  quoteForMessage,
  typeMismatch,
} from "../types/errors.js";
import {
  codePointLength,
  compareCodePoints,
  compareValues,
  conformValue,
  formatHex,
  formatValue,
  isNotDistinct,
  parseHex,
  sliceCodePoints,
  trimTrailingSpaces,
} from "../types/value.js";
import type { NonNullValue, SqlValue } from "../types/value.js";

/** 집계 함수의 이름이다. 파서가 이름을 대문자로 정규화하므로 대문자로 비교한다. */
export const AGGREGATE_NAMES: ReadonlySet<string> = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX"]);

/** 집계 함수인지 본다. */
export function isAggregateFunction(name: string): boolean {
  return AGGREGATE_NAMES.has(name.toUpperCase());
}

/** 스칼라 함수에 넘기는 세션 정보이다. */
export interface FunctionContext {
  readonly typeCtx: TypeContext;
  readonly currentUser: string;
}

/** 값과 타입을 함께 다룬다. */
export interface TypedValue {
  value: SqlValue;
  type: DataType;
}

function failFunction(message: string): never {
  throw new DbError("42883", ERROR_CODES.INVALID_FUNCTION_ARGUMENT, message);
}

function failArgumentCount(name: string, expected: string, got: number): never {
  failFunction(`Function ${name} expects ${expected}, but got ${got} argument(s).`);
}

function requireArgCount(name: string, args: TypedValue[], min: number, max: number): void {
  if (args.length < min || args.length > max) {
    const expected = min === max ? `${min}` : `${min} to ${max}`;
    failArgumentCount(name, expected, args.length);
  }
}

/** NULL 이 하나라도 있으면 NULL 이다. */
function allNotNull(args: TypedValue[]): boolean {
  return args.every((arg) => arg.value !== null);
}

function asString(value: NonNullValue, name: string): string {
  if (typeof value !== "string") {
    throw typeMismatch(`Function ${name} expects a character value.`);
  }
  return value;
}

function asBigIntValue(value: NonNullValue, name: string): bigint {
  if (typeof value === "bigint") return value;
  if (value instanceof Decimal) return value.toBigInt();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw numericOutOfRange(`Value out of range for function ${name}.`);
    return BigInt(value < 0 ? -Math.round(-value) : Math.round(value));
  }
  throw typeMismatch(`Function ${name} expects a numeric value.`);
}

function isNumericValue(value: NonNullValue): boolean {
  return typeof value === "bigint" || typeof value === "number" || value instanceof Decimal;
}

function numericKind(type: DataType): "INTEGER" | "DECIMAL" | "FLOAT" | null {
  if (type.kind === "INTEGER") return "INTEGER";
  if (type.kind === "DECIMAL") return "DECIMAL";
  if (type.kind === "FLOAT") return "FLOAT";
  return null;
}

// ---------------------------------------------------------------------------
// 문자열 자르기
// ---------------------------------------------------------------------------

/** TRIM/LTRIM/RTRIM 에서 자를 문자 집합을 구한다. 생략하면 공백 하나이다. */
function trimSet(chars: TypedValue | null, typeCtx: TypeContext): string {
  if (chars === null || chars.value === null) return " ";
  const text = stringOf(chars, typeCtx);
  if (codePointLength(text) === 0) {
    throw new DbError("22023", ERROR_CODES.TYPE_PARAMETER_INVALID, "Trim character must not be empty.");
  }
  return text;
}

/** 문자열 값을 요구하고, 문자열이 아니면 같은 계열 안에서만 바꾼다. */
function stringOf(arg: TypedValue, typeCtx: TypeContext): string {
  if (arg.value === null) throw typeMismatch("NULL value has no string form.");
  if (typeof arg.value === "string") return arg.value;
  throw typeMismatch(`Cannot convert ${formatDataType(arg.type)} to a character value implicitly; use CAST.`);
}

/** 앞뒤 공백 문자 집합을 자른다. */
export function trimBoth(text: string, chars: string, leading: boolean, trailing: boolean): string {
  const set = new Set(Array.from(chars));
  let points = Array.from(text);
  if (leading) {
    let start = 0;
    while (start < points.length && set.has(points[start] as string)) start++;
    points = points.slice(start);
  }
  if (trailing) {
    let end = points.length;
    while (end > 0 && set.has(points[end - 1] as string)) end--;
    points = points.slice(0, end);
  }
  return points.join("");
}

/** SUBSTRING/SUBSTR 의 시작과 길이를 정수로 바꾼다. */
function integerArg(arg: TypedValue, name: string, typeCtx: TypeContext): bigint {
  if (arg.value === null) throw typeMismatch(`Function ${name} got NULL for an integer argument.`);
  const value = arg.value;
  if (typeof value === "bigint") return value;
  if (value instanceof Decimal) return value.toBigInt();
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new DbError("22023", ERROR_CODES.TYPE_PARAMETER_INVALID, `Function ${name} expects an integer argument.`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^[+-]?\d+$/.test(text)) {
      throw new DbError("22023", ERROR_CODES.TYPE_PARAMETER_INVALID, `Function ${name} expects an integer argument.`);
    }
    return BigInt(text);
  }
  throw typeMismatch(`Function ${name} expects an integer argument.`);
}

/** SUBSTRING/SUBSTR 본체. 시작은 1부터이며 음수는 뒤에서 센다. */
export function substringValue(text: string, start: bigint, length: bigint | null, name: string): string {
  const points = Array.from(text);
  const size = BigInt(points.length);
  let from: bigint;
  if (start > 0n) {
    from = start - 1n;
  } else if (start === 0n) {
    from = 0n;
  } else {
    from = size + start;
    if (from < 0n) from = 0n;
  }
  if (from > size) return "";
  if (length === null) {
    return points.slice(Number(from)).join("");
  }
  if (length < 0n) {
    throw new DbError("22023", ERROR_CODES.TYPE_PARAMETER_INVALID, `Function ${name} expects a non-negative length.`);
  }
  return points.slice(Number(from), Number(from + length)).join("");
}

// ---------------------------------------------------------------------------
// LIKE
// ---------------------------------------------------------------------------

/** LIKE 패턴을 코드 포인트 단위로 견준다. */
export function likeMatch(value: string, pattern: string, escape: string | null): boolean {
  const text = Array.from(value);
  const pat = Array.from(pattern);
  let escapeChar: string | null = null;
  if (escape !== null) {
    const points = Array.from(escape);
    if (points.length !== 1) {
      throw new DbError("22023", ERROR_CODES.TYPE_PARAMETER_INVALID, "LIKE escape must be a single character.");
    }
    escapeChar = points[0] as string;
  }
  // 토큰화 : % , _ , 문자
  type Token = { kind: "%" | "_" | "CHAR"; char?: string };
  const tokens: Token[] = [];
  for (let i = 0; i < pat.length; i++) {
    const char = pat[i] as string;
    if (escapeChar !== null && char === escapeChar) {
      i++;
      if (i >= pat.length) {
        throw invalidCastValue("LIKE pattern ends with an escape character.");
      }
      tokens.push({ kind: "CHAR", char: pat[i] as string });
      continue;
    }
    if (char === "%") tokens.push({ kind: "%" });
    else if (char === "_") tokens.push({ kind: "_" });
    else tokens.push({ kind: "CHAR", char });
  }
  // 고전적인 와일드카드 매칭 (백트래킹)
  let textIndex = 0;
  let tokenIndex = 0;
  let star = -1;
  let mark = 0;
  while (textIndex < text.length) {
    const token = tokenIndex < tokens.length ? tokens[tokenIndex] : undefined;
    if (token !== undefined && (token.kind === "_" || (token.kind === "CHAR" && token.char === text[textIndex]))) {
      textIndex++;
      tokenIndex++;
    } else if (token !== undefined && token.kind === "%") {
      star = tokenIndex;
      mark = textIndex;
      tokenIndex++;
    } else if (star !== -1) {
      mark++;
      textIndex = mark;
      tokenIndex = star + 1;
    } else {
      return false;
    }
  }
  while (tokenIndex < tokens.length && tokens[tokenIndex]?.kind === "%") tokenIndex++;
  return tokenIndex === tokens.length;
}

// ---------------------------------------------------------------------------
// 날짜/숫자 형식 (TO_CHAR, TO_DATE)
// ---------------------------------------------------------------------------

type DateToken =
  | { kind: "YEAR4" }
  | { kind: "YEAR2" }
  | { kind: "MONTH" }
  | { kind: "DAY" }
  | { kind: "HOUR24" }
  | { kind: "HOUR12" }
  | { kind: "MINUTE" }
  | { kind: "SECOND" }
  | { kind: "FRACTION"; digits: number }
  | { kind: "AMPM" }
  | { kind: "LITERAL"; text: string };

/** 날짜 형식을 토큰으로 나눈다. 큰따옴표 안은 고정 문자열이다. */
function tokenizeDateFormat(format: string): DateToken[] {
  const tokens: DateToken[] = [];
  const upper = format.toUpperCase();
  let i = 0;
  const pushLiteral = (text: string): void => {
    const last = tokens[tokens.length - 1];
    if (last !== undefined && last.kind === "LITERAL") last.text += text;
    else tokens.push({ kind: "LITERAL", text });
  };
  while (i < format.length) {
    const char = format[i] as string;
    if (char === '"') {
      const close = format.indexOf('"', i + 1);
      if (close < 0) throw invalidDatetimeFormat(`Invalid date format: ${quoteForMessage(format)}.`);
      pushLiteral(format.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    const rest = upper.slice(i);
    if (rest.startsWith("YYYY")) {
      tokens.push({ kind: "YEAR4" });
      i += 4;
    } else if (rest.startsWith("YY")) {
      tokens.push({ kind: "YEAR2" });
      i += 2;
    } else if (rest.startsWith("MM")) {
      tokens.push({ kind: "MONTH" });
      i += 2;
    } else if (rest.startsWith("DD")) {
      tokens.push({ kind: "DAY" });
      i += 2;
    } else if (rest.startsWith("HH24")) {
      tokens.push({ kind: "HOUR24" });
      i += 4;
    } else if (rest.startsWith("HH12") || rest.startsWith("HH")) {
      tokens.push({ kind: "HOUR12" });
      i += rest.startsWith("HH12") ? 4 : 2;
    } else if (rest.startsWith("MI")) {
      tokens.push({ kind: "MINUTE" });
      i += 2;
    } else if (rest.startsWith("SS")) {
      tokens.push({ kind: "SECOND" });
      i += 2;
    } else if (/^FF[1-6]/.test(rest)) {
      tokens.push({ kind: "FRACTION", digits: Number(rest[2]) });
      i += 3;
    } else if (rest.startsWith("AM") || rest.startsWith("PM")) {
      tokens.push({ kind: "AMPM" });
      i += 2;
    } else {
      pushLiteral(char);
      i += 1;
    }
  }
  return tokens;
}

interface WallFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  microsecond: number;
}

/** 값에서 벽시계 필드를 꺼낸다. DATE 는 자정으로 본다. */
function wallFieldsOf(value: NonNullValue, type: DataType): WallFields {
  if (value instanceof DateValue) {
    const civil = civilFromDays(value.days);
    return { year: civil.year, month: civil.month, day: civil.day, hour: 0, minute: 0, second: 0, microsecond: 0 };
  }
  if (value instanceof TimeValue) {
    const fields = splitTimeOfDay(value.localMicros);
    return { year: 1970, month: 1, day: 1, hour: fields.hour, minute: fields.minute, second: fields.second, microsecond: fields.microsecond };
  }
  if (value instanceof TimestampValue) {
    const split = splitLocalMicros(value.localMicros);
    const civil = civilFromDays(split.days);
    const fields = splitTimeOfDay(split.microsOfDay);
    return { year: civil.year, month: civil.month, day: civil.day, hour: fields.hour, minute: fields.minute, second: fields.second, microsecond: fields.microsecond };
  }
  throw typeMismatch(`TO_CHAR expects a datetime or numeric value, but got ${formatDataType(type)}.`);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function pad4(value: number): string {
  return String(value).padStart(4, "0");
}

/** 날짜시간 값을 형식에 맞추어 적는다. */
function formatDatetime(value: NonNullValue, type: DataType, format: string): string {
  const fields = wallFieldsOf(value, type);
  const tokens = tokenizeDateFormat(format);
  let out = "";
  for (const token of tokens) {
    switch (token.kind) {
      case "YEAR4":
        out += pad4(fields.year);
        break;
      case "YEAR2":
        out += pad2(fields.year % 100);
        break;
      case "MONTH":
        out += pad2(fields.month);
        break;
      case "DAY":
        out += pad2(fields.day);
        break;
      case "HOUR24":
        out += pad2(fields.hour);
        break;
      case "HOUR12": {
        const hour12 = fields.hour % 12 === 0 ? 12 : fields.hour % 12;
        out += pad2(hour12);
        break;
      }
      case "MINUTE":
        out += pad2(fields.minute);
        break;
      case "SECOND":
        out += pad2(fields.second);
        break;
      case "FRACTION":
        out += String(fields.microsecond).padStart(6, "0").slice(0, token.digits);
        break;
      case "AMPM":
        out += fields.hour < 12 ? "AM" : "PM";
        break;
      case "LITERAL":
        out += token.text;
        break;
    }
  }
  return out;
}

/** ISO 8601 기본 표기로 적는다. */
function formatDatetimeIso(value: NonNullValue, type: DataType): string {
  if (value instanceof DateValue) return formatDate(value.days);
  if (value instanceof TimeValue) {
    const precision = type.kind === "TIME" ? type.fractionalPrecision : 0;
    const text = formatTimeOfDay(value.localMicros, precision);
    return value.offsetMinutes === null ? text : `${text}${formatOffset(value.offsetMinutes)}`;
  }
  if (value instanceof TimestampValue) {
    const precision = type.kind === "TIMESTAMP" ? type.fractionalPrecision : 6;
    const split = splitLocalMicros(value.localMicros);
    const civil = civilFromDays(split.days);
    const text = `${formatDateFromCivil(civil.year, civil.month, civil.day)} ${formatTimeOfDay(split.microsOfDay, precision)}`;
    return value.offsetMinutes === null ? text : `${text}${formatOffset(value.offsetMinutes)}`;
  }
  throw typeMismatch(`TO_CHAR expects a datetime value, but got ${formatDataType(type)}.`);
}

function formatDateFromCivil(year: number, month: number, day: number): string {
  return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
}

function formatOffset(offsetMinutes: number): string {
  const absolute = Math.abs(offsetMinutes);
  const sign = offsetMinutes < 0 ? "-" : "+";
  return `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
}

/** 숫자 형식을 해석한다. FM 접두만 받는다. */
interface NumberFormat {
  fillMode: boolean;
  intSlots: number;
  fracSlots: number;
  grouping: boolean;
  width: number;
  hasPoint: boolean;
}

function parseNumberFormat(format: string): NumberFormat {
  let rest = format;
  let fillMode = false;
  if (/^FM/i.test(rest)) {
    fillMode = true;
    rest = rest.slice(2);
  }
  if (rest.length === 0 || !/^[90.,]+$/.test(rest)) {
    throw invalidCastValue(`Invalid number format: ${quoteForMessage(format)}.`);
  }
  const points = (rest.match(/\./g) ?? []).length;
  if (points > 1) throw invalidCastValue(`Invalid number format: ${quoteForMessage(format)}.`);
  const [intPart = "", fracPart = ""] = rest.split(".");
  const hasPoint = rest.includes(".");
  const intSlots = intPart.replace(/,/g, "").length;
  const fracSlots = hasPoint ? fracPart.length : 0;
  if (intSlots === 0 && fracSlots === 0) {
    throw invalidCastValue(`Invalid number format: ${quoteForMessage(format)}.`);
  }
  return { fillMode, intSlots, fracSlots, grouping: rest.includes(","), width: rest.length, hasPoint };
}

/** 숫자를 Decimal 로 바꾼다. */
function decimalOf(value: NonNullValue): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value === "bigint") return Decimal.fromBigInt(value);
  if (typeof value === "number") return Decimal.fromNumber(value);
  throw typeMismatch("TO_CHAR expects a numeric value.");
}

/** 숫자 값을 형식에 맞추어 적는다. */
function formatNumber(value: NonNullValue, format: string): string {
  const parsed = parseNumberFormat(format);
  const decimal = decimalOf(value);
  const rounded = decimal.round(parsed.fracSlots);
  const negative = rounded.sign() < 0;
  const digits = rounded.abs().toString().split(".");
  const intDigits = digits[0] ?? "0";
  const fracDigits = digits[1] ?? "";
  const intCount = intDigits.replace(/^0+(?=\d)/, "").length === 0 ? 1 : intDigits.replace(/^0+(?=\d)/, "").length;
  void intCount;
  const significant = intDigits.replace(/^0+(?=\d)/, "") || "0";
  if (significant.length > parsed.intSlots) {
    return "#".repeat(parsed.width);
  }
  // 정수부를 채운다. 0이 있으면 0으로, 아니면 공백으로 채운다 (FM이면 채우지 않는다).
  const intFormat = format.replace(/^FM/i, "").split(".")[0] ?? "";
  const zeroPad = intFormat.includes("0");
  let intText = significant;
  if (!parsed.fillMode && intText.length < parsed.intSlots) {
    intText = (zeroPad ? "0" : " ").repeat(parsed.intSlots - intText.length) + intText;
  }
  if (parsed.grouping) {
    // 앞에 채운 공백은 그대로 두고 숫자 부분에만 쉼표를 넣는다.
    const padding = intText.match(/^ */)?.[0] ?? "";
    const core = intText.slice(padding.length);
    const grouped = core.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    intText = padding + grouped;
  }
  const fracText = parsed.fracSlots > 0 ? (fracDigits + "0".repeat(parsed.fracSlots)).slice(0, parsed.fracSlots) : "";
  const sign = negative ? "-" : parsed.fillMode ? "" : " ";
  const point = parsed.hasPoint && parsed.fracSlots === 0 ? "." : parsed.fracSlots > 0 ? "." : "";
  // FM이 아니면 너비에 맞추어 앞에 공백을 둔다. (이미 정수부에서 채웠으므로 길이가 모자랄 때만)
  let out = `${sign}${intText}${point}${fracText}`;
  if (!parsed.fillMode && out.length < parsed.width + 1) {
    out = " ".repeat(parsed.width + 1 - out.length) + out;
  }
  return out;
}

/** TO_CHAR 의 숫자 기본 표기이다. */
function formatNumberIso(value: NonNullValue, type: DataType): string {
  return formatValue(value, type);
}

/** 날짜 형식으로 문자열을 읽어 벽시계 필드로 바꾼다. */
function parseDatetimeWithFormat(text: string, format: string): WallFields {
  const tokens = tokenizeDateFormat(format);
  let at = 0;
  const fields: WallFields = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, microsecond: 0 };
  let hour12: number | null = null;
  let ampm: "AM" | "PM" | null = null;
  let hasDate = false;
  let hasTime = false;
  const readDigits = (count: number | null, what: string): string => {
    const rest = text.slice(at);
    const match = count === null ? /^(\d+)/.exec(rest) : new RegExp(`^(\\d{1,${count}})`).exec(rest);
    if (match === null) throw invalidDatetimeFormat(`Invalid date value: ${quoteForMessage(text)}.`);
    at += (match[1] as string).length;
    void what;
    return match[1] as string;
  };
  for (const token of tokens) {
    switch (token.kind) {
      case "YEAR4":
        fields.year = Number(readDigits(4, "year"));
        hasDate = true;
        break;
      case "YEAR2": {
        const year2 = Number(readDigits(2, "year"));
        fields.year = 2000 + year2;
        hasDate = true;
        break;
      }
      case "MONTH":
        fields.month = Number(readDigits(2, "month"));
        hasDate = true;
        break;
      case "DAY":
        fields.day = Number(readDigits(2, "day"));
        hasDate = true;
        break;
      case "HOUR24":
        fields.hour = Number(readDigits(2, "hour"));
        hasTime = true;
        break;
      case "HOUR12":
        hour12 = Number(readDigits(2, "hour"));
        hasTime = true;
        break;
      case "MINUTE":
        fields.minute = Number(readDigits(2, "minute"));
        hasTime = true;
        break;
      case "SECOND":
        fields.second = Number(readDigits(2, "second"));
        hasTime = true;
        break;
      case "FRACTION": {
        const digits = readDigits(9, "fraction");
        fields.microsecond = Number((digits + "000000").slice(0, 6));
        hasTime = true;
        break;
      }
      case "AMPM": {
        const rest = text.slice(at, at + 2).toUpperCase();
        if (rest !== "AM" && rest !== "PM") throw invalidDatetimeFormat(`Invalid date value: ${quoteForMessage(text)}.`);
        ampm = rest;
        at += 2;
        break;
      }
      case "LITERAL": {
        if (token.text === " ") {
          while (text[at] === " " || text[at] === "\t") at++;
        } else if (text.startsWith(token.text, at)) {
          at += token.text.length;
        } else {
          throw invalidDatetimeFormat(`Invalid date value: ${quoteForMessage(text)}.`);
        }
        break;
      }
    }
  }
  if (hour12 !== null) {
    if (hour12 < 1 || hour12 > 12) throw invalidDatetimeFormat(`Invalid date value: ${quoteForMessage(text)}.`);
    const base = hour12 % 12;
    fields.hour = ampm === "PM" ? base + 12 : base;
  } else if (ampm !== null) {
    if (fields.hour < 0 || fields.hour > 23) throw invalidDatetimeFormat(`Invalid date value: ${quoteForMessage(text)}.`);
    if (ampm === "PM" && fields.hour < 12) fields.hour += 12;
    if (ampm === "AM" && fields.hour === 12) fields.hour = 0;
  }
  const rest = text.slice(at).trim();
  if (rest.length > 0) throw invalidDatetimeFormat(`Invalid date value: ${quoteForMessage(text)}.`);
  void hasDate;
  void hasTime;
  return fields;
}

// ---------------------------------------------------------------------------
// 집계
// ---------------------------------------------------------------------------

/** 집계의 결과 타입을 정한다. */
export function aggregateResultType(name: string, argType: DataType | null, star: boolean): DataType {
  const upper = name.toUpperCase();
  switch (upper) {
    case "COUNT":
      return BIGINT_TYPE;
    case "SUM": {
      if (argType === null) throw typeMismatch("SUM needs an argument.");
      if (argType.kind === "INTEGER") return BIGINT_TYPE;
      if (argType.kind === "DECIMAL") return argType;
      if (argType.kind === "FLOAT") return DOUBLE_TYPE;
      throw typeMismatch(`SUM is not defined for ${formatDataType(argType)}.`);
    }
    case "AVG": {
      if (argType === null) throw typeMismatch("AVG needs an argument.");
      if (argType.kind === "FLOAT") return DOUBLE_TYPE;
      if (argType.kind === "INTEGER" || argType.kind === "DECIMAL") {
        return decimalType(38, 6);
      }
      throw typeMismatch(`AVG is not defined for ${formatDataType(argType)}.`);
    }
    case "MIN":
    case "MAX": {
      if (argType === null) throw typeMismatch(`${upper} needs an argument.`);
      return argType;
    }
    default:
      throw new DbError("42883", ERROR_CODES.UNDEFINED_FUNCTION, `Unknown aggregate function: "${name}".`);
  }
}

/** 집계 한 그룹을 계산한다. NULL은 세지 않는다. COUNT(*)는 호출자가 행 수를 넘긴다. */
export function aggregateGroup(
  name: string,
  values: SqlValue[],
  argType: DataType | null,
  star: boolean,
  rowCount: number,
): SqlValue {
  const upper = name.toUpperCase();
  if (upper === "COUNT") {
    if (star) return BigInt(rowCount);
    return BigInt(values.filter((value) => value !== null).length);
  }
  const present = values.filter((value) => value !== null);
  if (present.length === 0) return null;
  switch (upper) {
    case "SUM": {
      if (argType?.kind === "FLOAT") {
        let total = 0;
        for (const value of present) {
          if (typeof value !== "number") throw typeMismatch("SUM got an unexpected value.");
          total += value;
        }
        return conformValue(total, DOUBLE_TYPE);
      }
      if (argType?.kind === "DECIMAL") {
        let total = Decimal.ZERO;
        for (const value of present) {
          if (!(value instanceof Decimal)) throw typeMismatch("SUM got an unexpected value.");
          total = total.add(value);
        }
        return conformValue(total, argType);
      }
      let total = 0n;
      for (const value of present) {
        if (typeof value !== "bigint") throw typeMismatch("SUM got an unexpected value.");
        total += value;
      }
      return conformValue(total, BIGINT_TYPE);
    }
    case "AVG": {
      if (argType?.kind === "FLOAT") {
        let total = 0;
        for (const value of present) {
          if (typeof value !== "number") throw typeMismatch("AVG got an unexpected value.");
          total += value;
        }
        return conformValue(total / present.length, DOUBLE_TYPE);
      }
      let total = Decimal.ZERO;
      for (const value of present) {
        if (typeof value === "bigint") total = total.add(Decimal.fromBigInt(value));
        else if (value instanceof Decimal) total = total.add(value);
        else throw typeMismatch("AVG got an unexpected value.");
      }
      const average = total.divide(Decimal.fromBigInt(BigInt(present.length)), 6);
      return conformValue(average, decimalType(38, 6));
    }
    case "MIN":
    case "MAX": {
      if (argType === null) throw typeMismatch(`${upper} needs an argument.`);
      const bothChar = argType.kind === "CHAR";
      let best = present[0] as NonNullValue;
      for (const value of present.slice(1)) {
        const order = compareValues(best, value as NonNullValue, { ignoreTrailingSpaces: bothChar });
        if (upper === "MIN" ? order > 0 : order < 0) best = value as NonNullValue;
      }
      return best;
    }
    default:
      throw new DbError("42883", ERROR_CODES.UNDEFINED_FUNCTION, `Unknown aggregate function: "${name}".`);
  }
}

// ---------------------------------------------------------------------------
// 스칼라 함수
// ---------------------------------------------------------------------------

/** 스칼라 함수를 계산한다. 집계는 호출자가 따로 처리한다. */
export function evaluateScalarFunction(
  name: string,
  args: TypedValue[],
  ctx: FunctionContext,
): TypedValue {
  // 타입 없는 문자열(리터럴·문자열 파라미터)은 VARCHAR로 본다.
  const typed = args.map((arg) => arg.type === null || arg.type === undefined
    ? { value: arg.value, type: varcharType(Math.max(1, codePointLength(typeof arg.value === "string" ? arg.value : ""))) }
    : arg);
  args = typed;
  const upper = name.toUpperCase();
  switch (upper) {
    case "UPPER":
    case "LOWER": {
      requireArgCount(name, args, 1, 1);
      const arg = args[0] as TypedValue;
      if (arg.value === null) return { value: null, type: varcharType(1) };
      const text = asString(arg.value, name);
      const out = upper === "UPPER" ? text.toUpperCase() : text.toLowerCase();
      return { value: out, type: varcharType(Math.max(1, codePointLength(out))) };
    }
    case "LENGTH":
    case "CHAR_LENGTH":
    case "CHARACTER_LENGTH": {
      requireArgCount(name, args, 1, 1);
      const arg = args[0] as TypedValue;
      if (arg.value === null) return { value: null, type: BIGINT_TYPE };
      return { value: BigInt(codePointLength(asString(arg.value, name))), type: BIGINT_TYPE };
    }
    case "OCTET_LENGTH": {
      requireArgCount(name, args, 1, 1);
      const arg = args[0] as TypedValue;
      if (arg.value === null) return { value: null, type: BIGINT_TYPE };
      return { value: BigInt(Buffer.byteLength(asString(arg.value, name), "utf8")), type: BIGINT_TYPE };
    }
    case "SUBSTRING":
    case "SUBSTR": {
      requireArgCount(name, args, 2, 3);
      const [textArg, startArg, lengthArg] = args as [TypedValue, TypedValue, TypedValue?];
      if (textArg.value === null || startArg.value === null || (lengthArg !== undefined && lengthArg.value === null)) {
        return { value: null, type: varcharType(1) };
      }
      const text = asString(textArg.value, name);
      const start = integerArg(startArg, name, ctx.typeCtx);
      const length = lengthArg === undefined ? null : integerArg(lengthArg, name, ctx.typeCtx);
      const out = substringValue(text, start, length, name);
      return { value: out, type: varcharType(Math.max(1, codePointLength(text))) };
    }
    case "POSITION": {
      requireArgCount(name, args, 2, 2);
      const [needleArg, haystackArg] = args as [TypedValue, TypedValue];
      if (needleArg.value === null || haystackArg.value === null) {
        return { value: null, type: BIGINT_TYPE };
      }
      const needle = asString(needleArg.value, name);
      const haystack = asString(haystackArg.value, name);
      const needlePoints = Array.from(needle);
      const hayPoints = Array.from(haystack);
      if (needlePoints.length === 0) return { value: 1n, type: BIGINT_TYPE };
      for (let i = 0; i + needlePoints.length <= hayPoints.length; i++) {
        let same = true;
        for (let j = 0; j < needlePoints.length; j++) {
          if (hayPoints[i + j] !== needlePoints[j]) {
            same = false;
            break;
          }
        }
        if (same) return { value: BigInt(i + 1), type: BIGINT_TYPE };
      }
      return { value: 0n, type: BIGINT_TYPE };
    }
    case "CONCAT": {
      requireArgCount(name, args, 2, 1000);
      if (!allNotNull(args)) return { value: null, type: varcharType(1) };
      let length = 0;
      let out = "";
      for (const arg of args) {
        const text = asString(arg.value as NonNullValue, name);
        out += text;
        length += codePointLength(text);
      }
      return { value: out, type: varcharType(Math.max(1, Math.min(length, 65535))) };
    }
    case "REPLACE": {
      requireArgCount(name, args, 2, 3);
      const [textArg, fromArg, toArg] = args as [TypedValue, TypedValue, TypedValue?];
      if (textArg.value === null || fromArg.value === null || (toArg !== undefined && toArg.value === null)) {
        return { value: null, type: (textArg.type.kind === "CHAR" || textArg.type.kind === "VARCHAR" ? textArg.type : varcharType(1)) };
      }
      const text = asString(textArg.value, name);
      const from = asString(fromArg.value, name);
      const to = toArg === undefined ? "" : asString(toArg.value as NonNullValue, name);
      if (from.length === 0) return { value: text, type: textArg.type };
      return { value: text.split(from).join(to), type: textArg.type };
    }
    case "LTRIM":
    case "RTRIM": {
      requireArgCount(name, args, 1, 2);
      const [textArg, charsArg] = args as [TypedValue, TypedValue?];
      if (textArg.value === null) return { value: null, type: varcharType(1) };
      const text = asString(textArg.value, name);
      const chars = trimSet(charsArg ?? null, ctx.typeCtx);
      const out = upper === "LTRIM" ? trimBoth(text, chars, true, false) : trimBoth(text, chars, false, true);
      return { value: out, type: textArg.type };
    }
    case "ABS": {
      requireArgCount(name, args, 1, 1);
      const arg = args[0] as TypedValue;
      if (arg.value === null) return { value: null, type: arg.type };
      const value = arg.value;
      if (typeof value === "bigint") return { value: value < 0n ? -value : value, type: arg.type };
      if (value instanceof Decimal) return { value: value.abs(), type: arg.type };
      if (typeof value === "number") return { value: Math.abs(value), type: arg.type };
      throw typeMismatch(`Function ${name} expects a numeric value.`);
    }
    case "MOD": {
      requireArgCount(name, args, 2, 2);
      const [leftArg, rightArg] = args as [TypedValue, TypedValue];
      if (leftArg.value === null || rightArg.value === null) return { value: null, type: leftArg.type };
      const left = leftArg.value;
      const right = rightArg.value;
      if (typeof left === "bigint" && typeof right === "bigint") {
        if (right === 0n) throw divisionByZero();
        return { value: left % right, type: leftArg.type };
      }
      if (left instanceof Decimal && right instanceof Decimal) {
        return { value: left.remainder(right), type: leftArg.type };
      }
      if (typeof left === "number" && typeof right === "number") {
        if (right === 0) throw divisionByZero();
        return { value: left % right, type: DOUBLE_TYPE };
      }
      // 섞인 수 계열은 공통 타입으로 맞춘다.
      const common = commonType(leftArg.type, rightArg.type);
      if (common === null || numericKind(common) === null) throw typeMismatch(`Function ${name} expects numeric values.`);
      const leftNumber = left instanceof Decimal ? left.toNumber() : Number(left as bigint);
      const rightNumber = right instanceof Decimal ? right.toNumber() : Number(right as bigint);
      if (rightNumber === 0) throw divisionByZero();
      return { value: leftNumber % rightNumber, type: DOUBLE_TYPE };
    }
    case "CEIL":
    case "CEILING":
    case "FLOOR": {
      requireArgCount(name, args, 1, 1);
      const arg = args[0] as TypedValue;
      if (arg.value === null) return { value: null, type: arg.type };
      const mode = upper.startsWith("CEIL") ? "CEILING" as const : "FLOOR" as const;
      const value = arg.value;
      if (typeof value === "bigint") return { value, type: arg.type };
      if (value instanceof Decimal) {
        const rounded = value.round(0, mode);
        if (arg.type.kind === "DECIMAL") {
          return { value: fitDecimal(rounded, arg.type.precision, 0), type: decimalType(arg.type.precision, 0) };
        }
        return { value: rounded, type: arg.type };
      }
      if (typeof value === "number") {
        const out = mode === "CEILING" ? Math.ceil(value) : Math.floor(value);
        return { value: conformValue(out, arg.type) as number, type: arg.type };
      }
      throw typeMismatch(`Function ${name} expects a numeric value.`);
    }
    case "POWER": {
      requireArgCount(name, args, 2, 2);
      const [baseArg, expArg] = args as [TypedValue, TypedValue];
      if (baseArg.value === null || expArg.value === null) return { value: null, type: DOUBLE_TYPE };
      const base = numericToNumber(baseArg.value, name);
      const exp = numericToNumber(expArg.value, name);
      const out = Math.pow(base, exp);
      if (!Number.isFinite(out)) throw numericOutOfRange(`Value out of range for function ${name}.`);
      return { value: conformValue(out, DOUBLE_TYPE) as number, type: DOUBLE_TYPE };
    }
    case "SQRT": {
      requireArgCount(name, args, 1, 1);
      const arg = args[0] as TypedValue;
      if (arg.value === null) return { value: null, type: DOUBLE_TYPE };
      const value = numericToNumber(arg.value, name);
      if (value < 0) throw numericOutOfRange(`Value out of range for function ${name}.`);
      const out = Math.sqrt(value);
      return { value: conformValue(out, DOUBLE_TYPE) as number, type: DOUBLE_TYPE };
    }
    case "ROUND": {
      requireArgCount(name, args, 1, 2);
      const [valueArg, digitsArg] = args as [TypedValue, TypedValue?];
      if (valueArg.value === null) return { value: null, type: valueArg.type };
      const digits = digitsArg === undefined || digitsArg.value === null ? 0n : integerArg(digitsArg, name, ctx.typeCtx);
      if (digits > 1000n || digits < -1000n) {
        throw new DbError("22023", ERROR_CODES.TYPE_PARAMETER_INVALID, `Function ${name} scale out of range.`);
      }
      const places = Number(digits);
      const value = valueArg.value;
      if (typeof value === "bigint") {
        if (places >= 0) return { value, type: valueArg.type };
        const factor = 10n ** BigInt(-places);
        const rounded = (value / factor + (value % factor !== 0n && (value < 0n ? value % factor <= -factor / 2n : value % factor >= factor / 2n) ? (value < 0n ? -1n : 1n) : 0n)) * factor;
        void rounded;
        // 0에서 먼 쪽 반올림을 bigint로 직접 계산한다.
        const quotient = value / factor;
        const remainder = value % factor;
        const half = factor / 2n;
        let adjusted = quotient;
        if (remainder !== 0n) {
          const abs = remainder < 0n ? -remainder : remainder;
          if (abs * 2n >= factor) adjusted += value < 0n ? -1n : 1n;
          void half;
        }
        const out = adjusted * factor;
        return { value: conformValue(out, valueArg.type) as bigint, type: valueArg.type };
      }
      if (value instanceof Decimal) {
        // 음수 자릿수는 10의 거듭제곱으로 나누었다가 곱한다. 결과 소수 자릿수도 함께 줄인다.
        if (places < 0) {
          const factor = Decimal.fromBigInt(10n ** BigInt(-places));
          const divided = value.divide(factor, 0);
          const out = divided.multiply(factor);
          const argType = valueArg.type;
          if (argType.kind !== "DECIMAL") {
            return { value: conformValue(out, valueArg.type) as Decimal, type: valueArg.type };
          }
          return { value: fitDecimal(out, argType.precision, 0), type: decimalType(argType.precision, 0) };
        }
        const argType = valueArg.type;
        const newScale = argType.kind === "DECIMAL" ? Math.min(argType.scale, places) : places;
        const out = value.round(newScale);
        if (argType.kind !== "DECIMAL") {
          return { value: conformValue(out, valueArg.type) as Decimal, type: valueArg.type };
        }
        return { value: fitDecimal(out, argType.precision, newScale), type: decimalType(argType.precision, newScale) };
      }
      if (typeof value === "number") {
        const factor = Math.pow(10, places);
        const out = Math.round(value * factor) / factor;
        return { value: conformValue(out, valueArg.type) as number, type: valueArg.type };
      }
      throw typeMismatch(`Function ${name} expects a numeric value.`);
    }
    case "COALESCE": {
      requireArgCount(name, args, 1, 1000);
      // NULL 값은 공통 타입에 끼지 않는다. (NULL 리터럴이 어느 타입과도 어울리게)
      let common: DataType | null = null;
      for (const arg of args) {
        if (arg.value === null) continue;
        common = common === null ? arg.type : commonType(common, arg.type);
        if (common === null) throw typeMismatch(`Function ${name} got incompatible types.`);
      }
      const resultType = common ?? varcharType(1);
      for (const arg of args) {
        if (arg.value !== null) {
          return { value: castValue(arg.value, arg.type, resultType, ctx.typeCtx), type: resultType };
        }
      }
      return { value: null, type: resultType };
    }
    case "NULLIF": {
      requireArgCount(name, args, 2, 2);
      const [leftArg, rightArg] = args as [TypedValue, TypedValue];
      if (leftArg.value === null) {
        const other = rightArg.value === null ? varcharType(1) : rightArg.type;
        return { value: null, type: other };
      }
      if (rightArg.value === null) {
        return { value: castValue(leftArg.value, leftArg.type, leftArg.type, ctx.typeCtx), type: leftArg.type };
      }
      const common = commonType(leftArg.type, rightArg.type);
      if (common === null) throw typeMismatch(`Function ${name} got incompatible types.`);
      const left = castValue(leftArg.value, leftArg.type, common, ctx.typeCtx);
      const right = castValue(rightArg.value, rightArg.type, common, ctx.typeCtx);
      const bothChar = common.kind === "CHAR";
      const same = isNotDistinct(left, right, { ignoreTrailingSpaces: bothChar });
      return same ? { value: null, type: common } : { value: left, type: common };
    }
    case "NVL": {
      requireArgCount(name, args, 2, 2);
      const [valueArg, altArg] = args as [TypedValue, TypedValue];
      if (valueArg.value === null && altArg.value === null) return { value: null, type: varcharType(1) };
      const common = valueArg.value === null
        ? altArg.type
        : altArg.value === null
          ? valueArg.type
          : commonType(valueArg.type, altArg.type);
      if (common === null) throw typeMismatch(`Function ${name} got incompatible types.`);
      if (valueArg.value !== null) {
        return { value: castValue(valueArg.value, valueArg.type, common, ctx.typeCtx), type: common };
      }
      return { value: castValue(altArg.value as NonNullValue, altArg.type, common, ctx.typeCtx), type: common };
    }
    case "CURRENT_DATE": {
      requireArgCount(name, args, 0, 0);
      const days = currentLocalDays(ctx.typeCtx);
      return { value: new DateValue(days), type: DATE_TYPE };
    }
    case "CURRENT_TIME": {
      requireArgCount(name, args, 0, 1);
      const precision = precisionArg(args, 0, name);
      const now = currentWallTime(ctx.typeCtx);
      return { value: TimeValue.fromLocal(now.microsOfDay, now.offset), type: timeType(precision, true) };
    }
    case "CURRENT_TIMESTAMP": {
      requireArgCount(name, args, 0, 1);
      const precision = precisionArg(args, 6, name);
      const now = currentTimestamp(ctx.typeCtx);
      return { value: conformTimestamp(now, precision, true), type: timestampType(precision, true) };
    }
    case "LOCALTIME": {
      requireArgCount(name, args, 0, 1);
      const precision = precisionArg(args, 0, name);
      const now = currentWallTime(ctx.typeCtx);
      return { value: new TimeValue(now.microsOfDay, null), type: timeType(precision, false) };
    }
    case "LOCALTIMESTAMP": {
      requireArgCount(name, args, 0, 1);
      const precision = precisionArg(args, 6, name);
      const now = currentTimestamp(ctx.typeCtx);
      const local = new TimestampValue(now.localMicros, null);
      return { value: conformTimestamp(local, precision, false), type: timestampType(precision, false) };
    }
    case "CURRENT_USER": {
      requireArgCount(name, args, 0, 0);
      return { value: ctx.currentUser, type: varcharType(Math.max(1, ctx.currentUser.length)) };
    }
    case "TO_CHAR": {
      requireArgCount(name, args, 1, 2);
      const [valueArg, formatArg] = args as [TypedValue, TypedValue?];
      if (valueArg.value === null) return { value: null, type: varcharType(4000) };
      const format = formatArg === undefined || formatArg.value === null ? null : asString(formatArg.value, name);
      if (formatArg !== undefined && formatArg.value === null) return { value: null, type: varcharType(4000) };
      const value = valueArg.value;
      const type = valueArg.type;
      if (type.kind === "DATE" || type.kind === "TIME" || type.kind === "TIMESTAMP") {
        const out = format === null ? formatDatetimeIso(value, type) : formatDatetime(value, type, format);
        return { value: out, type: varcharType(4000) };
      }
      if (type.kind === "INTEGER" || type.kind === "DECIMAL" || type.kind === "FLOAT") {
        const out = format === null ? formatNumberIso(value, type) : formatNumber(value, format);
        return { value: out, type: varcharType(4000) };
      }
      throw typeMismatch(`Function ${name} expects a datetime or numeric value.`);
    }
    case "TO_DATE": {
      requireArgCount(name, args, 1, 2);
      const [textArg, formatArg] = args as [TypedValue, TypedValue?];
      if (textArg.value === null) return { value: null, type: timestampType(0, false) };
      const text = asString(textArg.value, name);
      const format = formatArg === undefined || formatArg.value === null ? null : asString(formatArg.value, name);
      if (formatArg !== undefined && formatArg.value === null) return { value: null, type: timestampType(0, false) };
      if (format === null) {
        const parsed = parseTimestampText(text);
        const value = TimestampValue.fromLocal(parsed.localMicros, null);
        return { value: conformTimestamp(value, 0, false), type: timestampType(0, false) };
      }
      const fields = parseDatetimeWithFormat(text, format);
      const days = daysFromFields(fields.year, fields.month, fields.day);
      const microsOfDay = timeOfDayFromFields(fields.hour, fields.minute, fields.second, fields.microsecond);
      const value = new TimestampValue(BigInt(days) * BigInt(MICROS_PER_DAY) + BigInt(microsOfDay), null);
      return { value: conformTimestamp(value, 0, false), type: timestampType(0, false) };
    }
    default:
      throw new DbError("42883", ERROR_CODES.UNDEFINED_FUNCTION, `Unknown function: "${name}".`);
  }
}

/** 집계가 아닌 스칼라 함수인지 본다. 파서에서 받은 이름 그대로 판단한다. */
export function isScalarFunction(name: string): boolean {
  const upper = name.toUpperCase();
  if (isAggregateFunction(upper)) return false;
  // 알려지지 않은 이름은 호출 때 오류가 나므로 여기서는 참으로 본다.
  return true;
}

/** 행 없이 스칼라 함수의 결과 타입만 정한다. 값 계산은 하지 않는다. */
export function inferScalarType(name: string, argTypes: DataType[]): DataType {
  const upper = name.toUpperCase();
  const first = (index: number): DataType => {
    const type = argTypes[index];
    if (type === undefined) {
      throw new DbError("42883", ERROR_CODES.INVALID_FUNCTION_ARGUMENT, `Function ${name} needs more arguments.`);
    }
    return type;
  };
  switch (upper) {
    case "UPPER":
    case "LOWER":
    case "REPLACE":
    case "LTRIM":
    case "RTRIM":
    case "SUBSTRING":
    case "SUBSTR":
      if (argTypes.length === 0) {
        throw new DbError("42883", ERROR_CODES.INVALID_FUNCTION_ARGUMENT, `Function ${name} needs an argument.`);
      }
      return first(0);
    case "LENGTH":
    case "CHAR_LENGTH":
    case "CHARACTER_LENGTH":
    case "OCTET_LENGTH":
    case "POSITION":
      return BIGINT_TYPE;
    case "CONCAT":
      return varcharType(65535);
    case "ABS":
    case "MOD":
    case "CEIL":
    case "CEILING":
    case "FLOOR":
    case "ROUND":
      return first(0);
    case "POWER":
    case "SQRT":
      return DOUBLE_TYPE;
    case "COALESCE":
    case "NULLIF":
    case "NVL": {
      let common: DataType | null = null;
      for (const type of argTypes) {
        common = common === null ? type : commonType(common, type);
        if (common === null) throw typeMismatch(`Function ${name} got incompatible types.`);
      }
      if (common === null) {
        throw new DbError("42883", ERROR_CODES.INVALID_FUNCTION_ARGUMENT, `Function ${name} needs an argument.`);
      }
      return common;
    }
    case "CURRENT_DATE":
      return DATE_TYPE;
    case "CURRENT_TIME":
      return timeType(0, true);
    case "CURRENT_TIMESTAMP":
      return timestampType(6, true);
    case "LOCALTIME":
      return timeType(0, false);
    case "LOCALTIMESTAMP":
      return timestampType(6, false);
    case "CURRENT_USER":
      return varcharType(128);
    case "TO_CHAR":
      return varcharType(4000);
    case "TO_DATE":
      return timestampType(0, false);
    default:
      throw new DbError("42883", ERROR_CODES.UNDEFINED_FUNCTION, `Unknown function: "${name}".`);
  }
}

function numericToNumber(value: NonNullValue, name: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Decimal) return value.toNumber();
  throw typeMismatch(`Function ${name} expects a numeric value.`);
}

function precisionArg(args: TypedValue[], defaultValue: number, name: string): number {
  if (args.length === 0) return defaultValue;
  const arg = args[0] as TypedValue;
  if (arg.value === null) {
    throw new DbError("22023", ERROR_CODES.TYPE_PARAMETER_INVALID, `Function ${name} precision must not be NULL.`);
  }
  const precision = asBigIntValue(arg.value, name);
  if (precision < 0n || precision > 6n) {
    throw new DbError("22023", ERROR_CODES.TYPE_PARAMETER_INVALID, `Function ${name} precision must be 0 to 6.`);
  }
  return Number(precision);
}

function currentLocalDays(typeCtx: TypeContext): number {
  const offset = typeCtx.timeZone.offsetAtUtc(typeCtx.currentUtcMicros);
  const local = typeCtx.currentUtcMicros + BigInt(offset) * BigInt(MICROS_PER_MINUTE);
  return splitLocalMicros(local).days;
}

function currentWallTime(typeCtx: TypeContext): { microsOfDay: number; offset: number } {
  const offset = typeCtx.timeZone.offsetAtUtc(typeCtx.currentUtcMicros);
  const local = typeCtx.currentUtcMicros + BigInt(offset) * BigInt(MICROS_PER_MINUTE);
  const split = splitLocalMicros(local);
  return { microsOfDay: split.microsOfDay, offset };
}

function currentTimestamp(typeCtx: TypeContext): TimestampValue {
  const offset = typeCtx.timeZone.offsetAtUtc(typeCtx.currentUtcMicros);
  return new TimestampValue(typeCtx.currentUtcMicros, offset);
}

void SMALLINT_TYPE;
void INTEGER_TYPE;
void REAL_TYPE;
void BOOLEAN_TYPE;
void charType;
void intervalType;
void isCastSupported;
void castLiteral;
void bindConcat;
void compareCodePoints;
void compareValues;
void formatHex;
void formatValue;
void parseHex;
void trimTrailingSpaces;
void castNotSupported;
void integerType;
