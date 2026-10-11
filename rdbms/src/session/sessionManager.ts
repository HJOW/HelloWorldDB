/**
 * 세션 관리.
 *
 * 담당
 *  - 세션의 생성과 종료, 세션 목록 (SYS_SESSIONS 와 상태 조회에 쓴다)
 *  - 접속 수 제한 : TCP, UDP 세션 수가 `maxConnections` 에 이르면 새 TCP, UDP 접속을 거부한다.
 *    로컬 전용 채널의 세션은 세지 않는다.
 *  - 로컬 접속 판정 : 로컬 전용 채널로 들어왔거나, TCP 나 UDP 로 루프백 주소에서 들어온 접속
 *  - CONNECT 검사 : CONNECT 권한 그룹이 없는 사용자는 로컬 접속만 받는다. 로그인 시점에 판정한다.
 *  - 유휴 세션 종료 (`session.idleTimeoutMs`)
 *  - 세션이 끝날 때 커밋하지 않은 변경을 롤백한다.
 *  - 정상 종료 절차에서 새 접속을 막고 모든 세션을 끝낸다.
 *
 * 7단계에서는 목록, 유휴 세션 종료, 전체 종료까지 맡는다. 접속 수 제한과 로컬 판정, CONNECT 검사는
 * 접속 경로(통신)가 생기는 9단계에서 붙인다. 세션이 끝날 때의 롤백은 Session.close 가 한다.
 *
 * 관련 사양 : AGENTS.md 상세 6, 7, 8, 9, 12
 * 구현 단계 : 7단계(세션 목록), 9단계(접속 수 제한, 로컬 판정)
 */

import type { Session, SessionCloseReason } from "./session.js";

/** 세션 하나의 현황이다. 상태 조회와 SYS_SESSIONS 에 쓴다. */
export interface SessionInfo {
  id: number;
  user: string;
  tablespace: string;
  autocommit: boolean;
  inTransaction: boolean;
  connectedAt: number;
  lastActivity: number;
}

export class SessionManager {
  private readonly sessions = new Map<number, Session>();
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private accepting = true;

  /** idleTimeoutMs 가 0 이면 유휴 세션을 닫지 않는다. */
  constructor(private readonly idleTimeoutMs: number) {}

  /** 새 세션 번호이다. */
  nextId(): number {
    this.seq++;
    return this.seq;
  }

  /** 새 세션을 목록에 넣는다. 받아도 되는지는 호출자가 isAccepting 으로 먼저 확인한다. */
  add(session: Session): void {
    this.sessions.set(session.id, session);
    if (this.idleTimeoutMs > 0 && this.timer === null) {
      const period = Math.max(10, Math.min(1000, Math.floor(this.idleTimeoutMs / 2)));
      this.timer = setInterval(() => this.sweepIdle(), period);
      this.timer.unref();
    }
  }

  /** 닫힌 세션을 목록에서 뺀다. */
  remove(session: Session): void {
    this.sessions.delete(session.id);
  }

  get count(): number {
    return this.sessions.size;
  }

  /** 새 세션을 받을 수 있는 상태인지 본다. 종료 절차에서는 false 이다. */
  get isAccepting(): boolean {
    return this.accepting;
  }

  /** 세션 현황을 번호 순서로 돌려준다. */
  list(): SessionInfo[] {
    return [...this.sessions.values()]
      .sort((left, right) => left.id - right.id)
      .map((session) => ({
        id: session.id,
        user: session.user,
        tablespace: session.currentTablespace,
        autocommit: session.autocommit,
        inTransaction: session.inTransaction,
        connectedAt: session.connectedAt,
        lastActivity: session.lastActivity,
      }));
  }

  /**
   * 문장을 실행하고 있지 않은 채 idleTimeoutMs 를 넘긴 세션을 닫는다.
   * 닫힌 세션의 커밋하지 않은 변경은 롤백된다. 닫은 세션 수를 돌려준다.
   */
  sweepIdle(now: number = Date.now()): number {
    if (this.idleTimeoutMs <= 0) return 0;
    let closed = 0;
    for (const session of [...this.sessions.values()]) {
      if (session.isIdle && now - session.lastActivity >= this.idleTimeoutMs) {
        session.close("idle");
        closed++;
      }
    }
    return closed;
  }

  /** 새 세션 받기를 멈추고 모든 세션을 끝낸다. 커밋하지 않은 변경은 롤백된다. */
  closeAll(reason: SessionCloseReason = "shutdown"): void {
    this.accepting = false;
    for (const session of [...this.sessions.values()]) {
      session.close(reason);
    }
  }

  /** 유휴 검사 타이머를 멈춘다. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
