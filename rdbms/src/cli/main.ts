#!/usr/bin/env node
/**
 * `hwdb` 명령의 진입점.
 *
 * 담당
 *  - 명령행 인자에서 하위 명령을 가려 담당 모듈로 넘긴다.
 *      hwdb start | stop | status   → 데몬 제어 (daemonControl.ts)
 *      hwdb [옵션]                  → SQL 접속 (sqlShell.ts)
 *  - 옵션 해석은 args.ts 에서 하고, 여기서는 해석 결과로 실행한다. (--help, --version 포함)
 *  - 프로세스 종료 코드 결정 : 정상 0, 실패 1, 명령행 오류 1
 *
 * 여기에 두지 않는 것 : 데몬 본체의 구동 절차 (daemon/main.ts)
 *
 * 관련 사양 : AGENTS.md 상세 14
 * 구현 단계 : 1단계에서 `start --foreground` 와 `status` 를 연결했고, 10단계에서 분리 구동·`stop`·SQL 접속을 붙였다.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { RDBMS_VERSION } from "../common/instance.js";
import { parseArguments } from "./args.js";
import { startCommand, statusCommand, stopCommand } from "./daemonControl.js";
import { initLocaleFromEnvironment, t } from "./i18n.js";
import { runSqlCommand } from "./sqlShell.js";

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

/** 인자를 보고 할 일을 정해 실행한 뒤, 프로세스 종료 코드를 돌려준다. */
async function main(argv: readonly string[]): Promise<number> {
  const command = parseArguments(argv);
  switch (command.kind) {
    case "error":
      process.stderr.write(`${command.message}\n${t("args.seeHelp")}\n`);
      return 1;
    case "help":
      process.stdout.write(t("usage.text"));
      return 0;
    case "version":
      process.stdout.write(`${t("version.text", { version: RDBMS_VERSION })}\n`);
      return 0;
    case "status":
      return await statusCommand(findInstallDir());
    case "stop":
      return await stopCommand(findInstallDir(), command.timeoutSeconds);
    case "start":
      return await startCommand({ installDir: findInstallDir(), foreground: command.foreground, timeoutSeconds: command.timeoutSeconds });
    case "sql":
      return await runSqlCommand(command.options, findInstallDir());
  }
}

initLocaleFromEnvironment();
process.exitCode = await main(process.argv.slice(2));
