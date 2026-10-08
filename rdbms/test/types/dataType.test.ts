/**
 * 담당 : 변경된 고정소수 타입 기본값, 별칭, 명시 인자와 범위 검증.
 * 관련 사양 : AGENTS.md 개요 1, 상세 1-1, 13.
 * 구현 단계 : 3단계의 기본값 정책.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DbError, ERROR_CODES } from "../../src/common/errors.js";
import { resolveDataType, resolveExactNumericType } from "../../src/types/dataType.js";

test("DECIMAL, DEC, NUMERIC은 인자 전체 생략 시 (10,3)으로 해석한다", () => {
  for (const name of ["DECIMAL", "DEC", "NUMERIC", "decimal", "numeric", "DeC"]) {
    assert.deepEqual(resolveExactNumericType(name), { name: "DECIMAL", precision: 10, scale: 3 });
  }
});

test("정밀도만 지정하면 소수 자릿수는 0이고 명시한 인자는 보존한다", () => {
  for (const name of ["DECIMAL", "DEC", "NUMERIC"]) {
    assert.deepEqual(resolveExactNumericType(name, 2), { name: "DECIMAL", precision: 2, scale: 0 });
    assert.deepEqual(resolveExactNumericType(name, 12, 4), { name: "DECIMAL", precision: 12, scale: 4 });
    assert.deepEqual(resolveExactNumericType(name, 38, 38), { name: "DECIMAL", precision: 38, scale: 38 });
    assert.deepEqual(resolveExactNumericType(name, 1, 0), { name: "DECIMAL", precision: 1, scale: 0 });
  }
});

test("잘못된 고정소수 인자는 기본값으로 덮지 않고 오류로 처리한다", () => {
  const invalid: [number | undefined, number | undefined][] = [
    [0, 0], [39, 0], [-1, 0], [1.5, 0], [NaN, 0], [Infinity, 0],
    [10, -1], [10, 11], [10, 1.5], [10, NaN], [10, Infinity], [undefined, 2],
  ];
  for (const name of ["DECIMAL", "DEC", "NUMERIC"]) {
    for (const [precision, scale] of invalid) {
      assert.throws(() => resolveExactNumericType(name, precision, scale),
        (error) => error instanceof DbError && error.sqlState === "22023" && error.code === ERROR_CODES.TYPE_PARAMETER_INVALID);
    }
  }
});

test("문자 및 이진 타입 별칭과 길이 기본값을 정규화한다", () => {
  const fixedAliases = ["CHAR", "CHARACTER", "NCHAR", "NATIONAL CHARACTER"];
  for (const alias of fixedAliases) {
    assert.deepEqual(resolveDataType(alias), { kind: "CHAR", name: "CHAR", length: 1 });
  }
  const varyingAliases = ["VARCHAR", "CHARACTER VARYING", "CHAR VARYING", "NVARCHAR", "NATIONAL CHARACTER VARYING"];
  for (const alias of varyingAliases) {
    assert.deepEqual(resolveDataType(alias), { kind: "VARCHAR", name: "VARCHAR", length: 65_535 });
  }
  assert.deepEqual(resolveDataType("BINARY"), { kind: "BINARY", name: "BINARY", length: 1 });
  assert.deepEqual(resolveDataType("BINARY VARYING"), { kind: "VARBINARY", name: "VARBINARY", length: 65_535 });
  assert.deepEqual(resolveDataType(" cHaR  VaRyInG ", 12), { kind: "VARCHAR", name: "VARCHAR", length: 12 });
});

test("문자 및 이진 길이의 경계값을 검증한다", () => {
  assert.deepEqual(resolveDataType("CHAR", 2_000), { kind: "CHAR", name: "CHAR", length: 2_000 });
  assert.deepEqual(resolveDataType("VARCHAR", 65_535), { kind: "VARCHAR", name: "VARCHAR", length: 65_535 });
  assert.deepEqual(resolveDataType("BINARY", 2_000), { kind: "BINARY", name: "BINARY", length: 2_000 });
  assert.deepEqual(resolveDataType("VARBINARY", 65_535), { kind: "VARBINARY", name: "VARBINARY", length: 65_535 });
  for (const [name, length] of [
    ["CHAR", 0], ["CHAR", 2_001], ["VARCHAR", 65_536], ["BINARY", -1], ["BINARY", 2_001],
    ["VARBINARY", 65_536], ["VARCHAR", 1.5], ["CHAR", Number.NaN],
  ] as const) {
    assertInvalidTypeParameter(() => resolveDataType(name, length));
  }
});

test("정수, 고정소수, 부동소수 타입을 정의한다", () => {
  assert.deepEqual(resolveDataType("SMALLINT"), { kind: "INTEGER", name: "SMALLINT", bits: 16 });
  assert.deepEqual(resolveDataType("int"), { kind: "INTEGER", name: "INTEGER", bits: 32 });
  assert.deepEqual(resolveDataType("BIGINT"), { kind: "INTEGER", name: "BIGINT", bits: 64 });
  assert.deepEqual(resolveDataType("NUMERIC"), { kind: "DECIMAL", name: "DECIMAL", precision: 10, scale: 3 });
  assert.deepEqual(resolveDataType("DEC", 7), { kind: "DECIMAL", name: "DECIMAL", precision: 7, scale: 0 });
  assert.deepEqual(resolveDataType("REAL"), { kind: "FLOAT", name: "REAL", bits: 32 });
  assert.deepEqual(resolveDataType("FLOAT"), { kind: "FLOAT", name: "DOUBLE PRECISION", bits: 64 });
  assert.deepEqual(resolveDataType("FLOAT", 24), { kind: "FLOAT", name: "REAL", bits: 32 });
  assert.deepEqual(resolveDataType("FLOAT", 25), { kind: "FLOAT", name: "DOUBLE PRECISION", bits: 64 });
  assert.deepEqual(resolveDataType("FLOAT", 53), { kind: "FLOAT", name: "DOUBLE PRECISION", bits: 64 });
  assert.deepEqual(resolveDataType("BOOLEAN"), { kind: "BOOLEAN", name: "BOOLEAN" });
  assert.deepEqual(resolveDataType("DATE"), { kind: "DATE", name: "DATE" });
});

test("시간 타입의 정밀도 기본값과 타임존 여부를 정의한다", () => {
  assert.deepEqual(resolveDataType("TIME"), {
    kind: "TIME", name: "TIME", fractionalPrecision: 0, withTimeZone: false,
  });
  assert.deepEqual(resolveDataType("TIME WITH TIME ZONE", 6), {
    kind: "TIME", name: "TIME WITH TIME ZONE", fractionalPrecision: 6, withTimeZone: true,
  });
  assert.deepEqual(resolveDataType("TIMESTAMP"), {
    kind: "TIMESTAMP", name: "TIMESTAMP", fractionalPrecision: 6, withTimeZone: false,
  });
  assert.deepEqual(resolveDataType("TIMESTAMP WITH TIME ZONE", 0), {
    kind: "TIMESTAMP", name: "TIMESTAMP WITH TIME ZONE", fractionalPrecision: 0, withTimeZone: true,
  });
  for (const [name, precision] of [
    ["TIME", -1], ["TIME", 7], ["TIMESTAMP", 1.25], ["TIME WITH TIME ZONE", Number.NaN],
  ] as const) {
    assertInvalidTypeParameter(() => resolveDataType(name, precision));
  }
});

test("INTERVAL 한정자와 기본 정밀도를 검증한다", () => {
  assert.deepEqual(resolveDataType("INTERVAL YEAR TO MONTH", 4), {
    kind: "INTERVAL",
    name: "INTERVAL",
    startField: "YEAR",
    endField: "MONTH",
    leadingPrecision: 4,
    fractionalPrecision: null,
  });
  assert.deepEqual(resolveDataType("INTERVAL DAY TO SECOND", 3, 2), {
    kind: "INTERVAL",
    name: "INTERVAL",
    startField: "DAY",
    endField: "SECOND",
    leadingPrecision: 3,
    fractionalPrecision: 2,
  });
  assert.deepEqual(resolveDataType("INTERVAL SECOND"), {
    kind: "INTERVAL",
    name: "INTERVAL",
    startField: "SECOND",
    endField: "SECOND",
    leadingPrecision: 2,
    fractionalPrecision: 6,
  });
  assert.deepEqual(resolveDataType("INTERVAL SECOND", 3), {
    kind: "INTERVAL",
    name: "INTERVAL",
    startField: "SECOND",
    endField: "SECOND",
    leadingPrecision: 2,
    fractionalPrecision: 3,
  });
  for (const [name, parameters] of [
    ["INTERVAL YEAR TO DAY", []],
    ["INTERVAL MONTH TO HOUR", []],
    ["INTERVAL SECOND TO SECOND", []],
    ["INTERVAL DAY TO SECOND", [10]],
    ["INTERVAL YEAR", [0]],
    ["INTERVAL SECOND", [2, 7]],
  ] as const) {
    assertInvalidTypeParameter(() => resolveDataType(name, ...parameters));
  }
});

test("지원하지 않는 타입은 0A000으로 구분한다", () => {
  for (const name of ["CLOB", "BLOB", "JSON", "UNKNOWN_TYPE"]) {
    assert.throws(() => resolveDataType(name), (error) =>
      error instanceof DbError && error.sqlState === "0A000" && error.code === ERROR_CODES.FEATURE_NOT_SUPPORTED);
  }
});

function assertInvalidTypeParameter(operation: () => unknown): void {
  assert.throws(operation, (error) =>
    error instanceof DbError && error.sqlState === "22023" && error.code === ERROR_CODES.TYPE_PARAMETER_INVALID);
}
