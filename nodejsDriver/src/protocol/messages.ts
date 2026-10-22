/**
 * 메시지 프로토콜의 정의 (클라이언트 쪽).
 *
 * 담당
 *  - 프로토콜 버전과 한도
 *  - 응답 메시지의 타입, 응답의 해석(`decodeResponse`), 요청 메시지 만들기(`encodeMessage`), 오류 응답의 변환(`toDbError`)
 *  - 메시지는 UTF-8 JSON 이며 요청의 `id` 로 응답을 짝짓는다. 메시지 하나는 최대 16 MiB 이다.
 *
 * 기준 문서는 `rdbms/docs/protocol.md`(버전 1)이다. 서버 쪽 요청 검증은 이 드라이버에 없다.
 * 서버를 신뢰하지 않는 것이 목적이 아니라, 어긋난 응답으로 드라이버가 예외로 죽지 않게 하기 위해 응답의 모양을 확인한다.
 *
 * 관련 사양 : AGENTS.md 상세 8
 * 구현 단계 : 12-2
 */

import { DbError } from "../errors.js";
import type { SourcePosition } from "../errors.js";

/** 이 드라이버가 쓰는 프로토콜 버전이다. */
export const PROTOCOL_VERSION = 1;

/** 인증 방식의 이름이다. */
export const AUTH_MECHANISM = "SCRAM-SHA-256";

/** 메시지 하나의 최대 크기(바이트)이다. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** 인증을 마치기 전 메시지 하나의 최대 크기(바이트)이다. 인증 전에는 이 한도를 넘는 프레임이 접속을 끊는다. */
export const PRE_AUTH_MAX_MESSAGE_BYTES = 64 * 1024;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** `execute.params` 의 원소이다. */
export type ParamValue = null | boolean | number | string | { binary: string };

/** 컬럼 하나의 메타데이터이다. 해당하지 않는 필드는 생략된다. */
export interface ColumnMeta {
  name: string;
  /** 정규 타입 이름이다. (예 : `VARCHAR`, `DECIMAL`, `TIMESTAMP WITH TIME ZONE`) */
  typeName: string;
  /** 선언 표기이다. (예 : `DECIMAL(10,3)`, `VARCHAR(100)`) */
  declared: string;
  length?: number;
  precision?: number;
  scale?: number;
  fractionalPrecision?: number;
  startField?: string;
  endField?: string;
  leadingPrecision?: number;
}

/** 인증을 마친 세션의 정보이다. 현재 테이블스페이스가 없으면 `tablespace` 는 `null` 이다. */
export interface SessionInfoMessage {
  id: number;
  user: string;
  tablespace: string | null;
  timeZone: string;
  autocommit: boolean;
}

export interface HelloOkResponse {
  id: number;
  type: "helloOk";
  version: number;
  server: string;
  mechanism: string;
  maxMessageBytes: number;
  defaultFetchSize: number;
  /** UDP 접속일 때만 있다. ping 주기와 조각 크기를 정하는 데 쓴다. */
  udp?: { sessionTimeoutMs: number; maxPacketSize: number };
}

export interface AuthChallengeResponse {
  id: number;
  type: "authChallenge";
  serverFirst: string;
}

export interface AuthOkResponse {
  id: number;
  type: "authOk";
  /** SCRAM server-final-message(`v=<서버 서명>`)이다. 서버를 확인하는 데 쓴다. */
  serverFinal: string;
  session: SessionInfoMessage;
}

export interface RowsResponse {
  id: number;
  type: "rows";
  /** `execute` 의 응답에만 있다. `fetch` 의 응답에는 없다. */
  columns?: ColumnMeta[];
  rows: JsonValue[][];
  /** 남은 행이 있을 때만 있다. */
  cursor?: number;
  hasMore: boolean;
}

export interface OkResponse {
  id: number;
  type: "ok";
  message: string;
  rowCount?: number;
}

export interface CursorClosedResponse {
  id: number;
  type: "cursorClosed";
}

export interface PongResponse {
  id: number;
  type: "pong";
}

export interface ByeResponse {
  id: number;
  type: "bye";
  /** 세션을 닫으면서 커밋하지 않은 변경을 롤백했을 때만 있다(`true`). */
  rolledBack?: boolean;
}

export interface ErrorResponse {
  id: number;
  type: "error";
  sqlState: string;
  code: number;
  message: string;
  position?: SourcePosition;
}

/** 드라이버가 받는 응답이다. (데몬 제어의 `status`, `stopping` 은 로컬 전용 채널의 몫이라 다루지 않는다) */
export type Response =
  | HelloOkResponse
  | AuthChallengeResponse
  | AuthOkResponse
  | RowsResponse
  | OkResponse
  | CursorClosedResponse
  | PongResponse
  | ByeResponse
  | ErrorResponse;

const RESPONSE_TYPES: readonly string[] = ["helloOk", "authChallenge", "authOk", "rows", "ok", "cursorClosed", "pong", "bye", "error"];

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** 메시지를 UTF-8 JSON 본문으로 바꾼다. 16 MiB 를 넘으면 54000 이다. */
export function encodeMessage(message: object): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_MESSAGE_BYTES) {
    throw new DbError("54000", 8003, `Message is too large: ${body.length} bytes (limit ${MAX_MESSAGE_BYTES}).`);
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function validColumn(value: unknown): boolean {
  if (!isRecord(value) || typeof value["name"] !== "string" || typeof value["typeName"] !== "string" || typeof value["declared"] !== "string") return false;
  for (const key of ["length", "precision", "scale", "fractionalPrecision", "leadingPrecision"]) {
    if (value[key] !== undefined && !integer(value[key])) return false;
  }
  return ["startField", "endField"].every((key) => value[key] === undefined || typeof value[key] === "string");
}

function validSession(value: unknown): boolean {
  return isRecord(value) && integer(value["id"], 1) && typeof value["user"] === "string" &&
    (value["tablespace"] === null || typeof value["tablespace"] === "string") &&
    typeof value["timeZone"] === "string" && typeof value["autocommit"] === "boolean";
}

function scalar(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

export type DecodeResponseResult = { ok: true; response: Response } | { ok: false; reason: string };

/** 응답 본문을 해석한다. 봉투와 핵심 필드의 모양만 확인하고, 모르는 필드는 그대로 둔다. */
export function decodeResponse(body: Uint8Array): DecodeResponseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8.decode(body)) as unknown;
  } catch {
    return { ok: false, reason: "Response is not valid UTF-8 JSON." };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "Response must be a JSON object." };
  const id = parsed["id"];
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) return { ok: false, reason: 'Response needs an integer "id".' };
  const type = parsed["type"];
  if (typeof type !== "string" || !RESPONSE_TYPES.includes(type)) return { ok: false, reason: "Unknown response type." };
  const need = (condition: boolean, what: string): DecodeResponseResult | null =>
    condition ? null : { ok: false, reason: `Response "${type}" has an invalid field: ${what}.` };
  const problem = ((): DecodeResponseResult | null => {
    switch (type) {
      case "helloOk": {
        const udp = parsed["udp"];
        return need(integer(parsed["version"], 1) && integer(parsed["maxMessageBytes"], 1) && parsed["maxMessageBytes"] <= MAX_MESSAGE_BYTES &&
          integer(parsed["defaultFetchSize"], 1) && typeof parsed["server"] === "string" && typeof parsed["mechanism"] === "string" &&
          (udp === undefined || (isRecord(udp) && integer(udp["sessionTimeoutMs"]) && integer(udp["maxPacketSize"], 64) && udp["maxPacketSize"] <= 65_507)), "hello fields");
      }
      case "authChallenge":
        return need(typeof parsed["serverFirst"] === "string", "serverFirst");
      case "authOk":
        return need(typeof parsed["serverFinal"] === "string" && validSession(parsed["session"]), "serverFinal, session");
      case "rows": {
        const columns = parsed["columns"];
        const rows = parsed["rows"];
        return need(Array.isArray(rows) && rows.every((row) => Array.isArray(row) && row.every(scalar) &&
          (!Array.isArray(columns) || row.length === columns.length)) && typeof parsed["hasMore"] === "boolean" &&
          (columns === undefined || (Array.isArray(columns) && columns.every(validColumn))) &&
          (parsed["cursor"] === undefined || integer(parsed["cursor"], 1)) &&
          (parsed["hasMore"] !== true || integer(parsed["cursor"], 1)), "rows, hasMore, cursor, columns");
      }
      case "ok":
        return need(typeof parsed["message"] === "string" && (parsed["rowCount"] === undefined || integer(parsed["rowCount"])), "message, rowCount");
      case "error": {
        const position = parsed["position"];
        return need(typeof parsed["sqlState"] === "string" && /^[A-Z0-9]{5}$/.test(parsed["sqlState"]) && integer(parsed["code"]) && typeof parsed["message"] === "string" &&
          (position === undefined || (isRecord(position) && integer(position["offset"]) && integer(position["line"], 1) && integer(position["column"], 1))), "sqlState, code, message, position");
      }
      case "bye":
        return need(parsed["rolledBack"] === undefined || typeof parsed["rolledBack"] === "boolean", "rolledBack");
      default:
        return null;
    }
  })();
  if (problem !== null) return problem;
  return { ok: true, response: parsed as unknown as Response };
}

/** 오류 응답을 `DbError` 로 바꾼다. */
export function toDbError(response: ErrorResponse): DbError {
  const options = response.position === undefined ? undefined : { position: response.position };
  return new DbError(response.sqlState, response.code, response.message, options);
}
