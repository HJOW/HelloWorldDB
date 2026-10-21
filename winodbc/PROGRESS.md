# winodbc 개발 계획과 진행 상황

HelloWorldDB에 접속하는 **Windows 네이티브 ODBC 드라이버**를 개발하는 프로젝트이다. Windows의 ODBC Driver Manager를 사용하는 C/C++ 프로그램과 ODBC 지원 도구가 대상이다.

사양의 최상위 기준은 [AGENTS.md](../AGENTS.md)이다. 통신은 [서버 프로토콜](../rdbms/docs/protocol.md), 데이터 타입은 [타입 정책](../rdbms/docs/data-types.md)을 따른다. ODBC API는 AGENTS.md가 연결한 [Microsoft ODBC 문서](https://learn.microsoft.com/ko-kr/sql/odbc/microsoft-open-database-connectivity-odbc?view=sql-server-ver17)를 기준으로 한다.

## 현재 상태

- 최종 갱신: 2026-10-21.
- 진행 단계: **WO-0 ~ WO-6 완료**. 네이티브 TCP/SCRAM, User/System DSN 및 DSN 없는 접속, 직접/준비 SQL·실행 전 메타데이터·단일 파라미터·SQL escape·전진 fetch/바인딩·분할 수신·모든 DB 타입 getter를 구현했다. 전체 Core/3.8 적합성은 아직 미완료이다.
- 이번 검증: HJOW-ATHLON / Windows 10 Pro x64 10.0.19045 / MSVC 19.44.35229.0 / SDK 10.0.26100.0 / CMake·CTest 4.4.3 / Node.js 24.21.0. x86/x64 Debug/Release **CTest 52개**, 그 안의 실제 서버/결함 주입 **19개 × 4구성 = 76개**, 교차 비트 수 거부 4개·PE 검사 4개·문서/환경 10개 통과, 실패/건너뜀 0. 최신 증거는 `build/native/summary.json`(2026-10-21T12:52:08Z)과 구성별 로그/JUnit이다.
- 다음 작업: **WO-7 descriptor·행/파라미터 배열·실행 시 데이터**. 자동/명시 ARD/APD/IRD/IPD의 필드/복사/공유, 단일 바인딩과 같은 내부 레코드를 쓰는 배열, NEED_DATA/ParamData/PutData/로컬 cancel을 구현한다. 이후 cancel/reset·전체 카탈로그·TLS/UDP·Setup/설치·범용 앱 인수까지 목표는 계속 활성 상태이다. WO-6의 현재 규칙과 제한은 [prepared-statements.md](docs/prepared-statements.md)에 기록했다.
- 서버 prepare/describe·cancel의 PD-1 ~ PD-5와 기존 드라이버 회귀는 완료되어 있으며, 규약은 [protocol.md 17절](../rdbms/docs/protocol.md#17-준비-문장과-취소-2026-10-20-확장-규약)에 확정했다. PD-6의 ODBC 시험은 WO-6·WO-8·WO-13의 후속이다.
- 사용자 지시에 따라 이번 작업의 생성·변경 파일과 조회 결과는 모두 `winodbc/` 안에 둔다. 루트 PROGRESS.md는 읽기 참조로 유지하고 이 문서에 최신 요약을 기록했다. 커밋·푸시는 하지 않는다.
- TCP 저수준 앱과 별도로 Driver Manager → DLL → 실제 서버의 CRUD·타입·13개 INTERVAL·긴 Unicode·NULL·DSN·원격 CONNECT 거부·16개 서버 커서와 준비/설명/입력/반복 실행·권한 재검사·DDL 무효화를 검증했다. 등록은 해당 프로세스의 HKLM/HKCU를 임시 영역으로 매핑한 격리 시험이며 실제 시스템 설치를 뜻하지 않는다. 정상 취소·Core 완료는 후속이다.

## 1. 이 문서를 따라 작업하는 방법

1. 매 작업 시작 시 AGENTS.md, 이 문서의 현재 상태, 해당 단계, 관련 서버 문서를 읽는다. 이전 대화의 기억만으로 통신 필드를 정하지 않는다.
2. WO 번호가 작은 단계부터 진행한다. 해당 단계의 선행 조건이 안 끝났으면 의존하지 않는 작업까지만 진행하고 미완료 이유를 적는다.
3. 체크박스 하나를 구현하고 그 동작을 확인하는 시험을 추가한다. 성공 경로만 확인하지 말고 입력 오류·호출 순서·정리도 확인한다.
4. 빌드 성공, 직접 DLL 함수 호출 성공, Driver Manager 경유 성공, 실제 서버 성공은 서로 다른 증거이다. 어느 경로로 시험했는지 적는다.
5. 완료 조건을 전부 충족한 항목만 `[x]`로 바꾼다. 함수 이름만 export했거나 항상 성공을 반환하는 스텁은 구현 완료가 아니다.
6. 문서에 없는 선택을 했다면 "결정 사항"에 근거를 남긴다. 서버 사양·프로토콜 변경이 필요하면 AGENTS.md와 서버 문서를 먼저 고친 뒤 구현한다.
7. 작업 종료 전 현재 상태·작업 이력·다음 작업을 갱신하고 루트 PROGRESS.md에도 요약한다. 실행한 명령·컴파일러·OS·비트 수·서버 런타임·통과/실패/건너뜀 수를 남긴다.
8. 코드와 Markdown은 UTF-8, 주석·설명은 한국어로 작성한다. DB 오류 메시지는 영문으로 유지한다. AI는 commit·push를 하지 않는다.
9. **PC가 바뀌면 Visual Studio/Build Tools 설치를 다시 확인한다. 설치/미설치·버전·절대 경로와 PC 호스트명을 함께 문서화한다.** VM-W11-Codex에서 확인한 설치를 다른 PC의 설치 근거로 사용하지 않는다. [호스트별 기록 규칙](docs/environment.md)을 따른다.
10. 사용자 지정 작업 범위에 따라 winodbc 관련 새 파일·생성물·임시 자료는 모두 이 디렉토리에 둔다. 현재 작업은 루트 문서를 변경하지 않고 이 문서에서 인수인계한다.

## 2. 목표와 설계 기본안

아래는 상세 사양이 없는 부분에 대한 **이 계획의 기본안**이다. 사용자 확정 사항과 혼동하지 않는다. WO-0에서 도구·목표 앱에 맞는지 확인하고 변경 근거를 기록한다.

| 항목 | 기본안 |
|---|---|
| 구현 | C++17, MSVC, Windows SDK ODBC 헤더, CMake·CTest |
| 최초 검증 OS | VM-W11-Codex의 Windows 11 Pro x64 10.0.26300. 제품 기준은 Windows 11 24H2 이상 x64, 최소 OS 실제 시험은 WO-13 |
| 아키텍처 | x64 DLL과 x86 DLL을 각각 빌드. 64비트 OS의 32비트 앱도 시험 |
| ODBC 목표 | ODBC 3.8, Core 인터페이스 + 실제 DB가 제공하는 트랜잭션·카탈로그 기능 |
| 문자열 | W API의 UTF-16과 서버 UTF-8 사이를 엄격하게 변환. ANSI 경로와 SQL_C_CHAR도 별도 시험 |
| 전송 | TCP 먼저, TLS 다음, UDP 신뢰성 계층까지 구현 |
| Windows 라이브러리 | Winsock, Schannel/인증서 API, CNG의 SHA-256·HMAC·난수/PBKDF2 활용 |
| SQL 처리 | SQL과 파라미터를 분리 전송. 서버를 대신하는 별도 SQL 실행기는 만들지 않음 |
| 실행 | 동기 ODBC 호출, DBC별 실행 직렬화. SQLCancel은 별도 경로로 진입 가능 |
| 결과 | 전진·읽기 전용, 서버 fetch 묶음 단위 수신. 서버 내부 결과 전체 보관 한계는 별도 명시 |
| 설치 | Driver DLL·Setup DLL·같은 비트 수의 설치 도구를 분리. DSN 없는 접속을 먼저 완성 |
| 배포 이름 | 표시명 `HelloWorldDB ODBC Driver`, DLL 기본안 `hwdbodbc.dll`, Setup `hwdbodbc_setup.dll` |
| 실행 의존성 | Windows 네이티브 DLL. Node.js·JVM·Python 프로세스를 중간 드라이버로 실행하지 않음 |

WO-0에서 **VM-W11-Codex에 한해 Visual Studio Build Tools 2022 설치를 확인**했다. MSVC·SDK·CMake·CTest의 버전·절대 경로와 앱 확인 범위는 [environment.md](docs/environment.md)에 기록했다. JSON 3.12.0(MIT)·Windows CNG·정확한 소수 자체 변환·정적 CRT 정책은 [dependencies.md](docs/dependencies.md)에 결정했다. 다른 PC는 도구 설치를 재조회하며, 설치 확인과 실제 빌드 성공을 구분한다.

초기 제외 범위는 비동기 ODBC 실행, 스크롤·갱신 커서, 북마크, 출력 파라미터·저장 프로시저, 분산 트랜잭션, ARM64, Linux/macOS ODBC이다. **입력 파라미터 배열, data-at-execution, descriptor, SQLCancel을 단순히 선택 기능이라고 제외하지 않는다.** Core 목록과 필요한 호출 형태를 별도로 검증한다. [Core 적합성](https://learn.microsoft.com/en-us/sql/odbc/reference/develop-app/core-interface-conformance?view=sql-server-ver17), [함수별 적합성](https://learn.microsoft.com/en-us/sql/odbc/reference/develop-app/function-conformance?view=sql-server-ver17).

## 3. 계층과 파일 배치 기본안

```text
winodbc/
  PROGRESS.md
  README.md                    # 구현 후 사용할 빌드·접속·설치 설명
  CMakeLists.txt
  CMakePresets.json             # x86/x64 빌드 디렉토리를 분리
  include/hwdbodbc/
  src/odbc/                    # C ABI 진입점, 핸들, 속성, descriptor, 진단
  src/protocol/                # JSON, 프레임, 인증, 세션, 요청 ID, 커서
  src/transport/               # TCP, Schannel TLS, UDP 신뢰성
  src/types/                   # SQL 타입/C 타입/문자열 변환
  src/setup/                   # ConfigDSN, DSN 설정 UI
  installer/                   # 등록·제거·배포 패키지
  tests/unit/                  # 네트워크 없는 시험
  tests/driver_manager/        # odbc32.dll을 통해 호출하는 시험 앱
  tests/integration/           # 실제 rdbms와 결함 주입
  tests/helpers/               # 임시 서버·등록·정리 도우미
  docs/api-support.md          # 함수·속성·descriptor·길이 단위 지원표
  docs/state-machines.md       # ENV/DBC/STMT/DESC 상태와 전이
  docs/type-mapping.md
  docs/verification.md
  build/                      # 생성물, Git 제외
  dist/                       # 배포물, Git 제외
```

의존 방향은 `ODBC 진입점 → 핸들/타입/세션 → 프로토콜 → 전송`이다. 전송 코드가 SQLHSTMT나 앱 버퍼에 직접 쓰지 않게 한다. Setup DLL에서 SQL 실행기를 복제하지 않는다. 기존 JDBC/Node.js 코드를 참고하되 C++ 코드가 패키지 선언만 바꾸어 공유될 수 있다고 가정하지 않는다.

## 4. 전체 작업 순서

| 단계 | 산출물 | 다음 단계로 넘어갈 조건 |
|---|---|---|
| WO-0 | **완료**: 목표·API 지원표·서버 의존성 확정 | 문서 계약 검사 통과, ODBC 실행 시험과 구분 |
| WO-1 | **완료**: x86/x64 Debug/Release DLL·시험 앱 | ABI·export·직접 로드·비트 수 거부 통과, 로그인 후속 |
| WO-2 | **완료**: 전체 핸들·다중 진단·문자열 | 네 구성 수명/경계/동시 해제 시험 통과 |
| WO-3 | **완료**: TCP·JSON·SCRAM·저수준 왕복 | 네 구성 실제 서버·결함 주입·id 0·인증 경계 통과 |
| WO-4 | **완료**: DSN/DSN 없는 접속·기본 속성 | 두 비트 수 Manager 로그인/종료·우선순위·원격 거부 통과 |
| WO-5 | **완료**: 직접 실행·fetch·타입 변환 | Hello World·모든 타입·분할/메모리 경계·서버 커서 수명 통과 |
| WO-6 | prepare/describe·단일 파라미터 | 실행 전 메타데이터·반복 실행 성공 |
| WO-7 | descriptor·배열·실행 시 데이터 | 입력/출력 버퍼와 순서 상태 시험 통과 |
| WO-8 | 트랜잭션·취소·시간 제한·초기화 | 취소 뒤 세션·트랜잭션 정합성 유지 |
| WO-9 | 카탈로그·기능 보고 | 지원표와 실제 API 결과 일치 |
| WO-10 | TLS | 검증 기본 켬·실패·재시도 시험 통과 |
| WO-11 | UDP | 유실·중복·순서 변경에서도 정합성 유지 |
| WO-12 | DSN·Setup·설치/제거 | 각 비트 수의 등록·접속·정리 성공 |
| WO-13 | 적합성·실제 앱·배포 검증 | 기능·상태·배포 체크리스트 전체 통과 |

## 5. 단계별 구현 절차

### WO-0. 목표·지원표·서버 의존성 확정

선행 조건: AGENTS.md, 서버 protocol.md, 이 문서를 읽는다.

- [x] WO-0.1: VM-W11-Codex의 MSVC·Windows SDK·CMake·CTest·x86/x64 경로·버전을 조회했다. [환경 기록](docs/environment.md), `scripts/inspect-environment.ps1`. 다른 PC는 호스트명과 함께 설치 여부를 재기록한다.
- [x] WO-0.2: 최초/최소 OS·아키텍처·네이티브 시험 앱·관리자·Excel/Access/범용 앱의 목표/미시험을 구분했다. Office 앱은 조회 범위에서 미발견이며 드라이버 설치와 혼동하지 않았다. [목표](docs/environment.md).
- [x] WO-0.3: [API 지원 계약](docs/api-support.md)에 함수별 계층/단계·B/W export·상태·진단·시험 ID와 별도 속성/descriptor/길이 표를 작성했다. [타입](docs/type-mapping.md), [후속 시험](docs/verification.md)과 연결했다.
- [x] WO-0.4: 버전 2/3/3.8 협상·C 타입 검증·reset 재인증·비동기 미지원 보고를 명시했다. ODBC 3.8 완성 광고는 실제 구현/적합성 시험 뒤로 남겼다. [API 계약](docs/api-support.md).
- [x] WO-0.5: capabilities 없는 서버에 새 요청을 보내지 않는 규칙, UNKNOWN/힌트·준비 수명·취소 경합·HY008/HYT00 매핑을 서버 17절에 맞췄다. [서버 의존성](docs/server-dependencies.md). 서버 ODBC 시험은 미완료이다.
- [x] WO-0.6: JSON 3.12.0/MIT·정확한 10진 자체 변환·CNG·NFKC·CRT/배포 정책을 결정했다. [의존성](docs/dependencies.md). 외부 소스 도입과 실제 인증/변환 시험은 후속이다.

완료 기준: 함수·속성·descriptor·타입·서버 기능·테스트의 대응표가 있다. 서버 미구현 기능을 ODBC의 성공 스텁으로 가리지 않는다. 이 단계의 문서 검토는 드라이버 실행 시험으로 세지 않는다.

### WO-1. DLL·C ABI·두 비트 수의 시험 기반

산출물 기본 위치: CMake 파일, `src/odbc/exports.*`, architecture별 `.def`, 최소 시험 앱.

- [x] WO-1.1: x64·Win32 프리셋과 출력 경로를 분리했다. 동일한 소스의 두 DLL과 각 직접 로드/예외/Manager EXE를 Debug/Release로 빌드했다. `/utf-8 /W4 /WX`, `/MTd`·`/MT`를 적용하고 PE에서 동적 CRT import 부재를 확인했다.
- [x] WO-1.2: `include/hwdbodbc/odbc.hpp`에서 SDK `sql.h`, `sqlext.h`, `sqltypes.h`를 사용한다. 함수 포인터도 SDK 원형에서 가져온다. 타입·구조체·원형을 재정의하지 않았다.
- [x] WO-1.3: `extern "C"`·`SQL_API`와 아키텍처별 `.def`로 최소 6개 이름을 제공했다. x86 stdcall 장식을 외부에 노출하지 않으며 두 아키텍처의 실제 export 목록을 GetProcAddress·dumpbin·PE 독립 검사로 대조했다. SQLConnectW 등 접속 export는 WO-2/4 후속이다.
- [x] WO-1.4: `SQLLEN`·`SQLULEN`·SQLPOINTER·정수·SQLWCHAR 및 날짜/소수 구조체 크기를 컴파일 시 검사했다. 실측 길이/주소는 x64에서 8, x86에서 4바이트이고 SQLWCHAR는 모두 2바이트이다. ENV 숫자 출력의 4바이트 폭도 canary로 검사했다. [64비트 ODBC](https://learn.microsoft.com/en-us/sql/odbc/reference/odbc-64-bit-information?view=sql-server-ver17).
- [x] WO-1.5: DllMain은 즉시 TRUE를 반환하며 레지스트리는 최초 API 호출 때 초기화한다. 공통 C++ 예외 경계와 할당 없는 고정 진단을 만들었다. 같은 경계의 네이티브 단위 시험에서 bad_alloc→HY001·기타 예외→HY000을 확인했다. ENV 할당 자체 실패는 진단 핸들이 없어 SQL_ERROR이다. 실제 메모리 고갈·전체 진단 검증은 WO-2 후속이다.
- [x] WO-1.6: 직접 로드 앱·Manager 앱을 분리했다. 후자만 odbc32.lib에 링크하며 hwdbodbc import가 없다. 직접 DLL/Manager ENV·진단을 각각 시험했고 적재된 Manager machine도 확인했다. Manager가 드라이버 DLL을 적재하는 로그인 시험은 WO-4 후속이다.

필수 시험: `dumpbin /headers`, `/exports` 또는 동등 도구로 machine type·export를 확인한다. DLL·EXE의 x86/x64 조합이 맞는 경우와 맞지 않는 경우를 기록한다. 생성물을 지울 때는 build/dist의 절대 경로를 확인한다.

완료 기준: 두 architecture의 빌드·로드·export 검사가 통과한다. 아직 로그인할 수 없으면 README에 시제품 상태를 명시한다.

결과: 네 가지 구성 모두 통과했다. 반대 비트 수 DLL은 양방향·Debug/Release 모두 `ERROR_BAD_EXE_FORMAT(193)`으로 거부했다. [빌드 명령·시험 수·증거](docs/verification.md)에 경로와 한계를 기록했으며, WO-2 ~ WO-13은 완료 처리하지 않았다.

### WO-2. 핸들·진단·문자열 공통 처리

- [x] WO-2.1: ENV → DBC → STMT와 DBC → 명시적 DESC 소유 관계를 만든다. STMT에는 자동 ARD/APD/IRD/IPD가 필요하다. 할당/해제는 SQLAllocHandle/SQLFreeHandle로 시작한다.
- [x] WO-2.2: 등록된 핸들의 종류·수명·부모 상태를 확인한 뒤 접근한다. 잘못된 임의 주소를 곧바로 C++ 객체로 역참조하지 않는다. 무효 핸들은 SQL_INVALID_HANDLE로 처리하고 무효 핸들에 진단을 저장하려 하지 않는다.
- [x] WO-2.3: 핸들마다 진단 레코드 목록을 둔다. SQLGetDiagRec/W·SQLGetDiagField/W, SQLSTATE 5자리, native error, 영문 메시지, 레코드 번호·필요 시 행/컬럼 번호를 구현한다.
- [x] WO-2.4: 일반 API가 이전 진단을 지우는 시점과 진단 조회 API가 지우지 않는 규칙을 표로 만든다. SQL_SUCCESS_WITH_INFO·SQL_NO_DATA·SQL_ERROR를 구분한다.
- [x] WO-2.5: UTF-8 ↔ UTF-16과 SQL_NTS/명시적 길이 처리를 공통 함수로 만든다. 입력에 NUL이 포함된 경우도 명시적 길이에 맞추어 다룬다. 깨진 UTF-8·짝이 없는 surrogate는 오류로 처리한다.
- [x] WO-2.6: W 함수의 길이를 일괄적으로 문자 수라고 가정하지 않는다. 함수/인자별 단위를 지원표에 적는다. SQLExecDirectW 텍스트 길이는 UTF-16 코드 단위, SQLGetInfoW 버퍼 길이와 SQLGetData 데이터 버퍼 길이는 바이트라는 차이를 시험한다. [Unicode 인자 규칙](https://learn.microsoft.com/en-us/sql/odbc/reference/develop-app/unicode-function-arguments?view=sql-server-ver17).
- [x] WO-2.7: Unicode 드라이버 인식에 필요한 SQLConnectW를 포함한다. ANSI 호출은 Driver Manager의 매핑 또는 명시적 wrapper 경로를 정한다. 직접 구현할 때는 unsuffixed ANSI export도 고려하며 A 접미사만 내보내지 않는다. SQL_C_CHAR 바인딩 변환은 Unicode 드라이버가 담당한다. [Unicode 드라이버](https://learn.microsoft.com/en-us/sql/odbc/reference/develop-app/unicode-drivers?view=sql-server-ver17).

필수 시험: 타입이 다른 핸들·해제 후 호출·부모보다 먼저 해제해야 하는 자식·NULL 출력 인자·음수 길이·길이 0·한글·emoji·정확히 맞는 버퍼·끝의 canary가 유지되는 버퍼. 진단 문자열이 잘릴 때에도 길이와 종료 문자가 맞아야 한다.

완료 기준: 서버 없이 핸들·오류·문자열 경계 시험이 통과한다. "모든 W 길이에 sizeof(SQLWCHAR)를 곱한다" 같은 공통 편법을 사용하지 않는다.

### WO-3. 저수준 JSON·TCP·SCRAM

이 단계는 ODBC 버퍼를 쓰지 않는 프로토콜 계층부터 시험한다.

- [x] WO-3.1: JSON 객체·배열·NULL·논리·문자열·숫자 코덱을 준비한다. 메시지의 타입·범위·깊이·Unicode·중복 필드 처리 정책을 검증한다. BIGINT·NUMERIC·날짜시간은 명세대로 문자열이다.
- [x] WO-3.2: Winsock TCP에서 4바이트 big-endian 본문 길이를 처리한다. 부분 send/recv, 여러 프레임의 합쳐진 수신, 인증 전 64KiB·후 16MiB 한도를 메모리 할당 전에 검사한다.
- [x] WO-3.3: hello → authStart → authFinish → READY 상태를 구현한다. 버전·메커니즘·nonce·반복수 1~10,000,000·서버 서명을 확인한다. 비밀번호 NFKC 정규화는 기존 서버와 동일하게 한다.
- [x] WO-3.4: 요청 id 증가와 응답 짝짓기, id 0의 서버 종료/유휴 오류, 일반 문장 오류와 연결 종료 오류를 구분한다. 서버가 모르는 선택 필드와 알려지지 않은 응답 종류를 혼동하지 않는다.
- [x] WO-3.5: execute/fetch/closeCursor/ping/close를 구현하고 SQLSTATE·native error를 보존한다. 오류 뒤 같은 연결을 계속 쓸 수 있는지 구분한다.
- [x] WO-3.6: 임시 config·data/log 디렉토리·빈 TCP/UDP 포트로 실제 서버를 띄우는 시험 도우미를 만든다. 서버를 정상 종료한 뒤 디렉토리를 지운다. PID만 보고 다른 프로세스를 종료하지 않는다.

필수 시험: 올바른/틀린 비밀번호, 버전 불일치, 위조 서버 서명, 잘못된 UTF-8·프레임 길이·응답 id, 중간 끊김, 기본 테이블스페이스 null, fetch 여러 묶음. 비밀번호·SCRAM 비밀키가 로그에 없어야 한다.

완료 기준: 네이티브 저수준 시험 앱이 실제 서버에서 SELECT 1을 실행하고 정상 종료한다. ODBC 함수가 통과했다고 대신 기록하지 않는다.

### WO-4. Driver Manager 경유 접속과 속성

- [x] WO-4.1: SQLConnect/W, SQLDriverConnect/W, SQLDisconnect, ENV/DBC 속성 get/set을 연결한다. 우선 SQL_DRIVER_NOPROMPT의 DSN 없는 경로를 완성한다.
- [x] WO-4.2: 연결 문자열 파서를 만든다. 키의 대소문자·공백·중복·빈 값·중괄호로 감싼 값과 이스케이프를 ODBC 연결 문자열 규칙에 맞추어 처리한다. 단순히 세미콜론 split만 하지 않는다.
- [x] WO-4.3: 아래 연결 속성을 파싱·검증하고 명시 속성 > DSN > 기본값 순서를 정한다. `DSN`은 설정 이름이며 서버의 SID나 DB 이름이 아니다.
- [x] WO-4.4: 접속·재접속·접속 중인 핸들에 중복 로그인·연결하지 않은 핸들의 실행을 상태표대로 처리한다. SQL_ATTR_LOGIN_TIMEOUT의 단위는 초이고 내부 ms 변환의 오버플로를 검사한다.
- [x] WO-4.5: SQL_ATTR_CURRENT_CATALOG를 테이블스페이스 변경으로 오용하지 않는다. 테이블스페이스는 Tablespace 속성/USE로 다루고 카탈로그가 없다는 사실을 메타데이터와 일치시킨다.
- [x] WO-4.6: 출력 연결 문자열·진단·추적에서 PWD를 제거하거나 가린다. 지원하지 않는 UI 모드를 임의로 성공시키지 않고, WO-12에서 실제 prompting 경로를 추가한다.

연결 문자열 예시 기본안:

```text
DRIVER={HelloWorldDB ODBC Driver};Server=127.0.0.1;Port=7410;UID=SYSTEM;PWD=HelloWorldDB;Tablespace=SYSTEM;
```

| 키 | 기본값/의미 |
|---|---|
| Server, Port | localhost와 7410, host·port로 인스턴스 지정 |
| UID, PWD | 사용자명 필수, 비밀번호는 앱 입력. 서버 초기 암호를 드라이버 기본 암호로 넣지 않음 |
| Tablespace, TimeZone | 생략 시 사용자/서버 기본값. Tablespace가 없어도 로그인 가능 |
| Transport | TCP, 이후 UDP 추가 |
| SSL, SSLCA, SSLVerify | false, Windows 신뢰 저장소, true. SSLCA는 선택적 PEM CA 파일 |
| FetchSize | 500, 서버 허용 범위 1~100,000 |

필수 시험: Driver Manager의 SQLAllocHandle → SQLSetEnvAttr → SQLDriverConnectW → SQLDisconnect → SQLFreeHandle 흐름, 한글 값, 값 안의 세미콜론/닫는 중괄호, 포트 범위 오류, 원격 CONNECT 권한 거부. 이 단계부터 실제 Manager가 로드한 DLL 경로를 기록한다.

완료 기준: x86·x64의 같은 비트 수 시험 앱에서 DSN 없는 로그인이 된다. 개발용 임시 드라이버 등록과 최종 설치 프로그램을 구분한다.

### WO-5. 직접 실행·결과·타입 변환

- [x] WO-5.1: SQLExecDirect/W, SQLNumResultCols, SQLRowCount, SQLDescribeCol/W, SQLColAttribute/W를 실행 후 결과에 연결한다. SELECT와 rows가 없는 문장을 구분한다.
- [x] WO-5.2: SQLFetch와 SQLFetchScroll(SQL_FETCH_NEXT), SQLCloseCursor, SQLFreeStmt의 CLOSE/UNBIND/RESET_PARAMS/DROP 의미를 구현한다. STMT 재실행·해제에서 자신의 커서를 정리한다.
- [x] WO-5.2a: SQLGetCursorName/W·SQLSetCursorName/W의 이름 생성·명시 이름·길이·중복·호출 상태를 구현한다. 이름을 붙이는 기능과 positioned UPDATE/DELETE 지원은 구분한다.
- [x] WO-5.3: 한 번에 하나의 서버 fetch 묶음을 보관하고 행 위치를 관리한다. 마지막 행, 결과 없음, fetch 후 SQL_NO_DATA, 커밋·롤백 후에도 읽을 수 있는 결과를 시험한다.
- [x] WO-5.4: SQLBindCol의 버퍼·타입·길이·indicator 주소를 보관하고 fetch할 때 실제 값을 쓴다. NULL은 SQL_NULL_DATA로 표시하고 indicator가 없으면 22002 같은 표준 오류를 낸다. 빈 문자열은 NULL과 다르다.
- [x] WO-5.5: SQLGetData의 긴 문자/이진 값을 여러 번 읽는 위치를 컬럼별로 관리한다. 중간 01004 경고, 마지막 성공, 그 다음 SQL_NO_DATA, 다음 행에서 위치 초기화를 구현한다.
- [x] WO-5.6: 지원하는 SQL_GETDATA_EXTENSIONS를 먼저 정한다. 초기에는 row array size 1·증가하는 unbound 컬럼 순서의 기본 규칙을 구현하고, ANY_COLUMN/ANY_ORDER/BOUND/BLOCK을 시험 없이 광고하지 않는다.
- [x] WO-5.7: 아래 타입 표와 공식 변환표를 따라 getter 변환을 구현한다. 데이터의 범위 초과와 앱 수신 버퍼의 잘림을 구분한다. 고정 크기 C 타입은 ODBC의 규정된 크기로 쓰며 BufferLength를 문자열처럼 해석하지 않는다. [SQLGetData](https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/sqlgetdata-function?view=sql-server-ver17), [SQL→C 변환](https://learn.microsoft.com/en-us/sql/odbc/reference/appendixes/converting-data-from-sql-to-c-data-types?view=sql-server-ver17).

필수 시험: SELECT 'Hello World', CRUD 영향 행 수, fetchSize 1/3/500, 16개 커서 한도·조기 닫기, 모든 타입·NULL·한글/emoji·긴 VARCHAR·binary 0x00, 작은 앱 버퍼에서 분할 수신 후 원문 재구성.

완료 기준: 실제 서버 왕복과 ODBC 메모리 경계 시험을 둘 다 통과한다. SQLPrepare 뒤의 메타데이터는 WO-6의 별도 완료 조건이다.

### WO-6. prepare/describe·단일 파라미터

선행 조건: WO-5와 서버 PD-1 ~ PD-3. 서버가 기능을 광고하지 않는 경우의 시제품 경로와 정식 지원 경로를 구분한다.

- [x] WO-6.1: SQLPrepare/W로 SQL을 저장·준비하고 SQLExecute로 실행한다. `?`의 개수를 문자열·큰따옴표 식별자·줄/블록 주석 안의 물음표와 구분한다. SQLNumParams를 제공한다.
- [x] WO-6.2: 서버가 확정한 prepare/describe/executePrepared/해제 요청을 연결한다. 실행 전 결과 컬럼·개수와 결과 없음·타입 미정을 구분한다.
- [x] WO-6.3: SQLBindParameter의 ParameterNumber, InputOutputType, ValueType, ParameterType, ColumnSize, DecimalDigits, BufferLength, indicator를 저장한다. SQL 타입과 C 메모리 타입을 같은 값으로 보지 않는다.
- [x] WO-6.4: 바인딩한 버퍼는 실행 시 읽는다. 바인딩 직후 값을 복사해 고정하면 앱이 버퍼를 바꾼 뒤 재실행할 때 틀릴 수 있다. 문자열·NULL·binary·정수·정확한 소수를 wire Param으로 변환한다.
- [x] WO-6.5: 타입 힌트를 필요로 하는 SELECT ?는 바인딩 정보 또는 명시적 CAST로 재분석한다. SQLDescribeParam은 확실한 정보가 있을 때만 제공하고, 모르면 미지원으로 보고한다. SQLNumParams와 SQLDescribeParam을 혼동하지 않는다. [파라미터 설명의 한계](https://learn.microsoft.com/en-us/sql/odbc/reference/develop-app/describing-parameters?view=sql-server-ver17).
- [x] WO-6.6: 준비 문장 해제·STMT 재준비·연결 종료·권한 회수·객체 변경 뒤의 상태를 처리한다. 준비 시 허용되었다는 이유로 실행 권한 검사를 생략하지 않는다.
- [x] WO-6.7: SQL_ATTR_NOSCAN과 SQLNativeSql/W, 날짜/시간 escape 등 지원할 ODBC SQL escape 범위를 문서화한다. 지원하지 않는 escape를 원문 그대로 보내고 변환 완료라고 알리지 않는다.

필수 시험: INSERT를 prepare/describe만 했을 때 데이터가 늘지 않음, 수동 트랜잭션이 commit되지 않음, 실행 전 SELECT 메타데이터, 버퍼 값 변경 후 2회 실행, 따옴표/주석의 ?, 미바인딩/범위 밖 인덱스, 한 번 준비 후 GRANT/REVOKE·ALTER.

완료 기준: 실행 전에 정확한 결과 메타데이터를 얻고 같은 준비 문장을 다른 값으로 반복 실행한다. 메타데이터를 얻으려고 실제 실행했다가 rollback하거나 문자열로 파라미터를 치환하지 않는다.

### WO-7. descriptor·행 배열·파라미터 배열·실행 시 데이터

- [ ] WO-7.1: 자동/명시적 ARD·APD·IRD·IPD, SQLGet/SetDescField/W, SQLGet/SetDescRec/W, SQLCopyDesc를 구현한다. 읽기 전용 구현 descriptor의 변경을 거부하고 애플리케이션 descriptor의 소유·연결 교체를 처리한다.
- [ ] WO-7.2: SQLBindCol/SQLBindParameter/SQLSetStmtAttr와 descriptor 필드가 동일한 내부 상태를 보도록 만든다. 각 API에 서로 다른 바인딩 사본을 두지 않는다. [Descriptor 필드](https://learn.microsoft.com/en-us/sql/odbc/reference/develop-app/descriptor-fields?view=sql-server-ver17).
- [ ] WO-7.3: SQL_ATTR_ROW_ARRAY_SIZE, ROW_BIND_TYPE, ROW_BIND_OFFSET_PTR, ROW_STATUS_PTR, ROWS_FETCHED_PTR를 지원한다. column-wise와 row-wise 배치, bind offset, 마지막 부분 행 묶음을 시험한다.
- [ ] WO-7.4: PARAMSET_SIZE, PARAM_BIND_TYPE, PARAM_BIND_OFFSET_PTR, PARAM_STATUS_PTR, PARAMS_PROCESSED_PTR를 지원한다. 서버가 일괄 API를 제공하지 않으면 항목별로 순서대로 실행하고 실제 처리 수·실패/미처리 상태를 보고한다.
- [ ] WO-7.5: SQL_DATA_AT_EXEC와 SQL_LEN_DATA_AT_EXEC의 입력을 SQL_NEED_DATA → SQLParamData → SQLPutData → 실행 흐름으로 처리한다. 입력받는 중에도 SQLCancel이 빠져나올 수 있게 한다.
- [ ] WO-7.6: 분할 입력은 서버 16MiB·문자열 길이·파라미터 수 한도를 검사하며 모은다. 입력 길이가 미리 주어진 경우 실제 길이와 맞는지 확인한다. LOB가 없다는 이유로 긴 VARCHAR/VARBINARY 입력을 생략하지 않는다.
- [ ] WO-7.7: 바인딩 버퍼는 앱 소유이고 DLL 해제 대상이 아님을 코드 구조로 보장한다. 주소 계산의 곱셈·덧셈·SQLLEN 변환 오버플로를 검사한다.

필수 시험: 구조체 배열의 서로 다른 offset·alignment, 0/1/여러 항목, NULL indicator 배열, 둘째 파라미터 집합에서 제약 위반, 일부 성공 상태, 여러 PutData, 취소·닫기·재바인딩·descriptor 복사 후 버퍼 주소. x86/x64를 모두 실행한다.

완료 기준: 단일 행 시험뿐 아니라 입력 배열·행 배열·실행 시 데이터가 정확하다. SQLGetData의 rowset 제한은 SQLGetInfo 보고와 일치해야 한다.

### WO-8. 트랜잭션·취소·시간 제한·풀 초기화

선행 조건: WO-7과 서버 PD-4 ~ PD-6. 서버의 정상 취소를 사용하고 소켓 종료만으로 대체 완료 처리하지 않는다.

- [ ] WO-8.1: SQL_ATTR_AUTOCOMMIT 기본 ON, OFF 전환, SQLEndTran(DBC)의 COMMIT/ROLLBACK, ENV 수준 호출의 각 연결 처리를 구현한다. 여러 연결을 원자적으로 묶는 분산 트랜잭션이라고 보고하지 않는다.
- [ ] WO-8.2: 격리는 READ COMMITTED만 지원한다. DDL·GRANT/REVOKE의 앞뒤 자동 커밋과 연결 종료 시 미커밋 변경 롤백을 그대로 반영한다.
- [ ] WO-8.3: SQLCancel과 필요 시 SQLCancelHandle을 서버 cancel에 연결한다. execute를 기다리는 스레드가 잠근 동일 mutex를 cancel이 무기한 기다리지 않게 한다. 수신은 한 곳에서 하고 id별 응답을 분배한다.
- [ ] WO-8.4: SQLParamData/SQLPutData 대화 취소와 실행 중 취소를 나누어 구현한다. 취소 접수와 원래 요청의 최종 취소 완료를 구분한다. 이미 끝난 요청·취소 불가 커밋 단계·늦은 취소가 다음 요청에 적용되지 않게 한다.
- [ ] WO-8.5: LOGIN_TIMEOUT·CONNECTION_TIMEOUT·QUERY_TIMEOUT의 적용 범위·기본값·0·단위를 정한다. 취소 가능 시간 초과는 서버 취소를 시도하고, 응답 동기화에 실패하면 연결을 dead로 표시하여 재사용하지 않는다.
- [ ] WO-8.6: 서버의 취소 SQLSTATE와 ODBC HY008, 사용자 취소와 HYT00/HYT01을 명시적으로 매핑한다. native error와 원래 서버 상태를 진단에 보존한다. 통신 단절 후 결과가 불확실한 DML을 자동 재실행하지 않는다.
- [ ] WO-8.7: ODBC 3.8의 SQL_ATTR_RESET_CONNECTION을 처리한다. 열린 커서·준비 문장·미커밋 변경·현재 테이블스페이스·타임존·자동 커밋·바인딩/진단 상태의 초기화 범위를 정의한다.
- [ ] WO-8.8: 원래 tablespace가 null이었던 세션 등 현재 프로토콜만으로 되돌릴 수 없는 상태를 숨기지 않는다. 서버 초기화 기능을 검토하거나, 안전하게 초기화할 수 없는 물리 연결을 풀에서 재사용하지 않도록 실패·폐기 경로를 구현한다. 단순 성공 스텁은 금지한다.

필수 시험: 커밋 가시성·롤백·DDL 자동 커밋, 잠금 대기 취소와 긴 CPU 질의 취소, 취소 후 앞선 트랜잭션 변경 보존·다음 SELECT, 완료/취소 경합, 시간 초과, 같은 DBC의 경쟁 호출·여러 DBC 동시 실행, Driver Manager 풀에서 다음 사용자에게 상태가 남지 않음. [SQLCancel](https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/sqlcancel-function?view=sql-server-ver17).

완료 기준: 취소가 실제로 실행을 멈추고 다음 요청의 결과를 훔치지 않는다. 풀에 반환한 세션에 이전 실행의 상태가 남지 않는다. 커밋된 작업을 취소했다고 잘못 알리지 않는다.

### WO-9. 카탈로그·기능·속성 보고

- [ ] WO-9.1: SYSTEM.SYS_TABLESPACES/TABLES/COLUMNS/VIEWS/INDEXES/INDEX_COLUMNS/CONSTRAINTS/CONSTRAINT_COLUMNS 등을 조회하여 SQLTables/W·SQLColumns/W·SQLStatistics/W·SQLSpecialColumns/W·SQLGetTypeInfo/W를 제공한다.
- [ ] WO-9.2: SQLPrimaryKeys/W·SQLForeignKeys/W와 필요한 권한/프로시저 목록도 지원표에 따라 추가한다. 저장 프로시저가 없다는 것은 올바른 컬럼 구조를 가진 빈 카탈로그 결과로 표현할 수 있으며 호출 실행 지원을 뜻하지 않는다.
- [ ] WO-9.3: 테이블스페이스는 schema, catalog는 없음으로 표현한다. SQL_ALL_CATALOGS/SQL_ALL_SCHEMAS/SQL_ALL_TABLE_TYPES의 특별 호출과 SQL_ATTR_METADATA_ID의 패턴/식별자 차이를 처리한다. `%`, `_`, escape, null과 빈 문자열을 구분한다.
- [ ] WO-9.4: 결과 컬럼 이름·순서·SQL 타입·정렬 규약을 Microsoft 함수별 문서와 맞춘다. SYS_COLUMNS에 없는 뷰 컬럼은 서버 describe로 얻는다. 권한 필터를 우회하거나 테이블 전체 데이터를 읽지 않는다.
- [ ] WO-9.5: SQLGetInfo/W·SQLGetFunctions를 실제 지원표에서 생성하거나 같은 단일 정의를 사용한다. 함수 하나 조회·전체 함수 배열·ODBC3 비트맵 형태를 각각 시험한다.
- [ ] WO-9.6: SQL_DRIVER_ODBC_VER, interface/SQL conformance, schema/catalog, 트랜잭션·커서·GetData·배열·최대 길이·비동기 미지원 등 반환값을 검증한다. Driver Manager가 담당하는 SQL_DM_VER/SQL_ODBC_VER와 드라이버 버전을 혼동하지 않는다.
- [ ] WO-9.7: SQLGet/SetEnvAttr·ConnectAttr·StmtAttr의 기본값과 지원 값이 Core 요구를 충족하는지 감사한다. 미지원 값에 무조건 성공을 반환하지 말고 함수 규약의 HYC00/HY092/01S02 등을 사용한다.
- [ ] WO-9.8: SQLMoreResults는 한 문장 규칙에 맞게 현재 결과를 마무리하고 추가 결과 없음(SQL_NO_DATA)을 반환하도록 구현한다. 남은 커서 해제·DML 뒤 호출·반복 호출·호출 순서 오류를 시험한다.

필수 시험: DBA·제한 사용자·기본 tablespace 없는 사용자·뷰만 권한 있는 사용자, 복합 PK/FK·ASC/DESC 인덱스, 특수 식별자, 타입 인자 생략과 명시, 모든 SQLGetFunctions의 true 항목을 실제 호출하는 시험.

완료 기준: 탐색에 보이는 객체·타입·기능과 실제 실행 가능 범위가 일치한다. SQLGetFunctions가 true라는 이유만으로 해당 함수 시험을 생략하지 않는다.

### WO-10. TCP TLS

- [ ] WO-10.1: Schannel 전송을 공통 메시지 전송 인터페이스에 연결한다. 핸드셰이크의 추가 입력·남는 입력·분할 TLS 레코드·연결 종료와 전송 버퍼 수명을 처리한다.
- [ ] WO-10.2: Windows 기본 신뢰 저장소와 호스트/IP 이름·인증서 기간 검증을 기본으로 사용한다. SSLCA의 PEM 파일은 연결 전용 신뢰 구성으로 처리하고 시스템 저장소를 임의로 수정하지 않는다.
- [ ] WO-10.3: 수동 검증 경로를 쓰면 인증서 체인과 SSL 정책의 호스트 검증을 빠짐없이 수행한다. "Schannel 암호화가 켜짐"만으로 인증서 검증이 끝났다고 판단하지 않는다. [Schannel 자격 증명 검증](https://learn.microsoft.com/en-us/windows/win32/secauthn/manually-validating-schannel-credentials).
- [ ] WO-10.4: 검증 끄기는 명시 옵션에서만 허용한다. 인증서 오류에만 새 연결로 100ms 뒤 최대 2회 재시도하며, hello/auth 전에 처리한다. 버전 불일치·연결 거절·일반 timeout은 인증서 재시도로 분류하지 않는다.
- [ ] WO-10.5: 기본 서버 TLSv1.2 이상에서 시험한다. 이 Windows 드라이버에 Java 6을 위한 구버전 TLS 요구를 추가하지 않는다.

필수 시험: 기본 신뢰 실패, 지정 CA 성공, 다른 호스트 인증서·만료/시작 전 인증서 거부, 검증 끄기, 정확한 재시도 횟수, 실패 자원 정리, TLS를 통한 실행·fetch·취소·트랜잭션.

완료 기준: 동일 ODBC 동작이 TLS에서도 되며 인증서 검증 실패를 성공 연결로 바꾸지 않는다.

### WO-11. UDP 신뢰성 계층

- [ ] WO-11.1: protocol.md의 20바이트 big-endian 헤더·플래그·주소와 sessionId·방향별 seq를 그대로 구현한다. Windows 구조체 메모리를 그대로 wire에 쓰지 않는다.
- [ ] WO-11.2: SYN/ACK/DATA/FIN/RST, 조각·재조립, 즉시 ACK·누적 ACK·중복 제거·순서 보장, 한 메시지/32조각 창을 구현한다.
- [ ] WO-11.3: RFC 6298 RTO·Karn·backoff·재전송 한도, 잘못된 패킷 무시·크기/조각/메모리 한도, 서버 maxPacketSize 협상을 구현한다.
- [ ] WO-11.4: 유휴 sessionTimeoutMs/3 ping과 0 처리, 실행 중·유휴 ACK 처리, 종료·로그인 실패·서버 종료 시 타이머/스레드 정리를 구현한다. SQLCancel 응답과 실행 응답도 각각 id로 처리한다.
- [ ] WO-11.5: SSL+UDP 조합은 거부한다. 전송 계층의 재전송과 애플리케이션 DML 재실행을 혼동하지 않는다.

필수 시험: 양방향 유실·중복·지연·순서 변경, 잘린/오염된 헤더, 큰 UTF-8 요청/응답, 장시간 유휴, 도중 종료·재전송 한도. 중계 도우미는 접속마다 별도 upstream 소켓을 사용하여 두 JDBC 시험에서 확인한 주소 충돌 문제를 반복하지 않는다.

완료 기준: TCP의 타입·메타데이터·트랜잭션·취소 시험을 UDP에서도 실행한다. 데이터가 맞는지와 요청이 중복 실행되지 않았는지를 모두 검증한다.

### WO-12. DSN·Setup DLL·설치/제거

- [ ] WO-12.1: User DSN·System DSN·DSN 없는 접속의 구성 저장/읽기를 구분한다. DSN에는 Server·Port·Tablespace 등 필요한 설정을 저장하고 비밀번호는 기본 저장하지 않는다.
- [ ] WO-12.2: Setup DLL에 ConfigDSN/W·필요한 ConfigDriver를 구현한다. 추가/수정/삭제, double-NUL 속성 목록, 무인 설정과 UI 취소를 처리한다. SQLWriteDSNToIni·설정 API를 사용하고 오류는 installer 진단으로 돌려준다. [ConfigDSN](https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/configdsn-function?view=sql-server-ver17).
- [ ] WO-12.3: SQLDriverConnect의 PROMPT/COMPLETE 계열을 지원 범위대로 연결한다. HWND 유무·필수 정보 부족·사용자 취소를 처리하고 UI 없이 필요한 정보가 있으면 무인 접속이 된다.
- [ ] WO-12.4: 설치 도구가 DLL 파일 배치·ODBC 등록·사용 횟수·제거를 책임지도록 한다. SQLInstallDriverEx·SQLRemoveDriver 등 installer API의 역할을 따른다. SQLInstallDriverEx 호출만으로 파일 복사와 런타임 설치까지 완료됐다고 보지 않는다. [설치 API](https://learn.microsoft.com/en-us/sql/odbc/reference/syntax/sqlinstalldriverex-function?view=sql-server-2017).
- [ ] WO-12.5: x86/x64의 등록·DLL 경로를 나누고 앱과 드라이버의 비트 수를 맞춘다. 64비트 관리자는 `%windir%\System32\odbcad32.exe`, 32비트 관리자는 `%windir%\SysWOW64\odbcad32.exe`이다. 폴더 이름 때문에 반대로 쓰지 않는다. [Windows ODBC 관리자 비트 수](https://learn.microsoft.com/en-us/troubleshoot/sql/connect/odbc-tool-displays-32-bit-64-bit).
- [ ] WO-12.6: 관리자 권한이 필요한 드라이버 등록/System DSN 작업과 User DSN 작업을 구분한다. 시험용 고유 이름·별도 설치 경로로 기존 드라이버·사용자 DSN을 덮어쓰지 않는다.
- [ ] WO-12.7: 선택한 CRT·외부 라이브러리의 비트 수/배포 라이선스와 의존 파일을 포함한다. 업그레이드·사용 중 DLL·설치 실패 되돌리기·제거 후 남길 DSN 정책을 정한다.

필수 시험: 각 비트 수 관리자에서 드라이버 표시, DSN 생성·수정·삭제, DSN 없는/있는 접속, 잘못된 아키텍처, 설정 UI 취소, 설치/제거 반복, 타사 드라이버·기존 DSN·서버 데이터 보존.

완료 기준: 깨끗한 시험 환경에서 소스 디렉토리와 개발 도구 없이 배포물만으로 접속한다. 전역 등록 시험과 배포·공개 여부는 실제 구현 작업의 승인 범위에 맞추어 수행한다.

### WO-13. 적합성·실제 앱·최종 인수

- [ ] WO-13.1: Core 함수·필수 호출 형태·속성·descriptor 필드를 공식 목록과 대조한다. SQLDrivers/SQLDataSources 등 Driver Manager 담당 기능을 드라이버에 중복 구현하지 않았는지도 확인한다.
- [ ] WO-13.2: ODBC 3.x/3.8 환경 설정을 사용하는 네이티브 x86/x64 앱으로 전체 시험을 실행한다. ODBC 2.x 호환은 Driver Manager 매핑 범위와 별도 목표 여부를 기록한다.
- [ ] WO-13.3: 최소 한 개의 범용 ODBC 탐색 도구와 목표 앱에서 DSN/DSN-less·객체 탐색·파라미터·한글·NULL·DECIMAL·날짜시간·대량 결과를 시험한다. Excel/Access/ADO 등을 시험하지 않았으면 미시험으로 적는다.
- [ ] WO-13.4: 10개 연결의 동시 조회·변경·취소·연결 종료, 같은 연결의 STMT 여러 개·커서 한도, 권한 변경과 서버 종료를 시험한다. 취소가 다른 연결의 작업을 중단하지 않아야 한다.
- [ ] WO-13.5: Debug/Release, x86/x64, TCP/TLS/UDP 조합과 설치 시험의 결과표를 만든다. 메모리 검사 도구·반복 할당/해제·스레드 종료 검사를 포함한다.
- [ ] WO-13.6: 지원표에서 true인 기능을 호출하는 자동 시험을 돌리고, unsupported 경로의 반환값·SQLSTATE도 검사한다. 안전한 시험 환경에서 결함 주입으로 경계 검사가 실제로 실패를 잡는지 확인한다.
- [ ] WO-13.7: README·타입/연결/진단/제약 문서·검증 기록·라이선스·배포 파일 목록·설치/제거 설명을 작성하고 이 문서와 루트 PROGRESS.md를 갱신한다.

최종 완료 기준: 두 비트 수에서 모든 필수 시험을 통과하고 Driver Manager와 실제 앱을 거쳤다는 증거가 있다. 서버 PD 작업이 미완료이거나 미시험 필수 기능이 있으면 "시제품"으로 남긴다. DLL 생성이나 SELECT 1 성공만으로 프로젝트 완료를 선언하지 않는다.

## 6. 타입 대응과 데이터 손실 규칙

다음은 구현 기본안이다. SQLGetTypeInfo·SQLColumns·SQLDescribeCol·IRD와 실제 변환을 같은 정의에서 만들고, [ODBC SQL 타입](https://learn.microsoft.com/en-us/sql/odbc/reference/appendixes/sql-data-types?view=sql-server-ver17)과 SDK C 구조체를 대조한다.

| DB 타입 | ODBC SQL 타입 기본안 | C 타입·정밀도 정책 |
|---|---|---|
| CHAR / VARCHAR | SQL_WCHAR / SQL_WVARCHAR | SQL_C_WCHAR 기본, SQL_C_CHAR도 변환. 원래 DB 타입 이름은 유지 |
| NCHAR / NVARCHAR | 위와 동일 | 서버 정규화 타입을 따른다. 별칭만 보고 다른 저장 인코딩을 가정하지 않음 |
| BINARY / VARBINARY | SQL_BINARY / SQL_VARBINARY | SQL_C_BINARY, 길이·중간 0바이트 보존 |
| SMALLINT / INTEGER / BIGINT | SQL_SMALLINT / SQL_INTEGER / SQL_BIGINT | SQL_C_SSHORT / SQL_C_SLONG / SQL_C_SBIGINT. 범위 검사 |
| DECIMAL / NUMERIC | SQL_DECIMAL 또는 정규화에 맞는 SQL_NUMERIC | SQL_C_NUMERIC·문자열. 38자리까지 double 없이 처리 |
| REAL / DOUBLE PRECISION | SQL_REAL / SQL_DOUBLE | SQL_C_FLOAT / SQL_C_DOUBLE. NaN·무한대 오류 |
| BOOLEAN | SQL_BIT | SQL_C_BIT, NULL indicator 별도 |
| DATE | SQL_TYPE_DATE | SQL_DATE_STRUCT, 유효 날짜와 0001~9999 |
| TIME(p) | SQL_TYPE_TIME | SQL_TIME_STRUCT에는 소수 초가 없음. 원문 문자 변환 제공, 손실 변환의 경고 정책 검증 |
| TIMESTAMP(p) | SQL_TYPE_TIMESTAMP | SQL_TIMESTAMP_STRUCT.fraction은 ns 단위. 서버 μs × 1000으로 보존 |
| TIME/TIMESTAMP WITH TIME ZONE | 초기에는 SQL_WVARCHAR로 노출 | 표준 구조체에 오프셋을 억지로 넣지 않음. typeName·원문·소수 초·오프셋 보존을 문서화 |
| INTERVAL | 한정자에 맞는 SQL_INTERVAL_* | SQL_INTERVAL_STRUCT 및 문자열. YEAR~MONTH와 DAY~SECOND 계열 구분 |

필수 세부 규칙:

- VARCHAR/NVARCHAR 기본·최대 65,535, DECIMAL 인자 전체 생략 (10,3), NUMERIC(p)는 (p,0)을 실제 서버 메타데이터에서 읽는다. 드라이버 기본값으로 명시한 선언을 덮어쓰지 않는다.
- DB 문자 길이는 Unicode 코드 포인트이고 W API 문자열 길이는 인자에 따라 UTF-16 코드 단위 또는 바이트이다. emoji 한 글자의 코드 포인트 수·UTF-16 두 단위·UTF-8 네 바이트를 구분하는 시험을 둔다. ColumnSize와 옥텟 길이를 같은 값으로 복사하지 않는다.
- ANSI API/SQL_C_CHAR는 Windows 코드 페이지 변환 정책을 정한다. 기본안은 Windows ANSI 코드 페이지이며 UTF-8이라고 몰래 가정하지 않는다. 표현 불가능한 문자를 `?`로 바꾸지 말고 규약에 맞는 진단을 낸다. Unicode 경로는 원문 왕복이 되어야 한다.
- SQL_NUMERIC_STRUCT의 precision·scale·부호·정수 바이트 표현은 SDK 정의를 따른다. 소수 정수화와 반대 변환, 양/음수·0·38자리·scale 경계를 시험한다.
- 고정 길이 문자열의 뒤 공백을 임의로 제거하지 않는다. 빈 문자열·길이 0 이진 값·NULL을 구분한다.
- 서버 INSERT의 길이 초과 오류와 ODBC 수신 버퍼가 작아서 발생한 01004 경고는 다르다. 값을 저장할 때 조용히 잘라 넣지 않는다. 숫자의 정수부 손실은 오류, 소수/날짜시간 손실은 변환별 규정된 경고/오류를 사용한다.
- SQLGetData 분할 수신 길이는 그 호출의 공식 규약을 따른다. 매 조각에 원래 전체 길이를 무조건 반복하거나 반환한 바이트 수로 임의 대체하지 않는다. 마지막 유효 조각과 이후 SQL_NO_DATA를 시험한다.

## 7. API 지원표에 반드시 들어갈 묶음

| 묶음 | 주요 함수·기능 | 담당 단계 |
|---|---|---|
| 핸들·진단 | SQLAllocHandle, SQLFreeHandle, SQLFreeStmt, SQLGetDiagRec/Field | WO-2, WO-7 |
| 접속·속성 | SQLConnect, SQLDriverConnect, SQLDisconnect, Env/Connect/Stmt Get/SetAttr | WO-4, WO-8, WO-9 |
| 실행·준비 | SQLExecDirect, SQLPrepare, SQLExecute, SQLNumParams, SQLNativeSql | WO-5, WO-6 |
| 바인딩·분할 입력 | SQLBindParameter, SQLParamData, SQLPutData, 입력 배열 | WO-6, WO-7 |
| 결과·메타데이터 | SQLFetch, SQLFetchScroll(NEXT), SQLBindCol, SQLGetData, SQLDescribeCol, SQLColAttribute, SQLNumResultCols, SQLRowCount | WO-5, WO-7 |
| 커서 수명·이름 | SQLCloseCursor, SQLGetCursorName, SQLSetCursorName, SQLMoreResults | WO-5, WO-9 |
| Descriptor | SQLCopyDesc, SQLGet/SetDescField, SQLGet/SetDescRec, ARD/APD/IRD/IPD | WO-7 |
| 트랜잭션·취소 | SQLEndTran, SQLCancel, 선택 지원 SQLCancelHandle, 시간 제한·풀 초기화 | WO-8 |
| 카탈로그·능력 | SQLTables, SQLColumns, SQLStatistics, SQLSpecialColumns, SQLGetTypeInfo, SQLGetInfo, SQLGetFunctions, PK/FK 등 | WO-9 |
| Driver Manager 담당 | SQLDrivers, SQLDataSources, ODBC 2.x 매핑·공통 풀 관리 | WO-12/13에서 경유 검증 |

SQLMoreResults는 한 요청 한 문장 규칙에서 현재 결과를 닫고 더 없음을 반환하는 경로부터 검증한다. 이를 여러 SQL 문장을 자동 분리 실행하는 기능으로 확장하지 않는다. 커서 이름 지원을 positioned UPDATE/DELETE 지원으로 오해하지 않는다.

## 8. 오류·상태·동시성 검토표

| 상황 | 계획상 처리 원칙 |
|---|---|
| 잘못된 핸들 | SQL_INVALID_HANDLE, 유효하지 않은 주소 접근 금지 |
| 잘못된 호출 순서 | 함수별 HY010/24000 등. 열린 커서·NEED_DATA·실행 중 상태 구분 |
| 앱 가변 길이 출력 버퍼 부족 | SQL_SUCCESS_WITH_INFO와 01004, 종료 문자·indicator·필요 길이 정확히 반환 |
| NULL인데 indicator 없음 | 22002 등 함수별 규정 |
| 수치 범위·문자/날짜 변환 오류 | 22003·22018·22007 등 해당 규정 |
| 선택 기능 미지원 | 함수 규정의 HYC00 등, SQLGetFunctions·SQLGetInfo 보고와 일치 |
| 서버가 반환한 SQL 오류 | SQLSTATE·native error 기본 보존. ODBC상 변환이 필요한 경우 매핑과 원래 상태를 명시 |
| 사용자 취소·제한 시간 | HY008/HYT00/HYT01 등 동작별 매핑. 정상 완료와 경합 시 실제 결과를 보존 |
| 통신 단절 | 연결 dead와 08S01 등 규정된 진단. 불확실한 DML 자동 재실행 금지 |

서버 미지원 SQL의 0A000과 ODBC 자체 API/속성 오류를 구분한다. 다른 드라이버의 예외 이름이나 JDBC SQLSTATE 선택을 그대로 복사하지 않는다. 반환할 SQLSTATE는 실제 구현할 ODBC 함수의 공식 오류 표와 대조한다.

같은 DBC의 서버 요청은 직렬화하되, 진단 조회·취소·해제를 위한 동시성 규칙을 별도로 정한다. 서로 다른 DBC를 하나의 전역 실행 mutex로 묶지 않는다. 해제 중인 핸들을 다른 스레드가 사용하는 경우에도 use-after-free·교착이 없도록 수명과 잠금 순서를 문서화한다.

## 9. 인수인계와 피해야 할 구현

- `SELECT 1` 성공으로 ODBC 완성 처리하지 않는다. descriptor·배열·진단·실행 전 메타데이터·취소·설치가 별도 단계로 남아 있다.
- 드라이버 함수에서 같은 이름의 Driver Manager 함수를 다시 호출하여 재귀하지 않는다. 시험 앱만 odbc32.dll 경로를 사용한다.
- SQL 문장의 `?`를 문자열 값으로 치환하지 않는다. 메타데이터를 얻으려고 INSERT/UPDATE/DDL을 실행하지 않는다.
- SQLLEN/SQLULEN을 int/long으로 통일하지 않는다. 모든 W 인자 길이를 문자 수 또는 바이트 수 하나로 통일하지 않는다.
- 사용자 버퍼를 delete/free하지 않는다. SQLBindParameter 때 복사한 옛 값을 계속 실행하지 않는다.
- 지원표에 true를 먼저 쓰지 않는다. 미지원 기능·잘못된 속성을 성공 스텁으로 통과시키지 않는다.
- 원격 CONNECT 권한은 서버가 판정한다. ODBC가 localhost에 접속한다고 로컬 CLI의 무제한 접속 보장을 상속받는 것은 아니다.
- 취소와 시간 초과를 소켓 끊기만으로 정상 완료 처리하지 않는다. 서버의 rdbms/PREPARE.md 작업을 선행 조건으로 추적한다.
- 설치·제거 시험은 고유한 시험용 드라이버/DSN과 격리된 경로를 사용한다. 기존 사용자 DSN과 실제 서버 데이터를 정리 대상으로 포함하지 않는다.

## 10. 미결 사항과 결정 기록

사용자가 Windows용 ODBC 첫 단계 진행과 파일의 winodbc 내부 배치를 지시했다. 도구 기록은 해당 PC에 한정하고 다른 PC에서도 호스트명과 설치 여부를 함께 기록하도록 추가 지시했다. 아래는 WO-0에서 정한 구현 선택과 남은 사항이다.

- 제품 기준은 Windows 11 24H2 이상 x64 및 WOW64 x86 앱이다. Windows Server·ARM64는 이번 범위에서 제외한다. 최소 OS 클린 환경 시험은 WO-13에 남긴다.
- VM-W11-Codex에서 도구 설치/버전/경로를 재조회하고 WO-1의 x86/x64 Debug/Release 빌드를 완료했다. 다른 PC는 [환경 기록 규칙](docs/environment.md)에 따라 호스트명을 포함해 재조회한다. C++17·MSVC v143·CMake 3.25 이상, 정적 CRT, JSON 3.12.0(MIT) 및 Windows API 정책을 유지한다. JSON 도입은 WO-3이다.
- 네이티브 x86/x64 시험 EXE와 Windows ODBC 관리자를 필수 경로로 정했다. Excel/Access 앱·범용 ODBC 도구 버전과 비트 수의 실제 설치/사용 확인은 WO-13에 남긴다. 현재 PC 조회에서 Office 앱·범용 탐색 앱은 발견하지 못했다.
- 서버 준비 문장/describe/cancel의 wire 규약·타입 힌트·기능 협상은 확정·구현되었다. ODBC 진단·descriptor·수명으로의 매핑과 세션 초기화의 추가 서버 지원 필요 여부는 WO-0·WO-6·WO-8에서 검토한다.
- 배포 패키지 형식·코드 서명·설치 표시명·업그레이드 정책. 문서 기본안은 확정 배포 정책이 아니다.
- 서버에 포괄적 reset 요청이 없으므로 WO-8은 물리 연결 재인증으로 초기화한다. 효율적인 풀 재사용을 위한 서버 확장은 별도 후속이며 성공 스텁으로 대체하지 않는다.
- WO-1의 export 범위는 ENV와 영문 단일 진단의 최소 ABI 경로이다. 전체 목표 함수를 미리 성공 스텁으로 만들지 않는다. ENV 조회/레지스트리 잠금은 초기 기반이며 WO-2에서 자식 수명·동시 해제·주소 재사용·핸들별 진단으로 확장한다. DBC 요청 실행을 전역 mutex로 직렬화하는 설계로 이어가지 않는다.

## WO-0 완료 인수인계

- 추가한 README·환경/API/타입/서버/의존성/검증 문서, 환경 조회 스크립트·문서 검사 코드는 모두 winodbc 안에 있다. 생성 JSON은 build/wo0 안의 Git 제외 파일이다. 루트/다른 프로젝트는 변경하지 않았다.
- VM-W11-Codex, Windows 11 Pro x64 10.0.26300, MSVC 19.44.35229.0·SDK 10.0.26100.0·CMake/CTest 4.4.4를 확인했다. 이 도구 설치 기록을 다른 PC에 일반화하지 않는다.
- WO-0 검사는 문서·SDK·환경 대응을 확인한다. DLL/Manager/서버 왕복·적합성은 미시험이며 서버 런타임을 실행하지 않았다. 다음 WO-1에서 컴파일/링크/로드/비트 수 검사를 새로 수행한다.
- `powershell -NoProfile -File winodbc/scripts/inspect-environment.ps1` 조회와 Node.js 24.19.0의 `node --test winodbc/tests/wo0.test.mjs` **10개 통과·실패 0·건너뜀 0**, `git diff --check -- winodbc` 통과. 명령·경로·검사 범위는 [검증 기록](docs/verification.md)에 남겼다.

## WO-1 완료 인수인계

- `CMakeLists.txt`·`CMakePresets.json`, SDK 기반 헤더·예외 경계, 최소 ENV 구현·x86/x64 `.def`, 직접 로드/Manager/예외 시험 EXE, PE 검사·빌드 스크립트를 추가했다. 변경·로그·생성물은 모두 winodbc 내부이며 루트/타 프로젝트는 읽기만 했다.
- VM-W11-CODEX / Windows 11 Pro x64 10.0.26300 / MSVC 19.44.35229.0 / SDK 10.0.26100.0 / CMake·CTest 4.4.4 / 개발용 Node.js 24.19.0에서 검증했다. 서버 런타임은 실행하지 않았다.
- `powershell -NoProfile -File winodbc/scripts/build-and-test.ps1`로 네 가지 구성 CTest **20개**, 교차 비트 수 거부 **4개**, PE 검사 **4개**, WO-0 계약 **10개** 통과·실패/건너뜀 0이다. dumpbin 헤더/export/dependents·JUnit·로그·집계는 Git 제외 `build/wo1/`에 있다. `git diff --check -- winodbc`도 통과했다.
- 현재 DLL은 접속할 수 없는 시제품이며 Manager 자체의 ENV/진단 시험과 직접 DLL 시험을 분리했다. 설치·등록·DSN 변경·네트워크·ODBC Core 적합성·제품 최소 OS 시험은 하지 않았다. 다음 작업은 WO-2이다.

## 작업 이력

- 2026-10-21: WO-6의 7개 항목을 완료했다. SQLPrepare/W·Execute·NumParams·DescribeParam·BindParameter·NativeSql/W의 8개 export를 추가해 총 51개가 되었다. 서버 capability·UNKNOWN/CAST/바인딩 힌트, 실행 시 앱 버퍼 읽기·정확한 38자리 소수·binary/NULL/날짜시간/offset/13개 INTERVAL, SQL escape/NOSCAN, 준비/설명의 무부작용·미커밋 변경 보존·70회 재준비/해제·권한 회수·DDL 무효화를 실제 Manager로 검증했다. C→SQL의 문자 숫자 손실 22001·날짜시간 손실 22008·INTERVAL 손실 22015와 숫자 C 입력의 선택적 01S07을 getter와 구분했다. x86 NativeSql/W의 stdcall 장식 크기 오류를 수정했다. 네 구성 CTest 52개(내부 Node 76개), 교차 로드 4개·PE 4개·문서/환경 10개가 통과했고 실패/건너뜀은 0이다. WO-7부터 전체 목표는 계속 진행하며 변경·생성물은 winodbc 안에만 두었다. 커밋·푸시는 하지 않았다.

- 2026-10-21: WO-3 ~ WO-5를 완료했다. 응답 스키마/id 0/인증 후 전이, DSN 읽기와 속성 우선순위, 직접 SQL·메타데이터·기본 바인딩·분할 수신·모든 DB 타입/13개 INTERVAL·커서 이름/수명과 종료 시 자식 무효화를 추가했다. 원격 CONNECT 거부와 fetchSize 1/3/500을 실제 Manager/서버로 확인했다. 네 구성 CTest 44개(내부 Node 76개), 교차 로드 4개·PE 4개·문서/환경 10개 통과, 실패/건너뜀 0이다. SDK x86 SQLColAttribute 원형 차이를 수정했고 해제된 Manager 포인터의 재사용과 드라이버 토큰 검증을 구분했다. WO-6 SQL escape 독립 초안은 아직 미연결/미시험이며 준비 문장·파라미터 구현부터 계속해야 한다. 전체 목표는 미완료·활성 상태이고 변경/생성물은 winodbc 안에만 두었다. 커밋·푸시는 하지 않았다.

- 2026-10-21: 전체 완료 목표를 시작했다. HJOW-ATHLON에서 도구를 재조회하고 다중 VS/SDK 레지스트리 조회 문제를 수정했다. WO-2의 전체 핸들·진단·엄격한 Unicode/ACP를 완료하고 WO-3 TCP/JSON/CNG SCRAM 및 WO-4 DSN 없는 ODBC 접속을 구현했다. x86/x64 Debug/Release CTest 40개(내부 Node 통합 64개), 교차 거부 4개·PE 4개·문서/환경 10개가 통과했다. 실제 서버 저수준 왕복과 격리 레지스트리의 Driver Manager 로그인을 구분해 기록했다. WO-3/4 잔여 검증과 WO-5 이후 구현은 계속 진행해야 하며 전체 완료로 표시하지 않았다. 변경·임시 서버·증거는 winodbc 안에만 두었고 커밋·푸시는 하지 않았다.

- 2026-10-21: 다음 단계 WO-1의 6개 항목을 완료했다. x86/x64 Debug/Release DLL·시험 앱, C ABI/export·정적 CRT·예외 경계·최소 ENV/진단과 자동 검증을 추가했다. CTest 20개·비트 수 거부 4개·PE 4개·문서/환경 10개가 통과했다. WO-2 전체 핸들·진단·문자열 처리를 다음 작업으로 기록했다. 모든 변경·생성물은 winodbc 내부이며 커밋·푸시는 하지 않았다.

- 2026-10-21: 사용자 지시에 따라 첫 단계 WO-0의 6개 항목을 완료했다. VM-W11-Codex에 한정한 도구 설치 조회, 호스트별 재확인 규칙, 함수·속성·descriptor·길이·타입·서버 기능·진단·시험 대응, 의존성/배포 선택과 재실행 가능한 조회·검사를 추가했다. 문서·환경 검사 10개 통과·실패/건너뜀 0이다. 드라이버 구현은 WO-1부터이며 모든 변경·생성물을 winodbc 안에 두었다. 커밋·푸시는 하지 않았다.

- 2026-10-20: 서버 PD-1 ~ PD-5·기존 드라이버 회귀와 jdbc6 새 API 연동 완료를 반영했다. 서버 규약 의존성은 해소했고 PD-6의 ODBC 시험은 남아 있다. ODBC 코드·DLL 구현과 적합성 시험은 이번 작업에 포함하지 않았다.

- 2026-10-20: AGENTS.md를 다시 읽고 빈 winodbc/PROGRESS.md에 WO-0 ~ WO-13 개발 계획을 작성했다. 각 단계의 절차·필수 시험·완료 기준, ODBC 3.8 Core/Unicode/descriptor·배열·취소·x86/x64 설치 주의점을 명시했다. 사용자 추가 지시에 따라 서버 prepare/describe·cancel을 rdbms/PREPARE.md의 다음 작업으로 연결했다. 구현·빌드·실행 시험과 드라이버 등록은 하지 않았다.
