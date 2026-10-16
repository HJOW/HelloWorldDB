/**
 * 네트워크를 거친 동시성 시험 (11단계). 실제 `hwdb start` 로 띄운 데몬에 로컬 전용 채널, TCP, UDP 로 접속한 세션 10개가
 * 같은 테이블에 조회와 변경을 동시에 수행한다. 개요 9 "동시 접근 지원 (최대 사용자 10명으로 테스트)" 의 검증 기준이다 :
 * 데이터 정합성이 유지되고, 풀리지 않는 대기 없이 끝나야 한다.
 *  - 이체 부하 : 서로 반대 순서로 두 행을 잠그는 트랜잭션이 교착을 일으켜도 감지되어 재시도로 끝나고 합계가 변하지 않는다.
 *  - 갱신 손실이 없는 카운터, 조회가 쓰는 쪽을 기다리지 않는 READ COMMITTED, 같은 PK 를 동시에 넣는 경쟁
 *  - 교착(40P01)과 잠금 대기 초과(55P03)가 네트워크 너머에서도 동작하고 세션이 유지되는 것, 접속이 갑자기 끊기면 잠금이 풀리는 것
 *  - 동시 세션 수 상한(maxConnections)의 경계
 * 7단계의 동시성 시험(`test/txn/concurrency.test.ts`)은 프로세스 안의 세션이고, 여기는 프로토콜과 소켓을 거친다.
 * 관련 사양 : AGENTS.md 상세 9, 10
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Connection } from "../../src/client/connection.js";
import { DbError } from "../../src/common/errors.js";
import { createRandom } from "../types/helpers.js";
import { Daemon, exec, execAll, failure, num, query, sleep } from "./helpers.js";
import type { ConnectKind } from "./helpers.js";

/** 일이 제한 시간 안에 끝나는지 본다. 끝나지 않으면 "풀리지 않는 대기" 로 보고 시험을 실패시킨다. */
async function within<T>(milliseconds: number, what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds} ms: ${what}`)), milliseconds);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 사용자가 이미 닫힌 접속의 오류(교착, 잠금 대기 초과)를 만나면 롤백하고 다시 시도해야 하는지 본다. */
function isRetryable(error: unknown): error is DbError {
  return error instanceof DbError && (error.sqlState === "40P01" || error.sqlState === "55P03");
}

/** 세션 10개의 접속 경로이다. 로컬 전용 채널 3, TCP 4, UDP 3. */
const TEN: readonly ConnectKind[] = ["local", "local", "local", "tcp", "tcp", "tcp", "tcp", "udp", "udp", "udp"];

async function openTen(daemon: Daemon): Promise<Connection[]> {
  return await Promise.all(TEN.map((kind) => daemon.connect(kind)));
}

test("개요 9 : 세션 10개가 로컬·TCP·UDP 로 이체를 동시에 수행해도 합계가 변하지 않고 교착은 재시도로 끝난다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const admin = await daemon.connect("tcp");
  await execAll(admin, [
    "CREATE TABLE ACCOUNTS (ID INTEGER PRIMARY KEY, BALANCE INTEGER NOT NULL)",
    ...Array.from({ length: 10 }, (_, id) => `INSERT INTO ACCOUNTS VALUES (${id}, 1000)`),
  ]);

  const sessions = await openTen(daemon);
  const stats = { transfers: 0, retries: 0, sumChecks: 0 };

  const worker = async (connection: Connection, seed: number): Promise<void> => {
    const random = createRandom(seed);
    for (let n = 0; n < 25; n++) {
      // 반대 방향의 이체가 겹치도록 두 계좌를 무작위로 고른다.
      const from = Math.floor(random() * 10);
      let to = Math.floor(random() * 10);
      if (to === from) to = (to + 1) % 10;
      const amount = 1 + Math.floor(random() * 50);
      for (;;) {
        try {
          await exec(connection, "BEGIN");
          await exec(connection, "UPDATE ACCOUNTS SET BALANCE = BALANCE - ? WHERE ID = ?", [amount, from]);
          await exec(connection, "UPDATE ACCOUNTS SET BALANCE = BALANCE + ? WHERE ID = ?", [amount, to]);
          await exec(connection, "COMMIT");
          stats.transfers++;
          break;
        } catch (error) {
          if (!isRetryable(error)) throw error;
          stats.retries++;
          await exec(connection, "ROLLBACK");
        }
      }
      // 커밋된 데이터만 보이므로 어느 시점에 읽어도 합계는 같다 (이체 중간 상태가 보이면 안 된다).
      if (n % 5 === 0) {
        assert.equal(await num(connection, "SELECT SUM(BALANCE) FROM ACCOUNTS"), 10000);
        stats.sumChecks++;
      }
    }
  };

  await within(120_000, "10 sessions transferring", Promise.all(sessions.map((connection, index) => worker(connection, 1000 + index))));

  assert.equal(stats.transfers, 250);
  assert.ok(stats.sumChecks >= 50);
  assert.equal(await num(admin, "SELECT SUM(BALANCE) FROM ACCOUNTS"), 10000);
  // 모든 세션이 정상이고(풀리지 않는 대기 없음) 데몬이 세션 수를 정확히 안다.
  const status = daemon.hwdb(["status"]);
  assert.match(status.stdout, /sessions: 11\n/);
});

test("개요 9 : 세션 10개가 같은 행을 동시에 증가시켜도 갱신을 잃지 않는다 (행 잠금)", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const admin = await daemon.connect("local");
  await execAll(admin, ["CREATE TABLE COUNTER (ID INTEGER PRIMARY KEY, N INTEGER NOT NULL)", "INSERT INTO COUNTER VALUES (1, 0)"]);
  const sessions = await openTen(daemon);
  await within(
    120_000,
    "10 sessions incrementing",
    Promise.all(
      sessions.map(async (connection) => {
        for (let n = 0; n < 40; n++) await exec(connection, "UPDATE COUNTER SET N = N + 1 WHERE ID = 1");
      }),
    ),
  );
  assert.equal(await num(admin, "SELECT N FROM COUNTER WHERE ID = 1"), 400);
});

test("개요 9 : 세션 10개가 서로 다른 PK 범위와 같은 PK 를 동시에 넣으면 중복만 거부된다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const admin = await daemon.connect("tcp");
  await exec(admin, "CREATE TABLE ITEMS (ID INTEGER PRIMARY KEY, OWNER INTEGER NOT NULL)");
  const sessions = await openTen(daemon);
  let duplicates = 0;
  await within(
    120_000,
    "10 sessions inserting",
    Promise.all(
      sessions.map(async (connection, index) => {
        // 자기 범위(index * 100 + 0 ~ 29)는 모두 들어가고, 모두가 같이 넣는 공용 키 9000 ~ 9009 는 하나씩만 들어간다.
        for (let n = 0; n < 30; n++) await exec(connection, "INSERT INTO ITEMS VALUES (?, ?)", [index * 100 + n, index]);
        for (let shared = 9000; shared < 9010; shared++) {
          try {
            await exec(connection, "INSERT INTO ITEMS VALUES (?, ?)", [shared, index]);
          } catch (error) {
            if (!(error instanceof DbError) || error.sqlState !== "23505") throw error;
            duplicates++;
          }
        }
      }),
    ),
  );
  assert.equal(await num(admin, "SELECT COUNT(*) FROM ITEMS"), 310);
  assert.equal(duplicates, 90, "공용 키 10개마다 9 세션이 중복 오류를 받았다");
  assert.equal(await num(admin, "SELECT COUNT(DISTINCT ID) FROM ITEMS"), 310);
});

test("개요 9 : 같은 PK 를 동시에 넣는 두 트랜잭션 : 앞선 쪽이 커밋하면 뒤가 중복, 롤백하면 뒤가 성공한다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const setup = await daemon.connect("tcp");
  await exec(setup, "CREATE TABLE PK_RACE (ID INTEGER PRIMARY KEY, WHO VARCHAR(10))");
  const a = await daemon.connect("tcp");
  const b = await daemon.connect("udp");

  // 커밋하는 경우
  await exec(a, "BEGIN");
  await exec(a, "INSERT INTO PK_RACE VALUES (1, 'A')");
  const waiting = failure(b, "INSERT INTO PK_RACE VALUES (1, 'B')"); // A 가 끝나기를 기다린다.
  await sleep(300);
  await exec(a, "COMMIT");
  assert.equal((await within(10_000, "B after A commit", waiting)).sqlState, "23505");
  assert.deepEqual(await query(setup, "SELECT WHO FROM PK_RACE WHERE ID = 1"), [["A"]]);

  // 롤백하는 경우
  await exec(a, "BEGIN");
  await exec(a, "INSERT INTO PK_RACE VALUES (2, 'A')");
  const second = exec(b, "INSERT INTO PK_RACE VALUES (2, 'B')");
  await sleep(300);
  await exec(a, "ROLLBACK");
  await within(10_000, "B after A rollback", second);
  assert.deepEqual(await query(setup, "SELECT WHO FROM PK_RACE WHERE ID = 2"), [["B"]]);
});

test("개요 9 : 조회는 쓰는 쪽을 기다리지 않고 커밋된 값만 본다 (READ COMMITTED)", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const writer = await daemon.connect("tcp");
  const reader = await daemon.connect("udp");
  await execAll(writer, ["CREATE TABLE ACCT (ID INTEGER PRIMARY KEY, V INTEGER)", "INSERT INTO ACCT VALUES (1, 100)"]);

  await exec(writer, "BEGIN");
  await exec(writer, "UPDATE ACCT SET V = 200 WHERE ID = 1");
  // 쓰는 쪽이 행 잠금을 쥔 채여도 읽는 쪽은 바로 끝나고 이전 값을 본다.
  const started = Date.now();
  assert.equal(await within(5000, "read while locked", num(reader, "SELECT V FROM ACCT WHERE ID = 1")), 100);
  assert.ok(Date.now() - started < 3000, "조회가 쓰기를 기다리면 안 된다");
  assert.equal(await num(writer, "SELECT V FROM ACCT WHERE ID = 1"), 200, "자기 변경은 자기에게 보인다");
  await exec(writer, "COMMIT");
  assert.equal(await num(reader, "SELECT V FROM ACCT WHERE ID = 1"), 200, "커밋 뒤에는 다른 세션에도 보인다");

  await exec(writer, "BEGIN");
  await exec(writer, "DELETE FROM ACCT WHERE ID = 1");
  assert.equal(await num(reader, "SELECT COUNT(*) FROM ACCT"), 1, "지운 행도 커밋 전에는 남아 보인다");
  await exec(writer, "ROLLBACK");
  assert.equal(await num(reader, "SELECT COUNT(*) FROM ACCT"), 1);
});

for (const kind of ["tcp", "udp"] as const) {
  test(`교착 : 서로 반대 순서로 잠그는 두 세션(${kind}) 중 하나는 40P01 로 롤백되고 둘 다 접속을 유지한다`, async (t) => {
    const daemon = await Daemon.create(t);
    daemon.start();
    const setup = await daemon.connect("local");
    await execAll(setup, ["CREATE TABLE DL (ID INTEGER PRIMARY KEY, V INTEGER)", "INSERT INTO DL VALUES (1, 0)", "INSERT INTO DL VALUES (2, 0)"]);
    const a = await daemon.connect(kind);
    const b = await daemon.connect(kind);

    await exec(a, "BEGIN");
    await exec(b, "BEGIN");
    await exec(a, "UPDATE DL SET V = 1 WHERE ID = 1");
    await exec(b, "UPDATE DL SET V = 2 WHERE ID = 2");
    // A 가 B 의 행을, B 가 A 의 행을 잠그려 한다.
    const outcomes = await within(
      30_000,
      "deadlock detection",
      Promise.all([
        exec(a, "UPDATE DL SET V = 1 WHERE ID = 2").then(() => "ok", (error: unknown) => error),
        exec(b, "UPDATE DL SET V = 2 WHERE ID = 1").then(() => "ok", (error: unknown) => error),
      ]),
    );
    const victims = outcomes.filter((outcome) => outcome instanceof DbError);
    assert.equal(victims.length, 1, "정확히 한쪽만 희생된다");
    assert.equal((victims[0] as DbError).sqlState, "40P01");
    assert.ok(outcomes.includes("ok"), "나머지 한쪽은 성공한다");

    // 희생된 쪽은 이미 롤백되었고 세션은 그대로이므로 같은 접속으로 다시 시도한다.
    const [survivor, victim] = outcomes[0] === "ok" ? [a, b] : [b, a];
    await exec(survivor, "COMMIT");
    await exec(victim, "BEGIN");
    await exec(victim, "UPDATE DL SET V = 9 WHERE ID = 1");
    await exec(victim, "COMMIT");
    const final = await query(setup, "SELECT ID, V FROM DL ORDER BY ID");
    assert.equal(final.length, 2);
    assert.equal((final[0] as number[])[1], 9);
  });
}

test("개요 9 : 잠금 대기가 transaction.lockTimeoutMs 를 넘으면 그 문장만 55P03 으로 끝나고 세션은 유지된다", async (t) => {
  const daemon = await Daemon.create(t, { transaction: { lockTimeoutMs: 1000 } });
  daemon.start();
  const holder = await daemon.connect("tcp");
  const waiter = await daemon.connect("udp");
  await execAll(holder, ["CREATE TABLE LT (ID INTEGER PRIMARY KEY, V INTEGER)", "INSERT INTO LT VALUES (1, 0)"]);

  await exec(holder, "BEGIN");
  await exec(holder, "UPDATE LT SET V = 1 WHERE ID = 1");
  const started = Date.now();
  const error = await within(20_000, "lock timeout", failure(waiter, "UPDATE LT SET V = 2 WHERE ID = 1"));
  const waited = Date.now() - started;
  assert.equal(error.sqlState, "55P03");
  assert.ok(waited >= 800 && waited < 10_000, `대기 시간이 설정(1000 ms) 근처여야 한다 : ${waited} ms`);
  // 대기 초과는 문장 오류이다. 세션과 트랜잭션은 유지된다.
  assert.equal(await num(waiter, "SELECT 1"), 1);
  await exec(holder, "COMMIT");
  await exec(waiter, "UPDATE LT SET V = 2 WHERE ID = 1");
  assert.equal(await num(holder, "SELECT V FROM LT WHERE ID = 1"), 2);
});

test("개요 9 : 잠금을 쥔 채 접속이 갑자기 끊기면 롤백되고 잠금이 풀려 기다리던 세션이 진행한다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const setup = await daemon.connect("local");
  await execAll(setup, ["CREATE TABLE DROPPED (ID INTEGER PRIMARY KEY, V INTEGER)", "INSERT INTO DROPPED VALUES (1, 0)"]);
  for (const kind of ["tcp", "udp", "local"] as const) {
    const victim = await daemon.connect(kind);
    const waiter = await daemon.connect("tcp");
    await exec(victim, "BEGIN");
    await exec(victim, "UPDATE DROPPED SET V = 99 WHERE ID = 1");
    await exec(victim, "INSERT INTO DROPPED VALUES (?, 1)", [100 + kind.length]);
    const pending = exec(waiter, "UPDATE DROPPED SET V = 5 WHERE ID = 1"); // victim 의 잠금을 기다린다.
    await sleep(300);
    victim.abort(); // FIN/close 없이 소켓을 끊는다.
    await within(20_000, `${kind} waiter after the drop`, pending);
    assert.equal(await num(setup, "SELECT V FROM DROPPED WHERE ID = 1"), 5, "끊긴 세션의 변경(99)은 롤백되었다");
    assert.equal(await num(setup, "SELECT COUNT(*) FROM DROPPED"), 1, "끊긴 세션이 넣은 행도 롤백되었다");
    await exec(setup, "UPDATE DROPPED SET V = 0 WHERE ID = 1");
  }
});

test("개요 9 : maxConnections 경계 : TCP·UDP 세션 10개까지 받고 11번째는 53300, 로컬 전용 채널은 세지 않는다", async (t) => {
  const daemon = await Daemon.create(t); // maxConnections 기본 10
  daemon.start();
  const ten = await Promise.all(Array.from({ length: 10 }, (_, index) => daemon.connect(index % 2 === 0 ? "tcp" : "udp")));
  assert.equal(await num(ten[0] as Connection, "SELECT 1"), 1);
  assert.equal((await failure2(() => daemon.connect("tcp"))).sqlState, "53300");
  assert.equal((await failure2(() => daemon.connect("udp"))).sqlState, "53300");
  // 로컬 전용 채널은 가득 찬 상태에서도 받고, 세는 수에 들어가지 않는다.
  const local = await daemon.connect("local");
  assert.equal(await num(local, "SELECT COUNT(*) FROM SYS_SESSIONS"), 11);
  // 하나를 닫으면 자리가 생긴다.
  await (ten[3] as Connection).close();
  await sleep(200);
  const again = await daemon.connect("tcp");
  assert.equal(await num(again, "SELECT 1"), 1);
});

async function failure2(open: () => Promise<Connection>): Promise<DbError> {
  try {
    await open();
  } catch (error) {
    if (error instanceof DbError) return error;
    throw error;
  }
  throw new Error("The connection should have been refused.");
}
