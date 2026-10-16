/**
 * UDP 신뢰성 계층 시험용 시뮬레이터 (9단계, 9-7).
 * 테스트를 등록하지 않으므로 여러 테스트 파일에서 import해도 중복 실행되지 않는다.
 *  - FakeClock : 시간을 손으로 흘리는 가짜 시계. 이벤트는 (시각, 등록 순서)로 정렬되어 결정적이다.
 *  - Link : 시드가 있는 난수로 패킷을 유실, 중복, 지연시키는 가짜 네트워크. 지연이 제각각이라 순서도 뒤바뀐다.
 *  - Pair : 두 ReliableEndpoint 를 Link 로 잇고 받은 메시지와 실패를 모아 둔다.
 * 시드가 같으면 같은 결과가 나오므로 실패 사례를 재현할 수 있다.
 * 관련 사양 : AGENTS.md 상세 8
 */
import { ReliableEndpoint, UdpFlags, decodePacket } from "../../src/net/udpReliability.js";
import type { Clock, PacketPort, ReliableOptions, UdpPacket, UdpReliabilityError } from "../../src/net/udpReliability.js";
import { createRandom } from "../types/helpers.js";

interface Event {
  at: number;
  order: number;
  fn: () => void;
  cancelled: boolean;
}

/** 시간을 손으로 흘리는 시계이다. */
export class FakeClock implements Clock {
  private time = 0;
  private order = 0;
  private readonly events: Event[] = [];

  now(): number {
    return this.time;
  }

  setTimer(ms: number, fn: () => void): { cancel(): void } {
    const event: Event = { at: this.time + Math.max(0, ms), order: this.order++, fn, cancelled: false };
    // (at, order) 오름차순으로 끼워 넣는다.
    let low = 0;
    let high = this.events.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const other = this.events[mid] as Event;
      if (other.at < event.at || (other.at === event.at && other.order < event.order)) low = mid + 1;
      else high = mid;
    }
    this.events.splice(low, 0, event);
    return {
      cancel: () => {
        event.cancelled = true;
      },
    };
  }

  /** 대기 중인 이벤트 수이다. (취소한 것은 센다) */
  get pendingEvents(): number {
    return this.events.length;
  }

  /**
   * 조건이 참이 될 때까지, 또는 이벤트가 없거나 가상 시간이 `maxVirtualMs` 를 넘을 때까지 이벤트를 차례로 실행한다.
   * 조건이 참이 되었으면 true 이다.
   */
  run(until: () => boolean, maxVirtualMs = 600_000): boolean {
    const limit = this.time + maxVirtualMs;
    while (!until()) {
      const event = this.events.shift();
      if (event === undefined) return until();
      if (event.cancelled) continue;
      if (event.at > limit) {
        this.events.unshift(event);
        return false;
      }
      this.time = Math.max(this.time, event.at);
      event.fn();
    }
    return true;
  }
}

export interface LinkOptions {
  /** 패킷을 잃을 확률(0 ~ 1)이다. */
  loss?: number;
  /** 잃지 않은 패킷을 한 번 더 보낼 확률이다. */
  duplicate?: number;
  /** 지연의 범위(ms)이다. 지연이 제각각이라 순서가 뒤바뀐다. */
  minDelay?: number;
  maxDelay?: number;
  /** ACK 만 잃을 확률이다. (DATA 는 `loss` 를 따른다) */
  ackLoss?: number;
  /** true 를 돌려주면 그 패킷을 잃는다. 특정 패킷을 겨냥할 때 쓴다. */
  dropIf?: (packet: UdpPacket, count: number) => boolean;
  random: () => number;
}

/** 한 방향의 가짜 네트워크이다. */
export class Link {
  /** 지금까지 보낸 패킷 수이다. */
  sent = 0;
  delivered = 0;
  dropped = 0;
  maxSize = 0;
  readonly log: UdpPacket[] = [];

  constructor(
    private readonly clock: FakeClock,
    private readonly options: LinkOptions,
    private readonly target: () => ReliableEndpoint,
  ) {}

  readonly port: PacketPort = {
    send: (bytes: Buffer): void => {
      this.sent++;
      this.maxSize = Math.max(this.maxSize, bytes.length);
      const packet = decodePacket(bytes);
      if (packet === null) throw new Error("A malformed packet was sent.");
      this.log.push(packet);
      const o = this.options;
      const pureAck = (packet.flags & UdpFlags.ACK) !== 0 && (packet.flags & UdpFlags.DATA) === 0;
      const lost =
        (o.dropIf?.(packet, this.sent) ?? false) ||
        o.random() < (o.loss ?? 0) ||
        (pureAck && o.random() < (o.ackLoss ?? 0));
      if (lost) {
        this.dropped++;
        return;
      }
      this.deliver(bytes);
      if (o.random() < (o.duplicate ?? 0)) this.deliver(bytes);
    },
  };

  private deliver(bytes: Buffer): void {
    const min = this.options.minDelay ?? 1;
    const max = this.options.maxDelay ?? min;
    const delay = min + this.options.random() * (max - min);
    this.clock.setTimer(delay, () => {
      this.delivered++;
      const packet = decodePacket(bytes);
      if (packet !== null) this.target().receivePacket(packet);
    });
  }
}

export interface PairOptions {
  seed?: number;
  link?: Partial<Omit<LinkOptions, "random">>;
  /** A 에서 B 로 가는 방향에만 적용하는 링크 설정이다. */
  linkAtoB?: Partial<Omit<LinkOptions, "random">>;
  linkBtoA?: Partial<Omit<LinkOptions, "random">>;
  maxPacketSize?: number;
  maxMessageBytes?: number;
  optionsA?: Partial<ReliableOptions>;
  optionsB?: Partial<ReliableOptions>;
}

/** 서로 잇닿은 두 끝점이다. */
export class Pair {
  readonly clock = new FakeClock();
  readonly a: ReliableEndpoint;
  readonly b: ReliableEndpoint;
  readonly toB: Link;
  readonly toA: Link;
  readonly receivedByA: Buffer[] = [];
  readonly receivedByB: Buffer[] = [];
  readonly failuresA: UdpReliabilityError[] = [];
  readonly failuresB: UdpReliabilityError[] = [];

  constructor(options: PairOptions = {}) {
    const random = createRandom(options.seed ?? 1);
    const base = options.link ?? {};
    this.toB = new Link(this.clock, { ...base, ...options.linkAtoB, random }, () => this.b);
    this.toA = new Link(this.clock, { ...base, ...options.linkBtoA, random }, () => this.a);
    const maxPacketSize = options.maxPacketSize ?? 1200;
    const limit = options.maxMessageBytes ?? 16 * 1024 * 1024;
    this.a = new ReliableEndpoint(this.toB.port, this.clock, {
      maxPacketSize,
      sessionId: () => 7,
      onMessage: (body) => this.receivedByA.push(body),
      onFailure: (error) => this.failuresA.push(error),
      maxMessageBytes: () => limit,
      ...options.optionsA,
    });
    this.b = new ReliableEndpoint(this.toA.port, this.clock, {
      maxPacketSize,
      sessionId: () => 7,
      onMessage: (body) => this.receivedByB.push(body),
      onFailure: (error) => this.failuresB.push(error),
      maxMessageBytes: () => limit,
      ...options.optionsB,
    });
  }

  /** 양쪽의 보낼 것이 모두 확인되거나 한쪽이 실패할 때까지 시계를 돌린다. 모두 확인되었으면 true 이다. */
  settle(maxVirtualMs = 600_000): boolean {
    return this.clock.run(
      () =>
        (this.a.pendingMessages === 0 && this.b.pendingMessages === 0) || this.failuresA.length > 0 || this.failuresB.length > 0,
      maxVirtualMs,
    ) && this.failuresA.length === 0 && this.failuresB.length === 0;
  }
}

/** 시드로 정해지는 내용의 메시지 본문이다. 내용이 맞는지 비교할 수 있다. */
export function payload(size: number, seed: number): Buffer {
  const random = createRandom(seed * 7919 + size);
  const out = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) out[i] = Math.floor(random() * 256);
  return out;
}
