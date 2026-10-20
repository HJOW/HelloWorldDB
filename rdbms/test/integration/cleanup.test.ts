/** 로컬 채널의 파일 존재 검사와 무관하게 시험 데몬을 정상 종료하는지 확인한다. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { Connection } from "../../src/client/connection.js";
import { getLocalChannelAddress } from "../../src/common/instance.js";
import { isProcessAlive, readLockFile } from "../../src/daemon/lockFile.js";
import { Daemon } from "./helpers.js";
import { waitFor } from "../net/helpers.js";

test("채널 경로의 existsSync가 false여도 시험 데몬에 정상 종료를 요청한다", async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const lock = readLockFile(daemon.dataDir);
  assert.ok(lock);
  const exists = fs.existsSync;
  try {
    // 파일 조회 결과를 구동 상태의 증거로 쓸 수 없는 상황을 강제로 만든다.
    fs.existsSync = (file) => String(file) === getLocalChannelAddress(lock.port) ? false : exists(file);
    daemon.dispose();
    assert.equal(isProcessAlive(lock.pid), false, "시험 설치를 지우기 전에 데몬이 끝나야 한다");
  } finally {
    fs.existsSync = exists;
    // 수정 전 시험이 실패해도 토큰으로 식별한 자기 데몬을 남기지 않는다.
    if (isProcessAlive(lock.pid)) {
      const connection = await Connection.open({ kind: "local", port: lock.port });
      try {
        const status = await connection.control("status", lock.controlToken);
        assert.equal(status.pid, lock.pid);
        await connection.control("stop", lock.controlToken);
      } finally {
        connection.abort();
      }
      await waitFor(() => !isProcessAlive(lock.pid), 10_000, "시험 데몬 종료");
    }
  }
});
