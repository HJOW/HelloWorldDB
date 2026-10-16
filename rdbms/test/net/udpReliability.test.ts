/**
 * UDP 신뢰성 계층 테스트 (9단계, 9-7). 소켓 없이 가짜 시계와 시뮬레이터로
 * 유실, 중복, 지연, 순서 뒤바뀜, ACK 유실, 큰 메시지, 양방향 동시 전송, 재전송 한도를 시험한다.
 * 관련 사양 : AGENTS.md 상세 8
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DbError } from "../../src/common/errors.js";
import {
  ReliableEndpoint,
  UDP_HEADER_BYTES,
  UDP_MAX_FRAGMENTS,
  UDP_MAX_RETRANSMITS,
  UdpFlags,
  decodePacket,
  encodePacket,
  maxPayloadBytes,
} from "../../src/net/udpReliability.js";
import type { UdpPacket } from "../../src/net/udpReliability.js";
import { createRandom } from "../types/helpers.js";
import { Pair, payload } from "./udpSim.js";

function dataPacket(overrides: Partial<UdpPacket> = {}): UdpPacket {
  return {
    flags: UdpFlags.DATA,
    sessionId: 1,
    seq: 1,
    fragIndex: 0,
    fragCount: 1,
    ackSeq: 0,
    payload: Buffer.from("x"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 패킷 코덱
// ---------------------------------------------------------------------------

test("패킷 헤더는 20바이트 빅엔디언이고 매직과 버전이 앞에 있다", () => {
  const bytes = encodePacket({
    flags: UdpFlags.SYN | UdpFlags.DATA | UdpFlags.ACK,
    sessionId: 0x01020304,
    seq: 0x0a0b0c0d,
    fragIndex: 0x0102,
    fragCount: 0x0304,
    ackSeq: 0x11223344,
    payload: Buffer.from([0xaa, 0xbb]),
  });
  assert.equal(UDP_HEADER_BYTES, 20);
  assert.deepEqual(
    [...bytes],
    [0x48, 0x57, 1, 0x07, 1, 2, 3, 4, 0x0a, 0x0b, 0x0c, 0x0d, 1, 2, 3, 4, 0x11, 0x22, 0x33, 0x44, 0xaa, 0xbb],
  );
});

test("패킷은 인코딩하고 해석하면 같고 가장 큰 값도 지킨다", () => {
  const original: UdpPacket = {
    flags: UdpFlags.DATA,
    sessionId: 0xffffffff,
    seq: 0xffffffff,
    fragIndex: 0xfffe,
    fragCount: 0xffff,
    ackSeq: 0xffffffff,
    payload: Buffer.from("hello"),
  };
  assert.deepEqual(decodePacket(encodePacket(original)), original);
  const ack: UdpPacket = { flags: UdpFlags.ACK | UdpFlags.SYN, sessionId: 5, seq: 9, fragIndex: 3, fragCount: 0, ackSeq: 2, payload: Buffer.alloc(0) };
  assert.deepEqual(decodePacket(encodePacket(ack)), ack);
});

test("규칙에 맞지 않는 패킷은 null 이다", () => {
  const good = encodePacket(dataPacket());
  assert.notEqual(decodePacket(good), null);
  assert.equal(decodePacket(good.subarray(0, 19)), null, "짧다");
  assert.equal(decodePacket(Buffer.alloc(0)), null);
  for (const [offset, value] of [[0, 0], [1, 0], [2, 2], [2, 0]] as const) {
    const copy = Buffer.from(good);
    copy[offset] = value;
    assert.equal(decodePacket(copy), null, `offset ${offset}`);
  }
  const unknownFlag = Buffer.from(good);
  unknownFlag[3] = (unknownFlag[3] as number) | 0x80;
  assert.equal(decodePacket(unknownFlag), null);
  assert.equal(decodePacket(encodePacket(dataPacket({ fragCount: 0 }))), null, "조각 수 0");
  assert.equal(decodePacket(encodePacket(dataPacket({ fragIndex: 1, fragCount: 1 }))), null, "조각 번호가 수 이상");
  assert.equal(decodePacket(encodePacket(dataPacket({ payload: Buffer.alloc(0) }))), null, "DATA 의 본문이 비었다");
  assert.equal(decodePacket(encodePacket({ ...dataPacket(), flags: UdpFlags.ACK, fragCount: 0 })), null, "DATA 가 아닌데 본문이 있다");
});

test("끝점은 잘못된 패킷 크기 설정을 받지 않는다", () => {
  const make = (maxPacketSize: number): ReliableEndpoint =>
    new ReliableEndpoint({ send: () => undefined }, { now: () => 0, setTimer: () => ({ cancel: () => undefined }) }, {
      maxPacketSize,
      sessionId: () => 0,
      onMessage: () => undefined,
      onFailure: () => undefined,
      maxMessageBytes: () => 1000,
    });
  assert.throws(() => make(63), RangeError);
  assert.throws(() => make(65_508), RangeError);
  assert.throws(() => make(100.5), RangeError);
  assert.doesNotThrow(() => make(64));
  assert.doesNotThrow(() => make(65_507));
  assert.equal(maxPayloadBytes(1200), 1180);
});

// ---------------------------------------------------------------------------
// 기본 동작
// ---------------------------------------------------------------------------

test("메시지 하나가 전달되고 ACK 로 끝난다", () => {
  const pair = new Pair({ link: { minDelay: 10 } });
  pair.a.sendMessage(Buffer.from("hello"));
  assert.equal(pair.a.pendingMessages, 1);
  assert.equal(pair.settle(), true);
  assert.deepEqual(pair.receivedByB, [Buffer.from("hello")]);
  assert.equal(pair.a.pendingMessages, 0);
  assert.equal(pair.toB.sent, 1, "재전송 없이 패킷 하나");
  assert.equal(pair.toA.sent, 1, "ACK 하나");
  assert.equal(pair.toB.log[0]?.flags, UdpFlags.DATA | UdpFlags.SYN, "첫 메시지에는 SYN 이 붙는다");
});

test("방향마다 첫 메시지에만 SYN 이 붙고 모든 패킷이 ackSeq 를 싣는다", () => {
  const pair = new Pair({ link: { minDelay: 5 } });
  pair.a.sendMessage(Buffer.from("one"));
  pair.settle();
  pair.b.sendMessage(Buffer.from("reply"));
  pair.settle();
  pair.a.sendMessage(Buffer.from("two"));
  pair.settle();
  const dataFromA = pair.toB.log.filter((packet) => (packet.flags & UdpFlags.DATA) !== 0);
  assert.deepEqual(dataFromA.map((packet) => [packet.seq, (packet.flags & UdpFlags.SYN) !== 0]), [[1, true], [2, false]]);
  const dataFromB = pair.toA.log.filter((packet) => (packet.flags & UdpFlags.DATA) !== 0);
  assert.deepEqual(dataFromB.map((packet) => [packet.seq, packet.ackSeq]), [[1, 1]], "B 의 답은 A 의 1번을 받았음을 싣는다");
  assert.equal(dataFromA[1]?.ackSeq, 1, "A 의 두 번째 메시지는 B 의 1번을 받았음을 싣는다");
  // 첫 메시지를 받은 쪽의 ACK 에는 SYN 이 따라 붙는다.
  assert.equal(((pair.toA.log[0] as UdpPacket).flags & UdpFlags.SYN) !== 0, true);
  assert.deepEqual(pair.receivedByA, [Buffer.from("reply")]);
});

test("조각으로 나누어 보내고 다시 합친다 (경계 크기 포함)", () => {
  const size = maxPayloadBytes(1200);
  for (const length of [1, size - 1, size, size + 1, size * 2, size * 2 + 1, size * 10, 100_000]) {
    const pair = new Pair({ link: { minDelay: 3 } });
    const body = payload(length, length);
    pair.a.sendMessage(body);
    assert.equal(pair.settle(), true, String(length));
    assert.equal(pair.receivedByB.length, 1);
    assert.ok((pair.receivedByB[0] as Buffer).equals(body), `length ${length}`);
    assert.ok(pair.toB.maxSize <= 1200, "패킷이 maxPacketSize 를 넘지 않는다");
    const fragments = pair.toB.log.filter((packet) => (packet.flags & UdpFlags.DATA) !== 0);
    assert.equal(fragments.length, Math.ceil(length / size));
    assert.ok(fragments.every((packet) => packet.fragCount === Math.ceil(length / size)));
  }
});

test("작은 패킷 크기(64)에서도 동작한다", () => {
  const pair = new Pair({ maxPacketSize: 64, link: { minDelay: 2, loss: 0.1 }, seed: 5 });
  const body = payload(5000, 1);
  pair.a.sendMessage(body);
  assert.equal(pair.settle(), true);
  assert.ok((pair.receivedByB[0] as Buffer).equals(body));
  assert.ok(pair.toB.maxSize <= 64);
});

test("메시지는 한 번에 하나씩 전송하고 대기열의 순서를 지킨다", () => {
  const pair = new Pair({ link: { minDelay: 10 } });
  const messages = Array.from({ length: 6 }, (_, i) => payload(100 + i * 700, i));
  for (const message of messages) pair.a.sendMessage(message);
  assert.equal(pair.a.pendingMessages, 6);
  assert.equal(pair.settle(), true);
  assert.equal(pair.receivedByB.length, 6);
  messages.forEach((message, i) => assert.ok((pair.receivedByB[i] as Buffer).equals(message), `message ${i}`));
  // 이전 메시지가 모두 확인되기 전에는 다음 번호를 보내지 않는다.
  const seqs = pair.toB.log.filter((packet) => (packet.flags & UdpFlags.DATA) !== 0).map((packet) => packet.seq);
  for (let i = 1; i < seqs.length; i++) assert.ok((seqs[i] as number) >= (seqs[i - 1] as number));
});

test("한 메시지 안에서 미확인 조각은 32개까지이다", () => {
  const pair = new Pair({ link: { minDelay: 50 } });
  pair.a.sendMessage(payload(maxPayloadBytes(1200) * 100, 3));
  // ACK 가 오기 전(50 ms 안)까지 보낸 조각 수이다.
  pair.clock.run(() => false, 49);
  assert.equal(pair.toB.sent, 32);
  assert.equal(pair.settle(), true);
});

// ---------------------------------------------------------------------------
// 유실, 중복, 순서 뒤바뀜
// ---------------------------------------------------------------------------

function assertExactlyOnceInOrder(pair: Pair, sentByA: Buffer[], sentByB: Buffer[], label: string): void {
  assert.equal(pair.receivedByB.length, sentByA.length, `${label}: A→B 개수`);
  assert.equal(pair.receivedByA.length, sentByB.length, `${label}: B→A 개수`);
  sentByA.forEach((message, i) => assert.ok((pair.receivedByB[i] as Buffer).equals(message), `${label}: A→B ${i}`));
  sentByB.forEach((message, i) => assert.ok((pair.receivedByA[i] as Buffer).equals(message), `${label}: B→A ${i}`));
}

test("유실, 중복, 지연, 순서 뒤바뀜이 함께 있어도 모든 메시지가 한 번씩 순서대로 전달된다 (시드 120개)", () => {
  for (let seed = 1; seed <= 120; seed++) {
    const random = createRandom(seed * 31);
    const pair = new Pair({ seed, link: { loss: 0.25, duplicate: 0.2, minDelay: 2, maxDelay: 90 } });
    const sentByA: Buffer[] = [];
    const sentByB: Buffer[] = [];
    for (let i = 0; i < 12; i++) {
      const a = payload(1 + Math.floor(random() * 5000), seed * 100 + i);
      const b = payload(1 + Math.floor(random() * 5000), seed * 100 + 50 + i);
      sentByA.push(a);
      sentByB.push(b);
      pair.a.sendMessage(a);
      pair.b.sendMessage(b);
    }
    assert.equal(pair.settle(), true, `seed ${seed}: ${pair.failuresA[0]?.message ?? pair.failuresB[0]?.message ?? "not settled"}`);
    assertExactlyOnceInOrder(pair, sentByA, sentByB, `seed ${seed}`);
  }
});

test("유실 40% 에서도 전달된다 (시드 30개, 재전송 한도 안에서)", () => {
  let failures = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const pair = new Pair({ seed, link: { loss: 0.4, minDelay: 5, maxDelay: 30 } });
    const message = payload(20_000, seed);
    pair.a.sendMessage(message);
    pair.b.sendMessage(message);
    if (!pair.settle()) {
      // 실패한다면 깨끗하게 재전송 한도 오류여야 하고, 잘못된 데이터를 전달해서는 안 된다.
      failures++;
      const error = pair.failuresA[0] ?? pair.failuresB[0];
      assert.equal(error?.kind, "retransmit-limit");
    }
    for (const received of [...pair.receivedByA, ...pair.receivedByB]) assert.ok(received.equals(message));
  }
  assert.ok(failures <= 3, `재전송 한도로 실패한 시드가 너무 많다: ${failures}`);
});

test("조각이 모두 뒤섞여 도착해도 올바르게 합쳐진다", () => {
  // 지연을 0 ~ 500 ms 로 크게 흩뜨린다.
  const pair = new Pair({ seed: 99, link: { minDelay: 1, maxDelay: 500 } });
  const body = payload(60_000, 9);
  pair.a.sendMessage(body);
  assert.equal(pair.settle(), true);
  assert.ok((pair.receivedByB[0] as Buffer).equals(body));
});

test("모든 패킷이 두 번씩 도착해도 한 번만 전달한다", () => {
  const pair = new Pair({ link: { duplicate: 1, minDelay: 3, maxDelay: 12 }, seed: 4 });
  const messages = Array.from({ length: 5 }, (_, i) => payload(3000, i + 40));
  for (const message of messages) pair.a.sendMessage(message);
  assert.equal(pair.settle(), true);
  assert.equal(pair.receivedByB.length, 5);
  messages.forEach((message, i) => assert.ok((pair.receivedByB[i] as Buffer).equals(message)));
});

test("ACK 가 자주 유실되어도 전달되고 중복은 한 번만 전달된다", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const pair = new Pair({ seed, link: { minDelay: 5, maxDelay: 15 }, linkBtoA: { ackLoss: 0.4 } });
    const messages = Array.from({ length: 6 }, (_, i) => payload(2500, seed * 10 + i));
    for (const message of messages) pair.a.sendMessage(message);
    assert.equal(pair.settle(), true, `seed ${seed}`);
    assert.equal(pair.receivedByB.length, 6, `seed ${seed}: 한 번씩만`);
    messages.forEach((message, i) => assert.ok((pair.receivedByB[i] as Buffer).equals(message)));
  }
});

test("이미 전달한 메시지의 중복 조각에는 ACK 를 다시 보내고 다시 전달하지 않는다", () => {
  const pair = new Pair({ link: { minDelay: 2 } });
  pair.a.sendMessage(Buffer.from("once"));
  assert.equal(pair.settle(), true);
  const sentBefore = pair.toA.sent;
  const original = pair.toB.log[0] as UdpPacket;
  pair.b.receivePacket(original); // 같은 조각이 늦게 다시 도착했다.
  pair.b.receivePacket(original);
  assert.equal(pair.receivedByB.length, 1, "다시 전달하지 않는다");
  assert.equal(pair.toA.sent, sentBefore + 2, "ACK 는 다시 보낸다");
});

test("미래의 메시지(seq > expected)는 버리고 ACK 도 보내지 않는다", () => {
  const pair = new Pair({ link: { minDelay: 2 } });
  pair.b.receivePacket(dataPacket({ seq: 5, payload: Buffer.from("ahead") }));
  assert.equal(pair.receivedByB.length, 0);
  assert.equal(pair.toA.sent, 0);
  assert.equal(pair.b.deliveredSeq, 0);
});

test("양쪽이 동시에 큰 메시지를 보내도 된다", () => {
  const pair = new Pair({ seed: 8, link: { loss: 0.15, duplicate: 0.1, minDelay: 5, maxDelay: 40 } });
  const a = payload(400_000, 1);
  const b = payload(300_000, 2);
  pair.a.sendMessage(a);
  pair.b.sendMessage(b);
  assert.equal(pair.settle(), true);
  assert.ok((pair.receivedByB[0] as Buffer).equals(a));
  assert.ok((pair.receivedByA[0] as Buffer).equals(b));
});

test("16 MiB 메시지(약 14,000 조각)를 유실 5% 에서 전달한다", () => {
  const pair = new Pair({ seed: 21, link: { loss: 0.05, minDelay: 10, maxDelay: 20 } });
  const body = payload(16 * 1024 * 1024, 77);
  pair.a.sendMessage(body);
  assert.equal(pair.settle(3_600_000), true, pair.failuresA[0]?.message);
  assert.equal(pair.receivedByB.length, 1);
  assert.ok((pair.receivedByB[0] as Buffer).equals(body));
});

// ---------------------------------------------------------------------------
// 재전송과 실패
// ---------------------------------------------------------------------------

test("재전송 제한 시간은 왕복 시간에 맞추어 줄어든다 (RFC 6298, 하한 50 ms)", () => {
  const pair = new Pair({ link: { minDelay: 10 } });
  assert.equal(pair.a.currentRto, 300, "초기값");
  for (let i = 0; i < 8; i++) pair.a.sendMessage(payload(200, i));
  assert.equal(pair.settle(), true);
  assert.equal(pair.a.currentRto, 50);
});

test("상대가 사라지면 같은 조각을 10번 다시 보낸 뒤 실패한다 (간격은 2배씩, 상한 3초)", () => {
  const pair = new Pair({ link: { minDelay: 5 }, linkAtoB: { loss: 1 } });
  pair.a.sendMessage(Buffer.from("into the void"));
  const times: number[] = [];
  const clock = pair.clock;
  const original = pair.toB.port.send;
  pair.toB.port.send = (bytes: Buffer): void => {
    times.push(clock.now());
    original(bytes);
  };
  // 위에서 바꾼 함수는 이후 보내기부터 적용되므로, 이미 보낸 첫 전송 시각(0)을 앞에 둔다.
  times.push(0);
  pair.clock.run(() => pair.failuresA.length > 0, 600_000);
  assert.equal(pair.failuresA.length, 1);
  assert.equal(pair.failuresA[0]?.kind, "retransmit-limit");
  assert.equal(pair.toB.sent, 1 + UDP_MAX_RETRANSMITS, "처음 한 번과 재전송 10번");
  assert.deepEqual(
    times.slice(1).map((time, i) => time - (times[i] as number)),
    [300, 600, 1200, 2400, 3000, 3000, 3000, 3000, 3000, 3000],
  );
  assert.equal(pair.a.isStopped, true);
  // 멈춘 끝점은 더 보내지 않는다.
  pair.a.sendMessage(Buffer.from("ignored"));
  assert.equal(pair.a.pendingMessages, 0);
  assert.equal(pair.toB.sent, 1 + UDP_MAX_RETRANSMITS);
});

test("재전송이 시작되면 ACK 가 오는 즉시 끝나고 실패하지 않는다", () => {
  let drops = 0;
  const pair = new Pair({ link: { minDelay: 5 }, linkAtoB: { dropIf: () => drops++ < 3 } });
  pair.a.sendMessage(Buffer.from("third time lucky"));
  assert.equal(pair.settle(), true);
  assert.equal(pair.toB.sent, 4);
  assert.deepEqual(pair.receivedByB, [Buffer.from("third time lucky")]);
});

test("확인된 적 없는 첫 메시지는 더 낮은 재전송 한도를 받을 수 있다", () => {
  const pair = new Pair({ link: { minDelay: 5 }, linkAtoB: { loss: 1 }, optionsA: { unconfirmedRetransmitLimit: 3 } });
  pair.a.sendMessage(Buffer.from("hello"));
  pair.clock.run(() => pair.failuresA.length > 0, 600_000);
  assert.equal(pair.failuresA[0]?.kind, "retransmit-limit");
  assert.equal(pair.toB.sent, 1 + 3);
  // 한 조각이라도 확인되면 보통의 한도(10)로 돌아간다. 두 조각 메시지에서 첫 조각만 확인되고 둘째 조각이 계속 유실되는 경우이다.
  const second = new Pair({
    link: { minDelay: 5 },
    linkAtoB: { dropIf: (packet) => packet.fragIndex === 1 },
    optionsA: { unconfirmedRetransmitLimit: 3 },
  });
  second.a.sendMessage(payload(maxPayloadBytes(1200) + 10, 1));
  second.clock.run(() => second.failuresA.length > 0, 600_000);
  assert.equal(second.failuresA[0]?.kind, "retransmit-limit");
  assert.equal(second.toB.log.filter((packet) => packet.fragIndex === 1).length, 1 + UDP_MAX_RETRANSMITS);
});

test("두 번째 메시지부터는 낮춘 한도를 쓰지 않는다", () => {
  let first = true;
  const pair = new Pair({
    link: { minDelay: 5 },
    linkAtoB: {
      // 첫 메시지는 통과시키고 둘째 메시지는 모두 잃는다.
      dropIf: (packet) => {
        if (packet.seq === 1) return false;
        first = false;
        return true;
      },
    },
    optionsA: { unconfirmedRetransmitLimit: 3 },
  });
  pair.a.sendMessage(Buffer.from("one"));
  pair.a.sendMessage(Buffer.from("two"));
  pair.clock.run(() => pair.failuresA.length > 0, 600_000);
  assert.equal(first, false);
  assert.equal(pair.toB.log.filter((packet) => packet.seq === 2).length, 1 + UDP_MAX_RETRANSMITS);
});

// ---------------------------------------------------------------------------
// 규칙 위반과 한도
// ---------------------------------------------------------------------------

test("한 메시지의 조각 수가 도중에 바뀌면 위반이다", () => {
  const pair = new Pair();
  pair.b.receivePacket(dataPacket({ seq: 1, fragIndex: 0, fragCount: 3, payload: Buffer.from("a") }));
  pair.b.receivePacket(dataPacket({ seq: 1, fragIndex: 1, fragCount: 4, payload: Buffer.from("b") }));
  assert.equal(pair.failuresB.length, 1);
  assert.equal(pair.failuresB[0]?.kind, "protocol");
  assert.equal(pair.b.isStopped, true);
});

test("받을 수 있는 크기를 넘으면 위반이다 (인증 전 한도 같은 상황)", () => {
  const pair = new Pair({ maxMessageBytes: 100 });
  pair.b.receivePacket(dataPacket({ seq: 1, fragIndex: 0, fragCount: 2, payload: Buffer.alloc(60) }));
  assert.equal(pair.failuresB.length, 0);
  pair.b.receivePacket(dataPacket({ seq: 1, fragIndex: 1, fragCount: 2, payload: Buffer.alloc(60) }));
  assert.equal(pair.failuresB.length, 1);
  assert.equal(pair.failuresB[0]?.kind, "protocol");
  assert.equal(pair.receivedByB.length, 0, "한도를 넘은 메시지는 위로 전달되지 않는다");
});

test("한도는 조각을 받을 때의 값을 쓴다 (인증을 마치면 커진다)", () => {
  let limit = 100;
  const pair = new Pair({ optionsB: { maxMessageBytes: () => limit } });
  pair.b.receivePacket(dataPacket({ seq: 1, fragIndex: 0, fragCount: 2, payload: Buffer.alloc(60) }));
  limit = 1000;
  pair.b.receivePacket(dataPacket({ seq: 1, fragIndex: 1, fragCount: 2, payload: Buffer.alloc(60) }));
  assert.equal(pair.failuresB.length, 0);
  assert.equal(pair.receivedByB[0]?.length, 120);
});

test("빈 본문은 보낼 수 없고, 조각 수가 65,535 를 넘는 메시지는 54000 이다", () => {
  const pair = new Pair({ maxPacketSize: 64 });
  assert.throws(() => pair.a.sendMessage(Buffer.alloc(0)), RangeError);
  const size = maxPayloadBytes(64);
  assert.doesNotThrow(() => pair.a.sendMessage(Buffer.alloc(size * UDP_MAX_FRAGMENTS)));
  const other = new Pair({ maxPacketSize: 64 });
  assert.throws(
    () => other.a.sendMessage(Buffer.alloc(size * UDP_MAX_FRAGMENTS + 1)),
    (error) => error instanceof DbError && error.sqlState === "54000" && error.code === 8003,
  );
  assert.equal(other.a.pendingMessages, 0);
});

test("idle 은 보낼 것이 모두 확인되면 풀리고, stop 하면 바로 풀린다", async () => {
  const pair = new Pair({ link: { minDelay: 10 } });
  let done = false;
  pair.a.sendMessage(payload(10_000, 1));
  void pair.a.idle().then(() => {
    done = true;
  });
  await Promise.resolve();
  assert.equal(done, false);
  pair.settle();
  await Promise.resolve();
  assert.equal(done, true);
  await pair.a.idle(); // 이미 비어 있으면 바로 끝난다.
  const other = new Pair({ link: { minDelay: 10 }, linkAtoB: { loss: 1 } });
  other.a.sendMessage(Buffer.from("x"));
  let released = false;
  void other.a.idle().then(() => {
    released = true;
  });
  other.a.stop();
  await Promise.resolve();
  assert.equal(released, true);
});

test("멈춘 끝점은 들어오는 패킷도 무시한다", () => {
  const pair = new Pair();
  pair.b.stop();
  pair.b.receivePacket(dataPacket());
  assert.equal(pair.receivedByB.length, 0);
  assert.equal(pair.toA.sent, 0);
});
