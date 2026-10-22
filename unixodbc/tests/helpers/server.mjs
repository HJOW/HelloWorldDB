/**
 * 통합 시험용 서버 도우미이다. 실제 `rdbms` 를 `hwdb start` 로 띄우고 끝낸다.
 *
 * unixODBC 시험은 최종적으로 C++ 드라이버 → unixODBC Manager → 실제 서버를 확인한다.
 * 이 도우미는 그 서버를 격리된 임시 디렉토리·빈 포트로 띄우는 공통 기반이다. (UO-1·UO-3 부터 사용)
 *
 *  - 임시 설치 디렉토리, config.json, 데이터·로그 디렉토리를 서버마다 새로 만든다.
 *  - 데몬을 끝낸 뒤에 디렉토리를 지운다. PID 만 믿지 않고 그 포트의 로컬 전용 채널도 확인한다.
 *  - `../rdbms` 가 빌드되어 있어야 한다. (`rdbms` 에서 `npm run build`)
 */
import { spawn, spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RDBMS_DIR = fileURLToPath(new URL('../../../rdbms/', import.meta.url));

/** 빌드된 `hwdb` 진입점이다. */
export const HWDB = path.join(RDBMS_DIR, 'dist', 'src', 'cli', 'main.js');

/** 서버를 돌릴 런타임이다. `HWDB_TEST_RUNTIME` 이 있으면 그것, 없으면 이 시험 실행 파일이다. */
export function serverRuntime() {
  const override = process.env.HWDB_TEST_RUNTIME;
  return override !== undefined && override.length > 0 ? override : process.execPath;
}

function localChannelAddress(port) {
  return process.platform === 'win32' ? `\\\\.\\pipe\\helloworlddb-${port}` : `/tmp/helloworlddb-${port}.sock`;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function bothFree(port) {
  for (const host of ['0.0.0.0', '127.0.0.1']) {
    const tcp = await new Promise(resolve => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, host, () => server.close(() => resolve(true)));
    });
    if (!tcp) return false;
    const udp = await new Promise(resolve => {
      const socket = dgram.createSocket('udp4');
      socket.once('error', () => {
        socket.close();
        resolve(false);
      });
      socket.bind(port, host, () => socket.close(() => resolve(true)));
    });
    if (!udp) return false;
  }
  return true;
}

/** TCP 와 UDP 가 함께 쓸 수 있는 빈 포트를 고른다. */
export async function freePort() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 25_000);
    if (await bothFree(port)) return port;
  }
  throw new Error('빈 포트를 찾지 못했다.');
}

const undisposed = new Set();
process.once('exit', () => {
  for (const server of [...undisposed]) {
    try {
      server.dispose();
    } catch {
      // 종료 중이므로 정리 실패는 무시한다.
    }
  }
});

export class TestServer {
  static async start(t, config = {}) {
    if (!fs.existsSync(HWDB)) {
      throw new Error(`rdbms 빌드를 찾지 못했다: ${HWDB}. ../rdbms 에서 npm run build 를 실행하십시오.`);
    }
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwdb-uo-'));
    const port = await freePort();
    fs.writeFileSync(path.join(installDir, 'config.json'), JSON.stringify({ ...config, port }, null, 2), 'utf8');
    const server = new TestServer(installDir, port);
    undisposed.add(server);
    t.after(() => server.dispose());
    const result = server.hwdb(['start', '--timeout', '60']);
    if (result.status !== 0) {
      throw new Error(`hwdb start 실패(${result.status}): ${result.stderr}${result.stdout}`);
    }
    return server;
  }

  constructor(installDir, port) {
    this.installDir = installDir;
    this.port = port;
    this.dataDir = path.join(installDir, 'data');
    this.logPath = path.join(installDir, 'logs', 'helloworlddb.log');
    this.disposed = false;
  }

  hwdb(args) {
    const result = spawnSync(serverRuntime(), [HWDB, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HWDB_INSTALL_DIR: this.installDir },
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  hwdbAsync(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(serverRuntime(), [HWDB, ...args], {
        env: { ...process.env, HWDB_INSTALL_DIR: this.installDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', chunk => (stderr += chunk.toString('utf8')));
      child.once('error', reject);
      child.once('close', status => resolve({ status, stdout, stderr }));
    });
  }

  async stopAsync() {
    const result = await this.hwdbAsync(['stop', '--timeout', '60']);
    if (result.status !== 0) {
      throw new Error(`hwdb stop 실패(${result.status}): ${result.stderr}${result.stdout}`);
    }
  }

  livePid() {
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'helloworlddb.lock'), 'utf8'));
      if (typeof lock.pid !== 'number' || typeof lock.port !== 'number') return null;
      return lock.pid !== process.pid && isProcessAlive(lock.pid) && fs.existsSync(localChannelAddress(lock.port))
        ? lock.pid
        : null;
    } catch {
      return null;
    }
  }

  log() {
    try {
      return fs.readFileSync(this.logPath, 'utf8');
    } catch {
      return '';
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    undisposed.delete(this);
    this.hwdb(['stop', '--timeout', '20']);
    const pid = this.livePid();
    if (pid !== null) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 이미 끝났다.
      }
    }
    fs.rmSync(this.installDir, { recursive: true, force: true });
  }
}
