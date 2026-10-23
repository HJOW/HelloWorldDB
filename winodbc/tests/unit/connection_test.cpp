#include "hwdbodbc/connection.hpp"
#include "../helpers/check.hpp"

using namespace hwdbodbc;
template<class F> void error(F&& function, const char* state) {
    try { function(); check(false, "expected connection option error"); }
    catch (const DriverError& value) { check(value.state == state, "connection option SQLSTATE"); }
}
int main() {
    return run_checks([] {
        const auto options = parse_connection_string(" Server = localhost ;UID={한글;=}}😀};PWD={ abc;}}def };Port=7410;port=1234;Empty=; ");
        check(options.at("SERVER") == "localhost" && options.at("UID") == "한글;=}😀", "ODBC escaped braces/semicolon");
        check(options.at("PWD") == " abc;}def " && options.at("EMPTY").empty(), "password whitespace/empty option");
        check(option_integer(options, "PORT", 0, 1, 65535) == 7410, "first duplicate wins");
        const auto sanitized = connection_string(options);
        check(sanitized.find("PWD") == std::string::npos && sanitized.find("abc") == std::string::npos, "no password output");
        auto expected = options; expected.erase("PWD");
        check(parse_connection_string(sanitized) == expected, "connection string inverse");
        error([] { parse_connection_string("Server"); }, "HY000");
        error([] { parse_connection_string("UID={abc"); }, "HY000");
        error([] { parse_connection_string("UID={abc}def"); }, "HY000");
        error([] { parse_connection_string(std::string("UID=a\0b", 7)); }, "HY000");
        for (const auto* port : {"0", "65536", "-1", "1.5", "4294967296", ""})
            error([&] { option_integer({{"PORT", port}}, "PORT", 7410, 1, 65535); }, "HY024");
        check(option_boolean({{"SSLVERIFY", "TRUE"}}, "SSLVERIFY", false), "boolean uppercase");
        check(!option_boolean({{"SSL", "0"}}, "SSL", true), "boolean zero");
        error([] { option_boolean({{"SSL", "yesplease"}}, "SSL", false); }, "HY024");
        SQLHENV env = nullptr; SQLHDBC dbc = nullptr;
        check(SQLAllocHandle(SQL_HANDLE_ENV, nullptr, &env) == SQL_SUCCESS, "ENV allocate");
        check(SQLSetEnvAttr(env, SQL_ATTR_ODBC_VERSION, reinterpret_cast<SQLPOINTER>(SQL_OV_ODBC3), 0) == SQL_SUCCESS, "version");
        check(SQLAllocHandle(SQL_HANDLE_DBC, env, &dbc) == SQL_SUCCESS, "DBC allocate");
        const auto call = [&](const wchar_t* value) {
            return SQLDriverConnectW(dbc, nullptr, reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(value)), SQL_NTS, nullptr, 0, nullptr, SQL_DRIVER_NOPROMPT);
        };
        const auto state = [&] {
            SQLCHAR code[6]{};
            check(SQLGetDiagRec(SQL_HANDLE_DBC, dbc, 1, code, nullptr, nullptr, 0, nullptr) == SQL_SUCCESS, "connection diagnostic");
            return std::string(reinterpret_cast<char*>(code));
        };
        check(call(L"UID=SYSTEM;PWD=secret;Port=0;") == SQL_ERROR, "port validation before network");
        check(call(L"UID=SYSTEM;PWD=secret;Transport=UDP;") == SQL_ERROR, "unimplemented transport rejected");
        // SSL=true는 TLS로 접속하므로 서버가 없어도 HYC00이 아니라 08001이다.
        check(call(L"UID=SYSTEM;PWD=secret;SSL=true;") == SQL_ERROR, "TLS without server fails");
        check(state() == "08001", "TLS connection failure SQLSTATE");
        check(call(L"UID=SYSTEM;PWD=secret;SSLCA=C:\\none.pem;") == SQL_ERROR, "SSLCA requires SSL=true");
        check(state() == "HY024", "SSLCA without SSL SQLSTATE");
        check(call(L"UID=SYSTEM;PWD=secret;SSLVERIFY=false;") == SQL_ERROR, "SSLVERIFY=false requires SSL=true");
        check(state() == "HY024", "SSLVERIFY without SSL SQLSTATE");
        check(call(L"UID=SYSTEM;PWD=secret;SSL=true;SSLCA=C:\\none.pem;SSLVERIFY=false;") == SQL_ERROR, "SSLCA with SSLVERIFY=false");
        check(state() == "HY024", "SSLCA and no-verify SQLSTATE");
        check(call(L"UID=SYSTEM;") == SQL_ERROR, "no default password");
        SQLWCHAR catalog[4]{1,1,1,1}; SQLINTEGER length = -1;
        check(SQLGetConnectAttrW(dbc, SQL_ATTR_CURRENT_CATALOG, catalog, sizeof(catalog), &length) == SQL_SUCCESS && !catalog[0] && length == 0, "no catalog");
        check(SQLSetConnectAttrW(dbc, SQL_ATTR_CURRENT_CATALOG, const_cast<wchar_t*>(L"SYSTEM"), SQL_NTS) == SQL_ERROR, "catalog cannot change tablespace");
        struct { SQLUINTEGER value = 0; SQLUINTEGER canary = 0xabcdef12; } output;
        check(SQLGetConnectAttr(dbc, SQL_ATTR_LOGIN_TIMEOUT, &output.value, 0, &length) == SQL_SUCCESS && output.value == 0
            && output.canary == 0xabcdef12 && length == 4, "connection scalar output width");
        check(SQLSetConnectAttr(dbc, SQL_ATTR_LOGIN_TIMEOUT, reinterpret_cast<SQLPOINTER>(5), 0) == SQL_SUCCESS, "login timeout set");
        check(SQLSetConnectAttr(dbc, SQL_ATTR_LOGIN_TIMEOUT, reinterpret_cast<SQLPOINTER>(static_cast<std::uintptr_t>(UINT_MAX)), 0) == SQL_ERROR, "timeout overflow");
        check(SQLDisconnect(dbc) == SQL_ERROR, "disconnect before connect");
        check(SQLFreeHandle(SQL_HANDLE_DBC, dbc) == SQL_SUCCESS && SQLFreeHandle(SQL_HANDLE_ENV, env) == SQL_SUCCESS, "connection cleanup");
    });
}
