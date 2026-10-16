/**
 * 데몬 프로세스의 진입점.
 *
 * 담당
 *  - 데몬 본체의 구동 절차(`runForeground`)이다. `hwdb start` 가 분리된 프로세스로 띄우는 진입점(entry.ts)이 이것을 부르고,
 *    `--foreground` 일 때는 CLI 프로세스 안에서 같은 절차를 그대로 실행한다.
 *  - 설정 읽기(config/config.ts) → 데몬 본체 구동(server.ts) → 구동 완료를 `hwdb start` 에 알림
 *  - SIGINT, SIGTERM 을 받거나 로컬 전용 채널로 종료 요청(`hwdb stop`)이 오면 정상 종료 절차를 시작한다.
 *    Windows 에서는 다른 프로세스가 보낸 SIGTERM 을 받을 수 없으므로,
 *    데몬의 정상 종료는 로컬 전용 채널의 종료 요청(`hwdb stop`)이 기본 경로이다.
 *  - 처리되지 않은 오류의 마지막 처리, 로그 기록, 프로세스 종료 코드
 *
 * 여기에 두지 않는 것 : 구동과 종료의 세부 순서 (server.ts)
 *
 * 관련 사양 : AGENTS.md 상세 12, 14-1
 * 구현 단계 : 1단계(포그라운드 구동), 10단계(분리된 프로세스로 구동. 분리 진입점은 entry.ts)
 */

import { loadConfig } from "../config/config.js";
import { StartupError } from "../common/errors.js";
import { createLogger } from "../common/logger.js";
import type { Logger } from "../common/logger.js";
import { Server } from "./server.js";

export interface ForegroundOptions {
  /** 구동 완료 콜백. 테스트에서 쓴다. */
  ready?: () => void;
  /**
   * 로그를 터미널에도 낼지이다. 기본은 true (포그라운드 구동).
   * 분리된 데몬(daemon/entry.ts)은 false 이다. 출력이 곧 로그 파일로 이어져 있어 같은 줄이 두 번 남지 않도록 한다.
   */
  console?: boolean;
}

/** 로그에 이미 남긴 구동 실패이다. 호출자가 같은 오류를 다시 적지 않도록 `wasLogged` 로 확인한다. */
const loggedFailures = new WeakSet<object>();

/** `runForeground` 가 던진 오류를 이미 로그에 남겼는지 본다. (설정을 읽기 전이나 로그를 열기 전의 실패는 남기지 못한다) */
export function wasLogged(error: unknown): boolean {
  return typeof error === "object" && error !== null && loggedFailures.has(error);
}

/**
 * 포그라운드로 구동한다. 설정 오류나 잠금 실패가 있으면 StartupError 를 던진다.
 * SIGINT 와 SIGTERM 을 받으면 정상 종료 절차를 밟고 돌려준다.
 */
export async function runForeground(installDir: string, options?: ForegroundOptions): Promise<void> {
  const { config, warnings } = loadConfig(installDir);
  let logger: Logger | null = null;
  let server: Server | null = null;
  let shutdown: { promise: Promise<void>; cancel(): void } | undefined;
  try {
    logger = createLogger({ level: config.log.level, dir: config.log.dir, foreground: options?.console ?? true });
    for (const warning of warnings) {
      logger.warn(warning);
    }
    server = new Server(config, logger);
    await server.start();
    shutdown = waitForShutdownSignal(logger);
    options?.ready?.();

    // 종료 신호(SIGINT, SIGTERM)나 로컬 전용 채널의 종료 요청(`hwdb stop`) 중 먼저 오는 것으로 종료 절차를 시작한다.
    // Windows 에서는 다른 프로세스가 보낸 SIGTERM 을 받을 수 없으므로 종료 요청이 기본 경로이다.
    // 둘이 겹쳐도 Server.stop 이 한 번만 실행한다.
    await Promise.race([shutdown.promise, server.stopRequested]);
  } catch (error) {
    if (logger !== null) {
      try {
        logger.error(describeStartupFailure(error));
        if (typeof error === "object" && error !== null) loggedFailures.add(error);
      } catch { /* 로그 오류로 최초 실패를 가리지 않는다. */ }
    }
    throw error;
  } finally {
    shutdown?.cancel();
    try { await server?.stop(); } finally { await logger?.close(); }
  }
}

/**
 * 정상 종료 절차(`runForeground` 가 돌아온 뒤)를 마친 프로세스를 끝낸다.
 * 접속한 클라이언트가 소켓을 읽지 않거나 닫지 않으면(멈춘 프로그램, 일시 정지된 디버거 등) 서버 쪽 소켓의 닫기가 끝나지 않을 수 있다.
 * 특히 Windows 의 네임드 파이프는 상대가 읽을 때까지 닫기가 끝나지 않아 이벤트 루프가 비지 않는다.
 * 데이터 파일 반영과 정상 종료 표시, 잠금 파일 제거는 이미 끝났으므로 `hwdb stop` 이 기다리는 프로세스가 남지 않도록 직접 끝낸다.
 * 표준 출력과 표준 오류에 남은 출력을 내보낸 뒤에 끝낸다. (파이프로 이어진 출력이 잘리지 않도록)
 */
export async function exitAfterShutdown(code: number): Promise<never> {
  const flush = (stream: NodeJS.WriteStream): Promise<void> =>
    new Promise((resolve) => {
      try {
        if (stream.writableLength === 0) resolve();
        else stream.write("", () => resolve());
      } catch {
        resolve();
      }
    });
  await Promise.race([Promise.all([flush(process.stdout), flush(process.stderr)]), new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
  process.exit(code);
}

/** 종료 신호가 올 때까지 기다린다. 신호가 오면 한 번만 종료 절차를 시작한다. */
function waitForShutdownSignal(logger: Logger): { promise: Promise<void>; cancel(): void } {
  let cancel = (): void => {};
  const promise = new Promise<void>((resolve) => {
    let settled = false;
    // 신호 대기만으로는 이벤트 루프가 비어 프로세스가 바로 끝나므로,
    // 종료될 때까지 루프를 붙잡는 타이머를 둔다.
    const keepAlive = setInterval(() => {}, 60_000);
    const onInterrupt = (): void => onSignal("SIGINT");
    const onTerminate = (): void => onSignal("SIGTERM");
    cancel = (): void => {
      clearInterval(keepAlive);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    };
    const onSignal = (signal: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      cancel();
      try { logger.info(`Received ${signal}; shutting down.`); }
      catch { /* 로그가 실패해도 종료 대기를 반드시 풀고 자원을 정리한다. */ }
      resolve();
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
  });
  return { promise, cancel: () => cancel() };
}

/** 구동 실패를 로그와 화면에 남길 한 줄 영문 설명으로 바꾼다. */
function describeStartupFailure(error: unknown): string {
  if (error instanceof StartupError) {
    return `Startup failed: ${error.message}`;
  }
  if (error instanceof Error) {
    return `Startup failed: ${error.message}`;
  }
  return "Startup failed: unknown error.";
}
