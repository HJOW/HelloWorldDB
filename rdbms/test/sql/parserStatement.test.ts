/**
 * 담당 : DML, 테이블스페이스·사용자·권한 문장, 트랜잭션과 세션 문장의 구문 분석. 문장 단위의 규칙.
 * 관련 사양 : AGENTS.md 상세 0, 1-4, 3, 4, 5, 6, 10, 12, 13, 16.
 * 구현 단계 : 4단계.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type * as ast from "../../src/sql/ast.js";
import { parseStatement, RESERVED_WORDS } from "../../src/sql/parser.js";
import {
  assertSqlStateAt,
  assertSyntaxError,
  assertUnsupported,
  parse,
  renderExpression,
  renderQuery,
} from "./helpers.js";

const name = (text: string, tablespace: string | null = null): { tablespace: string | null; name: string } =>
  ({ tablespace, name: text });

/**
 * 지원하지 않는 문장의 오류가 가리킬 칸.
 * CREATE, ALTER, DROP 은 그 뒤의 객체 종류를, 나머지는 문장의 첫 단어를 가리킨다.
 */
function unsupportedColumn(sql: string): number {
  const prefix = /^(CREATE OR REPLACE |CREATE |ALTER |DROP )/.exec(sql);
  return prefix === null ? 1 : prefix[0].length + 1;
}

/** INSERT 문을 `대상(컬럼) <- 원본` 한 줄로 적는다. */
function insert(sql: string): string {
  const statement = parseStatement(sql).statement as ast.InsertStatement;
  assert.equal(statement.kind, "Insert");
  const target = `${statement.target.tablespace === null ? "" : `${statement.target.tablespace}.`}${statement.target.name}`;
  const columns = statement.columns === null ? "" : `(${statement.columns.join(",")})`;
  let source: string;
  if (statement.source.kind === "Values") {
    source = statement.source.rows.map((row) => `[${row.map(renderExpression).join(", ")}]`).join(" ");
  } else if (statement.source.kind === "Query") {
    source = renderQuery(statement.source.query);
  } else {
    source = "DEFAULT VALUES";
  }
  return `${target}${columns} <- ${source}`;
}

test("Hello World 샘플의 세 문장이 그대로 구문 분석된다", () => {
  assert.deepEqual(parse("CREATE TABLE HELLO (MESSAGE VARCHAR)"), {
    kind: "CreateTable",
    name: name("HELLO"),
    ifNotExists: false,
    columns: [{
      name: "MESSAGE",
      dataType: { kind: "VARCHAR", name: "VARCHAR", length: 65_535 },
      default: null,
      notNull: false,
      primaryKey: null,
      references: null,
    }],
    constraints: [],
  });
  assert.equal(insert("INSERT INTO HELLO VALUES ('Hello World')"), "HELLO <- ['Hello World']");
  assert.equal(renderQuery(parseStatement("SELECT * FROM HELLO").statement as ast.Query), "{SELECT * FROM HELLO}");
});

test("INSERT : INTO 와 컬럼 목록은 생략할 수 있다", () => {
  assert.equal(insert("INSERT INTO t VALUES (1, 'a')"), "T <- [1, 'a']");
  assert.equal(insert("INSERT t VALUES (1)"), "T <- [1]");
  assert.equal(insert("INSERT INTO app.t (a, b) VALUES (1, 2)"), "APP.T(A,B) <- [1, 2]");
  assert.equal(insert("INSERT INTO t (a) VALUES (1), (2), (3)"), "T(A) <- [1] [2] [3]");
  assert.equal(insert("INSERT INTO t VALUES (?, ? + 1, NULL, DEFAULT, CURRENT_DATE)"),
    "T <- [?1, (+ ?2 1), NULL, DEFAULT, (CURRENT_DATE)]");
  assert.equal(insert("INSERT INTO t DEFAULT VALUES"), "T <- DEFAULT VALUES");
  assert.equal(insert("INSERT INTO t SELECT * FROM u"), "T <- {SELECT * FROM U}");
  assert.equal(insert("INSERT INTO t (a, b) SELECT x, y FROM u WHERE x > 0 ORDER BY x"),
    "T(A,B) <- {SELECT X, Y FROM U WHERE (> X 0) ORDER X}");
  // 괄호로 감싼 질의는 컬럼 목록과 구별된다.
  assert.equal(insert("INSERT INTO t (SELECT a FROM u)"), "T <- {SELECT A FROM U}");
  assert.equal(insert("INSERT INTO t (a) (SELECT a FROM u UNION SELECT a FROM v)"), "T(A) <- {(UNION SELECT A FROM U SELECT A FROM V)}");
  assert.equal(insert('INSERT INTO "t" ("select") VALUES (1)'), "t(select) <- [1]");
  assertSyntaxError("INSERT INTO t", { line: 1, column: 14 }, /expected VALUES, DEFAULT VALUES or SELECT/);
  assertSyntaxError("INSERT INTO t VALUES", { line: 1, column: 21 });
  assertSyntaxError("INSERT INTO t VALUES ()", { line: 1, column: 23 });
  assertSyntaxError("INSERT INTO t VALUES (1,)");
  assertSyntaxError("INSERT INTO t VALUES (1) (2)");
  assertSyntaxError("INSERT INTO t () VALUES (1)");
  assertSyntaxError("INSERT INTO t (a b) VALUES (1)");
  assertSyntaxError("INSERT INTO VALUES (1)", { line: 1, column: 13 }, /Reserved word "VALUES"/);
  assertSyntaxError("INSERT INTO t VALUES (DEFAULT + 1)");
  assertUnsupported("INSERT ALL INTO t VALUES (1) SELECT 1");
  assertUnsupported("INSERT INTO t VALUES (1) RETURNING id");
  assertUnsupported("INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING");
});

test("UPDATE", () => {
  assert.deepEqual(parse("UPDATE t SET a = 1"), {
    kind: "Update",
    target: name("T"),
    alias: null,
    assignments: [{ column: "A", value: { kind: "Literal", type: "INTEGER", text: "1" } }],
    where: null,
  });
  const update = (sql: string): string => {
    const statement = parseStatement(sql).statement as ast.UpdateStatement;
    const assignments = statement.assignments.map((item) => `${item.column}=${renderExpression(item.value)}`).join(", ");
    const where = statement.where === null ? "" : ` WHERE ${renderExpression(statement.where)}`;
    return `${statement.target.name}${statement.alias === null ? "" : ` AS ${statement.alias}`} SET ${assignments}${where}`;
  };
  assert.equal(update("UPDATE t SET a = a + 1, b = DEFAULT, c = NULL WHERE id = ?"),
    "T SET A=(+ A 1), B=DEFAULT, C=NULL WHERE (= ID ?1)");
  assert.equal(update("UPDATE app.t x SET a = (SELECT MAX(b) FROM u WHERE u.id = x.id)"),
    "T AS X SET A={SELECT (MAX B) FROM U WHERE (= U.ID X.ID)}");
  assert.equal(update("UPDATE t AS x SET a = 1 WHERE x.b IN (1, 2)"), "T AS X SET A=1 WHERE (IN X.B 1 2)");
  assertSyntaxError("UPDATE t", { line: 1, column: 9 });
  assertSyntaxError("UPDATE t SET", { line: 1, column: 13 });
  assertSyntaxError("UPDATE t SET a", { line: 1, column: 15 });
  assertSyntaxError("UPDATE t SET a = ", { line: 1, column: 18 });
  assertSyntaxError("UPDATE t SET a = 1,");
  assertSyntaxError("UPDATE t SET t.a = 1", { line: 1, column: 15 }, /must not be qualified/);
  assertSyntaxError("UPDATE t SET a = 1 WHERE");
  assertUnsupported("UPDATE t SET (a, b) = (1, 2)");
  assertUnsupported("UPDATE t SET a = 1 FROM u");
  assertUnsupported("UPDATE t SET a = 1 RETURNING a");
});

test("DELETE : FROM 은 생략할 수 있다", () => {
  assert.deepEqual(parse("DELETE FROM t"), { kind: "Delete", target: name("T"), alias: null, where: null });
  assert.deepEqual(parse("DELETE t"), parse("DELETE FROM t"));
  assert.deepEqual(parse("DELETE FROM app.t x WHERE x.id = 1"), {
    kind: "Delete",
    target: name("T", "APP"),
    alias: "X",
    where: {
      kind: "Binary",
      operator: "=",
      left: { kind: "Column", qualifier: ["X"], name: "ID" },
      right: { kind: "Literal", type: "INTEGER", text: "1" },
    },
  });
  assert.deepEqual(parse("DELETE t WHERE id = 1"), parse("DELETE FROM t WHERE id = 1"));
  assertSyntaxError("DELETE", { line: 1, column: 7 });
  assertSyntaxError("DELETE FROM", { line: 1, column: 12 });
  assertSyntaxError("DELETE FROM t WHERE");
  assertSyntaxError("DELETE * FROM t");
  assertUnsupported("DELETE FROM t USING u WHERE t.id = u.id");
  assertUnsupported("DELETE FROM t WHERE id = 1 RETURNING *");
});

test("테이블스페이스 문장", () => {
  assert.deepEqual(parse("CREATE TABLESPACE app"), { kind: "CreateTablespace", name: "APP", dataFile: null, characterSet: null });
  assert.deepEqual(parse("CREATE TABLESPACE app DATAFILE 'D:\\data\\app.hwdb' CHARACTER SET UTF8"), {
    kind: "CreateTablespace", name: "APP", dataFile: "D:\\data\\app.hwdb", characterSet: "UTF8",
  });
  assert.deepEqual(parse("CREATE TABLESPACE \"앱\" CHARACTER SET utf8 DATAFILE './a.hwdb'"), {
    kind: "CreateTablespace", name: "앱", dataFile: "./a.hwdb", characterSet: "UTF8",
  });
  // 지원하는 캐릭터셋인지는 실행할 때 본다.
  assert.equal((parse("CREATE TABLESPACE a CHARACTER SET 'euc-kr'") as ast.CreateTablespaceStatement).characterSet, "EUC-KR");
  assert.deepEqual(parse("DROP TABLESPACE app"), { kind: "DropTablespace", name: "APP", includingContents: false });
  assert.deepEqual(parse("DROP TABLESPACE app INCLUDING CONTENTS"), { kind: "DropTablespace", name: "APP", includingContents: true });
  assert.deepEqual(parse("DROP TABLESPACE app INCLUDING CONTENTS AND DATAFILES"), parse("DROP TABLESPACE app INCLUDING CONTENTS"));
  assertSyntaxError("CREATE TABLESPACE", { line: 1, column: 18 });
  assertSyntaxError("CREATE TABLESPACE a.b");
  assertSyntaxError("CREATE TABLESPACE app DATAFILE app.hwdb");
  assertSyntaxError("CREATE TABLESPACE app DATAFILE 'a' DATAFILE 'b'", { line: 1, column: 36 });
  assertSyntaxError("CREATE TABLESPACE app CHARACTER UTF8");
  assertSyntaxError("DROP TABLESPACE app INCLUDING");
  assertSyntaxError("DROP TABLESPACE app CASCADE");
  assertUnsupported("ALTER TABLESPACE app RENAME TO app2");
});

test("사용자 문장 : 비밀번호는 문자열 리터럴이며 대소문자를 그대로 둔다", () => {
  assert.deepEqual(parse("CREATE USER scott IDENTIFIED BY 'Tiger''s'"), {
    kind: "CreateUser", name: "SCOTT", password: "Tiger's", defaultTablespace: null,
  });
  assert.deepEqual(parse("CREATE USER \"Scott\" IDENTIFIED BY '' DEFAULT TABLESPACE app"), {
    kind: "CreateUser", name: "Scott", password: "", defaultTablespace: "APP",
  });
  assert.deepEqual(parse("ALTER USER SYSTEM IDENTIFIED BY '새 비밀번호'"), {
    kind: "AlterUser", name: "SYSTEM", password: "새 비밀번호", defaultTablespace: null,
  });
  assert.deepEqual(parse("ALTER USER scott DEFAULT TABLESPACE app"), {
    kind: "AlterUser", name: "SCOTT", password: null, defaultTablespace: "APP",
  });
  assert.deepEqual(parse("ALTER USER scott DEFAULT TABLESPACE app IDENTIFIED BY 'x'"), {
    kind: "AlterUser", name: "SCOTT", password: "x", defaultTablespace: "APP",
  });
  assert.deepEqual(parse("DROP USER scott"), { kind: "DropUser", name: "SCOTT", cascade: false });
  assert.deepEqual(parse("DROP USER scott CASCADE"), { kind: "DropUser", name: "SCOTT", cascade: true });
  assertSyntaxError("CREATE USER scott", { line: 1, column: 18 });
  assertSyntaxError("CREATE USER scott IDENTIFIED BY tiger", { line: 1, column: 33 }, /expected a password string/);
  assertSyntaxError("CREATE USER scott IDENTIFIED 'x'");
  assertSyntaxError("CREATE USER scott IDENTIFIED BY 'x' DEFAULT app");
  assertSyntaxError("ALTER USER scott", { line: 1, column: 17 }, /expected IDENTIFIED BY or DEFAULT TABLESPACE/);
  assertSyntaxError("ALTER USER scott IDENTIFIED BY 'a' IDENTIFIED BY 'b'");
  assertSyntaxError("DROP USER scott RESTRICT");
  assertUnsupported("CREATE ROLE manager");
});

test("GRANT, REVOKE : 테이블스페이스 수준과 객체 수준", () => {
  assert.deepEqual(parse("GRANT SELECT ON TABLESPACE app TO scott"), {
    kind: "Grant", privileges: ["SELECT"], target: { kind: "Tablespace", name: "APP" }, users: ["SCOTT"],
  });
  assert.deepEqual(parse("GRANT select, insert, update, delete, create, alter, drop ON TABLESPACE app TO a, b"), {
    kind: "Grant",
    privileges: ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP"],
    target: { kind: "Tablespace", name: "APP" },
    users: ["A", "B"],
  });
  assert.deepEqual(parse("GRANT ALL ON app.orders TO scott"), {
    kind: "Grant",
    privileges: "ALL",
    target: { kind: "Object", objectType: null, name: name("ORDERS", "APP") },
    users: ["SCOTT"],
  });
  assert.deepEqual(parse("GRANT ALL PRIVILEGES ON TABLE orders TO scott"), {
    kind: "Grant", privileges: "ALL", target: { kind: "Object", objectType: "TABLE", name: name("ORDERS") }, users: ["SCOTT"],
  });
  assert.deepEqual(parse("GRANT UPDATE ON VIEW app.view_sample1 TO scott"), {
    kind: "Grant",
    privileges: ["UPDATE"],
    target: { kind: "Object", objectType: "VIEW", name: name("VIEW_SAMPLE1", "APP") },
    users: ["SCOTT"],
  });
  assert.deepEqual(parse("REVOKE SELECT, UPDATE ON TABLESPACE app FROM scott, tiger"), {
    kind: "Revoke", privileges: ["SELECT", "UPDATE"], target: { kind: "Tablespace", name: "APP" }, users: ["SCOTT", "TIGER"],
  });
  assert.deepEqual(parse("REVOKE ALL ON orders FROM scott"), {
    kind: "Revoke", privileges: "ALL", target: { kind: "Object", objectType: null, name: name("ORDERS") }, users: ["SCOTT"],
  });
  // 종류를 뜻하는 단어가 객체 이름으로 쓰인 경우
  assert.deepEqual((parse("GRANT SELECT ON view TO scott") as ast.PrivilegeStatement).target,
    { kind: "Object", objectType: null, name: name("VIEW") });
  assert.deepEqual((parse("GRANT SELECT ON tablespace.t TO scott") as ast.PrivilegeStatement).target,
    { kind: "Object", objectType: null, name: name("T", "TABLESPACE") });
  assert.deepEqual((parse("GRANT SELECT ON TABLE tablespace TO scott") as ast.PrivilegeStatement).target,
    { kind: "Object", objectType: "TABLE", name: name("TABLESPACE") });

  assertSyntaxError("GRANT SELECT TO scott", { line: 1, column: 14 }, /expected ON/);
  assertSyntaxError("GRANT SELECT ON t", { line: 1, column: 18 });
  assertSyntaxError("GRANT SELECT ON t FROM scott", { line: 1, column: 19 });
  assertSyntaxError("REVOKE SELECT ON t TO scott", { line: 1, column: 20 });
  assertSyntaxError("GRANT ON t TO scott");
  assertSyntaxError("GRANT SELECT, ON t TO scott");
  assertSyntaxError("GRANT SELECT ON t TO");
  assertSyntaxError("GRANT ALL PRIVILEGES TO scott");
  assertUnsupported("GRANT SELECT ON t TO scott WITH GRANT OPTION");
  assertUnsupported("GRANT SELECT ON t TO PUBLIC");
  assertUnsupported("GRANT SELECT (a, b) ON t TO scott");
  assertUnsupported("GRANT REFERENCES ON t TO scott");
  assertUnsupported("GRANT EXECUTE ON t TO scott");
  assertUnsupported("REVOKE GRANT OPTION FOR SELECT ON t FROM scott");
  assertUnsupported("REVOKE SELECT ON t FROM scott CASCADE");
});

test("권한 그룹의 GRANT, REVOKE", () => {
  assert.deepEqual(parse("GRANT CONNECT TO SYSTEM"), { kind: "GrantGroup", groups: ["CONNECT"], users: ["SYSTEM"] });
  assert.deepEqual(parse("GRANT connect, officer, dba TO a, b"), {
    kind: "GrantGroup", groups: ["CONNECT", "OFFICER", "DBA"], users: ["A", "B"],
  });
  assert.deepEqual(parse("REVOKE DBA FROM scott"), { kind: "RevokeGroup", groups: ["DBA"], users: ["SCOTT"] });
  assertSyntaxError("GRANT CONNECT ON t TO scott");
  assertSyntaxError("GRANT CONNECT, SELECT ON t TO scott", { line: 1, column: 23 }, /cannot be mixed/);
  assertSyntaxError("GRANT DBA FROM scott");
  assertSyntaxError("REVOKE DBA TO scott");
  // 사용자 정의 권한 그룹은 지원하지 않는다.
  assertUnsupported("GRANT manager TO scott", { line: 1, column: 7 });
  assertUnsupported("GRANT DBA TO PUBLIC");
});

test("트랜잭션 문장", () => {
  assert.deepEqual(parse("BEGIN"), { kind: "Begin" });
  assert.deepEqual(parse("BEGIN WORK"), { kind: "Begin" });
  assert.deepEqual(parse("BEGIN TRANSACTION"), { kind: "Begin" });
  assert.deepEqual(parse("START TRANSACTION"), { kind: "Begin" });
  assert.deepEqual(parse("START TRANSACTION ISOLATION LEVEL READ COMMITTED"), { kind: "Begin" });
  assert.deepEqual(parse("COMMIT"), { kind: "Commit" });
  assert.deepEqual(parse("COMMIT WORK;"), { kind: "Commit" });
  assert.deepEqual(parse("ROLLBACK"), { kind: "Rollback", savepoint: null });
  assert.deepEqual(parse("ROLLBACK WORK"), { kind: "Rollback", savepoint: null });
  assert.deepEqual(parse("SAVEPOINT sp1"), { kind: "Savepoint", name: "SP1" });
  // ROLLBACK TO 와 RELEASE 의 SAVEPOINT 는 생략할 수 있다.
  assert.deepEqual(parse("ROLLBACK TO SAVEPOINT sp1"), { kind: "Rollback", savepoint: "SP1" });
  assert.deepEqual(parse("ROLLBACK TO sp1"), { kind: "Rollback", savepoint: "SP1" });
  assert.deepEqual(parse("ROLLBACK WORK TO SAVEPOINT \"Sp 1\""), { kind: "Rollback", savepoint: "Sp 1" });
  assert.deepEqual(parse("RELEASE SAVEPOINT sp1"), { kind: "ReleaseSavepoint", name: "SP1" });
  assert.deepEqual(parse("RELEASE sp1"), { kind: "ReleaseSavepoint", name: "SP1" });
  // 세이브포인트 이름이 SAVEPOINT 인 경우
  assert.deepEqual(parse("SAVEPOINT savepoint"), { kind: "Savepoint", name: "SAVEPOINT" });
  assert.deepEqual(parse("ROLLBACK TO savepoint"), { kind: "Rollback", savepoint: "SAVEPOINT" });
  assert.deepEqual(parse("RELEASE SAVEPOINT savepoint"), { kind: "ReleaseSavepoint", name: "SAVEPOINT" });
  assertSyntaxError("START", { line: 1, column: 6 });
  assertSyntaxError("SAVEPOINT", { line: 1, column: 10 });
  assertSyntaxError("ROLLBACK TO", { line: 1, column: 12 });
  assertSyntaxError("RELEASE");
  assertSyntaxError("COMMIT now");
  assertSyntaxError("BEGIN SELECT 1");
  assertUnsupported("START TRANSACTION ISOLATION LEVEL SERIALIZABLE", { line: 1, column: 35 });
  assertUnsupported("START TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  assertUnsupported("START TRANSACTION ISOLATION LEVEL READ UNCOMMITTED");
  assertUnsupported("START TRANSACTION READ ONLY");
  assertUnsupported("COMMIT AND CHAIN");
  assertUnsupported("ROLLBACK AND NO CHAIN");
});

test("세션 문장 : USE, SET AUTOCOMMIT, SET TIME ZONE, SET TRANSACTION", () => {
  assert.deepEqual(parse("USE app"), { kind: "Use", tablespace: "APP" });
  assert.deepEqual(parse('USE "My Space"'), { kind: "Use", tablespace: "My Space" });
  assertSyntaxError("USE", { line: 1, column: 4 });
  assertSyntaxError("USE a.b");
  assertSyntaxError("USE 'app'");

  for (const on of ["ON", "on", "= ON", "TO ON", "TRUE", "1", "= 1"]) {
    assert.deepEqual(parse(`SET AUTOCOMMIT ${on}`), { kind: "SetAutocommit", value: true }, on);
  }
  for (const off of ["OFF", "off", "= OFF", "FALSE", "0"]) {
    assert.deepEqual(parse(`SET AUTOCOMMIT ${off}`), { kind: "SetAutocommit", value: false }, off);
  }
  assertSyntaxError("SET AUTOCOMMIT", { line: 1, column: 15 }, /expected ON or OFF/);
  assertSyntaxError("SET AUTOCOMMIT YES");
  assertSyntaxError("SET AUTOCOMMIT 2");

  assert.deepEqual(parse("SET TIME ZONE 'Asia/Seoul'"), { kind: "SetTimeZone", zone: "Asia/Seoul" });
  assert.deepEqual(parse("SET TIME ZONE '+09:00'"), { kind: "SetTimeZone", zone: "+09:00" });
  assert.deepEqual(parse("SET TIME ZONE LOCAL"), { kind: "SetTimeZone", zone: "local" });
  assert.deepEqual(parse("SET TIME ZONE INTERVAL '+09:00' HOUR TO MINUTE"), { kind: "SetTimeZone", zone: "+09:00" });
  assert.deepEqual(parse("SET TIME ZONE INTERVAL '9:00' HOUR TO MINUTE"), { kind: "SetTimeZone", zone: "+09:00" });
  assert.deepEqual(parse("SET TIME ZONE INTERVAL -'05:30' HOUR TO MINUTE"), { kind: "SetTimeZone", zone: "-05:30" });
  assertSyntaxError("SET TIME ZONE", { line: 1, column: 14 });
  assertSyntaxError("SET TIME ZONE Asia");
  assertSyntaxError("SET TIME ZONE 9");
  assertSyntaxError("SET TIME ZONE INTERVAL '9' HOUR");
  assertSyntaxError("SET TIME 'x'");

  assert.deepEqual(parse("SET TRANSACTION ISOLATION LEVEL READ COMMITTED"), { kind: "SetTransaction", isolationLevel: "READ COMMITTED" });
  assertUnsupported("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
  assertUnsupported("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  assertUnsupported("SET TRANSACTION READ ONLY");
  assertSyntaxError("SET TRANSACTION");
  assertSyntaxError("SET", { line: 1, column: 4 }, /expected AUTOCOMMIT, TIME ZONE or TRANSACTION/);
  assertSyntaxError("SET x = 1");
  assertUnsupported("SET ROLE manager");
  assertUnsupported("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED");
});

test("한 번에 문장 하나만 받는다. 빈 문장은 오류이다", () => {
  assert.deepEqual(parse("COMMIT;"), { kind: "Commit" });
  assert.deepEqual(parse("COMMIT ; -- 주석"), { kind: "Commit" });
  assertSyntaxError("SELECT 1; SELECT 2", { line: 1, column: 11 }, /Only one statement/);
  assertSyntaxError("COMMIT;;", { line: 1, column: 8 });
  assertSyntaxError("COMMIT; ROLLBACK;");
  for (const empty of ["", "   ", ";", " ; ", "-- 주석만", "/* 주석만 */", "\n\n"]) {
    assertSyntaxError(empty, undefined, /Empty statement/);
  }
  assertSyntaxError(";;", { line: 1, column: 1 });
});

test("문장의 첫 단어가 틀리면 문법 오류, 지원하지 않는 문장이면 0A000 이다", () => {
  assertSyntaxError("SELEC 1", { line: 1, column: 1 }, /Unexpected "SELEC"; expected a statement/);
  assertSyntaxError("FROM t SELECT 1", { line: 1, column: 1 });
  assertSyntaxError("1 + 1", { line: 1, column: 1 });
  assertSyntaxError("'SELECT 1'", { line: 1, column: 1 });
  assertSyntaxError('"SELECT" 1', { line: 1, column: 1 });
  assertSyntaxError("CREATE", { line: 1, column: 7 }, /expected TABLE, VIEW, INDEX, TABLESPACE or USER/);
  assertSyntaxError("CREATE thing x");
  assertSyntaxError("DROP", { line: 1, column: 5 });
  assertSyntaxError("ALTER x");
  // 상세 12, 16 에서 초기 버전에 넣지 않기로 한 것
  for (const sql of [
    "MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET a = 1",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "CREATE SEQUENCE seq", "DROP SEQUENCE seq", "ALTER SEQUENCE seq RESTART",
    "CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW BEGIN END",
    "CREATE PROCEDURE p() BEGIN END", "CREATE OR REPLACE FUNCTION f() RETURNS INT", "CALL p()",
    "CREATE SYNONYM s FOR t", "CREATE PUBLIC SYNONYM s FOR t",
    "CREATE MATERIALIZED VIEW mv AS SELECT 1", "DROP MATERIALIZED VIEW mv",
    "CREATE GLOBAL TEMPORARY TABLE t (a INT)", "CREATE SCHEMA s", "CREATE DATABASE d", "CREATE ROLE r", "DROP ROLE r",
    "BACKUP DATABASE", "RESTORE DATABASE", "EXPORT TABLE t", "IMPORT TABLE t",
    "EXPLAIN SELECT 1", "LOCK TABLE t IN EXCLUSIVE MODE", "COMMENT ON TABLE t IS 'x'", "RENAME t TO u",
    "ALTER SESSION SET x = 1", "ALTER INDEX ix RENAME TO iy", "ALTER VIEW v RENAME TO w",
  ]) {
    assertUnsupported(sql, { line: 1, column: unsupportedColumn(sql) });
  }
});

test("예약어는 큰따옴표로 감싸야 식별자로 쓸 수 있다", () => {
  for (const word of RESERVED_WORDS) {
    assertSyntaxError(`SELECT 1 FROM ${word}`);
    assertSyntaxError(`CREATE TABLE ${word} (A INT)`);
    // UNIQUE 와 CHECK 는 컬럼 자리에서 제약조건으로 읽히며, 지원하지 않는 제약조건이다.
    if (word === "UNIQUE" || word === "CHECK") assertUnsupported(`CREATE TABLE T (${word} INT)`);
    else assertSyntaxError(`CREATE TABLE T (${word} INT)`);
    assert.deepEqual((parse(`CREATE TABLE "${word}" ("${word}" INT)`) as ast.CreateTableStatement).name, name(word));
    assert.deepEqual(parse(`SELECT "${word}" FROM "${word}" "${word}"`), parse(`SELECT "${word}" FROM "${word}" AS "${word}"`));
  }
  // 따옴표로 감싼 이름은 대소문자를 보존하며 키워드로 보지 않는다.
  assert.deepEqual((parse('SELECT 1 FROM "select"') as ast.Query).body, {
    kind: "Select",
    distinct: false,
    items: [{ kind: "Expression", expression: { kind: "Literal", type: "INTEGER", text: "1" }, alias: null }],
    from: [{ kind: "Table", name: name("select"), alias: null }],
    where: null,
    groupBy: [],
    having: null,
  });
  assertSyntaxError('"SELECT" 1');
  assert.equal(RESERVED_WORDS.has("MESSAGE"), false);
  assert.equal(RESERVED_WORDS.has("HELLO"), false);
});

test("예약어가 아닌 키워드는 이름으로 쓸 수 있다", () => {
  const words = [
    "DATE", "TIME", "TIMESTAMP", "INTERVAL", "YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND", "ZONE", "KEY", "INDEX",
    "VIEW", "TABLESPACE", "USER", "COLUMN", "ADD", "RENAME", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE",
    "START", "TRANSACTION", "WORK", "USE", "TRUNCATE", "FIRST", "NEXT", "ROW", "ROWS", "ONLY", "NULLS", "LAST",
    "IF", "REPLACE", "CASCADE", "RESTRICT", "ACTION", "NO", "DATAFILE", "CHARACTER", "INCLUDING", "CONTENTS",
    "IDENTIFIED", "PRIVILEGES", "CONNECT", "OFFICER", "DBA", "AUTOCOMMIT", "LOCAL", "COUNT", "SUM", "TRIM", "SUBSTRING",
    "POSITION", "EXTRACT", "UNKNOWN", "VALUE", "NAME", "TYPE", "DATA", "MESSAGE", "LEVEL", "READ", "OVER", "WINDOW",
    "VARCHAR", "INTEGER", "INT", "DECIMAL", "BOOLEAN", "CHAR", "BINARY",
  ];
  for (const word of words) {
    assert.equal(RESERVED_WORDS.has(word), false, word);
    const created = parse(`CREATE TABLE ${word} (${word} INT)`) as ast.CreateTableStatement;
    assert.deepEqual(created.name, name(word), word);
    assert.equal(created.columns[0]?.name, word, word);
    const selected = parse(`SELECT ${word}, t.${word} FROM ${word} t WHERE ${word} = 1`) as ast.Query;
    const body = selected.body as ast.Select;
    assert.deepEqual(body.items[0], { kind: "Expression", expression: { kind: "Column", qualifier: [], name: word }, alias: null }, word);
    assert.deepEqual(body.from, [{ kind: "Table", name: name(word), alias: "T" }], word);
  }
});

test("오류에는 SQLSTATE 와 위치가 담기고, 타입 인자 오류도 위치를 가진다", () => {
  assertSqlStateAt("CREATE TABLE t (a VARCHAR(70000))", "22023", { line: 1, column: 19 });
  assertSqlStateAt("CREATE TABLE t (\n  a INT,\n  b DECIMAL(40)\n)", "22023", { line: 3, column: 5 });
  assertSqlStateAt(`SELECT ${"A".repeat(129)}`, "42622", { line: 1, column: 8 });
  assertUnsupported("CREATE TABLE t (\n  a INT,\n  b CLOB\n)", { line: 3, column: 5 }, /Unsupported data type: CLOB \(line 3, column 5\)\.$/);
});

test("문서의 예약어 목록은 구문 분석기의 예약어와 같다", () => {
  // docs/sql-syntax.md 는 드라이버와 DB툴이 기준으로 삼는 문서이므로 코드와 어긋나면 안 된다.
  const document = fs.readFileSync(fileURLToPath(new URL("../../../docs/sql-syntax.md", import.meta.url)), "utf8");
  const block = /## 예약어[\s\S]*?```\r?\n([\s\S]*?)```/.exec(document);
  assert.ok(block !== null, "reserved word list not found in docs/sql-syntax.md");
  const listed = (block[1] as string).split(/\s+/).filter((word) => word.length > 0);
  assert.deepEqual([...listed].sort(), [...RESERVED_WORDS].sort());
  assert.equal(new Set(listed).size, listed.length, "duplicated word in the document");
});
