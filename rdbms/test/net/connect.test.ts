/**
 * 접속 정책 테스트 (9단계, 9-3) : 루프백 판정, `Database.connect` 의 CONNECT 검사와 `maxConnections`, SYS_SESSIONS 의 새 열.
 * 관련 사양 : AGENTS.md 상세 6, 9, 14
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isLoopbackAddress } from "../../src/common/address.js";
import { DbError } from "../../src/common/errors.js";
import { Database } from "../../src/session/session.js";
import { selectStrings, tempDir } from "../exec/helpers.js";

function open(t: { after(fn: () => void): void }, maxConnections?: number): Database {
  const dir = tempDir(t);
  const db = Database.open(dir, { onWarning: () => {}, scramIterations: 1000, maxConnections });
  t.after(() => db.close());
  return db;
}

function isError(sqlState: string, code?: number): (error: unknown) => boolean {
  return (error) => error instanceof DbError && error.sqlState === sqlState && (code === undefined || error.code === code);
}

test("루프백 주소 판정", () => {
  for (const address of ["127.0.0.1", "127.255.255.254", "127.1.2.3", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:127.9.9.9", "::FFFF:7f00:1", "::1%lo"]) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of ["10.0.0.1", "192.168.0.10", "128.0.0.1", "126.255.255.255", "::2", "::", "fe80::1", "::ffff:10.0.0.1", "::ffff:c0a8:1", "2001:db8::1", "localhost", "", "not an address", "127.0.0", "1.127.0.0"]) {
    assert.equal(isLoopbackAddress(address), false, address);
  }
  assert.equal(isLoopbackAddress(null), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test("로컬 전용 채널은 CONNECT 가 없어도 항상 받는다", (t) => {
  const db = open(t);
  const session = db.connect({ user: "SYSTEM", channel: "local", remoteAddress: null });
  assert.equal(session.channel, "local");
  assert.equal(session.remoteAddress, null);
});

test("TCP, UDP 에서 루프백이 아닌 주소는 원격이라 CONNECT 가 필요하다", (t) => {
  const db = open(t);
  for (const channel of ["tcp", "udp"] as const) {
    assert.throws(
      () => db.connect({ user: "SYSTEM", channel, remoteAddress: "192.168.0.10" }),
      isError("28000", 7006),
      channel,
    );
  }
  assert.equal(db.sessions.count, 0, "거부된 접속은 세션을 남기지 않는다");

  // CONNECT 를 주면 같은 주소에서 들어온다.
  const admin = db.createSession({});
  admin.execute("GRANT CONNECT TO SYSTEM");
  const remote = db.connect({ user: "SYSTEM", channel: "tcp", remoteAddress: "192.168.0.10" });
  assert.equal(remote.channel, "tcp");
  assert.equal(remote.remoteAddress, "192.168.0.10");
  // 회수해도 이미 맺어진 세션은 끊지 않는다. 새 접속만 거부한다.
  admin.execute("REVOKE CONNECT FROM SYSTEM");
  assert.equal(remote.isClosed, false);
  assert.throws(() => db.connect({ user: "SYSTEM", channel: "tcp", remoteAddress: "192.168.0.11" }), isError("28000", 7006));
});

test("TCP, UDP 에서도 루프백 주소는 CONNECT 없이 로컬 접속이다", (t) => {
  const db = open(t);
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    for (const channel of ["tcp", "udp"] as const) {
      const session = db.connect({ user: "SYSTEM", channel, remoteAddress: address });
      assert.equal(session.channel, channel);
      session.close();
    }
  }
});

test("없는 사용자나 없는 테이블스페이스는 세션을 만들지 않는다", (t) => {
  const db = open(t);
  assert.throws(() => db.connect({ user: "NOBODY", channel: "local", remoteAddress: null }), isError("42704"));
  assert.throws(() => db.connect({ user: "SYSTEM", tablespace: "NOPE", channel: "local", remoteAddress: null }), isError("3D000"));
  assert.throws(() => db.connect({ user: "SYSTEM", timeZone: "Mars/Base", channel: "local", remoteAddress: null }));
  assert.equal(db.sessions.count, 0);
});

test("maxConnections 는 TCP, UDP 세션 수의 상한이고 로컬 전용 채널은 세지도 막지도 않는다", (t) => {
  const db = open(t, 2);
  const local1 = db.connect({ user: "SYSTEM", channel: "local", remoteAddress: null });
  const tcp = db.connect({ user: "SYSTEM", channel: "tcp", remoteAddress: "127.0.0.1" });
  const udp = db.connect({ user: "SYSTEM", channel: "udp", remoteAddress: "127.0.0.1" });
  assert.equal(db.sessions.countRemote(), 2);
  assert.equal(db.isConnectionLimitReached(), true);

  assert.throws(() => db.connect({ user: "SYSTEM", channel: "tcp", remoteAddress: "127.0.0.1" }), isError("53300", 8001));
  assert.throws(() => db.connect({ user: "SYSTEM", channel: "udp", remoteAddress: "127.0.0.1" }), isError("53300", 8001));

  // 가득 찬 상태에서도 로컬 전용 채널은 받는다.
  const local2 = db.connect({ user: "SYSTEM", channel: "local", remoteAddress: null });
  const local3 = db.connect({ user: "SYSTEM", channel: "local", remoteAddress: null });
  assert.equal(db.sessions.count, 5);
  assert.equal(db.sessions.countRemote(), 2);

  // 하나가 나가면 자리가 난다.
  tcp.close();
  assert.equal(db.isConnectionLimitReached(), false);
  const again = db.connect({ user: "SYSTEM", channel: "udp", remoteAddress: "127.0.0.1" });
  assert.equal(again.channel, "udp");
  for (const session of [local1, local2, local3, udp, again]) session.close();
});

test("CONNECT 가 없는 사용자의 원격 접속은 접속 수 제한보다 먼저 CONNECT 오류이다", (t) => {
  const db = open(t, 1);
  const admin = db.createSession({});
  admin.execute("CREATE USER ALICE IDENTIFIED BY 'pw'");
  db.connect({ user: "SYSTEM", channel: "tcp", remoteAddress: "127.0.0.1" });
  assert.throws(() => db.connect({ user: "ALICE", channel: "tcp", remoteAddress: "10.1.1.1" }), isError("28000", 7006));
});

test("maxConnections 를 주지 않으면 제한이 없다", (t) => {
  const db = open(t);
  for (let i = 0; i < 30; i++) db.connect({ user: "SYSTEM", channel: "tcp", remoteAddress: "127.0.0.1" });
  assert.equal(db.sessions.countRemote(), 30);
  assert.equal(db.isConnectionLimitReached(), false);
});

test("createSession 의 기본 접속 경로는 local 이다", (t) => {
  const db = open(t, 1);
  const session = db.createSession({});
  assert.equal(session.channel, "local");
  assert.equal(db.sessions.countRemote(), 0);
});

test("SYS_SESSIONS 는 끝에 CHANNEL, CLIENT_ADDRESS 를 더하고 기존 열의 순서는 그대로이다", (t) => {
  const db = open(t);
  const admin = db.connect({ user: "SYSTEM", channel: "local", remoteAddress: null });
  const tcp = db.connect({ user: "SYSTEM", channel: "tcp", remoteAddress: "127.0.0.1" });
  const udp = db.connect({ user: "SYSTEM", channel: "udp", remoteAddress: "::1" });
  const view = selectStrings(admin.execute("SELECT * FROM SYS_SESSIONS ORDER BY SESSION_ID"));
  assert.deepEqual(view.columns, ["SESSION_ID", "USER_NAME", "TABLESPACE_NAME", "AUTOCOMMIT", "IN_TRANSACTION", "CHANNEL", "CLIENT_ADDRESS"]);
  assert.deepEqual(
    view.rows.map((row) => row.slice(5)),
    [["LOCAL", "NULL"], ["TCP", "127.0.0.1"], ["UDP", "::1"]],
  );
  tcp.close();
  udp.close();
});
