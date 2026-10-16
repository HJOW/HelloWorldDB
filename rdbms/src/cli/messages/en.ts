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
 *  - 대화형 모드의 프롬프트(`hwdb> `). 사양이 정한 고정 문자열이다. (cli/sqlShell.ts)
 *
 * 언어를 추가하려면 같은 키를 가진 카탈로그 파일을 더하고 `i18n.ts` 의 `registerCatalog` 로 등록한다.
 * 빠진 키는 영어로 채워지고, 키와 `{이름}` 이 영어와 맞는지는 `checkCatalog` 로 시험한다.
 *
 * 관련 사양 : AGENTS.md 상세 14
 * 구현 단계 : 9단계 (사용자 결정 2026-10-16 : 지금은 영어만, 다국어는 언제든 붙일 수 있게 준비), 10단계(명령 문구)
 */

export const EN_MESSAGES = {
  "common.yes": "yes",
  "common.no": "no",
  "common.on": "on",
  "common.off": "off",
  "common.none": "(none)",
  "error.unknown": "unknown error.",
  "error.line": "ERROR {text}",
  "error.inputLine": "  at input line {line}, column {column}",

  "usage.text": `Usage:
  hwdb start [--timeout <seconds>] [--foreground]   Start the daemon
  hwdb stop [--timeout <seconds>]                   Stop the daemon
  hwdb status                                       Show the daemon status
  hwdb [options]                                    Open an SQL session

Options for an SQL session:
  -h, --host <host>          Connect over TCP to this host (default: local-only channel)
  -P, --port <port>          Port number of the instance (default: port in config.json)
      --udp                  Use UDP instead of TCP (with --host)
      --ssl                  Use SSL for the TCP connection (with --host)
      --ssl-ca <file>        CA certificate (PEM) to verify the server certificate (with --ssl)
      --ssl-no-verify        Do not verify the server certificate (unsafe, with --ssl)
  -u, --user <name>          User name (default: ask)
  -p, --password <password>  Password (default: ask without echo)
  -t, --tablespace <name>    Initial tablespace (default: the user's default tablespace)
  -e, --execute <sql>        Run the statements and exit
  -f, --file <path>          Run the statements in the file and exit
      --version              Show the version
      --help                 Show this help
`,
  "version.text": "hwdb {version}",

  "args.seeHelp": "Try: hwdb --help",
  "args.unknownOption": "{command}: unknown option \"{option}\"",
  "args.unexpectedArgument": "{command}: unexpected argument \"{argument}\"",
  "args.optionNeedsValue": "hwdb: option {option} needs a value",
  "args.optionTakesNoValue": "hwdb: option {option} takes no value",
  "args.timeoutInvalid": "hwdb: --timeout must be a positive integer (seconds)",
  "args.portInvalid": "hwdb: invalid port number \"{value}\" (1 - 65535)",
  "args.hostEmpty": "hwdb: --host needs a host name or address",
  "args.sslCaEmpty": "hwdb: --ssl-ca needs a file path",
  "args.tablespaceEmpty": "hwdb: --tablespace needs a tablespace name",
  "args.fileEmpty": "hwdb: --file needs a file path",
  "args.needsHost": "hwdb: {option} can be used only with --host",
  "args.needsSsl": "hwdb: {option} can be used only with --ssl",
  "args.udpWithSsl": "hwdb: --udp and --ssl cannot be used together (SSL applies to TCP only)",
  "args.sslOptionWithUdp": "hwdb: {option} cannot be used with --udp (SSL applies to TCP only)",
  "args.sslCaWithNoVerify": "hwdb: --ssl-ca and --ssl-no-verify cannot be used together",
  "args.executeWithFile": "hwdb: --execute and --file cannot be used together",

  "prompt.user": "Username: ",
  "prompt.password": "Password: ",

  "sql.credentialsRequired": "hwdb: standard input is not a terminal, so the user name and password cannot be asked. Give {options}.",
  "sql.userRequired": "hwdb: a user name is required.",
  "sql.passwordCancelled": "hwdb: cancelled.",
  "sql.hiddenInputUnsupported": "hwdb: this terminal cannot hide the typed password. Give the password with -p.",
  "sql.configFailed": "hwdb: {reason}",
  "sql.cannotReadFile": "hwdb: cannot read the file {path}: {reason}",
  "sql.cannotReadInput": "hwdb: cannot read the input: {reason}",
  "sql.cannotReadCa": "hwdb: cannot read the CA certificate {path}: {reason}",
  "sql.daemonNotRunning": "hwdb: cannot connect to the instance on port {port} through the local-only channel. If the daemon is not running, start it with: hwdb start",
  "sql.certRetry": "certificate error ({code}); retrying {attempt}/{max} ...",
  "sql.certHint": "To trust this server, give its CA certificate with --ssl-ca <file>. To skip the certificate check (unsafe), use --ssl-no-verify.",
  "sql.connected": "Connected to {server} as {user}. Current tablespace: {tablespace}.",
  "sql.hint": "Type \"help\" for help and \"exit\" to quit. End each statement with \";\".",
  "sql.help": `Enter SQL statements ending with ";". A statement may span several lines.
  help         Show this help
  exit, quit   Leave hwdb (Ctrl-D also works)
Examples:
  SELECT 'Hello World';
  CREATE TABLE HELLO (MESSAGE VARCHAR);
  INSERT INTO HELLO VALUES ('Hello World');
  SELECT * FROM HELLO;`,
  "sql.inputDiscarded": "Input discarded.",
  "sql.interruptHint": "Type exit or press Ctrl-D to leave hwdb.",
  "sql.rolledBack": "Uncommitted changes were rolled back.",
  "sql.connectionLost": "hwdb: the connection to the server was closed.",

  "result.elapsedMs": "{value} ms",
  "result.elapsedSeconds": "{value} s",
  "result.rowsOne": "1 row ({elapsed})",
  "result.rowsMany": "{count} rows ({elapsed})",
  "result.okNoCount": "{message} ({elapsed})",
  "result.okAffectedOne": "{message} (1 row affected, {elapsed})",
  "result.okAffectedMany": "{message} ({count} rows affected, {elapsed})",

  "start.failed": "hwdb start: {reason}",
  "start.started": "HelloWorldDB started. port: {port}, pid: {pid}",
  "start.alreadyRunning": "HelloWorldDB is already running. port: {port}, pid: {pid}",
  "start.exited": "the daemon exited while starting (exit code {code})",
  "start.exitedSignal": "the daemon was terminated by signal {signal} while starting",
  "start.timeout": "the daemon did not finish starting within {seconds} seconds",
  "start.seeLog": "See the log file: {path}",
  "start.spawnFailed": "cannot start the daemon process: {reason}",
  "start.cannotOpenLog": "cannot open the log file {path}: {reason}",
  "start.lockHeld":
    "the lock file {path} names process {pid}, which is alive but does not answer on the local-only channel. If that process is not a HelloWorldDB daemon, remove the lock file and try again.",
  "start.otherStartFailed": "another hwdb start (process {pid}) was starting the daemon, but it stopped",

  "stop.failed": "hwdb stop: {reason}",
  "stop.notRunning": "HelloWorldDB is not running.",
  "stop.stopped": "HelloWorldDB stopped.",
  "stop.timeout": "the daemon (process {pid}) did not stop within {seconds} seconds",

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
  "status.starting": "state: starting (not accepting connections yet)",
  "status.unresponsive":
    "note: the lock file {path} names process {pid}, which is alive but does not answer on the local-only channel (still starting, stuck, or the PID is used by another program)",

  "warning.initialPassword":
    "The SYSTEM account still uses its initial password. Connect with hwdb on this machine and run: ALTER USER SYSTEM IDENTIFIED BY '<new password>'",
} as const;

/** 메시지 키이다. 영어 카탈로그의 키가 곧 전체 키 목록이다. */
export type MessageKey = keyof typeof EN_MESSAGES;
