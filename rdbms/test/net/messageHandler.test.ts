/**
 * 메시지 처리기 테스트 (9단계, 9-4). 소켓 없이 가짜 끝점으로 상태 기계, 인증, 문장 실행, 커서, 제어 요청을 시험한다.
 * 관련 사양 : AGENTS.md 상세 6, 8, 9, 14-1
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createLogger } from "../../src/common/logger.js";
import type { ControlPort } from "../../src/net/messageHandler.js";
import { MessageHandler } from "../../src/net/messageHandler.js";
import { MAX_MESSAGE_BYTES, MAX_OPEN_CURSORS, MAX_PENDING_REQUESTS, MAX_PREAUTH_MESSAGE_BYTES } from "../../src/net/protocol.js";
import { Database } from "../../src/session/session.js";
import type { DatabaseOptions } from "../../src/session/session.js";
import { selectStrings, tempDir } from "../exec/helpers.js";
import { Driver, FakeEndpoint, capturingLogger, makeEnvironment, waitFor } from "./helpers.js";
import type { EnvironmentOptions } from "./helpers.js";

interface Fixture {
  dir: string;
  db: Database;
  env: ReturnType<typeof makeEnvironment>;
  /** 처리기를 열어 구동기를 돌려준다. 시험이 끝나면 정리된다. */
  open(channel?: "local" | "tcp" | "udp", address?: string | null): Driver;
  admin: ReturnType<Database["createSession"]>;
}

function setup(t: { after(fn: () => void): void }, options: DatabaseOptions = {}, envOptions: EnvironmentOptions = {}): Fixture {
  const dir = tempDir(t);
  const db = Database.open(dir, { onWarning: () => {}, scramIterations: 1000, lockTimeoutMs: 3000, ...options });
  const env = makeEnvironment(db, envOptions);
  const drivers: Driver[] = [];
  t.after(() => {
    for (const driver of drivers) driver.handler.dispose();
    db.close();
  });
  const admin = db.createSession({});
  return {
    dir,
    db,
    env,
    admin,
    open(channel = "local", address = channel === "local" ? null : "127.0.0.1") {
      const driver = Driver.open(env, new FakeEndpoint(channel, address));
      assert.ok(driver !== null, "처리기가 열려야 한다");
      drivers.push(driver);
      return driver;
    },
  };
}

async function loggedIn(fixture: Fixture, user = "SYSTEM", password = "HelloWorldDB", channel: "local" | "tcp" | "udp" = "local", address?: string | null): Promise<Driver> {
  const driver = fixture.open(channel, address);
  const result = await driver.login(user, password);
  assert.equal(result.type, "authOk", JSON.stringify(result));
  return driver;
}

function violation(message: { type: string; sqlState?: string; code?: number }): void {
  assert.equal(message.type, "error");
  assert.equal(message.sqlState, "08P01");
  assert.equal(message.code, 8000);
}

// ---------------------------------------------------------------------------
// 핸드셰이크
// ---------------------------------------------------------------------------

test("hello 는 협상한 버전과 서버 정보를 돌려준다", async (t) => {
  const fixture = setup(t);
  const driver = fixture.open();
  const response = await driver.request({ type: "hello", versions: [7, 1, 3], client: "t" });
  assert.equal(response.type, "helloOk");
  assert.equal(response["version"], 1, "공통 버전 중 가장 큰 것");
  assert.equal(response["mechanism"], "SCRAM-SHA-256");
  assert.equal(response["maxMessageBytes"], MAX_MESSAGE_BYTES);
  assert.equal(response["defaultFetchSize"], 500);
  assert.match(response["server"], /^HelloWorldDB /);
  assert.equal("udp" in response, false, "UDP 가 아니면 udp 필드가 없다");
});

test("공통 버전이 없으면 0A000 으로 알리고 접속을 닫는다", async (t) => {
  const fixture = setup(t);
  const driver = fixture.open();
  const response = await driver.request({ type: "hello", versions: [2, 3] });
  assert.equal(response.type, "error");
  assert.equal(response["sqlState"], "0A000");
  assert.equal(response["code"], 1);
  assert.equal(driver.endpoint.closed, true);
  assert.equal(driver.handler.isClosed, true);
});

test("지원하지 않는 인증 방식만 제시하면 0A000 이다", async (t) => {
  const fixture = setup(t);
  const driver = fixture.open();
  const response = await driver.request({ type: "hello", versions: [1], mechanisms: ["PLAIN"] });
  assert.equal(response["sqlState"], "0A000");
  assert.equal(driver.endpoint.closed, true);
});

test("UDP 접속의 helloOk 에는 세션 시간 제한과 패킷 크기가 실린다", async (t) => {
  const fixture = setup(t, {}, { udp: { sessionTimeoutMs: 60000, maxPacketSize: 1200 } });
  const driver = fixture.open("udp", "127.0.0.1");
  const response = await driver.hello();
  assert.deepEqual(response["udp"], { sessionTimeoutMs: 60000, maxPacketSize: 1200 });
  const tcp = fixture.open("tcp", "127.0.0.1");
  assert.equal("udp" in (await tcp.hello()), false);
});

// ---------------------------------------------------------------------------
// 상태 기계
// ---------------------------------------------------------------------------

test("인증 전에는 핸드셰이크와 인증 메시지만 받는다", async (t) => {
  const fixture = setup(t);
  for (const message of [
    { type: "execute", sql: "SELECT 1", params: [] },
    { type: "fetch", cursor: 1 },
    { type: "closeCursor", cursor: 1 },
    { type: "ping" },
    { type: "authStart", mechanism: "SCRAM-SHA-256", clientFirst: "n,,n=SYSTEM,r=abc" },
    { type: "authFinish", clientFinal: "c=biws,r=x,p=y" },
    { type: "close" },
  ]) {
    const driver = fixture.open();
    const response = await driver.request(message);
    violation(response as never);
    assert.equal(driver.endpoint.closed, true, JSON.stringify(message));
  }
});

test("GREETED 에서 받을 수 없는 메시지, 인증 중의 엇갈린 메시지는 위반이다", async (t) => {
  const fixture = setup(t);
  const hello = async (): Promise<Driver> => {
    const driver = fixture.open();
    await driver.hello();
    return driver;
  };
  // hello 를 두 번
  violation((await (await hello()).request({ type: "hello", versions: [1] })) as never);
  // 인증 전의 execute
  violation((await (await hello()).execute("SELECT 1")) as never);
  // authStart 없이 authFinish
  violation((await (await hello()).request({ type: "authFinish", clientFinal: "c=biws,r=x,p=y" })) as never);
  // 인증 중에 authStart 를 다시
  const mid = await hello();
  const challenge = await mid.request({ type: "authStart", mechanism: "SCRAM-SHA-256", clientFirst: "n,,n=SYSTEM,r=abc" });
  assert.equal(challenge.type, "authChallenge");
  violation((await mid.request({ type: "authStart", mechanism: "SCRAM-SHA-256", clientFirst: "n,,n=SYSTEM,r=abc" })) as never);
  const other = await hello();
  await other.request({ type: "authStart", mechanism: "SCRAM-SHA-256", clientFirst: "n,,n=SYSTEM,r=abc" });
  violation((await other.execute("SELECT 1")) as never);
});

test("인증 뒤에는 인증 메시지를 다시 받지 않는다", async (t) => {
  const fixture = setup(t);
  const driver = await loggedIn(fixture);
  violation((await driver.request({ type: "hello", versions: [1] })) as never);
  assert.equal(driver.endpoint.closed, true);
  const second = await loggedIn(fixture);
  violation((await second.request({ type: "authStart", mechanism: "SCRAM-SHA-256", clientFirst: "n,,n=SYSTEM,r=abc" })) as never);
});

test("해석할 수 없는 메시지, 모르는 type, id 없음은 위반이고 접속을 닫는다", async (t) => {
  const fixture = setup(t);
  for (const raw of ["not json", "[1]", '{"type":"ping"}', '{"id":1,"type":"nope"}']) {
    const driver = fixture.open();
    driver.sendRaw(raw);
    violation(await driver.endpoint.next());
    assert.equal(driver.endpoint.closed, true, raw);
  }
  // 인증 후에도 같다.
  const driver = await loggedIn(fixture);
  driver.sendRaw('{"id":5,"type":"nope"}');
  const response = await driver.endpoint.next();
  violation(response);
  assert.equal(response.id, 5);
  assert.equal(driver.endpoint.closed, true);
});

test("필드 값이 틀린 요청은 그 요청만 실패하고 접속은 유지된다 (인증 후)", async (t) => {
  const fixture = setup(t);
  const driver = await loggedIn(fixture);
  const bad = await driver.request({ type: "execute", sql: "SELECT 1", fetchSize: -1 });
  assert.equal(bad["sqlState"], "22023");
  assert.equal(driver.endpoint.closed, false);
  const ok = await driver.execute("SELECT 1");
  assert.equal(ok.type, "rows");
});

test("인증 전의 필드 오류는 접속을 닫는다", async (t) => {
  const fixture = setup(t);
  const driver = fixture.open();
  const response = await driver.request({ type: "hello", versions: "x" });
  assert.equal(response["sqlState"], "22023");
  assert.equal(driver.endpoint.closed, true);
});

test("받을 수 있는 메시지의 최대 크기는 인증 전 64 KiB, 인증 후 16 MiB 이다", async (t) => {
  const fixture = setup(t);
  const driver = fixture.open();
  assert.equal(driver.handler.maxBodyBytes, MAX_PREAUTH_MESSAGE_BYTES);
  await driver.login("SYSTEM", "HelloWorldDB");
  assert.equal(driver.handler.maxBodyBytes, MAX_MESSAGE_BYTES);
  driver.handler.dispose();
  assert.equal(driver.handler.maxBodyBytes, MAX_PREAUTH_MESSAGE_BYTES);
});

// ---------------------------------------------------------------------------
// 인증
// ---------------------------------------------------------------------------

test("프로토타입 속성 이름의 미등록 사용자는 정상 SCRAM 실패로 처리한다", async (t) => {
  const fixture = setup(t);
  const logger = capturingLogger();
  fixture.env.logger = logger;
  for (const name of ["NOBODY", "constructor", "toString", "hasOwnProperty", "__proto__"]) {
    const driver = fixture.open();
    const response = await driver.login(name, "wrong");
    assert.equal(response.type, "error", name);
    assert.equal(response["sqlState"], "28000", name);
    assert.equal(response["code"], 7000, name);
    assert.equal(response["message"], "Authentication failed.", name);
    assert.equal(driver.endpoint.closed, true, name);
  }
  assert.equal(logger.lines.some((line) => line.startsWith("error:")), false);
});

test("프로토타입 속성 이름으로 만든 사용자는 SCRAM 인증이 된다", async (t) => {
  const fixture = setup(t);
  for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    fixture.admin.execute(`CREATE USER "${name}" IDENTIFIED BY 'pw'`);
    const driver = fixture.open();
    const response = await driver.login(name, "pw");
    assert.equal(response.type, "authOk", name);
    assert.equal(response["session"].user, name);
    await driver.request({ type: "close" });
  }
});

test("SCRAM 인증에 성공하면 서버 서명을 검증할 수 있고 세션 정보를 받는다", async (t) => {
  const fixture = setup(t);
  const driver = fixture.open();
  const ok = await driver.login("SYSTEM", "HelloWorldDB");
  assert.equal(ok.type, "authOk");
  const session = ok["session"];
  assert.equal(session.user, "SYSTEM");
  assert.equal(session.tablespace, "SYSTEM");
  assert.equal(session.autocommit, true);
  assert.equal(typeof session.id, "number");
  assert.equal(typeof session.timeZone, "string");
  assert.equal(driver.handler.currentSession?.id, session.id);
  assert.equal(driver.handler.currentSession?.channel, "local");
});

test("따옴표 없는 사용자 이름은 대문자로 찾는다", async (t) => {
  const fixture = setup(t);
  const driver = fixture.open();
  const ok = await driver.login("system", "HelloWorldDB");
  assert.equal(ok.type, "authOk");
  assert.equal(ok["session"].user, "SYSTEM");
});

test("대소문자가 다른 두 사용자가 있으면 정확히 같은 이름이 먼저이다", async (t) => {
  const fixture = setup(t);
  fixture.admin.execute(`CREATE USER "bob" IDENTIFIED BY 'lower'`);
  fixture.admin.execute(`CREATE USER BOB IDENTIFIED BY 'upper'`);
  assert.equal((await fixture.open().login("bob", "lower"))["session"].user, "bob");
  assert.equal((await fixture.open().login("BOB", "upper"))["session"].user, "BOB");
  assert.equal((await fixture.open().login("Bob", "upper"))["session"].user, "BOB");
});

test("틀린 비밀번호와 없는 사용자는 같은 오류이고 접속이 닫힌다 (응답 전에 지연)", async (t) => {
  const fixture = setup(t);
  const wrong = fixture.open();
  const wrongResult = await wrong.login("SYSTEM", "not-the-password");
  const ghost = fixture.open();
  const ghostResult = await ghost.login("GHOST", "whatever");
  for (const result of [wrongResult, ghostResult]) {
    assert.equal(result.type, "error");
    assert.equal(result["sqlState"], "28000");
    assert.equal(result["code"], 7000);
    assert.equal(result["message"], "Authentication failed.");
  }
  // 응답 모양(키 집합)도 같다.
  assert.deepEqual(Object.keys(wrongResult).sort(), Object.keys(ghostResult).sort());
  assert.equal(wrong.endpoint.closed, true);
  assert.equal(ghost.endpoint.closed, true);
  assert.equal(fixture.db.sessions.count, 1, "실패한 인증은 세션을 만들지 않는다 (admin 세션 하나뿐)");
  // 실패 응답 전에 200 ms 지연을 요청했다.
  assert.deepEqual(fixture.env.sleeps, [200, 200]);
});

test("없는 사용자도 같은 절차로 진행하며 챌린지 모양과 솔트가 일정하다", async (t) => {
  const fixture = setup(t);
  const challenge = async (user: string): Promise<Record<string, unknown>> => {
    const driver = fixture.open();
    await driver.hello();
    const first = `n,,n=${user},r=clientnonce`;
    return await driver.request({ type: "authStart", mechanism: "SCRAM-SHA-256", clientFirst: first });
  };
  const real = await challenge("SYSTEM");
  const ghost1 = await challenge("GHOST");
  const ghost2 = await challenge("GHOST");
  const other = await challenge("PHANTOM");
  assert.equal(real["type"], "authChallenge");
  assert.equal(ghost1["type"], "authChallenge");
  assert.deepEqual(Object.keys(real).sort(), Object.keys(ghost1).sort());
  const parse = (value: unknown): { salt: string; iterations: string } => {
    const match = /^r=[^,]+,s=([^,]+),i=(\d+)$/.exec(String(value));
    assert.ok(match !== null);
    return { salt: match[1] as string, iterations: match[2] as string };
  };
  assert.deepEqual(parse(ghost1["serverFirst"]), parse(ghost2["serverFirst"]), "같은 이름은 항상 같은 솔트");
  assert.notEqual(parse(ghost1["serverFirst"]).salt, parse(other["serverFirst"]).salt, "이름이 다르면 솔트도 다르다");
  assert.equal(parse(ghost1["serverFirst"]).iterations, parse(real["serverFirst"]).iterations, "반복 횟수가 실제 계정과 같다");
});

test("서버 nonce 는 클라이언트 nonce 뒤에 붙고 인증마다 새로 만든다", async (t) => {
  const fixture = setup(t);
  const nonces: string[] = [];
  for (let i = 0; i < 2; i++) {
    const driver = fixture.open();
    await driver.hello();
    const challenge = await driver.request({ type: "authStart", mechanism: "SCRAM-SHA-256", clientFirst: "n,,n=SYSTEM,r=abc" });
    const nonce = /^r=([^,]+),/.exec(String(challenge["serverFirst"]))?.[1] as string;
    assert.ok(nonce.startsWith("abc") && nonce.length > 3 + 10);
    nonces.push(nonce);
  }
  assert.notEqual(nonces[0], nonces[1]);
});

test("nonce 가 바뀌었거나 채널 바인딩이 다르면 증명이 맞아도 인증 실패이다", async (t) => {
  const fixture = setup(t);
  // 비밀번호를 아는 클라이언트가 최종 메시지의 한 부분만 바꾸고, 바뀐 메시지에 대해 증명을 올바르게 계산한다.
  // 그래서 증명 검증은 통과하고, 서버가 따로 하는 nonce 와 채널 바인딩 확인만이 이것을 막는다.
  const variants: Array<(combinedNonce: string) => string> = [
    (combined) => `c=biws,r=${combined}FORGED`,
    (combined) => `c=eSws,r=${combined}`,
  ];
  for (const [index, makeWithoutProof] of variants.entries()) {
    const driver = fixture.open();
    await driver.hello();
    const challenge = await driver.request({ type: "authStart", mechanism: "SCRAM-SHA-256", clientFirst: "n,,n=SYSTEM,r=abc" });
    const parsed = /^r=([^,]+),s=([^,]+),i=(\d+)$/.exec(String(challenge["serverFirst"])) as RegExpExecArray;
    const { authMessage, computeClientProof } = await import("../../src/auth/scram.js");
    const withoutProof = makeWithoutProof(parsed[1] as string);
    const message = authMessage("n=SYSTEM,r=abc", String(challenge["serverFirst"]), withoutProof);
    const proof = computeClientProof("HelloWorldDB", parsed[2] as string, Number(parsed[3]), message);
    const response = await driver.request({ type: "authFinish", clientFinal: `${withoutProof},p=${proof}` });
    assert.equal(response["sqlState"], "28000", `variant ${index}`);
    assert.equal(response["message"], "Authentication failed.");
    assert.equal(driver.endpoint.closed, true);
  }
  // 대조군 : 아무것도 바꾸지 않으면 같은 방식으로 계산한 증명이 통과한다.
  const control = fixture.open();
  assert.equal((await control.login("SYSTEM", "HelloWorldDB")).type, "authOk");
});

test("잘못된 SCRAM 메시지 형식은 위반이다", async (t) => {
  const fixture = setup(t);
  for (const clientFirst of ["garbage", "y,,n=A,r=x", "n,,n=,r=x", "n,,n=A=bad,r=x"]) {
    const driver = fixture.open();
    await driver.hello();
    violation((await driver.request({ type: "authStart", mechanism: "SCRAM-SHA-256", clientFirst })) as never);
  }
  const driver = fixture.open();
  await driver.hello();
  await driver.request({ type: "authStart", mechanism: "SCRAM-SHA-256", clientFirst: "n,,n=SYSTEM,r=abc" });
  violation((await driver.request({ type: "authFinish", clientFinal: "not a final message" })) as never);
  const other = fixture.open();
  await other.hello();
  violation((await other.request({ type: "authStart", mechanism: "OTHER", clientFirst: "n,,n=SYSTEM,r=abc" })) as never);
});

test("authStart 의 테이블스페이스와 타임존이 세션에 적용된다", async (t) => {
  const fixture = setup(t);
  fixture.admin.execute("CREATE TABLESPACE APP");
  const driver = fixture.open();
  const ok = await driver.login("SYSTEM", "HelloWorldDB", { tablespace: "APP", timeZone: "+09:00" });
  assert.equal(ok["session"].tablespace, "APP");
  assert.equal(ok["session"].timeZone, "+09:00");
});

test("없는 테이블스페이스나 잘못된 타임존은 인증 뒤 오류로 알리고 접속을 닫는다", async (t) => {
  const fixture = setup(t);
  const noTablespace = await fixture.open().login("SYSTEM", "HelloWorldDB", { tablespace: "NOPE" });
  assert.equal(noTablespace["sqlState"], "3D000");
  const badZone = fixture.open();
  const result = await badZone.login("SYSTEM", "HelloWorldDB", { timeZone: "Mars/Base" });
  assert.equal(result.type, "error");
  assert.equal(badZone.endpoint.closed, true);
});

test("기본 테이블스페이스가 없는 사용자의 세션 정보는 tablespace 가 null 이다", async (t) => {
  const fixture = setup(t);
  fixture.admin.execute("CREATE USER NOTS IDENTIFIED BY 'pw'");
  const ok = await fixture.open().login("NOTS", "pw");
  assert.equal(ok.type, "authOk");
  assert.equal(ok["session"].tablespace, null);
});

// ---------------------------------------------------------------------------
// 접속 정책
// ---------------------------------------------------------------------------

test("CONNECT 가 없는 사용자의 원격 접속은 인증 뒤에 인증 실패와 구별되는 오류로 거부된다", async (t) => {
  const fixture = setup(t);
  const remote = fixture.open("tcp", "10.20.30.40");
  const result = await remote.login("SYSTEM", "HelloWorldDB");
  assert.equal(result.type, "error");
  assert.equal(result["sqlState"], "28000");
  assert.equal(result["code"], 7006, "CONNECT 거부는 인증 실패(7000)와 번호가 다르다");
  assert.match(result["message"], /CONNECT/);
  assert.equal(remote.endpoint.closed, true);
  // 비밀번호가 틀리면 CONNECT 여부와 상관없이 인증 실패이다.
  const wrong = await fixture.open("tcp", "10.20.30.40").login("SYSTEM", "bad");
  assert.equal(wrong["code"], 7000);
  // CONNECT 를 주면 같은 주소에서 접속된다. 루프백은 처음부터 된다.
  fixture.admin.execute("GRANT CONNECT TO SYSTEM");
  assert.equal((await fixture.open("tcp", "10.20.30.40").login("SYSTEM", "HelloWorldDB")).type, "authOk");
  fixture.admin.execute("REVOKE CONNECT FROM SYSTEM");
  assert.equal((await fixture.open("tcp", "127.0.0.1").login("SYSTEM", "HelloWorldDB")).type, "authOk");
  assert.equal((await fixture.open("udp", "::1").login("SYSTEM", "HelloWorldDB")).type, "authOk");
});

test("maxConnections 는 TCP, UDP 세션만 세고 로컬 전용 채널은 항상 받는다", async (t) => {
  const fixture = setup(t, { maxConnections: 2 });
  await loggedIn(fixture, "SYSTEM", "HelloWorldDB", "tcp", "127.0.0.1");
  await loggedIn(fixture, "SYSTEM", "HelloWorldDB", "udp", "127.0.0.1");
  // 가득 찬 뒤의 새 TCP, UDP 는 hello 에서 일찍 거절한다.
  for (const channel of ["tcp", "udp"] as const) {
    const refused = fixture.open(channel, "127.0.0.1");
    const response = await refused.hello();
    assert.equal(response["sqlState"], "53300");
    assert.equal(response["code"], 8001);
    assert.equal(refused.endpoint.closed, true);
  }
  // 로컬 전용 채널은 가득 차도 받는다.
  await loggedIn(fixture, "SYSTEM", "HelloWorldDB", "local");
  await loggedIn(fixture, "SYSTEM", "HelloWorldDB", "local");
  assert.equal(fixture.db.sessions.countRemote(), 2);
});

test("hello 와 인증 사이에 자리가 찼으면 Database.connect 가 마지막으로 막는다", async (t) => {
  const fixture = setup(t, { maxConnections: 1 });
  const first = fixture.open("tcp", "127.0.0.1");
  const second = fixture.open("tcp", "127.0.0.1");
  // 둘 다 hello 를 통과한다(아직 자리가 비어 있다).
  assert.equal((await first.hello()).type, "helloOk");
  assert.equal((await second.hello()).type, "helloOk");
  // 먼저 인증을 끝낸 쪽이 자리를 차지한다. 두 번째는 인증에는 성공하지만 접속이 거부된다.
  const finish = async (driver: Driver, nonce: string): Promise<Record<string, unknown>> => {
    const { authMessage, clientFinalWithoutProof, clientFirstBare, clientFirstMessage, computeClientProof, parseServerFirst } = await import("../../src/auth/scram.js");
    const challenge = await driver.request({ type: "authStart", mechanism: "SCRAM-SHA-256", clientFirst: clientFirstMessage("SYSTEM", nonce) });
    const parsed = parseServerFirst(challenge["serverFirst"] as string) as { nonce: string; salt: string; iterations: number };
    const withoutProof = clientFinalWithoutProof(parsed.nonce);
    const message = authMessage(clientFirstBare("SYSTEM", nonce), challenge["serverFirst"] as string, withoutProof);
    const proof = computeClientProof("HelloWorldDB", parsed.salt, parsed.iterations, message);
    return await driver.request({ type: "authFinish", clientFinal: `${withoutProof},p=${proof}` });
  };
  assert.equal((await finish(first, "nonce-one")).type, "authOk");
  const refused = await finish(second, "nonce-two");
  assert.equal(refused["sqlState"], "53300");
  assert.equal(second.endpoint.closed, true);
});

test("인증 전 접속 수 제한을 넘는 TCP, UDP 접속은 열리지 않고, 로컬 전용 채널은 제한을 받지 않는다", (t) => {
  const fixture = setup(t, {}, { limits: { maxPreAuth: 2 } });
  const endpoints = [0, 1].map(() => MessageHandler.open(fixture.env, new FakeEndpoint("tcp", "127.0.0.1")));
  assert.ok(endpoints.every((handler) => handler !== null));
  assert.equal(fixture.env.limits.preAuthCount, 2);
  assert.equal(MessageHandler.open(fixture.env, new FakeEndpoint("tcp", "127.0.0.1")), null);
  assert.equal(MessageHandler.open(fixture.env, new FakeEndpoint("udp", "127.0.0.1")), null);
  const local = MessageHandler.open(fixture.env, new FakeEndpoint("local", null));
  assert.ok(local !== null, "로컬 전용 채널은 제한을 받지 않는다");
  assert.equal(fixture.env.limits.preAuthCount, 2, "로컬은 자리를 쓰지 않는다");
  // 접속이 끝나면 자리를 돌려준다.
  endpoints[0]?.dispose();
  assert.equal(fixture.env.limits.preAuthCount, 1);
  assert.ok(MessageHandler.open(fixture.env, new FakeEndpoint("tcp", "127.0.0.1")) !== null);
  for (const handler of endpoints) handler?.dispose();
  local.dispose();
});

test("인증을 마치면 인증 전 자리를 돌려준다", async (t) => {
  const fixture = setup(t);
  const driver = fixture.open("tcp", "127.0.0.1");
  assert.equal(fixture.env.limits.preAuthCount, 1);
  await driver.login("SYSTEM", "HelloWorldDB");
  assert.equal(fixture.env.limits.preAuthCount, 0);
  driver.handler.dispose();
  assert.equal(fixture.env.limits.preAuthCount, 0, "두 번 돌려주지 않는다");
});

test("인증 시간 제한을 넘기면 응답 없이 접속을 닫는다", async (t) => {
  const fixture = setup(t, {}, { limits: { authTimeoutMs: 30 } });
  const idle = fixture.open("tcp", "127.0.0.1");
  await waitFor(() => idle.endpoint.closed, 3000, "the authentication timeout");
  assert.equal(idle.endpoint.sent.length, 0, "오류 메시지를 보내지 않는다");
  assert.equal(fixture.env.limits.preAuthCount, 0);
  // hello 만 하고 멈춘 접속도 같다.
  const half = fixture.open("local");
  await half.hello();
  await waitFor(() => half.endpoint.closed, 3000, "the authentication timeout after hello");
  // 인증을 마친 접속에는 적용되지 않는다.
  const ready = await loggedIn(fixture);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(ready.endpoint.closed, false);
});

// ---------------------------------------------------------------------------
// 문장 실행
// ---------------------------------------------------------------------------

test("Hello World 두 샘플이 그대로 실행된다", async (t) => {
  const fixture = setup(t);
  const driver = await loggedIn(fixture);
  const hello = await driver.execute("SELECT 'Hello World'");
  assert.equal(hello.type, "rows");
  assert.deepEqual(hello["rows"], [["Hello World"]]);
  assert.equal(hello["hasMore"], false);
  assert.equal(hello["columns"].length, 1);
  assert.equal(hello["columns"][0].typeName, "VARCHAR");
  assert.equal("cursor" in hello, false);

  assert.equal((await driver.execute("CREATE TABLE HELLO (MESSAGE VARCHAR)"))["type"], "ok");
  const inserted = await driver.execute("INSERT INTO HELLO VALUES ('Hello World')");
  assert.equal(inserted.type, "ok");
  assert.equal(inserted["rowCount"], 1);
  const selected = await driver.execute("SELECT * FROM HELLO");
  assert.deepEqual(selected["rows"], [["Hello World"]]);
  assert.equal(selected["columns"][0].name, "MESSAGE");
  assert.equal(selected["columns"][0].declared, "VARCHAR(65535)");
});

test("값 표현 : BIGINT 와 NUMERIC 은 문자열, 이진은 16진, 날짜시간은 문자열이다", async (t) => {
  const fixture = setup(t);
  const driver = await loggedIn(fixture);
  await driver.execute("CREATE TABLE V (I INTEGER, B BIGINT, D DECIMAL(10,3), F DOUBLE PRECISION, BO BOOLEAN, BI VARBINARY(4), DT DATE, TS TIMESTAMP(3), N VARCHAR(5))");
  const inserted = await driver.execute(
    "INSERT INTO V (I, B, D, F, BO, DT, TS) VALUES (7, 5000000000, 1.5, 2.5, TRUE, '2026-10-15', '2026-10-15 13:05:07.250')",
  );
  assert.equal(inserted.type, "ok", JSON.stringify(inserted));
  const rows = await driver.execute("SELECT I, B, D, F, BO, DT, TS, N FROM V");
  assert.deepEqual(rows["rows"], [[7, "5000000000", "1.500", 2.5, true, "2026-10-15", "2026-10-15 13:05:07.250", null]]);
  assert.deepEqual(
    rows["columns"].map((column: { typeName: string }) => column.typeName),
    ["INTEGER", "BIGINT", "DECIMAL", "DOUBLE PRECISION", "BOOLEAN", "DATE", "TIMESTAMP", "VARCHAR"],
  );
});

test("파라미터를 바인딩한다 (정수, 문자열, NULL, 이진, 큰 정수 문자열)", async (t) => {
  const fixture = setup(t);
  const driver = await loggedIn(fixture);
  await driver.execute("CREATE TABLE P (I INTEGER, B BIGINT, S VARCHAR(20), BI VARBINARY(4))");
  const insert = await driver.execute("INSERT INTO P VALUES (?, ?, ?, ?)", [42, "9007199254740993", "한글", { binary: "ab12" }]);
  assert.equal(insert.type, "ok", JSON.stringify(insert));
  await driver.execute("INSERT INTO P VALUES (?, ?, ?, ?)", [null, null, null, null]);
  const rows = await driver.execute("SELECT I, B, S, BI FROM P ORDER BY I");
  assert.deepEqual(rows["rows"], [[42, "9007199254740993", "한글", "AB12"], [null, null, null, null]]);
  // 개수 불일치
  assert.equal((await driver.execute("SELECT ?", []))["sqlState"], "07001");
  // 안전 정수를 벗어난 JSON 숫자
  assert.equal((await driver.execute("SELECT ?", [9007199254740993]))["sqlState"], "22003");
  // 접속은 유지된다.
  assert.equal((await driver.execute("SELECT 1", [])).type, "rows");
});

test("문장 오류는 접속을 끊지 않고 SQLSTATE, 번호, 위치를 싣는다", async (t) => {
  const fixture = setup(t);
  const driver = await loggedIn(fixture);
  const syntax = await driver.execute("SELEC 1");
  assert.equal(syntax.type, "error");
  assert.equal(syntax["sqlState"], "42601");
  assert.equal(syntax["code"], 3000);
  assert.deepEqual(Object.keys(syntax["position"]).sort(), ["column", "line", "offset"]);
  assert.equal(syntax["position"].line, 1);
  const missing = await driver.execute("SELECT * FROM NO_SUCH_TABLE");
  assert.equal(missing["sqlState"], "42P01");
  assert.equal("position" in missing, true);
  assert.equal(driver.endpoint.closed, false);
  assert.equal((await driver.execute("SELECT 1")).type, "rows");
  // 한 번의 요청에 문장이 둘이면 문법 오류이다.
  assert.equal((await driver.execute("SELECT 1; SELECT 2"))["sqlState"], "42601");
});

test("권한 오류도 문장 오류이다", async (t) => {
  const fixture = setup(t);
  fixture.admin.execute("CREATE TABLESPACE APP");
  fixture.admin.execute("CREATE TABLE APP.SECRET (X INTEGER)");
  fixture.admin.execute("CREATE USER ALICE IDENTIFIED BY 'pw' DEFAULT TABLESPACE APP");
  const alice = await loggedIn(fixture, "ALICE", "pw", "local");
  const denied = await alice.execute("SELECT * FROM SECRET");
  assert.equal(denied["sqlState"], "42501");
  assert.equal(denied["code"], 7001);
  assert.equal(alice.endpoint.closed, false);
  fixture.admin.execute("GRANT SELECT ON APP.SECRET TO ALICE");
  assert.equal((await alice.execute("SELECT * FROM SECRET")).type, "rows", "권한 변경은 다음 문장부터 적용된다");
});

test("트랜잭션 문장과 커밋, 롤백이 동작한다", async (t) => {
  const fixture = setup(t);
  const a = await loggedIn(fixture);
  await a.execute("CREATE TABLE T (X INTEGER)");
  await a.execute("BEGIN");
  await a.execute("INSERT INTO T VALUES (1)");
  const b = await loggedIn(fixture);
  assert.deepEqual((await b.execute("SELECT COUNT(*) FROM T"))["rows"], [["0"]], "커밋 전의 변경은 다른 세션에 보이지 않는다");
  await a.execute("COMMIT");
  assert.deepEqual((await b.execute("SELECT X FROM T"))["rows"], [[1]]);
  await a.execute("BEGIN");
  await a.execute("INSERT INTO T VALUES (2)");
  await a.execute("SAVEPOINT S1");
  await a.execute("INSERT INTO T VALUES (3)");
  await a.execute("ROLLBACK TO S1");
  await a.execute("ROLLBACK");
  assert.deepEqual((await b.execute("SELECT X FROM T ORDER BY X"))["rows"], [[1]]);
  const unknown = await a.execute("ROLLBACK TO NOPE");
  assert.equal(unknown["sqlState"] === "25P01" || unknown["sqlState"] === "3B001", true);
});

test("ping 은 pong 을 돌려주고 유휴 시간을 되돌리지 않는다", async (t) => {
  const fixture = setup(t);
  const driver = await loggedIn(fixture);
  const session = driver.handler.currentSession;
  assert.ok(session !== null);
  const before = session.lastActivity;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await driver.request({ type: "ping" })).type, "pong");
  assert.equal(session.lastActivity, before);
});

// ---------------------------------------------------------------------------
// 커서
// ---------------------------------------------------------------------------

async function tableWithRows(driver: Driver, rows: number): Promise<void> {
  await driver.execute("CREATE TABLE BIG (N INTEGER, S VARCHAR(20))");
  const chunk = 400;
  for (let start = 1; start <= rows; start += chunk) {
    const values: string[] = [];
    for (let n = start; n < start + chunk && n <= rows; n++) values.push(`(${n}, 'row ${n}')`);
    const result = await driver.execute(`INSERT INTO BIG VALUES ${values.join(", ")}`);
    assert.equal(result.type, "ok", JSON.stringify(result));
  }
}

test("큰 결과는 묶음으로 나누어 보내고 마지막 묶음에서 커서가 사라진다", async (t) => {
  const fixture = setup(t);
  const driver = await loggedIn(fixture);
  await tableWithRows(driver, 1200);
  const first = await driver.execute("SELECT N FROM BIG ORDER BY N");
  assert.equal(first["rows"].length, 500, "기본 묶음은 500행");
  assert.equal(first["hasMore"], true);
  assert.equal(first["cursor"], 1);
  assert.ok(Array.isArray(first["columns"]));
  const second = await driver.request({ type: "fetch", cursor: 1 });
  assert.equal(second["rows"].length, 500);
  assert.equal(second["hasMore"], true);
  assert.equal(second["cursor"], 1);
  assert.equal("columns" in second, false, "fetch 응답에는 columns 가 없다");
  const third = await driver.request({ type: "fetch", cursor: 1 });
  assert.equal(third["rows"].length, 200);
  assert.equal(third["hasMore"], false);
  assert.equal("cursor" in third, false);
  const all = [...first["rows"], ...second["rows"], ...third["rows"]].map((row: number[]) => row[0]);
  assert.deepEqual(all, Array.from({ length: 1200 }, (_, i) => i + 1), "빠짐도 중복도 없이 순서대로 온다");
  // 마지막 묶음 뒤의 fetch 는 커서가 없다.
  const gone = await driver.request({ type: "fetch", cursor: 1 });
  assert.equal(gone["sqlState"], "34000");
  assert.equal(gone["code"], 8004);
  assert.equal(driver.endpoint.closed, false);
});

test("fetchSize 로 묶음 행 수를 정한다", async (t) => {
  const fixture = setup(t);
  const driver = await loggedIn(fixture);
  await tableWithRows(driver, 100);
  const first = await driver.execute("SELECT N FROM BIG ORDER BY N", [], 30);
  assert.equal(first["rows"].length, 30);
  const next = await driver.request({ type: "fetch", cursor: first["cursor"], fetchSize: 50 });
  assert.equal(next["rows"].length, 50);
  assert.equal(next["rows"][0][0], 31);
  const rest = await driver.request({ type: "fetch", cursor: first["cursor"] });
  assert.equal(rest["rows"].length, 20, "fetchSize 를 생략하면 기본 묶음(500)이다");
  assert.equal(rest["hasMore"], false);
  // 상한(100,000)을 넘는 값은 줄인다. (오류가 아니다)
  const clamp = await driver.execute("SELECT N FROM BIG", [], 5_000_000);
  assert.equal(clamp["rows"].length, 100);
});

test("행 수가 묶음과 같으면 한 번에 끝난다", async (t) => {
  const fixture = setup(t);
  const driver = await loggedIn(fixture);
  await tableWithRows(driver, 500);
  const result = await driver.execute("SELECT N FROM BIG");
  assert.equal(result["rows"].length, 500);
  assert.equal(result["hasMore"], false);
  assert.equal("cursor" in result, false);
  const empty = await driver.execute("SELECT N FROM BIG WHERE N < 0");
  assert.deepEqual(empty["rows"], []);
  assert.equal(empty["hasMore"], false);
  assert.ok(Array.isArray(empty["columns"]), "결과가 비어도 컬럼 정보는 온다");
});

test("closeCursor 는 남은 행을 버리고 없는 커서를 닫아도 오류가 아니다", async (t) => {
  const fixture = setup(t);
  const driver = await loggedIn(fixture);
  await tableWithRows(driver, 600);
  const first = await driver.execute("SELECT N FROM BIG");
  assert.equal((await driver.request({ type: "closeCursor", cursor: first["cursor"] })).type, "cursorClosed");
  assert.equal((await driver.request({ type: "fetch", cursor: first["cursor"] }))["sqlState"], "34000");
  assert.equal((await driver.request({ type: "closeCursor", cursor: 99 })).type, "cursorClosed");
  assert.equal((await driver.request({ type: "fetch", cursor: 99 }))["sqlState"], "34000");
});

test("커서는 커밋, 롤백, 새 문장과 무관하게 유효하다 (홀더블)", async (t) => {
  const fixture = setup(t);
  const driver = await loggedIn(fixture);
  await tableWithRows(driver, 700);
  await driver.execute("BEGIN");
  const first = await driver.execute("SELECT N FROM BIG ORDER BY N");
  await driver.execute("DELETE FROM BIG");
  await driver.execute("ROLLBACK");
  await driver.execute("DELETE FROM BIG WHERE N > 1000");
  const rest = await driver.request({ type: "fetch", cursor: first["cursor"] });
  assert.equal(rest["rows"].length, 200, "문장이 실행된 시점의 행을 복사해 둔 것이다");
  assert.equal(rest["rows"][0][0], 501);
});

test("커서는 접속마다 따로 번호를 매기고 열린 커서는 16개까지이다", async (t) => {
  const fixture = setup(t);
  const driver = await loggedIn(fixture);
  await tableWithRows(driver, 600);
  const cursors: number[] = [];
  for (let i = 0; i < MAX_OPEN_CURSORS; i++) {
    const result = await driver.execute("SELECT N FROM BIG", [], 10);
    assert.equal(result["cursor"], i + 1);
    cursors.push(result["cursor"]);
  }
  const over = await driver.execute("SELECT N FROM BIG", [], 10);
  assert.equal(over["sqlState"], "53400");
  assert.equal(over["code"], 8005);
  assert.equal(driver.endpoint.closed, false);
  // 하나를 닫으면 다시 열 수 있다. 번호는 계속 늘어난다.
  await driver.request({ type: "closeCursor", cursor: 3 });
  const again = await driver.execute("SELECT N FROM BIG", [], 10);
  assert.equal(again["cursor"], MAX_OPEN_CURSORS + 1);
  // 한 번에 끝나는 결과는 커서를 쓰지 않으므로 한도와 무관하다.
  const small = await driver.execute("SELECT 1");
  assert.equal(small.type, "rows");
  // 다른 접속은 자기 커서 번호를 1부터 센다.
  const other = await loggedIn(fixture);
  assert.equal((await other.execute("SELECT N FROM BIG", [], 10))["cursor"], 1);
  assert.equal((await other.request({ type: "fetch", cursor: 2 }))["sqlState"], "34000");
});

// ---------------------------------------------------------------------------
// 종료와 정리
// ---------------------------------------------------------------------------

test("close 는 bye 로 답하고 접속을 닫고 커밋하지 않은 변경을 롤백한다", async (t) => {
  const fixture = setup(t);
  const a = await loggedIn(fixture);
  await a.execute("CREATE TABLE T (X INTEGER PRIMARY KEY)");
  await a.execute("INSERT INTO T VALUES (1)");
  await a.execute("BEGIN");
  await a.execute("INSERT INTO T VALUES (2)");
  await a.execute("UPDATE T SET X = 10 WHERE X = 1");
  const sessions = fixture.db.sessions.count;
  const bye = await a.request({ type: "close" });
  assert.equal(bye.type, "bye");
  assert.equal(bye["rolledBack"], true, "커밋하지 않은 변경을 롤백했음을 알린다");
  assert.equal(a.endpoint.closed, true);
  assert.equal(fixture.db.sessions.count, sessions - 1);
  // 롤백되었고 잠금도 풀렸다.
  fixture.admin.execute("USE SYSTEM");
  assert.deepEqual(selectStrings(fixture.admin.execute("SELECT X FROM T")).rows, [["1"]]);
  assert.doesNotThrow(() => fixture.admin.execute("UPDATE T SET X = 11 WHERE X = 1"));
});

test("bye 의 rolledBack 은 롤백한 변경이 있을 때만 있다", async (t) => {
  const fixture = setup(t);
  const setupDriver = await loggedIn(fixture);
  await setupDriver.execute("CREATE TABLE T (X INTEGER PRIMARY KEY)");
  assert.equal((await setupDriver.request({ type: "close" }))["rolledBack"], undefined, "아무것도 하지 않았다");

  const cases: Array<[string[], boolean]> = [
    [["INSERT INTO T VALUES (1)"], false], // 자동 커밋
    [["BEGIN", "SELECT 1"], false], // 트랜잭션은 열려 있지만 변경이 없다
    [["BEGIN", "INSERT INTO T VALUES (2)", "COMMIT"], false],
    [["BEGIN", "INSERT INTO T VALUES (3)", "ROLLBACK"], false],
    [["BEGIN", "INSERT INTO T VALUES (4)", "SAVEPOINT S", "DELETE FROM T WHERE X = 4", "ROLLBACK TO S"], true], // 세이브포인트 앞의 변경이 남는다
    [["SET AUTOCOMMIT OFF", "UPDATE T SET X = 20 WHERE X = 1"], true],
    [["SET AUTOCOMMIT OFF", "SELECT 1"], false],
    [["BEGIN", "INSERT INTO T VALUES (5)", "SAVEPOINT S", "ROLLBACK TO S", "ROLLBACK"], false],
  ];
  for (const [statements, expected] of cases) {
    const driver = await loggedIn(fixture);
    for (const sql of statements) {
      const result = await driver.execute(sql);
      assert.notEqual(result.type, "error", `${sql}: ${JSON.stringify(result)}`);
    }
    const bye = await driver.request({ type: "close" });
    assert.equal(bye.type, "bye");
    assert.equal(bye["rolledBack"], expected ? true : undefined, statements.join("; "));
  }
});

test("접속이 갑자기 사라져도(dispose) 롤백하고 잠금을 푼다", async (t) => {
  const fixture = setup(t);
  const a = await loggedIn(fixture);
  await a.execute("CREATE TABLE T (X INTEGER)");
  await a.execute("INSERT INTO T VALUES (1)");
  await a.execute("BEGIN");
  await a.execute("UPDATE T SET X = 2");
  a.handler.dispose();
  assert.equal(a.handler.currentSession, null);
  assert.deepEqual(selectStrings(fixture.admin.execute("SELECT X FROM SYSTEM.T")).rows, [["1"]]);
  assert.doesNotThrow(() => fixture.admin.execute("UPDATE SYSTEM.T SET X = 3"));
  // dispose 는 여러 번 불러도 안전하다.
  a.handler.dispose();
});

test("닫은 뒤에 도착한 메시지는 무시한다", async (t) => {
  const fixture = setup(t);
  const a = await loggedIn(fixture);
  await a.request({ type: "close" });
  const sent = a.endpoint.sent.length;
  a.send({ type: "execute", sql: "SELECT 1", params: [] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(a.endpoint.sent.length, sent);
});

test("잠금을 기다리는 문장이 있어도 close 가 대기열을 건너뛰어 접속을 끝낸다", async (t) => {
  const fixture = setup(t);
  fixture.admin.execute("CREATE TABLE L (X INTEGER)");
  fixture.admin.execute("INSERT INTO L VALUES (1)");
  fixture.admin.execute("BEGIN");
  fixture.admin.execute("UPDATE L SET X = 2");
  const waiter = await loggedIn(fixture);
  waiter.send({ type: "execute", sql: "UPDATE SYSTEM.L SET X = 3", params: [] });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(waiter.endpoint.unread, 0, "잠금을 기다리는 중이라 아직 응답이 없다");
  waiter.send({ type: "ping" });
  const closeId = waiter.send({ type: "close" });
  const bye = await waiter.endpoint.next();
  assert.equal(bye.type, "bye");
  assert.equal(bye.id, closeId);
  assert.equal(waiter.endpoint.closed, true);
  const sentAtClose = waiter.endpoint.sent.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(waiter.endpoint.sent.length, sentAtClose, "닫힌 뒤에는 기다리던 문장의 응답도 보내지 않는다");
  fixture.admin.execute("ROLLBACK");
});

test("요청 대기열이 64개를 넘으면 53400 으로 접속을 끊는다", async (t) => {
  const fixture = setup(t);
  fixture.admin.execute("CREATE TABLE L (X INTEGER)");
  fixture.admin.execute("INSERT INTO L VALUES (1)");
  fixture.admin.execute("BEGIN");
  fixture.admin.execute("UPDATE L SET X = 2");
  const flooded = await loggedIn(fixture);
  flooded.send({ type: "execute", sql: "UPDATE SYSTEM.L SET X = 3", params: [] });
  await new Promise((resolve) => setTimeout(resolve, 30));
  for (let i = 0; i < MAX_PENDING_REQUESTS + 1; i++) flooded.send({ type: "ping" });
  const error = await flooded.endpoint.next();
  assert.equal(error.type, "error");
  assert.equal(error["sqlState"], "53400");
  assert.equal(error["code"], 8005);
  assert.equal(flooded.endpoint.closed, true);
  fixture.admin.execute("ROLLBACK");
});

test("교착으로 롤백된 뒤에도 접속과 세션은 유지된다", async (t) => {
  const fixture = setup(t);
  fixture.admin.execute("CREATE TABLE D (K INTEGER PRIMARY KEY, V INTEGER)");
  fixture.admin.execute("INSERT INTO D VALUES (1, 0), (2, 0)");
  const a = await loggedIn(fixture);
  const b = await loggedIn(fixture);
  await a.execute("BEGIN");
  await b.execute("BEGIN");
  await a.execute("UPDATE SYSTEM.D SET V = 1 WHERE K = 1");
  await b.execute("UPDATE SYSTEM.D SET V = 1 WHERE K = 2");
  a.send({ type: "execute", sql: "UPDATE SYSTEM.D SET V = 2 WHERE K = 2", params: [] });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const victim = await b.execute("UPDATE SYSTEM.D SET V = 2 WHERE K = 1");
  assert.equal(victim["sqlState"], "40P01");
  assert.equal(b.endpoint.closed, false, "교착 뒤에도 접속은 유지된다");
  // b 가 롤백되었으므로 a 의 기다리던 문장이 끝난다.
  const aResult = await a.endpoint.next();
  assert.equal(aResult.type, "ok");
  assert.equal((await b.execute("SELECT COUNT(*) FROM SYSTEM.D")).type, "rows");
  await a.execute("ROLLBACK");
});

test("유휴 시간 초과로 세션이 닫히면 id 0 오류를 보내고 접속을 닫는다", async (t) => {
  const fixture = setup(t, { idleTimeoutMs: 60_000 });
  const driver = await loggedIn(fixture);
  fixture.db.sessions.sweepIdle(Date.now() + 120_000);
  const message = await driver.endpoint.next();
  assert.equal(message.id, 0);
  assert.equal(message.type, "error");
  assert.equal(message["sqlState"], "57P05");
  assert.equal(message["code"], 8002);
  assert.equal(driver.endpoint.closed, true);
});

test("서버가 종료되면 id 0 오류(57P01)를 보내고 접속을 닫는다", async (t) => {
  const dir = tempDir(t);
  const db = Database.open(dir, { onWarning: () => {}, scramIterations: 1000 });
  const env = makeEnvironment(db);
  const driver = Driver.open(env, new FakeEndpoint("tcp", "127.0.0.1")) as Driver;
  await driver.login("SYSTEM", "HelloWorldDB");
  db.close();
  const message = await driver.endpoint.next();
  assert.equal(message.id, 0);
  assert.equal(message["sqlState"], "57P01");
  assert.equal(message["code"], 6003);
  assert.equal(driver.endpoint.closed, true);
});

test("보내기가 밀려 있는 동안에는 다음 요청을 처리하지 않는다", async (t) => {
  const fixture = setup(t);
  const driver = await loggedIn(fixture);
  let release: () => void = () => {};
  driver.endpoint.drainGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  driver.send({ type: "ping" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(driver.endpoint.unread, 0, "밀린 동안은 응답을 만들지 않는다");
  release();
  assert.equal((await driver.endpoint.next()).type, "pong");
});

test("한 접속의 요청은 도착 순서대로 응답한다", async (t) => {
  const fixture = setup(t);
  const driver = await loggedIn(fixture);
  const ids = [
    driver.send({ type: "execute", sql: "SELECT 1", params: [] }),
    driver.send({ type: "ping" }),
    driver.send({ type: "execute", sql: "SELECT 2", params: [] }),
    driver.send({ type: "ping" }),
  ];
  const received: number[] = [];
  for (let i = 0; i < ids.length; i++) received.push((await driver.endpoint.next()).id);
  assert.deepEqual(received, ids);
});

// ---------------------------------------------------------------------------
// 제어 요청
// ---------------------------------------------------------------------------

function controlPort(): ControlPort & { stops: number } {
  const port = {
    stops: 0,
    controlToken: (): string => "token-123",
    status: () => ({
      running: true,
      port: 7410,
      pid: 4321,
      startedAt: "2026-10-16T00:00:00.000Z",
      version: "0.1.0",
      dataDir: "/data",
      tcpEnabled: true,
      udpEnabled: false,
      sessionCount: 3,
      ready: true,
      systemPasswordInitial: false,
    }),
    requestStop: (): void => {
      port.stops++;
    },
  };
  return port;
}

test("제어 요청 status 는 로컬 전용 채널의 GREETED 에서 토큰만으로 받는다", async (t) => {
  const control = controlPort();
  const fixture = setup(t, {}, { control });
  const driver = fixture.open("local");
  await driver.hello();
  const status = await driver.request({ type: "control", action: "status", token: "token-123" });
  assert.equal(status.type, "status");
  assert.equal(status["running"], true);
  assert.equal(status["port"], 7410);
  assert.equal(status["pid"], 4321);
  assert.equal(status["sessionCount"], 3);
  assert.equal(status["udpEnabled"], false);
  assert.equal(driver.endpoint.closed, false, "status 뒤에도 같은 접속으로 이어서 쓸 수 있다");
  assert.equal(control.stops, 0);
});

test("제어 요청 stop 은 stopping 을 보내고 접속을 닫은 뒤 종료를 요청한다", async (t) => {
  const control = controlPort();
  const fixture = setup(t, {}, { control });
  const driver = fixture.open("local");
  await driver.hello();
  const response = await driver.request({ type: "control", action: "stop", token: "token-123" });
  assert.equal(response.type, "stopping");
  assert.equal(driver.endpoint.closed, true);
  assert.equal(control.stops, 1);
});

test("제어 토큰이 틀리면 인증 실패와 같은 오류이고 접속을 끊는다 (로그에 토큰이 없다)", async (t) => {
  const control = controlPort();
  const logger = capturingLogger();
  const fixture = setup(t, {}, { control, logger });
  const driver = fixture.open("local");
  await driver.hello();
  const response = await driver.request({ type: "control", action: "stop", token: "wrong-token-xyz" });
  assert.equal(response["sqlState"], "28000");
  assert.equal(response["code"], 7000);
  assert.equal(response["message"], "Authentication failed.");
  assert.equal(driver.endpoint.closed, true);
  assert.equal(control.stops, 0);
  assert.ok(logger.lines.every((line) => !line.includes("wrong-token-xyz") && !line.includes("token-123")));
});

test("제어 요청은 로컬 전용 채널이 아니거나 GREETED 가 아니면 42501 이다", async (t) => {
  const control = controlPort();
  const fixture = setup(t, {}, { control });
  // TCP, UDP 에서는 받지 않는다.
  for (const channel of ["tcp", "udp"] as const) {
    const driver = fixture.open(channel, "127.0.0.1");
    await driver.hello();
    const response = await driver.request({ type: "control", action: "stop", token: "token-123" });
    assert.equal(response["sqlState"], "42501");
    assert.equal(response["code"], 7001);
    assert.equal(driver.endpoint.closed, true);
  }
  // hello 전
  const early = fixture.open("local");
  const earlyResponse = await early.request({ type: "control", action: "status", token: "token-123" });
  assert.equal(earlyResponse["sqlState"], "42501");
  // 인증 뒤(READY)에도 받지 않지만 세션은 유지한다.
  const ready = await loggedIn(fixture);
  const readyResponse = await ready.request({ type: "control", action: "stop", token: "token-123" });
  assert.equal(readyResponse["sqlState"], "42501");
  assert.equal(ready.endpoint.closed, false);
  assert.equal(control.stops, 0);
});

test("제어 창구가 없는 구성에서는 제어 요청을 받지 않는다", async (t) => {
  const fixture = setup(t);
  const driver = fixture.open("local");
  await driver.hello();
  assert.equal((await driver.request({ type: "control", action: "status", token: "x" }))["sqlState"], "42501");
});

test("제어 요청은 인증 전 접속 수 제한을 받지 않는다", async (t) => {
  const control = controlPort();
  const fixture = setup(t, {}, { control, limits: { maxPreAuth: 0 } });
  const driver = fixture.open("local");
  await driver.hello();
  assert.equal((await driver.request({ type: "control", action: "status", token: "token-123" })).type, "status");
});

// ---------------------------------------------------------------------------
// 로그
// ---------------------------------------------------------------------------

test("로그에는 비밀번호와 SCRAM 값이 남지 않고, 인증 실패의 원인은 debug 로만 구별된다", async (t) => {
  const dir = tempDir(t);
  const logger = createLogger({ level: "debug", dir: path.join(dir, "logs"), foreground: false });
  const fixture = setup(t, {}, { logger });
  const driver = await loggedIn(fixture);
  await driver.execute("CREATE USER LEAKY IDENTIFIED BY 'sup3r-secret-pw'");
  await driver.execute("ALTER USER LEAKY IDENTIFIED BY 'another-secret-pw'");
  const wrong = fixture.open("tcp", "127.0.0.1");
  await wrong.login("LEAKY", "bad-guess-pw");
  const ghost = fixture.open("tcp", "127.0.0.1");
  await ghost.login("GHOST", "ghost-guess-pw");
  await logger.close();
  const text = fs.readFileSync(path.join(dir, "logs", "helloworlddb.log"), "utf8");
  for (const secret of ["sup3r-secret-pw", "another-secret-pw", "bad-guess-pw", "ghost-guess-pw", "HelloWorldDB"]) {
    assert.equal(text.includes(secret), false, `로그에 ${secret} 가 있으면 안 된다`);
  }
  assert.match(text, /Authentication failed: user="LEAKY"/);
  assert.match(text, /Authentication failed: user="GHOST"/);
  assert.match(text, /failure reason: wrong password/);
  assert.match(text, /failure reason: no such user/);
  assert.match(text, /Session \d+ opened: user=SYSTEM/);
});
