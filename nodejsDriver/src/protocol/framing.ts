/**
 * 스트림 위의 메시지 경계 (프레임).
 *
 * 담당
 *  - 보낼 때 : 본문의 바이트 수(4바이트, 빅엔디언)를 앞에 붙인다.
 *  - 받을 때 : 이어져 들어오는 바이트에서 메시지를 하나씩 잘라 낸다. 한 번에 여러 메시지가 오거나
 *    한 메시지가 여러 번에 나뉘어 오는 경우를 모두 처리한다.
 *  - 크기 제한을 본문을 모으기 **전에** 검사한다. 한도를 넘는 길이나 길이 0 은 본문을 받지 않고 오류로 끝낸다.
 *
 * TCP 가 쓴다. UDP 는 패킷 단위라서 이 모듈을 쓰지 않는다. (udpReliability.ts)
 * node:buffer 외에는 의존하지 않는다. 소켓은 다루지 않는다.
 *
 * 관련 사양 : AGENTS.md 상세 8 / rdbms/docs/protocol.md 2-1절
 * 구현 단계 : 12-2
 */

import { MAX_MESSAGE_BYTES } from "./messages.js";

/** 길이 접두의 바이트 수이다. */
export const FRAME_HEADER_BYTES = 4;

/** 프레임 규칙을 어긴 입력이다. 호출자가 연결 오류로 접속을 끊는다. */
export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

/** 본문 앞에 길이를 붙여 프레임 하나를 만든다. 본문이 비었거나 16 MiB 를 넘으면 RangeError 이다. */
export function encodeFrame(body: Uint8Array): Buffer {
  if (body.length === 0) throw new RangeError("A frame body must not be empty.");
  if (body.length > MAX_MESSAGE_BYTES) {
    throw new RangeError(`A frame body is too large: ${body.length} bytes (limit ${MAX_MESSAGE_BYTES}).`);
  }
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + body.length);
  frame.writeUInt32BE(body.length, 0);
  frame.set(body, FRAME_HEADER_BYTES);
  return frame;
}

/**
 * 프레임을 이어 받는 해석기이다. 접속마다 하나를 둔다.
 * 오류가 한 번 나면 그 접속은 끝난 것이므로 이후의 입력은 무시한다.
 */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  /** 첫 조각에서 이미 읽은 바이트 수이다. */
  private headOffset = 0;
  private buffered = 0;
  /** 읽는 중인 본문의 길이이다. 길이를 아직 읽지 못했으면 -1 이다. */
  private expected = -1;
  private failed = false;

  /** `maxBodyBytes` 는 길이를 읽는 순간의 한도를 돌려준다. */
  constructor(private readonly maxBodyBytes: () => number) {}

  /** 아직 메시지로 내보내지 않은 바이트 수이다. */
  get bufferedBytes(): number {
    return this.buffered;
  }

  /**
   * 들어온 바이트를 넣고, 완성된 메시지마다 `onMessage` 를 부른다.
   * 규칙을 어기면 `FrameError` 를 던진다. 던지기 전에 완성된 메시지는 이미 전달되었다.
   */
  push(chunk: Buffer, onMessage: (body: Buffer) => void): void {
    if (this.failed || chunk.length === 0) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    for (;;) {
      if (this.expected < 0) {
        if (this.buffered < FRAME_HEADER_BYTES) return;
        const length = this.take(FRAME_HEADER_BYTES).readUInt32BE(0);
        // 본문을 모으기 전에 길이부터 본다.
        const limit = this.maxBodyBytes();
        if (length === 0) throw this.fail("Frame length is zero.");
        if (length > limit) throw this.fail(`Frame is too large: ${length} bytes (limit ${limit}).`);
        this.expected = length;
      }
      if (this.buffered < this.expected) return;
      const body = this.take(this.expected);
      this.expected = -1;
      onMessage(body);
    }
  }

  private fail(message: string): FrameError {
    this.failed = true;
    this.chunks = [];
    this.headOffset = 0;
    this.buffered = 0;
    return new FrameError(message);
  }

  /** 앞에서 `count` 바이트를 떼어 새 버퍼로 돌려준다. `buffered >= count` 일 때만 부른다. */
  private take(count: number): Buffer {
    const first = this.chunks[0] as Buffer;
    const available = first.length - this.headOffset;
    let result: Buffer;
    if (available >= count) {
      // 조각 하나 안에 다 있다. 받은 조각의 메모리를 붙잡지 않도록 복사한다.
      result = Buffer.from(first.subarray(this.headOffset, this.headOffset + count));
      this.headOffset += count;
      if (this.headOffset === first.length) {
        this.chunks.shift();
        this.headOffset = 0;
      }
    } else {
      result = Buffer.allocUnsafe(count);
      let written = 0;
      while (written < count) {
        const head = this.chunks[0] as Buffer;
        const take = Math.min(head.length - this.headOffset, count - written);
        head.copy(result, written, this.headOffset, this.headOffset + take);
        written += take;
        this.headOffset += take;
        if (this.headOffset === head.length) {
          this.chunks.shift();
          this.headOffset = 0;
        }
      }
    }
    this.buffered -= count;
    return result;
  }
}
