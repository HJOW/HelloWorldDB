/**
 * 담당 : v1 페이지 레이아웃, CRC-32, 헤더 인코딩과 검증.
 * 관련 사양 : AGENTS.md 상세 2, 3. docs/storage-v1.md.
 * 구현 단계 : 2단계.
 */
import { PAGE_SIZE } from "../../pageFile.js";
import { argument, corrupt } from "../../errors.js";
import type { TablespaceHeader } from "../format.js";
import { unsupportedFeature } from "../../../common/errors.js";

export const END = PAGE_SIZE - 4;
export const BODY = 32;
export const CAPACITY = END - BODY;
export const Kind = { Free: 1, Heap: 2, Overflow: 3, Branch: 4, Leaf: 5, Index: 6 } as const;
export type PageKind = (typeof Kind)[keyof typeof Kind];
const MAGIC = Buffer.from("HWDBTS\r\n", "ascii");
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

export function checksum(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
  return (crc ^ 0xffffffff) >>> 0;
}
export function seal(page: Buffer): Buffer {
  page.writeUInt32LE(checksum(page.subarray(0, END)), END);
  return page;
}
export function verify(page: Buffer): void {
  if (page.length !== PAGE_SIZE || page.readUInt32LE(END) !== checksum(page.subarray(0, END))) {
    throw corrupt("Invalid page checksum.");
  }
}
export function emptyPage(id: number, kind: PageKind, owner: number): Buffer {
  const page = Buffer.alloc(PAGE_SIZE);
  page.writeUInt32LE(id, 0);
  page[4] = kind;
  page.writeUInt32LE(owner, 16);
  if (kind === Kind.Heap) {
    page.writeUInt16LE(BODY, 20);
    page.writeUInt16LE(END, 22);
  }
  return seal(page);
}
export function verifyDataPage(page: Buffer, id: number): void {
  verify(page);
  if (page.readUInt32LE(0) !== id || page[4]! < Kind.Free || page[4]! > Kind.Index) {
    throw corrupt("Invalid data page header.");
  }
}
export function decodeText(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw corrupt("Invalid UTF-8 in tablespace header."); }
}
export function checkedText(value: string, maxBytes: number): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length === 0 || bytes.length > maxBytes || decodeText(bytes) !== value || value.includes("\0")) {
    throw argument("Invalid tablespace header text.");
  }
  return bytes;
}
export function encodeHeader(header: TablespaceHeader): Buffer {
  const page = Buffer.alloc(PAGE_SIZE);
  MAGIC.copy(page);
  page.writeUInt32LE(header.formatVersion, 8);
  page.writeUInt32LE(PAGE_SIZE, 12);
  page.write(header.characterSet, 16, 16, "ascii");
  const name = checkedText(header.name, 512);
  const server = checkedText(header.serverVersion, 64);
  page.writeUInt16LE(name.length, 32);
  page.writeUInt16LE(server.length, 34);
  name.copy(page, 40);
  server.copy(page, 552);
  page.writeBigInt64LE(BigInt(header.createdAt), 616);
  page[624] = header.cleanShutdown ? 1 : 0;
  page.writeUInt32LE(header.catalogRoot, 632);
  page.writeUInt32LE(header.freeListHead, 636);
  page.writeUInt32LE(header.pageCount, 640);
  return seal(page);
}
export function decodeHeader(page: Buffer): TablespaceHeader {
  verify(page);
  if (!page.subarray(0, 8).equals(MAGIC) || page.readUInt32LE(8) !== 1 || page.readUInt32LE(12) !== PAGE_SIZE) {
    throw corrupt("Invalid v1 tablespace header.");
  }
  const characterSet = page.subarray(16, 32).toString("latin1").replace(/\0+$/, "");
  if (characterSet !== "UTF8") throw unsupportedFeature(`Unsupported tablespace character set: ${characterSet}.`);
  const nameLength = page.readUInt16LE(32);
  const serverLength = page.readUInt16LE(34);
  if (nameLength === 0 || nameLength > 512 || serverLength === 0 || serverLength > 64 || page[624]! > 1) {
    throw corrupt("Invalid tablespace header fields.");
  }
  const name = decodeText(page.subarray(40, 40 + nameLength));
  const serverVersion = decodeText(page.subarray(552, 552 + serverLength));
  const createdAt = Number(page.readBigInt64LE(616));
  if ([...name].length > 128 || name.includes("\0") || serverVersion.includes("\0") || !Number.isSafeInteger(createdAt)) {
    throw corrupt("Invalid tablespace header fields.");
  }
  const pageCount = page.readUInt32LE(640);
  const catalogRoot = page.readUInt32LE(632);
  const freeListHead = page.readUInt32LE(636);
  if (pageCount === 0 || catalogRoot >= pageCount || freeListHead >= pageCount) {
    throw corrupt("Invalid tablespace root pointers.");
  }
  return { formatVersion: 1, pageSize: PAGE_SIZE, characterSet, name, createdAt, serverVersion,
    cleanShutdown: page[624] === 1, catalogRoot, freeListHead, pageCount };
}
