/**
 * CLI 시험의 공용 도우미 (10단계). 시험을 등록하지 않으므로 여러 시험 파일에서 import 해도 중복 실행되지 않는다.
 *  - 프로세스 안에서 데몬(`Server`)을 띄우는 도우미 : `startServer`
 *  - `hwdb` 의 입출력을 가짜로 끼우는 환경 : `makeShellEnv`, `scriptedLines`
 * 관련 사양 : AGENTS.md 상세 14
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection } from "../../src/client/connection.js";
import { createLogger } from "../../src/common/logger.js";
import { loadConfig } from "../../src/config/config.js";
import { Server } from "../../src/daemon/server.js";
import type { SqlOptions } from "../../src/cli/args.js";
import { runSqlCommand } from "../../src/cli/sqlShell.js";
import type { ShellEnvironment } from "../../src/cli/sqlShell.js";
import type { LineRead, LineSource } from "../../src/cli/terminal.js";
import { writeFreePortConfig } from "../net/helpers.js";

export interface RunningServer {
  installDir: string;
  port: number;
  server: Server;
  stop(): Promise<void>;
}

/** 새 설치 디렉토리에서 데몬을 프로세스 안에 띄운다. 시험이 끝나면 `stop()` 으로 끝내고 디렉토리를 지운다. */
export async function startServer(extra: Record<string, unknown> = {}): Promise<RunningServer> {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "hwdb-sh-"));
  const port = await writeFreePortConfig(installDir, extra);
  const { config } = loadConfig(installDir);
  const logger = createLogger({ level: "error", dir: config.log.dir, foreground: false });
  const server = new Server(config, logger);
  await server.start();
  return {
    installDir,
    port,
    server,
    async stop() {
      await server.stop();
      await logger.close();
      fs.rmSync(installDir, { recursive: true, force: true });
    },
  };
}

/** 가짜 환경과 거기에 모인 출력이다. */
export interface ShellHarness {
  env: ShellEnvironment;
  out: string[];
  err: string[];
  /** 표준 출력으로 나간 것 전체이다. */
  outText(): string;
  /** 표준 오류로 나간 것 전체이다. */
  errText(): string;
}

/**
 * `hwdb` 의 입출력을 가짜로 끼운 환경을 만든다. 기본은 터미널이 아닌 표준 입력(빈 입력)이고, 접속은 진짜 `Connection` 이다.
 * 물어보는 일(`ask`, `askSecret`, `openLineSource`)은 기본으로 시험을 실패시킨다. 필요한 시험이 `overrides` 로 바꾼다.
 */
export function makeShellEnv(overrides: Partial<ShellEnvironment> = {}): ShellHarness {
  const out: string[] = [];
  const err: string[] = [];
  const env: ShellEnvironment = {
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
    stdinIsTTY: false,
    readStdin: () => Promise.resolve(""),
    readFile: (filePath) => fs.readFileSync(filePath),
    ask: () => Promise.reject(new Error("unexpected ask")),
    askSecret: () => Promise.reject(new Error("unexpected askSecret")),
    openLineSource: () => {
      throw new Error("unexpected openLineSource");
    },
    connect: (target, options) => Connection.open(target, { ...options, internal: { connectTimeoutMs: 5000 } }),
    defaultPort: (installDir) => loadConfig(installDir).config.port,
    ...overrides,
  };
  return { env, out, err, outText: () => out.join(""), errText: () => err.join("") };
}

/** 미리 정한 입력을 차례로 내주는 줄 입력이다. 입력이 끝나면 eof 이다. 받은 프롬프트를 `prompts` 에 모은다. */
export function scriptedLines(inputs: ReadonlyArray<string | "interrupt" | (() => Promise<string | "interrupt">)>): LineSource & { prompts: string[]; closed: boolean } {
  const queue = [...inputs];
  const source = {
    prompts: [] as string[],
    closed: false,
    async readLine(prompt: string): Promise<LineRead> {
      source.prompts.push(prompt);
      const next = queue.shift();
      if (next === undefined) return { kind: "eof" };
      const value = typeof next === "function" ? await next() : next;
      if (value === "interrupt") return { kind: "interrupt" };
      return { kind: "line", text: value };
    },
    close(): void {
      source.closed = true;
    },
  };
  return source;
}

/** 접속 옵션의 기본값에 덮어써서 SQL 접속을 실행한다. */
export function runSql(options: Partial<SqlOptions>, installDir: string, harness: ShellHarness): Promise<number> {
  return runSqlCommand({ udp: false, ssl: false, sslNoVerify: false, ...options }, installDir, harness.env);
}

/** 접속 옵션에 SYSTEM 의 초기 암호를 채운다. */
export function asSystem(options: Partial<SqlOptions> = {}): Partial<SqlOptions> {
  return { user: "SYSTEM", password: "HelloWorldDB", ...options };
}
