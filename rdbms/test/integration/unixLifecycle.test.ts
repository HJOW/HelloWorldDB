/**
 * 유닉스 데몬의 소켓 권한·수명과 Linux 세션 분리를 실제 프로세스로 검증한다.
 * 관련 사양: AGENTS.md 상세 8, 12, 14, 15. Windows에서는 해당 시험만 건너뛴다.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { getLocalChannelAddress } from "../../src/common/instance.js";
import { Daemon, query } from "./helpers.js";

const unixOnly = { skip: process.platform === "win32" ? "유닉스 소켓과 신호 전용 시험" : false };

test("유닉스 소켓은 느슨한 umask에서도 0600이고 정상 종료하면 삭제된다", unixOnly, async (t) => {
  const daemon = await Daemon.create(t, { tcp: { enabled: false }, udp: { enabled: false } });
  const previousMask = process.umask(0);
  try {
    daemon.start();
  } finally {
    process.umask(previousMask);
  }
  const address = getLocalChannelAddress(daemon.port);
  const socket = fs.statSync(address);
  assert.ok(socket.isSocket());
  assert.equal(socket.mode & 0o777, 0o600);
  assert.deepEqual(await query(await daemon.connect("local"), "SELECT 'Hello World'"), [["Hello World"]]);
  daemon.stopClean();
  assert.equal(fs.existsSync(address), false);
});

test("SIGKILL로 남은 유닉스 소켓은 재구동 때 정리하고 새 소켓으로 접속한다", unixOnly, async (t) => {
  const daemon = await Daemon.create(t, { tcp: { enabled: false }, udp: { enabled: false } });
  daemon.start();
  const pid = daemon.pid as number;
  const address = getLocalChannelAddress(daemon.port);
  daemon.kill();
  await daemon.waitUntilGone(pid);
  assert.ok(fs.statSync(address).isSocket(), "비정상 종료한 소켓 파일이 남아 있어야 한다");
  daemon.start();
  assert.match(daemon.log(), /Removing a stale socket file/);
  assert.equal(fs.statSync(address).mode & 0o777, 0o600);
  assert.deepEqual(await query(await daemon.connect("local"), "SELECT 42"), [[42]]);
  daemon.stopClean();
  assert.equal(fs.existsSync(address), false);
});

test("분리된 데몬은 SIGHUP 뒤에도 같은 PID로 SQL을 실행한다", unixOnly, async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const pid = daemon.pid as number;
  process.kill(pid, "SIGHUP");
  // 신호가 처리될 시간을 준 뒤 새 접속으로 살아 있음을 확인한다.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(daemon.pid, pid);
  assert.deepEqual(await query(await daemon.connect("local"), "SELECT 7"), [[7]]);
});

test("Linux 데몬은 별도 세션·프로세스 그룹에서 제어 터미널 없이 실행된다", {
  skip: process.platform !== "linux" ? "Linux /proc 전용 시험" : false,
}, async (t) => {
  const daemon = await Daemon.create(t);
  daemon.start();
  const pid = daemon.pid as number;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  // comm 필드에는 공백과 괄호가 들어갈 수 있으므로 마지막 닫는 괄호 뒤부터 읽는다.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  assert.equal(Number(fields[2]), pid, "프로세스 그룹의 리더이다");
  assert.equal(Number(fields[3]), pid, "별도 세션의 리더이다");
  assert.equal(Number(fields[4]), 0, "제어 터미널이 없다");
});
