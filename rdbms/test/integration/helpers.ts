/**
 * 통합 시험의 공용 도우미 (11단계). 시험을 등록하지 않으므로 여러 시험 파일에서 import 해도 중복 실행되지 않는다.
 *
 *  - `Daemon` : 실제 `hwdb` 프로세스로 데몬을 띄우고(`hwdb start`) 끝내고(`hwdb stop`) 강제로 끊는(`kill`) 설치 하나.
 *    설치 디렉토리, config.json, 포트 번호, 데이터·로그 디렉토리를 시험마다 새로 만들고, 시험이 끝나면 데몬과 접속을 정리한다.
 *  - 데몬을 돌리는 런타임은 환경 변수 `HWDB_TEST_RUNTIME` 으로 고른다. (기본은 이 시험을 돌리는 실행 파일. bun 으로 데몬을 시험할 때 쓴다)
 *  - `Daemon.connect` : 로컬 전용 채널, TCP, TLS, UDP 중 하나로 접속해 로그인한 `Connection` 을 돌려준다.
 *  - 질의 도우미 : `query`(행), `exec`(결과), `failure`(오류를 기대)
 *
 * 관련 사양 : AGENTS.md 상세 8, 9, 14, 15
 * 구현 단계 : 11단계
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection } from "../../src/client/connection.js";
import type { ExecuteOutcome, SslOptions } from "../../src/client/connection.js";
import { DbError } from "../../src/common/errors.js";
import { DEFAULT_PORT, getLocalChannelAddress } from "../../src/common/instance.js";
import { isProcessAlive, readLockFile } from "../../src/daemon/lockFile.js";
import type { JsonValue } from "../../src/net/protocol.js";
import { waitFor, writeFreePortConfig } from "../net/helpers.js";

/** 빌드된 `hwdb` 의 진입점이다. (dist/src/cli/main.js) */
export const HWDB = fileURLToPath(new URL("../../src/cli/main.js", import.meta.url));

/** 시험용 TLS 인증서 파일의 경로이다. (test/fixtures/tls, README 참고) */
export function tlsFixture(name: string): string {
  return fileURLToPath(new URL(`../../../test/fixtures/tls/${name}`, import.meta.url));
}

/** 데몬을 돌릴 런타임이다. `HWDB_TEST_RUNTIME` 이 있으면 그것(예 : bun 의 경로), 없으면 이 시험을 돌리는 실행 파일이다. */
export function daemonRuntime(): string {
  const override = process.env["HWDB_TEST_RUNTIME"];
  return override !== undefined && override.length > 0 ? override : process.execPath;
}

/** 데몬이 bun 으로 돌고 있는지이다. bun 에서는 TLS 서버의 최소 버전을 적용하지 못하는 등 달라지는 시험을 가려내는 데 쓴다. */
export function daemonIsBun(): boolean {
  return /(^|[\\/])bun(\.exe)?$/i.test(daemonRuntime());
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

export type ConnectKind = "local" | "tcp" | "tls" | "udp";

export interface ConnectOptions {
  user?: string;
  password?: string;
  tablespace?: string;
  /** TCP, TLS, UDP 에서 접속할 주소이다. 기본은 127.0.0.1 (로컬 접속으로 판정된다). */
  host?: string;
  /** 로그인하지 않고 핸드셰이크까지만 한다. */
  login?: boolean;
  /** TLS 일 때의 옵션이다. 기본은 시험용 인증서(server-a)를 신뢰한다. */
  ssl?: SslOptions;
}

export interface HwdbResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * 정리(`dispose`)가 아직 되지 않은 `Daemon` 들이다. 시험 러너가 정리 훅(`t.after`)을 돌리지 못하고 끝나더라도(시간 초과, 중단)
 * 프로세스가 끝날 때 마지막으로 정리한다.
 * PID 만 따로 모아 두었다가 종료할 때 죽이는 방식은 쓰지 않는다. 이미 끝난 데몬의 PID 를 운영체제가 다른 프로세스(병렬로 도는 다른 시험 파일의
 * 데몬)에 다시 줄 수 있어서, 오래된 PID 에 신호를 보내면 남의 데몬을 죽인다. (Windows 는 PID 를 빨리 재사용한다)
 */
const undisposedDaemons = new Set<Daemon>();
process.once("exit", () => {
  for (const daemon of [...undisposedDaemons]) {
    try {
      daemon.dispose();
    } catch {
      // 종료 중이므로 정리 실패는 무시한다.
    }
  }
});

/**
 * 이 잠금 파일의 데몬이 지금도 도는지 본다. PID 가 살아 있는 것에 더해, 그 포트 번호의 로컬 전용 채널(네임드 파이프, 유닉스 소켓)이 열려 있어야 한다.
 * 강제 종료로 남은 잠금 파일의 PID 를 다른 프로세스가 재사용한 경우를 데몬으로 오인하지 않기 위함이다.
 */
function isDaemonAlive(lock: { pid: number; port: number }): boolean {
  return lock.pid !== process.pid && isProcessAlive(lock.pid) && fs.existsSync(getLocalChannelAddress(lock.port));
}

/** 프로세스를 강제로 끝낸다. 이미 없으면 아무 일도 하지 않는다. */
function forceKill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 그 사이에 끝났다.
  }
}

export class Daemon {
  readonly installDir: string;
  /** 접속할 포트 번호이다. config.json 을 바꾸는 `writeConfig`, `updateConfig`, `setPort` 가 함께 갱신한다. */
  port: number;
  /** 데이터 디렉토리이다. config.json 의 `dataDir` 를 설치 디렉토리 기준으로 푼 경로이다. */
  dataDir: string;
  /** 로그 파일이다. config.json 의 `log.dir` 를 설치 디렉토리 기준으로 푼 경로 아래에 있다. */
  logPath: string;
  private readonly connections = new Set<Connection>();
  private readonly runtime = daemonRuntime();
  /**
   * 지금까지 이 설치가 데이터 디렉토리로 쓴 모든 경로이다. config.json 의 `dataDir` 를 바꾸면 `dataDir` 는 새 경로를 가리키지만,
   * 옛 경로에서 구동한 데몬이 남아 있을 수 있으므로 정리할 때는 전부 찾아 본다.
   */
  private readonly usedDataDirs = new Set<string>();
  /**
   * 이 설치로 구동하거나 구동 중임을 확인한 데몬이다. (PID → 포트 번호) 잠금 파일이 지워져도 정리할 수 있게 따로 기억한다.
   * 데몬이 끝난 것을 확인할 때마다 비운다(`livePids`). 오래 들고 있으면 PID 재사용으로 남의 프로세스를 죽일 수 있다.
   */
  private readonly knownDaemons = new Map<number, number>();
  /** `makeExtraDir` 로 만든 디렉토리이다. 데몬을 모두 끝낸 뒤에 지운다. */
  private readonly extraDirs: string[] = [];
  private disposed = false;

  private constructor(installDir: string, port: number) {
    this.installDir = installDir;
    this.port = port;
    this.dataDir = path.join(installDir, "data");
    this.logPath = path.join(installDir, "logs", "helloworlddb.log");
    this.usedDataDirs.add(this.dataDir);
  }

  /** config.json 의 내용에서 접속할 포트와 데이터·로그 경로를 다시 구한다. (경로는 설치 디렉토리 기준이다) */
  private followConfig(config: Record<string, unknown>): void {
    if (typeof config["port"] === "number") this.port = config["port"];
    const dataDir = typeof config["dataDir"] === "string" ? config["dataDir"] : "./data";
    const log = config["log"];
    const logDir = typeof log === "object" && log !== null && typeof (log as Record<string, unknown>)["dir"] === "string"
      ? ((log as Record<string, unknown>)["dir"] as string) : "./logs";
    this.dataDir = path.resolve(this.installDir, dataDir);
    this.logPath = path.join(path.resolve(this.installDir, logDir), "helloworlddb.log");
    this.usedDataDirs.add(this.dataDir);
  }

  /**
   * 이 설치가 쓸 설치 디렉토리 밖의 임시 디렉토리를 만든다. (예 : 절대 경로의 `dataDir` 시험) 시험이 끝나면 데몬을 모두 끝낸 **뒤에** 지운다.
   * 이런 디렉토리를 시험이 따로 `t.after` 로 지우면 정리 훅의 실행 순서에 따라 데몬의 잠금 파일이 먼저 사라져 데몬이 남을 수 있다.
   */
  makeExtraDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(path.dirname(this.installDir), prefix));
    this.extraDirs.push(dir);
    return dir;
  }

  /**
   * 지금 도는 데몬의 PID 를 모은다. 지금까지 쓴 모든 데이터 디렉토리의 잠금 파일과, 구동 때 기억해 둔 데몬을 본다.
   * 끝난 데몬은 기억에서 지운다.
   */
  private livePids(): number[] {
    for (const dir of this.usedDataDirs) {
      try {
        const lock = readLockFile(dir);
        if (lock !== null) this.knownDaemons.set(lock.pid, lock.port);
      } catch {
        // 읽을 수 없는 잠금 파일은 무시한다.
      }
    }
    const pids: number[] = [];
    for (const [pid, port] of [...this.knownDaemons]) {
      if (isDaemonAlive({ pid, port })) pids.push(pid);
      else this.knownDaemons.delete(pid);
    }
    return pids;
  }

  /** `hwdb start` 를 부른 뒤 구동된 데몬을 기억한다. (정리 때 쓴다) 다른 `hwdb` 호출 뒤에는 끝난 데몬을 기억에서 지운다. */
  private noteDaemons(): void {
    this.livePids();
  }

  /**
   * 설치 디렉토리를 만들고 config.json 을 쓴다. `config` 의 키는 config.json 에 그대로 들어간다.
   * 시험이 끝나면 접속을 끊고 데몬을 끝내고(남았으면 강제로) 디렉토리를 지운다.
   */
  static async create(t: { after(fn: () => void): void }, config: Record<string, unknown> = {}): Promise<Daemon> {
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "hwdb-it-"));
    const port = await writeFreePortConfig(installDir, config);
    const daemon = new Daemon(installDir, port);
    daemon.followConfig({ port, ...config });
    undisposedDaemons.add(daemon);
    t.after(() => daemon.dispose());
    return daemon;
  }

  /** 같은 설치 디렉토리의 config.json 을 새 내용으로 바꾼다. (다음 구동부터 적용된다) `port` 와 경로 키는 이 객체도 따라간다. */
  writeConfig(config: Record<string, unknown>): void {
    fs.writeFileSync(path.join(this.installDir, "config.json"), JSON.stringify(config), "utf8");
    this.followConfig(config);
  }

  /** config.json 에 있던 키는 두고 `patch` 의 최상위 키만 덮어쓴다. (다음 구동부터 적용된다) */
  updateConfig(patch: Record<string, unknown>): void {
    const config = this.readConfig();
    this.writeConfig({ ...config, ...patch });
  }

  /** config.json 의 `port` 만 바꾼다. 이후의 `connect` 는 새 포트로 접속한다. */
  setPort(port: number): void {
    this.updateConfig({ port });
  }

  /** config.json 의 내용이다. 파일이 없으면 빈 객체이다. */
  readConfig(): Record<string, unknown> {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.installDir, "config.json"), "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /** config.json 을 지운다. (모든 값이 기본값으로 구동된다) 포트는 기본 포트가 된다. */
  removeConfig(): void {
    fs.rmSync(path.join(this.installDir, "config.json"), { force: true });
    this.followConfig({ port: DEFAULT_PORT });
  }

  /** `hwdb` 를 동기로 실행한다. 이 프로세스 안에서 데몬을 돌리지 않으므로 이벤트 루프가 막혀도 된다. 접속 중인 `Connection` 은 이 동안 응답을 읽지 못한다. */
  hwdb(args: string[], input?: string): HwdbResult {
    const result = spawnSync(this.runtime, [HWDB, ...args], {
      encoding: "utf8",
      env: { ...process.env, HWDB_INSTALL_DIR: this.installDir },
      timeout: 120_000,
      windowsHide: true,
      ...(input === undefined ? { stdio: ["ignore", "pipe", "pipe"] as const } : { input }),
    });
    this.noteDaemons();
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  /** `hwdb` 를 비동기로 실행한다. 접속 중인 `Connection` 이 있는 시험은 이쪽을 쓴다. */
  hwdbAsync(args: string[], input?: string): Promise<HwdbResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.runtime, [HWDB, ...args], {
        env: { ...process.env, HWDB_INSTALL_DIR: this.installDir },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.once("error", reject);
      child.once("close", (status) => {
        this.noteDaemons();
        resolve({ status, stdout, stderr });
      });
      child.stdin.end(input ?? "");
    });
  }

  /** `hwdb start` 로 데몬을 띄운다. 실패하면 시험을 실패시킨다. */
  start(): void {
    const result = this.hwdb(["start", "--timeout", "60"]);
    if (result.status !== 0) throw new Error(`hwdb start failed (${result.status}): ${result.stderr}${result.stdout}`);
  }

  /** `hwdb stop` 으로 정상 종료한다. */
  stop(): void {
    const result = this.hwdb(["stop", "--timeout", "60"]);
    if (result.status !== 0) throw new Error(`hwdb stop failed (${result.status}): ${result.stderr}${result.stdout}`);
  }

  /** 접속을 모두 끊은 뒤 정상 종료한다. (정상 종료 때 접속이 남아 있으면 유예 시간만큼 기다리게 된다) */
  stopClean(): void {
    for (const connection of this.connections) connection.abort();
    this.connections.clear();
    this.stop();
  }

  /** 잠금 파일에 적힌 데몬의 PID 이다. 구동 중이 아니면 null 이다. */
  get pid(): number | null {
    const lock = readLockFile(this.dataDir);
    return lock !== null && isProcessAlive(lock.pid) ? lock.pid : null;
  }

  /** 데몬 프로세스를 정상 종료 절차 없이 강제로 끝낸다. (비정상 종료 시험) */
  kill(): void {
    const pid = this.pid;
    if (pid === null) throw new Error("The daemon is not running.");
    process.kill(pid, "SIGKILL");
  }

  /** 데몬 프로세스가 사라질 때까지 기다린다. */
  async waitUntilGone(pid: number): Promise<void> {
    await waitFor(() => !isProcessAlive(pid), 30_000, `process ${pid} to exit`);
  }

  /** 로그 파일의 전체 내용이다. 없으면 빈 문자열이다. */
  log(): string {
    try {
      return fs.readFileSync(this.logPath, "utf8");
    } catch {
      return "";
    }
  }

  /** 접속하여 로그인한 `Connection` 을 돌려준다. 시험이 끝나면 자동으로 끊는다. 기본 계정은 SYSTEM 이다. */
  async connect(kind: ConnectKind = "tcp", options: ConnectOptions = {}): Promise<Connection> {
    const host = options.host ?? "127.0.0.1";
    const internal = { connectTimeoutMs: 10_000 };
    let connection: Connection;
    switch (kind) {
      case "local":
        connection = await Connection.open({ kind: "local", port: this.port }, { internal });
        break;
      case "tcp":
        connection = await Connection.open({ kind: "tcp", host, port: this.port }, { internal });
        break;
      case "tls":
        connection = await Connection.open(
          { kind: "tcp", host, port: this.port, ssl: options.ssl ?? { ca: fs.readFileSync(tlsFixture("server-a.cert.pem")) } },
          { internal },
        );
        break;
      case "udp":
        connection = await Connection.open({ kind: "udp", host, port: this.port }, { internal });
        break;
    }
    this.connections.add(connection);
    if (options.login !== false) {
      await connection.login({
        user: options.user ?? "SYSTEM",
        password: options.password ?? "HelloWorldDB",
        ...(options.tablespace === undefined ? {} : { tablespace: options.tablespace }),
      });
    }
    return connection;
  }

  /**
   * 시험이 끝났을 때의 정리이다. 접속을 끊고, 데몬이 남았으면 정상 종료를 시도하고, 그래도 남으면 강제로 끝낸 뒤 디렉토리를 지운다.
   * 데몬은 잠금 파일(지금까지 쓴 모든 데이터 디렉토리)과 구동 때 기억해 둔 데몬으로 찾는다. 디렉토리를 지우는 것은 항상 데몬을 끝낸 다음이다.
   * 두 번 불러도 한 번만 한다.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    undisposedDaemons.delete(this);
    for (const connection of this.connections) connection.abort();
    this.connections.clear();
    // 채널 경로의 existsSync는 구동 여부를 보장하지 않는다. 파일 검사에 앞서 실제 제어 채널로 종료를 시도한다.
    this.hwdb(["stop", "--timeout", "20"]); // 지금 설정의 인스턴스가 대상이다. 설정이 바뀌었다면 아래에서 옛 데몬도 확인한다.
    for (const pid of this.livePids()) forceKill(pid);
    const rmOptions = { recursive: true, force: true, maxRetries: 20, retryDelay: 100 } as const;
    for (const dir of [this.installDir, ...this.extraDirs]) {
      try {
        fs.rmSync(dir, rmOptions);
      } catch {
        // 지우지 못한 임시 디렉토리는 남는다. 데몬 프로세스를 남기는 것보다 낫다.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 질의 도우미
// ---------------------------------------------------------------------------

type Param = null | boolean | number | bigint | string | Buffer;

/** 문장을 실행한다. 조회 결과는 나머지 행까지 모두 받아 돌려준다. */
export async function exec(connection: Connection, sql: string, params: readonly Param[] = []): Promise<ExecuteOutcome> {
  const outcome = await connection.execute(sql, params);
  return outcome.kind === "rows" ? await connection.fetchAll(outcome) : outcome;
}

/** 조회하여 행을 돌려준다. (값은 서버가 보낸 JSON 값 그대로이다. BIGINT·NUMERIC·날짜시간은 문자열) */
export async function query(connection: Connection, sql: string, params: readonly Param[] = []): Promise<JsonValue[][]> {
  const outcome = await exec(connection, sql, params);
  if (outcome.kind !== "rows") throw new Error(`Not a query: ${sql}`);
  return outcome.rows;
}

/** 첫 행의 첫 열이다. */
export async function scalar(connection: Connection, sql: string, params: readonly Param[] = []): Promise<JsonValue> {
  const rows = await query(connection, sql, params);
  if (rows.length === 0 || rows[0]?.length === 0) throw new Error(`No value: ${sql}`);
  return (rows[0] as JsonValue[])[0] as JsonValue;
}

/** 첫 행의 첫 열을 숫자로 돌려준다. (COUNT, SUM 같은 BIGINT 는 문자열로 오므로 안전 정수 범위에서 바꾼다) */
export async function num(connection: Connection, sql: string, params: readonly Param[] = []): Promise<number> {
  const value = await scalar(connection, sql, params);
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) && !Number.isFinite(parsed)) throw new Error(`Not a number: ${String(value)}`);
  return parsed;
}

/** 문장이 오류로 끝나기를 기대하고 그 오류를 돌려준다. 성공하면 시험이 실패한다. */
export async function failure(connection: Connection, sql: string, params: readonly Param[] = []): Promise<DbError> {
  try {
    await exec(connection, sql, params);
  } catch (error) {
    if (error instanceof DbError) return error;
    throw error;
  }
  throw new Error(`The statement should have failed: ${sql}`);
}

/** 여러 문장을 차례로 실행한다. */
export async function execAll(connection: Connection, statements: readonly string[]): Promise<void> {
  for (const sql of statements) await exec(connection, sql);
}

/** 지정한 시간(ms)만 기다린다. */
export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
