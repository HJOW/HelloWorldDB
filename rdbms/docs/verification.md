# 통합 검증 기록 (11단계)

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

- **Node.js 22 에서의 실행**: 개발 장비는 Node.js 24 이다. AGENTS.md 지켜야 할 사항 5 에 따라 Node.js 22.x PC 에서의 전체 시험은 나중에 한다. 문제가 나오면 고친다.
- **bun 으로 단위 시험 전체를 돌리지 않았다.** bun 에서는 통합 시험 87개(시험 러너와 데몬 모두 bun)만 파일마다 돌려 85개 통과, 2개 건너뜀(bun 의 TLS 최소 버전 제약, Windows 의 SIGTERM)이다. 전체 `bun test --timeout 360000 dist/test/` 는 시작했다가 중단했고 결과를 쓰지 않는다. 11단계에서 바뀐 코드의 단위 시험은 Node.js 로만 확인했다.
- **bun 으로 통합 시험을 돌린 뒤 데몬 프로세스 둘이 남았다** (설치 디렉토리는 지워진 상태). Node.js 로 전체를 돌린 뒤에는 남지 않았다. 원인으로는 `t.after` 정리 순서가 Node.js 와 bun 에서 다른 것을 의심하지만 확인하지 못했다. 시험 도우미(`Daemon`)의 정리를 고쳐야 한다. 자세한 것은 [../PROGRESS.md](../PROGRESS.md)의 미결 사항이다.
- **리눅스, macOS**: 모든 시험을 Windows 11 에서 돌렸다. 유닉스 도메인 소켓(권한 0600, 남은 소켓 파일 정리), `hwdb start` 의 새 세션 분리와 SIGHUP 무시, SIGTERM·SIGINT 로 정상 종료하는 시험(`overviewStorage` 의 마지막 시험, Windows 에서는 건너뜀)은 비윈도우 장비에서 확인해야 한다.
- **실제 터미널 앱의 탭 닫기**: 새 콘솔 창의 프로세스를 강제로 끝내는 것으로 갈음했다. 데몬은 콘솔에 붙어 있지 않다.
- **TLS 1.0 과 자바 6**: Node.js 에서 `minVersion: "TLSv1"` 협상은 확인했다(이 Node.js·OpenSSL 빌드가 TLS 1.0 을 협상하지 못하면 시험은 서버 설정과 경고까지만 확인한다). 실제 자바 6 클라이언트는 `jdbc6` 단계의 몫이다. bun 은 구버전 TLS 와 TLS 최소 버전 적용을 지원하지 않는다.
- **동시성의 규모**: 세션 10개로 시험했다. 그 이상의 부하와 오래 도는 부하(수 시간)는 시험하지 않았다.
- **딕셔너리 뷰 `SYS_COLUMNS` 에는 뷰의 컬럼이 없다** (`SYS_VIEWS` 에는 뷰가 있다). 드라이버·DB 툴의 메타데이터 조회(`getColumns`)를 만들 때 정한다.
- **인덱스 이름의 테이블스페이스**: `CREATE INDEX IX ON APP.T (...)` 처럼 인덱스 이름에 테이블스페이스를 붙이지 않으면 세션의 현재 테이블스페이스에 만들려 하고, 테이블과 다르면 `42P16` 이다. `CREATE INDEX APP.IX ON APP.T (...)` 처럼 쓴다. `DROP INDEX` 도 같다. (테이블이 있는 테이블스페이스에 만들도록 바꿀지는 정해야 한다)
- **조회 결과 전체가 메모리에 올라온다** : 아주 큰 조회는 서버와 클라이언트 메모리를 많이 쓴다. ([communication-design.md](communication-design.md) 5절)
- 통합 시험은 같은 장비 안에서 돈다. 다른 장비에서의 네트워크 지연·손실·방화벽은 UDP 손실 프록시로 흉내만 냈다.
