# 검증 기록과 후속 시험

## VM-W11-CODEX — 2026-10-22·23 작업(WO-7 ~ WO-10) 점검과 보완

2026-10-23, 같은 VM(Windows 11 Pro x64 10.0.26300 / MSVC 19.44.35229.0·v143 / SDK 10.0.26100.0 / CMake·CTest 4.4.4 / Node.js 24.19.0)에서 WO-7 ~ WO-10 커밋(11190b4, 4669268, aa89d3b, e8e96cc)의 코드·문서·시험을 대조했다.

**기준선(수정 전)**: `build-and-test.ps1`을 두 번 실행했다. 첫 실행은 x64 Debug의 `integration.protocol_manager`가 실제 서버 시나리오 한 곳에서 `HYT01`로 실패했다(프로브의 단일 요청 3초 제한을 DDL 한 건이 넘김). 같은 시험을 3번 다시 돌리면 모두 통과했고(24~27초), 두 번째 전체 실행은 CTest 68개·교차 4개·PE 4개·문서/환경 10개가 모두 통과했다. PROGRESS.md의 기록과 일치한다. 프로브의 일반 시나리오 요청 제한을 10초로 올려 이 간헐 실패를 막았고 제한 시간 동작을 시험하는 시나리오의 값은 그대로 두었다.

**점검에서 찾아 고친 것**

| 영역 | 문제 | 수정과 시험 |
|---|---|---|
| WO-10 TLS 송신 | `EncryptMessage`가 갱신한 트레일러 크기가 아니라 `cbTrailer` 고정값만큼 보냄. CBC 계열 스위트에서는 레코드 뒤에 쓰레기 바이트가 붙음 | 세 버퍼 크기의 합을 보내도록 수정. 서버 기본 스위트(AES-GCM·ChaCha20)에서는 두 값이 같아 시험으로 드러나지 않는다 |
| WO-9 `SQLColumns` | `TIMESTAMP(0)`을 기본값 6자리로 보고(COLUMN_SIZE 26, DECIMAL_DIGITS 6). 서버는 항상 `TIMESTAMP(p)`로 적으므로 0자리가 6자리로 둔갑 | 명시 여부를 구분. 단위 시험과 `SQLDescribeCol` 대조로 확인 |
| WO-9 `SQLSpecialColumns` | `SQL_SCOPE_CURROW`·`TRANSACTION` 요청에 빈 결과(범위는 "최소 범위"이므로 SESSION 범위 PK가 모두 만족) | 세 범위 모두 PK를 반환 |
| WO-9 PK/FK/통계/특수컬럼 | 스키마·테이블 일반 인자를 패턴으로 비교. `ORDER_ITEMS`가 `ORDERXITEMS`와 섞임 | 일반 인자는 문자 그대로 비교. 식별자 모드는 따옴표 식별자·대문자 접기 적용 |
| WO-9 `SQLGetInfo` | 문서(api-support.md)가 반환한다고 적은 `SQL_ASYNC_MODE`·`SQL_ASYNC_DBC_FUNCTIONS`가 없어 `HY096`. `SQL_ASYNC_NOTIFICATION`도 추가 | 비동기 미지원 값 반환. 직접 DLL에서 확인 |
| WO-9.7 속성 | 유효하지만 미지원인 연결 속성(PACKET_SIZE, TRANSLATE_LIB/OPTION, ENLIST_IN_DTC)과 문장 속성(KEYSET_SIZE, SIMULATE_CURSOR, ASYNC_STMT_EVENT)이 `HY092` | `HYC00` 또는 기본값만 받고 `01S02`. 직접 DLL에서 확인 |

**시험 공백을 메운 것**: 기존 `catalog_cases.cpp`는 DBA 접속과 단일 컬럼 키·ASC 인덱스만 다뤘고, `catalog-info.md`가 "복합 PK/FK·ASC/DESC·특수 식별자·타입 생략/명시를 포함한다"고 적은 것은 사실과 달랐다. 다음을 새로 시험한다.
- 복합 PK(제약조건 순서 KEY_SEQ)·복합 FK(PK 쪽·FK 쪽 어느 테이블로 물어도 같은 행)·`DESC` 인덱스·따옴표 식별자(공백·`$`·예약어)·식별자 모드·타입 인자 생략/명시 9종과 `SQLDescribeCol` 대조·일반 인자의 `_` 비패턴 비교.
- 권한이 없고 기본 테이블스페이스도 없는 사용자 / 뷰 권한만 있는 사용자 / 테이블스페이스 수준 SELECT 사용자의 탐색 결과, 그리고 보이는 것과 실제 실행 가능 범위(보이면 읽히고 안 보이면 `42501`)의 일치.
- 직접 DLL에서 `SQLGetFunctions` true 55개와 실제 export(ANSI·W)의 양방향 대조, 단일 ID·`SQL_API_ALL_FUNCTIONS`·`SQL_API_ODBC3_ALL_FUNCTIONS` 일치, 제외 함수 5개의 보고·export 부재.

**결함 주입 확인**: 수정을 하나씩 되돌려 새 시험이 실패하는지 확인했다. `TIMESTAMP(0)` 복원(`TIMESTAMP(0) keeps zero fractional digits`·단위 시험), 특수컬럼 범위 필터 복원(`best rowid is returned for every minimum scope`), PK 테이블 이름 패턴 비교 복원(`primary key lookup does not treat _ as a wildcard`)이 각각 실패했고 되돌린 뒤 모두 통과했다.

**수정 후 실행**: 저장소 루트에서 `powershell -NoProfile -File winodbc/scripts/build-and-test.ps1`을 실행했다. x64 Debug/Release·x86 Debug/Release 각각 CTest 17개, 합계 **68개 통과**이며 그 안의 Node 실제 서버/결함 주입은 구성당 32개(총 128개)이다. 새 시험은 기존 CTest 항목 안(`catalog.helpers_types`, `integration.protocol_manager`)에 들어 있어 CTest 수는 그대로다. 교차 비트 수 거부 4개·PE 검사 4개·문서/환경 10개도 통과했고 실패·건너뜀은 0이다. `build/native/summary.json`의 capturedAt은 `2026-10-23T08:50:39.2715320+00:00`이다.

**남은 한계**: 핸드셰이크 직후 붙어 오는 응용 데이터(`SECBUFFER_EXTRA`)를 전송 객체로 넘기지 않는 점은 현재 서버와는 발생하지 않아 고치지 않고 [TLS 문서](tls.md)에 적었다. CBC 스위트 송신 수정은 실제 CBC 협상 서버로 확인하지 못했다. `SQLGetFunctions` 대조는 보고와 export의 정합성을 보장하며, 각 함수의 동작은 기존 시험이 호출한다. WO-8.7 실제 Manager 풀과 WO-7.1 공유 DESC 해제는 이번 점검으로 해결되지 않았다.

## VM-W11-CODEX — WO-10 TCP TLS

2026-10-23, Windows 11 Pro x64 10.0.26300 / Build Tools 2022 17.14.37710.0 / MSVC 19.44.35229.0·v143 / SDK 10.0.26100.0 / CMake·CTest 4.4.4 / Node.js 24.19.0이다. 현재 서버 소스를 `winodbc/build/server/`에 빌드하여 시험했으며 rdbms 소스나 dist는 바꾸지 않았다. 시험용 만료·시작 전 인증서는 `test/fixtures/tls/`의 자체 서명 인증서이며 서버 `server-a` 계열은 `rdbms/test/fixtures/tls/`를 참조한다.

저장소 루트에서 `powershell -NoProfile -File winodbc/scripts/build-and-test.ps1`을 실행했다. x64 Debug/Release·x86 Debug/Release 각각 **CTest 17개, 합계 68개 통과**이다(신규 `tls.options_ca_validation` 포함). 그 안의 Node 실제 서버/결함 주입은 구성당 32개(기존 24개 + TLS 8개), 총 128개이며 CTest 수에 중복 합산하지 않는다. 별도 교차 비트 수 거부 4개·PE 검사 4개·문서/환경 검사 10개도 통과했다. 기본 행렬 실패·건너뜀은 0이며 85개 export·정적 CRT·직접 시험과 Manager 링크 분리를 확인했다.

- **단위**: `tls_test.cpp`의 인증서 오류 분류·PEM 읽기·옵션 조합 오류, `connection_test.cpp`의 `SSLCA` 없는 `SSL`·검증 끄기 없는 `SSL` 조합의 `HY024`와 서버 없는 TLS 접속의 `08001`을 통과했다.
- **가짜 서버 연결 수 세기**: 신뢰할 수 없음·호스트 불일치·만료·시작 전 인증서는 각 3회, 평문 서버·닫힌 포트는 각 1회를 확인했다. 원인 코드(`not trusted`·`does not match`·`expired`·`not yet valid`)와 `08001`/8007도 함께 확인했으며 3회 시도는 200 ms 이상 걸린다.
- **실제 Manager → DLL → TLS 서버**: CA 지정 접속의 CRUD·분할 fetch·커밋/롤백·잠금 취소와 검증 끄기 접속을 통과했다. 기본 신뢰 실패·평문 서버는 재시도 없이 끝난다.

상세 계약은 [TLS 전송](tls.md)에 있다. WO-8.7의 실제 Manager 풀 검증과 WO-7.1 공유 DESC의 별도 실패는 남아 있다. 전체 Core/ODBC 3.8 적합성을 선언하지 않는다.

## VM-W11-CODEX — WO-9 카탈로그·기능·속성 보고

2026-10-23, Windows 11 Pro x64 10.0.26300 / Build Tools 2022 17.14.37710.0 / MSVC 19.44.35229.0·v143 / SDK 10.0.26100.0 / CMake·CTest 4.4.4 / Node.js 24.19.0이다. [호스트 환경](environment.md)의 같은 설치 경로를 재조회했다. 현재 서버 소스를 `winodbc/build/server/`에 빌드하여 시험했으며 rdbms 소스나 dist는 바꾸지 않았다.

저장소 루트에서 `powershell -NoProfile -File winodbc/scripts/build-and-test.ps1`을 실행했다. x64 Debug/Release·x86 Debug/Release 각각 **CTest 16개, 합계 64개 통과**이다. 그 안의 Node 실제 서버/결함 주입은 구성당 24개, 총 96개이며 CTest 수에 중복 합산하지 않는다. 별도 교차 비트 수 거부 4개·PE 검사 4개·문서/환경 검사 10개도 통과했다. 기본 행렬 실패·건너뜀은 0이며 85개 export·정적 CRT·직접 시험과 Manager 링크 분리를 확인했다. 최종 `build/native/summary.json`의 status는 `passed`, capturedAt은 `2026-10-23T06:15:45.4370326+00:00`이다.

- **단위**: `catalog_test.cpp`의 패턴·선언 해석·타입 정보를 통과했다.
- **실제 Manager → DLL → 서버**: `catalog_cases.cpp`의 테이블 전체/종류/패턴·특별 ALL_SCHEMAS/TABLE_TYPES/CATALOGS·빈 카탈로그, 컬럼 18개·DECIMAL 정밀도·뷰·METADATA_ID 식별자, 통계 전체/유일·HY101 예약값, BEST_ROWID·ROWVER 빈 결과, PK/FK·권한·프로시저 빈 결과, GetTypeInfo 전체/단일·HY004, GetInfo/GetFunctions 단일/전체/비트맵·MoreResults 종료·HY010을 통과했다.
- **Manager 검증 차이**: `SQLStatistics` 예약값 오류는 Manager가 `HY101`을 먼저 내며 드라이버 직접 값 `HY024`와 구분해 시험한다. 카탈로그 `NULL` 인자는 Manager가 `HY009`를 내므로 빈 문자열로 넘긴다.

상세 계약은 [카탈로그·기능 보고](catalog-info.md)에 있다. WO-8.7의 실제 Manager 풀 검증과 WO-7.1 공유 DESC의 별도 실패는 남아 있다. 전체 Core/ODBC 3.8 적합성을 선언하지 않는다.

## VM-W11-CODEX — WO-8 트랜잭션·취소·시간 제한·초기화

2026-10-22, Windows 11 Pro x64 10.0.26300 / Build Tools 2022 17.14.37710.0 / MSVC 19.44.35229.0·v143 / SDK 10.0.26100.0 / CMake·CTest 4.4.4 / Node.js 24.19.0이다. [호스트 환경](environment.md)의 같은 설치 경로를 재조회했다. 현재 서버 소스를 `winodbc/build/server/`에 빌드하여 시험했으며 rdbms 소스나 dist는 바꾸지 않았다.

저장소 루트에서 `powershell -NoProfile -File winodbc/scripts/build-and-test.ps1`을 실행했다. x64 Debug/Release·x86 Debug/Release 각각 **CTest 15개, 합계 60개 통과**이다. 그 안의 Node 실제 서버/결함 주입은 구성당 24개, 총 96개이며 CTest 수에 중복 합산하지 않는다. 별도 교차 비트 수 거부 4개·PE 검사 4개·문서/환경 검사 10개도 통과했다. 기본 행렬 실패·건너뜀은 0이며 63개 export·정적 CRT·직접 시험과 Manager 링크 분리를 확인했다. 최종 `build/native/summary.json`의 status는 `passed`, capturedAt은 `2026-10-22T00:36:10.4970455+00:00`이다. 로그는 같은 디렉토리의 `*-ctest.log`, `*-ctest.xml`, `*-build.log`, `pe-audit.log`, `wo8-matrix.log`에 있다.

- **실제 Manager → DLL → 서버**: `transaction_cases.cpp`의 커밋 가시성·롤백·DDL 자동 커밋·ENV의 두 연결 처리·연결 종료 롤백·커서 보존, 잠금/CPU 취소·앞선 미커밋 변경 보존·다음 SELECT, 같은 DBC 대기 요청과 별도 DBC 진행, query/connection timeout·늦은 취소를 통과했다.
- **직접 DLL → 서버**: `reset_probe.cpp`의 바인딩·준비·커서·명시/자동 descriptor 초기화, 앱 메모리 유지, NULL 기본 테이블스페이스·타임존 복원·미커밋 변경 롤백·기본 속성, 서버에서 암호가 바뀐 뒤 reset 실패/연결 dead·재사용 거부를 통과했다. 실제 Manager 풀 반환/재인수는 이 결과에 포함하지 않는다.
- **저수준 결함 주입**: 누적 로그인 deadline, 취소 ACK와 원래 57014 응답의 분리/HYT00, ACK 뒤 원래 응답 유실의 dead 처리, tooLate 뒤 실제 정상 완료 보존·다음 요청 정합성, 12MiB 송신 정체의 제한 시간·재실행 부재를 통과했다.

상세 계약은 [트랜잭션·취소·초기화](transactions-cancel-reset.md)에 있다. WO-8.7의 실제 Manager 풀 검증과 아래 WO-7.1 공유 DESC의 별도 실패는 남아 있다. 사용자 요청에 따라 WO-8 변경의 문서 반영·커밋 후 목표를 일시 중지하며 WO-9 이후는 착수하지 않는다. 전체 Core/ODBC 3.8 적합성을 선언하지 않는다.

## VM-W11-CODEX — WO-7 분할 입력과 배열 검증

2026-10-22 Windows 11 Pro x64 10.0.26300 / MSVC 19.44.35229.0·v143 / SDK 10.0.26100.0 / CMake·CTest 4.4.4 / Node.js 24.19.0이다. 현재 PC의 설치 경로를 다시 조회했고 현재 서버 소스를 `build/server/`에 빌드했다. 오래된 `rdbms/dist/`에서는 준비 INSERT가 42804였으며 현재 소스에서는 통과했다. 서버 소스와 기존 dist는 바꾸지 않았다.

`powershell -NoProfile -File winodbc/scripts/build-and-test.ps1` 결과는 x86/x64 Debug/Release 각각 CTest 15개, 합계 **60개 통과**이며 그 안의 실제 서버/결함 주입 Node 시험은 19개씩 76개이다. 별도의 교차 비트 수 거부 4개·PE 4개·문서/환경 10개도 통과했다. 기본 행렬 실패/건너뜀 0이며 62개 export·정적 CRT·Manager 역링크 부재를 검사했다. 다른 STMT의 속성·BindCol·UNBIND/RESET_PARAMS 경유 공유 descriptor 변경도 거부하도록 보완한 최종 재실행의 `build/native/summary.json` capturedAt은 `2026-10-22T00:08:01.9587537+00:00`이다.

새 시험 `parameters.streaming_limits_sequence`는 네트워크 없이 분할 입력의 C 타입·바이트 길이·surrogate·NULL 결합·음수/과다 길이·16MiB를 검사한다. descriptor 시험은 NEED_DATA 중 필드 변경·복사 대상·DESC/STMT 해제를 거부하고 SQLCancel 뒤 정리한다. 실제 Manager의 `data_cases.cpp`는 단일/배열 NEED_DATA, token·여러 PutData·Unicode/이진/NULL/빈 값·60,000자·예고 길이 부족/초과·취소 후 재실행·배열 PK 오류·처리 수와 row count를 검사한다. 기본 descriptor 시험은 **한 STMT에 남겨 둔 명시 DESC를 해제한 뒤 Manager의 자동 복원**도 검사한다.

**기본 행렬 밖의 공유 DESC 회귀는 x64 Debug에서 1개 실패**했다. `scripts/reproduce-descriptor-free.ps1`의 종료 코드 8과 `build/native/shared-descriptor-free-x64-debug.log`에 18개 통과·1개 실패, Manager 조회의 `0xC0000005`·fault address `0x10`을 보존했다. 여러 STMT에 공유된 채 해제하는 이 실패를 기본 통과 집계로 가리지 않는다. Manager 바이너리 분석 근거·버전/해시·단일/다중 연결 차이와 앱의 명시 분리 방법은 [상세](descriptors-arrays.md)에 있다. WO-7.1과 WO-13 최종 인수는 아직 미완료이며 WO-8 이후 구현을 계속한다.

## HJOW-ATHLON — WO-2·TCP·ODBC 접속 구현 검증

2026-10-21, Windows 10 Pro x64 10.0.19045, MSVC 19.44.35229.0/v143, Windows SDK 10.0.26100.0, CMake/CTest 4.4.3, 개발용/실제 시험 서버 Node.js 24.21.0. 설치 조회의 절대 경로와 이전 호스트와의 차이는 [환경](environment.md)에 기록했다.

실행 명령은 저장소 루트의 `powershell -NoProfile -File winodbc/scripts/build-and-test.ps1`이다. 최신 로그·JUnit·dumpbin·요약은 `build/native/`, 환경은 `build/wo0/environment.json`이다.

| 구성 | CTest | 그 안의 Node 통합 시험 | Manager → 드라이버 → 서버 |
|---|---|---|---|
| x64 Debug | 10 통과 | 16 통과 | DLL 절대 경로·로그인·STMT/자동 DESC·종료 통과 |
| x64 Release | 10 통과 | 16 통과 | 통과 |
| x86 Debug | 10 통과 | 16 통과 | 통과 |
| x86 Release | 10 통과 | 16 통과 | 통과 |

모두 실패/건너뜀 0이다. CTest 40개에는 통합 시험 실행 4개가 포함되어 있으므로 Node 64개를 독립 CTest 수로 합산하지 않는다. 별도로 교차 비트 수 DLL 거부 4개, PE machine/export/정적 CRT/Manager 분리 4개, 문서·환경 계약 10개가 통과했다.

직접 DLL 시험은 무효/종류 불일치/해제 후 핸들, 부모보다 먼저 자식 해제, 버전 설정 순서, ANSI/W 진단 잘림·canary를 확인한다. 내부 시험은 명시/자동 DESC 수명, 재사용하지 않는 토큰 2,000회, 조회/해제 경합 100회, 여러 진단·행/컬럼/native/header, NTS·명시 NUL·한글·emoji·잘못된 UTF-8/surrogate·ACP·길이 단위를 확인한다. 내부 STMT 수명 시험의 연결 상태 주입은 서버 로그인 증거로 세지 않는다.

네이티브 TCP 앱은 실제 서버의 정상/틀린 암호, SQL 오류 뒤 재사용, 기본 테이블스페이스 null, execute/fetch 여러 묶음/조기 closeCursor/ping/close를 확인한다. 결함 주입은 응답 id·알 수 없는 type·중복 키·잘못된 UTF-8/JSON·과도한 깊이·0/초과 프레임 길이·분할 전송·도중 끊김·NFKC 증명·위조 서명·nonce·반복 수·버전 실패를 확인한다.

Manager 시험은 실제 OS odbc32.dll을 사용하고 DLL 절대 경로를 출력한다. `RegOverridePredefKey`가 **해당 시험 프로세스에서만** HKLM을 고유한 HKCU 임시 키로 연결한다. Winsock의 시스템 TCP 공급자를 먼저 초기화한 뒤 격리하며, installer API의 등록/제거·usage count와 실제 DLL 경로를 확인한다. 관리자 권한의 시스템 설치, Windows ODBC 관리자 UI, 일반 앱의 영구 등록 인수를 대신하지 않는다. 기존 드라이버/DSN/서버 데이터는 변경하지 않는다. [RegOverridePredefKey 공식 규약](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regoverridepredefkey)을 따른다.

남은 범위: WO-3 응답 필드 검증/id 0 보강, WO-4의 전체 경계, ODBC SQL 실행·변환·prepare·descriptor 필드/배열·취소/시간 제한/reset·카탈로그·TLS·UDP·Setup/설치·Windows 11 최소 OS·범용 앱·메모리 도구 인수. 전체 ODBC 구현 완료나 Core 적합성의 증거가 아니다.

## HJOW-ATHLON — WO-3 ~ WO-5 완료 검증

위 기록의 후속이다. 같은 호스트/컴파일러/SDK/런타임에서 `powershell -NoProfile -File winodbc/scripts/build-and-test.ps1`을 재실행했다. 최신 `build/native/summary.json`의 capturedAt은 **2026-10-21T12:18:10Z**이며, 네 구성 CTest **11개씩 44개**, 그 안의 Node 통합 **19개씩 76개**, 교차 비트 수 거부 **4개**, PE 감사 **4개**, 문서/환경 **10개**가 통과했다. 실패/건너뜀 0이다.

추가한 단위 시험은 정확한 38자리 NUMERIC·음수/0/scale 38/음수 scale·signed/unsigned 64비트·고정 C 크기·numeric 문자 출력의 정수부 손실·작은 W/이진 버퍼·NULL indicator·μs→ns·날짜/INTERVAL 범위를 검사한다. 응답 스키마는 알려진 필드 타입/범위·준비/취소·오류 position·id 0를 검사하고, authOk 뒤에도 서버 서명을 확인하기 전에는 수신을 멈추어 인증 전 크기 한도를 유지한다.

네 구성의 Manager 시험에서 다음을 실제 서버와 확인했다.

- User/System DSN 및 DSN 없는 로그인, 명시 값 우선, 기본 tablespace null, 중복 로그인 오류, 루프백 이외 주소의 CONNECT 7006 거부, 종료 후 자식 정리.
- Hello World·CRUD 영향 행 수·실행 후 메타데이터·한글/emoji 컬럼과 커서 이름의 서로 다른 W 길이·인용 커서 이름의 대소문자 구별.
- CHAR/VARCHAR/NVARCHAR·BINARY/VARBINARY·정수 3종·REAL/DOUBLE·DECIMAL/NUMERIC·BOOLEAN·DATE/TIME/TIMESTAMP·timezone 문자열 및 INTERVAL 한정자 13개를 C 기본 타입/명시 타입으로 조회.
- VARCHAR 65535/DECIMAL (10,3)/NUMERIC(p,0) 메타데이터, 38자리 값, 고정 공백/0, 소수 초와 offset 보존, NULL/빈 문자열/빈 이진 구별, bound truncation의 01004·행/컬럼 진단.
- 60,000 UTF-16 단위의 긴 Unicode 결과(인증 전 한도보다 큰 프레임) 재구성, 조각별 남은 바이트 indicator, 마지막 성공 뒤 SQL_NO_DATA.
- fetchSize 1/3/500, bound 열 이후 unbound GetData, 역순/바인딩된 열 거부, 행 상태/처리 수, 서버 커서 16개·17번째 53400, STMT 해제의 조기 정리, commit/rollback 뒤 서버 fetch 지속.

x86에서 SQLColAttribute/W의 마지막 인자가 SDK상 SQLPOINTER인 점을 빌드가 검출하여 수정했다. 시스템 Manager가 SQLDisconnect로 이미 해제한 앱 STMT 포인터를 다시 SQLFreeHandle에 주면 x86 Release에서 접근 위반이 발생했다. 최종 시험은 해당 포인터를 재사용하지 않고, **직접 드라이버 토큰**에 대해 종료 후 SQL_INVALID_HANDLE·부모 자식 수 정리를 검사한다. 그 실패로 남았던 두 개의 고유 HKCU 시험 키는 경로/드라이버 DLL이 이 작업의 build 디렉토리임을 확인한 뒤 제거했으며, 최신 성공 시험 후 임시 키가 없음을 확인했다.

후속은 WO-6부터이다. 시간 제한/취소·풀 reset·배열·완전한 descriptor·전체 카탈로그/기능 감사·TLS·UDP·실제 설치/앱/최소 OS 인수는 아직 남아 있다. SQL escape 초안은 미연결·미시험이므로 이 결과에 포함하지 않는다.

## HJOW-ATHLON — WO-6 완료 검증

동일 호스트·도구·런타임에서 전체 빌드 스크립트를 다시 실행했다. 최신 `build/native/summary.json`의 capturedAt은 **2026-10-21T12:52:08Z**이다. x86/x64 Debug/Release에서 CTest 13개씩 **52개**, 내부 Node 통합 19개씩 **76개**, 교차 비트 수 거부 4개·PE 감사 4개·문서/환경 10개가 통과했다. 실패/건너뜀 0이다. Node 76개는 CTest의 통합 실행 4개 안의 세부 시험이므로 CTest 수와 더하지 않는다.

새 단위 시험 `sql.odbc_escapes_parameters`는 따옴표/주석의 ?와 중첩 escape·날짜시간·CONVERT/EXTRACT·outer join/LIKE·미지원/오류 문법을 확인한다. `types.input_parameters`는 실시간 앱 주소 읽기, 64비트/38자리 NUMERIC의 정확성, NULL/빈 이진/내장 NUL·W 바이트 길이·정밀도/범위·unaligned/offset 오버플로를 확인한다. C→SQL의 입력 손실 진단은 getter와 구분해 문자 숫자 손실 22001·날짜시간 손실 22008·INTERVAL 손실 22015·숫자 C 소수 손실의 선택적 01S07을 사용한다.

실제 Driver Manager → DLL → 서버의 `prepare_cases.cpp`는 다음을 검증했다.

- INSERT·DDL의 prepare/describe만으로 데이터/객체를 만들지 않음, 미커밋 INSERT 뒤 DDL prepare가 commit하지 않음, autocommit 설정 보존.
- 실행 전 결과/파라미터 개수·CAST 메타데이터, UNKNOWN 결과의 SQL_UNKNOWN_TYPE·크기 0과 미정 DescribeParam HYC00, 바인딩 힌트 이후 재설명.
- 같은 준비 ID·앱 버퍼의 값 변경 후 반복 실행, CloseCursor 뒤 재실행, parameterized ExecDirect, ANSI/W Prepare·NativeSql의 길이/잘림/canary·NOSCAN.
- 따옴표·주석처럼 보이는 문자열이 SQL이 아닌 입력 데이터로 보존됨, 정확한 DECIMAL(38,6)·binary 0·NULL·timestamp·timezone offset·13개 native INTERVAL 왕복.
- 70회 재준비와 별도 STMT 준비/해제, 권한 회수 후 42501, ALTER 뒤 0A000/native 8009, 재준비 후 정상 실행, 바인딩/방향/정밀도 오류.

x86 링크가 SQLNativeSql/W의 잘못된 stdcall 장식 크기를 검출했으며 SDK의 6인자 원형에 맞게 `@24`로 수정했다. 최종 네 구성의 PE는 51개 export와 정적 CRT·Manager import 분리를 통과했다. 증거는 구성별 build/CTest 로그·JUnit·dumpbin과 `verification-console.log`에 있다. 격리 레지스트리는 정상 정리했고 영구 드라이버 등록은 하지 않았다.

WO-7의 descriptor 필드/자동 IPD/공유·배열·실행 시 데이터, WO-8 정상 취소/reset, 카탈로그/전체 기능 감사·TLS·UDP·실제 설치/앱·최소 OS 인수가 남아 있다. 전체 ODBC 목표는 활성 상태이며 Core/3.8 적합성 완료를 뜻하지 않는다.

## HJOW-ATHLON — WO-7 descriptor/배열 진행 검증

동일 환경에서 전체 스크립트를 재실행한 기본 행렬의 최신 capturedAt은 **2026-10-21T13:41:17Z**이다. 네 구성 CTest 14개씩 **56개**, 그 안의 Node 19개씩 **76개**, 교차 비트 수 거부 4개·PE 4개·문서/환경 10개가 통과했다. 기본 행렬 실패/건너뜀 0이며 PE는 59개 export를 확인했다. SDK의 SQLGetDescRec/W는 11인자·x86 `@44`, SQLSetDescRec은 10인자·`@40`이며 W 이름을 별도로 만들지 않았다.

새 `descriptors.fields_sharing_lifetime` 내부 시험은 scalar/포인터 필드 폭과 canary, W 필드 바이트/레코드 이름 코드 단위·홀수 버퍼 오류, IRD 읽기 전용/상태 포인터 예외, descriptor 복사 후 앱 주소, 타입 변경의 unbind/일관성 검사, 자동/명시 복원·같은 연결 공유·다른 연결 거부, 교차 연결 복사 경합, 부호 있는 offset/stride overflow를 확인했다. 네트워크 없는 연결 상태 주입 시험이다.

실제 Manager/서버의 `descriptor_cases.cpp`는 column-wise/packed row-wise 행 배열과 NULL indicator 배열, 바인딩 offset·서로 다른 alignment·분리 indicator/length, 마지막 부분 묶음과 최대 행 제한, 일부/전체 변환 오류·경고의 상태/진단 row/column, 같은 ARD의 두 STMT 공유·복사, 자동 IPD의 실제 스키마 타입을 확인했다. DML 파라미터 배열은 열/packed 배치, 둘째 set의 PK 실패·계속 실행/IGNORE, 전체 실패/전체 무시·처리 수·영향 행 수 합계, 실행마다 바뀐 값과 NULL을 확인했다. SELECT 배열의 HYC00과 SQLGetInfo의 NO_SELECT/집계 row count가 일치한다.

**기본 행렬과 별도로 알려진 실패가 있다.** `HWDB_DESC_FREE_REGRESSION=1`에서 연결된 명시 DESC를 해제한 직후 SQLGetStmtAttr(APP_ROW_DESC)를 호출하면 x64 Debug의 시스템 Manager가 드라이버 조회에 진입하기 전 ntdll.dll+0x2faad에서 0xC0000005, fault address 0x10으로 실패한다. 최종 코드로 다시 재현한 Node 시험 **1개 실패·0개 통과**를 `build/native/descriptor-free-regression.log`에 보존했다. 기본 행렬은 먼저 두 STMT에서 명시 DESC를 분리한 뒤 해제하며, 그 통과를 해제 직후 조회의 증거로 합치지 않는다. 직접 드라이버의 자동 복원은 통과한다. 자기 문장의 원래 자동 DESC를 받는 검사는 수정했지만 해당 Manager 경로의 실패는 남아 있다.

크래시로 남은 고유 HKCU 키들은 해당 시험 종료와 정확한 GUID 경로·등록 Driver가 이 프로젝트 build 안임을 확인한 뒤 제거했다. 최종 재현의 키도 따로 검증해 제거했다. 복원·재현 방법과 남은 최소 OS 확인은 [descriptor/배열 문서](descriptors-arrays.md)에 있다. WO-7.1·실행 시 데이터/로컬 취소·분할 입력 한도와 WO-8 이후는 미완료이며 전체 목표는 활성 상태이다.

## 실행 증거

2026-10-21, **VM-W11-Codex**(실제 호스트명 `VM-W11-CODEX`), Windows 11 Pro x64 10.0.26300. 다른 PC의 빌드 툴 설치를 보증하는 기록이 아니다. 새 PC는 [환경 확인 규칙](environment.md)에 따라 호스트명·도구 설치 여부·버전·경로를 다시 기록한다.

| 검증 경로 | 이번 단계 결과 |
|---|---|
| 문서·서버 계약 검토 | AGENTS.md, 루트/프로젝트 PROGRESS.md, protocol.md, PREPARE.md, 타입 정책, Microsoft 공식 문서 확인 |
| 도구 조회 | Build Tools 2022 17.14.37710.0, MSVC 19.44.35229.0, SDK 10.0.26100.0, CMake/CTest 4.4.4, 양 비트 수 도구·lib 확인 |
| WO-0 자동 검사 | Node.js 24.19.0, **10개 통과·실패 0·건너뜀 0**. git diff --check 통과 |
| 드라이버 빌드·LoadLibrary·export 검사 | WO-1 완료, x86/x64 Debug/Release·아래 상세 |
| Driver Manager 자체 ENV/진단 | WO-1 완료, 드라이버 DLL 미적재·로그인과 구분 |
| Driver Manager 경유 로그인·실제 서버 왕복 | 미실행, WO-4 이후 |
| Excel/Access·범용 앱·설치 | 미실행, WO-12/13 |

```powershell
powershell -NoProfile -File winodbc/scripts/inspect-environment.ps1
node --test winodbc/tests/wo0.test.mjs
git diff --check -- winodbc
```

환경 JSON은 Git 제외인 `winodbc/build/wo0/environment.json`이다. 자동 검사는 UTF-8·로컬 문서 링크·필수 함수/속성/descriptor/C 타입 계약·시험 ID·SDK 원형과 상수·현재 호스트의 도구/PE 아키텍처 증거를 확인한다. **문서 계약 검사이며 ODBC 구현/적합성 시험으로 세지 않는다.** 서버 프로세스와 임시 DB는 WO-0·WO-1에서 실행/생성하지 않았다.

## WO-1 빌드·ABI 시험 — 2026-10-21

동일한 VM-W11-CODEX에서 도구를 재조회했다. Windows 11 Pro x64 10.0.26300, Build Tools 2022 17.14.37710.0, MSVC 19.44.35229.0(v143), SDK 10.0.26100.0, CMake/CTest 4.4.4, 개발용 Node.js 24.19.0이다. 도구 절대 경로는 [환경 문서](environment.md)에 있다. C++17·`/W4 /WX /utf-8`·Debug `/MTd`·Release `/MT`를 사용했다. 이 단계에서 서버 런타임은 실행하지 않았다.

```powershell
# 저장소 루트에서 네 가지 구성 전체를 검증한다.
powershell -NoProfile -File winodbc/scripts/build-and-test.ps1
git diff --check -- winodbc
```

스크립트는 환경 재조회·WO-0 검사 → 각 아키텍처 configure → Debug/Release build·CTest → dumpbin → 양방향 비트 수 불일치 거부 → Node.js PE 검사를 실행한다. 요약은 현재 실행의 상태를 `running`/`failed`/`passed`로 기록해 이전 성공을 새 실패의 결과로 남기지 않는다. 직접 실행할 때는 `winodbc`에서 `cmake --preset x64`, `cmake --build --preset x64-debug`, `ctest --preset x64-debug`처럼 실행한다. x86 프리셋은 generator platform `Win32`이며 경로는 `build/x86`이다.

| 검증 | x64 Debug | x64 Release | x86 Debug | x86 Release | 합계 |
|---|---|---|---|---|---|
| DLL·직접 로드/예외/Manager EXE 빌드 | 성공 | 성공 | 성공 | 성공 | 4개 구성 |
| CTest | 5/5 | 5/5 | 5/5 | 5/5 | 20개 통과 |
| 반대 비트 수 DLL 거부 | 193 | 193 | 193 | 193 | 4개 통과 |
| 독립 PE 검사 | 통과 | 통과 | 통과 | 통과 | 4개 통과 |

별도의 WO-0 계약 검사 10개도 통과했다. 최종 실행의 실패·건너뜀은 모두 0이다. 빌드 구성별 반복 실행을 서로 다른 기능 수로 해석하지 않는다.

- `abi.exports`: SDK 함수 포인터로 GetProcAddress 결과를 읽고 6개 공개 이름을 찾는다. x86 stdcall 장식·ANSI A 전용 이름·접속 함수·Manager 열거 함수가 공개되지 않는지 확인한다. SQLLEN/SQLULEN/SQLPOINTER는 x64 8바이트·x86 4바이트, SQLWCHAR는 모두 2바이트이다.
- `abi.lifecycle`: 직접 적재한 DLL에서 최소 ENV를 256회 할당·해제한다. 무효 주소·다른 핸들 종류·해제 후 호출·NULL 출력·버전 값과 숫자 출력 canary·미구현 DBC의 오류/NULL 출력을 확인한다.
- `abi.diagnostics`: ENV 영문 단일 진단의 ANSI/W SQLSTATE, native 번호, 정확한/작은/0/음수 버퍼·NUL·canary·길이 조회·재조회·다음 레코드·성공 호출 후 초기화를 확인한다. W 길이는 UTF-16 코드 단위이며 일반 Unicode 변환 시험은 WO-2이다.
- `abi.exception_boundary`: 제품과 같은 경계 템플릿 안에서 `bad_alloc`·표준 예외·비표준 예외를 주입해 HY001/HY000과 SQL_ERROR를 확인한다. 메시지에 예외 원문을 복사하지 않으며 진단 없는 ENV 할당 실패도 처리한다. 실제 할당기 고갈이나 전체 핸들 OOM 시험은 아니다.
- `manager.environment`: `odbc32.lib`에만 링크한 별도 EXE에서 Manager ENV·버전·HY024 진단·해제를 확인한다. 모듈 경로와 **적재된 이미지**의 machine을 기록한다. x86의 System32 표시는 WOW64 경로일 수 있어 machine `0x014C`를 확인하며 x64는 `0x8664`이다. hwdbodbc.dll 미적재도 검사한다.
- 교차 로드: 각 EXE가 같은 구성의 반대 비트 수 DLL을 절대 경로로 로드하면 `ERROR_BAD_EXE_FORMAT(193)`으로 실패해야 한다. DLL 없음 같은 다른 실패를 통과로 처리하지 않는다.
- PE 검사: 16개 산출물의 machine/PE32·PE32+, DLL의 정확한 export 목록, 동적 CRT import 부재, DLL/직접 로드 앱의 odbc32 import 부재, Manager 앱의 odbc32 import와 hwdbodbc import 부재를 독립 파싱한다. `dumpbin /headers /exports /dependents`도 네 가지 구성의 모든 파일에서 성공했다.

DLL 실제 적재 경로는 `H:\Workspace\git\HelloWorldDB\winodbc\build\<x64 또는 x86>\bin\<Debug 또는 Release>\hwdbodbc.dll`이며 요청한 파일과 같은지 검사한다. 같은 디렉토리에 `hwdb_abi_probe.exe`, `hwdb_boundary_test.exe`, `hwdb_dm_probe.exe`가 있다. 증거는 Git 제외 `build/wo1/`의 `*-configure.log`, `*-build.log`, `*-ctest.log/xml`, `*-pe.log`, `*-mismatch.log`, `pe-audit.log`, `wo0.log`, `summary.json`이다.

현재 ENV/진단 구현은 WO-1 시험 기반이다. 전체 부모/자식 핸들·자동 descriptor·다중 진단·SQLGetDiagField·UTF-8/UTF-16/ACP는 WO-2, 실제 Manager 경유 드라이버 로그인은 WO-4 후속이다. 드라이버/DSN 등록·설치·서버 SQL·실제 앱·Core 적합성은 이 결과에 포함하지 않는다. DllMain은 즉시 반환하며 일반 초기화를 API 최초 호출로 미룬다. [Microsoft DLL 초기화 지침](https://learn.microsoft.com/en-us/windows/win32/dlls/dynamic-link-library-best-practices), [SQLAllocHandle의 ENV 실패와 Manager 지연 할당](https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/sqlallochandle-function?view=sql-server-ver17)을 확인했다.

## 후속 시험 ID

표의 ID는 지원표에서 참조할 구현 시험 묶음이다. **T-ABI는 WO-1에서 완료**했다. 나머지는 후속 단계이며 WO-1의 최소 ENV/진단 시험만으로 완료 처리하지 않는다. WO-0 검사 수에도 포함하지 않는다. 각 묶음은 성공·입력 오류·호출 순서·자원 정리와 x86/x64를 다룬다.

| ID | 단계 | 관찰할 결과 |
|---|---|---|
| T-ABI | WO-1 | 양 DLL/EXE의 machine·undecorated export·정상 로드·비트 수 불일치 거부 |
| T-HANDLE | WO-2/7 | 종류/임의 주소/해제 후/부모·자식 순서·실행 중 해제에서 충돌 없음 |
| T-DIAG | WO-2 | 다중 레코드·NO_DATA·진단 수명·영문 메시지·길이/종료 NUL·OOM |
| T-TEXT | WO-2/5 | W 단위/바이트·음수/0/NTS·emoji·깨진 Unicode·ACP 손실·canary |
| T-PROTO | WO-3 | 부분 프레임·상한·중복 키·깊이·알 수 없는 type·id·끊김·id=0 |
| T-AUTH | WO-3 | nonce 연장·반복수·서명·NFKC·오인증·CONNECT·로그 비밀 비노출 |
| T-CAPS | WO-3/6/8 | prepareDescribe/cancel 네 조합·목록 생략, 미광고 새 요청 0건 |
| T-VERSION | WO-4/8 | 2/3/3.8 ENV·잘못된 값·C 타입 검사·비동기 거부·보고 일치 |
| T-CONNECT | WO-4/12 | Manager 경유 NOPROMPT·한글·중괄호·중복 키·재접속·DSN·실패 정리 |
| T-ATTR | WO-4/5/7 | default get/set·비default/unknown·실제 대체 값·읽기 전용·상태 오류 |
| T-EXEC | WO-5 | Hello World·CRUD 영향 수·NULL·빈 값·실패 후 같은 연결 재사용 |
| T-CURSOR | WO-5/9 | fetch 1/3/500·16개 한도·조기/중복 닫기·이름·MoreResults·commit 보존 |
| T-TYPE | WO-5/9 | 전 타입 경계·38자리·BIGINT·소수 초·offset·INTERVAL·카탈로그 일치 |
| T-GETDATA | WO-5/7 | 01004 조각→마지막 성공→NO_DATA·NULL indicator·rowset/컬럼 순서 |
| T-META | WO-5/6 | 실행 전/후 metadata·UNKNOWN/힌트·nullable·DDL 무효화 |
| T-PREPARE | WO-6 | INSERT/DDL 분석 무부작용·개수·ID 해제/한도·권한 회수·무효화 |
| T-PARAM | WO-6/7 | 값은 실행 시 읽음·정확한 wire·범위 오류·일부 성공/미처리·IGNORE |
| T-ESCAPE | WO-6 | NativeSql 무실행·날짜시간 escape·NOSCAN·미지원 escape 진단 |
| T-DESC | WO-7 | ARD/APD/IRD/IPD의 get/set·복사·공유·read-only 예외·버퍼 일관성 |
| T-ROWSET | WO-7 | row/column-wise·offset·마지막 부분 묶음·status/processed·오버플로 |
| T-DAE | WO-7 | NEED_DATA·token·여러 PutData·NULL/길이 불일치·중단·긴 문자/이진 |
| T-TXN | WO-8 | OFF/ON·commit/rollback·제약/교착·앞선 변경 보존·ENV의 모든 DBC 처리 |
| T-CANCEL | WO-8 | 긴 CPU·잠금 대기·accepted/tooLate/notRunning·원 응답·실행 중 close |
| T-TIMEOUT | WO-8 | 초→ms 경계·query cancel·HYT00/HYT01·연결 dead·불명확 결과 재실행 금지 |
| T-RESET | WO-8 | Manager reset YES·재인증·모든 세션/바인딩/진단 초기화·실패 시 폐기 |
| T-CATALOG | WO-9 | 제한 사용자·뷰 전용 권한·무기본 tablespace·PK/FK·패턴/식별자·빈 결과 |
| T-INFO | WO-9/13 | 함수 true/정보 비트 전체 실제 호출, 지원표·export·행동 일치 |
| T-TLS | WO-10 | CA/이름/IP/기간·검증 기본 켬·인증서 오류만 100ms 뒤 2회 재시도 |
| T-UDP | WO-11 | 유실·중복·순서 변경·재전송·취소·유휴 ping·중복 DML 0건 |
| T-INSTALL | WO-12 | 고유 시험 등록·DSN·각 비트 수 관리자·무개발 도구 환경·실패 되돌리기 |
| T-APP | WO-13 | 도구·앱 버전/PE 비트 수·DSN/DSN-less·탐색/파라미터/한글/정확성 |
| T-CONCURRENT | WO-13 | 10연결·독립 DBC·동일 DBC 취소/해제·반복 수명·누수 검사 |

최종 행렬은 Debug/Release × x86/x64 × TCP/TLS/UDP와 설치/실제 앱이다. 결함 주입 시 시험이 실패하는지 확인하고, 성공·실패·건너뜀 수와 호스트명·컴파일러·OS·비트 수·서버 런타임을 매번 기록한다.
