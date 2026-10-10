/**
 * 객체 정의 변경 : 테이블, 뷰, 인덱스의 DDL.
 *
 * 담당
 *  - CREATE TABLE, ALTER TABLE(컬럼 추가와 삭제, DEFAULT 와 NOT NULL 변경, 이름 변경, 제약조건 추가와 삭제), DROP TABLE
 *  - CREATE VIEW (OR REPLACE 포함), DROP VIEW
 *  - CREATE INDEX, DROP INDEX. PK 를 만들 때 유일 인덱스를 자동으로 만든다.
 *  - 생략한 이름의 자동 부여 : PK_테이블명, FK_테이블명_순번, IX_테이블명_순번
 *  - RESTRICT 와 CASCADE : 다른 테이블의 FK 나 뷰가 참조하는 객체의 삭제 처리
 *  - 이미 데이터가 있는 테이블에 제약조건을 추가할 때 기존 데이터 검사
 *  - 실행 전후의 자동 커밋
 *
 * 정의의 저장은 catalog/catalog.ts 에 맡긴다.
 * 테이블스페이스, 사용자, 권한 문장은 각각 catalog/tablespaceManager.ts, auth/users.ts, auth/privileges.ts 가 맡는다.
 *
 * 관련 사양 : AGENTS.md 상세 1-3, 10, 11
 * 구현 단계 : 5단계
 */

import { DbError, ERROR_CODES, unsupportedFeature } from "../common/errors.js";
import type { SourcePosition } from "../common/errors.js";
import type {
  AlterTableStatement,
  CreateIndexStatement,
  CreateTableStatement,
  CreateViewStatement,
  DropIndexStatement,
  DropTableStatement,
  DropViewStatement,
  IndexColumn,
  ObjectName,
  Query,
  Select,
  TableConstraint,
  TruncateTableStatement,
} from "../sql/ast.js";
import type { DataType } from "../types/dataType.js";
import { formatDataType } from "../types/dataType.js";
import {
  assertNotReserved,
  assertSinglePrimaryKey,
  collectReferencedObjects,
  dataTypesMatch,
  expressionText,
  isReservedSystemName,
  objectExists,
  resolveReference,
} from "../catalog/catalog.js";
import type {
  CatalogStore,
  StoredColumn,
  StoredConstraint,
  StoredIndex,
  StoredTable,
} from "../catalog/catalog.js";
import { serializeCatalog } from "../catalog/catalog.js";
import type { TablespaceManager } from "../catalog/tablespaceManager.js";
import type { StorageBatch } from "../storage/format/format.js";
import { decodeRow, encodeKey, encodeRow } from "../types/codec.js";
import type { SqlValue } from "../types/value.js";
import { isDictionaryView } from "../catalog/dictionaryViews.js";
import { assignValue, isImplicitlyConvertible } from "../types/cast.js";
import { evaluateExpression } from "./expression.js";
import { dataHandlers, typeHandlers } from "./executor.js";
import type { QueryContext } from "./executor.js";

function fail(sqlState: string, code: number, message: string, position?: SourcePosition): never {
  if (position !== undefined) {
    const text = message.replace(/\.$/, "");
    throw new DbError(sqlState, code, `${text} (line ${position.line}, column ${position.column}).`, { position });
  }
  throw new DbError(sqlState, code, message);
}

/** 객체 이름에서 테이블스페이스를 정한다. 생략하면 현재 테이블스페이스이다. */
export function resolveTablespace(
  manager: TablespaceManager,
  name: ObjectName,
  current: string,
): { tablespace: string; name: string } {
  const tablespace = name.tablespace ?? current;
  if (!manager.has(tablespace)) {
    fail("3D000", ERROR_CODES.TABLESPACE_NOT_FOUND, `Tablespace does not exist: "${tablespace}".`, name.position);
  }
  return { tablespace, name: name.name };
}

/**
 * 딕셔너리 뷰와 DUAL 은 읽기 전용이다. DDL 과 DML 로 고치려 하면 막는다. (상세 3)
 * SYSTEM 이 아닌 테이블스페이스에서는 같은 이름의 사용자 객체가 없을 때만 딕셔너리 객체를 가리킨다.
 * 존재하지 않는 `SYS_` 이름은 지나가서 "없음" 오류가 난다.
 */
export function assertNotDictionaryObject(
  manager: TablespaceManager,
  tablespace: string,
  name: string,
  position?: SourcePosition,
): void {
  if (name !== "DUAL" && !isDictionaryView(name)) return;
  if (tablespace !== "SYSTEM") {
    if (!manager.has(tablespace)) return;
    const catalog = manager.requireCatalog(tablespace);
    if (catalog.data.tables[name] !== undefined || catalog.data.views[name] !== undefined) return;
  }
  fail("42809", ERROR_CODES.READ_ONLY_OBJECT, `"${name}" is a read-only dictionary object and cannot be changed.`, position);
}

/** 테이블스페이스가 사용 가능한지 확인하고 카탈로그를 돌려준다. */
function requireCatalog(manager: TablespaceManager, tablespace: string, position?: SourcePosition): CatalogStore {
  try {
    return manager.requireCatalog(tablespace, position);
  } catch (error) {
    if (error instanceof DbError && position !== undefined && error.position === undefined) {
      const text = error.message.replace(/\.$/, "");
      throw new DbError(
        error.sqlState,
        error.code,
        `${text} (line ${position.line}, column ${position.column}).`,
        { cause: error.cause, position },
      );
    }
    throw error;
  }
}

/** 컬럼 이름 목록에서 중복을 찾는다. */
function assertUniqueColumns(columns: string[], position?: SourcePosition): void {
  const seen = new Set<string>();
  for (const name of columns) {
    if (seen.has(name)) {
      fail("42701", ERROR_CODES.COLUMN_EXISTS, `Duplicate column name: "${name}".`, position);
    }
    seen.add(name);
  }
}

/** 테이블 정의의 컬럼 수를 확인한다. 최대 1,000개이다. */
function assertColumnLimit(count: number, position?: SourcePosition): void {
  if (count > 1000) {
    fail("54011", ERROR_CODES.TOO_MANY_COLUMNS, "A table cannot have more than 1000 columns.", position);
  }
}

/** 인덱스 컬럼 수를 확인한다. 최대 16개이다. */
function assertIndexColumnLimit(count: number, position?: SourcePosition): void {
  if (count === 0 || count > 16) {
    fail("42P16", ERROR_CODES.INVALID_INDEX_DEFINITION, "An index must have 1 to 16 columns.", position);
  }
}

// ---------------------------------------------------------------------------
// CREATE TABLE
// ---------------------------------------------------------------------------

interface ParsedColumns {
  columns: StoredColumn[];
  inlinePkName: string | null;
  inlinePkColumns: string[];
  inlineFks: { name: string | null; columns: string[]; reference: import("../sql/ast.js").ForeignKeyReference }[];
}

/** 컬럼 정의 목록을 저장 형태로 바꾼다. 타입은 파서가 이미 해석했다. */
function parseColumnDefinitions(stmt: CreateTableStatement): ParsedColumns {
  const columns: StoredColumn[] = [];
  const names = new Set<string>();
  let inlinePkName: string | null = null;
  let inlinePkColumns: string[] = [];
  const inlineFks: ParsedColumns["inlineFks"] = [];
  for (const column of stmt.columns) {
    if (names.has(column.name)) {
      fail("42701", ERROR_CODES.COLUMN_EXISTS, `Duplicate column name: "${column.name}".`, stmt.name.position);
    }
    names.add(column.name);
    const stored: StoredColumn = {
      name: column.name,
      dataType: column.dataType,
      defaultText: column.default === null ? null : expressionText(column.default),
      defaultExpr: column.default,
      notNull: column.notNull,
    };
    if (column.primaryKey !== null) {
      if (inlinePkColumns.length > 0) {
        fail(
          "42P16",
          ERROR_CODES.INVALID_TABLE_DEFINITION,
          "A table cannot have more than one primary key.",
          stmt.name.position,
        );
      }
      inlinePkName = column.primaryKey.name;
      inlinePkColumns = [column.name];
      stored.notNull = true;
    }
    if (column.references !== null) {
      inlineFks.push({
        name: column.references.name,
        columns: [column.name],
        reference: {
          table: column.references.table,
          columns: column.references.columns,
          onDelete: column.references.onDelete,
          onUpdate: column.references.onUpdate,
        },
      });
    }
    columns.push(stored);
  }
  assertColumnLimit(columns.length, stmt.name.position);
  assertUniqueColumns(columns.map((column) => column.name), stmt.name.position);
  return { columns, inlinePkName, inlinePkColumns, inlineFks };
}

/** CREATE TABLE 를 실행한다. */
export function executeCreateTable(
  manager: TablespaceManager,
  currentTablespace: string,
  owner: string,
  stmt: CreateTableStatement,
): void {
  const { tablespace, name } = resolveTablespace(manager, stmt.name, currentTablespace);
  const catalog = requireCatalog(manager, tablespace, stmt.name.position);
  if (objectExists(catalog.data, name)) {
    if (stmt.ifNotExists) return;
    const existing = catalog.data.tables[name] !== undefined ? "Table" : "View";
    if (existing === "Table") {
      fail("42P07", ERROR_CODES.TABLE_EXISTS, `Table already exists: "${name}".`, stmt.name.position);
    }
    fail("42P07", ERROR_CODES.VIEW_EXISTS, `A view with the same name already exists: "${name}".`, stmt.name.position);
  }
  assertNotReserved(tablespace, name, stmt.name.position);

  const parsed = parseColumnDefinitions(stmt);
  assertSinglePrimaryKey(parsed.inlinePkColumns.length > 0 ? 1 : 0, stmt.constraints, stmt.name.position);

  // 테이블 제약조건을 모은다.
  let pkName: string | null = parsed.inlinePkName;
  let pkColumns: string[] = [...parsed.inlinePkColumns];
  const fkSpecs: { name: string | null; columns: string[]; reference: import("../sql/ast.js").ForeignKeyReference }[] = [
    ...parsed.inlineFks,
  ];
  for (const constraint of stmt.constraints) {
    if (constraint.kind === "PrimaryKey") {
      if (pkColumns.length > 0) {
        fail(
          "42P16",
          ERROR_CODES.INVALID_TABLE_DEFINITION,
          "A table cannot have more than one primary key.",
          stmt.name.position,
        );
      }
      pkName = constraint.name;
      pkColumns = [...constraint.columns];
    } else {
      fkSpecs.push({ name: constraint.name, columns: [...constraint.columns], reference: constraint.reference });
    }
  }

  // 컬럼 존재와 중복을 확인한다.
  const columnMap = new Map(parsed.columns.map((column) => [column.name, column]));
  const checkColumnsExist = (columns: string[]): void => {
    for (const columnName of columns) {
      if (!columnMap.has(columnName)) {
        fail("42703", ERROR_CODES.COLUMN_NOT_FOUND, `Column does not exist: "${columnName}".`, stmt.name.position);
      }
    }
    assertUniqueColumns(columns, stmt.name.position);
  };
  if (pkColumns.length > 0) checkColumnsExist(pkColumns);
  for (const fk of fkSpecs) checkColumnsExist(fk.columns);

  // FK 참조를 검증한다. 같은 테이블스페이스 안의 PK 만 참조할 수 있다.
  const resolvedFks: { name: string; columns: string[]; refTable: string; refColumns: string[]; onDelete: import("../sql/ast.js").ReferentialAction; onUpdate: import("../sql/ast.js").ReferentialAction }[] = [];
  for (const fk of fkSpecs) {
    const refTablespace = fk.reference.table.tablespace ?? tablespace;
    if (refTablespace !== tablespace) {
      fail(
        "42P16",
        ERROR_CODES.INVALID_TABLE_DEFINITION,
        "A foreign key can only reference a table in the same tablespace.",
        stmt.name.position,
      );
    }
    const refName = fk.reference.table.name;
    // 자기 참조는 허용한다. 아직 카탈로그에 없으므로 뒤에서 따로 처리한다.
    const isSelfReference = refName === name;
    const target: StoredTable | undefined = isSelfReference
      ? undefined
      : catalog.data.tables[refName];
    if (!isSelfReference && target === undefined) {
      // 뷰는 FK 대상으로 쓸 수 없다.
      if (catalog.data.views[refName] !== undefined) {
        fail(
          "42P16",
          ERROR_CODES.INVALID_TABLE_DEFINITION,
          `A foreign key cannot reference a view: "${refName}".`,
          stmt.name.position,
        );
      }
      fail("42P01", ERROR_CODES.TABLE_NOT_FOUND, `Referenced table does not exist: "${refName}".`, stmt.name.position);
    }
    // 참조 컬럼 목록 생략은 대상 PK 이다. 자기 참조는 PK 가 아직 확정되지 않았으므로 뒤에서 처리한다.
    if (!isSelfReference && target !== undefined) {
      const resolved = resolveReference(fk.reference, target, stmt.name.position);
      // 컬럼 수와 타입이 맞아야 한다.
      if (resolved.columns.length !== fk.columns.length) {
        fail(
          "42P16",
          ERROR_CODES.INVALID_TABLE_DEFINITION,
          "Foreign key column count must match the referenced primary key.",
          stmt.name.position,
        );
      }
      for (let i = 0; i < fk.columns.length; i++) {
        const from = columnMap.get(fk.columns[i] as string);
        const toIndex = target.pkColumns.indexOf(resolved.columns[i] as string);
        if (toIndex < 0) {
          fail(
            "42P16",
            ERROR_CODES.INVALID_TABLE_DEFINITION,
            "Foreign key must reference the primary key columns.",
            stmt.name.position,
          );
        }
        const toColumn = target.columns.find((column) => column.name === resolved.columns[i]);
        if (from === undefined || toColumn === undefined) {
          fail("42703", ERROR_CODES.COLUMN_NOT_FOUND, "Foreign key column does not exist.", stmt.name.position);
        }
        if (!dataTypesMatch((from as StoredColumn).dataType, (toColumn as StoredColumn).dataType)) {
          fail(
            "42P16",
            ERROR_CODES.INVALID_TABLE_DEFINITION,
            "Foreign key column type must match the referenced column type.",
            stmt.name.position,
          );
        }
      }
      const constraintName = catalog.resolveConstraintName(fk.name, "FOREIGN KEY", name, stmt.name.position);
      resolvedFks.push({
        name: constraintName,
        columns: [...fk.columns],
        refTable: refName,
        refColumns: [...resolved.columns],
        onDelete: resolved.onDelete,
        onUpdate: resolved.onUpdate,
      });
    } else {
      // 자기 참조는 PK 확정 뒤에 검증한다. 표식으로 남긴다.
      const constraintName = catalog.resolveConstraintName(fk.name, "FOREIGN KEY", name, stmt.name.position);
      resolvedFks.push({
        name: constraintName,
        columns: [...fk.columns],
        refTable: refName,
        refColumns: fk.reference.columns ?? [],
        onDelete: fk.reference.onDelete ?? "NO ACTION",
        onUpdate: fk.reference.onUpdate ?? "NO ACTION",
      });
    }
  }

  // PK 이름을 정한다.
  let finalPkName: string | null = null;
  if (pkColumns.length > 0) {
    finalPkName = catalog.resolveConstraintName(pkName, "PRIMARY KEY", name, stmt.name.position);
    assertNotReserved(tablespace, finalPkName, stmt.name.position);
    // PK 컬럼은 NOT NULL 이다.
    for (const column of parsed.columns) {
      if (pkColumns.includes(column.name)) column.notNull = true;
    }
  }

  // 자기 참조 FK 의 생략된 컬럼 목록과 타입을 확정한다.
  for (const fk of resolvedFks) {
    if (fk.refTable === name && fk.refColumns.length === 0) {
      if (pkColumns.length === 0) {
        fail(
          "42P16",
          ERROR_CODES.INVALID_TABLE_DEFINITION,
          `Referenced table "${name}" has no primary key.`,
          stmt.name.position,
        );
      }
      fk.refColumns = [...pkColumns];
    }
    if (fk.refTable === name) {
      if (fk.refColumns.length !== fk.columns.length) {
        fail(
          "42P16",
          ERROR_CODES.INVALID_TABLE_DEFINITION,
          "Foreign key column count must match the referenced primary key.",
          stmt.name.position,
        );
      }
      for (let i = 0; i < fk.columns.length; i++) {
        const from = columnMap.get(fk.columns[i] as string);
        const toName = fk.refColumns[i] as string;
        if (!pkColumns.includes(toName)) {
          fail(
            "42P16",
            ERROR_CODES.INVALID_TABLE_DEFINITION,
            "Foreign key must reference the primary key columns.",
            stmt.name.position,
          );
        }
        const toColumn = parsed.columns.find((column) => column.name === toName);
        if (from === undefined || toColumn === undefined) {
          fail("42703", ERROR_CODES.COLUMN_NOT_FOUND, "Foreign key column does not exist.", stmt.name.position);
        }
        if (!dataTypesMatch((from as StoredColumn).dataType, (toColumn as StoredColumn).dataType)) {
          fail(
            "42P16",
            ERROR_CODES.INVALID_TABLE_DEFINITION,
            "Foreign key column type must match the referenced column type.",
            stmt.name.position,
          );
        }
      }
    }
    assertNotReserved(tablespace, fk.name, stmt.name.position);
  }

  // 저장소에 힙과 PK 유일 인덱스를 만들고 카탈로그를 함께 쓴다.
  const space = catalog.space;
  const batch: StorageBatch = space.begin();
  try {
    const heapRoot = batch.createHeap();
    let pkIndexRoot: number | null = null;
    if (finalPkName !== null) {
      pkIndexRoot = batch.createIndex({ unique: true });
    }
    const table: StoredTable = {
      name,
      owner,
      columns: parsed.columns,
      heapRoot,
      pkName: finalPkName,
      pkColumns: [...pkColumns],
      pkIndexRoot,
    };
    catalog.data.tables[name] = table;
    if (finalPkName !== null) {
      const constraint: StoredConstraint = {
        name: finalPkName,
        table: name,
        kind: "PRIMARY KEY",
        columns: [...pkColumns],
        refTable: null,
        refColumns: null,
        onDelete: "NO ACTION",
        onUpdate: "NO ACTION",
        indexRoot: pkIndexRoot,
      };
      catalog.data.constraints[finalPkName] = constraint;
    }
    for (const fk of resolvedFks) {
      const constraint: StoredConstraint = {
        name: fk.name,
        table: name,
        kind: "FOREIGN KEY",
        columns: [...fk.columns],
        refTable: fk.refTable,
        refColumns: [...fk.refColumns],
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
        indexRoot: null,
      };
      catalog.data.constraints[fk.name] = constraint;
    }
    batch.setCatalog(serializeCatalog(catalog.data));
    batch.commit();
  } catch (error) {
    try {
      batch.rollback();
    } catch {
      // 원래 오류를 유지한다.
    }
    // 배치 실패 뒤 메모리의 카탈로그를 되돌린다. (같은 프로세스 안에서만 쓴다)
    delete catalog.data.tables[name];
    if (finalPkName !== null) delete catalog.data.constraints[finalPkName];
    for (const fk of resolvedFks) delete catalog.data.constraints[fk.name];
    throw error;
  }
}

// ---------------------------------------------------------------------------
// ALTER TABLE
// ---------------------------------------------------------------------------

/** ALTER TABLE 를 실행한다. */
export function executeAlterTable(
  manager: TablespaceManager,
  currentTablespace: string,
  _owner: string,
  stmt: AlterTableStatement,
  ctx: QueryContext,
): void {
  const { tablespace, name } = resolveTablespace(manager, stmt.name, currentTablespace);
  assertNotDictionaryObject(manager, tablespace, name, stmt.name.position);
  const catalog = requireCatalog(manager, tablespace, stmt.name.position);
  const action = stmt.action;
  switch (action.kind) {
    case "AddColumn": {
      addColumn(manager, catalog, tablespace, name, action.column, ctx, stmt.name.position);
      return;
    }
    case "DropColumn": {
      dropColumn(manager, catalog, tablespace, name, action.column, stmt.name.position);
      return;
    }
    case "AlterColumn": {
      alterColumn(manager, catalog, tablespace, name, action.column, action.change, stmt.name.position);
      return;
    }
    case "RenameColumn": {
      renameColumn(manager, catalog, tablespace, name, action.column, action.newName, stmt.name.position);
      return;
    }
    case "RenameTable": {
      renameTable(manager, catalog, tablespace, name, action.newName, stmt.name.position);
      return;
    }
    case "AddConstraint": {
      addConstraint(manager, catalog, tablespace, name, action.constraint, stmt.name.position);
      return;
    }
    case "DropConstraint": {
      dropConstraint(catalog, tablespace, name, action.name, stmt.name.position);
      return;
    }
  }
}

function persistCatalog(catalog: CatalogStore): void {
  catalog.save();
}

/**
 * 기존 행을 모두 새 모양으로 다시 쓴다. 힙을 새로 만들고 PK 와 인덱스를 다시 쌓는다.
 * 행 식별자가 바뀌므로 인덱스도 함께 만든다. 실패하면 메모리의 카탈로그를 원래대로 돌린다.
 * 컬럼 삭제와 DEFAULT 가 있는 컬럼 추가가 쓴다.
 */
function rewriteTableRows(
  catalog: CatalogStore,
  table: StoredTable,
  nextColumns: StoredColumn[],
  stored: { id: import("../storage/format/format.js").RowId; data: Buffer }[],
  transform: (values: SqlValue[]) => SqlValue[],
): void {
  const oldColumns = table.columns;
  const oldTypes = oldColumns.map((column) => column.dataType);
  const newTypes = nextColumns.map((column) => column.dataType);
  const tableIndexes = Object.values(catalog.data.indexes).filter((entry) => entry.table === table.name);
  const savedHeapRoot = table.heapRoot;
  const savedPkRoot = table.pkIndexRoot;
  const savedIndexRoots = new Map(tableIndexes.map((entry) => [entry.name, entry.indexRoot]));
  const batch = catalog.space.begin();
  try {
    batch.dropHeap(table.heapRoot);
    for (const entry of tableIndexes) batch.dropIndex(entry.indexRoot);
    if (table.pkIndexRoot !== null) batch.dropIndex(table.pkIndexRoot);
    const heapRoot = batch.createHeap();
    const newIds: import("../storage/format/format.js").RowId[] = [];
    const newRows: SqlValue[][] = [];
    for (const row of stored) {
      const values = transform(decodeRow(row.data, oldTypes));
      newIds.push(batch.heap(heapRoot).insert(encodeRow(values, newTypes)));
      newRows.push(values);
    }
    table.heapRoot = heapRoot;
    table.columns = nextColumns;
    const keyOf = (values: SqlValue[], columns: { name: string; descending: boolean }[]): Buffer => {
      const keyColumns = columns.map((column) => {
        const found = nextColumns.find((entry) => entry.name === column.name);
        return { type: (found as StoredColumn).dataType, descending: column.descending };
      });
      const keyValues = columns.map((column) => {
        const at = nextColumns.findIndex((entry) => entry.name === column.name);
        return (values[at] ?? null) as SqlValue;
      });
      return encodeKey(keyValues, keyColumns);
    };
    if (savedPkRoot !== null) {
      const pkRoot = batch.createIndex({ unique: true });
      table.pkIndexRoot = pkRoot;
      if (table.pkName !== null) {
        const constraint = catalog.data.constraints[table.pkName];
        if (constraint !== undefined) constraint.indexRoot = pkRoot;
      }
      const pkColumns = (table.pkColumns as string[]).map((name) => ({ name, descending: false }));
      newRows.forEach((values, position) => {
        batch.index(pkRoot).insert(keyOf(values, pkColumns), newIds[position] as import("../storage/format/format.js").RowId);
      });
    }
    for (const entry of tableIndexes) {
      const root = batch.createIndex({ unique: false });
      entry.indexRoot = root;
      newRows.forEach((values, position) => {
        batch.index(root).insert(keyOf(values, entry.columns), newIds[position] as import("../storage/format/format.js").RowId);
      });
    }
    batch.setCatalog(serializeCatalog(catalog.data));
    batch.commit();
  } catch (error) {
    table.heapRoot = savedHeapRoot;
    table.pkIndexRoot = savedPkRoot;
    table.columns = oldColumns;
    if (table.pkName !== null) {
      const constraint = catalog.data.constraints[table.pkName];
      if (constraint !== undefined) constraint.indexRoot = savedPkRoot;
    }
    for (const entry of tableIndexes) {
      const saved = savedIndexRoots.get(entry.name);
      if (saved !== undefined) entry.indexRoot = saved;
    }
    try {
      batch.rollback();
    } catch {
      // 원래 오류를 유지한다.
    }
    throw error;
  }
}

/** ADD COLUMN 의 DEFAULT 를 한 번 계산한다. 기존 행은 모두 이 값으로 채운다. 없으면 NULL 이다. */
function evaluateAddedColumnDefault(column: StoredColumn, ctx: QueryContext, position?: SourcePosition): SqlValue {
  if (column.defaultExpr === null) return null;
  const bound = evaluateExpression(
    column.defaultExpr,
    {
      typeCtx: ctx.typeCtx,
      params: ctx.params,
      scopes: [...ctx.outerScopes],
      currentUser: ctx.currentUser,
      subqueries: dataHandlers([], ctx),
      typeSubqueries: typeHandlers(ctx),
    },
    column.dataType,
  );
  if (bound.value === null) return null;
  if (!isImplicitlyConvertible(bound.type, column.dataType)) {
    fail("42804", 2011, `Cannot convert ${bound.type.name} to ${column.dataType.name} implicitly; use CAST.`, position);
  }
  return assignValue(bound.value, bound.type, column.dataType, ctx.typeCtx);
}

function addColumn(
  _manager: TablespaceManager,
  catalog: CatalogStore,
  tablespace: string,
  tableName: string,
  columnDef: import("../sql/ast.js").ColumnDefinition,
  ctx: QueryContext,
  position?: SourcePosition,
): void {
  const columnPosition = position;
  const table = catalog.requireTable(tableName);
  if (table.columns.some((column) => column.name === columnDef.name)) {
    fail("42701", ERROR_CODES.COLUMN_EXISTS, `Duplicate column name: "${columnDef.name}".`, columnPosition);
  }
  assertNotReserved(tablespace, columnDef.name, columnPosition);
  const added: StoredColumn = {
    name: columnDef.name,
    dataType: columnDef.dataType,
    defaultText: columnDef.default === null ? null : expressionText(columnDef.default),
    defaultExpr: columnDef.default,
    notNull: columnDef.notNull,
  };
  const next: StoredColumn[] = [...table.columns, added];
  assertColumnLimit(next.length, columnPosition);
  const stored = catalog.space.heap(table.heapRoot).scan();
  const hasRows = stored.length > 0;
  // 컬럼에 붙은 PK 와 FK 는 ADD CONSTRAINT 와 같이 처리한다.
  if (columnDef.primaryKey !== null) {
    if (table.pkName !== null) {
      fail("42P16", ERROR_CODES.INVALID_TABLE_DEFINITION, "A table cannot have more than one primary key.", columnPosition);
    }
    // 새로 넣는 PK 컬럼은 NOT NULL이므로 기존 행이 있으면 위반이다.
    if (hasRows) {
      fail("23502", ERROR_CODES.NOT_NULL_VIOLATION, `NULL violates NOT NULL of column "${columnDef.name}".`, columnPosition);
    }
    const pkName = catalog.resolveConstraintName(columnDef.primaryKey.name, "PRIMARY KEY", tableName, columnPosition);
    const space = catalog.space;
    const batch = space.begin();
    const savedColumns = table.columns;
    try {
      const indexRoot = batch.createIndex({ unique: true });
      table.columns = next;
      added.notNull = true;
      table.pkName = pkName;
      table.pkColumns = [columnDef.name];
      table.pkIndexRoot = indexRoot;
      catalog.data.constraints[pkName] = {
        name: pkName,
        table: tableName,
        kind: "PRIMARY KEY",
        columns: [columnDef.name],
        refTable: null,
        refColumns: null,
        onDelete: "NO ACTION",
        onUpdate: "NO ACTION",
        indexRoot,
      };
      batch.setCatalog(serializeCatalog(catalog.data));
      batch.commit();
    } catch (error) {
      table.columns = savedColumns;
      table.pkName = null;
      table.pkColumns = [];
      table.pkIndexRoot = null;
      delete catalog.data.constraints[pkName];
      try {
        batch.rollback();
      } catch {
        // 원래 오류를 유지한다.
      }
      throw error;
    }
    return;
  }
  // 기존 행에 채울 값이다. DEFAULT 는 한 번 계산해 모든 기존 행에 같은 값을 넣는다.
  const fill = hasRows ? evaluateAddedColumnDefault(added, ctx, columnPosition) : null;
  if (hasRows && columnDef.notNull && fill === null) {
    fail("23502", ERROR_CODES.NOT_NULL_VIOLATION, `NULL violates NOT NULL of column "${columnDef.name}".`, columnPosition);
  }
  if (columnDef.references !== null) {
    if (fill !== null) {
      throw unsupportedFeature("ADD COLUMN with REFERENCES and a non-NULL DEFAULT is not supported on a table that has rows.");
    }
    // 새로 넣는 컬럼은 기존 행에서 NULL 로 읽히므로 FK 검사를 건너뛴다.
    const savedColumns = table.columns;
    table.columns = next;
    try {
      addConstraint(_manager, catalog, tablespace, tableName, {
        kind: "ForeignKey",
        name: columnDef.references.name,
        columns: [columnDef.name],
        reference: {
          table: columnDef.references.table,
          columns: columnDef.references.columns,
          onDelete: columnDef.references.onDelete,
          onUpdate: columnDef.references.onUpdate,
        },
      }, columnPosition);
    } catch (error) {
      table.columns = savedColumns;
      throw error;
    }
    return;
  }
  if (fill !== null) {
    // 기존 행에도 DEFAULT 값이 보이도록 행을 다시 쓴다.
    rewriteTableRows(catalog, table, next, stored, (values) => {
      const widened = [...values];
      widened.push(fill);
      return widened;
    });
    return;
  }
  const savedColumns = table.columns;
  table.columns = next;
  try {
    persistCatalog(catalog);
  } catch (error) {
    table.columns = savedColumns;
    throw error;
  }
}

function dropColumn(
  manager: TablespaceManager,
  catalog: CatalogStore,
  tablespace: string,
  tableName: string,
  columnName: string,
  position?: SourcePosition,
): void {
  const table = catalog.requireTable(tableName, position);
  const index = table.columns.findIndex((column) => column.name === columnName);
  if (index < 0) {
    fail("42703", ERROR_CODES.COLUMN_NOT_FOUND, `Column does not exist: "${columnName}".`, position);
  }
  const usage = catalog.isColumnUsed(tableName, columnName);
  if (usage.used) {
    fail(
      "55006",
      ERROR_CODES.OBJECT_IN_USE,
      `Column "${columnName}" is used by ${usage.reason}; cannot drop it.`,
      position,
    );
  }
  // 뷰가 이 테이블을 참조하면 보수적으로 막는다. (컬럼 단위 추적은 하지 않는다)
  const dependentViews = findDependentViews(manager, tablespace, tableName);
  if (dependentViews.length > 0) {
    fail(
      "55006",
      ERROR_CODES.OBJECT_IN_USE,
      `Column "${columnName}" is referenced by view "${dependentViews[0]}"; cannot drop it.`,
      position,
    );
  }
  // 행이 있으면 그 컬럼 값을 빼고 힙을 다시 쓴다. 남은 인덱스는 이 컬럼을 쓰지 않는다.
  const nextColumns = table.columns.filter((_, at) => at !== index);
  const stored = catalog.space.heap(table.heapRoot).scan();
  if (stored.length === 0) {
    const savedColumns = table.columns;
    table.columns = nextColumns;
    try {
      persistCatalog(catalog);
    } catch (error) {
      table.columns = savedColumns;
      throw error;
    }
    return;
  }
  rewriteTableRows(catalog, table, nextColumns, stored, (values) => {
    const narrowed = [...values];
    narrowed.splice(index, 1);
    return narrowed;
  });
}

function alterColumn(
  _manager: TablespaceManager,
  catalog: CatalogStore,
  _tablespace: string,
  tableName: string,
  columnName: string,
  change: import("../sql/ast.js").AlterColumnChange,
  position?: SourcePosition,
): void {
  const table = catalog.requireTable(tableName, position);
  const column = table.columns.find((entry) => entry.name === columnName);
  if (column === undefined) {
    fail("42703", ERROR_CODES.COLUMN_NOT_FOUND, `Column does not exist: "${columnName}".`, position);
  }
  const target = column as StoredColumn;
  switch (change.kind) {
    case "SetDefault":
      target.defaultText = expressionText(change.expression);
      target.defaultExpr = change.expression;
      break;
    case "DropDefault":
      target.defaultText = null;
      target.defaultExpr = null;
      break;
    case "SetNotNull": {
      // 기존 행에 NULL이 있으면 실패한다.
      const columnIndex = table.columns.findIndex((entry) => entry.name === columnName);
      const types = table.columns.map((entry) => entry.dataType);
      for (const row of catalog.space.heap(table.heapRoot).scan()) {
        const values = decodeRow(row.data, types);
        if ((values[columnIndex] ?? null) === null) {
          fail("23502", ERROR_CODES.NOT_NULL_VIOLATION, `NULL violates NOT NULL of column "${columnName}".`, position);
        }
      }
      target.notNull = true;
      break;
    }
    case "DropNotNull": {
      if (table.pkColumns.includes(columnName)) {
        fail(
          "42P16",
          ERROR_CODES.INVALID_TABLE_DEFINITION,
          `Primary key column "${columnName}" cannot drop NOT NULL.`,
          position,
        );
      }
      target.notNull = false;
      break;
    }
  }
  persistCatalog(catalog);
}

function renameColumn(
  manager: TablespaceManager,
  catalog: CatalogStore,
  _tablespace: string,
  tableName: string,
  columnName: string,
  newName: string,
  position?: SourcePosition,
): void {
  const table = catalog.requireTable(tableName, position);
  const column = table.columns.find((entry) => entry.name === columnName);
  if (column === undefined) {
    fail("42703", ERROR_CODES.COLUMN_NOT_FOUND, `Column does not exist: "${columnName}".`, position);
  }
  if (table.columns.some((entry) => entry.name === newName)) {
    fail("42701", ERROR_CODES.COLUMN_EXISTS, `Duplicate column name: "${newName}".`, position);
  }
  const usage = catalog.isColumnUsed(tableName, columnName);
  if (usage.used) {
    fail(
      "55006",
      ERROR_CODES.OBJECT_IN_USE,
      `Column "${columnName}" is used by ${usage.reason}; cannot rename it.`,
      position,
    );
  }
  const dependentViews = findDependentViews(manager, (column as StoredColumn) !== undefined ? catalog.tablespaceName : "", tableName);
  if (dependentViews.length > 0) {
    fail(
      "55006",
      ERROR_CODES.OBJECT_IN_USE,
      `Column "${columnName}" is referenced by view "${dependentViews[0]}"; cannot rename it.`,
      position,
    );
  }
  (column as StoredColumn).name = newName;
  persistCatalog(catalog);
}

function renameTable(
  manager: TablespaceManager,
  catalog: CatalogStore,
  tablespace: string,
  tableName: string,
  newName: string,
  position?: SourcePosition,
): void {
  const table = catalog.requireTable(tableName, position);
  if (objectExists(catalog.data, newName)) {
    fail("42P07", ERROR_CODES.TABLE_EXISTS, `An object with the same name already exists: "${newName}".`, position);
  }
  assertNotReserved(tablespace, newName, position);
  // 참조하는 FK 나 뷰가 있으면 보수적으로 막지 않고 이름을 따라 고친다.
  // 뷰의 queryText 는 그대로 두므로, 이름이 바뀐 뒤 뷰는 다시 만들도록 안내한다.
  const referencing = catalog.findReferencingForeignKeys(tableName);
  const dependentViews = findDependentViews(manager, tablespace, tableName);
  void dependentViews;
  const oldHeap = table.heapRoot;
  void oldHeap;
  delete catalog.data.tables[tableName];
  table.name = newName;
  catalog.data.tables[newName] = table;
  // 이 테이블이 가진 제약조건과 인덱스의 테이블 이름을 고친다.
  for (const constraint of Object.values(catalog.data.constraints)) {
    if (constraint.table === tableName) constraint.table = newName;
    if (constraint.refTable === tableName) constraint.refTable = newName;
  }
  for (const index of Object.values(catalog.data.indexes)) {
    if (index.table === tableName) index.table = newName;
  }
  persistCatalog(catalog);
}

/** 값 묶음을 비교용 문자열로 바꾼다. 인덱스 키와 같은 인코딩이라 CHAR 의 뒤쪽 공백은 무시한다. */
function tupleKeyText(values: SqlValue[], types: DataType[]): string {
  return encodeKey(values, types.map((type) => ({ type, descending: false }))).toString("latin1");
}

/** 기존 행이 PK 조건(NULL 없음, 중복 없음)을 만족하는지 본다. */
function checkRowsForPrimaryKey(
  catalog: CatalogStore,
  table: StoredTable,
  pkColumns: string[],
  position?: SourcePosition,
): void {
  const types = table.columns.map((column) => column.dataType);
  const pkTypes = pkColumns.map((columnName) => {
    const found = table.columns.find((column) => column.name === columnName);
    return (found as StoredColumn).dataType;
  });
  const seen = new Set<string>();
  for (const stored of catalog.space.heap(table.heapRoot).scan()) {
    const values = decodeRow(stored.data, types);
    const key = pkColumns.map((columnName) => {
      const index = table.columns.findIndex((column) => column.name === columnName);
      return (values[index] ?? null) as SqlValue;
    });
    if (key.some((value) => value === null)) {
      fail("23502", ERROR_CODES.NOT_NULL_VIOLATION, "NULL violates NOT NULL of a primary key column.", position);
    }
    const text = tupleKeyText(key, pkTypes);
    if (seen.has(text)) {
      fail("23505", ERROR_CODES.DUPLICATE_KEY, `Duplicate primary key in table "${table.name}".`, position);
    }
    seen.add(text);
  }
}

/** 기존 행이 FK를 어기지 않는지 본다. NULL이 섞인 행은 건너뛴다. */
function checkRowsForForeignKey(
  catalog: CatalogStore,
  table: StoredTable,
  fkColumns: string[],
  refTable: StoredTable,
  refColumns: string[],
  position?: SourcePosition,
): void {
  const types = table.columns.map((column) => column.dataType);
  const refTypes = refTable.columns.map((column) => column.dataType);
  const parentTypes = refColumns.map((columnName) => {
    const found = refTable.columns.find((column) => column.name === columnName);
    return (found as StoredColumn).dataType;
  });
  const parentKeys = new Set<string>();
  for (const stored of catalog.space.heap(refTable.heapRoot).scan()) {
    const values = decodeRow(stored.data, refTypes);
    const key = refColumns.map((columnName) => {
      const index = refTable.columns.findIndex((column) => column.name === columnName);
      return (values[index] ?? null) as SqlValue;
    });
    parentKeys.add(tupleKeyText(key, parentTypes));
  }
  for (const stored of catalog.space.heap(table.heapRoot).scan()) {
    const values = decodeRow(stored.data, types);
    const key = fkColumns.map((columnName) => {
      const index = table.columns.findIndex((column) => column.name === columnName);
      return (values[index] ?? null) as SqlValue;
    });
    if (key.some((value) => value === null)) continue;
    if (!parentKeys.has(tupleKeyText(key, parentTypes))) {
      fail("23503", ERROR_CODES.FOREIGN_KEY_VIOLATION, "Existing rows violate the foreign key.", position);
    }
  }
}

function addConstraint(
  _manager: TablespaceManager,
  catalog: CatalogStore,
  tablespace: string,
  tableName: string,
  constraint: TableConstraint,
  position?: SourcePosition,
): void {
  const table = catalog.requireTable(tableName, position);
  if (constraint.kind === "PrimaryKey") {
    if (table.pkName !== null) {
      fail("42P16", ERROR_CODES.INVALID_TABLE_DEFINITION, "A table cannot have more than one primary key.", position);
    }
    for (const columnName of constraint.columns) {
      if (!table.columns.some((column) => column.name === columnName)) {
        fail("42703", ERROR_CODES.COLUMN_NOT_FOUND, `Column does not exist: "${columnName}".`, position);
      }
    }
    assertUniqueColumns(constraint.columns, position);
    const pkName = catalog.resolveConstraintName(constraint.name, "PRIMARY KEY", tableName, position);
    assertNotReserved(tablespace, pkName, position);
    // 기존 행을 검사한다. NULL이 있으면 23502, 중복이면 23505이다.
    checkRowsForPrimaryKey(catalog, table, constraint.columns, position);
    const space = catalog.space;
    const batch = space.begin();
    try {
      const indexRoot = batch.createIndex({ unique: true });
      // 유일 인덱스에 기존 키를 넣는다. 겹치면 저장 계층이 23505로 막는다.
      const keyColumns = constraint.columns.map((columnName) => {
        const found = table.columns.find((column) => column.name === columnName);
        return { type: (found as StoredColumn).dataType, descending: false };
      });
      const types = table.columns.map((column) => column.dataType);
      for (const stored of space.heap(table.heapRoot).scan()) {
        const values = decodeRow(stored.data, types);
        const keyValues = constraint.columns.map((columnName) => {
          const index = table.columns.findIndex((column) => column.name === columnName);
          return (values[index] ?? null) as import("../types/value.js").SqlValue;
        });
        batch.index(indexRoot).insert(encodeKey(keyValues, keyColumns), stored.id);
      }
      table.pkName = pkName;
      table.pkColumns = [...constraint.columns];
      table.pkIndexRoot = indexRoot;
      for (const columnName of constraint.columns) {
        table.columns.find((column) => column.name === columnName)!.notNull = true;
      }
      catalog.data.constraints[pkName] = {
        name: pkName,
        table: tableName,
        kind: "PRIMARY KEY",
        columns: [...constraint.columns],
        refTable: null,
        refColumns: null,
        onDelete: "NO ACTION",
        onUpdate: "NO ACTION",
        indexRoot,
      };
      batch.setCatalog(serializeCatalog(catalog.data));
      batch.commit();
    } catch (error) {
      try {
        batch.rollback();
      } catch {
        // 원래 오류를 유지한다.
      }
      throw error;
    }
    return;
  }
  // ForeignKey
  for (const columnName of constraint.columns) {
    if (!table.columns.some((column) => column.name === columnName)) {
      fail("42703", ERROR_CODES.COLUMN_NOT_FOUND, `Column does not exist: "${columnName}".`, position);
    }
  }
  assertUniqueColumns(constraint.columns, position);
  const refTablespace = constraint.reference.table.tablespace ?? tablespace;
  if (refTablespace !== tablespace) {
    fail(
      "42P16",
      ERROR_CODES.INVALID_TABLE_DEFINITION,
      "A foreign key can only reference a table in the same tablespace.",
      position,
    );
  }
  const refTable = catalog.data.tables[constraint.reference.table.name];
  if (refTable === undefined) {
    fail(
      "42P01",
      ERROR_CODES.TABLE_NOT_FOUND,
      `Referenced table does not exist: "${constraint.reference.table.name}".`,
      position,
    );
  }
  const resolved = resolveReference(constraint.reference, refTable, position);
  if (resolved.columns.length !== constraint.columns.length) {
    fail(
      "42P16",
      ERROR_CODES.INVALID_TABLE_DEFINITION,
      "Foreign key column count must match the referenced primary key.",
      position,
    );
  }
  const columnMap = new Map(table.columns.map((column) => [column.name, column]));
  for (let i = 0; i < constraint.columns.length; i++) {
    const from = columnMap.get(constraint.columns[i] as string);
    const toColumn = refTable.columns.find((column) => column.name === resolved.columns[i]);
    if (from === undefined || toColumn === undefined) {
      fail("42703", ERROR_CODES.COLUMN_NOT_FOUND, "Foreign key column does not exist.", position);
    }
    if (!dataTypesMatch((from as StoredColumn).dataType, (toColumn as StoredColumn).dataType)) {
      fail(
        "42P16",
        ERROR_CODES.INVALID_TABLE_DEFINITION,
        "Foreign key column type must match the referenced column type.",
        position,
      );
    }
  }
  const fkName = catalog.resolveConstraintName(constraint.name, "FOREIGN KEY", tableName, position);
  assertNotReserved(tablespace, fkName, position);
  // 기존 행이 참조 무결성을 어기면 실패한다. NULL이 섞인 행은 건너뛴다.
  checkRowsForForeignKey(catalog, table, constraint.columns, refTable, resolved.columns, position);
  catalog.data.constraints[fkName] = {
    name: fkName,
    table: tableName,
    kind: "FOREIGN KEY",
    columns: [...constraint.columns],
    refTable: refTable.name,
    refColumns: [...resolved.columns],
    onDelete: resolved.onDelete,
    onUpdate: resolved.onUpdate,
    indexRoot: null,
  };
  persistCatalog(catalog);
}

function dropConstraint(
  catalog: CatalogStore,
  _tablespace: string,
  tableName: string,
  constraintName: string,
  position?: SourcePosition,
): void {
  catalog.requireTable(tableName, position);
  const constraint = catalog.data.constraints[constraintName];
  if (constraint === undefined || constraint.table !== tableName) {
    fail("42704", ERROR_CODES.CONSTRAINT_NOT_FOUND, `Constraint does not exist: "${constraintName}".`, position);
  }
  const target = constraint as StoredConstraint;
  if (target.kind === "PRIMARY KEY") {
    // 다른 테이블의 FK 가 참조하면 막는다.
    const referencing = catalog.findReferencingForeignKeys(tableName);
    if (referencing.length > 0) {
      fail(
        "55006",
        ERROR_CODES.OBJECT_IN_USE,
        `Primary key is referenced by constraint "${referencing[0]?.name}"; cannot drop it.`,
        position,
      );
    }
    const space = catalog.space;
    const batch = space.begin();
    try {
      if (target.indexRoot !== null) batch.dropIndex(target.indexRoot);
      const table = catalog.requireTable(tableName);
      table.pkName = null;
      table.pkColumns = [];
      table.pkIndexRoot = null;
      delete catalog.data.constraints[constraintName];
      batch.setCatalog(serializeCatalog(catalog.data));
      batch.commit();
    } catch (error) {
      try {
        batch.rollback();
      } catch {
        // 원래 오류를 유지한다.
      }
      throw error;
    }
    return;
  }
  delete catalog.data.constraints[constraintName];
  persistCatalog(catalog);
}

// ---------------------------------------------------------------------------
// DROP TABLE, TRUNCATE
// ---------------------------------------------------------------------------

/** 이 테이블을 참조하는 뷰를 모든 테이블스페이스에서 찾는다. */
function findDependentViews(manager: TablespaceManager, tablespace: string, tableName: string): string[] {
  const result: string[] = [];
  for (const candidateSpace of manager.listNames()) {
    let catalog;
    try {
      catalog = manager.requireCatalog(candidateSpace);
    } catch {
      continue;
    }
    for (const view of Object.values(catalog.data.views)) {
      if (view.dependencies.some((dep) => dep.tablespace === tablespace && dep.name === tableName)) {
        result.push(`${candidateSpace}.${view.name}`);
      }
    }
  }
  return result;
}

/** CASCADE 로 딸린 뷰를 함께 지운다. */
function dropDependentViews(manager: TablespaceManager, tablespace: string, tableName: string): void {
  for (const candidateSpace of manager.listNames()) {
    let catalog;
    try {
      catalog = manager.requireCatalog(candidateSpace);
    } catch {
      continue;
    }
    const victims = Object.values(catalog.data.views).filter((view) =>
      view.dependencies.some((dep) => dep.tablespace === tablespace && dep.name === tableName),
    );
    for (const victim of victims) {
      // 재귀로 그 뷰에 딸린 뷰까지 지운다.
      dropDependentViews(manager, candidateSpace, victim.name);
      const fresh = manager.requireCatalog(candidateSpace);
      delete fresh.data.views[victim.name];
      fresh.save();
    }
  }
}

/** DROP TABLE 를 실행한다. */
export function executeDropTable(
  manager: TablespaceManager,
  currentTablespace: string,
  stmt: DropTableStatement,
): void {
  const { tablespace, name } = resolveTablespace(manager, stmt.name, currentTablespace);
  assertNotDictionaryObject(manager, tablespace, name, stmt.name.position);
  const catalog = requireCatalog(manager, tablespace, stmt.name.position);
  const table = catalog.data.tables[name];
  if (table === undefined) {
    if (catalog.data.views[name] !== undefined) {
      fail(
        "42P01",
        ERROR_CODES.TABLE_NOT_FOUND,
        `"${name}" is a view; use DROP VIEW to drop it.`,
        stmt.name.position,
      );
    }
    if (stmt.ifExists) return;
    fail("42P01", ERROR_CODES.TABLE_NOT_FOUND, `Table does not exist: "${name}".`, stmt.name.position);
  }
  const behavior = stmt.behavior ?? "RESTRICT";
  const referencing = catalog.findReferencingForeignKeys(name);
  const dependentViews = findDependentViews(manager, tablespace, name);
  if (behavior === "RESTRICT") {
    if (referencing.length > 0) {
      fail(
        "55006",
        ERROR_CODES.OBJECT_IN_USE,
        `Table "${name}" is referenced by constraint "${referencing[0]?.name}".`,
        stmt.name.position,
      );
    }
    if (dependentViews.length > 0) {
      fail(
        "55006",
        ERROR_CODES.OBJECT_IN_USE,
        `Table "${name}" is referenced by view "${dependentViews[0]}".`,
        stmt.name.position,
      );
    }
  } else {
    // CASCADE : 참조하는 FK 제약조건을 함께 지운다.
    for (const fk of referencing) {
      delete catalog.data.constraints[fk.name];
    }
    dropDependentViews(manager, tablespace, name);
  }
  const target = table as StoredTable;
  const space = catalog.space;
  const batch = space.begin();
  try {
    // 이 테이블의 인덱스와 힙을 함께 지운다.
    for (const index of Object.values(catalog.data.indexes)) {
      if (index.table === name) {
        batch.dropIndex(index.indexRoot);
        delete catalog.data.indexes[index.name];
      }
    }
    if (target.pkIndexRoot !== null) batch.dropIndex(target.pkIndexRoot);
    batch.dropHeap(target.heapRoot);
    if (target.pkName !== null) delete catalog.data.constraints[target.pkName];
    // 이 테이블이 가진 FK 를 지운다.
    for (const constraint of Object.values(catalog.data.constraints)) {
      if (constraint.table === name) delete catalog.data.constraints[constraint.name];
    }
    delete catalog.data.tables[name];
    batch.setCatalog(serializeCatalog(catalog.data));
    batch.commit();
  } catch (error) {
    try {
      batch.rollback();
    } catch {
      // 원래 오류를 유지한다.
    }
    throw error;
  }
}

/** TRUNCATE 를 실행한다. 5단계에서는 정의만 남기고 행은 비운다. */
export function executeTruncateTable(
  manager: TablespaceManager,
  currentTablespace: string,
  stmt: TruncateTableStatement,
): void {
  const { tablespace, name } = resolveTablespace(manager, stmt.name, currentTablespace);
  assertNotDictionaryObject(manager, tablespace, name, stmt.name.position);
  const catalog = requireCatalog(manager, tablespace, stmt.name.position);
  const table = catalog.data.tables[name];
  if (table === undefined) {
    fail("42P01", ERROR_CODES.TABLE_NOT_FOUND, `Table does not exist: "${name}".`, stmt.name.position);
  }
  const target = table as StoredTable;
  const space = catalog.space;
  const batch = space.begin();
  try {
    // 힙을 비우고 PK 와 일반 인덱스도 함께 비운다.
    batch.dropHeap(target.heapRoot);
    const heapRoot = batch.createHeap();
    target.heapRoot = heapRoot;
    if (target.pkIndexRoot !== null) {
      batch.dropIndex(target.pkIndexRoot);
      const pkRoot = batch.createIndex({ unique: true });
      target.pkIndexRoot = pkRoot;
      const constraint = target.pkName !== null ? catalog.data.constraints[target.pkName] : undefined;
      if (constraint !== undefined) constraint.indexRoot = pkRoot;
    }
    for (const index of Object.values(catalog.data.indexes)) {
      if (index.table === name) {
        batch.dropIndex(index.indexRoot);
        index.indexRoot = batch.createIndex({ unique: false });
      }
    }
    batch.setCatalog(serializeCatalog(catalog.data));
    batch.commit();
  } catch (error) {
    try {
      batch.rollback();
    } catch {
      // 원래 오류를 유지한다.
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// CREATE VIEW, DROP VIEW
// ---------------------------------------------------------------------------

/** SELECT 목록에서 뷰 컬럼 이름을 추론한다. */
function inferViewColumns(
  manager: TablespaceManager,
  currentTablespace: string,
  query: Query,
  position?: SourcePosition,
): string[] {
  const body = query.body;
  if (body.kind === "Query") return inferViewColumns(manager, currentTablespace, body, position);
  if (body.kind === "SetOperation") {
    return inferViewColumns(manager, currentTablespace, { kind: "Query", body: body.left, orderBy: [], offset: null, fetch: null, forUpdate: false }, position);
  }
  const select = body as Select;
  const columns: string[] = [];
  for (const item of select.items) {
    if (item.kind === "Star") {
      for (const name of expandStar(manager, currentTablespace, item.qualifier, position)) {
        columns.push(name);
      }
      continue;
    }
    if (item.alias !== null) {
      columns.push(item.alias);
      continue;
    }
    const expr = item.expression;
    if (expr.kind === "Column") {
      columns.push(expr.name);
      continue;
    }
    columns.push(`COL${columns.length + 1}`);
  }
  return columns;
}

function expandStar(
  manager: TablespaceManager,
  currentTablespace: string,
  qualifier: string[],
  position?: SourcePosition,
): string[] {
  // 한정 없는 * 는 FROM 의 모든 테이블을 순서대로 펼친다. 여기서는 호출자가 FROM 을 알 수 없으므로
  // 뷰 추론에서 FROM 을 직접 펼치는 방식으로 처리한다. 이 함수는 한정 있는 * 만 받는다.
  void manager;
  void currentTablespace;
  void qualifier;
  void position;
  return [];
}

/** FROM 절의 테이블 참조에서 컬럼 목록을 모은다. */
function columnsOfReference(
  manager: TablespaceManager,
  currentTablespace: string,
  reference: import("../sql/ast.js").TableReference,
): string[] {
  switch (reference.kind) {
    case "Table": {
      const tablespace = reference.name.tablespace ?? currentTablespace;
      if (!manager.has(tablespace)) return [];
      let catalog;
      try {
        catalog = manager.requireCatalog(tablespace);
      } catch {
        return [];
      }
      const table = catalog.data.tables[reference.name.name];
      if (table !== undefined) return table.columns.map((column) => column.name);
      const view = catalog.data.views[reference.name.name];
      if (view !== undefined) return [...view.columns];
      return [];
    }
    case "Derived": {
      if (reference.columns !== null) return [...reference.columns];
      return inferViewColumns(manager, currentTablespace, reference.query);
    }
    case "Join": {
      return [...columnsOfReference(manager, currentTablespace, reference.left), ...columnsOfReference(manager, currentTablespace, reference.right)];
    }
  }
}

/** 뷰의 SELECT 목록을 FROM 과 함께 펼쳐 컬럼 이름을 정한다. */
function inferViewColumnsWithFrom(
  manager: TablespaceManager,
  currentTablespace: string,
  query: Query,
  position?: SourcePosition,
): string[] {
  const body = query.body;
  if (body.kind === "Query") return inferViewColumnsWithFrom(manager, currentTablespace, body, position);
  if (body.kind === "SetOperation") {
    return inferViewColumnsWithFrom(
      manager,
      currentTablespace,
      { kind: "Query", body: body.left, orderBy: [], offset: null, fetch: null, forUpdate: false },
      position,
    );
  }
  const select = body as Select;
  const columns: string[] = [];
  for (const item of select.items) {
    if (item.kind === "Star") {
      if (item.qualifier.length === 0) {
        for (const reference of select.from) {
          for (const name of columnsOfReference(manager, currentTablespace, reference)) columns.push(name);
        }
      } else if (item.qualifier.length === 1) {
        const wanted = item.qualifier[0] as string;
        const found = select.from.flatMap((reference) => columnsOfReference(manager, currentTablespace, reference));
        void found;
        // 별칭까지 추적하지 않고 같은 이름의 테이블에서 찾는다.
        for (const reference of select.from) {
          if (reference.kind === "Table" && reference.name.name === wanted) {
            for (const name of columnsOfReference(manager, currentTablespace, reference)) columns.push(name);
          }
        }
      } else {
        const tablespace = item.qualifier[0] as string;
        const tableName = item.qualifier[1] as string;
        let catalog;
        try {
          catalog = manager.requireCatalog(tablespace);
        } catch {
          continue;
        }
        const table = catalog.data.tables[tableName];
        if (table !== undefined) {
          for (const column of table.columns) columns.push(column.name);
          continue;
        }
        const view = catalog.data.views[tableName];
        if (view !== undefined) {
          for (const column of view.columns) columns.push(column);
        }
      }
      continue;
    }
    if (item.alias !== null) {
      columns.push(item.alias);
      continue;
    }
    if (item.expression.kind === "Column") {
      columns.push(item.expression.name);
      continue;
    }
    columns.push(`COL${columns.length + 1}`);
  }
  return columns;
}

/** CREATE VIEW 를 실행한다. */
export function executeCreateView(
  manager: TablespaceManager,
  currentTablespace: string,
  owner: string,
  stmt: CreateViewStatement,
): void {
  const { tablespace, name } = resolveTablespace(manager, stmt.name, currentTablespace);
  const catalog = requireCatalog(manager, tablespace, stmt.name.position);
  const existingTable = catalog.data.tables[name];
  const existingView = catalog.data.views[name];
  if (existingTable !== undefined) {
    fail("42P07", ERROR_CODES.TABLE_EXISTS, `"${name}" is a table; cannot create a view with the same name.`, stmt.name.position);
  }
  if (existingView !== undefined && !stmt.orReplace) {
    fail("42P07", ERROR_CODES.VIEW_EXISTS, `View already exists: "${name}".`, stmt.name.position);
  }
  assertNotReserved(tablespace, name, stmt.name.position);

  // 참조하는 객체가 모두 있는지 확인한다.
  const refs = collectReferencedObjects(stmt.query);
  const dependencies: { tablespace: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const refSpace = ref.tablespace ?? tablespace;
    const key = `${refSpace}.${ref.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isReservedSystemName(ref.name) && refSpace === "SYSTEM") {
      // 딕셔너리 뷰와 DUAL 은 가상으로 존재한다.
      if (ref.name === "DUAL" || ref.name.startsWith("SYS_")) {
        dependencies.push({ tablespace: refSpace, name: ref.name });
        continue;
      }
    }
    if (!manager.has(refSpace)) {
      fail("3D000", ERROR_CODES.TABLESPACE_NOT_FOUND, `Tablespace does not exist: "${refSpace}".`, ref.position);
    }
    let refCatalog;
    try {
      refCatalog = manager.requireCatalog(refSpace);
    } catch {
      fail("42P01", ERROR_CODES.TABLE_NOT_FOUND, `Object does not exist: "${refSpace}.${ref.name}".`, ref.position);
    }
    if (refCatalog.data.tables[ref.name] === undefined && refCatalog.data.views[ref.name] === undefined) {
      // 자기 자신을 OR REPLACE 로 바꾸는 경우는 허용한다.
      if (!(stmt.orReplace && refSpace === tablespace && ref.name === name)) {
        fail("42P01", ERROR_CODES.TABLE_NOT_FOUND, `Object does not exist: "${refSpace}.${ref.name}".`, ref.position);
      }
    }
    dependencies.push({ tablespace: refSpace, name: ref.name });
  }

  // 뷰 컬럼을 정한다.
  let columns: string[];
  if (stmt.columns !== null) {
    columns = [...stmt.columns];
    assertUniqueColumns(columns, stmt.name.position);
  } else {
    columns = inferViewColumnsWithFrom(manager, tablespace, stmt.query, stmt.name.position);
    if (columns.length === 0) {
      // FROM 없는 SELECT 는 선택 목록 수만큼 COL 이름을 둔다.
      columns = inferViewColumns(manager, tablespace, stmt.query, stmt.name.position);
    }
  }
  if (columns.length === 0) {
    fail("42P17", ERROR_CODES.INVALID_VIEW_DEFINITION, "A view must have at least one column.", stmt.name.position);
  }
  if (columns.length > 1000) {
    fail("54011", ERROR_CODES.TOO_MANY_COLUMNS, "A view cannot have more than 1000 columns.", stmt.name.position);
  }

  catalog.data.views[name] = {
    name,
    owner,
    columns,
    queryText: stmt.queryText,
    dependencies,
  };
  persistCatalog(catalog);
}

/** DROP VIEW 를 실행한다. */
export function executeDropView(
  manager: TablespaceManager,
  currentTablespace: string,
  stmt: DropViewStatement,
): void {
  const { tablespace, name } = resolveTablespace(manager, stmt.name, currentTablespace);
  assertNotDictionaryObject(manager, tablespace, name, stmt.name.position);
  const catalog = requireCatalog(manager, tablespace, stmt.name.position);
  const view = catalog.data.views[name];
  if (view === undefined) {
    if (catalog.data.tables[name] !== undefined) {
      fail(
        "42P01",
        ERROR_CODES.VIEW_NOT_FOUND,
        `"${name}" is a table; use DROP TABLE to drop it.`,
        stmt.name.position,
      );
    }
    if (stmt.ifExists) return;
    fail("42P01", ERROR_CODES.VIEW_NOT_FOUND, `View does not exist: "${name}".`, stmt.name.position);
  }
  const behavior = stmt.behavior ?? "RESTRICT";
  // 이 뷰를 참조하는 다른 뷰를 찾는다.
  const dependents: { space: string; name: string }[] = [];
  for (const candidateSpace of manager.listNames()) {
    let candidate;
    try {
      candidate = manager.requireCatalog(candidateSpace);
    } catch {
      continue;
    }
    for (const candidateView of Object.values(candidate.data.views)) {
      if (candidateView.dependencies.some((dep) => dep.tablespace === tablespace && dep.name === name)) {
        // 자기 자신은 제외한다.
        if (candidateSpace === tablespace && candidateView.name === name) continue;
        dependents.push({ space: candidateSpace, name: candidateView.name });
      }
    }
  }
  if (behavior === "RESTRICT" && dependents.length > 0) {
    fail(
      "55006",
      ERROR_CODES.OBJECT_IN_USE,
      `View "${name}" is referenced by view "${dependents[0]?.space}.${dependents[0]?.name}".`,
      stmt.name.position,
    );
  }
  for (const dependent of dependents) {
    const candidate = manager.requireCatalog(dependent.space);
    delete candidate.data.views[dependent.name];
    candidate.save();
    // 그 뷰에 딸린 뷰까지 재귀로 지운다.
    dropViewsDependingOn(manager, dependent.space, dependent.name);
  }
  const fresh = manager.requireCatalog(tablespace);
  delete fresh.data.views[name];
  fresh.save();
}

function dropViewsDependingOn(manager: TablespaceManager, tablespace: string, viewName: string): void {
  for (const candidateSpace of manager.listNames()) {
    let candidate;
    try {
      candidate = manager.requireCatalog(candidateSpace);
    } catch {
      continue;
    }
    const victims = Object.values(candidate.data.views).filter((view) =>
      view.dependencies.some((dep) => dep.tablespace === tablespace && dep.name === viewName),
    );
    for (const victim of victims) {
      dropViewsDependingOn(manager, candidateSpace, victim.name);
      const fresh = manager.requireCatalog(candidateSpace);
      delete fresh.data.views[victim.name];
      fresh.save();
    }
  }
}

// ---------------------------------------------------------------------------
// CREATE INDEX, DROP INDEX
// ---------------------------------------------------------------------------

/** CREATE INDEX 를 실행한다. */
export function executeCreateIndex(
  manager: TablespaceManager,
  currentTablespace: string,
  stmt: CreateIndexStatement,
): void {
  const tableRef = resolveTablespace(manager, stmt.table, currentTablespace);
  assertNotDictionaryObject(manager, tableRef.tablespace, tableRef.name, stmt.table.position);
  const catalog = requireCatalog(manager, tableRef.tablespace, stmt.table.position);
  const table = catalog.data.tables[tableRef.name];
  if (table === undefined) {
    if (catalog.data.views[tableRef.name] !== undefined) {
      fail("42P01", ERROR_CODES.TABLE_NOT_FOUND, `Cannot create an index on a view: "${tableRef.name}".`, stmt.table.position);
    }
    fail("42P01", ERROR_CODES.TABLE_NOT_FOUND, `Table does not exist: "${tableRef.name}".`, stmt.table.position);
  }
  const target = table as StoredTable;
  assertIndexColumnLimit(stmt.columns.length, stmt.table.position);
  for (const column of stmt.columns) {
    if (!target.columns.some((entry) => entry.name === column.name)) {
      fail("42703", ERROR_CODES.COLUMN_NOT_FOUND, `Column does not exist: "${column.name}".`, stmt.table.position);
    }
  }
  const columnNames = stmt.columns.map((column) => column.name);
  assertUniqueColumns(columnNames, stmt.table.position);

  let indexName: string;
  let indexTablespace = tableRef.tablespace;
  if (stmt.name === null) {
    indexName = catalog.nextIndexName(target.name);
  } else {
    const resolved = resolveTablespace(manager, stmt.name, currentTablespace);
    // 인덱스는 테이블과 같은 테이블스페이스에 둔다.
    if (resolved.tablespace !== tableRef.tablespace) {
      fail(
        "42P16",
        ERROR_CODES.INVALID_INDEX_DEFINITION,
        "An index must be in the same tablespace as its table.",
        stmt.table.position,
      );
    }
    indexName = resolved.name;
    indexTablespace = resolved.tablespace;
    if (catalog.data.indexes[indexName] !== undefined || Object.values(catalog.data.constraints).some((constraint) => constraint.name === indexName)) {
      fail("42710", ERROR_CODES.INDEX_EXISTS, `Index already exists: "${indexName}".`, stmt.table.position);
    }
    assertNotReserved(indexTablespace, indexName, stmt.table.position);
  }
  if (catalog.data.indexes[indexName] !== undefined) {
    fail("42710", ERROR_CODES.INDEX_EXISTS, `Index already exists: "${indexName}".`, stmt.table.position);
  }
  void indexTablespace;

  const space = catalog.space;
  const batch = space.begin();
  try {
    const indexRoot = batch.createIndex({ unique: false });
    const stored: StoredIndex = {
      name: indexName,
      table: target.name,
      columns: stmt.columns.map((column: IndexColumn) => ({ name: column.name, descending: column.descending })),
      indexRoot,
      unique: false,
    };
    // 기존 행을 새 인덱스에 넣는다.
    const types = target.columns.map((column) => column.dataType);
    const keyColumns = stored.columns.map((column) => {
      const found = target.columns.find((entry) => entry.name === column.name);
      return { type: (found as StoredColumn).dataType, descending: column.descending };
    });
    for (const row of batch.heap(target.heapRoot).scan()) {
      const values = decodeRow(row.data, types);
      const keyValues = stored.columns.map((column) => {
        const position = target.columns.findIndex((entry) => entry.name === column.name);
        return (values[position] ?? null) as SqlValue;
      });
      batch.index(indexRoot).insert(encodeKey(keyValues, keyColumns), row.id);
    }
    catalog.data.indexes[indexName] = stored;
    batch.setCatalog(serializeCatalog(catalog.data));
    batch.commit();
  } catch (error) {
    try {
      batch.rollback();
    } catch {
      // 원래 오류를 유지한다.
    }
    delete catalog.data.indexes[indexName];
    throw error;
  }
}

/** DROP INDEX 를 실행한다. PK 유일 인덱스는 DROP INDEX 로 지울 수 없다. */
export function executeDropIndex(
  manager: TablespaceManager,
  currentTablespace: string,
  stmt: DropIndexStatement,
): void {
  const { tablespace, name } = resolveTablespace(manager, stmt.name, currentTablespace);
  const catalog = requireCatalog(manager, tablespace, stmt.name.position);
  // PK 제약조건과 이름이 같은 유일 인덱스는 DROP INDEX 대상이 아니다.
  if (catalog.data.constraints[name] !== undefined) {
    fail(
      "42P16",
      ERROR_CODES.INVALID_INDEX_DEFINITION,
      `Index "${name}" is a primary key index; drop its constraint instead.`,
      stmt.name.position,
    );
  }
  const index = catalog.data.indexes[name];
  if (index === undefined) {
    fail("42704", ERROR_CODES.INDEX_NOT_FOUND, `Index does not exist: "${name}".`, stmt.name.position);
  }
  const target = index as StoredIndex;
  const space = catalog.space;
  const batch = space.begin();
  try {
    batch.dropIndex(target.indexRoot);
    delete catalog.data.indexes[name];
    batch.setCatalog(serializeCatalog(catalog.data));
    batch.commit();
  } catch (error) {
    try {
      batch.rollback();
    } catch {
      // 원래 오류를 유지한다.
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 타입 노출 (세션에서 기본값을 채울 때 쓴다)
// ---------------------------------------------------------------------------

export type { DataType };
export { formatDataType };
