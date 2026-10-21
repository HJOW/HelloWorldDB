#include "hwdbodbc/statement.hpp"
#include "hwdbodbc/sql_text.hpp"
#include "hwdbodbc/descriptor.hpp"

using namespace hwdbodbc;
#ifdef _WIN64
using ColumnNumericArgument = SQLLEN*;
#else
// Windows SDK는 x86의 마지막 인자를 SQLPOINTER로 선언한다.
using ColumnNumericArgument = SQLPOINTER;
#endif
namespace {
std::wstring canonical_cursor_name(const std::string& name) {
    const auto input = utf16(name);
    std::wstring value;
    if (!input.empty() && input.front() == L'"') {
        if (input.size() < 2 || input.back() != L'"') throw DriverError("34000", "Invalid quoted cursor name.");
        for (std::size_t i = 1; i + 1 < input.size(); ++i) {
            if (input[i] == L'"' && (i + 2 >= input.size() || input[++i] != L'"')) throw DriverError("34000", "Invalid quoted cursor name.");
            value += input[i];
        }
    } else {
        if (input.find(L'"') != std::wstring::npos) throw DriverError("34000", "Invalid cursor name delimiter.");
        const auto count = LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_UPPERCASE, input.data(), static_cast<int>(input.size()), nullptr, 0, nullptr, nullptr, 0);
        if (!count) throw DriverError("34000", "Invalid cursor name.");
        value.resize(static_cast<std::size_t>(count));
        if (!LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_UPPERCASE, input.data(), static_cast<int>(input.size()), value.data(), count, nullptr, nullptr, 0))
            throw DriverError("34000", "Invalid cursor name.");
    }
    return value;
}
const DescriptorRecord& column_record(Statement& statement, SQLUSMALLINT column) {
    static_cast<void>(statement_connection(statement));
    if (statement.prepared && !statement.executed) describe_prepared(statement);
    const auto& records = statement.descriptors[2]->records;
    if (!column || column > records.size()) throw DriverError("07009", "Invalid column number.");
    return records[column - 1];
}
template<class Character>
SQLRETURN execute_direct(SQLHSTMT handle, Character* input, SQLINTEGER length) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        auto& connection = statement_connection(statement);
        if (statement.cursor_open) throw DriverError("24000", "Close the current cursor before executing another statement.");
        const auto text = input_text(input, length);
        const auto sql = statement.noscan == SQL_NOSCAN_OFF ? native_sql(text) : text;
        if (parameter_count(sql)) {
            prepare_statement(statement, sql);
            return execute_prepared(statement);
        }
        release_prepared(statement);
        statement.executed = false; statement.row_count = 0;
        statement.diagnostic.row_count = 0; statement.diagnostic.cursor_row_count = 0;
        statement.descriptors[2]->records.clear();
        const auto response = connection.session->request({{"type", "execute"}, {"sql", sql}, {"fetchSize", connection.fetch_size}}, "result", connection.connection_timeout);
        accept_result(statement, response);
        return SQL_SUCCESS;
    });
}
template<class Character>
SQLRETURN describe_column(SQLHSTMT handle, SQLUSMALLINT column, Character* name, SQLSMALLINT capacity,
    SQLSMALLINT* length, SQLSMALLINT* type, SQLULEN* size, SQLSMALLINT* scale, SQLSMALLINT* nullable) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        if (capacity < 0) throw DriverError("HY090", "Invalid buffer length.");
        const auto& metadata = column_record(statement, column).metadata;
        if (type) *type = metadata.sql_type;
        if (size) *size = metadata.size;
        if (scale) *scale = metadata.scale;
        if (nullable) *nullable = metadata.nullable;
        const auto result = output_text(metadata.name, name, capacity, length);
        if (result == SQL_SUCCESS_WITH_INFO) statement.diagnostic.append("01004", "Column name was truncated.");
        return result;
    });
}
template<class Character>
SQLRETURN column_attribute(SQLHSTMT handle, SQLUSMALLINT column, SQLUSMALLINT field, SQLPOINTER output,
    SQLSMALLINT capacity, SQLSMALLINT* length, SQLLEN* numeric) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        const auto put = [&](SQLLEN value) -> SQLRETURN { if (numeric) *numeric = value; return SQL_SUCCESS; };
        if (field == SQL_DESC_COUNT || field == SQL_COLUMN_COUNT) {
            if (statement.prepared && !statement.executed) describe_prepared(statement);
            return put(static_cast<SQLLEN>(statement.descriptors[2]->records.size()));
        }
        const auto& record = column_record(statement, column);
        const auto& metadata = record.metadata;
        const auto string = [&](const std::string& value) {
            const auto result = output_text(value, static_cast<Character*>(output), capacity, length, LengthUnit::bytes);
            if (result == SQL_SUCCESS_WITH_INFO) statement.diagnostic.append("01004", "Column attribute was truncated.");
            return result;
        };
        switch (field) {
        case SQL_DESC_NAME: case SQL_COLUMN_NAME: case SQL_DESC_LABEL: return string(metadata.name);
        case SQL_DESC_TYPE_NAME: case SQL_DESC_LOCAL_TYPE_NAME: return string(metadata.type_name);
        case SQL_DESC_BASE_COLUMN_NAME: case SQL_DESC_BASE_TABLE_NAME: case SQL_DESC_CATALOG_NAME:
        case SQL_DESC_SCHEMA_NAME: case SQL_DESC_TABLE_NAME: return string("");
        case SQL_DESC_LITERAL_PREFIX: case SQL_DESC_LITERAL_SUFFIX:
            return string(metadata.default_c == SQL_C_WCHAR || metadata.sql_type == SQL_TYPE_DATE || metadata.sql_type == SQL_TYPE_TIME || metadata.sql_type == SQL_TYPE_TIMESTAMP ? "'" : "");
        case SQL_DESC_CONCISE_TYPE: return put(metadata.sql_type);
        case SQL_DESC_TYPE: return put(metadata.interval_code ? SQL_INTERVAL : metadata.sql_type >= SQL_TYPE_DATE && metadata.sql_type <= SQL_TYPE_TIMESTAMP ? SQL_DATETIME : metadata.sql_type);
        case SQL_DESC_DATETIME_INTERVAL_CODE: return put(metadata.interval_code ? metadata.interval_code
            : metadata.sql_type == SQL_TYPE_DATE ? SQL_CODE_DATE : metadata.sql_type == SQL_TYPE_TIME ? SQL_CODE_TIME : metadata.sql_type == SQL_TYPE_TIMESTAMP ? SQL_CODE_TIMESTAMP : 0);
        case SQL_DESC_LENGTH: return put(static_cast<SQLLEN>(metadata.size));
        case SQL_COLUMN_LENGTH: case SQL_DESC_OCTET_LENGTH: return put(metadata.octets);
        case SQL_DESC_PRECISION: return put(record.conversion.precision);
        case SQL_COLUMN_PRECISION: return put(static_cast<SQLLEN>(metadata.size));
        case SQL_DESC_SCALE: return put(record.conversion.scale);
        case SQL_COLUMN_SCALE: return put(metadata.scale);
        case SQL_DESC_NULLABLE: case SQL_COLUMN_NULLABLE: return put(metadata.nullable);
        case SQL_DESC_DISPLAY_SIZE: return put(metadata.display_size);
        case SQL_DESC_UNSIGNED: return put(SQL_FALSE);
        case SQL_DESC_UPDATABLE: return put(SQL_ATTR_READONLY);
        case SQL_DESC_AUTO_UNIQUE_VALUE: case SQL_DESC_ROWVER: return put(SQL_FALSE);
        case SQL_DESC_CASE_SENSITIVE: return put(metadata.sql_type == SQL_WCHAR || metadata.sql_type == SQL_WVARCHAR ? SQL_TRUE : SQL_FALSE);
        case SQL_DESC_FIXED_PREC_SCALE: return put(SQL_FALSE);
        case SQL_DESC_NUM_PREC_RADIX: return put(record.radix);
        case SQL_DESC_UNNAMED: return put(record.unnamed);
        case SQL_DESC_DATETIME_INTERVAL_PRECISION: return put(metadata.leading_precision);
        case SQL_DESC_SEARCHABLE: return put(SQL_PRED_SEARCHABLE);
        default: throw DriverError("HY091", "Invalid column attribute identifier.");
        }
    });
}
template<class Character>
SQLRETURN cursor_name(SQLHSTMT handle, Character* output, SQLSMALLINT capacity, SQLSMALLINT* length) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        const auto result = output_text(statement.cursor_name, output, capacity, length);
        if (result == SQL_SUCCESS_WITH_INFO) statement.diagnostic.append("01004", "Cursor name was truncated.");
        return result;
    });
}
template<class Character>
SQLRETURN set_cursor_name(SQLHSTMT handle, Character* input, SQLSMALLINT length) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        if (statement.executed) throw DriverError("24000", "Cursor name cannot change in an executed state.");
        const auto name = input_text(input, length);
        const auto wide = canonical_cursor_name(name);
        std::size_t points = 0;
        for (const auto unit : wide) if (unit < 0xdc00 || unit > 0xdfff) ++points;
        if (!points || points > 128 || name.find('\0') != std::string::npos) throw DriverError("34000", "Invalid cursor name.");
        std::string upper = utf8(wide);
        for (auto& byte : upper) if (byte >= 'a' && byte <= 'z') byte = static_cast<char>(byte - 'a' + 'A');
        if (upper.rfind("SQLCUR", 0) == 0 || upper.rfind("SQL_CUR", 0) == 0) throw DriverError("34000", "Cursor name uses a reserved prefix.");
        for (const auto& other : connection_statements(static_cast<Connection&>(*statement.parent))) {
            if (other.get() == &statement) continue;
            const auto other_name = canonical_cursor_name(other->cursor_name);
            if (wide == other_name)
                throw DriverError("3C000", "Cursor name is already in use.");
        }
        statement.cursor_name = name;
        return SQL_SUCCESS;
    });
}
}

extern "C" SQLRETURN SQL_API SQLExecDirect(SQLHSTMT handle, SQLCHAR* input, SQLINTEGER length) { return execute_direct(handle, input, length); }
extern "C" SQLRETURN SQL_API SQLExecDirectW(SQLHSTMT handle, SQLWCHAR* input, SQLINTEGER length) { return execute_direct(handle, input, length); }
extern "C" SQLRETURN SQL_API SQLNumResultCols(SQLHSTMT handle, SQLSMALLINT* count) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        static_cast<void>(statement_connection(statement));
        if (!count) throw DriverError("HY009", "Invalid use of null pointer.");
        if (statement.prepared && !statement.executed) describe_prepared(statement);
        *count = static_cast<SQLSMALLINT>(statement.descriptors[2]->records.size()); return SQL_SUCCESS;
    });
}
extern "C" SQLRETURN SQL_API SQLRowCount(SQLHSTMT handle, SQLLEN* count) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        static_cast<void>(statement_connection(statement));
        if (!statement.executed) throw DriverError("HY010", "No statement has been executed.");
        if (!count) throw DriverError("HY009", "Invalid use of null pointer.");
        *count = statement.row_count; return SQL_SUCCESS;
    });
}
extern "C" SQLRETURN SQL_API SQLDescribeCol(SQLHSTMT handle, SQLUSMALLINT column, SQLCHAR* name, SQLSMALLINT capacity,
    SQLSMALLINT* length, SQLSMALLINT* type, SQLULEN* size, SQLSMALLINT* scale, SQLSMALLINT* nullable) { return describe_column(handle, column, name, capacity, length, type, size, scale, nullable); }
extern "C" SQLRETURN SQL_API SQLDescribeColW(SQLHSTMT handle, SQLUSMALLINT column, SQLWCHAR* name, SQLSMALLINT capacity,
    SQLSMALLINT* length, SQLSMALLINT* type, SQLULEN* size, SQLSMALLINT* scale, SQLSMALLINT* nullable) { return describe_column(handle, column, name, capacity, length, type, size, scale, nullable); }
extern "C" SQLRETURN SQL_API SQLColAttribute(SQLHSTMT handle, SQLUSMALLINT column, SQLUSMALLINT field, SQLPOINTER output, SQLSMALLINT capacity, SQLSMALLINT* length, ColumnNumericArgument numeric) { return column_attribute<SQLCHAR>(handle, column, field, output, capacity, length, static_cast<SQLLEN*>(numeric)); }
extern "C" SQLRETURN SQL_API SQLColAttributeW(SQLHSTMT handle, SQLUSMALLINT column, SQLUSMALLINT field, SQLPOINTER output, SQLSMALLINT capacity, SQLSMALLINT* length, ColumnNumericArgument numeric) { return column_attribute<SQLWCHAR>(handle, column, field, output, capacity, length, static_cast<SQLLEN*>(numeric)); }
extern "C" SQLRETURN SQL_API SQLBindCol(SQLHSTMT handle, SQLUSMALLINT column, SQLSMALLINT type, SQLPOINTER output, SQLLEN capacity, SQLLEN* indicator) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        if (!column || column > static_cast<SQLUSMALLINT>((std::numeric_limits<SQLSMALLINT>::max)())) throw DriverError("07009", "Invalid column number.");
        if (!valid_c_type(type)) throw DriverError("HY003", "Invalid C data type.");
        if (capacity < 0) throw DriverError("HY090", "Invalid buffer length.");
        auto& records = statement.descriptors[0]->records;
        if (records.size() < column) records.resize(column);
        auto& record = records[column - 1];
        descriptor_concise_type(record,type,true); record.data = output; record.capacity = capacity; record.bound = output != nullptr;
        record.indicator = indicator; record.octet_length_pointer = indicator;
        if (!output) while (!records.empty() && !records.back().bound) records.pop_back();
        return SQL_SUCCESS;
    });
}
extern "C" SQLRETURN SQL_API SQLFetch(SQLHSTMT handle) { return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, fetch_rows); }
extern "C" SQLRETURN SQL_API SQLFetchScroll(SQLHSTMT handle, SQLSMALLINT orientation, SQLLEN) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        if (orientation != SQL_FETCH_NEXT) throw DriverError("HY106", "Only SQL_FETCH_NEXT is supported.");
        return fetch_rows(statement);
    });
}
extern "C" SQLRETURN SQL_API SQLGetData(SQLHSTMT handle, SQLUSMALLINT column, SQLSMALLINT type, SQLPOINTER output, SQLLEN capacity, SQLLEN* indicator) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        const auto& implementation = column_record(statement, column);
        if (!statement.cursor_open || !statement.current_row) throw DriverError("24000", "Fetch a row before retrieving column data.");
        const auto& application = *statement.descriptors[0];
        if (application.array_size != 1) throw DriverError("HYC00", "SQLGetData requires row array size one.");
        std::size_t highest_bound = 0;
        for (std::size_t i = 0; i < application.records.size(); ++i) if (application.records[i].data) highest_bound = i + 1;
        if (column <= highest_bound || column < statement.last_get_column) throw DriverError("07009", "SQLGetData requires increasing unbound column numbers.");
        ConversionSpec spec;
        if (type == SQL_ARD_TYPE) {
            if (column > application.records.size()) throw DriverError("07009", "ARD record is missing.");
            type = application.records[column - 1].type; spec = application.records[column - 1].conversion;
        }
        const auto result = convert_value(statement.rows[statement.next_row - 1][column - 1], implementation.metadata,
            type, output, capacity, indicator, statement.diagnostic, &statement.streams[column - 1], spec, SQL_ROW_NUMBER_UNKNOWN, column);
        statement.last_get_column = column;
        return result;
    });
}
extern "C" SQLRETURN SQL_API SQLCloseCursor(SQLHSTMT handle) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        static_cast<void>(statement_connection(statement));
        if (!statement.cursor_open) throw DriverError("24000", "No result set is open.");
        finish_statement_result(statement); return SQL_SUCCESS;
    });
}
extern "C" SQLRETURN SQL_API SQLFreeStmt(SQLHSTMT handle, SQLUSMALLINT option) {
    if (option == SQL_DROP) return free_handle(SQL_HANDLE_STMT, handle);
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        switch (option) {
        case SQL_CLOSE: finish_statement_result(statement); break;
        case SQL_UNBIND: statement.descriptors[0]->records.clear(); break;
        case SQL_RESET_PARAMS:
            statement.descriptors[1]->records.clear(); statement.descriptors[3]->records.clear();
            statement.parameter_metadata_dirty = true; break;
        default: throw DriverError("HY092", "Invalid SQLFreeStmt option.");
        }
        return SQL_SUCCESS;
    });
}
extern "C" SQLRETURN SQL_API SQLMoreResults(SQLHSTMT handle) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        static_cast<void>(statement_connection(statement));
        if (!statement.executed) throw DriverError("HY010", "No executed statement has a result to advance.");
        finish_statement_result(statement); return SQL_NO_DATA;
    });
}
extern "C" SQLRETURN SQL_API SQLGetCursorName(SQLHSTMT handle, SQLCHAR* output, SQLSMALLINT capacity, SQLSMALLINT* length) { return cursor_name(handle, output, capacity, length); }
extern "C" SQLRETURN SQL_API SQLGetCursorNameW(SQLHSTMT handle, SQLWCHAR* output, SQLSMALLINT capacity, SQLSMALLINT* length) { return cursor_name(handle, output, capacity, length); }
extern "C" SQLRETURN SQL_API SQLSetCursorName(SQLHSTMT handle, SQLCHAR* input, SQLSMALLINT length) { return set_cursor_name(handle, input, length); }
extern "C" SQLRETURN SQL_API SQLSetCursorNameW(SQLHSTMT handle, SQLWCHAR* input, SQLSMALLINT length) { return set_cursor_name(handle, input, length); }
