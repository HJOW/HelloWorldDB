/** 따옴표 식별자에 구분자가 들어가도 객체의 정체성이 보존되는지 확인한다. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Database } from "../../src/session/session.js";
import { selectStrings, state, tempDir } from "../exec/helpers.js";

function setup(t: { after(fn: () => void): void }) {
  const db = Database.open(tempDir(t), { scramIterations: 1000 });
  t.after(() => db.close());
  const admin = db.createSession({});
  admin.execute("CREATE TABLESPACE A");
  admin.execute('CREATE TABLESPACE "A.B"');
  return { db, admin };
}

test("점이 든 한정 이름의 트랜잭션 변경·세이브포인트·커밋이 서로 섞이지 않는다", (t) => {
  const { db, admin } = setup(t);
  const first = 'A."B.C"';
  const second = '"A.B".C';
  for (const table of [first, second]) admin.execute(`CREATE TABLE ${table} (ID INTEGER PRIMARY KEY, V INTEGER)`);
  admin.execute(`INSERT INTO ${first} VALUES (1, 10)`);
  admin.execute(`INSERT INTO ${second} VALUES (1, 20)`);
  const other = db.createSession({});
  admin.execute("BEGIN");
  admin.execute(`UPDATE ${first} SET V = 11 WHERE ID = 1`);
  assert.deepEqual(selectStrings(admin.execute(`SELECT V FROM ${second}`)).rows, [["20"]]);
  admin.execute("SAVEPOINT S");
  admin.execute(`UPDATE ${second} SET V = 21 WHERE ID = 1`);
  admin.execute("ROLLBACK TO S");
  assert.deepEqual(selectStrings(admin.execute(`SELECT V FROM ${first}`)).rows, [["11"]]);
  assert.deepEqual(selectStrings(admin.execute(`SELECT V FROM ${second}`)).rows, [["20"]]);
  admin.execute(`UPDATE ${second} SET V = 22 WHERE ID = 1`);
  assert.deepEqual(selectStrings(other.execute(`SELECT V FROM ${first}`)).rows, [["10"]]);
  admin.execute("COMMIT");
  assert.deepEqual(selectStrings(other.execute(`SELECT V FROM ${first}`)).rows, [["11"]]);
  assert.deepEqual(selectStrings(other.execute(`SELECT V FROM ${second}`)).rows, [["22"]]);
});

test("점이 든 서로 다른 뷰를 순환 참조로 판정하지 않는다", (t) => {
  const { admin } = setup(t);
  admin.execute("CREATE TABLE A.BASE (ID INTEGER)");
  admin.execute("INSERT INTO A.BASE VALUES (7)");
  admin.execute('CREATE VIEW A."B.C" AS SELECT ID FROM A.BASE');
  admin.execute('CREATE VIEW "A.B".C AS SELECT ID FROM A."B.C"');
  assert.deepEqual(selectStrings(admin.execute('SELECT * FROM "A.B".C')).rows, [["7"]]);
  admin.execute('UPDATE "A.B".C SET ID = 8');
  assert.deepEqual(selectStrings(admin.execute("SELECT ID FROM A.BASE")).rows, [["8"]]);
});

test("점이 든 이름의 뷰 의존 객체를 모두 보존하고 DROP RESTRICT로 보호한다", (t) => {
  const { db, admin } = setup(t);
  admin.execute('CREATE TABLE A."B.C" (ID INTEGER)');
  admin.execute('CREATE TABLE "A.B".C (ID INTEGER)');
  admin.execute('CREATE VIEW A.V AS SELECT L.ID AS LID, R.ID AS RID FROM A."B.C" L CROSS JOIN "A.B".C R');
  assert.equal(db.manager.requireCatalog("A").data.views["V"]!.dependencies.length, 2);
  assert.throws(() => admin.execute('DROP TABLE A."B.C"'), state("55006"));
  assert.throws(() => admin.execute('DROP TABLE "A.B".C'), state("55006"));
});

test("뷰와 기반 객체의 한정 이름이 점 연결로 같아도 비소유자에게 GRANT를 허용하지 않는다", (t) => {
  const { db, admin } = setup(t);
  admin.execute('CREATE TABLE "A.B".C (ID INTEGER)');
  admin.execute("CREATE USER VIEW_OWNER IDENTIFIED BY 'pw'");
  admin.execute("CREATE USER READER IDENTIFIED BY 'pw'");
  admin.execute("GRANT CREATE ON TABLESPACE A TO VIEW_OWNER");
  admin.execute('GRANT SELECT ON "A.B".C TO VIEW_OWNER');
  const owner = db.login("VIEW_OWNER", "pw");
  owner.execute('CREATE VIEW A."B.C" AS SELECT ID FROM "A.B".C');
  assert.throws(() => owner.execute('GRANT SELECT ON A."B.C" TO READER'), state("42501"));
  const reader = db.login("READER", "pw");
  assert.throws(() => reader.execute('SELECT * FROM A."B.C"'), state("42501"));
});
