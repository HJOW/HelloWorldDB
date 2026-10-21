#include "hwdbodbc/statement.hpp"
#include "hwdbodbc/parameters.hpp"
#include "hwdbodbc/sql_text.hpp"

namespace hwdbodbc {
Connection& statement_connection(Statement& statement) {
    auto& connection = static_cast<Connection&>(*statement.parent);
    if (!connection.connected || !connection.session) throw DriverError("08003", "Connection is not open.");
    if (connection.session->dead()) throw DriverError("08S01", "Connection is no longer usable.", 8006);
    return connection;
}
void close_statement_cursor(Statement& statement) {
    if (statement.cursor && statement.parent) {
        auto& connection = static_cast<Connection&>(*statement.parent);
        if (connection.connected && connection.session && !connection.session->dead())
            connection.session->request({{"type", "closeCursor"}, {"cursor", statement.cursor}}, "cursorClosed", connection.connection_timeout);
    }
    statement.cursor = 0; statement.has_more = false; statement.cursor_open = false; statement.current_row = false;
    statement.rows = Json::array(); statement.next_row = 0; statement.row_number = 0;
    statement.streams.clear(); statement.last_get_column = 0;
}
void release_prepared(Statement& statement) {
    if (statement.prepared && statement.parent) {
        auto& connection = static_cast<Connection&>(*statement.parent);
        if (connection.connected && connection.session && !connection.session->dead())
            connection.session->request({{"type", "closePrepared"}, {"statement", statement.prepared}}, "preparedClosed", connection.connection_timeout);
    }
    statement.prepared = 0; statement.parameter_metadata.clear(); statement.parameter_metadata_dirty = false;
}
void release_statement(Statement& statement) { close_statement_cursor(statement); release_prepared(statement); }
namespace {
Json parameter_hints(const Statement& statement, std::size_t count) {
    Json hints = Json::array();
    const auto& application = statement.descriptors[1]->records;
    const auto& implementation = statement.descriptors[3]->records;
    for (std::size_t i = 0; i < count; ++i) {
        if (i < application.size() && application[i].bound && i < implementation.size()) {
            const auto& binding = implementation[i].metadata;
            if (i < statement.parameter_metadata.size() && binding.sql_type == SQL_WVARCHAR
                && statement.parameter_metadata[i].type_name.find("WITH TIME ZONE") != std::string::npos)
                hints.push_back(statement.parameter_metadata[i].declared);
            else hints.push_back(binding.declared);
        }
        else hints.push_back(nullptr);
    }
    return hints;
}
void prepared_metadata(Statement& statement, const Json& response) {
    const auto count = integer_field(response, "parameterCount");
    if (count > static_cast<std::uint64_t>((std::numeric_limits<SQLSMALLINT>::max)())
        || response["columns"].size() > static_cast<std::size_t>((std::numeric_limits<SQLSMALLINT>::max)()))
        throw DriverError("HYC00", "Prepared metadata exceeds the ODBC SQLSMALLINT range.");
    std::vector<SqlType> parameters; std::vector<DescriptorRecord> columns;
    for (const auto& item : response["parameters"]) parameters.push_back(sql_type(item));
    for (const auto& item : response["columns"]) {
        DescriptorRecord record; record.metadata = sql_type(item); record.type = record.metadata.sql_type; columns.push_back(std::move(record));
    }
    statement.parameter_metadata = std::move(parameters); statement.descriptors[2]->records = std::move(columns);
    statement.parameter_metadata_dirty = false;
}
}
void prepare_statement(Statement& statement, const std::string& sql) {
    auto& connection = statement_connection(statement);
    if (statement.cursor_open) throw DriverError("24000", "Close the current cursor before preparing another statement.");
    if (!connection.session->capabilities.count("prepareDescribe")) throw DriverError("HYC00", "The server does not support prepare/describe.");
    const auto count = parameter_count(sql);
    if (count > static_cast<std::size_t>((std::numeric_limits<SQLSMALLINT>::max)())) throw DriverError("HYC00", "Parameter count exceeds the ODBC SQLSMALLINT range.");
    release_prepared(statement); statement.executed = false; statement.row_count = 0; statement.descriptors[2]->records.clear();
    statement.diagnostic.row_count = 0; statement.diagnostic.cursor_row_count = 0;
    const auto response = connection.session->request({{"type", "prepare"}, {"sql", sql}}, "prepared", connection.connection_timeout);
    statement.prepared = integer_field(response, "statement");
    try {
        if (integer_field(response, "parameterCount") != count) { connection.session->abort(); throw DriverError("08S01", "Prepared parameter count does not match SQL markers.", 8000); }
        prepared_metadata(statement, response);
        const auto& application = statement.descriptors[1]->records;
        if (std::any_of(application.begin(), application.begin() + (std::min)(count, application.size()), [](const auto& record) { return record.bound; })) {
            statement.parameter_metadata_dirty = true; describe_prepared(statement);
        }
    } catch (...) {
        const auto failure = std::current_exception();
        try { release_prepared(statement); } catch (...) { connection.session->abort(); }
        std::rethrow_exception(failure);
    }
}
void describe_prepared(Statement& statement) {
    if (!statement.prepared) throw DriverError("HY010", "No statement has been prepared.");
    auto& connection = statement_connection(statement);
    const auto response = connection.session->request({{"type", "describe"}, {"statement", statement.prepared},
        {"parameterTypes", parameter_hints(statement, statement.parameter_metadata.size())}}, "description", connection.connection_timeout);
    if (integer_field(response, "statement") != statement.prepared || integer_field(response, "parameterCount") != statement.parameter_metadata.size()) {
        connection.session->abort(); throw DriverError("08S01", "Prepared metadata identity changed unexpectedly.", 8000);
    }
    prepared_metadata(statement, response);
}
SQLRETURN execute_prepared(Statement& statement) {
    auto& connection = statement_connection(statement);
    if (!statement.prepared) throw DriverError("HY010", "No statement has been prepared.");
    if (statement.cursor_open) throw DriverError("24000", "Close the current cursor before executing another statement.");
    statement.executed = false; statement.row_count = 0;
    statement.diagnostic.row_count = 0; statement.diagnostic.cursor_row_count = 0;
    auto& apd = *statement.descriptors[1]; auto& ipd = *statement.descriptors[3];
    if (apd.array_size != 1) throw DriverError("HYC00", "Parameter arrays are not implemented yet.");
    if (ipd.rows_processed) *ipd.rows_processed = 0;
    if (ipd.array_status) ipd.array_status[0] = SQL_PARAM_UNUSED;
    Json parameters = Json::array();
    for (std::size_t i = 0; i < statement.parameter_metadata.size(); ++i) {
        if (i >= apd.records.size() || !apd.records[i].bound || i >= ipd.records.size()) throw DriverError("07002", "A parameter marker has no bound value.");
        try { parameters.push_back(parameter_value(apd.records[i], ipd.records[i].metadata, statement.diagnostic,
            apd.bind_offset ? *apd.bind_offset : 0, static_cast<SQLINTEGER>(i + 1))); }
        catch (const DriverError& error) {
            if (ipd.array_status) ipd.array_status[0] = SQL_PARAM_ERROR;
            statement.diagnostic.append(error.state, error.what(), error.native, 1, static_cast<SQLINTEGER>(i + 1)); return SQL_ERROR;
        }
    }
    if (statement.parameter_metadata_dirty) describe_prepared(statement);
    statement.executed = false; statement.row_count = 0;
    const auto response = connection.session->request({{"type", "executePrepared"}, {"statement", statement.prepared}, {"params", parameters}, {"fetchSize", connection.fetch_size}}, "result", connection.connection_timeout);
    accept_result(statement, response);
    const bool warning = statement.diagnostic.size() != 0;
    if (ipd.rows_processed) *ipd.rows_processed = 1;
    if (ipd.array_status) ipd.array_status[0] = warning ? SQL_PARAM_SUCCESS_WITH_INFO : SQL_PARAM_SUCCESS;
    return warning ? SQL_SUCCESS_WITH_INFO : SQL_SUCCESS;
}
void finish_statement_result(Statement& statement) {
    close_statement_cursor(statement);
    statement.executed = false; statement.row_count = 0;
    statement.diagnostic.row_count = 0; statement.diagnostic.cursor_row_count = 0;
    if (!statement.prepared) statement.descriptors[2]->records.clear();
}
void accept_result(Statement& statement, const Json& response) {
    const auto kind = string_field(response, "type");
    auto& implementation = *statement.descriptors[2];
    implementation.records.clear();
    statement.rows = Json::array(); statement.next_row = 0;
    statement.row_number = 0; statement.current_row = false; statement.streams.clear(); statement.last_get_column = 0;
    statement.cursor = 0; statement.has_more = false;
    if (kind == "rows") {
        if (!response.contains("columns")) throw DriverError("08S01", "Initial result metadata is missing.", 8000);
        statement.has_more = response["hasMore"].get<bool>();
        if (statement.has_more) statement.cursor = integer_field(response, "cursor");
        statement.cursor_open = true;
        if (response["columns"].size() > static_cast<std::size_t>((std::numeric_limits<SQLSMALLINT>::max)()))
            throw DriverError("HYC00", "Result column count exceeds the ODBC SQLSMALLINT range.");
        for (const auto& column : response["columns"]) {
            DescriptorRecord record;
            record.metadata = sql_type(column); record.type = record.metadata.sql_type;
            implementation.records.push_back(std::move(record));
        }
        statement.rows = response["rows"];
        statement.row_count = -1;
    } else {
        statement.cursor_open = false;
        const auto count = response.contains("rowCount") ? integer_field(response, "rowCount") : 0;
        if (count > static_cast<std::uint64_t>((std::numeric_limits<SQLLEN>::max)()))
            throw DriverError("22003", "Affected row count exceeds SQLLEN range.");
        statement.row_count = static_cast<SQLLEN>(count);
    }
    statement.executed = true;
    statement.diagnostic.row_count = statement.row_count;
    statement.diagnostic.cursor_row_count = -1;
}
SQLRETURN fetch_rows(Statement& statement) {
    auto& connection = statement_connection(statement);
    if (!statement.cursor_open) throw DriverError("24000", "No result set is open.");
    auto& application = *statement.descriptors[0];
    auto& implementation = *statement.descriptors[2];
    if (application.array_size != 1) throw DriverError("HYC00", "Row arrays are not implemented yet.");
    if (implementation.rows_processed) *implementation.rows_processed = 0;
    if (implementation.array_status) implementation.array_status[0] = SQL_ROW_NOROW;
    statement.current_row = false; statement.streams.clear(); statement.last_get_column = 0;
    if (statement.max_rows && statement.row_number >= statement.max_rows) {
        // 결과 한도에 도달하면 서버 자원을 닫되 ODBC 커서 상태는 끝 상태로 유지한다.
        const auto row_number = statement.row_number;
        close_statement_cursor(statement); statement.cursor_open = true; statement.row_number = row_number;
        return SQL_NO_DATA;
    }
    if (statement.next_row == statement.rows.size() && statement.has_more) {
        const auto response = connection.session->request({{"type", "fetch"}, {"cursor", statement.cursor}, {"fetchSize", connection.fetch_size}}, "rows", connection.connection_timeout);
        statement.rows = response["rows"]; statement.next_row = 0;
        statement.has_more = response["hasMore"].get<bool>();
        statement.cursor = statement.has_more ? integer_field(response, "cursor") : 0;
    }
    if (statement.next_row == statement.rows.size()) return SQL_NO_DATA;
    const auto& row = statement.rows[statement.next_row++];
    if (row.size() != implementation.records.size()) { connection.session->abort(); throw DriverError("08S01", "Result row width does not match metadata.", 8000); }
    ++statement.row_number; statement.current_row = true;
    statement.streams.resize(row.size());
    if (implementation.rows_processed) *implementation.rows_processed = 1;
    bool warning = false, error = false;
    if (statement.retrieve_data == SQL_RD_ON) {
        for (std::size_t column = 0; column < application.records.size(); ++column) {
            auto& record = application.records[column];
            if (!record.data) continue;
            if (column >= row.size()) {
                statement.diagnostic.append("07009", "Bound column is outside the result set.", 0, 1, static_cast<SQLINTEGER>(column + 1));
                error = true; continue;
            }
            const auto offset = application.bind_offset ? *application.bind_offset : 0;
            const auto shifted = [offset](auto pointer) {
                using Type = decltype(pointer);
                if (!pointer) return Type(nullptr);
                const auto address = reinterpret_cast<std::uintptr_t>(pointer);
                if (offset > (std::numeric_limits<std::uintptr_t>::max)() - address) throw DriverError("HY090", "Binding address overflow.");
                return reinterpret_cast<Type>(address + offset);
            };
            try {
                const auto indicator = record.indicator ? shifted(record.indicator) : shifted(record.octet_length_pointer);
                const auto result = convert_value(row[column], implementation.records[column].metadata, record.type,
                    shifted(record.data), record.capacity, indicator, statement.diagnostic, nullptr, record.conversion, 1, static_cast<SQLINTEGER>(column + 1));
                warning = warning || result == SQL_SUCCESS_WITH_INFO;
            } catch (const DriverError& failure) {
                statement.diagnostic.append(failure.state, failure.what(), failure.native, 1, static_cast<SQLINTEGER>(column + 1)); error = true;
            }
        }
    }
    if (implementation.array_status) implementation.array_status[0] = error ? SQL_ROW_ERROR : warning ? SQL_ROW_SUCCESS_WITH_INFO : SQL_ROW_SUCCESS;
    return error ? SQL_ERROR : warning ? SQL_SUCCESS_WITH_INFO : SQL_SUCCESS;
}
} // namespace hwdbodbc
