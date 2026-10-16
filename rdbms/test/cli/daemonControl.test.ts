/**
 * CLI 데몬 제어 테스트 (1단계, 10단계에서 로컬 전용 채널 조회로 바꿈).
 * 같은 프로세스 안에서 띄운 데몬(`Server`)에 `hwdb status` 를 묻는다.
 * 데몬이 이 시험 프로세스 안에서 돌므로 `hwdb` 는 이벤트 루프를 막지 않는 비동기 `spawn` 으로 실행한다.
 * (`spawnSync` 는 데몬이 요청에 답하지 못하게 막는다)
 * 실제 프로세스로 띄우는 분리 구동·종료는 daemonLifecycle.test.ts 에 있다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config/config.js";
import { createLogger } from "../../src/common/logger.js";
import { Server } from "../../src/daemon/server.js";
import { writeFreePortConfig } from "../net/helpers.js";

const HWDB = fileURLToPath(new URL("../../src/cli/main.js", import.meta.url));

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hwdb-cli-"));
}

/** 이벤트 루프를 막지 않고 `hwdb` 를 실행한다. */
function runHwdb(args: string[], installDir: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HWDB, ...args], {
      env: { ...process.env, HWDB_INSTALL_DIR: installDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("hwdb status 는 구동 중이 아니면 종료 코드 1 이다", (t) => {
  const installDir = makeTempDir();
  t.after(() => fs.rmSync(installDir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [HWDB, "status"], {
    encoding: "utf8",
    env: { ...process.env, HWDB_INSTALL_DIR: installDir },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /running: no/);
});

test("hwdb status 는 구동 중이면 종료 코드 0 이다", async () => {
  const installDir = makeTempDir();
  const port = await writeFreePortConfig(installDir); // 시험 파일이 병렬로 돌므로 기본 포트(7410)를 쓰지 않는다.
  const { config } = loadConfig(installDir);
  const logger = createLogger({ level: "error", dir: config.log.dir, foreground: false });
  const server = new Server(config, logger);
  await server.start();
  try {
    const result = await runHwdb(["status"], installDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /running: yes/);
    assert.match(result.stdout, new RegExp(`port: ${port}`));
    assert.match(result.stdout, new RegExp(`pid: ${process.pid}\\n`));
  } finally {
    await server.stop();
    await logger.close();
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});
