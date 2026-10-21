#include "hwdbodbc/sql_text.hpp"
#include <map>
#include <vector>

namespace hwdbodbc {
namespace {
std::string_view trim(std::string_view input) {
    const auto first = input.find_first_not_of(" \t\r\n");
    if (first == std::string_view::npos) return {};
    return input.substr(first, input.find_last_not_of(" \t\r\n") - first + 1);
}
std::string upper(std::string_view input) {
    std::string value(input);
    for (auto& byte : value) if (byte >= 'a' && byte <= 'z') byte = static_cast<char>(byte - 'a' + 'A');
    return value;
}
// 따옴표와 주석 내부는 그대로 보존하고 그 안의 ?, {, }를 해석하지 않는다.
std::size_t opaque_end(std::string_view text, std::size_t start) {
    const auto character = text[start];
    if (character == '\'' || character == '"') {
        auto position = start + 1;
        while (position < text.size()) {
            if (text[position++] != character) continue;
            if (position < text.size() && text[position] == character) { ++position; continue; }
            return position;
        }
        return text.size();
    }
    if (text.substr(start, 2) == "--") {
        const auto end = text.find('\n', start + 2); return end == std::string_view::npos ? text.size() : end + 1;
    }
    if (text.substr(start, 2) == "/*") {
        const auto end = text.find("*/", start + 2); return end == std::string_view::npos ? text.size() : end + 2;
    }
    return start;
}
std::vector<std::string_view> arguments(std::string_view input) {
    std::vector<std::string_view> result;
    int depth = 0; std::size_t start = 0;
    for (std::size_t i = 0; i < input.size();) {
        const auto end = opaque_end(input, i);
        if (end != i) { i = end; continue; }
        if (input[i] == '(') ++depth;
        else if (input[i] == ')') { if (--depth < 0) throw DriverError("42000", "Invalid ODBC escape arguments."); }
        else if (input[i] == ',' && depth == 0) { result.push_back(trim(input.substr(start, i - start))); start = i + 1; }
        ++i;
    }
    if (depth) throw DriverError("42000", "Invalid ODBC escape arguments.");
    if (!input.empty()) result.push_back(trim(input.substr(start)));
    return result;
}
std::string translate(std::string_view text, unsigned depth);
std::string escape(std::string_view input, unsigned depth) {
    input = trim(input);
    const auto keyword_end = input.find_first_of(" \t\r\n");
    if (keyword_end == std::string_view::npos) throw DriverError("HYC00", "ODBC escape is not supported.");
    const auto keyword = upper(input.substr(0, keyword_end));
    const auto body = trim(input.substr(keyword_end));
    if (keyword == "D" || keyword == "T" || keyword == "TS" || keyword == "ESCAPE") {
        if (body.empty() || body.front() != '\'' || body.back() != '\'' || opaque_end(body, 0) != body.size())
            throw DriverError("42000", "ODBC escape requires a single string literal.");
        return (keyword == "D" ? "DATE " : keyword == "T" ? "TIME " : keyword == "TS" ? "TIMESTAMP " : "ESCAPE ") + std::string(body);
    }
    if (keyword == "OJ") return translate(body, depth + 1);
    if (keyword != "FN") throw DriverError("HYC00", "ODBC escape is not supported.");
    const auto open = body.find('(');
    if (open == std::string_view::npos || body.back() != ')') throw DriverError("42000", "Invalid ODBC function escape.");
    const auto function = upper(trim(body.substr(0, open)));
    const auto inside = trim(body.substr(open + 1, body.size() - open - 2));
    if (function == "NOW" || function == "CURDATE" || function == "CURTIME" || function == "USER") {
        if (!inside.empty()) throw DriverError("42000", "ODBC current-value function takes no arguments.");
        return function == "NOW" ? "CURRENT_TIMESTAMP" : function == "CURDATE" ? "CURRENT_DATE" : function == "CURTIME" ? "CURRENT_TIME" : "CURRENT_USER";
    }
    if (function == "CONVERT") {
        const auto args = arguments(inside);
        if (args.size() != 2) throw DriverError("42000", "ODBC CONVERT requires two arguments.");
        const std::map<std::string, std::string> types{{"SQL_CHAR","CHAR"},{"SQL_VARCHAR","VARCHAR"},{"SQL_WCHAR","NCHAR"},
            {"SQL_WVARCHAR","NVARCHAR"},{"SQL_SMALLINT","SMALLINT"},{"SQL_INTEGER","INTEGER"},{"SQL_BIGINT","BIGINT"},
            {"SQL_DECIMAL","DECIMAL"},{"SQL_NUMERIC","NUMERIC"},{"SQL_REAL","REAL"},{"SQL_FLOAT","DOUBLE PRECISION"},
            {"SQL_DOUBLE","DOUBLE PRECISION"},{"SQL_BIT","BOOLEAN"},{"SQL_BINARY","BINARY"},{"SQL_VARBINARY","VARBINARY"},
            {"SQL_DATE","DATE"},{"SQL_TYPE_DATE","DATE"},{"SQL_TIME","TIME"},{"SQL_TYPE_TIME","TIME"},
            {"SQL_TIMESTAMP","TIMESTAMP"},{"SQL_TYPE_TIMESTAMP","TIMESTAMP"}};
        const auto found = types.find(upper(args[1]));
        if (found == types.end()) throw DriverError("HYC00", "ODBC CONVERT target is not supported.");
        return "CAST(" + translate(args[0], depth + 1) + " AS " + found->second + ")";
    }
    const std::map<std::string, std::string> extract{{"YEAR","YEAR"},{"MONTH","MONTH"},{"DAYOFMONTH","DAY"},
        {"HOUR","HOUR"},{"MINUTE","MINUTE"},{"SECOND","SECOND"}};
    const auto extracted = extract.find(function);
    if (extracted != extract.end()) {
        if (arguments(inside).size() != 1) throw DriverError("42000", "ODBC datetime function requires one argument.");
        return "EXTRACT(" + extracted->second + " FROM " + translate(inside, depth + 1) + ")";
    }
    const std::map<std::string, std::string> functions{{"UCASE","UPPER"},{"LCASE","LOWER"},{"IFNULL","COALESCE"},
        {"UPPER","UPPER"},{"LOWER","LOWER"},{"LENGTH","LENGTH"},{"CHAR_LENGTH","CHAR_LENGTH"},{"OCTET_LENGTH","OCTET_LENGTH"},
        {"CONCAT","CONCAT"},{"SUBSTRING","SUBSTR"},{"LTRIM","LTRIM"},{"RTRIM","RTRIM"},{"REPLACE","REPLACE"},
        {"ABS","ABS"},{"CEILING","CEIL"},{"FLOOR","FLOOR"},{"MOD","MOD"},{"POWER","POWER"},{"ROUND","ROUND"},{"SQRT","SQRT"}};
    const auto found = functions.find(function);
    if (found == functions.end()) throw DriverError("HYC00", "ODBC scalar function is not supported.");
    static_cast<void>(arguments(inside));
    return found->second + "(" + translate(inside, depth + 1) + ")";
}
std::string translate(std::string_view text, unsigned depth) {
    if (depth > 64) throw DriverError("42000", "ODBC escape nesting limit exceeded.");
    std::string result;
    for (std::size_t i = 0; i < text.size();) {
        const auto end = opaque_end(text, i);
        if (end != i) { result.append(text.substr(i, end - i)); i = end; continue; }
        if (text[i] == '}') throw DriverError("42000", "Unexpected ODBC escape terminator.");
        if (text[i] != '{') { result += text[i++]; continue; }
        const auto start = ++i;
        unsigned braces = 1;
        for (; i < text.size();) {
            const auto opaque = opaque_end(text, i);
            if (opaque != i) { i = opaque; continue; }
            if (text[i] == '{') ++braces;
            if (text[i] == '}' && --braces == 0) break;
            ++i;
        }
        if (i == text.size()) throw DriverError("42000", "Unterminated ODBC escape.");
        result += escape(text.substr(start, i - start), depth);
        ++i;
    }
    return result;
}
}
std::string native_sql(std::string_view input) { return translate(input, 0); }
std::size_t parameter_count(std::string_view input) {
    std::size_t result = 0;
    for (std::size_t i = 0; i < input.size();) {
        const auto end = opaque_end(input, i);
        if (end != i) { i = end; continue; }
        if (input[i++] == '?') ++result;
    }
    return result;
}
} // namespace hwdbodbc
