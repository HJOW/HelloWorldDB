/**
 * 프로토콜 계층의 단위 시험 (12-2) : SCRAM-SHA-256, 프레임, 메시지 해석, UDP 신뢰성 계층. 서버가 필요 없다.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DbError } from "../src/errors.js";
import { FrameDecoder, FrameError, encodeFrame } from "../src/protocol/framing.js";
import { MAX_MESSAGE_BYTES, decodeResponse, encodeMessage, toDbError } from "../src/protocol/messages.js";
import type { ErrorResponse } from "../src/protocol/messages.js";
import { authMessage, clientFinalWithoutProof, clientFirstBare, clientFirstMessage, computeClientProof, escapeUserName, parseServerFirst, verifyServerSignature } from "../src/protocol/scram.js";
import { ReliableEndpoint, UDP_HEADER_BYTES, UdpFlags, decodePacket, encodePacket } from "../src/protocol/udpReliability.js";
import { FakeClock, Link, createRandom } from "./helpers/udpSim.js";

// ---------------------------------------------------------------------------
// SCRAM-SHA-256 (RFC 7677 시험 벡터)
// ---------------------------------------------------------------------------

const RFC_CLIENT_NONCE = "rOprNGfwEbeRWgbNEkqO";
const RFC_SERVER_FIRST = "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";

test("SCRAM : RFC 7677 시험 벡터와 클라이언트 증명·서버 서명이 일치한다", () => {
  assert.equal(clientFirstMessage("user", RFC_CLIENT_NONCE), "n,,n=user,r=rOprNGfwEbeRWgbNEkqO");
  const parsed = parseServerFirst(RFC_SERVER_FIRST);
  assert.ok(parsed !== null);
  assert.equal(parsed.iterations, 4096);
  assert.equal(parsed.salt, "W22ZaJ0SNY7soEsUEjb6gQ==");
  const withoutProof = clientFinalWithoutProof(parsed.nonce);
  assert.equal(withoutProof, "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0");
  const message = authMessage(clientFirstBare("user", RFC_CLIENT_NONCE), RFC_SERVER_FIRST, withoutProof);
  assert.equal(computeClientProof("pencil", parsed.salt, parsed.iterations, message), "dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=");
  assert.equal(verifyServerSignature("pencil", parsed.salt, parsed.iterations, message, "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4="), true);
  assert.equal(verifyServerSignature("wrong", parsed.salt, parsed.iterations, message, "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4="), false, "비밀번호가 다르면 서명이 맞지 않는다");
  assert.equal(verifyServerSignature("pencil", parsed.salt, parsed.iterations, message, "AAAA"), false, "서명이 틀리면 거부");
});

test("SCRAM : 사용자 이름의 = 와 , 를 이스케이프하고, 깨진 server-first 와 지나친 반복 횟수는 거부한다", () => {
  assert.equal(escapeUserName("a=b,c"), "a=3Db=2Cc");
  assert.equal(clientFirstBare("a=b,c", "N"), "n=a=3Db=2Cc,r=N");
  assert.equal(parseServerFirst("garbage"), null);
  assert.equal(parseServerFirst("r=abc,s=xyz,i=0"), null);
  assert.equal(parseServerFirst("r=abc,s=xyz,i=10000001"), null, "계산이 오래 걸리게 하는 값은 받지 않는다");
  assert.notEqual(parseServerFirst("r=abc,s=xyz,i=10000000"), null);
  assert.equal(parseServerFirst("r=abc,s=xyz,i=99999999999999999999"), null);
});

// ---------------------------------------------------------------------------
// 프레임
// ---------------------------------------------------------------------------

test("프레임 : 4바이트 빅엔디언 길이 뒤에 본문이 붙는다", () => {
  const frame = encodeFrame(Buffer.from("hello"));
  assert.deepEqual([...frame.subarray(0, 4)], [0, 0, 0, 5]);
  assert.equal(frame.subarray(4).toString(), "hello");
  assert.throws(() => encodeFrame(Buffer.alloc(0)), RangeError);
  assert.throws(() => encodeFrame(Buffer.alloc(MAX_MESSAGE_BYTES + 1)), RangeError);
});

test("프레임 해석 : 한 번에 여러 메시지가 와도, 한 메시지가 한 바이트씩 나뉘어 와도 처리한다", () => {
  const bodies = ["a", "bb".repeat(300), "ccc"].map((text) => Buffer.from(text));
  const stream = Buffer.concat(bodies.map((body) => encodeFrame(body)));
  const together: string[] = [];
  new FrameDecoder(() => MAX_MESSAGE_BYTES).push(stream, (body) => together.push(body.toString()));
  assert.deepEqual(together, bodies.map((b) => b.toString()));
  const bytewise: string[] = [];
  const decoder = new FrameDecoder(() => MAX_MESSAGE_BYTES);
  for (let i = 0; i < stream.length; i++) decoder.push(stream.subarray(i, i + 1), (body) => bytewise.push(body.toString()));
  assert.deepEqual(bytewise, together);
  assert.equal(decoder.bufferedBytes, 0);
});

test("프레임 해석 : 길이가 0 이거나 한도를 넘으면 본문을 받지 않고 오류이다", () => {
  const zero = Buffer.alloc(4);
  assert.throws(() => new FrameDecoder(() => 100).push(zero, () => undefined), FrameError);
  const tooLarge = Buffer.alloc(4);
  tooLarge.writeUInt32BE(101, 0);
  assert.throws(() => new FrameDecoder(() => 100).push(tooLarge, () => undefined), FrameError);
  // 오류가 난 뒤의 입력은 무시한다.
  const decoder = new FrameDecoder(() => 100);
  assert.throws(() => decoder.push(zero, () => undefined));
  const seen: Buffer[] = [];
  decoder.push(encodeFrame(Buffer.from("x")), (body) => seen.push(body));
  assert.equal(seen.length, 0);
});

// ---------------------------------------------------------------------------
// 메시지
// ---------------------------------------------------------------------------

test("응답 해석 : 모양이 맞는 응답은 그대로 돌려주고, 어긋난 응답은 이유와 함께 거부한다", () => {
  const ok = decodeResponse(Buffer.from(JSON.stringify({ id: 3, type: "rows", rows: [[1]], hasMore: false, extra: "무시" })));
  assert.ok(ok.ok);
  assert.equal(ok.response.type, "rows");
  for (const [text, reason] of [
    ["not json", /not valid/],
    ["[1]", /JSON object/],
    [JSON.stringify({ type: "pong" }), /id/],
    [JSON.stringify({ id: -1, type: "pong" }), /id/],
    [JSON.stringify({ id: 1, type: "nope" }), /Unknown response type/],
    [JSON.stringify({ id: 1, type: "status", running: true, port: 1 }), /Unknown response type/],
    [JSON.stringify({ id: 1, type: "rows", rows: "x", hasMore: false }), /rows, hasMore/],
    [JSON.stringify({ id: 1, type: "error", sqlState: "42P01" }), /sqlState, code, message/],
    [JSON.stringify({ id: 1, type: "authChallenge" }), /serverFirst/],
  ] as const) {
    const result = decodeResponse(Buffer.from(text));
    assert.equal(result.ok, false, text);
    if (!result.ok) assert.match(result.reason, reason, text);
  }
  assert.equal(decodeResponse(Buffer.from([0xff, 0xfe, 0x00])).ok, false, "올바르지 않은 UTF-8");
});

test("오류 응답은 SQLSTATE, 내부 번호, 메시지, 위치를 가진 DbError 가 된다", () => {
  const response: ErrorResponse = { id: 1, type: "error", sqlState: "42601", code: 3000, message: "Syntax error.", position: { offset: 14, line: 1, column: 15 } };
  const error = toDbError(response);
  assert.ok(error instanceof DbError);
  assert.equal(error.sqlState, "42601");
  assert.equal(error.code, 3000);
  assert.equal(error.message, "Syntax error.");
  assert.deepEqual(error.position, { offset: 14, line: 1, column: 15 });
  assert.equal(error.isConnectionError, false);
  assert.equal(toDbError({ id: 1, type: "error", sqlState: "08006", code: 8006, message: "x" }).isConnectionError, true);
  assert.equal(toDbError({ id: 1, type: "error", sqlState: "42501", code: 7001, message: "x" }).position, undefined);
});

test("메시지는 16 MiB 를 넘으면 54000 으로 거부한다", () => {
  assert.throws(
    () => encodeMessage({ id: 1, type: "execute", sql: "x".repeat(MAX_MESSAGE_BYTES) }),
    (error: unknown) => error instanceof DbError && error.sqlState === "54000",
  );
  assert.equal(JSON.parse(encodeMessage({ id: 1, type: "ping" }).toString()).type, "ping");
});

// ---------------------------------------------------------------------------
// UDP 신뢰성 계층 (가짜 시계와 손실·중복·지연 시뮬레이터)
// ---------------------------------------------------------------------------

test("UDP 패킷 : 헤더 20바이트 레이아웃을 왕복하고, 형식이 틀린 패킷은 버린다", () => {
  const packet = { flags: UdpFlags.DATA | UdpFlags.SYN, sessionId: 0xdeadbeef, seq: 7, fragIndex: 2, fragCount: 5, ackSeq: 6, payload: Buffer.from("본문") };
  const bytes = encodePacket(packet);
  assert.equal(bytes.length, UDP_HEADER_BYTES + packet.payload.length);
  assert.equal(bytes.readUInt16BE(0), 0x4857);
  assert.equal(bytes.readUInt8(2), 1);
  assert.deepEqual(decodePacket(bytes), packet);
  assert.equal(decodePacket(bytes.subarray(0, 19)), null, "헤더보다 짧다");
  const badMagic = Buffer.from(bytes);
  badMagic.writeUInt16BE(0x0000, 0);
  assert.equal(decodePacket(badMagic), null);
  const unknownFlag = Buffer.from(bytes);
  unknownFlag.writeUInt8(0x80 | UdpFlags.DATA, 3);
  assert.equal(decodePacket(unknownFlag), null);
  const emptyData = encodePacket({ ...packet, payload: Buffer.alloc(0) });
  assert.equal(decodePacket(emptyData), null, "DATA 의 본문이 비었다");
  const ackWithBody = encodePacket({ ...packet, flags: UdpFlags.ACK });
  assert.equal(decodePacket(ackWithBody), null, "DATA 가 아닌데 본문이 있다");
});

interface Pair {
  clock: FakeClock;
  a: ReliableEndpoint;
  b: ReliableEndpoint;
  toA: Link;
  toB: Link;
  receivedByA: Buffer[];
  receivedByB: Buffer[];
  failures: string[];
}

function makePair(options: { loss?: number; duplicate?: number; minDelay?: number; maxDelay?: number; seed?: number; maxPacketSize?: number }): Pair {
  const clock = new FakeClock();
  const random = createRandom(options.seed ?? 1);
  const receivedByA: Buffer[] = [];
  const receivedByB: Buffer[] = [];
  const failures: string[] = [];
  const link = { random, ...(options.loss === undefined ? {} : { loss: options.loss }), ...(options.duplicate === undefined ? {} : { duplicate: options.duplicate }), minDelay: options.minDelay ?? 5, maxDelay: options.maxDelay ?? 5 };
  const toA = new Link(clock, link, () => a);
  const toB = new Link(clock, link, () => b);
  const make = (port: Link, received: Buffer[], name: string): ReliableEndpoint =>
    new ReliableEndpoint(port.port, clock, {
      maxPacketSize: options.maxPacketSize ?? 1200,
      sessionId: () => 1,
      onMessage: (body) => received.push(body),
      onFailure: (error) => failures.push(`${name}: ${error.kind}`),
      maxMessageBytes: () => MAX_MESSAGE_BYTES,
    });
  const a: ReliableEndpoint = make(toB, receivedByA, "A");
  const b: ReliableEndpoint = make(toA, receivedByB, "B");
  return { clock, a, b, toA, toB, receivedByA, receivedByB, failures };
}

function payload(size: number, seed: number): Buffer {
  const random = createRandom(seed);
  const buffer = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buffer[i] = Math.floor(random() * 256);
  return buffer;
}

test("UDP 신뢰성 : 손실·중복·지연으로 순서가 뒤바뀌어도 메시지가 순서대로 한 번씩 온전히 전달된다", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const pair = makePair({ loss: 0.2, duplicate: 0.2, minDelay: 1, maxDelay: 40, seed, maxPacketSize: 256 });
    const sizes = [1, 100, 236, 237, 5000, 40_000, 1, 300];
    const sent = sizes.map((size, index) => payload(size, seed * 100 + index));
    for (const body of sent) pair.a.sendMessage(body);
    // B 도 A 에게 보낸다. (두 방향이 함께 돈다)
    const back = [payload(10, 99), payload(9000, 98)];
    for (const body of back) pair.b.sendMessage(body);
    const done = pair.clock.run(() => pair.receivedByB.length === sent.length && pair.receivedByA.length === back.length);
    assert.equal(done, true, `seed ${seed} : 모두 전달되어야 한다 (B ${pair.receivedByB.length}/${sent.length}, A ${pair.receivedByA.length}/${back.length})`);
    assert.deepEqual(pair.failures, []);
    pair.receivedByB.forEach((body, index) => assert.ok(body.equals(sent[index] as Buffer), `seed ${seed} : B 의 ${index}번째 메시지`));
    pair.receivedByA.forEach((body, index) => assert.ok(body.equals(back[index] as Buffer), `seed ${seed} : A 의 ${index}번째 메시지`));
    assert.ok(pair.toB.dropped > 0, "시험이 실제로 패킷을 잃게 했다");
    assert.ok(pair.toB.maxSize <= 256, `패킷이 maxPacketSize 를 넘지 않는다 (${pair.toB.maxSize})`);
  }
});

test("UDP 신뢰성 : 상대가 사라지면 재전송 한도(10번)를 넘긴 뒤 한 번만 실패를 알린다", () => {
  const pair = makePair({ loss: 1 });
  pair.a.sendMessage(Buffer.from("anyone there?"));
  pair.clock.run(() => pair.failures.length > 0);
  assert.deepEqual(pair.failures, ["A: retransmit-limit"]);
  assert.equal(pair.a.isStopped, true);
  pair.a.sendMessage(Buffer.from("after the failure")); // 멈춘 끝점은 조용히 무시한다.
  assert.equal(pair.failures.length, 1);
});

test("UDP 신뢰성 : 조각 수가 65,535 를 넘는 메시지는 보내지 않고 54000", () => {
  const pair = makePair({ maxPacketSize: 64 });
  assert.throws(
    () => pair.a.sendMessage(Buffer.alloc(44 * 65_536)),
    (error: unknown) => error instanceof DbError && error.sqlState === "54000",
  );
});

test("UDP 신뢰성 : 패킷 크기를 64 ~ 65,507 밖으로 정하면 거부한다", () => {
  const pair = makePair({});
  assert.throws(() => pair.a.setMaxPacketSize(63), RangeError);
  assert.throws(() => pair.a.setMaxPacketSize(65_508), RangeError);
  pair.a.setMaxPacketSize(64);
  pair.a.setMaxPacketSize(65_507);
});
