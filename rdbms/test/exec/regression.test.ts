/**
 * 6단계 점검에서 찾은 결함의 회귀 테스트.
 * INTERVAL 단일 필드 리터럴, DML 의 서브쿼리 값 대입, ALTER TABLE ADD COLUMN 의 DEFAULT·NOT NULL,
 * 트랜잭션 문장이 성공을 알린 만큼 되돌리는지, 읽기 전용 딕셔너리 객체, 자기 조인의 한정 이름, 집합 기반 제약 검사를 본다.
 * 관련 사양 : AGENTS.md 상세 0, 1-1, 1-3, 1-4, 3, 10, 11
 * 구현 단계 : 6단계(점검 보완), 7단계(트랜잭션 문장 연동)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDataType } from "../../src/types/dataType.js";
import type { DataType } from "../../src/types/dataType.js";
import { conformValue, formatValue } from "../../src/types/value.js";
import type { NonNullValue } from "../../src/types/value.js";
import type { ExecuteResult, Session } from "../../src/session/session.js";
import { openTestDb, selectStrings, setupApp, state, tempDir } from "./helpers.js";

test("끝 필드가 없는 단일 필드 INTERVAL 리터럴을 받는다", (t) => {
  const { db, session } = setupApp(t);
  try {
    const rows = (sql: string): string[][] => selectStrings(session.execute(sql)).rows;
    assert.deepEqual(rows("SELECT INTERVAL '1' DAY, INTERVAL '2' HOUR, INTERVAL '30' MINUTE, INTERVAL '-3' DAY"), [["1", "2", "30", "-3"]]);
    assert.deepEqual(rows("SELECT INTERVAL '1' YEAR, INTERVAL '5' MONTH"), [["1", "5"]]);
    assert.deepEqual(rows("SELECT INTERVAL '5.25' SECOND"), [["5.250000"]]);
    // 값이 선행 정밀도(기본 2)를 넘으면 넓혀서 받고, 적어 둔 정밀도는 지킨다.
    assert.deepEqual(rows("SELECT INTERVAL '100' DAY"), [["100"]]);
    assert.deepEqual(rows("SELECT INTERVAL '3' DAY(3)"), [["3"]]);
    assert.throws(() => session.execute("SELECT INTERVAL '100' DAY(2)"), state("22015"));
    // 같은 필드를 TO 로 다시 적은 것은 여전히 잘못된 한정자이다.
    assert.throws(() => session.execute("SELECT INTERVAL '1' DAY TO DAY"), state("22023"));
    assert.deepEqual(rows("SELECT INTERVAL '1-2' YEAR TO MONTH"), [["1-02"]]);
    // 날짜시간과의 연산
    assert.deepEqual(rows("SELECT DATE '2026-01-31' + INTERVAL '1' DAY"), [["2026-02-01"]]);
    assert.deepEqual(rows("SELECT DATE '2026-01-31' + INTERVAL '1' MONTH"), [["2026-02-28"]]);
    assert.deepEqual(rows("SELECT TIMESTAMP '2026-01-31 10:00:00' + INTERVAL '2' HOUR"), [["2026-01-31 12:00:00.000000"]]);
    assert.deepEqual(rows("SELECT TIMESTAMP '2026-01-31 10:00:00' - INTERVAL '1' DAY"), [["2026-01-30 10:00:00.000000"]]);
  } finally {
    db.close();
  }
});

test("INSERT·UPDATE 의 서브쿼리 값도 컬럼 타입에 맞추어 저장한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE T (ID INTEGER PRIMARY KEY, N VARCHAR(10), D DECIMAL(5,2), TS TIMESTAMP)");
    // 정수 서브쿼리를 DECIMAL 컬럼에, 더 짧은 문자열을 VARCHAR 컬럼에 넣는다.
    session.execute("INSERT INTO T VALUES (2, (SELECT 'abc'), (SELECT 7), NULL)");
    session.execute("UPDATE T SET D = (SELECT MAX(ID) FROM T) WHERE ID = 2");
    session.execute("INSERT INTO T VALUES (5, (SELECT NULL), (SELECT NULL), NULL)");
    assert.deepEqual(selectStrings(session.execute("SELECT ID, N, D FROM T ORDER BY ID")).rows, [
      ["2", "abc", "2.00"],
      ["5", "NULL", "NULL"],
    ]);
    // 컬럼 타입의 범위와 길이는 서브쿼리 값에도 적용된다.
    assert.throws(() => session.execute("INSERT INTO T VALUES (3, 'x', (SELECT 99999), NULL)"), state("22003"));
    assert.throws(() => session.execute("INSERT INTO T VALUES (4, (SELECT 'toolongvaluexx'), 1, NULL)"), state("22001"));
    // 계열이 다르면 내부 오류가 아니라 42804 이다.
    assert.throws(() => session.execute("INSERT INTO T VALUES ((SELECT 'abc'), 'x', 1, NULL)"), state("42804"));
    assert.throws(() => session.execute("UPDATE T SET TS = (SELECT 1) WHERE ID = 2"), state("42804"));
    assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM T")).rows, [["2"]]);
  } finally {
    db.close();
  }
});

test("ADD COLUMN 은 기존 행에 DEFAULT 를 채우고, 빈 값이 될 NOT NULL 컬럼은 거절한다", (t) => {
  const dir = tempDir(t);
  let db = openTestDb(dir);
  try {
    const session = db.createSession({});
    session.execute("CREATE TABLESPACE APP");
    session.execute("USE APP");
    session.execute("CREATE TABLE A1 (X INTEGER PRIMARY KEY, Y INTEGER)");
    session.execute("INSERT INTO A1 VALUES (1, 10), (2, 20)");
    session.execute("CREATE INDEX IA ON A1 (Y)");
    session.execute("ALTER TABLE A1 ADD COLUMN Z INTEGER DEFAULT 5");
    session.execute("ALTER TABLE A1 ADD COLUMN W VARCHAR(5) DEFAULT 'hi' NOT NULL");
    session.execute("ALTER TABLE A1 ADD COLUMN U TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
    session.execute("ALTER TABLE A1 ADD COLUMN NOTE VARCHAR(5)");
    assert.deepEqual(selectStrings(session.execute("SELECT X, Y, Z, W, NOTE FROM A1 ORDER BY X")).rows, [
      ["1", "10", "5", "hi", "NULL"],
      ["2", "20", "5", "hi", "NULL"],
    ]);
    // CURRENT_TIMESTAMP 는 한 번 계산해 모든 기존 행에 같은 값을 넣는다.
    assert.deepEqual(selectStrings(session.execute("SELECT COUNT(DISTINCT U), COUNT(U) FROM A1")).rows, [["1", "2"]]);
    // 행을 다시 써도 PK 와 보조 인덱스로 찾을 수 있다.
    assert.deepEqual(selectStrings(session.execute("SELECT X FROM A1 WHERE Y = 20")).rows, [["2"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT Z FROM A1 WHERE X = 1")).rows, [["5"]]);
    assert.throws(() => session.execute("INSERT INTO A1 (X, Y) VALUES (1, 99)"), state("23505"));
    // DEFAULT 없는 NOT NULL 컬럼은 행이 있으면 거절한다. 실패한 뒤에도 컬럼이 늘지 않는다.
    assert.throws(() => session.execute("ALTER TABLE A1 ADD COLUMN V INTEGER NOT NULL"), state("23502"));
    assert.throws(() => session.execute("ALTER TABLE A1 ADD COLUMN BAD INTEGER DEFAULT 'abc'"), state("22018"));
    assert.throws(() => session.execute("ALTER TABLE A1 ADD COLUMN SHORT VARCHAR(2) DEFAULT 'toolong'"), state("22001"));
    assert.deepEqual(
      selectStrings(session.execute("SELECT COLUMN_NAME FROM SYS_COLUMNS WHERE TABLE_NAME = 'A1' ORDER BY ORDINAL_POSITION")).rows,
      [["X"], ["Y"], ["Z"], ["W"], ["U"], ["NOTE"]],
    );
    // 기존 행에 채울 수 없는 FK 조합은 지원하지 않는다고 알린다.
    session.execute("CREATE TABLE PR (P INTEGER PRIMARY KEY)");
    assert.throws(() => session.execute("ALTER TABLE A1 ADD COLUMN R2 INTEGER DEFAULT 1 REFERENCES PR"), state("0A000"));
    session.execute("ALTER TABLE A1 ADD COLUMN R INTEGER REFERENCES PR");
    // 빈 테이블에는 NOT NULL 컬럼을 추가할 수 있다.
    session.execute("CREATE TABLE EM (A INTEGER)");
    session.execute("ALTER TABLE EM ADD COLUMN B INTEGER NOT NULL");
    session.execute("ALTER TABLE EM ADD COLUMN C INTEGER DEFAULT 3 NOT NULL");
    session.execute("INSERT INTO EM (A, B) VALUES (1, 2)");
    assert.deepEqual(selectStrings(session.execute("SELECT A, B, C FROM EM")).rows, [["1", "2", "3"]]);
  } finally {
    db.close();
  }
  // 다시 열어도 채워 둔 값과 인덱스가 남아 있다.
  db = openTestDb(dir);
  try {
    const session = db.createSession({ tablespace: "APP" });
    assert.deepEqual(selectStrings(session.execute("SELECT X, Z, W FROM A1 ORDER BY X")).rows, [
      ["1", "5", "hi"],
      ["2", "5", "hi"],
    ]);
    assert.deepEqual(selectStrings(session.execute("SELECT X FROM A1 WHERE Y = 10")).rows, [["1"]]);
    session.execute("INSERT INTO A1 (X, Y) VALUES (3, 30)");
    assert.deepEqual(selectStrings(session.execute("SELECT X, Z, W FROM A1 WHERE X = 3")).rows, [["3", "5", "hi"]]);
  } finally {
    db.close();
  }
});

test("DROP COLUMN 은 행과 인덱스를 다시 쓰고 실패하면 원래대로 둔다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE D1 (ID INTEGER PRIMARY KEY, A INTEGER, B VARCHAR(5))");
    session.execute("INSERT INTO D1 VALUES (1, 10, 'x'), (2, 20, 'y')");
    session.execute("CREATE INDEX IB ON D1 (B)");
    assert.throws(() => session.execute("ALTER TABLE D1 DROP COLUMN B"), state("55006"));
    session.execute("ALTER TABLE D1 DROP COLUMN A");
    assert.deepEqual(selectStrings(session.execute("SELECT * FROM D1 ORDER BY ID")).rows, [["1", "x"], ["2", "y"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT ID FROM D1 WHERE B = 'y'")).rows, [["2"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT B FROM D1 WHERE ID = 1")).rows, [["x"]]);
  } finally {
    db.close();
  }
});

test("트랜잭션 문장은 성공을 알린 만큼 실제로 되돌리거나 커밋한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE T (A INTEGER)");
    // 자동 커밋을 끈 채 쓴 행은 ROLLBACK 으로 사라진다.
    session.execute("SET AUTOCOMMIT OFF");
    assert.equal(session.autocommit, false);
    session.execute("INSERT INTO T VALUES (1)");
    session.execute("ROLLBACK");
    assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM T")).rows, [["0"]]);
    // BEGIN 으로 연 트랜잭션에서는 세이브포인트 뒤의 변경만 되돌린다.
    session.execute("SET AUTOCOMMIT ON");
    session.execute("BEGIN");
    session.execute("INSERT INTO T VALUES (2)");
    session.execute("SAVEPOINT S1");
    session.execute("INSERT INTO T VALUES (3)");
    session.execute("ROLLBACK TO S1");
    session.execute("COMMIT");
    assert.deepEqual(selectStrings(session.execute("SELECT A FROM T")).rows, [["2"]]);
    session.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
  } finally {
    db.close();
  }
});

test("딕셔너리 뷰와 DUAL 은 DDL·DML 로 고칠 수 없다", (t) => {
  const { db, session } = setupApp(t);
  try {
    const readOnly = [
      "INSERT INTO DUAL VALUES ('Y')",
      "DELETE FROM SYS_TABLES",
      "UPDATE SYS_TABLES SET TABLE_NAME = 'X'",
      "DELETE FROM SYSTEM.SYS_USERS",
      "DROP TABLE SYS_TABLES",
      "DROP VIEW SYS_TABLES",
      "ALTER TABLE DUAL ADD COLUMN Q INTEGER",
      "TRUNCATE SYS_TABLES",
      "CREATE INDEX I9 ON SYS_TABLES (TABLE_NAME)",
    ];
    // 현재 테이블스페이스가 APP 일 때와 SYSTEM 일 때 모두 같다.
    for (const sql of readOnly) assert.throws(() => session.execute(sql), state("42809"), sql);
    session.execute("USE SYSTEM");
    for (const sql of readOnly) assert.throws(() => session.execute(sql), state("42809"), sql);
    // 없는 SYS_ 이름은 그냥 없는 객체이고, SYS_ 이름을 만들 수 없는 것은 그대로이다.
    assert.throws(() => session.execute("DELETE FROM SYS_NOPE"), state("42P01"));
    assert.throws(() => session.execute("CREATE TABLE SYS_FOO (A INTEGER)"), state("42602"));
    // SYSTEM 이 아닌 테이블스페이스에서 만든 같은 이름의 사용자 테이블은 평범하게 고칠 수 있다.
    session.execute("USE APP");
    session.execute("CREATE TABLE SYS_TABLES (A INTEGER)");
    session.execute("INSERT INTO SYS_TABLES VALUES (1)");
    session.execute("DELETE FROM SYS_TABLES");
    session.execute("DROP TABLE SYS_TABLES");
    assert.equal(session.execute("SELECT * FROM SYSTEM.SYS_TABLES").kind, "select");
  } finally {
    db.close();
  }
});

test("별칭을 준 출처는 별칭으로만 부르고, 자기 조인에서도 테이블 이름이 모호하지 않다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE K (A INTEGER, B INTEGER)");
    session.execute("INSERT INTO K VALUES (1, 10), (2, 20)");
    const rows = (sql: string): string[][] => selectStrings(session.execute(sql)).rows;
    assert.deepEqual(rows("SELECT K.A FROM K LEFT JOIN K k2 USING (A) ORDER BY K.A"), [["1"], ["2"]]);
    assert.deepEqual(rows("SELECT K.A, K2.B FROM K LEFT JOIN K k2 ON K.A = K2.A ORDER BY K.A"), [["1", "10"], ["2", "20"]]);
    assert.deepEqual(rows("SELECT APP.K.A FROM K ORDER BY 1"), [["1"], ["2"]]);
    assert.deepEqual(rows("SELECT x.A FROM K x WHERE x.B = 10"), [["1"]]);
    // 별칭을 주면 원래 테이블 이름으로는 부를 수 없다.
    assert.throws(() => session.execute("SELECT K.A FROM K x"), state("42703"));
    // 같은 별칭을 두 출처에 주면 여전히 모호하다.
    assert.throws(() => session.execute("SELECT x.A FROM K x, K x"), state("42702"));
    // 뷰를 통한 DML 에서도 뷰 이름과 별칭으로 한정할 수 있다.
    session.execute("CREATE VIEW KV AS SELECT A, B FROM K");
    session.execute("UPDATE KV SET B = 5 WHERE KV.A = 1");
    session.execute("UPDATE KV v SET B = 6 WHERE v.A = 2");
    assert.deepEqual(rows("SELECT * FROM K ORDER BY A"), [["1", "5"], ["2", "6"]]);
  } finally {
    db.close();
  }
});

test("많은 행에서도 PK·FK 검사가 정확하다 (집합 기반 검사)", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE P (ID INTEGER PRIMARY KEY, C CHAR(3))");
    session.execute("CREATE TABLE CH (ID INTEGER PRIMARY KEY, PID INTEGER REFERENCES P ON DELETE CASCADE ON UPDATE CASCADE)");
    session.execute("INSERT INTO P VALUES (1, 'a')");
    for (let round = 0; round < 8; round++) {
      session.execute("INSERT INTO P SELECT ID + (SELECT MAX(ID) FROM P), C FROM P");
    }
    assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM P")).rows, [["256"]]);
    // 같은 문장 안의 중복도, 기존 행과의 중복도 잡는다.
    assert.throws(() => session.execute("INSERT INTO P VALUES (1000, 'x'), (1000, 'y')"), state("23505"));
    assert.throws(() => session.execute("INSERT INTO P VALUES (256, 'x')"), state("23505"));
    assert.throws(() => session.execute("UPDATE P SET ID = 1 WHERE ID = 2"), state("23505"));
    // FK : 없는 부모는 거절하고 있는 부모는 받는다.
    session.execute("INSERT INTO CH SELECT ID, ID FROM P");
    assert.throws(() => session.execute("INSERT INTO CH VALUES (1000, 257)"), state("23503"));
    assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM CH")).rows, [["256"]]);
    // 참조동작
    session.execute("UPDATE P SET ID = ID + 1000 WHERE ID <= 3");
    assert.deepEqual(selectStrings(session.execute("SELECT PID FROM CH WHERE ID <= 3 ORDER BY ID")).rows, [["1001"], ["1002"], ["1003"]]);
    session.execute("DELETE FROM P WHERE ID > 1000");
    assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM CH")).rows, [["253"]]);
    session.execute("TRUNCATE TABLE CH");
    session.execute("TRUNCATE TABLE P");
    assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM P")).rows, [["0"]]);
  } finally {
    db.close();
  }
});

test("CHAR 키는 뒤쪽 공백을 무시하고 중복을 판정한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE C (K CHAR(3) PRIMARY KEY)");
    session.execute("INSERT INTO C VALUES ('a')");
    assert.throws(() => session.execute("INSERT INTO C VALUES ('a  ')"), state("23505"));
    session.execute("INSERT INTO C VALUES ('ab'), ('b')");
    assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM C")).rows, [["3"]]);
    // 기존 행에 대한 PK 추가도 같은 규칙이다.
    session.execute("CREATE TABLE C2 (K CHAR(3))");
    session.execute("INSERT INTO C2 VALUES ('x'), ('y')");
    session.execute("ALTER TABLE C2 ADD PRIMARY KEY (K)");
    session.execute("CREATE TABLE C3 (K VARCHAR(3))");
    session.execute("INSERT INTO C3 VALUES ('x'), ('x')");
    assert.throws(() => session.execute("ALTER TABLE C3 ADD PRIMARY KEY (K)"), state("23505"));
    session.execute("CREATE TABLE C4 (K CHAR(3))");
    session.execute("INSERT INTO C4 VALUES ('x'), ('z')");
    assert.throws(() => session.execute("ALTER TABLE C4 ADD FOREIGN KEY (K) REFERENCES C2"), state("23503"));
  } finally {
    db.close();
  }
});


// ---------------------------------------------------------------------------
// 11단계(통합 검증)에서 찾은 결함 : 타입이 정해지지 않은 NULL 리터럴과 NVL·COALESCE 의 행별 타입
// ---------------------------------------------------------------------------

/** 결과의 모든 값이 그 열의 타입에 맞는 JavaScript 값이고 자릿수까지 맞춘 모양인지 본다. (네트워크 인코더가 하는 검사와 같다) */
function assertConformsToColumns(result: ExecuteResult, what: string): void {
  assert.equal(result.kind, "select", what);
  if (result.kind !== "select") return;
  const columns: DataType[] = result.columns.map((column) => column.dataType);
  result.rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      if (value === null) return;
      const columnType = columns[columnIndex] as DataType;
      const conformed = conformValue(value, columnType) as NonNullValue;
      assert.equal(
        formatValue(conformed, columnType),
        formatValue(value, columnType),
        `${what}: 행 ${rowIndex} 열 ${columnIndex} 가 열 타입 ${formatDataType(columnType)} 에 맞게 만들어져 있어야 한다`,
      );
    });
  });
}

/** 조회하여 값을 문자열로(NULL 은 null 로) 돌려준다. 결과가 열 타입에 맞는지도 함께 본다. */
function nullableRows(session: Session, sql: string): Array<Array<string | null>> {
  const result = session.execute(sql);
  assertConformsToColumns(result, sql);
  if (result.kind !== "select") return [];
  const types = result.columns.map((column) => column.dataType);
  return result.rows.map((row) => row.map((value, index) => (value === null ? null : formatValue(value, types[index] as DataType))));
}

function firstColumnType(session: Session, sql: string): string {
  const result = session.execute(sql);
  assert.equal(result.kind, "select", sql);
  return result.kind === "select" ? formatDataType((result.columns[0] as { dataType: DataType }).dataType) : "";
}

test("NVL·COALESCE 의 결과는 NULL 인 행도 열 타입(DECIMAL 의 소수 자릿수 포함)에 맞는다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE T (ID INTEGER, S NUMERIC(10,2), F DOUBLE PRECISION, V VARCHAR(5), D DATE)");
    session.execute("INSERT INTO T VALUES (1, 100.5, 1.5, 'a', DATE '2026-01-01')");
    session.execute("INSERT INTO T VALUES (2, NULL, NULL, NULL, NULL)");
    // 값이 열 타입에 맞는지 (예전에는 NULL 인 행만 대체 값의 타입 그대로 나가 네트워크로 보낼 때 XX000 이었다)
    for (const sql of [
      "SELECT NVL(S, 0) FROM T ORDER BY ID",
      "SELECT NVL(S, 0.5) FROM T ORDER BY ID",
      "SELECT NVL(F, 0) FROM T ORDER BY ID",
      "SELECT NVL(ID, 0.5) FROM T ORDER BY ID",
      "SELECT NVL(V, 'zz') FROM T ORDER BY ID",
      "SELECT NVL(D, DATE '2000-01-01') FROM T ORDER BY ID",
      "SELECT COALESCE(S, 0) FROM T ORDER BY ID",
      "SELECT COALESCE(NULL, S, 0) FROM T ORDER BY ID",
      "SELECT COALESCE(S, F, 0) FROM T ORDER BY ID",
      "SELECT NULLIF(S, 0) FROM T ORDER BY ID",
      "SELECT NULLIF(S, 100.5) FROM T ORDER BY ID",
    ]) {
      nullableRows(session, sql);
    }
    // 값도 맞다. NULL 인 행은 대체 값이 열 타입(DECIMAL(12,2) 등)으로 바뀐다.
    assert.deepEqual(nullableRows(session, "SELECT NVL(S, 0) FROM T ORDER BY ID"), [["100.50"], ["0.00"]]);
    assert.deepEqual(nullableRows(session, "SELECT NVL(S, 0.5) FROM T ORDER BY ID"), [["100.50"], ["0.50"]]);
    assert.deepEqual(nullableRows(session, "SELECT COALESCE(S, 0) FROM T ORDER BY ID"), [["100.50"], ["0.00"]]);
    assert.deepEqual(nullableRows(session, "SELECT COALESCE(NULL, S, 7) FROM T ORDER BY ID"), [["100.50"], ["7.00"]]);
    assert.deepEqual(nullableRows(session, "SELECT NVL(F, 0) FROM T ORDER BY ID"), [["1.5"], ["0"]]);
    assert.deepEqual(nullableRows(session, "SELECT NVL(S, NULL) FROM T ORDER BY ID"), [["100.50"], [null]]);
    assert.deepEqual(nullableRows(session, "SELECT NVL(NULL, S) FROM T ORDER BY ID"), [["100.50"], [null]]);
    assert.deepEqual(nullableRows(session, "SELECT NULLIF(S, 100.5) FROM T ORDER BY ID"), [[null], [null]]);
    // 열 타입은 값이 NULL 인지와 무관하게 모든 인자의 공통 타입이다.
    assert.equal(firstColumnType(session, "SELECT NVL(S, 0) FROM T"), "DECIMAL(12,2)");
    assert.equal(firstColumnType(session, "SELECT NVL(NULL, S) FROM T"), "DECIMAL(10,2)");
    assert.equal(firstColumnType(session, "SELECT COALESCE(S, F, 0) FROM T"), "DOUBLE PRECISION");
  } finally {
    db.close();
  }
});

test("타입이 정해지지 않은 NULL 리터럴은 상대 타입에 맞추어 계산된다 (연산에 NULL 이 섞이면 결과는 NULL)", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE T (ID INTEGER, S NUMERIC(10,2), D DATE)");
    session.execute("INSERT INTO T VALUES (1, 100.5, DATE '2026-01-01')");
    // 사칙연산 (예전에는 INTEGER 와 VARCHAR(1) 의 연산이 정의되지 않았다는 42804 였다)
    assert.deepEqual(nullableRows(session, "SELECT 1 + NULL, NULL + 1, S * NULL, NULL - S, -NULL, NULL / 2 FROM T"), [[null, null, null, null, null, null]]);
    assert.deepEqual(nullableRows(session, "SELECT D + NULL, NULL + D FROM T"), [[null, null]]);
    // 결과 타입은 상대 피연산자를 따른다.
    assert.equal(firstColumnType(session, "SELECT 1 + NULL FROM T"), "INTEGER");
    assert.equal(firstColumnType(session, "SELECT S + NULL FROM T"), "DECIMAL(11,2)");
    // 비교는 UNKNOWN 이고, 선택 목록에서도 오류가 아니다.
    assert.deepEqual(nullableRows(session, "SELECT ID = NULL, NULL <> S, S > NULL FROM T"), [[null, null, null]]);
    // CASE 의 THEN, ELSE 에 NULL 이 있어도 나머지 분기의 타입이 된다.
    assert.deepEqual(
      nullableRows(session, "SELECT CASE WHEN ID = 1 THEN NULL ELSE 5 END, CASE WHEN ID = 2 THEN 1 ELSE NULL END, CASE WHEN ID = 1 THEN S ELSE NULL END FROM T"),
      [[null, null, "100.50"]],
    );
    assert.equal(firstColumnType(session, "SELECT CASE WHEN ID = 1 THEN NULL ELSE 5 END FROM T"), "INTEGER");
    // 집합 연산
    assert.deepEqual(nullableRows(session, "SELECT NULL FROM T UNION ALL SELECT 1 FROM T"), [[null], ["1"]]);
    assert.deepEqual(nullableRows(session, "SELECT 1 FROM T UNION ALL SELECT NULL FROM T"), [["1"], [null]]);
    assert.deepEqual(nullableRows(session, "SELECT NULL, NULL FROM T UNION ALL SELECT 'a', DATE '2026-02-02' FROM T"), [[null, null], ["a", "2026-02-02"]]);
    // NULL 만 있는 식은 예전처럼 VARCHAR(1) 이다.
    assert.equal(firstColumnType(session, "SELECT NULL FROM T"), "VARCHAR(1)");
    assert.equal(firstColumnType(session, "SELECT COALESCE(NULL, NULL) FROM T"), "VARCHAR(1)");
    assert.equal(firstColumnType(session, "SELECT NVL(NULL, NULL) FROM T"), "VARCHAR(1)");
    // 서로 다른 계열은 NULL 이 아닌 값끼리라면 여전히 오류이다.
    assert.throws(() => session.execute("SELECT COALESCE(1, DATE '2026-01-01') FROM T"), state("42804"));
    assert.throws(() => session.execute("SELECT CASE WHEN ID = 1 THEN 1 ELSE DATE '2026-01-01' END FROM T"), state("42804"));
    assert.throws(() => session.execute("SELECT 1 + TRUE FROM T"), state("42804"));
  } finally {
    db.close();
  }
});

/** 조회 결과의 첫 열을 정수로 모아 정렬한 문자열이다. */
function idList(session: Session, sql: string): string {
  return selectStrings(session.execute(sql)).rows.map((row) => Number(row[0])).sort((a, b) => a - b).join(",");
}

test("인덱스를 쓰는 범위 조건의 결과는 인덱스를 쓸 수 없게 만든 같은 뜻의 조건과 같다 (DESC 컬럼, 컬럼이 더 있는 복합 인덱스, NULL, 갱신·삭제)", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE T (ID INTEGER PRIMARY KEY, A INTEGER, B INTEGER, C INTEGER)");
    const rows: string[] = [];
    for (let id = 1; id <= 400; id++) rows.push(`(${id}, ${id % 3}, ${id % 17 === 0 ? "NULL" : id % 10}, ${id % 13 === 0 ? "NULL" : id % 5})`);
    session.execute(`INSERT INTO T VALUES ${rows.join(", ")}`);
    // 예전에는 DESC 컬럼의 한쪽만 있는 범위(A = 1 AND B > 3 등)가 빈 결과였고, 뒤에 컬럼이 더 있는 인덱스의 경계값 행을 놓칠 수 있었다.
    const comparisons = [">", ">=", "<", "<=", "="].flatMap((op) => [3, 0, 9, 10, -1].map((value) => `B ${op} ${value}`));
    comparisons.push("B BETWEEN 2 AND 6", "B BETWEEN 0 AND 0", "B BETWEEN 9 AND 12", "B BETWEEN 5 AND 5", "3 < B", "6 >= B");
    const plain = (where: string): string => where.replace(/\bA = (\d)/, "A + 0 = $1").replace(/\bB\b(?! BETWEEN)/g, "B + 0");
    let compared = 0;
    for (const definition of ["(A, B)", "(A, B DESC)", "(A DESC, B)", "(A, B, C)", "(A, B DESC, C)", "(A, B, C DESC)", "(A DESC, B DESC, C DESC)", "(B)", "(B DESC)", "(B, C)", "(B DESC, C)"]) {
      session.execute(`CREATE INDEX IX ON T ${definition}`);
      const prefixes = definition.startsWith("(B") ? [null] : ["A = 1", "A = 0", "A = 2"];
      for (const prefix of prefixes) {
        for (const comparison of comparisons) {
          const where = prefix === null ? comparison : `${prefix} AND ${comparison}`;
          assert.equal(idList(session, `SELECT ID FROM T WHERE ${where}`), idList(session, `SELECT ID FROM T WHERE ${plain(where)}`), `인덱스 ${definition}, WHERE ${where}`);
          compared++;
        }
      }
      session.execute("DROP INDEX IX");
    }
    assert.ok(compared > 500);

    // 갱신과 삭제도 같은 후보 탐색을 쓴다. 인덱스가 DESC 인 상태에서 조건에 맞는 행만 바뀌고 지워진다.
    session.execute("CREATE INDEX IX ON T (A, B DESC)");
    const expectedUpdate = Number(selectStrings(session.execute("SELECT COUNT(*) FROM T WHERE A + 0 = 1 AND B + 0 > 3")).rows[0]?.[0]);
    assert.ok(expectedUpdate > 0);
    const updated = session.execute("UPDATE T SET C = 99 WHERE A = 1 AND B > 3");
    assert.equal(updated.kind === "ok" ? updated.rowCount : -1, expectedUpdate);
    assert.equal(idList(session, "SELECT ID FROM T WHERE C = 99"), idList(session, "SELECT ID FROM T WHERE A + 0 = 1 AND B + 0 > 3"));
    const expectedDelete = Number(selectStrings(session.execute("SELECT COUNT(*) FROM T WHERE A + 0 = 2 AND B + 0 <= 4")).rows[0]?.[0]);
    const deleted = session.execute("DELETE FROM T WHERE A = 2 AND B <= 4");
    assert.equal(deleted.kind === "ok" ? deleted.rowCount : -1, expectedDelete);
    assert.equal(selectStrings(session.execute("SELECT COUNT(*) FROM T WHERE A + 0 = 2 AND B + 0 <= 4")).rows[0]?.[0], "0");
  } finally {
    db.close();
  }
});
