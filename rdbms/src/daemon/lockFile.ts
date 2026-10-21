/**
 * 데이터 디렉토리의 잠금 파일.
 *
 * 담당
 *  - 데이터 디렉토리 하나를 데몬 프로세스 하나만 쓰도록 막는다.
 *  - 구동할 때 PID, 포트 번호, 구동 시각, 제어 토큰을 적는다.
 *    제어 토큰은 구동할 때마다 새로 만드는 임의의 값이다.
 *  - 남아 있는 잠금 파일의 판정 : 적힌 PID 의 프로세스가 없으면 구동 중이 아닌 것으로 본다.
 *  - 정상 종료 때 잠금 파일을 지운다.
 *
 * 데몬이 쓰고 CLI 가 읽는다. CLI 는 여기서 읽은 제어 토큰을 데몬 제어 요청에 싣는다.
 * 그래서 데이터 디렉토리를 읽을 수 있는 운영체제 사용자만 데몬을 제어할 수 있다.
 *
 * 관련 사양 : AGENTS.md 상세 9, 14-1
 * 구현 단계 : 1단계(중복 구동 방지), 9단계(서버의 제어 토큰 확인), 10단계(CLI 가 토큰을 읽어 제어 요청에 싣기, 남은 가드 정리)
 * 서버가 제어 토큰을 확인하는 일은 net/messageHandler.ts 의 `control` 처리, CLI 가 토큰을 읽어 보내는 일은 cli/daemonControl.ts 의 `probeDaemon` 이다.
 * 잠금 파일의 PID 만으로는 구동 중인지 알 수 없다(운영체제가 PID 를 다른 프로그램에 다시 줄 수 있다). CLI 는 로컬 전용 채널의 상태 조회 응답까지 확인한다.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { StartupError } from "../common/errors.js";
import { getLockFilePath } from "../common/instance.js";

/** 잠금 파일의 내용이다. */
export interface LockFileContent {
  pid: number;
  port: number;
  startedAt: string;
  controlToken: string;
}

/** 잠금 파일의 내용을 읽는다. 파일이 없으면 null 을 돌려준다. */
export function readLockFile(dataDir: string): LockFileContent | null {
  const lockPath = getLockFilePath(dataDir);
  let text: string;
  try {
    text = fs.readFileSync(lockPath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw new StartupError(`Cannot read lock file: ${lockPath}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isLockFileContent(parsed)) {
    return null;
  }
  return parsed;
}

/** PID 의 프로세스가 살아 있는지 확인한다. Linux의 종료된 좀비는 제외하고, 권한이 없으면 보수적으로 참이다. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        // comm에는 공백과 괄호가 들어갈 수 있다. 마지막 닫는 괄호 뒤의 상태 필드만 읽는다.
        const state = stat[stat.lastIndexOf(")") + 2];
        if (state === "Z" || state === "X") return false;
      } catch (error) {
        if (isNotFoundError(error)) return false;
        // /proc 접근이 제한된 환경에서는 kill(0)의 존재 판정을 유지한다.
      }
    }
    return true;
  } catch (error) {
    if (isErrnoError(error) && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

/**
 * 잠금 파일을 확보한다.
 * 이미 살아 있는 데몬의 잠금이면 StartupError 를 던진다.
 * 비정상 종료로 남은 파일(PID 의 프로세스가 없음)은 덮어쓴다.
 */
export function acquireLock(dataDir: string, port: number): LockFileContent {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = getLockFilePath(dataDir);
  // 읽기와 쓰기 사이에 다른 프로세스가 잠금을 덮어쓰지 못하도록 생성 절차를 직렬화한다.
  // 가드는 이 짧은 구간(수 ms)에만 존재한다. 그 사이에 프로세스가 강제 종료되어 남은 가드는 오래된 것만 치운다. (`takeGate`)
  const gatePath = `${lockPath}.acquire`;
  takeGate(gatePath);
  try {
    const existing = readLockFile(dataDir);
    if (existing !== null && isProcessAlive(existing.pid)) {
      throw new StartupError(
        `Data directory is already in use by process ${String(existing.pid)} (port ${String(existing.port)}).`,
      );
    }
    const content: LockFileContent = {
      pid: process.pid,
      port,
      startedAt: new Date().toISOString(),
      controlToken: crypto.randomBytes(16).toString("hex"),
    };
    try {
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
      fs.writeFileSync(lockPath, JSON.stringify(content, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      throw new StartupError(`Cannot write lock file: ${lockPath}`, { cause: error });
    }
    return content;
  } finally {
    fs.rmdirSync(gatePath);
  }
}

/**
 * 잠금 생성 가드가 이만큼(ms) 지났으면 강제 종료로 남은 것으로 본다.
 * 가드는 잠금 파일을 읽고 쓰는 동안만 있으므로 정상이라면 수 ms 안에 사라진다. 여유를 크게 잡았다.
 */
export const GATE_STALE_MS = 10_000;

/**
 * 잠금 생성 가드(디렉토리)를 만든다. 이미 있으면 다른 프로세스가 지금 잠금을 만드는 중이므로 실패한다.
 * 단, 오래된 가드(`GATE_STALE_MS` 보다 오래됨)는 그 구간에서 프로세스가 강제 종료되어 남은 것이므로 치우고 한 번 더 만든다.
 * 오래된 가드를 치우는 순간 다른 프로세스도 같은 가드를 치우고 있으면 둘 다 잡을 수 있는 좁은 틈이 있다.
 * 가드가 남아 있는 상황 자체가 드물고, 그 틈은 같은 순간에 구동하는 경우에만 열리며, 그때도 잠금 파일의 PID 검사가 한 번 더 막는다.
 */
function takeGate(gatePath: string): void {
  try {
    fs.mkdirSync(gatePath);
    return;
  } catch (error) {
    if (!isErrnoError(error) || error.code !== "EEXIST") {
      throw new StartupError(`Cannot acquire data directory lock: ${gatePath}`, { cause: error });
    }
    let ageMs: number;
    try {
      ageMs = Date.now() - fs.statSync(gatePath).mtimeMs;
    } catch {
      ageMs = Number.POSITIVE_INFINITY; // 그 사이에 지워졌다. 다시 만들어 본다.
    }
    if (ageMs <= GATE_STALE_MS) {
      throw new StartupError(`Cannot acquire data directory lock: ${gatePath} (another process is starting on this data directory)`, { cause: error });
    }
    try {
      fs.rmdirSync(gatePath);
    } catch {
      // 다른 프로세스가 먼저 치웠다. 아래에서 만들어 본다.
    }
    try {
      fs.mkdirSync(gatePath);
    } catch (retryError) {
      throw new StartupError(`Cannot acquire data directory lock: ${gatePath}`, { cause: retryError });
    }
  }
}

/** 정상 종료 때 잠금 파일을 지운다. 없으면 넘어간다. */
export function releaseLock(dataDir: string, owner?: LockFileContent): void {
  const lockPath = getLockFilePath(dataDir);
  if (owner !== undefined && readLockFile(dataDir)?.controlToken !== owner.controlToken) return;
  try {
    fs.rmSync(lockPath, { force: true });
  } catch (error) {
    throw new StartupError(`Cannot remove lock file: ${lockPath}`, { cause: error });
  }
}

/** 데몬이 구동 중인지 잠금 파일과 PID 로 판단한다. */
export function isRunning(dataDir: string): boolean {
  const existing = readLockFile(dataDir);
  return existing !== null && isProcessAlive(existing.pid);
}

function isLockFileContent(value: unknown): value is LockFileContent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["pid"] === "number" &&
    Number.isSafeInteger(record["pid"]) && record["pid"] > 0 &&
    typeof record["port"] === "number" &&
    Number.isInteger(record["port"]) && record["port"] >= 1 && record["port"] <= 65535 &&
    typeof record["startedAt"] === "string" &&
    typeof record["controlToken"] === "string" &&
    record["controlToken"].length > 0
  );
}

function isNotFoundError(error: unknown): boolean {
  return isErrnoError(error) && error.code === "ENOENT";
}

function isErrnoError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
