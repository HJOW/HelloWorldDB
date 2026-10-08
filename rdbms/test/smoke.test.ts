/**
 * 프로젝트 구성 확인용 테스트.
 *
 * 빌드 결과물이 ES 모듈로 실행되고 `hwdb` 진입점이 동작하는지만 본다.
 * 기능 테스트는 단계별로 test/ 아래에 src 와 같은 디렉토리 이름으로 추가한다.
 * 테스트 파일 이름은 `*.test.ts` 로 끝나야 실행 대상이 된다.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// 빌드하면 이 파일은 dist/test/ 에, 진입점은 dist/src/cli/ 에 놓인다.
const HWDB = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

test("hwdb --help 는 사용법을 보여 주고 종료 코드 0 으로 끝난다", () => {
  const result = spawnSync(process.execPath, [HWDB, "--help"], { encoding: "utf8" });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /hwdb start/);
  assert.match(result.stdout, /hwdb stop/);
  assert.match(result.stdout, /hwdb status/);
});
