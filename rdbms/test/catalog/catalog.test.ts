/**
 * 카탈로그와 DDL 테스트 (5단계).
 * 프로세스 내부 세션 API 로 테이블스페이스, 테이블, 뷰, 인덱스 DDL 과 딕셔너리 뷰, DUAL 을 본다.
 * 관련 사양 : AGENTS.md 상세 0, 1-3, 3, 11
 * 구현 단계 : 5단계
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Database } from "../../src/session/session.js";
import type { ExecuteResult } from "../../src/session/session.js";
import { DbError } from "../../src/common/errors.js";

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hwdb-catalog-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function openTestDb(dir: string): Database {
  return Database.open(dir, { onWarning: () => {} });
}

function state(code: string): (error: unknown) => boolean {
  return (error) => error instanceof DbError && error.sqlState === code;
}

function selectRows(result: ExecuteResult): string[][] {
  assert.equal(result.kind, "select");
  if (result.kind !== "select") throw new Error("Not a select result.");
  return result.rows.map((row) =>
    row.map((value) => {
      if (value === null) return "NULL";
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "string") return value;
      if (Buffer.isBuffer(value)) return value.toString("hex");
      return String(value);
    }),
  );
}

test("SYSTEM 테이블스페이스는 최초 구동 때 자동으로 생긴다", (t) => {
  const dir = tempDir(t);
  const db = openTestDb(dir);
  try {
    assert.ok(fs.existsSync(path.join(dir, "SYSTEM.hwdb")));
    const session = db.createSession({});
    const tablespaces = session.execute("SELECT * FROM SYSTEM.SYS_TABLESPACES");
    const rows = selectRows(tablespaces);
    assert.ok(rows.some((row) => row[0] === "SYSTEM" && row[4] === "AVAILABLE"));
  } finally {
    db.close();
  }
});

test("테이블스페이스 생성과 삭제가 동작한다", (t) => {
  const dir = tempDir(t);
  const db = openTestDb(dir);
  try {
    const session = db.createSession({});
    session.execute("CREATE TABLESPACE APP");
    assert.ok(fs.existsSync(path.join(dir, "APP.hwdb")));
    // 중복은 오류이다.
    assert.throws(() => session.execute("CREATE TABLESPACE APP"), state("42P06"));
    // CHARACTER SET 는 UTF8 만 받는다.
    assert.throws(() => session.execute("CREATE TABLESPACE BAD_TS CHARACTER SET UTF16"), state("0A000"));
    // DATAFILE 을 지정할 수 있다.
    session.execute("CREATE TABLESPACE CUSTOM DATAFILE 'custom/custom.hwdb'");
    assert.ok(fs.existsSync(path.join(dir, "custom", "custom.hwdb")));
    // 비어 있지 않으면 INCLUDING CONTENTS 가 필요하다.
    session.execute("USE CUSTOM");
    session.execute("CREATE TABLE T (A INTEGER)");
    session.execute("USE SYSTEM");
    assert.throws(() => session.execute("DROP TABLESPACE CUSTOM"), state("55006"));
    session.execute("DROP TABLESPACE CUSTOM INCLUDING CONTENTS");
    assert.ok(!fs.existsSync(path.join(dir, "custom", "custom.hwdb")));
    // SYSTEM 은 지울 수 없다.
    assert.throws(() => session.execute("DROP TABLESPACE SYSTEM INCLUDING CONTENTS"), state("55006"));
    // 없는 테이블스페이스는 오류이다.
    assert.throws(() => session.execute("DROP TABLESPACE MISSING"), state("3D000"));
  } finally {
    db.close();
  }
});

test("DDL 로 만든 객체가 재구동 후에도 남는다", (t) => {
  const dir = tempDir(t);
  let db = openTestDb(dir);
  try {
    const session = db.createSession({});
    session.execute("CREATE TABLESPACE APP");
    session.execute("USE APP");
    session.execute("CREATE TABLE HELLO (MESSAGE VARCHAR)");
    session.execute("CREATE VIEW V_HELLO AS SELECT * FROM HELLO");
    session.execute("CREATE INDEX IX_HELLO_MSG ON HELLO (MESSAGE)");
  } finally {
    db.close();
  }
  db = openTestDb(dir);
  try {
    const session = db.createSession({ tablespace: "APP" });
    const tables = selectRows(session.execute("SELECT * FROM SYSTEM.SYS_TABLES"));
    assert.ok(tables.some((row) => row[0] === "APP" && row[1] === "HELLO"));
    const views = selectRows(session.execute("SELECT * FROM SYSTEM.SYS_VIEWS"));
    assert.ok(views.some((row) => row[0] === "APP" && row[1] === "V_HELLO"));
    const indexes = selectRows(session.execute("SELECT * FROM SYSTEM.SYS_INDEXES"));
    assert.ok(indexes.some((row) => row[0] === "APP" && row[1] === "IX_HELLO_MSG"));
    const columns = selectRows(session.execute("SELECT * FROM SYSTEM.SYS_COLUMNS"));
    assert.ok(columns.some((row) => row[1] === "HELLO" && row[2] === "MESSAGE"));
  } finally {
    db.close();
  }
});

test("테이블 DDL 의 이름 규칙과 중복을 검사한다", (t) => {
  const dir = tempDir(t);
  const db = openTestDb(dir);
  try {
    const session = db.createSession({});
    session.execute("CREATE TABLESPACE APP");
    session.execute("USE APP");
    session.execute("CREATE TABLE T1 (A INTEGER)");
    // 같은 이름의 테이블은 만들 수 없다.
    assert.throws(() => session.execute("CREATE TABLE T1 (A INTEGER)"), state("42P07"));
    // IF NOT EXISTS 는 넘어간다.
    session.execute("CREATE TABLE IF NOT EXISTS T1 (A INTEGER)");
    // 테이블과 뷰는 이름공간을 함께 쓴다.
    session.execute("CREATE VIEW V1 AS SELECT * FROM T1");
    assert.throws(() => session.execute("CREATE TABLE V1 (A INTEGER)"), state("42P07"));
    assert.throws(() => session.execute("CREATE VIEW V1 AS SELECT * FROM T1"), state("42P07"));
    session.execute("CREATE OR REPLACE VIEW V1 AS SELECT * FROM T1");
    // SYSTEM 의 예약 이름은 막는다.
    session.execute("USE SYSTEM");
    assert.throws(() => session.execute("CREATE TABLE SYS_FOO (A INTEGER)"), state("42602"));
    assert.throws(() => session.execute("CREATE TABLE DUAL (A INTEGER)"), state("42602"));
    assert.throws(() => session.execute("CREATE VIEW SYS_BAR AS SELECT * FROM DUAL"), state("42602"));
  } finally {
    db.close();
  }
});

test("PK 와 FK 정의와 자동 이름을 확인한다", (t) => {
  const dir = tempDir(t);
  const db = openTestDb(dir);
  try {
    const session = db.createSession({});
    session.execute("CREATE TABLESPACE APP");
    session.execute("USE APP");
    session.execute("CREATE TABLE PARENT (ID INTEGER PRIMARY KEY, NAME VARCHAR(10))");
    session.execute("CREATE TABLE CHILD (ID INTEGER PRIMARY KEY, PID INTEGER REFERENCES PARENT (ID))");
    const constraints = selectRows(session.execute("SELECT * FROM SYSTEM.SYS_CONSTRAINTS"));
    assert.ok(constraints.some((row) => row[1] === "PK_PARENT" && row[3] === "PRIMARY KEY"));
    assert.ok(constraints.some((row) => row[1] === "PK_CHILD"));
    assert.ok(constraints.some((row) => row[2] === "CHILD" && row[3] === "FOREIGN KEY" && row[4] === "PARENT"));
    // 참조 컬럼 생략은 대상 PK 이다.
    session.execute("CREATE TABLE CHILD2 (ID INTEGER PRIMARY KEY, PID INTEGER REFERENCES PARENT)");
    // 같은 테이블스페이스만 참조할 수 있다.
    session.execute("CREATE TABLESPACE OTHER");
    assert.throws(
      () => session.execute("CREATE TABLE BAD (A INTEGER REFERENCES OTHER.PARENT (ID))"),
      state("42P16"),
    );
    // 타입이 다르면 안 된다.
    assert.throws(
      () => session.execute("CREATE TABLE BAD2 (A VARCHAR(10) REFERENCES PARENT (ID))"),
      state("42P16"),
    );
    // 없는 테이블 참조는 안 된다.
    assert.throws(() => session.execute("CREATE TABLE BAD3 (A INTEGER REFERENCES MISSING (ID))"), state("42P01"));
  } finally {
    db.close();
  }
});

test("ALTER TABLE 의 가지들을 확인한다", (t) => {
  const dir = tempDir(t);
  const db = openTestDb(dir);
  try {
    const session = db.createSession({});
    session.execute("CREATE TABLESPACE APP");
    session.execute("USE APP");
    session.execute("CREATE TABLE T (A INTEGER)");
    session.execute("ALTER TABLE T ADD COLUMN B VARCHAR(10)");
    session.execute("ALTER TABLE T ALTER COLUMN B SET NOT NULL");
    session.execute("ALTER TABLE T ALTER COLUMN B DROP NOT NULL");
    session.execute("ALTER TABLE T RENAME COLUMN B TO C");
    session.execute("ALTER TABLE T RENAME TO T2");
    session.execute("ALTER TABLE T2 ADD CONSTRAINT PK_T2 PRIMARY KEY (A)");
    session.execute("ALTER TABLE T2 DROP CONSTRAINT PK_T2");
    const columns = selectRows(session.execute("SELECT * FROM SYSTEM.SYS_COLUMNS"));
    assert.ok(columns.some((row) => row[1] === "T2" && row[2] === "C"));
    // PK 가 걸린 컬럼은 지우거나 바꿀 수 없다.
    session.execute("ALTER TABLE T2 ADD CONSTRAINT PK_T2 PRIMARY KEY (A)");
    assert.throws(() => session.execute("ALTER TABLE T2 DROP COLUMN A"), state("55006"));
    assert.throws(() => session.execute("ALTER TABLE T2 RENAME COLUMN A TO Z"), state("55006"));
  } finally {
    db.close();
  }
});

test("DROP TABLE 의 RESTRICT 와 CASCADE 를 확인한다", (t) => {
  const dir = tempDir(t);
  const db = openTestDb(dir);
  try {
    const session = db.createSession({});
    session.execute("CREATE TABLESPACE APP");
    session.execute("USE APP");
    session.execute("CREATE TABLE P (ID INTEGER PRIMARY KEY)");
    session.execute("CREATE TABLE C (ID INTEGER PRIMARY KEY, PID INTEGER REFERENCES P (ID))");
    session.execute("CREATE VIEW V AS SELECT * FROM P");
    assert.throws(() => session.execute("DROP TABLE P"), state("55006"));
    session.execute("DROP TABLE P CASCADE");
    const tables = selectRows(session.execute("SELECT * FROM SYSTEM.SYS_TABLES"));
    assert.ok(!tables.some((row) => row[1] === "P"));
    assert.ok(tables.some((row) => row[1] === "C"));
    const views = selectRows(session.execute("SELECT * FROM SYSTEM.SYS_VIEWS"));
    assert.ok(!views.some((row) => row[1] === "V"));
    const constraints = selectRows(session.execute("SELECT * FROM SYSTEM.SYS_CONSTRAINTS"));
    assert.ok(!constraints.some((row) => row[4] === "P"));
  } finally {
    db.close();
  }
});

test("뷰와 인덱스 DDL 을 확인한다", (t) => {
  const dir = tempDir(t);
  const db = openTestDb(dir);
  try {
    const session = db.createSession({});
    session.execute("CREATE TABLESPACE APP");
    session.execute("USE APP");
    session.execute("CREATE TABLE T (A INTEGER, B VARCHAR(10))");
    session.execute("CREATE VIEW V (X, Y) AS SELECT A, B FROM T");
    session.execute("CREATE INDEX IX_T_A ON T (A DESC, B)");
    const indexes = selectRows(session.execute("SELECT * FROM SYSTEM.SYS_INDEXES"));
    assert.ok(indexes.some((row) => row[1] === "IX_T_A"));
    const indexColumns = selectRows(session.execute("SELECT * FROM SYSTEM.SYS_INDEX_COLUMNS"));
    assert.ok(indexColumns.some((row) => row[1] === "IX_T_A" && row[3] === "A" && row[4] === "YES"));
    // 이름 없는 인덱스는 자동으로 짓는다.
    session.execute("CREATE INDEX ON T (B)");
    // PK 인덱스는 DROP INDEX 로 지울 수 없다.
    session.execute("ALTER TABLE T ADD CONSTRAINT PK_T PRIMARY KEY (A)");
    assert.throws(() => session.execute("DROP INDEX PK_T"), state("42P16"));
    // DROP VIEW 의 RESTRICT 와 CASCADE 를 본다.
    session.execute("CREATE VIEW V2 AS SELECT * FROM V");
    assert.throws(() => session.execute("DROP VIEW V"), state("55006"));
    session.execute("DROP VIEW V CASCADE");
    const views = selectRows(session.execute("SELECT * FROM SYSTEM.SYS_VIEWS"));
    assert.ok(!views.some((row) => row[1] === "V"));
    assert.ok(!views.some((row) => row[1] === "V2"));
  } finally {
    db.close();
  }
});

test("TRUNCATE 와 세션 문장이 동작한다", (t) => {
  const dir = tempDir(t);
  const db = openTestDb(dir);
  try {
    const session = db.createSession({});
    session.execute("CREATE TABLESPACE APP");
    session.execute("USE APP");
    session.execute("CREATE TABLE T (A INTEGER PRIMARY KEY)");
    session.execute("TRUNCATE TABLE T");
    session.execute("TRUNCATE T");
    session.execute("USE SYSTEM");
    assert.equal(session.currentTablespace, "SYSTEM");
    assert.throws(() => session.execute("USE MISSING"), state("3D000"));
    session.execute("SET TIME ZONE '+09:00'");
    assert.throws(() => session.execute("SET TIME ZONE 'BAD/Zone'"), state("22009"));
    session.execute("SET AUTOCOMMIT OFF");
    assert.equal(session.autocommit, false);
    session.execute("BEGIN");
    session.execute("COMMIT");
  } finally {
    db.close();
  }
});

test("딕셔너리 뷰와 DUAL 을 조회한다", (t) => {
  const dir = tempDir(t);
  const db = openTestDb(dir);
  try {
    const session = db.createSession({});
    session.execute("CREATE TABLESPACE APP");
    session.execute("USE APP");
    session.execute("CREATE TABLE T (A INTEGER)");
    for (const view of [
      "SYS_TABLESPACES",
      "SYS_USERS",
      "SYS_TABLES",
      "SYS_COLUMNS",
      "SYS_VIEWS",
      "SYS_INDEXES",
      "SYS_INDEX_COLUMNS",
      "SYS_CONSTRAINTS",
      "SYS_CONSTRAINT_COLUMNS",
      "SYS_PRIVILEGES",
      "SYS_GROUP_GRANTS",
      "SYS_SESSIONS",
    ]) {
      const result = session.execute(`SELECT * FROM SYSTEM.${view}`);
      assert.equal(result.kind, "select");
    }
    const dual = session.execute("SELECT * FROM SYSTEM.DUAL");
    assert.deepEqual(selectRows(dual), [["X"]]);
    const bare = session.execute("SELECT 'Hello World'");
    assert.deepEqual(selectRows(bare), [["Hello World"]]);
    // FROM 없는 Hello World 와 테이블 한 행이 그대로 실행된다. (상세 13)
    const hello = session.execute("SELECT 'Hello World'");
    assert.equal(hello.kind, "select");
  } finally {
    db.close();
  }
});

test("데이터 파일이 없거나 손상되면 사용 불가로 둔다", (t) => {
  const dir = tempDir(t);
  let db = openTestDb(dir);
  try {
    const session = db.createSession({});
    session.execute("CREATE TABLESPACE APP");
    session.execute("USE APP");
    session.execute("CREATE TABLE T (A INTEGER)");
  } finally {
    db.close();
  }
  // 데이터 파일을 지우고 다시 열면 사용 불가이다.
  fs.rmSync(path.join(dir, "APP.hwdb"));
  db = openTestDb(dir);
  try {
    const session = db.createSession({});
    const rows = selectRows(session.execute("SELECT * FROM SYSTEM.SYS_TABLESPACES"));
    const app = rows.find((row) => row[0] === "APP");
    assert.ok(app !== undefined && app[4] === "UNAVAILABLE");
    assert.throws(() => session.execute("USE APP"), state("58030"));
  } finally {
    db.close();
  }
});

test("오류에 SQLSTATE 와 위치가 담긴다", (t) => {
  const dir = tempDir(t);
  const db = openTestDb(dir);
  try {
    const session = db.createSession({});
    try {
      session.execute("CREATE TABL T (A INTEGER)");
      assert.fail("Expected a syntax error.");
    } catch (error) {
      assert.ok(error instanceof DbError);
      assert.equal(error.sqlState, "42601");
      assert.ok(error.position !== undefined);
    }
    try {
      session.execute("CREATE TABLE T (A INTEGER REFERENCES MISSING (ID))");
      assert.fail("Expected a missing table error.");
    } catch (error) {
      assert.ok(error instanceof DbError);
      assert.equal(error.sqlState, "42P01");
    }
  } finally {
    db.close();
  }
});

test("한도와 교차 테이블스페이스 참조를 검사한다", (t) => {
  const dir = tempDir(t);
  const db = openTestDb(dir);
  try {
    const session = db.createSession({});
    session.execute("CREATE TABLESPACE APP");
    session.execute("CREATE TABLESPACE OTHER");
    session.execute("USE APP");
    // 컬럼 1,000개까지는 되고 1,001개는 안 된다.
    const many = Array.from({ length: 1000 }, (_, i) => `C${i} INTEGER`).join(", ");
    session.execute(`CREATE TABLE MANY (${many})`);
    const tooMany = Array.from({ length: 1001 }, (_, i) => `D${i} INTEGER`).join(", ");
    assert.throws(() => session.execute(`CREATE TABLE TOO_MANY (${tooMany})`), state("54011"));
    // 인덱스는 16개까지이다.
    session.execute("CREATE TABLE T (A1 INTEGER, A2 INTEGER, A3 INTEGER)");
    assert.throws(
      () =>
        session.execute(
          "CREATE INDEX BIG_IDX ON T (A1, A2, A3, A1, A2, A3, A1, A2, A3, A1, A2, A3, A1, A2, A3, A1, A2)",
        ),
      state("42P16"),
    );
    // DATAFILE 중복은 안 된다.
    session.execute("CREATE TABLESPACE WITH_FILE DATAFILE 'shared.hwdb'");
    assert.throws(() => session.execute("CREATE TABLESPACE DUP_FILE DATAFILE 'shared.hwdb'"), state("42P06"));
    // 다른 테이블스페이스의 객체를 뷰에서 함께 볼 수 있다.
    session.execute("USE OTHER");
    session.execute("CREATE TABLE OT (A INTEGER PRIMARY KEY)");
    session.execute("USE APP");
    session.execute("CREATE TABLE LT (A INTEGER PRIMARY KEY)");
    session.execute("CREATE VIEW CROSS_V AS SELECT * FROM LT UNION SELECT * FROM OTHER.OT");
    const views = selectRows(session.execute("SELECT * FROM SYSTEM.SYS_VIEWS"));
    assert.ok(views.some((row) => row[0] === "APP" && row[1] === "CROSS_V"));
    // FK 는 같은 테이블스페이스만 된다.
    assert.throws(() => session.execute("CREATE TABLE BAD_FK (A INTEGER REFERENCES OTHER.OT (A))"), state("42P16"));
  } finally {
    db.close();
  }
});
