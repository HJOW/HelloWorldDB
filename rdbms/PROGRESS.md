# rdbms 진행 상황

RDBMS 본체와 접속용 CLI 프로그램을 개발하는 프로젝트이다.
사양은 루트의 AGENTS.md 가 기준이다. 이 문서에는 세부 계획, 진행 상황, 인수인계 사항만 적는다.
단계 번호는 AGENTS.md "구현 계획" 의 번호와 같고, "상세 N" 은 AGENTS.md "RDBMS 에 구현되어야 할 사항 (상세)" 의 N번 절을 가리킨다.

## 현재 상태

- 최종 갱신 : 2026-10-20
- **후속 서버 구현·검증 완료** : prepare/describe·cancel·협력 실행·파일 커서와 뷰 컬럼·인덱스 이름 생략을 검토했다. IN·BETWEEN·CASE·서브쿼리 분석, 선언 타입 NULL 바인딩, 결과 파일 생성 실패·부분 쓰기를 수정했다. Node.js 22.23.3 전체 **949개 중 948개 통과·Windows SIGTERM 1개 건너뜀·실패 0**이다. Bun 1.4.2 주요 167개와 최종 NULL 수정을 포함한 핵심 42개도 통과했다. 최신 인수인계는 [HANDOFF.md](HANDOFF.md), 검증 범위는 [docs/verification.md](docs/verification.md) 7절이다.
- 후속 수정 검증 : Windows, Node.js 24.22.0 / TypeScript 6.0.3에서 `npm test` **906개 중 905개 통과·1개 건너뜀·실패 0**(Windows의 기존 SIGTERM 시험). Bun 1.3.14는 카탈로그·계정·권한·질의·트랜잭션·잠금·메시지 처리기 관련 241개와 실제 데몬 정리 회귀 시험 1개가 모두 통과했다. Bun 전체 시험은 이번에 다시 돌리지 않았다. 회귀 시험은 총 17개를 추가했다.
- 2026-10-20 후속 수정 : 점검 항목 P-1 ~ P-4를 모두 수정했다. 카탈로그와 SYSTEM 레지스트리의 이름 맵은 생성·재열기·레지스트리 저장 모두에서 프로토타입 없는 객체를 쓴다. 추가 점검에서 한정 이름 충돌로 인한 트랜잭션 혼선·뷰 GRANT 검사 누락(P-5), 카탈로그가 손상된 일반 테이블스페이스의 파일 핸들 누수(P-6)를 재현하고 고쳤다. 시험 도우미의 데몬 종료 요청 생략(P-7)도 고쳤다. 상세는 아래 "점검 작업 사항".
- 최초 점검(2026-10-20)은 수정 없이 P-1 ~ P-4를 기록했다. 수정 전 재현 내용은 아래에 보존하고, 후속 조치와 추가 발견 사항은 같은 절에 함께 적었다.
- 2026-10-17 : 11단계 뒤의 마무리와 12단계(`nodejsDriver`) 중에 한 수정 3건. (1) **bun 에서 통합 시험 뒤 데몬이 남던 문제를 재현하고 고쳤다**(시험 도우미. 제품 코드 변경 없음), (2) **드라이버의 통합 시험이 찾은 제품 결함** `CAST(? AS INTEGER)` 같은 문자열 파라미터 캐스트의 내부 오류(`XX000`)를 고쳤다, (3) 단위 시험이 쌓던 임시 디렉토리를 정리하게 했다. 내용은 "결정 사항"의 "12단계(Node.js 드라이버) 중에 한 rdbms 쪽 수정".
  전체 시험을 다시 돌렸다 : Node.js 24.21.0 에서 `npm test` 888개 → 새 회귀 시험 1개를 더해 889개 중 888개 통과, 1개 건너뜀(Windows 의 SIGTERM), 실패 0. bun 1.3.14 : 통합 시험 87개(파일마다) 85개 통과·2개 건너뜀, 단위 시험 801개(통합 제외) 799개 통과·2개 실패(둘 다 bun 1.3.14 가 `t.mock` 을 구현하지 않아서. 위 "미결 사항"). 남은 `daemon/entry` 프로세스 0.
- 진행 단계 : 1 ~ 11단계 완료. 11단계(통합 검증)는 개요 1 ~ 15 항목마다 실제 `hwdb start` 데몬에 접속하는 시험 87개(`test/integration/`)와 이전 포맷 버전 호환성(데이터 디렉토리 단위, 버전 보호), 사용 설명서 [docs/manual.md](docs/manual.md), 검증 기록 [docs/verification.md](docs/verification.md)를 갖추었고, 그 과정에서 제품 결함 넷을 찾아 고쳤다("11단계 검증"). 10단계(데몬 제어와 CLI)는 `hwdb start`(분리된 데몬), `stop`, `status` 와 SQL 접속(대화형·스크립트 모드, 로컬 전용 채널·TCP·SSL·UDP)을 구현했다.
  완료 기준을 채웠다 : 데몬을 띄우면 바로 돌아오고 부모와 콘솔이 끝나도 남으며, 설치 직후 SYSTEM 으로 로그인해 초기 암호를 바꿀 수 있고, TCP·UDP 를 껐거나 `maxConnections` 가 차도 로컬 접속이 된다(Windows 에서 확인).
  명령의 동작은 [docs/cli.md](docs/cli.md), 9단계(통신)의 프로토콜 명세는 [docs/protocol.md](docs/protocol.md)이다.
- 착수 조건 : 없음
- 다음 작업 : jdbc6·jdbc8의 prepare/describe·cancel 공개 API를 연동했다. Node.js·Python의 새 공개 API와 ODBC 통합은 각 프로젝트의 후속 작업이다. 서버의 [PREPARE.md](PREPARE.md) PD-1 ~ PD-5를 완료했으며 PD-6의 ODBC 시험은 별도로 남긴다. 리눅스·macOS와 범용 DB툴 검증, 복합 질의의 외부 정렬은 아래 미결 사항의 범위로 유지한다.
- 10단계에서 서버·프로토콜에 더한 것(2026-10-16) : `bye` 응답의 `rolledBack`(세션을 닫으며 커밋하지 않은 변경을 롤백했는지. `Session.hasUncommittedChanges`, `Connection.close()` 가 `{ rolledBack }` 을 돌려줌),
  정상 종료 뒤 프로세스를 직접 끝내는 `exitAfterShutdown`(`daemon/main.ts`. 클라이언트가 소켓을 읽지 않아 Windows 네임드 파이프가 닫히지 않을 때 데몬이 영원히 남아 `hwdb stop` 이 끝나지 않던 것을 고쳤다), 강제 종료로 남은 잠금 생성 가드 정리(`lockFile.ts`).
- 사용자 확인이 남은 것 : 없다. 2026-10-16 에 3건이 정해졌다. (화면 문구는 영어만 + 다국어 준비, DML 은 행 단위로, 사양이 정하지 않은 권한 규칙은 보편적인 RDBMS 방식. "결정 사항"의 "사용자 결정")
- 6단계 점검 보완(2026-10-10) : 다른 AI 의 구현을 점검하여 찾은 결함 7건을 고쳤다. 내용은 "결정 사항"의 "6단계 점검 보완"과 "작업 이력"에 있다. "인수인계 사항"의 첫 항목(DML 구조와 성능)을 읽는다.
- 2026-10-11 병합 점검 : 원격 커밋과 병합하면서 충돌 마커(`<<<<<<<`, `=======`, `>>>>>>>`)가 `session.ts`, `dml.ts` 에 커밋되어 빌드가 깨져 있었다. 7단계 쪽 구현을 기준으로 정리했다. 병합 중 빠졌던 6단계 점검 보완의 기록(결정 사항, 인수인계, 작업 이력)을 이 문서에 다시 넣었다. 6단계 스텁의 동작을 고정하던 테스트 두 개는 7단계 동작으로 바꾸었다.
- 11단계 검증(Windows, Node.js 24.21.0 / TypeScript 6.0.3) : `npm test` 888개 중 887개 통과, 1개 건너뜀(SIGTERM 종료 시험. Windows 에서는 다른 프로세스가 보낸 SIGTERM 을 받을 수 없다), 실패 0. 10단계의 789개에서 99개가 늘었다(통합 87 : 동시성 10, 인스턴스 5, 데이터 11, 네트워크·설정·CLI 16, 계정·권한 15, 저장·복구 12, 트랜잭션·인덱스·제약 15, 데이터 디렉토리 호환성 3. 단위 12 : 힙 빈자리 지도 5, 인덱스 범위 1, 상대 경로 3, NULL 리터럴 2, 샘플 설정 1).
  bun 1.3.14 : 통합 시험 87개를 시험 러너와 데몬 모두 bun 으로 돌려 85개 통과, 2개 건너뜀(bun 의 TLS 최소 버전 제약, Windows 의 SIGTERM)이고 실패 0이다(파일마다 따로 돌렸다). 11단계에서는 단위 시험 전체를 bun 으로 돌리지 못했으나 2026-10-17 에 돌렸다 : `test/integration` 을 뺀 801개 중 799개 통과, 2개 실패(둘 다 bun 1.3.14 가 `t.mock` 을 구현하지 않아서). 통합 시험을 돌린 뒤 데몬이 남던 문제도 고쳤다("결정 사항").
  결함을 일부러 주입한 빌드에서 새 시험이 실패하는지 확인했다(힙 지도 6건, 인덱스 범위, 데이터 디렉토리 잠금, config 상대 경로, 제어 요청 두 가지, TLS 기본 버전, 모르는 키 경고, config 기본값, 포맷 버전 보호. [docs/verification.md](docs/verification.md) 4절). 모두 잡혔다.
- 10단계 검증(Windows, Node.js 24.21.0 / TypeScript 6.0.3) : `npm test` 789개 통과(10단계 신규 131개 : 인자 해석 16, 문장 나누기 16, 결과 출력 15, 터미널 입력 16, SQL 접속 43, 실제 프로세스 수명주기 21, 잠금 가드 3, 처리기 1).
  bun 1.3.14 : `bun test dist/test/cli/` 138개, `dist/test/net/ dist/test/daemon/` 249개 통과, `hwdb start`·`status`·SQL 접속(로컬·TCP·UDP)·`stop` 직접 실행 확인.
  결함을 일부러 주입한 빌드에서 시험이 실패하는지 15건 확인했다(문장 나누기의 따옴표·주석, 표시 폭, NULL 표시, 옵션 조합 규칙 2건, PID 만으로 구동 판단, 정상 종료 뒤 프로세스 끝내기, `rolledBack`, `-t` 전달, 비밀번호 되울림, 오류 뒤 계속 실행, 인증서 안내, 오류 칸 계산, 구동 실패 감지). 모두 잡혔다.
  실제 Windows 콘솔(`winpty`)에서 대화형 모드를 사람이 하는 입력으로 확인했다 : 비밀번호 숨김, 여러 줄 입력, 위 화살표 이력, `help`, 오류와 `^` 표시, Ctrl-D, 롤백 안내. 새 콘솔 창에서 `hwdb start` 를 실행하고 그 창의 프로세스를 강제로 끝내도 데몬이 남는 것, 데몬에 콘솔 창과 콘솔 호스트가 없는 것도 확인했다. 실제 터미널 앱 탭 닫기는 확인하지 못했다.
- 검증 : Windows의 Node.js 24.19.0 / TypeScript 6.0.3에서 `npm test` 658개 통과(행 단위 접근 2부 신규 16개 포함). 빌드에 오류와 경고가 없다.
  Bun 1.4.2에서도 전체 658개를 검증했다(전체 실행 657개 통과 + 2만 행 시험 1개 별도 통과). 대량 시험은 데이터 준비를 포함해 최초 120초 제한을 넘었고, 제한을 360초로 늘린 재실행에서 약 221초에 통과했다. 예전 Bun 1.3.14에서 실패했던 `t.mock` 기반 fsync 시험은 1.4.2에서 통과했다.
  TLS 시험의 일부(서버 쪽 핸드셰이크 실패 이벤트, 클라이언트의 `maxVersion`, 서버 인증서 교체)는 bun 에서 동작이 달라 Node.js 에서만 본다. 제품 동작의 차이는 [docs/protocol.md](docs/protocol.md) 16절.
  결함을 일부러 주입한 빌드에서 시험이 실패하는지 확인했다(통신 22개 항목 : nonce·채널 바인딩·제어 토큰 비교·접속 수 제한·CONNECT 검사·UDP 주소 고정·재전송·중복 제거·TLS 최소 버전·클라이언트의 서버 서명 검증 등. 모두 잡혔다).
  권한 검사기를 일부러 무력화한 빌드에서 `test/auth/privileges.test.ts` 24개 중 18개가 실패하는 것도 확인했다(8단계).


### 7단계 남은 마무리 (2026-10-15 완료)

- [x] bun 확인 (2026-10-11) : `bun test --timeout 120000 dist/test/` 는 330개 통과. 1개는 `t.mock` 미구현으로 실패한다(인수인계 사항 참고). 동시성 테스트(`setTimeout`, `setImmediate`, Promise 순서에 기대는 것)도 bun 에서 통과했다.
- [x] `SYS_SESSIONS` 연결. `QueryContext.dictionary()` 가 딕셔너리 뷰의 원천(세션 현황, 사용자, 권한, 가시성 판정자)을 돌려주고 `executor.ts` 의 `case "dictionary"` 가 `getDictionaryRows` 에 넘긴다. (처음 계획한 `QueryContext.sessions` 는 8단계 원천이 늘어 `dictionary` 하나로 합쳤다) `test/txn/transaction.test.ts` 에 세션 수와 `IN_TRANSACTION` 을 보는 테스트를 추가했다.
- [x] `exec/executor.ts` 의 `scanTable` 에 남은 불필요한 `ctx.txn !== null &&` 를 지웠다.
- [x] `test/exec/query.test.ts` 의 테스트 제목을 "자동 커밋에서 FOR UPDATE 는 읽고 바로 푼다" 로 고쳤다.
- [x] [docs/transactions.md](docs/transactions.md) 를 썼다. 오버레이 구조, 잠금 키 종류, 기다림과 교착, 커밋 순서, DDL 과 자동 커밋, 트랜잭션 문장 규칙, 오류 번호, 알려진 한계를 모았다.
- [x] `docs/storage-v1.md` 의 트랜잭션 설계 절에 "7단계에서 오버레이 방식으로 구현했다. 실제 구조는 transactions.md" 를 덧붙였다.
- [x] "알려진 한계"를 읽고 8단계 이후에 손볼 것을 정했다 : 8단계에서는 손볼 것이 없다. 메모리 이미지 방식은 2026-10-16 행 단위 접근으로 해결했고, 나머지는 사용자가 불편을 느끼면 다룬다.

### 7단계 알려진 한계

사양을 어기는 것은 없다. 단순함을 위해 보수적으로 동작하는 부분이다.

- 삭제 중인 행의 PK 를 다른 트랜잭션이 다시 넣으려 하면 기다리지 않고 바로 `23505` 가 난다. (삭제가 커밋되기 전에는 커밋된 행이 아직 보이므로)
- `ROLLBACK TO SAVEPOINT` 는 변경은 되돌리지만 그 뒤에 얻은 행 잠금은 트랜잭션이 끝날 때까지 쥐고 있다.
- 잠금은 전부 배타 잠금이다. FK 의 부모 행을 읽는 것만으로는 잠그지 않고, 대신 커밋 직전에 FK 를 다시 확인한다. (`exec/rowChanges.ts`의 `revalidateRowReferences`)
  그래서 부모를 지우는 트랜잭션과 자식을 넣는 트랜잭션이 겹치면 한쪽이 커밋에서 `23503` 으로 실패한다. 기다리게 하는 방식이 아니다.
- 테이블스페이스를 둘 이상 건드린 트랜잭션의 커밋은 테이블스페이스마다 배치 하나씩이며 서로 원자적이지 않다. (사양 12 의 "커밋 도중 중단" 범위. WAL 이 없다)
- 비동기 문장이 실행 중인 같은 세션에서 동기 `Session.execute`를 호출하면 `25001`로 거부한다.
- 트랜잭션 크기는 메모리에 제한된다. (사양 10 이 인정한 제한)

## 작업 규칙

- 작업 항목을 끝내면 `[ ]` 를 `[x]` 로 바꾼다. 단계가 끝나면 "현재 상태" 와 "작업 이력" 을 갱신한다.
- 단계의 완료 기준을 채우기 전에는 다음 단계로 넘어가지 않는다.
- 사양에 없는 것을 새로 정했으면 "결정 사항" 에 적는다. 사양 자체를 바꿔야 하면 AGENTS.md 를 먼저 고친다.

## 디렉토리 구성

파일마다 맨 위 주석에 담당 범위, 관련 사양, 구현 단계를 적어 두었다. 아래는 한 줄 요약이다.
`config`, `common`, `storage`, `types`, `sql`에 구현 코드가 있고, 5단계에서 `catalog`, `session`, `exec/ddl`, 데몬 조립까지, 6단계에서 질의 실행(`exec` 나머지)과 DML을, 7단계에서 `txn` 과 세션 관리를, 8단계에서 `auth`(계정, 권한, SCRAM 계산, 문장별 권한 검사)와 사용자·권한 문장 실행(`exec/accounts.ts`)을, 9단계에서 통신(`net`, `client`)과 데몬의 접속 경로 조립, `cli` 의 문구 카탈로그(`cli/i18n.ts`)를 붙였다. 10단계에서 `cli` 의 나머지(`hwdb start`·`stop`·`status`·SQL 접속, 인자 해석, 문장 나누기, 터미널 입력, 결과 출력)와 분리된 데몬의 진입점(`daemon/entry.ts`)을 붙였다. 11단계에서 통합 시험(`test/integration`), 데이터 디렉토리 호환성 자료, `config.sample.json`, 사용 설명서와 검증 기록을 붙였고 저장 엔진 힙에 빈자리 지도를 더했다.

```
rdbms/
  package.json, tsconfig.json
  config.json            설정 파일. 없으면 기본값으로 구동한다 (저장소에는 없다. 사용자가 만든다)
  config.sample.json     모든 키를 기본값으로 적은 예시. 읽히지 않는다(이름이 다르다). test/config 가 기본값과 같은지 확인한다
  src/
    cli/                 hwdb 명령 (화면 문구는 i18n.ts 의 t(키)로 꺼낸다)
      main.ts              진입점. 인자를 해석(args.ts)해 담당 모듈로 넘김, --help, --version, 종료 코드
      args.ts              명령행 인자 해석, 옵션 조합 규칙
      i18n.ts              화면 문구의 다국어 처리 기반(카탈로그 등록, 언어 선택, t, checkCatalog)
      messages/en.ts       영어 카탈로그(키 목록의 기준)
      daemonControl.ts     hwdb start(분리 구동), stop, status. 구동 상태 확인(probeDaemon)
      sqlShell.ts          SQL 접속 (로그인 흐름, 대화형 모드, 스크립트 모드, 롤백 안내). 입출력은 ShellEnvironment 로 받는다
      statementSplitter.ts 문장 나누기 (문자열·식별자·주석 안의 ; 무시, 줄·칸 위치)
      terminal.ts          터미널 입력 (사용자명, 화면에 보이지 않는 비밀번호, 줄 입력, 표준 입력 읽기)
      resultPrinter.ts     실행 결과의 화면 출력 (표, 표시 폭, 행 수, NULL 표시, 오류와 위치 표시)
    client/
      connection.ts        클라이언트 쪽 프로토콜(핸드셰이크, SCRAM, 실행, 커서, 제어 요청). CLI 와 테스트가 쓴다
      transports.ts        전송 계층 추상화와 로컬 채널·TCP·TLS 연결(인증서 검증과 재시도)
      udpTransport.ts      UDP 전송(신뢰성 계층 위, 세션 번호, FIN)
    daemon/
      main.ts              데몬 본체 구동(runForeground), 신호 처리, 정상 종료 뒤 프로세스 끝내기(exitAfterShutdown)
      entry.ts             hwdb start 가 분리해서 띄우는 진입점
      server.ts            구성 요소 조립, 구동과 종료의 순서
      lockFile.ts          데이터 디렉토리 잠금 파일, 제어 토큰
    config/
      config.ts            config.json 읽기, 기본값, 검증
    common/
      errors.ts            오류 체계 (SQLSTATE, 내부 오류 번호)
      logger.ts            로그
      instance.ts          인스턴스 식별 규칙(포트 번호 → 로컬 전용 채널 주소), 공용 상수
      address.ts           루프백 주소 판정, 상대 주소 다듬기
    storage/
      pageFile.ts          페이지 단위 파일 입출력
      bufferCache.ts       버퍼 캐시
      errors.ts            저장 오류 생성, 인자 검증
      format/format.ts     포맷 버전의 공통 인터페이스, 버전 선택
      format/v1/           포맷 버전 1
        index.ts             테이블스페이스와 배치, 빈 페이지, 카탈로그 바이트 저장
        pages.ts             페이지 레이아웃, CRC-32, 파일 헤더
        context.ts           내부 페이지 접근 규약, 힙 빈자리 지도의 타입
        overflow.ts          행/긴 키/카탈로그의 오버플로 체인
        heap.ts              슬롯 힙, 삽입용 빈자리 지도(HeapSpace. 메모리에만 있는 힌트)
        btree.ts             B+Tree
    types/               타입 시스템. storage 를 import 하지 않는다
      dataType.ts          타입 정의, 이름과 별칭 해석, 인자 기본값과 범위, SQL 표기
      errors.ts            타입 시스템의 오류 생성 (2001 ~ 2012번)
      numeric.ts           Decimal. bigint 기반 10진 정확 연산
      datetime.ts          DATE/TIME/TIMESTAMP/INTERVAL 값, 문자열 변환, 타임존, 날짜 연산
      value.ts             SqlValue, 값을 타입에 맞추기, 비교와 정렬, 3값 논리, 문자열 표기
      cast.ts              암묵적 형변환의 범위, CAST, 문자열 리터럴 해석, 공통 타입
      arithmetic.ts        사칙연산, 단항 -, 연결 || 의 결과 타입과 계산
      codec.ts             행 인코딩, 순서를 보존하는 인덱스 키 인코딩, UTF-8 변환
    sql/                 SQL 문법. catalog, storage 를 import 하지 않는다
      lexer.ts             어휘 분석. 토큰과 위치, 문법 오류 생성
      ast.ts               구문 트리의 타입 정의
      parser.ts            구문 분석. parseStatement, 예약어 목록, 깊이 한도
    catalog/             catalog.ts(정의 저장과 의존 추적), tablespaceManager.ts(목록과 파일 관리),
                         bootstrap.ts(SYSTEM 최초 생성), dictionaryViews.ts(12개 뷰와 컬럼 정의)
    session/             session.ts(SQL 실행의 입구, Database 와 Session, 동기 execute 와 비동기 executeAsync, 트랜잭션 문장),
                         sessionManager.ts(세션 목록, 유휴 세션 종료, 전체 종료. 접속 수 제한과 로컬 판정은 9단계)
    exec/                ddl.ts(테이블·뷰·인덱스 DDL 실행), analyzer.ts(이름 해석과 뷰 전개, 갱신 가능 판정),
                         planner.ts(규칙 기반 인덱스 선택), expression.ts(식 계산과 3값 논리),
                         functions.ts(내장 함수와 집계), executor.ts(조회 실행), dml.ts(INSERT·UPDATE·DELETE·TRUNCATE와 오버레이 커밋), rowChanges.ts(변경 행의 제약·참조동작·잠금·커밋 FK 재검사),
                         accounts.ts(CREATE·ALTER·DROP USER, GRANT, REVOKE 실행)
    txn/                 transaction.ts(트랜잭션과 미커밋 변경 오버레이(PK 맵 포함, 행 단위 변경 API), 되돌리기 기록, 세이브포인트),
                         rowAccess.ts(커밋 값에 자기 변경을 합친 읽기. 지연 순회, PK 조회, 인덱스 조회, 인덱스 후보 합치기),
                         lockManager.ts(행·PK·객체 배타 잠금, 대기열, 제한 시간, 교착 감지)
    auth/                scram.ts(SCRAM-SHA-256 계산과 메시지), users.ts(계정 저장소, SYSTEM 계정, 비밀번호 확인),
                         privileges.ts(부여 기록, 권한 판정, 권한 그룹, 이름 해석, 기록 정리),
                         authorizer.ts(문장별 필요한 권한을 정해 실행 전에 확인)
    net/                 protocol.ts(메시지 정의, 요청 검증, 응답 해석, 한도), resultEncoder.ts(값·메타데이터·파라미터 JSON 변환, 행 묶음),
                         framing.ts(길이 접두 프레임), messageHandler.ts(접속 하나의 상태 기계, 인증, 문장 실행, 제어 요청), cursors.ts, connectionLimits.ts(인증 전 접속 제한),
                         streamConnection.ts(소켓을 처리기에 잇는 공통 코드), localChannelServer.ts, tcpServer.ts(TLS 포함),
                         udpReliability.ts(패킷 코덱, ACK·재전송·조각), udpServer.ts(세션 표, 시간 제한)

  test/                  테스트. src 와 같은 디렉토리 이름으로 두며 파일 이름은 *.test.ts
    smoke.test.ts          프로젝트 구성 확인용
    cli/                   i18n(카탈로그와 언어 선택), args(인자 해석), statementSplitter, resultPrinter, terminal(가짜 터미널 스트림), sqlShell(데몬을 프로세스 안에 띄우고 가짜 입출력으로 실행),
                           daemonControl(프로세스 안의 데몬에 status), daemonLifecycle(실제 hwdb 프로세스로 start·status·stop·잠금 파일·두 인스턴스). helpers.ts 는 공용 도우미
    net/                   통신 테스트. protocol(메시지와 값 인코딩), framing, connect(접속 정책), messageHandler(소켓 없는 처리기), localChannel, tcp(TLS, 인증서 검증과 재시도 포함), clientSecurity(서버 서명 확인),
                           udpReliability(가짜 시계와 시뮬레이터), udp(실제 소켓과 손실 프록시). helpers.ts, udpSim.ts, udpProxy.ts 는 공용 도우미
    catalog/               카탈로그와 DDL 테스트. 내부 세션 API 로 실행하고 재구동 persistence 를 본다
    exec/                  질의 실행 테스트. helpers.ts 는 공용 도우미이며 query(조회)·dml(DML과 제약)·functions(함수와 파라미터)로 나눈다
                           regression.test.ts 는 6단계 점검에서 찾은 결함의 회귀 테스트이다
    txn/                   트랜잭션 테스트. rowDml(행 단위 제약·참조동작·커밋과 대량 테이블 힙 순회 계측), rowAccess(오버레이 PK 맵, 행 단위 읽기, 인덱스 읽기와 전체 스캔의 일치), lockManager(잠금 단위), transaction(커밋·롤백·세이브포인트·가시성·동기 잠금 충돌·DDL),
                           concurrency(비동기 대기·제한 시간·교착, 10개 세션 동시성). exec/helpers.ts 를 함께 쓴다
    auth/                  계정과 권한 테스트. scram(RFC 7677 시험 벡터), accounts(SYSTEM 계정, 사용자 문장, 인증, CONNECT, 영속성, 가시성),
                           privileges(권한 조합별 허용·거부, 수준별 독립, 소유자, OFFICER·DBA, 뷰 규칙, 딕셔너리 가시성, 기록 정리). helpers.ts 는 공용 도우미
    daemon/                server.test.ts(정상 종료 때의 트랜잭션 롤백, 초기 암호 경고 등), serverAssembly.test.ts(세 경로, 제어 요청, 종료 순서, 구동 실패 정리, 두 인스턴스)
    storage/               저장 엔진 테스트, runtime-smoke.mjs(Node.js/bun 실행 검증)
    types/                 타입 시스템 테스트. helpers.ts 는 SQL 표기로 타입과 값을 만드는 도우미
                           codecStorage.test.ts 는 코덱과 저장 엔진을 함께 쓰는 테스트
    sql/                   어휘 분석, 구문 분석 테스트. helpers.ts 는 구문 트리를 한 줄 표기로 바꾸는 도우미
                           parserRobustness.test.ts 는 망가뜨린 입력으로 파서의 견고성을 본다
    integration/           11단계 통합 시험. 실제 `hwdb start` 데몬에 소켓으로 접속한다. helpers.ts(Daemon 도우미)는 공용이다
                           concurrency(개요 9, 세션 10개), overviewData(개요 1·2·13), overviewSecurity(개요 4·5·6), overviewStorage(개요 3·12), overviewTxn(개요 10·11),
                           overviewNetwork(개요 7·8·14), instances(개요 15), dataDirCompat(이전 포맷 버전, 버전 보호)
    fixtures/              storage-v1.hwdb(저장 엔진 계층), datadir-v1/(데이터 디렉토리 전체), 해시/내용 설명, 생성 스크립트(create-storage-v1.mjs, create-datadir.mjs). tls/ 는 시험용 자체 서명 인증서(README 에 만드는 명령)
  docs/
    data-types.md          타입 인자와 기본값, 값 표현, 비교, 형변환, 연산 결과 타입, 타입 오류 번호
    sql-syntax.md          어휘 규칙, 예약어, 사양에 더해 받는 문법, 지원하지 않는 문법, 한도, 구문 트리의 원칙
    storage-v1.md          저장 포맷, 행과 인덱스 키의 값 인코딩, API 사용 원칙과 트랜잭션 설계 원안. 프로토콜 명세는 9단계
    transactions.md        오버레이, 잠금 키, 기다림과 교착, 커밋 순서, DDL 과 자동 커밋, 트랜잭션 문장 규칙, 한계
    accounts-and-privileges.md  계정 저장, SCRAM, 권한 수준과 판정, 뷰 규칙, 권한 그룹, 문장별 필요 권한, 딕셔너리 가시성, 오류 번호
    communication-design.md     9단계 설계와 구현하며 달라진 점(20절)
    cli.md                 hwdb 명령. 데몬 제어(구동 상태 판단, 분리 구동, 종료), SQL 접속(옵션, 모드, 문장 나누기, 출력, 롤백 안내), 표준 절차, 확인 기록과 한계
    manual.md              사용 설명서 : 설치, 데몬 구동·종료, 초기 암호 변경, config.json, CLI 사용법, 여러 인스턴스, 백업, 문제 해결
    verification.md        11단계 통합 검증 기록 : 개요 항목과 시험의 대응, 찾아 고친 결함, 결함 주입 점검, 확인하지 못한 것과 한계
    protocol.md            프로토콜 명세(버전 1). 전송 계층(프레임, TLS, 로컬 채널, UDP 패킷), 메시지, SCRAM, 값 표현, 커서, 오류, 한도, 클라이언트 체크리스트, 런타임 차이. 드라이버가 기준으로 삼는다
  dist/                  빌드 결과물. git 에 넣지 않는다
```

### 모듈 사이의 의존 방향

- `common` 은 다른 모듈을 import 하지 않는다. 다른 모듈은 모두 `common` 을 쓸 수 있다.
- `storage` 는 SQL 의 타입을 모르고 바이트열만 다룬다. `types` 는 `storage` 를 모른다. 둘을 잇는 것은 `types/codec.ts` 가 만든 바이트열이다.
- `sql` 은 문법만 다룬다. `catalog` 나 `storage` 를 import 하지 않는다.
- `exec` 가 `sql`, `catalog`, `storage`, `types`, `txn`, `auth` 를 엮어 문장을 실행한다.
- `session` 이 SQL 실행의 입구이다. `net` 은 `session` 만 호출하고 `exec` 를 직접 부르지 않는다.
- 상위 계층은 `storage/format/format.ts` 만 import 하고 `v1` 같은 특정 버전의 모듈을 직접 import 하지 않는다.
- `client` 는 서버 쪽 모듈을 import 하지 않는다. 공유하는 것은 `net/protocol.ts`, `net/framing.ts`, `net/udpReliability.ts`, `auth/scram.ts` 뿐이다.
- 구성 요소를 서로 연결하는 일은 `daemon/server.ts` 에서만 한다.

### 명령

`rdbms` 디렉토리에서 실행한다.

| 명령 | 하는 일 |
|---|---|
| `npm install` | 개발 의존성 설치 |
| `npm run build` | `dist` 를 지우고 빌드 |
| `npm test` | 빌드한 뒤 `node:test` 로 테스트 실행 |
| `node test/storage/runtime-smoke.mjs` | 빌드 결과물의 저장/재열기와 포그라운드 종료 검증 |
| `bun test/storage/runtime-smoke.mjs` | 같은 주요 경로를 bun에서 검증 |
| `bun test dist/test/types/ dist/test/sql/` | 빌드한 타입 시스템, SQL 파서 테스트를 bun에서 실행 |
| `bun test dist/test/exec/ dist/test/catalog/` | 빌드한 카탈로그, 질의 실행 테스트를 bun에서 실행 |
| `bun test --timeout 360000 dist/test/` | 전체를 bun에서 실행. 2만 행 시험의 데이터 준비 시간까지 고려한 제한이다 |
| `node --test dist/test/integration/` | 통합 시험만 (빌드 후). 데몬을 시험마다 띄우므로 파일 하나에 수십 초가 걸린다 |
| `bun test --timeout 360000 dist/test/integration/<파일>.test.js` | 통합 시험을 bun 으로(시험 러너와 데몬 모두 bun). 파일마다 따로 돌리면 첫 실패의 연쇄 오류를 피한다 |
| `node test/fixtures/create-datadir.mjs <포맷 버전>` | 현재 빌드가 만드는 포맷의 데이터 디렉토리 호환성 자료를 만든다. 이미 있으면 덮어쓰지 않는다 |
| `npm run hwdb -- <인자>` | 빌드된 `hwdb` 명령 실행. 예 : `npm run hwdb -- --help` |

## 세부 계획

### 1단계. 프로젝트 기반

- [x] `package.json` : `name` 은 `org.duckdns.hjow.helloworlddb.rdbms`, `engines.node` 는 `>=22.0.0`, `bin` 에 `hwdb` 를 등록한다
- [x] TypeScript 빌드 구성 (ES 모듈). 빌드 결과물이 Node.js 22.12 와 bun 1.3.14 에서 실행되는 것을 확인했다. Node.js 22.0 자체에서는 확인하지 못했다 (미결 사항)
- [x] 개발 의존성의 타입스크립트를 6 버전으로 고정 (AGENTS.md 지켜야 할 사항 7)
- [x] `node:test` 기반 테스트 실행 구성
- [x] 모듈별 뼈대 파일과 담당 범위 주석
- [x] config.json 읽기 : 기본값 채우기, 값 검증, 모르는 키 경고, 상대 경로 처리 (상세 7)
- [x] 로그 : 레벨, 파일 출력. 비밀번호가 로그에 남지 않게 한다
- [x] 오류 체계 : SQLSTATE, 내부 오류 번호, 영문 메시지 (상세 0)
- [x] 데몬 진입점 : 포그라운드 구동, 정상 종료 절차의 뼈대, 데이터 디렉토리 잠금 파일 (상세 9, 12). 분리된 프로세스로 띄우는 것은 10단계에서 한다
- 완료 기준 : 기본값과 config.json 각각으로 프로세스가 포그라운드로 구동되고 정상 종료된다.
  (`hwdb start --foreground` 로 기본값과 config.json 모두 확인했고, `hwdb status` 로 구동 여부를 확인했다. `npm test` 29개 통과.)

### 2단계. 저장 엔진

- [x] 바이트 단위 파일 포맷을 정하고 `docs` 에 문서로 남긴다 (상세 3)
- [x] 페이지 단위 파일 입출력, 파일 헤더, 매직 넘버와 포맷 버전 확인
- [x] 포맷 버전에 따라 구현을 고르는 구조(`storage/format/v1`)와 상위 계층이 쓰는 공통 인터페이스
- [x] 버퍼 캐시. 커밋되지 않은 변경은 데이터 파일에 쓰지 않는다 (상세 10)
- [x] 빈 페이지 관리, 슬롯 페이지 구조의 힙, 오버플로 페이지
- [x] B+Tree : 삽입, 삭제, 단건 탐색, 범위 탐색, 복합 키, 유일 키 검사
- [x] 페이지 체크섬, 정상 종료 표시
- [x] 트랜잭션 설계 : 되돌리기 정보를 어디에 둘지, 행 잠금을 어떻게 걸지, 다른 트랜잭션이 커밋 전 값을 읽지 않게 하는 방법을 문서로 정한다 (구현은 7단계)
- [x] v1 데이터 파일을 만들어 `test/fixtures` 에 보관하고, 그 파일을 여는 호환성 테스트를 둔다
- 완료 기준 : 재구동 후에도 데이터가 유지된다. v1 데이터 파일이 호환성 테스트 자료로 보관되어 있다.
  (파일 재열기 및 별도 프로세스 종료 후 커밋 유지/미커밋 폐기 확인. 고정 `storage-v1.hwdb`의 SHA-256과 힙/인덱스/카탈로그 읽기 테스트 통과.)

### 3단계. 타입 시스템

- [x] 타입 이름과 별칭 해석, 길이와 정밀도의 범위 검증, 생략했을 때의 기본값 (상세 1-1, 13)
  - 문자/이진, 정수, 고정·부동소수, 논리, 날짜시간, INTERVAL 타입을 정규화했다. `CHAR`/`VARCHAR`/`BINARY` 계열 길이와 DECIMAL, FLOAT, TIME/TIMESTAMP, INTERVAL 정밀도를 검증하고 기본값을 적용한다.
  - 전용 테스트에서 별칭, 경계값, 잘못된 인자, 지원하지 않는 타입의 SQLSTATE를 확인했다.
- [x] 값의 저장 형식, 정렬 순서가 유지되는 인덱스 키 형식
  - `codec.ts`의 `encodeRow`/`decodeRow`, `encodeKey`, `prefixUpperBound`. 형식은 [docs/storage-v1.md](docs/storage-v1.md)의 "행과 인덱스 키의 값 인코딩"에 있고 고정 검증값 테스트로 묶었다.
- [x] 비교 규칙 : NULL, CHAR 의 뒤쪽 공백, 코드 포인트 순 (상세 1-2)
- [x] NUMERIC 의 10진 정확 연산. 부동소수를 거치지 않는다 (`bigint` 기반)
- [x] 날짜시간, 타임존, INTERVAL 연산
- [x] 암묵적 형변환과 `CAST`
- [x] 사칙연산, 단항 `-`, `||` 의 결과 타입과 계산 (`arithmetic.ts`)
- 완료 기준 : 타입별 경계값, 오버플로, NULL 처리 테스트 통과.
  (`test/types`의 102개 테스트 통과. 키의 바이트 순서와 값의 정렬 순서가 같은지를 표본값·무작위값·복합 키로 확인했고, 코덱이 만든 행과 키를 실제 저장 엔진에 넣어 재열기 후 인덱스 순서로 읽는 테스트를 두었다. 빌드 결과물에 결함을 주입해 테스트가 잡아내는지도 확인했다.)

### 4단계. SQL 파서

- [x] 어휘 분석 : 키워드, 식별자(큰따옴표 포함), 리터럴, 주석, `?`
- [x] 식 : 연산자 우선순위, `CASE`, `CAST`, 함수 호출, 서브쿼리
- [x] 문장 : 질의, DML, DDL, 트랜잭션, 테이블스페이스, 사용자, 권한, 세션 문장(`USE`, `SET TIME ZONE`, `SET AUTOCOMMIT`)
- [x] 생략 규칙 전부 (상세 13)
- [x] 지원하지 않는 문법을 알아보고 `0A000` 으로 답한다 (`UNIQUE`, `CHECK`, `WITH`, `MERGE`, 윈도우 함수 등. 상세 11, 16)
- [x] 문법 오류에 줄과 칸 위치를 담는다
- [x] 견고성 : 어떤 입력에도 `DbError` 이외의 예외로 죽지 않는다. 겹친 깊이와 구문 트리 깊이의 한도를 둔다
- 완료 기준 : 지원 문법은 구문 트리로, 미지원 문법은 `0A000`, 잘못된 문법은 위치 정보를 담은 오류로 처리된다.
  (`test/sql`의 80개 테스트 통과. 받아들이는 문법과 결정 사항은 [docs/sql-syntax.md](docs/sql-syntax.md)에 있다. 상세 13 의 Hello World 세 문장이 그대로 구문 분석된다. 토큰을 빼고 바꾸고 끼워 넣은 입력 만여 건에서 `DbError` 이외의 예외가 없음을 확인했고, 빌드 결과물에 결함 20개를 주입해 테스트가 모두 잡아내는 것을 확인했다.)

### 5단계. 카탈로그와 DDL

- [x] 프로세스 내부 세션 API. 네트워크 없이 SQL 을 실행하는 통로이며 5 ~ 8단계의 테스트가 이것을 쓴다
- [x] 최초 구동 시 SYSTEM 테이블스페이스 생성 (상세 3)
- [x] 테이블스페이스 생성과 삭제, 구동 시 열기, 사용 불가 상태 처리
- [x] 테이블, 뷰, 인덱스 DDL. `RESTRICT` 와 `CASCADE` 의 의존성 처리 (상세 1-3)
- [x] 제약조건 정의 저장 : PK, NOT NULL, FK (상세 11)
- [x] 이름 해석 : 현재 테이블스페이스, `USE`
- [x] 딕셔너리 뷰와 `DUAL` (상세 3)
- 완료 기준 : DDL 로 만든 객체가 재구동 후에도 남고 딕셔너리 뷰에서 조회된다.
  (`test/catalog/catalog.test.ts`의 13개 테스트 통과. 테이블스페이스·테이블·뷰·인덱스 생성과 삭제, PK·FK·NOT NULL 저장, RESTRICT·CASCADE, USE, 12개 딕셔너리 뷰와 DUAL 조회, 재구동 persistence, 손상·분실 시 사용 불가 처리를 확인했다. 데몬(`daemon/server.ts`)도 구동 때 테이블스페이스를 함께 연다.)

### 6단계. 질의 실행

- [x] 이름과 타입 검사
- [x] 단일 테이블 조회, 조건, 식 계산
- [x] 조인, 집계와 `GROUP BY`, `HAVING`, 정렬, `DISTINCT`, 집합 연산, 행 수 제한 (상세 1-4)
- [x] 서브쿼리 : 스칼라, 인라인 뷰, `IN`, `EXISTS`, `ANY`, `ALL`, 상관 서브쿼리
- [x] INSERT, UPDATE, DELETE, TRUNCATE
- [x] 제약조건 검사와 FK 참조동작 (상세 11)
- [x] 뷰 전개, 갱신 가능한 뷰를 통한 DML (상세 1-3)
- [x] 내장 함수. `TO_CHAR`, `TO_DATE` 의 형식 요소 포함 (상세 1-5)
- [x] `?` 파라미터 바인딩
- [x] 규칙 기반 인덱스 선택 (상세 10)
- 완료 기준 : 문법 요소별 결과 검증 테스트 통과. NVL, TO_CHAR, TO_DATE 포함. 상세 13 의 Hello World 샘플이 그대로 실행된다.
  (`test/exec`의 27개 테스트 통과. 조인 5종과 USING 병합, 상관 서브쿼리, 복합 PK·FK와 CASCADE·SET NULL, 갱신 가능 뷰 DML, 함수 전체와 파라미터, PK·앞쪽 컬럼 동등·범위의 규칙 기반 인덱스, Hello World 두 샘플을 확인했다. `SELECT ... FOR UPDATE`는 잠금 없이 읽으며 잠금은 7단계이다.)

### 7단계. 트랜잭션과 동시성

- [x] 세션 상태 : 자동 커밋, 진행 중인 트랜잭션, 현재 테이블스페이스, 타임존
- [x] 커밋, 롤백, 세이브포인트, 실패한 문장만 되돌리기 (상세 10)
- [x] DDL 등 자동 커밋되는 문장 처리
- [x] 행 잠금, `SELECT ... FOR UPDATE`, 잠금 대기 제한, 교착 감지
- [x] READ COMMITTED : 커밋된 값과 자기 변경만 읽는다. 조회와 변경이 서로를 기다리게 하지 않는다
- [x] 커밋 시 디스크 반영(fsync) 후 응답 (저장 배치 커밋이 fsync 를 마친 뒤 돌아온다)
- [x] DDL 과 진행 중인 트랜잭션이 같은 객체에서 만났을 때의 처리
- [x] 10개 세션 동시성 테스트 (상세 9)
- [x] 세션 목록, 유휴 세션 종료(`session.idleTimeoutMs`), 세션을 닫을 때의 롤백, 데몬 정상 종료 때의 롤백
- [x] 6단계 점검 보완에서 `0A000` 으로 막아 둔 문장을 풀었다 : `BEGIN`, `START TRANSACTION`, `ROLLBACK`, `SAVEPOINT`, `ROLLBACK TO`, `RELEASE SAVEPOINT`, `SET AUTOCOMMIT OFF`. `regression.test.ts` 와 `catalog.test.ts` 의 단언을 7단계 동작으로 바꾸었다
- [x] DML 행 단위 접근 1부 : 읽기와 오버레이 계층 (2026-10-16 완료. 사용자 결정 : 보편적인 RDBMS 처럼 대상 행 단위로 접근하고 테이블 전체를 메모리 이미지로 올리지 않는다)
  - `Heap.iterate()` 지연 순회(`storage/format`), 오버레이를 PK 맵을 가진 클래스로(`txn/transaction.ts`, 행 단위 변경 `insertRow`·`updateRow`·`deleteRow`),
    읽기 계층 `txn/rowAccess.ts`(`visibleRows`, `visibleRowById`, `findVisibleByPk`, `findVisibleByIndex`, `mergeIndexEntries`), 조회와 DML 대상 찾기가 인덱스를 타고(자기 트랜잭션이 건드린 테이블 포함) 못 타면 지연 순회.
  - 시험 : `test/txn/rowAccess.test.ts` 11개(오버레이 PK 맵과 되돌리기, 읽기 함수, 인덱스 읽기와 전체 스캔이 같은 결과(무작위 시드 40개), PK 조회가 힙을 훑지 않음, 결함 주입 8건 모두 잡힘). 기존 시험 631개는 그대로 통과.
- [x] DML 행 단위 접근 2부 : **제약 검사, 참조동작, 커밋 쓰기, 커밋 때의 FK 재확인을 행 단위로** (2026-10-16 완료). `StatementImages`·`ImageRow`·`overlayToImage`를 없앴다.
  - `exec/rowChanges.ts` : 변경 행만 기록하고 NOT NULL·PK·FK 검사, 부모 키별 참조동작, 최종 무결성 검사, 문장 끝의 일괄 잠금. 인덱스 없는 자식은 키 묶음별 지연 순회와 행 식별자 재사용.
  - `exec/dml.ts` : 대입식·DEFAULT를 변경 전에 계산, 오버레이 직접 변경, 변경 행만 저장 배치에 쓰기, 옛 인덱스 항목 삭제 후 새 항목 삽입, 커밋 FK 재검사, TRUNCATE의 첫 참조 행 조기 중단.
  - 시험 : `test/txn/rowDml.test.ts` 16개. 2만 행의 PK 단건 INSERT·UPDATE·DELETE와 명시적 커밋에서 힙 순회 0회, 인덱스 없는 자식은 여러 부모 키를 한 번에 검사, 복합 FK·순환 CASCADE·SET NULL·문장 스냅샷·실패 되돌리기·잠금 재시도·커밋 경쟁·재구동 뒤 인덱스 확인.
- [x] 남은 마무리 : `SYS_SESSIONS` 연결과 문서를 8단계 착수 전에 끝냈다 (현재 상태 절의 "7단계 남은 마무리")
- 완료 기준 : 상세 9 의 10개 세션 동시성 테스트 통과. (충족)
  (`test/txn` 48개 + 데몬 1개. 잠금 관리자 단위 11개, 트랜잭션 시나리오 24개, 비동기 대기·제한 시간·교착·세션 종료 중 대기 12개, 10개 세션 동시성 1개.
  동시성 테스트는 세션 10개가 각각 15회 이체 트랜잭션(두 계좌 갱신 + 카운터 + 로그 삽입)을 하고 매번 합계 조회를 하며, 계좌 1·2 를 서로 반대 방향으로 오가게 해 교착을 부추긴다.
  교착이나 대기 초과가 나면 롤백하고 다시 한다. 끝난 뒤 계좌 합계, 카운터, 로그 건수, "같은 키를 모든 세션이 차지하려 해도 한 세션만 성공" 을 확인하고, 대기와 잠금이 남지 않은 것과 재구동 뒤 값이 같은 것을 본다.
  이 테스트는 세션을 프로세스 안에서 직접 쓰므로 네트워크를 거친 동시성은 11단계에서 다시 본다.)

### 8단계. 계정과 권한

- [x] SCRAM-SHA-256 검증 정보 생성과 저장 (상세 4). `auth/scram.ts`, RFC 7677 시험 벡터로 검증. 통신 계층이 쓸 메시지 함수와 없는 사용자용 가짜 검증 정보 포함
- [x] 최초 구동 시 SYSTEM 계정 생성. 초기 암호를 바꾸지 않았으면 구동 로그에 경고 (`Database.open`, `Server.start`)
- [x] `CREATE USER`, `ALTER USER`, `DROP USER [CASCADE]`
- [x] 객체 소유자 기록 (이미 6단계까지 `owner` 로 저장하고 있었다). `CREATE OR REPLACE VIEW` 가 소유자를 바꾸던 것을 고쳤다
- [x] GRANT, REVOKE (권한, 권한 그룹)와 실행 자격 검사 (상세 5, 6)
- [x] 문장별 권한 검사, 뷰 권한 규칙. 문장 실행 전에 구문 트리로 확인한다 (`auth/authorizer.ts`)
- [x] 딕셔너리 뷰는 권한이 있는 객체의 행만 보여 준다. `SYS_USERS`, `SYS_PRIVILEGES`, `SYS_GROUP_GRANTS` 도 채웠다
- [x] 사양 4 의 "기본 테이블스페이스가 없는 상태" : 현재 테이블스페이스가 없는 세션, `3F000`
- [x] 객체 삭제·이름 변경·테이블스페이스 삭제 때의 권한 기록 정리
- [x] `Database.login`(비밀번호 확인 + CONNECT 검사)을 두어 9단계가 쓸 입구를 마련했다
- 완료 기준 : 권한 조합별 허용, 거부 테스트 통과. 개요 5 의 뷰 UPDATE 예시 포함. (충족)
  (`test/auth` 50개(scram 10, accounts 16, privileges 24)와 데몬 초기 암호 경고 테스트 1개. 권한 조합별 허용·거부, 수준별 독립, 소유자, OFFICER·DBA, CONNECT·로컬 접속, 개요 5 의 `VIEW_SAMPLE1` UPDATE 예시, 딕셔너리 가시성, 영속성, 기록 정리를 확인했다.
  권한 검사기를 무력화한 빌드에서 테스트가 실패하는 것도 확인했다.)

### 9단계. 통신 (2026-10-16 완료)

설계는 [docs/communication-design.md](docs/communication-design.md), 확정한 프로토콜은 [docs/protocol.md](docs/protocol.md)에 있다. 작업 단위 9-1 ~ 9-10 은 설계 문서 15절의 번호이다.

- [x] 9-1 프로토콜 명세 확정 : [docs/protocol.md](docs/protocol.md), `net/protocol.ts`(메시지 정의, 요청 검증, 응답 해석), `net/resultEncoder.ts`(값·메타데이터·파라미터 변환), 오류 번호 8000 ~ 8007
- [x] 9-2 프레임 : `net/framing.ts`. 본문을 모으기 전에 길이를 검사한다(인증 전 64 KiB, 후 16 MiB)
- [x] 9-3 접속 정책 : `Database.connect`(로컬 판정, CONNECT 검사, `maxConnections`), `DatabaseOptions.maxConnections`, 세션의 접속 경로와 상대 주소, `SYS_SESSIONS` 의 `CHANNEL`·`CLIENT_ADDRESS`, `common/address.ts`(루프백 판정)
- [x] 9-4 메시지 처리기 : `net/messageHandler.ts`(상태 기계, SCRAM 인증, 문장 실행, 커서, 제어 요청, 대기열), `net/cursors.ts`, `net/connectionLimits.ts`
- [x] 9-5 로컬 전용 채널 + 클라이언트 : `net/localChannelServer.ts`, `net/streamConnection.ts`, `client/connection.ts`, `client/transports.ts`
- [x] 9-6 TCP + TLS : `net/tcpServer.ts`, 시험용 인증서(`test/fixtures/tls`), 클라이언트의 서버 인증서 검증과 재시도(100 ms 뒤 최대 2회, `08001`(8007))
- [x] 9-7 UDP 신뢰성 계층 : `net/udpReliability.ts`(패킷 코덱, 송신자·수신자, RFC 6298 RTO, 주입 가능한 시계와 통로), 시뮬레이터 `test/net/udpSim.ts`
- [x] 9-8 UDP 서버 + 클라이언트 UDP 전송 : `net/udpServer.ts`, `client/udpTransport.ts`, 손실 프록시 `test/net/udpProxy.ts`
- [x] 9-9 서버 조립과 제어 : `daemon/server.ts`(세 경로 열기와 닫기, 정상 종료 순서, `ControlPort`, `stopRequested`), `daemon/main.ts`
- [x] 9-10 마무리 점검 : config 검증 보강(`udp.maxPacketSize` 64 ~ 65,507, `udp.sessionTimeoutMs = 0` 구동 경고), bun 확인, 결함 주입 점검, 문서 갱신
- [x] 사용자 결정(2026-10-16) : `hwdb` 화면 문구는 영어만 쓰되 다국어를 붙일 수 있게 메시지 카탈로그로 분리했다(`cli/i18n.ts`, `cli/messages/en.ts`, 시험 `test/cli/i18n.test.ts`)
- 완료 기준 : 테스트용 클라이언트로 세 접속 경로 모두에서 로그인, 질의, 대량 결과 수신, 트랜잭션이 동작한다. UDP 는 패킷 유실과 중복을 일부러 일으킨 조건에서도 통과해야 한다. (충족)
  (`test/net` 10개 파일과 `test/daemon/serverAssembly.test.ts` : 로컬 전용 채널 19개, TCP·TLS 28개, UDP 서버 26개, UDP 신뢰성 계층 30개(시드 120개의 유실·중복·지연·순서 시험, 16 MiB 메시지 포함), 처리기 58개, 프로토콜 23개, 프레임 12개, 접속 정책 10개, 클라이언트 서버 확인 6개, 서버 조립 20개, 의존 범위(클라이언트와 공유 모듈이 서버 모듈을 import 하지 않음) 4개, `hwdb start --foreground` 실제 프로세스 1개.
  UDP 는 프록시로 유실 15 ~ 25%, 중복 10 ~ 100% 에서 로그인, 질의, 3,000행 결과, 트랜잭션, 10개 접속 동시 쓰기가 통과한다. Node.js 와 bun 모두 확인했다. 리눅스·macOS 의 유닉스 소켓은 Windows 개발 환경에서 실행해 보지 못했다.)


### 10단계. 데몬 제어와 CLI (2026-10-16 완료)

명령의 동작과 옵션은 [docs/cli.md](docs/cli.md)에 있다.

데몬 제어 (상세 14-1)

- [x] `hwdb start` : 데몬을 분리된 프로세스로 띄우기(`daemon/entry.ts`. `detached` + `windowsHide`, 출력은 로그 파일에 이어 붙임), 구동 완료 대기(로컬 전용 채널 `status` 의 `ready`), 실패 시 원인 표시(로그의 마지막 `[error]`), 이미 구동 중일 때의 처리(종료 코드 0), `--timeout`, `--foreground`
- [x] `hwdb stop` : 종료 요청, 프로세스가 사라질 때까지 대기. 구동 중이 아니면 알리고 0. 접속한 클라이언트가 소켓을 읽지 않아도 최대 약 2초 뒤 끝난다(`exitAfterShutdown`)
- [x] `hwdb status` : 구동 중이면 데몬이 알려 준 값과 종료 코드 0, 아니면 config.json 의 값과 1
- [x] 잠금 파일에 PID, 포트 번호, 구동 시각, 제어 토큰 기록(9단계까지 구현). 비정상 종료로 남은 것의 처리 : 죽은 PID 는 구동 중이 아닌 것으로 보고 덮어쓴다. PID 가 살아 있는데 로컬 전용 채널이 답하지 않으면 `unresponsive` 로 알리고 잠금 파일을 지우지 않는다. 오래된(10초) 잠금 생성 가드는 치운다. 남은 소켓 파일은 9단계의 `LocalChannelServer` 가 정리한다(유닉스는 미확인)
- [x] 데몬의 출력을 로그 파일로 보내기
- [x] Windows 확인 : 터미널(콘솔)을 닫아도 데몬이 남는지, 콘솔 창이 뜨지 않는지 (확인 내용은 위 "10단계 검증")

SQL 접속 (상세 14-2)

- [x] 명령행 옵션 처리. 모든 옵션을 생략할 수 있다 (`args.ts`)
- [x] 로컬 전용 채널 접속(기본), TCP 접속, UDP 접속. 데몬이 구동 중이 아니면 `hwdb start` 를 안내한다
- [x] `--ssl` 접속 : 서버 인증서를 기본으로 검증하고, 인증서 오류 때 클라이언트 라이브러리의 재시도(100 ms 뒤 최대 2회)를 표준 오류에 한 줄씩 알린다(`onCertRetry`). 최종 실패에는 `--ssl-ca`, `--ssl-no-verify` 를 안내한다
- [x] 사용자명 입력, 화면에 보이지 않는 비밀번호 입력 (`terminal.ts`)
- [x] 대화형 모드 : 여러 줄 입력, `;` 에서 실행, 입력 이력, `help`, `exit`, `quit`
- [x] 스크립트 모드 : `-e`, `-f`, 표준 입력. 오류 시 종료 코드 1
- [x] 문장 나누기 : 문자열과 주석 안의 `;` 는 문장 끝으로 보지 않는다 (`statementSplitter.ts`)
- [x] 결과 표 출력 : 한글처럼 폭이 넓은 문자의 칸 맞춤, 행 수와 소요 시간
- [x] SYSTEM 계정 초기 암호 변경 안내
- 완료 기준 : `hwdb start` 가 데몬을 띄우고 바로 돌아오며, 터미널을 닫아도 데몬이 남는다. `hwdb status` 와 `hwdb stop` 이 동작한다.
  설치 직후 `hwdb` 로 SYSTEM 에 로그인하여 초기 암호를 바꿀 수 있다. TCP 와 UDP 를 모두 껐거나 `maxConnections` 가 찬 상태에서도 로컬 접속이 된다. Windows 에서도 모두 확인한다. (충족)
  (`test/cli/daemonLifecycle.test.ts` 21개 : 실제 `hwdb` 프로세스로 start 가 바로 돌아오고(측정 0.4초 안팎) 데몬이 부모가 끝난 뒤에도 남는 것, status·stop, 재구동 뒤 데이터 유지, 초기 암호 변경 절차, 세 접속 경로, TCP·UDP 를 껐을 때와 `maxConnections` 가 찼을 때의 로컬 접속, 구동 실패 원인, 남은 잠금 파일, 두 인스턴스.
  터미널을 닫는 동작과 콘솔 창은 자동으로 확인할 수 없어 위 "10단계 검증"의 수동 확인을 따른다.)

### 11단계. 통합 검증

- [x] 네트워크를 거친 10개 세션 동시성 테스트 (`concurrency.test.ts` 10개 : 로컬·TCP·UDP 에 섞어 접속해 이체(교착 감지와 재시도로 합계 유지), 카운터, PK 경쟁, READ COMMITTED, 교착 `40P01`, 잠금 대기 `55P03`, 접속 끊김 뒤 잠금 해제, `maxConnections` 경계)
- [x] 개요 1 ~ 15 항목별 시나리오 테스트 (제목이 `개요 N :` 인 시험. 대응표는 [docs/verification.md](docs/verification.md) 1절)
- [x] 포트 번호가 다른 두 인스턴스를 한 장비에서 함께 구동 (상세 15) (`instances.test.ts` 5개 : 독립, 같은 포트·같은 데이터 디렉토리 거부, 포트 변경, 포트가 식별자인 것)
- [x] bun 에서 데몬 구동과 종료, 접속, 주요 시나리오 확인 (`bun test` 로 통합 시험 87개를 데몬까지 bun 으로 돌려 통과. 단위 시험 전체의 bun 실행은 2026-10-17 에 했다 — "미결 사항")
- [x] 이전 포맷 버전 호환성 테스트가 전체 테스트에 포함되어 있는지 확인 (`storage-v1.hwdb` 시험은 `test/storage`, 데이터 디렉토리 시험은 `dataDirCompat.test.ts`. `LATEST_FORMAT_VERSION` 이 오르면 이전 버전 자료가 없을 때 시험이 실패하는 버전 보호를 더했다)
- [x] 사용 설명서 : 설치, 데몬 구동과 종료, config.json, CLI 사용법, 초기 암호 변경 절차 ([docs/manual.md](docs/manual.md), [config.sample.json](config.sample.json))
- 완료 기준 : 개요 1 ~ 15 항목을 각각 확인하는 테스트가 있고 모두 통과한다. (충족)

#### 11단계에서 찾아 고친 결함

통합 시험을 만들며 제품 결함 넷을 찾았다. 모두 회귀 시험이 있고, 수정 전 코드에서 시험이 실패함을 확인했다. 자세한 것은 [docs/verification.md](docs/verification.md) 3절.

1. **타입이 정해지지 않은 `NULL` 리터럴** : `NVL(NULL, x)`, `COALESCE`, `NULLIF`, `1 + NULL`, `-NULL`, `CASE ... THEN NULL`, `UNION` 에서 결과 타입과 행의 값이 어긋났다. `NULL_LITERAL_TYPE`(`types/dataType.ts`, 참조 동일성으로 구별하는 표지)을 두어 상대 피연산자의 타입을 따르게 했다(`cast.ts commonType`, `arithmetic.ts`, `expression.ts`, `functions.ts`).
2. **데이터 파일 경로가 절대 경로로 기록** : 데이터 디렉토리를 복사하면(백업 복원, 인스턴스 이전) 옛 절대 경로를 찾았다. 데이터 디렉토리 안의 파일은 디렉토리 기준 상대 경로로 기록하고 이전 기록은 열 때 바꾼다(`catalog/tablespaceManager.ts`). `DATAFILE` 로 밖에 만든 것은 절대 경로이다.
3. **행 삽입 비용이 테이블 크기에 비례** : 행마다 힙 페이지 체인을 처음부터 따라갔다. 힙마다 메모리 빈자리 지도를 두었다(`storage/format/v1/heap.ts`, `context.ts`, `index.ts`. 지도는 힌트이고 쓸 때마다 검증하며 롤백·힙 삭제 때 버린다. 포맷 번호는 올리지 않았다. [docs/storage-v1.md](docs/storage-v1.md)). 1,000행 삽입이 테이블 크기와 무관하게 약 120 ms 이다. 인덱스 성능 시험이 예전에는 77초 걸려 행 수를 줄여야 했다.
4. **인덱스를 쓰는 범위 조건이 틀린 결과** : (a) 동등 조건 뒤 `DESC` 컬럼의 한쪽만 있는 범위는 하한·상한을 뒤바꿀 때 기본 경계까지 뒤바뀌어 항상 빈 결과였다. (b) 인덱스 컬럼이 범위 컬럼보다 더 있으면 앞쪽 컬럼만으로 만든 키로 "포함" 경계를 잡아 경계값 행이 빠졌다(`exec/executor.ts` `indexEntryIds`). 이전 포맷 호환성 시험이 먼저 드러냈다. 인덱스 정의 11가지 × 조건 약 600가지의 전수 비교에서 217건이 틀렸고 고친 뒤 0건이다. 갱신·삭제의 대상 탐색도 같은 코드를 쓴다.

## 미결 사항

해당 단계에서 정하고 "결정 사항" 으로 옮긴다.

- (2026-10-20 해소) Node.js 22.23.3으로 시험 러너·서버를 모두 실행해 최종 전체 949개 중 948개 통과·SIGTERM 1개 건너뜀·실패 0이다. TypeScript 6.0.3 컴파일도 통과했다.
- **리눅스, macOS 에서의 유닉스 소켓 확인**. 소켓 파일 권한 0600(umask 0177), 남은 소켓 파일 정리(연결을 시도해 죽은 소켓이면 지움), 클라이언트의 소켓 파일 소유자 확인은 구현했으나 Windows 개발 환경에서는 실행해 보지 못했다. 비윈도우 장비에서 `test/net/localChannel.test.ts` 를 돌려 확인하고, 소켓 파일 정리와 권한을 직접 보는 시험을 더한다.
- **리눅스, macOS 에서의 `hwdb start`**. 분리 구동(`detached` 로 새 세션, SIGHUP 무시)과 터미널을 닫는 동작은 Windows 개발 환경에서 실행해 보지 못했다. 비윈도우 장비에서 `test/cli/daemonLifecycle.test.ts` 를 돌리고, 터미널을 닫아도 데몬이 남는지 직접 본다.
- 실제 터미널 앱(Windows Terminal 등)의 탭을 닫는 동작은 확인하지 못했다(새 콘솔 창의 프로세스를 강제 종료하는 것으로 갈음했다). 데몬은 콘솔에 붙어 있지 않으므로 영향이 없다고 보지만 실제 장비에서 한 번 확인한다.
- (2026-10-20 해소) 실제 Oracle JDK 6u45 클라이언트와 Node.js 22 서버의 TLSv1 접속·준비 문장·취소를 검증했다. Java 7 이상은 TLSv1.2로 검증했다. 자바 5는 지원하지 않으며 Bun의 구버전 TLS 제약은 유지한다(protocol.md 16절).
- (11단계에서 해소) 동시 접속 부하에서의 교착 감지는 `test/integration/concurrency.test.ts` 가 로컬·TCP·UDP 세션 10개의 이체 부하(서로 반대 순서로 두 행을 잠금)로 확인한다.
- (2026-10-17 해소) **bun 으로 통합 시험을 돌린 뒤 데몬 프로세스가 남던 문제** : 재현하고 고쳤다. "결정 사항"의 "데몬 프로세스 누수 수정"을 본다.
- (2026-10-17 해소) bun 으로 단위 시험 전체를 돌렸다 : `test/integration` 을 뺀 801개 중 799개 통과, 2개 실패. 실패는 둘 다 `t.mock`(`node:test` 의 mock)을 쓰는 시험(`fsync` 실패 시험, 힙 삽입 시험)이다. bun 1.3.14 가 mock 을 구현하지 않아("mock is not yet implemented in Bun") 나는 오류이며 제품 결함이 아니다. 예전 bun 1.4.2 에서는 통과했다(기록은 위 "검증"). 통합 시험 87개는 파일마다 따로 돌려 85개 통과, 2개 건너뜀(bun 의 TLS 최소 버전 제약, Windows 의 SIGTERM)이다.
- (2026-10-20 해소) **뷰 컬럼 메타데이터와 인덱스 이름**: SYS_COLUMNS의 뷰 컬럼 제공과 JDBC 중복 보완 조회·UNKNOWN 매핑을 검증했다. CREATE INDEX의 한정하지 않은 이름은 대상 테이블의 테이블스페이스에 만들고, DROP INDEX는 현재 테이블스페이스에서 찾는다. 최종 서버 전체 회귀와 JDBC 컬럼 순서·패턴 시험을 통과했다.
- 통합 시험은 Windows 에서만 돌려 보았다. 리눅스·macOS 에서는 `test/integration/` 도 한 번 돌려 본다(원격 접속 시험은 루프백이 아닌 IPv4 주소가 필요하고 없으면 건너뛴다. SIGTERM 시험은 유닉스 계열에서만 돈다).
- 삭제 중인 PK 의 재삽입 대기, `ROLLBACK TO` 뒤의 잠금 해제, FK 부모 읽기 잠금 여부는 "7단계 알려진 한계" 에 있다. 사용자가 불편을 느끼면 정한다.
- 단순 조회의 지연 파이프라인과 파일 커서·정리·취소·동시성 검증을 완료했다. 정렬·집계·DISTINCT·집합 연산 등 복합 경로의 중간 결과는 여전히 메모리에 구체화할 수 있다. 외부 정렬 등 중간 메모리 제한은 별도 확장 범위이다.


## 점검 작업 사항 (2026-10-20 코드 점검)

2026-10-20 최초 점검은 수정 없이 발견 사항만 기록했다. 같은 날 후속 수정 요청을 받아 P-1 ~ P-4를 고쳤고 추가 점검의 P-5, P-6도 처리했다. 아래의 재현 설명과 행 번호는 최초 점검 시점을 기준으로 보존한다.

공통 조치 : `catalog.ts`의 `nameMap()`이 `Object.create(null)`로 이름 맵을 만든다. `tables`, `views`, `indexes`, `constraints`, SYSTEM의 `tablespaces`, `users`, `groups`에 생성과 JSON 역직렬화 양쪽에서 적용했다. `saveRegistry()`도 같은 맵에 기록한다. 이름을 금지하지 않으며 `"__proto__"`도 일반 키로 동작한다. 저장 JSON과 파일 포맷은 그대로이고 이전 v1 자료를 계속 읽는다.

- [x] **P-1 (인증, 중간) 없는 사용자 이름이 있는 사용자처럼 응답한다.** `auth/users.ts` 의 `has`(84행)와 `verifierOf`(183~185행)가 `users[name]` 을 일반 객체에서 찾는다. `constructor`, `toString`, `hasOwnProperty`, `__proto__` 같은 `Object.prototype` 속성 이름이면 `undefined` 대신 상속된 값을 돌려준다. `net/messageHandler.ts` 의 `resolveUserName`(418행)과 `onAuthStart`(437행)가 이를 실제 사용자로 받아 `s=undefined,i=undefined` 챌린지를 보낸다. 이어서 `onAuthFinish` 의 `verifyClientProof` 가 `TypeError` 를 던져 `XX000` 내부 오류가 되고, 스택이 오류 로그에 남는다. 없는 사용자는 `28000` 이므로 사양 상세 8("없는 사용자와 틀린 비밀번호를 구분하지 않고 같은 오류")에 어긋난다. 인증 우회는 아니다(증명 검사 전에 끊긴다).
  재현 : `authStart` 의 `clientFirst` 를 `n,,n=constructor,r=x` 로 보내고 `authFinish` 를 보낸다. `NOBODY` 와 응답을 비교한다(`NOBODY` 는 `28000`, `constructor` 는 `XX000`).
  조치 : 사용자 이름 맵의 프로토타입을 제거했다. 미등록 이름은 같은 SCRAM 절차 뒤 `28000`/7000으로 실패하고 오류 로그가 남지 않는다. 같은 이름으로 실제 계정을 만들면 인증된다(`test/net/messageHandler.test.ts`).

- [x] **P-2 (데이터 손실, 중간) `"__proto__"` 테이블스페이스가 재구동 뒤 사라진다.** `CREATE TABLESPACE "__proto__"` 는 성공하고 `SYS_TABLESPACES` 에도 보인다. 그러나 `catalog/tablespaceManager.ts` 의 `registry[name] = record`(299행)가 `Record` 에 프로토타입 설정자를 건드리므로 JSON 저장에서 빠진다. 재구동하면 목록에서 없어지고, 데이터 파일 `__proto__.hwdb` 는 고아로 남는다. 그 테이블스페이스를 기본으로 쓰던 사용자는 "기본 테이블스페이스 없음" 이 된다.
  재현 : `CREATE TABLESPACE "__proto__"` → 닫기 → 다시 열기 → `SELECT TABLESPACE_NAME FROM SYS_TABLESPACES`. 재구동 전에는 `__proto__` 가 보이고, 재구동 뒤에는 `SYSTEM` 만 남는다. 데이터 디렉토리에는 `__proto__.hwdb` 가 그대로 있다(확인함).
  조치 : 레지스트리 저장 때 프로토타입 없는 맵을 사용한다. 테이블스페이스 안의 행, 기본 테이블스페이스, 권한이 재구동 뒤에도 유지되는 시험을 추가했다. 이미 고아가 된 기존 파일은 자동 등록·삭제하지 않는다. 기존 데이터의 복구가 필요하면 별도 확인한다.

- [x] **P-3 (기능, 낮음~중간) 객체 이름이 `Object.prototype` 속성과 같으면 존재 판정이 틀린다.** 카탈로그, 권한, 사용자 조회가 모두 `data.tables[name] !== undefined` 같은 일반 객체 인덱싱이다. 큰따옴표 식별자는 대소문자를 보존하므로 `"constructor"`, `"toString"`, `"hasOwnProperty"` 가 그대로 들어온다.
  - `CREATE TABLE "constructor" (A INTEGER)` → 없는데도 `42P07`(4002) "Table already exists".
  - `SELECT * FROM "hasOwnProperty"` → `XX000` 내부 오류(`Cannot read properties of undefined (reading 'map')`). 사양상 `42P01` 이어야 한다.
  확인한 조회 지점 : `catalog/catalog.ts`(212, 375~445행), `exec/ddl.ts`(106, 227, 291, 1546~1547, 1581, 1610, 1629, 1747~1822행), `exec/analyzer.ts`(95~278행), `exec/dml.ts`(86~96, 361, 388행), `exec/rowChanges.ts`(119, 171행), `auth/privileges.ts`(76~80, 154~190, 407행), `auth/authorizer.ts`(114행), `session/session.ts`(763행). 이 밖에도 같은 형태가 있을 수 있으니 grep 으로 `[name] !== undefined` 과 `[name] =` 을 모두 찾는다.
  조치 : 카탈로그 이름 맵과 권한 그룹 맵을 모두 같은 규칙으로 정규화했다. 네 가지 이름의 테이블·뷰·컬럼·인덱스·PK 생성, DML, 이름 변경, 삭제, 중복 PK, 재열기 및 계정·권한 부여·회수 시험을 추가했다(`test/catalog/identifierNames.test.ts`).

- [x] **P-4 (일관성, 낮음) `ALTER USER` 가 없는 사용자에게 성공하고 전역 `Object` 를 바꾼다.** `ALTER USER "constructor" IDENTIFIED BY 'x'` 가 `User "constructor" altered.` 로 성공하고, 그 뒤 `Object.verifier` 가 생긴다. `auth/users.ts` 의 `require`(98행)가 `Object` 함수를 돌려주고 `setPassword` 가 그 속성을 쓰기 때문이다. `ALTER USER ... DEFAULT TABLESPACE` 도 `Object.defaultTablespace` 를 쓴다. 같은 이름의 `CREATE USER` 는 `42710` 으로 거부하므로 두 문장의 존재 판정이 서로 다르다. P-3 과 함께 고친다.
  조치 : 공통 이름 맵 수정으로 미등록 이름에는 `42704`를 반환한다. 비밀번호·기본 테이블스페이스 변경 실패 전후에 전역 `Object`와 `Object.prototype`의 속성 설명자가 동일함을 별도 시험으로 확인했다.

- [x] **최초 점검의 확인 기록 : 뷰 이름 `"__proto__"`도 기존에는 존재 검사에서 막혔다.** P-3 수정 후에는 정상 생성·교체·재열기·뷰 DML·삭제가 된다. 프로토타입을 바꾸지 않고 저장하는 것을 회귀 시험으로 확인했다.

확인한 것(문제 없음) : SCRAM 계산과 상수 시간 비교, 없는 사용자의 가짜 검증 정보(솔트는 이름과 구동 비밀값으로 고정), 인증 실패 응답의 통일과 200 ms 지연(`auth/scram.ts`, `messageHandler.ts`), 제어 요청의 로컬 전용 채널 한정과 제어 토큰 상수 시간 비교, 프로토콜 입력의 타입·범위·길이 검사와 파라미터 16진 검사(`net/protocol.ts` 409~536행, `net/resultEncoder.ts` 150행), 본문을 모으기 전 프레임 길이 검사(`net/framing.ts`), 인증 전 접속 수 제한과 `maxConnections`(TCP·UDP 세션만 셈), 권한 판정(`auth/authorizer.ts`, `auth/privileges.ts`. 사양 5 와 일치, OFFICER 는 SYSTEM 제외), 프로세스를 PID 로 끊는 경로 없음(`process.kill(pid, 0)` 은 생존 확인뿐), TLS 최소 버전과 클라이언트 인증서 검증 기본값(`net/tcpServer.ts`, `client/transports.ts` 245행).

후속 점검 범위 : UDP 서버·신뢰성 계층의 메시지 크기 제한과 인증 전 세션 수 제한, 저장 엔진의 체크섬·포인터·힙/오버플로/B+Tree 순환 방어, 세션의 문장 실패 되돌리기·잠금 대기·권한 재검사, CLI 인자와 설정 검증을 읽고 관련 기존 시험으로 확인했다. 이 범위에서 추가로 재현한 결함은 P-5, P-6이다. 모든 실행 환경을 증명하는 점검은 아니며, 앞의 "미결 사항"은 계속 남아 있다.

- [x] **P-5 (데이터 정합성·권한, 높음) 한정 이름과 잠금 구분자의 충돌.** `A."B.C"`와 `"A.B".C`를 모두 `A.B.C`로 이어 붙여 트랜잭션 오버레이, 뷰 순환 검사, 의존 객체 중복 제거, 뷰 소유자의 GRANT 자격 검사에서 같은 객체로 취급했다. 실제로 첫 테이블만 UPDATE한 뒤 두 번째 테이블에서도 변경값이 보였고, 뷰의 두 의존 객체 중 하나가 빠졌으며, 기반 테이블을 소유하지 않은 뷰 소유자의 GRANT가 성공했다. 잠금도 식별자의 U+001F와 내부 구분자가 충돌했다.
  조치 : `common/objectKey.ts`의 JSON 문자열 쌍을 위 경로 모두에서 사용한다. 표시용 객체명은 그대로이다. `test/catalog/qualifiedNames.test.ts` 4개와 `test/txn/lockManager.test.ts` 신규 1개는 수정 전 모두 실패, 수정 후 모두 통과했다. 정상적인 뷰 체인을 순환으로 오인하던 문제도 함께 해소했다.

- [x] **P-6 (자원 정리, 중간) 일반 테이블스페이스의 카탈로그 해석 실패 뒤 파일이 열린 채 남는다.** 저장 계층이 파일을 연 다음 `parseCatalog()`가 잘못된 JSON을 거부하면 사용 불가로 표시하지만 파일을 닫지 않았다. 손상된 APP 카탈로그로 재현했고, 사용 불가 판정 뒤에도 추적한 `PageFile.readPage(0)`이 성공했다.
  조치 : `openListed()`의 실패 경로에서 이미 연 테이블스페이스를 닫는다. `test/catalog/unavailableTablespace.test.ts`는 실제 손상 카탈로그를 만들고 APP 사용 불가·SYSTEM 정상 구동·파일 닫기를 확인한다.

- [x] **P-7 (시험 도우미, 중간) 채널 경로의 파일 존재 검사 결과가 false이면 데몬 종료 요청을 생략한다.** 최초 전체 시험 뒤 이번 실행에서 만든 임시 데몬 1개가 설치 디렉토리 없이 남은 것을 확인했다. `Daemon.dispose()`는 `livePids()`가 빈 목록이면 `hwdb stop`도 생략하고 디렉토리를 지웠다. 로컬 채널에 대한 `existsSync`를 false로 만드는 회귀 시험은 실제 데몬을 남겨 수정 전 실패했다. 최초 누수 순간의 파일 검사 결과는 사후 확정하지 못했다.
  조치 : 파일 존재 검사에 앞서 현재 설치의 실제 제어 채널로 `hwdb stop`을 항상 시도한다. 오래된 PID만 믿고 강제 종료하는 방식은 추가하지 않았다. `test/integration/cleanup.test.ts`는 실제 데몬으로 실패 조건을 주입하고 종료를 확인하며 실패해도 보관한 제어 토큰과 서버 PID로 자기 데몬만 정리한다. Node.js·Bun에서 통과했다. 최초 실행에서 남은 임시 데몬은 명령행·설치 경로·시작 시각을 다시 확인해 정리했다.

## 결정 사항

### 12단계(Node.js 드라이버) 중에 한 rdbms 쪽 수정 (2026-10-17)

- **데몬 프로세스 누수 수정** (시험 도우미 `test/integration/helpers.ts`. 제품 코드는 바꾸지 않았다)
  - 재현 : bun 으로 통합 시험을 파일마다 돌리면 `overviewNetwork.test` 뒤에 `daemon/entry.js` 가 하나 남았다. 설치 디렉토리 `hwdb-it-*` 는 이미 지워진 뒤였다. 나머지 파일에서는 남지 않았다.
  - 원인 : 상대 경로 시험이 `dataDir` 를 설치 디렉토리 밖(`hwdb-abs-*`)으로 바꿔 데몬을 다시 띄우고, 그 디렉토리를 `Daemon` 과 별개의 `t.after` 로 지웠다. 정리 훅의 실행 순서가 Node.js 와 bun 이 달라, bun 에서는 그 디렉토리(= 데몬의 잠금 파일)가 먼저 지워졌다. `Daemon.dispose` 는 **잠금 파일의 PID** 로만 데몬을 찾았으므로 데몬을 찾지 못하고 설치 디렉토리만 지웠다.
  - 수정 : (1) `Daemon` 이 지금까지 쓴 모든 데이터 디렉토리를 기억하고(`usedDataDirs`) 정리할 때 전부의 잠금 파일을 본다. 구동 때 본 데몬도 기억한다(`knownDaemons`). (2) 설치 디렉토리 밖의 임시 디렉토리는 `daemon.makeExtraDir()` 로 만들어 `Daemon` 이 데몬을 끝낸 **뒤에** 지운다. (3) 정리되지 않은 `Daemon` 은 프로세스가 끝날 때(`process.on("exit")`) 마지막으로 정리한다. (4) 디렉토리를 지우는 쪽은 `maxRetries` 로 다시 시도하고 실패해도 데몬을 먼저 끝낸다.
  - **PID 재사용 주의(고치는 중에 만든 결함)** : 처음에는 구동한 데몬의 PID 를 프로세스가 끝날 때까지 들고 있다가 종료 때 `SIGKILL` 을 보냈다. 이미 끝난 데몬의 PID 를 Windows 가 곧바로 다른 프로세스(병렬로 도는 다른 시험 파일의 새 데몬)에 주는 바람에, 전체 시험(`node --test`)에서 한 번 `overviewTxn` 의 시험이 `ECONNRESET` 으로 실패했다. 지금은 PID 를 오래 들고 있지 않고, **잠금 파일의 PID 가 살아 있으면서 그 포트의 로컬 전용 채널(네임드 파이프, 유닉스 소켓)이 열려 있을 때만** 도는 데몬으로 본다(`isDaemonAlive`). 데몬이 끝난 것을 확인할 때마다 기억에서 지운다.
  - 확인 : bun 으로 통합 시험을 파일마다 돌린 뒤 남은 `daemon/entry` 프로세스와 `hwdb-it-*` 디렉토리가 0 (수정 전 1 / 수정 뒤 두 번 모두 0), Node.js 전체 시험 3회(888·888·889개 중 887·887·888 통과, 1 건너뜀, 실패 0) 통과, 단위 시험이 쌓던 임시 디렉토리는 시험 전후 개수가 같다.
- **`CAST(? AS 숫자·날짜 타입)` 의 내부 오류(`XX000`)** : 문자열 파라미터를 숫자·날짜 타입으로 `CAST` 하면 `Cannot read properties of null (reading 'kind')` 가 났다. `evaluateExpression` 의 `Cast` 가 타입 없는 문자열 중 리터럴(`untyped` 표지)만 리터럴 해석(`castLiteral`)으로 보내고, 문자열 파라미터(`type` 이 null)는 놓쳐 `castValue` 에 null 타입을 넘겼다. 다른 곳이 쓰는 `untypedText()` 로 바꾸어 고쳤다(`exec/expression.ts`). 회귀 시험 `test/exec/regression.test.ts`("문자열 파라미터를 CAST 하면 …")를 더했고 수정 전 코드에서 실패함을 확인했다. `nodejsDriver` 의 통합 시험이 찾았다.
- **단위 시험이 만드는 임시 디렉토리 정리** : `config`, `lockFile`, `logger`, `server`, `daemonControl` 시험이 `os.tmpdir()` 에 만든 디렉토리를 지우지 않아 시험을 돌릴 때마다 수백 개가 쌓였다(`hwdb-config-*` 584개, `hwdb-lock-*` 139개 등). `test/tempDirs.ts` 의 `createTempDir()` 로 만들어 시험 프로세스가 끝날 때 지운다. 이미 쌓인 것은 지우지 않았다(`%TEMP%` 의 `hwdb-*`. 필요하면 사용자가 지운다).

### 11단계 결정

- **통합 시험은 실제 프로세스로 한다.** `test/integration/helpers.ts` 의 `Daemon` 이 시험마다 임시 설치 디렉토리와 비어 있는 포트의 config.json 을 만들고 `hwdb start` 로 데몬을 띄워, 로컬·TCP·TLS·UDP 로 `client/connection.ts` 의 `Connection` 을 연다. 시험이 끝나면 접속을 끊고 `hwdb stop`, 안 되면 강제 종료한 뒤 디렉토리를 지운다. `HWDB_TEST_RUNTIME` 으로 데몬만 다른 런타임에서 돌릴 수 있다.
  기본 포트(7410)는 쓰지 않는다. 기본값으로 구동하는 시험 하나만 7410 이 비어 있을 때 돈다. 원격 접속(CONNECT)은 이 장비의 루프백이 아닌 IPv4 주소로 접속해 실제로 확인한다(없으면 건너뜀).
- **`Daemon.hwdb` 는 `spawnSync` 이므로 시험 프로세스의 이벤트 루프가 막힌다.** 접속을 열어 둔 채 쓰면 그 접속이 응답을 읽지 못한다. 접속이 있는 시험은 `hwdbAsync` 를 쓰거나 `stopClean()`(접속을 모두 끊고 정상 종료)을 쓴다.
- **개요 N 항목은 제목이 `개요 N :` 로 시작하는 시험으로 확인한다.** 대응표는 [docs/verification.md](docs/verification.md)에 둔다. 새 시험을 더할 때도 제목 규칙을 따른다.
- **결함을 주입해 시험이 잡는지 확인한다**(프로젝트 관례). 소스를 바꾸고 빌드·시험한 뒤 반드시 원본으로 되돌리고 다시 빌드한다. 결함 주입이 현재 디렉토리에 파일을 남기거나(config 상대 경로 변이가 `rdbms/mydata`, `mylogs` 를 만들고 데몬을 남겼다) 프로세스를 남길 수 있으니 확인하고 지운다.
- **이전 포맷 버전 호환성 자료는 두 층이다.** 저장 엔진 계층 `test/fixtures/storage-v1.hwdb`(2단계)와 서버 전체 `test/fixtures/datadir-v<N>/`(11단계. `create-datadir.mjs` 로 만든다). 후자는 해시를 `dataDirCompat.test.ts` 에 고정하고, `LATEST_FORMAT_VERSION` 이 N 이면 `datadir-v1` ... `datadir-vN` 이 모두 있어야 통과한다(버전 보호). 포맷 버전을 올리기 **전**에 지금 버전의 자료를 먼저 만든다. 1.0 전의 의도적 변경(개요 3 예외)에는 자료·해시·기대값·README 를 함께 고친다.
- **힙 빈자리 지도는 포맷이 아니다.** 메모리에만 두는 힌트이며 파일에는 아무것도 더하지 않는다. 틀려도 안전해야 하므로 쓸 때마다 검증하고 맞지 않으면 다시 만든다. 지도를 고칠 때는 "틀린 지도" 시험(`test/storage/storage.test.ts`)이 계속 통과해야 한다.
- **인덱스 범위 탐색은 키 바이트 구간 `[start, end)` 로 통일했다.** 앞쪽 일부 컬럼으로 만든 키는 그것으로 시작하는 모든 키보다 작으므로 "포함/제외" 를 `prefixUpperBound` 로 바꾸어 구간 끝점을 정한다. 구간은 후보를 줄이기만 하고 조건은 호출자가 다시 거므로 과대 포함은 괜찮지만 누락은 안 된다. 이 코드를 고칠 때는 `test/exec/regression.test.ts` 의 전수 비교를 돌린다.
- **bun 으로 시험할 때** : `bun test` 는 시험 프로세스의 시간대를 UTC 로 둔다. 시간대에 기대는 기대값은 데몬을 돌리는 런타임에서 구한다. 시험 하나가 실패하면 뒤 시험이 "test() inside another test()" 로 연쇄 실패하므로 통합 시험은 파일마다 따로 돌린다.
- 사양(AGENTS.md)은 바꾸지 않았다.

- ES 모듈로 작성한다. `package.json` 에 `"type": "module"`, `tsconfig.json` 에 `module: NodeNext` 를 두었다.
  상대 경로 import 에는 확장자 `.js` 를 붙인다. (예 : `import { x } from "./x.js"`)
- 빌드 결과물은 `dist/src` 와 `dist/test` 로 나간다. `bin` 의 `hwdb` 는 `dist/src/cli/main.js` 를 가리킨다.
- 컴파일러는 타입스크립트 6 하나만 쓴다. `package.json` 의 개발 의존성이 `^6.0.3` 이라 `npm install` 로 7 이 들어오지 않는다. 7 로 올리지 않는다 (AGENTS.md 지켜야 할 사항 7).
  처음에는 7 로 빌드하고 6 으로 따로 검사하는 구성을 해 보았으나, 두 패키지의 `tsc` 명령이 충돌하여 사용자와 상의해 6 하나로 정했다. 그때 같은 코드가 7.0.2 에서도 컴파일되는 것은 확인했다.
- `tsconfig.json` 에는 타입스크립트 6 이 폐기 예정이라고 알리는 옵션을 넣지 않고, `ignoreDeprecations` 로 그 알림을 끄지도 않는다. 나중에 상위 버전으로 올릴 때를 위해서이다.
- 테스트 파일 이름은 `*.test.ts` 이다. 이 이름이어야 `npm test` 의 실행 대상이 된다.
- 1단계에서 정한 사항이다.
  - 잠금 파일 이름은 `helloworlddb.lock` 이며 데이터 디렉토리 안에 둔다. 로그 파일 이름은 `helloworlddb.log` 이며 로그 디렉토리 안에 둔다.
  - 내부 오류 번호는 `1 = 지원하지 않는 기능(0A000)`, `2 = 내부 오류(XX000)` 로 고정했다. 한 번 정한 번호는 바꾸거나 다른 뜻으로 다시 쓰지 않는다.
  - 구동 실패(설정 오류, 잠금 실패)는 SQLSTATE 없이 `StartupError` 로 다룬다. CLI 는 종료 코드 1 과 영문 메시지로 보여 준다.
  - `hwdb status` 는 1단계에서 잠금 파일과 PID 로만 판단하며 세션 수는 0으로 보여 준다. 로컬 전용 채널을 통한 상태 조회는 9~10단계에서 붙는다.
  - `HWDB_INSTALL_DIR` 환경 변수가 있으면 설치 디렉토리 대신 그 값을 쓴다. 시험용이며 `hwdb status` 테스트에서 임시 디렉토리를 가리키는 데 쓴다.
  - config.json 을 읽을 때 맨 앞의 BOM 이 있으면 떼고 해석한다. (Windows 메모장 대응)
  - 포그라운드 대기(`runForeground`)는 신호만 기다리면 이벤트 루프가 비어 프로세스가 바로 끝나므로, 60초 간격의 유지 타이머를 함께 둔다. 신호가 오면 타이머를 지우고 종료 절차를 시작한다.
- 소스 파일 맨 위 주석은 "담당, 관련 사양, 구현 단계" 형식을 지킨다. 구현하면서 담당 범위가 달라지면 주석도 함께 고친다.
- AGENTS.md 개요 1에 맞춰 고정소수 타입의 인자 전체 생략은 (10,3)으로 통일했다. 정밀도만 명시한 `(p)`는 기존 규칙대로 (p,0)이며 최대 정밀도는 38이다. `types/dataType.ts`의 `resolveExactNumericType()`을 사용하고 SQL 파서에서 기본값을 따로 중복 정의하지 않는다. 타입 인자 오류는 2000번(`22023`)이다. [docs/data-types.md](docs/data-types.md)를 참고한다.
- 타입 이름은 대소문자를 구분하지 않고 공백을 정규화한다. 별칭은 `resolveDataType()`에서 정규 타입으로 통일하며, 잘못된 인자 수/범위는 2000번(`22023`), 미지원 타입은 1번(`0A000`)으로 반환한다. 저장 형식은 아직 확정하지 않았으며 이후 `codec.ts`에서 별도로 구현한다.
- 명세에서 정하지 않은 `FLOAT(p)`의 상한은 IEEE 754 배정도 정밀도 53으로, INTERVAL 선행 정밀도 상한은 9로 정했다. INTERVAL 기본 선행 정밀도는 2, 초 소수 자릿수 기본값은 6이며 범위는 각각 1~9, 0~6이다. 세부 사항과 `resolveDataType()`의 인자 순서는 [docs/data-types.md](docs/data-types.md)를 따른다.
- 4단계에서 정한 사항이다. 전체 목록은 [docs/sql-syntax.md](docs/sql-syntax.md)에 있다.
  - 예약어는 문장과 절의 구조를 정하는 단어만 둔다(76개). 타입 이름, 함수 이름, `KEY`·`INDEX`·`USER`·`MESSAGE` 같은 나머지 키워드는 문맥으로 구별하여 이름으로 쓸 수 있게 했다. Hello World 샘플의 `MESSAGE`, 딕셔너리 뷰의 컬럼 이름이 따옴표 없이 쓰이도록 하기 위함이다.
  - 구문 분석기가 데이터 타입을 바로 해석하여 구문 트리에 `DataType`으로 담는다. 타입의 기본값을 두 곳에서 정의하지 않기 위함이다. 그 밖의 생략된 부분은 `null`로 남긴다.
  - 수 리터럴과 문자열 리터럴은 타입을 정하지 않고 표기만 남긴다. 값의 타입은 6단계의 분석기가 문맥으로 정한다. 수 리터럴 앞의 단항 부호만 리터럴에 합친다.
  - `AND`, `OR`은 피연산자를 나란히 담는 `Logical` 노드이다. 조건이 길게 이어져도 트리가 깊어지지 않는다.
  - 괄호가 겹친 곳이 질의인지 식(또는 조인)인지는 되돌려 읽지 않고, 안쪽 질의 뒤에 이어지는 토큰으로 한 번에 정한다. 되돌려 읽는 방식은 겹친 깊이에 지수적으로 느려지는 것을 실제로 확인하여 버렸다.
  - 겹친 깊이는 200, 구문 트리 깊이는 1,000 으로 제한하고 넘으면 `54001`이다. Node.js 에서 노드당 2프레임짜리 재귀 순회가 깊이 약 5,000 에서 스택을 넘기는 것을 재어 정한 값이다.
  - 오류 번호 3000(`42601` 문법 오류), 3001(`42622` 식별자 길이), 3002(`54001` 처리 한도)를 배정했다. `DbError`에 선택 항목 `position`을 추가했고, 위치는 메시지 끝에도 `(line L, column C).`로 적는다.
  - 사양의 구문에 없지만 뜻이 같거나 널리 쓰이는 표기를 더 받는다(쉼표 조인, `DEFAULT VALUES`, `IS TRUE`, `SET TRANSACTION ISOLATION LEVEL READ COMMITTED`, `INCLUDING CONTENTS AND DATAFILES` 등). `DROP INDEX`와 `CREATE VIEW`/`CREATE INDEX`의 `IF [NOT] EXISTS`처럼 사양에 없는 절은 넣지 않았다.
  - `BETWEEN`, `LIKE`, `DEFAULT`, 행 수 제한의 인자는 비교·논리 연산자를 포함하지 않는 식으로 읽는다. `DEFAULT 0 NOT NULL`의 `NOT`이 식의 일부로 읽히지 않게 하기 위함이다.
  - 한 번에 문장 하나만 받으며 빈 문장은 문법 오류이다. 여러 문장을 나누는 것은 10단계의 CLI 가 `sql/lexer.ts`의 토큰으로 한다.
- 3단계에서 정한 사항이다. 근거와 표는 [docs/data-types.md](docs/data-types.md)에 있다.
  - 실행 중의 값은 타입 꼬리표 없는 JavaScript 값(`SqlValue`)이고 타입 정의는 따로 다닌다. 정수는 폭과 무관하게 `bigint`, NUMERIC 은 `Decimal`, 날짜시간은 전용 클래스이다. 실행기는 식마다 타입을 정적으로 정해 두어야 한다. (결과 컬럼의 메타데이터에도 필요하다)
  - `WITH TIME ZONE` 값은 UTC 기준 마이크로초와 오프셋(분)을 가진다. 지역 이름은 저장하지 않는다. 오프셋 범위는 config.json 검증과 같은 -23:59 ~ +23:59 이다. 지역 이름 타임존의 오프셋은 분 단위로 반올림한다.
  - 길이를 넘는 문자열은 `22001`이되, 넘는 부분이 모두 공백이면 그 공백만 뗀다. 소수 초는 NUMERIC 의 소수부처럼 반올림한다. INTERVAL 은 종료 필드보다 작은 단위를 버린다.
  - `CHAR`끼리의 비교는 뒤쪽 공백을 뗀 뒤 코드 포인트 순으로 한다(공백을 채워 비교하는 방식이 아니다). 인덱스 키도 공백을 떼고 만든다.
  - 부동소수는 유한한 값만 받는다. NaN 과 무한대는 값이 될 수 없으므로 정렬 순서를 따로 정하지 않았다.
  - 암묵적 형변환의 계열, `CAST` 지원 조합, 문자열 → `BOOLEAN` 은 `TRUE`/`FALSE` 만 받는 것, 문자·이진 사이의 `CAST` 미지원을 정했다. 타입이 정해지지 않은 문자열은 `castLiteral`로 해석하며 이진 타입은 16진 문자열로 읽는다.
  - 연산 결과 타입 : 정수끼리는 적어도 `INTEGER`, `DECIMAL`은 정밀도 38 안에서 정수부를 먼저 지키는 식, `DATE - DATE`는 일수(`INTEGER`), 시각의 차이는 `INTERVAL DAY(9) TO SECOND`, 계산으로 얻은 기간의 선행 정밀도는 9 이다.
  - 타입 오류 번호 2001 ~ 2012 를 배정했다. 값의 표현이 타입과 어긋난 채 넘어오면 내부 오류(`XX000`)이다.
  - 값의 저장 형식은 포맷 v1 의 일부이다. 행은 컬럼 수와 NULL 비트맵을 앞에 두어, 저장된 컬럼이 정의보다 적으면 뒤쪽을 NULL 로 읽는다. (`ADD COLUMN`을 어떻게 처리할지는 5단계에서 정한다)
  - 뼈대에 없던 `types/errors.ts`, `types/arithmetic.ts`를 추가했다. 연산 결과 타입은 `cast.ts`가 아니라 `arithmetic.ts`가 맡는다.
- 5단계에서 정한 사항이다.
  - 카탈로그는 테이블스페이스 파일의 카탈로그 영역에 JSON(UTF-8)으로 둔다. `CatalogData`는 테이블, 뷰, 인덱스, 제약조건, 자동 이름 순번을 가지며 SYSTEM 만 `system.tablespaces` 레지스트리를 함께 가진다. `parseCatalog`는 빠진 항목을 빈 값으로 채워 앞으로 항목이 늘어나도 읽는다.
  - `DATAFILE` 생략은 `<dataDir>/<이름>.hwdb`이며, 상대 경로는 데이터 디렉토리 기준이다. `CHARACTER SET`은 `UTF8`만 받는다.
  - `ADD COLUMN`은 기본값이 없으면(NULL) 기존 행을 다시 쓰지 않는다. 행 형식에 컬럼 수를 앞에 두므로 저장된 컬럼이 적으면 뒤쪽을 NULL 로 읽는다. 기본값이 있으면 6단계 점검 보완에서 기존 행을 다시 쓰도록 바꾸었다(아래 "6단계 점검 보완" 참조).
  - FK 타입 일치는 `formatDataType` 표기가 같은지로 본다. 같은 테이블스페이스의 PK 만 참조할 수 있으며 컬럼 수와 순서가 맞아야 한다.
  - `SYS_` 와 `DUAL` 예약은 SYSTEM 에서만 막는다. 다른 테이블스페이스에서는 같은 이름의 사용자 객체가 먼저이며, 없을 때만 딕셔너리·DUAL 로 푼다.
  - 딕셔너리 12개 뷰의 컬럼은 `catalog/dictionaryViews.ts`에 고정했다. `SYS_USERS`, `SYS_PRIVILEGES`, `SYS_GROUP_GRANTS`는 8단계까지 비어 있다. `SYS_SESSIONS`는 7단계에서 컬럼을 5개로 늘렸고(아래 7단계 항목) 내용 연결은 "7단계 남은 마무리"에 있다. `DUAL`은 저장하지 않는 가상 한 행(`DUMMY VARCHAR(1) = 'X'`)이다.
  - DDL 오류 번호 4000 ~ 4017 을 배정했다. `3D000` 테이블스페이스 없음, `42P06` 중복, `42P07` 중복 테이블·뷰, `42P01` 없음, `42701`·`42703` 컬럼 중복·없음, `42710`·`42704` 제약·인덱스 중복·없음, `42P16`·`42P17` 잘못된 정의, `55006` 사용 중, `42602` 예약 이름, `54011` 컬럼 초과이다.
  - 세션의 SELECT 는 5단계에서 딕셔너리·DUAL·FROM 없는 리터럴만 받는다. `WHERE`, `ORDER BY`, 행 수 제한, 조인, 집합 연산은 `0A000`으로 알리고 6단계에서 푼다.
  - 데몬(`daemon/server.ts`)은 구동 때 `TablespaceManager.open`으로 SYSTEM 과 목록을 함께 열고, 종료 때 닫아 정상 종료 표시를 쓴다. SYSTEM 이 손상되면 구동에 실패하고 나머지는 사용 불가로 두고 구동한다.
- 6단계에서 정한 사항이다.
  - 식 평가는 기대 타입을 아래로 넘긴다. 타입 없는 문자열(리터럴·문자열 파라미터)은 문맥 타입으로 `castLiteral` 해석하고, 수 리터럴은 크기별 INTEGER·BIGINT·DECIMAL(p,s), FLOAT는 DOUBLE로 묶는다. INTERVAL 리터럴은 값이 선행 정밀도를 넘으면 9까지 넓힌다.
  - NULL은 비교·BETWEEN·IN·COALESCE·NULLIF·NVL에서 상대 타입에 적응한다. 비교에 NULL이 섞이면 타입이 달라도 UNKNOWN이며 오류가 아니다.
  - 범위에는 깊이를 둔다. 안쪽이 바깥을 가리고 같은 깊이에 둘이면 `42702`이다. USING 병합 열은 오른쪽에서 가리고, 바깥 조인에서 비는 쪽의 병합 열은 살아 있는 쪽 값으로 채운다.
  - 뷰 안의 생략된 이름은 뷰의 테이블스페이스에서 찾는다. 뷰 순환은 `42P17`이다.
  - GROUP BY 검사는 집계 없는 식 전체가 GROUP BY 식과 같거나(예 : `GROUP BY SUBSTRING`의 그 식), 집계 안의 바깥 열이 GROUP BY에 있어야 한다. 상수는 항상 된다.
  - 6단계 DML은 문장 단위 메모리 이미지로 NOT NULL·PK·FK와 참조동작을 구현했다. 7단계에서는 오버레이와 커밋 쓰기를 붙였고, 2026-10-16 행 단위 접근 2부에서 전체 이미지를 없앴다. 현재 구조는 아래 행 단위 접근 구현과 `docs/transactions.md` 2-1절.
  - TRUNCATE는 참조하는 자식 행이 있으면 `23503`이다. `ALTER ... SET NOT NULL`과 PK·FK 추가, `DROP COLUMN`(힙 다시 쓰기와 인덱스 재구축)은 기존 행을 검사한다.
  - 인덱스 선택은 앞쪽 컬럼의 동등 묶음에 범위 하나이며, DESC 컬럼의 하한·상한을 뒤집는다. `CREATE INDEX`와 PK 추가는 기존 행을 백필한다.
  - 함수 결과 타입 : `POWER`·`SQRT`는 DOUBLE, `AVG`는 DECIMAL(38,6)·DOUBLE, `TO_CHAR`는 VARCHAR(4000), `TO_DATE`는 TIMESTAMP(0), `ROUND`는 소수 자릿수에 맞춘다. 날짜 요소(YYYY, YY, MM, DD, HH24, HH12, HH, MI, SS, FF1~FF6, AM, PM, 큰따옴표 고정 문자열)와 숫자 요소(9, 0, ., ,, FM)를 받으며, 넘치면 `#`으로 적는다. `YY`는 2000년대로 읽는다.
  - `LIKE`는 코드 포인트 단위로 견주며, `SUBSTR`의 음수 시작은 뒤에서 센다.
  - `?`는 문자열이면 문맥 타입으로, 아니면 `assignValue`로 맞춘다. 개수 불일치는 `07001`(5008)이다. DML 결과에 `rowCount`를 함께 둔다.
  - 실행 오류 번호 5000 ~ 5011 을 배정했다. `42702` 모호한 열, `42883` 정의되지 않은 함수·잘못된 인자, `21000` 스칼라 서브쿼리 행 수, `23502` NOT NULL, `23503` FK, `42803` GROUP BY, `07001` 파라미터, `42601` INSERT 값 개수(5011), `42804` 집합 연산 불일치(5010)이다. TO_DATE 형식 불일치는 `22007`이다.
  - `SELECT ... FOR UPDATE`는 6단계에서 잠금 없이 읽었고 7단계에서 실제 잠금을 건다. `UNION ALL` 사슬은 왼쪽부터 재귀로 풀며, 구문 트리 한도(1,000) 안에서는 스택이 넘치지 않는다.
  - DbError가 아닌 예외는 세션 입구에서 내부 오류(`XX000`)로 바꾸어 응답한다.
- 6단계 점검 보완에서 정한 사항이다. (2026-10-10, 다른 AI 가 만든 6단계 구현을 점검하며 직접 실행하여 찾은 결함)
  - `INTERVAL '1' DAY` 처럼 끝 필드가 없는 단일 필드 리터럴을 받는다. 선행 정밀도를 적지 않은 리터럴만 값에 맞추어 9까지 넓히며, 적어 둔 정밀도(`DAY(2)`)는 지킨다.
  - INSERT 의 VALUES 와 DEFAULT, UPDATE 의 SET 은 `toColumnValue`(암묵적 형변환, 길이·범위 검사)를 거친다. 계열이 다르면 `42804` 이다. DML 이 따로 가졌던 서브쿼리 핸들러(타입 쪽은 항상 INTEGER 를 돌려주던 것)를 버리고 `executor.ts` 의 `dataHandlers`·`typeHandlers` 를 같이 쓴다.
  - `ADD COLUMN` : DEFAULT 가 있으면 한 번 계산하여 기존 행을 `rewriteTableRows`(DROP COLUMN 과 같은 함수)로 다시 쓰고, 실패하면 카탈로그를 원래대로 되돌린다. 행이 있는 테이블에 DEFAULT 없는 NOT NULL 컬럼을 넣으면 `23502`, 행이 있는 테이블의 `REFERENCES` + NULL 이 아닌 DEFAULT 조합은 `0A000` 이다. `executeAlterTable` 이 `QueryContext` 를 받는다.
  - 딕셔너리 뷰와 `DUAL` 을 바꾸는 DML·DDL 은 `42809`(내부 번호 4018, `READ_ONLY_OBJECT`)이다. 이전에는 "없는 객체"로 보였다. SYSTEM 이 아닌 테이블스페이스에서는 같은 이름의 사용자 객체가 없을 때만 딕셔너리 객체로 본다(`assertNotDictionaryObject`).
  - 별칭을 준 FROM 출처는 별칭으로만 한정해 부른다. 이전에는 테이블 이름도 맞아서 `K LEFT JOIN K k2` 에서 `K.A` 가 `42702` 였다.
  - PK 유일성, FK 존재, TRUNCATE 의 참조 검사, `ADD PRIMARY KEY`·`ADD FOREIGN KEY` 의 기존 행 검사를 쌍마다 견주던 O(n²) 방식에서, 인덱스 키와 같은 인코딩의 문자열 집합(`tupleKey`) 방식으로 바꾸었다. CHAR 의 뒤쪽 공백을 무시하는 규칙은 인코딩이 그대로 보장한다. 7단계의 잠금 키 계산(`collectLockKeys`)도 같은 방식이다.
  - 7단계 전의 트랜잭션 문장은 `0A000` 이었다. 되돌리지 못하면서 성공을 알리던 것을 막기 위함이었고, 7단계에서 구현하며 풀렸다.
- 7단계에서 정한 사항이다. 구조는 코드의 머리 주석(`txn/transaction.ts`, `txn/lockManager.ts`, `session/session.ts`, `exec/dml.ts`)에도 있다.
  - 미커밋 변경은 데이터 파일에 쓰지 않고 트랜잭션이 메모리에 가진 오버레이(테이블마다 새로 넣은 행, 바꾼 커밋 행, 지운 커밋 행)에만 둔다. 읽을 때 커밋 값에 자기 오버레이를 덮어 보이고(READ COMMITTED, `visibleRows`·`findVisibleByPk` 등), 커밋할 때 짧은 저장 배치로 쓴다.
    쓰는 순간에는 다른 문장이 끼어들 수 없어(한 스레드, 동기 실행) 저장 배치의 `40001` 충돌이 생기지 않는다. 사양 상세 10 의 "커밋되지 않은 변경은 데이터 파일에 쓰지 않는다" 와 같다.
  - 자동 커밋 문장도 문장 하나짜리 트랜잭션 안에서 실행하고 문장 직후 커밋한다. 데이터 문장(SELECT·INSERT·UPDATE·DELETE)은 같은 경로를 쓰므로 `QueryContext.txn` 은 항상 있다.
  - 문장은 처음부터 끝까지 한 번에(동기로) 실행하고, 기다림은 문장과 문장 사이에서만 한다. 문장이 잠금 충돌을 만나면 그 문장의 변경을 되돌리고 충돌 오류(`55P03`, 충돌한 키를 담은 `LockConflictError`)를 던진다.
    `Session.execute`(동기)는 그대로 실패하고, `Session.executeAsync`(비동기)는 `lockTimeoutMs` 까지 그 키가 풀리기를 기다렸다가 **문장을 처음부터 다시 실행**한다. 그래서 기다린 쪽은 커밋된 새 값을 읽는다.
    한 문장은 일관된 커밋 상태에서 읽고 쓰므로 읽은 값과 건 잠금 사이에 다른 트랜잭션이 끼어들지 않는다. 잠금은 문장 끝에서 대상 행 전부를 한꺼번에 걸고(전부 걸리거나 하나도 안 걸림), 충돌하면 그 문장에서 적용한 오버레이 변경을 되돌린다.
  - 잠금 키는 세 종류이다. `R` 행(저장된 커밋 행을 바꾸거나 지우거나 FOR UPDATE 할 때), `K` PK 값(새 행을 넣거나 PK 를 바꿀 때. 같은 PK 를 동시에 넣으려는 쪽끼리 순서가 정해진다), `O` 객체(DDL 이 테이블 하나에 건다).
    객체 잠금은 같은 테이블의 행·PK 잠금과 서로 충돌한다. 모든 잠금은 배타이고 같은 소유자는 다시 걸 수 있다. 소유자는 트랜잭션 번호이며 DDL 문장도 자기 번호를 받는다.
  - 교착은 대기열에 들 때 대기 그래프(잠금 보유자와 같은 대기열에서 앞선 대기자)를 따라 고리를 찾아 감지한다. 고리를 닫은 쪽(방금 기다리려던 쪽)이 희생자이며, 그 트랜잭션을 통째로 롤백하고 `40P01` 을 알린다. 대기 초과는 `55P03` 이고 그 문장만 실패한다.
  - 읽은 값은 잠그지 않는다. 일반 SELECT 는 기다리지 않는다. `SELECT ... FOR UPDATE` 는 돌려주는 행(ORDER BY·OFFSET·FETCH 적용 뒤)의 저장 행에 행 잠금을 건다. 자동 커밋에서는 문장이 끝나면 풀린다.
    행을 그대로 돌려주지 않거나 기반 테이블이 아닌 출처를 쓰는 질의(DISTINCT, GROUP BY, 집계, 집합 연산, 괄호 질의, 뷰, 인라인 뷰, 딕셔너리 뷰)의 FOR UPDATE 는 조용히 넘기지 않고 `0A000` 이다. 기반 테이블끼리의 조인은 된다.
  - 자기 트랜잭션이 건드린 테이블도 인덱스 후보에 오버레이를 합쳐 읽는다(행 단위 접근 1부). 커밋 때 인덱스까지 함께 쓰므로 커밋 뒤에는 인덱스 조회도 새 값을 본다. 인덱스 항목은 커밋 때 지운 행과 바꾸기 전 값을 먼저 모두 지운 뒤 새 항목을 넣는다.
    (같은 PK 를 지우고 다시 넣거나 PK 값을 맞바꾸어도 유일 인덱스에서 부딪치지 않는다)
  - 커밋 때의 검사 두 가지. 1) 오버레이를 만들 때 적어 둔 테이블 정의 서명(컬럼 이름·타입, 힙 루트)이 지금과 같은지 본다. 다르거나 테이블이 없으면 `40001` 이고 트랜잭션은 롤백된다. PK 가 없는 테이블의 삽입은 잠금이 없어 DDL 과 부딪치지 않으므로 이 검사가 막는다.
    2) 여러 문장 트랜잭션(명시적 트랜잭션, 자동 커밋 OFF)에서 FK 로 엮인 테이블의 FK 를 커밋 값 + 자기 변경 기준으로 다시 확인한다. 어기면 `23503` 이고 롤백된다. 문장 하나짜리 트랜잭션은 문장과 커밋 사이에 끼어들 틈이 없어 생략한다.
  - 트랜잭션 문장의 규칙 : `BEGIN` 은 이미 트랜잭션이 있으면 `25001`, 없는 곳에서 `SAVEPOINT`·`ROLLBACK TO`·`RELEASE` 는 `25P01`(단, 자동 커밋 OFF 이면 `SAVEPOINT` 가 트랜잭션을 시작한다), 없는 세이브포인트는 `3B001`.
    `COMMIT`·`ROLLBACK` 은 트랜잭션이 없어도 오류가 아니다. `SET AUTOCOMMIT ON` 은 진행 중인 트랜잭션을 커밋한다(MySQL 과 같음). `ROLLBACK TO` 는 세이브포인트를 남기고 그 뒤의 세이브포인트만 지운다.
    SELECT 도 자동 커밋 OFF 에서는 트랜잭션을 시작한다. `SET TRANSACTION ISOLATION LEVEL` 은 READ COMMITTED 만 받는다. (파서 단계 규칙)
  - DDL(테이블스페이스·테이블·뷰·인덱스·TRUNCATE)은 실행 전에 진행 중인 트랜잭션을 커밋하고(커밋이 실패하면 DDL 은 실행하지 않는다), 대상 테이블과 FK 로 엮인 테이블에 객체 잠금을 걸어 실행한 뒤 푼다.
    다른 트랜잭션이 그 테이블의 행을 잠그고 있으면 동기 실행은 `55P03`, 비동기 실행은 기다린다. `DROP TABLESPACE` 는 그 안의 모든 테이블에 건다. 새로 만드는 객체는 잠그지 않는다. 실패한 DDL 도 앞선 커밋은 되돌리지 않는다.
  - 세션 : 번호(`id`)와 `lastActivity` 를 가지며 `Session.close(reason)` 이 커밋하지 않은 변경을 롤백하고 잠금을 풀고 대기를 취소(`08003`)한다. 닫힌 세션의 `execute` 는 `08003`.
    `SessionManager` 가 세션 목록과 유휴 세션 종료(`sweepIdle`, `idleTimeoutMs` > 0 이면 주기 타이머, `unref`)와 `closeAll` 을 맡는다. `Database.close()` 는 세션을 모두 닫고(이유 `shutdown`) 새 세션을 막은 뒤(`57P01`) 테이블스페이스를 닫는다.
    같은 세션의 비동기 문장은 호출 순서대로 하나씩 처리한다. (줄 세우기) 그래서 문장이 잠금을 기다리는 동안 같은 세션의 다음 문장도 기다린다. 다른 세션으로 조회해야 한다.
  - 데몬(`daemon/server.ts`)은 이제 `TablespaceManager` 대신 `Database` 를 연다. `config.json` 의 `timeZone`, `transaction.lockTimeoutMs`, `session.idleTimeoutMs` 를 넘기고, `stop()` 은 `Database.close()` 로 트랜잭션을 롤백한 뒤 정상 종료 표시를 쓴다. `getDatabase()` 를 9단계가 쓴다. 상태 조회의 세션 수는 `sessions.count` 이다.
  - 오류 번호 6000 ~ 6006 을 배정했다. 6000 `55P03` 잠금 대기 초과·충돌, 6001 `40P01` 교착, 6002 `3B001` 세이브포인트 없음, 6003 `08003`(`57P01` 도 이 번호) 세션 닫힘, 6004 `25001` 이미 트랜잭션 중, 6005 `25P01` 트랜잭션 없음, 6006 `40001` 커밋 때 전제가 깨짐.
    `withPosition` 이 잠금 충돌 오류의 `conflictKey` 를 잃지 않게 고쳤다.
  - `SYS_SESSIONS` 컬럼을 `SESSION_ID`, `USER_NAME`, `TABLESPACE_NAME`, `AUTOCOMMIT`(YES/NO), `IN_TRANSACTION`(YES/NO) 로 정했다. `SessionManager.list()` 가 원천이다. (연결은 남은 마무리)
  - 행 쓰기 도중 `heap.update` 가 RowId 를 바꾸지 않는다는 6단계의 가정을 그대로 쓴다. 바뀌는 구현이 되면 오버레이의 `pageId:slotId` 키 방식을 다시 봐야 한다.
- 8단계에서 정한 사항이다. 전체는 [docs/accounts-and-privileges.md](docs/accounts-and-privileges.md)에 있다.
  - 사용자, 권한, 권한 그룹 부여 내역은 SYSTEM 카탈로그의 `system`(`users`, `privileges`, `groups`)에 둔다. 읽을 때 빠진 항목을 빈 값으로 채우므로 포맷 번호는 올리지 않았다. 8단계 전의 데이터 디렉토리도 열리고, 열 때 SYSTEM 계정이 없으면 만든다.
  - 비밀번호는 SCRAM-SHA-256 검증 정보(솔트, 반복 횟수, StoredKey, ServerKey)로만 저장한다. 반복 횟수의 기본값은 4096(RFC 7677 권고 최소, PostgreSQL 기본)이고 `Database.open` 의 `scramIterations` 로 바꾼다(config.json 키는 만들지 않았다). 비밀번호는 NFKC 정규화만 한다(SASLprep 은 하지 않음).
  - 권한 검사는 문장을 실행하기 전에 구문 트리로 한다(`auth/authorizer.ts`). 문장에 적힌 객체만 보고 뷰는 펼치지 않으므로, 뷰에 권한이 있으면 기반 테이블의 권한은 보지 않는다(뷰 정의자의 권한). 실행기(`exec`)는 권한을 모른다.
    권한이 없으면 `42501` 로 문장이 시작도 하지 않는다. DDL 계열은 자동 커밋 전에 확인하여 거부된 문장이 트랜잭션을 커밋하지 않는다. 데이터 문장은 잠금을 기다렸다가 다시 시도할 때마다 확인한다.
  - 없는 객체는 권한 검사가 거부하지 않고 지나가 실행 단계의 "없음" 오류가 난다. 그래서 권한 없음(`42501`)과 없음(`42P01`)이 구별된다(PostgreSQL 과 같음).
  - 사양이 정하지 않은 규칙 : 대상 컬럼을 읽는 `UPDATE`·`DELETE` 에는 `SELECT` 를 요구하지 않는다(개요 5 의 뷰 UPDATE 예시를 그대로 따르기 위함). `SELECT ... FOR UPDATE` 는 `UPDATE` 도 요구한다. `CASCADE` 로 지워지는 FK·의존 뷰에는 별도 권한을 보지 않는다.
    `USE` 는 권한 없이 한다. 객체 수준 `CREATE` 는 줄 수 없다(`0LP01`). 자기 기본 테이블스페이스 변경은 DBA 만 한다. 빈 비밀번호는 거부한다.
  - 뷰 소유자 규칙 : 뷰 소유자는 ALTER, DROP 을 가지고, 따로 받은 뷰 권한이 없는 SELECT·INSERT·UPDATE·DELETE 는 뷰가 참조하는 모든 객체(재귀)에 대한 본인의 권한으로 판정한다. 뷰 권한을 GRANT 하려면 뷰가 직접·간접으로 참조하는 모든 객체의 소유자이기도 해야 한다.
    `CREATE OR REPLACE VIEW` 는 기존 뷰의 ALTER 가 필요하고 소유자를 바꾸지 않는다.
  - DBA 는 OFFICER 를 포함하지만 `groups` 에 펼쳐 저장하지 않고 판정 때 계산한다. CONNECT 는 포함하지 않는다. SYSTEM 의 삭제와 SYSTEM 의 DBA 회수는 `42501`(7008)이다.
  - 사용자 삭제는 접속 중이면 `55006`, 소유 객체가 있으면 `55006`, `CASCADE` 면 뷰와 테이블을 `CASCADE` 로 지운다. 받은 권한 기록도 지운다.
  - 객체를 지우거나 테이블스페이스를 지우면 권한 기록을 지운다. DDL 이 끝날 때마다 사라진 객체의 기록을 정리하는 방식이라 모든 삭제 경로(CASCADE 포함)를 한 곳에서 처리한다. 테이블 이름 변경은 권한 기록이 따라간다.
    지워진 테이블스페이스를 기본으로 쓰던 사용자는 기본 테이블스페이스가 없는 상태가 된다.
  - 현재 테이블스페이스가 없는 세션(`NO_TABLESPACE`, 빈 문자열)을 지원한다(사양 4). 테이블스페이스명이 없는 객체 이름은 `3F000`(7005), `DUAL`·딕셔너리 뷰·FROM 없는 SELECT 는 그대로 된다.
  - 딕셔너리 뷰는 `QueryContext.dictionary()` 가 돌려주는 원천(세션, 사용자, 권한, 판정자)으로 행을 만든다. 일반 사용자는 권한이 있는 객체의 행만 보고, `SYS_USERS`·`SYS_GROUP_GRANTS`·`SYS_SESSIONS` 는 자기 것만, `SYS_PRIVILEGES` 는 받은 기록과 자기 객체의 기록만 본다. 비밀번호 정보는 원천에 넘기지 않는다.
  - 오류 번호 7000 ~ 7008 을 배정했다. 7000 `28000` 인증 실패, 7001 `42501` 권한 없음, 7002 `42710` 사용자 있음, 7003 `42704` 사용자 없음, 7004 `0LP01` 줄 수 없는 권한, 7005 `3F000` 현재 테이블스페이스 없음, 7006 `28000` CONNECT 없는 원격 접속, 7007 `22023` 비밀번호 오류, 7008 `42501` 보호되는 계정.
  - `Database.login(사용자, 비밀번호, { local })` 은 비밀번호 확인과 CONNECT 검사를 한다. 없는 사용자도 같은 계산을 하고 같은 오류를 낸다. `createSession` 은 인증이 끝난 접속용이며 비밀번호를 보지 않고, 사용자는 있어야 한다. 기본 테이블스페이스는 사용자 설정을 따른다.
  - 데몬은 구동할 때 SYSTEM 이 초기 암호이면 경고를 로그에 남긴다(`INITIAL_PASSWORD_WARNING`).
- 9단계 설계에서 정한 사항이다. (2026-10-15, 구현은 아직 없다. 전체 설계는 [docs/communication-design.md](docs/communication-design.md))
  - 사용자가 정한 것 : (1) 클라이언트(접속용 CLI, 드라이버)는 TLS 서버 인증서를 **기본으로 검증** 한다. 인증서 오류로 접속에 실패하면 접속을 끊고 **100 ms 뒤 다시 시도하며 재시도는 최대 2회**(연결 시도는 최대 3번)이다. 재시도에서도 검증은 그대로 하고, 인증서 오류 코드에만 적용한다.
    최종 실패는 `08001`(내부 번호 8007, 클라이언트가 만드는 오류)이다. `SslOptions` 는 `ca`, `rejectUnauthorized`, `servername`, `certRetries`(2), `certRetryDelayMs`(100), `onCertRetry` 이다. 상세는 설계 문서 12-1절. AGENTS.md 상세 8 에 반영했다.
    (2) `SYS_SESSIONS` 끝에 `CHANNEL`, `CLIENT_ADDRESS` 열을 더한다. (3) `udp.sessionTimeoutMs = 0` 은 시간 제한 없음이고 구동 로그에 경고한다. (4) `udp.maxPacketSize` 는 64 이상 65,507 이하로 검증한다. (3), (4) 는 AGENTS.md 상세 7 에 반영했다.
  - 권장안을 그대로 쓰는 것 : (5) 인증 실패 시 접속을 끊고 응답 전에 200 ms 지연.
  - 설계가 정한 것(사양에 없던 것) : 메시지 봉투와 이름, 버전 협상, 인증 전 제한(10초, 64 KiB, `max(16, 2 × maxConnections)`), 커서 모델(홀더블, 16개), fetch 500행·1 MiB, UDP 패킷의 `ackSeq`·조각 창 32·메시지 단위 stop-and-wait, `Database.connect` 로 접속 정책 모으기, 오류 번호 8000 ~ 8007 안. 목록은 설계 문서 18절.
- **사용자 결정(2026-10-16)** 3건이다.
  - 화면 문구의 언어 : `hwdb` 의 사용법, 안내, 표 머리글, 경고, 명령행 오류 같은 화면 문구는 **지금 영어만** 낸다. 다만 언제든 다국어를 붙일 수 있게 문구를 코드에 박지 않고 메시지 카탈로그에서 키로 꺼낸다.
    구조 : `cli/messages/en.ts`(영어 카탈로그. 키가 전체 키 목록이다), `cli/i18n.ts`(`t(키, { 이름: 값 })`, 언어 이름 해석 `ko_KR.UTF-8` → `ko-kr` → `ko` → 영어, `registerCatalog`, `checkCatalog`).
    언어 선택은 환경 변수 `HWDB_LANG`, `LC_ALL`, `LC_MESSAGES`, `LANG` 순서이며 등록된 카탈로그가 없으면 영어이다. 카탈로그에 빠진 키는 영어로 채워진다.
    **새 언어를 더하는 방법** : (1) `cli/messages/<언어>.ts` 에 같은 키로 문구를 적는다(일부만 있어도 된다) (2) `cli/i18n.ts` 의 `registerBuiltinCatalogs` 에 `registerCatalog("<언어>", ...)` 를 한 줄 더한다 (3) `checkCatalog` 로 키와 `{이름}` 이 영어와 맞는지 시험한다. 호출하는 코드와 선택 규칙은 고치지 않는다.
    **새 화면 문구를 추가할 때** 는 영어 카탈로그에 키를 더하고 `t` 로 꺼낸다(10단계의 `hwdb` 가 이것을 따른다). DB 오류 메시지(AGENTS.md 상세 0 에 따라 영문 고정)와 서버 로그는 카탈로그를 쓰지 않는다. SQLSTATE 와 내부 오류 번호가 번역의 열쇠이다.
    지금 있는 `hwdb` 문구(사용법, 명령행 오류, `status` 출력, 구동 안내)를 모두 카탈로그로 옮겼고 영어 문구는 그대로이다. 초기 암호 경고는 서버 로그의 `INITIAL_PASSWORD_WARNING` 과 같은 영어 문구를 카탈로그에도 두었고, 같은 문구인지 시험한다.
  - DML 의 행 단위 접근 : 보편적인 RDBMS 처럼 **대상 행 단위로 접근**한다. INSERT·UPDATE·DELETE 가 테이블 전체(와 FK 로 얽힌 테이블)를 메모리 이미지로 올려 제약을 검사하고 되쓰는 지금의 방식(6단계)은 버린다.
    인덱스나 힙에서 대상 행만 읽고, PK 유일성은 인덱스, FK는 부모·자식의 인덱스나 지연 순회로 검사한다. 트랜잭션 오버레이와 잠금 키는 7단계 구조를 유지했다. 9단계 다음, 10단계 전에 마쳤으며 "알려진 한계"의 메모리 이미지 항목을 지웠다.
  - **행 단위 접근 1부 구현(2026-10-16)** : 읽기 쪽과 오버레이를 행 단위로 바꿨다. 오버레이는 `TableOverlay` 클래스이고 PK 값 → 오버레이 행 맵(`pkRefs`)을 변경과 되돌리기마다 같이 고친다. 읽기 계층은 `txn/rowAccess.ts` 이며 설명은 [docs/transactions.md](docs/transactions.md) 2절.
    인덱스로 얻은 후보에는 오버레이의 바뀐 행과 넣은 행이 모두 덧붙는다(상위 집합. 호출자가 조건을 다시 건다). `findVisibleByPk` 는 맵의 항목이 지금 값과 맞는지 한 번 더 확인한다.
  - **행 단위 접근 2부 구현** (2026-10-16 완료) : `exec/rowChanges.ts`로 변경 행의 제약·참조동작을 분리하고 전체 테이블 이미지를 없앴다. 구현 방침은 다음과 같다.
    1. 문장 안에서 변경을 오버레이에 **바로 적용**한다(`txn.insertRow`·`updateRow`·`deleteRow`. 되돌리기 항목이 남는다). 새 값은 변경을 하나도 적용하기 전에 모두 계산한다(UPDATE 의 서브쿼리가 자기 변경을 보는 일이 없도록. 지금의 문장 단위 스냅샷과 같다).
       문장이 실패하면 세션이 이미 `txn.truncateTo(mark)` 로 되돌린다(`attemptData`). 잠금은 지금처럼 **문장의 끝에서 한꺼번에**(`tryAcquireAll`) 걸고, 충돌하면 변경이 되돌려진 채로 충돌 오류를 던진다. 오류 우선순위(제약 위반이 잠금 충돌보다 먼저)도 지금과 같다.
    2. 변경 목록(`RowChange` : 테이블, 옛 값, 새 값, 행 식별. 값의 유무로 변경 종류를 구분)을 모아 문장 끝에서 검사한다. NOT NULL 은 변경된 행만. **PK 유일성**은 새로 넣은 행과 PK 가 바뀐 행마다 `findVisibleByPk` 가 둘 이상이면 `23505`(PK 가 그대로인 행은 건너뜀. 같은 문장 안의 PK 맞바꾸기는 최종 상태로 판정).
    3. **FK 자식 쪽** : 넣은 행과 FK 컬럼이 바뀐 행마다 부모를 `findVisibleByPk` 로 찾는다(`refColumns` 가 PK 컬럼의 순서만 다른 같은 집합이면 PK 순서로 바꿔 찾고, 그렇지 않으면 `visibleRows` 로 대조). NULL 이 섞이면 건너뜀. 없으면 `23503`.
       **FK 부모 쪽** : 지워진 행과 참조되는 키가 바뀐 행의 옛 키를 모은다. 그 키가 지금도 부모에 있으면(`findVisibleByPk`) 할 일이 없다. 사라졌으면 자식 행을 찾는다 — FK 컬럼이 앞쪽 컬럼인 인덱스(PK 포함)가 있으면 `findVisibleByIndex`, 없으면 자식 테이블을 `visibleRows`로 훑어 옛 키 집합과 대조(같은 전파 차례의 키 묶음당 한 번). 일치하는 행 식별자만 보관해 최종 검사에 재사용한다. 연쇄의 다음 차례에서 새로운 부모 키가 생겼을 때만 추가 탐색한다. 전체 자식 테이블의 키와 행을 메모리에 보관하지 않기 위한 선택이다.
       참조동작 : `CASCADE`(삭제는 자식 삭제, 갱신은 새 키로 바꿈), `SET NULL`(NOT NULL 컬럼이면 `23502`), 그 밖(`NO ACTION`, `RESTRICT`)은 연쇄 완료 후에도 참조가 남으면 `23503`. 자식 변경도 변경 목록에 들어가 같은 검사를 받고(자기 테이블 참조와 다단계 연쇄는 작업 목록으로 끝날 때까지),
       부모 쪽 동작은 그 부모 행의 변경 종류(삭제는 `onDelete`, 키 갱신은 `onUpdate`)를 따른다. 연쇄가 끝나면 연쇄로 바뀐 행에도 NOT NULL·PK 검사를 한다. 오류 번호와 메시지는 지금과 같게 유지한다.
    4. **커밋**(`commitTransaction`) : 오버레이에서 행을 바로 저장 배치에 쓴다(`writeOverlay`). 옛 인덱스 항목은 `heap.get(RowId)`의 옛 값으로 지우고, 지우기를 먼저 모두 한 뒤 새 항목을 넣는 순서는 유지한다. `overlayToImage`와 `ImageRow`를 없앴다. 테이블 정의 서명 확인(`40001`)은 그대로.
       **커밋 때의 FK 재확인**(`revalidateRowReferences`)도 오버레이의 변경 행만 본다 : 넣은·바꾼 자식 행의 부모 존재, 지운·키가 바뀐 부모 행의 자식 존재(연쇄 없이 위반이면 `23503`). 옛 값은 `heap.get` 으로 읽는다.
    5. `TRUNCATE` 의 참조 검사는 "자식 테이블에 NULL 이 아닌 FK 값이 있는 행이 하나라도 있으면 막는다" 로 줄인다(참조 무결성이 지켜지면 그 행은 부모에 있다). 자식 힙을 `iterate` 로 훑다가 첫 행에서 멈춘다.
    6. 시험 : 변경 목록의 동작은 문장별 결과·실패 되돌리기·잠금 재시도·세이브포인트로 검증한다. 기존 DML·제약·참조동작·트랜잭션 시험 전부, 큰 테이블(수만 행)에서 PK 로 1건 INSERT·UPDATE·DELETE 가 행 수와 무관하게 끝나는 것(힙 순회 횟수를 `V1Heap.prototype.iterate` 로 세어 0 을 확인), 무작위 DML 로 "행 단위 방식"과 "이전 이미지 방식"의 결과 비교는 기존 시험 전체로 갈음. 메모리 이미지 한계 항목을 이 문서와 `docs/transactions.md` 9절에서 지웠다. 그 밖의 한계는 유지한다.
  - 사양이 정하지 않은 사용자·권한 규칙 : 보편적인 RDBMS 의 동작을 따른다. [docs/accounts-and-privileges.md](docs/accounts-and-privileges.md) 8절의 규칙(대상 컬럼을 읽는 UPDATE·DELETE 에 SELECT 불필요, `SELECT ... FOR UPDATE` 는 UPDATE 요구, CASCADE 삭제는 별도 권한 없음,
    권한 없음과 객체 없음을 오류 번호로 구별 등)을 점검한 결과 PostgreSQL, Oracle 의 공통 동작이거나 AGENTS.md 개요 5 의 명시 문구를 따른 것이라 그대로 두었다. (대상 컬럼을 읽는 UPDATE·DELETE 에 SELECT 를 요구하지 않는 것은 Oracle 의 기본 동작이며, 개요 5 의 "뷰에 UPDATE 권한이 있으면 UPDATE 가 가능해야 한다" 를 조건 없이 지키기 위한 것이다.)
- 10단계에서 정한 사항이다. 동작은 [docs/cli.md](docs/cli.md)가 기준이다.
  - **구동 중인지는 PID 가 아니라 로컬 전용 채널의 상태 조회 응답으로 판단한다**(`probeDaemon`). PID 는 살아 있는데 답이 없으면 `unresponsive`(구동 중일 수도, 멈췄을 수도, PID 재사용일 수도 있음)이며 잠금 파일을 마음대로 지우지 않는다. 접속은 잠금 파일에 적힌 포트로 하므로 구동 뒤 config.json 의 `port` 를 바꿔도 떠 있는 데몬을 다룰 수 있다.
  - `hwdb start` 가 이미 구동 중일 때와 `hwdb stop` 이 구동 중이 아닐 때는 그 사실만 알리고 **종료 코드 0** 이다(AGENTS.md 14-1 에 명시). `status` 만 구동 중 0, 아니면 1.
  - 분리 구동은 `process.execPath`(Node.js 또는 bun)로 `daemon/entry.js` 를 `detached`, `windowsHide` 로 띄우고 표준 출력·오류를 로그 파일에 이어 붙인다. 부모는 0.1초마다 잠금 파일의 PID 와 `status.ready` 를 확인한다. 제한 시간이 지나면 정상 종료를 요청하고 5초 뒤 강제로 끝낸다. 실패 원인은 이번 구동이 쓴 로그 분량의 마지막 `[error]` 줄이다.
  - **정상 종료 절차를 마친 데몬은 직접 `process.exit` 한다**(`exitAfterShutdown`. 표준 출력·오류를 비운 뒤). 접속한 클라이언트가 소켓을 읽지도 닫지도 않으면 Windows 네임드 파이프는 서버 쪽 닫기가 끝나지 않아 이벤트 루프가 비지 않고 프로세스가 영원히 남았다. 이 상태에서 `hwdb stop` 은 최대 약 2초(소켓 닫기 유예) 뒤에 끝난다.
  - 문장 나누기는 SQL 어휘 분석과 같은 규칙(작은따옴표 문자열, 큰따옴표 식별자, `--` 와 `/* */` 주석, 중첩 없음)이다. 스크립트 모드에서 `exit`·`quit`·`help` 는 일반 문장으로 서버에 보낸다(AGENTS.md 14-2 에 명시). 서버에는 한 번에 한 문장만 보내며, 스크립트 모드는 입력 전체를 접속 전에 읽는다(UTF-8 이 아니면 로그인하지 않고 실패).
  - 출력 규칙 : 결과(표, 완료 메시지)는 표준 출력, 오류·안내·경고(초기 암호, 롤백, 인증서 재시도)는 표준 오류. NULL 은 `NULL`, 빈 문자열은 빈 칸. 숫자 타입은 오른쪽 맞춤. 표시 폭은 한글·한자·가나·전각·이모지 2칸, 결합 문자 0칸. 서버의 오류 위치(문장 안의 줄·칸)를 입력 파일의 줄·칸으로도 바꿔 알린다(앞선 문장이 같은 줄에 있으면 시작 칸을 더한다).
  - **종료 때 롤백 안내**는 `bye` 응답의 `rolledBack` 으로 정확히 알린다. 처음에는 `SYS_SESSIONS.IN_TRANSACTION` 으로 확인하려 했으나, `SET AUTOCOMMIT OFF` 인 세션에서는 확인 질의 자체가 트랜잭션을 열어 오탐이 되고 변경 없는 열린 트랜잭션도 알리게 되어 서버가 `Transaction.hasChanges()` 로 알려 주도록 했다. 프로토콜의 선택 필드이므로 프로토콜 버전은 올리지 않았다(없으면 false).
  - `-t` 의 값은 SQL 식별자 규칙으로 바꿔 보낸다(`tablespaceNameOf` : 따옴표 없으면 대문자, 큰따옴표면 그대로). 프로토콜의 `authStart.tablespace` 는 저장된 이름 그대로를 받는다(서버는 접는 처리를 하지 않는다). 드라이버도 사용자 입력을 받는 곳에서는 같은 변환을 해야 한다.
  - `--ssl-ca` 와 `--ssl-no-verify` 는 함께 쓸 수 없고 `--ssl` 이 있어야 한다. 짧은 옵션은 모두 값을 받는다(`-p` 도 값이 필요하다. 비밀번호를 물어보게 하려면 `-p` 를 쓰지 않는다). 모르는 옵션과 위치 인자는 오류 1이고 `Try: hwdb --help` 를 안내한다.
  - 잠금 생성 가드(`helloworlddb.lock.acquire`)가 10초 넘게 남아 있으면 강제 종료로 남은 것으로 보고 치운다. 10초 이내이면 다른 프로세스가 구동 중이므로 실패한다. 오래된 가드를 두 프로세스가 동시에 치우면 둘 다 잡을 수 있는 좁은 틈이 있으나, 이어지는 잠금 파일의 PID 검사가 한 번 더 막는다.
  - 시험 : 프로세스 안에서 데몬을 띄우는 시험(`daemonControl`, `sqlShell`)은 `hwdb` 를 `spawnSync` 로 실행하면 안 된다(이벤트 루프가 막혀 데몬이 답하지 못한다. 비동기 `spawn` 또는 프로세스 안의 `runSqlCommand` 를 쓴다). 실제 프로세스로 띄우는 시험은 `daemonLifecycle` 이며 정리할 때 잠금 파일의 PID 가 시험 프로세스 자신이면 끝내지 않는다.
- 9단계에서 정한 사항이다. 프로토콜의 규칙은 [docs/protocol.md](docs/protocol.md), 구조는 [docs/communication-design.md](docs/communication-design.md)(구현하며 달라진 점은 20절)가 기준이다.
  - 세션은 `Database.connect` 한 곳에서 만든다(로컬 판정, CONNECT 검사, `maxConnections`). 로컬 전용 채널은 세지도 막지도 않고, 루프백 주소의 TCP·UDP 는 로컬이지만 `maxConnections` 에는 센다.
  - 메시지 처리기는 접속마다 하나이고 소켓을 모른다(`ConnectionEndpoint`). 한 접속의 요청은 도착 순서대로 하나씩 처리하며(대기열 64개) `close` 만 건너뛴다. 보내기가 밀리면(`drained`) 다음 요청을 처리하지 않는다.
  - 사용자 이름은 정확히 같은 이름을 먼저, 없으면 대문자로 바꾼 이름을 찾는다. 인증 실패는 사용자 없음·비밀번호 틀림·nonce 불일치가 모두 같은 응답이고, 없는 사용자에게도 가짜 검증 정보로 끝까지 진행하며 실패하면 200 ms 늦춘 뒤 접속을 끊는다.
  - 클라이언트는 서버 nonce 가 자기 nonce 로 시작하는지, 반복 횟수가 범위 안인지, 서버 서명이 맞는지 검증하고 어긋나면 접속을 끊는다.
  - 종료 요청(`control stop`)은 `stopping` 을 보낸 뒤 `Server.stopRequested` 를 풀 뿐이고, 종료 절차는 `runForeground` 가 시작한다. `Server.stop()` 은 한 번만 실행한다. 정상 종료 순서 : 새 접속 받기 멈춤 → `Database.close()`(롤백, 정상 종료 표시) → 소켓 닫기 → 잠금 파일 제거.
  - `net.Server.close()` 의 콜백은 모든 접속이 끝나야 불리므로 `stopAccepting` 은 콜백을 기다리지 않는다. Windows 네임드 파이프는 듣기를 멈춘 뒤에도 기존 접속이 남아 있으면 새 연결이 대기하다가 연결 제한 시간에 실패한다.
  - UDP : 서버가 처음 보내는 응답이 확인되기 전의 재전송 한도는 4번(증폭 억제), 문장을 실행 중인 세션은 세션 시간 제한에서 제외, 인증을 마친 세션이 있는 주소에서 새 `SYN` 이 오면 옛 세션을 닫는다. 클라이언트의 ping 은 `Connection` 이 보낸다.
  - TLS : 서버는 `cert`, `key`, `minVersion`(와 구버전 허용 때 `ciphers`)을 Node.js 의 `tls.createServer` 에 직접 준다. 호스트 이름 불일치는 서버가 인증서를 실제로 보냈을 때만 인증서 오류(재시도 대상)로 본다.
  - bun : 네임드 파이프, TCP, UDP, SCRAM, 프레임, 커서는 Node.js 와 같게 동작한다. TLS 서버는 `minVersion` 을 적용하지 못한다(`TLSv1.2` 만 설정대로 지켜지고 `TLSv1.3`·구버전 허용은 구동 로그에 경고). 서버 구동 로그에 경고하는 것으로 정했고 구동 실패로 막지는 않았다.
  - 시험 : 데몬을 구동하는 시험은 기본 포트(7410)를 쓰지 않고 `writeFreePortConfig` 로 포트를 나눈다(시험 파일이 병렬로 돌고 인스턴스는 포트로 구분되므로). Windows 의 TCP 와 UDP 제외 포트 범위 때문에 `freePort()` 는 두 프로토콜과 두 바인드 주소를 모두 확인한다.
  - 오류 번호 8000 ~ 8007 을 배정했다. 8000 `08P01` 위반, 8001 `53300` 접속 수 초과, 8002 `57P05` 유휴 시간 초과, 8003 `54000` 처리 한도 초과, 8004 `34000` 커서 없음, 8005 `53400` 구성 한도 초과, 8006 `08006` 연결 실패(클라이언트), 8007 `08001` 인증서 검증 실패(클라이언트).
- 2단계에서 정한 사항이다.
  - [docs/storage-v1.md](docs/storage-v1.md)의 레이아웃을 사용한다. 리틀 엔디언, 8KB 페이지, CRC-32/ISO-HDLC, 고정 매직/버전 위치이다.
  - 공개 저장 API는 `storage/format/format.ts`에 있다. 힙/인덱스는 바이트열을 받고 SQL 타입은 해석하지 않는다. 타입별 복합 키와 ASC/DESC/NULL 인코딩은 3단계에서 구현한다.
  - 저장 배치는 커밋 페이지와 분리된 사본을 갖는다. 커밋 순서는 데이터 페이지 → 헤더 → fsync → 캐시 공개이다. LRU 퇴거와 롤백으로 미커밋 값을 쓰지 않는다. I/O 실패 뒤에는 저장소를 사용 불가로 두고 정상 종료 표시를 쓰지 않는다.
  - 다른 배치가 커밋한 뒤 오래된 배치의 커밋은 `40001`로 거부한다. 7단계 SQL 트랜잭션은 행 변경을 보관했다가 커밋 직전 최신 페이지 위에 적용해야 한다. 긴 SQL 트랜잭션을 저장 배치 하나에 대응시키지 않는다.
  - B+Tree는 가변 길이 키를 바이트 크기로 분할하며 삭제 시 병합과 루트 축소를 한다. 최소 충전율은 강제하지 않는다. 1,024바이트를 넘는 키도 오버플로 체인으로 지원한다.
  - 저장 오류 번호는 1000 I/O(`58030`), 1001 손상(`XX001`), 1002 API 인자(`22023`), 1003 배치 충돌(`40001`), 1004 유일 키 중복(`23505`)이다.
  - `test/fixtures/storage-v1.hwdb`는 고정 바이너리이다. 테스트에서 원본을 직접 열거나 재생성하지 않고 해시를 검증한 뒤 복사본을 사용한다. 1.0 출시 전에는 개요 3의 예외에 따라 포맷 번호를 유지한 변경이 가능하며, 의도적인 포맷 변경 시 문서와 자료도 함께 갱신한다.
  - 동기 I/O와 배치 단위 커밋을 사용한다. WAL/장애 복구와 다중 파일 장애 원자성은 초기 버전에서 제공하지 않는다.

## 인수인계 사항

- **2026-10-20 최신 인수인계**: [HANDOFF.md](HANDOFF.md)가 기준이며 최종 서버·호환 회귀와 문서 정리를 완료했다. 아래 단계별 인수인계는 당시의 기록이다. 예전의 뷰 컬럼·전체 결과 메모리·동기 실행·JDBC 보류 설명은 최신 상태로 읽지 않는다.

- 11단계까지 마쳤다. 12단계(Node.js 드라이버)가 이어받을 때 알아 둘 점이다.
  - **읽을 것** : [docs/manual.md](docs/manual.md)(사용자 관점), [docs/protocol.md](docs/protocol.md)(드라이버의 기준), [docs/verification.md](docs/verification.md)(무엇을 어떻게 확인했고 무엇을 못 했는지). 드라이버의 통합 시험은 `test/integration/helpers.ts` 의 `Daemon` 을 본뜨면 된다(이 도우미의 정리가 bun 에서 데몬을 남기던 문제는 2026-10-17 에 고쳤다 — "결정 사항". `nodejsDriver` 는 `rdbms` 의 시험 코드를 직접 import 하지 않고 `nodejsDriver/test/helpers/server.ts` 의 `TestServer` 로 `rdbms` 를 `hwdb start` 로 띄워 통합 시험을 한다. 빌드 결과물 `dist/src/cli/main.js` 와 `HWDB_INSTALL_DIR`, config.json 의 `port` 만 있으면 된다).
  - **12단계가 끝났다(2026-10-17).** `nodejsDriver` 의 통합 시험 100개가 실제 `rdbms` 로 통과한다. 드라이버가 알아낸 서버 동작과 수정은 위 "결정 사항"에 있다. 드라이버의 시험이 자기 프로세스 안에서 `hwdb` 를 `spawnSync` 로 부르면 접속이 응답을 읽지 못해 서버 종료가 유예 시간(수십 초)만큼 늦어진다(`TestServer.stopAsync` 를 쓴다).
  - 클라이언트 라이브러리의 출발점은 `src/client/connection.ts` 이다(`Connection.open(target)` → `login` → `execute`/`fetch`/`fetchAll`/`closeCursor`/`ping`/`close`). 결과의 값은 JSON 값이고 BIGINT·NUMERIC·날짜시간·INTERVAL 은 문자열, 이진은 16진 문자열이다(`bigint`, 정밀도를 잃지 않는 날짜시간 변환은 드라이버의 몫). 통합 시험이 쓰는 `exec`/`query`/`failure` 도우미가 사용 예이다.
  - 알아 둘 서버 동작 : 인증 실패는 `28000`(없는 사용자와 틀린 암호가 같은 오류), 원격 접속에 CONNECT 가 없으면 `28000`(내부 7006), 접속 수 초과는 `53300`, 잠금 대기 초과 `55P03`, 교착 `40P01`(그 트랜잭션은 롤백됨), 유휴 종료 `57P05`, 서버 종료 `57P01`, UDP 는 암호화되지 않는다, TLS 포트에 평문으로 접속하면 연결이 끊긴다(`08006`), 인증서 검증 실패는 100 ms 뒤 최대 2회 재시도 후 `08001`(내부 8007).
  - 서버가 만든 데이터 디렉토리는 복사해 옮길 수 있다(데이터 파일 경로는 디렉토리 기준으로 기록). 드라이버 통합 시험이 서버를 띄울 때 임시 디렉토리를 쓰면 된다.
  - 알려진 한계는 "미결 사항"과 [docs/verification.md](docs/verification.md) 6절이다. `SYS_COLUMNS` 에 뷰의 컬럼이 없는 것은 드라이버의 `getColumns` 류 메타데이터 API 를 만들 때 정해야 한다.
- JDBC 지원 기준(2026-10-16 사용자 결정) : `jdbc6`는 자바 6~7용 JDBC 4.0이며 같은 배포본을 자바 8 이상에서도 사용 가능해야 한다. `jdbc8`은 자바 8 이상용 JDBC 4.2이다. 자바 5는 지원하지 않는다. 두 드라이버 모두 현재 서버 프로토콜을 사용하며, 공통 프로토콜 코드는 자바 6 기준으로 작성한다 (AGENTS.md 상세 8-1). JDBC 개발 보류는 유지한다.
- 10단계까지 마쳤다. 11단계(통합 검증)와 12단계(Node.js 드라이버)가 이어받을 때 알아 둘 점이다.
  - **`hwdb` 는 모두 구현되어 있다.** 명령 문서는 [docs/cli.md](docs/cli.md). 11단계의 네트워크 시험은 `test/cli/helpers.ts`(`startServer` 로 프로세스 안에 데몬, `makeShellEnv`/`runSql` 로 가짜 입출력의 `hwdb`)와 `daemonLifecycle.test.ts`(실제 프로세스)를 본뜨면 된다. 10개 세션 시험은 실제 프로세스 데몬 하나에 `Connection` 열 개를 열면 된다.
  - 사용자 시나리오는 전부 `runSqlCommand(options, installDir, env)` 로 시험한다. `ShellEnvironment` 가 표준 입출력, 파일, 터미널 입력(`ask`, `askSecret`, `openLineSource`), 접속(`connect`)을 감싸므로 가짜를 끼우기 쉽다. 터미널 논리는 `terminal.ts` 의 함수에 가짜 스트림(`FakeTty`, 원시 모드를 흉내)을 준다.
  - **이 시험 프로세스 안의 데몬에 `hwdb` 를 `spawnSync` 로 부르지 않는다.** 이벤트 루프가 막혀 데몬이 답하지 못하고, `status` 는 `unresponsive` 로 판정한다.
  - 데몬 판정과 제어는 `cli/daemonControl.ts` 의 `probeDaemon(config)`(구동 중 / 아님 / 답 없음)이다. 드라이버나 DB툴이 데몬을 제어한다면 같은 방식을 쓴다 : 잠금 파일의 제어 토큰으로 로컬 전용 채널에 `status`·`stop`.
  - 프로토콜에 선택 필드 `bye.rolledBack` 이 생겼다([docs/protocol.md](docs/protocol.md) 6절). 드라이버는 `close` 의 응답에서 이를 읽어 사용자에게 알릴 수 있다(없으면 false). `Connection.close()` 는 이제 `{ rolledBack }` 을 돌려준다.
  - `daemon/main.ts` 의 `exitAfterShutdown` 때문에 `runForeground` 를 부르는 쪽(`hwdb start --foreground`, `daemon/entry.ts`)은 정상 종료 뒤 `process.exit` 한다. 프로세스 안에서 `runForeground` 를 직접 시험할 때는 이 함수를 부르지 않는다(`Server` 를 직접 쓰는 기존 시험처럼).
  - 화면 문구를 더하면 `cli/messages/en.ts` 에 키를 넣는다(`t(키)`). 키를 지우거나 이름을 바꾸면 `usage.text` 를 비교하는 시험(`i18n.test.ts`)과 이 키를 쓰는 곳을 함께 확인한다.
  - 알려진 한계 : 결과 전체를 서버와 클라이언트가 메모리에 모은 뒤 출력한다. 대화형 모드의 입력 이력은 파일에 저장하지 않는다. 리눅스·macOS 와 실제 터미널 앱의 탭 닫기는 확인하지 못했다("미결 사항").
- 9단계까지 마쳤다. 10단계(`hwdb`)와 12단계(Node.js 드라이버)가 이어받을 때 알아 둘 점이다.
  - **클라이언트는 이미 있다.** `client/connection.ts`(`Connection.open(target)` → `login` → `execute`/`fetch`/`fetchAll`/`closeCursor`/`ping`/`close`/`control`)와 `client/transports.ts`, `client/udpTransport.ts` 이다.
    `Target` 은 `{ kind: "local", port }`, `{ kind: "tcp", host, port, ssl? }`, `{ kind: "udp", host, port }` 이다. `hwdb` 는 이것을 그대로 쓰고, `nodejsDriver` 는 이것을 출발점으로 삼아 타입 변환(`bigint`, 날짜 등)과 커넥션 풀을 얹는다. 결과의 값은 JSON 값 그대로이다.
  - `hwdb status` / `hwdb stop` 은 `Connection.open({ kind: "local", port })` 로 `hello` 까지만 한 뒤 `control("status" | "stop", token)` 을 보낸다. 토큰은 데이터 디렉토리의 잠금 파일(`readLockFile(dataDir).controlToken`)에 있다. 연결이 거부되면 `isConnectionRefused(error)` 가 참이고, 이때 "`hwdb start` 로 구동하라" 고 안내한다.
    `stop` 은 응답(`stopping`) 뒤 서버가 접속을 닫고 종료 절차를 시작한다. 프로세스가 사라지는 것은 잠금 파일의 PID(`isProcessAlive`)로 확인한다. Windows 에서는 다른 프로세스가 보낸 SIGTERM 을 받을 수 없으므로 이 요청이 종료의 기본 경로이다.
  - SQL 접속(`hwdb`)의 `-t` 는 `login({ tablespace })`, 타임존은 `login({ timeZone })` 이다. 로그인 결과(`SessionInfo.tablespace`)가 `null` 이면 현재 테이블스페이스가 없는 것이므로 프롬프트와 안내에서 "없음" 으로 보여야 한다. SYSTEM 이 초기 암호이면(`HelloWorldDB`) 변경 안내를 보인다.
  - TLS 접속(`--ssl`)은 `ssl: { ca?, rejectUnauthorized?, onCertRetry? }` 를 준다. `onCertRetry` 로 재시도를 표준 오류에 한 줄씩 알리고(예: `certificate error (DEPTH_ZERO_SELF_SIGNED_CERT); retrying 1/2 ...`), 최종 실패(`08001`, 코드 8007)에서는 원인과 해결 방법(신뢰할 CA 지정, 검증 끄기)을 안내한다.
  - **화면 문구는 `cli/i18n.ts` 의 `t(키)` 로 꺼낸다**(사용자 결정 2026-10-16). 새 문구는 `cli/messages/en.ts` 에 키를 더한다. 언어 추가 방법은 "결정 사항"의 사용자 결정 첫 항목.
  - 데몬은 `runForeground`(`daemon/main.ts`)가 `Server` 를 구동하고, 종료 신호나 `Server.stopRequested` 로 종료한다. 분리된 프로세스로 띄우는 `hwdb start`(10단계)도 같은 `runForeground` 를 쓰면 된다. 구동 실패(포트 사용 중, 로컬 채널 중복, TLS 인증서 오류 등)는 `StartupError` 로 나오고 `Server.start` 가 열었던 것을 모두 정리한다.
  - 구동 로그(`Listening: ...`)에 열린 경로, 포트, TLS 사용 여부가 한 줄로 남는다. `hwdb start` 가 "접속을 받을 수 있게 되었음" 을 알리는 시점은 `Server.start()` 가 끝난 때이다(`runForeground` 의 `ready` 콜백).
  - 테스트 도우미 : `test/net/helpers.ts`(`FakeEndpoint`, `Driver`(소켓 없는 프로토콜 구동기), `makeEnvironment`, `freePort`, `writeFreePortConfig`, `waitFor`, `isBun`), `test/net/udpSim.ts`(가짜 시계와 유실·중복·지연 링크), `test/net/udpProxy.ts`(실제 소켓용 손실 프록시). 데몬을 구동하는 시험은 `writeFreePortConfig` 로 포트를 나눈다.
  - bun에서 `bun test --timeout 360000 dist/test/`로 전체를 한 번에 돌릴 수 있다(대량 시험 준비 시간 포함). 시험이 실패하면 bun 이 "test() inside another test()" 로 연쇄 오류를 내므로 첫 실패부터 본다.
  - 통신 계층에서 하지 않은 것 : 문장 취소, 서버가 먼저 보내는 알림(유휴·종료 통지 제외), 압축, UDP 구간 암호화, 클라이언트 인증서 인증, 조회의 스트리밍 실행(결과를 메모리에 모아 나누어 보낸다).

- 8단계까지 마쳤다. 9단계(통신)가 이어받을 때 알아 둘 점이다. 자세한 것은 [docs/accounts-and-privileges.md](docs/accounts-and-privileges.md)의 10절. **(9단계에서 모두 반영했다. `Database.connect` 가 `createSession`, `assertMayConnect`, `maxConnections`, 로컬 판정을 한곳에서 한다. 아래는 당시의 기록이다)**
  - 접속마다 SCRAM 교환을 한다. 서버는 `database.users.verifierOf(이름)` 의 검증 정보로 `parseClientFirst` → `serverFirstMessage` → `parseClientFinal` → `verifyClientProof` → `computeServerSignature` 순으로 처리한다(`auth/scram.ts`, RFC 7677 시험 벡터로 검증됨).
    없는 사용자에게는 `decoyVerifier(이름, 구동 때 정한 비밀값)` 를 쓰고, 마지막 실패 응답은 두 경우가 같아야 한다. `client/connection.ts` 는 `clientFirstMessage`, `computeClientProof`, `verifyServerSignature` 를 쓰면 된다.
  - 인증이 끝나면 `database.createSession({ user, tablespace })` 로 세션을 만든다. 원격 접속(루프백이 아닌 주소의 TCP·UDP)이면 그 앞에 `database.assertMayConnect(사용자, false)` 로 CONNECT 를 확인한다(`28000`, 7006). 로컬 전용 채널과 루프백은 `true` 로 부른다.
    `Database.login` 은 평문 비밀번호를 받으므로 프로세스 안에서만 쓴다(네트워크 경로에서 쓰지 않는다).
  - `maxConnections` 와 로컬 판정은 아직 `SessionManager` 에 없다. 9단계에서 붙인다. 접속 수 제한은 `database.sessions.count` 에서 로컬 전용 채널 세션을 뺀 수로 센다(세션에 접속 경로를 표시해야 한다).
  - 통신 계층은 `executeAsync` 를 쓴다. 권한 검사는 두 실행 방식 모두에서 같다. 권한 오류(`42501`)는 문장 오류이며 세션을 끊지 않는다.
  - 현재 테이블스페이스가 없는 세션이 있을 수 있다(`session.currentTablespace === ""`). 접속 응답이나 `hwdb` 의 프롬프트에서 이를 "없음" 으로 보여야 한다. `-t`(접속 직후의 테이블스페이스)는 `createSession({ tablespace })` 로 넘긴다.
  - 비밀번호가 든 문장(`CREATE USER`, `ALTER USER`)의 원문을 로그에 남길 때는 1단계의 로그 가림을 거친다. 구문 트리와 `Statement` 의 `password` 는 평문이다.
  - 새 문장 종류를 추가할 때는 `auth/authorizer.ts` 의 `authorizeStatement` 와 `session.ts` 의 `statementClass` 를 함께 고친다. 빠뜨리면 `never` 검사로 컴파일이 실패한다.
- **DML 행 단위 접근 완료(2026-10-16)**. 읽기와 오버레이(1부), 제약 검사·참조동작·커밋 쓰기·커밋 FK 재검사(2부)를 마쳤다. 전체 테이블 이미지는 없다. PK 단건 변경은 인덱스로 접근하고, FK의 부모는 PK 인덱스, 자식은 맞는 인덱스나 지연 순회로 찾는다.
  - `exec/rowChanges.ts`의 `RowChanges`가 변경 행만 기록하고 오버레이에 즉시 적용한다. 대입식과 DEFAULT는 적용 전에 모두 계산한다. 문장 실패나 잠금 충돌은 `Session.attemptData`가 문장 표시까지 되돌린다.
  - 제약 검사와 참조동작이 끝나면 `finishRowChanges`가 잠금을 한꺼번에 건다. 커밋은 `commitTransaction` → `writeOverlay`이며 변경 행만 저장 배치에 쓴다. 데이터 문장에서 저장 배치를 직접 열지 않는다.
  - 인덱스 없는 자식은 부모의 옛 키들을 묶어 한 번 훑고 일치한 행 식별자만 보관한다. 같은 키의 최종 검사에는 이를 재사용한다. 연쇄 다음 차례에서 새 부모 키가 생기면 추가로 탐색한다.
  - 조회 결과 전체의 스트리밍은 별도 미결 사항이다. 현재 결과·정렬·집계·커서는 여전히 결과를 모으며, DML은 변경할 대상 행만 모은다.
- **bun에서의 테스트** (2026-10-16 확인). Bun 1.4.2에서는 `node:test`의 `t.mock` 기반 fsync 실패 시험도 통과한다. 1.3.14의 `t.mock` 미구현 한계는 이전 검증 기록이다.
  2만 행 시험은 데이터 준비도 포함해 Bun에서 약 230초 걸려 개별 제한을 360초로 두었다. 전체 명령도 `bun test --timeout 360000 dist/test/`를 권장한다. `runtime-smoke.mjs`의 이전 Node.js/Bun 확인 결과는 유지한다.
- 7단계는 구현과 테스트를 마쳤고 "7단계 남은 마무리"만 남았다. 이어받을 때 알아 둘 점이다.
  - 작업을 중단한 시점의 코드는 컴파일에 오류가 없고 `npm test` 322개가 모두 통과한다. 반쯤 고친 파일은 없다. 다만 `catalog/dictionaryViews.ts` 가 `SYS_SESSIONS` 용 인자와 컬럼을 받도록 먼저 고쳐져 있어, 연결을 끝내기 전에는 그 뷰가 빈 결과이다. (해가 없는 상태)
  - SQL 을 실행하는 방법이 둘이다. 단위 테스트와 CLI 단순 실행은 `session.execute(sql, params)`(동기, 잠금 충돌 즉시 `55P03`)를 쓰고, 통신 계층(9단계)과 동시성 테스트는 `await session.executeAsync(sql, params)` 를 써야 기다림과 교착 감지가 동작한다. 두 방식은 같은 문장 실행 코드를 쓴다.
  - 9단계는 접속마다 `server.getDatabase().createSession(...)` 으로 세션을 만들고, 연결이 끊기면 `session.close()`, 접속 수 제한은 `database.sessions.count` 로 센다. 세션 종료 알림은 `session.onClose(listener)` 로 받는다. 로컬 판정과 `maxConnections`, CONNECT 검사는 아직 `SessionManager` 에 없다.
  - 8단계는 사용자와 권한 검사를 `Session` 의 문장 실행 앞(`executeStatementSync`/`executeStatementAsync` 의 분기 앞)에 넣으면 된다. `Database.createSession` 은 지금 인증 없이 `user` 문자열만 받는다. 문장 종류는 `session.ts` 맨 아래 `statementClass` 가 `data` / `ddl` / `control` / `unsupported` 로 나누며, 사용자·권한 문장은 현재 `unsupported`(`0A000`)이다. 구현하면서 `ddl` 쪽으로 옮기면 실행 전후의 자동 커밋이 그대로 적용된다.
  - 데이터 문장을 새로 추가하거나 DML 의 쓰기 경로를 고칠 때는 `exec/rowChanges.ts`의 `finishRowChanges`(제약 검사 + 일괄 잠금)와 `exec/dml.ts`의 `commitTransaction`(커밋 때 쓰기)을 거치게 해야 한다. 저장 배치를 문장에서 직접 열어 쓰면 트랜잭션 격리가 깨진다. (DDL 은 예외이며 `ddl.ts` 가 배치를 직접 연다)
  - 오버레이를 쓰는 읽기는 `txn/rowAccess.ts`의 행 단위 읽기 함수를 거친다. `readTableRows`는 전체 배열이 필요한 조회용 호환 경로이다. 힙을 직접 `scan()` 하는 곳(`exec/ddl.ts` 의 백필·검증)은 DDL 이 이미 트랜잭션을 커밋한 뒤 도므로 괜찮지만, 새로 데이터를 읽는 코드가 힙을 직접 읽으면 자기 변경이 안 보인다.
  - 테스트에서 같은 세션으로 `executeAsync` 두 개를 동시에 걸어 두면 뒤의 문장은 앞의 문장이 끝날 때까지 기다린다. 잠금을 기다리는 문장이 있을 때 확인용 조회는 다른 세션으로 해야 한다. (`test/txn/concurrency.test.ts` 가 그렇게 한다)
- 6단계까지 마쳤다. 조회와 DML을 내부 세션 API로 실행한다. (실제 호출 예는 `test/exec/query.test.ts`, `dml.test.ts`, `functions.test.ts`)
  - `Database.open(데이터디렉토리)`로 열고 `createSession({ user, tablespace })`으로 세션을 만든다. `session.execute(sql, params)`가 구문 분석부터 실행까지 맡는다.
  - 질의는 `exec/executor.ts`의 `executeQuery`가 맡는다. FROM 묶기 → WHERE → GROUP BY·HAVING → 투영 → DISTINCT → 집합 연산 → ORDER BY → 행 수 제한 순서이다.
  - 식은 `exec/expression.ts`가 값과 타입을 함께 계산하고, 함수는 `exec/functions.ts`가 맡는다. 서브쿼리 실행은 순환 import를 피하려고 호출자가 넘긴 핸들러로 한다.
  - DML은 `exec/dml.ts`가 대상을 찾고 오버레이에 적용하며 `exec/rowChanges.ts`가 변경 행의 제약과 참조동작을 검사한다(행 단위 접근 2부). INSERT ... SELECT의 원천 질의와 WHERE 탐색은 실행기를 재사용한다.
  - 인덱스가 필요한 읽기는 `exec/planner.ts`의 `chooseIndex`로 고른다. (PK·유일 인덱스 포함, 앞쪽 동등과 그 다음 컬럼의 범위) 단위 테스트에서 앞쪽·뒤쪽·범위 조건의 선택을 직접 본다.
  - 데몬은 구동 때 테이블스페이스를 함께 연다. `hwdb start --foreground` 뒤 `Database` 없이도 `SYSTEM.hwdb`가 생긴다.
- 1단계를 점검·보완하고 2단계를 마쳤다. `config`, `common`, 데몬/CLI의 1단계 범위와 `storage`에 기능 코드가 있다. SQL 실행/접속은 아직 구현되지 않았다.
- 3단계까지 마쳤다. 타입 시스템을 쓰는 순서는 다음과 같다. (실제 호출 예는 `test/types/codecStorage.test.ts`)
  - 타입 선언은 `resolveDataType(이름, ...인자)`로 `DataType`을 만든다. 식의 결과 타입은 `bindArithmetic`/`bindConcat`/`bindNegate`의 `resultType`, 여러 식을 함께 다룰 때는 `commonType`으로 정한다.
  - 값은 `castValue`(명시적), `assignValue`(암묵적, 계열 검사 포함), `castLiteral`(타입이 정해지지 않은 문자열)로 대상 타입에 맞춘 뒤에 저장하거나 비교한다. 이 함수들은 마지막에 `conformValue`를 거치므로 결과는 항상 타입에 맞는 값이다.
  - 저장은 `encodeRow`, 인덱스는 `encodeKey`. 키를 만들 값은 인덱스 컬럼의 타입으로 먼저 바꾼다. 앞쪽 컬럼 조건은 접두 키와 `prefixUpperBound`로 범위를 만든다.
  - 비교는 `compareNullable`(조건), `compareForSort`(정렬), `isNotDistinct`(GROUP BY, DISTINCT). 두 값이 모두 `CHAR`일 때만 `ignoreTrailingSpaces`를 준다.
  - 형변환과 날짜시간 연산에는 `TypeContext`(세션 타임존, 문장 시작 시각)가 필요하다. 세션이 문장마다 만들어 넘긴다.
- `EXTRACT`, `TO_CHAR`, `TO_DATE`, `MOD` 등 내장 함수는 6단계이다. 필요한 부품(`civilFromDays`, `splitTimeOfDay`, `Decimal.remainder`, `Decimal.round`)은 타입 모듈에 있다.
- 4단계까지 마쳤다. SQL 은 `parseStatement(sql)`로 구문 트리를 얻는다. 뒤 단계가 알아 둘 점은 다음과 같다.
  - 구문 트리는 문법만 담는다. 이름의 존재, 타입, 권한, 값의 범위는 보지 않았다. 예를 들어 `DATE 'abc'`, 없는 함수, `INSERT`의 값 개수 불일치, `GROUP BY` 없는 집계의 오용, `SELECT` 없는 곳의 `FOR UPDATE`는 그대로 통과한다.
  - 수 리터럴의 타입은 분석기가 정한다. `INTEGER` 종류는 값의 크기에 따라 `INTEGER`, `BIGINT`, `DECIMAL(n,0)`으로, `DECIMAL` 종류는 적힌 자릿수의 `DECIMAL(p,s)`로, `FLOAT` 종류는 `DOUBLE PRECISION`으로 보는 것을 권한다. 문자열 리터럴과 문자열로 온 `?` 파라미터는 `castLiteral`로 문맥의 타입에 맞춘다.
  - INTERVAL 리터럴은 한정자를 적힌 그대로 가진다. 선행 정밀도를 생략한 리터럴은 값의 자릿수에 맞추어 넓혀 주는 것을 권한다(`INTERVAL '100' DAY`가 오류가 되지 않도록).
  - 구문 트리를 재귀로 순회해도 된다. 깊이는 1,000 을 넘지 않는다. 6단계에서 최대 깊이의 식으로 분석기와 실행기가 스택을 넘기지 않는지 테스트한다. 세션은 그래도 `DbError`가 아닌 예외를 내부 오류로 바꾸어 응답해야 한다.
  - 뒤 단계의 오류에도 위치를 붙일 수 있다. 식과 객체 이름의 `position`을 `withPosition(error, position)`에 넘긴다.
  - 뷰 정의는 `CreateViewStatement.queryText`(질의의 원문)를 카탈로그에 저장하고, 쓸 때 다시 구문 분석하는 방식을 염두에 두었다. 구문 트리 자체를 저장 형식으로 삼지 않는다.
  - 비밀번호가 든 문장(`CREATE USER`, `ALTER USER`)의 원문을 로그에 남길 때는 1단계의 로그 가림을 거친다. 구문 트리의 `password`는 평문이다.
- 저장 API의 실제 호출 예와 검증은 `test/storage/storage.test.ts`, Node.js/bun 실행 경로는 `test/storage/runtime-smoke.mjs`를 참고한다. 저장 배치 중 오류가 나면 호출자가 해당 배치를 롤백해야 한다.
- 5단계에서 SYSTEM 자동 생성과 데몬 조립을 붙였다. `hwdb start --foreground`는 데이터 디렉토리에 `SYSTEM.hwdb`를 만들고 목록의 테이블스페이스를 함께 연다. 네트워크 리스너는 9단계까지 열지 않으므로 로그는 설정 상태로만 표현한다.
- 저장 API 호출자는 파일을 독점 사용해야 한다. 데몬에서 연결할 때 데이터 디렉토리 잠금을 먼저 확보하고 마지막에 해제한다.
- 타입스크립트 코드를 고쳤으면 `npm test` 로 확인한다. 타입스크립트 6 으로 빌드하므로, 6 에 없는 문법이나 `tsconfig.json` 옵션을 쓰면 빌드에서 걸린다.
- 뼈대의 파일 나눔은 출발점이다. 구현하다가 파일을 더 나누거나 합쳐야 하면 그렇게 하고, 이 문서의 "디렉토리 구성" 을 함께 고친다. "모듈 사이의 의존 방향" 은 지킨다.
- 통신은 TCP, UDP, 로컬 전용 채널이다. 초기 계획에 있던 HTTP 웹소켓은 사양에서 빠졌으므로 웹소켓 구현이나 `ws` 패키지는 필요 없다.
- CLI 는 `nodejsDriver` 보다 먼저 만들어지므로 이 프로젝트 안에 클라이언트 코드를 가진다. 9단계의 테스트용 클라이언트와 CLI 가 같은 코드를 쓰게 하면 `nodejsDriver` 가 그것을 출발점으로 삼을 수 있다.
- 서버 실행 파일을 따로 두지 않는다. 명령은 `hwdb` 하나이고, 데몬은 `hwdb start` 가 분리된 프로세스로 띄운다. 9단계까지는 포그라운드 구동으로 개발하고 시험한다.
- Windows 에서는 다른 프로세스가 보낸 SIGTERM 을 받을 수 없다. 그래서 데몬의 정상 종료는 신호가 아니라 로컬 전용 채널의 종료 요청(`hwdb stop`)으로 한다. 신호 처리는 포그라운드 구동과 유닉스 계열을 위한 보조 수단이다.
- 포트 번호는 인스턴스의 식별자이지만 데이터와는 무관하다. 데이터 디렉토리나 데이터 파일의 이름, 내용에 포트 번호를 넣지 않는다 (상세 15).

## 작업 이력

- 2026-10-20 : JDBC8 후속 연동의 결과를 반영했다. 지정 JDK 8u202의 Java 8·21 기존 130개·새 API 50개·독립 소비자 6개가 Node.js 22 서버에서 통과했다. 서버·공유 프로토콜 소스와 저장 포맷은 변경하지 않았다. JDBC6·JDBC8 연동은 완료했으며 PD-6 ODBC와 Node.js·Python의 새 API는 후속이다.

- 2026-10-20 : 사용자 재개 요청에 따라 prepare/describe·cancel·조회 파일 커서·뷰 컬럼·인덱스 이름 생략의 남은 검토·수정·검증을 완료했다. IN·BETWEEN·CASE·서브쿼리 분석과 선언 타입 NULL, 결과 파일 생성 실패·부분 쓰기를 보완했다. Node.js 22 전체 949개 중 948개 통과·SIGTERM 1개 건너뜀, Bun 주요 167개와 최종 핵심 42개 통과. Node.js 116개·Python 3.2/3.13.1 각 124개·jdbc6 기존 255개/확장 85개/행렬 15개/독립 소비자 15개·jdbc8 기존 130개도 통과했다. PREPARE의 서버·호환 회귀를 완료하고 ODBC 한 항목을 남겼다. 규약·매뉴얼·각 진행 문서와 HANDOFF를 갱신했으며 커밋·푸시는 하지 않았다.

- 2026-10-20 : 사용자 요청으로 서버 prepare/describe·cancel 후속 구현과 조회/메타데이터 보완을 진행했다. 마지막 NULL/타입 힌트 오류 및 JDBC 뷰 컬럼 중복을 수정했다. 추가 지시에 따라 테스트를 다음 작업으로 남기고 종료했으며, 구현·진행 중 발견한 실패·이미 실행된 검증·미검증 범위와 재개 명령을 HANDOFF.md에 기록했다. 전체 완료로 판정하지 않았고 커밋·푸시는 하지 않았다.

- 2026-10-20: Windows ODBC 계획 중 사용자 추가 요청에 따라 [PREPARE.md](PREPARE.md)를 신설하고 다음 작업을 prepare/describe·cancel로 명시했다. 실행 없는 분석·준비 문장 수명·취소 가능한 실행 루프·요청 우선 처리·결과 경합·기존 드라이버 호환 검증을 PD-1 ~ PD-6으로 정리했다. 이번 변경은 계획 문서이며 서버 구현·프로토콜·기존 시험 결과를 바꾸지 않았다.

- 2026-10-08 : 세부 계획 작성.
- 2026-10-08 : 사양 변경 반영. 데몬 구동과 `hwdb start`, `stop`, `status` 추가, 포트 번호를 인스턴스 식별자로 사용(TCP 와 UDP 포트 통합), 패키지명 확정.
- 2026-10-08 : 1단계 착수. Node.js 프로젝트 구성(ES 모듈, TypeScript), 모듈별 뼈대 파일 52개 작성, 개발 의존성의 타입스크립트를 6 버전으로 고정. `npm test` 통과, Node.js 22.12 와 bun 1.3.14 에서 `hwdb --help` 실행 확인.
- 2026-10-08 : 1단계 완료. config.json 읽기(기본값, 검증, 모르는 키 경고, 상대 경로, BOM 처리), 로그(레벨, 파일 출력, 비밀번호 가림), 오류 체계(DbError 와 StartupError, 0A000), 데몬 진입점(포그라운드 구동, 잠금 파일, 정상 종료 뼈대), `hwdb start --foreground` 와 `hwdb status` 연결. `npm test` 29개 통과. 기본값과 config.json 각각으로 포그라운드 구동과 `status` 확인. bun 1.4.2 에서 `hwdb --help` 와 `status` 실행 확인.
- 2026-10-08 : 기존 구현 점검. 기존 29개 테스트 통과 확인 후 잠금 파일 생성 경쟁/소유자 확인, 잘못된 UTF-8/타임존 검증, SQL 주석과 미완성 리터럴의 비밀번호 가림, 로그 파일 오류/핸들 닫기, 포그라운드 종료와 실패 시 자원 정리를 보완했다.
- 2026-10-08 : 2단계 완료. 포맷/트랜잭션 설계 문서, 페이지 I/O, 포맷 선택, LRU/배치 캐시, 슬롯 힙/오버플로, 빈 페이지, B+Tree, 카탈로그 바이트 저장, 체크섬/정상 종료 표시와 v1 고정 자료를 추가했다. TypeScript 6.0.3, Node.js 24.19.0에서 `npm test` 51개 통과. bun 1.4.2 주요 실행 검증 통과.
- 2026-10-08 : AGENTS.md 변경 반영. DECIMAL/DEC/NUMERIC 전체 생략 시 (10,3), VARCHAR/NVARCHAR 최대·기본 길이 65,535를 기본값 상수와 고정소수 인자 해석에 적용하고 정책 테스트를 추가했다. 저장 포맷과 타입 코덱 주석에 1.0 출시 전 호환성 예외를 명시했다. `npm test` 54개와 bun의 고정소수 인자 해석 테스트 통과. 전체 타입 시스템과 SQL 연결은 후속 단계이다.
- 2026-10-08 : 3단계 타입 정의 작업. `resolveDataType()`에 ANSI 타입 정규화와 별칭, 기본값, 길이/정밀도 검증을 추가하고 `docs/data-types.md` 및 타입 테스트를 확장했다. 명세에 없던 FLOAT/INTERVAL 정밀도 경계는 결정 사항으로 기록했다. TypeScript 6.0.3 빌드 및 `npm test` 60개, Bun 1.3.14 타입 테스트 9개 통과. 값 표현과 저장/인덱스 키 코덱은 미완료이다.
- 2026-10-09 : 3단계 완료. `Decimal`(10진 정확 연산), 날짜시간·타임존·INTERVAL, 값 맞춤과 비교, 형변환, 연산 결과 타입, 행/인덱스 키 코덱을 구현하고 타입 문서와 저장 포맷 문서에 규칙과 바이트 형식을 적었다. `npm test` 153개(Node.js 24.21.0), bun 타입 테스트 102개 통과.
- 2026-10-09 : 4단계 완료. 어휘 분석, 구문 트리, 구문 분석(질의, DML, DDL, 테이블스페이스·사용자·권한, 트랜잭션·세션 문장)을 구현하고 [docs/sql-syntax.md](docs/sql-syntax.md)를 작성했다. 검토 중에 겹친 괄호의 되돌려 읽기가 지수적으로 느려지는 문제와 깊은 재귀의 스택 넘침을 발견하여, 한 번에 판정하는 방식과 깊이 한도(`54001`)로 고쳤다. `npm test` 233개, bun 타입·SQL 테스트 182개 통과. 저장 엔진의 `runtime-smoke.mjs`도 Node.js와 bun에서 다시 확인했다.
- 2026-10-10 : 5단계 완료. 내부 세션 API(`Database`, `Session`), SYSTEM 최초 생성과 테이블스페이스 관리, 테이블·뷰·인덱스 DDL(RESTRICT·CASCADE, PK·FK·NOT NULL, 자동 이름), `USE`와 딕셔너리 12개 뷰·`DUAL`, 데몬 구동 때 테이블스페이스 열기를 구현했다. 오류 번호 4000 ~ 4017 을 배정했다. `npm test` 246개, bun 타입·SQL 182개와 카탈로그 13개 통과.
- 2026-10-10 : 6단계 완료. 식 계산과 3값 논리, 전체 조회 파이프라인(조인 5종·USING 병합, 집계·GROUP BY·HAVING, DISTINCT, 집합 연산, 정렬, 행 수 제한), 상관 서브쿼리 5종, INSERT·UPDATE·DELETE·TRUNCATE와 NOT NULL·PK·FK·참조동작, 갱신 가능 뷰 DML, 내장 함수 전체와 NVL·TO_CHAR·TO_DATE, 파라미터 바인딩, 규칙 기반 인덱스 선택을 구현했다. 오류 번호 5000 ~ 5011 을 배정했다. `npm test` 273개, bun 222개 통과.
- 2026-10-10 : 6단계 점검 보완. 다른 AI 가 만든 구현을 읽고 직접 실행하여 결함을 찾아 고쳤다. (1) 단일 필드 INTERVAL 리터럴 전부 실패 (2) INSERT·UPDATE 의 스칼라 서브쿼리 값이 `XX000` (3) `ADD COLUMN` 의 DEFAULT 가 기존 행에 반영되지 않고 NOT NULL 컬럼이 행이 있는 테이블에 추가됨 (4) `BEGIN`·`ROLLBACK` 이 성공으로 답하면서 되돌리지 않음 (5) 딕셔너리 뷰·`DUAL` 변경 시 "없는 객체" 오류 (6) 자기 조인의 한정 이름이 모호함 (7) PK·FK 검사의 O(n²). 회귀 테스트 9개(`test/exec/regression.test.ts`)를 더했고, 그중 6개는 수정 전 코드에서 실패함을 확인했다. `npm test` 282개(Node.js 24.21.0), bun 1.3.14 에서 231개와 `runtime-smoke.mjs` 통과. 내용은 "결정 사항" 의 "6단계 점검 보완".
- 2026-10-11 : 7단계 구현 완료(남은 마무리 있음). 이전 작업이 오류로 중단된 지점(잠금 관리자·트랜잭션 파일이 반쯤 쓰이고 빌드가 깨진 상태)에서 이어받아 오버레이 방식의 트랜잭션을 완성했다.
  `txn/lockManager.ts`(행·PK·객체 배타 잠금, 대기열, 제한 시간, 교착 감지), `txn/transaction.ts`(오버레이, 되돌리기, 세이브포인트, 합쳐 읽기), `session/session.ts`(동기·비동기 실행, 트랜잭션·DDL 자동 커밋 규칙, 세션 닫기),
  `session/sessionManager.ts`(세션 목록, 유휴 종료), `exec/dml.ts`(잠금 후 오버레이에 접기, 커밋 때 쓰기와 FK 재확인, 인덱스 지우기 우선 쓰기), `exec/executor.ts`(FOR UPDATE 잠금과 제한), `daemon/server.ts`(Database 연결, 종료 때 롤백)를 구현했다.
  오류 번호 6000 ~ 6006 을 배정했다. 테스트 49개(`test/txn` 48개, 데몬 1개)를 추가해 `npm test` 322개(Node.js 24.21.0) 통과. 10개 세션 동시성 테스트(약 1.5 ~ 2초)를 포함한다.
  bun 확인, `SYS_SESSIONS` 연결, 설계 문서는 남아 있다. (현재 상태의 "7단계 남은 마무리")
- 2026-10-11 : 병합 점검. 원격 커밋(`f39583f`)과 병합한 커밋(`9d50f23`)에 충돌 마커가 남아 빌드가 깨져 있었다. `session.ts`·`dml.ts` 의 충돌을 7단계 쪽으로 정리하고, `AlterTable` 의 컨텍스트 전달을 7단계 시그니처(`queryContext(params, txn)`)에 맞추었다. `dml.ts` 의 `pkEquals` 호출은 `tupleKey` 비교로 바꿨다. 이 문서의 6단계 점검 보완 기록이 병합 중 빠져 있어 다시 넣었다. 6단계 스텁의 동작을 고정하던 테스트 두 개를 7단계 동작으로 바꿨다. `npm test` 331개 통과, bun 330개 통과(`t.mock` 1개 제외).
- 2026-10-15 : 7단계 남은 마무리 완료. `SYS_SESSIONS` 연결(`QueryContext.dictionary()`), `scanTable` 의 불필요한 조건 제거, 테스트 제목 수정, `docs/transactions.md` 작성, `docs/storage-v1.md` 덧붙임. 테스트 1개 추가.
- 2026-10-15 : 8단계(계정과 권한) 완료. `auth/scram.ts`(SCRAM-SHA-256 계산, RFC 7677 시험 벡터), `auth/users.ts`(계정 저장소, SYSTEM 계정, 비밀번호 확인), `auth/privileges.ts`(부여 기록, 판정, 권한 그룹, 이름 해석),
  `auth/authorizer.ts`(문장별 권한 검사), `exec/accounts.ts`(사용자·권한 문장 실행)를 구현하고 `session.ts` 에 연결했다(`Database.login`, `assertMayConnect`, 문장 실행 전 권한 확인, DDL 뒤 기록 정리).
  딕셔너리 뷰의 가시성과 `SYS_USERS`·`SYS_PRIVILEGES`·`SYS_GROUP_GRANTS`, 현재 테이블스페이스가 없는 세션(`3F000`), 데몬의 초기 암호 경고, `CREATE OR REPLACE VIEW` 의 소유자 유지, 테이블 이름 변경 때 권한 이동을 넣었다. 오류 번호 7000 ~ 7008 을 배정했다.
  테스트 51개를 더해 `npm test` 383개 통과, bun 382개 통과(`t.mock` 1개 제외). 권한 검사기를 무력화하면 테스트가 실패함을 확인했다. 문서는 `docs/accounts-and-privileges.md`.
- 2026-10-15 : 9단계 설계 문서 작성. [docs/communication-design.md](docs/communication-design.md). 코드는 바꾸지 않았다. 메시지 규약 초안(봉투, 버전 협상, 요청·응답 표, 값 표현, 컬럼 메타데이터, 파라미터, 오류), 커서와 묶음 크기, SCRAM 교환 순서, `Database.connect` 로 접속 정책 모으기, 프레임·TCP·TLS·로컬 채널·UDP 신뢰성 계층(패킷 레이아웃, 송신·수신 규칙, 주입 가능한 구조),
  서버 조립과 종료 순서, 제어 요청, 오류 번호 8000번대 안, 클라이언트 구조, 테스트 계획, 작업 분해(9-1 ~ 9-10), 위험, 사용자 확인이 필요한 결정 5건을 담았다.
- 2026-10-15 : 9단계 설계 결정 반영. 사용자가 설계의 5건을 정했다 : 클라이언트 TLS 서버 인증서 검증 기본 켬 + 인증서 오류 때 100 ms 뒤 최대 2회 재시도(설계 문서 12-1절 신설, 오류 번호 8007 `08001`, 시험 항목과 작업 9-6 에 반영), `SYS_SESSIONS` 열 추가 확정, `udp.sessionTimeoutMs = 0` 은 제한 없음, `udp.maxPacketSize` 64 ~ 65,507, 인증 실패 시 접속 종료는 권장안 유지.
  설계 문서 19절을 "결정 기록" 으로 바꾸고 AGENTS.md 상세 7, 8 에 사양을 보충했다. 코드는 바꾸지 않았다.

- 2026-10-16 : 사용자 결정 3건 반영과 `rdbms` 9단계(통신) 구현 완료.
  결정 : (1) `hwdb` 화면 문구는 영어만, 다국어를 붙일 수 있게 메시지 카탈로그 분리(`cli/i18n.ts`, `cli/messages/en.ts`, 기존 문구 이전) (2) DML 행 단위 접근은 하기로 함(9단계 다음, 10단계 전) (3) 사양이 정하지 않은 권한 규칙은 보편적인 RDBMS 방식(점검 결과 현행 유지).
  9단계 : 프로토콜 명세 확정(`docs/protocol.md`), 프레임, 접속 정책(`Database.connect`, `maxConnections`, 루프백 판정, `SYS_SESSIONS` 열 추가), 메시지 처리기(상태 기계, SCRAM, 커서, 제어 요청, 대기열), 로컬 전용 채널, TCP 와 TLS(최소 버전, 구버전 허용 경고),
  클라이언트(핸드셰이크, SCRAM 과 서버 서명 검증, TLS 인증서 검증과 재시도), UDP 신뢰성 계층(ACK, 재전송, 조각, 중복 제거, RFC 6298 RTO), UDP 서버와 클라이언트 전송, 서버 조립(세 경로, 제어 포트, 종료 순서), config 검증 보강(`udp.maxPacketSize`, `udp.sessionTimeoutMs = 0` 경고).
  오류 번호 8000 ~ 8007 을 배정했다. 시험 248개를 더해 `npm test` 631개 통과, bun 630개 통과(`t.mock` 1개 제외). 결함을 일부러 주입한 빌드로 시험이 통신 결함 22건을 모두 잡는 것을 확인했다.
  bun 확인 결과 : TLS 서버의 `minVersion` 을 적용하지 못한다(기본 TLS 1.2 이상, 구버전 허용 불가). 구동 로그에 경고한다. 그 밖의 통신은 Node.js 와 같다. 이 과정에서 UDP 신뢰성 계층의 RTT 표본 누락(마지막 조각의 ACK 가 누적 확인에 먼저 걸려 표본이 되지 않음)을 찾아 고쳤다.
  통신 시험 중 Windows 의 TCP·UDP 제외 포트 범위와 `net.Server.close` 콜백이 모든 접속 종료를 기다리는 것을 확인하여 시험 도우미와 `stopAccepting` 에 반영했다. 커밋은 하지 않았다.
- 2026-10-16 : DML 행 단위 접근 1부(읽기와 오버레이 계층). (사용자가 DML 을 10단계보다 먼저 하라고 하여 10단계는 미뤘고, 작업을 나눌 수 있는 지점까지만 했다.)
  `Heap.iterate()` 지연 순회, `TableOverlay` 클래스(PK 맵, 행 단위 변경과 되돌리기), `txn/rowAccess.ts`(`visibleRows`, `findVisibleByPk`, `findVisibleByIndex`, `mergeIndexEntries`), 조회와 DML 대상 찾기가 인덱스를 타고(자기 트랜잭션이 건드린 테이블 포함) 못 타면 지연 순회하도록 `exec/executor.ts` 를 바꿨다.
  `exec/dml.ts` 는 새 오버레이 API 에 맞춰 최소만 고쳤다(`foldImageRow`, 커밋 때 오버레이 읽기). 제약 검사와 쓰기는 이미지 방식 그대로이다(2부). 시험 11개를 더해 `npm test` 642개, bun 641개(`t.mock` 1개 제외)이다. 오버레이와 읽기 계층의 결함 주입 8건을 모두 잡는 것을 확인했다.
  10단계 사전 작업 : `control status` 응답에 `ready`, `systemPasswordInitial` 을 더했고 AGENTS.md 14-2 에 `--ssl-ca`, `--ssl-no-verify` 와 옵션 조합 규칙을 정했다. 커밋은 하지 않았다.

- 2026-10-16 : DML 행 단위 접근 2부 완료. `exec/dml.ts`의 전체 테이블 이미지(`StatementImages`, `ImageRow`, `overlayToImage`)를 없앴다.
  `exec/rowChanges.ts`에서 변경 행만 오버레이에 기록하고 NOT NULL·PK·FK, CASCADE·SET NULL, 문장 끝의 일괄 잠금을 처리한다. UPDATE 대입식과 INSERT DEFAULT는 변경 전에 모두 계산한다.
  부모 PK는 인덱스로 찾고, 자식은 FK 컬럼을 앞쪽에 둔 인덱스(복합·역순·DESC 포함)나 옛 키 묶음별 지연 순회로 찾는다. 일치한 행 식별자만 보관해 최종 검사에 재사용하며 자기 참조·순환 삭제도 작업 목록으로 처리한다.
  커밋은 오버레이의 변경 행만 직접 쓰며 옛 인덱스 항목을 모두 지운 뒤 새 항목을 넣는다. 커밋 FK 재검사도 변경 자식과 사라진 부모 키만 확인한다. TRUNCATE는 첫 참조 자식에서 멈춘다.
  시험 16개를 더해 Node.js 24.19.0 / TypeScript 6.0.3에서 `npm test` 658개 통과. 2만 행의 PK 단건 DML과 명시적 커밋의 힙 순회 0회, 인덱스 없는 자식의 키 묶음당 순회 1회, 문장 실패와 잠금 재시도, 복합 FK·연쇄·커밋 경쟁·재구동 후 인덱스를 검증했다.
  Bun 1.4.2는 전체 실행 657개 통과 + 대량 시험 별도 1개 통과로 658개를 모두 검증했다. 대량 시험은 데이터 준비 포함 최초 120초 타임아웃이었고, 제한을 360초로 늘린 재실행에서 약 221초에 통과했다. `t.mock` 기반 fsync 시험은 이 버전에서 통과한다.
  `docs/transactions.md`와 두 PROGRESS.md를 갱신했다. 조회 결과 전체의 스트리밍은 별도 미결 사항이며, 다음 작업은 10단계 CLI이다. 커밋은 하지 않았다.
- 2026-10-16 : JDBC 지원 변경을 반영했다. 자바 6~7용 `jdbc6`(JDBC 4.0, 자바 8 이상 실행 호환)와 자바 8 이상용 `jdbc8`(JDBC 4.2)을 상세 사양과 인수인계에 명시했다. 자바 5 지원 문구를 제거하고 통신 설계·프로토콜·TLS 경고와 시험 주석을 자바 6 기준으로 맞췄다. 메시지 프로토콜과 TLS 설정 동작은 바꾸지 않았다. `npm run build`와 `test/net/tcp.test.ts`의 기존 시험은 Node.js·Bun 각각 28개 통과했다.

- 2026-10-16 : `rdbms` 10단계(데몬 제어와 CLI) 완료. `hwdb start`(분리된 데몬. `daemon/entry.ts`, 구동 완료는 로컬 전용 채널 `status.ready` 로 확인, 실패 원인은 로그에서), `stop`(종료 요청 뒤 PID 가 사라질 때까지), `status`(구동 중이면 데몬의 값). 구동 중인지는 PID 가 아니라 로컬 전용 채널의 응답으로 판단한다.
  SQL 접속 : 인자 해석(`args.ts`, 옵션 네 가지 형태와 조합 규칙), 로컬 전용 채널·TCP·SSL(`--ssl-ca`, `--ssl-no-verify`, 인증서 재시도 안내)·UDP, 사용자명과 화면에 보이지 않는 비밀번호 입력(`terminal.ts`), 대화형 모드(여러 줄, 이력, help·exit·quit, Ctrl-C·Ctrl-D), 스크립트 모드(`-e`, `-f`, 표준 입력), 문장 나누기, 한글 폭을 맞춘 표 출력, 오류 위치 표시, SYSTEM 초기 암호 안내, 종료 때 롤백 안내.
  서버·프로토콜 : `bye.rolledBack`, 정상 종료 뒤 프로세스를 직접 끝내는 `exitAfterShutdown`(클라이언트가 소켓을 읽지 않을 때 Windows 에서 데몬이 영원히 남던 문제), 오래된 잠금 생성 가드 정리. AGENTS.md 14-1, 14-2 에 종료 코드·옵션 조합·스크립트 모드의 `exit` 를 보충했다. [docs/cli.md](docs/cli.md)를 썼다.
  시험 131개를 더해 `npm test` 789개 통과(Node.js 24.21.0), bun 1.3.14 에서 CLI 138개와 net·daemon 249개 통과. 결함 주입 15건을 모두 잡는 것을 확인했다. Windows 에서 분리 구동(콘솔 창 없음, 콘솔 프로세스를 끝내도 데몬 유지)과 실제 콘솔의 대화형 모드를 확인했다. 커밋은 하지 않았다.

- 2026-10-16 : `rdbms` 11단계(통합 검증) 완료. `test/integration/` 에 실제 `hwdb start` 데몬을 쓰는 시험 87개 : 네트워크를 거친 10개 세션 동시성(교착·잠금 대기·접속 끊김·`maxConnections`), 개요 1 ~ 15 항목별 시나리오(데이터 타입·UTF-8·생략 원칙, 테이블스페이스·복구·백업, 계정·권한·권한 그룹(원격 CONNECT 포함), 트랜잭션·인덱스·제약, config.json·TCP·UDP·TLS·UDP 유실, 데몬 구동·CLI·초기 암호 변경·제어 권한), 두 인스턴스, 이전 포맷 버전 데이터 디렉토리 호환성과 버전 보호.
  제품 결함 넷을 찾아 고쳤다 : NULL 리터럴의 타입, 데이터 파일 절대 경로(복사한 데이터 디렉토리를 못 엶), 행 삽입 비용이 테이블 크기에 비례(힙 빈자리 지도), 인덱스 범위 조건이 틀린 결과(DESC 컬럼의 한쪽 범위, 컬럼이 더 있는 복합 인덱스). 회귀 시험을 더했고 수정 전 코드에서 실패함을 확인했다.
  `docs/manual.md`(사용 설명서), `docs/verification.md`(검증 기록), `config.sample.json`, `docs/storage-v1.md`(빈자리 지도)를 썼다. 사양(AGENTS.md)은 바꾸지 않았다.
  `npm test` 888개 중 887개 통과·1개 건너뜀(Windows 에서 SIGTERM 시험), 실패 0 (Node.js 24.21.0 / TypeScript 6.0.3). bun 1.3.14 에서 통합 시험 87개 통과(건너뜀 2). 결함 주입 점검 모두 잡힘. 커밋은 하지 않았다.
- 2026-10-17 : 11단계 뒤의 마무리 (12단계 `nodejsDriver` 중에 한 수정). (1) bun 으로 통합 시험을 돌린 뒤 데몬이 남던 문제를 재현하고(`overviewNetwork` 상대 경로 시험 뒤 1개) 고쳤다 — 정리 훅 순서에 기대던 `Daemon.dispose` 를 지금까지 쓴 모든 데이터 디렉토리와 `makeExtraDir` 로 바꾸고, 고치는 중에 만든 PID 재사용 결함(끝난 데몬의 PID 에 `SIGKILL`)도 함께 바로잡았다. (2) `nodejsDriver` 의 통합 시험이 찾은 `CAST(? AS INTEGER)` 의 내부 오류(`XX000`)를 고치고 회귀 시험을 더했다. (3) 단위 시험의 임시 디렉토리 정리(`test/tempDirs.ts`). 시험 : Node.js `npm test` 889개 중 888 통과·1 건너뜀, bun 통합 85 통과·2 건너뜀, bun 단위 799 통과·2 실패(`t.mock` 미구현). 커밋은 하지 않았다.
- 2026-10-20 : `rdbms` 코드 점검(수정 없음). 인증·카탈로그·권한·프로토콜·TLS 경로를 읽고 빌드 결과물에 재현했다. 발견 사항 P-1 ~ P-4 를 "점검 작업 사항" 절에 `[ ]` 작업으로 남겼고, 고치지는 않았다. `npm run build` 는 오류 없이 통과했다(`dist` 를 새로 만들었다. git 에는 들어가지 않는다). 시험 전체는 돌리지 않았다. 커밋은 하지 않았다.
- 2026-10-20 : 후속 수정과 추가 점검. P-1 ~ P-4를 프로토타입 없는 이름 맵으로 수정하고 P-5(한정 이름·잠금 키 충돌), P-6(사용 불가 카탈로그 파일 누수), P-7(시험 도우미의 데몬 종료 생략)을 재현·수정했다. 회귀 시험 17개를 추가했다. Node.js 24.22.0 / TypeScript 6.0.3 `npm test`는 906개 중 905개 통과·1개 건너뜀·실패 0. Bun 1.3.14 관련 시험 241개와 정리 회귀 1개 통과. 최종 시험 후 남은 HelloWorldDB 데몬은 0개이다. 사양·통신 프로토콜·파일 포맷과 고정 호환성 자료는 바꾸지 않았고, 기존 고아 파일 복구는 수행하지 않았다. 두 PROGRESS.md와 트랜잭션 문서를 갱신했다. 커밋·푸시는 하지 않았다.
