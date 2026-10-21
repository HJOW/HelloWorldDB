cmake_minimum_required(VERSION 3.25)
project(HelloWorldDBODBC VERSION 0.1.0 LANGUAGES CXX)

if(NOT WIN32 OR NOT MSVC)
    message(FATAL_ERROR "Windows와 MSVC가 필요합니다.")
endif()
if(NOT CMAKE_GENERATOR_PLATFORM MATCHES "^(Win32|x64)$")
    message(FATAL_ERROR "x86 또는 x64 프리셋을 사용하십시오.")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib")

add_library(hwdb_build_options INTERFACE)
target_include_directories(hwdb_build_options INTERFACE "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_compile_definitions(hwdb_build_options INTERFACE
    WIN32_LEAN_AND_MEAN NOMINMAX ODBCVER=0x0380)
target_compile_options(hwdb_build_options INTERFACE
    /W4 /WX /utf-8 /permissive- /EHsc /Zc:__cplusplus)

if(CMAKE_SIZEOF_VOID_P EQUAL 8)
    set(HWDB_ARCH x64)
else()
    set(HWDB_ARCH x86)
endif()

add_library(hwdbodbc SHARED src/odbc/exports.cpp src/odbc/dllmain.cpp
    "src/odbc/exports_${HWDB_ARCH}.def")
target_link_libraries(hwdbodbc PRIVATE hwdb_build_options)

include(CTest)
if(BUILD_TESTING)
    add_executable(hwdb_abi_probe tests/abi/abi_probe.cpp)
    target_link_libraries(hwdb_abi_probe PRIVATE hwdb_build_options)
    add_executable(hwdb_boundary_test tests/unit/entry_point_test.cpp)
    target_link_libraries(hwdb_boundary_test PRIVATE hwdb_build_options)
    # Manager용 EXE는 드라이버 타깃이나 import lib에 링크하지 않는다.
    add_executable(hwdb_dm_probe tests/driver_manager/manager_probe.cpp)
    target_link_libraries(hwdb_dm_probe PRIVATE hwdb_build_options odbc32)

    foreach(scenario exports lifecycle diagnostics)
        add_test(NAME "abi.${scenario}"
            COMMAND hwdb_abi_probe "${scenario}" "$<TARGET_FILE:hwdbodbc>")
    endforeach()
    add_test(NAME abi.exception_boundary COMMAND hwdb_boundary_test)
    add_test(NAME manager.environment COMMAND hwdb_dm_probe)
    set_tests_properties(abi.exports abi.lifecycle abi.diagnostics
        abi.exception_boundary manager.environment PROPERTIES TIMEOUT 20)
endif()
