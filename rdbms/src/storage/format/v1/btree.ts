/**
 * 포맷 버전 1 의 인덱스 (B+Tree).
 *
 * 담당
 *  - 키의 삽입과 삭제, 단건 탐색, 범위 탐색
 *  - 유일 키 검사 (PK 가 만드는 유일 인덱스용)
 *
 * 키는 바이트열로만 비교한다. 복합 컬럼, ASC 와 DESC, NULL 의 순서는
 * types/codec.ts 가 정렬 순서를 보존하는 키 형식으로 미리 풀어 준다.
 *
 * 관련 사양 : AGENTS.md 상세 3, 10
 * 구현 단계 : 2단계
 */

import type { IndexEntry, IndexRange, RowId, StorageIndex } from "../format.js";
import type { ReadContext, WriteContext } from "./context.js";
import { BODY, CAPACITY, END, Kind } from "./pages.js";
import { argument, corrupt, duplicate, uint } from "../../errors.js";
import { freeOverflow, readOverflow, writeOverflow } from "./overflow.js";

const INLINE_KEY_MAX = 1024;
interface Entry extends IndexEntry { overflow: number; }
interface Node { leaf: boolean; entries: Entry[]; children: number[]; next: number; previous: number; }
interface Split { separator: Entry; right: number; }
interface DeleteResult { removed: boolean; split?: Split; }

function compare(a: IndexEntry, b: IndexEntry): number {
  return Buffer.compare(a.key, b.key) || a.rowId.pageId - b.rowId.pageId || a.rowId.slotId - b.rowId.slotId;
}
function bytesUsed(node: Node): number {
  return node.entries.reduce((sum, entry) => sum + (node.leaf ? 16 : 20) + (entry.overflow === 0 ? entry.key.length : 0), 0);
}
function lowerBound(entries: Entry[], target: IndexEntry): number {
  let low = 0, high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compare(entries[middle]!, target) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** 노드의 깊이는 유지하면서 바이트 크기로 분할하고 병합한다. */
export class V1Index implements StorageIndex {
  constructor(private readonly context: ReadContext, readonly root: number, private readonly writer?: WriteContext) {
    this.metadata();
  }

  find(key: Buffer): RowId[] {
    return this.range({ lower: key, upper: key }).map((entry) => entry.rowId);
  }

  range(options: IndexRange = {}): IndexEntry[] {
    if (options.limit !== undefined) uint(options.limit);
    if (options.limit === 0) return [];
    if (options.lower !== undefined && options.upper !== undefined && Buffer.compare(options.lower, options.upper) > 0) return [];
    const target: IndexEntry = { key: options.lower ?? Buffer.alloc(0), rowId: { pageId: 0, slotId: 0 } };
    let id = this.metadata().readUInt32LE(8);
    const visited = new Set<number>();
    while (true) {
      if (visited.has(id)) throw corrupt("Cyclic B+Tree.");
      visited.add(id);
      const node = this.readNode(id);
      if (node.leaf) break;
      const child = options.lower === undefined ? 0 : this.childFor(node, target);
      id = node.children[child]!;
    }
    const result: IndexEntry[] = [];
    const leaves = new Set<number>();
    let previous: number | undefined;
    while (id !== 0) {
      if (leaves.has(id)) throw corrupt("Cyclic B+Tree leaf chain.");
      leaves.add(id);
      const node = this.readNode(id);
      if (!node.leaf || (previous !== undefined && node.previous !== previous)) throw corrupt("Invalid B+Tree leaf chain.");
      for (const entry of node.entries) {
        const lower = options.lower === undefined ? 1 : Buffer.compare(entry.key, options.lower);
        if (lower < 0 || (lower === 0 && options.lowerInclusive === false)) continue;
        const upper = options.upper === undefined ? -1 : Buffer.compare(entry.key, options.upper);
        if (upper > 0 || (upper === 0 && options.upperInclusive === false)) return result;
        result.push({ key: Buffer.from(entry.key), rowId: { ...entry.rowId } });
        if (options.limit !== undefined && result.length >= options.limit) return result;
      }
      previous = id;
      id = node.next;
    }
    return result;
  }

  insert(key: Buffer, rowId: RowId): void {
    const writer = this.requireWriter();
    this.checkRowId(rowId); uint(key.length);
    const meta = this.metadata();
    const found = this.find(key);
    if (found.some((id) => id.pageId === rowId.pageId && id.slotId === rowId.slotId) || ((meta[5]! & 1) !== 0 && found.length > 0)) {
      throw duplicate();
    }
    const entry: Entry = { key: Buffer.from(key), rowId: { ...rowId },
      overflow: key.length > INLINE_KEY_MAX ? writeOverflow(writer, key, this.root) : 0 };
    const treeRoot = meta.readUInt32LE(8);
    const split = this.insertInto(treeRoot, entry, new Set());
    if (split !== undefined) {
      const newRoot = writer.allocate(Kind.Branch, this.root);
      this.writeNode(newRoot, { leaf: false, entries: [split.separator], children: [treeRoot, split.right], next: 0, previous: 0 });
      meta.writeUInt32LE(newRoot, 8);
      writer.write(this.root, meta);
    }
  }

  delete(key: Buffer, rowId: RowId): boolean {
    this.requireWriter(); this.checkRowId(rowId);
    const meta = this.metadata();
    const treeRoot = meta.readUInt32LE(8);
    const result = this.deleteFrom(treeRoot, { key, rowId }, true, new Set());
    if (!result.removed) return false;
    // 삭제 후 최소 키가 더 긴 키로 바뀌면 내부 노드도 분할이 필요할 수 있다.
    if (result.split !== undefined) {
      const newRoot = this.requireWriter().allocate(Kind.Branch, this.root);
      this.writeNode(newRoot, { leaf: false, entries: [result.split.separator],
        children: [treeRoot, result.split.right], next: 0, previous: 0 });
      meta.writeUInt32LE(newRoot, 8); this.requireWriter().write(this.root, meta);
      return true;
    }
    let root = treeRoot;
    let node = this.readNode(root);
    while (!node.leaf && node.children.length === 1) {
      const old = root;
      root = node.children[0]!;
      this.requireWriter().free(old);
      node = this.readNode(root);
    }
    if (root !== treeRoot) {
      meta.writeUInt32LE(root, 8);
      this.requireWriter().write(this.root, meta);
    }
    return true;
  }

  drop(): void {
    const writer = this.requireWriter();
    const visited = new Set<number>();
    const visit = (id: number): void => {
      if (visited.has(id)) throw corrupt("Cyclic B+Tree.");
      visited.add(id);
      const node = this.readNode(id);
      if (node.leaf) {
        for (const entry of node.entries) if (entry.overflow !== 0) freeOverflow(writer, entry.overflow, this.root);
      } else {
        for (const child of node.children) visit(child);
      }
      writer.free(id);
    };
    visit(this.metadata().readUInt32LE(8));
    writer.free(this.root);
  }

  private insertInto(id: number, entry: Entry, visited: Set<number>): Split | undefined {
    if (visited.has(id)) throw corrupt("Cyclic B+Tree.");
    visited.add(id);
    const node = this.readNode(id);
    if (node.leaf) node.entries.splice(lowerBound(node.entries, entry), 0, entry);
    else {
      const childIndex = this.childFor(node, entry);
      const split = this.insertInto(node.children[childIndex]!, entry, visited);
      if (split !== undefined) {
        node.entries.splice(childIndex, 0, split.separator);
        node.children.splice(childIndex + 1, 0, split.right);
      }
    }
    return this.storeOrSplit(id, node);
  }

  private storeOrSplit(id: number, node: Node): Split | undefined {
    if (bytesUsed(node) <= CAPACITY) { this.writeNode(id, node); return undefined; }
    const rightId = this.requireWriter().allocate(node.leaf ? Kind.Leaf : Kind.Branch, this.root);
    // 항목 수가 아닌 누적 바이트 수로 나누어 가변 길이 키에도 양쪽이 한 페이지에 맞게 한다.
    const half = bytesUsed(node) / 2;
    let middle = 0, bytes = 0;
    while (middle < node.entries.length - 1) {
      const entry = node.entries[middle]!;
      const size = (node.leaf ? 16 : 20) + (entry.overflow === 0 ? entry.key.length : 0);
      if (bytes + size > half && middle > 0) break;
      bytes += size; middle++;
    }
    let separator: Entry;
    let right: Node;
    if (node.leaf) {
      right = { leaf: true, entries: node.entries.splice(middle), children: [], next: node.next, previous: id };
      separator = right.entries[0]!;
      if (node.next !== 0) {
        const after = this.readNode(node.next);
        after.previous = rightId;
        this.writeNode(node.next, after);
      }
      node.next = rightId;
    } else {
      separator = node.entries[middle]!;
      right = { leaf: false, entries: node.entries.slice(middle + 1), children: node.children.slice(middle + 1), next: 0, previous: 0 };
      node.entries = node.entries.slice(0, middle);
      node.children = node.children.slice(0, middle + 1);
    }
    this.writeNode(id, node);
    this.writeNode(rightId, right);
    return { separator, right: rightId };
  }

  private deleteFrom(id: number, target: IndexEntry, isRoot: boolean, visited: Set<number>): DeleteResult {
    if (visited.has(id)) throw corrupt("Cyclic B+Tree.");
    visited.add(id);
    const node = this.readNode(id);
    if (node.leaf) {
      const position = lowerBound(node.entries, target);
      const entry = node.entries[position];
      if (entry === undefined || compare(entry, target) !== 0) return { removed: false };
      node.entries.splice(position, 1);
      if (entry.overflow !== 0) freeOverflow(this.requireWriter(), entry.overflow, this.root);
      this.writeNode(id, node);
      return { removed: true };
    }
    const position = this.childFor(node, target);
    const child = node.children[position]!;
    const result = this.deleteFrom(child, target, false, visited);
    if (!result.removed) return result;
    if (result.split !== undefined) node.children.splice(position + 1, 0, result.split.right);
    const childNode = this.readNode(child);
    if ((childNode.leaf && childNode.entries.length === 0) || (!childNode.leaf && childNode.children.length === 0)) {
      this.unlinkEmpty(child, childNode);
      node.children.splice(position, 1);
    }
    // 형제 한 쌍이 한 페이지에 들어가면 병합한다. 억지로 최소 충전율을 맞추지 않는다.
    for (let index = 0; index + 1 < node.children.length;) {
      const leftId = node.children[index]!, rightId = node.children[index + 1]!;
      const left = this.readNode(leftId), right = this.readNode(rightId);
      if (left.leaf !== right.leaf) throw corrupt("Unbalanced B+Tree.");
      const merged: Node = left.leaf
        ? { ...left, entries: [...left.entries, ...right.entries], next: right.next }
        : { ...left, entries: [], children: [...left.children, ...right.children] };
      if (!merged.leaf) merged.entries = merged.children.slice(1).map((childId) => this.firstEntry(childId));
      if (bytesUsed(merged) > CAPACITY) { index++; continue; }
      this.writeNode(leftId, merged);
      if (merged.leaf && merged.next !== 0) {
        const after = this.readNode(merged.next);
        after.previous = leftId;
        this.writeNode(merged.next, after);
      }
      this.requireWriter().free(rightId);
      node.children.splice(index + 1, 1);
    }
    if (isRoot && node.children.length === 0) {
      this.writeNode(id, { leaf: true, entries: [], children: [], next: 0, previous: 0 });
    } else {
      node.entries = node.children.slice(1).map((childId) => this.firstEntry(childId));
      return { removed: true, split: this.storeOrSplit(id, node) };
    }
    return { removed: true };
  }

  private unlinkEmpty(id: number, node: Node): void {
    if (node.leaf) {
      if (node.previous !== 0) {
        const before = this.readNode(node.previous); before.next = node.next; this.writeNode(node.previous, before);
      }
      if (node.next !== 0) {
        const after = this.readNode(node.next); after.previous = node.previous; this.writeNode(node.next, after);
      }
    }
    this.requireWriter().free(id);
  }

  private firstEntry(id: number): Entry {
    const visited = new Set<number>();
    while (true) {
      if (visited.has(id)) throw corrupt("Cyclic B+Tree.");
      visited.add(id);
      const node = this.readNode(id);
      if (node.leaf) {
        if (node.entries.length === 0) throw corrupt("Empty B+Tree child.");
        return node.entries[0]!;
      }
      id = node.children[0]!;
    }
  }

  private childFor(node: Node, entry: IndexEntry): number {
    let low = 0, high = node.entries.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compare(entry, node.entries[mid]!) >= 0) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private readNode(id: number): Node {
    const page = this.context.page(id, undefined, this.root);
    const leaf = page[4] === Kind.Leaf;
    if (!leaf && page[4] !== Kind.Branch) throw corrupt("Invalid B+Tree page kind.");
    const count = page.readUInt16LE(6);
    const entries: Entry[] = [], children: number[] = [];
    if (!leaf) children.push(page.readUInt32LE(24));
    let at = BODY;
    for (let index = 0; index < count; index++) {
      const fixed = leaf ? 16 : 20;
      if (at + fixed > END) throw corrupt("Invalid B+Tree entry bounds.");
      const length = page.readUInt32LE(at), overflow = page.readUInt32LE(at + 4);
      const rowId = { pageId: page.readUInt32LE(at + 8), slotId: page.readUInt16LE(at + 12) };
      if (rowId.pageId === 0 || (overflow === 0 && (length > INLINE_KEY_MAX || at + fixed + length > END))) {
        throw corrupt("Invalid B+Tree entry.");
      }
      if (!leaf) children.push(page.readUInt32LE(at + 16));
      const key = overflow === 0 ? Buffer.from(page.subarray(at + fixed, at + fixed + length))
        : readOverflow(this.context, overflow, this.root, length);
      const entry = { key, rowId, overflow };
      if (entries.length > 0 && compare(entries.at(-1)!, entry) >= 0) throw corrupt("Unsorted B+Tree entries.");
      entries.push(entry);
      at += fixed + (overflow === 0 ? length : 0);
    }
    if (!leaf && children.some((child) => child === 0)) {
      // 빈 내부 노드는 삭제 배치 안에서만 잠깐 존재한다.
      if (count !== 0 || children[0] !== 0) throw corrupt("Invalid B+Tree child pointer.");
      children.length = 0;
    }
    return { leaf, entries, children, next: page.readUInt32LE(8), previous: page.readUInt32LE(12) };
  }

  private writeNode(id: number, node: Node): void {
    const writer = this.requireWriter();
    if (bytesUsed(node) > CAPACITY) throw argument("B+Tree node is full.");
    const page = this.context.page(id, undefined, this.root);
    page.fill(0, BODY, END);
    page[4] = node.leaf ? Kind.Leaf : Kind.Branch;
    page.writeUInt16LE(node.entries.length, 6);
    page.writeUInt32LE(node.next, 8); page.writeUInt32LE(node.previous, 12);
    page.writeUInt32LE(node.children[0] ?? 0, 24);
    let at = BODY;
    for (let i = 0; i < node.entries.length; i++) {
      const entry = node.entries[i]!;
      page.writeUInt32LE(entry.key.length, at); page.writeUInt32LE(entry.overflow, at + 4);
      page.writeUInt32LE(entry.rowId.pageId, at + 8); page.writeUInt16LE(entry.rowId.slotId, at + 12);
      const fixed = node.leaf ? 16 : 20;
      if (!node.leaf) page.writeUInt32LE(node.children[i + 1]!, at + 16);
      if (entry.overflow === 0) entry.key.copy(page, at + fixed);
      at += fixed + (entry.overflow === 0 ? entry.key.length : 0);
    }
    writer.write(id, page);
  }

  private metadata(): Buffer {
    const page = this.context.page(this.root, Kind.Index, this.root);
    if (page.readUInt32LE(8) === 0 || (page[5]! & ~1) !== 0) throw corrupt("Invalid index metadata.");
    return page;
  }
  private checkRowId(id: RowId): void {
    uint(id.pageId); uint(id.slotId, 0xffff);
    if (id.pageId === 0) throw argument("Index row page must be nonzero.");
  }
  private requireWriter(): WriteContext {
    if (this.writer === undefined) throw argument("Index is read-only outside a storage batch.");
    return this.writer;
  }
}
