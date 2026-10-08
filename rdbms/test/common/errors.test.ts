/**
 * 오류 체계 테스트 (1단계).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DbError,
  ERROR_CODES,
  formatDbError,
  internalError,
  isDbError,
  isSqlState,
  StartupError,
  unsupportedFeature,
} from "../../src/common/errors.js";

test("SQLSTATE 는 5자리 영문 대문자와 숫자이다", () => {
  assert.equal(isSqlState("0A000"), true);
  assert.equal(isSqlState("XX000"), true);
  assert.equal(isSqlState("42601"), true);
  assert.equal(isSqlState("0A00"), false);
  assert.equal(isSqlState("0a000"), false);
});

test("지원하지 않는 기능은 SQLSTATE 0A000 이다", () => {
  const error = unsupportedFeature("UNIQUE constraint is not supported.");
  assert.ok(error instanceof DbError);
  assert.ok(isDbError(error));
  assert.equal(error.sqlState, "0A000");
  assert.equal(error.code, ERROR_CODES.FEATURE_NOT_SUPPORTED);
  assert.match(formatDbError(error), /0A000/);
});

test("내부 오류는 SQLSTATE XX000 이다", () => {
  const error = internalError("Unexpected internal state.");
  assert.equal(error.sqlState, "XX000");
  assert.equal(error.code, ERROR_CODES.INTERNAL_ERROR);
});

test("구동 실패는 SQLSTATE 를 가지지 않는다", () => {
  const error = new StartupError("Invalid config value.");
  assert.ok(error instanceof Error);
  assert.equal(isDbError(error), false);
  assert.equal(error.name, "StartupError");
});

test("내부 오류 번호는 바꾸지 않으므로 고정값을 가진다", () => {
  assert.equal(ERROR_CODES.FEATURE_NOT_SUPPORTED, 1);
  assert.equal(ERROR_CODES.INTERNAL_ERROR, 2);
});
