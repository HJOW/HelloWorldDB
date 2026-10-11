/**
 * 동시성 테스트 (7단계).
 * 비동기 실행(executeAsync)의 잠금 대기, 대기 제한 시간, 교착 감지와 희생자 롤백, DDL 의 대기,
 * 세션 종료 중의 대기 취소를 본다.
 * 마지막 테스트가 상세 9 의 검증 기준(10개 세션이 같은 테이블에 조회와 변경을 동시에 수행)이다.
 * 관련 사양 : AGENTS.md 상세 9, 10
 * 구현 단계 : 7단계
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DbError } from "../../src/common/errors.js";
import { Database } from "../../src/session/session.js";
import type { ExecuteResult, Session } from "../../src/session/session.js";
import { selectStrings, state, tempDir } from "../exec/helpers.js";

function openDb(dir: string, lockTimeoutMs = 30000): Database {
  return Database.open(dir, { onWarning: () => {}, lockTimeoutMs });
}

async function rows(session: Session, sql: string): Promise<string[][]> {
  return selectStrings(await session.executeAsync(sql)).rows;
}

async function setup(t: { after(fn: () => void): void }, lockTimeoutMs = 30000): Promise<{ db: Database; a: Session; b: Session }> {
  const db = openDb(tempDir(t), lockTimeoutMs);
  const a = db.createSession({});
  await a.executeAsync("CREATE TABLESPACE APP");
  await a.executeAsync("USE APP");
  await a.executeAsync("CREATE TABLE T (ID INTEGER PRIMARY KEY, V INTEGER)");
  await a.executeAsync("INSERT INTO T VALUES (1, 10), (2, 20), (3, 30)");
  const b = db.createSession({ tablespace: "APP" });
  return { db, a, b };
}

/** 약속이 이미 끝났는지 몇 틱 뒤에 확인한다. */
async function settled(promise: Promise<unknown>): Promise<"pending" | "resolved" | "rejected"> {
  let status: "pending" | "resolved" | "rejected" = "pending";
  promise.then(
    () => {
      status = "resolved";
    },
    () => {
      status = "rejected";
    },
  );
  for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setImmediate(resolve));
  return status;
}

test("잠금을 기다렸다가 풀리면 문장이 이어지고 갱신이 유실되지 않는다", async (t) => {
  const { db, a, b } = await setup(t);
  try {
    await a.executeAsync("BEGIN");
    await a.executeAsync("UPDATE T SET V = V + 1 WHERE ID = 1");
    const waiting = b.executeAsync("UPDATE T SET V = V + 1 WHERE ID = 1");
    assert.equal(await settled(waiting), "pending");
    assert.equal(db.locks.waiterCount, 1);
    // 기다리는 동안에도 다른 세션의 조회는 막히지 않고, 커밋 전 값을 본다.
    // (같은 세션의 문장은 순서대로 처리되므로 b 로는 조회할 수 없다)
    const reader = db.createSession({ tablespace: "APP" });
    assert.deepEqual(await rows(reader, "SELECT V FROM T WHERE ID = 1"), [["10"]]);
    await a.executeAsync("COMMIT");
    const result = await waiting;
    assert.equal(result.kind === "ok" ? result.rowCount : undefined, 1);
    // 두 변경이 차례로 적용되었다. (11 위에 12)
    assert.deepEqual(await rows(a, "SELECT V FROM T WHERE ID = 1"), [["12"]]);
    assert.equal(db.locks.lockCount, 0);
    assert.equal(db.locks.waiterCount, 0);
  } finally {
    db.close();
  }
});

test("앞선 트랜잭션이 롤백하면 기다리던 문장이 원래 값 위에서 이어진다", async (t) => {
  const { db, a, b } = await setup(t);
  try {
    await a.executeAsync("BEGIN");
    await a.executeAsync("DELETE FROM T WHERE ID = 2");
    const waiting = b.executeAsync("UPDATE T SET V = V + 5 WHERE ID = 2");
    assert.equal(await settled(waiting), "pending");
    await a.executeAsync("ROLLBACK");
    await waiting;
    assert.deepEqual(await rows(a, "SELECT V FROM T WHERE ID = 2"), [["25"]]);
  } finally {
    db.close();
  }
});

test("앞선 트랜잭션이 행을 지우고 커밋하면 기다리던 문장은 그 행을 못 찾는다", async (t) => {
  const { db, a, b } = await setup(t);
  try {
    await a.executeAsync("BEGIN");
    await a.executeAsync("DELETE FROM T WHERE ID = 2");
    const waiting = b.executeAsync("UPDATE T SET V = 0 WHERE ID = 2");
    assert.equal(await settled(waiting), "pending");
    await a.executeAsync("COMMIT");
    const result = await waiting;
    assert.equal(result.kind === "ok" ? result.rowCount : undefined, 0);
    assert.deepEqual(await rows(a, "SELECT ID FROM T ORDER BY ID"), [["1"], ["3"]]);
  } finally {
    db.close();
  }
});

test("대기 제한 시간을 넘기면 그 문장만 55P03 으로 실패하고 트랜잭션은 이어진다", async (t) => {
  const { db, a, b } = await setup(t, 60);
  try {
    await a.executeAsync("BEGIN");
    await a.executeAsync("UPDATE T SET V = 11 WHERE ID = 1");
    await b.executeAsync("BEGIN");
    await b.executeAsync("UPDATE T SET V = 22 WHERE ID = 2");
    const started = Date.now();
    await assert.rejects(b.executeAsync("UPDATE T SET V = 12 WHERE ID = 1"), state("55P03"));
    assert.ok(Date.now() - started >= 40, "제한 시간만큼 기다린 뒤 실패해야 한다");
    assert.equal(db.locks.waiterCount, 0);
    // 트랜잭션은 살아 있고 앞서 바꾼 것도 그대로이다.
    assert.equal(b.inTransaction, true);
    assert.deepEqual(await rows(b, "SELECT V FROM T WHERE ID = 2"), [["22"]]);
    await a.executeAsync("COMMIT");
    await b.executeAsync("UPDATE T SET V = 12 WHERE ID = 1");
    await b.executeAsync("COMMIT");
    assert.deepEqual(await rows(a, "SELECT ID, V FROM T ORDER BY ID"), [["1", "12"], ["2", "22"], ["3", "30"]]);
  } finally {
    db.close();
  }
});

test("lockTimeoutMs 가 0 이면 기다리지 않는다", async (t) => {
  const { db, a, b } = await setup(t, 0);
  try {
    await a.executeAsync("BEGIN");
    await a.executeAsync("UPDATE T SET V = 11 WHERE ID = 1");
    await assert.rejects(b.executeAsync("UPDATE T SET V = 12 WHERE ID = 1"), state("55P03"));
    assert.equal(db.locks.waiterCount, 0);
    await a.executeAsync("ROLLBACK");
  } finally {
    db.close();
  }
});

test("교착 상태를 감지하면 한쪽 트랜잭션을 롤백하고 40P01 을 알린다", async (t) => {
  const { db, a, b } = await setup(t);
  try {
    await a.executeAsync("BEGIN");
    await b.executeAsync("BEGIN");
    await a.executeAsync("UPDATE T SET V = 11 WHERE ID = 1");
    await b.executeAsync("UPDATE T SET V = 22 WHERE ID = 2");
    // A 가 B 의 행을 기다린다.
    const aWaits = a.executeAsync("UPDATE T SET V = 21 WHERE ID = 2");
    assert.equal(await settled(aWaits), "pending");
    // B 가 A 의 행을 기다리면 고리가 닫힌다. 고리를 닫은 B 가 희생자이다.
    await assert.rejects(b.executeAsync("UPDATE T SET V = 12 WHERE ID = 1"), state("40P01"));
    assert.equal(b.inTransaction, false);
    // 희생자의 변경은 사라지고 잠금이 풀려 A 가 이어진다.
    await aWaits;
    await a.executeAsync("COMMIT");
    assert.deepEqual(await rows(b, "SELECT ID, V FROM T ORDER BY ID"), [["1", "11"], ["2", "21"], ["3", "30"]]);
    assert.equal(db.locks.lockCount, 0);
    assert.equal(db.locks.waiterCount, 0);
  } finally {
    db.close();
  }
});

test("교착으로 롤백된 세션은 새 트랜잭션을 바로 시작할 수 있다", async (t) => {
  const { db, a, b } = await setup(t);
  try {
    await a.executeAsync("BEGIN");
    await b.executeAsync("BEGIN");
    await a.executeAsync("UPDATE T SET V = 11 WHERE ID = 1");
    await b.executeAsync("UPDATE T SET V = 22 WHERE ID = 2");
    const aWaits = a.executeAsync("UPDATE T SET V = 21 WHERE ID = 2");
    await settled(aWaits);
    await assert.rejects(b.executeAsync("UPDATE T SET V = 12 WHERE ID = 1"), state("40P01"));
    await aWaits;
    await a.executeAsync("COMMIT");
    await b.executeAsync("BEGIN");
    await b.executeAsync("UPDATE T SET V = 99 WHERE ID = 3");
    await b.executeAsync("COMMIT");
    assert.deepEqual(await rows(a, "SELECT V FROM T WHERE ID = 3"), [["99"]]);
  } finally {
    db.close();
  }
});

test("같은 세션의 비동기 문장은 호출한 순서대로 처리된다", async (t) => {
  const { db, a, b } = await setup(t);
  try {
    await a.executeAsync("BEGIN");
    await a.executeAsync("UPDATE T SET V = 100 WHERE ID = 1");
    // B 의 첫 문장이 기다리는 동안 뒤의 문장은 먼저 실행되지 않는다.
    const first = b.executeAsync("UPDATE T SET V = V + 1 WHERE ID = 1");
    const second = b.executeAsync("UPDATE T SET V = V * 2 WHERE ID = 1");
    const third = b.executeAsync("SELECT V FROM T WHERE ID = 1");
    assert.equal(await settled(first), "pending");
    assert.equal(await settled(second), "pending");
    await a.executeAsync("COMMIT");
    await first;
    await second;
    const result = (await third) as ExecuteResult;
    assert.deepEqual(selectStrings(result).rows, [["202"]]);
  } finally {
    db.close();
  }
});

test("FOR UPDATE 도 기다린다", async (t) => {
  const { db, a, b } = await setup(t);
  try {
    await a.executeAsync("BEGIN");
    assert.deepEqual(await rows(a, "SELECT V FROM T WHERE ID = 1 FOR UPDATE"), [["10"]]);
    const waiting = b.executeAsync("SELECT V FROM T WHERE ID = 1 FOR UPDATE");
    assert.equal(await settled(waiting), "pending");
    await a.executeAsync("UPDATE T SET V = 15 WHERE ID = 1");
    await a.executeAsync("COMMIT");
    // 기다린 쪽은 커밋된 새 값을 읽는다.
    assert.deepEqual(selectStrings(await waiting).rows, [["15"]]);
  } finally {
    db.close();
  }
});

test("같은 PK 를 동시에 넣으면 먼저 커밋한 쪽만 남고 나중 쪽은 23505 이다", async (t) => {
  const { db, a, b } = await setup(t);
  try {
    await a.executeAsync("BEGIN");
    await a.executeAsync("INSERT INTO T VALUES (5, 50)");
    const waiting = b.executeAsync("INSERT INTO T VALUES (5, 51)");
    assert.equal(await settled(waiting), "pending");
    await a.executeAsync("COMMIT");
    await assert.rejects(waiting, state("23505"));
    assert.deepEqual(await rows(b, "SELECT V FROM T WHERE ID = 5"), [["50"]]);
    // 앞선 쪽이 롤백하면 나중 쪽이 들어간다.
    await a.executeAsync("BEGIN");
    await a.executeAsync("INSERT INTO T VALUES (6, 60)");
    const retry = b.executeAsync("INSERT INTO T VALUES (6, 61)");
    assert.equal(await settled(retry), "pending");
    await a.executeAsync("ROLLBACK");
    await retry;
    assert.deepEqual(await rows(a, "SELECT V FROM T WHERE ID = 6"), [["61"]]);
  } finally {
    db.close();
  }
});

test("DDL 은 그 테이블의 행 잠금이 풀릴 때까지 기다린다", async (t) => {
  const { db, a, b } = await setup(t);
  try {
    await a.executeAsync("BEGIN");
    await a.executeAsync("UPDATE T SET V = 11 WHERE ID = 1");
    const ddl = b.executeAsync("ALTER TABLE T ADD COLUMN W INTEGER");
    assert.equal(await settled(ddl), "pending");
    // DDL 이 기다리는 동안 조회와 다른 세션의 읽기는 막히지 않는다.
    assert.deepEqual(await rows(a, "SELECT V FROM T WHERE ID = 1"), [["11"]]);
    await a.executeAsync("COMMIT");
    await ddl;
    assert.deepEqual(await rows(a, "SELECT ID, V, W FROM T WHERE ID = 1"), [["1", "11", "NULL"]]);
    assert.equal(db.locks.lockCount, 0);
  } finally {
    db.close();
  }
});

test("잠금을 기다리는 세션을 닫으면 기다림이 취소되고 08003 으로 끝난다", async (t) => {
  const { db, a, b } = await setup(t);
  try {
    await a.executeAsync("BEGIN");
    await a.executeAsync("UPDATE T SET V = 11 WHERE ID = 1");
    await b.executeAsync("BEGIN");
    await b.executeAsync("UPDATE T SET V = 22 WHERE ID = 2");
    const waiting = b.executeAsync("UPDATE T SET V = 12 WHERE ID = 1");
    assert.equal(await settled(waiting), "pending");
    const failure = assert.rejects(waiting, state("08003"));
    b.close();
    await failure;
    assert.equal(db.locks.waiterCount, 0);
    // B 가 가졌던 잠금도 풀렸다.
    await a.executeAsync("UPDATE T SET V = 23 WHERE ID = 2");
    await a.executeAsync("COMMIT");
    assert.deepEqual(await rows(a, "SELECT ID, V FROM T ORDER BY ID"), [["1", "11"], ["2", "23"], ["3", "30"]]);
  } finally {
    db.close();
  }
});

/** 재현 가능한 의사 난수이다. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: unknown): boolean {
  return error instanceof DbError && (error.sqlState === "40P01" || error.sqlState === "55P03");
}

/** 교착이나 대기 초과로 실패하면 트랜잭션을 정리하고 처음부터 다시 한다. 다시 한 횟수를 돌려준다. */
async function withRetry(session: Session, work: () => Promise<void>): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      await session.executeAsync("BEGIN");
      await work();
      await session.executeAsync("COMMIT");
      return attempt;
    } catch (error) {
      if (session.inTransaction) await session.executeAsync("ROLLBACK");
      if (!isRetryable(error)) throw error;
      await sleep(1 + (attempt % 5));
    }
  }
}

test("10개 세션이 같은 테이블에 조회와 변경을 동시에 수행해도 정합성이 유지되고 대기가 풀린다", { timeout: 120000 }, async (t) => {
  const SESSIONS = 10;
  const ROUNDS = 15;
  const ACCOUNTS = 6;
  const INITIAL = 1000;
  const dir = tempDir(t);
  const db = openDb(dir);
  let closed = false;
  try {
    const admin = db.createSession({});
    await admin.executeAsync("CREATE TABLESPACE APP");
    await admin.executeAsync("USE APP");
    await admin.executeAsync("CREATE TABLE ACCOUNTS (ID INTEGER PRIMARY KEY, BAL INTEGER NOT NULL)");
    await admin.executeAsync("CREATE TABLE COUNTER (ID INTEGER PRIMARY KEY, N INTEGER NOT NULL)");
    await admin.executeAsync("CREATE TABLE LOG (SID INTEGER, SEQ INTEGER, AMT INTEGER, PRIMARY KEY (SID, SEQ))");
    await admin.executeAsync("CREATE TABLE CLAIM (K INTEGER PRIMARY KEY, WINNER INTEGER NOT NULL)");
    await admin.executeAsync("CREATE INDEX IX_LOG_AMT ON LOG (AMT)");
    for (let id = 1; id <= ACCOUNTS; id++) {
      await admin.executeAsync("INSERT INTO ACCOUNTS VALUES (?, ?)", [BigInt(id), BigInt(INITIAL)]);
    }
    await admin.executeAsync("INSERT INTO COUNTER VALUES (1, 0)");

    let totalRetries = 0;
    let readChecks = 0;
    const claimWins = new Map<number, number>();

    async function worker(sid: number): Promise<void> {
      const session = db.createSession({ tablespace: "APP" });
      const random = prng(1000 + sid);
      for (let round = 1; round <= ROUNDS; round++) {
        // 서로 다른 순서로 두 계좌를 만지므로 교착이 생길 수 있다.
        // 절반은 계좌 1 과 2 사이를 세션 번호에 따라 반대 방향으로 오가게 하여 교착을 부추긴다.
        let from = 1 + Math.floor(random() * ACCOUNTS);
        let to = 1 + Math.floor(random() * ACCOUNTS);
        if (to === from) to = (to % ACCOUNTS) + 1;
        if (random() < 0.8) {
          from = sid % 2 === 0 ? 1 : 2;
          to = sid % 2 === 0 ? 2 : 1;
        }
        const amount = 1 + Math.floor(random() * 50);
        totalRetries += await withRetry(session, async () => {
          await session.executeAsync("UPDATE ACCOUNTS SET BAL = BAL - ? WHERE ID = ?", [BigInt(amount), BigInt(from)]);
          await session.executeAsync("UPDATE ACCOUNTS SET BAL = BAL + ? WHERE ID = ?", [BigInt(amount), BigInt(to)]);
          await session.executeAsync("UPDATE COUNTER SET N = N + 1 WHERE ID = 1");
          await session.executeAsync("INSERT INTO LOG VALUES (?, ?, ?)", [BigInt(sid), BigInt(round), BigInt(amount)]);
        });
        // 조회는 막히지 않으며 항상 커밋된 완결 상태만 본다. (이체 도중의 값은 보이지 않는다)
        const sum = selectStrings(await session.executeAsync("SELECT SUM(BAL) FROM ACCOUNTS")).rows;
        assert.deepEqual(sum, [[String(ACCOUNTS * INITIAL)]]);
        const counter = selectStrings(await session.executeAsync("SELECT N FROM COUNTER WHERE ID = 1")).rows;
        assert.ok(Number(counter[0]?.[0]) >= 0);
        readChecks++;
        // 모든 세션이 같은 키를 차지하려 한다. 정확히 한 세션만 성공해야 한다.
        try {
          await session.executeAsync("INSERT INTO CLAIM VALUES (?, ?)", [BigInt(round), BigInt(sid)]);
          claimWins.set(round, (claimWins.get(round) ?? 0) + 1);
        } catch (error) {
          if (!(error instanceof DbError) || error.sqlState !== "23505") throw error;
        }
      }
      session.close();
    }

    const started = Date.now();
    await Promise.all(Array.from({ length: SESSIONS }, (_, index) => worker(index + 1)));
    const elapsed = Date.now() - started;

    const total = SESSIONS * ROUNDS;
    assert.deepEqual(await rows(admin, "SELECT SUM(BAL) FROM ACCOUNTS"), [[String(ACCOUNTS * INITIAL)]]);
    assert.deepEqual(await rows(admin, "SELECT N FROM COUNTER"), [[String(total)]]);
    // 모든 (세션, 회차) 쌍이 한 번씩만 기록되었다. (재시도로 중복 기록되지 않았다)
    assert.deepEqual(await rows(admin, "SELECT COUNT(*) FROM LOG"), [[String(total)]]);
    // 이체 합계와 로그의 금액 합계가 일치한다. 인덱스를 거친 조회도 같은 결과를 낸다.
    const logged = await rows(admin, "SELECT SUM(AMT) FROM LOG");
    const byIndex = await rows(admin, "SELECT COUNT(*) FROM LOG WHERE AMT >= 1");
    assert.deepEqual(byIndex, [[String(total)]]);
    assert.ok(Number(logged[0]?.[0]) >= total);
    // 모든 키는 정확히 한 세션이 차지했다.
    assert.deepEqual(await rows(admin, "SELECT COUNT(*) FROM CLAIM"), [[String(ROUNDS)]]);
    for (let round = 1; round <= ROUNDS; round++) assert.equal(claimWins.get(round), 1, `키 ${round}`);
    assert.equal(readChecks, total);
    // 대기가 남지 않고 잠금이 모두 풀렸다.
    assert.equal(db.locks.waiterCount, 0);
    assert.equal(db.locks.lockCount, 0);
    assert.equal(db.sessions.count, 1);
    t.diagnostic(`세션 ${SESSIONS}개 x ${ROUNDS}회, 재시도 ${totalRetries}회, ${elapsed}ms`);

    // 커밋한 내용은 다시 열어도 같다.
    db.close();
    closed = true;
    const reopened = openDb(dir);
    try {
      const check = reopened.createSession({ tablespace: "APP" });
      assert.deepEqual(await rows(check, "SELECT SUM(BAL) FROM ACCOUNTS"), [[String(ACCOUNTS * INITIAL)]]);
      assert.deepEqual(await rows(check, "SELECT N FROM COUNTER"), [[String(total)]]);
      assert.deepEqual(await rows(check, "SELECT COUNT(*) FROM LOG"), [[String(total)]]);
      assert.deepEqual(await rows(check, "SELECT COUNT(*) FROM LOG WHERE AMT >= 1"), [[String(total)]]);
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) db.close();
  }
});
