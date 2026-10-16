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
import { DEFAULT_PORT } from "../../src/common/instance.js";
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

  private constructor(installDir: string, port: number) {
    this.installDir = installDir;
    this.port = port;
    this.dataDir = path.join(installDir, "data");
    this.logPath = path.join(installDir, "logs", "helloworlddb.log");
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
      child.once("close", (status) => resolve({ status, stdout, stderr }));
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

  /** 시험이 끝났을 때의 정리이다. 접속을 끊고, 데몬이 남았으면 정상 종료를 시도하고, 그래도 남으면 강제로 끝낸다. */
  private dispose(): void {
    for (const connection of this.connections) connection.abort();
    this.connections.clear();
    const pid = this.pid;
    if (pid !== null && pid !== process.pid) {
      this.hwdb(["stop", "--timeout", "20"]);
      if (isProcessAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // 이미 끝났다.
        }
      }
    }
    fs.rmSync(this.installDir, { recursive: true, force: true });
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
