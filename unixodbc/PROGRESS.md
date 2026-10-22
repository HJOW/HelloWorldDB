# unixodbc 개발 계획과 진행 상황

HelloWorldDB 에 접속하는 **Unix ODBC(unixODBC) 드라이버**를 개발하는 프로젝트이다.
Linux/macOS 의 unixODBC Driver Manager 를 쓰는 C/C++ 프로그램, `isql`·`iusql`, ODBC 지원 도구가 대상이다. Windows 네이티브 ODBC 는 [winodbc](../winodbc/PROGRESS.md)가 담당한다.

사양의 최상위 기준은 [AGENTS.md](../AGENTS.md)이다. 통신은 [서버 프로토콜](../rdbms/docs/protocol.md), 데이터 타입은 [서버 타입 정책](../rdbms/docs/data-types.md)을 따른다. ODBC API 는 AGENTS.md 가 연결한 [Microsoft ODBC 문서](https://learn.microsoft.com/ko-kr/sql/odbc/microsoft-open-database-connectivity-odbc?view=sql-server-ver17)와 unixODBC 2.3.x 동작을 함께 기준으로 한다.

## 현재 상태

- 최종 갱신: 2026-10-22
- 진행 단계: **UO-0(환경·계약) 완료, UO-1(빌드·C ABI 기반) 골격 착수.** 이 프로젝트에는 **아직 ODBC 함수(`SQL*`) 구현이 없다.** `libhwdbodbc.so` 는 빌드·가시성·dlopen·시험 기반을 확인하는 골격이며 `isql` 로 접속할 수 없다.
- 이번 작업: 디렉토리·빌드·시험 환경, root 권한 없는 의존성 준비(`.deps`), 환경 조회, 문서 계약(API·타입·서버 기능·검증 ID), 실제 `rdbms` 스모크 시험을 만들었다.
- 이번 검증: Debian 13.7 / GCC 14.2.0 / CMake 4.4.4 / unixODBC 2.3.12 / Node.js 24.16.0 에서 `dev`·`release`·`asan` 세 프리셋의 CTest **각 4개, 합계 12개 통과**(실패·건너뜀 0). `abi.load`, `env.inspect`, `docs.contract`, `integration.server_smoke` 이다. 32비트는 아직 실행하지 않았다.

- 다음 작업: UO-1 의 SQL* 진입점 표·export, unixODBC Manager 격리 시험, `abi.load` 확장(내보낸 심볼 ↔ API 표, Manager 링크 없음 확인). 그 뒤 UO-2(핸들·진단·문자열).
- 현재 요청 범위: **환경 구축과 계획 문서까지**이다. ODBC 동작 구현은 후속 작업으로 남긴다.

## 1. 이 문서를 따라 작업하는 방법

1. 매 작업 시작 시 [AGENTS.md](../AGENTS.md), 이 문서의 현재 상태, 해당 단계, [API 계약](docs/api-support.md), [서버 의존성](docs/server-dependencies.md), [프로토콜](../rdbms/docs/protocol.md)을 읽는다. 이전 대화의 기억만으로 메시지 필드나 함수 계약을 정하지 않는다.
2. UO 번호가 작은 단계부터 진행한다. 선행 조건이 끝나지 않았으면 의존하지 않는 작업까지만 하고 이유를 적는다.
3. 체크박스 하나를 구현할 때 그 동작을 확인하는 시험을 함께 만든다. 성공 경로만 보지 말고 잘못된 입력·호출 순서·정리·자원 해제를 확인한다.
4. 빌드 성공, 직접 `dlopen`, unixODBC Manager 경유, 실제 서버, 범용 앱은 **서로 다른 증거**이다. 어느 경로로 시험했는지 적는다.
5. 완료 조건을 모두 채운 항목만 `[x]` 로 바꾼다. 함수 이름만 export 했거나 항상 성공을 돌려주는 스텁은 완료가 아니다.
6. 사양에 없는 선택을 했으면 "10. 미결 사항과 결정 기록"에 근거를 남긴다. 서버 사양·프로토콜 변경이 필요하면 AGENTS.md와 서버 문서를 먼저 고친 뒤 구현한다.
7. 작업을 마치기 전 "현재 상태", "작업 이력", "다음 작업"을 갱신하고 루트 [PROGRESS.md](../PROGRESS.md)에도 요약한다.
8. 코드와 Markdown 은 UTF-8, 주석·설명은 한국어로 쓴다. DB 오류 메시지는 영문으로 유지한다.
9. **git commit·push 는 하지 않는다.** 조회·pull 만 한다. (AGENTS.md 지켜야 할 사항 3)
10. PC가 바뀌면 [환경 기록](docs/environment.md)에 호스트명·도구 버전·절대 경로를 다시 남긴다. 이전 PC의 설치 기록을 새 PC의 근거로 쓰지 않는다.

## 2. 목표와 설계 기본안

아래는 상세 사양이 없는 부분의 **기본안**이다. UO 단계에서 시험으로 확정하고, 바꾸면 근거를 기록한다.

| 항목 | 기본안 |
|---|---|
| 구현 | C++17, CMake 3.25 이상, Linux/macOS |
| ODBC 목표 | ODBC 3.8, Core + 서버가 제공하는 트랜잭션·카탈로그 |
| 문자열 | ANSI 경로 UTF-8, W 경로 2바이트 UTF-16. 4바이트 `SQLWCHAR` 빌드는 미지원 |
| export | 드라이버 .so 는 Manager 에 링크하지 않음. hidden 가시성 + version script |
| 배포 이름 | 표시명 `HelloWorldDB ODBC Driver`, 라이브러리 `libhwdbodbc.so.0` |
| 전송 | TCP → TLS → UDP 신뢰성 계층. 로컬 유닉스 소켓은 `hwdb` CLI 전용이라 쓰지 않음 |
| TLS | OpenSSL 3. 인증서 검증 기본, CA 지정·검증 끄기 속성 제공, 실패 시 100ms 뒤 최대 2회 재시도 |
| SQL 처리 | SQL 과 파라미터를 분리 전송. 서버를 대신하는 SQL 실행기를 만들지 않음 |
| 실행 | 동기 ODBC 호출. DBC 단위 직렬화, `SQLCancel` 은 별도 경로 |
| 결과 | 전진·읽기 전용, 서버 fetch 묶음 단위. `SQLGetData` 는 rowset=1 |
| 카탈로그 | `SYS_*` 딕셔너리 뷰를 SQL 로 조회. 서버에 ODBC 전용 요청을 만들지 않음 |
| 설치 | `lib/odbc/` 에 .so, `odbcinst.ini` 예시, 선택적 Setup 라이브러리 |
| 실행 의존성 | 순수 네이티브. Node.js·JVM·Python 프로세스를 중간에 두지 않음 |
| 32비트 | 기본 지원 아님. UO-13 선택 항목 |
| 패키지명 | Node/Java 가 아니므로 AGENTS.md 6항의 패키지명 규칙 대상이 아니다. C++ namespace 는 `hwdb::odbc` |

초기 제외: 비동기 ODBC, 스크롤·갱신 커서, bookmark, 출력 파라미터, 저장 프로시저, 분산 트랜잭션, ARM64/macOS 의 실제 앱 인수(가능한 범위만), Windows.
**입력 파라미터 배열, descriptor, data-at-execution, `SQLCancel` 은 "선택 기능"으로 빼지 않는다.** Core 호출 형태와 필요한 속성을 UO-7·UO-13에서 확인한다.

## 3. 계층과 파일 배치

```text
unixodbc/
  PROGRESS.md
  README.md
  CMakeLists.txt / CMakePresets.json
  include/hwdbodbc/                 # version.hpp 등 공개·내부 헤더
  src/odbc/                         # C ABI, 핸들, 속성, descriptor, 진단
  src/protocol/                     # JSON, 프레임, SCRAM, 세션, 요청 ID, 커서
  src/transport/                    # TCP, TLS, UDP 신뢰성
  src/types/                        # SQL/C 타입, UTF-8·UTF-16, 정확한 10진
  src/setup/                        # ConfigDSN (Setup 라이브러리, UO-12)
  tests/unit/                       # 네트워크 없는 시험, env·abi probe
  tests/integration/                # 실제 서버·결함 주입·Manager 경유
  tests/helpers/                    # 임시 서버·격리 odbcinst·정리
  tests/uo0.test.mjs                # 문서·환경 계약
  scripts/                          # 의존성, 환경 조회, 빌드·시험
  docs/
  build/ dist/ .deps/               # 생성물, Git 제외
```

의존 방향은 `ODBC 진입점 → 핸들/타입/세션 → 프로토콜 → 전송` 이다. 전송 코드가 `SQLHSTMT` 나 앱 버퍼를 직접 만지지 않는다. Setup 라이브러리에서 SQL 실행기를 복제하지 않는다.

## 4. 전체 작업 순서

| 단계 | 산출물 | 다음 단계로 넘어갈 조건 |
|---|---|---|
| UO-0 | **완료**: 환경·API 계약·타입·서버 의존성·검증 ID·빌드 기반 | 환경 JSON·문서 계약·스모크 시험 통과 |
| UO-1 | **진행 중**: .so·C ABI·export·Manager 격리 시험 | dlopen·export 표·Manager 로드·숨김 심볼 시험 통과 |
| UO-2 | 핸들·진단·문자열 | 수명·다중 진단·UTF 변환·SQLWCHAR 경계 통과 |
| UO-3 | TCP·JSON·SCRAM·세션 | 실제 서버 인증·프레임·id 0·결함 주입 통과 |
| UO-4 | DSN·연결 속성·`isql` 로그인 | Manager 경유 로그인·우선순위·원격 거부 통과 |
| UO-5 | 직접 실행·fetch·타입 변환 | Hello World·18개 타입·분할 수신 통과 |
| UO-6 | prepare·describe·파라미터 | 실행 전 메타데이터·반복 실행 통과 |
| UO-7 | descriptor·배열·실행 시 데이터 | 바인딩 상태·NEED_DATA·부분 실패 통과 |
| UO-8 | 트랜잭션·취소·시간 제한·reset | 취소 경합·잠금·재인증·세션 정합성 통과 |
| UO-9 | 카탈로그·기능 보고 | 지원표와 실제 결과 일치, `isql` 메타데이터 |
| UO-10 | TLS | 검증 기본·CA·실패·재시도·TLS 1.2/1.0 시험 통과 |
| UO-11 | UDP | 유실·중복·순서 뒤바뀜·분할에서도 정합성 유지 |
| UO-12 | DSN·Setup·설치·제거 | 등록·접속·정리, `ODBCSYSINI` 격리 시험 통과 |
| UO-13 | 적합성·실제 앱·배포 인수 | Core·상태·앱·문서 체크리스트 통과 |

각 단계는 앞 단계의 산출물을 전제로 한다. UO-10·UO-11은 UO-3의 전송 구조를 확장하고, UO-12는 UO-4·UO-9의 결과를 묶는다.

## 5. 단계별 구현 절차

### UO-0. 환경·계약·빌드 기반 확정

선행 조건: AGENTS.md, 서버 protocol.md, winodbc의 선행 계획을 읽는다.

- [x] UO-0.1: 호스트 환경 조회 스크립트(`scripts/inspect-environment.mjs`)와 기록 형식을 만들고, 이 PC의 결과를 [환경 기록](docs/environment.md)에 남겼다. 호스트명·OS·도구 버전·`.deps` 경로·SQLWCHAR 2바이트를 확인했다.
- [x] UO-0.2: root 없이 쓸 수 있는 의존성 준비(`scripts/setup-deps.sh`)를 만들었다. 시스템 설치와 프로젝트 `.deps` 추출 두 경로를 지원한다.
- [x] UO-0.3: CMake·CTest 프리셋(`dev`, `release`, `asan`), 골격 `libhwdbodbc.so`, `dlopen` ABI 시험을 만들었다. 드라이버는 unixODBC Manager 에 링크하지 않는다.
- [x] UO-0.4: [API 지원 계약](docs/api-support.md)에 ODBC Core 함수 전체와 추가 카탈로그·준비 함수, 속성·descriptor·길이 단위·단계·시험 ID를 적었다.
- [x] UO-0.5: [타입 계약](docs/type-mapping.md)에 서버의 모든 typeName·UNKNOWN, ODBC/C 타입, 길이 단위, 손실·오류 규칙을 적었다.
- [x] UO-0.6: [서버 의존성](docs/server-dependencies.md)에 capability 협상, 요청 대응, 취소·준비 수명, 진단 매핑, 한도를 적었다.
- [x] UO-0.7: [의존성 정책](docs/dependencies.md)에 unixODBC 2.3.x, OpenSSL 3, JSON, 배포·등록 정책을 정했다.
- [x] UO-0.8: [검증 기록](docs/verification.md)에 T-ENV ~ T-CONFORM 시험 ID를 정의하고 문서 참조를 맞췄다.
- [x] UO-0.9: 문서 계약 시험(`tests/uo0.test.mjs`)과 실제 rdbms 스모크 시험(`tests/integration/server-smoke.test.mjs`)을 만들었다.
- [ ] UO-0.10: 최소 지원 배포판·macOS의 실제 빌드는 UO-13에서 확인한다. 이 PC의 Debian 13 결과를 최소 배포판 인수로 쓰지 않는다.

완료 기준: 이 호스트에서 환경 JSON이 생성되고, 문서 계약·ABI·스모크 시험이 통과한다. 이 단계의 통과는 ODBC API 구현 완료가 아니다.

### UO-1. .so·C ABI·Manager 격리 시험 기반

- [x] UO-1.1: `libhwdbodbc.so.0`(SOVERSION 0)과 버전 스크립트, macOS export 목록, hidden 가시성을 구성했다.
- [x] UO-1.2: `hwdb_odbc_build_id` 골격 심볼과 `dlopen`·숨김 심볼 ABI 시험을 만들었다.
- [ ] UO-1.3: API 표의 `B/W`/`B`/`DM` 분류대로 SQL* 진입점을 export 하고, `abi.load` 가 **내보낸 목록 ↔ API 표 ↔ 헤더 원형**을 대조하게 한다.
- [ ] UO-1.4: C++ 심볼·RTTI·DATA 심볼이 노출되지 않고 `libodbc` 에 의존하지 않음을 `readelf -d`/`nm -D` 시험으로 확인한다.
- [ ] UO-1.5: 격리된 `ODBCSYSINI`·`ODBCINI` 에 임시 `odbcinst.ini` 를 만들고 unixODBC Manager 로 `SQLAllocHandle(SQL_HANDLE_ENV)`·`SQLSetEnvAttr` 만 호출하는 최소 시험 앱을 만든다. (로그인은 UO-4)
- [ ] UO-1.6: Manager 가 잘못된 `SQLWCHAR` 크기·헤더 버전과 만났을 때의 실패 방식을 기록하고, 구성 단계 검사를 넣는다.
- [x] UO-1.7: `dev`·`release`·`asan` 프리셋을 실제로 돌려 각 4개 시험이 통과했다. (2026-10-22)

완료 기준: 빈 구현이라도 Manager 가 .so 를 로드하고 ENV 핸들까지 도달하며, 내보낸 심볼이 계약과 정확히 일치한다. 이 단계에서는 SQL 실행 성공을 주장하지 않는다.

### UO-2. 핸들·진단·문자열

- [ ] UO-2.1: ENV/DBC/STMT/명시 DESC 핸들, 자동 DESC(ARD/APD/IRD/IPD), 참조 계수와 해제 규칙.
- [ ] UO-2.2: 핸들별 가변 진단 목록, `SQLGetDiagRec`/`SQLGetDiagField`, header/record 필드, 성공 시 진단 보존.
- [ ] UO-2.3: ENV 속성(ODBC 2/3/3.8 협상, OUTPUT_NTS), DBC 할당 뒤 변경 거부.
- [ ] UO-2.4: UTF-8 ↔ UTF-16 변환, 서러게이트·비정상 시퀀스·NUL·길이 경계, 2바이트 `SQLWCHAR` 검사.
- [ ] UO-2.5: C++ 예외 경계(`bad_alloc→HY001`, 그 밖→`HY000`), 무효 핸들 `SQL_INVALID_HANDLE`.
- [ ] UO-2.6: `iusql` 로 ENV 수준 동작을 확인할 수 있는 최소 연결 전 단계 시험. (로그인은 UO-4)
- [ ] UO-2.7: T-HANDLE·T-DIAG·T-TEXT·T-VERSION 시험 통과.

완료 기준: 핸들·진단·문자열이 Manager 경유와 직접 호출 양쪽에서 같은 규칙으로 동작하고, 해제 후 접근이 안전하다.

### UO-3. 저수준 JSON·TCP·SCRAM·세션

- [ ] UO-3.1: 엄격한 UTF-8 JSON 해석·생성(16 MiB·인증 전 64 KiB), 모르는 필드 무시·모르는 type 거부.
- [ ] UO-3.2: 4바이트 빅엔디언 프레임, 부분 수신·여러 메시지 동시 수신, 논블로킹 `poll`, `EINTR`, `SIGPIPE` 방지.
- [ ] UO-3.3: SCRAM-SHA-256 클라이언트(nonce·PBKDF2·StoredKey/ServerKey 검증), 인증 10초 제한, 실패 시 연결 정리.
- [ ] UO-3.4: 세션 상태 기계(NEW→GREETED→CHALLENGED→READY→CLOSED), 요청 ID 짝, `id:0` 서버 알림.
- [ ] UO-3.5: `helloOk` 검증(버전·capabilities·maxMessageBytes·defaultFetchSize), 기능 없는 서버에 새 요청을 보내지 않는 규칙.
- [ ] UO-3.6: 실제 서버로 hello/auth/execute/fetch/close 를 수행하는 저수준 probe(`hwdb_odbc_protocol_probe`).
- [ ] UO-3.7: 손상 프레임·크기 초과·조기 종료·잘못된 nonce/서명 시험(T-PROTO·T-AUTH).

완료 기준: ODBC 계층 없이 실제 서버와 인증·단순 실행·fetch·정상 종료가 되고, 잘못된 응답을 성공으로 처리하지 않는다.

### UO-4. DSN·연결 속성·Manager 경유 로그인

- [ ] UO-4.1: `SQLConnect`/`SQLDriverConnect`(ANSI/W), 연결 문자열 파서(`{}`·`}}`, 중복 키 첫 값, 암호 제거), `NOPROMPT`.
- [ ] UO-4.2: `odbcinst.ini`/`odbc.ini` 읽기 없이 Manager 가 넘긴 속성만 사용하는 기본 경로. DSN 이름·드라이버 경로 해석은 unixODBC에 맡긴다.
- [ ] UO-4.3: DBC 속성(login/connection timeout, access mode, metadata id, current catalog, quiet mode), `SQLDisconnect`.
- [ ] UO-4.4: 원격 접속의 CONNECT 권한 거부, 루프백 판정, 서버 메시지 보존.
- [ ] UO-4.5: 격리된 `ODBCSYSINI`/`ODBCINI` 로 `isql`·`iusql` 로그인·종료 시험.
- [ ] UO-4.6: DSN 없는 접속(`DRIVER={HelloWorldDB ODBC Driver}`)과 등록 이름/절대 경로 두 방식.
- [ ] UO-4.7: T-CONNECT·T-VERSION 시험 통과.

완료 기준: unixODBC Manager → 드라이버 → 실제 서버 로그인이 두 비트 수가 아닌 이 플랫폼에서 되고, 실패 시 연결·자원이 남지 않는다.

### UO-5. 직접 실행·결과·타입 변환

- [ ] UO-5.1: `SQLExecDirect`(ANSI/W), 문장 하나, `rows`/`ok`/`error` 구분, `SQLRowCount`.
- [ ] UO-5.2: 결과 컬럼 메타데이터(`SQLNumResultCols`, `SQLDescribeCol`, `SQLColAttribute`), W 이름·길이.
- [ ] UO-5.3: `SQLBindCol`·`SQLFetch`·`SQLFetchScroll(NEXT)`·`SQLGetData`(rowset=1), 지연 fetch.
- [ ] UO-5.4: 18개 타입과 C 타입 변환, 정확한 10진, UTF-8/UTF-16, 날짜시간·13개 INTERVAL.
- [ ] UO-5.5: 커서 이름·닫기·`SQLFreeStmt` 옵션, 서버 커서 16개 한도와 정리.
- [ ] UO-5.6: AGENTS.md 의 Hello World 두 샘플과 CRUD, 권한·제약 오류 보존.
- [ ] UO-5.7: T-EXEC·T-META·T-ROWSET·T-GETDATA·T-CURSOR·T-TYPE 시험 통과.

완료 기준: `isql` 로 조회·DML·타입 왕복이 되고, 앱 버퍼 경계·NULL indicator·분할 수신이 안전하다.

### UO-6. prepare/describe·파라미터

- [ ] UO-6.1: `SQLPrepare`(W 포함)와 `prepareDescribe` 협상, 기능 없으면 `HYC00`.
- [ ] UO-6.2: `describe` 메타데이터, UNKNOWN·타입 힌트, `SQLNumParams`·`SQLDescribeParam`.
- [ ] UO-6.3: `SQLBindParameter`(INPUT, 단일), 실행 시 버퍼 읽기, `executePrepared`.
- [ ] UO-6.4: 반복 실행·재분석·권한 재검사, 무효화(`0A000`/`8009`) 시 앱에 재준비 요구.
- [ ] UO-6.5: `SQLNativeSql` 의 ODBC escape 처리(날짜·함수·outer join·LIKE), CALL/GUID 거부.
- [ ] UO-6.6: T-PREPARE·T-ESCAPE·T-PARAM(단일) 시험 통과.

완료 기준: 실행 전에 컬럼·파라미터 메타데이터를 얻고, 준비 문장을 값 치환 없이 반복 실행한다.

### UO-7. descriptor·배열·실행 시 데이터

- [ ] UO-7.1: ARD/APD/IRD/IPD 필드, 자동 DESC 교체·공유·`SQLCopyDesc`, 읽기 전용 위반.
- [ ] UO-7.2: 행 배열(열·행 중심, offset, status, rows fetched)과 canary 검사.
- [ ] UO-7.3: 파라미터 배열(paramset size, status, processed, operation, 부분 실패).
- [ ] UO-7.4: `SQLParamData`/`SQLPutData`(NEED_DATA, 분할·NULL·길이), 도중 취소·정리.
- [ ] UO-7.5: `SQL_ATTR_*` STMT 속성 전수, 실행 중 변경 제한·`01S02`.
- [ ] UO-7.6: T-DESC·T-ROWSET·T-PARAM·T-DAE·T-ATTR 시험 통과.

완료 기준: descriptor 와 배열을 쓰는 앱이 값 손실·버퍼 침범 없이 동작하고, NEED_DATA 가 끊겨도 연결을 재사용할 수 있다.

### UO-8. 트랜잭션·취소·시간 제한·reset

- [ ] UO-8.1: autocommit ON/OFF, `SQLEndTran` COMMIT/ROLLBACK, DBC/ENV 수준, DDL 자동 커밋.
- [ ] UO-8.2: 다른 스레드의 `SQLCancel`, 실행 중 상태·원자 플래그, 서버 `cancel`·`cancelAck` 경합.
- [ ] UO-8.3: `HY008`·`HYT00`·`HYT01` 구분, 잠금 대기·교착, 세션 유지.
- [ ] UO-8.4: `SQL_ATTR_QUERY_TIMEOUT`, `SQL_ATTR_MAX_ROWS`, 취소 뒤 자원 정리.
- [ ] UO-8.5: `SQL_ATTR_RESET_CONNECTION` 재인증·세션 상태 초기화, Manager 풀 재사용 시험.
- [ ] UO-8.6: T-TXN·T-CANCEL·T-TIMEOUT·T-RESET 시험 통과.

완료 기준: 취소와 시간 제한이 문장 단위로 끝나고, 앞선 트랜잭션 변경·연결 상태가 규칙대로 유지된다.

### UO-9. 카탈로그·기능·속성 보고

- [ ] UO-9.1: `SYS_TABLES`·`SYS_COLUMNS` 등 딕셔너리 뷰를 SQL 로 조회해 `SQLTables`·`SQLColumns` 구성.
- [ ] UO-9.2: 테이블스페이스=`TABLE_SCHEM`, 카탈로그 없음, wildcard·escape·권한 가시성.
- [ ] UO-9.3: `SQLStatistics`·`SQLSpecialColumns`·`SQLPrimaryKeys`·`SQLForeignKeys`·`SQLTablePrivileges`.
- [ ] UO-9.4: `SQLGetTypeInfo`(SQL_ALL_TYPES 포함), `SQLGetInfo`·`SQLGetFunctions` 실제 값.
- [ ] UO-9.5: `SQL_DRIVER_ODBC_VER` 를 `03.80` 으로 올릴 시점 확정, 3.8 완성 광고 여부.
- [ ] UO-9.6: T-INFO·T-CATALOG·T-TYPE(SQLGetTypeInfo) 시험 통과.

완료 기준: DB툴·`isql` 이 객체·컬럼·키·타입을 실제와 같게 본다. 보고한 함수 비트와 실제 export 가 일치한다.

### UO-10. TCP TLS

- [ ] UO-10.1: OpenSSL 3 컨텍스트, 서버 인증서·호스트 이름 검증 기본, CA 파일 지정, 검증 끄기 속성.
- [ ] UO-10.2: 최소 버전 설정(기본 TLS 1.2, 필요 시 1.0/1.1 + `SECLEVEL=0`·경고 로그).
- [ ] UO-10.3: 인증서 오류 시 100 ms 뒤 새 연결로 최대 2회 재시도, 다른 오류는 재시도 금지.
- [ ] UO-10.4: TLS 위에서 SCRAM·실행·fetch·트랜잭션·대량 결과.
- [ ] UO-10.5: T-TLS 시험 통과, `isql`/`iusql` 로 실제 TLS 접속.

완료 기준: 인증서 오류를 성공으로 넘기지 않고, 검증을 끄지 않는 기본 경로가 실제 서버에서 동작한다.

### UO-11. UDP 신뢰성 계층

- [ ] UO-11.1: 패킷 헤더(매직·버전·세션 ID·순번·조각·플래그), `maxPacketSize` 분할·재조립.
- [ ] UO-11.2: ACK·재전송·중복 제거·순서 보장, 세션 시간 초과, ping.
- [ ] UO-11.3: SCRAM·실행·fetch·트랜잭션을 UDP 로 수행, 결과 크기·손실 대응.
- [ ] UO-11.4: 유실·중복·순서 뒤바뀜·지연을 일부러 만든 시험(T-UDP).
- [ ] UO-11.5: UDP 미지원 서버·방화벽 실패 시 명확한 진단과 정리.

완료 기준: 결함 주입 상태에서도 중복 실행·값 손상 없이 끝나고, UDP 세션이 남지 않는다. UDP 구간은 암호화하지 않는다는 사양을 지킨다.

### UO-12. DSN·Setup·설치·제거

- [ ] UO-12.1: `ConfigDSN`/`ConfigDriver` 를 별도 Setup 라이브러리로 구현하고 `odbcinst -i` 경로 확인.
- [ ] UO-12.2: `odbcinst.ini` 등록·해제, 드라이버 이름·경로, DSN 예시, 비밀번호 미저장.
- [ ] UO-12.3: 설치 스크립트·`ldconfig`·multiarch 경로, 제거 시 잔여 파일 확인.
- [ ] UO-12.4: 설정 UI 범위 결정(CLI/파일 우선, GUI 는 선택), `SQL_ATTR_QUIET_MODE`.
- [ ] UO-12.5: 격리된 `ODBCSYSINI` 로 등록→접속→제거 시험(T-INSTALL).
- [ ] UO-12.6: 배포 패키지 형식(.deb 우선, tar.gz)과 서명·체크섬 정책.

완료 기준: 새 호스트에서 등록·DSN 접속·제거가 문서만 보고 재현되고, 시스템 설정을 남기지 않는다.

### UO-13. 적합성·실제 앱·최종 인수

- [ ] UO-13.1: Core 호출 형태·상태·진단·descriptor 적합성 표를 실제 결과로 채운다.
- [ ] UO-13.2: `isql`·`iusql` 로 로그인·CRUD·대량 결과·트랜잭션·취소.
- [ ] UO-13.3: 범용 앱(DBeaver·LibreOffice·Python `pyodbc` 등 가능한 것) 실제 접속·화면 증거.
- [ ] UO-13.4: Release·ASan·UBSan, 가능하면 32비트·macOS 빌드 행렬.
- [ ] UO-13.5: 10 세션 동시성·대량 결과·장시간 실행·자원 누수 점검.
- [ ] UO-13.6: README·사용 설명서·설치 안내·알려진 한계 정리, 루트 PROGRESS 갱신.

완료 기준: AGENTS.md 개요 8(ODBC)과 상세 8-1의 지원 범위, 이 문서의 API 표를 각각 확인하는 시험이 있고 모두 통과한다.

## 6. 타입 대응과 데이터 손실 규칙

요약이다. 전체 표는 [타입 계약](docs/type-mapping.md)에 있다.

- 문자: CHAR/VARCHAR → `SQL_WCHAR`/`SQL_WVARCHAR`, C 는 `SQL_C_WCHAR`/`SQL_C_CHAR`. 코드 포인트 길이와 UTF-8/UTF-16 바이트를 구분한다.
- 이진: BINARY/VARBINARY → `SQL_BINARY`/`SQL_VARBINARY`, wire 는 대문자 hex.
- 정수: SMALLINT/INTEGER/BIGINT → `SQL_SMALLINT`/`SQL_INTEGER`/`SQL_BIGINT`. BIGINT wire 는 문자열.
- 고정소수: DECIMAL(별칭 NUMERIC/DEC) → `SQL_DECIMAL`. 38자리, `double` 우회 금지.
- 부동소수: REAL/DOUBLE PRECISION → `SQL_REAL`/`SQL_DOUBLE`. NaN·무한대 거부.
- 논리: BOOLEAN → `SQL_BIT`.
- 날짜시간: DATE/TIME/TIMESTAMP → `SQL_TYPE_*`, timezone 타입은 문자열(`SQL_WVARCHAR`)로 오프셋 보존.
- 기간: INTERVAL → 13개 `SQL_INTERVAL_*` 와 대응 구조체.
- 준비 UNKNOWN → `SQL_UNKNOWN_TYPE`, 힌트/CAST 뒤 재분석.

길이 초과는 자르지 않고 오류, 소수부만 잘리는 경우는 `01S07`, 출력 버퍼 부족은 `01004` 이다.

## 7. Unix 고유 검토 사항

1. **`SQLWCHAR` 크기** : unixODBC 2.3.x 기본은 2바이트 UTF-16 이다. 4바이트로 빌드한 Manager 와 섞이면 문자열이 깨진다. 빌드 시 `sizeof(SQLWCHAR)` 를 확인하고, 지원하지 않는 크기면 구성 단계에서 실패시킨다. (`SQL_WCHART_CONVERT` 사용 금지)
2. **Manager 미링크** : 드라이버 .so 는 `libodbc` 에 링크하지 않는다. 링크하면 Manager 심볼 충돌·이중 로드가 생길 수 있다. `readelf -d` 로 확인한다.
3. **심볼 가시성** : 기본 hidden, version script 로 SQL* 만 export. `extern "C"` 를 빠뜨리면 Manager 가 찾지 못한다.
4. **ANSI 경로의 인코딩** : `SQLCHAR` 는 UTF-8 로 고정한다. 앱 로캘이 UTF-8 이 아닌 경우 unixODBC가 변환하지 않으므로 드라이버가 다른 인코딩을 추측하지 않는다. 잘못된 바이트는 `22021`.
5. **길이 단위** : ANSI 는 바이트, W 의 문자열 길이는 SQLWCHAR 개수, 버퍼 함수의 `BufferLength` 는 바이트. 함수별로 시험해 고정한다.
6. **DSN 등록** : 시스템 `/etc/odbcinst.ini` 를 직접 고치지 않는다. 시험은 `ODBCSYSINI`(odbcinst.ini 디렉터리)와 `ODBCINI`(사용자 DSN 파일)로 격리한다. `odbcinst -j` 로 실제 경로를 확인한다.
7. **unixODBC ini 캐싱** : 2.3.12 는 `ENABLE_INI_CACHING` 으로 빌드됐다. 등록·해제 시험은 프로세스를 새로 띄워 캐시 영향을 분리한다.
8. **`isql` 과 `iusql`** : ANSI 경로는 `isql`, W 경로·한글은 `iusql` 로 확인한다. 둘 다 실제 앱 증거이며 드라이버 단위 시험과 구분한다.
9. **신호·소켓** : `SIGPIPE` 로 프로세스가 죽지 않게 `MSG_NOSIGNAL`/`SO_NOSIGPIPE`, `EINTR` 재시도, `poll` 시간 제한을 쓴다.
10. **TLS** : OpenSSL 3 는 TLS 1.0/1.1 을 기본 보안 수준에서 거부한다. 서버 최소 버전을 낮춘 경우에만 `SECLEVEL=0` 을 쓰고 로그에 경고를 남긴다. 인증서 검증 기본은 끄지 않는다.
11. **로컬 채널 미사용** : `/tmp/helloworlddb-<포트>.sock` 은 CLI 전용이다. ODBC 드라이버는 TCP/TLS/UDP 만 쓴다. 따라서 `tcp.enabled=false` 인 서버에는 ODBC 로 접속할 수 없다는 것을 문서에 밝힌다.
12. **배포 경로** : Debian multiarch 는 `/usr/lib/x86_64-linux-gnu/odbc/`, macOS/Homebrew 는 별도 prefix. `odbcinst.ini` 의 `Driver=` 는 절대 경로를 쓴다.
13. **32비트** : multilib·32비트 unixODBC 가 필요하다. 기본 검증에 넣지 않고 UO-13 선택 항목으로 둔다.
14. **종료 처리** : ODBC 에는 프로세스 종료 훅이 없다. 앱이 `SQLDisconnect`/`SQLFreeHandle` 을 빠뜨려도 서버 세션이 오래 남지 않도록 서버 유휴 제한과 드라이버의 소켓 정리를 확인한다.

## 8. 오류·상태·동시성 검토표

| 상황 | ODBC 결과 | 비고 |
|---|---|---|
| 무효·해제된 핸들 | `SQL_INVALID_HANDLE` | 진단 핸들 없음 |
| 상태에 맞지 않는 호출 | `HY010` | 예: 준비 없이 Execute |
| 알 수 없는 속성·필드 | `HY092`/`HY091` | 성공으로 무시하지 않음 |
| 잘못된 속성 값 | `HY024` | ODBC 버전·배열 크기 등 |
| 미지원 기능·속성 | `HYC00` | 3.8 미완성 광고 금지 |
| 잘못된 C/SQL 타입 | `HY003`/`HY004` | 정의되지 않은 타입 |
| 변환 불가 | `07006` | 타입 계열 차이 |
| 문자열 인코딩 오류 | `22021`/`22018` | UTF-8·UTF-16, 숫자 변환 |
| 값 범위 초과 | `22003` | 정수부·NUMERIC |
| 출력 버퍼 부족 | `01004` | 실제 길이 보고, 분할 |
| 소수부만 손실 | `01S07` | TIME 구조체 등 |
| 결과 없음 | `SQL_NO_DATA` | fetch·GetData·Diag 끝 |
| 잠금 대기·교착 | 서버 `55P03`/`40P01` 보존 | 전체 트랜잭션 롤백 여부 확인 |
| 실행 취소 | `HY008` | 원 서버 `57014`/native 보존 |
| query timeout | `HYT00` | 서버 취소와 구분 |
| 연결 동작 제한 | `HYT01` | 연결 정리 |
| 연결 끊김·프로토콜 위반 | `08S01` | native·원인 보존, DML 재실행 금지 |
| 메모리 부족 | `HY001` | `bad_alloc` 경계 |
| 예상 밖 예외 | `HY000` | C++ 예외 차단 |

동시성 원칙:

- DBC 하나의 일반 호출은 직렬화한다. 같은 DBC 에 두 스레드가 동시에 `SQLExecute` 를 부르면 `HY010` 이다.
- `SQLCancel` 만 예외적으로 실행 중 DBC 에 진입한다. 취소 요청은 서버 `cancel` 로 가고, 실행 함수는 최종 응답을 받아 끝난다.
- 핸들 해제와 실행이 겹치면 해제가 이기지 않게 참조 계수를 확인한다. 해제 후 접근은 즉시 `SQL_INVALID_HANDLE` 이다.
- 10 세션 동시성은 UO-13에서 실제 서버로 확인한다.

## 9. 인수인계와 피해야 할 구현

### 지금 있는 것

- `CMakeLists.txt` : unixODBC 헤더 탐색, C++17, 경고, hidden 가시성, `libhwdbodbc.so.0`, `abi.load`/`env.inspect`/`docs.contract`/`integration.server_smoke`.
- `src/odbc/scaffold.cpp` : **임시 골격**이다. UO-1.3에서 SQL* 진입점으로 교체한다.
- `scripts/setup-deps.sh` : root 없이 `.deps/sysroot`(unixODBC 2.3.12)와 `.deps/python`(CMake)를 만든다.
- `scripts/inspect-environment.mjs` : `build/<프리셋>/uo0/environment.json` 생성.
- `tests/helpers/server.mjs` : 실제 `rdbms` 를 임시 디렉토리·빈 포트로 띄우고 정상 종료한다.
- 문서: API·타입·서버 의존성·설계·의존성·환경·검증.

### 피해야 할 구현

1. **SQL 을 실행해 메타데이터를 흉내 내는 것** : prepareDescribe 가 없으면 `HYC00` 이다.
2. **항상 성공하는 스텁** : 미지원 함수·속성은 `HYC00`, 순서 오류는 `HY010`.
3. **앱 버퍼 크기를 무시하는 쓰기** : canary·indicator 시험을 먼저 만든다.
4. **`double` 을 거치는 DECIMAL·BIGINT 변환** : 정밀도 손실.
5. **Manager 에 링크하거나 모든 심볼을 노출하는 것** : `libodbc` 의존·심볼 충돌.
6. **시스템 `/etc/odbcinst.ini` 를 고치는 시험** : `ODBCSYSINI`/`ODBCINI` 로 격리한다.
7. **서버 스레드·이벤트 루프를 드라이버에 복제하는 것** : 드라이버는 동기 클라이언트이다.
8. **취소를 `SQLCancel` 반환 성공으로 끝내는 것** : 실행 함수의 `HY008`/정상 결과까지 확인한다.
9. **연결을 잃은 뒤 DML 을 자동 재실행하는 것** : 중복 반영 위험.
10. **4바이트 `SQLWCHAR` 를 조용히 지원하는 것처럼 광고하는 것** : 빌드 전제와 다르면 실패시킨다.

## 10. 미결 사항과 결정 기록

### 결정 기록

| 날짜 | 결정 | 근거 |
|---|---|---|
| 2026-10-22 | 프로젝트 디렉토리·문서·단계 번호를 `unixodbc` / UO-0 ~ UO-13 으로 둔다 | AGENTS.md 구현 계획 8번, winodbc 와 대칭 |
| 2026-10-22 | C++17 + CMake, Linux/macOS | 기존 winodbc 경험, unixODBC 헤더 사용 |
| 2026-10-22 | 드라이버 .so 는 Manager 에 링크하지 않고 hidden + version script | unixODBC 플러그인 규약 |
| 2026-10-22 | ANSI=UTF-8, W=2바이트 UTF-16, 4바이트 `SQLWCHAR` 미지원 | 서버 UTF-8 전용, unixODBC 2.3.x 기본 |
| 2026-10-22 | TLS 는 OpenSSL 3 | Linux/macOS 공통, 인증서 검증·최소 버전 제어 |
| 2026-10-22 | 로컬 유닉스 소켓은 드라이버가 쓰지 않는다 | CLI 전용 채널, ODBC 는 네트워크 드라이버 |
| 2026-10-22 | root 없는 개발을 `.deps/` 로 지원 | 이 호스트에 sudo 암호가 필요하고 시스템을 바꾸지 않기 위함 |
| 2026-10-22 | 문서 계약 시험을 CTest 에 넣는다 | UO-0 산출물이 실제로 유지되는지 확인 |

### 사용자 확인이 필요한 사항

1. **32비트 지원** : 기본 미지원으로 두었다. 필요하면 UO-13 전에 multilib 환경과 함께 확정해야 한다.
2. **macOS 실제 앱 인수 범위** : 빌드만 할지, `isql`·ODBC 앱까지 인수할지 정해야 한다.
3. **Setup UI** : `ConfigDSN` 을 CLI/파일 우선으로 할지, GUI 설정 도구까지 만들지 정해야 한다. (초기 기본안: CLI/파일)
4. **배포 형식** : `.deb` 우선 + `tar.gz` 로 둘지, `.rpm`·Homebrew formula 까지 할지.
5. **TLS 최소 버전 기본값** : 서버 기본과 같이 TLS 1.2 로 두었다. 구형 클라이언트 지원 요구가 있으면 낮출 수 있다.

### 미결·위험

- unixODBC 배포판별 `SQLWCHAR` 4바이트 빌드가 실제로 얼마나 쓰이는지 확인하지 못했다. 빌드 검사로 막고, 필요하면 별도 빌드 변형을 검토한다.
- `SQLColAttribute` 등 일부 함수의 W 길이 단위는 구현·시험으로 확정해야 한다. 문서의 계약과 실제 unixODBC 동작이 다르면 UO-2에서 문서를 고친다.
- Manager 풀 재사용·reset 은 unixODBC 버전·앱에 따라 차이가 있다. UO-8에서 실제 Manager 로 확인한다.
- 대량 결과에서 서버 fetch 파일과 드라이버 메모리 사용량은 UO-5·UO-13에서 계측한다.

## 11. 작업 이력

- 2026-10-22 : **unixodbc 프로젝트 환경과 계획을 만들었다.** AGENTS.md·루트 PROGRESS.md·winodbc 계획·서버 프로토콜을 읽고 UO-0 ~ UO-13 계획, API·타입·서버 의존성·설계·의존성·환경·검증 문서를 작성했다. CMake·CTest(dev/release/asan) 기반, `libhwdbodbc.so.0` 골격과 version script, `hwdb_odbc_abi_probe`·`hwdb_odbc_env_probe`, 문서 계약 시험(`tests/uo0.test.mjs`), 실제 `rdbms` 스모크 시험과 서버 도우미를 만들었다. root 권한이 없어 `.deps/sysroot`(unixODBC 2.3.12)·`.deps/python`(CMake 4.4.4)로 의존성을 준비하는 스크립트를 넣었다. Debian 13.7 / GCC 14.2.0 / Node.js 24.16.0 에서 세 프리셋의 CTest 가 각 4개씩, 합계 12개 통과했다. ODBC 함수는 아직 구현하지 않았고, UO-1의 나머지가 다음 작업이다. 커밋·푸시는 하지 않았다.
