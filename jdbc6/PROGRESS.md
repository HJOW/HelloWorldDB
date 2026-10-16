# jdbc6 진행 상황

HelloWorldDB용 JDBC 4.0 드라이버를 개발하는 프로젝트이다. 자바 6~7을 기본 대상으로 하며 같은 배포본을 자바 8 이상에서도 사용할 수 있어야 한다. 자바 5는 지원하지 않는다.
사양은 루트의 AGENTS.md 가 기준이다. 이 문서에는 세부 계획, 진행 상황, 인수인계 사항만 적는다.
아래의 단계 번호(14-1 등)는 보류 전 계획에서 쓰던 번호이다. "상세 N" 은 AGENTS.md "RDBMS 에 구현되어야 할 사항 (상세)" 의 N번 절을 가리킨다.

## 현재 상태

- 최종 갱신 : 2026-10-16
- 진행 단계 : 보류 (코드 없음)
- 확정된 지원 기준 : 자바 6 이상에서 실행 가능한 JDBC 4.0. 프로젝트·폴더는 `jdbc6`, 패키지는 `org.duckdns.hjow.helloworlddb.jdbc6`이다 (AGENTS.md 상세 8-1).
- 착수 조건 : `rdbms` 와 `nodejsDriver` 를 마친 뒤 계획부터 다시 정한다. 아래 세부 계획은 보류 전에 잡아 둔 초안이며 확정된 것이 아니므로 그대로 착수하지 않는다. 순서는 `jdbc8` 다음이다.
- 다음 작업 : 없음

## 작업 규칙

- 작업 항목을 끝내면 `[ ]` 를 `[x]` 로 바꾼다. 묶음이 끝나면 "현재 상태" 와 "작업 이력" 을 갱신한다.
- 사양에 없는 것을 새로 정했으면 "결정 사항" 에 적는다.

## 세부 계획 초안 (보류 전의 14단계)

### 14-1. 빌드와 시험 환경

- [ ] 자바 6 대상 빌드 환경을 준비한다 (초안 : JDK 8의 `-source 1.6 -target 1.6`). 자바 5용 결과물은 만들지 않는다
- [ ] 자바 6에 없는 API를 쓰면 빌드가 실패하게 한다. `-source`, `-target`만으로는 API를 제한하지 못하므로 자바 6의 `rt.jar`를 부트 클래스패스로 지정하거나 Animal Sniffer 등으로 검사한다
- [ ] 시험용 자바 6, 7, 8 이상 런타임을 준비한다. 같은 jar를 각 런타임에서 사용한다
- [ ] 옛 런타임에서 통합 테스트를 돌리는 방법을 마련한다. 빌드 도구는 옛 자바에서 돌지 않으므로, 만들어진 jar 와 테스트 클래스를 각 런타임의 `java` 로 직접 실행한다

### 14-2. 프로토콜 계층

- [ ] `jdbc8`의 프로토콜 계층을 가져온다. 공유 코드는 자바 6 문법·API 범위로 작성한다. 고칠 것이 나오면 `jdbc8`도 같이 고쳐 두 프로젝트의 코드를 같게 유지한다 (패키지 선언만 다르다)
- [ ] SSL : 런타임이 지원하는 프로토콜 중 가장 높은 버전을 사용한다. TLS 1.2를 지원하지만 기본으로 켜지 않은 런타임에서는 `setEnabledProtocols`로 켠다. TLS 1.2를 쓸 수 없는 자바 6 환경에서는 서버의 최소 버전을 낮춰 접속한다 (상세 8)

### 14-3. JDBC 구현 (JDBC 4.0)

- [ ] `jdbc8`의 JDBC 구현을 자바 6과 JDBC 4.0 범위로 옮긴다. `java.time`, JDBC 4.1·4.2 전용 타입과 API에 의존하지 않는다
- [ ] `META-INF/services/java.sql.Driver`로 드라이버를 자동 등록한다. `Class.forName`을 통한 명시적 로딩도 동작하게 한다
- [ ] `Connection.isValid`, `Statement.isClosed`, `unwrap`, `isWrapperFor` 등 JDBC 4.0 메서드를 구현한다. NCHAR·NVARCHAR는 서버의 UTF-8 문자 타입 규칙을 따른다
- [ ] `RowId`, `NClob`, `SQLXML`은 자바 6에 존재하는 JDBC 4.0 타입이지만, 해당 DB 기능은 초기 RDBMS의 지원 범위에 없으므로 미지원으로 처리한다
- [ ] 지원하지 않는 기능은 SQLSTATE `0A000`을 담은 `SQLFeatureNotSupportedException`으로 알린다
- [ ] 자바 7·8 이상에서 추가된 JDBC 메서드는 필요한 호환 처리를 마련한다. 기본 접속·질의·트랜잭션·메타데이터 사용 중 클래스 로딩 오류나 `AbstractMethodError`가 나지 않아야 한다
- [ ] `DatabaseMetaData.getJDBCMajorVersion()`과 `getJDBCMinorVersion()`은 실행 자바 버전과 무관하게 4와 0을 반환한다

### 14-4. 타입 대응

- [ ] `jdbc8/PROGRESS.md` 의 표를 따르되 `java.time` 타입은 뺀다
- [ ] `WITH TIME ZONE` 타입은 `Types.TIME`, `Types.TIMESTAMP` 로 알리고, 오프셋까지 필요하면 `getString` 으로 읽게 한다

### 14-5. 검증

- [ ] 자바 6, 7, 8 이상 각각에서 같은 jar로 통합 테스트 : TCP, UDP 로그인, 질의, 파라미터, 대량 결과, 트랜잭션, 오류
- [ ] JDBC 4.0 자동 등록, 연결 유효성, 래퍼, 메타데이터의 JDBC 버전(4.0), 미지원 기능의 오류를 확인한다
- [ ] SSL : TLS 1.2를 지원하는 환경은 서버 기본 설정으로, 지원하지 않는 자바 6 환경은 서버의 `tcp.ssl.minVersion`을 `TLSv1`로 낮추고 시험한다
- 완료 기준 : 자바 6, 7과 자바 8 이상에서 같은 배포본의 통합 테스트 통과. JDBC 4.0 메타데이터와 서버의 TLS 최소 버전을 낮춘 상태의 SSL 접속 포함.

## 자바 6 범위 주의 목록

자바 6에서 쓸 수 없는 것 중 실수하기 쉬운 것들이다. `jdbc8`의 공통 프로토콜 계층에도 똑같이 적용한다. `jdbc8`의 JDBC 4.2 구현에는 자바 8 API를 쓸 수 있다.

- 문법 (자바 7 이후) : try-with-resources, 다이아몬드(`<>`), 문자열 `switch`, 다중 `catch`
- 문법 (자바 8 이후) : 람다, 메서드 참조, 인터페이스의 default·static 메서드
- API (자바 7 이후) : `StandardCharsets`, `Objects`, `AutoCloseable`
- API (자바 8 이후) : `java.time`, `java.util.Base64`, `PBKDF2WithHmacSHA256`
- 자바 6에서 추가된 `@Override`의 인터페이스 구현 적용, `String.isEmpty()`, `String.getBytes(Charset)`, `new String(byte[], Charset)`, `Arrays.copyOf`, `ArrayDeque`, `IOException(Throwable)`는 사용할 수 있다
- 문자 인코딩은 `getBytes("UTF-8")` 또는 `Charset.forName("UTF-8")`을 쓴다. `StandardCharsets.UTF_8`에 의존하지 않는다
- 기술 근거 : [Java 6 JDBC API](https://docs.oracle.com/javase/6/docs/api/java/sql/package-summary.html), [Java 6 String API](https://docs.oracle.com/javase/6/docs/api/java/lang/String.html), [JDK 8 javac 교차 컴파일](https://docs.oracle.com/javase/8/docs/technotes/tools/windows/javac.html)

## 미결 사항

- 빌드용 JDK와 시험용 자바 6, 7, 8 이상 런타임을 어떻게 마련할지 (보류 해제 때 확인). 자바 5 환경은 필요 없다
- 서버가 구버전 TLS 접속을 실제로 받아 주는지. 최신 Node.js 의 OpenSSL 은 TLS 1.0 을 쓰려면 최소 버전 외에 보안 수준 설정도 낮춰야 할 수 있다. 14-5 에서 실제 접속으로 확인하고, 서버 쪽 수정이 필요하면 `rdbms/PROGRESS.md` 에 적는다
- 자바 6 환경이 받아들이는 서버 인증서와 암호 스위트의 범위. 시험에는 RSA 인증서를 쓴다

## 결정 사항

- 사용자 결정(2026-10-16) : 자바 5 지원을 철회하고 프로젝트·폴더·패키지 이름을 `jdbc6` 기준으로 변경했다. JDBC 인터페이스 기준은 4.0이며 자바 6~7뿐 아니라 자바 8 이상에서도 같은 배포본을 사용할 수 있어야 한다.
- SSL 접속 시 서버 인증서는 기본으로 검증한다. 인증서 오류 때 접속을 끊고 100 ms 뒤 최대 2회 다시 시도한다 (AGENTS.md 상세 8, 사용자 결정 2026-10-15). 자바 6의 인증서 검증 범위는 미결 사항의 확인 항목과 함께 본다.

## 인수인계 사항

- 프로토콜 계층의 코드는 패키지 선언 외에는 `jdbc8` 과 같게 유지한다. 한쪽을 고치면 다른 쪽도 고친다.
- 자바 패키지 이름은 `org.duckdns.hjow.helloworlddb.jdbc6`이다 (AGENTS.md 지켜야 할 사항 6). JDBC URL 형식은 `jdbc8`에서 정한 것을 그대로 쓴다.
- TLS 1.2를 쓸 수 없는 자바 6 환경에서 SSL을 쓰려면 서버 관리자가 TLS 최소 버전을 낮춰야 한다는 점을 사용 설명서에 적는다.
- DECIMAL/DEC/NUMERIC의 선언 인자를 모두 생략하면 (10,3), VARCHAR/NVARCHAR의 최대·기본 길이는 65,535이다. `jdbc8`과 같이 실제 컬럼 길이/정밀도/소수 자릿수는 서버 메타데이터를 따른다. [rdbms 타입 정책](../rdbms/docs/data-types.md)을 참고한다.

## 작업 이력

- 2026-10-08 : 세부 계획 작성.
- 2026-10-08 : 보류로 전환. 세부 계획은 초안으로 남김. 자바 패키지 이름 확정.
- 2026-10-08 : 변경된 타입 기본값과 메타데이터 사용 규칙을 인수인계에 반영했다. 개발은 계속 보류한다.
- 2026-10-16 : 자바 5 지원 철회, 프로젝트·폴더·패키지 이름을 `jdbc6`으로 변경, JDBC 4.0 기준과 자바 8 이상 실행 호환을 반영했다. 빌드·공통 코드·자동 등록·예외·타입·TLS·검증 초안을 자바 6 기준으로 정리했다. 개발 보류는 유지한다.
