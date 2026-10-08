/**
 * 로그 테스트 (1단계). 비밀번호 가림과 레벨, 파일 출력을 본다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createLogger, sanitizeLogMessage } from "../../src/common/logger.js";
import { LOG_FILE_NAME } from "../../src/common/instance.js";
import { StartupError } from "../../src/common/errors.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hwdb-log-"));
}

test("IDENTIFIED BY 뒤의 값은 로그에 남지 않는다", () => {
  assert.equal(
    sanitizeLogMessage("CREATE USER HONG IDENTIFIED BY 'secret123'"),
    "CREATE USER HONG IDENTIFIED BY '***'",
  );
  assert.equal(
    sanitizeLogMessage('ALTER USER HONG IDENTIFIED BY "Secret"'),
    'ALTER USER HONG IDENTIFIED BY "***"',
  );
  assert.equal(sanitizeLogMessage("SELECT 1"), "SELECT 1");
});

test("레벨 이하의 메시지만 파일에 남는다", async () => {
  const dir = makeTempDir();
  const logger = createLogger({ level: "warn", dir, foreground: false });
  logger.info("this info must be hidden");
  logger.warn("this warn must remain");
  logger.error("this error must remain");
  await logger.close();

  const text = fs.readFileSync(path.join(dir, LOG_FILE_NAME), "utf8");
  assert.match(text, /this warn must remain/);
  assert.match(text, /this error must remain/);
  assert.doesNotMatch(text, /this info must be hidden/);
});

test("비밀번호가 들어간 문장도 가려서 파일에 남는다", async () => {
  const dir = makeTempDir();
  const logger = createLogger({ level: "info", dir, foreground: false });
  logger.info("CREATE USER HONG IDENTIFIED BY 'secret123'");
  await logger.close();

  const text = fs.readFileSync(path.join(dir, LOG_FILE_NAME), "utf8");
  assert.match(text, /IDENTIFIED BY '\*\*\*'/);
  assert.doesNotMatch(text, /secret123/);
});

test("주석, 이스케이프와 끝나지 않은 비밀번호 리터럴도 가린다", () => {
  for (const sql of [
    "ALTER USER A IDENTIFIED /* comment */ BY 'se''cret'",
    "ALTER USER A IDENTIFIED BY /* comment */ 'secret'",
    "ALTER USER A IDENTIFIED -- comment\nBY 'secret'",
    "ALTER USER A IDENTIFIED BY 'unterminated-secret",
  ]) {
    assert.doesNotMatch(sanitizeLogMessage(sql), /secret|se''cret/);
    assert.match(sanitizeLogMessage(sql), /\*\*\*/);
  }
});

test("로그 파일 열기 실패를 처리하고 닫기는 여러 번 호출할 수 있다", async (t) => {
  const dir = makeTempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, LOG_FILE_NAME));
  assert.throws(() => createLogger({ level: "info", dir, foreground: false }), StartupError);
  const goodDir = path.join(dir, "ok");
  const logger = createLogger({ level: "info", dir: goodDir, foreground: false });
  logger.info("ok"); await logger.close(); await logger.close();
});
