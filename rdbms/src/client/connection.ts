/**
 * 클라이언트 쪽 프로토콜 구현.
 *
 * 담당
 *  - 세 접속 경로로 서버에 연결한다 : 로컬 전용 채널, TCP (SSL 포함), UDP. (전송 계층은 transports.ts, udpTransport.ts)
 *  - 핸드셰이크와 프로토콜 버전 협상, SCRAM-SHA-256 인증. 서버가 보낸 서명을 검증해 서버를 확인한다.
 *  - 문장 실행과 `?` 파라미터 전달, 결과를 fetch 단위로 나누어 받기, 커서 닫기, ping, 접속 종료
 *  - 데몬 제어 요청 (상태 조회, 종료) 보내기. 로컬 전용 채널에서 `hello` 직후에 보낸다.
 *  - 요청과 응답을 `id` 로 짝짓는다. 접속이 끊기면 기다리던 모든 요청을 08006 으로 실패시키고,
 *    서버가 먼저 보낸 `id: 0` 오류(유휴 시간 초과, 서버 종료)는 그 오류로 실패시킨다.
 *
 * CLI 와 테스트가 함께 쓴다. 나중에 `nodejsDriver` 의 출발점이 되므로,
 * 서버 쪽 모듈(session, exec, catalog 등)을 import 하지 않는다.
 * 서버와 공유하는 것은 프로토콜 정의뿐이다 :
 * net/protocol.ts, net/framing.ts, net/udpReliability.ts, auth/scram.ts, common/*
 *
 * 결과의 값은 JSON 값 그대로 돌려준다. (BIGINT 와 NUMERIC 은 문자열 등. docs/protocol.md)
 * 타입 변환(`bigint`, 날짜 객체 등)은 `nodejsDriver` 의 정책이며 이 클라이언트는 하지 않는다.
 *
 * 관련 사양 : AGENTS.md 상세 8, 14-2
 * 구현 단계 : 9단계 (9-5)
 */

import { DbError } from "../common/errors.js";
import {
  authMessage,
  clientFinalWithoutProof,
  clientFirstBare,
  clientFirstMessage,
  computeClientProof,
  generateNonce,
  parseServerFirst,
  verifyServerSignature,
} from "../auth/scram.js";
import {
  AUTH_MECHANISM,
  PROTOCOL_VERSION,
  decodeResponse,
  encodeMessage,
  toDbError,
} from "../net/protocol.js";
import type {
  ColumnMeta,
  ControlAction,
  HelloOkResponse,
  JsonValue,
  ParamValue,
  Response,
  SessionInfoMessage,
  StatusResponse,
} from "../net/protocol.js";
import { connectLocal, connectTcp, connectionFailure } from "./transports.js";
import type { InternalTransportOptions, MessageTransport, Target } from "./transports.js";
import { connectUdp } from "./udpTransport.js";

export type { SslOptions, Target } from "./transports.js";
export { connectionFailure, isCertificateError, isConnectionRefused } from "./transports.js";

/** 파라미터로 줄 수 있는 JavaScript 값이다. */
export type ClientParam = null | undefined | boolean | number | bigint | string | Buffer | Uint8Array;

export interface ConnectionOptions {
  /** 요청마다 응답을 기다리는 제한 시간(ms)이다. 기본은 없다. (문장이 잠금을 기다리면 30초까지 걸릴 수 있다) */
  requestTimeoutMs?: number;
  /** `hello` 에 싣는 클라이언트 이름이다. */
  clientName?: string;
  /** 시험에서만 쓰는 내부 옵션이다. */
  internal?: InternalTransportOptions;
}

export interface LoginOptions {
  user: string;
  password: string;
  /** 접속 직후의 현재 테이블스페이스이다. 생략하면 사용자의 기본 테이블스페이스이다. */
  tablespace?: string;
  /** 세션 타임존이다. 생략하면 서버 설정을 따른다. */
  timeZone?: string;
}

export interface RowsResult {
  kind: "rows";
  columns: ColumnMeta[];
  rows: JsonValue[][];
  /** 남은 행이 있을 때의 커서 번호이다. 없으면 null 이다. */
  cursor: number | null;
  hasMore: boolean;
}

export interface OkResult {
  kind: "ok";
  message: string;
  rowCount: number | null;
}

export type ExecuteOutcome = RowsResult | OkResult;

export interface RowsBatch {
  rows: JsonValue[][];
  cursor: number | null;
  hasMore: boolean;
}

interface Pending {
  resolve(response: Response): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
}

function encodeParam(value: ClientParam, index: number): ParamValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError(`Parameter ${index + 1} is not a finite number.`);
    // 안전 정수를 넘는 정수는 JSON 숫자로 보내면 정밀도를 잃으므로 문자열로 보낸다.
    return Number.isInteger(value) && !Number.isSafeInteger(value) ? BigInt(value).toString() : value;
  }
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (value instanceof Uint8Array) {
    return { binary: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex").toUpperCase() };
  }
  throw new TypeError(`Parameter ${index + 1} has an unsupported type.`);
}

export class Connection {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private closedError: DbError | null = null;
  private helloInfo: HelloOkResponse | null = null;
  private sessionInfo: SessionInfoMessage | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private lastSentAt = Date.now();

  private constructor(
    private readonly transport: MessageTransport,
    private readonly options: ConnectionOptions,
  ) {
    transport.setHandlers({
      onMessage: (body) => this.handleMessage(body),
      onClose: (error) => this.handleClose(error),
    });
  }

  /** 연결하고 핸드셰이크(`hello`)까지 마친다. 로그인은 `login` 으로 따로 한다. */
  static async open(target: Target, options: ConnectionOptions = {}): Promise<Connection> {
    const internal = options.internal ?? {};
    let transport: MessageTransport;
    switch (target.kind) {
      case "local":
        transport = await connectLocal(target.port, internal);
        break;
      case "tcp":
        transport = await connectTcp(target.host, target.port, target.ssl, internal);
        break;
      case "udp":
        transport = await connectUdp(target.host, target.port, internal);
        break;
    }
    const connection = new Connection(transport, options);
    try {
      // 서버가 응답하지 않는 경우(UDP 에서 서버가 없을 때 등)를 연결 제한 시간 안에 알아차린다.
      const hello = await connection.request(
        { type: "hello", versions: [PROTOCOL_VERSION], client: options.clientName ?? "hwdb-client" },
        internal.connectTimeoutMs ?? 10_000,
      );
      if (hello.type !== "helloOk") throw connectionFailure("Unexpected response to hello.");
      connection.helloInfo = hello;
      transport.onHello?.(hello);
      connection.startKeepAlive(hello.udp?.sessionTimeoutMs ?? 0);
    } catch (error) {
      connection.abort();
      throw error;
    }
    return connection;
  }

  /** 서버가 협상한 프로토콜 정보이다. */
  get hello(): HelloOkResponse {
    if (this.helloInfo === null) throw new Error("The handshake is not complete.");
    return this.helloInfo;
  }

  /** 로그인한 세션의 정보이다. 로그인 전에는 null 이다. */
  get session(): SessionInfoMessage | null {
    return this.sessionInfo;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // -------------------------------------------------------------------------
  // 요청과 응답
  // -------------------------------------------------------------------------

  private handleMessage(body: Buffer): void {
    const decoded = decodeResponse(body);
    if (!decoded.ok) {
      this.failAll(connectionFailure(`Invalid response from the server: ${decoded.reason}`));
      this.transport.close();
      return;
    }
    const response = decoded.response;
    if (response.id === 0) {
      // 서버가 먼저 보낸 메시지이다. (유휴 시간 초과, 서버 종료) 서버는 곧 접속을 닫는다.
      if (response.type === "error") this.closedError = toDbError(response);
      this.failAll(this.closedError ?? connectionFailure("The server closed the connection."));
      return;
    }
    const waiting = this.pending.get(response.id);
    if (waiting === undefined) return; // 제한 시간이 지난 요청의 늦은 응답이다.
    this.pending.delete(response.id);
    if (waiting.timer !== null) clearTimeout(waiting.timer);
    if (response.type === "error") waiting.reject(toDbError(response));
    else waiting.resolve(response);
  }

  /**
   * UDP 접속은 서버가 `sessionTimeoutMs` 동안 패킷이 없으면 세션을 끝낸다. 유휴 상태에서 그 시간의 1/3 마다 ping 을 보내 세션을 유지한다.
   * ping 은 서버의 유휴 세션 종료(`session.idleTimeoutMs`)를 되돌리지 않는다.
   */
  private startKeepAlive(sessionTimeoutMs: number): void {
    if (sessionTimeoutMs <= 0) return;
    const interval = sessionTimeoutMs / 3;
    const timer = setInterval(() => {
      if (this.closed || this.pending.size > 0 || Date.now() - this.lastSentAt < interval) return;
      void this.ping().catch(() => undefined);
    }, Math.max(50, Math.floor(interval / 2)));
    timer.unref();
    this.keepAlive = timer;
  }

  private stopKeepAlive(): void {
    if (this.keepAlive !== null) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  }

  private handleClose(error: Error | null): void {
    this.closed = true;
    this.stopKeepAlive();
    this.failAll(this.closedError ?? (error instanceof DbError ? error : connectionFailure(error === null ? "The connection was closed." : error.message, error ?? undefined)));
  }

  private failAll(error: Error): void {
    for (const [id, waiting] of [...this.pending]) {
      this.pending.delete(id);
      if (waiting.timer !== null) clearTimeout(waiting.timer);
      waiting.reject(error);
    }
  }

  /** 요청을 보내고 같은 `id` 의 응답을 기다린다. 오류 응답은 `DbError` 로 거부된다. */
  request(message: Record<string, unknown> & { type: string }, timeoutMs: number | undefined = this.options.requestTimeoutMs): Promise<Response> {
    if (this.closed) return Promise.reject(this.closedError ?? connectionFailure("The connection is closed."));
    const id = this.nextId++;
    let body: Buffer;
    try {
      body = encodeMessage({ id, ...message });
    } catch (error) {
      return Promise.reject(error as Error);
    }
    return new Promise<Response>((resolve, reject) => {
      const waiting: Pending = { resolve, reject, timer: null };
      if (timeoutMs !== undefined) {
        waiting.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(connectionFailure(`No response from the server within ${timeoutMs} ms.`));
        }, timeoutMs);
      }
      this.pending.set(id, waiting);
      this.lastSentAt = Date.now();
      try {
        this.transport.send(body);
      } catch (error) {
        // 보낼 수 없는 메시지(예 : UDP 조각 수 한도 초과)이다. 기다리지 말고 바로 실패시킨다.
        this.pending.delete(id);
        if (waiting.timer !== null) clearTimeout(waiting.timer);
        reject(error as Error);
      }
    });
  }

  private async expect<T extends Response["type"]>(type: T, message: Record<string, unknown> & { type: string }): Promise<Extract<Response, { type: T }>> {
    const response = await this.request(message);
    if (response.type !== type) throw connectionFailure(`Unexpected response "${response.type}" to "${message.type}".`);
    return response as Extract<Response, { type: T }>;
  }

  // -------------------------------------------------------------------------
  // 인증
  // -------------------------------------------------------------------------

  /** SCRAM-SHA-256 으로 로그인한다. 비밀번호는 평문으로 오가지 않으며, 서버 서명을 검증해 서버를 확인한다. */
  async login(options: LoginOptions): Promise<SessionInfoMessage> {
    const clientNonce = generateNonce();
    const challenge = await this.expect("authChallenge", {
      type: "authStart",
      mechanism: AUTH_MECHANISM,
      clientFirst: clientFirstMessage(options.user, clientNonce),
      ...(options.tablespace === undefined ? {} : { tablespace: options.tablespace }),
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    });
    const parsed = parseServerFirst(challenge.serverFirst);
    // 서버 nonce 는 우리 nonce 로 시작해야 한다. 아니면 응답을 되돌려 보내는 공격일 수 있다.
    if (parsed === null || !parsed.nonce.startsWith(clientNonce) || parsed.nonce.length === clientNonce.length) {
      this.abort();
      throw connectionFailure("The server sent an invalid SCRAM challenge.");
    }
    const withoutProof = clientFinalWithoutProof(parsed.nonce);
    const message = authMessage(clientFirstBare(options.user, clientNonce), challenge.serverFirst, withoutProof);
    const proof = computeClientProof(options.password, parsed.salt, parsed.iterations, message);
    const ok = await this.expect("authOk", { type: "authFinish", clientFinal: `${withoutProof},p=${proof}` });
    const signature = ok.serverFinal.startsWith("v=") ? ok.serverFinal.slice(2) : "";
    if (signature === "" || !verifyServerSignature(options.password, parsed.salt, parsed.iterations, message, signature)) {
      this.abort();
      throw connectionFailure("The server could not prove that it knows the password; the connection was dropped.");
    }
    this.sessionInfo = ok.session;
    return ok.session;
  }

  // -------------------------------------------------------------------------
  // 문장 실행
  // -------------------------------------------------------------------------

  /**
   * 문장 하나를 실행한다. 조회 결과가 크면 첫 묶음과 `cursor`, `hasMore` 를 그대로 돌려주고,
   * 나머지는 `fetch` 로 가져간다. 전체가 필요하면 `fetchAll` 을 쓴다.
   */
  async execute(sql: string, params: readonly ClientParam[] = [], options: { fetchSize?: number } = {}): Promise<ExecuteOutcome> {
    const response = await this.request({
      type: "execute",
      sql,
      params: params.map((value, index) => encodeParam(value, index)),
      ...(options.fetchSize === undefined ? {} : { fetchSize: options.fetchSize }),
    });
    if (response.type === "rows") {
      return { kind: "rows", columns: response.columns ?? [], rows: response.rows, cursor: response.cursor ?? null, hasMore: response.hasMore };
    }
    if (response.type === "ok") {
      return { kind: "ok", message: response.message, rowCount: response.rowCount ?? null };
    }
    throw connectionFailure(`Unexpected response "${response.type}" to "execute".`);
  }

  /** 커서의 다음 행 묶음을 가져온다. */
  async fetch(cursor: number, fetchSize?: number): Promise<RowsBatch> {
    const response = await this.request({ type: "fetch", cursor, ...(fetchSize === undefined ? {} : { fetchSize }) });
    if (response.type !== "rows") throw connectionFailure(`Unexpected response "${response.type}" to "fetch".`);
    return { rows: response.rows, cursor: response.cursor ?? null, hasMore: response.hasMore };
  }

  async closeCursor(cursor: number): Promise<void> {
    await this.expect("cursorClosed", { type: "closeCursor", cursor });
  }

  /** `execute` 가 돌려준 조회 결과의 나머지 행을 모두 가져와 하나로 합친다. */
  async fetchAll(result: RowsResult, fetchSize?: number): Promise<RowsResult> {
    const rows = [...result.rows];
    let cursor = result.cursor;
    let hasMore = result.hasMore;
    while (hasMore && cursor !== null) {
      const batch = await this.fetch(cursor, fetchSize);
      rows.push(...batch.rows);
      cursor = batch.cursor;
      hasMore = batch.hasMore;
    }
    return { kind: "rows", columns: result.columns, rows, cursor: null, hasMore: false };
  }

  async ping(): Promise<void> {
    await this.expect("pong", { type: "ping" });
  }

  /**
   * 데몬 제어 요청이다. 로컬 전용 채널에서 `hello` 직후(로그인하지 않은 상태)에만 받는다.
   * 토큰은 데이터 디렉토리의 잠금 파일에 있는 값이다. `stop` 의 응답(`stopping`)을 받으면 서버가 접속을 닫는다.
   */
  async control(action: "status", token: string): Promise<StatusResponse>;
  async control(action: "stop", token: string): Promise<void>;
  async control(action: ControlAction, token: string): Promise<StatusResponse | void> {
    if (action === "status") return await this.expect("status", { type: "control", action, token });
    await this.expect("stopping", { type: "control", action, token });
  }

  /**
   * 정상적으로 접속을 끝낸다. 서버가 커밋하지 않은 변경을 롤백한다. 이미 닫혔으면 아무것도 하지 않는다.
   * 돌려주는 `rolledBack` 은 서버가 그런 변경을 실제로 롤백했는지이다. (서버의 응답을 받지 못했으면 false)
   */
  async close(): Promise<{ rolledBack: boolean }> {
    if (this.closed) return { rolledBack: false };
    let rolledBack = false;
    try {
      const response = await this.request({ type: "close" }, 2000);
      rolledBack = response.type === "bye" && response.rolledBack === true;
    } catch {
      // 이미 끊겼거나 응답이 없어도 닫는다.
    }
    this.abort();
    return { rolledBack };
  }

  /** 서버의 응답을 기다리지 않고 접속을 끊는다. */
  abort(): void {
    this.closed = true;
    this.stopKeepAlive();
    this.failAll(this.closedError ?? connectionFailure("The connection was closed."));
    this.transport.close();
  }
}
