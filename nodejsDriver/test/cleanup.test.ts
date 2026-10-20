/** 통합 시험 도우미가 채널 파일 조회 실패로 실제 데몬 종료를 건너뛰지 않는지 확인한다. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { TestServer } from "./helpers/server.js";

test("채널 경로가 보이지 않아도 시험 서버에 종료를 요청한다", async (t) => {
  const server = await TestServer.start(t);
  const exists = fs.existsSync;
  const remove = fs.rmSync;
  let runningAfterDispose: boolean;
  try {
    fs.existsSync = (file) => String(file).includes("helloworlddb-") ? false : exists(file);
    // 수정 전 시험이 실패해도 제어 토큰이 남아 정상 종료할 수 있게 삭제만 잠시 유예한다.
    fs.rmSync = (file, options) => { if (String(file) !== server.installDir) remove(file, options); };
    server.dispose();
    fs.existsSync = exists;
    runningAfterDispose = server.livePid() !== null;
    assert.equal(runningAfterDispose, false);
  } finally {
    fs.existsSync = exists;
    fs.rmSync = remove;
    if (server.livePid() !== null) await server.stopAsync();
    remove(server.installDir, { recursive: true, force: true });
  }
});
