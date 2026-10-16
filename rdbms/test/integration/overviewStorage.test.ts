/**
 * 개요 3, 12 의 시나리오 시험 (11단계). 실제 `hwdb start` 로 띄운 데몬과 데이터 파일을 다룬다.
 *  - 개요 3 : 테이블스페이스 = 데이터 파일 하나와 1:1. 파일 맨 앞의 매직 넘버·포맷 버전·캐릭터셋, SYSTEM 기본 제공,
 *            테이블스페이스는 자기 완결적(정의·데이터·인덱스가 자기 파일 안), 파일이 없거나 손상되거나 새 버전이면 사용 불가로 두고 나머지는 정상 구동,
 *            SYSTEM 이 손상되면 구동 실패, 삭제, 업그레이드·이름 변경 미제공
 *  - 개요 12 : 복구·백업 기능은 초기 버전에서 미지원. 정상 종료(진행 중인 트랜잭션 롤백, 정상 종료 표시), 비정상 종료 뒤 구동(경고, 커밋은 남고 미커밋은 없음),
 *             커밋 응답 뒤의 내구성, 백업은 정상 종료 뒤 데이터 디렉토리 복사
 * 이전 포맷 버전의 데이터 파일을 여는 호환성 시험은 `dataDirCompat.test.ts` 와 `test/storage/storage.test.ts` 이다.
 * 관련 사양 : AGENTS.md 개요 3, 12, 상세 3, 12
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isProcessAlive } from "../../src/daemon/lockFile.js";
import { Daemon, exec, execAll, failure, num, query } from "./helpers.js";

/** 데이터 파일 헤더의 고정 위치 값들이다. (docs/storage-v1.md) */
function readHeader(file: string): { magic: string; version: number; charset: string; cleanShutdown: number; text: string } {
  const bytes = fs.readFileSync(file).subarray(0, 8192);
  return {
    magic: bytes.subarray(0, 8).toString("latin1"),
    version: bytes.readUInt32LE(8),
    charset: bytes.subarray(16, 32).toString("latin1").replace(/\0+$/, ""),
    cleanShutdown: bytes[624] as number,
    text: bytes.toString("latin1"),
  };
}

/** 로그 파일의 `offset` 이후 내용이다. */
function logSince(daemon: Daemon, offset: number): string {
  return daemon.log().slice(offset);
}

// ---------------------------------------------------------------------------
// 개요 3 : 테이블스페이스
// ---------------------------------------------------------------------------

test("개요 3 : 테이블스페이스는 데이터 파일 하나와 1:1 이고 SYSTEM 은 기본 제공된다 (파일 맨 앞에 매직·포맷 버전·캐릭터셋)", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("tcp");
  // 최초 구동 직후에는 SYSTEM 하나뿐이다.
  assert.deepEqual(fs.readdirSync(daemon.dataDir).filter((name) => name.endsWith(".hwdb")), ["SYSTEM.hwdb"]);
  assert.deepEqual(await query(c, "SELECT TABLESPACE_NAME, FORMAT_VERSION, CHARACTER_SET, STATUS FROM SYS_TABLESPACES"), [["SYSTEM", 1, "UTF8", "AVAILABLE"]]);

  const custom = path.join(daemon.installDir, "elsewhere", "custom.hwdb").split(path.sep).join("/");
  await execAll(c, ["CREATE TABLESPACE APP", `CREATE TABLESPACE CUSTOM DATAFILE '${custom}'`, "CREATE TABLESPACE SUB DATAFILE 'nested/sub.hwdb'"]);
  // 데이터 파일 하나가 테이블스페이스 하나이다. DATAFILE 을 생략하면 <dataDir>/<이름>.hwdb 이다.
  const files = await query(c, "SELECT TABLESPACE_NAME, DATAFILE FROM SYS_TABLESPACES ORDER BY 1");
  assert.deepEqual(files, [
    ["APP", path.join(daemon.dataDir, "APP.hwdb")],
    ["CUSTOM", path.normalize(custom)],
    ["SUB", path.join(daemon.dataDir, "nested", "sub.hwdb")],
    ["SYSTEM", path.join(daemon.dataDir, "SYSTEM.hwdb")],
  ]);
  for (const [, file] of files) assert.ok(fs.existsSync(file as string), file as string);
  assert.equal(new Set(files.map((row) => row[1])).size, 4, "파일은 서로 다르다");
  // 같은 데이터 파일을 두 테이블스페이스가 쓸 수 없다.
  assert.equal((await failure(c, `CREATE TABLESPACE DUPFILE DATAFILE '${custom}'`)).sqlState, "42P06");
  assert.equal((await failure(c, "CREATE TABLESPACE APP")).sqlState, "42P06", "이름이 같은 테이블스페이스");

  // 파일 맨 앞 고정 위치의 매직 넘버, 포맷 버전, 캐릭터셋, 이름, 생성한 서버 버전
  for (const [name, file] of files as Array<[string, string]>) {
    const header = readHeader(file);
    assert.equal(header.magic, "HWDBTS\r\n", name);
    assert.equal(header.version, 1, `${name}: 포맷 버전은 1 부터 시작하는 정수이다`);
    assert.equal(header.charset, "UTF8", name);
    assert.ok(header.text.includes(name), `${name}: 헤더에 테이블스페이스 이름이 있다`);
    assert.ok(header.text.includes("0.1.0"), `${name}: 헤더에 생성한 서버 버전이 있다`);
  }
  // 새 테이블스페이스는 서버가 지원하는 최신 버전(1)으로 만든다.
  assert.deepEqual(await query(c, "SELECT DISTINCT FORMAT_VERSION FROM SYS_TABLESPACES"), [[1]]);
});

test("개요 3 : 테이블스페이스는 자기 완결적이다 (정의·데이터·인덱스가 자기 파일 안에 있다)", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("tcp");
  await execAll(c, [
    "CREATE TABLESPACE APP",
    "CREATE TABLE APP.T (ID INTEGER PRIMARY KEY, V VARCHAR(10))",
    "CREATE INDEX APP.IX_V ON APP.T (V)",
    "CREATE VIEW APP.VT AS SELECT ID, V FROM APP.T",
    "INSERT INTO APP.T VALUES (1, 'one')",
    "INSERT INTO APP.T VALUES (2, 'two')",
    "CREATE TABLESPACE OTHER",
    "CREATE TABLE OTHER.O (ID INTEGER PRIMARY KEY)",
    "INSERT INTO OTHER.O VALUES (7)",
  ]);
  daemon.stopClean();
  // APP 의 파일을 치우면 그 테이블스페이스의 테이블·뷰·인덱스·데이터가 모두 사라진다. 사용자와 권한, 테이블스페이스 목록은 SYSTEM 에 남는다.
  const app = path.join(daemon.dataDir, "APP.hwdb");
  fs.renameSync(app, `${app}.away`);
  daemon.start();
  const away = await daemon.connect("tcp");
  assert.deepEqual(await query(away, "SELECT TABLESPACE_NAME, STATUS FROM SYS_TABLESPACES ORDER BY 1"), [["APP", "UNAVAILABLE"], ["OTHER", "AVAILABLE"], ["SYSTEM", "AVAILABLE"]]);
  assert.equal((await failure(away, "SELECT * FROM APP.T")).sqlState, "58030");
  assert.equal((await failure(away, "SELECT * FROM APP.VT")).sqlState, "58030");
  assert.deepEqual(await query(away, "SELECT ID FROM OTHER.O"), [[7]], "나머지 테이블스페이스는 정상이다");
  assert.deepEqual(await query(away, "SELECT COUNT(*) FROM SYS_TABLES WHERE TABLESPACE_NAME = 'APP'"), [["0"]], "객체 정의는 자기 파일에 있어서 목록에 없다");
  assert.match(daemon.log(), /Tablespace "APP" is unavailable/);
  daemon.stopClean();
  // 파일을 돌려놓으면 정의, 데이터, 인덱스가 모두 되살아난다.
  fs.renameSync(`${app}.away`, app);
  daemon.start();
  const back = await daemon.connect("tcp");
  assert.deepEqual(await query(back, "SELECT ID, V FROM APP.T ORDER BY ID"), [[1, "one"], [2, "two"]]);
  assert.deepEqual(await query(back, "SELECT ID FROM APP.VT WHERE V = 'two'"), [[2]]);
  assert.deepEqual(await query(back, "SELECT INDEX_NAME FROM SYS_INDEXES WHERE TABLESPACE_NAME = 'APP' ORDER BY 1"), [["IX_V"], ["PK_T"]]);
  // 테이블 FK 는 같은 테이블스페이스의 테이블만 참조하고, 질의와 뷰는 여러 테이블스페이스를 함께 참조할 수 있다.
  assert.equal((await failure(back, "CREATE TABLE OTHER.F (ID INTEGER, TID INTEGER REFERENCES APP.T)")).sqlState, "42P16");
  assert.equal((await failure(back, "CREATE TABLE APP.F2 (ID INTEGER, OID INTEGER, FOREIGN KEY (OID) REFERENCES OTHER.O (ID))")).sqlState, "42P16");
  await exec(back, "CREATE VIEW OTHER.XV AS SELECT T.ID AS TID, O.ID AS OID FROM APP.T T, OTHER.O O");
  assert.deepEqual(await query(back, "SELECT COUNT(*) FROM OTHER.XV"), [["2"]]);
  // 인덱스는 테이블과 같은 테이블스페이스에 있어야 한다.
  assert.equal((await failure(back, "CREATE INDEX OTHER.IX_BAD ON APP.T (V)")).sqlState, "42P16");
});

test("개요 3 : 데이터 파일이 없거나 손상되었거나 서버가 모르는 새 버전이면 그 테이블스페이스만 사용 불가로 두고 나머지는 정상 구동한다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("tcp");
  await execAll(c, [
    "CREATE TABLESPACE GOOD",
    "CREATE TABLESPACE NEWER",
    "CREATE TABLESPACE BROKEN",
    "CREATE TABLESPACE BROKENHEAD",
    "CREATE TABLESPACE GONE",
    "CREATE TABLE BROKEN.B (A INTEGER)",
    "INSERT INTO BROKEN.B VALUES (1)",
    "CREATE TABLE GOOD.G (A INTEGER)",
    "INSERT INTO GOOD.G VALUES (1)",
    "CREATE USER U1 IDENTIFIED BY 'pw' DEFAULT TABLESPACE GONE",
  ]);
  daemon.stopClean();
  const file = (name: string): string => path.join(daemon.dataDir, `${name}.hwdb`);
  // 서버가 모르는 상위 버전
  const newer = fs.readFileSync(file("NEWER"));
  newer.writeUInt32LE(99, 8);
  fs.writeFileSync(file("NEWER"), newer);
  // 데이터 페이지가 손상된 파일 (헤더 다음의 모든 페이지에서 일부 바이트를 뒤집는다. 페이지마다 체크섬이 있다)
  const broken = fs.readFileSync(file("BROKEN"));
  for (let page = 1; page * 8192 < broken.length; page++) {
    for (let i = page * 8192 + 100; i < page * 8192 + 140; i++) broken[i] = (broken[i] as number) ^ 0xff;
  }
  fs.writeFileSync(file("BROKEN"), broken);
  // 헤더 페이지가 손상된 파일
  const brokenHead = fs.readFileSync(file("BROKENHEAD"));
  brokenHead[100] = (brokenHead[100] as number) ^ 0xff;
  fs.writeFileSync(file("BROKENHEAD"), brokenHead);
  // 없는 파일
  fs.rmSync(file("GONE"));

  daemon.start(); // 구동은 성공한다
  const after = await daemon.connect("tcp");
  assert.deepEqual(await query(after, "SELECT TABLESPACE_NAME, STATUS FROM SYS_TABLESPACES ORDER BY 1"), [
    ["BROKEN", "UNAVAILABLE"],
    ["BROKENHEAD", "UNAVAILABLE"],
    ["GONE", "UNAVAILABLE"],
    ["GOOD", "AVAILABLE"],
    ["NEWER", "UNAVAILABLE"],
    ["SYSTEM", "AVAILABLE"],
  ]);
  assert.deepEqual(await query(after, "SELECT A FROM GOOD.G"), [[1]]);
  for (const name of ["BROKEN", "BROKENHEAD", "GONE", "NEWER"]) {
    assert.equal((await failure(after, `SELECT * FROM ${name}.ANYTHING`)).sqlState, "58030", name);
    assert.match(daemon.log(), new RegExp(`Tablespace "${name}" is unavailable`), name);
  }
  // 사용 불가 테이블스페이스에는 새 객체를 만들 수도 없다. 지울 수는 있다.
  assert.equal((await failure(after, "CREATE TABLE BROKEN.X (A INTEGER)")).sqlState, "58030");
  await exec(after, "DROP TABLESPACE BROKEN INCLUDING CONTENTS");
  assert.equal(fs.existsSync(file("BROKEN")), false);
  await exec(after, "DROP TABLESPACE BROKENHEAD INCLUDING CONTENTS");
  // 기본 테이블스페이스가 사라진 사용자는 기본 테이블스페이스가 없는 상태가 된다.
  await exec(after, "DROP TABLESPACE GONE INCLUDING CONTENTS");
  const u1 = await daemon.connect("tcp", { user: "U1", password: "pw" });
  assert.equal(u1.session?.tablespace, null);
  assert.deepEqual(await query(after, "SELECT DEFAULT_TABLESPACE FROM SYS_USERS WHERE USER_NAME = 'U1'"), [[null]]);
});

test("개요 3 : SYSTEM 테이블스페이스가 손상되었으면 구동에 실패하고 원인을 알리며 잠금 파일을 남기지 않는다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  daemon.stopClean();
  const system = path.join(daemon.dataDir, "SYSTEM.hwdb");
  const bytes = fs.readFileSync(system);
  bytes[0] = 0;
  fs.writeFileSync(system, bytes);
  const start = daemon.hwdb(["start", "--timeout", "30"]);
  assert.equal(start.status, 1);
  assert.match(start.stderr, /hwdb start: .*magic/i);
  assert.equal(fs.existsSync(path.join(daemon.dataDir, "helloworlddb.lock")), false);
  assert.equal(daemon.pid, null);
});

test("개요 3 : 테이블스페이스를 지우면 데이터 파일도 지우고 권한 기록을 없앤다. SYSTEM 은 지울 수 없다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("tcp");
  await execAll(c, ["CREATE TABLESPACE TMP1", "CREATE TABLE TMP1.T (A INTEGER)", "CREATE USER U1 IDENTIFIED BY 'pw'", "GRANT SELECT ON TABLESPACE TMP1 TO U1", "GRANT SELECT ON TABLE TMP1.T TO U1"]);
  assert.equal((await failure(c, "DROP TABLESPACE TMP1")).sqlState, "55006", "객체가 남아 있으면 INCLUDING CONTENTS 가 필요하다");
  assert.ok(fs.existsSync(path.join(daemon.dataDir, "TMP1.hwdb")));
  await exec(c, "DROP TABLESPACE TMP1 INCLUDING CONTENTS");
  assert.equal(fs.existsSync(path.join(daemon.dataDir, "TMP1.hwdb")), false);
  assert.equal(await num(c, "SELECT COUNT(*) FROM SYS_PRIVILEGES WHERE TABLESPACE_NAME = 'TMP1'"), 0);
  assert.equal((await failure(c, "DROP TABLESPACE SYSTEM INCLUDING CONTENTS")).sqlState, "55006");
  assert.equal((await failure(c, "DROP TABLESPACE NOPE")).sqlState, "3D000");
  // 비어 있는 테이블스페이스는 INCLUDING CONTENTS 없이 지운다.
  await exec(c, "CREATE TABLESPACE EMPTY1");
  await exec(c, "DROP TABLESPACE EMPTY1");
  // 업그레이드, 이름 변경, 데이터 파일 이동 기능은 제공하지 않는다.
  for (const sql of ["ALTER TABLESPACE SYSTEM RENAME TO X", "ALTER TABLESPACE SYSTEM UPGRADE", "ALTER TABLESPACE SYSTEM MOVE DATAFILE 'x'"]) {
    assert.equal((await failure(c, sql)).sqlState, "0A000", sql);
  }
  // 캐릭터셋은 UTF8 뿐이다.
  assert.equal((await failure(c, "CREATE TABLESPACE U16 CHARACTER SET UTF16")).sqlState, "0A000");
});

test("개요 3 : 사용자, 권한, 테이블스페이스 목록은 SYSTEM 에 있고 재구동(정상·강제 종료) 뒤에도 남는다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  let c = await daemon.connect("tcp");
  await execAll(c, [
    "CREATE TABLESPACE APP",
    "CREATE USER U1 IDENTIFIED BY 'pw1' DEFAULT TABLESPACE APP",
    "GRANT ALL ON TABLESPACE APP TO U1",
    "GRANT CONNECT TO U1",
    "CREATE TABLE APP.T (A INTEGER)",
    "INSERT INTO APP.T VALUES (1)",
  ]);
  for (const how of ["stop", "kill"] as const) {
    const pid = daemon.pid as number;
    if (how === "stop") daemon.stopClean();
    else {
      daemon.kill();
      await daemon.waitUntilGone(pid);
    }
    daemon.start();
    c = await daemon.connect("tcp");
    assert.deepEqual(await query(c, "SELECT USER_NAME, DEFAULT_TABLESPACE FROM SYS_USERS ORDER BY 1"), [["SYSTEM", "SYSTEM"], ["U1", "APP"]], how);
    assert.deepEqual(await query(c, "SELECT GRANTEE, GROUP_NAME FROM SYS_GROUP_GRANTS ORDER BY 1, 2"), [["SYSTEM", "DBA"], ["U1", "CONNECT"]], how);
    assert.equal(await num(c, "SELECT COUNT(*) FROM SYS_PRIVILEGES WHERE GRANTEE = 'U1'"), 7, how);
    const u1 = await daemon.connect("tcp", { user: "U1", password: "pw1" });
    assert.deepEqual(await query(u1, "SELECT A FROM T"), [[1]], how);
  }
});

// ---------------------------------------------------------------------------
// 개요 12 : 복구·백업은 초기 버전에서 미지원
// ---------------------------------------------------------------------------

test("개요 12 : 백업·복원·내보내기·가져오기 명령은 없다 (0A000 또는 문법 오류)", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("tcp");
  assert.equal((await failure(c, "BACKUP DATABASE")).sqlState, "0A000");
  assert.equal((await failure(c, "RESTORE DATABASE")).sqlState, "0A000");
  for (const sql of ["EXPORT TABLE T", "IMPORT TABLE T", "FLASHBACK TABLE T", "RECOVER DATABASE"]) {
    const error = await failure(c, sql);
    assert.ok(["0A000", "42601"].includes(error.sqlState), `${sql}: ${error.sqlState}`);
  }
});

test("개요 12 : 정상 종료(hwdb stop)는 진행 중인 트랜잭션을 롤백하고 헤더에 정상 종료 표시를 남기며, 다음 구동에 경고가 없다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("tcp");
  await execAll(c, ["CREATE TABLE SYSTEM.T (ID INTEGER PRIMARY KEY, V VARCHAR(10))", "INSERT INTO SYSTEM.T VALUES (1, 'committed')"]);
  const pending = await daemon.connect("udp");
  await exec(pending, "BEGIN");
  await exec(pending, "INSERT INTO SYSTEM.T VALUES (2, 'pending')");
  await exec(pending, "UPDATE SYSTEM.T SET V = 'changed' WHERE ID = 1");
  const system = path.join(daemon.dataDir, "SYSTEM.hwdb");
  assert.equal(readHeader(system).cleanShutdown, 0, "구동 중에는 정상 종료 표시가 꺼져 있다");
  const offset = daemon.log().length;
  const stopper = await daemon.hwdbAsync(["stop", "--timeout", "60"]);
  assert.equal(stopper.status, 0, stopper.stderr);
  assert.equal(readHeader(system).cleanShutdown, 1, "정상 종료 뒤에는 표시가 켜진다");
  const shutdownLog = logSince(daemon, offset);
  assert.match(shutdownLog, /Shutting down the server/);
  assert.match(shutdownLog, /Server stopped/);

  const before = daemon.log().length;
  daemon.start();
  assert.doesNotMatch(logSince(daemon, before), /not shut down cleanly/, "정상 종료 뒤의 구동에는 경고가 없다");
  const again = await daemon.connect("tcp");
  assert.deepEqual(await query(again, "SELECT ID, V FROM SYSTEM.T ORDER BY ID"), [[1, "committed"]], "커밋하지 않은 변경은 남지 않는다");
});

test("개요 12 : 비정상 종료 뒤 구동하면 경고를 남기고 자동 복구는 하지 않으며, 커밋한 것은 남고 커밋하지 않은 것은 없다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("tcp");
  await execAll(c, ["CREATE TABLESPACE APP", "CREATE TABLE APP.T (ID INTEGER PRIMARY KEY, V VARCHAR(10))"]);
  for (let id = 1; id <= 50; id++) await exec(c, "INSERT INTO APP.T VALUES (?, ?)", [id, `row${id}`]);
  const pending = await daemon.connect("udp");
  await exec(pending, "BEGIN");
  await exec(pending, "INSERT INTO APP.T VALUES (1000, 'pending')");
  await exec(pending, "DELETE FROM APP.T WHERE ID <= 10");

  const pid = daemon.pid as number;
  daemon.kill(); // 정상 종료 절차 없이 강제로 끝낸다
  await daemon.waitUntilGone(pid);
  assert.equal(readHeader(path.join(daemon.dataDir, "APP.hwdb")).cleanShutdown, 0, "정상 종료 표시가 꺼진 채 남는다");
  assert.ok(fs.existsSync(path.join(daemon.dataDir, "helloworlddb.lock")), "잠금 파일이 남는다 (PID 가 죽었으므로 구동 중이 아닌 것으로 본다)");

  const offset = daemon.log().length;
  daemon.start(); // 남은 잠금 파일을 덮어쓰고 구동한다
  const warned = logSince(daemon, offset);
  assert.match(warned, /\[warn\] Tablespace was not shut down cleanly; automatic recovery is unavailable\./);
  assert.match(warned, /Found a previous lock file/);
  const again = await daemon.connect("tcp");
  assert.equal(await num(again, "SELECT COUNT(*) FROM APP.T"), 50, "커밋한 50행이 모두 남고 커밋하지 않은 변경은 없다");
  assert.equal(await num(again, "SELECT COUNT(*) FROM APP.T WHERE ID = 1000"), 0);
  assert.equal(await num(again, "SELECT COUNT(*) FROM APP.T WHERE ID <= 10"), 10);
  // 페이지 체크섬이 맞는 온전한 파일이므로 전체를 읽어도 오류가 없고, 계속 쓸 수 있다.
  assert.equal(await num(again, "SELECT SUM(ID) FROM APP.T"), (50 * 51) / 2);
  await exec(again, "INSERT INTO APP.T VALUES (51, 'after')");
  assert.deepEqual(await query(again, "SELECT V FROM APP.T WHERE ID = 51"), [["after"]]);
});

test("개요 12 : 커밋 응답을 받은 변경은 바로 강제로 끝내도 남는다 (커밋은 디스크에 반영한 뒤 응답한다)", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  let c = await daemon.connect("tcp");
  await exec(c, "CREATE TABLE SYSTEM.D (ID INTEGER PRIMARY KEY)");
  for (let round = 1; round <= 3; round++) {
    await exec(c, "BEGIN");
    for (let n = 0; n < 5; n++) await exec(c, "INSERT INTO SYSTEM.D VALUES (?)", [round * 100 + n]);
    await exec(c, "COMMIT"); // 이 응답을 받은 즉시
    const pid = daemon.pid as number;
    daemon.kill(); // 강제로 끝낸다
    await daemon.waitUntilGone(pid);
    daemon.start();
    c = await daemon.connect("tcp");
    assert.equal(await num(c, "SELECT COUNT(*) FROM SYSTEM.D"), round * 5, `라운드 ${round}`);
  }
});

test("개요 12 : 백업은 서버를 정상 종료한 뒤 데이터 디렉토리를 통째로 복사하는 것이고, 복사본을 다른 인스턴스로 구동해도 원본은 그대로이다", async (t) => {
  const original = await Daemon.create(t);
  original.start();
  const c = await original.connect("tcp");
  await execAll(c, [
    "CREATE TABLESPACE APP",
    "CREATE TABLE APP.T (ID INTEGER PRIMARY KEY, V VARCHAR(10))",
    "INSERT INTO APP.T VALUES (1, 'original')",
    "CREATE USER BACKED IDENTIFIED BY 'pw' DEFAULT TABLESPACE APP",
    "GRANT ALL ON TABLESPACE APP TO BACKED",
  ]);
  original.stopClean();

  // 정상 종료한 데이터 디렉토리를 다른 설치 디렉토리(다른 포트)로 복사한다.
  const copy = await Daemon.create(t);
  const copyFiles = (from: string, to: string): void => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.name === "helloworlddb.lock") continue;
      if (entry.isDirectory()) copyFiles(path.join(from, entry.name), path.join(to, entry.name));
      else fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
    }
  };
  copyFiles(original.dataDir, copy.dataDir);
  const originalBytes = fs.readFileSync(path.join(original.dataDir, "APP.hwdb"));

  copy.start();
  const restored = await copy.connect("tcp", { user: "BACKED", password: "pw" });
  assert.equal(restored.session?.tablespace, "APP");
  assert.deepEqual(await query(restored, "SELECT ID, V FROM T"), [[1, "original"]]);
  const copyAdmin = await copy.connect("tcp");
  assert.deepEqual(await query(copyAdmin, "SELECT TABLESPACE_NAME, DATAFILE FROM SYS_TABLESPACES WHERE TABLESPACE_NAME = 'APP'"), [["APP", path.join(copy.dataDir, "APP.hwdb")]], "복사본의 목록은 복사본의 파일을 가리킨다");
  await exec(restored, "INSERT INTO T VALUES (2, 'copy')");
  copy.stopClean();
  assert.deepEqual(fs.readFileSync(path.join(original.dataDir, "APP.hwdb")), originalBytes, "복사본이 원본의 데이터 파일을 고치지 않았다");

  // 원본은 따로 그대로 구동된다.
  original.start();
  const reopened = await original.connect("tcp");
  assert.deepEqual(await query(reopened, "SELECT ID FROM APP.T"), [[1]]);
});

test("개요 12 : 종료 신호(SIGTERM, SIGINT)를 받아도 정상 종료 절차를 밟는다 (유닉스 계열)", { skip: process.platform === "win32" ? "Windows 에서는 다른 프로세스가 보낸 SIGTERM 을 받을 수 없다 (종료는 hwdb stop 요청이 기본 경로이다)" : false }, async (t) => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const daemon = await Daemon.create(t);
    daemon.start();
    const c = await daemon.connect("tcp");
    await exec(c, "CREATE TABLE SYSTEM.S (A INTEGER)");
    await exec(c, "INSERT INTO SYSTEM.S VALUES (1)");
    const pid = daemon.pid as number;
    c.abort();
    process.kill(pid, signal);
    await daemon.waitUntilGone(pid);
    assert.equal(isProcessAlive(pid), false);
    assert.equal(readHeader(path.join(daemon.dataDir, "SYSTEM.hwdb")).cleanShutdown, 1, signal);
    const before = daemon.log().length;
    daemon.start();
    assert.doesNotMatch(logSince(daemon, before), /not shut down cleanly/, signal);
    daemon.stopClean();
  }
});
