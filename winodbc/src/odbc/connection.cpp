#include "hwdbodbc/connection.hpp"
#include <charconv>
#include <cctype>

namespace hwdbodbc {
namespace {
std::string trim(std::string_view value) {
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string_view::npos) return {};
    return std::string(value.substr(first, value.find_last_not_of(" \t\r\n") - first + 1));
}
std::string upper(std::string value) {
    for (auto& byte : value) if (byte >= 'a' && byte <= 'z') byte = static_cast<char>(byte - 'a' + 'A');
    return value;
}
std::string get_option(const Options& options, const char* name, const char* fallback = "") {
    const auto found = options.find(name);
    return found == options.end() ? fallback : found->second;
}
Options data_source(const std::string& name) {
    const auto wide = utf16(name);
    if (wide.empty() || wide.size() > 32 || name.find_first_of("\\[]{}(),;?*=!@") != std::string::npos || name.find('\0') != std::string::npos)
        throw DriverError("IM002", "Invalid data source name.");
    const auto path = L"SOFTWARE\\ODBC\\ODBC.INI\\" + wide;
    HKEY key = nullptr;
    auto status = RegOpenKeyExW(HKEY_CURRENT_USER, path.c_str(), 0, KEY_QUERY_VALUE, &key);
    if (status == ERROR_FILE_NOT_FOUND) status = RegOpenKeyExW(HKEY_LOCAL_MACHINE, path.c_str(), 0, KEY_QUERY_VALUE, &key);
    if (status != ERROR_SUCCESS) throw DriverError("IM002", "Data source name not found.");
    struct CloseKey { HKEY key; ~CloseKey() { RegCloseKey(key); } } close_key{key};
    Options result;
    const std::pair<const wchar_t*, const char*> fields[] = {{L"Server","SERVER"},{L"Port","PORT"},{L"UID","UID"},
        {L"Tablespace","TABLESPACE"},{L"TimeZone","TIMEZONE"},{L"Transport","TRANSPORT"},{L"SSL","SSL"},
        {L"SSLCA","SSLCA"},{L"SSLVerify","SSLVERIFY"},{L"FetchSize","FETCHSIZE"}};
    for (const auto& field : fields) {
        DWORD size = 0;
        status = RegGetValueW(key, nullptr, field.first, RRF_RT_REG_SZ, nullptr, nullptr, &size);
        if (status == ERROR_FILE_NOT_FOUND) continue;
        if (status != ERROR_SUCCESS || size > 65536 || size % sizeof(wchar_t)) throw DriverError("IM002", "Invalid data source setting.");
        std::wstring value(static_cast<std::size_t>(size) / sizeof(wchar_t), 0);
        if (RegGetValueW(key, nullptr, field.first, RRF_RT_REG_SZ, nullptr, value.data(), &size) != ERROR_SUCCESS)
            throw DriverError("IM002", "Could not read data source setting.");
        value.resize(static_cast<std::size_t>(size) / sizeof(wchar_t));
        while (!value.empty() && value.back() == 0) value.pop_back();
        if (value.find(L'\0') != std::wstring::npos) throw DriverError("IM002", "Data source setting contains a NUL character.");
        result.emplace(field.second, utf8(value));
    }
    return result;
}
}
Options parse_connection_string(std::string_view text) {
    if (text.find('\0') != std::string_view::npos) throw DriverError("HY000", "Connection string contains a NUL character.");
    Options result;
    std::size_t position = 0;
    while (position < text.size()) {
        while (position < text.size() && (text[position] == ';' || text[position] == ' ' || text[position] == '\t')) ++position;
        if (position == text.size()) break;
        const auto equals = text.find('=', position);
        const auto separator = text.find(';', position);
        if (equals == std::string_view::npos || (separator != std::string_view::npos && separator < equals))
            throw DriverError("HY000", "Invalid connection string syntax.");
        const auto key = upper(trim(text.substr(position, equals - position)));
        if (key.empty()) throw DriverError("HY000", "Connection string keyword is empty.");
        position = equals + 1;
        while (position < text.size() && (text[position] == ' ' || text[position] == '\t')) ++position;
        std::string value;
        if (position < text.size() && text[position] == '{') {
            ++position;
            bool closed = false;
            while (position < text.size()) {
                const auto byte = text[position++];
                if (byte != '}') { value += byte; continue; }
                if (position < text.size() && text[position] == '}') { value += '}'; ++position; }
                else { closed = true; break; }
            }
            if (!closed) throw DriverError("HY000", "Unterminated connection string value.");
            while (position < text.size() && (text[position] == ' ' || text[position] == '\t')) ++position;
            if (position < text.size() && text[position] != ';') throw DriverError("HY000", "Invalid connection string suffix.");
        } else {
            const auto end = text.find(';', position);
            value = trim(text.substr(position, end == std::string_view::npos ? text.size() - position : end - position));
            position = end == std::string_view::npos ? text.size() : end;
        }
        // ODBC 규약대로 중복 키는 처음 나온 값을 사용한다.
        result.emplace(key, std::move(value));
        if (position < text.size()) ++position;
    }
    return result;
}
std::string connection_string(const Options& options) {
    std::string result;
    for (const auto& item : options) {
        if (item.first == "PWD" || item.first == "PASSWORD") continue;
        result += item.first + "={";
        for (const auto byte : item.second) { result += byte; if (byte == '}') result += '}'; }
        result += "};";
    }
    return result;
}
unsigned option_integer(const Options& options, const char* name, unsigned fallback, unsigned minimum, unsigned maximum) {
    const auto found = options.find(name);
    if (found == options.end()) return fallback;
    unsigned value = 0;
    const auto& input = found->second;
    const auto conversion = std::from_chars(input.data(), input.data() + input.size(), value);
    if (conversion.ec != std::errc() || conversion.ptr != input.data() + input.size() || value < minimum || value > maximum)
        throw DriverError("HY024", "Invalid numeric connection option.");
    return value;
}
bool option_boolean(const Options& options, const char* name, bool fallback) {
    const auto found = options.find(name);
    if (found == options.end()) return fallback;
    const auto value = upper(found->second);
    if (value == "TRUE" || value == "1" || value == "YES") return true;
    if (value == "FALSE" || value == "0" || value == "NO") return false;
    throw DriverError("HY024", "Invalid boolean connection option.");
}
void open_connection(Connection& connection, Options& options) {
    if (connection.connected) throw DriverError("08002", "Connection is already open.");
    if (options.count("DSN")) {
        const auto defaults = data_source(options.at("DSN"));
        for (const auto& item : defaults) options.emplace(item);
    }
    if (!options.count("UID") || options.at("UID").empty()) throw DriverError("28000", "User name is required.");
    if (!options.count("PWD")) throw DriverError("28000", "Password is required.");
    const auto host = get_option(options, "SERVER", "localhost");
    const auto port = option_integer(options, "PORT", 7410, 1, 65535);
    const auto fetch_size = option_integer(options, "FETCHSIZE", 500, 1, 100000);
    if (upper(get_option(options, "TRANSPORT", "TCP")) != "TCP") throw DriverError("HYC00", "Transport is not implemented yet.");
    const bool ssl = option_boolean(options, "SSL", false);
    static_cast<void>(option_boolean(options, "SSLVERIFY", true));
    if (ssl || options.count("SSLCA")) throw DriverError("HYC00", "TLS transport is not implemented yet.");
    options.emplace("SERVER", host);
    options.emplace("PORT", std::to_string(port));
    options.emplace("FETCHSIZE", std::to_string(fetch_size));
    for (const auto& item : options) {
        if (item.first != "DSN" && item.first != "DRIVER" && item.first != "SERVER" && item.first != "PORT" && item.first != "UID"
            && item.first != "PWD" && item.first != "TABLESPACE" && item.first != "TIMEZONE" && item.first != "TRANSPORT"
            && item.first != "FETCHSIZE" && item.first != "SSL" && item.first != "SSLVERIFY" && item.first != "SSLCA")
            connection.diagnostic.append("01S00", "Invalid connection string attribute was ignored.");
    }
    auto session = std::make_shared<Session>(tcp_transport(host, static_cast<unsigned short>(port), connection.login_timeout));
    session->login(options.at("UID"), options.at("PWD"), get_option(options, "TABLESPACE"), get_option(options, "TIMEZONE"), connection.login_timeout);
    if (connection.autocommit == SQL_AUTOCOMMIT_OFF)
        session->request({{"type", "execute"}, {"sql", "SET AUTOCOMMIT OFF"}}, "result", connection.connection_timeout);
    connection.server_name = host;
    connection.fetch_size = fetch_size;
    connection.session = std::move(session);
    connection.connected = true;
}
} // namespace hwdbodbc
