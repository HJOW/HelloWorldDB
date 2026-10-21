# 타입·버퍼 계약

WO-0의 구현 목표이며 현재 변환 코드는 없다. 기준은 [서버 타입 정책](../../rdbms/docs/data-types.md), [프로토콜 8·9·17절](../../rdbms/docs/protocol.md)이다. T-TYPE은 단순 값 비교뿐 아니라 SQLGetTypeInfo·SQLColumns·SQLDescribeCol·IRD·실제 바인딩의 일치를 검사한다.

| DB typeName | wire 값 | ODBC SQL 타입 | 기본 C 표현·핵심 시험 | 시험 ID |
|---|---|---|---|---|
| CHAR | 공백을 포함한 문자열 | SQL_WCHAR | SQL_C_WCHAR, 끝 공백 보존 | T-TYPE |
| VARCHAR | 문자열 | SQL_WVARCHAR | SQL_C_WCHAR, 한글/emoji·빈 문자열 | T-TYPE |
| BINARY | 대문자 hex 문자열 | SQL_BINARY | SQL_C_BINARY, 고정 길이 0 채움 | T-TYPE |
| VARBINARY | 대문자 hex 문자열 | SQL_VARBINARY | SQL_C_BINARY, 중간 0·길이 0 | T-TYPE |
| SMALLINT | JSON 정수 | SQL_SMALLINT | SQL_C_SSHORT, ±16비트 경계 | T-TYPE |
| INTEGER | JSON 정수 | SQL_INTEGER | SQL_C_SLONG, ±32비트 경계 | T-TYPE |
| BIGINT | 10진 문자열 | SQL_BIGINT | SQL_C_SBIGINT, ±64비트 경계 | T-TYPE |
| DECIMAL | 10진 문자열 | SQL_DECIMAL | SQL_C_NUMERIC, 38자리·부호·scale | T-TYPE |
| REAL | 유한 JSON 숫자 | SQL_REAL | SQL_C_FLOAT, 단정도 한계 | T-TYPE |
| DOUBLE PRECISION | 유한 JSON 숫자 | SQL_DOUBLE | SQL_C_DOUBLE, NaN/무한대 거부 | T-TYPE |
| BOOLEAN | JSON boolean | SQL_BIT | SQL_C_BIT, 0/1과 NULL indicator | T-TYPE |
| DATE | YYYY-MM-DD | SQL_TYPE_DATE | SQL_C_TYPE_DATE / SQL_DATE_STRUCT | T-TYPE |
| TIME | HH:MM:SS[.ffffff] | SQL_TYPE_TIME | SQL_C_TYPE_TIME, 소수 초는 문자 경로로 보존 | T-TYPE |
| TIMESTAMP | 날짜·시각 문자열 | SQL_TYPE_TIMESTAMP | SQL_C_TYPE_TIMESTAMP, fraction=μs×1000 | T-TYPE |
| TIME WITH TIME ZONE | 시각+offset 문자열 | SQL_WVARCHAR | SQL_C_WCHAR, offset·소수 초 보존 | T-TYPE |
| TIMESTAMP WITH TIME ZONE | 날짜·시각+offset | SQL_WVARCHAR | SQL_C_WCHAR, offset·소수 초 보존 | T-TYPE |
| INTERVAL | 한정자에 맞는 문자열 | SQL_INTERVAL_* | SQL_C_INTERVAL_* / SQL_INTERVAL_STRUCT | T-TYPE |
| UNKNOWN | 준비 분석의 미정 타입 | 확정 SQL 타입 아님 | SQLDescribeParam/Col은 HYC00; 힌트/CAST 뒤 재분석 | T-PREPARE |

NUMERIC/DEC는 서버 정규형 DECIMAL에, NCHAR/NVARCHAR는 CHAR/VARCHAR에, FLOAT는 REAL/DOUBLE PRECISION에 맞춘다. 선언 별칭을 근거로 저장 인코딩이나 정밀도를 바꾸지 않는다. 위 표 외의 미지원 DB 타입은 성공 변환으로 가리지 않는다.

INTERVAL은 YEAR, MONTH, YEAR_TO_MONTH, DAY, HOUR, MINUTE, SECOND, DAY_TO_HOUR, DAY_TO_MINUTE, DAY_TO_SECOND, HOUR_TO_MINUTE, HOUR_TO_SECOND, MINUTE_TO_SECOND의 13개 SQL_INTERVAL_*와 대응 SQL_C_INTERVAL_*를 모두 계획한다. 연-월과 일-시간의 부호·leadingPrecision·fractionalPrecision을 검사한다.

## 길이와 정확성

- CHAR 1~2000, VARCHAR 기본/최대 65535의 DB 단위는 코드 포인트이다. ColumnSize는 DB의 문자 수이며, SQL_C_WCHAR 전송 최대 옥텟 길이는 보충 평면 문자까지 고려해 최대 4×문자 수이다. 실제 출력 indicator는 실제 UTF-16 바이트 수이다. SQL_C_CHAR는 ACP의 실제 변환 크기를 따로 센다. `A😀한`의 코드 포인트 3·UTF-16 단위 4·UTF-8 바이트 8을 서로 혼동하지 않는다.
- DECIMAL 인자 생략은 (10,3), 정밀도만 있으면 (p,0), 최대 p=38이다. **메타데이터의 실제 precision/scale을 우선**한다. SQL_NUMERIC_STRUCT의 val은 16바이트 little-endian 절댓값, sign은 1=양수/0=음수이다. 앱 descriptor의 precision/scale과 값의 범위를 검사하고 double로 우회하지 않는다.
- 파라미터의 큰 정수는 문자열로 보낸다. 안전 정수 범위 ±(2^53-1) 밖을 JSON 숫자로 내보내지 않는다. DECIMAL·날짜시간·INTERVAL도 문자열이며 이진 입력은 `{binary: hex}`이다. NULL은 JSON null, 빈 문자열과 빈 이진은 별개의 값이다.
- TIME_STRUCT에는 fraction이 없다. 소수 초가 있는 값을 그 구조체로 받을 때 실제 소수 손실은 01S07 경고로 보고하고, 문자 수신은 전 자릿수를 보존한다. TIMESTAMP_STRUCT.fraction은 나노초이며 서버의 0~6자리 소수 초와 정확히 변환한다. 입력 나노초를 μs로 줄이는 경우도 손실·범위 정책을 시험한다.
- timezone 타입의 원래 typeName/declared는 유지하고 SQL_WVARCHAR로 노출한다. ColumnSize는 TIME 최대 21, TIMESTAMP 최대 32이며 선언 fractionalPrecision에 맞게 산출한다. 표준 날짜 구조체에 오프셋을 숨겨 넣지 않는다. DATE 범위는 0001-01-01~9999-12-31이다.
- 준비 메타데이터 nullable UNKNOWN은 SQL_NULLABLE_UNKNOWN이다. 실행 결과 메타데이터에 nullable이 없다고 NOT NULL을 추정하지 않는다. SQLColumns는 딕셔너리의 실제 NOT NULL/PK를 쓴다.

## C 타입·오류·시험

SQL_C_DEFAULT는 실제 SQL 타입으로 결정한다. SQL_C_CHAR/WCHAR/BINARY, SQL_C_BIT, 부호 있는/없는 정수(C_TINYINT/SHORT/LONG/BIGINT 및 SDK alias), FLOAT/DOUBLE, NUMERIC, DATE/TIME/TIMESTAMP와 13개 INTERVAL의 유효성 검사를 둔다. 이들 사이의 변환은 ODBC 변환 규약의 허용 조합만 제공한다. SQL_C_GUID·bookmark·출력 파라미터·제품 고유 C 타입은 초기 제외이다. 정의되지 않은 C 타입은 HY003, 지원하지 않는 SQL 타입은 HY004, 타입 간 불가 변환은 07006/HYC00으로 구분한다.

수치 정수부 범위 초과 22003, 변환 문법 22018, 날짜 문법/범위 22007/22008, NULL indicator 누락 22002, 가변 출력 버퍼 잘림 01004를 구별한다. 저장 입력의 길이 초과와 수신 버퍼 부족도 다르다. 앱 버퍼 부족을 이유로 DB에 잘린 값을 입력하지 않는다.

T-TYPE은 최대/최소/한 칸 초과, NULL/빈 값, 고정 길이 공백, 38자리 소수, 2^53 경계, 소수 초 0~6, timezone offset, 13개 interval, 잘못된 C 타입을 x86/x64에서 왕복한다. T-TEXT/T-GETDATA/T-ROWSET/T-PARAM은 canary·indicator·부분 수신·행/파라미터 배열 offset·주소 계산 오버플로를 함께 검사한다.
