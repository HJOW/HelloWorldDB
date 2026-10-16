/**
 * UDP 신뢰성 계층.
 *
 * 담당
 *  - 패킷 헤더 : 매직 넘버, 프로토콜 버전, 세션 ID, 순번, 조각 번호와 전체 조각 수, 플래그, 누적 확인(ackSeq)
 *  - 수신 확인(ACK), 재전송, 중복 제거, 순서 보장
 *  - `udp.maxPacketSize` 를 넘는 메시지를 조각으로 나누어 보내고, 받은 조각을 다시 합친다.
 *
 * UDP 는 유실, 중복, 순서 뒤바뀜이 있으므로 이 계층이 메시지 단위의 전달을 보장한다.
 * 서버와 클라이언트가 같은 규칙을 쓴다. 이 드라이버에서는 클라이언트 쪽(transport/udpTransport.ts)이 쓴다.
 * 서버 쪽 구현(rdbms/src/net/udpReliability.ts)과 같은 코드를 기준으로 하며, 규칙이 바뀌면 둘을 함께 고친다.
 * 소켓을 직접 열지 않고, 패킷을 보내는 통로(`PacketPort`)와 시계(`Clock`)를 주입받는다.
 * 그래야 가짜 시계와 유실, 중복, 지연, 순서 뒤바뀜을 일으키는 시뮬레이터로 결정적인 시험을 할 수 있다.
 *
 * 규칙의 요점 (바이트 레이아웃과 상세 규칙은 rdbms/docs/protocol.md)
 *  - 송신 : 방향마다 **한 번에 메시지 하나만** 전송 중으로 둔다. 다음 메시지는 대기열에서 기다린다. 요청과 응답이 한 번에 하나씩이라
 *    처리량 손실이 없고, 수신 쪽이 항상 `seq == expected` 한 가지 경우만 다루면 되어 순서 보장이 단순하다.
 *    한 메시지 안에서 동시에 미확인으로 둘 수 있는 조각은 32개이다.
 *  - 재전송 : 조각마다 보낸 시각을 기록하고 RTO 안에 ACK 가 없으면 그 조각을 다시 보낸다. RTO 는 RFC 6298 방식이다
 *    (재전송하지 않은 조각의 왕복 시간만 표본으로 쓴다(Karn). 초기 300 ms, 하한 50 ms, 상한 3 s, 재전송마다 2배).
 *    한 조각이 10번 재전송되고도 ACK 가 없으면 상대가 사라진 것으로 보고 실패시킨다.
 *    처음 보내는 메시지(`seq` 1)가 한 번도 확인되지 않은 동안에는 재전송 한도를 더 낮게 줄 수 있다. (위조된 출발지 주소로 온 SYN 의 증폭을 줄이기 위함)
 *  - 수신 : `seq < expected` 는 이미 전달한 메시지의 중복이라 조각은 버리되 ACK 는 다시 보낸다. `seq == expected` 는 조각을 저장하고
 *    모두 모이면 위로 전달한다. `seq > expected` 는 송신 규칙상 올 수 없으므로 버린다. 조각마다 즉시 ACK 를 보낸다(지연 ACK 없음).
 *  - 모든 패킷이 `ackSeq`(끝까지 받은 상대 메시지의 가장 큰 번호)를 싣는다. ACK 가 유실되어도 이것으로 메시지 전송이 끝난다.
 *
 * node:buffer 외에는 의존하지 않는다. (errors.ts 만 쓴다)
 *
 * 관련 사양 : AGENTS.md 상세 8 / rdbms/docs/protocol.md 2-4절
 * 구현 단계 : 12-2 (rdbms 9단계 9-7 의 코드를 옮겨 왔다)
 */

import { DbError, ERROR_CODES } from "../errors.js";

/** 패킷 맨 앞의 매직 넘버이다. ASCII `HW`. */
export const UDP_MAGIC = 0x4857;

/** 전송 계층의 버전이다. 헤더 레이아웃이나 규칙의 뜻을 바꾸면 올린다. */
export const UDP_TRANSPORT_VERSION = 1;

/** 패킷 헤더의 크기(바이트)이다. */
export const UDP_HEADER_BYTES = 20;

/** `udp.maxPacketSize` 의 하한과 상한이다. (config 검증과 같다) */
export const UDP_MIN_PACKET_SIZE = 64;
export const UDP_MAX_PACKET_SIZE = 65_507;

/** 패킷의 플래그 비트이다. */
export const UdpFlags = {
  /** 세션 열기. 방향마다 첫 번째 메시지(`seq` 1)의 조각에 붙는다. 서버가 보내는 ACK 에도 상대의 SYN 을 따라 붙는다. */
  SYN: 0x01,
  ACK: 0x02,
  DATA: 0x04,
  /** 세션 닫기. */
  FIN: 0x08,
  /** 알 수 없는 세션이다. */
  RST: 0x10,
} as const;

const KNOWN_FLAGS = UdpFlags.SYN | UdpFlags.ACK | UdpFlags.DATA | UdpFlags.FIN | UdpFlags.RST;

/** 한 메시지 안에서 동시에 미확인으로 둘 수 있는 조각 수이다. */
export const UDP_WINDOW_FRAGMENTS = 32;
export const UDP_INITIAL_RTO_MS = 300;
export const UDP_MIN_RTO_MS = 50;
export const UDP_MAX_RTO_MS = 3000;
/** 한 조각의 재전송 한도이다. 넘으면 상대가 사라진 것으로 본다. */
export const UDP_MAX_RETRANSMITS = 10;
/** 조각 번호와 조각 수는 16비트이다. */
export const UDP_MAX_FRAGMENTS = 65_535;

export interface UdpPacket {
  flags: number;
  sessionId: number;
  seq: number;
  fragIndex: number;
  fragCount: number;
  ackSeq: number;
  payload: Buffer;
}

/** 패킷 하나를 만든다. 패킷 크기를 검사하지 않는다. */
export function encodePacket(packet: UdpPacket): Buffer {
  const out = Buffer.allocUnsafe(UDP_HEADER_BYTES + packet.payload.length);
  out.writeUInt16BE(UDP_MAGIC, 0);
  out.writeUInt8(UDP_TRANSPORT_VERSION, 2);
  out.writeUInt8(packet.flags, 3);
  out.writeUInt32BE(packet.sessionId >>> 0, 4);
  out.writeUInt32BE(packet.seq >>> 0, 8);
  out.writeUInt16BE(packet.fragIndex, 12);
  out.writeUInt16BE(packet.fragCount, 14);
  out.writeUInt32BE(packet.ackSeq >>> 0, 16);
  packet.payload.copy(out, UDP_HEADER_BYTES);
  return out;
}

/**
 * 받은 바이트를 패킷으로 해석한다. 매직, 버전, 길이, 플래그, 조각 번호가 맞지 않으면 null 이다.
 * 호출자는 null 에 응답하지 않고 버린다. (오류 응답 패킷은 RST 뿐이다)
 */
export function decodePacket(bytes: Uint8Array): UdpPacket | null {
  if (bytes.length < UDP_HEADER_BYTES) return null;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.readUInt16BE(0) !== UDP_MAGIC || buffer.readUInt8(2) !== UDP_TRANSPORT_VERSION) return null;
  const flags = buffer.readUInt8(3);
  if ((flags & ~KNOWN_FLAGS) !== 0) return null;
  const fragIndex = buffer.readUInt16BE(12);
  const fragCount = buffer.readUInt16BE(14);
  const payload = Buffer.from(buffer.subarray(UDP_HEADER_BYTES));
  if ((flags & UdpFlags.DATA) !== 0) {
    if (fragCount < 1 || fragIndex >= fragCount || payload.length === 0) return null;
  } else if (payload.length !== 0) {
    return null;
  }
  return {
    flags,
    sessionId: buffer.readUInt32BE(4),
    seq: buffer.readUInt32BE(8),
    fragIndex,
    fragCount,
    ackSeq: buffer.readUInt32BE(16),
    payload,
  };
}

/** 패킷 하나에 실을 수 있는 본문의 최대 크기이다. */
export function maxPayloadBytes(maxPacketSize: number): number {
  return maxPacketSize - UDP_HEADER_BYTES;
}

/** 한 상대에게 패킷을 보내는 통로이다. 소켓이나 시험용 링크가 구현한다. */
export interface PacketPort {
  send(packet: Buffer): void;
}

/** 시계와 타이머이다. 시험에서는 시간을 손으로 흘리는 가짜 시계를 쓴다. */
export interface Clock {
  now(): number;
  setTimer(ms: number, fn: () => void): { cancel(): void };
}

/** 실제 시계이다. 타이머는 프로세스를 붙잡지 않는다. */
export const realClock: Clock = {
  now: () => Date.now(),
  setTimer(ms, fn) {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

/** 신뢰성 계층의 실패이다. 재전송 한도를 넘었거나 상대가 규칙을 어겼다. */
export class UdpReliabilityError extends Error {
  constructor(
    readonly kind: "retransmit-limit" | "protocol",
    message: string,
  ) {
    super(message);
    this.name = "UdpReliabilityError";
  }
}

export interface ReliableOptions {
  /** 패킷 하나의 최대 크기(헤더 포함)이다. 64 이상 65,507 이하. `setMaxPacketSize` 로 바꿀 수 있다. */
  maxPacketSize: number;
  /** 보내는 패킷에 싣는 세션 번호이다. 클라이언트는 서버가 알려 줄 때까지 0 이다. */
  sessionId(): number;
  /** 조립이 끝난 메시지 본문 하나를 위로 전달한다. 순서대로 한 번씩만 불린다. */
  onMessage(body: Buffer): void;
  /** 재전송 한도를 넘었거나 상대가 규칙을 어겼을 때 한 번 불린다. 그 뒤로 이 끝점은 멈춘다. */
  onFailure(error: UdpReliabilityError): void;
  /** 지금 받을 수 있는 메시지의 최대 크기이다. (인증 전 64 KiB, 인증 후 16 MiB) 넘으면 상대가 규칙을 어긴 것으로 본다. */
  maxMessageBytes(): number;
  /** 처음 보내는 메시지가 한 번도 확인되지 않은 동안의 재전송 한도이다. 생략하면 `UDP_MAX_RETRANSMITS` 이다. */
  unconfirmedRetransmitLimit?: number;
  /** 시험용 : 한 메시지 안의 미확인 조각 수 상한. 기본 32. */
  window?: number;
}

interface OutFragment {
  payload: Buffer;
  sent: boolean;
  acked: boolean;
  sentAt: number;
  retransmits: number;
}

interface OutMessage {
  seq: number;
  fragments: OutFragment[];
  /** 아직 한 번도 보내지 않은 첫 조각의 번호이다. */
  nextToSend: number;
  inflight: number;
  unacked: number;
  /** 이 메시지의 조각 중 하나라도 확인되었는지이다. */
  confirmed: boolean;
}

interface InAssembly {
  seq: number;
  fragCount: number;
  parts: Array<Buffer | undefined>;
  received: number;
  bytes: number;
}

/**
 * 한 상대와의 신뢰성 있는 메시지 전달이다. 방향마다 송신자와 수신자를 하나씩 가진다.
 * 서버는 세션마다 하나, 클라이언트는 접속마다 하나를 둔다.
 */
export class ReliableEndpoint {
  private readonly queue: Buffer[] = [];
  private current: OutMessage | null = null;
  private nextSeq = 1;
  private timer: { cancel(): void } | null = null;
  private stopped = false;
  private idleWaiters: Array<() => void> = [];

  // RTO 추정 (RFC 6298)
  private srtt: number | null = null;
  private rttvar = 0;
  private rto = UDP_INITIAL_RTO_MS;

  // 수신
  private expectedSeq = 1;
  private assembly: InAssembly | null = null;

  private readonly window: number;

  constructor(
    private readonly port: PacketPort,
    private readonly clock: Clock,
    private readonly options: ReliableOptions,
  ) {
    if (!Number.isInteger(options.maxPacketSize) || options.maxPacketSize < UDP_MIN_PACKET_SIZE || options.maxPacketSize > UDP_MAX_PACKET_SIZE) {
      throw new RangeError(`maxPacketSize must be an integer between ${UDP_MIN_PACKET_SIZE} and ${UDP_MAX_PACKET_SIZE}.`);
    }
    this.window = options.window ?? UDP_WINDOW_FRAGMENTS;
  }

  /**
   * 이후에 대기열에서 꺼내 조각내는 메시지부터 새 패킷 크기를 쓴다. 이미 전송 중인 메시지의 조각은 그대로이다.
   * 클라이언트가 서버의 `udp.maxPacketSize`(helloOk 로 알려 준다)에 맞출 때 쓴다.
   */
  setMaxPacketSize(maxPacketSize: number): void {
    if (!Number.isInteger(maxPacketSize) || maxPacketSize < UDP_MIN_PACKET_SIZE || maxPacketSize > UDP_MAX_PACKET_SIZE) {
      throw new RangeError(`maxPacketSize must be an integer between ${UDP_MIN_PACKET_SIZE} and ${UDP_MAX_PACKET_SIZE}.`);
    }
    this.options.maxPacketSize = maxPacketSize;
  }

  /** 끝까지 받아 위로 전달한 상대 메시지의 가장 큰 번호이다. 모든 패킷의 `ackSeq` 에 실린다. */
  get deliveredSeq(): number {
    return this.expectedSeq - 1;
  }

  /** 보내기를 기다리거나 확인을 기다리는 메시지의 수이다. */
  get pendingMessages(): number {
    return this.queue.length + (this.current === null ? 0 : 1);
  }

  /** 지금의 재전송 제한 시간(ms)이다. 시험과 관찰용이다. */
  get currentRto(): number {
    return this.rto;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** 보낼 메시지를 대기열에 넣는다. 조각 수가 한도(65,535)를 넘는 메시지는 보내지 않고 54000 이다. */
  sendMessage(body: Buffer): void {
    if (this.stopped) return;
    if (body.length === 0) throw new RangeError("A message body must not be empty.");
    const payloadSize = maxPayloadBytes(this.options.maxPacketSize);
    if (Math.ceil(body.length / payloadSize) > UDP_MAX_FRAGMENTS) {
      throw new DbError(
        "54000",
        ERROR_CODES.LIMIT_EXCEEDED,
        `Message needs more than ${UDP_MAX_FRAGMENTS} UDP fragments (${body.length} bytes, packet size ${this.options.maxPacketSize}).`,
      );
    }
    this.queue.push(body);
    this.startNext();
  }

  /** 보낼 것이 모두 확인될 때까지 기다린다. 이미 비어 있으면 바로 끝난다. 멈춘 끝점은 바로 끝난다. */
  idle(): Promise<void> {
    if (this.stopped || (this.current === null && this.queue.length === 0)) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /** 타이머를 모두 멈추고 이후의 입력과 보내기를 무시한다. */
  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = null;
    this.current = null;
    this.queue.length = 0;
    this.assembly = null;
    this.releaseIdle();
  }

  private releaseIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const waiter of waiters) waiter();
  }

  // -------------------------------------------------------------------------
  // 송신
  // -------------------------------------------------------------------------

  private startNext(): void {
    if (this.stopped || this.current !== null) return;
    const body = this.queue.shift();
    if (body === undefined) {
      this.releaseIdle();
      return;
    }
    const payloadSize = maxPayloadBytes(this.options.maxPacketSize);
    const count = Math.ceil(body.length / payloadSize);
    const fragments: OutFragment[] = [];
    for (let i = 0; i < count; i++) {
      fragments.push({
        payload: body.subarray(i * payloadSize, Math.min(body.length, (i + 1) * payloadSize)),
        sent: false,
        acked: false,
        sentAt: 0,
        retransmits: 0,
      });
    }
    this.current = { seq: this.nextSeq++, fragments, nextToSend: 0, inflight: 0, unacked: count, confirmed: false };
    this.sendWindow();
  }

  private sendWindow(): void {
    const message = this.current;
    if (message === null) return;
    while (message.nextToSend < message.fragments.length && message.inflight < this.window) {
      this.transmit(message, message.nextToSend);
      message.inflight++;
      message.nextToSend++;
    }
    this.armTimer();
  }

  private transmit(message: OutMessage, index: number): void {
    const fragment = message.fragments[index] as OutFragment;
    fragment.sent = true;
    fragment.sentAt = this.clock.now();
    this.port.send(
      encodePacket({
        flags: UdpFlags.DATA | (message.seq === 1 ? UdpFlags.SYN : 0),
        sessionId: this.options.sessionId(),
        seq: message.seq,
        fragIndex: index,
        fragCount: message.fragments.length,
        ackSeq: this.deliveredSeq,
        payload: fragment.payload,
      }),
    );
  }

  /** 조각의 다음 재전송 시각이다. 재전송할 때마다 간격이 2배가 된다(상한까지). */
  private deadline(fragment: OutFragment): number {
    return fragment.sentAt + Math.min(this.rto * 2 ** fragment.retransmits, UDP_MAX_RTO_MS);
  }

  private armTimer(): void {
    this.timer?.cancel();
    this.timer = null;
    const message = this.current;
    if (message === null || this.stopped) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const fragment of message.fragments) {
      if (fragment.sent && !fragment.acked) earliest = Math.min(earliest, this.deadline(fragment));
    }
    if (earliest === Number.POSITIVE_INFINITY) return;
    this.timer = this.clock.setTimer(Math.max(0, earliest - this.clock.now()), () => this.onTimer());
  }

  private onTimer(): void {
    this.timer = null;
    const message = this.current;
    if (message === null || this.stopped) return;
    const now = this.clock.now();
    const limit =
      message.seq === 1 && !message.confirmed && this.options.unconfirmedRetransmitLimit !== undefined
        ? this.options.unconfirmedRetransmitLimit
        : UDP_MAX_RETRANSMITS;
    for (let i = 0; i < message.nextToSend; i++) {
      const fragment = message.fragments[i] as OutFragment;
      if (fragment.acked || this.deadline(fragment) > now) continue;
      if (fragment.retransmits >= limit) {
        this.fail(new UdpReliabilityError("retransmit-limit", `The peer did not acknowledge fragment ${i} of message ${message.seq} after ${limit} retransmissions.`));
        return;
      }
      fragment.retransmits++;
      this.transmit(message, i);
    }
    this.armTimer();
  }

  /** RFC 6298 : 왕복 시간 표본으로 SRTT, RTTVAR, RTO 를 갱신한다. */
  private sampleRtt(sample: number): void {
    if (this.srtt === null) {
      this.srtt = sample;
      this.rttvar = sample / 2;
    } else {
      this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - sample);
      this.srtt = 0.875 * this.srtt + 0.125 * sample;
    }
    this.rto = Math.min(UDP_MAX_RTO_MS, Math.max(UDP_MIN_RTO_MS, this.srtt + Math.max(1, 4 * this.rttvar)));
  }

  private finishCurrent(): void {
    this.timer?.cancel();
    this.timer = null;
    this.current = null;
    this.startNext();
  }

  private onAck(seq: number, fragIndex: number): void {
    const message = this.current;
    if (message === null || message.seq !== seq || fragIndex >= message.fragments.length) return;
    const fragment = message.fragments[fragIndex] as OutFragment;
    if (!fragment.sent || fragment.acked) return;
    fragment.acked = true;
    message.confirmed = true;
    message.inflight--;
    message.unacked--;
    // Karn : 재전송하지 않은 조각의 왕복 시간만 표본으로 쓴다.
    if (fragment.retransmits === 0) this.sampleRtt(Math.max(0, this.clock.now() - fragment.sentAt));
    if (message.unacked === 0) this.finishCurrent();
    else this.sendWindow();
  }

  private fail(error: UdpReliabilityError): void {
    if (this.stopped) return;
    this.stop();
    this.options.onFailure(error);
  }

  // -------------------------------------------------------------------------
  // 수신
  // -------------------------------------------------------------------------

  /** 소켓에서 받아 해석한 패킷을 넣는다. 세션 번호와 출발지 주소의 확인은 호출자가 이미 했다. */
  receivePacket(packet: UdpPacket): void {
    if (this.stopped) return;
    // 조각 하나에 대한 ACK 를 먼저 처리한다. 마지막 조각의 ACK 도 왕복 시간 표본이 되어야 하기 때문이다.
    if ((packet.flags & UdpFlags.ACK) !== 0 && (packet.flags & UdpFlags.DATA) === 0) this.onAck(packet.seq, packet.fragIndex);
    // 누적 확인 : 상대가 끝까지 받은 메시지 번호가 지금 보내는 메시지 이상이면 남은 ACK 가 유실되었어도 끝난 것이다.
    const message = this.current;
    if (message !== null && packet.ackSeq >= message.seq) {
      message.confirmed = true;
      this.finishCurrent();
    }
    if ((packet.flags & UdpFlags.DATA) !== 0) this.onData(packet);
  }

  private sendAck(packet: UdpPacket): void {
    this.port.send(
      encodePacket({
        flags: UdpFlags.ACK | (packet.flags & UdpFlags.SYN),
        sessionId: this.options.sessionId(),
        seq: packet.seq,
        fragIndex: packet.fragIndex,
        fragCount: 0,
        ackSeq: this.deliveredSeq,
        payload: Buffer.alloc(0),
      }),
    );
  }

  private onData(packet: UdpPacket): void {
    if (packet.seq < this.expectedSeq) {
      // 이미 전달한 메시지의 중복이다. 상대의 ACK 가 유실되어 재전송했을 수 있으므로 ACK 는 다시 보낸다.
      this.sendAck(packet);
      return;
    }
    if (packet.seq > this.expectedSeq) return; // 송신 규칙상 올 수 없다. 버린다.
    let assembly = this.assembly;
    if (assembly === null) {
      assembly = { seq: packet.seq, fragCount: packet.fragCount, parts: new Array<Buffer | undefined>(packet.fragCount).fill(undefined), received: 0, bytes: 0 };
      this.assembly = assembly;
    } else if (assembly.fragCount !== packet.fragCount) {
      this.fail(new UdpReliabilityError("protocol", `The fragment count of message ${packet.seq} changed from ${assembly.fragCount} to ${packet.fragCount}.`));
      return;
    }
    if (assembly.parts[packet.fragIndex] !== undefined) {
      // 중복 조각이다. 무시하되 ACK 는 보낸다.
      this.sendAck(packet);
      return;
    }
    const limit = this.options.maxMessageBytes();
    if (assembly.bytes + packet.payload.length > limit) {
      this.fail(new UdpReliabilityError("protocol", `Message ${packet.seq} is larger than the allowed ${limit} bytes.`));
      return;
    }
    assembly.parts[packet.fragIndex] = packet.payload;
    assembly.received++;
    assembly.bytes += packet.payload.length;
    if (assembly.received < assembly.fragCount) {
      this.sendAck(packet);
      return;
    }
    // 모든 조각이 모였다. 상태를 먼저 갱신한 뒤 ACK 를 보내고 위로 전달한다.
    const body = Buffer.concat(assembly.parts as Buffer[], assembly.bytes);
    this.assembly = null;
    this.expectedSeq++;
    this.sendAck(packet);
    this.options.onMessage(body);
  }
}
