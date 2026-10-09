/**
 * 담당 : 파서의 견고성. 어떤 입력을 받아도 구문 트리를 돌려주거나 위치를 가진 DbError 를 내야 한다.
 *        (TypeError, RangeError 같은 그 밖의 예외나 끝나지 않는 처리가 있어서는 안 된다)
 * 관련 사양 : AGENTS.md 상세 0.
 * 구현 단계 : 4단계.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DbError } from "../../src/common/errors.js";
import { tokenize } from "../../src/sql/lexer.js";
import { parseStatement } from "../../src/sql/parser.js";
import { createRandom } from "../types/helpers.js";

/** 파서가 낼 수 있는 SQLSTATE : 문법 오류, 미지원, 타입 인자, 식별자 길이, 처리 한도 */
const EXPECTED_STATES = new Set(["42601", "0A000", "22023", "42622", "54001"]);

const VALID_STATEMENTS = [
  "SELECT 'Hello World'",
  "SELECT a, b AS x, t.*, COUNT(*) FROM app.t x LEFT JOIN u ON x.id = u.id WHERE a BETWEEN 1 AND 2 OR b NOT IN (1, 2) GROUP BY a HAVING SUM(b) > 0 ORDER BY 1 DESC NULLS LAST OFFSET 1 ROW FETCH FIRST 5 ROWS ONLY FOR UPDATE",
  "SELECT CASE a WHEN 1 THEN 'x' ELSE NULL END, CAST(b AS DECIMAL(10, 2)), TRIM(BOTH ' ' FROM c), EXTRACT(YEAR FROM d), SUBSTRING(e FROM 1 FOR 2), POSITION('a' IN f), INTERVAL '1-2' YEAR TO MONTH, DATE '2026-01-01', X'0A', ?",
  "SELECT * FROM ((SELECT 1) UNION ALL (SELECT 2)) x WHERE EXISTS (SELECT 1) AND a = ANY (SELECT b FROM t) AND ((SELECT 1) + 1) > 0",
  "(SELECT a FROM t ORDER BY a LIMIT 1) INTERSECT SELECT b FROM u EXCEPT SELECT c FROM v",
  "INSERT INTO t (a, b) VALUES (1, DEFAULT), (?, 'x' || 'y')",
  "INSERT t SELECT * FROM u",
  "UPDATE t x SET a = a + 1, b = DEFAULT WHERE id IN (SELECT id FROM u)",
  "DELETE FROM t WHERE a IS NOT NULL AND b LIKE 'x%' ESCAPE '!'",
  "CREATE TABLE IF NOT EXISTS app.t (id INT PRIMARY KEY, name VARCHAR(10) DEFAULT 'x' NOT NULL, ref INT CONSTRAINT fk REFERENCES p (id) ON DELETE CASCADE ON UPDATE SET NULL, ts TIMESTAMP(3) WITH TIME ZONE, iv INTERVAL DAY(3) TO SECOND(2), CONSTRAINT pk PRIMARY KEY (id), FOREIGN KEY (ref) REFERENCES p)",
  "ALTER TABLE t ADD COLUMN c NUMERIC(10, 2) DEFAULT 0",
  "ALTER TABLE t ALTER COLUMN c SET NOT NULL",
  "ALTER TABLE t RENAME COLUMN c TO d",
  "ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a, b) REFERENCES p (x, y)",
  "DROP TABLE IF EXISTS t CASCADE",
  "TRUNCATE TABLE t",
  "CREATE OR REPLACE VIEW v (a, b) AS SELECT 1, 2 FROM t",
  "CREATE INDEX ix ON t (a ASC, b DESC)",
  "CREATE TABLESPACE app DATAFILE './app.hwdb' CHARACTER SET UTF8",
  "DROP TABLESPACE app INCLUDING CONTENTS",
  "CREATE USER u IDENTIFIED BY 'pw' DEFAULT TABLESPACE app",
  "ALTER USER u IDENTIFIED BY 'pw2'",
  "GRANT SELECT, UPDATE ON TABLESPACE app TO u1, u2",
  "REVOKE ALL PRIVILEGES ON VIEW app.v FROM u",
  "GRANT CONNECT, DBA TO u",
  "START TRANSACTION ISOLATION LEVEL READ COMMITTED",
  "ROLLBACK TO SAVEPOINT sp",
  "SET TIME ZONE INTERVAL '+09:00' HOUR TO MINUTE",
  "SET AUTOCOMMIT OFF",
  "USE app",
];

/** 문장을 망가뜨릴 때 끼워 넣는 조각. 키워드, 구두점, 리터럴과 어휘 분석 단계에서 걸리는 것들을 섞는다. */
const FRAGMENTS = [
  "SELECT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "ORDER", "UNION", "ALL", "INTERSECT", "EXCEPT", "JOIN", "LEFT", "ON",
  "USING", "AS", "AND", "OR", "NOT", "NULL", "IS", "IN", "BETWEEN", "LIKE", "ESCAPE", "EXISTS", "ANY", "CASE", "WHEN", "THEN",
  "ELSE", "END", "CAST", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "ALTER", "DROP", "TABLE", "VIEW",
  "INDEX", "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "CONSTRAINT", "DEFAULT", "UNIQUE", "CHECK", "GRANT", "REVOKE", "TO",
  "WITH", "TIME", "ZONE", "INTERVAL", "DATE", "TIMESTAMP", "YEAR", "SECOND", "LIMIT", "OFFSET", "FETCH", "FIRST", "ROWS",
  "ONLY", "FOR", "DISTINCT", "COUNT", "TRIM", "EXTRACT", "SUBSTRING", "POSITION", "OVER", "VARCHAR", "DECIMAL", "INT",
  "TABLESPACE", "USER", "IDENTIFIED", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "CASCADE", "IF", "COLUMN", "RENAME",
  "a", "t", "x1", '"Q q"', "'s'", "''", "N'n'", "X'0A'", "1", "2.5", "1e3", "?", "(", ")", "(", ")", ",", ".", ";", "*", "+", "-",
  "/", "=", "<>", "!=", "<", "<=", ">", ">=", "||", "-- c\n", "/* c */", "\n", "한글", "'열린 문자열", '"열린 이름', "/* 열린 주석",
  "X'0'", "1x", "@", "%", "😀", "\u0000", "A".repeat(129), "9".repeat(60),
];

function check(sql: string): void {
  try {
    const parsed = parseStatement(sql);
    assert.equal(typeof parsed.statement.kind, "string");
    assert.ok(Number.isInteger(parsed.parameterCount) && parsed.parameterCount >= 0);
  } catch (error) {
    assert.ok(error instanceof DbError, `DbError expected but got ${String(error)}\nSQL: ${JSON.stringify(sql)}`);
    assert.ok(EXPECTED_STATES.has(error.sqlState), `Unexpected SQLSTATE ${error.sqlState}: ${error.message}\nSQL: ${JSON.stringify(sql)}`);
    const position = error.position;
    assert.ok(position !== undefined, `Position expected: ${error.message}\nSQL: ${JSON.stringify(sql)}`);
    assert.ok(position.offset >= 0 && position.offset <= sql.length && position.line >= 1 && position.column >= 1,
      `Invalid position ${JSON.stringify(position)}\nSQL: ${JSON.stringify(sql)}`);
  }
}

test("바탕이 되는 문장은 모두 올바른 문장이다", () => {
  for (const sql of VALID_STATEMENTS) {
    assert.equal(typeof parseStatement(sql).statement.kind, "string", sql);
  }
});

test("올바른 문장의 토큰을 빼거나 바꾸거나 끼워 넣어도 DbError 이외의 예외는 나지 않는다", () => {
  const random = createRandom(4);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  for (const base of VALID_STATEMENTS) {
    // 원문을 토큰 단위의 조각으로 나눈다.
    const tokens = tokenize(base).slice(0, -1);
    const pieces = tokens.map((token) => base.slice(token.position.offset, token.end));
    // 앞에서부터 자른 것 : 문장이 중간에 끝나는 모든 경우
    for (let length = 0; length <= pieces.length; length++) check(pieces.slice(0, length).join(" "));
    // 토큰 하나를 뺀 것
    for (let index = 0; index < pieces.length; index++) check(pieces.filter((_, i) => i !== index).join(" "));
    // 무작위로 바꾸고 끼워 넣고 서로 맞바꾼 것
    for (let round = 0; round < 150; round++) {
      const mutated = [...pieces];
      const edits = 1 + Math.floor(random() * 3);
      for (let edit = 0; edit < edits; edit++) {
        const index = Math.floor(random() * (mutated.length + 1));
        const action = random();
        if (action < 0.35) mutated.splice(index, 1, pick(FRAGMENTS));
        else if (action < 0.7) mutated.splice(index, 0, pick(FRAGMENTS));
        else if (action < 0.85) mutated.splice(index, 1);
        else {
          const other = Math.floor(random() * mutated.length);
          const moved = mutated[other] ?? "";
          mutated[other] = mutated[index] ?? "";
          mutated[index] = moved;
        }
      }
      check(mutated.join(random() < 0.9 ? " " : ""));
    }
  }
});

test("조각을 아무렇게나 이어 붙인 입력에도 DbError 이외의 예외는 나지 않는다", () => {
  const random = createRandom(2026);
  const starters = ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP", "GRANT", "REVOKE", "SET", "(", ""];
  for (let round = 0; round < 6_000; round++) {
    const length = 1 + Math.floor(random() * 14);
    const parts = [starters[Math.floor(random() * starters.length)] as string];
    for (let i = 0; i < length; i++) parts.push(FRAGMENTS[Math.floor(random() * FRAGMENTS.length)] as string);
    check(parts.join(" "));
  }
});

test("글자 단위로 자르거나 망가뜨린 입력에도 DbError 이외의 예외는 나지 않는다", () => {
  const random = createRandom(77);
  const noise = ["'", '"', "(", ")", "\\", "\n", "\r", "\t", "\u0000", "\ud83d", "﻿", ";", "--", "/*", "*/", "e", ".", "0"];
  for (const base of VALID_STATEMENTS) {
    for (let length = 0; length <= base.length; length += 1 + Math.floor(random() * 3)) check(base.slice(0, length));
    for (let round = 0; round < 60; round++) {
      const at = Math.floor(random() * (base.length + 1));
      const inserted = noise[Math.floor(random() * noise.length)] as string;
      check(base.slice(0, at) + inserted + base.slice(at + (random() < 0.5 ? 0 : 1)));
    }
  }
});
