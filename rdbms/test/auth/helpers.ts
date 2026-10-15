/**
 * 계정과 권한 테스트의 공용 도우미 (8단계).
 * 테스트를 등록하지 않으므로 여러 테스트 파일에서 import해도 중복 실행되지 않는다.
 * 관련 사양 : AGENTS.md 상세 4, 5, 6
 * 구현 단계 : 8단계
 */
import { Database } from "../../src/session/session.js";
import type { Session } from "../../src/session/session.js";
import { selectStrings, state, tempDir } from "../exec/helpers.js";

export { selectStrings, state, tempDir };

/** 권한이 없어 거부된 오류인지 확인하는 판정 함수이다. */
export const denied = state("42501");

export interface AuthFixture {
  dir: string;
  db: Database;
  /** SYSTEM 계정(DBA)의 세션이다. APP 테이블스페이스를 만들어 두었고 현재 테이블스페이스는 SYSTEM 이다. */
  admin: Session;
}

/** 새 데이터베이스를 열고 APP 테이블스페이스를 만든다. SCRAM 반복 횟수를 줄여 시험을 빠르게 한다. */
export function setupAuth(t: { after(fn: () => void): void }): AuthFixture {
  const dir = tempDir(t);
  const db = Database.open(dir, { onWarning: () => {}, scramIterations: 1000 });
  const admin = db.createSession({});
  admin.execute("CREATE TABLESPACE APP");
  return { dir, db, admin };
}

/** 사용자를 만든다. 기본 테이블스페이스는 지정하지 않으면 없다. */
export function makeUser(admin: Session, name: string, defaultTablespace?: string): void {
  const suffix = defaultTablespace === undefined ? "" : ` DEFAULT TABLESPACE ${defaultTablespace}`;
  admin.execute(`CREATE USER ${name} IDENTIFIED BY '${name.toLowerCase()}-pw'${suffix}`);
}

/** 조회 결과의 행을 문자열 표로 돌려준다. */
export function rows(session: Session, sql: string): string[][] {
  return selectStrings(session.execute(sql)).rows;
}
