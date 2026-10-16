/**
 * 서버 조립 테스트 (9단계, 9-9). 데몬 본체(`Server`)가 로컬 전용 채널, TCP(TLS), UDP 를 열고 닫는 순서,
 * 제어 요청(상태 조회, 종료), 구동 실패 때의 정리, 정상 종료 순서를 시험한다.
 * 관련 사양 : AGENTS.md 상세 6, 7, 8, 9, 12, 14-1, 15
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Connection } from "../../src/client/connection.js";
import type { RowsResult } from "../../src/client/connection.js";
import { DbError, StartupError } from "../../src/common/errors.js";
import { loadConfig } from "../../src/config/config.js";
import type { ResolvedConfig } from "../../src/config/config.js";
import { isRunning, readLockFile } from "../../src/daemon/lockFile.js";
import { runForeground } from "../../src/daemon/main.js";
import { Server } from "../../src/daemon/server.js";
import { capturingLogger, waitFor, writeFreePortConfig } from "../net/helpers.js";
import type { CapturingLogger } from "../net/helpers.js";

const certA = fileURLToPath(new URL("../../../test/fixtures/tls/server-a.cert.pem", import.meta.url));
const keyA = fileURLToPath(new URL("../../../test/fixtures/tls/server-a.key.pem", import.meta.url));

interface Started {
  server: Server;
  config: ResolvedConfig;
  installDir: string;
  port: number;
  logger: CapturingLogger;
  connections: Connection[];
  local(): Promise<Connection>;
  tcp(ssl?: { ca: string }): Promise<Connection>;
  udp(): Promise<Connection>;
  login(open: () => Promise<Connection>): Promise<Connection>;
}

async function prepare(extra: Record<string, unknown> = {}): Promise<{ installDir: string; port: number; config: ResolvedConfig }> {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "hwdb-assembly-"));
  const port = await writeFreePortConfig(installDir, { log: { level: "error" }, ...extra });
  return { installDir, port, config: loadConfig(installDir).config };
}

async function startServer(t: { after(fn: () => unknown): void }, extra: Record<string, unknown> = {}): Promise<Started> {
  const { installDir, port, config } = await prepare(extra);
  const logger = capturingLogger();
  const server = new Server(config, logger);
  await server.start();
  const connections: Connection[] = [];
  t.after(async () => {
    for (const connection of connections) connection.abort();
    await server.stop();
    fs.rmSync(installDir, { recursive: true, force: true });
  });
  const track = async (target: Parameters<typeof Connection.open>[0]): Promise<Connection> => {
    const connection = await Connection.open(target, { requestTimeoutMs: 20_000, internal: { connectTimeoutMs: 5000 } });
    connections.push(connection);
    return connection;
  };
  return {
    server,
    config,
    installDir,
    port,
    logger,
    connections,
    local: () => track({ kind: "local", port }),
    tcp: (ssl) => track({ kind: "tcp", host: "127.0.0.1", port, ...(ssl === undefined ? {} : { ssl }) }),
    udp: () => track({ kind: "udp", host: "127.0.0.1", port }),
    async login(open) {
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

// ---------------------------------------------------------------------------
// 세 접속 경로
// ---------------------------------------------------------------------------

test("구동하면 로컬 전용 채널, TCP, UDP 세 경로에서 로그인하고 질의한다", async (t) => {
  const started = await startServer(t);
  const local = await started.login(started.local);
  const tcp = await started.login(started.tcp);
  const udp = await started.login(started.udp);
  for (const connection of [local, tcp, udp]) {
    assert.deepEqual(rowsOf(await connection.execute("SELECT 'Hello World'")), [["Hello World"]]);
  }
  await local.execute("CREATE TABLE SHARED (N INTEGER)");
  await tcp.execute("INSERT INTO SHARED VALUES (1)");
  await udp.execute("INSERT INTO SHARED VALUES (2)");
  assert.deepEqual(rowsOf(await local.execute("SELECT N FROM SHARED ORDER BY N")), [[1], [2]]);
  assert.deepEqual(
    rowsOf(await local.execute("SELECT CHANNEL FROM SYS_SESSIONS ORDER BY CHANNEL")).map((row) => row[0]),
    ["LOCAL", "TCP", "UDP"],
  );
  const status = started.server.getStatus();
  assert.equal(status.sessionCount, 3);
  assert.equal(status.tcpEnabled, true);
  assert.equal(status.udpEnabled, true);
});

test("구동 로그에 열린 경로, 포트, TLS 사용 여부가 남는다", async (t) => {
  const started = await startServer(t);
  const line = started.logger.lines.find((entry) => entry.startsWith("info: Listening:"));
  assert.ok(line !== undefined);
  assert.match(line, new RegExp(`tcp=0\\.0\\.0\\.0:${started.port} \\(plain\\)`));
  assert.match(line, new RegExp(`udp=0\\.0\\.0\\.0:${started.port}`));
  assert.match(line, /local-channel=/);
  assert.match(line, /maxConnections=10/);
});

test("tcp 와 udp 를 모두 꺼도 로컬 전용 채널은 열린다", async (t) => {
  const started = await startServer(t, { tcp: { enabled: false }, udp: { enabled: false } });
  const local = await started.login(started.local);
  assert.deepEqual(rowsOf(await local.execute("SELECT 1")), [[1]]);
  await assert.rejects(Connection.open({ kind: "tcp", host: "127.0.0.1", port: started.port }, { internal: { connectTimeoutMs: 1000 } }), isDbError("08006"));
  await assert.rejects(Connection.open({ kind: "udp", host: "127.0.0.1", port: started.port }, { internal: { connectTimeoutMs: 600 } }), isDbError("08006"));
  assert.equal(started.server.getStatus().tcpEnabled, false);
  assert.equal(started.server.getStatus().udpEnabled, false);
  assert.match(started.logger.lines.find((line) => line.includes("Listening:")) as string, /^info: Listening: local-channel=\S+ maxConnections=10$/);
});

test("maxConnections 가 차도 로컬 전용 채널은 받고, TCP 와 UDP 는 거절한다", async (t) => {
  const started = await startServer(t, { maxConnections: 2 });
  await started.login(started.tcp);
  await started.login(started.udp);
  await assert.rejects(started.tcp(), isDbError("53300", 8001));
  await assert.rejects(started.udp(), isDbError("53300", 8001));
  const local = await started.login(started.local);
  const another = await started.login(started.local);
  assert.deepEqual(rowsOf(await local.execute("SELECT COUNT(*) FROM SYS_SESSIONS")), [["4"]]);
  assert.equal(another.session?.user, "SYSTEM");
});

test("CONNECT 가 없는 사용자도 로컬 전용 채널로는 항상 접속한다", async (t) => {
  const started = await startServer(t, { tcp: { enabled: false }, udp: { enabled: false }, maxConnections: 1 });
  const admin = await started.login(started.local);
  await admin.execute("CREATE USER PLAIN IDENTIFIED BY 'plain-pw'");
  const plain = await started.local();
  assert.equal((await plain.login({ user: "PLAIN", password: "plain-pw" })).user, "PLAIN");
});

test("TLS 설정이 있으면 TCP 는 TLS 로만 받는다", async (t) => {
  const started = await startServer(t, { tcp: { ssl: { certPath: certA, keyPath: keyA, minVersion: "TLSv1.2" } } });
  const tls = await started.login(() => started.tcp({ ca: fs.readFileSync(certA, "utf8") }));
  assert.deepEqual(rowsOf(await tls.execute("SELECT 1")), [[1]]);
  await assert.rejects(started.tcp(), isDbError("08006"), "평문 접속은 받지 않는다");
  const line = started.logger.lines.find((entry) => entry.includes("Listening:")) as string;
  assert.match(line, /\(TLS, minimum TLSv1\.2\)/);
  // UDP 와 로컬 전용 채널은 TLS 와 무관하다.
  assert.equal((await started.login(started.udp)).session?.user, "SYSTEM");
  assert.equal((await started.login(started.local)).session?.user, "SYSTEM");
});

test("구버전 TLS 를 허용하는 설정은 구동 로그에 경고를 남긴다", async (t) => {
  const started = await startServer(t, { tcp: { ssl: { certPath: certA, keyPath: keyA, minVersion: "TLSv1" } } });
  assert.ok(started.logger.lines.some((line) => line.startsWith("warn:") && /TLSv1/.test(line) && /insecure/.test(line)));
  assert.match(started.logger.lines.find((entry) => entry.includes("Listening:")) as string, /legacy versions allowed/);
});

// ---------------------------------------------------------------------------
// 제어 요청
// ---------------------------------------------------------------------------

test("제어 요청 status 는 잠금 파일의 토큰으로 받고 현재 상태를 돌려준다", async (t) => {
  const started = await startServer(t);
  const token = readLockFile(started.config.dataDir)?.controlToken as string;
  assert.ok(token.length >= 16);
  await started.login(started.tcp);
  const control = await started.local();
  const status = await control.control("status", token);
  assert.equal(status.running, true);
  assert.equal(status.port, started.port);
  assert.equal(status.pid, process.pid);
  assert.equal(status.version, "0.1.0");
  assert.equal(status.dataDir, started.config.dataDir);
  assert.equal(status.tcpEnabled, true);
  assert.equal(status.udpEnabled, true);
  assert.equal(status.sessionCount, 1);
  assert.equal(typeof status.startedAt, "string");
});

test("제어 요청은 토큰이 틀리면 거부하고, TCP 와 UDP 로는 받지 않는다", async (t) => {
  const started = await startServer(t);
  const token = readLockFile(started.config.dataDir)?.controlToken as string;
  const wrong = await started.local();
  await assert.rejects(wrong.control("stop", "not-the-token"), isDbError("28000", 7000));
  for (const open of [started.tcp, started.udp]) {
    const connection = await open();
    await assert.rejects(connection.control("status", token), isDbError("42501", 7001));
  }
  // 토큰이 틀려도 틀린 요청 때문에 서버가 멈추지 않는다.
  let stopped = false;
  void started.server.stopRequested.then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stopped, false);
  assert.ok(started.logger.lines.every((line) => !line.includes(token)), "로그에 제어 토큰이 없다");
});

test("제어 요청 stop 은 응답을 보낸 뒤 stopRequested 를 알린다", async (t) => {
  const started = await startServer(t);
  const token = readLockFile(started.config.dataDir)?.controlToken as string;
  const control = await started.local();
  await control.control("stop", token);
  await started.server.stopRequested;
  assert.equal(started.server.isRunning(), true, "종료 절차는 데몬 본체가 시작한다");
  await started.server.stop();
  assert.equal(started.server.isRunning(), false);
  assert.equal(isRunning(started.config.dataDir), false);
});

test("runForeground 는 로컬 전용 채널의 종료 요청으로 정상 종료한다 (신호 없이)", async (t) => {
  const { installDir, port, config } = await prepare();
  t.after(() => fs.rmSync(installDir, { recursive: true, force: true }));
  let requested = false;
  await runForeground(installDir, {
    ready: () => {
      void (async () => {
        const token = readLockFile(config.dataDir)?.controlToken as string;
        const connection = await Connection.open({ kind: "local", port });
        await connection.control("stop", token);
        requested = true;
      })();
    },
  });
  assert.equal(requested, true);
  assert.equal(isRunning(config.dataDir), false);
  await assert.rejects(Connection.open({ kind: "local", port }, { internal: { connectTimeoutMs: 500 } }), isDbError("08006"));
});

// ---------------------------------------------------------------------------
// 정상 종료 순서
// ---------------------------------------------------------------------------

test("정상 종료는 모든 경로의 접속에 57P01 을 알리고 커밋하지 않은 변경을 롤백한다", async (t) => {
  const started = await startServer(t);
  const local = await started.login(started.local);
  const tcp = await started.login(started.tcp);
  const udp = await started.login(started.udp);
  await local.execute("CREATE TABLE KEPT (ID INTEGER PRIMARY KEY)");
  await local.execute("INSERT INTO KEPT VALUES (1)");
  for (const [index, connection] of [local, tcp, udp].entries()) {
    await connection.execute("BEGIN");
    await connection.execute("INSERT INTO KEPT VALUES (?)", [100 + index]);
  }
  await started.server.stop();
  for (const connection of [local, tcp, udp]) {
    await waitFor(() => connection.isClosed, 5000, "the connection to be closed by the server");
    await assert.rejects(connection.execute("SELECT 1"), isDbError("57P01", 6003));
  }
  assert.equal(isRunning(started.config.dataDir), false);

  // 다시 구동하면 커밋한 행만 남아 있다. (정상 종료로 데이터 파일에 반영되었다)
  const restarted = new Server(started.config, capturingLogger());
  await restarted.start();
  try {
    const connection = await Connection.open({ kind: "local", port: started.port });
    await connection.login({ user: "SYSTEM", password: "HelloWorldDB" });
    assert.deepEqual(rowsOf(await connection.execute("SELECT ID FROM KEPT ORDER BY ID")), [[1]]);
    await connection.close();
  } finally {
    await restarted.stop();
  }
});

test("종료한 뒤에는 어느 경로로도 접속되지 않는다", async (t) => {
  const started = await startServer(t);
  await started.server.stop();
  await assert.rejects(Connection.open({ kind: "local", port: started.port }, { internal: { connectTimeoutMs: 500 } }), isDbError("08006"));
  await assert.rejects(Connection.open({ kind: "tcp", host: "127.0.0.1", port: started.port }, { internal: { connectTimeoutMs: 500 } }), isDbError("08006"));
  await assert.rejects(Connection.open({ kind: "udp", host: "127.0.0.1", port: started.port }, { internal: { connectTimeoutMs: 500 } }), isDbError("08006"));
});

test("종료 절차는 한 번만 실행한다 (여러 번 불러도, 동시에 불러도)", async (t) => {
  const started = await startServer(t);
  await started.login(started.local);
  await Promise.all([started.server.stop(), started.server.stop(), started.server.stop()]);
  await started.server.stop();
  assert.equal(started.logger.lines.filter((line) => line.includes("Shutting down the server")).length, 1);
  assert.equal(started.logger.lines.filter((line) => line.includes("Server stopped")).length, 1);
  assert.equal(started.server.isRunning(), false);
});

test("종료 요청과 종료 신호가 겹쳐도 한 번만 종료한다", async (t) => {
  const started = await startServer(t);
  started.server.requestStop();
  started.server.requestStop();
  await Promise.all([started.server.stop(), started.server.stop()]);
  assert.equal(started.logger.lines.filter((line) => line.includes("Shutting down the server")).length, 1);
});

// ---------------------------------------------------------------------------
// 구동 실패
// ---------------------------------------------------------------------------

test("TCP 포트가 사용 중이면 구동에 실패하고 연 것을 모두 닫고 잠금 파일도 지운다", async (t) => {
  const { installDir, port, config } = await prepare({ udp: { enabled: false } });
  t.after(() => fs.rmSync(installDir, { recursive: true, force: true }));
  const occupant = net.createServer();
  await new Promise<void>((resolve) => occupant.listen(port, "0.0.0.0", () => resolve()));
  t.after(() => occupant.close());
  const server = new Server(config, capturingLogger());
  await assert.rejects(server.start(), (error) => error instanceof StartupError && /TCP port/.test(error.message));
  assert.equal(server.isRunning(), false);
  assert.equal(server.getDatabase(), undefined);
  assert.equal(isRunning(config.dataDir), false, "잠금 파일이 남지 않았다");
  // 이미 열었던 로컬 전용 채널도 닫혔다.
  await assert.rejects(Connection.open({ kind: "local", port }, { internal: { connectTimeoutMs: 500 } }), isDbError("08006"));
  // 포트를 비우면 다시 구동된다.
  await new Promise<void>((resolve) => occupant.close(() => resolve()));
  const again = new Server(config, capturingLogger());
  await again.start();
  await again.stop();
});

test("UDP 포트가 사용 중이면 구동에 실패한다", async (t) => {
  const { installDir, port, config } = await prepare({ tcp: { enabled: false } });
  t.after(() => fs.rmSync(installDir, { recursive: true, force: true }));
  const dgram = await import("node:dgram");
  const occupant = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => occupant.bind(port, "0.0.0.0", () => resolve()));
  t.after(() => occupant.close());
  const server = new Server(config, capturingLogger());
  await assert.rejects(server.start(), (error) => error instanceof StartupError && /UDP port/.test(error.message));
  assert.equal(isRunning(config.dataDir), false);
});

test("같은 포트 번호의 두 번째 인스턴스는 로컬 전용 채널에서 구동에 실패하고 첫 인스턴스는 영향이 없다", async (t) => {
  const first = await startServer(t, { tcp: { enabled: false }, udp: { enabled: false } });
  const secondInstall = fs.mkdtempSync(path.join(os.tmpdir(), "hwdb-assembly2-"));
  t.after(() => fs.rmSync(secondInstall, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(secondInstall, "config.json"),
    JSON.stringify({ port: first.port, tcp: { enabled: false }, udp: { enabled: false }, log: { level: "error" } }),
    "utf8",
  );
  const secondConfig = loadConfig(secondInstall).config;
  assert.notEqual(secondConfig.dataDir, first.config.dataDir, "데이터 디렉토리는 따로이다");
  const second = new Server(secondConfig, capturingLogger());
  await assert.rejects(second.start(), (error) => {
    assert.ok(error instanceof StartupError);
    assert.match(error.message, /port number/);
    return true;
  });
  assert.equal(isRunning(secondConfig.dataDir), false);
  const connection = await first.login(first.local);
  assert.deepEqual(rowsOf(await connection.execute("SELECT 1")), [[1]]);
});

test("포트 번호가 다른 두 인스턴스는 한 장비에서 함께 구동된다", async (t) => {
  const a = await startServer(t);
  const b = await startServer(t);
  assert.notEqual(a.port, b.port);
  for (const started of [a, b]) {
    for (const open of [started.local, started.tcp, started.udp]) {
      const connection = await started.login(open);
      assert.deepEqual(rowsOf(await connection.execute("SELECT 1")), [[1]]);
    }
  }
  const a1 = await a.login(a.local);
  const b1 = await b.login(b.local);
  await a1.execute("CREATE TABLE ONLY_A (X INTEGER)");
  await assert.rejects(b1.execute("SELECT * FROM ONLY_A"), isDbError("42P01"), "데이터는 인스턴스마다 독립이다");
});

test("접속한 사용자가 SYSTEM 의 초기 암호를 바꾸면 이후 접속은 새 암호로만 된다", async (t) => {
  const started = await startServer(t);
  const admin = await started.login(started.local);
  await admin.execute("ALTER USER SYSTEM IDENTIFIED BY 'new-password-1'");
  const old = await started.local();
  await assert.rejects(old.login({ user: "SYSTEM", password: "HelloWorldDB" }), isDbError("28000", 7000));
  const fresh = await started.local();
  assert.equal((await fresh.login({ user: "SYSTEM", password: "new-password-1" })).user, "SYSTEM");
  // 같은 계정이 다른 경로에서도 새 암호로만 된다.
  const tcp = await started.tcp();
  await assert.rejects(tcp.login({ user: "SYSTEM", password: "HelloWorldDB" }), isDbError("28000", 7000));
});
