/**
 * 잠금 관리.
 *
 * 담당
 *  - 행 단위 잠금 : 같은 행을 변경하려는 트랜잭션끼리 순서를 정한다. 커밋이나 롤백 때까지 유지한다.
 *  - SELECT ... FOR UPDATE 의 잠금
 *  - 잠금 대기와 제한 시간 (`transaction.lockTimeoutMs`). 넘으면 그 문장을 오류로 끝낸다.
 *  - 교착 감지 : 서로 기다리는 고리를 찾으면 고리를 닫은 대기자의 트랜잭션을 롤백시킨다.
 *  - DDL 과 진행 중인 트랜잭션이 같은 객체에서 만났을 때를 위한 객체 단위 잠금
 *
 * 조회는 잠금을 기다리지 않는다. (FOR UPDATE 제외)
 * 잠금은 전부 배타 잠금이다. 같은 소유자가 다시 걸면 허용한다.
 * 잠금 종류(키의 첫 글자)
 *  - `R` 행 잠금 : 저장된 행 하나. 갱신, 삭제, FOR UPDATE 가 건다.
 *  - `K` PK 잠금 : PK 값 하나. 같은 PK 를 넣거나 바꾸려는 트랜잭션끼리 순서를 정한다.
 *  - `O` 객체 잠금 : 테이블 하나. DDL 이 건다. 같은 테이블의 행·PK 잠금과 서로 충돌한다.
 *
 * 동기 실행(`Session.execute`)은 기다리지 않고 즉시 55P03 으로 알리고,
 * 비동기 실행(`Session.executeAsync`)은 제한 시각까지 기다렸다가 문장을 다시 시도한다.
 *
 * 관련 사양 : AGENTS.md 상세 7, 10
 * 구현 단계 : 2단계(저장 엔진과 함께 설계), 7단계(구현)
 */

import { DbError, ERROR_CODES } from "../common/errors.js";
import { objectKey } from "../common/objectKey.js";
import type { RowId } from "../storage/format/format.js";

/** 잠금의 소유자이다. 트랜잭션 번호이며, DDL 문장도 자기 번호를 받는다. */
export type LockOwner = number;

/** 키 안의 구분자이다. 식별자 안의 같은 제어 문자는 objectKey에서 이스케이프한다. */
const SEP = "\u001f";

/** 행 잠금 키이다. */
export function rowLockKey(tablespace: string, table: string, id: RowId): string {
  return `R${SEP}${objectKey(tablespace, table)}${SEP}${id.pageId}:${id.slotId}`;
}

/** PK 잠금 키이다. 같은 PK 값을 넣으려는 트랜잭션끼리 순서가 정해진다. */
export function pkLockKey(tablespace: string, table: string, keyHex: string): string {
  return `K${SEP}${objectKey(tablespace, table)}${SEP}${keyHex}`;
}

/** 객체 잠금 키이다. DDL 이 같은 객체의 행 잠금과 충돌한다. */
export function objectLockKey(tablespace: string, table: string): string {
  return `O${SEP}${objectKey(tablespace, table)}`;
}

/** 잠금 키가 속한 객체 범위(테이블스페이스와 테이블)이다. */
function lockScope(key: string): string {
  return key.split(SEP)[1]!;
}

function isObjectKey(key: string): boolean {
  return key.startsWith(`O${SEP}`);
}

/** 사람이 읽는 잠금 설명이다. 오류 메시지에 쓴다. */
function describeKey(key: string): string {
  const parts = key.split(SEP);
  const [tablespace, table] = JSON.parse(parts[1]!) as [string, string];
  const target = `${tablespace}.${table}`;
  if (parts[0] === "R") return `row ${parts[2] ?? ""} of "${target}"`;
  if (parts[0] === "K") return `primary key of "${target}"`;
  return `object "${target}"`;
}

/** 잠금 충돌 오류이다. 비동기 실행이 기다렸다가 다시 시도할 키를 가진다. */
export interface LockConflictError extends DbError {
  conflictKey: string;
}

/** 잠금 충돌 오류를 만든다. SQLSTATE 55P03. 메시지는 영문으로 적는다. */
export function lockConflict(key: string): LockConflictError {
  const error = new DbError("55P03", ERROR_CODES.LOCK_TIMEOUT, `Could not acquire lock on ${describeKey(key)}.`);
  (error as LockConflictError).conflictKey = key;
  return error as LockConflictError;
}

/** 값이 잠금 충돌 오류인지 확인한다. */
export function isLockConflict(value: unknown): value is LockConflictError {
  return (
    value instanceof DbError &&
    value.sqlState === "55P03" &&
    typeof (value as { conflictKey?: unknown }).conflictKey === "string"
  );
}

/** 잠금 대기 제한 시간 초과 오류를 만든다. SQLSTATE 55P03. */
export function lockTimeout(): DbError {
  return new DbError("55P03", ERROR_CODES.LOCK_TIMEOUT, "Lock wait timeout exceeded.");
}

/** 교착 상태 오류를 만든다. 호출자가 대기자의 트랜잭션을 롤백한다. SQLSTATE 40P01. */
export function deadlock(): DbError {
  return new DbError("40P01", ERROR_CODES.DEADLOCK_DETECTED, "Deadlock detected; transaction is rolled back.");
}

/** 세션이 닫혀 대기가 취소되었을 때의 오류이다. SQLSTATE 08003. */
export function sessionClosed(): DbError {
  return new DbError("08003", ERROR_CODES.SESSION_CLOSED, "Session is closed.");
}

/** 잠금을 걸어 주는 쪽이 갖추어야 할 최소 인터페이스이다. 실행기는 이것만 안다. */
export interface LockSink {
  /** 키들을 전부 걸거나, 충돌하면 하나도 걸지 않고 충돌한 키를 알린다. */
  tryAcquireAll(owner: LockOwner, keys: readonly string[]): { ok: true } | { ok: false; key: string };
}

interface Waiter {
  owner: LockOwner;
  key: string;
  resolve: () => void;
  reject: (error: DbError) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * 잠금 관리자이다. 데이터베이스가 하나 들고 모든 세션이 함께 쓴다.
 * 한 세션의 문장은 동기적으로 실행되므로, 대기는 문장 단위 재시도로 푼다.
 * 대기 그래프에 고리가 생기면 고리를 닫은 대기자를 교착 상태로 알린다.
 */
export class LockManager implements LockSink {
  private readonly holders = new Map<string, LockOwner>();
  private readonly owned = new Map<LockOwner, Set<string>>();
  /** 범위별로 행·PK 잠금을 가진 소유자와 그 수이다. 객체 잠금과의 충돌을 빠르게 찾는다. */
  private readonly rowOwners = new Map<string, Map<LockOwner, number>>();
  private readonly queues = new Map<string, Waiter[]>();
  private readonly waitingOn = new Map<LockOwner, string>();

  /** 지금 걸려 있는 잠금 수이다. 테스트와 진단에 쓴다. */
  get lockCount(): number {
    return this.holders.size;
  }

  /** 소유자가 가진 잠금 수이다. */
  countOf(owner: LockOwner): number {
    return this.owned.get(owner)?.size ?? 0;
  }

  /** 기다리고 있는 소유자 수이다. */
  get waiterCount(): number {
    return this.waitingOn.size;
  }

  /** 다른 소유자와 충돌하는 보유자를 모은다. 없으면 빈 집합이다. */
  private conflictHolders(owner: LockOwner, key: string): Set<LockOwner> {
    const result = new Set<LockOwner>();
    const held = this.holders.get(key);
    if (held !== undefined && held !== owner) result.add(held);
    const scope = lockScope(key);
    if (isObjectKey(key)) {
      const rows = this.rowOwners.get(scope);
      if (rows !== undefined) {
        for (const other of rows.keys()) {
          if (other !== owner) result.add(other);
        }
      }
    } else {
      const object = this.holders.get(`O${SEP}${scope}`);
      if (object !== undefined && object !== owner) result.add(object);
    }
    return result;
  }

  private grant(owner: LockOwner, key: string): void {
    let keys = this.owned.get(owner);
    if (keys === undefined) {
      keys = new Set();
      this.owned.set(owner, keys);
    }
    if (keys.has(key)) return;
    keys.add(key);
    this.holders.set(key, owner);
    if (!isObjectKey(key)) {
      const scope = lockScope(key);
      let counts = this.rowOwners.get(scope);
      if (counts === undefined) {
        counts = new Map();
        this.rowOwners.set(scope, counts);
      }
      counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
  }

  /**
   * 키들을 전부 걸거나 하나도 걸지 않는다.
   * 충돌하면 아무것도 걸지 않고 충돌한 키를 알린다.
   */
  tryAcquireAll(owner: LockOwner, keys: readonly string[]): { ok: true } | { ok: false; key: string } {
    const unique = [...new Set(keys)];
    for (const key of unique) {
      if (this.conflictHolders(owner, key).size > 0) return { ok: false, key };
    }
    for (const key of unique) this.grant(owner, key);
    return { ok: true };
  }

  /**
   * 키가 비워질 때까지 기다렸다가 건다. 제한 시각을 넘기면 55P03, 고리가 생기면 40P01 로 거부한다.
   * 먼저 한 번 걸어 보고, 안 되면 대기열에 든다.
   */
  waitFor(owner: LockOwner, key: string, deadlineEpochMs: number): Promise<void> {
    if (this.conflictHolders(owner, key).size === 0) {
      this.grant(owner, key);
      return Promise.resolve();
    }
    if (Date.now() >= deadlineEpochMs) return Promise.reject(lockTimeout());
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { owner, key, resolve, reject, timer: null };
      const queue = this.queues.get(key) ?? [];
      queue.push(waiter);
      this.queues.set(key, queue);
      this.waitingOn.set(owner, key);
      if (this.hasCycle(owner)) {
        this.removeWaiter(waiter);
        reject(deadlock());
        return;
      }
      waiter.timer = setTimeout(() => {
        waiter.timer = null;
        this.removeWaiter(waiter);
        reject(lockTimeout());
      }, Math.max(0, deadlineEpochMs - Date.now()));
    });
  }

  /** 소유자가 가진 잠금을 전부 풀고, 풀린 잠금을 기다리던 쪽에 넘긴다. */
  releaseAll(owner: LockOwner): void {
    const keys = this.owned.get(owner);
    if (keys === undefined) return;
    this.owned.delete(owner);
    for (const key of keys) {
      this.holders.delete(key);
      if (!isObjectKey(key)) {
        const scope = lockScope(key);
        const counts = this.rowOwners.get(scope);
        if (counts !== undefined) {
          const left = (counts.get(owner) ?? 1) - 1;
          if (left <= 0) counts.delete(owner);
          else counts.set(owner, left);
          if (counts.size === 0) this.rowOwners.delete(scope);
        }
      }
    }
    this.pump();
  }

  /** 소유자의 대기를 취소하고 기다리던 쪽에 오류를 알린다. 세션을 닫을 때 쓴다. */
  cancelWait(owner: LockOwner, error: DbError = sessionClosed()): void {
    for (const queue of [...this.queues.values()]) {
      for (const waiter of [...queue]) {
        if (waiter.owner !== owner) continue;
        this.removeWaiter(waiter);
        waiter.reject(error);
      }
    }
  }

  /** 소유자를 막고 있는 쪽이다. 잠금 보유자와 같은 대기열에서 앞선 대기자를 함께 본다. */
  private blockersOf(owner: LockOwner): Set<LockOwner> {
    const key = this.waitingOn.get(owner);
    if (key === undefined) return new Set();
    const blockers = this.conflictHolders(owner, key);
    for (const waiter of this.queues.get(key) ?? []) {
      if (waiter.owner === owner) break;
      blockers.add(waiter.owner);
    }
    return blockers;
  }

  /** 대기 그래프에서 시작점으로 돌아오는 고리가 있는지 본다. */
  private hasCycle(start: LockOwner): boolean {
    const seen = new Set<LockOwner>();
    const stack = [...this.blockersOf(start)];
    while (stack.length > 0) {
      const current = stack.pop() as LockOwner;
      if (current === start) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of this.blockersOf(current)) stack.push(next);
    }
    return false;
  }

  private removeWaiter(waiter: Waiter): void {
    if (waiter.timer !== null) {
      clearTimeout(waiter.timer);
      waiter.timer = null;
    }
    const queue = this.queues.get(waiter.key);
    if (queue !== undefined) {
      const kept = queue.filter((entry) => entry !== waiter);
      if (kept.length === 0) this.queues.delete(waiter.key);
      else this.queues.set(waiter.key, kept);
    }
    if (this.waitingOn.get(waiter.owner) === waiter.key) this.waitingOn.delete(waiter.owner);
  }

  /** 풀린 잠금을 기다리는 순서대로 준다. */
  private pump(): void {
    for (const [key, queue] of [...this.queues]) {
      while (queue.length > 0) {
        const head = queue[0] as Waiter;
        if (this.conflictHolders(head.owner, head.key).size > 0) break;
        queue.shift();
        if (queue.length === 0) this.queues.delete(key);
        this.waitingOn.delete(head.owner);
        if (head.timer !== null) {
          clearTimeout(head.timer);
          head.timer = null;
        }
        this.grant(head.owner, head.key);
        head.resolve();
      }
    }
  }
}
