/**
 * 로컬 전용 채널과 클라이언트 테스트 (9단계, 9-5). 실제 네임드 파이프(Windows) 또는 유닉스 소켓으로 접속한다.
 * 관련 사양 : AGENTS.md 상세 6, 8, 9, 14, 15
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { test } from "node:test";
import { Connection, connectionFailure, isConnectionRefused } from "../../src/client/connection.js";
import type { ClientParam, RowsResult } from "../../src/client/connection.js";
import { DbError, StartupError } from "../../src/common/errors.js";
import { getLocalChannelAddress } from "../../src/common/instance.js";
import { LocalChannelServer } from "../../src/net/localChannelServer.js";
import type { ControlPort } from "../../src/net/messageHandler.js";
import { Database } from "../../src/session/session.js";
import type { DatabaseOptions } from "../../src/session/session.js";
import { tempDir } from "../exec/helpers.js";
import { capturingLogger, freePort, makeEnvironment, waitFor } from "./helpers.js";

interface Fixture {
  db: Database;
  port: number;
  server: LocalChannelServer;
  connect(): Promise<Connection>;
  login(user?: string, password?: string): Promise<Connection>;
  control: ControlPort & { stops: number };
}

async function setup(t: { after(fn: () => unknown): void }, options: DatabaseOptions = {}): Promise<Fixture> {
  const dir = tempDir(t);
  const db = Database.open(dir, { onWarning: () => {}, scramIterations: 1000, lockTimeoutMs: 3000, ...options });
  const control = {
    stops: 0,
    controlToken: (): string => "local-test-token",
    status: () => ({ running: true, port, pid: process.pid, startedAt: "now", version: "0.1.0", dataDir: dir, tcpEnabled: false, udpEnabled: false, sessionCount: db.sessions.count, ready: true, systemPasswordInitial: false }),
    requestStop: (): void => {
      control.stops++;
    },
  };
  const port = await freePort();
  const env = makeEnvironment(db, { control, logger: capturingLogger() });
  const server = new LocalChannelServer(env, port);
  await server.start();
  const connections: Connection[] = [];
  t.after(async () => {
    for (const connection of connections) connection.abort();
    await server.closeConnections(500);
    db.close();
  });
  const connect = async (): Promise<Connection> => {
    const connection = await Connection.open({ kind: "local", port }, { requestTimeoutMs: 15000 });
    connections.push(connection);
    return connection;
  };
  return {
    db,
    port,
    server,
    control,
    connect,
    async login(user = "SYSTEM", password = "HelloWorldDB") {
      const connection = await connect();
      await connection.login({ user, password });
      return connection;
    },
  };
}

function rowsOf(result: Awaited<ReturnType<Connection["execute"]>>): unknown[][] {
  assert.equal(result.kind, "rows");
  return (result as RowsResult).rows;
}

test("옛 서버의 정리는 같은 유닉스 주소를 새로 쓰는 서버의 소켓을 지우지 않는다", {
  skip: process.platform === "win32" ? "유닉스 소켓 파일 전용 시험" : false,
}, async (t) => {
  const fixture = await setup(t);
  await fixture.server.stopAccepting();
  const next = new LocalChannelServer(makeEnvironment(fixture.db), fixture.port);
  await next.start();
  t.after(() => next.closeConnections(0));
  await fixture.server.closeConnections(0);
  assert.ok(fs.statSync(getLocalChannelAddress(fixture.port)).isSocket());
  const connection = await fixture.login();
  assert.deepEqual(rowsOf(await connection.execute("SELECT 1")), [[1]]);
});

test("로컬 전용 채널로 로그인하고 Hello World 두 샘플을 실행한다", async (t) => {
  const fixture = await setup(t);
  const connection = await fixture.login();
  assert.equal(connection.session?.user, "SYSTEM");
  assert.equal(connection.hello.version, 1);
  assert.deepEqual(rowsOf(await connection.execute("SELECT 'Hello World'")), [["Hello World"]]);
  assert.equal((await connection.execute("CREATE TABLE HELLO (MESSAGE VARCHAR)")).kind, "ok");
  const insert = await connection.execute("INSERT INTO HELLO VALUES ('Hello World')");
  assert.deepEqual(insert, { kind: "ok", message: insert.kind === "ok" ? insert.message : "", rowCount: 1 });
  assert.deepEqual(rowsOf(await connection.execute("SELECT * FROM HELLO")), [["Hello World"]]);
});

test("파라미터 바인딩 : 정수, 큰 정수, 문자열, NULL, 이진, 논리", async (t) => {
  const fixture = await setup(t);
  const connection = await fixture.login();
  await connection.execute("CREATE TABLE P (I INTEGER, B BIGINT, S VARCHAR(20), BI VARBINARY(4), F BOOLEAN)");
  const params: ClientParam[] = [42, 9007199254740993n, "한글", Buffer.from("ab12", "hex"), true];
  await connection.execute("INSERT INTO P VALUES (?, ?, ?, ?, ?)", params);
  await connection.execute("INSERT INTO P VALUES (?, ?, ?, ?, ?)", [null, undefined, null, null, null]);
  assert.deepEqual(rowsOf(await connection.execute("SELECT * FROM P ORDER BY I")), [
    [42, "9007199254740993", "한글", "AB12", true],
    [null, null, null, null, null],
  ]);
  await assert.rejects(connection.execute("SELECT ?", [Number.NaN]), RangeError);
});

test("대량 결과를 묶음으로 받는다 (fetch, fetchAll, closeCursor)", async (t) => {
  const fixture = await setup(t);
  const connection = await fixture.login();
  await connection.execute("CREATE TABLE BIG (N INTEGER, S VARCHAR(30))");
  for (let start = 1; start <= 3000; start += 500) {
    const values: string[] = [];
    for (let n = start; n < start + 500; n++) values.push(`(${n}, 'value ${n}')`);
    await connection.execute(`INSERT INTO BIG VALUES ${values.join(",")}`);
  }
  const first = await connection.execute("SELECT N, S FROM BIG ORDER BY N");
  assert.equal(first.kind, "rows");
  const rows = first as RowsResult;
  assert.equal(rows.rows.length, 500);
  assert.equal(rows.hasMore, true);
  assert.notEqual(rows.cursor, null);
  const all = await connection.fetchAll(rows);
  assert.equal(all.rows.length, 3000);
  assert.equal(all.hasMore, false);
  assert.deepEqual(all.rows.map((row) => row[0]), Array.from({ length: 3000 }, (_, i) => i + 1));
  assert.deepEqual(all.columns.map((column) => column.name), ["N", "S"]);
  // 직접 fetch 하고 중간에 닫는다.
  const again = (await connection.execute("SELECT N FROM BIG ORDER BY N", [], { fetchSize: 100 })) as RowsResult;
  const batch = await connection.fetch(again.cursor as number, 250);
  assert.equal(batch.rows.length, 250);
  assert.equal(batch.rows[0]?.[0], 101);
  await connection.closeCursor(again.cursor as number);
  await assert.rejects(connection.fetch(again.cursor as number), (error) => error instanceof DbError && error.sqlState === "34000");
});

test("같은 접속에 요청을 한꺼번에 보내도 응답이 요청과 짝지어진다", async (t) => {
  const fixture = await setup(t);
  const connection = await fixture.login();
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => connection.execute(`SELECT ${i}`)));
  assert.deepEqual(results.map((result) => rowsOf(result)[0]?.[0]), Array.from({ length: 30 }, (_, i) => i));
  const mixed = await Promise.allSettled([connection.execute("SELECT 1"), connection.execute("SELEC 2"), connection.execute("SELECT 3")]);
  assert.equal(mixed[0]?.status, "fulfilled");
  assert.equal(mixed[1]?.status, "rejected");
  assert.equal(mixed[2]?.status, "fulfilled");
  await connection.ping();
});

test("트랜잭션 : 커밋, 롤백, 세이브포인트, 다른 접속에는 커밋 뒤에 보인다", async (t) => {
  const fixture = await setup(t);
  const a = await fixture.login();
  const b = await fixture.login();
  await a.execute("CREATE TABLE T (X INTEGER)");
  await a.execute("BEGIN");
  await a.execute("INSERT INTO T VALUES (1)");
  assert.deepEqual(rowsOf(await a.execute("SELECT X FROM T")), [[1]]);
  assert.deepEqual(rowsOf(await b.execute("SELECT X FROM T")), [], "커밋 전에는 보이지 않는다");
  await a.execute("COMMIT");
  assert.deepEqual(rowsOf(await b.execute("SELECT X FROM T")), [[1]]);
  await a.execute("BEGIN");
  await a.execute("INSERT INTO T VALUES (2)");
  await a.execute("SAVEPOINT S1");
  await a.execute("INSERT INTO T VALUES (3)");
  await a.execute("ROLLBACK TO S1");
  await a.execute("COMMIT");
  assert.deepEqual(rowsOf(await b.execute("SELECT X FROM T ORDER BY X")), [[1], [2]]);
  await a.execute("BEGIN");
  await a.execute("INSERT INTO T VALUES (9)");
  await a.execute("ROLLBACK");
  assert.deepEqual(rowsOf(await b.execute("SELECT X FROM T ORDER BY X")), [[1], [2]]);
  // 자동 커밋 OFF
  await a.execute("SET AUTOCOMMIT OFF");
  await a.execute("INSERT INTO T VALUES (5)");
  assert.deepEqual(rowsOf(await b.execute("SELECT COUNT(*) FROM T")), [["2"]]);
  await a.execute("COMMIT");
  assert.deepEqual(rowsOf(await b.execute("SELECT COUNT(*) FROM T")), [["3"]]);
});

test("문장 오류는 SQLSTATE 와 위치를 가진 DbError 이고 접속은 유지된다", async (t) => {
  const fixture = await setup(t);
  const connection = await fixture.login();
  await assert.rejects(connection.execute("SELEC 1"), (error) => {
    assert.ok(error instanceof DbError);
    assert.equal(error.sqlState, "42601");
    assert.equal(error.code, 3000);
    assert.equal(error.position?.line, 1);
    return true;
  });
  await assert.rejects(connection.execute("SELECT * FROM NOPE"), (error) => error instanceof DbError && error.sqlState === "42P01");
  assert.deepEqual(rowsOf(await connection.execute("SELECT 1")), [[1]]);
});

test("틀린 비밀번호와 없는 사용자는 같은 오류이고 접속이 닫힌다", async (t) => {
  const fixture = await setup(t);
  const errors: DbError[] = [];
  for (const [user, password] of [["SYSTEM", "wrong"], ["NOBODY", "wrong"]] as const) {
    const connection = await fixture.connect();
    await assert.rejects(connection.login({ user, password }), (error) => {
      assert.ok(error instanceof DbError);
      errors.push(error);
      return true;
    });
    await waitFor(() => connection.isClosed, 3000, "the connection to close");
    await assert.rejects(connection.execute("SELECT 1"), (error) => error instanceof DbError);
  }
  assert.equal(errors[0]?.sqlState, "28000");
  assert.equal(errors[0]?.code, 7000);
  assert.equal(errors[0]?.message, errors[1]?.message);
  assert.equal(errors[0]?.code, errors[1]?.code);
});

test("로컬 전용 채널은 maxConnections 가 0 이고 CONNECT 가 없어도 항상 받는다", async (t) => {
  const fixture = await setup(t, { maxConnections: 0 });
  fixture.db.createSession({}).execute("CREATE USER NOCONNECT IDENTIFIED BY 'pw'");
  const admin = await fixture.login();
  const other = await fixture.login("NOCONNECT", "pw");
  assert.equal(other.session?.user, "NOCONNECT");
  assert.deepEqual(rowsOf(await admin.execute("SELECT COUNT(*) FROM SYS_SESSIONS")), [["3"]], "createSession 으로 만든 것과 로컬 접속 둘");
  assert.equal(fixture.db.sessions.countRemote(), 0);
  // 세션 목록에 접속 경로가 보인다.
  assert.deepEqual(rowsOf(await admin.execute("SELECT DISTINCT CHANNEL FROM SYS_SESSIONS")), [["LOCAL"]]);
});

test("없는 테이블스페이스를 접속 직후의 테이블스페이스로 줄 수 없다", async (t) => {
  const fixture = await setup(t);
  const connection = await fixture.connect();
  await assert.rejects(connection.login({ user: "SYSTEM", password: "HelloWorldDB", tablespace: "NOPE" }), (error) => error instanceof DbError && error.sqlState === "3D000");
  fixture.db.createSession({}).execute("CREATE TABLESPACE APP");
  const good = await fixture.connect();
  const session = await good.login({ user: "SYSTEM", password: "HelloWorldDB", tablespace: "APP", timeZone: "+09:00" });
  assert.equal(session.tablespace, "APP");
  assert.equal(session.timeZone, "+09:00");
});

test("데몬 제어 요청 : status 와 stop 은 토큰으로 받고, 같은 접속에서 로그인은 하지 않는다", async (t) => {
  const fixture = await setup(t);
  const status = await Connection.open({ kind: "local", port: fixture.port });
  const info = await status.control("status", "local-test-token");
  assert.equal(info.running, true);
  assert.equal(info.pid, process.pid);
  assert.equal(info.port, fixture.port);
  await status.close();

  const wrong = await Connection.open({ kind: "local", port: fixture.port });
  await assert.rejects(wrong.control("stop", "nope"), (error) => error instanceof DbError && error.sqlState === "28000");
  assert.equal(fixture.control.stops, 0);

  const stop = await Connection.open({ kind: "local", port: fixture.port });
  await stop.control("stop", "local-test-token");
  assert.equal(fixture.control.stops, 1);
  await waitFor(() => stop.isClosed, 3000, "the stop connection to close");
});

test("접속이 갑자기 끊기면 서버가 세션을 닫고 롤백하고 잠금을 푼다", async (t) => {
  const fixture = await setup(t);
  const a = await fixture.login();
  await a.execute("CREATE TABLE T (X INTEGER)");
  await a.execute("INSERT INTO T VALUES (1)");
  await a.execute("BEGIN");
  await a.execute("UPDATE T SET X = 2");
  const before = fixture.db.sessions.count;
  a.abort(); // close 메시지 없이 소켓만 끊는다.
  await waitFor(() => fixture.db.sessions.count === before - 1, 5000, "the server to drop the session");
  const b = await fixture.login();
  assert.deepEqual(rowsOf(await b.execute("SELECT X FROM T")), [[1]]);
  await b.execute("UPDATE T SET X = 3"); // 잠금이 풀렸으므로 기다리지 않는다.
  assert.deepEqual(rowsOf(await b.execute("SELECT X FROM T")), [[3]]);
});

test("정상적으로 close 하면 롤백하고 세션이 사라진다", async (t) => {
  const fixture = await setup(t);
  const a = await fixture.login();
  await a.execute("CREATE TABLE T (X INTEGER)");
  await a.execute("BEGIN");
  await a.execute("INSERT INTO T VALUES (1)");
  const before = fixture.db.sessions.count;
  await a.close();
  assert.equal(a.isClosed, true);
  await waitFor(() => fixture.db.sessions.count === before - 1, 5000, "the session to go");
  await assert.rejects(a.execute("SELECT 1"), (error) => error instanceof DbError);
  const b = await fixture.login();
  assert.deepEqual(rowsOf(await b.execute("SELECT COUNT(*) FROM T")), [["0"]]);
});

test("프레임 규칙을 어긴 입력은 위반 오류를 보내고 끊되 서버는 계속 동작한다", async (t) => {
  const fixture = await setup(t);
  const good = await fixture.login();
  const address = getLocalChannelAddress(fixture.port);
  // 인증 전 한도(64 KiB)를 넘는 길이
  const readReply = (socket: net.Socket): Promise<{ id: number; type: string; sqlState: string; code: number } | null> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("close", () => {
        const all = Buffer.concat(chunks);
        if (all.length < 4) return resolve(null);
        resolve(JSON.parse(all.subarray(4, 4 + all.readUInt32BE(0)).toString("utf8")) as never);
      });
      socket.on("error", () => undefined);
    });
  for (const header of [Buffer.from([0, 1, 0, 1]), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from([0, 0, 0, 0])]) {
    const socket = net.connect(address);
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    const reply = readReply(socket);
    socket.write(header);
    const message = await reply;
    assert.ok(message !== null, "위반 오류를 받아야 한다");
    assert.equal(message.type, "error");
    assert.equal(message.sqlState, "08P01");
    assert.equal(message.code, 8000);
    assert.equal(message.id, 0);
  }
  // 쓰레기 바이트
  const noise = net.connect(address);
  await new Promise<void>((resolve) => noise.once("connect", () => resolve()));
  noise.on("error", () => undefined);
  noise.resume(); // 서버가 보낸 오류를 읽어야 접속이 닫힌 것을 알 수 있다.
  noise.write(Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
  await new Promise<void>((resolve) => noise.once("close", () => resolve()));
  assert.deepEqual(rowsOf(await good.execute("SELECT 1")), [[1]], "다른 접속은 영향이 없다");
});

test("본문이 깨진 프레임(올바른 길이, JSON 아님)도 위반이다", async (t) => {
  const fixture = await setup(t);
  const socket = net.connect(getLocalChannelAddress(fixture.port));
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  const body = Buffer.from("this is not json");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  const chunks: Buffer[] = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  socket.write(Buffer.concat([header, body]));
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  const all = Buffer.concat(chunks);
  assert.equal((JSON.parse(all.subarray(4).toString("utf8")) as { sqlState: string }).sqlState, "08P01");
});

test("새 접속 받기를 멈추면 새 접속은 거부되고 기존 접속은 유지된다", async (t) => {
  const fixture = await setup(t);
  const existing = await fixture.login();
  await fixture.server.stopAccepting();
  // 새 접속은 맺어지지 않는다. (유닉스는 ECONNREFUSED 로 바로 실패하고, Windows 네임드 파이프는 기존 접속이 남아 있는 동안
  // 연결이 대기하다가 연결 제한 시간에 실패한다)
  await assert.rejects(Connection.open({ kind: "local", port: fixture.port }, { internal: { connectTimeoutMs: 400 } }), (error) => {
    assert.ok(error instanceof DbError);
    assert.equal(error.sqlState, "08006");
    return true;
  });
  assert.deepEqual(rowsOf(await existing.execute("SELECT 1")), [[1]]);
  await fixture.server.closeConnections(500);
  await waitFor(() => existing.isClosed, 3000, "the existing connection to close");
});

test("서버가 종료되면 클라이언트는 57P01 오류를 받는다", async (t) => {
  const fixture = await setup(t);
  const connection = await fixture.login();
  fixture.db.close();
  await waitFor(() => connection.isClosed, 5000, "the connection to close");
  await assert.rejects(connection.execute("SELECT 1"), (error) => error instanceof DbError && error.sqlState === "57P01");
});

test("같은 포트 번호의 두 번째 서버는 구동에 실패하고 포트가 인스턴스 식별자임을 알린다", async (t) => {
  const fixture = await setup(t);
  const env = makeEnvironment(fixture.db);
  const second = new LocalChannelServer(env, fixture.port);
  await assert.rejects(second.start(), (error) => {
    assert.ok(error instanceof StartupError);
    assert.match(error.message, /port number/);
    assert.match(error.message, new RegExp(String(fixture.port)));
    return true;
  });
});

test("데몬이 없으면 연결 거부로 알 수 있다", async () => {
  const port = await freePort();
  await assert.rejects(Connection.open({ kind: "local", port }), (error) => {
    assert.ok(error instanceof DbError);
    assert.equal(error.sqlState, "08006");
    assert.equal(isConnectionRefused(error), true);
    return true;
  });
  assert.equal(connectionFailure("x").code, 8006);
});

test("접속 10개가 동시에 같은 테이블에 쓰고 읽는다", async (t) => {
  const fixture = await setup(t);
  const admin = await fixture.login();
  await admin.execute("CREATE TABLE C (WHO INTEGER, N INTEGER)");
  const clients = await Promise.all(Array.from({ length: 10 }, () => fixture.login()));
  await Promise.all(
    clients.map(async (client, who) => {
      for (let n = 0; n < 15; n++) {
        await client.execute("INSERT INTO C VALUES (?, ?)", [who, n]);
        await client.execute("SELECT COUNT(*) FROM C");
      }
    }),
  );
  assert.deepEqual(rowsOf(await admin.execute("SELECT COUNT(*) FROM C")), [["150"]]);
  assert.deepEqual(rowsOf(await admin.execute("SELECT COUNT(DISTINCT WHO) FROM C")), [["10"]]);
});
