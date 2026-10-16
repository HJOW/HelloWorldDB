# HelloWorldDB 전체 진행 상황

프로젝트 전체에 걸친 진행 상황과 공통 인수인계 사항을 적는다.
사양과 구현 계획은 AGENTS.md 가 기준이고, 프로젝트별 세부 계획과 진행 상황은 각 디렉토리의 PROGRESS.md 에 있다.

## 현재 상태

- 최종 갱신 : 2026-10-16
- 사양(AGENTS.md 의 개요와 상세)과 구현 계획을 세웠다.
- `rdbms` 는 1 ~ 9단계 구현을 마쳤다. Hello World 샘플을 포함한 CRUD와 내장 함수, 파라미터, 규칙 기반 인덱스, 트랜잭션(커밋·롤백·세이브포인트, 행 잠금, 교착 감지), 사용자 계정(SCRAM-SHA-256 검증 정보), 권한과 권한 그룹, 문장별 권한 검사에 더해, 9단계에서 **로컬 전용 채널, TCP(TLS 포함), UDP(신뢰성 계층 포함)** 로 접속해 로그인, 질의, 대량 결과, 트랜잭션을 하고 데몬이 세 경로를 열고 닫으며 상태 조회·종료 요청을 처리한다. 접속용 클라이언트 라이브러리(`rdbms/src/client`)도 있다.
- 지금 진행할 범위는 `rdbms` 와 `nodejsDriver` 이다. JDBC(`jdbc8`, `jdbc5`)와 GUI DB툴(`gui`)은 보류했다.
- 다음 작업 : `rdbms` 의 **DML 행 단위 접근**(사용자 결정 2026-10-16. 보편적인 RDBMS 처럼 대상 행 단위로 접근) → 10단계(데몬 제어와 CLI `hwdb`). 10단계는 9단계의 클라이언트 라이브러리를 그대로 쓰며, `hwdb` 화면 문구는 영어만 낸다(메시지 카탈로그로 분리해 다국어를 붙일 수 있다). 인수인계는 [rdbms/PROGRESS.md](rdbms/PROGRESS.md)의 "인수인계 사항".
  9단계 프로토콜 명세는 [rdbms/docs/protocol.md](rdbms/docs/protocol.md)에 확정되어 있고(드라이버가 기준으로 삼는다), 설계 배경은 [rdbms/docs/communication-design.md](rdbms/docs/communication-design.md)이다.
- 2026-10-16 : 사용자 결정 3건을 반영하고 9단계(통신)를 완료했다. 프로토콜 명세, 세 접속 경로, 클라이언트, 정상 종료 순서와 제어 요청. 세부는 [rdbms/PROGRESS.md](rdbms/PROGRESS.md).
- 2026-10-15 : 7단계 남은 마무리(`SYS_SESSIONS` 연결, `docs/transactions.md`)를 끝내고 8단계를 완료했다.
- 6단계 점검 보완(2026-10-10)에서 결함 7건을 고쳤다. 7단계에서 `BEGIN`·`ROLLBACK` 등을 막아 둔 `0A000` 을 풀었다. DML 의 행 단위 접근은 하지 않았다.
- 2026-10-11 병합 점검 : 원격 커밋과 병합하면서 `session.ts`, `dml.ts` 에 충돌 마커가 커밋되어 빌드가 깨져 있었다. 7단계 쪽을 기준으로 정리했고, 병합 중 빠진 6단계 점검 보완 기록을 `rdbms/PROGRESS.md` 에 다시 넣었다.
- 검증 : Windows의 Node.js 24.22.0 / TypeScript 6.0.3에서 `npm test` 631개 통과. Bun 1.3.14 에서 `bun test --timeout 120000 dist/test/` 630개 통과(`node:test` 의 `t.mock` 을 쓰는 1개 제외). 통신 결함 22건을 일부러 주입해 시험이 모두 잡는 것을 확인했다.

## 프로젝트별 상태

단계 번호는 AGENTS.md "구현 계획" 의 번호이다.

| 프로젝트 | 패키지명 | 단계 | 상태 | 착수 조건 | 세부 계획 |
|---|---|---|---|---|---|
| `rdbms` | `org.duckdns.hjow.helloworlddb.rdbms` | 1 ~ 11 | 9단계까지 완료. 다음은 DML 행 단위 접근, 10단계(CLI) | 없음 | [rdbms/PROGRESS.md](rdbms/PROGRESS.md) |
| `nodejsDriver` | `org.duckdns.hjow.helloworlddb.nodejsdriver` | 12 | 착수 전 | 11단계 완료 | [nodejsDriver/PROGRESS.md](nodejsDriver/PROGRESS.md) |
| `jdbc8` | `org.duckdns.hjow.helloworlddb.jdbc8` | 없음 | 보류 | 계획부터 다시 정한다 | [jdbc8/PROGRESS.md](jdbc8/PROGRESS.md) |
| `jdbc5` | `org.duckdns.hjow.helloworlddb.jdbc5` | 없음 | 보류 | 계획부터 다시 정한다 | [jdbc5/PROGRESS.md](jdbc5/PROGRESS.md) |
| `gui` | `org.duckdns.hjow.helloworlddb.gui` | 없음 | 보류 | 계획부터 다시 정한다 | [gui/PROGRESS.md](gui/PROGRESS.md) |

## 공통 인수인계 사항

- 보류한 프로젝트의 PROGRESS.md 에는 보류 전에 잡아 둔 세부 계획이 초안으로 남아 있다. 확정된 계획이 아니므로 그대로 착수하지 않는다.
- RDBMS 사양 중 보류한 프로젝트를 위한 부분(자바 5, 6 용 TLS 최소 버전 설정, 메타데이터 조회용 딕셔너리 뷰)은 `rdbms` 에서 그대로 구현한다.
- 프로토콜 명세는 [rdbms/docs/protocol.md](rdbms/docs/protocol.md)에 확정되어 있다(2026-10-16, 버전 1). 모든 드라이버가 이 문서를 기준으로 삼는다. 클라이언트가 해야 하는 검증(서버 nonce·서명 확인, TLS 인증서 검증과 재시도 등)은 그 문서 15절의 체크리스트이다.
  프로토콜을 바꾸면 프로토콜 버전을 올리고, 영향을 받는 드라이버 프로젝트의 PROGRESS.md 에 알린다.
- 명령은 `hwdb` 하나이다. `hwdb start`, `hwdb stop`, `hwdb status` 로 데몬을 제어하고, `hwdb` 로 SQL 접속을 한다. 서버 실행 파일을 따로 두지 않는다.
- 인스턴스는 포트 번호로 구분한다. SID 나 DB 이름은 없으며, TCP 와 UDP 가 같은 포트 번호를 쓴다.
- `rdbms` 의 CLI 는 `nodejsDriver` 보다 먼저 만들어지므로 자체 클라이언트 코드(`rdbms/src/client`: `Connection`, 전송 계층 로컬·TCP·TLS·UDP)를 가진다. `nodejsDriver` 는 그 코드를 출발점으로 삼을 수 있다.
- 타입스크립트 코드는 타입스크립트 6 에서 컴파일되어야 한다 (AGENTS.md 지켜야 할 사항 7). 그래서 `rdbms` 의 개발 의존성은 타입스크립트 6 으로 묶어 두었다. 7 로 올리지 않는다.
- SYSTEM 계정은 CONNECT 없이 만들어지므로 처음에는 로컬에서만 접속된다. 설치 후 관리자가 서버 장비에서 `hwdb` 로 접속해 초기 암호를 바꾸는 것이 표준 절차이다.
- 저장 포맷과 트랜잭션 설계는 [rdbms/docs/storage-v1.md](rdbms/docs/storage-v1.md)에 있다. 저장 API는 `storage/format/format.ts`만 통해 사용한다. SQL 카탈로그와 데몬 연결은 5단계에서 마쳤고, SQL 트랜잭션과 행 잠금은 7단계에서 구현했다(설계 요약은 [rdbms/PROGRESS.md](rdbms/PROGRESS.md)의 결정 사항).
- v1 고정 바이너리와 해시 검증 테스트를 보관했다. 개요 3의 1.0 출시 전 포맷 변경 예외는 적용 가능하며, 변경 시 포맷 문서와 테스트 자료도 의도적으로 갱신한다.
- 변경된 타입 정책은 [rdbms/docs/data-types.md](rdbms/docs/data-types.md)에 정리했다. VARCHAR/NVARCHAR의 최대·기본 길이는 65,535이며 DECIMAL/DEC/NUMERIC의 인자 전체 생략은 (10,3), 정밀도만 지정한 `(p)`는 (p,0)이다. 드라이버와 DB툴은 실제 컬럼 인자를 서버 메타데이터에서 읽는다.
- 저장 엔진의 저장/재열기, 인덱스, 롤백, v1 자료 읽기와 포그라운드 종료는 앞선 단계에서 Node.js와 bun으로 확인했다. 현재 검증 환경은 Windows, Node.js 24.21.0, TypeScript 6.0.3, bun 1.4.2이다. Node.js 22.x 장비에서의 전역 검증은 남아 있다.
- 드라이버와 DB툴이 참고할 `rdbms` 문서이다. 타입과 값의 규칙은 [rdbms/docs/data-types.md](rdbms/docs/data-types.md), SQL 의 어휘 규칙·예약어·지원 문법·한도는 [rdbms/docs/sql-syntax.md](rdbms/docs/sql-syntax.md), 저장 포맷은 [rdbms/docs/storage-v1.md](rdbms/docs/storage-v1.md),
  트랜잭션과 잠금의 동작(오류 번호 `55P03`, `40P01` 등)은 [rdbms/docs/transactions.md](rdbms/docs/transactions.md), 계정·권한·오류 번호 `28000`·`42501` 등과 딕셔너리 뷰의 가시성은 [rdbms/docs/accounts-and-privileges.md](rdbms/docs/accounts-and-privileges.md), 프로토콜(전송 계층, 메시지, SCRAM, 값 표현, 커서, 오류 8000번대, 한도, 런타임 차이)은 [rdbms/docs/protocol.md](rdbms/docs/protocol.md)이다.
- **TLS 서버 인증서 검증(모든 클라이언트 공통, 2026-10-15 결정)** : 접속용 CLI(`hwdb --ssl`)와 드라이버는 서버 인증서를 기본으로 검증한다. 신뢰할 CA 를 지정하는 방법과 검증을 끄는 방법을 함께 제공한다.
  인증서 오류로 접속에 실패하면 접속을 끊고 100 ms 뒤에 다시 시도하며, 재시도는 최대 2회(연결 시도는 최대 3번)이다. 재시도에서도 검증은 그대로 한다. 인증서 오류가 아닌 실패(연결 거부, 시간 초과 등)에는 적용하지 않는다. 사양은 AGENTS.md 상세 8, 설계는 [rdbms/docs/communication-design.md](rdbms/docs/communication-design.md)의 12-1절이다.
- 인증은 SCRAM-SHA-256 이다. 드라이버가 쓸 계산은 `rdbms/src/auth/scram.ts` 에 순수 함수로 있고 RFC 7677 시험 벡터로 검증되어 있다. 사용자가 없는 경우와 비밀번호가 틀린 경우는 같은 오류(`28000`)이다.
  CONNECT 권한 그룹이 없는 사용자는 원격(루프백이 아닌 주소) 접속이 거부된다. 현재 테이블스페이스가 없는 세션(사용자에게 기본 테이블스페이스가 없을 때)이 있을 수 있으므로 드라이버와 DB툴은 이를 처리해야 한다.
- **사용자 결정(2026-10-16)** 3건이다. 자세한 구현 방침은 [rdbms/PROGRESS.md](rdbms/PROGRESS.md)의 결정 사항.
  1. **화면 문구의 언어** : `hwdb` 의 사용법, 안내, 표 머리글, 경고 같은 문구는 지금 영어만 낸다. 문구를 코드에 박지 않고 메시지 키로 꺼내 쓰는 카탈로그(`rdbms/src/cli/i18n.ts`, 영어 카탈로그 `rdbms/src/cli/messages/en.ts`)로 분리해 두었으므로, 언어를 추가할 때는 카탈로그와 언어 선택만 더하면 된다.
     DB 오류 메시지는 AGENTS.md 상세 0 대로 영문으로 고정하고 SQLSTATE 와 내부 오류 번호가 번역의 열쇠이다. 드라이버와 DB툴도 같은 원칙을 따른다(서버 메시지는 그대로 전달하고, 자기 화면 문구만 카탈로그로 둔다).
  2. **DML 행 단위 접근** : 보편적인 RDBMS 처럼 대상 행 단위로 접근한다. 테이블 전체를 메모리 이미지로 올리는 방식은 버린다. 9단계를 마친 다음, 10단계 전에 처리한다.
  3. **사양이 정하지 않은 사용자·권한 규칙** : 보편적인 RDBMS 의 동작을 따른다. 점검 결과 [rdbms/docs/accounts-and-privileges.md](rdbms/docs/accounts-and-privileges.md) 8절의 규칙은 이미 PostgreSQL, Oracle 의 공통 동작이거나 AGENTS.md 개요 5 의 명시 문구를 따른 것이라 그대로 두었다.
- 오류는 SQLSTATE, 내부 오류 번호, 영문 메시지에 더해, SQL 문장 안의 위치(줄, 칸)를 가질 수 있다. 문법 오류는 항상 위치를 가진다. 9단계의 프로토콜 오류 메시지에 이 위치를 실어 드라이버와 CLI 가 보여 줄 수 있게 한다.
- 내부 오류 번호의 배정 : 1 ~ 999 공통, 1000번대 저장 엔진, 2000번대 타입 시스템, 3000번대 SQL 문법, 4000번대 카탈로그와 DDL, 5000번대 질의 실행. 번호와 SQLSTATE 의 목록은 `rdbms/src/common/errors.ts`에 있고 한 번 정한 번호는 바꾸지 않는다.

## 사용자 확인이 필요한 사항

지금 `rdbms` 와 `nodejsDriver` 에서 사용자 확인을 기다리는 것은 없다. 아래 3건은 2026-10-16 에 사용자가 정했고, 결정 내용은 "공통 인수인계 사항" 에 있다.

- 결정 1 : `hwdb` 가 화면에 내는 문구의 언어 → 지금은 영어만 낸다. 다만 언제든 다국어를 붙일 수 있게 문구를 메시지 카탈로그로 분리한다.
- 결정 2 : DML 의 행 단위 접근 → 보편적인 RDBMS 처럼 행 단위로 접근하도록 구현한다. 시기는 9단계 다음, 10단계 전이다.
- 결정 3 : 사용자·권한 문장에서 사양이 정하지 않은 규칙 → 보편적인 RDBMS 의 동작을 따른다. 지금 구현이 이미 그렇게 되어 있어 코드는 바꾸지 않는다.

보류한 프로젝트의 확인 사항(자바 빌드와 시험 환경, UI 프레임워크 등)은 각 PROGRESS.md 의 "미결 사항" 에 있으며, 보류를 풀 때 확인한다.

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
