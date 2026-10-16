/**
 * 데몬 제어 : `hwdb start`, `hwdb stop`, `hwdb status`.
 *
 * 담당
 *  - start  : 이미 구동 중인지 확인 → 데몬(daemon/entry.ts)을 분리된 프로세스로 띄움
 *             → 접속을 받을 수 있게 될 때까지 대기(제한 시간) → 포트 번호와 PID 출력.
 *             `--foreground` 면 분리하지 않고 현재 터미널에서 실행한다.
 *  - stop   : 종료 요청 → 데몬 프로세스가 사라질 때까지 대기 → 결과 출력
 *  - status : 구동 여부, 포트 번호, PID, 구동 시각, 버전, 데이터 디렉토리,
 *             TCP 와 UDP 사용 여부, 세션 수 출력. 구동 중이면 종료 코드 0, 아니면 1
 *  - 제어 요청은 로컬 전용 채널로 보내며, 잠금 파일(daemon/lockFile.ts)의 제어 토큰을 싣는다.
 *
 * 대상은 이 `hwdb` 가 속한 설치 디렉토리의 인스턴스이다. (같은 디렉토리의 config.json)
 * DB 계정 인증은 거치지 않는다.
 *
 * 구동 중인지의 판단 : 잠금 파일의 PID 가 살아 있는 것만으로는 부족하다. 운영체제가 그 PID 를 다른 프로세스에 다시 줬을 수 있기 때문이다.
 * 그래서 로컬 전용 채널에 제어 토큰으로 상태를 물어 답이 오는 것(`running`)을 구동 중으로 본다.
 * PID 는 살아 있는데 답이 없으면 `unresponsive` 이다. (구동 중이거나, 멈췄거나, PID 를 다른 프로그램이 쓰는 중이다)
 * 이때는 잠금 파일을 마음대로 지우지 않고 알려 준다.
 *
 * 데몬을 분리하는 방법 : `process.execPath`(Node.js 또는 bun)로 daemon/entry.js 를 `detached` 로 띄운다. 표준 입력은 닫고
 * 표준 출력과 표준 오류는 로그 파일에 이어 붙인다. Windows 에서는 `windowsHide` 로 콘솔 창이 뜨지 않게 한다.
 * 부모(`hwdb start`)는 `unref` 하여 데몬이 계속 돌아도 바로 끝낼 수 있다.
 *
 * 관련 사양 : AGENTS.md 상세 14-1
 * 구현 단계 : 10단계
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection } from "../client/connection.js";
import { LOG_FILE_NAME, RDBMS_VERSION, getLockFilePath } from "../common/instance.js";
import { loadConfig } from "../config/config.js";
import type { ResolvedConfig } from "../config/config.js";
import { isProcessAlive, readLockFile } from "../daemon/lockFile.js";
import type { LockFileContent } from "../daemon/lockFile.js";
import { exitAfterShutdown, runForeground } from "../daemon/main.js";
import type { StatusResponse } from "../net/protocol.js";
import { t } from "./i18n.js";

export interface StartRequest {
  installDir: string;
  foreground: boolean;
  timeoutSeconds: number;
}

/** 구동 상태 확인에서 로컬 전용 채널에 기다리는 시간(ms)이다. */
const PROBE_TIMEOUT_MS = 2000;
/** 구동 완료를 확인하는 간격(ms)이다. */
const POLL_INTERVAL_MS = 100;
/** 구동 중인 다른 `hwdb start` 를 기다리는 기준이다. 잠금 파일의 구동 시각이 이보다 최근이면 아직 구동 중일 수 있다고 본다. */
const RECENT_START_MS = 60_000;

// ---------------------------------------------------------------------------
// 구동 상태 확인
// ---------------------------------------------------------------------------

/** 데몬의 구동 상태이다. */
export type DaemonProbe =
  | { state: "stopped"; lock: LockFileContent | null }
  | { state: "running"; lock: LockFileContent; status: StatusResponse }
  | { state: "unresponsive"; lock: LockFileContent };

/**
 * 데몬이 구동 중인지 확인한다.
 *  - 잠금 파일이 없거나 PID 의 프로세스가 없으면 `stopped` (남은 잠금 파일이 있으면 `lock` 에 담긴다)
 *  - 잠금 파일의 제어 토큰으로 로컬 전용 채널에 상태를 물어 답이 오면 `running`
 *  - PID 는 살아 있지만 답이 없으면 `unresponsive`
 * 접속은 잠금 파일에 적힌 포트로 한다. 구동한 뒤에 config.json 의 `port` 를 바꿨어도 떠 있는 데몬을 찾을 수 있다.
 */
export async function probeDaemon(config: ResolvedConfig, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<DaemonProbe> {
  const lock = readLockFile(config.dataDir);
  if (lock === null || !isProcessAlive(lock.pid)) return { state: "stopped", lock };
  try {
    const connection = await Connection.open({ kind: "local", port: lock.port }, { requestTimeoutMs: timeoutMs, internal: { connectTimeoutMs: timeoutMs } });
    try {
      const status = await connection.control("status", lock.controlToken);
      return { state: "running", lock, status };
    } finally {
      connection.abort();
    }
  } catch {
    return { state: "unresponsive", lock };
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return t("error.unknown");
}

function loadConfigSafe(installDir: string): { config: ResolvedConfig; error: null } | { config: null; error: string } {
  try {
    const { config } = loadConfig(installDir);
    return { config, error: null };
  } catch (error) {
    return { config: null, error: describeError(error) };
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** SYSTEM 계정이 초기 암호 그대로이면 변경을 안내한다. (표준 오류) */
function warnInitialPassword(status: StatusResponse): void {
  if (status.systemPasswordInitial) process.stderr.write(`${t("warning.initialPassword")}\n`);
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

/** 분리해서 띄울 데몬 진입점의 경로이다. */
function daemonEntryPath(): string {
  return fileURLToPath(new URL("../daemon/entry.js", import.meta.url));
}

/** 분리된 데몬 프로세스의 종료 정보이다. */
interface ChildExit {
  done: boolean;
  code: number | null;
  signal: string | null;
  error: Error | null;
}

/**
 * 구동에 실패했을 때 보여 줄 원인을 로그 파일에서 찾는다. 이번 구동이 쓰기 시작한 위치(`startOffset`) 뒤만 본다.
 * `[error]` 줄이 있으면 그 마지막 줄의 메시지이고, 없으면 마지막 줄이다. 아무것도 없으면 null 이다.
 */
function findStartupFailure(logPath: string, startOffset: number): string | null {
  let text: string;
  try {
    const descriptor = fs.openSync(logPath, "r");
    try {
      const size = fs.fstatSync(descriptor).size;
      const from = Math.max(startOffset, size - 64 * 1024);
      const buffer = Buffer.alloc(Math.max(0, size - from));
      fs.readSync(descriptor, buffer, 0, buffer.length, from);
      text = buffer.toString("utf8");
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const errorLine = [...lines].reverse().find((line) => line.includes("[error]"));
  const chosen = errorLine ?? lines[lines.length - 1];
  if (chosen === undefined) return null;
  const marker = chosen.indexOf("[error] ");
  const message = marker === -1 ? chosen : chosen.slice(marker + "[error] ".length);
  return message.replace(/^Startup failed:\s*/, "");
}

/** 구동하다 멈춘 데몬을 정리한다. 가능하면 정상 종료를 요청하고, 안 되면 강제로 끝낸다. */
async function terminateStartingDaemon(child: ChildProcess, exit: ChildExit, config: ResolvedConfig): Promise<void> {
  try {
    const lock = readLockFile(config.dataDir);
    if (lock !== null && lock.pid === child.pid) {
      const connection = await Connection.open({ kind: "local", port: lock.port }, { requestTimeoutMs: PROBE_TIMEOUT_MS, internal: { connectTimeoutMs: PROBE_TIMEOUT_MS } });
      try {
        await connection.control("stop", lock.controlToken);
      } finally {
        connection.abort();
      }
    }
  } catch {
    // 아직 제어 요청을 받을 수 없는 단계이다. 아래에서 강제로 끝낸다.
  }
  const deadline = Date.now() + 5000;
  while (!exit.done && Date.now() < deadline) await sleep(POLL_INTERVAL_MS);
  if (!exit.done) {
    try {
      child.kill();
    } catch {
      // 이미 끝났다.
    }
  }
}

/** `hwdb start` 를 실행한다. */
export async function startCommand(request: StartRequest): Promise<number> {
  const loaded = loadConfigSafe(request.installDir);
  if (loaded.config === null) {
    process.stderr.write(`${t("start.failed", { reason: loaded.error })}\n`);
    return 1;
  }
  const config = loaded.config;

  if (request.foreground) {
    try {
      await runForeground(request.installDir);
      // 정상 종료 절차를 마쳤다. 접속한 클라이언트가 소켓을 닫지 않아도 프로세스가 남지 않게 직접 끝낸다.
      return await exitAfterShutdown(0);
    } catch (error) {
      process.stderr.write(`${t("start.failed", { reason: describeError(error) })}\n`);
      return 1;
    }
  }

  let probe: DaemonProbe;
  try {
    probe = await probeDaemon(config);
  } catch (error) {
    process.stderr.write(`${t("start.failed", { reason: describeError(error) })}\n`);
    return 1;
  }
  if (probe.state === "running") {
    process.stdout.write(`${t("start.alreadyRunning", { port: probe.status.port, pid: probe.status.pid })}\n`);
    warnInitialPassword(probe.status);
    return 0;
  }
  const deadline = Date.now() + request.timeoutSeconds * 1000;
  if (probe.state === "unresponsive") {
    // 다른 `hwdb start` 가 막 띄운 데몬이면 곧 답한다. 오래된 잠금이면 멈췄거나 PID 가 다른 프로그램에 쓰이는 중이다.
    const startedAt = Date.parse(probe.lock.startedAt);
    const recent = Number.isFinite(startedAt) && Date.now() - startedAt < RECENT_START_MS;
    if (!recent) {
      process.stderr.write(`${t("start.failed", { reason: t("start.lockHeld", { path: getLockFilePath(config.dataDir), pid: probe.lock.pid }) })}\n`);
      return 1;
    }
    return await waitForStartedElsewhere(config, probe.lock, deadline, request.timeoutSeconds);
  }

  // 분리된 프로세스로 띄운다. 출력은 로그 파일로 이어 붙인다.
  const logPath = path.join(config.log.dir, LOG_FILE_NAME);
  let descriptor: number;
  let startOffset = 0;
  try {
    fs.mkdirSync(config.log.dir, { recursive: true });
    startOffset = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
    descriptor = fs.openSync(logPath, "a", 0o600);
  } catch (error) {
    process.stderr.write(`${t("start.failed", { reason: t("start.cannotOpenLog", { path: logPath, reason: describeError(error) }) })}\n`);
    return 1;
  }
  const exit: ChildExit = { done: false, code: null, signal: null, error: null };
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [daemonEntryPath(), config.installDir], {
      detached: true,
      stdio: ["ignore", descriptor, descriptor],
      windowsHide: true,
    });
  } catch (error) {
    fs.closeSync(descriptor);
    process.stderr.write(`${t("start.failed", { reason: t("start.spawnFailed", { reason: describeError(error) }) })}\n`);
    return 1;
  } finally {
    // 자식 프로세스가 자기 몫의 핸들을 이미 물려받았다. 부모의 핸들은 닫는다.
    try { fs.closeSync(descriptor); } catch { /* 이미 닫혔다. */ }
  }
  child.once("error", (error) => {
    exit.done = true;
    exit.error = error;
  });
  child.once("exit", (code, signal) => {
    exit.done = true;
    exit.code = code;
    exit.signal = signal;
  });
  child.unref();

  for (;;) {
    if (exit.done) {
      const reason =
        exit.error !== null
          ? t("start.spawnFailed", { reason: exit.error.message })
          : (findStartupFailure(logPath, startOffset) ?? t(exit.signal !== null ? "start.exitedSignal" : "start.exited", { code: exit.code ?? "?", signal: exit.signal ?? "" }));
      process.stderr.write(`${t("start.failed", { reason })}\n${t("start.seeLog", { path: logPath })}\n`);
      return 1;
    }
    const lock = readLockFile(config.dataDir);
    if (lock !== null && lock.pid === child.pid) {
      const probed = await probeDaemon(config);
      if (probed.state === "running" && probed.status.ready) {
        process.stdout.write(`${t("start.started", { port: probed.status.port, pid: probed.status.pid })}\n`);
        warnInitialPassword(probed.status);
        return 0;
      }
    }
    if (Date.now() >= deadline) {
      await terminateStartingDaemon(child, exit, config);
      process.stderr.write(`${t("start.failed", { reason: t("start.timeout", { seconds: request.timeoutSeconds }) })}\n${t("start.seeLog", { path: logPath })}\n`);
      return 1;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** 다른 `hwdb start` 가 띄우는 중인 데몬이 접속을 받을 수 있게 되기를 기다린다. */
async function waitForStartedElsewhere(config: ResolvedConfig, lock: LockFileContent, deadline: number, timeoutSeconds: number): Promise<number> {
  for (;;) {
    const probe = await probeDaemon(config);
    if (probe.state === "running" && probe.status.ready) {
      process.stdout.write(`${t("start.alreadyRunning", { port: probe.status.port, pid: probe.status.pid })}\n`);
      warnInitialPassword(probe.status);
      return 0;
    }
    if (probe.state === "stopped") {
      process.stderr.write(`${t("start.failed", { reason: t("start.otherStartFailed", { pid: lock.pid }) })}\n`);
      return 1;
    }
    if (Date.now() >= deadline) {
      process.stderr.write(`${t("start.failed", { reason: t("start.timeout", { seconds: timeoutSeconds }) })}\n`);
      return 1;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

/** `hwdb stop` 을 실행한다. 종료를 요청하고, 정상 종료 절차가 끝나 프로세스가 사라질 때까지 기다린다. */
export async function stopCommand(installDir: string, timeoutSeconds: number): Promise<number> {
  const loaded = loadConfigSafe(installDir);
  if (loaded.config === null) {
    process.stderr.write(`${t("stop.failed", { reason: loaded.error })}\n`);
    return 1;
  }
  const config = loaded.config;
  let probe: DaemonProbe;
  try {
    probe = await probeDaemon(config);
  } catch (error) {
    process.stderr.write(`${t("stop.failed", { reason: describeError(error) })}\n`);
    return 1;
  }
  if (probe.state === "stopped") {
    process.stdout.write(`${t("stop.notRunning")}\n`);
    return 0;
  }
  if (probe.state === "unresponsive") {
    process.stderr.write(`${t("stop.failed", { reason: t("start.lockHeld", { path: getLockFilePath(config.dataDir), pid: probe.lock.pid }) })}\n`);
    return 1;
  }

  const { lock } = probe;
  try {
    const connection = await Connection.open({ kind: "local", port: lock.port }, { requestTimeoutMs: PROBE_TIMEOUT_MS, internal: { connectTimeoutMs: PROBE_TIMEOUT_MS } });
    try {
      await connection.control("stop", lock.controlToken);
    } finally {
      connection.abort();
    }
  } catch (error) {
    process.stderr.write(`${t("stop.failed", { reason: describeError(error) })}\n`);
    return 1;
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (isProcessAlive(lock.pid)) {
    if (Date.now() >= deadline) {
      process.stderr.write(`${t("stop.failed", { reason: t("stop.timeout", { seconds: timeoutSeconds, pid: lock.pid }) })}\n`);
      return 1;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  process.stdout.write(`${t("stop.stopped")}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * `hwdb status` 를 실행한다.
 * 구동 중이면 데몬이 알려 준 값을 보여 주고(종료 코드 0), 아니면 config.json 의 값을 보여 준다(종료 코드 1).
 */
export async function statusCommand(installDir: string): Promise<number> {
  const loaded = loadConfigSafe(installDir);
  if (loaded.config === null) {
    process.stderr.write(`${t("status.failed", { reason: loaded.error })}\n`);
    return 1;
  }
  const config = loaded.config;
  let probe: DaemonProbe;
  try {
    probe = await probeDaemon(config);
  } catch (error) {
    process.stderr.write(`${t("status.failed", { reason: describeError(error) })}\n`);
    return 1;
  }

  const yesNo = (value: boolean): string => t(value ? "common.yes" : "common.no");
  const onOff = (value: boolean): string => t(value ? "common.on" : "common.off");
  const lines: string[] = [];
  if (probe.state === "running") {
    const status = probe.status;
    lines.push(t("status.running", { value: yesNo(true) }));
    lines.push(t("status.port", { value: status.port }));
    lines.push(t("status.pid", { value: status.pid }));
    lines.push(t("status.startedAt", { value: status.startedAt }));
    lines.push(t("status.version", { value: status.version }));
    lines.push(t("status.dataDir", { value: status.dataDir }));
    lines.push(t("status.tcp", { value: onOff(status.tcpEnabled) }));
    lines.push(t("status.udp", { value: onOff(status.udpEnabled) }));
    lines.push(t("status.sessions", { value: status.sessionCount }));
    if (!status.ready) lines.push(t("status.starting"));
    process.stdout.write(`${lines.join("\n")}\n`);
    warnInitialPassword(status);
    return 0;
  }

  lines.push(t("status.running", { value: yesNo(false) }));
  lines.push(t("status.port", { value: config.port }));
  lines.push(t("status.version", { value: RDBMS_VERSION }));
  lines.push(t("status.dataDir", { value: config.dataDir }));
  lines.push(t("status.tcp", { value: onOff(config.tcp.enabled) }));
  lines.push(t("status.udp", { value: onOff(config.udp.enabled) }));
  lines.push(t("status.sessions", { value: 0 }));
  if (probe.state === "unresponsive") {
    lines.push(t("status.unresponsive", { pid: probe.lock.pid, path: getLockFilePath(config.dataDir) }));
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 1;
}
