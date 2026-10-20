/** 접속 생성과 풀 종료가 겹치는 경우를 제어 가능한 접속으로 재현한다. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Connection, createPool } from "../src/index.js";
import { sleep } from "./helpers/server.js";

function pendingConnection() {
  let resolve!: (connection: Connection) => void;
  const promise = new Promise<Connection>((done) => { resolve = done; });
  const fake = new EventEmitter() as EventEmitter & {
    isClosed: boolean; _needsReset: boolean; _lease(fn: () => void): void; destroy(): void;
  };
  fake.isClosed = false;
  fake._needsReset = false;
  fake._lease = () => {};
  fake.destroy = () => { fake.isClosed = true; fake.emit("close", null); };
  return { promise, resolve, connection: fake as unknown as Connection };
}

test("접속 생성 중 풀을 닫으면 제한 시간 없는 acquire도 거부된다", async () => {
  const pending = pendingConnection();
  const connect = Connection.connect;
  Connection.connect = () => pending.promise;
  const pool = createPool({ user: "u", password: "p", max: 1, acquireTimeoutMs: 0 });
  try {
    const acquired = pool.acquire().then(() => "resolved", () => "rejected");
    const closing = pool.close();
    pending.resolve(pending.connection);
    await closing;
    assert.equal(await Promise.race([acquired, sleep(100).then(() => "pending")]), "rejected");
    assert.equal(pending.connection.isClosed, true);
  } finally {
    Connection.connect = connect;
    await pool.close({ force: true });
  }
});

test("접속 생성 중 첫 acquire가 시간 초과되어도 다음 대기자에게 접속을 준다", async () => {
  const pending = pendingConnection();
  const connect = Connection.connect;
  Connection.connect = () => pending.promise;
  const pool = createPool({ user: "u", password: "p", max: 1, acquireTimeoutMs: 200 });
  try {
    const first = pool.acquire().then(() => "resolved", () => "rejected");
    await sleep(100);
    const second = pool.acquire().then((connection) => connection, () => null);
    assert.equal(await first, "rejected");
    pending.resolve(pending.connection);
    assert.equal(await second, pending.connection);
  } finally {
    Connection.connect = connect;
    await pool.close({ force: true });
  }
});
