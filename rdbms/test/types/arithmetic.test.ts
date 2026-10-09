/**
 * 담당 : 사칙연산, 단항 `-`, 연결 `||` 의 결과 타입과 계산. 오버플로, 0 으로 나누기, NULL 전파.
 * 관련 사양 : AGENTS.md 상세 1-2, 1-4.
 * 구현 단계 : 3단계.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bindArithmetic, bindConcat, bindNegate, evaluateArithmetic } from "../../src/types/arithmetic.js";
import type { ArithmeticOperator } from "../../src/types/arithmetic.js";
import { formatDataType } from "../../src/types/dataType.js";
import { formatValue } from "../../src/types/value.js";
import { assertSqlState, context, type, value } from "./helpers.js";

/** `값:타입` 두 개와 연산자로 계산하여 `결과 :: 결과 타입` 으로 돌려준다. */
function calc(left: [string | null, string], operator: ArithmeticOperator, right: [string | null, string], timeZone = "+09:00"): string {
  const operation = bindArithmetic(operator, type(left[1]), type(right[1]));
  const result = operation.evaluate(
    value(left[0], left[1], timeZone),
    value(right[0], right[1], timeZone),
    context(timeZone),
  );
  const text = result === null ? "NULL" : formatValue(result, operation.resultType);
  return `${text} :: ${formatDataType(operation.resultType)}`;
}

test("정수 연산의 결과는 넓은 쪽 타입이며 적어도 INTEGER 이다", () => {
  assert.equal(calc(["1", "INTEGER"], "+", ["1", "INTEGER"]), "2 :: INTEGER");
  assert.equal(calc(["30000", "SMALLINT"], "+", ["30000", "SMALLINT"]), "60000 :: INTEGER");
  assert.equal(calc(["5", "SMALLINT"], "*", ["3", "BIGINT"]), "15 :: BIGINT");
  assert.equal(calc(["5", "INTEGER"], "-", ["8", "INTEGER"]), "-3 :: INTEGER");
  assert.equal(calc(["2147483647", "INTEGER"], "+", ["1", "BIGINT"]), "2147483648 :: BIGINT");
  assertSqlState(() => calc(["2147483647", "INTEGER"], "+", ["1", "INTEGER"]), "22003");
  assertSqlState(() => calc(["-2147483648", "INTEGER"], "-", ["1", "SMALLINT"]), "22003");
  assertSqlState(() => calc(["65536", "INTEGER"], "*", ["65536", "INTEGER"]), "22003");
  assertSqlState(() => calc(["9223372036854775807", "BIGINT"], "+", ["1", "BIGINT"]), "22003");
  assertSqlState(() => calc(["-9223372036854775808", "BIGINT"], "/", ["-1", "BIGINT"]), "22003");
});

test("정수끼리의 나눗셈은 0 방향으로 버린 정수이다", () => {
  assert.equal(calc(["7", "INTEGER"], "/", ["2", "INTEGER"]), "3 :: INTEGER");
  assert.equal(calc(["-7", "INTEGER"], "/", ["2", "INTEGER"]), "-3 :: INTEGER");
  assert.equal(calc(["7", "INTEGER"], "/", ["-2", "INTEGER"]), "-3 :: INTEGER");
  assert.equal(calc(["1", "SMALLINT"], "/", ["3", "SMALLINT"]), "0 :: INTEGER");
  assert.equal(calc(["6", "BIGINT"], "/", ["3", "INTEGER"]), "2 :: BIGINT");
});

test("0 으로 나누면 타입과 무관하게 22012 이다", () => {
  assertSqlState(() => calc(["1", "INTEGER"], "/", ["0", "INTEGER"]), "22012");
  assertSqlState(() => calc(["1", "BIGINT"], "/", ["0", "SMALLINT"]), "22012");
  assertSqlState(() => calc(["1.5", "DECIMAL(5,2)"], "/", ["0", "DECIMAL(5,2)"]), "22012");
  assertSqlState(() => calc(["1", "INTEGER"], "/", ["0.000", "DECIMAL"]), "22012");
  assertSqlState(() => calc(["1.5", "DOUBLE PRECISION"], "/", ["0", "DOUBLE PRECISION"]), "22012");
  assertSqlState(() => calc(["0", "REAL"], "/", ["0", "INTEGER"]), "22012");
  assertSqlState(() => calc(["1", "INTERVAL DAY"], "/", ["0", "INTEGER"]), "22012");
});

test("NUMERIC 연산은 10진으로 정확하고 결과 타입의 자릿수를 따른다", () => {
  assert.equal(calc(["0.1", "DECIMAL(3,1)"], "+", ["0.2", "DECIMAL(3,1)"]), "0.3 :: DECIMAL(4,1)");
  assert.equal(calc(["1.10", "DECIMAL(5,2)"], "-", ["2.205", "DECIMAL(6,3)"]), "-1.105 :: DECIMAL(7,3)");
  assert.equal(calc(["1.5", "DECIMAL(3,1)"], "*", ["2.25", "DECIMAL(4,2)"]), "3.375 :: DECIMAL(8,3)");
  assert.equal(calc(["1", "DECIMAL(10,3)"], "/", ["3", "DECIMAL(10,3)"]), "0.33333333333333 :: DECIMAL(24,14)");
  assert.equal(calc(["2", "DECIMAL(5,0)"], "/", ["3", "DECIMAL(5,0)"]), "0.666667 :: DECIMAL(11,6)");
  // 정수와 섞이면 정수를 같은 범위의 NUMERIC 으로 본다.
  assert.equal(calc(["7", "INTEGER"], "/", ["2", "DECIMAL(2,1)"]), "3.500000 :: DECIMAL(17,6)");
  assert.equal(calc(["1", "INTEGER"], "+", ["0.5", "DECIMAL(2,1)"]), "1.5 :: DECIMAL(12,1)");
  assert.equal(calc(["2", "BIGINT"], "*", ["1.5", "DECIMAL(2,1)"]), "3.0 :: DECIMAL(22,1)");
  // 부동소수라면 틀어지는 계산
  assert.equal(calc(["1.15", "DECIMAL(5,2)"], "*", ["100", "DECIMAL(3,0)"]), "115.00 :: DECIMAL(9,2)");
});

test("NUMERIC 결과가 38자리를 넘으면 소수 자릿수를 줄이고, 정수부가 넘치면 22003 이다", () => {
  const max = "9".repeat(38);
  assert.equal(calc([max, "DECIMAL(38,0)"], "-", ["1", "DECIMAL(38,0)"]), `${"9".repeat(37)}8 :: DECIMAL(38,0)`);
  assertSqlState(() => calc([max, "DECIMAL(38,0)"], "+", ["1", "DECIMAL(38,0)"]), "22003");
  assertSqlState(() => calc([max, "DECIMAL(38,0)"], "*", ["2", "DECIMAL(38,0)"]), "22003");
  // 정수부 21자리를 지키고 남는 17자리를 소수부에 쓴다.
  assert.equal(
    calc(["1.0000000001", "DECIMAL(20,10)"], "*", ["1.0000000001", "DECIMAL(20,10)"]),
    "1.00000000020000000 :: DECIMAL(38,17)",
  );
  // 정수부만으로 38자리를 넘길 수 있으면 소수 자릿수는 6 까지만 줄인다.
  assert.equal(
    calc(["1.0000005", "DECIMAL(30,10)"], "*", ["1", "DECIMAL(30,10)"]),
    "1.000001 :: DECIMAL(38,6)",
  );
  assert.equal(calc(["1", "DECIMAL(38,10)"], "/", ["3", "DECIMAL(38,10)"]), "0.333333 :: DECIMAL(38,6)");
});

test("부동소수가 섞이면 부동소수로 계산하고 유한하지 않은 결과는 22003 이다", () => {
  assert.equal(calc(["1.5", "DOUBLE PRECISION"], "+", ["2", "INTEGER"]), "3.5 :: DOUBLE PRECISION");
  assert.equal(calc(["1.5", "REAL"], "*", ["2.5", "REAL"]), "3.75 :: REAL");
  assert.equal(calc(["1.5", "REAL"], "*", ["2", "INTEGER"]), "3 :: DOUBLE PRECISION");
  assert.equal(calc(["0.5", "DECIMAL(2,1)"], "-", ["0.25", "DOUBLE PRECISION"]), "0.25 :: DOUBLE PRECISION");
  assert.equal(calc(["7", "INTEGER"], "/", ["2", "DOUBLE PRECISION"]), "3.5 :: DOUBLE PRECISION");
  assertSqlState(() => calc(["1e308", "DOUBLE PRECISION"], "*", ["10", "DOUBLE PRECISION"]), "22003");
  assertSqlState(() => calc(["3e38", "REAL"], "+", ["3e38", "REAL"]), "22003");
});

test("연산에 NULL 이 섞이면 결과는 NULL 이다", () => {
  for (const operator of ["+", "-", "*", "/"] as const) {
    assert.equal(calc([null, "INTEGER"], operator, ["1", "INTEGER"]), "NULL :: INTEGER");
    assert.equal(calc(["1", "DECIMAL(5,2)"], operator, [null, "DOUBLE PRECISION"]), "NULL :: DOUBLE PRECISION");
  }
  // NULL 이면 0 으로 나누는지도 따지지 않는다.
  assert.equal(calc([null, "INTEGER"], "/", ["0", "INTEGER"]), "NULL :: INTEGER");
  assert.equal(calc(["2026-10-09", "DATE"], "+", [null, "INTEGER"]), "NULL :: DATE");
  assert.equal(calc([null, "TIMESTAMP"], "-", ["2026-10-09 00:00:00", "TIMESTAMP"]), "NULL :: INTERVAL DAY(9) TO SECOND(6)");
  assert.equal(
    evaluateArithmetic("+", null, type("INTEGER"), null, type("INTEGER"), context()),
    null,
  );
  assert.equal(bindNegate(type("INTEGER")).evaluate(null), null);
  assert.equal(bindConcat(type("VARCHAR(5)"), type("VARCHAR(5)")).evaluate("a", null, context()), null);
  assert.equal(bindConcat(type("VARCHAR(5)"), type("VARCHAR(5)")).evaluate(null, "b", context()), null);
});

test("날짜와 정수, 날짜끼리의 연산", () => {
  assert.equal(calc(["2026-10-09", "DATE"], "+", ["30", "INTEGER"]), "2026-11-08 :: DATE");
  assert.equal(calc(["30", "SMALLINT"], "+", ["2026-10-09", "DATE"]), "2026-11-08 :: DATE");
  assert.equal(calc(["2026-03-01", "DATE"], "-", ["1", "BIGINT"]), "2026-02-28 :: DATE");
  assert.equal(calc(["2026-10-09", "DATE"], "-", ["2026-01-01", "DATE"]), "281 :: INTEGER");
  assert.equal(calc(["2026-01-01", "DATE"], "-", ["2026-10-09", "DATE"]), "-281 :: INTEGER");
  assert.equal(calc(["9999-12-31", "DATE"], "-", ["0001-01-01", "DATE"]), "3652058 :: INTEGER");
  assertSqlState(() => calc(["9999-12-31", "DATE"], "+", ["1", "INTEGER"]), "22008");
  assertSqlState(() => calc(["0001-01-01", "DATE"], "-", ["1", "INTEGER"]), "22008");
});

test("날짜시간과 INTERVAL 의 연산", () => {
  assert.equal(calc(["2026-01-31", "DATE"], "+", ["1", "INTERVAL MONTH"]), "2026-02-28 :: DATE");
  assert.equal(calc(["1-00", "INTERVAL YEAR TO MONTH"], "+", ["2024-02-29", "DATE"]), "2025-02-28 :: DATE");
  assert.equal(calc(["2026-10-09", "DATE"], "-", ["7", "INTERVAL DAY"]), "2026-10-02 :: DATE");
  // 시각 필드가 있는 기간을 날짜에 더하면 TIMESTAMP 이다.
  assert.equal(calc(["2026-10-09", "DATE"], "+", ["36", "INTERVAL HOUR"]), "2026-10-10 12:00:00 :: TIMESTAMP(0)");
  assert.equal(
    calc(["2026-10-09", "DATE"], "-", ["0 00:00:00.5", "INTERVAL DAY TO SECOND(1)"]),
    "2026-10-08 23:59:59.5 :: TIMESTAMP(1)",
  );
  assert.equal(
    calc(["2026-10-09 23:30:00", "TIMESTAMP(0)"], "+", ["45:30.25", "INTERVAL MINUTE TO SECOND(2)"]),
    "2026-10-10 00:15:30.25 :: TIMESTAMP(2)",
  );
  assert.equal(
    calc(["2026-01-31 10:00:00+09:00", "TIMESTAMP(0) WITH TIME ZONE"], "+", ["1", "INTERVAL MONTH"]),
    "2026-02-28 10:00:00+09:00 :: TIMESTAMP(0) WITH TIME ZONE",
  );
  assert.equal(
    calc(["1", "INTERVAL DAY"], "+", ["2026-10-09 10:00:00", "TIMESTAMP(0)"]),
    "2026-10-10 10:00:00 :: TIMESTAMP(0)",
  );
  assert.equal(calc(["23:00:00", "TIME"], "+", ["90", "INTERVAL MINUTE"]), "00:30:00 :: TIME(0)");
  assert.equal(calc(["00:10:00", "TIME"], "-", ["0.5", "INTERVAL SECOND(1)"]), "00:09:59.5 :: TIME(1)");
  assertSqlState(() => calc(["9999-12-31 23:00:00", "TIMESTAMP(0)"], "+", ["2", "INTERVAL HOUR"]), "22008");
});

test("두 시각의 차이는 INTERVAL 이다", () => {
  assert.equal(
    calc(["2026-10-09 12:00:00", "TIMESTAMP(0)"], "-", ["2026-10-08 10:30:00", "TIMESTAMP(0)"]),
    "1 01:30:00 :: INTERVAL DAY(9) TO SECOND(0)",
  );
  assert.equal(
    calc(["2026-10-08 10:30:00.5", "TIMESTAMP(1)"], "-", ["2026-10-09 12:00:00", "TIMESTAMP(0)"]),
    "-1 01:29:59.5 :: INTERVAL DAY(9) TO SECOND(1)",
  );
  // DATE 와 TIMESTAMP 가 섞이면 DATE 를 그 날의 0시로 본다.
  assert.equal(
    calc(["2026-10-09 06:00:00", "TIMESTAMP(0)"], "-", ["2026-10-08", "DATE"]),
    "1 06:00:00 :: INTERVAL DAY(9) TO SECOND(0)",
  );
  // 타임존 유무가 섞이면 세션 타임존으로 맞춘 뒤 계산한다.
  assert.equal(
    calc(["2026-10-09 12:00:00+00:00", "TIMESTAMP(0) WITH TIME ZONE"], "-", ["2026-10-09 12:00:00", "TIMESTAMP(0)"]),
    "0 09:00:00 :: INTERVAL DAY(9) TO SECOND(0)",
  );
  assert.equal(calc(["12:00:00", "TIME"], "-", ["13:30:00", "TIME"]), "-1:30:00 :: INTERVAL HOUR(9) TO SECOND(0)");
  assert.equal(
    calc(["9999-12-31 00:00:00", "TIMESTAMP(0)"], "-", ["0001-01-01 00:00:00", "TIMESTAMP(0)"]),
    "3652058 00:00:00 :: INTERVAL DAY(9) TO SECOND(0)",
  );
});

test("INTERVAL 끼리의 연산과 수와의 곱셈, 나눗셈", () => {
  assert.equal(calc(["1", "INTERVAL YEAR"], "+", ["6", "INTERVAL MONTH"]), "1-06 :: INTERVAL YEAR(9) TO MONTH");
  assert.equal(calc(["99", "INTERVAL DAY"], "+", ["1", "INTERVAL DAY"]), "100 :: INTERVAL DAY(9)");
  assert.equal(calc(["1", "INTERVAL DAY"], "-", ["36", "INTERVAL HOUR"]), "-0 12 :: INTERVAL DAY(9) TO HOUR");
  assert.equal(calc(["1-06", "INTERVAL YEAR TO MONTH"], "*", ["2", "INTEGER"]), "3-00 :: INTERVAL YEAR(9) TO MONTH");
  assert.equal(calc(["1.5", "DECIMAL(2,1)"], "*", ["2", "INTERVAL HOUR"]), "3 :: INTERVAL HOUR(9)");
  assert.equal(calc(["0.5", "DOUBLE PRECISION"], "*", ["1 00:00:00", "INTERVAL DAY TO SECOND(0)"]), "0 12:00:00 :: INTERVAL DAY(9) TO SECOND(0)");
  assert.equal(calc(["1 00:00:00", "INTERVAL DAY TO SECOND(0)"], "/", ["3", "INTEGER"]), "0 08:00:00 :: INTERVAL DAY(9) TO SECOND(0)");
  // 결과도 같은 한정자이므로 종료 필드보다 작은 단위는 버린다.
  assert.equal(calc(["1", "INTERVAL DAY"], "/", ["2", "INTEGER"]), "0 :: INTERVAL DAY(9)");
  assertSqlState(() => calc(["999999999", "INTERVAL DAY(9)"], "*", ["2", "INTEGER"]), "22015");
});

test("정의되지 않은 연산은 42804 이다", () => {
  const undefinedCases: [string, ArithmeticOperator, string][] = [
    ["VARCHAR", "+", "INTEGER"], ["VARCHAR", "+", "VARCHAR"], ["BOOLEAN", "+", "BOOLEAN"], ["DATE", "+", "DATE"],
    ["DATE", "*", "INTEGER"], ["DATE", "+", "DECIMAL"], ["DATE", "+", "DOUBLE PRECISION"], ["TIMESTAMP", "+", "INTEGER"],
    ["INTEGER", "-", "DATE"], ["INTERVAL DAY", "-", "DATE"], ["TIME", "+", "INTERVAL MONTH"], ["TIME", "-", "DATE"],
    ["INTERVAL YEAR", "+", "INTERVAL DAY"], ["INTERVAL DAY", "*", "INTERVAL DAY"], ["INTEGER", "/", "INTERVAL DAY"],
    ["INTERVAL DAY", "/", "INTERVAL DAY"], ["TIME", "-", "TIMESTAMP"], ["BINARY(1)", "+", "BINARY(1)"],
    ["TIMESTAMP", "*", "INTEGER"], ["DATE", "/", "INTEGER"],
  ];
  for (const [left, operator, right] of undefinedCases) {
    assertSqlState(() => bindArithmetic(operator, type(left), type(right)), "42804");
  }
});

test("단항 - 는 수 계열과 INTERVAL 에 정의된다", () => {
  const negate = (text: string, typeText: string): string => {
    const operation = bindNegate(type(typeText));
    const result = operation.evaluate(value(text, typeText));
    return `${result === null ? "NULL" : formatValue(result, operation.resultType)} :: ${formatDataType(operation.resultType)}`;
  };
  assert.equal(negate("5", "INTEGER"), "-5 :: INTEGER");
  assert.equal(negate("-32768", "SMALLINT"), "32768 :: INTEGER");
  assert.equal(negate("1.50", "DECIMAL(5,2)"), "-1.50 :: DECIMAL(5,2)");
  assert.equal(negate("2.5", "DOUBLE PRECISION"), "-2.5 :: DOUBLE PRECISION");
  assert.equal(negate("0", "DOUBLE PRECISION"), "0 :: DOUBLE PRECISION");
  assert.equal(negate("1-06", "INTERVAL YEAR TO MONTH"), "-1-06 :: INTERVAL YEAR(2) TO MONTH");
  assert.equal(negate("-3", "INTERVAL DAY"), "3 :: INTERVAL DAY(2)");
  assertSqlState(() => negate("-2147483648", "INTEGER"), "22003");
  assertSqlState(() => negate("-9223372036854775808", "BIGINT"), "22003");
  for (const typeText of ["VARCHAR", "BOOLEAN", "DATE", "TIME", "TIMESTAMP", "VARBINARY"]) {
    assertSqlState(() => bindNegate(type(typeText)), "42804");
  }
});

test("연결 연산자 || 는 문자끼리 또는 이진끼리 잇는다", () => {
  const concat = (left: [string, string], right: [string, string]): string => {
    const operation = bindConcat(type(left[1]), type(right[1]));
    const result = operation.evaluate(value(left[0], left[1]), value(right[0], right[1]), context());
    return `${result === null ? "NULL" : formatValue(result, operation.resultType)} :: ${formatDataType(operation.resultType)}`;
  };
  assert.equal(concat(["Hello", "VARCHAR(10)"], [" World", "VARCHAR(10)"]), "Hello World :: VARCHAR(20)");
  assert.equal(concat(["ab", "CHAR(3)"], ["cd", "CHAR(3)"]), "ab cd  :: CHAR(6)");
  assert.equal(concat(["ab", "CHAR(3)"], ["cd", "VARCHAR(3)"]), "ab cd :: VARCHAR(6)");
  assert.equal(concat(["", "VARCHAR(5)"], ["", "VARCHAR(5)"]), " :: VARCHAR(10)");
  assert.equal(concat(["a", "VARCHAR"], ["b", "VARCHAR"]), "ab :: VARCHAR(65535)");
  assert.equal(concat(["0A", "VARBINARY(4)"], ["0B0C", "BINARY(2)"]), "0A0B0C :: VARBINARY(6)");
  assert.equal(concat(["0A", "BINARY(1)"], ["0B", "BINARY(1)"]), "0A0B :: BINARY(2)");
  assert.equal(formatDataType(bindConcat(type("CHAR(1500)"), type("CHAR(1500)")).resultType), "VARCHAR(3000)");
  // 길이의 상한을 넘는 결과는 잘라내지 않고 오류이다.
  const long = bindConcat(type("VARCHAR"), type("VARCHAR"));
  assertSqlState(() => long.evaluate("x".repeat(40_000), "y".repeat(40_000), context()), "22001");
  for (const [left, right] of [["VARCHAR", "INTEGER"], ["INTEGER", "INTEGER"], ["VARCHAR", "VARBINARY"], ["DATE", "VARCHAR"]] as const) {
    assertSqlState(() => bindConcat(type(left), type(right)), "42804");
  }
});
