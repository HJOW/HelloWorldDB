# 설계 기본안

이 문서는 상세 사양이 없는 부분의 **구현 기본안**이다. 사용자 확정 사항과 구분하며, 단계마다 시험으로 확정한다.
사양의 최상위 기준은 [AGENTS.md](../../AGENTS.md), 통신은 [프로토콜](../../rdbms/docs/protocol.md), 타입은 [타입 정책](../../rdbms/docs/data-types.md)이다.

## 1. 계층

```text
ODBC 진입점 (C ABI, 예외 차단)
    │  핸들·상태·진단·descriptor·버퍼 변환
    ├── 문장 실행기 (SQL/파라미터 조립, 커서, 결과 변환)
    ├── 세션 (SCRAM, 트랜잭션, 준비 문장, 취소)
    └── 전송 (TCP/TLS/UDP, 프레임, 재시도)
```

의존 방향은 한쪽이다. 전송 계층은 `SQLHSTMT` 나 앱 버퍼를 직접 만지지 않고, ODBC 계층은 소켓을 직접 다루지 않는다.
기존 `rdbms/src/client`, `nodejsDriver`, `jdbc6`/`jdbc8` 은 **참고**하되 C++ 코드가 그대로 공유된다고 가정하지 않는다.

## 2. 파일 배치

```text
unixodbc/
  CMakeLists.txt / CMakePresets.json
  include/hwdbodbc/           # 공개·내부 헤더
  src/odbc/                   # 진입점, 핸들, 속성, descriptor, 진단
  src/protocol/               # JSON, 프레임, SCRAM, 세션, 요청 ID, 커서
  src/transport/              # TCP, TLS(OpenSSL), UDP 신뢰성
  src/types/                  # SQL/C 타입 변환, UTF-8·UTF-16, 정확한 10진
  src/setup/                  # ConfigDSN (Setup 라이브러리, UO-12)
  tests/unit/                 # 네트워크 없는 시험
  tests/integration/          # 실제 rdbms·결함 주입·Manager 경유
  tests/helpers/              # 임시 서버, 격리 odbcinst, 정리
  tests/uo0.test.mjs          # 문서·환경 계약
  scripts/                    # 의존성 준비, 환경 조회, 빌드·시험
  docs/                       # 이 문서들
  build/ dist/ .deps/         # 생성물, Git 제외
```

## 3. 빌드·배포

- C++17, CMake 3.25 이상, Linux/macOS. 경고는 `-Wall -Wextra -Wpedantic -Werror`.
- `libhwdbodbc.so` 는 unixODBC Manager 에 링크하지 않는다. `-fvisibility=hidden` 과 version script 로 SQL* 심볼만 내보낸다.
  macOS 는 `-exported_symbols_list` 를 쓴다. SONAME 은 `libhwdbodbc.so.0`.
- OpenSSL 3 로 TLS 를 구현한다. (UO-10) TLS 1.0/1.1 이 필요한 구버전 클라이언트는 `SSL_CTX_set_security_level(0)` 과 최소 버전 설정으로만 허용하고 로그에 경고를 남긴다.
- JSON 은 MIT 라이선스의 단일 헤더 라이브러리(nlohmann/json 3.12.0)를 `third_party/` 에 고정한다. (UO-3 에서 도입, 출처·해시 기록)
- 배포물은 `libhwdbodbc.so`, 선택적 Setup 라이브러리, `odbcinst.ini` 예시, 사용 설명서이다. 배포판 패키징은 UO-12 에서 정한다.
- 설치 기본 위치는 `${prefix}/lib/<multiarch>/odbc/` 이고, unixODBC 등록은 `odbcinst -i` 또는 `odbcinst.ini` 편집으로 한다.

## 4. 핸들·상태

| 핸들 | 내용 | 수명 |
|---|---|---|
| ENV | ODBC 버전, 진단, DBC 목록 | `SQLAllocHandle` ~ `SQLFreeHandle` |
| DBC | 연결, 세션, 트랜잭션 상태, 자동 DESC | ENV 에 붙는다 |
| STMT | SQL, 준비 ID, 커서, ARD/APD/IRD/IPD, 상태 | DBC 에 붙는다 |
| DESC | ARD/APD(응용), IRD/IPD(구현) | STMT/DBC 에 붙고 자동 DESC 는 직접 해제 불가 |

문장 상태는 `S0 → P → X → R → F → Z` 이고 `X → N`(NEED_DATA)이 있다. 상태에 맞지 않는 호출은 `HY010` 이다.
`SQLFreeHandle` 은 자식·열린 커서·실행 중 요청을 확인한다. ENV 해제는 자식이 없을 때만 성공한다.

## 5. 스레드·동시성

- 한 DBC 의 일반 호출은 뮤텍스로 직렬화한다. 다른 DBC 는 병행한다.
- `SQLCancel` 은 실행 중인 DBC 에 다른 스레드에서 들어올 수 있어야 한다. 취소 경로는 뮤텍스를 기다리지 않고 원자 상태를 읽어 서버 `cancel` 을 보낸다.
- 실행 함수는 취소 완료를 기다리지 않고 서버의 최종 응답을 받아 `HY008` 또는 정상 결과로 끝낸다.
- 핸들·DESC 는 참조 계수로 수명을 관리한다. 해제 뒤의 접근은 재사용된 메모리를 읽지 않도록 즉시 무효 표시한다.
- 시험: 같은 DBC 에 동시 실행·취소·해제를 반복하는 T-HANDLE/T-CANCEL, 서버 10 세션 동시성은 UO-13.

## 6. 진단

- 핸들마다 가변 길이 진단 레코드 목록을 둔다. 각 레코드는 SQLSTATE(5), native(4바이트), 영문 메시지, 행·컬럼 번호를 가진다.
- 성공 호출은 기존 진단을 지우지 않는다. `SQLGetDiagRec` 은 1부터 읽고 끝나면 `SQL_NO_DATA`.
- `SQLGetDiagField` 의 header 필드(`SQL_DIAG_NUMBER`, `SQL_DIAG_RETURNCODE`, `SQL_DIAG_ROW_COUNT`)와 record 필드를 모두 지원한다.
- C++ 예외는 진입점 경계에서 차단한다. `bad_alloc → HY001`, 그 밖 → `HY000`.

## 7. 문자열

- 서버는 UTF-8. ANSI 경로는 UTF-8 바이트, W 경로는 2바이트 UTF-16.
- 변환은 직접 구현한다. 서러게이트 쌍·비정상 시퀀스·NUL 포함 여부를 검사한다.
- `SQLWCHAR` 크기는 빌드 시 확인한다. 4바이트 unixODBC 빌드는 지원하지 않고 구성 단계에서 실패시킨다.
- 이름·리터럴·식별자 규칙은 서버 파서를 신뢰한다. 드라이버가 SQL 을 재작성하지 않는다. (단, ODBC escape 는 `SQLNativeSql` 에서 변환)

## 8. 전송

- TCP: 4바이트 빅엔디언 길이 + UTF-8 JSON. 인증 전 64 KiB, 인증 후 16 MiB. 부분 수신·여러 메시지 동시 수신을 처리한다.
- TLS: OpenSSL. 서버 인증서를 기본 검증, `SQLDriverConnect` 속성으로 CA 파일·검증 끄기를 제공한다. 인증서 오류는 연결을 닫고 100 ms 뒤 최대 2회 재시도한다. (프로토콜 2-2절)
- UDP: 매직·버전·세션 ID·순번·조각 번호·플래그 헤더, ACK·재전송·중복 제거·순서 보장, `maxPacketSize` 분할. 세션 유지는 ping.
- 연결 상태는 `NEW → GREETED → CHALLENGED → READY → CLOSED` 이며 서버 상태 기계와 같다.
- 소켓은 논블로킹 + `poll` 로 읽고, 요청별 시간 제한을 건다. `EINTR` 은 재시도한다.
- SIGPIPE 를 쓰지 않도록 `MSG_NOSIGNAL`/`SO_NOSIGPIPE` 를 쓴다. (macOS/Linux 차이)

## 9. 실행·커서

- `execute`/`executePrepared` 의 `rows` 는 컬럼 메타데이터를 먼저 보관하고, 앱이 fetch 할 때 행 묶음 단위로 가져온다.
- 행은 서버 `rows` 배열 그대로 보관하지 않고 필요한 만큼만 유지한다. 큰 결과는 fetch 크기로 나눈다.
- `SQLGetData` 는 rowset=1 에서만 지원한다. unbound 컬럼을 순서대로 읽는 규칙을 지킨다.
- 결과 커서와 준비 문장 ID 는 독립이다. `SQLCloseCursor` 는 커서만, `SQLFreeStmt`/연결 종료는 둘 다 정리한다.
- 트랜잭션: 자동 커밋 ON 이 기본. OFF 에서 첫 문장에 `BEGIN`, `SQLEndTran`·`SQLSetConnectAttr(AUTOCOMMIT)` 에서 `COMMIT`/`ROLLBACK`. DDL 은 서버가 자동 커밋한다.
- `SQL_ATTR_RESET_CONNECTION` 은 연결을 유지한 채 세션 상태(트랜잭션·준비 문장·커서·타임존·테이블스페이스)를 초기화하고 SCRAM 재인증을 한다.

## 10. 시험 전략

| 층 | 도구 | 증거 |
|---|---|---|
| 단위 | C++ 실행 파일 + CTest | 파서·변환·상태·버퍼 수명, 네트워크 없음 |
| ABI | `hwdb_odbc_abi_probe` | dlopen·export·숨김 심볼·SONAME |
| 계약 | `node --test tests/uo0.test.mjs` | 문서·환경·API 표·서버 타입 대응 |
| Manager | 작은 C 앱 + 격리 `ODBCSYSINI`/`ODBCINI` | unixODBC → .so → 실제 서버 |
| 범용 앱 | `isql`, `iusql`, 필요 시 DBeaver/LibreOffice | 실제 사용 경로, 버전·한계 기록 |
| 결함 주입 | TCP 프록시·UDP 손실/중복 | 재시도·오류 매핑·정리 |

- 통합 시험은 `tests/helpers/server.mjs` 가 실제 `rdbms` 를 임시 디렉토리·빈 포트로 띄운다.
- unixODBC 설정은 시스템 `/etc` 를 건드리지 않고 `ODBCSYSINI`(odbcinst.ini 가 있는 디렉토리)와 `ODBCINI`(사용자 DSN 파일)로 격리한다.
- 빌드 성공, 직접 dlopen, Manager 경유, 실제 서버, 범용 앱은 각각 다른 증거로 기록한다.
