/** 실행 시점의 결과를 임시 파일에 보관한다. 커서가 끝나면 파일·핸들을 정리한다. 상세 8-2. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeRow, decodeRow } from "../types/codec.js";
import type { DataType } from "../types/dataType.js";
import type { SqlValue } from "../types/value.js";

export class RowSpool {
  readonly directory = fs.mkdtempSync(path.join(os.tmpdir(), "hwdb-result-"));
  private readonly file = path.join(this.directory, "rows.bin");
  private fd = fs.openSync(this.file, "wx+", 0o600);
  private types: readonly DataType[] = [];
  private count = 0;
  private position = 0;
  private nextIndex = 0;
  private cached: { index: number; row: SqlValue[] } | undefined;
  constructor(private readonly onClose: () => void) {}

  append(row: readonly SqlValue[], types: readonly DataType[]): void {
    if (this.count === 0) this.types = types;
    const bytes = encodeRow(row, this.types);
    const header = Buffer.allocUnsafe(4); header.writeUInt32BE(bytes.length);
    fs.writeSync(this.fd, header); fs.writeSync(this.fd, bytes);
    this.count++;
  }

  private read(index: number): SqlValue[] | undefined {
    if (index >= this.count) return undefined;
    if (this.cached?.index === index) return this.cached.row;
    if (index < this.nextIndex) { this.position = 0; this.nextIndex = 0; }
    while (this.nextIndex <= index) {
      const header = Buffer.allocUnsafe(4);
      if (fs.readSync(this.fd, header, 0, 4, this.position) !== 4) throw new Error("Truncated result spool.");
      const size = header.readUInt32BE(); const bytes = Buffer.allocUnsafe(size);
      let read = 0;
      while (read < size) {
        const amount = fs.readSync(this.fd, bytes, read, size - read, this.position + 4 + read);
        if (amount === 0) throw new Error("Truncated result spool.");
        read += amount;
      }
      this.position += 4 + size;
      this.cached = { index: this.nextIndex++, row: decodeRow(bytes, this.types) };
    }
    return this.cached!.row;
  }

  /** 봉투/커서 계층의 배열 인터페이스를 유지하되 행은 필요할 때 하나씩 읽는다. */
  rows(): SqlValue[][] {
    const rows = new Array<SqlValue[]>(this.count);
    const isIndex = (key: PropertyKey): key is string => typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key);
    return new Proxy(rows, {
      get: (target, key, receiver) => isIndex(key) ? this.read(Number(key)) : Reflect.get(target, key, receiver),
      has: (target, key) => isIndex(key) ? Number(key) < this.count : Reflect.has(target, key),
    });
  }

  close(): void {
    if (this.fd < 0) return;
    const fd = this.fd; this.fd = -1;
    try { fs.closeSync(fd); }
    finally { try { fs.unlinkSync(this.file); } finally { try { fs.rmdirSync(this.directory); } finally { this.onClose(); } } }
  }
}
