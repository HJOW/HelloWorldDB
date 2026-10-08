/**
 * 버퍼 캐시.
 *
 * 담당
 *  - 읽은 페이지를 메모리에 두고 다시 쓴다.
 *  - 변경된 페이지와, 그 변경을 만든 트랜잭션을 추적한다.
 *  - 커밋되지 않은 변경은 데이터 파일에 쓰지 않는다.
 *    그래서 변경된 페이지는 커밋이나 롤백 전에 캐시에서 내보낼 수 없고,
 *    트랜잭션 하나의 크기는 메모리 크기에 제한된다.
 *  - 커밋할 때 해당 변경을 데이터 파일에 쓰고 디스크에 반영(fsync)한다.
 *
 * 파일 입출력은 pageFile.ts 를 거친다.
 *
 * 관련 사양 : AGENTS.md 상세 10, 12
 * 구현 단계 : 2단계
 */

import { PageFile, PAGE_SIZE } from "./pageFile.js";
import { argument, conflict, storageIO, uint } from "./errors.js";

/** 포맷에 독립적인 페이지 사본. 읽은 바이트열을 바꾸어도 캐시는 변하지 않는다. */
export interface PageReader { read(pageId: number): Buffer; }

export class BufferCache implements PageReader {
  private readonly pages = new Map<number, Buffer>();
  private readonly batches = new Set<PageBatch>();
  private revision = 0;
  private failed = false;
  private closed = false;

  constructor(readonly file: PageFile, private readonly capacity = 64) {
    uint(capacity);
    if (capacity === 0) throw argument("Cache capacity must be positive.");
  }

  read(pageId: number): Buffer {
    this.checkUsable();
    uint(pageId);
    const cached = this.pages.get(pageId);
    const page = cached ?? this.file.readPage(pageId);
    this.remember(pageId, page);
    return Buffer.from(page);
  }

  begin(): PageBatch {
    this.checkUsable();
    const batch = new PageBatch(this, this.revision);
    this.batches.add(batch);
    return batch;
  }

  /** 데이터는 헤더보다 먼저 기록한다. fsync가 성공한 뒤 캐시에 공개한다. */
  commit(batch: PageBatch, revision: number, changes: ReadonlyMap<number, Buffer>): void {
    this.checkUsable();
    if (!this.batches.has(batch)) throw argument("Storage batch is not active.");
    if (revision !== this.revision) throw conflict();
    const ids = [...changes.keys()].sort((a, b) => a - b);
    // I/O 이전에 빈 구간을 검증한다. 사용자 인자 오류는 캐시를 손상시키지 않는다.
    let count = this.file.pageCount;
    for (const id of ids) {
      if (id > count) throw argument("Storage batch leaves a gap in the file.");
      if (id === count) count++;
    }
    try {
      for (const id of ids) if (id !== 0) this.file.writePage(id, changes.get(id)!);
      if (changes.has(0)) this.file.writePage(0, changes.get(0)!);
      this.file.sync();
    } catch (error) {
      this.failed = true;
      this.pages.clear();
      throw error;
    }
    for (const [id, page] of changes) this.remember(id, Buffer.from(page));
    this.revision++;
    this.finish(batch);
  }

  finish(batch: PageBatch): void { this.batches.delete(batch); }

  discardPending(): void {
    for (const batch of [...this.batches]) batch.rollback();
  }

  close(): void {
    if (this.closed) return;
    this.discardPending();
    this.pages.clear();
    this.closed = true;
    this.file.close();
  }

  private remember(id: number, page: Buffer): void {
    this.pages.delete(id);
    this.pages.set(id, page);
    if (this.pages.size > this.capacity) this.pages.delete(this.pages.keys().next().value!);
  }

  private checkUsable(): void {
    if (this.closed) throw argument("Buffer cache is closed.");
    if (this.failed) throw storageIO("Storage is unavailable after an I/O failure.");
  }
}

/** 미커밋 변경은 이 객체에만 존재하고 LRU 퇴거 대상이 아니다. */
export class PageBatch implements PageReader {
  private readonly changes = new Map<number, Buffer>();
  private active = true;
  constructor(private readonly cache: BufferCache, private readonly revision: number) {}

  read(pageId: number): Buffer {
    this.checkActive();
    const page = this.changes.get(pageId);
    return page === undefined ? this.cache.read(pageId) : Buffer.from(page);
  }

  write(pageId: number, page: Buffer): void {
    this.checkActive();
    uint(pageId);
    if (page.length !== PAGE_SIZE) throw argument("Invalid page size.");
    this.changes.set(pageId, Buffer.from(page));
  }

  commit(): void {
    this.checkActive();
    this.cache.commit(this, this.revision, this.changes);
    this.active = false;
    this.changes.clear();
  }

  rollback(): void {
    if (!this.active) return;
    this.active = false;
    this.changes.clear();
    this.cache.finish(this);
  }

  private checkActive(): void {
    if (!this.active) throw argument("Storage batch is no longer active.");
  }
}
