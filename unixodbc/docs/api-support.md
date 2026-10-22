# ODBC API·속성·길이 계약

**이 문서의 표는 최종 목표와 검증 의무이다.** 아직 구현된 ODBC 진입점은 없다. (UO-0/UO-1 골격만 있다)
드라이버 .so 생성, 직접 `dlopen`, unixODBC Manager 경유, 실제 서버, 범용 앱의 증거를 서로 합치지 않는다.

- ODBC 목표는 **3.8** 이고, Core 인터페이스와 서버가 제공하는 트랜잭션·카탈로그를 구현 대상으로 한다.
- 함수 분류는 [Microsoft ODBC Core 적합성](https://learn.microsoft.com/en-us/sql/odbc/reference/develop-app/core-interface-conformance?view=sql-server-ver17)과 [함수별 적합성](https://learn.microsoft.com/en-us/sql/odbc/reference/develop-app/function-conformance?view=sql-server-ver17)을 기준으로 한다. Unix 쪽 호출 규약은 unixODBC 2.3.x Driver Manager로 시험한다.
- 상태 약어와 진단 규칙은 [설계](design.md) 4절을 따른다. 모든 함수의 무효 핸들은 `SQL_INVALID_HANDLE`, 유효 핸들의 할당 실패는 `HY001`, 잘못된 길이는 함수별 `HY090`을 기본으로 한다.
- 시험 ID는 [검증 기록](verification.md)에 정의되어 있다. 표의 ID는 **예정**인 시험이다.

## 1. Unix export·문자열·길이 규칙

- 드라이버는 unixODBC Manager(`libodbc.so`)에 **링크하지 않는다.** Manager가 `dlopen`/`dlsym`으로 진입점을 찾는다. 그래서 .so 는 기본 가시성을 hidden 으로 두고 version script 로 SQL* 심볼만 내보낸다. (`src/odbc/exports.map`)
- ANSI 이름과 W 이름을 **각각 export** 한다. (`B/W`) 접미사 `A` 만 있는 함수는 만들지 않는다.
- ANSI 경로의 `SQLCHAR` 는 **UTF-8** 이다. 서버가 UTF-8 만 쓰므로 드라이버도 UTF-8 만 받는다. 올바르지 않은 UTF-8 은 `22021` 이다. 다른 로캘의 바이트를 조용히 해석하지 않는다.
- W 경로의 `SQLWCHAR` 는 unixODBC 2.3.x 기본값인 **2바이트 UTF-16** 이다. `SQL_WCHART_CONVERT` 로 `wchar_t`(Linux 4바이트)를 쓰는 unixODBC 빌드는 이 프로젝트의 지원 대상이 아니다. 빌드 시 `sizeof(SQLWCHAR)` 를 확인하고, 4바이트면 구성 단계에서 실패시킨다.
- 길이 단위는 호출 형태에 따라 다르다. 이 표의 `길이` 열에 적은 것은 **UO-2에서 시험으로 고정할 계약**이다.
  - 입력 문자열(`SQLConnect`, `SQLDriverConnect`, `SQLExecDirect`, `SQLPrepare`, `SQLNativeSql`, `SQLSetCursorName`) : ANSI는 바이트, W는 **SQLWCHAR 개수**.
  - 버퍼 함수(`SQLBindCol`, `SQLGetData`, `SQLBindParameter`, `SQLPutData`) : `BufferLength` 는 **바이트**.
  - 정보 반환(`SQLGetInfo`, `SQLColAttribute`, `SQLGetDiagRec`, `SQLGetDiagField`) : 함수별 ODBC 규약과 unixODBC가 넘기는 단위를 그대로 따르며, UO-2에서 ANSI/W 양쪽을 시험해 이 문서에 확정한다. 지금 단정하지 않는다.
- 종료 NUL 은 반환 길이에 포함하지 않는다.
- `SQLColAttribute` 문자열 속성의 `BufferLength` 단위는 UO-2에서 `isql`/`iusql` 로 확인해 고정한다. 확인 전의 추측을 계약으로 쓰지 않는다.
- 진단 메시지의 `SQLSTATE` 와 native 번호는 서버 값을 보존한다. (영문 메시지 고정)

## 2. 함수·export 표

| API | export | 담당 계층/단계 | 지원 호출 형태·계약 | 주요 진단 | 시험 ID |
|---|---|---|---|---|---|
| SQLAllocHandle | B | 핸들 UO-2 | ENV/DBC/STMT/명시 DESC, 자동 DESC 4개; 부모·자식 상태 검사 | HY010, HY009 | T-HANDLE |
| SQLFreeHandle | B | 핸들 UO-2 | 자식·실행 수명 확인, 자동 DESC 직접 해제 금지 | HY010, HY017 | T-HANDLE |
| SQLFreeStmt | B | 문장 UO-5/7 | CLOSE/UNBIND/RESET_PARAMS/DROP, 순서 검사 | HY010, HY092 | T-CURSOR |
| SQLGetDiagRec | B/W | 진단 UO-2 | 모든 핸들, 1부터 레코드, 조회가 진단을 지우지 않음 | 01004, SQL_NO_DATA | T-DIAG |
| SQLGetDiagField | B/W | 진단 UO-2/7 | header·record, 행/파라미터 배열의 행·컬럼 번호 | HY091, SQL_NO_DATA | T-DIAG |
| SQLGetEnvAttr | B | 속성 UO-4 | ODBC 버전·출력 NTS 조회 | HY092 | T-VERSION |
| SQLSetEnvAttr | B | 속성 UO-4 | DBC 할당 전 2/3/3.8 협상, 이후 변경 거부 | HY010, HY024 | T-VERSION |
| SQLGetConnectAttr | B/W | 속성 UO-4/8 | 아래 DBC 속성표의 D0/D1 조회 | HY092 | T-CONNECT |
| SQLSetConnectAttr | B/W | 속성 UO-4/8 | D0/D1별 변경, reset·autocommit 포함 | HY010, HY024, HYC00 | T-RESET |
| SQLGetStmtAttr | B/W | 속성 UO-5/7/8 | 아래 STMT 속성표, DESC 핸들·배열 주소 | HY092 | T-ATTR |
| SQLSetStmtAttr | B/W | 속성 UO-5/7/8 | 배열·descriptor 연결, 실행 중 변경 제한 | HY010, HY024, 01S02 | T-ATTR |
| SQLConnect | B/W | 접속 UO-4/12 | DSN·UID·PWD, D0→D1, 엄격한 UTF-8/UTF-16 | IM002, 08002, 28000 | T-CONNECT |
| SQLDriverConnect | B/W | 접속 UO-4/12 | DSN 없는 접속, NOPROMPT, 중복 키 첫 값, 암호 제거 | HY110, 01004, SQL_NO_DATA | T-CONNECT |
| SQLDisconnect | B | 세션 UO-4/8 | 미커밋 롤백·자식 자원 정리, 끊긴 연결도 정리 | 08003, HY010 | T-CONNECT |
| SQLExecDirect | B/W | 실행 UO-5 | S0/P→X→R/U, 문장 하나, 파라미터는 `?` | 24000, HY010, 서버 진단 | T-EXEC |
| SQLPrepare | B/W | 분석 UO-6 | 실행 부작용 없음, prepareDescribe 협상 | HYC00, HY010, 서버 진단 | T-PREPARE |
| SQLExecute | B | 실행 UO-6/7 | P→X/N→R/U, 버퍼는 실행 시 읽음 | HY010, 07002, 07006 | T-PARAM |
| SQLNumParams | B | 분석 UO-6 | 준비 후 서버 parameterCount | HY010 | T-PREPARE |
| SQLDescribeParam | B | 분석 UO-6 | 확정 타입만, UNKNOWN은 힌트/CAST 요청 | HYC00, 07009 | T-PREPARE |
| SQLBindParameter | B | 바인딩 UO-6/7 | INPUT, 단일·배열, SQL_DATA_AT_EXEC | HY105, HY003, HY004, 07009 | T-PARAM |
| SQLParamData | B | 바인딩 UO-7 | NEED_DATA 의 다음 입력 token, 마지막에 실행 | HY010, SQL_NEED_DATA | T-DAE |
| SQLPutData | B | 바인딩 UO-7 | 활성 파라미터의 분할 문자·이진·NULL | HY010, HY090, 22026 | T-DAE |
| SQLNativeSql | B/W | SQL escape UO-6 | 지원 escape 만 변환하고 실행하지 않음 | 01004, HYC00 | T-ESCAPE |
| SQLNumResultCols | B | 메타데이터 UO-5/6 | P/R/U, 결과 없으면 0 | HY010 | T-META |
| SQLRowCount | B | 결과 UO-5 | DML 영향 수, 조회는 -1 | HY010 | T-EXEC |
| SQLDescribeCol | B/W | 메타데이터 UO-5/6 | 결과 컬럼 1부터, 실행 전 준비 메타데이터 | 07009, 01004 | T-META |
| SQLColAttribute | B/W | 메타데이터 UO-5/6/9 | IRD 필드, 수치·문자열 출력 구분 | HY091, 07009, 01004 | T-META |
| SQLBindCol | B | 바인딩 UO-5/7 | ARD 바인딩·해제, 열·행 중심 배열 | HY003, 07009 | T-ROWSET |
| SQLFetch | B | 커서 UO-5/7 | R/F→F/Z, 행 묶음 전진 | 24000, 01004, SQL_NO_DATA | T-ROWSET |
| SQLFetchScroll | B | 커서 UO-5/7 | SQL_FETCH_NEXT 만, Offset 무시 규칙 | HY106, SQL_NO_DATA | T-ROWSET |
| SQLGetData | B | 변환 UO-5 | F, rowset=1, unbound 컬럼 순서, 분할 수신 | 07009, 22002, 01004 | T-GETDATA |
| SQLCloseCursor | B | 커서 UO-5 | R/F/Z→P 또는 S0 | 24000 | T-CURSOR |
| SQLGetCursorName | B/W | 커서 UO-5 | DBC 안의 자동·명시 이름 | 01004 | T-CURSOR |
| SQLSetCursorName | B/W | 커서 UO-5 | 커서 열기 전 설정, DBC 내 유일 | 3C000, 24000, HY010 | T-CURSOR |
| SQLMoreResults | B | 결과 UO-9 | 현재 결과 정리, 추가 결과 없음 | HY010, SQL_NO_DATA | T-CURSOR |
| SQLCopyDesc | B | descriptor UO-7 | 응용 DESC 복사, 읽기 전용 IRD 대상 금지 | HY016, HY021 | T-DESC |
| SQLGetDescField | B/W | descriptor UO-7 | header·record, 역할별 필드 | HY091, 07009 | T-DESC |
| SQLSetDescField | B/W | descriptor UO-7 | ARD/APD와 쓰기 가능한 IPD/header | HY016, HY091, HY021 | T-DESC |
| SQLGetDescRec | B/W | descriptor UO-7 | 1부터 record, 이름·타입·길이 | 07009, 01004, SQL_NO_DATA | T-DESC |
| SQLSetDescRec | B | descriptor UO-7 | 타입·정밀도·버퍼 일관성 | HY016, HY021 | T-DESC |
| SQLEndTran | B | 트랜잭션 UO-8 | DBC/ENV COMMIT·ROLLBACK, READ COMMITTED | HY012, 25S01, 서버 진단 | T-TXN |
| SQLCancel | B | 취소 UO-8 | 다른 스레드의 실행 취소, NEED_DATA 중단, idle 성공 | HY008, HY010 | T-CANCEL |
| SQLGetInfo | B/W | 능력 UO-9 | 정보별 실제 값·크기, 3.8 보고 규칙 | HY096, 01004 | T-INFO |
| SQLGetFunctions | B | 능력 UO-9 | 단일 ID, ALL_FUNCTIONS, ODBC3_ALL_FUNCTIONS | HY095 | T-INFO |
| SQLTables | B/W | 카탈로그 UO-9 | TABLE/VIEW, tablespace=TABLE_SCHEM, wildcard | HY009, HY090 | T-CATALOG |
| SQLColumns | B/W | 카탈로그 UO-9 | 선언 타입·순서·NULL 허용·권한 가시성 | HY009, HY090 | T-CATALOG |
| SQLGetTypeInfo | B/W | 타입 UO-9 | SQL_ALL_TYPES 와 실제 타입별 결과 | HY004 | T-TYPE |
| SQLStatistics | B/W | 카탈로그 UO-9 | PK 유일 인덱스·일반 인덱스·ASC/DESC | HY100, HY101 | T-CATALOG |
| SQLSpecialColumns | B/W | 카탈로그 UO-9 | SQL_BEST_ROWID=PK, SQL_ROWVER=빈 결과 | HY097, HY098 | T-CATALOG |
| SQLPrimaryKeys | B/W | 카탈로그 UO-9 | 복합 PK 컬럼 순서 | HY009, HY090 | T-CATALOG |
| SQLForeignKeys | B/W | 카탈로그 UO-9 | 같은 tablespace FK, 참조동작 | HY009, HY090 | T-CATALOG |
| SQLTablePrivileges | B/W | 카탈로그 UO-9 | 가시적인 실제 권한, GRANT OPTION 없음 | HY009, HY090 | T-CATALOG |
| SQLColumnPrivileges | B/W | 카탈로그 UO-9 | 컬럼 단위 권한 미지원, 정의된 빈 결과 | HY009, HY090 | T-CATALOG |
| SQLProcedures | B/W | 카탈로그 UO-9 | 저장 프로시저 미지원, 정의된 빈 결과 | HY090 | T-CATALOG |
| SQLProcedureColumns | B/W | 카탈로그 UO-9 | 위와 같음 | HY090 | T-CATALOG |
| SQLDrivers | DM | Manager UO-12/13 | 드라이버에 export 하지 않는다. Manager 가 열거 | Manager 진단 | T-INSTALL |
| SQLDataSources | DM | Manager UO-12/13 | 드라이버에 export 하지 않는다. Manager 가 DSN 열거 | Manager 진단 | T-INSTALL |

초기 제외: `SQLCancelHandle`, `SQLCompleteAsync`, `SQLBrowseConnect`, `SQLBulkOperations`, `SQLSetPos`, 비동기 실행, 출력 파라미터, bookmark, 스크롤·갱신 커서, 분산 트랜잭션.
ODBC 2.x 레거시 이름(`SQLAllocEnv`, `SQLAllocConnect`, `SQLAllocStmt`, `SQLTransact`, `SQLError`)은 Manager 매핑 경로만 시험하고 자체 export 하지 않는다.
`ConfigDSN`/`ConfigDriver` 는 별도 Setup 라이브러리(UO-12)이다.

## 3. ODBC 3.8 협상과 능력 보고

- ENV 에서 `SQL_OV_ODBC2`, `SQL_OV_ODBC3`, `SQL_OV_ODBC3_80` 을 받는다. 다른 값은 `HY024`, DBC 할당 뒤 변경은 `HY010`.
- 최종 `SQL_DRIVER_ODBC_VER` 는 `03.80` 이다. UO-8(reset)·UO-13(적합성) 전에는 3.8 완성을 광고하지 않는다. UO-9 까지는 `03.00` 으로 시작하고 단계 완료 시 올린다.
- 모든 바인딩·GetData·descriptor 설정에서 C 타입을 검사한다. 정의되지 않은 C 타입 `HY003`, 정의되지 않은 SQL 타입 `HY004`, 알려졌지만 미지원인 변환 `HYC00`/`07006`.
- `SQL_ASYNC_MODE=SQL_AM_NONE`, `SQL_ASYNC_DBC_FUNCTIONS=SQL_ASYNC_DBC_NOT_CAPABLE`. 비동기 활성화는 `HYC00`.
- `SQL_ODBC_INTERFACE_CONFORMANCE=SQL_OIC_CORE` 는 Core 호출 형태 시험을 모두 통과한 뒤에만 보고한다.
- `SQL_TXN_CAPABLE=SQL_TC_DDL_COMMIT`, 기본·유일 격리 수준은 `SQL_TXN_READ_COMMITTED`, `CURSOR_COMMIT_BEHAVIOR`/`CURSOR_ROLLBACK_BEHAVIOR=SQL_CB_PRESERVE`.
- 카탈로그는 없음(`SQL_CATALOG_NAME='N'`). **테이블스페이스는 `TABLE_SCHEM`** 에 대응한다. `CURRENT_CATALOG` 로 `USE` 를 실행하지 않는다.
- 식별자 인용 문자는 큰따옴표, 최대 128자. `SQL_MAX_CONCURRENT_ACTIVITIES` 는 서버 커서 한도 16을 보고하며, 이는 요청 병렬 실행을 뜻하지 않는다.
- `SQLGetFunctions` 의 true 비트는 실제 export·시험과 일치해야 한다. 구현하지 않은 함수를 true 로 보고하지 않는다.

## 4. ENV·DBC 속성

| 속성 | 계약 | 단계·시험 |
|---|---|---|
| SQL_ATTR_ODBC_VERSION | DBC 전 2/3/3.8 협상, 명시 설정 필요 | UO-4 T-VERSION |
| SQL_ATTR_OUTPUT_NTS | SQL_TRUE, FALSE 는 미지원 | UO-4 T-VERSION |
| SQL_ATTR_LOGIN_TIMEOUT | 0=드라이버 제한 없음, 서버 인증 10초와 별개 | UO-4 T-CONNECT |
| SQL_ATTR_CONNECTION_TIMEOUT | 0=제한 없음, 소켓·명령 단계에 적용 | UO-4 T-CONNECT |
| SQL_ATTR_AUTOCOMMIT | SQL_AUTOCOMMIT_ON 기본, OFF→ON 커밋 실패 보존 | UO-8 T-TXN |
| SQL_ATTR_TXN_ISOLATION | SQL_TXN_READ_COMMITTED 만 | UO-8 T-TXN |
| SQL_ATTR_ACCESS_MODE | SQL_MODE_READ_WRITE/SQL_MODE_READ_ONLY | UO-4 T-CONNECT |
| SQL_ATTR_METADATA_ID | SQL_FALSE 기본, SQL_TRUE 는 대소문자 구분 인용 규칙 | UO-9 T-CATALOG |
| SQL_ATTR_CURRENT_CATALOG | 변경 시 `HYC00` (USE 는 앱이 SQL 로 실행) | UO-9 T-CATALOG |
| SQL_ATTR_QUIET_MODE | 실제 창이 없으므로 저장만 하고 프롬프트는 사용하지 않음 | UO-12 T-INSTALL |
| SQL_ATTR_RESET_CONNECTION | SQL_RESET_CONNECTION_YES: 세션 상태 초기화, 재인증 | UO-8 T-RESET |
| SQL_ATTR_CONNECTION_DEAD | 실제 연결 상태 보고 (읽기 전용) | UO-8 T-RESET |

`SQL_ATTR_CONNECTION_POOLING`/`SQL_ATTR_CP_MATCH` 는 Manager 담당이다. 실제 풀 재사용은 UO-8·UO-13에서 따로 시험하며, 드라이버의 reset 시험을 Manager 풀 증거로 대신하지 않는다.

## 5. STMT·DESC 속성

| 속성/필드 | 계약 | 단계·시험 |
|---|---|---|
| SQL_ATTR_APP_ROW_DESC / APP_PARAM_DESC | 문장별 자동 DESC, 교체 가능 | UO-7 T-DESC |
| SQL_ATTR_IMP_ROW_DESC / IMP_PARAM_DESC | 읽기 전용, 설정 시 HY016 | UO-7 T-DESC |
| SQL_ATTR_ROW_ARRAY_SIZE | 1 이상, 행 묶음 크기 | UO-5/7 T-ROWSET |
| SQL_ATTR_ROW_BIND_TYPE | SQL_BIND_BY_COLUMN 또는 행 길이 | UO-7 T-ROWSET |
| SQL_ATTR_ROW_BIND_OFFSET_PTR | 앱 주소·정렬 검사 | UO-7 T-ROWSET |
| SQL_ATTR_ROW_STATUS_PTR | 행 상태 배열, 정리 후에도 앱 메모리 불변 | UO-7 T-ROWSET |
| SQL_ATTR_ROWS_FETCHED_PTR | 이번 fetch 행 수 | UO-7 T-ROWSET |
| SQL_ATTR_PARAMSET_SIZE | 파라미터 배열 크기, 실행 시 스냅샷 | UO-7 T-PARAM |
| SQL_ATTR_PARAM_BIND_TYPE | 열·행 중심 | UO-7 T-PARAM |
| SQL_ATTR_PARAM_BIND_OFFSET_PTR | 앱 주소·정렬 검사 | UO-7 T-PARAM |
| SQL_ATTR_PARAM_STATUS_PTR / PARAMS_PROCESSED_PTR | 부분 실패 위치 보고 | UO-7 T-PARAM |
| SQL_ATTR_PARAM_OPERATION_PTR | SQL_PARAM_IGNORE / SQL_PARAM_PROCEED | UO-7 T-PARAM |
| SQL_ATTR_ROW_OPERATION_PTR | 행 무시 규칙 | UO-7 T-ROWSET |
| SQL_ATTR_MAX_ROWS / QUERY_TIMEOUT | 상한·시간 제한, 취소 기능 필요 | UO-8 T-TIMEOUT |
| SQL_ATTR_CURSOR_TYPE / CONCURRENCY / SCROLLABLE | FORWARD_ONLY·READ_ONLY 만, 그 외 HYC00 | UO-5 T-CURSOR |
| SQL_ATTR_USE_BOOKMARKS | SQL_UB_OFF 만 | UO-7 T-DESC |
| SQL_ATTR_CURSOR_SENSITIVITY | SQL_INSENSITIVE | UO-5 T-CURSOR |
| SQL_DESC_COUNT / TYPE / LENGTH / PRECISION / SCALE | 역할별 검사, 읽기 전용 IPD 변경 금지 | UO-7 T-DESC |
| SQL_DESC_DATA_PTR / INDICATOR_PTR / OCTET_LENGTH_PTR | 정렬·NULL 허용 검사, NEED_DATA 중 변경 금지 | UO-7 T-DAE |
| SQL_DESC_ARRAY_SIZE / ARRAY_STATUS_PTR / BIND_OFFSET_PTR / BIND_TYPE | 묶음 실행 규칙 | UO-7 T-PARAM |

## 6. 핸들·상태·동시성

- 핸들 종류: ENV → DBC → STMT, 명시 DESC 는 DBC/STMT 에 붙는다. STMT 는 ARD/APD/IRD/IPD 를 가진다. IRD/IPD 는 읽기 전용이다.
- 상태: `S0`(할당됨, 문장 없음), `P`(준비됨), `X`(실행 중), `N`(NEED_DATA), `R`(결과 있음), `F`(fetch 중), `Z`(결과 닫힘).
- `SQLCancel` 은 다른 스레드에서 실행 중인 `X` 에 진입할 수 있어야 한다. 일반 호출은 DBC 단위로 직렬화하고, 취소 경로는 별도 원자 상태와 서버 `cancel` 요청을 쓴다.
- 핸들·DESC 참조는 원자 참조 계수로 관리한다. 앱이 자식 핸들을 해제한 뒤 Manager 가 늦게 접근하는 경우를 고려하되, 해제된 메모리를 재사용하지 않는다.
- 오류는 핸들별 가변 길이 진단 목록에 쌓고, 성공 호출이 기존 진단을 지우지 않는다. `SQLGetDiagRec` 은 1부터, 없으면 `SQL_NO_DATA`.
- `SQLFreeHandle(SQL_HANDLE_ENV)` 은 자식 DBC/STMT 가 없을 때만 성공한다. 자동 DESC 는 직접 해제할 수 없다(`HY017`).

## 7. 문장 실행 흐름

- `SQLExecDirect` 는 서버 `execute` 한 번이다. 결과가 `rows` 면 커서를 열고, `ok` 면 `SQLRowCount` 를 채운다.
- `SQLPrepare` 는 `prepare`(prepareDescribe 기능 필요) → `describe` 로 컬럼·파라미터 메타데이터를 얻는다. 기능이 없으면 `HYC00` 이고 SQL 을 실행해 메타데이터를 흉내 내지 않는다.
- `SQLExecute` 는 `executePrepared` 로 파라미터를 보낸다. 파라미터 값은 실행 시점에 앱 버퍼에서 읽는다.
- `SQLParamData`/`SQLPutData` 는 `SQL_NEED_DATA` 상태에서 입력을 모은 뒤 실행한다. 서버로 보내기 전의 취소는 로컬에서 끝낸다.
- 서버 커서는 최대 16개이고, 결과는 fetch 크기 단위로 나누어 받는다. `SQLCloseCursor`·`SQLFreeStmt`·연결 종료에서 서버 `closeCursor` 를 보낸다.
- DDL·GRANT·REVOKE·사용자/테이블스페이스 관리 문장은 서버가 자동 커밋한다. 드라이버는 트랜잭션 상태를 서버 응답에 맞춘다.

## 8. 진단·버퍼 안전 규칙

- 앱 버퍼를 쓰기 전에 길이·정렬·indicator 포인터를 검사한다. 정의되지 않은 포인터는 역참조하지 않는다.
- 분할 출력은 `01004` 와 실제 잘린 길이를 남기고, 다음 `SQLGetData` 호출에서 이어 받게 한다.
- 정수·NUMERIC 변환은 `double` 을 거치지 않는다. BIGINT는 문자열에서 64비트로, DECIMAL 은 10진 문자열/`SQL_NUMERIC_STRUCT` 로 다룬다.
- UTF-8 ⇄ UTF-16 변환은 서러게이트 쌍을 검사한다. 잘못된 시퀀스는 `22021`, 버퍼 부족은 `01004`.
- 모든 공개 진입점은 C++ 예외를 밖으로 내보내지 않는다. `std::bad_alloc` 은 `HY001`, 예상 밖 예외는 `HY000` 으로 바꾼다.
