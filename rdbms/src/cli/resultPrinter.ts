/**
 * 실행 결과의 화면 출력.
 *
 * 담당
 *  - 조회 결과를 표로 출력한다. 한글처럼 폭이 넓은 문자가 있어도 칸이 맞아야 한다. (`displayWidth`)
 *  - 조회 결과 끝에 행 수와 소요 시간을 덧붙인다.
 *  - 그 외 문장은 서버의 완료 메시지와 영향받은 행 수, 소요 시간을 출력한다.
 *  - 오류는 SQLSTATE 와 내부 오류 번호, 영문 메시지를 출력한다. 위치가 있으면 해당 줄과 가리키는 표시를 덧붙인다.
 *  - NULL 과 빈 문자열을 구분해서 보여 준다 : NULL 은 `NULL`, 빈 문자열은 빈 칸이다.
 *
 * 표 모양(psql 과 mysql 의 중간)
 *   +-------------+
 *   | MESSAGE     |
 *   +-------------+
 *   | Hello World |
 *   +-------------+
 *   1 row (3 ms)
 * 숫자 타입의 값은 오른쪽으로 맞춘다. 줄바꿈, 탭, 그 밖의 제어 문자는 `\n`, `\t`, `\xNN` 으로 바꿔 한 줄에 보여 준다.
 *
 * 문구는 메시지 카탈로그(`t`)에서 꺼낸다. 서버가 보낸 오류 메시지와 완료 메시지는 영문 그대로 둔다.
 *
 * 관련 사양 : AGENTS.md 상세 14-2
 * 구현 단계 : 10단계
 */

import { formatDbError } from "../common/errors.js";
import type { DbError } from "../common/errors.js";
import type { ColumnMeta, JsonValue } from "../net/protocol.js";
import { t } from "./i18n.js";

// ---------------------------------------------------------------------------
// 표시 폭
// ---------------------------------------------------------------------------

/** 앞뒤 값이 위치 범위 [시작, 끝] 인 표이다. 2칸을 차지하는 문자(동아시아의 넓은 문자와 이모지)이다. */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // 한글 자모(초성)
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e], // CJK 부수, 강희자전, 표의 문자 기호, CJK 기호와 구두점
  [0x3041, 0x33ff], // 히라가나, 가타카나, 한글 호환 자모, CJK 호환
  [0x3400, 0x4dbf], // CJK 확장 A
  [0x4e00, 0xa4cf], // CJK 통합 한자, 이 문자
  [0xa960, 0xa97f], // 한글 자모 확장 A
  [0xac00, 0xd7a3], // 한글 음절
  [0xf900, 0xfaff], // CJK 호환 한자
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60], // 전각 형태
  [0xffe0, 0xffe6],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7],
  [0x1f6dc, 0x1f6df],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], // CJK 확장 B 이후
  [0x30000, 0x3fffd],
];

/** 폭이 0 인 문자이다. 결합 문자(Mn, Me)와 서식 문자(Cf. 폭 없는 공백과 이음 문자 등)이다. */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

/** 코드 포인트 하나가 터미널에서 차지하는 칸 수(0, 1, 2)이다. */
function codePointWidth(codePoint: number): number {
  if (codePoint < 0x300) return 1; // 제어 문자는 출력 전에 바꾸므로 여기에 오지 않는다.
  if (ZERO_WIDTH.test(String.fromCodePoint(codePoint))) return 0;
  // 이진 탐색
  let low = 0;
  let high = WIDE_RANGES.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = WIDE_RANGES[middle] as readonly [number, number];
    if (codePoint < range[0]) high = middle - 1;
    else if (codePoint > range[1]) low = middle + 1;
    else return 2;
  }
  return 1;
}

/**
 * 문자열이 터미널에서 차지하는 칸 수이다. 한글, 한자, 가나, 전각 문자, 이모지는 2칸이고 결합 문자는 0칸이다.
 * 글꼴과 터미널에 따라 달라질 수 있는 모호한 폭 문자는 1칸으로 본다. 이모지의 이음 순서(ZWJ)는 낱개의 합으로 센다.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += codePointWidth(character.codePointAt(0) as number);
  }
  return width;
}

// ---------------------------------------------------------------------------
// 값 표시
// ---------------------------------------------------------------------------

/** 오른쪽으로 맞추는 컬럼 타입이다. */
const NUMERIC_TYPES: ReadonlySet<string> = new Set(["SMALLINT", "INTEGER", "BIGINT", "DECIMAL", "REAL", "DOUBLE PRECISION"]);

const BINARY_TYPES: ReadonlySet<string> = new Set(["BINARY", "VARBINARY"]);

/** 제어 문자를 한 줄에 보이는 표기로 바꾼다. */
function escapeControls(text: string): string {
  // 서식을 깨는 문자만 바꾼다. 줄 구분자(U+2028, U+2029)도 바꾼다.
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (character) => {
    switch (character) {
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      default:
        return `\\x${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
    }
  });
}

/** 값 하나를 표의 칸에 넣을 문자열로 바꾼다. NULL 은 `NULL`, 빈 문자열은 빈 칸이다. */
export function formatCell(value: JsonValue, column?: ColumnMeta): string {
  if (value === null) return "NULL";
  if (typeof value === "string") {
    if (column !== undefined && BINARY_TYPES.has(column.typeName)) return `0x${value}`;
    return escapeControls(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(value);
  return escapeControls(JSON.stringify(value));
}

function pad(text: string, width: number, alignRight: boolean): string {
  const fill = " ".repeat(Math.max(0, width - displayWidth(text)));
  return alignRight ? fill + text : text + fill;
}

/**
 * 표를 만든다. 머리글 줄, 구분선, 행 줄로 이루어지며 줄바꿈 문자로 끝나지 않는다.
 * 행이 하나도 없어도 머리글은 보여 준다.
 */
export function renderTable(columns: readonly ColumnMeta[], rows: readonly JsonValue[][]): string {
  const cells = rows.map((row) => columns.map((column, index) => formatCell(row[index] ?? null, column)));
  const widths = columns.map((column, index) => {
    let width = displayWidth(escapeControls(column.name));
    for (const row of cells) width = Math.max(width, displayWidth(row[index] as string));
    return width;
  });
  const right = columns.map((column) => NUMERIC_TYPES.has(column.typeName));
  const border = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
  const line = (values: readonly string[], useAlignment: boolean): string =>
    `| ${values.map((value, index) => pad(value, widths[index] as number, useAlignment && (right[index] as boolean))).join(" | ")} |`;
  const lines = [border, line(columns.map((column) => escapeControls(column.name)), false), border];
  for (const row of cells) lines.push(line(row, true));
  lines.push(border);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 소요 시간, 행 수
// ---------------------------------------------------------------------------

/** 소요 시간 표기이다. 1초 미만은 ms, 그 이상은 초(소수 둘째 자리)이다. */
export function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1000) return t("result.elapsedMs", { value: Math.max(0, Math.round(milliseconds)) });
  return t("result.elapsedSeconds", { value: (milliseconds / 1000).toFixed(2) });
}

/** 조회 결과 끝에 덧붙이는 줄이다. 예 : `3 rows (4 ms)` */
export function formatRowsFooter(rowCount: number, elapsedMs: number): string {
  return t(rowCount === 1 ? "result.rowsOne" : "result.rowsMany", { count: rowCount, elapsed: formatElapsed(elapsedMs) });
}

/** 조회가 아닌 문장의 결과 줄이다. 예 : `INSERT 1 (1 row affected, 3 ms)` */
export function formatOkLine(message: string, rowCount: number | null, elapsedMs: number): string {
  if (rowCount === null) return t("result.okNoCount", { message, elapsed: formatElapsed(elapsedMs) });
  return t(rowCount === 1 ? "result.okAffectedOne" : "result.okAffectedMany", { message, count: rowCount, elapsed: formatElapsed(elapsedMs) });
}

// ---------------------------------------------------------------------------
// 오류
// ---------------------------------------------------------------------------

/**
 * 오류를 사람이 읽을 문구로 바꾼다. 첫 줄은 `ERROR [SQLSTATE:번호] 메시지` 이다.
 * 오류에 위치가 있고 문장 원문이 주어지면, 그 줄과 가리키는 표시(`^`)를 이어서 보여 준다.
 *
 * @param statement 서버에 보낸 문장 원문이다. 오류 위치(줄, 칸)가 이 문장 안의 위치이다.
 * @param origin 문장이 입력(파일)에서 시작하는 줄과 칸이다. 주어지면 오류가 난 입력 위치를 함께 알린다.
 *               문장의 첫 줄에서는 시작 칸만큼 밀어서, 같은 줄에 앞선 문장이 있어도 입력의 칸과 맞는다.
 */
export function formatError(error: DbError, statement?: string, origin?: { line: number; column: number }): string {
  const lines = [t("error.line", { text: formatDbError(error) })];
  const position = error.position;
  if (position !== undefined) {
    if (origin !== undefined) {
      const column = position.line === 1 ? origin.column + position.column - 1 : position.column;
      lines.push(t("error.inputLine", { line: origin.line + position.line - 1, column }));
    }
    if (statement !== undefined) {
      const sourceLine = statement.split(/\r\n|\r|\n/)[position.line - 1];
      if (sourceLine !== undefined) {
        // 칸은 UTF-16 단위이다. 표시 위치는 그 앞부분의 표시 폭이다.
        const before = sourceLine.slice(0, Math.max(0, position.column - 1));
        const shown = escapeControls(sourceLine);
        lines.push(`  ${shown}`);
        lines.push(`  ${" ".repeat(displayWidth(escapeControls(before)))}^`);
      }
    }
  }
  return lines.join("\n");
}
