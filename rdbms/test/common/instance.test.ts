/**
 * 인스턴스 식별 규칙 테스트 (1단계).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PORT,
  getLocalChannelAddress,
  getLockFilePath,
  isValidPort,
  LOCK_FILE_NAME,
  PRODUCT_NAME,
  RDBMS_VERSION,
} from "../../src/common/instance.js";

test("기본 포트와 제품 상수가 정해져 있다", () => {
  assert.equal(DEFAULT_PORT, 7410);
  assert.equal(PRODUCT_NAME, "HelloWorldDB");
  assert.match(RDBMS_VERSION, /^\d+\.\d+\.\d+$/);
});

test("포트 번호의 범위를 검사한다", () => {
  assert.equal(isValidPort(1), true);
  assert.equal(isValidPort(7410), true);
  assert.equal(isValidPort(65535), true);
  assert.equal(isValidPort(0), false);
  assert.equal(isValidPort(65536), false);
  assert.equal(isValidPort(74.1), false);
});

test("로컬 전용 채널 주소는 운영체제별로 다르다", () => {
  const address = getLocalChannelAddress(7410);
  if (process.platform === "win32") {
    assert.equal(address, "\\\\.\\pipe\\helloworlddb-7410");
  } else {
    assert.equal(address, "/tmp/helloworlddb-7410.sock");
  }
  assert.throws(() => getLocalChannelAddress(0), /Invalid port/);
});

test("잠금 파일은 데이터 디렉토리 안에 있다", () => {
  assert.equal(getLockFilePath("/data").endsWith(LOCK_FILE_NAME), true);
});
