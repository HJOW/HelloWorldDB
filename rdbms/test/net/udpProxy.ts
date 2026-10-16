/**
 * UDP 시험용 손실 프록시 (9단계, 9-8).
 * 클라이언트와 서버 사이에 끼어 패킷을 떨어뜨리고 복제하고 지연시킨다. 시드가 있는 난수로 움직여 실패 사례를 재현할 수 있다.
 * 서버는 클라이언트가 아니라 프록시의 업스트림 소켓(클라이언트마다 하나)과 이야기하므로 출발지 주소가 일정하다.
 * 테스트를 등록하지 않으므로 여러 테스트 파일에서 import해도 중복 실행되지 않는다.
 * 관련 사양 : AGENTS.md 상세 8
 */
import dgram from "node:dgram";
import { decodePacket } from "../../src/net/udpReliability.js";
import { createRandom } from "../types/helpers.js";

export interface ProxyOptions {
  serverPort: number;
  seed?: number;
  /** 클라이언트에서 서버로 가는 패킷을 잃을 확률이다. */
  lossToServer?: number;
  /** 서버에서 클라이언트로 가는 패킷을 잃을 확률이다. */
  lossToClient?: number;
  duplicate?: number;
  /** 지연의 범위(ms)이다. 지연이 제각각이라 순서도 뒤바뀐다. */
  minDelay?: number;
  maxDelay?: number;
}

export class LossyProxy {
  private readonly socket = dgram.createSocket("udp4");
  private readonly upstream = new Map<string, dgram.Socket>();
  private readonly random: () => number;
  readonly options: ProxyOptions;
  /** true 이면 그 방향의 모든 패킷을 버린다. (죽은 클라이언트나 끊긴 서버 흉내) */
  blockToServer = false;
  blockToClient = false;
  stats = { toServer: 0, toClient: 0, droppedToServer: 0, droppedToClient: 0, maxClientPacket: 0, maxServerPacket: 0 };
  /** 서버가 처음 보낸 패킷에 실린 세션 번호이다. */
  capturedSessionId = 0;
  private closed = false;

  constructor(options: ProxyOptions) {
    this.options = options;
    this.random = createRandom(options.seed ?? 1);
  }

  get port(): number {
    return this.socket.address().port;
  }

  async start(): Promise<void> {
    this.socket.on("message", (message, remote) => this.fromClient(message, remote));
    this.socket.on("error", () => undefined);
    await new Promise<void>((resolve) => this.socket.bind(0, "127.0.0.1", () => resolve()));
  }

  private delay(): number {
    const min = this.options.minDelay ?? 0;
    const max = this.options.maxDelay ?? min;
    return min + this.random() * (max - min);
  }

  private forward(send: () => void, copies: number): void {
    for (let i = 0; i < copies; i++) {
      const wait = this.delay();
      if (wait <= 0) send();
      else setTimeout(() => !this.closed && send(), wait);
    }
  }

  private fromClient(message: Buffer, remote: dgram.RemoteInfo): void {
    this.stats.toServer++;
    this.stats.maxClientPacket = Math.max(this.stats.maxClientPacket, message.length);
    if (this.blockToServer || this.random() < (this.options.lossToServer ?? 0)) {
      this.stats.droppedToServer++;
      return;
    }
    const key = `${remote.address}:${remote.port}`;
    let upstream = this.upstream.get(key);
    if (upstream === undefined) {
      upstream = dgram.createSocket("udp4");
      upstream.on("error", () => undefined);
      upstream.on("message", (reply) => this.fromServer(reply, remote));
      upstream.bind(0, "127.0.0.1");
      this.upstream.set(key, upstream);
    }
    const target = upstream;
    const copies = this.random() < (this.options.duplicate ?? 0) ? 2 : 1;
    this.forward(() => target.send(message, this.options.serverPort, "127.0.0.1", () => undefined), copies);
  }

  private fromServer(message: Buffer, client: dgram.RemoteInfo): void {
    this.stats.toClient++;
    this.stats.maxServerPacket = Math.max(this.stats.maxServerPacket, message.length);
    if (this.capturedSessionId === 0) {
      const packet = decodePacket(message);
      if (packet !== null && packet.sessionId !== 0) this.capturedSessionId = packet.sessionId;
    }
    if (this.blockToClient || this.random() < (this.options.lossToClient ?? 0)) {
      this.stats.droppedToClient++;
      return;
    }
    const copies = this.random() < (this.options.duplicate ?? 0) ? 2 : 1;
    this.forward(() => this.socket.send(message, client.port, client.address, () => undefined), copies);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const socket of this.upstream.values()) socket.close();
    this.upstream.clear();
    await new Promise<void>((resolve) => this.socket.close(() => resolve()));
  }
}
