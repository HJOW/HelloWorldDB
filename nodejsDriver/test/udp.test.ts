/**
 * UDP 접속 시험 (12-2, 12-5). 실제 rdbms 를 UDP 로 접속하며, 패킷 유실·중복·지연을 일부러 일으키는 프록시를 사이에 끼운다.
 * UDP 구간은 암호화되지 않는다.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Connection, DbError, connect } from "../src/index.js";
import type { ConnectOptions } from "../src/index.js";
import { LossyProxy } from "./helpers/udpProxy.js";
import type { ProxyOptions } from "./helpers/udpProxy.js";
import { TestServer, sleep } from "./helpers/server.js";

const ADMIN = { user: "SYSTEM", password: "HelloWorldDB" } as const;
const server = await TestServer.start({ after: (fn) => after(fn) });

async function proxy(options: Omit<ProxyOptions, "serverPort">, target: TestServer = server): Promise<LossyProxy> {
  const created = new LossyProxy({ ...options, serverPort: target.port });
  await created.start();
  after(() => created.close());
  return created;
}

function viaUdp(port: number, extra: Partial<ConnectOptions> = {}): Promise<Connection> {
  return connect({ port, protocol: "udp", ...ADMIN, connectTimeoutMs: 20_000, ...extra });
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

test("UDP : 로그인, 조회, 트랜잭션, 큰 결과가 TCP 와 같게 동작한다", async () => {
  const db = await viaUdp(server.port);
  await db.query("CREATE TABLE ND_UDP1 (ID INTEGER PRIMARY KEY, V VARCHAR(100))");
  await db.transaction(async (tx) => {
    for (let from = 0; from < 2000; from += 500) {
      const values = Array.from({ length: 500 }, (_, i) => `(${from + i}, 'udp-row-${from + i}-${"x".repeat(40)}')`).join(", ");
      await tx.query(`INSERT INTO ND_UDP1 VALUES ${values}`); // 요청 하나가 수십 KB 라 여러 조각으로 나뉜다.
    }
  });
  const result = await db.query("SELECT ID, V FROM ND_UDP1 ORDER BY ID", [], { fetchSize: 300 });
  assert.equal(result.rows.length, 2000);
  assert.ok(result.rows.every((row, index) => row[0] === index && String(row[1]).startsWith(`udp-row-${index}-`)));
  await db.close();
});

test("UDP : 서버의 패킷 크기(udp.maxPacketSize)가 작아도 맞추어 조각으로 나눈다", async () => {
  const small = await TestServer.start({ after: (fn) => after(fn) }, { udp: { maxPacketSize: 200 } });
  const db = await viaUdp(small.port);
  await db.query("CREATE TABLE ND_UDP2 (ID INTEGER PRIMARY KEY, V VARCHAR(2000))");
  const text = "가나다".repeat(300);
  await db.query("INSERT INTO ND_UDP2 VALUES (1, ?)", [text]);
  assert.equal((await db.query("SELECT V FROM ND_UDP2")).rows[0]?.[0], text);
  await db.close();
});

for (const seed of [1, 2, 3]) {
  test(`UDP : 패킷을 15% 잃고 10% 중복되고 지연으로 순서가 뒤바뀌어도 결과가 정확하다 (시드 ${seed})`, async () => {
    const lossy = await proxy({ seed, lossToServer: 0.15, lossToClient: 0.15, duplicate: 0.1, minDelay: 0, maxDelay: 30 });
    const db = await viaUdp(lossy.port);
    await db.query("CREATE TABLE ND_LOSS" + seed + " (ID INTEGER PRIMARY KEY, V VARCHAR(2000))");
    const payload = (n: number): string => `row ${n} ` + String.fromCharCode(0xac00 + n).repeat(700);
    await db.transaction(async (tx) => {
      for (let i = 0; i < 12; i++) await tx.query("INSERT INTO ND_LOSS" + seed + " VALUES (?, ?)", [i, payload(i)]);
    });
    const rows = (await db.query("SELECT ID, V FROM ND_LOSS" + seed + " ORDER BY ID", [], { fetchSize: 5 })).rows;
    assert.equal(rows.length, 12);
    rows.forEach((row, i) => {
      assert.equal(row[0], i);
      assert.equal(row[1], payload(i), `${i}번째 행의 값이 그대로 도착했다`);
    });
    assert.ok(lossy.stats.droppedToServer + lossy.stats.droppedToClient > 0, "시험이 실제로 패킷을 잃게 했다");
    assert.ok(lossy.stats.duplicated > 0, "시험이 실제로 패킷을 중복시켰다");
    await db.close();
  });
}

test("UDP : 서버로 가는 패킷이 모두 사라지면 요청 제한 시간 안에 08006 으로 실패한다", async () => {
  const lossy = await proxy({ seed: 5 });
  const db = await viaUdp(lossy.port, { requestTimeoutMs: 1500 });
  assert.equal((await db.query("SELECT 1")).rows[0]?.[0], 1);
  lossy.blockToServer = true;
  const error = await failure(db.query("SELECT 2"));
  assert.equal(error.sqlState, "08006");
  db.destroy();
});

test("UDP : 서버가 없으면 접속 제한 시간 안에 08006 으로 실패한다", async () => {
  const dead = await proxy({ seed: 6 });
  dead.blockToServer = true;
  const started = Date.now();
  const error = await failure(connect({ port: dead.port, protocol: "udp", ...ADMIN, connectTimeoutMs: 1000 }));
  assert.equal(error.sqlState, "08006");
  assert.ok(Date.now() - started < 5000);
});

test("UDP : 유휴 상태에서도 세션 시간 제한(udp.sessionTimeoutMs)의 1/3 마다 ping 을 보내 세션을 유지한다", async () => {
  const short = await TestServer.start({ after: (fn) => after(fn) }, { udp: { sessionTimeoutMs: 1200 } });
  const db = await viaUdp(short.port);
  await db.query("CREATE TABLE ND_UDP3 (N INTEGER)");
  await sleep(3500); // 시간 제한의 세 배 가까이 아무 문장도 보내지 않는다.
  assert.equal(db.isClosed, false);
  assert.equal((await db.query("SELECT COUNT(*) FROM ND_UDP3")).rows[0]?.[0], 0n, "세션이 살아 있다");
  await db.close();
});

test("UDP : 서버가 세션을 잊은 뒤(패킷이 오래 끊김)에는 접속이 끝났음을 08006 으로 알린다", async () => {
  const short = await TestServer.start({ after: (fn) => after(fn) }, { udp: { sessionTimeoutMs: 1000 } });
  const lossy = await proxy({ seed: 7 }, short);
  const db = await viaUdp(lossy.port);
  const closed = new Promise<DbError | null>((resolve) => db.once("close", (e: DbError | null) => resolve(e)));
  lossy.blockToServer = true; // ping 도 서버에 가지 못한다.
  await sleep(2500); // 서버의 시간 제한을 넘긴다.
  lossy.blockToServer = false;
  // 다시 이어진 뒤 보낸 패킷을 서버가 모르는 세션이라고 답하면(RST) 접속이 끝난다.
  const error = await failure(db.query("SELECT 1"));
  assert.equal(error.sqlState, "08006");
  const closeError = await closed;
  assert.equal(closeError?.sqlState, "08006");
  assert.equal(db.isClosed, true);
});

test("UDP : 서버가 내려가면 57P01 로 알린다", async () => {
  const own = await TestServer.start({ after: (fn) => after(fn) });
  const db = await viaUdp(own.port);
  const closed = new Promise<DbError | null>((resolve) => db.once("close", (e: DbError | null) => resolve(e)));
  await own.stopAsync();
  assert.equal((await closed)?.sqlState, "57P01");
});
