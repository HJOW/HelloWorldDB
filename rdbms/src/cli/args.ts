/**
 * `hwdb` 명령행 인자 해석.
 *
 * 담당
 *  - 하위 명령(`start`, `stop`, `status`)과 SQL 접속 옵션(상세 14-2 의 옵션 표)을 해석한다.
 *  - 값이 필요한 옵션은 `--port 7410`, `--port=7410`, `-P 7410`, `-P7410` 형태를 모두 받는다.
 *  - 옵션의 조합 규칙을 검사한다 : `--udp`, `--ssl`, `--ssl-ca`, `--ssl-no-verify` 는 `--host` 와 함께만,
 *    `--udp` 와 `--ssl` 은 함께 쓸 수 없고, `--ssl-ca` 와 `--ssl-no-verify` 는 `--ssl` 이 있어야 하며 서로 함께 쓸 수 없고,
 *    `-e` 와 `-f` 도 함께 쓸 수 없다.
 *  - 실행은 하지 않는다. 해석 결과(또는 사용자에게 보일 오류 문구)만 돌려준다. 그래서 프로세스를 띄우지 않고 시험할 수 있다.
 *
 * 오류 문구는 메시지 카탈로그(`t`)에서 꺼낸다. (사용자 결정 2026-10-16)
 *
 * 관련 사양 : AGENTS.md 상세 14-1, 14-2
 * 구현 단계 : 10단계
 */

import { isValidPort } from "../common/instance.js";
import { t } from "./i18n.js";

/** `hwdb start`, `stop` 의 기본 제한 시간(초)이다. */
export const DEFAULT_TIMEOUT_SECONDS = 30;

/** SQL 접속 옵션이다. 모든 옵션은 생략할 수 있다. */
export interface SqlOptions {
  host?: string;
  port?: number;
  udp: boolean;
  ssl: boolean;
  sslCa?: string;
  sslNoVerify: boolean;
  user?: string;
  password?: string;
  tablespace?: string;
  execute?: string;
  file?: string;
}

export type ParsedCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "start"; timeoutSeconds: number; foreground: boolean }
  | { kind: "stop"; timeoutSeconds: number }
  | { kind: "status" }
  | { kind: "sql"; options: SqlOptions }
  | { kind: "error"; message: string };

const DAEMON_COMMANDS = ["start", "stop", "status"] as const;

/** 옵션 하나의 정의이다. 모든 옵션이 값을 받거나(`value`) 받지 않는다(`flag`). */
interface OptionSpec {
  /** 결과에 쓸 이름이다. */
  key: string;
  long: string;
  short?: string;
  takesValue: boolean;
}

const SQL_OPTION_SPECS: readonly OptionSpec[] = [
  { key: "host", long: "--host", short: "-h", takesValue: true },
  { key: "port", long: "--port", short: "-P", takesValue: true },
  { key: "udp", long: "--udp", takesValue: false },
  { key: "ssl", long: "--ssl", takesValue: false },
  { key: "sslCa", long: "--ssl-ca", takesValue: true },
  { key: "sslNoVerify", long: "--ssl-no-verify", takesValue: false },
  { key: "user", long: "--user", short: "-u", takesValue: true },
  { key: "password", long: "--password", short: "-p", takesValue: true },
  { key: "tablespace", long: "--tablespace", short: "-t", takesValue: true },
  { key: "execute", long: "--execute", short: "-e", takesValue: true },
  { key: "file", long: "--file", short: "-f", takesValue: true },
];

const START_OPTION_SPECS: readonly OptionSpec[] = [
  { key: "timeout", long: "--timeout", takesValue: true },
  { key: "foreground", long: "--foreground", takesValue: false },
];

const STOP_OPTION_SPECS: readonly OptionSpec[] = [{ key: "timeout", long: "--timeout", takesValue: true }];

type RawOptions = Map<string, string | true>;
type RawResult = { ok: true; options: RawOptions; help: boolean; version: boolean } | { ok: false; message: string };

/**
 * 인자 목록을 옵션 표에 따라 나눈다. 위치 인자(옵션이 아닌 인자)는 허용하지 않는다.
 * `--help`, `--version` 은 어느 명령에서든 알아본다. (옵션의 값으로 쓰인 경우는 제외)
 */
function scanOptions(args: readonly string[], specs: readonly OptionSpec[], command: string): RawResult {
  const options: RawOptions = new Map();
  let help = false;
  let version = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--version") {
      version = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      const spec = specs.find((candidate) => candidate.long === name);
      if (spec === undefined) return { ok: false, message: t("args.unknownOption", { command, option: name }) };
      if (!spec.takesValue) {
        if (equals !== -1) return { ok: false, message: t("args.optionTakesNoValue", { option: spec.long }) };
        options.set(spec.key, true);
        continue;
      }
      if (equals !== -1) {
        options.set(spec.key, arg.slice(equals + 1));
        continue;
      }
      const next = args[index + 1];
      if (next === undefined) return { ok: false, message: t("args.optionNeedsValue", { option: spec.long }) };
      options.set(spec.key, next);
      index++;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const short = arg.slice(0, 2);
      const spec = specs.find((candidate) => candidate.short === short);
      if (spec === undefined) return { ok: false, message: t("args.unknownOption", { command, option: short }) };
      // 짧은 옵션은 모두 값을 받는다. `-P7410` 처럼 붙여 쓰거나 `-P 7410` 처럼 띄어 쓴다.
      if (arg.length > 2) {
        options.set(spec.key, arg.slice(2));
        continue;
      }
      const next = args[index + 1];
      if (next === undefined) return { ok: false, message: t("args.optionNeedsValue", { option: spec.short ?? spec.long }) };
      options.set(spec.key, next);
      index++;
      continue;
    }
    return { ok: false, message: t("args.unexpectedArgument", { command, argument: arg }) };
  }
  return { ok: true, options, help, version };
}

/** `--timeout` 값을 정수 초로 바꾼다. 없으면 기본값이다. */
function timeoutOf(options: RawOptions): number | string {
  const raw = options.get("timeout");
  if (raw === undefined) return DEFAULT_TIMEOUT_SECONDS;
  if (raw === true || !/^[0-9]+$/.test(raw)) return t("args.timeoutInvalid");
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return t("args.timeoutInvalid");
  return parsed;
}

function stringOption(options: RawOptions, key: string): string | undefined {
  const value = options.get(key);
  return typeof value === "string" ? value : undefined;
}

/** SQL 접속 옵션을 만들고 조합 규칙을 검사한다. 오류면 문구(string)를 돌려준다. */
function buildSqlOptions(raw: RawOptions): SqlOptions | string {
  const options: SqlOptions = {
    udp: raw.has("udp"),
    ssl: raw.has("ssl"),
    sslNoVerify: raw.has("sslNoVerify"),
  };
  const host = stringOption(raw, "host");
  if (host !== undefined) {
    if (host === "") return t("args.hostEmpty");
    options.host = host;
  }
  const port = stringOption(raw, "port");
  if (port !== undefined) {
    const parsed = /^[0-9]+$/.test(port) ? Number(port) : NaN;
    if (!isValidPort(parsed)) return t("args.portInvalid", { value: port });
    options.port = parsed;
  }
  const sslCa = stringOption(raw, "sslCa");
  if (sslCa !== undefined) {
    if (sslCa === "") return t("args.sslCaEmpty");
    options.sslCa = sslCa;
  }
  const user = stringOption(raw, "user");
  if (user !== undefined) options.user = user;
  const password = stringOption(raw, "password");
  if (password !== undefined) options.password = password;
  const tablespace = stringOption(raw, "tablespace");
  if (tablespace !== undefined) {
    if (tablespace === "") return t("args.tablespaceEmpty");
    options.tablespace = tablespace;
  }
  const execute = stringOption(raw, "execute");
  if (execute !== undefined) options.execute = execute;
  const file = stringOption(raw, "file");
  if (file !== undefined) {
    if (file === "") return t("args.fileEmpty");
    options.file = file;
  }

  // 옵션의 조합 (상세 14-2)
  if (options.host === undefined) {
    // 호스트가 없으면 로컬 전용 채널이므로 UDP 와 SSL 옵션은 뜻이 없다.
    for (const [name, present] of [["--udp", options.udp], ["--ssl", options.ssl], ["--ssl-ca", options.sslCa !== undefined], ["--ssl-no-verify", options.sslNoVerify]] as const) {
      if (present) return t("args.needsHost", { option: name });
    }
  }
  if (options.udp && options.ssl) return t("args.udpWithSsl");
  if (options.udp && (options.sslCa !== undefined || options.sslNoVerify)) {
    return t("args.sslOptionWithUdp", { option: options.sslCa !== undefined ? "--ssl-ca" : "--ssl-no-verify" });
  }
  if (!options.ssl) {
    if (options.sslCa !== undefined) return t("args.needsSsl", { option: "--ssl-ca" });
    if (options.sslNoVerify) return t("args.needsSsl", { option: "--ssl-no-verify" });
  }
  if (options.sslCa !== undefined && options.sslNoVerify) return t("args.sslCaWithNoVerify");
  if (options.execute !== undefined && options.file !== undefined) return t("args.executeWithFile");
  return options;
}

/**
 * 명령행 인자(`process.argv.slice(2)`)를 해석한다.
 * 첫 인자가 `start`, `stop`, `status` 면 데몬 제어이고, 그 밖에는 모두 SQL 접속 옵션이다.
 */
export function parseArguments(argv: readonly string[]): ParsedCommand {
  const first = argv[0];
  const daemonCommand = DAEMON_COMMANDS.find((name) => name === first);
  if (daemonCommand !== undefined) {
    const rest = argv.slice(1);
    const specs = daemonCommand === "start" ? START_OPTION_SPECS : daemonCommand === "stop" ? STOP_OPTION_SPECS : [];
    const scanned = scanOptions(rest, specs, `hwdb ${daemonCommand}`);
    if (!scanned.ok) return { kind: "error", message: scanned.message };
    if (scanned.help) return { kind: "help" };
    if (scanned.version) return { kind: "version" };
    if (daemonCommand === "status") return { kind: "status" };
    const timeout = timeoutOf(scanned.options);
    if (typeof timeout === "string") return { kind: "error", message: timeout };
    if (daemonCommand === "stop") return { kind: "stop", timeoutSeconds: timeout };
    return { kind: "start", timeoutSeconds: timeout, foreground: scanned.options.has("foreground") };
  }

  const scanned = scanOptions(argv, SQL_OPTION_SPECS, "hwdb");
  if (!scanned.ok) return { kind: "error", message: scanned.message };
  if (scanned.help) return { kind: "help" };
  if (scanned.version) return { kind: "version" };
  const options = buildSqlOptions(scanned.options);
  if (typeof options === "string") return { kind: "error", message: options };
  return { kind: "sql", options };
}
