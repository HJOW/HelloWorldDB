/**
 * 데이터 타입의 정의.
 *
 * 담당
 *  - 지원하는 타입의 목록과 별칭 (예 : INT → INTEGER, NVARCHAR → VARCHAR)
 *  - 길이, 정밀도, 소수 초 자릿수의 허용 범위와 생략했을 때의 기본값
 *    (예 : VARCHAR/NVARCHAR 는 65,535, DECIMAL/NUMERIC 은 (10,3), TIMESTAMP 는 6)
 *  - 고정소수 타입의 인자 전체 생략은 (10,3), 정밀도만 지정하면 소수 자릿수는 0이다.
 *  - 지원하지 않는 타입(CLOB, BLOB, JSON 등)을 가려 SQLSTATE 0A000 으로 알린다.
 *
 * 관련 사양 : AGENTS.md 개요 1, 상세 1-1, 13
 * 구현 단계 : 3단계. 현재는 변경된 기본값과 고정소수 타입 인자 해석만 구현했다.
 */

import { DbError, ERROR_CODES, unsupportedFeature } from "../common/errors.js";

/** VARCHAR와 그 별칭 NVARCHAR의 길이는 유니코드 코드 포인트 단위이다. */
export const VARCHAR_MAX_LENGTH = 65_535;
export const DEFAULT_VARCHAR_LENGTH = VARCHAR_MAX_LENGTH;
export const DECIMAL_MAX_PRECISION = 38;
export const DEFAULT_DECIMAL_PRECISION = 10;
export const DEFAULT_DECIMAL_SCALE = 3;

/** NUMERIC과 DEC도 DECIMAL로 정규화하여 같은 기본값과 검증 규칙을 쓴다. */
export interface ExactNumericType {
  name: "DECIMAL";
  precision: number;
  scale: number;
}

/** SQL 파서가 읽은 타입 이름과 인자를 받아 고정소수 타입 정의를 만든다. */
export function resolveExactNumericType(name: string, precision?: number, scale?: number): ExactNumericType {
  const normalized = name.toUpperCase();
  if (normalized !== "DECIMAL" && normalized !== "DEC" && normalized !== "NUMERIC") {
    throw unsupportedFeature(`Unsupported exact numeric type: ${name}.`);
  }
  if (precision === undefined && scale !== undefined) {
    throw invalidParameter("Scale cannot be specified without precision.");
  }
  const resolvedPrecision = precision ?? DEFAULT_DECIMAL_PRECISION;
  const resolvedScale = scale ?? (precision === undefined ? DEFAULT_DECIMAL_SCALE : 0);
  if (!Number.isSafeInteger(resolvedPrecision) || resolvedPrecision < 1 || resolvedPrecision > DECIMAL_MAX_PRECISION) {
    throw invalidParameter("Exact numeric precision must be an integer between 1 and 38.");
  }
  if (!Number.isSafeInteger(resolvedScale) || resolvedScale < 0 || resolvedScale > resolvedPrecision) {
    throw invalidParameter("Exact numeric scale must be an integer between 0 and precision.");
  }
  return { name: "DECIMAL", precision: resolvedPrecision, scale: resolvedScale };
}

function invalidParameter(message: string): DbError {
  return new DbError("22023", ERROR_CODES.TYPE_PARAMETER_INVALID, message);
}
