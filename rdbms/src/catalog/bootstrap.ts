/**
 * 최초 구동 시의 초기 구성.
 *
 * 담당
 *  - 데이터 디렉토리에 SYSTEM 테이블스페이스가 없으면 새로 만든다.
 *  - 서버 전체에 걸친 정보를 담을 내부 저장 구조를 만든다 :
 *    사용자, 권한, 권한 그룹 부여 내역, 테이블스페이스 목록
 *  - `DUAL` 을 만든다.
 *  - SYSTEM 계정을 만든다 : 암호 HelloWorldDB, 권한 그룹 DBA, 기본 테이블스페이스 SYSTEM (8단계)
 *
 * 이미 구성된 데이터 디렉토리에는 아무것도 하지 않는다.
 *
 * 관련 사양 : AGENTS.md 상세 3, 4
 * 구현 단계 : 5단계(SYSTEM 테이블스페이스), 8단계(SYSTEM 계정)
 */

import { TablespaceManager } from "./tablespaceManager.js";

/** DUAL 은 가상의 한 행짜리 테이블이다. 저장 파일에 따로 두지 않는다. */
export const DUAL_TABLESPACE = "SYSTEM";
export const DUAL_NAME = "DUAL";

/**
 * 데이터 디렉토리를 열고 SYSTEM 테이블스페이스를 준비한다.
 * 이미 있으면 열어만 두고, 없으면 새로 만든다. DUAL 과 SYSTEM 계정은 저장하지 않는다.
 * DUAL 은 조회할 때 가상으로 제공하고, SYSTEM 계정은 8단계에서 만든다.
 */
export function ensureSystemTablespace(
  dataDir: string,
  options: { serverVersion?: string; onWarning?: (message: string) => void } = {},
): TablespaceManager {
  return TablespaceManager.open(dataDir, options);
}
