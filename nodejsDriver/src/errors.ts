/**
 * 드라이버의 오류.
 *
 * 담당
 *  - 서버가 돌려준 오류와 드라이버가 만드는 연결 오류를 하나의 클래스(`DbError`)로 다룬다.
 *    SQLSTATE(ANSI 5자리), 내부 오류 번호, 영문 메시지, SQL 문장 안의 위치(있을 때만)를 가진다.
 *  - 서버 메시지는 번역하지 않는다. 오류는 `sqlState` 와 `code` 로 판단한다. (AGENTS.md 상세 14-2 "화면 문구의 언어")
 *  - 내부 오류 번호 가운데 드라이버가 알아야 하는 것만 옮겨 둔다. 번호의 전체 목록은 `rdbms/src/common/errors.ts` 이다.
 *    한 번 정한 번호는 서버에서 바뀌지 않으므로 여기서도 그대로 쓴다.
 *
 * 관련 사양 : AGENTS.md 상세 0, 8, 15 / rdbms/docs/protocol.md 11절
 * 구현 단계 : 12-3
 */

/** 드라이버가 만들거나 다루는 내부 오류 번호이다. (서버와 같은 값이다) */
export const ERROR_CODES = {
  /** 지원하지 않는 기능. SQLSTATE 0A000. */
  FEATURE_NOT_SUPPORTED: 1,
  /** 인증 실패. 사용자가 없는 경우와 비밀번호가 틀린 경우를 구분하지 않는다. SQLSTATE 28000. */
  AUTHENTICATION_FAILED: 7000,
  /** 권한이 없음. SQLSTATE 42501. */
  INSUFFICIENT_PRIVILEGE: 7001,
  /** CONNECT 권한 그룹이 없는 사용자가 원격에서 접속함. SQLSTATE 28000. */
  CONNECT_NOT_ALLOWED: 7006,
  /** 프로토콜 위반. SQLSTATE 08P01. */
  PROTOCOL_VIOLATION: 8000,
  /** TCP, UDP 접속 수가 maxConnections 에 이름. SQLSTATE 53300. */
  TOO_MANY_CONNECTIONS: 8001,
  /** 유휴 시간 초과로 서버가 세션을 끊음. SQLSTATE 57P05. */
  IDLE_TIMEOUT: 8002,
  /** 처리 한도 초과(행 하나가 메시지에 안 들어감, UDP 조각 수 초과). SQLSTATE 54000. */
  LIMIT_EXCEEDED: 8003,
  /** 커서가 없음. SQLSTATE 34000. */
  CURSOR_NOT_FOUND: 8004,
  /** 연결 실패. 드라이버가 만드는 오류이다(UDP 재전송 한도, 연결 끊김, 응답 시간 초과, 서버 확인 실패). SQLSTATE 08006. */
  CONNECTION_FAILURE: 8006,
  /** 접속을 맺지 못함 : TLS 서버 인증서 검증 실패. 드라이버가 만드는 오류이다. SQLSTATE 08001. */
  CONNECTION_REJECTED: 8007,
} as const;

/** SQL 문장 안의 위치. 줄과 칸은 1 부터 세며, 칸은 UTF-16 단위이다. `offset` 은 0 부터 센다. */
export interface SourcePosition {
  offset: number;
  line: number;
  column: number;
}

/** 서버가 돌려준 오류와 드라이버가 만드는 연결 오류이다. 메시지는 영문이다. */
export class DbError extends Error {
  /** ANSI SQLSTATE 5자리이다. */
  readonly sqlState: string;
  /** 서버의 내부 오류 번호이다. */
  readonly code: number;
  /** 오류가 난 SQL 문장 안의 위치이다. 문법 오류처럼 위치를 알 수 있을 때만 있다. */
  readonly position?: SourcePosition;

  constructor(sqlState: string, code: number, message: string, options?: { cause?: unknown; position?: SourcePosition }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DbError";
    this.sqlState = sqlState;
    this.code = code;
    if (options?.position !== undefined) this.position = options.position;
  }

  /**
   * 이 연결을 더 쓸 수 없게 된 오류인지이다. 연결이 끊겼거나 맺지 못한 오류(SQLSTATE 클래스 08)와, 서버가 접속을 끊으며 알리는 오류
   * (서버 종료 57P01, 유휴 시간 초과 57P05)가 해당한다. 새 연결을 맺어 다시 시도할 수 있다.
   */
  get isConnectionError(): boolean {
    return this.sqlState.startsWith("08") || this.sqlState === "57P01" || this.sqlState === "57P05";
  }
}

/** 연결을 맺지 못했거나 끊긴 오류를 만든다. SQLSTATE 08006. 서버는 보내지 않는 드라이버의 오류이다. */
export function connectionFailure(message: string, cause?: unknown): DbError {
  return new DbError("08006", ERROR_CODES.CONNECTION_FAILURE, message, cause === undefined ? undefined : { cause });
}
