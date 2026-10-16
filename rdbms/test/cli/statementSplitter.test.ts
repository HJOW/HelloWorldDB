/**
 * SQL 문장 나누기 테스트 (10단계). 문자열·식별자·주석 안의 `;`, 줄·칸 위치, 끝나지 않은 입력을 본다.
 * 관련 사양 : AGENTS.md 상세 14-2
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { splitScript, splitStatements } from "../../src/cli/statementSplitter.js";

const texts = (input: string): string[] => splitStatements(input).statements.map((statement) => statement.text);

test("`;` 로 문장을 나누고 `;` 는 문장에 넣지 않는다", () => {
  assert.deepEqual(texts("SELECT 1; SELECT 2;"), ["SELECT 1", "SELECT 2"]);
  assert.deepEqual(texts("  SELECT 1  ;\n\nSELECT 2\n;"), ["SELECT 1", "SELECT 2"]);
});

test("마지막 `;` 뒤의 나머지는 끝나지 않은 입력이다", () => {
  const result = splitStatements("SELECT 1; SELECT 2");
  assert.deepEqual(result.statements.map((s) => s.text), ["SELECT 1"]);
  assert.equal(result.rest, " SELECT 2");
  assert.equal(result.restPending, true);
});

test("공백과 주석만 있는 나머지는 끝나지 않은 입력이 아니다", () => {
  for (const tail of ["", "   ", "\n\n", "-- note", "/* a */", " -- a\n /* b */ "]) {
    const result = splitStatements(`SELECT 1;${tail}`);
    assert.equal(result.restPending, false, JSON.stringify(tail));
    assert.deepEqual(result.statements.map((s) => s.text), ["SELECT 1"]);
  }
});

test("문자열 리터럴 안의 `;` 는 문장의 끝이 아니다", () => {
  assert.deepEqual(texts("SELECT 'a;b'; SELECT 2;"), ["SELECT 'a;b'", "SELECT 2"]);
  assert.deepEqual(texts("SELECT 'it''s; ok'; SELECT 2;"), ["SELECT 'it''s; ok'", "SELECT 2"], "작은따옴표 두 개는 따옴표 하나이다");
  assert.deepEqual(texts("SELECT N'한;글'; SELECT 2;"), ["SELECT N'한;글'", "SELECT 2"]);
  assert.deepEqual(texts("SELECT X'AB'; SELECT 2;"), ["SELECT X'AB'", "SELECT 2"]);
  assert.deepEqual(texts("SELECT 'multi\nline;\nstring'; SELECT 2;"), ["SELECT 'multi\nline;\nstring'", "SELECT 2"]);
});

test("큰따옴표 식별자 안의 `;` 는 문장의 끝이 아니다", () => {
  assert.deepEqual(texts('SELECT 1 AS "a;b"; SELECT 2;'), ['SELECT 1 AS "a;b"', "SELECT 2"]);
  assert.deepEqual(texts('SELECT 1 AS "a""b;c"; SELECT 2;'), ['SELECT 1 AS "a""b;c"', "SELECT 2"]);
  assert.deepEqual(texts("SELECT \"it's\"; SELECT 2;"), ["SELECT \"it's\"", "SELECT 2"], "큰따옴표 안의 작은따옴표는 문자일 뿐이다");
  assert.deepEqual(texts("SELECT 'say \"hi;\"'; SELECT 2;"), ["SELECT 'say \"hi;\"'", "SELECT 2"], "작은따옴표 안의 큰따옴표도 문자일 뿐이다");
});

test("한 줄 주석 안의 `;` 는 문장의 끝이 아니고 줄 끝에서 주석이 끝난다", () => {
  assert.deepEqual(texts("SELECT 1 -- a;b\n; SELECT 2;"), ["SELECT 1 -- a;b", "SELECT 2"]);
  assert.deepEqual(texts("SELECT 1 -- ' unbalanced\n; SELECT 2;"), ["SELECT 1 -- ' unbalanced", "SELECT 2"], "주석 안의 따옴표는 따옴표가 아니다");
  assert.deepEqual(texts("SELECT 1 -- a\r\n; SELECT 2;"), ["SELECT 1 -- a", "SELECT 2"]);
});

test("여러 줄 주석 안의 `;` 는 문장의 끝이 아니다", () => {
  assert.deepEqual(texts("SELECT /* a;\nb */ 1; SELECT 2;"), ["SELECT /* a;\nb */ 1", "SELECT 2"]);
  assert.deepEqual(texts("SELECT 1 /* ' */; SELECT 2;"), ["SELECT 1 /* ' */", "SELECT 2"]);
  // 중첩하지 않는다 : 첫 `*/` 에서 끝난다 (SQL 어휘 분석과 같다).
  assert.deepEqual(texts("SELECT /* a /* b */ 1; SELECT 2;"), ["SELECT /* a /* b */ 1", "SELECT 2"]);
});

test("주석만 있는 조각은 문장이 아니다", () => {
  assert.deepEqual(texts("-- header\n; SELECT 1;"), ["SELECT 1"]);
  assert.deepEqual(texts("/* x */; ; ;;"), []);
  assert.deepEqual(texts(";;;"), []);
});

test("문장 앞의 주석은 그대로 두고 앞뒤 공백만 뗀다", () => {
  assert.deepEqual(texts("\n\n  -- header\n  SELECT 1  ;"), ["-- header\n  SELECT 1"]);
});

test("닫히지 않은 따옴표나 주석은 끝나지 않은 입력이다", () => {
  for (const open of ["SELECT 'abc;", 'SELECT "abc;', "SELECT /* abc;"]) {
    const result = splitStatements(`SELECT 1; ${open}`);
    assert.deepEqual(result.statements.map((s) => s.text), ["SELECT 1"], open);
    assert.equal(result.restPending, true, open);
    assert.equal(result.rest, ` ${open}`, open);
  }
  // 줄을 더 받아 닫으면 문장이 된다.
  assert.deepEqual(texts("SELECT 'abc;\ndef';"), ["SELECT 'abc;\ndef'"]);
});

test("문장마다 시작하는 줄과 칸을 알려 준다", () => {
  const result = splitStatements("SELECT 1;\n\n  SELECT 2;  SELECT 3;\n-- c\n\tSELECT 4");
  assert.deepEqual(
    result.statements.map((s) => [s.text, s.line, s.column]),
    [
      ["SELECT 1", 1, 1],
      ["SELECT 2", 3, 3],
      ["SELECT 3", 3, 14],
    ],
  );
  assert.equal(result.restPending, true);
  assert.equal(result.restLine, 3);
});

test("앞에 주석이 붙은 문장은 주석이 시작하는 줄이 문장의 시작이다", () => {
  const result = splitStatements("SELECT 1;\n-- why\nSELECT 2;");
  assert.deepEqual(result.statements.map((s) => [s.text, s.line, s.column]), [["SELECT 1", 1, 1], ["-- why\nSELECT 2", 2, 1]]);
});

test("줄바꿈은 \\n, \\r\\n, \\r 모두 한 줄로 센다", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const result = splitStatements(`SELECT 1;${newline}${newline}SELECT 2;`);
    assert.deepEqual(result.statements.map((s) => [s.line, s.column]), [[1, 1], [3, 1]], JSON.stringify(newline));
  }
});

test("시작 줄을 줄 수 있다", () => {
  const result = splitStatements("SELECT 1;\nSELECT 2;", 10);
  assert.deepEqual(result.statements.map((s) => s.line), [10, 11]);
});

test("splitScript 는 끝에 `;` 가 없는 마지막 문장도 문장으로 센다", () => {
  assert.deepEqual(splitScript("SELECT 1; SELECT 2").map((s) => s.text), ["SELECT 1", "SELECT 2"]);
  assert.deepEqual(splitScript("SELECT 1;\n  -- tail").map((s) => s.text), ["SELECT 1"]);
  assert.deepEqual(splitScript("").map((s) => s.text), []);
  assert.deepEqual(splitScript("   \n  ").map((s) => s.text), []);
  // 닫히지 않은 따옴표는 그대로 서버에 보내 구문 오류를 받는다.
  assert.deepEqual(splitScript("SELECT 1; SELECT 'abc").map((s) => s.text), ["SELECT 1", "SELECT 'abc"]);
  const last = splitScript("SELECT 1;\n\n   SELECT 2").at(-1);
  assert.deepEqual([last?.line, last?.column], [3, 4]);
});

test("큰 입력도 선형 시간에 나눈다", () => {
  const statements = Array.from({ length: 50_000 }, (_, index) => `INSERT INTO T VALUES (${index}, 'a;b');`);
  const started = performance.now();
  const result = splitStatements(statements.join("\n"));
  const elapsed = performance.now() - started;
  assert.equal(result.statements.length, 50_000);
  assert.equal(result.statements[49_999]?.line, 50_000);
  assert.ok(elapsed < 3000, `too slow: ${elapsed} ms`);
});
