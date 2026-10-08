/**
 * 담당 : 저장 배치의 격리, 재열기, 힙/오버플로, B+Tree와 파일 손상 검증.
 * 관련 사양 : AGENTS.md 상세 2, 3, 10, 12. docs/storage-v1.md.
 * 구현 단계 : 2단계.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createTablespace, openTablespace } from "../../src/storage/format/format.js";
import type { RowId } from "../../src/storage/format/format.js";
import { DbError } from "../../src/common/errors.js";
import { checksum, END, seal } from "../../src/storage/format/v1/pages.js";
import { PageFile, PAGE_SIZE } from "../../src/storage/pageFile.js";
import { BufferCache } from "../../src/storage/bufferCache.js";

function temp(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hwdb-storage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "TEST.hwdb");
}
function state(sqlState: string): (error: unknown) => boolean {
  return (error) => error instanceof DbError && error.sqlState === sqlState;
}
function key(number: number, length = 4): Buffer {
  const result = Buffer.alloc(length); result.writeUInt32BE(number); return result;
}
function shuffle<T>(items: T[]): T[] {
  let seed = 0x12345678;
  for (let i = items.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

test("CRC-32는 표준 확인값과 일치한다", () => {
  assert.equal(checksum(Buffer.from("123456789")), 0xcbf43926);
});

test("페이지 파일은 부분 페이지와 범위 밖 접근을 거부한다", (t) => {
  const filePath = temp(t);
  const file = PageFile.create(filePath);
  try {
    assert.throws(() => file.writePage(0, Buffer.alloc(1)), state("22023"));
    assert.throws(() => file.writePage(1, Buffer.alloc(PAGE_SIZE)), state("22023"));
    file.writePage(0, Buffer.alloc(PAGE_SIZE, 7));
    assert.equal(file.readPage(0)[0], 7);
    assert.throws(() => file.readPage(1), state("XX001"));
    file.sync();
  } finally { file.close(); }
  fs.appendFileSync(filePath, Buffer.from([1]));
  const partial = PageFile.open(filePath);
  try { assert.throws(() => partial.pageCount, state("XX001")); }
  finally { partial.close(); }
});

test("LRU 퇴거와 롤백은 미커밋 페이지를 파일에 쓰지 않는다", (t) => {
  const filePath = temp(t);
  const file = PageFile.create(filePath);
  file.writePage(0, Buffer.alloc(PAGE_SIZE, 1));
  file.writePage(1, Buffer.alloc(PAGE_SIZE, 2));
  file.sync();
  const cache = new BufferCache(file, 1);
  try {
    const batch = cache.begin();
    const page = batch.read(0); page[0] = 9; batch.write(0, page);
    cache.read(1); cache.read(0);
    assert.equal(batch.read(0)[0], 9);
    assert.equal(cache.read(0)[0], 1);
    assert.equal(fs.readFileSync(filePath)[0], 1);
    batch.rollback();
    const copy = cache.read(0); copy[0] = 99;
    assert.equal(cache.read(0)[0], 1);
  } finally { cache.close(); }
});

test("fsync 실패 뒤에는 배치를 공개하지 않고 저장소를 사용 불가로 둔다", (t) => {
  const filePath = temp(t), file = PageFile.create(filePath);
  file.writePage(0, Buffer.alloc(PAGE_SIZE)); file.sync();
  const cache = new BufferCache(file);
  const batch = cache.begin(); batch.write(0, Buffer.alloc(PAGE_SIZE, 4));
  t.mock.method(file, "sync", () => { throw new DbError("58030", 1000, "Injected fsync failure."); });
  assert.throws(() => batch.commit(), state("58030"));
  assert.throws(() => cache.read(0), state("58030"));
  cache.close();
});

test("헤더, 카탈로그, 힙 행과 큰 행은 재열기 후 유지된다", (t) => {
  const filePath = temp(t);
  let space = createTablespace(filePath, { name: "테스트😀", createdAt: 1234, cachePages: 2 });
  const batch = space.begin(), root = batch.createHeap(), heap = batch.heap(root);
  const empty = heap.insert(Buffer.alloc(0));
  const hello = heap.insert(Buffer.from("Hello World 한글😀"));
  const large = Buffer.alloc(40000, 31), largeId = heap.insert(large);
  const catalog = Buffer.from("카탈로그".repeat(2000)); batch.setCatalog(catalog);
  assert.deepEqual(heap.get(empty), Buffer.alloc(0));
  batch.commit();
  space.close();
  const bytes = fs.readFileSync(filePath);
  assert.equal(bytes[624], 1);
  const warnings: string[] = [];
  space = openTablespace(filePath, { cachePages: 1, onWarning: (message) => warnings.push(message) });
  try {
    assert.equal(warnings.length, 0);
    assert.equal(space.header.cleanShutdown, false);
    assert.equal(space.header.name, "테스트😀"); assert.equal(space.header.createdAt, 1234);
    assert.deepEqual(space.getCatalog(), catalog);
    assert.deepEqual(space.heap(root).get(hello), Buffer.from("Hello World 한글😀"));
    assert.deepEqual(space.heap(root).get(largeId), large);
    assert.equal(space.heap(root).scan().length, 3);
  } finally { space.close(); }
});

test("힙 갱신은 행 식별자를 유지하고 슬롯과 오버플로 페이지를 재사용한다", (t) => {
  const filePath = temp(t), space = createTablespace(filePath, { name: "TEST" });
  try {
    let batch = space.begin(); const root = batch.createHeap(); let heap = batch.heap(root);
    const first = heap.insert(Buffer.alloc(8000, 1));
    const second = heap.insert(Buffer.alloc(8000, 2));
    const huge = heap.insert(Buffer.alloc(50000, 3)); batch.commit();
    const size = space.header.pageCount;
    batch = space.begin(); heap = batch.heap(root);
    assert.equal(heap.update(first, Buffer.alloc(32000, 4)), true);
    assert.equal(heap.delete(huge), true);
    assert.equal(heap.delete(huge), false);
    assert.deepEqual(heap.insert(Buffer.alloc(50000, 5)), huge);
    assert.equal(heap.update(second, Buffer.from("작아짐")), true);
    batch.commit();
    assert.ok(space.header.pageCount <= size + 4);
    assert.deepEqual(space.heap(root).get(first), Buffer.alloc(32000, 4));
    assert.deepEqual(space.heap(root).get(second), Buffer.from("작아짐"));
    const after = space.header.pageCount;
    batch = space.begin(); batch.dropHeap(root); batch.commit();
    batch = space.begin(); const replacement = batch.createHeap(); batch.heap(replacement).insert(Buffer.alloc(50000)); batch.commit();
    assert.equal(space.header.pageCount, after);
  } finally { space.close(); }
});

test("배치 격리, 충돌 검사와 닫기의 롤백은 갱신 유실을 막는다", (t) => {
  const filePath = temp(t), space = createTablespace(filePath, { name: "TEST" });
  let batch = space.begin(); const root = batch.createHeap(); const row = batch.heap(root).insert(Buffer.from("before")); batch.commit();
  const first = space.begin(), second = space.begin();
  first.heap(root).update(row, Buffer.from("first")); second.heap(root).update(row, Buffer.from("second"));
  assert.equal(space.heap(root).get(row)?.toString(), "before");
  assert.equal(first.heap(root).get(row)?.toString(), "first");
  first.commit();
  assert.throws(() => second.commit(), state("40001")); second.rollback();
  assert.equal(space.heap(root).get(row)?.toString(), "first");
  batch = space.begin(); batch.heap(root).update(row, Buffer.alloc(60000)); batch.setCatalog(Buffer.from("uncommitted"));
  const bytes = fs.readFileSync(filePath); batch.rollback();
  assert.deepEqual(fs.readFileSync(filePath), bytes);
  batch = space.begin(); batch.heap(root).delete(row); space.close();
  assert.throws(() => batch.commit(), state("22023"));
  const reopened = openTablespace(filePath);
  try { assert.equal(reopened.heap(root).get(row)?.toString(), "first"); assert.equal(reopened.getCatalog(), null); }
  finally { reopened.close(); }
});

test("B+Tree 다단계 분할, 범위 조회, 병합, 루트 축소와 재열기", (t) => {
  const filePath = temp(t); let space = createTablespace(filePath, { name: "TEST", cachePages: 3 });
  const batch = space.begin(), root = batch.createIndex();
  const index = batch.index(root);
  const numbers = shuffle(Array.from({ length: 800 }, (_, i) => i));
  for (const n of numbers) index.insert(key(n, 250), { pageId: n + 1, slotId: n % 17 });
  assert.deepEqual(index.range({ lower: key(101, 250), upper: key(110, 250), lowerInclusive: false, upperInclusive: false })
    .map((entry) => entry.key.readUInt32BE()), [102, 103, 104, 105, 106, 107, 108, 109]);
  assert.equal(index.range({ limit: 3 }).length, 3);
  batch.commit(); space.close(); space = openTablespace(filePath, { cachePages: 2 });
  try {
    for (const n of numbers) assert.deepEqual(space.index(root).find(key(n, 250)), [{ pageId: n + 1, slotId: n % 17 }]);
    const deletion = space.begin(), mutable = deletion.index(root);
    for (const n of numbers) {
      assert.equal(mutable.delete(key(n, 250), { pageId: n + 1, slotId: n % 17 }), true);
      if (n % 100 === 0) assert.equal(mutable.find(key(n, 250)).length, 0);
    }
    assert.equal(mutable.range().length, 0);
    assert.equal(mutable.delete(key(1), { pageId: 1, slotId: 1 }), false);
    mutable.insert(key(7), { pageId: 8, slotId: 0 }); deletion.commit();
    assert.deepEqual(space.index(root).find(key(7)), [{ pageId: 8, slotId: 0 }]);
  } finally { space.close(); }
});

test("B+Tree의 중복 키, 유일 검사, 복합 키와 페이지를 넘는 키", (t) => {
  const filePath = temp(t), space = createTablespace(filePath, { name: "TEST" });
  try {
    const batch = space.begin(), root = batch.createIndex(), uniqueRoot = batch.createIndex({ unique: true });
    const index = batch.index(root), unique = batch.index(uniqueRoot);
    const big = Buffer.alloc(25000, 8);
    for (let i = 600; i > 0; i--) index.insert(key(3), { pageId: i, slotId: 0 });
    index.insert(big, { pageId: 1, slotId: 3 });
    assert.equal(index.find(key(3)).length, 600);
    assert.deepEqual(index.find(big), [{ pageId: 1, slotId: 3 }]);
    unique.insert(big, { pageId: 1, slotId: 0 });
    assert.throws(() => unique.insert(big, { pageId: 2, slotId: 0 }), state("23505"));
    assert.equal(unique.delete(big, { pageId: 1, slotId: 0 }), true);
    unique.insert(big, { pageId: 2, slotId: 0 });
    const compound = (a: number, b: number) => Buffer.concat([key(a), key(0xffffffff - b)]);
    for (const [a, b] of [[2, 1], [1, 2], [1, 1]]) index.insert(compound(a!, b!), { pageId: a!, slotId: b! });
    assert.deepEqual(index.range({ lower: compound(1, 2), upper: compound(2, 1) }).map((entry) => entry.rowId),
      [{ pageId: 1, slotId: 2 }, { pageId: 1, slotId: 1 }, { pageId: 2, slotId: 1 }]);
    batch.commit();
    const size = space.header.pageCount;
    const drop = space.begin(); drop.dropIndex(root); drop.dropIndex(uniqueRoot); drop.commit();
    const next = space.begin(); next.createIndex(); next.commit(); assert.equal(space.header.pageCount, size);
  } finally { space.close(); }
});

test("길이가 섞인 B+Tree 키의 삽입/삭제는 정렬 모델과 일치한다", (t) => {
  const filePath = temp(t), space = createTablespace(filePath, { name: "TEST", cachePages: 1 });
  try {
    const batch = space.begin(), root = batch.createIndex(), index = batch.index(root);
    const numbers = shuffle(Array.from({ length: 500 }, (_, i) => i));
    const length = (i: number) => i % 5 === 0 ? 1000 : i % 7 === 0 ? 20000 : 4;
    for (const i of numbers) index.insert(key(i, length(i)), { pageId: i + 1, slotId: 0 });
    const alive = new Set(numbers);
    for (let offset = 0; offset < numbers.length; offset++) {
      const i = numbers[offset]!;
      assert.equal(index.delete(key(i, length(i)), { pageId: i + 1, slotId: 0 }), true); alive.delete(i);
      if (offset % 25 === 0) assert.deepEqual(index.range().map((entry) => entry.key.readUInt32BE()), [...alive].sort((a, b) => a - b));
    }
    batch.commit();
  } finally { space.close(); }
});

test("한쪽에 긴 키가 몰린 B+Tree도 바이트 크기로 분할한다", (t) => {
  const space = createTablespace(temp(t), { name: "TEST" });
  try {
    const batch = space.begin(), root = batch.createIndex(), index = batch.index(root);
    for (let i = 0; i < 48; i++) index.insert(key(i, i < 40 ? 4 : 1024), { pageId: i + 1, slotId: 0 });
    assert.deepEqual(index.range().map((entry) => entry.key.readUInt32BE()), Array.from({ length: 48 }, (_, i) => i));
    batch.commit();
  } finally { space.close(); }
});

test("실제 프로세스가 닫기 없이 종료되면 커밋만 남고 다음 열기에서 경고한다", (t) => {
  const filePath = temp(t);
  const moduleUrl = new URL("../../src/storage/format/format.js", import.meta.url).href;
  const script = `
    import { createTablespace } from ${JSON.stringify(moduleUrl)};
    const space = createTablespace(process.argv[1], { name: 'TEST' });
    const batch = space.begin(); batch.setCatalog(Buffer.from('committed')); batch.commit();
    space.begin().setCatalog(Buffer.from('uncommitted')); process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, filePath], { encoding: "utf8", windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const warnings: string[] = [], space = openTablespace(filePath, { onWarning: (message) => warnings.push(message) });
  try { assert.equal(space.getCatalog()?.toString(), "committed"); assert.equal(warnings.length, 1); }
  finally { space.close(); }
});

test("고정 v1 바이너리는 해시와 이전 데이터/인덱스의 호환성을 유지한다", (t) => {
  const source = fileURLToPath(new URL("../../../test/fixtures/storage-v1.hwdb", import.meta.url));
  const expectedHash = "4761b56834809b99431944c62cd8c440957a76cde8a44f14c29ab1b333193d7c";
  const hash = () => crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
  assert.equal(hash(), expectedHash);
  const filePath = temp(t); fs.copyFileSync(source, filePath);
  const space = openTablespace(filePath);
  try {
    assert.equal(space.header.name, "FIXTURE_V1");
    assert.equal(space.header.serverVersion, "0.1.0");
    assert.equal(space.header.createdAt, Date.parse("2026-10-08T00:00:00Z"));
    const catalog = JSON.parse(space.getCatalog()!.toString()) as {
      heapRoot: number; uniqueRoot: number; indexRoot: number; hello: RowId; empty: RowId; large: RowId;
    };
    assert.deepEqual(space.heap(catalog.heapRoot).get(catalog.hello), Buffer.from("Hello World 한글😀"));
    assert.deepEqual(space.heap(catalog.heapRoot).get(catalog.empty), Buffer.alloc(0));
    assert.deepEqual(space.heap(catalog.heapRoot).get(catalog.large), Buffer.alloc(25000, 0xab));
    assert.deepEqual(space.index(catalog.uniqueRoot).find(Buffer.alloc(12000, 0xcc)), [catalog.large]);
    assert.equal(space.index(catalog.indexRoot).range().length, 66);
    assert.deepEqual(space.index(catalog.indexRoot).find(Buffer.from("duplicate")), [catalog.hello, catalog.empty]);
    for (let i = 0; i < 64; i++) assert.deepEqual(space.index(catalog.indexRoot).find(key(i, 300)), [catalog.hello]);
    const batch = space.begin(); assert.throws(() => batch.index(catalog.uniqueRoot).insert(Buffer.from("hello"), catalog.large), state("23505"));
    batch.rollback();
  } finally { space.close(); }
  assert.equal(hash(), expectedHash);
});

test("손상된 헤더/페이지, 새 버전, 캐릭터셋과 순환 연결을 거부한다", (t) => {
  const filePath = temp(t), space = createTablespace(filePath, { name: "TEST" });
  const batch = space.begin(), root = batch.createHeap(); batch.heap(root).insert(Buffer.from("row")); batch.commit(); space.close();
  const original = fs.readFileSync(filePath);
  const check = (change: (bytes: Buffer) => void, sqlState: string, reseal = false) => {
    const bytes = Buffer.from(original); change(bytes);
    if (reseal) seal(bytes.subarray(0, PAGE_SIZE));
    fs.writeFileSync(filePath, bytes); assert.throws(() => openTablespace(filePath), state(sqlState));
  };
  check((bytes) => { bytes[0] = 0; }, "XX001");
  check((bytes) => { bytes.writeUInt32LE(99, 8); }, "0A000");
  check((bytes) => { bytes[40] = 0xff; }, "XX001", true);
  check((bytes) => { bytes.write("UTF16", 16, "ascii"); }, "0A000", true);
  check((bytes) => { bytes[PAGE_SIZE + 40] = bytes[PAGE_SIZE + 40]! ^ 1; }, "XX001");
  const cyclic = Buffer.from(original), page = cyclic.subarray(root * PAGE_SIZE, (root + 1) * PAGE_SIZE);
  page.writeUInt32LE(root, 8); seal(page); fs.writeFileSync(filePath, cyclic);
  const opened = openTablespace(filePath);
  try { assert.throws(() => opened.heap(root).scan(), state("XX001")); }
  finally { opened.close(); }
});

test("정상 종료 표시와 기능 검사는 재열기 시 호환성을 지킨다", (t) => {
  const filePath = temp(t), space = createTablespace(filePath, { name: "TEST" });
  assert.throws(() => createTablespace(filePath, { name: "OTHER" }), state("58030"));
  assert.equal(space.supports("heap"), true); assert.equal(space.supports("future-feature"), false);
  assert.throws(() => space.requireFeature("future-feature"), state("0A000"));
  space.close();
  const bytes = fs.readFileSync(filePath); bytes[624] = 0; seal(bytes.subarray(0, PAGE_SIZE)); fs.writeFileSync(filePath, bytes);
  const warnings: string[] = [];
  const reopened = openTablespace(filePath, { onWarning: (message) => warnings.push(message) });
  assert.equal(warnings.length, 1); reopened.close();
  assert.equal(fs.readFileSync(filePath)[624], 1);
  assert.equal(END, 8188);
});
