/**
 * 질의 실행 테스트 (6단계).
 * 단일 테이블 조회, 조건과 식, 조인, 집계, 집합 연산, 서브쿼리, 정렬과 행 수 제한을 본다.
 * 관련 사양 : AGENTS.md 상세 1-4
 * 구현 단계 : 6단계
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../../src/session/session.js";
import { DbError } from "../../src/common/errors.js";
import { parseStatement } from "../../src/sql/parser.js";
import { chooseIndex } from "../../src/exec/planner.js";
import { evaluateExpression } from "../../src/exec/expression.js";
import { resolveTimeZone } from "../../src/types/datetime.js";
import { setupApp } from "./helpers.js";
import { selectStrings } from "./helpers.js";
import { state } from "./helpers.js";

function empSetup(session: Session): void {
  session.execute("CREATE TABLE EMP (ID INTEGER PRIMARY KEY, NAME VARCHAR(20), SAL DECIMAL(10,2), HIRE DATE)");
  session.execute("INSERT INTO EMP VALUES (1, 'Ann', 5000.00, DATE '2024-01-15')");
  session.execute("INSERT INTO EMP VALUES (2, 'Bob', 7000.50, DATE '2023-06-01')");
  session.execute("INSERT INTO EMP VALUES (3, NULL, 6000, DATE '2024-03-10')");
  session.execute("INSERT INTO EMP VALUES (4, 'Ada', 7000.50, DATE '2022-12-31')");
}

test("Hello World 샘플이 그대로 실행된다", (t) => {
  const { db, session } = setupApp(t);
  try {
    assert.deepEqual(selectStrings(session.execute("SELECT 'Hello World'")).rows, [["Hello World"]]);
    session.execute("CREATE TABLE HELLO (MESSAGE VARCHAR)");
    assert.equal(session.execute("INSERT INTO HELLO VALUES ('Hello World')").kind, "ok");
    assert.deepEqual(selectStrings(session.execute("SELECT * FROM HELLO")).rows, [["Hello World"]]);
  } finally {
    db.close();
  }
});

test("단일 테이블 조회와 조건, 식을 계산한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    empSetup(session);
    // 비교와 논리, NULL
    assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM EMP WHERE SAL > 6000 ORDER BY ID")).rows, [["Bob"], ["Ada"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM EMP WHERE SAL >= 6000 ORDER BY ID")).rows, [["Bob"], ["NULL"], ["Ada"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM EMP WHERE NAME IS NULL")).rows, [["NULL"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM EMP WHERE NAME IS NOT NULL ORDER BY ID")).rows, [["Ann"], ["Bob"], ["Ada"]]);
    assert.deepEqual(
      selectStrings(session.execute("SELECT ID FROM EMP WHERE SAL BETWEEN 6000 AND 7000 ORDER BY ID")).rows,
      [["3"]],
    );
    assert.deepEqual(selectStrings(session.execute("SELECT ID FROM EMP WHERE ID IN (1, 4) ORDER BY ID")).rows, [["1"], ["4"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT ID FROM EMP WHERE NAME LIKE 'A%' ORDER BY ID")).rows, [["1"], ["4"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT ID FROM EMP WHERE NAME LIKE '%o%' ORDER BY ID")).rows, [["2"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT 1 + 2 * 3, 'a' || 'b', 7 / 2")).rows, [["7", "ab", "3"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT CASE WHEN ID = 1 THEN 'one' ELSE 'other' END FROM EMP ORDER BY ID")).rows, [["one"], ["other"], ["other"], ["other"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT CASE ID WHEN 1 THEN 'one' WHEN 2 THEN 'two' ELSE 'other' END FROM EMP ORDER BY ID")).rows, [["one"], ["two"], ["other"], ["other"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT CAST(SAL AS INTEGER) FROM EMP WHERE ID = 1")).rows, [["5000"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT ID FROM EMP WHERE HIRE = '2024-01-15'")).rows, [["1"]]);
    // 별칭과 한정된 이름
    assert.deepEqual(selectStrings(session.execute("SELECT E.NAME AS N FROM EMP AS E WHERE E.ID = 2")).rows, [["Bob"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT APP.EMP.NAME FROM APP.EMP WHERE ID = 1")).rows, [["Ann"]]);
  } finally {
    db.close();
  }
});

test("정렬과 NULL 순서, DISTINCT, 행 수 제한을 확인한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    empSetup(session);
    assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM EMP ORDER BY NAME")).rows, [["Ada"], ["Ann"], ["Bob"], ["NULL"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM EMP ORDER BY NAME DESC")).rows, [["NULL"], ["Bob"], ["Ann"], ["Ada"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM EMP ORDER BY NAME DESC NULLS LAST")).rows, [["Bob"], ["Ann"], ["Ada"], ["NULL"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM EMP ORDER BY NAME NULLS FIRST")).rows, [["NULL"], ["Ada"], ["Ann"], ["Bob"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT DISTINCT SAL FROM EMP ORDER BY SAL")).rows, [["5000.00"], ["6000.00"], ["7000.50"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT ID FROM EMP ORDER BY ID LIMIT 2")).rows, [["1"], ["2"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT ID FROM EMP ORDER BY ID LIMIT 2 OFFSET 1")).rows, [["2"], ["3"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT ID FROM EMP ORDER BY ID OFFSET 1 ROWS FETCH NEXT 2 ROWS ONLY")).rows, [["2"], ["3"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT ID FROM EMP ORDER BY ID FETCH FIRST ROW ONLY")).rows, [["1"]]);
  } finally {
    db.close();
  }
});

test("조인을 확인한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE DEPT (ID INTEGER PRIMARY KEY, DNAME VARCHAR(20))");
    session.execute("CREATE TABLE WORK (EID INTEGER, DID INTEGER)");
    session.execute("INSERT INTO DEPT VALUES (10, 'R&D'), (20, 'Sales')");
    session.execute("INSERT INTO WORK VALUES (1, 10), (2, 20), (3, NULL)");
    session.execute("CREATE TABLE E (ID INTEGER PRIMARY KEY, NAME VARCHAR(20))");
    session.execute("INSERT INTO E VALUES (1, 'Ann'), (2, 'Bob'), (4, 'Dan')");
    assert.deepEqual(
      selectStrings(session.execute("SELECT E.NAME, D.DNAME FROM E JOIN WORK W ON E.ID = W.EID JOIN DEPT D ON W.DID = D.ID ORDER BY E.ID")).rows,
      [["Ann", "R&D"], ["Bob", "Sales"]],
    );
    assert.deepEqual(
      selectStrings(session.execute("SELECT E.NAME, D.DNAME FROM E LEFT JOIN WORK W ON E.ID = W.EID LEFT JOIN DEPT D ON W.DID = D.ID ORDER BY E.ID")).rows,
      [["Ann", "R&D"], ["Bob", "Sales"], ["Dan", "NULL"]],
    );
    assert.deepEqual(
      selectStrings(session.execute("SELECT D.DNAME, W.EID FROM WORK W RIGHT JOIN DEPT D ON W.DID = D.ID ORDER BY D.ID")).rows,
      [["R&D", "1"], ["Sales", "2"]],
    );
    assert.deepEqual(
      selectStrings(session.execute("SELECT A.ID, B.ID FROM E A CROSS JOIN E B ORDER BY A.ID, B.ID LIMIT 3")).rows,
      [["1", "1"], ["1", "2"], ["1", "4"]],
    );
    assert.deepEqual(
      selectStrings(session.execute("SELECT * FROM E, DEPT WHERE E.ID = 1 AND DEPT.ID = 10")).rows,
      [["1", "Ann", "10", "R&D"]],
    );
    // USING 병합 : 오른쪽의 ID는 한 번만 나온다.
    session.execute("CREATE TABLE J1 (ID INTEGER, V VARCHAR(5))");
    session.execute("CREATE TABLE J2 (ID INTEGER, W VARCHAR(5))");
    session.execute("INSERT INTO J1 VALUES (1, 'a'), (2, 'b'), (3, 'c')");
    session.execute("INSERT INTO J2 VALUES (2, 'x'), (3, 'y'), (4, 'z')");
    const merged = session.execute("SELECT * FROM J1 JOIN J2 USING (ID) ORDER BY ID");
    assert.deepEqual(selectStrings(merged).columns.filter((column) => column === "ID").length, 1);
    assert.deepEqual(selectStrings(merged).rows, [["2", "b", "x"], ["3", "c", "y"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT * FROM J1 LEFT JOIN J2 USING (ID) ORDER BY ID")).rows, [
      ["1", "a", "NULL"],
      ["2", "b", "x"],
      ["3", "c", "y"],
    ]);
    // 다른 테이블스페이스와 조인한다.
    session.execute("CREATE TABLESPACE OTHER");
    session.execute("CREATE TABLE OTHER.O (ID INTEGER PRIMARY KEY, TAG VARCHAR(10))");
    session.execute("INSERT INTO OTHER.O VALUES (1, 'x')");
    assert.deepEqual(selectStrings(session.execute("SELECT E.NAME, O.TAG FROM E JOIN OTHER.O ON E.ID = O.ID")).rows, [["Ann", "x"]]);
  } finally {
    db.close();
  }
});

test("집계와 GROUP BY, HAVING을 확인한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    empSetup(session);
    assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*), COUNT(NAME), SUM(SAL), MIN(SAL), MAX(SAL) FROM EMP")).rows, [["4", "3", "25001.00", "5000.00", "7000.50"]]);
    assert.deepEqual(
      selectStrings(session.execute("SELECT SUBSTRING(NAME, 1, 1) AS I, COUNT(*) AS C FROM EMP GROUP BY SUBSTRING(NAME, 1, 1) ORDER BY I")).rows,
      [["A", "2"], ["B", "1"], ["NULL", "1"]],
    );
    assert.deepEqual(
      selectStrings(session.execute("SELECT SAL, COUNT(*) FROM EMP GROUP BY SAL HAVING COUNT(*) > 1 ORDER BY SAL")).rows,
      [["7000.50", "2"]],
    );
    assert.deepEqual(selectStrings(session.execute("SELECT COUNT(DISTINCT SAL) FROM EMP")).rows, [["3"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT SUM(SAL) FROM EMP WHERE 1 = 0")).rows, [["NULL"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM EMP WHERE 1 = 0")).rows, [["0"]]);
    assert.throws(() => session.execute("SELECT NAME FROM EMP GROUP BY SAL"), state("42803"));
    assert.throws(() => session.execute("SELECT NAME, COUNT(*) FROM EMP"), state("42803"));
  } finally {
    db.close();
  }
});

test("집합 연산을 확인한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE A (ID INTEGER)");
    session.execute("CREATE TABLE B (ID INTEGER)");
    session.execute("INSERT INTO A VALUES (1), (2), (2), (3)");
    session.execute("INSERT INTO B VALUES (2), (3), (4)");
    assert.deepEqual(selectStrings(session.execute("SELECT ID FROM A UNION SELECT ID FROM B ORDER BY ID")).rows, [["1"], ["2"], ["3"], ["4"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT ID FROM A UNION ALL SELECT ID FROM B ORDER BY ID")).rows, [["1"], ["2"], ["2"], ["2"], ["3"], ["3"], ["4"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT ID FROM A INTERSECT SELECT ID FROM B ORDER BY ID")).rows, [["2"], ["3"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT ID FROM A EXCEPT SELECT ID FROM B ORDER BY ID")).rows, [["1"]]);
    assert.throws(() => session.execute("SELECT ID FROM A UNION SELECT ID, ID FROM A"), state("42804"));
  } finally {
    db.close();
  }
});

test("서브쿼리를 확인한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    empSetup(session);
    // 스칼라
    assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM EMP WHERE SAL = (SELECT MAX(SAL) FROM EMP) ORDER BY ID")).rows, [["Bob"], ["Ada"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT (SELECT COUNT(*) FROM EMP) AS C")).rows, [["4"]]);
    assert.throws(() => session.execute("SELECT * FROM EMP WHERE ID = (SELECT ID FROM EMP)"), state("21000"));
    // 인라인 뷰
    assert.deepEqual(selectStrings(session.execute("SELECT T.NAME FROM (SELECT * FROM EMP WHERE SAL > 6000) AS T ORDER BY T.ID")).rows, [["Bob"], ["Ada"]]);
    // IN / EXISTS (상관)
    assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM EMP WHERE ID IN (SELECT ID FROM EMP WHERE SAL > 6000) ORDER BY ID")).rows, [["Bob"], ["Ada"]]);
    assert.deepEqual(
      selectStrings(session.execute("SELECT NAME FROM EMP E WHERE EXISTS (SELECT 1 FROM EMP WHERE SAL > E.SAL) ORDER BY ID")).rows,
      [["Ann"], ["NULL"]],
    );
    // ANY / ALL (상관)
    assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM EMP WHERE SAL > ANY (SELECT SAL FROM EMP WHERE NAME IS NULL) ORDER BY ID")).rows, [["Bob"], ["Ada"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM EMP WHERE SAL >= ALL (SELECT SAL FROM EMP WHERE NAME IS NOT NULL) ORDER BY ID")).rows, [["Bob"], ["Ada"]]);
    // 상관 스칼라
    assert.deepEqual(
      selectStrings(session.execute("SELECT NAME, (SELECT COUNT(*) FROM EMP E2 WHERE E2.SAL > E.SAL) AS BIGGER FROM EMP E ORDER BY ID")).rows,
      [["Ann", "3"], ["Bob", "0"], ["NULL", "2"], ["Ada", "0"]],
    );
  } finally {
    db.close();
  }
});

test("이름과 타입 오류를 확인한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    empSetup(session);
    session.execute("CREATE TABLE T2 (ID INTEGER, NAME VARCHAR(10))");
    session.execute("INSERT INTO T2 VALUES (1, 'x')");
    assert.throws(() => session.execute("SELECT * FROM MISSING"), state("42P01"));
    assert.throws(() => session.execute("SELECT NOPE FROM EMP"), state("42703"));
    assert.throws(() => session.execute("SELECT ID FROM EMP, T2"), state("42702"));
    assert.throws(() => session.execute("SELECT NAME + SAL FROM EMP"), state("42804"));
    assert.throws(() => session.execute("SELECT 1 / 0 FROM EMP"), state("22012"));
    assert.throws(() => session.execute("SELECT NOFN(NAME) FROM EMP"), state("42883"));
  } finally {
    db.close();
  }
});

test("규칙 기반 인덱스 선택을 확인한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    empSetup(session);
    session.execute("CREATE INDEX IX_EMP_SAL ON EMP (SAL)");
    session.execute("CREATE INDEX IX_EMP_NAME_SAL ON EMP (NAME, SAL)");
    const manager = db.manager;
    const catalog = manager.requireCatalog("APP");
    const table = catalog.data.tables["EMP"];
    assert.ok(table !== undefined);
    const typeCtx = { timeZone: resolveTimeZone("local"), currentUtcMicros: 0n };
    const evalConstant = (expression: import("../../src/sql/ast.js").Expression): import("../../src/exec/functions.js").TypedValue | null => {
      try {
        return evaluateExpression(expression, {
          typeCtx,
          params: [],
          scopes: [],
          currentUser: "SYSTEM",
          subqueries: { scalar: () => { throw new Error("no"); }, exists: () => false, columnValues: () => ({ values: [], type: table!.columns[0]!.dataType }) },
          typeSubqueries: { scalar: () => { throw new Error("no"); }, exists: () => false, columnValues: () => ({ values: [], type: table!.columns[0]!.dataType }) },
        });
      } catch {
        return null;
      }
    };
    const whereOf = (sql: string): import("../../src/sql/ast.js").Expression | null => {
      const parsed = parseStatement(sql);
      const stmt = parsed.statement;
      if (stmt.kind !== "Query") throw new Error("not a query");
      const body = stmt.kind === "Query" && stmt.body.kind === "Select" ? stmt.body : null;
      if (body === null) throw new Error("not a select");
      return body.where;
    };
    // PK 동등은 PK 인덱스를 탄다.
    const pkChoice = chooseIndex(catalog, table!, null, whereOf("SELECT * FROM EMP WHERE ID = 1"), evalConstant);
    assert.ok(pkChoice !== null && pkChoice.name === "PK_EMP");
    // 앞쪽 컬럼 동등은 일반 인덱스를 탄다.
    const nameChoice = chooseIndex(catalog, table!, null, whereOf("SELECT * FROM EMP WHERE NAME = 'Ann'"), evalConstant);
    assert.ok(nameChoice !== null && nameChoice.name === "IX_EMP_NAME_SAL" && nameChoice.prefixCount === 1);
    // 범위 조건도 탄다.
    const rangeChoice = chooseIndex(catalog, table!, null, whereOf("SELECT * FROM EMP WHERE SAL > 100"), evalConstant);
    assert.ok(rangeChoice !== null);
    // 뒤쪽 컬럼만으로는 타지 않는다.
    const secondOnly = chooseIndex(catalog, table!, null, whereOf("SELECT * FROM EMP WHERE SAL = 100"), evalConstant);
    assert.ok(secondOnly === null || secondOnly.name !== "IX_EMP_NAME_SAL");
    // 결과가 인덱스 유무와 같아야 한다.
    assert.deepEqual(selectStrings(session.execute("SELECT ID FROM EMP WHERE ID = 2")).rows, [["2"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT ID FROM EMP WHERE SAL >= 7000.50 ORDER BY ID")).rows, [["2"], ["4"]]);
  } finally {
    db.close();
  }
});

test("FOR UPDATE는 잠금 없이 읽는다", (t) => {
  const { db, session } = setupApp(t);
  try {
    empSetup(session);
    assert.deepEqual(selectStrings(session.execute("SELECT NAME FROM EMP WHERE ID = 1 FOR UPDATE")).rows, [["Ann"]]);
  } finally {
    db.close();
  }
});

test("FULL OUTER JOIN과 바이너리·타임존 값을 확인한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE L (ID INTEGER, V VARCHAR(5))");
    session.execute("CREATE TABLE R (ID INTEGER, W VARCHAR(5))");
    session.execute("INSERT INTO L VALUES (1, 'a'), (2, 'b')");
    session.execute("INSERT INTO R VALUES (2, 'x'), (3, 'y')");
    assert.deepEqual(selectStrings(session.execute("SELECT * FROM L FULL JOIN R USING (ID) ORDER BY ID")).rows, [
      ["1", "a", "NULL"],
      ["2", "b", "x"],
      ["3", "NULL", "y"],
    ]);
    // 바이너리 왕복
    session.execute("CREATE TABLE BIN (A BINARY(4), B VARBINARY(10))");
    session.execute("INSERT INTO BIN VALUES (X'0102', X'FF')");
    assert.deepEqual(selectStrings(session.execute("SELECT A, B FROM BIN")).rows, [["01020000", "FF"]]);
    // 타임존 값 왕복
    session.execute("CREATE TABLE TZ (T TIME WITH TIME ZONE, TS TIMESTAMP WITH TIME ZONE)");
    session.execute("INSERT INTO TZ VALUES (TIME '10:00:00+09:00', TIMESTAMP '2024-01-01 10:00:00+09:00')");
    assert.deepEqual(selectStrings(session.execute("SELECT T, TS FROM TZ")).rows, [["10:00:00+09:00", "2024-01-01 10:00:00.000000+09:00"]]);
  } finally {
    db.close();
  }
});

test("다른 테이블스페이스의 뷰를 조회한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLESPACE OTHER");
    session.execute("CREATE TABLE OTHER.T (A INTEGER)");
    session.execute("INSERT INTO OTHER.T VALUES (1), (2)");
    session.execute("CREATE VIEW OTHER.V AS SELECT A * 2 AS B FROM T");
    session.execute("USE OTHER");
    assert.deepEqual(selectStrings(session.execute("SELECT * FROM V ORDER BY B")).rows, [["2"], ["4"]]);
    session.execute("USE APP");
    // 생략된 이름은 뷰의 테이블스페이스(APP이 아님)에서 찾는다.
    assert.deepEqual(selectStrings(session.execute("SELECT * FROM OTHER.V ORDER BY B")).rows, [["2"], ["4"]]);
  } finally {
    db.close();
  }
});

test("깊은 식과 잘못된 값에서도 DbError로 답한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE T (A INTEGER)");
    session.execute("INSERT INTO T VALUES (1)");
    const deep = Array.from({ length: 200 }, (_, i) => `A + ${i}`).join(" + ");
    try {
      session.execute(`SELECT ${deep} FROM T`);
    } catch (error) {
      assert.ok(error instanceof DbError);
    }
    // 0으로 나누기, 오버플로, 잘못된 CAST도 DbError이다.
    for (const sql of ["SELECT 1 / 0 FROM T", "SELECT CAST('abc' AS INTEGER) FROM T", "SELECT * FROM MISSING", "SELECT A + 'x' FROM T"]) {
      assert.throws(() => session.execute(sql), (error: unknown) => error instanceof DbError);
    }
  } finally {
    db.close();
  }
});
