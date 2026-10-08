/**
 * 담당 : 저장 계층의 오류 생성과 API 인자 검증.
 * 관련 사양 : AGENTS.md 상세 0, 3. docs/storage-v1.md 오류 목록.
 * 구현 단계 : 2단계.
 */
import { DbError, ERROR_CODES } from "../common/errors.js";

export function storageIO(message: string, cause?: unknown): DbError {
  return new DbError("58030", ERROR_CODES.STORAGE_IO, message, { cause });
}
export function corrupt(message: string): DbError {
  return new DbError("XX001", ERROR_CODES.STORAGE_CORRUPT, message);
}
export function argument(message: string): DbError {
  return new DbError("22023", ERROR_CODES.STORAGE_ARGUMENT, message);
}
export function conflict(): DbError {
  return new DbError("40001", ERROR_CODES.STORAGE_CONFLICT, "Storage batch conflicts with a committed batch.");
}
export function duplicate(): DbError {
  return new DbError("23505", ERROR_CODES.DUPLICATE_KEY, "Duplicate index key.");
}
export function uint(value: number, max = 0xffffffff): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw argument("Invalid unsigned integer.");
}
