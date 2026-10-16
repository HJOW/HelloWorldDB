/**
 * 트랜잭션.
 *
 * 담당
 *  - 시작, 커밋, 롤백. 자동 커밋이 켜져 있으면 문장마다 커밋한다.
 *  - 세이브포인트 : SAVEPOINT, ROLLBACK TO, RELEASE
 *  - 문장 단위 되돌리기 : 문장이 실패하면 그 문장이 한 변경만 되돌리고 트랜잭션은 유지한다.
 *  - 되돌리기 정보의 기록과 적용
 *  - READ COMMITTED : 조회는 커밋된 값과 자기 트랜잭션의 변경만 본다.
 *    조회와 변경이 서로를 기다리게 하지 않는다. (읽기는 txn/rowAccess.ts)
 *  - 커밋은 변경을 디스크에 반영한 뒤에 성공을 알린다. (storage/bufferCache.ts)
 *  - DDL, GRANT, REVOKE, 사용자와 테이블스페이스 관리 문장의 실행 전후 자동 커밋
 *
 * 격리 수준은 READ COMMITTED 하나뿐이다.
 * 미커밋 변경은 데이터 파일에 쓰지 않고 트랜잭션이 메모리에 가진 "오버레이"에만 둔다.
 * 오버레이는 테이블마다 (새로 넣은 행, 바꾼 커밋 행, 지운 커밋 행)을 가진다. 변경은 행 단위로 기록한다.
 * 읽을 때는 저장된 커밋 값에 자기 오버레이를 덮어 보여 주고(txn/rowAccess.ts),
 * 커밋할 때 짧은 저장 배치 하나로 쓴다. (exec/dml.ts 의 commitTransaction)
 * 한 세션의 문장은 동기적으로 실행되므로 문장 안에서는 끼어들기가 없다.
 * 오버레이 행은 데이터 형식이 저장 행과 같은 값 배열이다. 따라서 트랜잭션 크기는 메모리에 제한된다.
 *
 * 행 단위 접근을 위해 오버레이는 PK 값으로 자기 행을 바로 찾는 맵(`pkRefs`)을 함께 유지한다.
 * 변경과 되돌리기는 모두 `TableOverlay` 의 메서드를 거치므로 맵이 항상 오버레이와 맞는다.
 * DML 은 문장 안에서 변경을 오버레이에 바로 적용하고(되돌리기 항목을 남긴다), 문장의 끝에서 제약을 검사한다.
 * 어기면 세션이 문장 표시(`mark`)까지 되돌린다. (session/session.ts 의 attemptData)
 *
 * 관련 사양 : AGENTS.md 상세 10, 12
 * 구현 단계 : 2단계(저장 엔진과 함께 설계), 7단계(구현), 행 단위 접근(2026-10-16 사용자 결정)
 */

import { DbError, ERROR_CODES } from "../common/errors.js";
import type { RowId } from "../storage/format/format.js";
import type { StoredTable } from "../catalog/catalog.js";
import { encodeKey } from "../types/codec.js";
import type { KeyColumn } from "../types/codec.js";
import type { DataType } from "../types/dataType.js";
import type { SqlValue } from "../types/value.js";

/** 오버레이 테이블을 가리키는 키이다. */
export function overlayKey(tablespace: string, table: string): string {
  return `${tablespace}.${table}`;
}

/** 커밋된 행의 식별 키이다. */
export function committedRowKey(id: RowId): string {
  return `${id.pageId}:${id.slotId}`;
}

/** 키에서 행 식별자를 되돌린다. */
export function parseCommittedRowKey(key: string): RowId {
  const [page, slot] = key.split(":");
  return { pageId: Number(page), slotId: Number(slot) };
}

/** PK 값들을 비교와 잠금 키에 쓰는 16진 표기로 바꾼다. 같은 값이면 같은 문자열이다. (CHAR 의 뒤쪽 공백은 무시) */
export function pkKeyHex(pkValues: SqlValue[], pkTypes: DataType[]): string {
  const columns: KeyColumn[] = pkTypes.map((type) => ({ type }));
  return encodeKey(pkValues, columns).toString("hex");
}

/** 읽은 행이다. 커밋된 행은 id, 자기 트랜잭션이 넣은 행은 tempId 를 가진다. */
export interface OverlayRow {
  id: RowId | null;
  tempId: string | null;
  values: SqlValue[];
}

/** 오버레이가 PK 로 자기 행을 찾을 때 가리키는 행이다. */
export type OverlayPkRef = { kind: "insert"; tempId: string } | { kind: "update"; rowKey: string };

interface InsertEntry {
  tempId: string;
  /** 넣은 순서이다. 삭제를 되돌릴 때 원래 자리로 돌아가게 한다. */
  seq: number;
  values: SqlValue[];
}

/** 테이블 하나의 미커밋 변경이다. 변경은 `Transaction` 이 이 메서드들로만 한다. */
export class TableOverlay {
  readonly table: string;
  /** 오버레이를 처음 만들 때의 테이블 정의 서명이다. 커밋 때 같은지 확인한다. */
  readonly signature: string;
  private readonly insertMap = new Map<string, InsertEntry>();
  private insertSeq = 0;
  /** 삭제 되돌리기로 넣은 순서가 흐트러졌는지이다. 그렇다면 읽을 때 순서를 다시 맞춘다. */
  private disordered = false;
  private readonly updateMap = new Map<string, SqlValue[]>();
  private readonly deleteSet = new Set<string>();
  private readonly pkPositions: number[] | null;
  private readonly pkTypes: DataType[] | null;
  private readonly pkMap = new Map<string, Map<string, OverlayPkRef>>();

  constructor(
    readonly tablespace: string,
    table: StoredTable,
  ) {
    this.table = table.name;
    this.signature = tableSignature(table);
    if (table.pkName === null) {
      this.pkPositions = null;
      this.pkTypes = null;
    } else {
      this.pkPositions = table.pkColumns.map((column) => table.columns.findIndex((entry) => entry.name === column));
      this.pkTypes = this.pkPositions.map((position) => (table.columns[position] as StoredTable["columns"][number]).dataType);
    }
  }

  // ---- 읽기 ----

  get isEmpty(): boolean {
    return this.insertMap.size === 0 && this.updateMap.size === 0 && this.deleteSet.size === 0;
  }

  get insertCount(): number {
    return this.insertMap.size;
  }

  get updateCount(): number {
    return this.updateMap.size;
  }

  get deleteCount(): number {
    return this.deleteSet.size;
  }

  /** 이 트랜잭션이 넣은 행을 넣은 순서대로 돌려준다. */
  insertedRows(): { tempId: string; values: SqlValue[] }[] {
    const entries = [...this.insertMap.values()];
    if (this.disordered) entries.sort((left, right) => left.seq - right.seq);
    return entries;
  }

  getInsert(tempId: string): SqlValue[] | undefined {
    return this.insertMap.get(tempId)?.values;
  }

  /** 바뀐 커밋 행의 새 값이다. 없으면 undefined 이다. */
  getUpdate(rowKey: string): SqlValue[] | undefined {
    return this.updateMap.get(rowKey);
  }

  updatedRows(): IterableIterator<[string, SqlValue[]]> {
    return this.updateMap.entries();
  }

  isDeleted(rowKey: string): boolean {
    return this.deleteSet.has(rowKey);
  }

  deletedKeys(): IterableIterator<string> {
    return this.deleteSet.values();
  }

  /** 테이블에 PK 가 있는지이다. 없으면 `pkRefs` 는 항상 비어 있다. */
  get hasPk(): boolean {
    return this.pkPositions !== null;
  }

  /** 행 값에서 PK 의 16진 표기를 만든다. PK 가 없으면 null 이다. */
  pkHexOf(values: SqlValue[]): string | null {
    if (this.pkPositions === null || this.pkTypes === null) return null;
    return pkKeyHex(
      this.pkPositions.map((position) => (values[position] ?? null) as SqlValue),
      this.pkTypes,
    );
  }

  /** 이 PK 값을 (새 값으로) 가진 오버레이 행들이다. 문장 안에서 PK 가 잠깐 겹칠 수 있어 여럿일 수 있다. */
  pkRefs(pkHex: string): OverlayPkRef[] {
    const found = this.pkMap.get(pkHex);
    return found === undefined ? [] : [...found.values()];
  }

  // ---- 변경 (Transaction 만 부른다) ----

  private pkAdd(values: SqlValue[], refId: string, ref: OverlayPkRef): void {
    const hex = this.pkHexOf(values);
    if (hex === null) return;
    let bucket = this.pkMap.get(hex);
    if (bucket === undefined) {
      bucket = new Map();
      this.pkMap.set(hex, bucket);
    }
    bucket.set(refId, ref);
  }

  private pkRemove(values: SqlValue[], refId: string): void {
    const hex = this.pkHexOf(values);
    if (hex === null) return;
    const bucket = this.pkMap.get(hex);
    if (bucket === undefined) return;
    bucket.delete(refId);
    if (bucket.size === 0) this.pkMap.delete(hex);
  }

  addInsert(tempId: string, values: SqlValue[], seq?: number): number {
    const useSeq = seq ?? ++this.insertSeq;
    if (seq !== undefined && seq < this.insertSeq) this.disordered = true;
    this.insertMap.set(tempId, { tempId, seq: useSeq, values });
    this.pkAdd(values, `i:${tempId}`, { kind: "insert", tempId });
    return useSeq;
  }

  /** 넣은 행을 지우고 그 항목(되돌릴 때 필요한 순서 번호 포함)을 돌려준다. */
  removeInsert(tempId: string): { seq: number; values: SqlValue[] } | undefined {
    const entry = this.insertMap.get(tempId);
    if (entry === undefined) return undefined;
    this.insertMap.delete(tempId);
    this.pkRemove(entry.values, `i:${tempId}`);
    return { seq: entry.seq, values: entry.values };
  }

  setInsertValues(tempId: string, values: SqlValue[]): SqlValue[] | undefined {
    const entry = this.insertMap.get(tempId);
    if (entry === undefined) return undefined;
    const previous = entry.values;
    this.pkRemove(previous, `i:${tempId}`);
    entry.values = values;
    this.pkAdd(values, `i:${tempId}`, { kind: "insert", tempId });
    return previous;
  }

  setUpdate(rowKey: string, values: SqlValue[]): SqlValue[] | undefined {
    const previous = this.updateMap.get(rowKey);
    if (previous !== undefined) this.pkRemove(previous, `u:${rowKey}`);
    this.updateMap.set(rowKey, values);
    this.pkAdd(values, `u:${rowKey}`, { kind: "update", rowKey });
    return previous;
  }

  clearUpdate(rowKey: string): SqlValue[] | undefined {
    const previous = this.updateMap.get(rowKey);
    if (previous === undefined) return undefined;
    this.updateMap.delete(rowKey);
    this.pkRemove(previous, `u:${rowKey}`);
    return previous;
  }

  addDelete(rowKey: string): boolean {
    if (this.deleteSet.has(rowKey)) return false;
    this.deleteSet.add(rowKey);
    return true;
  }

  removeDelete(rowKey: string): void {
    this.deleteSet.delete(rowKey);
  }
}

/** 오버레이의 변경이 있는지 본다. */
export function overlayIsEmpty(overlay: TableOverlay): boolean {
  return overlay.isEmpty;
}

/** 테이블 정의의 서명이다. 정의가 바뀌었는지 비교하는 데만 쓴다. */
export function tableSignature(table: StoredTable): string {
  return JSON.stringify([table.heapRoot, table.columns.map((column) => [column.name, column.dataType])]);
}

/** 되돌리기 항목이다. 문장 표시와 세이브포인트가 같은 목록을 쓴다. */
type UndoOp =
  | { op: "drop-insert"; table: string; tempId: string }
  | { op: "restore-insert"; table: string; tempId: string; prev: SqlValue[] }
  | { op: "reinsert"; table: string; tempId: string; values: SqlValue[]; seq: number }
  | { op: "set-update"; table: string; key: string; prev: SqlValue[] | undefined }
  | { op: "remove-delete"; table: string; key: string };

/** 변경할 행을 가리킨다. 커밋된 행은 id, 이 트랜잭션이 넣은 행은 tempId 이다. */
export interface RowRef {
  id: RowId | null;
  tempId: string | null;
}

/**
 * 진행 중인 트랜잭션 하나이다. 세션이 하나씩 가진다.
 * 카탈로그 정의(DDL 결과)는 오버레이에 두지 않는다. DDL 은 자동 커밋으로 바로 쓴다.
 */
export class Transaction {
  private readonly tables = new Map<string, TableOverlay>();
  private readonly undo: UndoOp[] = [];
  private readonly savepoints = new Map<string, { mark: number; seq: number }>();
  private savepointSeq = 0;
  private tempSeq = 0;

  /** id 는 잠금 소유자 번호를 겸한다. explicit 이 true 면 COMMIT 이나 ROLLBACK 까지 이어진다. */
  constructor(
    readonly id: number,
    readonly explicit: boolean,
  ) {}

  /** 문장 시작 표시이다. 실패하면 이 위치까지 되돌린다. */
  mark(): number {
    return this.undo.length;
  }

  /** 표시까지 되돌린다. 표시 이후의 되돌리기 항목을 역순으로 적용한다. */
  truncateTo(mark: number): void {
    while (this.undo.length > mark) {
      const op = this.undo.pop() as UndoOp;
      const overlay = this.tables.get(op.table);
      if (overlay === undefined) continue;
      switch (op.op) {
        case "drop-insert":
          overlay.removeInsert(op.tempId);
          break;
        case "restore-insert":
          overlay.setInsertValues(op.tempId, op.prev);
          break;
        case "reinsert":
          overlay.addInsert(op.tempId, op.values, op.seq);
          break;
        case "set-update":
          if (op.prev === undefined) overlay.clearUpdate(op.key);
          else overlay.setUpdate(op.key, op.prev);
          break;
        case "remove-delete":
          overlay.removeDelete(op.key);
          break;
      }
    }
  }

  /** 세이브포인트를 만든다. 같은 이름이 있으면 바꾼다. */
  savepoint(name: string): void {
    this.savepointSeq++;
    this.savepoints.set(name, { mark: this.undo.length, seq: this.savepointSeq });
  }

  /** 세이브포인트까지 되돌린다. 세이브포인트 자체는 남고, 이후에 만든 세이브포인트는 사라진다. */
  rollbackTo(name: string): void {
    const found = this.savepoints.get(name);
    if (found === undefined) {
      throw new DbError("3B001", ERROR_CODES.INVALID_SAVEPOINT, `Savepoint does not exist: "${name}".`);
    }
    this.truncateTo(found.mark);
    for (const [other, state] of [...this.savepoints]) {
      if (state.seq > found.seq) this.savepoints.delete(other);
    }
  }

  /** 세이브포인트를 푼다. 이후에 만든 것도 함께 사라진다. 변경은 되돌리지 않는다. */
  release(name: string): void {
    const found = this.savepoints.get(name);
    if (found === undefined) {
      throw new DbError("3B001", ERROR_CODES.INVALID_SAVEPOINT, `Savepoint does not exist: "${name}".`);
    }
    for (const [other, state] of [...this.savepoints]) {
      if (state.seq >= found.seq) this.savepoints.delete(other);
    }
  }

  /** 오버레이를 돌려준다. 없을 때 def 가 있으면 만들고, 없으면 undefined 이다. */
  overlayFor(tablespace: string, tableName: string, def: StoredTable | null): TableOverlay | undefined {
    const key = overlayKey(tablespace, tableName);
    const found = this.tables.get(key);
    if (found !== undefined || def === null) return found;
    const overlay = new TableOverlay(tablespace, def);
    this.tables.set(key, overlay);
    return overlay;
  }

  /** 변경이 있는 테이블의 오버레이를 돌려준다. */
  touchedOverlays(): TableOverlay[] {
    return [...this.tables.values()].filter((overlay) => !overlay.isEmpty);
  }

  /** 테이블에 미커밋 변경이 있는지 본다. */
  touches(tablespace: string, table: string): boolean {
    const overlay = this.overlayFor(tablespace, table, null);
    return overlay !== undefined && !overlay.isEmpty;
  }

  /** 미커밋 변경이 하나라도 있는지 본다. */
  hasChanges(): boolean {
    for (const overlay of this.tables.values()) {
      if (!overlay.isEmpty) return true;
    }
    return false;
  }

  /** 오버레이 행에 붙는 임시 식별자이다. 트랜잭션 안에서 유일하다. */
  newTempId(): string {
    this.tempSeq++;
    return `T${this.id}:${this.tempSeq}`;
  }

  private pushUndo(op: UndoOp): void {
    this.undo.push(op);
  }

  private overlayOf(tablespace: string, table: StoredTable): { overlay: TableOverlay; tableKey: string } {
    const overlay = this.overlayFor(tablespace, table.name, table) as TableOverlay;
    return { overlay, tableKey: overlayKey(tablespace, table.name) };
  }

  // -------------------------------------------------------------------------
  // 행 단위 변경. 변경과 제약 검사를 마친 뒤 호출자가 문장 끝에서 잠금을 한꺼번에 건다.
  // 되돌리기 항목을 남기므로 문장이 실패하면 표시까지 되돌릴 수 있다.
  // -------------------------------------------------------------------------

  /** 새 행을 넣는다. 임시 식별자를 돌려준다. */
  insertRow(tablespace: string, table: StoredTable, values: SqlValue[]): string {
    const { overlay, tableKey } = this.overlayOf(tablespace, table);
    const tempId = this.newTempId();
    overlay.addInsert(tempId, [...values]);
    this.pushUndo({ op: "drop-insert", table: tableKey, tempId });
    return tempId;
  }

  /** 행의 값을 바꾼다. 커밋된 행이면 바뀐 값을, 이 트랜잭션이 넣은 행이면 넣은 값을 고친다. */
  updateRow(tablespace: string, table: StoredTable, ref: RowRef, values: SqlValue[]): void {
    const { overlay, tableKey } = this.overlayOf(tablespace, table);
    if (ref.tempId !== null) {
      const previous = overlay.setInsertValues(ref.tempId, [...values]);
      if (previous === undefined) {
        throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, "Transaction overlay entry is missing.");
      }
      this.pushUndo({ op: "restore-insert", table: tableKey, tempId: ref.tempId, prev: previous });
      return;
    }
    if (ref.id === null) {
      throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, "Transaction row has no identity.");
    }
    const key = committedRowKey(ref.id);
    const previous = overlay.setUpdate(key, [...values]);
    this.pushUndo({ op: "set-update", table: tableKey, key, prev: previous });
  }

  /** 행을 지운다. 이 트랜잭션이 넣은 행이면 오버레이에서 없애고, 커밋된 행이면 지운 행으로 표시한다. */
  deleteRow(tablespace: string, table: StoredTable, ref: RowRef): void {
    const { overlay, tableKey } = this.overlayOf(tablespace, table);
    if (ref.tempId !== null) {
      const removed = overlay.removeInsert(ref.tempId);
      if (removed === undefined) {
        throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, "Transaction overlay entry is missing.");
      }
      this.pushUndo({ op: "reinsert", table: tableKey, tempId: ref.tempId, values: removed.values, seq: removed.seq });
      return;
    }
    if (ref.id === null) {
      throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, "Transaction row has no identity.");
    }
    const key = committedRowKey(ref.id);
    const previous = overlay.clearUpdate(key);
    if (previous !== undefined) this.pushUndo({ op: "set-update", table: tableKey, key, prev: previous });
    if (overlay.addDelete(key)) this.pushUndo({ op: "remove-delete", table: tableKey, key });
  }
}
