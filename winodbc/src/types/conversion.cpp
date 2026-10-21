#include "hwdbodbc/types.hpp"
#include <charconv>
#include <cmath>
#include <cstring>
#include <limits>
#include <cstdio>

namespace hwdbodbc {
namespace {
struct Decimal {
    bool negative = false;
    std::string digits;
    int scale = 0;
};
std::string_view trimmed(std::string_view text) {
    while (!text.empty() && (text.front() == ' ' || text.front() == '\t' || text.front() == '\r' || text.front() == '\n')) text.remove_prefix(1);
    while (!text.empty() && (text.back() == ' ' || text.back() == '\t' || text.back() == '\r' || text.back() == '\n')) text.remove_suffix(1);
    return text;
}
Decimal decimal(std::string_view text) {
    text = trimmed(text);
    Decimal result;
    if (text.empty()) throw DriverError("22018", "Invalid numeric value.");
    std::size_t position = 0;
    if (text[position] == '-' || text[position] == '+') result.negative = text[position++] == '-';
    bool point = false;
    for (; position < text.size(); ++position) {
        const auto byte = text[position];
        if (byte == '.' && !point) { point = true; continue; }
        if (byte < '0' || byte > '9') break;
        result.digits += byte;
        if (point) ++result.scale;
    }
    if (result.digits.empty()) throw DriverError("22018", "Invalid numeric value.");
    if (position < text.size() && (text[position] == 'e' || text[position] == 'E')) {
        ++position;
        bool negative = false;
        if (position < text.size() && (text[position] == '+' || text[position] == '-')) negative = text[position++] == '-';
        int exponent = 0;
        const auto conversion = std::from_chars(text.data() + position, text.data() + text.size(), exponent);
        if (conversion.ec == std::errc::result_out_of_range || exponent > 1000) throw DriverError("22003", "Numeric value out of range.");
        if (conversion.ec != std::errc() || conversion.ptr != text.data() + text.size()) throw DriverError("22018", "Invalid numeric value.");
        result.scale += negative ? exponent : -exponent;
        position = text.size();
    }
    if (position != text.size()) throw DriverError("22018", "Invalid numeric value.");
    return result;
}
void strip_zeroes(std::string& digits) {
    const auto first = digits.find_first_not_of('0');
    if (first == std::string::npos) digits = "0";
    else if (first) digits.erase(0, first);
}
bool rescale(Decimal& value, int scale) {
    bool truncated = false;
    const auto difference = scale - value.scale;
    if (difference >= 0) value.digits.append(static_cast<std::size_t>(difference), '0');
    else {
        const auto removed = static_cast<std::size_t>(-difference);
        const auto keep = removed >= value.digits.size() ? 0 : value.digits.size() - removed;
        truncated = value.digits.find_first_not_of('0', keep) != std::string::npos;
        value.digits.resize(keep);
    }
    strip_zeroes(value.digits); value.scale = scale;
    if (value.digits == "0") value.negative = false;
    return truncated;
}
std::string value_text(const Json& value) {
    if (value.is_string()) return value.get<std::string>();
    if (value.is_boolean()) return value.get<bool>() ? "1" : "0";
    if (value.is_number()) return value.dump();
    throw DriverError("07006", "Value cannot be converted to the requested C type.");
}
bool numeric_source(const SqlType& type) {
    return type.sql_type == SQL_SMALLINT || type.sql_type == SQL_INTEGER || type.sql_type == SQL_BIGINT
        || type.sql_type == SQL_DECIMAL || type.sql_type == SQL_NUMERIC || type.sql_type == SQL_REAL
        || type.sql_type == SQL_DOUBLE || type.sql_type == SQL_BIT || type.sql_type == SQL_WCHAR || type.sql_type == SQL_WVARCHAR;
}
template<class T> T integer(const std::string& text, bool& truncated) {
    auto value = decimal(text);
    truncated = rescale(value, 0);
    if (value.negative) value.digits.insert(value.digits.begin(), '-');
    T result{};
    const auto conversion = std::from_chars(value.digits.data(), value.digits.data() + value.digits.size(), result);
    if (conversion.ec != std::errc() || conversion.ptr != value.digits.data() + value.digits.size())
        throw DriverError("22003", "Numeric value out of range.");
    return result;
}
unsigned component(std::string_view text, std::size_t start, std::size_t count, unsigned maximum) {
    if (start + count > text.size()) throw DriverError("22007", "Invalid datetime format.");
    unsigned result = 0;
    const auto conversion = std::from_chars(text.data() + start, text.data() + start + count, result);
    if (conversion.ec != std::errc() || conversion.ptr != text.data() + start + count || result > maximum)
        throw DriverError("22007", "Invalid datetime format.");
    return result;
}
SQL_DATE_STRUCT date(std::string_view text) {
    if (text.size() < 10 || text[4] != '-' || text[7] != '-') throw DriverError("22007", "Invalid datetime format.");
    const auto year = component(text, 0, 4, 9999), month = component(text, 5, 2, 12), day = component(text, 8, 2, 31);
    const unsigned days[] = {0,31,28,31,30,31,30,31,31,30,31,30,31};
    if (!year || !month || !day || day > days[month] + (month == 2 && year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) ? 1U : 0U))
        throw DriverError("22007", "Invalid calendar date.");
    return {static_cast<SQLSMALLINT>(year), static_cast<SQLUSMALLINT>(month), static_cast<SQLUSMALLINT>(day)};
}
SQL_TIMESTAMP_STRUCT timestamp(std::string_view text, bool& has_date, bool& has_time) {
    text = trimmed(text);
    SQL_TIMESTAMP_STRUCT result{};
    has_date = text.size() >= 10 && text[4] == '-';
    has_time = !has_date || text.size() > 10;
    if (has_date) {
        const auto parsed = date(text); result.year = parsed.year; result.month = parsed.month; result.day = parsed.day;
        text.remove_prefix(10);
        if (!text.empty()) { if (text.front() != ' ' && text.front() != 'T') throw DriverError("22007", "Invalid datetime format."); text.remove_prefix(1); }
    }
    if (has_time) {
        if (text.size() < 8 || text[2] != ':' || text[5] != ':') throw DriverError("22007", "Invalid datetime format.");
        result.hour = static_cast<SQLUSMALLINT>(component(text, 0, 2, 23));
        result.minute = static_cast<SQLUSMALLINT>(component(text, 3, 2, 59));
        result.second = static_cast<SQLUSMALLINT>(component(text, 6, 2, 59));
        text.remove_prefix(8);
        if (!text.empty()) {
            if (text[0] != '.' || text.size() < 2 || text.size() > 10) throw DriverError("22007", "Invalid datetime fraction.");
            result.fraction = component(text, 1, text.size() - 1, 999999999);
            for (std::size_t i = text.size() - 1; i < 9; ++i) result.fraction *= 10;
            text = {};
        }
    }
    if (!text.empty()) throw DriverError("22007", "Invalid datetime format.");
    return result;
}
std::vector<unsigned char> binary(std::string_view text) {
    if (text.size() % 2) throw DriverError("22018", "Invalid binary representation.");
    std::vector<unsigned char> result(text.size() / 2);
    const auto digit = [](char value) -> unsigned {
        if (value >= '0' && value <= '9') return static_cast<unsigned>(value - '0');
        if (value >= 'A' && value <= 'F') return static_cast<unsigned>(value - 'A' + 10);
        if (value >= 'a' && value <= 'f') return static_cast<unsigned>(value - 'a' + 10);
        throw DriverError("22018", "Invalid binary representation.");
    };
    for (std::size_t i = 0; i < result.size(); ++i) result[i] = static_cast<unsigned char>((digit(text[i * 2]) << 4) | digit(text[i * 2 + 1]));
    return result;
}
SQL_INTERVAL_STRUCT interval(const std::string& input, const SqlType& source, SQLSMALLINT target, const ConversionSpec& spec, bool& truncated) {
    if (source.type_name != "INTERVAL" || source.sql_type != target) throw DriverError("07006", "Interval qualifier conversion is not supported.");
    SQL_INTERVAL_STRUCT result{};
    result.interval_type = static_cast<SQLINTERVAL>(target - 100);
    std::string_view text(input);
    if (!text.empty() && (text.front() == '-' || text.front() == '+')) {
        result.interval_sign = text.front() == '-' ? SQL_TRUE : SQL_FALSE; text.remove_prefix(1);
    }
    std::vector<std::string_view> parts;
    std::size_t position = 0;
    for (std::size_t i = 0; i <= text.size(); ++i) if (i == text.size() || text[i] == '-' || text[i] == ' ' || text[i] == ':') {
        parts.push_back(text.substr(position, i - position)); position = i + 1;
    }
    const auto code = source.interval_code;
    const std::pair<int, int> ranges[] = {{0,0},{1,1},{2,2},{3,3},{4,4},{5,5},{0,1},{2,3},{2,4},{2,5},{3,4},{3,5},{4,5}};
    if (code < 1 || code > 13) throw DriverError("22015", "Invalid interval qualifier.");
    const auto range = ranges[code - 1];
    if (parts.size() != static_cast<std::size_t>(range.second - range.first + 1) || parts[0].empty()) throw DriverError("22018", "Invalid interval format.");
    SQLUINTEGER values[6]{};
    for (std::size_t i = 0; i < parts.size(); ++i) {
        const auto field = range.first + static_cast<int>(i);
        auto part = parts[i];
        const auto dot = part.find('.');
        if (dot != std::string_view::npos) {
            if (field != 5) throw DriverError("22018", "Invalid interval fraction.");
            const auto fraction = part.substr(dot + 1);
            if (fraction.empty() || fraction.size() > 9) throw DriverError("22018", "Invalid interval fraction.");
            result.intval.day_second.fraction = component(fraction, 0, fraction.size(), 999999999);
            for (std::size_t j = fraction.size(); j < 9; ++j) result.intval.day_second.fraction *= 10;
            SQLUINTEGER divisor = 1;
            for (int j = spec.fractional_precision; j < 9; ++j) divisor *= 10;
            truncated = result.intval.day_second.fraction % divisor != 0;
            result.intval.day_second.fraction = result.intval.day_second.fraction / divisor * divisor;
            part = part.substr(0, dot);
        }
        const auto converted = std::from_chars(part.data(), part.data() + part.size(), values[field]);
        if (part.empty() || converted.ec != std::errc() || converted.ptr != part.data() + part.size()) throw DriverError("22015", "Interval field overflow.");
        auto digits = part; while (digits.size() > 1 && digits.front() == '0') digits.remove_prefix(1);
        if ((i == 0 && digits.size() > static_cast<std::size_t>(spec.leading_precision))
            || (i != 0 && values[field] > (field == 1 ? 11U : field == 3 ? 23U : 59U)))
            throw DriverError("22015", "Interval field overflow.");
    }
    if (range.first < 2) { result.intval.year_month.year = values[0]; result.intval.year_month.month = values[1]; }
    else {
        result.intval.day_second.day = values[2]; result.intval.day_second.hour = values[3];
        result.intval.day_second.minute = values[4]; result.intval.day_second.second = values[5];
    }
    return result;
}
}

SQL_NUMERIC_STRUCT numeric_struct(std::string_view text, SQLSMALLINT precision, SQLSMALLINT scale, bool& truncated) {
    if (precision < 1 || precision > 38 || scale < -128 || scale > 127) throw DriverError("HY104", "Invalid numeric precision or scale.");
    auto value = decimal(text);
    truncated = rescale(value, scale);
    if (value.digits.size() > static_cast<std::size_t>(precision)) throw DriverError("22003", "Numeric value out of range.");
    SQL_NUMERIC_STRUCT result{};
    result.precision = static_cast<SQLCHAR>(precision); result.scale = static_cast<SQLSCHAR>(scale); result.sign = value.negative ? 0 : 1;
    for (const auto digit : value.digits) {
        unsigned carry = static_cast<unsigned>(digit - '0');
        for (auto& byte : result.val) { const auto product = static_cast<unsigned>(byte) * 10 + carry; byte = static_cast<SQLCHAR>(product & 255U); carry = product >> 8; }
        if (carry) throw DriverError("22003", "Numeric value out of range.");
    }
    return result;
}
std::string numeric_text(const SQL_NUMERIC_STRUCT& numeric) {
    if (numeric.precision < 1 || numeric.precision > 38 || numeric.sign > 1) throw DriverError("22003", "Invalid SQL_NUMERIC_STRUCT.");
    std::array<SQLCHAR, SQL_MAX_NUMERIC_LEN> bytes{};
    std::copy_n(numeric.val, bytes.size(), bytes.data());
    std::string digits;
    bool remaining = true;
    while (remaining) {
        unsigned remainder = 0; remaining = false;
        for (std::size_t i = bytes.size(); i-- > 0;) {
            const auto value = remainder * 256 + bytes[i]; bytes[i] = static_cast<SQLCHAR>(value / 10); remainder = value % 10;
            remaining = remaining || bytes[i] != 0;
        }
        digits.insert(digits.begin(), static_cast<char>('0' + remainder));
    }
    if (digits.size() > numeric.precision) throw DriverError("22003", "Numeric value exceeds declared precision.");
    if (numeric.scale > 0) {
        if (digits.size() <= static_cast<std::size_t>(numeric.scale)) digits.insert(0, static_cast<std::size_t>(numeric.scale) + 1 - digits.size(), '0');
        digits.insert(digits.size() - static_cast<std::size_t>(numeric.scale), 1, '.');
    } else if (numeric.scale < 0) digits.append(static_cast<std::size_t>(-static_cast<int>(numeric.scale)), '0');
    if (!numeric.sign && digits.find_first_not_of("0.") != std::string::npos) digits.insert(digits.begin(), '-');
    return digits;
}

SQLRETURN convert_value(const Json& value, const SqlType& source, SQLSMALLINT target,
    SQLPOINTER output, SQLLEN capacity, SQLLEN* indicator, Diagnostic& diagnostic,
    DataStream* stream, const ConversionSpec& spec, SQLLEN row, SQLINTEGER column) {
    if (!valid_c_type(target)) throw DriverError("HY003", "Invalid C data type.");
    if (capacity < 0) throw DriverError("HY090", "Invalid buffer length.");
    if (!output) throw DriverError("HY009", "Invalid use of null pointer.");
    if (target == SQL_C_DEFAULT) target = source.default_c;
    if (stream && stream->done) return SQL_NO_DATA;
    if (stream && stream->offset && stream->type != target) throw DriverError("HY010", "C type cannot change during partial retrieval.");
    if (stream) stream->type = target;
    if (value.is_null()) {
        if (!indicator) throw DriverError("22002", "Indicator variable required for NULL data.");
        *indicator = SQL_NULL_DATA;
        if (stream) stream->done = true;
        return SQL_SUCCESS;
    }
    const auto text = value_text(value);
    const auto warn = [&](const char* state, const char* message) -> SQLRETURN {
        diagnostic.append(state, message, 0, row, column); return SQL_SUCCESS_WITH_INFO;
    };
    if (target == SQL_C_CHAR || target == SQL_C_WCHAR || target == SQL_C_BINARY) {
        std::vector<unsigned char> bytes;
        std::size_t terminator = 0;
        if (target == SQL_C_BINARY) {
            if (source.sql_type == SQL_BINARY || source.sql_type == SQL_VARBINARY) bytes = binary(text);
            else if (source.sql_type == SQL_WCHAR || source.sql_type == SQL_WVARCHAR) bytes.assign(text.begin(), text.end());
            else throw DriverError("07006", "Binary conversion is not supported for this SQL type.");
        } else {
            const auto wide = utf16(text);
            if (target == SQL_C_WCHAR) {
                const auto begin = reinterpret_cast<const unsigned char*>(wide.data()); bytes.assign(begin, begin + wide.size() * 2); terminator = 2;
            } else {
                const auto narrow = encode_ansi(wide); bytes.assign(narrow.begin(), narrow.end()); terminator = 1;
            }
        }
        const auto offset = stream ? stream->offset : 0;
        if (offset > bytes.size()) throw DriverError("HY010", "Invalid data retrieval offset.");
        const auto remaining = bytes.size() - offset;
        if (indicator) *indicator = static_cast<SQLLEN>(remaining);
        auto available = static_cast<std::size_t>(capacity);
        if (target == SQL_C_WCHAR) available -= available % 2;
        auto copied = (std::min)(remaining, available >= terminator ? available - terminator : 0);
        if (target == SQL_C_WCHAR && copied < remaining && copied >= 2) {
            SQLWCHAR last = 0; std::memcpy(&last, bytes.data() + offset + copied - 2, 2);
            if (last >= 0xd800 && last <= 0xdbff) copied -= 2;
        }
        if (target == SQL_C_CHAR && copied < remaining) {
            const auto begin = reinterpret_cast<const char*>(bytes.data() + offset);
            std::size_t position = 0;
            while (position < copied) {
                std::size_t next;
                if (GetACP() == CP_UTF8) {
                    const auto byte = static_cast<unsigned char>(begin[position]);
                    next = position + (byte < 0x80 ? 1U : byte < 0xe0 ? 2U : byte < 0xf0 ? 3U : 4U);
                } else next = static_cast<std::size_t>(CharNextExA(CP_ACP, begin + position, 0) - begin);
                if (next > copied) { copied = position; break; } position = next;
            }
        }
        const bool variable_source = source.sql_type == SQL_WCHAR || source.sql_type == SQL_WVARCHAR
            || source.sql_type == SQL_BINARY || source.sql_type == SQL_VARBINARY;
        if (!variable_source && (target == SQL_C_CHAR || target == SQL_C_WCHAR)) {
            const auto dot = text.find('.');
            std::size_t minimum = dot == std::string::npos ? text.size() : dot;
            if (text.find_first_of("eE") != std::string::npos) minimum = text.size();
            if (source.sql_type == SQL_TYPE_DATE) minimum = 10;
            else if (source.sql_type == SQL_TYPE_TIME) minimum = 8;
            else if (source.sql_type == SQL_TYPE_TIMESTAMP) minimum = 19;
            const auto units = copied / (target == SQL_C_WCHAR ? 2U : 1U);
            if (units < minimum || available < terminator)
                throw DriverError("22003", "Whole numeric or datetime fields would be truncated.");
            if (units && units < text.size() && text[units - 1] == '.') copied -= target == SQL_C_WCHAR ? 2U : 1U;
        }
        if (copied) std::memcpy(output, bytes.data() + offset, copied);
        if (terminator && available >= terminator) std::memset(static_cast<unsigned char*>(output) + copied, 0, terminator);
        if (stream) { stream->offset += copied; stream->done = !variable_source || (copied == remaining && available >= terminator); }
        if (copied < remaining || available < terminator) return warn("01004", "String or binary data was truncated.");
        return SQL_SUCCESS;
    }
    bool truncated = false;
    const auto put = [&](const auto& output_value) {
        std::memcpy(output, &output_value, sizeof(output_value));
        if (indicator) *indicator = sizeof(output_value);
        if (stream) stream->done = true;
    };
    if (target == SQL_C_DATE || target == SQL_C_TYPE_DATE || target == SQL_C_TIME || target == SQL_C_TYPE_TIME
        || target == SQL_C_TIMESTAMP || target == SQL_C_TYPE_TIMESTAMP) {
        if (source.sql_type != SQL_TYPE_DATE && source.sql_type != SQL_TYPE_TIME && source.sql_type != SQL_TYPE_TIMESTAMP
            && source.sql_type != SQL_WCHAR && source.sql_type != SQL_WVARCHAR)
            throw DriverError("07006", "SQL type cannot be converted to a datetime C type.");
        bool has_date = false, has_time = false;
        auto parsed = timestamp(text, has_date, has_time);
        if (target == SQL_C_DATE || target == SQL_C_TYPE_DATE) {
            if (!has_date) throw DriverError("07006", "A time value cannot be converted to a date.");
            truncated = parsed.hour || parsed.minute || parsed.second || parsed.fraction;
            put(SQL_DATE_STRUCT{parsed.year, parsed.month, parsed.day});
        } else if (target == SQL_C_TIME || target == SQL_C_TYPE_TIME) {
            if (!has_time) throw DriverError("07006", "A date value cannot be converted to a time.");
            truncated = parsed.fraction != 0;
            put(SQL_TIME_STRUCT{parsed.hour, parsed.minute, parsed.second});
        } else {
            if (!has_date) {
                SYSTEMTIME now{}; GetLocalTime(&now);
                parsed.year = static_cast<SQLSMALLINT>(now.wYear); parsed.month = now.wMonth; parsed.day = now.wDay;
            }
            put(parsed);
        }
    } else if (target >= SQL_C_INTERVAL_YEAR && target <= SQL_C_INTERVAL_MINUTE_TO_SECOND) put(interval(text, source, target, spec, truncated));
    else {
        if (!numeric_source(source)) throw DriverError("07006", "SQL type cannot be converted to a numeric C type.");
        switch (target) {
        case SQL_C_SHORT: case SQL_C_SSHORT: put(integer<SQLSMALLINT>(text, truncated)); break;
        case SQL_C_USHORT: put(integer<SQLUSMALLINT>(text, truncated)); break;
        case SQL_C_LONG: case SQL_C_SLONG: put(integer<SQLINTEGER>(text, truncated)); break;
        case SQL_C_ULONG: put(integer<SQLUINTEGER>(text, truncated)); break;
        case SQL_C_TINYINT: case SQL_C_STINYINT: put(integer<signed char>(text, truncated)); break;
        case SQL_C_UTINYINT: put(integer<unsigned char>(text, truncated)); break;
        case SQL_C_SBIGINT: put(integer<SQLBIGINT>(text, truncated)); break;
        case SQL_C_UBIGINT: put(integer<SQLUBIGINT>(text, truncated)); break;
        case SQL_C_BIT: {
            const auto original = decimal(text);
            if (original.negative && original.digits.find_first_not_of('0') != std::string::npos)
                throw DriverError("22003", "Bit value out of range.");
            const auto bit = integer<unsigned char>(text, truncated);
            if (bit > 1) throw DriverError("22003", "Bit value out of range."); put(bit); break;
        }
        case SQL_C_NUMERIC: put(numeric_struct(text, spec.precision, spec.scale, truncated)); break;
        case SQL_C_FLOAT: case SQL_C_DOUBLE: {
            double number = 0;
            auto input = trimmed(text);
            if (!input.empty() && input.front() == '+') input.remove_prefix(1);
            const auto converted = std::from_chars(input.data(), input.data() + input.size(), number);
            if (converted.ec == std::errc::result_out_of_range || !std::isfinite(number)) throw DriverError("22003", "Floating point value out of range.");
            if (converted.ec != std::errc() || converted.ptr != input.data() + input.size()) throw DriverError("22018", "Invalid floating point value.");
            if (target == SQL_C_FLOAT) {
                if (std::abs(number) > (std::numeric_limits<float>::max)()) throw DriverError("22003", "Floating point value out of range.");
                if (number != 0 && static_cast<float>(number) == 0) throw DriverError("22003", "Floating point value underflow.");
                put(static_cast<float>(number));
            } else put(number);
            break;
        }
        default: throw DriverError("HYC00", "C data type conversion is not implemented.");
        }
    }
    return truncated ? warn("01S07", "Fractional data was truncated.") : SQL_SUCCESS;
}
} // namespace hwdbodbc
