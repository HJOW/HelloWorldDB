/**
 * UDP 접속 경로.
 *
 * 담당
 *  - 설정의 `port` 와 `udp.host` 로 UDP 패킷을 받는다. `udp.enabled` 가 false 면 열지 않는다(서버 조립이 판단한다).
 *    포트 번호는 TCP 와 같다. 열지 못하면 구동에 실패한다.
 *  - 세션 식별 : 클라이언트의 `SYN|DATA`(세션 번호 0)로 세션이 열린다. 서버가 **암호학적 난수로 0 이 아닌 32비트 세션 번호**를 발급하고,
 *    이후에는 세션 번호와 출발지 주소(IP:포트)가 **모두** 맞을 때만 받아들인다. 주소가 다르면 응답 없이 버린다.
 *    모르는 세션 번호에는 `RST` 로 답한다. (헤더 20바이트뿐이라 증폭이 없다)
 *  - 같은 주소에서 세션을 여는 `SYN` 이 다시 오면(응답이 유실되어 클라이언트가 다시 보낸 것) 대기 중인 세션으로 보낸다.
 *    인증을 마친 세션이 있는 주소에서 새 `SYN` 이 오면 새 접속으로 보고 옛 세션을 닫는다. (같은 포트를 다시 쓴 새 프로세스)
 *  - 신뢰성 계층(udpReliability.ts)이 조립한 메시지를 메시지 처리기(messageHandler.ts)에 넘긴다. 세션마다 처리기가 하나이다.
 *  - `udp.sessionTimeoutMs` 동안 그 세션의 유효한 패킷이 없으면 세션을 끝낸다. 문장을 실행 중인 세션은 제외한다.
 *    `0` 이면 시간 제한이 없다. 클라이언트는 ping 으로 세션을 유지한다.
 *  - `udp.maxPacketSize` 보다 큰 패킷은 버린다. 서버가 보내는 패킷도 이 크기를 넘지 않는다.
 *  - 증폭 억제 : 위조된 출발지 주소의 `SYN` 에 응답이 계속 나가지 않도록, 처음 보내는 응답(`helloOk`)이 한 번도 확인되지 않은 동안은
 *    재전송 한도를 4번으로 낮춘다. 인증 전 세션 수는 처리기가 제한한다. (`max(16, 2 × maxConnections)`, 10초)
 *  - Windows 에서 상대가 없을 때 ICMP "포트 도달 불가" 로 소켓에 ECONNRESET 이 올라올 수 있다. 소켓 오류는 로그만 남기고 소켓은 닫지 않는다.
 *
 * UDP 구간은 암호화하지 않는다. (AGENTS.md 16) 신뢰할 수 있는 네트워크에서 쓴다. node:dgram 만 쓴다.
 *
 * 관련 사양 : AGENTS.md 상세 7, 8, 15
 * 구현 단계 : 9단계 (9-8)
 */

import { randomInt } from "node:crypto";
import dgram from "node:dgram";
import { isIPv6 } from "node:net";
import { normalizeRemoteAddress } from "../common/address.js";
import { DbError, ERROR_CODES, StartupError } from "../common/errors.js";
import { MessageHandler } from "./messageHandler.js";
import type { ConnectionEndpoint, HandlerEnvironment } from "./messageHandler.js";
import { errorResponse, encodeMessage } from "./protocol.js";
import { ReliableEndpoint, UdpFlags, decodePacket, encodePacket, realClock } from "./udpReliability.js";
import type { Clock, UdpPacket, UdpReliabilityError } from "./udpReliability.js";

export interface UdpServerOptions {
  host: string;
  port: number;
  maxPacketSize: number;
  /** 0 이면 시간 제한이 없다. */
  sessionTimeoutMs: number;
}

/** 처음 보내는 응답이 확인되기 전까지의 재전송 한도이다. */
const UNCONFIRMED_RETRANSMIT_LIMIT = 4;

/** `close()` 가 보낸 것을 비우기를 기다리는 최대 시간(ms)이다. */
const FLUSH_GRACE_MS = 5000;

interface UdpSession {
  readonly id: number;
  readonly key: string;
  readonly address: string;
  readonly port: number;
  reliable: ReliableEndpoint;
  handler: MessageHandler;
  lastReceived: number;
  closing: boolean;
  removed: boolean;
}

export class UdpServer {
  private socket: dgram.Socket | null = null;
  private readonly byId = new Map<number, UdpSession>();
  private readonly byKey = new Map<string, UdpSession>();
  private accepting = true;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly env: HandlerEnvironment;

  constructor(
    env: HandlerEnvironment,
    private readonly options: UdpServerOptions,
    private readonly clock: Clock = realClock,
  ) {
    // helloOk 에 싣는 값이다. 클라이언트가 ping 주기와 조각 크기를 정하는 데 쓴다.
    this.env = { ...env, udp: { sessionTimeoutMs: options.sessionTimeoutMs, maxPacketSize: options.maxPacketSize } };
  }

  /** 지금 열려 있는 세션 수이다. */
  get sessionCount(): number {
    return this.byId.size;
  }

  /** 실제로 바인드한 포트이다. 구동 전에는 null 이다. */
  get boundPort(): number | null {
    try {
      return this.socket?.address().port ?? null;
    } catch {
      return null;
    }
  }

  /** 포트를 연다. 열지 못하면 StartupError 이다. */
  async start(): Promise<void> {
    if (this.socket !== null) throw new StartupError("The UDP server is already started.");
    const socket = dgram.createSocket({ type: isIPv6(this.options.host) ? "udp6" : "udp4" });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        socket.close();
        reject(
          new StartupError(
            error.code === "EADDRINUSE"
              ? `Cannot open the UDP port ${this.options.host}:${this.options.port}: it is already in use.`
              : `Cannot open the UDP port ${this.options.host}:${this.options.port}: ${error.message}`,
            { cause: error },
          ),
        );
      };
      socket.once("error", onError);
      socket.bind(this.options.port, this.options.host, () => {
        socket.off("error", onError);
        resolve();
      });
    });
    socket.on("error", (error) => this.env.logger.debug(`UDP socket error: ${error.message}`));
    socket.on("message", (message, remote) => {
      try {
        this.onDatagram(message, remote);
      } catch (error) {
        this.env.logger.error(`Unexpected error while handling a UDP packet: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      }
    });
    this.socket = socket;
    if (this.options.sessionTimeoutMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), 1000);
      this.sweepTimer.unref();
    }
  }

  /** 새 세션 열기를 멈춘다. 이미 열린 세션은 유지한다. (같은 소켓을 쓰므로 소켓은 닫지 않는다) */
  stopAccepting(): Promise<void> {
    this.accepting = false;
    return Promise.resolve();
  }

  /** 남은 세션을 닫고 소켓을 닫는다. 유예 시간 안에 비워지지 않으면 강제로 닫는다. */
  async closeConnections(graceMs = 2000): Promise<void> {
    this.accepting = false;
    const deadline = Date.now() + graceMs;
    while (this.byId.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const session of [...this.byId.values()]) this.closeSession(session, "server shutdown", true);
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) await new Promise<void>((resolve) => socket.close(() => resolve()));
  }

  // -------------------------------------------------------------------------
  // 패킷 수신
  // -------------------------------------------------------------------------

  private onDatagram(message: Buffer, remote: dgram.RemoteInfo): void {
    if (message.length > this.options.maxPacketSize) {
      this.env.logger.debug(`Dropped an oversized UDP packet (${message.length} bytes) from ${remote.address}:${remote.port}.`);
      return;
    }
    const packet = decodePacket(message);
    if (packet === null) return; // 잘못된 패킷은 조용히 버린다. 오류 응답 패킷은 RST 뿐이다.
    if ((packet.flags & UdpFlags.RST) !== 0) return;
    const key = `${remote.address}:${remote.port}`;
    let session: UdpSession | undefined;
    if (packet.sessionId === 0) {
      // 세션 번호가 없는 패킷은 세션을 여는 SYN|DATA 뿐이다.
      if ((packet.flags & UdpFlags.SYN) === 0 || (packet.flags & UdpFlags.DATA) === 0) return;
      session = this.byKey.get(key);
      if (session !== undefined && session.handler.currentSession !== null) {
        // 인증을 마친 세션이 있는 주소에서 새 SYN 이 왔다. 같은 포트를 다시 쓴 새 접속이므로 옛 세션을 닫는다.
        this.closeSession(session, "replaced by a new connection from the same address", false);
        session = undefined;
      }
      if (session === undefined) {
        if (!this.accepting) return;
        session = this.createSession(remote, key);
        if (session === undefined) return;
      }
    } else {
      session = this.byId.get(packet.sessionId);
      if (session === undefined) {
        this.sendReset(remote, packet.sessionId);
        return;
      }
      if (session.key !== key) return; // 출발지 주소가 다르면 응답 없이 버린다.
    }
    session.lastReceived = this.clock.now();
    if ((packet.flags & UdpFlags.FIN) !== 0) {
      this.sendControl(session, UdpFlags.FIN | UdpFlags.ACK);
      this.closeSession(session, "closed by the client", false);
      return;
    }
    session.reliable.receivePacket(packet);
  }

  private newSessionId(): number {
    for (;;) {
      const id = randomInt(1, 0x1_0000_0000);
      if (!this.byId.has(id)) return id;
    }
  }

  private sendReset(remote: dgram.RemoteInfo, sessionId: number): void {
    const packet: UdpPacket = { flags: UdpFlags.RST, sessionId, seq: 0, fragIndex: 0, fragCount: 0, ackSeq: 0, payload: Buffer.alloc(0) };
    this.rawSend(encodePacket(packet), remote.port, remote.address);
  }

  private sendControl(session: UdpSession, flags: number): void {
    const packet: UdpPacket = { flags, sessionId: session.id, seq: 0, fragIndex: 0, fragCount: 0, ackSeq: session.reliable.deliveredSeq, payload: Buffer.alloc(0) };
    this.rawSend(encodePacket(packet), session.port, session.address);
  }

  private rawSend(packet: Buffer, port: number, address: string): void {
    this.socket?.send(packet, port, address, (error) => {
      if (error !== null) this.env.logger.debug(`UDP send failed: ${error.message}`);
    });
  }

  // -------------------------------------------------------------------------
  // 세션
  // -------------------------------------------------------------------------

  private createSession(remote: dgram.RemoteInfo, key: string): UdpSession | undefined {
    const id = this.newSessionId();
    const holder: { session?: UdpSession } = {};
    const reliable = new ReliableEndpoint(
      { send: (packet) => this.rawSend(packet, remote.port, remote.address) },
      this.clock,
      {
        maxPacketSize: this.options.maxPacketSize,
        sessionId: () => id,
        onMessage: (body) => holder.session?.handler.receive(body),
        onFailure: (error: UdpReliabilityError) => {
          this.env.logger.warn(`UDP session ${id} (${key}) failed: ${error.message}`);
          if (holder.session !== undefined) this.closeSession(holder.session, error.message, true);
        },
        maxMessageBytes: () => holder.session?.handler.maxBodyBytes ?? 64 * 1024,
        unconfirmedRetransmitLimit: UNCONFIRMED_RETRANSMIT_LIMIT,
      },
    );
    const endpoint: ConnectionEndpoint = {
      channel: "udp",
      remoteAddress: normalizeRemoteAddress(remote.address),
      send: (body) => this.sendBody(holder.session as UdpSession, body),
      close: (closeOptions) => {
        const session = holder.session;
        if (session === undefined || session.closing) return;
        if (closeOptions?.flush === false) {
          this.closeSession(session, "closed without flushing", true);
          return;
        }
        session.closing = true;
        void this.flushAndRemove(session);
      },
      drained: () => reliable.idle(),
    };
    const handler = MessageHandler.open(this.env, endpoint);
    if (handler === null) {
      reliable.stop();
      return undefined;
    }
    const session: UdpSession = {
      id,
      key,
      address: remote.address,
      port: remote.port,
      reliable,
      handler,
      lastReceived: this.clock.now(),
      closing: false,
      removed: false,
    };
    holder.session = session;
    this.byId.set(id, session);
    this.byKey.set(key, session);
    this.env.logger.debug(`UDP session ${id} opened for ${key}.`);
    return session;
  }

  /** 응답 하나를 신뢰성 계층에 넣는다. 조각 수 한도를 넘으면 같은 `id` 의 오류 응답으로 바꾼다. */
  private sendBody(session: UdpSession, body: Buffer): void {
    try {
      session.reliable.sendMessage(body);
    } catch (error) {
      if (!(error instanceof DbError)) throw error;
      const id = /^\{"id":(\d+),/.exec(body.subarray(0, 40).toString("utf8"))?.[1];
      const replacement = errorResponse(
        id === undefined ? 0 : Number(id),
        new DbError("54000", ERROR_CODES.LIMIT_EXCEEDED, "The response is too large for the UDP packet size; ask for a smaller fetchSize or use TCP."),
      );
      this.env.logger.warn(`UDP session ${session.id}: ${error.message}`);
      session.reliable.sendMessage(encodeMessage(replacement));
    }
  }

  /** 보낸 것이 모두 확인되기를 기다린 뒤(최대 5초) FIN 을 보내고 세션을 지운다. */
  private async flushAndRemove(session: UdpSession): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        session.reliable.idle(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, FLUSH_GRACE_MS);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    this.closeSession(session, "closed", true);
  }

  /** 세션을 지우고 처리기를 정리한다(롤백과 잠금 해제). `notify` 이면 클라이언트에 FIN 을 보낸다. */
  private closeSession(session: UdpSession, reason: string, notify: boolean): void {
    if (session.removed) return;
    session.removed = true;
    session.closing = true;
    if (notify) this.sendControl(session, UdpFlags.FIN);
    session.reliable.stop();
    session.handler.dispose();
    this.byId.delete(session.id);
    if (this.byKey.get(session.key) === session) this.byKey.delete(session.key);
    this.env.logger.debug(`UDP session ${session.id} (${session.key}) removed: ${reason}.`);
  }

  /** 세션 시간 제한을 넘긴 세션을 끝낸다. 문장을 실행하거나 기다리는 중인 세션은 제외한다. */
  private sweep(): void {
    const timeout = this.options.sessionTimeoutMs;
    if (timeout <= 0) return;
    const now = this.clock.now();
    for (const session of [...this.byId.values()]) {
      if (session.handler.busy || session.closing) continue;
      if (now - session.lastReceived >= timeout) {
        this.env.logger.info(`UDP session ${session.id} (${session.key}) timed out after ${timeout} ms without packets.`);
        this.closeSession(session, "session timeout", true);
      }
    }
  }
}
