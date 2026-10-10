/**
 * 데이터 변경 : INSERT, UPDATE, DELETE, TRUNCATE.
 *
 * 담당
 *  - INSERT (VALUES 여러 행, INSERT ... SELECT), UPDATE, DELETE, TRUNCATE
 *  - 컬럼의 DEFAULT 적용
 *  - 제약조건 검사 : NOT NULL, PK(유일성), FK. 검사는 문장이 끝나는 시점에 한다.
 *  - FK 참조동작 : NO ACTION, RESTRICT, CASCADE, SET NULL
 *  - 변경한 행에 딸린 인덱스를 함께 고친다.
 *  - 갱신 가능한 뷰를 통한 변경을 기반 테이블의 변경으로 바꾼다.
 *  - 변경할 행에 잠금을 건다. (txn/lockManager.ts)
 *  - 문장이 실패하면 그 문장이 한 변경만 되돌릴 수 있게 한다. (txn/transaction.ts)
 *
 * TRUNCATE 는 DDL 처럼 실행 전후에 자동으로 커밋된다.
 * 6단계에서는 자동 커밋으로 한 문장을 한 배치에 넣어 디스크에 반영한다. 잠금과 동시성은 7단계이다.
 *
 * 관련 사양 : AGENTS.md 상세 1-3, 1-4, 10, 11
 * 구현 단계 : 6단계
 */

import { DbError, ERROR_CODES, withPosition } from "../common/errors.js";
import type { SourcePosition } from "../common/errors.js";
import type {
  DeleteStatement,
  Expression,
  InsertStatement,
  ObjectName,
  TruncateTableStatement,
  UpdateStatement,
} from "../sql/ast.js";
import type { DataType } from "../types/dataType.js";
import { assignValue, isImplicitlyConvertible } from "../types/cast.js";
import { isNotDistinct } from "../types/value.js";
import type { SqlValue } from "../types/value.js";
import { decodeRow, encodeKey, encodeRow } from "../types/codec.js";
import type { KeyColumn } from "../types/codec.js";
import type { RowId, StorageBatch } from "../storage/format/format.js";
import type { CatalogStore, StoredTable } from "../catalog/catalog.js";
import type { TablespaceManager } from "../catalog/tablespaceManager.js";
import { executeQuery, readTableRows, scanTableForDml } from "./executor.js";
import type { QueryContext } from "./executor.js";
import { evaluateExpression } from "./expression.js";
import { atInnerLevel } from "./expression.js";
import type { RowScope } from "./expression.js";
import { rewriteViewColumns, viewColumnMapping } from "./analyzer.js";
import { executeTruncateTable } from "./ddl.js";

function fail(sqlState: string, code: number, message: string, position?: SourcePosition): never {
  if (position !== undefined) {
    throw withPosition(new DbError(sqlState, code, message), position);
  }
  throw new DbError(sqlState, code, message);
}

function rowIdKey(id: RowId): string {
  return `${id.pageId}:${id.slotId}`;
}

// ---------------------------------------------------------------------------
// 변경 대상 해석 (테이블 또는 갱신 가능한 뷰)
// ---------------------------------------------------------------------------

interface DmlTarget {
  catalog: CatalogStore;
  tablespace: string;
  table: StoredTable;
}

/** INSERT, UPDATE, DELETE의 대상을 기반 테이블로 푼다. 뷰는 갱신 가능해야 한다. */
function resolveTarget(
  manager: TablespaceManager,
  currentTablespace: string,
  target: ObjectName,
): DmlTarget & { viewName: string | null; columnMap: Map<string, string | null> | null } {
  const tablespace = target.tablespace ?? currentTablespace;
  if (!manager.has(tablespace)) {
    fail("3D000", ERROR_CODES.TABLESPACE_NOT_FOUND, `Tablespace does not exist: "${tablespace}".`, target.position);
  }
  const catalog = manager.requireCatalog(tablespace);
  const table = catalog.data.tables[target.name];
  if (table !== undefined) {
    return { catalog, tablespace, table, viewName: null, columnMap: null };
  }
  const view = catalog.data.views[target.name];
  if (view === undefined) {
    fail("42P01", ERROR_CODES.TABLE_NOT_FOUND, `Object does not exist: "${tablespace}.${target.name}".`, target.position);
  }
  const mapping = viewColumnMapping(manager, tablespace, target.name);
  const baseCatalog = manager.requireCatalog(mapping.baseTablespace);
  const baseTable = baseCatalog.data.tables[mapping.baseTable];
  if (baseTable === undefined) {
    fail("42P01", ERROR_CODES.TABLE_NOT_FOUND, `Object does not exist: "${mapping.baseTablespace}.${mapping.baseTable}".`, target.position);
  }
  return { catalog: baseCatalog, tablespace: mapping.baseTablespace, table: baseTable, viewName: target.name, columnMap: mapping.map };
}

/** 뷰 열 이름을 기반 열 이름으로 바꾼다. 직접 참조가 아니면 오류이다. */
function mapViewColumn(columnMap: Map<string, string | null> | null, column: string, position?: SourcePosition): string {
  if (columnMap === null) return column;
  const base = columnMap.get(column);
  if (base === undefined) {
    fail("42703", ERROR_CODES.COLUMN_NOT_FOUND, `Column does not exist: "${column}".`, position);
  }
  if (base === null) {
    fail("42P17", ERROR_CODES.INVALID_VIEW_DEFINITION, `Column "${column}" of the view is not updatable.`, position);
  }
  return base as string;
}

/** 뷰를 통한 DML에서 식의 뷰 열 참조를 기반으로 바꾼다. 별칭과 뷰 이름 둘 다 받는다. */
function rewriteForBase(
  expression: Expression,
  viewName: string,
  alias: string | null,
  baseTable: string,
  columnMap: Map<string, string | null>,
): Expression {
  void baseTable;
  let rewritten = rewriteViewColumns(expression, viewName, baseTable, columnMap);
  if (alias !== null && alias !== viewName) {
    rewritten = rewriteViewColumns(rewritten, alias, baseTable, columnMap);
  }
  return rewritten;
}

// ---------------------------------------------------------------------------
// 문장 안의 메모리 이미지 (제약 검사와 CASCADE용)
// ---------------------------------------------------------------------------

interface ImageRow {
  id: RowId | null;
  values: SqlValue[];
  original: SqlValue[] | null;
  deleted: boolean;
  added: boolean;
  dirtyTablespaces?: never;
}

interface TableImage {
  catalog: CatalogStore;
  tablespace: string;
  table: StoredTable;
  rows: ImageRow[];
  byId: Map<string, ImageRow>;
  dirty: boolean;
}

class StatementImages {
  private readonly images = new Map<string, TableImage>();

  constructor(private readonly manager: TablespaceManager) {}

  image(tablespace: string, tableName: string): TableImage {
    const key = `${tablespace}.${tableName}`;
    const found = this.images.get(key);
    if (found !== undefined) return found;
    const catalog = this.manager.requireCatalog(tablespace);
    const table = catalog.data.tables[tableName];
    if (table === undefined) {
      throw new DbError("42P01", ERROR_CODES.TABLE_NOT_FOUND, `Table does not exist: "${key}".`);
    }
    const image: TableImage = { catalog, tablespace, table, rows: [], byId: new Map(), dirty: false };
    for (const stored of readTableRows(catalog, table)) {
      const row: ImageRow = { id: stored.id, values: stored.values, original: null, deleted: false, added: false };
      image.rows.push(row);
      image.byId.set(rowIdKey(stored.id), row);
    }
    this.images.set(key, image);
    return image;
  }

  /** 건드린 이미지들을 돌려준다. */
  dirtyImages(): TableImage[] {
    return [...this.images.values()].filter((image) => image.dirty);
  }

  insertRow(image: TableImage, values: SqlValue[]): ImageRow {
    const row: ImageRow = { id: null, values, original: null, deleted: false, added: true };
    image.rows.push(row);
    image.dirty = true;
    return row;
  }

  updateRow(image: TableImage, row: ImageRow, values: SqlValue[]): void {
    if (row.deleted) {
      throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, "Cannot update a deleted row.");
    }
    if (row.original === null && !row.added) {
      row.original = [...row.values];
    }
    row.values = values;
    image.dirty = true;
  }

  deleteRow(image: TableImage, row: ImageRow): void {
    if (row.added) {
      const index = image.rows.indexOf(row);
      if (index >= 0) image.rows.splice(index, 1);
      image.dirty = true;
      return;
    }
    row.deleted = true;
    image.dirty = true;
  }

  liveRows(image: TableImage): ImageRow[] {
    return image.rows.filter((row) => !row.deleted);
  }
}

/** PK 튜플이 같은지 본다. CHAR는 뒤쪽 공백을 무시한다. */
function pkEquals(left: SqlValue[], right: SqlValue[], types: DataType[]): boolean {
  for (let index = 0; index < types.length; index++) {
    const type = types[index] as DataType;
    if (!isNotDistinct(left[index] as SqlValue, right[index] as SqlValue, { ignoreTrailingSpaces: type.kind === "CHAR" })) {
      return false;
    }
  }
  return true;
}

/** 행에서 PK 값을 뽑는다. */
function pkOf(table: StoredTable, values: SqlValue[]): SqlValue[] {
  return table.pkColumns.map((column) => {
    const index = table.columns.findIndex((entry) => entry.name === column);
    return (values[index] ?? null) as SqlValue;
  });
}

/** 행에서 FK 값을 뽑는다. */
function fkOf(columns: string[], table: StoredTable, values: SqlValue[]): SqlValue[] {
  return columns.map((column) => {
    const index = table.columns.findIndex((entry) => entry.name === column);
    return (values[index] ?? null) as SqlValue;
  });
}

/** FK 값에 NULL이 하나라도 있으면 검사를 건너뛴다. */
function fkIsNull(values: SqlValue[]): boolean {
  return values.some((value) => value === null);
}

// ---------------------------------------------------------------------------
// 제약 검사와 참조동작
// ---------------------------------------------------------------------------

/** 살아 있는 행들의 NOT NULL을 검사한다. */
function checkNotNull(image: TableImage, position?: SourcePosition): void {
  for (const row of image.rows) {
    if (row.deleted) continue;
    for (let index = 0; index < image.table.columns.length; index++) {
      const column = image.table.columns[index] as StoredTable["columns"][number];
      if (column.notNull && (row.values[index] ?? null) === null) {
        fail("23502", ERROR_CODES.NOT_NULL_VIOLATION, `NULL violates NOT NULL of column "${column.name}".`, position);
      }
    }
  }
}

/** 살아 있는 행들의 PK 유일성을 검사한다. */
function checkPrimaryKey(image: TableImage, position?: SourcePosition): void {
  if (image.table.pkName === null) return;
  const types = image.table.pkColumns.map((column) => {
    const found = image.table.columns.find((entry) => entry.name === column);
    return (found as StoredTable["columns"][number]).dataType;
  });
  const seen: SqlValue[][] = [];
  for (const row of image.rows) {
    if (row.deleted) continue;
    const key = pkOf(image.table, row.values);
    for (const other of seen) {
      if (pkEquals(key, other, types)) {
        fail("23505", ERROR_CODES.DUPLICATE_KEY, `Duplicate primary key in table "${image.table.name}".`, position);
      }
    }
    seen.push(key);
  }
}

/** 자식 쪽 FK 존재 검사를 한다. CASCADE로 지워지지 않은 orphan이 있으면 오류이다. */
function checkForeignKeys(images: StatementImages, image: TableImage, position?: SourcePosition): void {
  for (const constraint of Object.values(image.catalog.data.constraints)) {
    if (constraint.kind !== "FOREIGN KEY" || constraint.table !== image.table.name) continue;
    const childTypes = constraint.columns.map((column) => {
      const found = image.table.columns.find((entry) => entry.name === column);
      return (found as StoredTable["columns"][number]).dataType;
    });
    const parent = images.image(image.tablespace, constraint.refTable as string);
    const parentTypes = (constraint.refColumns as string[]).map((column) => {
      const found = parent.table.columns.find((entry) => entry.name === column);
      return (found as StoredTable["columns"][number]).dataType;
    });
    for (const row of image.rows) {
      if (row.deleted) continue;
      const key = fkOf(constraint.columns, image.table, row.values);
      if (fkIsNull(key)) continue;
      const found = parent.rows.some((parentRow) => {
        if (parentRow.deleted) return false;
        const parentKey = fkOf(constraint.refColumns as string[], parent.table, parentRow.values);
        return pkEquals(key, parentKey, parentTypes);
      });
      void childTypes;
      if (!found) {
        fail("23503", ERROR_CODES.FOREIGN_KEY_VIOLATION, `Foreign key "${constraint.name}" is violated.`, position);
      }
    }
  }
}

/** 부모 변경에 따른 참조동작을 끝까지 적용한다. */
function applyReferentialActions(
  images: StatementImages,
  kind: "delete" | "update",
  position?: SourcePosition,
): void {
  for (;;) {
    let progressed = false;
    for (const image of images.dirtyImages()) {
      for (const constraint of Object.values(image.catalog.data.constraints)) {
        if (constraint.kind !== "FOREIGN KEY") continue;
        // 자식 이미지를 준비한다. 같은 테이블스페이스만 참조하므로 같이 있다.
        const child = images.image(image.tablespace, constraint.table);
        const parent = images.image(image.tablespace, constraint.refTable as string);
        const parentTypes = (constraint.refColumns as string[]).map((column) => {
          const found = parent.table.columns.find((entry) => entry.name === column);
          return (found as StoredTable["columns"][number]).dataType;
        });
        for (const childRow of [...child.rows]) {
          if (childRow.deleted) continue;
          const key = fkOf(constraint.columns, child.table, childRow.values);
          if (fkIsNull(key)) continue;
          // 현재 부모에 있으면 할 일이 없다.
          const alive = parent.rows.some((parentRow) => {
            if (parentRow.deleted) return false;
            return pkEquals(key, fkOf(constraint.refColumns as string[], parent.table, parentRow.values), parentTypes);
          });
          if (alive) continue;
          // 원래 부모에 있었는지 본다. 없었으면 이 문장이 만든 orphan이므로 동작 없이 오류이다.
          const wasReferenced = parent.rows.some((parentRow) => {
            const original = parentRow.original ?? (parentRow.deleted ? parentRow.values : null);
            if (original === null) return false;
            return pkEquals(key, fkOf(constraint.refColumns as string[], parent.table, original), parentTypes);
          });
          // 새로 넣은 자식 행이 없는 부모를 가리키면 오류이다.
          if (!wasReferenced) {
            const action = kind === "delete" ? constraint.onDelete : constraint.onUpdate;
            void action;
            fail("23503", ERROR_CODES.FOREIGN_KEY_VIOLATION, `Foreign key "${constraint.name}" is violated.`, position);
          }
          const action = kind === "delete" ? constraint.onDelete : constraint.onUpdate;
          if (action === "CASCADE") {
            if (kind === "delete") {
              images.deleteRow(child, childRow);
              progressed = true;
            } else {
              // 바뀐 부모를 찾아 새 PK로 맞춘다.
              const updated = parent.rows.find((parentRow) => {
                if (parentRow.deleted || parentRow.original === null) return false;
                return pkEquals(key, fkOf(constraint.refColumns as string[], parent.table, parentRow.original), parentTypes);
              });
              if (updated === undefined) {
                fail("23503", ERROR_CODES.FOREIGN_KEY_VIOLATION, `Foreign key "${constraint.name}" is violated.`, position);
              }
              const newValues = [...childRow.values];
              (constraint.columns as string[]).forEach((column, index) => {
                const columnIndex = child.table.columns.findIndex((entry) => entry.name === column);
                const refColumn = (constraint.refColumns as string[])[index] as string;
                const refIndex = parent.table.columns.findIndex((entry) => entry.name === refColumn);
                newValues[columnIndex] = (updated.values[refIndex] ?? null) as SqlValue;
              });
              images.updateRow(child, childRow, newValues);
              progressed = true;
            }
          } else if (action === "SET NULL") {
            const newValues = [...childRow.values];
            for (const column of constraint.columns) {
              const columnIndex = child.table.columns.findIndex((entry) => entry.name === column);
              const definition = child.table.columns[columnIndex] as StoredTable["columns"][number];
              if (definition.notNull) {
                fail("23502", ERROR_CODES.NOT_NULL_VIOLATION, `SET NULL violates NOT NULL of column "${column}".`, position);
              }
              newValues[columnIndex] = null;
            }
            images.updateRow(child, childRow, newValues);
            progressed = true;
          } else {
            fail("23503", ERROR_CODES.FOREIGN_KEY_VIOLATION, `Foreign key "${constraint.name}" is violated.`, position);
          }
        }
      }
    }
    if (!progressed) break;
  }
}

// ---------------------------------------------------------------------------
// INSERT
// ---------------------------------------------------------------------------

/** INSERT를 실행하고 넣은 행 수를 돌려준다. */
export function executeInsert(
  manager: TablespaceManager,
  currentTablespace: string,
  ctx: QueryContext,
  stmt: InsertStatement,
): number {
  const resolved = resolveTarget(manager, currentTablespace, stmt.target);
  const table = resolved.table;
  // 넣을 컬럼을 정한다. 생략하면 테이블의 모든 컬럼이다. 뷰는 대응 열로 바꾼다.
  // 뷰에 목록을 생략하면 뷰 열 순서대로 받는다. (기반 순서와 다를 수 있다)
  const requested = stmt.columns ?? (resolved.columnMap === null
    ? table.columns.map((column) => column.name)
    : [...resolved.columnMap.keys()]);
  if (new Set(requested).size !== requested.length) {
    fail("42701", ERROR_CODES.COLUMN_EXISTS, "Duplicate column in INSERT column list.", stmt.target.position);
  }
  const insertColumns = requested.map((column) => {
    const base = mapViewColumn(resolved.columnMap, column, stmt.target.position);
    const definition = table.columns.find((entry) => entry.name === base);
    if (definition === undefined) {
      fail("42703", ERROR_CODES.COLUMN_NOT_FOUND, `Column does not exist: "${column}".`, stmt.target.position);
    }
    return definition as StoredTable["columns"][number];
  });
  // 원천 행들을 만든다.
  const sourceRows: SqlValue[][] = [];
  if (stmt.source.kind === "Values") {
    for (const row of stmt.source.rows) {
      if (row.length !== insertColumns.length) {
        fail("42601", ERROR_CODES.INSERT_VALUE_MISMATCH, "INSERT value count does not match column count.", stmt.target.position);
      }
      sourceRows.push(evaluateInsertRow(row, insertColumns, ctx, stmt.target.position));
    }
  } else if (stmt.source.kind === "DefaultValues") {
    sourceRows.push(insertColumns.map((column) => evaluateColumnDefault(column, ctx)));
  } else {
    const result = executeQuery(stmt.source.query, ctx);
    if (result.columns.length !== insertColumns.length) {
      fail("42601", ERROR_CODES.INSERT_VALUE_MISMATCH, "INSERT query column count does not match.", stmt.target.position);
    }
    for (const row of result.rows) {
      sourceRows.push(
        row.map((value, index) => {
          const column = insertColumns[index] as StoredTable["columns"][number];
          const sourceType = (result.columns[index] as { type: DataType }).type;
          if (value === null) return null;
          if (!isImplicitlyConvertible(sourceType, column.dataType)) {
            fail("42804", 2011, `Cannot convert ${sourceType.name} to ${column.dataType.name} implicitly; use CAST.`, stmt.target.position);
          }
          return assignValue(value, sourceType, column.dataType, ctx.typeCtx);
        }),
      );
    }
  }
  // 전체 행으로 펼친다. 적지 않은 컬럼은 DEFAULT나 NULL이다.
  const images = new StatementImages(manager);
  const image = images.image(resolved.tablespace, table.name);
  for (const source of sourceRows) {
    const full = table.columns.map((column) => {
      const position = insertColumns.findIndex((entry) => entry.name === column.name);
      if (position >= 0) return (source[position] ?? null) as SqlValue;
      return evaluateColumnDefault(column, ctx);
    });
    images.insertRow(image, full);
  }
  checkNotNull(image, stmt.target.position);
  checkPrimaryKey(image, stmt.target.position);
  applyReferentialActions(images, "update", stmt.target.position);
  checkForeignKeys(images, image, stmt.target.position);
  writeBack(manager, images, stmt.target.position);
  return sourceRows.length;
}

/** VALUES 한 행을 컬럼 타입에 맞추어 평가한다. */
function evaluateInsertRow(
  expressions: Expression[],
  columns: StoredTable["columns"],
  ctx: QueryContext,
  position: SourcePosition,
): SqlValue[] {
  return expressions.map((expression, index) => {
    const column = columns[index] as StoredTable["columns"][number];
    if (expression.kind === "Default") {
      return evaluateColumnDefault(column, ctx);
    }
    const evalCtx = {
      typeCtx: ctx.typeCtx,
      params: ctx.params,
      scopes: [...ctx.outerScopes],
      currentUser: ctx.currentUser,
      subqueries: dataHandlersFor(ctx),
      typeSubqueries: typeHandlersFor(ctx),
    };
    const bound = evaluateExpression(expression, evalCtx, column.dataType);
    return bound.value;
  });
}

/** 컬럼의 DEFAULT를 평가한다. 없으면 NULL이다. */
function evaluateColumnDefault(column: StoredTable["columns"][number], ctx: QueryContext): SqlValue {
  if (column.defaultExpr === null) return null;
  const evalCtx = {
    typeCtx: ctx.typeCtx,
    params: ctx.params,
    scopes: [...ctx.outerScopes],
    currentUser: ctx.currentUser,
    subqueries: dataHandlersFor(ctx),
    typeSubqueries: typeHandlersFor(ctx),
  };
  const bound = evaluateExpression(column.defaultExpr, evalCtx, column.dataType);
  return bound.value;
}

function dataHandlersFor(ctx: QueryContext) {
  return {
    scalar: (query: import("../sql/ast.js").Query): import("./functions.js").TypedValue => {
      const result = executeQuery(query, ctx);
      if (result.columns.length !== 1) {
        fail("21000", ERROR_CODES.CARDINALITY_VIOLATION, "Scalar subquery must return a single column.");
      }
      if (result.rows.length === 0) {
        return { value: null, type: (result.columns[0] as { type: DataType }).type };
      }
      if (result.rows.length > 1) {
        fail("21000", ERROR_CODES.CARDINALITY_VIOLATION, "Scalar subquery returned more than one row.");
      }
      return { value: (result.rows[0] as SqlValue[])[0] as SqlValue, type: (result.columns[0] as { type: DataType }).type };
    },
    exists: (query: import("../sql/ast.js").Query): boolean => executeQuery(query, ctx).rows.length > 0,
    columnValues: (query: import("../sql/ast.js").Query): { values: SqlValue[]; type: DataType } => {
      const result = executeQuery(query, ctx);
      if (result.columns.length !== 1) {
        fail("21000", ERROR_CODES.CARDINALITY_VIOLATION, "Subquery must return a single column.");
      }
      return { values: result.rows.map((row) => row[0] as SqlValue), type: (result.columns[0] as { type: DataType }).type };
    },
  };
}

function typeHandlersFor(ctx: QueryContext) {
  void ctx;
  return {
    scalar: (_query: import("../sql/ast.js").Query): import("./functions.js").TypedValue => ({ value: null, type: { kind: "INTEGER", name: "INTEGER", bits: 32 } as DataType }),
    exists: (_query: import("../sql/ast.js").Query): boolean => false,
    columnValues: (_query: import("../sql/ast.js").Query): { values: SqlValue[]; type: DataType } => ({
      values: [],
      type: { kind: "INTEGER", name: "INTEGER", bits: 32 } as DataType,
    }),
  };
}

// ---------------------------------------------------------------------------
// UPDATE, DELETE
// ---------------------------------------------------------------------------

/** UPDATE를 실행하고 바꾼 행 수를 돌려준다. */
export function executeUpdate(
  manager: TablespaceManager,
  currentTablespace: string,
  ctx: QueryContext,
  stmt: UpdateStatement,
): number {
  const resolved = resolveTarget(manager, currentTablespace, stmt.target);
  const table = resolved.table;
  if (new Set(stmt.assignments.map((assignment) => assignment.column)).size !== stmt.assignments.length) {
    fail("42701", ERROR_CODES.COLUMN_EXISTS, "Duplicate column in UPDATE SET list.", stmt.target.position);
  }
  // 대입 열을 기반으로 푼다.
  const assignments = stmt.assignments.map((assignment) => {
    const base = mapViewColumn(resolved.columnMap, assignment.column, stmt.target.position);
    const definition = table.columns.find((entry) => entry.name === base);
    if (definition === undefined) {
      fail("42703", ERROR_CODES.COLUMN_NOT_FOUND, `Column does not exist: "${assignment.column}".`, stmt.target.position);
    }
    return { column: definition as StoredTable["columns"][number], value: assignment.value };
  });
  const alias = stmt.alias ?? resolved.viewName;
  let where = stmt.where;
  if (where !== null && resolved.columnMap !== null) {
    where = rewriteForBase(where, resolved.viewName as string, alias, table.name, resolved.columnMap);
  }
  const images = new StatementImages(manager);
  const image = images.image(resolved.tablespace, table.name);
  const found = scanTableForDml(image.catalog, table, resolved.tablespace, alias, where, ctx);
  let count = 0;
  for (const row of found) {
    const stored = image.byId.get(rowIdKey(row.id));
    if (stored === undefined || stored.deleted) continue;
    const newValues = [...stored.values];
    for (const assignment of assignments) {
      const index = table.columns.findIndex((entry) => entry.name === assignment.column.name);
      if (assignment.value.kind === "Default") {
        newValues[index] = evaluateColumnDefault(assignment.column, ctx);
        continue;
      }
      const evalCtx = {
        typeCtx: ctx.typeCtx,
        params: ctx.params,
        scopes: [...ctx.outerScopes, ...atInnerLevel(ctx.outerScopes, row.scopes)],
        currentUser: ctx.currentUser,
        subqueries: dataHandlersForRow(row.scopes, ctx),
        typeSubqueries: typeHandlersFor(ctx),
      };
      const bound = evaluateExpression(assignment.value, evalCtx, assignment.column.dataType);
      newValues[index] = bound.value;
    }
    images.updateRow(image, stored, newValues);
    count++;
  }
  if (count === 0) return 0;
  checkNotNull(image, stmt.target.position);
  checkPrimaryKey(image, stmt.target.position);
  applyReferentialActions(images, "update", stmt.target.position);
  checkForeignKeys(images, image, stmt.target.position);
  // 다른 테이블의 CASCADE로 바뀐 이미지들도 검사한다.
  for (const other of images.dirtyImages()) {
    if (other === image) continue;
    checkNotNull(other, stmt.target.position);
    checkPrimaryKey(other, stmt.target.position);
    checkForeignKeys(images, other, stmt.target.position);
  }
  writeBack(manager, images, stmt.target.position);
  return count;
}

/** DELETE를 실행하고 지운 행 수를 돌려준다. */
export function executeDelete(
  manager: TablespaceManager,
  currentTablespace: string,
  ctx: QueryContext,
  stmt: DeleteStatement,
): number {
  const resolved = resolveTarget(manager, currentTablespace, stmt.target);
  const table = resolved.table;
  const alias = stmt.alias ?? resolved.viewName;
  let where = stmt.where;
  if (where !== null && resolved.columnMap !== null) {
    where = rewriteForBase(where, resolved.viewName as string, alias, table.name, resolved.columnMap);
  }
  const images = new StatementImages(manager);
  const image = images.image(resolved.tablespace, table.name);
  const found = scanTableForDml(image.catalog, table, resolved.tablespace, alias, where, ctx);
  for (const row of found) {
    const stored = image.byId.get(rowIdKey(row.id));
    if (stored !== undefined && !stored.deleted) images.deleteRow(image, stored);
  }
  if (found.length === 0) return 0;
  applyReferentialActions(images, "delete", stmt.target.position);
  for (const other of images.dirtyImages()) {
    checkNotNull(other, stmt.target.position);
    checkPrimaryKey(other, stmt.target.position);
    checkForeignKeys(images, other, stmt.target.position);
  }
  writeBack(manager, images, stmt.target.position);
  return found.length;
}

function dataHandlersForRow(scopes: RowScope[], ctx: QueryContext) {
  const outer = [...ctx.outerScopes, ...atInnerLevel(ctx.outerScopes, scopes)];
  return {
    scalar: (query: import("../sql/ast.js").Query): import("./functions.js").TypedValue => {
      const result = executeQuery(query, { ...ctx, outerScopes: outer });
      if (result.columns.length !== 1) {
        fail("21000", ERROR_CODES.CARDINALITY_VIOLATION, "Scalar subquery must return a single column.");
      }
      if (result.rows.length === 0) {
        return { value: null, type: (result.columns[0] as { type: DataType }).type };
      }
      if (result.rows.length > 1) {
        fail("21000", ERROR_CODES.CARDINALITY_VIOLATION, "Scalar subquery returned more than one row.");
      }
      return { value: (result.rows[0] as SqlValue[])[0] as SqlValue, type: (result.columns[0] as { type: DataType }).type };
    },
    exists: (query: import("../sql/ast.js").Query): boolean =>
      executeQuery(query, { ...ctx, outerScopes: outer }).rows.length > 0,
    columnValues: (query: import("../sql/ast.js").Query): { values: SqlValue[]; type: DataType } => {
      const result = executeQuery(query, { ...ctx, outerScopes: outer });
      if (result.columns.length !== 1) {
        fail("21000", ERROR_CODES.CARDINALITY_VIOLATION, "Subquery must return a single column.");
      }
      return { values: result.rows.map((row) => row[0] as SqlValue), type: (result.columns[0] as { type: DataType }).type };
    },
  };
}

// ---------------------------------------------------------------------------
// TRUNCATE
// ---------------------------------------------------------------------------

/** TRUNCATE를 실행한다. 참조하는 자식 행이 있으면 오류이다. */
export function executeTruncate(
  manager: TablespaceManager,
  currentTablespace: string,
  ctx: QueryContext,
  stmt: TruncateTableStatement,
): number {
  void ctx;
  const resolved = resolveTarget(manager, currentTablespace, stmt.name);
  if (resolved.viewName !== null) {
    fail("42P01", ERROR_CODES.TABLE_NOT_FOUND, `TRUNCATE needs a table, but "${stmt.name.name}" is a view.`, stmt.name.position);
  }
  // 자식 테이블에 참조 행이 있으면 비울 수 없다.
  for (const constraint of Object.values(resolved.catalog.data.constraints)) {
    if (constraint.kind !== "FOREIGN KEY" || constraint.refTable !== resolved.table.name) continue;
    const childCatalog = manager.requireCatalog(resolved.tablespace);
    const childTable = childCatalog.data.tables[constraint.table];
    if (childTable === undefined) continue;
    const childRows = readTableRows(childCatalog, childTable);
    if (childRows.length === 0) continue;
    const parentRows = readTableRows(resolved.catalog, resolved.table);
    if (parentRows.length === 0) continue;
    // 참조 행이 실제로 있는지 본다. 없으면 그냥 비운다.
    const parentTypes = (constraint.refColumns as string[]).map((column) => {
      const found = resolved.table.columns.find((entry) => entry.name === column);
      return (found as StoredTable["columns"][number]).dataType;
    });
    const referenced = childRows.some((childRow) => {
      const key = fkOf(constraint.columns, childTable, childRow.values);
      if (fkIsNull(key)) return false;
      return parentRows.some((parentRow) =>
        pkEquals(key, fkOf(constraint.refColumns as string[], resolved.table, parentRow.values), parentTypes),
      );
    });
    if (referenced) {
      fail("23503", ERROR_CODES.FOREIGN_KEY_VIOLATION, `Table "${resolved.table.name}" is referenced by "${constraint.table}".`, stmt.name.position);
    }
  }
  executeTruncateTable(manager, currentTablespace, stmt);
  return 0;
}

// ---------------------------------------------------------------------------
// 디스크 반영
// ---------------------------------------------------------------------------

/** 메모리 이미지를 저장 배치로 쓴다. 테이블스페이스마다 배치 하나를 공유한다. */
function writeBack(manager: TablespaceManager, images: StatementImages, position?: SourcePosition): void {
  void manager;
  void position;
  const touched = images.dirtyImages();
  // 테이블스페이스마다 배치 하나를 쓴다. FK는 같은 테이블스페이스이므로 보통 하나이다.
  const batches = new Map<string, StorageBatch>();
  const plan = new Map<string, TableImage[]>();
  for (const image of touched) {
    const list = plan.get(image.tablespace) ?? [];
    list.push(image);
    plan.set(image.tablespace, list);
  }
  try {
    for (const [tablespace, list] of plan) {
      const first = list[0] as TableImage;
      void tablespace;
      const batch = first.catalog.space.begin();
      batches.set(batchKey(first), batch);
      for (const image of list) {
        writeImage(image, batch);
      }
    }
    for (const batch of batches.values()) {
      batch.commit();
    }
  } catch (error) {
    for (const batch of batches.values()) {
      try {
        batch.rollback();
      } catch {
        // 원래 오류를 유지한다.
      }
    }
    throw error;
  }
}

function batchKey(image: TableImage): string {
  return image.tablespace;
}

/** 이미지 하나의 변경을 배치에 쓴다. 힙과 인덱스를 함께 고친다. */
function writeImage(image: TableImage, batch: StorageBatch, position?: SourcePosition): void {
  const types = image.table.columns.map((column) => column.dataType);
  const indexes: { root: number; columns: { name: string; descending: boolean }[] }[] = [];
  if (image.table.pkName !== null && image.table.pkIndexRoot !== null) {
    indexes.push({ root: image.table.pkIndexRoot, columns: image.table.pkColumns.map((name) => ({ name, descending: false })) });
  }
  for (const index of Object.values(image.catalog.data.indexes)) {
    if (index.table === image.table.name) {
      indexes.push({ root: index.indexRoot, columns: index.columns });
    }
  }
  const keyOf = (values: SqlValue[]): Buffer[] => indexes.map((index) => {
    const keyColumns: KeyColumn[] = index.columns.map((column) => {
      const found = image.table.columns.find((entry) => entry.name === column.name);
      return { type: (found as StoredTable["columns"][number]).dataType, descending: column.descending };
    });
    const keyValues = index.columns.map((column) => {
      const position = image.table.columns.findIndex((entry) => entry.name === column.name);
      return (values[position] ?? null) as SqlValue;
    });
    return encodeKey(keyValues, keyColumns);
  });
  for (const row of image.rows) {
    if (row.added && !row.deleted) {
      const id = batch.heap(image.table.heapRoot).insert(encodeRow(row.values, types));
      row.id = id;
      const keys = keyOf(row.values);
      indexes.forEach((index, position) => {
        batch.index(index.root).insert(keys[position] as Buffer, id);
      });
      void position;
    } else if (!row.added && row.deleted && row.id !== null) {
      const stored = image.catalog.space.heap(image.table.heapRoot).get(row.id);
      if (stored === null) {
        throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, "Row to delete does not exist.");
      }
      const oldValues = decodeRow(stored, types);
      const oldKeys = keyOf(oldValues);
      indexes.forEach((index, position) => {
        batch.index(index.root).delete(oldKeys[position] as Buffer, row.id as RowId);
      });
      batch.heap(image.table.heapRoot).delete(row.id);
    } else if (!row.added && !row.deleted && row.original !== null && row.id !== null) {
      const stored = image.catalog.space.heap(image.table.heapRoot).get(row.id);
      if (stored === null) {
        throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, "Row to update does not exist.");
      }
      const oldValues = decodeRow(stored, types);
      const oldKeys = keyOf(oldValues);
      indexes.forEach((index, position) => {
        batch.index(index.root).delete(oldKeys[position] as Buffer, row.id as RowId);
      });
      batch.heap(image.table.heapRoot).update(row.id, encodeRow(row.values, types));
      const newKeys = keyOf(row.values);
      indexes.forEach((index, position) => {
        batch.index(index.root).insert(newKeys[position] as Buffer, row.id as RowId);
      });
    }
  }
}
