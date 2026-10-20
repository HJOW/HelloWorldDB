# jdbc6 진행 상황

HelloWorldDB용 JDBC 4.0 드라이버를 개발하는 프로젝트이다. 자바 6~7을 기본 대상으로 하며 같은 배포본을 자바 8 이상에서도 사용할 수 있어야 한다. 자바 5는 지원하지 않는다.
사양은 루트의 AGENTS.md 가 기준이다. 이 문서에는 세부 계획, 진행 상황, 인수인계 사항만 적는다.
단계 번호(14-1 등)는 기존 14단계의 번호를 유지한다. 사용자의 2026-10-20 작업 지시에 따라 빌드와 시험 기반부터 착수했다. "상세 N" 은 AGENTS.md "RDBMS 에 구현되어야 할 사항 (상세)" 의 N번 절을 가리킨다.

## 현재 상태

- 최종 갱신 : 2026-10-20
- **Java 8 기본 후보 갱신** : 사용자 추가 지정에 따라 `C:\Program Files\Java\jdk1.8.0_202`를 사용한다. HWDB_JAVA8_HOME을 생략해도 이 경로를 찾도록 바꾸고 Java 6·7·8u202·21·25의 빌드·API 행렬 15개가 통과했다. 아래 기존 전체 서버 시험의 Java 8u504 기록은 앞선 검증이다.
- **서버 prepare/describe·cancel 연동 완료**: 실행 전 결과·파라미터 메타데이터, UNKNOWN·바인딩 힌트, 서버 준비 문장 수명, 요청별 취소·질의 제한 시간·실행 중 close를 구현했다. 단일 수신 경로·ID별 응답 분배·UDP 송신 큐와 정상 종료 후 추가 read 제거를 jdbc8 공통 프로토콜에 동기화했다. 서버 NULL 바인딩 결함도 수정했다.
- **사용자 지정 JDK**: Java 6 빌드·시험은 `C:\Program Files\Java\jdk1.6.0_45`, Java 7 시험은 `C:\Program Files\Java\jdk1.7.0_80`을 사용했다. 실제 버전은 1.6.0_45·1.7.0_80이다. Java 8u504·21.0.12.1은 임시 Zulu 배포본, Java 25는 기본 설치 런타임으로 시험했다.
- 진행 단계 : **14-1 ~ 14-5 완료**. 사용자 추가 작업 요청으로 서버 확장 연동과 최종 통합 검증까지 진행했다. 실제 JDK 6으로 빌드한 같은 JAR을 자바 6·7·8·21·25에서 검증했다.
- 확정된 지원 기준 : 자바 6 이상에서 실행 가능한 JDBC 4.0. 프로젝트·폴더는 `jdbc6`, 패키지는 `org.duckdns.hjow.helloworlddb.jdbc6`이다 (AGENTS.md 상세 8-1).
- 착수 조건 : 선행 프로젝트 완료와 사용자 작업 지시로 충족했다. 추가 지시에 따라 jdbc8 13-4와 jdbc6 14-4까지 진행했다. GUI 보류는 유지한다.
- 최종 검증 : Windows / Node.js 22.23.3 / TypeScript 6.0.3. 기존 실제 서버 **255개**, 확장 API **85개**, 빌드·API 행렬 **15개**, 독립 소비자 **15개** 통과·실패와 건너뜀 0. Java 6 TLSv1과 Java 7 이상 TLSv1.2, TCP·UDP·유실/중복 UDP, 인증서 검증, NULL·뷰 메타데이터·배치·트랜잭션·취소·시간 제한·close를 확인했다.
- 추가 검증 범위 : 리눅스·macOS, 실제 원격망과 장시간 부하는 아직 시험하지 않았다. 배포·릴리스 정책은 별도 작업이며 GUI 보류는 유지한다.
- 구현·검증·README·진행 기록 갱신을 마쳤다. 재현 가능한 명령은 `npm run test:integration`, `test:extensions`, `test:matrix`, `test:consumer`이다.

## 서버 prepare/describe·cancel 연동

서버의 PD-1 ~ PD-5와 [통신 규약](../rdbms/docs/protocol.md)에 맞추어 구현했고 PD-6의 드라이버 회귀와 함께 검증했다. 실제 실행 전에 메타데이터를 조회하며 문맥을 알 수 없는 타입만 UNKNOWN이다. 요청별 취소와 질의 제한 시간을 제공한다. 14-5의 통합·독립 소비자 검증을 완료했으며 다른 OS·장시간 부하는 추가 검증 범위이다.

- [x] 공통 프로토콜에 기능 협상과 준비·설명·실행·해제·취소 메시지를 추가한다. 요청 이름·필드·SQLSTATE는 확정 명세를 따른다. 구형 서버에서는 기존 실행을 유지하고 새 기능의 미지원 상태를 JDBC 규약에 맞게 알린다.
- [x] `PreparedStatement`를 서버 준비 문장 수명과 연결한다. 반복 바인딩과 실행, 문장·연결 종료 시 해제, USE·DDL·권한 변경 시 무효화를 처리한다. 준비 문장 ID와 결과 커서 ID를 구분한다.
- [x] `PreparedStatement.getMetaData()`와 `getParameterMetaData()`에 실행 전 컬럼·파라미터 정보, 정밀도·소수 자릿수·null 허용 여부를 대응시킨다. 서버의 미정 타입을 임의로 확정하지 않으며, 메타데이터 조회를 위해 SELECT나 DML을 실행하지 않는다. 권한 있는 뷰의 메타데이터도 서버가 제공하는 권한 경계를 따른다.
- [x] `Statement.cancel()`과 `setQueryTimeout()`을 실행 요청별 취소에 연결한다. 실행 대기 중 취소 송신을 막는 잠금 구조를 없애고 단일 수신 경로에서 요청 ID별로 응답을 전달한다. 일반 문장의 직렬 실행과 자바 6 문법·API 범위를 유지한다.
- [x] 취소 접수와 실행의 최종 응답, 정상 완료·늦은 취소·중복 취소 경합을 구분한다. 질의 제한 시간은 `SQLTimeoutException`, 사용자 취소는 확정 SQLSTATE를 보존한 JDBC 예외로 처리하도록 매핑을 정한다. 통신 시간 초과와 구분하고, 취소 후 연결 재사용·앞선 트랜잭션 변경 보존을 검증한다. 결과 불명 DML은 자동 재실행하지 않는다.
- [x] 공통 프로토콜 변경은 `jdbc6`를 원본으로 하여 `jdbc8`에 패키지 선언만 바꾸어 동기화한다. `java.time`·`SQLType` 등 자바 8 API를 공유 계층에 넣지 않고 양쪽 동기화 검사를 통과시킨다.
- [x] 실제 JDK 6으로 빌드한 같은 JAR을 자바 6·7·8·21에서 시험한다. TCP·각 JDK의 지원 TLS·UDP, 실행 없는 describe·미정 타입·반복 실행·잠금 대기/CPU 질의 취소·UDP 유실/중복·구형 서버 호환과 기존 전체 회귀를 확인한 뒤 README·한계·진행 기록을 갱신한다.

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

- 사용자 최신 지정: C:/Program Files/Java/jdk1.8.0_202.
- java·javac의 실제 버전은 1.8.0_202이고 Oracle HotSpot 64비트이다.
- jdbc6 실행기의 기본 후보와 jdbc8 빌드 기본값에 적용했다. HWDB_JAVA8_HOME으로 변경할 수 있다.
- jdbc6 소스 컴파일은 계속 지정 JDK 6을 사용한다. 이번 8u202는 Java 6 JAR의 실행 호환성과 jdbc8 컴파일·실행을 검증했다.

초기 시험용으로 내려받은 Azul 배포본은 더 이상 사용하지 않는다. 삭제 대상은 `H:\Workspace\git\HelloWorldDB\jdbc6\.tools\java7\zulu7.56.0.11-ca-jdk7.0.352-win_x64`이다. 해당 디렉토리의 삭제 명령이 자동 승인 검토에서 `blocked by policy`로 차단되어 사용자가 직접 삭제하기로 했다. ZIP 파일은 앞선 압축 해제 작업에서 이미 삭제했다.
자바 21은 사용자 지정 `C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot`을 기본 후보로 사용한다. `HWDB_JAVA21_HOME`으로 바꿀 수 있다. 같은 JAR의 TCP·TLS·UDP 서버 시험도 완료했다.

## 세부 계획 (14단계)

### 14-1. 빌드와 시험 환경

- [x] 실제 JDK 6의 `javac`·`jar`로 UTF-8 소스를 컴파일·패키징한다. 생성 클래스의 버전은 50이다. 외부 라이브러리와 Maven·Gradle은 사용하지 않는다
- [x] 자바 6의 실제 API로 컴파일하여 상위 버전 API 사용을 막는다. `Objects`, `String.join`, `Connection.getSchema`, 다이아몬드 문법의 실패와 올바른 자바 6 코드의 성공을 시험한다. 최신 JDK를 빌드용으로 지정하면 기존 출력물을 지우기 전에 거부한다
- [x] 자바 6, 7, 8, 21 런타임으로 같은 JAR을 검증한다. 필수 자바 6·7·8 환경이 없는 경우 일반 시험은 건너뜀을 표시하고 `test:matrix`는 실패한다
- [x] 자바 시험 클래스의 `main`을 각 런타임의 `java -cp`로 직접 실행한다. 배포 JAR의 실제 로딩, 매니페스트·라이선스·시험 클래스 제외, 바이트코드와 UTF-8 소스를 확인한다. 서버 통합 시험도 이 실행 방식에 추가한다

구현 파일 : `src/.../DriverInfo.java`, `scripts/java-tools.mjs`, `scripts/build.mjs`, `scripts/test.mjs`, `scripts/matrix.test.mjs`, `test/.../BuildEnvironmentTest.java`.
`package.json`은 Node.js 시험 실행기용이며 `private`이다. 배포물은 `dist/org.duckdns.hjow.helloworlddb.jdbc6-0.1.0.jar`이며 JDBC 드라이버·서비스 등록·프로토콜을 포함한다. 시험 클래스는 제외한다.
빌드·시험 명령과 환경 변수는 [README.md](README.md)를 따른다. 사용자 작성 Eclipse 설정(`src`→`bin`, JavaSE-1.6)은 변경하지 않았다.

### 14-2. 프로토콜 계층

- [x] 명세 기준의 JSON·UTF-8·TCP 프레임·SCRAM·실행·fetch·커서·ping·종료. 자바 6 문법·API로 구현하여 jdbc8과 패키지 선언만 바꾸어 공유
- [x] SSLSocket 지원 TLS 프로토콜 활성화, 인증서 체인·기간·호스트 이름 검증, CA 지정·검증 끄기와 인증서 오류 재시도. Java 6은 서버 최소 TLSv1, Java 7·8·21은 기본 TLSv1.2에서 시험
- [x] UDP ACK·RFC 6298 RTO·Karn·32조각 창·재전송·재조립·중복 제거·순서 보장·FIN·유휴 ping
- [x] 임시 디렉토리·포트의 실제 rdbms에서 TCP·TLS·UDP와 유실·중복·지연을 검증하고 종료·정리

### 14-3. JDBC 구현 (JDBC 4.0)

- [x] URL·접속 속성, Driver·Connection·Statement·PreparedStatement·ResultSet·메타데이터. 실제 JDK 6으로 컴파일하여 상위 API 의존을 방지
- [x] 서비스 자동 등록과 Class.forName 명시적 로딩
- [x] isValid·isClosed·unwrap·isWrapperFor, NCHAR·NVARCHAR UTF-8 처리
- [x] RowId·NClob·SQLXML·LOB·배열·CallableStatement·생성 키·갱신/스크롤 ResultSet 등 미지원 처리
- [x] 미지원 기능은 SQLFeatureNotSupportedException과 0A000
- [x] 동적 프록시로 상위 런타임 메서드도 호환 처리. getSchema·closeOnCompletion 등을 Java 7·8·21에서 확인하고 메타데이터 버전은 유지
- [x] JDBC 버전은 항상 4.0

### 14-4. 타입 대응

- [x] jdbc8 표에서 java.time을 제외한 타입 대응. BIGINT·NUMERIC·소수 초·NULL·Calendar·스트림·명시한 NUMERIC 정밀도를 검증
- [x] WITH TIME ZONE은 Types.TIME·Types.TIMESTAMP, 원래 typeName과 getString에 오프셋 보존. Time/Timestamp getter는 오프셋을 반영한 시점을 반환

### 14-5. 검증

2026-10-20 추가 작업 요청으로 수행했다. 아래 항목은 실제 JDK 6 배포 JAR의 최종 회귀와 독립 소비자 시험으로 확인했다.

- [x] 자바 6, 7, 8 이상 각각에서 같은 jar로 통합 테스트 : TCP, UDP 로그인, 질의, 파라미터, 대량 결과, 트랜잭션, 오류
- [x] JDBC 4.0 자동 등록, 연결 유효성, 래퍼, 메타데이터의 JDBC 버전(4.0), 미지원 기능의 오류를 확인한다
- [x] SSL : TLS 1.2를 지원하는 환경은 서버 기본 설정으로, 지원하지 않는 자바 6 환경은 서버의 `tcp.ssl.minVersion`을 `TLSv1`로 낮추고 시험한다
- [x] 저장소의 시험 클래스 없이 임시 프로젝트에 JAR만 복사하여 JDK 6으로 소비자 앱을 컴파일하고 Java 6·7·8·21·25의 TCP·UDP·TLS 15개 확인
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

## 검증 기록과 남은 사항

- Java 6·7·8·21 각각 단위 5개, TCP 10개, UDP 11개, 결함 주입 UDP 11개, TLS 10개, TLS 거부/검증 끄기 3개. 합계 **200개 통과**, 실패·건너뜀 0. 기존 빌드·API 제한 시험 **14개**도 통과했다.
- UDP 결함 주입에서 유실 363회·중복 528회·지연 448회를 처리했다. 60KB 이상의 UTF-8 메시지, 두 연결의 뷰 권한·메타데이터 가시성도 확인했다.
- RSA 시험 인증서와 Node.js 기본 TLS 서버를 사용했다. Java 6은 minVersion=TLSv1에서 실제 접속했다. 서버가 이미 낮은 버전의 암호 스위트를 허용하므로 서버 소스 수정은 필요 없었다. Java 7은 지원하지만 기본으로 비활성인 TLS 1.2를 명시적으로 켜 기본 서버 설정에 접속했다.
- 이 절은 최초 14-4 완료 당시의 검증 기록이다. 이후 서버 prepare/describe·cancel 연동으로 메타데이터·취소 한계를 보완하고 14-5의 통합·독립 소비자 시험도 마쳤다. 최신 결과는 문서 맨 위를 따른다. 다른 OS·릴리스 배포는 별도 범위이다. 자세한 동작은 [README.md](README.md)에 있다.

## 결정 사항

- 추가 작업 지시(2026-10-20)로 jdbc6는 14-4, jdbc8은 13-4까지 구현했다. 프로토콜은 Java 6 원본을 공유하고 JDBC 계층은 Java API 기준에 맞추어 각각 유지한다.
- 공통 URL은 `jdbc:helloworlddb://호스트[:포트][?옵션]`이며 현재 테이블스페이스는 tablespace 속성으로 지정한다. SID·DB 이름·경로는 없다. 전체 속성은 jdbc8 README와 공유한다.

- 사용자 작업 지시(2026-10-20)에 따라 `jdbc6`의 보류를 해제했다. 기존 14-1 ~ 14-5 번호를 유지하며 `jdbc8`보다 먼저 자바 6 기준의 공통 코드를 준비한다. AGENTS.md C절에 순서를 반영했다.
- 빌드는 JDK 6을 직접 사용한다. Node.js 22 이상의 표준 모듈로 소스 목록·패키징·시험 실행만 조정하며 배포 JAR은 JDK 표준 API 외의 의존성을 가지지 않는다. 이미 사용자가 만든 Eclipse의 `src`, `bin` 설정을 유지한다.
- 사용자 지정(2026-10-20) : `VM-W11-Codex`의 자바 7 시험에는 `C:\Program Files\Java\jdk1.7.0_80`을 사용한다. 임시로 내려받은 Azul 배포본은 사용을 중단하고 정리한다.
- 사용자 결정(2026-10-16) : 자바 5 지원을 철회하고 프로젝트·폴더·패키지 이름을 `jdbc6` 기준으로 변경했다. JDBC 인터페이스 기준은 4.0이며 자바 6~7뿐 아니라 자바 8 이상에서도 같은 배포본을 사용할 수 있어야 한다.
- SSL 접속 시 서버 인증서는 기본으로 검증한다. 인증서 오류 때 접속을 끊고 100 ms 뒤 최대 2회 다시 시도한다 (AGENTS.md 상세 8, 사용자 결정 2026-10-15). 자바 6의 인증서 검증 범위는 미결 사항의 확인 항목과 함께 본다.

## 인수인계 사항

- `jdbc8` 착수 시 `jdbc6`의 프로토콜 계층을 공유한다. 두 구현이 생긴 뒤에는 패키지 선언 외의 공통 코드에 변경이 있으면 양쪽에 반영한다.
- 자바 패키지 이름은 `org.duckdns.hjow.helloworlddb.jdbc6`이다. JDBC URL과 속성은 [README.md](README.md)의 확정 형식을 두 프로젝트에서 공유한다.
- TLS 1.2를 쓸 수 없는 자바 6 환경에서 SSL을 쓰려면 서버 관리자가 TLS 최소 버전을 낮춰야 한다는 점을 사용 설명서에 적는다.
- DECIMAL/DEC/NUMERIC의 선언 인자를 모두 생략하면 (10,3), VARCHAR/NVARCHAR의 최대·기본 길이는 65,535이다. `jdbc8`과 같이 실제 컬럼 길이/정밀도/소수 자릿수는 서버 메타데이터를 따른다. [rdbms 타입 정책](../rdbms/docs/data-types.md)을 참고한다.

## 작업 이력

- 2026-10-20 : jdbc8 추가 작업에서 사용자 지정 Java 8u202를 기본 실행 후보로 반영하고 README·환경 기록을 갱신했다. Java 8 환경 변수 없이 실제 지정 경로를 찾는 빌드 행렬 15개가 모두 통과했다. JDBC6 Java 소스·공통 프로토콜은 바꾸지 않았으며 전체 네트워크 회귀는 이 경로 변경만으로 반복하지 않았다.

- 2026-10-20 : 사용자 지정 Oracle JDK 6u45·7u80을 사용해 서버 준비·설명·실행·해제와 JDBC4.0 메타데이터·취소·질의 제한 시간·실행 중 close를 구현했다. 새 확장 85개·기존 255개·빌드 행렬 15개·독립 배포 소비자 15개가 Java 6·7·8·21·25에서 통과했다. 정상 bye 뒤 추가 read를 재현·제거했고, 서버 선언 타입 NULL 결함을 찾아 고쳤다. 14-5의 명시된 완료 기준을 충족했다. 공유 프로토콜·README·각 진행 문서를 갱신했으며 커밋·푸시는 하지 않았다.

- 2026-10-20 : 서버 뷰 컬럼 메타데이터 확장에 따른 보완 조회 중복과 UNKNOWN 매핑을 수정했다. 사용자 추가 지시에 따라 수정 후 빌드·시험을 다음 작업으로 남기고 종료했다. 실제 JDK 6 빌드 및 네 런타임 회귀 재실행이 필요하다.

- 2026-10-20 : 서버 prepare/describe·cancel 구현 후의 JDBC 4.0 연동을 다음 작업으로 등록했다. PreparedStatement 메타데이터·수명, Statement 취소·제한 시간, 공유 Java 6 프로토콜과 실행 환경별 회귀 시험을 미완료 체크리스트로 추가했다. 이번 변경은 문서만 해당한다.

- 2026-10-20 : 추가 지시로 14-2 ~ 14-4 구현. 공유 Java 6 프로토콜, JDBC 4.0 인터페이스·자동 등록·메타데이터·타입 변환을 추가했다. JDK 6으로 만든 같은 JAR의 Java 6·7·8·21 실제 서버 시험 200개와 기존 빌드 회귀 14개 통과. Java 6 TLSv1과 나머지 TLSv1.2 접속을 확인했고 서버 소스 변경은 없었다. 다음은 14-5이며 커밋·푸시는 하지 않았다.

- 2026-10-08 : 세부 계획 작성.
- 2026-10-08 : 보류로 전환. 세부 계획은 초안으로 남김. 자바 패키지 이름 확정.
- 2026-10-08 : 변경된 타입 기본값과 메타데이터 사용 규칙을 인수인계에 반영했다. 개발은 계속 보류한다.
- 2026-10-16 : 자바 5 지원 철회, 프로젝트·폴더·패키지 이름을 `jdbc6`으로 변경, JDBC 4.0 기준과 자바 8 이상 실행 호환을 반영했다. 빌드·공통 코드·자동 등록·예외·타입·TLS·검증 초안을 자바 6 기준으로 정리했다. 개발 보류는 유지한다.
- 2026-10-20 : `VM-W11-Codex`의 JDK 6 설치 경로(`C:\Program Files\Java\jdk1.6.0_45`)와 실행·컴파일러 경로를 기록했다. 두 실행 파일의 버전이 `1.6.0_45`임을 확인하고 환경 관련 미결 사항에 반영했다. 개발 보류는 유지한다.
- 2026-10-20 : 사용자 작업 지시에 따라 보류를 해제하고 14-1을 구현했다. JDK 6 직접 빌드, JAR·라이선스 패키징, 버전별 시험 실행기, 상위 API·문법 거부 시험을 추가했다. Java 6·7·8·21에서 `npm run test:matrix` 14개 통과·실패와 건너뜀 0이다. Java 7 공식 ZIP은 해시 검증 후 프로젝트의 무시 경로에 풀었으며, 사용자가 알려 준 JDK 8 경로와 실제 `1.8.0_432` 버전을 기록했다. 다음은 14-2이며 커밋·푸시는 하지 않았다.
- 2026-10-20 : 자바 7 기본 시험 경로를 사용자가 지정한 `C:\Program Files\Java\jdk1.7.0_80`으로 변경하고 `npm run test:matrix` 14개를 다시 통과했다. 실행기와 README·진행 문서를 갱신했다. 내려받은 Azul 디렉토리의 삭제는 자동 승인 검토에서 차단되어 사용자에게 전체 경로를 안내했으며 수동 정리 대상이다.
- 2026-10-20 : 전 소스 한국어 Javadoc 추가. 14개 전체 소스(Driver·JdbcConnection·JdbcStatement·JdbcResultSet·JdbcDatabaseMetaData·JdbcProxy·Values·DriverInfo·protocol 6종)의 클래스·중첩 클래스·상수·필드·생성자·메소드(비공개 포함)에 한국어 Javadoc을 달고 JDK 6(`1.6.0_45`) 컴파일을 확인했다. 로직 변경 없음.
