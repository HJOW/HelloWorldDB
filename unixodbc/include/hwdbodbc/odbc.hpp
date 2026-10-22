#pragma once

/**
 * ODBC 헤더를 포함하고 이 프로젝트의 전제를 컴파일 시점에 검사한다.
 *
 * - unixODBC 여야 한다. iODBC 등 다른 Manager 는 지원하지 않는다.
 * - ODBC 3.8 상수가 있어야 한다. (unixODBC 2.3 이상)
 * - SQLWCHAR 는 2바이트 UTF-16 이어야 한다. 4바이트(wchar_t) 빌드는 지원 대상이 아니다.
 */
#include <sql.h>
#include <sqlext.h>
#include <sqlucode.h>

#if !defined(SQL_ATTR_UNIXODBC_VERSION)
#error "unixODBC 헤더가 필요하다. iODBC 등 다른 Driver Manager 는 지원하지 않는다."
#endif

#if !defined(SQL_OV_ODBC3_80)
#error "ODBC 3.8 상수(SQL_OV_ODBC3_80)가 없다. unixODBC 2.3 이상이 필요하다."
#endif

#if defined(SQL_WCHART_CONVERT)
#error "SQL_WCHART_CONVERT(wchar_t) 빌드는 지원하지 않는다. 2바이트 SQLWCHAR unixODBC 를 쓰십시오."
#endif

static_assert(sizeof(SQLWCHAR) == 2, "SQLWCHAR 가 2바이트인 unixODBC 빌드만 지원한다.");
