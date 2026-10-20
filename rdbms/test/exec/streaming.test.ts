/** 조회 파이프라인·파일 커서·협력 실행의 동시성 회귀 시험. 상세 8-2, 9, 10. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { setupApp, selectStrings, state, tempDir } from "./helpers.js";
import { Database } from "../../src/session/session.js";
import { RowSpool } from "../../src/exec/rowSpool.js";
import { INTEGER_TYPE, varcharType } from "../../src/types/dataType.js";
import { Execution } from "../../src/exec/work.js";

test("파일 결과는 순차·되돌아간 접근과 배열 API를 지원하고 정리된다", () => {
  let closed = 0; const spool = new RowSpool(() => closed++);
  try {
    for (let i = 0; i < 100; i++) spool.append([BigInt(i), "한글"], [INTEGER_TYPE, varcharType(10)]);
    const rows = spool.rows();
    assert.equal(rows.length, 100); assert.deepEqual(rows[99], [99n, "한글"]); assert.deepEqual(rows[0], [0n, "한글"]);
    assert.deepEqual(rows.map(row => row[0]), Array.from({length:100}, (_, i) => BigInt(i)));
  } finally { spool.close(); spool.close(); }
  assert.equal(closed, 1); assert.equal(fs.existsSync(spool.directory), false);
});

test("결과 파일 생성 실패는 디렉토리를 남기지 않고 짧은 쓰기도 모두 기록한다", t => {
  let directory = "";
  const mkdtemp = fs.mkdtempSync;
  const make = t.mock.method(fs, "mkdtempSync", (prefix: string) => directory = mkdtemp(prefix));
  const open = t.mock.method(fs, "openSync", () => { throw new Error("spool open failure"); });
  try { assert.throws(() => new RowSpool(() => {}), /spool open failure/); }
  finally { open.mock.restore(); make.mock.restore(); }
  assert.ok(directory);
  assert.equal(fs.existsSync(directory), false);

  const spool = new RowSpool(() => {});
  const write = fs.writeSync;
  const shortWrite = t.mock.method(fs, "writeSync", (fd: number, bytes: Buffer, offset: number) => write(fd, bytes, offset, 1));
  try {
    spool.append([42n, "한글"], [INTEGER_TYPE, varcharType(10)]);
    assert.deepEqual(spool.rows()[0], [42n, "한글"]);
  } finally { shortWrite.mock.restore(); spool.close(); }
});

for (const sql of [
  "SELECT * FROM T", "SELECT N, V FROM T WHERE N >= 30 OFFSET 2 ROWS FETCH NEXT 7 ROWS ONLY",
  "SELECT N FROM T WHERE N = ?", "SELECT CAST(? AS DECIMAL(12,0))", "SELECT N FROM T ORDER BY N DESC",
  "SELECT ?, ?, ?",
  "SELECT COUNT(*), SUM(N) FROM T", "SELECT A.N FROM T A CROSS JOIN T B WHERE A.N = 1 FETCH FIRST 3 ROWS ONLY",
  "SELECT N FROM T UNION ALL SELECT N FROM T", "SELECT DISTINCT V FROM T",
]) test(`스트리밍/구체화 결과가 기존 실행과 같다: ${sql}`, async t => {
  const {db, session} = setupApp(t); t.after(() => db.close());
  session.execute("CREATE TABLE T (N INTEGER PRIMARY KEY, V VARCHAR(100))");
  session.execute("INSERT INTO T VALUES " + Array.from({length:50}, (_, i) => `(${i}, '값${i % 4}')`).join(","));
  const params = sql === "SELECT ?, ?, ?" ? [42n, "한글", null] : sql.includes("?") ? ["42"] : [];
  const expected = selectStrings(session.execute(sql, params));
  const actual = await session.executeAsync(sql, params, session.createExecution());
  assert.deepEqual(selectStrings(actual), expected);
  if (actual.kind === "select") actual.dispose?.();
});

test("파일 커서는 실행 시점 결과를 유지하며 커밋·DDL·닫기와 독립이다", async t => {
  const {db, session} = setupApp(t); t.after(() => db.close());
  session.execute("CREATE TABLE T (N INTEGER)"); session.execute("INSERT INTO T VALUES (1), (2), (3)");
  const result = await session.executeAsync("SELECT * FROM T", [], session.createExecution());
  session.execute("DELETE FROM T"); session.execute("DROP TABLE T");
  assert.deepEqual(selectStrings(result).rows, [["1"],["2"],["3"]]);
  if (result.kind === "select") result.dispose?.();
});

test("양보 중 다른 세션이 커밋해도 UPDATE 값을 잃지 않는다", { timeout:180000 }, async t => {
  // 값 보존을 검사하는 시험이므로 느린 런타임의 재시도가 기본 30초 제한에 걸리지 않게 한다.
  const db = Database.open(tempDir(t), { lockTimeoutMs:120000, onWarning:() => {} });
  t.after(() => db.close());
  const session = db.createSession({});
  session.execute("CREATE TABLESPACE APP"); session.execute("USE APP");
  session.execute("CREATE TABLE T (N INTEGER PRIMARY KEY, V INTEGER)");
  session.execute("INSERT INTO T VALUES " + Array.from({length:1000}, (_, i) => `(${i}, 0)`).join(","));
  const clients = Array.from({length:4}, () => db.createSession({ tablespace:"APP" }));
  await Promise.all(clients.map(client => client.executeAsync("UPDATE T SET V = V + 1")));
  assert.deepEqual(selectStrings(session.execute("SELECT MIN(V), MAX(V) FROM T")).rows, [["4", "4"]]);
});

test("부분 변경 후 취소와 같은 세션의 동기 호출을 검사한다", async t => {
  const {db, session} = setupApp(t); t.after(() => db.close());
  session.execute("CREATE TABLE T (N INTEGER PRIMARY KEY, V INTEGER)");
  session.execute("INSERT INTO T VALUES " + Array.from({length:2000}, (_, i) => `(${i}, 0)`).join(","));
  session.execute("BEGIN"); session.execute("INSERT INTO T VALUES (-1, 99)");
  const execution = new Execution();
  const pending = session.executeAsync("UPDATE T SET V = V + 1", [], execution);
  const failed = assert.rejects(pending, state("57014"));
  await new Promise<void>(resolve => setTimeout(resolve, 15));
  assert.throws(() => session.execute("SELECT 1"), state("25001"));
  session.cancelExecution(execution); await failed;
  assert.deepEqual(selectStrings(session.execute("SELECT MIN(V), MAX(V) FROM T WHERE N >= 0")).rows, [["0", "0"]]);
  assert.deepEqual(selectStrings(session.execute("SELECT V FROM T WHERE N = -1")).rows, [["99"]]);
});
