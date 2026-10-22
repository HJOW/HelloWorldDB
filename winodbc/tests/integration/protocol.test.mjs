// 네이티브 프로토콜 시험: 실제 서버와 결함 주입을 각각 구분한다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pbkdf2Sync, createHmac, createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Server, loadConfig } from '../helpers/server.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const executable = process.env.HWDB_PROTOCOL_PROBE ?? path.join(project, 'build/x64/bin/Debug/hwdb_protocol_probe.exe');
const logs = [];
const logger = Object.fromEntries(['error', 'warn', 'info', 'debug'].map(level => [level, message => logs.push(message)]));
logger.close = async () => {};
const probe = (port, scenario = 'basic') => new Promise((resolve, reject) => {
  const child = spawn(executable, [String(port), scenario], { windowsHide: true, timeout: 20000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => stdout += value);
  child.stderr.on('data', value => stderr += value);
  child.on('error', reject);
  child.on('close', status => resolve({ status, stdout, stderr }));
});
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function freeTcpUdpPort() {
  for (let attempt = 0; attempt < 20; ++attempt) {
    const tcp = net.createServer(), udp = dgram.createSocket('udp4');
    const port = await listen(tcp);
    let available = false;
    try {
      await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(port, '0.0.0.0', resolve); });
      available = true;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
    finally {
      try { await new Promise(resolve => udp.close(resolve)); } catch {}
      await new Promise(resolve => tcp.close(resolve));
    }
    if (available) return port;
  }
  throw new Error('빈 TCP/UDP 포트를 확보하지 못했다.');
}
function frame(message) {
  const body = Buffer.isBuffer(message) ? message : Buffer.from(typeof message === 'string' ? message : JSON.stringify(message));
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
async function fake(t, onMessage) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let data = Buffer.alloc(0);
    socket.on('data', part => {
      data = Buffer.concat([data, part]);
      while (data.length >= 4 && data.length >= 4 + data.readUInt32BE()) {
        const length = data.readUInt32BE();
        const message = JSON.parse(data.subarray(4, 4 + length));
        data = data.subarray(4 + length);
        onMessage(socket, message);
      }
    });
  });
  const port = await listen(server);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return port;
}
const hello = id => ({ id, type: 'helloOk', version: 1, mechanism: 'SCRAM-SHA-256', maxMessageBytes: 16777216, server: 'test', defaultFetchSize: 500 });

test('LOGIN_TIMEOUT은 hello·인증 단계에 누적 적용된다', async t => {
  const port = await fake(t, (socket, message) => {
    if (message.type === 'hello') setTimeout(() => socket.write(frame(hello(message.id))), 700);
    if (message.type === 'authStart') {
      const nonce = message.clientFirst.split(',r=')[1];
      setTimeout(() => socket.write(frame({ id: message.id, type: 'authChallenge', serverFirst: `r=${nonce}SERVER,s=c2FsdA==,i=4096` })), 700);
    }
  });
  const started = Date.now(), result = await probe(port, 'login-budget');
  assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /STATE=HYT01/);
  assert.ok(Date.now() - started < 4000, '단계별 timeout을 새로 시작하지 않아야 한다.');
});

for (const scenario of ['query-timeout', 'cancel-desync', 'timeout-completed', 'send-timeout']) {
  test(`취소 응답 분배·시간 제한 결함 주입: ${scenario}`, async t => {
    let first, serverFirst, executionId, executions = 0;
    const port = await fake(t, (socket, message) => {
      if (message.type === 'hello') return socket.write(frame({ ...hello(message.id), capabilities: ['cancel'] }));
      if (message.type === 'authStart') {
        first = message.clientFirst.slice(3);
        serverFirst = `r=${first.split(',r=')[1]}SERVER,s=c2FsdA==,i=4096`;
        return socket.write(frame({ id: message.id, type: 'authChallenge', serverFirst }));
      }
      if (message.type === 'authFinish') {
        const auth = `${first},${serverFirst},${message.clientFinal.split(',p=')[0]}`;
        const salted = pbkdf2Sync('HelloWorldDB', 'salt', 4096, 32, 'sha256');
        const hmac = (key, text) => createHmac('sha256', key).update(text).digest();
        const signature = hmac(hmac(salted, 'Server Key'), auth).toString('base64');
        socket.write(frame({ id: message.id, type: 'authOk', serverFinal: `v=${signature}`,
          session: { id: 1, user: 'SYSTEM', tablespace: 'SYSTEM', timeZone: '+00:00', autocommit: true } }));
        if (scenario === 'send-timeout') socket.pause();
        return;
      }
      const rows = (id, value) => ({ id, type: 'rows', columns: [{ name: 'N', typeName: 'INTEGER', declared: 'INTEGER' }], rows: [[value]], hasMore: false });
      if (message.type === 'execute') {
        ++executions;
        if (executions === 1) executionId = message.id;
        else socket.write(frame(rows(message.id, 2)));
      }
      if (message.type === 'cancel') {
        assert.equal(message.targetId, executionId);
        socket.write(frame({ id: message.id, type: 'cancelAck', targetId: executionId, status: scenario === 'timeout-completed' ? 'tooLate' : 'accepted' }));
        if (scenario === 'query-timeout') socket.write(frame({ id: executionId, type: 'error', sqlState: '57014', code: 8010, message: 'Statement was cancelled.' }));
        if (scenario === 'timeout-completed') setTimeout(() => socket.write(frame(rows(executionId, 1))), 100);
      }
      if (message.type === 'close') socket.end(frame({ id: message.id, type: 'bye' }));
    });
    const result = await probe(port, scenario);
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, new RegExp(`PASS ${scenario}`));
    assert.equal(executions, scenario === 'send-timeout' ? 0 : scenario === 'cancel-desync' ? 1 : 2, '원래 DML/질의를 자동 재실행하지 않는다.');
  });
}

test('실제 서버: SCRAM·fetch·오류 후 재사용·기본 tablespace NULL', async t => {
  const port = await freeTcpUdpPort();
  const parent = path.join(project, 'build/integration'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'protocol-'));
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ port, udp: { enabled: false }, tcp: { host: '0.0.0.0' } }));
  const server = new Server(loadConfig(directory).config, logger);
  t.after(async () => {
    await server.stop();
    const resolved = fs.realpathSync(directory);
    assert.ok(resolved.startsWith(fs.realpathSync(parent) + path.sep));
    fs.rmSync(resolved, { recursive: true });
  });
  await server.start();
  assert.deepEqual(await probe(port), { status: 0, stdout: 'PASS basic\r\n', stderr: '' });
  assert.equal((await probe(port, 'wrong')).status, 0);
  assert.equal((await probe(port, 'nullspace')).status, 0);
  if (process.env.HWDB_DM_CONNECTION) {
    const result = await new Promise((resolve, reject) => {
      const driver = process.env.HWDB_ODBC_DLL ?? path.join(path.dirname(executable), 'hwdbodbc.dll');
      const remote = Object.values(os.networkInterfaces()).flat().find(address => address && !address.internal && address.family === 'IPv4');
      assert.ok(remote, '원격 CONNECT 시험에 사용할 비루프백 IPv4 주소가 필요하다.');
      const child = spawn(process.env.HWDB_DM_CONNECTION, [driver, String(port)], {
        windowsHide: true, timeout: 60000, env: { ...process.env, HWDB_TEST_REMOTE_HOST: remote.address },
      });
      let output = '';
      child.stdout.on('data', value => output += value);
      child.stderr.on('data', value => output += value);
      child.on('error', reject); child.on('close', status => resolve({ status, output }));
    });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /MANAGER DLL:/);
    console.log(result.output.trim());
  }
  if (process.env.HWDB_RESET_PROBE) {
    const result = await new Promise((resolve, reject) => {
      const driver = process.env.HWDB_ODBC_DLL ?? path.join(path.dirname(executable), 'hwdbodbc.dll');
      const child = spawn(process.env.HWDB_RESET_PROBE, [driver, String(port)], { windowsHide: true, timeout: 20000 });
      let output = '';
      child.stdout.on('data', value => output += value); child.stderr.on('data', value => output += value);
      child.on('error', reject); child.on('close', status => resolve({ status, output }));
    });
    assert.equal(result.status, 0, result.output); console.log(result.output.trim());
  }
  assert.ok(logs.every(message => ['wrong-test-password','no-default-test','null-reset-test','changed-reset-test'].every(secret => !message.includes(secret))));
});

for (const [name, response, state] of [
  ['응답 id 불일치', id => frame(hello(id + 1)), '08S01'],
  ['모르는 응답 종류', id => frame({ id, type: 'unknown' }), '08S01'],
  ['중복 JSON 키', id => frame(`{"id":${id},"type":"helloOk","id":${id}}`), '08S01'],
  ['잘못된 UTF-8', () => frame(Buffer.from([0xff])), '22021'],
  ['인증 전 64KiB 초과', () => { const header = Buffer.alloc(4); header.writeUInt32BE(65537); return header; }, '08S01'],
  ['길이 0', () => Buffer.alloc(4), '08S01'],
  ['잘못된 JSON', () => frame('{'), '08S01'],
  ['잘못된 필드 타입', id => frame({ ...hello(id), defaultFetchSize: '500' }), '08S01'],
  ['서버 종료 id 0', () => frame({ id: 0, type: 'error', sqlState: '57P01', code: 6003, message: 'Server is shutting down.' }), '57P01'],
  ['잘못된 오류 SQLSTATE', () => frame({ id: 0, type: 'error', sqlState: 'invalid', code: 6003, message: 'Invalid.' }), '08S01'],
  ['너무 깊은 JSON', id => frame(`{"id":${id},"x":${'['.repeat(70)}0${']'.repeat(70)}}`), '08S01'],
]) {
  test(`결함 주입: ${name}`, async t => {
    const port = await fake(t, (socket, message) => socket.write(response(message.id)));
    const result = await probe(port, 'hello');
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, new RegExp(`STATE=${state}`));
  });
}
test('TCP 조각난 헤더·본문', async t => {
  const port = await fake(t, (socket, message) => {
    const data = frame(hello(message.id));
    socket.write(data.subarray(0, 2));
    setTimeout(() => { socket.write(data.subarray(2, 7)); setTimeout(() => socket.write(data.subarray(7)), 5); }, 5);
  });
  assert.equal((await probe(port, 'hello')).status, 0);
});
test('중간 연결 종료', async t => {
  const port = await fake(t, socket => { socket.write(Buffer.from([0, 0, 0, 20, 123])); socket.end(); });
  const result = await probe(port, 'hello');
  assert.equal(result.status, 2); assert.match(result.stderr, /STATE=08S01/);
});

for (const scenario of ['nfkc', 'forged', 'nonce', 'iterations', 'version']) {
  test(`SCRAM 주입: ${scenario}`, async t => {
    let first, serverFirst, expectedFinal;
    const password = scenario === 'nfkc' ? 'Ａ①가\u0301😀' : 'HelloWorldDB';
    const port = await fake(t, (socket, message) => {
      if (message.type === 'hello') return socket.write(frame({ ...hello(message.id), version: scenario === 'version' ? 99 : 1 }));
      if (message.type === 'authStart') {
        first = message.clientFirst.slice(3);
        const clientNonce = first.split(',r=')[1];
        serverFirst = `r=${scenario === 'nonce' ? 'wrong' : clientNonce}SERVER,s=${Buffer.from('salt-test').toString('base64')},i=${scenario === 'iterations' ? 10000001 : 4096}`;
        return socket.write(frame({ id: message.id, type: 'authChallenge', serverFirst }));
      }
      if (message.type === 'authFinish') {
        const withoutProof = message.clientFinal.split(',p=')[0];
        const auth = `${first},${serverFirst},${withoutProof}`;
        const salted = pbkdf2Sync(password.normalize('NFKC'), 'salt-test', 4096, 32, 'sha256');
        const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
        const clientKey = hmac(salted, 'Client Key');
        const stored = createHash('sha256').update(clientKey).digest();
        const clientSignature = hmac(stored, auth);
        const proof = Buffer.from(clientKey.map((byte, i) => byte ^ clientSignature[i])).toString('base64');
        assert.equal(message.clientFinal.split(',p=')[1], proof);
        expectedFinal = hmac(hmac(salted, 'Server Key'), auth).toString('base64');
        return socket.write(frame({ id: message.id, type: 'authOk', serverFinal: `v=${scenario === 'forged' ? 'bad' : expectedFinal}`,
          session: { id: 1, user: 'SYSTEM', tablespace: 'SYSTEM', timeZone: '+09:00', autocommit: true } }));
      }
      if (message.type === 'execute') return socket.write(frame({ id: message.id, type: 'rows', columns: [{ name: 'N', typeName: 'INTEGER', declared: 'INTEGER' }], rows: [[1]], hasMore: false }));
      if (message.type === 'close') return socket.end(frame({ id: message.id, type: 'bye' }));
    });
    const result = await probe(port, scenario === 'nfkc' ? 'nfkc' : 'auth');
    assert.equal(result.status, scenario === 'nfkc' ? 0 : 2, result.stderr);
    if (scenario !== 'nfkc') assert.match(result.stderr, /STATE=08006/);
  });
}
