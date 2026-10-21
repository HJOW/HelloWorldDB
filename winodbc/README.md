# HelloWorldDB Windows ODBC

Windows 네이티브 ODBC 3.8 드라이버 프로젝트이다. 현재 **TCP/SCRAM 접속, 직접/준비 SQL, 실행 전 메타데이터, descriptor·행/파라미터 배열, fetch·바인딩·분할 수신과 모든 DB 타입 getter**를 구현한 시제품이다. Driver Manager와 실제 서버를 거치는 x86/x64 시험을 포함한다. 실행 시 데이터·취소·TLS·UDP·설치·Core 적합성과 descriptor 해제 후 Manager 조회의 재현 사례는 [PROGRESS.md](PROGRESS.md)의 후속이다.

- [개발 환경과 목표 앱](docs/environment.md)
- [API·속성·descriptor·길이 단위 지원 계획](docs/api-support.md)
- [타입 대응](docs/type-mapping.md)
- [준비 문장·파라미터·SQL escape](docs/prepared-statements.md)
- [Descriptor·배열과 남은 Manager 재현 사례](docs/descriptors-arrays.md)
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

`hwdb_abi_probe.exe`는 DLL 직접 로드·export·호출 규약·수명·진단 버퍼를 검사한다. `hwdb_handles_test.exe`, `hwdb_descriptor_test.exe`, `hwdb_text_test.exe`, `hwdb_connection_test.exe`, `hwdb_protocol_test.exe`는 네트워크 없는 내부 시험이다. 자동 STMT/DESC 수명의 내부 시험은 연결 상태를 주입하며 실제 로그인 증거와 구분한다. `hwdb_protocol_probe.exe`는 중간 런타임 없이 TCP·CNG 인증·실제 서버의 execute/fetch/closeCursor/ping/close를 수행한다.

`hwdb_dm_probe.exe`는 Manager 자체의 ENV를, `hwdb_dm_connection.exe`는 Manager → 드라이버 DLL → 실제 서버의 로그인·STMT/DESC·종료를 시험한다. 후자는 `RegOverridePredefKey`로 **시험 프로세스의 HKLM/HKCU를 고유한 HKCU 임시 키에 연결**하고 installer API로 등록/제거한다. 실제 시스템 드라이버와 기존 DSN을 수정하지 않으며, 관리자 권한의 시스템 설치 시험을 대신하지 않는다. Node.js는 격리된 서버를 구동하고 결함을 주입하는 시험 도우미이며 DLL은 Node.js·JVM·Python을 실행하지 않는다.

SQLConnect/W는 User/System DSN을 읽고 SQLDriverConnect/W는 명시 속성 > DSN > 기본값으로 접속한다. DSN에는 비밀번호를 기본 저장하지 않는다. SQLExecDirect/W·SQLPrepare/W·SQLExecute·SQLNumParams·SQLDescribeParam·SQLBindParameter·SQLNativeSql/W와 결과 메타데이터·fetch·커서 수명을 제공한다. SQLGetInfo/W·SQLGetFunctions는 현재 구현한 기능만 보고하며 ODBC Core·3.8 완성은 광고하지 않는다. 전체 목표와 현재 범위는 [API 계약](docs/api-support.md)을 따른다.

전체 스크립트는 환경 JSON을 `build/wo0/`, 빌드·CTest/JUnit·dumpbin·교차 로드·PE 검사와 `summary.json`을 `build/native/`에 남긴다. 실제 서버 config/data/log는 `build/integration/` 아래 고유 임시 디렉토리를 사용하고 정상 종료 후 제거한다. 서버 빌드 `../rdbms/dist/`가 먼저 존재해야 한다.

접속 문자열은 다음 형식이다. 이 단계에서는 DLL을 직접 호출하거나 격리 Manager 시험 앱에서 사용한다. 일반 앱용 설치는 WO-12의 후속이다.

```text
DRIVER={HelloWorldDB ODBC Driver};Server=127.0.0.1;Port=7410;UID=SYSTEM;PWD=HelloWorldDB;Tablespace=SYSTEM;
```

비밀번호 기본값은 없다. 연결 문자열은 중괄호와 `}}` 이스케이프를 지원하며 중복 키는 첫 값을 사용한다. 출력 연결 문자열에서는 비밀번호를 제거한다. 미지원 TLS/UDP를 지정하면 HYC00으로 거부한다.

문서와 환경만 검사할 때는 다음 명령을 사용한다.

```powershell
powershell -NoProfile -File winodbc/scripts/inspect-environment.ps1
node --test winodbc/tests/wo0.test.mjs
```

생성 파일·시험 자료·추후 임시 서버의 config/data/log와 빌드/배포물은 모두 `winodbc` 안에 둔다. 기존 프로젝트는 읽기 참조만 한다. 이번 작업의 진행 요약은 [PROGRESS.md](PROGRESS.md)에 모았다.
