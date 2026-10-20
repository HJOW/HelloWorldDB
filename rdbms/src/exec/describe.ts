/**
 * 실행 없는 문장 분석. 카탈로그 정의와 타입만 사용하며 행·DEFAULT를 평가하지 않는다.
 * 관련 사양: AGENTS.md 상세 8-2. 구현 단계: PD-2.
 */
import { DbError, ERROR_CODES } from "../common/errors.js";
import type { Statement, Expression } from "../sql/ast.js";
import { parseStatement } from "../sql/parser.js";
import { NULL_LITERAL_TYPE } from "../types/dataType.js";
import type { DataType } from "../types/dataType.js";
import { commonType } from "../types/cast.js";
import { bindSource } from "./analyzer.js";
import { evaluateExpression } from "./expression.js";
import { evalContextFor, inferOutputColumns, typeScopes } from "./executor.js";
import type { QueryContext } from "./executor.js";

export interface Description {
  resultKind: "rows" | "ok";
  columns: { name: string; type: DataType; nullable: "YES" | "NO" | "UNKNOWN" }[];
  parameters: (DataType | null)[];
}

export function parseParameterTypes(hints: readonly (string | null)[] | undefined, count: number): (DataType | null)[] {
  if (hints === undefined) return Array.from({ length: count }, () => null);
  if (hints.length !== count) throw new DbError("07001", ERROR_CODES.PARAM_COUNT_MISMATCH, "Parameter type count does not match.");
  return hints.map((hint) => {
    if (hint === null) return null;
    let parsed: ReturnType<typeof parseStatement>;
    try { parsed = parseStatement(`SELECT CAST(NULL AS ${hint})`); }
    catch (error) {
      if (error instanceof DbError) throw new DbError("22023", ERROR_CODES.TYPE_PARAMETER_INVALID, "Invalid parameter type declaration.", { cause: error });
      throw error;
    }
    const stmt = parsed.statement;
    if (parsed.parameterCount !== 0 || stmt.kind !== "Query" || stmt.body.kind !== "Select" || stmt.body.items.length !== 1) throw new DbError("22023", ERROR_CODES.TYPE_PARAMETER_INVALID, "Invalid parameter type declaration.");
    const item = stmt.body.items[0]!;
    if (item.kind !== "Expression" || item.alias !== null || item.expression.kind !== "Cast" || stmt.body.from.length !== 0 || stmt.body.where !== null || stmt.orderBy.length !== 0 || stmt.offset !== null || stmt.fetch !== null || stmt.forUpdate) throw new DbError("22023", ERROR_CODES.TYPE_PARAMETER_INVALID, "Invalid parameter type declaration.");
    return item.expression.dataType;
  });
}

export function describeStatement(stmt: Statement, count: number, context: QueryContext, hints?: readonly (string | null)[]): Description {
  const parameters = parseParameterTypes(hints, count);
  const ctx: QueryContext = { ...context, parameterType(index, expected) {
    const current = parameters[index - 1];
    if (expected !== undefined && expected !== NULL_LITERAL_TYPE) {
      if (current !== null && current !== undefined && commonType(current, expected) === null) throw new DbError("42804", ERROR_CODES.TYPE_MISMATCH, "Parameter type is incompatible with its context.");
      if (current === null) parameters[index - 1] = expected;
    }
    return parameters[index - 1] ?? NULL_LITERAL_TYPE;
  } };
  let columns: Description["columns"] = [];
  const check = (expression: Expression, scopes = typeScopes([], ctx), expected?: DataType): void => {
    if (expression.kind !== "Default") evaluateExpression(expression, evalContextFor(scopes, ctx, true), expected);
  };
  if (stmt.kind === "Query") {
    // WHERE 등에서 얻은 타입을 선택 목록에도 반영한다.
    inferOutputColumns(stmt, ctx);
    columns = inferOutputColumns(stmt, ctx).map(column => ({ ...column, nullable: "UNKNOWN" }));
    if (stmt.body.kind === "Select") {
      const scopes = typeScopes(stmt.body.from.map(ref => bindSource(ctx.manager, ref, ctx.currentTablespace)), ctx);
      const outputScopes = [{ tablespace: null, table: null, alias: null, slots: columns.map(c => ({ column: c.name, value: null, type: c.type })) }];
      for (const order of stmt.orderBy) {
        const expression = order.expression;
        if (expression.kind === "Column" && expression.qualifier.length === 0 && columns.some(c => c.name === expression.name)) check(expression, outputScopes);
        else check(expression, scopes);
      }
    }
  } else if (stmt.kind === "Insert" || stmt.kind === "Update" || stmt.kind === "Delete") {
    const bound = bindSource(ctx.manager, { kind: "Table", name: stmt.target, alias: stmt.kind === "Insert" ? null : stmt.alias }, ctx.currentTablespace);
    const scopes = typeScopes([bound], ctx);
    const slots = scopes.flatMap(scope => scope.slots);
    const expected = (name: string): DataType => {
      const column = slots.find(slot => slot.column === name);
      if (column === undefined) throw new DbError("42703", ERROR_CODES.COLUMN_NOT_FOUND, `Column does not exist: "${name}".`);
      return column.type;
    };
    if (stmt.kind === "Insert") {
      const target = stmt.columns ?? slots.map(slot => slot.column);
      target.forEach(expected);
      if (stmt.source.kind === "Values") {
        for (const row of stmt.source.rows) {
          if (row.length !== target.length) throw new DbError("42601", ERROR_CODES.INSERT_VALUE_MISMATCH, "INSERT value count does not match column count.");
          row.forEach((expression, i) => check(expression, [], expected(target[i]!)));
        }
      } else if (stmt.source.kind === "Query") {
        const source = inferOutputColumns(stmt.source.query, ctx);
        if (source.length !== target.length) throw new DbError("42601", ERROR_CODES.INSERT_VALUE_MISMATCH, "INSERT query column count does not match.");
      }
    } else {
      if (stmt.kind === "Update") stmt.assignments.forEach(assignment => check(assignment.value, scopes, expected(assignment.column)));
      if (stmt.where !== null) check(stmt.where, scopes);
    }
  } else if (stmt.kind === "CreateView") {
    inferOutputColumns(stmt.query, ctx);
  } else if (stmt.kind === "CreateIndex") {
    const bound = bindSource(ctx.manager, { kind: "Table", name: stmt.table, alias: null }, ctx.currentTablespace);
    const scopes = typeScopes([bound], ctx);
    for (const column of stmt.columns) check({ kind: "Column", qualifier: [], name: column.name, position: stmt.table.position }, scopes);
  }
  return { resultKind: stmt.kind === "Query" ? "rows" : "ok", columns, parameters };
}
