/**
 * 담당 : Node.js와 bun에서 빌드 결과물의 저장/재열기 및 구동 주요 경로를 검증한다.
 * 관련 사양 : AGENTS.md 상세 3, 10, 12. 구현 계획 공통 방침.
 * 구현 단계 : 1, 2단계.
 * 사용 : npm run build 후 node 또는 bun test/storage/runtime-smoke.mjs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTablespace, openTablespace } from "../../dist/src/storage/format/format.js";
import { runForeground } from "../../dist/src/daemon/main.js";
import { createLogger } from "../../dist/src/common/logger.js";
import { LOG_FILE_NAME } from "../../dist/src/common/instance.js";
import { isRunning } from "../../dist/src/daemon/lockFile.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hwdb-runtime-"));
let space;
try {
  const filePath = path.join(dir, "RUNTIME.hwdb");
  space = createTablespace(filePath, { name: "RUNTIME", cachePages: 1 });
  const batch = space.begin(), heapRoot = batch.createHeap(), heap = batch.heap(heapRoot);
  const indexRoot = batch.createIndex({ unique: true }), index = batch.index(indexRoot);
  const rows = [];
  for (let i = 0; i < 100; i++) {
    const key = Buffer.alloc(1024); key.writeUInt32BE(i);
    const id = heap.insert(Buffer.from(`Hello World 한글😀 ${i}`));
    rows.push({ key, id }); index.insert(key, id);
  }
  const big = heap.insert(Buffer.alloc(25000, 3));
  batch.setCatalog(Buffer.from(JSON.stringify({ heapRoot, indexRoot }))); batch.commit();
  const pending = space.begin(); pending.heap(heapRoot).update(rows[0].id, Buffer.from("pending"));
  assert.equal(space.heap(heapRoot).get(rows[0].id).toString(), "Hello World 한글😀 0"); pending.rollback();
  space.close(); space = openTablespace(filePath);
  assert.deepEqual(space.heap(heapRoot).get(big), Buffer.alloc(25000, 3));
  assert.equal(space.heap(heapRoot).scan().length, 101);
  for (const { key, id } of rows) assert.deepEqual(space.index(indexRoot).find(key), [id]);
  const deletion = space.begin();
  for (const { key, id } of rows) { deletion.index(indexRoot).delete(key, id); deletion.heap(heapRoot).delete(id); }
  deletion.commit(); assert.equal(space.index(indexRoot).range().length, 0);
  space.close(); space = undefined;

  const source = fileURLToPath(new URL("../fixtures/storage-v1.hwdb", import.meta.url));
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex"),
    "4761b56834809b99431944c62cd8c440957a76cde8a44f14c29ab1b333193d7c");
  const copy = path.join(dir, "fixture.hwdb"); fs.copyFileSync(source, copy);
  space = openTablespace(copy);
  const catalog = JSON.parse(space.getCatalog().toString());
  assert.equal(space.heap(catalog.heapRoot).scan().length, 3);
  assert.equal(space.index(catalog.indexRoot).range().length, 66);
  space.close(); space = undefined;

  const logger = createLogger({ level: "info", dir: path.join(dir, "logs"), foreground: false });
  logger.info("ALTER USER SYSTEM IDENTIFIED /* comment */ BY 'runtime-secret'"); await logger.close();
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "logs", LOG_FILE_NAME), "utf8"), /runtime-secret/);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ log: { level: "error" } }));
  await runForeground(dir, { ready: () => process.emit("SIGINT") });
  assert.equal(isRunning(path.join(dir, "data")), false);
  process.stdout.write("저장, 재열기, v1 호환성, 롤백, 인덱스 삭제와 포그라운드 종료 검증 통과\n");
} finally {
  space?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
