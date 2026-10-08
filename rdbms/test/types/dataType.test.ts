/**
 * 담당 : 변경된 고정소수 타입 기본값, 별칭, 명시 인자와 범위 검증.
 * 관련 사양 : AGENTS.md 개요 1, 상세 1-1, 13.
 * 구현 단계 : 3단계의 기본값 정책.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DbError, ERROR_CODES } from "../../src/common/errors.js";
import { resolveExactNumericType } from "../../src/types/dataType.js";

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
