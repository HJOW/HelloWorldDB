/**
 * 세션 : 접속 하나에 대응하는 실행 단위이자 SQL 실행의 입구.
 *
 * 담당
 *  - 세션 상태 : 로그인한 사용자, 자동 커밋 여부, 진행 중인 트랜잭션, 현재 테이블스페이스, 타임존
 *  - 문장 실행의 흐름 : 구문 분석(sql) → 이름과 타입 검사(exec/analyzer) → 권한 검사(auth) → 실행(exec)
 *  - 세션 문장 처리 : USE, SET TIME ZONE, SET AUTOCOMMIT
 *  - 한 세션의 문장은 들어온 순서대로 하나씩 처리한다. 세션 하나는 트랜잭션을 하나만 가진다.
 *  - 조회 결과를 fetch 단위로 꺼내 갈 수 있게 커서를 관리한다.
 *
 * 네트워크와 무관하게 프로세스 안에서 바로 쓸 수 있어야 한다.
 * 5 ~ 8단계의 테스트가 이 API 로 SQL 을 실행한다.
 *
 * 관련 사양 : AGENTS.md 상세 0, 9, 10
 * 구현 단계 : 5단계(실행 입구), 6단계(질의와 DML 연결), 7단계(트랜잭션 상태)
 */

import { DbError, ERROR_CODES, unsupportedFeature } from "../common/errors.js";
import type { SourcePosition } from "../common/errors.js";
import { parseStatement } from "../sql/parser.js";
import type { Query } from "../sql/ast.js";
import type { DataType } from "../types/dataType.js";
import { currentUtcMicros, resolveTimeZone } from "../types/datetime.js";
import type { TypeContext } from "../types/cast.js";
import type { SqlValue } from "../types/value.js";
import { ensureSystemTablespace } from "../catalog/bootstrap.js";
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
import { executeDelete, executeInsert, executeTruncate, executeUpdate } from "../exec/dml.js";

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
}

export interface SessionOptions {
  user?: string;
  tablespace?: string;
  timeZone?: string;
}

/**
 * 프로세스 내부의 데이터베이스이다. 데몬이 들고 있는 것과 같은 구성이다.
 * 네트워크 없이 SQL 을 실행하는 통로이며 5 ~ 8단계의 테스트가 이것을 쓴다.
 */
export class Database {
  private constructor(
    readonly dataDir: string,
    readonly manager: TablespaceManager,
    readonly defaultTimeZone: string,
  ) {}

  /** 데이터 디렉토리를 열고 SYSTEM 을 준비한다. 없으면 새로 만든다. */
  static open(dataDir: string, options: DatabaseOptions = {}): Database {
    const manager = ensureSystemTablespace(dataDir, {
      serverVersion: options.serverVersion,
      onWarning: options.onWarning,
    });
    return new Database(dataDir, manager, options.timeZone ?? "local");
  }

  /** 세션을 만든다. 사용자 인증은 8단계에서 붙이며 지금은 이름만 남긴다. */
  createSession(options: SessionOptions = {}): Session {
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
    return new Session(this, user, current, timeZone);
  }

  /** 모든 테이블스페이스를 닫는다. */
  close(): void {
    this.manager.close();
  }
}

import type { TablespaceManager } from "../catalog/tablespaceManager.js";

/**
 * 접속 하나의 실행 단위이다. 한 번에 문장 하나씩 순서대로 처리한다.
 * 6단계에서는 DDL 과 세션 문장, 질의 실행과 DML을 처리한다. 권한은 뒤 단계이다.
 */
export class Session {
  autocommit = true;

  constructor(
    readonly database: Database,
    readonly user: string,
    currentTablespace: string,
    timeZone: string,
  ) {
    this.currentTablespace = currentTablespace;
    this.timeZoneSpec = timeZone;
  }

  currentTablespace: string;
  private timeZoneSpec: string;

  get timeZone(): string {
    return this.timeZoneSpec;
  }

  /** 문장 실행용 질의 문맥을 만든다. 한 문장 안에서 현재 시각은 같은 값이다. */
  private queryContext(params: readonly SqlValue[]): QueryContext {
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
    };
  }

  /** SQL 문장 하나를 실행한다. 한 번의 요청에는 문장 하나만 둔다. */
  execute(sql: string, params: SqlValue[] = []): ExecuteResult {
    const parsed = parseStatement(sql);
    if (parsed.parameterCount !== params.length) {
      fail(
        "07001",
        ERROR_CODES.PARAM_COUNT_MISMATCH,
        `Parameter count does not match: expected ${parsed.parameterCount}, got ${params.length}.`,
      );
    }
    try {
      return this.executeParsed(parsed.statement, params);
    } catch (error) {
      // DbError가 아니면 내부 오류로 바꾸어 응답한다. (파서의 견고성과 같은 규칙)
      if (error instanceof DbError) throw error;
      throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, `Internal error: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  private executeParsed(stmt: import("../sql/ast.js").Statement, params: SqlValue[]): ExecuteResult {
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
        const count = executeTruncate(manager, this.currentTablespace, this.queryContext(params), stmt);
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
      case "Use": {
        if (!manager.has(stmt.tablespace)) {
          fail("3D000", ERROR_CODES.TABLESPACE_NOT_FOUND, `Tablespace does not exist: "${stmt.tablespace}".`);
        }
        try {
          manager.requireCatalog(stmt.tablespace);
        } catch (error) {
          if (error instanceof DbError) throw error;
          throw error;
        }
        this.currentTablespace = stmt.tablespace;
        return { kind: "ok", message: `Current tablespace is "${stmt.tablespace}".` };
      }
      case "SetTimeZone": {
        resolveTimeZone(stmt.zone);
        this.timeZoneSpec = stmt.zone;
        return { kind: "ok", message: `Time zone is "${stmt.zone}".` };
      }
      case "SetAutocommit":
        this.autocommit = stmt.value;
        return { kind: "ok", message: `Autocommit is ${stmt.value ? "ON" : "OFF"}.` };
      case "Begin":
      case "Commit":
      case "Rollback":
      case "Savepoint":
      case "ReleaseSavepoint":
      case "SetTransaction":
        // 트랜잭션의 실제 동작은 7단계이다. 지금은 순서만 받는다.
        return { kind: "ok", message: "Transaction statement accepted." };
      case "Query":
        return this.executeQuery(stmt, params);
      case "Insert": {
        const count = executeInsert(manager, this.currentTablespace, this.queryContext(params), stmt);
        return { kind: "ok", message: `INSERT ${count}`, rowCount: count };
      }
      case "Update": {
        const count = executeUpdate(manager, this.currentTablespace, this.queryContext(params), stmt);
        return { kind: "ok", message: `UPDATE ${count}`, rowCount: count };
      }
      case "Delete": {
        const count = executeDelete(manager, this.currentTablespace, this.queryContext(params), stmt);
        return { kind: "ok", message: `DELETE ${count}`, rowCount: count };
      }
      case "CreateUser":
      case "AlterUser":
      case "DropUser":
      case "Grant":
      case "Revoke":
      case "GrantGroup":
      case "RevokeGroup":
        throw unsupportedFeature("User and privilege management is supported in a later step.");
      default: {
        const _exhaustive: never = stmt;
        throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, `Unsupported statement: ${JSON.stringify(_exhaustive)}.`);
      }
    }
  }

  private executeQuery(query: Query, params: SqlValue[]): ExecuteResult {
    // SELECT ... FOR UPDATE는 6단계에서 잠금 없이 읽는다. (잠금은 7단계)
    const result = executeQuery(query, this.queryContext(params));
    return {
      kind: "select",
      columns: result.columns.map((column) => ({ name: column.name, dataType: column.type })),
      rows: result.rows,
    };
  }
}
