/**
 * DML의 행 단위 변경 목록과 제약 검사.
 * 변경한 행만 오버레이에 기록하고, PK/FK 인덱스 또는 필요한 자식 행의 지연 탐색으로 검사한다.
 * 참조동작은 작업 목록으로 전파하며 문장 실패의 되돌리기는 Session이 담당한다.
 * 관련 사양 : AGENTS.md 상세 10, 11. 구현 단계 : DML 행 단위 접근 2부.
 */

import { runSync, mapWork, everyWork, forEachWork } from "./work.js";
import type { Work } from "./work.js";
import { DbError, ERROR_CODES, withPosition } from "../common/errors.js";
import type { SourcePosition } from "../common/errors.js";
import type { CatalogStore, StoredConstraint, StoredTable } from "../catalog/catalog.js";
import type { DataType } from "../types/dataType.js";
import type { SqlValue } from "../types/value.js";
import { committedRowKey, pkKeyHex } from "../txn/transaction.js";
import type { OverlayRow, RowRef, Transaction } from "../txn/transaction.js";
import { findVisibleByIndex, findVisibleByPk, visibleRowById, visibleRows } from "../txn/rowAccess.js";
import type { IndexSpec } from "../txn/rowAccess.js";
import { lockConflict, pkLockKey, rowLockKey } from "../txn/lockManager.js";
import type { LockSink } from "../txn/lockManager.js";

export interface RowTarget {
  catalog: CatalogStore;
  tablespace: string;
  table: StoredTable;
}

export interface RowChange {
  target: RowTarget;
  ref: RowRef;
  before: SqlValue[] | null;
  after: SqlValue[] | null;
}

export function rowRefKey(ref: RowRef): string {
  return ref.id === null ? `t${ref.tempId}` : `c${committedRowKey(ref.id)}`;
}

export function valuesOf(table: StoredTable, columns: readonly string[], values: SqlValue[]): SqlValue[] {
  return columns.map((name) => values[table.columns.findIndex((column) => column.name === name)] ?? null);
}

function columnTypes(table: StoredTable, columns: readonly string[]): DataType[] {
  return columns.map((name) => table.columns.find((column) => column.name === name)!.dataType);
}

function keyOf(table: StoredTable, columns: readonly string[], values: SqlValue[]): string {
  return pkKeyHex(valuesOf(table, columns, values), columnTypes(table, columns));
}

function violation(constraint: StoredConstraint, position?: SourcePosition): never {
  fail("23503", ERROR_CODES.FOREIGN_KEY_VIOLATION, `Foreign key "${constraint.name}" is violated.`, position);
}

function fail(state: string, code: number, message: string, position?: SourcePosition): never {
  const error = new DbError(state, code, message);
  throw position === undefined ? error : withPosition(error, position);
}

/** 문장 시작 값과 최종 값만 보관한다. 전파용 작업 목록에는 중간 변경도 남긴다. */
export class RowChanges {
  private readonly tables = new Map<StoredTable, Map<string, RowChange>>();
  private pending: RowChange[] = [];

  constructor(readonly txn: Transaction) {}

  all(): RowChange[] {
    return [...this.tables.values()].flatMap((rows) => [...rows.values()]);
  }

  forTable(table: StoredTable): Iterable<RowChange> {
    return this.tables.get(table)?.values() ?? [];
  }

  private record(change: RowChange): void {
    let rows = this.tables.get(change.target.table);
    if (rows === undefined) {
      rows = new Map();
      this.tables.set(change.target.table, rows);
    }
    const key = rowRefKey(change.ref);
    const previous = rows.get(key);
    if (previous === undefined) rows.set(key, { ...change });
    else previous.after = change.after;
    this.pending.push(change);
  }

  insert(target: RowTarget, values: SqlValue[]): void {
    const tempId = this.txn.insertRow(target.tablespace, target.table, values);
    this.record({ target, ref: { id: null, tempId }, before: null, after: values });
  }

  update(target: RowTarget, row: OverlayRow, values: SqlValue[]): void {
    this.txn.updateRow(target.tablespace, target.table, row, values);
    this.record({ target, ref: { id: row.id, tempId: row.tempId }, before: row.values, after: values });
  }

  delete(target: RowTarget, row: OverlayRow): void {
    this.txn.deleteRow(target.tablespace, target.table, row);
    this.record({ target, ref: { id: row.id, tempId: row.tempId }, before: row.values, after: null });
  }

  takePending(): RowChange[] {
    const pending = this.pending;
    this.pending = [];
    return pending;
  }

  /** 커밋 재검사용 기록이다. 오버레이는 변경하지 않는다. */
  addForValidation(change: RowChange): void {
    this.record(change);
  }
}

function currentRow(target: RowTarget, txn: Transaction, ref: RowRef): OverlayRow | null {
  if (ref.id !== null) return visibleRowById(target.catalog, target.tablespace, target.table, txn, ref.id);
  const values = txn.overlayFor(target.tablespace, target.table.name, null)?.getInsert(ref.tempId!);
  return values === undefined ? null : { ...ref, values };
}

function parentTarget(target: RowTarget, constraint: StoredConstraint): RowTarget {
  return { ...target, table: target.catalog.data.tables[constraint.refTable!]! };
}

/** REFERENCES의 컬럼 순서가 PK와 다르면 PK 순서로 재배열한다. */
function* parentExistsSteps(parent: RowTarget, constraint: StoredConstraint, txn: Transaction, values: SqlValue[]): Work<boolean> {
  const columns = constraint.refColumns!;
  if (columns.length === parent.table.pkColumns.length && (yield* everyWork(parent.table.pkColumns, function* (name) {
    return columns.includes(name);
  }))) {
    const pk = (yield* mapWork(parent.table.pkColumns, function* (name) {
      return values[columns.indexOf(name)]!;
    }));
    return findVisibleByPk(parent.catalog, parent.tablespace, parent.table, txn, pk).length > 0;
  }
  const key = pkKeyHex(values, columnTypes(parent.table, columns));
  for (const row of visibleRows(parent.catalog, parent.tablespace, parent.table, txn)) {
    yield;
    if (keyOf(parent.table, columns, row.values) === key) return true;
  }
  return false;
}

/** FK의 모든 컬럼이 인덱스 앞쪽의 같은 집합이면 순서와 ASC/DESC에 맞추어 사용한다. */
function childIndex(child: RowTarget, constraint: StoredConstraint): IndexSpec | undefined {
  const indexes: IndexSpec[] = [];
  if (child.table.pkIndexRoot !== null) {
    indexes.push({ root: child.table.pkIndexRoot, columns: child.table.pkColumns.map((name) => ({ name, descending: false })) });
  }
  for (const index of Object.values(child.catalog.data.indexes)) {
    if (index.table === child.table.name) indexes.push({ root: index.indexRoot, columns: index.columns });
  }
  return indexes.find((index) => index.columns.length >= constraint.columns.length &&
    index.columns.slice(0, constraint.columns.length).every((column) => constraint.columns.includes(column.name)));
}

interface ParentWork {
  parent: RowTarget;
  child: RowTarget;
  constraint: StoredConstraint;
  removed: Map<string, RowChange>;
}

/** 같은 FK의 사라진 부모 키를 묶어 자식 힙을 부모 행마다 다시 읽지 않는다. */
function* parentWorkSteps(changes: readonly RowChange[], txn: Transaction): Work<ParentWork[]> {
  const work = new Map<StoredConstraint, ParentWork>();
  for (const change of changes) {
    yield;
    if (change.before === null) continue;
    const { target } = change;
    for (const constraint of Object.values(target.catalog.data.constraints)) {
      yield;
      if (constraint.kind !== "FOREIGN KEY" || constraint.refTable !== target.table.name) continue;
      const columns = constraint.refColumns!;
      const key = keyOf(target.table, columns, change.before);
      if (change.after !== null && keyOf(target.table, columns, change.after) === key) continue;
      const values = valuesOf(target.table, columns, change.before);
      if ((yield* parentExistsSteps(target, constraint, txn, values)))
        continue;
      let item = work.get(constraint);
      if (item === undefined) {
        item = { parent: target, child: { ...target, table: target.catalog.data.tables[constraint.table]! }, constraint, removed: new Map() };
        work.set(constraint, item);
      }
      item.removed.set(key, change);
    }
  }
  return [...work.values()];
}

/**
 * 찾은 키에 대응하는 행 식별자만 보관한다. 최종 검사에서는 다시 순회하지 않고 현재 값을 읽는다.
 * 연쇄의 다음 차례에서 새로운 부모 키가 생긴 경우에만 그 키들을 추가로 찾는다.
 */
class ChildLookup {
  private readonly cache = new Map<StoredConstraint, Map<string, RowRef[]>>();

  constructor(private readonly changes: RowChanges) {}

  find(work: ParentWork): OverlayRow[] {
    return runSync(this.findSteps(work));
  }

  *findSteps(work: ParentWork): Work<OverlayRow[]> {
    const { child, constraint, removed } = work;
    let cache = this.cache.get(constraint);
    if (cache === undefined) {
      cache = new Map();
      this.cache.set(constraint, cache);
    }
    const missing = new Set([...removed.keys()].filter((key) => !cache.has(key)));
    for (const key of missing) cache.set(key, []);
    const types = columnTypes(work.parent.table, constraint.refColumns!);
    const rowKey = (row: OverlayRow): string | null => {
      const values = valuesOf(child.table, constraint.columns, row.values);
      return values.includes(null) ? null : pkKeyHex(values, types);
    };
    const index = childIndex(child, constraint);
    if (missing.size > 0) {
      if (index === undefined) {
        for (const row of visibleRows(child.catalog, child.tablespace, child.table, this.changes.txn)) {
          yield;
          const key = rowKey(row);
          if (key !== null && missing.has(key)) cache.get(key)!.push({ id: row.id, tempId: row.tempId });
        }
      } else {
        for (const key of missing) {
          yield;
          const change = removed.get(key)!;
          const parentValues = valuesOf(work.parent.table, constraint.refColumns!, change.before!);
          const values = index.columns.slice(0, constraint.columns.length).map((column) => parentValues[constraint.columns.indexOf(column.name)]!);
          const rows = findVisibleByIndex(child.catalog, child.tablespace, child.table, this.changes.txn, index, values);
          cache.set(key, rows.map((row) => ({ id: row.id, tempId: row.tempId })));
        }
      }
    }
    const refs = new Map<string, RowRef>();
    for (const key of removed.keys()) {
      yield;
      for (const ref of cache.get(key)!) refs.set(rowRefKey(ref), ref);
    }
    // 앞선 탐색 이후 연쇄로 FK가 바뀐 행도 포함한다.
    for (const change of this.changes.forTable(child.table)) refs.set(rowRefKey(change.ref), change.ref);
    const rows: OverlayRow[] = [];
    for (const ref of refs.values()) {
      yield;
      const row = currentRow(child, this.changes.txn, ref);
      if (row === null) continue;
      const key = rowKey(row);
      if (key !== null && removed.has(key)) rows.push(row);
    }
    return rows;
  }
}

function* checkRowsSteps(changes: RowChanges, position?: SourcePosition): Work<void> {
  for (const change of changes.all()) {
    yield;
    if (change.after === null) continue;
    const { target, before, after } = change;
    for (let index = 0; index < target.table.columns.length; index++) {
      yield;
      const column = target.table.columns[index]!;
      if (column.notNull && after[index] === null) {
        fail("23502", ERROR_CODES.NOT_NULL_VIOLATION, `NULL violates NOT NULL of column "${column.name}".`, position);
      }
    }
    if (target.table.pkName !== null && (before === null ||
      keyOf(target.table, target.table.pkColumns, before) !== keyOf(target.table, target.table.pkColumns, after))) {
      if (findVisibleByPk(target.catalog, target.tablespace, target.table, changes.txn, valuesOf(target.table, target.table.pkColumns, after)).length > 1) {
        fail("23505", ERROR_CODES.DUPLICATE_KEY, `Duplicate primary key in table "${target.table.name}".`, position);
      }
    }
  }
}

function* checkChildReferencesSteps(changes: RowChanges, allUpdated: boolean, position?: SourcePosition): Work<void> {
  for (const { target, before, after } of changes.all()) {
    yield;
    if (after === null) continue;
    for (const constraint of Object.values(target.catalog.data.constraints)) {
      yield;
      if (constraint.kind !== "FOREIGN KEY" || constraint.table !== target.table.name) continue;
      if (!allUpdated && before !== null && keyOf(target.table, constraint.columns, before) === keyOf(target.table, constraint.columns, after)) continue;
      const values = valuesOf(target.table, constraint.columns, after);
      if (values.includes(null)) continue;
      if (!(yield* parentExistsSteps(parentTarget(target, constraint), constraint, changes.txn, values)))
        violation(constraint, position);
    }
  }
}

/** 참조동작이 끝난 뒤 NO ACTION도 검사하므로 FK 등록 순서에 결과가 좌우되지 않는다. */
export function finishRowChanges(changes: RowChanges, locker: LockSink, position?: SourcePosition): void {
  return runSync(finishRowChangesSteps(changes, locker, position));
}

/** 참조동작이 끝난 뒤 NO ACTION도 검사하므로 FK 등록 순서에 결과가 좌우되지 않는다. */
export function* finishRowChangesSteps(changes: RowChanges, locker: LockSink, position?: SourcePosition): Work<void> {
  (yield* checkRowsSteps(changes, position));
  const lookup = new ChildLookup(changes);
  for (;;) {
    yield;
    const pending = changes.takePending();
    if (pending.length === 0) break;
    for (const work of (yield* parentWorkSteps(pending, changes.txn))) {
      yield;
      for (const row of (yield* lookup.findSteps(work))) {
        yield;
        // 같은 차례의 다른 참조동작에서 이미 바뀌거나 지워진 행은 현재 값으로 판정한다.
        const current = currentRow(work.child, changes.txn, row);
        if (current === null) continue;
        const values = valuesOf(work.child.table, work.constraint.columns, current.values);
        if (values.includes(null)) continue;
        const key = pkKeyHex(values, columnTypes(work.parent.table, work.constraint.refColumns!));
        const parent = work.removed.get(key);
        if (parent === undefined || (yield* parentExistsSteps(work.parent, work.constraint, changes.txn, values)))
          continue;
        const action = parent.after === null ? work.constraint.onDelete : work.constraint.onUpdate;
        if (action === "CASCADE" && parent.after === null) {
          changes.delete(work.child, current);
        }
        else if (action === "CASCADE" || action === "SET NULL") {
          const next = [...current.values];
          const replacement = parent.after === null ? [] : valuesOf(work.parent.table, work.constraint.refColumns!, parent.after);
          (yield* forEachWork(work.constraint.columns, function* (name, index) {
            const column = work.child.table.columns.findIndex((entry) => entry.name === name);
            if (action === "SET NULL" && work.child.table.columns[column]!.notNull) {
              fail("23502", ERROR_CODES.NOT_NULL_VIOLATION, `SET NULL violates NOT NULL of column "${name}".`, position);
            }
            next[column] = action === "SET NULL" ? null : replacement[index]!;
          }));
          changes.update(work.child, current, next);
        }
      }
    }
  }
  (yield* checkRowsSteps(changes, position));
  (yield* checkChildReferencesSteps(changes, false, position));
  for (const work of (yield* parentWorkSteps(changes.all(), changes.txn))) {
    yield;
    if ((yield* lookup.findSteps(work)).length > 0) violation(work.constraint, position);
  }
  const keys: string[] = [];
  for (const { target, ref, before, after } of changes.all()) {
    yield;
    if (ref.id !== null) keys.push(rowLockKey(target.tablespace, target.table.name, ref.id));
    if (after !== null && target.table.pkName !== null && (before === null ||
      keyOf(target.table, target.table.pkColumns, before) !== keyOf(target.table, target.table.pkColumns, after))) {
      keys.push(pkLockKey(target.tablespace, target.table.name, keyOf(target.table, target.table.pkColumns, after)));
    }
  }
  const result = locker.tryAcquireAll(changes.txn.id, keys);
  if (!result.ok) throw lockConflict(result.key);
}

/** 커밋에서는 연쇄 없이 변경한 행과 사라진 부모 키만 재검사한다. */
export function revalidateRowReferences(txn: Transaction, entries: RowChange[]): void {
  const changes = new RowChanges(txn);
  // 기록만 넣는다. 커밋 직전에 오버레이나 되돌리기 항목을 바꾸지 않는다.
  for (const entry of entries) changes.addForValidation(entry);
  runSync(checkChildReferencesSteps(changes, true));
  const lookup = new ChildLookup(changes);
  for (const work of runSync(parentWorkSteps(entries, txn))) {
    if (lookup.find(work).length > 0) violation(work.constraint);
  }
}
