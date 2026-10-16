/**
 * 11단계 통합 검증 : 개요 7 (config.json), 8 (TCP, UDP, SSL 통신), 14 (데몬 구동과 CLI).
 *
 * 모두 실제 `hwdb start` 프로세스를 띄우고 `hwdb` 명령과 클라이언트 라이브러리로 접속해 본다.
 * 같은 사양을 프로세스 안에서 자세히 시험한 것은 test/config, test/net, test/cli 에 있다. 여기서는 설치한 그대로의 제품이 사양대로 움직이는지 본다.
 *
 * 관련 사양 : AGENTS.md 상세 7, 8, 14
 * 구현 단계 : 11단계
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { Connection } from "../../src/client/connection.js";
import type { SslOptions } from "../../src/client/connection.js";
import { DEFAULT_PORT, getLocalChannelAddress, LOCK_FILE_NAME } from "../../src/common/instance.js";
import { readLockFile } from "../../src/daemon/lockFile.js";
import { LossyProxy } from "../net/udpProxy.js";
import { Daemon, daemonIsBun, daemonRuntime, exec, num, query, scalar, sleep, tlsFixture } from "./helpers.js";

const SYSTEM_ARGS = ["-u", "SYSTEM", "-p", "HelloWorldDB"];
const CERT = tlsFixture("server-a.cert.pem");
const KEY = tlsFixture("server-a.key.pem");

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

/** 조건이 참이 될 때까지 기다린다. */
async function eventually(condition: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(100);
  }
}

/** 비동기 동작이 DB 오류로 실패하기를 기대하고 그 오류를 돌려준다. */
async function rejection(action: () => Promise<unknown>): Promise<{ sqlState?: string; message: string }> {
  try {
    await action();
  } catch (error) {
    return error as { sqlState?: string; message: string };
  }
  throw new Error("The action should have failed.");
}

/** 로그에서 수준별 줄을 센다. 줄 형식은 `<ISO 시각> [<수준>] <메시지>` 이다. */
function logLevels(log: string): Set<string> {
  const levels = new Set<string>();
  for (const match of log.matchAll(/^\S+ \[(\w+)\]/gm)) levels.add(match[1] as string);
  return levels;
}

// ---------------------------------------------------------------------------
// 개요 7 : config.json
// ---------------------------------------------------------------------------

// 기본 포트(7410)를 이미 누가 쓰고 있으면 기본값으로 구동하는 시험은 건너뛴다. (다른 시험은 모두 비어 있는 포트를 따로 고른다)
const defaultPortBusy = (await tcpOpen(DEFAULT_PORT)) || fs.existsSync(getLocalChannelAddress(DEFAULT_PORT));

test("개요 7 : config.json 이 없으면 전부 기본값으로 구동된다 (포트 7410, ./data, ./logs, TCP 와 UDP 사용, 최대 10세션)",
  { skip: defaultPortBusy ? `The default port ${DEFAULT_PORT} is in use on this machine.` : false }, async (t) => {
    const daemon = await Daemon.create(t);
    daemon.removeConfig();
    assert.equal(daemon.port, DEFAULT_PORT);
    daemon.start();
    const status = daemon.hwdb(["status"]);
    assert.match(status.stdout, new RegExp(`port: ${DEFAULT_PORT}\\b`));
    assert.match(status.stdout, /tcp: on/);
    assert.match(status.stdout, /udp: on/);
    assert.ok(fs.existsSync(path.join(daemon.installDir, "data")), "데이터 디렉토리는 설치 디렉토리 아래의 ./data");
    assert.ok(fs.existsSync(path.join(daemon.installDir, "logs", "helloworlddb.log")), "로그 디렉토리는 ./logs");
    assert.match(daemon.log(), /maxConnections=10/);
    for (const kind of ["local", "tcp", "udp"] as const) assert.equal(await num(await daemon.connect(kind), "SELECT 1"), 1, kind);
  });

test("개요 7 : 필요한 키만 적으면 나머지는 기본값을 쓰고, 모르는 키는 경고를 남기고 무시한다", async (t) => {
  const daemon = await Daemon.create(t, { tcp: { enabled: false, bogus: 1 }, nonsenseKey: true });
  daemon.start();
  const status = daemon.hwdb(["status"]);
  assert.match(status.stdout, /tcp: off/);
  assert.match(status.stdout, /udp: on/, "적지 않은 udp 는 기본값(사용)");
  const log = daemon.log();
  assert.match(log, /maxConnections=10/, "적지 않은 maxConnections 는 기본값 10");
  assert.match(log, /\[warn\] Unknown config key "nonsenseKey"; ignored\./);
  assert.match(log, /\[warn\] Unknown config key "tcp\.bogus"; ignored\./);
  assert.equal(await num(await daemon.connect("udp"), "SELECT 1"), 1, "경고만 남기고 정상 구동한다");
});

test("개요 7 : 값이 올바르지 않거나 읽을 수 없는 config.json 이면 구동에 실패하고 원인을 알린다 (데몬도 잠금 파일도 남지 않는다)", async (t) => {
  const cases: Array<[string, Record<string, unknown> | string, RegExp]> = [
    ["maxConnections 가 0", { maxConnections: 0 }, /"maxConnections" must be an integer >= 1/],
    ["port 가 범위 밖", { port: 70000 }, /"port"/],
    ["dataDir 가 문자열이 아님", { dataDir: 5 }, /"dataDir"/],
    ["log.level 이 없는 수준", { log: { level: "verbose" } }, /"log\.level"/],
    ["udp.maxPacketSize 가 너무 작음", { udp: { maxPacketSize: 10 } }, /"udp\.maxPacketSize" must be an integer between 64 and 65507/],
    ["tcp.ssl 에 인증서만 있음", { tcp: { ssl: { certPath: CERT } } }, /"tcp\.ssl\.certPath" and "tcp\.ssl\.keyPath" must be set together/],
    ["tcp.ssl.minVersion 이 없는 버전", { tcp: { ssl: { certPath: CERT, keyPath: KEY, minVersion: "SSLv3" } } }, /minVersion/],
    ["JSON 문법 오류", "{ not json", /config\.json/i],
  ];
  for (const [label, config, expected] of cases) {
    const daemon = await Daemon.create(t);
    if (typeof config === "string") fs.writeFileSync(path.join(daemon.installDir, "config.json"), config, "utf8");
    else daemon.writeConfig({ port: daemon.port, ...config });
    const result = daemon.hwdb(["start", "--timeout", "30"]);
    assert.equal(result.status, 1, `${label} : ${result.stdout}`);
    assert.match(result.stderr, expected, label);
    assert.equal(daemon.pid, null, `${label} : 데몬이 남지 않는다`);
    assert.equal(fs.existsSync(path.join(daemon.dataDir, LOCK_FILE_NAME)), false, `${label} : 잠금 파일이 남지 않는다`);
    assert.equal(daemon.hwdb(["status"]).status, 1);
  }
});

test("개요 7 : 상대 경로는 config.json 이 있는 디렉토리를 기준으로 한다 (시험을 돌리는 현재 디렉토리가 아니다)", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.updateConfig({ dataDir: "./mydata", log: { dir: "./mylogs" } });
  const cwdData = path.resolve("mydata");
  const cwdLogs = path.resolve("mylogs");
  assert.equal(fs.existsSync(cwdData) || fs.existsSync(cwdLogs), false, "미리 있으면 시험이 의미 없다");
  daemon.start();
  await exec(await daemon.connect("tcp"), "CREATE TABLE T (N INTEGER)");
  assert.ok(fs.existsSync(path.join(daemon.installDir, "mydata", "SYSTEM.hwdb")), "데이터 파일이 설치 디렉토리의 ./mydata 에 생긴다");
  assert.ok(fs.existsSync(path.join(daemon.installDir, "mylogs", "helloworlddb.log")), "로그가 설치 디렉토리의 ./mylogs 에 생긴다");
  assert.equal(fs.existsSync(path.join(daemon.installDir, "data")), false, "기본 위치에는 만들지 않는다");
  assert.equal(fs.existsSync(cwdData) || fs.existsSync(cwdLogs), false, "현재 디렉토리에 만들지 않는다");
  // 절대 경로는 그대로 쓴다.
  daemon.stopClean();
  const elsewhere = fs.mkdtempSync(path.join(path.dirname(daemon.installDir), "hwdb-abs-"));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.cpSync(path.join(daemon.installDir, "mydata"), path.join(elsewhere, "data"), { recursive: true });
  daemon.updateConfig({ dataDir: path.join(elsewhere, "data"), log: { dir: path.join(elsewhere, "logs") } });
  daemon.start();
  assert.equal(await num(await daemon.connect("tcp"), "SELECT COUNT(*) FROM T"), 0, "복사한 데이터를 절대 경로로 연다");
  assert.ok(fs.existsSync(path.join(elsewhere, "logs", "helloworlddb.log")));
});

test("개요 7 : config.json 은 구동할 때 한 번만 읽는다 (바꾼 내용은 재시작해야 적용된다)", async (t) => {
  const daemon = await Daemon.create(t, { maxConnections: 2 });
  daemon.start();
  await daemon.connect("tcp");
  await daemon.connect("tcp");
  assert.equal((await rejection(() => daemon.connect("tcp"))).sqlState, "53300", "최대 2세션");
  daemon.updateConfig({ maxConnections: 5 });
  assert.equal((await rejection(() => daemon.connect("tcp"))).sqlState, "53300", "떠 있는 데몬은 바뀐 설정을 보지 않는다");
  assert.equal(daemon.hwdb(["status"]).status, 0);
  daemon.stopClean();
  daemon.start();
  for (let n = 0; n < 5; n++) await daemon.connect("tcp");
  assert.equal((await rejection(() => daemon.connect("tcp"))).sqlState, "53300", "재시작하면 5세션까지");
});

test("개요 7 : timeZone 은 세션 기본 타임존이다 (+09:00, -05:00, Asia/Seoul, local)", async (t) => {
  const daemon = await Daemon.create(t, { timeZone: "+09:00" });
  const offsetOf = async (): Promise<string> => {
    const value = await scalar(await daemon.connect("tcp"), "SELECT CURRENT_TIMESTAMP");
    return String(value).slice(-6);
  };
  daemon.start();
  assert.equal(await offsetOf(), "+09:00");
  let c = await daemon.connect("tcp");
  assert.match(String(await scalar(c, "SELECT CAST(TIMESTAMP '2026-01-01 00:00:00' AS TIMESTAMP WITH TIME ZONE)")), /\+09:00$/, "세션 타임존으로 해석한다");
  // 세션에서 바꾸면 그 세션만 바뀐다.
  await exec(c, "SET TIME ZONE '-05:00'");
  assert.equal(String(await scalar(c, "SELECT CURRENT_TIMESTAMP")).slice(-6), "-05:00");
  assert.equal(await offsetOf(), "+09:00", "다른 세션은 기본값 그대로");
  for (const [setting, expected] of [["-05:00", "-05:00"], ["Asia/Seoul", "+09:00"]] as const) {
    daemon.stopClean();
    daemon.updateConfig({ timeZone: setting });
    daemon.start();
    assert.equal(await offsetOf(), expected, setting);
  }
  // "local" 은 서버 OS 의 타임존이다.
  daemon.stopClean();
  daemon.updateConfig({ timeZone: "local" });
  daemon.start();
  c = await daemon.connect("tcp");
  // 기대값은 데몬을 돌리는 런타임이 보는 OS 시간대에서 구한다. (bun test 는 시험 프로세스의 시간대를 UTC 로 두므로 이 프로세스의 값을 쓰지 않는다)
  const offsetMinutes = Number(spawnSync(daemonRuntime(), ["-e", "console.log(-new Date().getTimezoneOffset())"], { encoding: "utf8" }).stdout.trim());
  assert.ok(Number.isInteger(offsetMinutes));
  const sign = offsetMinutes < 0 ? "-" : "+";
  const hh = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0");
  const mm = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
  assert.equal(String(await scalar(c, "SELECT CURRENT_TIMESTAMP")).slice(-6), `${sign}${hh}:${mm}`);
});

test("개요 7 : session.idleTimeoutMs 를 주면 유휴 세션을 닫고, log.level 이 로그 수준을 정한다", async (t) => {
  const daemon = await Daemon.create(t, { session: { idleTimeoutMs: 1500 } });
  daemon.start();
  const busy = await daemon.connect("tcp");
  const idle = await daemon.connect("tcp");
  for (let n = 0; n < 7; n++) { await sleep(500); await num(busy, "SELECT 1"); }
  assert.equal((await rejection(() => query(idle, "SELECT 1"))).sqlState, "57P05", "쓰지 않은 세션은 닫힌다");
  assert.equal(await num(busy, "SELECT 1"), 1, "계속 쓰는 세션은 닫히지 않는다");

  // 로그 수준 : info 는 구동 기록을, warn 은 경고만, error 는 둘 다 남기지 않는다. (SYSTEM 이 초기 암호이면 구동할 때 경고가 있다)
  const expectations: Array<[string, boolean, boolean]> = [["info", true, true], ["warn", false, true], ["error", false, false]];
  for (const [level, hasInfo, hasWarn] of expectations) {
    daemon.stopClean();
    fs.rmSync(path.dirname(daemon.logPath), { recursive: true, force: true });
    daemon.updateConfig({ session: { idleTimeoutMs: 0 }, log: { level } });
    daemon.start();
    const levels = logLevels(daemon.log());
    assert.equal(levels.has("info"), hasInfo, `log.level=${level} info`);
    assert.equal(levels.has("warn"), hasWarn, `log.level=${level} warn`);
  }
});

// ---------------------------------------------------------------------------
// 개요 8 : TCP, UDP, SSL
// ---------------------------------------------------------------------------

test("개요 8 : TCP 와 UDP 가 같은 포트 번호로 동시에 접속을 받고, config.json 으로 각각 끌 수 있다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const tcp = await daemon.connect("tcp");
  const udp = await daemon.connect("udp");
  await exec(tcp, "CREATE TABLE T (N INTEGER)");
  await exec(tcp, "INSERT INTO T VALUES (7)");
  assert.equal(await num(udp, "SELECT N FROM T"), 7);

  for (const [off, other] of [["tcp", "udp"], ["udp", "tcp"]] as const) {
    daemon.stopClean();
    daemon.updateConfig({ [off]: { enabled: false } });
    daemon.start();
    const status = daemon.hwdb(["status"]);
    assert.match(status.stdout, new RegExp(`${off}: off`));
    assert.match(status.stdout, new RegExp(`${other}: on`));
    assert.equal(await num(await daemon.connect(other), "SELECT N FROM T"), 7, `${off} 를 꺼도 ${other} 는 된다`);
    if (off === "tcp") assert.equal(await tcpOpen(daemon.port), false, "TCP 를 끄면 포트가 닫힌다");
    else await assert.rejects(() => Connection.open({ kind: "udp", host: "127.0.0.1", port: daemon.port }, { internal: { connectTimeoutMs: 1500 } }), "UDP 를 끄면 응답이 없다");
    assert.equal(await num(await daemon.connect("local"), "SELECT N FROM T"), 7, "로컬 전용 채널은 언제나 열린다");
    daemon.updateConfig({ [off]: { enabled: true } });
  }
});

test("개요 8 : SSL 인증서와 개인키를 주면 TCP 포트 전체가 TLS 이고 평문 TCP 는 받지 않는다. UDP 는 영향이 없다", async (t) => {
  const daemon = await Daemon.create(t, { tcp: { ssl: { certPath: CERT, keyPath: KEY } } });
  daemon.start();
  assert.match(daemon.log(), /Listening:.*tcp=\S+ \((?!plain)/, "구동 로그가 TLS 로 연다고 알린다");

  const secure = await daemon.connect("tls");
  assert.equal(await num(secure, "SELECT 1"), 1);
  await assert.rejects(() => daemon.connect("tcp"), "평문 TCP 접속은 받지 않는다");
  assert.equal(await num(await daemon.connect("udp"), "SELECT 2"), 2, "UDP 구간은 SSL 과 무관하게 평문으로 돌아간다");
  assert.equal(await num(await daemon.connect("local"), "SELECT 3"), 3);

  // 서버 인증서는 기본으로 검증한다. 신뢰하지 않는 CA 이면 접속을 끊고 100ms 뒤 최대 2회 다시 시도한 끝에 실패한다.
  const attempts: number[] = [];
  const untrusted: SslOptions = { ca: fs.readFileSync(tlsFixture("server-b.cert.pem")), onCertRetry: (info) => attempts.push(info.attempt) };
  const failed = await rejection(() => daemon.connect("tls", { ssl: untrusted }));
  assert.equal(failed.sqlState, "08001");
  assert.match(failed.message, /after 3 attempts/);
  assert.deepEqual(attempts, [1, 2], "다시 시도는 최대 2회");
  // 검증을 끄는 방법도 있다.
  const unverified = await daemon.connect("tls", { ssl: { rejectUnauthorized: false } });
  assert.equal(await num(unverified, "SELECT 4"), 4);

  // hwdb 의 옵션
  const base = ["-h", "127.0.0.1", "-P", String(daemon.port), ...SYSTEM_ARGS, "-e", "SELECT 'Hello World'"];
  const withCa = daemon.hwdb([...base, "--ssl", "--ssl-ca", CERT]);
  assert.equal(withCa.status, 0, withCa.stderr);
  assert.match(withCa.stdout, /Hello World/);
  const noCa = daemon.hwdb([...base, "--ssl"]);
  assert.equal(noCa.status, 1);
  assert.match(noCa.stderr, /retrying 1\/2/);
  assert.match(noCa.stderr, /retrying 2\/2/);
  assert.match(noCa.stderr, /--ssl-ca/);
  assert.match(noCa.stderr, /--ssl-no-verify/);
  const noVerify = daemon.hwdb([...base, "--ssl", "--ssl-no-verify"]);
  assert.equal(noVerify.status, 0, noVerify.stderr);
  const plain = daemon.hwdb(base);
  assert.equal(plain.status, 1, "TLS 포트에 평문으로 접속하는 hwdb 는 실패한다");
  const udpSsl = daemon.hwdb(["-h", "127.0.0.1", "--udp", "--ssl", ...SYSTEM_ARGS, "-e", "SELECT 1"]);
  assert.equal(udpSsl.status, 1);
  assert.match(udpSsl.stderr, /--udp and --ssl cannot be used together/);
  const udpOnly = daemon.hwdb(["-h", "127.0.0.1", "-P", String(daemon.port), "--udp", ...SYSTEM_ARGS, "-e", "SELECT 'over udp'"]);
  assert.equal(udpOnly.status, 0, udpOnly.stderr);
  assert.match(udpOnly.stdout, /over udp/);
});

test("개요 8 : TLS 최소 버전은 기본 TLSv1.2 이고, 낮추면 경고를 남기고 그 버전의 클라이언트를 받는다 (Java 6 대비)",
  { skip: daemonIsBun() ? "bun 은 TLS 서버의 최소 버전과 구버전 TLS 를 적용하지 못한다 (docs/protocol.md 16절)" : false }, async (t) => {
    const daemon = await Daemon.create(t, { tcp: { ssl: { certPath: CERT, keyPath: KEY } } });
    daemon.start();
    assert.equal(logLevels(daemon.log()).has("warn") && /TLSv1\b.*insecure|insecure.*TLSv1\b/.test(daemon.log()), false, "기본값에서는 구버전 경고가 없다");
    const ca = fs.readFileSync(CERT);
    // 1.2 와 1.3 은 받는다.
    for (const version of ["TLSv1.2", "TLSv1.3"] as const) {
      const c = await daemon.connect("tls", { ssl: { ca, minVersion: version, maxVersion: version } });
      assert.equal(await num(c, "SELECT 1"), 1, version);
    }
    // 1.1 이하만 되는 클라이언트는 받지 않는다.
    const old: SslOptions = { ca, minVersion: "TLSv1", maxVersion: "TLSv1.1", ciphers: "DEFAULT:@SECLEVEL=0" };
    await assert.rejects(() => daemon.connect("tls", { ssl: old }), "기본 최소 버전 TLSv1.2 가 TLS 1.1 을 막는다");

    // 최소 버전을 TLSv1 로 낮추면 경고를 남긴다.
    daemon.stopClean();
    daemon.updateConfig({ tcp: { ssl: { certPath: CERT, keyPath: KEY, minVersion: "TLSv1" } } });
    daemon.start();
    assert.match(daemon.log(), /\[warn\].*TLSv1.*insecure/i, "구동 로그에 경고");
    try {
      const c = await daemon.connect("tls", { ssl: { ca, minVersion: "TLSv1", maxVersion: "TLSv1", ciphers: "DEFAULT:@SECLEVEL=0" } });
      assert.equal(await num(c, "SELECT 1"), 1);
    } catch (error) {
      // 이 Node.js 와 OpenSSL 빌드가 TLS 1.0 을 협상하지 못하면 서버 설정까지만 확인한 것으로 한다.
      console.log(`This Node.js/OpenSSL build cannot negotiate TLS 1.0: ${error instanceof Error ? error.message : String(error)}`);
    }
    assert.equal(await num(await daemon.connect("tls", { ssl: { ca } }), "SELECT 1"), 1, "새 클라이언트도 계속 받는다");
  });

test("개요 8 : UDP 는 패킷이 유실·중복·뒤바뀌고 큰 메시지가 조각나는 조건에서도 질의와 대량 결과를 정확히 주고받는다", async (t) => {
  const daemon = await Daemon.create(t, { udp: { maxPacketSize: 300, sessionTimeoutMs: 60_000 } });
  daemon.start();
  const proxy = new LossyProxy({ serverPort: daemon.port, seed: 2026, lossToServer: 0.15, lossToClient: 0.15, duplicate: 0.2, minDelay: 0, maxDelay: 25 });
  await proxy.start();
  t.after(() => proxy.close());
  const c = await Connection.open({ kind: "udp", host: "127.0.0.1", port: proxy.port }, { requestTimeoutMs: 60_000, internal: { connectTimeoutMs: 60_000 } });
  t.after(() => c.abort());
  await c.login({ user: "SYSTEM", password: "HelloWorldDB" });

  await exec(c, "CREATE TABLE LOSSY (ID INTEGER PRIMARY KEY, BODY VARCHAR(2000))");
  await exec(c, "BEGIN");
  for (let id = 1; id <= 40; id++) await exec(c, "INSERT INTO LOSSY VALUES (?, ?)", [id, String.fromCharCode(96 + (id % 26 || 26)).repeat(id * 20)]);
  await exec(c, "COMMIT");
  const rows = await query(c, "SELECT ID, BODY FROM LOSSY ORDER BY ID");
  assert.equal(rows.length, 40);
  for (const [id, body] of rows) {
    const n = Number(id);
    assert.equal(body, String.fromCharCode(96 + (n % 26 || 26)).repeat(n * 20), `행 ${n}`);
  }
  assert.equal(await num(c, "SELECT SUM(LENGTH(BODY)) FROM LOSSY"), (40 * 41 / 2) * 20);
  // 시험이 일부러 만든 조건이 실제로 일어났고, 패킷은 설정한 크기를 넘지 않았다.
  assert.ok(proxy.stats.droppedToServer > 0 && proxy.stats.droppedToClient > 0, JSON.stringify(proxy.stats));
  assert.ok(proxy.stats.maxServerPacket <= 300 && proxy.stats.maxClientPacket <= 300, JSON.stringify(proxy.stats));
  // 서버에 같은 INSERT 가 두 번 반영되지 않았다. (중복 패킷은 걸러진다)
  assert.equal(await num(await daemon.connect("local"), "SELECT COUNT(*) FROM LOSSY"), 40);
});

test("개요 8 : udp.sessionTimeoutMs 동안 아무것도 오지 않는 UDP 세션은 서버가 끝내고 롤백한다", async (t) => {
  const daemon = await Daemon.create(t, { udp: { sessionTimeoutMs: 2000 } });
  daemon.start();
  const local = await daemon.connect("local");
  await exec(local, "CREATE TABLE T (N INTEGER)");
  await exec(local, "INSERT INTO T VALUES (1)");
  const proxy = new LossyProxy({ serverPort: daemon.port, seed: 1 });
  await proxy.start();
  t.after(() => proxy.close());
  const c = await Connection.open({ kind: "udp", host: "127.0.0.1", port: proxy.port }, { requestTimeoutMs: 20_000, internal: { connectTimeoutMs: 20_000 } });
  t.after(() => c.abort());
  await c.login({ user: "SYSTEM", password: "HelloWorldDB" });
  await exec(c, "BEGIN");
  await exec(c, "UPDATE T SET N = 2");
  assert.equal(await num(local, "SELECT COUNT(*) FROM SYS_SESSIONS"), 2);
  proxy.blockToServer = true; // 클라이언트가 사라진 것처럼 서버로 가는 패킷을 모두 버린다.
  await eventually(async () => (await num(local, "SELECT COUNT(*) FROM SYS_SESSIONS")) === 1, 30_000, "the idle UDP session to end");
  assert.equal(await num(local, "SELECT N FROM T"), 1, "끝난 세션의 커밋하지 않은 변경은 롤백된다");
});

// ---------------------------------------------------------------------------
// 개요 14 : 데몬 구동과 CLI
// ---------------------------------------------------------------------------

test("개요 14 : hwdb start 는 데몬을 비동기로 띄우고 포트와 PID 를 알리며 바로 돌아오고, status 와 stop 이 동작한다", async (t) => {
  const daemon = await Daemon.create(t);
  assert.equal(daemon.hwdb(["status"]).status, 1, "구동 전에는 구동 중이 아니다");
  const started = Date.now();
  const start = daemon.hwdb(["start"]);
  const elapsed = Date.now() - started;
  assert.equal(start.status, 0, start.stderr);
  const pid = daemon.pid;
  assert.notEqual(pid, null);
  assert.match(start.stdout, new RegExp(`port: ${daemon.port}\\b`));
  assert.match(start.stdout, new RegExp(`pid: ${pid}\\b`));
  assert.ok(elapsed < 20_000, `start 가 바로 돌아온다 (${elapsed} ms)`);
  // 돌아온 뒤에도 데몬은 계속 돌며 접속을 받는다. (hwdb start 프로세스는 이미 끝났다)
  await sleep(500);
  assert.equal(daemon.pid, pid);
  assert.equal(await num(await daemon.connect("tcp"), "SELECT 1"), 1);

  const status = daemon.hwdb(["status"]);
  assert.equal(status.status, 0);
  for (const field of [/running: yes/, new RegExp(`port: ${daemon.port}\\b`), new RegExp(`pid: ${pid}\\b`), /startedAt: \d{4}-\d\d-\d\dT/, /version: \d+\.\d+\.\d+/,
    /dataDir: .+/, /tcp: on/, /udp: on/, /sessions: \d+/]) {
    assert.match(status.stdout, field);
  }
  assert.match(start.stdout + start.stderr, /ALTER USER SYSTEM IDENTIFIED BY/, "초기 암호 그대로이면 구동 결과와 함께 경고를 보여 준다");

  const again = daemon.hwdb(["start"]);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already running/i);
  assert.equal(daemon.pid, pid, "이미 구동 중이면 새 데몬을 띄우지 않는다");

  daemon.stopClean();
  assert.equal(daemon.pid, null);
  assert.equal(daemon.hwdb(["status"]).status, 1);
  assert.equal(daemon.hwdb(["stop"]).status, 0, "구동 중이 아닐 때의 stop 은 그 사실만 알린다");
});

test("개요 14 : 같은 장비에서 hwdb 로 접속한다 (-e, -f, 표준 입력, 대화형 모드 없는 스크립트 모드) — 개요 13 의 Hello World 두 가지가 그대로 실행된다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const one = daemon.hwdb([...SYSTEM_ARGS, "-e", "SELECT 'Hello World'"]);
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /Hello World/);
  assert.match(one.stdout, /1 row/);

  const script = "CREATE TABLE HELLO (MESSAGE VARCHAR)\n;INSERT INTO HELLO VALUES ('Hello World');\n-- 주석 ; 안의 세미콜론\nSELECT * FROM HELLO;\n";
  const file = path.join(daemon.installDir, "hello.sql");
  fs.writeFileSync(file, script, "utf8");
  const viaFile = daemon.hwdb([...SYSTEM_ARGS, "-f", file]);
  assert.equal(viaFile.status, 0, viaFile.stderr);
  assert.match(viaFile.stdout, /\| Hello World \|/);

  daemon.hwdb([...SYSTEM_ARGS, "-e", "DROP TABLE HELLO"]);
  const viaStdin = daemon.hwdb(SYSTEM_ARGS, script);
  assert.equal(viaStdin.status, 0, viaStdin.stderr);
  assert.match(viaStdin.stdout, /\| Hello World \|/);

  // 오류가 나면 거기서 멈추고 종료 코드 1 이다. 이후 문장은 실행하지 않는다.
  const failing = daemon.hwdb(SYSTEM_ARGS, "SELECT * FROM NO_SUCH_TABLE; CREATE TABLE AFTER_ERROR (N INTEGER);");
  assert.equal(failing.status, 1);
  assert.match(failing.stderr, /\[42P01/);
  assert.equal(daemon.hwdb([...SYSTEM_ARGS, "-e", "SELECT * FROM AFTER_ERROR"]).status, 1, "오류 뒤의 문장은 실행하지 않았다");

  // 표준 입력이 터미널이 아니면 사용자명과 비밀번호를 물어볼 수 없다.
  const noCredentials = daemon.hwdb([], "SELECT 1");
  assert.equal(noCredentials.status, 1);
  assert.match(noCredentials.stderr, /-u/);
  // 틀린 비밀번호와 없는 사용자는 같은 오류이다.
  const wrongPassword = daemon.hwdb(["-u", "SYSTEM", "-p", "wrong", "-e", "SELECT 1"]);
  const noUser = daemon.hwdb(["-u", "NO_SUCH_USER", "-p", "wrong", "-e", "SELECT 1"]);
  assert.equal(wrongPassword.status, 1);
  assert.equal(noUser.status, 1);
  assert.equal(wrongPassword.stderr.replace(/\r/g, ""), noUser.stderr.replace(/\r/g, ""));
});

test("개요 14 : 설치 직후의 표준 절차 — SYSTEM 로 로컬 접속해 초기 암호를 바꾸면 경고가 사라지고 이전 암호는 쓸 수 없다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  assert.match(daemon.log(), /\[warn\] The SYSTEM account still uses its initial password/);
  const login = daemon.hwdb([...SYSTEM_ARGS, "-e", "SELECT 1"]);
  assert.match(login.stderr + login.stdout, /ALTER USER SYSTEM IDENTIFIED BY '<new password>'/, "CLI 가 변경을 안내한다");
  const change = daemon.hwdb([...SYSTEM_ARGS, "-e", "ALTER USER SYSTEM IDENTIFIED BY 'a new secret'"]);
  assert.equal(change.status, 0, change.stderr);
  assert.equal(daemon.hwdb([...SYSTEM_ARGS, "-e", "SELECT 1"]).status, 1, "이전 암호는 더 쓸 수 없다");
  const renewed = daemon.hwdb(["-u", "SYSTEM", "-p", "a new secret", "-e", "SELECT 1"]);
  assert.equal(renewed.status, 0, renewed.stderr);
  assert.doesNotMatch(renewed.stderr + renewed.stdout, /initial password|ALTER USER SYSTEM/, "바꾼 뒤에는 안내하지 않는다");
  // 재시작해도 새 암호이고 구동 경고가 없다. 평문 암호는 로그에 남지 않는다.
  daemon.stopClean();
  fs.rmSync(path.dirname(daemon.logPath), { recursive: true, force: true });
  const restart = daemon.hwdb(["start"]);
  assert.equal(restart.status, 0, restart.stderr);
  assert.doesNotMatch(restart.stdout + restart.stderr + daemon.log(), /initial password/);
  assert.doesNotMatch(daemon.log(), /a new secret|HelloWorldDB'/);
  assert.equal(daemon.hwdb(["-u", "SYSTEM", "-p", "a new secret", "-e", "SELECT 1"]).status, 0);
});

test("개요 14 : 데몬 제어(상태 조회, 종료)는 로컬 전용 채널로 제어 토큰과 함께 보낼 때만 처리한다. DB 계정 인증은 거치지 않는다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const token = (readLockFile(daemon.dataDir) as { controlToken: string }).controlToken;
  assert.ok(token.length >= 16);
  // TCP, UDP 로는 제어 요청을 받지 않는다. (로그인 전이든 후든)
  for (const kind of ["tcp", "udp"] as const) {
    for (const login of [false, true]) {
      const c = await daemon.connect(kind, { login });
      await assert.rejects(() => c.control("status", token), `${kind} (login=${login})`);
      c.abort();
    }
  }
  // 토큰이 틀리면 로컬 전용 채널에서도 처리하지 않는다.
  const wrong = await daemon.connect("local", { login: false });
  await assert.rejects(() => wrong.control("stop", "0".repeat(token.length)));
  wrong.abort();
  assert.notEqual(daemon.pid, null, "거부된 종료 요청에 데몬이 끝나지 않았다");
  // 맞는 토큰이면 로그인 없이도 상태를 알려 준다.
  const good = await daemon.connect("local", { login: false });
  const status = await good.control("status", token);
  assert.equal(status.running, true);
  assert.equal(status.port, daemon.port);
  assert.equal(status.pid, daemon.pid);
  good.abort();
});
