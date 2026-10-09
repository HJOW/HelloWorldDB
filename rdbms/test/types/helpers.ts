/**
 * 담당 : 타입 시스템 테스트가 함께 쓰는 도우미.
 * 관련 사양 : AGENTS.md 상세 1-1, 1-2.
 * 구현 단계 : 3단계.
 */
import assert from "node:assert/strict";
import { DbError } from "../../src/common/errors.js";
import type { TypeContext } from "../../src/types/cast.js";
import { intervalType, resolveDataType } from "../../src/types/dataType.js";
import type { DataType, IntervalDataType, IntervalField } from "../../src/types/dataType.js";
import { resolveTimeZone } from "../../src/types/datetime.js";
import { castLiteral } from "../../src/types/cast.js";
import type { SqlValue } from "../../src/types/value.js";

/** 오류의 SQLSTATE 를 확인한다. */
export function assertSqlState(operation: () => unknown, sqlState: string): void {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof DbError, `DbError expected but got: ${String(error)}`);
    assert.equal(error.sqlState, sqlState, error.message);
    return true;
  });
}

/** 도우미로 만든 INTERVAL 정의가 resolveDataType 이 받아들이는 한정자인지 확인한다. */
function conformIntervalDefinition(definition: IntervalDataType): IntervalDataType {
  const name = definition.startField === definition.endField
    ? `INTERVAL ${definition.startField}`
    : `INTERVAL ${definition.startField} TO ${definition.endField}`;
  resolveDataType(name);
  return definition;
}

const INTERVAL_REGEX =/^INTERVAL (\w+)(?:\((\d+)(?:,(\d+))?\))?(?: TO (\w+)(?:\((\d+)\))?)?$/;

/**
 * `VARCHAR(10)`, `DECIMAL(10,3)`, `TIME(3) WITH TIME ZONE` 처럼 SQL 표기로 적은 타입을 해석한다.
 * INTERVAL 은 `INTERVAL DAY(3) TO SECOND(2)` 처럼 선행 정밀도와 소수 초 자릿수를 필드 뒤에 적는다.
 * `INTERVAL SECOND(3)` 의 인자 하나는 resolveDataType 과 같이 소수 초 자릿수이다.
 */
export function type(text: string): DataType {
  const interval = INTERVAL_REGEX.exec(text);
  if (interval !== null) {
    const start = interval[1] as IntervalField;
    const end = (interval[4] ?? start) as IntervalField;
    let leading: string | undefined = interval[2];
    let fraction: string | undefined = interval[5] ?? interval[3];
    if (start === "SECOND" && interval[3] === undefined) {
      fraction = interval[2];
      leading = undefined;
    }
    return conformIntervalDefinition(intervalType(
      start,
      end,
      leading === undefined ? undefined : Number(leading),
      fraction === undefined ? undefined : Number(fraction),
    ));
  }
  const parameters: number[] = [];
  const name = text.replace(/\(([^)]*)\)/g, (_, inner: string) => {
    for (const part of inner.split(",")) parameters.push(Number(part.trim()));
    return "";
  });
  return resolveDataType(name, ...parameters);
}

/** 2026-10-09 12:00:00 UTC 를 현재 시각으로 하는 형변환 문맥. */
export function context(timeZone = "+09:00"): TypeContext {
  return {
    timeZone: resolveTimeZone(timeZone),
    currentUtcMicros: BigInt(Date.UTC(2026, 9, 9, 12, 0, 0)) * 1_000n,
  };
}

/** 문자열 표기를 주어진 타입의 값으로 만든다. */
export function value(text: string | null, typeText: string, timeZone = "+09:00"): SqlValue {
  return castLiteral(text, type(typeText), context(timeZone));
}

/** 재현할 수 있는 난수. 속성 기반 테스트에 쓴다. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
