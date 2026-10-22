# 개발 환경과 목표

## 2026-10-22 vm-debian-codex 확인

이 프로젝트의 첫 환경 확인이다. **이 기록은 이 호스트에만 해당한다.**

| 항목 | 확인 결과 | 경로·비고 |
|---|---|---|
| OS | Debian GNU/Linux 13 (trixie) 13.7, x86_64 | 커널 6.12.113+deb13-amd64 |
| 호스트명 | `vm-debian-codex` | `hostname()` 결과 |
| 권한 | 일반 사용자(uid 1000), 암호 없는 sudo 없음 | 시스템 설치 대신 `.deps/` 사용 |
| GCC/G++ | 14.2.0 (Debian 14.2.0-19) | `/usr/bin/g++`, target `x86_64-linux-gnu` |
| CMake/CTest | 4.4.4 | `.deps/python/cmake/data/bin/cmake` (pip 바퀴) |
| unixODBC | 2.3.12 (`SQL_SPEC_STRING` 03.52) | `.deps/sysroot/usr/include`, `lib/x86_64-linux-gnu` |
| isql/iusql | unixODBC 2.3.12 | `.deps/sysroot/usr/bin` (`LD_LIBRARY_PATH` 필요) |
| odbcinst | unixODBC 2.3.12 | `.deps/sysroot/usr/bin` (`odbcinst -j` 로 등록 경로 확인) |
| SQLWCHAR | 2바이트 UTF-16 (`wchar_t` 변환 아님) | 환경 JSON 의 `abi.odbc.sqlwcharSize` |
| Node.js | 24.16.0 | `/usr/local/node/node-v24.16.0-linux-x64/bin/node` |
| Bun | 1.4.0 | 선택 확인용 |
| `rdbms` 빌드 | `dist/src/cli/main.js` 존재 | 통합 시험 도우미가 사용 |

- 시스템에는 `cmake` 와 `unixodbc-dev` 가 설치되어 있지 않다. `scripts/setup-deps.sh` 가 `.deps/` 에 준비했다.
- 32비트 개발 패키지, Valgrind, clang 은 이 호스트에서 확인하지 않았다. 해당 시험은 UO-13 의 선택 항목이다.
- 원본은 `build/<프리셋>/uo0/environment.json` 이고 `scripts/inspect-environment.mjs` 로 다시 만든다. 이 문서의 값은 그 결과를 옮긴 것이다.
- 2026-10-22 `dev`·`release`·`asan` 프리셋에서 각각 CTest 4개(`abi.load`, `env.inspect`, `docs.contract`, `integration.server_smoke`)가 통과했다. 실패·건너뜀 0이다. 이 결과는 ODBC 함수 구현 완료를 뜻하지 않는다.

## PC별 확인 규칙

**다른 PC 에 같은 도구가 설치되어 있다고 가정하지 않는다.** 처음 작업할 때와 도구를 바꾼 뒤에는 다음을 다시 실행하고, 확인일·호스트명·OS·도구 버전·절대 경로를 이 문서에 **추가**한다. 이전 PC 의 성공 기록을 새 PC 의 검증 근거로 쓰지 않는다.

```sh
unixodbc/scripts/setup-deps.sh
unixodbc/scripts/build-and-test.sh dev
```

기록에 남길 항목:

```text
확인일 / 호스트명 / OS·커널·비트 수
root·sudo 가능 여부 / 의존성 설치 방식(시스템 또는 .deps)
컴파일러 / CMake / unixODBC / Node.js 의 버전과 절대 경로
SQLWCHAR 크기 / unixODBC 라이브러리 경로
실제로 실행한 빌드·시험과 미시험 범위
```

## 목표 실행 환경

- 제품 기준: Linux x86_64 의 일반 배포판, unixODBC 2.3.7 이상. macOS 는 빌드·시험 가능하되 실제 앱 검증 범위는 UO-13 에서 정한다.
- 최소 OS 실제 시험은 별도 호스트가 필요하다. 이 문서의 Debian 13 결과를 최소 배포판 인수 결과로 쓰지 않는다.
- 32비트는 기본 지원 범위가 아니다. 하려면 multilib 환경을 갖춘 호스트에서 별도 행렬로 기록한다.

## 목표 앱

| 도구 | 용도 | 시험 단계 |
|---|---|---|
| `isql` | ANSI 경로·DSN·SQL 실행 확인 | UO-4 부터, UO-13 인수 |
| `iusql` | W API·한글·UTF-16 경로 | UO-2 부터, UO-13 인수 |
| 작은 C 시험 앱 | Manager 경유 Core 호출·descriptor·배열 | UO-1·4·7 |
| DBeaver/LibreOffice | 범용 앱 호환성(가능한 경우) | UO-13, 미확인은 명시 |
| Python `pyodbc` | 선택 확인 (unixODBC 경유) | UO-13 선택 |

범용 앱은 설치 버전·설정·화면 증거를 따로 남긴다. 드라이버 내부 시험 통과를 앱 호환성 증거로 대신하지 않는다.
