/**
 * 데몬 제어 : `hwdb start`, `hwdb stop`, `hwdb status`.
 *
 * 담당
 *  - start  : 이미 구동 중인지 확인 → 데몬(daemon/main.ts)을 분리된 프로세스로 띄움
 *             → 접속을 받을 수 있게 될 때까지 대기(제한 시간) → 포트 번호와 PID 출력.
 *             `--foreground` 면 분리하지 않고 현재 터미널에서 실행한다.
 *  - stop   : 종료 요청 → 데몬 프로세스가 사라질 때까지 대기 → 결과 출력
 *  - status : 구동 여부, 포트 번호, PID, 구동 시각, 버전, 데이터 디렉토리,
 *             TCP 와 UDP 사용 여부, 세션 수 출력. 구동 중이면 종료 코드 0, 아니면 1
 *  - 제어 요청은 로컬 전용 채널로 보내며, 잠금 파일(daemon/lockFile.ts)의 제어 토큰을 싣는다.
 *
 * 대상은 이 `hwdb` 가 속한 설치 디렉토리의 인스턴스이다. (같은 디렉토리의 config.json)
 * DB 계정 인증은 거치지 않는다.
 *
 * 관련 사양 : AGENTS.md 상세 14-1
 * 구현 단계 : 10단계
 * 1단계에서는 `start --foreground` 와 잠금 파일 기준의 `status` 만 동작한다.
 * 분리된 프로세스로 띄우기와 로컬 전용 채널로의 상태 조회·종료 요청은 10단계에서 붙는다. (서버 쪽은 9단계에서 끝났고, client/connection.ts 의 `control` 을 쓰면 된다)
 */

import { loadConfig } from "../config/config.js";
import { RDBMS_VERSION } from "../common/instance.js";
import { isProcessAlive, readLockFile } from "../daemon/lockFile.js";
import { runForeground } from "../daemon/main.js";
import { t } from "./i18n.js";

export interface StartRequest {
  installDir: string;
  foreground: boolean;
  timeoutSeconds: number;
}

/** `hwdb start` 를 실행한다. 포그라운드 구동은 1단계에서 동작한다. */
export async function startCommand(request: StartRequest): Promise<number> {
  if (request.foreground) {
    try {
      await runForeground(request.installDir);
      return 0;
    } catch (error) {
      process.stderr.write(`${t("start.failed", { reason: describeError(error) })}\n`);
      return 1;
    }
  }
  process.stderr.write(`${t("start.detachNotImplemented")}\n`);
  process.stderr.write(`${t("start.useForeground")}\n`);
  return 1;
}

/** `hwdb stop` 을 실행한다. 로컬 전용 채널의 종료 요청은 10단계에서 붙는다. (서버 쪽은 9단계에서 끝났다) */
export async function stopCommand(_installDir: string, _timeoutSeconds: number): Promise<number> {
  process.stderr.write(`${t("stop.notImplemented")}\n`);
  process.stderr.write(`${t("stop.foregroundHint")}\n`);
  return 1;
}

/**
 * `hwdb status` 를 실행한다.
 * 1단계에서는 잠금 파일과 PID 로 구동 여부만 판단한다. 세션 수는 0으로 보여 준다.
 * 구동 중이면 종료 코드 0, 아니면 1 로 끝난다.
 */
export async function statusCommand(installDir: string): Promise<number> {
  let loaded: Awaited<ReturnType<typeof loadConfigSafe>>;
  loaded = loadConfigSafe(installDir);
  if (loaded.error !== null) {
    process.stderr.write(`${t("status.failed", { reason: loaded.error })}\n`);
    return 1;
  }
  const { config } = loaded;
  const lock = readLockFile(config.dataDir);
  const running = lock !== null && isProcessAlive(lock.pid);

  const yesNo = (value: boolean): string => t(value ? "common.yes" : "common.no");
  const onOff = (value: boolean): string => t(value ? "common.on" : "common.off");
  const lines: string[] = [];
  lines.push(t("status.running", { value: yesNo(running) }));
  lines.push(t("status.port", { value: config.port }));
  if (running && lock !== null) {
    lines.push(t("status.pid", { value: lock.pid }));
    lines.push(t("status.startedAt", { value: lock.startedAt }));
  }
  lines.push(t("status.version", { value: RDBMS_VERSION }));
  lines.push(t("status.dataDir", { value: config.dataDir }));
  lines.push(t("status.tcp", { value: onOff(config.tcp.enabled) }));
  lines.push(t("status.udp", { value: onOff(config.udp.enabled) }));
  lines.push(t("status.sessions", { value: 0 }));
  process.stdout.write(`${lines.join("\n")}\n`);
  return running ? 0 : 1;
}

function loadConfigSafe(installDir: string):
  | { config: ReturnType<typeof loadConfig>["config"]; error: null }
  | { config: null; error: string } {
  try {
    const { config } = loadConfig(installDir);
    return { config, error: null };
  } catch (error) {
    return { config: null, error: describeError(error) };
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return t("error.unknown");
}
