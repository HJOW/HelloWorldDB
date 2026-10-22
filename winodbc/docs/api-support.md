# ODBC 지원 계약

**뒤의 전체 표는 최종 목표와 검증 의무이다.** 현재 구현은 다음 표와 [검증 기록](verification.md)을 따른다. DLL 생성·직접 호출·Manager 경유·실제 서버·범용 앱의 증거를 합치지 않는다. 3.8/Core 적합성은 아직 완료하지 않았다.

| 현재 export | 구현·시험 범위 | 남은 범위 |
|---|---|---|
| SQLAllocHandle / SQLFreeHandle | ENV/DBC/STMT/명시 DESC·네 자동 DESC·공유/교체·부모/자식·무효/해제 후·동시 조회/해제 | 연결된 DESC 해제 직후 Manager 조회 재현 사례·실행 중 해제 WO-7/8/13 |
| SQLSetEnvAttr / SQLGetEnvAttr | ODBC 2/3/3.8·OUTPUT_NTS, DBC 할당 이후 버전 변경 거부 | 전체 버전 적합성 WO-13 |
| SQLGetDiagRec/W·SQLGetDiagField/W | 모든 핸들·다중 Unicode 레코드·header·행/파라미터 배열의 행/컬럼·native·W 길이·취소/시간 초과 진단 | 전체 적합성 WO-13 |
| SQLConnect/W | 엄격한 문자열 입력, User/System DSN 로그인·명시 값 우선·원격 CONNECT 거부 | 설정 UI/등록 WO-12 |
| SQLDriverConnect/W·SQLDisconnect | TCP·NOPROMPT·DSN 없는 로그인/종료, 엄격한 연결 문자열·암호 제거 | prompting·DSN·다른 전송 WO-10/11/12 |
| SQLGet/SetConnectAttr/W | login/connection timeout·autocommit·metadata id·access mode·격리·dead·catalog 없음·quiet mode·재인증 reset | 실제 Manager 풀 재사용 WO-8/13 |
| SQLGet/SetStmtAttr/W | 자동/명시 descriptor·공유/자동 IPD·전진/읽기 전용·최대 행·행/파라미터 배열/offset·상태/처리 수·query timeout | 전체 속성 감사 WO-9/13 |
| SQLGet/SetDescField/W·GetDescRec/W·SetDescRec·CopyDesc | 역할별 필드·폭·이름·일관성 검사·복사·같은 바인딩 상태·교차 연결 잠금·NEED_DATA 변경 거부 | 여러 STMT 공유 상태의 Manager 해제 재현 WO-7/13 |
| SQLExecDirect/W·NumResultCols·RowCount·DescribeCol/W·ColAttribute/W | 조회/DML·실행 전 메타데이터·실제 타입/정밀도·한글 이름·W 길이·영향 행 수 | 전체 정보 필드 감사 WO-9 |
| SQLPrepare/W·Execute·NumParams·DescribeParam·BindParameter | 서버 준비/설명/실행/해제·UNKNOWN/힌트·INPUT 배열·실행 시 앱 버퍼 읽기 | 출력 파라미터 제외 |
| SQLParamData·SQLPutData·SQLCancel | NEED_DATA token·분할 입력·NULL·예고 길이·배열 상태·로컬 입력/서버 실행 취소·늦은 취소 | 전체 동시성 인수 WO-13 |
| SQLEndTran | DBC/ENV의 COMMIT/ROLLBACK·READ COMMITTED·DDL 자동 커밋·연결 종료 롤백 | 분산 트랜잭션 제외 |
| SQLNativeSql/W | 날짜시간·함수·outer join·LIKE escape의 실행 없는 변환·NOSCAN | CALL/GUID escape 미지원 |
| SQLBindCol·Fetch·FetchScroll(NEXT)·GetData | 열/packed 행 배열·앱 주소·NULL·정확한 38자리 소수/64비트·날짜시간·13개 INTERVAL·분할 | GetData는 rowset=1, BLOCK 미지원 |
| SQLCloseCursor·FreeStmt·MoreResults·Get/SetCursorName/W | 서버 커서/준비 자원 정리·모든 FreeStmt 옵션·단일 결과 종료·자동/명시/인용 커서 이름 | positioned DML 미지원 |
| SQLGetInfo/W·SQLGetFunctions | 제품명·기본 문자열 정보·실제 구현 함수의 단일/배열/ODBC3 비트맵 | 전체 정보/함수 감사 WO-9/13 |

고정 비상 진단으로 bad_alloc→HY001, 예상 밖 예외→HY000을 처리한다. 정상 레코드는 가변 길이 목록을 사용한다. ENV 할당 자체의 실패는 진단 핸들이 없어 SQL_ERROR이다. [상태·잠금·문자열 구현](state-machines.md)과 [트랜잭션·취소·초기화](transactions-cancel-reset.md)를 따른다. SQL_DRIVER_ODBC_VER는 현재 `03.00`으로 유지하며, 3.8 앱의 Manager 경로에서 버전 경고가 붙을 수 있다. reset의 직접 DLL 시험은 실제 Manager 풀 재사용의 증거가 아니다. 속성 미지원은 성공으로 무시하지 않는다.

ODBC 3.8을 목표로 하며, [Core 목록](https://learn.microsoft.com/en-us/sql/odbc/reference/develop-app/core-interface-conformance?view=sql-server-ver17)과 [함수별 분류](https://learn.microsoft.com/en-us/sql/odbc/reference/develop-app/function-conformance?view=sql-server-ver17)를 확인했다. 입력 배열·실행 시 데이터·descriptor·다중 스레드 취소를 완료 기준에 포함한다. 아래의 호출 형태·오류 선택은 이 프로젝트의 구현 계약이며 함수별 공식 진단표를 각 구현 단계에서 재확인한다.

## 함수·export 표

`B/W`는 **접미사 없는 ANSI 이름과 W 이름을 각각 export**한다는 뜻이다. `B`는 SDK의 원형 하나만 export한다. A 접미사만 제공하지 않는다. ANSI 텍스트와 SQL_C_CHAR는 Windows ACP로 엄격하게 변환하고 표현 불가 시 22018을 반환한다. UTF-16·UTF-8 오류는 22021이다. SDK에 W 원형이 없는 함수에 W 이름을 만들지 않는다. SDK가 W 원형을 정의한 SQLGetTypeInfo·StmtAttr도 포함한다.

상태 약어는 [상태·진단 계약](#상태진단동시성)을 따른다. 모든 함수의 무효 핸들은 SQL_INVALID_HANDLE, 유효 핸들의 할당 실패는 HY001, 잘못된 길이는 함수별 HY090을 기본으로 한다. 테스트 ID는 [시험 목록](verification.md)에 정의하며, 표의 ID는 **예정**인 시험이다.

| API | export | 담당 계층/단계 | 지원 호출 형태·상태 | 주요 오류·종료 | 시험 ID |
|---|---|---|---|---|---|
| SQLAllocHandle | B | 핸들 WO-2/7 | ENV/DBC/STMT/명시 DESC; E/D 상태 검사 | HY010, HY009 | T-HANDLE |
| SQLFreeHandle | B | 핸들 WO-2/7 | 자식·실행 수명 확인; 자동 DESC 직접 해제 금지 | HY010, HY017 | T-HANDLE |
| SQLFreeStmt | B | 문장 WO-5/7 | CLOSE/UNBIND/RESET_PARAMS/DROP; N/X 순서 검사 | HY010, HY092 | T-CURSOR |
| SQLGetDiagRec | B/W | 진단 WO-2 | 모든 핸들, 1부터 레코드; 조회가 진단을 지우지 않음 | 01004, SQL_NO_DATA | T-DIAG |
| SQLGetDiagField | B/W | 진단 WO-2/7 | header/record, 행·컬럼 번호·반환 코드 | HY091, SQL_NO_DATA | T-DIAG |
| SQLGetEnvAttr | B | 속성 WO-4 | 버전·출력 NTS 조회 | HY092 | T-VERSION |
| SQLSetEnvAttr | B | 속성 WO-4 | DBC 할당 전 버전 협상 | HY010, HY024 | T-VERSION |
| SQLGetConnectAttr | B/W | 속성 WO-4/8 | D0/D1, 아래 DBC 표 | HY092 | T-CONNECT |
| SQLSetConnectAttr | B/W | 속성 WO-4/8 | D0/D1별 변경; reset 포함 | HY010, HY024, HYC00 | T-RESET |
| SQLGetStmtAttr | B/W | 속성 WO-5/7/8 | S별 속성·DESC 핸들·배열 주소 | HY092 | T-ATTR |
| SQLSetStmtAttr | B/W | 속성 WO-5/7/8 | 배열·descriptor 연결; X/N 중 변경 제한 | HY010, HY024, 01S02 | T-ATTR |
| SQLConnect | B/W | 접속 WO-4/12 | DSN·UID·PWD, D0→D1 | IM002, 08002, 28000 | T-CONNECT |
| SQLDriverConnect | B/W | 접속 WO-4/12 | NOPROMPT 우선, PROMPT/COMPLETE는 WO-12 | HY110, 01004, SQL_NO_DATA(UI 취소) | T-CONNECT |
| SQLDisconnect | B | 세션 WO-4/8 | 미커밋 rollback·자식 자원 정리; dead도 정리 | 08003, HY010 | T-CONNECT |
| SQLExecDirect | B/W | 실행 WO-5 | S0/P→X→R/U, 문장 하나 | 24000, HY010, 서버 진단 | T-EXEC |
| SQLPrepare | B/W | 분석 WO-6 | S0/P→P, 실행 부작용 없음; 기능 협상 | HYC00, HY010, 서버 진단 | T-PREPARE |
| SQLExecute | B | 실행 WO-6/7 | P→X/N→R/U, 버퍼는 실행 시 읽음 | HY010, 07002, 07006 | T-PARAM |
| SQLNumParams | B | 분석 WO-6 | P 이후 서버 parameterCount | HY010 | T-PREPARE |
| SQLDescribeParam | B | 분석 WO-6 | 확정 타입만; UNKNOWN은 힌트/CAST 요청 | HYC00, 07009 | T-PREPARE |
| SQLBindParameter | B | 바인딩 WO-6/7 | INPUT, 단일/배열, SQL_DATA_AT_EXEC | HY105, HY003, HY004, 07009 | T-PARAM |
| SQLParamData | B | 바인딩 WO-7 | N의 다음 입력 token, 마지막에 실제 실행 | HY010, SQL_NEED_DATA | T-DAE |
| SQLPutData | B | 바인딩 WO-7 | N의 활성 파라미터, 분할 문자/이진·NULL | HY010, HY090, 22026 | T-DAE |
| SQLNativeSql | B/W | SQL escape WO-6 | 지원 escape만 변환, SQL 실행 안 함 | 01004, HYC00 | T-ESCAPE |
| SQLNumResultCols | B | 메타데이터 WO-5/6 | P/R/U, 결과 없음은 0 | HY010 | T-META |
| SQLRowCount | B | 결과 WO-5 | DML 영향 수, 조회 미확정은 -1 | HY010 | T-EXEC |
| SQLDescribeCol | B/W | 메타데이터 WO-5/6 | 결과 컬럼 1부터, 준비 후 실행 전도 동일; 미정은 SQL_UNKNOWN_TYPE | 07009, 01004 | T-META |
| SQLColAttribute | B/W | 메타데이터 WO-5/6/9 | IRD 필드; 수치와 문자열 출력 구분 | HY091, 07009, 01004 | T-META |
| SQLBindCol | B | 바인딩 WO-5/7 | ARD 바인딩/해제, 열·행 중심 배열 | HY003, 07009 | T-ROWSET |
| SQLFetch | B | 커서 WO-5/7 | R/F→F/Z, 전진 행 묶음 | 24000, 01004, SQL_NO_DATA | T-ROWSET |
| SQLFetchScroll | B | 커서 WO-5/7 | SQL_FETCH_NEXT만, Offset 무시 규칙 준수 | HY106, SQL_NO_DATA | T-ROWSET |
| SQLGetData | B | 변환 WO-5 | F, rowset=1, 증가하는 unbound 컬럼 순서, 분할 | 07009, 22002, 01004, SQL_NO_DATA | T-GETDATA |
| SQLCloseCursor | B | 커서 WO-5 | R/F/Z→P 또는 S0 | 24000 | T-CURSOR |
| SQLGetCursorName | B/W | 커서 WO-5 | DBC 안의 자동/명시 이름 조회 | 01004 | T-CURSOR |
| SQLSetCursorName | B/W | 커서 WO-5 | 커서 열기 전 이름 설정, DBC 내 유일 | 3C000, 24000, HY010 | T-CURSOR |
| SQLMoreResults | B | 결과 WO-9 | 현재 결과 정리, 한 문장이라 추가 결과 없음 | HY010, SQL_NO_DATA | T-CURSOR |
| SQLCopyDesc | B | descriptor WO-7 | 응용 DESC 복사, 읽기 전용 IRD를 대상 금지 | HY016, HY021 | T-DESC |
| SQLGetDescField | B/W | descriptor WO-7 | header/record, 역할별 필드 | HY091, 07009 | T-DESC |
| SQLSetDescField | B/W | descriptor WO-7 | ARD/APD 및 쓰기 가능한 IPD/header 필드 | HY016, HY091, HY021 | T-DESC |
| SQLGetDescRec | B/W | descriptor WO-7 | 1부터 record와 이름 | 07009, 01004, SQL_NO_DATA | T-DESC |
| SQLSetDescRec | B | descriptor WO-7 | 타입·정밀도·버퍼 일관성 확인 | HY016, HY021 | T-DESC |
| SQLEndTran | B | 트랜잭션 WO-8 | DBC/ENV의 COMMIT/ROLLBACK, READ COMMITTED | HY012, 25S01, 서버 진단 | T-TXN |
| SQLCancel | B | 취소 WO-7/8 | N 중단, 다른 스레드의 X 실행 취소, idle 성공 | HY008(실행 측), HY010 | T-CANCEL |
| SQLGetInfo | B/W | 능력 WO-9 | 정보별 실제 값·크기, 아래 보고 계약 | HY096, 01004 | T-INFO |
| SQLGetFunctions | B | 능력 WO-9 | 단일 ID, ALL_FUNCTIONS, ODBC3_ALL_FUNCTIONS | HY095 | T-INFO |
| SQLTables | B/W | 카탈로그 WO-9 | TABLE/VIEW·tablespace=TABLE_SCHEM, wildcard | HY009, HY090 | T-CATALOG |
| SQLColumns | B/W | 카탈로그 WO-9 | 실제 선언·순서·권한 가시성 | HY009, HY090 | T-CATALOG |
| SQLGetTypeInfo | B/W | 타입 WO-9 | SQL_ALL_TYPES와 실제 타입별 결과 | HY004 | T-TYPE |
| SQLStatistics | B/W | 카탈로그 WO-9 | PK 유일·일반 인덱스·컬럼 순서 ASC/DESC | HY100, HY101 | T-CATALOG |
| SQLSpecialColumns | B/W | 카탈로그 WO-9 | SQL_BEST_ROWID=PK, SQL_ROWVER=빈 결과 | HY097, HY098 | T-CATALOG |
| SQLPrimaryKeys | B/W | 카탈로그 WO-9 | 복합 PK 순서 | HY009, HY090 | T-CATALOG |
| SQLForeignKeys | B/W | 카탈로그 WO-9 | 같은 tablespace FK·참조 동작 | HY009, HY090 | T-CATALOG |
| SQLTablePrivileges | B/W | 카탈로그 WO-9 | 가시적인 실제 권한 기록, GRANT OPTION 없음 | HY009, HY090 | T-CATALOG |
| SQLColumnPrivileges | B/W | 카탈로그 WO-9 | 컬럼 단위 권한 미지원, 정의된 빈 결과 | HY009, HY090 | T-CATALOG |
| SQLProcedures | B/W | 카탈로그 WO-9 | 저장 프로시저 미지원, 정의된 빈 결과 | HY090 | T-CATALOG |
| SQLProcedureColumns | B/W | 카탈로그 WO-9 | 위와 동일 | HY090 | T-CATALOG |
| SQLDrivers | DM | Manager WO-12/13 | 드라이버에 export 안 함, Manager가 열거 | Manager 진단 | T-INSTALL |
| SQLDataSources | DM | Manager WO-12/13 | 드라이버에 export 안 함, Manager가 DSN 열거 | Manager 진단 | T-INSTALL |

SQLCancelHandle·SQLCompleteAsync·SQLBrowseConnect·SQLBulkOperations·SQLSetPos는 초기 드라이버 export/지원 광고에서 제외한다. 출력 파라미터·bookmark·scroll/갱신 커서도 제외한다. ODBC 2.x의 SQLAllocEnv/SQLAllocConnect/SQLAllocStmt/SQLTransact/이전 Option/ColAttributes/SQLError는 Manager 매핑 경로만 검증하고 자체 레거시 export를 추가하지 않는다. ConfigDSN/W·ConfigDriver는 별도 Setup DLL의 WO-12 항목이다.

## ODBC 3.8 협상과 능력 보고

[3.8 지침](https://learn.microsoft.com/en-us/sql/odbc/reference/develop-driver/upgrading-a-3-5-driver-to-a-3-8-driver?view=sql-server-ver17)에 따라 버전·C 타입 검증·reset을 독립 시험한다.

- ENV에서 SQL_OV_ODBC2, SQL_OV_ODBC3, SQL_OV_ODBC3_80을 받아들이고 나머지는 HY024이다. ODBC 2 모드는 Manager 변환 범위를 시험하며 별도 2.x native 구현을 뜻하지 않는다. DBC 생성 뒤 버전 변경은 HY010이다.
- 최종 드라이버의 SQL_DRIVER_ODBC_VER는 `03.80`이다. WO-8의 reset과 WO-13 적합성이 끝나기 전에는 3.8 완성을 선언하지 않는다. ODBCVER 매크로는 원형 선택일 뿐이다.
- 모든 바인딩·GetData·descriptor 설정에서 C 타입을 검사한다. SDK의 유효한 타입 중 미지원 변환은 HYC00/07006, 정의되지 않은 C 타입은 HY003이다. 임의 정수를 C 타입으로 받아 버퍼를 쓰지 않는다. 제품 고유 C 타입은 없다.
- SQL_ASYNC_MODE=SQL_AM_NONE, SQL_ASYNC_DBC_FUNCTIONS=SQL_ASYNC_DBC_NOT_CAPABLE. 비동기 활성화는 HYC00, OFF는 수용한다. SQL_GD_OUTPUT_PARAMS·비동기 notification·driver-aware pooling을 광고하지 않는다.
- 최종 SQL_ODBC_INTERFACE_CONFORMANCE=SQL_OIC_CORE는 Core 호출 형태 시험 전체 통과 후에만 제공한다. SQL_GETDATA_EXTENSIONS=0을 출발점으로 한다. 여러 행 fetch는 지원하되 SQLGetData는 rowset size 1만 지원한다.
- SQL_TXN_CAPABLE=SQL_TC_DDL_COMMIT, SQL_DEFAULT_TXN_ISOLATION/SQL_TXN_ISOLATION_OPTION=SQL_TXN_READ_COMMITTED. CURSOR_COMMIT_BEHAVIOR/CURSOR_ROLLBACK_BEHAVIOR=SQL_CB_PRESERVE. SQL_MAX_CONCURRENT_ACTIVITIES=16은 서버 커서 한도이며 일반 요청 병렬 실행을 뜻하지 않는다.
- 카탈로그는 없음(SQL_CATALOG_NAME=`N`, CATALOG_USAGE=0), 테이블스페이스는 TABLE_SCHEM에 대응한다. `tablespace.object` 이름과 schema 지원 비트를 실제 결과에 맞춘다. CURRENT_CATALOG로 USE를 실행하지 않는다.
- SQL_IDENTIFIER_QUOTE_CHAR는 큰따옴표, 식별자 최대 128, 문자열의 ColumnSize/옥텟 길이는 [타입 계약](type-mapping.md)을 따른다. SQLGetFunctions의 true 비트와 실제 callable export·시험을 T-INFO에서 대조한다.

## ENV·DBC 속성 표

모르는 속성은 HY092, 잘못된 값은 HY024, 선택 기능은 HYC00을 기준으로 하되 공식 함수별 진단을 따른다. 읽기 전용 속성의 set도 성공으로 무시하지 않는다. [ENV](https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/sqlsetenvattr-function?view=sql-server-ver17), [DBC](https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/sqlsetconnectattr-function?view=sql-server-ver17).

| 속성 | 기본·get/set 계약 | 단계·시험 ID |
|---|---|---|
| SQL_ATTR_ODBC_VERSION | DBC 전 2/3/3.8 협상, 명시 설정 필수 | WO-4 T-VERSION |
| SQL_ATTR_OUTPUT_NTS | SQL_TRUE; FALSE 미지원 | WO-4 T-VERSION |
| SQL_ATTR_CONNECTION_POOLING / SQL_ATTR_CP_MATCH | Manager 담당, 풀 재사용은 별도 시험 | WO-8 T-RESET |
| SQL_ATTR_AUTOCOMMIT | SQL_AUTOCOMMIT_ON; OFF 지원, OFF→ON의 commit 실패 보존 | WO-8 T-TXN |
| SQL_ATTR_TXN_ISOLATION | SQL_TXN_READ_COMMITTED; 다른 격리 수준 미지원 | WO-8 T-TXN |
| SQL_ATTR_LOGIN_TIMEOUT | 0초(드라이버 제한 없음), 서버 인증 10초와 별개; ms 변환 오버플로 확인 | WO-4 T-CONNECT |
| SQL_ATTR_CONNECTION_TIMEOUT | 0초; 요청의 송신 대기·송신·응답 대기 제한, 만료 시 동기화 또는 dead | WO-8 T-TIMEOUT |
| SQL_ATTR_CONNECTION_DEAD | get 전용 TRUE/FALSE; 통신 실패 후 TRUE | WO-8 T-TIMEOUT |
| SQL_ATTR_RESET_CONNECTION | Manager 전용, SQL_RESET_CONNECTION_YES만; 재인증으로 전 상태 초기화 | WO-8 T-RESET |
| SQL_ATTR_CURRENT_CATALOG | 없음; get 빈 문자열, 비어 있지 않은 set HYC00 | WO-4 T-CONNECT |
| SQL_ATTR_ACCESS_MODE | SQL_MODE_READ_WRITE; READ_ONLY는 강제 기능 미지원, 01S02와 실제 값 유지 | WO-4 T-ATTR |
| SQL_ATTR_METADATA_ID | SQL_FALSE; TRUE이면 카탈로그 인자를 패턴 대신 식별자로 처리 | WO-9 T-CATALOG |
| SQL_ATTR_AUTO_IPD | get 전용 SQL_TRUE 목표, prepare/describe로 채움 | WO-6/7 T-DESC |
| SQL_ATTR_ASYNC_DBC_FUNCTIONS_ENABLE | SQL_ASYNC_DBC_ENABLE_OFF만 | WO-8 T-VERSION |
| SQL_ATTR_PACKET_SIZE | 전송 기본 크기, 비default 요청은 미지원/01S02 정책 검증 | WO-4 T-ATTR |
| SQL_ATTR_ODBC_CURSORS | Manager 담당; SQL_CUR_USE_DRIVER 경로 | WO-4 T-ATTR |
| SQL_ATTR_TRACE / SQL_ATTR_TRACEFILE | Manager 담당, 제품 자체 비밀 로그와 구분 | WO-12 T-INSTALL |
| SQL_ATTR_TRANSLATE_LIB / SQL_ATTR_TRANSLATE_OPTION | 변환 라이브러리 미지원 | WO-4 T-ATTR |
| SQL_ATTR_QUIET_MODE | HWND 보관, UI는 WO-12 | WO-12 T-INSTALL |
| SQL_ATTR_ENLIST_IN_DTC | 분산 트랜잭션 미지원 | WO-8 T-TXN |

## STMT 속성 표

SQLSetStmtAttr와 descriptor가 동일 상태를 공유한다. 가변 주소는 앱 소유로 두고 해제하지 않는다. 수치 값은 SQLULEN 등 [SDK 정의](https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/sqlsetstmtattr-function?view=sql-server-ver17)에 맞춘다.

| 속성 | 기본·get/set 계약 | 단계·시험 ID |
|---|---|---|
| SQL_ATTR_APP_ROW_DESC / SQL_ATTR_APP_PARAM_DESC | 자동 ARD/APD; 같은 DBC 명시 DESC로 교체 가능 | WO-7 T-DESC |
| SQL_ATTR_IMP_ROW_DESC / SQL_ATTR_IMP_PARAM_DESC | get 전용 자동 IRD/IPD | WO-7 T-DESC |
| SQL_ATTR_ROW_ARRAY_SIZE | 1 이상; ARD ARRAY_SIZE | WO-7 T-ROWSET |
| SQL_ATTR_ROW_BIND_TYPE / SQL_ATTR_ROW_BIND_OFFSET_PTR | COLUMN 기본, row-wise·offset 지원 | WO-7 T-ROWSET |
| SQL_ATTR_ROW_STATUS_PTR / SQL_ATTR_ROWS_FETCHED_PTR | NULL 기본, IRD 상태·처리 수 | WO-7 T-ROWSET |
| SQL_ATTR_ROW_OPERATION_PTR | NULL 기본, ARD 주소 보관; fetch 결과와 별개 | WO-7 T-ROWSET |
| SQL_ATTR_PARAMSET_SIZE | 1 이상, APD ARRAY_SIZE | WO-7 T-PARAM |
| SQL_ATTR_PARAM_BIND_TYPE / SQL_ATTR_PARAM_BIND_OFFSET_PTR | COLUMN 기본, row-wise·offset 지원 | WO-7 T-PARAM |
| SQL_ATTR_PARAM_STATUS_PTR / SQL_ATTR_PARAMS_PROCESSED_PTR | NULL 기본, IPD 주소, 일부 성공·미처리 보고 | WO-7 T-PARAM |
| SQL_ATTR_PARAM_OPERATION_PTR | NULL 기본, APD의 PROCEED/IGNORE 입력 | WO-7 T-PARAM |
| SQL_ATTR_QUERY_TIMEOUT | 0초; 0보다 큰 실행 시간 제한은 cancel로 중단 | WO-8 T-TIMEOUT |
| SQL_ATTR_CURSOR_TYPE | SQL_CURSOR_FORWARD_ONLY만; 대체 시 01S02 | WO-5 T-ATTR |
| SQL_ATTR_CONCURRENCY | SQL_CONCUR_READ_ONLY만; 대체 시 01S02 | WO-5 T-ATTR |
| SQL_ATTR_CURSOR_SCROLLABLE / SQL_ATTR_CURSOR_SENSITIVITY | NONSCROLLABLE/INSENSITIVE; 실행 시점 결과 보관 | WO-5 T-ATTR |
| SQL_ATTR_USE_BOOKMARKS / SQL_ATTR_FETCH_BOOKMARK_PTR | OFF/NULL만, bookmark 미지원 | WO-5 T-ATTR |
| SQL_ATTR_MAX_ROWS | 0 무제한; 0보다 큰 값은 반환 행 상한 뒤 커서 닫기 | WO-5 T-EXEC |
| SQL_ATTR_MAX_LENGTH | 0; 저장 데이터 무손실, 비default 대체 시 01S02 | WO-5 T-ATTR |
| SQL_ATTR_RETRIEVE_DATA | SQL_RD_ON; OFF면 fetch 위치·상태만 갱신 | WO-7 T-ROWSET |
| SQL_ATTR_ROW_NUMBER | get 전용; 현재 행 없으면 0 | WO-5 T-CURSOR |
| SQL_ATTR_NOSCAN | SQL_NOSCAN_OFF; 지원 SQL escape는 변환, ON은 원문 경로 | WO-6 T-ESCAPE |
| SQL_ATTR_ENABLE_AUTO_IPD | SQL_FALSE 기본; TRUE로 자동 IPD 요청 지원 | WO-6/7 T-DESC |
| SQL_ATTR_ASYNC_ENABLE / SQL_ATTR_ASYNC_STMT_EVENT | OFF/NULL만, 비동기 미지원 | WO-8 T-VERSION |
| SQL_ATTR_KEYSET_SIZE / SQL_ATTR_SIMULATE_CURSOR | 전진 커서에 의미 없음, 기본 get·미지원 set 진단 | WO-5 T-ATTR |

## Descriptor 필드 표

`A`=ARD/APD, `I`=IRD, `P`=IPD, `-`=해당 없음. 기본 역할별 접근은 [공식 필드](https://learn.microsoft.com/en-us/sql/odbc/reference/develop-app/descriptor-fields?view=sql-server-ver17)와 [설정 규칙](https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/sqlsetdescfield-function?view=sql-server-ver17)을 따른다. **IRD 전체를 불변이라고 처리하지 않는다.** 상태·처리 수 포인터는 IRD/IPD에서도 설정한다. 아래는 WO-7/T-DESC 계약이며 타입 값·수명은 SDK에 따른다.

| 필드 | A | I | P | 시험 ID |
|---|---|---|---|---|
| SQL_DESC_ALLOC_TYPE | R | R | R | T-DESC |
| SQL_DESC_ARRAY_SIZE | RW | - | - | T-DESC |
| SQL_DESC_ARRAY_STATUS_PTR | RW | RW | RW | T-DESC |
| SQL_DESC_BIND_OFFSET_PTR | RW | - | - | T-DESC |
| SQL_DESC_BIND_TYPE | RW | - | - | T-DESC |
| SQL_DESC_COUNT | RW | R | RW | T-DESC |
| SQL_DESC_ROWS_PROCESSED_PTR | - | RW | RW | T-DESC |
| SQL_DESC_TYPE / SQL_DESC_CONCISE_TYPE | RW | R | RW | T-DESC |
| SQL_DESC_DATETIME_INTERVAL_CODE / SQL_DESC_DATETIME_INTERVAL_PRECISION | RW | R | RW | T-DESC |
| SQL_DESC_LENGTH / SQL_DESC_OCTET_LENGTH | RW | R | RW | T-DESC |
| SQL_DESC_PRECISION / SQL_DESC_SCALE / SQL_DESC_NUM_PREC_RADIX | RW | R | RW | T-DESC |
| SQL_DESC_DATA_PTR | RW | - | 일관성 검사 | T-DESC |
| SQL_DESC_INDICATOR_PTR / SQL_DESC_OCTET_LENGTH_PTR | RW | - | - | T-DESC |
| SQL_DESC_PARAMETER_TYPE | - | - | RW(INPUT) | T-DESC |
| SQL_DESC_NAME / SQL_DESC_UNNAMED | - | R | RW | T-DESC |
| SQL_DESC_NULLABLE / SQL_DESC_UNSIGNED | - | R | R | T-DESC |
| SQL_DESC_TYPE_NAME / SQL_DESC_LOCAL_TYPE_NAME | - | R | R | T-DESC |
| SQL_DESC_CASE_SENSITIVE / SQL_DESC_FIXED_PREC_SCALE / SQL_DESC_ROWVER | - | R | R | T-DESC |
| SQL_DESC_AUTO_UNIQUE_VALUE / SQL_DESC_DISPLAY_SIZE / SQL_DESC_LABEL | - | R | - | T-DESC |
| SQL_DESC_BASE_COLUMN_NAME / SQL_DESC_BASE_TABLE_NAME | - | R | - | T-DESC |
| SQL_DESC_CATALOG_NAME / SQL_DESC_SCHEMA_NAME / SQL_DESC_TABLE_NAME | - | R | - | T-DESC |
| SQL_DESC_LITERAL_PREFIX / SQL_DESC_LITERAL_SUFFIX | - | R | - | T-DESC |
| SQL_DESC_SEARCHABLE / SQL_DESC_UPDATABLE | - | R | - | T-DESC |
| SQL_DESC_MINIMUM_SCALE / SQL_DESC_MAXIMUM_SCALE | - | 타입 정보 | 타입 정보 | T-TYPE |

IPD DATA_PTR set은 바인딩 소유권 이전이 아니라 일관성 검사이며 값을 보존해 돌려줄 의무와 구분한다. 읽기 전용 변경 HY016, 정의되지 않은 필드 HY091, 불일치 HY021, 무효 record 07009를 적용한다. 전진 커서의 record 0 bookmark는 지원하지 않는다. 타입 정보 전용 MINIMUM/MAXIMUM_SCALE을 일반 writable descriptor로 취급하지 않는다. base origin을 서버에서 알 수 없으면 빈 문자열을 사용하며 질의 식의 출처를 꾸며 만들지 않는다.

## 문자열·길이 단위

[Unicode 인자 규약](https://learn.microsoft.com/en-us/sql/odbc/reference/develop-app/unicode-function-arguments?view=sql-server-ver17)과 설치된 SDK의 함수 원형을 대조했다. NTS/음수/0/정확한 크기/홀수 바이트/한글/emoji/짝 없는 surrogate/명시 길이 NUL/canary를 T-TEXT로 검사한다. 출력 필요 길이는 함수 규정에 따라 종료 NUL을 제외한다.

| 함수/인자 | W 단위 | ANSI 단위 | 시험 ID |
|---|---|---|---|
| SQLConnect, DriverConnect, ExecDirect, Prepare, NativeSql의 텍스트·길이 | UTF-16 코드 단위 | ACP 바이트 | T-TEXT |
| SQLDescribeCol, Get/SetCursorName, GetDiagRec, GetDescRec의 이름/메시지 길이 | UTF-16 코드 단위 | ACP 바이트 | T-TEXT |
| SQLTables/Columns/PK/FK/Statistics/SpecialColumns/Privileges/Procedures 입력 이름 길이 | UTF-16 코드 단위 | ACP 바이트 | T-TEXT |
| SQLGetInfo, SQLColAttribute의 BufferLength/문자열 필요 길이 | 바이트 | 바이트 | T-TEXT |
| SQLGet/SetConnectAttr, StmtAttr의 문자열 BufferLength/StringLength | 바이트, 필드/속성별 판정 | 바이트 | T-TEXT |
| SQLGet/SetDescField, SQLGetDiagField의 문자열 길이 | 바이트, 필드별 판정 | 바이트 | T-TEXT |
| SQLGetData/SQLBindCol/SQLBindParameter/SQLPutData의 문자 데이터 버퍼·indicator | SQL_C_WCHAR도 바이트, SQL_NTS는 별도 | SQL_C_CHAR 바이트 | T-GETDATA |
| SQLGetDescRec의 LengthPtr, DESC_OCTET_LENGTH | 타입/필드 규약, 이름 길이와 구분 | 동일 | T-DESC |
| ColumnSize/DESC_LENGTH/표시 크기 | SQL 타입의 문자·숫자 규약 | 동일 | T-TYPE |

SQLLEN/SQLULEN/SQLPOINTER를 포인터 크기에 맞추고 `long`으로 주소·길이를 축소하지 않는다. SQLGetData의 고정 C 구조체는 BufferLength를 가변 문자열처럼 해석하지 않는다. 분할 데이터의 indicator는 [SQLGetData 규약](https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/sqlgetdata-function?view=sql-server-ver17)의 남은 데이터 길이·NULL·SQL_NO_TOTAL을 구분한다.

## 상태·진단·동시성

이 약어는 구현용 요약이며 ODBC 공식 S1~S12 번호를 대체하지 않는다. WO-2에서 함수별 전이 시험을 작성한다.

| 상태 | 의미·전이 | 시험 ID |
|---|---|---|
| E0/E1 | ENV 할당/버전 설정, DBC는 E1 뒤 생성 | T-HANDLE |
| D0/D1/Ddead | 미접속/인증 완료/단절; reset·disconnect 중은 다른 실행 금지 | T-CONNECT |
| S0/P | 미준비/준비·분석 완료; 재준비는 옛 prepared ID 정리 | T-PREPARE |
| X | 동기 실행 중, 일반 DBC 요청 직렬화, SQLCancel 별도 진입 | T-CANCEL |
| N | 실행 시 데이터 요청 중, ParamData/PutData/Cancel 허용 | T-DAE |
| R/F/Z | 열린 결과/현재 행/끝, close 뒤 P 또는 S0 | T-CURSOR |

일반 호출 시작 시 그 핸들의 이전 진단을 지운다. GetDiagRec/GetDiagField는 지우지 않는다. SQLCancel과 실행 측 진단은 잠금으로 조정하여 실행 측 HY008/시간 제한 HYT00을 유실하지 않는다. 서버 SQLSTATE/native/message는 [매핑표](server-dependencies.md)의 예외 외에는 보존한다. 진단 문자열은 영문이다. bad_alloc/예외는 C ABI 안에서 HY001/HY000으로 바꾸며 진단 할당 실패에도 예외를 밖으로 던지지 않는다.

핸들 레지스트리로 종류·세대를 확인한 뒤 객체를 참조한다. 실행 중에는 수명 참조를 유지하고 부모/자식 해제와 경합을 시험한다. registry 잠금 안에서 네트워크 대기를 하지 않는다. DBC마다 실행 잠금을 두고 cancel은 이 잠금을 기다리지 않는다. 단일 수신 경로가 request ID별 응답을 전달하며, 모든 DBC를 전역 실행 mutex로 묶지 않는다.
