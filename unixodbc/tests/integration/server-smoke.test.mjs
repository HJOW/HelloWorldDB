/**
 * 환경 점검용 스모크 시험이다. (T-SMOKE)
 *
 * 드라이버 구현 전이지만, 시험 도우미가 실제 `rdbms` 데몬을 띄우고
 * TCP 프레임으로 프로토콜 버전을 협상할 수 있는지 확인한다.
 * UO-3 부터 이 경로에 인증·실행 시험이 붙는다.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';

import { TestServer } from '../helpers/server.mjs';

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** 소켓에서 프레임 메시지를 순서대로 읽는 함수를 만든다. (프레임이 나뉘거나 합쳐져 와도 된다) */
function createReader(socket) {
  let buffer = Buffer.alloc(0);
  const messages = [];
  const waiters = [];
  let failure = null;

  const deliver = () => {
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length).toString('utf8');
      buffer = buffer.subarray(4 + length);
      let message;
      try {
        message = JSON.parse(body);
      } catch (error) {
        failure = error;
        for (const waiter of waiters.splice(0)) waiter.reject(error);
        return;
      }
      const waiter = waiters.shift();
      if (waiter === undefined) messages.push(message);
      else waiter.resolve(message);
    }
  };

  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    deliver();
  });
  socket.on('close', () => {
    if (failure === null) failure = new Error('메시지를 받기 전에 연결이 끝났다.');
    for (const waiter of waiters.splice(0)) waiter.reject(failure);
  });
  socket.on('error', error => {
    failure = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });

  return () => {
    if (messages.length > 0) return Promise.resolve(messages.shift());
    if (failure !== null) return Promise.reject(failure);
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };
}

test('실제 rdbms 데몬과 TCP 프레임으로 hello/close 를 교환한다', async t => {
  const server = await TestServer.start(t, {
    tcp: { enabled: true, host: '127.0.0.1' },
    udp: { enabled: false },
  });

  const socket = net.createConnection({ host: '127.0.0.1', port: server.port });
  const readMessage = createReader(socket);
  try {
    await once(socket, 'connect');
    socket.write(frame({ id: 1, type: 'hello', versions: [1], client: 'unixodbc-smoke' }));
    const hello = await readMessage();
    assert.equal(hello.type, 'helloOk');
    assert.equal(hello.id, 1);
    assert.equal(hello.version, 1);
    assert.equal(hello.mechanism, 'SCRAM-SHA-256');
    assert.ok(Array.isArray(hello.capabilities), 'capabilities 는 배열이어야 한다.');
    assert.ok(hello.capabilities.includes('prepareDescribe'));
    assert.ok(hello.maxMessageBytes > 0);

    socket.write(frame({ id: 2, type: 'close' }));
    const bye = await readMessage();
    assert.equal(bye.type, 'bye');
    assert.equal(bye.id, 2);
  } finally {
    socket.destroy();
  }
});
