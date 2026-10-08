/**
 * 데몬 본체의 구동과 종료 뼈대 테스트 (1단계).
 * 기본값과 config.json 각각으로 구동되고 정상 종료되면 잠금 파일이 남지 않는다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../../src/config/config.js";
import { createLogger } from "../../src/common/logger.js";
import { Server } from "../../src/daemon/server.js";
import { isRunning } from "../../src/daemon/lockFile.js";
import { runForeground } from "../../src/daemon/main.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hwdb-server-"));
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
  const installDir = makeTempDir();
  const { config } = loadConfig(installDir);
  assert.equal(config.configFilePath, null);

  const server = await startWithInstallDir(installDir);
  assert.equal(server.isRunning(), true);
  assert.equal(isRunning(config.dataDir), true);
  const status = server.getStatus();
  assert.equal(status.running, true);
  assert.equal(status.port, 7410);
  assert.equal(status.sessionCount, 0);

  // 정상 종료 순서의 뼈대 : 잠금 해제까지 확인한다.
  const quietLogger = createLogger({ level: "error", dir: config.log.dir, foreground: false });
  void quietLogger;
  await server.stop();
  assert.equal(server.isRunning(), false);
  assert.equal(isRunning(config.dataDir), false);
});

test("config.json 으로 구동되고 정상 종료된다", async () => {
  const installDir = makeTempDir();
  fs.writeFileSync(
    path.join(installDir, "config.json"),
    JSON.stringify({
      port: 7430,
      dataDir: "./mydata",
      tcp: { enabled: false },
      udp: { enabled: false },
      log: { level: "error", dir: "./mylogs" },
    }),
    "utf8",
  );
  const { config } = loadConfig(installDir);
  assert.equal(config.port, 7430);

  const server = await startWithInstallDir(installDir);
  const status = server.getStatus();
  assert.equal(status.port, 7430);
  assert.equal(status.tcpEnabled, false);
  assert.equal(status.udpEnabled, false);
  await server.stop();
  assert.equal(isRunning(config.dataDir), false);
});

test("이미 구동 중이면 두 번째 구동에 실패한다", async () => {
  const installDir = makeTempDir();
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
  const installDir = makeTempDir();
  t.after(() => fs.rmSync(installDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(installDir, "config.json"), JSON.stringify({ log: { level: "error" } }), "utf8");
  const { config } = loadConfig(installDir);
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  await runForeground(installDir, { ready: () => { process.emit("SIGINT"); } });
  assert.equal(isRunning(config.dataDir), false);
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
  await assert.rejects(runForeground(installDir, { ready: () => { throw new Error("Injected ready failure."); } }), /Injected ready failure/);
  assert.equal(isRunning(config.dataDir), false);
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
});
