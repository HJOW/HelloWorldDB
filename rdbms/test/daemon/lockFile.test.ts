/**
 * 잠금 파일 테스트 (1단계).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";
import {
  GATE_STALE_MS,
  acquireLock,
  isProcessAlive,
  isRunning,
  readLockFile,
  releaseLock,
} from "../../src/daemon/lockFile.js";
import { getLockFilePath } from "../../src/common/instance.js";
import { StartupError } from "../../src/common/errors.js";
import { createTempDir } from "../tempDirs.js";

function makeTempDir(): string {
  return createTempDir("hwdb-lock-");
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

test("방금 만든 잠금 생성 가드가 있으면 다른 프로세스가 구동 중이므로 실패하고 가드를 건드리지 않는다", () => {
  const dataDir = path.join(makeTempDir(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const gate = `${getLockFilePath(dataDir)}.acquire`;
  fs.mkdirSync(gate);
  assert.throws(() => acquireLock(dataDir, 7410), /another process is starting/);
  assert.equal(fs.existsSync(gate), true);
  assert.equal(readLockFile(dataDir), null);
});

test("강제 종료로 남은 오래된 잠금 생성 가드는 치우고 구동한다", () => {
  const dataDir = path.join(makeTempDir(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const gate = `${getLockFilePath(dataDir)}.acquire`;
  fs.mkdirSync(gate);
  const old = new Date(Date.now() - GATE_STALE_MS - 5000);
  fs.utimesSync(gate, old, old);
  const lock = acquireLock(dataDir, 7410);
  assert.equal(lock.pid, process.pid);
  assert.equal(fs.existsSync(gate), false, "가드는 구동 뒤에 남지 않는다");
  releaseLock(dataDir);
});

test("오래된 가드가 있어도 살아 있는 데몬이 있으면 중복 구동은 막는다", () => {
  const dataDir = path.join(makeTempDir(), "data");
  acquireLock(dataDir, 7410);
  const gate = `${getLockFilePath(dataDir)}.acquire`;
  fs.mkdirSync(gate);
  const old = new Date(Date.now() - GATE_STALE_MS - 5000);
  fs.utimesSync(gate, old, old);
  assert.throws(() => acquireLock(dataDir, 7410), /already in use/);
  assert.equal(fs.existsSync(gate), false, "실패해도 가드는 치워 둔다");
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
