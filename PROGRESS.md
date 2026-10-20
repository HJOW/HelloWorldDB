# HelloWorldDB 전체 진행 상황

프로젝트 전체에 걸친 진행 상황과 공통 인수인계 사항을 적는다.
사양과 구현 계획은 AGENTS.md 가 기준이고, 프로젝트별 세부 계획과 진행 상황은 각 디렉토리의 PROGRESS.md 에 있다.

## 현재 상태

- 최종 갱신 : 2026-10-20
- **2026-10-20 : `pythonDriver` PY-2 완료 (`VM-W11-Codex`).** TCP 프로토콜 코어(`errors`, `_protocol`, `_scram`, `_tcp`)와 시험 43개를 구현했다. RFC 7677 벡터, 프레임 길이 선검사, 요청 `id` 짝짓기와 `id: 0` 종료, SCRAM nonce·반복 횟수·서명 검증, 실행·fetch·커서·ping·close(`bye.rolledBack`), 연결·응답 제한 시간을 확인했다. Windows / Node.js 24.19.0 / Python 3.2·3.12.4에서 각각 77개 통과·실패와 건너뜀 0이다. 오래된 `rdbms/dist` 로 실제 서버 시험이 구동 실패가 나 `rdbms` 를 다시 빌드한 뒤 통과했다. 다음은 PY-3(DB-API 2.0 계층)이다. 자세한 내용은 [pythonDriver/PROGRESS.md](pythonDriver/PROGRESS.md)에 있다.
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
- 현재 진행할 범위는 `pythonDriver`이다. `rdbms`와 `nodejsDriver`의 구현·점검은 완료했고 JDBC(`jdbc8`, `jdbc6`)와 GUI DB툴(`gui`)의 보류는 유지한다.
- 다음 작업 : `pythonDriver` PY-3(DB-API 2.0 계층). AGENTS.md D절과 [pythonDriver/PROGRESS.md](pythonDriver/PROGRESS.md)를 따른다. 프로토콜의 기준은 [rdbms/docs/protocol.md](rdbms/docs/protocol.md), 사용자 관점의 동작은 [rdbms/docs/manual.md](rdbms/docs/manual.md)이다.
- 11단계 검증 : Windows의 Node.js 24.21.0 / TypeScript 6.0.3에서 `npm test` 888개 중 887개 통과, 1개 건너뜀(Windows에서 SIGTERM을 받을 수 없는 유닉스 전용 시험), 실패 0. bun 1.3.14에서는 통합 시험 87개를 시험 러너와 데몬 모두 bun으로 돌려 85개 통과, 2개 건너뜀(bun의 TLS 최소 버전 제약, SIGTERM)이다. 결함을 일부러 주입한 빌드에서 새 시험이 실패하는지 확인했다(모두 잡힘).
  확인하지 못한 것 : Node.js 22.x 장비, 리눅스·macOS(유닉스 소켓, `hwdb start`의 세션 분리, SIGTERM 종료), 실제 터미널 앱의 탭 닫기, 실제 자바 6의 TLS 1.0 접속. 알려진 한계 : `SYS_COLUMNS`에 뷰의 컬럼이 없음, 인덱스 이름에 테이블스페이스를 붙여야 하는 경우(`rdbms/PROGRESS.md` 미결 사항).
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
| `rdbms` | `org.duckdns.hjow.helloworlddb.rdbms` | 1 ~ 11 | 1 ~ 11단계 완료(`hwdb`, 통합 검증, 사용 설명서 포함) | 없음 | [rdbms/PROGRESS.md](rdbms/PROGRESS.md) |
| `nodejsDriver` | `org.duckdns.hjow.helloworlddb.nodejsdriver` | 12 | 12단계 완료 (TCP·SSL·UDP, 트랜잭션, 커넥션 풀, 타입 정의, README) | 11단계 완료 (충족) | [nodejsDriver/PROGRESS.md](nodejsDriver/PROGRESS.md) |
| `pythonDriver` | `org.duckdns.hjow.helloworlddb.pythondriver` (import `helloworlddb`) | PY-1 ~ PY-6 | PY-2 완료. Python 3.2·3.12.4 각 77개 통과. DB-API는 PY-3 | `rdbms`·`nodejsDriver` 완료, 사용자 작업 지시 (충족) | [pythonDriver/PROGRESS.md](pythonDriver/PROGRESS.md) |
| `jdbc8` | `org.duckdns.hjow.helloworlddb.jdbc8` | 없음 | 보류. 자바 8 이상, JDBC 4.2 | 계획부터 다시 정한다 | [jdbc8/PROGRESS.md](jdbc8/PROGRESS.md) |
| `jdbc6` | `org.duckdns.hjow.helloworlddb.jdbc6` | 없음 | 보류. 자바 6~7용 JDBC 4.0, 자바 8 이상 실행 호환 | 계획부터 다시 정한다 | [jdbc6/PROGRESS.md](jdbc6/PROGRESS.md) |
| `gui` | `org.duckdns.hjow.helloworlddb.gui` | 없음 | 보류 | 계획부터 다시 정한다 | [gui/PROGRESS.md](gui/PROGRESS.md) |

## 공통 인수인계 사항

- 보류한 프로젝트의 PROGRESS.md 에는 보류 전에 잡아 둔 세부 계획이 초안으로 남아 있다. 확정된 계획이 아니므로 그대로 착수하지 않는다.
- JDBC 기준(2026-10-16 사용자 결정) : 자바 5 지원을 철회했다. 프로젝트·폴더·패키지는 `jdbc6` 기준으로 바꾸고 자바 6~7용 JDBC 4.0을 개발한다. 같은 배포본을 자바 8 이상에서도 사용할 수 있어야 한다. `jdbc8`은 자바 8 이상용 JDBC 4.2이다. 두 프로젝트의 공통 프로토콜 코드는 자바 6 범위로 유지한다. 사양은 AGENTS.md 상세 8-1이다.
- RDBMS 사양 중 보류한 프로젝트를 위한 부분(TLS 1.2를 쓸 수 없는 자바 6 환경용 TLS 최소 버전 설정, 메타데이터 조회용 딕셔너리 뷰)은 `rdbms`에서 그대로 구현한다.
- 프로토콜 명세는 [rdbms/docs/protocol.md](rdbms/docs/protocol.md)에 확정되어 있다(2026-10-16, 버전 1). 모든 드라이버가 이 문서를 기준으로 삼는다. 클라이언트가 해야 하는 검증(서버 nonce·서명 확인, TLS 인증서 검증과 재시도 등)은 그 문서 15절의 체크리스트이다.
  프로토콜을 바꾸면 프로토콜 버전을 올리고, 영향을 받는 드라이버 프로젝트의 PROGRESS.md 에 알린다.
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
- 저장 엔진의 저장/재열기, 인덱스, 롤백, v1 자료 읽기와 포그라운드 종료는 앞선 단계에서 Node.js와 bun으로 확인했다. 현재 검증 환경은 Windows, Node.js 24.19.0, TypeScript 6.0.3, Bun 1.4.2이다. Node.js 22.x 장비에서의 전역 검증은 남아 있다.
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
`VM-W11-Codex` 에서는 Python 3.2가 `C:\Program Files\Python\302\python.exe`, 현재 PATH의 Python(3.12.4)이 `C:\Program Files\Python\312\python.exe` 이다. PY-2는 이 PC에서 3.2·3.12.4 각각 77개 통과로 검증했다.

지금 `rdbms` 와 `nodejsDriver` 에서 사용자 확인을 기다리는 것은 없다. 아래 3건은 2026-10-16 에 사용자가 정했고, 결정 내용은 "공통 인수인계 사항" 에 있다.

- 결정 1 : `hwdb` 가 화면에 내는 문구의 언어 → 지금은 영어만 낸다. 다만 언제든 다국어를 붙일 수 있게 문구를 메시지 카탈로그로 분리한다.
- 결정 2 : DML 의 행 단위 접근 → 보편적인 RDBMS 처럼 행 단위로 접근하도록 구현한다. 시기는 9단계 다음, 10단계 전이다.
- 결정 3 : 사용자·권한 문장에서 사양이 정하지 않은 규칙 → 보편적인 RDBMS 의 동작을 따른다. 지금 구현이 이미 그렇게 되어 있어 코드는 바꾸지 않는다.

보류한 프로젝트의 확인 사항(자바 빌드와 시험 환경, UI 프레임워크 등)은 각 PROGRESS.md 의 "미결 사항" 에 있으며, 보류를 풀 때 확인한다.

JDBC의 자바 지원 범위·인터페이스 버전·프로젝트 이름은 2026-10-16 사용자 결정으로 확정했다. `jdbc6`는 자바 6~7용 JDBC 4.0과 자바 8 이상 실행 호환, `jdbc8`은 자바 8 이상용 JDBC 4.2이다. 개발 보류는 유지한다.

## 작업 이력

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
