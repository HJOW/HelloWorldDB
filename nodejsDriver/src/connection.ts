/**
 * 접속 하나의 공개 API.
 *
 * 담당
 *  - 접속 대상은 호스트와 포트 번호만으로 정한다. SID 나 DB 이름에 해당하는 항목은 없다. 둘 다 생략하면 로컬 장비(127.0.0.1)의 7410 이다.
 *    TCP 와 UDP 는 같은 포트 번호를 쓴다. TCP 에는 SSL 을 쓸 수 있고 서버 인증서는 기본으로 검증한다.
 *  - 문장 실행(`query`)과 `?` 파라미터 바인딩. 결과는 컬럼 메타데이터와 변환된 행이다. (값의 변환은 values.ts)
 *  - 큰 결과를 나누어 받는 커서(`cursor`)와 비동기 반복자(`stream`).
 *  - 트랜잭션 : 자동 커밋 전환(`setAutoCommit`), 시작(`begin`), 커밋(`commit`), 롤백(`rollback`), 한 번에 감싸는 `transaction`.
 *  - 접속 종료(`close`), 강제 종료(`destroy`), 끊김 감지(`close` 이벤트).
 *  - 오류는 `DbError` 이다. SQLSTATE, 내부 오류 번호, 영문 메시지(서버 메시지는 번역하지 않는다), 문장 안의 위치(있을 때만)를 가진다.
 *
 * 한 접속은 세션 하나이고 세션 하나는 동시에 트랜잭션 하나만 가진다. 문장은 보낸 순서대로 처리된다.
 * 한 접속에서 `transaction()` 이 도는 동안 다른 곳에서 같은 접속으로 문장을 보내면 그 문장도 같은 트랜잭션에 들어간다.
 *
 * 관련 사양 : AGENTS.md 상세 8, 10, 15 / rdbms/docs/protocol.md
 * 구현 단계 : 12-3
 */

import { EventEmitter } from "node:events";
import { DbError, connectionFailure } from "./errors.js";
import { ProtocolConnection } from "./protocol/protocolConnection.js";
import type { RawOutcome, Target } from "./protocol/protocolConnection.js";
import type { ColumnMeta, JsonValue, SessionInfoMessage } from "./protocol/messages.js";
import type { InternalTransportOptions, SslOptions } from "./transport/tcpTransport.js";
import { decodeRow, encodeParams } from "./values.js";
import type { Column, Param, Row, Value } from "./values.js";

export type { SslOptions } from "./transport/tcpTransport.js";
export type { Column, Param, Row, Value } from "./values.js";

/** 기본 포트 번호이다. */
export const DEFAULT_PORT = 7410;
/** 호스트를 생략했을 때의 주소이다. (로컬 장비. `localhost` 는 IPv6 로 풀릴 수 있어 쓰지 않는다) */
export const DEFAULT_HOST = "127.0.0.1";

export interface ConnectOptions {
  /** 서버 주소이다. 기본 `127.0.0.1`. */
  host?: string;
  /** 포트 번호이다. TCP 와 UDP 가 같은 번호를 쓴다. 기본 7410. */
  port?: number;
  /** 접속 방식이다. 기본 `tcp`. UDP 는 암호화되지 않는다. 신뢰할 수 있는 네트워크에서만 쓴다. */
  protocol?: "tcp" | "udp";
  /** 사용자명이다. */
  user: string;
  /** 비밀번호이다. 평문으로 오가지 않는다(SCRAM-SHA-256). */
  password: string;
  /** 접속 직후의 현재 테이블스페이스이다. 식별자 규칙을 따른다(따옴표 없이 쓰면 대문자). 생략하면 사용자의 기본 테이블스페이스이다. */
  tablespace?: string;
  /** 세션 타임존이다. (`+09:00`, `Asia/Seoul`) 생략하면 서버 설정을 따른다. */
  timeZone?: string;
  /** TCP 에서 SSL 을 쓴다. `true` 는 기본 옵션(서버 인증서를 검증), 객체는 CA 지정이나 검증 끄기 같은 세부 옵션이다. */
  ssl?: boolean | SslOptions;
  /** 연결과 로그인의 제한 시간(ms)이다. 기본 10,000. */
  connectTimeoutMs?: number;
  /** 요청 하나가 응답을 기다리는 제한 시간(ms)이다. 기본은 제한 없음이다. (문장이 잠금을 기다리면 30초까지 걸릴 수 있다) */
  requestTimeoutMs?: number;
  /** 조회 결과를 나누어 받는 묶음의 행 수이다. 생략하면 서버 기본값(500)이다. */
  fetchSize?: number;
  /** 서버에 알리는 클라이언트 이름이다. */
  clientName?: string;
  /** 시험에서만 쓰는 내부 옵션이다. 공개 API 가 아니다. */
  internal?: InternalTransportOptions;
}

export interface QueryOptions {
  /** 이 문장의 묶음 크기이다. 생략하면 접속의 `fetchSize` 이다. */
  fetchSize?: number;
}

/** 로그인한 세션의 정보이다. 현재 테이블스페이스가 없는 사용자의 `tablespace` 는 `null` 이다. */
export type SessionInfo = SessionInfoMessage;

/** 서버의 정보이다. */
export interface ServerInfo {
  /** 서버 이름과 버전이다. */
  server: string;
  protocolVersion: number;
  /** 메시지 하나의 최대 크기(바이트)이다. */
  maxMessageBytes: number;
  defaultFetchSize: number;
}

/** 접속을 닫은 결과이다. */
export interface CloseResult {
  /** 커밋하지 않은 변경이 있어서 서버가 롤백했는지이다. (서버의 응답을 받지 못했으면 false) */
  rolledBack: boolean;
}

/** 문장 하나의 실행 결과이다. 조회가 아닌 문장은 `columns` 와 `rows` 가 비어 있다. */
export class QueryResult {
  constructor(
    /** 컬럼 메타데이터이다. */
    readonly columns: Column[],
    /** 변환된 행이다. 컬럼 순서의 배열이다. */
    readonly rows: Row[],
    /** 조회면 받은 행 수, DML 이면 영향받은 행 수이다. 알 수 없으면(DDL 등) null 이다. */
    readonly rowCount: number | null,
    /** 조회가 아닌 문장의 완료 메시지이다. 조회면 null 이다. */
    readonly message: string | null,
  ) {}

  /** 행을 컬럼 이름을 키로 하는 객체로 바꾼다. 같은 이름의 컬럼이 둘이면 뒤의 것이 남는다. */
  records(): Array<Record<string, Value>> {
    return this.rows.map((row) => {
      const record: Record<string, Value> = {};
      this.columns.forEach((column, index) => {
        record[column.name] = row[index] as Value;
      });
      return record;
    });
  }
}

/** 문장 맨 앞의 주석을 건너뛰고 첫 두 낱말(대문자)을 돌려준다. 트랜잭션 상태를 가늠하는 데만 쓴다. */
function leadingWords(sql: string): [string, string] {
  let rest = sql;
  for (;;) {
    rest = rest.trimStart();
    if (rest.startsWith("--")) {
      const end = rest.indexOf("\n");
      rest = end < 0 ? "" : rest.slice(end + 1);
    } else if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      rest = end < 0 ? "" : rest.slice(end + 2);
    } else {
      break;
    }
  }
  const match = /^([A-Za-z_]+)(?:\s+([A-Za-z_]+))?/.exec(rest);
  return [(match?.[1] ?? "").toUpperCase(), (match?.[2] ?? "").toUpperCase()];
}

const SCHEMA_STATEMENTS: ReadonlySet<string> = new Set(["CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "REVOKE"]);

function checkFetchSize(value: number | undefined, what: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new RangeError(`${what} must be an integer of 1 or more.`);
}

function resolveTarget(options: ConnectOptions): Target {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  if (typeof host !== "string" || host.length === 0) throw new TypeError("host must be a non-empty string.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError("port must be an integer between 1 and 65535.");
  const protocol = options.protocol ?? "tcp";
  if (protocol === "udp") {
    if (options.ssl !== undefined && options.ssl !== false) throw new TypeError("SSL applies to TCP only; UDP is not encrypted.");
    return { kind: "udp", host, port };
  }
  if (protocol !== "tcp") throw new TypeError('protocol must be "tcp" or "udp".');
  const ssl = options.ssl === true ? {} : options.ssl === false || options.ssl === undefined ? undefined : options.ssl;
  return ssl === undefined ? { kind: "tcp", host, port } : { kind: "tcp", host, port, ssl };
}

/** 서버가 먼저 끊거나 연결이 끊긴 접속은 쓸 수 없다. */
export class Connection extends EventEmitter {
  private autocommit: boolean;
  private readonly defaultAutocommit: boolean;
  private inTxn = false;
  private releaser: (() => void) | null = null;
  /** 마지막으로 문장을 보낸 시각(ms)이다. 커넥션 풀이 쓴다. */
  lastUsedAt = Date.now();

  private constructor(
    private readonly protocol: ProtocolConnection,
    private readonly fetchSize: number | undefined,
    private readonly sessionInfo: SessionInfo,
  ) {
    super();
    this.autocommit = sessionInfo.autocommit;
    this.defaultAutocommit = sessionInfo.autocommit;
    protocol.onClose((error) => this.emit("close", error));
  }

  /** 서버에 접속하고 로그인한다. */
  static async connect(options: ConnectOptions): Promise<Connection> {
    if (typeof options !== "object" || options === null) throw new TypeError("connect options are required.");
    if (typeof options.user !== "string" || options.user.length === 0) throw new TypeError("user must be a non-empty string.");
    if (typeof options.password !== "string") throw new TypeError("password must be a string.");
    checkFetchSize(options.fetchSize, "fetchSize");
    const target = resolveTarget(options);
    const protocol = await ProtocolConnection.open(target, {
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      clientName: options.clientName ?? "helloworlddb-nodejs",
      ...(options.internal === undefined ? {} : { internal: options.internal }),
    });
    let session: SessionInfoMessage;
    try {
      session = await protocol.login({
        user: options.user,
        password: options.password,
        ...(options.tablespace === undefined ? {} : { tablespace: options.tablespace }),
        ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
      });
    } catch (error) {
      protocol.abort();
      throw error;
    }
    return new Connection(protocol, options.fetchSize, session);
  }

  /** 로그인할 때 서버가 알려 준 세션 정보이다. (`USE` 로 바꾼 현재 테이블스페이스는 반영하지 않는다) */
  get session(): SessionInfo {
    return this.sessionInfo;
  }

  get serverInfo(): ServerInfo {
    const hello = this.protocol.hello;
    return { server: hello.server, protocolVersion: hello.version, maxMessageBytes: hello.maxMessageBytes, defaultFetchSize: hello.defaultFetchSize };
  }

  /** 접속이 끝났는지이다. 끝난 접속으로는 문장을 보낼 수 없다. */
  get isClosed(): boolean {
    return this.protocol.isClosed;
  }

  /** 이 접속의 자동 커밋 상태이다. */
  get autoCommit(): boolean {
    return this.autocommit;
  }

  /**
   * 커밋하지 않은 변경이 있을 수 있는지이다. 이 접속으로 보낸 문장에서 가늠한 값이다.
   * 자동 커밋이 꺼져 있으면 첫 문장에서 트랜잭션이 시작되므로 문장을 보낸 뒤에는 true 이다.
   */
  get inTransaction(): boolean {
    return this.inTxn;
  }

  // -------------------------------------------------------------------------
  // 문장 실행
  // -------------------------------------------------------------------------

  /**
   * 문장 하나를 실행한다. `?` 는 `params` 의 값으로 바인딩된다. 조회 결과는 모두 받아서 돌려준다.
   * 결과가 아주 크면 `cursor` 나 `stream` 으로 나누어 읽는다.
   */
  async query(sql: string, params: readonly Param[] = [], options: QueryOptions = {}): Promise<QueryResult> {
    const raw = await this.run(sql, params, options);
    if (raw.kind === "ok") return new QueryResult([], [], raw.rowCount, raw.message);
    const fetchSize = options.fetchSize ?? this.fetchSize;
    const pages: JsonValue[][][] = [raw.rows];
    let cursor = raw.cursor;
    let hasMore = raw.hasMore;
    try {
      while (hasMore && cursor !== null) {
        const batch = await this.protocol.fetch(cursor, fetchSize);
        pages.push(batch.rows);
        cursor = batch.cursor;
        hasMore = batch.hasMore;
      }
    } catch (error) {
      if (cursor !== null && !this.isClosed) await this.protocol.closeCursor(cursor).catch(() => undefined);
      throw error;
    }
    const rows: Row[] = [];
    for (const page of pages) for (const rawRow of page) rows.push(decodeRow(rawRow, raw.columns));
    return new QueryResult(raw.columns, rows, rows.length, null);
  }

  /**
   * 조회를 실행하고 결과를 나누어 읽는 커서를 돌려준다. 서버가 쥐고 있는 나머지 행은 `fetch` 로 가져오고, 다 읽었거나 더 필요 없으면 `close` 한다.
   * 커밋과 롤백은 커서를 무효로 만들지 않는다. 한 접속이 동시에 열어 둘 수 있는 커서는 16개이다.
   */
  async cursor(sql: string, params: readonly Param[] = [], options: QueryOptions = {}): Promise<Cursor> {
    const raw = await this.run(sql, params, options);
    const fetchSize = options.fetchSize ?? this.fetchSize;
    if (raw.kind === "ok") return new Cursor(this.protocol, [], [], null, false, fetchSize, raw.rowCount, raw.message);
    return new Cursor(this.protocol, raw.columns, raw.rows, raw.cursor, raw.hasMore, fetchSize, null, null);
  }

  /** 조회를 실행하고 행을 하나씩 비동기 반복자로 읽는다. 반복을 중간에 멈추면 커서를 닫는다. */
  async *stream(sql: string, params: readonly Param[] = [], options: QueryOptions = {}): AsyncGenerator<Row, void, undefined> {
    const cursor = await this.cursor(sql, params, options);
    try {
      yield* cursor;
    } finally {
      await cursor.close();
    }
  }

  private async run(sql: string, params: readonly Param[], options: QueryOptions): Promise<RawOutcome> {
    if (typeof sql !== "string" || sql.trim().length === 0) throw new TypeError("sql must be a non-empty string.");
    checkFetchSize(options.fetchSize, "fetchSize");
    const encoded = encodeParams(params);
    this.lastUsedAt = Date.now();
    const raw = await this.protocol.execute(sql, encoded, options.fetchSize ?? this.fetchSize);
    this.trackStatement(sql);
    return raw;
  }

  /** 성공한 문장에서 자동 커밋과 트랜잭션 상태를 가늠한다. */
  private trackStatement(sql: string): void {
    const [first, second] = leadingWords(sql);
    if (first === "BEGIN" || (first === "START" && second === "TRANSACTION")) {
      this.inTxn = true;
    } else if (first === "COMMIT" || (first === "ROLLBACK" && second !== "TO")) {
      this.inTxn = false;
    } else if (first === "SET" && second === "AUTOCOMMIT") {
      const text = sql.replace(/;\s*$/, "").trim().toUpperCase();
      this.autocommit = !text.endsWith("OFF");
    } else if (SCHEMA_STATEMENTS.has(first)) {
      this.inTxn = false; // DDL, GRANT, REVOKE 는 실행 전후에 자동으로 커밋된다.
    } else if (!this.autocommit && first !== "") {
      this.inTxn = true; // 자동 커밋이 꺼져 있으면 첫 문장에서 트랜잭션이 시작된다.
    }
  }

  // -------------------------------------------------------------------------
  // 트랜잭션
  // -------------------------------------------------------------------------

  /** 트랜잭션을 시작한다. (`BEGIN`) 자동 커밋이 꺼져 있으면 첫 문장에서 자동으로 시작되므로 쓸 필요가 없다. */
  async begin(): Promise<void> {
    await this.query("BEGIN");
  }

  async commit(): Promise<void> {
    await this.query("COMMIT");
  }

  async rollback(): Promise<void> {
    await this.query("ROLLBACK");
  }

  /** 자동 커밋을 켜거나 끈다. (`SET AUTOCOMMIT ON | OFF`) */
  async setAutoCommit(enabled: boolean): Promise<void> {
    await this.query(enabled ? "SET AUTOCOMMIT ON" : "SET AUTOCOMMIT OFF");
  }

  /**
   * `fn` 을 트랜잭션 안에서 실행한다. `fn` 이 끝나면 커밋하고, 예외를 던지면 롤백한 뒤 그 예외를 다시 던진다.
   * 자동 커밋이 꺼져 있으면 `BEGIN` 없이 같은 규칙으로 커밋하거나 롤백한다.
   * 교착(`40P01`)이면 서버가 이미 트랜잭션을 롤백했으므로 `fn` 의 예외를 그대로 던진다. 다시 시도하는 것은 호출하는 쪽의 몫이다.
   */
  async transaction<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    if (this.autocommit) await this.begin();
    let result: T;
    try {
      result = await fn(this);
    } catch (error) {
      if (!this.isClosed) await this.rollback().catch(() => undefined);
      throw error;
    }
    await this.commit();
    return result;
  }

  // -------------------------------------------------------------------------
  // 관리
  // -------------------------------------------------------------------------

  /** 서버가 응답하는지 확인한다. */
  async ping(): Promise<void> {
    await this.protocol.ping();
  }

  /**
   * 정상적으로 접속을 끝낸다. 서버가 커밋하지 않은 변경을 롤백한다. 이미 닫혔으면 아무것도 하지 않는다.
   * 커넥션 풀에서 가져온 접속은 `release` 로 돌려준다. `close` 를 부르면 풀에서도 빠진다.
   */
  async close(): Promise<CloseResult> {
    return await this.protocol.close();
  }

  /** 서버의 응답을 기다리지 않고 접속을 끊는다. */
  destroy(): void {
    this.protocol.abort();
  }

  /** 커넥션 풀에서 가져온 접속을 풀에 돌려준다. 돌려준 뒤에는 이 객체를 쓰지 않는다. 풀에서 가져온 것이 아니거나 이미 돌려주었으면 오류이다. */
  release(): void {
    if (this.releaser === null) throw new Error("This connection is not leased from a pool (or it was already released).");
    const release = this.releaser;
    this.releaser = null;
    release();
  }

  /** @internal 커넥션 풀이 가져가는 접속에 돌려주는 함수를 붙인다. */
  _lease(release: () => void): void {
    this.releaser = release;
  }

  /** @internal 풀에 돌려줄 때 되돌릴 것이 있는지이다. (트랜잭션 중이거나 자동 커밋 상태가 로그인 때와 다르다) */
  get _needsReset(): boolean {
    return this.inTxn || this.autocommit !== this.defaultAutocommit;
  }

  /** @internal 풀에 돌려주기 전에 접속을 로그인 직후의 상태로 되돌린다. */
  async _reset(): Promise<void> {
    if (this.inTxn) await this.rollback();
    if (this.autocommit !== this.defaultAutocommit) await this.setAutoCommit(this.defaultAutocommit);
  }
}

/** 조회 결과를 나누어 읽는 커서이다. `Connection.cursor` 가 만든다. */
export class Cursor implements AsyncIterable<Row> {
  private buffer: Row[];
  private cursorId: number | null;
  private hasMore: boolean;
  private closed = false;

  constructor(
    private readonly protocol: ProtocolConnection,
    /** 컬럼 메타데이터이다. 조회가 아닌 문장이면 비어 있다. */
    readonly columns: Column[],
    firstRows: JsonValue[][],
    cursorId: number | null,
    hasMore: boolean,
    private readonly fetchSize: number | undefined,
    /** DML 이면 영향받은 행 수이다. 조회는 행 수를 미리 알 수 없으므로 null 이다. */
    readonly rowCount: number | null,
    /** 조회가 아닌 문장의 완료 메시지이다. 조회면 null 이다. */
    readonly message: string | null,
  ) {
    this.buffer = firstRows.map((raw) => decodeRow(raw, columns as ColumnMeta[]));
    this.cursorId = cursorId;
    this.hasMore = hasMore;
  }

  /** 서버에 더 가져올 행이 있는지이다. 이미 받은 행이 남아 있을 수도 있다. */
  get hasMoreOnServer(): boolean {
    return this.hasMore;
  }

  /** 다음 묶음을 돌려준다. 처음에는 `execute` 로 받은 첫 묶음이다. 끝까지 읽었으면 빈 배열이다. */
  async fetch(size?: number): Promise<Row[]> {
    if (this.buffer.length > 0) {
      const rows = this.buffer;
      this.buffer = [];
      return rows;
    }
    if (this.closed || !this.hasMore || this.cursorId === null) return [];
    const batch = await this.protocol.fetch(this.cursorId, size ?? this.fetchSize);
    this.cursorId = batch.cursor;
    this.hasMore = batch.hasMore;
    return batch.rows.map((raw) => decodeRow(raw, this.columns as ColumnMeta[]));
  }

  /** 남은 행을 버리고 서버의 커서를 닫는다. 이미 닫혔거나 다 읽었으면 아무 일도 하지 않는다. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.buffer = [];
    const id = this.cursorId;
    this.cursorId = null;
    this.hasMore = false;
    if (id !== null && !this.protocol.isClosed) {
      try {
        await this.protocol.closeCursor(id);
      } catch (error) {
        // 접속이 이미 끊긴 경우는 서버가 커서를 버렸으므로 무시한다.
        if (!(error instanceof DbError && error.isConnectionError)) throw error;
      }
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Row, void, undefined> {
    try {
      for (;;) {
        const rows = await this.fetch();
        if (rows.length === 0) return;
        for (const row of rows) yield row;
      }
    } finally {
      await this.close();
    }
  }
}

/** 서버에 접속하고 로그인한다. `Connection.connect` 와 같다. */
export function connect(options: ConnectOptions): Promise<Connection> {
  return Connection.connect(options);
}

// 연결이 닫혔을 때 쓰는 오류를 한곳에서 만들기 위한 재노출이다.
export { connectionFailure };
