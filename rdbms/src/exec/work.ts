/**
 * 동기 API와 협력적 비동기 실행이 공유하는 실행 단계이다.
 * 관련 사양: AGENTS.md 상세 8-2, 10. 구현 단계: PD-4.
 */
import { DbError, ERROR_CODES } from "../common/errors.js";
import { withPosition } from "../common/errors.js";
import type { SourcePosition } from "../common/errors.js";

export type Work<T> = Generator<void, T, unknown>;
export class StatementChanged extends Error {}

export function runSync<T>(work: Work<T>): T {
  for (;;) {
    const next = work.next();
    if (next.done) return next.value;
  }
}

export class Execution {
  spillResults = false;
  guard?: () => void;
  cancelled = false;
  phase: "running" | "finalizing" | "done" = "running";
  check(): void {
    if (this.cancelled) throw new DbError("57014", ERROR_CODES.STATEMENT_CANCELLED, "Statement was cancelled.");
    this.guard?.();
  }
  cancel(): "accepted" | "tooLate" | "notRunning" {
    if (this.phase === "done") return "notRunning";
    if (this.phase === "finalizing") return "tooLate";
    this.cancelled = true;
    return "accepted";
  }
}

export async function runAsync<T>(work: Work<T>, execution: Execution): Promise<T> {
  let count = 0;
  let until = performance.now() + 4;
  try {
    for (;;) {
      execution.check();
      const next = work.next();
      if (next.done) return next.value;
      if (++count % 256 === 0 && performance.now() >= until) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        until = performance.now() + 4;
      }
    }
  } catch (error) {
    // 제너레이터 안의 finally를 실행하고 문장 복구는 Session에 맡긴다.
    work.return(undefined as T);
    throw error;
  }
}

export function* valueWork<T>(value: T | Work<T>): Work<T> {
  if (value !== null && typeof value === "object" && "next" in value) return yield* value as Work<T>;
  return value as T;
}

export function* mapWork<T, U>(items: readonly T[], fn: (value: T, index: number, array: readonly T[]) => Work<U>): Work<U[]> {
  const out: U[] = [];
  for (let i = 0; i < items.length; i++) { yield; out.push(yield* fn(items[i]!, i, items)); }
  return out;
}

export function* filterWork<T>(items: readonly T[], fn: (value: T, index: number) => Work<unknown>): Work<T[]> {
  const out: T[] = [];
  for (let i = 0; i < items.length; i++) { yield; if (yield* fn(items[i]!, i)) out.push(items[i]!); }
  return out;
}

export function* someWork<T>(items: readonly T[], fn: (value: T, index: number) => Work<unknown>): Work<boolean> {
  for (let i = 0; i < items.length; i++) { yield; if (yield* fn(items[i]!, i)) return true; }
  return false;
}

export function* everyWork<T>(items: readonly T[], fn: (value: T, index: number) => Work<unknown>): Work<boolean> {
  for (let i = 0; i < items.length; i++) { yield; if (!(yield* fn(items[i]!, i))) return false; }
  return true;
}

export function* findWork<T>(items: readonly T[], fn: (value: T, index: number) => Work<unknown>): Work<T | undefined> {
  for (let i = 0; i < items.length; i++) { yield; if (yield* fn(items[i]!, i)) return items[i]; }
  return undefined;
}

export function* forEachWork<T>(items: readonly T[], fn: (value: T, index: number) => Work<unknown>): Work<void> {
  for (let i = 0; i < items.length; i++) { yield; yield* fn(items[i]!, i); }
}

export function* flatMapWork<T, U>(items: readonly T[], fn: (value: T, index: number) => Work<U | readonly U[]>): Work<U[]> {
  const out: U[] = [];
  for (let i = 0; i < items.length; i++) { yield; const value = yield* fn(items[i]!, i); if (Array.isArray(value)) out.push(...value); else out.push(value as U); }
  return out;
}

export function* atWork<T>(position: SourcePosition, fn: () => Work<T>): Work<T> {
  try { return yield* fn(); }
  catch (error) { if (error instanceof DbError && error.position === undefined) throw withPosition(error, position); throw error; }
}

/** 안정 병합 정렬. 큰 Array.sort 호출로 이벤트 루프가 막히지 않는다. */
export function* sortWork<T>(items: T[], compare: (a: T, b: T) => number): Work<T[]> {
  let src = items.slice();
  let dest = new Array<T>(items.length);
  for (let width = 1; width < items.length; width *= 2) {
    for (let start = 0; start < items.length; start += width * 2) {
      const middle = Math.min(start + width, items.length), end = Math.min(start + width * 2, items.length);
      let a = start, b = middle;
      for (let i = start; i < end; i++) {
        yield;
        dest[i] = b >= end || (a < middle && compare(src[a]!, src[b]!) <= 0) ? src[a++]! : src[b++]!;
      }
    }
    [src, dest] = [dest, src];
  }
  for (let i = 0; i < items.length; i++) { yield; items[i] = src[i]!; }
  return items;
}
