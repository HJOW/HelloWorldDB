/**
 * 담당 : 값을 타입에 맞추기(길이, 범위, 정밀도), 비교와 정렬 규칙, NULL 과 3값 논리, 문자열 표기.
 * 관련 사양 : AGENTS.md 상세 1-1, 1-2.
 * 구현 단계 : 3단계.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Decimal } from "../../src/types/numeric.js";
import {
  codePointLength,
  compareCodePoints,
  compareForSort,
  compareNullable,
  compareValues,
  conformValue,
  formatHex,
  formatValue,
  isNotDistinct,
  isWellFormedString,
  parseHex,
  sliceCodePoints,
  triAnd,
  triNot,
  triOr,
  trimTrailingSpaces,
} from "../../src/types/value.js";
import type { NonNullValue, SqlValue, Tri } from "../../src/types/value.js";
import { assertSqlState, type, value } from "./helpers.js";

const d = (text: string): Decimal => Decimal.parse(text);
/** 타입에 맞춘 뒤 문자열 표기로 확인한다. */
const fit = (input: SqlValue, typeText: string): string | null => {
  const fitted = conformValue(input, type(typeText));
  return fitted === null ? null : formatValue(fitted, type(typeText));
};

test("3값 논리의 AND, OR, NOT", () => {
  const values: Tri[] = [true, false, null];
  const and: Tri[][] = [[true, false, null], [false, false, false], [null, false, null]];
  const or: Tri[][] = [[true, true, true], [true, false, null], [true, null, null]];
  values.forEach((left, i) => {
    values.forEach((right, j) => {
      assert.equal(triAnd(left, right), (and[i] as Tri[])[j]);
      assert.equal(triOr(left, right), (or[i] as Tri[])[j]);
    });
  });
  assert.equal(triNot(true), false);
  assert.equal(triNot(false), true);
  assert.equal(triNot(null), null);
});

test("문자 길이는 바이트가 아니라 코드 포인트로 센다", () => {
  assert.equal(codePointLength(""), 0);
  assert.equal(codePointLength("abc"), 3);
  assert.equal(codePointLength("한글"), 2);
  assert.equal(codePointLength("a😀b"), 3);
  assert.equal(sliceCodePoints("a😀b", 2), "a😀");
  assert.equal(sliceCodePoints("한글", 5), "한글");
  assert.equal(trimTrailingSpaces("ab  "), "ab");
  assert.equal(trimTrailingSpaces("  ab"), "  ab");
  assert.equal(trimTrailingSpaces("   "), "");
  assert.equal(trimTrailingSpaces("ab\t"), "ab\t");
  assert.equal(isWellFormedString("a😀b"), true);
  assert.equal(isWellFormedString("a\ud83d"), false);
  assert.equal(isWellFormedString("\ude00a"), false);
  assert.equal(isWellFormedString("\ud83d😀"), false);
});

test("NULL 은 어떤 타입에 맞추어도 NULL 이다", () => {
  for (const typeText of ["CHAR(3)", "VARCHAR", "BINARY(2)", "INTEGER", "DECIMAL", "REAL", "BOOLEAN", "DATE",
    "TIME", "TIMESTAMP WITH TIME ZONE", "INTERVAL DAY TO SECOND"]) {
    assert.equal(conformValue(null, type(typeText)), null);
  }
});

test("CHAR 는 공백으로 채우고, 길이를 넘으면 22001 이다", () => {
  assert.equal(fit("ab", "CHAR(5)"), "ab   ");
  assert.equal(fit("", "CHAR(2)"), "  ");
  assert.equal(fit("한글", "CHAR(3)"), "한글 ");
  assert.equal(fit("a😀", "CHAR(2)"), "a😀");
  assert.equal(fit("abcde", "CHAR(5)"), "abcde");
  assertSqlState(() => fit("abcdef", "CHAR(5)"), "22001");
  assertSqlState(() => fit("한글입니다", "CHAR(4)"), "22001");
  // 넘는 부분이 모두 공백이면 그 공백만 뗀다.
  assert.equal(fit("ab      ", "CHAR(5)"), "ab   ");
  assertSqlState(() => fit("ab    c", "CHAR(5)"), "22001");
  assert.equal(fit("x".repeat(2000), "CHAR(2000)")?.length, 2000);
  assertSqlState(() => fit("a\ud83d", "CHAR(5)"), "22021");
});

test("VARCHAR 는 길이를 넘으면 잘라내지 않고 22001 이다", () => {
  assert.equal(fit("ab", "VARCHAR(5)"), "ab");
  assert.equal(fit("", "VARCHAR(5)"), "");
  assert.equal(fit("ab ", "VARCHAR(5)"), "ab ");
  assert.equal(fit("가나다라마", "VARCHAR(5)"), "가나다라마");
  assertSqlState(() => fit("가나다라마바", "VARCHAR(5)"), "22001");
  assert.equal(fit("abcde   ", "VARCHAR(5)"), "abcde");
  assert.equal(fit("y".repeat(65_535), "VARCHAR")?.length, 65_535);
  assertSqlState(() => fit("y".repeat(65_536), "VARCHAR"), "22001");
  assertSqlState(() => fit("\udc00", "VARCHAR(5)"), "22021");
});

test("BINARY 는 0x00 으로 채우고, 이진 타입도 길이를 넘으면 22001 이다", () => {
  assert.equal(fit(Buffer.from([0xab]), "BINARY(3)"), "AB0000");
  assert.equal(fit(Buffer.from([1, 2, 3]), "BINARY(3)"), "010203");
  assertSqlState(() => fit(Buffer.from([1, 2, 3, 4]), "BINARY(3)"), "22001");
  assert.equal(fit(Buffer.alloc(0), "VARBINARY(3)"), "");
  assert.equal(fit(Buffer.from([0xff, 0x00]), "VARBINARY(3)"), "FF00");
  assertSqlState(() => fit(Buffer.alloc(4), "VARBINARY(3)"), "22001");
  assert.equal(formatHex(parseHex("0aFf")), "0AFF");
  assert.equal(parseHex("").length, 0);
  assertSqlState(() => parseHex("abc"), "22018");
  assertSqlState(() => parseHex("zz"), "22018");
});

test("정수 타입의 경계값과 오버플로", () => {
  assert.equal(fit(32_767n, "SMALLINT"), "32767");
  assert.equal(fit(-32_768n, "SMALLINT"), "-32768");
  assertSqlState(() => fit(32_768n, "SMALLINT"), "22003");
  assertSqlState(() => fit(-32_769n, "SMALLINT"), "22003");
  assert.equal(fit(2_147_483_647n, "INTEGER"), "2147483647");
  assert.equal(fit(-2_147_483_648n, "INT"), "-2147483648");
  assertSqlState(() => fit(2_147_483_648n, "INTEGER"), "22003");
  assertSqlState(() => fit(-2_147_483_649n, "INTEGER"), "22003");
  assert.equal(fit(9_223_372_036_854_775_807n, "BIGINT"), "9223372036854775807");
  assert.equal(fit(-9_223_372_036_854_775_808n, "BIGINT"), "-9223372036854775808");
  assertSqlState(() => fit(9_223_372_036_854_775_808n, "BIGINT"), "22003");
  assertSqlState(() => fit(-9_223_372_036_854_775_809n, "BIGINT"), "22003");
});

test("NUMERIC 은 소수부를 반올림하고 정수부가 넘치면 22003 이다", () => {
  assert.equal(fit(d("1.2345"), "DECIMAL"), "1.235");
  assert.equal(fit(d("-1.2345"), "NUMERIC(10,3)"), "-1.235");
  assert.equal(fit(d("5"), "DECIMAL(5)"), "5");
  assert.equal(fit(d("5.5"), "DECIMAL(5)"), "6");
  assert.equal(fit(d("9999999.999"), "DECIMAL"), "9999999.999");
  assertSqlState(() => fit(d("10000000"), "DECIMAL"), "22003");
  assertSqlState(() => fit(d("99999.5"), "DECIMAL(5)"), "22003");
});

test("부동소수는 유한한 값만 담고 단정도는 범위를 따로 본다", () => {
  assert.equal(fit(1.5, "DOUBLE PRECISION"), "1.5");
  assert.equal(fit(1.7976931348623157e308, "FLOAT"), "1.7976931348623157e+308");
  assert.equal(fit(0.1, "REAL"), "0.1");
  assert.equal(conformValue(0.1, type("REAL")), Math.fround(0.1));
  assert.equal(fit(3.4028234e38, "REAL"), "3.4028235e+38");
  assertSqlState(() => fit(3.5e38, "REAL"), "22003");
  assertSqlState(() => fit(-3.5e38, "FLOAT(24)"), "22003");
  assert.equal(fit(1e-50, "REAL"), "0");
  assert.equal(Object.is(conformValue(-0, type("DOUBLE PRECISION")), 0), true);
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assertSqlState(() => fit(invalid, "DOUBLE PRECISION"), "22003");
    assertSqlState(() => fit(invalid, "REAL"), "22003");
  }
});

test("날짜시간 값의 범위와 소수 초 자릿수", () => {
  assert.equal(fit(value("0001-01-01", "DATE"), "DATE"), "0001-01-01");
  assert.equal(fit(value("9999-12-31", "DATE"), "DATE"), "9999-12-31");
  assert.equal(fit(value("12:34:56.789", "TIME(6)"), "TIME"), "12:34:57");
  assert.equal(fit(value("12:34:56.789", "TIME(6)"), "TIME(2)"), "12:34:56.79");
  assert.equal(fit(value("2026-10-09 12:34:56.789", "TIMESTAMP"), "TIMESTAMP"), "2026-10-09 12:34:56.789000");
  assert.equal(fit(value("2026-10-09 12:34:56.789", "TIMESTAMP"), "TIMESTAMP(0)"), "2026-10-09 12:34:57");
  assert.equal(
    fit(value("2026-10-09 12:34:56.789+00:00", "TIMESTAMP WITH TIME ZONE"), "TIMESTAMP(1) WITH TIME ZONE"),
    "2026-10-09 12:34:56.8+00:00",
  );
  assert.equal(fit(value("1 02:03:04.56", "INTERVAL DAY TO SECOND"), "INTERVAL DAY TO MINUTE"), "1 02:03");
  assertSqlState(() => fit(value("100", "INTERVAL DAY(3)"), "INTERVAL DAY"), "22015");
});

test("값의 표현이 타입과 어긋나면 내부 오류이다", () => {
  const cases: [NonNullValue, string][] = [
    [1n, "VARCHAR"], ["1", "INTEGER"], [1, "DECIMAL"], [d("1"), "DOUBLE PRECISION"], ["TRUE", "BOOLEAN"],
    ["2026-01-01", "DATE"], [1n, "BINARY(1)"], [true, "TIME"], [1n, "TIMESTAMP"], ["1", "INTERVAL DAY"],
    [value("12:00:00", "TIME") as NonNullValue, "TIME WITH TIME ZONE"],
    [value("2026-01-01 00:00:00+09:00", "TIMESTAMP WITH TIME ZONE") as NonNullValue, "TIMESTAMP"],
  ];
  for (const [input, typeText] of cases) {
    assertSqlState(() => conformValue(input, type(typeText)), "XX000");
    if (typeText !== "TIME WITH TIME ZONE" && typeText !== "TIMESTAMP") {
      assertSqlState(() => formatValue(input, type(typeText)), "XX000");
    }
  }
});

test("문자열은 코드 포인트 순으로 비교하며 대소문자를 구분한다", () => {
  assert.equal(compareValues("a", "b"), -1);
  assert.equal(compareValues("B", "a"), -1);
  assert.equal(compareValues("abc", "abc"), 0);
  assert.equal(compareValues("ab", "abc"), -1);
  assert.equal(compareValues("", "a"), -1);
  assert.equal(compareValues("가", "나"), -1);
  assert.equal(compareValues("z", "가"), -1);
  // U+FF5E(BMP) 는 U+1F600(보충 평면)보다 앞이다. UTF-16 단위로 비교하면 반대가 된다.
  assert.equal(compareValues("～", "😀"), -1);
  assert.equal("～" < "😀", false);
  assert.equal(compareCodePoints("😀", "～"), 1);
  assert.equal(compareCodePoints("😀", "😁"), -1);
  assert.equal(compareCodePoints("a😀", "a퟿"), 1);
  // UTF-8 바이트 순서와 같은지 확인한다.
  const samples = ["", "a", "ab", "\u007f", "\u0080", "߿", "ࠀ", "퟿", "", "￿", "😀", "\u{10ffff}", "a😀", "a￿"];
  for (const left of samples) {
    for (const right of samples) {
      assert.equal(
        compareCodePoints(left, right),
        Math.sign(Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))),
        `${JSON.stringify(left)} vs ${JSON.stringify(right)}`,
      );
    }
  }
});

test("CHAR 끼리는 뒤쪽 공백을 무시하고 비교한다", () => {
  assert.equal(compareValues("ab   ", "ab", { ignoreTrailingSpaces: true }), 0);
  assert.equal(compareValues("ab ", "abc", { ignoreTrailingSpaces: true }), -1);
  assert.equal(compareValues(" ab", "ab", { ignoreTrailingSpaces: true }), -1);
  assert.equal(compareValues("   ", "", { ignoreTrailingSpaces: true }), 0);
  // 기본(VARCHAR)은 공백도 구별한다.
  assert.equal(compareValues("ab ", "ab"), 1);
});

test("수 계열은 정수, 10진수, 부동소수를 섞어 비교한다", () => {
  assert.equal(compareValues(1n, 2n), -1);
  assert.equal(compareValues(-5n, -5n), 0);
  assert.equal(compareValues(1n, d("1.000")), 0);
  assert.equal(compareValues(d("1.001"), 1n), 1);
  assert.equal(compareValues(d("0.1"), 0.1), 0);
  assert.equal(compareValues(2n, 2.5), -1);
  assert.equal(compareValues(-0, 0), 0);
  assert.equal(compareValues(d("12345678901234567890.5"), d("12345678901234567890.4")), 1);
  // 배정도로 구별되지 않는 큰 정수도 정확히 비교한다.
  assert.equal(compareValues(9_007_199_254_740_993n, 9_007_199_254_740_992n), 1);
});

test("그 밖의 타입의 비교", () => {
  assert.equal(compareValues(false, true), -1);
  assert.equal(compareValues(true, true), 0);
  assert.equal(compareValues(Buffer.from([1, 2]), Buffer.from([1, 3])), -1);
  assert.equal(compareValues(Buffer.from([1]), Buffer.from([1, 0])), -1);
  assert.equal(compareValues(Buffer.from([0xff]), Buffer.from([0x7f, 0xff])), 1);
  const v = (text: string, typeText: string): NonNullValue => value(text, typeText) as NonNullValue;
  assert.equal(compareValues(v("2026-10-09", "DATE"), v("2026-10-10", "DATE")), -1);
  assert.equal(compareValues(v("0001-01-01", "DATE"), v("1969-12-31", "DATE")), -1);
  assert.equal(compareValues(v("12:00:00", "TIME"), v("11:59:59.999999", "TIME(6)")), 1);
  assert.equal(compareValues(v("2026-10-09 00:00:00", "TIMESTAMP"), v("2026-10-09 00:00:00.000001", "TIMESTAMP")), -1);
  // WITH TIME ZONE 은 오프셋이 달라도 같은 시각이면 같다.
  assert.equal(compareValues(
    v("2026-10-09 21:00:00+09:00", "TIMESTAMP WITH TIME ZONE"),
    v("2026-10-09 12:00:00+00:00", "TIMESTAMP WITH TIME ZONE"),
  ), 0);
  assert.equal(compareValues(v("10:00:00+09:00", "TIME WITH TIME ZONE"), v("02:00:00+00:00", "TIME WITH TIME ZONE")), -1);
  assert.equal(compareValues(v("1-00", "INTERVAL YEAR TO MONTH"), v("11", "INTERVAL MONTH")), 1);
  assert.equal(compareValues(v("1", "INTERVAL DAY"), v("24", "INTERVAL HOUR")), 0);
  assert.equal(compareValues(v("-1", "INTERVAL DAY"), v("0", "INTERVAL SECOND")), -1);
});

test("계열이 다른 값은 형변환 없이 비교할 수 없다", () => {
  const v = (text: string, typeText: string): NonNullValue => value(text, typeText) as NonNullValue;
  const pairs: [NonNullValue, NonNullValue][] = [
    ["1", 1n], [1n, true], [Buffer.from("a"), "a"],
    [v("2026-10-09", "DATE"), v("2026-10-09 00:00:00", "TIMESTAMP")],
    [v("2026-10-09 00:00:00", "TIMESTAMP"), v("2026-10-09 00:00:00+09:00", "TIMESTAMP WITH TIME ZONE")],
    [v("12:00:00", "TIME"), v("12:00:00+09:00", "TIME WITH TIME ZONE")],
    [v("1", "INTERVAL YEAR"), v("1", "INTERVAL DAY")],
  ];
  for (const [left, right] of pairs) {
    assertSqlState(() => compareValues(left, right), "XX000");
  }
});

test("NULL 과의 비교는 UNKNOWN 이고, 정렬에서는 NULL 이 가장 크다", () => {
  assert.equal(compareNullable(null, 1n), null);
  assert.equal(compareNullable(1n, null), null);
  assert.equal(compareNullable(null, null), null);
  assert.equal(compareNullable(1n, 2n), -1);

  const sort = (values: SqlValue[], options = {}): SqlValue[] =>
    [...values].sort((left, right) => compareForSort(left, right, options));
  assert.deepEqual(sort([3n, null, 1n, 2n, null]), [1n, 2n, 3n, null, null]);
  assert.deepEqual(sort([3n, null, 1n, 2n], { descending: true }), [null, 3n, 2n, 1n]);
  assert.deepEqual(sort([3n, null, 1n, 2n], { nulls: "FIRST" }), [null, 1n, 2n, 3n]);
  assert.deepEqual(sort([3n, null, 1n, 2n], { descending: true, nulls: "LAST" }), [3n, 2n, 1n, null]);
  assert.deepEqual(sort([3n, null, 1n, 2n], { descending: true, nulls: "FIRST" }), [null, 3n, 2n, 1n]);
  assert.deepEqual(sort(["b", null, "a"], { nulls: "LAST" }), ["a", "b", null]);
  assert.deepEqual(sort(["b ", "a  ", "b"], { ignoreTrailingSpaces: true })[0], "a  ");

  // GROUP BY, DISTINCT 에서는 NULL 끼리 같은 값으로 묶는다.
  assert.equal(isNotDistinct(null, null), true);
  assert.equal(isNotDistinct(null, 0n), false);
  assert.equal(isNotDistinct(1n, d("1.0")), true);
  assert.equal(isNotDistinct("a ", "a", { ignoreTrailingSpaces: true }), true);
  assert.equal(isNotDistinct("a ", "a"), false);
});

test("값을 표준 문자열 표기로 적는다", () => {
  assert.equal(formatValue("ab ", type("CHAR(3)")), "ab ");
  assert.equal(formatValue(Buffer.from([0, 255]), type("VARBINARY")), "00FF");
  assert.equal(formatValue(-42n, type("BIGINT")), "-42");
  assert.equal(formatValue(d("1.50"), type("DECIMAL(5,2)")), "1.50");
  assert.equal(formatValue(true, type("BOOLEAN")), "TRUE");
  assert.equal(formatValue(false, type("BOOLEAN")), "FALSE");
  assert.equal(formatValue(1e21, type("DOUBLE PRECISION")), "1e+21");
  assert.equal(formatValue(-2.5, type("DOUBLE PRECISION")), "-2.5");
  assert.equal(formatValue(Math.fround(1.1), type("REAL")), "1.1");
  assert.equal(formatValue(Math.fround(16777216), type("REAL")), "16777216");
  assert.equal(formatValue(Math.fround(1 / 3), type("REAL")), "0.33333334");
});
