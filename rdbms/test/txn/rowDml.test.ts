/**
 * DML 행 단위 접근 2부 시험.
 * 전체 테이블 이미지 없이 제약·참조동작·커밋을 수행하고 문장 실패를 되돌리는지 확인한다.
 * 관련 사양 : AGENTS.md 상세 10, 11.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { V1Heap } from "../../src/storage/format/v1/heap.js";
import { selectStrings, setupApp, state, tempDir, openTestDb } from "../exec/helpers.js";
import type { Session } from "../../src/session/session.js";

const rows = (session: Session, sql: string): string[][] => selectStrings(session.execute(sql)).rows;

/** 측정 구간의 힙 순회 횟수와 실제 읽은 행 수를 센다. Bun에서도 같은 계측을 쓴다. */
function measure<T>(work: () => T): { result: T; scans: Map<number, number>; visited: Map<number, number> } {
  const original = V1Heap.prototype.iterate;
  const scans = new Map<number, number>();
  const visited = new Map<number, number>();
  V1Heap.prototype.iterate = function* (this: V1Heap) {
    scans.set(this.root, (scans.get(this.root) ?? 0) + 1);
    for (const row of original.call(this)) {
      visited.set(this.root, (visited.get(this.root) ?? 0) + 1);
      yield row;
    }
  };
  try { return { result: work(), scans, visited }; }
  finally { V1Heap.prototype.iterate = original; }
}

// 대량 데이터 준비도 시험 시간에 포함된다. Bun의 준비 시간을 고려해 이 시험만 6분을 허용한다.
test("2만 행 테이블의 PK 단건 DML과 명시적 커밋은 힙을 순회하지 않는다", { timeout: 360000 }, (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE T (ID INTEGER PRIMARY KEY, V INTEGER NOT NULL)");
    session.execute("CREATE INDEX IX_V ON T (V DESC)");
    for (let start = 1; start <= 20000; start += 1000) {
      session.execute(`INSERT INTO T VALUES ${Array.from({ length: 1000 }, (_, index) => `(${start + index}, ${start + index})`).join(",")}`);
    }
    const measured = measure(() => {
      session.execute("INSERT INTO T VALUES (20001, 7)");
      session.execute("UPDATE T SET V = 8 WHERE ID = 12345");
      session.execute("DELETE FROM T WHERE ID = 2345");
      assert.throws(() => session.execute("INSERT INTO T VALUES (12345, 9)"), state("23505"));
      session.execute("BEGIN");
      session.execute("UPDATE T SET ID = 30001 WHERE ID = 20001");
      session.execute("INSERT INTO T VALUES (20001, 10)");
      session.execute("DELETE FROM T WHERE ID = 3456");
      session.execute("COMMIT");
    });
    assert.equal(measured.scans.size, 0, "제약 검사와 커밋에도 전체 힙 순회가 없다");
    assert.deepEqual(rows(session, "SELECT ID FROM T WHERE V = 8"), [["8"], ["12345"]]);
    assert.deepEqual(rows(session, "SELECT V FROM T WHERE ID = 30001"), [["7"]]);
    assert.deepEqual(rows(session, "SELECT COUNT(*) FROM T"), [["20000"]]);
  } finally { db.close(); }
});

test("UPDATE의 여러 행과 INSERT의 DEFAULT 서브쿼리는 변경 전 상태를 본다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE T (ID INTEGER PRIMARY KEY, V INTEGER)");
    session.execute("INSERT INTO T VALUES (1, 10), (2, 20), (3, 30)");
    session.execute("UPDATE T SET V = V + (SELECT SUM(V) FROM T)");
    assert.deepEqual(rows(session, "SELECT V FROM T ORDER BY ID"), [["70"], ["80"], ["90"]]);
    session.execute("ALTER TABLE T ALTER COLUMN V SET DEFAULT (SELECT COUNT(*) FROM T)");
    session.execute("INSERT INTO T (ID) VALUES (4), (5)");
    assert.deepEqual(rows(session, "SELECT V FROM T WHERE ID >= 4 ORDER BY ID"), [["3"], ["3"]]);
  } finally { db.close(); }
});

test("문장 끝의 PK 맞바꾸기와 자기 참조 FK를 최종 상태로 판정한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE T (ID INTEGER PRIMARY KEY, PID INTEGER REFERENCES T ON UPDATE CASCADE)");
    session.execute("INSERT INTO T VALUES (1, 2), (2, 1)");
    session.execute("UPDATE T SET ID = 3 - ID");
    assert.deepEqual(rows(session, "SELECT ID, PID FROM T ORDER BY ID"), [["1", "1"], ["2", "2"]]);
    assert.throws(() => session.execute("UPDATE T SET ID = 3"), state("23505"));
    assert.deepEqual(rows(session, "SELECT ID, PID FROM T ORDER BY ID"), [["1", "1"], ["2", "2"]]);
  } finally { db.close(); }
});

test("복합 FK 순서와 자식 인덱스 순서·DESC·접미 컬럼을 처리한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE P (A INTEGER, B INTEGER, PRIMARY KEY (A, B))");
    session.execute("CREATE TABLE C (ID INTEGER PRIMARY KEY, X INTEGER, Y INTEGER, FOREIGN KEY (X, Y) REFERENCES P (B, A) ON UPDATE CASCADE ON DELETE CASCADE)");
    session.execute("CREATE INDEX IX_C ON C (Y DESC, X ASC, ID DESC)");
    session.execute("INSERT INTO P VALUES (1, 10), (2, 20)");
    session.execute("INSERT INTO C VALUES (1, 10, 1), (2, 20, 2), (3, NULL, 999)");
    const measured = measure(() => {
      session.execute("BEGIN");
      session.execute("UPDATE P SET A = A + 100, B = B + 1000 WHERE A = 1");
      session.execute("DELETE FROM P WHERE A = 2");
      session.execute("COMMIT");
    });
    assert.equal(measured.scans.size, 0, "부모·자식 모두 인덱스만 사용한다");
    assert.deepEqual(rows(session, "SELECT ID, X, Y FROM C ORDER BY ID"), [["1", "1010", "101"], ["3", "NULL", "999"]]);
  } finally { db.close(); }
});

test("여러 부모 키의 인덱스 없는 FK 참조동작은 자식 힙을 한 번만 순회한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE P (ID INTEGER PRIMARY KEY)");
    session.execute("CREATE TABLE C (ID INTEGER PRIMARY KEY, PID INTEGER REFERENCES P ON DELETE CASCADE)");
    session.execute("CREATE TABLE U (ID INTEGER PRIMARY KEY)");
    session.execute("CREATE TABLE UC (PID INTEGER REFERENCES U)");
    session.execute("INSERT INTO P VALUES (1), (2), (3), (4)");
    session.execute("INSERT INTO C VALUES (1, 1), (2, 2), (3, 3), (4, 4)");
    const catalog = db.manager.requireCatalog("APP");
    const measured = measure(() => session.execute("DELETE FROM P WHERE ID <= 3"));
    assert.equal(measured.scans.get(catalog.data.tables["C"]!.heapRoot), 1);
    assert.equal(measured.scans.size, 1, "관련 없는 FK 테이블과 부모 힙은 읽지 않는다");
    assert.deepEqual(rows(session, "SELECT ID FROM C"), [["4"]]);
  } finally { db.close(); }
});

test("인덱스 없는 조건의 DML은 대상 힙을 한 번 순회하고 변경 행만 쓴다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE T (ID INTEGER PRIMARY KEY, V INTEGER)");
    session.execute("INSERT INTO T VALUES (1, 10), (2, 20), (3, 30)");
    const root = db.manager.requireCatalog("APP").data.tables["T"]!.heapRoot;
    assert.equal(measure(() => session.execute("UPDATE T SET V = 21 WHERE V = 20")).scans.get(root), 1);
    assert.equal(measure(() => session.execute("DELETE FROM T WHERE V = 30")).scans.get(root), 1);
    assert.deepEqual(rows(session, "SELECT ID, V FROM T ORDER BY ID"), [["1", "10"], ["2", "21"]]);
  } finally { db.close(); }
});

test("다단계 DELETE CASCADE와 SET NULL은 실제로 바뀐 행에만 전파된다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE P (ID INTEGER PRIMARY KEY)");
    session.execute("CREATE TABLE C (ID INTEGER PRIMARY KEY, K INTEGER REFERENCES P ON DELETE SET NULL)");
    // FK의 비 PK 컬럼만 NULL로 바뀌면 이 테이블의 PK를 참조하는 손자는 그대로 남는다.
    session.execute("CREATE TABLE G (ID INTEGER PRIMARY KEY, CID INTEGER REFERENCES C ON DELETE CASCADE)");
    session.execute("INSERT INTO P VALUES (1)");
    session.execute("INSERT INTO C VALUES (2, 1)");
    session.execute("INSERT INTO G VALUES (3, 2)");
    session.execute("DELETE FROM P WHERE ID = 1");
    assert.deepEqual(rows(session, "SELECT ID, K FROM C"), [["2", "NULL"]]);
    assert.deepEqual(rows(session, "SELECT ID, CID FROM G"), [["3", "2"]]);
    // P 삭제 → C 삭제 → G의 SET NULL 갱신 → G를 참조하는 H는 삭제하면 안 된다.
    session.execute("CREATE TABLE P2 (ID INTEGER PRIMARY KEY)");
    session.execute("CREATE TABLE C2 (ID INTEGER PRIMARY KEY REFERENCES P2 ON DELETE CASCADE)");
    session.execute("CREATE TABLE G2 (ID INTEGER PRIMARY KEY, CID INTEGER REFERENCES C2 ON DELETE SET NULL)");
    session.execute("CREATE TABLE H2 (GID INTEGER REFERENCES G2 ON DELETE CASCADE)");
    session.execute("INSERT INTO P2 VALUES (1)");
    session.execute("INSERT INTO C2 VALUES (1)");
    session.execute("INSERT INTO G2 VALUES (2, 1)");
    session.execute("INSERT INTO H2 VALUES (2)");
    session.execute("DELETE FROM P2 WHERE ID = 1");
    assert.deepEqual(rows(session, "SELECT CID FROM G2"), [["NULL"]]);
    assert.deepEqual(rows(session, "SELECT GID FROM H2"), [["2"]]);
  } finally { db.close(); }
});

test("자기 참조의 다단계·순환 CASCADE 삭제가 끝나고 되돌릴 수 있다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE T (ID INTEGER PRIMARY KEY, PID INTEGER REFERENCES T ON DELETE CASCADE)");
    session.execute("CREATE INDEX IX_T_PID ON T (PID)");
    session.execute("INSERT INTO T VALUES (1, 2), (2, 3), (3, 1), (4, 3)");
    session.execute("BEGIN");
    session.execute("SAVEPOINT S");
    session.execute("DELETE FROM T WHERE ID = 1");
    assert.deepEqual(rows(session, "SELECT COUNT(*) FROM T"), [["0"]]);
    session.execute("ROLLBACK TO S");
    assert.deepEqual(rows(session, "SELECT COUNT(*) FROM T"), [["4"]]);
    session.execute("DELETE FROM T WHERE ID = 2");
    session.execute("COMMIT");
    assert.deepEqual(rows(session, "SELECT COUNT(*) FROM T"), [["0"]]);
  } finally { db.close(); }
});

test("FK 등록 순서와 무관하게 CASCADE가 지울 자식의 NO ACTION은 최종 상태로 검사한다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE P (ID INTEGER PRIMARY KEY)");
    session.execute("CREATE TABLE C (ID INTEGER PRIMARY KEY, A INTEGER REFERENCES P, B INTEGER REFERENCES P ON DELETE CASCADE)");
    session.execute("INSERT INTO P VALUES (1)");
    session.execute("INSERT INTO C VALUES (1, 1, 1)");
    session.execute("DELETE FROM P WHERE ID = 1");
    assert.deepEqual(rows(session, "SELECT COUNT(*) FROM C"), [["0"]]);
  } finally { db.close(); }
});

test("연쇄 도중 NOT NULL·PK·FK 위반은 그 문장만 되돌린다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE P (ID INTEGER PRIMARY KEY)");
    session.execute("CREATE TABLE C (ID INTEGER PRIMARY KEY, PID INTEGER NOT NULL REFERENCES P ON DELETE SET NULL)");
    session.execute("INSERT INTO P VALUES (1), (2)");
    session.execute("INSERT INTO C VALUES (1, 1)");
    session.execute("BEGIN");
    session.execute("INSERT INTO P VALUES (3)");
    assert.throws(() => session.execute("DELETE FROM P WHERE ID <= 2"), state("23502"));
    assert.deepEqual(rows(session, "SELECT ID FROM P ORDER BY ID"), [["1"], ["2"], ["3"]]);
    assert.throws(() => session.execute("INSERT INTO C VALUES (2, 2), (3, 99)"), state("23503"));
    assert.deepEqual(rows(session, "SELECT ID FROM C"), [["1"]]);
    assert.throws(() => session.execute("INSERT INTO P VALUES (4), (3)"), state("23505"));
    assert.deepEqual(rows(session, "SELECT ID FROM P ORDER BY ID"), [["1"], ["2"], ["3"]]);
    session.execute("COMMIT");
  } finally { db.close(); }
});

test("연쇄로 자식 PK와 그 인덱스도 함께 바뀐다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE P (ID INTEGER PRIMARY KEY)");
    session.execute("CREATE TABLE C (PID INTEGER PRIMARY KEY REFERENCES P ON UPDATE CASCADE)");
    session.execute("INSERT INTO P VALUES (1), (2)");
    session.execute("INSERT INTO C VALUES (1), (2)");
    // 부모의 PK 충돌이 먼저 검출되고 연쇄가 시작되지 않는다.
    assert.throws(() => session.execute("UPDATE P SET ID = 2 WHERE ID = 1"), state("23505"));
    session.execute("UPDATE P SET ID = ID + 10");
    assert.deepEqual(rows(session, "SELECT PID FROM C ORDER BY PID"), [["11"], ["12"]]);
  } finally { db.close(); }
});

test("잠금 충돌 때 오버레이와 연쇄를 되돌리고 재시도는 최신 값을 쓴다", async (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE P (ID INTEGER PRIMARY KEY)");
    session.execute("CREATE TABLE C (ID INTEGER PRIMARY KEY, PID INTEGER REFERENCES P ON UPDATE CASCADE)");
    session.execute("CREATE INDEX IX_C_PID ON C (PID)");
    session.execute("INSERT INTO P VALUES (1)");
    session.execute("INSERT INTO C VALUES (1, 1)");
    const other = db.createSession({ tablespace: "APP" });
    session.execute("BEGIN");
    session.execute("SELECT * FROM C WHERE ID = 1 FOR UPDATE");
    other.execute("BEGIN");
    assert.throws(() => other.execute("UPDATE P SET ID = 2 WHERE ID = 1"), state("55P03"));
    assert.deepEqual(rows(other, "SELECT ID FROM P"), [["1"]]);
    assert.deepEqual(rows(other, "SELECT PID FROM C"), [["1"]]);
    // 제약 위반은 잠금 충돌보다 먼저 반환한다.
    assert.throws(() => other.execute("UPDATE C SET PID = 99 WHERE ID = 1"), state("23503"));
    const waiting = other.executeAsync("UPDATE P SET ID = 2 WHERE ID = 1");
    await new Promise<void>((resolve) => setImmediate(resolve));
    session.execute("COMMIT");
    await waiting;
    other.execute("COMMIT");
    assert.deepEqual(rows(session, "SELECT PID FROM C"), [["2"]]);
    assert.equal(db.locks.lockCount, 0);
  } finally { db.close(); }
});

for (const indexed of [false, true]) {
  test(`커밋 FK 재검사는 새 자식과 부모 삭제의 경쟁을 막는다 (자식 인덱스 ${indexed})`, (t) => {
    const { db, session } = setupApp(t);
    try {
      session.execute("CREATE TABLE P (ID INTEGER PRIMARY KEY)");
      session.execute("CREATE TABLE C (ID INTEGER PRIMARY KEY, PID INTEGER REFERENCES P ON DELETE CASCADE ON UPDATE CASCADE)");
      if (indexed) session.execute("CREATE INDEX IX_C_PID ON C (PID)");
      session.execute("INSERT INTO P VALUES (1), (2), (3)");
      const other = db.createSession({ tablespace: "APP" });
      session.execute("BEGIN");
      session.execute("DELETE FROM P WHERE ID = 1");
      other.execute("INSERT INTO C VALUES (1, 1)");
      assert.throws(() => session.execute("COMMIT"), state("23503"));
      assert.deepEqual(rows(other, "SELECT ID FROM P WHERE ID = 1"), [["1"]]);
      session.execute("BEGIN");
      session.execute("INSERT INTO C VALUES (2, 2)");
      other.execute("DELETE FROM P WHERE ID = 2");
      assert.throws(() => session.execute("COMMIT"), state("23503"));
      assert.deepEqual(rows(other, "SELECT ID FROM C WHERE ID = 2"), []);
      session.execute("BEGIN");
      session.execute("UPDATE P SET ID = 30 WHERE ID = 3");
      other.execute("INSERT INTO C VALUES (3, 3)");
      assert.throws(() => session.execute("COMMIT"), state("23503"));
      assert.deepEqual(rows(other, "SELECT ID FROM P WHERE ID = 3"), [["3"]]);
    } finally { db.close(); }
  });
}

test("TRUNCATE는 NULL FK를 건너뛰고 첫 참조 행에서 멈춘다", (t) => {
  const { db, session } = setupApp(t);
  try {
    session.execute("CREATE TABLE P (ID INTEGER PRIMARY KEY)");
    session.execute("CREATE TABLE C (PID INTEGER REFERENCES P)");
    session.execute("INSERT INTO P VALUES (1)");
    session.execute("INSERT INTO C VALUES (NULL), (1), (1), (1)");
    const catalog = db.manager.requireCatalog("APP");
    const measured = measure(() => assert.throws(() => session.execute("TRUNCATE P"), state("23503")));
    assert.equal(measured.scans.size, 1);
    assert.equal(measured.visited.get(catalog.data.tables["C"]!.heapRoot), 2);
    session.execute("DELETE FROM C WHERE PID IS NOT NULL");
    session.execute("TRUNCATE P");
    assert.deepEqual(rows(session, "SELECT COUNT(*) FROM C"), [["1"]]);
  } finally { db.close(); }
});

test("행 단위 커밋은 삭제·재삽입·반복 PK 변경과 보조 인덱스를 재구동 뒤에도 유지한다", (t) => {
  const dir = tempDir(t);
  let db = openTestDb(dir);
  try {
    let session = db.createSession({});
    session.execute("CREATE TABLESPACE APP");
    session.execute("USE APP");
    session.execute("CREATE TABLE T (ID INTEGER PRIMARY KEY, V VARCHAR)");
    session.execute("CREATE INDEX IX_T_V ON T (V)");
    session.execute("INSERT INTO T VALUES (1, 'a'), (2, 'b')");
    session.execute("BEGIN");
    session.execute("UPDATE T SET ID = 10, V = 'x' WHERE ID = 1");
    session.execute("UPDATE T SET ID = 20, V = 'y' WHERE ID = 10");
    session.execute("DELETE FROM T WHERE ID = 2");
    session.execute("INSERT INTO T VALUES (2, 'new')");
    session.execute("INSERT INTO T VALUES (3, 'gone')");
    session.execute("DELETE FROM T WHERE ID = 3");
    session.execute("COMMIT");
    db.close();
    db = openTestDb(dir);
    session = db.createSession({ tablespace: "APP" });
    assert.deepEqual(rows(session, "SELECT ID, V FROM T ORDER BY ID"), [["2", "new"], ["20", "y"]]);
    assert.deepEqual(rows(session, "SELECT ID FROM T WHERE V = 'y'"), [["20"]]);
    assert.deepEqual(rows(session, "SELECT ID FROM T WHERE V IN ('a', 'b', 'x', 'gone')"), []);
  } finally { db.close(); }
});
