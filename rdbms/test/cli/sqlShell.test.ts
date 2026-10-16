/**
 * SQL 접속(`hwdb`) 테스트 (10단계). 데몬을 프로세스 안에 띄우고 가짜 입출력 환경으로 `runSqlCommand` 를 실행한다.
 * 세 접속 경로(로컬 전용 채널, TCP, UDP), 스크립트 모드와 대화형 모드, 로그인 흐름, 롤백 안내, 오류 출력을 본다.
 * 실제 프로세스로 띄우는 시험은 daemonLifecycle.test.ts 에 있다.
 * 관련 사양 : AGENTS.md 상세 14-2
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Connection } from "../../src/client/connection.js";
import { freePort } from "../net/helpers.js";
import { tablespaceNameOf } from "../../src/cli/sqlShell.js";
import { asSystem, makeShellEnv, runSql, scriptedLines, startServer } from "./helpers.js";

const fixture = (name: string): string => fileURLToPath(new URL(`../../../test/fixtures/tls/${name}`, import.meta.url));

// ---------------------------------------------------------------------------
// 스크립트 모드
// ---------------------------------------------------------------------------

test("Hello World 한 문장을 -e 로 실행하면 표와 행 수를 낸다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const harness = makeShellEnv();
  const code = await runSql(asSystem({ execute: "SELECT 'Hello World'" }), running.installDir, harness);
  assert.equal(code, 0, harness.errText());
  assert.match(harness.outText(), /\| Hello World \|/);
  assert.match(harness.outText(), /^\+-+\+\n\|[^\n]*\|\n\+-+\+\n\| Hello World \|\n\+-+\+\n1 row \(\d+ ms\)\n$/);
});

test("포트를 생략하면 설치 디렉토리 config.json 의 포트로 접속한다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const harness = makeShellEnv();
  // 포트 옵션이 없고, defaultPort 가 진짜 config.json 을 읽는다.
  assert.equal(await runSql(asSystem({ execute: "SELECT 1" }), running.installDir, harness), 0, harness.errText());
});

test("설치 디렉토리의 config.json 이 올바르지 않으면 포트를 생략한 접속은 실패한다", async (t) => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "hwdb-badcfg-"));
  t.after(() => fs.rmSync(installDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(installDir, "config.json"), '{"port": "abc"}');
  const harness = makeShellEnv();
  assert.equal(await runSql(asSystem({ execute: "SELECT 1" }), installDir, harness), 1);
  assert.match(harness.errText(), /^hwdb: .*port/i);
  // 포트를 직접 주면 config.json 을 읽지 않으므로 포트 오류가 아니라 접속 오류가 난다.
  const second = makeShellEnv();
  assert.equal(await runSql(asSystem({ execute: "SELECT 1", port: await freePort() }), installDir, second), 1);
  assert.match(second.errText(), /hwdb start/);
});

test("Hello World 샘플 세 문장을 표준 입력으로 실행한다 (상세 13)", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const script = "CREATE TABLE HELLO (MESSAGE VARCHAR);\nINSERT INTO HELLO VALUES ('Hello World');\nSELECT * FROM HELLO;\n";
  const harness = makeShellEnv({ readStdin: () => Promise.resolve(script) });
  assert.equal(await runSql(asSystem({ tablespace: "SYSTEM" }), running.installDir, harness), 0, harness.errText());
  const output = harness.outText();
  assert.match(output, /Table "HELLO" created\./);
  assert.match(output, /INSERT 1 \(1 row affected, \d+ ms\)/);
  assert.match(output, /\| MESSAGE {5}\|\n\+-+\+\n\| Hello World \|/);
  assert.equal(harness.err.length, 1, "초기 암호 안내 한 줄뿐이다");
  assert.match(harness.errText(), /initial password/);
});

test("오류가 나면 거기서 멈추고 종료 코드 1 이며 뒤 문장은 실행하지 않는다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const first = makeShellEnv();
  const code = await runSql(
    asSystem({ execute: "CREATE TABLE T1 (A INTEGER); INSERT INTO T1 VALUES (1); SELEC 2; INSERT INTO T1 VALUES (3)" }),
    running.installDir,
    first,
  );
  assert.equal(code, 1);
  assert.match(first.errText(), /ERROR \[42601:\d+\] /);
  assert.match(first.errText(), /at input line 1, column \d+/);
  assert.match(first.errText(), /\n {2}SELEC 2\n {2}\^\n/);
  const second = makeShellEnv();
  assert.equal(await runSql(asSystem({ execute: "SELECT COUNT(*) FROM T1" }), running.installDir, second), 0);
  assert.match(second.outText(), /\|\s+1 \|/, "1행만 들어갔다 (자동 커밋)");
});

test("오류의 입력 위치는 같은 줄의 앞선 문장만큼 밀리고 파일의 줄 번호를 따른다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const same = makeShellEnv();
  await runSql(asSystem({ execute: "SELECT 1;   SELEC 2" }), running.installDir, same);
  assert.match(same.errText(), /at input line 1, column 13\b/);

  const file = path.join(running.installDir, "multi.sql");
  fs.writeFileSync(file, "SELECT 1;\n\n  SELECT 2,\n   FROM X;\n");
  const multi = makeShellEnv();
  assert.equal(await runSql(asSystem({ file }), running.installDir, multi), 1);
  assert.match(multi.errText(), /at input line 4, column 4\b/);
  assert.match(multi.errText(), /\n {2} {3}FROM X\n {2} {3}\^\n/);
});

test("스크립트에서 exit 같은 대화형 명령은 일반 문장으로 서버에 보낸다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const harness = makeShellEnv({ readStdin: () => Promise.resolve("SELECT 1;\nexit;\nSELECT 2;") });
  assert.equal(await runSql(asSystem(), running.installDir, harness), 1);
  assert.match(harness.errText(), /ERROR \[42601:/);
  assert.doesNotMatch(harness.outText(), /\| {3}2 \|/, "exit 뒤 문장은 실행하지 않는다");
});

test("문자열과 주석 안의 `;` 는 문장을 나누지 않고 서버에는 한 번에 한 문장만 간다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const harness = makeShellEnv();
  const sql = "SELECT 'a;b' AS X; -- c;d\nSELECT /* e;f */ 'g' AS Y; SELECT \"h;i\" FROM (SELECT 1 AS \"h;i\") Q";
  assert.equal(await runSql(asSystem({ execute: sql }), running.installDir, harness), 0, harness.errText());
  assert.equal((harness.outText().match(/^1 row /gm) ?? []).length, 3, "문장 세 개가 각각 실행되었다");
  assert.match(harness.outText(), /\| a;b \|/);
  assert.match(harness.outText(), /\| g \|/);
  assert.match(harness.outText(), /\|\s+1 \|/);
});

test("끝에 `;` 가 없는 마지막 문장도 실행한다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const harness = makeShellEnv();
  assert.equal(await runSql(asSystem({ execute: "SELECT 1; SELECT 2" }), running.installDir, harness), 0);
  assert.equal((harness.outText().match(/1 row /g) ?? []).length, 2);
});

test("빈 입력은 아무것도 하지 않고 정상 종료한다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const harness = makeShellEnv();
  assert.equal(await runSql(asSystem({ execute: "  ; -- nothing\n ;" }), running.installDir, harness), 0);
  assert.equal(harness.outText(), "");
});

test("한글 값을 넣고 읽어 표의 칸이 맞는다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const harness = makeShellEnv();
  const sql = "CREATE TABLE K (NAME VARCHAR(20), AGE INTEGER); INSERT INTO K VALUES ('홍길동', 30); INSERT INTO K VALUES ('Kim', 7); SELECT * FROM K ORDER BY AGE";
  assert.equal(await runSql(asSystem({ execute: sql, tablespace: "SYSTEM" }), running.installDir, harness), 0, harness.errText());
  assert.match(
    harness.outText(),
    /\+--------\+-----\+\n\| NAME {3}\| AGE \|\n\+--------\+-----\+\n\| Kim {4}\| {3}7 \|\n\| 홍길동 \| {2}30 \|\n\+--------\+-----\+\n2 rows /,
  );
});

test("NULL 과 빈 문자열을 구분해서 보여 준다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const harness = makeShellEnv();
  assert.equal(await runSql(asSystem({ execute: "SELECT NULL AS A, '' AS B" }), running.installDir, harness), 0, harness.errText());
  assert.match(harness.outText(), /\| NULL \| {3}\|\n/, "NULL 은 NULL, 빈 문자열은 빈 칸");
});

test("큰 조회 결과를 나누어 받아 모두 출력한다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const setup = makeShellEnv();
  const inserts = Array.from({ length: 2500 }, (_, i) => `(${i})`).join(", ");
  assert.equal(await runSql(asSystem({ execute: `CREATE TABLE BIG (N INTEGER); INSERT INTO BIG VALUES ${inserts}`, tablespace: "SYSTEM" }), running.installDir, setup), 0, setup.errText());
  const harness = makeShellEnv();
  assert.equal(await runSql(asSystem({ execute: "SELECT N FROM BIG ORDER BY N", tablespace: "SYSTEM" }), running.installDir, harness), 0, harness.errText());
  assert.match(harness.outText(), /\n2500 rows \(\d+ ms\)\n$/);
  assert.match(harness.outText(), /\| 2499 \|/);
});

test("-f 파일을 실행하고 맨 앞의 BOM 은 무시한다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const file = path.join(running.installDir, "bom.sql");
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("SELECT '한글' AS X;", "utf8")]));
  const harness = makeShellEnv();
  assert.equal(await runSql(asSystem({ file }), running.installDir, harness), 0, harness.errText());
  assert.match(harness.outText(), /\| 한글 \|/);
});

test("읽을 수 없거나 UTF-8 이 아닌 입력 파일은 로그인하기 전에 실패한다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  let connects = 0;
  const harness = makeShellEnv({
    connect: () => {
      connects++;
      return Promise.reject(new Error("must not connect"));
    },
  });
  assert.equal(await runSql(asSystem({ file: path.join(running.installDir, "missing.sql") }), running.installDir, harness), 1);
  assert.match(harness.errText(), /cannot read the file .*missing\.sql/);

  const broken = path.join(running.installDir, "latin1.sql");
  fs.writeFileSync(broken, Buffer.from([0x53, 0x45, 0x4c, 0x45, 0x43, 0x54, 0x20, 0x27, 0xe9, 0x27]));
  const second = makeShellEnv({ connect: () => Promise.reject(new Error("must not connect")) });
  assert.equal(await runSql(asSystem({ file: broken }), running.installDir, second), 1);
  assert.match(second.errText(), /cannot read the file .*latin1\.sql/);
  assert.equal(connects, 0);

  const input = makeShellEnv({ readStdin: () => Promise.reject(new Error("bad bytes")), connect: () => Promise.reject(new Error("must not connect")) });
  assert.equal(await runSql(asSystem(), running.installDir, input), 1);
  assert.match(input.errText(), /cannot read the input: bad bytes/);
});

// ---------------------------------------------------------------------------
// 로그인
// ---------------------------------------------------------------------------

test("표준 입력이 터미널이 아니면 -u, -p 가 필요하다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const noUser = makeShellEnv();
  assert.equal(await runSql({ password: "x", execute: "SELECT 1" }, running.installDir, noUser), 1);
  assert.match(noUser.errText(), /cannot be asked\. Give -u\./);
  const neither = makeShellEnv();
  assert.equal(await runSql({ execute: "SELECT 1" }, running.installDir, neither), 1);
  assert.match(neither.errText(), /Give -u, -p\./);
  const noPassword = makeShellEnv();
  assert.equal(await runSql({ user: "SYSTEM" }, running.installDir, noPassword), 1);
  assert.match(noPassword.errText(), /Give -p\./);
});

test("터미널이면 사용자명과 비밀번호를 물어본다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const asked: string[] = [];
  const harness = makeShellEnv({
    stdinIsTTY: true,
    ask: (prompt) => {
      asked.push(prompt);
      return Promise.resolve("  SYSTEM ");
    },
    askSecret: (prompt) => {
      asked.push(prompt);
      return Promise.resolve("HelloWorldDB");
    },
  });
  assert.equal(await runSql({ execute: "SELECT 1" }, running.installDir, harness), 0, harness.errText());
  assert.deepEqual(asked, ["Username: ", "Password: "]);
  // -u 만 주면 비밀번호만 묻는다.
  asked.length = 0;
  const onlyPassword = makeShellEnv({ stdinIsTTY: true, askSecret: (prompt) => (asked.push(prompt), Promise.resolve("HelloWorldDB")) });
  assert.equal(await runSql({ user: "SYSTEM", execute: "SELECT 1" }, running.installDir, onlyPassword), 0, onlyPassword.errText());
  assert.deepEqual(asked, ["Password: "]);
});

test("사용자명이나 비밀번호 입력을 취소하면 접속하지 않고 종료 코드 1 이다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const connectFails = (): Promise<Connection> => Promise.reject(new Error("must not connect"));
  const emptyUser = makeShellEnv({ stdinIsTTY: true, ask: () => Promise.resolve("   "), connect: connectFails });
  assert.equal(await runSql({}, running.installDir, emptyUser), 1);
  assert.match(emptyUser.errText(), /a user name is required/);

  const cancelledUser = makeShellEnv({ stdinIsTTY: true, ask: () => Promise.resolve(null), connect: connectFails });
  assert.equal(await runSql({}, running.installDir, cancelledUser), 1);

  const cancelledPassword = makeShellEnv({ stdinIsTTY: true, askSecret: () => Promise.resolve(null), connect: connectFails });
  assert.equal(await runSql({ user: "SYSTEM" }, running.installDir, cancelledPassword), 1);
  assert.match(cancelledPassword.errText(), /cancelled/);

  const unsupported = makeShellEnv({ stdinIsTTY: true, askSecret: () => Promise.reject(new Error("no raw mode")), connect: connectFails });
  assert.equal(await runSql({ user: "SYSTEM" }, running.installDir, unsupported), 1);
  assert.match(unsupported.errText(), /cannot hide the typed password/);
});

test("비밀번호가 틀리거나 없는 사용자는 같은 오류이다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const wrong = makeShellEnv();
  assert.equal(await runSql({ user: "SYSTEM", password: "nope", execute: "SELECT 1" }, running.installDir, wrong), 1);
  const unknown = makeShellEnv();
  assert.equal(await runSql({ user: "NOBODY", password: "nope", execute: "SELECT 1" }, running.installDir, unknown), 1);
  assert.equal(wrong.errText(), unknown.errText());
  assert.match(wrong.errText(), /^ERROR \[28000:\d+\] Authentication failed\.\n$/);
  assert.equal(wrong.outText(), "");
});

test("SYSTEM 이 초기 암호로 로그인하면 변경을 안내하고, 바꾼 뒤에는 안내하지 않는다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const first = makeShellEnv();
  assert.equal(await runSql(asSystem({ execute: "SELECT 1" }), running.installDir, first), 0);
  assert.match(first.errText(), /The SYSTEM account still uses its initial password\./);
  assert.match(first.errText(), /ALTER USER SYSTEM IDENTIFIED BY '<new password>'/);
  assert.equal(first.outText().includes("initial password"), false, "안내는 표준 출력의 결과에 섞이지 않는다");

  const change = makeShellEnv();
  assert.equal(await runSql(asSystem({ execute: "ALTER USER SYSTEM IDENTIFIED BY 'n3w-Secret'" }), running.installDir, change), 0, change.errText());

  const after = makeShellEnv();
  assert.equal(await runSql({ user: "SYSTEM", password: "n3w-Secret", execute: "SELECT 1" }, running.installDir, after), 0, after.errText());
  assert.equal(after.errText(), "", "초기 암호가 아니므로 안내가 없다");

  const old = makeShellEnv();
  assert.equal(await runSql(asSystem({ execute: "SELECT 1" }), running.installDir, old), 1, "옛 암호는 더 이상 쓸 수 없다");

  // 소문자로 적어도 같은 SYSTEM 계정이다 (따옴표 없는 식별자는 대문자로 바뀐다).
  const lower = makeShellEnv();
  assert.equal(await runSql({ user: "system", password: "n3w-Secret", execute: "SELECT CURRENT_USER" }, running.installDir, lower), 0, lower.errText());
  assert.match(lower.outText(), /\| SYSTEM \|/);
});

test("접속 직후의 테이블스페이스를 -t 로 정한다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const setup = makeShellEnv();
  assert.equal(
    await runSql(asSystem({ execute: "CREATE TABLESPACE APP; CREATE TABLE APP.ITEMS (N INTEGER); INSERT INTO APP.ITEMS VALUES (7)" }), running.installDir, setup),
    0,
    setup.errText(),
  );
  const harness = makeShellEnv();
  assert.equal(await runSql(asSystem({ tablespace: "APP", execute: "SELECT N FROM ITEMS" }), running.installDir, harness), 0, harness.errText());
  assert.match(harness.outText(), /\| 7 \|/);
  const missing = makeShellEnv();
  assert.equal(await runSql(asSystem({ tablespace: "NOPE", execute: "SELECT 1" }), running.installDir, missing), 1);
  assert.match(missing.errText(), /^ERROR \[/);
});

test("-t 의 이름은 SQL 식별자 규칙을 따른다 : 따옴표 없으면 대문자, 큰따옴표면 그대로", async (t) => {
  assert.equal(tablespaceNameOf("app"), "APP");
  assert.equal(tablespaceNameOf("App_1"), "APP_1");
  assert.equal(tablespaceNameOf('"App"'), "App");
  assert.equal(tablespaceNameOf('"a""b"'), 'a"b');
  assert.equal(tablespaceNameOf('""'), "");
  assert.equal(tablespaceNameOf('"'), '"', "짝이 없는 따옴표는 이름 그대로이다");

  const running = await startServer();
  t.after(() => running.stop());
  const setup = makeShellEnv();
  assert.equal(
    await runSql(asSystem({ execute: 'CREATE TABLESPACE APP; CREATE TABLE APP.ITEMS (N INTEGER); INSERT INTO APP.ITEMS VALUES (7); CREATE TABLESPACE "MixedCase"; CREATE TABLE "MixedCase".OTHER (N INTEGER); INSERT INTO "MixedCase".OTHER VALUES (8)' }), running.installDir, setup),
    0,
    setup.errText(),
  );
  for (const [tablespace, table, expected] of [["app", "ITEMS", "7"], ['"APP"', "ITEMS", "7"], ['"MixedCase"', "OTHER", "8"]] as const) {
    const harness = makeShellEnv();
    assert.equal(await runSql(asSystem({ tablespace, execute: `SELECT N FROM ${table}` }), running.installDir, harness), 0, `${tablespace}: ${harness.errText()}`);
    assert.match(harness.outText(), new RegExp(`\\| ${expected} \\|`), tablespace);
  }
  const wrongCase = makeShellEnv();
  assert.equal(await runSql(asSystem({ tablespace: "mixedcase", execute: "SELECT 1" }), running.installDir, wrongCase), 1, "따옴표 없는 mixedcase 는 MIXEDCASE 이다");
});

// ---------------------------------------------------------------------------
// 접속 경로
// ---------------------------------------------------------------------------

test("TCP 와 UDP 로도 같은 결과를 얻는다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const tcp = makeShellEnv();
  assert.equal(await runSql(asSystem({ host: "127.0.0.1", port: running.port, execute: "SELECT 1 + 1 AS TWO" }), running.installDir, tcp), 0, tcp.errText());
  assert.match(tcp.outText(), /\| {3}2 \|/);
  const udp = makeShellEnv();
  assert.equal(await runSql(asSystem({ host: "127.0.0.1", port: running.port, udp: true, execute: "SELECT 1 + 1 AS TWO" }), running.installDir, udp), 0, udp.errText());
  // 소요 시간만 다를 뿐 출력은 같다.
  const withoutTime = (text: string): string => text.replace(/\(\d+ ms\)/g, "(T)");
  assert.equal(withoutTime(udp.outText()), withoutTime(tcp.outText()));
});

test("TCP 와 UDP 를 모두 끄고 접속 수가 가득 차도 로컬 접속은 된다 (상세 14-2 로컬 접속 보장)", async (t) => {
  const running = await startServer({ tcp: { enabled: false }, udp: { enabled: false }, maxConnections: 1 });
  t.after(() => running.stop());
  const harness = makeShellEnv();
  assert.equal(await runSql(asSystem({ execute: "SELECT 'local'" }), running.installDir, harness), 0, harness.errText());
  assert.match(harness.outText(), /\| local \|/);
});

test("maxConnections 가 찬 상태에서도 로컬 접속은 되고 원격은 막힌다", async (t) => {
  const running = await startServer({ maxConnections: 1 });
  t.after(() => running.stop());
  // GRANT CONNECT 가 없는 SYSTEM 도 루프백에서는 TCP 로 들어올 수 있다. 접속 하나를 잡아 둔다.
  const holder = makeShellEnv();
  const held = await Connection.open({ kind: "tcp", host: "127.0.0.1", port: running.port });
  t.after(() => held.abort());
  await held.login({ user: "SYSTEM", password: "HelloWorldDB" });

  const refused = makeShellEnv();
  assert.equal(await runSql(asSystem({ host: "127.0.0.1", port: running.port, execute: "SELECT 1" }), running.installDir, refused), 1);
  assert.match(refused.errText(), /^ERROR \[/);

  assert.equal(await runSql(asSystem({ execute: "SELECT 1" }), running.installDir, holder), 0, holder.errText());
});

test("데몬이 없으면 hwdb start 를 안내한다", async () => {
  const port = await freePort();
  const harness = makeShellEnv();
  assert.equal(await runSql(asSystem({ port, execute: "SELECT 1" }), os.tmpdir(), harness), 1);
  assert.match(harness.errText(), /cannot connect to the instance on port \d+ through the local-only channel/);
  assert.match(harness.errText(), /hwdb start/);
});

test("TCP 접속이 거부되면 접속 오류를 낸다", async () => {
  const port = await freePort();
  const harness = makeShellEnv();
  assert.equal(await runSql(asSystem({ host: "127.0.0.1", port, execute: "SELECT 1" }), os.tmpdir(), harness), 1);
  assert.match(harness.errText(), /^ERROR \[08006:/);
});

// ---------------------------------------------------------------------------
// SSL
// ---------------------------------------------------------------------------

async function startTlsServer(): Promise<Awaited<ReturnType<typeof startServer>>> {
  return await startServer({ tcp: { ssl: { certPath: fixture("server-a.cert.pem"), keyPath: fixture("server-a.key.pem") } } });
}

test("--ssl-ca 로 서버 인증서를 신뢰하면 SSL 접속이 된다", async (t) => {
  const running = await startTlsServer();
  t.after(() => running.stop());
  const harness = makeShellEnv();
  const code = await runSql(asSystem({ host: "127.0.0.1", port: running.port, ssl: true, sslCa: fixture("server-a.cert.pem"), execute: "SELECT 'secure'" }), running.installDir, harness);
  assert.equal(code, 0, harness.errText());
  assert.match(harness.outText(), /\| secure \|/);
  assert.doesNotMatch(harness.errText(), /certificate error/);
});

test("서버 인증서를 신뢰할 수 없으면 재시도를 알리고 해결 방법을 안내한다", async (t) => {
  const running = await startTlsServer();
  t.after(() => running.stop());
  const harness = makeShellEnv();
  // CA 를 지정하지 않았고 서버는 자체 서명 인증서이므로 기본 검증은 실패한다. 재시도해도 검증은 그대로이다.
  const code = await runSql(asSystem({ host: "127.0.0.1", port: running.port, ssl: true, execute: "SELECT 1" }), running.installDir, harness);
  assert.equal(code, 1);
  const err = harness.errText();
  assert.match(err, /certificate error \([A-Z_]+\); retrying 1\/2 \.\.\.\n/);
  assert.match(err, /certificate error \([A-Z_]+\); retrying 2\/2 \.\.\.\n/);
  assert.equal((err.match(/retrying/g) ?? []).length, 2);
  assert.match(err, /ERROR \[08001:\d+\] The server certificate could not be verified/);
  assert.match(err, /--ssl-ca <file>/);
  assert.match(err, /--ssl-no-verify/);
  assert.equal(harness.outText(), "");
});

test("다른 인증서를 신뢰하는 CA 로 지정하면 접속하지 못한다", async (t) => {
  const running = await startTlsServer();
  t.after(() => running.stop());
  const harness = makeShellEnv();
  const code = await runSql(asSystem({ host: "127.0.0.1", port: running.port, ssl: true, sslCa: fixture("server-b.cert.pem"), execute: "SELECT 1" }), running.installDir, harness);
  assert.equal(code, 1);
  assert.match(harness.errText(), /ERROR \[08001:/);
});

test("--ssl-no-verify 는 검증 없이 접속한다", async (t) => {
  const running = await startTlsServer();
  t.after(() => running.stop());
  const harness = makeShellEnv();
  const code = await runSql(asSystem({ host: "127.0.0.1", port: running.port, ssl: true, sslNoVerify: true, execute: "SELECT 'unverified'" }), running.installDir, harness);
  assert.equal(code, 0, harness.errText());
  assert.match(harness.outText(), /\| unverified \|/);
  assert.doesNotMatch(harness.errText(), /certificate error/);
});

test("CA 파일을 읽지 못하면 접속하지 않는다", async (t) => {
  const running = await startTlsServer();
  t.after(() => running.stop());
  const harness = makeShellEnv({ connect: () => Promise.reject(new Error("must not connect")) });
  const code = await runSql(asSystem({ host: "127.0.0.1", port: running.port, ssl: true, sslCa: path.join(running.installDir, "nope.pem"), execute: "SELECT 1" }), running.installDir, harness);
  assert.equal(code, 1);
  assert.match(harness.errText(), /cannot read the CA certificate .*nope\.pem/);
});

test("SSL 이 필요한 서버에 평문으로 접속하면 오류이다", async (t) => {
  const running = await startTlsServer();
  t.after(() => running.stop());
  const harness = makeShellEnv();
  const code = await runSql(asSystem({ host: "127.0.0.1", port: running.port, execute: "SELECT 1" }), running.installDir, harness);
  assert.equal(code, 1);
  assert.match(harness.errText(), /^ERROR \[/);
});

// ---------------------------------------------------------------------------
// 롤백 안내
// ---------------------------------------------------------------------------

test("커밋하지 않은 변경이 있는 채로 끝내면 롤백됨을 알린다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const setup = makeShellEnv();
  assert.equal(await runSql(asSystem({ execute: "CREATE TABLE R (N INTEGER)", tablespace: "SYSTEM" }), running.installDir, setup), 0, setup.errText());

  const harness = makeShellEnv();
  assert.equal(await runSql(asSystem({ execute: "BEGIN; INSERT INTO R VALUES (1)", tablespace: "SYSTEM" }), running.installDir, harness), 0, harness.errText());
  assert.match(harness.errText(), /Uncommitted changes were rolled back\.\n$/);

  const check = makeShellEnv();
  await runSql(asSystem({ execute: "SELECT COUNT(*) FROM R", tablespace: "SYSTEM" }), running.installDir, check);
  assert.match(check.outText(), /\|\s+0 \|/, "롤백되었다");
});

test("변경이 없거나 커밋했으면 롤백 안내가 없다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const setup = makeShellEnv();
  await runSql(asSystem({ execute: "CREATE TABLE R (N INTEGER)", tablespace: "SYSTEM" }), running.installDir, setup);
  for (const sql of [
    "BEGIN; INSERT INTO R VALUES (1); COMMIT",
    "INSERT INTO R VALUES (2)",
    "BEGIN; SELECT 1",
    "BEGIN; INSERT INTO R VALUES (3); ROLLBACK",
    "SELECT 1",
  ]) {
    const harness = makeShellEnv();
    assert.equal(await runSql(asSystem({ execute: sql, tablespace: "SYSTEM" }), running.installDir, harness), 0, `${sql}: ${harness.errText()}`);
    assert.doesNotMatch(harness.errText(), /rolled back/, sql);
  }
});

test("오류로 끝나도 커밋하지 않은 변경은 롤백되고 알린다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const setup = makeShellEnv();
  await runSql(asSystem({ execute: "CREATE TABLE R (N INTEGER)", tablespace: "SYSTEM" }), running.installDir, setup);
  const harness = makeShellEnv();
  assert.equal(await runSql(asSystem({ execute: "BEGIN; INSERT INTO R VALUES (1); SELEC", tablespace: "SYSTEM" }), running.installDir, harness), 1);
  assert.match(harness.errText(), /Uncommitted changes were rolled back\.\n$/);
});

// ---------------------------------------------------------------------------
// 대화형 모드
// ---------------------------------------------------------------------------

test("대화형 모드 : 여러 줄 입력과 `;` 실행, 오류 뒤 계속, help, exit", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const source = scriptedLines(["help", "SELECT", "  1 AS A", ";", "SELEC 2;", "SELECT 'x' AS X; SELECT 'y' AS Y;", "", "   ", "-- just a comment", "exit", "SELECT 'never'"]);
  const harness = makeShellEnv({ stdinIsTTY: true, openLineSource: () => source });
  const code = await runSql(asSystem(), running.installDir, harness);
  assert.equal(code, 0, harness.errText());
  assert.deepEqual(source.prompts, ["hwdb> ", "hwdb> ", "    -> ", "    -> ", "hwdb> ", "hwdb> ", "hwdb> ", "hwdb> ", "hwdb> ", "hwdb> "]);
  assert.equal(source.closed, true);

  const out = harness.outText();
  assert.match(out, /^Connected to HelloWorldDB \S+ as SYSTEM\. Current tablespace: SYSTEM\.\nType "help" for help and "exit" to quit\./);
  assert.match(out, /Enter SQL statements ending with ";"/);
  assert.match(out, /\| A \|/);
  assert.match(out, /\| x \|/);
  assert.match(out, /\| y \|/);
  assert.doesNotMatch(out, /never/);
  // 오류 뒤에도 계속했고, 대화형 모드는 입력 위치를 따로 알리지 않는다.
  assert.match(harness.errText(), /ERROR \[42601:\d+\] /);
  assert.doesNotMatch(harness.errText(), /input line/);
  assert.match(harness.errText(), /\n {2}SELEC 2\n {2}\^\n/);
});

test("대화형 모드 : exit, quit, 대소문자, 끝의 `;`", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  for (const word of ["exit", "quit", "EXIT", "Quit", "exit;", "  quit ; "]) {
    const source = scriptedLines([word, "SELECT 'never'"]);
    const harness = makeShellEnv({ stdinIsTTY: true, openLineSource: () => source });
    assert.equal(await runSql(asSystem(), running.installDir, harness), 0, word);
    assert.doesNotMatch(harness.outText(), /never/, word);
  }
  const help = scriptedLines(["HELP;", "Help"]);
  const helpEnv = makeShellEnv({ stdinIsTTY: true, openLineSource: () => help });
  await runSql(asSystem(), running.installDir, helpEnv);
  assert.equal((helpEnv.outText().match(/Enter SQL statements ending with/g) ?? []).length, 2);
});

test("대화형 모드 : 문장을 쓰는 도중의 exit 는 문장의 일부이다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const source = scriptedLines(["SELECT 1 AS A", "exit", ";"]);
  const harness = makeShellEnv({ stdinIsTTY: true, openLineSource: () => source });
  assert.equal(await runSql(asSystem(), running.installDir, harness), 0);
  assert.match(harness.errText(), /ERROR \[42601:/, "SELECT 1 AS A exit 는 구문 오류이다");
});

test("대화형 모드 : Ctrl-C 는 쓰던 입력을 버리고, 입력 끝(Ctrl-D)은 정상 종료이다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const source = scriptedLines(["SELECT 'discarded'", "interrupt", "interrupt", "SELECT 'kept' AS K;"]);
  const harness = makeShellEnv({ stdinIsTTY: true, openLineSource: () => source });
  assert.equal(await runSql(asSystem(), running.installDir, harness), 0);
  assert.doesNotMatch(harness.outText(), /discarded/);
  assert.match(harness.outText(), /\| kept \|/);
  assert.match(harness.errText(), /Input discarded\./);
  assert.match(harness.errText(), /Type exit or press Ctrl-D to leave hwdb\./);
  // 입력 끝에서 끝나지 않은 입력은 실행하지 않는다.
  const eof = scriptedLines(["SELECT 'unfinished'"]);
  const second = makeShellEnv({ stdinIsTTY: true, openLineSource: () => eof });
  assert.equal(await runSql(asSystem(), running.installDir, second), 0);
  assert.doesNotMatch(second.outText(), /unfinished/);
  assert.equal(eof.closed, true);
});

test("대화형 모드 : 기본 테이블스페이스가 없으면 (none) 으로 보여 준다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const setup = makeShellEnv();
  assert.equal(await runSql(asSystem({ execute: "CREATE USER NOTS IDENTIFIED BY 'pw'" }), running.installDir, setup), 0, setup.errText());
  const source = scriptedLines(["exit"]);
  const harness = makeShellEnv({ stdinIsTTY: true, openLineSource: () => source });
  assert.equal(await runSql({ user: "NOTS", password: "pw" }, running.installDir, harness), 0, harness.errText());
  assert.match(harness.outText(), /as NOTS\. Current tablespace: \(none\)\./);
  assert.doesNotMatch(harness.errText(), /initial password/);
});

test("대화형 모드 : 서버가 접속을 닫으면 오류를 알리고 종료 코드 1 이다", async (t) => {
  const running = await startServer();
  let stopped = false;
  t.after(async () => {
    if (!stopped) await running.stop();
  });
  const source = scriptedLines([
    "SELECT 1 AS OK;",
    async () => {
      stopped = true;
      await running.stop();
      return "SELECT 2 AS GONE;";
    },
    "SELECT 3;",
  ]);
  const harness = makeShellEnv({ stdinIsTTY: true, openLineSource: () => source });
  const code = await runSql(asSystem(), running.installDir, harness);
  assert.equal(code, 1);
  assert.match(harness.outText(), /\| OK \|/);
  assert.match(harness.errText(), /ERROR \[(57P01|08006):/);
  assert.match(harness.errText(), /the connection to the server was closed/);
  assert.equal(source.prompts.length, 2, "연결이 끊긴 뒤에는 더 읽지 않는다");
});

test("대화형 모드로 종료할 때도 커밋하지 않은 변경은 롤백되고 알린다", async (t) => {
  const running = await startServer();
  t.after(() => running.stop());
  const setup = makeShellEnv();
  await runSql(asSystem({ execute: "CREATE TABLE R (N INTEGER)", tablespace: "SYSTEM" }), running.installDir, setup);
  const source = scriptedLines(["BEGIN;", "INSERT INTO R VALUES (1);", "exit"]);
  const harness = makeShellEnv({ stdinIsTTY: true, openLineSource: () => source });
  assert.equal(await runSql(asSystem({ tablespace: "SYSTEM" }), running.installDir, harness), 0, harness.errText());
  assert.match(harness.errText(), /Uncommitted changes were rolled back\.\n$/);
});
