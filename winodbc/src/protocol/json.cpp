#include "hwdbodbc/protocol.hpp"
#include <cmath>

namespace hwdbodbc {
Json parse_message(std::string_view body) {
    static_cast<void>(utf16(body));
    std::vector<std::set<std::string>> objects;
    try {
        auto result = Json::parse(body, [&](int depth, Json::parse_event_t event, Json& parsed) {
            if (depth > 64) throw DriverError("08S01", "Protocol nesting limit exceeded.", 8000);
            if (event == Json::parse_event_t::object_start) objects.emplace_back();
            else if (event == Json::parse_event_t::object_end) objects.pop_back();
            else if (event == Json::parse_event_t::key && !objects.back().insert(parsed.get<std::string>()).second)
                throw DriverError("08S01", "Duplicate protocol field.", 8000);
            return true;
        });
        if (!result.is_object()) throw DriverError("08S01", "Protocol message must be an object.", 8000);
        return result;
    } catch (const Json::exception&) {
        throw DriverError("08S01", "Malformed protocol JSON.", 8000);
    }
}
std::string string_field(const Json& object, const char* key) {
    const auto found = object.find(key);
    if (found == object.end() || !found->is_string()) throw DriverError("08S01", "Invalid protocol string field.", 8000);
    return found->get<std::string>();
}
std::uint64_t integer_field(const Json& object, const char* key, std::uint64_t maximum) {
    const auto found = object.find(key);
    if (found == object.end() || !found->is_number_integer()
        || (found->is_number_integer() && !found->is_number_unsigned() && found->get<std::int64_t>() < 0))
        throw DriverError("08S01", "Invalid protocol integer field.", 8000);
    const auto value = found->get<std::uint64_t>();
    if (value > maximum) throw DriverError("08S01", "Protocol integer exceeds the supported range.", 8000);
    return value;
}

namespace {
[[noreturn]] void invalid_response() { throw DriverError("08S01", "Invalid response fields.", 8000); }
const Json& required(const Json& object, const char* key, Json::value_t type) {
    const auto found = object.find(key);
    if (found == object.end() || found->type() != type) invalid_response();
    return *found;
}
void positive(const Json& object, const char* key, std::uint64_t maximum = 9007199254740991ULL) {
    if (!integer_field(object, key, maximum)) invalid_response();
}
void column(const Json& value) {
    if (!value.is_object()) invalid_response();
    static_cast<void>(string_field(value, "name"));
    static_cast<void>(string_field(value, "declared"));
    const auto name = string_field(value, "typeName");
    const std::set<std::string> names{"SMALLINT", "INTEGER", "BIGINT", "DECIMAL", "NUMERIC", "REAL", "DOUBLE PRECISION",
        "CHAR", "VARCHAR", "BINARY", "VARBINARY", "BOOLEAN", "DATE", "TIME", "TIME WITH TIME ZONE", "TIMESTAMP",
        "TIMESTAMP WITH TIME ZONE", "INTERVAL", "UNKNOWN"};
    if (!names.count(name)) invalid_response();
    for (const auto& field : std::vector<std::pair<const char*, std::uint64_t>>{{"length",65535},{"precision",38},
        {"scale",38},{"fractionalPrecision",6},{"leadingPrecision",9}})
        if (value.contains(field.first)) static_cast<void>(integer_field(value, field.first, field.second));
    if (name == "CHAR" || name == "VARCHAR" || name == "BINARY" || name == "VARBINARY") positive(value, "length", 65535);
    if (name == "DECIMAL" || name == "NUMERIC") {
        positive(value, "precision", 38);
        if (integer_field(value, "scale", 38) > integer_field(value, "precision", 38)) invalid_response();
    }
    if (name.find("TIME") == 0) static_cast<void>(integer_field(value, "fractionalPrecision", 6));
    if (name == "INTERVAL") {
        const std::string fields = " YEAR MONTH DAY HOUR MINUTE SECOND ";
        if (fields.find(" " + string_field(value, "startField") + " ") == std::string::npos
            || fields.find(" " + string_field(value, "endField") + " ") == std::string::npos) invalid_response();
        positive(value, "leadingPrecision", 9);
        if (value.contains("fractionalPrecision")) static_cast<void>(integer_field(value, "fractionalPrecision", 6));
    }
    if (value.contains("nullable")) {
        const auto nullable = string_field(value, "nullable");
        if (nullable != "YES" && nullable != "NO" && nullable != "UNKNOWN") invalid_response();
    }
}
void columns(const Json& values) {
    if (!values.is_array()) invalid_response();
    for (const auto& value : values) column(value);
}
}
void validate_response(const Json& message) {
    static_cast<void>(integer_field(message, "id"));
    const auto type = string_field(message, "type");
    if (type == "helloOk") {
        positive(message, "version"); positive(message, "maxMessageBytes", 16777216);
        positive(message, "defaultFetchSize", 100000);
        static_cast<void>(string_field(message, "server"));
        static_cast<void>(string_field(message, "mechanism"));
        if (message.contains("capabilities")) for (const auto& item : required(message, "capabilities", Json::value_t::array))
            if (!item.is_string()) invalid_response();
        if (message.contains("udp")) {
            const auto& udp = required(message, "udp", Json::value_t::object);
            if (integer_field(udp, "maxPacketSize", 65507) < 64) invalid_response();
            static_cast<void>(integer_field(udp, "sessionTimeoutMs"));
        }
    } else if (type == "authChallenge") static_cast<void>(string_field(message, "serverFirst"));
    else if (type == "authOk") {
        static_cast<void>(string_field(message, "serverFinal"));
        const auto& session = required(message, "session", Json::value_t::object);
        positive(session, "id"); static_cast<void>(string_field(session, "user"));
        static_cast<void>(string_field(session, "timeZone"));
        static_cast<void>(required(session, "autocommit", Json::value_t::boolean));
        if (!session.contains("tablespace") || (!session["tablespace"].is_null() && !session["tablespace"].is_string())) invalid_response();
    } else if (type == "error") {
        const auto state = string_field(message, "sqlState");
        if (state.size() != 5 || state.find_first_not_of("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ") != std::string::npos) invalid_response();
        static_cast<void>(integer_field(message, "code", INT_MAX));
        static_cast<void>(string_field(message, "message"));
        if (message.contains("position")) {
            const auto& position = required(message, "position", Json::value_t::object);
            positive(position, "line"); positive(position, "column");
            static_cast<void>(integer_field(position, "offset"));
        }
    } else if (type == "rows") {
        const auto& rows = required(message, "rows", Json::value_t::array);
        const auto more = required(message, "hasMore", Json::value_t::boolean).get<bool>();
        if (more) { positive(message, "cursor"); if (rows.empty()) invalid_response(); }
        else if (message.contains("cursor")) invalid_response();
        if (message.contains("columns")) columns(message["columns"]);
        for (const auto& row : rows) {
            if (!row.is_array() || (message.contains("columns") && row.size() != message["columns"].size())) invalid_response();
            for (const auto& cell : row) if (!(cell.is_primitive() && !cell.is_binary() && !cell.is_discarded())) invalid_response();
        }
    } else if (type == "ok") {
        static_cast<void>(string_field(message, "message"));
        if (message.contains("rowCount")) static_cast<void>(integer_field(message, "rowCount"));
    } else if (type == "prepared" || type == "description") {
        positive(message, "statement");
        const auto count = integer_field(message, "parameterCount", 65535);
        columns(required(message, "columns", Json::value_t::array));
        const auto& parameters = required(message, "parameters", Json::value_t::array);
        if (parameters.size() != count) invalid_response();
        for (std::size_t i = 0; i < parameters.size(); ++i) {
            column(parameters[i]);
            if (integer_field(parameters[i], "index", 65535) != i + 1) invalid_response();
        }
        const auto kind = string_field(message, "resultKind");
        if (kind != "rows" && kind != "ok") invalid_response();
    } else if (type == "cancelAck") {
        positive(message, "targetId");
        const auto status = string_field(message, "status");
        if (status != "accepted" && status != "notRunning" && status != "tooLate") invalid_response();
    } else if (type == "bye") {
        if (message.contains("rolledBack")) static_cast<void>(required(message, "rolledBack", Json::value_t::boolean));
    } else if (type != "preparedClosed" && type != "cursorClosed" && type != "pong") invalid_response();
}
} // namespace hwdbodbc
