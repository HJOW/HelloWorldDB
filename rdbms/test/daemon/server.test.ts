/**
 * 데몬 본체의 구동과 종료 뼈대 테스트 (1단계).
 * 기본값과 config.json 각각으로 구동되고 정상 종료되면 잠금 파일이 남지 않는다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../../src/config/config.js";
import { createLogger } from "../../src/common/logger.js";
import { Server } from "../../src/daemon/server.js";
import { isRunning } from "../../src/daemon/lockFile.js";
import { runForeground } from "../../src/daemon/main.js";
import { writeFreePortConfig } from "../net/helpers.js";
import { createTempDir } from "../tempDirs.js";

function makeTempDir(): string {
  return createTempDir("hwdb-server-");
}

/** 사용하지 않는 포트로 구동하도록 config.json 을 쓴 설치 디렉토리를 만든다. (시험 파일이 병렬로 돌므로 기본 포트를 쓰지 않는다) */
async function makeInstallDir(extra: Record<string, unknown> = {}): Promise<{ installDir: string; port: number }> {
  const installDir = makeTempDir();
  const port = await writeFreePortConfig(installDir, extra);
  return { installDir, port };
}

async function startWithInstallDir(installDir: string): Promise<Server> {
  const { config } = loadConfig(installDir);
  const logger = createLogger({ level: "error", dir: config.log.dir, foreground: false });
  const server = new Server(config, logger);
  await server.start();
  await logger.close();
  return server;
}

test("기본값으로 구동되고 정상 종료된다", async () => {
  // config.json 이 없으면 전부 기본값이다. (기본 포트 7410 은 병렬 시험과 겹치지 않도록 구동하지 않고 값만 확인한다)
  const defaults = loadConfig(makeTempDir()).config;
  assert.equal(defaults.configFilePath, null);
  assert.equal(defaults.port, 7410);
  assert.equal(defaults.tcp.enabled, true);
  assert.equal(defaults.udp.enabled, true);

  // 포트만 정한 config.json 으로 구동하면 나머지는 기본값이다.
  const { installDir, port } = await makeInstallDir();
  const { config } = loadConfig(installDir);
  assert.equal(config.port, port);

  const server = await startWithInstallDir(installDir);
  assert.equal(server.isRunning(), true);
  assert.equal(isRunning(config.dataDir), true);
  const status = server.getStatus();
  assert.equal(status.running, true);
  assert.equal(status.port, port);
  assert.equal(status.tcpEnabled, true);
  assert.equal(status.udpEnabled, true);
  assert.equal(status.sessionCount, 0);

  // 정상 종료 순서의 뼈대 : 잠금 해제까지 확인한다.
  const quietLogger = createLogger({ level: "error", dir: config.log.dir, foreground: false });
  void quietLogger;
  await server.stop();
  assert.equal(server.isRunning(), false);
  assert.equal(isRunning(config.dataDir), false);
});

test("config.json 으로 구동되고 정상 종료된다", async () => {
  const { installDir, port } = await makeInstallDir({
    dataDir: "./mydata",
    tcp: { enabled: false },
    udp: { enabled: false },
    log: { level: "error", dir: "./mylogs" },
  });
  const { config } = loadConfig(installDir);
  assert.equal(config.port, port);

  const server = await startWithInstallDir(installDir);
  const status = server.getStatus();
  assert.equal(status.port, port);
  assert.equal(status.tcpEnabled, false);
  assert.equal(status.udpEnabled, false);
  await server.stop();
  assert.equal(isRunning(config.dataDir), false);
});

test("정상 종료는 진행 중인 트랜잭션을 롤백하고 세션을 모두 끝낸다 (7단계)", async (t) => {
  const { installDir } = await makeInstallDir();
  t.after(() => fs.rmSync(installDir, { recursive: true, force: true }));
  const server = await startWithInstallDir(installDir);
  const { config } = loadConfig(installDir);
  const database = server.getDatabase();
  assert.ok(database !== undefined);
  const session = (database as NonNullable<typeof database>).createSession({});
  session.execute("CREATE TABLE KEPT (ID INTEGER PRIMARY KEY)");
  session.execute("INSERT INTO KEPT VALUES (1)");
  session.execute("BEGIN");
  session.execute("INSERT INTO KEPT VALUES (2)");
  assert.equal(server.getStatus().sessionCount, 1);
  await server.stop();
  assert.equal(session.isClosed, true);
  assert.equal(server.getDatabase(), undefined);
  assert.equal(server.getStatus().sessionCount, 0);

  // 다시 구동하면 커밋한 행만 남아 있다.
  const restarted = await startWithInstallDir(installDir);
  try {
    const check = (restarted.getDatabase() as NonNullable<ReturnType<Server["getDatabase"]>>).createSession({});
    const result = check.execute("SELECT ID FROM KEPT ORDER BY ID");
    assert.deepEqual(result.kind === "select" ? result.rows.map((row) => String(row[0])) : [], ["1"]);
  } finally {
    await restarted.stop();
  }
  assert.equal(isRunning(config.dataDir), false);
});

test("이미 구동 중이면 두 번째 구동에 실패한다", async () => {
  const { installDir } = await makeInstallDir();
  const first = await startWithInstallDir(installDir);
  const { config } = loadConfig(installDir);
  const logger = createLogger({ level: "error", dir: config.log.dir, foreground: false });
  const second = new Server(config, logger);
  await assert.rejects(async () => {
    await second.start();
  });
  await logger.close();
  await first.stop();
});

test("포그라운드 구동의 종료와 구동 완료 콜백 실패는 자원을 정리한다", async (t) => {
  const { installDir } = await makeInstallDir({ log: { level: "error" } });
  t.after(() => fs.rmSync(installDir, { recursive: true, force: true }));
  const { config } = loadConfig(installDir);
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  await runForeground(installDir, { ready: () => { process.emit("SIGINT"); } });
  assert.equal(isRunning(config.dataDir), false);
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
  await assert.rejects(runForeground(installDir, { ready: () => { throw new Error("Injected ready failure."); } }), /Injected ready failure/);
  assert.equal(isRunning(config.dataDir), false);
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
});

test("SYSTEM 계정이 초기 암호 그대로이면 구동 로그에 경고하고, 바꾼 뒤에는 경고하지 않는다 (8단계)", async (t) => {
  const { installDir } = await makeInstallDir();
  t.after(() => fs.rmSync(installDir, { recursive: true, force: true }));
  const { config } = loadConfig(installDir);
  const startWithWarnings = async (): Promise<{ server: Server; warnings: string[] }> => {
    const warnings: string[] = [];
    const logger = {
      error: () => {},
      warn: (message: string) => { warnings.push(message); },
      info: () => {},
      debug: () => {},
      close: async () => {},
    };
    const server = new Server(config, logger);
    await server.start();
    return { server, warnings };
  };

  const first = await startWithWarnings();
  assert.equal(first.warnings.some((message) => message.includes("initial password")), true);
  (first.server.getDatabase() as NonNullable<ReturnType<Server["getDatabase"]>>)
    .createSession({})
    .execute("ALTER USER SYSTEM IDENTIFIED BY 'changed-password'");
  await first.server.stop();

  const second = await startWithWarnings();
  assert.equal(second.warnings.some((message) => message.includes("initial password")), false);
  await second.server.stop();
});
