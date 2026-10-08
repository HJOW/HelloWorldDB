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
 * 구현 단계 : 1단계(중복 구동 방지), 10단계(제어 토큰)
 * 1단계에서는 중복 구동 방지와 기본 상태 조회까지만 쓴다.
 * 제어 토큰을 로컬 전용 채널에 싣는 일은 9~10단계에서 한다.
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

/** PID 의 프로세스가 살아 있는지 확인한다. 권한이 없어도 존재하면 참이다. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
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
  // 이 짧은 구간에서 프로세스가 강제 종료되면 불완전한 잠금을 자동으로 추측해 지우지 않는다.
  const gatePath = `${lockPath}.acquire`;
  try {
    fs.mkdirSync(gatePath);
  } catch (error) {
    throw new StartupError(`Cannot acquire data directory lock: ${gatePath}`, { cause: error });
  }
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
