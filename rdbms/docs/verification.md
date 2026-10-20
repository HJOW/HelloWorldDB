# 통합 검증과 후속 서버 검증 기록

개요 1 ~ 15 항목마다 "그 항목을 확인하는 시험"을 두고, 실제 `hwdb start` 로 띄운 데몬에 소켓으로 접속해 확인한 기록이다.
프로세스 안에서 자세히 보는 시험(`test/types`, `test/sql`, `test/exec`, `test/txn`, `test/auth`, `test/net`, `test/cli` 등)은 그대로 두고, 이 시험들은 **설치한 그대로의 제품** 이 사양대로 움직이는지를 본다.

## 1. 개요 항목과 시험

시험은 `test/integration/` 에 있다. 제목이 `개요 N :` 로 시작하는 시험이 개요 N 을 확인한다.

| 개요 | 내용 | 시험 파일 (시험 수) | 프로세스 안의 시험 |
|---|---|---|---|
| 1 | 데이터 타입, 테이블·뷰 DDL, CRUD, NVL·TO_CHAR·TO_DATE | `overviewData` (5) | `test/types`, `test/sql`, `test/exec` |
| 2 | UTF-8 (저장·SQL·통신), 잘못된 UTF-8, 파일 헤더의 캐릭터셋 | `overviewData` (3) | `test/storage`, `test/net/protocol` |
| 3 | 테이블스페이스 1:1 데이터 파일, 자기 완결성, 버전·캐릭터셋 표기, SYSTEM, 손상·없는 파일, 삭제, **이전 버전 호환성** | `overviewStorage` (6), `dataDirCompat` (3) | `test/storage`, `test/catalog` |
| 4 | 사용자 계정, 초기 SYSTEM 계정, 비밀번호 저장·로그 | `overviewSecurity` (4) | `test/auth` |
| 5 | 테이블스페이스·테이블·뷰 수준 권한, 뷰 권한 규칙, GRANT·REVOKE, 상속 없음 | `overviewSecurity` (6) | `test/auth` |
| 6 | 권한 그룹 CONNECT·OFFICER·DBA (원격 접속은 이 장비의 루프백이 아닌 주소로 실제 확인) | `overviewSecurity` (5) | `test/auth`, `test/net` |
| 7 | config.json (기본값, 일부 키, 잘못된 값, 상대 경로, 한 번만 읽기, timeZone·유휴·로그 수준) | `overviewNetwork` (7) | `test/config` |
| 8 | TCP·UDP·SSL(TLS 최소 버전 포함), UDP 유실·중복·조각, UDP 세션 시간 제한 | `overviewNetwork` (5) | `test/net` |
| 9 | 동시 접근 : 네트워크를 거친 10개 세션 (이체·카운터·PK 경쟁·읽기 일관성·교착·잠금 대기·접속 끊김·접속 수 상한) | `concurrency` (10) | `test/txn` |
| 10 | 트랜잭션(자동 커밋, 세이브포인트, 격리, 행 잠금), 인덱스 | `overviewTxn` (10) | `test/txn`, `test/exec` |
| 11 | PK, NOT NULL, FK(참조동작), UNIQUE·CHECK 미지원 | `overviewTxn` (5) | `test/exec`, `test/catalog` |
| 12 | 백업·복구 : 명령 없음, 정상 종료 절차, 비정상 종료 경고, 커밋 뒤 강제 종료, 디렉토리 복사 백업 | `overviewStorage` (6) | `test/daemon` |
| 13 | 문법 생략 원칙, Hello World 두 가지 | `overviewData` (3) | `test/sql`, `test/exec` |
| 14 | 데몬 구동·종료·상태, `hwdb` 접속, 초기 암호 변경 절차, 제어 권한 | `overviewNetwork` (4) | `test/cli`, `test/daemon` |
| 15 | 포트가 다른 두 인스턴스, 같은 포트·같은 데이터 디렉토리 거부, 포트 변경 | `instances` (5) | `test/cli/daemonLifecycle` |

## 2. 실행 방법

```sh
npm test                                              # 빌드 + 전체 (Node.js)
node --test dist/test/integration/                   # 통합 시험만 (빌드 후)
node --test "dist/test/integration/overviewNetwork.test.js"   # 한 파일
bun test --timeout 360000 dist/test/integration/overviewTxn.test.js   # bun 으로 (파일마다 따로 돌린다)
```

- 시험을 돌리는 런타임이 데몬도 돌린다. 환경 변수 `HWDB_TEST_RUNTIME` 에 실행 파일 경로를 주면 데몬만 그 런타임으로 돈다. (예 : Node.js 가 시험을 돌리고 bun 이 데몬을 돈다)
- 통합 시험은 시험마다 임시 설치 디렉토리를 만들고 비어 있는 포트를 골라 데몬을 띄운다. 기본 포트 7410 은 쓰지 않으므로 이미 떠 있는 인스턴스와 겹치지 않는다. (기본값으로 구동하는 시험 하나만 7410 이 비어 있을 때 돈다)
- 데몬 구동에 2 ~ 3초가 들어 시험 하나가 수 초 걸린다. `npm test` 전체(888개)는 Node.js 에서 약 1분 20초이다(시험 파일을 병렬로 돌린다). 통합 시험을 bun 으로 파일마다 따로 돌리면 합쳐 약 2분 15초이다.
- bun 은 시험 하나가 실패하면 뒤의 시험이 "test() inside another test()" 로 연쇄 실패한다. 첫 실패부터 본다. `bun test` 는 시험 프로세스의 시간대를 UTC 로 두므로 시간대에 의존하는 기대값은 데몬을 돌리는 런타임에서 구한다.
- 원격 접속 시험(CONNECT)은 이 장비에 루프백이 아닌 IPv4 주소가 있어야 한다. 없으면 건너뛴다.

## 3. 11단계에서 찾아 고친 결함

통합 시험과 점검을 만들며 실제 제품 결함 넷을 찾아 고쳤다. 모두 회귀 시험이 있다.

1. **타입이 정해지지 않은 `NULL` 리터럴** (`NVL(NULL, x)`, `COALESCE`, `1 + NULL`, `CASE ... THEN NULL`, `UNION`). 결과 타입과 행의 값이 어긋나 오류가 나거나 열 타입에 맞지 않는 행이 만들어졌다.
   `NULL` 은 상대 피연산자의 타입을 따르도록 고쳤다. (`NULL_LITERAL_TYPE`) 시험 : `test/exec/regression.test.ts` 의 NVL·COALESCE, NULL 리터럴 시험.
2. **데이터 파일 경로가 절대 경로로 기록**되어 데이터 디렉토리를 다른 위치로 복사하면(백업 복원, 인스턴스 이전) 테이블스페이스를 찾지 못했다.
   데이터 디렉토리 안의 파일은 디렉토리 기준 상대 경로로 기록하고, 이전 절대 경로 기록은 열 때 바꾼다. `DATAFILE` 로 밖에 만든 것은 절대 경로 그대로이다. 시험 : `test/catalog/catalog.test.ts`, `overviewStorage` 의 백업 시험.
3. **행 삽입 비용이 테이블 크기에 비례**했다. 행 하나를 넣을 때마다 힙의 페이지 체인을 처음부터 끝까지 따라가(페이지마다 체크섬 검증과 슬롯 해석) 몇 만 행을 넣는 데 수 분이 걸렸다.
   힙마다 메모리 안에 빈자리 지도를 두어 한 번만 훑는다. 지도는 힌트일 뿐이라 쓸 때마다 실제 페이지로 검증하고, 틀리면 다시 만든다(다른 배치의 변경, 롤백, 힙 삭제에도 데이터는 안전하다). 1,000행 삽입이 테이블 크기와 무관하게 약 120 ms 이다.
   시험 : `test/storage/storage.test.ts` 의 힙 빈자리 지도 시험 5개 (페이지 해석 횟수 상한, 삭제 공간 재사용, 롤백·동시 배치, 힙 재생성, 틀린 지도).
4. **인덱스를 쓰는 범위 조건이 틀린 결과**를 냈다. 이전 포맷 호환성 시험이 `WHERE DEPT_ID = 2 AND SALARY > 1300`(인덱스 `(DEPT_ID, SALARY DESC)`)의 결과가 비어 있는 것을 드러냈다. 전수 비교로 두 가지 원인을 확인했다.
   - 동등 조건 뒤의 `DESC` 컬럼에 한쪽만 있는 범위(`>`, `>=`, `<`, `<=`)는 하한·상한을 뒤바꿀 때 "없는 쪽" 의 기본 경계까지 뒤바뀌어 항상 빈 결과였다.
   - 인덱스 컬럼이 범위 컬럼보다 더 있는 복합 인덱스(`(A, B, C)` 에 `A = 1 AND B <= 3`)에서 앞쪽 컬럼만으로 만든 키로 "포함" 경계를 잡아 경계값 행이 더 긴 키 때문에 빠졌다.
   이전 코드는 인덱스 정의 11가지 × 조건 약 600가지 중 217건이 인덱스를 쓰지 않은 같은 뜻의 질의와 달랐고, 고친 뒤에는 0건이다. 갱신·삭제의 대상 탐색도 같은 코드를 쓴다.
   시험 : `test/exec/regression.test.ts` 의 인덱스 범위 시험(인덱스 정의 11가지 × 조건 29가지 × 선행 조건, DML 포함).

### 11단계 뒤에 찾은 결함 (2026-10-17, `nodejsDriver` 의 통합 시험)

5. **문자열 파라미터의 `CAST`** : `CAST(? AS INTEGER)`, `CAST(? AS DECIMAL(20,10))`, `CAST(? AS DATE)` 처럼 문자열 파라미터를 숫자·날짜 타입으로 캐스트하면 내부 오류 `XX000`(`Cannot read properties of null (reading 'kind')`)이 났다. 타입 없는 문자열 가운데 리터럴만 리터럴 해석으로 보내고 파라미터를 놓쳤다. 고친 뒤 리터럴과 같은 결과와 같은 오류(`22018`)를 낸다.
   시험 : `test/exec/regression.test.ts` 의 "문자열 파라미터를 CAST 하면 리터럴 해석을 쓴다" (수정 전 코드에서 실패함을 확인했다), `nodejsDriver/test/query.test.ts` 의 NUMERIC 시험.

## 4. 결함 주입(변이) 점검

새 시험이 정말 결함을 잡는지 소스에 결함을 일부러 넣어 확인했다. 시험이 통과하는 것만으로는 시험이 느슨한지 알 수 없기 때문이다. 아래는 모두 시험이 실패했고, 확인 뒤 원본을 복구했다.

| 결함 주입 | 실패한 시험 |
|---|---|
| 삽입마다 빈자리 지도를 버림 / 삭제 공간을 지도에 알리지 않음 / 해석 실패를 오류로 올림 / 꼬리 검증 제거 / 롤백·힙 삭제 때 지도를 안 버림 | 힙 빈자리 지도 시험 (각각) |
| 인덱스 범위 계산을 옛 코드로 되돌림 | 인덱스 범위 시험 |
| 데이터 디렉토리 잠금 확인을 끔 | `instances` 의 같은 데이터 디렉토리 시험 (두 번째 데몬이 떠서 시간 초과) |
| config 상대 경로를 현재 디렉토리 기준으로 | `overviewNetwork` 의 상대 경로 시험 |
| 제어 요청을 모든 접속 경로에서 받음 / 제어 토큰 검사를 끔 | `overviewNetwork` 의 제어 권한 시험 |
| TLS 최소 버전 기본값을 TLSv1 로 | `overviewNetwork` 의 TLS 최소 버전 시험 |
| 모르는 config 키 경고를 없앰 | `overviewNetwork` 의 일부 키·모르는 키 시험 |
| config 기본값(`maxConnections`)을 바꿈 | `test/config` 의 `config.sample.json` 시험 |
| `LATEST_FORMAT_VERSION` 을 2 로 올림 | `dataDirCompat` 의 버전 보호 시험 |

## 5. 이전 포맷 버전 호환성

- `test/fixtures/storage-v1.hwdb` : 저장 엔진 계층(힙, 오버플로, B+Tree, 카탈로그 바이트). `test/storage/storage.test.ts` 가 해시와 내용을 확인한다.
- `test/fixtures/datadir-v1/` : 서버 전체. 데이터 디렉토리를 복사해 실제 데몬으로 열고 읽기·쓰기를 확인한다. `test/integration/dataDirCompat.test.ts`.
- 두 시험 모두 `npm test` 의 전체 시험에 들어 있다. 포맷 버전을 올리면 이전 버전 자료가 없을 때 시험이 실패한다(버전 보호). 자료를 만들고 보관하는 방법은 [../test/fixtures/README.md](../test/fixtures/README.md)에 있다.

## 6. 확인하지 못한 것과 알려진 한계

- **Node.js 22 전체 실행은 2026-10-20 완료**: Windows에서 Node.js 22.23.3으로 시험 러너와 실제 데몬을 모두 실행했다. TypeScript 6.0.3 컴파일과 전체 949개 중 948개 통과·1개 건너뜀(Windows SIGTERM)·실패 0이다. 후속 범위는 7절을 본다.
- **bun 으로 단위 시험 전체를 돌렸다(2026-10-17).** `test/integration` 을 뺀 801개 중 799개 통과, 2개 실패이다. 실패는 둘 다 `t.mock`(`node:test` 의 mock)을 쓰는 시험(`fsync` 실패 시험, 힙 삽입 시험)으로, bun 1.3.14 가 mock 을 구현하지 않아 나는 오류이다(제품 결함이 아니다. bun 1.4.2 에서는 통과했다). 통합 시험 87개는 파일마다 따로 돌려 85개 통과, 2개 건너뜀(bun 의 TLS 최소 버전 제약, Windows 의 SIGTERM)이다.
- **bun 으로 통합 시험을 돌린 뒤 데몬이 남던 문제는 고쳤다(2026-10-17).** 원인은 시험 도우미(`Daemon`)가 데이터 디렉토리를 바꾼 데몬의 잠금 파일을 찾지 못한 것이다(`t.after` 정리 순서가 Node.js 와 bun 에서 다르다). 고친 뒤 bun 으로 통합 시험을 세 번 돌려 남은 데몬이 없었다. 자세한 것은 [../PROGRESS.md](../PROGRESS.md)의 "결정 사항"이다.
- **리눅스, macOS**: 모든 시험을 Windows 11 에서 돌렸다. 유닉스 도메인 소켓(권한 0600, 남은 소켓 파일 정리), `hwdb start` 의 새 세션 분리와 SIGHUP 무시, SIGTERM·SIGINT 로 정상 종료하는 시험(`overviewStorage` 의 마지막 시험, Windows 에서는 건너뜀)은 비윈도우 장비에서 확인해야 한다.
- **실제 터미널 앱의 탭 닫기**: 새 콘솔 창의 프로세스를 강제로 끝내는 것으로 갈음했다. 데몬은 콘솔에 붙어 있지 않다.
- **TLS 1.0 과 자바 6**: 실제 Oracle JDK 6u45의 jdbc6 클라이언트와 Node.js 22 서버 사이의 TLSv1 접속을 확인했다. Java 7 이상은 TLSv1.2로 검증한다. bun은 구버전 TLS와 TLS 최소 버전 적용을 지원하지 않는다.
- **동시성의 규모**: 세션 10개로 시험했다. 그 이상의 부하와 오래 도는 부하(수 시간)는 시험하지 않았다.
- **뷰 컬럼과 인덱스 이름 생략 규칙은 구현했다**: SYS_COLUMNS는 권한으로 보이는 뷰의 컬럼을 행 없이 제공한다. `CREATE INDEX IX ON APP.T (...)`는 APP에 만들고, 한정하지 않은 DROP INDEX는 현재 테이블스페이스에서 찾는다.
- **조회 메모리**: 네트워크 결과는 임시 파일에 보관하고 단순 조회는 지연 순회한다. 정렬·집계·DISTINCT·집합 연산 등 복합 경로의 중간 결과, 트랜잭션 오버레이, 전체 결과를 모으는 클라이언트 API의 메모리 사용량은 제한하지 않는다.
- 통합 시험은 같은 장비 안에서 돈다. 다른 장비에서의 네트워크 지연·손실·방화벽은 UDP 손실 프록시로 흉내만 냈다.

## 7. prepare/describe·취소·파일 커서 후속 검증 (2026-10-20)

사양은 AGENTS.md 상세 8-2, 규약은 [protocol.md](protocol.md) 17절이다. 저장 포맷과 고정 호환성 자료는 바꾸지 않았다.

- `test/exec/prepare`: DML·DDL·설정의 실행 없는 분석, NULL·미정 타입·힌트, 조인·집계·CASE·서브쿼리, 권한·수명·한도·USE/DDL 무효화, CPU·정렬·DML 취소와 앞선 트랜잭션 보존.
- `test/exec/streaming`: 기존 실행과 지연/파일 실행의 결과 일치, 커밋·DDL 뒤 결과 보존, 동시 UPDATE의 값 보존, 부분 변경 후 취소·동기 호출 거부, 파일 생성 실패 정리와 짧은 쓰기.
- `test/net/prepareCancel`: TCP·TLS·로컬·UDP·유실/중복 UDP의 준비·설명·실행·CPU 취소·연결 재사용, 다른 연결 거부, 대기열 우회·중복/늦은 취소·tooLate, 준비 문장과 커서의 독립 수명.
- `test/net/clientSecurity`: 기능 없는 서버에 새 요청을 보내지 않는 호환성. 기존 드라이버 회귀는 새 helloOk의 선택 필드와 기존 실행 규약의 호환성을 확인한다.

재개 때 NULL 파라미터·잘못된 힌트의 SQLSTATE·JDBC 뷰 컬럼 중복 수정부터 다시 검토했다. 추가로 IN 분석이 타입 범위의 NULL 값 때문에 목록 검사를 건너뛰는 결함을 회귀 시험으로 재현했다. IN·BETWEEN·단순 CASE·IN/ANY/ALL 서브쿼리의 피연산자 검사와 파라미터 문맥 전달을 고쳤다. 결과 파일 생성 실패의 빈 디렉토리 누수와 부분 쓰기도 보완했다. JDBC6 배치 회귀에서 선언 타입의 NULL 바인딩 오류를 발견하여 모든 타입 계열의 NULL과 NOT NULL 검증을 추가했다. 서버 회귀 시험은 세 개를 추가했고, JDBC 두 시험에 뷰 컬럼 패턴·순서·중복 없음·UNKNOWN 매핑을 보강했다.

최종 Node.js 22.23.3 전체 결과는 **949개 중 948개 통과·1개 건너뜀·실패 0**이다. 건너뜀은 기존 Windows SIGTERM 시험이다. Bun과 외부 드라이버 결과는 아래 기록을 따른다.

- Bun 1.4.2: 준비·실행·스트리밍·통신·10세션 동시성의 주요 167개 통과 후, 마지막 NULL 수정을 포함한 prepare·streaming·prepareCancel 42개를 다시 실행해 모두 통과했다. Bun 전체 시험은 이번에 반복하지 않았다.
- 동시 UPDATE 값 보존 시험은 느린 실행에서 기본 30초 재시도 한도를 넘었다. 해당 시험의 DB 설정만 120초, 시험 제한은 180초로 지정했다. 최종 Bun 42개와 Node.js 22 streaming 15개가 통과했다.
- Node.js 드라이버: 시험 러너와 실제 서버를 Node.js 22.23.3으로 실행해 기존 116개 통과.
- Python 드라이버: Python 3.2와 3.13.1 각각 기존 124개 통과. 서버는 Node.js 22.23.3이다.
- JDBC6의 준비·설명·힌트·CPU/잠금 취소·제한 시간·실행 중 close·구형 서버 호환 확장 85개가 Oracle 6u45·7u80, Java 8u504·21.0.12.1·25에서 통과했다. 공통 수신 경로의 정상 종료 응답 후 추가 read를 단위 시험으로 재현하여 제거했다. 최신 전체 회귀는 [jdbc6 진행 기록](../../jdbc6/PROGRESS.md)과 [jdbc8 진행 기록](../../jdbc8/PROGRESS.md)을 따른다.
- JDBC8 후속 연동: 사용자 지정 Oracle JDK 8u202로 빌드한 같은 JAR의 Java 8·21 기존 130개·새 API 50개·독립 소비자 6개가 통과했다. 실행 전 분석·SQLType/java.time 힌트·정밀도·오프셋·배치·취소·시간 제한·구형 서버 호환과 뷰 권한 경계를 확인했다. 이 후속 작업에서는 서버·공유 프로토콜 소스를 바꾸지 않아 서버 전체 시험을 반복하지 않았다.
