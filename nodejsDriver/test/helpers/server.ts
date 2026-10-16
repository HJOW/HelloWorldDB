/**
 * 통합 시험용 서버 도우미. 실제 `rdbms` 를 `hwdb start` 로 띄우고 끝낸다.
 * 시험을 등록하지 않으므로 여러 시험 파일에서 import 해도 중복 실행되지 않는다.
 *
 *  - 설치 디렉토리(임시), config.json, 비어 있는 포트 번호, 데이터·로그 디렉토리를 서버마다 새로 만든다.
 *  - 서버를 돌리는 런타임은 환경 변수 `HWDB_TEST_RUNTIME` 으로 고른다. (기본은 이 시험을 돌리는 실행 파일. bun 으로 서버를 시험할 때 쓴다)
 *  - 정리는 데몬을 끝낸 **뒤에** 디렉토리를 지운다. 데몬은 데이터 디렉토리의 잠금 파일로 찾고, 그 포트의 로컬 전용 채널이 열려 있을 때만 강제로 끝낸다.
 *    (끝난 데몬의 PID 를 운영체제가 다른 프로세스에 다시 줄 수 있어, PID 만 믿고 신호를 보내지 않는다)
 *
 * rdbms 는 이 저장소의 형제 디렉토리(`../rdbms`)이며 빌드되어 있어야 한다. (`npm test` 가 먼저 확인한다: scripts/ensure-rdbms.mjs)
 *
 * 구현 단계 : 12-5
 */

import { spawn, spawnSync } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RDBMS_DIR = fileURLToPath(new URL("../../../../rdbms/", import.meta.url));

/** 빌드된 `hwdb` 의 진입점이다. */
export const HWDB = path.join(RDBMS_DIR, "dist", "src", "cli", "main.js");

/** rdbms 의 시험용 TLS 인증서 파일의 경로이다. (자체 서명. 시험 전용) */
export function tlsFixture(name: string): string {
  return path.join(RDBMS_DIR, "test", "fixtures", "tls", name);
}

/** 서버를 돌릴 런타임이다. `HWDB_TEST_RUNTIME` 이 있으면 그것(예 : bun 의 경로), 없으면 이 시험을 돌리는 실행 파일이다. */
export function serverRuntime(): string {
  const override = process.env["HWDB_TEST_RUNTIME"];
  return override !== undefined && override.length > 0 ? override : process.execPath;
}

/** 서버가 bun 으로 돌고 있는지이다. bun 에서는 TLS 서버의 최소 버전을 적용하지 못하는 등 달라지는 시험을 가려내는 데 쓴다. */
export function serverIsBun(): boolean {
  return /(^|[\\/])bun(\.exe)?$/i.test(serverRuntime());
}

/** 이 시험을 돌리는 런타임이 bun 인지이다. */
export function runnerIsBun(): boolean {
  return "Bun" in globalThis;
}

/** 이 장비의 루프백이 아닌 IPv4 주소이다. 없으면 null 이다. 서버는 0.0.0.0 에 바인드하므로 이 주소로 들어오면 "원격" 접속이다. */
export function lanAddress(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (!entry.internal && entry.family === "IPv4") return entry.address;
    }
  }
  return null;
}

/** 조건이 참이 될 때까지 기다린다. */
export async function waitFor(condition: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** TCP 와 UDP 포트가 모두 비어 있는지 본다. (같은 번호를 TCP 와 UDP 가 함께 쓴다) 데몬의 바인드 주소(0.0.0.0)와 루프백 양쪽에서 본다. */
async function bothFree(port: number): Promise<boolean> {
  for (const host of ["0.0.0.0", "127.0.0.1"]) {
    const tcp = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, host, () => server.close(() => resolve(true)));
    });
    if (!tcp) return false;
    const udp = await new Promise<boolean>((resolve) => {
      const socket = dgram.createSocket("udp4");
      socket.once("error", () => {
        socket.close();
        resolve(false);
      });
      socket.bind(port, host, () => socket.close(() => resolve(true)));
    });
    if (!udp) return false;
  }
  return true;
}

/**
 * 지금 비어 있는 포트 하나를 고른다. Windows 는 TCP 와 UDP 에 서로 다른 "제외된 포트 범위"를 가지므로,
 * 동적 포트 범위 아래(20,000 ~ 45,000)에서 무작위로 골라 둘 다 비어 있는지 확인한다.
 */
export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 25_000);
    if (await bothFree(port)) return port;
  }
  throw new Error("Could not find a free port.");
}

/** 로컬 전용 채널의 주소이다. (AGENTS.md 상세 15) 열려 있으면 그 포트의 데몬이 살아 있다. */
function localChannelAddress(port: number): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\helloworlddb-${port}` : `/tmp/helloworlddb-${port}.sock`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface HwdbResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** 정리가 되지 않은 서버이다. 시험 러너가 정리 훅을 돌리지 못하고 끝나도 프로세스가 끝날 때 정리한다. */
const undisposed = new Set<TestServer>();
process.once("exit", () => {
  for (const server of [...undisposed]) {
    try {
      server.dispose();
    } catch {
      // 종료 중이므로 정리 실패는 무시한다.
    }
  }
});

export class TestServer {
  readonly installDir: string;
  readonly port: number;
  readonly dataDir: string;
  readonly logPath: string;
  private readonly runtime = serverRuntime();
  private disposed = false;

  private constructor(installDir: string, port: number) {
    this.installDir = installDir;
    this.port = port;
    this.dataDir = path.join(installDir, "data");
    this.logPath = path.join(installDir, "logs", "helloworlddb.log");
  }

  /**
   * 서버를 띄운다. `config` 의 키는 config.json 에 그대로 들어간다. (`port` 는 비어 있는 포트로 정해진다)
   * 시험이 끝나면 서버를 끝내고 디렉토리를 지운다. `t` 는 `after` 를 가진 시험 문맥이거나 `node:test` 의 `after` 를 감싼 객체이다.
   */
  static async start(t: { after(fn: () => void): void }, config: Record<string, unknown> = {}): Promise<TestServer> {
    if (!fs.existsSync(HWDB)) throw new Error(`The rdbms build was not found: ${HWDB}. Run "npm run build" in ../rdbms (or "npm test" here).`);
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "hwdb-nd-"));
    const port = await freePort();
    fs.writeFileSync(path.join(installDir, "config.json"), JSON.stringify({ ...config, port }), "utf8");
    const server = new TestServer(installDir, port);
    undisposed.add(server);
    t.after(() => server.dispose());
    server.start();
    return server;
  }

  /** `hwdb` 를 동기로 실행한다. */
  hwdb(args: string[]): HwdbResult {
    const result = spawnSync(this.runtime, [HWDB, ...args], {
      encoding: "utf8",
      env: { ...process.env, HWDB_INSTALL_DIR: this.installDir },
      timeout: 120_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  /**
   * `hwdb` 를 비동기로 실행한다. **이 시험 프로세스에 서버에 접속한 `Connection` 이 열려 있으면 이쪽을 쓴다.**
   * `hwdb` 를 동기로(`spawnSync`) 부르면 이 프로세스의 이벤트 루프가 막혀 접속이 서버의 메시지를 읽지도 확인(ACK)하지도 못하므로,
   * 서버가 그 접속을 기다리느라 종료가 유예 시간만큼 늦어진다.
   */
  hwdbAsync(args: string[]): Promise<HwdbResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.runtime, [HWDB, ...args], {
        env: { ...process.env, HWDB_INSTALL_DIR: this.installDir },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    });
  }

  /** 서버(데몬)를 띄운다. 실패하면 시험을 실패시킨다. */
  start(): void {
    const result = this.hwdb(["start", "--timeout", "60"]);
    if (result.status !== 0) throw new Error(`hwdb start failed (${result.status}): ${result.stderr}${result.stdout}`);
  }

  /** 서버를 정상 종료한다. 이 프로세스에 열려 있는 접속이 있으면 `stopAsync` 를 쓴다. */
  stop(): void {
    const result = this.hwdb(["stop", "--timeout", "60"]);
    if (result.status !== 0) throw new Error(`hwdb stop failed (${result.status}): ${result.stderr}${result.stdout}`);
  }

  /** 서버를 정상 종료한다. (이벤트 루프를 막지 않는다) */
  async stopAsync(): Promise<void> {
    const result = await this.hwdbAsync(["stop", "--timeout", "60"]);
    if (result.status !== 0) throw new Error(`hwdb stop failed (${result.status}): ${result.stderr}${result.stdout}`);
  }

  /** 서버를 띄운다. (이벤트 루프를 막지 않는다) */
  async startAsync(): Promise<void> {
    const result = await this.hwdbAsync(["start", "--timeout", "60"]);
    if (result.status !== 0) throw new Error(`hwdb start failed (${result.status}): ${result.stderr}${result.stdout}`);
  }

  /** 서버를 정상 종료 절차 없이 강제로 끝낸다. (비정상 종료 시험) */
  kill(): void {
    const pid = this.livePid();
    if (pid === null) throw new Error("The server is not running.");
    process.kill(pid, "SIGKILL");
  }

  /** 지금 도는 데몬의 PID 이다. 잠금 파일의 PID 가 살아 있고 그 포트의 로컬 전용 채널이 열려 있을 때만 돈다고 본다. 아니면 null 이다. */
  livePid(): number | null {
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(this.dataDir, "helloworlddb.lock"), "utf8")) as { pid?: unknown; port?: unknown };
      if (typeof lock.pid !== "number" || typeof lock.port !== "number") return null;
      return lock.pid !== process.pid && isProcessAlive(lock.pid) && fs.existsSync(localChannelAddress(lock.port)) ? lock.pid : null;
    } catch {
      return null;
    }
  }

  /** 서버 로그의 전체 내용이다. 없으면 빈 문자열이다. */
  log(): string {
    try {
      return fs.readFileSync(this.logPath, "utf8");
    } catch {
      return "";
    }
  }

  /** 시험이 끝났을 때의 정리이다. 서버가 남았으면 정상 종료를 시도하고, 그래도 남으면 강제로 끝낸 뒤 디렉토리를 지운다. 두 번 불러도 한 번만 한다. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    undisposed.delete(this);
    if (this.livePid() !== null) {
      this.hwdb(["stop", "--timeout", "20"]);
      const pid = this.livePid();
      if (pid !== null) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // 그 사이에 끝났다.
        }
      }
    }
    try {
      fs.rmSync(this.installDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      // 지우지 못한 임시 디렉토리는 남는다. 서버 프로세스를 남기는 것보다 낫다.
    }
  }
}
