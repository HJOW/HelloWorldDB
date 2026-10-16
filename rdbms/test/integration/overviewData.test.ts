/**
 * 개요 1, 2, 13 의 시나리오 시험 (11단계). 실제 `hwdb start` 로 띄운 데몬에 네트워크로 접속해 확인한다.
 *  - 개요 1 : ANSI 데이터 타입 전부(CLOB·BLOB 제외), VARCHAR 의 최대 길이, DECIMAL·NUMERIC 의 생략 규칙, 테이블·뷰 DDL 과 CRUD, NVL·TO_CHAR·TO_DATE
 *  - 개요 2 : 캐릭터셋은 UTF-8 뿐. 저장·통신·SQL 이 모두 UTF-8 이고 올바르지 않은 UTF-8 은 오류, 데이터 파일 헤더에 캐릭터셋이 적힌다
 *  - 개요 13 : 문법의 생략 원칙. Hello World 샘플이 아무 설정 없이 그대로 실행되고, 생략할 수 있는 것을 생략해도 뜻이 같다
 * 각 항목의 세부는 단위 시험(`test/types`, `test/sql`, `test/exec`)이 이미 깊게 본다. 여기서는 사양 문장이 실제 데몬에서 끝까지 되는지를 본다.
 * 관련 사양 : AGENTS.md 개요 1, 2, 13, 상세 0, 1, 2, 13
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import type { Connection } from "../../src/client/connection.js";
import { Daemon, exec, execAll, failure, num, query, scalar } from "./helpers.js";

/** 조회 결과의 컬럼 선언 표기(`DECIMAL(10,3)` 등)와 타입 이름이다. */
async function describeColumns(connection: Connection, sql: string): Promise<Array<{ name: string; declared: string; typeName: string }>> {
  const outcome = await connection.execute(sql);
  if (outcome.kind !== "rows") throw new Error("Not a query.");
  if (outcome.cursor !== null) await connection.closeCursor(outcome.cursor);
  return outcome.columns.map((column) => ({ name: column.name, declared: column.declared, typeName: column.typeName }));
}

test("개요 1 : ANSI 데이터 타입 전부를 만들고 넣고 읽는다 (CLOB, BLOB 제외)", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("tcp");
  await exec(
    c,
    `CREATE TABLE ALL_TYPES (
       C_CHAR CHAR(5), C_NCHAR NCHAR(3), C_VARCHAR VARCHAR(100), C_NVARCHAR NVARCHAR(10),
       C_BINARY BINARY(4), C_VARBINARY VARBINARY(10),
       C_SMALLINT SMALLINT, C_INT INTEGER, C_BIGINT BIGINT,
       C_NUM NUMERIC(10,3), C_DEC DECIMAL(12,2),
       C_REAL REAL, C_DOUBLE DOUBLE PRECISION, C_FLOAT FLOAT(10),
       C_BOOL BOOLEAN, C_DATE DATE, C_TIME TIME(3), C_TIMETZ TIME(0) WITH TIME ZONE,
       C_TS TIMESTAMP(6), C_TSTZ TIMESTAMP(3) WITH TIME ZONE,
       C_IYM INTERVAL YEAR TO MONTH, C_IDS INTERVAL DAY TO SECOND)`,
  );
  // 리터럴로 넣는다.
  await exec(
    c,
    `INSERT INTO ALL_TYPES VALUES ('ab', '한', 'Hello', '😀', X'0A0B0C0D', X'FF', 32767, 2147483647, 9223372036854775807,
       1234567.891, 1.5, 1.5, 2.25, 3.5, TRUE, DATE '2026-10-15', TIME '13:05:07.25', TIME WITH TIME ZONE '13:05:07+09:00',
       TIMESTAMP '2026-10-15 13:05:07.123456', TIMESTAMP WITH TIME ZONE '2026-10-15 13:05:07.25+09:00',
       INTERVAL '1-2' YEAR TO MONTH, INTERVAL '3 04:05:06.5' DAY TO SECOND)`,
  );
  // 파라미터로 넣는다. (BIGINT·NUMERIC·날짜시간은 문자열로 보내는 것이 정확하다)
  await exec(c, "INSERT INTO ALL_TYPES (C_BIGINT, C_NUM, C_BINARY, C_DATE, C_TS, C_BOOL) VALUES (?, ?, ?, ?, ?, ?)", [
    "-9223372036854775808",
    "-0.001",
    Buffer.from([1, 2, 3, 4]),
    "0001-01-01",
    "9999-12-31 23:59:59.999999",
    false,
  ]);

  const outcome = await c.execute("SELECT * FROM ALL_TYPES ORDER BY C_BIGINT DESC");
  assert.equal(outcome.kind, "rows");
  if (outcome.kind !== "rows") return;
  assert.deepEqual(
    outcome.columns.map((column) => column.declared),
    [
      "CHAR(5)", "CHAR(3)", "VARCHAR(100)", "VARCHAR(10)", "BINARY(4)", "VARBINARY(10)", "SMALLINT", "INTEGER", "BIGINT",
      "DECIMAL(10,3)", "DECIMAL(12,2)", "REAL", "DOUBLE PRECISION", "REAL", "BOOLEAN", "DATE", "TIME(3)", "TIME(0) WITH TIME ZONE",
      "TIMESTAMP(6)", "TIMESTAMP(3) WITH TIME ZONE", "INTERVAL YEAR(2) TO MONTH", "INTERVAL DAY(2) TO SECOND(6)",
    ],
    "NCHAR·NVARCHAR 는 CHAR·VARCHAR 와 같고 FLOAT(10) 은 REAL 이다",
  );
  assert.deepEqual(outcome.rows[0], [
    "ab   ", "한  ", "Hello", "😀", "0A0B0C0D", "FF", 32767, 2147483647, "9223372036854775807",
    "1234567.891", "1.50", 1.5, 2.25, 3.5, true, "2026-10-15", "13:05:07.250", "13:05:07+09:00",
    "2026-10-15 13:05:07.123456", "2026-10-15 13:05:07.250+09:00", "1-02", "3 04:05:06.500000",
  ]);
  // 파라미터로 넣은 경계값은 그대로 돌아온다.
  const second = outcome.rows[1] as unknown[];
  assert.equal(second[8], "-9223372036854775808");
  assert.equal(second[9], "-0.001");
  assert.equal(second[4], "01020304");
  assert.equal(second[15], "0001-01-01");
  assert.equal(second[18], "9999-12-31 23:59:59.999999");
  assert.equal(second[14], false);
  assert.equal(second[0], null, "넣지 않은 컬럼은 NULL");

  // 범위를 넘는 값은 잘라내지 않고 오류이다.
  assert.equal((await failure(c, "INSERT INTO ALL_TYPES (C_SMALLINT) VALUES (32768)")).sqlState, "22003");
  assert.equal((await failure(c, "INSERT INTO ALL_TYPES (C_INT) VALUES (2147483648)")).sqlState, "22003");
  assert.equal((await failure(c, "INSERT INTO ALL_TYPES (C_BIGINT) VALUES (9223372036854775808)")).sqlState, "22003");
  assert.equal((await failure(c, "INSERT INTO ALL_TYPES (C_NUM) VALUES (12345678.1)")).sqlState, "22003");
  assert.equal((await failure(c, "INSERT INTO ALL_TYPES (C_CHAR) VALUES ('abcdef')")).sqlState, "22001");
  // 같은 계열 안에서만 암묵적 형변환을 하고, 다른 계열은 CAST 가 필요하다.
  assert.equal((await failure(c, "SELECT TRUE + 1")).sqlState, "42804", "다른 계열끼리는 CAST 없이 연산할 수 없다");
  assert.equal(await scalar(c, "SELECT CAST('42' AS INTEGER)"), 42);
});

test("개요 1 : CLOB, BLOB 는 초기 버전에서 지원하지 않고 0A000 이다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("tcp");
  for (const type of ["CLOB", "BLOB", "NCLOB"]) {
    assert.equal((await failure(c, `CREATE TABLE LOB (A ${type})`)).sqlState, "0A000", type);
  }
});

test("개요 1 : VARCHAR·NVARCHAR 의 최대 길이는 65535 이고 길이를 생략하면 65535 이다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("local");
  await exec(c, "CREATE TABLE BIGV (A VARCHAR(65535), B NVARCHAR(65535), C VARCHAR, D NVARCHAR)");
  assert.deepEqual(
    (await describeColumns(c, "SELECT * FROM BIGV")).map((column) => column.declared),
    ["VARCHAR(65535)", "VARCHAR(65535)", "VARCHAR(65535)", "VARCHAR(65535)"],
  );
  assert.equal((await failure(c, "CREATE TABLE BIGV2 (A VARCHAR(65536))")).sqlState, "22023");
  assert.equal((await failure(c, "CREATE TABLE BIGV3 (A NVARCHAR(65536))")).sqlState, "22023");
  await exec(c, "INSERT INTO BIGV (A) VALUES (?)", ["x".repeat(65535)]);
  assert.equal(await num(c, "SELECT LENGTH(A) FROM BIGV"), 65535);
  assert.equal((await failure(c, "INSERT INTO BIGV (A) VALUES (?)", ["x".repeat(65536)])).sqlState, "22001");
});

test("개요 1 : DECIMAL·NUMERIC 는 인자를 모두 생략하면 (10,3), 자리수만 주면 소수 자리가 0 이고 둘은 같게 처리된다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("udp");
  await exec(c, "CREATE TABLE DECS (A DECIMAL, B NUMERIC, C DEC, D DECIMAL(5), E NUMERIC(7), F DECIMAL(6,2), G NUMERIC(38,10))");
  const columns = await describeColumns(c, "SELECT * FROM DECS");
  assert.deepEqual(
    columns.map((column) => column.declared),
    ["DECIMAL(10,3)", "DECIMAL(10,3)", "DECIMAL(10,3)", "DECIMAL(5,0)", "DECIMAL(7,0)", "DECIMAL(6,2)", "DECIMAL(38,10)"],
  );
  assert.ok(columns.every((column) => column.typeName === "DECIMAL"), "NUMERIC 과 DEC 는 DECIMAL 로 처리된다");
  await exec(c, "INSERT INTO DECS VALUES (1.2345, 1.2345, 1.2345, 12345.6, 1234567.5, 1234.567, 1234567890123456789012345678.1234567891)");
  // 소수부만 지정한 자릿수로 반올림한다. 정수부가 넘치면 오류이다.
  assert.deepEqual(await query(c, "SELECT * FROM DECS"), [
    ["1.235", "1.235", "1.235", "12346", "1234568", "1234.57", "1234567890123456789012345678.1234567891"],
  ]);
  assert.equal((await failure(c, "INSERT INTO DECS (D) VALUES (123456)")).sqlState, "22003");
});

test("개요 1 : 테이블과 뷰의 DDL, CRUD 기본 문법과 Oracle 호환 함수 NVL, TO_CHAR, TO_DATE", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("tcp");
  await execAll(c, [
    "CREATE TABLE EMP (ID INTEGER PRIMARY KEY, NAME VARCHAR(20) NOT NULL, DEPT VARCHAR(10), SALARY NUMERIC(10,2), HIRED DATE)",
    "INSERT INTO EMP VALUES (1, 'Kim', 'DEV', 5000.50, DATE '2020-03-01')",
    "INSERT INTO EMP VALUES (2, 'Lee', 'DEV', 4500, DATE '2021-07-15')",
    "INSERT INTO EMP VALUES (3, 'Park', NULL, NULL, DATE '2019-01-31')",
    "INSERT INTO EMP (ID, NAME) VALUES (4, 'Choi')",
    "CREATE VIEW DEV_EMP (EMP_ID, EMP_NAME, PAY) AS SELECT ID, NAME, SALARY FROM EMP WHERE DEPT = 'DEV'",
  ]);
  assert.deepEqual(await query(c, "SELECT EMP_ID, EMP_NAME, PAY FROM DEV_EMP ORDER BY EMP_ID"), [[1, "Kim", "5000.50"], [2, "Lee", "4500.00"]]);
  // 갱신 가능한 뷰의 UPDATE·INSERT·DELETE 는 기반 테이블에 반영된다.
  await exec(c, "UPDATE DEV_EMP SET PAY = 6000 WHERE EMP_ID = 2");
  await exec(c, "DELETE FROM DEV_EMP WHERE EMP_ID = 1");
  assert.deepEqual(await query(c, "SELECT ID, SALARY FROM EMP WHERE DEPT = 'DEV'"), [[2, "6000.00"]]);
  // 조인, 그룹, 서브쿼리, 집합 연산
  assert.deepEqual(await query(c, "SELECT DEPT, COUNT(*) FROM EMP GROUP BY DEPT ORDER BY DEPT"), [["DEV", "1"], [null, "2"]]);
  assert.deepEqual(
    await query(c, "SELECT NAME FROM EMP WHERE SALARY > (SELECT AVG(SALARY) FROM EMP WHERE SALARY IS NOT NULL) OR NAME = 'Choi' ORDER BY 1"),
    [["Choi"]],
  );
  assert.deepEqual(await query(c, "SELECT ID FROM EMP WHERE ID < 3 UNION SELECT ID FROM EMP WHERE ID > 3 ORDER BY 1"), [[2], [4]]);
  // NVL, TO_CHAR, TO_DATE
  assert.deepEqual(await query(c, "SELECT NAME, NVL(DEPT, 'NONE'), NVL(SALARY, 0) FROM EMP ORDER BY ID"), [
    ["Lee", "DEV", "6000.00"],
    ["Park", "NONE", "0.00"],
    ["Choi", "NONE", "0.00"],
  ]);
  assert.deepEqual(await query(c, "SELECT TO_CHAR(HIRED, 'YYYY/MM/DD'), TO_CHAR(HIRED), TO_CHAR(SALARY, '9,999.99') FROM EMP WHERE ID = 2"), [
    ["2021/07/15", "2021-07-15", " 6,000.00"],
  ]);
  assert.deepEqual(await query(c, "SELECT TO_DATE('2026-10-15 13:05:07', 'YYYY-MM-DD HH24:MI:SS'), TO_DATE('2026-10-15') FROM DUAL"), [
    ["2026-10-15 13:05:07", "2026-10-15 00:00:00"],
  ]);
  // ALTER, DROP
  await exec(c, "ALTER TABLE EMP ADD COLUMN GRADE INTEGER DEFAULT 1");
  assert.equal(await num(c, "SELECT SUM(GRADE) FROM EMP"), 3);
  assert.equal((await failure(c, "DROP TABLE EMP")).sqlState, "55006", "뷰가 참조하는 테이블은 RESTRICT 가 기본이라 지울 수 없다");
  await exec(c, "DROP VIEW DEV_EMP");
  await exec(c, "DROP TABLE EMP");
  assert.equal((await failure(c, "SELECT * FROM EMP")).sqlState, "42P01");
});

test("개요 2 : 한글·일본어·이모지가 TCP, UDP, 로컬 전용 채널 모두에서 UTF-8 로 오가고 길이는 문자(코드 포인트) 단위이다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const writer = await daemon.connect("tcp");
  await exec(writer, "CREATE TABLE TXT (ID INTEGER PRIMARY KEY, V VARCHAR(12), C CHAR(3))");
  const samples = ["한글", "日本語テキスト", "😀😀😀😀😀", "Ünïcödé ÄÖÜ", "ab한😀"];
  for (const [index, sample] of samples.entries()) {
    await exec(writer, "INSERT INTO TXT (ID, V) VALUES (?, ?)", [index, sample]);
  }
  await exec(writer, "INSERT INTO TXT (ID, V) VALUES (98, ?)", ["😀".repeat(12)]);
  await exec(writer, "DELETE FROM TXT WHERE ID = 98");
  // 이모지는 UTF-16 으로는 두 단위이지만 한 문자로 센다. 12문자는 VARCHAR(12) 에 들어가고 13문자는 들어가지 않는다.
  assert.equal((await failure(writer, "INSERT INTO TXT (ID, V) VALUES (99, ?)", ["😀".repeat(13)])).sqlState, "22001");
  await exec(writer, "INSERT INTO TXT (ID, C) VALUES (50, '한😀')");
  for (const kind of ["tcp", "udp", "local"] as const) {
    const reader = await daemon.connect(kind);
    const rows = await query(reader, "SELECT V FROM TXT WHERE V IS NOT NULL ORDER BY ID");
    assert.deepEqual(rows.map((row) => row[0]), samples, kind);
    assert.deepEqual(await query(reader, "SELECT CHAR_LENGTH(V), OCTET_LENGTH(V) FROM TXT WHERE ID = 2"), [["5", "20"]], kind);
    assert.deepEqual(await query(reader, "SELECT C, CHAR_LENGTH(C) FROM TXT WHERE ID = 50"), [["한😀 ", "3"]], kind);
    // SQL 문장 안의 한글 식별자와 큰따옴표 식별자
    assert.equal(await num(reader, 'SELECT COUNT(*) FROM TXT WHERE "V" = \'한글\''), 1, kind);
  }
  await exec(writer, "CREATE TABLE 사원 (번호 INTEGER, 이름 VARCHAR(10))");
  await exec(writer, "INSERT INTO 사원 VALUES (1, '홍길동')");
  assert.deepEqual(await query(writer, "SELECT 이름 FROM 사원"), [["홍길동"]]);
});

test("개요 2 : 올바르지 않은 UTF-8 바이트열은 오류로 처리하고 접속을 닫는다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const frame = (body: Buffer): Buffer => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    return Buffer.concat([header, body]);
  };
  const exchange = (body: Buffer): Promise<{ text: string; closed: boolean }> =>
    new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: daemon.port });
      const chunks: Buffer[] = [];
      socket.on("connect", () => socket.write(frame(body)));
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("error", reject);
      socket.on("close", () => resolve({ text: Buffer.concat(chunks).subarray(4).toString("utf8"), closed: true }));
      setTimeout(() => socket.destroy(), 5000);
    });
  // JSON 의 문자열 안에 올바르지 않은 UTF-8 바이트(0xC3 0x28)를 넣는다.
  const bad = Buffer.concat([Buffer.from('{"id":1,"type":"hello","versions":[1],"client":"', "utf8"), Buffer.from([0xc3, 0x28]), Buffer.from('"}', "utf8")]);
  const result = await exchange(bad);
  assert.equal(result.closed, true);
  const response = JSON.parse(result.text) as { type: string; sqlState: string; id: number };
  assert.equal(response.type, "error");
  assert.equal(response.sqlState, "08P01", "프로토콜 위반");
  // 같은 내용의 올바른 UTF-8 은 받아들인다.
  const good = await exchange(Buffer.from('{"id":1,"type":"hello","versions":[1],"client":"한글"}\n'.trim(), "utf8"));
  assert.equal((JSON.parse(good.text) as { type: string }).type, "helloOk");
});

test("개요 2 : 테이블스페이스 데이터 파일 헤더에 캐릭터셋 UTF8 이 적히고 다른 캐릭터셋은 만들 수 없다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("local");
  await exec(c, "CREATE TABLESPACE KO CHARACTER SET UTF8");
  assert.equal((await failure(c, "CREATE TABLESPACE EUC CHARACTER SET EUC-KR")).sqlState.length, 5);
  assert.equal((await failure(c, "CREATE TABLESPACE U16 CHARACTER SET UTF16")).sqlState, "0A000");
  assert.deepEqual(await query(c, "SELECT TABLESPACE_NAME, CHARACTER_SET FROM SYS_TABLESPACES ORDER BY 1"), [["KO", "UTF8"], ["SYSTEM", "UTF8"]]);
  for (const name of ["SYSTEM", "KO"]) {
    const header = fs.readFileSync(path.join(daemon.dataDir, `${name}.hwdb`)).subarray(0, 64);
    assert.equal(header.subarray(16, 32).toString("ascii").replace(/\0+$/, ""), "UTF8", name);
  }
});

test("개요 13 : Hello World 샘플 두 가지가 다른 설정이나 문법을 덧붙이지 않고 그대로 실행된다", async (t) => {
  const daemon = await Daemon.create(t); // config.json 에는 포트만 있다 (나머지는 기본값)
  daemon.start();
  const c = await daemon.connect("tcp"); // SYSTEM, HelloWorldDB, 현재 테이블스페이스는 기본값
  // 첫째 샘플 : 한 문장
  assert.deepEqual(await query(c, "SELECT 'Hello World'"), [["Hello World"]]);
  // 둘째 샘플 : 세 문장. 문장마다 서버에 하나씩 보내며 ';' 도, 테이블스페이스 이름도 없다.
  await exec(c, "CREATE TABLE HELLO (MESSAGE VARCHAR)");
  await exec(c, "INSERT INTO HELLO VALUES ('Hello World')");
  assert.deepEqual(await query(c, "SELECT * FROM HELLO"), [["Hello World"]]);
  // 같은 샘플을 CLI 로 (`;` 로 나뉜 스크립트)
  const cli = daemon.hwdb(["-u", "SYSTEM", "-p", "HelloWorldDB", "-e", "SELECT 'Hello World'"]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /\| Hello World \|/);
  const script = daemon.hwdb(
    ["-u", "SYSTEM", "-p", "HelloWorldDB"],
    "CREATE TABLE HELLO2 (MESSAGE VARCHAR);\nINSERT INTO HELLO2 VALUES ('Hello World');\nSELECT * FROM HELLO2\n",
  );
  assert.equal(script.status, 0, script.stderr);
  assert.match(script.stdout, /\| Hello World \|/);
});

test("개요 13 : 생략할 수 있는 키워드, 절, 인자를 생략해도 뜻이 같다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("tcp");
  // 문장 끝의 ';' 와 FROM 절, 별칭 앞의 AS, INNER, OUTER, ASC
  assert.deepEqual(await query(c, "SELECT 1 + 1"), [[2]]);
  assert.deepEqual(await query(c, "SELECT 1 + 1;"), [[2]]);
  await execAll(c, ["CREATE TABLE A (ID INTEGER PRIMARY KEY, N VARCHAR(5))", "CREATE TABLE B (ID INTEGER, AID INTEGER REFERENCES A)"]);
  // INSERT 의 INTO 와 컬럼 목록, DELETE 의 FROM
  await exec(c, "INSERT A VALUES (1, 'x')");
  await exec(c, "INSERT A (ID, N) VALUES (2, 'y')");
  await exec(c, "INSERT INTO B VALUES (10, 1)");
  assert.deepEqual(await query(c, "SELECT a.N AS n1, b.ID bid FROM A a JOIN B b ON b.AID = a.ID ORDER BY a.ID ASC"), [["x", 10]]);
  assert.deepEqual(await query(c, "SELECT a.N FROM A a LEFT JOIN B b ON b.AID = a.ID ORDER BY a.ID"), [["x"], ["y"]]);
  assert.deepEqual(await query(c, "SELECT a.N FROM A a LEFT OUTER JOIN B b ON b.AID = a.ID ORDER BY a.ID"), [["x"], ["y"]]);
  assert.deepEqual(await query(c, "SELECT a.N FROM A a INNER JOIN B b ON b.AID = a.ID"), [["x"]]);
  await exec(c, "DELETE B");
  assert.equal(await num(c, "SELECT COUNT(*) FROM B"), 0);
  // ALTER TABLE 의 COLUMN, TRUNCATE 의 TABLE, COMMIT·ROLLBACK 의 WORK, ROLLBACK TO 의 SAVEPOINT
  await exec(c, "ALTER TABLE A ADD EXTRA INTEGER");
  await exec(c, "ALTER TABLE A DROP EXTRA");
  await exec(c, "BEGIN");
  await exec(c, "SAVEPOINT S1");
  await exec(c, "INSERT A VALUES (3, 'z')");
  await exec(c, "ROLLBACK TO S1");
  await exec(c, "COMMIT WORK");
  assert.equal(await num(c, "SELECT COUNT(*) FROM A"), 2);
  await exec(c, "TRUNCATE B");
  // 타입의 길이와 정밀도
  await exec(c, "CREATE TABLE TYPES (A CHAR, B VARCHAR, C VARBINARY, D BINARY, E DECIMAL, F DECIMAL(5), G TIME, H TIMESTAMP, I FLOAT)");
  assert.deepEqual(
    (await describeColumns(c, "SELECT * FROM TYPES")).map((column) => column.declared),
    ["CHAR(1)", "VARCHAR(65535)", "VARBINARY(65535)", "BINARY(1)", "DECIMAL(10,3)", "DECIMAL(5,0)", "TIME(0)", "TIMESTAMP(6)", "DOUBLE PRECISION"],
  );
  // 제약조건 이름, 인덱스 이름 자동 부여 / REFERENCES 의 컬럼 목록 생략 / FK 의 참조동작과 DROP 의 RESTRICT 기본값
  await exec(c, "CREATE INDEX ON A (N)");
  const constraints = await query(c, "SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE FROM SYS_CONSTRAINTS WHERE TABLE_NAME IN ('A', 'B') ORDER BY 1");
  assert.deepEqual(constraints.map((row) => row[0]).filter((name) => /^PK_/.test(String(name))), ["PK_A"]);
  assert.ok(constraints.some((row) => /^FK_B_\d+$/.test(String(row[0]))), "FK 이름은 FK_테이블명_순번");
  assert.ok((await query(c, "SELECT INDEX_NAME FROM SYS_INDEXES WHERE TABLE_NAME = 'A'")).some((row) => /^IX_A_\d+$/.test(String(row[0]))), "인덱스 이름은 IX_테이블명_순번");
  await exec(c, "INSERT INTO B VALUES (1, 1)");
  assert.equal((await failure(c, "DELETE FROM A WHERE ID = 1")).sqlState, "23503", "참조동작의 기본은 NO ACTION");
  assert.equal((await failure(c, "DROP TABLE A")).sqlState, "55006", "DROP 의 기본은 RESTRICT");
  // 뷰의 컬럼 목록 생략, TO_CHAR·TO_DATE 의 형식 생략, 정렬의 NULL 은 가장 큰 값
  await exec(c, "CREATE VIEW AV AS SELECT ID AS ID_A, N FROM A");
  assert.deepEqual((await describeColumns(c, "SELECT * FROM AV")).map((column) => column.name), ["ID_A", "N"]);
  await exec(c, "INSERT INTO A (ID) VALUES (4)");
  assert.deepEqual(await query(c, "SELECT ID FROM A ORDER BY N"), [[1], [2], [4]], "ASC 에서 NULL 은 마지막");
  assert.deepEqual(await query(c, "SELECT ID FROM A ORDER BY N DESC"), [[4], [2], [1]], "DESC 에서 NULL 은 처음");
  assert.deepEqual(await query(c, "SELECT ID FROM A ORDER BY N NULLS FIRST"), [[4], [1], [2]]);
  // 테이블스페이스, 사용자
  await exec(c, "CREATE TABLESPACE EXTRA");
  await exec(c, "CREATE USER EXTRA_USER IDENTIFIED BY 'pw'");
  assert.deepEqual(
    await query(c, "SELECT DATAFILE LIKE '%EXTRA.hwdb', CHARACTER_SET FROM SYS_TABLESPACES WHERE TABLESPACE_NAME = 'EXTRA'"),
    [[true, "UTF8"]],
    "DATAFILE 을 생략하면 <dataDir>/<이름>.hwdb, CHARACTER SET 을 생략하면 UTF8",
  );
  assert.deepEqual(await query(c, "SELECT DEFAULT_TABLESPACE FROM SYS_USERS WHERE USER_NAME = 'EXTRA_USER'"), [[null]]);
  // 이름 앞의 테이블스페이스를 생략하면 현재 테이블스페이스(SYSTEM)
  assert.equal(await num(c, "SELECT COUNT(*) FROM SYSTEM.A"), await num(c, "SELECT COUNT(*) FROM A"));
});

test("개요 13 : 생략할 수 없도록 일부러 막아 둔 것 : INCLUDING CONTENTS, CASCADE", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const c = await daemon.connect("tcp");
  await execAll(c, ["CREATE TABLESPACE KEEP", "CREATE TABLE KEEP.T (A INTEGER)", "CREATE USER OWNER1 IDENTIFIED BY 'pw'", "GRANT ALL ON TABLESPACE KEEP TO OWNER1"]);
  assert.equal((await failure(c, "DROP TABLESPACE KEEP")).sqlState, "55006", "객체가 남은 테이블스페이스는 INCLUDING CONTENTS 가 필요하다");
  assert.ok(fs.existsSync(path.join(daemon.dataDir, "KEEP.hwdb")));
  const owner = await daemon.connect("tcp", { user: "OWNER1", password: "pw" });
  await exec(owner, "CREATE TABLE KEEP.OWNED (A INTEGER)");
  await owner.close();
  assert.equal((await failure(c, "DROP USER OWNER1")).sqlState, "55006", "소유한 객체가 있으면 CASCADE 가 필요하다");
  await exec(c, "DROP USER OWNER1 CASCADE");
  await exec(c, "DROP TABLESPACE KEEP INCLUDING CONTENTS");
  assert.equal(fs.existsSync(path.join(daemon.dataDir, "KEEP.hwdb")), false, "데이터 파일도 함께 지운다");
});
