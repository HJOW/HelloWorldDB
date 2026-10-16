/**
 * 분리된 데몬 프로세스의 진입점. `hwdb start` 가 이 파일을 별도 프로세스로 띄운다.
 *
 * 담당
 *  - 인자로 받은 설치 디렉토리로 데몬 본체(`runForeground`)를 구동한다. 구동이 끝나면 종료 요청이나 종료 신호가 올 때까지 돈다.
 *  - 터미널과 분리되어 있으므로 출력은 모두 로그 파일로 이어진다. `hwdb start` 가 표준 출력과 표준 오류를 로그 파일에 연결해 두었다.
 *    로그는 파일에만 쓰고(`console: false`), 로거가 만들어지기 전의 실패와 처리되지 않은 오류만 표준 오류(곧 로그 파일)에 남는다.
 *  - 터미널을 닫을 때 오는 SIGHUP 은 무시한다. (유닉스 계열. 분리해서 띄우므로 보통 오지 않지만 서비스 관리자 등에서 올 수 있다)
 *  - 종료 코드 : 정상 종료 0, 구동 실패 1.
 *
 * 구동이 끝났는지는 `hwdb start` 가 로컬 전용 채널의 상태 조회(`ready`)로 확인한다. 이 프로세스가 부모에게 따로 알리지 않는다.
 *
 * 관련 사양 : AGENTS.md 상세 14-1
 * 구현 단계 : 10단계
 */

import { exitAfterShutdown, runForeground, wasLogged } from "./main.js";

process.on("SIGHUP", () => {
  // 터미널이 닫혀도 데몬은 계속 돈다.
});

const installDir = process.argv[2];
if (installDir === undefined || installDir === "") {
  process.stderr.write("Usage: entry <install directory>\n");
  process.exitCode = 2;
} else {
  try {
    await runForeground(installDir, { console: false });
  } catch (error) {
    // 로그에 남긴 실패는 다시 적지 않는다. 로그를 열기 전의 실패(설정 오류 등)는 여기서 표준 오류(로그 파일)에 남긴다.
    if (!wasLogged(error)) {
      process.stderr.write(`${new Date().toISOString()} [error] Startup failed: ${error instanceof Error ? error.message : "unknown error."}\n`);
    }
    await exitAfterShutdown(1);
  }
  // 정상 종료 절차를 마쳤다. 접속한 클라이언트가 소켓을 닫지 않아도 프로세스가 남지 않게 직접 끝낸다.
  await exitAfterShutdown(0);
}
