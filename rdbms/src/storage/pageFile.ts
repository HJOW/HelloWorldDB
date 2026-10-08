/**
 * 페이지 단위 파일 입출력.
 *
 * 담당
 *  - 데이터 파일을 고정 크기 페이지(8KB)의 나열로 다룬다.
 *  - 페이지 번호로 읽기와 쓰기, 파일 늘리기, 디스크 반영(fsync), 열기와 닫기
 *
 * 페이지 안에 무엇이 들어 있는지는 모른다. 내용의 해석은 format/ 의 몫이다.
 * 테이블스페이스 하나가 데이터 파일 하나이므로, 이 모듈의 인스턴스 하나가 테이블스페이스 하나에 대응한다.
 *
 * 관련 사양 : AGENTS.md 상세 3
 * 구현 단계 : 2단계
 */

import fs from "node:fs";
import { argument, corrupt, storageIO, uint } from "./errors.js";

export const PAGE_SIZE = 8192;

/** 파일 내용의 해석 없이 완전한 페이지를 읽고 쓴다. */
export class PageFile {
  private closed = false;
  private constructor(readonly filePath: string, private readonly fd: number) {}

  static create(filePath: string): PageFile {
    try { return new PageFile(filePath, fs.openSync(filePath, "wx+", 0o600)); }
    catch (error) { throw storageIO(`Cannot create data file: ${filePath}`, error); }
  }

  static open(filePath: string): PageFile {
    try { return new PageFile(filePath, fs.openSync(filePath, "r+")); }
    catch (error) { throw storageIO(`Cannot open data file: ${filePath}`, error); }
  }

  get byteLength(): number {
    this.checkOpen();
    try { return fs.fstatSync(this.fd).size; }
    catch (error) { throw storageIO("Cannot stat data file.", error); }
  }

  get pageCount(): number {
    const bytes = this.byteLength;
    if (bytes % PAGE_SIZE !== 0) throw corrupt("Data file contains a partial page.");
    return bytes / PAGE_SIZE;
  }

  readPrefix(length: number): Buffer {
    uint(length, PAGE_SIZE);
    return this.readAt(length, 0);
  }

  readPage(pageId: number): Buffer {
    uint(pageId);
    if (pageId >= this.pageCount) throw corrupt("Page is outside the data file.");
    return this.readAt(PAGE_SIZE, pageId * PAGE_SIZE);
  }

  writePage(pageId: number, page: Buffer): void {
    this.checkOpen();
    uint(pageId);
    if (page.length !== PAGE_SIZE) throw argument("Page must contain exactly 8192 bytes.");
    if (pageId > this.pageCount) throw argument("Cannot leave gaps in a data file.");
    let written = 0;
    try {
      while (written < PAGE_SIZE) {
        const count = fs.writeSync(this.fd, page, written, PAGE_SIZE - written, pageId * PAGE_SIZE + written);
        if (count === 0) throw storageIO("Data file write made no progress.");
        written += count;
      }
    } catch (error) { throw storageIO("Cannot write data page.", error); }
  }

  sync(): void {
    this.checkOpen();
    try { fs.fsyncSync(this.fd); }
    catch (error) { throw storageIO("Cannot sync data file.", error); }
  }

  close(): void {
    if (this.closed) return;
    try { fs.closeSync(this.fd); }
    catch (error) { throw storageIO("Cannot close data file.", error); }
    finally { this.closed = true; }
  }

  private readAt(length: number, position: number): Buffer {
    this.checkOpen();
    const result = Buffer.alloc(length);
    let read = 0;
    try {
      while (read < length) {
        const count = fs.readSync(this.fd, result, read, length - read, position + read);
        if (count === 0) throw corrupt("Unexpected end of data file.");
        read += count;
      }
    } catch (error) {
      if (error instanceof Error && error.name === "DbError") throw error;
      throw storageIO("Cannot read data page.", error);
    }
    return result;
  }

  private checkOpen(): void {
    if (this.closed) throw argument("Data file is closed.");
  }
}
