/**
 * 담당 : 타입 코덱이 만든 바이트열을 실제 저장 엔진(힙, B+Tree)에 넣어 재열기 후에도
 *        값과 정렬 순서가 유지되는지 확인한다.
 * 관련 사양 : AGENTS.md 상세 1-1, 3, 10. docs/storage-v1.md.
 * 구현 단계 : 3단계.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createTablespace, openTablespace } from "../../src/storage/format/format.js";
import type { RowId } from "../../src/storage/format/format.js";
import { decodeRow, encodeKey, encodeRow, prefixUpperBound } from "../../src/types/codec.js";
import type { KeyColumn } from "../../src/types/codec.js";
import type { DataType } from "../../src/types/dataType.js";
import { formatValue } from "../../src/types/value.js";
import type { NonNullValue, SqlValue } from "../../src/types/value.js";
import { assertSqlState, type, value } from "./helpers.js";

const COLUMNS = ["INTEGER", "VARCHAR(20)", "DECIMAL(10,3)", "TIMESTAMP(6) WITH TIME ZONE", "CHAR(6)"];
const TYPES: DataType[] = COLUMNS.map(type);
const PRIMARY_KEY: KeyColumn[] = [{ type: TYPES[0] as DataType }];
/** (NAME ASC, AMOUNT DESC) */
const SECONDARY: KeyColumn[] = [{ type: TYPES[1] as DataType }, { type: TYPES[2] as DataType, descending: true }];

const ROWS: (string | null)[][] = [
  ["3", "kim", "10.500", "2026-10-09 09:00:00+09:00", "A"],
  ["1", "lee", "-3.250", "2026-10-09 00:00:00+00:00", "B"],
  ["7", "kim", "99.999", "2026-01-01 12:00:00-05:00", null],
  ["2", null, "0", "1970-01-01 00:00:00+00:00", "한글"],
  ["5", "kim", null, "9999-12-31 23:59:59.999999+14:00", ""],
  ["4", "김", "1234567.891", "0001-01-01 00:00:00-12:00", "C"],
  ["6", "", "10.500", null, "D"],
];

function toValues(row: (string | null)[]): SqlValue[] {
  return row.map((text, index) => value(text, COLUMNS[index] as string));
}

function toText(values: SqlValue[]): (string | null)[] {
  return values.map((item, index) => (item === null ? null : formatValue(item as NonNullValue, TYPES[index] as DataType)));
}

test("코덱으로 만든 행과 키를 저장 엔진에 넣고 재열기 후 인덱스 순서로 읽는다", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hwdb-codec-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "APP.hwdb");

  let heapRoot = 0;
  let primaryRoot = 0;
  let secondaryRoot = 0;
  const created = createTablespace(filePath, { name: "APP" });
  try {
    const batch = created.begin();
    heapRoot = batch.createHeap();
    primaryRoot = batch.createIndex({ unique: true });
    secondaryRoot = batch.createIndex();
    for (const row of ROWS) {
      const values = toValues(row);
      const rowId = batch.heap(heapRoot).insert(encodeRow(values, TYPES));
      batch.index(primaryRoot).insert(encodeKey([values[0] as SqlValue], PRIMARY_KEY), rowId);
      batch.index(secondaryRoot).insert(encodeKey([values[1] as SqlValue, values[2] as SqlValue], SECONDARY), rowId);
    }
    // PK 중복은 저장 엔진의 유일 인덱스가 잡는다.
    assertSqlState(
      () => batch.index(primaryRoot).insert(encodeKey([3n], PRIMARY_KEY), { pageId: 1, slotId: 0 }),
      "23505",
    );
    batch.commit();
  } finally {
    created.close();
  }

  const space = openTablespace(filePath);
  try {
    const read = (rowId: RowId): (string | null)[] => {
      const data = space.heap(heapRoot).get(rowId);
      assert.ok(data !== null);
      return toText(decodeRow(data, TYPES));
    };

    // PK 순서 : 정수의 순서대로
    const byPrimary = space.index(primaryRoot).range().map((entry) => read(entry.rowId));
    assert.deepEqual(byPrimary.map((row) => row[0]), ["1", "2", "3", "4", "5", "6", "7"]);
    // 읽은 값은 넣은 값과 같다. CHAR 는 채움 공백이 붙는다.
    assert.deepEqual(byPrimary[2], ["3", "kim", "10.500", "2026-10-09 09:00:00.000000+09:00", "A     "]);
    assert.deepEqual(byPrimary[1], ["2", null, "0.000", "1970-01-01 00:00:00.000000+00:00", "한글    "]);
    assert.deepEqual(byPrimary[4], ["5", "kim", null, "9999-12-31 23:59:59.999999+14:00", "      "]);
    assert.deepEqual(byPrimary[5], ["6", "", "10.500", null, "D     "]);

    // (NAME ASC, AMOUNT DESC) : NAME 은 코드 포인트 순이고 NULL 이 마지막, AMOUNT 는 NULL 이 처음이고 큰 값부터
    const bySecondary = space.index(secondaryRoot).range().map((entry) => read(entry.rowId));
    assert.deepEqual(bySecondary.map((row) => [row[1], row[2]]), [
      ["", "10.500"],
      ["kim", null],
      ["kim", "99.999"],
      ["kim", "10.500"],
      ["lee", "-3.250"],
      ["김", "1234567.891"],
      [null, "0.000"],
    ]);

    // PK 단건 조회
    const found = space.index(primaryRoot).find(encodeKey([4n], PRIMARY_KEY));
    assert.equal(found.length, 1);
    assert.equal(read(found[0] as RowId)[1], "김");
    assert.equal(space.index(primaryRoot).find(encodeKey([8n], PRIMARY_KEY)).length, 0);

    // PK 범위 : 2 < ID <= 5
    const ranged = space.index(primaryRoot).range({
      lower: encodeKey([2n], PRIMARY_KEY),
      lowerInclusive: false,
      upper: encodeKey([5n], PRIMARY_KEY),
      upperInclusive: true,
    });
    assert.deepEqual(ranged.map((entry) => read(entry.rowId)[0]), ["3", "4", "5"]);

    // 복합 인덱스의 앞쪽 컬럼 동등 조건 : NAME = 'kim'
    const prefix = encodeKey(["kim"], SECONDARY);
    const upper = prefixUpperBound(prefix);
    assert.ok(upper !== null);
    const kims = space.index(secondaryRoot).range({ lower: prefix, upper, upperInclusive: false });
    assert.deepEqual(kims.map((entry) => read(entry.rowId)[0]), ["5", "7", "3"]);

    // 앞쪽 컬럼 동등 + 다음 컬럼 범위 : NAME = 'kim' AND AMOUNT > 10.5 (DESC 이므로 상한이 된다)
    const above = space.index(secondaryRoot).range({
      lower: encodeKey(["kim", value("999999.999", "DECIMAL(10,3)")], SECONDARY),
      upper: encodeKey(["kim", value("10.5", "DECIMAL(10,3)")], SECONDARY),
      upperInclusive: false,
    });
    assert.deepEqual(above.map((entry) => read(entry.rowId)[0]), ["7"]);
  } finally {
    space.close();
  }
});
