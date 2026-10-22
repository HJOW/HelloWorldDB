# HelloWorldDB Unix ODBC

HelloWorldDB 에 접속하는 **Unix ODBC(unixODBC) 드라이버** 프로젝트이다. Linux 와 macOS 의 unixODBC Driver Manager 를 쓰는 C/C++ 프로그램과 ODBC 도구가 대상이다.

> **현재 상태 : UO-0(환경·계약) 완료, UO-1 빌드 골격.** 아직 ODBC 함수(`SQL*`)를 구현하지 않았다. 생성되는 `libhwdbodbc.so` 는 빌드·가시성·dlopen 경로를 확인하기 위한 골격이며 `isql` 로 접속할 수 없다.
> 남은 단계와 순서는 [PROGRESS.md](PROGRESS.md)에 있다.

사양의 최상위 기준은 [AGENTS.md](../AGENTS.md), 통신은 [서버 프로토콜](../rdbms/docs/protocol.md), 타입은 [서버 타입 정책](../rdbms/docs/data-types.md)을 따른다.

## 빠른 시작

```sh
# 1) 의존성 준비 (root/sudo 가 없으면 프로젝트 안 .deps/ 에 준비한다)
unixodbc/scripts/setup-deps.sh

# 2) 빌드와 시험 (dev, release, asan)
unixodbc/scripts/build-and-test.sh dev
```

`rdbms` 통합 시험은 `../rdbms` 가 빌드되어 있어야 한다.

```sh
(cd rdbms && npm install && npm run build)
```

이미 시스템에 CMake 와 `unixodbc-dev` 가 있으면 `.deps` 없이도 빌드된다.

```sh
cd unixodbc
cmake --preset dev
cmake --build --preset dev
ctest --preset dev
```

산출물은 `build/dev/libhwdbodbc.so` 이다.

## 개발 문서

- [개발 계획과 진행 상황](PROGRESS.md)
- [개발 환경과 목표 앱](docs/environment.md)
- [API·속성·길이 계약](docs/api-support.md)
- [타입·버퍼 계약](docs/type-mapping.md)
- [서버 기능·진단·수명 계약](docs/server-dependencies.md)
- [설계 기본안](docs/design.md)
- [의존성과 배포 정책](docs/dependencies.md)
- [검증 기록과 시험 ID](docs/verification.md)

## 현재 시험

| CTest | 확인하는 것 |
|---|---|
| `abi.load` | .so 를 직접 dlopen, 빌드 식별자, 숨김 심볼 |
| `env.inspect` | 이 호스트의 도구·unixODBC·ABI 기록 생성 |
| `docs.contract` | API 표·타입 대응·서버 기능·문서 링크의 계약 검사 |
| `integration.server_smoke` | 실제 `rdbms` 데몬과 TCP hello/close |

드라이버 구현은 UO-1 의 SQL* 진입점부터 시작한다. 작업 순서와 완료 기준은 [PROGRESS.md](PROGRESS.md) 5절을 따른다.

## 접속 문자열(목표)

```text
DRIVER={HelloWorldDB ODBC Driver};Server=127.0.0.1;Port=7410;UID=SYSTEM;PWD=HelloWorldDB;Tablespace=SYSTEM
```

비밀번호는 DSN 에 기본 저장하지 않는다. TLS·UDP 속성은 UO-10·UO-11 에서 확정한다.
