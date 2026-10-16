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
 * 9단계에서 통신을 붙였다.
 *  - 구동 순서 : 잠금 파일 → `Database.open` → **로컬 전용 채널(항상)** → TCP(`tcp.enabled`) → UDP(`udp.enabled`) → 구동 로그.
 *    어느 단계에서 실패하든 이미 연 것은 닫고, 데이터베이스를 닫고, 잠금 파일을 지운다.
 *  - 정상 종료 순서(사양 12) : 새 접속 받기 멈춤(TCP, UDP, 로컬 전용 채널) → `Database.close()`(세션 롤백, 잠금 해제, 정상 종료 표시.
 *    접속마다 57P01 오류가 나간다) → 남은 소켓 닫기(유예 시간 뒤 강제) → 소켓 파일 지우기 → 잠금 파일 제거. 종료 절차는 한 번만 실행한다.
 *  - 제어 창구(`ControlPort`)를 통신 계층에 넘긴다. 상태 조회, 제어 토큰(잠금 파일), 종료 요청이다.
 *    종료 요청(`hwdb stop`)은 `stopRequested` 를 알릴 뿐이고, 종료 절차는 데몬 본체(daemon/main.ts)가 시작한다. (신호와 겹쳐도 한 번만)
 *
 * 관련 사양 : AGENTS.md 상세 3, 6, 7, 8, 9, 12, 14-1, 15
 * 구현 단계 : 1단계(구동과 종료의 뼈대), 9단계(통신 조립). 이후 단계마다 구성 요소가 붙는다.
 */

import { randomBytes } from "node:crypto";
import type { ResolvedConfig } from "../config/config.js";
import { StartupError } from "../common/errors.js";
import { RDBMS_VERSION } from "../common/instance.js";
import type { Logger } from "../common/logger.js";
import { acquireLock, readLockFile, releaseLock } from "./lockFile.js";
import type { LockFileContent } from "./lockFile.js";
import { Database } from "../session/session.js";
import { ConnectionLimits } from "../net/connectionLimits.js";
import { LocalChannelServer } from "../net/localChannelServer.js";
import type { ControlPort, HandlerEnvironment } from "../net/messageHandler.js";
import { TcpServer, isLegacyTlsVersion } from "../net/tcpServer.js";
import { UdpServer } from "../net/udpServer.js";

/** SYSTEM 계정이 초기 암호 그대로일 때 구동 로그에 남기는 경고이다. `hwdb start` 도 같은 내용을 보여 준다. */
export const INITIAL_PASSWORD_WARNING =
  "The SYSTEM account still uses its initial password. Connect with hwdb on this machine and run: ALTER USER SYSTEM IDENTIFIED BY '<new password>'";

/** 상태 조회에 답할 정보이다. 세션 수는 로컬 전용 채널을 포함한 모든 접속 경로의 세션 수이다. */
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
 * 데몬 본체. 잠금 파일을 잡고 살아 있는 동안 점유하며, 데이터베이스와 세 접속 경로를 연다.
 * 5단계부터 SYSTEM 테이블스페이스와 나머지 테이블스페이스를 함께 열고, 9단계부터 접속을 받는다.
 */
export class Server {
  private readonly config: ResolvedConfig;
  private readonly logger: Logger;
  private running = false;
  private startedAt = "";
  private lock: LockFileContent | undefined;
  private database: Database | undefined;
  private localChannel: LocalChannelServer | undefined;
  private tcpServer: TcpServer | undefined;
  private udpServer: UdpServer | undefined;
  private stopPromise: Promise<void> | undefined;
  private stopRequestedResolve: (() => void) | undefined;
  /** `hwdb stop` 요청이 오면 풀리는 약속이다. 종료 절차를 시작하는 것은 이것을 기다리는 데몬 본체(main.ts)이다. */
  readonly stopRequested: Promise<void>;

  constructor(config: ResolvedConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.stopRequested = new Promise<void>((resolve) => {
      this.stopRequestedResolve = resolve;
    });
  }

  /** 구동 순서 : 잠금 파일 확보 → 테이블스페이스 열기 → 접속 대기(9단계). */
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
    this.lock = lock;
    this.startedAt = lock.startedAt;
    this.running = true;
    try {
      // SYSTEM 이 없으면 새로 만들고, 있으면 열어 목록의 나머지를 함께 연다.
      // SYSTEM 이 손상되었으면 구동에 실패한다. 나머지는 사용 불가로 두고 구동한다.
      try {
        this.database = Database.open(this.config.dataDir, {
          onWarning: (message) => this.logger.warn(message),
          timeZone: this.config.timeZone,
          lockTimeoutMs: this.config.transaction.lockTimeoutMs,
          idleTimeoutMs: this.config.session.idleTimeoutMs,
          maxConnections: this.config.maxConnections,
        });
      } catch (error) {
        throw error instanceof StartupError || error instanceof Error
          ? new StartupError(`Cannot open tablespaces: ${error.message}`, { cause: error })
          : error;
      }
      this.logger.info(
        `Server started. port=${String(this.config.port)} pid=${String(lock.pid)} dataDir="${this.config.dataDir}"`,
      );
      // 초기 암호를 바꾸지 않은 채 구동하면 경고를 남긴다. 표준 절차는 서버 장비에서 hwdb 로 접속해 바꾸는 것이다.
      if (this.database.isInitialSystemPassword()) {
        this.logger.warn(INITIAL_PASSWORD_WARNING);
      }
      await this.openTransports(this.database, lock);
    } catch (error) {
      // 이미 연 접속 경로를 닫고, 데이터베이스를 닫고, 잠금 파일을 지운다.
      await this.closeTransports(0);
      try {
        this.database?.close();
      } catch {
        // 닫기 오류는 원래 오류를 가리지 않는다.
      }
      this.database = undefined;
      releaseLock(this.config.dataDir, this.lock);
      this.lock = undefined;
      this.running = false;
      throw error;
    }
  }

  /** 세 접속 경로를 연다. 로컬 전용 채널은 항상, TCP 와 UDP 는 설정에 따라 연다. 열지 못하면 StartupError 이다. */
  private async openTransports(database: Database, lock: LockFileContent): Promise<void> {
    const env: HandlerEnvironment = {
      database,
      control: this.controlPort(lock),
      limits: new ConnectionLimits({ maxConnections: this.config.maxConnections }),
      logger: this.logger,
      // 없는 사용자에게 줄 가짜 SCRAM 검증 정보의 솔트를 정하는 비밀값이다. 구동할 때마다 새로 만든다.
      decoySecret: randomBytes(32),
    };
    const opened: string[] = [];

    this.localChannel = new LocalChannelServer(env, this.config.port);
    await this.localChannel.start();
    opened.push(`local-channel=${this.localChannel.address}`);

    if (this.config.tcp.enabled) {
      const ssl = this.config.tcp.ssl;
      this.tcpServer = new TcpServer(env, {
        host: this.config.tcp.host,
        port: this.config.port,
        ssl: { certPath: ssl.certPath, keyPath: ssl.keyPath, minVersion: ssl.minVersion },
      });
      await this.tcpServer.start();
      const tlsText = this.tcpServer.tlsEnabled
        ? ` (TLS, minimum ${ssl.minVersion}${isLegacyTlsVersion(ssl.minVersion) ? ", legacy versions allowed" : ""})`
        : " (plain)";
      opened.push(`tcp=${this.config.tcp.host}:${this.config.port}${tlsText}`);
    }

    if (this.config.udp.enabled) {
      this.udpServer = new UdpServer(env, {
        host: this.config.udp.host,
        port: this.config.port,
        maxPacketSize: this.config.udp.maxPacketSize,
        sessionTimeoutMs: this.config.udp.sessionTimeoutMs,
      });
      await this.udpServer.start();
      opened.push(
        `udp=${this.config.udp.host}:${this.config.port} (maxPacketSize ${this.config.udp.maxPacketSize}, sessionTimeoutMs ${this.config.udp.sessionTimeoutMs})`,
      );
    }
    this.logger.info(`Listening: ${opened.join(" ")} maxConnections=${this.config.maxConnections}`);
  }

  /** 통신 계층에 넘기는 제어 창구이다. 제어 토큰은 구동할 때 만든 잠금 파일의 값이다. */
  private controlPort(lock: LockFileContent): ControlPort {
    return {
      controlToken: () => lock.controlToken,
      status: () => this.getStatus(),
      requestStop: () => this.requestStop(),
    };
  }

  /** 종료를 요청한다. `stopRequested` 를 풀 뿐이고, 종료 절차는 그것을 기다리는 데몬 본체가 시작한다. */
  requestStop(): void {
    this.stopRequestedResolve?.();
  }

  /** 접속 경로를 정해진 순서로 닫는다. 새 접속 받기를 모두 멈춘 뒤 남은 접속을 닫는다. */
  private async closeTransports(graceMs: number): Promise<void> {
    const transports = [this.tcpServer, this.udpServer, this.localChannel];
    await Promise.all(transports.map(async (transport) => transport?.stopAccepting()));
    await Promise.all(transports.map(async (transport) => transport?.closeConnections(graceMs)));
    this.tcpServer = undefined;
    this.udpServer = undefined;
    this.localChannel = undefined;
  }

  /**
   * 정상 종료 순서 : 새 접속 받기 멈춤 → 진행 중인 트랜잭션 롤백(세션 닫기) → 데이터 파일 반영과 정상 종료 표시 → 남은 소켓 닫기 → 잠금 파일 제거.
   * 한 번만 실행하며, 이미 시작했으면 같은 약속을 돌려준다. (`hwdb stop` 요청과 신호가 겹쳐도 한 번이다)
   */
  stop(): Promise<void> {
    if (!this.running) return Promise.resolve();
    this.stopPromise ??= this.runStop();
    return this.stopPromise;
  }

  private async runStop(): Promise<void> {
    this.logger.info("Shutting down the server.");
    try {
      // 1. 새 접속 받기를 멈춘다. 이미 맺어진 접속(종료를 요청한 접속 포함)은 유지한다.
      await Promise.all([this.tcpServer, this.udpServer, this.localChannel].map(async (transport) => transport?.stopAccepting()));
      // 2~3. Database.close 가 세션을 모두 닫아(커밋하지 않은 변경은 롤백, 잠금 해제) 새 세션을 막은 뒤 테이블스페이스를 닫아
      //      정상 종료 표시를 쓴다. 세션이 닫히며 접속마다 57P01 오류가 나간다.
      try {
        this.database?.close();
      } catch {
        // 닫기 중 하나의 실패가 잠금 해제를 막지 않는다.
      }
      this.database = undefined;
      // 4. 나가는 오류 메시지가 비워지도록 잠깐 기다린 뒤 남은 소켓을 닫는다. (소켓 파일도 지운다)
      await this.closeTransports(2000);
    } finally {
      // 5. 잠금 파일을 지운다.
      releaseLock(this.config.dataDir, this.lock);
      this.lock = undefined;
      this.running = false;
    }
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
      sessionCount: this.database?.sessions.count ?? 0,
    };
  }

  /** 구동 중인 데이터베이스이다. 통신 계층(9단계)이 세션을 만들 때 쓴다. 구동 중이 아니면 undefined 이다. */
  getDatabase(): Database | undefined {
    return this.database;
  }

  /** 구동 중인지 확인한다. */
  isRunning(): boolean {
    return this.running;
  }
}
