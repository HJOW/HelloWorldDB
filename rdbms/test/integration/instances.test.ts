/**
 * 11단계 통합 검증 : 개요 15 (SID 개념 없이 포트 번호가 인스턴스를 식별한다).
 *
 * 실제 `hwdb start` 프로세스 여러 개를 한 장비에서 함께 띄워 본다.
 *  - 포트 번호가 다른 두 인스턴스가 함께 돌고 데이터·세션·종료가 서로 독립이다.
 *  - 같은 포트의 두 번째 인스턴스와 같은 데이터 디렉토리의 두 번째 데몬은 구동할 수 없다.
 *  - config.json 의 port 를 바꾸고 재시작하면 같은 데이터를 새 포트 번호로 서비스한다.
 *  - TCP 와 UDP 가 같은 번호를 쓰고 로컬 전용 채널의 주소도 번호로 정해지며, 접속 정보에 SID 나 데이터베이스 이름이 없다.
 *
 * 관련 사양 : AGENTS.md 상세 15, 8, 9, 14
 * 구현 단계 : 11단계
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { test } from "node:test";
import { getLocalChannelAddress, LOCK_FILE_NAME } from "../../src/common/instance.js";
import { freePort, waitFor } from "../net/helpers.js";
import { Daemon, exec, num, query } from "./helpers.js";

/** 포트에 TCP 로 접속되는지이다. */
function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

/** 데이터 디렉토리의 파일 이름 목록이다. (잠금 파일은 실행 중인 프로세스의 표식이므로 뺀다) */
function dataFiles(daemon: Daemon): string[] {
  return fs.readdirSync(daemon.dataDir).filter((name) => name !== LOCK_FILE_NAME).sort();
}

test("개요 15 : 포트 번호가 다른 두 인스턴스를 한 장비에서 함께 구동하고, 데이터·세션·종료가 서로 독립이다", async (t) => {
  const first = await Daemon.create(t);
  const second = await Daemon.create(t);
  assert.notEqual(first.port, second.port);
  first.start();
  second.start();

  // 세 접속 경로 모두 포트 번호로 인스턴스를 찾는다.
  const f1 = await first.connect("local");
  await first.connect("tcp");
  const f3 = await first.connect("udp");
  const s1 = await second.connect("tcp");
  await exec(f1, "CREATE TABLE ONLY_FIRST (N INTEGER)");
  await exec(f1, "INSERT INTO ONLY_FIRST VALUES (1)");
  await exec(s1, "CREATE TABLE ONLY_SECOND (N INTEGER)");
  assert.equal(await num(f3, "SELECT COUNT(*) FROM ONLY_FIRST"), 1);
  assert.equal(await num(s1, "SELECT COUNT(*) FROM SYS_TABLES WHERE TABLE_NAME = 'ONLY_FIRST'"), 0, "다른 인스턴스의 객체는 보이지 않는다");
  assert.equal(await num(s1, "SELECT COUNT(*) FROM SYS_TABLES WHERE TABLE_NAME = 'ONLY_SECOND'"), 1);
  assert.equal(await num(s1, "SELECT COUNT(*) FROM SYS_SESSIONS"), 1, "세션 목록도 인스턴스마다 따로이다");
  assert.equal(await num(f1, "SELECT COUNT(*) FROM SYS_SESSIONS"), 3);

  // 로컬 전용 채널의 주소는 포트 번호로 정해진다. 각자 자기 주소를 연다.
  for (const daemon of [first, second]) {
    const address = getLocalChannelAddress(daemon.port);
    assert.ok(address.includes(String(daemon.port)), address);
    assert.ok(fs.existsSync(address), `${address} 이 열려 있다`);
  }
  // status 는 각 인스턴스의 포트와 데이터 디렉토리를 보여 준다.
  for (const daemon of [first, second]) {
    const status = daemon.hwdb(["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`port: ${daemon.port}\\b`));
  }

  // 하나를 종료해도 다른 인스턴스는 그대로 돈다.
  const pid = first.pid as number;
  first.stopClean();
  await first.waitUntilGone(pid);
  await waitFor(() => !fs.existsSync(getLocalChannelAddress(first.port)), 15_000, "first's local channel to close");
  assert.equal(first.hwdb(["status"]).status, 1);
  await assert.rejects(() => first.connect("tcp"), "종료한 인스턴스의 포트로는 접속되지 않는다");
  assert.equal(second.hwdb(["status"]).status, 0, "하나를 종료해도 다른 인스턴스는 계속 돈다");
  assert.equal(await num(s1, "SELECT COUNT(*) FROM ONLY_SECOND"), 0);
  const again = await second.connect("local");
  assert.equal(await num(again, "SELECT COUNT(*) FROM SYS_SESSIONS"), 2);
  // 종료한 인스턴스는 다시 구동할 수 있고 데이터가 남아 있다. 이쪽에는 영향이 없다.
  first.start();
  const f4 = await first.connect("tcp");
  assert.equal(await num(f4, "SELECT COUNT(*) FROM ONLY_FIRST"), 1);
  assert.equal(await num(s1, "SELECT COUNT(*) FROM SYS_SESSIONS"), 2);
});

test("개요 15 : 한 장비에서 같은 포트 번호의 인스턴스를 둘 띄울 수 없다. 두 번째가 실패해도 첫 번째는 그대로이다", async (t) => {
  const first = await Daemon.create(t);
  const second = await Daemon.create(t);
  first.start();
  const c = await first.connect("tcp");
  await exec(c, "CREATE TABLE T (N INTEGER)");

  // 설치 디렉토리와 데이터 디렉토리는 다르지만 포트 번호가 같다.
  second.writeConfig({ port: first.port });
  const result = second.hwdb(["start", "--timeout", "30"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, new RegExp(`${first.port}`), "원인에 포트 번호가 나온다");
  assert.match(result.stderr, /port number|already in use|another instance/i);
  assert.equal(second.pid, null, "실패한 두 번째 데몬이 남지 않는다");
  assert.equal(second.hwdb(["status"]).status, 1);
  assert.equal(fs.existsSync(`${second.dataDir}/${LOCK_FILE_NAME}`), false, "실패한 구동이 잠금 파일을 남기지 않는다");

  // 첫 번째 인스턴스는 영향이 없다.
  assert.equal(first.hwdb(["status"]).status, 0);
  assert.equal(await num(c, "SELECT COUNT(*) FROM T"), 0);
  await exec(c, "INSERT INTO T VALUES (1)");
  assert.equal(await num(await first.connect("udp"), "SELECT COUNT(*) FROM T"), 1);
});

test("개요 15 : 데이터 디렉토리 하나는 데몬 하나만 쓴다. 포트가 달라도 같은 데이터 디렉토리로는 띄울 수 없다", async (t) => {
  const first = await Daemon.create(t);
  const other = await Daemon.create(t);
  first.start();
  const c = await first.connect("tcp");
  await exec(c, "CREATE TABLE T (N INTEGER)");

  // 다른 설치 디렉토리와 포트이지만 dataDir 이 첫 번째의 데이터를 가리킨다.
  other.writeConfig({ port: other.port, dataDir: first.dataDir });
  // 분리 구동 : 이미 그 데이터 디렉토리로 구동 중인 데몬이 있으므로 그 사실만 알린다. 새 데몬을 띄우지 않는다.
  const start = other.hwdb(["start", "--timeout", "30"]);
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /already running/i);
  assert.match(start.stdout, new RegExp(`port: ${first.port}\\b`), "구동 중인 쪽의 포트를 알린다");
  // 포그라운드 : 데몬이 직접 데이터 디렉토리의 잠금을 잡으려다 실패한다.
  const foreground = other.hwdb(["start", "--foreground"]);
  assert.equal(foreground.status, 1);
  assert.match(foreground.stderr, /Data directory is already in use by process \d+/);
  assert.match(foreground.stderr, new RegExp(`port ${first.port}\\b`));
  // 두 번째 설정의 포트로 서비스를 열지도 않았다.
  assert.equal(await tcpOpen(other.port), false);
  assert.equal(fs.existsSync(getLocalChannelAddress(other.port)), false);
  // 첫 번째는 그대로이다.
  assert.equal(await num(c, "SELECT COUNT(*) FROM T"), 0);
  assert.equal(first.hwdb(["status"]).status, 0);
});

test("개요 15 : 포트 번호는 인스턴스의 이름일 뿐 데이터에 묶이지 않는다 (port 를 바꾸고 재시작하면 같은 데이터를 새 포트로 서비스한다)", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  let c = await daemon.connect("tcp");
  await exec(c, "CREATE TABLE KEEP (ID INTEGER PRIMARY KEY, MSG VARCHAR(40))");
  await exec(c, "INSERT INTO KEEP VALUES (1, 'before the port change')");
  const files = dataFiles(daemon);
  assert.ok(files.length > 0);
  for (const name of files) assert.ok(!name.includes(String(daemon.port)), `데이터 디렉토리의 파일 이름에 포트 번호가 없다 : ${name}`);

  daemon.stopClean();
  const oldPort = daemon.port;
  const newPort = await freePort();
  assert.notEqual(newPort, oldPort);
  daemon.setPort(newPort);
  daemon.start();

  const status = daemon.hwdb(["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`port: ${newPort}\\b`));
  assert.deepEqual(dataFiles(daemon), files, "포트를 바꿔도 데이터 파일의 이름과 구성이 같다");
  // 새 포트로 세 경로 모두 접속되고 데이터가 그대로 있다.
  for (const kind of ["local", "tcp", "udp"] as const) {
    c = await daemon.connect(kind);
    assert.deepEqual(await query(c, "SELECT MSG FROM KEEP WHERE ID = 1"), [["before the port change"]], kind);
  }
  // 옛 포트로는 더 이상 접속되지 않는다.
  assert.equal(fs.existsSync(getLocalChannelAddress(oldPort)), false);
  assert.equal(fs.existsSync(getLocalChannelAddress(newPort)), true);
  assert.equal(await tcpOpen(oldPort), false, "옛 포트에는 인스턴스가 없다");
});

test("개요 15 : TCP 와 UDP 가 같은 포트 번호를 쓰고, 둘을 꺼도 포트 번호가 인스턴스를 가리킨다. 접속 정보에 SID 나 데이터베이스 이름은 없다", async (t) => {
  const first = await Daemon.create(t);
  const second = await Daemon.create(t, { tcp: { enabled: false }, udp: { enabled: false } });
  first.start();
  second.start();
  const a = await first.connect("tcp");
  const b = await first.connect("udp");
  await exec(a, "CREATE TABLE SHARED (N INTEGER)");
  await exec(a, "INSERT INTO SHARED VALUES (42)");
  assert.equal(await num(b, "SELECT N FROM SHARED"), 42, "같은 번호의 TCP 와 UDP 는 같은 인스턴스이다");

  // 둘 다 끈 인스턴스에서도 포트 번호가 식별자로 남는다 : 로컬 전용 채널 주소가 번호로 정해지고 status 가 보여 준다.
  await assert.rejects(() => second.connect("tcp"), "TCP 를 껐다");
  const local = await second.connect("local");
  assert.equal(await num(local, "SELECT 1"), 1);
  assert.ok(fs.existsSync(getLocalChannelAddress(second.port)));
  assert.match(second.hwdb(["status"]).stdout, new RegExp(`port: ${second.port}\\b`));

  // CLI 도 포트 번호만으로 인스턴스를 고른다. (-P) 같은 설치 디렉토리에서 다른 포트를 주면 그 인스턴스에 간다.
  const args = ["-u", "SYSTEM", "-p", "HelloWorldDB", "-t", "SYSTEM"];
  const viaFirst = first.hwdb(["-P", String(first.port), ...args, "-e", "SELECT N FROM SHARED"]);
  assert.equal(viaFirst.status, 0, viaFirst.stderr);
  assert.match(viaFirst.stdout, /42/);
  const viaOther = second.hwdb(["-P", String(first.port), ...args, "-e", "SELECT N FROM SHARED"]);
  assert.equal(viaOther.status, 0, "second 의 설치 디렉토리에서 -P 로 first 의 포트를 가리키면 first 에 접속된다");
  assert.match(viaOther.stdout, /42/);
  const ownPort = second.hwdb([...args, "-e", "SELECT N FROM SHARED"]);
  assert.equal(ownPort.status, 1, "-P 없이는 자기 설치 디렉토리의 인스턴스에 가며 거기에는 그 테이블이 없다");

  // SID 나 데이터베이스 이름에 해당하는 옵션은 없다.
  for (const option of ["--sid", "--database", "--db", "--service"]) {
    const result = first.hwdb([option, "X", ...args, "-e", "SELECT 1"]);
    assert.equal(result.status, 1, option);
    assert.match(result.stderr, /unknown option/i, option);
  }
});
