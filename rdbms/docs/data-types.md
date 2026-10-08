# 데이터 타입 정의

`src/types/dataType.ts`의 `resolveDataType()`은 SQL 타입 이름과 타입 인자를 정규화된 `DataType` 정의로 바꾼다. 키워드·별칭은 대소문자를 구분하지 않으며 연속 공백은 하나로 정규화한다. 타입 인자는 SQL 파서에서 숫자로 해석해 넘긴다.

| 정규 타입 | 별칭 | 기본값 | 허용 범위 |
|---|---|---|---|
| `CHAR` | `CHARACTER`, `NCHAR`, `NATIONAL CHARACTER` | 길이 1 | 1~2,000 |
| `VARCHAR` | `CHARACTER VARYING`, `CHAR VARYING`, `NVARCHAR`, `NATIONAL CHARACTER VARYING` | 길이 65,535 | 1~65,535 |
| `BINARY` | - | 길이 1 | 1~2,000 |
| `VARBINARY` | `BINARY VARYING` | 길이 65,535 | 1~65,535 |
| `SMALLINT` | - | - | 16비트 부호 정수 |
| `INTEGER` | `INT` | - | 32비트 부호 정수 |
| `BIGINT` | - | - | 64비트 부호 정수 |
| `DECIMAL` | `DEC`, `NUMERIC` | `(10,3)` | 정밀도 1~38, 소수 자릿수 0~정밀도 |
| `REAL` | - | - | IEEE 754 단정도 |
| `DOUBLE PRECISION` | - | - | IEEE 754 배정도 |
| `FLOAT(p)` | - | 인자 생략 시 `DOUBLE PRECISION` | p=1~24는 `REAL`, p=25~53은 `DOUBLE PRECISION` |
| `BOOLEAN`, `DATE` | - | - | 각각 논리값, 날짜 |
| `TIME(p)` | `TIME(p) WITH TIME ZONE` | p=0 | p=0~6 |
| `TIMESTAMP(p)` | `TIMESTAMP(p) WITH TIME ZONE` | p=6 | p=0~6 |
| `INTERVAL` 수식자 | - | 선행 정밀도 2, 초 정밀도 6 | 선행 정밀도 1~9, 초 정밀도 0~6 |

문자 길이는 바이트가 아니라 유니코드 코드 포인트 단위이다. `NCHAR`, `NVARCHAR`는 UTF-8만 지원하므로 각각 `CHAR`, `VARCHAR`와 같은 정의를 사용한다. `TIME WITH TIME ZONE`과 `TIMESTAMP WITH TIME ZONE`은 타임존이 있는 별도 타입 정의로 보존한다.

`DECIMAL`, `DEC`, `NUMERIC`의 인자 전체 생략은 `(10,3)`, 정밀도만 지정한 `(p)`는 `(p,0)`이다. `FLOAT(p)`는 IEEE 754 유효 정밀도 경계인 24비트 이하에서 단정도, 그 이상에서 배정도로 해석한다.

`INTERVAL` 수식자는 타입 이름에 붙여 전달한다(예: `INTERVAL YEAR TO MONTH`, `INTERVAL DAY TO SECOND`). 타입 인자는 선행 정밀도, 그리고 종료 필드가 `SECOND`일 때 초 소수 자릿수 순서이다. 시작 필드가 `SECOND`인 단일 필드 수식자는 인자를 초 소수 자릿수로 해석한다. 이 수식자 표기는 타입 해석 API의 내부 인터페이스이며, SQL 구문 분석기는 SQL 구문에서 같은 정의를 만들어야 한다.

잘못된 인자 수나 범위는 SQLSTATE `22023`, 내부 오류 번호 2000이다. 지원하지 않는 타입은 SQLSTATE `0A000`, 내부 오류 번호 1이다. `CLOB`, `NCLOB`, `BLOB`를 비롯해 AGENTS.md에서 초기 버전 제외로 정한 타입은 지원하지 않는다.

드라이버와 DB툴은 컬럼의 실제 길이/정밀도/소수 자릿수를 서버 메타데이터에서 읽어야 한다. 기본값은 타입 선언에만 적용하며 조회된 값의 형식을 강제로 바꾸는 규칙이 아니다.

SQL 카탈로그에는 해석한 타입 인자를 명시적으로 기록한다. 저장 형식은 [storage-v1.md](storage-v1.md)의 버전 규칙을 따른다. 1.0 출시 전에는 포맷 번호를 유지한 변경과 기존 호환성 생략이 가능하며, 이 경우에도 문서와 테스트 자료를 함께 갱신한다.
