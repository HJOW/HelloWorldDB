/**
 * 타입 시스템의 오류 생성.
 *
 * 담당
 *  - 값의 범위, 형식, 형변환 오류를 SQLSTATE 와 내부 오류 번호에 맞추어 만든다.
 *  - 오류 메시지에 넣는 값은 길이를 제한한다.
 *
 * 관련 사양 : AGENTS.md 상세 0, 1-2
 * 구현 단계 : 3단계
 */

import { DbError, ERROR_CODES } from "../common/errors.js";

/** 오류 메시지에 값을 넣을 때 너무 길면 줄인다. */
export function quoteForMessage(text: string): string {
  const limit = 64;
  const shown = text.length > limit ? `${text.slice(0, limit)}...` : text;
  return `"${shown}"`;
}

export function stringTooLong(message: string): DbError {
  return new DbError("22001", ERROR_CODES.STRING_TOO_LONG, message);
}

export function numericOutOfRange(message: string): DbError {
  return new DbError("22003", ERROR_CODES.NUMERIC_OUT_OF_RANGE, message);
}

export function divisionByZero(): DbError {
  return new DbError("22012", ERROR_CODES.DIVISION_BY_ZERO, "Division by zero.");
}

export function invalidCastValue(message: string): DbError {
  return new DbError("22018", ERROR_CODES.INVALID_CAST_VALUE, message);
}

export function invalidDatetimeFormat(message: string): DbError {
  return new DbError("22007", ERROR_CODES.INVALID_DATETIME_FORMAT, message);
}

export function datetimeOutOfRange(message: string): DbError {
  return new DbError("22008", ERROR_CODES.DATETIME_OUT_OF_RANGE, message);
}

export function invalidIntervalFormat(message: string): DbError {
  return new DbError("22006", ERROR_CODES.INVALID_INTERVAL_FORMAT, message);
}

export function intervalOutOfRange(message: string): DbError {
  return new DbError("22015", ERROR_CODES.INTERVAL_OUT_OF_RANGE, message);
}

export function invalidTimeZone(message: string): DbError {
  return new DbError("22009", ERROR_CODES.INVALID_TIME_ZONE, message);
}

export function invalidCharacterEncoding(message: string): DbError {
  return new DbError("22021", ERROR_CODES.INVALID_CHARACTER_ENCODING, message);
}

export function typeMismatch(message: string): DbError {
  return new DbError("42804", ERROR_CODES.TYPE_MISMATCH, message);
}

export function castNotSupported(message: string): DbError {
  return new DbError("42846", ERROR_CODES.CAST_NOT_SUPPORTED, message);
}

/** 저장된 바이트열을 값으로 되돌릴 수 없음. 저장 파일 손상과 같은 번호를 쓴다. */
export function corruptValue(message: string): DbError {
  return new DbError("XX001", ERROR_CODES.STORAGE_CORRUPT, message);
}
