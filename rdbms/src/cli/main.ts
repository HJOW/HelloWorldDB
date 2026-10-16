#!/usr/bin/env node
/**
 * `hwdb` 명령의 진입점.
 *
 * 담당
 *  - 명령행 인자에서 하위 명령을 가려 담당 모듈로 넘긴다.
 *      hwdb start | stop | status   → 데몬 제어 (daemonControl.ts)
 *      hwdb [옵션]                  → SQL 접속 (sqlShell.ts)
 *  - 옵션 해석 (상세 14-2 의 옵션 표, --timeout, --foreground)
 *  - 프로세스 종료 코드 결정
 *
 * 여기에 두지 않는 것 : 데몬 본체의 구동 절차 (daemon/main.ts)
 *
 * 관련 사양 : AGENTS.md 상세 14
 * 구현 단계 : 1단계에서 `start --foreground` 와 `status` 를 연결했다.
 *             분리 구동과 SQL 접속은 10단계에서 붙는다.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCommand, statusCommand, stopCommand } from "./daemonControl.js";
import { initLocaleFromEnvironment, t } from "./i18n.js";

/** 데몬 제어용 하위 명령. 이 밖의 인자는 모두 SQL 접속으로 본다. */
const DAEMON_COMMANDS = ["start", "stop", "status"] as const;
type DaemonCommand = (typeof DAEMON_COMMANDS)[number];

const DEFAULT_TIMEOUT_SECONDS = 30;

function isDaemonCommand(arg: string | undefined): arg is DaemonCommand {
  return DAEMON_COMMANDS.includes(arg as DaemonCommand);
}

/**
 * 설치 디렉토리를 찾는다. config.json 이 있는 디렉토리이다.
 * HWDB_INSTALL_DIR 환경 변수가 있으면 시험용으로 그것을 쓴다.
 */
export function findInstallDir(): string {
  const override = process.env["HWDB_INSTALL_DIR"];
  if (override !== undefined && override.length > 0) {
    return path.resolve(override);
  }
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(cliDir, "..", "..", "..");
}

function parseTimeoutSeconds(args: readonly string[]): number | null {
  const index = args.indexOf("--timeout");
  if (index === -1) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  const raw = args[index + 1];
  if (raw === undefined) {
    process.stderr.write(`${t("args.timeoutNeedsValue")}\n`);
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    process.stderr.write(`${t("args.timeoutInvalid")}\n`);
    return null;
  }
  return parsed;
}

/** 인자를 보고 할 일을 정해 실행한 뒤, 프로세스 종료 코드를 돌려준다. */
async function main(argv: readonly string[]): Promise<number> {
  const [first] = argv;

  if (argv.includes("--help")) {
    process.stdout.write(t("usage.text"));
    return 0;
  }

  if (isDaemonCommand(first)) {
    const installDir = findInstallDir();
    if (first === "status") {
      if (argv.length > 1) {
        process.stderr.write(`${t("args.statusTakesNoArguments")}\n`);
        return 1;
      }
      return await statusCommand(installDir);
    }
    if (first === "stop") {
      const timeoutSeconds = parseTimeoutSeconds(argv);
      if (timeoutSeconds === null) {
        return 1;
      }
      const rest = argv.filter((arg, index) => arg !== "--timeout" && argv[index - 1] !== "--timeout");
      if (rest.length > 1) {
        process.stderr.write(`${t("args.stopUnknownArguments")}\n`);
        return 1;
      }
      return await stopCommand(installDir, timeoutSeconds);
    }
    const timeoutSeconds = parseTimeoutSeconds(argv);
    if (timeoutSeconds === null) {
      return 1;
    }
    const foreground = argv.includes("--foreground");
    const rest = argv.filter((arg, index) => {
      if (arg === "--timeout" || argv[index - 1] === "--timeout" || arg === "--foreground") {
        return false;
      }
      return true;
    });
    if (rest.length > 1) {
      process.stderr.write(`${t("args.startUnknownArguments")}\n`);
      return 1;
    }
    return await startCommand({ installDir, foreground, timeoutSeconds });
  }

  // TODO(10단계) : 옵션을 해석하여 sqlShell.ts 로 넘긴다.
  process.stderr.write(`${t("session.notImplemented")}\n`);
  return 1;
}

initLocaleFromEnvironment();
process.exitCode = await main(process.argv.slice(2));
