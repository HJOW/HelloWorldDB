# Descriptor와 배열 바인딩

현재 WO-7의 descriptor·행 배열·파라미터 배열 구현을 설명한다. SQLParamData/SQLPutData·NEED_DATA·로컬 취소는 아직 후속이며, 아래의 Manager 재현 사례도 전체 완료 전에 확인해야 한다.

## Descriptor 수명과 필드

STMT는 자동 ARD/APD/IRD/IPD 네 개를 유지한다. 명시 DESC는 같은 연결의 여러 STMT에서 ARD 또는 APD로 공유할 수 있다. SQL_ATTR_APP_ROW_DESC/APP_PARAM_DESC를 NULL 또는 그 자리의 원래 자동 핸들로 설정하면 자동 DESC로 돌아간다. 다른 문장/역할의 자동 DESC는 HY017, 다른 연결의 명시 DESC는 HY024이다. STMT 해제는 자신의 자동 DESC만 해제하며 명시 DESC를 해제하지 않는다. 명시 DESC 해제는 그것을 참조하던 모든 STMT의 자동 DESC를 복원한다. [연결 규칙](https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/sqlsetstmtattr-function?view=sql-server-ver17), [해제 규칙](https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/sqlfreehandle-function?view=sql-server-ver15).

SQLGet/SetDescField와 W 버전, SQLGetDescRec/W, SQLSetDescRec, SQLCopyDesc를 제공한다. SDK에 없는 SQLSetDescRecW는 만들지 않는다. BindCol·BindParameter·SetStmtAttr와 이 API들은 같은 descriptor 레코드/헤더를 쓴다. C 버퍼 정의는 ARD/APD, 바인딩한 SQL 타입은 IPD, 결과 메타데이터는 IRD에 있다. 실행 전에 서버가 설명한 파라미터 메타데이터는 바인딩 값의 복사본이 아니다.

IRD의 결과 메타데이터는 읽기 전용이지만 ARRAY_STATUS_PTR·ROWS_PROCESSED_PTR는 설정할 수 있다. 준비/실행 전 IRD 메타데이터 읽기는 HY007이다. IPD의 TYPE·LENGTH·PRECISION·SCALE·방향·이름 등 허용된 필드는 수정할 수 있다. 입력 파라미터만 지원한다. 타입/정밀도 등을 바꾸면 응용 DATA_PTR를 해제하고, 다시 설정할 때 일관성을 검사한다. SQLCopyDesc는 ALLOC_TYPE을 제외한 필드를 복사하되 핸들 소유권과 원래 자동 할당 관계를 바꾸지 않는다. 서로 다른 연결 간 복사는 두 연결의 잠금을 교착 없이 획득한다. [필드와 접근 권한](https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/sqlsetdescfield-function?view=sql-server-ver17), [복사](https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/sqlcopydesc-function?view=sql-server-ver17).

SQL_ATTR_AUTO_IPD는 서버 capability가 있으면 TRUE이다. SQL_ATTR_ENABLE_AUTO_IPD는 기본 FALSE이며 TRUE이면 prepare 결과로 IPD를 채운다. IPD의 NULLABLE은 동적 파라미터이므로 SQL_NULLABLE이다. 결과 IRD의 NULLABLE과 SQLDescribeParam의 서버 nullable UNKNOWN을 혼동하지 않는다.

필드별 SDK 폭으로 반환한다. COUNT/TYPE/PRECISION/SCALE 등은 SQLSMALLINT, NUM_PREC_RADIX 등은 SQLINTEGER, ARRAY_SIZE/LENGTH는 SQLULEN, OCTET_LENGTH/DISPLAY_SIZE는 SQLLEN, 포인터는 포인터 폭이다. DESC_BIND_TYPE은 32비트 SQLUINTEGER이며 STMT의 SQLULEN 입력도 그 범위 안에서 받는다. BIND_OFFSET_PTR는 부호 있는 SQLLEN을 가리킨다. GetDescFieldW의 문자열 길이는 바이트이고 홀수 바이트 버퍼는 HY090이다. GetDescRecW의 이름 길이는 UTF-16 코드 단위이다. [64비트 필드 목록](https://learn.microsoft.com/en-us/sql/odbc/reference/odbc-64-bit-information?view=sql-server-ver17).

## 행 배열

ROW_ARRAY_SIZE·ROW_BIND_TYPE·ROW_BIND_OFFSET_PTR·ROW_STATUS_PTR·ROWS_FETCHED_PTR를 지원한다. column-wise 데이터 stride는 고정 C 타입의 SDK 크기 또는 가변 C 타입의 BufferLength이며, indicator/length stride는 sizeof(SQLLEN)이다. row-wise는 두 버퍼 모두 ROW_BIND_TYPE을 stride로 쓴다. offset의 부호를 보존하고 곱셈/덧셈/언더플로와 배열 상태 포인터 범위를 검사한다. packed 구조체의 데이터와 indicator는 memcpy로 읽고 쓴다.

Fetch는 서버 묶음 경계를 넘어 요청한 행 수만큼 진행하며 마지막 부분 묶음의 남은 상태는 SQL_ROW_NOROW이다. 실패 행은 SQL_ROW_ERROR, 잘림/손실 경고 행은 SQL_ROW_SUCCESS_WITH_INFO이다. 성공 행이 섞였으면 SQL_SUCCESS_WITH_INFO, 모두 실패했으면 SQL_ERROR이다. 진단의 row는 현재 묶음 안의 1부터 번호이며 ROW_NUMBER는 현재 묶음 첫 행의 전체 결과 내 위치이다.

INDICATOR_PTR와 OCTET_LENGTH_PTR가 다르면 NULL은 indicator에만 SQL_NULL_DATA를 쓰고, non-NULL은 indicator 0·실제 길이를 각 주소에 쓴다. 같은 포인터이면 BindCol의 결합 길이/indicator 규칙을 따른다. NULL 행과 마지막 부분 묶음의 미사용 데이터 버퍼를 초기화하지 않는다. 앱 버퍼를 DLL에서 해제하지 않는다.

SQLGetData는 row array size 1·증가하는 unbound 열의 기존 제한을 유지한다. SQL_GETDATA_EXTENSIONS는 0이고 SQL_GD_BLOCK을 광고하지 않는다. ROW_OPERATION_PTR는 ARD의 주소를 보관하지만 읽기 전용 fetch에 위치 갱신 동작을 추가하지 않는다. [행 중심 바인딩](https://learn.microsoft.com/en-us/sql/odbc/reference/develop-app/row-wise-binding?view=sql-server-ver17).

## 파라미터 배열

PARAMSET_SIZE·PARAM_BIND_TYPE·PARAM_BIND_OFFSET_PTR·PARAM_STATUS_PTR·PARAMS_PROCESSED_PTR·PARAM_OPERATION_PTR를 지원한다. 준비 문장과 파라미터가 있는 ExecDirect의 DML을 set 순서대로 실행한다. 서버의 일괄 API를 흉내 내거나 SQL에 값을 치환하지 않는다. PROCEED/IGNORE를 구분하며 무시한 set은 SQL_PARAM_UNUSED이다. 처리 수는 오류 set을 포함한 현재 1부터 위치이며 정상 완료 시 PARAMSET_SIZE이다.

제약조건/값 변환 오류는 해당 set을 SQL_PARAM_ERROR로 기록하고 다음 set을 계속한다. 일부 성공이면 SQL_SUCCESS_WITH_INFO, 모두 실패하면 SQL_ERROR이다. 연결 단절·트랜잭션 실패·준비 무효화는 중단하고 뒤의 set을 미처리로 남긴다. 서버 요청을 자동 재시도하지 않는다. 진단의 row는 set 번호이다. 성공은 그 문장의 실행 결과를 뜻하며 수동 트랜잭션 전체의 commit을 뜻하지 않는다.

SQLRowCount는 성공한 DML의 영향 행 수를 합산한다. SQL_PARAM_ARRAY_ROW_COUNTS는 SQL_PARC_NO_BATCH이며 별도 set별 row count 결과를 만들지 않는다. 결과를 내는 배열 질의는 실행 전에 HYC00으로 거부하고 SQL_PARAM_ARRAY_SELECTS는 SQL_PAS_NO_SELECT이다. [배열과 오류/처리 수 규칙](https://learn.microsoft.com/en-us/sql/odbc/reference/develop-app/using-arrays-of-parameters?view=sql-server-ver17).

## 확인한 경로와 남은 재현 사례

`descriptors.fields_sharing_lifetime` 내부 시험은 필드 폭·W 길이·복사 후 앱 주소·일관성·교차 연결 복사 경합·자동 복원·주소 오버플로를 검사한다. 네트워크 없이 연결 상태를 주입하는 시험이다. 실제 Manager/서버의 `descriptor_cases.cpp`는 열/packed 행 배열·부분 묶음·분리 indicator/length·NULL·경고 행/열·명시 ARD 공유/복사·자동 IPD·열/packed 파라미터 배열의 중간 PK 오류와 일부 성공/IGNORE를 검사한다.

HJOW-ATHLON의 Windows 10 10.0.19045에서 **연결된 명시 DESC를 해제한 직후 SQLGetStmtAttr(APP_ROW_DESC)**를 호출하면 시스템 Manager가 드라이버의 조회 함수에 진입하기 전 ntdll.dll에서 접근 위반(0xC0000005, fault address 0x10)을 일으켰다. 자기 문장의 원래 자동 DESC를 받는 드라이버 검사를 수정했지만 이 재현 사례는 남았다. 드라이버 직접 호출의 자동 복원은 통과하며, 기본 Manager 시험은 먼저 두 STMT에서 명시 DESC를 분리한 뒤 해제한다. 이 결과로 해제 직후의 Manager 조회까지 통과했다고 주장하지 않는다.

별도 재현은 `HWDB_DESC_FREE_REGRESSION=1`을 설정하고 실제 서버 시험을 실행한다. 예외 모듈/offset을 native probe가 출력한다. 실패 시 종료한 시험의 고유 HKCU 키가 남을 수 있으므로, 해당 프로세스의 종료와 Driver 경로가 이 프로젝트 build 아래인지 검증한 뒤 그 키만 제거한다. 제품 기준인 Windows 11에서의 동일 경로와 Manager 캐시 동작을 WO-13에서 다시 확인해야 하며, 현재 WO-7.1과 전체 적합성을 완료로 표시하지 않는다.
