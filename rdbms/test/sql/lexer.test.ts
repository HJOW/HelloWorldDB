/**
 * 담당 : 어휘 분석. 식별자와 리터럴의 규칙, 주석, 토큰의 위치, 잘못된 입력.
 * 관련 사양 : AGENTS.md 상세 0.
 * 구현 단계 : 4단계.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DbError, ERROR_CODES } from "../../src/common/errors.js";
import { MAX_IDENTIFIER_LENGTH, tokenize } from "../../src/sql/lexer.js";
import type { Token } from "../../src/sql/lexer.js";

/** 토큰을 `종류:내용` 으로 적는다. 끝 토큰은 뺀다. */
function kinds(sql: string): string[] {
  return tokenize(sql).slice(0, -1).map((token) => `${token.kind}:${token.text}`);
}

function assertLexError(sql: string, sqlState: string, line: number, column: number): void {
  assert.throws(() => tokenize(sql), (error) => {
    assert.ok(error instanceof DbError, String(error));
    assert.equal(error.sqlState, sqlState, error.message);
    assert.deepEqual({ line: error.position?.line, column: error.position?.column }, { line, column }, error.message);
    assert.match(error.message, new RegExp(`\\(line ${line}, column ${column}\\)\\.$`));
    return true;
  });
}

test("따옴표 없는 식별자는 대문자로 바꾸고, 큰따옴표로 감싼 식별자는 그대로 둔다", () => {
  assert.deepEqual(kinds('select Hello, "Hello", "sel ect", _a1$'), [
    "WORD:SELECT", "WORD:HELLO", "SYMBOL:,", "QUOTED:Hello", "SYMBOL:,", "QUOTED:sel ect", "SYMBOL:,", "WORD:_A1$",
  ]);
  // 큰따옴표 안의 큰따옴표는 두 번 적는다.
  assert.deepEqual(kinds('"a""b" """"'), ['QUOTED:a"b', 'QUOTED:"']);
  // 문자는 유니코드 문자 전체이다.
  assert.deepEqual(kinds("회원 이름_2 straße"), ["WORD:회원", "WORD:이름_2", "WORD:STRASSE"]);
  // 숫자나 $ 로 시작할 수는 없다.
  assertLexError("SELECT $a", "42601", 1, 8);
  assertLexError("SELECT 1a", "42601", 1, 8);
});

test("식별자는 최대 128자이다", () => {
  const longest = "A".repeat(MAX_IDENTIFIER_LENGTH);
  assert.deepEqual(kinds(longest), [`WORD:${longest}`]);
  assert.deepEqual(kinds(`"${longest}"`), [`QUOTED:${longest}`]);
  // 길이는 코드 포인트로 센다.
  const wide = "가".repeat(MAX_IDENTIFIER_LENGTH);
  assert.deepEqual(kinds(wide), [`WORD:${wide}`]);
  const emoji = "😀".repeat(MAX_IDENTIFIER_LENGTH);
  assert.deepEqual(kinds(`"${emoji}"`), [`QUOTED:${emoji}`]);

  for (const sql of [`${longest}A`, `"${longest}A"`, `SELECT 1 FROM "${emoji}😀"`]) {
    assert.throws(() => tokenize(sql), (error) =>
      error instanceof DbError && error.sqlState === "42622" && error.code === ERROR_CODES.IDENTIFIER_TOO_LONG
      && error.position !== undefined);
  }
  assertLexError('SELECT ""', "42601", 1, 8);
});

test("문자열 리터럴은 작은따옴표로 감싸고 안의 작은따옴표는 두 번 적는다", () => {
  assert.deepEqual(kinds("'Hello World'"), ["STRING:Hello World"]);
  assert.deepEqual(kinds("'It''s' '' ''''"), ["STRING:It's", "STRING:", "STRING:'"]);
  assert.deepEqual(kinds("'한글 😀'"), ["STRING:한글 😀"]);
  assert.deepEqual(kinds("'a\nb'"), ["STRING:a\nb"]);
  // 문자열 안의 주석 표시와 세미콜론은 내용이다.
  assert.deepEqual(kinds("'-- x' '/* y */' ';'"), ["STRING:-- x", "STRING:/* y */", "STRING:;"]);
  // N'...' 은 같은 문자열이다. 대소문자는 가리지 않는다.
  assert.deepEqual(kinds("N'국문' n'a'"), ["STRING:국문", "STRING:a"]);
  // 식별자 뒤에 붙은 따옴표는 별개의 토큰이다.
  assert.deepEqual(kinds("COLN'a'"), ["WORD:COLN", "STRING:a"]);
  assertLexError("SELECT 'abc", "42601", 1, 8);
  assertLexError("SELECT\n  'abc''", "42601", 2, 3);
  assertLexError('SELECT "abc', "42601", 1, 8);
});

test("이진 리터럴은 X'...' 이며 짝수 개의 16진 숫자여야 한다", () => {
  assert.deepEqual(kinds("X'0a0B' x'' X'FF'"), ["HEX:0A0B", "HEX:", "HEX:FF"]);
  assertLexError("SELECT X'0A0'", "42601", 1, 8);
  assertLexError("SELECT X'0G'", "42601", 1, 8);
  assertLexError("SELECT X'0A 0B'", "42601", 1, 8);
  assertLexError("SELECT X'0A", "42601", 1, 8);
});

test("수 리터럴은 정수, 소수, 지수 표기로 나눈다", () => {
  const numbers = (sql: string): string[] =>
    tokenize(sql).slice(0, -1).map((token) => `${token.text}:${token.numberKind ?? token.kind}`);
  assert.deepEqual(numbers("0 123 0123"), ["0:INTEGER", "123:INTEGER", "0123:INTEGER"]);
  assert.deepEqual(numbers("1.5 .5 5. 0.0"), ["1.5:DECIMAL", ".5:DECIMAL", "5.:DECIMAL", "0.0:DECIMAL"]);
  assert.deepEqual(numbers("1e3 1.5E-3 2e+10 .5e1 1.e2"), ["1e3:FLOAT", "1.5E-3:FLOAT", "2e+10:FLOAT", ".5e1:FLOAT", "1.e2:FLOAT"]);
  // 부호는 리터럴의 일부가 아니다.
  assert.deepEqual(numbers("-1"), ["-:SYMBOL", "1:INTEGER"]);
  assert.deepEqual(numbers("1-2"), ["1:INTEGER", "-:SYMBOL", "2:INTEGER"]);
  assert.deepEqual(numbers("t1.c2"), ["T1:WORD", ".:SYMBOL", "C2:WORD"]);
  for (const sql of ["1e", "1e+", "1.5ex", "12abc", "1_000", "0x10"]) {
    assertLexError(`SELECT ${sql}`, "42601", 1, 8);
  }
});

test("연산자, 구두점, 파라미터", () => {
  assert.deepEqual(kinds("a<>b!=c<=d>=e<f>g=h||i"), [
    "WORD:A", "SYMBOL:<>", "WORD:B", "SYMBOL:!=", "WORD:C", "SYMBOL:<=", "WORD:D", "SYMBOL:>=", "WORD:E",
    "SYMBOL:<", "WORD:F", "SYMBOL:>", "WORD:G", "SYMBOL:=", "WORD:H", "SYMBOL:||", "WORD:I",
  ]);
  assert.deepEqual(kinds("(a.b,*)+-/;?"), [
    "SYMBOL:(", "WORD:A", "SYMBOL:.", "WORD:B", "SYMBOL:,", "SYMBOL:*", "SYMBOL:)", "SYMBOL:+", "SYMBOL:-",
    "SYMBOL:/", "SYMBOL:;", "PARAMETER:?",
  ]);
  for (const character of ["%", "^", "&", "|", "~", ":", "[", "{", "@", "#", "`", "\\", "!"]) {
    assertLexError(`SELECT ${character}`, "42601", 1, 8);
  }
});

test("주석과 공백을 건너뛴다", () => {
  assert.deepEqual(kinds("SELECT -- 한 줄 주석\n 1"), ["WORD:SELECT", "NUMBER:1"]);
  assert.deepEqual(kinds("SELECT /* 여러 줄\n 주석 */ 1 /**/ + /* -- */ 2"), [
    "WORD:SELECT", "NUMBER:1", "SYMBOL:+", "NUMBER:2",
  ]);
  assert.deepEqual(kinds("SELECT 1 -- 끝의 주석"), ["WORD:SELECT", "NUMBER:1"]);
  assert.deepEqual(kinds("SELECT 1 - -1"), ["WORD:SELECT", "NUMBER:1", "SYMBOL:-", "SYMBOL:-", "NUMBER:1"]);
  assert.deepEqual(kinds("﻿\tSELECT\r\n 1"), ["WORD:SELECT", "NUMBER:1"]);
  assert.deepEqual(kinds(""), []);
  assert.deepEqual(kinds("  -- 주석만\n/* 있다 */ "), []);
  // 여러 줄 주석은 겹치지 않는다. 처음 만난 닫는 표시에서 끝난다.
  assert.deepEqual(kinds("/* a /* b */ 1"), ["NUMBER:1"]);
  assertLexError("SELECT 1 /* 닫지 않음", "42601", 1, 10);
});

test("토큰마다 줄과 칸을 기록한다", () => {
  const tokens = tokenize("SELECT a,\n       'x\ny' AS b\r\nFROM t -- c\n;");
  const at = (token: Token): string => `${token.text.replace("\n", "\\n")}@${token.position.line}:${token.position.column}`;
  assert.deepEqual(tokens.map(at), [
    "SELECT@1:1", "A@1:8", ",@1:9", "x\\ny@2:8", "AS@3:4", "B@3:7", "FROM@4:1", "T@4:6", ";@5:1", "@5:2",
  ]);
  // offset 과 end 로 원문을 잘라낼 수 있다.
  const sql = 'SELECT "Na me", N\'값\' FROM t';
  const slices = tokenize(sql).slice(0, -1).map((token) => sql.slice(token.position.offset, token.end));
  assert.deepEqual(slices, ["SELECT", '"Na me"', ",", "N'값'", "FROM", "t"]);
  // 캐리지 리턴만으로도 줄이 바뀐다.
  assert.deepEqual(tokenize("a\rb").map(at), ["A@1:1", "B@2:1", "@2:2"]);
  const end = tokenize("SELECT 1").at(-1) as Token;
  assert.equal(end.kind, "END");
  assert.deepEqual(end.position, { offset: 8, line: 1, column: 9 });
});
