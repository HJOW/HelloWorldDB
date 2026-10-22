# 서버 기능·진단·수명 계약

기준은 [프로토콜 명세](../../rdbms/docs/protocol.md)(버전 1)과 [준비 문장·취소 규약](../../rdbms/PREPARE.md)이다.
이 문서는 UO-0 에서 확인한 **드라이버가 의존하는 서버 동작**이며, ODBC 드라이버의 실제 실행 시험을 대신하지 않는다.

## 1. 접속 경로

- 드라이버는 **TCP** 와 **TLS over TCP**, **UDP 신뢰성 계층**을 쓴다. 서버의 로컬 전용 채널(유닉스 도메인 소켓 `/tmp/helloworlddb-<포트>.sock`)은 `hwdb` CLI 전용이므로 ODBC 드라이버가 쓰지 않는다.
- 호스트와 포트 번호만으로 인스턴스를 지정한다. SID·데이터베이스 이름은 없다.
- 기본 포트는 7410 이다. `--udp` 접속은 같은 포트 번호의 UDP 를 쓴다.
- 서버 `maxConnections` 는 TCP·UDP 세션 합계이다. 드라이버의 연결 풀을 쓰는 앱은 이 한도보다 작게 유지해야 한다. (기본 10)

## 2. 기능 협상

- `hello.versions` 는 `[1]` 을 보낸다. `helloOk.version` 이 1 이 아니면 접속하지 않는다.
- `helloOk.capabilities` 가 없으면 빈 목록이다. 드라이버는 광고되지 않은 `prepareDescribe`·`cancel` 요청을 보내지 않는다.
- 현재 서버는 `prepareDescribe`, `cancel` 을 광고한다.

| ODBC 동작 | 서버 요청/응답 | 필요 기능·조건 | 완료 증거·시험 |
|---|---|---|---|
| 로그인 | hello→authStart→authFinish | helloOk 검증, READY 전 실행 금지 | nonce·반복 횟수·서버 서명·위조 응답 거부, T-AUTH |
| 직접 실행 | execute→rows/ok/error | 기능 없는 v1 에서도 가능 | 실제 서버 CRUD·fetch, T-EXEC |
| 준비 | prepare(sql, parameterTypes?)→prepared | prepareDescribe, 없으면 로컬 HYC00 | 실행 전 분석의 무부작용, T-PREPARE |
| 결과/파라미터 메타데이터 | describe(statement, parameterTypes?)→description | prepareDescribe, UNKNOWN 보존 | 컬럼·힌트·resultKind 일치, T-META |
| 준비 실행 | executePrepared(statement, params, fetchSize?) | prepareDescribe | 버퍼 변경·반복 실행·권한 재검사, T-PARAM |
| 준비 해제 | closePrepared→preparedClosed | prepareDescribe, 없는 ID 도 성공 | 커서와 독립 해제, T-PREPARE |
| fetch/결과 닫기 | fetch→rows, closeCursor→cursorClosed | 커서 ID 와 준비 ID 분리 | 조기·마지막 닫기, 16개 한도, T-CURSOR |
| 실행 취소 | cancel(targetId)→cancelAck | cancel, execute/executePrepared 한정 | 원 실행의 최종 응답까지 확인, T-CANCEL |
| NEED_DATA 취소 | 서버 전송 전 로컬 정리 | cancel 기능 없어도 가능 | 연결 재사용·미입력 자원 정리, T-DAE |
| commit/rollback/autocommit | execute 의 트랜잭션 SQL | READ COMMITTED 만 | 앞선 변경 보존·DDL 자동 커밋, T-TXN |
| 풀 반환 reset | 전용 요청 없음, 연결 닫기→재인증 | SQL_ATTR_RESET_CONNECTION=YES | 세션·상태 완전 초기화, T-RESET |

- 메타데이터를 얻으려고 SQL 을 실행하거나 실패 뒤 rollback 하는 편법을 쓰지 않는다.
- `cancel` 기능이 없는 서버에는 실행 중 `SQLCancel` 과 0보다 큰 `SQL_ATTR_QUERY_TIMEOUT` 을 `HYC00` 으로 거부한다. 유휴 `SQLCancel`·NEED_DATA 취소는 로컬 동작이다.
- 기능 미지원 시 native code 는 로컬 진단 `0` 이고, 원래 wire 의미 `0A000` 과 ODBC `HYC00` 의 차이를 기록한다.

## 3. 준비·설명 메시지 검증

- `prepared`/`description` 의 `statement`, `parameterCount`, `parameters`, `columns`, `resultKind` 를 확인한다.
- `parameters[].index` 는 1부터이다. UNKNOWN 에는 길이·정밀도를 지어내지 않는다.
- `parameterTypes` 힌트 배열 길이는 파라미터 수와 같아야 한다. 힌트는 `CAST` 를 대신하는 분석 보조이며, 값을 SQL 문자열에 치환하지 않는다.
- nullable 은 UNKNOWN 이 일반적이다. 실행 전 메타데이터의 UNKNOWN 을 NOT NULL 로 추정하지 않는다.
- 준비 문장은 세션당 64개, SQL UTF-8 합계 16 MiB, 열린 커서는 16개이다. `USE`·객체 정의 변경 뒤에는 `0A000`/`8009` 로 재준비를 요구한다. 드라이버는 자동 재실행하지 않고 앱에 재준비 필요를 알린다.
- 커밋·롤백은 열린 결과 커서를 무효화하지 않는다. `closePrepared` 도 열린 결과를 닫지 않는다. 드라이버가 소유 관계를 분리해 정리한다.

## 4. 취소·시간 제한

- `cancel` 은 별도의 양의 request ID 를 쓰고, `targetId` 는 현재 실행 요청에 고정한다. `cancelAck` 의 `accepted` 는 완료 증명이 아니다.
- 수신 경로 하나에서 원 실행 응답과 `cancelAck` 를 `id` 로 나눈다. `accepted` 뒤 정상 완료·`tooLate`·취소 완료가 모두 가능하다.
- 취소된 문장은 `57014` 로 끝나고 그 문장의 변경만 되돌린다. 앞선 수동 트랜잭션의 성공 변경과 연결은 유지된다.
- 서버는 준비/설명/해제/fetch 의 정상 취소 기능을 광고하지 않는다. 이 구간의 취소 성공을 ODBC 에서 광고하지 않는다.
- 커밋·DDL·권한 변경의 확정 단계는 취소하지 않는다.

| 상황 | wire SQLSTATE/native | ODBC 진단·상태 정책 | 시험 ID |
|---|---|---|---|
| 앱 SQLCancel 로 실제 취소 완료 | 57014/8010 | 실행 함수에 HY008, native 8010·원래 57014·영문 메시지 보존 | T-CANCEL |
| query timeout 이 먼저 발생한 실제 취소 | 57014/8010 | 실행 함수에 HYT00, native 8010·원래 상태 보존 | T-TIMEOUT |
| accepted 뒤 정상 완료·tooLate | 정상 결과 | 실제 결과 반환, 취소로 꾸미지 않음 | T-CANCEL |
| 기록된 취소 원인이 없는 57014 | 57014/8010 | 원래 57014 보존, 다른 요청에 원인 전파 금지 | T-CANCEL |
| 잠금 대기 제한·교착 | 55P03 / 40P01 | 원래 상태·native 보존, 교착 때 전체 트랜잭션 롤백 확인 | T-TXN |
| 준비 ID 없음·무효화 | 26000/8008, 0A000/8009 | 원래 상태·native 보존, 이전 성공 실행 재시도 금지 | T-PREPARE |
| 인증 실패·CONNECT 거부 | 28000/7000 또는 7006 | 보존, 물리 연결 닫기 | T-AUTH |
| TLS 검증 최종 실패 | 클라이언트 08001/8007 | 08001/8007, 검증 유지한 최대 3회 시도·원인 포함 | T-TLS |
| 인증 후 통신 단절·잘못된 프레임 | 08006/8006 또는 08P01/8000 | ODBC 08S01, native·원인 보존, 미확정 DML 재실행 금지 | T-PROTO |
| 서버 종료·유휴 종료 id=0 | 57P01/6003, 57P05/8002 | 원래 상태를 포함한 08S01, 모든 대기 요청 실패 | T-PROTO |
| 로그인 시간 제한 | 응답 없을 수 있음 | HYT00, 연결 정리, 서버 인증 10초와 앱 제한 구분 | T-CONNECT |
| 연결 동작 제한 | 응답 없을 수 있음 | HYT01, 자원 정리 | T-TIMEOUT |
| 권한·제약·SQL 문장 오류 | 서버 SQLSTATE/native | 변환 없이 보존, 연결 재사용 가능 | T-EXEC |

ODBC 진단의 영문 메시지에 원 서버 상태를 포함하고 native 번호를 보존한다. `SQLCancel` 자체의 성공과 실행 함수의 `HY008` 을 혼동하지 않는다. 연결을 잃어 취소 완료를 확인할 수 없으면 `08S01` 이다.

## 5. 값 표현

- BIGINT·DECIMAL·날짜시간·INTERVAL 은 문자열, 이진 값은 16진 문자열이다. 실제 타입은 컬럼 메타데이터에 있다.
- NULL 은 JSON null, 빈 문자열·빈 이진은 별개의 값이다.
- 서버 메시지 최대 크기는 16 MiB(인증 전 64 KiB)이다. 한 조회 결과는 fetch 크기 단위로 나누어 받는다.
- 서버는 UTF-8 만 쓴다. 잘못된 UTF-8 은 `08P01`/`22021` 이며 드라이버가 임의로 대체 문자를 만들지 않는다.

## 6. 아직 서버에 요청하지 않은 것

- ODBC 카탈로그(`SQLTables`, `SQLColumns` 등)는 서버 딕셔너리 뷰(`SYS_*`)를 SQL 로 조회해 구성한다. 서버에 ODBC 전용 요청을 새로 만들지 않는다. (UO-9)
- ODBC descriptor·배열은 서버 프로토콜에 없다. 드라이버가 로컬에서 조립·분해한다. (UO-7)
- 서버에 ODBC 시험용 결함 주입 기능을 넣지 않는다. 시험은 프록시·테스트 서버 설정·기존 오류 경로로 만든다.
