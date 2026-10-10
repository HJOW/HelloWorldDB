/**
 * 내장 함수와 파라미터 테스트 (6단계).
 * ANSI·공통·Oracle 호환 함수와 ? 바인딩을 본다.
 * 관련 사양 : AGENTS.md 상세 1-5
 * 구현 단계 : 6단계
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../../src/session/session.js";
import type { SqlValue } from "../../src/types/value.js";
import { selectStrings } from "./helpers.js";
import { setupApp } from "./helpers.js";
import { state } from "./helpers.js";

/** FROM 없는 스칼라 식 하나의 값을 돌려준다. */
function scalar(session: Session, sql: string, params: SqlValue[] = []): string {
  const rows = selectStrings(session.execute(sql, params)).rows;
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as string[]).length, 1);
  return (rows[0] as string[])[0] as string;
}

test("문자열 함수를 확인한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    assert.equal(scalar(session, "SELECT UPPER('hello')"), "HELLO");
    assert.equal(scalar(session, "SELECT LOWER('HeLLo')"), "hello");
    assert.equal(scalar(session, "SELECT LENGTH('한글ab')"), "4");
    assert.equal(scalar(session, "SELECT CHAR_LENGTH('한글ab')"), "4");
    assert.equal(scalar(session, "SELECT OCTET_LENGTH('한글ab')"), "8");
    assert.equal(scalar(session, "SELECT SUBSTRING('hello' FROM 2 FOR 3)"), "ell");
    assert.equal(scalar(session, "SELECT SUBSTR('hello', 2, 3)"), "ell");
    assert.equal(scalar(session, "SELECT SUBSTR('hello', 2)"), "ello");
    assert.equal(scalar(session, "SELECT POSITION('ll' IN 'hello')"), "3");
    assert.equal(scalar(session, "SELECT POSITION('z' IN 'hello')"), "0");
    assert.equal(scalar(session, "SELECT TRIM(BOTH 'x' FROM 'xxhex')"), "he");
    assert.equal(scalar(session, "SELECT TRIM(LEADING FROM '  hi  ')"), "hi  ");
    assert.equal(scalar(session, "SELECT TRIM(TRAILING FROM '  hi  ')"), "  hi");
    assert.equal(scalar(session, "SELECT LTRIM('xxhi', 'x')"), "hi");
    assert.equal(scalar(session, "SELECT RTRIM('hixx', 'x')"), "hi");
    assert.equal(scalar(session, "SELECT REPLACE('hello', 'l', 'L')"), "heLLo");
    assert.equal(scalar(session, "SELECT REPLACE('hello', 'l')"), "heo");
    assert.equal(scalar(session, "SELECT CONCAT('a', 'b', 'c')"), "abc");
    assert.equal(scalar(session, "SELECT UPPER(NULL)"), "NULL");
    assert.equal(scalar(session, "SELECT CONCAT('a', NULL)"), "NULL");
  } finally {
    db.close();
  }
});

test("수학 함수를 확인한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    assert.equal(scalar(session, "SELECT ABS(-5)"), "5");
    assert.equal(scalar(session, "SELECT ABS(-5.5)"), "5.5");
    assert.equal(scalar(session, "SELECT MOD(7, 3)"), "1");
    assert.equal(scalar(session, "SELECT MOD(-7, 3)"), "-1");
    assert.equal(scalar(session, "SELECT CEIL(2.1)"), "3");
    assert.equal(scalar(session, "SELECT FLOOR(-2.1)"), "-3");
    assert.equal(scalar(session, "SELECT POWER(2, 10)"), "1024");
    assert.equal(scalar(session, "SELECT SQRT(2)"), String(Math.sqrt(2)));
    assert.equal(scalar(session, "SELECT ROUND(2.5)"), "3");
    assert.equal(scalar(session, "SELECT ROUND(2.555, 2)"), "2.56");
    assert.equal(scalar(session, "SELECT ROUND(125, -1)"), "130");
    assert.throws(() => session.execute("SELECT SQRT(-1)"), state("22003"));
  } finally {
    db.close();
  }
});

test("날짜시간 함수와 EXTRACT를 확인한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE T (D DATE, TS TIMESTAMP(6))");
    session.execute("INSERT INTO T VALUES (DATE '2024-02-29', TIMESTAMP '2024-02-29 13:05:06.123456')");
    assert.deepEqual(selectStrings(session.execute("SELECT EXTRACT(YEAR FROM D), EXTRACT(MONTH FROM D), EXTRACT(DAY FROM D) FROM T")).rows, [["2024", "2", "29"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT EXTRACT(HOUR FROM TS), EXTRACT(MINUTE FROM TS), EXTRACT(SECOND FROM TS) FROM T")).rows, [["13", "5", "6"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT CURRENT_DATE FROM T")).rows.length, 1);
    const user = scalar(session, "SELECT CURRENT_USER");
    assert.equal(user, "SYSTEM");
    assert.deepEqual(selectStrings(session.execute("SELECT LOCALTIME, LOCALTIMESTAMP FROM T")).rows.length, 1);
    assert.deepEqual(selectStrings(session.execute("SELECT CURRENT_TIME, CURRENT_TIMESTAMP FROM T")).rows.length, 1);
    assert.equal(scalar(session, "SELECT COALESCE(NULL, NULL, 'x')"), "x");
    assert.equal(scalar(session, "SELECT NULLIF('a', 'a')"), "NULL");
    assert.equal(scalar(session, "SELECT NULLIF('a', 'b')"), "a");
  } finally {
    db.close();
  }
});

test("NVL, TO_CHAR, TO_DATE를 확인한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    assert.equal(scalar(session, "SELECT NVL(NULL, 'alt')"), "alt");
    assert.equal(scalar(session, "SELECT NVL('v', 'alt')"), "v");
    assert.equal(scalar(session, "SELECT NVL(NULL, 7)"), "7");
    // 날짜 형식
    assert.equal(scalar(session, "SELECT TO_CHAR(DATE '2024-03-05', 'YYYY-MM-DD')"), "2024-03-05");
    assert.equal(scalar(session, "SELECT TO_CHAR(DATE '2024-03-05', 'YY/MM/DD')"), "24/03/05");
    assert.equal(scalar(session, "SELECT TO_CHAR(TIMESTAMP '2024-03-05 14:07:09', 'YYYY-MM-DD HH24:MI:SS')"), "2024-03-05 14:07:09");
    assert.equal(scalar(session, "SELECT TO_CHAR(TIMESTAMP '2024-03-05 14:07:09', 'YYYY-MM-DD HH12:MI:SS PM')"), "2024-03-05 02:07:09 PM");
    assert.equal(scalar(session, "SELECT TO_CHAR(TIMESTAMP '2024-03-05 14:07:09.123456', 'SS.FF3')"), "09.123");
    assert.equal(scalar(session, "SELECT TO_CHAR(DATE '2024-03-05', '\"Y:\"YYYY')"), "Y:2024");
    assert.equal(scalar(session, "SELECT TO_CHAR(DATE '2024-03-05')"), "2024-03-05");
    // 숫자 형식
    assert.equal(scalar(session, "SELECT TO_CHAR(123, '999')"), " 123");
    assert.equal(scalar(session, "SELECT TO_CHAR(123, 'FM999')"), "123");
    assert.equal(scalar(session, "SELECT TO_CHAR(-45.6, 'FM999.99')"), "-45.60");
    assert.equal(scalar(session, "SELECT TO_CHAR(1234567, 'FM9,999,999')"), "1,234,567");
    assert.equal(scalar(session, "SELECT TO_CHAR(5, '000')"), " 005");
    // TO_DATE는 TIMESTAMP(0)을 돌려준다.
    assert.equal(scalar(session, "SELECT TO_DATE('2024-03-05', 'YYYY-MM-DD')"), "2024-03-05 00:00:00");
    assert.equal(scalar(session, "SELECT TO_DATE('2024-03-05 14:07:09', 'YYYY-MM-DD HH24:MI:SS')"), "2024-03-05 14:07:09");
    assert.equal(scalar(session, "SELECT TO_DATE('2024-03-05')"), "2024-03-05 00:00:00");
    // DATE 컬럼에 넣으면 날짜만 남는다.
    session.execute("CREATE TABLE D (D DATE)");
    session.execute("INSERT INTO D VALUES (TO_DATE('2024-03-05 14:07:09', 'YYYY-MM-DD HH24:MI:SS'))");
    assert.deepEqual(selectStrings(session.execute("SELECT * FROM D")).rows, [["2024-03-05"]]);
    assert.throws(() => session.execute("SELECT TO_DATE('nope', 'YYYY-MM-DD')"), state("22007"));
  } finally {
    db.close();
  }
});

test("집계 함수의 타입과 DISTINCT를 확인한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE N (A INTEGER, B DECIMAL(10,2), C DOUBLE PRECISION)");
    session.execute("INSERT INTO N VALUES (1, 10.00, 1.5), (2, 20.00, 2.5), (NULL, NULL, NULL)");
    const result = session.execute("SELECT COUNT(*), COUNT(A), SUM(A), AVG(A), MIN(A), MAX(A) FROM N");
    assert.equal(result.kind, "select");
    if (result.kind === "select") {
      assert.equal((result.columns[0] as { dataType: { name: string } }).dataType.name, "BIGINT");
      assert.deepEqual(selectStrings(result).rows, [["3", "2", "3", "1.500000", "1", "2"]]);
    }
    assert.deepEqual(selectStrings(session.execute("SELECT SUM(B), AVG(B) FROM N")).rows, [["30.00", "15.000000"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT SUM(C), AVG(C) FROM N")).rows, [["4", "2"]]);
  } finally {
    db.close();
  }
});

test("? 파라미터 바인딩을 확인한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE T (ID INTEGER PRIMARY KEY, NAME VARCHAR(20), HIRE DATE, SAL DECIMAL(10,2))");
    session.execute("INSERT INTO T VALUES (1, 'Ann', DATE '2024-01-15', 100.00)");
    assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM T WHERE ID = ?", [1n])).rows, [["Ann"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM T WHERE HIRE = ?", ["2024-01-15"])).rows, [["Ann"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT ? + ?", [1n, 2n])).rows, [["3"]]);
    session.execute("INSERT INTO T VALUES (?, ?, ?, ?)", [2n, "Bob", "2023-06-01", "200.50"]);
    assert.deepEqual(selectStrings(session.execute("SELECT NAME, SAL FROM T WHERE ID = 2")).rows, [["Bob", "200.50"]]);
    session.execute("UPDATE T SET SAL = ? WHERE ID = ?", ["300.25", 1n]);
    assert.deepEqual(selectStrings(session.execute("SELECT SAL FROM T WHERE ID = 1")).rows, [["300.25"]]);
    assert.throws(() => session.execute("SELECT * FROM T WHERE ID = ?", []), state("07001"));
    assert.throws(() => session.execute("SELECT * FROM T WHERE ID = ?", [1n, 2n]), state("07001"));
  } finally {
    db.close();
  }
});
