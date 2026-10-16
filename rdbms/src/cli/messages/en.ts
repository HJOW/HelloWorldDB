/**
 * `hwdb` 가 화면에 내는 문구의 영어 카탈로그. 지금 제공하는 유일한 언어이며, 다른 언어 카탈로그의 기준이다.
 *
 * 담당
 *  - `hwdb` 의 사용법, 안내, 표 머리글, 경고, 명령행 오류 문구
 *  - 키는 `영역.이름` 형태이고, 문구 안의 `{이름}` 은 `t(key, { 이름: 값 })` 로 채운다.
 *
 * 여기에 두지 않는 것
 *  - DB 오류 메시지. AGENTS.md 상세 0 에 따라 영문으로 고정이며 SQLSTATE 와 내부 오류 번호가 번역의 열쇠이다. (common/errors.ts)
 *  - 서버 로그. 운영자가 보는 로그도 영문이다.
 *
 * 언어를 추가하려면 같은 키를 가진 카탈로그 파일을 더하고 `i18n.ts` 의 `registerCatalog` 로 등록한다.
 * 빠진 키는 영어로 채워지고, 키와 `{이름}` 이 영어와 맞는지는 `checkCatalog` 로 시험한다.
 *
 * 관련 사양 : AGENTS.md 상세 14
 * 구현 단계 : 9단계 (사용자 결정 2026-10-16 : 지금은 영어만, 다국어는 언제든 붙일 수 있게 준비)
 */

export const EN_MESSAGES = {
  "common.yes": "yes",
  "common.no": "no",
  "common.on": "on",
  "common.off": "off",
  "error.unknown": "unknown error.",

  "usage.text": `Usage:
  hwdb start [--timeout <seconds>] [--foreground]   Start the daemon
  hwdb stop [--timeout <seconds>]                   Stop the daemon
  hwdb status                                       Show the daemon status
  hwdb [options]                                    Open an SQL session

Options for an SQL session:
  -h, --host <host>          Connect over TCP to this host (default: local-only channel)
  -P, --port <port>          Port number of the instance (default: port in config.json)
      --udp                  Use UDP instead of TCP (with --host)
      --ssl                  Use SSL for the TCP connection
  -u, --user <name>          User name (default: ask)
  -p, --password <password>  Password (default: ask without echo)
  -t, --tablespace <name>    Initial tablespace (default: the user's default tablespace)
  -e, --execute <sql>        Run the statement and exit
  -f, --file <path>          Run the statements in the file and exit
      --help                 Show this help
`,

  "args.timeoutNeedsValue": "hwdb: --timeout needs a value in seconds",
  "args.timeoutInvalid": "hwdb: --timeout must be a positive integer (seconds)",
  "args.statusTakesNoArguments": "hwdb status: this command takes no arguments",
  "args.stopUnknownArguments": "hwdb stop: unknown arguments",
  "args.startUnknownArguments": "hwdb start: unknown arguments",
  "session.notImplemented": "hwdb: SQL session is not implemented yet",

  "start.failed": "hwdb start: {reason}",
  "start.detachNotImplemented": "hwdb start: running as a detached daemon is not implemented yet (step 10)",
  "start.useForeground": "Use `hwdb start --foreground` for now.",
  "stop.notImplemented": "hwdb stop: not implemented yet (step 10)",
  "stop.foregroundHint": "If the daemon runs with --foreground, stop it with Ctrl+C.",

  "status.failed": "hwdb status: {reason}",
  "status.running": "running: {value}",
  "status.port": "port: {value}",
  "status.pid": "pid: {value}",
  "status.startedAt": "startedAt: {value}",
  "status.version": "version: {value}",
  "status.dataDir": "dataDir: {value}",
  "status.tcp": "tcp: {value}",
  "status.udp": "udp: {value}",
  "status.sessions": "sessions: {value}",

  "warning.initialPassword":
    "The SYSTEM account still uses its initial password. Connect with hwdb on this machine and run: ALTER USER SYSTEM IDENTIFIED BY '<new password>'",
} as const;

/** 메시지 키이다. 영어 카탈로그의 키가 곧 전체 키 목록이다. */
export type MessageKey = keyof typeof EN_MESSAGES;
