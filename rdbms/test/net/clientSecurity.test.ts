/**
 * 클라이언트의 서버 확인 테스트 (9단계). 서버가 보낸 SCRAM 메시지를 중간에서 바꾸는 프록시를 끼워,
 * 클라이언트가 서버 서명과 nonce 를 검증하고 속은 접속을 끊는지 본다. (상호 인증)
 * 관련 사양 : AGENTS.md 상세 8
 */
import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { Connection } from "../../src/client/connection.js";
import { DbError } from "../../src/common/errors.js";
import { FrameDecoder, encodeFrame } from "../../src/net/framing.js";
import { MAX_MESSAGE_BYTES } from "../../src/net/protocol.js";
import { TcpServer } from "../../src/net/tcpServer.js";
import { Database } from "../../src/session/session.js";
import { tempDir } from "../exec/helpers.js";
import { capturingLogger, freePort, makeEnvironment, waitFor } from "./helpers.js";

type Rewrite = (message: Record<string, unknown>) => Record<string, unknown>;

/** 서버 → 클라이언트 방향의 프레임을 해석해 `rewrite` 로 바꾼 뒤 전달하는 프록시이다. */
async function startTamperingProxy(serverPort: number, rewrite: Rewrite): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    const upstream = net.connect(serverPort, "127.0.0.1");
    sockets.add(upstream);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.on("data", (chunk) => upstream.write(chunk));
    const decoder = new FrameDecoder(() => MAX_MESSAGE_BYTES);
    upstream.on("data", (chunk) => {
      decoder.push(chunk, (body) => {
        const message = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        client.write(encodeFrame(Buffer.from(JSON.stringify(rewrite(message)), "utf8")));
      });
    });
  });
  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function setup(t: { after(fn: () => unknown): void }, rewrite: Rewrite): Promise<{ proxyPort: number; db: Database }> {
  const dir = tempDir(t);
  const db = Database.open(dir, { onWarning: () => {}, scramIterations: 1000 });
  const env = makeEnvironment(db, { logger: capturingLogger() });
  const serverPort = await freePort();
  const tcp = new TcpServer(env, { host: "127.0.0.1", port: serverPort });
  await tcp.start();
  const proxy = await startTamperingProxy(serverPort, rewrite);
  t.after(async () => {
    await proxy.close();
    await tcp.closeConnections(300);
    db.close();
  });
  return { proxyPort: proxy.port, db };
}

const isConnectionFailure = (error: unknown): boolean => error instanceof DbError && error.sqlState === "08006";

test("프록시가 아무것도 바꾸지 않으면 로그인된다 (시험 장치 확인)", async (t) => {
  const { proxyPort } = await setup(t, (message) => message);
  const connection = await Connection.open({ kind: "tcp", host: "127.0.0.1", port: proxyPort });
  assert.equal((await connection.login({ user: "SYSTEM", password: "HelloWorldDB" })).user, "SYSTEM");
  await connection.close();
});

test("서버 서명이 틀리면 클라이언트는 서버를 믿지 않고 접속을 끊는다", async (t) => {
  const { proxyPort } = await setup(t, (message) => {
    if (message["type"] !== "authOk") return message;
    // 같은 길이의 다른 서명으로 바꾼다.
    return { ...message, serverFinal: `v=${Buffer.alloc(32, 7).toString("base64")}` };
  });
  const connection = await Connection.open({ kind: "tcp", host: "127.0.0.1", port: proxyPort });
  await assert.rejects(connection.login({ user: "SYSTEM", password: "HelloWorldDB" }), (error) => {
    assert.ok(isConnectionFailure(error));
    assert.match((error as DbError).message, /could not prove/);
    return true;
  });
  await waitFor(() => connection.isClosed, 3000, "the client to drop the connection");
  assert.equal(connection.session, null, "서버를 확인하지 못했으므로 세션 정보를 받아들이지 않는다");
});

test("서버 서명이 없거나 형식이 틀려도 마찬가지이다", async (t) => {
  for (const serverFinal of ["", "v=", "x=abc", "v=!!!not-base64!!!"]) {
    const { proxyPort } = await setup(t, (message) => (message["type"] === "authOk" ? { ...message, serverFinal } : message));
    const connection = await Connection.open({ kind: "tcp", host: "127.0.0.1", port: proxyPort });
    await assert.rejects(connection.login({ user: "SYSTEM", password: "HelloWorldDB" }), isConnectionFailure, JSON.stringify(serverFinal));
    await waitFor(() => connection.isClosed, 3000, "the client to drop the connection");
  }
});

test("서버 nonce 가 클라이언트 nonce 로 시작하지 않으면 클라이언트는 비밀번호 증명을 보내지 않는다", async (t) => {
  const { proxyPort } = await setup(t, (message) => {
    if (message["type"] !== "authChallenge") return message;
    // nonce 를 통째로 다른 값으로 바꾼다.
    return { ...message, serverFirst: String(message["serverFirst"]).replace(/^r=[^,]+/, "r=forged-nonce-without-client-part") };
  });
  const connection = await Connection.open({ kind: "tcp", host: "127.0.0.1", port: proxyPort });
  await assert.rejects(connection.login({ user: "SYSTEM", password: "HelloWorldDB" }), (error) => {
    assert.ok(isConnectionFailure(error));
    assert.match((error as DbError).message, /invalid SCRAM challenge/);
    return true;
  });
  await waitFor(() => connection.isClosed, 3000, "the client to drop the connection");
});

test("비정상적인 반복 횟수나 깨진 챌린지는 거부한다 (클라이언트가 오래 계산하지 않는다)", async (t) => {
  for (const replacement of ["i=99999999999", "i=0", "i=abc", "garbage"]) {
    const { proxyPort } = await setup(t, (message) => {
      if (message["type"] !== "authChallenge") return message;
      const serverFirst = String(message["serverFirst"]);
      return { ...message, serverFirst: replacement === "garbage" ? "garbage" : serverFirst.replace(/i=\d+/, replacement) };
    });
    const connection = await Connection.open({ kind: "tcp", host: "127.0.0.1", port: proxyPort });
    const started = Date.now();
    await assert.rejects(connection.login({ user: "SYSTEM", password: "HelloWorldDB" }), isConnectionFailure, replacement);
    assert.ok(Date.now() - started < 2000, `${replacement}: 오래 계산하지 않는다`);
  }
});

test("응답이 깨진 서버(JSON 이 아닌 메시지)에는 예외 없이 접속 실패로 알린다", async (t) => {
  const port = await freePort();
  const fake = net.createServer((socket) => {
    socket.on("error", () => undefined);
    socket.on("data", () => {
      socket.write(encodeFrame(Buffer.from("this is not json")));
    });
  });
  await new Promise<void>((resolve) => fake.listen(port, "127.0.0.1", () => resolve()));
  t.after(() => fake.close());
  await assert.rejects(Connection.open({ kind: "tcp", host: "127.0.0.1", port }, { internal: { connectTimeoutMs: 2000 } }), isConnectionFailure);
});
