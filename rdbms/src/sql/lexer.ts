/**
 * 어휘 분석.
 *
 * 담당
 *  - SQL 문장을 토큰으로 나눈다 : 키워드, 식별자, 리터럴, 연산자, 구두점, 파라미터 `?`
 *  - 식별자 규칙 : 따옴표 없는 식별자는 대문자로 바꾸고, 큰따옴표로 감싼 식별자는 그대로 둔다.
 *  - 문자열 리터럴 : 작은따옴표로 감싸며 안의 작은따옴표는 '' 로 적는다. 이진 리터럴은 X'...'
 *  - 주석 건너뛰기 : `-- 한 줄`, 여러 줄 주석
 *  - 토큰마다 줄과 칸 위치를 기록한다. 문법 오류 메시지에 쓴다.
 *
 * 키워드와 식별자는 여기서 구별하지 않고 모두 WORD 로 낸다. 어떤 단어가 키워드인지는 파서가 문맥으로 정한다.
 *
 * 관련 사양 : AGENTS.md 상세 0
 * 구현 단계 : 4단계
 */

import { DbError, ERROR_CODES, unsupportedFeature, withPosition } from "../common/errors.js";
import type { SourcePosition } from "../common/errors.js";

/** 식별자의 최대 길이 (코드 포인트). */
export const MAX_IDENTIFIER_LENGTH = 128;

export type TokenKind =
  /** 따옴표 없는 단어. text 는 대문자로 바꾼 것이다. 키워드일 수도, 식별자일 수도 있다. */
  | "WORD"
  /** 큰따옴표로 감싼 식별자. text 는 따옴표를 뗀 내용 그대로이다. */
  | "QUOTED"
  /** 문자열 리터럴. text 는 따옴표를 떼고 '' 를 ' 로 바꾼 내용이다. */
  | "STRING"
  /** 이진 리터럴. text 는 대문자 16진 숫자이다. */
  | "HEX"
  /** 수 리터럴. text 는 적힌 그대로이다. */
  | "NUMBER"
  /** `?` */
  | "PARAMETER"
  /** 연산자와 구두점 */
  | "SYMBOL"
  /** 문장의 끝 */
  | "END";

export interface Token {
  kind: TokenKind;
  text: string;
  /** NUMBER 일 때만 있다. 숫자만이면 INTEGER, 소수점이 있으면 DECIMAL, 지수 표기이면 FLOAT. */
  numberKind?: "INTEGER" | "DECIMAL" | "FLOAT";
  /** 토큰이 시작하는 위치. */
  position: SourcePosition;
  /** 토큰이 끝난 바로 다음의 offset. */
  end: number;
}

/** 문법 오류를 만든다. SQLSTATE 42601. 메시지 끝에 줄과 칸을 적는다. */
export function syntaxError(message: string, position: SourcePosition): DbError {
  return withPosition(new DbError("42601", ERROR_CODES.SYNTAX_ERROR, message), position);
}

/** 지원하지 않는 문법 오류를 위치와 함께 만든다. SQLSTATE 0A000. */
export function unsupportedSyntax(message: string, position: SourcePosition): DbError {
  return withPosition(unsupportedFeature(message), position);
}

/** 처리 한도를 넘은 문장의 오류를 만든다. SQLSTATE 54001. */
export function tooComplex(message: string, position: SourcePosition): DbError {
  return withPosition(new DbError("54001", ERROR_CODES.STATEMENT_TOO_COMPLEX, message), position);
}

const SYMBOLS_2 = new Set(["<>", "!=", "<=", ">=", "||"]);
const SYMBOLS_1 = new Set(["(", ")", ",", ".", ";", "*", "+", "-", "/", "=", "<", ">"]);

const IDENTIFIER_START = /[\p{L}_]/u;
const IDENTIFIER_PART = /[\p{L}\p{N}_$]/u;

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isSpace(code: number): boolean {
  // 공백, 탭, 줄바꿈, 세로 탭, 폼 피드, 캐리지 리턴, 줄바꿈 없는 공백, BOM
  return code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0 || code === 0xfeff;
}

function countCodePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** SQL 문장을 토큰으로 나눈다. 마지막 토큰은 항상 END 이다. */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  let line = 1;
  let lineStart = 0;

  const positionAt = (at: number): SourcePosition => ({ offset: at, line, column: at - lineStart + 1 });
  /** 줄바꿈을 지나갈 때 줄 번호를 올린다. \r\n 은 한 줄로 센다. */
  const advanceOver = (to: number): void => {
    for (let i = offset; i < to; i++) {
      const code = sql.charCodeAt(i);
      if (code === 0x0a || (code === 0x0d && sql.charCodeAt(i + 1) !== 0x0a)) {
        line++;
        lineStart = i + 1;
      }
    }
    offset = to;
  };
  /** 한 글자(코드 포인트)를 읽는다. */
  const charAt = (at: number): string => {
    const code = sql.codePointAt(at);
    return code === undefined ? "" : String.fromCodePoint(code);
  };
  const push = (kind: TokenKind, text: string, start: SourcePosition, end: number, extra?: Partial<Token>): void => {
    tokens.push({ kind, text, position: start, end, ...extra });
  };

  /** 따옴표로 감싼 내용을 읽는다. 따옴표를 두 번 적은 것은 따옴표 하나이다. offset 은 여는 따옴표에 있어야 한다. */
  const readQuoted = (quote: string, start: SourcePosition, what: string): string => {
    let content = "";
    let at = offset + 1;
    for (;;) {
      const next = sql.indexOf(quote, at);
      if (next < 0) {
        throw syntaxError(`Unterminated ${what}`, start);
      }
      content += sql.slice(at, next);
      if (sql[next + 1] === quote) {
        content += quote;
        at = next + 2;
      } else {
        advanceOver(next + 1);
        return content;
      }
    }
  };

  while (offset < sql.length) {
    const code = sql.charCodeAt(offset);

    if (isSpace(code)) {
      advanceOver(offset + 1);
      continue;
    }
    // 주석
    if (code === 0x2d && sql.charCodeAt(offset + 1) === 0x2d) {
      let end = offset + 2;
      while (end < sql.length && sql.charCodeAt(end) !== 0x0a && sql.charCodeAt(end) !== 0x0d) end++;
      advanceOver(end);
      continue;
    }
    if (code === 0x2f && sql.charCodeAt(offset + 1) === 0x2a) {
      const close = sql.indexOf("*/", offset + 2);
      if (close < 0) {
        throw syntaxError("Unterminated comment", positionAt(offset));
      }
      advanceOver(close + 2);
      continue;
    }

    const start = positionAt(offset);
    const character = charAt(offset);

    // 문자열 리터럴. N'...' 은 CHAR 와 같으므로 접두 N 을 떼고 같은 문자열로 본다.
    if (character === "'" || ((character === "N" || character === "n") && sql[offset + 1] === "'")) {
      if (character !== "'") offset++;
      const content = readQuoted("'", start, "string literal");
      push("STRING", content, start, offset);
      continue;
    }
    // 이진 리터럴
    if ((character === "X" || character === "x") && sql[offset + 1] === "'") {
      offset++;
      const content = readQuoted("'", start, "binary literal");
      if (content.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(content)) {
        throw syntaxError("Binary literal must contain an even number of hexadecimal digits", start);
      }
      push("HEX", content.toUpperCase(), start, offset);
      continue;
    }
    // 큰따옴표로 감싼 식별자
    if (character === '"') {
      const content = readQuoted('"', start, "quoted identifier");
      if (content.length === 0) {
        throw syntaxError("Quoted identifier must not be empty", start);
      }
      if (countCodePoints(content) > MAX_IDENTIFIER_LENGTH) {
        throw identifierTooLong(start);
      }
      push("QUOTED", content, start, offset);
      continue;
    }
    // 수 리터럴
    if (isDigit(code) || (character === "." && isDigit(sql.charCodeAt(offset + 1)))) {
      let end = offset;
      let numberKind: Token["numberKind"] = "INTEGER";
      while (isDigit(sql.charCodeAt(end))) end++;
      if (sql[end] === ".") {
        numberKind = "DECIMAL";
        end++;
        while (isDigit(sql.charCodeAt(end))) end++;
      }
      if (sql[end] === "e" || sql[end] === "E") {
        let exponent = end + 1;
        if (sql[exponent] === "+" || sql[exponent] === "-") exponent++;
        if (!isDigit(sql.charCodeAt(exponent))) {
          throw syntaxError("Invalid numeric literal", start);
        }
        while (isDigit(sql.charCodeAt(exponent))) exponent++;
        numberKind = "FLOAT";
        end = exponent;
      }
      if (end < sql.length && IDENTIFIER_PART.test(charAt(end))) {
        throw syntaxError("Invalid numeric literal", start);
      }
      push("NUMBER", sql.slice(offset, end), start, end, { numberKind });
      offset = end;
      continue;
    }
    // 단어
    if (IDENTIFIER_START.test(character)) {
      let end = offset + character.length;
      while (end < sql.length) {
        const next = charAt(end);
        if (!IDENTIFIER_PART.test(next)) break;
        end += next.length;
      }
      const word = sql.slice(offset, end);
      if (countCodePoints(word) > MAX_IDENTIFIER_LENGTH) {
        throw identifierTooLong(start);
      }
      push("WORD", word.toUpperCase(), start, end);
      offset = end;
      continue;
    }
    if (character === "?") {
      push("PARAMETER", "?", start, offset + 1);
      offset++;
      continue;
    }
    const pair = sql.slice(offset, offset + 2);
    if (SYMBOLS_2.has(pair)) {
      push("SYMBOL", pair, start, offset + 2);
      offset += 2;
      continue;
    }
    if (SYMBOLS_1.has(character)) {
      push("SYMBOL", character, start, offset + 1);
      offset++;
      continue;
    }
    throw syntaxError(`Unexpected character ${JSON.stringify(character)}`, start);
  }

  push("END", "", positionAt(offset), offset);
  return tokens;
}

function identifierTooLong(position: SourcePosition): DbError {
  return withPosition(
    new DbError("42622", ERROR_CODES.IDENTIFIER_TOO_LONG, `Identifier is longer than ${MAX_IDENTIFIER_LENGTH} characters`),
    position,
  );
}
