/**
 * 메시지 프로토콜의 정의.
 *
 * 담당
 *  - 프로토콜 버전과 한도(메시지 크기, 묶음 크기, 열린 커서 수 등)
 *  - 메시지의 종류와 필드 : 핸드셰이크, 인증, 문장 실행, 결과, 다음 행 묶음 요청, 커서 닫기,
 *    ping, 접속 종료, 오류, 데몬 제어(상태 조회, 종료)
 *  - 요청의 해석과 검증(`decodeRequest`), 응답의 해석(`decodeResponse`), 메시지 만들기(`encodeMessage`, `errorResponse`)
 *  - 메시지는 UTF-8 JSON 이며 요청의 `id` 로 응답을 짝짓는다. 메시지 하나는 최대 16MB 이다.
 *  - 값의 JSON 표현 : BIGINT, NUMERIC, 날짜시간, INTERVAL 은 문자열, 이진 값은 16진 문자열,
 *    나머지는 JSON 기본 타입. 실제 타입은 컬럼 메타데이터에 적는다. (값 변환은 서버 전용인 resultEncoder.ts)
 *
 * 서버와 클라이언트(client/connection.ts)가 함께 쓴다. 타입과 변환 함수만 두고, 소켓은 다루지 않는다.
 * 서버 쪽 모듈(session, exec, catalog, types 등)을 import 하지 않는다. (common/errors.ts 만 쓴다)
 * 이 파일을 바꾸면 docs/protocol.md 의 프로토콜 명세도 함께 고친다. 드라이버가 그 문서를 기준으로 삼는다.
 *
 * 관련 사양 : AGENTS.md 상세 8
 * 구현 단계 : 9단계 (9-1)
 */

import { DbError, ERROR_CODES } from "../common/errors.js";
import type { SourcePosition } from "../common/errors.js";

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------

/** 이 구현의 프로토콜 버전이다. 필드의 뜻을 바꾸거나 지우면 올린다. 필드를 더하는 것은 올리지 않는다. */
export const PROTOCOL_VERSION = 1;

/** 서버가 받아들이는 프로토콜 버전이다. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1];

/** 인증 방식의 이름이다. (auth/scram.ts 의 SCRAM_MECHANISM 과 같은 값이며, 클라이언트가 서버 모듈을 import 하지 않도록 여기에도 둔다) */
export const AUTH_MECHANISM = "SCRAM-SHA-256";

/** 메시지 하나의 최대 크기(바이트)이다. 사양 상세 8. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** 인증을 마치기 전에 받을 수 있는 메시지의 최대 크기(바이트)이다. 인증 전 메시지는 모두 작다. */
export const MAX_PREAUTH_MESSAGE_BYTES = 64 * 1024;

/** 응답 메시지의 봉투와 컬럼 정보 등에 남겨 두는 여유(바이트)이다. 행 하나가 이만큼을 뺀 크기를 넘으면 보낼 수 없다. */
export const MESSAGE_ENVELOPE_RESERVE = 4096;

/** `fetchSize` 를 생략했을 때의 행 수이다. */
export const DEFAULT_FETCH_SIZE = 500;

/** `fetchSize` 의 상한이다. 넘는 값은 이 값으로 줄인다. */
export const MAX_FETCH_SIZE = 100_000;

/** 한 묶음의 소프트 한도(바이트)이다. 이 크기를 넘기기 직전에 묶음을 끝낸다. 행이 하나뿐이면 넘어도 보낸다. */
export const FETCH_SOFT_LIMIT_BYTES = 1024 * 1024;

/** 접속 하나가 동시에 열어 둘 수 있는 커서의 수이다. */
export const MAX_OPEN_CURSORS = 16;

/** 접속 하나에서 처리를 기다릴 수 있는 요청의 수이다. 넘으면 접속을 끊는다. */
export const MAX_PENDING_REQUESTS = 64;

/** 접속한 뒤 인증을 마치기까지의 시간 제한(ms)이다. 넘으면 오류 없이 접속을 닫는다. */
export const AUTH_TIMEOUT_MS = 10_000;

/** 인증에 실패했을 때 응답하기 전에 두는 지연(ms)이다. 무차별 대입을 늦춘다. */
export const AUTH_FAILURE_DELAY_MS = 200;

/** `execute.params` 의 최대 개수이다. */
export const MAX_PARAMETERS = 65_535;

/** 접속 경로이다. */
export type Channel = "local" | "tcp" | "udp";

/** 서버가 먼저 보내는 메시지(유휴 시간 초과, 서버 종료)의 `id` 이다. */
export const SERVER_MESSAGE_ID = 0;

// ---------------------------------------------------------------------------
// JSON 과 메시지 타입
// ---------------------------------------------------------------------------

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** `execute.params` 의 원소이다. 해석 규칙은 서버의 resultEncoder.ts 와 docs/protocol.md 에 있다. */
export type ParamValue = null | boolean | number | string | { binary: string };

export interface HelloRequest {
  id: number;
  type: "hello";
  /** 클라이언트가 지원하는 프로토콜 버전이다. */
  versions: number[];
  client?: string;
  /** 지원하는 인증 방식이다. 생략하면 `["SCRAM-SHA-256"]` 이다. */
  mechanisms?: string[];
}

export interface AuthStartRequest {
  id: number;
  type: "authStart";
  mechanism: string;
  /** SCRAM client-first-message 이다. 사용자 이름이 들어 있다. */
  clientFirst: string;
  /** 접속 직후의 현재 테이블스페이스이다. 생략하면 사용자의 기본 테이블스페이스이다. */
  tablespace?: string;
  /** 세션 타임존이다. 생략하면 config.json 의 `timeZone` 이다. */
  timeZone?: string;
}

export interface AuthFinishRequest {
  id: number;
  type: "authFinish";
  /** SCRAM client-final-message 이다. */
  clientFinal: string;
}

export interface ExecuteRequest {
  id: number;
  type: "execute";
  sql: string;
  params: ParamValue[];
  fetchSize?: number;
}

export interface FetchRequest {
  id: number;
  type: "fetch";
  cursor: number;
  fetchSize?: number;
}

export interface CloseCursorRequest {
  id: number;
  type: "closeCursor";
  cursor: number;
}

export interface PingRequest {
  id: number;
  type: "ping";
}

export interface CloseRequest {
  id: number;
  type: "close";
}

export type ControlAction = "status" | "stop";

export interface ControlRequest {
  id: number;
  type: "control";
  action: ControlAction;
  token: string;
}

export type Request =
  | HelloRequest
  | AuthStartRequest
  | AuthFinishRequest
  | ExecuteRequest
  | FetchRequest
  | CloseCursorRequest
  | PingRequest
  | CloseRequest
  | ControlRequest;

export type RequestType = Request["type"];

export const REQUEST_TYPES: readonly RequestType[] = [
  "hello",
  "authStart",
  "authFinish",
  "execute",
  "fetch",
  "closeCursor",
  "ping",
  "close",
  "control",
];

/** 컬럼 하나의 메타데이터이다. 해당하지 않는 필드는 생략한다. */
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
  /** UDP 접속일 때만 있다. 클라이언트가 ping 주기와 조각 크기를 정하는 데 쓴다. */
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
  /** SCRAM server-final-message(`v=<서버 서명>`)이다. 클라이언트는 이것으로 서버를 확인한다. */
  serverFinal: string;
  session: SessionInfoMessage;
}

export interface RowsResponse {
  id: number;
  type: "rows";
  /** `execute` 의 응답에만 있다. `fetch` 의 응답에는 없다. */
  columns?: ColumnMeta[];
  rows: JsonValue[][];
  /** 남은 행이 있을 때만 있다. `fetch` 와 `closeCursor` 에 쓴다. */
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
}

export interface StatusResponse {
  id: number;
  type: "status";
  running: boolean;
  port: number;
  pid: number;
  startedAt: string;
  version: string;
  dataDir: string;
  tcpEnabled: boolean;
  udpEnabled: boolean;
  sessionCount: number;
}

export interface StoppingResponse {
  id: number;
  type: "stopping";
}

export interface ErrorResponse {
  id: number;
  type: "error";
  sqlState: string;
  code: number;
  message: string;
  position?: SourcePosition;
}

export type Response =
  | HelloOkResponse
  | AuthChallengeResponse
  | AuthOkResponse
  | RowsResponse
  | OkResponse
  | CursorClosedResponse
  | PongResponse
  | ByeResponse
  | StatusResponse
  | StoppingResponse
  | ErrorResponse;

export const RESPONSE_TYPES: readonly Response["type"][] = [
  "helloOk",
  "authChallenge",
  "authOk",
  "rows",
  "ok",
  "cursorClosed",
  "pong",
  "bye",
  "status",
  "stopping",
  "error",
];

// ---------------------------------------------------------------------------
// 오류 만들기
// ---------------------------------------------------------------------------

/** 프로토콜 위반 오류이다. SQLSTATE 08P01. 이 오류가 나면 접속을 끊는다. */
export function protocolViolation(message: string): DbError {
  return new DbError("08P01", ERROR_CODES.PROTOCOL_VIOLATION, message);
}

function invalidField(message: string): DbError {
  return new DbError("22023", ERROR_CODES.TYPE_PARAMETER_INVALID, message);
}

/** `DbError` 를 오류 응답으로 바꾼다. 스택이나 내부 경로는 싣지 않는다. */
export function errorResponse(id: number, error: DbError): ErrorResponse {
  const response: ErrorResponse = { id, type: "error", sqlState: error.sqlState, code: error.code, message: error.message };
  if (error.position !== undefined) response.position = error.position;
  return response;
}

// ---------------------------------------------------------------------------
// 메시지 만들기와 해석
// ---------------------------------------------------------------------------

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** 메시지를 UTF-8 JSON 본문으로 바꾼다. 16MB 를 넘으면 54000 이다. */
export function encodeMessage(message: object): Buffer {
  return assertMessageSize(Buffer.from(JSON.stringify(message), "utf8"));
}

/** 이미 만든 본문의 크기가 한도 안인지 확인한다. */
export function assertMessageSize(body: Buffer): Buffer {
  if (body.length > MAX_MESSAGE_BYTES) {
    throw new DbError("54000", ERROR_CODES.LIMIT_EXCEEDED, `Message is too large: ${body.length} bytes (limit ${MAX_MESSAGE_BYTES}).`);
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 올바르지 않은 UTF-8 이나 JSON 이면 null 이다. */
function parseJsonBody(body: Uint8Array): unknown {
  let text: string;
  try {
    text = UTF8.decode(body);
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** 짝이 맞지 않는 서러게이트가 있는지 본다. JSON 의 `\uD800` 이스케이프로 들어올 수 있다. */
export function hasLoneSurrogate(text: string): boolean {
  return LONE_SURROGATE.test(text);
}

export type DecodeResult =
  | { ok: true; request: Request }
  /**
   * 해석에 실패했다. `fatal` 이면 접속을 끊어야 하는 위반(08P01)이고,
   * 아니면 그 요청만 실패시키는 필드 값 오류(22023 등)이다. `id` 는 알 수 있을 때만 있다.
   */
  | { ok: false; id: number | null; error: DbError; fatal: boolean };

function fatal(id: number | null, message: string): DecodeResult {
  return { ok: false, id, error: protocolViolation(message), fatal: true };
}

function fieldError(id: number, error: DbError): DecodeResult {
  return { ok: false, id, error, fatal: false };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** 요청 본문을 해석하고 검증한다. 검증을 통과하기 전에는 어떤 필드도 쓰지 않는다. */
export function decodeRequest(body: Uint8Array): DecodeResult {
  const parsed = parseJsonBody(body);
  if (parsed === undefined) return fatal(null, "Message is not valid UTF-8 JSON.");
  if (!isRecord(parsed)) return fatal(null, "Message must be a JSON object.");
  const id = parsed["id"];
  if (!isPositiveInteger(id)) return fatal(null, 'Message needs an integer "id" of 1 or more.');
  const type = parsed["type"];
  if (typeof type !== "string" || !REQUEST_TYPES.includes(type as RequestType)) {
    return fatal(id, `Unknown message type: ${typeof type === "string" ? JSON.stringify(type.slice(0, 40)) : typeof type}.`);
  }
  try {
    return { ok: true, request: validateFields(id, type as RequestType, parsed) };
  } catch (error) {
    if (error instanceof DbError) return fieldError(id, error);
    throw error;
  }
}

function requireString(record: Record<string, unknown>, name: string, maxLength: number): string {
  const value = record[name];
  if (typeof value !== "string") throw invalidField(`Field "${name}" must be a string.`);
  if (value.length > maxLength) throw invalidField(`Field "${name}" is too long.`);
  return value;
}

function optionalString(record: Record<string, unknown>, name: string, maxLength: number): string | undefined {
  return record[name] === undefined ? undefined : requireString(record, name, maxLength);
}

function optionalFetchSize(record: Record<string, unknown>): number | undefined {
  const value = record["fetchSize"];
  if (value === undefined) return undefined;
  if (!isPositiveInteger(value)) throw invalidField('Field "fetchSize" must be an integer of 1 or more.');
  return value;
}

function requireCursor(record: Record<string, unknown>): number {
  const value = record["cursor"];
  if (!isPositiveInteger(value)) throw invalidField('Field "cursor" must be an integer of 1 or more.');
  return value;
}

function validateParam(value: unknown, index: number): ParamValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidField(`Parameter ${index + 1} is not a finite number.`);
    return value;
  }
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) {
      throw new DbError("22021", ERROR_CODES.INVALID_CHARACTER_ENCODING, `Parameter ${index + 1} is not valid Unicode text.`);
    }
    return value;
  }
  if (isRecord(value) && typeof value["binary"] === "string" && Object.keys(value).length === 1) {
    return { binary: value["binary"] };
  }
  throw invalidField(`Parameter ${index + 1} has an unsupported form.`);
}

function validateFields(id: number, type: RequestType, record: Record<string, unknown>): Request {
  switch (type) {
    case "hello": {
      const versions = record["versions"];
      if (!Array.isArray(versions) || versions.length === 0 || versions.length > 32 || !versions.every(isPositiveInteger)) {
        throw invalidField('Field "versions" must be a non-empty array of integers.');
      }
      const request: HelloRequest = { id, type, versions: versions as number[] };
      const client = optionalString(record, "client", 256);
      if (client !== undefined) request.client = client;
      const mechanisms = record["mechanisms"];
      if (mechanisms !== undefined) {
        if (!Array.isArray(mechanisms) || mechanisms.length > 16 || !mechanisms.every((entry) => typeof entry === "string")) {
          throw invalidField('Field "mechanisms" must be an array of strings.');
        }
        request.mechanisms = mechanisms as string[];
      }
      return request;
    }
    case "authStart": {
      const request: AuthStartRequest = {
        id,
        type,
        mechanism: requireString(record, "mechanism", 64),
        clientFirst: requireString(record, "clientFirst", 2048),
      };
      const tablespace = optionalString(record, "tablespace", 256);
      if (tablespace !== undefined) request.tablespace = tablespace;
      const timeZone = optionalString(record, "timeZone", 64);
      if (timeZone !== undefined) request.timeZone = timeZone;
      return request;
    }
    case "authFinish":
      return { id, type, clientFinal: requireString(record, "clientFinal", 2048) };
    case "execute": {
      const sql = requireString(record, "sql", MAX_MESSAGE_BYTES);
      if (hasLoneSurrogate(sql)) {
        throw new DbError("22021", ERROR_CODES.INVALID_CHARACTER_ENCODING, "SQL text is not valid Unicode text.");
      }
      const rawParams = record["params"];
      if (rawParams !== undefined && !Array.isArray(rawParams)) throw invalidField('Field "params" must be an array.');
      if (rawParams !== undefined && rawParams.length > MAX_PARAMETERS) throw invalidField('Field "params" has too many entries.');
      const params = (rawParams ?? []).map((entry: unknown, index: number) => validateParam(entry, index));
      const request: ExecuteRequest = { id, type, sql, params };
      const fetchSize = optionalFetchSize(record);
      if (fetchSize !== undefined) request.fetchSize = fetchSize;
      return request;
    }
    case "fetch": {
      const request: FetchRequest = { id, type, cursor: requireCursor(record) };
      const fetchSize = optionalFetchSize(record);
      if (fetchSize !== undefined) request.fetchSize = fetchSize;
      return request;
    }
    case "closeCursor":
      return { id, type, cursor: requireCursor(record) };
    case "ping":
      return { id, type };
    case "close":
      return { id, type };
    case "control": {
      const action = record["action"];
      if (action !== "status" && action !== "stop") throw invalidField('Field "action" must be "status" or "stop".');
      return { id, type, action, token: requireString(record, "token", 256) };
    }
  }
}

export type DecodeResponseResult = { ok: true; response: Response } | { ok: false; reason: string };

/**
 * 응답 본문을 해석한다. 클라이언트가 쓴다. 봉투와 핵심 필드의 모양만 확인하고, 모르는 필드는 그대로 둔다.
 * 서버를 신뢰하지 않는 것이 목적이 아니라, 어긋난 응답으로 클라이언트가 예외로 죽지 않게 하기 위함이다.
 */
export function decodeResponse(body: Uint8Array): DecodeResponseResult {
  const parsed = parseJsonBody(body);
  if (parsed === undefined) return { ok: false, reason: "Response is not valid UTF-8 JSON." };
  if (!isRecord(parsed)) return { ok: false, reason: "Response must be a JSON object." };
  const id = parsed["id"];
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) return { ok: false, reason: 'Response needs an integer "id".' };
  const type = parsed["type"];
  if (typeof type !== "string" || !RESPONSE_TYPES.includes(type as Response["type"])) {
    return { ok: false, reason: "Unknown response type." };
  }
  const need = (condition: boolean, what: string): DecodeResponseResult | null =>
    condition ? null : { ok: false, reason: `Response "${type}" has an invalid field: ${what}.` };
  const problem = ((): DecodeResponseResult | null => {
    switch (type as Response["type"]) {
      case "helloOk":
        return need(typeof parsed["version"] === "number" && typeof parsed["maxMessageBytes"] === "number", "version");
      case "authChallenge":
        return need(typeof parsed["serverFirst"] === "string", "serverFirst");
      case "authOk":
        return need(typeof parsed["serverFinal"] === "string" && isRecord(parsed["session"]), "serverFinal, session");
      case "rows":
        return need(Array.isArray(parsed["rows"]) && typeof parsed["hasMore"] === "boolean", "rows, hasMore");
      case "ok":
        return need(typeof parsed["message"] === "string", "message");
      case "error":
        return need(
          typeof parsed["sqlState"] === "string" && typeof parsed["code"] === "number" && typeof parsed["message"] === "string",
          "sqlState, code, message",
        );
      case "status":
        return need(typeof parsed["running"] === "boolean" && typeof parsed["port"] === "number", "running, port");
      default:
        return null;
    }
  })();
  if (problem !== null) return problem;
  return { ok: true, response: parsed as unknown as Response };
}

/** 오류 응답을 `DbError` 로 바꾼다. 클라이언트가 쓴다. */
export function toDbError(response: ErrorResponse): DbError {
  const options = response.position === undefined ? undefined : { position: response.position };
  return new DbError(response.sqlState, response.code, response.message, options);
}
