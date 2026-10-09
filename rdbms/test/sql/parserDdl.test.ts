/**
 * 담당 : DDL 의 구문 분석. 테이블, 뷰, 인덱스의 생성·변경·삭제와 제약조건.
 * 관련 사양 : AGENTS.md 상세 1-1, 1-3, 10, 11, 13, 16.
 * 구현 단계 : 4단계.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type * as ast from "../../src/sql/ast.js";
import { parseStatement } from "../../src/sql/parser.js";
import { formatDataType } from "../../src/types/dataType.js";
import { assertSqlStateAt, assertSyntaxError, assertUnsupported, parse, renderExpression, renderQuery } from "./helpers.js";

const name = (text: string, tablespace: string | null = null): { tablespace: string | null; name: string } =>
  ({ tablespace, name: text });

function referenceText(reference: ast.ForeignKeyReference): string {
  const table = `${reference.table.tablespace === null ? "" : `${reference.table.tablespace}.`}${reference.table.name}`;
  let text = `-> ${table}${reference.columns === null ? "" : `(${reference.columns.join(",")})`}`;
  if (reference.onDelete !== null) text += ` ON DELETE ${reference.onDelete}`;
  if (reference.onUpdate !== null) text += ` ON UPDATE ${reference.onUpdate}`;
  return text;
}

/** 컬럼 정의를 `이름 타입 [속성...]` 한 줄로 적는다. */
function columnText(column: ast.ColumnDefinition): string {
  let text = `${column.name} ${formatDataType(column.dataType)}`;
  if (column.default !== null) text += ` DEFAULT ${renderExpression(column.default)}`;
  if (column.notNull) text += " NOT NULL";
  if (column.primaryKey !== null) text += ` PK${column.primaryKey.name === null ? "" : `[${column.primaryKey.name}]`}`;
  if (column.references !== null) {
    text += ` FK${column.references.name === null ? "" : `[${column.references.name}]`} ${referenceText(column.references)}`;
  }
  return text;
}

function constraintText(constraint: ast.TableConstraint): string {
  const label = constraint.name === null ? "" : `[${constraint.name}]`;
  return constraint.kind === "PrimaryKey"
    ? `PK${label}(${constraint.columns.join(",")})`
    : `FK${label}(${constraint.columns.join(",")}) ${referenceText(constraint.reference)}`;
}

/** CREATE TABLE 의 컬럼과 제약조건을 줄 목록으로 돌려준다. */
function table(sql: string): string[] {
  const statement = parseStatement(sql).statement as ast.CreateTableStatement;
  assert.equal(statement.kind, "CreateTable");
  return [...statement.columns.map(columnText), ...statement.constraints.map(constraintText)];
}

function alter(sql: string): ast.AlterTableAction {
  const statement = parse(sql) as ast.AlterTableStatement;
  assert.equal(statement.kind, "AlterTable");
  return statement.action;
}

test("CREATE TABLE : 타입의 길이와 정밀도를 생략하면 기본값이 들어간다", () => {
  assert.deepEqual(table(`CREATE TABLE t (
    c1 CHAR, c2 VARCHAR, c3 NCHAR, c4 NVARCHAR, c5 BINARY, c6 VARBINARY,
    n1 SMALLINT, n2 INTEGER, n3 INT, n4 BIGINT, n5 DECIMAL, n6 NUMERIC, n7 DEC, n8 DECIMAL(8), n9 NUMERIC(12, 4),
    f1 REAL, f2 DOUBLE PRECISION, f3 FLOAT, f4 FLOAT(10),
    b1 BOOLEAN, d1 DATE, t1 TIME, t2 TIME WITH TIME ZONE, s1 TIMESTAMP, s2 TIMESTAMP WITH TIME ZONE,
    i1 INTERVAL YEAR, i2 INTERVAL YEAR TO MONTH, i3 INTERVAL DAY TO SECOND, i4 INTERVAL HOUR(4) TO MINUTE
  )`), [
    "C1 CHAR(1)", "C2 VARCHAR(65535)", "C3 CHAR(1)", "C4 VARCHAR(65535)", "C5 BINARY(1)", "C6 VARBINARY(65535)",
    "N1 SMALLINT", "N2 INTEGER", "N3 INTEGER", "N4 BIGINT", "N5 DECIMAL(10,3)", "N6 DECIMAL(10,3)", "N7 DECIMAL(10,3)",
    "N8 DECIMAL(8,0)", "N9 DECIMAL(12,4)",
    "F1 REAL", "F2 DOUBLE PRECISION", "F3 DOUBLE PRECISION", "F4 REAL",
    "B1 BOOLEAN", "D1 DATE", "T1 TIME(0)", "T2 TIME(0) WITH TIME ZONE", "S1 TIMESTAMP(6)", "S2 TIMESTAMP(6) WITH TIME ZONE",
    "I1 INTERVAL YEAR(2)", "I2 INTERVAL YEAR(2) TO MONTH", "I3 INTERVAL DAY(2) TO SECOND(6)", "I4 INTERVAL HOUR(4) TO MINUTE",
  ]);
  assert.deepEqual(table("CREATE TABLE t (a VARCHAR(65535), b CHAR(2000), c TIMESTAMP(0), d TIME(6) WITHOUT TIME ZONE)"), [
    "A VARCHAR(65535)", "B CHAR(2000)", "C TIMESTAMP(0)", "D TIME(6)",
  ]);
});

test("CREATE TABLE : 이름과 IF NOT EXISTS", () => {
  const created = parse("CREATE TABLE IF NOT EXISTS app.orders (id INT)") as ast.CreateTableStatement;
  assert.deepEqual(created.name, name("ORDERS", "APP"));
  assert.equal(created.ifNotExists, true);
  assert.equal((parse("CREATE TABLE orders (id INT)") as ast.CreateTableStatement).ifNotExists, false);
  assert.deepEqual((parse('CREATE TABLE "Mixed"."주문 내역" ("상품 명" VARCHAR(10))') as ast.CreateTableStatement).name,
    name("주문 내역", "Mixed"));
  assert.deepEqual(table('CREATE TABLE t ("상품 명" VARCHAR(10), 수량 INT)'), ["상품 명 VARCHAR(10)", "수량 INTEGER"]);
  assertSyntaxError("CREATE TABLE", { line: 1, column: 13 });
  assertSyntaxError("CREATE TABLE t", { line: 1, column: 15 });
  assertSyntaxError("CREATE TABLE t ()", { line: 1, column: 17 });
  assertSyntaxError("CREATE TABLE t (a)", { line: 1, column: 18 }, /expected a data type/);
  assertSyntaxError("CREATE TABLE t (a INT", { line: 1, column: 22 });
  assertSyntaxError("CREATE TABLE t (a INT,)");
  assertSyntaxError("CREATE TABLE t (a INT b INT)");
  assertSyntaxError("CREATE TABLE IF EXISTS t (a INT)");
  assertSyntaxError("CREATE TABLE a.b.c (a INT)");
  assertSyntaxError("CREATE TABLE t (PRIMARY KEY (a))", { line: 1, column: 16 }, /at least one column/);
  assertUnsupported("CREATE TABLE t AS SELECT * FROM u");
  assertUnsupported("CREATE TABLE t (a INT) PARTITION BY RANGE (a)");
  assertUnsupported("CREATE TEMPORARY TABLE t (a INT)");
});

test("컬럼 속성 : DEFAULT, NOT NULL, PRIMARY KEY, REFERENCES 를 순서와 무관하게 받는다", () => {
  assert.deepEqual(table(`CREATE TABLE t (
    a INT DEFAULT 0 NOT NULL,
    b VARCHAR(10) NOT NULL DEFAULT 'x',
    c INT PRIMARY KEY,
    d INT NOT NULL PRIMARY KEY,
    e INT NULL,
    f DECIMAL(10,2) DEFAULT -1.5,
    g TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    h DATE DEFAULT DATE '2026-01-01',
    i VARCHAR(20) DEFAULT 'a' || 'b',
    j INT DEFAULT NULL,
    k BOOLEAN DEFAULT TRUE NOT NULL,
    l INT DEFAULT (1 + 2) * 3
  )`), [
    "A INTEGER DEFAULT 0 NOT NULL",
    "B VARCHAR(10) DEFAULT 'x' NOT NULL",
    "C INTEGER PK",
    "D INTEGER NOT NULL PK",
    "E INTEGER",
    "F DECIMAL(10,2) DEFAULT -1.5:DECIMAL",
    "G TIMESTAMP(6) DEFAULT (CURRENT_TIMESTAMP) NOT NULL",
    "H DATE DEFAULT DATE'2026-01-01'",
    "I VARCHAR(20) DEFAULT (|| 'a' 'b')",
    "J INTEGER DEFAULT NULL",
    "K BOOLEAN DEFAULT TRUE NOT NULL",
    "L INTEGER DEFAULT (* (+ 1 2) 3)",
  ]);
  assert.deepEqual(table("CREATE TABLE t (a INT CONSTRAINT pk_t PRIMARY KEY, b INT CONSTRAINT nn_b NOT NULL)"), [
    "A INTEGER PK[PK_T]", "B INTEGER NOT NULL",
  ]);
  assertSyntaxError("CREATE TABLE t (a INT DEFAULT)", { line: 1, column: 30 });
  assertSyntaxError("CREATE TABLE t (a INT DEFAULT 1 DEFAULT 2)", { line: 1, column: 33 }, /DEFAULT is specified more than once/);
  assertSyntaxError("CREATE TABLE t (a INT PRIMARY KEY PRIMARY KEY)");
  assertSyntaxError("CREATE TABLE t (a INT NOT NULL NULL)", undefined, /both NULL and NOT NULL/);
  assertSyntaxError("CREATE TABLE t (a INT NULL NOT NULL)");
  assertSyntaxError("CREATE TABLE t (a INT NOT)");
  assertSyntaxError("CREATE TABLE t (a INT PRIMARY)");
  assertSyntaxError("CREATE TABLE t (a INT CONSTRAINT c DEFAULT 1)");
  assertSyntaxError("CREATE TABLE t (a INT CONSTRAINT)");
});

test("외래 키 : 컬럼에 붙여 적는 방식과 테이블 제약조건으로 적는 방식", () => {
  assert.deepEqual(table(`CREATE TABLE child (
    id INT PRIMARY KEY,
    p1 INT REFERENCES parent,
    p2 INT REFERENCES parent (id),
    p3 INT REFERENCES app.parent (id) ON DELETE CASCADE,
    p4 INT REFERENCES parent ON UPDATE SET NULL ON DELETE RESTRICT,
    p5 INT CONSTRAINT fk5 REFERENCES parent ON DELETE NO ACTION NOT NULL,
    p6 INT NOT NULL REFERENCES child,
    a INT, b INT,
    CONSTRAINT fk_ab FOREIGN KEY (a, b) REFERENCES parent2 (x, y) ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY (a) REFERENCES parent
  )`), [
    "ID INTEGER PK",
    "P1 INTEGER FK -> PARENT",
    "P2 INTEGER FK -> PARENT(ID)",
    "P3 INTEGER FK -> APP.PARENT(ID) ON DELETE CASCADE",
    "P4 INTEGER FK -> PARENT ON DELETE RESTRICT ON UPDATE SET NULL",
    "P5 INTEGER NOT NULL FK[FK5] -> PARENT ON DELETE NO ACTION",
    "P6 INTEGER NOT NULL FK -> CHILD",
    "A INTEGER",
    "B INTEGER",
    "FK[FK_AB](A,B) -> PARENT2(X,Y) ON DELETE SET NULL ON UPDATE CASCADE",
    "FK(A) -> PARENT",
  ]);
  assertSyntaxError("CREATE TABLE t (a INT REFERENCES)", { line: 1, column: 33 });
  assertSyntaxError("CREATE TABLE t (a INT REFERENCES p ON DELETE)");
  assertSyntaxError("CREATE TABLE t (a INT REFERENCES p ON INSERT CASCADE)");
  assertSyntaxError("CREATE TABLE t (a INT REFERENCES p ON DELETE CASCADE ON DELETE RESTRICT)", undefined, /more than once/);
  assertSyntaxError("CREATE TABLE t (a INT REFERENCES p ON DELETE SET)");
  assertSyntaxError("CREATE TABLE t (a INT REFERENCES p ON DELETE NO)");
  assertSyntaxError("CREATE TABLE t (a INT, FOREIGN KEY (a))");
  assertSyntaxError("CREATE TABLE t (a INT, FOREIGN KEY a REFERENCES p)");
  assertSyntaxError("CREATE TABLE t (a INT, FOREIGN (a) REFERENCES p)");
  assertUnsupported("CREATE TABLE t (a INT REFERENCES p ON DELETE SET DEFAULT)");
  assertUnsupported("CREATE TABLE t (a INT REFERENCES p MATCH FULL)");
  assertUnsupported("CREATE TABLE t (a INT REFERENCES p DEFERRABLE)");
  assertUnsupported("CREATE TABLE t (a INT, FOREIGN KEY (a) REFERENCES p INITIALLY DEFERRED)");
});

test("기본 키 : 이름을 생략할 수 있고 복합 컬럼을 받는다", () => {
  assert.deepEqual(table("CREATE TABLE t (a INT, b INT, PRIMARY KEY (a))"), ["A INTEGER", "B INTEGER", "PK(A)"]);
  assert.deepEqual(table("CREATE TABLE t (a INT, b INT, CONSTRAINT pk_t PRIMARY KEY (a, b))"), [
    "A INTEGER", "B INTEGER", "PK[PK_T](A,B)",
  ]);
  assert.deepEqual(table('CREATE TABLE t (a INT, CONSTRAINT "pk t" PRIMARY KEY ("a"))'), ["A INTEGER", "PK[pk t](a)"]);
  // 제약조건과 컬럼은 섞어 적을 수 있다.
  assert.deepEqual(table("CREATE TABLE t (PRIMARY KEY (a), a INT)"), ["A INTEGER", "PK(A)"]);
  assertSyntaxError("CREATE TABLE t (a INT, PRIMARY KEY)");
  assertSyntaxError("CREATE TABLE t (a INT, PRIMARY KEY ())");
  assertSyntaxError("CREATE TABLE t (a INT, PRIMARY (a))");
  assertSyntaxError("CREATE TABLE t (a INT, CONSTRAINT pk)");
  assertSyntaxError("CREATE TABLE t (a INT, CONSTRAINT PRIMARY KEY (a))");
});

test("UNIQUE, CHECK 등 지원하지 않는 제약조건과 컬럼 속성은 0A000 이다", () => {
  assertUnsupported("CREATE TABLE t (a INT UNIQUE)", { line: 1, column: 23 }, /UNIQUE constraint is not supported/);
  assertUnsupported("CREATE TABLE t (a INT CHECK (a > 0))", { line: 1, column: 23 }, /CHECK constraint is not supported/);
  assertUnsupported("CREATE TABLE t (a INT, UNIQUE (a))", { line: 1, column: 24 });
  assertUnsupported("CREATE TABLE t (a INT, CHECK (a > 0))");
  assertUnsupported("CREATE TABLE t (a INT, CONSTRAINT uq UNIQUE (a))", { line: 1, column: 38 });
  assertUnsupported("CREATE TABLE t (a INT CONSTRAINT ck CHECK (a > 0))");
  assertUnsupported("CREATE TABLE t (a INT NOT NULL UNIQUE)");
  assertUnsupported("ALTER TABLE t ADD UNIQUE (a)");
  assertUnsupported("ALTER TABLE t ADD CONSTRAINT ck CHECK (a > 0)");
  assertUnsupported("ALTER TABLE t ADD a INT UNIQUE");
  assertUnsupported("CREATE TABLE t (a INT GENERATED ALWAYS AS IDENTITY)");
  assertUnsupported("CREATE TABLE t (a INT AUTO_INCREMENT)");
  assertUnsupported("CREATE TABLE t (a INT IDENTITY)");
  assertUnsupported("CREATE TABLE t (a VARCHAR(10) COLLATE x)");
  for (const typeName of ["CLOB", "BLOB", "NCLOB", "JSON", "XML", "TEXT", "SERIAL", "CHARACTER LARGE OBJECT"]) {
    assertUnsupported(`CREATE TABLE t (a ${typeName})`, { line: 1, column: 19 });
  }
  for (const typeName of ["VARCHAR(0)", "VARCHAR(65536)", "NVARCHAR(65536)", "CHAR(2001)", "DECIMAL(0)", "DECIMAL(39)",
    "NUMERIC(10, 11)", "TIMESTAMP(7)", "BOOLEAN(1)"]) {
    assertSqlStateAt(`CREATE TABLE t (a ${typeName})`, "22023", { line: 1, column: 19 });
  }
});

test("ALTER TABLE : COLUMN 은 생략할 수 있다", () => {
  assert.deepEqual((parse("ALTER TABLE app.t ADD c INT") as ast.AlterTableStatement).name, name("T", "APP"));
  const added = alter("ALTER TABLE t ADD COLUMN c VARCHAR(10) DEFAULT 'x' NOT NULL");
  assert.equal(added.kind, "AddColumn");
  assert.equal(columnText((added as { column: ast.ColumnDefinition }).column), "C VARCHAR(10) DEFAULT 'x' NOT NULL");
  assert.deepEqual(alter("ALTER TABLE t ADD c VARCHAR(10) DEFAULT 'x' NOT NULL"), added);
  assert.equal(columnText((alter("ALTER TABLE t ADD c INT REFERENCES p (id) ON DELETE CASCADE") as { column: ast.ColumnDefinition }).column),
    "C INTEGER FK -> P(ID) ON DELETE CASCADE");

  assert.deepEqual(alter("ALTER TABLE t DROP COLUMN c"), { kind: "DropColumn", column: "C" });
  assert.deepEqual(alter("ALTER TABLE t DROP c"), { kind: "DropColumn", column: "C" });
  assert.deepEqual(alter("ALTER TABLE t DROP c RESTRICT"), { kind: "DropColumn", column: "C" });

  assert.deepEqual(alter("ALTER TABLE t ALTER COLUMN c SET DEFAULT 0"), {
    kind: "AlterColumn", column: "C", change: { kind: "SetDefault", expression: { kind: "Literal", type: "INTEGER", text: "0" } },
  });
  assert.deepEqual(alter("ALTER TABLE t ALTER c SET DEFAULT 0"), alter("ALTER TABLE t ALTER COLUMN c SET DEFAULT 0"));
  assert.deepEqual(alter("ALTER TABLE t ALTER c DROP DEFAULT"), { kind: "AlterColumn", column: "C", change: { kind: "DropDefault" } });
  assert.deepEqual(alter("ALTER TABLE t ALTER COLUMN c SET NOT NULL"), { kind: "AlterColumn", column: "C", change: { kind: "SetNotNull" } });
  assert.deepEqual(alter("ALTER TABLE t ALTER c DROP NOT NULL"), { kind: "AlterColumn", column: "C", change: { kind: "DropNotNull" } });

  assert.deepEqual(alter("ALTER TABLE t RENAME COLUMN c TO d"), { kind: "RenameColumn", column: "C", newName: "D" });
  assert.deepEqual(alter("ALTER TABLE t RENAME c TO d"), { kind: "RenameColumn", column: "C", newName: "D" });
  assert.deepEqual(alter("ALTER TABLE t RENAME TO u"), { kind: "RenameTable", newName: "U" });

  assert.deepEqual(alter("ALTER TABLE t ADD PRIMARY KEY (a, b)"), {
    kind: "AddConstraint", constraint: { kind: "PrimaryKey", name: null, columns: ["A", "B"] },
  });
  assert.deepEqual(alter("ALTER TABLE t ADD CONSTRAINT pk_t PRIMARY KEY (a)"), {
    kind: "AddConstraint", constraint: { kind: "PrimaryKey", name: "PK_T", columns: ["A"] },
  });
  assert.deepEqual(alter("ALTER TABLE t ADD CONSTRAINT fk1 FOREIGN KEY (p) REFERENCES parent (id) ON DELETE CASCADE"), {
    kind: "AddConstraint",
    constraint: {
      kind: "ForeignKey",
      name: "FK1",
      columns: ["P"],
      reference: { table: name("PARENT"), columns: ["ID"], onDelete: "CASCADE", onUpdate: null },
    },
  });
  assert.deepEqual(alter("ALTER TABLE t ADD FOREIGN KEY (p) REFERENCES parent"), {
    kind: "AddConstraint",
    constraint: {
      kind: "ForeignKey", name: null, columns: ["P"],
      reference: { table: name("PARENT"), columns: null, onDelete: null, onUpdate: null },
    },
  });
  assert.deepEqual(alter("ALTER TABLE t DROP CONSTRAINT fk1"), { kind: "DropConstraint", name: "FK1" });
});

test("ALTER TABLE : 컬럼 이름이 COLUMN 인 경우와 문법 오류", () => {
  assert.deepEqual(alter("ALTER TABLE t DROP column"), { kind: "DropColumn", column: "COLUMN" });
  assert.deepEqual(alter("ALTER TABLE t DROP COLUMN column"), { kind: "DropColumn", column: "COLUMN" });
  assert.deepEqual(alter("ALTER TABLE t RENAME COLUMN TO c"), { kind: "RenameColumn", column: "COLUMN", newName: "C" });
  assert.deepEqual(alter("ALTER TABLE t RENAME COLUMN column TO c"), { kind: "RenameColumn", column: "COLUMN", newName: "C" });
  assertSyntaxError("ALTER TABLE t", { line: 1, column: 14 }, /expected ADD, DROP, ALTER or RENAME/);
  assertSyntaxError("ALTER TABLE t ADD", { line: 1, column: 18 });
  assertSyntaxError("ALTER TABLE t ADD c", { line: 1, column: 20 });
  assertSyntaxError("ALTER TABLE t ADD c INT, ADD d INT", { line: 1, column: 24 });
  assertSyntaxError("ALTER TABLE t DROP");
  assertSyntaxError("ALTER TABLE t DROP CONSTRAINT");
  assertSyntaxError("ALTER TABLE t ALTER c");
  assertSyntaxError("ALTER TABLE t ALTER c SET");
  assertSyntaxError("ALTER TABLE t ALTER c SET NULL");
  assertSyntaxError("ALTER TABLE t ALTER c DROP");
  assertSyntaxError("ALTER TABLE t RENAME c d");
  assertSyntaxError("ALTER TABLE t RENAME TO app.u");
  assertSyntaxError("ALTER TABLE t RENAME TO");
  // 컬럼 타입 변경은 초기 버전에서 지원하지 않는다. (상세 16)
  assertUnsupported("ALTER TABLE t ALTER COLUMN c TYPE BIGINT");
  assertUnsupported("ALTER TABLE t ALTER c SET DATA TYPE BIGINT");
  assertUnsupported("ALTER TABLE t MODIFY c BIGINT");
  assertUnsupported("ALTER TABLE t DROP COLUMN c CASCADE");
  assertUnsupported("ALTER TABLE t DROP PRIMARY KEY");
});

test("DROP TABLE, DROP VIEW, TRUNCATE", () => {
  assert.deepEqual(parse("DROP TABLE t"), { kind: "DropTable", name: name("T"), ifExists: false, behavior: null });
  assert.deepEqual(parse("DROP TABLE IF EXISTS app.t CASCADE"), {
    kind: "DropTable", name: name("T", "APP"), ifExists: true, behavior: "CASCADE",
  });
  assert.deepEqual(parse("DROP TABLE t RESTRICT"), { kind: "DropTable", name: name("T"), ifExists: false, behavior: "RESTRICT" });
  assert.deepEqual(parse("DROP VIEW v"), { kind: "DropView", name: name("V"), ifExists: false, behavior: null });
  assert.deepEqual(parse("DROP VIEW IF EXISTS app.v CASCADE"), {
    kind: "DropView", name: name("V", "APP"), ifExists: true, behavior: "CASCADE",
  });
  // IF 가 테이블 이름인 경우
  assert.deepEqual(parse("DROP TABLE if"), { kind: "DropTable", name: name("IF"), ifExists: false, behavior: null });
  // TRUNCATE 의 TABLE 은 생략할 수 있다.
  assert.deepEqual(parse("TRUNCATE TABLE app.t"), { kind: "TruncateTable", name: name("T", "APP") });
  assert.deepEqual(parse("TRUNCATE t"), { kind: "TruncateTable", name: name("T") });
  assertSyntaxError("DROP TABLE", { line: 1, column: 11 });
  assertSyntaxError("DROP TABLE a, b", { line: 1, column: 13 });
  assertSyntaxError("DROP TABLE t CASCADE RESTRICT");
  assertSyntaxError("DROP TABLE IF NOT EXISTS t");
  assertSyntaxError("TRUNCATE", { line: 1, column: 9 });
  assertSyntaxError("TRUNCATE TABLE");
  assertSyntaxError("TRUNCATE t CASCADE");
});

test("CREATE VIEW : 질의의 원문을 함께 남긴다", () => {
  const view = parse("CREATE VIEW v AS SELECT a, b FROM t WHERE a > 0") as ast.CreateViewStatement;
  assert.equal(view.kind, "CreateView");
  assert.deepEqual(view.name, name("V"));
  assert.equal(view.orReplace, false);
  assert.equal(view.columns, null);
  assert.equal(renderQuery(view.query), "{SELECT A, B FROM T WHERE (> A 0)}");
  assert.equal(view.queryText, "SELECT a, b FROM t WHERE a > 0");

  const replaced = parse("create or replace view app.v (x, y) as\n  select a, b -- 주석\n  from t\n  order by 1 ;  ") as ast.CreateViewStatement;
  assert.equal(replaced.orReplace, true);
  assert.deepEqual(replaced.name, name("V", "APP"));
  assert.deepEqual(replaced.columns, ["X", "Y"]);
  assert.equal(replaced.queryText, "select a, b -- 주석\n  from t\n  order by 1");
  // 남긴 원문을 다시 구문 분석하면 같은 질의가 된다.
  assert.deepEqual(parse(replaced.queryText), replaced.query);

  const union = parse("CREATE VIEW v AS (SELECT 1 UNION SELECT 2)") as ast.CreateViewStatement;
  assert.equal(union.queryText, "(SELECT 1 UNION SELECT 2)");
  assert.equal(renderQuery(union.query), "{(UNION SELECT 1 SELECT 2)}");

  assertSyntaxError("CREATE VIEW v", { line: 1, column: 14 });
  assertSyntaxError("CREATE VIEW v AS", { line: 1, column: 17 });
  assertSyntaxError("CREATE VIEW v SELECT 1");
  assertSyntaxError("CREATE VIEW v () AS SELECT 1");
  assertSyntaxError("CREATE VIEW v AS INSERT INTO t VALUES (1)");
  assertSyntaxError("CREATE OR VIEW v AS SELECT 1");
  assertSyntaxError("CREATE OR REPLACE TABLE t (a INT)");
  assertSyntaxError("CREATE VIEW v AS SELECT ? FROM t", { line: 1, column: 18 }, /Parameters cannot be used in a view definition/);
  // 뷰의 WITH CHECK OPTION 과 구체화 뷰는 지원하지 않는다. (상세 16)
  assertUnsupported("CREATE VIEW v AS SELECT a FROM t WITH CHECK OPTION", { line: 1, column: 34 });
  assertUnsupported("CREATE MATERIALIZED VIEW v AS SELECT 1");
  assertUnsupported("CREATE VIEW v AS WITH x AS (SELECT 1) SELECT * FROM x");
});

test("CREATE INDEX : 이름과 ASC 는 생략할 수 있다", () => {
  assert.deepEqual(parse("CREATE INDEX ix_t ON t (a)"), {
    kind: "CreateIndex", name: name("IX_T"), table: name("T"), columns: [{ name: "A", descending: false }],
  });
  assert.deepEqual(parse("CREATE INDEX ON app.t (a ASC, b DESC, c)"), {
    kind: "CreateIndex",
    name: null,
    table: name("T", "APP"),
    columns: [{ name: "A", descending: false }, { name: "B", descending: true }, { name: "C", descending: false }],
  });
  assert.deepEqual((parse("CREATE INDEX app.ix ON app.t (a)") as ast.CreateIndexStatement).name, name("IX", "APP"));
  assert.deepEqual((parse('CREATE INDEX "on" ON t ("desc" DESC)') as ast.CreateIndexStatement), {
    kind: "CreateIndex", name: name("on"), table: name("T"), columns: [{ name: "desc", descending: true }],
  });
  assert.deepEqual(parse("DROP INDEX ix_t"), { kind: "DropIndex", name: name("IX_T") });
  assert.deepEqual(parse("DROP INDEX app.ix_t"), { kind: "DropIndex", name: name("IX_T", "APP") });
  assertSyntaxError("CREATE INDEX", { line: 1, column: 13 });
  assertSyntaxError("CREATE INDEX ix", { line: 1, column: 16 });
  assertSyntaxError("CREATE INDEX ix ON t", { line: 1, column: 21 });
  assertSyntaxError("CREATE INDEX ix ON t ()", { line: 1, column: 23 });
  assertSyntaxError("CREATE INDEX ix ON t (a,)");
  assertSyntaxError("CREATE INDEX ix ON t (a DESC ASC)");
  assertSyntaxError("CREATE INDEX ix t (a)");
  assertSyntaxError("DROP INDEX");
  assertSyntaxError("DROP INDEX ix ON t");
  // 유일 인덱스는 PK 로만 만들 수 있고, 기본 형태의 인덱스만 지원한다. (상세 10)
  assertUnsupported("CREATE UNIQUE INDEX ix ON t (a)", { line: 1, column: 8 }, /CREATE UNIQUE INDEX is not supported/);
  assertUnsupported("CREATE INDEX ix ON t (UPPER(a))");
  assertUnsupported("CREATE INDEX ix ON t ((a + b))");
  assertUnsupported("CREATE INDEX ix ON t (a + 1)");
  assertUnsupported("CREATE INDEX ix ON t (a) WHERE a > 0");
  assertUnsupported("CREATE INDEX ix ON t USING HASH (a)");
  assertUnsupported("CREATE INDEX ix ON t (a NULLS FIRST)");
  assertUnsupported("CREATE BITMAP INDEX ix ON t (a)");
});
