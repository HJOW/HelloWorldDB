# HelloWorldDB 전체 진행 상황

프로젝트 전체에 걸친 진행 상황과 공통 인수인계 사항을 적는다.
사양과 구현 계획은 AGENTS.md 가 기준이고, 프로젝트별 세부 계획과 진행 상황은 각 디렉토리의 PROGRESS.md 에 있다.

## 현재 상태

- 최종 갱신 : 2026-10-22
- **2026-10-22 : `unixodbc` 프로젝트 환경 구축·개발 계획 작성.** Debian 13.7에서 unixODBC 2.3.12 헤더·라이브러리를 `.deps/`에 두고 CMake·CTest(dev/release/asan) 기반과 `libhwdbodbc.so.0` 골격, ABI·환경·문서 계약·실제 서버 연기 시험을 만들었다. 세 프리셋 각 4개, 합계 12개 시험이 통과했다(실패·건너뜀 0). ODBC 함수는 아직 구현하지 않았고 UO-1의 나머지가 다음 작업이다. 계획·계약은 [unixodbc/PROGRESS.md](unixodbc/PROGRESS.md)와 `unixodbc/docs/`에 있다. 커밋·푸시는 하지 않았다.
- **2026-10-22 : 점검 취약점 수정 완료.** `rdbms` R-1 ~ R-6, `nodejsDriver` N-1 ~ N-5(와 P-6 의 Node 쪽 빈 묶음 검사), `pythonDriver` P-1 ~ P-6, `jdbc6`·`jdbc8` J-1 ~ J-6을 고치고 회귀 시험을 더했다. 사양은 AGENTS.md 상세 1-3(DEFAULT 상수 식, 테이블 이름 변경과 뷰)만 보충했다. 검증 : rdbms Node.js 24.22.0 `npm test` 963개 중 956 통과·실패 0·건너뜀 7(Windows 플랫폼 전용). nodejsDriver Node.js 24.22.0 125개 통과. pythonDriver Python 3.2·3.12.4 각 137개 통과(실제 데몬 시험 포함). jdbc8 Java 8·21 `test.mjs` 160개 통과. jdbc6 Java 6·7·8·21 실제 서버 224개, 확장 68개, 독립 소비자 12개 통과. 미결 : jdbc8·jdbc6 의 손실 UDP 시험에서 `UDP peer reset the session` 이 간헐적으로 났다(전체 행렬 3회 중 2회, 수정 전 기준선 1회 통과). 격리 재실행은 모두 통과했고 원인은 확정하지 못했다. 커밋·푸시는 하지 않았다.
- **2026-10-22 : rdbms·nodejsDriver·pythonDriver·jdbc6·jdbc8 코드 점검.** 기존 시험 기준선(rdbms 956개, nodejsDriver 116개, pythonDriver 124개)은 모두 통과했지만, 기존 시험이 다루지 않는 권한·DML·의존성·드라이버 상태 경로에서 결함을 재현했다. rdbms의 뷰 DML 조건 무시, DEFAULT 서브쿼리 권한 우회, 테이블 이름 변경 뒤 뷰 의존성, `ADD COLUMN REFERENCES` 검사 누락, nodejsDriver의 풀 트랜잭션 상태 누수, pythonDriver의 RST 예외·이전 결과 잔존·커서 누적, jdbc6/jdbc8의 `setNull(int, SQLType)`·문자 컬럼 `getBytes` 결함을 각 프로젝트 PROGRESS.md의 "다음 작업: 2026-10-22 점검 취약점 수정"에 기록했다. winodbc는 완료 프로젝트가 아니므로 제외했다. 소스는 아직 수정하지 않았고 커밋·푸시도 하지 않았다.
- **jdbc8 13-5 범용 도구 확인도 완료했다.** Linux DBeaver 26.0.5의 별도 작업공간에 배포 JAR을 등록해 접속·객체와 컬럼 탐색·뷰 조회·잠금 대기 취소·같은 편집기의 연결 재사용을 확인했다. [Linux 검증 기록](rdbms/docs/linux-verification.md)에 실제 화면 검증과 GTK 자동 조작의 한계, 대형 조인 중간 결과의 기존 메모리 한계를 함께 기록했다.
- **2026-10-21 : Linux 검증과 플랫폼 결함 수정.** Debian 13.7에서 서버·Node.js/Python·JDBC와 배포 소비자를 검증했다. 서버의 다른 인스턴스 소켓 삭제, Linux 좀비 PID로 인한 stop 시간 초과, 비밀번호 프롬프트 직후 입력의 되울림을 수정하고 회귀 시험 7개를 추가했다. Node.js 22 서버 전체 955개와 마지막 비밀번호 수정 포함 terminal 17개, Node.js 22·24 드라이버 각 116개, Python 3.2·3.13 각 124개가 통과했다. jdbc6의 Java 6·7·8·21·25 기존 255개·확장 85개·빌드 15개·소비자 15개, jdbc8의 Java 8·21 기존 130개·확장 50개·소비자 6개가 통과했다. 유닉스 소켓 0600·정리, SIGHUP·SIGINT·SIGTERM, 세션 분리, Konsole 창 닫기 뒤 데몬 유지와 실제 PTY 입력을 확인했다. 세부 환경·명령·한계는 [Linux 검증 기록](rdbms/docs/linux-verification.md)을 따른다. 커밋·푸시는 하지 않았다.
- **2026-10-20 : jdbc8 서버 확장 연동·자동 최종 검증 완료.** 지정한 `C:\Program Files\Java\jdk1.8.0_202`의 java·javac를 확인하고 기본 빌드 경로로 적용했다. JDBC4.2에 서버 준비 문장·실행 전 컬럼/파라미터 메타데이터·UNKNOWN/SQLType/java.time 힌트·취소·시간 제한·실행 중 close를 연동했다. 같은 JAR의 Java 8u202·21 기존 130개·확장 50개·독립 소비자 6개가 Node.js 22 서버에서 통과했다. JDBC6의 Java 8 기본 후보도 같은 경로로 바꾸고 행렬 15개를 통과했다. 13-5의 자동 검증은 완료했으며 DBeaver 등 범용 도구의 실제 등록·화면 검증은 남아 있다. [jdbc8/PROGRESS.md](jdbc8/PROGRESS.md), [README](jdbc8/README.md)를 따른다.
- **2026-10-20 : rdbms 후속 구현·검증 완료.** prepare/describe·cancel·협력 실행·파일 커서·뷰 컬럼·인덱스 이름 생략을 검토하고 IN/BETWEEN/CASE/서브쿼리 분석, 선언 타입 NULL, 결과 파일 정리·부분 쓰기를 수정했다. TypeScript 6.0.3 / Node.js 22.23.3 전체 **949개 중 948개 통과·Windows SIGTERM 1개 건너뜀·실패 0**. Bun 주요 167개와 마지막 NULL 수정을 포함한 핵심 42개도 통과했다. 규약·매뉴얼·진행 기록을 갱신했고 [rdbms/HANDOFF.md](rdbms/HANDOFF.md)에 최종 결과와 남은 범위를 정리했다.
- **2026-10-20 : jdbc6 서버 확장 연동과 14-5 검증 완료.** 지정한 `C:\Program Files\Java\jdk1.6.0_45`로 빌드하고 `C:\Program Files\Java\jdk1.7.0_80`을 포함한 Java 6·7·8·21·25에서 같은 JAR을 실행했다. 실행 전 결과·파라미터 메타데이터, UNKNOWN·힌트, 서버 준비 문장, 요청별 취소·시간 제한·실행 중 close를 구현했다. 기존 서버 255개·확장 85개·빌드 15개·독립 소비자 15개가 통과했다. 공유 코드를 동기화한 jdbc8 기존 130개, Node.js 드라이버 116개, Python 3.2·3.13.1 각각 124개도 통과했다. 나머지 드라이버의 새 공개 API와 ODBC 시험은 후속이다.
- **2026-10-20 : Windows ODBC 개발 계획 작성.** [winodbc/PROGRESS.md](winodbc/PROGRESS.md)에 WO-0 ~ WO-13의 구현 순서·필수 시험·완료 기준과 ODBC 3.8/Unicode/descriptor·배열·취소·x86/x64 설치 계획을 적었다. 사용자 추가 요청으로 서버의 prepare/describe·cancel은 [rdbms/PREPARE.md](rdbms/PREPARE.md)의 PD-1 ~ PD-6과 rdbms 진행 문서의 다음 작업에 등록했다. 이 항목은 계획 작성 당시의 기록이다. 이후 서버 구현·검증은 완료했고 ODBC 드라이버 구현·등록·적합성 시험은 미착수이다.
- **2026-10-20 : `jdbc8` 13-1 ~ 13-4, `jdbc6` 14-1 ~ 14-4 완료.** 사용자 추가 지시에 따라 두 드라이버를 구현했다. Java 6 범위의 JSON·TCP·TLS·UDP·SCRAM 프로토콜을 공유하고 JDBC 4.0/4.2 계층·타입·트랜잭션·메타데이터를 각각 제공한다. jdbc8은 실제 JDK 8로 빌드한 같은 JAR의 Java 8·21 시험 **130개**, jdbc6는 실제 JDK 6 JAR의 Java 6·7·8·21 실제 서버 시험 **200개**와 빌드 회귀 **14개**가 통과했다(실패·건너뜀 0). TLS 인증서 검증과 Java 6 TLSv1, 나머지 기본 TLSv1.2 접속, 유실·중복·지연 UDP, 권한·타입·커서·오류를 확인했다. 시험 서버는 정상 종료·정리했고 서버 소스는 바꾸지 않았다. 다음은 13-5·14-5 최종 검증이다. 상세는 [jdbc8/PROGRESS.md](jdbc8/PROGRESS.md), [jdbc6/PROGRESS.md](jdbc6/PROGRESS.md), 사용법은 각 README에 있다. GUI 보류는 유지한다.
- **2026-10-20 : `nodejsDriver`의 Node.js 22.x 후속 검증 완료.** `VM-W11-Codex`의 Node.js 22.23.3 / TypeScript 6.0.3에서 드라이버와 실제 서버를 모두 실행하여 전체 116개 시험이 통과했다(실패·건너뜀 0). 배포본을 새 소비자 프로젝트에 설치해 Node.js 22.23.3·Bun 1.4.2 각각의 TCP·TLS·UDP 접속, 엄격한 타입 검사, Node.js의 CommonJS `require(esm)` 접속을 확인했다. 호환성 결함은 발견되지 않아 소스 수정은 없으며 README와 진행 문서를 갱신했다. 서버 전체의 독립 Node.js 22 시험과 다른 OS 검증은 이번 범위에 포함하지 않았다. 상세는 [nodejsDriver/PROGRESS.md](nodejsDriver/PROGRESS.md)의 "Node.js 22 호환성 및 배포본 검증"이다.
- **2026-10-20 : `pythonDriver` PY-3 완료.** DB-API 2.0 계층(`types`, `cursor`, `connection`, 모듈 수준)을 구현하고 시험 47개를 더했다. 타입 변환·생성자·타입 객체, `connect()` 옵션 검증, Hello World, 자동 커밋 OFF·커밋·롤백·컨텍스트 관리자, fetch·반복·`executemany`·`description`·`rowcount`, 타입 왕복, 스레드 공유 접속을 실제 `rdbms` 로 확인했다. Windows / Node.js 24.19.0 / Python 3.2·3.12.4에서 각각 124개 통과·실패와 건너뜀 0이다. 시험 중 Param 이중 인코딩 결함과 3.2의 `utcoffset()` 검증을 찾아 고쳤고, 미결 9(`float` 정수값 처리)는 서버 동작 확인으로 닫았다. TLS·UDP는 `NotSupportedError` 이며 다음은 PY-4이다. 자세한 내용은 [pythonDriver/PROGRESS.md](pythonDriver/PROGRESS.md)에 있다.
- **2026-10-20 : `pythonDriver` PY-1 완료.** 사용자 작업 지시에 따라 `rdbms`·`nodejsDriver` 다음에 착수하고 기존 설계 기본안의 배포 이름(`org.duckdns.hjow.helloworlddb.pythondriver`)과 import 이름(`helloworlddb`)을 적용했다. 패키지 구성, Python 3.2 호환 계층, 버전별 시험 실행기, 소스 호환성 검사, 임시 `hwdb start`/`stop` 도우미를 구현했다. Windows의 Python 3.2·3.12.4에서 각각 34개 통과·실패와 건너뜀 0이다. 소스 배포본과 `py3-none-any` 휠도 생성했다. Python 드라이버의 실제 접속·DB-API는 아직 미구현이며 다음 단계는 PY-2(TCP 프로토콜 코어)이다. 자세한 내용은 [pythonDriver/PROGRESS.md](pythonDriver/PROGRESS.md)에 있다.
- **2026-10-20 : `nodejsDriver` 점검·수정을 완료했다.** 풀 생성 중 종료·시간 초과의 대기 요청 누락, 주석으로 인한 트랜잭션 상태 오류와 미커밋 행 재사용, 남은 커서·테이블스페이스·타임존 초기화 누락, 특수 컬럼 이름의 결과 변환, 인증 제한 시간·응답 검증·소켓 조기 종료·시험 서버 정리를 보완했다. 회귀 시험 16개를 추가해 Node.js 24.22.0 / TypeScript 6.0.3에서 전체 116개 통과·실패 0이다. Bun 1.3.14는 최종 시나리오 115개 통과·1개 건너뜀(기존 구버전 TLS)·실패 0. 상세는 [nodejsDriver/PROGRESS.md](nodejsDriver/PROGRESS.md)의 "코드 점검 및 수정"이며 README도 갱신했다. 서버 소스·사양·통신 메시지 형식은 바꾸지 않았다.
- 이번 `rdbms` 검증 : Windows, Node.js 24.22.0 / TypeScript 6.0.3의 전체 시험은 **906개 중 905개 통과·1개 건너뜀(SIGTERM)·실패 0**. Bun 1.3.14 관련 시험 241개와 실제 데몬 정리 회귀 시험 1개도 모두 통과했다. Bun 전체 시험과 다른 OS·Node.js 22.x 검증은 이번에 하지 않았다.
- **2026-10-20 : `rdbms` 점검 사항 P-1 ~ P-4와 추가 결함 P-5 ~ P-7를 수정했다.** 카탈로그·사용자·권한 그룹의 이름 맵과 테이블스페이스 레지스트리를 프로토타입 없는 맵으로 통일해 인증 오류, 객체 존재 판정 오류, `"__proto__"` 테이블스페이스의 재구동 후 누락, 잘못된 ALTER USER를 바로잡았다. 추가로 한정 이름 충돌로 인한 트랜잭션 혼선·뷰 권한 부여 검사 누락·잠금 범위 충돌과 손상된 카탈로그의 파일 핸들 누수를 재현하고 수정했다. 시험 데몬 정리에서 종료 요청이 생략되는 경우도 고쳤고 회귀 시험은 총 17개를 추가했다. 상세 재현과 조치는 [rdbms/PROGRESS.md](rdbms/PROGRESS.md)의 "점검 작업 사항"에 있다. 사양과 통신 프로토콜, 저장 파일 포맷은 바꾸지 않았다.
- **2026-10-17 : `nodejsDriver` 12단계를 완료했다.** TCP(SSL)·UDP 접속, SCRAM 인증, 문장 실행과 파라미터, 결과 나누어 받기(`cursor`, `stream`), 트랜잭션 API, 커넥션 풀, 타입 대응, 오류 객체, 타입 정의, README. 시험 100개(단위 25, 실제 `rdbms` 를 띄우는 통합 75)가 Node.js 24.21.0 에서 통과하고 bun 1.3.14 에서도 같다. 세부는 [nodejsDriver/PROGRESS.md](nodejsDriver/PROGRESS.md)이고 사용법은 [nodejsDriver/README.md](nodejsDriver/README.md)이다.
  이 과정에서 **`rdbms` 의 결함 하나를 찾아 고쳤다**(문자열 파라미터의 `CAST(? AS INTEGER)` 가 내부 오류 `XX000`, 회귀 시험 추가). 또 `rdbms` 통합 시험 도우미가 **bun 에서 데몬을 남기던 문제**(정리 훅 순서에 기대던 정리)를 재현하고 고쳤으며, 단위 시험이 쌓던 임시 디렉토리도 정리하게 했다. 사양(AGENTS.md)은 바꾸지 않았다.
  전체 시험을 다시 돌렸다 : `rdbms` Node.js `npm test` 889개 중 888 통과·1 건너뜀(Windows 의 SIGTERM)·실패 0, bun 1.3.14 통합 85 통과·2 건너뜀, bun 단위 801개 중 799 통과·2 실패(bun 1.3.14 가 `t.mock` 을 구현하지 않아서. 제품 결함 아님).
- 사양(AGENTS.md 의 개요와 상세)과 구현 계획을 세웠다.
- `rdbms` 는 1 ~ 11단계를 마쳤다. 11단계(통합 검증)에서 개요 1 ~ 15 항목마다 실제 데몬에 접속하는 시험을 갖추고(87개), 사용 설명서 [rdbms/docs/manual.md](rdbms/docs/manual.md)와 검증 기록 [rdbms/docs/verification.md](rdbms/docs/verification.md)를 썼다. 이 과정에서 제품 결함 넷(NULL 리터럴 타입, 데이터 파일 절대 경로, 행 삽입 비용, 인덱스 범위 조건의 틀린 결과)을 찾아 고쳤다.
  구현 범위는 다음과 같다. Hello World 샘플을 포함한 CRUD와 내장 함수, 파라미터, 규칙 기반 인덱스, 트랜잭션(커밋·롤백·세이브포인트, 행 잠금, 교착 감지), 사용자 계정(SCRAM-SHA-256 검증 정보), 권한과 권한 그룹, 문장별 권한 검사, **로컬 전용 채널, TCP(TLS 포함), UDP(신뢰성 계층 포함)** 접속과 접속용 클라이언트 라이브러리(`rdbms/src/client`)에 더해,
  10단계에서 **`hwdb` 명령**을 완성했다 : `hwdb start`(분리된 데몬), `hwdb stop`, `hwdb status`, 그리고 SQL 접속(대화형·스크립트 모드, 로컬 전용 채널·TCP·SSL·UDP, 화면에 보이지 않는 비밀번호 입력, 한글 폭을 맞춘 표 출력, 초기 암호 변경 안내, 종료 때 롤백 안내). 동작은 [rdbms/docs/cli.md](rdbms/docs/cli.md)에 있다.
- 이번 `rdbms`·`jdbc6` 및 추가 `jdbc8` 서버 확장 연동·자동 검증을 완료했다. GUI DB툴(`gui`)의 보류는 유지한다. 아래 이전 날짜의 구현·검증 내용은 누적 기록이며 최신 결과는 위 두 항목과 프로젝트별 상태표를 따른다.
- 다음 작업 : 2026-10-22 점검의 취약점 수정은 끝났다(각 프로젝트 PROGRESS.md 의 "2026-10-22 점검 취약점 수정 (완료)"). 그 뒤는 나머지 드라이버의 prepare/describe·cancel 공개 API, `pythonDriver` PY-4(TLS), `unixodbc` UO-1 이후 구현, winodbc WO-9 이후 구현이다. 미결은 위 손실 UDP 간헐 실패 조사다. 각 프로젝트의 PROGRESS.md 와 [통신 규약](rdbms/docs/protocol.md)을 따른다.
- 11단계 검증 : Windows의 Node.js 24.21.0 / TypeScript 6.0.3에서 `npm test` 888개 중 887개 통과, 1개 건너뜀(Windows에서 SIGTERM을 받을 수 없는 유닉스 전용 시험), 실패 0. bun 1.3.14에서는 통합 시험 87개를 시험 러너와 데몬 모두 bun으로 돌려 85개 통과, 2개 건너뜀(bun의 TLS 최소 버전 제약, SIGTERM)이다. 결함을 일부러 주입한 빌드에서 새 시험이 실패하는지 확인했다(모두 잡힘).
  당시 미확인 항목 중 Node.js 22, 실제 Java 6 TLSv1, 뷰 컬럼·인덱스 이름 생략은 이번 후속 작업에서 해소했다. 리눅스·macOS와 실제 터미널 앱의 탭 닫기는 미검증이다.
- 2026-10-16 : 사용자 결정 3건을 반영하고 9단계(통신)를 완료했다. 프로토콜 명세, 세 접속 경로, 클라이언트, 정상 종료 순서와 제어 요청. 세부는 [rdbms/PROGRESS.md](rdbms/PROGRESS.md).
- 2026-10-15 : 7단계 남은 마무리(`SYS_SESSIONS` 연결, `docs/transactions.md`)를 끝내고 8단계를 완료했다.
- 6단계 점검 보완(2026-10-10)에서 결함 7건을 고쳤다. 7단계에서 `BEGIN`·`ROLLBACK` 등을 막아 둔 `0A000` 을 풀었다. DML의 행 단위 접근은 당시 미구현이었고 2026-10-16에 완료했다.
- 2026-10-11 병합 점검 : 원격 커밋과 병합하면서 `session.ts`, `dml.ts` 에 충돌 마커가 커밋되어 빌드가 깨져 있었다. 7단계 쪽을 기준으로 정리했고, 병합 중 빠진 6단계 점검 보완 기록을 `rdbms/PROGRESS.md` 에 다시 넣었다.
- 10단계 검증 : Windows의 Node.js 24.21.0 / TypeScript 6.0.3에서 `npm test` 789개 통과(10단계 신규 131개). bun 1.3.14에서 CLI 시험 138개, net·daemon 시험 249개 통과. 결함 주입 15건을 시험이 모두 잡았다. 분리 구동(콘솔 창 없음, 콘솔 프로세스를 끝내도 데몬 유지)과 실제 Windows 콘솔의 대화형 모드를 확인했다. 리눅스·macOS와 실제 터미널 앱의 탭 닫기는 확인하지 못했다.
- 이전 검증 : Windows의 Node.js 24.19.0 / TypeScript 6.0.3에서 `npm test` 658개 통과(행 단위 접근 2부 신규 16개 포함). Bun 1.4.2도 658개 검증 완료(전체 실행 657개 통과 + 2만 행 시험 1개 별도 통과). 대량 시험은 준비 시간을 포함해 최초 120초 제한을 넘었으며, 360초 제한으로 재실행해 약 221초에 통과했다. 이전 통신 결함 22건과 읽기 계층 결함 8건의 주입 검증 기록은 유지한다.

## 프로젝트별 상태

단계 번호는 AGENTS.md "구현 계획"의 번호이다. Python 드라이버는 D절의 PY-1 ~ PY-6을 사용한다.

| 프로젝트 | 패키지명 | 단계 | 상태 | 착수 조건 | 세부 계획 |
|---|---|---|---|---|---|
| `rdbms` | `org.duckdns.hjow.helloworlddb.rdbms` | 1 ~ 11, PD | 기본 단계·PD-1 ~ PD-5 완료. PD-6 ODBC 시험 후속 | 없음 | [rdbms/PROGRESS.md](rdbms/PROGRESS.md) |
| `nodejsDriver` | `org.duckdns.hjow.helloworlddb.nodejsdriver` | 12 | 12단계 완료 (TCP·SSL·UDP, 트랜잭션, 커넥션 풀, 타입 정의, README) | 11단계 완료 (충족) | [nodejsDriver/PROGRESS.md](nodejsDriver/PROGRESS.md) |
| `pythonDriver` | `org.duckdns.hjow.helloworlddb.pythondriver` (import `helloworlddb`) | PY-1 ~ PY-6 | PY-3 완료. 최신 회귀 Python 3.2·3.13.1 각 124개 통과. TLS·UDP는 PY-4·PY-5 | `rdbms`·`nodejsDriver` 완료, 사용자 작업 지시 (충족) | [pythonDriver/PROGRESS.md](pythonDriver/PROGRESS.md) |
| `jdbc8` | `org.duckdns.hjow.helloworlddb.jdbc8` | 13-1 ~ 13-5 | 13-1 ~ 13-5·새 API 완료. 기존 130·확장 50·소비자 6개 및 Linux DBeaver 확인 통과 | 선행 조건 충족 | [jdbc8/PROGRESS.md](jdbc8/PROGRESS.md) |
| `jdbc6` | `org.duckdns.hjow.helloworlddb.jdbc6` | 14-1 ~ 14-5 | 14-1 ~ 14-5·prepare/describe·cancel 완료. Java 6·7·8·21·25 검증 | `rdbms`·`nodejsDriver` 완료, 사용자 작업 지시 (충족) | [jdbc6/PROGRESS.md](jdbc6/PROGRESS.md) |
| `unixodbc` | C++ (패키지명 규칙 대상 아님) | UO-0 ~ UO-13 | UO-0 완료, UO-1 빌드 골격. ODBC 함수 미구현 | 사용자 작업 지시 (환경·계획까지) | [unixodbc/PROGRESS.md](unixodbc/PROGRESS.md) |
| `winodbc` | C++ (패키지명 규칙 대상 아님) | WO-0 ~ WO-13 | WO-8까지 구현, WO-9 이후 일시 중지 | 사용자 재개 지시 | [winodbc/PROGRESS.md](winodbc/PROGRESS.md) |
| `gui` | `org.duckdns.hjow.helloworlddb.gui` | 없음 | 보류 | 계획부터 다시 정한다 | [gui/PROGRESS.md](gui/PROGRESS.md) |

## 공통 인수인계 사항

- 보류한 프로젝트의 PROGRESS.md 에는 보류 전에 잡아 둔 세부 계획이 초안으로 남아 있다. 확정된 계획이 아니므로 그대로 착수하지 않는다.
- JDBC 기준(2026-10-16 사용자 결정) : 자바 5 지원을 철회했다. 프로젝트·폴더·패키지는 `jdbc6` 기준으로 바꾸고 자바 6~7용 JDBC 4.0을 개발한다. 같은 배포본을 자바 8 이상에서도 사용할 수 있어야 한다. `jdbc8`은 자바 8 이상용 JDBC 4.2이다. 두 프로젝트의 공통 프로토콜 코드는 자바 6 범위로 유지한다. 사양은 AGENTS.md 상세 8-1이다.
- RDBMS 사양 중 보류한 프로젝트를 위한 부분(TLS 1.2를 쓸 수 없는 자바 6 환경용 TLS 최소 버전 설정, 메타데이터 조회용 딕셔너리 뷰)은 `rdbms`에서 그대로 구현한다.
- 프로토콜 명세는 [rdbms/docs/protocol.md](rdbms/docs/protocol.md)에 확정되어 있다(2026-10-16, 버전 1). 모든 드라이버가 이 문서를 기준으로 삼는다. 클라이언트가 해야 하는 검증(서버 nonce·서명 확인, TLS 인증서 검증과 재시도 등)은 그 문서 15절의 체크리스트이다.
  기존 필수 규약과 호환되지 않는 변경은 프로토콜 버전을 올리고 드라이버 진행 기록에 알린다. 이번 선택 확장은 버전 1을 유지하고 helloOk.capabilities의 prepareDescribe·cancel로 협상한다. 전체 호환 표는 protocol.md 17절이다.
- 11단계에서 서버 동작에 바뀐 것(드라이버가 알아 둘 점) : (1) 데이터 파일 경로를 데이터 디렉토리 기준 상대 경로로 기록하므로 데이터 디렉토리를 복사해 다른 위치·포트의 인스턴스로 옮길 수 있다. (2) 인덱스를 쓰는 범위 조건의 결과가 바로잡혔다(DESC 컬럼, 컬럼이 더 있는 복합 인덱스). (3) 타입이 정해지지 않은 `NULL` 이 상대 타입을 따른다(`NVL(NULL, x)`, `1 + NULL` 등). 프로토콜은 바뀌지 않았다.
  서버를 띄우고 접속하는 사용자 관점의 설명은 [rdbms/docs/manual.md](rdbms/docs/manual.md), 통합 시험의 구성과 한계는 [rdbms/docs/verification.md](rdbms/docs/verification.md)이다. 모든 키를 기본값으로 적은 설정 예시는 `rdbms/config.sample.json`이다.
- 명령은 `hwdb` 하나이다. `hwdb start`, `hwdb stop`, `hwdb status` 로 데몬을 제어하고, `hwdb` 로 SQL 접속을 한다. 서버 실행 파일을 따로 두지 않는다. (10단계에서 구현을 마쳤다. [rdbms/docs/cli.md](rdbms/docs/cli.md))
- 10단계에서 프로토콜·클라이언트에 더한 것(드라이버가 알아 둘 점) : (1) `close` 의 응답 `bye` 에 선택 필드 `rolledBack: true`(세션을 닫으며 커밋하지 않은 변경을 롤백했을 때만)가 생겼다. 프로토콜 버전은 올리지 않았다. `Connection.close()` 는 `{ rolledBack }` 을 돌려준다.
  (2) `authStart.tablespace` 는 저장된 이름 그대로를 받는다. 서버는 대문자로 바꾸는 등의 처리를 하지 않으므로 사용자 입력을 받는 쪽(`hwdb -t` 는 따옴표 없으면 대문자, 큰따옴표면 그대로)이 식별자 규칙으로 바꿔 보내야 한다. (3) 데몬이 구동 중인지는 잠금 파일의 PID 가 아니라 로컬 전용 채널의 `status` 응답으로 판단한다(PID 재사용 대비).
- 인스턴스는 포트 번호로 구분한다. SID 나 DB 이름은 없으며, TCP 와 UDP 가 같은 포트 번호를 쓴다.
- `rdbms` 의 CLI 는 `nodejsDriver` 보다 먼저 만들어지므로 자체 클라이언트 코드(`rdbms/src/client`: `Connection`, 전송 계층 로컬·TCP·TLS·UDP)를 가진다. `nodejsDriver` 는 그 코드를 출발점으로 삼을 수 있다.
- 타입스크립트 코드는 타입스크립트 6 에서 컴파일되어야 한다 (AGENTS.md 지켜야 할 사항 7). 그래서 `rdbms` 의 개발 의존성은 타입스크립트 6 으로 묶어 두었다. 7 로 올리지 않는다.
- SYSTEM 계정은 CONNECT 없이 만들어지므로 처음에는 로컬에서만 접속된다. 설치 후 관리자가 서버 장비에서 `hwdb` 로 접속해 초기 암호를 바꾸는 것이 표준 절차이다.
- 저장 포맷과 트랜잭션 설계는 [rdbms/docs/storage-v1.md](rdbms/docs/storage-v1.md)에 있다. 저장 API는 `storage/format/format.ts`만 통해 사용한다. SQL 카탈로그와 데몬 연결은 5단계에서 마쳤고, SQL 트랜잭션과 행 잠금은 7단계에서 구현했다(설계 요약은 [rdbms/PROGRESS.md](rdbms/PROGRESS.md)의 결정 사항).
- v1 고정 바이너리(`rdbms/test/fixtures/storage-v1.hwdb`)와 서버 전체의 데이터 디렉토리 자료(`datadir-v1/`, 11단계)를 해시 검증 테스트와 함께 보관했다. 포맷 버전을 올리면 이전 버전 자료가 없을 때 시험이 실패한다(버전 보호). 개요 3의 1.0 출시 전 포맷 변경 예외는 적용 가능하며, 변경 시 포맷 문서와 테스트 자료도 의도적으로 갱신한다.
- 변경된 타입 정책은 [rdbms/docs/data-types.md](rdbms/docs/data-types.md)에 정리했다. VARCHAR/NVARCHAR의 최대·기본 길이는 65,535이며 DECIMAL/DEC/NUMERIC의 인자 전체 생략은 (10,3), 정밀도만 지정한 `(p)`는 (p,0)이다. 드라이버와 DB툴은 실제 컬럼 인자를 서버 메타데이터에서 읽는다.
- 저장 엔진의 저장/재열기, 인덱스, 롤백, v1 자료 읽기와 포그라운드 종료는 앞선 단계에서 Node.js와 bun으로 확인했다. 기존 검증 환경은 Windows, Node.js 24.19.0, TypeScript 6.0.3, Bun 1.4.2이다. `nodejsDriver`는 2026-10-20 Node.js 22.23.3에서 전체 116개 시험과 배포본 검증을 마쳤다(서버도 Node.js 22로 구동). `rdbms`도 이번 Node.js 22.23.3 전체 949개 중 948개 통과·SIGTERM 1개 건너뜀으로 검증했다.
- 드라이버와 DB툴이 참고할 `rdbms` 문서이다. 타입과 값의 규칙은 [rdbms/docs/data-types.md](rdbms/docs/data-types.md), SQL 의 어휘 규칙·예약어·지원 문법·한도는 [rdbms/docs/sql-syntax.md](rdbms/docs/sql-syntax.md), 저장 포맷은 [rdbms/docs/storage-v1.md](rdbms/docs/storage-v1.md),
  트랜잭션과 잠금의 동작(오류 번호 `55P03`, `40P01` 등)은 [rdbms/docs/transactions.md](rdbms/docs/transactions.md), 계정·권한·오류 번호 `28000`·`42501` 등과 딕셔너리 뷰의 가시성은 [rdbms/docs/accounts-and-privileges.md](rdbms/docs/accounts-and-privileges.md), 프로토콜(전송 계층, 메시지, SCRAM, 값 표현, 커서, 오류 8000번대, 한도, 런타임 차이)은 [rdbms/docs/protocol.md](rdbms/docs/protocol.md)이다.
- **TLS 서버 인증서 검증(모든 클라이언트 공통, 2026-10-15 결정)** : 접속용 CLI(`hwdb --ssl`)와 드라이버는 서버 인증서를 기본으로 검증한다. 신뢰할 CA 를 지정하는 방법과 검증을 끄는 방법을 함께 제공한다.
  인증서 오류로 접속에 실패하면 접속을 끊고 100 ms 뒤에 다시 시도하며, 재시도는 최대 2회(연결 시도는 최대 3번)이다. 재시도에서도 검증은 그대로 한다. 인증서 오류가 아닌 실패(연결 거부, 시간 초과 등)에는 적용하지 않는다. 사양은 AGENTS.md 상세 8, 설계는 [rdbms/docs/communication-design.md](rdbms/docs/communication-design.md)의 12-1절이다.
- 인증은 SCRAM-SHA-256 이다. 드라이버가 쓸 계산은 `rdbms/src/auth/scram.ts` 에 순수 함수로 있고 RFC 7677 시험 벡터로 검증되어 있다. 사용자가 없는 경우와 비밀번호가 틀린 경우는 같은 오류(`28000`)이다.
  CONNECT 권한 그룹이 없는 사용자는 원격(루프백이 아닌 주소) 접속이 거부된다. 현재 테이블스페이스가 없는 세션(사용자에게 기본 테이블스페이스가 없을 때)이 있을 수 있으므로 드라이버와 DB툴은 이를 처리해야 한다.
- **사용자 결정(2026-10-16)** 3건이다. 자세한 구현 방침은 [rdbms/PROGRESS.md](rdbms/PROGRESS.md)의 결정 사항.
  1. **화면 문구의 언어** : `hwdb` 의 사용법, 안내, 표 머리글, 경고 같은 문구는 지금 영어만 낸다. 문구를 코드에 박지 않고 메시지 키로 꺼내 쓰는 카탈로그(`rdbms/src/cli/i18n.ts`, 영어 카탈로그 `rdbms/src/cli/messages/en.ts`)로 분리해 두었으므로, 언어를 추가할 때는 카탈로그와 언어 선택만 더하면 된다.
     DB 오류 메시지는 AGENTS.md 상세 0 대로 영문으로 고정하고 SQLSTATE 와 내부 오류 번호가 번역의 열쇠이다. 드라이버와 DB툴도 같은 원칙을 따른다(서버 메시지는 그대로 전달하고, 자기 화면 문구만 카탈로그로 둔다).
  2. **DML 행 단위 접근** : 보편적인 RDBMS 처럼 대상 행 단위로 접근한다. 테이블 전체를 메모리 이미지로 올리는 방식은 버린다. 사용자가 10단계보다 먼저 하라고 하여(2026-10-16) 1부(읽기와 오버레이 계층)와 2부(제약 검사·참조동작·커밋 쓰기·커밋 FK 재검사)를 모두 마쳤다. 전체 테이블 이미지를 없애고 PK 단건 DML과 명시적 커밋이 힙을 순회하지 않음을 계측했다.
  3. **사양이 정하지 않은 사용자·권한 규칙** : 보편적인 RDBMS 의 동작을 따른다. 점검 결과 [rdbms/docs/accounts-and-privileges.md](rdbms/docs/accounts-and-privileges.md) 8절의 규칙은 이미 PostgreSQL, Oracle 의 공통 동작이거나 AGENTS.md 개요 5 의 명시 문구를 따른 것이라 그대로 두었다.
- 오류는 SQLSTATE, 내부 오류 번호, 영문 메시지에 더해, SQL 문장 안의 위치(줄, 칸)를 가질 수 있다. 문법 오류는 항상 위치를 가진다. 9단계의 프로토콜 오류 메시지에 이 위치를 실어 드라이버와 CLI 가 보여 줄 수 있게 한다.
- 내부 오류 번호의 배정 : 1 ~ 999 공통, 1000번대 저장 엔진, 2000번대 타입 시스템, 3000번대 SQL 문법, 4000번대 카탈로그와 DDL, 5000번대 질의 실행. 번호와 SQLSTATE 의 목록은 `rdbms/src/common/errors.ts`에 있고 한 번 정한 번호는 바꾸지 않는다.

- **Node.js 드라이버가 끝났다(2026-10-17).** 공개 API 는 [nodejsDriver/README.md](nodejsDriver/README.md), 결정과 한계는 [nodejsDriver/PROGRESS.md](nodejsDriver/PROGRESS.md)이다. 다른 드라이버(`pythonDriver` 등)와 DB툴이 참고할 점 :
  (1) 서버를 띄우는 통합 시험 도우미 `nodejsDriver/test/helpers/server.ts`(`TestServer`)는 임시 설치 디렉토리·빈 포트·`hwdb start`/`stop` 으로 `rdbms` 를 띄운다. (2) 시험 프로세스 안에 서버에 접속한 연결이 열려 있을 때 `hwdb` 를 동기로 부르면 연결이 응답을 읽지 못해 서버 종료가 유예 시간만큼 늦어진다. (3) 시험의 서버 정리는 PID 만 믿고 `SIGKILL` 하지 않는다. 끝난 서버의 PID 를 운영체제가 곧바로 다른 프로세스에 줄 수 있다(Windows). 잠금 파일의 PID 가 살아 있고 그 포트의 로컬 전용 채널이 열려 있을 때만 서버로 본다.
  (4) 서버가 먼저 끊을 때는 `id: 0` 오류(`57P01` 서버 종료, `57P05` 유휴 시간 초과)가 오고 그 뒤 연결이 닫힌다. 연결은 이 오류를 원인으로 보고해야 한다. (5) 정수 파라미터의 산술과 집계(`COUNT(*)`)는 `BIGINT` 로 온다. (6) 서버의 `maxConnections`(기본 10)는 TCP·UDP 세션의 합이므로 풀의 기본 크기는 그보다 작게 둔다.

## 사용자 확인이 필요한 사항

`pythonDriver`는 2026-10-20 사용자 작업 지시에 따라 착수했다. 기존 설계의 명명 기본안을 적용하고 AGENTS.md D절에 순서를 명시하여 이전의 착수 대기는 해소했다. 후속 검증 사항은 [pythonDriver/PROGRESS.md](pythonDriver/PROGRESS.md)의 "미결 사항"에 있다.
이 PC(`DESKTOP-HJOW`)에서 Python 3.2는 `C:\Program Files\Python\P302\python.exe`, 현재 PATH의 Python은 `C:\Program Files\Python\P312\python.exe`(3.12.4)이다. 이전 3.13.1 경로는 현재 없어 시험하지 않았다. 다른 장비의 경로는 별도로 기록한다.
이번 환경에서는 Python 3.2가 `C:\Program Files\Python\302\python.exe`, Python 3.13.1이 `C:\Program Files\Python\313\python.exe`이며 각 124개를 검증했다. 앞의 다른 경로는 이전 장비 기록이다.
이번 Node.js 22.23.3은 `%TEMP%\hwdb-validation-runtimes\node22.exe`를 사용했다. 기본 Node.js는 24.21.0, Bun은 1.4.2이다. Java 8은 최신 지정 `C:\Program Files\Java\jdk1.8.0_202`를 쓰고 Java 21 임시 경로는 같은 디렉토리의 `jdk-homes.json`에 있다.
Java 6·7은 사용자가 지정한 `C:\Program Files\Java\jdk1.6.0_45`·`C:\Program Files\Java\jdk1.7.0_80`을 사용했다. 실제 버전과 컴파일러를 확인했고 이후 임시 Java 6·7 배포본은 사용하지 않았다. 최신 검증 기록은 `jdbc6/PROGRESS.md`를 따른다.

지금 `rdbms` 와 `nodejsDriver` 에서 사용자 확인을 기다리는 것은 없다. 아래 3건은 2026-10-16 에 사용자가 정했고, 결정 내용은 "공통 인수인계 사항" 에 있다.

- 결정 1 : `hwdb` 가 화면에 내는 문구의 언어 → 지금은 영어만 낸다. 다만 언제든 다국어를 붙일 수 있게 문구를 메시지 카탈로그로 분리한다.
- 결정 2 : DML 의 행 단위 접근 → 보편적인 RDBMS 처럼 행 단위로 접근하도록 구현한다. 시기는 9단계 다음, 10단계 전이다.
- 결정 3 : 사용자·권한 문장에서 사양이 정하지 않은 규칙 → 보편적인 RDBMS 의 동작을 따른다. 지금 구현이 이미 그렇게 되어 있어 코드는 바꾸지 않는다.

보류한 프로젝트의 확인 사항(자바 빌드와 시험 환경, UI 프레임워크 등)은 각 PROGRESS.md 의 "미결 사항" 에 있으며, 보류를 풀 때 확인한다.

JDBC의 자바 지원 범위·인터페이스 버전·프로젝트 이름은 2026-10-16 사용자 결정으로 확정했다. `jdbc6`는 자바 6~7용 JDBC 4.0과 자바 8 이상 실행 호환, `jdbc8`은 자바 8 이상용 JDBC 4.2이다. 2026-10-20 추가 지시로 jdbc6 14-5와 서버 확장 연동을 완료했고 jdbc8은 13-4 및 공통 통신 회귀까지 마쳤다. 공통 URL·접속 속성과 프로토콜을 공유하며 JDBC 계층은 각 Java API 기준으로 유지한다.

## 작업 이력

- 2026-10-22 : 사용자 요청으로 `unixodbc` 프로젝트 환경과 개발 계획을 만들었다. AGENTS.md·루트 PROGRESS.md·winodbc 계획·서버 프로토콜을 참고해 UO-0 ~ UO-13 단계와 API·타입·서버 의존성·설계·의존성·환경·검증 문서를 작성했다. CMake·CTest(dev/release/asan), `libhwdbodbc.so.0` 골격과 version script, ABI·환경 probe, 문서 계약 시험, 실제 `rdbms` 연기 시험을 만들었고 세 프리셋 각 4개(합계 12개)가 통과했다. root 권한이 없어 `.deps/`에 unixODBC 2.3.12와 CMake 4.4.4를 준비하는 스크립트를 넣었다. ODBC 함수는 아직 구현하지 않았다. 커밋·푸시는 하지 않았다.

- 2026-10-22 : 사용자 요청으로 `rdbms`와 `nodejsDriver`·`pythonDriver`·`jdbc6`·`jdbc8`를 점검했다. 기준선은 rdbms 956개, nodejsDriver 116개, pythonDriver 124개 모두 통과(각 환경은 프로젝트 문서 참고)였다. 기존 시험이 다루지 않는 경로를 실제 실행으로 재현해 rdbms 6건, nodejsDriver 5건, pythonDriver 6건, jdbc6·jdbc8 공통 6건을 찾고 각 프로젝트 PROGRESS.md의 "다음 작업: 2026-10-22 점검 취약점 수정"에 심각도·위치·재현·수정 방향·회귀 시험으로 기록했다. winodbc는 완료 프로젝트가 아니므로 제외했다. 소스와 시험은 바꾸지 않았고 커밋·푸시는 하지 않았다.

- 2026-10-21 : Linux에서 기존 서버·드라이버와 배포 소비자, 소켓·신호·Konsole·PTY를 점검했다. 플랫폼 결함 3개를 수정하고 회귀 시험 7개와 Linux 검증 기록을 추가했다. 서버 Node.js 22 전체 955개·마지막 CLI 17개, Bun 단위 863개·통합 91개(기존 TLS 1개 건너뜀)·마지막 CLI 17개가 통과했다. Node.js/Python/JDBC 결과는 현재 상태와 Linux 검증 기록을 따른다. 커밋·푸시는 하지 않았다.

- 2026-10-20 : 사용자 지정 Oracle JDK 8u202로 JDBC8 서버 prepare/describe·cancel을 연동했다. SQLType/java.time 힌트·정밀도·오프셋·배치 스냅샷·executeLargeBatch 부분 실패를 검증하고 기존 시험의 UNKNOWN 가정을 갱신했다. Java 8·21의 기존 130개·확장 50개·독립 소비자 6개 및 JDBC6 새 Java 8 기본 경로 행렬 15개가 통과했다. 13-5 자동 범위와 실제 범용 도구 미검증을 구분해 문서를 갱신했다. 서버·공유 프로토콜 소스와 저장 포맷은 바꾸지 않았으며 커밋·푸시는 하지 않았다.

- 2026-10-20 : AGENTS.md·각 PROGRESS.md·HANDOFF.md를 읽고 서버 남은 수정·검증과 jdbc6 추가 작업을 마쳤다. 서버 Node.js 22 전체 949개 중 948 통과·1 건너뜀, Bun 주요 167개·최종 핵심 42개 통과. 지정 Oracle JDK 6·7과 Java 8·21·25의 jdbc6 기존 255개·확장 85개·빌드 15개·독립 소비자 15개, jdbc8 기존 130개, Node.js 116개와 Python 3.2·3.13.1 각 124개가 통과했다. SQL 분석·NULL·파일 쓰기·JDBC 정상 종료 경합을 보완하고 규약·매뉴얼·완료 체크리스트·진행 기록을 갱신했다. ODBC와 나머지 드라이버의 새 API는 후속이며 GUI 보류를 유지한다. 커밋·푸시는 하지 않았다.

- 2026-10-20 : rdbms 남은 구현 작업을 진행한 뒤 사용자의 추가 지시로 마지막 오류 수정에서 종료했다. 서버 NULL/타입 힌트 오류와 JDBC 뷰 컬럼 중복을 수정했고, 추가 테스트·최종 검증·문서 정리를 rdbms/HANDOFF.md 및 각 진행 문서의 다음 작업에 명시했다. 커밋·푸시는 하지 않았다.

- 2026-10-20 : 사용자 요청에 따라 nodejsDriver·pythonDriver·jdbc6·jdbc8 진행 문서에 서버 prepare/describe·cancel 구현 후 연동 작업을 추가했다. 각 드라이버의 API·런타임·메타데이터·취소 처리·회귀 시험과 서버 선행 조건을 명시했다. 코드 변경과 실행 시험은 하지 않았다.

- 2026-10-20: AGENTS.md의 Windows ODBC 프로젝트 추가를 읽고 winodbc 상세 개발 계획을 작성했다. 서버 prepare/describe·cancel의 후속 작업 문서를 신설하고 두 프로젝트의 선행 조건·참조와 진행 기록을 연결했다. 문서만 변경했으며 커밋·푸시는 하지 않았다.

- 2026-10-20 : 사용자 추가 지시에 따라 jdbc8 13-4와 jdbc6 14-4 완료. TCP·TLS·UDP·SCRAM 공통 계층, JDBC 4.0/4.2와 타입 변환·메타데이터·트랜잭션·커서, JAR 서비스 등록과 실제 서버 시험 실행기를 구현했다. Windows VM-W11-Codex / Node.js 24.19.0에서 jdbc8(Java 8·21) 130개, jdbc6(Java 6·7·8·21) 200개와 빌드 회귀 14개 통과. 두 프로젝트 README·PROGRESS·AGENTS.md를 갱신했다. 후속 단계는 13-5·14-5이며 커밋·푸시는 하지 않았다.

- 2026-10-08 : AGENTS.md 에 상세 사양과 구현 계획 작성.
- 2026-10-08 : 사양 변경 반영. 통신 방식을 HTTP 웹소켓에서 TCP 로 변경, 접속용 CLI 와 로컬 전용 채널 추가, 문법 생략 원칙 추가. 프로젝트별 PROGRESS.md 작성.
- 2026-10-08 : 사양 변경 반영. 데몬 구동과 CLI 를 통한 구동, 종료, 상태 조회 추가. SID 대신 포트 번호로 인스턴스를 식별하도록 명시하고 TCP 와 UDP 포트를 하나로 통합. 패키지명 규칙 확정. JDBC 와 GUI DB툴 보류.
- 2026-10-08 : `rdbms` 1단계 착수. Node.js 프로젝트 구성(ES 모듈, TypeScript), 모듈별 뼈대 작성, 개발 의존성의 타입스크립트를 6 버전으로 고정.
- 2026-10-08 : `rdbms` 1단계 완료. config.json 읽기, 로그, 오류 체계, 포그라운드 구동과 잠금 파일 동작. `npm test` 29개 통과.
- 2026-10-08 : 기존 구현 점검 및 보완. 동시 구동 시 잠금 덮어쓰기, 잘못된 UTF-8/타임존 허용, SQL 주석을 낀 비밀번호 로그 노출, 로그 파일 오류와 종료 자원 정리를 수정했다. `rdbms` 2단계 저장 엔진 완료. `npm test` 51개와 Node.js/bun 주요 실행 검증 통과.
- 2026-10-08 : AGENTS.md 개요 변경을 상세 표, 타입 정책 문서, 프로젝트별 인수인계 및 소스에 동기화했다. 고정소수 기본값 (10,3), VARCHAR/NVARCHAR 길이 65,535, 1.0 출시 전 저장 포맷 예외를 반영했다. `npm test` 54개와 bun의 고정소수 인자 해석 테스트 통과.
- 2026-10-08 : `rdbms` 3단계 타입 정의를 진행했다. ANSI 타입 별칭/기본값/범위 검증과 테스트를 추가하고, FLOAT/INTERVAL 정밀도 선택을 결정 사항 및 타입 문서에 기록했다. `npm test` 60개, bun 타입 테스트 9개 통과.
- 2026-10-09 : `rdbms` 3단계(타입 시스템)와 4단계(SQL 파서) 완료. 값 표현과 비교, NUMERIC 정확 연산, 날짜시간·타임존·INTERVAL, 형변환, 연산 결과 타입, 행/인덱스 키 코덱, 어휘 분석과 구문 분석을 구현하고 `rdbms/docs`에 타입 규칙·값 인코딩·SQL 문법 문서를 정리했다. `npm test` 233개, bun 타입·SQL 테스트 182개 통과.
- 2026-10-10 : `rdbms` 5단계(카탈로그와 DDL) 완료. 내부 세션 API, SYSTEM 최초 생성과 테이블스페이스 관리, 테이블·뷰·인덱스 DDL과 PK·FK·NOT NULL, 딕셔너리 12개 뷰와 DUAL, 데몬 구동 때 테이블스페이스 열기를 구현했다. `npm test` 246개, bun 타입·SQL 182개와 카탈로그 13개 통과.
- 2026-10-10 : `rdbms` 6단계 점검 보완. 기존 구현을 점검하여 결함을 고치고 회귀 테스트 9개를 더했다. 7단계 전에는 `BEGIN`·`ROLLBACK`·`SAVEPOINT`·`SET AUTOCOMMIT OFF` 가 `0A000` 이다. `npm test` 282개, bun 231개 통과.
- 2026-10-10 : `rdbms` 6단계(질의 실행) 완료. 식 계산과 3값 논리, 조회 파이프라인(조인·집계·집합·정렬·제한), 상관 서브쿼리, DML과 제약·참조동작, 갱신 가능 뷰 DML, 내장 함수와 NVL·TO_CHAR·TO_DATE, 파라미터, 규칙 기반 인덱스를 구현했다. `npm test` 273개, bun 222개 통과.
- 2026-10-11 : `rdbms` 7단계(트랜잭션과 동시성) 구현. 세션 상태, 오버레이 방식의 트랜잭션, 커밋·롤백·세이브포인트, 행·PK·객체 잠금과 교착 감지, 10개 세션 동시성 테스트를 구현했다. 6단계 점검 보완에서 막아 둔 트랜잭션 문장(`0A000`)을 풀었다. 남은 마무리는 `rdbms/PROGRESS.md` 의 "7단계 남은 마무리".
- 2026-10-11 : 병합 점검. 원격 커밋(`f39583f`)과 병합한 커밋(`9d50f23`)에 충돌 마커가 남아 빌드가 깨져 있었다. `session.ts`, `dml.ts` 를 7단계 쪽으로 정리하고 `npm test` 331개 통과를 확인했다. 병합 중 빠진 `rdbms/PROGRESS.md` 의 6단계 점검 보완 기록을 복구했다. 커밋은 하지 않았다.
- 2026-10-15 : `rdbms` 7단계 남은 마무리와 8단계(계정과 권한) 완료. SCRAM-SHA-256 계산(RFC 7677 시험 벡터), 사용자 계정과 SYSTEM 계정, 권한 수준별 부여·회수와 권한 그룹(CONNECT·OFFICER·DBA), 문장 실행 전 권한 검사와 뷰 권한 규칙(개요 5 의 뷰 UPDATE 예시 포함), 딕셔너리 뷰의 권한별 가시성, 현재 테이블스페이스가 없는 세션, 데몬의 초기 암호 경고를 구현했다. `npm test` 383개 통과, bun 382개 통과. 커밋은 하지 않았다.
- 2026-10-15 : `rdbms` 9단계(통신) 설계 문서 작성(`rdbms/docs/communication-design.md`). 코드 변경 없음. 구현 전에 사용자 확인이 필요한 결정 5건을 정리했다.
- 2026-10-15 : 9단계 설계의 결정 5건 반영. 클라이언트 TLS 서버 인증서 검증 기본 켬 + 인증서 오류 때 100 ms 뒤 최대 2회 재시도, `SYS_SESSIONS` 열 추가, `udp.sessionTimeoutMs = 0` 은 제한 없음(경고), `udp.maxPacketSize` 64 ~ 65,507, 인증 실패 시 접속 종료(권장안 유지). AGENTS.md 상세 7, 8 에 사양을 보충했다. 코드 변경 없음.
- 2026-10-16 : 사용자 결정 3건 반영(`hwdb` 화면 문구는 영어만 + 다국어 준비, DML 은 행 단위 접근, 사양이 정하지 않은 권한 규칙은 보편적인 RDBMS 방식으로 현행 유지)과 `rdbms` 9단계(통신) 완료. 프로토콜 명세 `rdbms/docs/protocol.md` 확정, 로컬 전용 채널·TCP(TLS)·UDP(신뢰성 계층) 접속, 클라이언트 라이브러리, 서버 조립과 정상 종료·제어 요청, `udp` 설정 검증 보강. `npm test` 631개 통과, bun 630개 통과(`t.mock` 1개 제외). bun 에서는 TLS 서버의 최소 버전을 적용하지 못하는 것을 확인했다(구동 로그에 경고). 커밋은 하지 않았다.
- 2026-10-16 : 사용자 요청으로 10단계 전에 DML 행 단위 접근을 진행했고, 작업을 나눌 수 있는 지점인 1부(읽기와 오버레이 계층)까지 마쳤다. 힙 지연 순회, PK 맵을 가진 오버레이, 행 단위 읽기 계층, 인덱스를 타는 조회와 DML 대상 찾기. `npm test` 642개 통과, bun 641개 통과(`t.mock` 1개 제외). 제약 검사·커밋 쓰기(2부)와 10단계는 남았다. 10단계 사전 작업으로 `control status` 응답 필드와 `hwdb` SSL 옵션 사양을 먼저 정했다. 커밋은 하지 않았다.

- 2026-10-16 : `rdbms` DML 행 단위 접근 2부 완료. 제약 검사·FK 참조동작·커밋 쓰기·커밋 FK 재검사에서 전체 테이블 이미지를 없애고 변경 행만 처리한다. 복합 FK와 자기 참조·연쇄, 문장 실패 되돌리기와 잠금 재시도를 유지했다. 16개 시험을 더해 Node.js `npm test` 658개 통과. 2만 행 테이블의 PK 단건 INSERT·UPDATE·DELETE와 명시적 커밋에서 힙 순회가 0회였다. Bun 1.4.2도 전체 실행 657개 통과 + 대량 시험 별도 1개 통과로 658개 검증을 마쳤다(대량 시험은 데이터 준비를 포함해 제한을 120초에서 360초로 조정). 트랜잭션 문서와 진행·인수인계를 갱신했다. 다음은 10단계 CLI이며 커밋은 하지 않았다.
- 2026-10-16 : JDBC의 자바 5 지원을 철회하고 자바 6~7용 프로젝트·폴더·패키지 이름을 `jdbc6`으로 변경했다. JDBC 인터페이스는 `jdbc6` 4.0, `jdbc8` 4.2이며 `jdbc6`도 자바 8 이상에서 같은 배포본을 사용할 수 있어야 한다. AGENTS.md 상세 8-1, JDBC 초안, TLS 안내와 관련 문서·참조를 동기화했다. Markdown 17개의 UTF-8·로컬 링크·옛 JDBC 참조를 검사했고, 빌드와 TCP/TLS 시험은 Node.js·Bun 각각 28개 통과했다. 개발 보류는 유지하며 커밋은 하지 않았다.
- 2026-10-16 : `rdbms` 10단계(데몬 제어와 CLI) 완료. `hwdb start`(분리된 데몬), `stop`, `status`와 SQL 접속(대화형·스크립트 모드, 로컬 전용 채널·TCP·SSL·UDP, 비밀번호 숨김 입력, 한글 폭을 맞춘 표, 오류 위치 표시, 초기 암호·롤백 안내)을 구현하고 [rdbms/docs/cli.md](rdbms/docs/cli.md)를 썼다.
  구동 중인지는 PID가 아니라 로컬 전용 채널의 응답으로 판단한다(PID 재사용 대비). 서버·프로토콜에는 `bye.rolledBack`, 정상 종료 뒤 프로세스를 직접 끝내는 처리(클라이언트가 소켓을 읽지 않으면 Windows에서 데몬이 영원히 남던 문제), 오래된 잠금 생성 가드 정리를 더했다. AGENTS.md 14-1, 14-2에 종료 코드·옵션 조합·스크립트 모드의 `exit` 규칙을 보충했다.
  시험 131개를 더해 `npm test` 789개 통과(Node.js 24.21.0), bun 1.3.14에서 CLI 138개·net/daemon 249개 통과, 결함 주입 15건을 모두 잡았다. Windows에서 분리 구동(콘솔 창 없음, 콘솔 프로세스를 끝내도 데몬 유지)과 실제 콘솔의 대화형 모드를 확인했다. 리눅스·macOS와 실제 터미널 앱의 탭 닫기는 확인하지 못했다. 커밋은 하지 않았다.
- 2026-10-16 : `pythonDriver` 개발 계획을 작성했다([pythonDriver/PROGRESS.md](pythonDriver/PROGRESS.md)). Python 3.2 이상, DB-API 2.0을 지키는 드라이버를 PY-1 ~ PY-6(패키지 구성과 호환 계층, TCP 프로토콜 코어, DB-API 계층, TLS, UDP, 문서와 검증)으로 나누고 예외 매핑, 타입 대응, Python 3.2 범위 주의 목록을 정리했다. AGENTS.md "구현 계획"에 이 프로젝트의 단계가 없고 패키지 이름 규칙(지켜야 할 사항 6)이 Python을 말하지 않아 사용자 확인 사항 3건을 남겼다. 코드와 AGENTS.md는 바꾸지 않았다.
- 2026-10-16 : 이 PC의 Python 3.2가 `C:\Python\Py302\python.exe`에 있음을 `pythonDriver/PROGRESS.md`에 반영했다. 실제로 실행해 확인한 것: 3.2 / OpenSSL 1.0.0a(TLS 1.2 불가 → 이 3.2로 SSL을 시험하려면 서버의 `tcp.ssl.minVersion`을 `TLSv1`로 낮춰야 함) / pip·setuptools 없음 / `ssl.match_hostname`이 IP 주소 SAN을 비교하지 못함. 사용자 확인 사항은 2건(일정, 패키지 이름)으로 줄었다.
- 2026-10-16 : `rdbms` 11단계(통합 검증) 완료. 개요 1 ~ 15 항목마다 실제 `hwdb start` 데몬에 접속하는 시험 87개(동시성 10, 인스턴스 5, 개요별 시나리오 69, 데이터 디렉토리 호환성 3)와 이전 포맷 버전 호환성의 버전 보호를 갖추고 사용 설명서(`rdbms/docs/manual.md`), 검증 기록(`rdbms/docs/verification.md`), `rdbms/config.sample.json` 을 썼다.
  제품 결함 넷을 찾아 고쳤다 : 타입 없는 `NULL` 리터럴(`NVL(NULL, x)`, `1 + NULL` 등), 데이터 파일 절대 경로(복사한 데이터 디렉토리를 못 엶), 행 삽입 비용이 테이블 크기에 비례(힙 빈자리 지도), 인덱스 범위 조건이 틀린 결과(DESC 컬럼의 한쪽 범위, 컬럼이 더 있는 복합 인덱스. 217건이 틀렸고 0건으로). 모두 회귀 시험이 있고 수정 전 코드에서 실패함을 확인했다. 사양(AGENTS.md)은 바꾸지 않았다.
  Node.js 24.21.0 에서 `npm test` 888개 중 887개 통과·1개 건너뜀·실패 0, bun 1.3.14 에서 통합 시험 87개 통과(건너뜀 2). 다음은 `nodejsDriver` 12단계이다. 커밋은 하지 않았다.
- 2026-10-17 : `nodejsDriver` 12단계 완료 (위 "현재 상태"). `rdbms` 쪽에서는 통합 시험 도우미의 데몬 누수(bun)와 PID 재사용 결함을 고치고, 드라이버의 시험이 찾은 `CAST(? AS 타입)` 내부 오류를 고쳤다. 전체 시험을 다시 돌려 통과를 확인했다. 커밋은 하지 않았다.
- 2026-10-20 : `rdbms` 점검 항목 P-1 ~ P-7을 수정하고 회귀 시험 17개를 추가했다. 인증·객체 이름·테이블스페이스 영속성, 한정 이름에 따른 트랜잭션·뷰 권한 경계, 손상 카탈로그 파일 정리, 시험 데몬 정리를 보완했다. 전체 시험은 906개 중 905개 통과·1개 건너뜀·실패 0, Bun 관련 시험은 241개 + 정리 회귀 1개 통과이다. 커밋·푸시는 하지 않았다.
- 2026-10-20 : `nodejsDriver` 코드 점검·수정. 풀 생성·종료 경쟁, 세션과 커서 초기화, 주석이 든 트랜잭션 상태, 특수 컬럼 이름, 인증 제한 시간·응답 검증·소켓 조기 종료·시험 서버 정리를 고쳤다. 신규 시험 16개 포함 Node.js 전체 116개 통과, Bun 최종 시나리오 115개 통과·기존 TLS 1개 건너뜀. 실패·남은 시험 데몬 0. 사용법과 인수인계를 갱신했고 커밋·푸시는 하지 않았다.
- 2026-10-20 : `pythonDriver` PY-1 구현·검증. 패키지·호환 계층·시험 실행기·실제 데몬 도우미와 시험 34개를 추가했다. Python 3.2·3.12.4 각각 전부 통과했고 소스 배포본과 순수 Python 휠을 생성했다. 명명 기본안과 개발 순서를 AGENTS.md에 반영하고 실제 Python 설치 경로 기록을 갱신했다. 다음은 PY-2이며 커밋·푸시는 하지 않았다.
- 2026-10-20 : `pythonDriver` 휠을 깨끗한 Python 3.12.4 가상 환경에 네트워크 없이 설치해 소스 트리 밖 import와 호환 계산을 확인했다. Python 시험용 데몬은 최종 0개이다. 실제 드라이버 접속을 쓰는 최종 배포 시험은 PY-6에 남아 있다.
- 2026-10-20 : `pythonDriver` PY-2 구현·검증 (`VM-W11-Codex`). 저수준 TCP 코어와 시험 43개를 추가해 Python 3.2·3.12.4 각각 77개 통과, 실패·건너뜀 0이다. 오래된 `rdbms/dist` 로 실제 서버 시험이 실패해 다시 빌드한 뒤 통과했다. 다음은 PY-3이며 커밋·푸시는 하지 않았다.
- 2026-10-20 : `pythonDriver` PY-3 구현·검증. DB-API 2.0 계층과 시험 47개를 추가해 Python 3.2·3.12.4 각각 124개 통과, 실패·건너뜀 0이다. Param 이중 인코딩 결함과 3.2의 `utcoffset()` 검증을 찾아 고쳤고 미결 9는 서버 동작 확인으로 닫았다. 다음은 PY-4이며 커밋·푸시는 하지 않았다.
- 2026-10-20 : `nodejsDriver` Node.js 22.x 검증 완료(`VM-W11-Codex`, 22.23.3). 전체 116개 통과·실패와 건너뜀 0, 배포본의 Node.js·Bun TCP·TLS·UDP 접속과 타입 정의 및 CommonJS 소비자를 확인했다. 호환성 수정은 필요하지 않았으며 시험 데몬과 임시 배포본을 정리했다. README와 진행 문서를 갱신했고 커밋·푸시는 하지 않았다.
- 2026-10-20 : `jdbc6` 착수 및 14-1 완료. JDK 6으로 빌드한 같은 JAR의 Java 6·7·8·21 실행과 API·문법 제한 등 14개 시험을 통과했다. Node.js 실행기와 README를 추가하고 AGENTS.md C절·진행 문서에 착수 순서를 반영했다. VM-W11-Codex의 JDK 8 경로를 jdbc8·jdbc6 문서에 기록했다. JDBC 접속 구현은 다음 14-2이며 커밋·푸시는 하지 않았다.
- 2026-10-20 : 사용자 지정에 따라 자바 7 시험 경로를 `C:\Program Files\Java\jdk1.7.0_80`으로 전환했다. 같은 JAR의 Java 6·7·8·21 실행을 포함한 14개 시험이 통과했다. 사용하지 않는 Azul 배포본의 삭제는 자동 승인 검토에서 차단되어 사용자가 직접 정리할 전체 경로를 안내했다.
- 2026-10-22 : 점검 취약점 수정(rdbms R-1~R-6, nodejsDriver N-1~N-5, pythonDriver P-1~P-6, jdbc6·jdbc8 J-1~J-6)을 마쳤다. 사양(AGENTS.md)에 DEFAULT 상수 식과 테이블 이름 변경 규칙을 적었다. 손실 UDP 시험의 간헐 실패는 미결로 남겼다. 커밋·푸시는 하지 않았다.
