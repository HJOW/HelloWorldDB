#include "hwdbodbc/statement.hpp"
#include "hwdbodbc/descriptor.hpp"
#include "hwdbodbc/parameters.hpp"
#include <cstring>

namespace hwdbodbc {
namespace {
constexpr std::size_t input_limit = 16U * 1024U * 1024U;
SQLLEN length_at(const DescriptorRecord& record) {
    SQLLEN length = SQL_NTS;
    // 분리 indicator의 DATA_AT_EXEC도 길이 필드보다 먼저 검사한다.
    if (record.indicator) {
        std::memcpy(&length,record.indicator,sizeof(length));
        if (length == SQL_NULL_DATA || length == SQL_DATA_AT_EXEC || length <= SQL_LEN_DATA_AT_EXEC_OFFSET) return length;
    }
    if (record.octet_length_pointer) std::memcpy(&length,record.octet_length_pointer,sizeof(length));
    return length;
}
bool streamed(SQLLEN length) { return length == SQL_DATA_AT_EXEC || length <= SQL_LEN_DATA_AT_EXEC_OFFSET; }
bool fatal_error(const DriverError& error, const Connection& connection) {
    return connection.session->dead() || error.state.substr(0,2) == "08" || error.state.substr(0,2) == "40"
        || error.state.substr(0,2) == "25" || error.state == "0A000" || error.state == "26000";
}
void fail_input(Statement& statement) {
    auto& execution = *statement.parameter_execution;
    auto& ipd = *statement.descriptors[3];
    if (ipd.array_status) ipd.array_status[execution.row] = SQL_PARAM_ERROR;
    if (ipd.rows_processed) *ipd.rows_processed = execution.row + 1;
    statement.row_count = execution.affected; statement.diagnostic.row_count = execution.affected;
    statement.parameter_execution.reset();
}
}
SQLRETURN continue_parameters(Statement& statement) {
    auto& connection = statement_connection(statement);
    auto& execution = *statement.parameter_execution;
    auto& apd = *statement.descriptors[1]; auto& ipd = *statement.descriptors[3];
    bool fatal = false;
    for (; execution.row < apd.array_size; ++execution.row) {
        SQLINTEGER column = SQL_COLUMN_NUMBER_UNKNOWN;
        try {
            if (apd.array_status && apd.array_status[execution.row] == SQL_PARAM_IGNORE) {
                if (ipd.rows_processed) *ipd.rows_processed = execution.row + 1;
                continue;
            }
            if (apd.array_status && apd.array_status[execution.row] != SQL_PARAM_PROCEED) throw DriverError("HY024", "Invalid parameter operation value.");
            if (ipd.rows_processed) *ipd.rows_processed = execution.row + 1;
            for (; execution.parameter < statement.parameter_metadata.size(); ++execution.parameter) {
                const auto i = execution.parameter; column = static_cast<SQLINTEGER>(i + 1);
                if (i >= apd.records.size() || !apd.records[i].bound || i >= ipd.records.size()) throw DriverError("07002", "A parameter marker has no bound value.");
                const auto target = descriptor_parameter_type(ipd.records[i]);
                const auto binding = binding_record(apd,apd.records[i],execution.row,target.default_c);
                const auto length = length_at(binding);
                if (streamed(length)) {
                    execution.pending = true; execution.requested = false; execution.supplied = false; execution.null_value = false;
                    execution.binding = binding; execution.target = target; execution.input.clear();
                    execution.expected = length == SQL_DATA_AT_EXEC ? -1 : -(length - SQL_LEN_DATA_AT_EXEC_OFFSET);
                    if (execution.expected > static_cast<SQLLEN>(input_limit - execution.bytes)) throw DriverError("22001", "Announced parameter data exceeds the message size limit.");
                    execution.diagnostic = statement.diagnostic;
                    return SQL_NEED_DATA;
                }
                const auto previous = statement.diagnostic.size();
                execution.parameters.push_back(parameter_value(binding,target,statement.diagnostic,0,column,static_cast<SQLLEN>(execution.row + 1)));
                execution.row_warning = execution.row_warning || statement.diagnostic.size() != previous;
            }
            column = SQL_COLUMN_NUMBER_UNKNOWN;
            Json request{{"type","executePrepared"},{"statement",statement.prepared},{"params",execution.parameters},{"fetchSize",connection.fetch_size}};
            // JSON의 escape와 binary 16진 인코딩까지 포함해 실제 wire 크기를 제한한다.
            if (request.dump().size() > input_limit - 64) throw DriverError("22001", "Encoded parameters exceed the message size limit.");
            const auto response = connection.session->request(std::move(request),"result",connection.connection_timeout);
            if (apd.array_size > 1 && string_field(response,"type") != "ok") { connection.session->abort(); throw DriverError("08S01","Parameter array response kind does not match prepared metadata.",8000); }
            accept_result(statement,response);
            if (statement.row_count >= 0) {
                if (statement.row_count > (std::numeric_limits<SQLLEN>::max)() - execution.affected) throw DriverError("22003", "Aggregated affected row count exceeds SQLLEN range.");
                execution.affected += statement.row_count;
            }
            execution.warnings = execution.warnings || execution.row_warning; ++execution.successful;
            if (ipd.array_status) ipd.array_status[execution.row] = execution.row_warning ? SQL_PARAM_SUCCESS_WITH_INFO : SQL_PARAM_SUCCESS;
        } catch (const DriverError& error) {
            statement.diagnostic.append(error.state,error.what(),error.native,static_cast<SQLLEN>(execution.row + 1),column);
            execution.failed = true; if (ipd.array_status) ipd.array_status[execution.row] = SQL_PARAM_ERROR;
            fatal = fatal_error(error,connection);
        }
        execution.parameters = Json::array(); execution.parameter = 0; execution.bytes = 0; execution.pending = false; execution.row_warning = false;
        if (fatal) break;
    }
    if (apd.array_size > 1 || !statement.cursor_open) {
        statement.row_count = execution.affected; statement.diagnostic.row_count = execution.affected;
        statement.executed = execution.successful != 0 || !execution.failed;
    }
    const SQLRETURN result = fatal || (execution.failed && !execution.successful) ? SQL_ERROR : execution.failed || execution.warnings ? SQL_SUCCESS_WITH_INFO : SQL_SUCCESS;
    statement.parameter_execution.reset(); return result;
}
SQLRETURN parameter_data(Statement& statement, SQLPOINTER* token) {
    if (!statement.parameter_execution || !statement.parameter_execution->pending) throw DriverError("HY010", "No parameter data is requested.");
    if (!token) throw DriverError("HY009", "Parameter token output is null.");
    auto& execution = *statement.parameter_execution;
    statement.diagnostic = execution.diagnostic;
    if (execution.requested) {
        if (!execution.supplied) throw DriverError("HY010", "Supply parameter data before advancing to the next parameter.");
        try {
            if (!execution.null_value && execution.expected >= 0 && static_cast<std::size_t>(execution.expected) != execution.input.size())
                throw DriverError("22026", "Parameter data length does not match the announced length.");
            auto binding = execution.binding;
            SQLLEN length = execution.null_value ? SQL_NULL_DATA : static_cast<SQLLEN>(execution.input.size());
            unsigned char empty = 0;
            binding.data = execution.input.empty() ? &empty : execution.input.data();
            binding.capacity = length < 0 ? 0 : length; binding.indicator = &length; binding.octet_length_pointer = &length;
            const auto previous = statement.diagnostic.size();
            execution.parameters.push_back(parameter_value(binding,execution.target,statement.diagnostic,0,
                static_cast<SQLINTEGER>(execution.parameter + 1),static_cast<SQLLEN>(execution.row + 1)));
            execution.row_warning = execution.row_warning || statement.diagnostic.size() != previous;
            execution.bytes += execution.input.size(); execution.input.clear(); execution.pending = false; ++execution.parameter;
        } catch (...) { fail_input(statement); throw; }
        const auto result = continue_parameters(statement);
        if (result != SQL_NEED_DATA) return result;
    }
    execution.requested = true; *token = execution.binding.data; return SQL_NEED_DATA;
}
SQLRETURN put_parameter_data(Statement& statement, SQLPOINTER data, SQLLEN length) {
    if (!statement.parameter_execution || !statement.parameter_execution->requested) throw DriverError("HY010", "Call SQLParamData before SQLPutData.");
    auto& execution = *statement.parameter_execution;
    const auto type = execution.binding.type == SQL_C_DEFAULT ? execution.target.default_c : execution.binding.type;
    if (length == SQL_DEFAULT_PARAM) throw DriverError("07S01", "Default parameter values are not supported.");
    if (execution.supplied && (execution.null_value || length == SQL_NULL_DATA)) throw DriverError("HY020", "A null parameter cannot be concatenated.");
    if (length == SQL_NULL_DATA) { execution.null_value = true; execution.supplied = true; return SQL_SUCCESS; }
    const bool variable = type == SQL_C_CHAR || type == SQL_C_WCHAR || type == SQL_C_BINARY;
    const bool multiple = variable && (execution.target.sql_type == SQL_WCHAR || execution.target.sql_type == SQL_WVARCHAR
        || execution.target.sql_type == SQL_BINARY || execution.target.sql_type == SQL_VARBINARY);
    if (execution.supplied && !multiple) throw DriverError("HY019", "This conversion cannot receive data in pieces.");
    if (length < 0 && length != SQL_NTS) throw DriverError("HY090", "Invalid parameter data length.");
    std::size_t bytes = 0;
    if (!variable) bytes = fixed_c_size(type);
    else if (length == SQL_NTS) {
        if (type == SQL_C_BINARY) throw DriverError("HY090", "Binary data requires an explicit byte length.");
        if (!data) throw DriverError("HY009", "Parameter data pointer is null.");
        const auto width = type == SQL_C_WCHAR ? 2U : 1U;
        for (; bytes < input_limit; bytes += width) {
            unsigned short unit = 0; std::memcpy(&unit,static_cast<const char*>(data) + bytes,width); if (!unit) break;
        }
        if (bytes == input_limit) throw DriverError("22001", "Parameter data exceeds the message size limit.");
    } else bytes = static_cast<std::size_t>(length);
    if (bytes && !data) throw DriverError("HY009", "Parameter data pointer is null.");
    if (type == SQL_C_WCHAR && bytes % 2) throw DriverError("HY090", "Wide parameter data length must be even.");
    if (bytes > input_limit - execution.bytes - execution.input.size()) throw DriverError("22001", "Parameter data exceeds the message size limit.");
    const auto total = execution.input.size() + bytes;
    if (execution.expected >= 0 && total > static_cast<std::size_t>(execution.expected)) throw DriverError("22001", "Parameter data exceeds the announced length.");
    const auto target_type = execution.target.sql_type;
    if ((target_type == SQL_BINARY || target_type == SQL_VARBINARY) && type == SQL_C_BINARY && total > execution.target.size)
        throw DriverError("22001", "Binary parameter exceeds the declared length.");
    if ((target_type == SQL_WCHAR || target_type == SQL_WVARCHAR) && (type == SQL_C_CHAR || type == SQL_C_WCHAR) && total > execution.target.size * 4)
        throw DriverError("22001", "Character parameter exceeds the declared length.");
    validate_array_address(data,bytes,1);
    if (bytes) execution.input.insert(execution.input.end(),static_cast<const unsigned char*>(data),static_cast<const unsigned char*>(data) + bytes);
    execution.supplied = true; return SQL_SUCCESS;
}
} // namespace hwdbodbc

using namespace hwdbodbc;
extern "C" SQLRETURN SQL_API SQLParamData(SQLHSTMT handle, SQLPOINTER* token) {
    return with_handle<Statement>(SQL_HANDLE_STMT,handle,true,[&](Statement& statement) { return parameter_data(statement,token); },true);
}
extern "C" SQLRETURN SQL_API SQLPutData(SQLHSTMT handle, SQLPOINTER data, SQLLEN length) {
    return with_handle<Statement>(SQL_HANDLE_STMT,handle,true,[&](Statement& statement) { return put_parameter_data(statement,data,length); },true);
}
extern "C" SQLRETURN SQL_API SQLCancel(SQLHSTMT handle) {
    return with_handle<Statement>(SQL_HANDLE_STMT,handle,false,[](Statement& statement) -> SQLRETURN {
        statement.parameter_execution.reset(); return SQL_SUCCESS;
    },true);
}
