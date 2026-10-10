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
 * 구현 단계 : 5단계(실행 입구), 7단계(트랜잭션 상태)
 */

import { DbError, ERROR_CODES, unsupportedFeature } from "../common/errors.js";
import type { SourcePosition } from "../common/errors.js";
import { parseStatement } from "../sql/parser.js";
import type { ObjectName, Query, Select } from "../sql/ast.js";
import { varcharType, integerType } from "../types/dataType.js";
import type { DataType } from "../types/dataType.js";
import { resolveTimeZone } from "../types/datetime.js";
import type { SqlValue } from "../types/value.js";
import { DateValue, TimeValue, TimestampValue, IntervalValue } from "../types/datetime.js";
import { Decimal } from "../types/numeric.js";
import { ensureSystemTablespace } from "../catalog/bootstrap.js";
import type { TablespaceManager } from "../catalog/tablespaceManager.js";
import {
  getDictionaryColumns,
  getDictionaryRows,
  isDictionaryView,
} from "../catalog/dictionaryViews.js";
import {
  executeAlterTable,
  executeCreateIndex,
  executeCreateTable,
  executeCreateView,
  executeDropIndex,
  executeDropTable,
  executeDropView,
  executeTruncateTable,
} from "../exec/ddl.js";

function fail(sqlState: string, code: number, message: string, position?: SourcePosition): never {
  if (position !== undefined) {
    const text = message.replace(/\.$/, "");
    throw new DbError(sqlState, code, `${text} (line ${position.line}, column ${position.column}).`, { position });
  }
  throw new DbError(sqlState, code, message);
}

/** 실행 결과이다. 5단계에서는 DDL 과 딕셔너리 조회만 돌려준다. */
export type ExecuteResult =
  | { kind: "ok"; message: string }
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

/**
 * 접속 하나의 실행 단위이다. 한 번에 문장 하나씩 순서대로 처리한다.
 * 5단계에서는 DDL 과 세션 문장, 딕셔너리 조회만 실행한다. DML 과 권한은 뒤 단계이다.
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

  /** SQL 문장 하나를 실행한다. 한 번의 요청에는 문장 하나만 둔다. */
  execute(sql: string, params: SqlValue[] = []): ExecuteResult {
    const parsed = parseStatement(sql);
    if (parsed.parameterCount !== params.length) {
      fail(
        "07001",
        ERROR_CODES.INTERNAL_ERROR,
        `Parameter count does not match: expected ${parsed.parameterCount}, got ${params.length}.`,
      );
    }
    if (parsed.parameterCount > 0) {
      throw unsupportedFeature("Parameters are supported for DML in a later step.");
    }
    const stmt = parsed.statement;
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
      case "TruncateTable":
        executeTruncateTable(manager, this.currentTablespace, stmt);
        return { kind: "ok", message: `Table "${stmt.name.name}" truncated.` };
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
        return this.executeQuery(stmt);
      case "Insert":
      case "Update":
      case "Delete":
        throw unsupportedFeature("DML is supported in a later step.");
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

  private executeQuery(query: Query): ExecuteResult {
    // 5단계의 조회는 딕셔너리 뷰와 DUAL, FROM 없는 리터럴만 받는다. 나머지는 6단계이다.
    const body = query.body;
    if (query.forUpdate) {
      throw unsupportedFeature("SELECT ... FOR UPDATE is supported in a later step.");
    }
    if (query.offset !== null || query.fetch !== null) {
      // 행 수 제한이 딸린 딕셔너리 조회는 6단계에서 받는다.
      throw unsupportedFeature("Row limiting for dictionary views is supported in a later step.");
    }
    if (query.orderBy.length > 0) {
      throw unsupportedFeature("ORDER BY for dictionary views is supported in a later step.");
    }
    if (body.kind === "SetOperation") {
      throw unsupportedFeature("Set operations are supported in a later step.");
    }
    const unwrapped: Query["body"] = body.kind === "Query" ? body.body : body;
    if (unwrapped.kind !== "Select") {
      throw unsupportedFeature("Query execution is supported in a later step.");
    }
    const select = unwrapped as Select;
    if (select.groupBy.length > 0 || select.having !== null || select.distinct) {
      throw unsupportedFeature("Grouped queries are supported in a later step.");
    }
    if (select.where !== null) {
      throw unsupportedFeature("Filtered dictionary queries are supported in a later step.");
    }
    if (select.from.length === 0) {
      return this.executeBareSelect(select);
    }
    if (select.from.length !== 1) {
      throw unsupportedFeature("Joins are supported in a later step.");
    }
    const reference = select.from[0] as import("../sql/ast.js").TableReference;
    if (reference.kind !== "Table") {
      throw unsupportedFeature("Derived tables are supported in a later step.");
    }
    return this.executeSingleTableSelect(select, reference.name);
  }

  /** FROM 없는 SELECT. 리터럴만으로 된 한 행을 돌려준다. */
  private executeBareSelect(select: Select): ExecuteResult {
    const columns: { name: string; dataType: DataType }[] = [];
    const row: SqlValue[] = [];
    select.items.forEach((item, index) => {
      if (item.kind === "Star") {
        fail("42P01", ERROR_CODES.TABLE_NOT_FOUND, "SELECT * without FROM is not valid.");
      }
      const { value, dataType, name } = literalResult(item.expression, item.alias ?? `COL${index + 1}`);
      columns.push({ name, dataType });
      row.push(value);
    });
    return { kind: "select", columns, rows: [row] };
  }

  /** 테이블 하나만 참조하는 SELECT. 딕셔너리 뷰와 DUAL 만 받는다. */
  private executeSingleTableSelect(select: Select, name: ObjectName): ExecuteResult {
    const manager = this.database.manager;
    const resolved = resolveDictionaryName(manager, name, this.currentTablespace);
    if (resolved === null) {
      throw unsupportedFeature("Querying user tables is supported in a later step.");
    }
    if (resolved.kind === "Dual") {
      return this.executeDualSelect(select);
    }
    const columns = getDictionaryColumns(resolved.view);
    const allRows = getDictionaryRows(manager, resolved.view);
    // 선택 목록을 해석한다. * 또는 컬럼 이름과 별칭만 받는다.
    const wanted: { index: number; alias: string }[] = [];
    for (const item of select.items) {
      if (item.kind === "Star") {
        if (item.qualifier.length > 0) {
          throw unsupportedFeature("Qualified * for dictionary views is supported in a later step.");
        }
        columns.forEach((column, index) => wanted.push({ index, alias: column.name }));
        continue;
      }
      const expr = item.expression;
      if (expr.kind !== "Column" || expr.qualifier.length > 0) {
        // 딕셔너리 조회에서도 식은 6단계이다. 리터럴만 예외로 받는다.
        try {
          const literal = literalResult(expr, item.alias ?? "COL");
          void literal;
        } catch {
          throw unsupportedFeature("Expressions in dictionary queries are supported in a later step.");
        }
        throw unsupportedFeature("Expressions in dictionary queries are supported in a later step.");
      }
      const columnName: string = expr.name;
      const found = columns.findIndex((column) => column.name === columnName);
      if (found < 0) {
        fail("42703", ERROR_CODES.COLUMN_NOT_FOUND, `Column does not exist: "${columnName}".`);
      }
      wanted.push({ index: found, alias: item.alias ?? columns[found]!.name });
    }
    const outputColumns = wanted.map((entry) => ({
      name: entry.alias,
      dataType: columns[entry.index]!.dataType,
    }));
    const rows = allRows.map((source) => wanted.map((entry) => source[entry.index] as SqlValue));
    return { kind: "select", columns: outputColumns, rows };
  }

  /** DUAL 조회. 한 행짜리 가상의 테이블이다. */
  private executeDualSelect(select: Select): ExecuteResult {
    const dummyType = varcharType(1);
    const dummyColumns = [{ name: "DUMMY", dataType: dummyType as DataType }];
    const dummyRow: SqlValue[] = ["X"];
    if (select.items.length === 1 && select.items[0]?.kind === "Star") {
      return { kind: "select", columns: dummyColumns, rows: [dummyRow] };
    }
    // DUMMY 컬럼과 리터럴만 받는다.
    const columns: { name: string; dataType: DataType }[] = [];
    const row: SqlValue[] = [];
    select.items.forEach((item, index) => {
      if (item.kind === "Star") {
        columns.push({ name: "DUMMY", dataType: dummyType });
        row.push("X");
        return;
      }
      if (item.expression.kind === "Column") {
        if (item.expression.qualifier.length === 0 && item.expression.name === "DUMMY") {
          columns.push({ name: item.alias ?? "DUMMY", dataType: dummyType });
          row.push("X");
          return;
        }
        fail("42703", ERROR_CODES.COLUMN_NOT_FOUND, `Column does not exist: "${item.expression.name}".`);
      }
      const literal = literalResult(item.expression, item.alias ?? `COL${index + 1}`);
      columns.push({ name: literal.name, dataType: literal.dataType });
      row.push(literal.value);
    });
    return { kind: "select", columns, rows: [row] };
  }
}

/** 딕셔너리 이름 해석. SYS_ 뷰와 DUAL 은 SYSTEM 에서 찾는다. */
function resolveDictionaryName(
  manager: TablespaceManager,
  name: ObjectName,
  current: string,
): { kind: "Dictionary"; view: string } | { kind: "Dual" } | null {
  const tablespace = name.tablespace ?? current;
  const objectName = name.name;
  // 사용자 객체가 먼저이다. 현재 테이블스페이스에 같은 이름의 테이블이나 뷰가 있으면 그것을 가리킨다.
  // SYSTEM 에서는 SYS_ 와 DUAL 이 예약이므로 사용자 객체가 있을 수 없다.
  if (name.tablespace === null || tablespace === current) {
    try {
      const currentCatalog = manager.requireCatalog(current);
      if (currentCatalog.data.tables[objectName] !== undefined || currentCatalog.data.views[objectName] !== undefined) {
        return null;
      }
    } catch {
      // 사용 불가 상태에서는 딕셔너리로 풀어 상태를 보여 줄 수 있게 한다.
    }
  } else {
    try {
      const explicit = manager.requireCatalog(tablespace);
      if (explicit.data.tables[objectName] !== undefined || explicit.data.views[objectName] !== undefined) {
        return null;
      }
    } catch {
      return null;
    }
  }
  if (objectName === "DUAL") {
    // DUAL 은 어느 테이블스페이스에서 적어도 SYSTEM.DUAL 을 가리킨다.
    return { kind: "Dual" };
  }
  if (isDictionaryView(objectName)) {
    // SYSTEM 또는 생략된 이름은 딕셔너리로 본다. 다른 테이블스페이스에서 붙여 적어도 SYSTEM 것만 본다.
    if (tablespace === "SYSTEM" || name.tablespace === null) {
      return { kind: "Dictionary", view: objectName };
    }
    return null;
  }
  return null;
}

/** 리터럴 식을 값과 타입으로 바꾼다. FROM 없는 SELECT 와 DUAL 에서 쓴다. */
function literalResult(
  expression: import("../sql/ast.js").Expression,
  fallbackName: string,
): { value: SqlValue; dataType: DataType; name: string } {
  switch (expression.kind) {
    case "Literal": {
      switch (expression.type) {
        case "NULL":
          return { value: null, dataType: varcharType(1), name: fallbackName };
        case "BOOLEAN":
          return { value: expression.value, dataType: { kind: "BOOLEAN", name: "BOOLEAN" }, name: fallbackName };
        case "STRING":
          return { value: expression.value, dataType: varcharType(Math.max(1, [...expression.value].length)), name: fallbackName };
        case "BINARY": {
          const bytes = Buffer.from(expression.hex, "hex");
          return {
            value: bytes,
            dataType: { kind: "VARBINARY", name: "VARBINARY", length: Math.max(1, bytes.length) },
            name: fallbackName,
          };
        }
        case "INTEGER": {
          const text = expression.text;
          try {
            const value = BigInt(text);
            const dataType: DataType =
              value >= -(2n ** 31n) && value <= 2n ** 31n - 1n
                ? { kind: "INTEGER", name: "INTEGER", bits: 32 }
                : { kind: "INTEGER", name: "BIGINT", bits: 64 };
            return { value, dataType, name: fallbackName };
          } catch {
            const decimal = Decimal.parse(text);
            return {
              value: decimal,
              dataType: { kind: "DECIMAL", name: "DECIMAL", precision: 10, scale: 0 },
              name: fallbackName,
            };
          }
        }
        case "DECIMAL": {
          const decimal = Decimal.parse(expression.text);
          const parts = expression.text.replace(/^[+-]/, "").split(".");
          const precision = (parts[0]?.replace(/^0+/, "").length ?? 0) + (parts[1]?.length ?? 0);
          const scale = parts[1]?.length ?? 0;
          return {
            value: decimal,
            dataType: { kind: "DECIMAL", name: "DECIMAL", precision: Math.max(1, precision), scale },
            name: fallbackName,
          };
        }
        case "FLOAT":
          return {
            value: Number(expression.text),
            dataType: { kind: "FLOAT", name: "DOUBLE PRECISION", bits: 64 },
            name: fallbackName,
          };
        case "DATE":
          return {
            value: new DateValue(0),
            dataType: { kind: "DATE", name: "DATE" },
            name: fallbackName,
          };
        case "TIME":
          return {
            value: new TimeValue(0, expression.withTimeZone === true ? 0 : null),
            dataType: expression.withTimeZone === true
              ? { kind: "TIME", name: "TIME WITH TIME ZONE", fractionalPrecision: 0, withTimeZone: true }
              : { kind: "TIME", name: "TIME", fractionalPrecision: 0, withTimeZone: false },
            name: fallbackName,
          };
        case "TIMESTAMP":
          return {
            value: new TimestampValue(0n, expression.withTimeZone === true ? 0 : null),
            dataType: expression.withTimeZone === true
              ? { kind: "TIMESTAMP", name: "TIMESTAMP WITH TIME ZONE", fractionalPrecision: 6, withTimeZone: true }
              : { kind: "TIMESTAMP", name: "TIMESTAMP", fractionalPrecision: 6, withTimeZone: false },
            name: fallbackName,
          };
        case "INTERVAL":
          return {
            value: IntervalValue.yearMonth(0),
            dataType: { kind: "INTERVAL", name: "INTERVAL", startField: "YEAR", endField: "MONTH", leadingPrecision: 2, fractionalPrecision: null },
            name: fallbackName,
          };
      }
      break;
    }
    default:
      break;
  }
  throw unsupportedFeature("Expressions in this query are supported in a later step.");
}

void integerType;
