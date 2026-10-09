/**
 * 값의 저장 형식.
 *
 * 담당
 *  - 값을 데이터 파일에 넣는 바이트열로 바꾸고, 다시 값으로 되돌린다. (행 인코딩)
 *  - 인덱스 키 형식 : 바이트열을 그대로 비교한 순서가 값의 정렬 순서와 같아야 한다.
 *    복합 컬럼, ASC 와 DESC, NULL 의 순서를 여기서 푼다.
 *  - 문자열은 UTF-8 로 저장한다. 올바르지 않은 UTF-8 은 오류이다.
 *
 * 통신용 값 표현(JSON)은 여기가 아니라 net/protocol.ts 가 맡는다.
 * 저장 형식은 포맷 버전에 묶이므로, 바꿀 때는 storage/format 의 버전 규칙을 따른다.
 * RDBMS 1.0 출시 전에는 개요 3의 예외에 따라 포맷 번호를 유지한 변경이 가능하다.
 * 이 경우에도 저장 포맷 문서와 테스트 자료를 함께 갱신한다.
 *
 * 바이트 단위의 형식은 docs/storage-v1.md 의 "행과 인덱스 키의 값 인코딩" 에 적었다.
 * 여기로 들어오는 값은 이미 타입에 맞춘 값(conformValue 를 거친 값)이어야 한다.
 *
 * 관련 사양 : AGENTS.md 상세 1-1, 2, 3
 * 구현 단계 : 3단계
 */

import { internalError } from "../common/errors.js";
import type { DataType, DecimalDataType } from "./dataType.js";
import { DateValue, IntervalValue, TimestampValue, TimeValue } from "./datetime.js";
import { corruptValue, invalidCharacterEncoding } from "./errors.js";
import { Decimal, fitDecimal } from "./numeric.js";
import { assertWellFormedString, codePointLength, trimTrailingSpaces } from "./value.js";
import type { NonNullValue, SqlValue } from "./value.js";

// ---------------------------------------------------------------------------
// UTF-8
// ---------------------------------------------------------------------------

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** UTF-8 바이트열을 문자열로 바꾼다. 올바르지 않은 바이트열이면 22021 이다. */
export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw invalidCharacterEncoding("Invalid UTF-8 byte sequence.");
  }
}

/** 문자열을 UTF-8 바이트열로 바꾼다. 짝이 맞지 않는 서러게이트가 있으면 22021 이다. */
export function encodeUtf8(text: string): Buffer {
  assertWellFormedString(text);
  return Buffer.from(text, "utf8");
}

// ---------------------------------------------------------------------------
// 바이트 쓰기와 읽기
// ---------------------------------------------------------------------------

class ByteWriter {
  private buffer: Buffer = Buffer.allocUnsafe(128);
  private length = 0;

  get position(): number {
    return this.length;
  }

  /** size 바이트를 확보하고 그 시작 위치를 돌려준다. 내용은 호출자가 채운다. */
  reserve(size: number): number {
    const start = this.length;
    const needed = start + size;
    if (needed > this.buffer.length) {
      const grown = Buffer.allocUnsafe(Math.max(needed, this.buffer.length * 2));
      this.buffer.copy(grown, 0, 0, start);
      this.buffer = grown;
    }
    this.length = needed;
    return start;
  }

  /** 지금 쓰고 있는 버퍼. reserve 를 부르면 바뀔 수 있다. */
  get target(): Buffer {
    return this.buffer;
  }

  byte(value: number): void {
    const offset = this.reserve(1);
    this.buffer[offset] = value;
  }

  bytes(source: Uint8Array): void {
    const offset = this.reserve(source.length);
    this.buffer.set(source, offset);
  }

  zeros(size: number): number {
    const offset = this.reserve(size);
    this.buffer.fill(0, offset, offset + size);
    return offset;
  }

  // 고정 폭 쓰기. 자리를 먼저 확보한 뒤에 버퍼를 잡아야 재할당된 버퍼에 쓴다.
  int16LE(value: number): void {
    const offset = this.reserve(2);
    this.buffer.writeInt16LE(value, offset);
  }

  int32LE(value: number): void {
    const offset = this.reserve(4);
    this.buffer.writeInt32LE(value, offset);
  }

  int64LE(value: bigint): void {
    const offset = this.reserve(8);
    this.buffer.writeBigInt64LE(value, offset);
  }

  floatLE(value: number): void {
    const offset = this.reserve(4);
    this.buffer.writeFloatLE(value, offset);
  }

  doubleLE(value: number): void {
    const offset = this.reserve(8);
    this.buffer.writeDoubleLE(value, offset);
  }

  /** 부호 없는 가변 길이 정수 (LEB128). */
  varUint(value: number): void {
    let rest = value;
    while (rest >= 0x80) {
      this.byte((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.byte(rest);
  }

  /** [start, end) 의 모든 비트를 뒤집는다. */
  invert(start: number, end: number): void {
    for (let i = start; i < end; i++) {
      this.buffer[i] = ~(this.buffer[i] as number) & 0xff;
    }
  }

  finish(): Buffer {
    return Buffer.from(this.buffer.subarray(0, this.length));
  }
}

class ByteReader {
  private readonly data: Buffer;
  private offset = 0;

  constructor(data: Buffer) {
    this.data = data;
  }

  get atEnd(): boolean {
    return this.offset === this.data.length;
  }

  /** size 바이트를 읽을 수 있는지 확인하고 그 시작 위치를 돌려준다. */
  take(size: number): number {
    const start = this.offset;
    if (size < 0 || start + size > this.data.length) {
      throw corruptValue("Stored row is truncated.");
    }
    this.offset = start + size;
    return start;
  }

  get source(): Buffer {
    return this.data;
  }

  byte(): number {
    return this.data[this.take(1)] as number;
  }

  bytes(size: number): Buffer {
    const start = this.take(size);
    return this.data.subarray(start, start + size);
  }

  varUint(): number {
    let result = 0;
    let scale = 1;
    // 7바이트(49비트)까지만 받는다. 그보다 긴 길이 필드는 손상된 것이다.
    for (let i = 0; i < 7; i++) {
      const byte = this.byte();
      result += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return result;
      scale *= 0x80;
    }
    throw corruptValue("Stored row has an invalid length field.");
  }
}

// ---------------------------------------------------------------------------
// 정수의 바이트 표현
// ---------------------------------------------------------------------------

/** 2의 보수로 담는 데 필요한 최소 바이트 수. 0 은 0 바이트이다. */
function signedByteLength(value: bigint): number {
  if (value === 0n) return 0;
  let bytes = 1;
  let limit = 128n;
  while (value >= limit || value < -limit) {
    bytes++;
    limit <<= 8n;
  }
  return bytes;
}

/** 길이(1바이트) 뒤에 리틀 엔디언 2의 보수를 최소 길이로 적는다. */
function writeCompactBigInt(writer: ByteWriter, value: bigint): void {
  const size = signedByteLength(value);
  if (size > 255) throw internalError("Integer value is too large to store.");
  writer.byte(size);
  const offset = writer.reserve(size);
  let rest = BigInt.asUintN(size * 8, value);
  for (let i = 0; i < size; i++) {
    writer.target[offset + i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
}

function readCompactBigInt(reader: ByteReader): bigint {
  const size = reader.byte();
  const start = reader.take(size);
  let result = 0n;
  for (let i = size - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(reader.source[start + i] as number);
  }
  return BigInt.asIntN(size * 8, result);
}

/**
 * 부호 있는 정수를 size 바이트의 빅 엔디언으로 적되 부호 비트를 뒤집는다.
 * 이렇게 적은 바이트열은 그대로 비교한 순서가 수의 순서와 같다.
 */
function writeOrderedBigInt(writer: ByteWriter, value: bigint, size: number): void {
  const bits = size * 8;
  const limit = 1n << BigInt(bits - 1);
  if (value >= limit || value < -limit) {
    throw internalError("Integer value does not fit in its index key width.");
  }
  let rest = BigInt.asUintN(bits, value) ^ limit;
  const offset = writer.reserve(size);
  for (let i = size - 1; i >= 0; i--) {
    writer.target[offset + i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
}

// ---------------------------------------------------------------------------
// 값을 꺼내는 도우미
// ---------------------------------------------------------------------------

function mismatch(type: DataType): Error {
  return internalError(`Value does not match SQL type ${type.name} in the storage codec.`);
}

/** DECIMAL 값을 타입의 소수 자릿수에 맞춘 unscaled 정수로 바꾼다. */
function decimalUnscaled(value: NonNullValue, type: DecimalDataType): bigint {
  if (!(value instanceof Decimal)) throw mismatch(type);
  return value.scale === type.scale ? value.unscaled : fitDecimal(value, type.precision, type.scale).unscaled;
}

// ---------------------------------------------------------------------------
// 행 인코딩
// ---------------------------------------------------------------------------

function writeLengthPrefixed(writer: ByteWriter, bytes: Uint8Array): void {
  writer.varUint(bytes.length);
  writer.bytes(bytes);
}

function writeRowValue(writer: ByteWriter, value: NonNullValue, type: DataType): void {
  switch (type.kind) {
    case "CHAR": {
      if (typeof value !== "string") throw mismatch(type);
      // 채움 공백은 저장하지 않고 읽을 때 다시 채운다.
      writeLengthPrefixed(writer, encodeUtf8(trimTrailingSpaces(value)));
      return;
    }
    case "VARCHAR": {
      if (typeof value !== "string") throw mismatch(type);
      writeLengthPrefixed(writer, encodeUtf8(value));
      return;
    }
    case "BINARY":
    case "VARBINARY": {
      if (!Buffer.isBuffer(value)) throw mismatch(type);
      writeLengthPrefixed(writer, value);
      return;
    }
    case "INTEGER": {
      if (typeof value !== "bigint") throw mismatch(type);
      if (type.bits === 16) writer.int16LE(Number(value));
      else if (type.bits === 32) writer.int32LE(Number(value));
      else writer.int64LE(value);
      return;
    }
    case "DECIMAL": {
      writeCompactBigInt(writer, decimalUnscaled(value, type));
      return;
    }
    case "FLOAT": {
      if (typeof value !== "number") throw mismatch(type);
      if (type.bits === 32) writer.floatLE(value);
      else writer.doubleLE(value);
      return;
    }
    case "BOOLEAN": {
      if (typeof value !== "boolean") throw mismatch(type);
      writer.byte(value ? 1 : 0);
      return;
    }
    case "DATE": {
      if (!(value instanceof DateValue)) throw mismatch(type);
      writer.int32LE(value.days);
      return;
    }
    case "TIME": {
      if (!(value instanceof TimeValue) || (value.offsetMinutes !== null) !== type.withTimeZone) throw mismatch(type);
      writer.int64LE(BigInt(value.micros));
      if (value.offsetMinutes !== null) writer.int16LE(value.offsetMinutes);
      return;
    }
    case "TIMESTAMP": {
      if (!(value instanceof TimestampValue) || (value.offsetMinutes !== null) !== type.withTimeZone) throw mismatch(type);
      writer.int64LE(value.micros);
      if (value.offsetMinutes !== null) writer.int16LE(value.offsetMinutes);
      return;
    }
    case "INTERVAL": {
      if (!(value instanceof IntervalValue)) throw mismatch(type);
      writeCompactBigInt(writer, value.intervalClass === "YEAR_MONTH" ? BigInt(value.months) : value.micros);
      return;
    }
  }
}

function readString(reader: ByteReader): string {
  const bytes = reader.bytes(reader.varUint());
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw corruptValue("Stored character value is not valid UTF-8.");
  }
}

function readRowValue(reader: ByteReader, type: DataType): NonNullValue {
  switch (type.kind) {
    case "CHAR": {
      const text = readString(reader);
      const missing = type.length - codePointLength(text);
      return missing > 0 ? text + " ".repeat(missing) : text;
    }
    case "VARCHAR":
      return readString(reader);
    case "BINARY":
    case "VARBINARY":
      return Buffer.from(reader.bytes(reader.varUint()));
    case "INTEGER": {
      const offset = reader.take(type.bits / 8);
      if (type.bits === 16) return BigInt(reader.source.readInt16LE(offset));
      if (type.bits === 32) return BigInt(reader.source.readInt32LE(offset));
      return reader.source.readBigInt64LE(offset);
    }
    case "DECIMAL":
      return new Decimal(readCompactBigInt(reader), type.scale);
    case "FLOAT": {
      const offset = reader.take(type.bits / 8);
      return type.bits === 32 ? reader.source.readFloatLE(offset) : reader.source.readDoubleLE(offset);
    }
    case "BOOLEAN": {
      const byte = reader.byte();
      if (byte > 1) throw corruptValue("Stored boolean value is invalid.");
      return byte === 1;
    }
    case "DATE":
      return new DateValue(reader.source.readInt32LE(reader.take(4)));
    case "TIME": {
      const micros = Number(reader.source.readBigInt64LE(reader.take(8)));
      return new TimeValue(micros, type.withTimeZone ? reader.source.readInt16LE(reader.take(2)) : null);
    }
    case "TIMESTAMP": {
      const micros = reader.source.readBigInt64LE(reader.take(8));
      return new TimestampValue(micros, type.withTimeZone ? reader.source.readInt16LE(reader.take(2)) : null);
    }
    case "INTERVAL": {
      const amount = readCompactBigInt(reader);
      if (type.startField === "YEAR" || type.startField === "MONTH") {
        return IntervalValue.yearMonth(Number(amount));
      }
      return IntervalValue.dayTime(amount);
    }
  }
}

/**
 * 행 하나를 바이트열로 바꾼다. values 와 types 는 테이블의 컬럼 순서이다.
 *
 * 형식 : 컬럼 수(가변 길이 정수), NULL 비트맵(컬럼 i 는 i/8 번째 바이트의 i%8 번째 비트, 1 이면 NULL),
 *        NULL 이 아닌 컬럼의 값을 순서대로.
 */
export function encodeRow(values: readonly SqlValue[], types: readonly DataType[]): Buffer {
  if (values.length !== types.length) {
    throw internalError("Row value count does not match the column count.");
  }
  const writer = new ByteWriter();
  writer.varUint(values.length);
  const bitmap = writer.zeros(Math.ceil(values.length / 8));
  for (let i = 0; i < values.length; i++) {
    const value = values[i] as SqlValue;
    if (value === null) {
      writer.target[bitmap + (i >> 3)] = (writer.target[bitmap + (i >> 3)] as number) | (1 << (i & 7));
    } else {
      writeRowValue(writer, value, types[i] as DataType);
    }
  }
  return writer.finish();
}

/**
 * 저장된 행을 값으로 되돌린다.
 * 저장된 컬럼 수가 types 보다 적으면 모자란 뒤쪽 컬럼은 NULL 이다. 더 많거나 바이트가 남으면 XX001 이다.
 */
export function decodeRow(data: Buffer, types: readonly DataType[]): SqlValue[] {
  const reader = new ByteReader(data);
  const stored = reader.varUint();
  if (stored > types.length) {
    throw corruptValue("Stored row has more columns than its table definition.");
  }
  const bitmap = reader.bytes(Math.ceil(stored / 8));
  const values: SqlValue[] = new Array<SqlValue>(types.length).fill(null);
  for (let i = 0; i < stored; i++) {
    if (((bitmap[i >> 3] as number) & (1 << (i & 7))) === 0) {
      values[i] = readRowValue(reader, types[i] as DataType);
    }
  }
  if (!reader.atEnd) {
    throw corruptValue("Stored row has trailing bytes.");
  }
  return values;
}

// ---------------------------------------------------------------------------
// 인덱스 키 인코딩
// ---------------------------------------------------------------------------

/** 인덱스 키를 이루는 컬럼 하나. */
export interface KeyColumn {
  type: DataType;
  descending?: boolean;
}

/** NULL 은 가장 큰 값이므로 표시 바이트가 NULL 아닌 값보다 크다. */
const KEY_NOT_NULL = 0x00;
const KEY_NULL = 0x01;

/**
 * 바이트열을 끝 표시와 함께 적는다. 본문의 0x00 은 `00 FF` 로, 끝은 `00 00` 으로 적는다.
 * 짧은 쪽이 앞서는 사전식 순서가 그대로 유지된다.
 */
function writeTerminatedBytes(writer: ByteWriter, bytes: Uint8Array): void {
  let zeros = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) zeros++;
  }
  let offset = writer.reserve(bytes.length + zeros + 2);
  const target = writer.target;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number;
    target[offset++] = byte;
    if (byte === 0) target[offset++] = 0xff;
  }
  target[offset++] = 0x00;
  target[offset] = 0x00;
}

/** DECIMAL 의 키 폭. 정밀도 p 의 모든 값이 부호 있는 정수로 들어가는 가장 작은 폭이다. */
function decimalKeyWidth(precision: number): number {
  if (precision <= 2) return 1;
  if (precision <= 4) return 2;
  if (precision <= 9) return 4;
  return precision <= 18 ? 8 : 16;
}

function writeKeyValue(writer: ByteWriter, value: NonNullValue, type: DataType): void {
  switch (type.kind) {
    case "CHAR": {
      if (typeof value !== "string") throw mismatch(type);
      // CHAR 끼리는 뒤쪽 공백을 무시하고 비교하므로 공백을 떼고 적는다.
      writeTerminatedBytes(writer, encodeUtf8(trimTrailingSpaces(value)));
      return;
    }
    case "VARCHAR": {
      if (typeof value !== "string") throw mismatch(type);
      writeTerminatedBytes(writer, encodeUtf8(value));
      return;
    }
    case "BINARY":
    case "VARBINARY": {
      if (!Buffer.isBuffer(value)) throw mismatch(type);
      writeTerminatedBytes(writer, value);
      return;
    }
    case "INTEGER": {
      if (typeof value !== "bigint") throw mismatch(type);
      writeOrderedBigInt(writer, value, type.bits / 8);
      return;
    }
    case "DECIMAL": {
      writeOrderedBigInt(writer, decimalUnscaled(value, type), decimalKeyWidth(type.precision));
      return;
    }
    case "FLOAT": {
      if (typeof value !== "number" || Number.isNaN(value)) throw mismatch(type);
      const size = type.bits / 8;
      const offset = writer.reserve(size);
      const target = writer.target;
      // 음의 0 은 0 과 같은 키가 되어야 한다.
      const normalized = value === 0 ? 0 : value;
      if (size === 4) target.writeFloatBE(normalized, offset);
      else target.writeDoubleBE(normalized, offset);
      if (((target[offset] as number) & 0x80) === 0) {
        // 양수 : 부호 비트만 세워 음수보다 뒤에 오게 한다.
        target[offset] = (target[offset] as number) | 0x80;
      } else {
        // 음수 : 절대값이 클수록 앞에 오도록 모든 비트를 뒤집는다.
        writer.invert(offset, offset + size);
      }
      return;
    }
    case "BOOLEAN": {
      if (typeof value !== "boolean") throw mismatch(type);
      writer.byte(value ? 1 : 0);
      return;
    }
    case "DATE": {
      if (!(value instanceof DateValue)) throw mismatch(type);
      writeOrderedBigInt(writer, BigInt(value.days), 4);
      return;
    }
    case "TIME": {
      if (!(value instanceof TimeValue) || (value.offsetMinutes !== null) !== type.withTimeZone) throw mismatch(type);
      // 타임존이 있어도 비교는 UTC 기준 시각으로만 하므로 오프셋은 키에 넣지 않는다.
      writeOrderedBigInt(writer, BigInt(value.micros), 8);
      return;
    }
    case "TIMESTAMP": {
      if (!(value instanceof TimestampValue) || (value.offsetMinutes !== null) !== type.withTimeZone) throw mismatch(type);
      writeOrderedBigInt(writer, value.micros, 8);
      return;
    }
    case "INTERVAL": {
      if (!(value instanceof IntervalValue)) throw mismatch(type);
      if (value.intervalClass === "YEAR_MONTH") writeOrderedBigInt(writer, BigInt(value.months), 8);
      else writeOrderedBigInt(writer, value.micros, 12);
      return;
    }
  }
}

/**
 * 인덱스 키를 만든다. 결과 바이트열을 그대로 비교한 순서가 컬럼별 정렬 순서(ASC, DESC)와 같다.
 *  - NULL 은 가장 큰 값이다. ASC 에서는 마지막, DESC 에서는 처음에 온다.
 *  - values 가 columns 보다 짧으면 앞쪽 컬럼만으로 된 접두 키를 만든다. (범위 탐색용)
 *
 * 형식 : 컬럼마다 표시 바이트(00 값 있음, 01 NULL)와 값. DESC 컬럼은 그 컬럼의 모든 비트를 뒤집는다.
 */
export function encodeKey(values: readonly SqlValue[], columns: readonly KeyColumn[]): Buffer {
  if (values.length > columns.length) {
    throw internalError("Index key has more values than the index has columns.");
  }
  const writer = new ByteWriter();
  for (let i = 0; i < values.length; i++) {
    const value = values[i] as SqlValue;
    const column = columns[i] as KeyColumn;
    const start = writer.position;
    if (value === null) {
      writer.byte(KEY_NULL);
    } else {
      writer.byte(KEY_NOT_NULL);
      writeKeyValue(writer, value, column.type);
    }
    if (column.descending === true) {
      writer.invert(start, writer.position);
    }
  }
  return writer.finish();
}

/**
 * 접두 키로 시작하는 모든 키보다 큰 가장 작은 바이트열을 만든다. 범위 탐색의 배타적 상한으로 쓴다.
 * 그런 바이트열이 없으면(접두 키가 비었거나 모두 FF 이면) null 이며, 상한 없이 끝까지 읽으면 된다.
 */
export function prefixUpperBound(prefix: Buffer): Buffer | null {
  let end = prefix.length;
  while (end > 0 && prefix[end - 1] === 0xff) end--;
  if (end === 0) return null;
  const bound = Buffer.from(prefix.subarray(0, end));
  bound[end - 1] = (bound[end - 1] as number) + 1;
  return bound;
}
