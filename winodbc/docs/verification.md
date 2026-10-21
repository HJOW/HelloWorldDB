# WO-0 검증과 후속 시험

## 실행 증거

2026-10-21, **VM-W11-Codex**(실제 호스트명 `VM-W11-CODEX`), Windows 11 Pro x64 10.0.26300. 다른 PC의 빌드 툴 설치를 보증하는 기록이 아니다. 새 PC는 [환경 확인 규칙](environment.md)에 따라 호스트명·도구 설치 여부·버전·경로를 다시 기록한다.

| 검증 경로 | 이번 단계 결과 |
|---|---|
| 문서·서버 계약 검토 | AGENTS.md, 루트/프로젝트 PROGRESS.md, protocol.md, PREPARE.md, 타입 정책, Microsoft 공식 문서 확인 |
| 도구 조회 | Build Tools 2022 17.14.37710.0, MSVC 19.44.35229.0, SDK 10.0.26100.0, CMake/CTest 4.4.4, 양 비트 수 도구·lib 확인 |
| WO-0 자동 검사 | Node.js 24.19.0, **10개 통과·실패 0·건너뜀 0**. git diff --check 통과 |
| 드라이버 빌드·LoadLibrary·export 검사 | 미실행, WO-1 |
| Driver Manager 경유 로그인·실제 서버 왕복 | 미실행, WO-4 이후 |
| Excel/Access·범용 앱·설치 | 미실행, WO-12/13 |

```powershell
powershell -NoProfile -File winodbc/scripts/inspect-environment.ps1
node --test winodbc/tests/wo0.test.mjs
git diff --check -- winodbc
```

환경 JSON은 Git 제외인 `winodbc/build/wo0/environment.json`이다. 자동 검사는 UTF-8·로컬 문서 링크·필수 함수/속성/descriptor/C 타입 계약·시험 ID·SDK 원형과 상수·현재 호스트의 도구/PE 아키텍처 증거를 확인한다. **문서 계약 검사이며 ODBC 구현/적합성 시험으로 세지 않는다.** 서버 프로세스와 임시 DB는 이번 단계에서 실행/생성하지 않는다. CTest 테스트는 DLL 기반을 만드는 WO-1에 구성한다.

## 후속 시험 ID

표의 ID는 지원표에서 참조할 구현 시험 묶음이다. 현재 모두 미구현/미실행이며 WO-0 검사 수에 포함하지 않는다. 각 묶음은 성공·입력 오류·호출 순서·자원 정리와 x86/x64를 다룬다.

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
