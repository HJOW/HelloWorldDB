/** 코드 점검에서 찾은 결과 변환과 세션 재사용 결함의 실제 서버 회귀 시험이다. */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { connect, createPool } from "../src/index.js";
import { TestServer } from "./helpers/server.js";

const server = await TestServer.start({ after: (fn) => after(fn) });
const options = { port: server.port, user: "SYSTEM", password: "HelloWorldDB" };

test("records는 __proto__ 컬럼과 중복 컬럼의 마지막 값을 보존한다", async () => {
  const connection = await connect(options);
  try {
    const result = await connection.query('SELECT 1 AS "__proto__", 2 AS "constructor", 3 AS "__proto__"');
    const record = result.records()[0]!;
    assert.equal(Object.getPrototypeOf(record), Object.prototype);
    assert.equal(Object.hasOwn(record, "__proto__"), true);
    assert.equal(record["__proto__"], 3);
    assert.equal(record["constructor"], 2);
  } finally { await connection.close(); }
});

test("주석이 섞인 AUTOCOMMIT과 ROLLBACK TO의 트랜잭션 상태를 보존한다", async () => {
  const connection = await connect(options);
  try {
    await connection.query("SET /* a */ AUTOCOMMIT /* b */ OFF; -- tail");
    assert.equal(connection.autoCommit, false);
    await connection.query("SELECT 1");
    await connection.query("SET AUTOCOMMIT ON /* tail */");
    assert.equal(connection.autoCommit, true);
    assert.equal(connection.inTransaction, false);
    await connection.begin();
    await connection.query("SAVEPOINT S");
    await connection.query("ROLLBACK /* comment */ TO S");
    assert.equal(connection.inTransaction, true);
    await connection.rollback();
  } finally { await connection.close(); }
});

test("풀 반환 뒤에는 주석이 든 ROLLBACK TO 앞의 미커밋 행이 남지 않는다", async () => {
  const pool = createPool({ ...options, max: 1 });
  try {
    const first = await pool.acquire();
    await first.query("CREATE TABLE ND_REVIEW_TXN (ID INTEGER)");
    await first.begin();
    await first.query("INSERT INTO ND_REVIEW_TXN VALUES (1)");
    await first.query("SAVEPOINT S");
    await first.query("ROLLBACK /* comment */ TO S");
    first.release();
    const second = await pool.acquire();
    assert.equal((await second.query("SELECT COUNT(*) FROM ND_REVIEW_TXN")).rows[0]![0], 0n);
    second.release();
  } finally { await pool.close({ force: true }); }
});

test("풀 반환 때 읽다 남긴 커서도 닫아 다음 대여에서 커서 한도가 쌓이지 않는다", async () => {
  const pool = createPool({ ...options, max: 1 });
  try {
    for (let i = 0; i < 18; i++) {
      const connection = await pool.acquire();
      const cursor = await connection.cursor("SELECT 1 UNION ALL SELECT 2", [], { fetchSize: 1 });
      connection.release();
      const next = await pool.acquire();
      assert.deepEqual(await cursor.fetch(), []);
      next.release();
    }
  } finally { await pool.close({ force: true }); }
});

test("풀은 USE와 타임존 변경을 다음 대여에 넘기지 않는다", async () => {
  const pool = createPool({ ...options, max: 1, timeZone: "+09:00" });
  try {
    const first = await pool.acquire();
    await first.query("CREATE TABLESPACE ND_REVIEW_SPACE");
    await first.query("USE ND_REVIEW_SPACE");
    await first.query("SET TIME ZONE '-05:00'");
    first.release();
    const second = await pool.acquire();
    const result = await second.query("SELECT TABLESPACE_NAME FROM SYS_SESSIONS WHERE SESSION_ID = ?", [second.session.id]);
    assert.deepEqual(result.rows, [["SYSTEM"]]);
    assert.match(String((await second.query("SELECT CURRENT_TIMESTAMP")).rows[0]![0]), /\+09:00$/);
    second.release();
  } finally { await pool.close({ force: true }); }
});

test("BEGIN 응답 전에 반환해도 초기화가 끝난 뒤 다음 대여로 넘긴다", async () => {
  const pool = createPool({ ...options, max: 1 });
  try {
    const first = await pool.acquire();
    const beginning = first.begin();
    first.release();
    await beginning;
    const second = await pool.acquire();
    assert.equal(second.inTransaction, false);
    assert.deepEqual((await second.query("SELECT IN_TRANSACTION FROM SYS_SESSIONS WHERE SESSION_ID = ?", [second.session.id])).rows, [["NO"]]);
    second.release();
  } finally { await pool.close({ force: true }); }
});

test("기본 테이블스페이스가 없는 세션의 USE 변경은 새 접속으로 초기화한다", async () => {
  const admin = await connect(options);
  await admin.query("CREATE USER ND_REVIEW_NO_DEFAULT IDENTIFIED BY 'pw'");
  await admin.close();
  const pool = createPool({ ...options, user: "ND_REVIEW_NO_DEFAULT", password: "pw", max: 1 });
  try {
    const first = await pool.acquire();
    assert.equal(first.session.tablespace, null);
    await first.query("USE SYSTEM");
    first.release();
    const second = await pool.acquire();
    assert.notEqual(second.session.id, first.session.id);
    assert.equal(second.session.tablespace, null);
    assert.equal(first.isClosed, true);
    second.release();
  } finally { await pool.close({ force: true }); }
});
