#include "hwdbodbc/odbc.hpp"
#include "../helpers/check.hpp"
#include <array>
#include <cstring>
#include <filesystem>
#include <string>

namespace {
class Module {
public:
    explicit Module(const wchar_t* path) {
        const auto absolute = std::filesystem::absolute(path);
        handle_ = LoadLibraryExW(absolute.c_str(), nullptr,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
        check(handle_ != nullptr, "LoadLibraryExW failed");
        try {
            std::array<wchar_t, 32768> loaded{};
            const auto length = GetModuleFileNameW(handle_, loaded.data(), static_cast<DWORD>(loaded.size()));
            check(length > 0 && length < loaded.size(), "loaded DLL path lookup");
            check(std::filesystem::equivalent(absolute, loaded.data()), "loaded DLL path mismatch");
            std::wcout << L"DIRECT DLL: " << loaded.data() << L'\n';
        } catch (...) {
            FreeLibrary(handle_);
            handle_ = nullptr;
            throw;
        }
    }
    ~Module() { if (handle_) FreeLibrary(handle_); }
    Module(const Module&) = delete;
    Module& operator=(const Module&) = delete;

    template<class Function>
    Function get(const char* name) const {
        const auto address = GetProcAddress(handle_, name);
        check(address != nullptr, name);
        // SDK에서 가져온 함수 포인터로만 호출한다. C4191을 숨기는 함수 캐스트를 쓰지 않는다.
        static_assert(sizeof(Function) == sizeof(address));
        Function function = nullptr;
        std::memcpy(&function, &address, sizeof(function));
        return function;
    }
    bool has(const char* name) const { return GetProcAddress(handle_, name) != nullptr; }
private:
    HMODULE handle_ = nullptr;
};

void exports(const Module& module) {
    for (const char* name : {"SQLAllocHandle", "SQLFreeHandle", "SQLSetEnvAttr",
        "SQLGetEnvAttr", "SQLGetDiagRec", "SQLGetDiagRecW", "SQLGetDiagField", "SQLGetDiagFieldW",
        "SQLConnect", "SQLConnectW", "SQLGetStmtAttr", "SQLGetStmtAttrW"})
        check(module.has(name), name);
    for (const char* name : {"_SQLAllocHandle@12", "SQLGetDiagRecA", "SQLConnectA",
        "SQLDrivers", "SQLDataSources"})
        check(!module.has(name), "unexpected export");
    std::cout << "SQLLEN=" << sizeof(SQLLEN) << " SQLULEN=" << sizeof(SQLULEN)
        << " SQLPOINTER=" << sizeof(SQLPOINTER) << " SQLWCHAR=" << sizeof(SQLWCHAR) << '\n';
}

void lifecycle(const Module& module) {
    const auto allocate = module.get<decltype(&SQLAllocHandle)>("SQLAllocHandle");
    const auto release = module.get<decltype(&SQLFreeHandle)>("SQLFreeHandle");
    const auto set = module.get<decltype(&SQLSetEnvAttr)>("SQLSetEnvAttr");
    const auto get = module.get<decltype(&SQLGetEnvAttr)>("SQLGetEnvAttr");
    check(allocate(SQL_HANDLE_ENV, SQL_NULL_HANDLE, nullptr) == SQL_ERROR, "null output");
    const auto invalid = reinterpret_cast<SQLHANDLE>(static_cast<std::uintptr_t>(0x12345));
    check(release(SQL_HANDLE_ENV, invalid) == SQL_INVALID_HANDLE, "arbitrary handle");
    for (int iteration = 0; iteration < 256; ++iteration) {
        SQLHENV environment = SQL_NULL_HENV;
        check(allocate(SQL_HANDLE_ENV, SQL_NULL_HANDLE, &environment) == SQL_SUCCESS, "ENV allocation");
        check(environment != SQL_NULL_HENV, "null ENV");
        check(release(SQL_HANDLE_DBC, environment) == SQL_INVALID_HANDLE, "wrong handle type");
        for (const auto version : {SQL_OV_ODBC2, SQL_OV_ODBC3, SQL_OV_ODBC3_80}) {
            check(set(environment, SQL_ATTR_ODBC_VERSION,
                reinterpret_cast<SQLPOINTER>(static_cast<std::uintptr_t>(version)), 0) == SQL_SUCCESS,
                "version set");
            struct { SQLUINTEGER value = 0; SQLUINTEGER canary = 0x12345678; } output;
            SQLINTEGER length = -1;
            check(get(environment, SQL_ATTR_ODBC_VERSION, &output.value, 0, &length) == SQL_SUCCESS,
                "version get");
            check(output.value == version && output.canary == 0x12345678, "numeric output width");
            check(length == sizeof(SQLUINTEGER), "numeric output length");
        }
        SQLHANDLE connection = invalid;
        check(allocate(SQL_HANDLE_DBC, environment, &connection) == SQL_SUCCESS, "DBC allocation");
        check(release(SQL_HANDLE_ENV, environment) == SQL_ERROR, "live child prevents ENV release");
        check(release(SQL_HANDLE_DBC, connection) == SQL_SUCCESS, "DBC release");
        check(release(SQL_HANDLE_ENV, environment) == SQL_SUCCESS, "ENV release");
        check(set(environment, SQL_ATTR_ODBC_VERSION, nullptr, 0) == SQL_INVALID_HANDLE, "freed ENV");
        check(release(SQL_HANDLE_ENV, environment) == SQL_INVALID_HANDLE, "double release");
    }
}

void diagnostics(const Module& module) {
    const auto allocate = module.get<decltype(&SQLAllocHandle)>("SQLAllocHandle");
    const auto release = module.get<decltype(&SQLFreeHandle)>("SQLFreeHandle");
    const auto set = module.get<decltype(&SQLSetEnvAttr)>("SQLSetEnvAttr");
    const auto read = module.get<decltype(&SQLGetDiagRec)>("SQLGetDiagRec");
    const auto wide = module.get<decltype(&SQLGetDiagRecW)>("SQLGetDiagRecW");
    SQLHENV environment = SQL_NULL_HENV;
    check(allocate(SQL_HANDLE_ENV, SQL_NULL_HANDLE, &environment) == SQL_SUCCESS, "ENV allocation");
    check(set(environment, SQL_ATTR_ODBC_VERSION, nullptr, 0) == SQL_ERROR, "invalid version");
    std::array<SQLCHAR, 7> state{};
    state[6] = 0x5a;
    struct { SQLCHAR text[4]{}; SQLCHAR canary = 0x5a; } narrow;
    SQLINTEGER native = -1;
    SQLSMALLINT needed = -1;
    check(read(SQL_HANDLE_ENV, environment, 1, state.data(), &native, narrow.text, 4, &needed)
        == SQL_SUCCESS_WITH_INFO, "ANSI truncated diagnostic");
    check(std::strcmp(reinterpret_cast<const char*>(state.data()), "HY024") == 0, "diagnostic state");
    check(state[6] == 0x5a && narrow.canary == 0x5a && narrow.text[3] == 0, "ANSI canary/NUL");
    check(native == 0 && needed > 4, "diagnostic length/native");
    std::array<SQLWCHAR, 7> wide_state{};
    wide_state[6] = 0x5a5a;
    struct { SQLWCHAR text[4]{}; SQLWCHAR canary = 0x5a5a; } output;
    SQLSMALLINT wide_needed = -1;
    check(wide(SQL_HANDLE_ENV, environment, 1, wide_state.data(), nullptr, output.text, 4, &wide_needed)
        == SQL_SUCCESS_WITH_INFO, "W diagnostic code units");
    check(wide_state[0] == 'H' && wide_state[5] == 0 && wide_state[6] == 0x5a5a, "W state");
    check(output.text[3] == 0 && output.canary == 0x5a5a && needed == wide_needed, "W canary/length");
    std::array<SQLCHAR, 256> complete{};
    check(read(SQL_HANDLE_ENV, environment, 1, nullptr, nullptr, complete.data(), needed + 1, nullptr)
        == SQL_SUCCESS, "exact diagnostic buffer");
    check(complete[static_cast<std::size_t>(needed)] == 0, "exact buffer NUL");
    SQLCHAR untouched = 0x5a;
    check(read(SQL_HANDLE_ENV, environment, 1, nullptr, nullptr, &untouched, 0, nullptr)
        == SQL_SUCCESS_WITH_INFO && untouched == 0x5a, "zero capacity");
    check(read(SQL_HANDLE_ENV, environment, 1, nullptr, nullptr, nullptr, 0, &needed)
        == SQL_SUCCESS, "length only");
    check(read(SQL_HANDLE_ENV, environment, 0, nullptr, nullptr, nullptr, 0, nullptr) == SQL_ERROR, "record zero");
    check(read(SQL_HANDLE_ENV, environment, 1, nullptr, nullptr, nullptr, -1, nullptr) == SQL_ERROR, "negative length");
    check(read(SQL_HANDLE_ENV, environment, 2, nullptr, nullptr, nullptr, 0, nullptr) == SQL_NO_DATA, "record end");
    check(read(SQL_HANDLE_DBC, environment, 1, nullptr, nullptr, nullptr, 0, nullptr) == SQL_INVALID_HANDLE, "wrong diag type");
    check(set(environment, SQL_ATTR_OUTPUT_NTS,
        reinterpret_cast<SQLPOINTER>(static_cast<std::uintptr_t>(SQL_TRUE)), 0) == SQL_SUCCESS, "successful call");
    check(read(SQL_HANDLE_ENV, environment, 1, nullptr, nullptr, nullptr, 0, nullptr) == SQL_NO_DATA, "diagnostic cleared");
    check(release(SQL_HANDLE_ENV, environment) == SQL_SUCCESS, "ENV release");
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    return run_checks([&] {
        check(argc == 3, "usage: hwdb_abi_probe exports|lifecycle|diagnostics|reject DLL");
        const std::wstring scenario = argv[1];
        if (scenario == L"reject") {
            const auto path = std::filesystem::absolute(argv[2]);
            const auto module = LoadLibraryExW(path.c_str(), nullptr,
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
            const auto error = GetLastError();
            if (module) FreeLibrary(module);
            check(module == nullptr, "wrong-bitness DLL was loaded");
            std::cout << "mismatch GetLastError=" << error << '\n';
            check(error == ERROR_BAD_EXE_FORMAT, "expected ERROR_BAD_EXE_FORMAT (193)");
            return;
        }
        const Module module(argv[2]);
        if (scenario == L"exports") exports(module);
        else if (scenario == L"lifecycle") lifecycle(module);
        else if (scenario == L"diagnostics") diagnostics(module);
        else check(false, "unknown scenario");
    });
}
