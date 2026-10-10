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

import { DbError, ERROR_CODES } from "../common/errors.js";
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
): void {
  const { tablespace, name } = resolveTablespace(manager, stmt.name, currentTablespace);
  const catalog = requireCatalog(manager, tablespace, stmt.name.position);
  const action = stmt.action;
  switch (action.kind) {
    case "AddColumn": {
      addColumn(manager, catalog, tablespace, name, action.column);
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

function addColumn(
  _manager: TablespaceManager,
  catalog: CatalogStore,
  tablespace: string,
  tableName: string,
  columnDef: import("../sql/ast.js").ColumnDefinition,
): void {
  const table = catalog.requireTable(tableName);
  if (table.columns.some((column) => column.name === columnDef.name)) {
    fail("42701", ERROR_CODES.COLUMN_EXISTS, `Duplicate column name: "${columnDef.name}".`);
  }
  assertNotReserved(tablespace, columnDef.name);
  const next: StoredColumn[] = [
    ...table.columns,
    {
      name: columnDef.name,
      dataType: columnDef.dataType,
      defaultText: columnDef.default === null ? null : expressionText(columnDef.default),
      defaultExpr: columnDef.default,
      notNull: columnDef.notNull,
    },
  ];
  assertColumnLimit(next.length);
  // 컬럼에 붙은 PK 와 FK 는 ADD CONSTRAINT 와 같이 처리한다.
  if (columnDef.primaryKey !== null) {
    if (table.pkName !== null) {
      fail("42P16", ERROR_CODES.INVALID_TABLE_DEFINITION, "A table cannot have more than one primary key.");
    }
    // 기존 행이 없으므로(5단계) 바로 추가한다. 6단계에서 기존 데이터 검사를 붙인다.
    const pkName = catalog.resolveConstraintName(columnDef.primaryKey.name, "PRIMARY KEY", tableName);
    const space = catalog.space;
    const batch = space.begin();
    try {
      const indexRoot = batch.createIndex({ unique: true });
      table.columns = next;
      table.columns.find((column) => column.name === columnDef.name)!.notNull = true;
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
      try {
        batch.rollback();
      } catch {
        // 원래 오류를 유지한다.
      }
      throw error;
    }
    return;
  }
  if (columnDef.references !== null) {
    fail(
      "0A000",
      ERROR_CODES.FEATURE_NOT_SUPPORTED,
      "Adding a column with REFERENCES needs constraint validation in a later step.",
    );
  }
  table.columns = next;
  persistCatalog(catalog);
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
  // 뷰가 이 테이블을 참조하면 보수적으로 막는다. (컬럼 단위 추적은 6단계)
  const dependentViews = findDependentViews(manager, tablespace, tableName);
  if (dependentViews.length > 0) {
    fail(
      "55006",
      ERROR_CODES.OBJECT_IN_USE,
      `Column "${columnName}" is referenced by view "${dependentViews[0]}"; cannot drop it.`,
      position,
    );
  }
  table.columns.splice(index, 1);
  persistCatalog(catalog);
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
    case "SetNotNull":
      // 기존 데이터 검사는 6단계에서 붙인다. 지금은 행이 없으므로 바로 둔다.
      target.notNull = true;
      break;
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
    const space = catalog.space;
    const batch = space.begin();
    try {
      const indexRoot = batch.createIndex({ unique: true });
      // 기존 데이터 검사는 6단계에서 붙인다. 지금은 행이 없으므로 바로 둔다.
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
