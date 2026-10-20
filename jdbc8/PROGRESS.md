# jdbc8 진행 상황

HelloWorldDB용 JDBC 4.2 드라이버(자바 8 이상)를 개발하는 프로젝트이다. 공통 프로토콜 계층은 자바 6용 `jdbc6`와 공유한다.
사양은 루트의 AGENTS.md 가 기준이다. 이 문서에는 세부 계획, 진행 상황, 인수인계 사항만 적는다.
단계 번호(13-1 등)는 기존 계획의 번호를 유지한다. 2026-10-20 추가 작업 지시에 따라 13-4까지 진행했다. "상세 N" 은 AGENTS.md "RDBMS 에 구현되어야 할 사항 (상세)" 의 N번 절을 가리킨다.

## 현재 상태

- 최종 갱신 : 2026-10-20
- **공통 프로토콜·기존 호환 회귀 완료** : jdbc6 원본에서 준비·설명·취소 메시지, 단일 수신 스레드·ID별 응답 분배·UDP 송신 큐·정상 bye 뒤 수신 종료를 동기화했다. 뷰 컬럼 패턴·순서·중복 없음·UNKNOWN null 허용 여부를 보강한 기존 전체 시험 130개가 새 서버에서 통과했다. JDBC4.2 공개 계층의 새 prepare/describe·cancel 연동은 아래 미완료 항목으로 남긴다.
- 진행 단계 : **13-1 ~ 13-4 완료**. 빌드·자동 등록, 공유 프로토콜, JDBC 4.2와 타입 대응을 구현했다.
- 확정된 지원 기준 : 자바 8 이상, JDBC 4.2 (AGENTS.md 상세 8-1). `jdbc6`는 JDBC 4.0을 제공하며 자바 8 이상에서도 실행 가능해야 한다.
- 착수 조건 : 선행 두 프로젝트 완료와 사용자의 추가 작업 지시로 충족했다. 기존 번호와 범위를 유지하고 Maven 제안 대신 jdbc6과 같은 JDK·Node.js 방식으로 정했다.
- 검증 : Windows / Node.js 22.23.3 서버, 실제 JDK 8u504 빌드 JAR을 Java 8u504·21.0.12.1에서 실행해 **130개 통과·실패와 건너뜀 0**. 프로토콜 동기화 검사도 통과했다.
- 다음 작업 : **13-5 최종 검증**. 독립 배포 소비자·범용 DB툴(DBeaver 등) 등록과 객체 탐색. 자동 서버 시험은 13-4까지의 구현 검증으로 수행했다.
- 다음 API 작업 : prepare/describe·cancel을 JDBC 4.2 공개 계층에 연결한다. 서버 [rdbms/PREPARE.md](../rdbms/PREPARE.md) PD-1 ~ PD-5와 공통 프로토콜은 준비되었으며 아래 JDBC 계층 항목은 미구현이다.

## 다음 작업: 서버 prepare/describe·cancel 연동

착수 조건은 [rdbms/PREPARE.md](../rdbms/PREPARE.md)의 PD-1 ~ PD-5 구현과 [통신 규약](../rdbms/docs/protocol.md) 확정이다. PD-6의 드라이버 회귀 검증과 함께 진행한다. 현재의 파라미터 타입 UNKNOWN·취소/시간 초과 한계는 서버 연동을 구현·검증하기 전까지 그대로이다. 기존 13-5와 자바 8 이상·JDBC 4.2 기준은 유지한다.

- [x] 기능 협상과 준비·설명·실행·해제·취소 메시지를 공유 프로토콜에 반영한다. 요청 이름·필드·SQLSTATE는 확정 명세를 따르고 구형 서버의 기존 실행을 유지한다. 지원하지 않는 새 기능은 JDBC 규약에 맞게 알린다.
- [ ] `PreparedStatement`를 서버 준비 문장 수명과 연결한다. 반복 바인딩과 실행, 문장·연결 종료 시 해제, USE·DDL·권한 변경 시 무효화를 처리한다. 준비 문장 ID와 결과 커서 ID를 구분한다.
- [ ] `PreparedStatement.getMetaData()`와 `getParameterMetaData()`에 실행 전 결과·파라미터 정보를 대응시킨다. 정밀도·소수 자릿수·null 허용 여부와 서버의 미정 타입을 구분하며, 메타데이터를 얻기 위해 SQL을 실행하지 않는다. JDBC 4.2의 `SQLType`·`java.time` 바인딩과 타입 힌트가 기존 정밀도를 잃지 않는지 확인한다. 뷰 메타데이터는 서버의 권한 경계를 따른다.
- [ ] `Statement.cancel()`과 `setQueryTimeout()`을 실행 요청별 취소에 연결한다. 실행 응답 대기 중에도 취소를 송신하고, 단일 수신 경로에서 요청 ID별 응답을 전달하도록 잠금·대기 구조를 조정한다. 일반 문장의 직렬 실행은 유지한다.
- [ ] 취소 접수와 원래 실행의 최종 응답, 정상 완료·늦은 취소·중복 취소 경합을 처리한다. 질의 제한 시간은 `SQLTimeoutException`, 사용자 취소는 확정 SQLSTATE를 보존한 JDBC 예외로 매핑하고 통신 시간 초과와 구분한다. 취소 후 연결 재사용·앞선 트랜잭션 변경 보존을 검증하며 결과 불명 DML은 자동 재실행하지 않는다.
- [x] 공유 프로토콜은 `jdbc6` 원본에서 패키지 선언만 바꾸어 동기화한다. 공통 계층에 자바 8 전용 API를 넣지 않고, JDBC 4.2 전용 타입 대응은 jdbc8 계층에 둔다. 양쪽 동기화 검사를 통과시킨다.
- [ ] 실제 JDK 8로 빌드한 같은 JAR을 자바 8·21에서 시험한다. TCP·TLS·UDP, 실행 없는 describe·미정 타입·반복 실행·잠금 대기/CPU 질의 취소·UDP 유실/중복·구형 서버 호환과 기존 전체 회귀를 확인한다. 13-5의 범용 DB툴 검증에도 실행 전 메타데이터·취소 시나리오를 반영하고 README·한계·진행 기록을 갱신한다.

## 작업 규칙

- 작업 항목을 끝내면 `[ ]` 를 `[x]` 로 바꾼다. 묶음이 끝나면 "현재 상태" 와 "작업 이력" 을 갱신한다.
- 사양에 없는 것을 새로 정했으면 "결정 사항" 에 적는다.

## 설치된 자바 8 환경

- 장비 : `VM-W11-Codex`
- JDK 설치 경로 : `C:\Program Files\Java\jdk8u432-b06`
- 실행 파일 : `C:\Program Files\Java\jdk8u432-b06\bin\java.exe`
- 컴파일러 : `C:\Program Files\Java\jdk8u432-b06\bin\javac.exe`
- 확인일 : 2026-10-20. 실행 환경은 Temurin OpenJDK `1.8.0_432-b06`(64비트)이며 `java -version`과 `javac -version`에서 모두 `1.8.0_432`를 확인했다.

PowerShell에서 기본 PATH의 자바와 구분하여 실행한다.

```powershell
& "C:\Program Files\Java\jdk8u432-b06\bin\java.exe" -version
& "C:\Program Files\Java\jdk8u432-b06\bin\javac.exe" -version
```

같은 설치본을 `jdbc6`의 자바 8 실행 호환성 시험에도 사용한다. JDK 21은 사용자가 지정한 `C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot`이며 실제 버전 `21.0.12.1`을 확인했다. `HWDB_JAVA8_HOME`, `HWDB_JAVA21_HOME`으로 바꿀 수 있다.

## 세부 계획 (13단계)

### 13-1. 빌드 구성

- [x] 실제 JDK 8 javac·jar를 Node.js 표준 모듈로 조정한다. 클래스 버전 52, 라이선스 포함·시험 클래스 제외
- [x] 실행·시험 모두 JDK 표준 API만 쓴다. Maven·Gradle·외부 Java 라이브러리는 사용하지 않는다
- [x] 서비스 등록과 Class.forName 로딩
- [x] 실제 rdbms를 임시 설치·데이터 디렉토리와 빈 포트로 띄우고 종료·정리하는 시험 실행기

### 13-2. 프로토콜 계층

공통 원본은 `jdbc6/src/.../jdbc6/protocol`에 두었다. `npm run sync:protocol`로 패키지 선언만 바꾸어 복사하며 빌드에서 일치를 검사한다. 실제 JDK 6으로 컴파일하고 JDBC 4.2 계층은 자바 8 기준으로 유지한다.

- [x] JSON 직접 구현, UTF-8·서러게이트·중복 키·깊이 검증
- [x] TCP 프레임·인증 전후 크기 한도·응답 제한 시간, TLS 인증서 검증·CA·검증 끄기·재시도
- [x] UDP ACK·RFC 6298 RTO·Karn·32조각 창·재전송·재조립·중복 제거·순서 보장·FIN·유휴 ping
- [x] 핸드셰이크·버전 협상·응답 ID/종류/구조 검증·id 0 오류 보존
- [x] SCRAM-SHA-256, NFKC·nonce·반복수·서버 서명 검증. HmacSHA256 PBKDF2와 Java 6용 base64 직접 구현
- [x] 문장 실행·fetch·커서 닫기·ping·정상 종료. 잘못된 응답과 시간 초과는 연결 종료

### 13-3. JDBC 구현 (JDBC 4.2)

- [x] Driver URL·접속 속성·자동/명시적 등록
- [x] Connection 자동 커밋·커밋·롤백·세이브포인트·isValid·스키마·READ COMMITTED·네트워크 제한 시간
- [x] Statement·PreparedStatement 바인딩·fetch 크기·일반/large 배치·부분 실패 수·SQLType
- [x] 전진·읽기 전용 ResultSet, 현재 묶음만 보관·수명·wasNull·라벨·홀더블 커서
- [x] ResultSetMetaData·ParameterMetaData. 서버가 제공하지 않는 정보는 unknown
- [x] SYSTEM 딕셔너리의 권한 필터로 스키마·테이블·뷰·시스템 객체·컬럼·PK·FK·인덱스·타입 조회. 뷰 컬럼은 WHERE 1 = 0 메타데이터로 보완
- [x] JDBC 버전 메타데이터 4.2
- [x] SQLException SQLSTATE·내부 번호 보존
- [x] 미지원 기능은 SQLFeatureNotSupportedException/0A000. 동적 프록시로 상위 런타임 메서드도 처리

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

- [x] getXxx·getObject·setXxx·setObject를 위 표대로 구현. 전 타입 왕복·숫자 범위·소수 초·오프셋·NULL·Calendar·SQLType·스트림 시험

### 13-5. 검증

- [ ] 통합 테스트 : TCP, SSL, UDP 각각으로 로그인, 질의, 파라미터, 대량 결과, 트랜잭션, 오류
- [ ] `DatabaseMetaData` 로 테이블과 컬럼 목록 조회
- [ ] 범용 DB툴(DBeaver 등)에 드라이버를 등록하여 접속, 객체 탐색, 질의가 되는지 확인
- 완료 기준 : 실제 `rdbms` 를 상대로 한 통합 테스트 통과. `DatabaseMetaData` 로 테이블과 컬럼 목록이 조회된다.

## 검증 기록과 남은 사항

- Java 8·21 각각 단위 12개, TCP 12개, UDP 13개, 결함 주입 UDP 13개, TLS 12개, TLS 거부/검증 끄기 3개. 합계 **130개 통과**, 실패·건너뜀 0.
- UDP 유실·중복·지연과 60KB 이상 UTF-8 메시지를 시험했다. 중계 도우미는 JDBC 접속마다 별도 송신 소켓을 두어 서버의 주소·세션 식별 규칙을 보존한다.
- jdbc6도 같은 공통 코드를 사용하여 Java 6·7·8·21에서 실제 서버 시험 200개를 통과했다. 빌드·API 제한 회귀 시험 14개도 통과했다.
- 독립 배포 소비자·DBeaver와 기타 DB툴·다른 OS 시험은 13-5에 남아 있다. Java 9~20을 각각 실행하지는 않았다.
- 파라미터 타입은 서버 describe 기능이 없어 UNKNOWN이다. SELECT 권한이 없는 뷰의 컬럼은 보완 조회하지 않는다. 자세한 API와 한계는 [README.md](README.md)를 따른다.

## 결정 사항

- 사용자 추가 지시(2026-10-20)로 보류를 풀고 13-4까지 구현했다. Maven 제안 대신 실제 JDK 직접 빌드·Node.js 실행기를 사용한다. 배포 JAR은 외부 의존성이 없다.
- URL은 `jdbc:helloworlddb://호스트[:포트][?옵션]`이다. 현재 테이블스페이스는 tablespace 속성으로 지정하며 경로·SID·DB 이름은 없다. jdbc6도 같은 URL과 접속 속성을 사용한다.

- 사용자 결정(2026-10-16) : 이 프로젝트는 자바 8 이상과 JDBC 4.2 기준이다. 자바 6~7용 프로젝트는 `jdbc6`, JDBC 4.0이며 자바 8 이상에서도 사용 가능해야 한다. 공통 프로토콜 코드는 자바 6 범위로 유지한다.
- SSL 접속 시 서버 인증서는 기본으로 검증한다. 인증서 오류 때 접속을 끊고 100 ms 뒤 최대 2회 다시 시도한다 (AGENTS.md 상세 8, 사용자 결정 2026-10-15). 보류 해제 때 URL 옵션으로 CA 지정과 검증 끄기를 제공한다.

## 인수인계 사항

- 프로토콜을 추측해서 구현하지 않는다. `rdbms/docs` 의 프로토콜 명세가 기준이다. `nodejsDriver` 의 구현도 참고할 수 있다.
- 프로토콜 계층(13-2)의 코드는 패키지 선언 외에는 `jdbc6`와 같게 유지한다. 한쪽을 고치면 다른 쪽도 고친다.
- JDBC URL과 속성은 [README.md](README.md)의 형식을 두 프로젝트에서 공유한다.
- DECIMAL/DEC/NUMERIC의 선언 인자를 모두 생략하면 (10,3), VARCHAR/NVARCHAR의 최대·기본 길이는 65,535이다. 실제 컬럼 길이/정밀도/소수 자릿수는 서버 메타데이터에서 읽는다. `NUMERIC(p)` 등 명시한 선언을 기본값 (10,3)으로 덮어쓰지 않는다. [rdbms 타입 정책](../rdbms/docs/data-types.md)을 참고한다.

## 작업 이력

- 2026-10-20 : jdbc6 새 API 구현에 맞추어 공유 프로토콜을 동기화하고, 기존 메타데이터 시험에 뷰 컬럼 순서·패턴·UNKNOWN 매핑을 보강했다. JDK 8u504 배포 JAR의 Java 8·21 전체 130개와 동기화 검사가 Node.js 22 서버에서 통과했다. JDBC4.2의 새 공개 API와 13-5 범용 도구 검증은 후속이다.

- 2026-10-20 : 서버 뷰 컬럼 확장 후 기존 회귀 시험이 중복 컬럼으로 실패하여 보완 조회·UNKNOWN 매핑을 수정했다. 사용자 추가 지시에 따라 재빌드·재시험을 다음 작업으로 남기고 종료했다. 로그와 다음 명령은 rdbms/HANDOFF.md를 따른다.

- 2026-10-20 : 서버 prepare/describe·cancel 구현 후의 JDBC 4.2 연동을 다음 작업으로 등록했다. PreparedStatement 메타데이터·수명, Statement 취소·제한 시간, 공유 프로토콜 동기화와 자바 8·21 회귀 시험을 미완료 체크리스트로 추가했다. 이번 변경은 문서만 해당한다.

- 2026-10-20 : 추가 지시로 13-1 ~ 13-4 구현. JDK 8 빌드, 공유 Java 6 프로토콜, TCP·TLS·UDP, JDBC 4.2와 타입·메타데이터·실제 서버 실행기 추가. Java 8·21에서 130개 통과. jdbc6 14-4도 완료했고 공유 코드를 검증했다. README·진행·인수인계를 갱신했다. 다음은 13-5이며 커밋·푸시는 하지 않았다.

- 2026-10-08 : 세부 계획 작성.
- 2026-10-08 : 보류로 전환. 세부 계획은 초안으로 남김. 자바 패키지 이름 확정.
- 2026-10-08 : 변경된 타입 기본값과 메타데이터 사용 규칙을 인수인계에 반영했다. 개발은 계속 보류한다.
- 2026-10-16 : 자바 8 이상용 JDBC 4.2 기준을 명시하고, 공유 대상 프로젝트를 `jdbc6`(자바 6 이상 실행, JDBC 4.0)으로 바꿨다. 공통 프로토콜 코드의 자바 6 기준과 메타데이터 버전 차이를 반영했다. 개발 보류는 유지한다.
- 2026-10-20 : `VM-W11-Codex`의 JDK 8 설치 경로(`C:\Program Files\Java\jdk8u432-b06`)와 실행·컴파일러 경로를 기록했다. `jdbc6`의 자바 8 호환성 시험에도 같은 설치본을 사용한다. 개발 보류는 유지한다.
- 2026-10-20 : 전 소스 한국어 Javadoc 추가. 13개 전체 소스(Driver·JdbcConnection·JdbcStatement·JdbcResultSet·JdbcDatabaseMetaData·JdbcProxy·Values·protocol 6종)의 클래스·중첩 클래스·상수·필드·생성자·메소드(비공개 포함)에 한국어 Javadoc을 달았다. 빌드(`scripts/build.mjs`, JDK 8) 통과를 확인했고 커밋·푸시는 하지 않았다. 로직 변경 없음(멤버별 주석을 위해 한 줄 다중 필드 선언만 분리).
