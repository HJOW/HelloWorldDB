/**
 * 트랜잭션 시험 (12-3, 12-5) : 자동 커밋, 시작, 커밋, 롤백, 세이브포인트, 잠금 대기, 교착, 접속 끊김.
 * 실제 rdbms 를 띄워 TCP 와 UDP 로 수행한다.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Connection, DbError, connect } from "../src/index.js";
import type { ConnectOptions } from "../src/index.js";
import { TestServer } from "./helpers/server.js";

const server = await TestServer.start({ after: (fn) => after(fn) }, { transaction: { lockTimeoutMs: 1500 } });
const ADMIN = { user: "SYSTEM", password: "HelloWorldDB" } as const;

function open(extra: Partial<ConnectOptions> = {}): Promise<Connection> {
  return connect({ port: server.port, ...ADMIN, ...extra });
}

async function failure(promise: Promise<unknown>): Promise<DbError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DbError, `DbError 여야 한다: ${String(error)}`);
    return error;
  }
  throw new Error("실패해야 한다.");
}

async function count(db: Connection, table: string): Promise<bigint> {
  return (await db.query(`SELECT COUNT(*) FROM ${table}`)).rows[0]?.[0] as bigint;
}

test("자동 커밋이 기본이다. BEGIN 으로 시작한 트랜잭션은 COMMIT 전까지 다른 접속에 보이지 않는다 (TCP 와 UDP)", async () => {
  const setup = await open();
  await setup.query("CREATE TABLE ND_TX1 (ID INTEGER PRIMARY KEY, V VARCHAR(10))");
  assert.equal(setup.autoCommit, true);
  for (const protocol of ["tcp", "udp"] as const) {
    const a = await open({ protocol });
    const b = await open({ protocol });
    const base = protocol === "tcp" ? 0 : 100;
    await a.query("INSERT INTO ND_TX1 VALUES (?, 'auto')", [base + 1]); // 자동 커밋
    assert.equal(a.inTransaction, false);
    assert.equal(await count(b, `ND_TX1 WHERE ID = ${base + 1}`), 1n, `${protocol} : 자동 커밋은 바로 보인다`);

    await a.begin();
    assert.equal(a.inTransaction, true);
    await a.query("INSERT INTO ND_TX1 VALUES (?, 'tx')", [base + 2]);
    assert.equal(await count(a, `ND_TX1 WHERE ID = ${base + 2}`), 1n, "자기 변경은 자기에게 보인다");
    assert.equal(await count(b, `ND_TX1 WHERE ID = ${base + 2}`), 0n, "커밋 전에는 다른 접속에 보이지 않는다");
    await a.commit();
    assert.equal(a.inTransaction, false);
    assert.equal(await count(b, `ND_TX1 WHERE ID = ${base + 2}`), 1n, "커밋하면 보인다 (READ COMMITTED)");

    await a.begin();
    await a.query("INSERT INTO ND_TX1 VALUES (?, 'gone')", [base + 3]);
    await a.rollback();
    assert.equal(await count(b, `ND_TX1 WHERE ID = ${base + 3}`), 0n, "롤백한 변경은 없다");
    assert.equal(await count(a, `ND_TX1 WHERE ID = ${base + 3}`), 0n);
    await a.close();
    await b.close();
  }
  await setup.close();
});

test("문장이 실패해도 그 문장만 되돌리고 트랜잭션은 유지된다", async () => {
  const a = await open();
  const b = await open();
  await a.query("CREATE TABLE ND_TX2 (ID INTEGER PRIMARY KEY)");
  await a.begin();
  await a.query("INSERT INTO ND_TX2 VALUES (1)");
  assert.equal((await failure(a.query("INSERT INTO ND_TX2 VALUES (1)"))).sqlState, "23505");
  await a.query("INSERT INTO ND_TX2 VALUES (2)");
  assert.equal(a.inTransaction, true);
  await a.commit();
  assert.deepEqual((await b.query("SELECT ID FROM ND_TX2 ORDER BY ID")).rows, [[1], [2]]);
  await a.close();
  await b.close();
});

test("세이브포인트 : ROLLBACK TO 는 그 이후의 변경만 되돌린다", async () => {
  const a = await open();
  await a.query("CREATE TABLE ND_TX3 (ID INTEGER PRIMARY KEY)");
  await a.begin();
  await a.query("INSERT INTO ND_TX3 VALUES (1)");
  await a.query("SAVEPOINT S1");
  await a.query("INSERT INTO ND_TX3 VALUES (2)");
  await a.query("ROLLBACK TO SAVEPOINT S1");
  assert.equal(a.inTransaction, true, "ROLLBACK TO 는 트랜잭션을 끝내지 않는다");
  await a.query("INSERT INTO ND_TX3 VALUES (3)");
  await a.commit();
  assert.deepEqual((await a.query("SELECT ID FROM ND_TX3 ORDER BY ID")).rows, [[1], [3]]);
  await a.close();
});

test("자동 커밋을 끄면 첫 문장에서 트랜잭션이 시작되고 COMMIT·ROLLBACK 으로 끝난다", async () => {
  const a = await open();
  const b = await open();
  await a.query("CREATE TABLE ND_TX4 (ID INTEGER PRIMARY KEY)");
  await a.setAutoCommit(false);
  assert.equal(a.autoCommit, false);
  assert.equal(a.inTransaction, false);
  await a.query("INSERT INTO ND_TX4 VALUES (1)");
  assert.equal(a.inTransaction, true, "첫 문장에서 시작된다");
  assert.equal(await count(b, "ND_TX4"), 0n);
  await a.commit();
  assert.equal(await count(b, "ND_TX4"), 1n);
  await a.query("INSERT INTO ND_TX4 VALUES (2)");
  await a.rollback();
  assert.equal(await count(a, "ND_TX4"), 1n);
  await a.setAutoCommit(true);
  assert.equal(a.autoCommit, true);
  await a.query("INSERT INTO ND_TX4 VALUES (3)");
  assert.equal(await count(b, "ND_TX4"), 2n, "다시 자동 커밋");
  // SQL 로 직접 바꿔도 상태를 따라간다.
  await a.query("set autocommit off");
  assert.equal(a.autoCommit, false);
  await a.query("-- 주석 뒤\n SET AUTOCOMMIT ON;");
  assert.equal(a.autoCommit, true);
  await a.close();
  await b.close();
});

test("transaction(fn) : 끝나면 커밋하고 값을 돌려주며, 예외를 던지면 롤백하고 그 예외를 다시 던진다", async () => {
  const a = await open();
  const b = await open();
  await a.query("CREATE TABLE ND_TX5 (ID INTEGER PRIMARY KEY, V INTEGER)");
  const value = await a.transaction(async (tx) => {
    assert.equal(tx, a);
    await tx.query("INSERT INTO ND_TX5 VALUES (1, 10)");
    await tx.query("INSERT INTO ND_TX5 VALUES (2, 20)");
    return "done";
  });
  assert.equal(value, "done");
  assert.equal(await count(b, "ND_TX5"), 2n);
  assert.equal(a.inTransaction, false);

  const boom = new Error("boom");
  await assert.rejects(
    a.transaction(async (tx) => {
      await tx.query("UPDATE ND_TX5 SET V = V + 1");
      await tx.query("INSERT INTO ND_TX5 VALUES (3, 30)");
      throw boom;
    }),
    (error: unknown) => error === boom,
  );
  assert.equal(a.inTransaction, false);
  assert.deepEqual((await b.query("SELECT V FROM ND_TX5 ORDER BY ID")).rows, [[10], [20]], "롤백되어 원래 값이다");

  // 문장 오류도 예외로 롤백한다.
  await assert.rejects(
    a.transaction(async (tx) => {
      await tx.query("DELETE FROM ND_TX5 WHERE ID = 1");
      await tx.query("INSERT INTO ND_TX5 VALUES (2, 99)"); // PK 중복
    }),
    (error: unknown) => error instanceof DbError && error.sqlState === "23505",
  );
  assert.equal(await count(b, "ND_TX5"), 2n);

  // 자동 커밋이 꺼져 있으면 BEGIN 없이 같은 규칙으로 커밋·롤백한다.
  await a.setAutoCommit(false);
  await a.transaction(async (tx) => {
    await tx.query("INSERT INTO ND_TX5 VALUES (4, 40)");
  });
  assert.equal(await count(b, "ND_TX5"), 3n, "커밋되었다");
  await assert.rejects(
    a.transaction(async (tx) => {
      await tx.query("INSERT INTO ND_TX5 VALUES (5, 50)");
      throw boom;
    }),
    boom,
  );
  assert.equal(await count(b, "ND_TX5"), 3n, "롤백되었다");
  await a.close();
  await b.close();
});

test("DDL, GRANT 는 실행 전후에 자동으로 커밋된다", async () => {
  const a = await open();
  const b = await open();
  await a.query("CREATE TABLE ND_TX6 (ID INTEGER PRIMARY KEY)");
  await a.begin();
  await a.query("INSERT INTO ND_TX6 VALUES (1)");
  await a.query("CREATE TABLE ND_TX6B (ID INTEGER)");
  assert.equal(a.inTransaction, false, "DDL 이 앞선 변경을 커밋했다");
  assert.equal(await count(b, "ND_TX6"), 1n);
  await a.rollback(); // 이미 끝난 트랜잭션을 롤백해도 되돌릴 것이 없다.
  assert.equal(await count(b, "ND_TX6"), 1n);
  await a.close();
  await b.close();
});

test("같은 행을 바꾸려는 트랜잭션은 잠금으로 순서가 정해지고, 오래 기다리면 55P03 이다", async () => {
  const a = await open();
  const b = await open();
  await a.query("CREATE TABLE ND_TX7 (ID INTEGER PRIMARY KEY, V INTEGER)");
  await a.query("INSERT INTO ND_TX7 VALUES (1, 0), (2, 0)");
  await a.begin();
  await a.query("UPDATE ND_TX7 SET V = 1 WHERE ID = 1");
  // 다른 행은 기다리지 않는다.
  await b.query("UPDATE ND_TX7 SET V = 5 WHERE ID = 2");
  // 같은 행은 a 가 끝날 때까지 기다린다. a 가 커밋하면 이어서 실행된다.
  const waiting = b.query("UPDATE ND_TX7 SET V = V + 10 WHERE ID = 1");
  let settled = false;
  void waiting.then(() => (settled = true), () => (settled = true));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(settled, false, "a 의 잠금이 풀릴 때까지 기다린다");
  await a.commit();
  await waiting;
  assert.deepEqual((await a.query("SELECT ID, V FROM ND_TX7 ORDER BY ID")).rows, [[1, 11], [2, 5]]);

  // 잠금 대기 제한(이 서버는 1.5초)을 넘으면 그 문장만 55P03 으로 끝난다.
  await a.begin();
  await a.query("UPDATE ND_TX7 SET V = 0 WHERE ID = 1");
  const started = Date.now();
  const timeout = await failure(b.query("UPDATE ND_TX7 SET V = 99 WHERE ID = 1"));
  assert.equal(timeout.sqlState, "55P03");
  assert.ok(Date.now() - started >= 1000, `제한 시간 가까이 기다렸다 (${Date.now() - started} ms)`);
  assert.equal(b.isClosed, false, "접속은 그대로이다");
  await a.rollback();
  await b.query("UPDATE ND_TX7 SET V = 99 WHERE ID = 1");
  await a.close();
  await b.close();
});

test("교착 상태를 서버가 감지하면 한쪽은 40P01 로 롤백되고 다른 쪽은 계속된다. transaction() 이 롤백을 마친다", async () => {
  const a = await open();
  const b = await open();
  await a.query("CREATE TABLE ND_TX8 (ID INTEGER PRIMARY KEY, V INTEGER)");
  await a.query("INSERT INTO ND_TX8 VALUES (1, 0), (2, 0)");
  const gate = (): { wait: Promise<void>; open: () => void } => {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => (open = resolve));
    return { wait, open };
  };
  const aLocked = gate();
  const bLocked = gate();
  const settle = async (db: Connection, first: number, second: number, mine: ReturnType<typeof gate>, theirs: ReturnType<typeof gate>): Promise<string> => {
    try {
      await db.transaction(async (tx) => {
        await tx.query("UPDATE ND_TX8 SET V = V + 1 WHERE ID = ?", [first]);
        mine.open();
        await theirs.wait;
        await tx.query("UPDATE ND_TX8 SET V = V + 1 WHERE ID = ?", [second]);
      });
      return "committed";
    } catch (error) {
      assert.ok(error instanceof DbError);
      return error.sqlState;
    }
  };
  const results = await Promise.all([settle(a, 1, 2, aLocked, bLocked), settle(b, 2, 1, bLocked, aLocked)]);
  assert.deepEqual([...results].sort(), ["40P01", "committed"], `한쪽만 교착으로 롤백된다: ${results.join(", ")}`);
  assert.equal(a.inTransaction || b.inTransaction, false);
  // 이긴 쪽만 반영되었다.
  assert.deepEqual((await a.query("SELECT V FROM ND_TX8 ORDER BY ID")).rows, [[1], [1]]);
  await a.close();
  await b.close();
});

test("접속이 끊기면 커밋하지 않은 변경은 롤백되고 잠금이 풀린다", async () => {
  const a = await open();
  const b = await open();
  await a.query("CREATE TABLE ND_TX9 (ID INTEGER PRIMARY KEY, V INTEGER)");
  await a.query("INSERT INTO ND_TX9 VALUES (1, 0)");
  await a.begin();
  await a.query("UPDATE ND_TX9 SET V = 1 WHERE ID = 1");
  a.destroy(); // 응답도 없이 끊긴다.
  // 서버가 접속이 끊긴 것을 알아차리면 잠금이 풀려 b 가 기다리지 않고 바꿀 수 있다. (잠금 대기 제한 1.5초 안에 끝난다)
  await b.query("UPDATE ND_TX9 SET V = 7 WHERE ID = 1");
  assert.deepEqual((await b.query("SELECT V FROM ND_TX9")).rows, [[7]], "끊긴 접속의 변경은 없다");
  await b.close();
});
