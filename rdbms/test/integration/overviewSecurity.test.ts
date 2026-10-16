/**
 * 개요 4, 5, 6 의 시나리오 시험 (11단계). 실제 `hwdb start` 로 띄운 데몬에 사용자별로 네트워크 접속해 권한을 확인한다.
 *  - 개요 4 : 사용자 계정(Username, Password). 기본 테이블스페이스와 함께 만들기, 비밀번호·기본 테이블스페이스 변경, SYSTEM 계정(HelloWorldDB)
 *  - 개요 5 : 테이블스페이스·테이블·뷰 수준의 CRUD 와 DDL 권한, 뷰 권한 규칙(개요의 VIEW_SAMPLE1 예시), GRANT·REVOKE, 권한 상속 없음
 *  - 개요 6 : 권한 그룹 CONNECT·OFFICER·DBA. CONNECT 는 이 장비의 루프백이 아닌 주소(원격)로 접속해 확인한다.
 * 권한 조합별 세부는 `test/auth` 가 깊게 본다. 여기서는 사양 문장이 프로토콜과 소켓을 거친 실제 접속에서 끝까지 맞는지를 본다.
 * 관련 사양 : AGENTS.md 개요 4, 5, 6, 상세 4, 5, 6
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Connection } from "../../src/client/connection.js";
import { DbError } from "../../src/common/errors.js";
import { Daemon, exec, execAll, failure, lanAddress, num, query, sleep } from "./helpers.js";

/** 문장이 권한 오류(42501) 없이 실행되면 true, 권한 오류면 false 이다. 다른 오류는 그대로 던진다. */
async function allowed(connection: Connection, sql: string): Promise<boolean> {
  try {
    await exec(connection, sql);
    return true;
  } catch (error) {
    if (error instanceof DbError && error.sqlState === "42501") return false;
    throw error;
  }
}

/** 이름과 비밀번호로 TCP 접속한다. */
function asUser(daemon: Daemon, user: string, password: string, kind: "tcp" | "udp" | "local" = "tcp"): Promise<Connection> {
  return daemon.connect(kind, { user, password });
}

// ---------------------------------------------------------------------------
// 개요 4 : 사용자 계정
// ---------------------------------------------------------------------------

test("개요 4 : SYSTEM 계정(암호 HelloWorldDB)은 최초 설치 때 DBA 로 제공되고 삭제할 수 없다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const system = await daemon.connect("tcp"); // 기본값이 SYSTEM / HelloWorldDB
  assert.equal(system.session?.user, "SYSTEM");
  assert.equal(system.session?.tablespace, "SYSTEM", "SYSTEM 의 기본 테이블스페이스는 SYSTEM");
  assert.deepEqual(await query(system, "SELECT CURRENT_USER"), [["SYSTEM"]]);
  assert.deepEqual(await query(system, "SELECT GRANTEE, GROUP_NAME FROM SYS_GROUP_GRANTS"), [["SYSTEM", "DBA"]], "DBA 만 있고 CONNECT 는 없다");
  // 비밀번호가 틀리면 사용자가 없는 경우와 구별되지 않는 같은 오류이다.
  const wrong = await failureOnConnect(daemon, "SYSTEM", "wrong");
  const ghost = await failureOnConnect(daemon, "NOBODY", "wrong");
  assert.equal(wrong.sqlState, "28000");
  assert.equal(wrong.code, 7000);
  assert.equal(ghost.sqlState, wrong.sqlState);
  assert.equal(ghost.code, wrong.code);
  assert.equal(ghost.message, wrong.message, "사용자가 없는 경우와 비밀번호가 틀린 경우를 구분하지 않는다");
  // 삭제할 수 없고 DBA 를 회수할 수 없다.
  assert.equal((await failure(system, "DROP USER SYSTEM")).sqlState, "42501");
  assert.equal((await failure(system, "REVOKE DBA FROM SYSTEM")).sqlState.length, 5);
  assert.deepEqual(await query(system, "SELECT GROUP_NAME FROM SYS_GROUP_GRANTS WHERE GRANTEE = 'SYSTEM'"), [["DBA"]]);
});

async function failureOnConnect(daemon: Daemon, user: string, password: string): Promise<DbError> {
  try {
    await daemon.connect("tcp", { user, password });
  } catch (error) {
    if (error instanceof DbError) return error;
    throw error;
  }
  throw new Error("The login should have failed.");
}

test("개요 4 : 사용자를 기본 테이블스페이스와 함께 만들고 비밀번호와 기본 테이블스페이스를 바꾼다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const system = await daemon.connect("local");
  await execAll(system, [
    "CREATE TABLESPACE APP",
    "CREATE TABLESPACE LOGS",
    "CREATE USER U1 IDENTIFIED BY 'pw-one' DEFAULT TABLESPACE APP",
    "GRANT ALL ON TABLESPACE APP TO U1",
    "GRANT ALL ON TABLESPACE LOGS TO U1",
    "CREATE USER NODEFAULT IDENTIFIED BY 'pw-nd'",
  ]);
  // 기본 테이블스페이스가 접속 직후의 현재 테이블스페이스이다. 이름에 테이블스페이스를 붙이지 않은 객체는 거기에 만들어진다.
  const first = await asUser(daemon, "U1", "pw-one");
  assert.equal(first.session?.tablespace, "APP");
  await exec(first, "CREATE TABLE MINE (A INTEGER)");
  assert.deepEqual(await query(system, "SELECT TABLESPACE_NAME FROM SYS_TABLES WHERE TABLE_NAME = 'MINE'"), [["APP"]]);
  // 기본 테이블스페이스를 지정했다고 권한이 생기지는 않는다. 다른 사용자는 기본 테이블스페이스가 없다.
  const noDefault = await asUser(daemon, "NODEFAULT", "pw-nd");
  assert.equal(noDefault.session?.tablespace, null, "기본 테이블스페이스가 없으면 현재 테이블스페이스도 없다");
  assert.equal((await failure(noDefault, "SELECT * FROM MINE")).sqlState, "3F000", "이름에 테이블스페이스명을 붙이거나 USE 를 해야 한다");
  assert.equal((await failure(noDefault, "SELECT * FROM APP.MINE")).sqlState, "42501", "권한이 없다");
  await exec(system, "GRANT SELECT ON TABLESPACE APP TO NODEFAULT");
  await exec(noDefault, "USE APP");
  assert.deepEqual(await query(noDefault, "SELECT COUNT(*) FROM MINE"), [["0"]]);

  // 비밀번호 변경 : 자기 자신은 누구나 바꿀 수 있고, 바꾸면 옛 비밀번호는 쓸 수 없다.
  await exec(first, "ALTER USER U1 IDENTIFIED BY 'pw-two'");
  assert.equal((await failureOnConnect(daemon, "U1", "pw-one")).sqlState, "28000");
  const second = await asUser(daemon, "U1", "pw-two");
  assert.equal(await num(second, "SELECT 1"), 1);
  // 다른 사용자의 정보를 바꾸는 것은 DBA 만 할 수 있다.
  assert.equal((await failure(second, "ALTER USER NODEFAULT IDENTIFIED BY 'x'")).sqlState, "42501");
  assert.equal((await failure(second, "ALTER USER U1 DEFAULT TABLESPACE LOGS")).sqlState, "42501", "자기 자신의 기본 테이블스페이스도 DBA 만");
  // 기본 테이블스페이스 변경은 다음 접속부터 쓰인다.
  await exec(system, "ALTER USER U1 DEFAULT TABLESPACE LOGS");
  const third = await asUser(daemon, "U1", "pw-two");
  assert.equal(third.session?.tablespace, "LOGS");
  // 비밀번호와 기본 테이블스페이스를 한 문장에 바꿀 수도 있다.
  await exec(system, "ALTER USER U1 IDENTIFIED BY 'pw-three' DEFAULT TABLESPACE APP");
  const fourth = await asUser(daemon, "U1", "pw-three");
  assert.equal(fourth.session?.tablespace, "APP");
  // 사용자 생성·삭제는 DBA 만. 권한 그룹 이름은 사용자 이름이 될 수 없다.
  assert.equal((await failure(fourth, "CREATE USER U9 IDENTIFIED BY 'x'")).sqlState, "42501");
  assert.equal((await failure(fourth, "CREATE TABLESPACE NOPE")).sqlState, "42501", "테이블스페이스 생성도 DBA 만");
  assert.equal((await failure(system, "CREATE USER DBA IDENTIFIED BY 'x'")).sqlState, "42602");
  assert.equal((await failure(system, "CREATE USER U1 IDENTIFIED BY 'x'")).sqlState, "42710", "이미 있는 사용자");
});

test("개요 4 : 비밀번호는 평문으로 저장하지도 로그에 남기지도 않는다 (SCRAM-SHA-256 검증 정보)", async (t) => {
  const daemon = await Daemon.create(t, { log: { level: "debug" } });
  daemon.start();
  const system = await daemon.connect("tcp");
  const secret = "Zq9-unique-Secret-4711";
  const changed = "Rk3-another-Secret-0815";
  await exec(system, `CREATE USER SECRETIVE IDENTIFIED BY '${secret}'`);
  await exec(system, `ALTER USER SECRETIVE IDENTIFIED BY '${changed}'`);
  await exec(system, `ALTER USER SYSTEM IDENTIFIED BY '${changed}-sys'`);
  const secretive = await asUser(daemon, "SECRETIVE", changed);
  assert.equal(await num(secretive, "SELECT 1"), 1);
  // 문장 원문이 debug 로그에 남더라도 비밀번호 자리는 가려진다.
  await system.close();
  await secretive.close();
  daemon.stopClean();
  const everything = [daemon.log(), ...fs.readdirSync(daemon.dataDir).map((name) => fs.readFileSync(path.join(daemon.dataDir, name)).toString("latin1"))];
  for (const text of everything) {
    for (const word of [secret, changed, `${changed}-sys`]) {
      assert.equal(text.includes(word), false, `비밀번호 ${word} 가 데이터 파일이나 로그에 남아 있다`);
    }
  }
  assert.match(daemon.log(), /IDENTIFIED BY '\*\*\*'/, "문장은 남지만 비밀번호 자리는 가려진다");
  // 검증 정보도 딕셔너리 뷰로 보이지 않는다.
  daemon.start();
  const again = await asUser(daemon, "SYSTEM", `${changed}-sys`);
  const columns = (await again.execute("SELECT * FROM SYS_USERS")).kind === "rows" ? ((await again.execute("SELECT * FROM SYS_USERS")) as { columns: Array<{ name: string }> }).columns.map((column) => column.name) : [];
  assert.equal(columns.some((name) => /PASSWORD|VERIFIER|KEY|SALT/i.test(name)), false, columns.join(","));
});

test("개요 4 : 새로 만든 사용자는 아무 권한이 없고 로컬 로그인만 된다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const system = await daemon.connect("local");
  await execAll(system, ["CREATE TABLE SYSTEM.SECRET_T (A INTEGER)", "CREATE USER NEWBIE IDENTIFIED BY 'pw' DEFAULT TABLESPACE SYSTEM"]);
  for (const kind of ["local", "tcp", "udp"] as const) {
    const newbie = await asUser(daemon, "NEWBIE", "pw", kind); // 루프백은 로컬 접속이므로 CONNECT 가 없어도 된다
    assert.equal(await num(newbie, "SELECT 1"), 1, kind);
    assert.equal(await allowed(newbie, "SELECT * FROM SECRET_T"), false, kind);
    assert.equal(await allowed(newbie, "INSERT INTO SECRET_T VALUES (1)"), false, kind);
    assert.equal(await allowed(newbie, "CREATE TABLE MINE (A INTEGER)"), false, kind);
    assert.equal(await allowed(newbie, "DROP TABLE SECRET_T"), false, kind);
  }
});

// ---------------------------------------------------------------------------
// 개요 5 : 권한
// ---------------------------------------------------------------------------

/** 테이블스페이스 T1 과 T2 에 테이블을 두고 권한 시험용 사용자를 만든다. */
async function privilegeFixture(daemon: Daemon): Promise<Connection> {
  const system = await daemon.connect("local");
  await execAll(system, [
    "CREATE TABLESPACE T1",
    "CREATE TABLESPACE T2",
    "CREATE TABLE T1.A (ID INTEGER PRIMARY KEY, V INTEGER)",
    "CREATE TABLE T1.B (ID INTEGER PRIMARY KEY, V INTEGER)",
    "CREATE TABLE T2.C (ID INTEGER PRIMARY KEY, V INTEGER)",
    "INSERT INTO T1.A VALUES (1, 10)",
    "INSERT INTO T1.B VALUES (1, 20)",
    "INSERT INTO T2.C VALUES (1, 30)",
  ]);
  for (const name of ["U1", "U2", "U3", "U4"]) await exec(system, `CREATE USER ${name} IDENTIFIED BY 'pw'`);
  return system;
}

test("개요 5 : 테이블스페이스별 CRUD·DDL 권한은 그 안의 모든 테이블과 뷰, 나중에 만든 것에도 미치고 다른 테이블스페이스에는 미치지 않는다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const system = await privilegeFixture(daemon);
  const u1 = await asUser(daemon, "U1", "pw");

  assert.equal(await allowed(u1, "SELECT * FROM T1.A"), false, "처음에는 아무 권한이 없다");
  await exec(system, "GRANT SELECT ON TABLESPACE T1 TO U1");
  assert.equal(await allowed(u1, "SELECT * FROM T1.A"), true);
  assert.equal(await allowed(u1, "SELECT * FROM T1.B"), true, "그 안의 모든 테이블");
  assert.equal(await allowed(u1, "SELECT * FROM T2.C"), false, "다른 테이블스페이스에는 미치지 않는다");
  assert.equal(await allowed(u1, "INSERT INTO T1.A VALUES (2, 1)"), false, "SELECT 만 있다");
  await exec(system, "CREATE TABLE T1.LATER (ID INTEGER)");
  assert.equal(await allowed(u1, "SELECT * FROM T1.LATER"), true, "나중에 만든 테이블에도");

  // CRUD 권한은 각각 따로이다.
  await exec(system, "GRANT INSERT ON TABLESPACE T1 TO U1");
  assert.equal(await allowed(u1, "INSERT INTO T1.A VALUES (2, 1)"), true);
  assert.equal(await allowed(u1, "UPDATE T1.A SET V = 5 WHERE ID = 1"), false);
  assert.equal(await allowed(u1, "DELETE FROM T1.A WHERE ID = 2"), false);
  await exec(system, "GRANT UPDATE ON TABLESPACE T1 TO U1");
  assert.equal(await allowed(u1, "UPDATE T1.A SET V = 5 WHERE ID = 1"), true);
  assert.equal(await allowed(u1, "DELETE FROM T1.A WHERE ID = 2"), false);
  await exec(system, "GRANT DELETE ON TABLESPACE T1 TO U1");
  assert.equal(await allowed(u1, "DELETE FROM T1.A WHERE ID = 2"), true);

  // DDL 권한도 따로이다 : CREATE, ALTER, DROP
  assert.equal(await allowed(u1, "CREATE TABLE T1.NEW1 (A INTEGER)"), false);
  assert.equal(await allowed(u1, "ALTER TABLE T1.A ADD COLUMN W INTEGER"), false);
  assert.equal(await allowed(u1, "DROP TABLE T1.B"), false);
  await exec(system, "GRANT CREATE ON TABLESPACE T1 TO U1");
  assert.equal(await allowed(u1, "CREATE TABLE T1.NEW1 (A INTEGER)"), true);
  assert.equal(await allowed(u1, "CREATE TABLE T2.NEW2 (A INTEGER)"), false, "다른 테이블스페이스에는 만들 수 없다");
  assert.equal(await allowed(u1, "CREATE VIEW T1.NEWV AS SELECT ID FROM T1.A"), true, "CREATE 로 뷰도 만든다 (참조하는 객체의 SELECT 가 있어야 한다)");
  assert.equal(await allowed(u1, "ALTER TABLE T1.A ADD COLUMN W INTEGER"), false, "ALTER 는 따로");
  await exec(system, "GRANT ALTER ON TABLESPACE T1 TO U1");
  assert.equal(await allowed(u1, "ALTER TABLE T1.A ADD COLUMN W INTEGER"), true);
  assert.equal(await allowed(u1, "CREATE INDEX ON T1.A (V)"), true, "인덱스 생성은 ALTER 권한");
  assert.equal(await allowed(u1, "DROP TABLE T1.B"), false, "DROP 은 따로");
  await exec(system, "GRANT DROP ON TABLESPACE T1 TO U1");
  assert.equal(await allowed(u1, "DROP TABLE T1.B"), true);
  assert.equal(await allowed(u1, "DROP TABLE T1.LATER"), true, "그 안의 모든 객체");
  assert.equal(await allowed(u1, "DROP TABLE T2.C"), false);

  // ALL 은 그 수준에서 줄 수 있는 모든 권한이다.
  await exec(system, "GRANT ALL ON TABLESPACE T2 TO U2");
  const u2 = await asUser(daemon, "U2", "pw");
  assert.equal(await allowed(u2, "SELECT * FROM T2.C"), true);
  assert.equal(await allowed(u2, "UPDATE T2.C SET V = 1"), true);
  assert.equal(await allowed(u2, "CREATE TABLE T2.X (A INTEGER)"), true);
  assert.equal(await allowed(u2, "DROP TABLE T2.X"), true);
  assert.equal(await allowed(u2, "SELECT * FROM T1.A"), false);
});

test("개요 5 : 테이블스페이스 안의 특정 테이블별 CRUD·DDL 권한", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const system = await privilegeFixture(daemon);
  const u1 = await asUser(daemon, "U1", "pw");
  await exec(system, "GRANT SELECT, UPDATE ON TABLE T1.A TO U1");
  assert.equal(await allowed(u1, "SELECT * FROM T1.A"), true);
  assert.equal(await allowed(u1, "UPDATE T1.A SET V = 11 WHERE ID = 1"), true);
  assert.equal(await allowed(u1, "INSERT INTO T1.A VALUES (5, 5)"), false);
  assert.equal(await allowed(u1, "DELETE FROM T1.A"), false);
  assert.equal(await allowed(u1, "SELECT * FROM T1.B"), false, "같은 테이블스페이스의 다른 테이블에는 미치지 않는다");
  assert.equal(await allowed(u1, "UPDATE T1.B SET V = 1"), false);
  // 테이블 수준 DDL : ALTER 는 ALTER TABLE 과 인덱스, DROP 은 DROP TABLE 과 TRUNCATE
  assert.equal(await allowed(u1, "CREATE INDEX ON T1.A (V)"), false);
  assert.equal(await allowed(u1, "TRUNCATE T1.A"), false);
  await exec(system, "GRANT ALTER, DROP ON TABLE T1.A TO U1");
  assert.equal(await allowed(u1, "CREATE INDEX ON T1.A (V)"), true);
  assert.equal(await allowed(u1, "CREATE INDEX ON T1.B (V)"), false);
  assert.equal(await allowed(u1, "ALTER TABLE T1.A ADD COLUMN W INTEGER"), true);
  assert.equal(await allowed(u1, "TRUNCATE T1.A"), true);
  assert.equal(await allowed(u1, "DROP TABLE T1.B"), false);
  assert.equal(await allowed(u1, "DROP TABLE T1.A"), true);
  // 테이블에는 CREATE 를 줄 수 없다 (만들기 전에는 테이블이 없다)
  assert.equal((await failure(system, "GRANT CREATE ON TABLE T1.B TO U1")).sqlState.length, 5);
});

test("개요 5 : 뷰 권한이 있으면 기반 테이블 권한 없이도 그 뷰를 쓴다 (개요의 VIEW_SAMPLE1 UPDATE 예시)", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const system = await privilegeFixture(daemon);
  await execAll(system, [
    "CREATE VIEW T1.VIEW_SAMPLE1 AS SELECT ID, V FROM T1.A",
    "CREATE VIEW T1.JOINED AS SELECT A.ID, A.V AS AV, B.V AS BV FROM T1.A A JOIN T1.B B ON B.ID = A.ID",
    "GRANT SELECT, UPDATE ON VIEW T1.VIEW_SAMPLE1 TO U1",
    "GRANT SELECT ON VIEW T1.JOINED TO U1",
  ]);
  const u1 = await asUser(daemon, "U1", "pw");
  // U1 은 기반 테이블 T1.A, T1.B 에 아무 권한이 없다.
  assert.equal(await allowed(u1, "SELECT * FROM T1.A"), false);
  assert.equal(await allowed(u1, "UPDATE T1.A SET V = 1"), false);
  assert.equal((await query(u1, "SELECT V FROM T1.VIEW_SAMPLE1 WHERE ID = 1"))[0]?.[0], 10, "뷰는 읽을 수 있다");
  // 뷰의 UPDATE 권한으로 기반 테이블을 갱신한다.
  await exec(u1, "UPDATE T1.VIEW_SAMPLE1 SET V = 99 WHERE ID = 1");
  assert.deepEqual(await query(system, "SELECT V FROM T1.A WHERE ID = 1"), [[99]], "기반 테이블에 반영되었다");
  // 뷰 권한대로만 동작한다 : INSERT·DELETE 권한은 따로 필요하다.
  assert.equal(await allowed(u1, "INSERT INTO T1.VIEW_SAMPLE1 VALUES (7, 7)"), false);
  assert.equal(await allowed(u1, "DELETE FROM T1.VIEW_SAMPLE1 WHERE ID = 1"), false);
  // 여러 테이블을 조인한 뷰도 SELECT 권한만으로 읽는다.
  assert.deepEqual(await query(u1, "SELECT ID, AV, BV FROM T1.JOINED"), [[1, 99, 20]]);
  assert.equal(await allowed(u1, "UPDATE T1.JOINED SET AV = 1"), false, "UPDATE 권한이 없다");
  // 뷰 수준의 DDL : CREATE OR REPLACE VIEW 는 뷰의 ALTER, DROP VIEW 는 뷰의 DROP
  assert.equal(await allowed(u1, "DROP VIEW T1.VIEW_SAMPLE1"), false);
  await exec(system, "GRANT DROP ON VIEW T1.VIEW_SAMPLE1 TO U1");
  assert.equal(await allowed(u1, "DROP VIEW T1.VIEW_SAMPLE1"), true);
  // 뷰 권한을 회수하면 다시 쓸 수 없다. 기반 테이블 권한이 있어도 뷰 권한은 따로이다.
  await exec(system, "REVOKE SELECT ON VIEW T1.JOINED FROM U1");
  assert.equal(await allowed(u1, "SELECT * FROM T1.JOINED"), false);
});

test("개요 5 : 뷰 소유자 본인은 따로 받은 뷰 권한이 없으면 기반 객체에 대한 본인의 권한으로 검사한다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const system = await privilegeFixture(daemon);
  await execAll(system, ["GRANT SELECT ON TABLE T1.A TO U1", "GRANT CREATE ON TABLESPACE T1 TO U1", "GRANT SELECT ON TABLE T1.B TO U1"]);
  const u1 = await asUser(daemon, "U1", "pw");
  // 뷰를 만들려면 테이블스페이스 CREATE 와 참조하는 모든 객체의 SELECT 가 필요하다.
  assert.equal(await allowed(u1, "CREATE VIEW T1.MYV AS SELECT ID, V FROM T1.A"), true);
  assert.equal(await allowed(u1, "CREATE VIEW T1.BADV AS SELECT ID, V FROM T2.C"), false, "참조하는 객체의 SELECT 가 없다");
  assert.equal(await allowed(u1, "SELECT * FROM T1.MYV"), true);
  // 뷰를 만들었다고 기반 테이블에 없던 권한이 생기지 않는다.
  assert.equal(await allowed(u1, "UPDATE T1.MYV SET V = 1"), false);
  // 기반 테이블의 권한을 잃으면 자기 뷰도 쓸 수 없다.
  await exec(system, "REVOKE SELECT ON TABLE T1.A FROM U1");
  assert.equal(await allowed(u1, "SELECT * FROM T1.MYV"), false);
});

test("개요 5 : GRANT·REVOKE 는 접속 중인 세션에 다음 문장부터 적용되고, 수준별 기록은 서로 독립이며, 객체를 지우면 기록도 사라진다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const system = await privilegeFixture(daemon);
  const u1 = await asUser(daemon, "U1", "pw"); // 접속해 둔 채로
  assert.equal(await allowed(u1, "SELECT * FROM T1.A"), false);
  await exec(system, "GRANT SELECT ON TABLE T1.A TO U1");
  assert.equal(await allowed(u1, "SELECT * FROM T1.A"), true, "접속을 다시 하지 않아도 바로 적용된다");
  await exec(system, "GRANT SELECT ON TABLESPACE T1 TO U1");
  await exec(system, "REVOKE SELECT ON TABLESPACE T1 FROM U1");
  assert.equal(await allowed(u1, "SELECT * FROM T1.A"), true, "테이블 수준으로 따로 준 권한은 남는다");
  assert.equal(await allowed(u1, "SELECT * FROM T1.B"), false);
  await exec(system, "REVOKE ALL ON TABLE T1.A FROM U1");
  assert.equal(await allowed(u1, "SELECT * FROM T1.A"), false);
  // 부여된 적 없는 권한을 회수하면 오류 없이 넘어간다.
  await exec(system, "REVOKE DELETE ON TABLE T1.B FROM U1");
  // 객체를 지우면 그 객체의 권한 기록도 지운다.
  await exec(system, "GRANT SELECT, UPDATE ON TABLE T1.B TO U1");
  assert.equal(await num(system, "SELECT COUNT(*) FROM SYS_PRIVILEGES WHERE OBJECT_NAME = 'B'"), 2);
  await exec(system, "DROP TABLE T1.B");
  assert.equal(await num(system, "SELECT COUNT(*) FROM SYS_PRIVILEGES WHERE OBJECT_NAME = 'B'"), 0);
  // 테이블스페이스를 지우면 그 테이블스페이스의 권한 기록도 지운다.
  await exec(system, "GRANT SELECT ON TABLESPACE T2 TO U1");
  await exec(system, "DROP TABLESPACE T2 INCLUDING CONTENTS");
  assert.equal(await num(system, "SELECT COUNT(*) FROM SYS_PRIVILEGES WHERE TABLESPACE_NAME = 'T2'"), 0);
});

test("개요 5 : 개별 권한 상속은 구현하지 않는다 (WITH GRANT OPTION 과 사용자 간 상속, PUBLIC, 컬럼 단위 권한 없음)", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const system = await privilegeFixture(daemon);
  assert.equal((await failure(system, "GRANT SELECT ON TABLE T1.A TO U1 WITH GRANT OPTION")).sqlState, "0A000");
  assert.equal((await failure(system, "GRANT SELECT ON TABLESPACE T1 TO U1 WITH GRANT OPTION")).sqlState, "0A000");
  assert.equal((await failure(system, "GRANT SELECT ON TABLE T1.A TO PUBLIC")).sqlState.length, 5);
  assert.equal((await failure(system, "GRANT SELECT (V) ON TABLE T1.A TO U1")).sqlState.length, 5);
  // 받은 권한을 남에게 다시 줄 수 없다. 테이블 소유자와 DBA 만 줄 수 있다.
  await exec(system, "GRANT SELECT ON TABLE T1.A TO U1");
  const u1 = await asUser(daemon, "U1", "pw");
  assert.equal(await allowed(u1, "GRANT SELECT ON TABLE T1.A TO U2"), false);
  // 소유자는 자기 테이블의 권한을 줄 수 있다.
  await exec(system, "GRANT CREATE ON TABLESPACE T1 TO U3");
  const u3 = await asUser(daemon, "U3", "pw");
  await exec(u3, "CREATE TABLE T1.OWNED (A INTEGER)");
  await exec(u3, "GRANT SELECT ON TABLE T1.OWNED TO U4");
  const u4 = await asUser(daemon, "U4", "pw");
  assert.equal(await allowed(u4, "SELECT * FROM T1.OWNED"), true);
  assert.equal(await allowed(u3, "GRANT SELECT ON TABLE T1.A TO U4"), false, "소유하지 않은 테이블의 권한은 줄 수 없다");
  assert.equal(await allowed(u3, "GRANT SELECT ON TABLESPACE T1 TO U4"), false, "테이블스페이스 수준 권한은 DBA 만 준다");
});

// ---------------------------------------------------------------------------
// 개요 6 : 권한 그룹
// ---------------------------------------------------------------------------

const lan = lanAddress();
const needLan = lan === null ? "루프백이 아닌 IPv4 주소가 없다" : false;

test("개요 6 : CONNECT 가 없으면 로컬(루프백, 로컬 전용 채널)에서만 접속되고 원격은 비밀번호가 맞아도 거부된다", { skip: needLan }, async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const system = await daemon.connect("local");
  await exec(system, "CREATE USER REMOTEUSER IDENTIFIED BY 'pw'");
  const remote = lan as string;

  for (const kind of ["tcp", "udp"] as const) {
    // 루프백은 로컬 접속이므로 CONNECT 가 없어도 된다.
    const local = await daemon.connect(kind, { user: "REMOTEUSER", password: "pw" });
    assert.equal(await num(local, "SELECT 1"), 1);
    // 서버 장비의 루프백이 아닌 주소로 접속하면 같은 장비라도 원격이다.
    const refused = await failureOnOpen(() => daemon.connect(kind, { host: remote, user: "REMOTEUSER", password: "pw" }));
    assert.equal(refused.sqlState, "28000", kind);
    assert.equal(refused.code, 7006, "인증 실패(7000)와 구별되는 CONNECT 거부");
    // 비밀번호가 틀리면 CONNECT 와 상관없이 인증 실패이다. (CONNECT 가 있는지는 비밀번호를 맞게 낸 사람에게만 알려진다)
    const wrong = await failureOnOpen(() => daemon.connect(kind, { host: remote, user: "REMOTEUSER", password: "bad" }));
    assert.equal(wrong.code, 7000, kind);
  }
  assert.equal(await num(await daemon.connect("local", { user: "REMOTEUSER", password: "pw" }), "SELECT 1"), 1, "로컬 전용 채널은 항상 받는다");

  // CONNECT 를 주면 원격에서도 접속된다.
  await exec(system, "GRANT CONNECT TO REMOTEUSER");
  assert.deepEqual(await query(system, "SELECT GROUP_NAME FROM SYS_GROUP_GRANTS WHERE GRANTEE = 'REMOTEUSER'"), [["CONNECT"]]);
  const tcp = await daemon.connect("tcp", { host: remote, user: "REMOTEUSER", password: "pw" });
  const udp = await daemon.connect("udp", { host: remote, user: "REMOTEUSER", password: "pw" });
  assert.equal(await num(tcp, "SELECT 1"), 1);
  assert.equal(await num(udp, "SELECT 1"), 1);
  // 세션 목록에는 접속한 상대 주소가 남는다. (이 사용자는 DBA 가 아니므로 자기 세션만 보인다)
  assert.deepEqual(await query(tcp, "SELECT CHANNEL, CLIENT_ADDRESS FROM SYS_SESSIONS WHERE CLIENT_ADDRESS = ? ORDER BY CHANNEL", [remote]), [["TCP", remote], ["UDP", remote]]);

  // 회수해도 이미 맺어진 세션은 끊지 않는다. 새 원격 접속은 다시 거부된다.
  await exec(system, "REVOKE CONNECT FROM REMOTEUSER");
  assert.equal(await num(tcp, "SELECT 2"), 2);
  assert.equal(await num(udp, "SELECT 3"), 3);
  assert.equal((await failureOnOpen(() => daemon.connect("tcp", { host: remote, user: "REMOTEUSER", password: "pw" }))).code, 7006);
});

test("개요 6 : DBA 에는 CONNECT 가 포함되지 않아 SYSTEM 도 처음에는 로컬에서만 접속되고, 접속용 CLI 의 로컬 접속은 항상 보장된다", { skip: needLan }, async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const remote = lan as string;
  const refused = await failureOnOpen(() => daemon.connect("tcp", { host: remote }));
  assert.equal(refused.code, 7006, "SYSTEM(DBA)도 CONNECT 가 없으면 원격 접속이 거부된다");
  // 접속용 CLI(hwdb)의 로컬 접속은 CONNECT 와 상관없이 된다.
  const cli = daemon.hwdb(["-u", "SYSTEM", "-p", "HelloWorldDB", "-e", "SELECT 'local ok'"]);
  assert.equal(cli.status, 0, cli.stderr);
  // 원격에서 관리하려면 GRANT CONNECT TO SYSTEM 이 필요하다.
  const local = await daemon.connect("local");
  await exec(local, "GRANT CONNECT TO SYSTEM");
  const remoteAdmin = await daemon.connect("tcp", { host: remote });
  assert.equal(await num(remoteAdmin, "SELECT 1"), 1);
  await exec(remoteAdmin, "REVOKE CONNECT FROM SYSTEM");
});

async function failureOnOpen(open: () => Promise<Connection>): Promise<DbError> {
  try {
    await open();
  } catch (error) {
    if (error instanceof DbError) return error;
    throw error;
  }
  throw new Error("The connection should have been refused.");
}

test("개요 6 : OFFICER 는 SYSTEM 을 제외한 모든 테이블스페이스(나중에 만든 것 포함)의 CRUD·DDL 을 포괄하고 관리 권한은 없다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const system = await privilegeFixture(daemon);
  await exec(system, "GRANT OFFICER TO U1");
  const u1 = await asUser(daemon, "U1", "pw");
  assert.equal(await allowed(u1, "SELECT * FROM T1.A"), true);
  assert.equal(await allowed(u1, "UPDATE T2.C SET V = 1"), true);
  assert.equal(await allowed(u1, "CREATE TABLE T1.MADE (A INTEGER)"), true);
  assert.equal(await allowed(u1, "ALTER TABLE T1.MADE ADD COLUMN B INTEGER"), true);
  assert.equal(await allowed(u1, "CREATE INDEX ON T1.A (V)"), true);
  assert.equal(await allowed(u1, "DROP TABLE T1.MADE"), true);
  // 나중에 만든 테이블스페이스에도 미친다.
  await exec(system, "CREATE TABLESPACE T3");
  assert.equal(await allowed(u1, "CREATE TABLE T3.LATE (A INTEGER)"), true);
  assert.equal(await allowed(u1, "INSERT INTO T3.LATE VALUES (1)"), true);
  // SYSTEM 테이블스페이스에는 미치지 않는다.
  assert.equal(await allowed(u1, "CREATE TABLE SYSTEM.NOT_ALLOWED (A INTEGER)"), false);
  assert.equal(await allowed(u1, "SELECT * FROM SYS_USERS"), true, "딕셔너리 뷰는 모든 사용자가 조회한다 (자기 것만)");
  assert.equal(await num(u1, "SELECT COUNT(*) FROM SYS_USERS"), 1, "DBA 가 아니면 자기 계정만 보인다");
  // GRANT·REVOKE, 사용자·테이블스페이스 관리는 포함하지 않는다.
  assert.equal(await allowed(u1, "GRANT SELECT ON TABLE T1.A TO U2"), false);
  assert.equal(await allowed(u1, "GRANT SELECT ON TABLESPACE T1 TO U2"), false);
  assert.equal(await allowed(u1, "CREATE USER U9 IDENTIFIED BY 'x'"), false);
  assert.equal(await allowed(u1, "CREATE TABLESPACE T9"), false);
  assert.equal(await allowed(u1, "DROP TABLESPACE T3 INCLUDING CONTENTS"), false);
  assert.equal(await allowed(u1, "GRANT OFFICER TO U2"), false);
  // 회수하면 사라진다.
  await exec(system, "REVOKE OFFICER FROM U1");
  assert.equal(await allowed(u1, "SELECT * FROM T1.A"), false);
});

test("개요 6 : DBA 는 모든 권한을 포괄하는 마스터 권한 그룹이다 (OFFICER 포함, CONNECT 제외)", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const system = await privilegeFixture(daemon);
  await exec(system, "GRANT DBA TO U1");
  const admin = await asUser(daemon, "U1", "pw");
  // SYSTEM 을 포함한 모든 테이블스페이스의 CRUD 와 DDL
  assert.equal(await allowed(admin, "CREATE TABLE SYSTEM.BYADMIN (A INTEGER)"), true);
  assert.equal(await allowed(admin, "INSERT INTO SYSTEM.BYADMIN VALUES (1)"), true);
  assert.equal(await allowed(admin, "UPDATE T1.A SET V = 1"), true, "OFFICER 가 포함된다");
  assert.equal(await allowed(admin, "DROP TABLE SYSTEM.BYADMIN"), true);
  // 테이블스페이스·사용자 생성, GRANT·REVOKE
  assert.equal(await allowed(admin, "CREATE TABLESPACE BYADMIN"), true);
  assert.equal(await allowed(admin, "CREATE USER BYADMIN_USER IDENTIFIED BY 'pw'"), true);
  assert.equal(await allowed(admin, "GRANT SELECT ON TABLESPACE T1 TO BYADMIN_USER"), true);
  assert.equal(await allowed(admin, "GRANT OFFICER TO BYADMIN_USER"), true);
  assert.equal(await allowed(admin, "REVOKE OFFICER FROM BYADMIN_USER"), true);
  assert.equal(await allowed(admin, "DROP USER BYADMIN_USER"), true);
  assert.equal(await allowed(admin, "DROP TABLESPACE BYADMIN INCLUDING CONTENTS"), true);
  assert.equal(await num(admin, "SELECT COUNT(*) FROM SYS_USERS"), 5, "DBA 는 모든 계정을 본다 (SYSTEM, U1 ~ U4)");
  // 권한 그룹의 부여와 회수는 DBA 만 한다.
  await exec(system, "GRANT OFFICER TO U2");
  const officer = await asUser(daemon, "U2", "pw");
  assert.equal(await allowed(officer, "GRANT DBA TO U2"), false);
  assert.equal(await allowed(officer, "REVOKE DBA FROM U1"), false);
  // 회수하면 DBA 권한이 사라진다.
  await exec(system, "REVOKE DBA FROM U1");
  assert.equal(await allowed(admin, "CREATE USER AGAIN IDENTIFIED BY 'x'"), false);
});

test("개요 6 : 사용자 정의 권한 그룹은 지원하지 않고 권한 그룹 이름은 예약되어 있다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const system = await privilegeFixture(daemon);
  assert.equal((await failure(system, "CREATE ROLE MYGROUP")).sqlState, "0A000");
  assert.equal((await failure(system, "GRANT MYGROUP TO U1")).sqlState.length, 5);
  for (const name of ["CONNECT", "OFFICER", "DBA"]) {
    assert.equal((await failure(system, `CREATE USER ${name} IDENTIFIED BY 'x'`)).sqlState, "42602", name);
  }
  // 권한 그룹은 여러 개를 한꺼번에 줄 수 있다.
  await exec(system, "GRANT CONNECT, OFFICER TO U1, U2");
  assert.deepEqual(
    await query(system, "SELECT GRANTEE, GROUP_NAME FROM SYS_GROUP_GRANTS WHERE GRANTEE IN ('U1', 'U2') ORDER BY 1, 2"),
    [["U1", "CONNECT"], ["U1", "OFFICER"], ["U2", "CONNECT"], ["U2", "OFFICER"]],
  );
  await sleep(0);
});
