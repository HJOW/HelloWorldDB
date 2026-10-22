# HelloWorldDB JDBC 4.0 드라이버

자바 6~7용 드라이버이며 같은 JAR을 자바 8 이상에서도 사용할 수 있도록 개발한다.
패키지는 `org.duckdns.hjow.helloworlddb.jdbc6`이다.

**14-1 ~ 14-5**와 서버 prepare/describe·cancel 연동을 완료했다. TCP·TLS·UDP 통신, SCRAM 인증, JDBC 4.0·자동 등록·타입 변환과 실행 전 메타데이터·요청별 취소·질의 제한 시간을 제공한다. 같은 Java 6 JAR을 Java 6·7·8·21·25에서 검증했다.
자세한 진행 상황과 다음 작업은 [PROGRESS.md](PROGRESS.md)에 기록한다.

## 빌드

외부 라이브러리와 Maven·Gradle 없이 **JDK 6**의 `javac`, `jar`로 만든다. 빌드·시험 실행기는 Node.js 22 이상을 사용하며, JAR 실행에는 Node.js가 필요하지 않다. `npm install`도 필요하지 않다.

`jdbc6` 디렉토리에서 실행한다.

```powershell
$env:HWDB_JAVA6_HOME = "C:\Program Files\Java\jdk1.6.0_45"
$env:HWDB_JAVA7_HOME = "C:\Program Files\Java\jdk1.7.0_80"
npm.cmd run build
npm.cmd test
npm.cmd run test:matrix
npm.cmd run test:integration
npm.cmd run test:extensions
npm.cmd run test:consumer
```

자바 6 문법·바이트코드뿐 아니라 **API도 실제 JDK 6으로 제한**한다. 최신 JDK의 `-source`, `-target`만 지정하는 방식은 사용하지 않는다.
소스는 UTF-8로 읽고 생성한 `.class`의 버전이 50인지 검사한다. JDK 6이 아닌 컴파일러를 지정하면 실패한다.

- `src/` : 자바 소스. 기존 Eclipse 프로젝트 설정의 경로를 따른다.
- `test/` : 자바 6으로 컴파일하는 시험 클래스. 배포 JAR에 포함하지 않는다.
- `build/` : 클래스, 소스 목록과 임시 시험 자료.
- `dist/org.duckdns.hjow.helloworlddb.jdbc6-0.1.0.jar` : 배포 JAR.

빌드가 지우고 다시 만드는 경로는 `build/`, `dist/`뿐이다. Eclipse의 `bin/`은 사용하지 않는다.

## 자바 버전별 시험

`npm test`는 발견한 런타임으로 같은 배포 JAR과 시험 클래스를 실행한다. Java 6·7·8 중 없는 환경은 건너뛴 것으로 표시한다.
`npm run test:matrix`는 세 버전 중 하나라도 없으면 실패한다. PATH의 `java`와 `JAVA_HOME`도 추가로 시험한다.

| 환경 변수 | 용도 |
|---|---|
| `HWDB_JAVA6_HOME` | 빌드와 자바 6 시험에 사용하는 JDK. Windows 기본 후보는 `C:\Program Files\Java\jdk1.6.0_45` |
| `HWDB_JAVA7_HOME` | 자바 7 시험용 JDK 또는 JRE. Windows 기본 후보는 `C:\Program Files\Java\jdk1.7.0_80` |
| `HWDB_JAVA8_HOME` | 자바 8 시험용 JDK 또는 JRE. Windows 기본 후보는 `C:\Program Files\Java\jdk1.8.0_202` |
| `HWDB_JAVA21_HOME` | 자바 21 시험용 JDK 또는 JRE. Windows 기본 후보는 `C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot` |
| `HWDB_TEST_JAVA_HOMES` | 추가 시험용 JDK/JRE 목록. Windows에서는 `;`, 그 외에는 `:`로 구분 |

예를 들어 다른 장비에서는 설치 경로를 환경 변수로 지정한다.

```sh
HWDB_JAVA6_HOME=/opt/jdk6 HWDB_JAVA7_HOME=/opt/jdk7 HWDB_JAVA8_HOME=/opt/jdk8 npm run test:matrix
```

시험은 기본값 PATH의 컴파일러를 사용하지 않는다. 자바 7 전용 클래스, 자바 8 전용 메서드, JDBC 4.1 전용 메서드와 자바 7 문법이 실제로 컴파일에 실패하는지도 확인한다.
`npm run test:integration`은 같은 JAR과 Java 6으로 컴파일한 시험 클래스의 main을 Java 6·7·8·21과 추가로 발견한 런타임에서 실행한다. 앞의 네 런타임은 모두 필요하다. 서버를 매번 다시 빌드하고 임시 설치·데이터 디렉토리와 빈 포트로 띄운 뒤 정상 종료·정리한다. `../rdbms/node_modules`가 준비되어 있어야 한다. 최신 Node.js 22.23.3 서버와 Java 6·7·8·21·25에서 단위·실제 서버 시험 255개와 빌드 시험 15개가 통과했다.

`VM-W11-Codex`의 자바 7은 설치된 `C:\Program Files\Java\jdk1.7.0_80`을 사용한다.
`java -version`과 `javac -version`에서 모두 `1.7.0_80`을 확인했다. 빌드·시험 명령은 JDK를 내려받지 않는다.

## 접속

클래스는 `org.duckdns.hjow.helloworlddb.jdbc6.Driver`이며 JAR의 서비스 등록으로 자동 로딩된다. `Class.forName`도 지원한다. jdbc6와 jdbc8의 URL은 같으므로 앱의 클래스 경로에는 사용할 드라이버의 JAR 하나를 둔다.

```java
Properties options = new Properties();
options.setProperty("user", "SYSTEM");
options.setProperty("password", "HelloWorldDB");
Connection connection = DriverManager.getConnection(
    "jdbc:helloworlddb://127.0.0.1:7410", options);
try {
    Statement statement = connection.createStatement();
    try {
        ResultSet rows = statement.executeQuery("SELECT 'Hello World' AS MESSAGE");
        try {
            while (rows.next()) System.out.println(rows.getString("MESSAGE"));
        } finally { rows.close(); }
    } finally { statement.close(); }
} finally { connection.close(); }
```

위 예제에는 `java.sql.*`, `java.util.Properties` import가 필요하다. URL과 공통 속성은 [jdbc8 README의 접속 절](../jdbc8/README.md#접속)을 따른다. 형식은 `jdbc:helloworlddb://호스트[:포트][?옵션]`이며 SID·DB 이름·경로는 없다. 현재 테이블스페이스는 `tablespace` 속성으로 지정한다. TCP가 기본이고 `transport=udp` 또는 `ssl=true`·`sslCa`를 선택할 수 있다.

TLS는 `sslMinVersion`(기본 `TLSv1.2`) 이상의 프로토콜만 켜서 협상한다. Java 6에는 TLSv1.2가 없으므로 그 런타임에서는 `sslMinVersion=TLSv1`을 명시해야 한다(2026-10-22 점검 J-6). 서버 인증서는 기본으로 체인·기간·호스트 이름을 검증하며 인증서 오류에만 100 ms 뒤 최대 두 번 재시도한다. TLS 1.2를 지원하지 않는 이 PC의 Java 6은 서버 `tcp.ssl.minVersion`을 `TLSv1`로 낮춰 접속을 확인했다. Java 7·8·21은 서버 기본 최소 TLSv1.2로 통과했다. 서버 코드를 바꿀 필요는 없었다.

## JDBC 4.0과 타입

Connection·Statement·PreparedStatement·ResultSet과 세 종류의 메타데이터를 제공한다. 자동 커밋·커밋·롤백·세이브포인트, READ COMMITTED, 파라미터 바인딩·배치, fetch 단위 전진·읽기 전용 결과와 홀더블 커서를 지원한다. SYSTEM 딕셔너리의 권한 필터를 이용하며 테이블스페이스는 스키마로 보여 준다. JDBC 버전은 어느 런타임에서도 4.0이다. 미지원 기능은 `SQLFeatureNotSupportedException`과 `0A000`이다. 전체 JDBC 적합성을 선언하지 않는다.

기본 타입은 jdbc8의 표에서 java.time만 제외한 대응이다. CHAR/VARCHAR는 String, 이진 값은 byte[], SMALLINT/INTEGER는 Integer, BIGINT는 Long, NUMERIC/DECIMAL은 BigDecimal, REAL은 Float, DOUBLE은 Double, BOOLEAN은 Boolean, INTERVAL은 String이다. DATE·TIME·TIMESTAMP는 java.sql.Date·Time·Timestamp를 사용한다. java.sql.Time은 소수 초를 담지 못하므로 원문이 필요하면 getString으로 읽는다.

WITH TIME ZONE 타입은 JDBC 4.0에 맞게 Types.TIME·Types.TIMESTAMP로 보고한다. typeName·getString에는 오프셋을 보존하며 일반 Time/Timestamp getter는 입력 오프셋을 반영한 시점을 반환한다. Calendar 오버로드는 해당 타임존의 필드를 사용한다. java.time·SQLType 바인딩은 제공하지 않는다. 실제 길이·precision·scale은 서버 메타데이터를 따르고 NUMERIC(12)는 (12,0)을 유지한다.

동적 프록시로 JDBC 인터페이스를 제공하므로 상위 런타임에서 추가된 메서드도 클래스 로딩 오류나 AbstractMethodError 없이 처리한다. `getSchema`, `setSchema`, `closeOnCompletion`, large count 등 가능한 호환 메서드는 구현하고 JDBC 4.2 SQLType과 지원하지 않는 기능은 0A000이다.

서버가 `prepareDescribe`를 광고하면 PreparedStatement를 서버에 준비하고, `getMetaData()`·`getParameterMetaData()`는 실행 전에 결과 컬럼·파라미터 타입을 제공한다. DML·DDL을 분석해도 실행하거나 진행 중인 트랜잭션을 자동 커밋하지 않는다. 미정 타입은 `Types.OTHER`·`UNKNOWN`, 미정 길이·정밀도는 0으로 보존한다. 알려진 컬럼 문맥을 우선하고 미정 자리는 바인딩 타입 힌트로 보완한다. NULL 허용 여부·기반 테이블을 임의로 추정하지 않는다. 뷰 컬럼은 서버 SYS_COLUMNS를 먼저 읽고 빠진 객체만 기존 조회로 보완한다.

```java
PreparedStatement statement = connection.prepareStatement(
    "SELECT CAST(? AS DECIMAL(12,0)) AS N");
try {
    ResultSetMetaData columns = statement.getMetaData(); // 실행 없이 정밀도 12
    statement.setBigDecimal(1, new java.math.BigDecimal("12345678901"));
    statement.setQueryTimeout(3);
    ResultSet rows = statement.executeQuery();
    try { while (rows.next()) System.out.println(rows.getBigDecimal(1)); }
    finally { rows.close(); }
} finally { statement.close(); }
```

`Statement.cancel()`은 같은 문장을 실행하는 동안 다른 스레드에서 호출할 수 있다. 단일 수신 경로가 실행 응답과 취소 응답을 요청 ID로 구분한다. 사용자 취소는 `57014`이며 앞선 수동 트랜잭션 변경과 연결은 유지한다. `setQueryTimeout()`은 서버 취소를 요청하고 실제 취소 오류가 오면 `SQLTimeoutException`(`57014`/8010)이다. 확정 단계의 늦은 취소는 정상 완료와 경합할 수 있다. 통신 응답 시간 초과는 별도로 `SQLTimeoutException`(`08006`/8006)을 내고 연결을 닫는다. 결과를 모르는 DML은 자동 재실행하지 않는다.

준비 문장은 세션당 64개·SQL 합계 16 MiB이며 문장·연결 종료로 해제한다. 실행 중 문장을 닫으면 먼저 취소를 요청하고 정리한다. USE·객체 DDL 뒤 서버가 `0A000`/8009를 반환하면 새 PreparedStatement를 만든다. 열려 있는 결과 커서와 준비 문장 ID는 서로 다르다. 서버가 선택 기능을 광고하지 않으면 기존 실행을 유지하고 실행 전 결과 메타데이터는 null·파라미터 타입은 UNKNOWN이다. 그 서버의 cancel·질의 제한 시간은 명시적인 `SQLFeatureNotSupportedException`(`0A000`)이다.

동작 기준은 Java 6의 [PreparedStatement](https://docs.oracle.com/javase/6/docs/api/java/sql/PreparedStatement.html)와 [Statement](https://docs.oracle.com/javase/6/docs/api/java/sql/Statement.html), 메시지 규약은 [서버 프로토콜 17절](../rdbms/docs/protocol.md#17-준비-문장과-취소-2026-10-20-확장-규약)이다. LOB·배열·CallableStatement·생성 키·갱신/스크롤 ResultSet은 계속 미지원이다.

프로토콜 원본은 이 프로젝트의 `src/.../protocol`이며 jdbc8의 `npm run sync:protocol`로 패키지 선언만 바꾸어 공유한다. JDBC 계층은 Java 6·8 API 기준에 맞게 각각 유지한다. 시험 서버 도우미는 `../jdbc8/scripts/test-support.mjs`를 공유한다.

`npm run test:extensions`는 준비·설명·반복 실행·해제·타입 힌트·CPU/잠금 대기 취소·질의 제한 시간·실행 중 close·기능 없는 서버 fallback을 TCP·TLS·UDP·유실/중복 UDP에서 검증한다. `HWDB_JDBC_TEST_MAJORS=6`처럼 지정하면 집중 시험을 할 수 있으며 최종 회귀에는 모든 지원 런타임을 사용한다. `test:consumer`는 저장소 시험 클래스 없이 JAR만 복사한 별도 앱을 JDK 6으로 컴파일해 TCP·UDP·TLS로 실행한다.

2026-10-20 Windows / Node.js 22.23.3에서 사용자 지정 Oracle JDK 6u45·7u80과 Java 8u504·21.0.12.1·25를 사용했다. 같은 배포 JAR의 기존 서버 시험 255개, 확장 85개, 빌드 행렬 15개, 독립 소비자 15개가 모두 통과했다. 다른 OS와 장시간 원격 부하는 추가 검증 범위이다.
