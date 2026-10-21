#include "hwdbodbc/connection.hpp"

using namespace hwdbodbc;
namespace {
template<class Character>
SQLRETURN driver_connect(SQLHDBC handle, SQLHWND, Character* input, SQLSMALLINT input_length,
    Character* output, SQLSMALLINT capacity, SQLSMALLINT* needed, SQLUSMALLINT completion) {
    return with_handle<Connection>(SQL_HANDLE_DBC, handle, true, [&](Connection& connection) -> SQLRETURN {
        if (connection.connected) throw DriverError("08002", "Connection is already open.");
        if (capacity < 0) throw DriverError("HY090", "Invalid buffer length.");
        if (completion > SQL_DRIVER_COMPLETE_REQUIRED) throw DriverError("HY110", "Invalid driver completion.");
        if (completion != SQL_DRIVER_NOPROMPT) throw DriverError("HYC00", "Connection prompting is not implemented yet.");
        auto options = parse_connection_string(input_text(input, input_length));
        struct ErasePassword {
            Options& options;
            ~ErasePassword() { for (const auto* key : {"PWD", "PASSWORD"}) {
                auto found = options.find(key);
                if (found != options.end() && !found->second.empty()) SecureZeroMemory(found->second.data(), found->second.size());
            } }
        } erase_password{options};
        // ANSI 출력의 표현 불가를 로그인 성공 뒤에 발견하지 않도록 미리 검사한다.
        static_cast<void>(output_text<Character, SQLSMALLINT>(connection_string(options), nullptr, 0, nullptr));
        open_connection(connection, options);
        struct RollbackLogin { Connection& connection; bool complete = false;
            ~RollbackLogin() { if (!complete) { connection.session.reset(); connection.connected = false; } }
        } rollback_login{connection};
        const auto result = output_text(connection_string(options), output, capacity, needed);
        if (result == SQL_SUCCESS_WITH_INFO) connection.diagnostic.append("01004", "Connection string output was truncated.");
        rollback_login.complete = true;
        return connection.diagnostic.size() ? SQL_SUCCESS_WITH_INFO : SQL_SUCCESS;
    });
}
template<class Character>
SQLRETURN get_attribute(SQLHDBC handle, SQLINTEGER attribute, SQLPOINTER output, SQLINTEGER capacity, SQLINTEGER* length) {
    return with_handle<Connection>(SQL_HANDLE_DBC, handle, true, [&](Connection& connection) -> SQLRETURN {
        if (attribute == SQL_ATTR_CURRENT_CATALOG) {
            if constexpr (sizeof(Character) == 2) if (capacity % 2) throw DriverError("HY090", "Unicode buffer length must be even.");
            return output_text("", static_cast<Character*>(output), capacity, length, LengthUnit::bytes);
        }
        if (!output) throw DriverError("HY009", "Invalid use of null pointer.");
        if (attribute == SQL_ATTR_QUIET_MODE) {
            *static_cast<SQLHWND*>(output) = connection.window;
            if (length) *length = sizeof(SQLHWND);
            return SQL_SUCCESS;
        }
        SQLUINTEGER value;
        switch (attribute) {
        case SQL_ATTR_LOGIN_TIMEOUT: value = connection.login_timeout; break;
        case SQL_ATTR_CONNECTION_TIMEOUT: value = connection.connection_timeout; break;
        case SQL_ATTR_AUTOCOMMIT: value = connection.autocommit; break;
        case SQL_ATTR_METADATA_ID: value = connection.metadata_id; break;
        case SQL_ATTR_ACCESS_MODE: value = SQL_MODE_READ_WRITE; break;
        case SQL_ATTR_TXN_ISOLATION: value = SQL_TXN_READ_COMMITTED; break;
        case SQL_ATTR_CONNECTION_DEAD: value = !connection.connected || (connection.session && connection.session->dead()) ? SQL_CD_TRUE : SQL_CD_FALSE; break;
        case SQL_ATTR_ASYNC_DBC_FUNCTIONS_ENABLE: value = SQL_ASYNC_DBC_ENABLE_OFF; break;
        case SQL_ATTR_AUTO_IPD: value = connection.session && connection.session->capabilities.count("prepareDescribe") ? SQL_TRUE : SQL_FALSE; break;
        default: throw DriverError("HY092", "Invalid attribute identifier.");
        }
        *static_cast<SQLUINTEGER*>(output) = value;
        if (length) *length = sizeof(value);
        return SQL_SUCCESS;
    });
}
template<class Character>
SQLRETURN set_attribute(SQLHDBC handle, SQLINTEGER attribute, SQLPOINTER input, SQLINTEGER length) {
    return with_handle<Connection>(SQL_HANDLE_DBC, handle, true, [&](Connection& connection) -> SQLRETURN {
        const auto value = reinterpret_cast<std::uintptr_t>(input);
        if (attribute == SQL_ATTR_CURRENT_CATALOG) {
            if constexpr (sizeof(Character) == 2) {
                if (length != SQL_NTS && (length < 0 || length % 2)) throw DriverError("HY090", "Invalid Unicode string byte length.");
            }
            const auto text = input_text(static_cast<Character*>(input), length == SQL_NTS ? SQL_NTS : length / static_cast<SQLINTEGER>(sizeof(Character)));
            if (!text.empty()) throw DriverError("HYC00", "Catalogs are not supported; use Tablespace or USE.");
            return SQL_SUCCESS;
        }
        if (attribute == SQL_ATTR_QUIET_MODE) { connection.window = static_cast<SQLHWND>(input); return SQL_SUCCESS; }
        if (attribute == SQL_ATTR_LOGIN_TIMEOUT || attribute == SQL_ATTR_CONNECTION_TIMEOUT) {
            if (value > UINT_MAX / 1000U) throw DriverError("HY024", "Timeout exceeds the supported range.");
            if (attribute == SQL_ATTR_LOGIN_TIMEOUT) {
                if (connection.connected) throw DriverError("HY011", "Login timeout cannot be changed after connection.");
                connection.login_timeout = static_cast<SQLUINTEGER>(value);
            } else connection.connection_timeout = static_cast<SQLUINTEGER>(value);
            return SQL_SUCCESS;
        }
        if (attribute == SQL_ATTR_METADATA_ID) {
            if (value > SQL_TRUE) throw DriverError("HY024", "Invalid attribute value.");
            connection.metadata_id = static_cast<SQLUINTEGER>(value); return SQL_SUCCESS;
        }
        if (attribute == SQL_ATTR_AUTOCOMMIT) {
            if (value != SQL_AUTOCOMMIT_ON && value != SQL_AUTOCOMMIT_OFF) throw DriverError("HY024", "Invalid autocommit value.");
            if (connection.connected && connection.autocommit != value)
                connection.session->request({{"type", "execute"}, {"sql", value == SQL_AUTOCOMMIT_ON ? "SET AUTOCOMMIT ON" : "SET AUTOCOMMIT OFF"}}, "result", connection.connection_timeout);
            connection.autocommit = static_cast<SQLUINTEGER>(value); return SQL_SUCCESS;
        }
        if (attribute == SQL_ATTR_ACCESS_MODE) {
            if (value == SQL_MODE_READ_WRITE) return SQL_SUCCESS;
            if (value != SQL_MODE_READ_ONLY) throw DriverError("HY024", "Invalid access mode.");
            connection.diagnostic.append("01S02", "Read-write access mode was retained."); return SQL_SUCCESS_WITH_INFO;
        }
        if (attribute == SQL_ATTR_TXN_ISOLATION) {
            if (value == SQL_TXN_READ_COMMITTED) return SQL_SUCCESS;
            throw DriverError("HYC00", "Only READ COMMITTED isolation is supported.");
        }
        if (attribute == SQL_ATTR_ASYNC_DBC_FUNCTIONS_ENABLE) {
            if (value == SQL_ASYNC_DBC_ENABLE_OFF) return SQL_SUCCESS;
            throw DriverError("HYC00", "Asynchronous execution is not supported.");
        }
        if (attribute == SQL_ATTR_RESET_CONNECTION) throw DriverError("HYC00", "Connection reset is not implemented yet.");
        throw DriverError("HY092", "Invalid attribute identifier.");
    });
}
}
extern "C" SQLRETURN SQL_API SQLDriverConnect(SQLHDBC handle, SQLHWND window, SQLCHAR* input, SQLSMALLINT input_length,
    SQLCHAR* output, SQLSMALLINT capacity, SQLSMALLINT* needed, SQLUSMALLINT completion) {
    return driver_connect(handle, window, input, input_length, output, capacity, needed, completion);
}
extern "C" SQLRETURN SQL_API SQLDriverConnectW(SQLHDBC handle, SQLHWND window, SQLWCHAR* input, SQLSMALLINT input_length,
    SQLWCHAR* output, SQLSMALLINT capacity, SQLSMALLINT* needed, SQLUSMALLINT completion) {
    return driver_connect(handle, window, input, input_length, output, capacity, needed, completion);
}
extern "C" SQLRETURN SQL_API SQLGetConnectAttr(SQLHDBC handle, SQLINTEGER attribute, SQLPOINTER output, SQLINTEGER capacity, SQLINTEGER* length) {
    return get_attribute<SQLCHAR>(handle, attribute, output, capacity, length);
}
extern "C" SQLRETURN SQL_API SQLGetConnectAttrW(SQLHDBC handle, SQLINTEGER attribute, SQLPOINTER output, SQLINTEGER capacity, SQLINTEGER* length) {
    return get_attribute<SQLWCHAR>(handle, attribute, output, capacity, length);
}
extern "C" SQLRETURN SQL_API SQLSetConnectAttr(SQLHDBC handle, SQLINTEGER attribute, SQLPOINTER input, SQLINTEGER length) {
    return set_attribute<SQLCHAR>(handle, attribute, input, length);
}
extern "C" SQLRETURN SQL_API SQLSetConnectAttrW(SQLHDBC handle, SQLINTEGER attribute, SQLPOINTER input, SQLINTEGER length) {
    return set_attribute<SQLWCHAR>(handle, attribute, input, length);
}
extern "C" SQLRETURN SQL_API SQLDisconnect(SQLHDBC handle) {
    return with_handle<Connection>(SQL_HANDLE_DBC, handle, true, [&](Connection& connection) -> SQLRETURN {
        if (!connection.connected) throw DriverError("08003", "Connection is not open.");
        // 서버 close가 커서·준비 문장·미커밋 변경을 정리한다.
        bool warning = false;
        try { if (connection.session && !connection.session->dead()) connection.session->close(); }
        catch (const DriverError& error) {
            connection.diagnostic.append("01002", "Connection closed after a disconnect error [original state " + error.state + "].", error.native);
            warning = true;
        }
        connection.session.reset();
        connection.connected = false;
        invalidate_connection_children(connection);
        return warning ? SQL_SUCCESS_WITH_INFO : SQL_SUCCESS;
    });
}
