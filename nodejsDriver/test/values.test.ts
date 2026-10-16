/**
 * 값의 변환 시험 (12-4). 서버가 필요 없다.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeRow, decodeValue, encodeParam, encodeParams } from "../src/values.js";
import type { ColumnMeta } from "../src/protocol/messages.js";

function column(typeName: string): ColumnMeta {
  return { name: "C", typeName, declared: typeName };
}

test("결과 값 : 정수는 number, BIGINT 는 bigint (정밀도를 잃지 않는다)", () => {
  assert.equal(decodeValue(42, column("INTEGER")), 42);
  assert.equal(decodeValue(-32768, column("SMALLINT")), -32768);
  assert.equal(decodeValue("9223372036854775807", column("BIGINT")), 9223372036854775807n);
  assert.equal(decodeValue("-9223372036854775808", column("BIGINT")), -9223372036854775808n);
  assert.equal(decodeValue(5, column("BIGINT")), 5n, "숫자로 와도 받아 준다");
  assert.equal(typeof decodeValue("5000000000", column("BIGINT")), "bigint");
});

test("결과 값 : NUMERIC·DECIMAL 은 문자열 (자릿수를 잃지 않는다)", () => {
  assert.equal(decodeValue("1.50", column("DECIMAL")), "1.50");
  assert.equal(decodeValue("12345678901234567890.123456789", column("DECIMAL")), "12345678901234567890.123456789");
});

test("결과 값 : 부동소수는 number, 논리는 boolean, 문자는 string", () => {
  assert.equal(decodeValue(1.5, column("REAL")), 1.5);
  assert.equal(decodeValue(2.25, column("DOUBLE PRECISION")), 2.25);
  assert.equal(decodeValue(true, column("BOOLEAN")), true);
  assert.equal(decodeValue(false, column("BOOLEAN")), false);
  assert.equal(decodeValue("ab   ", column("CHAR")), "ab   ", "CHAR 의 공백 채움은 그대로");
  assert.equal(decodeValue("", column("VARCHAR")), "", "빈 문자열은 NULL 과 다르다");
  assert.equal(decodeValue("한글😀", column("VARCHAR")), "한글😀");
});

test("결과 값 : 이진은 Buffer (16진 문자열에서)", () => {
  const value = decodeValue("0A0B0C0D", column("VARBINARY"));
  assert.ok(Buffer.isBuffer(value));
  assert.deepEqual([...(value as Buffer)], [0x0a, 0x0b, 0x0c, 0x0d]);
  assert.equal((decodeValue("", column("BINARY")) as Buffer).length, 0);
});

test("결과 값 : 날짜시간과 INTERVAL 은 정밀도를 잃지 않는 문자열", () => {
  for (const [typeName, text] of [
    ["DATE", "2026-10-16"],
    ["TIME", "12:34:56.789"],
    ["TIME WITH TIME ZONE", "12:34:56.123+09:00"],
    ["TIMESTAMP", "2026-10-16 12:34:56.123456"],
    ["TIMESTAMP WITH TIME ZONE", "2026-10-16 12:34:56.123+09:00"],
    ["INTERVAL", "3 04:05:06.000000"],
  ] as const) {
    assert.equal(decodeValue(text, column(typeName)), text, typeName);
  }
});

test("결과 값 : NULL 은 어느 타입이든 null, 모르는 타입은 JSON 값 그대로", () => {
  for (const typeName of ["INTEGER", "BIGINT", "VARCHAR", "VARBINARY", "BOOLEAN", "TIMESTAMP"]) assert.equal(decodeValue(null, column(typeName)), null, typeName);
  assert.equal(decodeValue("x", column("SOMETHING NEW")), "x");
  assert.equal(decodeValue(7, column("SOMETHING NEW")), 7);
});

test("행 변환 : 컬럼 순서대로 바꾸고 컬럼 정보가 모자라면 그대로 둔다", () => {
  const columns = [column("INTEGER"), column("BIGINT"), column("VARBINARY")];
  assert.deepEqual(decodeRow([1, "2", "FF"], columns), [1, 2n, Buffer.from([0xff])]);
  assert.deepEqual(decodeRow([1, "x"], [column("INTEGER")]), [1, "x"]);
});

test("파라미터 : null, undefined, 논리, 문자열, 안전한 숫자는 그대로", () => {
  assert.equal(encodeParam(null, 0), null);
  assert.equal(encodeParam(undefined, 0), null);
  assert.equal(encodeParam(true, 0), true);
  assert.equal(encodeParam("a'b", 0), "a'b");
  assert.equal(encodeParam(42, 0), 42);
  assert.equal(encodeParam(-1.5, 0), -1.5);
  assert.equal(encodeParam(Number.MAX_SAFE_INTEGER, 0), Number.MAX_SAFE_INTEGER);
});

test("파라미터 : 안전 정수를 넘는 정수는 문자열로 보낸다 (JSON 숫자는 정밀도를 잃고 서버가 거부한다)", () => {
  assert.equal(encodeParam(2 ** 60, 0), "1152921504606846976");
  assert.equal(encodeParam(-(2 ** 62), 0), "-4611686018427387904");
  assert.equal(encodeParam(9007199254740993n, 0), "9007199254740993");
  assert.equal(encodeParam(-9007199254740993n, 0), "-9007199254740993");
  assert.equal(encodeParam(9223372036854775807n, 0), "9223372036854775807");
  assert.equal(encodeParam(5n, 0), 5, "안전한 bigint 는 숫자");
  assert.equal(encodeParam(BigInt(Number.MAX_SAFE_INTEGER), 0), Number.MAX_SAFE_INTEGER);
});

test("파라미터 : Buffer 와 Uint8Array 는 대문자 16진의 binary", () => {
  assert.deepEqual(encodeParam(Buffer.from([0, 171, 18]), 0), { binary: "00AB12" });
  assert.deepEqual(encodeParam(new Uint8Array([1, 2, 255]), 0), { binary: "0102FF" });
  assert.deepEqual(encodeParam(new Uint8Array(0), 0), { binary: "" });
  // 큰 버퍼의 일부를 가리키는 뷰도 자기 범위만 보낸다.
  const backing = new Uint8Array([9, 9, 1, 2, 9, 9]);
  assert.deepEqual(encodeParam(backing.subarray(2, 4), 0), { binary: "0102" });
});

test("파라미터 : Date 는 UTC 를 가리키는 ISO 8601 문자열 (밀리초 정밀도)", () => {
  assert.equal(encodeParam(new Date(Date.UTC(2026, 9, 16, 12, 34, 56, 789)), 0), "2026-10-16T12:34:56.789Z");
  assert.equal(encodeParam(new Date(0), 0), "1970-01-01T00:00:00.000Z");
});

test("파라미터 : 보낼 수 없는 값은 위치와 함께 예외로 알린다", () => {
  assert.throws(() => encodeParam(Number.NaN, 2), { name: "RangeError", message: /Parameter 3 is not a finite number/ });
  assert.throws(() => encodeParam(Number.POSITIVE_INFINITY, 0), RangeError);
  assert.throws(() => encodeParam(new Date(Number.NaN), 1), { name: "RangeError", message: /Parameter 2 is an invalid Date/ });
  assert.throws(() => encodeParam({} as never, 0), { name: "TypeError", message: /Parameter 1 has an unsupported type/ });
  assert.throws(() => encodeParam(Symbol("x") as never, 0), TypeError);
  assert.throws(() => encodeParam((() => 1) as never, 0), TypeError);
  assert.throws(() => encodeParams([1, "a", [] as never]), { name: "TypeError", message: /Parameter 3/ });
});
