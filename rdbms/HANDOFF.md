# RDBMS·JDBC 후속 작업 인수인계 — 2026-10-20

사용자 재개 요청과 jdbc6·jdbc8 추가 작업을 완료했다. 서버 PD-1 ~ PD-5 및 PD-6의 서버·기존 드라이버 회귀, jdbc6 새 API·14-5와 jdbc8 새 API·13-5 자동 검증을 마쳤다. jdbc8 범용 DB툴의 실제 화면 검증은 남아 있다. 커밋·푸시는 하지 않았다.

## 사용자 지정 JDK와 시험 환경

- Java 6 빌드·시험: C:/Program Files/Java/jdk1.6.0_45 (실제 1.6.0_45).
- Java 7 시험: C:/Program Files/Java/jdk1.7.0_80 (실제 1.7.0_80).
- 사용자 지정 뒤에는 임시 Zulu 6·7을 사용하지 않았다.
- Java 8 최신 지정·JDBC8 빌드: C:/Program Files/Java/jdk1.8.0_202 (실제 java·javac 1.8.0_202). JDBC6의 기본 Java 8 후보도 같게 반영했다.
- Java 21.0.12.1 임시 경로: %TEMP%/hwdb-validation-runtimes/jdk-homes.json의 java21. 앞선 JDBC6 전체 시험의 Java 8u504 기록은 과거 검증이다. Java 25는 기본 설치 런타임이다.
- Node.js 22.23.3: %TEMP%/hwdb-validation-runtimes/node22.exe. 기본 Node.js는 24.21.0, Bun은 1.4.2이다.
- Python 3.2·3.13.1: C:/Program Files/Python/302/python.exe·313/python.exe.

## 반영 사항

서버 prepare/describe·cancel·협력 실행·파일 커서·뷰 컬럼·인덱스 이름 생략을 검토했다. IN 목록 분석 누락, BETWEEN·CASE·서브쿼리의 파라미터 문맥, 선언 타입의 NULL 바인딩, 결과 파일 생성 실패의 디렉토리 누수·부분 쓰기를 수정했다. 통신 규약·매뉴얼·트랜잭션·설계·검증 문서를 갱신했다. 저장 포맷과 고정 호환성 자료는 바꾸지 않았다.

jdbc6는 단일 수신 스레드·ID별 응답 분배, 일반 요청 직렬화·취소 우회, UDP 송신 큐, 서버 준비·설명·실행·해제, 실행 전 메타데이터·UNKNOWN·바인딩 힌트, Statement.cancel·질의 제한 시간을 제공한다. 실행 중 close와 늦은 타이머의 요청 경계를 보완했고 정상 bye 뒤 추가 read를 재현·제거했다. 공통 프로토콜은 jdbc8에 패키지 선언만 바꾸어 동기화했다.

jdbc8도 서버 준비·실행 전 분석·취소·시간 제한을 연결했다. SQLType·java.time·정확한 NUMERIC·오프셋·배치 힌트 스냅샷·large 배치 부분 실패 행 수를 보존한다. 공유 프로토콜과 서버 소스는 이 후속 작업에서 변경하지 않았다.

## 최종 검증 결과

| 범위 | 결과 |
|---|---|
| 서버 Node.js 22.23.3 전체 | 949개 중 948 통과·Windows SIGTERM 1 건너뜀·실패 0 |
| 서버 Bun 1.4.2 | 주요 167개 통과 후 마지막 NULL 수정 포함 핵심 42개 재검증 통과 |
| 서버 최종 시험 설정 보완 | Node.js 22 streaming 15개 통과 |
| jdbc6 기존 실제 서버 | Oracle 6·7, Java 8·21·25의 같은 JAR 255개 통과 |
| jdbc6 새 준비·취소 API | TCP·TLS·UDP·유실 UDP·구형 서버 호환 85개 통과 |
| jdbc6 빌드·API 행렬 / 독립 소비자 | 각각 15개 통과 |
| jdbc8 기존·확장·독립 소비자 | 지정 JDK 8u202 빌드 JAR의 Java 8·21 기존 130개·확장 50개·소비자 6개 통과 |
| JDBC6 Java 8 기본 후보 추가 확인 | 환경 변수 없이 지정 8u202를 찾는 행렬 15개 통과 |
| Node.js 드라이버 | Node.js 22에서 기존 116개 통과 |
| Python 드라이버 | Python 3.2·3.13.1 각각 기존 124개 통과 |

Bun의 동시 UPDATE 값 보존 시험은 기본 30초 재시도 한도를 넘는 경우가 있어 그 시험의 DB 제한을 120초, 시험 제한을 180초로 지정했다. 마지막 Bun 42개와 Node.js 15개가 통과했다. Java 7 TLS 종료 오류 조사에서는 정상 bye 뒤 추가 read를 단위 시험으로 재현·제거했고 이후 전체 255개·독립 소비자·jdbc8 회귀가 통과했다.

진단 로그는 %TEMP%/hwdb-validation-logs/2026-10-20/ 아래 프로젝트별 디렉토리에 보관한다. 최초 실패 로그와 수정 후 검증 로그를 함께 남긴다.

## 다음 범위

1. PD-6의 ODBC 실행 전 메타데이터·SQLCancel·질의 제한 시간·진단 매핑 시험. 서버 의존성은 해소했으며 winodbc는 계획 단계이다.
2. nodejsDriver·pythonDriver 공개 API의 prepare/describe·cancel 연동. JDBC6·JDBC8의 연동은 완료했다.
3. Python PY-4 이후 TLS·UDP, jdbc8 13-5 범용 도구의 실제 등록·화면 검증. 자동 통합·메타데이터·독립 소비자는 완료했다.
4. 리눅스·macOS·실제 원격망·장시간 부하. 복합 질의의 외부 정렬과 중간 메모리 제한은 별도 확장이다. GUI 보류는 유지한다.

재검증 때 HWDB_JAVA6_HOME·HWDB_JAVA7_HOME은 위 지정 경로, HWDB_JAVA8_HOME·HWDB_JAVA21_HOME은 임시 경로로 지정한다. HWDB_TEST_RUNTIME에 Node.js 22 경로를 넣고 jdbc6의 test:integration·test:extensions·test:matrix·test:consumer, jdbc8의 npm test·test:extensions·test:consumer를 실행한다. 서버와 각 드라이버의 PROGRESS.md에 세부 결과를 기록했다.
