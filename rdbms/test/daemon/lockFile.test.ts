/**
 * 잠금 파일 테스트 (1단계).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";
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

test("자신의 제어 토큰과 다른 잠금은 종료 때 지우지 않는다", (t) => {
  const dataDir = makeTempDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const owner = acquireLock(dataDir, 7410);
  releaseLock(dataDir, { ...owner, controlToken: "another-owner" });
  assert.equal(readLockFile(dataDir)?.controlToken, owner.controlToken);
  releaseLock(dataDir, owner);
  assert.equal(readLockFile(dataDir), null);
});

test("8개 프로세스의 동시 구동에서 데이터 디렉토리는 하나만 점유된다", async (t) => {
  const dataDir = makeTempDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const moduleUrl = new URL("../../src/daemon/lockFile.js", import.meta.url).href;
  const script = `
    import { acquireLock } from ${JSON.stringify(moduleUrl)};
    process.stdin.once('data', () => {
      try { acquireLock(process.argv[1], 7410); process.stdout.write('owned'); }
      catch { process.stdout.write('rejected'); }
    });
    setInterval(() => {}, 1000);
    process.stdout.write('ready');
  `;
  const children = Array.from({ length: 8 }, () => spawn(process.execPath, ["--input-type=module", "-e", script, dataDir], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  }));
  const results: string[] = [];
  try {
    await Promise.all(children.map((child) => new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolve());
    })));
    await Promise.all(children.map((child) => new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", (data: Buffer) => { results.push(data.toString()); resolve(); });
      child.stdin.write("start");
    })));
    assert.equal(results.filter((result) => result === "owned").length, 1);
    assert.equal(results.filter((result) => result === "rejected").length, 7);
  } finally {
    await Promise.all(children.map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      child.once("exit", () => resolve()); child.kill();
    })));
  }
});
