/**
 * 커넥션 풀 시험 (12-3, 12-5). 실제 rdbms 를 띄워 수행한다.
 */
import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { Connection, DbError, connect, createPool } from "../src/index.js";
import type { PoolOptions } from "../src/index.js";
import { TestServer, sleep, waitFor } from "./helpers/server.js";

const server = await TestServer.start({ after: (fn) => after(fn) });
const ADMIN = { user: "SYSTEM", password: "HelloWorldDB" } as const;

// 서버의 동시 접속 상한(10)을 넘지 않게, 시험이 끝날 때마다 그 시험에서 만든 풀을 모두 닫는다.
const created: Array<ReturnType<typeof createPool>> = [];
afterEach(async () => {
  for (const p of created.splice(0)) await p.close({ force: true });
});

function pool(extra: Partial<PoolOptions> = {}, target: TestServer = server) {
  const p = createPool({ port: target.port, ...ADMIN, ...extra });
  created.push(p);
  return p;
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

test("접속은 처음 빌릴 때 만들고, 돌려주면 다음에 같은 접속을 다시 빌려준다", async () => {
  const p = pool({ max: 3 });
  assert.deepEqual(p.stats, { total: 0, idle: 0, active: 0, waiting: 0 });
  const first = await p.acquire();
  assert.deepEqual(p.stats, { total: 1, idle: 0, active: 1, waiting: 0 });
  const sessionId = first.session.id;
  first.release();
  assert.deepEqual(p.stats, { total: 1, idle: 1, active: 0, waiting: 0 });
  const second = await p.acquire();
  assert.equal(second, first, "돌려준 접속을 다시 쓴다");
  assert.equal(second.session.id, sessionId);
  assert.equal((await second.query("SELECT 1")).rows[0]?.[0], 1);
  second.release();
});

test("max 에 이르면 돌려받을 때까지 줄 서서 기다리고, 순서대로 받는다", async () => {
  const p = pool({ max: 2 });
  const a = await p.acquire();
  const b = await p.acquire();
  assert.notEqual(a, b);
  const order: string[] = [];
  const c = p.acquire().then((conn) => (order.push("c"), conn));
  const d = p.acquire().then((conn) => (order.push("d"), conn));
  await sleep(100);
  assert.deepEqual(p.stats, { total: 2, idle: 0, active: 2, waiting: 2 });
  assert.deepEqual(order, []);
  a.release();
  const gotC = await c;
  assert.equal(gotC, a, "돌려받은 접속이 먼저 기다린 쪽에 간다");
  assert.deepEqual(order, ["c"]);
  b.release();
  const gotD = await d;
  assert.equal(gotD, b);
  assert.equal(p.stats.total, 2, "max 를 넘어 만들지 않았다");
  gotC.release();
  gotD.release();
});

test("빌리려고 기다리다 acquireTimeoutMs 를 넘으면 53300 이다. 풀은 그대로 쓸 수 있다", async () => {
  const p = pool({ max: 1, acquireTimeoutMs: 300 });
  const held = await p.acquire();
  const started = Date.now();
  const error = await failure(p.acquire());
  assert.equal(error.sqlState, "53300");
  assert.ok(Date.now() - started >= 250);
  assert.equal(p.stats.waiting, 0, "포기한 요청은 줄에서 빠진다");
  held.release();
  const again = await p.acquire();
  assert.equal(again, held);
  again.release();
});

test("돌려받은 접속은 로그인 직후의 상태로 되돌린다 (커밋하지 않은 트랜잭션은 롤백, 바꾼 자동 커밋은 되돌림)", async () => {
  const admin = await connect({ port: server.port, ...ADMIN });
  await admin.query("CREATE TABLE ND_POOL1 (ID INTEGER PRIMARY KEY)");
  const p = pool({ max: 1 });
  const a = await p.acquire();
  await a.begin();
  await a.query("INSERT INTO ND_POOL1 VALUES (1)");
  a.release(); // 커밋하지 않고 돌려준다.
  const b = await p.acquire();
  assert.equal(b, a);
  assert.equal(b.inTransaction, false);
  assert.equal((await b.query("SELECT COUNT(*) FROM ND_POOL1")).rows[0]?.[0], 0n, "롤백되었다");
  await b.setAutoCommit(false);
  await b.query("INSERT INTO ND_POOL1 VALUES (2)");
  b.release();
  const c = await p.acquire();
  assert.equal(c.autoCommit, true, "자동 커밋이 되돌려졌다");
  assert.equal((await admin.query("SELECT COUNT(*) FROM ND_POOL1")).rows[0]?.[0], 0n);
  await c.query("INSERT INTO ND_POOL1 VALUES (3)");
  assert.equal((await admin.query("SELECT COUNT(*) FROM ND_POOL1")).rows[0]?.[0], 1n, "자동 커밋으로 동작한다");
  c.release();
  await admin.close();
});

test("끊어진 접속은 풀에서 빠지고 다음 요청은 새 접속을 만든다", async () => {
  const p = pool({ max: 1 });
  const first = await p.acquire();
  first.destroy(); // 빌려 간 접속이 끊겼다.
  await waitFor(() => p.stats.total === 0, 2000, "the broken connection to leave the pool");
  const second = await p.acquire();
  assert.notEqual(second, first);
  assert.equal((await second.query("SELECT 1")).rows[0]?.[0], 1);
  first.release(); // 끊긴 것을 늦게 돌려줘도 아무 일도 없다.
  assert.equal(p.stats.active, 1);
  second.release();
  // 놀고 있는 접속이 끊긴 경우
  const third = await p.acquire();
  third.release();
  third.destroy();
  await waitFor(() => p.stats.total === 0, 2000, "the idle connection to leave the pool");
  const fourth = await p.acquire();
  assert.equal((await fourth.query("SELECT 2")).rows[0]?.[0], 2);
  fourth.release();
});

test("서버가 유휴 시간 초과로 놀고 있는 접속을 끊어도 다음에 빌리는 접속은 정상이다", async () => {
  const own = await TestServer.start({ after: (fn) => after(fn) }, { session: { idleTimeoutMs: 800 } });
  const p = pool({ max: 2 }, own);
  const first = await p.acquire();
  first.release();
  await waitFor(() => p.stats.total === 0, 5000, "the server to close the idle connection (57P05)");
  const second = await p.acquire();
  assert.notEqual(second, first);
  assert.equal((await second.query("SELECT 3")).rows[0]?.[0], 3);
  second.release();
});

test("query, withConnection, transaction 은 빌리고 돌려주는 일을 알아서 한다 (예외가 나도 돌려준다)", async () => {
  const p = pool({ max: 1 });
  assert.equal((await p.query("SELECT 'x'")).rows[0]?.[0], "x");
  assert.equal(p.stats.active, 0);
  assert.equal((await failure(p.query("SELECT * FROM ND_NO_SUCH"))).sqlState, "42P01");
  assert.equal(p.stats.active, 0, "오류가 나도 돌려준다");

  const result = await p.withConnection(async (conn) => (await conn.query("SELECT 4")).rows[0]?.[0]);
  assert.equal(result, 4);
  await assert.rejects(p.withConnection(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(p.stats.active, 0);

  await p.query("CREATE TABLE ND_POOL2 (ID INTEGER PRIMARY KEY)");
  await p.transaction(async (tx) => {
    await tx.query("INSERT INTO ND_POOL2 VALUES (1)");
  });
  await assert.rejects(
    p.transaction(async (tx) => {
      await tx.query("INSERT INTO ND_POOL2 VALUES (2)");
      throw new Error("rollback please");
    }),
    /rollback please/,
  );
  assert.deepEqual((await p.query("SELECT ID FROM ND_POOL2")).rows, [[1]]);
  assert.equal(p.stats.active, 0);
});

test("동시에 많은 요청을 보내도 max 개의 접속만 쓰고 모두 정상으로 끝난다 (TCP 와 UDP)", async () => {
  for (const protocol of ["tcp", "udp"] as const) {
    const p = pool({ max: 3, protocol });
    const sessions = new Set<number>();
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 30 }, async (_, i) => {
        const conn = await p.acquire();
        try {
          sessions.add(conn.session.id);
          peak = Math.max(peak, p.stats.active);
          await sleep(5);
          return (await conn.query("SELECT ? + 0", [i])).rows[0]?.[0];
        } finally {
          conn.release();
        }
      }),
    );
    assert.deepEqual(results, Array.from({ length: 30 }, (_, i) => BigInt(i)), protocol);
    assert.ok(sessions.size <= 3 && peak <= 3, `${protocol} : 접속 ${sessions.size}개, 동시 ${peak}개`);
    await p.close();
  }
});

test("접속에 실패하면 기다리던 요청이 그 오류로 실패하고 풀은 계속 쓸 수 있다", async () => {
  const p = pool({ max: 2, password: "wrong" });
  const error = await failure(p.acquire());
  assert.equal(error.sqlState, "28000");
  assert.deepEqual(p.stats, { total: 0, idle: 0, active: 0, waiting: 0 });
  const more = await Promise.allSettled([p.acquire(), p.acquire(), p.acquire()]);
  assert.ok(more.every((r) => r.status === "rejected"), "여러 요청이 기다려도 모두 실패로 끝난다");
  assert.equal(p.stats.total, 0);
});

test("idleTimeoutMs 가 지난 놀고 있는 접속은 닫는다. maxLifetimeMs 를 넘은 접속은 돌려받을 때 닫는다", async () => {
  const idle = pool({ max: 2, idleTimeoutMs: 300 });
  const a = await idle.acquire();
  const b = await idle.acquire();
  a.release();
  b.release();
  assert.equal(idle.stats.idle, 2);
  await waitFor(() => idle.stats.total === 0, 3000, "idle connections to be closed");
  assert.equal(a.isClosed && b.isClosed, true);

  const aged = pool({ max: 1, maxLifetimeMs: 200 });
  const old = await aged.acquire();
  await sleep(300);
  old.release();
  assert.equal(old.isClosed, true, "오래 쓴 접속은 돌려받을 때 닫는다");
  const fresh = await aged.acquire();
  assert.notEqual(fresh, old);
  fresh.release();
});

test("close : 놀고 있는 접속은 바로 닫고, 기다리던 요청은 실패시키고, 빌려 간 접속은 돌려받는 대로 닫는다", async () => {
  const p = pool({ max: 2 });
  const idle = await p.acquire();
  const busy = await p.acquire();
  const third = p.acquire(); // max 라 기다린다.
  idle.release(); // 기다리던 third 가 받는다.
  const lent = await third;
  assert.equal(lent, idle);
  const closing = p.close();
  await sleep(50);
  assert.equal(p.stats.active, 2, "빌려 간 접속이 있는 동안 close 는 끝나지 않는다");
  assert.equal((await failure(p.acquire())).sqlState, "08003", "닫는 중인 풀에서는 빌릴 수 없다");
  busy.release();
  lent.release();
  await closing;
  assert.equal(busy.isClosed && lent.isClosed, true);
  assert.equal(p.stats.total, 0);
  await p.close(); // 다시 불러도 괜찮다.
});

test("close({ force }) 는 빌려 간 접속도 바로 끊는다 (커밋하지 않은 변경은 서버가 롤백한다)", async () => {
  const admin = await connect({ port: server.port, ...ADMIN });
  await admin.query("CREATE TABLE ND_POOL3 (ID INTEGER PRIMARY KEY)");
  const p = pool({ max: 1 });
  const lent = await p.acquire();
  await lent.begin();
  await lent.query("INSERT INTO ND_POOL3 VALUES (1)");
  const waiter = p.acquire();
  const waiterError = failure(waiter);
  await p.close({ force: true });
  assert.equal(lent.isClosed, true);
  assert.equal((await waiterError).sqlState, "08003");
  assert.equal((await admin.query("SELECT COUNT(*) FROM ND_POOL3")).rows[0]?.[0], 0n);
  await admin.close();
});

test("release 는 빌린 접속에만 쓸 수 있고 두 번 돌려줄 수 없다. 잘못된 풀 옵션은 거부한다", async () => {
  const direct = await connect({ port: server.port, ...ADMIN });
  assert.throws(() => direct.release(), /pool/);
  await direct.close();
  const p = pool({ max: 1 });
  const conn = await p.acquire();
  conn.release();
  assert.throws(() => conn.release(), /pool|released/);
  assert.throws(() => createPool({ ...ADMIN, max: 0 }), RangeError);
  assert.throws(() => createPool({ ...ADMIN, idleTimeoutMs: -1 }), RangeError);
  assert.throws(() => createPool({ ...ADMIN, acquireTimeoutMs: Number.NaN }), RangeError);
  assert.ok(conn instanceof Connection);
});
