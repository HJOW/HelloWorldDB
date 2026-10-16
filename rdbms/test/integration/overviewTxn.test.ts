/**
 * 개요 10, 11 의 시나리오 시험 (11단계). 실제 `hwdb start` 로 띄운 데몬에 두 세션(TCP, UDP)으로 접속해 확인한다.
 *  - 개요 10 : 트랜잭션(자동 커밋, BEGIN·COMMIT·ROLLBACK, 세이브포인트, 문장 실패 때 되돌리는 범위, DDL 의 자동 커밋, READ COMMITTED 하나, 행 잠금)과
 *            인덱스(B+Tree 단일·복합 컬럼 최대 16개, ASC·DESC, 이름 자동 부여, PK 로만 만드는 유일 인덱스, 지원하지 않는 종류)
 *  - 개요 11 : 제약조건은 PK, NOT NULL, FK 만 지원. UNIQUE, CHECK 는 오류. DEFAULT 는 컬럼 속성
 * 동시성의 세부(교착, 잠금 대기 초과, 접속 끊김)는 `concurrency.test.ts`, 제약·참조동작의 깊은 조합은 `test/exec`, `test/txn` 이다.
 * 관련 사양 : AGENTS.md 개요 10, 11, 상세 10, 11
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DbError } from "../../src/common/errors.js";
import { Daemon, exec, execAll, failure, num, query, sleep } from "./helpers.js";

// ---------------------------------------------------------------------------
// 개요 10 : 트랜잭션
// ---------------------------------------------------------------------------

test("개요 10 : 자동 커밋이 기본이고, BEGIN 으로 시작한 트랜잭션은 COMMIT 전까지 다른 세션에 보이지 않는다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const a = await daemon.connect("tcp");
  const b = await daemon.connect("udp");
  assert.equal(a.session?.autocommit, true, "자동 커밋은 기본이 ON 이다");
  await exec(a, "CREATE TABLE ACC (ID INTEGER PRIMARY KEY, V INTEGER)");
  await exec(a, "INSERT INTO ACC VALUES (1, 10)");
  assert.equal(await num(b, "SELECT COUNT(*) FROM ACC"), 1, "자동 커밋이라 바로 보인다");

  await exec(a, "BEGIN");
  await exec(a, "INSERT INTO ACC VALUES (2, 20)");
  await exec(a, "UPDATE ACC SET V = 11 WHERE ID = 1");
  assert.equal(await num(a, "SELECT COUNT(*) FROM ACC"), 2, "자기 변경은 자기에게 보인다");
  assert.equal(await num(b, "SELECT COUNT(*) FROM ACC"), 1, "커밋 전에는 다른 세션에 보이지 않는다");
  assert.equal(await num(b, "SELECT V FROM ACC WHERE ID = 1"), 10);
  await exec(a, "COMMIT");
  assert.equal(await num(b, "SELECT COUNT(*) FROM ACC"), 2);
  assert.equal(await num(b, "SELECT V FROM ACC WHERE ID = 1"), 11);

  await exec(a, "START TRANSACTION");
  await exec(a, "DELETE FROM ACC");
  await exec(a, "ROLLBACK");
  assert.equal(await num(b, "SELECT COUNT(*) FROM ACC"), 2, "ROLLBACK 은 변경을 버린다");
  await exec(a, "BEGIN");
  await exec(a, "DELETE FROM ACC WHERE ID = 2");
  await exec(a, "COMMIT WORK");
  assert.equal(await num(b, "SELECT COUNT(*) FROM ACC"), 1);
});

test("개요 10 : SET AUTOCOMMIT OFF 이면 첫 문장에서 트랜잭션이 자동으로 시작되고 COMMIT·ROLLBACK 으로 끝난다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const a = await daemon.connect("tcp");
  const b = await daemon.connect("tcp");
  await exec(a, "CREATE TABLE T (ID INTEGER PRIMARY KEY)");
  await exec(a, "SET AUTOCOMMIT OFF");
  await exec(a, "INSERT INTO T VALUES (1)");
  assert.equal(await num(b, "SELECT COUNT(*) FROM T"), 0, "BEGIN 없이도 트랜잭션이 시작되어 있다");
  await exec(a, "COMMIT");
  assert.equal(await num(b, "SELECT COUNT(*) FROM T"), 1);
  await exec(a, "INSERT INTO T VALUES (2)"); // 새 트랜잭션이 자동으로 시작된다
  await exec(a, "ROLLBACK");
  assert.equal(await num(b, "SELECT COUNT(*) FROM T"), 1);
  await exec(a, "INSERT INTO T VALUES (3)");
  assert.equal(await num(a, "SELECT COUNT(*) FROM T"), 2);
  await exec(a, "COMMIT");
  await exec(a, "SET AUTOCOMMIT ON");
  await exec(a, "INSERT INTO T VALUES (4)");
  assert.equal(await num(b, "SELECT COUNT(*) FROM T"), 3, "다시 켜면 문장마다 바로 커밋된다");
});

test("개요 10 : 세이브포인트 — ROLLBACK TO 는 그 이후의 변경만 되돌리고 이후에 만든 세이브포인트는 사라진다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const a = await daemon.connect("tcp");
  const b = await daemon.connect("udp");
  await exec(a, "CREATE TABLE S (ID INTEGER PRIMARY KEY)");
  await exec(a, "BEGIN");
  await exec(a, "INSERT INTO S VALUES (1)");
  await exec(a, "SAVEPOINT S1");
  await exec(a, "INSERT INTO S VALUES (2)");
  await exec(a, "SAVEPOINT S2");
  await exec(a, "INSERT INTO S VALUES (3)");
  await exec(a, "ROLLBACK TO S2");
  assert.deepEqual(await query(a, "SELECT ID FROM S ORDER BY ID"), [[1], [2]]);
  await exec(a, "ROLLBACK TO SAVEPOINT S1");
  assert.deepEqual(await query(a, "SELECT ID FROM S ORDER BY ID"), [[1]]);
  assert.equal((await failure(a, "ROLLBACK TO S2")).sqlState, "3B001", "S1 로 돌아가면서 S2 는 사라졌다");
  await exec(a, "INSERT INTO S VALUES (4)");
  await exec(a, "RELEASE SAVEPOINT S1");
  assert.equal((await failure(a, "ROLLBACK TO S1")).sqlState, "3B001", "RELEASE 한 세이브포인트로는 돌아갈 수 없다");
  assert.equal(await num(b, "SELECT COUNT(*) FROM S"), 0);
  await exec(a, "COMMIT");
  assert.deepEqual(await query(b, "SELECT ID FROM S ORDER BY ID"), [[1], [4]]);
});

test("개요 10 : 문장이 실패하면 그 문장이 한 변경만 되돌리고 트랜잭션은 유지된다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const a = await daemon.connect("tcp");
  const b = await daemon.connect("tcp");
  await exec(a, "CREATE TABLE F (ID INTEGER PRIMARY KEY, V VARCHAR(3))");
  await exec(a, "BEGIN");
  await exec(a, "INSERT INTO F VALUES (1, 'a')");
  // 여러 행을 넣다가 셋째에서 실패하면 앞의 두 행도 남지 않는다 (문장 단위)
  assert.equal((await failure(a, "INSERT INTO F VALUES (2, 'b'), (3, 'c'), (1, 'dup')")).sqlState, "23505");
  assert.equal((await failure(a, "INSERT INTO F VALUES (4, 'toolong')")).sqlState, "22001");
  assert.equal((await failure(a, "UPDATE F SET ID = 1, V = 'zzzzz'")).sqlState, "22001");
  assert.deepEqual(await query(a, "SELECT ID, V FROM F ORDER BY ID"), [[1, "a"]], "실패한 문장의 변경은 없고 트랜잭션의 앞 변경은 그대로이다");
  await exec(a, "INSERT INTO F VALUES (5, 'e')");
  await exec(a, "COMMIT");
  assert.deepEqual(await query(b, "SELECT ID FROM F ORDER BY ID"), [[1], [5]]);
  // 자동 커밋 상태에서 실패한 문장도 아무 흔적이 없다.
  assert.equal((await failure(a, "INSERT INTO F VALUES (6, 'f'), (5, 'dup')")).sqlState, "23505");
  assert.equal(await num(b, "SELECT COUNT(*) FROM F"), 2);
});

test("개요 10 : DDL, GRANT, REVOKE, 사용자·테이블스페이스 관리 문장은 실행 전후에 자동으로 커밋되고 롤백할 수 없다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const a = await daemon.connect("tcp");
  const b = await daemon.connect("udp");
  await exec(a, "CREATE TABLE D (ID INTEGER)");
  for (const [ddl, check] of [
    ["CREATE TABLE D2 (ID INTEGER)", "SELECT COUNT(*) FROM SYS_TABLES WHERE TABLE_NAME = 'D2'"],
    ["CREATE INDEX IX_D ON D (ID)", "SELECT COUNT(*) FROM SYS_INDEXES WHERE INDEX_NAME = 'IX_D'"],
    ["CREATE USER DDLUSER IDENTIFIED BY 'x'", "SELECT COUNT(*) FROM SYS_USERS WHERE USER_NAME = 'DDLUSER'"],
    ["CREATE TABLESPACE DDLSPACE", "SELECT COUNT(*) FROM SYS_TABLESPACES WHERE TABLESPACE_NAME = 'DDLSPACE'"],
    ["GRANT SELECT ON TABLE D TO DDLUSER", "SELECT COUNT(*) FROM SYS_PRIVILEGES WHERE GRANTEE = 'DDLUSER'"],
  ] as const) {
    await exec(a, "BEGIN");
    await exec(a, "INSERT INTO D VALUES (1)");
    await exec(a, ddl);
    // DDL 앞에서 앞선 변경이 커밋되었다.
    assert.equal(await num(b, "SELECT COUNT(*) FROM D"), await num(a, "SELECT COUNT(*) FROM D"), `${ddl}: DDL 앞의 INSERT 가 커밋되었다`);
    await exec(a, "ROLLBACK");
    assert.equal(await num(b, check), 1, `${ddl}: ROLLBACK 으로 되돌릴 수 없다`);
  }
  assert.equal(await num(a, "SELECT COUNT(*) FROM D"), 5);
  // DDL 이 명시적 트랜잭션을 끝낸 뒤의 문장은 자동 커밋 설정을 따른다. 켜져 있으면(기본) 문장마다 바로 커밋되어 ROLLBACK 이 되돌릴 것이 없다.
  await exec(a, "BEGIN");
  await exec(a, "DROP TABLE D2");
  await exec(a, "INSERT INTO D VALUES (2)");
  await exec(a, "ROLLBACK");
  assert.equal(await num(b, "SELECT COUNT(*) FROM D"), 6);
  // 꺼져 있으면 DDL 뒤의 첫 문장이 새 트랜잭션을 시작하고 그 변경은 롤백된다.
  await exec(a, "SET AUTOCOMMIT OFF");
  await exec(a, "CREATE TABLE D3 (X INTEGER)");
  await exec(a, "INSERT INTO D VALUES (3)");
  assert.equal(await num(b, "SELECT COUNT(*) FROM D"), 6, "아직 커밋 전");
  await exec(a, "ROLLBACK");
  assert.equal(await num(b, "SELECT COUNT(*) FROM D"), 6);
  assert.equal(await num(b, "SELECT COUNT(*) FROM SYS_TABLES WHERE TABLE_NAME = 'D3'"), 1, "DDL 은 이미 커밋되어 롤백되지 않았다");
});

test("개요 10 : 격리 수준은 READ COMMITTED 하나이다 (재조회가 다른 트랜잭션이 커밋한 값을 본다)", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const a = await daemon.connect("tcp");
  const b = await daemon.connect("udp");
  await execAll(a, ["CREATE TABLE R (ID INTEGER PRIMARY KEY, V INTEGER)", "INSERT INTO R VALUES (1, 1)"]);
  await exec(b, "BEGIN");
  assert.equal(await num(b, "SELECT V FROM R WHERE ID = 1"), 1);
  await exec(a, "UPDATE R SET V = 2 WHERE ID = 1"); // 자동 커밋
  assert.equal(await num(b, "SELECT V FROM R WHERE ID = 1"), 2, "트랜잭션 안에서도 문장마다 커밋된 최신 값을 읽는다");
  await exec(a, "INSERT INTO R VALUES (2, 9)");
  assert.equal(await num(b, "SELECT COUNT(*) FROM R"), 2, "팬텀도 보인다");
  await exec(b, "COMMIT");
  await exec(b, "SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
  for (const level of ["SERIALIZABLE", "REPEATABLE READ", "READ UNCOMMITTED"]) {
    assert.equal((await failure(b, `SET TRANSACTION ISOLATION LEVEL ${level}`)).sqlState, "0A000", level);
  }
});

test("개요 10 : 같은 행을 바꾸려는 트랜잭션은 행 잠금으로 순서가 정해지고 SELECT ... FOR UPDATE 도 같은 잠금을 건다", async (t) => {
  const daemon = await Daemon.create(t, { transaction: { lockTimeoutMs: 1500 } });
  daemon.start();
  const a = await daemon.connect("tcp");
  const b = await daemon.connect("udp");
  await execAll(a, ["CREATE TABLE L (ID INTEGER PRIMARY KEY, V INTEGER)", "INSERT INTO L VALUES (1, 0)", "INSERT INTO L VALUES (2, 0)"]);
  await exec(a, "BEGIN");
  await exec(a, "SELECT * FROM L WHERE ID = 1 FOR UPDATE");
  assert.equal((await failure(b, "UPDATE L SET V = 1 WHERE ID = 1")).sqlState, "55P03", "FOR UPDATE 로 잠근 행은 기다리다 대기 초과");
  await exec(b, "UPDATE L SET V = 1 WHERE ID = 2"); // 다른 행은 기다리지 않는다
  assert.equal((await failure(b, "SELECT * FROM L WHERE ID = 1 FOR UPDATE")).sqlState, "55P03");
  assert.equal(await num(b, "SELECT V FROM L WHERE ID = 1"), 0, "그냥 조회는 기다리지 않는다");
  // 잠금은 커밋이나 롤백 때까지 유지되고, 끝나면 풀린다.
  const waiting = exec(b, "UPDATE L SET V = 5 WHERE ID = 1");
  await sleep(300);
  await exec(a, "ROLLBACK");
  await waiting;
  assert.equal(await num(a, "SELECT V FROM L WHERE ID = 1"), 5);
});

// ---------------------------------------------------------------------------
// 개요 10 : 인덱스
// ---------------------------------------------------------------------------

test("개요 10 : 인덱스는 테이블에만 만들 수 있고 단일·복합(최대 16개) 컬럼과 컬럼별 ASC·DESC 를 지원하며 이름은 자동 부여된다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("tcp");
  const columns = Array.from({ length: 17 }, (_, index) => `C${index + 1} INTEGER`).join(", ");
  await exec(c, `CREATE TABLE WIDE (${columns})`);
  const names = (count: number): string => Array.from({ length: count }, (_, index) => `C${index + 1}`).join(", ");
  await exec(c, `CREATE INDEX IX_16 ON WIDE (${names(16)})`);
  assert.equal((await failure(c, `CREATE INDEX IX_17 ON WIDE (${names(17)})`)).sqlState, "42P16", "컬럼은 최대 16개");
  await exec(c, "CREATE INDEX ON WIDE (C1)");
  await exec(c, "CREATE INDEX ON WIDE (C2 ASC, C3 DESC)");
  assert.deepEqual(
    await query(c, "SELECT INDEX_NAME FROM SYS_INDEXES ORDER BY 1"),
    [["IX_16"], ["IX_WIDE_1"], ["IX_WIDE_2"]],
    "이름을 생략하면 IX_테이블명_순번",
  );
  assert.deepEqual(await query(c, "SELECT COLUMN_NAME, IS_DESCENDING FROM SYS_INDEX_COLUMNS WHERE INDEX_NAME = 'IX_WIDE_2' ORDER BY ORDINAL_POSITION"), [["C2", "NO"], ["C3", "YES"]]);
  assert.equal(await num(c, "SELECT COUNT(*) FROM SYS_INDEX_COLUMNS WHERE INDEX_NAME = 'IX_16'"), 16);
  // 인덱스는 이름이 테이블스페이스 안에서 유일하다.
  assert.equal((await failure(c, "CREATE INDEX IX_16 ON WIDE (C1)")).sqlState.length, 5);
  // 테이블에만 만들 수 있다 (뷰 불가), 없는 테이블·컬럼, 같은 컬럼 반복은 오류
  await exec(c, "CREATE VIEW WV AS SELECT C1 FROM WIDE");
  assert.equal((await failure(c, "CREATE INDEX VX ON WV (C1)")).sqlState, "42P01");
  assert.equal((await failure(c, "CREATE INDEX IX ON NOSUCH (A)")).sqlState, "42P01");
  assert.equal((await failure(c, "CREATE INDEX IX ON WIDE (NOSUCH)")).sqlState, "42703");
  assert.equal((await failure(c, "CREATE INDEX IX ON WIDE (C1, C1)")).sqlState, "42701");
  // FK 컬럼에는 인덱스를 자동으로 만들지 않는다.
  await execAll(c, ["CREATE TABLE PARENT (ID INTEGER PRIMARY KEY)", "CREATE TABLE CHILD (ID INTEGER, PID INTEGER REFERENCES PARENT)"]);
  assert.equal(await num(c, "SELECT COUNT(*) FROM SYS_INDEXES WHERE TABLE_NAME = 'CHILD'"), 0);
  // 지울 수 있다.
  await exec(c, "DROP INDEX IX_16");
  assert.equal((await failure(c, "DROP INDEX IX_16")).sqlState, "42704");
});

test("개요 10 : 유일 인덱스는 PK 로만 간접적으로 만들어지고 PK 제약조건과 이름이 같으며 DROP INDEX 로 지울 수 없다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("tcp");
  await execAll(c, ["CREATE TABLE P (ID INTEGER PRIMARY KEY, N VARCHAR(5))", "CREATE TABLE P2 (A INTEGER, B INTEGER, CONSTRAINT MY_PK PRIMARY KEY (A, B))"]);
  assert.deepEqual(await query(c, "SELECT INDEX_NAME, TABLE_NAME FROM SYS_INDEXES ORDER BY 1"), [["MY_PK", "P2"], ["PK_P", "P"]]);
  assert.deepEqual(
    await query(c, "SELECT CONSTRAINT_NAME FROM SYS_CONSTRAINTS WHERE CONSTRAINT_TYPE = 'PRIMARY KEY' ORDER BY 1"),
    [["MY_PK"], ["PK_P"]],
    "유일 인덱스의 이름이 PK 제약조건의 이름과 같다",
  );
  assert.equal((await failure(c, "DROP INDEX PK_P")).sqlState, "42P16");
  // 직접 만드는 인덱스는 기본 타입(B+Tree)만 : 유일, 함수 기반, 부분, 해시, 비트맵, 전문 검색은 지원하지 않는다.
  for (const sql of [
    "CREATE UNIQUE INDEX UX ON P (N)",
    "CREATE INDEX FX ON P (UPPER(N))",
    "CREATE INDEX PX ON P (N) WHERE N IS NOT NULL",
    "CREATE BITMAP INDEX BX ON P (N)",
    "CREATE FULLTEXT INDEX TX ON P (N)",
    "CREATE INDEX HX ON P (N) USING HASH",
  ]) {
    const error = await failure(c, sql);
    assert.ok(["0A000", "42601"].includes(error.sqlState), `${sql}: ${error.sqlState}`);
  }
  assert.equal((await failure(c, "CREATE UNIQUE INDEX UX ON P (N)")).sqlState, "0A000");
  // PK 를 지우면 그 유일 인덱스도 사라진다.
  await exec(c, "ALTER TABLE P2 DROP CONSTRAINT MY_PK");
  assert.equal(await num(c, "SELECT COUNT(*) FROM SYS_INDEXES WHERE TABLE_NAME = 'P2'"), 0);
});

test("개요 10 : 인덱스를 거쳐도 결과가 같고 갱신·삭제·재구동 뒤에도 맞으며, 조건절이 인덱스를 쓰면 전체를 훑지 않는다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  let c = await daemon.connect("tcp");
  await exec(c, "CREATE TABLE PERF (ID INTEGER PRIMARY KEY, K INTEGER, V INTEGER, S VARCHAR(10))");
  const rows = 6_000;
  for (let from = 0; from < rows; from += 1000) {
    const values = Array.from({ length: 1000 }, (_, index) => {
      const id = from + index;
      return `(${id}, ${id % 997}, ${(id * 7919) % 20011}, 's${id % 50}')`;
    }).join(", ");
    await exec(c, `INSERT INTO PERF VALUES ${values}`);
  }
  await exec(c, "CREATE INDEX IX_V ON PERF (V)");
  await exec(c, "CREATE INDEX IX_KV ON PERF (K DESC, V)");

  // 인덱스를 쓰는 조건과 쓸 수 없는 같은 뜻의 조건(V + 0 = ?)의 결과가 같다.
  const same = async (indexed: string, plain: string, params: number[], what: string): Promise<void> => {
    assert.deepEqual(await query(c, indexed, params), await query(c, plain, params), what);
  };
  await same("SELECT ID FROM PERF WHERE V = ? ORDER BY ID", "SELECT ID FROM PERF WHERE V + 0 = ? ORDER BY ID", [7919], "동등 조건");
  await same("SELECT ID FROM PERF WHERE V BETWEEN ? AND ? ORDER BY ID", "SELECT ID FROM PERF WHERE V + 0 BETWEEN ? AND ? ORDER BY ID", [1000, 1200], "범위 조건");
  await same("SELECT ID FROM PERF WHERE V > ? ORDER BY ID", "SELECT ID FROM PERF WHERE V + 0 > ? ORDER BY ID", [19990], "열린 범위");
  await same("SELECT ID FROM PERF WHERE K = ? AND V < ? ORDER BY ID", "SELECT ID FROM PERF WHERE K + 0 = ? AND V + 0 < ? ORDER BY ID", [5, 10000], "복합 인덱스의 앞쪽 동등 + 다음 컬럼 범위");
  assert.deepEqual(await query(c, "SELECT K, V FROM PERF WHERE K >= 995 ORDER BY K DESC, V LIMIT 3"), await query(c, "SELECT K, V FROM PERF WHERE K + 0 >= 995 ORDER BY K DESC, V LIMIT 3"));

  // 갱신·삭제가 인덱스에 반영된다.
  await exec(c, "UPDATE PERF SET V = 99999 WHERE ID BETWEEN 100 AND 109");
  await exec(c, "DELETE FROM PERF WHERE ID BETWEEN 200 AND 299");
  await same("SELECT ID FROM PERF WHERE V = ? ORDER BY ID", "SELECT ID FROM PERF WHERE V + 0 = ? ORDER BY ID", [99999], "갱신한 값");
  assert.equal(await num(c, "SELECT COUNT(*) FROM PERF WHERE V = 99999"), 10);
  assert.equal(await num(c, "SELECT COUNT(*) FROM PERF WHERE K = 1000"), 0);
  // 재구동(강제 종료) 뒤에도 같다.
  const pid = daemon.pid as number;
  daemon.kill();
  await daemon.waitUntilGone(pid);
  daemon.start();
  c = await daemon.connect("tcp");
  await same("SELECT ID FROM PERF WHERE V = ? ORDER BY ID", "SELECT ID FROM PERF WHERE V + 0 = ? ORDER BY ID", [99999], "재구동 뒤");
  await same("SELECT ID FROM PERF WHERE V BETWEEN ? AND ? ORDER BY ID", "SELECT ID FROM PERF WHERE V + 0 BETWEEN ? AND ? ORDER BY ID", [5000, 5100], "재구동 뒤 범위");
  assert.equal(await num(c, "SELECT COUNT(*) FROM PERF"), rows - 100);

  // 규칙 기반 계획 : 인덱스 컬럼의 동등·범위 조건이면 인덱스를 쓴다. 쓰면 같은 질의를 여러 번 해도 전체를 훑는 질의보다 훨씬 빠르다.
  const time = async (sql: string, params: (index: number) => number[]): Promise<number> => {
    const started = Date.now();
    for (let n = 0; n < 15; n++) await query(c, sql, params(n));
    return Date.now() - started;
  };
  await time("SELECT ID FROM PERF WHERE V = ?", (n) => [n * 100]); // 데워 둔다
  const withIndex = await time("SELECT ID FROM PERF WHERE V = ?", (n) => [n * 100 + 1]);
  const withoutIndex = await time("SELECT ID FROM PERF WHERE V + 0 = ?", (n) => [n * 100 + 1]);
  assert.ok(withIndex * 3 < withoutIndex, `인덱스를 쓴 질의(${withIndex} ms)가 전체를 훑는 질의(${withoutIndex} ms)보다 훨씬 빨라야 한다`);
});

// ---------------------------------------------------------------------------
// 개요 11 : 제약조건
// ---------------------------------------------------------------------------

test("개요 11 : PRIMARY KEY — 테이블당 하나, 단일·복합 컬럼, 컬럼은 자동으로 NOT NULL, 중복은 거부된다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("tcp");
  await execAll(c, ["CREATE TABLE ONE (ID INTEGER PRIMARY KEY, V INTEGER)", "CREATE TABLE TWO (A INTEGER, B VARCHAR(5), V INTEGER, PRIMARY KEY (A, B))"]);
  assert.equal((await failure(c, "CREATE TABLE BAD (A INTEGER PRIMARY KEY, B INTEGER PRIMARY KEY)")).sqlState, "42P16", "테이블당 하나");
  assert.equal((await failure(c, "CREATE TABLE BAD2 (A INTEGER, B INTEGER, PRIMARY KEY (A), PRIMARY KEY (B))")).sqlState, "42P16");
  await exec(c, "INSERT INTO ONE VALUES (1, 1)");
  assert.equal((await failure(c, "INSERT INTO ONE VALUES (1, 2)")).sqlState, "23505");
  assert.equal((await failure(c, "INSERT INTO ONE VALUES (NULL, 2)")).sqlState, "23502", "PK 컬럼은 자동으로 NOT NULL");
  await exec(c, "INSERT INTO ONE VALUES (2, 2)");
  assert.equal((await failure(c, "UPDATE ONE SET ID = 1 WHERE ID = 2")).sqlState, "23505", "PK 를 갱신해서 중복이 되어도 거부");
  await exec(c, "UPDATE ONE SET ID = 3 WHERE ID = 2");
  // 복합 PK : 조합이 같을 때만 중복이다
  await exec(c, "INSERT INTO TWO VALUES (1, 'a', 0)");
  await exec(c, "INSERT INTO TWO VALUES (1, 'b', 0)");
  await exec(c, "INSERT INTO TWO VALUES (2, 'a', 0)");
  assert.equal((await failure(c, "INSERT INTO TWO VALUES (1, 'a', 9)")).sqlState, "23505");
  assert.equal((await failure(c, "INSERT INTO TWO VALUES (1, NULL, 9)")).sqlState, "23502", "복합 PK 의 어느 컬럼도 NULL 일 수 없다");
  // 기존 데이터가 어기면 PK 를 추가할 수 없다.
  await exec(c, "CREATE TABLE LATE (A INTEGER, B INTEGER)");
  await execAll(c, ["INSERT INTO LATE VALUES (1, 1)", "INSERT INTO LATE VALUES (1, 2)"]);
  assert.equal((await failure(c, "ALTER TABLE LATE ADD PRIMARY KEY (A)")).sqlState, "23505");
  await exec(c, "ALTER TABLE LATE ADD CONSTRAINT LATE_PK PRIMARY KEY (A, B)");
  assert.equal((await failure(c, "INSERT INTO LATE VALUES (1, 2)")).sqlState, "23505");
  // 이름 규칙 : PK_테이블명 자동 부여, 지정하면 그 이름, 이름은 테이블스페이스 안에서 유일하다.
  assert.deepEqual(await query(c, "SELECT TABLE_NAME, CONSTRAINT_NAME FROM SYS_CONSTRAINTS WHERE CONSTRAINT_TYPE = 'PRIMARY KEY' ORDER BY 1"), [["LATE", "LATE_PK"], ["ONE", "PK_ONE"], ["TWO", "PK_TWO"]]);
  assert.deepEqual(await query(c, "SELECT COLUMN_NAME FROM SYS_CONSTRAINT_COLUMNS WHERE CONSTRAINT_NAME = 'PK_TWO' ORDER BY ORDINAL_POSITION"), [["A"], ["B"]]);
  assert.equal((await failure(c, "CREATE TABLE DUPNAME (A INTEGER, CONSTRAINT PK_ONE PRIMARY KEY (A))")).sqlState.length, 5);
});

test("개요 11 : NOT NULL — 컬럼 단위로 지정하고 바꿀 수 있으며 기존 데이터가 어기면 바꿀 수 없다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("udp");
  await exec(c, "CREATE TABLE NN (ID INTEGER, REQUIRED VARCHAR(5) NOT NULL, OPTIONAL VARCHAR(5) NULL, WITHDEFAULT VARCHAR(5) DEFAULT 'x' NOT NULL)");
  assert.equal((await failure(c, "INSERT INTO NN (ID) VALUES (1)")).sqlState, "23502", "REQUIRED 가 NULL");
  await exec(c, "INSERT INTO NN (ID, REQUIRED) VALUES (1, 'r')");
  assert.deepEqual(await query(c, "SELECT OPTIONAL, WITHDEFAULT FROM NN"), [[null, "x"]], "NULL 허용 컬럼과 DEFAULT");
  assert.equal((await failure(c, "UPDATE NN SET REQUIRED = NULL")).sqlState, "23502");
  assert.equal((await failure(c, "ALTER TABLE NN ALTER COLUMN OPTIONAL SET NOT NULL")).sqlState, "23502", "NULL 이 이미 있으면 NOT NULL 로 바꿀 수 없다");
  await exec(c, "UPDATE NN SET OPTIONAL = 'o'");
  await exec(c, "ALTER TABLE NN ALTER COLUMN OPTIONAL SET NOT NULL");
  assert.equal((await failure(c, "INSERT INTO NN (ID, REQUIRED) VALUES (2, 'r')")).sqlState, "23502");
  await exec(c, "ALTER TABLE NN ALTER COLUMN OPTIONAL DROP NOT NULL");
  await exec(c, "INSERT INTO NN (ID, REQUIRED) VALUES (2, 'r')");
  // 행이 있는 테이블에 값 없는 NOT NULL 컬럼은 추가할 수 없다.
  assert.equal((await failure(c, "ALTER TABLE NN ADD COLUMN EXTRA INTEGER NOT NULL")).sqlState, "23502");
  await exec(c, "ALTER TABLE NN ADD COLUMN EXTRA INTEGER DEFAULT 7 NOT NULL");
  assert.deepEqual(await query(c, "SELECT DISTINCT EXTRA FROM NN"), [[7]]);
});

test("개요 11 : FOREIGN KEY — 같은 테이블스페이스의 PK 를 참조하고 NO ACTION, RESTRICT, CASCADE, SET NULL 참조동작을 지원한다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("tcp");
  await execAll(c, [
    "CREATE TABLE PARENT (ID INTEGER PRIMARY KEY, N VARCHAR(5))",
    "CREATE TABLE C_NOACTION (ID INTEGER PRIMARY KEY, PID INTEGER REFERENCES PARENT)",
    "CREATE TABLE C_RESTRICT (ID INTEGER PRIMARY KEY, PID INTEGER REFERENCES PARENT (ID) ON DELETE RESTRICT ON UPDATE RESTRICT)",
    "CREATE TABLE C_CASCADE (ID INTEGER PRIMARY KEY, PID INTEGER, CONSTRAINT FK_CASCADE FOREIGN KEY (PID) REFERENCES PARENT (ID) ON DELETE CASCADE ON UPDATE CASCADE)",
    "CREATE TABLE C_SETNULL (ID INTEGER PRIMARY KEY, PID INTEGER REFERENCES PARENT ON DELETE SET NULL ON UPDATE SET NULL)",
    "INSERT INTO PARENT VALUES (1, 'a')",
    "INSERT INTO PARENT VALUES (2, 'b')",
    "INSERT INTO PARENT VALUES (3, 'c')",
  ]);
  // 부모가 없으면 자식을 넣을 수 없다. NULL 이면 검사하지 않는다.
  assert.equal((await failure(c, "INSERT INTO C_NOACTION VALUES (1, 99)")).sqlState, "23503");
  await exec(c, "INSERT INTO C_NOACTION VALUES (1, NULL)");
  assert.equal((await failure(c, "UPDATE C_NOACTION SET PID = 99")).sqlState, "23503");
  for (const table of ["C_NOACTION", "C_RESTRICT", "C_CASCADE", "C_SETNULL"]) {
    await exec(c, `DELETE FROM ${table}`);
    await exec(c, `INSERT INTO ${table} VALUES (1, 1)`);
    await exec(c, `INSERT INTO ${table} VALUES (2, 2)`);
  }
  // NO ACTION(기본)과 RESTRICT : 자식이 있는 부모는 지우거나 키를 바꿀 수 없다
  await execAll(c, ["DELETE FROM C_CASCADE", "DELETE FROM C_SETNULL"]);
  assert.equal((await failure(c, "DELETE FROM PARENT WHERE ID = 1")).sqlState, "23503");
  assert.equal((await failure(c, "UPDATE PARENT SET ID = 10 WHERE ID = 1")).sqlState, "23503");
  await exec(c, "DELETE FROM C_NOACTION");
  assert.equal((await failure(c, "DELETE FROM PARENT WHERE ID = 2")).sqlState, "23503", "RESTRICT 가 남아 있다");
  await exec(c, "DELETE FROM C_RESTRICT");
  // CASCADE : 부모를 지우면 자식도 지우고, 부모 키를 바꾸면 자식 키도 따라간다
  await execAll(c, ["INSERT INTO C_CASCADE VALUES (1, 1)", "INSERT INTO C_CASCADE VALUES (2, 2)", "INSERT INTO C_CASCADE VALUES (3, 2)"]);
  await exec(c, "DELETE FROM PARENT WHERE ID = 1");
  assert.deepEqual(await query(c, "SELECT ID FROM C_CASCADE ORDER BY ID"), [[2], [3]]);
  await exec(c, "UPDATE PARENT SET ID = 20 WHERE ID = 2");
  assert.deepEqual(await query(c, "SELECT ID, PID FROM C_CASCADE ORDER BY ID"), [[2, 20], [3, 20]]);
  // SET NULL : 부모를 지우거나 키를 바꾸면 자식의 FK 컬럼이 NULL 이 된다
  await execAll(c, ["INSERT INTO C_SETNULL VALUES (1, 3)", "INSERT INTO C_SETNULL VALUES (2, 20)"]);
  await exec(c, "DELETE FROM PARENT WHERE ID = 3");
  assert.deepEqual(await query(c, "SELECT ID, PID FROM C_SETNULL ORDER BY ID"), [[1, null], [2, 20]]);
  await execAll(c, ["INSERT INTO PARENT VALUES (4, 'd')", "INSERT INTO PARENT VALUES (5, 'e')"]);
  // SET DEFAULT 와 지연 검사(DEFERRABLE)는 지원하지 않는다.
  assert.equal((await failure(c, "CREATE TABLE X1 (ID INTEGER, PID INTEGER REFERENCES PARENT ON DELETE SET DEFAULT)")).sqlState, "0A000");
  assert.equal((await failure(c, "CREATE TABLE X2 (ID INTEGER, PID INTEGER REFERENCES PARENT DEFERRABLE)")).sqlState, "0A000");
  // 이름 : FK_테이블명_순번 자동 부여, 지정하면 그 이름
  const names = await query(c, "SELECT TABLE_NAME, CONSTRAINT_NAME FROM SYS_CONSTRAINTS WHERE CONSTRAINT_TYPE = 'FOREIGN KEY' ORDER BY 1");
  assert.equal(names.length, 4);
  assert.ok(names.every((row) => row[0] === "C_CASCADE" ? row[1] === "FK_CASCADE" : /^FK_C_[A-Z]+_\d+$/.test(String(row[1]))), JSON.stringify(names));
  assert.deepEqual(await query(c, "SELECT COLUMN_NAME, REFERENCED_COLUMN FROM SYS_CONSTRAINT_COLUMNS WHERE CONSTRAINT_NAME = 'FK_CASCADE'"), [["PID", "ID"]]);
});

test("개요 11 : FOREIGN KEY — 복합 키, 자기 참조, REFERENCES 의 컬럼 목록 생략(대상의 PK), 컬럼 수와 타입이 PK 와 맞아야 한다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("tcp");
  await execAll(c, [
    "CREATE TABLE P2 (A INTEGER, B VARCHAR(3), N INTEGER, PRIMARY KEY (A, B))",
    "CREATE TABLE C2 (ID INTEGER PRIMARY KEY, X INTEGER, Y VARCHAR(3), FOREIGN KEY (X, Y) REFERENCES P2)",
    "INSERT INTO P2 VALUES (1, 'a', 0)",
    "INSERT INTO P2 VALUES (1, 'b', 0)",
  ]);
  await exec(c, "INSERT INTO C2 VALUES (1, 1, 'a')");
  assert.equal((await failure(c, "INSERT INTO C2 VALUES (2, 1, 'z')")).sqlState, "23503", "복합 키는 조합이 부모에 있어야 한다");
  await exec(c, "INSERT INTO C2 VALUES (3, 1, NULL)"); // 컬럼 중 하나라도 NULL 이면 검사하지 않는다
  // 자기 테이블 참조
  await exec(c, "CREATE TABLE TREE (ID INTEGER PRIMARY KEY, PARENT INTEGER REFERENCES TREE ON DELETE CASCADE)");
  await execAll(c, ["INSERT INTO TREE VALUES (1, NULL)", "INSERT INTO TREE VALUES (2, 1)", "INSERT INTO TREE VALUES (3, 2)", "INSERT INTO TREE VALUES (4, 3)", "INSERT INTO TREE VALUES (5, NULL)"]);
  assert.equal((await failure(c, "INSERT INTO TREE VALUES (6, 99)")).sqlState, "23503");
  await exec(c, "DELETE FROM TREE WHERE ID = 1");
  assert.deepEqual(await query(c, "SELECT ID FROM TREE"), [[5]], "자기 참조 연쇄 삭제");
  // 컬럼 수와 타입이 PK 와 맞아야 하고, PK 가 아닌 컬럼은 참조할 수 없다. 같은 테이블스페이스의 테이블만 참조한다.
  for (const sql of [
    "CREATE TABLE E1 (ID INTEGER, A INTEGER, FOREIGN KEY (A) REFERENCES P2)",
    "CREATE TABLE E2 (ID INTEGER, A VARCHAR(5), B VARCHAR(3), FOREIGN KEY (A, B) REFERENCES P2)",
    "CREATE TABLE E3 (ID INTEGER, N INTEGER, FOREIGN KEY (N) REFERENCES P2 (N))",
    "CREATE TABLE E4 (ID INTEGER, A INTEGER, FOREIGN KEY (A) REFERENCES NOSUCH)",
  ]) {
    assert.equal((await failure(c, sql)).sqlState.length, 5, sql);
  }
  await exec(c, "CREATE TABLESPACE OTHER");
  assert.equal((await failure(c, "CREATE TABLE OTHER.E5 (ID INTEGER, A INTEGER, B VARCHAR(3), FOREIGN KEY (A, B) REFERENCES SYSTEM.P2)")).sqlState, "42P16");
  // 기존 데이터가 어기면 FK 를 추가할 수 없다. 추가하고 나면 지킨다. 제약조건은 지울 수 있다.
  await execAll(c, ["CREATE TABLE LOOSE (ID INTEGER, TID INTEGER)", "INSERT INTO LOOSE VALUES (1, 5)", "INSERT INTO LOOSE VALUES (2, 77)"]);
  assert.equal((await failure(c, "ALTER TABLE LOOSE ADD CONSTRAINT FK_LOOSE FOREIGN KEY (TID) REFERENCES TREE")).sqlState, "23503");
  await exec(c, "DELETE FROM LOOSE WHERE ID = 2");
  await exec(c, "ALTER TABLE LOOSE ADD CONSTRAINT FK_LOOSE FOREIGN KEY (TID) REFERENCES TREE");
  assert.equal((await failure(c, "INSERT INTO LOOSE VALUES (3, 77)")).sqlState, "23503");
  await exec(c, "ALTER TABLE LOOSE DROP CONSTRAINT FK_LOOSE");
  await exec(c, "INSERT INTO LOOSE VALUES (3, 77)");
});

test("개요 11 : UNIQUE, CHECK 제약조건은 지원하지 않고 오류를 준다. DEFAULT 는 제약조건이 아닌 컬럼 속성이다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("tcp");
  for (const sql of [
    "CREATE TABLE U1 (A INTEGER UNIQUE)",
    "CREATE TABLE U2 (A INTEGER, CONSTRAINT UQ UNIQUE (A))",
    "CREATE TABLE U3 (A INTEGER CHECK (A > 0))",
    "CREATE TABLE U4 (A INTEGER, CONSTRAINT CK CHECK (A > 0))",
  ]) {
    assert.equal((await failure(c, sql)).sqlState, "0A000", sql);
  }
  await exec(c, "CREATE TABLE OK1 (A INTEGER DEFAULT 5, B VARCHAR(5) DEFAULT 'x', C TIMESTAMP DEFAULT CURRENT_TIMESTAMP)");
  assert.equal((await failure(c, "ALTER TABLE OK1 ADD CONSTRAINT UQ2 UNIQUE (A)")).sqlState, "0A000");
  assert.equal((await failure(c, "ALTER TABLE OK1 ADD CONSTRAINT CK2 CHECK (A > 0)")).sqlState, "0A000");
  // 중복도 범위도 막지 않는다 (제약조건이 없으므로)
  await exec(c, "INSERT INTO OK1 VALUES (-1, 'a', NULL)");
  await exec(c, "INSERT INTO OK1 VALUES (-1, 'a', NULL)");
  await exec(c, "INSERT INTO OK1 (B) VALUES ('d')");
  await exec(c, "INSERT INTO OK1 DEFAULT VALUES");
  assert.deepEqual(await query(c, "SELECT A, B, C IS NOT NULL FROM OK1 ORDER BY B, A"), [[-1, "a", false], [-1, "a", false], [5, "d", true], [5, "x", true]]);
  // DEFAULT 는 제약조건 목록에 나오지 않는다. 제약조건은 PK, FK 뿐이다 (NOT NULL 은 컬럼 속성이다).
  assert.deepEqual(await query(c, "SELECT DISTINCT CONSTRAINT_TYPE FROM SYS_CONSTRAINTS"), []);
  await execAll(c, ["CREATE TABLE K1 (A INTEGER PRIMARY KEY, B INTEGER NOT NULL)", "CREATE TABLE K2 (A INTEGER REFERENCES K1)"]);
  assert.deepEqual(await query(c, "SELECT DISTINCT CONSTRAINT_TYPE FROM SYS_CONSTRAINTS ORDER BY 1"), [["FOREIGN KEY"], ["PRIMARY KEY"]]);
  // 테이블을 지우면 제약조건도 사라지고, 참조되는 테이블은 RESTRICT 기본이라 지울 수 없다. CASCADE 는 참조하는 FK 도 지운다.
  assert.equal((await failure(c, "DROP TABLE K1")).sqlState, "55006");
  await exec(c, "DROP TABLE K1 CASCADE");
  assert.deepEqual(await query(c, "SELECT DISTINCT CONSTRAINT_TYPE FROM SYS_CONSTRAINTS"), []);
  void DbError;
});
