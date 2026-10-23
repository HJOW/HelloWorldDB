# 카탈로그·기능 보고

WO-9의 구현 규칙이다. [API 계약](api-support.md), [타입 계약](type-mapping.md), [서버 의존성](server-dependencies.md)과 Microsoft ODBC 함수별 문서를 따른다.

## 카탈로그 원천과 결과 조합

- SYSTEM 스키마의 딕셔너리 뷰를 SQL로 조회한 뒤 드라이버에서 ODBC 결과로 조합한다. 사용자 테이블 데이터를 직접 읽지 않으며 서버의 권한 필터를 그대로 사용한다.
  - SQLTables: `SYSTEM.SYS_TABLES`와 `SYSTEM.SYS_VIEWS`를 각각 조회해 TABLE/VIEW로 합친다.
  - SQLColumns: `SYSTEM.SYS_COLUMNS` 한 번으로 테이블과 뷰 컬럼을 모두 얻는다. 서버가 이미 뷰 컬럼을 실행 없이 제공한다.
  - SQLStatistics: `SYSTEM.SYS_INDEXES`와 `SYSTEM.SYS_INDEX_COLUMNS`를 조합한다. PK 유일 인덱스는 SYS_INDEXES에 포함되어 있다.
  - SQLPrimaryKeys/ForeignKeys: `SYSTEM.SYS_CONSTRAINTS`와 `SYSTEM.SYS_CONSTRAINT_COLUMNS`를 조합한다. FK는 같은 테이블스페이스만 참조할 수 있다.
  - SQLSpecialColumns: `SQL_BEST_ROWID`는 PK 컬럼을 `SQL_SCOPE_SESSION` 범위로 낸다. 요청한 범위는 "최소 범위"이고 돌려주는 범위는 더 넓어도 되므로 `CURROW`·`TRANSACTION`·`SESSION` 어느 요청에도 같은 PK를 낸다. `SQL_ROWVER`는 행 버전 컬럼이 없으므로 정의된 빈 결과이다.
  - SQLTablePrivileges: `SYSTEM.SYS_PRIVILEGES`의 객체 수준 행만 테이블 권한으로 낸다. 테이블스페이스 수준 행은 펼치지 않는다.
  - SQLColumnPrivileges/Procedures/ProcedureColumns: 정의된 빈 결과를 낸다. 컬럼 권한과 저장 프로시저 미지원을 성공 스텁으로 가리지 않는다.
- 서버 커서를 쓰지 않는 로컬 결과이다. `fetchSize`, `maxRows`, `SQL_ATTR_RETRIEVE_DATA`는 일반 fetch와 같은 규칙으로 적용되며 `SQLMoreResults`는 현재 결과를 닫고 `SQL_NO_DATA`를 낸다.
- 한 요청 한 문장 규칙을 유지한다. 카탈로그 호출 전에 열린 커서가 있으면 `24000`으로 거부하며 앱이 먼저 닫아야 한다.

## 스키마·카탈로그·특별 호출

- 테이블스페이스는 `TABLE_SCHEM`이며 카탈로그는 없다. `TABLE_CAT`은 항상 NULL이다.
  - `SQL_CATALOG_NAME=N`, `SQL_CATALOG_USAGE=0`, `SQL_QUALIFIER_LOCATION=0`이다. `SQL_CURRENT_CATALOG`의 빈 문자열 조회는 성공하며 비어 있지 않은 설정은 `HYC00`이다.
  - `SQL_SCHEMA_TERM=tablespace`, `SQL_OWNER_TERM=tablespace`, `SQL_TABLE_TERM=table`이다.
  - 카탈로그 인자가 비어 있지 않고 `%`가 아니면 빈 결과를 낸다. 테이블스페이스가 없는 서버에는 ODBC로 접속할 수 없다는 뜻이 아니라 카탈로그 필터의 결과이다.
- 특별 호출은 다른 인자가 비어 있을 때만 인정한다.
  - `Catalog="%"+나머지 비움` → 단일 `TABLE_CAT` 컬럼의 빈 결과.
  - `Schema="%"+나머지 비움` → 단일 `TABLE_SCHEM` 컬럼에 가용한 테이블스페이스 목록.
  - `TableType="%"+나머지 비움` → 단일 `TABLE_TYPE` 컬럼에 `TABLE`, `VIEW`.
- `NULL` 포인터와 빈 문자열은 모두 필터 없음으로 본다. Manager가 `NULL`을 거부하는 호출에서는 빈 문자열을 넘긴다. `%`는 전체이며 `_`는 한 글자이다. 이스케이프는 `\`이다.

## 패턴과 식별자

- `SQL_ATTR_METADATA_ID=FALSE`(기본)에서 **패턴 값 인자**(SQLTables의 스키마·테이블, SQLColumns의 스키마·테이블·컬럼, SQLTablePrivileges의 스키마·테이블)는 `%`, `_`, 이스케이프를 ODBC 규칙으로 비교한다.
- **일반 인자**(SQLStatistics, SQLSpecialColumns, SQLPrimaryKeys, SQLForeignKeys의 스키마·테이블)는 패턴이 아니다. `FALSE`에서는 `%`, `_`도 문자 그대로이고 대소문자까지 정확히 같아야 한다.
  `ORDER_ITEMS`를 물으면 `ORDERXITEMS`의 키가 섞여 나오지 않는다. 이 인자도 NULL과 빈 문자열은 필터 없음이다.
- `SQL_ATTR_METADATA_ID=TRUE`는 식별자이다. `%`도 문자 그대로 비교하므로 `%` 패턴은 빈 결과가 된다. STMT와 DBC 중 하나라도 `TRUE`이면 식별자로 본다.
  식별자 인자는 뒤쪽 공백을 무시하고, 큰따옴표로 감싼 이름(`"Q9 Mixed$Name"`, 안의 `""`는 `"`)은 안쪽을 그대로 비교하며, 따옴표 없는 이름은 서버의 식별자 규칙처럼 대문자로 접어 비교한다.
  접기는 ASCII 영문자만 대상으로 한다. ASCII 밖 문자의 대소문자 접기는 서버와 같다고 보장하지 않으므로 그런 이름은 큰따옴표로 감싸 전달한다.
- `TableType`은 쉼표 목록이다. `TABLE`, `VIEW`만 허용하며 작은따옴표와 공백을 벗겨 대문자로 비교한다. `NULL`/빈/`%`는 둘 다 허용이다.
- 정렬은 Microsoft 규약을 따른다. Tables는 종류·스키마·이름, Columns는 스키마·테이블·순서, Statistics는 스키마·테이블·인덱스·순서, PK/FK는 스키마·테이블·순서이다.

## 타입·길이·NULL 규칙

- `DATA_TYPE` 문자열(`VARCHAR(20)`, `DECIMAL(10,2)`, `TIMESTAMP(6) WITH TIME ZONE` 등)을 해석해 ODBC 타입을 정한다. 서버 정규형(`NUMERIC`→`DECIMAL`, `NCHAR`→`CHAR` 등)을 따른다.
- timezone 타입은 `SQL_WVARCHAR`로 노출하며 오프셋을 구조체에 숨기지 않는다. `INTERVAL`은 13개 한정자에 맞는 `SQL_INTERVAL_*`이다.
- `COLUMN_SIZE`는 문자 수·정밀도, `BUFFER_LENGTH`는 전송 최대 바이트, `DECIMAL_DIGITS`·`NUM_PREC_RADIX`는 타입에 따라 값 또는 NULL이다. `CHAR_OCTET_LENGTH`는 문자·이진만 값이다.
- 서버는 시간 타입을 항상 `TIMESTAMP(p)`, `TIME(p)`처럼 자릿수와 함께 적는다. `TIMESTAMP(0)`은 명시한 0자리이며(`COLUMN_SIZE` 19, `DECIMAL_DIGITS` 0) 생략 기본값 6(26, 6)으로 보지 않는다. 자릿수가 아예 없는 선언 문자열일 때만 6으로 본다.
  이 값은 같은 컬럼을 실행 결과에서 `SQLDescribeCol`로 물을 때의 타입·자릿수와 같아야 한다.
- 고정 길이 뒤 공백과 빈 문자열·빈 이진·NULL을 구분한다. 저장 길이 초과와 수신 버퍼 부족(`01004`)을 혼동하지 않는다.
- `IS_NULLABLE`은 딕셔너리의 `YES`/`NO`/`UNKNOWN`을 그대로 쓰며 실행 결과의 추측으로 덮지 않는다.

## 기능·정보 보고

- `SQLGetFunctions`는 실제 export와 같은 단일 정의에서 만든다. 단일 ID·`SQL_API_ALL_FUNCTIONS`·`SQL_API_ODBC3_ALL_FUNCTIONS` 비트맵을 각각 시험한다. `SQLBulkOperations` 등은 `SQL_FALSE`이다.
- `SQLGetInfo`는 실제 구현 값만 낸다. 미지원 정보형은 `HY096`이며 성공 스텁을 쓰지 않는다.
  - 비동기는 지원하지 않는다: `SQL_ASYNC_MODE=SQL_AM_NONE`, `SQL_ASYNC_DBC_FUNCTIONS=SQL_ASYNC_DBC_NOT_CAPABLE`, `SQL_ASYNC_NOTIFICATION=SQL_ASYNC_NOTIFICATION_NOT_CAPABLE`.
  - `SQL_DRIVER_ODBC_VER=03.00`을 유지한다. `03.80`은 WO-8.7과 WO-13 적합성이 끝난 뒤에 선언한다.
  - `SQL_ODBC_INTERFACE_CONFORMANCE=SQL_OIC_CORE`는 WO-9 카탈로그 완료 뒤의 값이며 최종 적합성 감사는 WO-13이다.
  - 스키마·카탈로그·트랜잭션·커서·배열·최대 길이·비동기 미지원 값은 [지원 계약](api-support.md)의 ENV/DBC/STMT 속성표와 일치한다.
  - Manager 담당 `SQL_DM_VER`/`SQL_ODBC_VER`와 드라이버 `SQL_DRIVER_ODBC_VER`/`SQL_DRIVER_VER`를 혼동하지 않는다.
- 속성 감사는 WO-9.7이다. 모르는 속성은 `HY092`, 잘못된 값은 `HY024`, 선택 기능은 `HYC00`, 대체값은 `01S02`이다. 읽기 전용을 성공으로 무시하지 않는다.

## 검증 경로

- `tests/unit/catalog_test.cpp`는 패턴·선언 해석·타입 정보(`TIMESTAMP(0)` 등 소수 초 자릿수 포함)·식별자 비교와 일반 인자 비교를 네트워크 없이 검사한다.
- `tests/driver_manager/catalog_cases.cpp`는 실제 Manager와 서버로 테이블·컬럼·통계·특수컬럼·PK/FK·권한·프로시저·타입정보·정보/함수·MoreResults를 검사한다.
  - 형태: 복합 PK의 제약조건 순서 KEY_SEQ, 복합 FK의 열 짝(PK 쪽·FK 쪽 어느 테이블로 물어도 같은 행), `DESC` 인덱스의 컬럼별 ASC/DESC, 따옴표 식별자(공백·`$`·예약어)와 식별자 모드(`"…"`·대문자 접기), 타입 인자 생략/명시(`CHAR`, `VARCHAR`, `DECIMAL` 세 형태, `NUMERIC`, `TIMESTAMP` 생략·`(0)`·`(3) WITH TIME ZONE`, `TIME`)와 `SQLDescribeCol` 대조, `SQL_BEST_ROWID`의 세 범위, 일반 인자의 `_` 비패턴 비교.
  - 가시성: 권한이 없고 기본 테이블스페이스도 없는 사용자, 뷰 권한만 있는 사용자, 테이블스페이스 수준 SELECT 사용자가 각각 보는 테이블·컬럼·키·인덱스·권한·스키마 목록과, 보이는 것과 실제 실행 가능 범위(보이면 읽히고 안 보이면 `42501`)의 일치.
- `tests/integration/reset_probe.cpp`는 직접 DLL에서 `SQLGetFunctions`의 true 보고와 실제 export(ANSI·W)를 양방향으로 대조하고, 단일 ID·`SQL_API_ALL_FUNCTIONS`·`SQL_API_ODBC3_ALL_FUNCTIONS` 세 형태가 일치하는지, 범위에서 제외한 함수가 보고·export 모두에 없는지, `SQL_ASYNC_MODE`·`SQL_ASYNC_DBC_FUNCTIONS`·`SQL_ASYNC_NOTIFICATION`이 비동기 미지원으로 보고되는지 확인한다.
  이 대조는 보고와 export의 정합성을 보장한다. true인 각 함수의 호출 동작은 단위·Manager·통합 시험이 각각 호출하며 새 함수를 true로 보고하려면 이 대조 표도 함께 고쳐야 한다.
- Manager가 값 범위를 먼저 검사하는 항목(`SQLStatistics` 예약값 `HY101`, `NULL` 인자 `HY009` 등)은 드라이버의 `HY024`/`HY009`와 구분해 기록한다. 빈 문자열과 `NULL`의 취급, 카탈로그 없음의 빈 결과, 권한 없는 객체의 가시성은 서버 필터를 기준으로 한다.
