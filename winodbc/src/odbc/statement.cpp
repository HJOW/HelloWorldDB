#include "hwdbodbc/statement.hpp"
#include "hwdbodbc/parameters.hpp"
#include "hwdbodbc/sql_text.hpp"
#include "hwdbodbc/descriptor.hpp"

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
    statement.rows = Json::array(); statement.next_row = 0; statement.row_number = 0; statement.fetched_total = 0;
    statement.streams.clear(); statement.last_get_column = 0;
}
void release_prepared(Statement& statement) {
    if (statement.prepared && statement.parent) {
        auto& connection = static_cast<Connection&>(*statement.parent);
        if (connection.connected && connection.session && !connection.session->dead())
            connection.session->request({{"type", "closePrepared"}, {"statement", statement.prepared}}, "preparedClosed", connection.connection_timeout);
    }
    statement.prepared = 0; statement.prepared_rows = false; statement.parameter_metadata.clear(); statement.parameter_metadata_dirty = false;
}
void release_statement(Statement& statement) { statement.parameter_execution.reset(); close_statement_cursor(statement); release_prepared(statement); }
namespace {
Json parameter_hints(const Statement& statement, std::size_t count) {
    Json hints = Json::array();
    const auto& application = statement.descriptors[1]->records;
    const auto& implementation = statement.descriptors[3]->records;
    for (std::size_t i = 0; i < count; ++i) {
        if (i < application.size() && application[i].bound && i < implementation.size()) {
            const auto binding = descriptor_parameter_type(implementation[i]);
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
        DescriptorRecord record; descriptor_sql_metadata(record,sql_type(item)); columns.push_back(std::move(record));
    }
    statement.parameter_metadata = std::move(parameters); statement.descriptors[2]->records = std::move(columns);
    statement.prepared_rows = string_field(response,"resultKind") == "rows";
    statement.parameter_metadata_dirty = false;
    if (statement.auto_ipd && string_field(response,"type") == "prepared") {
        auto& ipd = statement.descriptors[3]->records; ipd.resize(statement.parameter_metadata.size());
        for (std::size_t i = 0; i < ipd.size(); ++i) descriptor_sql_metadata(ipd[i],statement.parameter_metadata[i]);
    }
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
    static_cast<void>(statement_connection(statement));
    if (!statement.prepared) throw DriverError("HY010", "No statement has been prepared.");
    if (statement.cursor_open) throw DriverError("24000", "Close the current cursor before executing another statement.");
    statement.executed = false; statement.row_count = 0;
    statement.diagnostic.row_count = 0; statement.diagnostic.cursor_row_count = 0;
    auto& apd = *statement.descriptors[1]; auto& ipd = *statement.descriptors[3];
    if (ipd.rows_processed) *ipd.rows_processed = 0;
    validate_array_address(ipd.array_status,apd.array_size,sizeof(SQLUSMALLINT));
    validate_array_address(apd.array_status,apd.array_size,sizeof(SQLUSMALLINT));
    if (ipd.array_status) std::fill_n(ipd.array_status,apd.array_size,static_cast<SQLUSMALLINT>(SQL_PARAM_UNUSED));
    if (statement.parameter_metadata_dirty) describe_prepared(statement);
    if (apd.array_size > 1 && statement.prepared_rows) throw DriverError("HYC00", "Result-producing parameter arrays are not supported.");
    statement.parameter_execution = std::make_unique<ParameterExecution>();
    return continue_parameters(statement);
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
    statement.row_number = 0; statement.fetched_total = 0; statement.current_row = false; statement.streams.clear(); statement.last_get_column = 0;
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
            descriptor_sql_metadata(record,sql_type(column));
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
} // namespace hwdbodbc
