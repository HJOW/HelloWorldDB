/**
 * 프레임 인코더와 해석기 테스트 (9단계, 9-2).
 * 관련 사양 : AGENTS.md 상세 8
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FRAME_HEADER_BYTES, FrameDecoder, FrameError, encodeFrame } from "../../src/net/framing.js";
import { MAX_MESSAGE_BYTES, MAX_PREAUTH_MESSAGE_BYTES } from "../../src/net/protocol.js";
import { createRandom } from "../types/helpers.js";

function collect(decoder: FrameDecoder, ...chunks: Buffer[]): string[] {
  const out: string[] = [];
  for (const chunk of chunks) decoder.push(chunk, (body) => out.push(body.toString("utf8")));
  return out;
}

function frames(...texts: string[]): Buffer {
  return Buffer.concat(texts.map((text) => encodeFrame(Buffer.from(text, "utf8"))));
}

test("프레임은 4바이트 빅엔디언 길이 뒤에 본문이 붙은 것이다", () => {
  const frame = encodeFrame(Buffer.from('{"id":1}', "utf8"));
  assert.equal(frame.length, FRAME_HEADER_BYTES + 8);
  assert.deepEqual([...frame.subarray(0, 4)], [0, 0, 0, 8]);
  assert.equal(frame.subarray(4).toString("utf8"), '{"id":1}');
  const long = encodeFrame(Buffer.alloc(0x0102_03, 1));
  assert.deepEqual([...long.subarray(0, 4)], [0, 0x01, 0x02, 0x03]);
});

test("빈 본문과 16 MiB 를 넘는 본문은 만들 수 없다", () => {
  assert.throws(() => encodeFrame(Buffer.alloc(0)), RangeError);
  assert.throws(() => encodeFrame(Buffer.alloc(MAX_MESSAGE_BYTES + 1)), RangeError);
  assert.equal(encodeFrame(Buffer.alloc(MAX_MESSAGE_BYTES)).length, MAX_MESSAGE_BYTES + 4);
});

test("한 번에 여러 메시지가 와도 모두 꺼낸다", () => {
  const decoder = new FrameDecoder(() => MAX_MESSAGE_BYTES);
  assert.deepEqual(collect(decoder, frames("a", "bb", "ccc")), ["a", "bb", "ccc"]);
  assert.equal(decoder.bufferedBytes, 0);
});

test("메시지가 쪼개져 와도 합쳐서 꺼낸다 (모든 경계, 1바이트씩)", () => {
  const all = frames("hello", "한글 😀", "x".repeat(300));
  const expected = ["hello", "한글 😀", "x".repeat(300)];
  for (let cut = 1; cut < all.length; cut++) {
    const decoder = new FrameDecoder(() => MAX_MESSAGE_BYTES);
    assert.deepEqual(collect(decoder, all.subarray(0, cut), all.subarray(cut)), expected, `cut=${cut}`);
  }
  const decoder = new FrameDecoder(() => MAX_MESSAGE_BYTES);
  const bytes = [...all].map((byte) => Buffer.from([byte]));
  assert.deepEqual(collect(decoder, ...bytes), expected);
});

test("무작위로 나눈 입력에서도 같은 메시지를 같은 순서로 꺼낸다", () => {
  const random = createRandom(20261016);
  for (let round = 0; round < 50; round++) {
    const messages = Array.from({ length: 1 + Math.floor(random() * 8) }, () => "m".repeat(1 + Math.floor(random() * 2000)));
    const all = frames(...messages);
    const parts: Buffer[] = [];
    for (let at = 0; at < all.length; ) {
      const size = 1 + Math.floor(random() * 700);
      parts.push(all.subarray(at, at + size));
      at += size;
    }
    const decoder = new FrameDecoder(() => MAX_MESSAGE_BYTES);
    assert.deepEqual(collect(decoder, ...parts), messages, `round=${round}`);
  }
});

test("길이 0 인 프레임은 오류이다", () => {
  const decoder = new FrameDecoder(() => MAX_MESSAGE_BYTES);
  assert.throws(() => collect(decoder, Buffer.from([0, 0, 0, 0])), FrameError);
});

test("한도를 넘는 길이는 본문을 받기 전에 거부한다", () => {
  const decoder = new FrameDecoder(() => MAX_PREAUTH_MESSAGE_BYTES);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_PREAUTH_MESSAGE_BYTES + 1, 0);
  // 본문은 한 바이트도 보내지 않았다. 헤더만으로 거부해야 메모리를 쓰게 하지 못한다.
  assert.throws(() => collect(decoder, header), FrameError);
  assert.equal(decoder.bufferedBytes, 0);
  // 4GiB 에 가까운 길이도 마찬가지이다.
  const huge = new FrameDecoder(() => MAX_MESSAGE_BYTES);
  assert.throws(() => collect(huge, Buffer.from([0xff, 0xff, 0xff, 0xff])), FrameError);
});

test("한도와 같은 길이는 받는다", () => {
  const decoder = new FrameDecoder(() => 100);
  assert.deepEqual(collect(decoder, frames("x".repeat(100))), ["x".repeat(100)]);
});

test("한도는 길이를 읽는 순간의 값을 쓴다 (인증 뒤에 커진다)", () => {
  let limit = 10;
  const decoder = new FrameDecoder(() => limit);
  assert.deepEqual(collect(decoder, frames("small")), ["small"]);
  assert.throws(() => collect(decoder, frames("x".repeat(50))), FrameError);
  limit = 1000;
  const later = new FrameDecoder(() => limit);
  assert.deepEqual(collect(later, frames("x".repeat(50))), ["x".repeat(50)]);
});

test("오류가 난 해석기는 이후의 입력을 무시한다", () => {
  const decoder = new FrameDecoder(() => 10);
  assert.throws(() => collect(decoder, frames("x".repeat(50))), FrameError);
  assert.deepEqual(collect(decoder, frames("ok")), []);
});

test("오류 전에 완성된 메시지는 전달된다", () => {
  const decoder = new FrameDecoder(() => 10);
  const received: string[] = [];
  const bad = Buffer.concat([frames("good"), Buffer.from([0, 0, 0, 99])]);
  assert.throws(() => decoder.push(bad, (body) => received.push(body.toString())), FrameError);
  assert.deepEqual(received, ["good"]);
});

test("큰 메시지(16 MiB)를 여러 조각으로 받는다", () => {
  const decoder = new FrameDecoder(() => MAX_MESSAGE_BYTES);
  const body = Buffer.alloc(MAX_MESSAGE_BYTES, 0x61);
  const frame = encodeFrame(body);
  const received: number[] = [];
  for (let at = 0; at < frame.length; at += 65_536) {
    decoder.push(frame.subarray(at, at + 65_536), (message) => received.push(message.length));
  }
  assert.deepEqual(received, [MAX_MESSAGE_BYTES]);
});
