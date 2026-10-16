/**
 * 인증 전 접속의 제한.
 *
 * 담당
 *  - 인증을 마치기 전의 접속 수 제한 : 동시에 `max(16, 2 × maxConnections)` 개까지. 넘는 새 TCP, UDP 접속은 바로 닫는다.
 *    인증하지 않는 접속이 폭주해도 정상 사용자의 자리(`maxConnections`)를 차지하지 못하고 서버 자원도 묶이지 않는다.
 *  - 인증 시간 제한(10초)과 인증 실패 뒤의 응답 지연(200 ms)의 값 보관
 *  - 지연 함수 `sleep` : 시험에서 바꿔 끼울 수 있게 한곳에 둔다.
 *
 * 로컬 전용 채널은 이 제한을 받지 않는다. (사양 상세 8, 9, 14)
 * 인증을 마친 세션의 수 제한(`maxConnections`)은 여기가 아니라 `Database.connect` 가 한다.
 *
 * 관련 사양 : AGENTS.md 상세 8, 9
 * 구현 단계 : 9단계 (9-4)
 */

import { AUTH_FAILURE_DELAY_MS, AUTH_TIMEOUT_MS } from "./protocol.js";

export interface ConnectionLimitsOptions {
  /** `config.json` 의 `maxConnections` 이다. 인증 전 접속 수의 상한을 정하는 데 쓴다. */
  maxConnections: number;
  /** 인증 시간 제한(ms). 기본 10,000. */
  authTimeoutMs?: number;
  /** 인증 실패 뒤 응답 전의 지연(ms). 기본 200. */
  authFailureDelayMs?: number;
  /** 인증 전 접속 수의 상한을 직접 정한다. 시험용이다. */
  maxPreAuth?: number;
  /** 지연 함수이다. 시험에서 바꿔 끼운다. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // 서버가 종료되는데 이 타이머 때문에 프로세스가 남지 않게 한다.
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

export class ConnectionLimits {
  readonly maxPreAuth: number;
  readonly authTimeoutMs: number;
  readonly authFailureDelayMs: number;
  private readonly sleepFunction: (ms: number) => Promise<void>;
  private preAuth = 0;

  constructor(options: ConnectionLimitsOptions) {
    const finite = Number.isFinite(options.maxConnections);
    this.maxPreAuth = options.maxPreAuth ?? (finite ? Math.max(16, 2 * options.maxConnections) : 1024);
    this.authTimeoutMs = options.authTimeoutMs ?? AUTH_TIMEOUT_MS;
    this.authFailureDelayMs = options.authFailureDelayMs ?? AUTH_FAILURE_DELAY_MS;
    this.sleepFunction = options.sleep ?? defaultSleep;
  }

  /** 지금 인증 전인 접속의 수이다. */
  get preAuthCount(): number {
    return this.preAuth;
  }

  /**
   * 인증 전 접속 한 자리를 얻는다. 가득 찼으면 null 이다.
   * 돌려받은 함수로 자리를 반납한다. 여러 번 불러도 한 번만 반납된다.
   */
  tryAcquirePreAuth(): (() => void) | null {
    if (this.preAuth >= this.maxPreAuth) return null;
    this.preAuth++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.preAuth--;
    };
  }

  sleep(ms: number): Promise<void> {
    return this.sleepFunction(ms);
  }
}
