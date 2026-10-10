/**
 * 이름과 타입 검사 (의미 분석).
 *
 * 담당
 *  - 구문 트리의 이름을 카탈로그의 실제 객체와 컬럼에 연결한다. 없는 이름이나 모호한 이름은 오류이다.
 *  - 식의 타입을 정하고, 타입이 맞지 않는 연산과 비교를 가려낸다.
 *  - 생략된 부분에 기본값을 채운다. (예 : INSERT 의 컬럼 목록, 타입의 길이)
 *  - 뷰 전개 : 뷰를 참조한 곳을 뷰의 정의로 바꾼다.
 *    어떤 객체를 뷰를 거쳐 참조했는지 남겨, 권한 검사가 뷰 권한 규칙을 적용할 수 있게 한다.
 *  - 갱신 가능한 뷰인지 판정한다.
 *
 * 관련 사양 : AGENTS.md 상세 1-2, 1-3, 1-4, 5, 13
 * 구현 단계 : 6단계
 */

import { DbError, ERROR_CODES, withPosition } from "../common/errors.js";
import type { SourcePosition } from "../common/errors.js";
import type {
  ColumnExpression,
  Expression,
  ObjectName,
  Query,
  Select,
  TableReference,
} from "../sql/ast.js";
import { parseStatement } from "../sql/parser.js";
import type { CatalogStore, StoredTable, StoredView } from "../catalog/catalog.js";
import type { TablespaceManager } from "../catalog/tablespaceManager.js";
import { getDictionaryColumns, isDictionaryView } from "../catalog/dictionaryViews.js";
import { containsAggregate, sameExpression } from "./expression.js";

function fail(sqlState: string, code: number, message: string, position: SourcePosition): never {
  throw withPosition(new DbError(sqlState, code, message), position);
}

// ---------------------------------------------------------------------------
// 바인딩된 데이터 출처
// ---------------------------------------------------------------------------

export type BoundSource =
  | { kind: "table"; tablespace: string; table: string; alias: string | null; def: StoredTable; catalog: CatalogStore }
  | { kind: "view"; tablespace: string; view: string; alias: string | null; def: StoredView; query: Query }
  | { kind: "derived"; query: Query; alias: string | null; columns: string[] | null }
  | { kind: "join"; type: "INNER" | "LEFT" | "RIGHT" | "FULL" | "CROSS"; left: BoundSource; right: BoundSource; on: Expression | null; using: string[] | null }
  | { kind: "dual" }
  | { kind: "dictionary"; view: string }
  | { kind: "bare" };

/** FROM 출처를 카탈로그에 연결한다. 뷰는 정의를 함께 들고 온다. */
export function bindSource(
  manager: TablespaceManager,
  reference: TableReference,
  currentTablespace: string,
  viewStack: readonly string[] = [],
): BoundSource {
  switch (reference.kind) {
    case "Table":
      return bindTable(manager, reference.name, reference.alias, currentTablespace, viewStack, reference.name.position);
    case "Derived": {
      return { kind: "derived", query: reference.query, alias: reference.alias, columns: reference.columns };
    }
    case "Join": {
      return {
        kind: "join",
        type: reference.type,
        left: bindSource(manager, reference.left, currentTablespace, viewStack),
        right: bindSource(manager, reference.right, currentTablespace, viewStack),
        on: reference.on,
        using: reference.using,
      };
    }
  }
}

function bindTable(
  manager: TablespaceManager,
  name: ObjectName,
  alias: string | null,
  currentTablespace: string,
  viewStack: readonly string[],
  position: SourcePosition,
): BoundSource {
  const tablespace = name.tablespace ?? currentTablespace;
  const objectName = name.name;
  // DUAL 과 딕셔너리는 사용자 객체보다 나중에 본다. 같은 이름의 사용자 객체가 있으면 그것을 쓴다.
  if (name.tablespace === null || tablespace === currentTablespace) {
    try {
      const current = manager.requireCatalog(currentTablespace);
      if (current.data.tables[objectName] !== undefined) {
        const def = current.data.tables[objectName] as StoredTable;
        return { kind: "table", tablespace: currentTablespace, table: objectName, alias, def, catalog: current };
      }
      if (current.data.views[objectName] !== undefined) {
        return bindView(manager, currentTablespace, objectName, alias, viewStack, position);
      }
    } catch {
      // 사용 불가 상태에서는 아래의 가상 객체로 풀 수 있게 둔다.
    }
  } else {
    if (!manager.has(tablespace)) {
      fail("3D000", ERROR_CODES.TABLESPACE_NOT_FOUND, `Tablespace does not exist: "${tablespace}".`, position);
    }
    try {
      const catalog = manager.requireCatalog(tablespace);
      if (catalog.data.tables[objectName] !== undefined) {
        const def = catalog.data.tables[objectName] as StoredTable;
        return { kind: "table", tablespace, table: objectName, alias, def, catalog };
      }
      if (catalog.data.views[objectName] !== undefined) {
        return bindView(manager, tablespace, objectName, alias, viewStack, position);
      }
    } catch (error) {
      if (error instanceof DbError) throw error;
      throw error;
    }
    if (objectName === "DUAL") return { kind: "dual" };
    if (isDictionaryView(objectName) && tablespace === "SYSTEM") {
      return { kind: "dictionary", view: objectName };
    }
    fail("42P01", ERROR_CODES.TABLE_NOT_FOUND, `Object does not exist: "${tablespace}.${objectName}".`, position);
  }
  if (objectName === "DUAL") return { kind: "dual" };
  if (isDictionaryView(objectName) && (tablespace === "SYSTEM" || name.tablespace === null)) {
    return { kind: "dictionary", view: objectName };
  }
  fail("42P01", ERROR_CODES.TABLE_NOT_FOUND, `Object does not exist: "${tablespace}.${objectName}".`, position);
}

function bindView(
  manager: TablespaceManager,
  tablespace: string,
  viewName: string,
  alias: string | null,
  viewStack: readonly string[],
  position: SourcePosition,
): BoundSource {
  const key = `${tablespace}.${viewName}`;
  if (viewStack.includes(key)) {
    fail("42P17", ERROR_CODES.INVALID_VIEW_DEFINITION, `View depends on itself: "${key}".`, position);
  }
  const catalog = manager.requireCatalog(tablespace);
  const def = catalog.data.views[viewName] as StoredView | undefined;
  if (def === undefined) {
    fail("42P01", ERROR_CODES.VIEW_NOT_FOUND, `View does not exist: "${key}".`, position);
  }
  const parsed = parseStatement(def.queryText);
  if (parsed.statement.kind !== "Query") {
    fail("42P17", ERROR_CODES.INVALID_VIEW_DEFINITION, `View definition is not a query: "${key}".`, position);
  }
  return { kind: "view", tablespace, view: viewName, alias, def, query: parsed.statement };
}

/** 출처의 별칭을 돌려준다. 없으면 테이블 이름이다. */
export function sourceAlias(source: BoundSource): string | null {
  switch (source.kind) {
    case "table":
      return source.alias ?? source.table;
    case "view":
      return source.alias ?? source.view;
    case "derived":
      return source.alias;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 갱신 가능한 뷰
// ---------------------------------------------------------------------------

/** 뷰 정의를 갱신 가능한지 본다. FROM에 테이블(또는 갱신 가능한 뷰) 하나만 있어야 한다. */
export function isUpdatableQuery(query: Query): boolean {
  const body = query.body;
  if (body.kind !== "Select") return false;
  if (body.kind === "Select") {
    if (body.distinct || body.groupBy.length > 0 || body.having !== null) return false;
    if (body.from.length !== 1) return false;
    const only = body.from[0] as TableReference;
    if (only.kind === "Join") return false;
    if (only.kind === "Derived") return false;
    // 집계 함수와 집합 연산이 없어야 한다.
    if (queryBodyHasSetOperation(query)) return false;
    if (selectHasAggregate(body)) return false;
    return true;
  }
  return false;
}

function queryBodyHasSetOperation(query: Query): boolean {
  const stack: unknown[] = [query.body];
  while (stack.length > 0) {
    const body = stack.pop() as { kind?: string; left?: unknown; right?: unknown; body?: unknown };
    if (body === null || typeof body !== "object") continue;
    if (body.kind === "SetOperation") return true;
    if (body.kind === "Query" && body.body !== undefined) {
      stack.push(body.body);
      continue;
    }
  }
  return false;
}

function selectHasAggregate(select: Select): boolean {
  const stack: Expression[] = [];
  for (const item of select.items) {
    if (item.kind === "Expression") stack.push(item.expression);
  }
  if (select.where !== null) stack.push(select.where);
  if (select.having !== null) stack.push(select.having);
  for (const order of (select as unknown as { orderBy?: { expression: Expression }[] }).orderBy ?? []) {
    stack.push(order.expression);
  }
  while (stack.length > 0) {
    const expression = stack.pop() as Expression;
    if (containsAggregate(expression)) return true;
  }
  return false;
}

/** 갱신 가능한 뷰의 열 대응을 구한다. 직접 참조한 열만 값을 넣거나 바꿀 수 있다. */
export function viewColumnMapping(
  manager: TablespaceManager,
  tablespace: string,
  viewName: string,
  viewStack: readonly string[] = [],
): { baseTablespace: string; baseTable: string; map: Map<string, string | null> } {
  const catalog = manager.requireCatalog(tablespace);
  const def = catalog.data.views[viewName] as StoredView | undefined;
  if (def === undefined) {
    throw new DbError("42P01", ERROR_CODES.VIEW_NOT_FOUND, `View does not exist: "${tablespace}.${viewName}".`);
  }
  const parsed = parseStatement(def.queryText);
  const query = parsed.statement;
  if (query.kind !== "Query" || !isUpdatableQuery(query)) {
    throw new DbError("42P17", ERROR_CODES.INVALID_VIEW_DEFINITION, `View "${viewName}" is not updatable.`);
  }
  const body = query.body as Select;
  const only = body.from[0] as TableReference;
  if (only.kind !== "Table") {
    throw new DbError("42P17", ERROR_CODES.INVALID_VIEW_DEFINITION, `View "${viewName}" is not updatable.`);
  }
  const baseTablespace = only.name.tablespace ?? tablespace;
  // 기반이 다시 뷰이면 재귀로 푼다.
  try {
    const baseCatalog = manager.requireCatalog(baseTablespace);
    if (baseCatalog.data.views[only.name.name] !== undefined) {
      const inner = viewColumnMapping(manager, baseTablespace, only.name.name, [...viewStack, `${tablespace}.${viewName}`]);
      // 바깥 뷰의 선택 목록을 안쪽 대응에 맞춘다.
      const map = new Map<string, string | null>();
      const items = body.items;
      def.columns.forEach((viewColumn, index) => {
        const item = items[index];
        if (item === undefined || item.kind !== "Expression" || item.expression.kind !== "Column") {
          map.set(viewColumn, null);
          return;
        }
        const innerName = item.expression.name;
        map.set(viewColumn, inner.map.get(innerName) ?? null);
      });
      return { baseTablespace: inner.baseTablespace, baseTable: inner.baseTable, map };
    }
  } catch (error) {
    if (error instanceof DbError) throw error;
    throw error;
  }
  const map = new Map<string, string | null>();
  const items = body.items;
  // 선택 목록이 * 이면 기반 테이블의 모든 열이 순서대로 대응한다.
  const starIndex = items.findIndex((item) => item.kind === "Star");
  if (starIndex >= 0) {
    const baseCatalog = manager.requireCatalog(baseTablespace);
    const baseTable = baseCatalog.data.tables[only.name.name] as StoredTable | undefined;
    const baseColumns = baseTable?.columns.map((column) => column.name) ?? [];
    baseColumns.forEach((baseColumn, index) => {
      const viewColumn = def.columns[index];
      if (viewColumn !== undefined) map.set(viewColumn, baseColumn);
    });
    return { baseTablespace, baseTable: only.name.name, map };
  }
  def.columns.forEach((viewColumn, index) => {
    const item = items[index];
    if (item === undefined || item.kind !== "Expression") {
      map.set(viewColumn, null);
      return;
    }
    if (item.expression.kind === "Column" && item.expression.qualifier.length === 0) {
      map.set(viewColumn, item.expression.name);
    } else {
      map.set(viewColumn, null);
    }
  });
  return { baseTablespace, baseTable: only.name.name, map };
}

/** 식 안의 뷰 열 참조를 기반 테이블 참조로 바꾼다. */
export function rewriteViewColumns(
  expression: Expression,
  viewNameOrAlias: string,
  baseTable: string,
  columnMap: Map<string, string | null>,
): Expression {
  const clone = JSON.parse(JSON.stringify(expression)) as Expression;
  const rewrite = (node: Expression): void => {
    if (node.kind === "Column") {
      const qualifier = node.qualifier;
      const matchesView = qualifier.length === 0 || (qualifier.length === 1 && qualifier[0] === viewNameOrAlias);
      if (matchesView) {
        const base = columnMap.get(node.name);
        if (base === undefined) {
          throw new DbError("42703", ERROR_CODES.COLUMN_NOT_FOUND, `Column does not exist: "${node.name}".`);
        }
        if (base === null) {
          throw new DbError("42P17", ERROR_CODES.INVALID_VIEW_DEFINITION, `Column "${node.name}" of the view is not updatable.`);
        }
        node.qualifier = [];
        node.name = base;
        void baseTable;
      }
      return;
    }
    for (const value of Object.values(node as unknown as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry !== null && typeof entry === "object" && "kind" in (entry as object)) {
            rewrite(entry as Expression);
          } else if (entry !== null && typeof entry === "object") {
            rewriteObject(entry as Record<string, unknown>);
          }
        }
      } else if (value !== null && typeof value === "object") {
        if ("kind" in (value as object) && typeof (value as { kind?: unknown }).kind === "string") {
          rewrite(value as Expression);
        } else {
          rewriteObject(value as Record<string, unknown>);
        }
      }
    }
  };
  const rewriteObject = (object: Record<string, unknown>): void => {
    for (const value of Object.values(object)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry !== null && typeof entry === "object" && "kind" in (entry as object)) rewrite(entry as Expression);
        }
      } else if (value !== null && typeof value === "object" && "kind" in (value as object)) {
        rewrite(value as Expression);
      }
    }
  };
  rewrite(clone);
  return clone;
}

// ---------------------------------------------------------------------------
// GROUP BY 검사
// ---------------------------------------------------------------------------

/** 집계 바깥의 열 참조를 모은다. 서브쿼리 안은 내려가지 않는다. */
function columnsOutsideAggregates(expression: Expression): ColumnExpression[] {
  const found: ColumnExpression[] = [];
  const walk = (node: Expression, insideAggregate: boolean): void => {
    switch (node.kind) {
      case "Column":
        if (!insideAggregate) found.push(node);
        return;
      case "Function":
        if (isAggregateName(node.name)) {
          return;
        }
        for (const arg of node.arguments) walk(arg, insideAggregate);
        return;
      case "InSubquery":
      case "Exists":
      case "Quantified":
      case "Subquery":
        return;
      case "Unary":
        walk(node.operand, insideAggregate);
        return;
      case "Binary":
        walk(node.left, insideAggregate);
        walk(node.right, insideAggregate);
        return;
      case "Logical":
        for (const operand of node.operands) walk(operand, insideAggregate);
        return;
      case "IsNull":
      case "IsBoolean":
        walk(node.operand, insideAggregate);
        return;
      case "Between":
        walk(node.operand, insideAggregate);
        walk(node.low, insideAggregate);
        walk(node.high, insideAggregate);
        return;
      case "InList":
        walk(node.operand, insideAggregate);
        for (const item of node.items) walk(item, insideAggregate);
        return;
      case "Like":
        walk(node.operand, insideAggregate);
        walk(node.pattern, insideAggregate);
        if (node.escape !== null) walk(node.escape, insideAggregate);
        return;
      case "Case":
        if (node.operand !== null) walk(node.operand, insideAggregate);
        for (const branch of node.branches) {
          walk(branch.when, insideAggregate);
          walk(branch.then, insideAggregate);
        }
        if (node.otherwise !== null) walk(node.otherwise, insideAggregate);
        return;
      case "Cast":
        walk(node.operand, insideAggregate);
        return;
      case "Extract":
        walk(node.operand, insideAggregate);
        return;
      case "Trim":
        if (node.characters !== null) walk(node.characters, insideAggregate);
        walk(node.operand, insideAggregate);
        return;
      default:
        return;
    }
  };
  walk(expression, false);
  return found;
}

function isAggregateName(name: string): boolean {
  return name === "COUNT" || name === "SUM" || name === "AVG" || name === "MIN" || name === "MAX";
}

/** GROUP BY와 집계의 규칙을 검사한다. */
export function validateGroupBy(select: Select, position: SourcePosition): void {
  const hasGroupBy = select.groupBy.length > 0;
  const selectHasAggregate = select.items.some(
    (item) => item.kind === "Expression" && containsAggregate(item.expression),
  ) || (select.having !== null && containsAggregate(select.having));
  if (!hasGroupBy && !selectHasAggregate) return;
  if (!hasGroupBy && selectHasAggregate) {
    // 전역 집계 : 집계 바깥의 열 참조가 있으면 오류이다.
    for (const item of select.items) {
      if (item.kind !== "Expression") continue;
      if (columnsOutsideAggregates(item.expression).length > 0) {
        fail("42803", ERROR_CODES.GROUPING_ERROR, "Column must appear in GROUP BY or be used in an aggregate.", position);
      }
    }
    if (select.having !== null && columnsOutsideAggregates(select.having).length > 0) {
      fail("42803", ERROR_CODES.GROUPING_ERROR, "Column must appear in GROUP BY or be used in an aggregate.", position);
    }
    return;
  }
  // GROUP BY가 있으면 집계 바깥의 열은 GROUP BY 식 안에 있어야 한다.
  // 집계 없는 식 전체가 GROUP BY 식과 같아도 된다. (예 : GROUP BY SUBSTRING(...)의 그 식)
  // 열이 하나도 없는 식(상수)은 항상 된다.
  const check = (expression: Expression): void => {
    if (columnsOutsideAggregates(expression).length === 0) return;
    if (!containsAggregate(expression)) {
      if (select.groupBy.some((group) => sameExpression(group, expression))) return;
      fail("42803", ERROR_CODES.GROUPING_ERROR, "Expression must appear in GROUP BY.", expression.position);
    }
    for (const column of columnsOutsideAggregates(expression)) {
      const matched = select.groupBy.some((group) => sameExpression(group, column));
      if (!matched) {
        fail("42803", ERROR_CODES.GROUPING_ERROR, `Column "${column.name}" must appear in GROUP BY.`, column.position);
      }
    }
  };
  for (const item of select.items) {
    if (item.kind !== "Expression") continue;
    check(item.expression);
  }
  if (select.having !== null) check(select.having);
}

export type { ColumnExpression };
