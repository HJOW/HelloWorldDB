/**
 * 스트림 소켓 하나를 메시지 처리기에 잇는 공통 코드. 로컬 전용 채널과 TCP(TLS 포함)가 함께 쓴다.
 *
 * 담당
 *  - 프레임 해석기(framing.ts)로 소켓의 바이트를 메시지로 잘라 처리기에 넘긴다. 프레임 규칙을 어기면 위반으로 접속을 끊는다.
 *  - 처리기가 보낸 메시지에 프레임을 붙여 쓴다. `socket.write` 가 false 를 돌려주면 `drain` 까지 처리기가 다음 요청을 처리하지 않게 한다.
 *  - 연결이 끊기거나 오류가 나면 처리기를 정리한다(`dispose`). 세션 롤백과 잠금 해제는 그 안에서 일어난다.
 *  - `close()` 는 보낸 것을 모두 내보낸 뒤 접속을 닫는다. 상대가 닫지 않으면 유예 시간 뒤에 강제로 끊는다.
 *  - 소켓 옵션 : TCP 는 `setNoDelay(true)`(작은 메시지의 지연 제거), `setKeepAlive(true, 30_000)`(끊어진 상대 감지).
 *    읽기 유휴 제한은 두지 않는다. (세션 유휴는 `session.idleTimeoutMs` 가 한다)
 *
 * 인증 전 접속 수 제한은 `MessageHandler.open` 이 하며, 가득 차서 처리기를 못 열면 소켓을 바로 끊는다(응답 없음).
 *
 * 관련 사양 : AGENTS.md 상세 8
 * 구현 단계 : 9단계 (9-5)
 */

import type net from "node:net";
import { FrameDecoder, FrameError, encodeFrame } from "./framing.js";
import { MessageHandler } from "./messageHandler.js";
import type { ConnectionEndpoint, HandlerEnvironment } from "./messageHandler.js";
import type { Channel } from "./protocol.js";

/** `close()` 뒤에 상대가 접속을 닫지 않을 때 강제로 끊기까지의 유예(ms)이다. */
export const CLOSE_GRACE_MS = 2000;

/**
 * 소켓 하나를 서비스한다. 처리기를 열지 못하면(인증 전 접속 수 초과) 소켓을 바로 끊고 null 을 돌려준다.
 * 접속이 끝나면 `onGone` 을 한 번 부른다. (서버가 소켓 목록에서 빼는 데 쓴다)
 */
export function serveStream(
  socket: net.Socket,
  env: HandlerEnvironment,
  channel: Channel,
  remoteAddress: string | null,
  onGone: () => void,
): MessageHandler | null {
  let blocked = false;
  let closing = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let drainWaiters: Array<() => void> = [];

  const releaseWaiters = (): void => {
    blocked = false;
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const waiter of waiters) waiter();
  };

  const endpoint: ConnectionEndpoint = {
    channel,
    remoteAddress,
    send(body: Buffer): void {
      if (socket.destroyed || !socket.writable) return;
      if (!socket.write(encodeFrame(body))) blocked = true;
    },
    close(): void {
      if (closing) return;
      closing = true;
      if (socket.destroyed) return;
      socket.end();
      // 상대가 닫지 않아도 접속이 남지 않게 한다.
      graceTimer = setTimeout(() => socket.destroy(), CLOSE_GRACE_MS);
      graceTimer.unref();
    },
    drained(): Promise<void> {
      if (!blocked || socket.destroyed) return Promise.resolve();
      return new Promise<void>((resolve) => drainWaiters.push(resolve));
    },
  };

  const handler = MessageHandler.open(env, endpoint);
  if (handler === null) {
    // 응답을 만들지 않고 바로 끊는다. (불필요한 응답을 만들지 않기 위함)
    socket.destroy();
    onGone();
    return null;
  }

  if (channel === "tcp") {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
  }
  const decoder = new FrameDecoder(() => handler.maxBodyBytes);
  let gone = false;
  const finish = (): void => {
    if (gone) return;
    gone = true;
    if (graceTimer !== null) clearTimeout(graceTimer);
    releaseWaiters();
    handler.dispose();
    onGone();
  };

  socket.on("data", (chunk: Buffer) => {
    try {
      decoder.push(chunk, (body) => handler.receive(body));
    } catch (error) {
      if (error instanceof FrameError) {
        handler.protocolFailure(error.message);
        return;
      }
      env.logger.error(`Unexpected error while reading a frame: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      socket.destroy();
    }
  });
  socket.on("drain", releaseWaiters);
  socket.on("error", (error: Error) => {
    // 연결이 끊기는 오류(ECONNRESET 등)는 흔하다. 세션 정리는 close 에서 한다.
    env.logger.debug(`Socket error on a ${channel} connection: ${error.message}`);
  });
  socket.on("close", finish);
  return handler;
}
