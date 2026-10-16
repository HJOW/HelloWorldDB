/**
 * TLS(SSL) 접속 시험 (12-2, 12-5). 실제 rdbms 를 인증서를 켜고 띄워 수행한다.
 * 서버 인증서는 기본으로 검증하고, 인증서 오류에는 100 ms 뒤 최대 2회 다시 시도한다. (AGENTS.md 상세 8)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";
import { Connection, DbError, connect } from "../src/index.js";
import type { ConnectOptions, SslOptions } from "../src/index.js";
import { TestServer, runnerIsBun, serverIsBun, tlsFixture } from "./helpers/server.js";

const ADMIN = { user: "SYSTEM", password: "HelloWorldDB" } as const;
const CERT_A = fs.readFileSync(tlsFixture("server-a.cert.pem"));
const CERT_B = fs.readFileSync(tlsFixture("server-b.cert.pem"));
const CERT_OTHER = fs.readFileSync(tlsFixture("server-other-name.cert.pem"));

const tlsServer = await TestServer.start(
  { after: (fn) => after(fn) },
  { tcp: { ssl: { certPath: tlsFixture("server-a.cert.pem"), keyPath: tlsFixture("server-a.key.pem") } } },
);

function open(ssl: boolean | SslOptions | undefined, extra: Partial<ConnectOptions> = {}, target: TestServer = tlsServer): Promise<Connection> {
  return connect({ port: target.port, ...ADMIN, ...(ssl === undefined ? {} : { ssl }), connectTimeoutMs: 5000, ...extra });
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

test("신뢰하는 CA 를 지정하면 TLS 로 접속해 조회한다", async () => {
  const db = await open({ ca: CERT_A });
  assert.equal((await db.query("SELECT 'secure'")).rows[0]?.[0], "secure");
  await db.close();
  // 호스트 이름(localhost)으로도 인증서의 이름과 맞는다.
  const named = await open({ ca: CERT_A }, { host: "localhost" });
  assert.equal((await named.query("SELECT 1")).rows[0]?.[0], 1);
  await named.close();
});

test("서버 인증서는 기본으로 검증한다. 자체 서명 인증서를 CA 로 알려 주지 않으면 08001 이고, 다시 시도를 모두 쓴다", async () => {
  const delays: number[] = [];
  const retries: Array<{ attempt: number; maxAttempts: number; code: unknown }> = [];
  const error = await failure(
    open(
      {
        onCertRetry: ({ attempt, maxAttempts, error: cause }) => retries.push({ attempt, maxAttempts, code: (cause as { code?: unknown }).code }),
      },
      { internal: { sleep: async (ms: number) => void delays.push(ms) } },
    ),
  );
  assert.equal(error.sqlState, "08001");
  assert.equal(error.code, 8007);
  assert.match(error.message, /after 3 attempts/);
  assert.deepEqual(delays, [100, 100], "재시도 전에 100 ms 씩 두 번 기다린다");
  assert.deepEqual(retries.map((r) => [r.attempt, r.maxAttempts]), [[1, 2], [2, 2]], "재시도는 최대 2회이다");
  assert.ok(retries.every((r) => typeof r.code === "string"), "원인 코드를 알려 준다");
  assert.ok(error.cause instanceof Error);
});

test("재시도 사이에 실제로 100 ms 를 기다리고, 횟수는 옵션으로 바꿀 수 있다", async () => {
  const started = Date.now();
  const defaults = await failure(open(true));
  assert.ok(Date.now() - started >= 180, `기본은 100 ms 씩 두 번 (${Date.now() - started} ms)`);
  assert.equal(defaults.sqlState, "08001");

  const attempts: number[] = [];
  const none = await failure(open({ certRetries: 0, onCertRetry: ({ attempt }) => attempts.push(attempt) }));
  assert.equal(none.sqlState, "08001");
  assert.match(none.message, /after 1 attempt:/);
  assert.deepEqual(attempts, [], "certRetries 가 0 이면 다시 시도하지 않는다");

  const oneAttempts: number[] = [];
  const one = await failure(open({ certRetries: 1, certRetryDelayMs: 10, onCertRetry: ({ attempt }) => oneAttempts.push(attempt) }));
  assert.match(one.message, /after 2 attempts/);
  assert.deepEqual(oneAttempts, [1]);
});

test("다른 CA 의 인증서(같은 이름이라도)는 믿지 않는다. 검증을 끄면(rejectUnauthorized: false) 접속된다", async () => {
  const wrong = await failure(open({ ca: CERT_B, certRetryDelayMs: 1 }));
  assert.equal(wrong.sqlState, "08001");
  const insecure = await open({ rejectUnauthorized: false });
  assert.equal((await insecure.query("SELECT 2")).rows[0]?.[0], 2);
  await insecure.close();
});

test("인증서의 이름이 접속 대상과 맞지 않으면 거부하고, 확인할 이름(servername)을 알려 주면 접속된다", async () => {
  const other = await TestServer.start(
    { after: (fn) => after(fn) },
    { tcp: { ssl: { certPath: tlsFixture("server-other-name.cert.pem"), keyPath: tlsFixture("server-other-name.key.pem") } } },
  );
  // 신뢰하는 인증서여도 127.0.0.1 은 other.example 이 아니다.
  const mismatch = await failure(open({ ca: CERT_OTHER, certRetryDelayMs: 1 }, {}, other));
  assert.equal(mismatch.sqlState, "08001");
  assert.match(mismatch.message, /ERR_TLS_CERT_ALTNAME_INVALID|altnames|does not match/i);
  const named = await open({ ca: CERT_OTHER, servername: "other.example" }, {}, other);
  assert.equal((await named.query("SELECT 3")).rows[0]?.[0], 3);
  await named.close();
});

test("TLS 서버에 평문으로, 평문 서버에 TLS 로 접속하면 08006 이고 다시 시도하지 않는다", async () => {
  const plainToTls = await failure(open(undefined, { connectTimeoutMs: 3000 }));
  assert.equal(plainToTls.sqlState, "08006");
  const plain = await TestServer.start({ after: (fn) => after(fn) });
  const attempts: number[] = [];
  const tlsToPlain = await failure(open({ ca: CERT_A, onCertRetry: ({ attempt }) => attempts.push(attempt) }, { connectTimeoutMs: 3000 }, plain));
  assert.equal(tlsToPlain.sqlState, "08006");
  assert.deepEqual(attempts, [], "인증서 오류가 아니므로 다시 시도하지 않는다");
});

test("TLS 연결에서도 트랜잭션, 큰 결과, 풀이 동작한다", async () => {
  const db = await open({ ca: CERT_A });
  await db.query("CREATE TABLE ND_TLS (ID INTEGER PRIMARY KEY, V VARCHAR(50))");
  await db.transaction(async (tx) => {
    const values = Array.from({ length: 1500 }, (_, i) => `(${i}, 'value-${i}')`).join(", ");
    await tx.query(`INSERT INTO ND_TLS VALUES ${values}`);
  });
  const result = await db.query("SELECT ID FROM ND_TLS ORDER BY ID", [], { fetchSize: 200 });
  assert.equal(result.rows.length, 1500);
  await db.close();
});

test(
  "TLS 최소 버전을 TLSv1 로 낮춘 서버에 TLS 1.0 으로 접속한다 (Node.js 만. bun 은 구버전 TLS 를 켤 수 없다)",
  { skip: serverIsBun() || runnerIsBun() ? "bun 은 구버전 TLS 를 지원하지 않는다" : false },
  async () => {
    const legacy = await TestServer.start(
      { after: (fn) => after(fn) },
      { tcp: { ssl: { certPath: tlsFixture("server-a.cert.pem"), keyPath: tlsFixture("server-a.key.pem"), minVersion: "TLSv1" } } },
    );
    const db = await open({ ca: CERT_A, minVersion: "TLSv1", maxVersion: "TLSv1", ciphers: "DEFAULT:@SECLEVEL=0" }, {}, legacy);
    assert.equal((await db.query("SELECT 'tls1.0'")).rows[0]?.[0], "tls1.0");
    await db.close();
  },
);
