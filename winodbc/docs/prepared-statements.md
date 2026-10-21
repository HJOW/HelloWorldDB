# 준비 문장·단일 파라미터

SQLPrepare/W는 서버의 `prepareDescribe` capability를 확인하고 `prepare`를 요청한다. 기능이 없으면 HYC00이다. SQL 실행·rollback으로 메타데이터를 추정하지 않는다. 서버의 prepared/description에서 결과와 파라미터 메타데이터를 받아 SQLNumParams·SQLDescribeParam·SQLNumResultCols·SQLDescribeCol/W·SQLColAttribute/W에 사용한다.

SQLNumParams는 준비한 문장의 실제 마커 수이다. 문자열, 큰따옴표 식별자와 줄/블록 주석의 `?`는 세지 않으며 서버 수와도 대조한다. SQLDescribeCol의 미정 타입은 SQL_UNKNOWN_TYPE, 크기 0이다. SQLDescribeParam은 미정이면 HYC00을 반환하며 CAST나 바인딩 타입을 요구한다. 이 구분은 [SQLDescribeCol](https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/sqldescribecol-function)과 [파라미터 설명의 한계](https://learn.microsoft.com/en-us/sql/odbc/reference/develop-app/describing-parameters?view=sql-server-ver17)를 따른다.

SQLBindParameter는 INPUT만 지원한다. APD에는 C 타입·주소·버퍼 크기·indicator, IPD에는 바인딩한 SQL 타입·길이·정밀도를 저장한다. 서버가 설명한 파라미터 메타데이터와 앱의 입력 변환 정의를 구분한다. 실행 전의 메타데이터 요청과 바인딩 변경 후의 SQLExecute는 타입 힌트로 서버 `describe`를 갱신한다. 자동 IPD·필드 API·명시 descriptor 공유는 WO-7이다.

## 버퍼와 전송

값은 SQLExecute마다 앱 주소에서 읽는다. 바인딩 후 값을 복사해 고정하지 않으며 앱 버퍼를 DLL에서 해제하지 않는다. 바인딩은 재준비와 결과 닫기에도 유지하고 SQLFreeStmt(SQL_RESET_PARAMS)로 지운다. SQLPrepare 전의 바인딩과 파라미터가 있는 SQLExecDirect도 지원한다. SQL에 없는 여분의 바인딩은 실행에서 무시하고, 필요한 마커의 누락은 07002이다. 인덱스 0·ODBC 최대 범위 밖 또는 SQLDescribeParam의 실제 범위 밖은 07009이다. [SQLBindParameter](https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/sqlbindparameter-function?view=sql-server-ver17).

CHAR/WCHAR의 명시 길이는 **바이트**, NTS는 종료 NUL까지이다. WCHAR의 홀수 바이트 길이는 HY090이다. 명시 길이는 내장 NUL을 보존한다. BINARY는 indicator가 없으면 BufferLength를 입력 길이로 사용한다. 고정 C 구조체는 SDK 크기로 읽으며 BufferLength를 데이터 길이로 해석하지 않는다. NULL indicator는 데이터 주소를 읽지 않는다. SQL_DEFAULT_PARAM은 07S01, 실행 시 데이터는 WO-7까지 HYC00이다.

입력 정수와 NUMERIC은 부동소수를 거치지 않는다. BIGINT·DECIMAL·날짜시간·INTERVAL은 wire 문자열, 작은 정수/실수/BOOLEAN은 JSON 값, 이진은 `{binary: hex}`, NULL은 null이다. SQL과 params는 별도 필드이며 SQL 문자열에 값을 치환하지 않는다. 문자열/이진 길이 초과는 22001이다. 숫자 C 타입의 정수부 손실은 22003, 소수부 손실은 01S07 경고이다. 문자 입력의 수치 자릿수 손실은 22001, 날짜시간 필드/소수 초 손실은 22008, INTERVAL 필드 손실은 22015이다. 지원하지 않는 변환은 07006/HYC00이다. INTERVAL의 기본 선행 정밀도는 2이고 소수 초는 바인딩한 DecimalDigits를 사용한다. [C→SQL 변환 규약](https://learn.microsoft.com/en-us/sql/odbc/reference/appendixes/converting-data-from-c-to-sql-data-types?view=sql-server-ver17), [문자 입력](https://learn.microsoft.com/en-us/sql/odbc/reference/appendixes/c-to-sql-character?view=sql-server-ver17), [숫자 입력](https://learn.microsoft.com/en-us/sql/odbc/reference/appendixes/c-to-sql-numeric?view=sql-server-ver17), [timestamp 입력](https://learn.microsoft.com/en-us/sql/odbc/reference/appendixes/c-to-sql-timestamp?view=sql-server-ver17).

문자 C 버퍼를 SQL_BINARY/VARBINARY에 넣으면 16진수 쌍으로 변환하고 ODBC 규칙대로 마지막 홀수 문자는 무시한다. timezone 컬럼은 표준 ODBC offset 구조체가 없어 WVARCHAR로 노출/바인딩한다. 이 경우 서버가 추론한 원래 WITH TIME ZONE 선언을 타입 힌트로 유지해 offset을 보존한다.

## 수명과 무효화

결과 닫기는 준비 ID를 보존한다. 재준비와 직접 실행으로 교체할 때 기존 준비 ID를 닫고, STMT 해제는 커서와 준비 ID를 모두 닫는다. 연결 종료는 서버 세션의 준비 자원을 정리하고 모든 자식 핸들을 무효화한다. 서버의 64개 준비 한도와 ODBC의 SQLSMALLINT 개수 범위를 검사한다.

서버의 USE/DDL 무효화는 0A000/native 8009를 그대로 반환한다. GRANT/REVOKE 후 설명·실행은 최신 권한으로 검사한다. 준비 성공을 실행 권한으로 간주하지 않으며 실패한 DML을 자동 재실행하지 않는다. prepare/describe는 자동 커밋 설정과 앞선 미커밋 변경을 바꾸지 않는다.

## ODBC SQL escape

SQLNativeSql/W는 실행 없이 변환한다. W 입력/출력 길이는 UTF-16 코드 단위이다. ExecDirect/Prepare는 SQL_ATTR_NOSCAN=OFF(기본)에서 같은 변환을 적용하며 ON이면 원문을 서버에 보낸다. 따옴표와 주석 내부는 보존한다. [SQLNativeSql 길이](https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/sqlnativesql-function?view=sql-server-ver15).

| escape | 변환 |
|---|---|
| `{d '...'}`, `{t '...'}`, `{ts '...'}` | DATE/TIME/TIMESTAMP 리터럴 |
| `{escape '...'}` | LIKE ESCAPE 절 |
| `{oj ...}` | outer join 본문, 중첩 escape도 변환 |
| `{fn UCASE/LCASE/IFNULL(...)}` | UPPER/LOWER/COALESCE |
| `{fn CONVERT(expr, SQL_타입)}` | 지원 SQL 타입의 CAST |
| `{fn YEAR/MONTH/DAYOFMONTH/HOUR/MINUTE/SECOND(...)}` | EXTRACT |
| `{fn NOW/CURDATE/CURTIME/USER()}` | 현재 시각/날짜/사용자 식 |
| `{fn ...}`의 문자열/수치 함수 | CONCAT, SUBSTRING→SUBSTR, LENGTH, CHAR_LENGTH, OCTET_LENGTH, LTRIM, RTRIM, REPLACE, ABS, CEILING→CEIL, FLOOR, MOD, POWER, ROUND, SQRT, UPPER, LOWER |

CALL·GUID와 나머지 함수/escape는 HYC00이며 잘못된 괄호·종료자·64단계 초과 중첩은 42000이다. 변환을 지원한다고 서버가 지원하지 않는 함수를 광고하지 않는다.

시험은 `sql.odbc_escapes_parameters`, `types.input_parameters`와 실제 Manager의 `prepare_cases.cpp`이다. 준비/설명만 한 INSERT·DDL의 무부작용, 수동 트랜잭션, 실행 전 UNKNOWN/힌트/CAST, 버퍼 변경, 정확한 38자리 소수·이진·NULL·타임스탬프·13개 INTERVAL 왕복, 70회 재준비/해제, 권한 회수·DDL 무효화·ANSI/W·NOSCAN을 검증한다.
