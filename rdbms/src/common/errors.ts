/**
 * 오류 체계.
 *
 * 담당
 *  - RDBMS 의 모든 오류가 쓰는 오류 클래스 : SQLSTATE(ANSI 5자리), 내부 오류 번호, 영문 메시지
 *  - 내부 오류 번호와 SQLSTATE 의 목록.
 *    드라이버가 참조하므로 한 번 정한 번호는 바꾸거나 다른 뜻으로 다시 쓰지 않는다.
 *  - 지원하지 않는 문법이나 기능을 알리는 오류 (SQLSTATE 0A000)
 *
 * 다른 모듈은 Error 를 직접 던지지 않고 여기서 정의한 오류를 쓴다.
 * 단, 구동 실패(설정 오류, 잠금 실패 등 SQL 실행 이전의 실패)는 StartupError 를 쓴다.
 * StartupError 는 SQLSTATE 를 가지지 않으며 CLI 가 종료 코드 1 과 함께 보여 준다.
 *
 * 관련 사양 : AGENTS.md 상세 0
 * 구현 단계 : 1단계
 */

/** SQLSTATE 는 ANSI 5자리 코드이다. 영문 대문자와 숫자만 쓴다. */
export type SqlState = string;

/** SQLSTATE 가 5자리 영문 대문자와 숫자인지 확인한다. */
export function isSqlState(value: string): boolean {
  return /^[0-9A-Z]{5}$/.test(value);
}

/**
 * 내부 오류 번호.
 * 한 번 정한 번호는 바꾸거나 다른 뜻으로 다시 쓰지 않는다.
 * 1 ~ 999 는 1단계에서 정한 공통 오류이다. 이후 단계는 1000 번대부터 새로 배정한다.
 */
export const ERROR_CODES = {
  /** 지원하지 않는 문법이나 기능. SQLSTATE 0A000. */
  FEATURE_NOT_SUPPORTED: 1,
  /** 내부 오류. SQLSTATE XX000. */
  INTERNAL_ERROR: 2,
} as const;

/** SQL 실행 오류. 메시지는 영문으로 적는다. */
export class DbError extends Error {
  readonly sqlState: SqlState;
  readonly code: number;

  constructor(sqlState: SqlState, code: number, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DbError";
    this.sqlState = sqlState;
    this.code = code;
  }
}

/** SQL 실행 이전의 구동 실패. SQLSTATE 를 가지지 않는다. 메시지는 영문으로 적는다. */
export class StartupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StartupError";
  }
}

/** 값이 DbError 인지 확인한다. */
export function isDbError(value: unknown): value is DbError {
  return value instanceof DbError;
}

/** 지원하지 않는 문법이나 기능 오류를 만든다. SQLSTATE 0A000. 메시지는 영문으로 적는다. */
export function unsupportedFeature(message: string, options?: { cause?: unknown }): DbError {
  return new DbError("0A000", ERROR_CODES.FEATURE_NOT_SUPPORTED, message, options);
}

/** 내부 오류를 만든다. SQLSTATE XX000. 메시지는 영문으로 적는다. */
export function internalError(message: string, options?: { cause?: unknown }): DbError {
  return new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, message, options);
}

/** 화면과 로그에 보여 줄 한 줄 설명을 만든다. */
export function formatDbError(error: DbError): string {
  return `[${error.sqlState}:${error.code}] ${error.message}`;
}
