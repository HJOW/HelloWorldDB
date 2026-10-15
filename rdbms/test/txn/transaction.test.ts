/**
 * 트랜잭션 테스트 (7단계).
 * 커밋, 롤백, 세이브포인트, 문장 단위 되돌리기, READ COMMITTED, 자동 커밋 규칙, 행 잠금 충돌(동기),
 * DDL 자동 커밋과 객체 잠금, 커밋 시점 재검증, 세션 종료와 영속성을 본다.
 * 기다림이 있는 시나리오(잠금 대기, 제한 시간, 교착)는 concurrency.test.ts 에 있다.
 * 관련 사양 : AGENTS.md 상세 9, 10
 * 구현 단계 : 7단계
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openTestDb, selectStrings, state, tempDir } from "../exec/helpers.js";
import { Database } from "../../src/session/session.js";
import type { Session } from "../../src/session/session.js";

interface Fixture {
  dir: string;
  db: Database;
  a: Session;
  b: Session;
}

/** APP 테이블스페이스와 같은 데이터베이스를 쓰는 세션 둘을 준비한다. */
function setup(t: { after(fn: () => void): void }): Fixture {
  const dir = tempDir(t);
  const db = openTestDb(dir);
  const a = db.createSession({});
  a.execute("CREATE TABLESPACE APP");
  a.execute("USE APP");
  const b = db.createSession({ tablespace: "APP" });
  return { dir, db, a, b };
}

function rows(session: Session, sql: string): string[][] {
  return selectStrings(session.execute(sql)).rows;
}

function seed(session: Session): void {
  session.execute("CREATE TABLE T (ID INTEGER PRIMARY KEY, V INTEGER)");
  session.execute("INSERT INTO T VALUES (1, 10), (2, 20), (3, 30)");
}

test("COMMIT 하면 다른 세션에 보이고 ROLLBACK 하면 사라진다", (t) => {
  const { db, a, b } = setup(t);
  try {
    seed(a);
    a.execute("BEGIN");
    a.execute("INSERT INTO T VALUES (4, 40)");
    a.execute("UPDATE T SET V = 11 WHERE ID = 1");
    a.execute("DELETE FROM T WHERE ID = 3");
    // 자기 변경은 바로 보인다.
    assert.deepEqual(rows(a, "SELECT ID, V FROM T ORDER BY ID"), [["1", "11"], ["2", "20"], ["4", "40"]]);
    // 다른 세션은 커밋 전 값을 본다. (더티 리드 없음)
    assert.deepEqual(rows(b, "SELECT ID, V FROM T ORDER BY ID"), [["1", "10"], ["2", "20"], ["3", "30"]]);
    a.execute("COMMIT");
    assert.deepEqual(rows(b, "SELECT ID, V FROM T ORDER BY ID"), [["1", "11"], ["2", "20"], ["4", "40"]]);

    a.execute("BEGIN");
    a.execute("INSERT INTO T VALUES (5, 50)");
    a.execute("UPDATE T SET V = 99");
    a.execute("DELETE FROM T WHERE ID = 2");
    a.execute("ROLLBACK");
    assert.deepEqual(rows(a, "SELECT ID, V FROM T ORDER BY ID"), [["1", "11"], ["2", "20"], ["4", "40"]]);
    assert.deepEqual(rows(b, "SELECT ID, V FROM T ORDER BY ID"), [["1", "11"], ["2", "20"], ["4", "40"]]);
    assert.equal(a.inTransaction, false);
  } finally {
    db.close();
  }
});

test("READ COMMITTED : 문장마다 그 시점의 커밋 값을 본다", (t) => {
  const { db, a, b } = setup(t);
  try {
    seed(a);
    b.execute("BEGIN");
    assert.deepEqual(rows(b, "SELECT V FROM T WHERE ID = 1"), [["10"]]);
    // 다른 세션의 자동 커밋 변경이 진행 중인 트랜잭션의 다음 문장에 보인다.
    a.execute("UPDATE T SET V = 12 WHERE ID = 1");
    assert.deepEqual(rows(b, "SELECT V FROM T WHERE ID = 1"), [["12"]]);
    a.execute("INSERT INTO T VALUES (9, 90)");
    assert.deepEqual(rows(b, "SELECT COUNT(*) FROM T"), [["4"]]);
    b.execute("COMMIT");
    assert.throws(() => a.execute("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"));
    assert.equal(a.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED").kind, "ok");
  } finally {
    db.close();
  }
});

test("자기 변경은 PK 조회와 인덱스 조회, 집계에도 반영된다", (t) => {
  const { db, a, b } = setup(t);
  try {
    seed(a);
    a.execute("CREATE INDEX IX_V ON T (V)");
    a.execute("BEGIN");
    a.execute("UPDATE T SET V = 77 WHERE ID = 2");
    a.execute("DELETE FROM T WHERE ID = 3");
    a.execute("INSERT INTO T VALUES (8, 77)");
    assert.deepEqual(rows(a, "SELECT ID FROM T WHERE V = 77 ORDER BY ID"), [["2"], ["8"]]);
    assert.deepEqual(rows(a, "SELECT ID FROM T WHERE V = 20"), []);
    assert.deepEqual(rows(a, "SELECT ID FROM T WHERE ID = 3"), []);
    assert.deepEqual(rows(a, "SELECT V FROM T WHERE ID = 8"), [["77"]]);
    assert.deepEqual(rows(a, "SELECT COUNT(*), SUM(V) FROM T"), [["3", "164"]]);
    // 다른 세션은 아직 옛 인덱스 항목을 본다.
    assert.deepEqual(rows(b, "SELECT ID FROM T WHERE V = 20"), [["2"]]);
    assert.deepEqual(rows(b, "SELECT ID FROM T WHERE V = 77"), []);
    a.execute("COMMIT");
    // 커밋 뒤에는 인덱스 항목도 새 값으로 바뀌어 있다.
    assert.deepEqual(rows(b, "SELECT ID FROM T WHERE V = 77 ORDER BY ID"), [["2"], ["8"]]);
    assert.deepEqual(rows(b, "SELECT ID FROM T WHERE V = 20"), []);
    assert.deepEqual(rows(b, "SELECT ID FROM T WHERE V = 30"), []);
  } finally {
    db.close();
  }
});

test("같은 트랜잭션에서 넣은 행을 바꾸고 지울 수 있다", (t) => {
  const { db, a, b } = setup(t);
  try {
    seed(a);
    a.execute("BEGIN");
    a.execute("INSERT INTO T VALUES (4, 40), (5, 50)");
    a.execute("UPDATE T SET V = V + 1 WHERE ID >= 4");
    a.execute("DELETE FROM T WHERE ID = 5");
    a.execute("UPDATE T SET V = V * 2 WHERE ID = 4");
    assert.deepEqual(rows(a, "SELECT ID, V FROM T WHERE ID >= 4"), [["4", "82"]]);
    a.execute("COMMIT");
    assert.deepEqual(rows(b, "SELECT ID, V FROM T WHERE ID >= 4"), [["4", "82"]]);
  } finally {
    db.close();
  }
});

test("실패한 문장은 그 문장의 변경만 되돌리고 트랜잭션은 이어진다", (t) => {
  const { db, a, b } = setup(t);
  try {
    seed(a);
    a.execute("BEGIN");
    a.execute("INSERT INTO T VALUES (4, 40)");
    // 두 번째 행에서 PK 가 중복되면 문장 전체가 취소된다. (4 도 남지 않는다)
    assert.throws(() => a.execute("INSERT INTO T VALUES (5, 50), (1, 11)"), state("23505"));
    assert.throws(() => a.execute("INSERT INTO T VALUES (6, NULL), (6, 61)"), state("23505"));
    assert.throws(() => a.execute("UPDATE T SET ID = 1 WHERE ID = 2"), state("23505"));
    assert.throws(() => a.execute("UPDATE T SET V = 1 / 0 WHERE ID = 1"), state("22012"));
    assert.deepEqual(rows(a, "SELECT ID, V FROM T ORDER BY ID"), [["1", "10"], ["2", "20"], ["3", "30"], ["4", "40"]]);
    assert.equal(a.inTransaction, true);
    a.execute("INSERT INTO T VALUES (7, 70)");
    a.execute("COMMIT");
    assert.deepEqual(rows(b, "SELECT ID FROM T ORDER BY ID"), [["1"], ["2"], ["3"], ["4"], ["7"]]);
  } finally {
    db.close();
  }
});

test("SAVEPOINT, ROLLBACK TO, RELEASE", (t) => {
  const { db, a, b } = setup(t);
  try {
    seed(a);
    assert.throws(() => a.execute("SAVEPOINT S0"), state("25P01"));
    assert.throws(() => a.execute("ROLLBACK TO S0"), state("25P01"));
    a.execute("BEGIN");
    a.execute("INSERT INTO T VALUES (4, 40)");
    a.execute("SAVEPOINT S1");
    a.execute("UPDATE T SET V = 0 WHERE ID = 1");
    a.execute("DELETE FROM T WHERE ID = 2");
    a.execute("SAVEPOINT S2");
    a.execute("INSERT INTO T VALUES (5, 50)");
    a.execute("UPDATE T SET V = V + 1 WHERE ID = 4");
    assert.deepEqual(rows(a, "SELECT ID, V FROM T ORDER BY ID"), [["1", "0"], ["3", "30"], ["4", "41"], ["5", "50"]]);
    a.execute("ROLLBACK TO SAVEPOINT S2");
    assert.deepEqual(rows(a, "SELECT ID, V FROM T ORDER BY ID"), [["1", "0"], ["3", "30"], ["4", "40"]]);
    // 되돌린 뒤에도 세이브포인트는 남아 있어 다시 되돌릴 수 있다.
    a.execute("INSERT INTO T VALUES (6, 60)");
    a.execute("ROLLBACK TO S2");
    assert.deepEqual(rows(a, "SELECT COUNT(*) FROM T"), [["3"]]);
    a.execute("ROLLBACK TO S1");
    assert.deepEqual(rows(a, "SELECT ID, V FROM T ORDER BY ID"), [["1", "10"], ["2", "20"], ["3", "30"], ["4", "40"]]);
    // S1 로 되돌리면 그 뒤에 만든 S2 는 사라진다.
    assert.throws(() => a.execute("ROLLBACK TO S2"), state("3B001"));
    a.execute("RELEASE SAVEPOINT S1");
    assert.throws(() => a.execute("ROLLBACK TO S1"), state("3B001"));
    assert.throws(() => a.execute("RELEASE S1"), state("3B001"));
    a.execute("COMMIT");
    assert.deepEqual(rows(b, "SELECT ID FROM T ORDER BY ID"), [["1"], ["2"], ["3"], ["4"]]);
    // 같은 이름을 다시 만들면 새 지점으로 바뀐다.
    a.execute("BEGIN");
    a.execute("SAVEPOINT P");
    a.execute("INSERT INTO T VALUES (10, 1)");
    a.execute("SAVEPOINT P");
    a.execute("INSERT INTO T VALUES (11, 1)");
    a.execute("ROLLBACK TO P");
    assert.deepEqual(rows(a, "SELECT ID FROM T WHERE ID >= 10"), [["10"]]);
    a.execute("ROLLBACK");
  } finally {
    db.close();
  }
});

test("자동 커밋 OFF 는 첫 문장에서 트랜잭션을 시작해 COMMIT 까지 이어 간다", (t) => {
  const { db, a, b } = setup(t);
  try {
    seed(a);
    assert.equal(a.autocommit, true);
    a.execute("SET AUTOCOMMIT OFF");
    assert.equal(a.inTransaction, false);
    a.execute("INSERT INTO T VALUES (4, 40)");
    assert.equal(a.inTransaction, true);
    assert.deepEqual(rows(b, "SELECT COUNT(*) FROM T"), [["3"]]);
    a.execute("COMMIT");
    assert.equal(a.inTransaction, false);
    assert.deepEqual(rows(b, "SELECT COUNT(*) FROM T"), [["4"]]);
    a.execute("DELETE FROM T WHERE ID = 4");
    a.execute("ROLLBACK");
    assert.deepEqual(rows(b, "SELECT COUNT(*) FROM T"), [["4"]]);
    // SELECT 도 트랜잭션을 시작한다. SAVEPOINT 가 첫 문장이어도 된다.
    rows(a, "SELECT * FROM T");
    assert.equal(a.inTransaction, true);
    a.execute("COMMIT");
    a.execute("SAVEPOINT S");
    assert.equal(a.inTransaction, true);
    a.execute("INSERT INTO T VALUES (5, 50)");
    a.execute("ROLLBACK TO S");
    assert.deepEqual(rows(a, "SELECT COUNT(*) FROM T"), [["4"]]);
    a.execute("INSERT INTO T VALUES (6, 60)");
    // 자동 커밋을 켜면 진행 중인 트랜잭션이 커밋된다.
    a.execute("SET AUTOCOMMIT ON");
    assert.equal(a.inTransaction, false);
    assert.deepEqual(rows(b, "SELECT ID FROM T WHERE ID >= 4 ORDER BY ID"), [["4"], ["6"]]);
    // 다시 ON 이면 문장마다 바로 커밋된다.
    a.execute("INSERT INTO T VALUES (7, 70)");
    assert.deepEqual(rows(b, "SELECT COUNT(*) FROM T"), [["6"]]);
  } finally {
    db.close();
  }
});

test("BEGIN 과 COMMIT 의 변형과 경계 동작", (t) => {
  const { db, a } = setup(t);
  try {
    seed(a);
    assert.equal(a.execute("COMMIT").kind, "ok");
    assert.equal(a.execute("ROLLBACK").kind, "ok");
    a.execute("START TRANSACTION");
    assert.throws(() => a.execute("BEGIN"), state("25001"));
    assert.throws(() => a.execute("START TRANSACTION"), state("25001"));
    a.execute("INSERT INTO T VALUES (4, 40)");
    a.execute("COMMIT WORK");
    a.execute("BEGIN");
    a.execute("DELETE FROM T");
    a.execute("ROLLBACK WORK");
    assert.deepEqual(rows(a, "SELECT COUNT(*) FROM T"), [["4"]]);
  } finally {
    db.close();
  }
});

test("DDL 은 실행 전에 진행 중인 트랜잭션을 커밋하며 롤백할 수 없다", (t) => {
  const { db, a, b } = setup(t);
  try {
    seed(a);
    a.execute("BEGIN");
    a.execute("INSERT INTO T VALUES (4, 40)");
    a.execute("CREATE TABLE U (X INTEGER)");
    assert.equal(a.inTransaction, false);
    assert.deepEqual(rows(b, "SELECT COUNT(*) FROM T"), [["4"]]);
    a.execute("ROLLBACK");
    assert.deepEqual(rows(b, "SELECT COUNT(*) FROM T"), [["4"]]);
    // 실패한 DDL 도 앞의 커밋은 이미 일어났다.
    a.execute("BEGIN");
    a.execute("INSERT INTO T VALUES (5, 50)");
    assert.throws(() => a.execute("CREATE TABLE U (X INTEGER)"), state("42P07"));
    assert.equal(a.inTransaction, false);
    assert.deepEqual(rows(b, "SELECT COUNT(*) FROM T"), [["5"]]);
    // 만든 객체는 롤백으로 지워지지 않는다.
    a.execute("BEGIN");
    a.execute("CREATE INDEX IX_V ON T (V)");
    a.execute("ROLLBACK");
    assert.deepEqual(rows(b, "SELECT ID FROM T WHERE V = 40"), [["4"]]);
    // TRUNCATE 도 자동 커밋이다.
    a.execute("BEGIN");
    a.execute("INSERT INTO T VALUES (6, 60)");
    a.execute("TRUNCATE TABLE T");
    assert.equal(a.inTransaction, false);
    assert.deepEqual(rows(b, "SELECT COUNT(*) FROM T"), [["0"]]);
  } finally {
    db.close();
  }
});

test("다른 트랜잭션이 잠근 행은 기다리지 않고 55P03 으로 알린다 (동기 실행)", (t) => {
  const { db, a, b } = setup(t);
  try {
    seed(a);
    a.execute("BEGIN");
    a.execute("UPDATE T SET V = 11 WHERE ID = 1");
    // 같은 행은 잠겨 있고, 다른 행은 자유롭다. 조회는 막히지 않는다.
    assert.throws(() => b.execute("UPDATE T SET V = 12 WHERE ID = 1"), state("55P03"));
    assert.throws(() => b.execute("DELETE FROM T WHERE ID = 1"), state("55P03"));
    assert.throws(() => b.execute("SELECT * FROM T WHERE ID = 1 FOR UPDATE"), state("55P03"));
    b.execute("UPDATE T SET V = 22 WHERE ID = 2");
    assert.deepEqual(rows(b, "SELECT V FROM T WHERE ID = 1"), [["10"]]);
    // 여러 행을 바꾸는 문장은 하나라도 막히면 아무것도 바꾸지 않는다.
    assert.throws(() => b.execute("UPDATE T SET V = V + 100"), state("55P03"));
    assert.deepEqual(rows(b, "SELECT V FROM T ORDER BY ID"), [["10"], ["22"], ["30"]]);
    assert.equal(a.execute("COMMIT").kind, "ok");
    b.execute("UPDATE T SET V = 12 WHERE ID = 1");
    assert.deepEqual(rows(a, "SELECT V FROM T ORDER BY ID"), [["12"], ["22"], ["30"]]);

    // 롤백해도 잠금이 풀린다.
    a.execute("BEGIN");
    a.execute("DELETE FROM T WHERE ID = 3");
    assert.throws(() => b.execute("UPDATE T SET V = 0 WHERE ID = 3"), state("55P03"));
    a.execute("ROLLBACK");
    b.execute("UPDATE T SET V = 0 WHERE ID = 3");
    assert.deepEqual(rows(a, "SELECT V FROM T WHERE ID = 3"), [["0"]]);
  } finally {
    db.close();
  }
});

test("같은 PK 를 동시에 넣으려는 쪽은 잠금으로 순서가 정해진다", (t) => {
  const { db, a, b } = setup(t);
  try {
    seed(a);
    a.execute("BEGIN");
    a.execute("INSERT INTO T VALUES (5, 50)");
    assert.throws(() => b.execute("INSERT INTO T VALUES (5, 51)"), state("55P03"));
    b.execute("INSERT INTO T VALUES (6, 60)");
    a.execute("COMMIT");
    // 앞선 쪽이 커밋하면 뒤의 쪽은 중복으로 실패한다.
    assert.throws(() => b.execute("INSERT INTO T VALUES (5, 51)"), state("23505"));
    // 앞선 쪽이 롤백하면 뒤의 쪽이 넣을 수 있다.
    a.execute("BEGIN");
    a.execute("INSERT INTO T VALUES (7, 70)");
    assert.throws(() => b.execute("INSERT INTO T VALUES (7, 71)"), state("55P03"));
    a.execute("ROLLBACK");
    b.execute("INSERT INTO T VALUES (7, 71)");
    assert.deepEqual(rows(a, "SELECT V FROM T WHERE ID = 7"), [["71"]]);
    // PK 를 바꾸는 쪽도 새 PK 값에 잠금을 건다.
    a.execute("BEGIN");
    a.execute("UPDATE T SET ID = 100 WHERE ID = 1");
    assert.throws(() => b.execute("INSERT INTO T VALUES (100, 0)"), state("55P03"));
    a.execute("COMMIT");
    assert.deepEqual(rows(b, "SELECT V FROM T WHERE ID = 100"), [["10"]]);
  } finally {
    db.close();
  }
});

test("SELECT ... FOR UPDATE 는 읽은 행을 잠그고 트랜잭션이 끝나면 푼다", (t) => {
  const { db, a, b } = setup(t);
  try {
    seed(a);
    a.execute("BEGIN");
    assert.deepEqual(rows(a, "SELECT V FROM T WHERE ID = 2 FOR UPDATE"), [["20"]]);
    assert.throws(() => b.execute("UPDATE T SET V = 0 WHERE ID = 2"), state("55P03"));
    b.execute("UPDATE T SET V = 0 WHERE ID = 1");
    a.execute("COMMIT");
    b.execute("UPDATE T SET V = 0 WHERE ID = 2");

    // ORDER BY 와 FETCH 로 돌려준 행만 잠근다.
    a.execute("BEGIN");
    assert.deepEqual(rows(a, "SELECT ID FROM T ORDER BY ID DESC FETCH FIRST 1 ROW ONLY FOR UPDATE"), [["3"]]);
    b.execute("UPDATE T SET V = 5 WHERE ID = 1");
    assert.throws(() => b.execute("UPDATE T SET V = 5 WHERE ID = 3"), state("55P03"));
    a.execute("ROLLBACK");

    // 자동 커밋에서는 문장이 끝나면 풀린다.
    assert.deepEqual(rows(a, "SELECT V FROM T WHERE ID = 3 FOR UPDATE"), [["30"]]);
    b.execute("UPDATE T SET V = 31 WHERE ID = 3");

    // 자기 트랜잭션이 넣은 행과 바꾼 행도 잠글 수 있다.
    a.execute("BEGIN");
    a.execute("INSERT INTO T VALUES (8, 80)");
    a.execute("UPDATE T SET V = 1 WHERE ID = 1");
    assert.deepEqual(rows(a, "SELECT ID FROM T WHERE ID IN (1, 8) ORDER BY ID FOR UPDATE"), [["1"], ["8"]]);
    a.execute("COMMIT");
  } finally {
    db.close();
  }
});

test("FOR UPDATE 를 쓸 수 없는 질의는 0A000 이다", (t) => {
  const { db, a } = setup(t);
  try {
    seed(a);
    a.execute("CREATE VIEW VT AS SELECT ID, V FROM T");
    assert.throws(() => a.execute("SELECT DISTINCT V FROM T FOR UPDATE"), state("0A000"));
    assert.throws(() => a.execute("SELECT V, COUNT(*) FROM T GROUP BY V FOR UPDATE"), state("0A000"));
    assert.throws(() => a.execute("SELECT COUNT(*) FROM T FOR UPDATE"), state("0A000"));
    assert.throws(() => a.execute("SELECT ID FROM T UNION SELECT ID FROM T FOR UPDATE"), state("0A000"));
    assert.throws(() => a.execute("SELECT * FROM VT FOR UPDATE"), state("0A000"));
    assert.throws(() => a.execute("SELECT * FROM (SELECT * FROM T) X FOR UPDATE"), state("0A000"));
    // 기반 테이블끼리의 조인은 된다.
    assert.deepEqual(rows(a, "SELECT X.ID FROM T X JOIN T Y ON X.ID = Y.ID WHERE X.ID = 1 FOR UPDATE"), [["1"]]);
  } finally {
    db.close();
  }
});

test("세션을 닫으면 커밋하지 않은 변경이 롤백되고 잠금이 풀린다", (t) => {
  const { db, a, b } = setup(t);
  try {
    seed(a);
    const reasons: string[] = [];
    a.onClose((reason) => reasons.push(reason));
    a.execute("BEGIN");
    a.execute("UPDATE T SET V = 0");
    a.execute("INSERT INTO T VALUES (9, 90)");
    assert.throws(() => b.execute("UPDATE T SET V = 1 WHERE ID = 1"), state("55P03"));
    a.close();
    assert.deepEqual(reasons, ["closed"]);
    assert.equal(a.isClosed, true);
    assert.throws(() => a.execute("SELECT 1"), state("08003"));
    assert.equal(db.locks.lockCount, 0);
    assert.deepEqual(rows(b, "SELECT ID, V FROM T ORDER BY ID"), [["1", "10"], ["2", "20"], ["3", "30"]]);
    b.execute("UPDATE T SET V = 1 WHERE ID = 1");
    a.close();
  } finally {
    db.close();
  }
});

test("커밋한 변경은 다시 열어도 남고 커밋하지 않은 변경은 남지 않는다", (t) => {
  const dir = tempDir(t);
  let db = openTestDb(dir);
  let a = db.createSession({});
  a.execute("CREATE TABLESPACE APP");
  a.execute("USE APP");
  seed(a);
  a.execute("BEGIN");
  a.execute("INSERT INTO T VALUES (4, 40)");
  a.execute("UPDATE T SET V = 11 WHERE ID = 1");
  a.execute("COMMIT");
  a.execute("BEGIN");
  a.execute("INSERT INTO T VALUES (5, 50)");
  a.execute("DELETE FROM T WHERE ID = 2");
  a.execute("UPDATE T SET V = 0");
  // 닫을 때 진행 중인 트랜잭션을 롤백한다.
  db.close();
  db = openTestDb(dir);
  try {
    a = db.createSession({ tablespace: "APP" });
    assert.deepEqual(rows(a, "SELECT ID, V FROM T ORDER BY ID"), [["1", "11"], ["2", "20"], ["3", "30"], ["4", "40"]]);
    // 인덱스도 일관된다.
    assert.deepEqual(rows(a, "SELECT V FROM T WHERE ID = 4"), [["40"]]);
    assert.deepEqual(rows(a, "SELECT V FROM T WHERE ID = 5"), []);
  } finally {
    db.close();
  }
});

test("DDL 은 다른 트랜잭션이 그 테이블의 행을 잠그고 있으면 실행하지 않는다", (t) => {
  const { db, a, b } = setup(t);
  try {
    seed(a);
    a.execute("CREATE TABLE OTHER (X INTEGER)");
    a.execute("BEGIN");
    a.execute("UPDATE T SET V = 1 WHERE ID = 1");
    assert.throws(() => b.execute("ALTER TABLE T ADD COLUMN W INTEGER"), state("55P03"));
    assert.throws(() => b.execute("DROP TABLE T"), state("55P03"));
    assert.throws(() => b.execute("TRUNCATE TABLE T"), state("55P03"));
    assert.throws(() => b.execute("CREATE INDEX IX_V ON T (V)"), state("55P03"));
    // 다른 테이블의 DDL 은 영향이 없다.
    b.execute("ALTER TABLE OTHER ADD COLUMN Y INTEGER");
    a.execute("COMMIT");
    b.execute("ALTER TABLE T ADD COLUMN W INTEGER");
    assert.deepEqual(rows(a, "SELECT ID, V, W FROM T WHERE ID = 1"), [["1", "1", "NULL"]]);
    // 객체 잠금은 DDL 이 끝나면 풀린다.
    assert.equal(db.locks.lockCount, 0);
  } finally {
    db.close();
  }
});

test("트랜잭션 중에 테이블 정의가 바뀌면 커밋이 40001 로 실패하고 롤백된다", (t) => {
  const { db, a, b } = setup(t);
  try {
    // PK 가 없는 테이블은 삽입에 잠금이 없어 DDL 과 부딪치지 않는다. 커밋 때 정의가 바뀐 것을 안다.
    a.execute("CREATE TABLE N (X INTEGER)");
    a.execute("INSERT INTO N VALUES (1)");
    a.execute("BEGIN");
    a.execute("INSERT INTO N VALUES (2)");
    b.execute("ALTER TABLE N ADD COLUMN Y INTEGER");
    assert.throws(() => a.execute("COMMIT"), state("40001"));
    assert.equal(a.inTransaction, false);
    assert.deepEqual(rows(b, "SELECT X FROM N ORDER BY X"), [["1"]]);
    assert.equal(db.locks.lockCount, 0);
    // 테이블이 지워진 경우도 같다.
    a.execute("BEGIN");
    a.execute("INSERT INTO N (X) VALUES (3)");
    b.execute("DROP TABLE N");
    assert.throws(() => a.execute("COMMIT"), state("40001"));
    assert.equal(a.inTransaction, false);
  } finally {
    db.close();
  }
});

test("커밋 직전에 참조 무결성을 다시 확인한다", (t) => {
  const { db, a, b } = setup(t);
  try {
    a.execute("CREATE TABLE P (ID INTEGER PRIMARY KEY)");
    a.execute("CREATE TABLE C (ID INTEGER PRIMARY KEY, PID INTEGER REFERENCES P)");
    a.execute("INSERT INTO P VALUES (1), (2)");
    a.execute("BEGIN");
    a.execute("INSERT INTO C VALUES (10, 1)");
    // 다른 세션이 아직 자식이 없는 것으로 보이는 부모를 지우고 커밋한다.
    b.execute("DELETE FROM P WHERE ID = 1");
    assert.throws(() => a.execute("COMMIT"), state("23503"));
    assert.equal(a.inTransaction, false);
    assert.deepEqual(rows(b, "SELECT COUNT(*) FROM C"), [["0"]]);
    // 반대 방향 : 트랜잭션이 부모를 지우는 사이 다른 세션이 자식을 넣고 커밋한다.
    a.execute("BEGIN");
    a.execute("DELETE FROM P WHERE ID = 2");
    b.execute("INSERT INTO C VALUES (20, 2)");
    assert.throws(() => a.execute("COMMIT"), state("23503"));
    assert.deepEqual(rows(b, "SELECT PID FROM C"), [["2"]]);
    assert.deepEqual(rows(b, "SELECT ID FROM P"), [["2"]]);
    // 문제가 없으면 정상 커밋된다.
    a.execute("BEGIN");
    a.execute("INSERT INTO P VALUES (3)");
    a.execute("INSERT INTO C VALUES (30, 3)");
    a.execute("COMMIT");
    assert.deepEqual(rows(b, "SELECT ID FROM C ORDER BY ID"), [["20"], ["30"]]);
  } finally {
    db.close();
  }
});

test("참조동작으로 바뀐 자식 행도 한 트랜잭션으로 묶인다", (t) => {
  const { db, a, b } = setup(t);
  try {
    a.execute("CREATE TABLE P (ID INTEGER PRIMARY KEY)");
    a.execute("CREATE TABLE C (ID INTEGER PRIMARY KEY, PID INTEGER REFERENCES P ON DELETE CASCADE)");
    a.execute("INSERT INTO P VALUES (1), (2)");
    a.execute("INSERT INTO C VALUES (10, 1), (11, 1), (12, 2)");
    a.execute("BEGIN");
    a.execute("DELETE FROM P WHERE ID = 1");
    assert.deepEqual(rows(a, "SELECT ID FROM C ORDER BY ID"), [["12"]]);
    assert.deepEqual(rows(b, "SELECT ID FROM C ORDER BY ID"), [["10"], ["11"], ["12"]]);
    a.execute("ROLLBACK");
    assert.deepEqual(rows(b, "SELECT ID FROM C ORDER BY ID"), [["10"], ["11"], ["12"]]);
    a.execute("BEGIN");
    a.execute("DELETE FROM P WHERE ID = 1");
    a.execute("COMMIT");
    assert.deepEqual(rows(b, "SELECT ID FROM C ORDER BY ID"), [["12"]]);
    assert.deepEqual(rows(b, "SELECT ID FROM P ORDER BY ID"), [["2"]]);
  } finally {
    db.close();
  }
});

test("지운 PK 를 다시 넣거나 PK 값을 맞바꾸는 변경도 커밋된다", (t) => {
  const { db, a, b } = setup(t);
  try {
    seed(a);
    a.execute("BEGIN");
    a.execute("DELETE FROM T WHERE ID = 1");
    a.execute("INSERT INTO T VALUES (1, 111)");
    a.execute("COMMIT");
    assert.deepEqual(rows(b, "SELECT V FROM T WHERE ID = 1"), [["111"]]);
    a.execute("BEGIN");
    a.execute("UPDATE T SET ID = 3 - ID WHERE ID IN (1, 2)");
    a.execute("COMMIT");
    assert.deepEqual(rows(b, "SELECT ID, V FROM T ORDER BY ID"), [["1", "20"], ["2", "111"], ["3", "30"]]);
    assert.deepEqual(rows(b, "SELECT V FROM T WHERE ID = 2"), [["111"]]);
  } finally {
    db.close();
  }
});

test("여러 테이블스페이스를 건드린 트랜잭션도 한 번에 커밋된다", (t) => {
  const { db, a, b } = setup(t);
  try {
    a.execute("CREATE TABLESPACE OTHER");
    a.execute("CREATE TABLE APP.T1 (ID INTEGER PRIMARY KEY)");
    a.execute("CREATE TABLE OTHER.T2 (ID INTEGER PRIMARY KEY)");
    a.execute("BEGIN");
    a.execute("INSERT INTO APP.T1 VALUES (1)");
    a.execute("INSERT INTO OTHER.T2 VALUES (2)");
    assert.deepEqual(rows(b, "SELECT COUNT(*) FROM APP.T1"), [["0"]]);
    assert.deepEqual(rows(b, "SELECT COUNT(*) FROM OTHER.T2"), [["0"]]);
    a.execute("COMMIT");
    assert.deepEqual(rows(b, "SELECT ID FROM APP.T1"), [["1"]]);
    assert.deepEqual(rows(b, "SELECT ID FROM OTHER.T2"), [["2"]]);
  } finally {
    db.close();
  }
});

test("뷰를 통한 변경도 트랜잭션에 묶인다", (t) => {
  const { db, a, b } = setup(t);
  try {
    seed(a);
    a.execute("CREATE VIEW VT AS SELECT ID, V FROM T WHERE V >= 20");
    a.execute("BEGIN");
    a.execute("UPDATE VT SET V = 21 WHERE ID = 2");
    a.execute("INSERT INTO VT VALUES (4, 40)");
    a.execute("DELETE FROM VT WHERE ID = 3");
    assert.deepEqual(rows(a, "SELECT ID, V FROM VT ORDER BY ID"), [["2", "21"], ["4", "40"]]);
    assert.deepEqual(rows(b, "SELECT ID, V FROM VT ORDER BY ID"), [["2", "20"], ["3", "30"]]);
    a.execute("ROLLBACK");
    assert.deepEqual(rows(b, "SELECT ID, V FROM VT ORDER BY ID"), [["2", "20"], ["3", "30"]]);
  } finally {
    db.close();
  }
});

test("세션 목록과 유휴 세션 종료", (t) => {
  const dir = tempDir(t);
  const db = Database.open(dir, { onWarning: () => {}, idleTimeoutMs: 50 });
  try {
    const a = db.createSession({});
    a.execute("CREATE TABLESPACE APP");
    a.execute("USE APP");
    seed(a);
    const b = db.createSession({ tablespace: "APP" });
    a.execute("BEGIN");
    a.execute("UPDATE T SET V = 0");
    assert.equal(db.sessions.count, 2);
    assert.deepEqual(
      db.sessions.list().map((info) => [info.id, info.inTransaction]),
      [[a.id, true], [b.id, false]],
    );
    const reasons: string[] = [];
    a.onClose((reason) => reasons.push(reason));
    // 제한 시간(50ms) 전에는 닫지 않는다.
    const now = Date.now();
    a.lastActivity = now - 10;
    b.lastActivity = now - 10;
    assert.equal(db.sessions.sweepIdle(now), 0);
    // 제한 시간을 넘긴 세션은 닫고 커밋하지 않은 변경은 롤백한다. 방금 쓴 세션은 남긴다.
    a.lastActivity = now - 1000;
    assert.equal(db.sessions.sweepIdle(now), 1);
    assert.equal(a.isClosed, true);
    assert.equal(b.isClosed, false);
    assert.deepEqual(reasons, ["idle"]);
    assert.deepEqual(rows(b, "SELECT V FROM T ORDER BY ID"), [["10"], ["20"], ["30"]]);
    assert.equal(db.locks.lockCount, 0);
    assert.equal(db.sessions.count, 1);
  } finally {
    db.close();
  }
});

test("데이터베이스를 닫으면 세션이 모두 끝나고 새 세션을 만들 수 없다", (t) => {
  const dir = tempDir(t);
  const db = openTestDb(dir);
  const a = db.createSession({});
  a.execute("CREATE TABLE T (ID INTEGER PRIMARY KEY)");
  a.execute("BEGIN");
  a.execute("INSERT INTO T VALUES (1)");
  const reasons: string[] = [];
  a.onClose((reason) => reasons.push(reason));
  db.close();
  assert.deepEqual(reasons, ["shutdown"]);
  assert.equal(a.isClosed, true);
  assert.throws(() => db.createSession({}), state("57P01"));
});

test("SYS_SESSIONS 는 접속 중인 세션과 트랜잭션 상태를 보여 준다", (t) => {
  const { db, a, b } = setup(t);
  try {
    seed(a);
    a.execute("BEGIN");
    a.execute("INSERT INTO T VALUES (4, 40)");
    b.execute("SET AUTOCOMMIT OFF");
    const view = "SELECT SESSION_ID, USER_NAME, TABLESPACE_NAME, AUTOCOMMIT, IN_TRANSACTION FROM SYSTEM.SYS_SESSIONS ORDER BY SESSION_ID";
    assert.deepEqual(rows(b, view), [
      [String(a.id), "SYSTEM", "APP", "YES", "YES"],
      [String(b.id), "SYSTEM", "APP", "NO", "YES"],
    ]);
    // 세션이 끝나면 목록에서 빠지고, 트랜잭션이 끝나면 IN_TRANSACTION 이 바뀐다.
    a.execute("COMMIT");
    b.close();
    assert.deepEqual(rows(a, view), [[String(a.id), "SYSTEM", "APP", "YES", "NO"]]);
    assert.deepEqual(rows(a, "SELECT COUNT(*) FROM SYSTEM.SYS_SESSIONS"), [["1"]]);
  } finally {
    db.close();
  }
});
