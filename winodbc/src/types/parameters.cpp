#include "hwdbodbc/parameters.hpp"
#include <charconv>
#include <cmath>
#include <cstring>
#include <iomanip>
#include <locale>
#include <sstream>

namespace hwdbodbc {
namespace {
constexpr std::size_t input_limit = 16U * 1024U * 1024U;
template<class T> T read(SQLPOINTER pointer) {
    T value{}; std::memcpy(&value, pointer, sizeof(value)); return value;
}
template<class T> T* shifted(T* pointer, SQLULEN offset) {
    if (!pointer) return nullptr;
    const auto address = reinterpret_cast<std::uintptr_t>(pointer);
    if (offset > (std::numeric_limits<std::uintptr_t>::max)() - address) throw DriverError("HY090", "Parameter binding address overflow.");
    return reinterpret_cast<T*>(address + offset);
}
std::string hex(const unsigned char* bytes, std::size_t size) {
    const char digits[] = "0123456789ABCDEF";
    std::string text; text.reserve(size * 2);
    for (std::size_t i = 0; i < size; ++i) { text += digits[bytes[i] >> 4]; text += digits[bytes[i] & 15]; }
    return text;
}
std::ostringstream formatter() { std::ostringstream output; output.imbue(std::locale::classic()); output << std::setfill('0'); return output; }
std::string date_text(const SQL_DATE_STRUCT& value) {
    auto text = formatter(); text << std::setw(4) << value.year << '-' << std::setw(2) << value.month << '-' << std::setw(2) << value.day; return text.str();
}
std::string time_text(SQLUSMALLINT hour, SQLUSMALLINT minute, SQLUSMALLINT second, SQLUINTEGER fraction, unsigned precision) {
    if (fraction > 999999999) throw DriverError("22007", "Invalid timestamp fraction.");
    auto text = formatter(); text << std::setw(2) << hour << ':' << std::setw(2) << minute << ':' << std::setw(2) << second;
    if (precision) { auto digits = formatter(); digits << std::setw(9) << fraction; text << '.' << digits.str().substr(0, precision); }
    return text.str();
}
std::string interval_text(const SQL_INTERVAL_STRUCT& value, SQLSMALLINT type) {
    if (value.interval_type != type - 100 || (value.interval_sign != SQL_FALSE && value.interval_sign != SQL_TRUE))
        throw DriverError("22015", "Invalid interval type or sign.");
    const std::pair<int,int> ranges[] = {{0,0},{1,1},{2,2},{3,3},{4,4},{5,5},{0,1},{2,3},{2,4},{2,5},{3,4},{3,5},{4,5}};
    const auto range = ranges[type - SQL_C_INTERVAL_YEAR];
    SQLUINTEGER fields[6]{};
    if (range.first < 2) { fields[0] = value.intval.year_month.year; fields[1] = value.intval.year_month.month; }
    else { const auto& ds = value.intval.day_second; fields[2] = ds.day; fields[3] = ds.hour; fields[4] = ds.minute; fields[5] = ds.second; }
    auto text = formatter(); if (value.interval_sign) text << '-';
    for (int field = range.first; field <= range.second; ++field) {
        if (field != range.first) text << (field == 1 ? '-' : field == 3 ? ' ' : ':');
        text << fields[field];
    }
    if (range.second == 5 && value.intval.day_second.fraction) {
        const auto fraction_value = value.intval.day_second.fraction;
        if (fraction_value > 999999999) throw DriverError("22015", "Invalid interval fraction.");
        auto digits = formatter(); digits << std::setw(9) << fraction_value;
        auto fraction = digits.str(); while (fraction.back() == '0') fraction.pop_back();
        text << '.' << fraction;
    }
    return text.str();
}
struct Input { Json value; SqlType source; };
Input input_value(SQLSMALLINT type, SQLPOINTER data, SQLLEN length, SQLLEN capacity) {
    Input input; input.source.sql_type = SQL_WVARCHAR;
    switch (type) {
    case SQL_C_CHAR: case SQL_C_WCHAR: case SQL_C_BINARY: {
        std::size_t bytes = 0;
        if (type == SQL_C_BINARY) {
            if (length == SQL_NTS) throw DriverError("HY090", "Binary parameters require an explicit byte length.");
            bytes = static_cast<std::size_t>(length);
        } else if (length == SQL_NTS) {
            if (type == SQL_C_CHAR) {
                const auto text = static_cast<const char*>(data);
                while (bytes < input_limit && text[bytes]) ++bytes;
                if (bytes == input_limit) throw DriverError("22001", "Parameter exceeds the message size limit.");
            } else {
                SQLWCHAR unit = 0;
                while (bytes < input_limit) { std::memcpy(&unit, static_cast<const char*>(data) + bytes, 2); if (!unit) break; bytes += 2; }
                if (bytes == input_limit) throw DriverError("22001", "Parameter exceeds the message size limit.");
            }
        } else bytes = static_cast<std::size_t>(length);
        static_cast<void>(capacity);
        if (bytes > input_limit) throw DriverError("22001", "Parameter exceeds the message size limit.");
        if (type == SQL_C_BINARY) { input.value = hex(static_cast<const unsigned char*>(data), bytes); input.source.sql_type = SQL_VARBINARY; }
        else if (type == SQL_C_CHAR) input.value = utf8(decode_ansi(std::string_view(static_cast<const char*>(data), bytes)));
        else {
            if (bytes % 2) throw DriverError("HY090", "Wide parameter length must be even.");
            std::wstring text(bytes / 2, L'\0'); if (bytes) std::memcpy(text.data(), data, bytes); input.value = utf8(text);
        }
        break;
    }
    case SQL_C_SHORT: case SQL_C_SSHORT: input.value = std::to_string(read<SQLSMALLINT>(data)); break;
    case SQL_C_USHORT: input.value = std::to_string(read<SQLUSMALLINT>(data)); break;
    case SQL_C_LONG: case SQL_C_SLONG: input.value = std::to_string(read<SQLINTEGER>(data)); break;
    case SQL_C_ULONG: input.value = std::to_string(read<SQLUINTEGER>(data)); break;
    case SQL_C_TINYINT: case SQL_C_STINYINT: input.value = std::to_string(read<signed char>(data)); break;
    case SQL_C_UTINYINT: input.value = std::to_string(read<unsigned char>(data)); break;
    case SQL_C_SBIGINT: input.value = std::to_string(read<SQLBIGINT>(data)); break;
    case SQL_C_UBIGINT: input.value = std::to_string(read<SQLUBIGINT>(data)); break;
    case SQL_C_BIT: {
        const auto bit = read<unsigned char>(data); if (bit > 1) throw DriverError("22003", "Bit value out of range."); input.value = std::to_string(bit); break;
    }
    case SQL_C_FLOAT: case SQL_C_DOUBLE: {
        const double value = type == SQL_C_FLOAT ? static_cast<double>(read<float>(data)) : read<double>(data);
        if (!std::isfinite(value)) throw DriverError("22003", "Floating point value out of range.");
        char text[64]{}; const auto result = std::to_chars(text, text + sizeof(text), value);
        if (result.ec != std::errc()) throw DriverError("22003", "Floating point conversion failed.");
        input.value = std::string(text, result.ptr); break;
    }
    case SQL_C_NUMERIC: input.value = numeric_text(read<SQL_NUMERIC_STRUCT>(data)); break;
    case SQL_C_DATE: case SQL_C_TYPE_DATE:
        input.value = date_text(read<SQL_DATE_STRUCT>(data)); input.source.sql_type = SQL_TYPE_DATE; break;
    case SQL_C_TIME: case SQL_C_TYPE_TIME: {
        const auto value = read<SQL_TIME_STRUCT>(data); input.value = time_text(value.hour, value.minute, value.second, 0, 0); input.source.sql_type = SQL_TYPE_TIME; break;
    }
    case SQL_C_TIMESTAMP: case SQL_C_TYPE_TIMESTAMP: {
        const auto value = read<SQL_TIMESTAMP_STRUCT>(data);
        input.value = date_text({value.year, value.month, value.day}) + " " + time_text(value.hour, value.minute, value.second, value.fraction, 9);
        input.source.sql_type = SQL_TYPE_TIMESTAMP; break;
    }
    case SQL_C_GUID: {
        const auto value = read<SQLGUID>(data); auto text = formatter(); text << std::hex << std::setw(8) << value.Data1 << '-' << std::setw(4) << value.Data2 << '-' << std::setw(4) << value.Data3 << '-';
        for (int i = 0; i < 8; ++i) { if (i == 2) text << '-'; text << std::setw(2) << static_cast<unsigned>(value.Data4[i]); }
        input.value = text.str(); break;
    }
    default:
        if (type < SQL_C_INTERVAL_YEAR || type > SQL_C_INTERVAL_MINUTE_TO_SECOND) throw DriverError("HY003", "Invalid C parameter type.");
        input.source.sql_type = type; input.source.type_name = "INTERVAL"; input.source.interval_code = static_cast<SQLSMALLINT>(type - 100);
        input.value = interval_text(read<SQL_INTERVAL_STRUCT>(data), type);
    }
    return input;
}
}
SqlType parameter_type(SQLSMALLINT type, SQLULEN size, SQLSMALLINT scale, SQLINTEGER leading_precision) {
    Json metadata{{"name", "PARAM"}};
    std::string name, declared;
    switch (type) {
    case SQL_CHAR: case SQL_WCHAR: case SQL_VARCHAR: case SQL_WVARCHAR: case SQL_BINARY: case SQL_VARBINARY: {
        const bool fixed = type == SQL_CHAR || type == SQL_WCHAR || type == SQL_BINARY;
        const bool binary = type == SQL_BINARY || type == SQL_VARBINARY;
        if (!size) size = fixed ? 1 : 65535;
        if (size > (fixed ? 2000U : 65535U)) throw DriverError("HY104", "Parameter length is outside the supported range.");
        name = binary ? fixed ? "BINARY" : "VARBINARY" : fixed ? "CHAR" : "VARCHAR";
        declared = name + "(" + std::to_string(size) + ")"; metadata["length"] = size; break;
    }
    case SQL_SMALLINT: name = "SMALLINT"; break;
    case SQL_INTEGER: name = "INTEGER"; break;
    case SQL_BIGINT: name = "BIGINT"; break;
    case SQL_BIT: name = "BOOLEAN"; break;
    case SQL_NUMERIC: case SQL_DECIMAL:
        if (size < 1 || size > 38 || scale < 0 || static_cast<SQLULEN>(scale) > size) throw DriverError("HY104", "Invalid numeric parameter precision or scale.");
        name = type == SQL_NUMERIC ? "NUMERIC" : "DECIMAL";
        declared = name + "(" + std::to_string(size) + "," + std::to_string(scale) + ")";
        metadata["precision"] = size; metadata["scale"] = scale; break;
    case SQL_REAL: name = "REAL"; break;
    case SQL_FLOAT: case SQL_DOUBLE: name = "DOUBLE PRECISION"; break;
    case SQL_DATE: case SQL_TYPE_DATE: name = "DATE"; break;
    case SQL_TIME: case SQL_TYPE_TIME: case SQL_TIMESTAMP: case SQL_TYPE_TIMESTAMP:
        if (scale < 0 || scale > 6) throw DriverError("HY104", "Datetime parameter precision must be between zero and six.");
        name = type == SQL_TIME || type == SQL_TYPE_TIME ? "TIME" : "TIMESTAMP";
        declared = name + "(" + std::to_string(scale) + ")"; metadata["fractionalPrecision"] = scale; break;
    case SQL_LONGVARCHAR: case SQL_WLONGVARCHAR: case SQL_LONGVARBINARY: case SQL_TINYINT: case SQL_GUID:
        throw DriverError("HYC00", "SQL parameter type is not supported by the server.");
    default: {
        if (type < SQL_INTERVAL_YEAR || type > SQL_INTERVAL_MINUTE_TO_SECOND) throw DriverError("HY004", "Invalid SQL parameter type.");
        const std::pair<const char*,const char*> fields[] = {{"YEAR","YEAR"},{"MONTH","MONTH"},{"DAY","DAY"},{"HOUR","HOUR"},{"MINUTE","MINUTE"},{"SECOND","SECOND"},
            {"YEAR","MONTH"},{"DAY","HOUR"},{"DAY","MINUTE"},{"DAY","SECOND"},{"HOUR","MINUTE"},{"HOUR","SECOND"},{"MINUTE","SECOND"}};
        const auto pair = fields[type - SQL_INTERVAL_YEAR];
        if (scale < 0 || scale > 6) throw DriverError("HY104", "Invalid interval fractional precision.");
        if (leading_precision < 1 || leading_precision > 9) throw DriverError("HY104", "Invalid interval leading precision.");
        name = "INTERVAL"; metadata["startField"] = pair.first; metadata["endField"] = pair.second; metadata["leadingPrecision"] = leading_precision;
        const bool seconds = std::string(pair.second) == "SECOND";
        if (seconds) metadata["fractionalPrecision"] = scale;
        declared = "INTERVAL " + std::string(pair.first) + "(" + std::to_string(leading_precision)
            + (std::string(pair.first) == "SECOND" ? "," + std::to_string(scale) + ")" : ")");
        if (std::string(pair.first) != pair.second) declared += " TO " + std::string(pair.second) + (seconds ? "(" + std::to_string(scale) + ")" : "");
    }
    }
    metadata["typeName"] = name; metadata["declared"] = declared.empty() ? name : declared;
    auto result = sql_type(metadata);
    if (type == SQL_CHAR || type == SQL_VARCHAR) result.default_c = SQL_C_CHAR;
    return result;
}
Json parameter_value(const DescriptorRecord& application, const SqlType& target, Diagnostic& diagnostic, SQLULEN offset, SQLINTEGER number, SQLLEN row) {
    const auto ctype = application.type == SQL_C_DEFAULT ? target.default_c : application.type;
    const auto indicator = shifted(application.indicator, offset);
    const auto length_pointer = shifted(application.octet_length_pointer,offset);
    if (indicator && read<SQLLEN>(indicator) == SQL_NULL_DATA) return nullptr;
    SQLLEN length = length_pointer ? read<SQLLEN>(length_pointer) : ctype == SQL_C_BINARY ? application.capacity : SQL_NTS;
    if (length == SQL_NULL_DATA) return nullptr;
    if (length == SQL_DEFAULT_PARAM) throw DriverError("07S01", "Default parameter values are not supported.");
    if (length == SQL_DATA_AT_EXEC || length <= SQL_LEN_DATA_AT_EXEC_OFFSET) throw DriverError("HYC00", "Data-at-execution parameters are not implemented yet.");
    if (length < 0 && length != SQL_NTS) throw DriverError("HY090", "Invalid parameter length or indicator.");
    const auto data = shifted(static_cast<unsigned char*>(application.data), offset);
    if (!data) throw DriverError("HY009", "Parameter data pointer is null.");
    auto input = input_value(ctype, data, length, application.capacity);
    auto text = input.value.get<std::string>();
    const bool character_input = ctype == SQL_C_CHAR || ctype == SQL_C_WCHAR;
    if (target.interval_code && input.source.sql_type == SQL_WVARCHAR) {
        const bool exact_numeric = ctype != SQL_C_FLOAT && ctype != SQL_C_DOUBLE && ctype != SQL_C_BIT && ctype != SQL_C_GUID;
        if (character_input || (exact_numeric && target.interval_code <= SQL_CODE_SECOND)) input.source = target;
        else throw DriverError("07006", "C type cannot be converted to this interval qualifier.");
        const auto first = text.find_first_not_of(" \t\r\n"), last = text.find_last_not_of(" \t\r\n");
        text = first == std::string::npos ? "" : text.substr(first,last - first + 1); input.value = text;
    }
    if (target.sql_type == SQL_WCHAR || target.sql_type == SQL_WVARCHAR) {
        const auto wide = utf16(text); SQLULEN count = 0;
        for (const auto unit : wide) if (unit < 0xdc00 || unit > 0xdfff) ++count;
        if (count > target.size) throw DriverError("22001", "Character parameter exceeds the declared length.");
        return text + (target.sql_type == SQL_WCHAR ? std::string(static_cast<std::size_t>(target.size - count), ' ') : "");
    }
    if (target.sql_type == SQL_BINARY || target.sql_type == SQL_VARBINARY) {
        if (character_input) {
            // ODBC는 문자 입력을 16진수 쌍으로 읽으며 마지막 홀수 문자는 무시한다.
            text.resize(text.size() - text.size() % 2);
            for (auto& byte : text) {
                if (byte >= 'a' && byte <= 'f') byte = static_cast<char>(byte - 'a' + 'A');
                if (!((byte >= '0' && byte <= '9') || (byte >= 'A' && byte <= 'F'))) throw DriverError("22018", "Character parameter is not hexadecimal.");
            }
        } else if (input.source.sql_type != SQL_VARBINARY) throw DriverError("07006", "Binary parameter conversion is not supported for this C type.");
        if (text.size() / 2 > target.size) throw DriverError("22001", "Binary parameter exceeds the declared length.");
        return Json{{"binary", text + (target.sql_type == SQL_BINARY ? std::string(static_cast<std::size_t>(target.size) * 2 - text.size(), '0') : "")}};
    }
    ConversionSpec spec; spec.precision = static_cast<SQLSMALLINT>(target.size); spec.scale = target.scale;
    spec.leading_precision = target.leading_precision; spec.fractional_precision = target.scale;
    SQLLEN ignored = 0;
    const auto convert = [&](SQLSMALLINT type, auto& output) {
        Diagnostic conversion;
        try { convert_value(input.value, input.source, type, &output, sizeof(output), &ignored, conversion, nullptr, spec, row, number); }
        catch (const DriverError& error) {
            const bool exact_target = target.sql_type == SQL_SMALLINT || target.sql_type == SQL_INTEGER || target.sql_type == SQL_BIGINT || target.sql_type == SQL_DECIMAL || target.sql_type == SQL_NUMERIC;
            if (character_input && exact_target && error.state == "22003") throw DriverError("22001", "Character parameter loses numeric digits.");
            if (character_input && error.state == "22007") throw DriverError("22018", "Character parameter is not a valid datetime literal.");
            throw;
        }
        if (conversion.size()) {
            if (target.interval_code) throw DriverError("22015", "Interval parameter loses field precision.");
            if (target.sql_type == SQL_TYPE_DATE || target.sql_type == SQL_TYPE_TIME || target.sql_type == SQL_TYPE_TIMESTAMP) throw DriverError("22008", "Datetime parameter loses field precision.");
            if (character_input || target.sql_type == SQL_BIT) throw DriverError("22001", "Parameter loses numeric digits.");
            diagnostic.append("01S07", "Fractional parameter data was truncated.", 0, row, number);
        }
    };
    switch (target.sql_type) {
    case SQL_SMALLINT: { SQLSMALLINT value{}; convert(SQL_C_SSHORT, value); return value; }
    case SQL_INTEGER: { SQLINTEGER value{}; convert(SQL_C_SLONG, value); return value; }
    case SQL_BIGINT: { SQLBIGINT value{}; convert(SQL_C_SBIGINT, value); return std::to_string(value); }
    case SQL_DECIMAL: case SQL_NUMERIC: { SQL_NUMERIC_STRUCT value{}; convert(SQL_C_NUMERIC, value); return numeric_text(value); }
    case SQL_REAL: { float value{}; convert(SQL_C_FLOAT, value); return value; }
    case SQL_DOUBLE: { double value{}; convert(SQL_C_DOUBLE, value); return value; }
    case SQL_BIT: { unsigned char value{}; convert(SQL_C_BIT, value); return value != 0; }
    case SQL_TYPE_DATE: { SQL_DATE_STRUCT value{}; convert(SQL_C_TYPE_DATE, value); return date_text(value); }
    case SQL_TYPE_TIME: case SQL_TYPE_TIMESTAMP: {
        SQL_TIMESTAMP_STRUCT value{}; convert(SQL_C_TYPE_TIMESTAMP, value);
        SQLUINTEGER divisor = 1; for (int i = target.scale; i < 9; ++i) divisor *= 10;
        if (value.fraction % divisor) throw DriverError("22008", "Datetime parameter loses fractional seconds.");
        if (target.sql_type == SQL_TYPE_TIME && value.fraction
            && (ctype == SQL_C_TIMESTAMP || ctype == SQL_C_TYPE_TIMESTAMP || (character_input && text.size() > 10 && text[4] == '-')))
            throw DriverError("22008", "Timestamp parameter loses fractional seconds when converted to TIME.");
        const auto time = time_text(value.hour, value.minute, value.second, value.fraction, static_cast<unsigned>(target.scale));
        return target.sql_type == SQL_TYPE_TIME ? time : date_text({value.year,value.month,value.day}) + " " + time;
    }
    default:
        if (target.interval_code) { SQL_INTERVAL_STRUCT value{}; convert(target.sql_type, value); return interval_text(value, target.sql_type); }
        throw DriverError("HYC00", "SQL parameter conversion is not supported.");
    }
}
} // namespace hwdbodbc
