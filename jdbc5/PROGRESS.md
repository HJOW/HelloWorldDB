# jdbc5 진행 상황

HelloWorldDB 용 JDBC 드라이버(자바 5 ~ 7)를 개발하는 프로젝트이다.
사양은 루트의 AGENTS.md 가 기준이다. 이 문서에는 세부 계획, 진행 상황, 인수인계 사항만 적는다.
아래의 단계 번호(14-1 등)는 보류 전 계획에서 쓰던 번호이다. "상세 N" 은 AGENTS.md "RDBMS 에 구현되어야 할 사항 (상세)" 의 N번 절을 가리킨다.

## 현재 상태

- 최종 갱신 : 2026-10-08
- 진행 단계 : 보류 (코드 없음)
- 착수 조건 : `rdbms` 와 `nodejsDriver` 를 마친 뒤 계획부터 다시 정한다. 아래 세부 계획은 보류 전에 잡아 둔 초안이며 확정된 것이 아니므로 그대로 착수하지 않는다. 순서는 `jdbc8` 다음이다.
- 다음 작업 : 없음

## 작업 규칙

- 작업 항목을 끝내면 `[ ]` 를 `[x]` 로 바꾼다. 묶음이 끝나면 "현재 상태" 와 "작업 이력" 을 갱신한다.
- 사양에 없는 것을 새로 정했으면 "결정 사항" 에 적는다.

## 세부 계획 초안 (보류 전의 14단계)

### 14-1. 빌드와 시험 환경

- [ ] 빌드용 JDK 8 을 준비한다. `-source 1.5 -target 1.5` 는 JDK 8 까지만 받고 JDK 9 부터는 받지 않는다
- [ ] 자바 5 에 없는 API 를 쓰면 빌드가 실패하게 한다. `-source`, `-target` 만으로는 잡히지 않으므로, 자바 5 의 `rt.jar` 를 부트 클래스패스로 주거나 Animal Sniffer 로 API 를 검사한다
- [ ] 시험용 자바 5, 6, 7 런타임을 준비한다
- [ ] 옛 런타임에서 통합 테스트를 돌리는 방법을 마련한다. 빌드 도구는 옛 자바에서 돌지 않으므로, 만들어진 jar 와 테스트 클래스를 각 런타임의 `java` 로 직접 실행한다

### 14-2. 프로토콜 계층

- [ ] `jdbc8` 의 프로토콜 계층을 가져온다. `jdbc8` 에서 자바 5 범위로 작성했으므로 고칠 것이 없어야 한다. 고칠 것이 나오면 `jdbc8` 도 같이 고쳐 두 프로젝트의 코드를 같게 유지한다 (패키지 선언만 다르다)
- [ ] SSL : 런타임이 지원하는 프로토콜 중 가장 높은 버전까지 켠다. 자바 7 은 TLS 1.2 를 지원하지만 기본으로 꺼져 있으므로 `setEnabledProtocols` 로 켠다. 자바 5, 6 은 TLS 1.0 까지만 지원한다 (상세 8)

### 14-3. JDBC 구현 (JDBC 3.0)

- [ ] `jdbc8` 의 JDBC 구현을 JDBC 3.0 범위로 옮긴다. 자바 5 에 없는 타입(`RowId`, `NClob`, `SQLXML`, `SQLFeatureNotSupportedException` 등)과 `java.time` 을 쓰지 않는다
- [ ] 드라이버 클래스의 정적 초기화에서 `DriverManager.registerDriver` 를 호출한다. 자바 5 에는 드라이버 자동 등록이 없어 사용자가 `Class.forName` 으로 불러야 한다. 자바 6, 7 을 위해 `META-INF/services/java.sql.Driver` 도 넣는다
- [ ] 자바 6, 7 런타임의 JDBC 인터페이스에는 메소드가 더 있다. 그중 자바 5 타입만으로 선언할 수 있는 것(`Connection.isValid`, `Statement.isClosed`, `unwrap`, `isWrapperFor` 등)은 같은 시그니처로 구현해 둔다. 구현하지 않은 메소드가 불리면 `AbstractMethodError` 가 난다
- [ ] 지원하지 않는 기능은 SQLSTATE `0A000` 을 담은 `SQLException` 으로 알린다

### 14-4. 타입 대응

- [ ] `jdbc8/PROGRESS.md` 의 표를 따르되 `java.time` 타입은 뺀다
- [ ] `WITH TIME ZONE` 타입은 `Types.TIME`, `Types.TIMESTAMP` 로 알리고, 오프셋까지 필요하면 `getString` 으로 읽게 한다

### 14-5. 검증

- [ ] 자바 5, 6, 7 각각에서 통합 테스트 : TCP, UDP 로 로그인, 질의, 파라미터, 대량 결과, 트랜잭션, 오류
- [ ] SSL : 자바 7 은 서버 기본 설정(TLS 1.2)으로, 자바 5, 6 은 서버의 `tcp.ssl.minVersion` 을 `TLSv1` 로 낮추고 시험한다
- 완료 기준 : 자바 5, 6, 7 런타임 각각에서 통합 테스트 통과. 서버의 TLS 최소 버전을 낮춘 상태의 SSL 접속 포함.

## 자바 5 범위 주의 목록

자바 5 에서 쓸 수 없는 것 중 실수하기 쉬운 것들이다. `jdbc8` 의 프로토콜 계층에도 똑같이 적용한다.

- 문법 (자바 7 이후) : try-with-resources, 다이아몬드(`<>`), 문자열 `switch`, 다중 `catch`, 람다
- 문법 (자바 6 이후) : 인터페이스 메소드를 구현한 곳에 붙이는 `@Override`
- API (자바 6 이후) : `String.isEmpty()`, `String.getBytes(Charset)`, `new String(byte[], Charset)`, `Arrays.copyOf`, `ArrayDeque`, `IOException(Throwable)`
- API (자바 7 이후) : `StandardCharsets`, `Objects`, `AutoCloseable`
- API (자바 8 이후) : `java.time`, `java.util.Base64`, `PBKDF2WithHmacSHA256`
- 문자 인코딩은 `getBytes("UTF-8")` 처럼 이름으로 지정한다

## 미결 사항

- 빌드용 JDK 8 과 시험용 자바 5, 6, 7 런타임을 어떻게 마련할지 (사용자 확인 필요). 특히 자바 5 런타임은 구하기 어려울 수 있다
- 서버가 구버전 TLS 접속을 실제로 받아 주는지. 최신 Node.js 의 OpenSSL 은 TLS 1.0 을 쓰려면 최소 버전 외에 보안 수준 설정도 낮춰야 할 수 있다. 14-5 에서 실제 접속으로 확인하고, 서버 쪽 수정이 필요하면 `rdbms/PROGRESS.md` 에 적는다
- 자바 5, 6 이 받아들이는 서버 인증서와 암호 스위트의 범위. 시험에는 RSA 인증서를 쓴다

## 결정 사항

아직 없음.

## 인수인계 사항

- 프로토콜 계층의 코드는 패키지 선언 외에는 `jdbc8` 과 같게 유지한다. 한쪽을 고치면 다른 쪽도 고친다.
- 자바 패키지 이름은 `org.duckdns.hjow.helloworlddb.jdbc5` 이다 (AGENTS.md 지켜야 할 사항 6). JDBC URL 형식은 `jdbc8` 에서 정한 것을 그대로 쓴다.
- 자바 5, 6 사용자가 SSL 을 쓰려면 서버 관리자가 TLS 최소 버전을 낮춰야 한다는 점을 사용 설명서에 적는다.

## 작업 이력

- 2026-10-08 : 세부 계획 작성.
- 2026-10-08 : 보류로 전환. 세부 계획은 초안으로 남김. 자바 패키지 이름 확정.
