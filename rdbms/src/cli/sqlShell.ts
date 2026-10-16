/**
 * SQL 접속 : 인자 없이 또는 접속 옵션만 주고 `hwdb` 를 실행했을 때의 동작.
 *
 * 담당
 *  - 접속 대상 결정 : 호스트를 생략하면 로컬 전용 채널, 지정하면 TCP (`--udp` 면 UDP). 포트를 생략하면 config.json 의 `port`.
 *    데몬이 구동 중이 아니면 `hwdb start` 를 안내하고 끝낸다.
 *  - 사용자명과 비밀번호 입력. 비밀번호는 화면에 보이지 않게 받는다. 표준 입력이 터미널이 아니면 물어볼 수 없으므로 `-u`, `-p` 가 필요하다.
 *  - 대화형 모드 : 프롬프트 `hwdb> `, 여러 줄 입력, `;` 에서 실행, `help`, `exit`, `quit`, 입력 이력(터미널의 줄 편집)
 *  - 스크립트 모드 : `-e`, `-f`, 표준 입력. 오류가 나면 멈추고 종료 코드 1
 *  - 문장 나누기 : `;` 기준. 문자열과 주석 안의 `;` 는 문장 끝으로 보지 않는다. 서버에는 한 번에 한 문장만 보낸다. (statementSplitter.ts)
 *  - SYSTEM 계정의 초기 암호 변경 안내, 커밋하지 않은 변경이 롤백됨을 알림
 *
 * 서버와의 통신은 client/connection.ts 에 맡기고, 화면 출력은 resultPrinter.ts 에 맡긴다.
 * 입출력(표준 입출력, 파일, 터미널 입력, 접속)은 `ShellEnvironment` 로 받으므로 시험에서는 가짜를 끼워 넣는다.
 *
 * 화면 출력의 구분 : 조회 결과 표와 행 수, 완료 메시지는 표준 출력, 오류와 안내와 경고는 표준 오류에 낸다.
 *
 * 관련 사양 : AGENTS.md 상세 14-2
 * 구현 단계 : 10단계
 */

import fs from "node:fs";
import { DbError } from "../common/errors.js";
import { Connection, isConnectionRefused } from "../client/connection.js";
import type { ConnectionOptions, SslOptions, Target } from "../client/connection.js";
import { loadConfig } from "../config/config.js";
import type { SessionInfoMessage } from "../net/protocol.js";
import type { SqlOptions } from "./args.js";
import { t } from "./i18n.js";
import { formatError, formatOkLine, formatRowsFooter, renderTable } from "./resultPrinter.js";
import { splitScript, splitStatements } from "./statementSplitter.js";
import { askLine, askSecret, createReadlineSource, decodeUtf8Strict, readAllStdin } from "./terminal.js";
import type { LineSource, TerminalInput } from "./terminal.js";

/** 대화형 모드의 프롬프트이다. (상세 14-2. 문구 카탈로그가 아니라 사양이 정한 고정 문자열이다) */
export const PROMPT = "hwdb> ";
/** 문장이 끝나지 않아 다음 줄을 받을 때의 프롬프트이다. */
export const CONTINUATION_PROMPT = "    -> ";

/** SYSTEM 계정의 초기 암호이다. (상세 4) */
const SYSTEM_INITIAL_PASSWORD = "HelloWorldDB";

/** `hwdb` 가 밖과 주고받는 것을 모은 것이다. 시험에서는 필요한 것만 바꿔 쓴다. */
export interface ShellEnvironment {
  out(text: string): void;
  err(text: string): void;
  /** 표준 입력이 터미널인지이다. 아니면 사용자명과 비밀번호를 물어볼 수 없고 표준 입력은 문장을 읽는 데 쓴다. */
  stdinIsTTY: boolean;
  /** 표준 입력 전체를 읽는다. (스크립트 모드) */
  readStdin(): Promise<string>;
  readFile(path: string): Buffer;
  /** 사용자명을 묻는다. 취소되면 null 이다. */
  ask(prompt: string): Promise<string | null>;
  /** 화면에 보이지 않게 묻는다. 취소되면 null 이다. 지원하지 않는 터미널이면 던진다. */
  askSecret(prompt: string): Promise<string | null>;
  /** 대화형 모드의 줄 입력을 연다. */
  openLineSource(): LineSource;
  connect(target: Target, options: ConnectionOptions): Promise<Connection>;
  /** 포트를 생략했을 때의 포트이다. 설치 디렉토리의 config.json 이 올바르지 않으면 던진다. */
  defaultPort(installDir: string): number;
}

/** 실제 표준 입출력과 파일 시스템을 쓰는 환경이다. */
export function defaultShellEnvironment(): ShellEnvironment {
  const input = process.stdin as TerminalInput;
  // 결과를 파일로 돌렸을 때 프롬프트가 결과에 섞이지 않도록, 표준 출력이 터미널이 아니면 프롬프트는 표준 오류에 낸다.
  const promptOutput = process.stdout.isTTY === true ? process.stdout : process.stderr;
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    stdinIsTTY: process.stdin.isTTY === true,
    readStdin: () => readAllStdin(process.stdin),
    readFile: (path) => fs.readFileSync(path),
    ask: (prompt) => askLine(prompt, input, promptOutput),
    askSecret: (prompt) => askSecret(prompt, input, promptOutput),
    openLineSource: () => createReadlineSource(input, promptOutput),
    connect: (target, options) => Connection.open(target, options),
    defaultPort: (installDir) => loadConfig(installDir).config.port,
  };
}

/**
 * `-t` 의 값을 테이블스페이스 이름으로 바꾼다. SQL 의 식별자 규칙을 따른다(상세 0) :
 * 따옴표 없는 이름은 대문자로 바꾸고, 큰따옴표로 감싼 이름은 따옴표를 떼고 `""` 를 `"` 로 하여 적힌 그대로 쓴다.
 * 프로토콜(`authStart.tablespace`)은 저장된 이름 그대로를 받으므로 이 변환은 클라이언트가 한다.
 */
export function tablespaceNameOf(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/""/g, '"');
  }
  return text.toUpperCase();
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Outcome = "ok" | "error" | "lost";

/** 접속 대상을 정한다. CA 파일을 읽지 못하면 오류 문구(string)를 돌려준다. */
function buildTarget(options: SqlOptions, port: number, env: ShellEnvironment): Target | string {
  if (options.host === undefined) return { kind: "local", port };
  if (options.udp) return { kind: "udp", host: options.host, port };
  if (!options.ssl) return { kind: "tcp", host: options.host, port };
  const ssl: SslOptions = {
    onCertRetry: ({ attempt, maxAttempts, error }) => {
      const code = (error as { code?: unknown }).code;
      env.err(`${t("sql.certRetry", { code: typeof code === "string" ? code : error.message, attempt, max: maxAttempts })}\n`);
    },
  };
  if (options.sslCa !== undefined) {
    try {
      ssl.ca = env.readFile(options.sslCa);
    } catch (error) {
      return t("sql.cannotReadCa", { path: options.sslCa, reason: reasonOf(error) });
    }
  }
  if (options.sslNoVerify) ssl.rejectUnauthorized = false;
  return { kind: "tcp", host: options.host, port, ssl };
}

/** 접속 실패를 사람이 읽을 문구로 바꾼다. */
function describeConnectFailure(error: unknown, target: Target): string {
  if (error instanceof DbError) {
    if (target.kind === "local" && isConnectionRefused(error)) {
      return t("sql.daemonNotRunning", { port: target.port });
    }
    const lines = [formatError(error)];
    // 인증서 오류로 접속하지 못했을 때는 해결 방법을 알려 준다.
    if (error.sqlState === "08001") lines.push(t("sql.certHint"));
    return lines.join("\n");
  }
  return t("error.line", { text: reasonOf(error) });
}

/**
 * `hwdb` 의 SQL 접속을 실행하고 프로세스 종료 코드를 돌려준다.
 * 0 은 정상, 1 은 접속·인증 실패나 스크립트 모드의 문장 오류이다.
 */
export async function runSqlCommand(options: SqlOptions, installDir: string, env: ShellEnvironment = defaultShellEnvironment()): Promise<number> {
  // 스크립트 모드 : -e, -f 를 썼거나 표준 입력이 터미널이 아니다.
  const scripted = options.execute !== undefined || options.file !== undefined || !env.stdinIsTTY;

  // 표준 입력이 터미널이 아니면 사용자명과 비밀번호를 물어볼 수 없다.
  if (!env.stdinIsTTY) {
    const missing: string[] = [];
    if (options.user === undefined) missing.push("-u");
    if (options.password === undefined) missing.push("-p");
    if (missing.length > 0) {
      env.err(`${t("sql.credentialsRequired", { options: missing.join(", ") })}\n`);
      return 1;
    }
  }

  let port = options.port;
  if (port === undefined) {
    try {
      port = env.defaultPort(installDir);
    } catch (error) {
      env.err(`${t("sql.configFailed", { reason: reasonOf(error) })}\n`);
      return 1;
    }
  }

  // 문장을 담은 입력은 접속하기 전에 읽는다. 읽지 못하면 로그인하지 않고 끝낸다.
  let script: string | null = null;
  try {
    if (options.execute !== undefined) script = options.execute;
    else if (options.file !== undefined) script = decodeUtf8Strict(env.readFile(options.file));
    else if (!env.stdinIsTTY) script = await env.readStdin();
  } catch (error) {
    const key = options.file !== undefined ? "sql.cannotReadFile" : "sql.cannotReadInput";
    env.err(`${t(key, { path: options.file ?? "", reason: reasonOf(error) })}\n`);
    return 1;
  }

  let user = options.user;
  let password = options.password;
  try {
    if (user === undefined) {
      const answer = await env.ask(t("prompt.user"));
      if (answer === null || answer.trim() === "") {
        env.err(`${t("sql.userRequired")}\n`);
        return 1;
      }
      user = answer.trim();
    }
    if (password === undefined) {
      const answer = await env.askSecret(t("prompt.password"));
      if (answer === null) {
        env.err(`${t("sql.passwordCancelled")}\n`);
        return 1;
      }
      password = answer;
    }
  } catch {
    env.err(`${t("sql.hiddenInputUnsupported")}\n`);
    return 1;
  }

  const target = buildTarget(options, port, env);
  if (typeof target === "string") {
    env.err(`${target}\n`);
    return 1;
  }
  let connection: Connection;
  try {
    connection = await env.connect(target, { clientName: "hwdb" });
  } catch (error) {
    env.err(`${describeConnectFailure(error, target)}\n`);
    return 1;
  }

  let session: SessionInfoMessage;
  try {
    session = await connection.login({ user, password, ...(options.tablespace === undefined ? {} : { tablespace: tablespaceNameOf(options.tablespace) }) });
  } catch (error) {
    env.err(`${error instanceof DbError ? formatError(error) : t("error.line", { text: reasonOf(error) })}\n`);
    connection.abort();
    return 1;
  }

  // SYSTEM 계정이 초기 암호로 로그인하면 변경을 안내한다. 결과(표준 출력)에 섞이지 않도록 표준 오류에 낸다.
  if (session.user === "SYSTEM" && password === SYSTEM_INITIAL_PASSWORD) {
    env.err(`${t("warning.initialPassword")}\n`);
  }

  let exitCode = 1;
  try {
    if (scripted) {
      exitCode = await runScript(connection, env, script ?? "");
    } else {
      exitCode = await runInteractive(connection, env, session);
    }
  } finally {
    // 접속을 끝낸다. 커밋하지 않은 변경이 있었으면 서버가 롤백하고 그 사실을 알려 준다.
    const { rolledBack } = await connection.close();
    if (rolledBack) env.err(`${t("sql.rolledBack")}\n`);
  }
  return exitCode;
}

/** 문장 하나를 서버에 보내고 결과를 출력한다. */
async function runStatement(
  connection: Connection,
  env: ShellEnvironment,
  text: string,
  origin: { line: number; column: number } | undefined,
): Promise<Outcome> {
  const started = performance.now();
  try {
    const result = await connection.execute(text);
    if (result.kind === "rows") {
      const all = await connection.fetchAll(result);
      const elapsed = performance.now() - started;
      env.out(`${renderTable(all.columns, all.rows)}\n${formatRowsFooter(all.rows.length, elapsed)}\n`);
    } else {
      env.out(`${formatOkLine(result.message, result.rowCount, performance.now() - started)}\n`);
    }
    return "ok";
  } catch (error) {
    if (error instanceof DbError) {
      env.err(`${formatError(error, text, origin)}\n`);
    } else {
      env.err(`${t("error.line", { text: reasonOf(error) })}\n`);
    }
    // 서버가 접속을 닫았거나 끊긴 경우이다. (서버 종료, 유휴 시간 초과, 네트워크 단절)
    return connection.isClosed ? "lost" : "error";
  }
}

/** 스크립트 모드 : 문장을 차례로 실행하고, 오류가 나면 거기서 멈춘다. */
async function runScript(connection: Connection, env: ShellEnvironment, script: string): Promise<number> {
  for (const statement of splitScript(script)) {
    const outcome = await runStatement(connection, env, statement.text, { line: statement.line, column: statement.column });
    if (outcome !== "ok") return 1;
  }
  return 0;
}

/** 대화형 모드에서 문장이 아닌 명령이다. 입력이 비어 있을 때 한 줄이 이것이면 명령으로 본다. */
function metaCommandOf(line: string): "exit" | "help" | null {
  const word = line.trim().replace(/;+\s*$/, "").trim().toLowerCase();
  if (word === "exit" || word === "quit") return "exit";
  if (word === "help") return "help";
  return null;
}

/** 대화형 모드 : 줄을 받아 `;` 에서 문장을 실행한다. */
async function runInteractive(connection: Connection, env: ShellEnvironment, session: SessionInfoMessage): Promise<number> {
  const source = env.openLineSource();
  env.out(`${t("sql.connected", { server: connection.hello.server, user: session.user, tablespace: session.tablespace ?? t("common.none") })}\n`);
  env.out(`${t("sql.hint")}\n`);
  try {
    /** 아직 실행하지 않은 입력이다. 문장이 여러 줄에 걸쳐 있을 때 쓴다. */
    let buffer = "";
    let pending = false;
    for (;;) {
      const read = await source.readLine(pending ? CONTINUATION_PROMPT : PROMPT);
      if (read.kind === "eof") {
        // 끝나지 않은 입력이 있으면 버린다. 줄이 이어지도록 줄바꿈을 낸다.
        env.out("\n");
        return 0;
      }
      if (read.kind === "interrupt") {
        if (pending) {
          buffer = "";
          pending = false;
          env.err(`${t("sql.inputDiscarded")}\n`);
        } else {
          env.err(`${t("sql.interruptHint")}\n`);
        }
        continue;
      }

      if (!pending) {
        const command = metaCommandOf(read.text);
        if (command === "exit") return 0;
        if (command === "help") {
          env.out(`${t("sql.help")}\n`);
          continue;
        }
      }

      buffer = pending ? `${buffer}\n${read.text}` : read.text;
      const split = splitStatements(buffer);
      for (const statement of split.statements) {
        const outcome = await runStatement(connection, env, statement.text, undefined);
        if (outcome === "lost") {
          env.err(`${t("sql.connectionLost")}\n`);
          return 1;
        }
      }
      pending = split.restPending;
      // 공백과 닫힌 주석뿐인 나머지는 버린다. 문장의 일부가 있으면 다음 줄과 이어 붙인다.
      buffer = pending ? split.rest : "";
    }
  } finally {
    source.close();
  }
}
