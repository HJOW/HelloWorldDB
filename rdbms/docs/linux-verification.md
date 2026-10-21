# Linux 검증 기록 — 2026-10-21

AGENTS.md와 루트·프로젝트별 PROGRESS.md의 미검증 항목을 Debian 13에서 실행했다. 기존 구현의 회귀 검증과 Linux 프로세스·터미널 동작을 대상으로 하며, 새 드라이버 기능 개발이나 릴리스 작업은 포함하지 않는다.

## 환경과 실행

- 장비: `vm-debian-codex`, Debian 13.7 x86_64, 커널 `6.12.113+deb13-amd64`.
- 기본 Node.js `24.16.0`, 추가 Node.js `22.23.3`, TypeScript `6.0.3`, Bun `1.4.0`.
- JDBC: Linux Zulu JDK `6.0.119`, `7.0.352`, `8u504`, `21.0.12.1`과 설치된 OpenJDK `25.0.4.1`. 실제 JDK 6·8의 컴파일러로 각각 빌드했다. Windows의 사용자 지정 Oracle JDK 경로는 변경하지 않았다.
- Python `3.13.5`와 공식 Python `3.2.6` 소스를 임시 디렉토리에서 빌드한 실행 파일을 사용했다. 3.2 빌드는 GCC 14·최신 glibc에 맞추어 `-O0 -fcommon -Wno-error=implicit-function-declaration -Wno-error=incompatible-pointer-types`를 적용하고, 임시 Python 소스의 내부 `sinpi` 이름 충돌을 고쳤다. 드라이버 소스는 변경하지 않았다. `ctypes`·`math`·`socket`·SHA-256을 먼저 확인했다.
- 터미널: Konsole `25.04.2`, Python 표준 `pty`. GUI 검증은 임시 Xvfb 화면에서 실행했다.
- 실행 로그·런타임 경로·SHA-256 확인 기록·소비자 프로젝트·PTY 기록은 `/tmp/hwdb-linux-validation-20261021/`에 있다. 재부팅 등으로 지워질 수 있으므로 이 문서에 결과와 재현 절차를 함께 남긴다.

프로젝트별 의존성을 `npm ci --no-audit --no-fund`로 설치했다. Node.js와 JDK 다운로드는 공급자의 SHA-256과 비교했다. 서버와 JDBC 실행기의 빌드는 같은 `dist`·`build`를 갱신하므로 **빌드가 끝난 다음 시험을 실행**한다. 검증 도중 빌드와 시험이 겹친 실행은 최종 결과에서 제외했다.

```sh
source /tmp/hwdb-linux-validation-20261021/env.sh
cd rdbms
npm test
HWDB_TEST_RUNTIME=/home/hjow/.bun/bin/bun /home/hjow/.bun/bin/bun test --timeout 360000 dist/test
cd ../nodejsDriver
npm test
HWDB_TEST_RUNTIME=/home/hjow/.bun/bin/bun /home/hjow/.bun/bin/bun test --timeout 360000 dist/test
cd ../jdbc6
npm run test:matrix
npm run test:integration
npm run test:extensions
npm run test:consumer
cd ../jdbc8
npm test
npm run test:extensions
npm run test:consumer
cd ../pythonDriver
python3 scripts/run_tests.py --python /tmp/hwdb-linux-validation-20261021/Python-3.2.6/python --python /usr/bin/python3
```

다른 장비에서는 `env.sh` 대신 그 장비의 `HWDB_JAVA6_HOME`, `HWDB_JAVA7_HOME`, `HWDB_JAVA8_HOME`, `HWDB_JAVA21_HOME`, `HWDB_TEST_RUNTIME`, `HWDB_TEST_NODE`, PATH를 지정한다. Bun 실행 경로도 설치 위치에 맞춘다.

## 발견하여 수정한 결함

1. **시작 실패한 인스턴스가 기존 인스턴스의 소켓을 삭제했다.** `LocalChannelServer.closeConnections()`가 자신이 열지 않은 주소도 지웠다. 성공적으로 만든 소켓의 장치·inode를 기억하고 자기 파일에만 정리를 적용한다. 시작 실패뿐 아니라 먼저 닫힌 서버의 정리가 같은 주소를 새로 쓰는 서버의 소켓을 삭제하지 않는지도 시험했다. 기존 중복 인스턴스 시험 두 개가 수정 전 Linux에서 실패하고 수정 후 통과했다.
2. **종료된 좀비 PID 때문에 `hwdb stop`이 시간 초과되었다.** Linux의 `kill(pid, 0)`은 부모가 아직 회수하지 않은 종료 프로세스에도 성공한다. `/proc/<pid>/stat`의 `Z`·`X` 상태를 종료로 판정하며, `/proc` 접근 제한 시에는 기존 존재 판정을 유지한다. 실제 좀비를 만들어 확인했고 foreground 프로세스의 종료 시험도 통과했다.
3. **비밀번호 프롬프트 직후의 빠른 입력이 화면에 보일 수 있었다.** PTY에서 프롬프트를 받자마자 입력해 재현했다. `askSecret()`이 숨김 모드·수신 처리를 먼저 준비한 뒤 프롬프트를 출력하도록 순서를 바꾸었다. 프롬프트 출력과 동시에 입력하는 회귀 시험과 실제 PTY 재시험을 통과했다.

저장 포맷·SQL·통신 규약은 변경하지 않았다. 새 회귀 시험은 유닉스 수명주기 4개, 좀비 1개, 소켓 재사용 1개, 비밀번호 입력 순서 1개로 총 7개이다.

## 서버와 드라이버 결과

| 범위 | 결과 |
|---|---|
| 서버 Node.js 22 전체 | Linux 수정 후 955개 전부 통과, 실패·건너뜀 0. 이후 비밀번호 수정과 새 시험을 포함한 terminal 17개 추가 통과 |
| 서버 Node.js 24 | 최초 전체 949개에서 플랫폼 결함으로 3개 실패. 수정 후 해당 실패를 모두 포함하는 80개와 마지막 terminal 17개 전부 통과 |
| 서버 Bun 단위 | 863개 전부 통과, 실패·건너뜀 0. 마지막 비밀번호 수정 포함 terminal 17개도 통과 |
| 서버 Bun 통합 | 92개 중 91개 통과·TLS 최소 버전 시험 1개 건너뜀·실패 0. 유닉스 수명주기 4개와 SIGINT·SIGTERM 포함 |
| Node.js 드라이버 | Node.js 24·22 각각 전체 116개 통과. Bun 115개 통과·구버전 TLS 1개 건너뜀·실패 0 |
| jdbc6 | 같은 JDK 6 JAR의 Java 6·7·8·21·25 기존 255개·확장 85개·빌드/API 15개·독립 소비자 15개 통과 |
| jdbc8 | 같은 JDK 8 JAR의 Java 8·21 기존 130개·확장 50개·독립 소비자 6개 통과 |
| Python | 3.2.6·3.13.5 각각 전체 124개 통과, 실패·건너뜀 0. 구버전 Linux 단조 시계 분기도 실제 실행 |
| Node.js 배포본 | 임시 소비자에 tgz 설치, 엄격한 TypeScript 6 검사, Node.js 22·Bun 각각 TCP·TLS·UDP, BIGINT·38자리 NUMERIC·마이크로초·이진 값, Node.js CommonJS 소비자 통과 |
| Python 배포본 | sdist·wheel 생성, 깨끗한 3.13 가상 환경에 `--no-index --no-deps`로 wheel 설치, 소스 트리 밖 TCP Hello World 통과 |

TLS 인증서 검증·실패·검증 끄기, Java 6 TLSv1과 상위 JDK TLSv1.2, UDP 유실·중복·지연, 준비 문장·메타데이터·취소·시간 제한·트랜잭션은 기존 드라이버 시험에 포함되어 있다.

## Linux 소켓·신호·터미널

- TCP·UDP를 모두 끄고 umask `000`으로 시작해도 소켓은 `0600`이며 로컬 SQL 접속이 된다. 정상 종료하면 소켓이 없어진다.
- SIGKILL 뒤 남은 소켓은 재구동 때 정리하고 다시 접속할 수 있다. 살아 있는 다른 인스턴스의 주소는 보존한다.
- `/proc`에서 데몬의 세션 ID·프로세스 그룹 ID가 자기 PID이고 제어 터미널 번호가 0임을 확인했다. SIGHUP 뒤에도 같은 PID로 SQL을 실행했다.
- 기존 SIGINT·SIGTERM 시험이 Linux에서 건너뜀 없이 실행되었다. 정상 종료 표시와 재구동 후 경고 없음을 확인했다.
- Konsole의 실제 창 닫기 동작을 D-Bus `org.qtproject.Qt.QWidget.close`로 실행했다. 터미널이 끝난 뒤에도 같은 데몬 PID·세션·프로세스 그룹이 유지되고 새 CLI SQL 접속이 성공했다.
- 실제 PTY에서 사용자명·숨김 암호, 한글·이모지, 여러 줄 문장, 위 화살표 이력, `help`, 문법 오류의 `^`, Ctrl-D와 미커밋 INSERT 롤백을 확인했다. 종료 뒤 별도 접속으로 행 수 0을 확인했다. 기록에는 시험용 암호가 포함될 수 있어 저장소에 넣지 않았다.
- 마지막으로 시험용 연결·데몬·DBeaver·임시 화면을 종료했다. 최초 실패 실행에서 남은 데몬도 정리했으며 `/proc` 조회에서 남은 시험 데몬은 0개였다. 문서 UTF-8 검사와 `git diff --check`도 통과했다. 커밋·푸시는 하지 않았다.

## DB 도구와 추가 확인

### DBeaver 실제 화면

설치된 DBeaver 26.0.5를 별도 임시 작업공간에서 실행하고 jdbc8 배포 JAR을 Generic 드라이버로 등록했다. [DBeaver 공식 명령행 안내](https://dbeaver.com/docs/dbeaver/Command-Line/)의 `-data`·`-con`·`-f`로 시험 연결과 SQL 파일을 열었다. 실제 화면에서 다음을 확인했다.

- HelloWorldDB JDBC 4.2 Driver 0.1.0으로 접속 성공. 테이블스페이스 APP·SYSTEM과 APP의 P·C 테이블이 보인다.
- P의 ID(INTEGER)·V(VARCHAR(20)) 컬럼이 객체 탐색기에 보인다. `SELECT ID, V FROM APP.VP`에서 `[1, 'DBeaver Linux']`가 조회된다.
- 별도 연결의 수동 트랜잭션으로 P의 행을 잠그고, SQL 편집기의 UPDATE가 대기하는 동안 실제 Cancel 버튼을 눌렀다. 같은 편집기에서 SELECT를 다시 실행해 연결 재사용과 원래 값 보존을 확인했다. 요청별 SQLSTATE·시간 제한·권한 조합의 세부 판정은 JDBC 자동 시험 결과를 따른다.
- 접근성을 켠 자동 조작에서 DBeaver의 네이티브 GTK `gtk_widget_is_sensitive` SIGSEGV를 관찰했다. 설치된 데스크톱 실행 파일의 기본값인 `NO_AT_BRIDGE=1`로 다시 실행하여 위 화면 검증을 마쳤다. HelloWorldDB Java 소스를 바꾸지 않았다.

로그와 화면은 임시 로그 디렉토리의 `gui-no-atspi.log`, `dbeaver-navigator.png`, `dbeaver-reuse.png` 등에 있다. 실제 화면 확인으로 jdbc8 13-5의 미완료 항목을 닫았다.

### 대형 복합 질의의 기존 한계

취소 화면을 준비하던 중 2,000행 테이블 세 개의 카티전 곱(논리적으로 80억 행)을 집계하는 인위적인 질의를 실행했다. 전체 입력이 필요한 복합 경로의 중간 결과가 Node.js 힙 한도를 넘어 프로세스가 종료되는 기존 메모리 제한을 재확인했다. 임시 인스턴스를 재시작하고 낮은 메모리 사용량으로 판정할 수 있는 행 잠금 대기로 도구 취소 시험을 완료했다. 이 결과를 단순 지연 조회·파일 커서의 결함이나 완료된 자동 회귀의 실패와 혼동하지 않는다. 중간 결과 메모리 제한·외부 정렬/조인은 별도 확장 과제이다.

### 다른 플랫폼과 후속 기능

macOS, 다른 장비 사이의 실제 원격망, 수 시간 부하는 이번 Linux 검증으로 완료 처리하지 않는다. Windows ODBC는 Windows 전용이며 구현 전 단계이다. GUI 프로젝트의 보류, Python TLS·UDP, Node.js/Python의 새 prepare·cancel 공개 API는 기존 후속 작업으로 유지한다.
