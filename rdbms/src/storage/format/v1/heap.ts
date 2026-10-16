/**
 * 포맷 버전 1 의 행 저장소 (힙).
 *
 * 담당
 *  - 슬롯 페이지 구조로 행을 저장한다.
 *  - 행의 삽입, 수정, 삭제, 전체 순회, 행 식별자(페이지 번호와 슬롯 번호)로 읽기
 *  - 한 페이지를 넘는 행은 오버플로 페이지로 잇는다.
 *
 * 행의 내용은 바이트열로만 다룬다. 컬럼 값의 인코딩은 types/codec.ts 의 몫이다.
 *
 * 관련 사양 : AGENTS.md 상세 3
 * 구현 단계 : 2단계
 */

import type { Heap, RowId, StoredRow } from "../format.js";
import type { HeapSpace, ReadContext, WriteContext } from "./context.js";
import { BODY, CAPACITY, END, Kind } from "./pages.js";
import { argument, corrupt, uint } from "../../errors.js";
import { freeOverflow, readOverflow, writeOverflow } from "./overflow.js";

const SLOT_SIZE = 12;
/** 이만큼 이상 남은 페이지만 빈자리 지도에 모아 둔다. 이보다 작은 조각은 삭제로 더 커지기 전까지 쓰지 않는다. */
const MIN_ROOM = SLOT_SIZE + 16;
interface Slot { inline: Buffer; overflow: number; length: number; }
interface HeapPage { slots: (Slot | null)[]; next: number; previous: number; }

function used(slots: (Slot | null)[]): number {
  return slots.length * SLOT_SIZE + slots.reduce((sum, slot) => sum + (slot?.inline.length ?? 0), 0);
}

function hasRoom(slots: (Slot | null)[]): boolean {
  return CAPACITY - used(slots) >= MIN_ROOM;
}

/** 루트 번호를 소유자로 쓰므로 다른 힙의 행 식별자로 접근할 수 없다. */
export class V1Heap implements Heap {
  constructor(private readonly context: ReadContext, readonly root: number, private readonly writer?: WriteContext) {
    context.page(root, Kind.Heap, root);
  }

  get(id: RowId): Buffer | null {
    uint(id.pageId); uint(id.slotId, 0xffff);
    const page = this.decode(id.pageId);
    const slot = page.slots[id.slotId];
    if (slot === undefined || slot === null) return null;
    return slot.overflow === 0 ? Buffer.from(slot.inline) : readOverflow(this.context, slot.overflow, this.root, slot.length);
  }

  scan(): StoredRow[] {
    return [...this.iterate()];
  }

  *iterate(): IterableIterator<StoredRow> {
    const visited = new Set<number>();
    let previous = 0;
    for (let pageId = this.root; pageId !== 0;) {
      if (visited.has(pageId)) throw corrupt("Cyclic heap page chain.");
      visited.add(pageId);
      const page = this.decode(pageId);
      if (page.previous !== previous) throw corrupt("Invalid heap previous pointer.");
      for (let slotId = 0; slotId < page.slots.length; slotId++) {
        const slot = page.slots[slotId];
        if (slot !== null && slot !== undefined) {
          yield { id: { pageId, slotId }, data: slot.overflow === 0 ? Buffer.from(slot.inline)
            : readOverflow(this.context, slot.overflow, this.root, slot.length) };
        }
      }
      previous = pageId;
      pageId = page.next;
    }
  }

  /**
   * 행을 넣는다. 빈자리 지도(HeapSpace)가 가리키는 페이지에 먼저 넣고, 들어갈 곳이 없으면 체인 끝에 새 페이지를 잇는다.
   * 지도는 힙당 한 번만 체인을 훑어 만든다. 매번 루트부터 체인을 따라가면 행 하나의 삽입 비용이 테이블 크기에 비례한다.
   */
  insert(data: Buffer): RowId {
    const writer = this.requireWriter();
    uint(data.length);
    const inlineLength = data.length <= CAPACITY - SLOT_SIZE ? data.length : 0;
    const space = this.spaceOf(writer);
    for (const pageId of space.candidates) {
      const page = this.tryDecode(pageId);
      if (page === null) return this.insertAfterRebuild(writer, data);
      const placed = this.place(writer, pageId, page, data, inlineLength);
      if (placed === null) { space.candidates.delete(pageId); continue; }
      if (!hasRoom(page.slots)) space.candidates.delete(pageId);
      return placed;
    }
    const tail = this.tryDecode(space.tail);
    if (tail === null || tail.next !== 0) return this.insertAfterRebuild(writer, data);
    const next = writer.allocate(Kind.Heap, this.root);
    tail.next = next;
    this.encode(space.tail, tail);
    const fresh: HeapPage = { slots: [], next: 0, previous: space.tail };
    space.tail = next;
    const placed = this.place(writer, next, fresh, data, inlineLength);
    if (placed === null) throw argument("A row does not fit in an empty heap page.");
    if (hasRoom(fresh.slots)) space.candidates.add(next);
    return placed;
  }

  /** 페이지에 행을 넣어 본다. 들어가지 않으면 null 이고, 들어가면 페이지에 쓴다. */
  private place(writer: WriteContext, pageId: number, page: HeapPage, data: Buffer, inlineLength: number): RowId | null {
    let slotId = page.slots.indexOf(null);
    if (slotId < 0) slotId = page.slots.length;
    const directoryGrowth = slotId === page.slots.length ? SLOT_SIZE : 0;
    if (used(page.slots) + directoryGrowth + inlineLength > CAPACITY) return null;
    page.slots[slotId] = inlineLength === data.length
      ? { inline: Buffer.from(data), overflow: 0, length: data.length }
      : { inline: Buffer.alloc(0), overflow: writeOverflow(writer, data, this.root), length: data.length };
    this.encode(pageId, page);
    return { pageId, slotId };
  }

  /** 지도가 현재 페이지 상태와 맞지 않으면(다른 배치의 변경, 롤백된 페이지 등) 지도를 버리고 체인을 다시 훑어 넣는다. */
  private insertAfterRebuild(writer: WriteContext, data: Buffer): RowId {
    writer.setHeapSpace(this.root, undefined);
    return this.insert(data);
  }

  /** 이 힙의 빈자리 지도를 돌려준다. 없으면 체인을 한 번 훑어 만든다. */
  private spaceOf(writer: WriteContext): HeapSpace {
    const existing = writer.heapSpace(this.root);
    if (existing !== undefined) return existing;
    const candidates = new Set<number>();
    const visited = new Set<number>();
    let tail = this.root;
    for (let pageId = this.root; pageId !== 0;) {
      if (visited.has(pageId)) throw corrupt("Cyclic heap page chain.");
      visited.add(pageId);
      const page = this.decode(pageId);
      if (hasRoom(page.slots)) candidates.add(pageId);
      tail = pageId;
      pageId = page.next;
    }
    const space: HeapSpace = { candidates, tail };
    writer.setHeapSpace(this.root, space);
    return space;
  }

  /** 페이지를 해석한다. 이 힙의 페이지가 아니거나 해석할 수 없으면 null 이다. (오래된 지도 항목을 걸러내는 데 쓴다) */
  private tryDecode(id: number): HeapPage | null {
    try {
      return this.decode(id);
    } catch {
      return null;
    }
  }

  /** 페이지에 빈자리가 생겼음을 지도에 알린다. */
  private noteRoom(pageId: number, page: HeapPage): void {
    const space = this.writer?.heapSpace(this.root);
    if (space !== undefined && hasRoom(page.slots)) space.candidates.add(pageId);
  }

  update(id: RowId, data: Buffer): boolean {
    const writer = this.requireWriter();
    uint(id.pageId); uint(id.slotId, 0xffff); uint(data.length);
    const page = this.decode(id.pageId);
    const old = page.slots[id.slotId];
    if (old === undefined || old === null) return false;
    const fits = used(page.slots) - old.inline.length + data.length <= CAPACITY;
    const replacement: Slot = fits ? { inline: Buffer.from(data), overflow: 0, length: data.length }
      : { inline: Buffer.alloc(0), overflow: writeOverflow(writer, data, this.root), length: data.length };
    if (old.overflow !== 0) freeOverflow(writer, old.overflow, this.root);
    page.slots[id.slotId] = replacement;
    this.encode(id.pageId, page);
    if (replacement.inline.length < old.inline.length) this.noteRoom(id.pageId, page);
    return true;
  }

  delete(id: RowId): boolean {
    const writer = this.requireWriter();
    uint(id.pageId); uint(id.slotId, 0xffff);
    const page = this.decode(id.pageId);
    const old = page.slots[id.slotId];
    if (old === undefined || old === null) return false;
    if (old.overflow !== 0) freeOverflow(writer, old.overflow, this.root);
    page.slots[id.slotId] = null;
    this.encode(id.pageId, page);
    this.noteRoom(id.pageId, page);
    return true;
  }

  drop(): void {
    const writer = this.requireWriter();
    const visited = new Set<number>();
    for (let id = this.root; id !== 0;) {
      if (visited.has(id)) throw corrupt("Cyclic heap page chain.");
      visited.add(id);
      const page = this.decode(id);
      for (const slot of page.slots) if (slot !== null && slot.overflow !== 0) freeOverflow(writer, slot.overflow, this.root);
      writer.free(id);
      id = page.next;
    }
    writer.setHeapSpace(this.root, undefined);
  }

  private decode(id: number): HeapPage {
    const bytes = this.context.page(id, Kind.Heap, this.root);
    const count = bytes.readUInt16LE(6);
    const lower = bytes.readUInt16LE(20);
    const upper = bytes.readUInt16LE(22);
    if (lower !== BODY + count * SLOT_SIZE || lower > upper || upper > END) throw corrupt("Invalid heap slot directory.");
    const slots: (Slot | null)[] = [];
    const spans: [number, number][] = [];
    for (let index = 0; index < count; index++) {
      const at = BODY + index * SLOT_SIZE;
      const offset = bytes.readUInt16LE(at);
      const length = bytes.readUInt16LE(at + 2);
      const overflow = bytes.readUInt32LE(at + 4);
      const total = bytes.readUInt32LE(at + 8);
      if (offset === 0) {
        if (length !== 0 || overflow !== 0 || total !== 0) throw corrupt("Invalid deleted heap slot.");
        slots.push(null); continue;
      }
      if (offset < upper || offset + length > END || (overflow === 0 && total !== length) || (overflow !== 0 && length !== 0)) {
        throw corrupt("Invalid heap slot bounds.");
      }
      if (length > 0) spans.push([offset, offset + length]);
      slots.push({ inline: Buffer.from(bytes.subarray(offset, offset + length)), overflow, length: total });
    }
    spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) if (spans[i]![0] < spans[i - 1]![1]) throw corrupt("Overlapping heap slots.");
    return { slots, next: bytes.readUInt32LE(8), previous: bytes.readUInt32LE(12) };
  }

  private encode(id: number, page: HeapPage): void {
    const writer = this.requireWriter();
    if (used(page.slots) > CAPACITY) throw argument("Heap page is full.");
    const bytes = this.context.page(id, Kind.Heap, this.root);
    bytes.fill(0, BODY, END);
    bytes.writeUInt16LE(page.slots.length, 6);
    bytes.writeUInt32LE(page.next, 8);
    bytes.writeUInt32LE(page.previous, 12);
    bytes.writeUInt16LE(BODY + page.slots.length * SLOT_SIZE, 20);
    let upper = END;
    for (let index = 0; index < page.slots.length; index++) {
      const slot = page.slots[index];
      if (slot === null || slot === undefined) continue;
      upper -= slot.inline.length;
      slot.inline.copy(bytes, upper);
      const at = BODY + index * SLOT_SIZE;
      bytes.writeUInt16LE(upper, at);
      bytes.writeUInt16LE(slot.inline.length, at + 2);
      bytes.writeUInt32LE(slot.overflow, at + 4);
      bytes.writeUInt32LE(slot.length, at + 8);
    }
    bytes.writeUInt16LE(upper, 22);
    writer.write(id, bytes);
  }

  private requireWriter(): WriteContext {
    if (this.writer === undefined) throw argument("Heap is read-only outside a storage batch.");
    return this.writer;
  }
}
