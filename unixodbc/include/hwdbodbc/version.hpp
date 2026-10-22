#pragma once

/** HelloWorldDB unixODBC 드라이버의 빌드 식별자이다. UO-1 부터 배포 정보에도 쓴다. */
#define HWDB_ODBC_VERSION_MAJOR 0
#define HWDB_ODBC_VERSION_MINOR 1
#define HWDB_ODBC_VERSION_PATCH 0
#define HWDB_ODBC_VERSION_STRING "0.1.0"

/**
 * 지금은 UO-0/UO-1 의 빌드 기반만 있으므로 골격임을 문자열에 밝힌다.
 * SQL* 진입점을 붙이는 UO-2 에서 "(scaffold)" 를 뗀다.
 */
#define HWDB_ODBC_BUILD_ID "HelloWorldDB unixODBC driver " HWDB_ODBC_VERSION_STRING " (scaffold)"

/**
 * unixODBC Manager 가 dlsym 으로 찾을 수 있게 기본 가시성을 되돌린다.
 * 빌드 기본값이 hidden 이므로 export 할 함수마다 이 표시가 필요하다.
 */
#if defined(_WIN32)
#define HWDB_ODBC_EXPORT __declspec(dllexport)
#else
#define HWDB_ODBC_EXPORT __attribute__((visibility("default")))
#endif
