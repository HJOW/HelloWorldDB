/**
 * 권한 테스트 (8단계).
 * 권한 조합별 허용과 거부, 수준별 독립성, 소유자 자격, 권한 그룹(OFFICER, DBA), GRANT/REVOKE 실행 자격,
 * 뷰 권한 규칙(개요 5 의 뷰 UPDATE 예시 포함), 딕셔너리 뷰의 가시성, 기록 정리를 본다.
 * 관련 사양 : AGENTS.md 상세 5, 6, 3
 * 구현 단계 : 8단계
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../../src/session/session.js";
import { denied, makeUser, rows, setupAuth, state } from "./helpers.js";
import type { AuthFixture } from "./helpers.js";

interface Cast {
  fixture: AuthFixture;
  /** 테이블스페이스 APP 의 CREATE 를 받은 소유자. 테이블 T(ID, V)를 만들고 3행을 넣었다. */
  alice: Session;
  bob: Session;
  carol: Session;
}

/** ALICE 가 APP.T 를 소유하고 BOB, CAROL 은 아무 권한이 없는 상태를 만든다. 모두 APP 에서 시작한다. */
function setupCast(t: { after(fn: () => void): void }): Cast {
  const fixture = setupAuth(t);
  const { db, admin } = fixture;
  for (const name of ["ALICE", "BOB", "CAROL"]) makeUser(admin, name, "APP");
  admin.execute("GRANT CREATE ON TABLESPACE APP TO ALICE");
  const alice = db.login("ALICE", "alice-pw");
  alice.execute("CREATE TABLE T (ID INTEGER PRIMARY KEY, V INTEGER)");
  alice.execute("INSERT INTO T VALUES (1, 10), (2, 20), (3, 30)");
  return { fixture, alice, bob: db.login("BOB", "bob-pw"), carol: db.login("CAROL", "carol-pw") };
}

test("권한이 없으면 SELECT, INSERT, UPDATE, DELETE, DDL 이 모두 거부된다", (t) => {
  const { fixture, bob } = setupCast(t);
  try {
    assert.throws(() => bob.execute("SELECT * FROM T"), denied);
    assert.throws(() => bob.execute("INSERT INTO T VALUES (9, 9)"), denied);
    assert.throws(() => bob.execute("UPDATE T SET V = 0"), denied);
    assert.throws(() => bob.execute("DELETE FROM T"), denied);
    assert.throws(() => bob.execute("CREATE TABLE X (A INTEGER)"), denied);
    assert.throws(() => bob.execute("CREATE VIEW VX AS SELECT 1"), denied);
    assert.throws(() => bob.execute("ALTER TABLE T ADD COLUMN W INTEGER"), denied);
    assert.throws(() => bob.execute("CREATE INDEX ON T (V)"), denied);
    assert.throws(() => bob.execute("TRUNCATE TABLE T"), denied);
    assert.throws(() => bob.execute("DROP TABLE T"), denied);
    // 거부된 문장은 아무것도 바꾸지 못했다.
    assert.deepEqual(rows(fixture.admin, "SELECT COUNT(*) FROM APP.T"), [["3"]]);
  } finally {
    fixture.db.close();
  }
});

test("객체 수준 권한은 문장 종류별로 따로 적용된다", (t) => {
  const { fixture, bob } = setupCast(t);
  const { admin } = fixture;
  try {
    admin.execute("GRANT SELECT ON TABLE APP.T TO BOB");
    assert.deepEqual(rows(bob, "SELECT V FROM T WHERE ID = 2"), [["20"]]);
    assert.throws(() => bob.execute("UPDATE T SET V = 0"), denied);
    assert.throws(() => bob.execute("INSERT INTO T VALUES (4, 40)"), denied);
    assert.throws(() => bob.execute("DELETE FROM T"), denied);

    admin.execute("GRANT INSERT ON APP.T TO BOB"); // TABLE 생략
    bob.execute("INSERT INTO T VALUES (4, 40)");
    assert.throws(() => bob.execute("UPDATE T SET V = 0"), denied);

    admin.execute("GRANT UPDATE ON TABLE APP.T TO BOB");
    bob.execute("UPDATE T SET V = 41 WHERE ID = 4");
    assert.throws(() => bob.execute("DELETE FROM T WHERE ID = 4"), denied);

    admin.execute("GRANT DELETE ON TABLE APP.T TO BOB");
    bob.execute("DELETE FROM T WHERE ID = 4");
    assert.deepEqual(rows(bob, "SELECT COUNT(*) FROM T"), [["3"]]);

    // DDL 권한은 따로이다. SELECT, INSERT, UPDATE, DELETE 가 있어도 ALTER, DROP 은 없다.
    assert.throws(() => bob.execute("ALTER TABLE T ADD COLUMN W INTEGER"), denied);
    assert.throws(() => bob.execute("DROP TABLE T"), denied);

    admin.execute("GRANT ALTER ON TABLE APP.T TO BOB");
    bob.execute("ALTER TABLE T ADD COLUMN W INTEGER");
    bob.execute("CREATE INDEX IX_T_V ON T (V)");
    bob.execute("DROP INDEX IX_T_V");
    assert.throws(() => bob.execute("TRUNCATE TABLE T"), denied);
    assert.throws(() => bob.execute("DROP TABLE T"), denied);

    admin.execute("GRANT DROP ON TABLE APP.T TO BOB");
    bob.execute("TRUNCATE TABLE T");
    bob.execute("DROP TABLE T");
    assert.deepEqual(rows(admin, "SELECT TABLE_NAME FROM SYS_TABLES WHERE TABLESPACE_NAME = 'APP'"), []);
  } finally {
    fixture.db.close();
  }
});

test("테이블스페이스 수준 권한은 그 안의 모든 객체(나중에 만든 것 포함)에 적용된다", (t) => {
  const { fixture, alice, bob } = setupCast(t);
  const { admin } = fixture;
  try {
    admin.execute("GRANT SELECT, UPDATE ON TABLESPACE APP TO BOB");
    assert.deepEqual(rows(bob, "SELECT COUNT(*) FROM T"), [["3"]]);
    bob.execute("UPDATE T SET V = V + 1");
    assert.throws(() => bob.execute("INSERT INTO T VALUES (9, 9)"), denied);
    // 나중에 만든 테이블에도 적용된다.
    alice.execute("CREATE TABLE LATER (A INTEGER)");
    alice.execute("INSERT INTO LATER VALUES (7)");
    assert.deepEqual(rows(bob, "SELECT A FROM LATER"), [["7"]]);
    // 다른 테이블스페이스에는 적용되지 않는다.
    admin.execute("CREATE TABLESPACE OTHER");
    admin.execute("CREATE TABLE OTHER.Z (A INTEGER)");
    assert.throws(() => bob.execute("SELECT * FROM OTHER.Z"), denied);
    // CREATE 는 테이블스페이스 수준에서만 준다.
    assert.throws(() => bob.execute("CREATE TABLE B1 (A INTEGER)"), denied);
    admin.execute("GRANT CREATE ON TABLESPACE APP TO BOB");
    bob.execute("CREATE TABLE B1 (A INTEGER)");
    // 만든 사람이 소유자이다.
    assert.deepEqual(rows(admin, "SELECT OWNER FROM SYS_TABLES WHERE TABLE_NAME = 'B1'"), [["BOB"]]);
    // 회수하면 바로 적용된다.
    admin.execute("REVOKE SELECT ON TABLESPACE APP FROM BOB");
    assert.throws(() => bob.execute("SELECT * FROM T"), denied);
    bob.execute("UPDATE T SET V = V + 1"); // UPDATE 는 남아 있다.
  } finally {
    fixture.db.close();
  }
});

test("테이블스페이스 수준과 객체 수준의 부여 기록은 서로 독립이다", (t) => {
  const { fixture, bob } = setupCast(t);
  const { admin } = fixture;
  try {
    admin.execute("GRANT SELECT ON TABLESPACE APP TO BOB");
    admin.execute("GRANT SELECT ON TABLE APP.T TO BOB");
    // 테이블스페이스 수준을 회수해도 객체 수준으로 따로 준 권한은 남는다.
    admin.execute("REVOKE SELECT ON TABLESPACE APP FROM BOB");
    assert.deepEqual(rows(bob, "SELECT COUNT(*) FROM T"), [["3"]]);
    // 반대로 객체 수준을 회수해도 테이블스페이스 수준은 남는다.
    admin.execute("GRANT SELECT ON TABLESPACE APP TO BOB");
    admin.execute("REVOKE SELECT ON TABLE APP.T FROM BOB");
    assert.deepEqual(rows(bob, "SELECT COUNT(*) FROM T"), [["3"]]);
    admin.execute("REVOKE SELECT ON TABLESPACE APP FROM BOB");
    assert.throws(() => bob.execute("SELECT * FROM T"), denied);
    // 부여된 적 없는 권한을 회수하면 오류 없이 넘어간다.
    admin.execute("REVOKE DELETE ON TABLE APP.T FROM BOB");
    admin.execute("REVOKE ALL ON TABLESPACE APP FROM BOB");
    // 사용자 여러 명에게 한 번에 준다.
    admin.execute("GRANT SELECT ON TABLE APP.T TO BOB, CAROL");
    assert.deepEqual(rows(admin, "SELECT GRANTEE FROM SYS_PRIVILEGES WHERE OBJECT_NAME = 'T' ORDER BY GRANTEE"), [["BOB"], ["CAROL"]]);
  } finally {
    fixture.db.close();
  }
});

test("ALL 은 그 수준에서 줄 수 있는 권한 전부이고, CREATE 는 테이블스페이스 수준에만 줄 수 있다", (t) => {
  const { fixture } = setupCast(t);
  const { admin } = fixture;
  try {
    admin.execute("GRANT ALL ON TABLE APP.T TO BOB");
    assert.deepEqual(
      rows(admin, "SELECT PRIVILEGE FROM SYS_PRIVILEGES WHERE GRANTEE = 'BOB' ORDER BY PRIVILEGE"),
      [["ALTER"], ["DELETE"], ["DROP"], ["INSERT"], ["SELECT"], ["UPDATE"]],
    );
    admin.execute("GRANT ALL PRIVILEGES ON TABLESPACE APP TO CAROL");
    assert.deepEqual(
      rows(admin, "SELECT PRIVILEGE FROM SYS_PRIVILEGES WHERE GRANTEE = 'CAROL' AND OBJECT_NAME IS NULL ORDER BY PRIVILEGE"),
      [["ALTER"], ["CREATE"], ["DELETE"], ["DROP"], ["INSERT"], ["SELECT"], ["UPDATE"]],
    );
    assert.throws(() => admin.execute("GRANT CREATE ON TABLE APP.T TO BOB"), state("0LP01"));
    admin.execute("REVOKE ALL ON TABLE APP.T FROM BOB");
    assert.deepEqual(rows(admin, "SELECT COUNT(*) FROM SYS_PRIVILEGES WHERE GRANTEE = 'BOB'"), [["0"]]);
    // 같은 권한을 두 번 주어도 기록은 하나이다.
    admin.execute("GRANT SELECT ON TABLE APP.T TO BOB");
    admin.execute("GRANT SELECT ON TABLE APP.T TO BOB");
    assert.deepEqual(rows(admin, "SELECT COUNT(*) FROM SYS_PRIVILEGES WHERE GRANTEE = 'BOB'"), [["1"]]);
  } finally {
    fixture.db.close();
  }
});

test("GRANT, REVOKE 의 대상 검사 : 없는 사용자, 없는 객체, 종류 불일치", (t) => {
  const { fixture, alice } = setupCast(t);
  const { admin } = fixture;
  try {
    alice.execute("CREATE VIEW VT AS SELECT * FROM T");
    assert.throws(() => admin.execute("GRANT SELECT ON TABLE APP.T TO NOBODY"), state("42704"));
    assert.throws(() => admin.execute("GRANT SELECT ON TABLE APP.NOPE TO ALICE"), state("42P01"));
    assert.throws(() => admin.execute("GRANT SELECT ON TABLESPACE NOPE TO ALICE"), state("3D000"));
    assert.throws(() => admin.execute("GRANT SELECT ON TABLE APP.VT TO BOB"), state("42P01"));
    assert.throws(() => admin.execute("GRANT SELECT ON VIEW APP.T TO BOB"), state("42P01"));
    admin.execute("GRANT SELECT ON VIEW APP.VT TO BOB");
    // 딕셔너리 뷰의 권한은 관리하지 않는다.
    assert.throws(() => admin.execute("GRANT SELECT ON SYSTEM.SYS_TABLES TO BOB"), state("42809"));
    // WITH GRANT OPTION, PUBLIC, 컬럼 권한은 지원하지 않는다.
    assert.throws(() => admin.execute("GRANT SELECT ON TABLE APP.T TO BOB WITH GRANT OPTION"), state("0A000"));
    assert.throws(() => admin.execute("GRANT SELECT ON TABLE APP.T TO PUBLIC"), state("0A000"));
    assert.throws(() => admin.execute("GRANT SELECT (V) ON TABLE APP.T TO BOB"), state("0A000"));
  } finally {
    fixture.db.close();
  }
});

test("테이블 소유자는 모든 권한을 가지고, 자기 테이블에 한해 GRANT, REVOKE 를 할 수 있다", (t) => {
  const { fixture, alice, bob, carol } = setupCast(t);
  const { admin } = fixture;
  try {
    // 소유자는 따로 받은 것 없이도 모든 일을 한다.
    alice.execute("UPDATE T SET V = V * 2");
    alice.execute("CREATE INDEX ON T (V)");
    alice.execute("ALTER TABLE T ADD COLUMN W INTEGER");
    // 소유자가 자기 테이블의 권한을 남에게 준다.
    alice.execute("GRANT SELECT, UPDATE ON TABLE T TO BOB");
    assert.deepEqual(rows(bob, "SELECT V FROM T ORDER BY ID"), [["20"], ["40"], ["60"]]);
    bob.execute("UPDATE T SET V = 0 WHERE ID = 1");
    alice.execute("REVOKE UPDATE ON T FROM BOB");
    assert.throws(() => bob.execute("UPDATE T SET V = 1"), denied);
    // 소유자가 아니면 권한을 줄 수 없다. 받은 권한을 다시 주는 것(상속)도 되지 않는다.
    assert.throws(() => bob.execute("GRANT SELECT ON TABLE T TO CAROL"), denied);
    assert.throws(() => carol.execute("GRANT SELECT ON TABLE T TO CAROL"), denied);
    assert.throws(() => bob.execute("REVOKE SELECT ON TABLE T FROM BOB"), denied);
    // 테이블스페이스 수준 권한은 DBA 만 준다. 소유자도 안 된다.
    assert.throws(() => alice.execute("GRANT SELECT ON TABLESPACE APP TO BOB"), denied);
    assert.throws(() => alice.execute("REVOKE CREATE ON TABLESPACE APP FROM ALICE"), denied);
    // DBA 는 남의 테이블 권한도 준다.
    admin.execute("GRANT DELETE ON TABLE APP.T TO CAROL");
    assert.equal(fixture.db.access.can("CAROL", "DELETE", "APP", "T"), true);
  } finally {
    fixture.db.close();
  }
});

test("OFFICER 는 SYSTEM 을 제외한 모든 테이블스페이스에 CRUD 와 DDL 을 하되 관리 일은 못 한다", (t) => {
  const { fixture, alice, bob } = setupCast(t);
  const { admin } = fixture;
  try {
    admin.execute("GRANT OFFICER TO BOB");
    // 나중에 만든 테이블스페이스에도 적용된다.
    admin.execute("CREATE TABLESPACE LATER_TS");
    for (const sql of [
      "SELECT COUNT(*) FROM APP.T",
      "UPDATE APP.T SET V = V + 1",
      "CREATE TABLE LATER_TS.X (A INTEGER)",
      "INSERT INTO LATER_TS.X VALUES (1)",
      "ALTER TABLE LATER_TS.X ADD COLUMN B INTEGER",
      "DROP TABLE LATER_TS.X",
    ]) {
      bob.execute(sql);
    }
    bob.execute("CREATE VIEW APP.BV AS SELECT ID FROM APP.T");
    bob.execute("DROP VIEW APP.BV");
    // SYSTEM 테이블스페이스는 제외된다.
    assert.throws(() => bob.execute("CREATE TABLE SYSTEM.X (A INTEGER)"), denied);
    // 관리 일은 포함하지 않는다.
    assert.throws(() => bob.execute("CREATE USER DAVE IDENTIFIED BY 'x'"), denied);
    assert.throws(() => bob.execute("CREATE TABLESPACE Y"), denied);
    assert.throws(() => bob.execute("GRANT SELECT ON TABLE APP.T TO CAROL"), denied);
    assert.throws(() => bob.execute("GRANT SELECT ON TABLESPACE APP TO CAROL"), denied);
    // 회수하면 바로 막힌다.
    admin.execute("REVOKE OFFICER FROM BOB");
    assert.throws(() => bob.execute("SELECT * FROM APP.T"), denied);
    void alice;
  } finally {
    fixture.db.close();
  }
});

test("DBA 는 모든 권한을 가지고 SYSTEM 테이블스페이스 객체도 다룬다", (t) => {
  const { fixture, alice, bob } = setupCast(t);
  const { admin, db: database } = fixture;
  try {
    makeUser(admin, "DEBBIE", "APP");
    admin.execute("GRANT DBA TO DEBBIE");
    const debbie = database.login("DEBBIE", "debbie-pw");
    debbie.execute("UPDATE APP.T SET V = 1");
    debbie.execute("CREATE TABLE SYSTEM.NOTES (A INTEGER)");
    debbie.execute("INSERT INTO SYSTEM.NOTES VALUES (1)");
    debbie.execute("GRANT SELECT ON TABLE APP.T TO BOB");
    debbie.execute("CREATE USER ERIC IDENTIFIED BY 'x'");
    debbie.execute("CREATE TABLESPACE VIA_DBA");
    assert.deepEqual(rows(bob, "SELECT COUNT(*) FROM APP.T"), [["3"]]);
    // 권한이 없는 사용자는 SYSTEM 테이블스페이스의 객체를 볼 수 없다.
    assert.throws(() => alice.execute("SELECT * FROM SYSTEM.NOTES"), denied);
    assert.deepEqual(rows(debbie, "SELECT A FROM SYSTEM.NOTES"), [["1"]]);
  } finally {
    database.close();
  }
});

test("뷰 권한 : 뷰에 UPDATE 권한이 있으면 기반 테이블에 권한이 없어도 그 뷰로 UPDATE 할 수 있다 (개요 5)", (t) => {
  const { fixture, alice, bob } = setupCast(t);
  const { admin } = fixture;
  try {
    alice.execute("CREATE VIEW VIEW_SAMPLE1 AS SELECT ID, V FROM T WHERE ID < 3");
    alice.execute("GRANT UPDATE ON VIEW VIEW_SAMPLE1 TO BOB");
    // BOB 에게는 기반 테이블 T 의 권한이 없다.
    assert.throws(() => bob.execute("SELECT * FROM T"), denied);
    assert.throws(() => bob.execute("UPDATE T SET V = 0"), denied);
    // 뷰의 UPDATE 권한은 뷰 권한대로 동작한다.
    const result = bob.execute("UPDATE VIEW_SAMPLE1 SET V = 99 WHERE ID = 1");
    assert.equal(result.kind === "ok" ? result.rowCount : -1, 1);
    assert.deepEqual(rows(alice, "SELECT ID, V FROM T ORDER BY ID"), [["1", "99"], ["2", "20"], ["3", "30"]]);
    // 받은 권한 이상은 안 된다. 뷰의 SELECT, INSERT, DELETE 는 따로 받아야 한다.
    assert.throws(() => bob.execute("SELECT * FROM VIEW_SAMPLE1"), denied);
    assert.throws(() => bob.execute("DELETE FROM VIEW_SAMPLE1"), denied);
    assert.throws(() => bob.execute("INSERT INTO VIEW_SAMPLE1 VALUES (7, 7)"), denied);
    // 뷰에 SELECT 와 DELETE 를 더 주면 기반 테이블 권한 없이도 된다.
    alice.execute("GRANT SELECT, DELETE ON VIEW VIEW_SAMPLE1 TO BOB");
    assert.deepEqual(rows(bob, "SELECT ID FROM VIEW_SAMPLE1 ORDER BY ID"), [["1"], ["2"]]);
    bob.execute("DELETE FROM VIEW_SAMPLE1 WHERE ID = 2");
    assert.deepEqual(rows(alice, "SELECT ID FROM T ORDER BY ID"), [["1"], ["3"]]);
    // 뷰 권한을 회수하면 다시 거부된다.
    alice.execute("REVOKE ALL ON VIEW VIEW_SAMPLE1 FROM BOB");
    assert.throws(() => bob.execute("UPDATE VIEW_SAMPLE1 SET V = 1"), denied);
    void admin;
  } finally {
    fixture.db.close();
  }
});

test("뷰를 만들려면 테이블스페이스의 CREATE 와 참조하는 모든 객체의 SELECT 가 필요하다", (t) => {
  const { fixture, alice, carol } = setupCast(t);
  const { admin } = fixture;
  try {
    // CREATE 만 있고 SELECT 가 없다.
    admin.execute("GRANT CREATE ON TABLESPACE APP TO CAROL");
    assert.throws(() => carol.execute("CREATE VIEW CV AS SELECT * FROM T"), denied);
    // 서브쿼리와 조인 안의 객체도 본다.
    alice.execute("CREATE TABLE U (ID INTEGER)");
    admin.execute("GRANT SELECT ON TABLE APP.T TO CAROL");
    assert.throws(() => carol.execute("CREATE VIEW CV2 AS SELECT * FROM T WHERE ID IN (SELECT ID FROM U)"), denied);
    carol.execute("CREATE VIEW CV AS SELECT * FROM T");
    // 반대로 SELECT 만 있고 CREATE 가 없으면 만들 수 없다.
    admin.execute("REVOKE CREATE ON TABLESPACE APP FROM CAROL");
    assert.throws(() => carol.execute("CREATE VIEW CV3 AS SELECT * FROM T"), denied);
  } finally {
    fixture.db.close();
  }
});

test("뷰 소유자는 뷰를 만든 것만으로 기반 테이블에 없던 권한을 얻지 못한다", (t) => {
  const { fixture, alice, bob, carol } = setupCast(t);
  const { admin } = fixture;
  try {
    admin.execute("GRANT CREATE ON TABLESPACE APP TO CAROL");
    admin.execute("GRANT SELECT ON TABLE APP.T TO CAROL");
    carol.execute("CREATE VIEW CV AS SELECT * FROM T");
    // 따로 받은 뷰 권한이 없으면 기반 객체에 대한 본인의 권한으로 검사한다.
    assert.deepEqual(rows(carol, "SELECT COUNT(*) FROM CV"), [["3"]]);
    assert.throws(() => carol.execute("UPDATE CV SET V = 0"), denied);
    assert.throws(() => carol.execute("DELETE FROM CV"), denied);
    // 뷰 소유자는 뷰의 ALTER, DROP 을 가진다.
    carol.execute("CREATE OR REPLACE VIEW CV AS SELECT ID FROM T");
    // 기반 테이블의 권한을 잃으면 뷰도 못 쓴다.
    admin.execute("REVOKE SELECT ON TABLE APP.T FROM CAROL");
    assert.throws(() => carol.execute("SELECT * FROM CV"), denied);
    // 뷰가 참조하는 객체의 소유자가 아닌 뷰 소유자는 그 뷰의 권한을 남에게 줄 수 없다.
    admin.execute("GRANT SELECT ON TABLE APP.T TO CAROL");
    assert.throws(() => carol.execute("GRANT SELECT ON VIEW CV TO BOB"), denied);
    // 테이블 소유자도 남이 만든 뷰의 권한은 줄 수 없다. (뷰 소유자가 아니다)
    assert.throws(() => alice.execute("GRANT SELECT ON VIEW APP.CV TO BOB"), denied);
    // 참조하는 모든 객체의 소유자이기도 한 뷰 소유자는 줄 수 있다.
    alice.execute("CREATE VIEW AV AS SELECT * FROM T");
    alice.execute("GRANT SELECT ON VIEW AV TO BOB");
    assert.deepEqual(rows(bob, "SELECT COUNT(*) FROM AV"), [["3"]]);
    // 뷰 위에 만든 뷰는 그 뷰의 SELECT 가 있어야 만들 수 있다.
    admin.execute("GRANT CREATE ON TABLESPACE APP TO CAROL");
    assert.throws(() => carol.execute("CREATE VIEW CV_OVER_AV AS SELECT * FROM APP.AV"), denied);
    // 간접으로 참조하는 객체의 소유자도 따져 본다. BOB 은 AV 를 받은 SELECT 로 읽을 수 있지만
    // AV 위에 만든 자기 뷰를 다른 사람에게 줄 수는 없다. (AV 의 소유자가 아니다)
    admin.execute("GRANT CREATE ON TABLESPACE APP TO BOB");
    bob.execute("CREATE VIEW BV_OVER_AV AS SELECT * FROM APP.AV");
    assert.throws(() => bob.execute("GRANT SELECT ON VIEW BV_OVER_AV TO CAROL"), denied);
  } finally {
    fixture.db.close();
  }
});

test("CREATE OR REPLACE VIEW 는 뷰의 ALTER 가 필요하고 소유자를 바꾸지 않는다", (t) => {
  const { fixture, alice, bob } = setupCast(t);
  const { admin } = fixture;
  try {
    alice.execute("CREATE VIEW V1 AS SELECT ID FROM T");
    admin.execute("GRANT SELECT ON TABLE APP.T TO BOB");
    admin.execute("GRANT CREATE ON TABLESPACE APP TO BOB");
    // CREATE 가 있어도 이미 있는 남의 뷰를 바꾸려면 그 뷰의 ALTER 가 있어야 한다.
    assert.throws(() => bob.execute("CREATE OR REPLACE VIEW V1 AS SELECT ID, V FROM T"), denied);
    admin.execute("GRANT ALTER ON VIEW APP.V1 TO BOB");
    bob.execute("CREATE OR REPLACE VIEW V1 AS SELECT ID, V FROM T");
    assert.deepEqual(rows(admin, "SELECT OWNER FROM SYS_VIEWS WHERE VIEW_NAME = 'V1'"), [["ALICE"]]);
    // 그 뷰의 DROP 은 따로 받아야 한다.
    assert.throws(() => bob.execute("DROP VIEW V1"), denied);
    admin.execute("GRANT DROP ON VIEW APP.V1 TO BOB");
    bob.execute("DROP VIEW V1");
  } finally {
    fixture.db.close();
  }
});

test("FK 를 만들려면 참조되는 테이블에 SELECT 가 있어야 한다", (t) => {
  const { fixture, bob } = setupCast(t);
  const { admin } = fixture;
  try {
    admin.execute("GRANT CREATE ON TABLESPACE APP TO BOB");
    assert.throws(() => bob.execute("CREATE TABLE C1 (ID INTEGER, P INTEGER REFERENCES T)"), denied);
    assert.throws(
      () => bob.execute("CREATE TABLE C1 (ID INTEGER, P INTEGER, FOREIGN KEY (P) REFERENCES T)"),
      denied,
    );
    admin.execute("GRANT SELECT ON TABLE APP.T TO BOB");
    bob.execute("CREATE TABLE C1 (ID INTEGER, P INTEGER REFERENCES T)");
    // ALTER TABLE 로 FK 를 더할 때도 같다.
    bob.execute("CREATE TABLE C2 (ID INTEGER, P INTEGER)");
    admin.execute("REVOKE SELECT ON TABLE APP.T FROM BOB");
    assert.throws(() => bob.execute("ALTER TABLE C2 ADD FOREIGN KEY (P) REFERENCES T"), denied);
    // 자기 자신을 참조하는 테이블은 만들 수 있다.
    bob.execute("CREATE TABLE TREE (ID INTEGER PRIMARY KEY, PARENT INTEGER REFERENCES TREE)");
  } finally {
    fixture.db.close();
  }
});

test("서브쿼리와 INSERT ... SELECT 가 읽는 다른 객체에는 SELECT 가 필요하다", (t) => {
  const { fixture, alice, bob } = setupCast(t);
  const { admin } = fixture;
  try {
    alice.execute("CREATE TABLE DEST (ID INTEGER, V INTEGER)");
    admin.execute("GRANT INSERT, UPDATE, DELETE ON TABLE APP.DEST TO BOB");
    assert.throws(() => bob.execute("INSERT INTO DEST SELECT * FROM T"), denied);
    assert.throws(() => bob.execute("INSERT INTO DEST VALUES ((SELECT MAX(V) FROM T), 1)"), denied);
    assert.throws(() => bob.execute("DELETE FROM DEST WHERE ID IN (SELECT ID FROM T)"), denied);
    assert.throws(() => bob.execute("UPDATE DEST SET V = (SELECT MAX(V) FROM T)"), denied);
    // 대상의 컬럼을 WHERE, SET 에서 읽는 데에는 SELECT 가 필요하지 않다.
    bob.execute("INSERT INTO DEST VALUES (1, 1)");
    bob.execute("UPDATE DEST SET V = V + 1 WHERE ID = 1");
    bob.execute("DELETE FROM DEST WHERE ID = 1");
    admin.execute("GRANT SELECT ON TABLE APP.T TO BOB");
    bob.execute("INSERT INTO DEST SELECT * FROM T");
    assert.deepEqual(rows(alice, "SELECT COUNT(*) FROM DEST"), [["3"]]);
    // 인라인 뷰와 조인 안의 객체도 본다.
    assert.throws(() => bob.execute("SELECT * FROM T JOIN DEST ON T.ID = DEST.ID"), denied);
    assert.throws(() => bob.execute("SELECT * FROM (SELECT * FROM DEST) X"), denied);
    assert.throws(() => bob.execute("SELECT ID FROM T UNION SELECT ID FROM DEST"), denied);
  } finally {
    fixture.db.close();
  }
});

test("SELECT ... FOR UPDATE 는 행을 잠그므로 UPDATE 권한도 필요하다", (t) => {
  const { fixture, bob } = setupCast(t);
  const { admin } = fixture;
  try {
    admin.execute("GRANT SELECT ON TABLE APP.T TO BOB");
    assert.deepEqual(rows(bob, "SELECT V FROM T WHERE ID = 1"), [["10"]]);
    assert.throws(() => bob.execute("SELECT V FROM T WHERE ID = 1 FOR UPDATE"), denied);
    admin.execute("GRANT UPDATE ON TABLE APP.T TO BOB");
    assert.deepEqual(rows(bob, "SELECT V FROM T WHERE ID = 1 FOR UPDATE"), [["10"]]);
  } finally {
    fixture.db.close();
  }
});

test("권한 변경은 접속 중인 세션에 다음 문장부터 바로 적용된다", async (t) => {
  const { fixture, bob } = setupCast(t);
  const { admin } = fixture;
  try {
    assert.throws(() => bob.execute("SELECT * FROM T"), denied);
    admin.execute("GRANT SELECT ON TABLE APP.T TO BOB");
    assert.deepEqual(rows(bob, "SELECT COUNT(*) FROM T"), [["3"]]);
    admin.execute("REVOKE SELECT ON TABLE APP.T FROM BOB");
    assert.throws(() => bob.execute("SELECT * FROM T"), denied);
    // 비동기 실행도 같다.
    admin.execute("GRANT SELECT ON TABLE APP.T TO BOB");
    await bob.executeAsync("SELECT COUNT(*) FROM T");
    admin.execute("REVOKE SELECT ON TABLE APP.T FROM BOB");
    await assert.rejects(bob.executeAsync("SELECT COUNT(*) FROM T"), denied);
  } finally {
    fixture.db.close();
  }
});

test("권한이 거부된 DDL 은 진행 중인 트랜잭션을 커밋하지 않는다", (t) => {
  const { fixture, bob } = setupCast(t);
  const { admin } = fixture;
  try {
    admin.execute("GRANT SELECT, INSERT ON TABLE APP.T TO BOB");
    bob.execute("BEGIN");
    bob.execute("INSERT INTO T VALUES (50, 50)");
    assert.throws(() => bob.execute("CREATE TABLE NOPE (A INTEGER)"), denied);
    assert.throws(() => bob.execute("DROP TABLE T"), denied);
    assert.equal(bob.inTransaction, true);
    assert.deepEqual(rows(admin, "SELECT COUNT(*) FROM APP.T"), [["3"]]);
    bob.execute("ROLLBACK");
    assert.deepEqual(rows(bob, "SELECT COUNT(*) FROM T"), [["3"]]);
    // 거부된 문장은 트랜잭션을 망가뜨리지 않는다. 같은 트랜잭션에서 허용된 문장은 계속된다.
    bob.execute("BEGIN");
    assert.throws(() => bob.execute("UPDATE T SET V = 0"), denied);
    bob.execute("INSERT INTO T VALUES (51, 51)");
    bob.execute("COMMIT");
    assert.deepEqual(rows(admin, "SELECT COUNT(*) FROM APP.T"), [["4"]]);
  } finally {
    fixture.db.close();
  }
});

test("객체를 지우면 권한 기록도 지워지고, 같은 이름으로 다시 만들어도 이어받지 않는다", (t) => {
  const { fixture, alice, bob } = setupCast(t);
  const { admin } = fixture;
  try {
    admin.execute("GRANT SELECT, UPDATE ON TABLE APP.T TO BOB");
    alice.execute("CREATE VIEW V1 AS SELECT * FROM T");
    alice.execute("GRANT SELECT ON VIEW V1 TO BOB");
    alice.execute("DROP VIEW V1");
    alice.execute("DROP TABLE T");
    assert.deepEqual(rows(admin, "SELECT COUNT(*) FROM SYS_PRIVILEGES WHERE GRANTEE = 'BOB'"), [["0"]]);
    alice.execute("CREATE TABLE T (ID INTEGER, V INTEGER)");
    assert.throws(() => bob.execute("SELECT * FROM T"), denied);
    // CASCADE 로 함께 지워진 뷰의 기록도 지워진다.
    alice.execute("CREATE VIEW V2 AS SELECT * FROM T");
    alice.execute("GRANT SELECT ON VIEW V2 TO BOB");
    alice.execute("DROP TABLE T CASCADE");
    assert.deepEqual(rows(admin, "SELECT COUNT(*) FROM SYS_PRIVILEGES WHERE GRANTEE = 'BOB'"), [["0"]]);
  } finally {
    fixture.db.close();
  }
});

test("테이블 이름을 바꾸면 권한이 새 이름을 따라간다", (t) => {
  const { fixture, alice, bob } = setupCast(t);
  const { admin } = fixture;
  try {
    admin.execute("GRANT SELECT ON TABLE APP.T TO BOB");
    alice.execute("ALTER TABLE T RENAME TO T2");
    assert.deepEqual(rows(bob, "SELECT COUNT(*) FROM T2"), [["3"]]);
    assert.deepEqual(rows(admin, "SELECT OBJECT_NAME FROM SYS_PRIVILEGES WHERE GRANTEE = 'BOB'"), [["T2"]]);
  } finally {
    fixture.db.close();
  }
});

test("딕셔너리 뷰는 자신이 권한을 가진 객체의 행만 보여 주고 DBA 는 전부 본다", (t) => {
  const { fixture, alice, bob, carol } = setupCast(t);
  const { admin } = fixture;
  try {
    alice.execute("CREATE TABLE U (A INTEGER, B INTEGER)");
    alice.execute("CREATE INDEX IX_U_A ON U (A)");
    alice.execute("CREATE VIEW VU AS SELECT A FROM U");
    admin.execute("GRANT SELECT ON TABLE APP.T TO BOB");
    admin.execute("GRANT UPDATE ON VIEW APP.VU TO CAROL");
    // BOB 는 T 만, CAROL 은 뷰 VU 만 본다. 권한이 전혀 없으면 아무것도 안 보인다.
    assert.deepEqual(rows(bob, "SELECT TABLE_NAME FROM SYS_TABLES"), [["T"]]);
    assert.deepEqual(rows(bob, "SELECT DISTINCT TABLE_NAME FROM SYS_COLUMNS"), [["T"]]);
    assert.deepEqual(rows(bob, "SELECT CONSTRAINT_NAME FROM SYS_CONSTRAINTS"), [["PK_T"]]);
    assert.deepEqual(rows(bob, "SELECT VIEW_NAME FROM SYS_VIEWS"), []);
    assert.deepEqual(rows(carol, "SELECT TABLE_NAME FROM SYS_TABLES"), []);
    assert.deepEqual(rows(carol, "SELECT VIEW_NAME FROM SYS_VIEWS"), [["VU"]]);
    // 인덱스는 테이블을 볼 수 있을 때만 보인다.
    assert.deepEqual(rows(bob, "SELECT INDEX_NAME FROM SYS_INDEXES"), [["PK_T"]]);
    assert.deepEqual(rows(alice, "SELECT INDEX_NAME FROM SYS_INDEXES ORDER BY INDEX_NAME"), [["IX_U_A"], ["PK_T"]]);
    assert.deepEqual(rows(alice, "SELECT COUNT(*) FROM SYS_INDEX_COLUMNS"), [["2"]]);
    // 소유자는 자기 객체를 모두 본다. DBA 는 전부 본다.
    assert.deepEqual(rows(alice, "SELECT TABLE_NAME FROM SYS_TABLES ORDER BY TABLE_NAME"), [["T"], ["U"]]);
    assert.deepEqual(rows(admin, "SELECT TABLE_NAME FROM SYS_TABLES ORDER BY TABLE_NAME"), [["T"], ["U"]]);
    assert.deepEqual(rows(admin, "SELECT VIEW_NAME FROM SYS_VIEWS"), [["VU"]]);
    // 테이블스페이스 목록도 권한이 있는 테이블스페이스만 보인다.
    assert.deepEqual(rows(bob, "SELECT TABLESPACE_NAME FROM SYS_TABLESPACES"), [["APP"]]);
    makeUser(admin, "NOBODY2");
    const nobody = fixture.db.login("NOBODY2", "nobody2-pw");
    assert.deepEqual(rows(nobody, "SELECT TABLESPACE_NAME FROM SYS_TABLESPACES"), []);
    assert.deepEqual(rows(admin, "SELECT TABLESPACE_NAME FROM SYS_TABLESPACES ORDER BY TABLESPACE_NAME"), [["APP"], ["SYSTEM"]]);
    // 그래도 딕셔너리 뷰와 DUAL 은 권한 없이 모두 조회할 수 있다.
    assert.deepEqual(rows(nobody, "SELECT * FROM SYSTEM.DUAL"), [["X"]]);
    assert.deepEqual(rows(nobody, "SELECT COUNT(*) FROM SYSTEM.SYS_TABLES"), [["0"]]);
  } finally {
    fixture.db.close();
  }
});

test("SYS_PRIVILEGES 는 받은 사람, 객체 소유자, DBA 에게 보인다", (t) => {
  const { fixture, alice, bob, carol } = setupCast(t);
  const { admin } = fixture;
  try {
    admin.execute("GRANT SELECT ON TABLE APP.T TO BOB");
    alice.execute("GRANT UPDATE ON TABLE T TO CAROL");
    admin.execute("GRANT SELECT ON TABLESPACE APP TO CAROL");
    // 테이블스페이스 수준 기록은 OBJECT_NAME 이 NULL 이다.
    assert.deepEqual(rows(carol, "SELECT TABLESPACE_NAME, OBJECT_NAME, PRIVILEGE FROM SYS_PRIVILEGES ORDER BY PRIVILEGE"), [
      ["APP", "NULL", "SELECT"],
      ["APP", "T", "UPDATE"],
    ]);
    assert.deepEqual(rows(bob, "SELECT GRANTEE, PRIVILEGE FROM SYS_PRIVILEGES"), [["BOB", "SELECT"]]);
    // 소유자는 자기 테이블에 부여된 기록을 모두 본다.
    assert.deepEqual(
      rows(alice, "SELECT GRANTEE, PRIVILEGE FROM SYS_PRIVILEGES ORDER BY GRANTEE, PRIVILEGE"),
      [["ALICE", "CREATE"], ["BOB", "SELECT"], ["CAROL", "UPDATE"]],
    );
    assert.deepEqual(rows(admin, "SELECT COUNT(*) FROM SYS_PRIVILEGES"), [["4"]]);
  } finally {
    fixture.db.close();
  }
});

test("권한 그룹과 개별 권한의 효과를 합쳐서 판정한다", (t) => {
  const { fixture, bob } = setupCast(t);
  const { admin, db: database } = fixture;
  try {
    // 권한이 없던 BOB 에게 OFFICER 를 주면 풀리고, 회수하면 개별 권한만 남는다.
    admin.execute("GRANT SELECT ON TABLE APP.T TO BOB");
    admin.execute("GRANT OFFICER TO BOB");
    bob.execute("UPDATE T SET V = 1");
    admin.execute("REVOKE OFFICER FROM BOB");
    assert.throws(() => bob.execute("UPDATE T SET V = 2"), denied);
    assert.deepEqual(rows(bob, "SELECT COUNT(*) FROM T"), [["3"]]);
    // 판정 함수의 직접 확인
    assert.equal(database.access.can("BOB", "SELECT", "APP", "T"), true);
    assert.equal(database.access.can("BOB", "UPDATE", "APP", "T"), false);
    assert.equal(database.access.can("ALICE", "DROP", "APP", "T"), true); // 소유자
    assert.equal(database.access.can("SYSTEM", "DROP", "APP", "T"), true); // DBA
    assert.equal(database.access.can("BOB", "SELECT", "SYSTEM", "DUAL"), true); // 가상 객체
  } finally {
    fixture.db.close();
  }
});

test("없는 객체와 IF EXISTS 는 권한 때문이 아니라 실행 단계의 오류와 동작을 따른다", (t) => {
  const { fixture, bob } = setupCast(t);
  try {
    assert.throws(() => bob.execute("SELECT * FROM NOPE"), state("42P01"));
    assert.throws(() => bob.execute("DROP TABLE NOPE"), state("42P01"));
    bob.execute("DROP TABLE IF EXISTS NOPE");
    assert.throws(() => bob.execute("SELECT * FROM NOSUCH.T"), state("3D000"));
  } finally {
    fixture.db.close();
  }
});
