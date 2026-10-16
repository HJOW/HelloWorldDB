/**
 * 통신 테스트의 공용 도우미 (9단계).
 * 테스트를 등록하지 않으므로 여러 테스트 파일에서 import해도 중복 실행되지 않는다.
 *  - 가짜 접속 끝점과 소켓 없는 프로토콜 구동기 : 메시지 처리기를 소켓 없이 시험한다.
 *  - 조용한 로거, 사용하지 않는 포트 고르기
 * 관련 사양 : AGENTS.md 상세 8
 * 구현 단계 : 9단계
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import dgram from "node:dgram";
import { randomBytes } from "node:crypto";
import {
  authMessage,
  clientFinalWithoutProof,
  clientFirstBare,
  clientFirstMessage,
  computeClientProof,
  generateNonce,
  parseServerFirst,
  verifyServerSignature,
} from "../../src/auth/scram.js";
import type { Logger } from "../../src/common/logger.js";
import { ConnectionLimits } from "../../src/net/connectionLimits.js";
import type { ConnectionLimitsOptions } from "../../src/net/connectionLimits.js";
import { MessageHandler } from "../../src/net/messageHandler.js";
import type { ConnectionEndpoint, ControlPort, HandlerEnvironment } from "../../src/net/messageHandler.js";
import type { Channel } from "../../src/net/protocol.js";
import type { Database } from "../../src/session/session.js";

/**
 * bun 에서 실행 중인지 본다. 소켓과 TLS 의 세부 동작(서버 쪽 핸드셰이크 실패 이벤트, 클라이언트의 `maxVersion` 적용 등)이
 * Node.js 와 다른 시험 항목을 가려내는 데만 쓴다. 제품 동작에 대한 단언은 두 런타임에서 모두 같아야 한다.
 */
export const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/** 시험에서 주고받는 메시지의 느슨한 모양이다. */
export type Message = { id: number; type: string } & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface CapturingLogger extends Logger {
  lines: string[];
}

/** 로그를 모아 두는 로거이다. 파일이나 터미널에는 쓰지 않는다. */
export function capturingLogger(): CapturingLogger {
  const lines: string[] = [];
  const push = (level: string) => (message: string): void => {
    lines.push(`${level}: ${message}`);
  };
  return { lines, error: push("error"), warn: push("warn"), info: push("info"), debug: push("debug"), close: () => Promise.resolve() };
}

/** 가짜 접속 끝점이다. 처리기가 보낸 메시지를 모으고, 닫힘을 기록한다. */
export class FakeEndpoint implements ConnectionEndpoint {
  readonly sent: Message[] = [];
  closed = false;
  closeCount = 0;
  private cursor = 0;
  private waiters: Array<() => void> = [];
  /** 값을 주면 처리기가 다음 요청 전에 이 약속을 기다린다. (보내기가 밀린 상황 흉내) */
  drainGate: Promise<void> | null = null;

  constructor(
    readonly channel: Channel = "local",
    readonly remoteAddress: string | null = null,
  ) {}

  send(body: Buffer): void {
    this.sent.push(JSON.parse(body.toString("utf8")) as Message);
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  close(): void {
    this.closed = true;
    this.closeCount++;
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  drained(): Promise<void> {
    return this.drainGate ?? Promise.resolve();
  }

  /** 아직 읽지 않은 다음 메시지를 기다린다. */
  async next(timeoutMs = 5000): Promise<Message> {
    const deadline = Date.now() + timeoutMs;
    while (this.cursor >= this.sent.length) {
      if (this.closed) throw new Error("The endpoint was closed while waiting for a message.");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Timed out waiting for a message.");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for a message.")), remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.sent[this.cursor++] as Message;
  }

  /** 읽지 않은 메시지가 있는지 본다. */
  get unread(): number {
    return this.sent.length - this.cursor;
  }
}

export interface EnvironmentOptions {
  control?: ControlPort | null;
  limits?: Partial<ConnectionLimitsOptions>;
  logger?: Logger;
  udp?: { sessionTimeoutMs: number; maxPacketSize: number };
}

/** 시험용 처리기 환경을 만든다. 인증 실패 지연은 기본으로 0 이다. */
export function makeEnvironment(database: Database, options: EnvironmentOptions = {}): HandlerEnvironment & { sleeps: number[]; logger: CapturingLogger | Logger } {
  const sleeps: number[] = [];
  const limits = new ConnectionLimits({
    maxConnections: Number.isFinite(database.maxConnections) ? database.maxConnections : 10,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...options.limits,
  });
  return {
    database,
    control: options.control ?? null,
    limits,
    logger: options.logger ?? capturingLogger(),
    decoySecret: randomBytes(32),
    ...(options.udp === undefined ? {} : { udp: options.udp }),
    sleeps,
  };
}

/** 소켓 없는 프로토콜 구동기이다. 요청을 보내고 같은 id 의 응답을 기다린다. */
export class Driver {
  private seq = 0;
  constructor(
    readonly handler: MessageHandler,
    readonly endpoint: FakeEndpoint,
  ) {}

  /** 처리기를 열고 구동기를 만든다. 가득 차서 열리지 않으면 null 이다. */
  static open(env: HandlerEnvironment, endpoint: FakeEndpoint): Driver | null {
    const handler = MessageHandler.open(env, endpoint);
    return handler === null ? null : new Driver(handler, endpoint);
  }

  /** 메시지를 보낸다. id 를 생략하면 새 번호를 붙인다. 쓴 id 를 돌려준다. */
  send(message: Record<string, unknown>): number {
    const id = typeof message["id"] === "number" ? (message["id"] as number) : ++this.seq;
    this.handler.receive(Buffer.from(JSON.stringify({ ...message, id }), "utf8"));
    return id;
  }

  /** 원본 본문을 그대로 넘긴다. */
  sendRaw(body: Buffer | string): void {
    this.handler.receive(typeof body === "string" ? Buffer.from(body, "utf8") : body);
  }

  /** 요청을 보내고 응답 하나를 받는다. */
  async request(message: Record<string, unknown>): Promise<Message> {
    const id = this.send(message);
    const response = await this.endpoint.next();
    if (response.id !== id) throw new Error(`Response id mismatch: expected ${id}, got ${response.id} (${JSON.stringify(response)})`);
    return response;
  }

  async hello(): Promise<Message> {
    return await this.request({ type: "hello", versions: [1], client: "test" });
  }

  /** SCRAM 교환을 클라이언트 쪽에서 수행한다. 성공하면 authOk 응답을 돌려준다. 실패하면 오류 응답을 돌려준다. */
  async login(user: string, password: string, extra: Record<string, unknown> = {}): Promise<Message> {
    const hello = await this.hello();
    if (hello.type !== "helloOk") return hello;
    const nonce = generateNonce();
    const challenge = await this.request({ type: "authStart", mechanism: "SCRAM-SHA-256", clientFirst: clientFirstMessage(user, nonce), ...extra });
    if (challenge.type !== "authChallenge") return challenge;
    const parsed = parseServerFirst(challenge["serverFirst"] as string);
    if (parsed === null) throw new Error("Bad server-first message.");
    const withoutProof = clientFinalWithoutProof(parsed.nonce);
    const message = authMessage(clientFirstBare(user, nonce), challenge["serverFirst"] as string, withoutProof);
    const proof = computeClientProof(password, parsed.salt, parsed.iterations, message);
    const ok = await this.request({ type: "authFinish", clientFinal: `${withoutProof},p=${proof}` });
    if (ok.type === "authOk") {
      const signature = (ok["serverFinal"] as string).replace(/^v=/, "");
      if (!verifyServerSignature(password, parsed.salt, parsed.iterations, message, signature)) {
        throw new Error("The server signature does not verify.");
      }
    }
    return ok;
  }

  /** SQL 을 실행하고 응답을 돌려준다. */
  async execute(sql: string, params: unknown[] = [], fetchSize?: number): Promise<Message> {
    return await this.request({ type: "execute", sql, params, ...(fetchSize === undefined ? {} : { fetchSize }) });
  }
}

/**
 * TCP 와 UDP 포트가 모두 비어 있는지 본다. (같은 번호를 TCP 와 UDP 가 함께 쓰므로 둘 다 본다)
 * 데몬의 기본 바인드 주소(0.0.0.0)와 시험이 쓰는 루프백(127.0.0.1) 양쪽에서 본다. 한쪽에만 바인드된 소켓이 다른 쪽 바인드를 막기 때문이다.
 */
async function bothFree(port: number, reasons: string[]): Promise<boolean> {
  for (const host of ["0.0.0.0", "127.0.0.1"]) {
    const tcp = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", (error: NodeJS.ErrnoException) => {
        reasons.push(`tcp ${host}:${port}: ${error.code ?? error.message}`);
        resolve(false);
      });
      server.listen(port, host, () => server.close(() => resolve(true)));
    });
    if (!tcp) return false;
    const udp = await new Promise<boolean>((resolve) => {
      const socket = dgram.createSocket("udp4");
      socket.once("error", (error: NodeJS.ErrnoException) => {
        reasons.push(`udp ${host}:${port}: ${error.code ?? error.message}`);
        socket.close();
        resolve(false);
      });
      socket.bind(port, host, () => socket.close(() => resolve(true)));
    });
    if (!udp) return false;
  }
  return true;
}

/**
 * 지금 비어 있는 포트 하나를 고른다. TCP 와 UDP 가 함께 쓰므로 둘 다 비어 있어야 한다.
 * Windows 는 TCP 와 UDP 에 서로 다른 "제외된 포트 범위"(예약 범위, `netsh int ipv4 show excludedportrange`)를 가지며
 * 운영체제가 순서대로 주는 포트가 그 범위에 연달아 걸릴 수 있다. 그래서 처음 몇 번만 운영체제가 주는 포트를 쓰고,
 * 그 뒤에는 동적 포트 범위 아래(20,000 ~ 45,000)에서 무작위로 고른다.
 */
export async function freePort(): Promise<number> {
  const reasons: string[] = [];
  for (let attempt = 0; attempt < 200; attempt++) {
    let port: number;
    if (attempt < 3) {
      port = await new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
        });
      });
    } else {
      port = 20_000 + Math.floor(Math.random() * 25_000);
    }
    if (port > 0 && (await bothFree(port, reasons))) return port;
  }
  throw new Error(`Could not find a free port. ${reasons.slice(0, 5).join("; ")}`);
}

/**
 * 설치 디렉토리에 사용하지 않는 포트를 `port` 로 하는 config.json 을 쓴다. 다른 키는 `extra` 로 더한다.
 * 통신 시험 파일들은 병렬로 실행되므로, 데몬(`Server`)을 구동하는 시험은 기본 포트(7410)를 쓰지 않고 이것으로 포트를 나눈다.
 * 인스턴스는 포트 번호로 구분되고 로컬 전용 채널의 주소도 포트로 정해지기 때문이다. (AGENTS.md 상세 15)
 * 정한 포트 번호를 돌려준다.
 */
export async function writeFreePortConfig(installDir: string, extra: Record<string, unknown> = {}): Promise<number> {
  const port = await freePort();
  fs.writeFileSync(path.join(installDir, "config.json"), JSON.stringify({ port, ...extra }), "utf8");
  return port;
}

/** 조건이 참이 될 때까지 기다린다. */
export async function waitFor(condition: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
