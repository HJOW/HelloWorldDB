/**
 * 데몬 본체. 구성 요소를 조립하고 구동과 종료의 순서를 책임진다.
 *
 * 담당
 *  - 구동 순서 : 잠금 파일 확보(lockFile.ts) → SYSTEM 테이블스페이스 열기 (최초 구동이면 생성)
 *               → 나머지 테이블스페이스 열기 → 로컬 전용 채널, TCP, UDP 열기 → 접속 받기 시작
 *  - 정상 종료 순서 : 새 접속 차단 → 진행 중인 트랜잭션 롤백 → 데이터 파일 반영
 *                    → 헤더에 정상 종료 표시 기록 → 잠금 파일 제거
 *  - 비정상 종료 뒤의 구동이면 이를 감지하여 경고 로그를 남긴다. 자동 복구는 하지 않는다.
 *  - 상태 조회에 답할 정보를 모아 준다 : 구동 시각, 포트 번호, 세션 수 등
 *
 * 구성 요소(저장 엔진, 카탈로그, 세션, 통신)는 이 파일에서만 서로 연결한다.
 *
 * 관련 사양 : AGENTS.md 상세 3, 9, 12, 14-1
 * 구현 단계 : 1단계(구동과 종료의 뼈대). 이후 단계마다 구성 요소가 붙는다.
 * 1단계에서는 잠금 파일 확보와 해제, 상태 정보까지만 동작한다.
 * 저장 엔진(2단계)과 통신(9단계)이 붙으면 구동과 종료 순서에 끼워 넣는다.
 */

import type { ResolvedConfig } from "../config/config.js";
import { StartupError } from "../common/errors.js";
import { RDBMS_VERSION } from "../common/instance.js";
import type { Logger } from "../common/logger.js";
import { acquireLock, readLockFile, releaseLock } from "./lockFile.js";

/** 상태 조회에 답할 정보이다. 세션 수는 통신(9단계)이 붙기 전에는 0이다. */
export interface ServerStatus {
  running: boolean;
  port: number;
  pid: number;
  startedAt: string;
  version: string;
  dataDir: string;
  tcpEnabled: boolean;
  udpEnabled: boolean;
  sessionCount: number;
}

/**
 * 1단계의 데몬 본체.
 * 잠금 파일을 잡고 살아 있는 동안 점유한다. 통신과 저장 엔진은 이후 단계에서 붙는다.
 */
export class Server {
  private readonly config: ResolvedConfig;
  private readonly logger: Logger;
  private running = false;
  private startedAt = "";

  constructor(config: ResolvedConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /** 구동 순서의 1단계 뼈대 : 잠금 파일 확보와 기동 로그. */
  async start(): Promise<void> {
    if (this.running) {
      throw new StartupError("Server is already running.");
    }
    // 비정상 종료로 남은 잠금 파일이 있으면 PID 로 판정한다.
    // PID 의 프로세스가 없으면 acquireLock 이 덮어쓰고, 살아 있으면 구동에 실패한다.
    const stale = readLockFile(this.config.dataDir);
    if (stale !== null) {
      this.logger.warn(
        `Found a previous lock file (pid ${String(stale.pid)}, started at ${stale.startedAt}).`,
      );
    }
    const lock = acquireLock(this.config.dataDir, this.config.port);
    this.startedAt = lock.startedAt;
    this.running = true;
    this.logger.info(
      `Server started. port=${String(this.config.port)} pid=${String(lock.pid)} dataDir="${this.config.dataDir}"`,
    );
    this.logger.info(
      `Listening: local-channel=always tcp=${this.config.tcp.enabled ? "on" : "off"} udp=${this.config.udp.enabled ? "on" : "off"}`,
    );
  }

  /**
   * 정상 종료 순서의 1단계 뼈대.
   * 새 접속 차단, 트랜잭션 롤백, 파일 반영은 이후 단계의 구성 요소가 붙으면 여기서 호출한다.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.logger.info("Shutting down the server.");
    // 2단계 이후 : 새 접속 차단 → 진행 중인 트랜잭션 롤백 → 데이터 파일 반영(fsync)
    //            → 헤더에 정상 종료 표시 기록.
    // 1단계에서는 점유한 잠금 파일만 해제한다.
    releaseLock(this.config.dataDir);
    this.running = false;
    this.logger.info("Server stopped.");
  }

  /** 상태 조회에 답할 정보를 모아 준다. */
  getStatus(): ServerStatus {
    return {
      running: this.running,
      port: this.config.port,
      pid: process.pid,
      startedAt: this.startedAt,
      version: RDBMS_VERSION,
      dataDir: this.config.dataDir,
      tcpEnabled: this.config.tcp.enabled,
      udpEnabled: this.config.udp.enabled,
      sessionCount: 0,
    };
  }

  /** 구동 중인지 확인한다. */
  isRunning(): boolean {
    return this.running;
  }
}
