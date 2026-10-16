/**
 * 문장 실행, 파라미터 바인딩, 타입 대응, 결과 나누어 받기, 오류 객체 시험 (12-3, 12-4, 12-5).
 * 실제 rdbms 를 띄워 TCP 와 UDP 로 수행한다.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Connection, DbError, connect } from "../src/index.js";
import type { ConnectOptions, Row } from "../src/index.js";
import { TestServer } from "./helpers/server.js";

const server = await TestServer.start({ after: (fn) => after(fn) });
const ADMIN = { user: "SYSTEM", password: "HelloWorldDB" } as const;
const KINDS = ["tcp", "udp"] as const;

function open(extra: Partial<ConnectOptions> = {}): Promise<Connection> {
  return connect({ port: server.port, ...ADMIN, ...extra });
}

async function failure(promise: Promise<unknown>): Promise<DbError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DbError, `DbError 여야 한다: ${String(error)}`);
    return error;
  }
  throw new Error("실패해야 한다.");
}

const TYPES_DDL =
  "CREATE TABLE ND_TYPES (ID INTEGER PRIMARY KEY, C CHAR(5), V NVARCHAR(10), SI SMALLINT, BI BIGINT, N DECIMAL(12,4), R REAL, D DOUBLE PRECISION, B BOOLEAN, " +
  "DT DATE, T TIME(3), TS TIMESTAMP(6), TSZ TIMESTAMP(3) WITH TIME ZONE, IV INTERVAL YEAR TO MONTH, IV2 INTERVAL DAY TO SECOND, BN BINARY(4), VB VARBINARY(10))";

test("타입 대응 : 모든 타입을 리터럴로 넣고 읽으면 표의 JavaScript 값으로 온다 (TCP 와 UDP)", async () => {
  const admin = await open();
  await admin.query(TYPES_DDL);
  await admin.query(
    "INSERT INTO ND_TYPES VALUES (1, 'ab', '한글😀', -32768, 9223372036854775807, 12345678.1235, 1.5, 2.25, TRUE, DATE '2026-10-16', TIME '12:34:56.789', " +
      "TIMESTAMP '2026-10-16 12:34:56.123456', TIMESTAMP '2026-10-16 12:34:56.123+09:00', INTERVAL '1-2' YEAR TO MONTH, INTERVAL '3 04:05:06' DAY TO SECOND, X'0A0B0C0D', X'00FF')",
  );
  await admin.query("INSERT INTO ND_TYPES (ID) VALUES (2)");
  for (const protocol of KINDS) {
    const db = await open({ protocol });
    const result = await db.query("SELECT * FROM ND_TYPES ORDER BY ID");
    assert.deepEqual(
      result.columns.map((c) => c.typeName),
      ["INTEGER", "CHAR", "VARCHAR", "SMALLINT", "BIGINT", "DECIMAL", "REAL", "DOUBLE PRECISION", "BOOLEAN", "DATE", "TIME", "TIMESTAMP", "TIMESTAMP WITH TIME ZONE", "INTERVAL", "INTERVAL", "BINARY", "VARBINARY"],
      protocol,
    );
    assert.equal(result.columns[5]?.declared, "DECIMAL(12,4)");
    assert.equal(result.columns[2]?.length, 10);
    const [full, empty] = result.rows as [Row, Row];
    assert.deepEqual(full.slice(0, 3), [1, "ab   ", "한글😀"], "정수는 number, CHAR 는 공백으로 채운 string, 유니코드 그대로");
    assert.equal(full[3], -32768);
    assert.equal(full[4], 9223372036854775807n, "BIGINT 는 bigint 로 정밀도를 잃지 않는다");
    assert.equal(full[5], "12345678.1235", "NUMERIC 은 string");
    assert.equal(full[6], 1.5);
    assert.equal(full[7], 2.25);
    assert.equal(full[8], true);
    assert.deepEqual(full.slice(9, 14), ["2026-10-16", "12:34:56.789", "2026-10-16 12:34:56.123456", "2026-10-16 12:34:56.123+09:00", "1-02"], "날짜시간은 string");
    assert.equal(full[14], "3 04:05:06.000000");
    assert.ok(Buffer.isBuffer(full[15]) && Buffer.isBuffer(full[16]), "이진은 Buffer");
    assert.deepEqual([...(full[15] as Buffer)], [0x0a, 0x0b, 0x0c, 0x0d]);
    assert.deepEqual([...(full[16] as Buffer)], [0x00, 0xff]);
    assert.deepEqual(empty.slice(1), Array.from({ length: 16 }, () => null), "NULL 은 null");
    await db.close();
  }
  await admin.close();
});

test("파라미터 : JavaScript 값을 타입에 맞게 바인딩하고 읽으면 같은 값이다 (TCP 와 UDP)", async () => {
  const admin = await open();
  for (const [index, protocol] of KINDS.entries()) {
    const db = await open({ protocol });
    const id = 100 + index;
    await db.query("INSERT INTO ND_TYPES VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      id, "ab", "한글😀", -32768, 9223372036854775807n, "12345678.1235", 1.5, 2.25, true, "2026-10-16", "12:34:56.789", "2026-10-16 12:34:56.123456",
      new Date(Date.UTC(2026, 9, 16, 12, 34, 56, 789)), "1-2", "3 04:05:06", Buffer.from("0A0B0C0D", "hex"), new Uint8Array([0, 255]),
    ]);
    const row = (await db.query("SELECT * FROM ND_TYPES WHERE ID = ?", [id])).rows[0] as Row;
    assert.equal(row[4], 9223372036854775807n, protocol);
    assert.equal(row[5], "12345678.1235");
    assert.equal(row[12], "2026-10-16 12:34:56.789+00:00", "Date 는 UTC 시각 그대로 TIMESTAMP WITH TIME ZONE 에 들어간다");
    assert.deepEqual([...(row[15] as Buffer)], [10, 11, 12, 13]);
    assert.deepEqual([...(row[16] as Buffer)], [0, 255]);
    await db.close();
  }
  await admin.close();
});

test("파라미터 : undefined 와 null 은 NULL, ? 의 개수가 맞지 않으면 07001 이다", async () => {
  const db = await open();
  await db.query("CREATE TABLE ND_NULLS (ID INTEGER PRIMARY KEY, V VARCHAR(20))");
  await db.query("INSERT INTO ND_NULLS VALUES (?, ?)", [1, undefined]);
  await db.query("INSERT INTO ND_NULLS VALUES (?, ?)", [2, null]);
  await db.query("INSERT INTO ND_NULLS VALUES (3, '')");
  assert.deepEqual((await db.query("SELECT ID FROM ND_NULLS WHERE V IS NULL ORDER BY ID")).rows, [[1], [2]]);
  assert.deepEqual((await db.query("SELECT V FROM ND_NULLS WHERE ID = 3")).rows, [[""]], "빈 문자열은 NULL 이 아니다");
  assert.equal((await failure(db.query("SELECT ?", []))).sqlState, "07001");
  assert.equal((await failure(db.query("SELECT 1", [1]))).sqlState, "07001");
  await db.close();
});

test("파라미터는 문장의 일부가 아니라 값이다 (따옴표, 주석, SQL 조각이 들어 있어도)", async () => {
  const db = await open();
  await db.query("CREATE TABLE ND_TEXT (ID INTEGER PRIMARY KEY, V VARCHAR(100))");
  const nasty = ["it's", "x'); DROP TABLE ND_TEXT; --", "/* c */ -- d", "줄\n바꿈\t탭", "𝒳😀", ""];
  for (const [index, text] of nasty.entries()) await db.query("INSERT INTO ND_TEXT VALUES (?, ?)", [index, text]);
  const rows = (await db.query("SELECT V FROM ND_TEXT ORDER BY ID")).rows;
  assert.deepEqual(rows.map((row) => row[0]), nasty);
  assert.equal((await db.query("SELECT COUNT(*) FROM ND_TEXT")).rows[0]?.[0], BigInt(nasty.length));
  await db.close();
});

test("BIGINT : 안전 정수를 넘는 값도 파라미터와 결과 양쪽에서 정확하다", async () => {
  const db = await open();
  await db.query("CREATE TABLE ND_BIG (ID BIGINT PRIMARY KEY, V BIGINT)");
  const values = [9007199254740993n, -9007199254740993n, 9223372036854775807n, -9223372036854775808n, 0n, 2n ** 53n];
  for (const value of values) await db.query("INSERT INTO ND_BIG VALUES (?, ?)", [value, value]);
  await db.query("INSERT INTO ND_BIG VALUES (?, ?)", [2 ** 60, 2 ** 60]); // 안전 정수를 넘는 number 도 문자열로 보내 정밀도를 지킨다.
  const rows = (await db.query("SELECT ID, V FROM ND_BIG ORDER BY ID")).rows;
  assert.deepEqual(
    rows.map((row) => row[0]),
    [-9223372036854775808n, -9007199254740993n, 0n, 2n ** 53n, 9007199254740993n, 2n ** 60n, 9223372036854775807n],
  );
  assert.ok(rows.every((row) => row[0] === row[1]));
  assert.equal((await failure(db.query("INSERT INTO ND_BIG VALUES (?, 1)", [9223372036854775808n]))).sqlState, "22003", "64비트를 넘으면 서버가 거부한다");
  await db.close();
});

test("NUMERIC : 부동소수를 거치지 않는 정확한 값이 문자열로 온다", async () => {
  const db = await open();
  const result = await db.query("SELECT CAST(? AS DECIMAL(20,10)) + CAST(? AS DECIMAL(20,10)), CAST(? AS DECIMAL(30,0))", ["0.1", "0.2", "123456789012345678901234567890"]);
  assert.deepEqual(result.rows[0], ["0.3000000000", "123456789012345678901234567890"]);
  assert.equal(result.columns[0]?.typeName, "DECIMAL");
  await db.close();
});

test("Date 파라미터 : 같은 순간이 타임존 없는 TIMESTAMP 에는 세션 타임존의 벽시계 시각으로, WITH TIME ZONE 에는 입력한 UTC 오프셋 그대로 들어간다", async () => {
  const db = await open({ timeZone: "+09:00" });
  await db.query("CREATE TABLE ND_TZ (ID INTEGER PRIMARY KEY, TS TIMESTAMP(3), TSZ TIMESTAMP(3) WITH TIME ZONE)");
  const instant = new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 678));
  await db.query("INSERT INTO ND_TZ VALUES (1, ?, ?)", [instant, instant]);
  assert.deepEqual((await db.query("SELECT TS, TSZ FROM ND_TZ")).rows[0], ["2026-01-02 12:04:05.678", "2026-01-02 03:04:05.678+00:00"]);
  await db.close();
});

test("DML 은 영향받은 행 수를, DDL 은 완료 메시지를 돌려준다", async () => {
  const db = await open();
  const ddl = await db.query("CREATE TABLE ND_DML (ID INTEGER PRIMARY KEY, V INTEGER)");
  assert.equal(typeof ddl.message, "string");
  assert.deepEqual([ddl.columns, ddl.rows], [[], []]);
  assert.equal((await db.query("INSERT INTO ND_DML VALUES (1, 10), (2, 20), (3, 30)")).rowCount, 3);
  assert.equal((await db.query("UPDATE ND_DML SET V = V + 1 WHERE ID >= 2")).rowCount, 2);
  assert.equal((await db.query("UPDATE ND_DML SET V = 0 WHERE ID = 99")).rowCount, 0);
  assert.equal((await db.query("DELETE FROM ND_DML WHERE ID = 1")).rowCount, 1);
  const select = await db.query("SELECT ID, V FROM ND_DML ORDER BY ID");
  assert.equal(select.rowCount, 2, "조회의 rowCount 는 받은 행 수");
  assert.equal(select.message, null);
  assert.deepEqual(select.records(), [{ ID: 2, V: 21 }, { ID: 3, V: 31 }]);
  assert.deepEqual((await db.query("SELECT 1 AS A, 'x' AS B")).records(), [{ A: 1, B: "x" }]);
  await db.close();
});

test("오류 객체 : SQLSTATE, 내부 오류 번호, 영문 메시지를 가지고 접속은 계속 쓸 수 있다", async () => {
  const db = await open();
  await db.query("CREATE TABLE ND_ERR (ID INTEGER PRIMARY KEY, V VARCHAR(5) NOT NULL)");
  await db.query("CREATE TABLE ND_ERR_CHILD (ID INTEGER PRIMARY KEY, P INTEGER REFERENCES ND_ERR)");
  await db.query("INSERT INTO ND_ERR VALUES (1, 'a')");
  const cases: Array<[string, string, string]> = [
    ["SELECT * FROM ND_NO_SUCH_TABLE", "42P01", "없는 테이블"],
    ["SELEC 1", "42601", "문법 오류"],
    ["INSERT INTO ND_ERR VALUES (1, 'b')", "23505", "PK 중복"],
    ["INSERT INTO ND_ERR VALUES (2, NULL)", "23502", "NOT NULL"],
    ["INSERT INTO ND_ERR_CHILD VALUES (1, 99)", "23503", "FK"],
    ["INSERT INTO ND_ERR VALUES (3, 'toolongvalue')", "22001", "길이 초과"],
    ["SELECT 1 / 0", "22012", "0 으로 나눔"],
    ["CREATE TABLE ND_ERR (X INTEGER)", "42P07", "이미 있는 테이블"],
    ["SELECT UNKNOWN_COLUMN FROM ND_ERR", "42703", "없는 컬럼"],
  ];
  for (const [sql, sqlState, what] of cases) {
    const error = await failure(db.query(sql));
    assert.equal(error.sqlState, sqlState, what);
    assert.equal(error.name, "DbError");
    assert.ok(Number.isInteger(error.code) && error.code > 0, `${what} : 내부 오류 번호`);
    assert.ok(error.message.length > 0 && /^[\x20-\x7e]+$/.test(error.message), `${what} : 영문 메시지 (${error.message})`);
    assert.equal(error.isConnectionError, false);
  }
  assert.equal((await db.query("SELECT COUNT(*) FROM ND_ERR")).rows[0]?.[0], 1n, "오류가 나도 접속은 그대로 쓸 수 있다");
  await db.close();
});

test("문법 오류는 SQL 문장 안의 위치(줄, 칸)를 가진다", async () => {
  const db = await open();
  const error = await failure(db.query("SELECT 1\n  FROM WHERE"));
  assert.equal(error.sqlState, "42601");
  assert.ok(error.position !== undefined);
  assert.equal(error.position.line, 2);
  assert.ok(error.position.column >= 3);
  assert.ok(error.position.offset >= 10);
  await db.close();
});

test("권한이 없으면 42501 이고, 권한을 받으면 된다", async () => {
  const admin = await open();
  await admin.query("CREATE TABLE ND_PRIV (N INTEGER)");
  await admin.query("CREATE USER ND_ALICE IDENTIFIED BY 'pw-a'");
  const alice = await open({ user: "ND_ALICE", password: "pw-a", tablespace: "SYSTEM" });
  assert.equal((await failure(alice.query("SELECT * FROM SYSTEM.ND_PRIV"))).sqlState, "42501");
  await admin.query("GRANT SELECT ON TABLE SYSTEM.ND_PRIV TO ND_ALICE");
  assert.deepEqual((await alice.query("SELECT * FROM SYSTEM.ND_PRIV")).rows, []);
  await alice.close();
  await admin.close();
});

test("잘못된 인자는 서버에 보내기 전에 예외로 알린다", async () => {
  const db = await open();
  await assert.rejects(() => db.query(""), TypeError);
  await assert.rejects(() => db.query("   "), TypeError);
  await assert.rejects(() => db.query(undefined as unknown as string), TypeError);
  await assert.rejects(() => db.query("SELECT ?", [Number.NaN]), RangeError);
  await assert.rejects(() => db.query("SELECT ?", [{} as never]), TypeError);
  await assert.rejects(() => db.query("SELECT 1", [], { fetchSize: 0 }), RangeError);
  assert.equal((await db.query("SELECT 1")).rows[0]?.[0], 1, "잘못된 인자 뒤에도 접속은 정상이다");
  await db.close();
});

test("큰 결과 : 묶음 크기보다 많은 행도 순서대로 모두 받는다 (TCP 와 UDP)", async () => {
  const admin = await open();
  await admin.query("CREATE TABLE ND_ROWS (ID INTEGER PRIMARY KEY, V VARCHAR(40))");
  for (let from = 0; from < 3000; from += 500) {
    const values = Array.from({ length: 500 }, (_, i) => `(${from + i}, 'row-${from + i}')`).join(", ");
    await admin.query(`INSERT INTO ND_ROWS VALUES ${values}`);
  }
  for (const protocol of KINDS) {
    const db = await open({ protocol });
    const small = await db.query("SELECT ID, V FROM ND_ROWS ORDER BY ID", [], { fetchSize: 77 });
    assert.equal(small.rows.length, 3000, protocol);
    assert.ok(small.rows.every((row, index) => row[0] === index && row[1] === `row-${index}`));
    const defaults = await db.query("SELECT ID FROM ND_ROWS ORDER BY ID");
    assert.equal(defaults.rows.length, 3000);
    await db.close();
  }
  const configured = await open({ fetchSize: 250 });
  assert.equal((await configured.query("SELECT ID FROM ND_ROWS")).rows.length, 3000);
  await configured.close();
  await admin.close();
});

test("커서 : 묶음 단위로 가져오고, 다 읽으면 빈 배열이며, 중간에 닫아도 된다", async () => {
  const db = await open();
  const cursor = await db.cursor("SELECT ID FROM ND_ROWS ORDER BY ID", [], { fetchSize: 1000 });
  assert.deepEqual(cursor.columns.map((c) => c.name), ["ID"]);
  const sizes: number[] = [];
  for (;;) {
    const rows = await cursor.fetch();
    if (rows.length === 0) break;
    sizes.push(rows.length);
  }
  assert.deepEqual(sizes, [1000, 1000, 1000], "첫 묶음은 execute 로 받은 것, 나머지는 fetch 로 받은 것");
  assert.deepEqual(await cursor.fetch(), []);
  await cursor.close();

  const partial = await db.cursor("SELECT ID FROM ND_ROWS ORDER BY ID", [], { fetchSize: 10 });
  assert.equal((await partial.fetch()).length, 10);
  assert.equal(partial.hasMoreOnServer, true);
  await partial.close();
  await partial.close(); // 두 번 닫아도 된다.
  assert.deepEqual(await partial.fetch(), [], "닫은 커서에서는 더 가져오지 않는다");

  const dml = await db.cursor("DELETE FROM ND_ROWS WHERE ID < 0");
  assert.deepEqual([dml.columns, await dml.fetch(), dml.rowCount], [[], [], 0], "조회가 아닌 문장은 빈 커서이다");
  await db.close();
});

test("커서는 접속당 16개까지이다 (53400). 닫으면 다시 열 수 있다", async () => {
  const db = await open();
  const cursors = [];
  for (let i = 0; i < 16; i++) cursors.push(await db.cursor("SELECT ID FROM ND_ROWS ORDER BY ID", [], { fetchSize: 10 }));
  assert.equal((await failure(db.cursor("SELECT ID FROM ND_ROWS ORDER BY ID", [], { fetchSize: 10 }))).sqlState, "53400");
  await cursors[0]?.close();
  const again = await db.cursor("SELECT ID FROM ND_ROWS ORDER BY ID", [], { fetchSize: 10 });
  assert.equal((await again.fetch()).length, 10);
  await again.close();
  for (const cursor of cursors) await cursor.close();
  await db.close();
});

test("stream : 비동기 반복자로 행을 하나씩 읽고, 중간에 멈추면 커서를 닫는다 (멈추기를 20번 해도 커서 한도에 걸리지 않는다)", async () => {
  const db = await open();
  let count = 0;
  let last = -1;
  for await (const row of db.stream("SELECT ID FROM ND_ROWS ORDER BY ID", [], { fetchSize: 400 })) {
    assert.equal(row[0], count);
    last = row[0] as number;
    count++;
  }
  assert.deepEqual([count, last], [3000, 2999]);
  for (let round = 0; round < 20; round++) {
    let seen = 0;
    for await (const row of db.stream("SELECT ID FROM ND_ROWS ORDER BY ID", [], { fetchSize: 5 })) {
      void row;
      if (++seen === 7) break;
    }
    assert.equal(seen, 7);
  }
  // 반복 중에 예외로 빠져나가도 닫힌다.
  await assert.rejects(async () => {
    for await (const row of db.stream("SELECT ID FROM ND_ROWS", [], { fetchSize: 5 })) {
      void row;
      throw new Error("중단");
    }
  }, /중단/);
  assert.equal((await db.query("SELECT 1")).rows[0]?.[0], 1);
  await db.close();
});

test("한 접속에 요청을 이어 보내도(파이프라이닝) 응답은 요청과 짝지어진다", async () => {
  for (const protocol of KINDS) {
    const db = await open({ protocol });
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => db.query("SELECT ? + 0", [i])));
    assert.deepEqual(results.map((r) => r.rows[0]?.[0]), Array.from({ length: 40 }, (_, i) => BigInt(i)), protocol); // 파라미터 산술은 BIGINT
    await db.close();
  }
});

test("큰 값 : 60,000자 문자열과 65,535바이트 이진 값을 파라미터로 보내고 받는다 (UDP 는 조각으로 나뉜다)", async () => {
  const admin = await open();
  await admin.query("CREATE TABLE ND_LOB (ID INTEGER PRIMARY KEY, T VARCHAR(65535), B VARBINARY(65535))");
  const text = Array.from({ length: 60_000 }, (_, i) => String.fromCharCode(0xac00 + (i % 1000))).join("");
  const bytes = Buffer.alloc(65_535);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
  for (const [index, protocol] of KINDS.entries()) {
    const db = await open({ protocol });
    await db.query("INSERT INTO ND_LOB VALUES (?, ?, ?)", [index, text, bytes]);
    const row = (await db.query("SELECT T, B FROM ND_LOB WHERE ID = ?", [index])).rows[0] as Row;
    assert.equal(row[0], text, protocol);
    assert.ok((row[1] as Buffer).equals(bytes), protocol);
    await db.close();
  }
  await admin.close();
});
