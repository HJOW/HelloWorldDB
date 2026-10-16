/**
 * 메시지 처리기. 접속 경로와 무관하게 메시지 하나를 받아 응답을 만든다.
 *
 * 담당
 *  - 접속 하나의 진행 상태 : 핸드셰이크 → 인증(SCRAM-SHA-256) → 문장 실행
 *      NEW ─hello→ GREETED ─authStart→ CHALLENGED ─authFinish(성공)→ READY → CLOSED
 *    상태에 맞지 않는 메시지는 프로토콜 위반(08P01)으로 오류를 보내고 접속을 끊는다.
 *    인증 전에는 핸드셰이크와 인증 메시지만 받는다. 인증 전 메시지는 64 KiB, 인증 후는 16 MiB 까지이다.
 *  - 인증 실패는 사용자가 없는 경우와 비밀번호가 틀린 경우를 구분하지 않고 같은 오류(28000)로 답한다.
 *    없는 사용자에게도 가짜 검증 정보로 끝까지 진행하고, 실패하면 응답 전에 200 ms 늦춘 뒤 접속을 끊는다.
 *  - 세션은 `Database.connect` 한 곳에서 만든다. (로컬 판정, CONNECT 검사, 접속 수 제한)
 *  - 문장 실행, 다음 행 묶음 요청, 커서 닫기, ping, 접속 종료를 세션(session/session.ts)에 넘긴다.
 *  - 한 접속의 요청은 도착 순서대로 하나씩 처리한다. 앞 요청이 잠금을 기다리는 동안 뒤 요청은 대기열(최대 64개)에 둔다.
 *    `close` 는 대기열을 건너뛰고 바로 처리한다.
 *  - 오류를 SQLSTATE, 내부 오류 번호, 메시지(와 위치)를 담은 응답으로 바꾼다. 문장 오류는 접속을 끊지 않는다.
 *  - 세션이 유휴 시간 초과나 서버 종료로 닫히면 `id: 0` 오류를 보내고 접속을 닫는다.
 *  - 데몬 제어 요청(상태 조회, 종료) : 로컬 전용 채널의 GREETED 상태에서만 받고, 제어 토큰이 맞아야 처리한다.
 *
 * TCP, UDP, 로컬 전용 채널이 모두 이 처리기를 쓴다. 소켓, 프레임, 패킷은 다루지 않고 `ConnectionEndpoint` 로만 주고받는다.
 * `net` 은 `session` 과 `auth/scram` 만 부르고, 데몬 제어는 `daemon` 이 넘겨 주는 `ControlPort` 로 한다.
 *
 * 관련 사양 : AGENTS.md 상세 6, 8, 9, 14-1
 * 구현 단계 : 9단계 (9-4)
 */

import { timingSafeEqual } from "node:crypto";
import { DbError, ERROR_CODES, unsupportedFeature } from "../common/errors.js";
import { PRODUCT_NAME, RDBMS_VERSION } from "../common/instance.js";
import type { Logger } from "../common/logger.js";
import {
  DEFAULT_SCRAM_ITERATIONS,
  authMessage,
  computeServerSignature,
  decoyVerifier,
  generateNonce,
  isExpectedChannelBinding,
  parseClientFinal,
  parseClientFirst,
  serverFirstMessage,
  verifyClientProof,
} from "../auth/scram.js";
import type { ScramVerifier } from "../auth/scram.js";
import type { Database, ExecuteResult, Session, SessionCloseReason } from "../session/session.js";
import type { ConnectionLimits } from "./connectionLimits.js";
import { CursorStore } from "./cursors.js";
import {
  AUTH_MECHANISM,
  DEFAULT_FETCH_SIZE,
  FETCH_SOFT_LIMIT_BYTES,
  MAX_FETCH_SIZE,
  MAX_MESSAGE_BYTES,
  MAX_PENDING_REQUESTS,
  MAX_PREAUTH_MESSAGE_BYTES,
  MESSAGE_ENVELOPE_RESERVE,
  SERVER_MESSAGE_ID,
  SUPPORTED_PROTOCOL_VERSIONS,
  assertMessageSize,
  decodeRequest,
  encodeMessage,
  errorResponse,
  protocolViolation,
} from "./protocol.js";
import type {
  AuthFinishRequest,
  AuthStartRequest,
  Channel,
  ControlRequest,
  ExecuteRequest,
  FetchRequest,
  HelloRequest,
  Request,
  Response,
  SessionInfoMessage,
  StatusResponse,
} from "./protocol.js";
import { columnMeta, decodeParams, encodeBatch } from "./resultEncoder.js";

/** 접속 경로 모듈이 처리기에 제공하는 것이다. 처리기는 소켓, 프레임, 패킷을 모른다. */
export interface ConnectionEndpoint {
  readonly channel: Channel;
  /** 상대 주소(포트 없음)이다. 로컬 전용 채널이면 null 이다. */
  readonly remoteAddress: string | null;
  /** 응답 메시지 하나(JSON 본문)를 보낸다. 프레임이나 조각 나누기는 접속 경로 모듈이 한다. */
  send(body: Buffer): void;
  /**
   * 보낸 것을 모두 내보낸 뒤 접속을 닫는다. `flush: false` 이면 보낼 것이 남아 있어도 기다리지 않고 바로 닫는다.
   * (보낼 응답이 없는 시간 초과 종료 등. UDP 에서 상대의 ACK 를 기다리느라 세션이 남지 않게 한다)
   */
  close(options?: { flush?: boolean }): void;
  /** 보내기가 밀려 있으면 풀릴 때까지 기다린다. 처리기는 다음 요청을 처리하기 전에 이것을 기다린다. 생략하면 기다리지 않는다. */
  drained?(): Promise<void>;
}

/** 데몬 제어에 쓰는 상태 정보이다. daemon/server.ts 의 `ServerStatus` 와 같은 모양이다. */
export type ControlStatus = Omit<StatusResponse, "id" | "type">;

/** 데몬이 통신 계층에 넘겨 주는 제어 창구이다. `net` 이 `daemon` 을 import 하지 않게 한다. */
export interface ControlPort {
  /** 잠금 파일의 제어 토큰이다. */
  controlToken(): string;
  status(): ControlStatus;
  /** 종료 절차를 비동기로 시작한다. 바로 돌아온다. */
  requestStop(): void;
}

/** 구동할 때 서버가 만들어 모든 접속에 공통으로 넘기는 것이다. */
export interface HandlerEnvironment {
  database: Database;
  /** 제어 요청을 받을 수 없는 구성(시험 등)이면 null 이다. */
  control: ControlPort | null;
  limits: ConnectionLimits;
  logger: Logger;
  /** 없는 사용자에게 줄 가짜 검증 정보의 솔트를 정하는 비밀값이다. 구동 때 무작위로 만든다. */
  decoySecret: Buffer;
  /** UDP 접속의 `helloOk` 에 싣는 값이다. */
  udp?: { sessionTimeoutMs: number; maxPacketSize: number };
}

type State = "new" | "greeted" | "challenged" | "ready" | "closed";

type QueueItem =
  | { kind: "request"; request: Request }
  | { kind: "invalid"; id: number | null; error: DbError; fatal: boolean };

interface AuthState {
  user: string;
  /** 사용자가 실제로 있는지이다. 없으면 가짜 검증 정보로 진행하고 어떤 증명도 통과시키지 않는다. */
  real: boolean;
  verifier: ScramVerifier;
  clientFirstBare: string;
  serverFirst: string;
  combinedNonce: string;
  tablespace: string | undefined;
  timeZone: string | undefined;
}

/** 서버가 보낸 메시지를 로그에 남길 때 줄바꿈과 긴 이름을 다듬는다. */
function describeName(name: string): string {
  return JSON.stringify(name.length > 64 ? `${name.slice(0, 64)}...` : name);
}

function clampFetchSize(requested: number | undefined): number {
  return Math.min(requested ?? DEFAULT_FETCH_SIZE, MAX_FETCH_SIZE);
}

export class MessageHandler {
  private state: State = "new";
  private session: Session | null = null;
  private auth: AuthState | null = null;
  private readonly cursors = new CursorStore();
  private readonly queue: QueueItem[] = [];
  private pumping = false;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private releasePreAuth: (() => void) | null;
  private disposed = false;

  private constructor(
    private readonly env: HandlerEnvironment,
    private readonly endpoint: ConnectionEndpoint,
    releasePreAuth: (() => void) | null,
  ) {
    this.releasePreAuth = releasePreAuth;
    this.armAuthTimer();
  }

  /**
   * 접속 하나에 처리기를 만든다. TCP, UDP 접속은 인증 전 접속 수 제한을 받으며, 가득 찼으면 null 이다.
   * (호출자는 오류 메시지를 보내지 않고 접속을 바로 닫는다. 불필요한 응답을 만들지 않기 위함이다)
   * 로컬 전용 채널은 제한을 받지 않는다.
   */
  static open(env: HandlerEnvironment, endpoint: ConnectionEndpoint): MessageHandler | null {
    let release: (() => void) | null = null;
    if (endpoint.channel !== "local") {
      release = env.limits.tryAcquirePreAuth();
      if (release === null) {
        env.logger.warn(`Too many unauthenticated connections; refusing a ${endpoint.channel} connection from ${endpoint.remoteAddress ?? "-"}.`);
        return null;
      }
    }
    return new MessageHandler(env, endpoint, release);
  }

  /** 지금 상태에서 받을 수 있는 메시지의 최대 크기이다. 프레임 해석기와 UDP 재조립이 길이를 읽자마자 비교한다. */
  get maxBodyBytes(): number {
    return this.state === "ready" ? MAX_MESSAGE_BYTES : MAX_PREAUTH_MESSAGE_BYTES;
  }

  /** 인증을 마친 세션이다. 시험과 UDP 서버가 쓴다. */
  get currentSession(): Session | null {
    return this.session;
  }

  get isClosed(): boolean {
    return this.state === "closed";
  }

  /** 요청을 처리하고 있거나 처리를 기다리는 요청이 있는지 본다. (UDP 서버가 문장 실행 중인 세션을 시간 제한에서 빼는 데 쓴다) */
  get busy(): boolean {
    return this.pumping || this.queue.length > 0;
  }

  /** 접속 경로 모듈이 프레임 해석이나 조각 재조립을 마친 메시지 본문 하나를 넘긴다. 동기로 대기열에 넣고 바로 돌아온다. */
  receive(body: Buffer): void {
    if (this.state === "closed") return;
    const decoded = decodeRequest(body);
    if (decoded.ok && decoded.request.type === "close" && this.state !== "new") {
      // 대기열을 건너뛰어 바로 처리한다. 앞 요청이 잠금을 기다리고 있어도 접속을 끝낼 수 있어야 한다.
      this.handleClose(decoded.request.id);
      return;
    }
    if (this.queue.length >= MAX_PENDING_REQUESTS) {
      this.closeWith(
        0,
        new DbError("53400", ERROR_CODES.CONFIGURATION_LIMIT_EXCEEDED, `Too many pending requests: at most ${MAX_PENDING_REQUESTS} per connection.`),
      );
      return;
    }
    this.queue.push(decoded.ok ? { kind: "request", request: decoded.request } : { kind: "invalid", id: decoded.id, error: decoded.error, fatal: decoded.fatal });
    this.pump();
  }

  /** 프레임 규칙이나 UDP 조립 규칙을 어긴 입력을 접속 경로 모듈이 알린다. 오류를 보내고 접속을 끊는다. */
  protocolFailure(message: string): void {
    if (this.state === "closed") return;
    this.closeWith(SERVER_MESSAGE_ID, protocolViolation(message));
  }

  /**
   * 접속이 사라졌을 때 부른다. 세션을 닫고(커밋하지 않은 변경은 롤백, 잠금 해제, 잠금 대기 취소) 커서와 타이머를 정리한다.
   * 여러 번 불러도 한 번만 처리한다. 모든 종료 경로가 이곳으로 모인다.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const wasReady = this.state === "ready";
    this.state = "closed";
    this.queue.length = 0;
    this.clearAuthTimer();
    this.releaseSlot();
    this.cursors.clear();
    this.auth = null;
    const session = this.session;
    this.session = null;
    if (session !== null && !session.isClosed) session.close("closed");
    if (wasReady && session !== null) {
      this.env.logger.info(`Session ${session.id} closed: user=${session.user} channel=${this.endpoint.channel}`);
    }
  }

  // -------------------------------------------------------------------------
  // 보내기, 닫기
  // -------------------------------------------------------------------------

  private send(response: Response): void {
    if (this.state === "closed") return;
    this.endpoint.send(encodeMessage(response));
  }

  private sendError(id: number, error: DbError): void {
    this.send(errorResponse(id, error));
  }

  /** 오류를 보내고 접속을 닫는다. */
  private closeWith(id: number, error: DbError): void {
    if (this.state === "closed") return;
    try {
      this.endpoint.send(encodeMessage(errorResponse(id, error)));
    } finally {
      this.endpoint.close();
      this.dispose();
    }
  }

  /** 응답 없이 접속을 닫는다. */
  private closeSilently(): void {
    if (this.state === "closed") return;
    this.endpoint.close({ flush: false });
    this.dispose();
  }

  private internalFailure(error: unknown): void {
    this.env.logger.error(`Unexpected error in the message handler: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    // 스택이나 내부 경로는 응답에 싣지 않는다.
    this.closeWith(SERVER_MESSAGE_ID, new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, "Internal error."));
  }

  private armAuthTimer(): void {
    this.authTimer = setTimeout(() => {
      this.authTimer = null;
      if (this.state === "closed" || this.state === "ready") return;
      this.env.logger.warn(`Closing a ${this.endpoint.channel} connection from ${this.endpoint.remoteAddress ?? "-"}: authentication was not completed in time.`);
      // 시간 초과는 응답 없이 닫는다.
      this.closeSilently();
    }, this.env.limits.authTimeoutMs);
    this.authTimer.unref();
  }

  private clearAuthTimer(): void {
    if (this.authTimer !== null) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }

  private releaseSlot(): void {
    if (this.releasePreAuth !== null) {
      this.releasePreAuth();
      this.releasePreAuth = null;
    }
  }

  // -------------------------------------------------------------------------
  // 대기열
  // -------------------------------------------------------------------------

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void (async () => {
      try {
        while (this.queue.length > 0 && !this.isClosed) {
          // 보내기가 밀려 있으면 풀릴 때까지 다음 요청을 처리하지 않는다. (메모리 폭주 방지)
          await this.endpoint.drained?.();
          if (this.isClosed) break;
          const item = this.queue.shift() as QueueItem;
          await this.process(item);
        }
      } catch (error) {
        this.internalFailure(error);
      } finally {
        this.pumping = false;
      }
    })();
  }

  private async process(item: QueueItem): Promise<void> {
    if (item.kind === "invalid") {
      if (item.fatal || this.state !== "ready") {
        this.closeWith(item.id ?? SERVER_MESSAGE_ID, item.error);
      } else {
        this.sendError(item.id ?? SERVER_MESSAGE_ID, item.error);
      }
      return;
    }
    const request = item.request;
    switch (request.type) {
      case "hello":
        if (this.state === "new") return this.onHello(request);
        break;
      case "authStart":
        if (this.state === "greeted") return this.onAuthStart(request);
        break;
      case "authFinish":
        if (this.state === "challenged") return await this.onAuthFinish(request);
        break;
      case "control":
        return this.onControl(request);
      case "execute":
        if (this.state === "ready") return await this.onExecute(request);
        break;
      case "fetch":
        if (this.state === "ready") return this.onFetch(request);
        break;
      case "closeCursor":
        if (this.state === "ready") return this.onCloseCursor(request.id, request.cursor);
        break;
      case "ping":
        if (this.state === "ready") return this.send({ id: request.id, type: "pong" });
        break;
      case "close":
        // NEW 가 아닌 상태에서 온 close 는 보통 receive 가 바로 처리한다. 대기열에서 상태가 바뀐 경우를 위해 여기서도 받는다.
        if (this.state !== "new") return this.handleClose(request.id);
        break;
    }
    this.closeWith(request.id, protocolViolation(`Message "${request.type}" is not allowed in this state.`));
  }

  // -------------------------------------------------------------------------
  // 핸드셰이크와 인증
  // -------------------------------------------------------------------------

  private onHello(request: HelloRequest): void {
    const common = request.versions.filter((version) => SUPPORTED_PROTOCOL_VERSIONS.includes(version));
    if (common.length === 0) {
      this.closeWith(
        request.id,
        unsupportedFeature(`No common protocol version: the server supports ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`),
      );
      return;
    }
    const mechanisms = request.mechanisms ?? [AUTH_MECHANISM];
    if (!mechanisms.includes(AUTH_MECHANISM)) {
      this.closeWith(request.id, unsupportedFeature(`No common authentication mechanism: the server supports ${AUTH_MECHANISM}.`));
      return;
    }
    // 이미 가득 찼으면 일찍 거절한다. 마지막 확인은 세션을 만드는 Database.connect 가 한다.
    if (this.endpoint.channel !== "local" && this.env.database.isConnectionLimitReached()) {
      this.closeWith(
        request.id,
        new DbError("53300", ERROR_CODES.TOO_MANY_CONNECTIONS, `Too many connections: the limit is ${String(this.env.database.maxConnections)} (maxConnections).`),
      );
      return;
    }
    this.state = "greeted";
    this.send({
      id: request.id,
      type: "helloOk",
      version: Math.max(...common),
      server: `${PRODUCT_NAME} ${RDBMS_VERSION}`,
      mechanism: AUTH_MECHANISM,
      maxMessageBytes: MAX_MESSAGE_BYTES,
      defaultFetchSize: DEFAULT_FETCH_SIZE,
      ...(this.endpoint.channel === "udp" && this.env.udp !== undefined ? { udp: this.env.udp } : {}),
    });
  }

  /** 정확히 같은 이름을 먼저 찾고, 없으면 대문자로 바꾼 이름을 찾는다. (따옴표 없는 식별자는 대문자로 저장되기 때문이다) */
  private resolveUserName(name: string): string | undefined {
    const users = this.env.database.users;
    if (users.has(name)) return name;
    const upper = name.toUpperCase();
    return users.has(upper) ? upper : undefined;
  }

  private onAuthStart(request: AuthStartRequest): void {
    if (request.mechanism !== AUTH_MECHANISM) {
      this.closeWith(request.id, protocolViolation(`Unsupported authentication mechanism: ${describeName(request.mechanism)}.`));
      return;
    }
    const parsed = parseClientFirst(request.clientFirst);
    if (parsed === null) {
      this.closeWith(request.id, protocolViolation("Malformed SCRAM client-first message."));
      return;
    }
    const database = this.env.database;
    const resolved = this.resolveUserName(parsed.userName);
    let verifier = resolved === undefined ? undefined : database.users.verifierOf(resolved);
    const real = verifier !== undefined;
    if (verifier === undefined) {
      // 없는 사용자도 같은 절차로 진행한다. 반복 횟수는 SYSTEM 계정의 것과 맞추어 응답으로 존재를 알 수 없게 한다.
      const iterations = database.users.verifierOf("SYSTEM")?.iterations ?? DEFAULT_SCRAM_ITERATIONS;
      verifier = decoyVerifier(parsed.userName, this.env.decoySecret, iterations);
    }
    const combinedNonce = `${parsed.nonce}${generateNonce()}`;
    const serverFirst = serverFirstMessage(combinedNonce, verifier);
    this.auth = {
      user: resolved ?? parsed.userName,
      real,
      verifier,
      clientFirstBare: parsed.bare,
      serverFirst,
      combinedNonce,
      tablespace: request.tablespace,
      timeZone: request.timeZone,
    };
    this.state = "challenged";
    this.send({ id: request.id, type: "authChallenge", serverFirst });
  }

  private async onAuthFinish(request: AuthFinishRequest): Promise<void> {
    const auth = this.auth as AuthState;
    const parsed = parseClientFinal(request.clientFinal);
    if (parsed === null) {
      this.closeWith(request.id, protocolViolation("Malformed SCRAM client-final message."));
      return;
    }
    const message = authMessage(auth.clientFirstBare, auth.serverFirst, parsed.withoutProof);
    // 사용자가 없는 경우도 같은 계산을 한다. 결과는 마지막에 합친다.
    const proofOk = verifyClientProof(auth.verifier, message, parsed.proof);
    const bindingOk = isExpectedChannelBinding(parsed.channelBinding);
    const nonceOk = parsed.nonce === auth.combinedNonce;
    if (!(auth.real && proofOk && bindingOk && nonceOk)) {
      // 응답은 사용자 없음, 비밀번호 틀림, nonce 불일치 모두 같다. 원인은 서버 로그에만 남긴다.
      const reason = !auth.real ? "no such user" : !nonceOk ? "nonce mismatch" : !bindingOk ? "channel binding mismatch" : "wrong password";
      this.env.logger.warn(`Authentication failed: user=${describeName(auth.user)} channel=${this.endpoint.channel} address=${this.endpoint.remoteAddress ?? "-"}`);
      this.env.logger.debug(`Authentication failure reason: ${reason}`);
      await this.env.limits.sleep(this.env.limits.authFailureDelayMs);
      this.closeWith(request.id, new DbError("28000", ERROR_CODES.AUTHENTICATION_FAILED, "Authentication failed."));
      return;
    }
    let session: Session;
    try {
      session = this.env.database.connect({
        user: auth.user,
        tablespace: auth.tablespace,
        timeZone: auth.timeZone,
        channel: this.endpoint.channel,
        remoteAddress: this.endpoint.remoteAddress,
      });
    } catch (error) {
      if (error instanceof DbError) {
        this.env.logger.warn(`Connection refused after authentication: user=${describeName(auth.user)} [${error.sqlState}:${error.code}] ${error.message}`);
        this.closeWith(request.id, error);
        return;
      }
      throw error;
    }
    if (this.state === "closed") {
      // 인증 확인 중에 접속이 사라졌다.
      session.close("closed");
      return;
    }
    this.session = session;
    this.auth = null;
    this.state = "ready";
    this.clearAuthTimer();
    this.releaseSlot();
    session.onClose((reason) => this.onSessionClosed(reason));
    this.env.logger.info(`Session ${session.id} opened: user=${session.user} channel=${this.endpoint.channel} address=${this.endpoint.remoteAddress ?? "-"}`);
    this.send({
      id: request.id,
      type: "authOk",
      serverFinal: `v=${computeServerSignature(auth.verifier.serverKey, message)}`,
      session: sessionInfo(session),
    });
  }

  /** 세션이 우리 쪽 요청이 아닌 이유(유휴, 서버 종료)로 닫혔을 때 불린다. */
  private onSessionClosed(reason: SessionCloseReason): void {
    if (this.state === "closed") return;
    if (reason === "idle") {
      this.closeWith(
        SERVER_MESSAGE_ID,
        new DbError("57P05", ERROR_CODES.IDLE_TIMEOUT, "Session was closed because it was idle for too long."),
      );
    } else if (reason === "shutdown") {
      this.closeWith(SERVER_MESSAGE_ID, new DbError("57P01", ERROR_CODES.SESSION_CLOSED, "Server is shutting down."));
    } else {
      this.closeSilently();
    }
  }

  // -------------------------------------------------------------------------
  // 접속 종료와 제어
  // -------------------------------------------------------------------------

  private handleClose(id: number): void {
    if (this.state === "closed") return;
    // 세션을 닫으면 커밋하지 않은 변경이 롤백된다. 클라이언트(hwdb 등)가 알릴 수 있게 닫기 전에 있었는지 알려 준다.
    const rolledBack = this.session?.hasUncommittedChanges ?? false;
    try {
      this.endpoint.send(encodeMessage({ id, type: "bye", ...(rolledBack ? { rolledBack: true } : {}) }));
    } finally {
      this.endpoint.close();
      this.dispose();
    }
  }

  private onControl(request: ControlRequest): void {
    const control = this.env.control;
    if (this.endpoint.channel !== "local" || this.state !== "greeted" || control === null) {
      // 다른 접속 경로, 다른 상태, 제어 창구가 없는 구성에서는 받지 않는다. READY 세션은 유지한다.
      const error = new DbError("42501", ERROR_CODES.INSUFFICIENT_PRIVILEGE, "Control requests are accepted only on the local-only channel before authentication.");
      if (this.state === "ready") this.sendError(request.id, error);
      else this.closeWith(request.id, error);
      return;
    }
    const given = Buffer.from(request.token, "utf8");
    const expected = Buffer.from(control.controlToken(), "utf8");
    const valid = given.length === expected.length && timingSafeEqual(given, expected);
    if (!valid) {
      // 로그에 토큰을 남기지 않는다.
      this.env.logger.warn("A control request with an invalid token was refused.");
      this.closeWith(request.id, new DbError("28000", ERROR_CODES.AUTHENTICATION_FAILED, "Authentication failed."));
      return;
    }
    if (request.action === "status") {
      this.send({ id: request.id, type: "status", ...control.status() });
      return;
    }
    // 응답을 보내고 flush 한 뒤 종료 절차를 시작한다. (응답 없이 끊겨 hwdb stop 이 기다리지 않게)
    this.endpoint.send(encodeMessage({ id: request.id, type: "stopping" }));
    this.endpoint.close();
    this.dispose();
    this.env.logger.info("A stop request was received on the local-only channel.");
    control.requestStop();
  }

  // -------------------------------------------------------------------------
  // 문장 실행과 커서
  // -------------------------------------------------------------------------

  private async onExecute(request: ExecuteRequest): Promise<void> {
    const session = this.session as Session;
    let result: ExecuteResult;
    try {
      const params = decodeParams(request.params);
      this.env.logger.debug(`Session ${session.id} execute: ${request.sql}`);
      result = await session.executeAsync(request.sql, params);
    } catch (error) {
      // 세션이 실행 중에 닫혔으면(연결 끊김, 유휴, 종료) 응답할 곳이 없다.
      if (this.state === "closed") return;
      if (error instanceof DbError) {
        this.sendError(request.id, error);
        return;
      }
      throw error;
    }
    if (this.state === "closed") return;
    if (result.kind === "ok") {
      this.send({ id: request.id, type: "ok", message: result.message, ...(result.rowCount === undefined ? {} : { rowCount: result.rowCount }) });
      return;
    }
    try {
      this.sendFirstBatch(request, result);
    } catch (error) {
      if (error instanceof DbError) {
        this.sendError(request.id, error);
        return;
      }
      throw error;
    }
  }

  /** 조회 결과의 첫 묶음을 보낸다. 남은 행이 있으면 커서를 열어 둔다. */
  private sendFirstBatch(request: ExecuteRequest, result: Extract<ExecuteResult, { kind: "select" }>): void {
    const types = result.columns.map((column) => column.dataType);
    const columnsJson = JSON.stringify(result.columns.map((column) => columnMeta(column.name, column.dataType)));
    const reserve = MESSAGE_ENVELOPE_RESERVE + Buffer.byteLength(columnsJson, "utf8");
    const batch = encodeBatch(result.rows, types, 0, clampFetchSize(request.fetchSize), FETCH_SOFT_LIMIT_BYTES, reserve);
    const hasMore = batch.next < result.rows.length;
    const cursor = hasMore ? this.cursors.open(types, result.rows, batch.next) : undefined;
    this.sendRows(request.id, columnsJson, batch.encodedRows, cursor, hasMore);
  }

  private onFetch(request: FetchRequest): void {
    const cursor = this.cursors.get(request.cursor);
    if (cursor === undefined) {
      this.sendError(request.id, new DbError("34000", ERROR_CODES.CURSOR_NOT_FOUND, `Cursor does not exist: ${request.cursor}.`));
      return;
    }
    let batch;
    try {
      batch = encodeBatch(cursor.rows, cursor.types, cursor.next, clampFetchSize(request.fetchSize), FETCH_SOFT_LIMIT_BYTES);
    } catch (error) {
      if (error instanceof DbError) {
        this.sendError(request.id, error);
        return;
      }
      throw error;
    }
    cursor.next = batch.next;
    const hasMore = cursor.next < cursor.rows.length;
    // 마지막 묶음이면 서버가 커서를 지운다.
    if (!hasMore) this.cursors.close(cursor.id);
    this.sendRows(request.id, null, batch.encodedRows, hasMore ? cursor.id : undefined, hasMore);
  }

  private onCloseCursor(id: number, cursor: number): void {
    this.cursors.close(cursor);
    this.send({ id, type: "cursorClosed" });
  }

  /** `rows` 응답을 만든다. 이미 인코딩한 행을 다시 인코딩하지 않고 그대로 이어 붙인다. */
  private sendRows(id: number, columnsJson: string | null, encodedRows: string[], cursor: number | undefined, hasMore: boolean): void {
    if (this.state === "closed") return;
    const text =
      `{"id":${id},"type":"rows",` +
      (columnsJson === null ? "" : `"columns":${columnsJson},`) +
      `"rows":[${encodedRows.join(",")}],` +
      (cursor === undefined ? "" : `"cursor":${cursor},`) +
      `"hasMore":${hasMore ? "true" : "false"}}`;
    this.endpoint.send(assertMessageSize(Buffer.from(text, "utf8")));
  }
}

function sessionInfo(session: Session): SessionInfoMessage {
  return {
    id: session.id,
    user: session.user,
    tablespace: session.currentTablespace === "" ? null : session.currentTablespace,
    timeZone: session.timeZone,
    autocommit: session.autocommit,
  };
}
