/**
 * DEFAULT 식과 컬럼 REFERENCES 의 권한 시험 (2026-10-22 점검 R-2, R-4).
 * DEFAULT 는 상수 식만 받고, ADD COLUMN 의 REFERENCES 도 참조 테이블의 SELECT 권한을 요구하는지 본다.
 * 관련 사양 : AGENTS.md 상세 1-3, 5, 11
 * 구현 단계 : 8단계(점검 보완)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Database } from "../../src/session/session.js";
import { denied, makeUser, rows, setupAuth, state } from "./helpers.js";

test("DEFAULT 의 서브쿼리는 누구의 권한이든 정의할 때 거부하여 비밀 값을 읽지 못한다 (R-2)", (t) => {
  const fixture = setupAuth(t);
  const { admin } = fixture;
  let db = fixture.db;
  try {
    makeUser(admin, "ALICE", "APP");
    makeUser(admin, "BOB", "APP");
    admin.execute("GRANT CREATE ON TABLESPACE APP TO ALICE, BOB");
    const alice = db.createSession({ user: "ALICE", tablespace: "APP" });
    const bob = db.createSession({ user: "BOB", tablespace: "APP" });
    alice.execute("CREATE TABLE SECRET (S VARCHAR(50))");
    alice.execute("INSERT INTO SECRET VALUES ('top-secret-value')");

    // BOB 은 SECRET 에 SELECT 권한이 없다. 어떤 DEFAULT 경로로도 값을 읽지 못해야 한다.
    assert.throws(() => bob.execute("CREATE TABLE ATTACK (ID INTEGER, V VARCHAR(200) DEFAULT (SELECT S FROM SECRET))"), state("0A000"));
    bob.execute("CREATE TABLE ATTACK (ID INTEGER, V VARCHAR(200))");
    assert.throws(() => bob.execute("ALTER TABLE ATTACK ADD COLUMN W VARCHAR(200) DEFAULT (SELECT S FROM SECRET)"), state("0A000"));
    assert.throws(() => bob.execute("ALTER TABLE ATTACK ALTER COLUMN V SET DEFAULT (SELECT S FROM SECRET)"), state("0A000"));
    bob.execute("INSERT INTO ATTACK (ID) VALUES (1)");
    assert.deepEqual(rows(bob, "SELECT V FROM ATTACK"), [["NULL"]]);
    assert.throws(() => bob.execute("SELECT S FROM SECRET"), denied);

    // 열 참조도 DEFAULT 에 쓸 수 없다.
    assert.throws(() => bob.execute("CREATE TABLE BADREF (A INTEGER, B INTEGER DEFAULT A)"), state("42703"));
  }
  finally {
    db.close();
  }
  // 상수 DEFAULT 는 그대로 동작하고, 재구동 뒤에도 저장된 값으로 동작한다.
  db = Database.open(fixture.dir, { onWarning: () => {}, scramIterations: 1000 });
  try {
    const bob = db.createSession({ user: "BOB", tablespace: "APP" });
    bob.execute("CREATE TABLE OKDEF (ID INTEGER, S VARCHAR(20) DEFAULT 'abc', N INTEGER DEFAULT 1 + 2)");
    bob.execute("INSERT INTO OKDEF (ID) VALUES (1)");
    assert.deepEqual(rows(bob, "SELECT S, N FROM OKDEF"), [["abc", "3"]]);
    bob.execute("ALTER TABLE OKDEF ALTER COLUMN S SET DEFAULT 'xyz'");
    bob.execute("INSERT INTO OKDEF (ID) VALUES (2)");
    bob.execute("INSERT INTO OKDEF VALUES (3, DEFAULT, DEFAULT)");
    assert.deepEqual(rows(bob, "SELECT ID, S, N FROM OKDEF ORDER BY ID"), [
      ["1", "abc", "3"],
      ["2", "xyz", "3"],
      ["3", "xyz", "3"],
    ]);
  }
  finally {
    db.close();
  }
});

test("ADD COLUMN 의 REFERENCES 도 참조 테이블의 SELECT 권한을 요구한다 (R-4)", (t) => {
  const { db, admin } = setupAuth(t);
  try {
    makeUser(admin, "ALICE", "APP");
    makeUser(admin, "BOB", "APP");
    admin.execute("GRANT CREATE ON TABLESPACE APP TO ALICE, BOB");
    const alice = db.createSession({ user: "ALICE", tablespace: "APP" });
    const bob = db.createSession({ user: "BOB", tablespace: "APP" });
    alice.execute("CREATE TABLE PARENT (ID INTEGER PRIMARY KEY)");
    alice.execute("INSERT INTO PARENT VALUES (1)");
    bob.execute("CREATE TABLE CHILD (ID INTEGER PRIMARY KEY)");

    // SELECT 가 없으면 ADD COLUMN ... REFERENCES 도 거부한다. ADD CONSTRAINT 와 같은 규칙이다.
    assert.throws(() => bob.execute("ALTER TABLE CHILD ADD COLUMN P INTEGER REFERENCES PARENT (ID)"), denied);
    assert.throws(() => bob.execute("ALTER TABLE CHILD ADD CONSTRAINT FK_P FOREIGN KEY (ID) REFERENCES PARENT (ID)"), denied);
    // 자기 테이블 참조는 권한 없이도 된다.
    bob.execute("ALTER TABLE CHILD ADD COLUMN SELF_REF INTEGER REFERENCES CHILD (ID)");

    // SELECT 를 받으면 허용하고, FK 검사가 실제로 동작한다.
    alice.execute("GRANT SELECT ON TABLE PARENT TO BOB");
    bob.execute("ALTER TABLE CHILD ADD COLUMN P INTEGER REFERENCES PARENT (ID)");
    bob.execute("INSERT INTO CHILD (ID, P) VALUES (10, 1)");
    assert.throws(() => bob.execute("INSERT INTO CHILD (ID, P) VALUES (11, 2)"), state("23503"));
  }
  finally {
    db.close();
  }
});
