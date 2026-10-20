# HelloWorldDB JDBC 4.0 드라이버

자바 6~7용 드라이버이며 같은 JAR을 자바 8 이상에서도 사용할 수 있도록 개발한다.
패키지는 `org.duckdns.hjow.helloworlddb.jdbc6`이다.

현재는 **14-1 ~ 14-4**를 구현했다. TCP·TLS·UDP 통신, SCRAM 인증, JDBC 4.0 인터페이스·자동 등록과 타입 변환을 제공한다. 같은 Java 6 JAR을 Java 6·7·8·21에서 검증했다.
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
| `HWDB_JAVA8_HOME` | 자바 8 시험용 JDK 또는 JRE. Windows 기본 후보는 `C:\Program Files\Java\jdk8u432-b06` |
| `HWDB_JAVA21_HOME` | 자바 21 시험용 JDK 또는 JRE. Windows 기본 후보는 `C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot` |
| `HWDB_TEST_JAVA_HOMES` | 추가 시험용 JDK/JRE 목록. Windows에서는 `;`, 그 외에는 `:`로 구분 |

예를 들어 다른 장비에서는 설치 경로를 환경 변수로 지정한다.

```sh
HWDB_JAVA6_HOME=/opt/jdk6 HWDB_JAVA7_HOME=/opt/jdk7 HWDB_JAVA8_HOME=/opt/jdk8 npm run test:matrix
```

시험은 기본값 PATH의 컴파일러를 사용하지 않는다. 자바 7 전용 클래스, 자바 8 전용 메서드, JDBC 4.1 전용 메서드와 자바 7 문법이 실제로 컴파일에 실패하는지도 확인한다.
`npm run test:integration`은 같은 JAR과 Java 6으로 컴파일한 시험 클래스의 main을 Java 6·7·8·21에서 실행한다. 이 명령은 네 런타임 모두 필요하며, 서버를 매번 다시 빌드하고 임시 설치·데이터 디렉토리와 빈 포트로 띄운 뒤 정상 종료·정리한다. `../rdbms/node_modules`가 준비되어 있어야 한다. Node.js `24.19.0` 서버에서 단위·실제 서버 시험 200개와 기존 빌드 시험 14개가 통과했다.

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

TLS는 런타임이 지원하는 TLS 프로토콜을 켜서 협상한다. 서버 인증서는 기본으로 체인·기간·호스트 이름을 검증하며 인증서 오류에만 100 ms 뒤 최대 두 번 재시도한다. TLS 1.2를 지원하지 않는 이 PC의 Java 6은 서버 `tcp.ssl.minVersion`을 `TLSv1`로 낮춰 접속을 확인했다. Java 7·8·21은 서버 기본 최소 TLSv1.2로 통과했다. 서버 코드를 바꿀 필요는 없었다.

## JDBC 4.0과 타입

Connection·Statement·PreparedStatement·ResultSet과 세 종류의 메타데이터를 제공한다. 자동 커밋·커밋·롤백·세이브포인트, READ COMMITTED, 파라미터 바인딩·배치, fetch 단위 전진·읽기 전용 결과와 홀더블 커서를 지원한다. SYSTEM 딕셔너리의 권한 필터를 이용하며 테이블스페이스는 스키마로 보여 준다. JDBC 버전은 어느 런타임에서도 4.0이다. 미지원 기능은 `SQLFeatureNotSupportedException`과 `0A000`이다. 전체 JDBC 적합성을 선언하지 않는다.

기본 타입은 jdbc8의 표에서 java.time만 제외한 대응이다. CHAR/VARCHAR는 String, 이진 값은 byte[], SMALLINT/INTEGER는 Integer, BIGINT는 Long, NUMERIC/DECIMAL은 BigDecimal, REAL은 Float, DOUBLE은 Double, BOOLEAN은 Boolean, INTERVAL은 String이다. DATE·TIME·TIMESTAMP는 java.sql.Date·Time·Timestamp를 사용한다. java.sql.Time은 소수 초를 담지 못하므로 원문이 필요하면 getString으로 읽는다.

WITH TIME ZONE 타입은 JDBC 4.0에 맞게 Types.TIME·Types.TIMESTAMP로 보고한다. typeName·getString에는 오프셋을 보존하며 일반 Time/Timestamp getter는 입력 오프셋을 반영한 시점을 반환한다. Calendar 오버로드는 해당 타임존의 필드를 사용한다. java.time·SQLType 바인딩은 제공하지 않는다. 실제 길이·precision·scale은 서버 메타데이터를 따르고 NUMERIC(12)는 (12,0)을 유지한다.

동적 프록시로 JDBC 인터페이스를 제공하므로 상위 런타임에서 추가된 메서드도 클래스 로딩 오류나 AbstractMethodError 없이 처리한다. `getSchema`, `setSchema`, `closeOnCompletion`, large count 등 가능한 호환 메서드는 구현하고 JDBC 4.2 SQLType과 지원하지 않는 기능은 0A000이다.

서버에 describe 요청이 없어 실행 전 PreparedStatement.getMetaData()는 null이다. ParameterMetaData는 개수·IN 모드와 UNKNOWN 타입을 제공한다. 결과의 기반 테이블·NULL 허용 여부를 추정하지 않는다. 뷰 컬럼은 SELECT 권한이 있을 때 WHERE 1 = 0의 메타데이터로 보완한다. 응답 시간 초과는 SQLTimeoutException(`08006`/8006)이며 연결을 닫는다. LOB·배열·CallableStatement·생성 키·갱신/스크롤 ResultSet·cancel은 미지원이다.

프로토콜 원본은 이 프로젝트의 `src/.../protocol`이며 jdbc8의 `npm run sync:protocol`로 패키지 선언만 바꾸어 공유한다. JDBC 계층은 Java 6·8 API 기준에 맞게 각각 유지한다. 시험 서버 도우미는 `../jdbc8/scripts/test-support.mjs`를 공유한다.

후속 14-5의 독립 배포 소비자와 최종 검증, 다른 OS 시험은 남아 있다. 이번 시험은 14-4까지의 구현 검증이며 세부 결과는 [PROGRESS.md](PROGRESS.md)에 기록했다.
