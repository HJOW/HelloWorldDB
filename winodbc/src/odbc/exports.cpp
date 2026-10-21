#include "hwdbodbc/handles.hpp"
#include "hwdbodbc/statement.hpp"

using namespace hwdbodbc;

namespace {
template<class Character>
SQLRETURN diagnostic_record(SQLSMALLINT type, SQLHANDLE handle, SQLSMALLINT record,
    Character* state, SQLINTEGER* native, Character* text,
    SQLSMALLINT capacity, SQLSMALLINT* length) noexcept {
    return with_handle<Handle>(type, handle, false, [&](Handle& value) -> SQLRETURN {
        if (record <= 0 || capacity < 0) return SQL_ERROR;
        const auto& diagnostic = value.diagnostic;
        if (static_cast<std::size_t>(record) > diagnostic.size()) return SQL_NO_DATA;
        const auto item = diagnostic.record(static_cast<std::size_t>(record - 1));
        if (state) {
            for (std::size_t i = 0; i < 5; ++i) state[i] = static_cast<Character>(item.state[i]);
            state[5] = 0;
        }
        if (native) *native = item.native_error;
        return output_text(item.message, text, capacity, length);
    });
}

template<class Character>
SQLRETURN diagnostic_field(SQLSMALLINT type, SQLHANDLE handle, SQLSMALLINT record,
    SQLSMALLINT field, SQLPOINTER output, SQLSMALLINT capacity, SQLSMALLINT* length) noexcept {
    return with_handle<Handle>(type, handle, false, [&](Handle& value) -> SQLRETURN {
        const auto& diagnostic = value.diagnostic;
        const auto numeric = [&](auto number) -> SQLRETURN {
            if (!output) return SQL_ERROR;
            using Type = decltype(number);
            *static_cast<Type*>(output) = number;
            return SQL_SUCCESS;
        };
        const auto text = [&](const std::string& string) -> SQLRETURN {
            if (capacity < 0) return SQL_ERROR;
            return output_text(string, static_cast<Character*>(output), capacity, length, LengthUnit::bytes);
        };
        switch (field) {
        case SQL_DIAG_NUMBER: return numeric(static_cast<SQLINTEGER>(diagnostic.size()));
        case SQL_DIAG_RETURNCODE: return numeric(diagnostic.return_code);
        case SQL_DIAG_ROW_COUNT:
            return type == SQL_HANDLE_STMT ? numeric(diagnostic.row_count) : SQL_ERROR;
        case SQL_DIAG_CURSOR_ROW_COUNT:
            return type == SQL_HANDLE_STMT ? numeric(diagnostic.cursor_row_count) : SQL_ERROR;
        case SQL_DIAG_DYNAMIC_FUNCTION:
            return type == SQL_HANDLE_STMT ? text(diagnostic.dynamic_function) : SQL_ERROR;
        case SQL_DIAG_DYNAMIC_FUNCTION_CODE:
            return type == SQL_HANDLE_STMT ? numeric(diagnostic.dynamic_function_code) : SQL_ERROR;
        default: break;
        }
        if (record <= 0) return SQL_ERROR;
        if (static_cast<std::size_t>(record) > diagnostic.size()) return SQL_NO_DATA;
        const auto item = diagnostic.record(static_cast<std::size_t>(record - 1));
        switch (field) {
        case SQL_DIAG_SQLSTATE: return text(item.state);
        case SQL_DIAG_MESSAGE_TEXT: return text(item.message);
        case SQL_DIAG_NATIVE: return numeric(item.native_error);
        case SQL_DIAG_ROW_NUMBER: return type == SQL_HANDLE_STMT ? numeric(item.row) : SQL_ERROR;
        case SQL_DIAG_COLUMN_NUMBER: return type == SQL_HANDLE_STMT ? numeric(item.column) : SQL_ERROR;
        case SQL_DIAG_CLASS_ORIGIN:
            return text(item.state.substr(0, 2) == "IM" ? "ODBC 3.0" : "ISO 9075");
        case SQL_DIAG_SUBCLASS_ORIGIN: {
            const std::string codes = " 01S00 01S01 01S02 01S06 01S07 07S01 08S01 21S01 21S02 25S01 25S02 25S03 42S01 42S02 42S11 42S12 42S21 42S22 HY095 HY097 HY098 HY099 HY100 HY101 HY105 HY106 HY107 HY109 HY110 HY111 HYT00 HYT01 ";
            return text(item.state.substr(0, 2) == "IM" || codes.find(" " + item.state + " ") != std::string::npos
                ? "ODBC 3.0" : "ISO 9075");
        }
        case SQL_DIAG_CONNECTION_NAME: return text("");
        case SQL_DIAG_SERVER_NAME: {
            auto connection = type == SQL_HANDLE_DBC ? find_handle(type, handle) : value.parent;
            return text(connection && connection->type == SQL_HANDLE_DBC
                ? static_cast<Connection&>(*connection).server_name : "");
        }
        default: return SQL_ERROR;
        }
    });
}

template<class Character>
SQLRETURN connect(SQLHDBC handle, Character* name, SQLSMALLINT name_length,
    Character* user, SQLSMALLINT user_length, Character* password, SQLSMALLINT password_length) {
    return with_handle<Connection>(SQL_HANDLE_DBC, handle, true, [&](Connection& connection) -> SQLRETURN {
        if (connection.connected) throw DriverError("08002", "Connection is already open.");
        Options options{{"DSN", input_text(name, name_length)}};
        if (user) options["UID"] = input_text(user, user_length);
        else if (user_length != 0) throw DriverError("HY009", "Invalid use of null pointer.");
        if (password) options["PWD"] = input_text(password, password_length);
        else if (password_length != 0) throw DriverError("HY009", "Invalid use of null pointer.");
        else options["PWD"] = "";
        struct WipePassword { Options& options; ~WipePassword() {
            const auto found = options.find("PWD");
            if (found != options.end() && !found->second.empty()) SecureZeroMemory(found->second.data(), found->second.size());
        } } wipe_password{options};
        open_connection(connection, options);
        return connection.diagnostic.size() ? SQL_SUCCESS_WITH_INFO : SQL_SUCCESS;
    });
}
}

extern "C" SQLRETURN SQL_API SQLAllocHandle(SQLSMALLINT type, SQLHANDLE input, SQLHANDLE* output) {
    return allocate_handle(type, input, output);
}
extern "C" SQLRETURN SQL_API SQLFreeHandle(SQLSMALLINT type, SQLHANDLE handle) {
    return free_handle(type, handle);
}

extern "C" SQLRETURN SQL_API SQLSetEnvAttr(SQLHENV handle, SQLINTEGER attribute, SQLPOINTER value, SQLINTEGER) {
    return with_handle<Environment>(SQL_HANDLE_ENV, handle, true, [&](Environment& environment) -> SQLRETURN {
        const auto numeric = reinterpret_cast<std::uintptr_t>(value);
        if (attribute == SQL_ATTR_ODBC_VERSION) {
            if (environment.children.load()) throw DriverError("HY010", "Connections have already been allocated.");
            if (numeric != SQL_OV_ODBC2 && numeric != SQL_OV_ODBC3 && numeric != SQL_OV_ODBC3_80)
                throw DriverError("HY024", "Invalid attribute value.");
            environment.version = static_cast<SQLUINTEGER>(numeric);
            return SQL_SUCCESS;
        }
        if (attribute == SQL_ATTR_OUTPUT_NTS) {
            if (numeric == SQL_TRUE) return SQL_SUCCESS;
            if (numeric == SQL_FALSE) throw DriverError("HYC00", "Non-terminated output is not supported.");
            throw DriverError("HY024", "Invalid attribute value.");
        }
        throw DriverError("HY092", "Invalid attribute identifier.");
    });
}

extern "C" SQLRETURN SQL_API SQLGetEnvAttr(SQLHENV handle, SQLINTEGER attribute,
    SQLPOINTER value, SQLINTEGER, SQLINTEGER* length) {
    return with_handle<Environment>(SQL_HANDLE_ENV, handle, true, [&](Environment& environment) -> SQLRETURN {
        if (attribute != SQL_ATTR_ODBC_VERSION && attribute != SQL_ATTR_OUTPUT_NTS)
            throw DriverError("HY092", "Invalid attribute identifier.");
        if (!value) throw DriverError("HY009", "Invalid use of null pointer.");
        *static_cast<SQLUINTEGER*>(value) = attribute == SQL_ATTR_ODBC_VERSION ? environment.version : SQL_TRUE;
        if (length) *length = sizeof(SQLUINTEGER);
        return SQL_SUCCESS;
    });
}

extern "C" SQLRETURN SQL_API SQLGetStmtAttr(SQLHSTMT handle, SQLINTEGER attribute,
    SQLPOINTER output, SQLINTEGER, SQLINTEGER* length) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        return get_statement_attribute(statement, attribute, output, length);
    });
}
extern "C" SQLRETURN SQL_API SQLGetStmtAttrW(SQLHSTMT handle, SQLINTEGER attribute,
    SQLPOINTER output, SQLINTEGER capacity, SQLINTEGER* length) {
    return SQLGetStmtAttr(handle, attribute, output, capacity, length);
}

extern "C" SQLRETURN SQL_API SQLGetDiagRec(SQLSMALLINT type, SQLHANDLE handle,
    SQLSMALLINT record, SQLCHAR* state, SQLINTEGER* native, SQLCHAR* text,
    SQLSMALLINT capacity, SQLSMALLINT* length) {
    return diagnostic_record(type, handle, record, state, native, text, capacity, length);
}
extern "C" SQLRETURN SQL_API SQLGetDiagRecW(SQLSMALLINT type, SQLHANDLE handle,
    SQLSMALLINT record, SQLWCHAR* state, SQLINTEGER* native, SQLWCHAR* text,
    SQLSMALLINT capacity, SQLSMALLINT* length) {
    return diagnostic_record(type, handle, record, state, native, text, capacity, length);
}
extern "C" SQLRETURN SQL_API SQLGetDiagField(SQLSMALLINT type, SQLHANDLE handle,
    SQLSMALLINT record, SQLSMALLINT field, SQLPOINTER output, SQLSMALLINT capacity, SQLSMALLINT* length) {
    return diagnostic_field<SQLCHAR>(type, handle, record, field, output, capacity, length);
}
extern "C" SQLRETURN SQL_API SQLGetDiagFieldW(SQLSMALLINT type, SQLHANDLE handle,
    SQLSMALLINT record, SQLSMALLINT field, SQLPOINTER output, SQLSMALLINT capacity, SQLSMALLINT* length) {
    return diagnostic_field<SQLWCHAR>(type, handle, record, field, output, capacity, length);
}
extern "C" SQLRETURN SQL_API SQLConnect(SQLHDBC handle, SQLCHAR* name, SQLSMALLINT name_length,
    SQLCHAR* user, SQLSMALLINT user_length, SQLCHAR* password, SQLSMALLINT password_length) {
    return connect(handle, name, name_length, user, user_length, password, password_length);
}
extern "C" SQLRETURN SQL_API SQLConnectW(SQLHDBC handle, SQLWCHAR* name, SQLSMALLINT name_length,
    SQLWCHAR* user, SQLSMALLINT user_length, SQLWCHAR* password, SQLSMALLINT password_length) {
    return connect(handle, name, name_length, user, user_length, password, password_length);
}
