/**
 * 트랜잭션.
 *
 * 담당
 *  - 시작, 커밋, 롤백. 자동 커밋이 켜져 있으면 문장마다 커밋한다.
 *  - 세이브포인트 : SAVEPOINT, ROLLBACK TO, RELEASE
 *  - 문장 단위 되돌리기 : 문장이 실패하면 그 문장이 한 변경만 되돌리고 트랜잭션은 유지한다.
 *  - 되돌리기 정보의 기록과 적용
 *  - READ COMMITTED : 조회는 커밋된 값과 자기 트랜잭션의 변경만 본다.
 *    조회와 변경이 서로를 기다리게 하지 않는다.
 *  - 커밋은 변경을 디스크에 반영한 뒤에 성공을 알린다. (storage/bufferCache.ts)
 *  - DDL, GRANT, REVOKE, 사용자와 테이블스페이스 관리 문장의 실행 전후 자동 커밋
 *
 * 격리 수준은 READ COMMITTED 하나뿐이다.
 * 미커밋 변경은 데이터 파일에 쓰지 않고 트랜잭션이 메모리에 가진 "오버레이"에만 둔다.
 * 오버레이는 테이블마다 (새로 넣은 행, 바꾼 커밋 행, 지운 커밋 행)을 가진다.
 * 읽을 때는 저장된 커밋 값에 자기 오버레이를 덮어 보여 주고(readMergedRows),
 * 커밋할 때 짧은 저장 배치 하나로 쓴다. (exec/dml.ts 의 commitTransaction)
 * 한 세션의 문장은 동기적으로 실행되므로 문장 안에서는 끼어들기가 없다.
 * 오버레이 행은 데이터 형식이 저장 행과 같은 값 배열이다. 따라서 트랜잭션 크기는 메모리에 제한된다.
 *
 * 관련 사양 : AGENTS.md 상세 10, 12
 * 구현 단계 : 2단계(저장 엔진과 함께 설계), 7단계(구현)
 */

import { DbError, ERROR_CODES } from "../common/errors.js";
import type { RowId } from "../storage/format/format.js";
import type { CatalogStore, StoredTable } from "../catalog/catalog.js";
import { decodeRow, encodeKey } from "../types/codec.js";
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

/** 합친 행이다. 커밋된 행은 id, 자기 트랜잭션이 넣은 행은 tempId 를 가진다. */
export interface OverlayRow {
  id: RowId | null;
  tempId: string | null;
  values: SqlValue[];
}

/** 테이블 하나의 미커밋 변경이다. */
export interface TableOverlay {
  tablespace: string;
  table: string;
  /** 오버레이를 처음 만들 때의 테이블 정의 서명이다. 커밋 때 같은지 확인한다. */
  signature: string;
  /** 이 트랜잭션이 새로 넣은 행이다. 넣은 순서대로 둔다. */
  inserts: Array<{ tempId: string; values: SqlValue[] }>;
  /** 바꾼 커밋 행의 새 값이다. 키는 `pageId:slotId` 이다. */
  updates: Map<string, SqlValue[]>;
  /** 지운 커밋 행의 키이다. */
  deletes: Set<string>;
}

function emptyOverlay(tablespace: string, table: StoredTable): TableOverlay {
  return {
    tablespace,
    table: table.name,
    signature: tableSignature(table),
    inserts: [],
    updates: new Map(),
    deletes: new Set(),
  };
}

/** 오버레이의 변경이 있는지 본다. */
export function overlayIsEmpty(overlay: TableOverlay): boolean {
  return overlay.inserts.length === 0 && overlay.updates.size === 0 && overlay.deletes.size === 0;
}

/** 테이블 정의의 서명이다. 정의가 바뀌었는지 비교하는 데만 쓴다. */
export function tableSignature(table: StoredTable): string {
  return JSON.stringify([table.heapRoot, table.columns.map((column) => [column.name, column.dataType])]);
}

/** 되돌리기 항목이다. 문장 표시와 세이브포인트가 같은 목록을 쓴다. */
type UndoOp =
  | { op: "drop-insert"; table: string; tempId: string }
  | { op: "restore-insert"; table: string; tempId: string; prev: SqlValue[] }
  | { op: "reinsert"; table: string; tempId: string; values: SqlValue[]; index: number }
  | { op: "set-update"; table: string; key: string; prev: SqlValue[] | undefined }
  | { op: "remove-delete"; table: string; key: string };

/** 문장 이미지의 한 행이다. exec/dml.ts 의 ImageRow 와 같은 모양이다. */
export interface FoldRow {
  id: RowId | null;
  tempId: string | null;
  values: SqlValue[];
  original: SqlValue[] | null;
  deleted: boolean;
  added: boolean;
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
        case "drop-insert": {
          const index = overlay.inserts.findIndex((entry) => entry.tempId === op.tempId);
          if (index >= 0) overlay.inserts.splice(index, 1);
          break;
        }
        case "restore-insert": {
          const entry = overlay.inserts.find((item) => item.tempId === op.tempId);
          if (entry !== undefined) entry.values = op.prev;
          break;
        }
        case "reinsert": {
          overlay.inserts.splice(Math.min(op.index, overlay.inserts.length), 0, {
            tempId: op.tempId,
            values: op.values,
          });
          break;
        }
        case "set-update": {
          if (op.prev === undefined) overlay.updates.delete(op.key);
          else overlay.updates.set(op.key, op.prev);
          break;
        }
        case "remove-delete": {
          overlay.deletes.delete(op.key);
          break;
        }
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
    const overlay = emptyOverlay(tablespace, def);
    this.tables.set(key, overlay);
    return overlay;
  }

  /** 변경이 있는 테이블의 키와 오버레이를 돌려준다. */
  touchedOverlays(): TableOverlay[] {
    return [...this.tables.values()].filter((overlay) => !overlayIsEmpty(overlay));
  }

  /** 테이블에 미커밋 변경이 있는지 본다. */
  touches(tablespace: string, table: string): boolean {
    const overlay = this.overlayFor(tablespace, table, null);
    return overlay !== undefined && !overlayIsEmpty(overlay);
  }

  /** 미커밋 변경이 하나라도 있는지 본다. */
  hasChanges(): boolean {
    for (const overlay of this.tables.values()) {
      if (!overlayIsEmpty(overlay)) return true;
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

  /**
   * 문장 이미지의 한 행을 오버레이에 접는다. 호출 전에 잠금을 걸어야 한다.
   * 되돌리기 항목을 남기므로 문장이 실패하면 표시까지 되돌릴 수 있다.
   */
  fold(tablespace: string, table: StoredTable, row: FoldRow): void {
    const tableKey = overlayKey(tablespace, table.name);
    const overlay = this.overlayFor(tablespace, table.name, table) as TableOverlay;
    if (row.added) {
      const tempId = this.newTempId();
      overlay.inserts.push({ tempId, values: [...row.values] });
      this.pushUndo({ op: "drop-insert", table: tableKey, tempId });
      return;
    }
    if (row.tempId !== null) {
      // 이 트랜잭션이 앞서 넣은 행이다.
      const index = overlay.inserts.findIndex((item) => item.tempId === row.tempId);
      if (index < 0) {
        throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, "Transaction overlay entry is missing.");
      }
      const entry = overlay.inserts[index] as { tempId: string; values: SqlValue[] };
      if (row.deleted) {
        overlay.inserts.splice(index, 1);
        this.pushUndo({ op: "reinsert", table: tableKey, tempId: entry.tempId, values: entry.values, index });
      } else if (row.original !== null) {
        const prev = entry.values;
        entry.values = [...row.values];
        this.pushUndo({ op: "restore-insert", table: tableKey, tempId: entry.tempId, prev });
      }
      return;
    }
    if (row.id === null) {
      throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, "Transaction row has no identity.");
    }
    const key = committedRowKey(row.id);
    if (row.deleted) {
      const prev = overlay.updates.get(key);
      if (prev !== undefined) {
        overlay.updates.delete(key);
        this.pushUndo({ op: "set-update", table: tableKey, key, prev });
      }
      if (!overlay.deletes.has(key)) {
        overlay.deletes.add(key);
        this.pushUndo({ op: "remove-delete", table: tableKey, key });
      }
      return;
    }
    if (row.original !== null) {
      this.pushUndo({ op: "set-update", table: tableKey, key, prev: overlay.updates.get(key) });
      overlay.updates.set(key, [...row.values]);
    }
  }
}

/**
 * 커밋된 행에 자기 트랜잭션의 변경을 합친다. (READ COMMITTED)
 * 문장이 시작할 때의 커밋 값에 자기 변경을 얹으므로, 다른 트랜잭션의 미커밋 값은 보이지 않는다.
 */
export function readMergedRows(
  catalog: CatalogStore,
  tablespace: string,
  table: StoredTable,
  txn: Transaction | null,
): OverlayRow[] {
  const types = table.columns.map((column) => column.dataType);
  const committed = catalog.space.heap(table.heapRoot).scan().map((stored) => ({
    id: stored.id,
    values: decodeRow(stored.data, types),
  }));
  const overlay = txn?.overlayFor(tablespace, table.name, null);
  if (overlay === undefined || overlayIsEmpty(overlay)) {
    return committed.map((row) => ({ id: row.id, tempId: null, values: row.values }));
  }
  const rows: OverlayRow[] = [];
  for (const row of committed) {
    const key = committedRowKey(row.id);
    if (overlay.deletes.has(key)) continue;
    rows.push({ id: row.id, tempId: null, values: overlay.updates.get(key) ?? row.values });
  }
  for (const insert of overlay.inserts) {
    rows.push({ id: null, tempId: insert.tempId, values: insert.values });
  }
  return rows;
}

/** PK 값들을 잠금 키에 쓰는 16진 표기로 바꾼다. */
export function pkKeyHex(pkValues: SqlValue[], pkTypes: DataType[]): string {
  const columns: KeyColumn[] = pkTypes.map((type) => ({ type }));
  return encodeKey(pkValues, columns).toString("hex");
}
