/** 일반 객체의 프로토타입 속성과 같은 SQL 식별자의 회귀 시험이다. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Database } from "../../src/session/session.js";
import { selectStrings, state, tempDir } from "../exec/helpers.js";

const names = ["__proto__", "constructor", "toString", "hasOwnProperty"];

test("없는 프로토타입 이름의 ALTER USER는 실패하고 전역 객체를 바꾸지 않는다", (t) => {
  const db = Database.open(tempDir(t), { scramIterations: 1000 });
  t.after(() => db.close());
  const admin = db.createSession({});
  const beforeObject = Object.getOwnPropertyDescriptors(Object);
  const beforePrototype = Object.getOwnPropertyDescriptors(Object.prototype);
  for (const name of names) {
    assert.throws(() => admin.execute(`ALTER USER "${name}" IDENTIFIED BY 'pw'`), state("42704"));
    assert.throws(() => admin.execute(`ALTER USER "${name}" DEFAULT TABLESPACE SYSTEM`), state("42704"));
  }
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object), beforeObject);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), beforePrototype);
});

test("없는 프로토타입 이름은 객체나 사용자로 해석하지 않는다", (t) => {
  const db = Database.open(tempDir(t), { scramIterations: 1000 });
  t.after(() => db.close());
  const admin = db.createSession({});
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    assert.equal(db.users.has(name), false, name);
    assert.equal(db.users.get(name), undefined, name);
    assert.equal(db.users.verifierOf(name), undefined, name);
    assert.deepEqual(db.access.groupsOf(name), [], name);
    assert.equal(db.access.isDba(name), false, name);
    assert.throws(() => db.login(name, "wrong"), state("28000"), name);
    assert.throws(() => admin.execute(`SELECT * FROM "${name}"`), state("42P01"), name);
    assert.throws(() => admin.execute(`DROP VIEW "${name}"`), state("42P01"), name);
    assert.throws(() => admin.execute(`ALTER USER "${name}" IDENTIFIED BY 'pw'`), state("42704"), name);
    assert.throws(() => admin.execute(`ALTER USER "${name}" DEFAULT TABLESPACE SYSTEM`), state("42704"), name);
  }
  assert.equal(Object.hasOwn(Object, "verifier"), false);
  assert.equal(Object.hasOwn(Object, "defaultTablespace"), false);
});

for (const name of names) {
  test(`식별자 "${name}"의 테이블·뷰·인덱스·제약조건은 재구동 뒤에도 동작한다`, (t) => {
    const dir = tempDir(t);
    let db = Database.open(dir, { scramIterations: 1000 });
    t.after(() => db.close());
    let admin = db.createSession({});
    admin.execute(`CREATE TABLE "${name}" ("${name}" INTEGER, CONSTRAINT "${name}" PRIMARY KEY ("${name}"))`);
    admin.execute(`INSERT INTO "${name}" VALUES (1)`);
    assert.throws(() => admin.execute(`INSERT INTO "${name}" VALUES (1)`), state("23505"));
    db.close();
    db = Database.open(dir, { scramIterations: 1000 });
    admin = db.createSession({});
    assert.deepEqual(selectStrings(admin.execute(`SELECT * FROM "${name}" WHERE "${name}" = 1`)).rows, [["1"]]);
    admin.execute(`UPDATE "${name}" SET "${name}" = 2`);
    admin.execute(`ALTER TABLE "${name}" DROP CONSTRAINT "${name}"`);
    admin.execute(`CREATE INDEX "${name}" ON "${name}" ("${name}" DESC)`);
    admin.execute(`ALTER TABLE "${name}" RENAME TO BASE`);
    admin.execute(`CREATE VIEW "${name}" AS SELECT * FROM BASE`);
    admin.execute(`CREATE OR REPLACE VIEW "${name}" AS SELECT * FROM BASE`);
    db.close();
    db = Database.open(dir, { scramIterations: 1000 });
    admin = db.createSession({});
    admin.execute(`UPDATE "${name}" SET "${name}" = 3`);
    assert.deepEqual(selectStrings(admin.execute(`SELECT * FROM "${name}"`)).rows, [["3"]]);
    admin.execute(`DROP VIEW "${name}"`);
    admin.execute(`DROP INDEX "${name}"`);
    admin.execute(`DELETE FROM BASE`);
    admin.execute(`DROP TABLE BASE`);
    assert.throws(() => admin.execute(`SELECT * FROM "${name}"`), state("42P01"));
  });
}

test('"__proto__" 테이블스페이스와 기본 테이블스페이스의 데이터가 재구동 뒤에도 남는다', (t) => {
  const dir = tempDir(t);
  let db = Database.open(dir, { scramIterations: 1000 });
  t.after(() => db.close());
  const admin = db.createSession({});
  admin.execute('CREATE TABLESPACE "__proto__"');
  admin.execute('CREATE TABLE "__proto__".T (ID INTEGER PRIMARY KEY)');
  admin.execute('INSERT INTO "__proto__".T VALUES (7)');
  admin.execute("CREATE USER READER IDENTIFIED BY 'pw' DEFAULT TABLESPACE \"__proto__\"");
  admin.execute('GRANT SELECT ON "__proto__".T TO READER');
  db.close();
  db = Database.open(dir, { scramIterations: 1000 });
  const reader = db.login("READER", "pw");
  assert.deepEqual(selectStrings(reader.execute("SELECT * FROM T")).rows, [["7"]]);
  assert.ok(selectStrings(db.createSession({}).execute("SELECT TABLESPACE_NAME FROM SYS_TABLESPACES")).rows.some((row) => row[0] === "__proto__"));
  reader.close();
  db.createSession({}).execute('DROP TABLESPACE "__proto__" INCLUDING CONTENTS');
  assert.equal(db.users.require("READER").defaultTablespace, null);
});

test("프로토타입 이름의 계정은 그룹과 뷰 권한을 독립적으로 저장하고 회수한다", (t) => {
  const dir = tempDir(t);
  let db = Database.open(dir, { scramIterations: 1000 });
  t.after(() => db.close());
  let admin = db.createSession({});
  admin.execute("CREATE TABLE BASE (ID INTEGER PRIMARY KEY)");
  admin.execute("INSERT INTO BASE VALUES (1)");
  admin.execute('CREATE VIEW "__proto__" AS SELECT * FROM BASE');
  for (const name of names) {
    admin.execute(`CREATE USER "${name}" IDENTIFIED BY 'pw' DEFAULT TABLESPACE SYSTEM`);
    admin.execute(`GRANT CONNECT TO "${name}"`);
    admin.execute(`GRANT SELECT, UPDATE ON "__proto__" TO "${name}"`);
  }
  db.close();
  db = Database.open(dir, { scramIterations: 1000 });
  admin = db.createSession({});
  for (const name of names) {
    const user = db.login(name, "pw");
    assert.deepEqual(db.access.groupsOf(name), ["CONNECT"]);
    assert.throws(() => user.execute("SELECT * FROM BASE"), state("42501"));
    assert.deepEqual(selectStrings(user.execute('SELECT * FROM "__proto__"')).rows, [["1"]]);
    user.execute('UPDATE "__proto__" SET ID = 1');
    admin.execute(`REVOKE UPDATE ON "__proto__" FROM "${name}"`);
    assert.throws(() => user.execute('UPDATE "__proto__" SET ID = 2'), state("42501"));
    admin.execute(`REVOKE CONNECT FROM "${name}"`);
    assert.deepEqual(db.access.groupsOf(name), []);
    user.execute(`ALTER USER "${name}" IDENTIFIED BY 'new-pw'`);
    user.close();
    assert.throws(() => db.login(name, "pw"), state("28000"));
    db.login(name, "new-pw").close();
    admin.execute(`DROP USER "${name}"`);
    assert.equal(db.users.has(name), false);
  }
});
