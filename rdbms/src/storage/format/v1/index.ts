/**
 * 포맷 버전 1 구현의 입구.
 *
 * 담당
 *  - 공통 인터페이스(../format.ts)의 버전 1 구현을 묶어 내보낸다.
 *  - 파일 헤더(0번 페이지) : 매직 넘버, 포맷 버전, 페이지 크기, 캐릭터셋, 테이블스페이스 이름,
 *    생성 시각, 생성한 RDBMS 버전, 정상 종료 표시, 카탈로그 루트 페이지, 빈 페이지 목록
 *  - 빈 페이지 관리, 페이지 체크섬
 *
 * RDBMS 1.0 이후 릴리스한 포맷은 버그 수정 외에 이 디렉토리를 고치지 않는다.
 * 그때 구조를 바꾸려면 v2 디렉토리를 새로 만들고 이전 테이블스페이스를 계속 지원한다.
 * 1.0 출시 전에는 개요 3의 예외로 포맷 번호를 유지한 구조 변경과 기존 호환성 생략이 가능하다.
 * 변경 시 포맷 문서와 테스트 자료도 함께 갱신한다.
 * 바이트 단위 레이아웃은 docs 의 저장 포맷 문서에 적는다.
 *
 * 관련 사양 : AGENTS.md 상세 2, 3
 * 구현 단계 : 2단계
 */

import type { CreateTablespaceOptions, HeapReader, IndexReader, OpenTablespaceOptions, StorageBatch,
  Tablespace, TablespaceHeader } from "../format.js";
import type { ReadContext, WriteContext } from "./context.js";
import { BufferCache } from "../../bufferCache.js";
import type { PageBatch } from "../../bufferCache.js";
import { PageFile, PAGE_SIZE } from "../../pageFile.js";
import { argument, corrupt, uint } from "../../errors.js";
import { RDBMS_VERSION } from "../../../common/instance.js";
import { unsupportedFeature } from "../../../common/errors.js";
import { decodeHeader, encodeHeader, emptyPage, Kind, seal, verifyDataPage } from "./pages.js";
import type { PageKind } from "./pages.js";
import { V1Heap } from "./heap.js";
import { V1Index } from "./btree.js";
import { freeOverflow, readOverflow, writeOverflow } from "./overflow.js";

const FEATURES = new Set(["heap", "overflow", "btree", "catalog", "batch"]);

export class V1Tablespace implements Tablespace, ReadContext {
  private closed = false;
  private constructor(private readonly cache: BufferCache) {}

  static create(filePath: string, options: CreateTablespaceOptions): V1Tablespace {
    if ([...options.name].length > 128) throw argument("Tablespace name exceeds 128 characters.");
    if (options.characterSet !== undefined && options.characterSet !== "UTF8") throw unsupportedFeature("Only UTF8 is supported.");
    const createdAt = options.createdAt ?? Date.now();
    if (!Number.isSafeInteger(createdAt)) throw argument("Invalid tablespace creation time.");
    const header: TablespaceHeader = { formatVersion: 1, pageSize: PAGE_SIZE, characterSet: "UTF8", name: options.name,
      createdAt, serverVersion: options.serverVersion ?? RDBMS_VERSION, cleanShutdown: false,
      catalogRoot: 0, freeListHead: 0, pageCount: 1 };
    // 인자를 검증한 뒤 파일을 만든다. 이미 있는 파일은 절대로 덮어쓰지 않는다.
    const bytes = encodeHeader(header);
    if (options.cachePages !== undefined && (!Number.isSafeInteger(options.cachePages) || options.cachePages < 1 || options.cachePages > 0xffffffff)) {
      throw argument("Cache capacity must be positive.");
    }
    const file = PageFile.create(filePath);
    try {
      file.writePage(0, bytes); file.sync();
      return new V1Tablespace(new BufferCache(file, options.cachePages));
    } catch (error) { file.close(); throw error; }
  }

  static open(file: PageFile, options: OpenTablespaceOptions): V1Tablespace {
    const header = decodeHeader(file.readPage(0));
    if (header.pageCount !== file.pageCount) throw corrupt("Tablespace page count does not match file size.");
    const freePages = new Set<number>();
    for (let id = 1; id < header.pageCount; id++) {
      const page = file.readPage(id);
      verifyDataPage(page, id);
      if (page[4] === Kind.Free) freePages.add(id);
      for (const at of [8, 12, 16]) {
        if (page.readUInt32LE(at) >= header.pageCount) throw corrupt("Page pointer exceeds tablespace size.");
      }
    }
    const visited = new Set<number>();
    for (let id = header.freeListHead; id !== 0;) {
      if (!freePages.has(id) || visited.has(id)) throw corrupt("Invalid free page chain.");
      visited.add(id);
      id = file.readPage(id).readUInt32LE(8);
    }
    if (visited.size !== freePages.size) throw corrupt("Unlinked free pages.");
    const tablespace = new V1Tablespace(new BufferCache(file, options.cachePages));
    if (!header.cleanShutdown) options.onWarning?.("Tablespace was not shut down cleanly; automatic recovery is unavailable.");
    if (header.catalogRoot !== 0) tablespace.getCatalog();
    const batch = tablespace.cache.begin();
    try {
      header.cleanShutdown = false;
      batch.write(0, encodeHeader(header)); batch.commit();
    } catch (error) { batch.rollback(); throw error; }
    return tablespace;
  }

  get header(): TablespaceHeader {
    this.checkOpen();
    return decodeHeader(this.cache.read(0));
  }

  page(id: number, kind?: PageKind, owner?: number): Buffer {
    return checkedPage(this.cache, this.header, id, kind, owner);
  }

  begin(): StorageBatch {
    this.checkOpen();
    return new V1Batch(this.cache.begin());
  }
  heap(root: number): HeapReader { return new V1Heap(this, root); }
  index(root: number): IndexReader { return new V1Index(this, root); }
  getCatalog(): Buffer | null {
    const root = this.header.catalogRoot;
    return root === 0 ? null : readOverflow(this, root, 0);
  }
  supports(feature: string): boolean { return FEATURES.has(feature); }
  requireFeature(feature: string): void {
    if (!this.supports(feature)) throw unsupportedFeature(`Feature is unavailable in tablespace format v1: ${feature}.`);
  }
  close(): void {
    if (this.closed) return;
    this.cache.discardPending();
    try {
      const header = this.header;
      header.cleanShutdown = true;
      const batch = this.cache.begin();
      try { batch.write(0, encodeHeader(header)); batch.commit(); }
      catch (error) { batch.rollback(); throw error; }
    } finally { this.closed = true; this.cache.close(); }
  }
  private checkOpen(): void {
    if (this.closed) throw argument("Tablespace is closed.");
  }
}

function checkedPage(reader: { read(id: number): Buffer }, header: TablespaceHeader, id: number, kind?: PageKind, owner?: number): Buffer {
  uint(id);
  if (id === 0 || id >= header.pageCount) throw corrupt("Data page pointer is outside the tablespace.");
  const page = reader.read(id);
  verifyDataPage(page, id);
  if ((kind !== undefined && page[4] !== kind) || (owner !== undefined && page.readUInt32LE(16) !== owner)) {
    throw corrupt("Unexpected page kind or owner.");
  }
  return page;
}

class V1Batch implements StorageBatch, WriteContext {
  private readonly header: TablespaceHeader;
  constructor(private readonly batch: PageBatch) { this.header = decodeHeader(batch.read(0)); }

  page(id: number, kind?: PageKind, owner?: number): Buffer {
    return checkedPage(this.batch, this.header, id, kind, owner);
  }
  write(id: number, page: Buffer): void { this.batch.write(id, seal(page)); }

  allocate(kind: PageKind, owner: number): number {
    let id: number;
    if (this.header.freeListHead !== 0) {
      id = this.header.freeListHead;
      const free = this.page(id, Kind.Free);
      this.header.freeListHead = free.readUInt32LE(8);
    } else {
      if (this.header.pageCount === 0xffffffff) throw argument("Tablespace page number limit reached.");
      id = this.header.pageCount++;
    }
    this.batch.write(id, emptyPage(id, kind, owner));
    this.writeHeader();
    return id;
  }

  free(id: number): void {
    const current = this.page(id);
    if (current[4] === Kind.Free) throw argument("Page is already free.");
    const page = emptyPage(id, Kind.Free, 0);
    page.writeUInt32LE(this.header.freeListHead, 8);
    this.write(id, page);
    this.header.freeListHead = id;
    this.writeHeader();
  }

  createHeap(): number {
    const id = this.allocate(Kind.Heap, 0);
    const page = this.page(id, Kind.Heap);
    page.writeUInt32LE(id, 16); this.write(id, page);
    return id;
  }
  heap(root: number): V1Heap { return new V1Heap(this, root, this); }
  createIndex(options: { unique?: boolean } = {}): number {
    const id = this.allocate(Kind.Index, 0);
    const leaf = this.allocate(Kind.Leaf, id);
    const page = this.page(id, Kind.Index);
    page.writeUInt32LE(id, 16); page.writeUInt32LE(leaf, 8);
    page[5] = options.unique ? 1 : 0;
    this.write(id, page);
    return id;
  }
  index(root: number): V1Index { return new V1Index(this, root, this); }
  dropHeap(root: number): void { this.heap(root).drop(); }
  dropIndex(root: number): void { this.index(root).drop(); }
  getCatalog(): Buffer | null {
    return this.header.catalogRoot === 0 ? null : readOverflow(this, this.header.catalogRoot, 0);
  }
  setCatalog(data: Buffer | null): void {
    if (data !== null) uint(data.length);
    const old = this.header.catalogRoot;
    const root = data === null ? 0 : writeOverflow(this, data, 0);
    if (old !== 0) freeOverflow(this, old, 0);
    this.header.catalogRoot = root;
    this.writeHeader();
  }
  commit(): void { this.writeHeader(); this.batch.commit(); }
  rollback(): void { this.batch.rollback(); }
  private writeHeader(): void { this.batch.write(0, encodeHeader(this.header)); }
}
