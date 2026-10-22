#include <winsock2.h>
#include <ws2tcpip.h>
#include "hwdbodbc/odbc.hpp"
#include "../helpers/check.hpp"
#include <filesystem>
#include <string>
#include <odbcinst.h>
#include <objbase.h>
#include <cstring>
void run_query_cases(SQLHDBC connection);
void run_descriptor_cases(SQLHDBC connection);
void run_data_cases(SQLHDBC connection);
void run_transaction_cases(SQLHDBC connection, SQLHENV environment, const std::wstring& connection_string);
void run_prepare_cases(SQLHDBC connection, SQLHENV environment, const std::wstring& connection_string);

void diagnostics(SQLHDBC connection) {
    SQLWCHAR state[6]{}, message[1024]{};
    SQLINTEGER number = 0;
    for (SQLSMALLINT record = 1; record < 32 && SQL_SUCCEEDED(SQLGetDiagRecW(SQL_HANDLE_DBC, connection, record, state, &number, message, 1024, nullptr)); ++record)
    {
        char text[4096]{};
        WideCharToMultiByte(CP_UTF8, 0, reinterpret_cast<wchar_t*>(message), -1, text, 4096, nullptr, nullptr);
        for (int i = 0; i < 5; ++i) std::cerr << static_cast<char>(state[i]);
        std::cerr << ' ' << number << ' ' << text << '\n';
    }
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
        // 이 프로세스에서 만든 GUID 경로만 제거한다. 실제 HKLM과 기존 DSN은 대상이 아니다.
        if (path.rfind(L"Software\\HelloWorldDB\\ODBC-Tests\\{", 0) == 0)
            RegDeleteTreeW(HKEY_CURRENT_USER, path.c_str());
    }
};
class TestRegistration {
    HMODULE installer = nullptr;
    decltype(&SQLInstallDriverExW) install_function = nullptr;
    decltype(&SQLRemoveDriverW) remove_function = nullptr;
    decltype(&SQLInstallerErrorW) error_function = nullptr;
    template<class T> void resolve(T& function, const char* symbol) {
        const auto address = GetProcAddress(installer, symbol);
        check(address != nullptr, "installer entry point");
        static_assert(sizeof(function) == sizeof(address));
        std::memcpy(&function, &address, sizeof(function));
    }
public:
    std::wstring name;
    bool installed = false;
    explicit TestRegistration(const wchar_t* filename) {
        installer = LoadLibraryExW(L"odbccp32.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
        check(installer != nullptr, "load system ODBC installer");
        resolve(install_function, "SQLInstallDriverExW");
        resolve(remove_function, "SQLRemoveDriverW");
        resolve(error_function, "SQLInstallerErrorW");
        GUID guid{};
        check(CoCreateGuid(&guid) == S_OK, "unique driver registration name");
        wchar_t guid_text[64]{};
        check(StringFromGUID2(guid, guid_text, 64) > 0, "GUID format");
        const std::wstring guid_value(guid_text);
        name = L"HelloWorldDB ODBC Test " + guid_value.substr(1, guid_value.size() - 2);
        std::wstring attributes = name;
        attributes += L'\0';
        attributes += L"Driver=" + std::filesystem::absolute(filename).wstring();
        attributes += L'\0';
        attributes += L"DriverODBCVer=03.00";
        attributes += L'\0';
        attributes += L'\0';
        wchar_t output[32768]{};
        WORD length = 0;
        DWORD usage = 0;
        const auto directory = std::filesystem::absolute(filename).parent_path().wstring();
        installed = install_function(attributes.c_str(), directory.c_str(), output, 32768, &length,
            ODBC_INSTALL_COMPLETE, &usage) != FALSE;
        if (!installed) {
            DWORD error = 0;
            wchar_t message[1024]{};
            error_function(1, &error, message, 1024, nullptr);
            std::wcerr << L"INSTALL ERROR " << error << L' ' << message << L'\n';
        }
        check(installed && usage == 1, "isolated test driver registration");
        HKEY key = nullptr;
        const auto registry_path = L"SOFTWARE\\ODBC\\ODBCINST.INI\\" + name;
        const auto key_status = RegOpenKeyExW(HKEY_LOCAL_MACHINE, registry_path.c_str(), 0, KEY_READ, &key);
        check(key_status == ERROR_SUCCESS, "installer wrote into private registry");
        if (key_status == ERROR_SUCCESS) {
            wchar_t driver[32768]{};
            DWORD bytes = sizeof(driver);
            const auto value_status = RegQueryValueExW(key, L"Driver", nullptr, nullptr, reinterpret_cast<BYTE*>(driver), &bytes);
            RegCloseKey(key);
            check(value_status == ERROR_SUCCESS && std::filesystem::equivalent(filename, driver), "registered DLL path");
        }
    }
    ~TestRegistration() {
        if (installed) {
            DWORD usage = 99;
            if (!remove_function(name.c_str(), FALSE, &usage) || usage != 0)
                std::wcerr << L"FAILED TO REMOVE TEST REGISTRATION: " << name << L'\n';
        }
        if (installer) FreeLibrary(installer);
    }
    void finish() {
        DWORD usage = 99;
        check(remove_function(name.c_str(), FALSE, &usage) != FALSE && usage == 0, "remove isolated test driver registration");
        installed = false;
    }
    void exercise_data_sources(SQLHENV environment, const wchar_t* port) {
        decltype(&SQLWriteDSNToIniW) write_dsn = nullptr;
        decltype(&SQLRemoveDSNFromIniW) remove_dsn = nullptr;
        decltype(&SQLWritePrivateProfileStringW) write_setting = nullptr;
        decltype(&SQLSetConfigMode) set_mode = nullptr;
        decltype(&SQLGetConfigMode) get_mode = nullptr;
        resolve(write_dsn, "SQLWriteDSNToIniW"); resolve(remove_dsn, "SQLRemoveDSNFromIniW");
        resolve(write_setting, "SQLWritePrivateProfileStringW"); resolve(set_mode, "SQLSetConfigMode"); resolve(get_mode, "SQLGetConfigMode");
        UWORD old_mode = 0; check(get_mode(&old_mode) != FALSE, "read installer config mode");
        for (const auto mode : {ODBC_USER_DSN, ODBC_SYSTEM_DSN}) {
            const wchar_t* dsn = mode == ODBC_USER_DSN ? L"HWDB_TEST_USER" : L"HWDB_TEST_SYSTEM";
            check(set_mode(static_cast<UWORD>(mode)) != FALSE && write_dsn(dsn, name.c_str()) != FALSE, "create private DSN");
            for (const auto& item : {std::pair<const wchar_t*, const wchar_t*>{L"Server",L"127.0.0.1"},
                {L"Port",port}, {L"UID",L"SYSTEM"}, {L"Tablespace",L"SYSTEM"}, {L"FetchSize",L"1"}})
                check(write_setting(dsn, item.first, item.second, L"ODBC.INI") != FALSE, "write private DSN setting");
            SQLHDBC connection = nullptr;
            check(SQLAllocHandle(SQL_HANDLE_DBC, environment, &connection) == SQL_SUCCESS, "DSN DBC allocate");
            const auto connected = SQLConnectW(connection, reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(dsn)), SQL_NTS,
                reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(L"SYSTEM")), SQL_NTS,
                reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(L"HelloWorldDB")), SQL_NTS);
            if (!SQL_SUCCEEDED(connected)) diagnostics(connection);
            check(SQL_SUCCEEDED(connected), "SQLConnectW private DSN login");
            const auto query = [&](const wchar_t* sql) {
                SQLHSTMT statement = nullptr;
                check(SQLAllocHandle(SQL_HANDLE_STMT, connection, &statement) == SQL_SUCCESS, "DSN query STMT");
                check(SQL_SUCCEEDED(SQLExecDirectW(statement, reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(sql)), SQL_NTS)), "DSN query");
                int rows = 0;
                while (SQLFetch(statement) == SQL_SUCCESS) ++rows;
                check(rows == 8, "DSN fetchSize 1/3 server batches");
                check(SQLFreeHandle(SQL_HANDLE_STMT, statement) == SQL_SUCCESS, "DSN query free");
            };
            query(L"SELECT ID FROM Q5_BATCH");
            SQLHSTMT disconnect_child = nullptr;
            check(SQLAllocHandle(SQL_HANDLE_STMT, connection, &disconnect_child) == SQL_SUCCESS, "disconnect child STMT");
            check(SQL_SUCCEEDED(SQLExecDirectW(disconnect_child, reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(L"SELECT ID FROM Q5_BATCH")), SQL_NTS)), "disconnect open cursor");
            check(SQLConnectW(connection, reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(dsn)), SQL_NTS, nullptr, 0, nullptr, 0) == SQL_ERROR, "duplicate DSN login rejected");
            SQLWCHAR state[6]{};
            check(SQLGetDiagRecW(SQL_HANDLE_DBC, connection, 1, state, nullptr, nullptr, 0, nullptr) == SQL_SUCCESS
                && std::wstring(reinterpret_cast<wchar_t*>(state)) == L"08002", "duplicate login SQLSTATE");
            check(SQLDisconnect(connection) == SQL_SUCCESS, "DSN disconnect");
            // Manager가 자체 STMT도 해제하므로 이후에는 그 포인터를 다시 사용하지 않는다.
            // 드라이버 토큰의 해제 후 호출은 별도의 직접 API 수명 시험에서 검사한다.
            // 명시 속성 > DSN. 저장된 포트를 바꿔도 명시한 정상 포트로 접속해야 한다.
            check(set_mode(static_cast<UWORD>(mode)) != FALSE && write_setting(dsn, L"Port", L"1", L"ODBC.INI") != FALSE, "change DSN port");
            const auto input = L"DSN=" + std::wstring(dsn) + L";Port=" + port + L";FetchSize=3;PWD=HelloWorldDB;";
            const auto result = SQLDriverConnectW(connection, nullptr, reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(input.c_str())), SQL_NTS,
                nullptr, 0, nullptr, SQL_DRIVER_NOPROMPT);
            if (!SQL_SUCCEEDED(result)) diagnostics(connection);
            check(SQL_SUCCEEDED(result), "DSN override precedence and saved UID");
            query(L"SELECT ID FROM Q5_BATCH");
            check(SQLDisconnect(connection) == SQL_SUCCESS && SQLFreeHandle(SQL_HANDLE_DBC, connection) == SQL_SUCCESS, "DSN cleanup");
            check(set_mode(static_cast<UWORD>(mode)) != FALSE && remove_dsn(dsn) != FALSE, "remove private DSN");
        }
        check(set_mode(old_mode) != FALSE, "restore installer config mode");
        wchar_t remote[256]{};
        const auto remote_length = GetEnvironmentVariableW(L"HWDB_TEST_REMOTE_HOST", remote, 256);
        check(remote_length > 0 && remote_length < 256, "remote CONNECT test host");
        SQLHDBC remote_connection = nullptr;
        check(SQLAllocHandle(SQL_HANDLE_DBC, environment, &remote_connection) == SQL_SUCCESS, "remote test DBC");
        const auto remote_input = L"DRIVER={" + name + L"};Server=" + remote + L";Port=" + port + L";UID=SYSTEM;PWD=HelloWorldDB;";
        check(SQLDriverConnectW(remote_connection, nullptr, reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(remote_input.c_str())), SQL_NTS,
            nullptr, 0, nullptr, SQL_DRIVER_NOPROMPT) == SQL_ERROR, "remote without CONNECT is rejected");
        SQLWCHAR remote_state[6]{}; SQLINTEGER native = 0;
        check(SQLGetDiagRecW(SQL_HANDLE_DBC, remote_connection, 1, remote_state, &native, nullptr, 0, nullptr) == SQL_SUCCESS
            && std::wstring(reinterpret_cast<wchar_t*>(remote_state)) == L"28000" && native == 7006, "remote CONNECT server diagnostic");
        check(SQLFreeHandle(SQL_HANDLE_DBC, remote_connection) == SQL_SUCCESS, "remote test DBC free");
        std::cout << "DSN user/system/explicit precedence PASS\n";
    }
};
LONG WINAPI report_unhandled_exception(EXCEPTION_POINTERS* exception) {
        HMODULE module = nullptr;
        GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(exception->ExceptionRecord->ExceptionAddress),&module);
        wchar_t path[32768]{}; if (module) GetModuleFileNameW(module,path,32768);
        std::wcerr << L"UNHANDLED code=" << std::hex << exception->ExceptionRecord->ExceptionCode << L" module=" << path
            << L" offset=" << (reinterpret_cast<std::uintptr_t>(exception->ExceptionRecord->ExceptionAddress) - reinterpret_cast<std::uintptr_t>(module)) << L'\n';
        if (exception->ExceptionRecord->NumberParameters >= 2) std::wcerr << L"FAULT ADDRESS=" << exception->ExceptionRecord->ExceptionInformation[1] << L'\n';
        return EXCEPTION_EXECUTE_HANDLER;
}
int wmain(int argc, wchar_t** argv) {
    std::cout << std::unitbuf; std::wcout << std::unitbuf;
    SetUnhandledExceptionFilter(report_unhandled_exception);
    return run_checks([&] {
        check(argc == 3, "usage: hwdb_dm_connection DRIVER PORT");
        NetworkBootstrap network_bootstrap;
        RegistrySandbox registry_sandbox;
        TestRegistration registration(argv[1]);
        SQLHENV environment = nullptr;
        SQLHDBC connection = nullptr;
        check(SQLAllocHandle(SQL_HANDLE_ENV, nullptr, &environment) == SQL_SUCCESS, "Manager ENV");
        check(SQLSetEnvAttr(environment, SQL_ATTR_ODBC_VERSION, reinterpret_cast<SQLPOINTER>(SQL_OV_ODBC3_80), 0) == SQL_SUCCESS, "Manager version");
        check(SQLAllocHandle(SQL_HANDLE_DBC, environment, &connection) == SQL_SUCCESS, "Manager DBC");
        const std::wstring input = L"DRIVER={" + registration.name + L"};Server=127.0.0.1;Port=" + argv[2] + L";UID=SYSTEM;PWD=HelloWorldDB;";
        SQLWCHAR output[1024]{};
        SQLSMALLINT length = -1;
        const auto result = SQLDriverConnectW(connection, nullptr, reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(input.c_str())), SQL_NTS,
            output, 1024, &length, SQL_DRIVER_NOPROMPT);
        if (!SQL_SUCCEEDED(result)) {
            diagnostics(connection);
            std::cerr << "driver_loaded=" << (GetModuleHandleW(L"hwdbodbc.dll") ? "yes" : "no") << '\n';
        }
        check(SQL_SUCCEEDED(result), "Manager driver login");
        check(std::wstring(reinterpret_cast<wchar_t*>(output)).find(L"PWD") == std::wstring::npos, "output password redacted");
        const auto loaded = GetModuleHandleW(L"hwdbodbc.dll");
        check(loaded != nullptr, "Manager loaded the driver DLL");
        wchar_t filename[32768]{};
        check(GetModuleFileNameW(loaded, filename, 32768) > 0, "driver path query");
        std::wcout << L"MANAGER DLL: " << filename << L'\n';
        SQLUINTEGER dead = SQL_CD_TRUE;
        check(SQLGetConnectAttr(connection, SQL_ATTR_CONNECTION_DEAD, &dead, 0, nullptr) == SQL_SUCCESS && dead == SQL_CD_FALSE, "Manager live connection");
        SQLHSTMT statement = nullptr;
        check(SQLAllocHandle(SQL_HANDLE_STMT, connection, &statement) == SQL_SUCCESS, "Manager STMT allocation");
        SQLHDESC descriptor = nullptr;
        check(SQLGetStmtAttr(statement, SQL_ATTR_APP_ROW_DESC, &descriptor, 0, nullptr) == SQL_SUCCESS && descriptor, "Manager ARD");
        check(SQLFreeHandle(SQL_HANDLE_STMT, statement) == SQL_SUCCESS, "Manager STMT free");
        run_query_cases(connection);
        run_prepare_cases(connection, environment, input);
        run_descriptor_cases(connection);
        run_data_cases(connection);
        run_transaction_cases(connection,environment,input);
        registration.exercise_data_sources(environment, argv[2]);
        check(SQLDisconnect(connection) == SQL_SUCCESS, "Manager disconnect");
        check(SQLFreeHandle(SQL_HANDLE_DBC, connection) == SQL_SUCCESS, "Manager DBC free");
        check(SQLFreeHandle(SQL_HANDLE_ENV, environment) == SQL_SUCCESS, "Manager ENV free");
        registration.finish();
    });
}
