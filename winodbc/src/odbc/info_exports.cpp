#include "hwdbodbc/connection.hpp"
#include <cstring>

using namespace hwdbodbc;
namespace {
template<class Character>
SQLRETURN info(SQLHDBC handle, SQLUSMALLINT field, SQLPOINTER output, SQLSMALLINT capacity, SQLSMALLINT* length) {
    return with_handle<Connection>(SQL_HANDLE_DBC, handle, true, [&](Connection& connection) -> SQLRETURN {
        const auto string = [&](const std::string& value) {
            const auto rc = output_text(value, static_cast<Character*>(output), capacity, length, LengthUnit::bytes);
            if (rc == SQL_SUCCESS_WITH_INFO) connection.diagnostic.append("01004", "Information output was truncated.");
            return rc;
        };
        const auto number = [&](auto value) -> SQLRETURN {
            if (!output) throw DriverError("HY009", "Invalid use of null pointer.");
            std::memcpy(output, &value, sizeof(value));
            if (length) *length = static_cast<SQLSMALLINT>(sizeof(value));
            return SQL_SUCCESS;
        };
        switch (field) {
        case SQL_GETDATA_EXTENSIONS: return number(static_cast<SQLUINTEGER>(0));
        case SQL_MAX_CONCURRENT_ACTIVITIES: return number(static_cast<SQLUSMALLINT>(16));
        case SQL_MAX_COLUMN_NAME_LEN: case SQL_MAX_CURSOR_NAME_LEN: case SQL_MAX_TABLE_NAME_LEN:
        case SQL_MAX_SCHEMA_NAME_LEN: case SQL_MAX_IDENTIFIER_LEN: return number(static_cast<SQLUSMALLINT>(128));
        case SQL_CURSOR_COMMIT_BEHAVIOR: case SQL_CURSOR_ROLLBACK_BEHAVIOR: return number(static_cast<SQLUSMALLINT>(SQL_CB_PRESERVE));
        case SQL_SCROLL_OPTIONS: return number(static_cast<SQLUINTEGER>(SQL_SO_FORWARD_ONLY));
        case SQL_SCROLL_CONCURRENCY: return number(static_cast<SQLUINTEGER>(SQL_SCCO_READ_ONLY));
        case SQL_DRIVER_ODBC_VER: return string("03.00");
        case SQL_DRIVER_NAME: return string("hwdbodbc.dll");
        case SQL_DRIVER_VER: return string("00.01.0000");
        case SQL_DBMS_NAME: return string("HelloWorldDB");
        case SQL_DBMS_VER: return string("00.01.0000");
        case SQL_SERVER_NAME: return string(connection.server_name);
        case SQL_DATABASE_NAME: return string("");
        case SQL_DATA_SOURCE_NAME: return string("");
        case SQL_USER_NAME: return string(connection.session ? string_field(connection.session->information, "user") : "");
        case SQL_IDENTIFIER_QUOTE_CHAR: return string("\"");
        case SQL_SEARCH_PATTERN_ESCAPE: return string("\\");
        case SQL_DATA_SOURCE_READ_ONLY: return string("N");
        default: throw DriverError("HY096", "Information type is not implemented yet.");
        }
    });
}
}
extern "C" SQLRETURN SQL_API SQLGetInfo(SQLHDBC handle, SQLUSMALLINT field, SQLPOINTER output, SQLSMALLINT capacity, SQLSMALLINT* length) {
    return info<SQLCHAR>(handle, field, output, capacity, length);
}
extern "C" SQLRETURN SQL_API SQLGetInfoW(SQLHDBC handle, SQLUSMALLINT field, SQLPOINTER output, SQLSMALLINT capacity, SQLSMALLINT* length) {
    return info<SQLWCHAR>(handle, field, output, capacity, length);
}
extern "C" SQLRETURN SQL_API SQLGetFunctions(SQLHDBC handle, SQLUSMALLINT function, SQLUSMALLINT* supported) {
    return with_handle<Connection>(SQL_HANDLE_DBC, handle, true, [&](Connection&) -> SQLRETURN {
        if (!supported) throw DriverError("HY009", "Invalid use of null pointer.");
        // 함수 지원과 개별 속성 지원을 구분한다. 미지원 속성은 해당 API에서 오류를 낸다.
        const SQLUSMALLINT functions[] = { SQL_API_SQLALLOCHANDLE, SQL_API_SQLFREEHANDLE,
            SQL_API_SQLSETENVATTR, SQL_API_SQLGETENVATTR, SQL_API_SQLGETDIAGREC, SQL_API_SQLGETDIAGFIELD,
            SQL_API_SQLCONNECT, SQL_API_SQLDRIVERCONNECT, SQL_API_SQLDISCONNECT, SQL_API_SQLGETFUNCTIONS,
            SQL_API_SQLGETCONNECTATTR, SQL_API_SQLSETCONNECTATTR, SQL_API_SQLGETSTMTATTR, SQL_API_SQLGETINFO,
            SQL_API_SQLEXECDIRECT, SQL_API_SQLNUMRESULTCOLS, SQL_API_SQLROWCOUNT, SQL_API_SQLDESCRIBECOL,
            SQL_API_SQLCOLATTRIBUTE, SQL_API_SQLBINDCOL, SQL_API_SQLFETCH, SQL_API_SQLFETCHSCROLL, SQL_API_SQLGETDATA,
            SQL_API_SQLCLOSECURSOR, SQL_API_SQLFREESTMT, SQL_API_SQLMORERESULTS, SQL_API_SQLGETCURSORNAME,
            SQL_API_SQLSETCURSORNAME, SQL_API_SQLSETSTMTATTR, SQL_API_SQLPREPARE, SQL_API_SQLEXECUTE,
            SQL_API_SQLNUMPARAMS, SQL_API_SQLDESCRIBEPARAM, SQL_API_SQLBINDPARAMETER, SQL_API_SQLNATIVESQL };
        const auto found = std::find(std::begin(functions), std::end(functions), function) != std::end(functions);
        if (function == SQL_API_ALL_FUNCTIONS) {
            std::fill_n(supported, 100, static_cast<SQLUSMALLINT>(SQL_FALSE));
            for (const auto item : functions) if (item < 100) supported[item] = SQL_TRUE;
        } else if (function == SQL_API_ODBC3_ALL_FUNCTIONS) {
            std::fill_n(supported, SQL_API_ODBC3_ALL_FUNCTIONS_SIZE, static_cast<SQLUSMALLINT>(0));
            for (const auto item : functions) supported[item >> 4] |= static_cast<SQLUSMALLINT>(1U << (item & 15));
        } else *supported = found ? SQL_TRUE : SQL_FALSE;
        return SQL_SUCCESS;
    });
}
