#include "hwdbodbc/statement.hpp"
#include "hwdbodbc/descriptor.hpp"

namespace hwdbodbc {
SQLRETURN get_statement_attribute(Statement& statement, SQLINTEGER attribute, SQLPOINTER output, SQLINTEGER* length) {
    if (!output) throw DriverError("HY009", "Invalid use of null pointer.");
    const auto number = [&](SQLULEN value) -> SQLRETURN { *static_cast<SQLULEN*>(output) = value; if (length) *length = sizeof(value); return SQL_SUCCESS; };
    const auto pointer = [&](SQLPOINTER value) -> SQLRETURN { *static_cast<SQLPOINTER*>(output) = value; if (length) *length = sizeof(value); return SQL_SUCCESS; };
    const auto& ard = *statement.descriptors[0]; const auto& apd = *statement.descriptors[1];
    const auto& ird = *statement.descriptors[2]; const auto& ipd = *statement.descriptors[3];
    switch (attribute) {
    case SQL_ATTR_APP_ROW_DESC: return pointer(ard.id);
    case SQL_ATTR_APP_PARAM_DESC: return pointer(apd.id);
    case SQL_ATTR_IMP_ROW_DESC: return pointer(ird.id);
    case SQL_ATTR_IMP_PARAM_DESC: return pointer(ipd.id);
    case SQL_ATTR_ROW_ARRAY_SIZE: return number(ard.array_size);
    case SQL_ATTR_ROW_BIND_TYPE: return number(ard.bind_type);
    case SQL_ATTR_ROW_BIND_OFFSET_PTR: return pointer(ard.bind_offset);
    case SQL_ATTR_ROW_OPERATION_PTR: return pointer(ard.array_status);
    case SQL_ATTR_ROW_STATUS_PTR: return pointer(ird.array_status);
    case SQL_ATTR_ROWS_FETCHED_PTR: return pointer(ird.rows_processed);
    case SQL_ATTR_PARAMSET_SIZE: return number(apd.array_size);
    case SQL_ATTR_PARAM_BIND_TYPE: return number(apd.bind_type);
    case SQL_ATTR_PARAM_BIND_OFFSET_PTR: return pointer(apd.bind_offset);
    case SQL_ATTR_PARAM_OPERATION_PTR: return pointer(apd.array_status);
    case SQL_ATTR_PARAM_STATUS_PTR: return pointer(ipd.array_status);
    case SQL_ATTR_PARAMS_PROCESSED_PTR: return pointer(ipd.rows_processed);
    case SQL_ATTR_QUERY_TIMEOUT: return number(statement.query_timeout);
    case SQL_ATTR_MAX_ROWS: return number(statement.max_rows);
    case SQL_ATTR_MAX_LENGTH: return number(0);
    case SQL_ATTR_ROW_NUMBER: return number(statement.current_row ? statement.row_number : 0);
    case SQL_ATTR_METADATA_ID: return number(statement.metadata_id);
    case SQL_ATTR_NOSCAN: return number(statement.noscan);
    case SQL_ATTR_RETRIEVE_DATA: return number(statement.retrieve_data);
    case SQL_ATTR_CURSOR_TYPE: return number(SQL_CURSOR_FORWARD_ONLY);
    case SQL_ATTR_CONCURRENCY: return number(SQL_CONCUR_READ_ONLY);
    case SQL_ATTR_CURSOR_SCROLLABLE: return number(SQL_NONSCROLLABLE);
    case SQL_ATTR_CURSOR_SENSITIVITY: return number(SQL_INSENSITIVE);
    case SQL_ATTR_USE_BOOKMARKS: return number(SQL_UB_OFF);
    case SQL_ATTR_FETCH_BOOKMARK_PTR: return pointer(nullptr);
    case SQL_ATTR_ASYNC_ENABLE: return number(SQL_ASYNC_ENABLE_OFF);
    case SQL_ATTR_ENABLE_AUTO_IPD: return number(statement.auto_ipd ? SQL_TRUE : SQL_FALSE);
    case SQL_ATTR_KEYSET_SIZE: return number(0);
    case SQL_ATTR_SIMULATE_CURSOR: return number(SQL_SC_NON_UNIQUE);
    default: throw DriverError("HY092", "Invalid statement attribute.");
    }
}
namespace {
SQLRETURN set_statement_attribute(SQLHSTMT handle, SQLINTEGER attribute, SQLPOINTER input) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        const auto value = reinterpret_cast<SQLULEN>(input);
        auto& ard = *statement.descriptors[0]; auto& apd = *statement.descriptors[1];
        auto& ird = *statement.descriptors[2]; auto& ipd = *statement.descriptors[3];
        const auto changed = [&]() -> SQLRETURN { statement.diagnostic.append("01S02", "Statement option value was substituted."); return SQL_SUCCESS_WITH_INFO; };
        switch (attribute) {
        case SQL_ATTR_ROW_ARRAY_SIZE: case SQL_ATTR_PARAMSET_SIZE:
            if (!value) throw DriverError("HY024", "Array size must be at least one.");
            if (value > (std::numeric_limits<SQLULEN>::max)() / sizeof(SQLUSMALLINT)) throw DriverError("HY024", "Array size exceeds the addressable range.");
            (attribute == SQL_ATTR_ROW_ARRAY_SIZE ? ard : apd).array_size = value; break;
        case SQL_ATTR_ROW_BIND_TYPE: case SQL_ATTR_PARAM_BIND_TYPE:
            if (value > (std::numeric_limits<SQLUINTEGER>::max)()) throw DriverError("HY024", "Binding type exceeds the descriptor SQLUINTEGER range.");
            (attribute == SQL_ATTR_ROW_BIND_TYPE ? ard : apd).bind_type = value; break;
        case SQL_ATTR_ROW_BIND_OFFSET_PTR: ard.bind_offset = static_cast<SQLLEN*>(input); break;
        case SQL_ATTR_PARAM_BIND_OFFSET_PTR: apd.bind_offset = static_cast<SQLLEN*>(input); break;
        case SQL_ATTR_ROW_OPERATION_PTR: ard.array_status = static_cast<SQLUSMALLINT*>(input); break;
        case SQL_ATTR_PARAM_OPERATION_PTR: apd.array_status = static_cast<SQLUSMALLINT*>(input); break;
        case SQL_ATTR_ROW_STATUS_PTR: ird.array_status = static_cast<SQLUSMALLINT*>(input); break;
        case SQL_ATTR_PARAM_STATUS_PTR: ipd.array_status = static_cast<SQLUSMALLINT*>(input); break;
        case SQL_ATTR_ROWS_FETCHED_PTR: ird.rows_processed = static_cast<SQLULEN*>(input); break;
        case SQL_ATTR_PARAMS_PROCESSED_PTR: ipd.rows_processed = static_cast<SQLULEN*>(input); break;
        case SQL_ATTR_MAX_ROWS: statement.max_rows = value; break;
        case SQL_ATTR_MAX_LENGTH: if (value) return changed(); break;
        case SQL_ATTR_QUERY_TIMEOUT:
            if (value) throw DriverError("HYC00", "Query timeout cancellation is not implemented yet.");
            statement.query_timeout = 0; break;
        case SQL_ATTR_METADATA_ID:
            if (value > SQL_TRUE) throw DriverError("HY024", "Invalid metadata identifier mode.");
            statement.metadata_id = static_cast<SQLUINTEGER>(value); break;
        case SQL_ATTR_NOSCAN:
            if (value != SQL_NOSCAN_ON && value != SQL_NOSCAN_OFF) throw DriverError("HY024", "Invalid NOSCAN value.");
            statement.noscan = static_cast<SQLUINTEGER>(value); break;
        case SQL_ATTR_RETRIEVE_DATA:
            if (value != SQL_RD_ON && value != SQL_RD_OFF) throw DriverError("HY024", "Invalid retrieve data value.");
            statement.retrieve_data = static_cast<SQLUINTEGER>(value); break;
        case SQL_ATTR_CURSOR_TYPE:
            if (statement.cursor_open) throw DriverError("24000", "Cursor is already open.");
            if (value > SQL_CURSOR_STATIC) throw DriverError("HY024", "Invalid cursor type.");
            if (value != SQL_CURSOR_FORWARD_ONLY) return changed(); break;
        case SQL_ATTR_CONCURRENCY:
            if (statement.cursor_open) throw DriverError("24000", "Cursor is already open.");
            if (value < SQL_CONCUR_READ_ONLY || value > SQL_CONCUR_VALUES) throw DriverError("HY024", "Invalid cursor concurrency.");
            if (value != SQL_CONCUR_READ_ONLY) return changed(); break;
        case SQL_ATTR_CURSOR_SCROLLABLE:
            if (value != SQL_NONSCROLLABLE && value != SQL_SCROLLABLE) throw DriverError("HY024", "Invalid cursor scrolling option.");
            if (value != SQL_NONSCROLLABLE) return changed(); break;
        case SQL_ATTR_CURSOR_SENSITIVITY:
            if (value != SQL_UNSPECIFIED && value != SQL_INSENSITIVE && value != SQL_SENSITIVE) throw DriverError("HY024", "Invalid cursor sensitivity.");
            if (value != SQL_INSENSITIVE) return changed(); break;
        case SQL_ATTR_USE_BOOKMARKS: if (value != SQL_UB_OFF) throw DriverError("HYC00", "Bookmarks are not supported."); break;
        case SQL_ATTR_FETCH_BOOKMARK_PTR: if (input) throw DriverError("HYC00", "Bookmarks are not supported."); break;
        case SQL_ATTR_ASYNC_ENABLE: if (value != SQL_ASYNC_ENABLE_OFF) throw DriverError("HYC00", "Asynchronous execution is not supported."); break;
        case SQL_ATTR_ENABLE_AUTO_IPD:
            if (value > SQL_TRUE) throw DriverError("HY024", "Invalid automatic IPD setting.");
            if (value && !statement_connection(statement).session->capabilities.count("prepareDescribe")) throw DriverError("HYC00", "The server does not support automatic IPD.");
            statement.auto_ipd = value != SQL_FALSE;
            if (statement.auto_ipd && statement.prepared && !statement.executed) {
                describe_prepared(statement);
                ipd.records.resize(statement.parameter_metadata.size());
                for (std::size_t i = 0; i < ipd.records.size(); ++i) descriptor_sql_metadata(ipd.records[i],statement.parameter_metadata[i]);
            }
            break;
        case SQL_ATTR_APP_ROW_DESC: case SQL_ATTR_APP_PARAM_DESC:
            associate_descriptor(statement,attribute == SQL_ATTR_APP_ROW_DESC ? 0U : 1U,static_cast<SQLHDESC>(input)); break;
        default: throw DriverError("HY092", "Invalid statement attribute.");
        }
        return SQL_SUCCESS;
    });
}
}
} // namespace hwdbodbc
extern "C" SQLRETURN SQL_API SQLSetStmtAttr(SQLHSTMT handle, SQLINTEGER attribute, SQLPOINTER input, SQLINTEGER) {
    return hwdbodbc::set_statement_attribute(handle, attribute, input);
}
extern "C" SQLRETURN SQL_API SQLSetStmtAttrW(SQLHSTMT handle, SQLINTEGER attribute, SQLPOINTER input, SQLINTEGER length) {
    return SQLSetStmtAttr(handle, attribute, input, length);
}
