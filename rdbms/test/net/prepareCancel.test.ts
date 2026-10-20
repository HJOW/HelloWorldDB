/** prepare/describe·cancel의 프로토콜·전송 경로·경합 시험. PD-5 ~ PD-6. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Database } from "../../src/session/session.js";
import { Connection } from "../../src/client/connection.js";
import { TcpServer } from "../../src/net/tcpServer.js";
import { LocalChannelServer } from "../../src/net/localChannelServer.js";
import { UdpServer } from "../../src/net/udpServer.js";
import { decodeRequest, encodeMessage } from "../../src/net/protocol.js";
import { Driver, FakeEndpoint, makeEnvironment, freePort, waitFor } from "./helpers.js";
import { tempDir, state } from "../exec/helpers.js";
import { LossyProxy } from "./udpProxy.js";

test("신규 요청의 ID·타입 힌트·파라미터 필드를 검증한다", () => {
  for (const message of [
    { type: "prepare", sql: 1 }, { type: "prepare", sql: "SELECT ?", parameterTypes: [1] },
    { type: "describe", statement: 0 }, { type: "cancel", targetId: -1 },
    { type: "executePrepared", statement: 1, params: {} }, { type: "closePrepared", statement: 1.1 },
  ]) {
    const result = decodeRequest(encodeMessage({ id: 1, ...message }));
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.fatal, false); assert.equal(result.error.sqlState, "22023"); }
  }
});

test("준비 문장 메타데이터·UNKNOWN·실행·커서·해제와 세션 경계", async t => {
  const db = Database.open(tempDir(t), { onWarning() {}, scramIterations: 1000 });
  const env = makeEnvironment(db); const driver = Driver.open(env, new FakeEndpoint())!;
  t.after(() => { driver.handler.dispose(); db.close(); });
  assert.equal((await driver.login("SYSTEM", "HelloWorldDB")).type, "authOk");
  const p = await driver.request({ type: "prepare", sql: "SELECT ? AS X" });
  assert.equal(p.type, "prepared"); assert.equal(p.columns[0].typeName, "UNKNOWN");
  const d = await driver.request({ type: "describe", statement: p.statement, parameterTypes: ["DECIMAL(12,2)"] });
  assert.equal(d.columns[0].precision, 12); assert.equal(d.columns[0].scale, 2);
  const result = await driver.request({ type: "executePrepared", statement: p.statement, params: ["1234567890.12"] });
  assert.deepEqual(result.rows, [["1234567890.12"]]); assert.equal(result.columns[0].typeName, "DECIMAL");
  assert.equal((await driver.request({ type: "closePrepared", statement: p.statement })).type, "preparedClosed");
  assert.equal((await driver.request({ type: "executePrepared", statement: p.statement })).sqlState, "26000");
  const other = Driver.open(env, new FakeEndpoint())!; t.after(() => other.handler.dispose());
  await other.login("SYSTEM", "HelloWorldDB");
  const q = await driver.request({ type: "prepare", sql: "SELECT 1" });
  assert.equal((await other.request({ type: "describe", statement: q.statement })).sqlState, "26000");
});

test("취소는 실행 대기열을 우회하고 늦은 취소는 다음 요청을 건드리지 않는다", async t => {
  const db = Database.open(tempDir(t), { onWarning() {}, scramIterations: 1000, lockTimeoutMs: 10000 });
  const env = makeEnvironment(db); const driver = Driver.open(env, new FakeEndpoint())!;
  t.after(() => { driver.handler.dispose(); db.close(); }); await driver.login("SYSTEM", "HelloWorldDB");
  await driver.execute("CREATE TABLE T (N INTEGER PRIMARY KEY, V INTEGER)"); await driver.execute("INSERT INTO T VALUES (1, 0), (2, 0)");
  const blocker = db.createSession({}); blocker.execute("BEGIN"); blocker.execute("UPDATE T SET V=10 WHERE N=1");
  await driver.execute("BEGIN"); await driver.execute("UPDATE T SET V=5 WHERE N=2");
  const executing = driver.send({ type: "execute", sql: "UPDATE T SET V=20 WHERE N=1" });
  await waitFor(() => driver.handler.busy);
  await new Promise<void>(resolve => setImmediate(resolve));
  const next = driver.send({ type: "execute", sql: "SELECT V FROM T WHERE N=2" });
  const cancel = driver.send({ type: "cancel", targetId: executing });
  const responses = [await driver.endpoint.next(), await driver.endpoint.next(), await driver.endpoint.next()];
  assert.equal(responses[0]!.id, cancel); assert.equal(responses[0]!.status, "accepted");
  assert.equal(responses.find(r => r.id === executing)!.sqlState, "57014");
  assert.deepEqual(responses.find(r => r.id === next)!.rows, [[5]]);
  assert.equal((await driver.request({ type: "cancel", targetId: executing })).status, "notRunning");
  await driver.execute("COMMIT"); blocker.execute("ROLLBACK");
  assert.deepEqual((await driver.execute("SELECT V FROM T ORDER BY N")).rows, [[0], [5]]);
});

test("확정 단계의 DDL 대기는 tooLate이며 취소 성공으로 알리지 않는다", async t => {
  const db = Database.open(tempDir(t), { onWarning() {}, scramIterations: 1000, lockTimeoutMs: 10000 });
  const driver = Driver.open(makeEnvironment(db), new FakeEndpoint())!;
  t.after(() => { driver.handler.dispose(); db.close(); }); await driver.login("SYSTEM", "HelloWorldDB");
  await driver.execute("CREATE TABLE T (N INTEGER PRIMARY KEY)"); await driver.execute("INSERT INTO T VALUES (1)");
  const blocker = db.createSession({}); blocker.execute("BEGIN"); blocker.execute("UPDATE T SET N=1");
  const id = driver.send({ type: "execute", sql: "DROP TABLE T" });
  await new Promise<void>(resolve => setImmediate(resolve));
  const cancel = driver.send({ type: "cancel", targetId: id });
  const ack = await driver.endpoint.next(); assert.equal(ack.id, cancel); assert.equal(ack.status, "tooLate");
  blocker.execute("ROLLBACK"); assert.equal((await driver.endpoint.next()).type, "ok");
});

for (const channel of ["tcp", "tls", "local", "udp", "lossyUdp"] as const) test(`${channel}: 실제 연결에서 준비·설명·CPU 질의 취소와 연결 재사용`, { timeout: 30000 }, async t => {
  const dir = tempDir(t); const db = Database.open(dir, { onWarning() {}, scramIterations: 1000, lockTimeoutMs: 10000 });
  const env = makeEnvironment(db); const port = await freePort();
  const fixture = (name: string) => fileURLToPath(new URL(`../../../test/fixtures/tls/${name}`, import.meta.url));
  const ssl = channel === "tls" ? { certPath: fixture("server-a.cert.pem"), keyPath: fixture("server-a.key.pem"), minVersion: "TLSv1.2" as const } : undefined;
  const server = channel === "local" ? new LocalChannelServer(env, port)
    : channel === "udp" || channel === "lossyUdp" ? new UdpServer(env, { host: "127.0.0.1", port, maxPacketSize: 1200, sessionTimeoutMs: 60000 })
    : new TcpServer(env, { host: "127.0.0.1", port, ssl });
  let proxy: LossyProxy | undefined;
  const clients: Connection[] = [];
  t.after(async () => { clients.forEach(c => c.abort()); await proxy?.close(); await server.closeConnections(500); db.close(); });
  await server.start();
  if (channel === "lossyUdp") { proxy = new LossyProxy({ serverPort: port, lossToServer: 0.1, lossToClient: 0.1, duplicate: 0.1, seed: 123 }); await proxy.start(); }
  const target = channel === "local" ? { kind: "local" as const, port }
    : channel === "udp" || channel === "lossyUdp" ? { kind: "udp" as const, host: "127.0.0.1", port: proxy?.port ?? port }
    : { kind: "tcp" as const, host: "127.0.0.1", port, ...(ssl ? { ssl: { ca: fs.readFileSync(ssl.certPath, "utf8") } } : {}) };
  const connection = await Connection.open(target, { requestTimeoutMs: 20000 }); clients.push(connection);
  await connection.login({ user: "SYSTEM", password: "HelloWorldDB" });
  const observer = await Connection.open(target, { requestTimeoutMs: 20000 }); clients.push(observer);
  await observer.login({ user: "SYSTEM", password: "HelloWorldDB" });
  assert.deepEqual(connection.hello.capabilities, ["prepareDescribe", "cancel"]);
  await connection.execute("CREATE TABLE T (N INTEGER)");
  await connection.execute("INSERT INTO T VALUES " + Array.from({length: 150}, (_, i) => `(${i})`).join(","));
  const prepared = await connection.request({ type: "prepare", sql: "SELECT CAST(? AS DECIMAL(12,0))" });
  assert.equal(prepared.type, "prepared");
  if (prepared.type !== "prepared") throw new Error("prepare response");
  assert.equal((await connection.request({ type: "describe", statement: prepared.statement })).type, "description");
  assert.equal((await connection.request({ type: "executePrepared", statement: prepared.statement, params: ["42"] })).type, "rows");
  const cpu = connection.startRequest({ type: "execute", sql: "SELECT A.N FROM T A CROSS JOIN T B CROSS JOIN T C ORDER BY A.N" });
  const failed = assert.rejects(cpu.result, state("57014"));
  await new Promise(resolve => setTimeout(resolve, 20));
  await observer.ping();
  const foreign = await observer.request({ type: "cancel", targetId: cpu.id });
  assert.equal(foreign.type, "cancelAck"); if (foreign.type === "cancelAck") assert.equal(foreign.status, "notRunning");
  const ack = await connection.request({ type: "cancel", targetId: cpu.id });
  assert.equal(ack.type, "cancelAck"); if (ack.type === "cancelAck") assert.equal(ack.status, "accepted");
  await failed;
  await connection.ping();
  assert.equal((await connection.request({ type: "cancel", targetId: cpu.id })).type, "cancelAck");
  assert.equal((await connection.execute("SELECT COUNT(*) FROM T")).kind, "rows");
  await connection.close();
});

test("준비 문장 해제는 이미 열린 결과 커서를 닫지 않는다", async t => {
  const db = Database.open(tempDir(t), { onWarning() {}, scramIterations: 1000 });
  const driver = Driver.open(makeEnvironment(db), new FakeEndpoint())!;
  t.after(() => { driver.handler.dispose(); db.close(); }); await driver.login("SYSTEM", "HelloWorldDB");
  await driver.execute("CREATE TABLE T (N INTEGER)"); await driver.execute("INSERT INTO T VALUES (1), (2), (3)");
  const p = await driver.request({ type:"prepare", sql:"SELECT * FROM T" });
  const first = await driver.request({ type:"executePrepared", statement:p.statement, fetchSize:1 });
  assert.deepEqual(first.rows, [[1]]); assert.equal(first.hasMore, true);
  await driver.request({ type:"closePrepared", statement:p.statement });
  const rest = await driver.request({ type:"fetch", cursor:first.cursor }); assert.deepEqual(rest.rows, [[2],[3]]);
  assert.equal(rest.hasMore, false);
});
