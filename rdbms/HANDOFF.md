# RDBMS 후속 구현 인수인계 — 2026-10-20

## 종료 기준과 현재 상태

사용자가 **이번 오류 수정까지만 반영하고 테스트는 다음 작업으로 남기도록 지시했다.** 따라서 추가 빌드·테스트를 시작하지 않고 종료한다. 아래 구현은 소스에 반영했으나 **전체 검증 완료로 판정하지 않는다.** 기존 1 ~ 11단계 완료 기록은 이번 변경 전의 기록이다. 커밋·푸시는 하지 않았다.

사양은 [AGENTS.md](../AGENTS.md) 상세 8-2, 확장 요청의 규약은 [docs/protocol.md](docs/protocol.md) 17절이다. 개발 체크리스트는 [PREPARE.md](PREPARE.md), 전체 진행 기록은 [PROGRESS.md](PROGRESS.md)를 함께 읽는다.

## 반영한 구현

| 범위 | 소스와 동작 |
|---|---|
| 기능 협상·새 요청 | `net/protocol.ts`, `net/messageHandler.ts`. 프로토콜 v1 유지, `helloOk.capabilities = ["prepareDescribe", "cancel"]`. prepare/describe/executePrepared/closePrepared/cancel과 응답·필드 검증 추가 |
| 실행 없는 분석 | `exec/describe.ts`, `executor.ts`, `expression.ts`. 카탈로그·타입 범위로 결과/파라미터를 분석한다. CAST·컬럼 문맥·타입 힌트를 사용하고 미정 타입은 UNKNOWN으로 전송한다. DML·DDL을 실제로 실행하거나 자동 커밋하지 않는다 |
| 준비 문장 수명 | `session/session.ts`. 세션별 SQL·AST·타입 힌트를 보관한다. 최대 64개·SQL UTF-8 합계 16 MiB. ID는 Database 전체에서 증가하여 세션 간 ID 혼동을 막는다. USE 이력과 객체 정의 변경의 전역 revision으로 보수적으로 무효화하고 설명/실행 때 권한을 다시 확인한다 |
| 협력 실행·취소 | `exec/work.ts`와 실행기·식·집계·DML·제약 검사. 동기 API는 같은 실행 단계를 즉시 소진하고 비동기 API는 일정 작업량마다 이벤트 루프에 제어를 돌린다. 큰 질의 정렬은 병합 정렬을 사용한다. 취소는 57014/8010이며 문장 표시까지 되돌린다 |
| 취소 우선 처리 | `messageHandler.ts`. 같은 연결의 활성 실행 ID만 대상으로 대기열을 우회한다. cancelAck의 accepted/notRunning/tooLate와 원래 요청의 최종 응답을 구분한다. DDL 자동 커밋 이후·COMMIT 등 확정 단계는 취소하지 않는다 |
| 읽기·동시성 | `session.ts`, B+Tree `iterate`. 양보 중 다른 세션이 커밋/DDL을 수행하면 다음 실행 단계 전에 revision을 검사하고 해당 문장만 되돌려 재시도한다. 제한 시간 내 일관된 실행이 안 되면 40001이다. 같은 세션에서 실행 중인 비동기 문장에 동기 execute를 섞는 것은 25001로 거부한다 |
| 조회·커서 | `exec/rowSpool.ts`, `streamQuerySteps`, `net/cursors.ts`. 단순 조회와 CROSS JOIN의 스캔·필터·투영·행 제한을 지연 순회하고 결과는 임시 파일에 보관한다. 정렬·집계·DISTINCT·집합 연산·그 밖의 복합 경로는 기존 구체화 실행 후 파일로 보관한다. 최종 fetch·커서 닫기·연결 종료·실패 시 파일을 정리한다. 모든 중간 연산의 메모리를 제한하는 외부 정렬까지 구현한 것은 아니다 |
| 메타데이터·인덱스 | SYS_COLUMNS에 권한으로 보이는 뷰 컬럼도 행 없이 제공한다. 뷰 식의 null 허용 여부는 UNKNOWN이다. CREATE INDEX에서 인덱스 이름의 테이블스페이스 생략 시 대상 테이블의 것을 사용한다. DROP INDEX 생략 규칙은 현재 테이블스페이스 그대로이다 |
| 내장 클라이언트 | `client/connection.ts`. 단일 pending 맵 수신 경로를 유지하며 `startRequest()`로 원래 요청 ID를 얻는다. 기능 없는 서버에는 확장 요청을 보내지 않고 0A000으로 알린다 |

저장 파일 포맷은 변경하지 않았다. 네 외부 드라이버의 prepare/describe/cancel 공개 API 연동은 별도 후속 작업이다. 이번 JDBC 변경은 아래 호환성 오류 수정에 한정한다.

## 마지막으로 수정한 오류

1. **NULL 파라미터 분석의 XX000**: 네트워크 조회를 파일로 보내기 전 타입 분석에서 `SELECT ?, ?, ?`의 NULL을 문자열로 펼쳐 `text is not iterable`이 발생했다. `expression.ts`에서 NULL을 NULL_LITERAL_TYPE(또는 기대 타입)으로 처리했다. `streaming.test.ts`에 정수·한글·NULL을 함께 전달하는 경우를 추가했다.
2. **잘못된 타입 힌트의 오류 위치/SQLSTATE**: 합성한 CAST 구문의 파서 오류가 그대로 노출되던 것을 `describe.ts`에서 22023의 타입 선언 오류로 정리했다.
3. **JDBC 뷰 컬럼 중복**: 서버가 SYS_COLUMNS에 뷰 컬럼을 제공한 뒤에도 jdbc8의 보완 조회가 같은 컬럼을 다시 추가해 기존 시험에서 `expected=V actual=ID`로 실패했다. jdbc6·jdbc8의 `JdbcDatabaseMetaData.viewColumns()`에서 이미 받은 객체는 보완하지 않게 수정했다. IS_NULLABLE=UNKNOWN은 JDBC의 columnNullableUnknown과 빈 문자열로 대응시켰다. **이 JDBC 수정 후 빌드·재시험은 아직 하지 않았다. 기존 JAR은 수정 전 결과물이므로 다음 작업에서 다시 빌드한다.**

## 이미 실행된 검증과 미검증 범위

- 수정 중간의 Node.js 22.23.3 전체 시험: **945개 중 942 통과·2 실패·1 건너뜀**. 실패는 위 NULL 처리와 타입 힌트 오류 코드였으며 이후 코드를 수정했다. 건너뜀은 Windows의 기존 SIGTERM 시험이다. 이 결과를 최종 통과로 읽으면 안 된다. 로그: `rdbms/.codex-rdbms-node22.log`.
- 마지막 서버 오류 수정 후, 사용자 종료 지시 전에 시작했던 Node.js 24.19.0 집중 시험은 이미 종료되어 **55개 통과·실패/건너뜀 0**이었다. 실행 파일은 `exec/prepare`, `exec/streaming`, `net/udp` 세 시험이다. 최종 Node.js 22 전체 시험과 다른 회귀 시험을 대체하지 않는다.
- 중간 스냅샷의 Node.js 드라이버: Node.js 22.23.3에서 116개 통과. 로그: `nodejsDriver/.codex-compat.log`. 최종 서버 코드에 대한 재검증은 다음 작업이다.
- 중간 스냅샷의 Python 드라이버: Python 3.2·3.12.4 각각 124개 통과. 로그: `pythonDriver/.codex-compat.log`. 최종 서버 코드에 대한 재검증은 다음 작업이다.
- jdbc8 호환 시험은 위 뷰 컬럼 중복으로 실패했다. 로그: `jdbc8/.codex-compat.log`. 수정 후 Java 8·21 재시험, jdbc6 Java 6·7·8·21 시험은 **미실행**이다.
- 이번 변경에 대한 Bun 시험, 비Windows 장비 시험, 범용 DB툴/ODBC 연동 시험은 **미실행**이다. 설치된 Bun은 1.4.2이다. 새 드라이버 API가 구현되었다고 표시하지 않는다.
- 사용자 종료 지시 후 새 빌드·테스트를 시작하지 않았다. 이미 종료된 실행의 결과만 회수했다. 로컬 `.codex-*.log`는 진단 자료로 남긴다.

## 다음 작업 순서

1. 위 마지막 오류 수정과 현재 diff를 먼저 읽는다. 특히 JDBC 두 파일의 보완 조회/UNKNOWN 매핑, 타입 전용 분석의 NULL·EXISTS·논리식·CASE, 취소/재시도의 문장 단위 되돌리기, 파일 커서 수명과 정리를 검토한다.
2. rdbms를 다시 빌드하고 prepare·streaming·prepareCancel·protocol·clientSecurity·동시성·UDP 집중 시험을 실행한다. 그 뒤 **Node.js 22 전체 시험**을 실행한다. 최종 시험 개수는 실행 결과로 기록한다.
3. Bun에서 새 기능·TCP/TLS/로컬/UDP·유실/중복·10세션 시나리오를 실행한다. TLS와 SIGTERM의 기존 런타임/OS 차이는 별도 기록한다.
4. jdbc8을 다시 빌드하여 Java 8·21 전체 시험을 실행하고, jdbc6도 실제 JDK 6으로 다시 빌드하여 Java 6·7·8·21 통합 시험과 빌드 회귀를 실행한다. 뷰 컬럼 순서·중복 없음·컬럼 패턴 필터·UNKNOWN 진단을 확인한다.
5. 최종 서버 코드로 nodejsDriver와 Python 3.2·3.12.4 기존 회귀 시험을 다시 실행한다. 새 prepare/describe/cancel API 연동은 각 드라이버 PROGRESS.md의 미완료 체크리스트를 별도로 진행한다.
6. `docs/protocol.md` 17절의 확장 규약과 기존 본문의 READY 메시지/요청·응답 표/오류 표/한도/기존 메모리·동기 실행 한계 설명을 일치시킨다. `docs/manual.md`, `docs/transactions.md`, `docs/verification.md`, 관련 소스의 예전 동기 실행 설명도 함께 정리한다. **이 문서 정리는 아직 남아 있다.**
7. 검증 결과를 PROGRESS.md·PREPARE.md·루트 진행 문서에 반영한 뒤 완료 기준을 판정한다. 미실행·실패를 완료로 바꾸지 않는다. ODBC와 외부 드라이버의 새 API 통합 시험은 해당 프로젝트 구현 후의 후속 작업이다.

재개할 때 사용할 PowerShell 명령 예시(이번 작업에서는 실행하지 않음):

```powershell
Set-Location H:\Workspace\git\HelloWorldDB\rdbms
$env:PATH = 'C:\Program Files\nodejs22;' + $env:PATH
$env:HWDB_TEST_RUNTIME = 'C:\Program Files\nodejs22\node.exe'
npm run build
node --test dist/test/exec/prepare.test.js dist/test/exec/streaming.test.js dist/test/net/prepareCancel.test.js dist/test/net/protocol.test.js dist/test/net/clientSecurity.test.js dist/test/txn/concurrency.test.js dist/test/net/udp.test.js
npm test

# 이후 Bun으로 실제 서버를 띄우는 시험에서는 이 변수도 Bun으로 바꾼다.
$env:HWDB_TEST_RUNTIME = 'C:\Users\BUZZ\.bun\bin\bun.exe'
bun test --timeout 120000 dist/test/exec/prepare.test.js dist/test/exec/streaming.test.js dist/test/net/prepareCancel.test.js dist/test/net/tcp.test.js dist/test/net/udp.test.js dist/test/net/localChannel.test.js dist/test/txn/concurrency.test.js dist/test/integration/concurrency.test.js

# 외부 드라이버 회귀는 서버 런타임을 다시 명시한다.
$env:HWDB_TEST_RUNTIME = 'C:\Program Files\nodejs22\node.exe'
Set-Location ..\jdbc8
npm test
Set-Location ..\jdbc6
npm run test:integration
npm run test:matrix
Set-Location ..\nodejsDriver
npm test
Set-Location ..\pythonDriver
& 'C:\Program Files\Python\312\python.exe' scripts/run_tests.py --python 'C:\Program Files\Python\302\python.exe' --python 'C:\Program Files\Python\312\python.exe'
```

각 명령의 종료 코드와 실패 원인을 확인한 뒤 다음 명령으로 진행한다. Java 8은 `C:\Program Files\Java\jdk8u432-b06`, Java 21은 `C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot`을 사용한다. jdbc6의 이 PC용 JDK 6·7 경로는 해당 프로젝트 진행 문서를 따른다.
