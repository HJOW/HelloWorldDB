# 검증 기록과 시험 ID

시험 ID는 계획 단계의 **검증 의무**이다. 이 문서에 없는 ID를 API 표나 설계에서 쓰지 않는다.
증거의 층을 구분한다 : 빌드 성공, 직접 `dlopen`, unixODBC Manager 경유, 실제 서버, 범용 앱은 서로 다른 증거이다.

## 현재 실행할 수 있는 시험

| CTest 이름 | 내용 | 증거 층 |
|---|---|---|
| `abi.load` | `libhwdbodbc.so` 를 직접 dlopen, 빌드 식별자·숨김 심볼 확인 | 직접 로드 |
| `env.inspect` | 호스트·도구·unixODBC·ABI 를 `uo0/environment.json` 에 기록 | 환경 조회 |
| `docs.contract` | 이 문서 묶음과 서버 타입·API 표·환경 JSON 의 계약 검사 | 문서 계약 |
| `integration.server_smoke` | 실제 `rdbms` 데몬과 TCP 프레임 hello/close | 실제 서버(프로토콜) |

`docs.contract` 는 드라이버 실행 시험이 아니다. 위 네 시험이 통과해도 ODBC API 구현 완료를 뜻하지 않는다.

## 시험 ID

| ID | 단계 | 층 | 검증 내용 | 현재 |
|---|---|---|---|---|
| T-ENV | UO-0 | 환경 | 호스트명·OS·도구·unixODBC 헤더/라이브러리·SQLWCHAR 크기 기록이 이 PC와 일치 | 통과 |
| T-ABI | UO-1 | 직접 로드 | .so 생성, dlopen, 내보낼 심볼만 노출, SONAME, 예외 차단 경계 | 일부 통과(골격) |
| T-SMOKE | UO-0 | 실제 서버 | 시험 도우미가 데몬을 띄우고 프로토콜 hello/close 를 교환 | 통과 |
| T-HANDLE | UO-2 | 단위·Manager | ENV/DBC/STMT/DESC 할당·해제·부모 자식·자동 DESC·동시 해제 | 예정 |
| T-DIAG | UO-2 | 단위·Manager | 다중 진단, header/record, W 길이, 행·컬럼 번호, 예외→HY001/HY000 | 예정 |
| T-TEXT | UO-2 | 단위 | UTF-8·UTF-16 변환, 서러게이트, 경계 길이, NUL, 2바이트 SQLWCHAR | 예정 |
| T-AUTH | UO-3 | 실제 서버 | SCRAM nonce·반복·서버 서명, 위조 응답 거부, 인증 실패 정리 | 예정 |
| T-PROTO | UO-3 | 실제 서버·결함 주입 | 부분/합쳐진 프레임, 크기 한도, id 짝, 서버 선종료, 잘못된 JSON | 예정 |
| T-CONNECT | UO-4 | Manager | DSN·DSN-less·우선순위·암호 제거·원격 CONNECT 거부·시간 제한 | 예정 |
| T-VERSION | UO-4 | 단위·Manager | ENV ODBC 2/3/3.8 협상, OUTPUT_NTS, DBC 뒤 변경 거부 | 예정 |
| T-EXEC | UO-5 | 실제 서버 | Hello World, CRUD, 영향 행 수, 단일 문장, 권한·제약 오류 보존 | 예정 |
| T-META | UO-5/6 | 실제 서버 | 컬럼 수·이름·타입·정밀도·NULL, 준비 전후 일치, W 이름 | 예정 |
| T-ROWSET | UO-5/7 | 단위·실제 서버 | 행 묶음·offset·status·rows fetched, packed 행, canary | 예정 |
| T-GETDATA | UO-5 | 실제 서버 | unbound 컬럼 순서, 분할 수신, 01004, NULL indicator | 예정 |
| T-CURSOR | UO-5 | 실제 서버 | 커서 이름, 닫기, FreeStmt 옵션, 서버 커서 16개 한도, MoreResults | 예정 |
| T-TYPE | UO-5 | 실제 서버 | 18개 타입 왕복, 경계·NULL·빈 값·38자리 DECIMAL·13개 INTERVAL | 예정 |
| T-PREPARE | UO-6 | 실제 서버 | prepare/describe 무부작용, UNKNOWN·힌트, 무효화, NumParams/DescribeParam | 예정 |
| T-PARAM | UO-6/7 | 실제 서버 | 단일·배열 입력, 실행 시 버퍼 읽기, 반복 실행, 부분 실패 상태 | 예정 |
| T-ESCAPE | UO-6 | 단위 | 날짜·함수·outer join·LIKE escape, CALL/GUID 거부 | 예정 |
| T-DESC | UO-7 | 단위·Manager | ARD/APD/IRD/IPD 필드, 교체·공유·복사, 읽기 전용 위반 | 예정 |
| T-DAE | UO-7 | 실제 서버 | SQL_NEED_DATA, PutData 분할·NULL, 도중 취소·정리 | 예정 |
| T-ATTR | UO-5/7/8 | 단위 | STMT 속성 전수, 실행 중 변경 제한, 01S02 | 예정 |
| T-TXN | UO-8 | 실제 서버 | autocommit·commit·rollback·savepoint 없음, DDL 자동 커밋, 끊김 롤백 | 예정 |
| T-CANCEL | UO-8 | 실제 서버·다중 스레드 | 다른 스레드 SQLCancel, accepted/tooLate 경합, HY008, 세션 유지 | 예정 |
| T-TIMEOUT | UO-8 | 실제 서버 | query timeout, HYT00, 잠금 대기, 교착, 연결 정리 | 예정 |
| T-RESET | UO-8 | Manager | SQL_ATTR_RESET_CONNECTION 재인증, 풀 반환 상태 초기화 | 예정 |
| T-INFO | UO-9 | Manager | SQLGetInfo 실제 값, SQLGetFunctions 비트와 실제 export 일치 | 예정 |
| T-CATALOG | UO-9 | 실제 서버 | SQLTables/Columns/Statistics/PrimaryKeys/ForeignKeys/Privileges, SYS_* 가시성 | 예정 |
| T-TLS | UO-10 | 실제 서버 | 인증서 검증 기본, CA 지정, 검증 끄기, 100ms 재시도 2회, TLS 1.2/1.0 | 예정 |
| T-UDP | UO-11 | 실제 서버·결함 주입 | 유실·중복·순서 뒤바뀜·분할·세션 시간 초과·ping | 예정 |
| T-INSTALL | UO-12 | Manager·설치 | odbcinst 등록·해제, DSN, isql/iusql, 설정 UI, 격리된 ODBCSYSINI | 예정 |
| T-CONFORM | UO-13 | 적합성 | Core 호출 형태, 상태·진단·descriptor, 32비트(선택), macOS(가능 시) | 예정 |

UO-0 의 환경 시험은 `abi.load`, `env.inspect`, `docs.contract`, `integration.server_smoke` 이고 T-ENV·T-ABI·T-SMOKE 로 기록한다.

## 검증 원칙

- 한 단계의 완료는 그 단계 표의 시험이 **실제 실행**되어 통과했을 때만 인정한다. 함수 이름 export 나 항상 성공하는 스텁은 완료가 아니다.
- 실패·건너뜀 수를 기록한다. 실행하지 못한 OS·아키텍처·앱은 "미시험"으로 남긴다.
- 결함 주입 시험은 결함을 넣은 빌드에서 실제로 실패하는지 확인한다.
- 시험 서버는 임시 디렉토리와 빈 포트를 쓰고 정상 종료 후 정리한다. `/tmp/helloworlddb-<포트>.sock` 이 남았는지도 확인한다.
- 결과는 이 문서와 `PROGRESS.md` 의 작업 이력에 명령·도구 버전·통과/실패/건너뜀 수와 함께 남긴다.
