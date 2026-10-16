/**
 * 데몬 제어 시험 (10단계). 실제 `hwdb` 프로세스를 띄워 분리 구동(start), 상태 조회(status), 종료(stop)와 SQL 접속을 본다.
 *  - `hwdb start` 가 데몬을 띄우고 바로 돌아오며, 부모가 끝난 뒤에도 데몬이 남는다.
 *  - 이미 구동 중이거나 구동 중이 아닐 때의 처리, 구동 실패의 원인 표시, 남은 잠금 파일(죽은 PID, 살아 있지만 답이 없는 PID)의 처리
 *  - 설치 직후 `hwdb` 로 SYSTEM 에 로그인해 초기 암호를 바꾸는 절차, TCP 와 UDP 를 모두 껐거나 `maxConnections` 가 찬 상태의 로컬 접속
 * 터미널을 닫아도 데몬이 남는지, 콘솔 창이 뜨지 않는지는 자동으로 확인할 수 없어 PROGRESS.md 의 수동 확인 기록을 따른다.
 * 관련 사양 : AGENTS.md 상세 12, 14, 15
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Connection } from "../../src/client/connection.js";
import { LOCK_FILE_NAME } from "../../src/common/instance.js";
import { loadConfig } from "../../src/config/config.js";
import { isProcessAlive, readLockFile } from "../../src/daemon/lockFile.js";
import { freePort, waitFor, writeFreePortConfig } from "../net/helpers.js";

const HWDB = fileURLToPath(new URL("../../src/cli/main.js", import.meta.url));

interface Installation {
  installDir: string;
  port: number;
  dataDir: string;
  logPath: string;
  /** `hwdb` 를 실행한다. */
  hwdb(args: string[], options?: { input?: string }): { status: number | null; stdout: string; stderr: string };
}

/** 설치 디렉토리를 만들고 시험이 끝나면 데몬을 정리한다. 데몬이 남았으면 stop 으로, 그래도 남으면 강제로 끝낸다. */
async function install(t: { after(fn: () => void): void }, config: Record<string, unknown> = {}): Promise<Installation> {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "hwdb-life-"));
  const port = await writeFreePortConfig(installDir, config);
  const { config: loaded } = loadConfig(installDir);
  const hwdb: Installation["hwdb"] = (args, options = {}) => {
    const result = spawnSync(process.execPath, [HWDB, ...args], {
      encoding: "utf8",
      env: { ...process.env, HWDB_INSTALL_DIR: installDir },
      timeout: 60_000,
      ...(options.input === undefined ? { stdio: ["ignore", "pipe", "pipe"] } : { input: options.input }),
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  t.after(() => {
    const lock = readLockFile(loaded.dataDir);
    // 일부 시험은 이 시험 프로세스의 PID 를 잠금 파일에 적어 둔다. 그 프로세스를 끝내면 안 된다.
    if (lock !== null && lock.pid !== process.pid && isProcessAlive(lock.pid)) {
      hwdb(["stop", "--timeout", "20"]);
      if (isProcessAlive(lock.pid)) {
        try {
          process.kill(lock.pid);
        } catch {
          // 이미 끝났다.
        }
      }
    }
    fs.rmSync(installDir, { recursive: true, force: true });
  });
  return { installDir, port, dataDir: loaded.dataDir, logPath: path.join(loaded.log.dir, "helloworlddb.log"), hwdb };
}

async function pidGone(pid: number): Promise<void> {
  await waitFor(() => !isProcessAlive(pid), 20_000, `process ${pid} to exit`);
}

test("hwdb start 는 데몬을 띄우고 바로 돌아오며, 데몬은 부모가 끝난 뒤에도 남는다", async (t) => {
  const box = await install(t);
  const started = Date.now();
  const start = box.hwdb(["start"]);
  const elapsed = Date.now() - started;
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, new RegExp(`^HelloWorldDB started\\. port: ${box.port}, pid: \\d+\\n$`));
  assert.ok(elapsed < 20_000, `start 가 너무 오래 걸렸다 : ${elapsed} ms`);

  const pid = Number(/pid: (\d+)/.exec(start.stdout)?.[1]);
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.notEqual(pid, process.pid);
  // `hwdb start` 프로세스는 이미 끝났다. 데몬은 남아 있고, 잠금 파일이 그 프로세스를 가리킨다.
  assert.equal(isProcessAlive(pid), true);
  const lock = readLockFile(box.dataDir);
  assert.equal(lock?.pid, pid);
  assert.equal(lock?.port, box.port);
  // 초기 암호 경고를 구동 결과와 함께 보여 준다.
  assert.match(start.stderr, /initial password/);
  // 데몬의 출력은 로그 파일에 남는다.
  const log = fs.readFileSync(box.logPath, "utf8");
  assert.match(log, /Server started\. port=/);
  assert.match(log, /Listening: /);
});

test("hwdb status 는 구동 중이면 종료 코드 0 과 데몬의 값을, 아니면 1 을 낸다", async (t) => {
  const box = await install(t);
  const before = box.hwdb(["status"]);
  assert.equal(before.status, 1);
  assert.match(before.stdout, /^running: no\n/);
  assert.match(before.stdout, new RegExp(`port: ${box.port}\\n`));
  assert.doesNotMatch(before.stdout, /pid:/);

  const start = box.hwdb(["start"]);
  assert.equal(start.status, 0, start.stderr);
  const pid = readLockFile(box.dataDir)?.pid;

  const status = box.hwdb(["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /^running: yes\n/);
  assert.match(status.stdout, new RegExp(`pid: ${pid}\\n`));
  assert.match(status.stdout, new RegExp(`port: ${box.port}\\n`));
  assert.match(status.stdout, /startedAt: \d{4}-\d\d-\d\dT/);
  assert.match(status.stdout, /version: \d+\.\d+\.\d+\n/);
  assert.match(status.stdout, /dataDir: .*data\n/);
  assert.match(status.stdout, /tcp: on\n/);
  assert.match(status.stdout, /udp: on\n/);
  assert.match(status.stdout, /sessions: 0\n/);
  assert.match(status.stderr, /initial password/);
});

test("status 의 세션 수는 접속 중인 세션을 센다", async (t) => {
  const box = await install(t);
  assert.equal(box.hwdb(["start"]).status, 0);
  const connection = await Connection.open({ kind: "local", port: box.port });
  t.after(() => connection.abort());
  await connection.login({ user: "SYSTEM", password: "HelloWorldDB" });
  assert.match(box.hwdb(["status"]).stdout, /sessions: 1\n/);
});

test("접속한 클라이언트가 소켓을 읽지 않아도 stop 은 유예 시간 뒤 끝나고 프로세스가 남지 않는다", async (t) => {
  // spawnSync 가 이 시험 프로세스의 이벤트 루프를 막으므로, 접속을 잡고 있는 클라이언트가 서버의 종료 오류를 읽지도 소켓을 닫지도 못한다.
  // Windows 의 네임드 파이프는 상대가 읽을 때까지 서버 쪽 닫기가 끝나지 않아, 데몬이 직접 프로세스를 끝내지 않으면 영원히 남는다.
  for (const kind of ["local", "tcp", "udp"] as const) {
    const box = await install(t);
    assert.equal(box.hwdb(["start"]).status, 0);
    const pid = readLockFile(box.dataDir)?.pid as number;
    const target = kind === "local" ? ({ kind, port: box.port } as const) : ({ kind, host: "127.0.0.1", port: box.port } as const);
    const connection = await Connection.open(target);
    t.after(() => connection.abort());
    await connection.login({ user: "SYSTEM", password: "HelloWorldDB" });
    const started = Date.now();
    const stop = box.hwdb(["stop", "--timeout", "30"]);
    assert.equal(stop.status, 0, `${kind}: ${stop.stderr}`);
    assert.ok(Date.now() - started < 15_000, `${kind}: stop 이 너무 오래 걸렸다 (${Date.now() - started} ms)`);
    assert.equal(isProcessAlive(pid), false, kind);
    assert.equal(readLockFile(box.dataDir), null, kind);
  }
});

test("이미 구동 중이면 그 사실만 알리고 종료 코드 0 으로 끝난다", async (t) => {
  const box = await install(t);
  const first = box.hwdb(["start"]);
  assert.equal(first.status, 0, first.stderr);
  const pid = readLockFile(box.dataDir)?.pid;
  const second = box.hwdb(["start"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, new RegExp(`^HelloWorldDB is already running\\. port: ${box.port}, pid: ${pid}\\n$`));
  assert.equal(readLockFile(box.dataDir)?.pid, pid, "데몬을 다시 띄우지 않았다");
});

test("hwdb stop 은 정상 종료가 끝나 프로세스가 사라질 때까지 기다린다", async (t) => {
  const box = await install(t);
  assert.equal(box.hwdb(["start"]).status, 0);
  const pid = readLockFile(box.dataDir)?.pid as number;
  const stop = box.hwdb(["stop"]);
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(stop.stdout, "HelloWorldDB stopped.\n");
  // stop 이 돌아온 시점에 프로세스는 이미 사라졌다. 잠금 파일도 없다.
  assert.equal(isProcessAlive(pid), false);
  assert.equal(fs.existsSync(path.join(box.dataDir, LOCK_FILE_NAME)), false);
  assert.match(fs.readFileSync(box.logPath, "utf8"), /Server stopped\./);
  assert.equal(box.hwdb(["status"]).status, 1);
});

test("구동 중이 아니면 stop 은 그 사실만 알리고 종료 코드 0 으로 끝난다", async (t) => {
  const box = await install(t);
  const stop = box.hwdb(["stop"]);
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(stop.stdout, "HelloWorldDB is not running.\n");
  assert.equal(stop.stderr, "");
});

test("종료 뒤 다시 구동할 수 있고 데이터가 남아 있다", async (t) => {
  const box = await install(t);
  assert.equal(box.hwdb(["start"]).status, 0);
  const create = box.hwdb(["-u", "SYSTEM", "-p", "HelloWorldDB", "-t", "SYSTEM", "-e", "CREATE TABLE HELLO (MESSAGE VARCHAR); INSERT INTO HELLO VALUES ('Hello World')"]);
  assert.equal(create.status, 0, create.stderr);
  assert.equal(box.hwdb(["stop"]).status, 0);
  assert.equal(box.hwdb(["start"]).status, 0);
  const select = box.hwdb(["-u", "SYSTEM", "-p", "HelloWorldDB", "-t", "SYSTEM", "-e", "SELECT * FROM HELLO"]);
  assert.equal(select.status, 0, select.stderr);
  assert.match(select.stdout, /\| Hello World \|/);
});

test("설치 직후 hwdb 로 SYSTEM 에 로그인해 초기 암호를 바꿀 수 있다 (상세 4, 14)", async (t) => {
  const box = await install(t);
  assert.equal(box.hwdb(["start"]).status, 0);
  // 표준 입력으로 문장을 주는 스크립트 모드이다 (표준 입력이 터미널이 아니므로 -u, -p 가 필요하다).
  const login = box.hwdb(["-u", "SYSTEM", "-p", "HelloWorldDB"], { input: "ALTER USER SYSTEM IDENTIFIED BY 'n3w-Secret';\n" });
  assert.equal(login.status, 0, login.stderr);
  assert.match(login.stderr, /ALTER USER SYSTEM IDENTIFIED BY '<new password>'/, "초기 암호로 로그인했으므로 변경을 안내한다");

  const old = box.hwdb(["-u", "SYSTEM", "-p", "HelloWorldDB", "-e", "SELECT 1"]);
  assert.equal(old.status, 1);
  assert.match(old.stderr, /Authentication failed/);

  const changed = box.hwdb(["-u", "SYSTEM", "-p", "n3w-Secret", "-e", "SELECT 1"]);
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(changed.stderr, "");

  // 비밀번호가 바뀌었으므로 start 와 status 의 경고도 사라진다.
  const status = box.hwdb(["status"]);
  assert.equal(status.status, 0);
  assert.equal(status.stderr, "");
  // 로그에 평문 비밀번호가 남지 않는다.
  assert.doesNotMatch(fs.readFileSync(box.logPath, "utf8"), /n3w-Secret/);
});

test("hwdb 의 SQL 접속은 세 경로 모두 같은 결과를 낸다", async (t) => {
  const box = await install(t);
  assert.equal(box.hwdb(["start"]).status, 0);
  const common = ["-u", "SYSTEM", "-p", "HelloWorldDB", "-e", "SELECT 'Hello World'"];
  const local = box.hwdb(common);
  const tcp = box.hwdb(["-h", "127.0.0.1", ...common]);
  const udp = box.hwdb(["-h", "127.0.0.1", "--udp", ...common]);
  for (const result of [local, tcp, udp]) {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\| Hello World \|/);
  }
});

test("TCP 와 UDP 를 모두 껐거나 maxConnections 가 찬 상태에서도 로컬 접속은 된다", async (t) => {
  const off = await install(t, { tcp: { enabled: false }, udp: { enabled: false } });
  assert.equal(off.hwdb(["start"]).status, 0);
  const status = off.hwdb(["status"]);
  assert.match(status.stdout, /tcp: off\nudp: off\n/);
  const local = off.hwdb(["-u", "SYSTEM", "-p", "HelloWorldDB", "-e", "SELECT 'local only'"]);
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /\| local only \|/);
  assert.equal(off.hwdb(["stop"]).status, 0);

  const full = await install(t, { maxConnections: 1 });
  assert.equal(full.hwdb(["start"]).status, 0);
  const held = await Connection.open({ kind: "tcp", host: "127.0.0.1", port: full.port });
  t.after(() => held.abort());
  await held.login({ user: "SYSTEM", password: "HelloWorldDB" });
  const remote = full.hwdb(["-h", "127.0.0.1", "-u", "SYSTEM", "-p", "HelloWorldDB", "-e", "SELECT 1"]);
  assert.equal(remote.status, 1, "TCP 접속은 가득 차서 거부된다");
  const viaLocal = full.hwdb(["-u", "SYSTEM", "-p", "HelloWorldDB", "-e", "SELECT 'still local'"]);
  assert.equal(viaLocal.status, 0, viaLocal.stderr);
  assert.match(viaLocal.stdout, /\| still local \|/);
});

test("구동 중이 아닐 때 SQL 접속은 hwdb start 를 안내한다", async (t) => {
  const box = await install(t);
  const result = box.hwdb(["-u", "SYSTEM", "-p", "HelloWorldDB", "-e", "SELECT 1"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /hwdb start/);
});

test("구동에 실패하면 원인을 보여 주고 종료 코드 1 로 끝나며 데몬이 남지 않는다", async (t) => {
  const box = await install(t);
  // 같은 번호의 TCP 포트를 다른 프로그램이 쓰고 있다.
  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(box.port, "0.0.0.0", resolve);
  });
  t.after(() => blocker.close());
  const start = box.hwdb(["start", "--timeout", "20"]);
  assert.equal(start.status, 1);
  assert.match(start.stderr, /^hwdb start: .*(EADDRINUSE|in use|address)/is);
  assert.match(start.stderr, /See the log file: /);
  // 구동에 실패한 데몬은 잠금 파일을 남기지 않는다.
  assert.equal(readLockFile(box.dataDir), null);
  assert.equal(box.hwdb(["status"]).status, 1);
});

test("config.json 이 올바르지 않으면 데몬을 띄우지 않고 원인을 보여 준다", async (t) => {
  const box = await install(t);
  fs.writeFileSync(path.join(box.installDir, "config.json"), '{"port": 0}');
  const start = box.hwdb(["start"]);
  assert.equal(start.status, 1);
  assert.match(start.stderr, /^hwdb start: .*port/is);
  assert.equal(box.hwdb(["status"]).status, 1);
  assert.match(box.hwdb(["status"]).stderr, /^hwdb status: .*port/is);
});

test("죽은 PID 가 적힌 잠금 파일은 구동 중이 아닌 것으로 보고, 구동하면 덮어쓴다", async (t) => {
  const box = await install(t);
  // 이미 끝난 프로세스의 PID 를 구한다.
  const finished = spawnSync(process.execPath, ["-e", ""]);
  const deadPid = finished.pid;
  assert.equal(isProcessAlive(deadPid), false);
  fs.mkdirSync(box.dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(box.dataDir, LOCK_FILE_NAME),
    JSON.stringify({ pid: deadPid, port: box.port, startedAt: "2020-01-01T00:00:00.000Z", controlToken: "stale" }),
  );
  const status = box.hwdb(["status"]);
  assert.equal(status.status, 1);
  assert.match(status.stdout, /running: no/);
  assert.doesNotMatch(status.stdout, /note:/);
  assert.equal(box.hwdb(["stop"]).stdout, "HelloWorldDB is not running.\n");

  const start = box.hwdb(["start"]);
  assert.equal(start.status, 0, start.stderr);
  const lock = readLockFile(box.dataDir);
  assert.notEqual(lock?.pid, deadPid);
  assert.notEqual(lock?.controlToken, "stale");
});

test("PID 가 살아 있어도 로컬 전용 채널이 답하지 않으면 구동 중으로 보지 않고 알린다 (PID 재사용 대비)", async (t) => {
  const box = await install(t);
  // 이 시험 프로세스가 살아 있는 아무 프로그램인 척한다. 로컬 전용 채널은 열려 있지 않다.
  fs.mkdirSync(box.dataDir, { recursive: true });
  const lockPath = path.join(box.dataDir, LOCK_FILE_NAME);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, port: await freePort(), startedAt: "2020-01-01T00:00:00.000Z", controlToken: "x" }));

  const status = box.hwdb(["status"]);
  assert.equal(status.status, 1);
  assert.match(status.stdout, /running: no/);
  assert.match(status.stdout, /note: the lock file .* names process \d+, which is alive but does not answer/);

  const start = box.hwdb(["start"]);
  assert.equal(start.status, 1);
  assert.match(start.stderr, /the lock file .* names process \d+, which is alive but does not answer on the local-only channel/);

  const stop = box.hwdb(["stop"]);
  assert.equal(stop.status, 1);
  assert.match(stop.stderr, /^hwdb stop: the lock file /);
  // 잠금 파일은 마음대로 지우지 않는다.
  assert.equal(fs.existsSync(lockPath), true);
});

test("방금 시작한 것처럼 보이는 잠금 파일이면 start 는 제한 시간까지 기다린다", async (t) => {
  const box = await install(t);
  fs.mkdirSync(box.dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(box.dataDir, LOCK_FILE_NAME),
    JSON.stringify({ pid: process.pid, port: await freePort(), startedAt: new Date().toISOString(), controlToken: "x" }),
  );
  const started = Date.now();
  const start = box.hwdb(["start", "--timeout", "1"]);
  assert.equal(start.status, 1);
  assert.match(start.stderr, /did not finish starting within 1 seconds/);
  assert.ok(Date.now() - started >= 900, "제한 시간만큼 기다렸다");
});

test("구동한 뒤 config.json 의 포트를 바꿔도 떠 있는 데몬을 찾아 상태를 보고 종료한다", async (t) => {
  const box = await install(t);
  assert.equal(box.hwdb(["start"]).status, 0);
  const otherPort = await freePort();
  fs.writeFileSync(path.join(box.installDir, "config.json"), JSON.stringify({ port: otherPort }));
  // 데몬은 시작할 때의 포트로 계속 돈다 (설정은 구동할 때 한 번만 읽는다). 잠금 파일에 적힌 포트로 찾는다.
  const status = box.hwdb(["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`port: ${box.port}\\n`));
  assert.equal(box.hwdb(["stop"]).status, 0);
});

test("두 인스턴스(다른 설치 디렉토리, 다른 포트)를 함께 구동하고 따로 종료한다 (상세 15)", async (t) => {
  const first = await install(t);
  const second = await install(t);
  assert.notEqual(first.port, second.port);
  assert.equal(first.hwdb(["start"]).status, 0);
  assert.equal(second.hwdb(["start"]).status, 0);
  const common = ["-u", "SYSTEM", "-p", "HelloWorldDB", "-t", "SYSTEM"];
  assert.equal(first.hwdb([...common, "-e", "CREATE TABLE ONLY_FIRST (N INTEGER)"]).status, 0);
  assert.equal(second.hwdb([...common, "-e", "SELECT * FROM ONLY_FIRST"]).status, 1, "두 인스턴스의 데이터는 별개이다");
  assert.equal(first.hwdb(["stop"]).status, 0);
  assert.equal(second.hwdb(["status"]).status, 0, "하나를 종료해도 다른 인스턴스는 계속 돈다");
  assert.equal(second.hwdb(["stop"]).status, 0);
});

test("hwdb --version, --help, 잘못된 인자", async (t) => {
  const box = await install(t);
  const version = box.hwdb(["--version"]);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^hwdb \d+\.\d+\.\d+\n$/);
  const help = box.hwdb(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage:\n {2}hwdb start/);
  const bad = box.hwdb(["--bogus"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown option "--bogus"\nTry: hwdb --help\n$/);
  assert.equal(bad.stdout, "");
  const conflict = box.hwdb(["-h", "127.0.0.1", "--udp", "--ssl"]);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /--udp and --ssl cannot be used together/);
});

test("start --foreground 는 분리하지 않고 현재 프로세스에서 구동해 종료 요청으로 끝난다", async (t) => {
  const box = await install(t);
  const child = spawn(process.execPath, [HWDB, "start", "--foreground"], {
    env: { ...process.env, HWDB_INSTALL_DIR: box.installDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  await waitFor(() => output.includes("Listening:"), 20_000, `the daemon to start (output: ${output})`);
  assert.equal(box.hwdb(["status"]).status, 0);
  assert.equal(box.hwdb(["stop"]).status, 0);
  assert.equal(await exited, 0);
});
