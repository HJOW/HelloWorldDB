/**
 * SQL 입력을 문장으로 나눈다.
 *
 * 담당
 *  - `;` 를 문장의 끝으로 본다. 문자열 리터럴(`'...'`), 큰따옴표 식별자(`"..."`), 한 줄 주석(`-- ...`),
 *    여러 줄 주석 안의 `;` 는 문장의 끝이 아니다. 따옴표 안의 같은 따옴표 두 개(`''`, `""`)는 따옴표 하나이다.
 *    SQL 어휘 분석(sql/lexer.ts)과 같은 규칙이다. (여러 줄 주석은 중첩하지 않는다)
 *  - 공백과 주석만 있는 조각은 문장으로 세지 않는다.
 *  - 문장마다 입력에서 시작하는 줄 번호를 알려 준다. 서버가 알려 주는 오류 위치(문장 안의 줄, 칸)를 입력 파일의 줄로 바꾸는 데 쓴다.
 *  - 끝나지 않은 입력(`;` 가 아직 없는 나머지, 닫히지 않은 따옴표나 주석)을 `rest` 로 돌려준다.
 *    대화형 모드는 줄이 들어올 때마다 이 함수를 불러 `;` 에서 문장을 실행하고 나머지는 다음 줄과 이어 붙인다.
 *
 * 문장 문자열에는 끝의 `;` 를 넣지 않는다. 서버에는 한 번에 한 문장만 보낸다.
 *
 * 관련 사양 : AGENTS.md 상세 14-2
 * 구현 단계 : 10단계
 */

/** 나눈 문장 하나이다. */
export interface SplitStatement {
  /** 앞뒤 공백을 뗀 문장이다. `;` 는 없다. 앞에 붙은 주석은 그대로 둔다. */
  text: string;
  /** 문장이 시작하는 줄이다. 입력의 첫 줄이 `startLine` 이다. */
  line: number;
  /** 문장이 시작하는 칸이다. (그 줄 안에서 1 부터. UTF-16 단위로 서버가 알려 주는 오류 위치의 칸과 같은 단위이다) */
  column: number;
}

export interface SplitResult {
  statements: SplitStatement[];
  /** 마지막 `;` 뒤의 나머지이다. */
  rest: string;
  /** 나머지에 문장의 일부가 있는지이다. 공백과 닫힌 주석뿐이면 false 이다. 닫히지 않은 따옴표나 주석이 있으면 true 이다. */
  restPending: boolean;
  /** 나머지가 시작하는 줄이다. */
  restLine: number;
  /** 나머지가 시작하는 칸이다. */
  restColumn: number;
}

/** 입력 안의 한 지점(줄, 칸)이다. */
interface Spot {
  line: number;
  column: number;
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c || code === 0x0b;
}

/** `from` 지점에서 `text` 만큼 지나간 뒤의 지점이다. `\r\n` 은 줄바꿈 하나이다. */
function advance(from: Spot, text: string): Spot {
  let { line, column } = from;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x0a || (code === 0x0d && text.charCodeAt(index + 1) !== 0x0a)) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

/** 앞의 공백을 뗀 문장과, 문장이 시작하는 지점을 돌려준다. `start` 는 `raw` 가 시작하는 지점이다. */
function trimStatement(raw: string, start: Spot): { text: string; at: Spot } {
  let first = 0;
  while (first < raw.length && isSpace(raw.charCodeAt(first))) first++;
  return { text: raw.slice(first).trimEnd(), at: advance(start, raw.slice(0, first)) };
}

/**
 * 입력을 문장으로 나눈다. `startLine` 은 입력의 첫 줄 번호이다. (기본 1)
 */
export function splitStatements(input: string, startLine = 1): SplitResult {
  const statements: SplitStatement[] = [];
  let segmentStart = 0;
  /** `segmentStart` 가 놓인 지점이다. 조각을 닫을 때마다 지나간 만큼 옮긴다. (입력 전체를 다시 세지 않는다) */
  let segmentSpot: Spot = { line: startLine, column: 1 };
  /** 현재 조각에 공백과 주석이 아닌 것이 나왔는지이다. */
  let hasToken = false;
  let index = 0;

  /** 닫히지 않은 따옴표나 주석 때문에 나머지 전체가 문장의 일부일 때의 결과이다. */
  const unfinished = (): SplitResult => ({
    statements,
    rest: input.slice(segmentStart),
    restPending: true,
    restLine: segmentSpot.line,
    restColumn: segmentSpot.column,
  });

  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code === 0x27 || code === 0x22) {
      // 문자열 리터럴 또는 큰따옴표 식별자. 같은 따옴표 두 개는 따옴표 하나이다.
      hasToken = true;
      let cursor = index + 1;
      let closed = false;
      while (cursor < input.length) {
        if (input.charCodeAt(cursor) === code) {
          if (input.charCodeAt(cursor + 1) === code) {
            cursor += 2;
            continue;
          }
          closed = true;
          cursor++;
          break;
        }
        cursor++;
      }
      if (!closed) return unfinished();
      index = cursor;
      continue;
    }
    if (code === 0x2d && input.charCodeAt(index + 1) === 0x2d) {
      // 한 줄 주석 : 줄 끝까지. 줄바꿈 자체는 다음 반복에서 공백으로 지나간다.
      let cursor = index + 2;
      while (cursor < input.length && input.charCodeAt(cursor) !== 0x0a && input.charCodeAt(cursor) !== 0x0d) cursor++;
      index = cursor;
      continue;
    }
    if (code === 0x2f && input.charCodeAt(index + 1) === 0x2a) {
      const close = input.indexOf("*/", index + 2);
      if (close < 0) return unfinished();
      index = close + 2;
      continue;
    }
    if (code === 0x3b) {
      const piece = input.slice(segmentStart, index + 1);
      if (hasToken) {
        const { text, at } = trimStatement(piece.slice(0, -1), segmentSpot);
        statements.push({ text, line: at.line, column: at.column });
      }
      hasToken = false;
      segmentSpot = advance(segmentSpot, piece);
      segmentStart = index + 1;
      index++;
      continue;
    }
    if (!isSpace(code)) hasToken = true;
    index++;
  }
  return { statements, rest: input.slice(segmentStart), restPending: hasToken, restLine: segmentSpot.line, restColumn: segmentSpot.column };
}

/**
 * 입력 전체를 문장으로 나눈다. 스크립트 모드가 쓴다.
 * 끝에 `;` 없이 남은 문장도 문장으로 센다. (닫히지 않은 따옴표나 주석이 있으면 그 조각을 그대로 서버에 보내 구문 오류를 받는다)
 */
export function splitScript(input: string): SplitStatement[] {
  const result = splitStatements(input);
  if (!result.restPending) return result.statements;
  const { text, at } = trimStatement(result.rest, { line: result.restLine, column: result.restColumn });
  return [...result.statements, { text, line: at.line, column: at.column }];
}
