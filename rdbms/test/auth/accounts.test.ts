/**
 * 사용자 계정 테스트 (8단계).
 * SYSTEM 계정, CREATE/ALTER/DROP USER, 인증, CONNECT 와 로컬 접속, 기본 테이블스페이스, 영속성,
 * 비밀번호 비저장, 딕셔너리 뷰의 가시성을 본다.
 * 관련 사양 : AGENTS.md 상세 4, 6
 * 구현 단계 : 8단계
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Database } from "../../src/session/session.js";
import { DbError } from "../../src/common/errors.js";
import { INITIAL_SYSTEM_PASSWORD } from "../../src/auth/users.js";
import { denied, makeUser, rows, selectStrings, setupAuth, state, tempDir } from "./helpers.js";

test("처음 열면 SYSTEM 계정이 암호 HelloWorldDB, DBA, 기본 테이블스페이스 SYSTEM 으로 만들어진다", (t) => {
  const dir = tempDir(t);
  const db = Database.open(dir, { onWarning: () => {}, scramIterations: 1000 });
  try {
    assert.equal(db.users.has("SYSTEM"), true);
    assert.equal(db.users.get("SYSTEM")?.defaultTablespace, "SYSTEM");
    assert.deepEqual(db.access.groupsOf("SYSTEM"), ["DBA"]);
    // CONNECT 는 DBA 에 포함되지 않는다.
    assert.equal(db.access.hasGroup("SYSTEM", "CONNECT"), false);
    assert.equal(db.access.hasGroup("SYSTEM", "OFFICER"), true);
    assert.equal(db.isInitialSystemPassword(), true);
    const session = db.login("SYSTEM", INITIAL_SYSTEM_PASSWORD);
    assert.equal(session.user, "SYSTEM");
    assert.equal(session.currentTablespace, "SYSTEM");
  } finally {
    db.close();
  }
});

test("인증 실패는 없는 사용자와 틀린 비밀번호를 구분하지 않는다", (t) => {
  const { db } = setupAuth(t);
  try {
    const capture = (user: string, password: string): DbError => {
      try {
        db.login(user, password);
      } catch (error) {
        assert.ok(error instanceof DbError);
        return error;
      }
      throw new Error("login succeeded");
    };
    const wrongPassword = capture("SYSTEM", "wrong");
    const unknownUser = capture("NOBODY", "HelloWorldDB");
    assert.equal(wrongPassword.sqlState, "28000");
    assert.equal(unknownUser.sqlState, "28000");
    assert.equal(wrongPassword.code, unknownUser.code);
    assert.equal(wrongPassword.message, unknownUser.message);
    // 비밀번호는 대소문자를 구분한다.
    assert.throws(() => db.login("SYSTEM", "helloworlddb"), state("28000"));
  } finally {
    db.close();
  }
});

test("비밀번호는 평문으로 저장되지 않는다", (t) => {
  const dir = tempDir(t);
  const db = Database.open(dir, { onWarning: () => {}, scramIterations: 1000 });
  try {
    const admin = db.createSession({});
    admin.execute("CREATE USER SCOTT IDENTIFIED BY 'Tiger-9f3a-unique-marker'");
  } finally {
    db.close();
  }
  const bytes = fs.readFileSync(path.join(dir, "SYSTEM.hwdb")).toString("latin1");
  assert.ok(!bytes.includes("Tiger-9f3a-unique-marker"));
  assert.ok(!bytes.includes(INITIAL_SYSTEM_PASSWORD));
  assert.ok(bytes.includes("SCOTT"));
});

test("CREATE USER : 이름 규칙, 중복, 기본 테이블스페이스", (t) => {
  const { db, admin } = setupAuth(t);
  try {
    admin.execute("CREATE USER ALICE IDENTIFIED BY 'a-pw' DEFAULT TABLESPACE APP");
    assert.equal(db.users.get("ALICE")?.defaultTablespace, "APP");
    admin.execute('CREATE USER "Mixed" IDENTIFIED BY \'pw\'');
    assert.equal(db.users.has("Mixed"), true);
    assert.equal(db.users.has("MIXED"), false);
    assert.throws(() => admin.execute("CREATE USER ALICE IDENTIFIED BY 'x'"), state("42710"));
    // 권한 그룹 이름은 사용자명으로 쓸 수 없다.
    for (const name of ["CONNECT", "OFFICER", "DBA"]) {
      assert.throws(() => admin.execute(`CREATE USER ${name} IDENTIFIED BY 'x'`), state("42602"));
    }
    assert.throws(() => admin.execute("CREATE USER BOB IDENTIFIED BY 'x' DEFAULT TABLESPACE NOPE"), state("3D000"));
    assert.equal(db.users.has("BOB"), false);
    assert.throws(() => admin.execute("CREATE USER BOB IDENTIFIED BY ''"), state("22023"));
  } finally {
    db.close();
  }
});

test("새 사용자는 아무 권한도 없고 로컬에서 로그인만 할 수 있다", (t) => {
  const { db, admin } = setupAuth(t);
  try {
    admin.execute("CREATE TABLE APP.T (A INTEGER)");
    makeUser(admin, "ALICE", "APP");
    assert.deepEqual(db.access.groupsOf("ALICE"), []);
    const session = db.login("ALICE", "alice-pw");
    // 기본 테이블스페이스로 지정했다고 해서 권한이 생기지는 않는다.
    assert.equal(session.currentTablespace, "APP");
    assert.throws(() => session.execute("SELECT * FROM T"), denied);
    assert.throws(() => session.execute("CREATE TABLE X (A INTEGER)"), denied);
    // 권한이 필요 없는 문장은 된다.
    assert.deepEqual(rows(session, "SELECT 'Hello World'"), [["Hello World"]]);
    assert.deepEqual(rows(session, "SELECT * FROM SYSTEM.DUAL"), [["X"]]);
    session.execute("USE SYSTEM");
  } finally {
    db.close();
  }
});

test("기본 테이블스페이스가 없으면 현재 테이블스페이스가 없고, 테이블스페이스명을 붙이거나 USE 를 해야 한다", (t) => {
  const { db, admin } = setupAuth(t);
  try {
    admin.execute("CREATE TABLE APP.T (A INTEGER)");
    admin.execute("INSERT INTO APP.T VALUES (1)");
    makeUser(admin, "ALICE");
    admin.execute("GRANT ALL ON TABLESPACE APP TO ALICE");
    const session = db.login("ALICE", "alice-pw");
    assert.equal(session.currentTablespace, "");
    assert.throws(() => session.execute("SELECT * FROM T"), state("3F000"));
    assert.throws(() => session.execute("INSERT INTO T VALUES (2)"), state("3F000"));
    assert.throws(() => session.execute("CREATE TABLE X (A INTEGER)"), state("3F000"));
    assert.throws(() => session.execute("DROP TABLE T"), state("3F000"));
    // 테이블스페이스명을 붙이면 된다. 딕셔너리 뷰와 DUAL 은 붙이지 않아도 된다.
    assert.deepEqual(rows(session, "SELECT A FROM APP.T"), [["1"]]);
    assert.deepEqual(rows(session, "SELECT COUNT(*) FROM SYS_SESSIONS"), [["1"]]);
    assert.deepEqual(rows(session, "SELECT * FROM DUAL"), [["X"]]);
    // 세션 목록에서 현재 테이블스페이스는 NULL 이다.
    assert.deepEqual(rows(session, "SELECT TABLESPACE_NAME FROM SYS_SESSIONS"), [["NULL"]]);
    session.execute("USE APP");
    assert.deepEqual(rows(session, "SELECT A FROM T"), [["1"]]);
  } finally {
    db.close();
  }
});

test("ALTER USER : 자기 비밀번호는 누구나, 그 밖의 변경은 DBA 만 한다", (t) => {
  const { db, admin } = setupAuth(t);
  try {
    makeUser(admin, "ALICE", "APP");
    makeUser(admin, "BOB");
    const alice = db.login("ALICE", "alice-pw");
    alice.execute("ALTER USER ALICE IDENTIFIED BY 'new-pw'");
    assert.throws(() => db.login("ALICE", "alice-pw"), state("28000"));
    assert.equal(db.login("ALICE", "new-pw").user, "ALICE");
    // 남의 비밀번호와 자기 기본 테이블스페이스는 DBA 만 바꾼다.
    assert.throws(() => alice.execute("ALTER USER BOB IDENTIFIED BY 'x'"), denied);
    assert.throws(() => alice.execute("ALTER USER ALICE DEFAULT TABLESPACE SYSTEM"), denied);
    // DBA 는 모두 바꿀 수 있다.
    admin.execute("ALTER USER BOB IDENTIFIED BY 'bob-new'");
    admin.execute("ALTER USER BOB DEFAULT TABLESPACE APP");
    assert.equal(db.users.get("BOB")?.defaultTablespace, "APP");
    assert.equal(db.login("BOB", "bob-new").currentTablespace, "APP");
    assert.throws(() => admin.execute("ALTER USER NOBODY IDENTIFIED BY 'x'"), state("42704"));
    assert.throws(() => admin.execute("ALTER USER BOB DEFAULT TABLESPACE NOPE"), state("3D000"));
    // SYSTEM 의 초기 암호를 바꾸면 초기 암호 경고가 사라진다.
    assert.equal(db.isInitialSystemPassword(), true);
    admin.execute("ALTER USER SYSTEM IDENTIFIED BY 'changed'");
    assert.equal(db.isInitialSystemPassword(), false);
  } finally {
    db.close();
  }
});

test("사용자 생성, 삭제와 권한 그룹 부여는 DBA 만 한다", (t) => {
  const { db, admin } = setupAuth(t);
  try {
    makeUser(admin, "ALICE", "APP");
    makeUser(admin, "BOB");
    admin.execute("GRANT OFFICER TO ALICE");
    const alice = db.login("ALICE", "alice-pw");
    assert.throws(() => alice.execute("CREATE USER CAROL IDENTIFIED BY 'x'"), denied);
    assert.throws(() => alice.execute("DROP USER BOB"), denied);
    assert.throws(() => alice.execute("GRANT CONNECT TO ALICE"), denied);
    assert.throws(() => alice.execute("REVOKE OFFICER FROM ALICE"), denied);
    assert.throws(() => alice.execute("CREATE TABLESPACE X"), denied);
    assert.throws(() => alice.execute("DROP TABLESPACE APP INCLUDING CONTENTS"), denied);
  } finally {
    db.close();
  }
});

test("SYSTEM 계정은 삭제할 수 없고 DBA 를 회수할 수 없다", (t) => {
  const { db, admin } = setupAuth(t);
  try {
    makeUser(admin, "ALICE");
    admin.execute("GRANT DBA TO ALICE");
    const alice = db.login("ALICE", "alice-pw");
    assert.throws(() => alice.execute("DROP USER SYSTEM"), state("42501"));
    assert.throws(() => alice.execute("DROP USER SYSTEM CASCADE"), state("42501"));
    assert.throws(() => alice.execute("REVOKE DBA FROM SYSTEM"), state("42501"));
    assert.deepEqual(db.access.groupsOf("SYSTEM"), ["DBA"]);
    // 다른 DBA 의 DBA 는 회수할 수 있다.
    admin.execute("REVOKE DBA FROM ALICE");
    assert.equal(db.access.isDba("ALICE"), false);
    // 회수된 뒤 첫 문장부터 DBA 의 일을 할 수 없다.
    assert.throws(() => alice.execute("CREATE USER CAROL IDENTIFIED BY 'x'"), denied);
  } finally {
    db.close();
  }
});

test("DROP USER : 접속 중이면 실패하고, 소유 객체가 있으면 CASCADE 가 필요하다", (t) => {
  const { db, admin } = setupAuth(t);
  try {
    makeUser(admin, "ALICE", "APP");
    makeUser(admin, "BOB", "APP");
    admin.execute("GRANT ALL ON TABLESPACE APP TO ALICE");
    admin.execute("GRANT SELECT ON TABLESPACE APP TO BOB");
    const alice = db.login("ALICE", "alice-pw");
    alice.execute("CREATE TABLE PARENT (ID INTEGER PRIMARY KEY)");
    alice.execute("CREATE TABLE CHILD (ID INTEGER, P INTEGER REFERENCES PARENT)");
    alice.execute("CREATE VIEW V AS SELECT * FROM PARENT");
    // 접속 중인 사용자는 지울 수 없다.
    assert.throws(() => admin.execute("DROP USER ALICE"), state("55006"));
    alice.close();
    // 소유 객체가 있으면 실패한다.
    assert.throws(() => admin.execute("DROP USER ALICE"), state("55006"));
    assert.equal(db.users.has("ALICE"), true);
    // 다른 사용자의 뷰가 의존하는 테이블도 CASCADE 로 함께 지워진다.
    admin.execute("CREATE VIEW APP.BOBS AS SELECT * FROM APP.PARENT");
    admin.execute("DROP USER ALICE CASCADE");
    assert.equal(db.users.has("ALICE"), false);
    assert.deepEqual(rows(admin, "SELECT TABLE_NAME FROM SYS_TABLES WHERE TABLESPACE_NAME = 'APP'"), []);
    assert.deepEqual(rows(admin, "SELECT VIEW_NAME FROM SYS_VIEWS WHERE TABLESPACE_NAME = 'APP'"), []);
    // 받은 권한 기록도 사라지고, 같은 이름으로 다시 만들어도 이어받지 않는다.
    assert.equal(db.access.records().some((record) => record.grantee === "ALICE"), false);
    assert.throws(() => admin.execute("DROP USER ALICE"), state("42704"));
    makeUser(admin, "ALICE", "APP");
    const again = db.login("ALICE", "alice-pw");
    assert.throws(() => again.execute("CREATE TABLE X (A INTEGER)"), denied);
  } finally {
    db.close();
  }
});

test("CONNECT 가 없으면 원격 접속을 거부하고 로컬 접속은 항상 받는다", (t) => {
  const { db, admin } = setupAuth(t);
  try {
    makeUser(admin, "ALICE");
    // 로컬은 CONNECT 없이도 된다. SYSTEM 도 마찬가지이다.
    assert.equal(db.login("ALICE", "alice-pw", { local: true }).user, "ALICE");
    assert.equal(db.login("SYSTEM", INITIAL_SYSTEM_PASSWORD, { local: true }).user, "SYSTEM");
    // 원격은 CONNECT 가 있어야 한다. DBA 도 CONNECT 를 포함하지 않는다.
    assert.throws(() => db.login("ALICE", "alice-pw", { local: false }), state("28000"));
    assert.throws(() => db.login("SYSTEM", INITIAL_SYSTEM_PASSWORD, { local: false }), state("28000"));
    // 비밀번호가 틀리면 CONNECT 와 상관없이 인증 실패이다.
    try {
      db.login("ALICE", "nope", { local: false });
      assert.fail("expected failure");
    } catch (error) {
      assert.ok(error instanceof DbError);
      assert.equal(error.message, "Authentication failed.");
    }
    admin.execute("GRANT CONNECT TO ALICE, SYSTEM");
    const remote = db.login("ALICE", "alice-pw", { local: false });
    assert.equal(db.login("SYSTEM", INITIAL_SYSTEM_PASSWORD, { local: false }).user, "SYSTEM");
    // 회수하더라도 이미 맺어진 세션은 끊지 않는다.
    admin.execute("REVOKE CONNECT FROM ALICE");
    assert.equal(remote.isClosed, false);
    assert.deepEqual(rows(remote, "SELECT 1"), [["1"]]);
    assert.throws(() => db.login("ALICE", "alice-pw", { local: false }), state("28000"));
    assert.equal(db.login("ALICE", "alice-pw").user, "ALICE");
  } finally {
    db.close();
  }
});

test("권한 그룹은 조합해서 부여하고, 가진 적 없는 그룹의 회수는 오류 없이 넘어간다", (t) => {
  const { db, admin } = setupAuth(t);
  try {
    makeUser(admin, "ALICE");
    admin.execute("GRANT CONNECT, OFFICER TO ALICE");
    assert.deepEqual(db.access.groupsOf("ALICE"), ["CONNECT", "OFFICER"]);
    admin.execute("GRANT OFFICER TO ALICE"); // 이미 가진 그룹
    assert.deepEqual(db.access.groupsOf("ALICE"), ["CONNECT", "OFFICER"]);
    admin.execute("REVOKE DBA FROM ALICE"); // 가진 적 없음
    admin.execute("REVOKE OFFICER FROM ALICE");
    assert.deepEqual(db.access.groupsOf("ALICE"), ["CONNECT"]);
    assert.throws(() => admin.execute("GRANT CONNECT TO NOBODY"), state("42704"));
    assert.throws(() => admin.execute("GRANT CUSTOM TO ALICE"), state("0A000"));
  } finally {
    db.close();
  }
});

test("계정, 권한, 권한 그룹은 재구동 뒤에도 남는다", (t) => {
  const dir = tempDir(t);
  let db = Database.open(dir, { onWarning: () => {}, scramIterations: 1000 });
  try {
    const admin = db.createSession({});
    admin.execute("CREATE TABLESPACE APP");
    admin.execute("CREATE USER ALICE IDENTIFIED BY 'a-pw' DEFAULT TABLESPACE APP");
    admin.execute("GRANT CONNECT TO ALICE");
    admin.execute("GRANT SELECT, INSERT ON TABLESPACE APP TO ALICE");
    admin.execute("CREATE TABLE APP.T (A INTEGER)");
    admin.execute("GRANT UPDATE ON TABLE APP.T TO ALICE");
    admin.execute("ALTER USER SYSTEM IDENTIFIED BY 'changed-pw'");
  } finally {
    db.close();
  }
  db = Database.open(dir, { onWarning: () => {}, scramIterations: 1000 });
  try {
    assert.throws(() => db.login("SYSTEM", INITIAL_SYSTEM_PASSWORD), state("28000"));
    assert.equal(db.login("SYSTEM", "changed-pw").user, "SYSTEM");
    assert.equal(db.isInitialSystemPassword(), false);
    const alice = db.login("ALICE", "a-pw", { local: false });
    assert.equal(alice.currentTablespace, "APP");
    alice.execute("INSERT INTO T VALUES (1)");
    alice.execute("UPDATE T SET A = 2");
    assert.deepEqual(rows(alice, "SELECT A FROM T"), [["2"]]);
    assert.throws(() => alice.execute("DELETE FROM T"), denied);
  } finally {
    db.close();
  }
});

test("DROP TABLESPACE : 그 테이블스페이스의 권한 기록은 지워지고, 기본으로 쓰던 사용자는 기본 테이블스페이스가 없어진다", (t) => {
  const { db, admin } = setupAuth(t);
  try {
    admin.execute("CREATE TABLESPACE OTHER");
    makeUser(admin, "ALICE", "APP");
    admin.execute("GRANT ALL ON TABLESPACE APP TO ALICE");
    admin.execute("GRANT SELECT ON TABLESPACE OTHER TO ALICE");
    admin.execute("CREATE TABLE APP.T (A INTEGER)");
    admin.execute("GRANT SELECT ON TABLE APP.T TO ALICE");
    admin.execute("DROP TABLESPACE APP INCLUDING CONTENTS");
    assert.equal(db.users.get("ALICE")?.defaultTablespace, null);
    assert.deepEqual(
      db.access.records().filter((record) => record.grantee === "ALICE").map((record) => `${record.tablespace}:${record.privilege}`),
      ["OTHER:SELECT"],
    );
    // 같은 이름으로 다시 만들어도 이전 권한이 되살아나지 않는다.
    admin.execute("CREATE TABLESPACE APP");
    assert.equal(db.access.hasTablespacePrivilege("ALICE", "APP", "SELECT"), false);
    assert.equal(db.login("ALICE", "alice-pw").currentTablespace, "");
  } finally {
    db.close();
  }
});

test("SYS_USERS 는 DBA 에게 전부, 그 밖에는 자기 행만 보여 주고 비밀번호 정보는 노출하지 않는다", (t) => {
  const { db, admin } = setupAuth(t);
  try {
    makeUser(admin, "ALICE", "APP");
    makeUser(admin, "BOB");
    assert.deepEqual(rows(admin, "SELECT USER_NAME, DEFAULT_TABLESPACE FROM SYS_USERS ORDER BY USER_NAME"), [
      ["ALICE", "APP"],
      ["BOB", "NULL"],
      ["SYSTEM", "SYSTEM"],
    ]);
    const alice = db.login("ALICE", "alice-pw");
    assert.deepEqual(rows(alice, "SELECT USER_NAME FROM SYS_USERS"), [["ALICE"]]);
    // 열은 이름과 기본 테이블스페이스뿐이다.
    assert.deepEqual(selectStrings(admin.execute("SELECT * FROM SYS_USERS")).columns, ["USER_NAME", "DEFAULT_TABLESPACE"]);
    assert.throws(() => admin.execute("SELECT STOREDKEY FROM SYS_USERS"), DbError);
    // 딕셔너리 뷰는 읽기 전용이다.
    assert.throws(() => admin.execute("DELETE FROM SYS_USERS"), state("42809"));
  } finally {
    db.close();
  }
});

test("SYS_GROUP_GRANTS 와 SYS_SESSIONS 는 DBA 가 아니면 자기 것만 보인다", (t) => {
  const { db, admin } = setupAuth(t);
  try {
    makeUser(admin, "ALICE");
    makeUser(admin, "BOB");
    admin.execute("GRANT CONNECT TO ALICE, BOB");
    admin.execute("GRANT OFFICER TO BOB");
    const alice = db.login("ALICE", "alice-pw");
    const bob = db.login("BOB", "bob-pw");
    assert.deepEqual(rows(admin, "SELECT GRANTEE, GROUP_NAME FROM SYS_GROUP_GRANTS ORDER BY GRANTEE, GROUP_NAME"), [
      ["ALICE", "CONNECT"],
      ["BOB", "CONNECT"],
      ["BOB", "OFFICER"],
      ["SYSTEM", "DBA"],
    ]);
    assert.deepEqual(rows(alice, "SELECT GRANTEE, GROUP_NAME FROM SYS_GROUP_GRANTS"), [["ALICE", "CONNECT"]]);
    assert.deepEqual(rows(bob, "SELECT GROUP_NAME FROM SYS_GROUP_GRANTS ORDER BY GROUP_NAME"), [["CONNECT"], ["OFFICER"]]);
    assert.deepEqual(rows(alice, "SELECT USER_NAME FROM SYS_SESSIONS"), [["ALICE"]]);
    assert.deepEqual(rows(admin, "SELECT USER_NAME FROM SYS_SESSIONS ORDER BY USER_NAME"), [["ALICE"], ["BOB"], ["SYSTEM"]]);
  } finally {
    db.close();
  }
});
