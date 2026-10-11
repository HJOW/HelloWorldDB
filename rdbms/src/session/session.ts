/**
 * 세션 : 접속 하나에 대응하는 실행 단위이자 SQL 실행의 입구.
 *
 * 담당
 *  - 세션 상태 : 로그인한 사용자, 자동 커밋 여부, 진행 중인 트랜잭션, 현재 테이블스페이스, 타임존
 *  - 문장 실행의 흐름 : 구문 분석(sql) → 이름과 타입 검사(exec/analyzer) → 권한 검사(auth) → 실행(exec)
 *  - 세션 문장 처리 : USE, SET TIME ZONE, SET AUTOCOMMIT
 *  - 트랜잭션 문장 처리 : BEGIN, COMMIT, ROLLBACK, SAVEPOINT, ROLLBACK TO, RELEASE SAVEPOINT
 *  - 한 세션의 문장은 들어온 순서대로 하나씩 처리한다. 세션 하나는 트랜잭션을 하나만 가진다.
 *  - 조회 결과를 fetch 단위로 꺼내 갈 수 있게 커서를 관리한다.
 *
 * 네트워크와 무관하게 프로세스 안에서 바로 쓸 수 있어야 한다.
 * 5 ~ 8단계의 테스트가 이 API 로 SQL 을 실행한다.
 *
 * 실행 방식은 두 가지이다. 문장을 실행하는 본체는 같고 잠금 충돌을 다루는 방법만 다르다.
 *  - `execute` : 동기. 다른 트랜잭션이 잠근 행을 만나면 기다리지 않고 바로 55P03 으로 끝낸다.
 *  - `executeAsync` : 비동기. 잠금이 풀리기를 `transaction.lockTimeoutMs` 까지 기다렸다가 문장을 처음부터
 *    다시 실행한다. 교착 상태를 만나면 이 트랜잭션을 롤백하고 40P01 로 끝낸다. 통신 계층이 이것을 쓴다.
 *
 * 문장을 실행하는 동안에는 다른 세션의 문장이 끼어들지 않는다. (자바스크립트의 한 스레드 실행)
 * 문장은 처음부터 끝까지 한 번에 실행되고, 기다림은 문장과 문장 사이(재시도 직전)에만 일어난다.
 * 그래서 한 문장은 항상 일관된 커밋 상태를 본다.
 *
 * 문장의 종류와 트랜잭션
 *  - 데이터 문장(SELECT, INSERT, UPDATE, DELETE) : 트랜잭션 안에서 실행한다.
 *    자동 커밋 ON 이고 트랜잭션이 없으면 문장 하나짜리 트랜잭션을 만들어 문장 직후 커밋한다.
 *    OFF 이면 첫 문장에서 트랜잭션을 시작하며 COMMIT 이나 ROLLBACK 까지 이어진다.
 *    실패한 문장은 그 문장이 한 변경만 되돌리고 트랜잭션은 유지한다.
 *  - DDL 문장(테이블스페이스, 테이블, 뷰, 인덱스, TRUNCATE) : 실행 전에 진행 중인 트랜잭션을 커밋하고,
 *    대상 객체에 객체 잠금을 걸어 다른 트랜잭션이 그 객체의 행을 잠그고 있는 동안은 실행하지 않는다.
 *    DDL 의 결과는 바로 저장되므로 롤백할 수 없다.
 *  - 세션 문장과 트랜잭션 문장 : 잠금 없이 바로 처리한다.
 *
 * 관련 사양 : AGENTS.md 상세 0, 9, 10
 * 구현 단계 : 5단계(실행 입구), 6단계(질의와 DML 연결), 7단계(트랜잭션 상태)
 */

import { DbError, ERROR_CODES, unsupportedFeature } from "../common/errors.js";
import type { SourcePosition } from "../common/errors.js";
import { parseStatement } from "../sql/parser.js";
import type { Statement } from "../sql/ast.js";
import type { DataType } from "../types/dataType.js";
import { currentUtcMicros, resolveTimeZone } from "../types/datetime.js";
import type { TypeContext } from "../types/cast.js";
import type { SqlValue } from "../types/value.js";
import { ensureSystemTablespace } from "../catalog/bootstrap.js";
import type { TablespaceManager } from "../catalog/tablespaceManager.js";
import {
  executeAlterTable,
  executeCreateIndex,
  executeCreateTable,
  executeCreateView,
  executeDropIndex,
  executeDropTable,
  executeDropView,
} from "../exec/ddl.js";
import { executeQuery } from "../exec/executor.js";
import type { QueryContext } from "../exec/executor.js";
import { commitTransaction, executeDelete, executeInsert, executeTruncate, executeUpdate } from "../exec/dml.js";
import { LockManager, isLockConflict, lockConflict, objectLockKey } from "../txn/lockManager.js";
import { Transaction } from "../txn/transaction.js";
import { SessionManager } from "./sessionManager.js";

function fail(sqlState: string, code: number, message: string, position?: SourcePosition): never {
  if (position !== undefined) {
    const text = message.replace(/\.$/, "");
    throw new DbError(sqlState, code, `${text} (line ${position.line}, column ${position.column}).`, { position });
  }
  throw new DbError(sqlState, code, message);
}

/** 실행 결과이다. DML은 영향받은 행 수를 함께 돌려준다. */
export type ExecuteResult =
  | { kind: "ok"; message: string; rowCount?: number }
  | { kind: "select"; columns: { name: string; dataType: DataType }[]; rows: SqlValue[][] };

export interface DatabaseOptions {
  serverVersion?: string;
  timeZone?: string;
  onWarning?: (message: string) => void;
  /** 잠금 대기 제한 시간(ms). `transaction.lockTimeoutMs` 와 같다. 기본 30000. */
  lockTimeoutMs?: number;
  /** 유휴 세션을 닫는 시간(ms). `session.idleTimeoutMs` 와 같다. 0 이면 제한 없음. 기본 0. */
  idleTimeoutMs?: number;
}

export interface SessionOptions {
  user?: string;
  tablespace?: string;
  timeZone?: string;
}

/**
 * 프로세스 내부의 데이터베이스이다. 데몬이 들고 있는 것과 같은 구성이다.
 * 네트워크 없이 SQL 을 실행하는 통로이며 5 ~ 8단계의 테스트가 이것을 쓴다.
 * 잠금 관리자와 세션 목록을 하나씩 가지며 모든 세션이 이것을 함께 쓴다.
 */
export class Database {
  /** 모든 세션이 함께 쓰는 잠금 관리자이다. */
  readonly locks = new LockManager();
  readonly sessions: SessionManager;
  private transactionSeq = 0;

  private constructor(
    readonly dataDir: string,
    readonly manager: TablespaceManager,
    readonly defaultTimeZone: string,
    readonly lockTimeoutMs: number,
    idleTimeoutMs: number,
  ) {
    this.sessions = new SessionManager(idleTimeoutMs);
  }

  /** 데이터 디렉토리를 열고 SYSTEM 을 준비한다. 없으면 새로 만든다. */
  static open(dataDir: string, options: DatabaseOptions = {}): Database {
    const manager = ensureSystemTablespace(dataDir, {
      serverVersion: options.serverVersion,
      onWarning: options.onWarning,
    });
    return new Database(
      dataDir,
      manager,
      options.timeZone ?? "local",
      options.lockTimeoutMs ?? 30000,
      options.idleTimeoutMs ?? 0,
    );
  }

  /** 트랜잭션과 잠금 소유자에 쓸 새 번호이다. DDL 문장도 이 번호로 객체 잠금을 건다. */
  nextTransactionId(): number {
    this.transactionSeq++;
    return this.transactionSeq;
  }

  /** 세션을 만든다. 사용자 인증은 8단계에서 붙이며 지금은 이름만 남긴다. */
  createSession(options: SessionOptions = {}): Session {
    if (!this.sessions.isAccepting) {
      fail("57P01", ERROR_CODES.SESSION_CLOSED, "Database is shutting down.");
    }
    const user = options.user ?? "SYSTEM";
    const timeZone = options.timeZone ?? this.defaultTimeZone;
    // 타임존 문자열이 잘못되면 여기서 실패한다.
    resolveTimeZone(timeZone);
    let current = options.tablespace ?? null;
    if (current === null) {
      // 기본 테이블스페이스가 없으면 SYSTEM 에서 시작한다. (8단계에서 사용자 기본값으로 바꾼다)
      current = "SYSTEM";
    }
    if (!this.manager.has(current)) {
      fail("3D000", ERROR_CODES.TABLESPACE_NOT_FOUND, `Tablespace does not exist: "${current}".`);
    }
    const session = new Session(this, this.sessions.nextId(), user, current, timeZone);
    this.sessions.add(session);
    return session;
  }

  /** 모든 세션을 끝내고(커밋하지 않은 변경은 롤백) 모든 테이블스페이스를 닫는다. */
  close(): void {
    this.sessions.closeAll("shutdown");
    this.sessions.stop();
    this.manager.close();
  }
}

/** 세션이 끝난 이유이다. 통신 계층이 클라이언트에 알릴 때 쓴다. */
export type SessionCloseReason = "closed" | "idle" | "shutdown";

/**
 * 접속 하나의 실행 단위이다. 한 번에 문장 하나씩 순서대로 처리한다.
 * 권한은 8단계에서 붙는다.
 */
export class Session {
  autocommit = true;
  currentTablespace: string;
  /** 마지막으로 문장을 시작하거나 끝낸 시각(epoch ms)이다. 유휴 판정에 쓴다. */
  lastActivity = Date.now();
  readonly connectedAt = Date.now();

  private timeZoneSpec: string;
  private txn: Transaction | null = null;
  private closed = false;
  /** 문장을 실행하는 중이면 true. 실행 중인 세션은 유휴로 보지 않는다. */
  private running = false;
  /** 잠금을 기다리는 중인 소유자 번호이다. 세션을 닫을 때 대기를 취소한다. */
  private waitingOwner: number | null = null;
  /** 비동기 문장을 도착 순서대로 하나씩 처리하기 위한 줄이다. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly closeListeners: Array<(reason: SessionCloseReason) => void> = [];

  constructor(
    readonly database: Database,
    readonly id: number,
    readonly user: string,
    currentTablespace: string,
    timeZone: string,
  ) {
    this.currentTablespace = currentTablespace;
    this.timeZoneSpec = timeZone;
  }

  get timeZone(): string {
    return this.timeZoneSpec;
  }

  /** 진행 중인 트랜잭션이 있는지 본다. */
  get inTransaction(): boolean {
    return this.txn !== null;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 문장을 실행하고 있지 않은 상태이다. */
  get isIdle(): boolean {
    return !this.running && !this.closed;
  }

  /** 세션이 닫힐 때 불리는 함수를 등록한다. */
  onClose(listener: (reason: SessionCloseReason) => void): void {
    this.closeListeners.push(listener);
  }

  /**
   * 세션을 닫는다. 커밋하지 않은 변경은 롤백하고 잠금을 모두 푼다.
   * 잠금을 기다리는 문장이 있으면 그 기다림을 취소한다.
   */
  close(reason: SessionCloseReason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waitingOwner !== null) this.database.locks.cancelWait(this.waitingOwner);
    if (this.txn !== null) this.dropTransaction(this.txn);
    this.database.sessions.remove(this);
    for (const listener of this.closeListeners) {
      try {
        listener(reason);
      } catch {
        // 알림 오류가 닫기를 막지 않는다.
      }
    }
  }

  /** 문장 실행용 질의 문맥을 만든다. 한 문장 안에서 현재 시각은 같은 값이다. */
  private queryContext(params: readonly SqlValue[], txn: Transaction): QueryContext {
    return {
      manager: this.database.manager,
      currentTablespace: this.currentTablespace,
      currentUser: this.user,
      typeCtx: {
        timeZone: resolveTimeZone(this.timeZoneSpec),
        currentUtcMicros: currentUtcMicros(),
      } as TypeContext,
      params,
      outerScopes: [],
      viewStack: [],
      txn,
      locker: this.database.locks,
    };
  }

  // -------------------------------------------------------------------------
  // 실행 입구
  // -------------------------------------------------------------------------

  /**
   * SQL 문장 하나를 동기로 실행한다. 한 번의 요청에는 문장 하나만 둔다.
   * 다른 트랜잭션이 잠근 행을 만나면 기다리지 않고 55P03 으로 끝낸다.
   */
  execute(sql: string, params: SqlValue[] = []): ExecuteResult {
    this.ensureOpen();
    const statement = this.parse(sql, params);
    this.running = true;
    this.lastActivity = Date.now();
    try {
      return this.executeStatementSync(statement, params);
    } catch (error) {
      throw this.normalizeError(error);
    } finally {
      this.running = false;
      this.lastActivity = Date.now();
    }
  }

  /**
   * SQL 문장 하나를 비동기로 실행한다. 같은 세션의 문장은 호출한 순서대로 하나씩 처리한다.
   * 잠금을 만나면 `lockTimeoutMs` 까지 기다린다. 넘으면 55P03 으로 그 문장만 실패하고,
   * 교착 상태가 되면 이 트랜잭션을 롤백하고 40P01 로 끝낸다.
   */
  executeAsync(sql: string, params: SqlValue[] = []): Promise<ExecuteResult> {
    const result = this.chain.then(() => this.runAsync(sql, params));
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async runAsync(sql: string, params: SqlValue[]): Promise<ExecuteResult> {
    this.ensureOpen();
    const statement = this.parse(sql, params);
    this.running = true;
    this.lastActivity = Date.now();
    try {
      return await this.executeStatementAsync(statement, params);
    } catch (error) {
      throw this.normalizeError(error);
    } finally {
      this.running = false;
      this.lastActivity = Date.now();
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new DbError("08003", ERROR_CODES.SESSION_CLOSED, "Session is closed.");
    }
  }

  private parse(sql: string, params: SqlValue[]): Statement {
    const parsed = parseStatement(sql);
    if (parsed.parameterCount !== params.length) {
      fail(
        "07001",
        ERROR_CODES.PARAM_COUNT_MISMATCH,
        `Parameter count does not match: expected ${parsed.parameterCount}, got ${params.length}.`,
      );
    }
    return parsed.statement;
  }

  /** DbError가 아니면 내부 오류로 바꾸어 응답한다. (파서의 견고성과 같은 규칙) */
  private normalizeError(error: unknown): DbError {
    if (error instanceof DbError) return error;
    return new DbError(
      "XX000",
      ERROR_CODES.INTERNAL_ERROR,
      `Internal error: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }

  private executeStatementSync(stmt: Statement, params: SqlValue[]): ExecuteResult {
    switch (statementClass(stmt)) {
      case "data": {
        const { txn, implicit } = this.statementTransaction();
        try {
          const result = this.attemptData(stmt, params, txn);
          if (implicit) this.commitTransaction(txn);
          return result;
        } catch (error) {
          if (implicit) this.dropTransaction(txn);
          throw error;
        }
      }
      case "ddl": {
        this.commitBeforeDdl();
        const owner = this.database.nextTransactionId();
        try {
          return this.attemptDdl(stmt, params, owner);
        } finally {
          this.database.locks.releaseAll(owner);
        }
      }
      case "control":
        return this.executeControl(stmt);
      case "unsupported":
        throw unsupportedFeature("User and privilege management is supported in a later step.");
    }
  }

  private async executeStatementAsync(stmt: Statement, params: SqlValue[]): Promise<ExecuteResult> {
    const deadline = Date.now() + this.database.lockTimeoutMs;
    switch (statementClass(stmt)) {
      case "data": {
        const { txn, implicit } = this.statementTransaction();
        try {
          let result: ExecuteResult;
          for (;;) {
            try {
              result = this.attemptData(stmt, params, txn);
              break;
            } catch (error) {
              if (!isLockConflict(error)) throw error;
              await this.waitLock(txn.id, error.conflictKey, deadline);
            }
          }
          if (implicit) this.commitTransaction(txn);
          return result;
        } catch (error) {
          // 교착 상태이면 트랜잭션 전체를 롤백한다. 그 밖에는 자동 커밋 문장만 정리한다.
          if (implicit || isDeadlock(error)) this.dropTransaction(txn);
          throw error;
        }
      }
      case "ddl": {
        this.commitBeforeDdl();
        const owner = this.database.nextTransactionId();
        try {
          for (;;) {
            try {
              return this.attemptDdl(stmt, params, owner);
            } catch (error) {
              if (!isLockConflict(error)) throw error;
              await this.waitLock(owner, error.conflictKey, deadline);
            }
          }
        } finally {
          this.database.locks.releaseAll(owner);
        }
      }
      case "control":
        return this.executeControl(stmt);
      case "unsupported":
        throw unsupportedFeature("User and privilege management is supported in a later step.");
    }
  }

  /** 잠금이 풀리기를 기다린다. 제한 시각을 넘으면 55P03, 교착이면 40P01 을 던진다. */
  private async waitLock(owner: number, key: string, deadline: number): Promise<void> {
    this.waitingOwner = owner;
    try {
      await this.database.locks.waitFor(owner, key, deadline);
    } finally {
      this.waitingOwner = null;
    }
  }

  // -------------------------------------------------------------------------
  // 트랜잭션
  // -------------------------------------------------------------------------

  /**
   * 데이터 문장이 쓸 트랜잭션을 정한다.
   * 진행 중인 것이 있으면 그것, 없고 자동 커밋이 OFF 이면 새로 시작해 이어 간다.
   * 자동 커밋 ON 이면 문장 하나짜리를 만들며 implicit 이 true 이다.
   */
  private statementTransaction(): { txn: Transaction; implicit: boolean } {
    if (this.txn !== null) return { txn: this.txn, implicit: false };
    if (!this.autocommit) {
      this.txn = new Transaction(this.database.nextTransactionId(), true);
      return { txn: this.txn, implicit: false };
    }
    return { txn: new Transaction(this.database.nextTransactionId(), false), implicit: true };
  }

  /** 문장 하나를 실행한다. 실패하면 이 문장이 한 변경만 되돌린다. */
  private attemptData(stmt: Statement, params: SqlValue[], txn: Transaction): ExecuteResult {
    const mark = txn.mark();
    try {
      return this.executeData(stmt, params, txn);
    } catch (error) {
      txn.truncateTo(mark);
      throw error;
    }
  }

  private executeData(stmt: Statement, params: SqlValue[], txn: Transaction): ExecuteResult {
    const manager = this.database.manager;
    const ctx = this.queryContext(params, txn);
    switch (stmt.kind) {
      case "Query": {
        const result = executeQuery(stmt, ctx);
        return {
          kind: "select",
          columns: result.columns.map((column) => ({ name: column.name, dataType: column.type })),
          rows: result.rows,
        };
      }
      case "Insert": {
        const count = executeInsert(manager, this.currentTablespace, ctx, stmt);
        return { kind: "ok", message: `INSERT ${count}`, rowCount: count };
      }
      case "Update": {
        const count = executeUpdate(manager, this.currentTablespace, ctx, stmt);
        return { kind: "ok", message: `UPDATE ${count}`, rowCount: count };
      }
      case "Delete": {
        const count = executeDelete(manager, this.currentTablespace, ctx, stmt);
        return { kind: "ok", message: `DELETE ${count}`, rowCount: count };
      }
      default:
        throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, `Not a data statement: ${stmt.kind}.`);
    }
  }

  /** 트랜잭션을 커밋한다. 성공하든 실패하든 트랜잭션은 끝나고 잠금은 풀린다. */
  private commitTransaction(txn: Transaction): void {
    try {
      commitTransaction(this.database.manager, txn, txn.explicit);
    } finally {
      this.dropTransaction(txn);
    }
  }

  /** 트랜잭션을 버린다. 미커밋 변경은 오버레이에만 있으므로 잠금만 풀면 롤백이 끝난다. */
  private dropTransaction(txn: Transaction): void {
    this.database.locks.releaseAll(txn.id);
    if (this.txn === txn) this.txn = null;
  }

  // -------------------------------------------------------------------------
  // DDL
  // -------------------------------------------------------------------------

  /** DDL 은 실행 전에 진행 중인 트랜잭션을 커밋한다. 커밋이 실패하면 DDL 은 실행하지 않는다. */
  private commitBeforeDdl(): void {
    if (this.txn !== null) this.commitTransaction(this.txn);
  }

  /** 객체 잠금을 걸고 DDL 을 한 번 실행한다. 충돌하면 오류를 던진다. */
  private attemptDdl(stmt: Statement, params: SqlValue[], owner: number): ExecuteResult {
    const keys = this.ddlLockKeys(stmt);
    const locked = this.database.locks.tryAcquireAll(owner, keys);
    if (!locked.ok) throw lockConflict(locked.key);
    return this.executeDdl(stmt, params, owner);
  }

  /**
   * DDL 이 건드리는 테이블의 객체 잠금 키를 모은다.
   * FK 로 엮인 테이블은 같이 잠근다. 새로 만드는 객체는 잠그지 않는다.
   */
  private ddlLockKeys(stmt: Statement): string[] {
    const manager = this.database.manager;
    const keys = new Set<string>();
    const spaceOf = (tablespace: string | null): string => tablespace ?? this.currentTablespace;
    const addTable = (tablespace: string, table: string): void => {
      keys.add(objectLockKey(tablespace, table));
    };
    const addRelated = (tablespace: string, table: string): void => {
      addTable(tablespace, table);
      if (!manager.has(tablespace)) return;
      let constraints;
      try {
        constraints = Object.values(manager.requireCatalog(tablespace).data.constraints);
      } catch {
        return;
      }
      for (const constraint of constraints) {
        if (constraint.kind !== "FOREIGN KEY") continue;
        if (constraint.table === table && constraint.refTable !== null) addTable(tablespace, constraint.refTable);
        if (constraint.refTable === table) addTable(tablespace, constraint.table);
      }
    };
    switch (stmt.kind) {
      case "AlterTable": {
        const tablespace = spaceOf(stmt.name.tablespace);
        addRelated(tablespace, stmt.name.name);
        if (stmt.action.kind === "AddConstraint" && stmt.action.constraint.kind === "ForeignKey") {
          const reference = stmt.action.constraint.reference.table;
          addTable(spaceOf(reference.tablespace), reference.name);
        }
        break;
      }
      case "DropTable":
      case "TruncateTable":
        addRelated(spaceOf(stmt.name.tablespace), stmt.name.name);
        break;
      case "CreateIndex":
        addTable(spaceOf(stmt.table.tablespace), stmt.table.name);
        break;
      case "DropIndex": {
        const tablespace = spaceOf(stmt.name.tablespace);
        if (manager.has(tablespace)) {
          try {
            const index = manager.requireCatalog(tablespace).data.indexes[stmt.name.name];
            if (index !== undefined) addTable(tablespace, index.table);
          } catch {
            // 사용할 수 없는 테이블스페이스는 DDL 이 오류로 알린다.
          }
        }
        break;
      }
      case "DropTablespace": {
        if (manager.has(stmt.name)) {
          try {
            for (const table of Object.keys(manager.requireCatalog(stmt.name).data.tables)) {
              addTable(stmt.name, table);
            }
          } catch {
            // 사용할 수 없는 테이블스페이스는 DDL 이 오류로 알린다.
          }
        }
        break;
      }
      default:
        break;
    }
    return [...keys];
  }

  private executeDdl(stmt: Statement, params: SqlValue[], owner: number): ExecuteResult {
    const manager = this.database.manager;
    switch (stmt.kind) {
      case "CreateTablespace": {
        manager.createTablespace(stmt.name, stmt.dataFile, stmt.characterSet);
        return { kind: "ok", message: `Tablespace "${stmt.name}" created.` };
      }
      case "DropTablespace": {
        manager.dropTablespace(stmt.name, stmt.includingContents);
        return { kind: "ok", message: `Tablespace "${stmt.name}" dropped.` };
      }
      case "CreateTable":
        executeCreateTable(manager, this.currentTablespace, this.user, stmt);
        return { kind: "ok", message: `Table "${stmt.name.name}" created.` };
      case "AlterTable":
        executeAlterTable(manager, this.currentTablespace, this.user, stmt);
        return { kind: "ok", message: `Table "${stmt.name.name}" altered.` };
      case "DropTable":
        executeDropTable(manager, this.currentTablespace, stmt);
        return { kind: "ok", message: `Table "${stmt.name.name}" dropped.` };
      case "TruncateTable": {
        const ctx = this.queryContext(params, new Transaction(owner, false));
        const count = executeTruncate(manager, this.currentTablespace, ctx, stmt);
        return { kind: "ok", message: `Table "${stmt.name.name}" truncated.`, rowCount: count };
      }
      case "CreateView":
        executeCreateView(manager, this.currentTablespace, this.user, stmt);
        return { kind: "ok", message: `View "${stmt.name.name}" created.` };
      case "DropView":
        executeDropView(manager, this.currentTablespace, stmt);
        return { kind: "ok", message: `View "${stmt.name.name}" dropped.` };
      case "CreateIndex":
        executeCreateIndex(manager, this.currentTablespace, stmt);
        return { kind: "ok", message: "Index created." };
      case "DropIndex":
        executeDropIndex(manager, this.currentTablespace, stmt);
        return { kind: "ok", message: `Index "${stmt.name.name}" dropped.` };
      default:
        throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, `Not a DDL statement: ${stmt.kind}.`);
    }
  }

  // -------------------------------------------------------------------------
  // 세션 문장과 트랜잭션 문장
  // -------------------------------------------------------------------------

  private executeControl(stmt: Statement): ExecuteResult {
    const manager = this.database.manager;
    switch (stmt.kind) {
      case "Use": {
        if (!manager.has(stmt.tablespace)) {
          fail("3D000", ERROR_CODES.TABLESPACE_NOT_FOUND, `Tablespace does not exist: "${stmt.tablespace}".`);
        }
        manager.requireCatalog(stmt.tablespace);
        this.currentTablespace = stmt.tablespace;
        return { kind: "ok", message: `Current tablespace is "${stmt.tablespace}".` };
      }
      case "SetTimeZone": {
        resolveTimeZone(stmt.zone);
        this.timeZoneSpec = stmt.zone;
        return { kind: "ok", message: `Time zone is "${stmt.zone}".` };
      }
      case "SetAutocommit": {
        // 켜는 순간 진행 중인 트랜잭션은 커밋한다. (MySQL 과 같은 규칙)
        if (stmt.value && this.txn !== null) this.commitTransaction(this.txn);
        this.autocommit = stmt.value;
        return { kind: "ok", message: `Autocommit is ${stmt.value ? "ON" : "OFF"}.` };
      }
      case "SetTransaction":
        return { kind: "ok", message: "Isolation level is READ COMMITTED." };
      case "Begin": {
        if (this.txn !== null) {
          fail("25001", ERROR_CODES.ACTIVE_TRANSACTION, "A transaction is already in progress.");
        }
        this.txn = new Transaction(this.database.nextTransactionId(), true);
        return { kind: "ok", message: "Transaction started." };
      }
      case "Commit": {
        if (this.txn === null) return { kind: "ok", message: "No transaction in progress." };
        this.commitTransaction(this.txn);
        return { kind: "ok", message: "Commit complete." };
      }
      case "Rollback": {
        if (stmt.savepoint !== null) {
          this.requireTransaction().rollbackTo(stmt.savepoint);
          return { kind: "ok", message: `Rolled back to savepoint "${stmt.savepoint}".` };
        }
        if (this.txn === null) return { kind: "ok", message: "No transaction in progress." };
        this.dropTransaction(this.txn);
        return { kind: "ok", message: "Rollback complete." };
      }
      case "Savepoint": {
        // 자동 커밋 OFF 이면 첫 문장에서 트랜잭션이 시작되므로 SAVEPOINT 도 시작시킨다.
        if (this.txn === null && !this.autocommit) {
          this.txn = new Transaction(this.database.nextTransactionId(), true);
        }
        this.requireTransaction().savepoint(stmt.name);
        return { kind: "ok", message: `Savepoint "${stmt.name}" created.` };
      }
      case "ReleaseSavepoint": {
        this.requireTransaction().release(stmt.name);
        return { kind: "ok", message: `Savepoint "${stmt.name}" released.` };
      }
      default:
        throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, `Not a control statement: ${stmt.kind}.`);
    }
  }

  private requireTransaction(): Transaction {
    if (this.txn === null) {
      fail("25P01", ERROR_CODES.NO_ACTIVE_TRANSACTION, "No transaction is in progress.");
    }
    return this.txn;
  }
}

/** 교착 상태 오류인지 본다. */
function isDeadlock(error: unknown): boolean {
  return error instanceof DbError && error.sqlState === "40P01";
}

type StatementClass = "data" | "ddl" | "control" | "unsupported";

/** 문장을 실행 방식에 따라 나눈다. */
function statementClass(stmt: Statement): StatementClass {
  switch (stmt.kind) {
    case "Query":
    case "Insert":
    case "Update":
    case "Delete":
      return "data";
    case "CreateTablespace":
    case "DropTablespace":
    case "CreateTable":
    case "AlterTable":
    case "DropTable":
    case "TruncateTable":
    case "CreateView":
    case "DropView":
    case "CreateIndex":
    case "DropIndex":
      return "ddl";
    case "Use":
    case "SetTimeZone":
    case "SetAutocommit":
    case "SetTransaction":
    case "Begin":
    case "Commit":
    case "Rollback":
    case "Savepoint":
    case "ReleaseSavepoint":
      return "control";
    case "CreateUser":
    case "AlterUser":
    case "DropUser":
    case "Grant":
    case "Revoke":
    case "GrantGroup":
    case "RevokeGroup":
      return "unsupported";
    default: {
      const exhaustive: never = stmt;
      throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, `Unsupported statement: ${JSON.stringify(exhaustive)}.`);
    }
  }
}
