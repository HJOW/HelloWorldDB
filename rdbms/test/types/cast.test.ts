/**
 * 담당 : 암묵적 형변환의 범위, CAST 의 조합별 동작, 문자열 리터럴 해석, 공통 타입.
 * 관련 사양 : AGENTS.md 상세 1-2.
 * 구현 단계 : 3단계.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DbError } from "../../src/common/errors.js";
import {
  assignValue,
  capDecimalType,
  castLiteral,
  castValue,
  commonType,
  isCastSupported,
  isImplicitlyConvertible,
  typeFamily,
} from "../../src/types/cast.js";
import { formatDataType } from "../../src/types/dataType.js";
import { Decimal } from "../../src/types/numeric.js";
import { formatValue } from "../../src/types/value.js";
import type { SqlValue } from "../../src/types/value.js";
import { assertSqlState, context, type, value } from "./helpers.js";

/** from 타입의 값을 to 타입으로 CAST 한 결과를 문자열 표기로 돌려준다. */
function cast(text: string, from: string, to: string, timeZone = "+09:00"): string | null {
  const result = castValue(value(text, from, timeZone), type(from), type(to), context(timeZone));
  return result === null ? null : formatValue(result, type(to));
}

/** 문자열 리터럴을 문맥 타입으로 해석한 결과를 문자열 표기로 돌려준다. */
function literal(text: string, to: string, timeZone = "+09:00"): string | null {
  const result = castLiteral(text, type(to), context(timeZone));
  return result === null ? null : formatValue(result, type(to));
}

const SAMPLES: [string, string][] = [
  ["CHAR(10)", "abc"],
  ["VARCHAR(100)", "abc"],
  ["BINARY(2)", "0A0B"],
  ["VARBINARY(10)", "0A0B"],
  ["SMALLINT", "12"],
  ["INTEGER", "12"],
  ["BIGINT", "12"],
  ["DECIMAL(10,3)", "12.500"],
  ["REAL", "12.5"],
  ["DOUBLE PRECISION", "12.5"],
  ["BOOLEAN", "TRUE"],
  ["DATE", "2026-10-09"],
  ["TIME(3)", "12:34:56.789"],
  ["TIME(3) WITH TIME ZONE", "12:34:56.789+09:00"],
  ["TIMESTAMP(6)", "2026-10-09 12:34:56.789000"],
  ["TIMESTAMP(6) WITH TIME ZONE", "2026-10-09 12:34:56.789000+09:00"],
  ["INTERVAL YEAR", "3"],
  ["INTERVAL YEAR TO MONTH", "3-04"],
  ["INTERVAL DAY", "3"],
  ["INTERVAL DAY TO SECOND(3)", "3 04:05:06.789"],
];

test("타입 계열과 암묵적 형변환의 범위", () => {
  assert.equal(typeFamily(type("NCHAR(3)")), "CHARACTER");
  assert.equal(typeFamily(type("VARBINARY")), "BINARY");
  assert.equal(typeFamily(type("NUMERIC")), "NUMERIC");
  assert.equal(typeFamily(type("FLOAT(10)")), "NUMERIC");
  assert.equal(typeFamily(type("DATE")), "DATETIME");
  assert.equal(typeFamily(type("TIMESTAMP WITH TIME ZONE")), "DATETIME");
  assert.equal(typeFamily(type("TIME")), "TIME");
  assert.equal(typeFamily(type("INTERVAL MONTH")), "INTERVAL_YEAR_MONTH");
  assert.equal(typeFamily(type("INTERVAL HOUR TO SECOND")), "INTERVAL_DAY_TIME");

  const implicit: [string, string, boolean][] = [
    ["SMALLINT", "DECIMAL", true], ["DECIMAL", "DOUBLE PRECISION", true], ["DOUBLE PRECISION", "SMALLINT", true],
    ["CHAR(3)", "VARCHAR", true], ["BINARY(3)", "VARBINARY", true], ["DATE", "TIMESTAMP", true],
    ["TIMESTAMP", "DATE", true], ["TIMESTAMP", "TIMESTAMP WITH TIME ZONE", true], ["TIME", "TIME WITH TIME ZONE", true],
    ["INTERVAL YEAR", "INTERVAL YEAR TO MONTH", true], ["INTERVAL DAY", "INTERVAL HOUR TO SECOND", true],
    ["VARCHAR", "INTEGER", false], ["INTEGER", "VARCHAR", false], ["INTEGER", "BOOLEAN", false],
    ["DATE", "TIME", false], ["TIMESTAMP", "TIME", false], ["VARCHAR", "DATE", false],
    ["INTERVAL YEAR", "INTERVAL DAY", false], ["VARCHAR", "VARBINARY", false], ["INTEGER", "INTERVAL DAY", false],
  ];
  for (const [from, to, expected] of implicit) {
    assert.equal(isImplicitlyConvertible(type(from), type(to)), expected, `${from} -> ${to}`);
  }
});

test("CAST 지원 여부는 실제 변환 동작과 일치한다", () => {
  const supported = new Set<string>();
  for (const [from, sample] of SAMPLES) {
    for (const [to] of SAMPLES) {
      const expected = isCastSupported(type(from), type(to));
      let outcome: "ok" | "unsupported" | "data";
      try {
        castValue(value(sample, from), type(from), type(to), context());
        outcome = "ok";
      } catch (error) {
        assert.ok(error instanceof DbError, String(error));
        outcome = error.sqlState === "42846" ? "unsupported" : "data";
      }
      assert.equal(outcome === "unsupported", !expected, `${from} -> ${to} (${outcome})`);
      if (expected) supported.add(`${typeFamily(type(from))}>${typeFamily(type(to))}:${from}>${to}`);
      // NULL 은 지원하는 조합이면 NULL, 지원하지 않는 조합이면 같은 오류이다.
      if (expected) assert.equal(castValue(null, type(from), type(to), context()), null);
      else assertSqlState(() => castValue(null, type(from), type(to), context()), "42846");
    }
  }
  const check = (from: string, to: string, expected: boolean): void =>
    assert.equal(isCastSupported(type(from), type(to)), expected, `${from} -> ${to}`);
  check("VARCHAR", "VARBINARY", false);
  check("VARBINARY", "VARCHAR", false);
  check("BOOLEAN", "INTEGER", false);
  check("INTEGER", "BOOLEAN", false);
  check("DATE", "TIME", false);
  check("TIME", "DATE", false);
  check("TIMESTAMP", "TIME", true);
  check("TIME", "TIMESTAMP", true);
  check("DATE", "INTEGER", false);
  check("INTEGER", "INTERVAL DAY", true);
  check("INTEGER", "INTERVAL DAY TO HOUR", false);
  check("INTERVAL YEAR TO MONTH", "INTEGER", false);
  check("INTERVAL MONTH", "DECIMAL", true);
  check("DOUBLE PRECISION", "INTERVAL DAY", false);
  check("INTERVAL YEAR", "INTERVAL DAY", false);
});

test("수 계열 사이의 CAST", () => {
  assert.equal(cast("12", "INTEGER", "BIGINT"), "12");
  assert.equal(cast("12", "INTEGER", "DECIMAL(5,2)"), "12.00");
  assert.equal(cast("12", "SMALLINT", "DOUBLE PRECISION"), "12");
  assert.equal(cast("12.345", "DECIMAL(10,3)", "DECIMAL(10,1)"), "12.3");
  assert.equal(cast("12.355", "DECIMAL(10,3)", "DECIMAL(10,2)"), "12.36");
  // 정수로 바꿀 때는 0 에서 먼 쪽으로 반올림한다.
  assert.equal(cast("2.5", "DECIMAL(10,3)", "INTEGER"), "3");
  assert.equal(cast("-2.5", "DECIMAL(10,3)", "INTEGER"), "-3");
  assert.equal(cast("2.5", "DOUBLE PRECISION", "INTEGER"), "3");
  assert.equal(cast("-2.5", "DOUBLE PRECISION", "INTEGER"), "-3");
  assert.equal(cast("2.4999", "DOUBLE PRECISION", "BIGINT"), "2");
  assert.equal(cast("0.1", "DOUBLE PRECISION", "DECIMAL(10,3)"), "0.100");
  assert.equal(cast("1.5", "REAL", "DOUBLE PRECISION"), "1.5");
  assert.equal(cast("0.125", "DECIMAL(10,3)", "REAL"), "0.125");
  // 범위를 넘으면 22003
  assertSqlState(() => cast("40000", "INTEGER", "SMALLINT"), "22003");
  assertSqlState(() => cast("3000000000", "BIGINT", "INTEGER"), "22003");
  assertSqlState(() => cast("1000", "INTEGER", "DECIMAL(5,2)"), "22003");
  assertSqlState(() => cast("1e19", "DOUBLE PRECISION", "BIGINT"), "22003");
  assertSqlState(() => cast("1e300", "DOUBLE PRECISION", "DECIMAL(38,0)"), "22003");
  assertSqlState(() => cast("1e300", "DOUBLE PRECISION", "REAL"), "22003");
  assert.equal(cast("9223372036854775807", "BIGINT", "DECIMAL(19,0)"), "9223372036854775807");
});

test("문자열과 수 사이의 CAST", () => {
  assert.equal(literal(" 42 ", "INTEGER"), "42");
  assert.equal(literal("-42", "SMALLINT"), "-42");
  assert.equal(literal("+7", "BIGINT"), "7");
  assert.equal(literal("12.345", "DECIMAL(10,2)"), "12.35");
  assert.equal(literal("1e2", "DECIMAL(10,2)"), "100.00");
  assert.equal(literal("1.5e3", "DOUBLE PRECISION"), "1500");
  assert.equal(literal(".5", "REAL"), "0.5");
  for (const [text, target] of [
    ["", "INTEGER"], ["abc", "INTEGER"], ["1.5", "INTEGER"], ["1e3", "BIGINT"], ["0x10", "INTEGER"], ["1 2", "INTEGER"],
    ["abc", "DECIMAL"], ["1,5", "DECIMAL"], ["", "DOUBLE PRECISION"], ["Infinity", "DOUBLE PRECISION"],
    ["NaN", "REAL"], ["0x1p3", "DOUBLE PRECISION"],
  ] as const) {
    assertSqlState(() => literal(text, target), "22018");
  }
  assertSqlState(() => literal("99999999999", "INTEGER"), "22003");
  assertSqlState(() => literal("1e400", "DOUBLE PRECISION"), "22003");
  assert.equal(cast("42", "INTEGER", "VARCHAR(10)"), "42");
  assert.equal(cast("42", "INTEGER", "CHAR(5)"), "42   ");
  assert.equal(cast("-1.50", "DECIMAL(5,2)", "VARCHAR"), "-1.50");
  assert.equal(cast("1.5", "DOUBLE PRECISION", "VARCHAR"), "1.5");
  // 문자열로 적은 결과가 길이를 넘으면 잘라내지 않고 22001 이다.
  assertSqlState(() => cast("123456", "INTEGER", "VARCHAR(3)"), "22001");
  assertSqlState(() => cast("123456", "INTEGER", "CHAR(3)"), "22001");
});

test("문자 타입 사이의 CAST 는 채움 공백을 유지하고 넘치는 공백만 뗀다", () => {
  assert.equal(cast("ab", "CHAR(5)", "VARCHAR(10)"), "ab   ");
  assert.equal(cast("ab", "VARCHAR(10)", "CHAR(5)"), "ab   ");
  assert.equal(cast("ab", "CHAR(5)", "CHAR(3)"), "ab ");
  assert.equal(cast("ab", "CHAR(5)", "VARCHAR(2)"), "ab");
  assertSqlState(() => cast("abc", "CHAR(5)", "VARCHAR(2)"), "22001");
  assert.equal(cast("0A0B", "VARBINARY(10)", "BINARY(3)"), "0A0B00");
  assertSqlState(() => cast("0A0B", "VARBINARY(10)", "BINARY(1)"), "22001");
});

test("BOOLEAN 은 문자열하고만 CAST 한다", () => {
  assert.equal(literal("true", "BOOLEAN"), "TRUE");
  assert.equal(literal(" FALSE ", "BOOLEAN"), "FALSE");
  assert.equal(literal("unknown", "BOOLEAN"), null);
  assert.equal(cast("TRUE", "BOOLEAN", "VARCHAR(5)"), "TRUE");
  assert.equal(cast("FALSE", "BOOLEAN", "CHAR(6)"), "FALSE ");
  assertSqlState(() => cast("FALSE", "BOOLEAN", "VARCHAR(4)"), "22001");
  for (const text of ["", "1", "0", "yes", "T", "TRUEE"]) {
    assertSqlState(() => literal(text, "BOOLEAN"), "22018");
  }
});

test("문자열 리터럴을 날짜시간 타입으로 해석한다", () => {
  assert.equal(literal("2026-01-01", "DATE"), "2026-01-01");
  assert.equal(literal("2026-01-01 23:59:59", "DATE"), "2026-01-01");
  assert.equal(literal("2026-01-01", "TIMESTAMP(0)"), "2026-01-01 00:00:00");
  assert.equal(literal("2026-01-01 10:20:30.5", "TIMESTAMP"), "2026-01-01 10:20:30.500000");
  assert.equal(literal("10:20:30", "TIME"), "10:20:30");
  assert.equal(literal("10:20:30.129", "TIME(2)"), "10:20:30.13");
  // 오프셋이 없으면 세션 타임존의 시각이다.
  assert.equal(literal("2026-01-01 10:00:00", "TIMESTAMP(0) WITH TIME ZONE"), "2026-01-01 10:00:00+09:00");
  assert.equal(literal("2026-07-01 10:00:00", "TIMESTAMP(0) WITH TIME ZONE", "America/New_York"), "2026-07-01 10:00:00-04:00");
  assert.equal(literal("2026-01-01 10:00:00", "TIMESTAMP(0) WITH TIME ZONE", "America/New_York"), "2026-01-01 10:00:00-05:00");
  assert.equal(literal("10:00:00", "TIME WITH TIME ZONE"), "10:00:00+09:00");
  // 오프셋이 적혀 있으면 그대로 가진다.
  assert.equal(literal("2026-01-01 10:00:00-05:00", "TIMESTAMP(0) WITH TIME ZONE"), "2026-01-01 10:00:00-05:00");
  assert.equal(literal("10:00:00Z", "TIME WITH TIME ZONE"), "10:00:00+00:00");
  // 타임존 없는 타입으로 받으면 세션 타임존의 벽시계 시각으로 옮긴다.
  assert.equal(literal("2026-01-01 10:00:00+00:00", "TIMESTAMP(0)"), "2026-01-01 19:00:00");
  assert.equal(literal("2026-01-01 20:00:00+00:00", "DATE"), "2026-01-02");
  assert.equal(literal("20:00:00+00:00", "TIME"), "05:00:00");
  for (const [text, target, state] of [
    ["2026-13-01", "DATE", "22008"], ["20260101", "DATE", "22007"], ["abc", "TIMESTAMP", "22007"],
    ["25:00:00", "TIME", "22008"], ["10:00", "DATE", "22007"], ["2026-01-01", "TIME", "22007"],
    ["2026-01-01 10:00:00+24:00", "TIMESTAMP WITH TIME ZONE", "22009"],
  ] as const) {
    assertSqlState(() => literal(text, target), state);
  }
});

test("날짜시간 타입 사이의 CAST", () => {
  assert.equal(cast("2026-10-09", "DATE", "TIMESTAMP(0)"), "2026-10-09 00:00:00");
  assert.equal(cast("2026-10-09", "DATE", "TIMESTAMP(0) WITH TIME ZONE"), "2026-10-09 00:00:00+09:00");
  assert.equal(cast("2026-10-09 23:59:59.9", "TIMESTAMP", "DATE"), "2026-10-09");
  assert.equal(cast("2026-10-09 23:59:59.9", "TIMESTAMP", "TIMESTAMP(0)"), "2026-10-10 00:00:00");
  assert.equal(cast("2026-10-09 12:34:56.789", "TIMESTAMP", "TIME(1)"), "12:34:56.8");
  assert.equal(cast("2026-10-09 12:34:56", "TIMESTAMP", "TIMESTAMP(0) WITH TIME ZONE"), "2026-10-09 12:34:56+09:00");
  // WITH TIME ZONE 에서 타임존 없는 타입으로 : 세션 타임존의 벽시계 시각
  assert.equal(cast("2026-10-09 20:00:00+00:00", "TIMESTAMP WITH TIME ZONE", "TIMESTAMP(0)"), "2026-10-10 05:00:00");
  assert.equal(cast("2026-10-09 20:00:00+00:00", "TIMESTAMP WITH TIME ZONE", "DATE"), "2026-10-10");
  assert.equal(cast("2026-10-09 20:00:00+00:00", "TIMESTAMP WITH TIME ZONE", "TIME"), "05:00:00");
  assert.equal(cast("2026-10-09 20:00:00+00:00", "TIMESTAMP WITH TIME ZONE", "TIME WITH TIME ZONE"), "20:00:00+00:00");
  assert.equal(cast("2026-07-01 12:00:00", "TIMESTAMP", "TIME WITH TIME ZONE", "America/New_York"), "12:00:00-04:00");
  assert.equal(cast("12:00:00", "TIME", "TIME WITH TIME ZONE"), "12:00:00+09:00");
  assert.equal(cast("12:00:00+00:00", "TIME WITH TIME ZONE", "TIME"), "21:00:00");
  assert.equal(cast("20:00:00+00:00", "TIME WITH TIME ZONE", "TIME"), "05:00:00");
  // TIME 을 TIMESTAMP 로 바꾸면 날짜는 세션 타임존의 오늘이다. (문맥의 현재 시각은 2026-10-09 12:00 UTC)
  assert.equal(cast("08:30:00", "TIME", "TIMESTAMP(0)"), "2026-10-09 08:30:00");
  assert.equal(cast("08:30:00", "TIME", "TIMESTAMP(0)", "+14:00"), "2026-10-10 08:30:00");
  assert.equal(cast("08:30:00", "TIME", "TIMESTAMP(0) WITH TIME ZONE"), "2026-10-09 08:30:00+09:00");
  assert.equal(cast("2026-10-09", "DATE", "VARCHAR(10)"), "2026-10-09");
  assert.equal(cast("2026-10-09 12:34:56.789", "TIMESTAMP(3)", "VARCHAR"), "2026-10-09 12:34:56.789");
  assert.equal(cast("12:34:56+09:00", "TIME WITH TIME ZONE", "VARCHAR"), "12:34:56+09:00");
  assertSqlState(() => cast("2026-10-09", "DATE", "VARCHAR(5)"), "22001");
});

test("INTERVAL 의 CAST", () => {
  assert.equal(literal("1-06", "INTERVAL YEAR TO MONTH"), "1-06");
  assert.equal(literal("-3 12:00:00.5", "INTERVAL DAY TO SECOND(1)"), "-3 12:00:00.5");
  assert.equal(cast("1-06", "INTERVAL YEAR TO MONTH", "INTERVAL MONTH"), "18");
  assert.equal(cast("1-06", "INTERVAL YEAR TO MONTH", "INTERVAL YEAR"), "1");
  assert.equal(cast("1 12:30:00", "INTERVAL DAY TO SECOND", "INTERVAL HOUR(3) TO MINUTE"), "36:30");
  assert.equal(cast("1 12:30:00", "INTERVAL DAY TO SECOND", "VARCHAR"), "1 12:30:00.000000");
  assertSqlState(() => cast("5 00:00:00", "INTERVAL DAY TO SECOND", "INTERVAL HOUR TO MINUTE"), "22015");
  assertSqlState(() => literal("1-06", "INTERVAL DAY"), "22006");
  // 정확한 수와 단일 필드 INTERVAL
  assert.equal(cast("5", "INTEGER", "INTERVAL DAY"), "5");
  assert.equal(cast("5", "INTEGER", "INTERVAL YEAR"), "5");
  assert.equal(cast("1.5", "DECIMAL(5,1)", "INTERVAL SECOND(3)"), "1.500");
  assert.equal(cast("1.5", "DECIMAL(5,1)", "INTERVAL HOUR"), "1");
  assert.equal(cast("90", "INTERVAL MINUTE", "INTEGER"), "90");
  assert.equal(cast("3", "INTERVAL YEAR", "SMALLINT"), "3");
  assert.equal(cast("1.25", "INTERVAL SECOND(2)", "DECIMAL(6,2)"), "1.25");
  assert.equal(cast("1.5", "INTERVAL SECOND(1)", "INTEGER"), "2");
  assertSqlState(() => cast("500", "INTEGER", "INTERVAL DAY"), "22015");
});

test("이진 타입은 16진 문자열 리터럴로 받는다", () => {
  assert.equal(literal("0a0B", "VARBINARY(4)"), "0A0B");
  assert.equal(literal("FF", "BINARY(2)"), "FF00");
  assert.equal(literal("", "VARBINARY(4)"), "");
  assertSqlState(() => literal("0A0", "VARBINARY(4)"), "22018");
  assertSqlState(() => literal("0A0B0C", "VARBINARY(2)"), "22001");
  assert.equal(castLiteral(null, type("VARBINARY"), context()), null);
  assert.equal(castLiteral(null, type("INTEGER"), context()), null);
});

test("암묵적 대입은 같은 계열에서만 되고 범위는 실행 때 확인한다", () => {
  const assign = (text: string, from: string, to: string): string | null => {
    const result = assignValue(value(text, from), type(from), type(to), context());
    return result === null ? null : formatValue(result, type(to));
  };
  assert.equal(assign("7", "SMALLINT", "DECIMAL(5,2)"), "7.00");
  assert.equal(assign("7.6", "DECIMAL(5,1)", "INTEGER"), "8");
  assert.equal(assign("2026-10-09 10:00:00", "TIMESTAMP", "DATE"), "2026-10-09");
  assert.equal(assign("ab", "VARCHAR(10)", "CHAR(4)"), "ab  ");
  assertSqlState(() => assign("70000", "INTEGER", "SMALLINT"), "22003");
  assertSqlState(() => assign("abcdef", "VARCHAR(10)", "CHAR(4)"), "22001");
  assertSqlState(() => assign("12", "VARCHAR(10)", "INTEGER"), "42804");
  assertSqlState(() => assign("12", "INTEGER", "VARCHAR(10)"), "42804");
  assertSqlState(() => assign("TRUE", "BOOLEAN", "INTEGER"), "42804");
  assertSqlState(() => assign("2026-10-09", "DATE", "TIME"), "42804");
  assert.equal(assignValue(null, type("INTEGER"), type("BIGINT"), context()), null);
  assertSqlState(() => assignValue(null, type("INTEGER"), type("VARCHAR"), context()), "42804");
});

test("공통 타입은 같은 계열 안에서 더 넓은 쪽으로 정한다", () => {
  const common = (left: string, right: string): string | null => {
    const result = commonType(type(left), type(right));
    const mirrored = commonType(type(right), type(left));
    assert.deepEqual(result, mirrored, `${left} / ${right}`);
    return result === null ? null : formatDataType(result);
  };
  assert.equal(common("CHAR(3)", "CHAR(5)"), "CHAR(5)");
  assert.equal(common("CHAR(3)", "VARCHAR(2)"), "VARCHAR(3)");
  assert.equal(common("VARCHAR(10)", "VARCHAR(20)"), "VARCHAR(20)");
  assert.equal(common("BINARY(3)", "VARBINARY(8)"), "VARBINARY(8)");
  assert.equal(common("SMALLINT", "INTEGER"), "INTEGER");
  assert.equal(common("INTEGER", "BIGINT"), "BIGINT");
  assert.equal(common("INTEGER", "DECIMAL(5,2)"), "DECIMAL(12,2)");
  assert.equal(common("BIGINT", "DECIMAL(5,2)"), "DECIMAL(21,2)");
  assert.equal(common("DECIMAL(10,3)", "DECIMAL(8,6)"), "DECIMAL(13,6)");
  assert.equal(common("DECIMAL(38,0)", "DECIMAL(38,10)"), "DECIMAL(38,6)");
  assert.equal(common("REAL", "REAL"), "REAL");
  assert.equal(common("REAL", "INTEGER"), "DOUBLE PRECISION");
  assert.equal(common("DECIMAL", "DOUBLE PRECISION"), "DOUBLE PRECISION");
  assert.equal(common("BOOLEAN", "BOOLEAN"), "BOOLEAN");
  assert.equal(common("DATE", "DATE"), "DATE");
  assert.equal(common("DATE", "TIMESTAMP(3)"), "TIMESTAMP(3)");
  assert.equal(common("TIMESTAMP(3)", "TIMESTAMP(6) WITH TIME ZONE"), "TIMESTAMP(6) WITH TIME ZONE");
  assert.equal(common("DATE", "TIMESTAMP(0) WITH TIME ZONE"), "TIMESTAMP(0) WITH TIME ZONE");
  assert.equal(common("TIME(2)", "TIME(4) WITH TIME ZONE"), "TIME(4) WITH TIME ZONE");
  assert.equal(common("INTERVAL YEAR", "INTERVAL MONTH"), "INTERVAL YEAR(9) TO MONTH");
  assert.equal(common("INTERVAL DAY(3)", "INTERVAL DAY(5) TO HOUR"), "INTERVAL DAY(5) TO HOUR");
  assert.equal(common("INTERVAL HOUR", "INTERVAL MINUTE TO SECOND(3)"), "INTERVAL HOUR(9) TO SECOND(3)");
  for (const [left, right] of [
    ["VARCHAR", "INTEGER"], ["DATE", "TIME"], ["BOOLEAN", "INTEGER"], ["INTERVAL YEAR", "INTERVAL DAY"],
    ["VARCHAR", "VARBINARY"], ["TIMESTAMP", "VARCHAR"],
  ] as const) {
    assert.equal(common(left, right), null);
  }
  assert.deepEqual(capDecimalType(40, 2), type("DECIMAL(38,2)"));
  assert.deepEqual(capDecimalType(50, 20), type("DECIMAL(38,8)"));
  assert.deepEqual(capDecimalType(0, 0), type("DECIMAL(1,0)"));
});

test("문맥이 요구하는 타입으로 해석한 리터럴은 그 타입의 값과 비교할 수 있다", () => {
  // 상세 1-2 의 예 : WHERE REG_DATE = '2026-01-01'
  const column = value("2026-01-01", "DATE") as SqlValue;
  const fromLiteral = castLiteral("2026-01-01", type("DATE"), context());
  assert.deepEqual(fromLiteral, column);
  assert.ok(castLiteral("12.50", type("DECIMAL(10,3)"), context()) instanceof Decimal);
});
