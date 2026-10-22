# 의존성과 배포 정책

## 1. 개발·빌드 의존성

| 항목 | 기준 | 확인 |
|---|---|---|
| OS | Linux(x86_64/aarch64), macOS. Windows 는 `winodbc` 담당 | Debian 13.7 x86_64 에서 확인 |
| 컴파일러 | C++17, GCC 11 이상 또는 Clang 14 이상 | GCC 14.2.0 |
| 빌드 | CMake 3.25 이상, CTest, GNU Make 또는 Ninja | CMake 4.4.4 |
| ODBC Manager | **unixODBC 2.3.7 이상**, 개발 헤더(`sql.h`, `sqlext.h`, `sqlucode.h`, `sqltypes.h`) | unixODBC 2.3.12 |
| 시험 실행기 | Node.js 22 이상 | Node.js 24.16.0 |
| 서버 | `../rdbms` 가 빌드되어 `dist/src/cli/main.js` 존재 | `npm run build` |

- unixODBC 2.3.x 의 기본 `SQLWCHAR` 는 2바이트이다. 헤더를 만든 빌드 설정과 Driver Manager 의 설정이 같아야 한다. 4바이트(`SQL_WCHART_CONVERT`/`wchar_t`) 빌드는 지원 대상이 아니다.
- unixODBC 2.3.12 의 `SQL_SPEC_STRING` 은 `03.52` 이고, ODBC 3.8 상수(`SQL_OV_ODBC3_80`)를 제공한다. 더 오래된 배포판은 이 상수가 없으면 구성 단계에서 실패한다.
- `isql` 과 W API 확인용 `iusql` 은 `unixodbc` 패키지에 있다. 실제 앱 시험(UO-13)에 쓴다.

## 2. 런타임 의존성

| 항목 | 정책 |
|---|---|
| C++ 표준 라이브러리 | 시스템 libstdc++/libc++. 정적 CRT 개념은 쓰지 않는다 |
| OpenSSL | TLS(UO-10)에 OpenSSL 3 계열. 배포 시 `libssl.so.3`/`libcrypto.so.3` 요구 |
| JSON | nlohmann/json 3.12.0 단일 헤더, MIT. `third_party/nlohmann/` 에 고정 (UO-3) |
| iconv | 초기에는 쓰지 않는다. ANSI 입력은 UTF-8 로만 받는다 |
| 스레드 | `pthread`. DBC 단위 직렬화와 취소 경로에 쓴다 |
| 드라이버 → Manager | 링크하지 않는다. 심볼로만 노출한다 |

- 드라이버는 Node.js·JVM·Python 프로세스를 중간에 두지 않는다. 순수 네이티브 .so 이다.
- 서드파티 코드는 라이선스·출처·버전·해시를 `third_party/` 의 문서에 남긴다. 라이선스가 호환되지 않는 코드는 넣지 않는다.
- 프로젝트 전체 라이선스는 저장소 루트의 [LICENSE](../../LICENSE)를 따른다.

## 3. 의존성 준비 방식

`scripts/setup-deps.sh` 가 두 경로를 지원한다.

1. **시스템 설치** : root 이거나 암호 없는 sudo 가 있으면 `apt-get install cmake unixodbc unixodbc-dev odbcinst libssl-dev`.
2. **프로젝트 내부 설치** : 권한이 없으면 `apt-get download` 로 받은 .deb 를 `.deps/sysroot` 에 풀고, CMake 는 pip 바퀴를 `.deps/python` 에 설치한다. 시스템 파일을 바꾸지 않는다.

`.deps/` 는 Git 에 넣지 않는다. 다른 PC 에서는 스크립트를 다시 실행한다. macOS 는 Homebrew 의 `cmake`, `unixodbc` 를 쓴다. (스크립트가 안내만 한다)

## 4. 배포·등록 정책

- 산출물: `libhwdbodbc.so.0`(+ 심볼릭 링크), 선택적 Setup 라이브러리, `odbcinst.ini` 예시, README.
- 설치 위치 기본안: `${CMAKE_INSTALL_LIBDIR}/odbc/`.
- 등록 예시:

```ini
[HelloWorldDB ODBC Driver]
Description=HelloWorldDB unixODBC Driver
Driver=/usr/lib/x86_64-linux-gnu/odbc/libhwdbodbc.so
```

- DSN 예시는 `Driver=HelloWorldDB ODBC Driver`, `Server=127.0.0.1`, `Port=7410` 을 쓴다. 비밀번호는 기본 저장하지 않는다.
- `SQLDrivers`/`SQLDataSources` 는 Manager 가 담당하므로 드라이버가 export 하지 않는다.
- 배포판 패키지(.deb/.rpm), 서명, `ldconfig`, `odbcinst -i` 자동화는 UO-12 에서 정한다.
- 32비트 빌드는 선택 사항이다. 하려면 `gcc-multilib`/`g++-multilib` 와 32비트 unixODBC 가 필요하며, UO-13 에서 별도 행렬로 기록한다. 기본 검증은 64비트이다.
