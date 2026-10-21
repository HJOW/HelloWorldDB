# HelloWorldDB Windows ODBC

Windows 네이티브 ODBC 3.8 드라이버 프로젝트이다. 현재 **WO-1(x86/x64 DLL·C ABI·시험 기반) 완료** 상태인 시제품이다. DLL 직접 로드와 최소 ENV/진단 호출을 검증했다. 접속·SQL 실행·설치·ODBC Core 적합성은 후속 단계이며, 다음은 [WO-2](PROGRESS.md)의 전체 핸들·진단·문자열 처리이다.

- [개발 환경과 목표 앱](docs/environment.md)
- [API·속성·descriptor·길이 단위 지원 계획](docs/api-support.md)
- [타입 대응](docs/type-mapping.md)
- [서버 기능 협상과 진단 매핑](docs/server-dependencies.md)
- [의존성과 배포 정책](docs/dependencies.md)
- [검증 기록과 시험 ID](docs/verification.md)

저장소 루트에서 다음 명령으로 현재 PC의 환경을 재조회하고 양 비트 수의 Debug/Release 빌드와 검사를 실행한다. Visual Studio Build Tools 2022의 v143 x86/x64·Windows SDK, CMake/CTest 3.25 이상, 개발용 Node.js 22 이상이 필요하다. 설치 여부는 [호스트별 환경 기록](docs/environment.md)과 구분해 직접 확인한다.

```powershell
powershell -NoProfile -File winodbc/scripts/build-and-test.ps1
```

일부 구성만 실행하려면 `winodbc` 디렉토리에서 다음과 같이 실행한다. x86은 프리셋 이름을 `x86`, `x86-debug`로 바꾼다. Release는 `x64-release` 또는 `x86-release`를 쓴다.

```powershell
cmake --preset x64
cmake --build --preset x64-debug
ctest --preset x64-debug
```

DLL과 시험 EXE는 `build/<x86 또는 x64>/bin/<Debug 또는 Release>/`에 생성된다. 빌드는 C++17, SDK ODBC 헤더, `/W4 /WX /utf-8`, Debug `/MTd`·Release `/MT`를 사용한다. DLL은 ODBC Manager에 링크하지 않으며, 정적 CRT의 메모리를 앱에 해제하도록 넘기지 않는다. Debug 산출물은 배포하지 않는다.

`hwdb_abi_probe.exe`는 DLL을 직접 적재해 장식 없는 export·호출 규약·최소 ENV 수명·진단 버퍼를 검사한다. `hwdb_boundary_test.exe`는 공통 예외 경계의 `bad_alloc`→HY001과 기타 예외→HY000을 검사한다. `hwdb_dm_probe.exe`는 `odbc32.lib`만 링크해 시스템 Manager의 ENV와 진단을 검사한다. **현재 Manager 시험은 hwdbodbc.dll을 적재하거나 로그인하지 않는다.** 드라이버 등록·DSN 변경·서버 실행은 하지 않는다.

현재 DLL의 6개 export는 `SQLAllocHandle`(ENV만), `SQLFreeHandle`(ENV만), `SQLSetEnvAttr`, `SQLGetEnvAttr`(버전·OUTPUT_NTS만), `SQLGetDiagRec`, `SQLGetDiagRecW`(ENV의 영문 단일 레코드만)이다. DBC 할당은 SQL_ERROR/HY000으로 시제품 미구현 상태를 알린다. ENV 할당 자체가 실패하면 진단을 저장할 핸들이 없으므로 SQL_ERROR만 반환한다. 이 목록은 최종 지원표의 완료를 뜻하지 않는다.

전체 스크립트는 환경 JSON을 `build/wo0/`, 빌드·CTest/JUnit·dumpbin·교차 로드·PE 검사 로그와 `summary.json`을 `build/wo1/`에 남긴다. PE 검사는 실제 machine, export 목록, 정적 CRT와 Manager import 분리를 확인한다. Node.js는 개발용 검사에만 쓰며 제품 실행 의존성이 아니다.

문서와 환경만 검사할 때는 다음 명령을 사용한다.

```powershell
powershell -NoProfile -File winodbc/scripts/inspect-environment.ps1
node --test winodbc/tests/wo0.test.mjs
```

생성 파일·시험 자료·추후 임시 서버의 config/data/log와 빌드/배포물은 모두 `winodbc` 안에 둔다. 기존 프로젝트는 읽기 참조만 한다. 이번 작업의 진행 요약은 [PROGRESS.md](PROGRESS.md)에 모았다.
