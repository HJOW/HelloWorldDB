/**
 * 11단계 통합 검증 : 이전 포맷 버전으로 만든 데이터 디렉토리의 호환성 (AGENTS.md 상세 3 "버전 관리").
 *
 * `test/fixtures/datadir-v<N>/` 는 포맷 버전 N 을 쓰던 서버가 만든 데이터 디렉토리(SYSTEM 과 사용자 테이블스페이스 APP)이다.
 * 이 시험은 버전마다 그 자료를 복사해 실제 데몬(`hwdb start`)으로 열고 아래를 확인한다.
 *  - 버전 보호 : 서버가 쓰는 포맷 버전(`LATEST_FORMAT_VERSION`)이 올라가면 이전 버전 자료가 있어야 이 시험이 통과한다.
 *    새 버전을 도입하기 전에 `node test/fixtures/create-datadir.mjs <버전>` 으로 지금 버전의 자료를 먼저 보관한다.
 *  - 읽기 : 이전 버전의 객체(테이블, 뷰, 인덱스, FK, 사용자, 권한)와 데이터가 그대로 읽히고 인덱스도 맞다.
 *  - 쓰기 : 이전 버전 테이블스페이스에서도 그 버전 기준의 모든 기능(DML, DDL, 트랜잭션, 권한)이 동작하고,
 *    파일은 업그레이드되지 않는다(버전 그대로). 새로 만드는 테이블스페이스는 최신 버전이다.
 *
 * 자료는 해시를 고정해 두어 실수로 바뀌지 않게 한다. 1.0 출시 전의 의도적인 포맷 변경에는 개요 3 의 예외가 적용되며,
 * 그때는 자료와 해시, 이 시험의 기대값, test/fixtures/README.md 를 함께 갱신한다.
 *
 * 관련 사양 : AGENTS.md 개요 3, 상세 3
 * 구현 단계 : 11단계
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LATEST_FORMAT_VERSION } from "../../src/storage/format/format.js";
import { Daemon, exec, execAll, failure, num, query } from "./helpers.js";

const FIXTURES = fileURLToPath(new URL("../../../test/fixtures/", import.meta.url));

/** 버전별 자료의 파일 해시이다. 자료를 바꿨으면(1.0 출시 전에만) 여기도 바꾼다. */
const FIXTURE_HASHES: Record<number, Record<string, string>> = {
  1: {
    "APP.hwdb": "6131b93e39026d745e0f9b157d4f252d30c5e28350ced67cdf78cba1754367ac",
    "SYSTEM.hwdb": "5d4e6fcc728d24658fd1f3a262823590cc19125b64eeeda7f942ebf194d2a598",
  },
};

function fixtureDir(version: number): string {
  return path.join(FIXTURES, `datadir-v${version}`);
}

/** 데이터 파일 헤더의 앞쪽 값이다. (매직과 포맷 버전은 어느 버전이든 맨 앞 고정 위치. 정상 종료 표시는 v1 레이아웃의 624번 바이트) */
function header(file: string): { magic: string; version: number; clean: boolean } {
  const bytes = fs.readFileSync(file);
  return { magic: bytes.subarray(0, 8).toString("latin1"), version: bytes.readUInt32LE(8), clean: bytes[624] === 1 };
}

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// 자료가 설명하는 데이터 (test/fixtures/create-datadir.mjs 와 짝이다)
const EMP_IDS = Array.from({ length: 300 }, (_, index) => index + 1).filter((id) => id < 101 || id > 110);
const salaryCents = (id: number): number => 100000 + id * 125 + (id <= 5 ? 100 : 0);
const money = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
const hired = (id: number): string => new Date(Date.UTC(2020, 0, 1) + id * 86400000).toISOString().slice(0, 10);
const DEPT_NAMES: Record<number, string> = { 1: "Sales", 2: "Engineering", 3: "Support" };

test("버전 보호 : 서버가 쓰는 포맷 버전마다 이전 버전의 데이터 디렉토리 자료가 있고, 해시와 파일 헤더가 맞다", () => {
  const found = fs.readdirSync(FIXTURES).map((name) => /^datadir-v(\d+)$/.exec(name)?.[1]).filter((v): v is string => v !== undefined).map(Number).sort((a, b) => a - b);
  for (let version = 1; version <= LATEST_FORMAT_VERSION; version++) {
    assert.ok(found.includes(version),
      `포맷 버전 ${version} 의 호환성 자료(test/fixtures/datadir-v${version})가 없다. 그 버전을 쓰는 서버로 ` +
      `\`node test/fixtures/create-datadir.mjs ${version}\` 을 실행해 만들어 보관한다. 새 포맷 버전을 도입할 때는 올리기 전에 지금 버전의 자료를 먼저 ` +
      "만들어 두어야 이전 버전 파일을 계속 열 수 있는지 시험할 수 있다 (AGENTS.md 상세 3).");
  }
  for (const version of found) {
    const expected = FIXTURE_HASHES[version];
    assert.ok(expected !== undefined, `datadir-v${version} 의 해시가 이 시험에 없다`);
    const files = fs.readdirSync(fixtureDir(version)).sort();
    assert.deepEqual(files, Object.keys(expected).sort(), `datadir-v${version} 의 파일 구성`);
    for (const name of files) {
      const file = path.join(fixtureDir(version), name);
      assert.equal(sha256(file), expected[name], `${name} 의 해시가 바뀌었다 (자료는 원본을 직접 열거나 고치지 않는다)`);
      const head = header(file);
      assert.equal(head.magic, "HWDBTS\r\n");
      assert.equal(head.version, version, `${name} 의 포맷 버전은 디렉토리 이름과 같다`);
      assert.equal(head.clean, true, `${name} 는 정상 종료된 상태로 보관한다`);
    }
  }
});

const versions = fs.readdirSync(FIXTURES).map((name) => /^datadir-v(\d+)$/.exec(name)?.[1]).filter((v): v is string => v !== undefined).map(Number).sort((a, b) => a - b);

/** 자료를 새 설치 디렉토리의 데이터 디렉토리로 복사한 데몬을 만든다. 원본은 건드리지 않는다. */
async function openFixture(t: { after(fn: () => void): void }, version: number): Promise<Daemon> {
  const daemon = await Daemon.create(t);
  fs.cpSync(fixtureDir(version), daemon.dataDir, { recursive: true });
  return daemon;
}

for (const version of versions) {
  test(`포맷 v${version} : 이전 버전으로 만든 데이터 디렉토리를 경고 없이 열고 객체와 데이터를 그대로 읽는다`, async (t) => {
    const daemon = await openFixture(t, version);
    daemon.start();
    const log = daemon.log();
    assert.doesNotMatch(log, /not shut down cleanly/i);
    assert.doesNotMatch(log, /unavailable|corrupt/i);
    assert.deepEqual(
      (await query(await daemon.connect("tcp"), "SELECT TABLESPACE_NAME, FORMAT_VERSION, CHARACTER_SET, STATUS FROM SYS_TABLESPACES ORDER BY TABLESPACE_NAME")),
      [["APP", version, "UTF8", "AVAILABLE"], ["SYSTEM", version, "UTF8", "AVAILABLE"]],
    );
    const c = await daemon.connect("tcp");

    // 테이블 데이터
    assert.deepEqual(await query(c, "SELECT COUNT(*), SUM(SALARY), MIN(HIRED), MAX(HIRED) FROM APP.EMP"),
      [[String(EMP_IDS.length), money(EMP_IDS.reduce((sum, id) => sum + salaryCents(id), 0)), hired(1), hired(300)]]);
    for (const id of [1, 3, 5, 6, 100, 111, 300]) {
      assert.deepEqual(await query(c, "SELECT NAME, DEPT_ID, SALARY, HIRED, LENGTH(NOTE) FROM APP.EMP WHERE ID = ?", [id]),
        [[`EMP${id}`, 1 + (id % 3), money(salaryCents(id)), hired(id), String(5 + (id % 50) * 30)]], `행 ${id}`);
    }
    assert.equal(await num(c, "SELECT COUNT(*) FROM APP.EMP WHERE ID BETWEEN 101 AND 110"), 0, "지운 행은 지워진 채");
    assert.deepEqual(await query(c, "SELECT ID, NAME FROM APP.DEPT ORDER BY ID"), [[1, "Sales"], [2, "Engineering"], [3, "Support"]]);
    // 오버플로 행
    const big = await query(c, "SELECT ID, DATA FROM APP.BIG ORDER BY ID");
    assert.deepEqual(big, [[1, "AB".repeat(20000)], [2, "01".repeat(100)]]);
    // 모든 데이터 타입
    assert.deepEqual(await query(c, "SELECT * FROM APP.TYPES ORDER BY SI"), [
      ["ab   ", "한글😀", -32768, "9223372036854775807", "12345678.1235", 1.5, 2.25, true, "2026-10-16", "12:34:56.789", "2026-10-16 12:34:56.123456",
        "2026-10-16 12:34:56.123+09:00", "1-02", "3 04:05:06.000000", "0A0B0C0D", "00FF"],
      Array.from({ length: 16 }, () => null),
    ]);

    // 인덱스 : 인덱스를 쓰는 조건과 쓸 수 없는 같은 뜻의 조건의 결과가 같다. (복합 인덱스의 DESC 컬럼 포함)
    for (const name of ["EMP1", "EMP150", "EMP300", "EMP105", "NOBODY"]) {
      assert.deepEqual(await query(c, "SELECT ID FROM APP.EMP WHERE NAME = ?", [name]), await query(c, "SELECT ID FROM APP.EMP WHERE NAME || '' = ?", [name]), name);
    }
    assert.deepEqual(await query(c, "SELECT ID FROM APP.EMP WHERE NAME = 'EMP150'"), [[150]]);
    assert.deepEqual(await query(c, "SELECT ID FROM APP.EMP WHERE DEPT_ID = 2 AND SALARY > 1300 ORDER BY SALARY DESC"),
      await query(c, "SELECT ID FROM APP.EMP WHERE DEPT_ID + 0 = 2 AND SALARY + 0 > 1300 ORDER BY SALARY DESC"));
    assert.ok((await query(c, "SELECT ID FROM APP.EMP WHERE DEPT_ID = 2 AND SALARY > 1300")).length > 0);
    // 갱신으로 바뀐 값의 인덱스 항목
    assert.deepEqual(await query(c, "SELECT ID FROM APP.EMP WHERE DEPT_ID = 3 AND SALARY = 1007.25"), [[5]]);

    // 뷰
    assert.deepEqual(await query(c, "SELECT ID, NAME, DEPT FROM APP.EMP_V WHERE ID IN (3, 4, 5) ORDER BY ID"),
      [3, 4, 5].map((id) => [id, `EMP${id}`, DEPT_NAMES[1 + (id % 3)]]));

    // 사전 뷰
    assert.deepEqual(await query(c, "SELECT INDEX_NAME FROM SYS_INDEXES WHERE TABLESPACE_NAME = 'APP' ORDER BY INDEX_NAME"),
      [["IX_EMP_DEPT_SAL"], ["IX_EMP_NAME"], ["PK_BIG"], ["PK_DEPT"], ["PK_EMP"]]);
    assert.deepEqual(await query(c, "SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE FROM SYS_CONSTRAINTS WHERE TABLESPACE_NAME = 'APP' ORDER BY CONSTRAINT_NAME"),
      [["FK_EMP_1", "FOREIGN KEY"], ["PK_BIG", "PRIMARY KEY"], ["PK_DEPT", "PRIMARY KEY"], ["PK_EMP", "PRIMARY KEY"]]);

    // 제약조건은 이전 버전 데이터에도 적용된다.
    assert.equal((await failure(c, "INSERT INTO APP.EMP (ID, NAME, DEPT_ID) VALUES (999, 'x', 99)")).sqlState, "23503");
    assert.equal((await failure(c, "INSERT INTO APP.EMP (ID, NAME) VALUES (1, 'dup')")).sqlState, "23505");
    assert.equal((await failure(c, "INSERT INTO APP.EMP (ID, NAME) VALUES (1000, NULL)")).sqlState, "23502");

    // 사용자와 권한 : 비밀번호 검증 정보(SCRAM)와 권한 기록도 그대로 쓸 수 있다.
    const alice = await daemon.connect("local", { user: "ALICE", password: "alice-pw" });
    assert.equal(await num(alice, "SELECT COUNT(*) FROM APP.EMP_V"), EMP_IDS.length, "뷰 권한만으로 기반 테이블 없이 조회");
    assert.equal((await failure(alice, "SELECT * FROM APP.EMP")).sqlState, "42501");
    await exec(alice, "INSERT INTO APP.DEPT VALUES (4, 'Ops')");
    assert.equal((await failure(alice, "DELETE FROM APP.DEPT WHERE ID = 4")).sqlState, "42501");
    await assert.rejects(() => daemon.connect("local", { user: "ALICE", password: "wrong" }), (error: { sqlState?: string }) => error.sqlState === "28000");
  });

  test(`포맷 v${version} : 이전 버전 테이블스페이스에서도 DML, DDL, 트랜잭션이 동작하고 파일은 업그레이드되지 않으며, 새 테이블스페이스는 최신 버전이다`, async (t) => {
    const daemon = await openFixture(t, version);
    daemon.start();
    const c = await daemon.connect("tcp");

    // DML
    for (let from = 1001; from <= 1050; from += 25) {
      const rows = Array.from({ length: 25 }, (_, index) => `(${from + index}, 'NEW${from + index}', ${1 + ((from + index) % 3)}, 2000.50, DATE '2026-01-01', 'n')`);
      await exec(c, `INSERT INTO APP.EMP VALUES ${rows.join(", ")}`);
    }
    await exec(c, "UPDATE APP.EMP SET SALARY = SALARY * 2, NOTE = 'updated' WHERE ID BETWEEN 1001 AND 1010");
    await exec(c, "DELETE FROM APP.EMP WHERE ID BETWEEN 1041 AND 1050");
    await exec(c, "UPDATE APP.BIG SET DATA = ? WHERE ID = 2", [Buffer.alloc(30000, 0x07)]);
    assert.equal(await num(c, "SELECT COUNT(*) FROM APP.EMP"), EMP_IDS.length + 40);
    assert.deepEqual(await query(c, "SELECT SALARY, NOTE FROM APP.EMP WHERE ID = 1005"), [["4001.00", "updated"]]);
    assert.equal(await num(c, "SELECT COUNT(*) FROM APP.EMP WHERE NAME = 'NEW1005'"), 1, "새 행도 이전 인덱스에 들어간다");
    // 참조동작 : 부서를 지우면 소속 직원의 DEPT_ID 가 NULL 이 된다. (ON DELETE SET NULL)
    const inSupport = await num(c, "SELECT COUNT(*) FROM APP.EMP WHERE DEPT_ID = 3");
    assert.ok(inSupport > 0);
    await exec(c, "DELETE FROM APP.DEPT WHERE ID = 3");
    assert.equal(await num(c, "SELECT COUNT(*) FROM APP.EMP WHERE DEPT_ID IS NULL"), inSupport);

    // 트랜잭션 : 롤백하면 이전 버전 파일에서도 되돌아간다.
    await execAll(c, ["BEGIN", "DELETE FROM APP.EMP", "ROLLBACK"]);
    assert.equal(await num(c, "SELECT COUNT(*) FROM APP.EMP"), EMP_IDS.length + 40);
    await execAll(c, ["BEGIN", "INSERT INTO APP.DEPT VALUES (9, 'Temp')", "SAVEPOINT S", "INSERT INTO APP.DEPT VALUES (10, 'Gone')", "ROLLBACK TO S", "COMMIT"]);
    assert.deepEqual(await query(c, "SELECT ID FROM APP.DEPT ORDER BY ID"), [[1], [2], [9]]);

    // DDL : 컬럼 추가, 인덱스, 뷰, 새 테이블, 삭제
    await exec(c, "ALTER TABLE APP.EMP ADD COLUMN GRADE INTEGER DEFAULT 1");
    assert.equal(await num(c, "SELECT SUM(GRADE) FROM APP.EMP"), EMP_IDS.length + 40);
    await exec(c, "CREATE INDEX APP.IX_EMP_GRADE ON APP.EMP (GRADE)");
    await exec(c, "CREATE VIEW APP.RICH AS SELECT ID, NAME FROM APP.EMP WHERE SALARY > 3000");
    assert.deepEqual(await query(c, "SELECT ID FROM APP.RICH ORDER BY ID"), [[1001], [1002], [1003], [1004], [1005], [1006], [1007], [1008], [1009], [1010]]);
    await exec(c, "CREATE TABLE APP.LOG (ID INTEGER PRIMARY KEY, MSG VARCHAR(100))");
    await exec(c, "INSERT INTO APP.LOG VALUES (0, 'to be truncated')");
    await exec(c, "TRUNCATE TABLE APP.LOG");
    await exec(c, "INSERT INTO APP.LOG VALUES (1, 'written by the newer server')");
    assert.equal((await failure(c, "TRUNCATE TABLE APP.DEPT")).sqlState, "23503", "FK 가 참조하는 테이블은 비울 수 없다");
    assert.equal((await failure(c, "DROP TABLE APP.DEPT")).sqlState, "55006", "참조되는 테이블은 RESTRICT 로 지울 수 없다");
    await exec(c, "DROP TABLE APP.BIG");
    // 삭제로 비운 공간은 다시 쓰인다 : 같은 크기의 새 테이블이 파일을 키우지 않는다.
    const sizeBefore = fs.statSync(path.join(daemon.dataDir, "APP.hwdb")).size;
    await exec(c, "CREATE TABLE APP.BIG2 (ID INTEGER PRIMARY KEY, DATA VARBINARY(30000))");
    await exec(c, "INSERT INTO APP.BIG2 VALUES (1, ?)", [Buffer.alloc(20000, 0x55)]);
    assert.equal(fs.statSync(path.join(daemon.dataDir, "APP.hwdb")).size, sizeBefore, "삭제로 반환된 페이지를 다시 쓴다");

    // 새 테이블스페이스는 최신 포맷이고, 이전 버전 파일은 업그레이드되지 않는다.
    await exec(c, "CREATE TABLESPACE NEWER");
    await exec(c, "CREATE TABLE NEWER.T (N INTEGER)");
    await exec(c, "INSERT INTO NEWER.T VALUES (1)");
    assert.deepEqual(await query(c, "SELECT TABLESPACE_NAME, FORMAT_VERSION FROM SYS_TABLESPACES ORDER BY TABLESPACE_NAME"),
      [["APP", version], ["NEWER", LATEST_FORMAT_VERSION], ["SYSTEM", version]]);

    // 정상 종료하면 파일은 그대로 그 버전이고 정상 종료 표시가 있다. 다시 구동해도 모두 남아 있다.
    daemon.stopClean();
    for (const [name, expected] of [["APP.hwdb", version], ["SYSTEM.hwdb", version], ["NEWER.hwdb", LATEST_FORMAT_VERSION]] as const) {
      const head = header(path.join(daemon.dataDir, name));
      assert.equal(head.version, expected, `${name} 의 포맷 버전`);
      assert.equal(head.clean, true, `${name} 의 정상 종료 표시`);
    }
    daemon.start();
    assert.doesNotMatch(daemon.log(), /not shut down cleanly/i);
    const again = await daemon.connect("tcp");
    assert.equal(await num(again, "SELECT COUNT(*) FROM APP.EMP"), EMP_IDS.length + 40);
    assert.equal(await num(again, "SELECT COUNT(*) FROM APP.EMP WHERE GRADE = 1"), EMP_IDS.length + 40);
    assert.deepEqual(await query(again, "SELECT MSG FROM APP.LOG"), [["written by the newer server"]]);
    assert.deepEqual(await query(again, "SELECT COUNT(*) FROM APP.DEPT"), [["3"]]);
    assert.equal(await num(again, "SELECT COUNT(*) FROM NEWER.T"), 1);
    assert.equal((await failure(again, "SELECT * FROM APP.BIG")).sqlState, "42P01");
    // 원본 자료는 건드리지 않았다.
    for (const [name, hash] of Object.entries(FIXTURE_HASHES[version] ?? {})) assert.equal(sha256(path.join(fixtureDir(version), name)), hash);
  });
}
