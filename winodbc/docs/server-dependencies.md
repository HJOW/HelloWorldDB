# 서버 기능·진단·수명 계약

WO-0에서 [protocol.md](../../rdbms/docs/protocol.md)의 1~17절과 [PREPARE.md](../../rdbms/PREPARE.md)를 확인했다. 현재 서버의 PD-1~PD-5는 완료되어 있다. **PD-6의 ODBC 시험은 아직 미실행**이며 이 문서의 매핑만으로 완료 처리하지 않는다. 서버 프로토콜·소스는 이번 단계에서 변경하지 않는다.

## 기능 협상과 요청 대응

프로토콜 version=1, 인증 SCRAM-SHA-256, helloOk.capabilities가 없으면 빈 목록이다. 모르는 기능 이름은 무시하고 알려진 기능만 활성화한다. 기능별 시험 T-CAPS는 prepareDescribe/cancel의 네 조합과 목록 생략을 모두 포함한다.

| ODBC 동작 | 서버 요청/응답 | 필요 기능·호출 조건 | 완료 증거·시험 ID |
|---|---|---|---|
| 로그인 | hello→authStart→authFinish | helloOk 검증, READY 전 실행 금지 | nonce·반복수·서버 서명·위조 응답 거부, T-AUTH |
| 직접 실행 | execute→rows/ok/error | 기능 없는 v1에서도 가능 | 실제 서버 CRUD·fetch, T-EXEC |
| 준비 | prepare(sql, parameterTypes?)→prepared | prepareDescribe; 없으면 로컬 HYC00 | 실행 전 분석의 무부작용, T-PREPARE |
| 결과/파라미터 메타데이터 | describe(statement, parameterTypes?)→description | prepareDescribe; UNKNOWN 보존 | 컬럼·힌트·resultKind 일치, T-META |
| 준비 실행 | executePrepared(statement, params, fetchSize?) | prepareDescribe | 버퍼 변경·반복 실행·권한 재검사, T-PARAM |
| 준비 해제 | closePrepared→preparedClosed | prepareDescribe; 없는 ID도 성공 | 커서와 독립 해제·누수 없음, T-PREPARE |
| fetch/결과 닫기 | fetch→rows, closeCursor→cursorClosed | cursor ID와 statement ID 분리 | 마지막/조기 닫기·16개 한도, T-CURSOR |
| 실행 취소 | cancel(targetId)→cancelAck | cancel; execute/executePrepared에 한정 | 원 실행의 최종 응답까지 확인, T-CANCEL |
| NEED_DATA 취소 | 서버 전송 전 로컬 상태 폐기 | cancel 기능 없어도 가능 | 연결 재사용·미입력 자원 정리, T-DAE |
| commit/rollback/autocommit | execute의 트랜잭션 SQL | READ COMMITTED만 | 앞선 변경 보존·DDL 자동 commit, T-TXN |
| 풀 반환 reset | 전용 요청 없음, 연결 닫기→재인증 | SQL_ATTR_RESET_CONNECTION=YES | 세션·상태 완전 초기화, T-RESET |

기능 없는 서버에는 prepare/describe/executePrepared/closePrepared/cancel 요청을 보내지 않는다. 메타데이터를 알아내려고 SQL을 실행하거나 실패 후 rollback하는 편법도 쓰지 않는다. cancel 없는 서버에서는 실행 중 SQLCancel과 0보다 큰 query timeout 설정을 HYC00으로 거부한다. 유휴 SQLCancel·NEED_DATA 취소는 별도 로컬 동작이다. 지원하지 않는 기능의 native code는 로컬 진단 0이며, 원래 wire 의미 0A000과 ODBC HYC00의 차이를 기록한다.

prepared/description의 statement·parameterCount·parameters·columns·resultKind를 검증한다. parameters의 index는 1부터, resultKind는 rows/ok, UNKNOWN에는 길이/정밀도를 추가하지 않는다. 힌트 배열은 파라미터 수와 같아야 한다. nullable은 UNKNOWN이 일반적이다. 원래 SQL과 바인딩 정보를 유지하여 필요한 힌트로 describe하되 값을 SQL 문자열에 치환하지 않는다.

준비 문장은 세션당 64개·SQL UTF-8 합계 16MiB, 열린 커서는 16개이다. USE/서버 정의 revision 변경은 0A000/8009로 재준비를 요구한다. 관계없는 DDL도 무효화할 수 있다. GRANT/REVOKE는 다음 분석·실행에 적용된다. 자동 재실행하지 않고 앱에 재준비 필요를 알린다. closePrepared는 이미 열린 결과를 닫지 않으며, commit/rollback도 결과 커서를 무효화하지 않는다.

## 취소·시간 제한과 진단 매핑

cancel은 별도의 양의 request ID를 쓰고 targetId는 현재 실행 요청에 고정한다. accepted는 완료 증명이 아니며 notRunning/tooLate/정상 결과 경합을 모두 처리한다. 수신 경로 하나에서 원 실행과 cancel 응답을 ID로 나눈다. 현재 서버는 준비/설명/해제/fetch를 정상 취소하는 기능이 없으므로 이 구간의 취소 성공을 광고하지 않는다. 긴 blocking 통신 실패를 접속 종료로 처리한 것은 정상 실행 취소와 구분한다.

| 상황 | wire SQLSTATE/native | ODBC 진단·상태 정책 | 시험 ID |
|---|---|---|---|
| 앱 SQLCancel로 실제 취소 완료 | 57014/8010 | 실행 함수에 HY008, native 8010·원래 57014·영문 메시지 보존 | T-CANCEL |
| query timeout이 먼저 발생한 요청의 실제 취소 | 57014/8010 | 실행 함수에 HYT00, native 8010·원래 상태 보존 | T-TIMEOUT |
| accepted 뒤 정상 완료/tooLate | 정상 결과 | 실제 결과 반환, 취소됐다고 꾸미지 않음 | T-CANCEL |
| 기록된 취소 원인이 없는 57014 | 57014/8010 | 원래 57014 보존, 다른 요청에 원인 전파 금지 | T-CANCEL |
| 잠금 대기 제한·교착 | 55P03 / 40P01 | 원래 상태/native 보존; 교착 때 전체 txn rollback 확인 | T-TXN |
| 준비 ID 없음·무효화 | 26000/8008, 0A000/8009 | 원래 상태/native 보존, 미리 성공했던 실행을 재시도 안 함 | T-PREPARE |
| 인증 실패·CONNECT 거부 | 28000/7000 또는 7006 | 보존, 해당 물리 연결 닫기 | T-AUTH |
| TLS 검증 최종 실패 | 클라이언트 08001/8007 | 08001/8007, 검증 유지한 최대 3회 시도·원인 포함 | T-TLS |
| 인증 후 통신 단절/잘못된 프레임·응답 | 08006/8006 또는 08P01/8000 | ODBC 08S01, native/원인 보존, Ddead·미확정 DML 재실행 금지 | T-PROTO |
| 서버 종료·유휴 종료 id=0 | 57P01/6003, 57P05/8002 | 원래 상태를 포함한 08S01, 모든 대기 요청 실패 | T-PROTO |
| 로그인 시간 제한 | 응답 없음 가능 | HYT00, 연결 정리, 인증 10초와 앱 제한 구분 | T-CONNECT |
| 연결 동작 제한 | 응답 없음 가능 | HYT01, 자원 정리 | T-TIMEOUT |
| 권한·제약·SQL 문장 오류 | 서버 SQLSTATE/native | 변환 없이 보존, 연결 재사용 여부 확인 | T-EXEC |

ODBC로 매핑하는 진단은 영문 메시지에 원 서버 상태를 포함하고 native 번호를 보존한다. SQLCancel 호출 자체의 성공과 실행 함수의 HY008을 혼동하지 않는다. 시간 제한·수동 취소의 최초 원인을 request별로 기록하며, 확정 단계가 이미 지난 결과를 거짓 rollback으로 보고하지 않는다. 앞선 수동 트랜잭션의 성공 변경은 문장 취소 후에도 보존된다. 연결을 잃어 취소 완료를 확인할 수 없으면 08S01과 Ddead이다.

## 풀 재사용 초기화

서버에는 현재 tablespace를 null로 되돌리거나 모든 임의 세션 SQL을 초기화하는 reset 메시지가 없다. WO-8에서는 SQL_ATTR_RESET_CONNECTION을 받으면 기존 결과·prepared ID·진행 중 문장·미커밋 상태를 정리하고 **물리 연결을 종료한 뒤 원래 접속 설정으로 재인증**한다. 초기 Tablespace/TimeZone 명시 옵션과 생략 상태를 구분한다. 재접속 실패는 Ddead이며 dirty 연결을 풀에 반환하지 않는다. 이 방법은 ODBC 핸들 재사용은 제공하지만 물리 세션 재사용의 성능 이점은 보장하지 않는다.

재인증에 필요한 자격 증명은 DBC 수명 안에서만 보호해 유지하고 close/reset 실패에서 지운다. 비밀번호·SCRAM 키·PWD를 진단/출력 연결 문자열/자체 로그에 남기지 않는다. T-RESET은 USE·SET TIME ZONE·autocommit·미커밋 DML·커서·prepare·STMT 속성·진단·바인딩이 새 사용자에게 남지 않는지 검사한다. 더 효율적인 reset wire 확장은 추후 별도 사양 작업으로 남기며 이 단계의 서버 변경을 요구하지 않는다.

프레임·인증·fetch 한도와 TLS/UDP 규칙은 서버 명세를 그대로 따른다. 4바이트 big-endian 프레임, 인증 전 65536/후 16777216바이트, 파라미터 65535개, fetch 기본 500/상한 100000·소프트 1MiB, SCRAM 반복수 1~10000000을 할당·계산 전에 검사한다. 원격 권한·최대 연결 수는 서버 판정이며 ODBC에 로컬 CLI의 예외를 적용하지 않는다.
