/**
 * UDP 신뢰성 계층 시험용 시뮬레이터. 시험을 등록하지 않으므로 여러 시험 파일에서 import 해도 중복 실행되지 않는다.
 *  - FakeClock : 시간을 손으로 흘리는 가짜 시계. 이벤트는 (시각, 등록 순서)로 정렬되어 결정적이다.
 *  - Link : 시드가 있는 난수로 패킷을 유실, 중복, 지연시키는 가짜 네트워크. 지연이 제각각이라 순서도 뒤바뀐다.
 *  - createRandom : 재현할 수 있는 난수.
 * 시드가 같으면 같은 결과가 나오므로 실패 사례를 재현할 수 있다. (rdbms/test/net/udpSim.ts 를 줄인 것이다)
 */
import { ReliableEndpoint, decodePacket } from "../../src/protocol/udpReliability.js";
import type { Clock, PacketPort } from "../../src/protocol/udpReliability.js";

/** 재현할 수 있는 난수이다. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

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

  /** 조건이 참이 될 때까지, 또는 이벤트가 없거나 가상 시간이 `maxVirtualMs` 를 넘을 때까지 이벤트를 차례로 실행한다. 조건이 참이 되었으면 true 이다. */
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
  random: () => number;
}

/** 한 방향의 가짜 네트워크이다. */
export class Link {
  sent = 0;
  dropped = 0;
  maxSize = 0;

  constructor(
    private readonly clock: FakeClock,
    private readonly options: LinkOptions,
    private readonly target: () => ReliableEndpoint,
  ) {}

  readonly port: PacketPort = {
    send: (bytes: Buffer): void => {
      this.sent++;
      this.maxSize = Math.max(this.maxSize, bytes.length);
      const o = this.options;
      if (o.random() < (o.loss ?? 0)) {
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
      const packet = decodePacket(bytes);
      if (packet !== null) this.target().receivePacket(packet);
    });
  }
}
