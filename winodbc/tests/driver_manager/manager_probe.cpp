#include "hwdbodbc/odbc.hpp"
#include "../helpers/check.hpp"
#include <array>

int main() {
    return run_checks([] {
        // 이 단계는 Manager 자체의 환경/진단 시험이다. 드라이버 로그인은 WO-4이다.
        const auto manager = GetModuleHandleW(L"odbc32.dll");
        check(manager != nullptr, "ODBC Driver Manager not loaded");
        std::array<wchar_t, 32768> path{};
        check(GetModuleFileNameW(manager, path.data(), static_cast<DWORD>(path.size())) > 0,
            "Manager path lookup");
        std::wcout << L"DRIVER MANAGER: " << path.data() << L'\n';
        // WOW64에서는 모듈 경로가 System32로 보일 수 있다. 적재된 이미지의 비트 수를 확인한다.
        const auto base = reinterpret_cast<const BYTE*>(manager);
        const auto dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
        const auto nt = reinterpret_cast<const IMAGE_NT_HEADERS*>(base + dos->e_lfanew);
        check(dos->e_magic == IMAGE_DOS_SIGNATURE && nt->Signature == IMAGE_NT_SIGNATURE,
            "Manager image signature");
        const auto machine = nt->FileHeader.Machine;
        check(machine == (sizeof(void*) == 8 ? IMAGE_FILE_MACHINE_AMD64 : IMAGE_FILE_MACHINE_I386),
            "loaded Manager machine mismatch");
        std::cout << "LOADED MANAGER MACHINE: 0x" << std::hex << machine << std::dec << '\n';
        check(GetModuleHandleW(L"hwdbodbc.dll") == nullptr, "driver unexpectedly loaded");
        SQLHENV environment = SQL_NULL_HENV;
        check(SQLAllocHandle(SQL_HANDLE_ENV, SQL_NULL_HANDLE, &environment) == SQL_SUCCESS, "Manager ENV allocation");
        check(SQLSetEnvAttr(environment, SQL_ATTR_ODBC_VERSION,
            reinterpret_cast<SQLPOINTER>(static_cast<std::uintptr_t>(SQL_OV_ODBC3_80)), 0) == SQL_SUCCESS,
            "Manager version");
        SQLUINTEGER version = 0;
        check(SQLGetEnvAttr(environment, SQL_ATTR_ODBC_VERSION, &version, 0, nullptr) == SQL_SUCCESS
            && version == SQL_OV_ODBC3_80, "Manager version get");
        check(SQLSetEnvAttr(environment, SQL_ATTR_ODBC_VERSION, nullptr, 0) == SQL_ERROR, "Manager invalid version");
        std::array<SQLWCHAR, 6> state{};
        std::array<SQLWCHAR, 256> message{};
        check(SQLGetDiagRecW(SQL_HANDLE_ENV, environment, 1, state.data(), nullptr,
            message.data(), static_cast<SQLSMALLINT>(message.size()), nullptr) == SQL_SUCCESS, "Manager diagnostics");
        check(state[0] == 'H' && state[1] == 'Y' && state[2] == '0' && state[3] == '2'
            && state[4] == '4', "Manager HY024");
        check(SQLFreeHandle(SQL_HANDLE_ENV, environment) == SQL_SUCCESS, "Manager ENV release");
        check(GetModuleHandleW(L"hwdbodbc.dll") == nullptr, "Manager smoke must not claim driver load");
    });
}
