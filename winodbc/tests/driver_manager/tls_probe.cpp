// TLS 접속 탐색기이다. Manager → 드라이버 DLL → 실제 또는 가짜 TLS 서버 경로를 시험한다.
//
// 사용법: hwdb_tls_probe <드라이버DLL> <포트> <quick|functional> <추가연결문자열>
//   quick: 접속 한 번을 시도하고 STATE=... 를 출력한다. 성공·실패 모두 종료 코드 0이다.
//   functional: 접속 뒤 CRUD·분할 fetch·트랜잭션·잠금 취소를 수행한다. 실패하면 0이 아니다.
// 비밀번호·SCRAM 비밀키는 출력·진단에 남기지 않는다.
#include <winsock2.h>
#include <ws2tcpip.h>
#include "hwdbodbc/odbc.hpp"
#include "../helpers/check.hpp"
#include <chrono>
#include <cstring>
#include <filesystem>
#include <future>
#include <iostream>
#include <odbcinst.h>
#include <objbase.h>
#include <string>
#include <thread>

namespace {
SQLWCHAR* wide(const std::wstring& text) { return reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(text.c_str())); }
void expect_stmt(SQLRETURN result, SQLHSTMT statement, const char* operation) {
    if (SQL_SUCCEEDED(result)) return;
    SQLCHAR state[6]{}, message[1024]{}; SQLINTEGER native = 0;
    SQLGetDiagRec(SQL_HANDLE_STMT, statement, 1, state, &native, message, 1024, nullptr);
    std::cerr << operation << " STATE=" << state << " NATIVE=" << native << " MESSAGE=" << message << '\n';
    check(false, operation);
}
std::string narrow_text(const wchar_t* wide) {
    char narrow[4096]{};
    WideCharToMultiByte(CP_UTF8, 0, wide, -1, narrow, sizeof(narrow), nullptr, nullptr);
    std::string text = narrow;
    for (auto& byte : text) if (byte == '\r' || byte == '\n') byte = ' ';
    return text;
}
std::string state_of(SQLHDBC connection, SQLINTEGER* native = nullptr, std::string* message = nullptr) {
    SQLWCHAR state[6]{}, text[2048]{};
    SQLINTEGER number = 0;
    if (SQLGetDiagRecW(SQL_HANDLE_DBC, connection, 1, state, &number, text, 2048, nullptr) != SQL_SUCCESS) return "NO_DIAG";
    if (native) *native = number;
    if (message) *message = narrow_text(reinterpret_cast<wchar_t*>(text));
    char narrow[6]{};
    WideCharToMultiByte(CP_UTF8, 0, reinterpret_cast<wchar_t*>(state), -1, narrow, 6, nullptr, nullptr);
    return narrow;
}
class NetworkBootstrap {
public:
    NetworkBootstrap() {
        WSADATA data{};
        check(WSAStartup(MAKEWORD(2, 2), &data) == 0, "initialize system Winsock catalog before registry isolation");
        const auto socket = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        check(socket != INVALID_SOCKET, "preload system TCP provider");
        closesocket(socket);
    }
    ~NetworkBootstrap() { WSACleanup(); }
};
class RegistrySandbox {
    std::wstring path;
    HKEY root = nullptr;
public:
    RegistrySandbox() {
        GUID guid{};
        check(CoCreateGuid(&guid) == S_OK, "registry sandbox GUID");
        wchar_t text[64]{};
        check(StringFromGUID2(guid, text, 64) > 0, "registry sandbox GUID format");
        path = L"Software\\HelloWorldDB\\ODBC-Tests\\" + std::wstring(text);
        check(RegCreateKeyExW(HKEY_CURRENT_USER, path.c_str(), 0, nullptr, REG_OPTION_NON_VOLATILE,
            KEY_ALL_ACCESS, nullptr, &root, nullptr) == ERROR_SUCCESS, "create private registry sandbox");
        if (RegOverridePredefKey(HKEY_LOCAL_MACHINE, root) != ERROR_SUCCESS) {
            RegCloseKey(root); root = nullptr;
            RegDeleteTreeW(HKEY_CURRENT_USER, path.c_str());
            check(false, "map process registry sandbox");
        }
        HKEY user = nullptr;
        const auto user_status = RegCreateKeyExW(root, L"USER", 0, nullptr, REG_OPTION_NON_VOLATILE,
            KEY_ALL_ACCESS, nullptr, &user, nullptr);
        if (user_status != ERROR_SUCCESS || RegOverridePredefKey(HKEY_CURRENT_USER, user) != ERROR_SUCCESS) {
            if (user) RegCloseKey(user);
            RegOverridePredefKey(HKEY_LOCAL_MACHINE, nullptr);
            RegCloseKey(root); root = nullptr;
            RegDeleteTreeW(HKEY_CURRENT_USER, path.c_str());
            check(false, "map private user DSN registry");
        }
        RegCloseKey(user);
    }
    ~RegistrySandbox() {
        RegOverridePredefKey(HKEY_CURRENT_USER, nullptr);
        RegOverridePredefKey(HKEY_LOCAL_MACHINE, nullptr);
        if (root) RegCloseKey(root);
        if (path.rfind(L"Software\\HelloWorldDB\\ODBC-Tests\\{", 0) == 0)
            RegDeleteTreeW(HKEY_CURRENT_USER, path.c_str());
    }
};
struct Registration {
    HMODULE installer = nullptr;
    decltype(&SQLInstallDriverExW) install_function = nullptr;
    decltype(&SQLRemoveDriverW) remove_function = nullptr;
    std::wstring name;
    bool installed = false;
    explicit Registration(const wchar_t* filename) {
        installer = LoadLibraryExW(L"odbccp32.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
        check(installer != nullptr, "load system ODBC installer");
        const auto install_address = GetProcAddress(installer, "SQLInstallDriverExW");
        const auto remove_address = GetProcAddress(installer, "SQLRemoveDriverW");
        check(install_address && remove_address, "installer entry points");
        std::memcpy(&install_function, &install_address, sizeof(install_address));
        std::memcpy(&remove_function, &remove_address, sizeof(remove_address));
        GUID guid{};
        check(CoCreateGuid(&guid) == S_OK, "unique driver registration name");
        wchar_t guid_text[64]{};
        check(StringFromGUID2(guid, guid_text, 64) > 0, "GUID format");
        const std::wstring guid_value(guid_text);
        name = L"HelloWorldDB TLS Test " + guid_value.substr(1, guid_value.size() - 2);
        std::wstring attributes = name;
        attributes += L'\0';
        attributes += L"Driver=" + std::filesystem::absolute(filename).wstring();
        attributes += L'\0';
        attributes += L"DriverODBCVer=03.00";
        attributes += L'\0';
        attributes += L'\0';
        wchar_t output[32768]{}; WORD length = 0; DWORD usage = 0;
        const auto directory = std::filesystem::absolute(filename).parent_path().wstring();
        installed = install_function(attributes.c_str(), directory.c_str(), output, 32768, &length,
            ODBC_INSTALL_COMPLETE, &usage) != FALSE;
        check(installed && usage == 1, "isolated test driver registration");
    }
    ~Registration() {
        if (installed) {
            DWORD usage = 99;
            if (!remove_function(name.c_str(), FALSE, &usage) || usage != 0)
                std::wcerr << L"FAILED TO REMOVE TEST REGISTRATION: " << name << L'\n';
        }
        if (installer) FreeLibrary(installer);
    }
};

void sql(SQLHSTMT statement, const std::wstring& text) { expect_stmt(SQLExecDirectW(statement, wide(text), SQL_NTS), statement, "TLS SQL"); }
int fetch_count(SQLHSTMT statement) {
    int rows = 0;
    while (SQLFetch(statement) == SQL_SUCCESS) ++rows;
    return rows;
}
}

int wmain(int argc, wchar_t** argv) {
    std::cout << std::unitbuf;
    return run_checks([&] {
        check(argc == 5, "usage: hwdb_tls_probe DRIVER PORT MODE EXTRA");
        NetworkBootstrap network_bootstrap;
        RegistrySandbox registry_sandbox;
        Registration registration(argv[1]);
        const std::wstring port = argv[2];
        const std::wstring mode = argv[3];
        const std::wstring extra = argv[4];
        SQLHENV environment = nullptr;
        check(SQLAllocHandle(SQL_HANDLE_ENV, nullptr, &environment) == SQL_SUCCESS, "TLS ENV");
        check(SQLSetEnvAttr(environment, SQL_ATTR_ODBC_VERSION, reinterpret_cast<SQLPOINTER>(SQL_OV_ODBC3), 0) == SQL_SUCCESS, "TLS version");
        const auto base = L"DRIVER={" + registration.name + L"};Server=127.0.0.1;Port=" + port + L";UID=SYSTEM;PWD=HelloWorldDB;";
        if (mode == L"quick") {
            SQLHDBC connection = nullptr;
            check(SQLAllocHandle(SQL_HANDLE_DBC, environment, &connection) == SQL_SUCCESS, "TLS quick DBC");
            const auto rc = SQLDriverConnectW(connection, nullptr, wide(base + extra), SQL_NTS, nullptr, 0, nullptr, SQL_DRIVER_NOPROMPT);
            std::cout << "RC=" << rc << '\n';
            if (SQL_SUCCEEDED(rc)) {
                std::cout << "STATE=SUCCESS\n";
                check(SQLDisconnect(connection) == SQL_SUCCESS, "TLS quick disconnect");
            } else {
                SQLINTEGER native = 0;
                std::string message;
                std::cout << "STATE=" << state_of(connection, &native, &message) << '\n';
                std::cout << "NATIVE=" << native << '\n';
                std::cout << "MESSAGE=" << message << '\n';
            }
            check(SQLFreeHandle(SQL_HANDLE_DBC, connection) == SQL_SUCCESS, "TLS quick DBC free");
        } else if (mode == L"functional") {
            SQLHDBC connection = nullptr;
            check(SQLAllocHandle(SQL_HANDLE_DBC, environment, &connection) == SQL_SUCCESS, "TLS functional DBC");
            const auto rc = SQLDriverConnectW(connection, nullptr, wide(base + extra), SQL_NTS, nullptr, 0, nullptr, SQL_DRIVER_NOPROMPT);
            if (!SQL_SUCCEEDED(rc)) {
                std::cerr << "functional connect STATE=" << state_of(connection) << '\n';
                check(false, "TLS functional connect");
            }
            SQLHSTMT statement = nullptr;
            check(SQLAllocHandle(SQL_HANDLE_STMT, connection, &statement) == SQL_SUCCESS, "TLS STMT");
            sql(statement, L"DROP TABLE IF EXISTS Q10_TLS");
            sql(statement, L"CREATE TABLE Q10_TLS (ID INTEGER PRIMARY KEY, TXT VARCHAR(50))");
            sql(statement, L"INSERT INTO Q10_TLS VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d'),(5,'e'),(6,'f'),(7,'g'),(8,'h'),(9,'i')");
            sql(statement, L"SELECT ID FROM Q10_TLS ORDER BY ID");
            check(fetch_count(statement) == 9, "TLS multi-batch fetch over encrypted records");
            expect_stmt(SQLCloseCursor(statement), statement, "TLS fetch close");
            check(SQLSetConnectAttr(connection, SQL_ATTR_AUTOCOMMIT, reinterpret_cast<SQLPOINTER>(SQL_AUTOCOMMIT_OFF), 0) == SQL_SUCCESS, "TLS autocommit off");
            sql(statement, L"UPDATE Q10_TLS SET TXT='changed' WHERE ID=1");
            check(SQLEndTran(SQL_HANDLE_DBC, connection, SQL_ROLLBACK) == SQL_SUCCESS, "TLS rollback");
            sql(statement, L"SELECT TXT FROM Q10_TLS WHERE ID=1");
            check(SQLFetch(statement) == SQL_SUCCESS, "TLS rollback fetch");
            SQLWCHAR value[64]{}; SQLLEN length = 0;
            expect_stmt(SQLGetData(statement, 1, SQL_C_WCHAR, value, sizeof(value), &length), statement, "TLS rollback data");
            check(std::wstring(reinterpret_cast<wchar_t*>(value)) == L"a", "TLS rollback restores value");
            expect_stmt(SQLCloseCursor(statement), statement, "TLS rollback close");
            // 잠금 대기 문장 하나만 취소한다. 앞선 변경은 유지되어야 한다.
            SQLHDBC second = nullptr;
            check(SQLAllocHandle(SQL_HANDLE_DBC, environment, &second) == SQL_SUCCESS, "TLS second DBC");
            const auto rc2 = SQLDriverConnectW(second, nullptr, wide(base + extra), SQL_NTS, nullptr, 0, nullptr, SQL_DRIVER_NOPROMPT);
            if (!SQL_SUCCEEDED(rc2)) {
                std::cerr << "second connect STATE=" << state_of(second) << '\n';
                check(false, "TLS second connect");
            }
            SQLHSTMT holder = nullptr, waiter = nullptr;
            check(SQLAllocHandle(SQL_HANDLE_STMT, connection, &holder) == SQL_SUCCESS, "TLS holder STMT");
            check(SQLAllocHandle(SQL_HANDLE_STMT, second, &waiter) == SQL_SUCCESS, "TLS waiter STMT");
            check(SQLSetConnectAttr(second, SQL_ATTR_AUTOCOMMIT, reinterpret_cast<SQLPOINTER>(SQL_AUTOCOMMIT_OFF), 0) == SQL_SUCCESS, "TLS second autocommit off");
            sql(holder, L"UPDATE Q10_TLS SET TXT='locked' WHERE ID=2");
            std::future<SQLRETURN> pending;
            {
                std::promise<void> entered;
                auto started = entered.get_future();
                pending = std::async(std::launch::async, [&] {
                    entered.set_value();
                    return SQLExecDirectW(waiter, wide(std::wstring(L"UPDATE Q10_TLS SET TXT='x' WHERE ID=2")), SQL_NTS);
                });
                started.wait();
                check(pending.wait_for(std::chrono::milliseconds(150)) == std::future_status::timeout, "TLS waiter blocks on row lock");
                check(SQLCancel(waiter) == SQL_SUCCESS, "TLS cancel accepted");
                check(pending.wait_for(std::chrono::seconds(5)) == std::future_status::ready, "TLS cancel completes");
                const auto cancelled = pending.get();
                check(cancelled == SQL_ERROR, "TLS lock wait cancelled");
                SQLCHAR code[6]{};
                check(SQLGetDiagRec(SQL_HANDLE_STMT, waiter, 1, code, nullptr, nullptr, 0, nullptr) == SQL_SUCCESS, "TLS cancel diagnostic");
                check(!std::strcmp(reinterpret_cast<char*>(code), "HY008"), "TLS cancel SQLSTATE");
            }
            check(SQLFreeHandle(SQL_HANDLE_STMT, waiter) == SQL_SUCCESS, "TLS waiter free");
            check(SQLFreeHandle(SQL_HANDLE_STMT, holder) == SQL_SUCCESS, "TLS holder free");
            check(SQLEndTran(SQL_HANDLE_DBC, second, SQL_ROLLBACK) == SQL_SUCCESS, "TLS second rollback");
            check(SQLEndTran(SQL_HANDLE_DBC, connection, SQL_ROLLBACK) == SQL_SUCCESS, "TLS first rollback");
            {
                const auto disc = SQLDisconnect(second);
                if (!SQL_SUCCEEDED(disc)) {
                    SQLCHAR st[6]{}; SQLINTEGER native = 0; SQLCHAR msg[1024]{};
                    SQLGetDiagRec(SQL_HANDLE_DBC, second, 1, st, &native, msg, 1024, nullptr);
                    std::cerr << "second disconnect rc=" << disc << " STATE=" << st << " NATIVE=" << native << " MESSAGE=" << msg << '\n';
                }
                check(disc == SQL_SUCCESS, "TLS second disconnect");
            }
            check(SQLFreeHandle(SQL_HANDLE_DBC, second) == SQL_SUCCESS, "TLS second free");
            check(SQLSetConnectAttr(connection, SQL_ATTR_AUTOCOMMIT, reinterpret_cast<SQLPOINTER>(SQL_AUTOCOMMIT_ON), 0) == SQL_SUCCESS, "TLS autocommit on");
            sql(statement, L"DROP TABLE Q10_TLS");
            check(SQLFreeHandle(SQL_HANDLE_STMT, statement) == SQL_SUCCESS, "TLS STMT free");
            check(SQLDisconnect(connection) == SQL_SUCCESS, "TLS disconnect");
            check(SQLFreeHandle(SQL_HANDLE_DBC, connection) == SQL_SUCCESS, "TLS DBC free");
            std::cout << "TLS functional PASS\n";
        } else {
            check(false, "unknown TLS probe mode");
        }
        check(SQLFreeHandle(SQL_HANDLE_ENV, environment) == SQL_SUCCESS, "TLS ENV free");
    });
}
