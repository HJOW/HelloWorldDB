/**
 * 날짜시간과 기간.
 *
 * 담당
 *  - DATE, TIME, TIMESTAMP 와 각각의 WITH TIME ZONE 형태. 소수 초는 6자리(마이크로초)까지
 *  - WITH TIME ZONE 은 UTC 기준 시각과 입력 당시의 오프셋을 함께 가진다.
 *  - INTERVAL 의 연-월 계열과 일-시간 계열
 *  - 날짜시간과 기간 사이의 연산, 문자열과의 상호 변환(ISO 8601 형태)
 *  - 세션 타임존의 적용. 오프셋(+09:00)과 지역 이름(Asia/Seoul)을 모두 받는다.
 *
 * JavaScript 의 Date 는 밀리초까지만 담으므로 내부 표현으로 쓰지 않는다.
 * 날짜는 1970-01-01 부터의 일수, 시각은 마이크로초 단위의 정수로 다룬다.
 * 달력은 전 기간에 그레고리력을 적용한다.
 *
 * 관련 사양 : AGENTS.md 상세 1-1, 1-2
 * 구현 단계 : 3단계
 */

import { internalError } from "../common/errors.js";
import type { IntervalDataType, IntervalField } from "./dataType.js";
import {
  datetimeOutOfRange,
  intervalOutOfRange,
  invalidDatetimeFormat,
  invalidIntervalFormat,
  invalidTimeZone,
  quoteForMessage,
  typeMismatch,
} from "./errors.js";
import { Decimal, divideRounded } from "./numeric.js";

export const MICROS_PER_SECOND = 1_000_000;
export const MICROS_PER_MINUTE = 60 * MICROS_PER_SECOND;
export const MICROS_PER_HOUR = 60 * MICROS_PER_MINUTE;
export const MICROS_PER_DAY = 24 * MICROS_PER_HOUR;

const MICROS_PER_SECOND_BIG = BigInt(MICROS_PER_SECOND);
const MICROS_PER_MINUTE_BIG = BigInt(MICROS_PER_MINUTE);
const MICROS_PER_HOUR_BIG = BigInt(MICROS_PER_HOUR);
const MICROS_PER_DAY_BIG = BigInt(MICROS_PER_DAY);

/** 0001-01-01 의 일수. */
export const MIN_DATE_DAYS = -719_162;
/** 9999-12-31 의 일수. */
export const MAX_DATE_DAYS = 2_932_896;
/** 타임존 오프셋의 절대값 상한(분). config.json 의 `timeZone` 검증과 같다. */
export const MAX_OFFSET_MINUTES = 23 * 60 + 59;

const MIN_LOCAL_MICROS = BigInt(MIN_DATE_DAYS) * MICROS_PER_DAY_BIG;
const MAX_LOCAL_MICROS = BigInt(MAX_DATE_DAYS + 1) * MICROS_PER_DAY_BIG - 1n;

// ---------------------------------------------------------------------------
// 값 표현
// ---------------------------------------------------------------------------

/** DATE. 1970-01-01 부터의 일수. */
export class DateValue {
  readonly days: number;

  constructor(days: number) {
    this.days = days;
  }
}

/**
 * TIME, TIME WITH TIME ZONE.
 *  - 타임존이 없으면 `micros` 는 자정부터의 마이크로초이고 `offsetMinutes` 는 null 이다.
 *  - 타임존이 있으면 `micros` 는 UTC 기준(현지 시각 - 오프셋)이며 0 ~ 24시 범위를 벗어날 수 있다.
 *    비교는 이 값으로 한다. 현지 시각은 `localMicros` 로 얻는다.
 */
export class TimeValue {
  readonly micros: number;
  readonly offsetMinutes: number | null;

  constructor(micros: number, offsetMinutes: number | null = null) {
    this.micros = micros;
    this.offsetMinutes = offsetMinutes;
  }

  /** 현지 시각(자정부터의 마이크로초)과 오프셋으로 만든다. */
  static fromLocal(localMicros: number, offsetMinutes: number | null): TimeValue {
    return new TimeValue(
      offsetMinutes === null ? localMicros : localMicros - offsetMinutes * MICROS_PER_MINUTE,
      offsetMinutes,
    );
  }

  get localMicros(): number {
    return this.offsetMinutes === null ? this.micros : this.micros + this.offsetMinutes * MICROS_PER_MINUTE;
  }
}

/**
 * TIMESTAMP, TIMESTAMP WITH TIME ZONE.
 *  - 타임존이 없으면 `micros` 는 벽시계 시각을 1970-01-01 00:00:00 부터 센 마이크로초이다.
 *  - 타임존이 있으면 `micros` 는 UTC 기준 시각이고 `offsetMinutes` 는 입력 당시의 오프셋이다.
 */
export class TimestampValue {
  readonly micros: bigint;
  readonly offsetMinutes: number | null;

  constructor(micros: bigint, offsetMinutes: number | null = null) {
    this.micros = micros;
    this.offsetMinutes = offsetMinutes;
  }

  /** 벽시계 시각과 오프셋으로 만든다. */
  static fromLocal(localMicros: bigint, offsetMinutes: number | null): TimestampValue {
    return new TimestampValue(
      offsetMinutes === null ? localMicros : localMicros - BigInt(offsetMinutes) * MICROS_PER_MINUTE_BIG,
      offsetMinutes,
    );
  }

  get localMicros(): bigint {
    return this.offsetMinutes === null ? this.micros : this.micros + BigInt(this.offsetMinutes) * MICROS_PER_MINUTE_BIG;
  }
}

/** INTERVAL 의 두 계열. 서로 비교하거나 더할 수 없다. */
export type IntervalClass = "YEAR_MONTH" | "DAY_TIME";

/** INTERVAL. 연-월 계열은 개월 수, 일-시간 계열은 마이크로초로 가진다. */
export class IntervalValue {
  readonly intervalClass: IntervalClass;
  readonly months: number;
  readonly micros: bigint;

  private constructor(intervalClass: IntervalClass, months: number, micros: bigint) {
    this.intervalClass = intervalClass;
    this.months = months;
    this.micros = micros;
  }

  static yearMonth(months: number): IntervalValue {
    return new IntervalValue("YEAR_MONTH", months === 0 ? 0 : months, 0n);
  }

  static dayTime(micros: bigint): IntervalValue {
    return new IntervalValue("DAY_TIME", 0, micros);
  }

  sign(): -1 | 0 | 1 {
    if (this.intervalClass === "YEAR_MONTH") {
      return this.months === 0 ? 0 : this.months < 0 ? -1 : 1;
    }
    return this.micros === 0n ? 0 : this.micros < 0n ? -1 : 1;
  }
}

// ---------------------------------------------------------------------------
// 달력 계산
// ---------------------------------------------------------------------------

export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

export interface TimeFields {
  hour: number;
  minute: number;
  second: number;
  microsecond: number;
}

function floorDivBig(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? quotient - 1n : quotient;
}

function floorMod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** 그레고리력 날짜를 1970-01-01 부터의 일수로 바꾼다. 범위는 검사하지 않는다. */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** 1970-01-01 부터의 일수를 그레고리력 날짜로 바꾼다. */
export function civilFromDays(days: number): CivilDate {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1_460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthIndex = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthIndex + 2) / 5) + 1;
  const month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

/** 요일. 0 = 일요일, 6 = 토요일. */
export function dayOfWeek(days: number): number {
  return floorMod(days + 4, 7);
}

/** 자정부터의 마이크로초를 시, 분, 초, 마이크로초로 나눈다. */
export function splitTimeOfDay(micros: number): TimeFields {
  const hour = Math.floor(micros / MICROS_PER_HOUR);
  const afterHour = micros - hour * MICROS_PER_HOUR;
  const minute = Math.floor(afterHour / MICROS_PER_MINUTE);
  const afterMinute = afterHour - minute * MICROS_PER_MINUTE;
  const second = Math.floor(afterMinute / MICROS_PER_SECOND);
  return { hour, minute, second, microsecond: afterMinute - second * MICROS_PER_SECOND };
}

/** 벽시계 마이크로초를 일수와 그 날의 마이크로초로 나눈다. */
export function splitLocalMicros(localMicros: bigint): { days: number; microsOfDay: number } {
  const days = floorDivBig(localMicros, MICROS_PER_DAY_BIG);
  return { days: Number(days), microsOfDay: Number(localMicros - days * MICROS_PER_DAY_BIG) };
}

export function joinLocalMicros(days: number, microsOfDay: number): bigint {
  return BigInt(days) * MICROS_PER_DAY_BIG + BigInt(microsOfDay);
}

// ---------------------------------------------------------------------------
// 범위 검사와 필드로부터의 생성
// ---------------------------------------------------------------------------

export function checkDateRange(days: number): void {
  if (!Number.isInteger(days) || days < MIN_DATE_DAYS || days > MAX_DATE_DAYS) {
    throw datetimeOutOfRange("Date out of range (0001-01-01 to 9999-12-31).");
  }
}

function checkLocalTimestampRange(localMicros: bigint): void {
  if (localMicros < MIN_LOCAL_MICROS || localMicros > MAX_LOCAL_MICROS) {
    throw datetimeOutOfRange("Timestamp out of range (0001-01-01 to 9999-12-31).");
  }
}

function checkOffsetRange(offsetMinutes: number): void {
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > MAX_OFFSET_MINUTES) {
    throw invalidTimeZone("Time zone displacement out of range (-23:59 to +23:59).");
  }
}

/** 연, 월, 일로 일수를 만든다. 없는 날짜나 범위 밖이면 22008 이다. */
export function daysFromFields(year: number, month: number, day: number): number {
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw datetimeOutOfRange("Year out of range (1 to 9999).");
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw datetimeOutOfRange("Month out of range (1 to 12).");
  }
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) {
    throw datetimeOutOfRange(`Day out of range for ${pad(year, 4)}-${pad(month, 2)}.`);
  }
  return daysFromCivil(year, month, day);
}

/** 시, 분, 초, 마이크로초로 자정부터의 마이크로초를 만든다. 범위 밖이면 22008 이다. */
export function timeOfDayFromFields(hour: number, minute: number, second: number, microsecond = 0): number {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw datetimeOutOfRange("Hour out of range (0 to 23).");
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw datetimeOutOfRange("Minute out of range (0 to 59).");
  }
  if (!Number.isInteger(second) || second < 0 || second > 59) {
    throw datetimeOutOfRange("Second out of range (0 to 59).");
  }
  if (!Number.isInteger(microsecond) || microsecond < 0 || microsecond >= MICROS_PER_SECOND) {
    throw datetimeOutOfRange("Fractional second out of range.");
  }
  return hour * MICROS_PER_HOUR + minute * MICROS_PER_MINUTE + second * MICROS_PER_SECOND + microsecond;
}

// ---------------------------------------------------------------------------
// 소수 초 자릿수 맞추기
// ---------------------------------------------------------------------------

function fractionUnit(precision: number): number {
  if (!Number.isInteger(precision) || precision < 0 || precision > 6) {
    throw internalError(`Invalid fractional seconds precision: ${precision}.`);
  }
  return 10 ** (6 - precision);
}

/** 자정부터의 마이크로초를 소수 초 precision 자리로 반올림한다. 결과가 24시가 될 수 있다. */
function roundTimeOfDay(micros: number, precision: number): number {
  const unit = fractionUnit(precision);
  return unit === 1 ? micros : Math.floor((micros + unit / 2) / unit) * unit;
}

/** 벽시계 마이크로초를 소수 초 precision 자리로 반올림한다. (소수 초 0.5 는 다음 단위로 올린다) */
function roundLocalMicros(localMicros: bigint, precision: number): bigint {
  const unit = BigInt(fractionUnit(precision));
  return unit === 1n ? localMicros : floorDivBig(localMicros + unit / 2n, unit) * unit;
}

/** DATE 값의 범위를 확인한다. */
export function conformDate(value: DateValue): DateValue {
  checkDateRange(value.days);
  return value;
}

/**
 * TIME 값을 타입에 맞춘다. 소수 초는 반올림하며, 반올림 결과가 24시에 이르면 22008 이다.
 * 타임존 유무가 타입과 다르면 호출자가 먼저 형변환해야 한다.
 */
export function conformTime(value: TimeValue, precision: number, withTimeZone: boolean): TimeValue {
  if ((value.offsetMinutes !== null) !== withTimeZone) {
    throw internalError("TIME value does not match the time zone property of its type.");
  }
  if (value.offsetMinutes !== null) checkOffsetRange(value.offsetMinutes);
  const local = value.localMicros;
  if (!Number.isInteger(local) || local < 0 || local >= MICROS_PER_DAY) {
    throw datetimeOutOfRange("Time out of range (00:00:00 to 23:59:59.999999).");
  }
  const rounded = roundTimeOfDay(local, precision);
  if (rounded >= MICROS_PER_DAY) {
    throw datetimeOutOfRange("Time out of range after rounding fractional seconds.");
  }
  return rounded === local ? value : TimeValue.fromLocal(rounded, value.offsetMinutes);
}

/** TIMESTAMP 값을 타입에 맞춘다. 소수 초는 반올림하고 벽시계 날짜의 범위를 확인한다. */
export function conformTimestamp(value: TimestampValue, precision: number, withTimeZone: boolean): TimestampValue {
  if ((value.offsetMinutes !== null) !== withTimeZone) {
    throw internalError("TIMESTAMP value does not match the time zone property of its type.");
  }
  if (value.offsetMinutes !== null) checkOffsetRange(value.offsetMinutes);
  const local = value.localMicros;
  const rounded = roundLocalMicros(local, precision);
  checkLocalTimestampRange(rounded);
  return rounded === local ? value : TimestampValue.fromLocal(rounded, value.offsetMinutes);
}

// ---------------------------------------------------------------------------
// 문자열 해석
// ---------------------------------------------------------------------------

const DATE_PATTERN = String.raw`(\d{4})-(\d{1,2})-(\d{1,2})`;
const TIME_PATTERN = String.raw`(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,9}))?)?`;
const ZONE_PATTERN = String.raw`(?:\s*(Z|[+-]\d{2}(?::?\d{2})?))?`;
const TIMESTAMP_REGEX = new RegExp(String.raw`^\s*${DATE_PATTERN}(?:(?:\s+|T)${TIME_PATTERN}${ZONE_PATTERN})?\s*$`, "i");
const TIME_REGEX = new RegExp(String.raw`^\s*${TIME_PATTERN}${ZONE_PATTERN}\s*$`, "i");
const OFFSET_REGEX = /^([+-])(\d{2})(?::?(\d{2}))?$/;

/** 소수 초 문자열(최대 9자리)을 마이크로초로 바꾼다. 7자리부터는 반올림하며 1,000,000 이 될 수 있다. */
function fractionToMicros(fraction: string | undefined): number {
  if (fraction === undefined) return 0;
  const nanos = Number(fraction.padEnd(9, "0"));
  return Math.floor((nanos + 500) / 1_000);
}

/**
 * 오프셋 표기(`Z`, `+09`, `+09:00`, `+0900`)를 분으로 바꾼다.
 * 표기가 아니면 null, 범위를 벗어나면 22009 이다.
 */
export function parseOffsetText(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "Z" || trimmed === "z") return 0;
  const match = OFFSET_REGEX.exec(trimmed);
  if (match === null) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  if (hours > 23 || minutes > 59) {
    throw invalidTimeZone(`Invalid time zone displacement: ${quoteForMessage(trimmed)}.`);
  }
  const total = hours * 60 + minutes;
  return match[1] === "-" && total !== 0 ? -total : total;
}

function parseTimeFields(
  hourText: string | undefined,
  minuteText: string | undefined,
  secondText: string | undefined,
  fractionText: string | undefined,
): number {
  const base = timeOfDayFromFields(Number(hourText), Number(minuteText), Number(secondText ?? "0"), 0);
  return base + fractionToMicros(fractionText);
}

export interface ParsedTime {
  /** 현지 시각. 자정부터의 마이크로초. */
  localMicros: number;
  /** 문자열에 적힌 오프셋. 없으면 null. */
  offsetMinutes: number | null;
}

export interface ParsedTimestamp {
  /** 문자열에 적힌 벽시계 시각. */
  localMicros: bigint;
  /** 문자열에 적힌 오프셋. 없으면 null. */
  offsetMinutes: number | null;
}

/**
 * `HH:MM[:SS[.ffffff]][오프셋]` 을 해석한다.
 * 형식이 틀리면 22007, 필드가 범위를 벗어나면 22008 이다.
 */
export function parseTimeText(text: string): ParsedTime {
  const match = TIME_REGEX.exec(text);
  if (match === null) {
    throw invalidDatetimeFormat(`Invalid time value: ${quoteForMessage(text)}.`);
  }
  const localMicros = parseTimeFields(match[1], match[2], match[3], match[4]);
  if (localMicros >= MICROS_PER_DAY) {
    throw datetimeOutOfRange("Time out of range after rounding fractional seconds.");
  }
  return { localMicros, offsetMinutes: match[5] === undefined ? null : parseOffsetText(match[5]) };
}

/**
 * `YYYY-MM-DD[ HH:MM[:SS[.ffffff]][오프셋]]` 을 해석한다. 날짜와 시각 사이는 공백이나 `T` 이다.
 * 형식이 틀리면 22007, 필드가 범위를 벗어나면 22008 이다.
 */
export function parseTimestampText(text: string): ParsedTimestamp {
  const match = TIMESTAMP_REGEX.exec(text);
  if (match === null) {
    throw invalidDatetimeFormat(`Invalid date or timestamp value: ${quoteForMessage(text)}.`);
  }
  const days = daysFromFields(Number(match[1]), Number(match[2]), Number(match[3]));
  const microsOfDay = match[4] === undefined ? 0 : parseTimeFields(match[4], match[5], match[6], match[7]);
  const localMicros = joinLocalMicros(days, microsOfDay);
  checkLocalTimestampRange(localMicros);
  return { localMicros, offsetMinutes: match[8] === undefined ? null : parseOffsetText(match[8]) };
}

// ---------------------------------------------------------------------------
// 문자열로 바꾸기
// ---------------------------------------------------------------------------

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** `YYYY-MM-DD` */
export function formatDate(days: number): string {
  const civil = civilFromDays(days);
  return `${pad(civil.year, 4)}-${pad(civil.month, 2)}-${pad(civil.day, 2)}`;
}

/** `HH:MM:SS[.fff]`. 소수 초는 precision 자리만 적는다. */
export function formatTimeOfDay(micros: number, precision: number): string {
  const fields = splitTimeOfDay(micros);
  const base = `${pad(fields.hour, 2)}:${pad(fields.minute, 2)}:${pad(fields.second, 2)}`;
  return precision > 0 ? `${base}.${pad(fields.microsecond, 6).slice(0, precision)}` : base;
}

/** `+09:00` 형태. */
export function formatOffset(offsetMinutes: number): string {
  const absolute = Math.abs(offsetMinutes);
  return `${offsetMinutes < 0 ? "-" : "+"}${pad(Math.floor(absolute / 60), 2)}:${pad(absolute % 60, 2)}`;
}

export function formatTime(value: TimeValue, precision: number): string {
  const text = formatTimeOfDay(value.localMicros, precision);
  return value.offsetMinutes === null ? text : `${text}${formatOffset(value.offsetMinutes)}`;
}

/** `YYYY-MM-DD HH:MM:SS[.ffffff][+09:00]` */
export function formatTimestamp(value: TimestampValue, precision: number): string {
  const { days, microsOfDay } = splitLocalMicros(value.localMicros);
  const text = `${formatDate(days)} ${formatTimeOfDay(microsOfDay, precision)}`;
  return value.offsetMinutes === null ? text : `${text}${formatOffset(value.offsetMinutes)}`;
}

// ---------------------------------------------------------------------------
// 타임존
// ---------------------------------------------------------------------------

/** 세션 타임존. 오프셋은 분 단위이며 UTC 보다 앞서면 양수이다. */
export interface TimeZone {
  /** 표시용 이름. 고정 오프셋은 `+09:00`, 지역은 `Asia/Seoul` 형태이다. */
  readonly id: string;
  /** UTC 기준 시각에서의 오프셋. */
  offsetAtUtc(utcMicros: bigint): number;
  /**
   * 벽시계 시각에서의 오프셋.
   * 서머타임 종료로 두 번 나타나는 시각은 먼저 오는 쪽을, 시작으로 건너뛴 시각은 전환 이전의 오프셋을 쓴다.
   */
  offsetAtLocal(localMicros: bigint): number;
}

class FixedOffsetZone implements TimeZone {
  readonly id: string;
  private readonly offsetMinutes: number;

  constructor(offsetMinutes: number) {
    this.offsetMinutes = offsetMinutes;
    this.id = formatOffset(offsetMinutes);
  }

  offsetAtUtc(): number {
    return this.offsetMinutes;
  }

  offsetAtLocal(): number {
    return this.offsetMinutes;
  }
}

/**
 * IANA 지역 이름의 타임존. 오프셋은 Intl 로 구하며 분 단위로 반올림한다.
 * (표준시 도입 이전의 지방 평균시처럼 초 단위 오프셋을 가진 시기는 가장 가까운 분으로 본다)
 */
class NamedZone implements TimeZone {
  readonly id: string;
  private readonly format: Intl.DateTimeFormat;
  private lastEpochSeconds = Number.NaN;
  private lastOffset = 0;

  constructor(format: Intl.DateTimeFormat) {
    this.format = format;
    this.id = format.resolvedOptions().timeZone;
  }

  offsetAtUtc(utcMicros: bigint): number {
    const epochSeconds = Number(floorDivBig(utcMicros, MICROS_PER_SECOND_BIG));
    if (epochSeconds === this.lastEpochSeconds) {
      return this.lastOffset;
    }
    let year = 0;
    let month = 1;
    let day = 1;
    let hour = 0;
    let minute = 0;
    let second = 0;
    let beforeChrist = false;
    for (const part of this.format.formatToParts(new Date(epochSeconds * 1_000))) {
      switch (part.type) {
        case "era": beforeChrist = part.value.toUpperCase().startsWith("B"); break;
        case "year": year = Number(part.value); break;
        case "month": month = Number(part.value); break;
        case "day": day = Number(part.value); break;
        case "hour": hour = Number(part.value) % 24; break;
        case "minute": minute = Number(part.value); break;
        case "second": second = Number(part.value); break;
        default: break;
      }
    }
    if (beforeChrist) year = 1 - year;
    const localSeconds = daysFromCivil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second;
    const offset = Math.round((localSeconds - epochSeconds) / 60);
    this.lastEpochSeconds = epochSeconds;
    this.lastOffset = offset;
    return offset;
  }

  offsetAtLocal(localMicros: bigint): number {
    // 전환 시점 앞뒤의 오프셋을 후보로 삼는다. 후보로 계산한 시각의 오프셋이 후보와 같으면 유효하다.
    const before = this.offsetAtUtc(localMicros - MICROS_PER_DAY_BIG);
    const after = this.offsetAtUtc(localMicros + MICROS_PER_DAY_BIG);
    if (before === after) return before;
    const toUtc = (offset: number): bigint => localMicros - BigInt(offset) * MICROS_PER_MINUTE_BIG;
    if (this.offsetAtUtc(toUtc(before)) === before) return before;
    if (this.offsetAtUtc(toUtc(after)) === after) return after;
    return before;
  }
}

export const UTC_ZONE: TimeZone = new FixedOffsetZone(0);

const zoneCache = new Map<string, TimeZone>();

/**
 * 타임존 지정을 해석한다. config.json 의 `timeZone` 과 `SET TIME ZONE` 이 함께 쓴다.
 *  - `local` : 서버 운영체제의 타임존
 *  - `+09:00` 같은 오프셋, `Z`
 *  - `Asia/Seoul` 같은 IANA 지역 이름
 * 해석할 수 없으면 22009 이다.
 */
export function resolveTimeZone(spec: string): TimeZone {
  const trimmed = spec.trim();
  const key = trimmed.toLowerCase();
  const cached = zoneCache.get(key);
  if (cached !== undefined) return cached;

  let zone: TimeZone;
  const offset = parseOffsetText(trimmed);
  if (offset !== null) {
    zone = new FixedOffsetZone(offset);
  } else {
    let name = trimmed;
    if (key === "local") {
      name = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
    if (name.length === 0) {
      throw invalidTimeZone("Time zone must not be empty.");
    }
    let format: Intl.DateTimeFormat;
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone: name,
        hourCycle: "h23",
        era: "short",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      throw invalidTimeZone(`Unknown time zone: ${quoteForMessage(trimmed)}.`);
    }
    zone = new NamedZone(format);
  }
  zoneCache.set(key, zone);
  return zone;
}

/** 현재 시각. UTC 기준 마이크로초. */
export function currentUtcMicros(): bigint {
  return BigInt(Math.round((performance.timeOrigin + performance.now()) * 1_000));
}

/** 타임존 없는 TIMESTAMP 를 주어진 타임존의 벽시계 시각으로 보아 WITH TIME ZONE 값으로 만든다. */
export function attachTimeZone(value: TimestampValue, zone: TimeZone): TimestampValue {
  if (value.offsetMinutes !== null) return value;
  const guess = zone.offsetAtLocal(value.micros);
  const utcMicros = value.micros - BigInt(guess) * MICROS_PER_MINUTE_BIG;
  return new TimestampValue(utcMicros, zone.offsetAtUtc(utcMicros));
}

/** WITH TIME ZONE 값을 주어진 타임존의 벽시계 시각(타임존 없는 TIMESTAMP)으로 바꾼다. */
export function detachTimeZone(value: TimestampValue, zone: TimeZone): TimestampValue {
  if (value.offsetMinutes === null) return value;
  const offset = zone.offsetAtUtc(value.micros);
  return new TimestampValue(value.micros + BigInt(offset) * MICROS_PER_MINUTE_BIG, null);
}

// ---------------------------------------------------------------------------
// INTERVAL
// ---------------------------------------------------------------------------

/** INTERVAL 한정자. 타입 정의에서 필요한 항목만 뽑은 것이다. */
export type IntervalQualifier = Pick<
  IntervalDataType,
  "startField" | "endField" | "leadingPrecision" | "fractionalPrecision"
>;

const FIELD_ORDER: readonly IntervalField[] = ["YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND"];

const FIELD_MICROS: Record<"DAY" | "HOUR" | "MINUTE" | "SECOND", bigint> = {
  DAY: MICROS_PER_DAY_BIG,
  HOUR: MICROS_PER_HOUR_BIG,
  MINUTE: MICROS_PER_MINUTE_BIG,
  SECOND: MICROS_PER_SECOND_BIG,
};

/** 선행 필드가 아닌 필드가 가질 수 있는 최대값. */
const FIELD_LIMIT: Record<"MONTH" | "HOUR" | "MINUTE" | "SECOND", number> = {
  MONTH: 11,
  HOUR: 23,
  MINUTE: 59,
  SECOND: 59,
};

type DayTimeField = "DAY" | "HOUR" | "MINUTE" | "SECOND";

export function intervalClassOf(qualifier: Pick<IntervalQualifier, "startField">): IntervalClass {
  return qualifier.startField === "YEAR" || qualifier.startField === "MONTH" ? "YEAR_MONTH" : "DAY_TIME";
}

function dayTimeFields(qualifier: Pick<IntervalQualifier, "startField" | "endField">): DayTimeField[] {
  const start = FIELD_ORDER.indexOf(qualifier.startField);
  const end = FIELD_ORDER.indexOf(qualifier.endField);
  return FIELD_ORDER.slice(start, end + 1) as DayTimeField[];
}

function absBig(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * INTERVAL 값을 한정자에 맞춘다.
 *  - 종료 필드보다 작은 단위는 0 방향으로 버린다. 소수 초는 지정 자릿수로 반올림한다.
 *  - 선행 필드가 선행 정밀도를 넘으면 22015 이다.
 */
export function conformInterval(value: IntervalValue, qualifier: IntervalQualifier): IntervalValue {
  const limit = 10n ** BigInt(qualifier.leadingPrecision);
  if (intervalClassOf(qualifier) === "YEAR_MONTH") {
    if (value.intervalClass !== "YEAR_MONTH") {
      throw typeMismatch("A day-time interval cannot be used as a year-month interval.");
    }
    let months = value.months;
    if (qualifier.endField === "YEAR") {
      months = Math.trunc(months / 12) * 12;
    }
    const leading = qualifier.startField === "YEAR" ? Math.floor(Math.abs(months) / 12) : Math.abs(months);
    if (BigInt(leading) >= limit) {
      throw intervalOutOfRange(`Interval ${qualifier.startField} field exceeds precision ${qualifier.leadingPrecision}.`);
    }
    return months === value.months ? value : IntervalValue.yearMonth(months);
  }

  if (value.intervalClass !== "DAY_TIME") {
    throw typeMismatch("A year-month interval cannot be used as a day-time interval.");
  }
  let micros = value.micros;
  if (qualifier.endField === "SECOND") {
    const unit = BigInt(fractionUnit(qualifier.fractionalPrecision ?? 6));
    if (unit !== 1n) micros = divideRounded(micros, unit) * unit;
  } else {
    const unit = FIELD_MICROS[qualifier.endField as DayTimeField];
    micros = (micros / unit) * unit;
  }
  const leading = absBig(micros) / FIELD_MICROS[qualifier.startField as DayTimeField];
  if (leading >= limit) {
    throw intervalOutOfRange(`Interval ${qualifier.startField} field exceeds precision ${qualifier.leadingPrecision}.`);
  }
  return micros === value.micros ? value : IntervalValue.dayTime(micros);
}

const dayTimeRegexCache = new Map<string, RegExp>();

function dayTimeRegex(fields: readonly DayTimeField[]): RegExp {
  const key = `${fields[0]}-${fields[fields.length - 1]}`;
  let regex = dayTimeRegexCache.get(key);
  if (regex === undefined) {
    let pattern = "^";
    fields.forEach((field, index) => {
      if (index > 0) pattern += fields[index - 1] === "DAY" ? String.raw`\s+` : ":";
      pattern += String.raw`(\d+)`;
      if (field === "SECOND") pattern += String.raw`(?:\.(\d{1,9}))?`;
    });
    regex = new RegExp(`${pattern}$`);
    dayTimeRegexCache.set(key, regex);
  }
  return regex;
}

/**
 * INTERVAL 문자열을 한정자에 맞추어 해석한다.
 *  - 연-월 계열 : `Y`, `M`, `Y-M`
 *  - 일-시간 계열 : `D`, `H`, `M`, `S[.f]`, `D H`, `D H:M`, `D H:M:S[.f]`, `H:M`, `H:M:S[.f]`, `M:S[.f]`
 * 맨 앞에 부호를 둘 수 있다. 형식이 틀리면 22006, 필드가 범위를 벗어나면 22015 이다.
 */
export function parseIntervalText(text: string, qualifier: IntervalQualifier): IntervalValue {
  const signMatch = /^\s*([+-])?\s*(.*?)\s*$/s.exec(text);
  const body = signMatch?.[2] ?? "";
  const negative = signMatch?.[1] === "-";
  const invalid = (): Error =>
    invalidIntervalFormat(`Invalid interval value: ${quoteForMessage(text)}.`);
  // 선행 필드는 최대 9자리이므로 그보다 훨씬 긴 숫자는 미리 걸러 낸다.
  const leadingNumber = (digits: string): bigint => {
    if (digits.length > 18) {
      throw intervalOutOfRange(`Interval ${qualifier.startField} field exceeds precision ${qualifier.leadingPrecision}.`);
    }
    return BigInt(digits);
  };
  const trailingNumber = (digits: string, field: keyof typeof FIELD_LIMIT): bigint => {
    const value = digits.length > 3 ? Number.POSITIVE_INFINITY : Number(digits);
    if (value > FIELD_LIMIT[field]) {
      throw intervalOutOfRange(`Interval ${field} field out of range (0 to ${FIELD_LIMIT[field]}).`);
    }
    return BigInt(value);
  };

  if (intervalClassOf(qualifier) === "YEAR_MONTH") {
    let months: bigint;
    if (qualifier.startField === qualifier.endField) {
      if (!/^\d+$/.test(body)) throw invalid();
      months = leadingNumber(body) * (qualifier.startField === "YEAR" ? 12n : 1n);
    } else {
      const match = /^(\d+)-(\d+)$/.exec(body);
      if (match === null) throw invalid();
      months = leadingNumber(match[1] as string) * 12n + trailingNumber(match[2] as string, "MONTH");
    }
    if (months > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw intervalOutOfRange(`Interval ${qualifier.startField} field exceeds precision ${qualifier.leadingPrecision}.`);
    }
    const value = Number(months);
    return conformInterval(IntervalValue.yearMonth(negative ? -value : value), qualifier);
  }

  const fields = dayTimeFields(qualifier);
  const match = dayTimeRegex(fields).exec(body);
  if (match === null) throw invalid();
  let micros = 0n;
  fields.forEach((field, index) => {
    const digits = match[index + 1] as string;
    const value = index === 0 ? leadingNumber(digits) : trailingNumber(digits, field as keyof typeof FIELD_LIMIT);
    micros += value * FIELD_MICROS[field];
  });
  if (qualifier.endField === "SECOND") {
    micros += BigInt(fractionToMicros(match[fields.length + 1]));
  }
  return conformInterval(IntervalValue.dayTime(negative ? -micros : micros), qualifier);
}

/** INTERVAL 값을 한정자에 맞는 문자열로 적는다. `parseIntervalText` 가 다시 읽을 수 있는 형태이다. */
export function formatInterval(value: IntervalValue, qualifier: IntervalQualifier): string {
  const sign = value.sign() < 0 ? "-" : "";
  if (value.intervalClass === "YEAR_MONTH") {
    const months = Math.abs(value.months);
    if (qualifier.startField === "MONTH") return `${sign}${months}`;
    const years = Math.floor(months / 12);
    return qualifier.endField === "YEAR" ? `${sign}${years}` : `${sign}${years}-${pad(months % 12, 2)}`;
  }

  const fields = dayTimeFields(qualifier);
  let rest = absBig(value.micros);
  let text = sign;
  fields.forEach((field, index) => {
    const unit = FIELD_MICROS[field];
    const amount = rest / unit;
    rest -= amount * unit;
    if (index === 0) {
      text += amount.toString();
    } else {
      text += `${fields[index - 1] === "DAY" ? " " : ":"}${amount.toString().padStart(2, "0")}`;
    }
  });
  const precision = qualifier.fractionalPrecision ?? 0;
  if (qualifier.endField === "SECOND" && precision > 0) {
    text += `.${rest.toString().padStart(6, "0").slice(0, precision)}`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// 연산
// ---------------------------------------------------------------------------

/** 날짜에 개월 수를 더한다. 결과 달에 그 날이 없으면 말일로 맞춘다. */
export function addMonthsToDays(days: number, months: number): number {
  const civil = civilFromDays(days);
  const total = civil.year * 12 + (civil.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  if (year < 1 || year > 9999) {
    throw datetimeOutOfRange("Date out of range (0001-01-01 to 9999-12-31).");
  }
  return daysFromCivil(year, month, Math.min(civil.day, daysInMonth(year, month)));
}

/** 날짜에 일수를 더한다. */
export function addDaysToDate(date: DateValue, days: bigint): DateValue {
  const result = BigInt(date.days) + days;
  if (result < BigInt(MIN_DATE_DAYS) || result > BigInt(MAX_DATE_DAYS)) {
    throw datetimeOutOfRange("Date out of range (0001-01-01 to 9999-12-31).");
  }
  return new DateValue(Number(result));
}

/**
 * 날짜에 기간을 더하거나 뺀다. 일-시간 계열은 일 단위로 떨어지는 값만 받는다.
 * (시각 필드가 있는 기간은 호출자가 TIMESTAMP 로 바꾸어 계산한다)
 */
export function addIntervalToDate(date: DateValue, interval: IntervalValue, sign: 1 | -1): DateValue {
  if (interval.intervalClass === "YEAR_MONTH") {
    return new DateValue(addMonthsToDays(date.days, sign * interval.months));
  }
  if (interval.micros % MICROS_PER_DAY_BIG !== 0n) {
    throw internalError("A day-time interval with time fields cannot be added to a DATE directly.");
  }
  return addDaysToDate(date, BigInt(sign) * (interval.micros / MICROS_PER_DAY_BIG));
}

/**
 * TIMESTAMP 에 기간을 더하거나 뺀다.
 * 연-월 계열은 벽시계 날짜에 적용하고 오프셋은 그대로 둔다. 일-시간 계열은 경과 시간으로 더한다.
 */
export function addIntervalToTimestamp(value: TimestampValue, interval: IntervalValue, sign: 1 | -1): TimestampValue {
  let local: bigint;
  if (interval.intervalClass === "YEAR_MONTH") {
    const { days, microsOfDay } = splitLocalMicros(value.localMicros);
    local = joinLocalMicros(addMonthsToDays(days, sign * interval.months), microsOfDay);
  } else {
    local = value.localMicros + BigInt(sign) * interval.micros;
  }
  checkLocalTimestampRange(local);
  return TimestampValue.fromLocal(local, value.offsetMinutes);
}

/** TIME 에 일-시간 계열 기간을 더하거나 뺀다. 24시를 넘으면 하루를 돌아 다시 센다. */
export function addIntervalToTime(value: TimeValue, interval: IntervalValue, sign: 1 | -1): TimeValue {
  if (interval.intervalClass !== "DAY_TIME") {
    throw typeMismatch("A year-month interval cannot be added to a TIME value.");
  }
  const delta = sign * Number(interval.micros % MICROS_PER_DAY_BIG);
  return TimeValue.fromLocal(floorMod(value.localMicros + delta, MICROS_PER_DAY), value.offsetMinutes);
}

/** 같은 계열의 기간 둘을 더하거나 뺀다. */
export function addIntervals(left: IntervalValue, right: IntervalValue, sign: 1 | -1): IntervalValue {
  if (left.intervalClass !== right.intervalClass) {
    throw typeMismatch("Year-month and day-time intervals cannot be combined.");
  }
  return left.intervalClass === "YEAR_MONTH"
    ? IntervalValue.yearMonth(left.months + sign * right.months)
    : IntervalValue.dayTime(left.micros + BigInt(sign) * right.micros);
}

export function negateInterval(value: IntervalValue): IntervalValue {
  return value.intervalClass === "YEAR_MONTH"
    ? IntervalValue.yearMonth(-value.months)
    : IntervalValue.dayTime(-value.micros);
}

function intervalFromScaled(value: IntervalValue, scaled: bigint): IntervalValue {
  if (value.intervalClass === "DAY_TIME") {
    return IntervalValue.dayTime(scaled);
  }
  if (absBig(scaled) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw intervalOutOfRange("Interval value out of range.");
  }
  return IntervalValue.yearMonth(Number(scaled));
}

function intervalMagnitude(value: IntervalValue): Decimal {
  return Decimal.fromBigInt(value.intervalClass === "YEAR_MONTH" ? BigInt(value.months) : value.micros);
}

/** 기간에 수를 곱한다. 결과는 가장 작은 단위(개월 또는 마이크로초)로 반올림한다. */
export function multiplyInterval(value: IntervalValue, factor: Decimal): IntervalValue {
  return intervalFromScaled(value, intervalMagnitude(value).multiply(factor).toBigInt());
}

/** 기간을 수로 나눈다. 0 으로 나누면 22012 이다. */
export function divideInterval(value: IntervalValue, divisor: Decimal): IntervalValue {
  return intervalFromScaled(value, intervalMagnitude(value).divide(divisor, 0).unscaled);
}

/** 두 TIMESTAMP 의 차이. 타임존 유무가 같은 값끼리만 계산한다. */
export function subtractTimestamps(left: TimestampValue, right: TimestampValue): IntervalValue {
  if ((left.offsetMinutes === null) !== (right.offsetMinutes === null)) {
    throw internalError("Timestamps with and without time zone cannot be subtracted directly.");
  }
  return IntervalValue.dayTime(left.micros - right.micros);
}

/** 두 TIME 의 차이. 타임존 유무가 같은 값끼리만 계산한다. */
export function subtractTimes(left: TimeValue, right: TimeValue): IntervalValue {
  if ((left.offsetMinutes === null) !== (right.offsetMinutes === null)) {
    throw internalError("Times with and without time zone cannot be subtracted directly.");
  }
  return IntervalValue.dayTime(BigInt(left.micros - right.micros));
}
