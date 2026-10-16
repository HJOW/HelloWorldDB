/**
 * 접속, 로그인, 세션, 접속 종료와 끊김 시험 (12-3, 12-5).
 * 실제 rdbms 를 띄워 TCP 와 UDP 로 접속한다.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Connection, DbError, connect } from "../src/index.js";
import type { ConnectOptions } from "../src/index.js";
import { TestServer, lanAddress, sleep, waitFor } from "./helpers/server.js";

const server = await TestServer.start({ after: (fn) => after(fn) });
const ADMIN = { user: "SYSTEM", password: "HelloWorldDB" } as const;

function open(extra: Partial<ConnectOptions> = {}, target: TestServer = server): Promise<Connection> {
  return connect({ port: target.port, ...ADMIN, ...extra });
}

async function rejection(promise: Promise<unknown>): Promise<DbError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DbError, `DbError 여야 한다: ${String(error)}`);
    return error;
  }
  throw new Error("거부되어야 한다.");
}

test("Hello World : 몇 줄이면 접속해서 조회하고 닫는다", async () => {
  const db = await connect({ port: server.port, user: "SYSTEM", password: "HelloWorldDB" });
  const result = await db.query("SELECT 'Hello World'");
  assert.equal(result.rows[0]?.[0], "Hello World");
  await db.close();
});

test("TCP 와 UDP 가 같은 포트 번호로 같은 서버에 접속된다 (호스트는 생략하면 127.0.0.1)", async () => {
  for (const protocol of ["tcp", "udp"] as const) {
    const db = await open({ protocol });
    assert.equal((await db.query("SELECT 1 + 1")).rows[0]?.[0], 2, protocol);
    assert.equal(db.session.user, "SYSTEM");
    await db.close();
  }
  // 호스트를 적어도 같다.
  const named = await open({ host: "127.0.0.1" });
  assert.equal((await named.query("SELECT 1")).rows[0]?.[0], 1);
  await named.close();
});

test("세션 정보와 서버 정보를 알려 준다", async () => {
  const db = await open();
  assert.equal(db.session.user, "SYSTEM");
  assert.equal(db.session.tablespace, "SYSTEM");
  assert.equal(db.session.autocommit, true);
  assert.ok(db.session.id > 0);
  assert.equal(db.serverInfo.protocolVersion, 1);
  assert.ok(db.serverInfo.server.length > 0);
  assert.equal(db.serverInfo.maxMessageBytes, 16 * 1024 * 1024);
  assert.equal(db.isClosed, false);
  await db.close();
  assert.equal(db.isClosed, true);
});

test("테이블스페이스를 지정해 접속한다. 기본 테이블스페이스가 없는 사용자는 tablespace 가 null 이다", async () => {
  const admin = await open();
  await admin.query("CREATE TABLESPACE ND_A");
  await admin.query("CREATE USER ND_NODEFAULT IDENTIFIED BY 'pw1'");
  const withTablespace = await open({ tablespace: "ND_A" });
  assert.equal(withTablespace.session.tablespace, "ND_A");
  await withTablespace.query("CREATE TABLE T (N INTEGER)"); // 현재 테이블스페이스 ND_A 에 만들어진다.
  assert.equal((await admin.query("SELECT COUNT(*) FROM SYS_TABLES WHERE TABLESPACE_NAME = 'ND_A' AND TABLE_NAME = 'T'")).rows[0]?.[0], 1n);
  const none = await open({ user: "ND_NODEFAULT", password: "pw1" });
  assert.equal(none.session.tablespace, null);
  for (const db of [admin, withTablespace, none]) await db.close();
});

test("세션 타임존을 지정할 수 있다", async () => {
  const db = await open({ timeZone: "+09:00" });
  assert.equal(db.session.timeZone, "+09:00");
  assert.equal((await db.query("SELECT CAST(TIMESTAMP '2026-01-01 00:00:00+00:00' AS VARCHAR(40))")).rows[0]?.[0] !== undefined, true);
  await db.close();
});

test("로그인 실패 : 없는 사용자와 틀린 비밀번호는 같은 오류(28000)이고 접속은 닫힌다", async () => {
  const wrong = await rejection(open({ password: "wrong" }));
  const none = await rejection(open({ user: "ND_NO_SUCH_USER", password: "wrong" }));
  assert.equal(wrong.sqlState, "28000");
  assert.equal(wrong.code, 7000);
  assert.equal(none.sqlState, wrong.sqlState);
  assert.equal(none.code, wrong.code);
  assert.equal(none.message, wrong.message);
});

test("CONNECT 권한 그룹이 없는 사용자는 원격 주소에서 접속할 수 없다 (루프백은 된다)", { skip: lanAddress() === null ? "루프백이 아닌 IPv4 주소가 없다" : false }, async () => {
  const lan = lanAddress() as string;
  const loopback = await open();
  await loopback.query("CREATE USER ND_REMOTE IDENTIFIED BY 'pw2'");
  // 루프백에서는 CONNECT 없이도 된다.
  const local = await open({ user: "ND_REMOTE", password: "pw2" });
  await local.close();
  const denied = await rejection(open({ host: lan, user: "ND_REMOTE", password: "pw2" }));
  assert.equal(denied.sqlState, "28000");
  assert.equal(denied.code, 7006);
  await loopback.query("GRANT CONNECT TO ND_REMOTE");
  const allowed = await open({ host: lan, user: "ND_REMOTE", password: "pw2" });
  assert.equal((await allowed.query("SELECT 1")).rows[0]?.[0], 1);
  await allowed.close();
  await loopback.close();
});

test("잘못된 옵션은 접속하기 전에 거부한다", async () => {
  await assert.rejects(() => connect({ user: "", password: "x" }), TypeError);
  await assert.rejects(() => connect({ user: "a", password: undefined as unknown as string }), TypeError);
  await assert.rejects(() => connect({ user: "a", password: "x", port: 0 }), RangeError);
  await assert.rejects(() => connect({ user: "a", password: "x", port: 70000 }), RangeError);
  await assert.rejects(() => connect({ user: "a", password: "x", host: "" }), TypeError);
  await assert.rejects(() => connect({ user: "a", password: "x", protocol: "ws" as unknown as "tcp" }), TypeError);
  await assert.rejects(() => connect({ user: "a", password: "x", protocol: "udp", ssl: true }), /TCP only/);
  await assert.rejects(() => connect({ user: "a", password: "x", fetchSize: 0 }), RangeError);
  await assert.rejects(() => connect(undefined as unknown as ConnectOptions), TypeError);
});

test("서버가 없는 포트로는 08006 으로 실패한다 (TCP 와 UDP)", async () => {
  const stopped = await TestServer.start({ after: (fn) => after(fn) });
  const port = stopped.port;
  stopped.stop();
  for (const protocol of ["tcp", "udp"] as const) {
    const error = await rejection(connect({ port, protocol, ...ADMIN, connectTimeoutMs: 3000 }));
    assert.equal(error.sqlState, "08006", protocol);
    assert.equal(error.isConnectionError, true);
  }
});

test("close 는 서버가 롤백했는지 알려 준다. 커밋하지 않은 변경은 남지 않는다", async () => {
  const db = await open();
  await db.query("CREATE TABLE ND_CLOSE (N INTEGER)");
  const clean = await db.close();
  assert.deepEqual(clean, { rolledBack: false });
  assert.deepEqual(await db.close(), { rolledBack: false }, "이미 닫힌 접속에 다시 불러도 괜찮다");

  const other = await open();
  await other.begin();
  await other.query("INSERT INTO ND_CLOSE VALUES (1)");
  assert.equal(other.inTransaction, true);
  assert.deepEqual(await other.close(), { rolledBack: true });
  const check = await open();
  assert.equal((await check.query("SELECT COUNT(*) FROM ND_CLOSE")).rows[0]?.[0], 0n);
  await check.close();
});

test("닫힌 접속으로 문장을 보내면 08006 이고, close 이벤트가 한 번 온다 (정상 종료는 오류 없음)", async () => {
  const db = await open();
  const events: Array<DbError | null> = [];
  db.on("close", (error: DbError | null) => events.push(error));
  await db.close();
  await waitFor(() => events.length > 0);
  assert.deepEqual(events, [null]);
  const error = await rejection(db.query("SELECT 1"));
  assert.equal(error.sqlState, "08006");
  await sleep(50);
  assert.equal(events.length, 1);
});

test("destroy 는 응답을 기다리지 않고 끊는다. 기다리던 요청은 08006 으로 실패한다", async () => {
  const db = await open();
  const events: Array<DbError | null> = [];
  db.on("close", (error: DbError | null) => events.push(error));
  const pending = db.query("SELECT 1");
  db.destroy();
  const error = await rejection(pending);
  assert.equal(error.sqlState, "08006");
  assert.equal(db.isClosed, true);
  await waitFor(() => events.length > 0);
});

test("서버가 내려가면 close 이벤트로 알리고(57P01) 이후의 문장은 실패한다", async () => {
  const own = await TestServer.start({ after: (fn) => after(fn) });
  const tcp = await open({}, own);
  const udp = await open({ protocol: "udp" }, own);
  const closed: Array<Promise<DbError | null>> = [tcp, udp].map(
    (db) => new Promise<DbError | null>((resolve) => db.once("close", (error: DbError | null) => resolve(error))),
  );
  await own.stopAsync(); // 이 프로세스에 열린 접속이 있으므로 이벤트 루프를 막지 않는다.
  for (const [index, promise] of closed.entries()) {
    const error = await promise;
    assert.ok(error !== null, `${index === 0 ? "TCP" : "UDP"} : 서버가 끊은 것은 오류로 알린다`);
    assert.equal(error.sqlState, "57P01", index === 0 ? "TCP" : "UDP");
  }
  assert.equal((await rejection(tcp.query("SELECT 1"))).isConnectionError, true);
});

test("유휴 시간이 지나 서버가 끊으면 57P05 로 알린다", async () => {
  const own = await TestServer.start({ after: (fn) => after(fn) }, { session: { idleTimeoutMs: 1500 } });
  const db = await open({}, own);
  const error = await new Promise<DbError | null>((resolve) => db.once("close", (e: DbError | null) => resolve(e)));
  assert.equal(error?.sqlState, "57P05");
  assert.equal(db.isClosed, true);
});

test("접속 수가 maxConnections 에 이르면 53300 으로 거부한다. 다른 접속이 닫히면 다시 접속된다", async () => {
  const own = await TestServer.start({ after: (fn) => after(fn) }, { maxConnections: 2 });
  const a = await open({}, own);
  const b = await open({ protocol: "udp" }, own);
  const error = await rejection(open({}, own));
  assert.equal(error.sqlState, "53300");
  await a.close();
  await waitFor(() => own.livePid() !== null);
  const c = await open({}, own);
  assert.equal((await c.query("SELECT 1")).rows[0]?.[0], 1);
  await b.close();
  await c.close();
});

test("요청 제한 시간을 넘으면 08006 으로 실패한다 (잠금을 기다리는 문장)", async () => {
  const a = await open();
  const b = await open({ requestTimeoutMs: 600 });
  await a.query("CREATE TABLE ND_TIMEOUT (ID INTEGER PRIMARY KEY, V INTEGER)");
  await a.query("INSERT INTO ND_TIMEOUT VALUES (1, 0)");
  await a.begin();
  await a.query("UPDATE ND_TIMEOUT SET V = 1 WHERE ID = 1");
  const error = await rejection(b.query("UPDATE ND_TIMEOUT SET V = 2 WHERE ID = 1")); // a 가 쥔 잠금을 기다린다.
  assert.equal(error.sqlState, "08006");
  assert.match(error.message, /600 ms/);
  await a.rollback();
  await a.close();
  b.destroy();
});

test("ping", async () => {
  const db = await open();
  await db.ping();
  await db.close();
});
