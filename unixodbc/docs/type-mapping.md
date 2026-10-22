# 타입·버퍼 계약

기준은 [서버 데이터 타입 정책](../../rdbms/docs/data-types.md)과 [프로토콜 8·9절](../../rdbms/docs/protocol.md)이다.
서버는 UTF-8 문자열을 보내고, 값의 정밀도를 잃지 않도록 BIGINT·DECIMAL·날짜시간·INTERVAL 을 문자열로 보낸다. 이 문서는 그 값을 ODBC 타입과 C 타입으로 바꾸는 계약이다.

| DB typeName | wire 값 | ODBC SQL 타입 | 기본 C 표현·핵심 시험 | 시험 ID |
|---|---|---|---|---|
| CHAR | 공백을 포함한 문자열 | SQL_WCHAR | SQL_C_WCHAR, 끝 공백 보존 | T-TYPE |
| VARCHAR | 문자열 | SQL_WVARCHAR | SQL_C_WCHAR, 한글·emoji·빈 문자열 | T-TYPE |
| BINARY | 대문자 hex 문자열 | SQL_BINARY | SQL_C_BINARY, 고정 길이 0 채움 | T-TYPE |
| VARBINARY | 대문자 hex 문자열 | SQL_VARBINARY | SQL_C_BINARY, 중간 0·길이 0 | T-TYPE |
| SMALLINT | JSON 정수 | SQL_SMALLINT | SQL_C_SSHORT, ±16비트 경계 | T-TYPE |
| INTEGER | JSON 정수 | SQL_INTEGER | SQL_C_SLONG, ±32비트 경계 | T-TYPE |
| BIGINT | 10진 문자열 | SQL_BIGINT | SQL_C_SBIGINT·SQL_C_CHAR, ±64비트 경계 | T-TYPE |
| DECIMAL | 10진 문자열 | SQL_DECIMAL | 기본 SQL_C_CHAR, 명시 SQL_C_NUMERIC, 38자리·scale | T-TYPE |
| REAL | 유한 JSON 숫자 | SQL_REAL | SQL_C_FLOAT, 단정도 한계 | T-TYPE |
| DOUBLE PRECISION | 유한 JSON 숫자 | SQL_DOUBLE | SQL_C_DOUBLE, NaN·무한대 거부 | T-TYPE |
| BOOLEAN | JSON boolean | SQL_BIT | SQL_C_BIT, 0/1·NULL indicator | T-TYPE |
| DATE | YYYY-MM-DD | SQL_TYPE_DATE | SQL_C_TYPE_DATE / SQL_DATE_STRUCT | T-TYPE |
| TIME | HH:MM:SS[.ffffff] | SQL_TYPE_TIME | SQL_C_TYPE_TIME, 소수 초는 문자 경로로 보존 | T-TYPE |
| TIMESTAMP | 날짜·시각 문자열 | SQL_TYPE_TIMESTAMP | SQL_C_TYPE_TIMESTAMP, fraction=μs×1000 | T-TYPE |
| TIME WITH TIME ZONE | 시각+offset 문자열 | SQL_WVARCHAR | SQL_C_WCHAR, offset·소수 초 보존 | T-TYPE |
| TIMESTAMP WITH TIME ZONE | 날짜·시각+offset 문자열 | SQL_WVARCHAR | SQL_C_WCHAR, offset·소수 초 보존 | T-TYPE |
| INTERVAL | 한정자에 맞는 문자열 | SQL_INTERVAL_* | SQL_C_INTERVAL_* / SQL_INTERVAL_STRUCT | T-TYPE |
| UNKNOWN | 준비 분석의 미정 타입 | SQL_UNKNOWN_TYPE | SQLDescribeParam 은 HYC00, SQLDescribeCol 은 타입·크기 0, 힌트/CAST 뒤 재분석 | T-PREPARE |

- NUMERIC·DEC 는 서버 정규형 DECIMAL 로, NCHAR·NVARCHAR 는 CHAR·VARCHAR 로, FLOAT 는 REAL·DOUBLE PRECISION 으로 맞춘다. 선언 별칭 때문에 저장 인코딩이나 정밀도를 바꾸지 않는다.
- 서버가 모르는 타입을 성공으로 가리지 않는다. 새 타입이 생기면 이 표와 서버 `dataType.ts` 를 함께 고친다.
- INTERVAL 은 `YEAR`, `MONTH`, `YEAR TO MONTH`, `DAY`, `HOUR`, `MINUTE`, `SECOND`, `DAY TO HOUR`, `DAY TO MINUTE`, `DAY TO SECOND`, `HOUR TO MINUTE`, `HOUR TO SECOND`, `MINUTE TO SECOND` 의 13개 `SQL_INTERVAL_*` 와 대응 구조체를 쓴다. 같은 한정자가 아닌 구조체 변환은 `07006` 이다.

## 1. 길이 단위

- DB 의 문자 길이는 **코드 포인트**이다. `SQL_DESC_LENGTH`/`ColumnSize` 는 문자 수이고, 옥텟 길이는 인코딩에 따라 달라진다.
- ANSI 경로의 `SQLCHAR` 는 UTF-8 이다. `SQL_C_CHAR` 의 `BufferLength`·indicator 는 **바이트**이다. 한글 3바이트, 보충 평면 문자 4바이트를 실제 값으로 센다.
- W 경로의 `SQLWCHAR` 는 2바이트 UTF-16 이다. `SQL_C_WCHAR` 의 `BufferLength`·indicator 는 **바이트**이고, 문자열 길이 인자는 SQLWCHAR 개수이다. `A😀한` 은 코드 포인트 3, UTF-16 단위 4, UTF-8 바이트 8 로 서로 다르다.
- CHAR 는 고정 길이다. 수신 시 뒤 공백을 보존하고, 비교·정렬은 서버 규칙을 그대로 따른다.
- VARCHAR·VARBINARY 최대 65,535, CHAR·BINARY 최대 2,000, DECIMAL 최대 38자리. 실제 선언값은 `SQLColumns`/`SQLDescribeCol` 에서 읽는다.

## 2. 수치

- DECIMAL 은 10진 문자열 또는 `SQL_NUMERIC_STRUCT` 로 주고받는다. `double` 로 우회하지 않는다.
  `SQL_NUMERIC_STRUCT.val` 은 16바이트 little-endian 절댓값이고 `sign` 은 1=양수, 0=음수이다.
- `SQLGetData` 의 명시 `SQL_C_NUMERIC` 기본 precision 은 38, scale 은 0 이다. 소수 손실은 `01S07`, 정수부 손실은 `22003`.
- 파라미터의 64비트 정수·DECIMAL 은 JSON 숫자가 아니라 **문자열**로 보낸다. JSON 안전 정수 범위 밖의 값을 숫자로 만들지 않는다.
- REAL·DOUBLE 은 유한값만 받는다. NaN·무한대는 서버에 보내지 않고 `22003`/`HYC00` 로 거부한다.

## 3. 날짜시간

- DATE 는 `0001-01-01` ~ `9999-12-31` 이다. TIME/TIMESTAMP 의 소수 초는 0~6자리다.
- `SQL_TIMESTAMP_STRUCT.fraction` 은 **나노초**이다. 서버 소수 6자리는 μs×1000 이다.
- `SQL_TIME_STRUCT` 에는 fraction 이 없다. 소수 초가 있는 TIME 을 이 구조체로 받으면 `01S07` 을 남기고, 문자 수신은 전 자릿수를 보존한다.
- `WITH TIME ZONE` 은 ODBC 표준 구조체에 오프셋을 숨기지 않고 **문자열**로 노출한다. 원래 typeName 과 선언 정밀도를 유지한다.
- TIME→C TIMESTAMP 의 날짜는 클라이언트 OS 의 현재 날짜로 채우고, TIMESTAMP→C DATE 의 시각 손실은 `01S07` 이다.
- 세션 타임존은 접속 시 `timeZone` 으로 보낸다. 서버가 준 오프셋 문자열을 임의로 UTC 로 바꾸지 않는다.

## 4. C 타입과 오류

- `SQL_C_DEFAULT` 는 실제 SQL 타입으로 결정한다.
- 지원 C 타입: `SQL_C_CHAR`, `SQL_C_WCHAR`, `SQL_C_BINARY`, `SQL_C_BIT`, 부호 있는·없는 정수(`SQL_C_STINYINT`/`SQL_C_UTINYINT`/`SQL_C_SSHORT`/`SQL_C_USHORT`/`SQL_C_SLONG`/`SQL_C_ULONG`/`SQL_C_SBIGINT`/`SQL_C_UBIGINT`), `SQL_C_FLOAT`, `SQL_C_DOUBLE`, `SQL_C_NUMERIC`, `SQL_C_TYPE_DATE`/`TIME`/`TIMESTAMP`, 13개 INTERVAL 구조체.
- 정의되지 않은 C 타입 `HY003`, 정의되지 않은 SQL 타입 `HY004`, 알려졌지만 미지원인 변환 `HYC00`/`07006`.
- 수치 정수부 범위 초과 `22003`, 변환 문법 `22018`, 날짜 문법·범위 `22007`/`22008`, NULL indicator 누락 `22002`, 가변 출력 잘림 `01004`.
- 앱 버퍼 부족을 이유로 DB 에 잘린 값을 입력하지 않는다. 입력 길이 초과는 `22001` 이다.
- 출력 파라미터·bookmark·제품 고유 C 타입은 초기 제외이다.

## 5. 왕복 시험 기준

- T-TYPE 은 타입별 최소·최대·한 칸 초과, NULL·빈 값, 고정 길이 공백, 38자리 DECIMAL, 소수 초 0~6, timezone offset, 13개 INTERVAL 을 실제 서버와 왕복한다.
- T-TEXT 는 UTF-8·UTF-16 경계(1·2·3·4바이트, 서러게이트 쌍, 잘못된 시퀀스)를 본다.
- T-GETDATA/T-ROWSET/T-PARAM 은 canary, indicator, 부분 수신, 행·파라미터 배열 offset, 주소 계산 오버플로를 함께 검사한다.
- 32비트 빌드는 UO-13 에서 선택적으로 확인한다.
