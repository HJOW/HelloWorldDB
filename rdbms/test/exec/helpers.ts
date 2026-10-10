/**
 * 실행 테스트의 공용 도우미 (6단계).
 * 테스트를 등록하지 않으므로 여러 테스트 파일에서 import해도 중복 실행되지 않는다.
 * 관련 사양 : AGENTS.md 상세 1-4
 * 구현 단계 : 6단계
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../../src/session/session.js";
import type { ExecuteResult, Session } from "../../src/session/session.js";
import { DbError } from "../../src/common/errors.js";
import { formatValue } from "../../src/types/value.js";

export function state(code: string): (error: unknown) => boolean {
  return (error) => error instanceof DbError && error.sqlState === code;
}

export function tempDir(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hwdb-exec-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function openTestDb(dir: string): Database {
  return Database.open(dir, { onWarning: () => {} });
}

export function setupApp(t: { after(fn: () => void): void }): { db: Database; session: Session } {
  const dir = tempDir(t);
  const db = openTestDb(dir);
  const session = db.createSession({});
  session.execute("CREATE TABLESPACE APP");
  session.execute("USE APP");
  return { db, session };
}

/** 조회 결과를 문자열 표로 바꾼다. NULL은 "NULL"이다. */
export function selectStrings(result: ExecuteResult): { columns: string[]; rows: string[][] } {
  if (result.kind !== "select") throw new Error("Not a select result.");
  return {
    columns: result.columns.map((column) => column.name),
    rows: result.rows.map((row) =>
      row.map((value, index) =>
        value === null
          ? "NULL"
          : formatValue(value, (result.columns[index] as { dataType: import("../../src/types/dataType.js").DataType }).dataType),
      ),
    ),
  };
}

void assert;
