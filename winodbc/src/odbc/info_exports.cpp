#include "hwdbodbc/connection.hpp"
#include <algorithm>
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
        case SQL_NEED_LONG_DATA_LEN: return string("Y");
        case SQL_TXN_CAPABLE: return number(static_cast<SQLUSMALLINT>(SQL_TC_DDL_COMMIT));
        case SQL_DEFAULT_TXN_ISOLATION: case SQL_TXN_ISOLATION_OPTION: return number(static_cast<SQLUINTEGER>(SQL_TXN_READ_COMMITTED));
        case SQL_MULTIPLE_ACTIVE_TXN: return string("Y");
        case SQL_PARAM_ARRAY_ROW_COUNTS: return number(static_cast<SQLUINTEGER>(SQL_PARC_NO_BATCH));
        case SQL_PARAM_ARRAY_SELECTS: return number(static_cast<SQLUINTEGER>(SQL_PAS_NO_SELECT));
        case SQL_MAX_CONCURRENT_ACTIVITIES: return number(static_cast<SQLUSMALLINT>(16));
        case SQL_MAX_COLUMN_NAME_LEN: case SQL_MAX_CURSOR_NAME_LEN: case SQL_MAX_TABLE_NAME_LEN:
        case SQL_MAX_SCHEMA_NAME_LEN: case SQL_MAX_IDENTIFIER_LEN: return number(static_cast<SQLUSMALLINT>(128));
        case SQL_MAX_CATALOG_NAME_LEN: return number(static_cast<SQLUSMALLINT>(0));
        case SQL_MAX_PROCEDURE_NAME_LEN: return number(static_cast<SQLUSMALLINT>(0));
        case SQL_MAX_COLUMNS_IN_TABLE: return number(static_cast<SQLUSMALLINT>(1000));
        case SQL_MAX_COLUMNS_IN_SELECT: return number(static_cast<SQLUSMALLINT>(1000));
        case SQL_MAX_COLUMNS_IN_ORDER_BY: return number(static_cast<SQLUSMALLINT>(1000));
        case SQL_MAX_COLUMNS_IN_GROUP_BY: return number(static_cast<SQLUSMALLINT>(1000));
        case SQL_MAX_COLUMNS_IN_INDEX: return number(static_cast<SQLUSMALLINT>(16));
        case SQL_MAX_TABLES_IN_SELECT: return number(static_cast<SQLUSMALLINT>(0));
        case SQL_MAX_ROW_SIZE: return number(static_cast<SQLUINTEGER>(0));
        case SQL_MAX_STATEMENT_LEN: return number(static_cast<SQLUINTEGER>(0));
        case SQL_MAX_CHAR_LITERAL_LEN: return number(static_cast<SQLUINTEGER>(0));
        case SQL_MAX_BINARY_LITERAL_LEN: return number(static_cast<SQLUINTEGER>(0));
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
        case SQL_ACCESSIBLE_PROCEDURES: return string("N");
        case SQL_ACCESSIBLE_TABLES: return string("Y");
        case SQL_CATALOG_NAME: return string("N");
        case SQL_CATALOG_NAME_SEPARATOR: return string("");
        case SQL_CATALOG_TERM: return string("");
        case SQL_CATALOG_LOCATION: return number(static_cast<SQLUSMALLINT>(0));
        case SQL_CATALOG_USAGE: return number(static_cast<SQLUINTEGER>(0));
        case SQL_SCHEMA_TERM: return string("tablespace");
        case SQL_SCHEMA_USAGE: return number(static_cast<SQLUINTEGER>(SQL_SU_DML_STATEMENTS | SQL_SU_TABLE_DEFINITION | SQL_SU_INDEX_DEFINITION | SQL_SU_PRIVILEGE_DEFINITION));
        case SQL_TABLE_TERM: return string("table");
        case SQL_PROCEDURE_TERM: return string("");
        case SQL_PROCEDURES: return string("N");
        case SQL_COLUMN_ALIAS: return string("Y");
        case SQL_EXPRESSIONS_IN_ORDERBY: return string("Y");
        case SQL_LIKE_ESCAPE_CLAUSE: return string("Y");
        case SQL_MULT_RESULT_SETS: return string("N");
        case SQL_OUTER_JOINS: return string("Y");
        case SQL_ORDER_BY_COLUMNS_IN_SELECT: return string("N");
        case SQL_ROW_UPDATES: return string("N");
        case SQL_POSITIONED_STATEMENTS: return number(static_cast<SQLUINTEGER>(0));
        case SQL_NON_NULLABLE_COLUMNS: return number(static_cast<SQLUSMALLINT>(SQL_NNC_NON_NULL));
        case SQL_NULL_COLLATION: return number(static_cast<SQLUSMALLINT>(SQL_NC_END));
        case SQL_CONCAT_NULL_BEHAVIOR: return number(static_cast<SQLUSMALLINT>(SQL_CB_NULL));
        case SQL_CORRELATION_NAME: return number(static_cast<SQLUSMALLINT>(SQL_CN_ANY));
        case SQL_GROUP_BY: return number(static_cast<SQLUSMALLINT>(SQL_GB_GROUP_BY_CONTAINS_SELECT));
        case SQL_IDENTIFIER_CASE: return number(static_cast<SQLUSMALLINT>(SQL_IC_UPPER));
        case SQL_QUOTED_IDENTIFIER_CASE: return number(static_cast<SQLUSMALLINT>(SQL_IC_SENSITIVE));
        case SQL_AGGREGATE_FUNCTIONS: return number(static_cast<SQLUINTEGER>(SQL_AF_AVG | SQL_AF_COUNT | SQL_AF_MAX | SQL_AF_MIN | SQL_AF_SUM | SQL_AF_DISTINCT));
        case SQL_ALTER_TABLE: {
            SQLUINTEGER value = SQL_AT_ADD_COLUMN_SINGLE | SQL_AT_DROP_COLUMN_CASCADE | SQL_AT_DROP_COLUMN_RESTRICT |
                SQL_AT_ADD_TABLE_CONSTRAINT | SQL_AT_DROP_TABLE_CONSTRAINT_CASCADE | SQL_AT_DROP_TABLE_CONSTRAINT_RESTRICT;
            return number(value);
        }
        case SQL_OJ_CAPABILITIES: {
            SQLUINTEGER value = SQL_OJ_LEFT | SQL_OJ_RIGHT | SQL_OJ_FULL | SQL_OJ_NESTED | SQL_OJ_NOT_ORDERED | SQL_OJ_INNER | SQL_OJ_ALL_COMPARISON_OPS;
            return number(value);
        }
        case SQL_SUBQUERIES: return number(static_cast<SQLUINTEGER>(SQL_SQ_COMPARISON | SQL_SQ_EXISTS | SQL_SQ_IN | SQL_SQ_QUANTIFIED | SQL_SQ_CORRELATED_SUBQUERIES));
        case SQL_UNION: return number(static_cast<SQLUINTEGER>(SQL_U_UNION | SQL_U_UNION_ALL));
        case SQL_CONVERT_FUNCTIONS: return number(static_cast<SQLUSMALLINT>(SQL_FN_CVT_CAST));
        case SQL_NUMERIC_FUNCTIONS: return number(static_cast<SQLUINTEGER>(SQL_FN_NUM_ABS | SQL_FN_NUM_CEILING | SQL_FN_NUM_FLOOR | SQL_FN_NUM_MOD | SQL_FN_NUM_POWER | SQL_FN_NUM_ROUND | SQL_FN_NUM_SQRT));
        case SQL_STRING_FUNCTIONS: return number(static_cast<SQLUINTEGER>(SQL_FN_STR_CONCAT | SQL_FN_STR_LENGTH | SQL_FN_STR_SUBSTRING | SQL_FN_STR_UCASE | SQL_FN_STR_LCASE | SQL_FN_STR_LTRIM | SQL_FN_STR_RTRIM | SQL_FN_STR_REPLACE | SQL_FN_STR_POSITION | SQL_FN_STR_CHAR_LENGTH | SQL_FN_STR_OCTET_LENGTH));
        case SQL_SYSTEM_FUNCTIONS: return number(static_cast<SQLUINTEGER>(0));
        case SQL_TIMEDATE_FUNCTIONS: return number(static_cast<SQLUINTEGER>(SQL_FN_TD_CURRENT_DATE | SQL_FN_TD_CURRENT_TIME | SQL_FN_TD_CURRENT_TIMESTAMP | SQL_FN_TD_EXTRACT));
        case SQL_TIMEDATE_ADD_INTERVALS: return number(static_cast<SQLUINTEGER>(0));
        case SQL_TIMEDATE_DIFF_INTERVALS: return number(static_cast<SQLUINTEGER>(0));
        case SQL_DATETIME_LITERALS: return number(static_cast<SQLUINTEGER>(SQL_DL_SQL92_DATE | SQL_DL_SQL92_TIME | SQL_DL_SQL92_TIMESTAMP | SQL_DL_SQL92_INTERVAL_YEAR | SQL_DL_SQL92_INTERVAL_MONTH | SQL_DL_SQL92_INTERVAL_DAY | SQL_DL_SQL92_INTERVAL_HOUR | SQL_DL_SQL92_INTERVAL_MINUTE | SQL_DL_SQL92_INTERVAL_SECOND | SQL_DL_SQL92_INTERVAL_YEAR_TO_MONTH | SQL_DL_SQL92_INTERVAL_DAY_TO_HOUR | SQL_DL_SQL92_INTERVAL_DAY_TO_MINUTE | SQL_DL_SQL92_INTERVAL_DAY_TO_SECOND | SQL_DL_SQL92_INTERVAL_HOUR_TO_MINUTE | SQL_DL_SQL92_INTERVAL_HOUR_TO_SECOND | SQL_DL_SQL92_INTERVAL_MINUTE_TO_SECOND));
        case SQL_ODBC_INTERFACE_CONFORMANCE: return number(static_cast<SQLUINTEGER>(SQL_OIC_CORE));
        case SQL_SQL_CONFORMANCE: return number(static_cast<SQLUINTEGER>(SQL_SC_SQL92_ENTRY));
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
            SQL_API_SQLNUMPARAMS, SQL_API_SQLDESCRIBEPARAM, SQL_API_SQLBINDPARAMETER, SQL_API_SQLNATIVESQL,
            SQL_API_SQLGETDESCFIELD, SQL_API_SQLSETDESCFIELD, SQL_API_SQLGETDESCREC, SQL_API_SQLSETDESCREC, SQL_API_SQLCOPYDESC,
            SQL_API_SQLPARAMDATA, SQL_API_SQLPUTDATA, SQL_API_SQLCANCEL, SQL_API_SQLENDTRAN,
            SQL_API_SQLTABLES, SQL_API_SQLCOLUMNS, SQL_API_SQLSTATISTICS, SQL_API_SQLSPECIALCOLUMNS,
            SQL_API_SQLPRIMARYKEYS, SQL_API_SQLFOREIGNKEYS, SQL_API_SQLTABLEPRIVILEGES, SQL_API_SQLCOLUMNPRIVILEGES,
            SQL_API_SQLPROCEDURES, SQL_API_SQLPROCEDURECOLUMNS, SQL_API_SQLGETTYPEINFO };
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
