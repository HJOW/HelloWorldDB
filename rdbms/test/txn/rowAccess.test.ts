/**
 * 행 단위 읽기 계층 시험 (행 단위 접근 1부, 2026-10-16 사용자 결정).
 * 오버레이의 PK 맵과 되돌리기, `txn/rowAccess.ts` 의 읽기 함수, 힙의 지연 순회, 인덱스를 타는 읽기가
 * 전체 스캔과 같은 결과를 내는지(무작위 시험)를 본다.
 * 관련 사양 : AGENTS.md 상세 10
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogStore, StoredTable } from "../../src/catalog/catalog.js";
import { V1Heap } from "../../src/storage/format/v1/heap.js";
import { Transaction } from "../../src/txn/transaction.js";
import { findVisibleByIndex, findVisibleByPk, mergeIndexEntries, readMergedRows, visibleRowById, visibleRows } from "../../src/txn/rowAccess.js";
import { selectStrings, setupApp } from "../exec/helpers.js";
import { createRandom } from "../types/helpers.js";

/** APP.T (ID INTEGER PRIMARY KEY, GRP INTEGER, NAME VARCHAR(10)) 에 행 N 개를 커밋해 둔다. GRP 에는 보조 인덱스가 있다. */
function setup(t: { after(fn: () => void): void }, rows = 5): { catalog: CatalogStore; table: StoredTable; run: (sql: string) => ReturnType<ReturnType<typeof setupApp>["session"]["execute"]>; session: ReturnType<typeof setupApp>["session"] } {
  const { db, session } = setupApp(t);
  session.execute("CREATE TABLE T (ID INTEGER PRIMARY KEY, GRP INTEGER, NAME VARCHAR(10))");
  session.execute("CREATE INDEX IX_GRP ON T (GRP)");
  for (let id = 1; id <= rows; id++) session.execute(`INSERT INTO T VALUES (${id}, ${id % 3}, 'n${id}')`);
  const catalog = db.manager.requireCatalog("APP");
  return { catalog, table: catalog.data.tables["T"] as StoredTable, run: (sql) => session.execute(sql), session };
}

const ids = (rows: { values: unknown[] }[]): number[] => rows.map((row) => Number(row.values[0])).sort((a, b) => a - b);

test("힙의 지연 순회는 scan 과 같은 행을 같은 순서로 돌려준다", (t) => {
  const { catalog, table } = setup(t, 40);
  const heap = catalog.space.heap(table.heapRoot);
  const scanned = heap.scan();
  const iterated = [...heap.iterate()];
  assert.equal(iterated.length, 40);
  assert.deepEqual(iterated.map((row) => row.id), scanned.map((row) => row.id));
  assert.ok(iterated.every((row, index) => row.data.equals((scanned[index] as { data: Buffer }).data)));
  // 지연 순회이므로 필요한 만큼만 읽고 멈출 수 있다.
  const iterator = heap.iterate();
  assert.equal(iterator.next().done, false);
  assert.equal(iterator.next().done, false);
});

test("커밋된 행만 있을 때 visibleRows 는 힙 순서이고 PK 로 바로 찾는다", (t) => {
  const { catalog, table } = setup(t);
  assert.deepEqual(ids([...visibleRows(catalog, "APP", table, null)]), [1, 2, 3, 4, 5]);
  assert.deepEqual(ids(readMergedRows(catalog, "APP", table, null)), [1, 2, 3, 4, 5]);
  const found = findVisibleByPk(catalog, "APP", table, null, [3n]);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0]?.values.slice(0, 2), [3n, 0n]);
  assert.ok(found[0]?.id !== null);
  assert.deepEqual(findVisibleByPk(catalog, "APP", table, null, [99n]), []);
  assert.deepEqual(visibleRowById(catalog, "APP", table, null, found[0]?.id as never)?.values.slice(0, 1), [3n]);
});

test("오버레이의 넣기, 바꾸기, 지우기가 PK 조회에 바로 보인다", (t) => {
  const { catalog, table } = setup(t);
  const txn = new Transaction(100, true);
  const committed3 = findVisibleByPk(catalog, "APP", table, txn, [3n])[0]!;
  const committed4 = findVisibleByPk(catalog, "APP", table, txn, [4n])[0]!;

  // 새 행
  const tempId = txn.insertRow("APP", table, [10n, 1n, "new"]);
  const inserted = findVisibleByPk(catalog, "APP", table, txn, [10n]);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0]?.tempId, tempId);
  assert.equal(inserted[0]?.id, null);

  // 커밋 행의 PK 를 바꾼다 : 새 PK 로는 보이고 옛 PK 로는 보이지 않는다.
  txn.updateRow("APP", table, { id: committed3.id, tempId: null }, [30n, 0n, "moved"]);
  assert.deepEqual(findVisibleByPk(catalog, "APP", table, txn, [3n]), []);
  const moved = findVisibleByPk(catalog, "APP", table, txn, [30n]);
  assert.equal(moved.length, 1);
  assert.deepEqual(moved[0]?.id, committed3.id);
  assert.equal(moved[0]?.values[2], "moved");

  // 같은 행의 PK 를 또 바꾼다 : 중간 값(30)으로는 더 이상 보이지 않는다. (오버레이 PK 맵이 옛 항목을 지워야 한다)
  txn.updateRow("APP", table, { id: committed3.id, tempId: null }, [31n, 0n, "moved-again"]);
  assert.deepEqual(findVisibleByPk(catalog, "APP", table, txn, [30n]), []);
  assert.equal(findVisibleByPk(catalog, "APP", table, txn, [31n]).length, 1);
  // PK 맵 자체도 정확해야 한다. (읽기 함수가 한 번 더 확인하더라도 낡은 항목이 쌓이면 안 된다)
  const overlay = txn.overlayFor("APP", "T", null)!;
  const hexOf = (id: bigint): string => overlay.pkHexOf([id, 0n, "x"])!;
  assert.equal(overlay.pkRefs(hexOf(30n)).length, 0, "30 은 더 이상 가리키는 행이 없다");
  assert.equal(overlay.pkRefs(hexOf(31n)).length, 1);
  txn.updateRow("APP", table, { id: committed3.id, tempId: null }, [30n, 0n, "moved"]);
  assert.deepEqual(findVisibleByPk(catalog, "APP", table, txn, [31n]), []);
  assert.equal(overlay.pkRefs(hexOf(31n)).length, 0, "31 도 비었다");
  assert.equal(overlay.pkRefs(hexOf(30n)).length, 1);

  // PK 가 같은 채로 값만 바꾼다 : 인덱스 항목과 오버레이 항목이 한 행으로 보인다.
  txn.updateRow("APP", table, { id: committed4.id, tempId: null }, [4n, 2n, "same-pk"]);
  const same = findVisibleByPk(catalog, "APP", table, txn, [4n]);
  assert.equal(same.length, 1);
  assert.equal(same[0]?.values[2], "same-pk");

  // 지운 행은 안 보인다. 지운 행의 PK 로 다시 넣으면 새 행이 보인다.
  txn.deleteRow("APP", table, { id: findVisibleByPk(catalog, "APP", table, txn, [5n])[0]!.id, tempId: null });
  assert.deepEqual(findVisibleByPk(catalog, "APP", table, txn, [5n]), []);
  txn.insertRow("APP", table, [5n, 9n, "again"]);
  const again = findVisibleByPk(catalog, "APP", table, txn, [5n]);
  assert.equal(again.length, 1);
  assert.equal(again[0]?.values[2], "again");

  // 이 트랜잭션이 넣은 행을 바꾸고 지운다.
  txn.updateRow("APP", table, { id: null, tempId }, [11n, 1n, "renamed"]);
  assert.equal(overlay.pkRefs(hexOf(10n)).length, 0, "넣은 행의 PK 를 바꾸면 옛 항목이 사라진다");
  assert.deepEqual(findVisibleByPk(catalog, "APP", table, txn, [10n]), []);
  assert.equal(findVisibleByPk(catalog, "APP", table, txn, [11n]).length, 1);
  txn.deleteRow("APP", table, { id: null, tempId });
  assert.deepEqual(findVisibleByPk(catalog, "APP", table, txn, [11n]), []);

  // 전체 순회와 PK 조회가 같은 상태를 본다.
  const all = ids([...visibleRows(catalog, "APP", table, txn)]);
  assert.deepEqual(all, [1, 2, 4, 5, 30]);
  for (const id of [1, 2, 4, 5, 30]) assert.equal(findVisibleByPk(catalog, "APP", table, txn, [BigInt(id)]).length, 1, `id ${id}`);
});

test("문장 표시까지 되돌리면 PK 맵과 읽기가 원래대로 돌아간다", (t) => {
  const { catalog, table } = setup(t);
  const txn = new Transaction(101, true);
  const row2 = findVisibleByPk(catalog, "APP", table, txn, [2n])[0]!;
  txn.insertRow("APP", table, [20n, 1n, "kept"]);
  const mark = txn.mark();
  const tempId = txn.insertRow("APP", table, [21n, 1n, "undone"]);
  txn.updateRow("APP", table, { id: row2.id, tempId: null }, [22n, 0n, "undone-move"]);
  txn.deleteRow("APP", table, { id: findVisibleByPk(catalog, "APP", table, txn, [1n])[0]!.id, tempId: null });
  txn.updateRow("APP", table, { id: null, tempId }, [23n, 1n, "undone-2"]);
  txn.truncateTo(mark);
  assert.deepEqual(ids([...visibleRows(catalog, "APP", table, txn)]), [1, 2, 3, 4, 5, 20]);
  assert.equal(findVisibleByPk(catalog, "APP", table, txn, [20n]).length, 1);
  assert.equal(findVisibleByPk(catalog, "APP", table, txn, [2n]).length, 1, "옛 PK 가 다시 보인다");
  assert.deepEqual(findVisibleByPk(catalog, "APP", table, txn, [22n]), []);
  assert.deepEqual(findVisibleByPk(catalog, "APP", table, txn, [21n]), []);
  assert.deepEqual(findVisibleByPk(catalog, "APP", table, txn, [23n]), []);
  assert.equal(findVisibleByPk(catalog, "APP", table, txn, [1n]).length, 1, "지웠던 행이 돌아온다");
  // 세이브포인트도 같은 방식이다.
  txn.savepoint("S1");
  txn.insertRow("APP", table, [24n, 0n, "sp"]);
  txn.rollbackTo("S1");
  assert.deepEqual(findVisibleByPk(catalog, "APP", table, txn, [24n]), []);
});

test("자기가 넣은 행을 지웠다가 되돌려도 넣은 순서가 유지된다", (t) => {
  const { catalog, table } = setup(t, 2);
  const txn = new Transaction(102, true);
  const a = txn.insertRow("APP", table, [10n, 0n, "a"]);
  txn.insertRow("APP", table, [11n, 0n, "b"]);
  txn.insertRow("APP", table, [12n, 0n, "c"]);
  const mark = txn.mark();
  txn.deleteRow("APP", table, { id: null, tempId: a });
  assert.deepEqual(ids([...visibleRows(catalog, "APP", table, txn)]), [1, 2, 11, 12]);
  txn.truncateTo(mark);
  const order = [...visibleRows(catalog, "APP", table, txn)].map((row) => Number(row.values[0]));
  assert.deepEqual(order, [1, 2, 10, 11, 12], "삭제를 되돌리면 원래 자리로 돌아간다");
});

test("PK 가 없는 테이블의 오버레이도 동작한다", (t) => {
  const { db, session } = setupApp(t);
  session.execute("CREATE TABLE NOPK (A INTEGER, B VARCHAR(5))");
  session.execute("INSERT INTO NOPK VALUES (1, 'x')");
  const catalog = db.manager.requireCatalog("APP");
  const table = catalog.data.tables["NOPK"] as StoredTable;
  const txn = new Transaction(103, true);
  txn.insertRow("APP", table, [2n, "y"]);
  assert.equal(txn.overlayFor("APP", "NOPK", null)?.hasPk, false);
  assert.deepEqual([...visibleRows(catalog, "APP", table, txn)].map((row) => Number(row.values[0])), [1, 2]);
  assert.throws(() => findVisibleByPk(catalog, "APP", table, txn, [1n]), /no primary key/);
});

test("인덱스로 얻은 후보에는 바뀐 행과 넣은 행이 덧붙고 지운 행은 빠진다", (t) => {
  const { catalog, table } = setup(t, 9);
  const txn = new Transaction(104, true);
  const ixRoot = Object.values(catalog.data.indexes).find((index) => index.name === "IX_GRP")!.indexRoot;
  // GRP = 0 인 커밋 행 : 3, 6, 9
  const row6 = findVisibleByPk(catalog, "APP", table, txn, [6n])[0]!;
  const row9 = findVisibleByPk(catalog, "APP", table, txn, [9n])[0]!;
  txn.deleteRow("APP", table, { id: row6.id, tempId: null });
  txn.updateRow("APP", table, { id: row9.id, tempId: null }, [9n, 2n, "regrouped"]);
  txn.insertRow("APP", table, [40n, 0n, "ins"]);
  const matches = findVisibleByIndex(catalog, "APP", table, txn, { root: ixRoot, columns: [{ name: "GRP", descending: false }] }, [0n]);
  // 실제로 GRP = 0 인 행만 돌려준다 : 3 (커밋), 40 (넣음). 6 은 지웠고 9 는 GRP 가 바뀌었다.
  assert.deepEqual(ids(matches), [3, 40]);
  const group2 = findVisibleByIndex(catalog, "APP", table, txn, { root: ixRoot, columns: [{ name: "GRP", descending: false }] }, [2n]);
  assert.deepEqual(ids(group2), [2, 5, 8, 9], "바뀐 값으로 새로 들어온 행 9 가 보인다");
  // 후보 함수는 상위 집합이다. 인덱스에서 얻은 행이 하나도 없어도 오버레이의 변경 행과 넣은 행은 모두 후보이고, 지운 행은 없다.
  const candidates = mergeIndexEntries(catalog, "APP", table, txn, []);
  assert.ok(candidates.some((row) => row.values[2] === "regrouped"));
  assert.ok(candidates.some((row) => row.values[2] === "ins"));
  assert.ok(!candidates.some((row) => Number(row.values[0]) === 6));
  assert.deepEqual(findVisibleByIndex(catalog, "APP", table, txn, { root: ixRoot, columns: [{ name: "GRP", descending: false }] }, [null as never]), []);
});

// ---------------------------------------------------------------------------
// SQL 수준 : 인덱스를 타는 읽기는 전체 스캔과 같은 결과여야 한다
// ---------------------------------------------------------------------------

/** `ID + 0` 은 인덱스 조건이 아니라서 전체 스캔이 된다. 인덱스를 타는 같은 질의와 결과를 견주는 기준으로 쓴다. */
function sameResult(session: ReturnType<typeof setup>["session"], indexed: string, scanned: string, label: string): void {
  const left = selectStrings(session.execute(indexed)).rows.map((row) => row.join("|")).sort();
  const right = selectStrings(session.execute(scanned)).rows.map((row) => row.join("|")).sort();
  assert.deepEqual(left, right, label);
}

test("트랜잭션 안에서 인덱스를 탄 조회는 전체 스캔과 같은 결과이다 (무작위 변경, 시드 40개)", (t) => {
  const { session } = setup(t, 30);
  for (let seed = 1; seed <= 40; seed++) {
    const random = createRandom(seed * 17);
    session.execute("BEGIN");
    let nextId = 100 * seed;
    for (let step = 0; step < 25; step++) {
      const roll = random();
      const id = 1 + Math.floor(random() * 30);
      if (roll < 0.25) {
        nextId++;
        session.execute(`INSERT INTO T VALUES (${nextId}, ${Math.floor(random() * 4)}, 'i${nextId}')`);
      } else if (roll < 0.5) {
        session.execute(`UPDATE T SET GRP = ${Math.floor(random() * 4)}, NAME = 'u${step}' WHERE ID = ${id}`);
      } else if (roll < 0.6) {
        // PK 를 바꾼다. (겹치지 않는 새 값으로)
        nextId++;
        session.execute(`UPDATE T SET ID = ${nextId} WHERE ID = ${id}`);
      } else if (roll < 0.8) {
        session.execute(`DELETE FROM T WHERE ID = ${id}`);
      } else if (roll < 0.9) {
        session.execute(`SAVEPOINT S${step}`);
        session.execute(`DELETE FROM T WHERE GRP = ${Math.floor(random() * 4)}`);
        session.execute(`ROLLBACK TO S${step}`);
      } else {
        session.execute(`UPDATE T SET NAME = 'g' WHERE GRP = ${Math.floor(random() * 4)}`);
      }
      const probe = 1 + Math.floor(random() * 30);
      const group = Math.floor(random() * 4);
      sameResult(session, `SELECT * FROM T WHERE ID = ${probe}`, `SELECT * FROM T WHERE ID + 0 = ${probe}`, `seed ${seed} step ${step}: by PK`);
      sameResult(session, `SELECT * FROM T WHERE GRP = ${group}`, `SELECT * FROM T WHERE GRP + 0 = ${group}`, `seed ${seed} step ${step}: by index`);
      sameResult(
        session,
        `SELECT * FROM T WHERE ID >= ${probe} AND ID < ${probe + 7}`,
        `SELECT * FROM T WHERE ID + 0 >= ${probe} AND ID + 0 < ${probe + 7}`,
        `seed ${seed} step ${step}: range`,
      );
    }
    session.execute("ROLLBACK");
    // 롤백하면 처음 상태로 돌아간다.
    assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM T")).rows, [["30"]], `seed ${seed}: rollback`);
  }
});

test("DML 의 대상 찾기도 인덱스를 타고 자기 변경을 본다", (t) => {
  const { session } = setup(t, 10);
  session.execute("BEGIN");
  session.execute("UPDATE T SET NAME = 'a' WHERE ID = 3");
  session.execute("DELETE FROM T WHERE ID = 4");
  session.execute("INSERT INTO T VALUES (50, 1, 'x')");
  // 바꾼 행, 지운 행, 넣은 행을 PK 로 다시 대상으로 삼는다.
  assert.equal(session.execute("UPDATE T SET NAME = 'b' WHERE ID = 3").kind === "ok" ? 1 : 0, 1);
  assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM T WHERE ID = 3")).rows, [["b"]]);
  const none = session.execute("DELETE FROM T WHERE ID = 4");
  assert.equal(none.kind === "ok" ? none.rowCount : -1, 0, "지운 행은 대상이 아니다");
  const own = session.execute("UPDATE T SET NAME = 'y' WHERE ID = 50");
  assert.equal(own.kind === "ok" ? own.rowCount : -1, 1, "이 트랜잭션이 넣은 행도 대상이다");
  const byGroup = session.execute("DELETE FROM T WHERE GRP = 1");
  assert.equal(byGroup.kind === "ok" ? byGroup.rowCount : -1, 4, "GRP = 1 : 1, 7, 10 과 새 행 50");
  session.execute("COMMIT");
  assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM T")).rows, [["6"]]);
});

test("PK 조회는 행이 많아도 힙을 훑지 않고, 자기가 쓴 뒤에도 같다", (t) => {
  const { session } = setup(t, 600);
  const original = V1Heap.prototype.iterate;
  let iterations = 0;
  V1Heap.prototype.iterate = function (this: V1Heap) {
    iterations++;
    return original.call(this);
  };
  t.after(() => {
    V1Heap.prototype.iterate = original;
  });
  // 커밋만 있는 상태
  assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM T WHERE ID = 321")).rows, [["n321"]]);
  assert.equal(iterations, 0, "PK 로 찾으면 힙 순회가 없다");
  // 트랜잭션이 테이블을 건드린 뒤에도 인덱스를 탄다. (이전에는 건드린 테이블을 전체 스캔했다)
  session.execute("BEGIN");
  session.execute("INSERT INTO T VALUES (9001, 1, 'mine')");
  iterations = 0;
  assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM T WHERE ID = 9001")).rows, [["mine"]]);
  assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM T WHERE ID = 77")).rows, [["n77"]]);
  assert.equal(iterations, 0, "자기 변경이 있어도 PK 조회는 힙을 훑지 않는다");
  // 인덱스가 없는 조건은 전체 순회이다.
  assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM T WHERE NAME = 'n5'")).rows, [["1"]]);
  assert.ok(iterations > 0);
  session.execute("ROLLBACK");
});

test("인덱스가 없는 DML 대상 찾기는 힙을 지연 순회하고 결과는 같다", (t) => {
  const { session } = setup(t, 50);
  const updated = session.execute("UPDATE T SET NAME = 'z' WHERE NAME = 'n7'");
  assert.equal(updated.kind === "ok" ? updated.rowCount : -1, 1);
  const deleted = session.execute("DELETE FROM T WHERE NAME LIKE 'n4%'");
  assert.equal(deleted.kind === "ok" ? deleted.rowCount : -1, 11, "n4, n40 ~ n49");
  assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM T")).rows, [["39"]]);
  assert.deepEqual(selectStrings(session.execute("SELECT ID FROM T WHERE NAME = 'z'")).rows, [["7"]]);
});
