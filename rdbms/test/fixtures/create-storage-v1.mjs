/**
 * 담당 : 최초 v1 호환성 자료 생성. 일반 테스트에서 재생성하지 않는다.
 * 관련 사양 : AGENTS.md 상세 3. docs/storage-v1.md.
 * 구현 단계 : 2단계.
 * 사용 : npm run build 후 node test/fixtures/create-storage-v1.mjs. 기존 파일은 덮어쓰지 않는다.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTablespace } from "../../dist/src/storage/format/format.js";

const filePath = fileURLToPath(new URL("./storage-v1.hwdb", import.meta.url));
const space = createTablespace(filePath, { name: "FIXTURE_V1", createdAt: Date.parse("2026-10-08T00:00:00Z"), serverVersion: "0.1.0" });
try {
  const batch = space.begin();
  const heapRoot = batch.createHeap(), heap = batch.heap(heapRoot);
  const hello = heap.insert(Buffer.from("Hello World 한글😀"));
  const empty = heap.insert(Buffer.alloc(0));
  const large = heap.insert(Buffer.alloc(25000, 0xab));
  const uniqueRoot = batch.createIndex({ unique: true }), unique = batch.index(uniqueRoot);
  unique.insert(Buffer.from("hello"), hello);
  unique.insert(Buffer.from("empty"), empty);
  unique.insert(Buffer.alloc(12000, 0xcc), large);
  const indexRoot = batch.createIndex(), index = batch.index(indexRoot);
  for (let i = 0; i < 64; i++) {
    const key = Buffer.alloc(300); key.writeUInt32BE(i);
    index.insert(key, hello);
  }
  index.insert(Buffer.from("duplicate"), hello); index.insert(Buffer.from("duplicate"), empty);
  batch.setCatalog(Buffer.from(JSON.stringify({ heapRoot, uniqueRoot, indexRoot, hello, empty, large }), "utf8"));
  batch.commit();
} finally { space.close(); }
process.stdout.write(`${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}\n`);
