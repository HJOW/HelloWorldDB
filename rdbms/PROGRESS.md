# rdbms 진행 상황

RDBMS 본체와 접속용 CLI 프로그램을 개발하는 프로젝트이다.
사양은 루트의 AGENTS.md 가 기준이다. 이 문서에는 세부 계획, 진행 상황, 인수인계 사항만 적는다.
단계 번호는 AGENTS.md "구현 계획" 의 번호와 같고, "상세 N" 은 AGENTS.md "RDBMS 에 구현되어야 할 사항 (상세)" 의 N번 절을 가리킨다.

## 현재 상태

- 최종 갱신 : 2026-10-10
- 진행 단계 : 1 ~ 6단계 완료. (프로젝트 기반, 저장 엔진, 타입 시스템, SQL 파서, 카탈로그와 DDL, 질의 실행)
- 착수 조건 : 없음
- 다음 작업 : 7단계 트랜잭션과 동시성. 세션 상태와 커밋·롤백·세이브포인트, 행 잠금과 교착 감지, READ COMMITTED, 10개 세션 동시성 테스트를 붙인다.
- 검증 : Windows의 Node.js 24.21.0 / TypeScript 6.0.3에서 `npm test` 273개 통과, Bun 1.4.2에서 222개(`bun test dist/test/exec/ dist/test/types/ dist/test/sql/ dist/test/catalog/`) 통과. 저장 엔진의 `test/storage/runtime-smoke.mjs`도 Node.js/bun 양쪽에서 다시 통과했다.

## 작업 규칙

- 작업 항목을 끝내면 `[ ]` 를 `[x]` 로 바꾼다. 단계가 끝나면 "현재 상태" 와 "작업 이력" 을 갱신한다.
- 단계의 완료 기준을 채우기 전에는 다음 단계로 넘어가지 않는다.
- 사양에 없는 것을 새로 정했으면 "결정 사항" 에 적는다. 사양 자체를 바꿔야 하면 AGENTS.md 를 먼저 고친다.

## 디렉토리 구성

파일마다 맨 위 주석에 담당 범위, 관련 사양, 구현 단계를 적어 두었다. 아래는 한 줄 요약이다.
`config`, `common`, `storage`, `types`, `sql`에 구현 코드가 있고, 5단계에서 `catalog`, `session`, `exec/ddl`, 데몬 조립까지, 6단계에서 질의 실행(`exec` 나머지)과 DML을 붙었다. 인증, 통신, 트랜잭션은 아직 뼈대이다.

```
rdbms/
  package.json, tsconfig.json
  config.json            설정 파일. 없으면 기본값으로 구동한다 (아직 만들지 않음)
  src/
    cli/                 hwdb 명령
      main.ts              진입점. 하위 명령 분기, 옵션 해석
      daemonControl.ts     hwdb start, stop, status
      sqlShell.ts          SQL 접속 (대화형 모드, 스크립트 모드)
      resultPrinter.ts     실행 결과의 화면 출력
    client/
      connection.ts        클라이언트 쪽 프로토콜. CLI 와 테스트가 쓴다
    daemon/
      main.ts              데몬 프로세스의 진입점, 신호 처리
      server.ts            구성 요소 조립, 구동과 종료의 순서
      lockFile.ts          데이터 디렉토리 잠금 파일, 제어 토큰
    config/
      config.ts            config.json 읽기, 기본값, 검증
    common/
      errors.ts            오류 체계 (SQLSTATE, 내부 오류 번호)
      logger.ts            로그
      instance.ts          인스턴스 식별 규칙(포트 번호 → 로컬 전용 채널 주소), 공용 상수
    storage/
      pageFile.ts          페이지 단위 파일 입출력
      bufferCache.ts       버퍼 캐시
      errors.ts            저장 오류 생성, 인자 검증
      format/format.ts     포맷 버전의 공통 인터페이스, 버전 선택
      format/v1/           포맷 버전 1
        index.ts             테이블스페이스와 배치, 빈 페이지, 카탈로그 바이트 저장
        pages.ts             페이지 레이아웃, CRC-32, 파일 헤더
        context.ts           내부 페이지 접근 규약
        overflow.ts          행/긴 키/카탈로그의 오버플로 체인
        heap.ts              슬롯 힙
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
    session/             session.ts(SQL 실행의 입구, Database 와 Session), sessionManager.ts(9단계용 뼈대)
    exec/                ddl.ts(테이블·뷰·인덱스 DDL 실행), analyzer.ts(이름 해석과 뷰 전개, 갱신 가능 판정),
                         planner.ts(규칙 기반 인덱스 선택), expression.ts(식 계산과 3값 논리),
                         functions.ts(내장 함수와 집계), executor.ts(조회 실행), dml.ts(INSERT·UPDATE·DELETE·TRUNCATE)
    txn/                 transaction.ts, lockManager.ts
    auth/                scram.ts, users.ts, privileges.ts
    net/                 protocol.ts, framing.ts, udpReliability.ts, messageHandler.ts,
                         tcpServer.ts, udpServer.ts, localChannelServer.ts
  test/                  테스트. src 와 같은 디렉토리 이름으로 두며 파일 이름은 *.test.ts
    smoke.test.ts          프로젝트 구성 확인용
    catalog/               카탈로그와 DDL 테스트. 내부 세션 API 로 실행하고 재구동 persistence 를 본다
    exec/                  질의 실행 테스트. helpers.ts 는 공용 도우미이며 query(조회)·dml(DML과 제약)·functions(함수와 파라미터)로 나눈다
    storage/               저장 엔진 테스트, runtime-smoke.mjs(Node.js/bun 실행 검증)
    types/                 타입 시스템 테스트. helpers.ts 는 SQL 표기로 타입과 값을 만드는 도우미
                           codecStorage.test.ts 는 코덱과 저장 엔진을 함께 쓰는 테스트
    sql/                   어휘 분석, 구문 분석 테스트. helpers.ts 는 구문 트리를 한 줄 표기로 바꾸는 도우미
                           parserRobustness.test.ts 는 망가뜨린 입력으로 파서의 견고성을 본다
    fixtures/              storage-v1.hwdb, 해시/내용 설명, 최초 생성 스크립트
  docs/
    data-types.md          타입 인자와 기본값, 값 표현, 비교, 형변환, 연산 결과 타입, 타입 오류 번호
    sql-syntax.md          어휘 규칙, 예약어, 사양에 더해 받는 문법, 지원하지 않는 문법, 한도, 구문 트리의 원칙
    storage-v1.md          저장 포맷, 행과 인덱스 키의 값 인코딩, API 사용 원칙과 트랜잭션 설계. 프로토콜 명세는 9단계
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

- [ ] 세션 상태 : 자동 커밋, 진행 중인 트랜잭션, 현재 테이블스페이스, 타임존
- [ ] 커밋, 롤백, 세이브포인트, 실패한 문장만 되돌리기 (상세 10)
- [ ] DDL 등 자동 커밋되는 문장 처리
- [ ] 행 잠금, `SELECT ... FOR UPDATE`, 잠금 대기 제한, 교착 감지
- [ ] READ COMMITTED : 커밋된 값과 자기 변경만 읽는다. 조회와 변경이 서로를 기다리게 하지 않는다
- [ ] 커밋 시 디스크 반영(fsync) 후 응답
- [ ] DDL 과 진행 중인 트랜잭션이 같은 객체에서 만났을 때의 처리
- [ ] 10개 세션 동시성 테스트 (상세 9)
- 완료 기준 : 상세 9 의 10개 세션 동시성 테스트 통과.

### 8단계. 계정과 권한

- [ ] SCRAM-SHA-256 검증 정보 생성과 저장 (상세 4)
- [ ] 최초 구동 시 SYSTEM 계정 생성. 초기 암호를 바꾸지 않았으면 구동 로그에 경고
- [ ] `CREATE USER`, `ALTER USER`, `DROP USER`
- [ ] 객체 소유자 기록
- [ ] GRANT, REVOKE (권한, 권한 그룹)와 실행 자격 검사 (상세 5, 6)
- [ ] 문장별 권한 검사, 뷰 권한 규칙
- [ ] 딕셔너리 뷰는 권한이 있는 객체의 행만 보여 준다
- 완료 기준 : 권한 조합별 허용, 거부 테스트 통과. 개요 5 의 뷰 UPDATE 예시 포함.

### 9단계. 통신

- [ ] 프로토콜 명세를 `docs` 에 문서로 쓴다 : 메시지 필드, TCP 프레임, UDP 패킷 레이아웃, 값 표현, 오류 코드 목록. 드라이버 프로젝트들이 이 문서를 기준으로 삼는다
- [ ] 접속 경로와 분리된 메시지 처리기 (세 경로가 같은 처리기를 쓴다)
- [ ] 핸드셰이크, SCRAM-SHA-256 인증, 인증 전 메시지 제한 (상세 8)
- [ ] TCP 와 UDP 를 config.json 의 `port` 하나로 연다 (상세 15)
- [ ] TCP : 길이를 앞에 붙인 프레임, 메시지 크기 제한
- [ ] SSL : 인증서가 설정되면 TLS 전용으로 운영, `tcp.ssl.minVersion` 적용
- [ ] UDP 신뢰성 계층 : 수신 확인, 재전송, 중복 제거, 순서 보장, 분할과 재조립, 세션 시간 초과
- [ ] 로컬 전용 채널 : Windows 네임드 파이프, 그 외 유닉스 도메인 소켓. 주소는 포트 번호로 정한다 (상세 15)
- [ ] 데몬 제어 요청 처리 : 상태 조회, 종료. 로컬 전용 채널에서만 받고 제어 토큰을 확인한다 (상세 14-1)
- [ ] 로컬 접속 판정, CONNECT 검사, `maxConnections` (상세 6, 9)
- [ ] 큰 결과를 fetch 단위로 나누어 보내기, 커서 닫기
- [ ] 유휴 세션 종료, 연결이 끊긴 세션의 롤백
- 완료 기준 : 테스트용 클라이언트로 세 접속 경로 모두에서 로그인, 질의, 대량 결과 수신, 트랜잭션이 동작한다. UDP 는 패킷 유실과 중복을 일부러 일으킨 조건에서도 통과해야 한다.

### 10단계. 데몬 제어와 CLI

데몬 제어 (상세 14-1)

- [ ] `hwdb start` : 데몬을 분리된 프로세스로 띄우기, 구동 완료 대기, 실패 시 원인 표시, 이미 구동 중일 때의 처리, `--timeout`, `--foreground`
- [ ] `hwdb stop` : 종료 요청, 프로세스가 사라질 때까지 대기
- [ ] `hwdb status` : 상태 표시와 종료 코드
- [ ] 잠금 파일에 PID, 포트 번호, 구동 시각, 제어 토큰 기록. 비정상 종료로 남은 잠금 파일과 소켓 파일 처리
- [ ] 데몬의 출력을 로그 파일로 보내기
- [ ] Windows 확인 : 터미널을 닫아도 데몬이 남는지, 데몬의 콘솔 창이 뜨지 않는지

SQL 접속 (상세 14-2)

- [ ] 명령행 옵션 처리. 모든 옵션을 생략할 수 있다
- [ ] 로컬 전용 채널 접속(기본), TCP 접속, UDP 접속. 데몬이 구동 중이 아니면 `hwdb start` 를 안내한다
- [ ] 사용자명 입력, 화면에 보이지 않는 비밀번호 입력
- [ ] 대화형 모드 : 여러 줄 입력, `;` 에서 실행, 입력 이력, `help`, `exit`, `quit`
- [ ] 스크립트 모드 : `-e`, `-f`, 표준 입력. 오류 시 종료 코드 1
- [ ] 문장 나누기 : 문자열과 주석 안의 `;` 는 문장 끝으로 보지 않는다
- [ ] 결과 표 출력 : 한글처럼 폭이 넓은 문자의 칸 맞춤, 행 수와 소요 시간
- [ ] SYSTEM 계정 초기 암호 변경 안내
- 완료 기준 : `hwdb start` 가 데몬을 띄우고 바로 돌아오며, 터미널을 닫아도 데몬이 남는다. `hwdb status` 와 `hwdb stop` 이 동작한다.
  설치 직후 `hwdb` 로 SYSTEM 에 로그인하여 초기 암호를 바꿀 수 있다. TCP 와 UDP 를 모두 껐거나 `maxConnections` 가 찬 상태에서도 로컬 접속이 된다. Windows 에서도 모두 확인한다.

### 11단계. 통합 검증

- [ ] 네트워크를 거친 10개 세션 동시성 테스트
- [ ] 개요 1 ~ 15 항목별 시나리오 테스트
- [ ] 포트 번호가 다른 두 인스턴스를 한 장비에서 함께 구동 (상세 15)
- [ ] bun 에서 데몬 구동과 종료, 접속, 주요 시나리오 확인
- [ ] 이전 포맷 버전 호환성 테스트가 전체 테스트에 포함되어 있는지 확인
- [ ] 사용 설명서 : 설치, 데몬 구동과 종료, config.json, CLI 사용법, 초기 암호 변경 절차
- 완료 기준 : 개요 1 ~ 15 항목을 각각 확인하는 테스트가 있고 모두 통과한다.

## 미결 사항

해당 단계에서 정하고 "결정 사항" 으로 옮긴다.

- Node.js 22.x 장비에서의 전역 실행 확인. 이번 검증 장비는 Node.js 24.19.0이다. 현재 설치된 버전으로 검증하고 22.x PC에서 확인한다는 AGENTS.md 지켜야 할 사항 5를 따른다.
- `hwdb` 가 화면에 내는 문구의 언어 (10단계, 사용자 확인 필요). DB 오류 메시지는 영문으로 정해져 있다 (상세 0). 사용법과 안내 문구는 지금 영문으로 적어 두었다.
- SCRAM 반복 횟수의 기본값 (8단계)
- 유닉스 도메인 소켓 파일의 접근 권한, 비정상 종료 뒤 남은 소켓 파일의 정리 (9단계)
- bun 에서 네임드 파이프와 TLS 최소 버전 설정이 Node.js 와 똑같이 동작하는지 (9단계에서 실제로 확인)
- bun 에서 프로세스를 분리해 띄우는 동작이 Node.js 와 같은지 (10단계에서 실제로 확인)
- 잠금 파일에 적힌 PID 를 운영체제가 다른 프로세스에 다시 쓴 경우의 처리 (10단계). PID 만 보면 구동 중으로 잘못 판단하므로 로컬 전용 채널 응답도 함께 확인해야 한다.
- 구버전 TLS 허용 (9단계). 최신 Node.js 의 OpenSSL 은 TLS 1.0 을 쓰려면 최소 버전 외에 보안 수준 설정도 낮춰야 할 수 있다. 실제 자바 5, 6 클라이언트 접속 확인은 `jdbc5` 단계에서 한다.
- 잠금 생성 가드(`helloworlddb.lock.acquire`) 안에서 강제 종료되어 가드가 남는 경우의 정리(10단계). 현재는 동시 점유 방지를 위해 구동에 실패시킨다. 관리자가 관련 데몬이 없는지 확인한 뒤 빈 가드 디렉토리를 제거해야 한다. 일반 구동 후 남은 잠금 파일은 죽은 PID를 확인해 재사용한다.

## 결정 사항

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
  - `ADD COLUMN`은 기존 행을 다시 쓰지 않는다. 행 형식에 컬럼 수를 앞에 두므로 저장된 컬럼이 적으면 뒤쪽을 NULL 로 읽는다. 기본값이 있는 컬럼을 추가해도 기존 행에는 NULL 로 보이며, 6단계의 조회가 DEFAULT 를 채울 때 함께 정한다. `DROP COLUMN`의 행 다시 쓰기도 6단계이다.
  - FK 타입 일치는 `formatDataType` 표기가 같은지로 본다. 같은 테이블스페이스의 PK 만 참조할 수 있으며 컬럼 수와 순서가 맞아야 한다.
  - `SYS_` 와 `DUAL` 예약은 SYSTEM 에서만 막는다. 다른 테이블스페이스에서는 같은 이름의 사용자 객체가 먼저이며, 없을 때만 딕셔너리·DUAL 로 푼다.
  - 딕셔너리 12개 뷰의 컬럼은 `catalog/dictionaryViews.ts`에 고정했다. `SYS_USERS`, `SYS_PRIVILEGES`, `SYS_GROUP_GRANTS`, `SYS_SESSIONS`는 8~9단계까지 비어 있다. `DUAL`은 저장하지 않는 가상 한 행(`DUMMY VARCHAR(1) = 'X'`)이다.
  - DDL 오류 번호 4000 ~ 4017 을 배정했다. `3D000` 테이블스페이스 없음, `42P06` 중복, `42P07` 중복 테이블·뷰, `42P01` 없음, `42701`·`42703` 컬럼 중복·없음, `42710`·`42704` 제약·인덱스 중복·없음, `42P16`·`42P17` 잘못된 정의, `55006` 사용 중, `42602` 예약 이름, `54011` 컬럼 초과이다.
  - 세션의 SELECT 는 5단계에서 딕셔너리·DUAL·FROM 없는 리터럴만 받는다. `WHERE`, `ORDER BY`, 행 수 제한, 조인, 집합 연산은 `0A000`으로 알리고 6단계에서 푼다.
  - 데몬(`daemon/server.ts`)은 구동 때 `TablespaceManager.open`으로 SYSTEM 과 목록을 함께 열고, 종료 때 닫아 정상 종료 표시를 쓴다. SYSTEM 이 손상되면 구동에 실패하고 나머지는 사용 불가로 두고 구동한다.
- 6단계에서 정한 사항이다.
  - 식 평가는 기대 타입을 아래로 넘긴다. 타입 없는 문자열(리터럴·문자열 파라미터)은 문맥 타입으로 `castLiteral` 해석하고, 수 리터럴은 크기별 INTEGER·BIGINT·DECIMAL(p,s), FLOAT는 DOUBLE로 묶는다. INTERVAL 리터럴은 값이 선행 정밀도를 넘으면 9까지 넓힌다.
  - NULL은 비교·BETWEEN·IN·COALESCE·NULLIF·NVL에서 상대 타입에 적응한다. 비교에 NULL이 섞이면 타입이 달라도 UNKNOWN이며 오류가 아니다.
  - 범위에는 깊이를 둔다. 안쪽이 바깥을 가리고 같은 깊이에 둘이면 `42702`이다. USING 병합 열은 오른쪽에서 가리고, 바깥 조인에서 비는 쪽의 병합 열은 살아 있는 쪽 값으로 채운다.
  - 뷰 안의 생략된 이름은 뷰의 테이블스페이스에서 찾는다. 뷰 순환은 `42P17`이다.
  - GROUP BY 검사는 집계 없는 식 전체가 GROUP BY 식과 같거나(예 : `GROUP BY SUBSTRING`의 그 식), 집계 안의 바깥 열이 GROUP BY에 있어야 한다. 상수는 항상 된다.
  - DML은 문장 단위 메모리 이미지로 NOT NULL·PK·FK를 검사하고 CASCADE·SET NULL을 끝까지 적용한 뒤 테이블스페이스마다 배치 하나로 쓴다. 한 배치를 여러 이미지가 공유하여 저장 충돌(`40001`)이 나지 않게 한다.
  - TRUNCATE는 참조하는 자식 행이 있으면 `23503`이다. `ALTER ... SET NOT NULL`과 PK·FK 추가, `DROP COLUMN`(힙 다시 쓰기와 인덱스 재구축)은 기존 행을 검사한다.
  - 인덱스 선택은 앞쪽 컬럼의 동등 묶음에 범위 하나이며, DESC 컬럼의 하한·상한을 뒤집는다. `CREATE INDEX`와 PK 추가는 기존 행을 백필한다.
  - 함수 결과 타입 : `POWER`·`SQRT`는 DOUBLE, `AVG`는 DECIMAL(38,6)·DOUBLE, `TO_CHAR`는 VARCHAR(4000), `TO_DATE`는 TIMESTAMP(0), `ROUND`는 소수 자릿수에 맞춘다. 날짜 요소(YYYY, YY, MM, DD, HH24, HH12, HH, MI, SS, FF1~FF6, AM, PM, 큰따옴표 고정 문자열)와 숫자 요소(9, 0, ., ,, FM)를 받으며, 넘치면 `#`으로 적는다. `YY`는 2000년대로 읽는다.
  - `LIKE`는 코드 포인트 단위로 견주며, `SUBSTR`의 음수 시작은 뒤에서 센다.
  - `?`는 문자열이면 문맥 타입으로, 아니면 `assignValue`로 맞춘다. 개수 불일치는 `07001`(5008)이다. DML 결과에 `rowCount`를 함께 둔다.
  - 실행 오류 번호 5000 ~ 5011 을 배정했다. `42702` 모호한 열, `42883` 정의되지 않은 함수·잘못된 인자, `21000` 스칼라 서브쿼리 행 수, `23502` NOT NULL, `23503` FK, `42803` GROUP BY, `07001` 파라미터, `42601` INSERT 값 개수(5011), `42804` 집합 연산 불일치(5010)이다. TO_DATE 형식 불일치는 `22007`이다.
  - `SELECT ... FOR UPDATE`는 6단계에서 잠금 없이 읽는다. `UNION ALL` 사슬은 왼쪽부터 재귀로 풀며, 구문 트리 한도(1,000) 안에서는 스택이 넘치지 않는다.
  - DbError가 아닌 예외는 세션 입구에서 내부 오류(`XX000`)로 바꾸어 응답한다.
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

- 6단계까지 마쳤다. 조회와 DML을 내부 세션 API로 실행한다. (실제 호출 예는 `test/exec/query.test.ts`, `dml.test.ts`, `functions.test.ts`)
  - `Database.open(데이터디렉토리)`로 열고 `createSession({ user, tablespace })`으로 세션을 만든다. `session.execute(sql, params)`가 구문 분석부터 실행까지 맡는다.
  - 질의는 `exec/executor.ts`의 `executeQuery`가 맡는다. FROM 묶기 → WHERE → GROUP BY·HAVING → 투영 → DISTINCT → 집합 연산 → ORDER BY → 행 수 제한 순서이다.
  - 식은 `exec/expression.ts`가 값과 타입을 함께 계산하고, 함수는 `exec/functions.ts`가 맡는다. 서브쿼리 실행은 순환 import를 피하려고 호출자가 넘긴 핸들러로 한다.
  - DML은 `exec/dml.ts`가 메모리 이미지에서 제약과 참조동작을 마친 뒤 쓴다. INSERT ... SELECT의 원천 질의와 WHERE 탐색은 실행기를 재사용한다.
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
