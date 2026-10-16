/**
 * 결과와 파라미터의 JSON 변환. 서버 전용이다.
 *
 * 담당
 *  - `SqlValue` → JSON 값 : BIGINT, NUMERIC, 날짜시간, INTERVAL 은 문자열, 이진 값은 16진 문자열,
 *    SMALLINT·INTEGER·REAL·DOUBLE 은 JSON 숫자, BOOLEAN 은 true/false, NULL 은 null.
 *    문자열 표기는 types/value.ts 의 `formatValue` 를 그대로 쓴다.
 *  - `DataType` → 컬럼 메타데이터(`ColumnMeta`)
 *  - 파라미터 JSON → `SqlValue` : `execute.params` 를 세션이 받는 값으로 바꾼다.
 *  - 행 묶음 만들기 : 행을 하나씩 JSON 으로 인코딩해 쌓다가 행 수나 크기 한도에서 멈춘다.
 *
 * 서버와 클라이언트가 함께 쓰는 protocol.ts 에는 타입 시스템을 들이지 않기 위해 이 모듈을 따로 두었다.
 * 규칙의 표는 docs/protocol.md 에 있다.
 *
 * 관련 사양 : AGENTS.md 상세 8
 * 구현 단계 : 9단계 (9-1)
 */

import { DbError, ERROR_CODES } from "../common/errors.js";
import type { DataType } from "../types/dataType.js";
import { formatDataType } from "../types/dataType.js";
import { numericOutOfRange } from "../types/errors.js";
import { formatValue, parseHex } from "../types/value.js";
import type { SqlValue } from "../types/value.js";
import { MESSAGE_ENVELOPE_RESERVE, MAX_MESSAGE_BYTES } from "./protocol.js";
import type { ColumnMeta, JsonValue, ParamValue } from "./protocol.js";

// ---------------------------------------------------------------------------
// 값 → JSON
// ---------------------------------------------------------------------------

/** 값을 프로토콜의 JSON 표현으로 바꾼다. 실제 타입은 컬럼 메타데이터에 있다. */
export function encodeValue(value: SqlValue, type: DataType): JsonValue {
  if (value === null) return null;
  switch (type.kind) {
    case "BOOLEAN":
      if (typeof value === "boolean") return value;
      break;
    case "INTEGER":
      // 16, 32비트는 JSON 숫자로 정확히 표현된다. 64비트는 문자열이다.
      if (typeof value === "bigint") return type.bits === 64 ? value.toString() : Number(value);
      break;
    case "FLOAT":
      // NaN 과 무한대는 값이 될 수 없다. 혹시 들어오면 JSON 이 null 로 바꾸기 전에 막는다.
      if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, "Non-finite floating-point value in a result.");
        return value;
      }
      break;
    default:
      return formatValue(value, type);
  }
  return formatValue(value, type);
}

/** 컬럼의 메타데이터를 만든다. */
export function columnMeta(name: string, type: DataType): ColumnMeta {
  const meta: ColumnMeta = { name, typeName: type.name, declared: formatDataType(type) };
  switch (type.kind) {
    case "CHAR":
    case "VARCHAR":
    case "BINARY":
    case "VARBINARY":
      meta.length = type.length;
      break;
    case "DECIMAL":
      meta.precision = type.precision;
      meta.scale = type.scale;
      break;
    case "TIME":
    case "TIMESTAMP":
      meta.fractionalPrecision = type.fractionalPrecision;
      break;
    case "INTERVAL":
      meta.startField = type.startField;
      meta.endField = type.endField;
      meta.leadingPrecision = type.leadingPrecision;
      if (type.fractionalPrecision !== null) meta.fractionalPrecision = type.fractionalPrecision;
      break;
    default:
      break;
  }
  return meta;
}

/** 행 하나를 JSON 배열 본문으로 바꾼다. */
export function encodeRow(row: readonly SqlValue[], types: readonly DataType[]): string {
  const encoded: JsonValue[] = new Array<JsonValue>(row.length);
  for (let i = 0; i < row.length; i++) {
    encoded[i] = encodeValue(row[i] as SqlValue, types[i] as DataType);
  }
  return JSON.stringify(encoded);
}

// ---------------------------------------------------------------------------
// 행 묶음
// ---------------------------------------------------------------------------

export interface RowBatch {
  /** 행마다 이미 인코딩된 JSON 배열 문자열이다. 메시지에 그대로 이어 붙인다. */
  encodedRows: string[];
  /** 다음 묶음이 시작할 행 번호이다. */
  next: number;
}

/**
 * `start` 행부터 묶음을 만든다. `maxRows` 행이나 `softBytes` 바이트를 넘기기 직전에 멈추며, 묶음에는 항상 행이 하나 이상 들어간다.
 * `reserve` 는 메시지 봉투와 컬럼 정보가 쓸 바이트이다. 행 하나만으로 한 메시지에 들어가지 않으면 54000 이다.
 */
export function encodeBatch(
  rows: readonly (readonly SqlValue[])[],
  types: readonly DataType[],
  start: number,
  maxRows: number,
  softBytes: number,
  reserve: number = MESSAGE_ENVELOPE_RESERVE,
): RowBatch {
  const encodedRows: string[] = [];
  let bytes = 0;
  let index = start;
  while (index < rows.length && encodedRows.length < maxRows) {
    const text = encodeRow(rows[index] as readonly SqlValue[], types);
    // 한 글자가 UTF-8 로 최대 3바이트(서러게이트 쌍은 4바이트)이므로 정확한 길이를 센다.
    const size = Buffer.byteLength(text, "utf8") + 1;
    if (encodedRows.length === 0 && size + reserve > MAX_MESSAGE_BYTES) {
      throw new DbError(
        "54000",
        ERROR_CODES.LIMIT_EXCEEDED,
        `A result row is too large for one message: ${size} bytes (limit ${MAX_MESSAGE_BYTES - reserve}).`,
      );
    }
    if (encodedRows.length > 0 && bytes + size > softBytes) break;
    encodedRows.push(text);
    bytes += size;
    index++;
  }
  return { encodedRows, next: index };
}

// ---------------------------------------------------------------------------
// 파라미터 JSON → 값
// ---------------------------------------------------------------------------

/**
 * `execute.params` 를 세션이 받는 값으로 바꾼다. 문자열은 타입 없는 문자열이라 세션이 문맥 타입으로 해석한다.
 *  - `null` → NULL, `true`/`false` → BOOLEAN
 *  - 정수 숫자 → `bigint`. 안전 정수 범위(±2^53-1)를 넘으면 정밀도를 잃었을 수 있으므로 22003 으로 거부한다.
 *  - 소수 숫자 → `number`(배정도)
 *  - 문자열 → 문자열. BIGINT, NUMERIC, 날짜시간은 문자열로 보내는 것이 정확하다.
 *  - `{ "binary": "AB12" }` → `Buffer`. 16진 문자열이 아니면 22018 이다.
 */
export function decodeParams(params: readonly ParamValue[]): SqlValue[] {
  return params.map((param, index) => decodeParam(param, index));
}

function decodeParam(param: ParamValue, index: number): SqlValue {
  if (param === null) return null;
  if (typeof param === "boolean" || typeof param === "string") return param;
  if (typeof param === "number") {
    if (!Number.isInteger(param)) return param;
    if (!Number.isSafeInteger(param)) {
      throw numericOutOfRange(
        `Parameter ${index + 1} is an integer outside the safe range of a JSON number; send it as a string.`,
      );
    }
    return BigInt(param);
  }
  return parseHex(param.binary);
}
