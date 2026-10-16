/**
 * 시험이 만드는 임시 디렉토리의 정리 도우미. 시험을 등록하지 않으므로 여러 시험 파일에서 import 해도 중복 실행되지 않는다.
 * `createTempDir` 로 만든 디렉토리는 시험 프로세스가 끝날 때 지운다. (`t.after` 를 쓸 수 없는 함수형 도우미에서 쓴다)
 * 지우지 못한 것(열려 있는 파일이 있는 경우 등)은 남기고 넘어간다. 시험 결과에는 영향이 없다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const created = new Set<string>();

process.once("exit", () => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // 지우지 못한 임시 디렉토리는 남는다.
    }
  }
});

/** 임시 디렉토리를 만든다. 시험 프로세스가 끝날 때 지워진다. */
export function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.add(dir);
  return dir;
}
