/**
 * 인스턴스 식별 규칙과 공용 상수.
 *
 * 담당
 *  - 포트 번호로부터 로컬 전용 채널의 주소를 만든다.
 *      Windows : 네임드 파이프 \\.\pipe\helloworlddb-<포트>
 *      그 외   : 유닉스 도메인 소켓 /tmp/helloworlddb-<포트>.sock
 *  - 제품 이름, RDBMS 버전, 기본 포트 번호(7410) 같은 공용 상수
 *
 * 데몬과 CLI 가 같은 규칙으로 서로를 찾아야 하므로 한곳에 둔다.
 * 포트 번호는 인스턴스를 가리키는 이름일 뿐이다.
 * 데이터 디렉토리나 데이터 파일의 이름, 내용에는 포트 번호를 넣지 않는다.
 *
 * 관련 사양 : AGENTS.md 상세 15
 * 구현 단계 : 1단계(상수), 9단계(로컬 전용 채널 주소)
 * 1단계에서는 상수와 주소 규칙, 잠금 파일 이름까지 확정한다.
 * 로컬 전용 채널 서버 자체는 9단계에서 구현한다.
 */

import path from "node:path";

/** 제품 이름. */
export const PRODUCT_NAME = "HelloWorldDB";

/** RDBMS 버전. package.json 의 version 과 함께 올린다. */
export const RDBMS_VERSION = "0.1.0";

/** 기본 포트 번호. TCP 와 UDP 가 함께 쓴다. */
export const DEFAULT_PORT = 7410;

/** 데이터 디렉토리 안에 두는 잠금 파일의 이름. */
export const LOCK_FILE_NAME = "helloworlddb.lock";

/** 로그 디렉토리 안에 두는 로그 파일의 이름. */
export const LOG_FILE_NAME = "helloworlddb.log";

/** 포트 번호가 유효한지 확인한다. */
export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * 포트 번호로부터 로컬 전용 채널의 주소를 만든다.
 * Windows 에서는 네임드 파이프, 그 외에서는 유닉스 도메인 소켓 경로이다.
 */
export function getLocalChannelAddress(port: number): string {
  if (!isValidPort(port)) {
    throw new Error(`Invalid port number: ${String(port)}`);
  }
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\helloworlddb-${port}`;
  }
  return `/tmp/helloworlddb-${port}.sock`;
}

/** 데이터 디렉토리 안의 잠금 파일 경로를 만든다. */
export function getLockFilePath(dataDir: string): string {
  return path.join(dataDir, LOCK_FILE_NAME);
}
