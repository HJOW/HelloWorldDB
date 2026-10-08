# jdbc8 진행 상황

HelloWorldDB 용 JDBC 드라이버(자바 8 이상)를 개발하는 프로젝트이다.
사양은 루트의 AGENTS.md 가 기준이다. 이 문서에는 세부 계획, 진행 상황, 인수인계 사항만 적는다.
아래의 단계 번호(13-1 등)는 보류 전 계획에서 쓰던 번호이다. "상세 N" 은 AGENTS.md "RDBMS 에 구현되어야 할 사항 (상세)" 의 N번 절을 가리킨다.

## 현재 상태

- 최종 갱신 : 2026-10-08
- 진행 단계 : 보류 (코드 없음)
- 착수 조건 : `rdbms` 와 `nodejsDriver` 를 마친 뒤 계획부터 다시 정한다. 아래 세부 계획은 보류 전에 잡아 둔 초안이며 확정된 것이 아니므로 그대로 착수하지 않는다.
- 다음 작업 : 없음

## 작업 규칙

- 작업 항목을 끝내면 `[ ]` 를 `[x]` 로 바꾼다. 묶음이 끝나면 "현재 상태" 와 "작업 이력" 을 갱신한다.
- 사양에 없는 것을 새로 정했으면 "결정 사항" 에 적는다.

## 세부 계획 초안 (보류 전의 13단계)

### 13-1. 빌드 구성

- [ ] 빌드 도구 구성 (Maven 제안). 자바 8 을 대상으로 컴파일한다
- [ ] 외부 라이브러리 없이 JDK 표준 API 만 쓴다. 테스트 도구만 예외이다
- [ ] `META-INF/services/java.sql.Driver` 로 드라이버를 자동 등록한다
- [ ] 통합 테스트에서 `rdbms` 를 임시 데이터 디렉토리로 띄우고 내리는 방법을 마련한다

### 13-2. 프로토콜 계층

이 계층은 `jdbc5` 로 그대로 가져간다. 자바 5 에 없는 문법과 API 를 쓰지 않는다. (`jdbc5/PROGRESS.md` 의 "자바 5 범위 주의 목록" 참고)

- [ ] JSON 읽기와 쓰기 (직접 구현)
- [ ] TCP 전송 : `Socket`, 길이를 앞에 붙인 프레임. SSL 은 `SSLSocket` (상세 8)
- [ ] UDP 전송 : `DatagramSocket`, 신뢰성 계층의 클라이언트 쪽
- [ ] 핸드셰이크와 프로토콜 버전 협상
- [ ] SCRAM-SHA-256 인증. PBKDF2 는 `HmacSHA256` 으로 직접 구현한다 (`PBKDF2WithHmacSHA256` 은 자바 8 부터 있어 `jdbc5` 에서 쓸 수 없다)
- [ ] 문장 실행, 결과 수신, 다음 행 묶음 요청, 커서 닫기, ping

### 13-3. JDBC 구현 (JDBC 4.2)

- [ ] `Driver` : URL 해석, 접속 속성
- [ ] `Connection` : 자동 커밋, 커밋, 롤백, 세이브포인트, `isValid`. 격리 수준은 READ COMMITTED 만 받는다
- [ ] `Statement`, `PreparedStatement` : `?` 바인딩, `setFetchSize`, 배치 실행
- [ ] `ResultSet` : 전진 전용, 읽기 전용. fetch 단위로 받아 온다
- [ ] `ResultSetMetaData`, `ParameterMetaData`
- [ ] `DatabaseMetaData` : SYSTEM 의 딕셔너리 뷰를 조회하여 구현한다. 테이블스페이스는 스키마로 보여 준다 (상세 3)
- [ ] `SQLException` 에 SQLSTATE 와 내부 오류 번호를 담는다
- [ ] 지원하지 않는 기능은 `SQLFeatureNotSupportedException` 으로 알린다 (`CallableStatement`, CLOB, BLOB, 스크롤이나 갱신이 되는 `ResultSet` 등)

### 13-4. 타입 대응

| DB 타입 | `java.sql.Types` | 자바 타입 |
|---|---|---|
| CHAR, VARCHAR | `CHAR`, `VARCHAR` | `String` |
| BINARY, VARBINARY | `BINARY`, `VARBINARY` | `byte[]` |
| SMALLINT, INTEGER | `SMALLINT`, `INTEGER` | `Integer` |
| BIGINT | `BIGINT` | `Long` |
| NUMERIC, DECIMAL | `NUMERIC`, `DECIMAL` | `BigDecimal` |
| REAL | `REAL` | `Float` |
| DOUBLE PRECISION, FLOAT | `DOUBLE` | `Double` |
| BOOLEAN | `BOOLEAN` | `Boolean` |
| DATE | `DATE` | `java.sql.Date`, `LocalDate` |
| TIME | `TIME` | `java.sql.Time`, `LocalTime` |
| TIMESTAMP | `TIMESTAMP` | `java.sql.Timestamp`, `LocalDateTime` |
| TIME WITH TIME ZONE | `TIME_WITH_TIMEZONE` | `OffsetTime` |
| TIMESTAMP WITH TIME ZONE | `TIMESTAMP_WITH_TIMEZONE` | `OffsetDateTime` |
| INTERVAL | `OTHER` | `String` |

- [ ] `getXxx`, `getObject`, `setXxx`, `setObject` 를 위 표대로 구현

### 13-5. 검증

- [ ] 통합 테스트 : TCP, SSL, UDP 각각으로 로그인, 질의, 파라미터, 대량 결과, 트랜잭션, 오류
- [ ] `DatabaseMetaData` 로 테이블과 컬럼 목록 조회
- [ ] 범용 DB툴(DBeaver 등)에 드라이버를 등록하여 접속, 객체 탐색, 질의가 되는지 확인
- 완료 기준 : 실제 `rdbms` 를 상대로 한 통합 테스트 통과. `DatabaseMetaData` 로 테이블과 컬럼 목록이 조회된다.

## 미결 사항

- Maven 좌표와 빌드 도구. 자바 패키지 이름은 `org.duckdns.hjow.helloworlddb.jdbc8` 로 정해졌다 (AGENTS.md 지켜야 할 사항 6)
- JDBC URL 형식. 제안 : `jdbc:helloworlddb://호스트[:포트][/테이블스페이스][?옵션]`. 호스트 외에는 생략할 수 있고, 옵션으로 UDP 사용과 SSL 사용을 고른다. 접속 대상은 호스트와 포트 번호만으로 정해지므로 SID 나 DB 이름 부분은 두지 않는다 (상세 15)
- SSL 접속 시 서버 인증서를 검증할지에 대한 기본값

## 결정 사항

아직 없음.

## 인수인계 사항

- 프로토콜을 추측해서 구현하지 않는다. `rdbms/docs` 의 프로토콜 명세가 기준이다. `nodejsDriver` 의 구현도 참고할 수 있다.
- 프로토콜 계층(13-2)의 코드는 패키지 선언 외에는 `jdbc5` 와 같게 유지한다. 한쪽을 고치면 다른 쪽도 고친다.
- 여기서 정한 JDBC URL 형식을 `jdbc5` 도 그대로 쓴다.
- DECIMAL/DEC/NUMERIC의 선언 인자를 모두 생략하면 (10,3), VARCHAR/NVARCHAR의 최대·기본 길이는 65,535이다. 실제 컬럼 길이/정밀도/소수 자릿수는 서버 메타데이터에서 읽는다. `NUMERIC(p)` 등 명시한 선언을 기본값 (10,3)으로 덮어쓰지 않는다. [rdbms 타입 정책](../rdbms/docs/data-types.md)을 참고한다.

## 작업 이력

- 2026-10-08 : 세부 계획 작성.
- 2026-10-08 : 보류로 전환. 세부 계획은 초안으로 남김. 자바 패키지 이름 확정.
- 2026-10-08 : 변경된 타입 기본값과 메타데이터 사용 규칙을 인수인계에 반영했다. 개발은 계속 보류한다.
