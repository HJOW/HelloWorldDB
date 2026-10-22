cmake_minimum_required(VERSION 3.25)
project(HelloWorldDBUnixODBC VERSION 0.1.0 LANGUAGES CXX)

# Unix ODBC 드라이버는 Linux/macOS 의 unixODBC Driver Manager 를 대상으로 한다.
# Windows 는 winodbc 프로젝트가 담당한다.
if(WIN32)
    message(FATAL_ERROR "unixodbc 는 Unix 계열 전용이다. Windows 는 winodbc 를 사용한다.")
endif()
if(NOT CMAKE_SYSTEM_NAME MATCHES "Linux|Darwin")
    message(FATAL_ERROR "지원 대상은 Linux 와 macOS 이다. (현재: ${CMAKE_SYSTEM_NAME})")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(HWDB_WERROR "경고를 오류로 처리한다." ON)

# unixODBC 헤더와 Driver Manager 라이브러리. 드라이버 .so 자체는 Manager 에 링크하지 않는다.
# (시험용 실행 파일만 ODBC::ODBC 를 링크한다)
find_package(ODBC REQUIRED)
# Debian/Ubuntu 는 unixodbc.h 를 <prefix>/include/<multiarch>/ 에 둔다.
# pkg-config 의 Cflags 에 이 경로가 빠져 있을 수 있으므로 직접 찾아 더한다.
find_path(HWDB_UNIXODBC_ARCH_INCLUDE_DIR unixodbc.h
    HINTS ${ODBC_INCLUDE_DIRS}
    PATH_SUFFIXES ${CMAKE_LIBRARY_ARCHITECTURE} ${CMAKE_LIBRARY_ARCHITECTURE}/unixODBC)
if(HWDB_UNIXODBC_ARCH_INCLUDE_DIR)
    list(APPEND ODBC_INCLUDE_DIRS "${HWDB_UNIXODBC_ARCH_INCLUDE_DIR}")
endif()
message(STATUS "unixODBC include: ${ODBC_INCLUDE_DIRS}")
message(STATUS "unixODBC library: ${ODBC_LIBRARIES}")

add_library(hwdb_build_options INTERFACE)
target_include_directories(hwdb_build_options INTERFACE
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
    ${ODBC_INCLUDE_DIRS})
target_compile_definitions(hwdb_build_options INTERFACE ODBCVER=0x0380)
target_compile_options(hwdb_build_options INTERFACE
    -Wall -Wextra -Wpedantic -Wshadow -Wnon-virtual-dtor
    -fvisibility=hidden -fvisibility-inlines-hidden)
if(HWDB_WERROR)
    target_compile_options(hwdb_build_options INTERFACE -Werror)
endif()

# UO-1 의 빌드 기반이다. UO-2 부터 SQL* 진입점을 이 라이브러리에 더한다.
# 지금은 ABI·가시성·SONAME·dlopen 경로만 확정하기 위한 골격 심볼 하나를 내보낸다.
add_library(hwdbodbc SHARED src/odbc/scaffold.cpp)
target_link_libraries(hwdbodbc PRIVATE hwdb_build_options)
set_target_properties(hwdbodbc PROPERTIES
    OUTPUT_NAME hwdbodbc
    VERSION ${PROJECT_VERSION}
    SOVERSION 0
    CXX_VISIBILITY_PRESET hidden
    VISIBILITY_INLINES_HIDDEN YES)
if(APPLE)
    set_target_properties(hwdbodbc PROPERTIES LINK_FLAGS
        "-Wl,-exported_symbols_list,${CMAKE_CURRENT_SOURCE_DIR}/src/odbc/exports.macos.txt")
else()
    target_link_options(hwdbodbc PRIVATE
        "-Wl,--version-script=${CMAKE_CURRENT_SOURCE_DIR}/src/odbc/exports.map")
endif()

include(GNUInstallDirs)
install(TARGETS hwdbodbc LIBRARY DESTINATION "${CMAKE_INSTALL_LIBDIR}/odbc")

include(CTest)
if(BUILD_TESTING)
    find_program(NODE_EXECUTABLE node REQUIRED)

    add_executable(hwdb_odbc_env_probe tests/unit/env_probe.cpp)
    target_link_libraries(hwdb_odbc_env_probe PRIVATE hwdb_build_options)

    add_executable(hwdb_odbc_abi_probe tests/unit/abi_probe.cpp)
    target_link_libraries(hwdb_odbc_abi_probe PRIVATE hwdb_build_options ${CMAKE_DL_LIBS})

    add_test(NAME abi.load COMMAND hwdb_odbc_abi_probe "$<TARGET_FILE:hwdbodbc>")
    set_tests_properties(abi.load PROPERTIES TIMEOUT 20)

    # 현재 호스트·도구·unixODBC·컴파일 ABI 를 build/uo0/environment.json 에 기록한다.
    add_test(NAME env.inspect
        COMMAND "${NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/scripts/inspect-environment.mjs"
            --output "${CMAKE_BINARY_DIR}/uo0/environment.json"
            --abi-probe "$<TARGET_FILE:hwdb_odbc_env_probe>")
    set_tests_properties(env.inspect PROPERTIES TIMEOUT 120 FIXTURES_SETUP hwdb_env)

    add_test(NAME docs.contract
        COMMAND "${NODE_EXECUTABLE}" --test "${CMAKE_CURRENT_SOURCE_DIR}/tests/uo0.test.mjs")
    set_tests_properties(docs.contract PROPERTIES
        TIMEOUT 60
        FIXTURES_REQUIRED hwdb_env
        ENVIRONMENT "HWDB_ODBC_ENVIRONMENT=${CMAKE_BINARY_DIR}/uo0/environment.json")

    add_test(NAME integration.server_smoke
        COMMAND "${NODE_EXECUTABLE}" --test "${CMAKE_CURRENT_SOURCE_DIR}/tests/integration/server-smoke.test.mjs")
    set_tests_properties(integration.server_smoke PROPERTIES
        TIMEOUT 180
        ENVIRONMENT "HWDB_TEST_RUNTIME=${NODE_EXECUTABLE}")
endif()
