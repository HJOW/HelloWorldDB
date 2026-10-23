#include "hwdbodbc/catalog.hpp"
#include "hwdbodbc/descriptor.hpp"
#include "hwdbodbc/statement.hpp"
#include <algorithm>
#include <cctype>

namespace hwdbodbc {
namespace {
std::string trim(const std::string& value) {
    std::size_t first = 0;
    while (first < value.size() && (value[first] == ' ' || value[first] == '\t' || value[first] == '\r' || value[first] == '\n')) ++first;
    std::size_t last = value.size();
    while (last > first && (value[last - 1] == ' ' || value[last - 1] == '\t' || value[last - 1] == '\r' || value[last - 1] == '\n')) --last;
    return value.substr(first, last - first);
}
std::string upper_copy(std::string value) {
    for (auto& byte : value) if (byte >= 'a' && byte <= 'z') byte = static_cast<char>(byte - 'a' + 'A');
    return value;
}
bool wide_match(const std::wstring& value, const std::wstring& pattern, wchar_t escape) {
    // ODBC 패턴 % _ 를 코드 포인트가 아니라 UTF-16 단위로 비교한다. surrogate는 두 단위로 센다.
    // 단순화를 위해 와일드카드 외 문자는 정확히 일치한다.
    std::size_t v = 0, p = 0, star = std::wstring::npos, star_v = 0;
    while (v < value.size()) {
        if (p < pattern.size() && pattern[p] == static_cast<wchar_t>(escape) && p + 1 < pattern.size()) {
            ++p;
            if (value[v] != pattern[p]) {
                if (star != std::wstring::npos) { p = star + 1; star_v++; v = star_v; continue; }
                return false;
            }
            ++v; ++p; continue;
        }
        if (p < pattern.size() && pattern[p] == L'%') { star = p++; star_v = v; continue; }
        if (p < pattern.size() && (pattern[p] == L'_' || pattern[p] == value[v])) { ++v; ++p; continue; }
        if (star != std::wstring::npos) { p = star + 1; star_v++; v = star_v; continue; }
        return false;
    }
    while (p < pattern.size() && pattern[p] == L'%') ++p;
    return p == pattern.size();
}
} // namespace

bool catalog_identifier_equals(const std::string& value, const std::string& argument) {
    // ODBC 식별자 인자 규칙이다. 뒤쪽 공백은 무시하고, 큰따옴표로 감싼 식별자는 안쪽을 그대로(안의 ""는 ") 비교하며,
    // 따옴표 없는 식별자는 서버처럼 대문자로 접어 비교한다. %와 _는 와일드카드가 아니라 문자 그대로이다.
    std::size_t last = argument.size();
    while (last > 0 && argument[last - 1] == ' ') --last;
    const std::string text = argument.substr(0, last);
    if (text.size() >= 2 && text.front() == '"' && text.back() == '"') {
        std::string inner;
        for (std::size_t i = 1; i + 1 < text.size(); ++i) {
            inner += text[i];
            if (text[i] == '"' && i + 2 < text.size() && text[i + 1] == '"') ++i;
        }
        return value == inner;
    }
    return value == upper_copy(text);
}

bool catalog_ordinary_match(const std::string& value, const std::string& argument, bool metadata_id) {
    return metadata_id ? catalog_identifier_equals(value, argument) : value == argument;
}

bool catalog_match(const std::string& value, const std::string& pattern, bool metadata_id, char escape) {
    if (metadata_id) return catalog_identifier_equals(value, pattern);
    if (pattern == "%" || pattern.empty()) return true;
    const auto wide_value = utf16(value);
    const auto wide_pattern = utf16(pattern);
    wchar_t wide_escape = 0;
    if (escape) {
        const auto wide = utf16(std::string(1, escape));
        if (!wide.empty()) wide_escape = wide[0];
    }
    return wide_match(wide_value, wide_pattern, wide_escape);
}

std::optional<std::string> catalog_string_input(const void* pointer, SQLINTEGER length, bool wide) {
    if (!pointer) return std::nullopt;
    if (length < 0 && length != SQL_NTS) throw DriverError("HY090", "Invalid string length.");
    if (wide) {
        const auto* text = static_cast<const SQLWCHAR*>(pointer);
        std::size_t count = length == SQL_NTS ? std::char_traits<SQLWCHAR>::length(text) : static_cast<std::size_t>(length);
        if (count > static_cast<std::size_t>((std::numeric_limits<int>::max)())) throw DriverError("HY090", "String length exceeds the supported range.");
        return utf8(std::wstring_view(reinterpret_cast<const wchar_t*>(text), count));
    }
    const auto* text = static_cast<const SQLCHAR*>(pointer);
    std::size_t count = length == SQL_NTS ? std::char_traits<SQLCHAR>::length(text) : static_cast<std::size_t>(length);
    if (count > static_cast<std::size_t>((std::numeric_limits<int>::max)())) throw DriverError("HY090", "String length exceeds the supported range.");
    return utf8(decode_ansi(std::string_view(reinterpret_cast<const char*>(text), count)));
}

Json fetch_all_rows(Connection& connection, const std::string& sql) {
    if (!connection.connected || !connection.session) throw DriverError("08003", "Connection is not open.");
    if (connection.session->dead()) throw DriverError("08S01", "Connection is no longer usable.", 8006);
    auto response = connection.session->request({{"type", "execute"}, {"sql", sql}, {"fetchSize", connection.fetch_size}}, "result", connection.connection_timeout);
    const auto kind = string_field(response, "type");
    if (kind == "ok") return Json::array();
    if (kind != "rows") throw DriverError("08S01", "Unexpected catalog response.", 8000);
    Json rows = response["rows"];
    bool more = response.contains("hasMore") && response["hasMore"].get<bool>();
    std::uint64_t cursor = more ? integer_field(response, "cursor") : 0;
    while (more) {
        auto next = connection.session->request({{"type", "fetch"}, {"cursor", cursor}, {"fetchSize", connection.fetch_size}}, "rows", connection.connection_timeout);
        const Json& part = next["rows"];
        for (const auto& row : part) rows.push_back(row);
        more = next["hasMore"].get<bool>();
        cursor = more ? integer_field(next, "cursor") : 0;
    }
    if (cursor) {
        try { connection.session->request({{"type", "closeCursor"}, {"cursor", cursor}}, "cursorClosed", connection.connection_timeout); } catch (...) {}
    }
    return rows;
}

void set_catalog_result(Statement& statement, std::vector<SqlType> columns, Json rows) {
    if (statement.cursor_open) throw DriverError("24000", "Close the current cursor before executing another statement.");
    release_prepared(statement);
    close_statement_cursor(statement);
    statement.executed = false;
    statement.row_count = 0;
    statement.diagnostic.row_count = 0;
    statement.diagnostic.cursor_row_count = 0;
    auto& implementation = *statement.descriptors[2];
    implementation.records.clear();
    for (const auto& column : columns) {
        DescriptorRecord record;
        descriptor_sql_metadata(record, column);
        implementation.records.push_back(std::move(record));
    }
    statement.rows = std::move(rows);
    statement.next_row = 0;
    statement.row_number = 0;
    statement.fetched_total = 0;
    statement.current_row = false;
    statement.streams.clear();
    statement.last_get_column = 0;
    statement.cursor = 0;
    statement.has_more = false;
    statement.cursor_open = true;
    statement.executed = true;
    statement.row_count = -1;
    statement.diagnostic.row_count = -1;
    statement.diagnostic.cursor_row_count = -1;
    if (implementation.records.size() == 1) statement.streams.resize(1);
    else statement.streams.resize(implementation.records.size());
    // 단일 행 묶음과 같은 초기 상태를 맞춘다. fetch가 스트림 위치를 다시 만든다.
    statement.streams.clear();
}

ParsedDeclared parse_declared_type(const std::string& declared) {
    ParsedDeclared result;
    std::string text = trim(declared);
    const std::string tz = "WITH TIME ZONE";
    if (text.size() > tz.size() && upper_copy(text.substr(text.size() - tz.size())) == tz) {
        result.with_time_zone = true;
        text = trim(text.substr(0, text.size() - tz.size()));
    }
    const std::string upper = upper_copy(text);
    if (upper.rfind("INTERVAL", 0) == 0) {
        result.base = "INTERVAL";
        std::string rest = trim(text.substr(8));
        // TO 분리
        std::string start_part, end_part;
        const auto to = upper_copy(rest).find(" TO ");
        if (to != std::string::npos) {
            start_part = trim(rest.substr(0, to));
            end_part = trim(rest.substr(to + 4));
        } else {
            start_part = trim(rest);
        }
        auto field = [&](const std::string& part, bool is_end) -> std::pair<std::string, long long> {
            const auto open = part.find('(');
            if (open == std::string::npos) return {upper_copy(trim(part)), is_end ? 6 : 2};
            const auto name = upper_copy(trim(part.substr(0, open)));
            const auto close = part.find(')', open);
            const auto inside = trim(part.substr(open + 1, close == std::string::npos ? std::string::npos : close - open - 1));
            if (name == "SECOND" && inside.find(',') != std::string::npos) {
                const auto comma = inside.find(',');
                const auto leading = std::stoll(trim(inside.substr(0, comma)));
                const auto frac = std::stoll(trim(inside.substr(comma + 1)));
                if (!is_end) result.leading = leading;
                else { result.leading = result.leading; }
                result.fractional = frac;
                return {name, leading};
            }
            const auto number = std::stoll(inside);
            if (!is_end && name != "SECOND") result.leading = number;
            if (name == "SECOND") result.fractional = number;
            return {name, number};
        };
        const auto start = field(start_part, false);
        result.start_field = start.first;
        if (!end_part.empty()) {
            const auto end = field(end_part, true);
            result.end_field = end.first;
            // 종료가 SECOND인데 소수 자릿수가 없으면 기본 6이다.
            if (end.first == "SECOND" && end_part.find(',') == std::string::npos && end_part.find('(') == std::string::npos) result.fractional = 6;
        } else {
            result.end_field = result.start_field;
            if (result.start_field == "SECOND" && start_part.find('(') == std::string::npos) result.fractional = 6;
        }
        if (result.start_field == "SECOND" && result.end_field == "SECOND" && start_part.find(',') == std::string::npos && start_part.find('(') != std::string::npos) {
            // SECOND(p) 형태는 leading이 아니라 fractional이다. 위에서 leading으로 잘못 넣었을 수 있어 바로잡는다.
            result.fractional = result.leading;
            result.leading = 2;
        }
        return result;
    }
    const auto open = text.find('(');
    if (open == std::string::npos) {
        result.base = upper_copy(trim(text));
        return result;
    }
    result.base = upper_copy(trim(text.substr(0, open)));
    const auto close = text.find(')', open);
    const auto inside = trim(text.substr(open + 1, close == std::string::npos ? std::string::npos : close - open - 1));
    if (result.base == "CHAR" || result.base == "VARCHAR" || result.base == "BINARY" || result.base == "VARBINARY" ||
        result.base == "NCHAR" || result.base == "NVARCHAR" || result.base == "CHARACTER" || result.base == "CHARACTER VARYING") {
        result.length = std::stoll(inside);
        result.has_length = true;
        if (result.base == "NCHAR" || result.base == "NATIONAL CHARACTER") result.base = "CHAR";
        if (result.base == "NVARCHAR" || result.base == "NATIONAL CHARACTER VARYING" || result.base == "CHARACTER VARYING" || result.base == "CHAR VARYING") result.base = "VARCHAR";
        if (result.base == "CHARACTER") result.base = "CHAR";
        return result;
    }
    if (result.base == "DECIMAL" || result.base == "NUMERIC" || result.base == "DEC") {
        result.base = "DECIMAL";
        const auto comma = inside.find(',');
        if (comma == std::string::npos) {
            result.precision = std::stoll(inside);
            result.has_precision = true;
        } else {
            result.precision = std::stoll(trim(inside.substr(0, comma)));
            result.scale = std::stoll(trim(inside.substr(comma + 1)));
            result.has_precision = true;
            result.has_scale = true;
        }
        return result;
    }
    if (result.base == "TIME" || result.base == "TIMESTAMP") {
        result.fractional = std::stoll(inside);
        result.has_fractional = true;
        return result;
    }
    if (result.base == "FLOAT") {
        result.precision = std::stoll(inside);
        result.has_precision = true;
        return result;
    }
    return result;
}

CatalogTypeInfo catalog_type_info(const std::string& declared) {
    const auto parsed = parse_declared_type(declared);
    CatalogTypeInfo info;
    const auto& base = parsed.base;
    if (base == "CHAR") {
        info.sql_type = SQL_WCHAR; info.type_name = "CHAR";
        info.column_size = static_cast<SQLULEN>(parsed.has_length ? parsed.length : 1);
        info.buffer_length = static_cast<SQLLEN>(info.column_size * 4);
        info.decimal_digits = 0; info.decimal_nullable = true;
        info.radix = 0; info.radix_nullable = true;
    } else if (base == "VARCHAR") {
        info.sql_type = SQL_WVARCHAR; info.type_name = "VARCHAR";
        info.column_size = static_cast<SQLULEN>(parsed.has_length ? parsed.length : 65535);
        info.buffer_length = static_cast<SQLLEN>(info.column_size * 4);
        info.decimal_digits = 0; info.decimal_nullable = true;
        info.radix = 0; info.radix_nullable = true;
    } else if (base == "BINARY") {
        info.sql_type = SQL_BINARY; info.type_name = "BINARY";
        info.column_size = static_cast<SQLULEN>(parsed.has_length ? parsed.length : 1);
        info.buffer_length = static_cast<SQLLEN>(info.column_size);
        info.radix = 0; info.radix_nullable = true;
    } else if (base == "VARBINARY" || base == "BINARY VARYING") {
        info.sql_type = SQL_VARBINARY; info.type_name = "VARBINARY";
        info.column_size = static_cast<SQLULEN>(parsed.has_length ? parsed.length : 65535);
        info.buffer_length = static_cast<SQLLEN>(info.column_size);
        info.radix = 0; info.radix_nullable = true;
    } else if (base == "SMALLINT") {
        info.sql_type = SQL_SMALLINT; info.type_name = "SMALLINT";
        info.column_size = 5; info.buffer_length = 2; info.decimal_digits = 0; info.decimal_nullable = false;
        info.radix = 10; info.radix_nullable = false;
    } else if (base == "INTEGER" || base == "INT") {
        info.sql_type = SQL_INTEGER; info.type_name = "INTEGER";
        info.column_size = 10; info.buffer_length = 4; info.decimal_digits = 0; info.decimal_nullable = false;
        info.radix = 10; info.radix_nullable = false;
    } else if (base == "BIGINT") {
        info.sql_type = SQL_BIGINT; info.type_name = "BIGINT";
        info.column_size = 19; info.buffer_length = 8; info.decimal_digits = 0; info.decimal_nullable = false;
        info.radix = 10; info.radix_nullable = false;
    } else if (base == "DECIMAL") {
        info.sql_type = SQL_DECIMAL; info.type_name = "DECIMAL";
        info.column_size = static_cast<SQLULEN>(parsed.has_precision ? parsed.precision : 10);
        info.decimal_digits = static_cast<SQLSMALLINT>(parsed.has_scale ? parsed.scale : (parsed.has_precision ? 0 : 3));
        info.decimal_nullable = false;
        info.buffer_length = static_cast<SQLLEN>(sizeof(SQL_NUMERIC_STRUCT));
        info.radix = 10; info.radix_nullable = false;
    } else if (base == "REAL") {
        info.sql_type = SQL_REAL; info.type_name = "REAL";
        info.column_size = 7; info.buffer_length = 4; info.decimal_digits = 0; info.decimal_nullable = true;
        info.radix = 2; info.radix_nullable = false;
    } else if (base == "DOUBLE PRECISION" || base == "DOUBLE" || base == "FLOAT") {
        info.sql_type = SQL_DOUBLE; info.type_name = "DOUBLE PRECISION";
        info.column_size = 15; info.buffer_length = 8; info.decimal_digits = 0; info.decimal_nullable = true;
        info.radix = 2; info.radix_nullable = false;
    } else if (base == "BOOLEAN") {
        info.sql_type = SQL_BIT; info.type_name = "BOOLEAN";
        info.column_size = 1; info.buffer_length = 1; info.decimal_digits = 0; info.decimal_nullable = true;
        info.radix = 0; info.radix_nullable = true;
    } else if (base == "DATE") {
        info.sql_type = SQL_TYPE_DATE; info.type_name = "DATE";
        info.column_size = 10; info.buffer_length = static_cast<SQLLEN>(sizeof(SQL_DATE_STRUCT));
        info.decimal_digits = 0; info.decimal_nullable = true;
        info.radix = 0; info.radix_nullable = true;
    } else if (base == "TIME") {
        if (parsed.with_time_zone) {
            info.sql_type = SQL_WVARCHAR; info.type_name = "TIME WITH TIME ZONE";
            const auto frac = parsed.fractional;
            info.column_size = static_cast<SQLULEN>(8 + (frac ? 1 + frac : 0) + 6);
            info.buffer_length = static_cast<SQLLEN>(info.column_size * 2);
        } else {
            info.sql_type = SQL_TYPE_TIME; info.type_name = "TIME";
            const auto frac = parsed.fractional;
            info.column_size = static_cast<SQLULEN>(8 + (frac ? 1 + frac : 0));
            info.buffer_length = static_cast<SQLLEN>(sizeof(SQL_TIME_STRUCT));
        }
        info.decimal_digits = static_cast<SQLSMALLINT>(parsed.fractional);
        info.decimal_nullable = false;
        info.radix = 0; info.radix_nullable = true;
    } else if (base == "TIMESTAMP") {
        if (parsed.with_time_zone) {
            info.sql_type = SQL_WVARCHAR; info.type_name = "TIMESTAMP WITH TIME ZONE";
            // 서버는 항상 TIMESTAMP(p)로 적는다. 0은 명시한 값이며 기본값 6이 아니다.
            const auto frac = parsed.has_fractional ? parsed.fractional : 6;
            info.column_size = static_cast<SQLULEN>(19 + (frac ? 1 + frac : 0) + 6);
            info.buffer_length = static_cast<SQLLEN>(info.column_size * 2);
            info.decimal_digits = static_cast<SQLSMALLINT>(frac);
        } else {
            info.sql_type = SQL_TYPE_TIMESTAMP; info.type_name = "TIMESTAMP";
            const auto frac = parsed.has_fractional ? parsed.fractional : 6;
            info.column_size = static_cast<SQLULEN>(19 + (frac ? 1 + frac : 0));
            info.buffer_length = static_cast<SQLLEN>(sizeof(SQL_TIMESTAMP_STRUCT));
            info.decimal_digits = static_cast<SQLSMALLINT>(frac);
        }
        info.decimal_nullable = false;
        info.radix = 0; info.radix_nullable = true;
    } else if (base == "INTERVAL") {
        const auto key = parsed.start_field + " " + parsed.end_field;
        SQLSMALLINT code = 0;
        if (key == "YEAR YEAR") code = SQL_INTERVAL_YEAR;
        else if (key == "MONTH MONTH") code = SQL_INTERVAL_MONTH;
        else if (key == "DAY DAY") code = SQL_INTERVAL_DAY;
        else if (key == "HOUR HOUR") code = SQL_INTERVAL_HOUR;
        else if (key == "MINUTE MINUTE") code = SQL_INTERVAL_MINUTE;
        else if (key == "SECOND SECOND") code = SQL_INTERVAL_SECOND;
        else if (key == "YEAR MONTH") code = SQL_INTERVAL_YEAR_TO_MONTH;
        else if (key == "DAY HOUR") code = SQL_INTERVAL_DAY_TO_HOUR;
        else if (key == "DAY MINUTE") code = SQL_INTERVAL_DAY_TO_MINUTE;
        else if (key == "DAY SECOND") code = SQL_INTERVAL_DAY_TO_SECOND;
        else if (key == "HOUR MINUTE") code = SQL_INTERVAL_HOUR_TO_MINUTE;
        else if (key == "HOUR SECOND") code = SQL_INTERVAL_HOUR_TO_SECOND;
        else if (key == "MINUTE SECOND") code = SQL_INTERVAL_MINUTE_TO_SECOND;
        info.sql_type = code ? code : SQL_WVARCHAR;
        info.type_name = declared;
        info.interval_code = code ? static_cast<SQLSMALLINT>(code - 100) : 0;
        info.leading_precision = static_cast<SQLINTEGER>(parsed.leading ? parsed.leading : 2);
        info.leading_nullable = false;
        const auto fields = std::map<std::string, unsigned>{{"YEAR",0},{"MONTH",1},{"DAY",2},{"HOUR",3},{"MINUTE",4},{"SECOND",5}};
        const auto span = fields.at(parsed.end_field) >= fields.at(parsed.start_field) ? fields.at(parsed.end_field) - fields.at(parsed.start_field) : 0;
        info.column_size = static_cast<SQLULEN>(info.leading_precision + 3 * span + (parsed.end_field == "SECOND" ? 1 + parsed.fractional : 0));
        info.buffer_length = static_cast<SQLLEN>(sizeof(SQL_INTERVAL_STRUCT));
        info.decimal_digits = static_cast<SQLSMALLINT>(parsed.end_field == "SECOND" ? parsed.fractional : 0);
        info.decimal_nullable = false;
        info.radix = 0; info.radix_nullable = true;
        if (!code) { info.column_size = 64; info.buffer_length = 128; }
        return info;
    } else {
        info.sql_type = SQL_WVARCHAR; info.type_name = declared.empty() ? "UNKNOWN" : declared;
        info.column_size = 128; info.buffer_length = 256;
    }
    info.leading_precision = 0; info.leading_nullable = true;
    return info;
}

SqlType make_catalog_varchar(const std::string& name, SQLULEN length, SQLSMALLINT nullable) {
    SqlType type;
    type.name = name; type.declared = "VARCHAR(" + std::to_string(length) + ")"; type.type_name = "VARCHAR";
    type.sql_type = SQL_WVARCHAR; type.default_c = SQL_C_WCHAR;
    type.size = length; type.octets = static_cast<SQLLEN>(length * 4); type.display_size = static_cast<SQLLEN>(length);
    type.scale = 0; type.nullable = nullable;
    return type;
}
SqlType make_catalog_smallint(const std::string& name, SQLSMALLINT nullable) {
    SqlType type;
    type.name = name; type.declared = "SMALLINT"; type.type_name = "SMALLINT";
    type.sql_type = SQL_SMALLINT; type.default_c = SQL_C_SSHORT;
    type.size = 5; type.octets = 2; type.display_size = 6; type.nullable = nullable;
    return type;
}
SqlType make_catalog_integer(const std::string& name, SQLSMALLINT nullable) {
    SqlType type;
    type.name = name; type.declared = "INTEGER"; type.type_name = "INTEGER";
    type.sql_type = SQL_INTEGER; type.default_c = SQL_C_SLONG;
    type.size = 10; type.octets = 4; type.display_size = 11; type.nullable = nullable;
    return type;
}
} // namespace hwdbodbc
