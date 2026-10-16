/**
 * 결과 출력 테스트 (10단계). 표시 폭, 표 모양, NULL 과 빈 문자열의 구분, 오류 출력을 본다.
 * 관련 사양 : AGENTS.md 상세 14-2
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DbError } from "../../src/common/errors.js";
import type { ColumnMeta } from "../../src/net/protocol.js";
import {
  displayWidth,
  formatCell,
  formatElapsed,
  formatError,
  formatOkLine,
  formatRowsFooter,
  renderTable,
} from "../../src/cli/resultPrinter.js";

function column(name: string, typeName = "VARCHAR"): ColumnMeta {
  return { name, typeName, declared: typeName };
}

test("표시 폭 : 영문은 1칸, 한글·한자·가나·전각은 2칸", () => {
  assert.equal(displayWidth(""), 0);
  assert.equal(displayWidth("Hello"), 5);
  assert.equal(displayWidth("한글"), 4);
  assert.equal(displayWidth("漢字"), 4);
  assert.equal(displayWidth("ひらがな"), 8);
  assert.equal(displayWidth("カタカナ"), 8);
  assert.equal(displayWidth("ＡＢ"), 4, "전각 영문");
  assert.equal(displayWidth("가a나"), 5);
  assert.equal(displayWidth("😀"), 2, "이모지");
  assert.equal(displayWidth("é"), 1);
  assert.equal(displayWidth("é"), 1, "결합 문자는 폭이 없다");
  assert.equal(displayWidth("a​b"), 2, "폭 없는 공백");
});

test("값 표시 : NULL 은 NULL, 빈 문자열은 빈 칸, 논리값은 대문자", () => {
  assert.equal(formatCell(null), "NULL");
  assert.equal(formatCell(""), "");
  assert.equal(formatCell("NULL"), "NULL", "문자열 NULL 은 텍스트 그대로이다");
  assert.equal(formatCell(true), "TRUE");
  assert.equal(formatCell(false), "FALSE");
  assert.equal(formatCell(42), "42");
  assert.equal(formatCell(1.5), "1.5");
  assert.equal(formatCell("AB12", column("B", "VARBINARY")), "0xAB12");
  assert.equal(formatCell("AB12", column("B", "VARCHAR")), "AB12");
});

test("줄바꿈, 탭, 제어 문자는 한 줄에 보이는 표기로 바꾼다", () => {
  assert.equal(formatCell("a\nb"), "a\\nb");
  assert.equal(formatCell("a\r\nb"), "a\\r\\nb");
  assert.equal(formatCell("a\tb"), "a\\tb");
  assert.equal(formatCell("a\u0001b"), "a\\x01b");
  assert.equal(formatCell("a\u001bb"), "a\\x1Bb");
  assert.equal(formatCell(`a${String.fromCharCode(0x2028)}b`), String.raw`a\x2028b`, "줄 구분자도 바꾼다");
});

test("표 모양 : 머리글, 구분선, 행", () => {
  const table = renderTable([column("MESSAGE")], [["Hello World"]]);
  assert.equal(
    table,
    ["+-------------+", "| MESSAGE     |", "+-------------+", "| Hello World |", "+-------------+"].join("\n"),
  );
});

test("한글이 있어도 칸이 맞는다", () => {
  const table = renderTable([column("이름"), column("CITY")], [["홍길동", "Seoul"], ["Kim", "부산"]]);
  const lines = table.split("\n");
  // 모든 줄의 표시 폭이 같다.
  const widths = new Set(lines.map((line) => displayWidth(line)));
  assert.equal(widths.size, 1, table);
  assert.equal(
    table,
    ["+--------+-------+", "| 이름   | CITY  |", "+--------+-------+", "| 홍길동 | Seoul |", "| Kim    | 부산  |", "+--------+-------+"].join("\n"),
  );
});

test("숫자 타입은 오른쪽으로 맞춘다", () => {
  const table = renderTable(
    [column("ID", "INTEGER"), column("NAME"), column("PRICE", "DECIMAL")],
    [[1, "a", "1.50"], [100, "bb", "20.00"]],
  );
  assert.equal(
    table,
    [
      "+-----+------+-------+",
      "| ID  | NAME | PRICE |",
      "+-----+------+-------+",
      "|   1 | a    |  1.50 |",
      "| 100 | bb   | 20.00 |",
      "+-----+------+-------+",
    ].join("\n"),
  );
});

test("NULL 과 빈 문자열이 한 표에서 구분된다", () => {
  const table = renderTable([column("A"), column("B")], [[null, ""], ["", null]]);
  assert.equal(
    table,
    ["+------+------+", "| A    | B    |", "+------+------+", "| NULL |      |", "|      | NULL |", "+------+------+"].join("\n"),
  );
});

test("행이 없어도 머리글은 보인다", () => {
  assert.equal(renderTable([column("A"), column("BB")], []), ["+---+----+", "| A | BB |", "+---+----+", "+---+----+"].join("\n"));
});

test("행 안의 줄바꿈이 표를 깨지 않는다", () => {
  const table = renderTable([column("TEXT")], [["line1\nline2"]]);
  assert.equal(table.split("\n").length, 5);
});

test("행 수와 소요 시간 문구", () => {
  assert.equal(formatRowsFooter(0, 3.4), "0 rows (3 ms)");
  assert.equal(formatRowsFooter(1, 0.2), "1 row (0 ms)");
  assert.equal(formatRowsFooter(2, 12.6), "2 rows (13 ms)");
  assert.equal(formatElapsed(999.4), "999 ms");
  assert.equal(formatElapsed(1500), "1.50 s");
  assert.equal(formatElapsed(-1), "0 ms");
});

test("조회가 아닌 문장의 결과 문구", () => {
  assert.equal(formatOkLine('Table "T" created.', null, 5), 'Table "T" created. (5 ms)');
  assert.equal(formatOkLine("INSERT 1", 1, 5), "INSERT 1 (1 row affected, 5 ms)");
  assert.equal(formatOkLine("UPDATE 3", 3, 5), "UPDATE 3 (3 rows affected, 5 ms)");
  assert.equal(formatOkLine("DELETE 0", 0, 5), "DELETE 0 (0 rows affected, 5 ms)");
});

test("오류는 SQLSTATE 와 내부 번호와 메시지를 보인다", () => {
  const error = new DbError("23505", 5101, "Duplicate key.");
  assert.equal(formatError(error), "ERROR [23505:5101] Duplicate key.");
});

test("위치가 있는 오류는 그 줄과 가리키는 표시를 이어서 보인다", () => {
  const error = new DbError("42601", 3000, "Unexpected FROM (line 2, column 4).", { position: { offset: 14, line: 2, column: 4 } });
  const statement = "SELECT 2,\n   FROM X";
  assert.equal(
    formatError(error, statement),
    ["ERROR [42601:3000] Unexpected FROM (line 2, column 4).", "     FROM X", "     ^"].join("\n"),
  );
});

test("가리키는 표시는 앞의 한글 폭만큼 밀린다", () => {
  const error = new DbError("42601", 3000, "Bad.", { position: { offset: 9, line: 1, column: 10 } });
  // 칸 10 은 `X` 의 위치이다. 앞의 `한` 은 UTF-16 한 칸이지만 폭은 2칸이다.
  const lines = formatError(error, "SELECT 한 X").split("\n");
  assert.equal(lines[1], "  SELECT 한 X");
  assert.equal(lines[2], `  ${" ".repeat(10)}^`);
  assert.equal(displayWidth("SELECT 한 "), 10);
});

test("입력 위치는 문장의 시작 줄과 칸을 반영한다", () => {
  const first = new DbError("42601", 3000, "Bad.", { position: { offset: 0, line: 1, column: 1 } });
  assert.match(formatError(first, "SELEC 2", { line: 4, column: 12 }), /at input line 4, column 12/);
  const later = new DbError("42601", 3000, "Bad.", { position: { offset: 10, line: 2, column: 4 } });
  assert.match(formatError(later, "SELECT 1,\n   X", { line: 4, column: 12 }), /at input line 5, column 4/, "둘째 줄부터는 칸을 그대로 쓴다");
  assert.doesNotMatch(formatError(first, "SELEC 2"), /input line/);
});
