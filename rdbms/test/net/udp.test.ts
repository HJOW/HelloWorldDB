/**
 * UDP 서버와 클라이언트 테스트 (9단계, 9-8). 실제 `dgram` 소켓으로 접속하고, 중간에 패킷을 떨어뜨리고 복제하는 프록시를 끼워
 * 로그인, 질의, 대량 결과, 트랜잭션을 시험한다. 세션 시간 제한, 위조 주소, 모르는 세션(RST), 인증 전 세션 정리도 본다.
 * 관련 사양 : AGENTS.md 상세 7, 8, 15
 */
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { test } from "node:test";
import { Connection, isConnectionRefused } from "../../src/client/connection.js";
import type { RowsResult } from "../../src/client/connection.js";
import { DbError, StartupError } from "../../src/common/errors.js";
import { UdpServer } from "../../src/net/udpServer.js";
import type { UdpServerOptions } from "../../src/net/udpServer.js";
import { UdpFlags, decodePacket, encodePacket } from "../../src/net/udpReliability.js";
import { Database } from "../../src/session/session.js";
import type { DatabaseOptions } from "../../src/session/session.js";
import { tempDir } from "../exec/helpers.js";
import { capturingLogger, freePort, makeEnvironment, waitFor } from "./helpers.js";
import type { CapturingLogger, EnvironmentOptions } from "./helpers.js";
import { LossyProxy } from "./udpProxy.js";
import type { ProxyOptions } from "./udpProxy.js";

interface Fixture {
  db: Database;
  server: UdpServer;
  port: number;
  logger: CapturingLogger;
  env: ReturnType<typeof makeEnvironment>;
  proxy: LossyProxy | null;
  /** 프록시가 있으면 프록시의 포트, 없으면 서버의 포트이다. */
  clientPort: number;
  open(connectTimeoutMs?: number): Promise<Connection>;
  login(): Promise<Connection>;
}

interface SetupOptions {
  db?: DatabaseOptions;
  env?: EnvironmentOptions;
  udp?: Partial<UdpServerOptions>;
  proxy?: Omit<ProxyOptions, "serverPort">;
}

async function setup(t: { after(fn: () => unknown): void }, options: SetupOptions = {}): Promise<Fixture> {
  const dir = tempDir(t);
  const db = Database.open(dir, { onWarning: () => {}, scramIterations: 1000, lockTimeoutMs: 4000, ...options.db });
  const logger = capturingLogger();
  const env = makeEnvironment(db, { logger, ...options.env });
  const port = await freePort();
  const server = new UdpServer(env, { host: "127.0.0.1", port, maxPacketSize: 1200, sessionTimeoutMs: 60_000, ...options.udp });
  await server.start();
  let proxy: LossyProxy | null = null;
  if (options.proxy !== undefined) {
    proxy = new LossyProxy({ serverPort: port, ...options.proxy });
    await proxy.start();
  }
  const connections: Connection[] = [];
  t.after(async () => {
    for (const connection of connections) connection.abort();
    await proxy?.close();
    await server.closeConnections(300);
    db.close();
  });
  const clientPort = proxy?.port ?? port;
  const open = async (connectTimeoutMs = 10_000): Promise<Connection> => {
    const connection = await Connection.open({ kind: "udp", host: "127.0.0.1", port: clientPort }, { requestTimeoutMs: 30_000, internal: { connectTimeoutMs } });
    connections.push(connection);
    return connection;
  };
  return {
    db,
    server,
    port,
    logger,
    env,
    proxy,
    clientPort,
    open,
    async login() {
      const connection = await open();
      await connection.login({ user: "SYSTEM", password: "HelloWorldDB" });
      return connection;
    },
  };
}

function rowsOf(result: Awaited<ReturnType<Connection["execute"]>>): unknown[][] {
  assert.equal(result.kind, "rows");
  return (result as RowsResult).rows;
}

const isDbError = (sqlState: string, code?: number) => (error: unknown): boolean =>
  error instanceof DbError && error.sqlState === sqlState && (code === undefined || error.code === code);

/** 원시 UDP 소켓으로 패킷을 보내고 일정 시간 안에 오는 응답을 모은다. */
async function probe(port: number, packets: Buffer[], waitMs = 250): Promise<Buffer[]> {
  const socket = dgram.createSocket("udp4");
  const replies: Buffer[] = [];
  socket.on("message", (message) => replies.push(message));
  socket.on("error", () => undefined);
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", () => resolve()));
  for (const packet of packets) socket.send(packet, port, "127.0.0.1");
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return replies;
}

const emptyPayload = Buffer.alloc(0);

// ---------------------------------------------------------------------------
// 기본 동작 (손실 없음)
// ---------------------------------------------------------------------------

test("UDP 로 로그인하고 Hello World 두 샘플을 실행한다. 세션에 접속 경로와 주소가 기록된다", async (t) => {
  const fixture = await setup(t);
  const connection = await fixture.login();
  assert.equal(connection.hello.udp?.maxPacketSize, 1200);
  assert.equal(connection.hello.udp?.sessionTimeoutMs, 60_000);
  assert.deepEqual(rowsOf(await connection.execute("SELECT 'Hello World'")), [["Hello World"]]);
  await connection.execute("CREATE TABLE HELLO (MESSAGE VARCHAR)");
  await connection.execute("INSERT INTO HELLO VALUES ('Hello World')");
  assert.deepEqual(rowsOf(await connection.execute("SELECT * FROM HELLO")), [["Hello World"]]);
  assert.deepEqual(rowsOf(await connection.execute("SELECT CHANNEL, CLIENT_ADDRESS FROM SYS_SESSIONS")), [["UDP", "127.0.0.1"]]);
  assert.equal(fixture.server.sessionCount, 1);
  assert.equal(fixture.db.sessions.countRemote(), 1);
});

test("루프백에서 온 UDP 접속은 로컬이라 CONNECT 가 없어도 받는다", async (t) => {
  const fixture = await setup(t);
  fixture.db.createSession({}).execute("CREATE USER NOCONNECT IDENTIFIED BY 'pw'");
  const connection = await fixture.open();
  assert.equal((await connection.login({ user: "NOCONNECT", password: "pw" })).user, "NOCONNECT");
});

test("대량 결과, 트랜잭션, 파라미터가 UDP 에서 동작한다", async (t) => {
  const fixture = await setup(t);
  const a = await fixture.login();
  const b = await fixture.login();
  await a.execute("CREATE TABLE BIG (N INTEGER, S VARCHAR(40))");
  for (let start = 1; start <= 3000; start += 500) {
    await a.execute(`INSERT INTO BIG VALUES ${Array.from({ length: 500 }, (_, i) => `(${start + i}, 'value number ${start + i}')`).join(",")}`);
  }
  const first = (await b.execute("SELECT N, S FROM BIG ORDER BY N")) as RowsResult;
  assert.equal(first.hasMore, true);
  const all = await b.fetchAll(first);
  assert.deepEqual(all.rows.map((row) => row[0]), Array.from({ length: 3000 }, (_, i) => i + 1));
  assert.equal(all.rows[2999]?.[1], "value number 3000");
  await a.execute("BEGIN");
  await a.execute("DELETE FROM BIG WHERE N > ?", [10]);
  assert.deepEqual(rowsOf(await b.execute("SELECT COUNT(*) FROM BIG")), [["3000"]]);
  await a.execute("COMMIT");
  assert.deepEqual(rowsOf(await b.execute("SELECT COUNT(*) FROM BIG")), [["10"]]);
  // 정수 파라미터는 BIGINT 로 보므로 결과는 문자열이다. (BIGINT 는 JSON 에서 문자열)
  assert.deepEqual(rowsOf(await a.execute("SELECT ?, ?, ?", [42, "한글", null])), [["42", "한글", null]]);
});

test("서버의 패킷 크기에 맞추어 조각낸다 (양쪽 모두 maxPacketSize 이내)", async (t) => {
  const fixture = await setup(t, { udp: { maxPacketSize: 300 }, proxy: {} });
  const connection = await fixture.login();
  await connection.execute("CREATE TABLE T (S VARCHAR(2000))");
  await connection.execute("INSERT INTO T VALUES (?)", ["x".repeat(1500)]);
  const result = await connection.execute("SELECT S FROM T");
  assert.equal(rowsOf(result)[0]?.[0], "x".repeat(1500));
  const proxy = fixture.proxy as LossyProxy;
  assert.ok(proxy.stats.maxServerPacket <= 300, `서버 패킷 ${proxy.stats.maxServerPacket}`);
  assert.ok(proxy.stats.maxClientPacket <= 300, `클라이언트 패킷 ${proxy.stats.maxClientPacket}`);
  assert.ok(proxy.stats.maxClientPacket > 200, "조각이 크기를 거의 다 채운다");
});

test("연결이 끊기면(abort) FIN 으로 서버가 세션을 바로 정리하고 롤백한다", async (t) => {
  const fixture = await setup(t);
  const a = await fixture.login();
  await a.execute("CREATE TABLE T (X INTEGER)");
  await a.execute("INSERT INTO T VALUES (1)");
  await a.execute("BEGIN");
  await a.execute("UPDATE T SET X = 2");
  a.abort();
  await waitFor(() => fixture.server.sessionCount === 0, 3000, "the server to drop the session");
  assert.equal(fixture.db.sessions.countRemote(), 0);
  const b = await fixture.login();
  assert.deepEqual(rowsOf(await b.execute("SELECT X FROM T")), [[1]]);
  await b.execute("UPDATE T SET X = 3");
});

test("정상적으로 close 하면 세션이 사라진다", async (t) => {
  const fixture = await setup(t);
  const a = await fixture.login();
  await a.close();
  await waitFor(() => fixture.server.sessionCount === 0, 3000, "the session to go");
  assert.equal(a.isClosed, true);
});

test("서버가 세션을 닫으면 클라이언트는 곧 알게 된다 (서버 종료 57P01)", async (t) => {
  const fixture = await setup(t);
  const connection = await fixture.login();
  fixture.db.close();
  await waitFor(() => connection.isClosed, 5000, "the client to notice");
  await assert.rejects(connection.execute("SELECT 1"), isDbError("57P01"));
});

// ---------------------------------------------------------------------------
// 패킷 유실과 중복
// ---------------------------------------------------------------------------

test("패킷 유실 15%, 중복 10%, 지연 0 ~ 20 ms 에서도 로그인과 질의와 트랜잭션이 통과한다", async (t) => {
  const fixture = await setup(t, { proxy: { seed: 11, lossToServer: 0.15, lossToClient: 0.15, duplicate: 0.1, minDelay: 0, maxDelay: 20 } });
  const a = await fixture.login();
  const b = await fixture.login();
  await a.execute("CREATE TABLE BIG (N INTEGER, S VARCHAR(40))");
  for (let start = 1; start <= 1500; start += 500) {
    await a.execute(`INSERT INTO BIG VALUES ${Array.from({ length: 500 }, (_, i) => `(${start + i}, 'value number ${start + i}')`).join(",")}`);
  }
  const first = (await b.execute("SELECT N, S FROM BIG ORDER BY N")) as RowsResult;
  const all = await b.fetchAll(first);
  assert.deepEqual(all.rows.map((row) => row[0]), Array.from({ length: 1500 }, (_, i) => i + 1));
  await a.execute("BEGIN");
  await a.execute("DELETE FROM BIG");
  await a.execute("ROLLBACK");
  assert.deepEqual(rowsOf(await b.execute("SELECT COUNT(*) FROM BIG")), [["1500"]]);
  const proxy = fixture.proxy as LossyProxy;
  assert.ok(proxy.stats.droppedToServer > 0 && proxy.stats.droppedToClient > 0, "패킷이 실제로 유실되었다");
  // 중복 패킷 때문에 같은 문장이 두 번 실행되지 않았다.
  assert.deepEqual(rowsOf(await a.execute("SELECT COUNT(*) FROM BIG")), [["1500"]]);
});

test("유실 25% 에서 같은 INSERT 가 한 번만 실행된다 (재전송이 중복 실행을 만들지 않는다)", async (t) => {
  const fixture = await setup(t, { proxy: { seed: 5, lossToServer: 0.25, lossToClient: 0.25, duplicate: 0.3, minDelay: 0, maxDelay: 8 } });
  const connection = await fixture.login();
  await connection.execute("CREATE TABLE C (N INTEGER)");
  for (let n = 0; n < 40; n++) await connection.execute("INSERT INTO C VALUES (?)", [n]);
  assert.deepEqual(rowsOf(await connection.execute("SELECT COUNT(*), COUNT(DISTINCT N) FROM C")), [["40", "40"]]);
});

test("모든 패킷이 두 번씩 와도 한 번만 처리한다", async (t) => {
  const fixture = await setup(t, { proxy: { seed: 3, duplicate: 1, minDelay: 0, maxDelay: 5 } });
  const connection = await fixture.login();
  await connection.execute("CREATE TABLE C (N INTEGER)");
  for (let n = 0; n < 15; n++) await connection.execute("INSERT INTO C VALUES (?)", [n]);
  assert.deepEqual(rowsOf(await connection.execute("SELECT COUNT(*) FROM C")), [["15"]]);
});

// ---------------------------------------------------------------------------
// 세션 시간 제한과 유지
// ---------------------------------------------------------------------------

test("클라이언트는 유휴 상태에서 ping 으로 세션을 유지한다", async (t) => {
  const fixture = await setup(t, { udp: { sessionTimeoutMs: 600 } });
  const connection = await fixture.login();
  await new Promise((resolve) => setTimeout(resolve, 2500)); // 세션 시간 제한의 4배 동안 아무것도 보내지 않는다.
  assert.equal(fixture.server.sessionCount, 1);
  assert.deepEqual(rowsOf(await connection.execute("SELECT 1")), [[1]]);
});

test("패킷이 끊긴 세션은 udp.sessionTimeoutMs 뒤에 정리되고 롤백된다", async (t) => {
  const fixture = await setup(t, { udp: { sessionTimeoutMs: 400 }, proxy: {} });
  const connection = await fixture.login();
  await connection.execute("CREATE TABLE T (X INTEGER)");
  await connection.execute("INSERT INTO T VALUES (1)");
  await connection.execute("BEGIN");
  await connection.execute("UPDATE T SET X = 2");
  (fixture.proxy as LossyProxy).blockToServer = true; // 클라이언트가 죽은 것처럼 서버로 가는 패킷이 모두 사라진다.
  await waitFor(() => fixture.server.sessionCount === 0, 6000, "the server to time out the session");
  assert.equal(fixture.db.sessions.count, 0);
  assert.ok(fixture.logger.lines.some((line) => /timed out after 400 ms/.test(line)));
  // 롤백되었고 잠금도 풀렸다.
  const session = fixture.db.createSession({});
  assert.deepEqual(session.execute("SELECT X FROM T").kind, "select");
  assert.doesNotThrow(() => session.execute("UPDATE T SET X = 5"));
  assert.deepEqual((session.execute("SELECT X FROM T") as { rows: unknown[][] }).rows.map((row) => String(row[0])), ["5"]);
});

test("문장을 실행 중(잠금 대기 중)인 세션은 세션 시간 제한에서 제외한다", async (t) => {
  const fixture = await setup(t, { udp: { sessionTimeoutMs: 300 }, proxy: {} });
  const admin = fixture.db.createSession({});
  admin.execute("CREATE TABLE L (X INTEGER)");
  admin.execute("INSERT INTO L VALUES (1)");
  admin.execute("BEGIN");
  admin.execute("UPDATE L SET X = 2");
  const connection = await fixture.login();
  // 클라이언트가 잠금을 기다리는 동안 keepalive 도 없고(요청이 진행 중), 서버는 그 세션을 닫으면 안 된다.
  const waiting = connection.execute("UPDATE SYSTEM.L SET X = 3");
  await new Promise((resolve) => setTimeout(resolve, 1800));
  assert.equal(fixture.server.sessionCount, 1, "대기 중인 세션이 시간 제한으로 닫히지 않았다");
  admin.execute("COMMIT");
  assert.equal((await waiting).kind, "ok");
});

test("udp.sessionTimeoutMs 가 0 이면 시간 제한이 없다", async (t) => {
  const fixture = await setup(t, { udp: { sessionTimeoutMs: 0 }, proxy: {} });
  const connection = await fixture.login();
  assert.equal(connection.hello.udp?.sessionTimeoutMs, 0);
  (fixture.proxy as LossyProxy).blockToServer = true;
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(fixture.server.sessionCount, 1, "시간 제한이 없으므로 세션이 남는다");
});

// ---------------------------------------------------------------------------
// 세션 식별과 위조, 쓰레기 패킷
// ---------------------------------------------------------------------------

test("세션 번호가 맞아도 출발지 주소가 다르면 응답 없이 버린다", async (t) => {
  const fixture = await setup(t, { proxy: {} });
  const connection = await fixture.login();
  const sessionId = (fixture.proxy as LossyProxy).capturedSessionId;
  assert.notEqual(sessionId, 0);
  assert.ok(sessionId > 0 && sessionId <= 0xffffffff);
  const spoof = encodePacket({ flags: UdpFlags.DATA, sessionId, seq: 99, fragIndex: 0, fragCount: 1, ackSeq: 0, payload: Buffer.from('{"id":1,"type":"close"}') });
  const fin = encodePacket({ flags: UdpFlags.FIN, sessionId, seq: 0, fragIndex: 0, fragCount: 0, ackSeq: 0, payload: emptyPayload });
  // 프록시를 거치지 않고 서버에 곧바로 다른 주소(소켓)에서 보낸다. (프록시의 업스트림 주소와 다르다)
  const replies = await probe(fixture.port, [spoof, fin]);
  assert.equal(replies.length, 0, "위조 주소에는 RST 도 보내지 않는다");
  assert.equal(fixture.server.sessionCount, 1, "FIN 도 효과가 없다");
  assert.deepEqual(rowsOf(await connection.execute("SELECT 1")), [[1]]);
});

test("모르는 세션 번호에는 RST 로 답한다 (20바이트 헤더뿐)", async (t) => {
  const fixture = await setup(t);
  const packet = encodePacket({ flags: UdpFlags.DATA, sessionId: 0x12345678, seq: 1, fragIndex: 0, fragCount: 1, ackSeq: 0, payload: Buffer.from("x") });
  const replies = await probe(fixture.port, [packet]);
  assert.equal(replies.length, 1);
  assert.equal((replies[0] as Buffer).length, 20, "증폭이 없다");
  const reply = decodePacket(replies[0] as Buffer);
  assert.ok(reply !== null);
  assert.equal(reply.flags, UdpFlags.RST);
  assert.equal(reply.sessionId, 0x12345678);
  // RST 에는 응답하지 않는다.
  const answers = await probe(fixture.port, [encodePacket({ flags: UdpFlags.RST, sessionId: 5, seq: 0, fragIndex: 0, fragCount: 0, ackSeq: 0, payload: emptyPayload })]);
  assert.equal(answers.length, 0);
});

test("잘못된 패킷과 쓰레기는 조용히 버리고 서버는 계속 동작한다", async (t) => {
  const fixture = await setup(t);
  const good = encodePacket({ flags: UdpFlags.DATA | UdpFlags.SYN, sessionId: 0, seq: 1, fragIndex: 0, fragCount: 1, ackSeq: 0, payload: Buffer.from("{}") });
  const badMagic = Buffer.from(good);
  badMagic[0] = 0;
  const badVersion = Buffer.from(good);
  badVersion[2] = 9;
  const noSyn = encodePacket({ flags: UdpFlags.DATA, sessionId: 0, seq: 1, fragIndex: 0, fragCount: 1, ackSeq: 0, payload: Buffer.from("{}") });
  const oversize = encodePacket({ flags: UdpFlags.DATA | UdpFlags.SYN, sessionId: 0, seq: 1, fragIndex: 0, fragCount: 1, ackSeq: 0, payload: Buffer.alloc(1500) });
  const random = Buffer.from(Array.from({ length: 200 }, (_, i) => (i * 37 + 11) & 0xff));
  const replies = await probe(fixture.port, [Buffer.alloc(0), Buffer.from("x"), badMagic, badVersion, noSyn, oversize, random, good.subarray(0, 19)]);
  assert.equal(replies.length, 0);
  assert.equal(fixture.server.sessionCount, 0, "세션이 만들어지지 않았다");
  const connection = await fixture.login();
  assert.deepEqual(rowsOf(await connection.execute("SELECT 1")), [[1]]);
});

test("본문이 JSON 이 아닌 hello 는 위반이고 세션이 정리된다", async (t) => {
  const fixture = await setup(t);
  const hello = encodePacket({ flags: UdpFlags.DATA | UdpFlags.SYN, sessionId: 0, seq: 1, fragIndex: 0, fragCount: 1, ackSeq: 0, payload: Buffer.from("not json at all") });
  const replies = await probe(fixture.port, [hello], 500);
  const packets = replies.map((reply) => decodePacket(reply)).filter((packet) => packet !== null);
  const data = packets.find((packet) => (packet.flags & UdpFlags.DATA) !== 0);
  assert.ok(data !== undefined, "위반 오류 메시지가 온다");
  assert.equal((JSON.parse(data.payload.toString("utf8")) as { sqlState: string }).sqlState, "08P01");
  await waitFor(() => fixture.server.sessionCount === 0, 7000, "the session to be removed");
});

// ---------------------------------------------------------------------------
// 인증 전 세션, 접속 수 제한
// ---------------------------------------------------------------------------

test("인증을 끝내지 않은 세션은 인증 시간 제한 뒤에 정리된다", async (t) => {
  const fixture = await setup(t, { env: { limits: { authTimeoutMs: 200 } } });
  const hello = encodePacket({ flags: UdpFlags.DATA | UdpFlags.SYN, sessionId: 0, seq: 1, fragIndex: 0, fragCount: 1, ackSeq: 0, payload: Buffer.from('{"id":1,"type":"hello","versions":[1]}') });
  const socket = dgram.createSocket("udp4");
  socket.on("error", () => undefined);
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", () => resolve()));
  socket.send(hello, fixture.port, "127.0.0.1");
  await waitFor(() => fixture.server.sessionCount === 1, 3000, "the session to open");
  await waitFor(() => fixture.server.sessionCount === 0, 7000, "the pre-auth session to be removed");
  assert.equal(fixture.env.limits.preAuthCount, 0);
  await new Promise<void>((resolve) => socket.close(() => resolve()));
});

test("인증 전 세션 수 제한을 넘는 SYN 은 응답 없이 버린다", async (t) => {
  const fixture = await setup(t, { env: { limits: { maxPreAuth: 2, authTimeoutMs: 30_000 } } });
  const hello = (id: number): Buffer =>
    encodePacket({ flags: UdpFlags.DATA | UdpFlags.SYN, sessionId: 0, seq: 1, fragIndex: 0, fragCount: 1, ackSeq: 0, payload: Buffer.from(`{"id":${id},"type":"hello","versions":[1]}`) });
  // 소켓마다 주소가 다르므로 세션이 따로 열린다. 응답 대기를 위해 소켓을 열어 둔다.
  const sockets: dgram.Socket[] = [];
  const replied: boolean[] = [];
  for (let i = 0; i < 4; i++) {
    const socket = dgram.createSocket("udp4");
    socket.on("error", () => undefined);
    replied.push(false);
    socket.on("message", () => (replied[i] = true));
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", () => resolve()));
    socket.send(hello(i + 1), fixture.port, "127.0.0.1");
    sockets.push(socket);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  assert.equal(fixture.server.sessionCount, 2);
  assert.deepEqual(replied, [true, true, false, false]);
  for (const socket of sockets) await new Promise<void>((resolve) => socket.close(() => resolve()));
});

test("maxConnections 에 이르면 새 UDP 접속은 hello 에서 53300 으로 거절된다", async (t) => {
  const fixture = await setup(t, { db: { maxConnections: 1 } });
  await fixture.login();
  await assert.rejects(fixture.open(), isDbError("53300", 8001));
  assert.equal(fixture.db.sessions.countRemote(), 1);
});

test("새 접속 받기를 멈추면 새 접속은 응답을 받지 못하고 기존 세션은 유지된다", async (t) => {
  const fixture = await setup(t);
  const existing = await fixture.login();
  await fixture.server.stopAccepting();
  await assert.rejects(fixture.open(600), isDbError("08006"));
  assert.deepEqual(rowsOf(await existing.execute("SELECT 1")), [[1]]);
});

test("같은 포트를 이미 쓰고 있으면 구동에 실패한다", async (t) => {
  const fixture = await setup(t);
  const second = new UdpServer(makeEnvironment(fixture.db), { host: "127.0.0.1", port: fixture.port, maxPacketSize: 1200, sessionTimeoutMs: 60_000 });
  await assert.rejects(second.start(), (error) => error instanceof StartupError && /already in use/.test(error.message));
});

test("서버가 다시 시작되어 세션을 잃으면 클라이언트는 RST 로 알게 된다", async (t) => {
  const dir = tempDir(t);
  const db = Database.open(dir, { onWarning: () => {}, scramIterations: 1000 });
  const env = makeEnvironment(db);
  const port = await freePort();
  const first = new UdpServer(env, { host: "127.0.0.1", port, maxPacketSize: 1200, sessionTimeoutMs: 60_000 });
  await first.start();
  const connection = await Connection.open({ kind: "udp", host: "127.0.0.1", port });
  await connection.login({ user: "SYSTEM", password: "HelloWorldDB" });
  // 소켓만 새로 연다. (데이터베이스와 포트는 그대로이고 세션 표만 사라진 서버 재시작 흉내)
  await first.closeConnections(0);
  const second = new UdpServer(env, { host: "127.0.0.1", port, maxPacketSize: 1200, sessionTimeoutMs: 60_000 });
  await second.start();
  t.after(async () => {
    connection.abort();
    await second.closeConnections(200);
    db.close();
  });
  await assert.rejects(connection.execute("SELECT 1"), isDbError("08006"));
  assert.equal(connection.isClosed, true);
});

test("서버가 없는 포트에는 연결 제한 시간 안에 08006 으로 실패한다", async () => {
  const port = await freePort();
  const started = Date.now();
  await assert.rejects(
    Connection.open({ kind: "udp", host: "127.0.0.1", port }, { internal: { connectTimeoutMs: 800 } }),
    (error) => {
      assert.ok(error instanceof DbError);
      assert.equal(error.sqlState, "08006");
      return true;
    },
  );
  assert.ok(Date.now() - started < 3000);
  void isConnectionRefused;
});

test("UDP 접속 10개가 동시에 같은 테이블에 쓰고 읽는다 (패킷 유실 10%)", async (t) => {
  const fixture = await setup(t, { proxy: { seed: 17, lossToServer: 0.1, lossToClient: 0.1, duplicate: 0.05, minDelay: 0, maxDelay: 6 } });
  const admin = await fixture.login();
  await admin.execute("CREATE TABLE C (WHO INTEGER, N INTEGER)");
  const clients = await Promise.all(Array.from({ length: 10 }, () => fixture.login()));
  await Promise.all(
    clients.map(async (client, who) => {
      for (let n = 0; n < 8; n++) {
        await client.execute("INSERT INTO C VALUES (?, ?)", [who, n]);
        await client.execute("SELECT COUNT(*) FROM C");
      }
    }),
  );
  assert.deepEqual(rowsOf(await admin.execute("SELECT COUNT(*), COUNT(DISTINCT WHO) FROM C")), [["80", "10"]]);
});
