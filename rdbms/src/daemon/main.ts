/**
 * 데몬 프로세스의 진입점.
 *
 * 담당
 *  - `hwdb start` 가 분리된 프로세스로 띄우는 시작점이다.
 *    `--foreground` 일 때는 CLI 프로세스 안에서 같은 절차를 그대로 실행한다.
 *  - 설정 읽기(config/config.ts) → 데몬 본체 구동(server.ts) → 구동 완료를 `hwdb start` 에 알림
 *  - SIGINT, SIGTERM 을 받으면 정상 종료 절차를 시작한다.
 *    Windows 에서는 다른 프로세스가 보낸 SIGTERM 을 받을 수 없으므로,
 *    데몬의 정상 종료는 로컬 전용 채널의 종료 요청(`hwdb stop`)이 기본 경로이다.
 *  - 처리되지 않은 오류의 마지막 처리, 로그 기록, 프로세스 종료 코드
 *
 * 여기에 두지 않는 것 : 구동과 종료의 세부 순서 (server.ts)
 *
 * 관련 사양 : AGENTS.md 상세 12, 14-1
 * 구현 단계 : 1단계(포그라운드 구동), 10단계(분리된 프로세스로 구동)
 */

import { loadConfig } from "../config/config.js";
import { StartupError } from "../common/errors.js";
import { createLogger } from "../common/logger.js";
import type { Logger } from "../common/logger.js";
import { Server } from "./server.js";

export interface ForegroundOptions {
  /** 구동 완료를 알리기 전에 기다리는 일. 10단계의 분리 구동에서 쓴다. 지금은 쓰지 않는다. */
  ready?: () => void;
}

/**
 * 포그라운드로 구동한다. 설정 오류나 잠금 실패가 있으면 StartupError 를 던진다.
 * SIGINT 와 SIGTERM 을 받으면 정상 종료 절차를 밟고 돌려준다.
 */
export async function runForeground(installDir: string, options?: ForegroundOptions): Promise<void> {
  const { config, warnings } = loadConfig(installDir);
  let logger: Logger | null = null;
  try {
    logger = createLogger({ level: config.log.level, dir: config.log.dir, foreground: true });
    for (const warning of warnings) {
      logger.warn(warning);
    }
    const server = new Server(config, logger);
    await server.start();
    options?.ready?.();

    await waitForShutdownSignal(server, logger);
    await server.stop();
    await logger.close();
    logger = null;
  } catch (error) {
    if (logger !== null) {
      logger.error(describeStartupFailure(error));
      await logger.close();
    }
    throw error;
  }
}

/** 종료 신호가 올 때까지 기다린다. 신호가 오면 한 번만 종료 절차를 시작한다. */
function waitForShutdownSignal(server: Server, logger: Logger): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    // 신호 대기만으로는 이벤트 루프가 비어 프로세스가 바로 끝나므로,
    // 종료될 때까지 루프를 붙잡는 타이머를 둔다.
    const keepAlive = setInterval(() => {}, 60_000);
    const onSignal = (signal: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(keepAlive);
      logger.info(`Received ${signal}; shutting down.`);
      resolve();
    };
    process.once("SIGINT", () => {
      onSignal("SIGINT");
    });
    process.once("SIGTERM", () => {
      onSignal("SIGTERM");
    });
    // 신호 외에 서버가 먼저 멈추는 경우는 1단계에 없으므로 신호만 기다린다.
    void server;
  });
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
