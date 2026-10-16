/**
 * 담당 : 데이터 디렉토리 단위의 호환성 자료 생성. 일반 테스트에서 호출하지 않는다.
 * 관련 사양 : AGENTS.md 상세 3 (버전 관리 : 이전 버전으로 만든 데이터 파일을 테스트 자료로 보관).
 * 구현 단계 : 11단계.
 *
 * 사용 : npm run build 후 `node test/fixtures/create-datadir.mjs <버전>` (예 : `node test/fixtures/create-datadir.mjs 1`)
 *   - 지금 구현이 만드는 포맷으로 `test/fixtures/datadir-v<버전>/` 을 만든다. 이미 있으면 덮어쓰지 않고 멈춘다.
 *   - 새 포맷 버전을 도입하기 전에, 지금(이전) 버전의 자료를 이 스크립트로 먼저 만들어 보관한다.
 *     (스크립트의 내용은 test/integration/dataDirCompat.test.ts 가 기대하는 값과 짝이다. 둘을 함께 고친다)
 *   - 파일마다 SHA-256 을 출력한다. test/fixtures/README.md 에 적어 둔다.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const version = process.argv[2];
if (version === undefined || !/^[1-9]\d*$/.test(version)) {
  console.error("Usage: node test/fixtures/create-datadir.mjs <format version>");
  process.exit(2);
}
const target = fileURLToPath(new URL(`./datadir-v${version}/`, import.meta.url));
if (fs.existsSync(target)) {
  console.error(`${target} already exists; it is never overwritten.`);
  process.exit(1);
}
const dist = fileURLToPath(new URL("../../dist/src/", import.meta.url));
const { Database } = await import(pathToFileURL(path.join(dist, "session/session.js")).href);
const { LATEST_FORMAT_VERSION } = await import(pathToFileURL(path.join(dist, "storage/format/format.js")).href);
if (Number(version) !== LATEST_FORMAT_VERSION) {
  console.error(`This build writes format version ${LATEST_FORMAT_VERSION}, not ${version}. Run it with the build that writes version ${version}.`);
  process.exit(1);
}

fs.mkdirSync(target, { recursive: true });
const db = Database.open(target, { serverVersion: "0.1.0", onWarning: (message) => console.error(`warning: ${message}`) });
try {
  const session = db.createSession({ user: "SYSTEM" });
  const run = (sql, params = []) => session.execute(sql, params);

  run("CREATE TABLESPACE APP");
  run("CREATE USER ALICE IDENTIFIED BY 'alice-pw' DEFAULT TABLESPACE APP");
  run("GRANT CONNECT TO ALICE");
  run("CREATE TABLE APP.DEPT (ID INTEGER PRIMARY KEY, NAME VARCHAR(30) NOT NULL)");
  run("CREATE TABLE APP.EMP (ID INTEGER PRIMARY KEY, NAME VARCHAR(30) NOT NULL, DEPT_ID INTEGER REFERENCES DEPT (ID) ON DELETE SET NULL, " +
    "SALARY DECIMAL(10,2), HIRED DATE, NOTE VARCHAR(2000))");
  run("CREATE INDEX APP.IX_EMP_NAME ON APP.EMP (NAME)");
  run("CREATE INDEX APP.IX_EMP_DEPT_SAL ON APP.EMP (DEPT_ID, SALARY DESC)");
  run("CREATE VIEW APP.EMP_V AS SELECT E.ID, E.NAME, D.NAME AS DEPT FROM APP.EMP E LEFT JOIN APP.DEPT D ON E.DEPT_ID = D.ID");
  run("CREATE TABLE APP.BIG (ID INTEGER PRIMARY KEY, DATA VARBINARY(30000))");
  run("CREATE TABLE APP.TYPES (C CHAR(5), V NVARCHAR(10), SI SMALLINT, BI BIGINT, N DECIMAL(12,4), R REAL, D DOUBLE PRECISION, B BOOLEAN, " +
    "DT DATE, T TIME(3), TS TIMESTAMP(6), TSZ TIMESTAMP(3) WITH TIME ZONE, IV INTERVAL YEAR TO MONTH, IV2 INTERVAL DAY TO SECOND, BN BINARY(4), VB VARBINARY(10))");

  run("INSERT INTO APP.DEPT VALUES (1, 'Sales'), (2, 'Engineering'), (3, 'Support')");
  // EMP : id 1..300. 부서는 1 + id % 3, 급여는 1000 + id * 1.25, 입사일은 2020-01-01 + id 일, 비고는 길이가 다른 문자열
  for (let from = 1; from <= 300; from += 100) {
    const values = [];
    for (let id = from; id < from + 100; id++) {
      const hired = new Date(Date.UTC(2020, 0, 1) + id * 86400000).toISOString().slice(0, 10);
      values.push(`(${id}, 'EMP${id}', ${1 + (id % 3)}, ${(1000 + id * 1.25).toFixed(2)}, DATE '${hired}', '${"note-".concat("x".repeat((id % 50) * 30))}')`);
    }
    run(`INSERT INTO APP.EMP VALUES ${values.join(", ")}`);
  }
  // 오버플로 행 : 한 페이지(8KB)를 넘는 이진 값
  run("INSERT INTO APP.BIG VALUES (1, ?)", [Buffer.alloc(20000, 0xab)]);
  run("INSERT INTO APP.BIG VALUES (2, ?)", [Buffer.alloc(100, 0x01)]);
  run("INSERT INTO APP.TYPES VALUES ('ab', '한글😀', -32768, 9223372036854775807, 12345678.1235, 1.5, 2.25, TRUE, DATE '2026-10-16', TIME '12:34:56.789', " +
    "TIMESTAMP '2026-10-16 12:34:56.123456', TIMESTAMP '2026-10-16 12:34:56.123+09:00', INTERVAL '1-2' YEAR TO MONTH, INTERVAL '3 04:05:06' DAY TO SECOND, X'0A0B0C0D', X'00FF')");
  run("INSERT INTO APP.TYPES (C) VALUES (NULL)");

  // 삭제와 갱신으로 빈 자리와 갱신된 인덱스 항목을 남긴다.
  run("DELETE FROM APP.EMP WHERE ID BETWEEN 101 AND 110");
  run("UPDATE APP.EMP SET SALARY = SALARY + 1 WHERE ID <= 5");

  run("GRANT SELECT ON VIEW APP.EMP_V TO ALICE");
  run("GRANT SELECT, INSERT ON TABLE APP.DEPT TO ALICE");
} finally {
  db.close();
}

for (const name of fs.readdirSync(target).sort()) {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(target, name))).digest("hex");
  console.log(`${name}  ${fs.statSync(path.join(target, name)).size} bytes  sha256 ${hash}`);
}
