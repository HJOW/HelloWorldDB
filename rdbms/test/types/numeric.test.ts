/**
 * 담당 : NUMERIC 의 10진 정확 연산, 반올림, 정밀도 경계와 오버플로.
 * 관련 사양 : AGENTS.md 상세 1-1, 1-2.
 * 구현 단계 : 3단계.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Decimal, countDigits, divideRounded, fitDecimal, pow10 } from "../../src/types/numeric.js";
import { assertSqlState } from "./helpers.js";

const d = (text: string): Decimal => Decimal.parse(text);

test("10진수 문자열을 소수 자릿수 그대로 해석하고 다시 적는다", () => {
  for (const text of ["0", "1", "-1", "123.450", "-0.001", "0.10", "99999999999999999999999999999999999999"]) {
    assert.equal(d(text).toString(), text);
  }
  assert.equal(d("  +12.5  ").toString(), "12.5");
  assert.equal(d(".5").toString(), "0.5");
  assert.equal(d("5.").toString(), "5");
  assert.equal(d("-0").toString(), "0");
  assert.equal(d("-0.00").toString(), "0.00");
  assert.equal(d("007.10").toString(), "7.10");
});

test("지수 표기를 정확한 10진수로 해석한다", () => {
  assert.equal(d("1.5e3").toString(), "1500");
  assert.equal(d("1.5E-3").toString(), "0.0015");
  assert.equal(d("12e0").toString(), "12");
  assert.equal(d("-2.50e+1").toString(), "-25.0");
  assert.equal(d("0e999999999").toString(), "0");
  assert.equal(d("1e-5000").isZero(), true);
  assertSqlState(() => d("1e5000"), "22003");
});

test("수가 아닌 문자열은 22018 이다", () => {
  for (const text of ["", " ", "abc", "1.2.3", "1e", "--1", "1 2", "0x10", "Infinity", "NaN", "1,000"]) {
    assertSqlState(() => d(text), "22018");
  }
});

test("덧셈, 뺄셈, 곱셈은 부동소수 오차 없이 정확하다", () => {
  assert.equal(d("0.1").add(d("0.2")).toString(), "0.3");
  assert.equal(d("1.10").add(d("2.205")).toString(), "3.305");
  assert.equal(d("1").subtract(d("0.999")).toString(), "0.001");
  assert.equal(d("-5.5").subtract(d("-5.5")).toString(), "0.0");
  assert.equal(d("1.5").multiply(d("-2.25")).toString(), "-3.375");
  assert.equal(d("99999999999999999999").multiply(d("99999999999999999999")).toString(),
    "9999999999999999999800000000000000000001");
  // 부동소수로는 표현되지 않는 큰 값의 정확성
  assert.equal(d("9007199254740993").add(d("1")).toString(), "9007199254740994");
});

test("나눗셈은 지정한 소수 자릿수에서 0 에서 먼 쪽으로 반올림한다", () => {
  assert.equal(d("1").divide(d("3"), 6).toString(), "0.333333");
  assert.equal(d("2").divide(d("3"), 6).toString(), "0.666667");
  assert.equal(d("-2").divide(d("3"), 6).toString(), "-0.666667");
  assert.equal(d("1").divide(d("8"), 2).toString(), "0.13");
  assert.equal(d("-1").divide(d("8"), 2).toString(), "-0.13");
  assert.equal(d("10.00").divide(d("4"), 0).toString(), "3");
  assert.equal(d("0.000001").divide(d("1000"), 3).toString(), "0.000");
  assert.equal(d("1").divide(d("3"), 4, "DOWN").toString(), "0.3333");
  assertSqlState(() => d("1").divide(d("0.00"), 2), "22012");
});

test("나머지의 부호는 나뉘는 수를 따른다", () => {
  assert.equal(d("7").remainder(d("3")).toString(), "1");
  assert.equal(d("-7").remainder(d("3")).toString(), "-1");
  assert.equal(d("7").remainder(d("-3")).toString(), "1");
  assert.equal(d("7.5").remainder(d("2")).toString(), "1.5");
  assert.equal(d("1.25").remainder(d("0.5")).toString(), "0.25");
  assertSqlState(() => d("1").remainder(d("0")), "22012");
});

test("반올림 방식별로 소수 자릿수를 맞춘다", () => {
  assert.equal(d("2.5").round(0).toString(), "3");
  assert.equal(d("-2.5").round(0).toString(), "-3");
  assert.equal(d("2.4").round(0).toString(), "2");
  assert.equal(d("1.005").round(2).toString(), "1.01");
  assert.equal(d("1.5").round(3).toString(), "1.500");
  assert.equal(d("2.9").round(0, "DOWN").toString(), "2");
  assert.equal(d("-2.9").round(0, "DOWN").toString(), "-2");
  assert.equal(d("-2.1").round(0, "FLOOR").toString(), "-3");
  assert.equal(d("2.1").round(0, "FLOOR").toString(), "2");
  assert.equal(d("2.1").round(0, "CEILING").toString(), "3");
  assert.equal(d("-2.1").round(0, "CEILING").toString(), "-2");
  assert.equal(d("-0.4").round(0).toString(), "0");
  assert.equal(divideRounded(7n, 2n), 4n);
  assert.equal(divideRounded(-7n, 2n), -4n);
  assert.equal(divideRounded(7n, -2n, "DOWN"), -3n);
  assertSqlState(() => divideRounded(1n, 0n), "22012");
});

test("비교는 소수 자릿수가 달라도 값으로 한다", () => {
  assert.equal(d("1.0").compare(d("1.00")), 0);
  assert.equal(d("1.0").equals(d("1")), true);
  assert.equal(d("-1").compare(d("0.5")), -1);
  assert.equal(d("0.51").compare(d("0.5")), 1);
  assert.equal(d("0").sign(), 0);
  assert.equal(d("-0.1").sign(), -1);
  assert.equal(d("-3.2").abs().toString(), "3.2");
  assert.equal(d("3.2").negate().toString(), "-3.2");
});

test("NUMERIC(p,s) 에 맞출 때 소수부는 반올림하고 정수부가 넘치면 22003 이다", () => {
  assert.equal(fitDecimal(d("123.4567"), 10, 3).toString(), "123.457");
  assert.equal(fitDecimal(d("1"), 10, 3).toString(), "1.000");
  assert.equal(fitDecimal(d("9999999.999"), 10, 3).toString(), "9999999.999");
  assert.equal(fitDecimal(d("-9999999.999"), 10, 3).toString(), "-9999999.999");
  assertSqlState(() => fitDecimal(d("10000000"), 10, 3), "22003");
  // 반올림으로 자릿수가 하나 늘어 넘치는 경우
  assertSqlState(() => fitDecimal(d("9999999.9995"), 10, 3), "22003");
  assertSqlState(() => fitDecimal(d("-9999999.9995"), 10, 3), "22003");
  assert.equal(fitDecimal(d("9999999.9994"), 10, 3).toString(), "9999999.999");
  // 소수 자릿수와 정밀도가 같으면 정수부를 가질 수 없다.
  assert.equal(fitDecimal(d("0.994"), 2, 2).toString(), "0.99");
  assertSqlState(() => fitDecimal(d("0.995"), 2, 2), "22003");
  assertSqlState(() => fitDecimal(d("1"), 2, 2), "22003");
});

test("정밀도 38자리의 경계값을 다룬다", () => {
  const max = "9".repeat(38);
  assert.equal(fitDecimal(d(max), 38, 0).toString(), max);
  assert.equal(fitDecimal(d(`-${max}`), 38, 0).toString(), `-${max}`);
  assertSqlState(() => fitDecimal(d(`1${"0".repeat(38)}`), 38, 0), "22003");
  assert.equal(fitDecimal(d(`0.${max}`), 38, 38).toString(), `0.${max}`);
  assertSqlState(() => fitDecimal(d(max).add(Decimal.ONE), 38, 0), "22003");
  assert.equal(d(max).integerDigits(), 38);
  assert.equal(d("0.05").integerDigits(), 0);
  assert.equal(d("0").integerDigits(), 0);
  assert.equal(countDigits(0n), 1);
  assert.equal(countDigits(-1000n), 4);
  assert.equal(pow10(38), 10n ** 38n);
});

test("부동소수와의 변환은 가장 짧은 10진 표기를 거친다", () => {
  assert.equal(Decimal.fromNumber(0.1).toString(), "0.1");
  assert.equal(Decimal.fromNumber(-1.5e-7).toString(), "-0.00000015");
  assert.equal(Decimal.fromNumber(1e21).toString(), "1000000000000000000000");
  assert.equal(Decimal.fromNumber(123456789.125).toString(), "123456789.125");
  assert.equal(Decimal.fromNumber(0).toString(), "0");
  assert.equal(d("0.1").toNumber(), 0.1);
  assert.equal(d("-12345678901234567890").toNumber(), -12345678901234567890);
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assertSqlState(() => Decimal.fromNumber(invalid), "22003");
  }
});

test("정수로 바꿀 때 0 에서 먼 쪽으로 반올림한다", () => {
  assert.equal(d("2.5").toBigInt(), 3n);
  assert.equal(d("-2.5").toBigInt(), -3n);
  assert.equal(d("2.49").toBigInt(), 2n);
  assert.equal(d("-0.5").toBigInt(), -1n);
  assert.equal(d("2.99").toBigInt("DOWN"), 2n);
  assert.equal(d("42").toBigInt(), 42n);
});
