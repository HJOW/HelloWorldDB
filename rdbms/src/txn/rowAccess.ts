/**
 * 행 읽기 (자기 트랜잭션의 변경을 합친 값).
 *
 * 담당
 *  - READ COMMITTED : 커밋된 행에 자기 트랜잭션의 변경(txn/transaction.ts 의 오버레이)을 덮어 보여 준다.
 *    다른 트랜잭션의 미커밋 값은 저장소에 없으므로 보이지 않는다.
 *  - 행 단위 접근 : 테이블 전체를 읽지 않고 필요한 행만 읽는 함수들.
 *      `visibleRowById`      행 식별자로 한 행
 *      `findVisibleByPk`     PK 값으로 행. PK 인덱스 한 번 + 오버레이의 PK 맵. 행 수와 무관하다.
 *      `findVisibleByIndex`  인덱스의 앞쪽 컬럼 값으로 행들. 인덱스 범위 탐색 + 오버레이.
 *      `mergeIndexEntries`   인덱스 탐색으로 얻은 행 식별자들에 오버레이를 합친 후보 행들
 *      `visibleRows`         전체 순회. 힙을 페이지 순서대로 하나씩 읽는 지연 순회이다.
 *  - 인덱스로 얻은 후보에는 오버레이의 바뀐 행과 넣은 행이 모두 덧붙는다. (바뀐 값이 조건에 새로 들어맞을 수 있으므로)
 *    그래서 후보는 조건의 상위 집합이며, 호출자가 조건을 다시 건다.
 *
 * 이 모듈은 읽기만 한다. 변경은 txn/transaction.ts 가 오버레이에 쓰고 exec/dml.ts 가 커밋 때 저장소에 쓴다.
 *
 * 관련 사양 : AGENTS.md 상세 10
 * 구현 단계 : 7단계(전체 읽기), 행 단위 접근(2026-10-16 사용자 결정)
 */

import type { RowId } from "../storage/format/format.js";
import type { CatalogStore, StoredTable } from "../catalog/catalog.js";
import { decodeRow, encodeKey, prefixUpperBound } from "../types/codec.js";
import type { KeyColumn } from "../types/codec.js";
import type { SqlValue } from "../types/value.js";
import { committedRowKey, parseCommittedRowKey, pkKeyHex } from "./transaction.js";
import type { OverlayRow, Transaction } from "./transaction.js";

function columnTypes(table: StoredTable): import("../types/dataType.js").DataType[] {
  return table.columns.map((column) => column.dataType);
}

/**
 * 테이블의 모든 행을 지연 순회한다. 커밋된 행(바뀐 값 반영, 지운 행 제외)을 힙 순서로, 이어서 이 트랜잭션이 넣은 행을 넣은 순서로 돌려준다.
 * 순회하는 동안 호출자가 오버레이를 바꾸면 안 된다.
 */
export function* visibleRows(
  catalog: CatalogStore,
  tablespace: string,
  table: StoredTable,
  txn: Transaction | null,
): IterableIterator<OverlayRow> {
  const types = columnTypes(table);
  const overlay = txn?.overlayFor(tablespace, table.name, null);
  const live = overlay !== undefined && !overlay.isEmpty;
  for (const stored of catalog.space.heap(table.heapRoot).iterate()) {
    if (!live) {
      yield { id: stored.id, tempId: null, values: decodeRow(stored.data, types) };
      continue;
    }
    const key = committedRowKey(stored.id);
    if (overlay.isDeleted(key)) continue;
    yield { id: stored.id, tempId: null, values: overlay.getUpdate(key) ?? decodeRow(stored.data, types) };
  }
  if (live) {
    for (const insert of overlay.insertedRows()) {
      yield { id: null, tempId: insert.tempId, values: insert.values };
    }
  }
}

/** 테이블의 모든 행을 배열로 읽는다. 행이 많으면 `visibleRows` 를 쓴다. */
export function readMergedRows(
  catalog: CatalogStore,
  tablespace: string,
  table: StoredTable,
  txn: Transaction | null,
): OverlayRow[] {
  return [...visibleRows(catalog, tablespace, table, txn)];
}

/** 커밋된 행 하나를 행 식별자로 읽는다. 자기 변경을 합친다. 지워졌거나 없으면 null 이다. */
export function visibleRowById(
  catalog: CatalogStore,
  tablespace: string,
  table: StoredTable,
  txn: Transaction | null,
  id: RowId,
): OverlayRow | null {
  const overlay = txn?.overlayFor(tablespace, table.name, null);
  const key = committedRowKey(id);
  if (overlay?.isDeleted(key) === true) return null;
  const updated = overlay?.getUpdate(key);
  if (updated !== undefined) return { id, tempId: null, values: updated };
  const data = catalog.space.heap(table.heapRoot).get(id);
  if (data === null) return null;
  return { id, tempId: null, values: decodeRow(data, columnTypes(table)) };
}

/**
 * 인덱스 탐색으로 얻은 커밋 행 식별자들에 자기 트랜잭션의 변경을 합쳐 후보 행들을 돌려준다.
 * 지운 행은 빼고 바뀐 행은 새 값으로 바꾼다. 인덱스 범위에 들지 않는 오버레이의 바뀐 행과 넣은 행도 모두 덧붙인다.
 * (바뀐 값이 조건에 들어맞을 수 있다) 따라서 결과는 조건의 상위 집합이고 호출자가 조건을 다시 걸어야 한다.
 */
export function mergeIndexEntries(
  catalog: CatalogStore,
  tablespace: string,
  table: StoredTable,
  txn: Transaction | null,
  rowIds: readonly RowId[],
): OverlayRow[] {
  const types = columnTypes(table);
  const overlay = txn?.overlayFor(tablespace, table.name, null);
  const live = overlay !== undefined && !overlay.isEmpty;
  const heap = catalog.space.heap(table.heapRoot);
  const out: OverlayRow[] = [];
  const seen = new Set<string>();
  for (const id of rowIds) {
    const key = committedRowKey(id);
    if (live) {
      if (overlay.isDeleted(key)) continue;
      const updated = overlay.getUpdate(key);
      if (updated !== undefined) {
        out.push({ id, tempId: null, values: updated });
        seen.add(key);
        continue;
      }
    }
    const data = heap.get(id);
    if (data === null) continue;
    out.push({ id, tempId: null, values: decodeRow(data, types) });
  }
  if (live) {
    for (const [key, values] of overlay.updatedRows()) {
      if (!seen.has(key)) out.push({ id: parseCommittedRowKey(key), tempId: null, values });
    }
    for (const insert of overlay.insertedRows()) {
      out.push({ id: null, tempId: insert.tempId, values: insert.values });
    }
  }
  return out;
}

/**
 * PK 값으로 행을 찾는다. (자기 변경을 합친 값) 보통 0 개나 1 개이며, 한 문장이 PK 를 겹치게 만들었으면 둘 이상일 수 있다.
 * PK 인덱스를 한 번 찾고 오버레이의 PK 맵을 한 번 본다. 행 수와 무관하다.
 * PK 가 없는 테이블에는 쓸 수 없다.
 */
export function findVisibleByPk(
  catalog: CatalogStore,
  tablespace: string,
  table: StoredTable,
  txn: Transaction | null,
  pkValues: SqlValue[],
): OverlayRow[] {
  if (table.pkName === null || table.pkIndexRoot === null) {
    throw new Error(`Table "${table.name}" has no primary key.`);
  }
  const types = columnTypes(table);
  const pkTypes = table.pkColumns.map((name) => (table.columns.find((column) => column.name === name) as StoredTable["columns"][number]).dataType);
  const keyColumns: KeyColumn[] = pkTypes.map((type) => ({ type }));
  const overlay = txn?.overlayFor(tablespace, table.name, null);
  const live = overlay !== undefined && !overlay.isEmpty;
  const hex = pkKeyHex(pkValues, pkTypes);
  const hits: OverlayRow[] = [];
  const seen = new Set<string>();
  for (const id of catalog.space.index(table.pkIndexRoot).find(encodeKey(pkValues, keyColumns))) {
    const key = committedRowKey(id);
    if (live) {
      if (overlay.isDeleted(key)) continue;
      const updated = overlay.getUpdate(key);
      if (updated !== undefined) {
        // PK 가 바뀌었으면 이 값으로는 더 이상 보이지 않는다.
        if (overlay.pkHexOf(updated) === hex) {
          hits.push({ id, tempId: null, values: updated });
          seen.add(key);
        }
        continue;
      }
    }
    const data = catalog.space.heap(table.heapRoot).get(id);
    if (data === null) continue;
    hits.push({ id, tempId: null, values: decodeRow(data, types) });
    seen.add(key);
  }
  if (live) {
    for (const ref of overlay.pkRefs(hex)) {
      if (ref.kind === "insert") {
        const values = overlay.getInsert(ref.tempId);
        if (values !== undefined && overlay.pkHexOf(values) === hex) hits.push({ id: null, tempId: ref.tempId, values });
      } else if (!seen.has(ref.rowKey)) {
        const values = overlay.getUpdate(ref.rowKey);
        // 맵의 항목이 지금 값과 맞는지 한 번 더 확인한다. (맵은 변경 때마다 고치지만 어긋나도 잘못된 행을 돌려주지 않게 한다)
        if (values !== undefined && overlay.pkHexOf(values) === hex) {
          hits.push({ id: parseCommittedRowKey(ref.rowKey), tempId: null, values });
        }
      }
    }
  }
  return hits;
}

/** 인덱스 정의에서 읽기에 필요한 부분이다. */
export interface IndexSpec {
  root: number;
  columns: { name: string; descending: boolean }[];
}

/**
 * 인덱스의 앞쪽 컬럼 값이 모두 같은 행들을 찾는다. (자기 변경을 합친 값) `values` 는 인덱스의 앞쪽 컬럼 `values.length` 개의 값이다.
 * 인덱스 범위 탐색 한 번과 오버레이의 변경 행을 보며, 돌려주는 행은 실제로 값이 같은 것만이다.
 * 값에 NULL 이 있으면 어떤 행과도 같지 않으므로(SQL 의 동등 비교) 빈 결과이다.
 */
export function findVisibleByIndex(
  catalog: CatalogStore,
  tablespace: string,
  table: StoredTable,
  txn: Transaction | null,
  index: IndexSpec,
  values: SqlValue[],
): OverlayRow[] {
  if (values.length === 0 || values.length > index.columns.length) {
    throw new Error("Index prefix length is out of range.");
  }
  if (values.some((value) => value === null)) return [];
  const keyColumns: KeyColumn[] = index.columns.slice(0, values.length).map((column) => {
    const definition = table.columns.find((entry) => entry.name === column.name) as StoredTable["columns"][number];
    return { type: definition.dataType, descending: column.descending };
  });
  const prefix = encodeKey(values, keyColumns);
  const upper = prefixUpperBound(prefix);
  const entries = catalog.space.index(index.root).range(
    upper === null ? { lower: prefix, lowerInclusive: true } : { lower: prefix, lowerInclusive: true, upper, upperInclusive: false },
  );
  const positions = index.columns.slice(0, values.length).map((column) => table.columns.findIndex((entry) => entry.name === column.name));
  const candidates = mergeIndexEntries(catalog, tablespace, table, txn, entries.map((entry) => entry.rowId));
  return candidates.filter((row) => {
    const key = encodeKey(
      positions.map((position) => (row.values[position] ?? null) as SqlValue),
      keyColumns,
    );
    return key.equals(prefix);
  });
}
