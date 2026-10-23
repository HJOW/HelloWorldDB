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

add_library(hwdb_core STATIC src/odbc/handles.cpp src/odbc/connection.cpp src/odbc/statement.cpp src/types/text.cpp
    src/odbc/statement_attributes.cpp src/odbc/descriptor.cpp src/odbc/rowset.cpp src/odbc/data_execution.cpp src/odbc/transaction.cpp src/odbc/sql_text.cpp src/types/parameters.cpp src/types/metadata.cpp src/types/conversion.cpp
    src/odbc/catalog.cpp src/odbc/catalog_impl.cpp
    src/protocol/json.cpp src/protocol/scram.cpp src/protocol/session.cpp src/transport/tcp.cpp)
target_include_directories(hwdb_core SYSTEM PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/third_party")
target_link_libraries(hwdb_core PUBLIC hwdb_build_options ws2_32 bcrypt crypt32 normaliz advapi32)

add_library(hwdbodbc SHARED src/odbc/exports.cpp src/odbc/connect_exports.cpp src/odbc/info_exports.cpp
    src/odbc/statement_exports.cpp src/odbc/prepare_exports.cpp src/odbc/descriptor_exports.cpp src/odbc/catalog_exports.cpp src/odbc/dllmain.cpp
    "src/odbc/exports_${HWDB_ARCH}.def")
target_link_libraries(hwdbodbc PRIVATE hwdb_core)

include(CTest)
if(BUILD_TESTING)
    add_executable(hwdb_abi_probe tests/abi/abi_probe.cpp)
    target_link_libraries(hwdb_abi_probe PRIVATE hwdb_build_options)
    add_executable(hwdb_boundary_test tests/unit/entry_point_test.cpp)
    target_link_libraries(hwdb_boundary_test PRIVATE hwdb_build_options)
    add_executable(hwdb_handles_test tests/unit/handles_test.cpp src/odbc/exports.cpp src/odbc/connect_exports.cpp)
    target_link_libraries(hwdb_handles_test PRIVATE hwdb_core)
    add_executable(hwdb_text_test tests/unit/text_test.cpp)
    target_link_libraries(hwdb_text_test PRIVATE hwdb_core)
    add_executable(hwdb_protocol_probe tests/integration/protocol_probe.cpp)
    target_link_libraries(hwdb_protocol_probe PRIVATE hwdb_core)
    add_executable(hwdb_reset_probe tests/integration/reset_probe.cpp)
    target_link_libraries(hwdb_reset_probe PRIVATE hwdb_build_options)
    add_executable(hwdb_protocol_test tests/unit/protocol_test.cpp)
    target_link_libraries(hwdb_protocol_test PRIVATE hwdb_core)
    add_executable(hwdb_conversion_test tests/unit/conversion_test.cpp)
    target_link_libraries(hwdb_conversion_test PRIVATE hwdb_core)
    add_executable(hwdb_sql_text_test tests/unit/sql_text_test.cpp)
    target_link_libraries(hwdb_sql_text_test PRIVATE hwdb_core)
    add_executable(hwdb_parameters_test tests/unit/parameters_test.cpp)
    target_link_libraries(hwdb_parameters_test PRIVATE hwdb_core)
    add_executable(hwdb_data_execution_test tests/unit/data_execution_test.cpp)
    target_link_libraries(hwdb_data_execution_test PRIVATE hwdb_core)
    add_executable(hwdb_catalog_test tests/unit/catalog_test.cpp)
    target_link_libraries(hwdb_catalog_test PRIVATE hwdb_core)
    add_executable(hwdb_descriptor_test tests/unit/descriptor_test.cpp src/odbc/exports.cpp src/odbc/connect_exports.cpp src/odbc/descriptor_exports.cpp)
    target_link_libraries(hwdb_descriptor_test PRIVATE hwdb_core)
    add_executable(hwdb_connection_test tests/unit/connection_test.cpp src/odbc/connect_exports.cpp src/odbc/exports.cpp)
    target_link_libraries(hwdb_connection_test PRIVATE hwdb_core)
    # Manager용 EXE는 드라이버 타깃이나 import lib에 링크하지 않는다.
    add_executable(hwdb_dm_probe tests/driver_manager/manager_probe.cpp)
    target_link_libraries(hwdb_dm_probe PRIVATE hwdb_build_options odbc32)
    add_executable(hwdb_dm_connection tests/driver_manager/connection_probe.cpp tests/driver_manager/query_cases.cpp tests/driver_manager/prepare_cases.cpp tests/driver_manager/descriptor_cases.cpp tests/driver_manager/data_cases.cpp tests/driver_manager/transaction_cases.cpp tests/driver_manager/catalog_cases.cpp)
    target_link_libraries(hwdb_dm_connection PRIVATE hwdb_build_options odbc32 ole32 advapi32 ws2_32)

    foreach(scenario exports lifecycle diagnostics)
        add_test(NAME "abi.${scenario}"
            COMMAND hwdb_abi_probe "${scenario}" "$<TARGET_FILE:hwdbodbc>")
    endforeach()
    add_test(NAME abi.exception_boundary COMMAND hwdb_boundary_test)
    add_test(NAME handles.lifecycle_diagnostics_concurrency COMMAND hwdb_handles_test)
    add_test(NAME text.unicode_lengths_acp COMMAND hwdb_text_test)
    add_test(NAME protocol.strict_json COMMAND hwdb_protocol_test)
    add_test(NAME types.exact_numeric_unicode_temporal COMMAND hwdb_conversion_test)
    add_test(NAME sql.odbc_escapes_parameters COMMAND hwdb_sql_text_test)
    add_test(NAME types.input_parameters COMMAND hwdb_parameters_test)
    add_test(NAME parameters.streaming_limits_sequence COMMAND hwdb_data_execution_test)
    add_test(NAME catalog.helpers_types COMMAND hwdb_catalog_test)
    add_test(NAME descriptors.fields_sharing_lifetime COMMAND hwdb_descriptor_test)
    add_test(NAME connection.options_attributes COMMAND hwdb_connection_test)
    find_program(HWDB_NODE_EXECUTABLE node REQUIRED)
    add_test(NAME integration.protocol_manager
        COMMAND "${CMAKE_COMMAND}" -E env
            "HWDB_PROTOCOL_PROBE=$<TARGET_FILE:hwdb_protocol_probe>"
            "HWDB_DM_CONNECTION=$<TARGET_FILE:hwdb_dm_connection>"
            "HWDB_ODBC_DLL=$<TARGET_FILE:hwdbodbc>"
            "HWDB_RESET_PROBE=$<TARGET_FILE:hwdb_reset_probe>"
            "${HWDB_NODE_EXECUTABLE}" --test --test-reporter=tap "${CMAKE_CURRENT_SOURCE_DIR}/tests/integration/protocol.test.mjs")
    set_tests_properties(integration.protocol_manager PROPERTIES TIMEOUT 180)
    add_test(NAME manager.environment COMMAND hwdb_dm_probe)
    set_tests_properties(abi.exports abi.lifecycle abi.diagnostics
        abi.exception_boundary manager.environment handles.lifecycle_diagnostics_concurrency
        text.unicode_lengths_acp protocol.strict_json connection.options_attributes types.exact_numeric_unicode_temporal
        sql.odbc_escapes_parameters types.input_parameters descriptors.fields_sharing_lifetime catalog.helpers_types PROPERTIES TIMEOUT 20)
endif()
