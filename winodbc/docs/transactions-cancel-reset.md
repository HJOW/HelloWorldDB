# 트랜잭션·취소·시간 제한·연결 초기화

WO-8의 구현 규칙이다. [서버 규약 17절](../../rdbms/docs/protocol.md#17-준비-문장과-취소-2026-10-20-확장-규약), [SQLEndTran](https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/sqlendtran-function?view=sql-server-ver17), [SQLCancel](https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/sqlcancel-function?view=sql-server-ver17)을 따른다. Manager의 실제 풀 인수는 ODBC 3.8 보고 및 WO-13과 함께 검증해야 한다.

## 트랜잭션

AUTOCOMMIT은 기본 ON이다. OFF에서 SQLEndTran(DBC, COMMIT/ROLLBACK)은 해당 세션의 서버 명령을 실행한다. ENV 호출은 연결들을 각각 처리하고, 하나가 실패해도 나머지를 시도한다. 실패한 DBC에 원래 진단을 남기고 ENV에는 25S01을 기록한다. 분산 트랜잭션이나 원자적인 전체 커밋을 제공하지 않는다. ON 상태에서의 EndTran은 데이터 변경 없이 성공한다.

격리는 READ COMMITTED 하나이며 다른 수준은 HYC00이다. DDL·GRANT/REVOKE는 서버의 실행 전후 자동 커밋을 따른다. SQL_TXN_CAPABLE은 SQL_TC_DDL_COMMIT이다. 커밋/롤백 뒤 열린 결과는 보존하고 SQL_CB_PRESERVE로 보고한다. 연결 종료는 미커밋 변경을 롤백한다. 트랜잭션 종료 중 연결을 잃으면 08007로 결과가 불확실함을 알리고 자동 재전송하지 않는다.

## 취소와 수명

한 DBC의 실행은 해당 연결의 mutex로 직렬화하고 서로 다른 DBC는 독립적으로 실행한다. 수신 스레드 하나가 요청 ID에 따라 promise와 완료 상태를 전달한다. SQLCancel은 STMT 실행 mutex를 기다리지 않고 현재 실행의 ID로 별도 cancel 요청을 보낸다. 연결과 요청 제어 객체는 공유 수명으로 보호하며 임의 핸들을 역참조하지 않는다.

배열 실행 및 실행 시 데이터 대화마다 별도의 작업 제어 객체를 둔다. 이전 작업을 취소하던 스레드가 새 실행의 취소 상태를 바꾸지 않는다. 서버가 실행 대기열에서 막 꺼내는 동안 notRunning이 반환되는 경우 같은 ID만 제한적으로 다시 취소한다. accepted는 접수이며 원래 실행의 최종 응답을 기다린다. tooLate 또는 정상 완료가 오면 실제 성공 결과를 보존한다. 정상 SELECT 완료와 사용자 취소가 경합하면 Manager 규약에 맞게 결과 커서는 닫고 메타데이터·실제 완료 반환값은 보존한다.

서버의 57014/8010은 사용자 취소에서 HY008로, 시간 초과에서 HYT00 또는 HYT01로 바꾼다. native error와 메시지의 원래 SQLSTATE 표기는 유지한다. 다른 스레드의 SQLCancel은 실행 측 진단을 지우거나 자신의 진단을 게시하지 않는다. NEED_DATA의 로컬 취소는 누적 입력과 해당 진단을 지우며 준비 문장·바인딩은 유지한다. 유휴 SQLCancel은 다음 실행이나 열린 커서에 영향을 주지 않는다.

## 시간 제한

| 속성 | 기본/단위 | 적용 범위 |
|---|---|---|
| LOGIN_TIMEOUT | 0, 초 | DNS·TCP 연결·hello·SCRAM 인증의 공통 deadline |
| CONNECTION_TIMEOUT | 0, 초 | 서버 요청의 송신 대기·JSON/프레임 송신·응답 대기 |
| QUERY_TIMEOUT | 0, 초 | execute/executePrepared 요청. 배열은 각 set의 실제 실행에 적용하며 앱의 PutData 입력 대기는 제외 |

0은 제한 없음이다. 연결과 질의 제한을 함께 지정하면 먼저 만료하는 쪽을 적용하고 같으면 질의 제한으로 처리한다. Windows 이름 조회는 취소 가능한 GetAddrInfoExW를 사용한다. DNS/TCP/hello/인증에 같은 로그인 deadline을 전달하여 단계마다 제한 시간을 새로 시작하지 않는다. 암호 계산 등 CPU 작업은 동기 실행이며 다음 I/O 전에 deadline을 확인한다.

취소 가능한 실행의 제한 시간이 지나면 서버 cancel을 시도하고 원래 결과와 응답 ID를 동기화한다. cancel 요청 한 번의 응답 제한은 2초이며 notRunning 경합에서는 10ms 간격으로 최대 20번 같은 ID를 시도한다. 그 뒤 원래 실행 응답에 최대 2초의 정리 유예를 두므로 API 반환이 설정한 실행 제한보다 늦을 수 있다. 최종 정상 결과를 받으면 그 결과를 보존한다. 원래 결과가 끝내 오지 않거나 프레임 송신 중 실패하면 연결을 dead로 두어 재사용하지 않으며 결과가 불확실함을 알린다. SQL이나 DML을 자동 재실행하지 않는다. CONNECTION_TIMEOUT은 유휴 연결을 자동 종료하는 속성이 아니다.

## 연결 초기화

SQL_ATTR_RESET_CONNECTION에는 SQL_RESET_CONNECTION_YES만 허용한다. 이 속성은 [ODBC 3.8 Manager와 드라이버 사이의 계약](https://learn.microsoft.com/en-us/sql/odbc/reference/develop-driver/upgrading-a-3-5-driver-to-a-3-8-driver)이며 앱에서 Manager를 경유해 직접 설정하는 API로 안내하지 않는다.

서버에 포괄적인 reset 요청이 없으므로 기존 세션을 닫고 같은 자격 증명과 접속 옵션으로 새 세션을 인증한다. 기존 세션의 커서·준비 ID·미커밋 변경·잠금을 먼저 폐기한다. 현재 테이블스페이스가 NULL이었던 경우도 새 로그인으로 복원하며 타임존은 로그인 기본값으로 돌아간다. DSN은 처음에 해석한 옵션으로 보관하므로 초기화 중 DSN을 다시 읽어 접속 대상을 바꾸지 않는다.

재인증 암호는 CryptProtectMemory(SAME_PROCESS)로 보호하여 보관한다. 일시적으로 복원한 버퍼는 사용 뒤 지운다. 암호를 접속 문자열 출력·진단·로그에 넣지 않는다. 서버에서 암호가 바뀌어 재인증에 실패하거나 안전한 초기화를 수행할 수 없으면 성공으로 풀에 반환하지 않고 연결을 dead로 표시한다.

정상 초기화는 자동 커밋·연결/로그인 제한·metadata ID·quiet mode와 STMT의 query timeout·max rows·NOSCAN·커서 이름을 기본값으로 돌린다. 모든 자동/명시 DESC의 바인딩·배열/offset/status/processed 포인터와 진단을 비운다. 할당된 핸들 및 descriptor 연결 관계는 유지하며 앱 소유 메모리를 해제하지 않는다. 초기화한 준비 핸들의 Execute는 HY010이다. NEED_DATA 중에는 먼저 입력 대화를 취소해야 한다.

## 검증 경로

`tests/driver_manager/transaction_cases.cpp`는 실제 Manager와 서버로 커밋 가시성·롤백·DDL 자동 커밋·ENV 종료·연결 종료 롤백·커서 보존, 잠금/CPU 취소·이전 트랜잭션 보존, 같은 DBC 직렬화와 다른 DBC 진행, query/connection timeout·재사용·늦은 취소를 검사한다.

`tests/integration/reset_probe.cpp`는 DLL을 직접 적재하여 reset 속성과 NULL 테이블스페이스·타임존·미커밋 행·준비 문장·커서·앱 버퍼·암호 변경 뒤 실패/폐기를 검사한다. 이는 Manager 풀 재사용을 통과했다는 뜻이 아니다. `protocol.test.mjs`의 결함 주입은 로그인 누적 deadline, 취소 ACK와 원래 실행의 분배, 원래 응답 유실, 늦은 취소의 정상 완료, 12MiB 송신 정체 및 DML 재실행 부재를 검사한다.
