#pragma once
#include "hwdbodbc/protocol.hpp"
#include "hwdbodbc/entry_point.hpp"

namespace hwdbodbc {
struct SqlType {
    std::string name;
    std::string declared;
    std::string type_name;
    SQLSMALLINT sql_type = SQL_UNKNOWN_TYPE;
    SQLSMALLINT default_c = SQL_C_CHAR;
    SQLULEN size = 0;
    SQLLEN octets = 0;
    SQLLEN display_size = 0;
    SQLSMALLINT scale = 0;
    SQLSMALLINT nullable = SQL_NULLABLE_UNKNOWN;
    SQLSMALLINT interval_code = 0;
    SQLINTEGER leading_precision = 2;
};
SqlType sql_type(const Json& metadata);
bool valid_c_type(SQLSMALLINT type);
std::size_t fixed_c_size(SQLSMALLINT type);
struct ConversionSpec {
    SQLSMALLINT precision = 38;
    SQLSMALLINT scale = 0;
    SQLINTEGER leading_precision = 2;
    SQLSMALLINT fractional_precision = 6;
};
struct DataStream {
    std::size_t offset = 0;
    bool done = false;
    SQLSMALLINT type = SQL_C_DEFAULT;
};
SQLRETURN convert_value(const Json& value, const SqlType& source, SQLSMALLINT type,
    SQLPOINTER output, SQLLEN capacity, SQLLEN* indicator, Diagnostic& diagnostic,
    DataStream* stream = nullptr, const ConversionSpec& spec = {}, SQLLEN row = SQL_ROW_NUMBER_UNKNOWN,
    SQLINTEGER column = SQL_COLUMN_NUMBER_UNKNOWN);
std::string numeric_text(const SQL_NUMERIC_STRUCT& numeric);
SQL_NUMERIC_STRUCT numeric_struct(std::string_view text, SQLSMALLINT precision, SQLSMALLINT scale, bool& truncated);
} // namespace hwdbodbc
