#pragma once

// SDK가 ABI의 유일한 정의이다. 원형과 ODBC 구조체를 다시 선언하지 않는다.
#include <windows.h>
#include <sql.h>
#include <sqlext.h>

#include <cstdint>
#include <type_traits>

static_assert(sizeof(SQLLEN) == sizeof(void*));
static_assert(sizeof(SQLULEN) == sizeof(void*));
static_assert(sizeof(SQLPOINTER) == sizeof(void*));
static_assert(sizeof(SQLINTEGER) == 4 && sizeof(SQLUINTEGER) == 4);
static_assert(sizeof(SQLSMALLINT) == 2 && sizeof(SQLWCHAR) == 2);
static_assert(sizeof(SQLBIGINT) == 8 && sizeof(SQLUBIGINT) == 8);
static_assert(std::is_signed_v<SQLLEN> && std::is_unsigned_v<SQLULEN>);
static_assert(sizeof(SQL_DATE_STRUCT) == 6);
static_assert(sizeof(SQL_TIME_STRUCT) == 6);
static_assert(sizeof(SQL_TIMESTAMP_STRUCT) == 16);
static_assert(sizeof(SQL_NUMERIC_STRUCT) == 19);
