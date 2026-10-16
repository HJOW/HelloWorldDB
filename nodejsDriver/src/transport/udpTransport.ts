/**
 * UDP 전송 계층.
 *
 * 담당
 *  - 서버의 UDP 포트에 연결한 소켓(`dgram`, 한 상대만 받는다) 위에서 신뢰성 계층(protocol/udpReliability.ts)으로 메시지를 주고받는다.
 *  - 세션 번호 : 첫 메시지(`hello`)는 번호 0 의 `SYN|DATA` 로 나가고, 서버의 첫 응답 패킷에 실린 번호를 이후의 모든 패킷에 싣는다.
 *    다른 번호의 패킷은 버린다. `RST`(서버가 이 세션을 모른다)를 받으면 접속이 끝난 것이다.
 *  - 패킷 크기 : 처음에는 1200 바이트이고, `helloOk` 가 알려 주는 서버의 `udp.maxPacketSize` 에 맞춘다. (`onHello`)
 *  - 세션 유지 : 서버는 `udp.sessionTimeoutMs` 동안 패킷이 없으면 세션을 끝낸다. 유휴 상태에서 그 시간의 1/3 마다 ping 을 보내는 일은
 *    `Connection` 이 한다. (요청 `id` 를 `Connection` 이 관리하므로)
 *  - 재전송 한도(10번)를 넘으면 접속이 끝난 것으로 보고 08006 으로 알린다. 처음 응답을 받기 전에 ICMP "도달 불가" 가 오면 서버가 없는 것으로 본다.
 *  - 닫을 때는 FIN 을 보내 서버가 세션을 바로 정리하게 한다.
 *
 * UDP 구간은 암호화하지 않는다. 비밀번호는 SCRAM 이라 평문으로 오가지 않지만 이후의 문장과 결과는 평문이다.
 *
 * 관련 사양 : AGENTS.md 상세 8 / rdbms/docs/protocol.md 2-4절
 * 구현 단계 : 12-2
 */

import dgram from "node:dgram";
import net from "node:net";
import { connectionFailure } from "../errors.js";
import { MAX_MESSAGE_BYTES } from "../protocol/messages.js";
import { ReliableEndpoint, UdpFlags, decodePacket, encodePacket, realClock } from "../protocol/udpReliability.js";
import type { UdpPacket, UdpReliabilityError } from "../protocol/udpReliability.js";
import type { MessageTransport, TransportHandlers } from "./tcpTransport.js";

/** 처음 쓰는 패킷 크기이다. 서버가 알려 주는 값에 맞춘다. */
const INITIAL_PACKET_SIZE = 1200;

/** 인증 뒤의 큰 결과를 받아야 하므로 메시지 하나의 최대 크기(16 MiB)로 둔다. */
const RECEIVE_LIMIT = MAX_MESSAGE_BYTES;

export async function connectUdp(host: string, port: number): Promise<MessageTransport> {
  const socket = dgram.createSocket({ type: net.isIPv6(host) ? "udp6" : "udp4" });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      socket.close();
      reject(connectionFailure(`Cannot open a UDP socket to ${host}:${port}: ${error.message}`, error));
    };
    socket.once("error", onError);
    // connect 는 한 상대만 받도록 소켓을 묶는다. 호스트 이름이면 여기서 주소를 푼다.
    socket.connect(port, host, () => {
      socket.off("error", onError);
      resolve();
    });
  });

  let handlers: TransportHandlers | null = null;
  let sessionId = 0;
  let closed = false;
  let heardFromServer = false;
  const early: Buffer[] = [];

  const finish = (error: Error | null): void => {
    if (closed) return;
    closed = true;
    reliable.stop();
    try {
      socket.close();
    } catch {
      // 이미 닫힌 소켓이다.
    }
    handlers?.onClose(error);
  };

  const reliable = new ReliableEndpoint(
    {
      send: (packet) => {
        if (closed) return;
        socket.send(packet, (error) => {
          if (error !== null && !closed) finish(connectionFailure(`UDP send failed: ${error.message}`, error));
        });
      },
    },
    realClock,
    {
      maxPacketSize: INITIAL_PACKET_SIZE,
      sessionId: () => sessionId,
      onMessage: (body) => {
        if (handlers === null) early.push(body);
        else handlers.onMessage(body);
      },
      onFailure: (error: UdpReliabilityError) => {
        finish(connectionFailure(error.kind === "retransmit-limit" ? "The server did not respond (UDP retransmissions exhausted)." : `UDP protocol error: ${error.message}`, error));
      },
      maxMessageBytes: () => RECEIVE_LIMIT,
    },
  );

  socket.on("message", (message) => {
    const packet = decodePacket(message);
    if (packet === null || closed) return;
    // 세션 번호를 아직 모르면 서버의 첫 응답에서 배운다. 이미 알면 다른 번호는 버린다.
    if (sessionId === 0) {
      if (packet.sessionId === 0) return;
      sessionId = packet.sessionId;
    } else if (packet.sessionId !== sessionId) {
      return;
    }
    heardFromServer = true;
    if ((packet.flags & UdpFlags.RST) !== 0) {
      finish(connectionFailure("The server does not know this UDP session; it may have timed out."));
      return;
    }
    if ((packet.flags & UdpFlags.FIN) !== 0) {
      finish(null);
      return;
    }
    reliable.receivePacket(packet);
  });
  socket.on("error", (error: NodeJS.ErrnoException) => {
    // 서버가 없으면 ICMP "도달 불가" 가 ECONNREFUSED(Windows 는 ECONNRESET)로 올라온다. 응답을 한 번도 받기 전이면 서버가 없는 것으로 본다.
    if (!heardFromServer && (error.code === "ECONNREFUSED" || error.code === "ECONNRESET")) {
      const cause = Object.assign(new Error(error.message), { code: "ECONNREFUSED" });
      finish(connectionFailure(`Cannot reach ${host}:${port}: nothing is listening on that UDP port.`, cause));
      return;
    }
    finish(connectionFailure(`UDP socket error: ${error.message}`, error));
  });

  return {
    send(body: Buffer): void {
      if (closed) return;
      reliable.sendMessage(body);
    },
    close(): void {
      if (closed) return;
      // 서버가 세션을 바로 정리하도록 FIN 을 보낸다. 유실될 수 있어 두 번 보낸다. 서버는 세션 시간 제한으로도 정리한다.
      if (sessionId !== 0) {
        const fin: UdpPacket = { flags: UdpFlags.FIN, sessionId, seq: 0, fragIndex: 0, fragCount: 0, ackSeq: reliable.deliveredSeq, payload: Buffer.alloc(0) };
        const bytes = encodePacket(fin);
        socket.send(bytes, () => undefined);
        socket.send(bytes, () => undefined);
      }
      // 이미 보낸 FIN 이 나가도록 소켓은 잠깐 뒤에 닫는다.
      closed = true;
      reliable.stop();
      handlers?.onClose(null);
      const closeLater = setTimeout(() => {
        try {
          socket.close();
        } catch {
          // 이미 닫힌 소켓이다.
        }
      }, 50);
      closeLater.unref();
    },
    setHandlers(next: TransportHandlers): void {
      handlers = next;
      for (const body of early.splice(0)) next.onMessage(body);
      if (closed) next.onClose(null);
    },
    onHello(info) {
      if (info.udp !== undefined) {
        try {
          reliable.setMaxPacketSize(Math.min(INITIAL_PACKET_SIZE, info.udp.maxPacketSize));
        } catch {
          // 서버가 알려 준 크기가 범위 밖이면 기본값을 그대로 쓴다.
        }
      }
    },
  };
}
