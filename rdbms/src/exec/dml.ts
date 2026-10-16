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
 *  - 트랜잭션 커밋 : 오버레이의 변경을 저장 배치로 쓴다. (commitTransaction)
 *
 * 문장은 변경할 행의 값을 먼저 계산하고 오버레이에 적용한 뒤, 변경 행의 제약을 검사하고 잠금을 건다.
 * 데이터 파일에는 쓰지 않는다. 쓰기는 커밋할 때 한 번 한다.
 * 자동 커밋 문장은 문장 하나짜리 트랜잭션이며, 세션이 문장 직후 커밋한다.
 * TRUNCATE 는 DDL 처럼 실행 전후에 자동으로 커밋된다. (session/session.ts)
 *
 * 관련 사양 : AGENTS.md 상세 1-3, 1-4, 10, 11
 * 구현 단계 : 6단계, 7단계(트랜잭션 연동), DML 행 단위 접근 2부
 */

import { DbError, ERROR_CODES, withPosition } from "../common/errors.js";
import type { SourcePosition } from "../common/errors.js";
import { NO_TABLESPACE } from "../common/instance.js";
import { noCurrentTablespace } from "../auth/privileges.js";
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
import type { SqlValue } from "../types/value.js";
import { decodeRow, encodeKey, encodeRow } from "../types/codec.js";
import type { KeyColumn } from "../types/codec.js";
import type { RowId, StorageBatch } from "../storage/format/format.js";
import type { CatalogStore, StoredTable } from "../catalog/catalog.js";
import type { TablespaceManager } from "../catalog/tablespaceManager.js";
import { dataHandlers, executeQuery, scanTableForDml, typeHandlers } from "./executor.js";
import type { QueryContext } from "./executor.js";
import { evaluateExpression } from "./expression.js";
import { atInnerLevel } from "./expression.js";
import { rewriteViewColumns, viewColumnMapping } from "./analyzer.js";
import { assertNotDictionaryObject, executeTruncateTable } from "./ddl.js";
import { parseCommittedRowKey, tableSignature } from "../txn/transaction.js";
import type { Transaction, TableOverlay } from "../txn/transaction.js";
import { visibleRows } from "../txn/rowAccess.js";
import { RowChanges, finishRowChanges, revalidateRowReferences, valuesOf } from "./rowChanges.js";
import type { RowChange, RowTarget } from "./rowChanges.js";

function fail(sqlState: string, code: number, message: string, position?: SourcePosition): never {
  if (position !== undefined) {
    throw withPosition(new DbError(sqlState, code, message), position);
  }
  throw new DbError(sqlState, code, message);
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
  if (tablespace === NO_TABLESPACE) throw noCurrentTablespace(target.position);
  if (!manager.has(tablespace)) {
    fail("3D000", ERROR_CODES.TABLESPACE_NOT_FOUND, `Tablespace does not exist: "${tablespace}".`, target.position);
  }
  assertNotDictionaryObject(manager, tablespace, target.name, target.position);
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
  // 생략한 컬럼의 DEFAULT도 변경을 적용하기 전에 모두 계산한다.
  const fullRows = sourceRows.map((source) => table.columns.map((column) => {
    const position = insertColumns.findIndex((entry) => entry.name === column.name);
    return position >= 0 ? (source[position] ?? null) as SqlValue : evaluateColumnDefault(column, ctx);
  }));
  const changes = new RowChanges(ctx.txn);
  for (const values of fullRows) changes.insert(resolved, values);
  finishRowChanges(changes, ctx.locker, stmt.target.position);
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
      subqueries: dataHandlers([], ctx),
      typeSubqueries: typeHandlers(ctx),
    };
    return toColumnValue(evaluateExpression(expression, evalCtx, column.dataType), column, ctx, position);
  });
}

/**
 * 식의 결과를 컬럼 타입에 맞춘다. 스칼라 서브쿼리처럼 기대 타입을 따르지 않는 식은
 * 자기 타입의 값을 돌려주므로, 저장하기 전에 암묵적 형변환과 길이·범위 검사를 거친다.
 */
function toColumnValue(
  bound: { value: SqlValue; type: DataType },
  column: StoredTable["columns"][number],
  ctx: QueryContext,
  position?: SourcePosition,
): SqlValue {
  if (bound.value === null) return null;
  if (!isImplicitlyConvertible(bound.type, column.dataType)) {
    fail("42804", 2011, `Cannot convert ${bound.type.name} to ${column.dataType.name} implicitly; use CAST.`, position);
  }
  return assignValue(bound.value, bound.type, column.dataType, ctx.typeCtx);
}

/** 컬럼의 DEFAULT를 평가한다. 없으면 NULL이다. */
function evaluateColumnDefault(column: StoredTable["columns"][number], ctx: QueryContext): SqlValue {
  if (column.defaultExpr === null) return null;
  const evalCtx = {
    typeCtx: ctx.typeCtx,
    params: ctx.params,
    scopes: [...ctx.outerScopes],
    currentUser: ctx.currentUser,
    subqueries: dataHandlers([], ctx),
    typeSubqueries: typeHandlers(ctx),
  };
  return toColumnValue(evaluateExpression(column.defaultExpr, evalCtx, column.dataType), column, ctx);
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
  const found = scanTableForDml(resolved.catalog, table, resolved.tablespace, alias, where, ctx);
  // 서브쿼리와 DEFAULT는 문장 시작 상태에서 평가한다. 아직 오버레이를 바꾸지 않는다.
  const updates = found.map((row) => {
    const newValues = [...row.values];
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
        subqueries: dataHandlers(row.scopes, ctx),
        typeSubqueries: typeHandlers(ctx),
      };
      newValues[index] = toColumnValue(
        evaluateExpression(assignment.value, evalCtx, assignment.column.dataType),
        assignment.column,
        ctx,
        stmt.target.position,
      );
    }
    return { row, values: newValues };
  });
  const changes = new RowChanges(ctx.txn);
  for (const update of updates) changes.update(resolved, update.row, update.values);
  finishRowChanges(changes, ctx.locker, stmt.target.position);
  return found.length;
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
  const found = scanTableForDml(resolved.catalog, table, resolved.tablespace, alias, where, ctx);
  const changes = new RowChanges(ctx.txn);
  for (const row of found) changes.delete(resolved, row);
  finishRowChanges(changes, ctx.locker, stmt.target.position);
  return found.length;
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
    // 참조 무결성이 유지되므로 NULL이 없는 자식 FK는 부모에 존재한다.
    // 첫 참조 행에서 멈추며 부모 테이블을 읽지 않는다.
    for (const row of visibleRows(childCatalog, resolved.tablespace, childTable, null)) {
      if (valuesOf(childTable, constraint.columns, row.values).includes(null)) continue;
      fail("23503", ERROR_CODES.FOREIGN_KEY_VIOLATION, `Table "${resolved.table.name}" is referenced by "${constraint.table}".`, stmt.name.position);
    }
  }
  executeTruncateTable(manager, currentTablespace, stmt);
  return 0;
}

// ---------------------------------------------------------------------------
// 커밋 : 변경 행만 저장 배치에 쓴다.
// ---------------------------------------------------------------------------

interface CommitTarget extends RowTarget {
  overlay: TableOverlay;
}

/** 테이블 정의가 트랜잭션 시작 이후 바뀌지 않았는지 확인한다. */
function resolveOverlay(manager: TablespaceManager, overlay: TableOverlay): CommitTarget {
  const changed = (what: string): DbError => new DbError("40001", ERROR_CODES.TRANSACTION_CONFLICT,
    `Table "${overlay.tablespace}.${overlay.table}" was ${what} during the transaction.`);
  if (!manager.has(overlay.tablespace)) throw changed("dropped");
  const catalog = manager.requireCatalog(overlay.tablespace);
  const table = catalog.data.tables[overlay.table];
  if (table === undefined) throw changed("dropped");
  if (tableSignature(table) !== overlay.signature) throw changed("altered");
  return { catalog, tablespace: overlay.tablespace, table, overlay };
}

/** 바꾼 커밋 행만 위치로 읽어 FK 재검사용 옛 값과 새 값을 모은다. */
function referenceChanges(targets: CommitTarget[]): RowChange[] {
  const changes: RowChange[] = [];
  for (const target of targets) {
    const { catalog, table, overlay } = target;
    const types = table.columns.map((column) => column.dataType);
    const oldValues = (id: RowId): SqlValue[] => {
      const data = catalog.space.heap(table.heapRoot).get(id);
      if (data === null) throw new DbError("40001", ERROR_CODES.TRANSACTION_CONFLICT, "Changed row does not exist.");
      return decodeRow(data, types);
    };
    for (const key of overlay.deletedKeys()) {
      const id = parseCommittedRowKey(key);
      changes.push({ target, ref: { id, tempId: null }, before: oldValues(id), after: null });
    }
    for (const [key, values] of overlay.updatedRows()) {
      const id = parseCommittedRowKey(key);
      changes.push({ target, ref: { id, tempId: null }, before: oldValues(id), after: values });
    }
    for (const row of overlay.insertedRows()) {
      changes.push({ target, ref: { id: null, tempId: row.tempId }, before: null, after: row.values });
    }
  }
  return changes;
}

/** 변경을 테이블스페이스마다 배치 하나로 쓴다. 성공 시 fsync가 끝나 있다. */
export function commitTransaction(manager: TablespaceManager, txn: Transaction, validate: boolean): void {
  const targets = txn.touchedOverlays().map((overlay) => resolveOverlay(manager, overlay));
  if (targets.length === 0) return;
  if (validate) revalidateRowReferences(txn, referenceChanges(targets));
  const batches = new Map<string, StorageBatch>();
  try {
    for (const target of targets) {
      let batch = batches.get(target.tablespace);
      if (batch === undefined) {
        batch = target.catalog.space.begin();
        batches.set(target.tablespace, batch);
      }
      writeOverlay(target, batch);
    }
    for (const batch of batches.values()) batch.commit();
  } catch (error) {
    for (const batch of batches.values()) {
      try { batch.rollback(); } catch { /* 원래 오류를 유지한다. */ }
    }
    throw error;
  }
}

/** 옛 인덱스 항목을 모두 지운 뒤 새 항목을 넣어 PK 맞바꾸기도 처리한다. */
function writeOverlay(target: CommitTarget, batch: StorageBatch): void {
  const { catalog, table, overlay } = target;
  const types = table.columns.map((column) => column.dataType);
  const indexes: { root: number; columns: { name: string; descending: boolean }[] }[] = [];
  if (table.pkName !== null && table.pkIndexRoot !== null) {
    indexes.push({ root: table.pkIndexRoot, columns: table.pkColumns.map((name) => ({ name, descending: false })) });
  }
  for (const index of Object.values(catalog.data.indexes)) {
    if (index.table === table.name) indexes.push({ root: index.indexRoot, columns: index.columns });
  }
  const keyColumns = indexes.map((index) => index.columns.map((column): KeyColumn => ({
    type: table.columns.find((entry) => entry.name === column.name)!.dataType,
    descending: column.descending,
  })));
  const keysOf = (values: SqlValue[]): Buffer[] => indexes.map((index, position) =>
    encodeKey(valuesOf(table, index.columns.map((column) => column.name), values), keyColumns[position]!));
  const removeOldKeys = (id: RowId): void => {
    const stored = catalog.space.heap(table.heapRoot).get(id);
    if (stored === null) throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, "Changed row does not exist.");
    const keys = keysOf(decodeRow(stored, types));
    indexes.forEach((index, position) => batch.index(index.root).delete(keys[position]!, id));
  };
  for (const key of overlay.deletedKeys()) {
    const id = parseCommittedRowKey(key);
    removeOldKeys(id);
    batch.heap(table.heapRoot).delete(id);
  }
  for (const [key] of overlay.updatedRows()) removeOldKeys(parseCommittedRowKey(key));
  for (const [key, values] of overlay.updatedRows()) {
    const id = parseCommittedRowKey(key);
    batch.heap(table.heapRoot).update(id, encodeRow(values, types));
    const keys = keysOf(values);
    indexes.forEach((index, position) => batch.index(index.root).insert(keys[position]!, id));
  }
  for (const row of overlay.insertedRows()) {
    const id = batch.heap(table.heapRoot).insert(encodeRow(row.values, types));
    const keys = keysOf(row.values);
    indexes.forEach((index, position) => batch.index(index.root).insert(keys[position]!, id));
  }
}
