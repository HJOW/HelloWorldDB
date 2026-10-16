/**
 * 값의 변환 : 서버가 보내는 JSON 값 ↔ JavaScript 값.
 *
 * 담당
 *  - 결과의 값을 컬럼 메타데이터의 타입 이름에 따라 JavaScript 값으로 바꾼다 (`decodeValue`).
 *  - 파라미터로 넘긴 JavaScript 값을 서버가 받는 JSON 값으로 바꾼다 (`encodeParam`).
 *
 * 타입 대응 (AGENTS.md 구현 계획 12 의 "타입 대응")
 *
 * | DB 타입 | JavaScript 값 |
 * |---|---|
 * | CHAR, VARCHAR | `string` |
 * | BINARY, VARBINARY | `Buffer` |
 * | SMALLINT, INTEGER | `number` |
 * | BIGINT | `bigint` |
 * | NUMERIC, DECIMAL | `string` (자릿수를 잃지 않기 위함) |
 * | REAL, DOUBLE PRECISION, FLOAT | `number` |
 * | BOOLEAN | `boolean` |
 * | DATE, TIME, TIMESTAMP, INTERVAL (WITH TIME ZONE 포함) | `string` (`Date` 는 마이크로초를 담지 못한다) |
 * | NULL | `null` |
 *
 * 파라미터는 위 표의 값에 더해 `Date`, `Uint8Array` 를 받는다. (`Date` 는 UTC 시각을 가리키는 ISO 8601 문자열로 보낸다)
 * 안전 정수 범위를 넘는 정수는 JSON 숫자로 보내면 정밀도를 잃으므로 문자열로 보낸다. (서버는 그 범위를 넘는 JSON 숫자를 22003 으로 거부한다)
 *
 * 관련 사양 : AGENTS.md 상세 8 / rdbms/docs/protocol.md 8, 9절
 * 구현 단계 : 12-4
 */

import type { ColumnMeta, JsonValue, ParamValue } from "./protocol/messages.js";

/** 결과의 컬럼 값이다. */
export type Value = null | string | number | bigint | boolean | Buffer;

/** 파라미터로 줄 수 있는 JavaScript 값이다. `undefined` 는 NULL 로 본다. */
export type Param = null | undefined | boolean | number | bigint | string | Date | Buffer | Uint8Array;

/** 컬럼 하나의 메타데이터이다. */
export type Column = ColumnMeta;

/** 결과의 행 하나이다. 컬럼 순서의 배열이다. */
export type Row = Value[];

/** 서버가 보낸 값 하나를 컬럼의 타입에 맞는 JavaScript 값으로 바꾼다. 모르는 타입은 JSON 값 그대로 돌려준다. */
export function decodeValue(raw: JsonValue, column: ColumnMeta): Value {
  if (raw === null) return null;
  switch (column.typeName) {
    case "BIGINT":
      // 서버는 BIGINT 를 10진 문자열로 보낸다. 숫자로 오더라도 받아 준다.
      return typeof raw === "string" || typeof raw === "number" ? BigInt(raw) : (raw as Value);
    case "SMALLINT":
    case "INTEGER":
    case "REAL":
    case "DOUBLE PRECISION":
      return typeof raw === "string" ? Number(raw) : (raw as Value);
    case "BINARY":
    case "VARBINARY":
      return typeof raw === "string" ? Buffer.from(raw, "hex") : (raw as Value);
    default:
      // CHAR, VARCHAR, DECIMAL, BOOLEAN, 날짜시간, INTERVAL 은 서버의 표기 그대로이다.
      return raw as Value;
  }
}

/** 결과의 행 하나를 변환한다. */
export function decodeRow(raw: readonly JsonValue[], columns: readonly ColumnMeta[]): Row {
  const row: Row = new Array<Value>(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const column = columns[i];
    row[i] = column === undefined ? (raw[i] as Value) : decodeValue(raw[i] as JsonValue, column);
  }
  return row;
}

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** 파라미터 하나를 서버가 받는 JSON 값으로 바꾼다. `index` 는 0 부터 센 파라미터 위치이며 오류 메시지에만 쓴다. */
export function encodeParam(value: Param, index: number): ParamValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new RangeError(`Parameter ${index + 1} is not a finite number.`);
      // 안전 정수를 넘는 정수는 JSON 숫자로 보내면 정밀도를 잃으므로 문자열로 보낸다.
      return Number.isInteger(value) && !Number.isSafeInteger(value) ? BigInt(value).toString() : value;
    case "bigint":
      return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value.toString();
    default:
      break;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new RangeError(`Parameter ${index + 1} is an invalid Date.`);
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return { binary: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex").toUpperCase() };
  }
  throw new TypeError(`Parameter ${index + 1} has an unsupported type.`);
}

/** 파라미터 목록을 변환한다. */
export function encodeParams(params: readonly Param[]): ParamValue[] {
  return params.map((value, index) => encodeParam(value, index));
}
