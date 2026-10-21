# 개발 환경과 목표

## PC별 확인 규칙

**아래 설치 확인 결과는 VM-W11-Codex에만 해당한다. 다른 PC에 Visual Studio 또는 Visual Studio Build Tools가 설치되어 있다고 가정하지 않는다.** 다른 PC에서 처음 작업할 때와 도구 변경 후에는 `scripts/inspect-environment.ps1`을 다시 실행한다. 기록에는 확인일, PC 호스트명, OS, Visual Studio/Build Tools 설치 여부, 버전과 절대 경로, MSVC·SDK·CMake·CTest·대상 아키텍처를 함께 남긴다. 미설치도 호스트명과 함께 명시하고, 이전 PC의 성공 기록을 새 PC의 검증 결과로 사용하지 않는다. 호스트명은 OS 조회값을 쓰고 파일명이나 대화 내용으로 추정하지 않는다.

자동 조회의 `computer`에는 실제 OS 값인 `VM-W11-CODEX`가 기록된다. 아래의 `VM-W11-Codex`는 같은 PC의 표기이다. 원본은 `winodbc/build/wo0/environment.json`이며 재조회하면 현재 PC 결과로 교체된다. 다른 PC에서 얻은 결과는 아래 형식으로 이 문서나 검증 문서에 추가해 기존 기록을 보존한다.

```text
확인일 / 호스트명 / OS·비트 수
Visual Studio 또는 Build Tools: 설치/미설치, 제품·버전·경로
MSVC / Windows SDK / CMake / CTest: 버전·경로 또는 미설치
x86·x64 도구/라이브러리: 확인/미확인
실제로 실행한 빌드·시험과 미시험 범위
```

## VM-W11-Codex — 2026-10-21 확인

Windows 11 Pro x64, 버전 `10.0.26300`, 빌드 `26300`. Windows PowerShell로 CIM·레지스트리·vswhere·파일 버전을 조회하고 CMake/CTest/MSVC/Linker/Dumpbin/MSBuild의 버전 명령을 직접 실행했다. 아래 표의 경로 별칭은 이 PC의 기록을 줄여 적은 것이며 빌드 스크립트의 고정 경로가 아니다.

| 별칭 | 이 PC의 절대 경로 |
|---|---|
| VS | `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools` |
| VC | `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207` |
| SDK | `C:\Program Files (x86)\Windows Kits\10` |

| 도구 | 설치 확인·버전 | 실행 경로 |
|---|---|---|
| Visual Studio Build Tools 2022 | **VM-W11-Codex에서 설치 확인**, 17.14.37710.0 | VS, `vswhere.exe`로 확인 |
| MSVC x64 대상 | 19.44.35229.0, toolset 14.44.35207 | VC 아래 `bin\Hostx64\x64\cl.exe` |
| MSVC x86 대상 | 19.44.35229.0 | VC 아래 `bin\Hostx64\x86\cl.exe` |
| Linker / Dumpbin | 양 대상 경로 존재, 14.44.35229.0 | VC 아래 `bin\Hostx64\{x64,x86}\link.exe`, `dumpbin.exe` |
| MSBuild | 17.14.60.43110 | VS 아래 `MSBuild\Current\Bin\MSBuild.exe` |
| Windows SDK | 10.0.26100.0 | SDK 아래 `Include\10.0.26100.0\um` 및 `Lib\10.0.26100.0` |
| CMake / CTest | 둘 다 4.4.4 | `C:\Users\BUZZ\AppData\Local\Microsoft\WinGet\Links\cmake.exe`, `ctest.exe` |
| Node.js (개발용) | 24.19.0 | `C:\Program Files\nodejs\node.exe` |

SDK의 `sql.h`, `sqlext.h`, `sqltypes.h`, `sqlucode.h`와 x86/x64의 `odbc32.lib`, `odbccp32.lib`, `ws2_32.lib`, `bcrypt.lib`, `secur32.lib`, `crypt32.lib`, `normaliz.lib`, `libucrt.lib`를 확인했다. MSVC의 양 대상 `libcmt.lib`도 있다. 기본 셸 PATH에는 cl/link/dumpbin/MSBuild가 없으므로 WO-1은 vswhere로 찾은 설치를 CMake의 VS generator로 사용한다. 기존 개발자 셸 환경을 필수로 가정하지 않는다. Hostx64의 x86 compiler 실행 파일 자체는 x64 PE이며, 이것은 생성할 앱의 비트 수와 다르다.

| Windows 구성 요소 | 경로 | 파일 버전 | PE machine |
|---|---|---|---|
| x64 Driver Manager | `C:\Windows\System32\odbc32.dll` | 10.0.26100.9549 | 0x8664 |
| x86 Driver Manager | `C:\Windows\SysWOW64\odbc32.dll` | 10.0.26100.9549 | 0x014C |
| x64 ODBC 관리자 | `C:\Windows\System32\odbcad32.exe` | 10.0.26100.8875 | 0x8664 |
| x86 ODBC 관리자 | `C:\Windows\SysWOW64\odbcad32.exe` | 10.0.26100.7019 | 0x014C |

파일 버전은 SQL_DM_VER/SQL_ODBC_VER의 반환값이 아니다. 실제 Driver Manager 경유 확인은 WO-4 이후이다.

## 제품 범위 결정

WO-0의 구현 기준은 Windows 11 24H2 이상 x64 OS, x64 앱과 WOW64의 x86 앱이다. x86 DLL은 32비트 Windows OS 지원을 뜻하지 않는다. 최초 시험 PC의 빌드 26300 성공만으로 최소 OS의 실제 동작을 보증하지 않으며, 최소 OS 클린 환경 시험은 WO-13에 남긴다. Windows 10·Windows Server·ARM64의 지원은 이번 범위에 넣지 않는다. C++17, MSVC v143, Windows SDK ODBC 원형, CMake 3.25 이상을 빌드 기준으로 정한다. 실제 확인한 CMake는 4.4.4이며 3.25 하한은 아직 미시험이다.

| 목표 앱/경로 | VM-W11-Codex 설치 확인 | 시험 계획 |
|---|---|---|
| 자체 네이티브 시험 EXE, x86/x64 | 아직 미구현 | WO-1 직접 로드, WO-4 이후 Driver Manager, WO-13 전체 행렬 |
| Windows ODBC 관리자, 양 비트 수 | 위 경로·machine 확인 | WO-12 등록·DSN UI, WO-13 배포 |
| Microsoft Excel / Access | App Paths 양 registry view, 일반 Office16 경로, 제거 등록에서 앱 미발견 | 버전·앱 PE 비트 수를 확인한 PC에서 WO-13 실제 사용 시험. 현재 미시험 |
| 범용 ODBC 탐색 앱 | DBeaver App Paths/일반 경로와 관련 제거 등록 미발견 | WO-13에서 실제 ODBC 연결 경로를 제공하는 도구·버전 확정 후 시험 |

포터블 앱 전체 디스크 검색은 하지 않았다. 기존 32비트 Excel/Access **ODBC 드라이버**는 발견했으나 Office **앱**의 설치 증거로 쓰지 않는다. 앱을 설치하거나 기존 DSN/드라이버 등록을 변경하지 않았다.
