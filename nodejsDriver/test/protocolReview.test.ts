/** 잘못된 서버 응답과 인증 중 정지를 실제 TCP 소켓으로 재현한다. */
import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { connect, DbError } from "../src/index.js";
import { ProtocolConnection } from "../src/protocol/protocolConnection.js";
import { FrameDecoder, encodeFrame } from "../src/protocol/framing.js";
import { decodeResponse, MAX_MESSAGE_BYTES } from "../src/protocol/messages.js";
import { streamTransport } from "../src/transport/tcpTransport.js";

function hello(id: number) {
  return { id, type: "helloOk", version: 1, server: "test", mechanism: "SCRAM-SHA-256", maxMessageBytes: MAX_MESSAGE_BYTES, defaultFetchSize: 500 };
}

test("수신 핸들러 등록 전에 끝난 소켓도 닫힘을 알려 준다", async () => {
  const socket = new net.Socket();
  const transport = streamTransport(socket);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.destroy();
  await closed;
  let notifications = 0;
  transport.setHandlers({ onMessage: () => {}, onClose: () => { notifications++; } });
  assert.equal(notifications, 1);
});

async function peer(t: TestContext, respond: (message: Record<string, any>, send: (body: object) => void, socket: net.Socket) => void) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    const decoder = new FrameDecoder(() => MAX_MESSAGE_BYTES);
    socket.on("data", (chunk: Buffer) => decoder.push(chunk, (body) => {
      respond(JSON.parse(body.toString("utf8")), (message) => socket.write(encodeFrame(Buffer.from(JSON.stringify(message)))), socket);
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as net.AddressInfo).port;
}

for (const stage of ["authStart", "authFinish"]) {
  test(`connectTimeoutMs는 ${stage} 응답 대기에도 적용된다`, async (t) => {
    let fallback: ReturnType<typeof setTimeout> | undefined;
    t.after(() => clearTimeout(fallback));
    const port = await peer(t, (message, send, socket) => {
      if (message.type === "hello") send(hello(message.id));
      else if (message.type === "authStart" && stage === "authFinish") {
        const nonce = /,r=(.*)$/.exec(message.clientFirst)![1];
        send({ id: message.id, type: "authChallenge", serverFirst: `r=${nonce}server,s=c2FsdA==,i=1` });
      } else {
        // 수정 전에도 시험이 끝나도록 상대가 나중에 접속을 끊는다.
        fallback = setTimeout(() => socket.destroy(), 600);
      }
    });
    const started = Date.now();
    await assert.rejects(connect({ port, user: "u", password: "p", connectTimeoutMs: 100 }), DbError);
    assert.ok(Date.now() - started < 450, "인증 응답이 없어도 연결 제한 시간 안에 끝나야 한다");
  });
}

test("서버가 제시한 미지원 프로토콜 버전을 거부한다", async (t) => {
  const port = await peer(t, (message, send) => send({ ...hello(message.id), version: 2 }));
  let accepted: ProtocolConnection | undefined;
  t.after(() => accepted?.abort());
  await assert.rejects(async () => { accepted = await ProtocolConnection.open({ kind: "tcp", host: "127.0.0.1", port }, { connectTimeoutMs: 1000, clientName: "test" }); }, DbError);
});

test("행 배열이 깨진 응답은 연결 오류로 거부하고 즉시 접속을 끝낸다", async (t) => {
  const port = await peer(t, (message, send) => {
    if (message.type === "hello") send(hello(message.id));
    else send({ id: message.id, type: "rows", columns: [], rows: [42], hasMore: false });
  });
  const connection = await ProtocolConnection.open({ kind: "tcp", host: "127.0.0.1", port }, { connectTimeoutMs: 1000, clientName: "test" });
  t.after(() => connection.abort());
  await assert.rejects(connection.execute("SELECT 1", []), DbError);
  assert.equal(connection.isClosed, true);
});

test("커서·컬럼·세션·오류 응답의 잘못된 필드를 거부한다", () => {
  for (const response of [
    { id: 1, type: "rows", rows: [[1]], hasMore: true },
    { id: 1, type: "rows", rows: [[1]], hasMore: false, cursor: -1 },
    { id: 1, type: "rows", rows: [[{}]], hasMore: false },
    { id: 1, type: "rows", rows: [[1]], hasMore: false, columns: [null] },
    { id: 1, type: "authOk", serverFinal: "v=x", session: {} },
    { ...hello(1), defaultFetchSize: 0 },
    { id: 1, type: "error", sqlState: "oops", code: 1, message: "x" },
    { id: 1, type: "bye", rolledBack: "yes" },
  ]) assert.equal(decodeResponse(Buffer.from(JSON.stringify(response))).ok, false, JSON.stringify(response));
});
