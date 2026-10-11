# SQL 문법 (구문 분석기)

`src/sql/parser.ts`의 `parseStatement(sql)`이 SQL 문장 하나를 구문 트리(`src/sql/ast.ts`)로 만든다. 받아들이는 문법의 기준은 AGENTS.md 상세 1, 3, 4, 5, 6, 10, 13이며, 이 문서에는 그 사양을 구현하면서 정한 세부 규칙과 사양에 없는 부분의 결정을 적는다. 드라이버와 DB툴이 SQL을 만들거나 나눌 때도 이 문서를 기준으로 삼는다.

구문 분석기는 문법만 본다. 이름이 실제로 있는지, 타입이 맞는지, 권한이 있는지는 뒤 단계(`exec`, `auth`)가 본다. 단, 데이터 타입의 이름과 인자는 `types/dataType.ts`로 바로 해석하여 타입 정의(`DataType`)로 담는다. 타입 규칙은 [data-types.md](data-types.md)에 있다.

## 어휘 규칙

- 키워드와 따옴표 없는 식별자는 대소문자를 구분하지 않으며 대문자로 바꾼다. 큰따옴표로 감싼 식별자는 적힌 그대로 두고 키워드로 보지 않는다. 안의 큰따옴표는 `""`로 적는다. 빈 이름(`""`)은 쓸 수 없다.
- 따옴표 없는 식별자는 문자 또는 `_`로 시작하고 문자, 숫자, `_`, `$`로 이어진다. 문자와 숫자는 유니코드 전체이다(한글 이름 가능).
- 식별자는 최대 128자(코드 포인트)이다. 넘으면 `42622`이다.
- 문자열 리터럴은 작은따옴표로 감싸고 안의 작은따옴표는 `''`로 적는다. 줄바꿈을 포함할 수 있다. `N'...'`은 같은 문자열이다. 역슬래시는 특별한 뜻이 없다.
- 이진 리터럴은 `X'0A0B'`이며 짝수 개의 16진 숫자만 쓴다.
- 수 리터럴은 정수(`123`), 소수(`1.5`, `.5`, `5.`), 지수 표기(`1e3`, `1.5E-3`)이다. 부호는 리터럴의 일부가 아니지만, 수 리터럴 바로 앞의 단항 부호는 구문 분석기가 리터럴에 합친다(`-2147483648`이 하나의 정수 리터럴이 된다).
- 주석은 `-- 줄 끝까지`와 `/* ... */`이다. 여러 줄 주석은 겹치지 않으며 처음 만난 `*/`에서 끝난다.
- 연산자와 구두점은 `( ) , . ; * + - / = <> != < <= > >= ||`이다. `!=`는 `<>`와 같다. 그 밖의 기호(`%`, `^`, `&` 등)는 문법 오류이다.
- `?`는 파라미터이다. 문장 안에서 나타난 순서대로 1부터 번호가 붙는다. 문자열이나 주석 안의 `?`는 파라미터가 아니다.
- 위치는 줄과 칸으로 센다. 둘 다 1부터 세며 칸은 UTF-16 단위이다. `\r\n`은 줄바꿈 하나이다.

## 예약어

다음 단어는 큰따옴표로 감싸야 식별자로 쓸 수 있다. 문장과 절의 구조를 정하는 단어만 예약했다.

```
ALL ALTER AND ANY AS ASC BETWEEN BY CASE CAST CHECK CONSTRAINT CREATE CROSS
CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER DEFAULT DELETE DESC DISTINCT DROP
ELSE END ESCAPE EXCEPT EXISTS FALSE FETCH FOR FOREIGN FROM FULL GRANT GROUP HAVING
IN INNER INSERT INTERSECT INTO IS JOIN LEFT LIKE LIMIT LOCALTIME LOCALTIMESTAMP
NATURAL NOT NULL OFFSET ON OR ORDER OUTER PRIMARY REFERENCES REVOKE RIGHT
SELECT SET SOME TABLE THEN TO TRUE UNION UNIQUE UPDATE USING VALUES WHEN WHERE WITH
```

그 밖의 키워드는 문맥으로 구별하므로 이름으로 쓸 수 있다. 타입 이름(`DATE`, `TIME`, `TIMESTAMP`, `INTERVAL`, `VARCHAR` 등), 함수 이름(`COUNT`, `TRIM` 등), `KEY`, `INDEX`, `VIEW`, `USER`, `TABLESPACE`, `COLUMN`, `FIRST`, `ROWS`, `BEGIN`, `COMMIT`, `VALUE`, `NAME`, `MESSAGE`가 그렇다. 문맥으로 구별하는 규칙은 다음과 같다.

- `DATE`, `TIME`, `TIMESTAMP` 뒤에 문자열이 오면 리터럴이고, 아니면 이름이다. `INTERVAL` 뒤에 문자열(또는 부호와 문자열)이 오면 리터럴이다.
- 생략할 수 있는 `COLUMN`, `SAVEPOINT`와 권한 대상의 `TABLESPACE`, `VIEW`는 뒤에 이름이 이어질 때만 키워드로 본다. 그래서 `ALTER TABLE T DROP COLUMN`은 이름이 `COLUMN`인 컬럼을, `GRANT SELECT ON VIEW TO U`는 이름이 `VIEW`인 객체를 가리킨다.
- `IF`는 `IF NOT EXISTS`, `IF EXISTS`로 이어질 때만 키워드이다.
- `AS` 없이 적는 별칭은 예약어가 아닌 단어만 된다.

## 문장

한 번에 문장 하나만 받는다. 문장 끝의 `;`는 있어도 되고 없어도 된다. `;` 뒤에 다른 문장이 이어지거나 문장이 비어 있으면 문법 오류이다. 여러 문장을 나누어 보내는 것은 클라이언트(CLI)의 일이다.

사양의 구문에 더해 다음을 받는다. 모두 뜻이 달라지지 않는 표기이거나 널리 쓰이는 표준 문법이다.

| 구문 | 내용 |
|---|---|
| 질의 | `FROM a, b`(쉼표 나열), 괄호로 감싼 조인, 괄호로 감싼 질의와 그 안의 `ORDER BY`·행 수 제한, `UNION DISTINCT`, `SELECT ALL` |
| 행 수 제한 | `OFFSET`과 `LIMIT`/`FETCH`는 순서를 가리지 않는다. `OFFSET n` 뒤의 `ROW`, `ROWS`는 생략할 수 있다. `FETCH FIRST ROW ONLY`처럼 개수를 생략하면 1행이다 |
| 식 | `IS [NOT] { TRUE \| FALSE \| UNKNOWN }`, `SOME`(`ANY`와 같다), `DEFAULT`(INSERT의 `VALUES`와 UPDATE의 `SET`에서 값 자리에만) |
| 함수 | `SUBSTRING(x FROM a [FOR b])`와 `SUBSTRING(x, a [, b])`, `TRIM([LEADING \| TRAILING \| BOTH] [문자] FROM x)`, `POSITION(a IN b)`, `EXTRACT(필드 FROM x)`, `CURRENT_TIMESTAMP(p)`. 괄호 없이 쓰는 함수에 빈 괄호를 붙여도 된다 |
| 리터럴 | `TIMESTAMP WITH TIME ZONE '...'`, `TIME WITHOUT TIME ZONE '...'`, `INTERVAL -'5' DAY`(부호를 문자열 앞에) |
| 타입 | `TIME(p) WITHOUT TIME ZONE`, `NATIONAL CHAR`, `NATIONAL CHAR VARYING`, `NCHAR VARYING`, `INTERVAL SECOND(선행 정밀도, 소수 초 자릿수)` |
| INSERT | `DEFAULT VALUES`, 괄호로 감싼 질의 |
| CREATE TABLE | 컬럼 속성(`DEFAULT`, `NOT NULL`, `NULL`, `PRIMARY KEY`, `REFERENCES`)을 순서와 무관하게 받는다. 컬럼에 붙여 적는 제약조건에도 `CONSTRAINT 이름`을 둘 수 있다. 컬럼과 테이블 제약조건을 섞어 적을 수 있다 |
| ALTER TABLE | `RENAME [COLUMN] a TO b`의 `COLUMN` 생략, `DROP [COLUMN] a RESTRICT` |
| ALTER USER | 비밀번호와 기본 테이블스페이스를 한 문장에 함께 적을 수 있다 |
| DROP TABLESPACE | `INCLUDING CONTENTS AND DATAFILES`(데이터 파일은 항상 함께 지우므로 뜻이 같다) |
| 트랜잭션 | `BEGIN [WORK \| TRANSACTION]`, `START TRANSACTION ISOLATION LEVEL READ COMMITTED`, `SET TRANSACTION ISOLATION LEVEL READ COMMITTED`, `RELEASE [SAVEPOINT] 이름` |
| 세션 | `SET AUTOCOMMIT [=] { ON \| OFF \| TRUE \| FALSE \| 1 \| 0 }`, `SET TIME ZONE { '이름 또는 오프셋' \| LOCAL \| INTERVAL '+09:00' HOUR TO MINUTE }` |

세부 규칙:

- 연산자의 우선순위는 낮은 것부터 `OR`, `AND`, `NOT`, 비교와 조건(`=`, `IS`, `BETWEEN`, `IN`, `LIKE`), `+`·`-`·`||`, `*`·`/`, 단항 부호이다. `||`는 `+`, `-`와 같은 순위이며 왼쪽부터 묶는다.
- 집합 연산은 `INTERSECT`가 `UNION`, `EXCEPT`보다 먼저 묶인다. `UNION`과 `EXCEPT`는 왼쪽부터 묶는다. `ALL`은 `UNION`에만 쓸 수 있다.
- 조인은 왼쪽부터 묶는다. `CROSS JOIN`은 조건을 가질 수 없고 그 밖의 조인은 `ON`이나 `USING`이 있어야 한다.
- `BETWEEN a AND b`, `LIKE 패턴 [ESCAPE 문자]`, `POSITION(a IN b)`의 인자와 `DEFAULT 식`, 행 수 제한의 개수는 비교·논리 연산자를 포함하지 않는 식이다. 그런 식을 쓰려면 괄호로 감싼다.
- `IN (` 바로 뒤가 `SELECT`이면 서브쿼리이고, 아니면 값 목록이다.
- 여는 괄호 뒤가 `SELECT`이면 서브쿼리(식에서는 스칼라 서브쿼리, FROM 절에서는 인라인 뷰)이다. 괄호가 겹쳐 있으면 맨 안쪽이 질의이고, 바깥 괄호는 안쪽 질의 뒤에 무엇이 이어지는지로 정해진다. `((SELECT 1))`과 `((SELECT 1) UNION (SELECT 2))`는 질의이고, `((SELECT 1) + 1)`은 식, `((SELECT 1) A CROSS JOIN B)`는 조인이다. 되돌려 읽지 않고 한 번에 정한다.
- 인라인 뷰의 별칭은 생략할 수 있다. 별칭 뒤에 컬럼 이름 목록을 둘 수 있다.
- `COUNT(*)`의 `*`는 `COUNT`에만 쓸 수 있다. 함수 이름이 실제로 있는지는 뒤 단계가 본다.
- 컬럼 참조는 `컬럼`, `테이블.컬럼`, `테이블스페이스.테이블.컬럼`이고 선택 목록의 `*`는 `*`, `테이블.*`, `테이블스페이스.테이블.*`이다.
- 뷰 정의에는 `?` 파라미터를 쓸 수 없다. `CREATE VIEW`는 `AS` 뒤 질의의 원문을 구문 트리와 함께 남긴다.
- `UPDATE ... SET`의 컬럼 이름에는 테이블 이름을 붙이지 않는다.
- 비밀번호는 문자열 리터럴만 받는다.
- 데이터 타입은 생략할 수 없다. 타입의 길이와 정밀도는 생략할 수 있다(상세 13).
- INTERVAL 리터럴의 한정자는 적힌 그대로(생략한 정밀도는 생략된 채로) 남긴다. 리터럴의 값이 한정자에 맞는지는 뒤 단계가 본다.
- 별칭을 준 FROM 출처는 별칭으로만 한정해 부를 수 있다. `FROM K x` 에서 `K.A` 는 오류(`42703`)이고 `x.A` 로 쓴다. 같은 테이블을 두 번 쓰는 자기 조인에서 테이블 이름이 두 출처에 모두 맞아 모호해지지 않게 하기 위함이다.
- 딕셔너리 뷰(`SYS_*`)와 `DUAL` 은 읽기 전용이다. 이것들을 대상으로 한 DML 과 `DROP`·`ALTER`·`TRUNCATE`·`CREATE INDEX` 는 `42809` 이다. SYSTEM 이 아닌 테이블스페이스에 같은 이름의 사용자 객체를 만든 경우에는 그 객체가 먼저이다.
- `ALTER TABLE ... ADD COLUMN` : `DEFAULT` 가 있으면 한 번 계산하여 기존 행에도 같은 값을 채운다(행을 다시 쓰므로 행 수에 비례한다). `DEFAULT` 가 없거나 NULL 이 되는데 `NOT NULL` 이면 행이 있는 테이블에서는 `23502` 이다. 행이 있는 테이블에 `REFERENCES` 와 NULL 이 아닌 `DEFAULT` 를 함께 주는 조합은 지원하지 않는다(`0A000`).

## 지원하지 않는 문법

다음은 문법 오류(`42601`)가 아니라 지원하지 않는 기능(`0A000`)으로 알린다(상세 0, 11, 12, 16).

- 문장 : `WITH`(CTE), `MERGE`, `CALL`, `EXPLAIN`, `LOCK`, `COMMENT`, `RENAME`, `SHOW`, `DESCRIBE`, 백업·복원·내보내기·가져오기, `VALUES`만으로 된 질의
- 객체 : 시퀀스, 트리거, 프로시저, 함수, 시노님, 구체화 뷰, 역할, 스키마, 임시 테이블, `ALTER TABLESPACE`·`ALTER INDEX`·`ALTER VIEW`
- 타입 : `CLOB`, `BLOB`, `NCLOB`, `JSON`, `XML` 등 [data-types.md](data-types.md)에 없는 타입
- 제약조건과 컬럼 속성 : `UNIQUE`, `CHECK`, `SET DEFAULT` 참조동작, `MATCH`, `DEFERRABLE`, IDENTITY·`AUTO_INCREMENT`·`GENERATED`, `COLLATE`
- 테이블 : `CREATE TABLE ... AS SELECT`, 파티션, 컬럼 타입 변경(`ALTER COLUMN ... TYPE`, `MODIFY`), `DROP COLUMN ... CASCADE`
- 뷰와 인덱스 : `WITH CHECK OPTION`, `CREATE UNIQUE INDEX`, 함수 기반·부분 인덱스, 인덱스 종류 지정(`USING`), 인덱스의 `NULLS FIRST`
- 질의 : 윈도우 함수(`OVER`), `FILTER`, `WITHIN GROUP`, `WINDOW` 절, `NATURAL JOIN`, `LATERAL`, `ROLLUP`·`CUBE`·`GROUPING SETS`, `INTERSECT ALL`·`EXCEPT ALL`, `SELECT INTO`, `IS DISTINCT FROM`, `BETWEEN SYMMETRIC`, 행 값 `(a, b)`, `FETCH ... PERCENT`·`WITH TIES`, `LIMIT a, b`, `FOR UPDATE OF`·`NOWAIT`·`SKIP LOCKED`·`FOR SHARE`
- DML : `RETURNING`, `ON CONFLICT`, `INSERT ALL`, `UPDATE ... FROM`, `DELETE ... USING`, 여러 컬럼 대입 `SET (a, b) = ...`
- 권한 : `WITH GRANT OPTION`, `GRANT OPTION FOR`, `PUBLIC`, 컬럼 단위 권한, `REFERENCES`·`EXECUTE` 등 사양에 없는 권한, 사용자 정의 권한 그룹
- 트랜잭션 : `READ COMMITTED` 외의 격리 수준, `READ ONLY`·`READ WRITE`, `AND CHAIN`
- 7단계 전의 임시 제한 : 문장마다 바로 커밋되므로 `BEGIN`, `START TRANSACTION`, `ROLLBACK`, `SAVEPOINT`, `ROLLBACK TO`, `RELEASE SAVEPOINT`, `SET AUTOCOMMIT OFF` 는 `0A000` 이다. 되돌릴 수 없는데 성공으로 알리면 데이터가 남기 때문이다. `COMMIT`, `SET AUTOCOMMIT ON`, `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` 는 할 일이 없는 채로 받는다. 7단계에서 이 제한을 푼다.

## 한도

| 한도 | 값 | 넘으면 |
|---|---:|---|
| 식별자 길이 | 128자 | `42622` |
| 겹쳐 들어가는 깊이(괄호, 서브쿼리, 함수 인자, `CASE`, `NOT`, 단항 부호) | 200 | `54001` |
| 구문 트리의 깊이 | 1,000 | `54001` |

구문 분석기는 재귀로 읽으므로 겹친 깊이를 제한한다. 제한하지 않으면 괄호를 수천 겹 쌓은 문장이 호출 스택을 넘긴다.

구문 트리의 깊이는 길게 이어진 연산 때문에 따로 제한한다. `a + b + c + ...`나 `UNION`, 조인의 사슬은 왼쪽으로 깊어지는 트리가 되므로, 한 사슬에 약 1,000개까지만 이어 쓸 수 있다. `AND`와 `OR`은 피연산자를 나란히 담으므로 조건을 몇 개 이어도 깊어지지 않는다. `IN` 목록, `VALUES`의 행, 선택 목록도 길이 제한이 없다. 이 제한 덕분에 구문 트리를 재귀로 순회하는 뒤 단계의 코드는 깊이 1,000까지만 견디면 된다.

## 오류

| 번호 | SQLSTATE | 뜻 |
|---:|---|---|
| 3000 | `42601` | 문법 오류 |
| 3001 | `42622` | 식별자가 너무 김 |
| 3002 | `54001` | 문장이 너무 깊이 겹쳤거나 연산이 너무 길게 이어짐 |
| 1 | `0A000` | 지원하지 않는 문법이나 타입 |
| 2000 | `22023` | 타입의 길이, 정밀도, INTERVAL 한정자가 잘못됨 |

구문 분석기가 내는 오류는 모두 `DbError.position`(offset, line, column)을 가지며, 메시지 끝에도 `(line 3, column 5).`처럼 위치를 적는다. 문법 오류의 메시지는 `Unexpected "FROM"; expected an expression` 형태이다.

## 구문 트리

`parseStatement`는 `{ statement, parameterCount }`를 돌려준다. 노드의 타입은 `src/sql/ast.ts`에 있으며 원칙은 다음과 같다.

- 이름은 정규화된 문자열이다(따옴표 없는 이름은 대문자). 객체 이름은 `{ tablespace, name }`이고 테이블스페이스명을 생략하면 `tablespace`가 `null`이다.
- 생략한 부분은 `null`, `false`, 빈 배열로 남긴다. 기본값을 채우는 것은 뒤 단계의 일이다. 예외로 데이터 타입은 기본값까지 해석한 `DataType`이다.
- 식과 객체 이름은 원문 안의 위치(`position`)를 가진다. 뒤 단계가 오류를 낼 때 `withPosition`으로 붙이면 된다.
- 문장의 종류는 `kind`로 구별한다. `BEGIN`과 `START TRANSACTION`은 같은 `Begin`, 권한과 권한 그룹의 `GRANT`는 `Grant`와 `GrantGroup`으로 나뉜다.
- 수 리터럴은 적힌 표기(`text`)와 종류(`INTEGER`, `DECIMAL`, `FLOAT`)만 가진다. 어느 타입의 값으로 볼지는 뒤 단계가 정한다. 문자열 리터럴도 타입이 정해지지 않은 채로 남는다.
- `AND`, `OR`은 `Logical` 노드이고 피연산자가 둘 이상이다. 그 밖의 이항 연산은 `Binary` 노드이다.
