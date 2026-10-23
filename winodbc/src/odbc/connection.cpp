#include "hwdbodbc/connection.hpp"
#include "hwdbodbc/statement.hpp"
#include <dpapi.h>
#include <cstring>
#include <charconv>
#include <cctype>

namespace hwdbodbc {
struct ReconnectState {
    Options settings;
    std::vector<unsigned char> password;
    std::size_t password_size;
    explicit ReconnectState(const Options& options) : password_size(options.at("PWD").size()) {
        for (const auto& item : options) if (item.first != "PWD" && item.first != "PASSWORD" && item.first != "DSN") settings.emplace(item);
        if (password_size > (std::numeric_limits<DWORD>::max)() - 15U) throw DriverError("HY090", "Password exceeds the protected memory size limit.");
        password.resize((std::max)(std::size_t{16},(password_size + 15) / 16 * 16));
        if (password_size) std::memcpy(password.data(),options.at("PWD").data(),password_size);
        if (!CryptProtectMemory(password.data(),static_cast<DWORD>(password.size()),CRYPTPROTECTMEMORY_SAME_PROCESS)) {
            const auto error = GetLastError(); SecureZeroMemory(password.data(),password.size());
            throw DriverError("HY000", "Could not protect reconnection credentials.",static_cast<SQLINTEGER>(error));
        }
    }
    ~ReconnectState() { if (!password.empty()) SecureZeroMemory(password.data(),password.size()); }
    Options restore() const {
        Options result = settings;
        struct Plain { std::vector<unsigned char> bytes; ~Plain() { if (!bytes.empty()) SecureZeroMemory(bytes.data(),bytes.size()); } } plain{password};
        if (!CryptUnprotectMemory(plain.bytes.data(),static_cast<DWORD>(plain.bytes.size()),CRYPTPROTECTMEMORY_SAME_PROCESS))
            throw DriverError("HY000", "Could not restore reconnection credentials.",static_cast<SQLINTEGER>(GetLastError()));
        result.emplace("PWD",std::string(reinterpret_cast<const char*>(plain.bytes.data()),password_size)); return result;
    }
};
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
    const auto transport = upper(get_option(options, "TRANSPORT", "TCP"));
    const bool ssl = option_boolean(options, "SSL", false);
    const bool has_ca = options.count("SSLCA") != 0;
    const bool verify = option_boolean(options, "SSLVERIFY", true);
    // SSL은 TCP에만 적용된다. UDP 구간은 암호화하지 않는다.
    if (transport != "TCP" && (ssl || has_ca)) throw DriverError("HYC00", "SSL applies to TCP only.");
    if (transport != "TCP") throw DriverError("HYC00", "Transport is not implemented yet.");
    if (has_ca && !ssl) throw DriverError("HY024", "SSLCA requires SSL=true.");
    if (!ssl && !verify) throw DriverError("HY024", "SSLVERIFY=false requires SSL=true.");
    if (has_ca && !verify) throw DriverError("HY024", "SSLCA and SSLVERIFY=false cannot be used together.");
    options.emplace("SERVER", host);
    options.emplace("PORT", std::to_string(port));
    options.emplace("FETCHSIZE", std::to_string(fetch_size));
    for (const auto& item : options) {
        if (item.first != "DSN" && item.first != "DRIVER" && item.first != "SERVER" && item.first != "PORT" && item.first != "UID"
            && item.first != "PWD" && item.first != "TABLESPACE" && item.first != "TIMEZONE" && item.first != "TRANSPORT"
            && item.first != "FETCHSIZE" && item.first != "SSL" && item.first != "SSLVERIFY" && item.first != "SSLCA")
            connection.diagnostic.append("01S00", "Invalid connection string attribute was ignored.");
    }
    const auto reconnect = std::make_shared<ReconnectState>(options);
    const auto deadline = connection.login_timeout ? std::chrono::steady_clock::now() + std::chrono::seconds(connection.login_timeout) : TransportDeadline::max();
    std::shared_ptr<Session> session;
    if (ssl) {
        TlsOptions tls;
        tls.verify = verify;
        tls.serverName = host;
        if (has_ca) tls.caCertificates = tls_load_pem_certificates(options.at("SSLCA"));
        session = std::make_shared<Session>(tls_transport(host, static_cast<unsigned short>(port), connection.login_timeout, deadline, std::move(tls)));
    } else {
        session = std::make_shared<Session>(tcp_transport(host, static_cast<unsigned short>(port), connection.login_timeout, deadline));
    }
    session->login(options.at("UID"), options.at("PWD"), get_option(options, "TABLESPACE"), get_option(options, "TIMEZONE"), connection.login_timeout, deadline);
    if (connection.autocommit == SQL_AUTOCOMMIT_OFF)
        session->request({{"type", "execute"}, {"sql", "SET AUTOCOMMIT OFF"}}, "result", connection.connection_timeout);
    connection.server_name = host;
    connection.fetch_size = fetch_size;
    connection.session = std::move(session);
    connection.reconnect = reconnect;
    connection.connected = true;
}
void reset_connection(Connection& connection) {
    if (!connection.connected || !connection.session) throw DriverError("08003", "Connection is not open.");
    if (connection.session->dead()) throw DriverError("08S01", "A dead connection cannot be reset.");
    if (!connection.reconnect) { connection.session->abort(); throw DriverError("HYC00", "Connection has no reconnection state and must be discarded."); }
    for (const auto& statement : connection_statements(connection)) {
        settle_local_cancellation(*statement);
        if (statement->parameter_execution) throw DriverError("HY010", "Complete or cancel parameter data before reset.");
    }
    auto options = connection.reconnect->restore();
    struct Erase { Options& options; ~Erase() { auto& password = options.at("PWD"); if (!password.empty()) SecureZeroMemory(password.data(),password.size()); } } erase{options};
    // 재인증 전에 기존 세션을 닫아 커서·준비 ID·미커밋 변경·잠금을 서버에서 폐기한다.
    try {
        connection.session->close();
        for (const auto& statement : connection_statements(connection)) {
            release_statement(*statement); statement->executed = false; statement->row_count = 0;
            statement->max_rows = 0; statement->retrieve_data = SQL_RD_ON; statement->query_timeout = 0;
            statement->metadata_id = SQL_FALSE; statement->noscan = SQL_NOSCAN_OFF; statement->auto_ipd = false;
            statement->cursor_name = statement->automatic_cursor_name; statement->diagnostic.clear();
        }
        for (const auto& descriptor : connection_descriptors(connection)) {
            descriptor->records.clear(); descriptor->array_size = 1; descriptor->bind_type = SQL_BIND_BY_COLUMN;
            descriptor->bind_offset = nullptr; descriptor->array_status = nullptr; descriptor->rows_processed = nullptr;
            descriptor->diagnostic.clear();
        }
        connection.autocommit = SQL_AUTOCOMMIT_ON; connection.connected = false;
        open_connection(connection,options);
        connection.login_timeout = 0; connection.connection_timeout = 0; connection.metadata_id = SQL_FALSE; connection.window = nullptr;
        connection.diagnostic.clear();
    } catch (...) {
        // 초기화 실패를 성공으로 풀에 돌리지 않는다. Manager가 CONNECTION_DEAD로 폐기한다.
        connection.connected = true; connection.session->abort(); throw;
    }
}
} // namespace hwdbodbc
