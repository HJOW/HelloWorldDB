/**
 * `hwdb` 명령행 인자 해석 테스트 (10단계). 프로세스를 띄우지 않고 해석 결과만 본다.
 * 관련 사양 : AGENTS.md 상세 14-1, 14-2
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TIMEOUT_SECONDS, parseArguments } from "../../src/cli/args.js";
import type { ParsedCommand, SqlOptions } from "../../src/cli/args.js";

function sqlOptions(argv: string[]): SqlOptions {
  const parsed = parseArguments(argv);
  assert.equal(parsed.kind, "sql", `argv ${JSON.stringify(argv)} => ${JSON.stringify(parsed)}`);
  return (parsed as Extract<ParsedCommand, { kind: "sql" }>).options;
}

function errorMessage(argv: string[]): string {
  const parsed = parseArguments(argv);
  assert.equal(parsed.kind, "error", `argv ${JSON.stringify(argv)} => ${JSON.stringify(parsed)}`);
  return (parsed as Extract<ParsedCommand, { kind: "error" }>).message;
}

test("인자가 없으면 모든 옵션을 생략한 SQL 접속이다", () => {
  assert.deepEqual(sqlOptions([]), { udp: false, ssl: false, sslNoVerify: false });
});

test("start 는 기본 제한 시간 30초이고 --timeout 과 --foreground 를 받는다", () => {
  assert.deepEqual(parseArguments(["start"]), { kind: "start", timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, foreground: false });
  assert.equal(DEFAULT_TIMEOUT_SECONDS, 30);
  assert.deepEqual(parseArguments(["start", "--timeout", "5", "--foreground"]), { kind: "start", timeoutSeconds: 5, foreground: true });
  assert.deepEqual(parseArguments(["start", "--foreground", "--timeout=7"]), { kind: "start", timeoutSeconds: 7, foreground: true });
});

test("stop 은 --timeout 만 받고 status 는 인자를 받지 않는다", () => {
  assert.deepEqual(parseArguments(["stop"]), { kind: "stop", timeoutSeconds: 30 });
  assert.deepEqual(parseArguments(["stop", "--timeout", "3"]), { kind: "stop", timeoutSeconds: 3 });
  assert.deepEqual(parseArguments(["status"]), { kind: "status" });
  assert.match(errorMessage(["status", "--timeout", "3"]), /hwdb status: unknown option "--timeout"/);
  assert.match(errorMessage(["stop", "--foreground"]), /hwdb stop: unknown option "--foreground"/);
  assert.match(errorMessage(["start", "extra"]), /hwdb start: unexpected argument "extra"/);
  assert.match(errorMessage(["start", "-P", "7410"]), /hwdb start: unknown option "-P"/);
});

test("--timeout 은 양의 정수여야 한다", () => {
  for (const bad of ["0", "-1", "abc", "1.5", "", "99999999999999999999"]) {
    assert.match(errorMessage(["start", "--timeout", bad]), /--timeout must be a positive integer/, bad);
    assert.match(errorMessage(["stop", `--timeout=${bad}`]), /--timeout must be a positive integer/, bad);
  }
  assert.match(errorMessage(["start", "--timeout"]), /option --timeout needs a value/);
});

test("값이 필요한 옵션은 네 가지 형태를 모두 받는다", () => {
  for (const argv of [["--port", "7410"], ["--port=7410"], ["-P", "7410"], ["-P7410"]]) {
    assert.equal(sqlOptions(argv).port, 7410, JSON.stringify(argv));
  }
  for (const argv of [["--user", "SYSTEM"], ["--user=SYSTEM"], ["-u", "SYSTEM"], ["-uSYSTEM"]]) {
    assert.equal(sqlOptions(argv).user, "SYSTEM", JSON.stringify(argv));
  }
  for (const argv of [["--host", "db"], ["--host=db"], ["-h", "db"], ["-hdb"]]) {
    assert.equal(sqlOptions(argv).host, "db", JSON.stringify(argv));
  }
  for (const argv of [["--tablespace", "T1"], ["--tablespace=T1"], ["-t", "T1"], ["-tT1"]]) {
    assert.equal(sqlOptions(argv).tablespace, "T1", JSON.stringify(argv));
  }
});

test("모든 접속 옵션을 함께 받는다", () => {
  const options = sqlOptions(["-h", "db.example", "-P", "9000", "--ssl", "--ssl-ca", "ca.pem", "-u", "SCOTT", "-p", "tiger", "-t", "APP", "-e", "SELECT 1"]);
  assert.deepEqual(options, {
    host: "db.example",
    port: 9000,
    udp: false,
    ssl: true,
    sslCa: "ca.pem",
    sslNoVerify: false,
    user: "SCOTT",
    password: "tiger",
    tablespace: "APP",
    execute: "SELECT 1",
  });
  assert.equal(sqlOptions(["-f", "script.sql"]).file, "script.sql");
  assert.equal(sqlOptions(["-h", "db", "--udp"]).udp, true);
  assert.equal(sqlOptions(["-h", "db", "--ssl", "--ssl-no-verify"]).sslNoVerify, true);
});

test("값에 등호나 대시가 있어도 값으로 받는다", () => {
  assert.equal(sqlOptions(["--password=a=b"]).password, "a=b");
  assert.equal(sqlOptions(["-p", "-secret"]).password, "-secret");
  assert.equal(sqlOptions(["-e", "-- comment\nSELECT 1"]).execute, "-- comment\nSELECT 1");
  assert.equal(sqlOptions(["-p", ""]).password, "", "빈 비밀번호도 값이다");
});

test("값이 빠진 옵션과 알 수 없는 옵션은 오류이다", () => {
  assert.match(errorMessage(["-P"]), /option -P needs a value/);
  assert.match(errorMessage(["--user"]), /option --user needs a value/);
  assert.match(errorMessage(["-u", "SYSTEM", "-p"]), /option -p needs a value/);
  assert.match(errorMessage(["--bogus"]), /hwdb: unknown option "--bogus"/);
  assert.match(errorMessage(["-x"]), /hwdb: unknown option "-x"/);
  assert.match(errorMessage(["--udp=1"]), /option --udp takes no value/);
  assert.match(errorMessage(["SELECT"]), /hwdb: unexpected argument "SELECT"/);
});

test("포트는 1 에서 65535 사이의 정수이다", () => {
  for (const bad of ["0", "65536", "abc", "-1", "70000", "1.5", "", "0x10"]) {
    assert.match(errorMessage([`--port=${bad}`]), /invalid port number/, bad);
  }
  assert.equal(sqlOptions(["-P", "1"]).port, 1);
  assert.equal(sqlOptions(["-P", "65535"]).port, 65535);
});

test("빈 값을 줄 수 없는 옵션", () => {
  assert.match(errorMessage(["--host="]), /--host needs a host name/);
  assert.match(errorMessage(["-h", "db", "--ssl", "--ssl-ca="]), /--ssl-ca needs a file path/);
  assert.match(errorMessage(["--tablespace="]), /--tablespace needs a tablespace name/);
  assert.match(errorMessage(["--file="]), /--file needs a file path/);
});

test("--udp, --ssl, --ssl-ca, --ssl-no-verify 는 --host 와 함께만 쓴다", () => {
  assert.match(errorMessage(["--udp"]), /--udp can be used only with --host/);
  assert.match(errorMessage(["--ssl"]), /--ssl can be used only with --host/);
  assert.match(errorMessage(["--ssl-ca", "ca.pem"]), /--ssl-ca can be used only with --host/);
  assert.match(errorMessage(["--ssl-no-verify"]), /--ssl-no-verify can be used only with --host/);
});

test("--udp 와 --ssl 은 함께 쓸 수 없다", () => {
  assert.match(errorMessage(["-h", "db", "--udp", "--ssl"]), /--udp and --ssl cannot be used together/);
  assert.match(errorMessage(["-h", "db", "--udp", "--ssl-ca", "ca.pem"]), /--ssl-ca cannot be used with --udp/);
  assert.match(errorMessage(["-h", "db", "--udp", "--ssl-no-verify"]), /--ssl-no-verify cannot be used with --udp/);
});

test("--ssl-ca 와 --ssl-no-verify 는 --ssl 이 있어야 하고 서로 함께 쓸 수 없다", () => {
  assert.match(errorMessage(["-h", "db", "--ssl-ca", "ca.pem"]), /--ssl-ca can be used only with --ssl/);
  assert.match(errorMessage(["-h", "db", "--ssl-no-verify"]), /--ssl-no-verify can be used only with --ssl/);
  assert.match(errorMessage(["-h", "db", "--ssl", "--ssl-ca", "ca.pem", "--ssl-no-verify"]), /--ssl-ca and --ssl-no-verify cannot be used together/);
});

test("-e 와 -f 는 함께 쓸 수 없다", () => {
  assert.match(errorMessage(["-e", "SELECT 1", "-f", "a.sql"]), /--execute and --file cannot be used together/);
});

test("--help 와 --version 은 어느 명령에서든 알아본다", () => {
  assert.deepEqual(parseArguments(["--help"]), { kind: "help" });
  assert.deepEqual(parseArguments(["--version"]), { kind: "version" });
  assert.deepEqual(parseArguments(["start", "--help"]), { kind: "help" });
  assert.deepEqual(parseArguments(["status", "--version"]), { kind: "version" });
  assert.deepEqual(parseArguments(["-u", "SYSTEM", "--help"]), { kind: "help" });
});

test("--help 가 다른 옵션의 값이면 값으로 받는다", () => {
  assert.equal(sqlOptions(["-e", "--help"]).execute, "--help");
});
