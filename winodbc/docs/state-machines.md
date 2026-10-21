# 핸들·진단·문자열의 현재 상태 규칙

WO-2·WO-5·WO-6과 진행 중인 WO-7의 현재 구현 기준이다. 준비 문장은 [준비 규칙](prepared-statements.md), descriptor/배열은 [배열 규칙](descriptors-arrays.md)을 따르며 NEED_DATA·실행 중 취소는 WO-7/8의 잔여 작업이다.

## 수명과 잠금

ENV → DBC → STMT, DBC → 명시적 DESC 관계를 가진다. STMT는 자동 ARD/APD/IRD/IPD 네 개를 만들고 명시 ARD/APD로 교체해도 원래 자동 핸들을 보존한다. STMT 해제는 자신의 자동 DESC만 무효화하고 공유한 명시 DESC는 유지한다. 명시 DESC 해제는 직접 드라이버 경로에서 원래 자동 DESC를 복원하며, 해제 직후 Manager 조회의 알려진 재현 사례는 별도로 추적한다. 자동 DESC는 직접 해제할 수 없다(HY017). ENV의 ODBC 버전은 DBC 할당 전에 지정한다. 접속하지 않은 DBC의 STMT/DESC 할당은 08003이다.

레지스트리는 종류와 불투명 토큰을 확인한 뒤 `shared_ptr`를 가져온다. 임의 앱 주소를 역참조하지 않는다. 토큰은 단조 증가하며 재사용하지 않는다. 토큰 공간을 소진하면 HY001로 실패한다. 객체 주소 재사용으로 이전 핸들이 새 객체에 접근하는 문제를 막는다.

레지스트리 잠금 중에는 핸들 잠금을 얻거나 네트워크 요청을 하지 않는다. 조회 후 레지스트리 잠금을 해제하고 핸들 mutex를 얻어 alive를 다시 확인한다. 해제 대기 중인 호출은 공유 소유권으로 메모리는 유지하지만, 무효화 후에는 SQL_INVALID_HANDLE이다. 자식 수는 원자적으로 관리하며 부모 해제와 새 자식 할당을 부모 잠금으로 조정한다.

ENV는 자체 mutex, DBC마다 서로 독립적인 mutex를 가진다. 그 DBC의 STMT/DESC는 DBC mutex를 공유한다. 따라서 다른 연결의 SQL 실행은 전역으로 직렬화되지 않는다. 같은 DBC의 일반 요청은 직렬화한다. 실행 중 취소는 WO-8에서 별도 진입 경로로 추가해야 한다.

## 진단

| 호출 | 이전 진단 | 반환 코드 헤더 |
|---|---|---|
| 일반 API | 유효 핸들을 잠근 뒤 지움 | 실제 반환 코드 기록 |
| SQLAllocHandle | 입력 부모의 진단 지움 | 부모에 기록 |
| SQLFreeHandle | 대상 진단 지움, 실패하면 대상 유지 | 실패 진단 기록 |
| SQLGetDiagRec/W, SQLGetDiagField/W | 지우거나 덧붙이지 않음 | 변경하지 않음 |
| 무효 핸들 | 접근하지 않음 | SQL_INVALID_HANDLE |

정상 레코드는 동적 목록으로 메시지·SQLSTATE·native error·행/컬럼을 가진다. C++ 예외에서는 추가 할당 없는 비상 레코드를 사용한다. bad_alloc은 HY001이고, 나머지 예상 밖 예외는 원문을 노출하지 않는 HY000이다. 정상 DriverError는 원래 상태와 번호를 보존한다. 진단 조회 실패도 기존 진단을 바꾸지 않는다.

SQLGetDiagRecW의 길이는 UTF-16 코드 단위이고 SQLGetDiagFieldW의 문자열 길이는 바이트이다. 헤더 필드는 record 번호를 무시한다. 숫자는 SDK가 정한 SQLINTEGER/SQLLEN/SQLRETURN 폭으로 기록한다.

## 문자 변환

서버 UTF-8과 앱 UTF-16은 엄격하게 검사한다. 짝이 없는 surrogate, 과도한 UTF-8 인코딩, 잘린 시퀀스는 22021이다. ANSI API는 Windows ACP를 사용하며 잘못된 시퀀스·표현 불가·왕복 시 원문이 바뀌는 변환은 22018이다. NTS는 NUL까지, 명시 길이는 내장 NUL을 포함해 처리한다. 연결 문자열 자체의 NUL은 구문 오류이다.

출력 헬퍼는 인자별로 코드 단위/바이트를 지정한다. W 출력이 잘릴 때 surrogate 쌍을 분리하지 않는다. 필요한 길이에는 종료 NUL을 포함하지 않으며 공간이 있으면 항상 종료한다. 버퍼 길이 0과 길이만 조회하는 NULL 출력은 구분한다.

## 실행과 커서

동기 실행 전에 열린 ODBC 커서가 있으면 24000이다. 실행 성공은 조회 커서 또는 DML 실행 상태가 된다. Fetch는 서버 묶음 하나에서 다음 행을 선택하고, 소진한 경우에만 fetch 요청을 보낸다. 마지막 SQL_NO_DATA에서도 ODBC 커서는 열려 있으며 CloseCursor/FreeStmt(CLOSE)/MoreResults로 마무리한다. 결과를 닫은 직접 실행 STMT는 미실행 상태가 되고 이전 결과 메타데이터를 버린다. 준비 문장은 결과를 닫아도 남으며 다시 SQLExecute할 수 있다.

GetData는 fetch한 행·row array size 1·증가하는 unbound 열만 허용한다. CHAR/VARCHAR/BINARY/VARBINARY의 문자/이진 출력은 바이트 offset을 보관하고 마지막 성공 뒤 SQL_NO_DATA를 반환한다. indicator는 이번 호출 이전에 남은 길이이며 다음 행에서 offset을 초기화한다. 고정 C 타입은 BufferLength 대신 SDK 크기로 쓰고, NUMERIC/날짜시간의 정보 손실은 해당 진단으로 보고한다.

바인딩은 ARD/APD 레코드의 앱 주소를 보관하고 fetch/execute 때 읽는다. 값과 indicator를 DLL이 해제하지 않는다. 행/파라미터 배열은 열/행 중심 배치와 부호 있는 offset을 지원하며 곱셈·덧셈·언더플로를 검사한다. 한 번의 fetch 결과는 부분 묶음·각 행 오류/경고를 보고하고, DML 파라미터 배열은 순차 실행의 실제 상태와 집계 영향 행 수를 보고한다. 조회 결과는 커밋/롤백 시에도 유효하다. SQLFreeHandle(STMT)는 자신의 서버 커서와 준비 문장을 닫고 자동 descriptor를 무효화한다.

SQLDisconnect는 서버 close 후 남은 STMT와 명시/자동 DESC 토큰을 모두 무효화한다. 그 토큰에 대한 직접 드라이버 호출은 SQL_INVALID_HANDLE이다. Driver Manager가 소유한 앱 포인터도 SQLDisconnect가 해제하므로 앱은 이를 이후에 재사용하지 않는다. x86 Release의 시스템 Manager에서 이미 해제된 앱 STMT 포인터를 다시 SQLFreeHandle에 전달하면 접근 위반이 관찰되어, 해당 검증은 드라이버의 불투명 토큰을 대상으로 수행한다.

자동 커서 이름은 SQL_CUR로 시작하고 18자 이내이며 토큰과 별도의 단조 증가 번호로 만든다. 앱 이름은 128 코드 포인트까지 허용하고 예약 접두사와 중복을 검사한다. 큰따옴표 식별자는 대소문자를 보존하여 비교하며 일반 이름은 정규화한다. positioned UPDATE/DELETE는 지원하지 않는다.

## 수신과 인증

수신 스레드는 하나이며 id별 promise로 응답을 분배한다. hello/auth 필드, 결과·준비·취소·오류의 알려진 필드와 범위, 중복 키, 깊이를 검사한다. 모르는 추가 필드는 무시하지만 모르는 type은 연결 오류이다. id 0의 서버 오류는 대기 요청에 전달하고 연결을 dead로 만든다.

authOk를 수신하면 서명 검증이 끝날 때까지 수신 스레드는 조건 변수에서 기다린다. 검증에 성공한 뒤에만 다음 프레임에 인증 후 16MiB 한도를 적용한다. 검증 실패·종료는 같은 조건 변수를 깨워 스레드를 정리한다. 인증 전 한도는 64KiB이다. 취소/시간 제한의 응답 정합성은 WO-8의 후속이다.
