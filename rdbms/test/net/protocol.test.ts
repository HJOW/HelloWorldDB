/**
 * 프로토콜 메시지의 해석과 검증, 값 인코딩 테스트 (9단계, 9-1).
 * 관련 사양 : AGENTS.md 상세 8, docs/protocol.md
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DbError } from "../../src/common/errors.js";
import {
  AUTH_MECHANISM,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  REQUEST_TYPES,
  RESPONSE_TYPES,
  SUPPORTED_PROTOCOL_VERSIONS,
  assertMessageSize,
  decodeRequest,
  decodeResponse,
  encodeMessage,
  errorResponse,
  hasLoneSurrogate,
  toDbError,
} from "../../src/net/protocol.js";
import type { DecodeResult, ErrorResponse } from "../../src/net/protocol.js";
import { SCRAM_MECHANISM } from "../../src/auth/scram.js";
import { columnMeta, decodeParams, encodeBatch, encodeRow, encodeValue } from "../../src/net/resultEncoder.js";
import type { DataType } from "../../src/types/dataType.js";
import { type as sqlType, value as sqlValue } from "../types/helpers.js";
import { Decimal } from "../../src/types/numeric.js";

function body(message: unknown): Buffer {
  return Buffer.from(typeof message === "string" ? message : JSON.stringify(message), "utf8");
}

function decode(message: unknown): DecodeResult {
  return decodeRequest(body(message));
}

function fatalOf(result: DecodeResult): { id: number | null; error: DbError } {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.fatal, true, "접속을 끊어야 하는 위반이어야 한다");
  assert.equal(result.error.sqlState, "08P01");
  assert.equal(result.error.code, 8000);
  return result;
}

function fieldOf(result: DecodeResult): { id: number | null; error: DbError } {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.fatal, false, "요청만 실패시키는 필드 오류여야 한다");
  return result;
}

test("프로토콜 버전과 인증 방식 상수는 서버 모듈과 같은 값이다", () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.deepEqual(SUPPORTED_PROTOCOL_VERSIONS, [1]);
  assert.equal(AUTH_MECHANISM, SCRAM_MECHANISM);
  assert.equal(MAX_MESSAGE_BYTES, 16_777_216);
});

test("모든 요청 종류가 해석된다", () => {
  const cases: Array<{ message: Record<string, unknown>; expect: Record<string, unknown> }> = [
    { message: { id: 11, type: "prepare", sql: "SELECT ?", parameterTypes: ["INTEGER"] }, expect: { parameterTypes: ["INTEGER"] } },
    { message: { id: 12, type: "describe", statement: 1 }, expect: { statement: 1 } },
    { message: { id: 13, type: "executePrepared", statement: 1 }, expect: { params: [] } },
    { message: { id: 14, type: "closePrepared", statement: 1 }, expect: { statement: 1 } },
    { message: { id: 15, type: "cancel", targetId: 5 }, expect: { targetId: 5 } },
    { message: { id: 1, type: "hello", versions: [1, 2], client: "t", mechanisms: ["SCRAM-SHA-256"] }, expect: { versions: [1, 2], client: "t" } },
    { message: { id: 2, type: "authStart", mechanism: "SCRAM-SHA-256", clientFirst: "n,,n=A,r=x", tablespace: "APP", timeZone: "+09:00" }, expect: { tablespace: "APP", timeZone: "+09:00" } },
    { message: { id: 3, type: "authFinish", clientFinal: "c=biws,r=x,p=y" }, expect: { clientFinal: "c=biws,r=x,p=y" } },
    { message: { id: 4, type: "execute", sql: "SELECT 1", params: [1, "a", null, true, 1.5, { binary: "AB" }], fetchSize: 10 }, expect: { sql: "SELECT 1", fetchSize: 10 } },
    { message: { id: 5, type: "execute", sql: "SELECT 1" }, expect: { params: [] } },
    { message: { id: 6, type: "fetch", cursor: 3, fetchSize: 20 }, expect: { cursor: 3, fetchSize: 20 } },
    { message: { id: 7, type: "closeCursor", cursor: 3 }, expect: { cursor: 3 } },
    { message: { id: 8, type: "ping" }, expect: {} },
    { message: { id: 9, type: "close" }, expect: {} },
    { message: { id: 10, type: "control", action: "status", token: "abc" }, expect: { action: "status", token: "abc" } },
  ];
  for (const { message, expect } of cases) {
    const result = decode(message);
    assert.equal(result.ok, true, JSON.stringify(message));
    if (!result.ok) continue;
    assert.equal(result.request.id, message["id"]);
    assert.equal(result.request.type, message["type"]);
    for (const [key, value] of Object.entries(expect)) {
      assert.deepEqual((result.request as unknown as Record<string, unknown>)[key], value, `${String(message["type"])}.${key}`);
    }
  }
  assert.equal(REQUEST_TYPES.length, cases.map((entry) => entry.message["type"]).filter((type, i, all) => all.indexOf(type) === i).length);
});

test("모르는 필드는 무시한다", () => {
  const result = decode({ id: 1, type: "ping", futureField: { nested: true } });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.request, { id: 1, type: "ping" });
});

test("해석할 수 없는 본문, 객체가 아닌 값, id 없음, 모르는 type 은 접속을 끊는 위반이다", () => {
  fatalOf(decode("{not json"));
  fatalOf(decode("[1, 2]"));
  fatalOf(decode("42"));
  fatalOf(decode("null"));
  fatalOf(decode({ type: "ping" }));
  fatalOf(decode({ id: 0, type: "ping" }));
  fatalOf(decode({ id: -1, type: "ping" }));
  fatalOf(decode({ id: 1.5, type: "ping" }));
  fatalOf(decode({ id: "1", type: "ping" }));
  const unknown = fatalOf(decode({ id: 5, type: "rows" }));
  assert.equal(unknown.id, 5, "type 이 틀려도 id 는 알려 준다");
  fatalOf(decode({ id: 5 }));
  fatalOf(decode({ id: 5, type: 7 }));
});

test("올바르지 않은 UTF-8 은 위반이다", () => {
  const bad = Buffer.concat([Buffer.from('{"id":1,"type":"ping","x":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]);
  fatalOf(decodeRequest(bad));
  // 빈 본문과 BOM
  fatalOf(decodeRequest(Buffer.alloc(0)));
});

test("필드 값이 틀린 요청은 그 요청만 실패시킨다(22023)", () => {
  const bad: unknown[] = [
    { id: 1, type: "hello" },
    { id: 1, type: "hello", versions: [] },
    { id: 1, type: "hello", versions: [0] },
    { id: 1, type: "hello", versions: "1" },
    { id: 1, type: "hello", versions: [1], mechanisms: "SCRAM" },
    { id: 1, type: "authStart", mechanism: 5, clientFirst: "x" },
    { id: 1, type: "authStart", mechanism: "SCRAM-SHA-256" },
    { id: 1, type: "authFinish" },
    { id: 1, type: "execute", sql: 5 },
    { id: 1, type: "execute" },
    { id: 1, type: "execute", sql: "x", params: "no" },
    { id: 1, type: "execute", sql: "x", params: [{ unknown: 1 }] },
    { id: 1, type: "execute", sql: "x", params: [[1]] },
    { id: 1, type: "execute", sql: "x", params: [{ binary: 1 }] },
    { id: 1, type: "execute", sql: "x", fetchSize: 0 },
    { id: 1, type: "execute", sql: "x", fetchSize: -5 },
    { id: 1, type: "execute", sql: "x", fetchSize: 1.5 },
    { id: 1, type: "fetch", cursor: 0 },
    { id: 1, type: "fetch", cursor: "1" },
    { id: 1, type: "fetch" },
    { id: 1, type: "closeCursor", cursor: -1 },
    { id: 1, type: "control", action: "restart", token: "t" },
    { id: 1, type: "control", action: "status" },
  ];
  for (const message of bad) {
    const result = fieldOf(decode(message));
    assert.equal(result.id, 1);
    assert.equal(result.error.sqlState, "22023", JSON.stringify(message));
  }
});

test("짝이 맞지 않는 서러게이트가 든 SQL 과 파라미터는 22021 이다", () => {
  assert.equal(hasLoneSurrogate("\ud800"), true);
  assert.equal(hasLoneSurrogate("\udc00x"), true);
  assert.equal(hasLoneSurrogate("a😀b"), false, "서러게이트 쌍은 올바르다");
  assert.equal(hasLoneSurrogate("한글"), false);
  const sql = fieldOf(decode('{"id":1,"type":"execute","sql":"SELECT \\ud800"}'));
  assert.equal(sql.error.sqlState, "22021");
  const param = fieldOf(decode('{"id":1,"type":"execute","sql":"SELECT ?","params":["\\udc00"]}'));
  assert.equal(param.error.sqlState, "22021");
  const ok = decode('{"id":1,"type":"execute","sql":"SELECT \\ud83d\\ude00"}');
  assert.equal(ok.ok, true);
});

test("응답을 해석한다", () => {
  const good: unknown[] = [
    { id: 11, type: "prepared", statement: 1, parameterCount: 0, parameters: [], columns: [], resultKind: "ok" },
    { id: 12, type: "description", statement: 1, parameterCount: 0, parameters: [], columns: [], resultKind: "ok" },
    { id: 13, type: "preparedClosed" },
    { id: 14, type: "cancelAck", targetId: 5, status: "accepted" },
    { id: 1, type: "helloOk", version: 1, server: "s", mechanism: "SCRAM-SHA-256", maxMessageBytes: 1, defaultFetchSize: 500 },
    { id: 2, type: "authChallenge", serverFirst: "r=1,s=2,i=3" },
    { id: 3, type: "authOk", serverFinal: "v=x", session: { id: 1, user: "A", tablespace: null, timeZone: "+00:00", autocommit: true } },
    { id: 4, type: "rows", columns: [], rows: [[1]], hasMore: false },
    { id: 5, type: "ok", message: "done", rowCount: 2 },
    { id: 6, type: "cursorClosed" },
    { id: 7, type: "pong" },
    { id: 8, type: "bye" },
    { id: 9, type: "status", running: true, port: 7410, pid: 1, startedAt: "x", version: "1", dataDir: "d", tcpEnabled: true, udpEnabled: true, sessionCount: 0 },
    { id: 10, type: "stopping" },
    { id: 0, type: "error", sqlState: "57P01", code: 6003, message: "bye" },
  ];
  for (const message of good) {
    const result = decodeResponse(body(message));
    assert.equal(result.ok, true, JSON.stringify(message));
  }
  assert.equal(new Set(good.map((entry) => (entry as { type: string }).type)).size, RESPONSE_TYPES.length);
  for (const message of ["{", "[]", '{"id":-1,"type":"pong"}', '{"id":1,"type":"nope"}', '{"id":1,"type":"rows","rows":5,"hasMore":true}', '{"id":1,"type":"error"}']) {
    assert.equal(decodeResponse(body(message)).ok, false, message);
  }
});

test("오류 응답과 DbError 는 서로 바뀐다", () => {
  const original = new DbError("42501", 7001, "Permission denied.", { position: { line: 1, column: 5, offset: 4 } });
  const response: ErrorResponse = errorResponse(7, original);
  assert.deepEqual(response, { id: 7, type: "error", sqlState: "42501", code: 7001, message: "Permission denied.", position: { line: 1, column: 5, offset: 4 } });
  const restored = toDbError(JSON.parse(JSON.stringify(response)) as ErrorResponse);
  assert.equal(restored.sqlState, "42501");
  assert.equal(restored.code, 7001);
  assert.deepEqual(restored.position, { line: 1, column: 5, offset: 4 });
  assert.equal("position" in errorResponse(1, new DbError("XX000", 2, "x")), false, "위치가 없으면 싣지 않는다");
});

test("메시지 크기 한도", () => {
  assert.equal(encodeMessage({ id: 1, type: "pong" }).toString("utf8"), '{"id":1,"type":"pong"}');
  assertMessageSize(Buffer.alloc(MAX_MESSAGE_BYTES));
  assert.throws(() => assertMessageSize(Buffer.alloc(MAX_MESSAGE_BYTES + 1)), (error) => error instanceof DbError && error.sqlState === "54000" && error.code === 8003);
});

// ---------------------------------------------------------------------------
// 값 인코딩
// ---------------------------------------------------------------------------

function enc(text: string | null, typeText: string): unknown {
  const dataType: DataType = sqlType(typeText);
  return encodeValue(sqlValue(text, typeText), dataType);
}

test("정수는 SMALLINT, INTEGER 만 JSON 숫자이고 BIGINT 는 문자열이다", () => {
  assert.equal(enc("32767", "SMALLINT"), 32767);
  assert.equal(enc("-32768", "SMALLINT"), -32768);
  assert.equal(enc("2147483647", "INTEGER"), 2147483647);
  assert.equal(enc("-2147483648", "INTEGER"), -2147483648);
  assert.equal(enc("9223372036854775807", "BIGINT"), "9223372036854775807");
  assert.equal(enc("-9223372036854775808", "BIGINT"), "-9223372036854775808");
  assert.equal(enc("5", "BIGINT"), "5");
});

test("NUMERIC 은 소수 자릿수를 유지한 문자열이다(38자리 포함)", () => {
  assert.equal(enc("1.5", "DECIMAL(10,3)"), "1.500");
  assert.equal(enc("0", "DECIMAL(10,3)"), "0.000");
  assert.equal(enc("-0.001", "DECIMAL(10,3)"), "-0.001");
  const max = "9".repeat(38);
  assert.equal(enc(max, "DECIMAL(38,0)"), max);
  assert.equal(enc(`${"9".repeat(32)}.${"9".repeat(6)}`, "DECIMAL(38,6)"), `${"9".repeat(32)}.${"9".repeat(6)}`);
});

test("부동소수와 논리와 문자열과 NULL", () => {
  assert.equal(enc("1.5", "DOUBLE PRECISION"), 1.5);
  assert.equal(enc("-2.25", "REAL"), -2.25);
  assert.equal(enc("1e300", "DOUBLE PRECISION"), 1e300);
  assert.equal(enc("TRUE", "BOOLEAN"), true);
  assert.equal(enc("FALSE", "BOOLEAN"), false);
  assert.equal(enc("Hello World", "VARCHAR(20)"), "Hello World");
  assert.equal(enc("한글 😀", "VARCHAR(20)"), "한글 😀");
  assert.equal(enc("", "VARCHAR(20)"), "", "빈 문자열은 NULL 이 아니다");
  assert.equal(enc("ab", "CHAR(4)"), "ab  ", "CHAR 는 공백으로 채운 값이다");
  assert.equal(enc(null, "VARCHAR(20)"), null);
  assert.equal(enc(null, "INTEGER"), null);
  assert.equal(enc(null, "TIMESTAMP"), null);
  assert.throws(() => encodeValue(Number.NaN, sqlType("DOUBLE PRECISION")), (error) => error instanceof DbError && error.sqlState === "XX000");
  assert.throws(() => encodeValue(Number.POSITIVE_INFINITY, sqlType("REAL")), (error) => error instanceof DbError);
});

test("이진 값은 대문자 16진 문자열이다", () => {
  assert.equal(enc("ab12", "VARBINARY(10)"), "AB12");
  assert.equal(enc("00ff", "BINARY(2)"), "00FF");
  assert.equal(encodeValue(Buffer.alloc(0), sqlType("VARBINARY(10)")), "");
});

test("날짜시간과 INTERVAL 은 선언 자릿수를 지킨 문자열이다", () => {
  assert.equal(enc("2026-10-15", "DATE"), "2026-10-15");
  assert.equal(enc("0001-01-01", "DATE"), "0001-01-01");
  assert.equal(enc("9999-12-31", "DATE"), "9999-12-31");
  assert.equal(enc("13:05:07", "TIME(0)"), "13:05:07");
  assert.equal(enc("13:05:07.250", "TIME(3)"), "13:05:07.250");
  assert.equal(enc("13:05:07.123456", "TIME(6)"), "13:05:07.123456");
  assert.equal(enc("13:05:07+09:00", "TIME(0) WITH TIME ZONE"), "13:05:07+09:00");
  assert.equal(enc("2026-10-15 13:05:07.250", "TIMESTAMP(3)"), "2026-10-15 13:05:07.250");
  assert.equal(enc("2026-10-15 13:05:07.123456", "TIMESTAMP(6)"), "2026-10-15 13:05:07.123456");
  assert.equal(enc("2026-10-15 13:05:07+09:00", "TIMESTAMP(0) WITH TIME ZONE"), "2026-10-15 13:05:07+09:00");
  assert.equal(enc("1-02", "INTERVAL YEAR TO MONTH"), "1-02");
  assert.match(String(enc("3 04:05:06.500000", "INTERVAL DAY TO SECOND(6)")), /^3 04:05:06\.500000$/);
});

test("컬럼 메타데이터는 타입의 세부 정보를 모두 담는다", () => {
  assert.deepEqual(columnMeta("N", sqlType("INTEGER")), { name: "N", typeName: "INTEGER", declared: "INTEGER" });
  assert.deepEqual(columnMeta("S", sqlType("VARCHAR(100)")), { name: "S", typeName: "VARCHAR", declared: "VARCHAR(100)", length: 100 });
  assert.deepEqual(columnMeta("C", sqlType("CHAR(3)")), { name: "C", typeName: "CHAR", declared: "CHAR(3)", length: 3 });
  assert.deepEqual(columnMeta("B", sqlType("VARBINARY(8)")), { name: "B", typeName: "VARBINARY", declared: "VARBINARY(8)", length: 8 });
  assert.deepEqual(columnMeta("D", sqlType("DECIMAL(10,3)")), { name: "D", typeName: "DECIMAL", declared: "DECIMAL(10,3)", precision: 10, scale: 3 });
  assert.deepEqual(columnMeta("T", sqlType("TIMESTAMP(3) WITH TIME ZONE")), {
    name: "T",
    typeName: "TIMESTAMP WITH TIME ZONE",
    declared: "TIMESTAMP(3) WITH TIME ZONE",
    fractionalPrecision: 3,
  });
  assert.deepEqual(columnMeta("TM", sqlType("TIME(0)")), { name: "TM", typeName: "TIME", declared: "TIME(0)", fractionalPrecision: 0 });
  const interval = columnMeta("I", sqlType("INTERVAL DAY(3) TO SECOND(2)"));
  assert.equal(interval.typeName, "INTERVAL");
  assert.equal(interval.startField, "DAY");
  assert.equal(interval.endField, "SECOND");
  assert.equal(interval.leadingPrecision, 3);
  assert.equal(interval.fractionalPrecision, 2);
  const ym = columnMeta("Y", sqlType("INTERVAL YEAR TO MONTH"));
  assert.equal("fractionalPrecision" in ym, false);
  assert.equal(columnMeta("B", sqlType("BOOLEAN")).typeName, "BOOLEAN");
  assert.equal(columnMeta("R", sqlType("REAL")).typeName, "REAL");
  assert.equal(columnMeta("DP", sqlType("DOUBLE PRECISION")).typeName, "DOUBLE PRECISION");
});

test("행 하나를 JSON 배열로 인코딩한다", () => {
  const types = [sqlType("INTEGER"), sqlType("VARCHAR(10)"), sqlType("BIGINT"), sqlType("DECIMAL(5,2)")];
  const row = [sqlValue("1", "INTEGER"), null, sqlValue("5000000000", "BIGINT"), sqlValue("1.5", "DECIMAL(5,2)")];
  assert.equal(encodeRow(row, types), '[1,null,"5000000000","1.50"]');
});

// ---------------------------------------------------------------------------
// 행 묶음
// ---------------------------------------------------------------------------

test("행 묶음은 행 수 한도에서 멈춘다", () => {
  const types = [sqlType("INTEGER")];
  const rows = Array.from({ length: 25 }, (_, i) => [BigInt(i)]);
  const first = encodeBatch(rows, types, 0, 10, 1 << 20);
  assert.equal(first.encodedRows.length, 10);
  assert.equal(first.next, 10);
  const second = encodeBatch(rows, types, first.next, 10, 1 << 20);
  assert.equal(second.next, 20);
  const third = encodeBatch(rows, types, second.next, 10, 1 << 20);
  assert.equal(third.encodedRows.length, 5);
  assert.equal(third.next, 25);
  assert.equal(encodeBatch(rows, types, 25, 10, 1 << 20).encodedRows.length, 0);
});

test("행 묶음은 크기 한도에서 멈추고 행은 항상 하나 이상 들어간다", () => {
  const types = [sqlType("VARCHAR(65535)")];
  const rows = Array.from({ length: 10 }, () => ["x".repeat(1000)]);
  const batch = encodeBatch(rows, types, 0, 100, 3500);
  assert.equal(batch.encodedRows.length, 3, "3500바이트 안에는 1,00x바이트 행이 셋 들어간다");
  const big = [["y".repeat(5000)]];
  const single = encodeBatch(big, types, 0, 100, 100);
  assert.equal(single.encodedRows.length, 1, "한도를 넘는 행도 혼자서는 보낸다");
  // UTF-8 크기로 센다 : 한글 한 글자는 3바이트
  const korean = Array.from({ length: 4 }, () => ["한".repeat(1000)]);
  assert.equal(encodeBatch(korean, types, 0, 100, 7000).encodedRows.length, 2);
});

test("행 하나가 한 메시지에 들어가지 않으면 54000 이다", () => {
  const types = [sqlType("VARCHAR(65535)")];
  const huge = [["z".repeat(MAX_MESSAGE_BYTES)]];
  assert.throws(
    () => encodeBatch(huge, types, 0, 10, 1 << 20),
    (error) => error instanceof DbError && error.sqlState === "54000" && error.code === 8003,
  );
});

// ---------------------------------------------------------------------------
// 파라미터
// ---------------------------------------------------------------------------

test("파라미터 JSON 을 값으로 바꾼다", () => {
  const decoded = decodeParams([null, true, false, 42, -7, 1.5, "text", { binary: "ab12" }, 0]);
  assert.equal(decoded[0], null);
  assert.equal(decoded[1], true);
  assert.equal(decoded[2], false);
  assert.equal(decoded[3], 42n, "정수는 bigint");
  assert.equal(decoded[4], -7n);
  assert.equal(decoded[5], 1.5, "소수는 number");
  assert.equal(decoded[6], "text");
  assert.ok(Buffer.isBuffer(decoded[7]));
  assert.equal((decoded[7] as Buffer).toString("hex"), "ab12");
  assert.equal(decoded[8], 0n);
  assert.equal(decodeParams([Number.MAX_SAFE_INTEGER])[0], BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(decodeParams([-Number.MAX_SAFE_INTEGER])[0], -BigInt(Number.MAX_SAFE_INTEGER));
  void Decimal;
});

test("안전 정수를 벗어난 JSON 숫자는 반올림하지 않고 22003 으로 거부한다", () => {
  for (const unsafe of [2 ** 53, 9007199254740993, 1e21, -(2 ** 53), 9223372036854775807]) {
    assert.throws(
      () => decodeParams([unsafe]),
      (error) => error instanceof DbError && error.sqlState === "22003",
      String(unsafe),
    );
  }
  // 같은 값을 문자열로 보내면 정확하다.
  assert.equal(decodeParams(["9007199254740993"])[0], "9007199254740993");
});

test("이진 파라미터가 16진 문자열이 아니면 22018 이다", () => {
  assert.throws(() => decodeParams([{ binary: "XYZ" }]), (error) => error instanceof DbError && error.sqlState === "22018");
  assert.throws(() => decodeParams([{ binary: "ABC" }]), (error) => error instanceof DbError && error.sqlState === "22018");
  assert.equal((decodeParams([{ binary: "" }])[0] as Buffer).length, 0);
});
