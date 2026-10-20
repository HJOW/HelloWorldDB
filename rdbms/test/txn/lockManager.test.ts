/**
 * 잠금 관리자 테스트 (7단계).
 * 전부 걸기 또는 하나도 안 걸기, 소유자 재진입, 행·PK·객체 잠금의 충돌, 대기와 깨우기,
 * 제한 시간, 교착 감지, 대기 취소를 본다.
 * 관련 사양 : AGENTS.md 상세 10
 * 구현 단계 : 7단계
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LockManager,
  objectLockKey,
  pkLockKey,
  rowLockKey,
} from "../../src/txn/lockManager.js";
import { state } from "../exec/helpers.js";

const row = (page: number, slot: number): string => rowLockKey("APP", "T", { pageId: page, slotId: slot });

test("식별자 안의 구분자로 다른 테이블의 잠금 범위가 합쳐지지 않는다", () => {
  const locks = new LockManager();
  const id = { pageId: 1, slotId: 0 };
  const first = rowLockKey("A", "B\u001fC", id);
  const second = rowLockKey("A\u001fB", "C", id);
  assert.deepEqual(locks.tryAcquireAll(1, [first]), { ok: true });
  assert.deepEqual(locks.tryAcquireAll(2, [second]), { ok: true });
  assert.equal(locks.tryAcquireAll(3, [objectLockKey("A", "B\u001fC")]).ok, false);
  assert.equal(locks.tryAcquireAll(3, [objectLockKey("A\u001fB", "C")]).ok, false);
  locks.releaseAll(1);
  assert.deepEqual(locks.tryAcquireAll(3, [objectLockKey("A", "B\u001fC")]), { ok: true });
  assert.equal(locks.tryAcquireAll(3, [objectLockKey("A\u001fB", "C")]).ok, false);
});

/** 약속이 이미 끝났는지 한 틱 뒤에 확인한다. */
async function settled(promise: Promise<unknown>): Promise<"pending" | "resolved" | "rejected"> {
  let status: "pending" | "resolved" | "rejected" = "pending";
  promise.then(
    () => {
      status = "resolved";
    },
    () => {
      status = "rejected";
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  return status;
}

test("키를 전부 걸거나 하나도 걸지 않는다", () => {
  const locks = new LockManager();
  assert.deepEqual(locks.tryAcquireAll(1, [row(1, 1), row(1, 2)]), { ok: true });
  // 2번 소유자는 (1,2)에서 충돌하므로 (1,3)도 걸지 못한다.
  const blocked = locks.tryAcquireAll(2, [row(1, 3), row(1, 2)]);
  assert.equal(blocked.ok, false);
  assert.equal(locks.countOf(2), 0);
  assert.deepEqual(locks.tryAcquireAll(3, [row(1, 3)]), { ok: true });
  locks.releaseAll(1);
  assert.deepEqual(locks.tryAcquireAll(2, [row(1, 2)]), { ok: true });
});

test("같은 소유자는 다시 걸 수 있고 해제하면 모두 풀린다", () => {
  const locks = new LockManager();
  assert.deepEqual(locks.tryAcquireAll(1, [row(1, 1)]), { ok: true });
  assert.deepEqual(locks.tryAcquireAll(1, [row(1, 1), row(1, 2), row(1, 1)]), { ok: true });
  assert.equal(locks.countOf(1), 2);
  locks.releaseAll(1);
  assert.equal(locks.lockCount, 0);
  assert.deepEqual(locks.tryAcquireAll(2, [row(1, 1), row(1, 2)]), { ok: true });
});

test("행, PK, 객체 잠금은 서로 다른 키이고 객체 잠금은 같은 테이블의 행·PK 잠금과 충돌한다", () => {
  const locks = new LockManager();
  assert.deepEqual(locks.tryAcquireAll(1, [row(1, 1), pkLockKey("APP", "T", "0a")]), { ok: true });
  // 다른 테이블과 다른 키는 충돌하지 않는다.
  assert.deepEqual(locks.tryAcquireAll(2, [rowLockKey("APP", "U", { pageId: 1, slotId: 1 }), row(1, 2)]), { ok: true });
  // 객체 잠금은 소유자가 다른 행 잠금이 있으면 걸리지 않는다.
  assert.equal(locks.tryAcquireAll(3, [objectLockKey("APP", "T")]).ok, false);
  // 2번도 T 의 행을 잠그고 있으므로 1번이 풀어도 아직 걸리지 않는다.
  locks.releaseAll(1);
  assert.equal(locks.tryAcquireAll(3, [objectLockKey("APP", "T")]).ok, false);
  locks.releaseAll(2);
  assert.deepEqual(locks.tryAcquireAll(3, [objectLockKey("APP", "T")]), { ok: true });
  // 반대로 객체 잠금이 있으면 같은 테이블의 행 잠금이 걸리지 않는다.
  assert.equal(locks.tryAcquireAll(4, [row(5, 5)]).ok, false);
  // 다른 테이블스페이스의 같은 이름 테이블은 다른 객체이다.
  assert.deepEqual(locks.tryAcquireAll(4, [rowLockKey("OTHER", "T", { pageId: 5, slotId: 5 })]), { ok: true });
  // 같은 소유자의 행 잠금은 자기 객체 잠금과 충돌하지 않는다.
  assert.deepEqual(locks.tryAcquireAll(3, [row(9, 9)]), { ok: true });
});

test("기다리던 쪽은 잠금이 풀리면 순서대로 깨어난다", async () => {
  const locks = new LockManager();
  locks.tryAcquireAll(1, [row(1, 1)]);
  const deadline = Date.now() + 5000;
  const second = locks.waitFor(2, row(1, 1), deadline);
  const third = locks.waitFor(3, row(1, 1), deadline);
  assert.equal(await settled(second), "pending");
  assert.equal(await settled(third), "pending");
  assert.equal(locks.waiterCount, 2);
  locks.releaseAll(1);
  assert.equal(await settled(second), "resolved");
  // 2번이 잡은 동안 3번은 계속 기다린다.
  assert.equal(await settled(third), "pending");
  assert.equal(locks.countOf(2), 1);
  locks.releaseAll(2);
  assert.equal(await settled(third), "resolved");
  assert.equal(locks.countOf(3), 1);
  locks.releaseAll(3);
  assert.equal(locks.lockCount, 0);
  assert.equal(locks.waiterCount, 0);
});

test("비어 있으면 기다리지 않고 바로 건다", async () => {
  const locks = new LockManager();
  await locks.waitFor(1, row(1, 1), Date.now() + 1000);
  assert.equal(locks.countOf(1), 1);
});

test("제한 시간이 지나면 55P03 으로 거부하고 대기열에서 빠진다", async () => {
  const locks = new LockManager();
  locks.tryAcquireAll(1, [row(1, 1)]);
  await assert.rejects(locks.waitFor(2, row(1, 1), Date.now() + 30), state("55P03"));
  assert.equal(locks.waiterCount, 0);
  // 이미 지난 시각이면 기다리지 않고 거부한다.
  await assert.rejects(locks.waitFor(2, row(1, 1), Date.now() - 1), state("55P03"));
  // 거부된 뒤에도 풀리면 새로 걸 수 있다.
  locks.releaseAll(1);
  assert.deepEqual(locks.tryAcquireAll(2, [row(1, 1)]), { ok: true });
});

test("서로 기다리는 고리를 만든 쪽이 40P01 로 거부된다", async () => {
  const locks = new LockManager();
  locks.tryAcquireAll(1, [row(1, 1)]);
  locks.tryAcquireAll(2, [row(1, 2)]);
  const deadline = Date.now() + 5000;
  const oneWaits = locks.waitFor(1, row(1, 2), deadline);
  assert.equal(await settled(oneWaits), "pending");
  // 2번이 1번의 잠금을 기다리면 고리가 닫힌다.
  await assert.rejects(locks.waitFor(2, row(1, 1), deadline), state("40P01"));
  // 희생자의 잠금을 풀면 1번이 깨어난다.
  locks.releaseAll(2);
  assert.equal(await settled(oneWaits), "resolved");
  locks.releaseAll(1);
});

test("세 트랜잭션이 이루는 고리도 찾는다", async () => {
  const locks = new LockManager();
  locks.tryAcquireAll(1, [row(1, 1)]);
  locks.tryAcquireAll(2, [row(1, 2)]);
  locks.tryAcquireAll(3, [row(1, 3)]);
  const deadline = Date.now() + 5000;
  const a = locks.waitFor(1, row(1, 2), deadline);
  const b = locks.waitFor(2, row(1, 3), deadline);
  assert.equal(await settled(a), "pending");
  assert.equal(await settled(b), "pending");
  await assert.rejects(locks.waitFor(3, row(1, 1), deadline), state("40P01"));
  locks.releaseAll(3);
  assert.equal(await settled(b), "resolved");
  locks.releaseAll(2);
  assert.equal(await settled(a), "resolved");
  locks.releaseAll(1);
});

test("고리가 아닌 긴 대기 줄은 교착으로 보지 않는다", async () => {
  const locks = new LockManager();
  locks.tryAcquireAll(1, [row(1, 1)]);
  const deadline = Date.now() + 5000;
  const a = locks.waitFor(2, row(1, 1), deadline);
  const b = locks.waitFor(3, row(1, 1), deadline);
  assert.equal(await settled(a), "pending");
  assert.equal(await settled(b), "pending");
  locks.releaseAll(1);
  await a;
  locks.releaseAll(2);
  await b;
  locks.releaseAll(3);
});

test("대기를 취소하면 기다리던 쪽에 08003 을 알린다", async () => {
  const locks = new LockManager();
  locks.tryAcquireAll(1, [row(1, 1)]);
  const waiting = locks.waitFor(2, row(1, 1), Date.now() + 5000);
  const failure = assert.rejects(waiting, state("08003"));
  locks.cancelWait(2);
  await failure;
  assert.equal(locks.waiterCount, 0);
  locks.releaseAll(1);
  assert.equal(locks.lockCount, 0);
});

test("DDL 의 객체 잠금은 행 잠금이 모두 풀린 뒤에 얻는다", async () => {
  const locks = new LockManager();
  locks.tryAcquireAll(1, [row(1, 1)]);
  locks.tryAcquireAll(2, [row(1, 2)]);
  const ddl = locks.waitFor(9, objectLockKey("APP", "T"), Date.now() + 5000);
  assert.equal(await settled(ddl), "pending");
  locks.releaseAll(1);
  assert.equal(await settled(ddl), "pending");
  locks.releaseAll(2);
  assert.equal(await settled(ddl), "resolved");
  locks.releaseAll(9);
});
