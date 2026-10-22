/**
 * 2026-10-22 점검의 보완 시험 (N-2, N-3, N-4, N-5 의 접속 상태 부분).
 * N-2 : 돌려줄 때 되돌리기가 제한 시간을 넘으면 접속을 끊는다. 응답 없는 가짜 프로토콜로 확인한다.
 * N-3 : 인증 전에는 64 KiB 를 넘는 메시지를 받지 않고, 인증 뒤에는 큰 결과를 받는다.
 * N-4 : Cursor.fetch 는 크기를 query 의 fetchSize 와 같은 규칙으로 검증한다.
 */
import assert from "node:assert/strict";
import net from "node:net";
import { after, test } from "node:test";
import { Connection } from "../src/connection.js";
import type { SessionInfo } from "../src/connection.js";
import { DbError } from "../src/errors.js";
import { connect, createPool } from "../src/index.js";
import { TestServer } from "./helpers/server.js";

const server = await TestServer.start({ after: (fn) => after(fn) });
const ADMIN = { user: "SYSTEM", password: "HelloWorldDB" } as const;

/**
 * 응답하지 않는 가짜 프로토콜이다. 실행 요청은 응답을 주지 않고, abort 는 보류 중인 요청을 모두 실패시킨다.
 * ProtocolConnection 의 같은 계약(abort 와 serverStateUnknown)을 흉내 낸다.
 */
class StalledProtocol {
  aborted = 0;
  serverStateUnknown = false;
  private readonly waiting = new Set<(error: Error) => void>();

  execute(): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      this.waiting.add(reject);
    });
  }

  onClose(): void {}

  abort(): void {
    this.aborted++;
    for (const reject of this.waiting) reject(new DbError("08006", 1, "The connection was closed."));
    this.waiting.clear();
  }
}

/** 생성자는 공개되어 있지 않으므로 시험에서만 이렇게 만든다. */
function connectionOver(protocol: StalledProtocol): Connection {
  const make = Connection as unknown as new (protocol: unknown, fetchSize: undefined, info: SessionInfo) => Connection;
  return new make(protocol, undefined, { autocommit: true, tablespace: "SYSTEM", timeZone: "UTC" } as unknown as SessionInfo);
}

test("돌려줄 때 되돌리기가 제한 시간을 넘으면 접속을 끊고 실패로 알린다 (N-2)", async () => {
  const protocol = new StalledProtocol();
  const connection = connectionOver(protocol);
  const started = Date.now();
  await assert.rejects(connection._reset(100), DbError);
  assert.equal(protocol.aborted, 1, "접속을 한 번 끊었다");
  assert.ok(Date.now() - started < 2000, "제한 시간 근처에서 끝난다");
});

test("서버 상태를 알 수 없는 접속은 되돌리지 않고 바로 끊는다 (N-5)", async () => {
  const protocol = new StalledProtocol();
  protocol.serverStateUnknown = true;
  const connection = connectionOver(protocol);
  assert.equal(connection._needsReset, true, "반납할 때 되돌리기 대상이다");
  await assert.rejects(connection._reset(), DbError);
  assert.equal(protocol.aborted, 1);
});

test("인증을 마치기 전 64 KiB 를 넘는 메시지는 접속을 끊는다 (N-3)", async () => {
  // 어떤 요청에도 64 KiB 를 넘는 프레임으로 답하는 가짜 서버이다.
  const fake = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.on("data", () => {
      const body = Buffer.alloc(70_000, 0x20);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length, 0);
      socket.write(Buffer.concat([header, body]));
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", () => resolve()));
  const port = (fake.address() as net.AddressInfo).port;
  try {
    await assert.rejects(connect({ host: "127.0.0.1", port, user: "x", password: "y", connectTimeoutMs: 5000 }));
  }
  finally {
    fake.close();
  }
});

test("인증을 마친 뒤에는 64 KiB 를 넘는 결과도 받는다 (N-3)", async () => {
  const db = await connect({ port: server.port, ...ADMIN });
  try {
    await db.query("CREATE TABLE ND_BIG (V VARCHAR(65535))");
    const big = "x".repeat(65_000);
    await db.query("INSERT INTO ND_BIG VALUES (?)", [big]);
    assert.equal((await db.query("SELECT V FROM ND_BIG")).rows[0]?.[0], big);
  }
  finally {
    await db.close();
  }
});

test("Cursor.fetch 는 잘못된 크기를 RangeError 로 거부하고, 정상 값은 그대로 받는다 (N-4)", async () => {
  const db = await connect({ port: server.port, ...ADMIN });
  try {
    await db.query("CREATE TABLE ND_FETCH (ID INTEGER)");
    await db.query("INSERT INTO ND_FETCH VALUES (1), (2), (3), (4), (5)");
    const cursor = await db.cursor("SELECT ID FROM ND_FETCH ORDER BY ID", [], { fetchSize: 2 });
    for (const bad of [-1, 0, 1.5, Number.NaN]) {
      await assert.rejects(cursor.fetch(bad), RangeError, `fetch(${bad})`);
    }
    // 거부된 호출은 서버에 보내지 않았으므로 커서는 그대로 읽힌다.
    assert.equal((await cursor.fetch(2)).length, 2);
    await cursor.close();
  }
  finally {
    await db.close();
  }
});

/**
 * 첫 묶음 뒤에 빈 묶음이 `hasMore` 와 함께 계속 오는 가짜 프로토콜이다. (P-6)
 * 빈 묶음을 계속 받으며 기다리면 무한히 돈다. 올바른 드라이버는 프로토콜 위반으로 접속을 끊고 끝낸다.
 */
class EmptyBatchProtocol {
  aborted = 0;
  closed = false;
  serverStateUnknown = false;
  fetches = 0;

  async execute(): Promise<unknown> {
    return { kind: "rows", columns: [{ name: "A", typeName: "INTEGER", declared: "INTEGER", precision: 10, scale: 0, nullable: "UNKNOWN" }], rows: [[1]], cursor: 9, hasMore: true };
  }

  async fetch(): Promise<unknown> {
    this.fetches++;
    return { rows: [], cursor: 9, hasMore: true };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async closeCursor(): Promise<void> {}

  onClose(): void {}

  abort(): void {
    this.aborted++;
    this.closed = true;
  }
}

test("빈 묶음에 hasMore 가 이어지면 프로토콜 위반으로 접속을 끊는다 (P-6)", async () => {
  const protocol = new EmptyBatchProtocol();
  const make = Connection as unknown as new (protocol: unknown, fetchSize: undefined, info: SessionInfo) => Connection;
  const connection = new make(protocol, undefined, { autocommit: true, tablespace: "SYSTEM", timeZone: "UTC" } as unknown as SessionInfo);
  const error = await connection.query("SELECT A FROM T").then(() => null, (reason: unknown) => reason);
  assert.ok(error instanceof DbError, "DbError 여야 한다");
  assert.equal((error as DbError).sqlState, "08P01");
  assert.equal(protocol.aborted, 1, "접속을 끊었다");
  assert.ok(protocol.fetches <= 1, "빈 묶음을 반복해 받지 않는다");
});
