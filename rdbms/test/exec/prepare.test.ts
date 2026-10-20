/** 실행 없는 분석·준비 문장 수명과 문장 단위 취소 회귀 시험. PD-2 ~ PD-4. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { setupApp, selectStrings, state } from "./helpers.js";
import { NULL_LITERAL_TYPE, formatDataType } from "../../src/types/dataType.js";
import { Execution, runAsync, sortWork } from "../../src/exec/work.js";

test("prepare/describe는 DML·DDL·세션 설정·잠금·파일을 바꾸지 않는다", async t => {
  const { db, session } = setupApp(t); t.after(() => db.close());
  session.execute("CREATE TABLE T (N INTEGER PRIMARY KEY, V DECIMAL(12,2))");
  session.execute("BEGIN"); session.execute("INSERT INTO T VALUES (1, 2.50)");
  const before = { txn: session.inTransaction, changes: session.hasUncommittedChanges, auto: session.autocommit, space: session.currentTablespace };
  const files = db.manager.listStatus().map(status => ({ path: status.dataFile, bytes: fs.readFileSync(status.dataFile) }));
  for (const sql of ["INSERT INTO T VALUES (?, ?)", "UPDATE T SET V = ? WHERE N = ?", "DELETE FROM T WHERE N = ?", "CREATE TABLE Q (X INTEGER)", "USE SYSTEM", "SET AUTOCOMMIT OFF", "COMMIT"]) {
    const prepared = session.prepare(sql); session.describe(prepared.statement); session.closePrepared(prepared.statement);
  }
  assert.deepEqual({ txn: session.inTransaction, changes: session.hasUncommittedChanges, auto: session.autocommit, space: session.currentTablespace }, before);
  for (const file of files) assert.deepEqual(fs.readFileSync(file.path), file.bytes);
  assert.deepEqual(selectStrings(session.execute("SELECT * FROM T")).rows, [["1", "2.50"]]);
  assert.throws(() => session.execute("SELECT * FROM Q"), state("42P01"));
  assert.ok(files.length > 0);
});

for (const [sql, types] of [
  ["SELECT 1 AS N", ["INTEGER"]],
  ["SELECT CAST(? AS DECIMAL(12,0)) AS N", ["DECIMAL(12,0)"]],
  ["SELECT A.N, B.V FROM T A LEFT JOIN T B ON A.N = B.N", ["INTEGER", "DECIMAL(12,2)"]],
  ["SELECT CASE WHEN N = 1 THEN V ELSE CAST(0 AS DECIMAL(12,2)) END FROM T", ["DECIMAL(12,2)"]],
  ["SELECT COUNT(*), SUM(V) FROM T GROUP BY N HAVING COUNT(*) > 0", ["BIGINT", "DECIMAL(12,2)"]],
  ["SELECT N FROM T UNION ALL SELECT N FROM T", ["INTEGER"]],
  ["SELECT (SELECT X.V FROM T X WHERE X.N = O.N) AS V FROM T O", ["DECIMAL(12,2)"]],
] as const) test(`행 없는 분석: ${sql}`, t => {
  const { db, session } = setupApp(t); t.after(() => db.close());
  session.execute("CREATE TABLE T (N INTEGER, V DECIMAL(12,2))");
  const p = session.prepare(sql);
  assert.deepEqual(p.columns.map(c => formatDataType(c.type)), types);
  assert.equal(session.inTransaction, false);
});

test("미정 파라미터·CAST·컬럼 문맥·타입 힌트와 잘못된 문장을 구분한다", t => {
  const { db, session } = setupApp(t); t.after(() => db.close());
  session.execute("CREATE TABLE T (N INTEGER, V DECIMAL(12,2))");
  const p = session.prepare("SELECT ? AS X");
  assert.equal(p.parameters[0], null); assert.equal(p.columns[0]!.type, NULL_LITERAL_TYPE);
  assert.equal(formatDataType(session.describe(p.statement, ["TIMESTAMP(6) WITH TIME ZONE"]).columns[0]!.type), "TIMESTAMP(6) WITH TIME ZONE");
  assert.equal(session.prepare("UPDATE T SET V = ? WHERE N = ?").parameters.map(v => v?.name).join(), "DECIMAL,INTEGER");
  assert.equal(session.prepare("SELECT CAST(? AS DECIMAL(12,0))").parameters[0]!.kind, "DECIMAL");
  assert.throws(() => session.describe(p.statement, []), state("07001"));
  assert.throws(() => session.prepare("SELECT BAD FROM T"), state("42703"));
  assert.throws(() => session.prepare("SELECT N FROM T WHERE BAD = 0"), state("42703"));
  assert.throws(() => session.prepare("SELECT * FROM MISSING"), state("42P01"));
  assert.throws(() => session.prepare("SELECT EXISTS (SELECT N FROM MISSING)"), state("42P01"));
  assert.throws(() => session.prepare("SELECT N FROM T WHERE FALSE AND BAD = 1"), state("42703"));
  assert.throws(() => session.prepare("SELECT CASE WHEN TRUE THEN 1 WHEN BAD = 1 THEN 2 END FROM T"), state("42703"));
});

test("IN·BETWEEN·CASE 분석은 모든 피연산자를 검사하고 컬럼 타입을 전달한다", t => {
  const { db, session } = setupApp(t); t.after(() => db.close());
  session.execute("CREATE TABLE T (N INTEGER, V DECIMAL(12,2))");
  for (const sql of [
    "SELECT N FROM T WHERE N IN (BAD)",
    "SELECT N FROM T WHERE NULL IN (BAD)",
    "SELECT N FROM T WHERE N IN (1, (SELECT BAD FROM T))",
  ]) assert.throws(() => session.prepare(sql), state("42703"));
  for (const sql of [
    "SELECT N FROM T WHERE N IN (?, ?)",
    "SELECT N FROM T WHERE N BETWEEN ? AND ?",
    "SELECT CASE N WHEN ? THEN V WHEN ? THEN V END FROM T",
  ]) assert.deepEqual(session.prepare(sql).parameters.map(type => type?.name), ["INTEGER", "INTEGER"]);
  for (const sql of [
    "SELECT ? IN (SELECT N FROM T)",
    "SELECT ? = ANY (SELECT N FROM T)",
    "SELECT ? >= ALL (SELECT N FROM T)",
  ]) assert.equal(session.prepare(sql).parameters[0]?.name, "INTEGER");
  assert.equal(session.prepare("SELECT 1 IN (1 / 0)").columns[0]?.type.name, "BOOLEAN");
  assert.equal(session.inTransaction, false);
});

test("준비 문장 반복 실행·한도·해제·세션 경계·무효화", async t => {
  const { db, session } = setupApp(t); t.after(() => db.close());
  session.execute("CREATE TABLE T (N INTEGER)");
  const p = session.prepare("INSERT INTO T VALUES (?)");
  await session.executePreparedAsync(p.statement, [1n]); await session.executePreparedAsync(p.statement, [2n]);
  await assert.rejects(session.executePreparedAsync(p.statement, []), state("07001"));
  const other = db.createSession({ tablespace: "APP" });
  assert.throws(() => other.describe(p.statement), state("26000"));
  session.closePrepared(p.statement); session.closePrepared(p.statement);
  await assert.rejects(session.executePreparedAsync(p.statement, [3n]), state("26000"));
  const prepared = session.prepare("SELECT * FROM T");
  session.execute("ALTER TABLE T ADD X INTEGER");
  assert.throws(() => session.describe(prepared.statement), state("0A000"));
  for (let i = 0; i < 63; i++) session.prepare("SELECT 1");
  assert.throws(() => session.prepare("SELECT 1"), state("53400"));
  session.close(); assert.throws(() => session.describe(prepared.statement), state("08003"));
});

test("타입이 정해진 준비 문장도 NULL을 모든 타입의 NULL로 바인딩한다", async t => {
  const { db, session } = setupApp(t); t.after(() => db.close());
  session.execute("CREATE TABLE T (N INTEGER, V DECIMAL(38,9), TS TIMESTAMP(6), B VARBINARY, FLAG BOOLEAN)");
  const insert = session.prepare("INSERT INTO T VALUES (?, ?, ?, ?, ?)");
  await session.executePreparedAsync(insert.statement, [null, null, null, null, null]);
  const stored = session.execute("SELECT * FROM T");
  assert.equal(stored.kind, "select");
  if (stored.kind === "select") assert.deepEqual(stored.rows, [[null, null, null, null, null]]);
  const select = session.prepare("SELECT CAST(? AS DECIMAL(12,0)), CAST(? AS DATE)");
  const selected = await session.executePreparedAsync(select.statement, [null, null]);
  assert.equal(selected.kind, "select");
  if (selected.kind === "select") assert.deepEqual(selected.rows, [[null, null]]);
  session.execute("CREATE TABLE REQUIRED (N INTEGER NOT NULL)");
  const required = session.prepare("INSERT INTO REQUIRED VALUES (?)");
  await assert.rejects(session.executePreparedAsync(required.statement, [null]), state("23502"));
});

test("USE 왕복·같은 이름 재생성도 준비 문장을 무효화하고 잘못된 타입 힌트는 거절한다", t => {
  const { db, session } = setupApp(t); t.after(() => db.close());
  session.execute("CREATE TABLE T (N INTEGER)");
  const first = session.prepare("SELECT * FROM T"); session.execute("USE SYSTEM"); session.execute("USE APP");
  assert.throws(() => session.describe(first.statement), state("0A000"));
  const second = session.prepare("SELECT * FROM T"); session.execute("DROP TABLE T"); session.execute("CREATE TABLE T (N INTEGER)");
  assert.throws(() => session.describe(second.statement), state("0A000"));
  assert.throws(() => session.prepare("SELECT ?", ["INTEGER) AS X"]), state("22023"));
  assert.equal(session.prepare("SELECT 1 / 0").columns[0]!.type.name, "INTEGER");
});

test("뷰 전용 권한으로 describe·SYS_COLUMNS가 동작하고 권한 회수는 다음 실행에 반영된다", async t => {
  const { db, session } = setupApp(t); t.after(() => db.close());
  session.execute("CREATE TABLE T (N INTEGER, V DECIMAL(12,2))");
  session.execute("CREATE VIEW V (A, B) AS SELECT N, V FROM T");
  session.execute("CREATE USER U IDENTIFIED BY 'pw'"); session.execute("GRANT SELECT ON APP.V TO U");
  const user = db.createSession({ user: "U" });
  const p = user.prepare("SELECT * FROM APP.V"); assert.deepEqual(p.columns.map(c => c.name), ["A", "B"]);
  const columns = selectStrings(user.execute("SELECT TABLE_NAME, COLUMN_NAME FROM SYSTEM.SYS_COLUMNS ORDER BY ORDINAL_POSITION")).rows;
  assert.deepEqual(columns, [["V", "A"], ["V", "B"]]);
  assert.throws(() => user.prepare("SELECT * FROM APP.T"), state("42501"));
  session.execute("REVOKE SELECT ON APP.V FROM U");
  await assert.rejects(user.executePreparedAsync(p.statement), state("42501"));
});

test("한정하지 않은 인덱스 이름은 대상 테이블의 테이블스페이스를 따른다", t => {
  const { db, session } = setupApp(t); t.after(() => db.close());
  session.execute("CREATE TABLE T (N INTEGER)"); session.execute("USE SYSTEM");
  session.execute("CREATE INDEX IX ON APP.T (N)");
  assert.ok(db.manager.requireCatalog("APP").data.indexes["IX"]);
  session.execute("DROP INDEX APP.IX");
});

test("CPU 질의와 정렬은 이벤트 루프를 양보하고 취소 후 연결이 유지된다", async t => {
  const { db, session } = setupApp(t); t.after(() => db.close());
  session.execute("CREATE TABLE T (N INTEGER)");
  session.execute("INSERT INTO T VALUES " + Array.from({length: 180}, (_, i) => `(${i})`).join(","));
  const execution = new Execution();
  let tick = false;
  const result = session.executeAsync("SELECT A.N FROM T A CROSS JOIN T B CROSS JOIN T C ORDER BY A.N DESC", [], execution);
  const failed = assert.rejects(result, state("57014"));
  setImmediate(() => { tick = true; session.cancelExecution(execution); });
  await failed; assert.equal(tick, true); assert.equal(session.isClosed, false);
  assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM T")).rows, [["180"]]);
  const sortExecution = new Execution();
  const sort = runAsync(sortWork(Array.from({length: 200000}, (_, i) => 200000-i), (a,b) => a-b), sortExecution);
  const sortFailed = assert.rejects(sort, state("57014"));
  setImmediate(() => sortExecution.cancel()); await sortFailed;
});

test("DML 취소는 앞선 변경을 보존하고 해당 문장의 변경만 되돌린다", async t => {
  const { db, session } = setupApp(t); t.after(() => db.close());
  session.execute("CREATE TABLE T (N INTEGER)");
  session.execute("INSERT INTO T VALUES " + Array.from({length: 200}, (_, i) => `(${i})`).join(","));
  session.execute("BEGIN"); session.execute("INSERT INTO T VALUES (-1)");
  const execution = new Execution();
  const pending = session.executeAsync("INSERT INTO T SELECT A.N FROM T A CROSS JOIN T B CROSS JOIN T C", [], execution);
  const failed = assert.rejects(pending, state("57014"));
  setImmediate(() => session.cancelExecution(execution)); await failed;
  assert.equal(session.inTransaction, true);
  assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM T")).rows, [["201"]]);
  session.execute("COMMIT");
  assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM T WHERE N = -1")).rows, [["1"]]);
});
