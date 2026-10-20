import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { ROOT } from './build.mjs';
export function child(exe, args, options = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = ''; let error = ''; const timer = setTimeout(() => { p.kill(); reject(new Error('시험 프로세스 시간 초과')); }, 120000);
    p.stdout.on('data', b => output += b.toString('utf8')); p.stderr.on('data', b => error += b.toString('utf8'));
    p.once('error', e => { clearTimeout(timer); reject(e); });
    p.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`실패(${code})\n${output}${error}`)); else resolve(output); });
  });
}
async function freePort() {
  for (let i = 0; i < 100; i++) {
    const port = 20000 + Math.floor(Math.random() * 24000); const tcp = net.createServer(); const udp = dgram.createSocket('udp4');
    try {
      await new Promise((resolve, reject) => { tcp.once('error', reject); tcp.listen(port, '127.0.0.1', resolve); });
      await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(port, '127.0.0.1', resolve); }); return port;
    } catch { /* 두 프로토콜 모두 사용 가능한 포트를 찾는다. */ }
    finally { if (tcp.listening) await new Promise(r => tcp.close(r)); try { udp.close(); } catch { } }
  }
  throw new Error('사용 가능한 시험 포트가 없다.');
}
const rdbms = path.resolve(ROOT, '../rdbms'); const hwdb = path.join(rdbms, 'dist/src/cli/main.js');
const runtime = process.env.HWDB_TEST_RUNTIME || process.execPath;
export const tls = name => path.join(rdbms, 'test/fixtures/tls', name);
export async function server(config, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwdb-jdbc8-')); const port = await freePort();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port, udp: { sessionTimeoutMs: 900 }, ...config }));
  const env = { ...process.env, HWDB_INSTALL_DIR: dir };
  const proc = spawn(runtime, [hwdb, 'start', '--foreground'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', b => log += b); proc.stderr.on('data', b => log += b);
  let exited = false; const exit = new Promise((resolve, reject) => { proc.once('error', reject); proc.once('exit', () => { exited = true; resolve(); }); });
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (exited) throw new Error('서버 구동 실패: ' + log);
      try { await child(runtime, [hwdb, 'status'], { env }); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    if (!ready) throw new Error('서버 구동 시간 초과: ' + log);
    await body(`jdbc:helloworlddb://127.0.0.1:${port}`, port);
  } finally {
    if (!exited) try { await child(runtime, [hwdb, 'stop', '--timeout', '10'], { env }); } catch { if (!exited) proc.kill(); }
    await Promise.race([exit, new Promise(r => setTimeout(r, 3000))]);
    if (!exited) { proc.kill(); await exit; }
    assert.equal(exited, true);
    const absolute = path.resolve(dir); assert.equal(path.dirname(absolute), path.resolve(os.tmpdir())); assert.ok(path.basename(absolute).startsWith('hwdb-jdbc8-'));
    fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
export async function lossy(serverPort, body) {
  const socket = dgram.createSocket('udp4'); await new Promise(r => socket.bind(0, '127.0.0.1', r));
  let count = 0; let dropped = 0; let duplicated = 0; let delayed = 0; const timers = new Set(); const upstream = new Map();
  function forward(bytes, send) {
    count++; if (count % 17 === 0) { dropped++; return; }
    if (count % 13 === 0) { delayed++; const t = setTimeout(() => { timers.delete(t); send(); }, 5); timers.add(t); } else send();
    if (count % 11 === 0) { duplicated++; send(); }
  }
  socket.on('message', (bytes, remote) => {
    const key = `${remote.address}:${remote.port}`;
    if (!upstream.has(key)) {
      // 서버는 세션 번호와 출발지 주소를 함께 검사하므로 접속마다 별도 송신 소켓을 둔다.
      const peer = dgram.createSocket('udp4'); upstream.set(key, peer);
      peer.on('message', response => forward(response, () => socket.send(response, remote.port, remote.address)));
    }
    const peer = upstream.get(key); forward(bytes, () => peer.send(bytes, serverPort, '127.0.0.1'));
  });
  try { await body(socket.address().port); assert.ok(dropped > 0 && duplicated > 0 && delayed > 0); console.log(`UDP 결함 주입: 유실 ${dropped}, 중복 ${duplicated}, 지연 ${delayed}`); }
  finally { for (const timer of timers) clearTimeout(timer); for (const peer of upstream.values()) peer.close(); await new Promise(r => socket.close(r)); }
}

