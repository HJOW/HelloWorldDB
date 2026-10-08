/**
 * CLI 데몬 제어 테스트 (1단계). 잠금 파일 기준의 상태 조회를 본다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config/config.js";
import { createLogger } from "../../src/common/logger.js";
import { Server } from "../../src/daemon/server.js";

const HWDB = fileURLToPath(new URL("../../src/cli/main.js", import.meta.url));

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hwdb-cli-"));
}

test("hwdb status 는 구동 중이 아니면 종료 코드 1 이다", () => {
  const installDir = makeTempDir();
  const result = spawnSync(process.execPath, [HWDB, "status"], {
    encoding: "utf8",
    env: { ...process.env, HWDB_INSTALL_DIR: installDir },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /running: no/);
});

test("hwdb status 는 구동 중이면 종료 코드 0 이다", async () => {
  const installDir = makeTempDir();
  const { config } = loadConfig(installDir);
  const logger = createLogger({ level: "error", dir: config.log.dir, foreground: false });
  const server = new Server(config, logger);
  await server.start();
  try {
    const result = spawnSync(process.execPath, [HWDB, "status"], {
      encoding: "utf8",
      env: { ...process.env, HWDB_INSTALL_DIR: installDir },
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /running: yes/);
    assert.match(result.stdout, /port: 7410/);
  } finally {
    await server.stop();
    await logger.close();
  }
});
