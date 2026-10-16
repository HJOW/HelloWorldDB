/**
 * 프로토콜 계층의 접속 하나 (저수준).
 *
 * 담당
 *  - TCP(SSL 포함) 또는 UDP 로 연결하고 핸드셰이크(`hello`)와 프로토콜 버전 협상을 한다.
 *  - SCRAM-SHA-256 인증. 서버 nonce 와 반복 횟수를 확인하고, 서버가 보낸 서명을 검증해 서버를 확인한다.
 *  - 문장 실행(`execute`)과 `?` 파라미터 전달, 결과를 fetch 단위로 나누어 받기, 커서 닫기, ping, 접속 종료.
 *  - 요청과 응답을 `id` 로 짝짓는다. 접속이 끊기면 기다리던 모든 요청을 08006 으로 실패시키고,
 *    서버가 먼저 보낸 `id: 0` 오류(유휴 시간 초과 57P05, 서버 종료 57P01)는 그 오류로 실패시킨다.
 *  - UDP 접속은 유휴 상태에서 세션 시간 제한의 1/3 마다 ping 을 보내 세션을 유지한다.
 *
 * 값은 JSON 값 그대로 다룬다. 타입 변환(`bigint`, `Buffer` 등)은 한 층 위(values.ts, connection.ts)가 한다.
 * 공개 API 가 아니다. 사용자는 `Connection` 을 쓴다.
 *
 * 관련 사양 : AGENTS.md 상세 8, 15 / rdbms/docs/protocol.md 3 ~ 10, 15절
 * 구현 단계 : 12-2
 */

import { DbError, connectionFailure } from "../errors.js";
import { connectTcp } from "../transport/tcpTransport.js";
import type { InternalTransportOptions, MessageTransport, SslOptions } from "../transport/tcpTransport.js";
import { connectUdp } from "../transport/udpTransport.js";
import { AUTH_MECHANISM, PROTOCOL_VERSION, decodeResponse, encodeMessage, toDbError } from "./messages.js";
import type { ColumnMeta, HelloOkResponse, JsonValue, ParamValue, Response, SessionInfoMessage } from "./messages.js";
import { authMessage, clientFinalWithoutProof, clientFirstBare, clientFirstMessage, computeClientProof, generateNonce, parseServerFirst, verifyServerSignature } from "./scram.js";

export type Target =
  | { kind: "tcp"; host: string; port: number; ssl?: SslOptions }
  | { kind: "udp"; host: string; port: number };

export interface ProtocolOptions {
  /** 연결과 핸드셰이크의 제한 시간(ms)이다. */
  connectTimeoutMs: number;
  /** 요청마다 응답을 기다리는 제한 시간(ms)이다. 없으면 기다린다. (문장이 잠금을 기다리면 30초까지 걸릴 수 있다) */
  requestTimeoutMs?: number;
  /** `hello` 에 싣는 클라이언트 이름이다. */
  clientName: string;
  /** 시험에서만 쓰는 내부 옵션이다. */
  internal?: InternalTransportOptions;
}

export interface LoginParams {
  user: string;
  password: string;
  tablespace?: string;
  timeZone?: string;
}

export interface RawRows {
  columns: ColumnMeta[];
  rows: JsonValue[][];
  /** 남은 행이 있을 때의 커서 번호이다. 없으면 null 이다. */
  cursor: number | null;
  hasMore: boolean;
}

export interface RawOk {
  message: string;
  rowCount: number | null;
}

export type RawOutcome = ({ kind: "rows" } & RawRows) | ({ kind: "ok" } & RawOk);

export interface RawBatch {
  rows: JsonValue[][];
  cursor: number | null;
  hasMore: boolean;
}

interface Pending {
  resolve(response: Response): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class ProtocolConnection {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  /** 이쪽에서 접속을 끝내기로 한 뒤이다. 이 뒤의 전송 계층 닫힘은 예상한 것이다. */
  private closing = false;
  private closedError: DbError | null = null;
  private helloInfo: HelloOkResponse | null = null;
  private sessionInfo: SessionInfoMessage | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private lastSentAt = Date.now();
  private closeListener: ((error: DbError | null) => void) | null = null;

  private constructor(
    private readonly transport: MessageTransport,
    private readonly options: ProtocolOptions,
  ) {
    transport.setHandlers({
      onMessage: (body) => this.handleMessage(body),
      onClose: (error) => this.handleClose(error),
    });
  }

  /** 연결하고 핸드셰이크(`hello`)까지 마친다. 로그인은 `login` 으로 따로 한다. */
  static async open(target: Target, options: ProtocolOptions): Promise<ProtocolConnection> {
    const transport =
      target.kind === "tcp"
        ? await connectTcp(target.host, target.port, target.ssl, options.connectTimeoutMs, options.internal)
        : await connectUdp(target.host, target.port);
    const connection = new ProtocolConnection(transport, options);
    try {
      // 서버가 응답하지 않는 경우(UDP 에서 서버가 없을 때 등)를 연결 제한 시간 안에 알아차린다.
      const hello = await connection.request({ type: "hello", versions: [PROTOCOL_VERSION], client: options.clientName }, options.connectTimeoutMs);
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

  /** 서버가 먼저 보낸 오류(유휴 시간 초과, 서버 종료)이다. 없으면 null 이다. */
  get serverClosedError(): DbError | null {
    return this.closedError;
  }

  /** 접속이 끝났을 때 한 번 부를 함수를 정한다. 오류 때문에 끝났으면 그 오류가 있다. */
  onClose(listener: (error: DbError | null) => void): void {
    this.closeListener = listener;
    if (this.closed) this.notifyClose(this.closedError);
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
    const reason = this.closedError ?? (error instanceof DbError ? error : connectionFailure(error === null ? "The server closed the connection." : error.message, error ?? undefined));
    this.failAll(reason);
    // 이쪽이 끝내기로 하지 않았는데 닫혔다면 오류이다. (서버가 끊었다)
    this.notifyClose(this.closedError ?? (error !== null || !this.closing ? reason : null));
  }

  private notifyClose(error: DbError | null): void {
    const listener = this.closeListener;
    this.closeListener = null;
    listener?.(error);
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
  async login(params: LoginParams): Promise<SessionInfoMessage> {
    const clientNonce = generateNonce();
    const challenge = await this.expect("authChallenge", {
      type: "authStart",
      mechanism: AUTH_MECHANISM,
      clientFirst: clientFirstMessage(params.user, clientNonce),
      ...(params.tablespace === undefined ? {} : { tablespace: params.tablespace }),
      ...(params.timeZone === undefined ? {} : { timeZone: params.timeZone }),
    });
    const parsed = parseServerFirst(challenge.serverFirst);
    // 서버 nonce 는 우리 nonce 로 시작해야 한다. 아니면 응답을 되돌려 보내는 공격일 수 있다.
    if (parsed === null || !parsed.nonce.startsWith(clientNonce) || parsed.nonce.length === clientNonce.length) {
      this.abort();
      throw connectionFailure("The server sent an invalid SCRAM challenge.");
    }
    const withoutProof = clientFinalWithoutProof(parsed.nonce);
    const message = authMessage(clientFirstBare(params.user, clientNonce), challenge.serverFirst, withoutProof);
    const proof = computeClientProof(params.password, parsed.salt, parsed.iterations, message);
    const ok = await this.expect("authOk", { type: "authFinish", clientFinal: `${withoutProof},p=${proof}` });
    const signature = ok.serverFinal.startsWith("v=") ? ok.serverFinal.slice(2) : "";
    if (signature === "" || !verifyServerSignature(params.password, parsed.salt, parsed.iterations, message, signature)) {
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
   * 문장 하나를 실행한다. 조회 결과가 크면 첫 묶음과 `cursor`, `hasMore` 를 그대로 돌려주고, 나머지는 `fetch` 로 가져간다.
   */
  async execute(sql: string, params: readonly ParamValue[], fetchSize?: number): Promise<RawOutcome> {
    const response = await this.request({ type: "execute", sql, params, ...(fetchSize === undefined ? {} : { fetchSize }) });
    if (response.type === "rows") {
      return { kind: "rows", columns: response.columns ?? [], rows: response.rows, cursor: response.cursor ?? null, hasMore: response.hasMore };
    }
    if (response.type === "ok") return { kind: "ok", message: response.message, rowCount: response.rowCount ?? null };
    throw connectionFailure(`Unexpected response "${response.type}" to "execute".`);
  }

  /** 커서의 다음 행 묶음을 가져온다. */
  async fetch(cursor: number, fetchSize?: number): Promise<RawBatch> {
    const response = await this.request({ type: "fetch", cursor, ...(fetchSize === undefined ? {} : { fetchSize }) });
    if (response.type !== "rows") throw connectionFailure(`Unexpected response "${response.type}" to "fetch".`);
    return { rows: response.rows, cursor: response.cursor ?? null, hasMore: response.hasMore };
  }

  async closeCursor(cursor: number): Promise<void> {
    await this.expect("cursorClosed", { type: "closeCursor", cursor });
  }

  async ping(): Promise<void> {
    await this.expect("pong", { type: "ping" });
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
    const wasClosed = this.closed;
    this.closing = true;
    this.closed = true;
    this.stopKeepAlive();
    this.failAll(this.closedError ?? connectionFailure("The connection was closed."));
    this.transport.close();
    if (!wasClosed) this.notifyClose(this.closedError);
  }
}
