/**
 * 테이블스페이스 포맷 버전의 공통 인터페이스와 버전 선택.
 *
 * 담당
 *  - 상위 계층(카탈로그, 실행기, 트랜잭션)이 쓰는 공통 인터페이스 :
 *    행 저장소, 인덱스, 카탈로그 저장 영역, 버전별 기능 지원 여부
 *  - 파일 맨 앞의 매직 넘버와 포맷 버전 읽기. 이 두 값의 위치는 모든 버전에서 같다.
 *  - 포맷 버전에 맞는 구현 고르기. 새 테이블스페이스는 항상 최신 버전으로 만든다.
 *  - 서버가 모르는 상위 버전의 파일은 사용 불가로 알린다.
 *  - 새 버전에서 생긴 기능을 이전 버전 테이블스페이스에 쓰려 하면 오류를 낸다.
 *
 * 상위 계층은 이 파일만 import 한다. v1 같은 특정 버전의 모듈을 직접 import 하지 않는다.
 *
 * 관련 사양 : AGENTS.md 상세 3
 * 구현 단계 : 2단계
 */

import { PageFile } from "../pageFile.js";
import { corrupt } from "../errors.js";
import { unsupportedFeature } from "../../common/errors.js";
import { V1Tablespace } from "./v1/index.js";

export const FILE_MAGIC = Buffer.from("HWDBTS\r\n", "ascii");
export const LATEST_FORMAT_VERSION = 1;

export interface RowId { pageId: number; slotId: number; }
export interface StoredRow { id: RowId; data: Buffer; }
export interface IndexEntry { key: Buffer; rowId: RowId; }
export interface IndexRange {
  lower?: Buffer;
  upper?: Buffer;
  lowerInclusive?: boolean;
  upperInclusive?: boolean;
  limit?: number;
}
export interface HeapReader {
  get(id: RowId): Buffer | null;
  scan(): StoredRow[];
}
export interface Heap extends HeapReader {
  insert(data: Buffer): RowId;
  update(id: RowId, data: Buffer): boolean;
  delete(id: RowId): boolean;
}
export interface IndexReader {
  find(key: Buffer): RowId[];
  range(options?: IndexRange): IndexEntry[];
}
export interface StorageIndex extends IndexReader {
  insert(key: Buffer, rowId: RowId): void;
  delete(key: Buffer, rowId: RowId): boolean;
}
export interface TablespaceHeader {
  formatVersion: number;
  pageSize: number;
  characterSet: string;
  name: string;
  createdAt: number;
  serverVersion: string;
  cleanShutdown: boolean;
  catalogRoot: number;
  freeListHead: number;
  pageCount: number;
}
export interface StorageBatch {
  createHeap(): number;
  heap(root: number): Heap;
  createIndex(options?: { unique?: boolean }): number;
  index(root: number): StorageIndex;
  dropHeap(root: number): void;
  dropIndex(root: number): void;
  getCatalog(): Buffer | null;
  setCatalog(data: Buffer | null): void;
  commit(): void;
  rollback(): void;
}
export interface Tablespace {
  readonly header: TablespaceHeader;
  begin(): StorageBatch;
  heap(root: number): HeapReader;
  index(root: number): IndexReader;
  getCatalog(): Buffer | null;
  supports(feature: string): boolean;
  requireFeature(feature: string): void;
  close(): void;
}
export interface CreateTablespaceOptions {
  name: string;
  serverVersion?: string;
  createdAt?: number;
  characterSet?: string;
  cachePages?: number;
}
export interface OpenTablespaceOptions {
  cachePages?: number;
  onWarning?: (message: string) => void;
}

/** 상위 계층이 버전을 가정하지 않고 고정 위치의 식별 정보로 구현을 고른다. */
export function openTablespace(filePath: string, options: OpenTablespaceOptions = {}): Tablespace {
  const file = PageFile.open(filePath);
  try {
    const prefix = file.readPrefix(12);
    if (!prefix.subarray(0, 8).equals(FILE_MAGIC)) throw corrupt("Invalid tablespace magic.");
    const version = prefix.readUInt32LE(8);
    if (version !== 1) throw unsupportedFeature(`Unsupported tablespace format version: ${version}.`);
    return V1Tablespace.open(file, options);
  } catch (error) { file.close(); throw error; }
}

/** 새 파일은 언제나 지원하는 최신 포맷으로 만든다. */
export function createTablespace(filePath: string, options: CreateTablespaceOptions): Tablespace {
  return V1Tablespace.create(filePath, options);
}
