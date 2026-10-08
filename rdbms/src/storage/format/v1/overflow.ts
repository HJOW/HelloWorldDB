/**
 * 담당 : 힙 행, 긴 인덱스 키, 카탈로그의 오버플로 체인.
 * 관련 사양 : AGENTS.md 상세 3. docs/storage-v1.md.
 * 구현 단계 : 2단계.
 */
import type { ReadContext, WriteContext } from "./context.js";
import { BODY, CAPACITY, Kind } from "./pages.js";
import { corrupt } from "../../errors.js";

export function readOverflow(context: ReadContext, first: number, owner: number, expected?: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  const visited = new Set<number>();
  for (let id = first; id !== 0;) {
    if (visited.has(id)) throw corrupt("Cyclic overflow chain.");
    visited.add(id);
    const page = context.page(id, Kind.Overflow, owner);
    const length = page.readUInt32LE(24);
    if (length > CAPACITY) throw corrupt("Invalid overflow length.");
    total += length;
    if (expected !== undefined && total > expected) throw corrupt("Overflow chain exceeds row length.");
    chunks.push(page.subarray(BODY, BODY + length));
    id = page.readUInt32LE(8);
  }
  if (expected !== undefined && total !== expected) throw corrupt("Overflow chain length mismatch.");
  return Buffer.concat(chunks, total);
}

export function writeOverflow(context: WriteContext, data: Buffer, owner: number): number {
  // 빈 카탈로그도 체인 하나로 NULL과 구별한다.
  const count = Math.max(1, Math.ceil(data.length / CAPACITY));
  const ids = Array.from({ length: count }, () => context.allocate(Kind.Overflow, owner));
  for (let index = 0; index < count; index++) {
    const id = ids[index]!;
    const page = context.page(id, Kind.Overflow, owner);
    const chunk = data.subarray(index * CAPACITY, (index + 1) * CAPACITY);
    page.writeUInt32LE(ids[index + 1] ?? 0, 8);
    page.writeUInt32LE(chunk.length, 24);
    chunk.copy(page, BODY);
    context.write(id, page);
  }
  return ids[0]!;
}

export function freeOverflow(context: WriteContext, first: number, owner: number): void {
  const visited = new Set<number>();
  for (let id = first; id !== 0;) {
    if (visited.has(id)) throw corrupt("Cyclic overflow chain.");
    visited.add(id);
    const page = context.page(id, Kind.Overflow, owner);
    const next = page.readUInt32LE(8);
    context.free(id);
    id = next;
  }
}
