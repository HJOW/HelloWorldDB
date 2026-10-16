/**
 * 커넥션 풀.
 *
 * 담당
 *  - 접속을 `max` 개까지 만들어 두고 빌려주고(`acquire`) 돌려받는다(`Connection.release`). 모자라면 빌릴 때까지 줄 서서 기다린다.
 *  - 돌려받은 접속은 로그인 직후의 상태로 되돌린다 : 커밋하지 않은 트랜잭션은 롤백하고, 바꾼 자동 커밋 상태는 되돌린다.
 *    되돌리지 못하면(접속이 끊겼다 등) 그 접속은 버린다.
 *  - 끊긴 접속(서버가 유휴 시간 초과로 끊거나 서버가 내려간 경우)은 풀에서 빠지고, 빌릴 때 새로 만든다.
 *  - 오래 놀린 접속(`idleTimeoutMs`)과 너무 오래 쓴 접속(`maxLifetimeMs`)을 닫는다.
 *  - 편의 함수 : `query`, `withConnection`, `transaction`. 빌리고 돌려주는 일을 알아서 한다.
 *
 * 서버의 동시 접속 상한(`maxConnections`, 기본 10)은 TCP 와 UDP 의 세션을 합친 것이다. 풀의 `max` 기본값은 이보다 작은 5 이다.
 *
 * 관련 사양 : AGENTS.md 구현 계획 12 (커넥션 풀), 상세 9
 * 구현 단계 : 12-3
 */

import { DbError, ERROR_CODES } from "./errors.js";
import { Connection } from "./connection.js";
import type { ConnectOptions, QueryOptions, QueryResult } from "./connection.js";
import type { Param } from "./values.js";

export interface PoolOptions extends ConnectOptions {
  /** 동시에 열어 둘 접속의 최대 수이다. 기본 5. */
  max?: number;
  /** 놀고 있는 접속을 닫기까지의 시간(ms)이다. 기본 30,000. 0 이면 닫지 않는다. */
  idleTimeoutMs?: number;
  /** 접속을 빌리려고 기다리는 제한 시간(ms)이다. 기본 30,000. 0 이면 끝까지 기다린다. */
  acquireTimeoutMs?: number;
  /** 접속 하나를 쓸 수 있는 최대 시간(ms)이다. 넘은 접속은 돌려받을 때 닫는다. 기본 0(제한 없음). */
  maxLifetimeMs?: number;
}

export interface PoolStats {
  /** 지금 열려 있는(만드는 중인 것 포함) 접속의 수이다. */
  total: number;
  /** 놀고 있는 접속의 수이다. */
  idle: number;
  /** 빌려 간 접속의 수이다. */
  active: number;
  /** 접속을 빌리려고 기다리는 요청의 수이다. */
  waiting: number;
}

interface Waiter {
  resolve(connection: Connection): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

interface IdleEntry {
  connection: Connection;
  since: number;
}

export class Pool {
  private readonly max: number;
  private readonly idleTimeoutMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly maxLifetimeMs: number;
  private readonly connectOptions: ConnectOptions;
  private readonly idle: IdleEntry[] = [];
  private readonly active = new Set<Connection>();
  /** 돌려받아 상태를 되돌리는 중인 접속이다. */
  private readonly releasing = new Set<Connection>();
  private readonly createdAt = new WeakMap<Connection, number>();
  private readonly waiters: Waiter[] = [];
  private creating = 0;
  private closing = false;
  private reaper: ReturnType<typeof setInterval> | null = null;
  private drained: Array<() => void> = [];

  constructor(options: PoolOptions) {
    const { max, idleTimeoutMs, acquireTimeoutMs, maxLifetimeMs, ...connectOptions } = options;
    this.max = max ?? 5;
    this.idleTimeoutMs = idleTimeoutMs ?? 30_000;
    this.acquireTimeoutMs = acquireTimeoutMs ?? 30_000;
    this.maxLifetimeMs = maxLifetimeMs ?? 0;
    if (!Number.isInteger(this.max) || this.max < 1) throw new RangeError("max must be an integer of 1 or more.");
    for (const [name, value] of [["idleTimeoutMs", this.idleTimeoutMs], ["acquireTimeoutMs", this.acquireTimeoutMs], ["maxLifetimeMs", this.maxLifetimeMs]] as const) {
      if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be 0 or more.`);
    }
    this.connectOptions = connectOptions;
  }

  get stats(): PoolStats {
    return { total: this.total(), idle: this.idle.length, active: this.active.size, waiting: this.waiters.length };
  }

  private total(): number {
    return this.idle.length + this.active.size + this.releasing.size + this.creating;
  }

  // -------------------------------------------------------------------------
  // 빌리기
  // -------------------------------------------------------------------------

  /**
   * 접속 하나를 빌린다. 다 쓰면 `connection.release()` 로 돌려준다. 돌려주지 않으면 풀이 그 접속을 영영 쓰지 못한다.
   * 빌릴 접속이 없고 `max` 에 이르렀으면 돌려받을 때까지 기다리고, `acquireTimeoutMs` 를 넘으면 53300 으로 실패한다.
   */
  acquire(): Promise<Connection> {
    if (this.closing) return Promise.reject(new DbError("08003", ERROR_CODES.CONNECTION_FAILURE, "The pool is closed."));
    return new Promise<Connection>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: null, done: false };
      if (this.acquireTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          if (waiter.done) return;
          waiter.done = true;
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new DbError("53300", ERROR_CODES.TOO_MANY_CONNECTIONS, `Timed out after ${this.acquireTimeoutMs} ms waiting for a free connection (pool max ${this.max}).`));
        }, this.acquireTimeoutMs);
      }
      this.waiters.push(waiter);
      this.dispatch();
    });
  }

  /** 기다리는 요청에 접속을 나눠 준다. 놀고 있는 접속이 있으면 그것을, 없고 여유가 있으면 새로 만들어서. */
  private dispatch(): void {
    while (this.waiters.length > 0 && !this.closing) {
      const connection = this.takeIdle();
      if (connection !== null) {
        this.handOut(connection, this.waiters.shift() as Waiter);
        continue;
      }
      if (this.total() >= this.max) break;
      const waiter = this.waiters.shift() as Waiter;
      this.creating++;
      Connection.connect(this.connectOptions).then(
        (created) => {
          this.creating--;
          this.createdAt.set(created, Date.now());
          created.on("close", () => this.forget(created));
          if (waiter.done || this.closing) {
            // 기다리던 요청이 이미 포기했거나 풀이 닫혔다.
            if (this.closing) created.destroy();
            else this.keepIdle(created);
            this.settle();
            return;
          }
          this.handOut(created, waiter);
        },
        (error: unknown) => {
          this.creating--;
          if (!waiter.done) {
            waiter.done = true;
            if (waiter.timer !== null) clearTimeout(waiter.timer);
            waiter.reject(error as Error);
          }
          this.dispatch();
          this.settle();
        },
      );
    }
  }

  private takeIdle(): Connection | null {
    while (this.idle.length > 0) {
      const entry = this.idle.pop() as IdleEntry;
      const connection = entry.connection;
      if (connection.isClosed) continue;
      if (this.maxLifetimeMs > 0 && Date.now() - (this.createdAt.get(connection) ?? 0) > this.maxLifetimeMs) {
        connection.destroy();
        continue;
      }
      return connection;
    }
    return null;
  }

  private handOut(connection: Connection, waiter: Waiter): void {
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    waiter.done = true;
    this.active.add(connection);
    connection._lease(() => this.giveBack(connection));
    waiter.resolve(connection);
  }

  // -------------------------------------------------------------------------
  // 돌려받기
  // -------------------------------------------------------------------------

  private giveBack(connection: Connection): void {
    this.active.delete(connection);
    if (connection.isClosed) {
      this.dispatch();
      this.settle();
      return;
    }
    if (this.closing) {
      connection.destroy();
      this.settle();
      return;
    }
    const tooOld = this.maxLifetimeMs > 0 && Date.now() - (this.createdAt.get(connection) ?? 0) > this.maxLifetimeMs;
    if (tooOld) {
      connection.destroy();
      this.dispatch();
      this.settle();
      return;
    }
    if (!connection._needsReset) {
      this.keepIdle(connection);
      this.dispatch();
      return;
    }
    this.releasing.add(connection);
    connection._reset().then(
      () => {
        this.releasing.delete(connection);
        if (this.closing || connection.isClosed) connection.destroy();
        else this.keepIdle(connection);
        this.dispatch();
        this.settle();
      },
      () => {
        // 되돌리지 못한 접속은 쓰지 않는다.
        this.releasing.delete(connection);
        connection.destroy();
        this.dispatch();
        this.settle();
      },
    );
  }

  private keepIdle(connection: Connection): void {
    this.idle.push({ connection, since: Date.now() });
    this.startReaper();
  }

  /** 끊어진 접속을 풀에서 뺀다. 빌려 간 접속이 끊겼으면 그 자리를 바로 돌려받고, 나중에 `release` 해도 아무 일도 없다. */
  private forget(connection: Connection): void {
    const index = this.idle.findIndex((entry) => entry.connection === connection);
    if (index >= 0) this.idle.splice(index, 1);
    this.active.delete(connection);
    this.releasing.delete(connection);
    this.dispatch();
    this.settle();
  }

  // -------------------------------------------------------------------------
  // 놀고 있는 접속 정리
  // -------------------------------------------------------------------------

  private startReaper(): void {
    if (this.reaper !== null || this.idleTimeoutMs <= 0) return;
    this.reaper = setInterval(() => this.reap(), Math.max(100, Math.floor(this.idleTimeoutMs / 2)));
    this.reaper.unref();
  }

  private reap(): void {
    const limit = Date.now() - this.idleTimeoutMs;
    for (let i = this.idle.length - 1; i >= 0; i--) {
      const entry = this.idle[i] as IdleEntry;
      if (entry.since <= limit) {
        this.idle.splice(i, 1);
        entry.connection.destroy();
      }
    }
    if (this.idle.length === 0 && this.reaper !== null) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
  }

  // -------------------------------------------------------------------------
  // 편의 함수
  // -------------------------------------------------------------------------

  /** 접속을 빌려 문장 하나를 실행하고 돌려준다. */
  async query(sql: string, params: readonly Param[] = [], options: QueryOptions = {}): Promise<QueryResult> {
    const connection = await this.acquire();
    try {
      return await connection.query(sql, params, options);
    } finally {
      connection.release();
    }
  }

  /** 접속을 빌려 `fn` 에 넘기고, 끝나면(예외로 끝나도) 돌려준다. */
  async withConnection<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    const connection = await this.acquire();
    try {
      return await fn(connection);
    } finally {
      connection.release();
    }
  }

  /** 접속을 빌려 `fn` 을 트랜잭션 안에서 실행한다. (`Connection.transaction`) */
  async transaction<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    return await this.withConnection((connection) => connection.transaction(fn));
  }

  // -------------------------------------------------------------------------
  // 닫기
  // -------------------------------------------------------------------------

  /** 모든 접속이 정리된 것을 기다리던 쪽을 깨운다. */
  private settle(): void {
    if (!this.closing || this.total() > 0) return;
    const waiting = this.drained;
    this.drained = [];
    for (const resolve of waiting) resolve();
  }

  /**
   * 풀을 닫는다. 새 요청은 받지 않고, 기다리던 요청은 실패시키고, 놀고 있는 접속은 바로 닫는다.
   * 빌려 간 접속은 돌려받는 대로 닫으며, 모두 정리되면 끝난다. `force` 가 true 이면 빌려 간 접속도 바로 끊는다(서버가 커밋하지 않은 변경을 롤백한다).
   */
  async close(options: { force?: boolean } = {}): Promise<void> {
    if (!this.closing) {
      this.closing = true;
      if (this.reaper !== null) {
        clearInterval(this.reaper);
        this.reaper = null;
      }
      for (const waiter of this.waiters.splice(0)) {
        waiter.done = true;
        if (waiter.timer !== null) clearTimeout(waiter.timer);
        waiter.reject(new DbError("08003", ERROR_CODES.CONNECTION_FAILURE, "The pool is closed."));
      }
      for (const entry of this.idle.splice(0)) entry.connection.destroy();
    }
    if (options.force === true) {
      for (const connection of [...this.active, ...this.releasing]) connection.destroy();
      this.active.clear();
      this.releasing.clear();
    }
    if (this.total() === 0) return;
    await new Promise<void>((resolve) => this.drained.push(resolve));
  }
}

/** 커넥션 풀을 만든다. 접속은 처음 빌릴 때 만든다. */
export function createPool(options: PoolOptions): Pool {
  return new Pool(options);
}
