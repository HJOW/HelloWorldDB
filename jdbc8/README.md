# HelloWorldDB JDBC 4.2

Java 8 이상용 HelloWorldDB 드라이버이다. 배포 JAR의 실행에는 JDK 표준 API만 필요하다. 서버는 별도로 구동한다.

## 빌드·시험

이 디렉토리에서 실행한다. 실제 JDK 8의 javac·jar로 빌드하며 클래스 버전은 52이다. Maven·Gradle은 사용하지 않는다. Node.js 22 이상은 빌드·시험만 조정한다.

```powershell
$env:HWDB_JAVA8_HOME = 'C:\Program Files\Java\jdk1.8.0_202'
$env:HWDB_JAVA21_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'
npm run build
npm test
npm run test:extensions
npm run test:consumer
```

배포물은 `dist/org.duckdns.hjow.helloworlddb.jdbc8-0.1.0.jar`이다. Java 8 경로는 사용자가 지정한 설치본이며 빌드 실행기의 기본값도 같다. Java 21 경로는 설치 환경에 맞게 지정한다. `npm run test:matrix`는 `npm test`와 같다.

시험은 Java 8·21에서 같은 JAR을 실행한다. 서버를 임시 설치·데이터 디렉토리와 빈 포트로 띄우고 끝나면 정상 종료·정리한다. `../rdbms/node_modules`가 준비되어 있어야 하며 서버는 항상 다시 컴파일한다. `HWDB_TEST_RUNTIME`으로 서버 실행 파일을 지정할 수 있다(기본 Node.js). 공유 코드의 Java 6 API 검사를 위해 전체 시험에는 JDK 6도 필요하다(`HWDB_JAVA6_HOME`, 이 PC 기본 `C:\Program Files\Java\jdk1.6.0_45`).

## 접속

드라이버 클래스는 `org.duckdns.hjow.helloworlddb.jdbc8.Driver`이다. JAR을 클래스 경로에 두면 서비스 등록으로 자동 로딩된다. `Class.forName`으로 명시적으로 로딩해도 된다.

```java
import java.sql.*;
import java.util.Properties;

Properties options = new Properties();
options.setProperty("user", "SYSTEM");
options.setProperty("password", "HelloWorldDB");
try (Connection connection = DriverManager.getConnection(
        "jdbc:helloworlddb://127.0.0.1:7410", options);
     Statement statement = connection.createStatement();
     ResultSet rows = statement.executeQuery("SELECT 'Hello World' AS MESSAGE")) {
    while (rows.next()) System.out.println(rows.getString("MESSAGE"));
}
```

URL은 `jdbc:helloworlddb://호스트[:포트][?키=값&키=값]`이다. IPv6는 `[::1]`처럼 쓴다. SID·DB 이름·경로는 없으며 현재 테이블스페이스는 `tablespace` 속성으로 지정한다. URL 쿼리는 UTF-8 URL 인코딩을 사용하고 Properties보다 우선한다. 모르는 속성과 잘못된 조합은 `08001`이다. jdbc6도 같은 URL을 사용한다.

| 속성 | 기본값 | 설명 |
|---|---|---|
| `user` | 필수 | 사용자명 |
| `password` | 빈 문자열 | 비밀번호 |
| `tablespace` | 사용자 기본값 | 현재 테이블스페이스 |
| `timeZone` | 서버 기본값 | 세션 타임존 |
| `transport` | `tcp` | `tcp` 또는 `udp` |
| `ssl` | `false` | TCP TLS 사용 |
| `sslCa` | JDK 신뢰 저장소 | 신뢰할 PEM CA 파일 |
| `sslVerify` | `true` | 인증서 체인·유효 기간·호스트 이름 검증 |
| `sslMinVersion` | `TLSv1.2` | 켤 TLS 최소 버전. `TLSv1`, `TLSv1.1`, `TLSv1.2`, `TLSv1.3` 중 하나. Java 6 에서는 `TLSv1` 을 명시한다 |
| `connectTimeoutMs` | `10000` | 연결·인증 요청 제한. DriverManager 로그인 제한이 있으면 그 값을 기본으로 사용 |
| `socketTimeoutMs` | `30000` | 응답 제한. 0은 무제한 |
| `fetchSize` | `500` | 1~100,000행 |

URL 질의의 키와 값은 퍼센트 디코딩한다. `+`는 공백이 아니라 문자 그대로 `+`이며, 공백은 `%20`으로 적는다. (`password=a+b%2Bc%20d` 는 `a+b+c d`)

포트 기본값은 7410이다. TLS에서 `ssl=true`와 필요 시 `sslCa`를 지정한다. 인증서 오류만 새 연결에서 100 ms 뒤 최대 두 번 재시도하며 최종 실패는 `08001`/8007이다. `sslVerify=false`는 명시했을 때만 검증을 끈다. `sslCa`와 검증 끄기는 함께 쓸 수 없고 SSL 옵션은 UDP에서 사용할 수 없다.

## JDBC와 타입

- 자동 커밋은 기본 ON이다. 커밋·롤백·세이브포인트와 READ COMMITTED를 지원한다. `getAutoCommit`·`getSchema`는 현재 서버 세션을 조회하여 직접 실행한 `SET AUTOCOMMIT`·`USE`도 반영한다.
- PreparedStatement는 SQL과 파라미터를 분리해 전송한다. 바인딩 누락은 `07001`, 잘못된 인덱스는 `07009`이다. 배치는 순서대로 실행하며 실패 시 앞선 성공 수를 BatchUpdateException에 담는다.
- ResultSet은 전진·읽기 전용이며 현재 fetch 묶음만 보관한다. 커밋·롤백 뒤에도 읽을 수 있는 HOLD_CURSORS_OVER_COMMIT만 지원한다. Statement를 다시 실행하거나 닫으면 기존 결과를 닫는다.
- `Statement.cancel()`은 다른 스레드에서 현재 실행 요청을 취소한다. 사용자 취소는 `SQLException`(`57014`/8010), `setQueryTimeout`의 실제 취소 완료는 `SQLTimeoutException`(`57014`/8010)이며 연결과 앞선 수동 트랜잭션 변경은 유지한다. 늦은 취소는 정상 완료와 경합할 수 있다. `setNetworkTimeout`·`socketTimeoutMs`의 통신 시간 초과는 별도 `SQLTimeoutException`(`08006`/8006)으로 연결을 닫는다. 결과를 모르는 DML은 자동 재실행하지 않는다.
- DatabaseMetaData는 SYSTEM 딕셔너리의 권한 필터를 사용한다. 테이블스페이스를 스키마로 표현하고 카탈로그는 없다. 테이블·뷰·시스템 객체·컬럼·PK·FK·인덱스·타입을 제공한다. 뷰 컬럼은 SYS_COLUMNS를 우선하고 누락된 객체만 WHERE 1 = 0으로 보완하며 SELECT 권한이 없는 뷰는 생략한다. 권한 목록은 직접 부여한 객체 권한을 보여 준다.
- 서버가 `prepareDescribe`를 광고하면 준비 문장을 등록하고 `PreparedStatement.getMetaData()`·`getParameterMetaData()`로 실행 전에 컬럼·파라미터 타입을 조회한다. 알려진 컬럼·CAST 문맥을 우선하고 미정 자리는 바인딩 타입 힌트로 보완한다. 미정 타입은 OTHER/UNKNOWN, 미정 precision·scale은 0이다. NULL 허용 여부는 서버의 YES/NO/UNKNOWN을 보존하고 기반 테이블 이름은 추정하지 않는다. DML·DDL을 분석해도 실행하거나 자동 커밋하지 않는다.
- CallableStatement, LOB, SQLXML, RowId, 배열, 생성 키, 스크롤·갱신 ResultSet 등은 SQLFeatureNotSupportedException(`0A000`)이다. 동적 프록시가 상위 런타임의 미지원 메서드도 처리한다. 전체 JDBC 적합성을 선언하지 않는다(`jdbcCompliant() == false`).

| DB 타입 | `getObject()` | 추가 대응 |
|---|---|---|
| CHAR, VARCHAR | String | NCHAR·NVARCHAR도 동일한 UTF-8 규칙. `getBytes()`는 UTF-8 바이트이다(BINARY 의 `getString` 이 16진 표기인 것과 짝을 이룬다) |
| BINARY, VARBINARY | byte[] | getBytes·setBytes·스트림 |
| SMALLINT, INTEGER | Integer | 정수 getter/setter |
| BIGINT | Long | 문자열 전송으로 64비트 정밀도 보존 |
| NUMERIC, DECIMAL | BigDecimal | 소수 자릿수 보존 |
| REAL / DOUBLE PRECISION | Float / Double | NaN·무한대는 오류 |
| BOOLEAN | Boolean | NULL은 기본형 getter와 wasNull로 구분 |
| DATE | java.sql.Date | LocalDate |
| TIME | java.sql.Time | LocalTime으로 소수 초 보존 |
| TIMESTAMP | java.sql.Timestamp | LocalDateTime |
| TIME WITH TIME ZONE | OffsetTime | Types.TIME_WITH_TIMEZONE |
| TIMESTAMP WITH TIME ZONE | OffsetDateTime | Types.TIMESTAMP_WITH_TIMEZONE |
| INTERVAL | String | Types.OTHER |

`getObject(i, LocalDate.class)` 등과 java.time 값의 `setObject`, JDBCType/SQLType 오버로드를 지원한다. Calendar 오버로드는 해당 타임존의 필드를 사용한다. 일반 SQL 날짜시간 getter는 JVM 기본 타임존을 따른다. java.sql.Time은 소수 초를 담지 못하므로 필요하면 LocalTime으로 읽는다. 오프셋 타입은 OffsetTime/OffsetDateTime 또는 getString으로 읽는다.

길이·precision·scale은 서버 메타데이터를 따른다. NUMERIC 별칭은 서버가 정규화한 DECIMAL로 보고한다. 인자 생략은 (10,3), NUMERIC(12)는 (12,0)이다.

```java
try (PreparedStatement statement = connection.prepareStatement("SELECT ? AS CREATED_AT")) {
    statement.setObject(1, OffsetDateTime.parse("2026-10-20T12:34:56.123456+09:00"),
            JDBCType.TIMESTAMP_WITH_TIMEZONE);
    ResultSetMetaData columns = statement.getMetaData(); // 실행 없이 오프셋 타입 확인
    statement.setQueryTimeout(3);
    try (ResultSet rows = statement.executeQuery()) {
        while (rows.next()) System.out.println(rows.getObject(1, OffsetDateTime.class));
    }
}
```

위 예제는 `java.sql.*`와 `java.time.OffsetDateTime`을 import한다. 미정 파라미터의 타입 힌트는 `SQLType`과 LocalDate·LocalTime·LocalDateTime·OffsetTime·OffsetDateTime을 지원한다. 소수 초는 최대 6자리, NUMERIC은 최대 38자리이며 알려진 서버 컬럼 타입을 바인딩 힌트로 덮어쓰지 않는다. 배치는 추가 당시의 값과 힌트를 함께 보관한다. `executeLargeBatch()` 부분 실패는 앞선 성공 행 수를 `getLargeUpdateCounts()`로 제공한다.

준비 문장은 세션당 64개·SQL 합계 16 MiB이며 Statement·Connection 종료 시 해제한다. 실행 중 close는 먼저 취소를 요청하고 정리한다. USE·객체 DDL로 무효화되어 `0A000`/8009가 오면 새 PreparedStatement를 만든다. 권한은 각 실행에서 검사하며 뷰만 허용된 사용자는 기반 테이블의 메타데이터를 얻을 수 없다. 커서와 준비 문장 ID의 수명은 독립이다.

선택 기능이 없는 서버에는 기존 실행을 유지한다. 실행 전 결과 메타데이터는 null, 파라미터 타입은 UNKNOWN이며 `cancel`·양수 질의 제한 시간으로 실행하면 `SQLFeatureNotSupportedException`(`0A000`)이다. 기능 협상과 취소 접수·최종 실행 결과의 구분은 [서버 프로토콜 17절](../rdbms/docs/protocol.md#17-준비-문장과-취소-2026-10-20-확장-규약)을 따른다.

## 공유와 검증 범위

프로토콜 원본은 `../jdbc6/src/.../jdbc6/protocol`이며 `npm run sync:protocol`로 패키지 선언만 바꾸어 복사한다. 빌드는 두 코드의 일치를 검사한다. JDBC 계층은 각 프로젝트의 Java API 기준에 맞게 별도로 유지한다. 서버·UDP 결함 주입 시험 도우미는 `scripts/test-support.mjs`를 공유한다.

2026-10-20 Windows에서 지정 Oracle JDK 8u202로 빌드한 같은 JAR을 Java 8u202·21.0.12.1에서 실행했다. Node.js 22.23.3 서버의 기존 130개·확장 50개·독립 소비자 6개가 모두 통과했다. 실제 JDK 6의 공유 코드 컴파일과 클래스 버전 52·프로토콜 동기화 검사도 통과했다. 2026-10-21에는 Linux JDK 8 빌드의 Java 8·21에서도 같은 자동 시험을 통과했고 DBeaver 26.0.5에서 등록·접속·객체/컬럼 탐색·뷰 조회·잠금 대기 취소와 연결 재사용을 확인하여 13-5를 마쳤다. macOS·실제 원격망·장시간 부하는 추가 범위이다. 자세한 기록은 [PROGRESS.md](PROGRESS.md)와 [Linux 검증 기록](../rdbms/docs/linux-verification.md)을 따른다.

`test:extensions`는 실행 없는 분석·힌트·반복 실행·해제·CPU/잠금 취소·질의 제한 시간·실행 중 close·구형 서버 호환을 TCP·TLS·UDP·유실/중복 UDP에서 시험한다. `test:consumer`는 저장소 시험 클래스를 제외하고 JAR만 복사한 앱을 실제 JDK 8로 컴파일하여 서비스 등록·접속·테이블/컬럼 메타데이터·JDBC4.2 바인딩을 확인한다.

기준 문서: [서버 프로토콜](../rdbms/docs/protocol.md), [타입 정책](../rdbms/docs/data-types.md), [Java 8 ResultSet API](https://docs.oracle.com/javase/8/docs/api/java/sql/ResultSet.html), [PreparedStatement API](https://docs.oracle.com/javase/8/docs/api/java/sql/PreparedStatement.html).
