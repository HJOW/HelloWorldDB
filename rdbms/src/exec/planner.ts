/**
 * 실행 계획.
 *
 * 담당
 *  - 검사를 마친 질의를 실행 단계의 조합으로 바꾼다 : 스캔, 조건, 조인, 집계, 정렬, 집합 연산, 행 수 제한
 *  - 규칙 기반으로 인덱스를 고른다. 조건절이 인덱스의 앞쪽 컬럼에 대한 동등 또는 범위 조건이면 인덱스를 쓴다.
 *
 * 통계 정보를 쓰는 비용 기반 최적화는 하지 않는다.
 *
 * 관련 사양 : AGENTS.md 상세 1-4, 10
 * 구현 단계 : 6단계
 */

import type { Expression } from "../sql/ast.js";
import type { DataType } from "../types/dataType.js";
import type { CatalogStore, StoredTable } from "../catalog/catalog.js";
import type { TypedValue } from "./functions.js";

/** 앞쪽 컬럼 조건으로 고른 인덱스이다. */
export interface IndexChoice {
  readonly name: string;
  readonly indexRoot: number;
  readonly unique: boolean;
  readonly columns: { name: string; descending: boolean; type: DataType }[];
  /** 동등 조건으로 묶인 앞쪽 컬럼 수이다. */
  readonly prefixCount: number;
  readonly prefixValues: TypedValue[];
  readonly lower: { value: TypedValue; inclusive: boolean } | null;
  readonly upper: { value: TypedValue; inclusive: boolean } | null;
}

/** 상수를 평가한다. 컬럼 참조가 섞이면 null 을 돌려준다. */
export type ConstantEvaluator = (expression: Expression) => TypedValue | null;

/** WHERE 를 AND 단위로 나눈다. */
function conjuncts(where: Expression | null): Expression[] {
  if (where === null) return [];
  if (where.kind === "Logical" && where.operator === "AND") return [...where.operands];
  return [where];
}

/** `컬럼 = 상수` 또는 `상수 = 컬럼` 형태인지 본다. */
function equalityTarget(
  condition: Expression,
  tableName: string,
  alias: string | null,
  evalConstant: ConstantEvaluator,
): { column: string; value: TypedValue } | null {
  if (condition.kind !== "Binary" || condition.operator !== "=") return null;
  const leftColumn = columnOf(condition.left, tableName, alias);
  const rightColumn = columnOf(condition.right, tableName, alias);
  if (leftColumn !== null && rightColumn === null) {
    const constant = evalConstant(condition.right);
    if (constant === null || constant.value === null) return null;
    return { column: leftColumn, value: constant };
  }
  if (rightColumn !== null && leftColumn === null) {
    const constant = evalConstant(condition.left);
    if (constant === null || constant.value === null) return null;
    return { column: rightColumn, value: constant };
  }
  return null;
}

/** 이 테이블의 맨 컬럼 참조인지 본다. 맞으면 컬럼 이름을 돌려준다. */
function columnOf(expression: Expression, tableName: string, alias: string | null): string | null {
  if (expression.kind !== "Column") return null;
  const qualifier = expression.qualifier;
  if (qualifier.length === 0) return expression.name;
  if (qualifier.length === 1 && (qualifier[0] === tableName || qualifier[0] === alias)) return expression.name;
  return null;
}

/**
 * 조건절의 앞쪽 컬럼에 대한 동등 또는 범위 조건이 있으면 인덱스를 고른다.
 * 없으면 null 이며 전체 스캔을 한다. 가장 길게 묶이는 인덱스를 고른다.
 */
export function chooseIndex(
  catalog: CatalogStore,
  table: StoredTable,
  tableAlias: string | null,
  where: Expression | null,
  evalConstant: ConstantEvaluator,
): IndexChoice | null {
  const conditions = conjuncts(where);
  if (conditions.length === 0) return null;
  const columnTypes = new Map(table.columns.map((column) => [column.name, column.dataType]));
  const candidates: { name: string; indexRoot: number; unique: boolean; columns: { name: string; descending: boolean }[] }[] = [];
  if (table.pkName !== null && table.pkIndexRoot !== null) {
    candidates.push({
      name: table.pkName,
      indexRoot: table.pkIndexRoot,
      unique: true,
      columns: table.pkColumns.map((name) => ({ name, descending: false })),
    });
  }
  for (const index of Object.values(catalog.data.indexes)) {
    if (index.table !== table.name) continue;
    candidates.push({ name: index.name, indexRoot: index.indexRoot, unique: index.unique, columns: index.columns });
  }
  let best: IndexChoice | null = null;
  for (const candidate of candidates) {
    const typedColumns = candidate.columns.map((column) => ({
      name: column.name,
      descending: column.descending,
      type: columnTypes.get(column.name) as DataType,
    }));
    if (typedColumns.some((column) => column.type === undefined)) continue;
    const prefixValues: TypedValue[] = [];
    let prefixCount = 0;
    let lower: IndexChoice["lower"] = null;
    let upper: IndexChoice["upper"] = null;
    let usable = false;
    for (let position = 0; position < typedColumns.length; position++) {
      const column = typedColumns[position] as { name: string; descending: boolean; type: DataType };
      // 동등 조건을 먼저 찾는다.
      let equality: { column: string; value: TypedValue } | null = null;
      for (const condition of conditions) {
        const found = equalityTarget(condition, table.name, tableAlias, evalConstant);
        if (found !== null && found.column === column.name) {
          equality = found;
          break;
        }
      }
      if (equality !== null) {
        prefixValues.push((equality as { value: TypedValue }).value);
        prefixCount++;
        continue;
      }
      break;
    }
    // 범위 조건을 앞쪽(prefix) 다음 컬럼에서 찾는다.
    if (prefixCount < typedColumns.length) {
      const column = typedColumns[prefixCount] as { name: string; descending: boolean; type: DataType };
      for (const condition of conditions) {
        if (condition.kind === "Between" && !condition.negated) {
          const target = columnOf(condition.operand, table.name, tableAlias);
          if (target !== column.name) continue;
          const low = evalConstant(condition.low);
          const high = evalConstant(condition.high);
          if (low === null || high === null || low.value === null || high.value === null) continue;
          lower = { value: low, inclusive: true };
          upper = { value: high, inclusive: true };
          usable = true;
          break;
        }
        if (condition.kind === "Binary") {
          const operator = condition.operator;
          if (operator !== ">" && operator !== ">=" && operator !== "<" && operator !== "<=") continue;
          const leftColumn = columnOf(condition.left, table.name, tableAlias);
          const rightColumn = columnOf(condition.right, table.name, tableAlias);
          if (leftColumn === column.name && rightColumn === null) {
            const constant = evalConstant(condition.right);
            if (constant === null || constant.value === null) continue;
            if (operator === ">" || operator === ">=") lower = { value: constant, inclusive: operator === ">=" };
            else upper = { value: constant, inclusive: operator === "<=" };
            usable = true;
            break;
          }
          if (rightColumn === column.name && leftColumn === null) {
            const constant = evalConstant(condition.left);
            if (constant === null || constant.value === null) continue;
            if (operator === ">" || operator === ">=") upper = { value: constant, inclusive: operator === ">=" };
            else lower = { value: constant, inclusive: operator === "<=" };
            usable = true;
            break;
          }
        }
      }
    }
    if (prefixCount === 0 && !usable) continue;
    const choice: IndexChoice = {
      name: candidate.name,
      indexRoot: candidate.indexRoot,
      unique: candidate.unique,
      columns: typedColumns,
      prefixCount,
      prefixValues,
      lower,
      upper,
    };
    if (best === null || choice.prefixCount > best.prefixCount || (choice.prefixCount === best.prefixCount && choice.unique && !best.unique)) {
      best = choice;
    }
  }
  return best;
}
