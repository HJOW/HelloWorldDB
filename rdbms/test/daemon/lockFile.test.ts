/**
 * 잠금 파일 테스트 (1단계).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  acquireLock,
  isProcessAlive,
  isRunning,
  readLockFile,
  releaseLock,
} from "../../src/daemon/lockFile.js";
import { getLockFilePath } from "../../src/common/instance.js";
import { StartupError } from "../../src/common/errors.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hwdb-lock-"));
}

test("잠금을 잡으면 PID와 포트, 제어 토큰이 기록된다", () => {
  const dataDir = path.join(makeTempDir(), "data");
  const lock = acquireLock(dataDir, 7410);
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.port, 7410);
  assert.ok(lock.controlToken.length > 0);
  assert.ok(lock.startedAt.length > 0);
  assert.equal(isRunning(dataDir), true);
  releaseLock(dataDir);
  assert.equal(isRunning(dataDir), false);
});

test("살아 있는 데몬이 있으면 중복 구동에 실패한다", () => {
  const dataDir = path.join(makeTempDir(), "data");
  acquireLock(dataDir, 7410);
  assert.throws(() => acquireLock(dataDir, 7410), StartupError);
  releaseLock(dataDir);
});

test("비정상 종료로 남은 파일은 덮어쓴다", () => {
  const dataDir = path.join(makeTempDir(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const deadPid = 2147483647;
  assert.equal(isProcessAlive(deadPid), false);
  fs.writeFileSync(
    getLockFilePath(dataDir),
    JSON.stringify({ pid: deadPid, port: 7410, startedAt: "2026-01-01T00:00:00.000Z", controlToken: "old" }),
    "utf8",
  );
  const lock = acquireLock(dataDir, 7420);
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.port, 7420);
  assert.notEqual(lock.controlToken, "old");
  releaseLock(dataDir);
});

test("깨진 잠금 파일은 구동 중이 아닌 것으로 본다", () => {
  const dataDir = path.join(makeTempDir(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(getLockFilePath(dataDir), "not json", "utf8");
  assert.equal(readLockFile(dataDir), null);
  assert.equal(isRunning(dataDir), false);
});
