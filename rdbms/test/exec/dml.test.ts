/**
 * DML과 제약조건 테스트 (6단계).
 * INSERT, UPDATE, DELETE, TRUNCATE와 NOT NULL·PK·FK, 참조동작, 갱신 가능한 뷰를 본다.
 * 관련 사양 : AGENTS.md 상세 1-3, 1-4, 10, 11
 * 구현 단계 : 6단계
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectStrings } from "./helpers.js";
import { setupApp } from "./helpers.js";
import { openTestDb } from "./helpers.js";
import { tempDir } from "./helpers.js";
import { state } from "./helpers.js";

test("INSERT의 여러 형태와 DEFAULT를 확인한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE T (A INTEGER, B VARCHAR(10) DEFAULT 'hi', C INTEGER DEFAULT 7)");
    assert.equal(session.execute("INSERT INTO T VALUES (1, 'x', 2)").kind, "ok");
    assert.equal(session.execute("INSERT INTO T (A) VALUES (2)").kind, "ok");
    assert.equal(session.execute("INSERT INTO T VALUES (3, DEFAULT, DEFAULT)").kind, "ok");
    assert.equal(session.execute("INSERT INTO T DEFAULT VALUES").kind, "ok");
    assert.deepEqual(selectStrings(session.execute("SELECT A, B, C FROM T ORDER BY A NULLS LAST")).rows, [
      ["1", "x", "2"],
      ["2", "hi", "7"],
      ["3", "hi", "7"],
      ["NULL", "hi", "7"],
    ]);
    // INTO 생략과 여러 행을 받는다.
    session.execute("INSERT T VALUES (10, 'a', 1), (11, 'b', 2)");
    assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM T")).rows, [["6"]]);
    // INSERT ... SELECT
    session.execute("CREATE TABLE U (A INTEGER, B VARCHAR(10), C INTEGER)");
    session.execute("INSERT INTO U SELECT * FROM T WHERE A >= 10 ORDER BY A");
    assert.deepEqual(selectStrings(session.execute("SELECT A FROM U ORDER BY A")).rows, [["10"], ["11"]]);
    // 값 개수가 안 맞으면 오류이다.
    assert.throws(() => session.execute("INSERT INTO T VALUES (1, 2)"), state("42601"));
    assert.throws(() => session.execute("INSERT INTO T (A, A) VALUES (1, 2)"), state("42701"));
    assert.throws(() => session.execute("INSERT INTO T (NOPE) VALUES (1)"), state("42703"));
    // 타입이 안 맞으면 오류이다.
    assert.throws(() => session.execute("INSERT INTO T (A) VALUES ('abc')"), state("22018"));
    assert.throws(() => session.execute("INSERT INTO T (B) VALUES ('0123456789!')"), state("22001"));
  } finally {
    db.close();
  }
});

test("UPDATE와 DELETE를 확인한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE T (ID INTEGER PRIMARY KEY, NAME VARCHAR(20), SAL DECIMAL(10,2))");
    session.execute("INSERT INTO T VALUES (1, 'Ann', 100), (2, 'Bob', 200), (3, 'Cid', 300)");
    const updated = session.execute("UPDATE T SET SAL = SAL * 2 WHERE ID >= 2");
    assert.equal(updated.kind, "ok");
    assert.equal(updated.kind === "ok" ? updated.rowCount : undefined, 2);
    assert.deepEqual(selectStrings(session.execute("SELECT SAL FROM T ORDER BY ID")).rows, [["100.00"], ["400.00"], ["600.00"]]);
    session.execute("UPDATE T SET NAME = DEFAULT WHERE ID = 1");
    assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM T WHERE ID = 1")).rows, [["NULL"]]);
    // 별칭을 쓸 수 있다.
    session.execute("UPDATE T AS X SET SAL = 0 WHERE X.ID = 3");
    assert.deepEqual(selectStrings(session.execute("SELECT SAL FROM T WHERE ID = 3")).rows, [["0.00"]]);
    const deleted = session.execute("DELETE FROM T WHERE SAL >= 400");
    assert.equal(deleted.kind, "ok");
    assert.equal(deleted.kind === "ok" ? deleted.rowCount : undefined, 1);
    assert.deepEqual(selectStrings(session.execute("SELECT ID FROM T ORDER BY ID")).rows, [["1"], ["3"]]);
    session.execute("DELETE T WHERE ID = 3");
    assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM T")).rows, [["1"]]);
    // 서브쿼리와 상관 서브쿼리를 WHERE에 쓸 수 있다.
    session.execute("INSERT INTO T VALUES (5, 'Eve', 500)");
    session.execute("UPDATE T SET SAL = (SELECT MAX(SAL) FROM T) WHERE ID = 1");
    assert.deepEqual(selectStrings(session.execute("SELECT SAL FROM T WHERE ID = 1")).rows, [["500.00"]]);
    session.execute("DELETE FROM T WHERE SAL < (SELECT AVG(SAL) FROM T)");
    assert.deepEqual(selectStrings(session.execute("SELECT ID FROM T ORDER BY ID")).rows, [["1"], ["5"]]);
  } finally {
    db.close();
  }
});

test("NOT NULL과 PK 위반을 확인한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE T (A INTEGER NOT NULL, B INTEGER PRIMARY KEY)");
    session.execute("INSERT INTO T VALUES (1, 10)");
    assert.throws(() => session.execute("INSERT INTO T VALUES (NULL, 11)"), state("23502"));
    assert.throws(() => session.execute("INSERT INTO T VALUES (2, 10)"), state("23505"));
    session.execute("INSERT INTO T VALUES (2, 11)");
    assert.throws(() => session.execute("UPDATE T SET B = 10 WHERE B = 11"), state("23505"));
    assert.deepEqual(selectStrings(session.execute("SELECT B FROM T ORDER BY B")).rows, [["10"], ["11"]]);
    assert.throws(() => session.execute("UPDATE T SET A = NULL"), state("23502"));
    // 복합 PK
    session.execute("CREATE TABLE C (A INTEGER, B INTEGER, CONSTRAINT PK_C PRIMARY KEY (A, B))");
    session.execute("INSERT INTO C VALUES (1, 1), (1, 2)");
    assert.throws(() => session.execute("INSERT INTO C VALUES (1, 1)"), state("23505"));
  } finally {
    db.close();
  }
});

test("FK 검사와 참조동작을 확인한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE P (ID INTEGER PRIMARY KEY, NAME VARCHAR(10))");
    session.execute("CREATE TABLE C (ID INTEGER PRIMARY KEY, PID INTEGER REFERENCES P (ID))");
    session.execute("INSERT INTO P VALUES (1, 'a'), (2, 'b')");
    assert.throws(() => session.execute("INSERT INTO C VALUES (1, 99)"), state("23503"));
    session.execute("INSERT INTO C VALUES (1, 1), (2, NULL)");
    assert.throws(() => session.execute("DELETE FROM P WHERE ID = 1"), state("23503"));
    session.execute("DELETE FROM C WHERE ID = 1");
    session.execute("DELETE FROM P WHERE ID = 1");
    assert.deepEqual(selectStrings(session.execute("SELECT ID FROM P ORDER BY ID")).rows, [["2"]]);
    // ON DELETE CASCADE
    session.execute("CREATE TABLE CC (ID INTEGER PRIMARY KEY, PID INTEGER REFERENCES P (ID) ON DELETE CASCADE)");
    session.execute("INSERT INTO CC VALUES (1, 2)");
    session.execute("DELETE FROM P WHERE ID = 2");
    assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM CC")).rows, [["0"]]);
    // ON DELETE SET NULL
    session.execute("INSERT INTO P VALUES (3, 'c')");
    session.execute("CREATE TABLE CS (ID INTEGER PRIMARY KEY, PID INTEGER REFERENCES P (ID) ON DELETE SET NULL)");
    session.execute("INSERT INTO CS VALUES (1, 3)");
    session.execute("DELETE FROM P WHERE ID = 3");
    assert.deepEqual(selectStrings(session.execute("SELECT PID FROM CS")).rows, [["NULL"]]);
    // ON UPDATE CASCADE
    session.execute("INSERT INTO P VALUES (4, 'd')");
    session.execute("CREATE TABLE CU (ID INTEGER PRIMARY KEY, PID INTEGER REFERENCES P (ID) ON UPDATE CASCADE)");
    session.execute("INSERT INTO CU VALUES (1, 4)");
    session.execute("UPDATE P SET ID = 40 WHERE ID = 4");
    assert.deepEqual(selectStrings(session.execute("SELECT PID FROM CU")).rows, [["40"]]);
    // 자기 참조
    session.execute("CREATE TABLE SELF (ID INTEGER PRIMARY KEY, BOSS INTEGER REFERENCES SELF (ID))");
    session.execute("INSERT INTO SELF VALUES (1, NULL)");
    session.execute("INSERT INTO SELF VALUES (2, 1)");
    assert.throws(() => session.execute("INSERT INTO SELF VALUES (3, 99)"), state("23503"));
    assert.throws(() => session.execute("DELETE FROM SELF WHERE ID = 1"), state("23503"));
  } finally {
    db.close();
  }
});

test("갱신 가능한 뷰를 통한 DML을 확인한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE T (A INTEGER PRIMARY KEY, B VARCHAR(10), C INTEGER)");
    session.execute("INSERT INTO T VALUES (1, 'x', 10), (2, 'y', 20)");
    session.execute("CREATE VIEW V AS SELECT A, B FROM T WHERE C > 5");
    session.execute("INSERT INTO V VALUES (3, 'z')");
    session.execute("UPDATE V SET B = 'w' WHERE A = 1");
    session.execute("DELETE FROM V WHERE A = 2");
    assert.deepEqual(selectStrings(session.execute("SELECT A, B, C FROM T ORDER BY A")).rows, [
      ["1", "w", "10"],
      ["3", "z", "NULL"],
    ]);
    // 집계 뷰는 갱신할 수 없다.
    session.execute("CREATE VIEW W AS SELECT COUNT(*) AS C FROM T");
    assert.throws(() => session.execute("INSERT INTO W VALUES (1)"), state("42P17"));
    assert.throws(() => session.execute("UPDATE W SET C = 1"), state("42P17"));
    // 계산 열에는 넣을 수 없다.
    session.execute("CREATE VIEW V2 AS SELECT A, C * 2 AS D FROM T");
    assert.throws(() => session.execute("INSERT INTO V2 VALUES (9, 9)"), state("42P17"));
    // 뷰를 통한 조회는 조건에 맞는 행만 보인다.
    assert.deepEqual(selectStrings(session.execute("SELECT * FROM V ORDER BY A")).rows, [
      ["1", "w"],
    ]);
    // 기반 테이블에는 뷰 조건에 안 맞는 행도 남는다.
    assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM T")).rows, [["2"]]);
  } finally {
    db.close();
  }
});

test("TRUNCATE는 행을 비우고 참조가 있으면 막는다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE P (ID INTEGER PRIMARY KEY)");
    session.execute("CREATE TABLE C (ID INTEGER PRIMARY KEY, PID INTEGER REFERENCES P (ID))");
    session.execute("INSERT INTO P VALUES (1), (2)");
    session.execute("INSERT INTO C VALUES (1, 1)");
    assert.throws(() => session.execute("TRUNCATE P"), state("23503"));
    session.execute("TRUNCATE C");
    assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM C")).rows, [["0"]]);
    session.execute("TRUNCATE P");
    assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM P")).rows, [["0"]]);
  } finally {
    db.close();
  }
});

test("데이터가 있는 테이블의 DDL 검사를 확인한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE T (A INTEGER, B INTEGER)");
    session.execute("INSERT INTO T VALUES (1, 1), (2, NULL)");
    assert.throws(() => session.execute("ALTER TABLE T ALTER COLUMN B SET NOT NULL"), state("23502"));
    session.execute("DELETE FROM T WHERE B IS NULL");
    session.execute("ALTER TABLE T ALTER COLUMN B SET NOT NULL");
    session.execute("INSERT INTO T VALUES (3, 3), (3, 4)");
    assert.throws(() => session.execute("ALTER TABLE T ADD CONSTRAINT PK_T PRIMARY KEY (A)"), state("23505"));
    session.execute("DELETE FROM T WHERE A = 3");
    session.execute("ALTER TABLE T ADD CONSTRAINT PK_T PRIMARY KEY (A)");
    session.execute("CREATE TABLE P (ID INTEGER PRIMARY KEY)");
    session.execute("INSERT INTO P VALUES (1)");
    session.execute("INSERT INTO T VALUES (9, 9)");
    assert.throws(() => session.execute("ALTER TABLE T ADD CONSTRAINT FK_T FOREIGN KEY (A) REFERENCES P (ID)"), state("23503"));
    session.execute("DELETE FROM T WHERE A = 9");
    session.execute("ALTER TABLE T ADD CONSTRAINT FK_T FOREIGN KEY (A) REFERENCES P (ID)");
    // DROP COLUMN은 행을 다시 쓴다.
    session.execute("CREATE TABLE D (A INTEGER, B INTEGER, C INTEGER)");
    session.execute("INSERT INTO D VALUES (1, 2, 3)");
    session.execute("ALTER TABLE D DROP COLUMN B");
    assert.deepEqual(selectStrings(session.execute("SELECT * FROM D")).rows, [["1", "3"]]);
  } finally {
    db.close();
  }
});

test("DML이 재구동 후에도 남는다", (t) => {
  const dir = tempDir(t);
  let db = openTestDb(dir);
  try {
    const session = db.createSession({});
    session.execute("CREATE TABLESPACE APP");
    session.execute("USE APP");
    session.execute("CREATE TABLE T (ID INTEGER PRIMARY KEY, NAME VARCHAR(20))");
    session.execute("CREATE INDEX IX_T_NAME ON T (NAME)");
    session.execute("INSERT INTO T VALUES (1, 'a'), (2, 'b')");
  } finally {
    db.close();
  }
  db = openTestDb(dir);
  try {
    const session = db.createSession({ tablespace: "APP" });
    assert.deepEqual(selectStrings(session.execute("SELECT ID, NAME FROM T ORDER BY ID")).rows, [["1", "a"], ["2", "b"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT ID FROM T WHERE NAME = 'b'")).rows, [["2"]]);
    session.execute("UPDATE T SET NAME = 'c' WHERE ID = 2");
    assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM T WHERE ID = 2")).rows, [["c"]]);
  } finally {
    db.close();
  }
});
