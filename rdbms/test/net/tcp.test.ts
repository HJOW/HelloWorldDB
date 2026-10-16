/**
 * TCP 와 TLS 테스트 (9단계, 9-6). 실제 TCP 소켓과 시험용 자체 서명 인증서(test/fixtures/tls)로 접속한다.
 * 클라이언트의 서버 인증서 검증과 재시도(설계 12-1절)를 포함한다.
 * 관련 사양 : AGENTS.md 상세 6, 7, 8, 9, 15
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Connection } from "../../src/client/connection.js";
import type { RowsResult, SslOptions } from "../../src/client/connection.js";
import { isCertificateError } from "../../src/client/transports.js";
import { DbError, StartupError } from "../../src/common/errors.js";
import type { TlsMinVersion } from "../../src/config/config.js";
import { TcpServer } from "../../src/net/tcpServer.js";
import { Database } from "../../src/session/session.js";
import type { DatabaseOptions } from "../../src/session/session.js";
import { tempDir } from "../exec/helpers.js";
import { capturingLogger, freePort, isBun, makeEnvironment, waitFor } from "./helpers.js";
import type { CapturingLogger, EnvironmentOptions } from "./helpers.js";

const FIXTURES = "../../../test/fixtures/tls/";
const fixturePath = (name: string): string => fileURLToPath(new URL(`${FIXTURES}${name}`, import.meta.url));
const certA = fs.readFileSync(fixturePath("server-a.cert.pem"), "utf8");
const certB = fs.readFileSync(fixturePath("server-b.cert.pem"), "utf8");
const keyA = fs.readFileSync(fixturePath("server-a.key.pem"), "utf8");
const certOther = fs.readFileSync(fixturePath("server-other-name.cert.pem"), "utf8");

interface Fixture {
  db: Database;
  server: TcpServer;
  port: number;
  logger: CapturingLogger;
  env: ReturnType<typeof makeEnvironment>;
  open(ssl?: SslOptions, internal?: { sleep?: (ms: number) => Promise<void>; connectTimeoutMs?: number }): Promise<Connection>;
  login(ssl?: SslOptions): Promise<Connection>;
}

interface SetupOptions {
  db?: DatabaseOptions;
  env?: EnvironmentOptions;
  tls?: { cert: string; key: string; minVersion?: TlsMinVersion };
}

async function setup(t: { after(fn: () => unknown): void }, options: SetupOptions = {}): Promise<Fixture> {
  const dir = tempDir(t);
  const db = Database.open(dir, { onWarning: () => {}, scramIterations: 1000, lockTimeoutMs: 3000, ...options.db });
  const logger = capturingLogger();
  const env = makeEnvironment(db, { logger, ...options.env });
  const port = await freePort();
  let ssl: { certPath: string; keyPath: string; minVersion: TlsMinVersion } | undefined;
  if (options.tls !== undefined) {
    const certPath = `${dir}/server.cert.pem`;
    const keyPath = `${dir}/server.key.pem`;
    fs.writeFileSync(certPath, options.tls.cert);
    fs.writeFileSync(keyPath, options.tls.key);
    ssl = { certPath, keyPath, minVersion: options.tls.minVersion ?? "TLSv1.2" };
  }
  const server = new TcpServer(env, { host: "127.0.0.1", port, ...(ssl === undefined ? {} : { ssl }) });
  await server.start();
  const connections: Connection[] = [];
  t.after(async () => {
    for (const connection of connections) connection.abort();
    await server.closeConnections(500);
    db.close();
  });
  const open: Fixture["open"] = async (sslOptions, internal) => {
    const connection = await Connection.open(
      { kind: "tcp", host: "127.0.0.1", port, ...(sslOptions === undefined ? {} : { ssl: sslOptions }) },
      { requestTimeoutMs: 15000, ...(internal === undefined ? {} : { internal }) },
    );
    connections.push(connection);
    return connection;
  };
  return {
    db,
    server,
    port,
    logger,
    env,
    open,
    async login(sslOptions) {
      const connection = await open(sslOptions);
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

// ---------------------------------------------------------------------------
// 평문 TCP
// ---------------------------------------------------------------------------

test("TCP 로 로그인하고 질의한다. 세션에 접속 경로와 주소가 기록된다", async (t) => {
  const fixture = await setup(t);
  const connection = await fixture.login();
  assert.deepEqual(rowsOf(await connection.execute("SELECT 'Hello World'")), [["Hello World"]]);
  assert.deepEqual(rowsOf(await connection.execute("SELECT CHANNEL, CLIENT_ADDRESS FROM SYS_SESSIONS")), [["TCP", "127.0.0.1"]]);
  assert.equal(fixture.db.sessions.countRemote(), 1);
  assert.equal(fixture.server.tlsEnabled, false);
});

test("루프백에서 온 TCP 접속은 로컬이라 CONNECT 가 없어도 받는다", async (t) => {
  const fixture = await setup(t);
  fixture.db.createSession({}).execute("CREATE USER NOCONNECT IDENTIFIED BY 'pw'");
  const connection = await fixture.open();
  const session = await connection.login({ user: "NOCONNECT", password: "pw" });
  assert.equal(session.user, "NOCONNECT");
});

test("대량 결과와 트랜잭션이 TCP 에서도 동작한다", async (t) => {
  const fixture = await setup(t);
  const a = await fixture.login();
  const b = await fixture.login();
  await a.execute("CREATE TABLE BIG (N INTEGER)");
  for (let start = 1; start <= 2500; start += 500) {
    await a.execute(`INSERT INTO BIG VALUES ${Array.from({ length: 500 }, (_, i) => `(${start + i})`).join(",")}`);
  }
  const first = (await b.execute("SELECT N FROM BIG ORDER BY N")) as RowsResult;
  assert.equal(first.hasMore, true);
  const all = await b.fetchAll(first);
  assert.deepEqual(all.rows.map((row) => row[0]), Array.from({ length: 2500 }, (_, i) => i + 1));
  await a.execute("BEGIN");
  await a.execute("DELETE FROM BIG");
  assert.deepEqual(rowsOf(await b.execute("SELECT COUNT(*) FROM BIG")), [["2500"]]);
  await a.execute("ROLLBACK");
  assert.deepEqual(rowsOf(await b.execute("SELECT COUNT(*) FROM BIG")), [["2500"]]);
});

test("maxConnections 에 이르면 새 TCP 접속은 hello 에서 53300 으로 거절된다", async (t) => {
  const fixture = await setup(t, { db: { maxConnections: 2 } });
  await fixture.login();
  await fixture.login();
  await assert.rejects(fixture.open(), isDbError("53300", 8001));
  assert.equal(fixture.db.sessions.countRemote(), 2);
});

test("연결이 끊기면 세션을 닫고 롤백하고 잠금을 푼다", async (t) => {
  const fixture = await setup(t);
  const a = await fixture.login();
  await a.execute("CREATE TABLE T (X INTEGER)");
  await a.execute("INSERT INTO T VALUES (1)");
  await a.execute("BEGIN");
  await a.execute("UPDATE T SET X = 2");
  a.abort();
  await waitFor(() => fixture.db.sessions.countRemote() === 0, 5000, "the session to be dropped");
  const b = await fixture.login();
  assert.deepEqual(rowsOf(await b.execute("SELECT X FROM T")), [[1]]);
  await b.execute("UPDATE T SET X = 3");
});

test("인증 전 시간 제한을 넘기면 응답 없이 닫는다", async (t) => {
  const fixture = await setup(t, { env: { limits: { authTimeoutMs: 100 } } });
  const socket = net.connect(fixture.port, "127.0.0.1");
  const received: Buffer[] = [];
  socket.on("data", (chunk) => received.push(chunk));
  socket.on("error", () => undefined);
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  assert.equal(Buffer.concat(received).length, 0, "오류 메시지를 보내지 않는다");
  assert.equal(fixture.env.limits.preAuthCount, 0);
});

test("인증 전 접속 수 제한을 넘는 TCP 접속은 응답 없이 바로 끊긴다", async (t) => {
  const fixture = await setup(t, { env: { limits: { maxPreAuth: 2 } } });
  const idle = [0, 1].map(() => {
    const socket = net.connect(fixture.port, "127.0.0.1");
    socket.on("error", () => undefined);
    socket.resume();
    return socket;
  });
  await waitFor(() => fixture.env.limits.preAuthCount === 2, 3000, "two pre-auth connections");
  const third = net.connect(fixture.port, "127.0.0.1");
  const received: Buffer[] = [];
  third.on("data", (chunk) => received.push(chunk));
  third.on("error", () => undefined);
  await new Promise<void>((resolve) => third.once("close", () => resolve()));
  assert.equal(Buffer.concat(received).length, 0);
  assert.equal(fixture.env.limits.preAuthCount, 2);
  // 앞의 둘이 나가면 자리가 난다.
  for (const socket of idle) socket.destroy();
  await waitFor(() => fixture.env.limits.preAuthCount === 0, 3000, "the slots to be released");
  const connection = await fixture.login();
  assert.equal(connection.session?.user, "SYSTEM");
});

test("프레임 규칙을 어기면 위반 오류를 보내고 끊는다", async (t) => {
  const fixture = await setup(t);
  const socket = net.connect(fixture.port, "127.0.0.1");
  const chunks: Buffer[] = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  socket.on("error", () => undefined);
  socket.write(Buffer.from([0x7f, 0xff, 0xff, 0xff]));
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  const body = Buffer.concat(chunks);
  const message = JSON.parse(body.subarray(4, 4 + body.readUInt32BE(0)).toString("utf8")) as { sqlState: string; code: number };
  assert.equal(message.sqlState, "08P01");
  assert.equal(message.code, 8000);
});

test("같은 포트를 이미 쓰고 있으면 구동에 실패한다", async (t) => {
  const fixture = await setup(t);
  const second = new TcpServer(makeEnvironment(fixture.db), { host: "127.0.0.1", port: fixture.port });
  await assert.rejects(second.start(), (error) => error instanceof StartupError && /already in use/.test(error.message));
});

test("새 접속 받기를 멈추면 새 접속은 거부되고 기존 접속은 유지된다", async (t) => {
  const fixture = await setup(t);
  const existing = await fixture.login();
  await fixture.server.stopAccepting();
  await assert.rejects(fixture.open(), isDbError("08006"));
  assert.deepEqual(rowsOf(await existing.execute("SELECT 1")), [[1]]);
});

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------

test("TLS : ca 를 지정하면 첫 시도에 접속되고 재시도하지 않는다", async (t) => {
  const fixture = await setup(t, { tls: { cert: certA, key: keyA } });
  assert.equal(fixture.server.tlsEnabled, true);
  const retries: unknown[] = [];
  const connection = await fixture.open({ ca: certA, onCertRetry: (info) => retries.push(info) });
  await connection.login({ user: "SYSTEM", password: "HelloWorldDB" });
  assert.deepEqual(rowsOf(await connection.execute("SELECT CHANNEL FROM SYS_SESSIONS")), [["TCP"]]);
  assert.equal(retries.length, 0);
});

test("TLS : 신뢰할 수 없는 자체 서명 인증서는 3번 시도하고 08001(8007)로 실패한다", async (t) => {
  const fixture = await setup(t, { tls: { cert: certA, key: keyA } });
  let secureConnections = 0;
  fixture.server.nodeServer?.on("secureConnection", () => secureConnections++);
  const sleeps: number[] = [];
  const retries: Array<{ attempt: number; maxAttempts: number; code: unknown }> = [];
  await assert.rejects(
    fixture.open(
      { onCertRetry: (info) => retries.push({ attempt: info.attempt, maxAttempts: info.maxAttempts, code: (info.error as { code?: unknown }).code }) },
      { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } },
    ),
    (error) => {
      assert.ok(error instanceof DbError);
      assert.equal(error.sqlState, "08001");
      assert.equal(error.code, 8007);
      assert.match(error.message, /after 3 attempts/);
      assert.match(error.message, /DEPTH_ZERO_SELF_SIGNED_CERT/);
      return true;
    },
  );
  assert.deepEqual(sleeps, [100, 100], "재시도 전 100 ms 를 두 번 기다린다");
  assert.deepEqual(retries, [
    { attempt: 1, maxAttempts: 2, code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
    { attempt: 2, maxAttempts: 2, code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
  ]);
  // 서버는 핸드셰이크 실패를 3번 보았고 응용 메시지는 하나도 받지 못했다. (인증서 검증은 핸드셰이크 안에서 끝난다)
  // bun 은 서버 쪽에서 핸드셰이크 실패 이벤트(tlsClientError)를 같은 방식으로 알리지 않고 secureConnection 이 먼저 올라오므로 Node.js 에서만 본다.
  if (!isBun) {
    await waitFor(() => fixture.logger.lines.filter((line) => line.includes("TLS handshake failed")).length >= 3, 3000, "three failed handshakes");
    assert.equal(secureConnections, 0, "재시도 동안 응답 가능한 접속이 맺어진 적이 없다");
  }
  assert.equal(fixture.db.sessions.count, 0);
  assert.equal(fixture.env.limits.preAuthCount, 0, "hello 가 도착한 적이 없다");
});

test("TLS : 인증서 오류의 재시도에는 실제 대기가 있다 (기본 100 ms 두 번)", async (t) => {
  const fixture = await setup(t, { tls: { cert: certA, key: keyA } });
  const started = Date.now();
  await assert.rejects(fixture.open({}), isDbError("08001", 8007)); // ssl 옵션이 빈 객체이면 TLS 이고 모든 기본값을 쓴다
  assert.ok(Date.now() - started >= 190, `두 번의 100 ms 대기가 있어야 한다: ${Date.now() - started} ms`);
});

test("TLS : certRetries 가 0 이면 한 번만 시도한다", async (t) => {
  const fixture = await setup(t, { tls: { cert: certA, key: keyA } });
  const sleeps: number[] = [];
  await assert.rejects(
    fixture.open({ certRetries: 0 }, { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } }),
    (error) => error instanceof DbError && error.code === 8007 && /after 1 attempt:/.test(error.message),
  );
  assert.deepEqual(sleeps, []);
});

test("TLS : certRetries 와 certRetryDelayMs 를 바꿀 수 있다", async (t) => {
  const fixture = await setup(t, { tls: { cert: certA, key: keyA } });
  const sleeps: number[] = [];
  await assert.rejects(
    fixture.open({ certRetries: 4, certRetryDelayMs: 7 }, { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } }),
    (error) => error instanceof DbError && /after 5 attempts/.test(error.message),
  );
  assert.deepEqual(sleeps, [7, 7, 7, 7]);
});

test("TLS : rejectUnauthorized 를 명시적으로 false 로 하면 검증하지 않고 첫 시도에 접속된다", async (t) => {
  const fixture = await setup(t, { tls: { cert: certA, key: keyA } });
  const retries: unknown[] = [];
  const connection = await fixture.open({ rejectUnauthorized: false, onCertRetry: (info) => retries.push(info) });
  await connection.login({ user: "SYSTEM", password: "HelloWorldDB" });
  assert.equal(retries.length, 0);
});

test("TLS : 서버가 첫 연결에는 신뢰할 수 없는 인증서를, 다음부터 신뢰하는 인증서를 내면 재시도 한 번에 성공한다", async (t) => {
  // bun 의 TLS 서버는 `setSecureContext` 로 인증서를 중간에 바꾸는 것이 적용되지 않는다. 이 시험은 Node.js 에서만 한다. (제품 동작과 무관한 시험 장치의 차이)
  if (isBun) return;
  const keyB = fs.readFileSync(fixturePath("server-b.key.pem"), "utf8");
  const fixture = await setup(t, { tls: { cert: certB, key: keyB } });
  const notices: Array<{ attempt: number; maxAttempts: number }> = [];
  const connection = await fixture.open({
    ca: certA, // A 만 신뢰한다. 서버는 처음에 B 를 낸다.
    onCertRetry: (info) => {
      notices.push({ attempt: info.attempt, maxAttempts: info.maxAttempts });
      // 재시도하기 직전에 서버가 인증서를 A 로 바꾼다.
      (fixture.server.nodeServer as tls.Server).setSecureContext({ cert: certA, key: keyA });
    },
  });
  await connection.login({ user: "SYSTEM", password: "HelloWorldDB" });
  assert.deepEqual(notices, [{ attempt: 1, maxAttempts: 2 }], "재시도 한 번, 알림 한 번");
  assert.deepEqual(rowsOf(await connection.execute("SELECT 1")), [[1]]);
});

test("TLS : 재시도에서도 검증은 그대로 한다 (끄거나 느슨하게 하지 않는다)", async (t) => {
  const keyB = fs.readFileSync(fixturePath("server-b.key.pem"), "utf8");
  const fixture = await setup(t, { tls: { cert: certB, key: keyB } });
  let secureConnections = 0;
  fixture.server.nodeServer?.on("secureConnection", () => secureConnections++);
  await assert.rejects(fixture.open({ ca: certA }, { sleep: () => Promise.resolve() }), isDbError("08001", 8007));
  if (!isBun) assert.equal(secureConnections, 0, "세 번의 시도 모두에서 검증이 유지되어 접속이 맺어지지 않았다");
  assert.equal(fixture.db.sessions.count, 0, "어떤 시도에서도 hello 나 로그인이 서버에 닿지 않았다");
});

test("TLS : 호스트 이름이 맞지 않는 인증서는 인증서 오류이고 재시도 대상이다", async (t) => {
  const keyOther = fs.readFileSync(fixturePath("server-other-name.key.pem"), "utf8");
  const fixture = await setup(t, { tls: { cert: certOther, key: keyOther } });
  const sleeps: number[] = [];
  await assert.rejects(
    fixture.open({ ca: certOther }, { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } }),
    (error) => error instanceof DbError && error.code === 8007 && /ERR_TLS_CERT_ALTNAME_INVALID/.test(error.message) && /after 3 attempts/.test(error.message),
  );
  assert.deepEqual(sleeps, [100, 100]);
  // 인증서의 이름으로 servername 을 지정하면 검증을 통과한다.
  const connection = await fixture.open({ ca: certOther, servername: "other.example" });
  await connection.login({ user: "SYSTEM", password: "HelloWorldDB" });
});

test("TLS : 서버가 평문 서버이면 인증서 오류가 아니므로 재시도 없이 바로 실패한다", async (t) => {
  const fixture = await setup(t);
  const sleeps: number[] = [];
  await assert.rejects(
    fixture.open({ ca: certA }, { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } }),
    (error) => error instanceof DbError && error.sqlState === "08006" && error.code === 8006,
  );
  assert.deepEqual(sleeps, [], "재시도하지 않는다");
});

test("TLS : 포트가 닫혀 있으면 재시도 없이 바로 실패한다", async () => {
  const port = await freePort();
  const sleeps: number[] = [];
  await assert.rejects(
    Connection.open({ kind: "tcp", host: "127.0.0.1", port, ssl: { ca: certA } }, { internal: { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } } }),
    (error) => error instanceof DbError && error.sqlState === "08006",
  );
  assert.deepEqual(sleeps, []);
});

test("TLS 서버는 평문 클라이언트를 받지 않는다", async (t) => {
  const fixture = await setup(t, { tls: { cert: certA, key: keyA } });
  // 평문으로 hello 를 보내는 클라이언트는 끝내 응답을 받지 못하고 접속이 끊긴다.
  await assert.rejects(fixture.open(), isDbError("08006"));
  assert.equal(fixture.db.sessions.count, 0);
  // 평문 소켓에 쓰레기를 보내도 TLS 핸드셰이크 오류로 끊긴다.
  const raw = net.connect(fixture.port, "127.0.0.1");
  raw.on("error", () => undefined);
  raw.resume();
  raw.write("GET / HTTP/1.1\r\n\r\n");
  await new Promise<void>((resolve) => raw.once("close", () => resolve()));
});

test("TLS : 최소 버전 설정이 적용된다 (기본 TLSv1.2, TLSv1.3 으로 올리면 1.2 클라이언트는 실패)", async (t) => {
  const v12 = await setup(t, { tls: { cert: certA, key: keyA } });
  await (await v12.open({ ca: certA, minVersion: "TLSv1.2", maxVersion: "TLSv1.2" })).close();
  await (await v12.open({ ca: certA, minVersion: "TLSv1.3" })).close();

  const v13 = await setup(t, { tls: { cert: certA, key: keyA, minVersion: "TLSv1.3" } });
  const sleeps: number[] = [];
  // bun 의 TLS 클라이언트는 maxVersion 을 적용하지 않아 1.2 로 낮출 수 없다. 서버의 최소 버전 적용은 Node.js 클라이언트로 본다.
  if (!isBun) {
    await assert.rejects(
      v13.open({ ca: certA, maxVersion: "TLSv1.2" }, { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } }),
      isDbError("08006"),
    );
    assert.deepEqual(sleeps, [], "버전 불일치는 재시도하지 않는다");
  }
  await (await v13.open({ ca: certA })).close();
});

test("TLS : 구버전(TLSv1) 허용 설정은 서버 구동 로그에 경고를 남기고 그 버전의 클라이언트를 받는다", async (t) => {
  const fixture = await setup(t, { tls: { cert: certA, key: keyA, minVersion: "TLSv1" } });
  assert.ok(fixture.logger.lines.some((line) => line.startsWith("warn:") && /TLSv1/.test(line) && /insecure/.test(line)), "경고가 남아야 한다");
  // 환경(OpenSSL 빌드)이 TLS 1.0을 쓸 수 없으면 건너뛴다. 실제 자바 6 접속은 jdbc6 단계에서 확인한다.
  let connection: Connection;
  try {
    connection = await fixture.open({ ca: certA, minVersion: "TLSv1", maxVersion: "TLSv1", ciphers: "DEFAULT:@SECLEVEL=0" });
  } catch (error) {
    // bun 은 t.skip 을 구현하지 않고, 클라이언트의 최소·최대 버전과 암호 표기(@SECLEVEL)도 받지 않는다. 건너뛰는 이유만 남기고 끝낸다.
    if (!isBun) t.skip(`This Node.js/OpenSSL build cannot negotiate TLS 1.0: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  await connection.login({ user: "SYSTEM", password: "HelloWorldDB" });
  assert.deepEqual(rowsOf(await connection.execute("SELECT 1")), [[1]]);
});

test("TLS : 최소 버전이 TLSv1.2 이상이면 경고가 없다", async (t) => {
  const fixture = await setup(t, { tls: { cert: certA, key: keyA } });
  assert.equal(fixture.logger.lines.some((line) => line.startsWith("warn:")), false);
});

test("TLS : 인증서나 키 파일을 읽을 수 없으면 구동에 실패한다", async (t) => {
  const dir = tempDir(t);
  const db = Database.open(dir, { onWarning: () => {}, scramIterations: 1000 });
  t.after(() => db.close());
  const server = new TcpServer(makeEnvironment(db), {
    host: "127.0.0.1",
    port: await freePort(),
    ssl: { certPath: `${dir}/missing.cert.pem`, keyPath: `${dir}/missing.key.pem`, minVersion: "TLSv1.2" },
  });
  await assert.rejects(server.start(), (error) => error instanceof StartupError && /Cannot read the SSL certificate/.test(error.message));
  // 형식이 틀린 인증서
  fs.writeFileSync(`${dir}/bad.cert.pem`, "not a certificate");
  fs.writeFileSync(`${dir}/bad.key.pem`, "not a key");
  const bad = new TcpServer(makeEnvironment(db), {
    host: "127.0.0.1",
    port: await freePort(),
    ssl: { certPath: `${dir}/bad.cert.pem`, keyPath: `${dir}/bad.key.pem`, minVersion: "TLSv1.2" },
  });
  await assert.rejects(bad.start(), (error) => error instanceof StartupError);
});

test("TLS 위에서 대량 결과와 트랜잭션이 동작한다", async (t) => {
  const fixture = await setup(t, { tls: { cert: certA, key: keyA } });
  const connection = await fixture.login({ ca: certA });
  await connection.execute("CREATE TABLE BIG (N INTEGER)");
  for (let start = 1; start <= 1500; start += 500) {
    await connection.execute(`INSERT INTO BIG VALUES ${Array.from({ length: 500 }, (_, i) => `(${start + i})`).join(",")}`);
  }
  const all = await connection.fetchAll((await connection.execute("SELECT N FROM BIG ORDER BY N")) as RowsResult);
  assert.equal(all.rows.length, 1500);
  await connection.execute("BEGIN");
  await connection.execute("DELETE FROM BIG");
  await connection.execute("ROLLBACK");
  assert.deepEqual(rowsOf(await connection.execute("SELECT COUNT(*) FROM BIG")), [["1500"]]);
});

test("인증서 오류 코드 판정은 연결 오류와 구별한다", () => {
  for (const code of ["DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN"]) {
    assert.equal(isCertificateError(Object.assign(new Error("x"), { code })), true, code);
  }
  for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION", undefined]) {
    assert.equal(isCertificateError(Object.assign(new Error("x"), { code })), false, String(code));
  }
  assert.equal(isCertificateError(null), false);
  assert.equal(isCertificateError("x"), false);
});
