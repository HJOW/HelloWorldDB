#include "hwdbodbc/types.hpp"

namespace hwdbodbc {
SqlType sql_type(const Json& metadata) {
    SqlType type;
    type.name = string_field(metadata, "name");
    type.type_name = string_field(metadata, "typeName");
    type.declared = string_field(metadata, "declared");
    const auto& name = type.type_name;
    if (name == "CHAR" || name == "VARCHAR") {
        type.sql_type = name == "CHAR" ? SQL_WCHAR : SQL_WVARCHAR;
        type.default_c = SQL_C_WCHAR;
        type.size = static_cast<SQLULEN>(integer_field(metadata, "length", 65535));
        type.octets = static_cast<SQLLEN>(type.size * 4);
        type.display_size = static_cast<SQLLEN>(type.size);
    } else if (name == "BINARY" || name == "VARBINARY") {
        type.sql_type = name == "BINARY" ? SQL_BINARY : SQL_VARBINARY;
        type.default_c = SQL_C_BINARY;
        type.size = static_cast<SQLULEN>(integer_field(metadata, "length", 65535));
        type.octets = static_cast<SQLLEN>(type.size); type.display_size = type.octets * 2;
    } else if (name == "SMALLINT") {
        type.sql_type = SQL_SMALLINT; type.default_c = SQL_C_SSHORT; type.size = 5; type.octets = 2; type.display_size = 6;
    } else if (name == "INTEGER") {
        type.sql_type = SQL_INTEGER; type.default_c = SQL_C_SLONG; type.size = 10; type.octets = 4; type.display_size = 11;
    } else if (name == "BIGINT") {
        type.sql_type = SQL_BIGINT; type.default_c = SQL_C_SBIGINT; type.size = 19; type.octets = 8; type.display_size = 20;
    } else if (name == "DECIMAL" || name == "NUMERIC") {
        type.sql_type = name == "DECIMAL" ? SQL_DECIMAL : SQL_NUMERIC;
        type.size = static_cast<SQLULEN>(integer_field(metadata, "precision", 38));
        type.scale = static_cast<SQLSMALLINT>(integer_field(metadata, "scale", type.size));
        type.octets = sizeof(SQL_NUMERIC_STRUCT); type.display_size = static_cast<SQLLEN>(type.size) + 2;
    } else if (name == "REAL" || name == "DOUBLE PRECISION") {
        type.sql_type = name == "REAL" ? SQL_REAL : SQL_DOUBLE;
        type.default_c = name == "REAL" ? SQL_C_FLOAT : SQL_C_DOUBLE;
        type.size = name == "REAL" ? 7 : 15; type.octets = name == "REAL" ? 4 : 8; type.display_size = name == "REAL" ? 14 : 24;
    } else if (name == "BOOLEAN") {
        type.sql_type = SQL_BIT; type.default_c = SQL_C_BIT; type.size = 1; type.octets = 1; type.display_size = 1;
    } else if (name == "DATE") {
        type.sql_type = SQL_TYPE_DATE; type.default_c = SQL_C_TYPE_DATE; type.size = 10;
        type.octets = sizeof(SQL_DATE_STRUCT); type.display_size = 10;
    } else if (name.find("TIME") == 0) {
        const bool timestamp = name.find("TIMESTAMP") == 0;
        type.scale = static_cast<SQLSMALLINT>(integer_field(metadata, "fractionalPrecision", 6));
        type.size = (timestamp ? 19U : 8U) + (type.scale ? 1U + static_cast<unsigned>(type.scale) : 0U);
        if (name.find("WITH TIME ZONE") != std::string::npos) {
            type.sql_type = SQL_WVARCHAR; type.default_c = SQL_C_WCHAR; type.size += 6;
            type.octets = static_cast<SQLLEN>(type.size * 2);
        } else {
            type.sql_type = timestamp ? SQL_TYPE_TIMESTAMP : SQL_TYPE_TIME;
            type.default_c = timestamp ? SQL_C_TYPE_TIMESTAMP : SQL_C_TYPE_TIME;
            type.octets = timestamp ? sizeof(SQL_TIMESTAMP_STRUCT) : sizeof(SQL_TIME_STRUCT);
        }
        type.display_size = static_cast<SQLLEN>(type.size);
    } else if (name == "INTERVAL") {
        const auto start = string_field(metadata, "startField"), end = string_field(metadata, "endField");
        const std::pair<const char*, SQLSMALLINT> intervals[] = {
            {"YEAR YEAR", SQL_INTERVAL_YEAR}, {"MONTH MONTH", SQL_INTERVAL_MONTH}, {"DAY DAY", SQL_INTERVAL_DAY},
            {"HOUR HOUR", SQL_INTERVAL_HOUR}, {"MINUTE MINUTE", SQL_INTERVAL_MINUTE}, {"SECOND SECOND", SQL_INTERVAL_SECOND},
            {"YEAR MONTH", SQL_INTERVAL_YEAR_TO_MONTH}, {"DAY HOUR", SQL_INTERVAL_DAY_TO_HOUR}, {"DAY MINUTE", SQL_INTERVAL_DAY_TO_MINUTE},
            {"DAY SECOND", SQL_INTERVAL_DAY_TO_SECOND}, {"HOUR MINUTE", SQL_INTERVAL_HOUR_TO_MINUTE},
            {"HOUR SECOND", SQL_INTERVAL_HOUR_TO_SECOND}, {"MINUTE SECOND", SQL_INTERVAL_MINUTE_TO_SECOND} };
        for (const auto& interval : intervals) if (start + " " + end == interval.first) type.sql_type = interval.second;
        if (type.sql_type == SQL_UNKNOWN_TYPE) throw DriverError("08S01", "Invalid interval qualifier.", 8000);
        type.interval_code = static_cast<SQLSMALLINT>(type.sql_type - 100);
        type.default_c = type.sql_type;
        type.leading_precision = static_cast<SQLINTEGER>(integer_field(metadata, "leadingPrecision", 9));
        type.scale = metadata.contains("fractionalPrecision") ? static_cast<SQLSMALLINT>(integer_field(metadata, "fractionalPrecision", 6)) : 0;
        const std::map<std::string, unsigned> fields{{"YEAR",0},{"MONTH",1},{"DAY",2},{"HOUR",3},{"MINUTE",4},{"SECOND",5}};
        type.size = static_cast<SQLULEN>(type.leading_precision) + 3 * (fields.at(end) - fields.at(start))
            + (type.scale ? static_cast<SQLULEN>(type.scale + 1) : 0);
        type.octets = sizeof(SQL_INTERVAL_STRUCT); type.display_size = static_cast<SQLLEN>(type.size + 1);
    } else if (name != "UNKNOWN") throw DriverError("08S01", "Unknown SQL type in metadata.", 8000);
    if (metadata.contains("nullable")) {
        const auto nullable = string_field(metadata, "nullable");
        type.nullable = nullable == "YES" ? SQL_NULLABLE : nullable == "NO" ? SQL_NO_NULLS : SQL_NULLABLE_UNKNOWN;
    }
    return type;
}
bool valid_c_type(SQLSMALLINT type) {
    switch (type) {
    case SQL_C_DEFAULT: case SQL_C_CHAR: case SQL_C_WCHAR: case SQL_C_BINARY:
    case SQL_C_SHORT: case SQL_C_SSHORT: case SQL_C_USHORT: case SQL_C_LONG: case SQL_C_SLONG: case SQL_C_ULONG:
    case SQL_C_TINYINT: case SQL_C_STINYINT: case SQL_C_UTINYINT: case SQL_C_SBIGINT: case SQL_C_UBIGINT:
    case SQL_C_FLOAT: case SQL_C_DOUBLE: case SQL_C_BIT: case SQL_C_NUMERIC:
    case SQL_C_DATE: case SQL_C_TIME: case SQL_C_TIMESTAMP: case SQL_C_TYPE_DATE: case SQL_C_TYPE_TIME: case SQL_C_TYPE_TIMESTAMP:
    case SQL_C_INTERVAL_YEAR: case SQL_C_INTERVAL_MONTH: case SQL_C_INTERVAL_DAY: case SQL_C_INTERVAL_HOUR:
    case SQL_C_INTERVAL_MINUTE: case SQL_C_INTERVAL_SECOND: case SQL_C_INTERVAL_YEAR_TO_MONTH:
    case SQL_C_INTERVAL_DAY_TO_HOUR: case SQL_C_INTERVAL_DAY_TO_MINUTE: case SQL_C_INTERVAL_DAY_TO_SECOND:
    case SQL_C_INTERVAL_HOUR_TO_MINUTE: case SQL_C_INTERVAL_HOUR_TO_SECOND: case SQL_C_INTERVAL_MINUTE_TO_SECOND:
    case SQL_C_GUID: return true;
    default: return false;
    }
}
std::size_t fixed_c_size(SQLSMALLINT type) {
    switch (type) {
    case SQL_C_SHORT: case SQL_C_SSHORT: case SQL_C_USHORT: return 2;
    case SQL_C_LONG: case SQL_C_SLONG: case SQL_C_ULONG: case SQL_C_FLOAT: return 4;
    case SQL_C_TINYINT: case SQL_C_STINYINT: case SQL_C_UTINYINT: case SQL_C_BIT: return 1;
    case SQL_C_SBIGINT: case SQL_C_UBIGINT: case SQL_C_DOUBLE: return 8;
    case SQL_C_NUMERIC: return sizeof(SQL_NUMERIC_STRUCT);
    case SQL_C_DATE: case SQL_C_TYPE_DATE: return sizeof(SQL_DATE_STRUCT);
    case SQL_C_TIME: case SQL_C_TYPE_TIME: return sizeof(SQL_TIME_STRUCT);
    case SQL_C_TIMESTAMP: case SQL_C_TYPE_TIMESTAMP: return sizeof(SQL_TIMESTAMP_STRUCT);
    case SQL_C_GUID: return sizeof(SQLGUID);
    default: return type >= SQL_C_INTERVAL_YEAR && type <= SQL_C_INTERVAL_MINUTE_TO_SECOND ? sizeof(SQL_INTERVAL_STRUCT) : 0;
    }
}
} // namespace hwdbodbc
