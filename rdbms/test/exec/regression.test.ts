/**
 * 6단계 점검에서 찾은 결함의 회귀 테스트.
 * INTERVAL 단일 필드 리터럴, DML 의 서브쿼리 값 대입, ALTER TABLE ADD COLUMN 의 DEFAULT·NOT NULL,
 * 7단계 전의 트랜잭션 문장, 읽기 전용 딕셔너리 객체, 자기 조인의 한정 이름, 집합 기반 제약 검사를 본다.
 * 관련 사양 : AGENTS.md 상세 0, 1-1, 1-3, 1-4, 3, 10, 11
 * 구현 단계 : 6단계(점검 보완)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
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

test("7단계 전에는 되돌릴 수 없는 트랜잭션 문장을 성공으로 알리지 않는다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE T (A INTEGER)");
    for (const sql of ["BEGIN", "START TRANSACTION", "ROLLBACK", "SAVEPOINT S1", "ROLLBACK TO S1", "RELEASE SAVEPOINT S1", "SET AUTOCOMMIT OFF"]) {
      assert.throws(() => session.execute(sql), state("0A000"), sql);
    }
    assert.equal(session.autocommit, true);
    // 문장마다 바로 커밋되므로 COMMIT 은 할 일이 없고, 자동 커밋과 READ COMMITTED 설정은 그대로 받는다.
    session.execute("INSERT INTO T VALUES (1)");
    session.execute("COMMIT");
    session.execute("SET AUTOCOMMIT ON");
    session.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM T")).rows, [["1"]]);
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
