#include "hwdbodbc/descriptor.hpp"
#include <cstring>

namespace hwdbodbc {
SQLRETURN fetch_rows(Statement& statement) {
    auto& connection = statement_connection(statement);
    if (!statement.cursor_open) throw DriverError("24000", "No result set is open.");
    auto& application = *statement.descriptors[0]; auto& implementation = *statement.descriptors[2];
    validate_array_address(implementation.array_status,application.array_size,sizeof(SQLUSMALLINT));
    if (implementation.rows_processed) *implementation.rows_processed = 0;
    if (implementation.array_status) std::fill_n(implementation.array_status,application.array_size,static_cast<SQLUSMALLINT>(SQL_ROW_NOROW));
    statement.current_row = false; statement.row_number = 0; statement.streams.clear(); statement.last_get_column = 0;
    const auto first_row = statement.fetched_total + 1;
    SQLULEN fetched = 0, successful = 0; bool warnings = false;
    for (; fetched < application.array_size; ++fetched) {
        if (statement.max_rows && statement.fetched_total >= statement.max_rows) {
            const auto total = statement.fetched_total;
            close_statement_cursor(statement); statement.cursor_open = true; statement.fetched_total = total; break;
        }
        while (statement.next_row == statement.rows.size() && statement.has_more) {
            const auto response = connection.session->request({{"type","fetch"},{"cursor",statement.cursor},{"fetchSize",connection.fetch_size}},"rows",connection.connection_timeout);
            statement.rows = response["rows"]; statement.next_row = 0; statement.has_more = response["hasMore"].get<bool>();
            statement.cursor = statement.has_more ? integer_field(response,"cursor") : 0;
            if (statement.rows.empty() && statement.has_more) { connection.session->abort(); throw DriverError("08S01","Server fetch made no progress.",8000); }
        }
        if (statement.next_row == statement.rows.size()) break;
        const auto& row = statement.rows[statement.next_row++];
        if (row.size() != implementation.records.size()) { connection.session->abort(); throw DriverError("08S01","Result row width does not match metadata.",8000); }
        ++statement.fetched_total;
        bool row_error = false, row_warning = false;
        if (statement.retrieve_data == SQL_RD_ON) {
            for (std::size_t column = 0; column < application.records.size(); ++column) {
                const auto& binding = application.records[column]; if (!binding.data) continue;
                try {
                    if (column >= row.size()) throw DriverError("07009","Bound column is outside the result set.");
                    const auto resolved = binding_record(application,binding,fetched,implementation.records[column].metadata.default_c);
                    SQLLEN length = 0;
                    auto* length_output = resolved.indicator || (!row[column].is_null() && resolved.octet_length_pointer) ? &length : nullptr;
                    const auto result = convert_value(row[column],implementation.records[column].metadata,resolved.type,resolved.data,resolved.capacity,
                        length_output,statement.diagnostic,nullptr,resolved.conversion,static_cast<SQLLEN>(fetched + 1),static_cast<SQLINTEGER>(column + 1));
                    if (resolved.indicator) {
                        const SQLLEN indicator = row[column].is_null() ? SQL_NULL_DATA : resolved.indicator == resolved.octet_length_pointer ? length : 0;
                        std::memcpy(resolved.indicator,&indicator,sizeof(indicator));
                    }
                    if (resolved.octet_length_pointer && !row[column].is_null()) std::memcpy(resolved.octet_length_pointer,&length,sizeof(length));
                    row_warning = row_warning || result == SQL_SUCCESS_WITH_INFO;
                } catch (const DriverError& error) {
                    statement.diagnostic.append(error.state,error.what(),error.native,static_cast<SQLLEN>(fetched + 1),static_cast<SQLINTEGER>(column + 1)); row_error = true;
                }
            }
        }
        if (!row_error) ++successful;
        warnings = warnings || row_error || row_warning;
        if (implementation.array_status) implementation.array_status[fetched] = row_error ? SQL_ROW_ERROR : row_warning ? SQL_ROW_SUCCESS_WITH_INFO : SQL_ROW_SUCCESS;
        if (implementation.rows_processed) *implementation.rows_processed = fetched + 1;
    }
    if (!fetched) return SQL_NO_DATA;
    statement.current_row = true; statement.row_number = first_row;
    if (application.array_size == 1) statement.streams.resize(implementation.records.size());
    return !successful ? SQL_ERROR : warnings ? SQL_SUCCESS_WITH_INFO : SQL_SUCCESS;
}
} // namespace hwdbodbc
