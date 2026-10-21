#include "hwdbodbc/statement.hpp"
#include "hwdbodbc/parameters.hpp"
#include "hwdbodbc/sql_text.hpp"

using namespace hwdbodbc;
namespace {
template<class Character> SQLRETURN prepare(SQLHSTMT handle, Character* input, SQLINTEGER length) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        const auto sql = input_text(input, length);
        prepare_statement(statement, statement.noscan == SQL_NOSCAN_OFF ? native_sql(sql) : sql);
        return SQL_SUCCESS;
    });
}
template<class Character> SQLRETURN native(SQLHDBC handle, Character* input, SQLINTEGER length, Character* output, SQLINTEGER capacity, SQLINTEGER* needed) {
    return with_handle<Connection>(SQL_HANDLE_DBC, handle, true, [&](Connection& connection) -> SQLRETURN {
        if (!connection.connected) throw DriverError("08003", "Connection is not open.");
        const auto result = output_text(native_sql(input_text(input, length)), output, capacity, needed);
        if (result == SQL_SUCCESS_WITH_INFO) connection.diagnostic.append("01004", "Native SQL output was truncated.");
        return result;
    });
}
}
extern "C" SQLRETURN SQL_API SQLPrepare(SQLHSTMT handle, SQLCHAR* input, SQLINTEGER length) { return prepare(handle, input, length); }
extern "C" SQLRETURN SQL_API SQLPrepareW(SQLHSTMT handle, SQLWCHAR* input, SQLINTEGER length) { return prepare(handle, input, length); }
extern "C" SQLRETURN SQL_API SQLExecute(SQLHSTMT handle) { return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, execute_prepared); }
extern "C" SQLRETURN SQL_API SQLNumParams(SQLHSTMT handle, SQLSMALLINT* count) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        if (!statement.prepared) throw DriverError("HY010", "No statement has been prepared.");
        if (!count) throw DriverError("HY009", "Invalid use of null pointer.");
        *count = static_cast<SQLSMALLINT>(statement.parameter_metadata.size()); return SQL_SUCCESS;
    });
}
extern "C" SQLRETURN SQL_API SQLDescribeParam(SQLHSTMT handle, SQLUSMALLINT number, SQLSMALLINT* type, SQLULEN* size, SQLSMALLINT* scale, SQLSMALLINT* nullable) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        if (!statement.prepared) throw DriverError("HY010", "No statement has been prepared.");
        if (!number || number > statement.parameter_metadata.size()) throw DriverError("07009", "Invalid parameter number.");
        if (!statement.cursor_open) describe_prepared(statement);
        const auto& metadata = statement.parameter_metadata[number - 1];
        if (metadata.sql_type == SQL_UNKNOWN_TYPE) throw DriverError("HYC00", "The server cannot infer this parameter type; bind a type or use CAST.");
        if (type) *type = metadata.sql_type;
        if (size) *size = metadata.size;
        if (scale) *scale = metadata.scale;
        if (nullable) *nullable = metadata.nullable;
        return SQL_SUCCESS;
    });
}
extern "C" SQLRETURN SQL_API SQLBindParameter(SQLHSTMT handle, SQLUSMALLINT number, SQLSMALLINT direction, SQLSMALLINT ctype, SQLSMALLINT sqltype,
    SQLULEN size, SQLSMALLINT scale, SQLPOINTER data, SQLLEN capacity, SQLLEN* indicator) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        if (!number || number > static_cast<SQLUSMALLINT>((std::numeric_limits<SQLSMALLINT>::max)())) throw DriverError("07009", "Invalid parameter number.");
        if (direction != SQL_PARAM_INPUT) {
            if (direction == SQL_PARAM_OUTPUT || direction == SQL_PARAM_INPUT_OUTPUT || direction == SQL_RETURN_VALUE
                || direction == SQL_PARAM_INPUT_OUTPUT_STREAM || direction == SQL_PARAM_OUTPUT_STREAM) throw DriverError("HYC00", "Only input parameters are supported.");
            throw DriverError("HY105", "Invalid parameter direction.");
        }
        if (!valid_c_type(ctype)) throw DriverError("HY003", "Invalid C parameter type.");
        if (capacity < 0) throw DriverError("HY090", "Invalid parameter buffer length.");
        if (!data && !indicator) throw DriverError("HY009", "Parameter data and indicator pointers are both null.");
        const auto metadata = parameter_type(sqltype, size, scale);
        auto& apd = statement.descriptors[1]->records; auto& ipd = statement.descriptors[3]->records;
        // 바인딩은 SQLPrepare 전에도 가능하며, SQL에 없는 여분의 바인딩은 실행 시 무시한다.
        if (apd.size() < number) apd.resize(number);
        if (ipd.size() < number) ipd.resize(number);
        auto& record = apd[number - 1]; record.bound = true; record.type = ctype; record.data = data; record.capacity = capacity;
        record.indicator = indicator; record.octet_length_pointer = indicator;
        ipd[number - 1].metadata = metadata; ipd[number - 1].type = metadata.sql_type; ipd[number - 1].parameter_type = direction;
        statement.parameter_metadata_dirty = true;
        return SQL_SUCCESS;
    });
}
extern "C" SQLRETURN SQL_API SQLNativeSql(SQLHDBC handle, SQLCHAR* input, SQLINTEGER length, SQLCHAR* output, SQLINTEGER capacity, SQLINTEGER* needed) { return native(handle,input,length,output,capacity,needed); }
extern "C" SQLRETURN SQL_API SQLNativeSqlW(SQLHDBC handle, SQLWCHAR* input, SQLINTEGER length, SQLWCHAR* output, SQLINTEGER capacity, SQLINTEGER* needed) { return native(handle,input,length,output,capacity,needed); }
