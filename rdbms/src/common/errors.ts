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
  /** 저장 파일 입출력 실패. SQLSTATE 58030. */
  STORAGE_IO: 1000,
  /** 저장 파일 손상. SQLSTATE XX001. */
  STORAGE_CORRUPT: 1001,
  /** 잘못된 저장 API 인자. SQLSTATE 22023. */
  STORAGE_ARGUMENT: 1002,
  /** 다른 배치의 커밋으로 인한 충돌. SQLSTATE 40001. */
  STORAGE_CONFLICT: 1003,
  /** 유일 인덱스의 중복 키. SQLSTATE 23505. */
  DUPLICATE_KEY: 1004,
  /** 잘못된 데이터 타입 인자. SQLSTATE 22023. */
  TYPE_PARAMETER_INVALID: 2000,
  /** 문자열이나 바이트열이 타입의 길이를 넘음. SQLSTATE 22001. */
  STRING_TOO_LONG: 2001,
  /** 숫자가 타입의 범위나 정밀도를 넘음. SQLSTATE 22003. */
  NUMERIC_OUT_OF_RANGE: 2002,
  /** 0 으로 나눔. SQLSTATE 22012. */
  DIVISION_BY_ZERO: 2003,
  /** 문자열을 대상 타입의 값으로 해석할 수 없음. SQLSTATE 22018. */
  INVALID_CAST_VALUE: 2004,
  /** 날짜시간 문자열의 형식이 틀림. SQLSTATE 22007. */
  INVALID_DATETIME_FORMAT: 2005,
  /** 날짜시간 값이 범위를 넘음. SQLSTATE 22008. */
  DATETIME_OUT_OF_RANGE: 2006,
  /** INTERVAL 문자열의 형식이 틀림. SQLSTATE 22006. */
  INVALID_INTERVAL_FORMAT: 2007,
  /** INTERVAL 값이 필드 범위나 선행 정밀도를 넘음. SQLSTATE 22015. */
  INTERVAL_OUT_OF_RANGE: 2008,
  /** 타임존 지정이 틀림. SQLSTATE 22009. */
  INVALID_TIME_ZONE: 2009,
  /** 올바르지 않은 UTF-8 바이트열 또는 짝이 맞지 않는 서러게이트. SQLSTATE 22021. */
  INVALID_CHARACTER_ENCODING: 2010,
  /** 타입이 맞지 않아 암묵적 형변환이나 연산을 할 수 없음. SQLSTATE 42804. */
  TYPE_MISMATCH: 2011,
  /** 지원하지 않는 형변환(CAST). SQLSTATE 42846. */
  CAST_NOT_SUPPORTED: 2012,
  /** SQL 문법 오류. SQLSTATE 42601. */
  SYNTAX_ERROR: 3000,
  /** 식별자가 최대 길이(128자)를 넘음. SQLSTATE 42622. */
  IDENTIFIER_TOO_LONG: 3001,
  /** 문장이 너무 깊이 겹쳤거나 식이 너무 길게 이어져 처리 한도를 넘음. SQLSTATE 54001. */
  STATEMENT_TOO_COMPLEX: 3002,
  /** 테이블스페이스가 없음. SQLSTATE 3D000. */
  TABLESPACE_NOT_FOUND: 4000,
  /** 테이블스페이스가 이미 있음. SQLSTATE 42P06. */
  TABLESPACE_EXISTS: 4001,
  /** 테이블이 이미 있음. SQLSTATE 42P07. */
  TABLE_EXISTS: 4002,
  /** 테이블이 없음. SQLSTATE 42P01. */
  TABLE_NOT_FOUND: 4003,
  /** 컬럼이 이미 있음. SQLSTATE 42701. */
  COLUMN_EXISTS: 4004,
  /** 컬럼이 없음. SQLSTATE 42703. */
  COLUMN_NOT_FOUND: 4005,
  /** 제약조건이 이미 있음. SQLSTATE 42710. */
  CONSTRAINT_EXISTS: 4006,
  /** 제약조건이 없음. SQLSTATE 42704. */
  CONSTRAINT_NOT_FOUND: 4007,
  /** 인덱스가 이미 있음. SQLSTATE 42710. */
  INDEX_EXISTS: 4008,
  /** 인덱스가 없음. SQLSTATE 42704. */
  INDEX_NOT_FOUND: 4009,
  /** 뷰가 이미 있음. SQLSTATE 42P07. */
  VIEW_EXISTS: 4010,
  /** 뷰가 없음. SQLSTATE 42P01. */
  VIEW_NOT_FOUND: 4011,
  /** 테이블 정의가 잘못됨. SQLSTATE 42P16. */
  INVALID_TABLE_DEFINITION: 4012,
  /** RESTRICT 로 막힌 삭제. SQLSTATE 55006. */
  OBJECT_IN_USE: 4013,
  /** 예약된 이름. SQLSTATE 42602. */
  RESERVED_NAME: 4014,
  /** 컬럼이 너무 많음. SQLSTATE 54011. */
  TOO_MANY_COLUMNS: 4015,
  /** 뷰 정의가 잘못됨. SQLSTATE 42P17. */
  INVALID_VIEW_DEFINITION: 4016,
  /** 인덱스 정의가 잘못됨. SQLSTATE 42P16. */
  INVALID_INDEX_DEFINITION: 4017,
  /** 컬럼 참조가 모호함. SQLSTATE 42702. */
  AMBIGUOUS_COLUMN: 5000,
  /** 정의되지 않은 함수. SQLSTATE 42883. */
  UNDEFINED_FUNCTION: 5001,
  /** 스칼라 서브쿼리가 2행 이상을 돌려줌. SQLSTATE 21000. */
  CARDINALITY_VIOLATION: 5002,
  /** NOT NULL 위반. SQLSTATE 23502. */
  NOT_NULL_VIOLATION: 5003,
  /** 외래 키 위반. SQLSTATE 23503. */
  FOREIGN_KEY_VIOLATION: 5004,
  /** 함수 인자의 개수나 형태가 틀림. SQLSTATE 42883. */
  INVALID_FUNCTION_ARGUMENT: 5005,
  /** GROUP BY 위반. SQLSTATE 42803. */
  GROUPING_ERROR: 5006,
  /** 파라미터 개수 불일치. SQLSTATE 07001. */
  PARAM_COUNT_MISMATCH: 5008,
  /** INSERT 값 개수 불일치. SQLSTATE 42601. */
  INSERT_VALUE_MISMATCH: 5011,
  /** 집합 연산의 컬럼 개수 불일치. SQLSTATE 42804. */
  SET_OPERATION_MISMATCH: 5010,
} as const;

/** SQL 문장 안의 위치. 줄과 칸은 1 부터 세며, 칸은 UTF-16 단위이다. */
export interface SourcePosition {
  /** 문장 맨 앞부터의 UTF-16 단위 수. 0 부터 센다. */
  offset: number;
  line: number;
  column: number;
}

/** SQL 실행 오류. 메시지는 영문으로 적는다. */
export class DbError extends Error {
  readonly sqlState: SqlState;
  readonly code: number;
  /** 오류가 난 SQL 문장 안의 위치. 문법 오류처럼 위치를 알 수 있을 때만 있다. */
  readonly position?: SourcePosition;

  constructor(
    sqlState: SqlState,
    code: number,
    message: string,
    options?: { cause?: unknown; position?: SourcePosition },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DbError";
    this.sqlState = sqlState;
    this.code = code;
    if (options?.position !== undefined) {
      this.position = options.position;
    }
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

/**
 * 같은 오류에 SQL 문장 안의 위치를 붙인 오류를 만든다. 메시지 끝에도 줄과 칸을 적는다.
 * 이미 위치가 있는 오류는 그대로 돌려준다.
 */
export function withPosition(error: DbError, position: SourcePosition): DbError {
  if (error.position !== undefined) return error;
  const text = error.message.replace(/\.$/, "");
  return new DbError(
    error.sqlState,
    error.code,
    `${text} (line ${position.line}, column ${position.column}).`,
    { cause: error.cause, position },
  );
}
