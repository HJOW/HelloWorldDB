/**
 * 담당 : 날짜시간과 INTERVAL 의 범위, 문자열 변환, 타임존, 연산.
 * 관련 사양 : AGENTS.md 상세 1-1, 1-2.
 * 구현 단계 : 3단계.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { intervalType } from "../../src/types/dataType.js";
import {
  addDaysToDate,
  addIntervalToDate,
  addIntervalToTime,
  addIntervalToTimestamp,
  addIntervals,
  addMonthsToDays,
  attachTimeZone,
  civilFromDays,
  conformInterval,
  conformTime,
  conformTimestamp,
  currentUtcMicros,
  DateValue,
  dayOfWeek,
  daysFromCivil,
  daysFromFields,
  daysInMonth,
  detachTimeZone,
  divideInterval,
  formatDate,
  formatInterval,
  formatOffset,
  formatTime,
  formatTimestamp,
  IntervalValue,
  isLeapYear,
  MAX_DATE_DAYS,
  MIN_DATE_DAYS,
  multiplyInterval,
  negateInterval,
  parseIntervalText,
  parseOffsetText,
  parseTimestampText,
  parseTimeText,
  resolveTimeZone,
  subtractTimes,
  subtractTimestamps,
  TimestampValue,
  timeOfDayFromFields,
  TimeValue,
} from "../../src/types/datetime.js";
import { Decimal } from "../../src/types/numeric.js";
import { assertSqlState } from "./helpers.js";

const date = (text: string): DateValue => new DateValue(Number(parseTimestampText(text).localMicros / 86_400_000_000n));
const timestamp = (text: string): TimestampValue => {
  const parsed = parseTimestampText(text);
  return TimestampValue.fromLocal(parsed.localMicros, parsed.offsetMinutes);
};
const time = (text: string): TimeValue => {
  const parsed = parseTimeText(text);
  return TimeValue.fromLocal(parsed.localMicros, parsed.offsetMinutes);
};
const DAY_TO_SECOND = intervalType("DAY", "SECOND", 9, 6);
const YEAR_TO_MONTH = intervalType("YEAR", "MONTH", 9);
const dayTime = (text: string): IntervalValue => parseIntervalText(text, DAY_TO_SECOND);
const yearMonth = (text: string): IntervalValue => parseIntervalText(text, YEAR_TO_MONTH);

test("일수와 그레고리력 날짜를 서로 바꾼다", () => {
  assert.equal(daysFromCivil(1970, 1, 1), 0);
  assert.equal(daysFromCivil(1, 1, 1), MIN_DATE_DAYS);
  assert.equal(daysFromCivil(9999, 12, 31), MAX_DATE_DAYS);
  assert.equal(daysFromCivil(2000, 3, 1) - daysFromCivil(2000, 2, 28), 2);
  assert.equal(daysFromCivil(1900, 3, 1) - daysFromCivil(1900, 2, 28), 1);
  assert.deepEqual(civilFromDays(MIN_DATE_DAYS), { year: 1, month: 1, day: 1 });
  assert.deepEqual(civilFromDays(MAX_DATE_DAYS), { year: 9999, month: 12, day: 31 });
  assert.deepEqual(civilFromDays(-1), { year: 1969, month: 12, day: 31 });
  // 전 범위에서 왕복이 맞고 날짜가 하루씩 이어지는지 확인한다.
  let previous = civilFromDays(MIN_DATE_DAYS - 1);
  for (let days = MIN_DATE_DAYS; days <= MAX_DATE_DAYS; days += 1) {
    const civil = civilFromDays(days);
    if (civil.day !== 1) {
      assert.equal(civil.day, previous.day + 1);
      assert.equal(civil.month, previous.month);
    } else {
      assert.equal(previous.day, daysInMonth(previous.year, previous.month));
    }
    if (days % 97 === 0) assert.equal(daysFromCivil(civil.year, civil.month, civil.day), days);
    previous = civil;
  }
});

test("윤년, 월의 일수, 요일을 계산한다", () => {
  assert.equal(isLeapYear(2000), true);
  assert.equal(isLeapYear(1900), false);
  assert.equal(isLeapYear(2024), true);
  assert.equal(isLeapYear(2026), false);
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2026, 4), 30);
  assert.equal(daysInMonth(2026, 12), 31);
  assert.equal(dayOfWeek(0), 4); // 1970-01-01 은 목요일
  assert.equal(dayOfWeek(date("2026-10-09").days), 5); // 금요일
  assert.equal(dayOfWeek(date("0001-01-01").days), 1); // 월요일
});

test("없는 날짜와 범위 밖의 필드는 22008 이다", () => {
  assert.equal(formatDate(daysFromFields(2024, 2, 29)), "2024-02-29");
  for (const [year, month, day] of [
    [2026, 2, 29], [2026, 4, 31], [2026, 13, 1], [2026, 0, 1], [2026, 1, 0], [0, 1, 1], [10000, 1, 1], [1900, 2, 29],
  ] as const) {
    assertSqlState(() => daysFromFields(year, month, day), "22008");
  }
  assert.equal(timeOfDayFromFields(23, 59, 59, 999_999), 86_399_999_999);
  for (const [hour, minute, second] of [[24, 0, 0], [0, 60, 0], [0, 0, 60], [-1, 0, 0]] as const) {
    assertSqlState(() => timeOfDayFromFields(hour, minute, second), "22008");
  }
});

test("날짜와 TIMESTAMP 문자열을 해석하고 ISO 8601 형태로 적는다", () => {
  assert.equal(formatDate(date("2026-10-09").days), "2026-10-09");
  assert.equal(formatDate(date("0001-01-01").days), "0001-01-01");
  assert.equal(formatDate(date("9999-12-31").days), "9999-12-31");
  assert.equal(formatDate(date(" 2026-1-5 ").days), "2026-01-05");
  assert.equal(formatTimestamp(timestamp("2026-10-09 13:05:09.123456"), 6), "2026-10-09 13:05:09.123456");
  assert.equal(formatTimestamp(timestamp("2026-10-09T13:05:09"), 0), "2026-10-09 13:05:09");
  assert.equal(formatTimestamp(timestamp("2026-10-09 13:05"), 3), "2026-10-09 13:05:00.000");
  assert.equal(formatTimestamp(timestamp("2026-10-09"), 0), "2026-10-09 00:00:00");
  assert.equal(formatTimestamp(timestamp("1969-12-31 23:59:59.999999"), 6), "1969-12-31 23:59:59.999999");
  assert.equal(formatTimestamp(timestamp("0001-01-01 00:00:00"), 0), "0001-01-01 00:00:00");
  assert.equal(formatTimestamp(timestamp("9999-12-31 23:59:59.999999"), 6), "9999-12-31 23:59:59.999999");
  // 소수 초 7자리부터는 마이크로초로 반올림하며 다음 날로 넘어갈 수 있다.
  assert.equal(formatTimestamp(timestamp("2026-10-09 23:59:59.9999995"), 6), "2026-10-10 00:00:00.000000");
  assert.equal(formatTimestamp(timestamp("2026-10-09 10:00:00.1234564"), 6), "2026-10-09 10:00:00.123456");
  for (const text of ["", "2026", "2026-10", "26-10-09", "2026/10/09", "2026-10-09 25", "2026-10-09 10:00:00 KST", "abc"]) {
    assertSqlState(() => parseTimestampText(text), "22007");
  }
  for (const text of ["2026-02-30", "2026-13-01", "2026-10-09 24:00:00", "2026-10-09 10:60:00", "0000-01-01",
    "9999-12-31 23:59:59.9999995"]) {
    assertSqlState(() => parseTimestampText(text), "22008");
  }
});

test("TIME 문자열을 해석하고 적는다", () => {
  assert.equal(formatTime(time("13:05:09"), 0), "13:05:09");
  assert.equal(formatTime(time("1:5"), 0), "01:05:00");
  assert.equal(formatTime(time("00:00:00.000001"), 6), "00:00:00.000001");
  assert.equal(formatTime(time("23:59:59.999999"), 6), "23:59:59.999999");
  assert.equal(formatTime(time("13:05:09.5"), 3), "13:05:09.500");
  assert.equal(formatTime(time("13:05:09+09:00"), 0), "13:05:09+09:00");
  assert.equal(formatTime(time("13:05:09 -0530"), 0), "13:05:09-05:30");
  assert.equal(formatTime(time("13:05:09Z"), 0), "13:05:09+00:00");
  for (const text of ["", "13", "13:5:9:1", "1305", "13:05:09 PM"]) {
    assertSqlState(() => parseTimeText(text), "22007");
  }
  for (const text of ["24:00:00", "12:60:00", "12:00:60", "23:59:59.9999995"]) {
    assertSqlState(() => parseTimeText(text), "22008");
  }
});

test("오프셋 표기를 해석하고 적는다", () => {
  assert.equal(parseOffsetText("+09:00"), 540);
  assert.equal(parseOffsetText("-0530"), -330);
  assert.equal(parseOffsetText("+14"), 840);
  assert.equal(parseOffsetText("Z"), 0);
  assert.equal(parseOffsetText("-00:00"), 0);
  assert.equal(parseOffsetText("Asia/Seoul"), null);
  assert.equal(formatOffset(540), "+09:00");
  assert.equal(formatOffset(-330), "-05:30");
  assert.equal(formatOffset(0), "+00:00");
  assertSqlState(() => parseOffsetText("+24:00"), "22009");
  assertSqlState(() => parseOffsetText("+09:60"), "22009");
});

test("WITH TIME ZONE 값은 UTC 기준 시각과 입력 당시의 오프셋을 함께 가진다", () => {
  const seoul = timestamp("2026-10-09 21:00:00+09:00");
  const utc = timestamp("2026-10-09 12:00:00+00:00");
  assert.equal(seoul.micros, utc.micros);
  assert.equal(seoul.offsetMinutes, 540);
  assert.equal(utc.offsetMinutes, 0);
  assert.equal(formatTimestamp(seoul, 0), "2026-10-09 21:00:00+09:00");
  assert.equal(formatTimestamp(utc, 0), "2026-10-09 12:00:00+00:00");
  // TIME 도 UTC 기준으로 비교할 수 있게 가진다. 날짜 경계를 넘어도 되돌릴 수 있어야 한다.
  const early = time("01:00:00+09:00");
  assert.equal(early.micros, -8 * 3_600_000_000);
  assert.equal(early.localMicros, 3_600_000_000);
  assert.equal(formatTime(early, 0), "01:00:00+09:00");
  assert.equal(formatTime(time("23:30:00-05:00"), 0), "23:30:00-05:00");
});

test("타임존 지정을 해석한다", () => {
  assert.equal(resolveTimeZone("+09:00").id, "+09:00");
  assert.equal(resolveTimeZone("-0530").id, "-05:30");
  assert.equal(resolveTimeZone("Z").id, "+00:00");
  assert.equal(resolveTimeZone("Asia/Seoul").id, "Asia/Seoul");
  assert.equal(resolveTimeZone("asia/seoul").id, "Asia/Seoul");
  assert.equal(resolveTimeZone("UTC").offsetAtUtc(0n), 0);
  assert.ok(resolveTimeZone("local").id.length > 0);
  assert.equal(resolveTimeZone("LOCAL"), resolveTimeZone("local"));
  for (const spec of ["", "Nowhere/City", "+25:00", "KST+9"]) {
    assertSqlState(() => resolveTimeZone(spec), "22009");
  }
});

test("지역 이름 타임존은 시기에 따라 오프셋이 달라진다", () => {
  const seoul = resolveTimeZone("Asia/Seoul");
  assert.equal(seoul.offsetAtUtc(timestamp("2026-10-09 00:00:00").micros), 540);
  assert.equal(seoul.offsetAtLocal(timestamp("2026-10-09 00:00:00").micros), 540);
  // 1988년 서울 올림픽 때의 서머타임
  assert.equal(seoul.offsetAtLocal(timestamp("1988-07-01 12:00:00").micros), 600);

  const newYork = resolveTimeZone("America/New_York");
  assert.equal(newYork.offsetAtLocal(timestamp("2026-01-15 12:00:00").micros), -300);
  assert.equal(newYork.offsetAtLocal(timestamp("2026-07-15 12:00:00").micros), -240);
  // 2026-03-08 02:00 에 03:00 으로 건너뛴다. 없는 시각은 전환 이전의 오프셋으로 계산하여 앞으로 민다.
  const skipped = attachTimeZone(timestamp("2026-03-08 02:30:00"), newYork);
  assert.equal(formatTimestamp(skipped, 0), "2026-03-08 03:30:00-04:00");
  // 2026-11-01 02:00 에 01:00 으로 돌아간다. 두 번 나타나는 시각은 먼저 오는 쪽(서머타임)이다.
  const repeated = attachTimeZone(timestamp("2026-11-01 01:30:00"), newYork);
  assert.equal(formatTimestamp(repeated, 0), "2026-11-01 01:30:00-04:00");
  assert.equal(formatTimestamp(attachTimeZone(timestamp("2026-11-01 02:30:00"), newYork), 0), "2026-11-01 02:30:00-05:00");
  // 되돌리면 그 타임존의 벽시계 시각이다.
  assert.equal(formatTimestamp(detachTimeZone(repeated, newYork), 0), "2026-11-01 01:30:00");
  assert.equal(formatTimestamp(detachTimeZone(repeated, seoul), 0), "2026-11-01 14:30:00");
  // 범위의 양 끝에서도 오프셋을 구할 수 있다.
  assert.equal(typeof seoul.offsetAtLocal(timestamp("0001-01-01 00:00:00").micros), "number");
  assert.equal(seoul.offsetAtLocal(timestamp("9999-12-31 23:59:59").micros), 540);
  assert.ok(currentUtcMicros() > timestamp("2026-01-01 00:00:00").micros);
});

test("TIME 과 TIMESTAMP 를 타입에 맞출 때 소수 초를 반올림하고 범위를 확인한다", () => {
  assert.equal(formatTime(conformTime(time("12:00:00.5"), 0, false), 0), "12:00:01");
  assert.equal(formatTime(conformTime(time("12:00:00.4"), 0, false), 0), "12:00:00");
  assert.equal(formatTime(conformTime(time("12:00:00.123456"), 3, false), 3), "12:00:00.123");
  assert.equal(formatTime(conformTime(time("12:00:00.1235+09:00"), 3, true), 3), "12:00:00.124+09:00");
  assertSqlState(() => conformTime(time("23:59:59.5"), 0, false), "22008");
  assert.equal(formatTimestamp(conformTimestamp(timestamp("2026-12-31 23:59:59.5"), 0, false), 0), "2027-01-01 00:00:00");
  // 1970년 이전의 값도 벽시계 기준으로 반올림한다.
  assert.equal(formatTimestamp(conformTimestamp(timestamp("1969-12-31 23:59:58.5"), 0, false), 0), "1969-12-31 23:59:59");
  assert.equal(formatTimestamp(conformTimestamp(timestamp("1969-12-31 23:59:58.4"), 0, false), 0), "1969-12-31 23:59:58");
  assert.equal(
    formatTimestamp(conformTimestamp(timestamp("2026-10-09 10:00:00.9996+09:00"), 3, true), 3),
    "2026-10-09 10:00:01.000+09:00",
  );
  assertSqlState(() => conformTimestamp(timestamp("9999-12-31 23:59:59.5"), 0, false), "22008");
  // 벽시계 날짜가 범위 안이면 UTC 기준 시각이 범위를 벗어나도 된다.
  assert.equal(
    formatTimestamp(conformTimestamp(timestamp("0001-01-01 00:00:00+09:00"), 0, true), 0),
    "0001-01-01 00:00:00+09:00",
  );
  assertSqlState(() => conformTimestamp(new TimestampValue(0n, 24 * 60), 0, true), "22009");
});

test("INTERVAL 문자열을 한정자에 맞추어 해석하고 적는다", () => {
  const cases: [string, ReturnType<typeof intervalType>, string][] = [
    ["5", intervalType("YEAR", "YEAR", 4), "5"],
    ["-14", intervalType("MONTH", "MONTH", 4), "-14"],
    ["1-02", intervalType("YEAR", "MONTH", 2), "1-02"],
    ["+0-11", intervalType("YEAR", "MONTH", 2), "0-11"],
    ["-99-11", intervalType("YEAR", "MONTH", 2), "-99-11"],
    ["3", intervalType("DAY", "DAY", 2), "3"],
    ["25", intervalType("HOUR", "HOUR", 2), "25"],
    ["90", intervalType("MINUTE", "MINUTE", 2), "90"],
    ["5.25", intervalType("SECOND", "SECOND", 2, 2), "5.25"],
    ["3 04", intervalType("DAY", "HOUR", 2), "3 04"],
    ["3 04:05", intervalType("DAY", "MINUTE", 2), "3 04:05"],
    ["3 04:05:06.789", intervalType("DAY", "SECOND", 2, 3), "3 04:05:06.789"],
    ["-3 04:05:06", intervalType("DAY", "SECOND", 2, 0), "-3 04:05:06"],
    ["30:05", intervalType("HOUR", "MINUTE", 2), "30:05"],
    ["30:05:06.5", intervalType("HOUR", "SECOND", 2, 6), "30:05:06.500000"],
    ["45:06.5", intervalType("MINUTE", "SECOND", 2, 1), "45:06.5"],
    ["0 00:00:00", intervalType("DAY", "SECOND", 2, 0), "0 00:00:00"],
  ];
  for (const [text, qualifier, expected] of cases) {
    assert.equal(formatInterval(parseIntervalText(text, qualifier), qualifier), expected, text);
  }
  assert.equal(yearMonth("1-02").months, 14);
  assert.equal(yearMonth("-1-02").months, -14);
  assert.equal(dayTime("1 00:00:00.000001").micros, 86_400_000_001n);
  assert.equal(dayTime("-0 00:00:01").micros, -1_000_000n);
});

test("INTERVAL 의 형식 오류는 22006, 필드 범위와 선행 정밀도 초과는 22015 이다", () => {
  const daySecond = intervalType("DAY", "SECOND", 2, 6);
  for (const text of ["", "abc", "1", "1 02:03", "1-02", "1 02:03:04:05", "1  02 03 04", "1.5 02:03:04"]) {
    assertSqlState(() => parseIntervalText(text, daySecond), "22006");
  }
  assertSqlState(() => parseIntervalText("1.5", intervalType("DAY", "DAY", 2)), "22006");
  assertSqlState(() => parseIntervalText("1 02", intervalType("YEAR", "MONTH", 2)), "22006");
  for (const text of ["1 24:00:00", "1 00:60:00", "1 00:00:60", "100 00:00:00"]) {
    assertSqlState(() => parseIntervalText(text, daySecond), "22015");
  }
  assertSqlState(() => parseIntervalText("1-12", intervalType("YEAR", "MONTH", 2)), "22015");
  assertSqlState(() => parseIntervalText("100", intervalType("YEAR", "YEAR", 2)), "22015");
  assertSqlState(() => parseIntervalText("1000000000", intervalType("DAY", "DAY", 9)), "22015");
  assertSqlState(() => parseIntervalText("9".repeat(40), intervalType("DAY", "DAY", 9)), "22015");
  assert.equal(parseIntervalText("999999999", intervalType("DAY", "DAY", 9)).micros, 999_999_999n * 86_400_000_000n);
  assert.equal(parseIntervalText("999999999-11", intervalType("YEAR", "MONTH", 9)).months, 11_999_999_999);
  assert.equal(parseIntervalText("99", intervalType("YEAR", "YEAR", 2)).months, 1188);
});

test("INTERVAL 을 한정자에 맞출 때 작은 단위는 버리고 소수 초는 반올림한다", () => {
  const value = dayTime("1 02:03:04.567890");
  assert.equal(formatInterval(conformInterval(value, intervalType("DAY", "HOUR", 2)), intervalType("DAY", "HOUR", 2)), "1 02");
  assert.equal(formatInterval(conformInterval(value, intervalType("DAY", "DAY", 2)), intervalType("DAY", "DAY", 2)), "1");
  assert.equal(
    formatInterval(conformInterval(value, intervalType("DAY", "SECOND", 2, 2)), intervalType("DAY", "SECOND", 2, 2)),
    "1 02:03:04.57",
  );
  assert.equal(
    formatInterval(conformInterval(value, intervalType("HOUR", "MINUTE", 2)), intervalType("HOUR", "MINUTE", 2)),
    "26:03",
  );
  // 음수는 0 방향으로 버리고, 소수 초는 0 에서 먼 쪽으로 반올림한다.
  const negative = dayTime("-1 02:03:04.5");
  assert.equal(conformInterval(negative, intervalType("DAY", "DAY", 2)).micros, -86_400_000_000n);
  assert.equal(conformInterval(negative, intervalType("DAY", "SECOND", 2, 0)).micros, -(93_785n * 1_000_000n));
  assert.equal(conformInterval(yearMonth("3-07"), intervalType("YEAR", "YEAR", 2)).months, 36);
  assert.equal(conformInterval(yearMonth("-3-07"), intervalType("YEAR", "YEAR", 2)).months, -36);
  assertSqlState(() => conformInterval(dayTime("100 00:00:00"), intervalType("DAY", "SECOND", 2, 6)), "22015");
  assertSqlState(() => conformInterval(value, intervalType("MINUTE", "SECOND", 2, 6)), "22015");
  assertSqlState(() => conformInterval(yearMonth("1-00"), intervalType("DAY", "DAY", 2)), "42804");
  assertSqlState(() => conformInterval(value, intervalType("YEAR", "MONTH", 2)), "42804");
});

test("날짜에 개월 수를 더하면 없는 날은 말일로 맞춘다", () => {
  const add = (text: string, months: number): string => formatDate(addMonthsToDays(date(text).days, months));
  assert.equal(add("2026-01-31", 1), "2026-02-28");
  assert.equal(add("2024-01-31", 1), "2024-02-29");
  assert.equal(add("2026-03-31", -1), "2026-02-28");
  assert.equal(add("2024-02-29", 12), "2025-02-28");
  assert.equal(add("2024-02-29", 48), "2028-02-29");
  assert.equal(add("2026-11-15", 2), "2027-01-15");
  assert.equal(add("2026-01-15", -13), "2024-12-15");
  assert.equal(add("9999-11-30", 1), "9999-12-30");
  assertSqlState(() => add("9999-12-01", 1), "22008");
  assertSqlState(() => add("0001-01-31", -1), "22008");
});

test("날짜와 TIMESTAMP 에 기간을 더하고 뺀다", () => {
  assert.equal(formatDate(addDaysToDate(date("2026-10-09"), 30n).days), "2026-11-08");
  assert.equal(formatDate(addDaysToDate(date("2026-03-01"), -1n).days), "2026-02-28");
  assertSqlState(() => addDaysToDate(date("9999-12-31"), 1n), "22008");
  assertSqlState(() => addDaysToDate(date("0001-01-01"), -1n), "22008");
  assertSqlState(() => addDaysToDate(date("2026-01-01"), 10n ** 30n), "22008");
  assert.equal(formatDate(addIntervalToDate(date("2026-01-31"), yearMonth("0-01"), 1).days), "2026-02-28");
  assert.equal(formatDate(addIntervalToDate(date("2026-01-31"), yearMonth("1-00"), -1).days), "2025-01-31");
  assert.equal(formatDate(addIntervalToDate(date("2026-10-09"), dayTime("7 00:00:00"), 1).days), "2026-10-16");

  const base = timestamp("2026-10-09 23:30:00.250000");
  assert.equal(formatTimestamp(addIntervalToTimestamp(base, dayTime("0 00:45:00.5"), 1), 6), "2026-10-10 00:15:00.750000");
  assert.equal(formatTimestamp(addIntervalToTimestamp(base, dayTime("1 00:00:00"), -1), 6), "2026-10-08 23:30:00.250000");
  assert.equal(formatTimestamp(addIntervalToTimestamp(base, yearMonth("0-05"), 1), 6), "2027-03-09 23:30:00.250000");
  assertSqlState(() => addIntervalToTimestamp(timestamp("9999-12-31 23:59:59"), dayTime("0 00:00:01"), 1), "22008");
  // WITH TIME ZONE 은 오프셋을 그대로 둔다.
  const zoned = timestamp("2026-01-31 10:00:00+09:00");
  assert.equal(formatTimestamp(addIntervalToTimestamp(zoned, yearMonth("0-01"), 1), 0), "2026-02-28 10:00:00+09:00");
  assert.equal(formatTimestamp(addIntervalToTimestamp(zoned, dayTime("0 20:00:00"), 1), 0), "2026-02-01 06:00:00+09:00");
});

test("TIME 에 기간을 더하면 하루를 돌아 다시 센다", () => {
  assert.equal(formatTime(addIntervalToTime(time("23:00:00"), dayTime("0 02:30:00"), 1), 0), "01:30:00");
  assert.equal(formatTime(addIntervalToTime(time("01:00:00"), dayTime("0 02:30:00"), -1), 0), "22:30:00");
  assert.equal(formatTime(addIntervalToTime(time("10:00:00"), dayTime("3 00:00:00.5"), 1), 1), "10:00:00.5");
  assert.equal(formatTime(addIntervalToTime(time("23:00:00+09:00"), dayTime("0 02:00:00"), 1), 0), "01:00:00+09:00");
  assertSqlState(() => addIntervalToTime(time("10:00:00"), yearMonth("0-01"), 1), "42804");
});

test("기간끼리의 연산과 수와의 곱셈, 나눗셈", () => {
  assert.equal(addIntervals(yearMonth("1-06"), yearMonth("0-08"), 1).months, 26);
  assert.equal(addIntervals(yearMonth("1-06"), yearMonth("0-08"), -1).months, 10);
  assert.equal(addIntervals(dayTime("1 00:00:00"), dayTime("0 12:00:00"), -1).micros, 43_200_000_000n);
  assertSqlState(() => addIntervals(yearMonth("1-00"), dayTime("1 00:00:00"), 1), "42804");
  assert.equal(negateInterval(yearMonth("1-06")).months, -18);
  assert.equal(negateInterval(dayTime("0 00:00:01")).micros, -1_000_000n);
  assert.equal(negateInterval(IntervalValue.yearMonth(0)).sign(), 0);
  assert.equal(multiplyInterval(yearMonth("1-00"), Decimal.parse("1.5")).months, 18);
  assert.equal(multiplyInterval(dayTime("0 01:00:00"), Decimal.parse("-2")).micros, -7_200_000_000n);
  assert.equal(divideInterval(dayTime("1 00:00:00"), Decimal.parse("3")).micros, 28_800_000_000n);
  // 가장 작은 단위에서 반올림한다.
  assert.equal(divideInterval(yearMonth("0-07"), Decimal.parse("2")).months, 4);
  assert.equal(divideInterval(dayTime("0 00:00:00.000001"), Decimal.parse("3")).micros, 0n);
  assertSqlState(() => divideInterval(dayTime("1 00:00:00"), Decimal.parse("0")), "22012");
});

test("두 시각의 차이는 일-시간 계열 기간이다", () => {
  const difference = subtractTimestamps(timestamp("2026-10-09 12:00:00"), timestamp("2026-10-08 10:30:00.5"));
  assert.equal(formatInterval(difference, DAY_TO_SECOND), "1 01:29:59.500000");
  assert.equal(
    subtractTimestamps(timestamp("2026-10-09 12:00:00+09:00"), timestamp("2026-10-09 03:00:00+00:00")).micros,
    0n,
  );
  assert.equal(subtractTimes(time("10:00:00"), time("12:30:00")).micros, -9_000_000_000n);
  assert.equal(subtractTimes(time("10:00:00+09:00"), time("10:00:00+00:00")).micros, -32_400_000_000n);
});
