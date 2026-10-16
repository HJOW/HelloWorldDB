/**
 * `hwdb start --foreground` 프로세스 시험 (9단계). 실제 프로세스를 띄워 세 접속 경로로 접속하고,
 * 로컬 전용 채널의 종료 요청(`control stop`)으로 프로세스가 정상 종료(종료 코드 0)하는지 본다.
 * Windows 에서는 다른 프로세스가 보낸 SIGTERM 을 받을 수 없으므로 이 요청이 종료의 기본 경로이다.
 * 관련 사양 : AGENTS.md 상세 12, 14-1
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Connection } from "../../src/client/connection.js";
import { loadConfig } from "../../src/config/config.js";
import { isRunning, readLockFile } from "../../src/daemon/lockFile.js";
import { waitFor, writeFreePortConfig } from "../net/helpers.js";

const HWDB = fileURLToPath(new URL("../../src/cli/main.js", import.meta.url));

test("hwdb start --foreground 는 세 경로로 접속을 받고 종료 요청으로 정상 종료한다", async (t) => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "hwdb-fg-"));
  t.after(() => fs.rmSync(installDir, { recursive: true, force: true }));
  const port = await writeFreePortConfig(installDir, { log: { level: "info" } });
  const { config } = loadConfig(installDir);

  const child = spawn(process.execPath, [HWDB, "start", "--foreground"], {
    env: { ...process.env, HWDB_INSTALL_DIR: installDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

  await waitFor(() => output.includes("Listening:"), 20_000, `the daemon to start (output so far: ${output})`);
  assert.match(output, /Server started\. port=/);
  assert.match(output, new RegExp(`udp=0\\.0\\.0\\.0:${port}`));
  assert.match(output, /initial password/, "초기 암호 경고가 구동 로그에 있다");

  // 세 경로로 로그인하고 질의한다.
  const targets = [
    { kind: "local", port },
    { kind: "tcp", host: "127.0.0.1", port },
    { kind: "udp", host: "127.0.0.1", port },
  ] as const;
  for (const target of targets) {
    const connection = await Connection.open(target, { internal: { connectTimeoutMs: 5000 } });
    await connection.login({ user: "SYSTEM", password: "HelloWorldDB" });
    const result = await connection.execute("SELECT 'Hello World'");
    assert.equal(result.kind === "rows" ? result.rows[0]?.[0] : null, "Hello World", target.kind);
    await connection.close();
  }

  // 로컬 전용 채널로 상태를 묻고 종료를 요청한다. 제어 토큰은 잠금 파일에 있다.
  const lock = readLockFile(config.dataDir);
  assert.ok(lock !== null);
  assert.equal(lock.pid, child.pid);
  const control = await Connection.open({ kind: "local", port });
  const status = await control.control("status", lock.controlToken);
  assert.equal(status.running, true);
  assert.equal(status.pid, child.pid);
  assert.equal(status.port, port);
  await control.close().catch(() => undefined);

  const stopper = await Connection.open({ kind: "local", port });
  await stopper.control("stop", lock.controlToken);
  const code = await Promise.race([exited, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 20_000))]);
  assert.equal(code, 0, `프로세스가 정상 종료해야 한다 (output: ${output})`);
  assert.equal(isRunning(config.dataDir), false, "잠금 파일이 남지 않았다");
  assert.match(output, /Shutting down the server/);
  assert.match(output, /Server stopped/);
});
