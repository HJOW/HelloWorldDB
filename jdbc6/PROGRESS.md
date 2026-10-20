# jdbc6 진행 상황

HelloWorldDB용 JDBC 4.0 드라이버를 개발하는 프로젝트이다. 자바 6~7을 기본 대상으로 하며 같은 배포본을 자바 8 이상에서도 사용할 수 있어야 한다. 자바 5는 지원하지 않는다.
사양은 루트의 AGENTS.md 가 기준이다. 이 문서에는 세부 계획, 진행 상황, 인수인계 사항만 적는다.
단계 번호(14-1 등)는 기존 14단계의 번호를 유지한다. 사용자의 2026-10-20 작업 지시에 따라 빌드와 시험 기반부터 착수했다. "상세 N" 은 AGENTS.md "RDBMS 에 구현되어야 할 사항 (상세)" 의 N번 절을 가리킨다.

## 현재 상태

- 최종 갱신 : 2026-10-20
- 진행 단계 : **14-1 빌드와 시험 환경 완료**. JDK 6으로 JAR을 만들고 같은 배포본을 자바 6·7·8·21로 실행하는 기반을 구현했다. 아직 DB 접속·JDBC 인터페이스 구현은 없다.
- 확정된 지원 기준 : 자바 6 이상에서 실행 가능한 JDBC 4.0. 프로젝트·폴더는 `jdbc6`, 패키지는 `org.duckdns.hjow.helloworlddb.jdbc6`이다 (AGENTS.md 상세 8-1).
- 착수 조건 : `rdbms`와 `nodejsDriver` 완료 및 사용자 작업 지시로 충족했다. `jdbc6`를 먼저 구현하고, `jdbc8`은 착수 시 공통 코드를 공유한다. `jdbc8`과 GUI의 보류는 유지한다.
- 최종 검증 : 2026-10-20, Windows / `VM-W11-Codex`, Node.js 22.23.3. `npm run test:matrix` **14개 통과·실패 0·건너뜀 0**. JDK 6 `1.6.0_45`, JDK 7 `1.7.0_80`, Temurin 8 `1.8.0_432`, Temurin 21 `21.0.12.1`을 사용했다.
- 다음 작업 : **14-2 프로토콜 계층**. `rdbms/docs/protocol.md`를 기준으로 JSON·프레임·SCRAM·TCP·TLS·UDP를 구현하고 실제 서버에 접속하는 시험을 추가한다.

## 작업 규칙

- 작업 항목을 끝내면 `[ ]` 를 `[x]` 로 바꾼다. 묶음이 끝나면 "현재 상태" 와 "작업 이력" 을 갱신한다.
- 사양에 없는 것을 새로 정했으면 "결정 사항" 에 적는다.

## 설치된 자바 6 환경

- 장비 : `VM-W11-Codex`
- JDK 설치 경로 : `C:\Program Files\Java\jdk1.6.0_45`
- 실행 파일 : `C:\Program Files\Java\jdk1.6.0_45\bin\java.exe`
- 컴파일러 : `C:\Program Files\Java\jdk1.6.0_45\bin\javac.exe`
- 확인일 : 2026-10-20. `java -version`과 `javac -version`이 모두 `1.6.0_45`를 반환하며, 런타임은 64비트이다.

PowerShell에서 기본 PATH의 자바와 구분하여 실행한다.

```powershell
& "C:\Program Files\Java\jdk1.6.0_45\bin\java.exe" -version
& "C:\Program Files\Java\jdk1.6.0_45\bin\javac.exe" -version
```

### 같은 장비의 자바 7 환경

- JDK 설치 경로 : `C:\Program Files\Java\jdk1.7.0_80`
- 실행 파일 : `C:\Program Files\Java\jdk1.7.0_80\bin\java.exe`
- 컴파일러 : `C:\Program Files\Java\jdk1.7.0_80\bin\javac.exe`
- 2026-10-20 확인 : 실행 환경과 컴파일러가 모두 `1.7.0_80`이며 런타임은 64비트이다.
- 사용자 지정에 따라 이 설치본을 자바 7 호환성 시험에 사용한다. `HWDB_JAVA7_HOME`으로 지정할 수 있으며 이 PC에서는 위 경로가 기본 후보이다.

### 같은 장비의 자바 8 환경

- JDK 설치 경로 : `C:\Program Files\Java\jdk8u432-b06`
- 실행 파일 : `C:\Program Files\Java\jdk8u432-b06\bin\java.exe`
- 컴파일러 : `C:\Program Files\Java\jdk8u432-b06\bin\javac.exe`
- 2026-10-20 확인 : Temurin OpenJDK `1.8.0_432-b06`(64비트), 컴파일러 `javac 1.8.0_432`이다.
- `jdbc6`의 자바 8 실행 호환성 시험과 향후 `jdbc8` 개발에 사용한다. 시험 실행기에 `HWDB_JAVA8_HOME`으로 지정할 수 있으며 이 PC에서는 위 경로를 기본 후보로 찾는다. `jdbc6` 소스의 컴파일은 계속 JDK 6으로 한다.

초기 시험용으로 내려받은 Azul 배포본은 더 이상 사용하지 않는다. 삭제 대상은 `H:\Workspace\git\HelloWorldDB\jdbc6\.tools\java7\zulu7.56.0.11-ca-jdk7.0.352-win_x64`이다. 해당 디렉토리의 삭제 명령이 자동 승인 검토에서 `blocked by policy`로 차단되어 사용자가 직접 삭제하기로 했다. ZIP 파일은 앞선 압축 해제 작업에서 이미 삭제했다.
현재 PATH의 자바 21도 함께 시험했다. 서버 접속·TLS·JDBC 통합 시험은 14-2 이후에 수행한다.

## 세부 계획 (14단계)

### 14-1. 빌드와 시험 환경

- [x] 실제 JDK 6의 `javac`·`jar`로 UTF-8 소스를 컴파일·패키징한다. 생성 클래스의 버전은 50이다. 외부 라이브러리와 Maven·Gradle은 사용하지 않는다
- [x] 자바 6의 실제 API로 컴파일하여 상위 버전 API 사용을 막는다. `Objects`, `String.join`, `Connection.getSchema`, 다이아몬드 문법의 실패와 올바른 자바 6 코드의 성공을 시험한다. 최신 JDK를 빌드용으로 지정하면 기존 출력물을 지우기 전에 거부한다
- [x] 자바 6, 7, 8, 21 런타임으로 같은 JAR을 검증한다. 필수 자바 6·7·8 환경이 없는 경우 일반 시험은 건너뜀을 표시하고 `test:matrix`는 실패한다
- [x] 자바 시험 클래스의 `main`을 각 런타임의 `java -cp`로 직접 실행한다. 배포 JAR의 실제 로딩, 매니페스트·라이선스·시험 클래스 제외, 바이트코드와 UTF-8 소스를 확인한다. 서버 통합 시험도 이 실행 방식에 추가한다

구현 파일 : `src/.../DriverInfo.java`, `scripts/java-tools.mjs`, `scripts/build.mjs`, `scripts/test.mjs`, `scripts/matrix.test.mjs`, `test/.../BuildEnvironmentTest.java`.
`package.json`은 Node.js 시험 실행기용이며 `private`이다. 배포물은 `dist/org.duckdns.hjow.helloworlddb.jdbc6-0.1.0.jar`이다. 현재 JAR에는 식별 정보만 있으며 JDBC 드라이버의 서비스 등록을 제공하지 않는다.
빌드·시험 명령과 환경 변수는 [README.md](README.md)를 따른다. 사용자 작성 Eclipse 설정(`src`→`bin`, JavaSE-1.6)은 변경하지 않았다.

### 14-2. 프로토콜 계층

- [ ] `rdbms/docs/protocol.md`를 기준으로 JSON 읽기·쓰기, UTF-8 검증, TCP 프레임과 메시지, SCRAM-SHA-256 인증, 실행·fetch·커서·ping·종료를 구현한다. 공유 코드는 자바 6 문법·API 범위로 작성하며 `jdbc8` 착수 시 이를 공유한다
- [ ] SSL : 런타임이 지원하는 프로토콜 중 가장 높은 버전을 사용한다. TLS 1.2를 지원하지만 기본으로 켜지 않은 런타임에서는 `setEnabledProtocols`로 켠다. TLS 1.2를 쓸 수 없는 자바 6 환경에서는 서버의 최소 버전을 낮춰 접속한다 (상세 8)
- [ ] UDP 신뢰성 계층 : ACK, 재전송, 조각·재조립, 중복 제거, 순서 보장, ping을 구현한다
- [ ] 실제 `rdbms`를 임시 디렉토리·포트로 띄워 TCP·TLS·UDP 인증·질의·결과·오류를 확인하고 시험 후 정상 종료한다. 프로토콜은 추측하지 않고 명세와 기존 드라이버의 시험을 참고한다

### 14-3. JDBC 구현 (JDBC 4.0)

- [ ] JDBC URL과 접속 속성, `Driver`, `Connection`, `Statement`, `PreparedStatement`, `ResultSet`과 메타데이터를 JDBC 4.0 범위로 구현한다. `java.time`, JDBC 4.1·4.2 전용 타입과 API에 의존하지 않는다
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

- JDBC URL·접속 속성과 메타데이터의 구체적인 API 동작은 14-3에서 정리한다. 호스트·포트로 인스턴스를 지정하며 SID나 DB 이름은 두지 않는다
- 서버가 구버전 TLS 접속을 실제로 받아 주는지. 최신 Node.js 의 OpenSSL 은 TLS 1.0 을 쓰려면 최소 버전 외에 보안 수준 설정도 낮춰야 할 수 있다. 14-5 에서 실제 접속으로 확인하고, 서버 쪽 수정이 필요하면 `rdbms/PROGRESS.md` 에 적는다
- 자바 6 환경이 받아들이는 서버 인증서와 암호 스위트의 범위. 시험에는 RSA 인증서를 쓴다

## 결정 사항

- 사용자 작업 지시(2026-10-20)에 따라 `jdbc6`의 보류를 해제했다. 기존 14-1 ~ 14-5 번호를 유지하며 `jdbc8`보다 먼저 자바 6 기준의 공통 코드를 준비한다. AGENTS.md C절에 순서를 반영했다.
- 빌드는 JDK 6을 직접 사용한다. Node.js 22 이상의 표준 모듈로 소스 목록·패키징·시험 실행만 조정하며 배포 JAR은 JDK 표준 API 외의 의존성을 가지지 않는다. 이미 사용자가 만든 Eclipse의 `src`, `bin` 설정을 유지한다.
- 사용자 지정(2026-10-20) : `VM-W11-Codex`의 자바 7 시험에는 `C:\Program Files\Java\jdk1.7.0_80`을 사용한다. 임시로 내려받은 Azul 배포본은 사용을 중단하고 정리한다.
- 사용자 결정(2026-10-16) : 자바 5 지원을 철회하고 프로젝트·폴더·패키지 이름을 `jdbc6` 기준으로 변경했다. JDBC 인터페이스 기준은 4.0이며 자바 6~7뿐 아니라 자바 8 이상에서도 같은 배포본을 사용할 수 있어야 한다.
- SSL 접속 시 서버 인증서는 기본으로 검증한다. 인증서 오류 때 접속을 끊고 100 ms 뒤 최대 2회 다시 시도한다 (AGENTS.md 상세 8, 사용자 결정 2026-10-15). 자바 6의 인증서 검증 범위는 미결 사항의 확인 항목과 함께 본다.

## 인수인계 사항

- `jdbc8` 착수 시 `jdbc6`의 프로토콜 계층을 공유한다. 두 구현이 생긴 뒤에는 패키지 선언 외의 공통 코드에 변경이 있으면 양쪽에 반영한다.
- 자바 패키지 이름은 `org.duckdns.hjow.helloworlddb.jdbc6`이다 (AGENTS.md 지켜야 할 사항 6). JDBC URL 형식은 14-3에서 확정하고 `jdbc8`에서도 같은 형식을 사용한다.
- TLS 1.2를 쓸 수 없는 자바 6 환경에서 SSL을 쓰려면 서버 관리자가 TLS 최소 버전을 낮춰야 한다는 점을 사용 설명서에 적는다.
- DECIMAL/DEC/NUMERIC의 선언 인자를 모두 생략하면 (10,3), VARCHAR/NVARCHAR의 최대·기본 길이는 65,535이다. `jdbc8`과 같이 실제 컬럼 길이/정밀도/소수 자릿수는 서버 메타데이터를 따른다. [rdbms 타입 정책](../rdbms/docs/data-types.md)을 참고한다.

## 작업 이력

- 2026-10-08 : 세부 계획 작성.
- 2026-10-08 : 보류로 전환. 세부 계획은 초안으로 남김. 자바 패키지 이름 확정.
- 2026-10-08 : 변경된 타입 기본값과 메타데이터 사용 규칙을 인수인계에 반영했다. 개발은 계속 보류한다.
- 2026-10-16 : 자바 5 지원 철회, 프로젝트·폴더·패키지 이름을 `jdbc6`으로 변경, JDBC 4.0 기준과 자바 8 이상 실행 호환을 반영했다. 빌드·공통 코드·자동 등록·예외·타입·TLS·검증 초안을 자바 6 기준으로 정리했다. 개발 보류는 유지한다.
- 2026-10-20 : `VM-W11-Codex`의 JDK 6 설치 경로(`C:\Program Files\Java\jdk1.6.0_45`)와 실행·컴파일러 경로를 기록했다. 두 실행 파일의 버전이 `1.6.0_45`임을 확인하고 환경 관련 미결 사항에 반영했다. 개발 보류는 유지한다.
- 2026-10-20 : 사용자 작업 지시에 따라 보류를 해제하고 14-1을 구현했다. JDK 6 직접 빌드, JAR·라이선스 패키징, 버전별 시험 실행기, 상위 API·문법 거부 시험을 추가했다. Java 6·7·8·21에서 `npm run test:matrix` 14개 통과·실패와 건너뜀 0이다. Java 7 공식 ZIP은 해시 검증 후 프로젝트의 무시 경로에 풀었으며, 사용자가 알려 준 JDK 8 경로와 실제 `1.8.0_432` 버전을 기록했다. 다음은 14-2이며 커밋·푸시는 하지 않았다.
- 2026-10-20 : 자바 7 기본 시험 경로를 사용자가 지정한 `C:\Program Files\Java\jdk1.7.0_80`으로 변경하고 `npm run test:matrix` 14개를 다시 통과했다. 실행기와 README·진행 문서를 갱신했다. 내려받은 Azul 디렉토리의 삭제는 자동 승인 검토에서 차단되어 사용자에게 전체 경로를 안내했으며 수동 정리 대상이다.
