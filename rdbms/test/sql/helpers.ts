/**
 * 담당 : SQL 파서 테스트가 함께 쓰는 도우미. 구문 트리를 한 줄 표기로 바꾸어 구조를 간결하게 비교한다.
 * 관련 사양 : AGENTS.md 상세 0, 1, 13.
 * 구현 단계 : 4단계.
 */
import assert from "node:assert/strict";
import { DbError, ERROR_CODES } from "../../src/common/errors.js";
import type * as ast from "../../src/sql/ast.js";
import { parseStatement } from "../../src/sql/parser.js";
import { formatDataType } from "../../src/types/dataType.js";

/** 구문 트리에서 위치 정보를 뗀다. 구조만 비교할 때 쓴다. */
export function withoutPositions<T>(node: T): T {
  if (Array.isArray(node)) return node.map(withoutPositions) as T;
  if (typeof node !== "object" || node === null) return node;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key !== "position") copy[key] = withoutPositions(value);
  }
  return copy as T;
}

/** 문장을 구문 분석하여 위치 정보를 뗀 구문 트리를 돌려준다. */
export function parse(sql: string): ast.Statement {
  return withoutPositions(parseStatement(sql).statement);
}

function qualifierText(qualifier: ast.IntervalQualifier): string {
  let text = qualifier.startField as string;
  if (qualifier.leadingPrecision !== null) {
    text += qualifier.endField === null && qualifier.fractionalPrecision !== null
      ? `(${qualifier.leadingPrecision},${qualifier.fractionalPrecision})`
      : `(${qualifier.leadingPrecision})`;
  }
  if (qualifier.endField !== null) {
    text += ` TO ${qualifier.endField}`;
    if (qualifier.fractionalPrecision !== null) text += `(${qualifier.fractionalPrecision})`;
  }
  return text;
}

function zoneText(withTimeZone: boolean | null): string {
  return withTimeZone === null ? "" : withTimeZone ? " WITH TIME ZONE" : " WITHOUT TIME ZONE";
}

/** 식을 전위 표기 한 줄로 적는다. (예 : `(+ 1 (* 2 3))`) */
export function renderExpression(expression: ast.Expression): string {
  const not = (negated: boolean): string => (negated ? "NOT-" : "");
  switch (expression.kind) {
    case "Literal":
      switch (expression.type) {
        case "NULL": return "NULL";
        case "BOOLEAN": return expression.value ? "TRUE" : "FALSE";
        case "STRING": return `'${expression.value}'`;
        case "BINARY": return `X'${expression.hex}'`;
        case "INTEGER": return expression.text;
        case "DECIMAL": return `${expression.text}:DECIMAL`;
        case "FLOAT": return `${expression.text}:FLOAT`;
        case "DATE": return `DATE'${expression.text}'`;
        case "TIME":
        case "TIMESTAMP": return `${expression.type}${zoneText(expression.withTimeZone)}'${expression.text}'`;
        case "INTERVAL": return `INTERVAL'${expression.text}' ${qualifierText(expression.qualifier)}`;
      }
    // eslint-disable-next-line no-fallthrough
    case "Parameter": return `?${expression.index}`;
    case "Column": return [...expression.qualifier, expression.name].join(".");
    case "Unary": return `(${expression.operator} ${renderExpression(expression.operand)})`;
    case "Binary":
      return `(${expression.operator} ${renderExpression(expression.left)} ${renderExpression(expression.right)})`;
    case "Logical": return `(${expression.operator} ${expression.operands.map(renderExpression).join(" ")})`;
    case "IsNull": return `(IS-${not(expression.negated)}NULL ${renderExpression(expression.operand)})`;
    case "IsBoolean": {
      const value = expression.value === null ? "UNKNOWN" : expression.value ? "TRUE" : "FALSE";
      return `(IS-${not(expression.negated)}${value} ${renderExpression(expression.operand)})`;
    }
    case "Between":
      return `(${not(expression.negated)}BETWEEN ${renderExpression(expression.operand)} ${renderExpression(expression.low)} ${renderExpression(expression.high)})`;
    case "InList":
      return `(${not(expression.negated)}IN ${[expression.operand, ...expression.items].map(renderExpression).join(" ")})`;
    case "InSubquery":
      return `(${not(expression.negated)}IN ${renderExpression(expression.operand)} ${renderQuery(expression.query)})`;
    case "Like": {
      const escape = expression.escape === null ? "" : ` ESCAPE ${renderExpression(expression.escape)}`;
      return `(${not(expression.negated)}LIKE ${renderExpression(expression.operand)} ${renderExpression(expression.pattern)}${escape})`;
    }
    case "Exists": return `(EXISTS ${renderQuery(expression.query)})`;
    case "Quantified":
      return `(${expression.operator} ${expression.quantifier} ${renderExpression(expression.operand)} ${renderQuery(expression.query)})`;
    case "Subquery": return renderQuery(expression.query);
    case "Case": {
      const operand = expression.operand === null ? "" : ` ${renderExpression(expression.operand)}`;
      const branches = expression.branches
        .map((branch) => ` (WHEN ${renderExpression(branch.when)} ${renderExpression(branch.then)})`)
        .join("");
      const otherwise = expression.otherwise === null ? "" : ` (ELSE ${renderExpression(expression.otherwise)})`;
      return `(CASE${operand}${branches}${otherwise})`;
    }
    case "Cast": return `(CAST ${renderExpression(expression.operand)} ${formatDataType(expression.dataType)})`;
    case "Function": {
      const parts = [expression.name];
      if (expression.distinct) parts.push("DISTINCT");
      if (expression.star) parts.push("*");
      parts.push(...expression.arguments.map(renderExpression));
      return `(${parts.join(" ")})`;
    }
    case "Extract": return `(EXTRACT ${expression.field} ${renderExpression(expression.operand)})`;
    case "Trim": {
      const characters = expression.characters === null ? "-" : renderExpression(expression.characters);
      return `(TRIM ${expression.side} ${characters} ${renderExpression(expression.operand)})`;
    }
    case "Default": return "DEFAULT";
  }
}

function renderName(name: ast.ObjectName): string {
  return name.tablespace === null ? name.name : `${name.tablespace}.${name.name}`;
}

export function renderTableReference(reference: ast.TableReference): string {
  switch (reference.kind) {
    case "Table":
      return reference.alias === null ? renderName(reference.name) : `${renderName(reference.name)} AS ${reference.alias}`;
    case "Derived": {
      const columns = reference.columns === null ? "" : `(${reference.columns.join(",")})`;
      return `${renderQuery(reference.query)}${reference.alias === null ? "" : ` AS ${reference.alias}${columns}`}`;
    }
    case "Join": {
      const condition = reference.on !== null
        ? ` ON ${renderExpression(reference.on)}`
        : reference.using !== null ? ` USING(${reference.using.join(",")})` : "";
      return `(${reference.type} ${renderTableReference(reference.left)} ${renderTableReference(reference.right)}${condition})`;
    }
  }
}

function renderBody(body: ast.QueryBody): string {
  if (body.kind === "Query") return renderQuery(body);
  if (body.kind === "SetOperation") {
    return `(${body.operator}${body.all ? " ALL" : ""} ${renderBody(body.left)} ${renderBody(body.right)})`;
  }
  const items = body.items.map((item) => {
    if (item.kind === "Star") return [...item.qualifier, "*"].join(".");
    return item.alias === null ? renderExpression(item.expression) : `${renderExpression(item.expression)} AS ${item.alias}`;
  });
  let text = `SELECT${body.distinct ? " DISTINCT" : ""} ${items.join(", ")}`;
  if (body.from.length > 0) text += ` FROM ${body.from.map(renderTableReference).join(", ")}`;
  if (body.where !== null) text += ` WHERE ${renderExpression(body.where)}`;
  if (body.groupBy.length > 0) text += ` GROUP ${body.groupBy.map(renderExpression).join(", ")}`;
  if (body.having !== null) text += ` HAVING ${renderExpression(body.having)}`;
  return text;
}

/** 질의를 한 줄로 적는다. 중괄호 하나가 질의 식(ORDER BY, 행 수 제한을 가질 수 있는 단위) 하나이다. */
export function renderQuery(query: ast.Query): string {
  let text = renderBody(query.body);
  if (query.orderBy.length > 0) {
    const items = query.orderBy.map((item) =>
      `${renderExpression(item.expression)}${item.descending ? " DESC" : ""}${item.nulls === null ? "" : ` NULLS ${item.nulls}`}`);
    text += ` ORDER ${items.join(", ")}`;
  }
  if (query.offset !== null) text += ` OFFSET ${renderExpression(query.offset)}`;
  if (query.fetch !== null) text += ` FETCH ${query.fetch.count === null ? "-" : renderExpression(query.fetch.count)}`;
  if (query.forUpdate) text += " FOR UPDATE";
  return `{${text}}`;
}

/** `SELECT 식` 을 구문 분석하여 그 식을 한 줄 표기로 돌려준다. */
export function expression(sql: string): string {
  const statement = parseStatement(`SELECT ${sql}`).statement;
  assert.equal(statement.kind, "Query");
  const body = (statement as ast.Query).body;
  assert.equal(body.kind, "Select");
  const items = (body as ast.Select).items;
  assert.equal(items.length, 1, "exactly one select item expected");
  const item = items[0] as ast.SelectItem;
  assert.equal(item.kind, "Expression");
  return renderExpression((item as ast.ExpressionItem).expression);
}

/** 질의를 구문 분석하여 한 줄 표기로 돌려준다. */
export function query(sql: string): string {
  const statement = parseStatement(sql).statement;
  assert.equal(statement.kind, "Query");
  return renderQuery(statement as ast.Query);
}

export interface ExpectedPosition {
  line: number;
  column: number;
}

function assertDbError(sql: string, sqlState: string, code: number, position?: ExpectedPosition, message?: RegExp): void {
  assert.throws(() => parseStatement(sql), (error) => {
    assert.ok(error instanceof DbError, `DbError expected for: ${sql}\n${String(error)}`);
    assert.equal(error.sqlState, sqlState, `${sql}\n${error.message}`);
    assert.equal(error.code, code, `${sql}\n${error.message}`);
    assert.ok(error.position !== undefined, `position expected for: ${sql}`);
    assert.match(error.message, /\(line \d+, column \d+\)\.$/);
    if (position !== undefined) {
      assert.deepEqual({ line: error.position.line, column: error.position.column }, position, `${sql}\n${error.message}`);
    }
    if (message !== undefined) assert.match(error.message, message, sql);
    return true;
  });
}

/** 잘못된 문법 : SQLSTATE 42601 과 위치 정보를 확인한다. */
export function assertSyntaxError(sql: string, position?: ExpectedPosition, message?: RegExp): void {
  assertDbError(sql, "42601", ERROR_CODES.SYNTAX_ERROR, position, message);
}

/** 지원하지 않는 문법 : SQLSTATE 0A000 과 위치 정보를 확인한다. */
export function assertUnsupported(sql: string, position?: ExpectedPosition, message?: RegExp): void {
  assertDbError(sql, "0A000", ERROR_CODES.FEATURE_NOT_SUPPORTED, position, message);
}

/** 처리 한도를 넘은 문장 : SQLSTATE 54001 과 위치 정보를 확인한다. */
export function assertTooComplex(sql: string, message?: RegExp): void {
  assertDbError(sql, "54001", ERROR_CODES.STATEMENT_TOO_COMPLEX, undefined, message);
}

/** 그 밖의 오류 : SQLSTATE 만 확인한다. 위치 정보는 있어야 한다. */
export function assertSqlStateAt(sql: string, sqlState: string, position?: ExpectedPosition): void {
  assert.throws(() => parseStatement(sql), (error) => {
    assert.ok(error instanceof DbError, `DbError expected for: ${sql}\n${String(error)}`);
    assert.equal(error.sqlState, sqlState, `${sql}\n${error.message}`);
    assert.ok(error.position !== undefined, `position expected for: ${sql}`);
    if (position !== undefined) {
      assert.deepEqual({ line: error.position.line, column: error.position.column }, position, `${sql}\n${error.message}`);
    }
    return true;
  });
}
