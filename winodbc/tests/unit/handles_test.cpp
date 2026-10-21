#include "hwdbodbc/handles.hpp"
#include "../helpers/check.hpp"
#include <cstring>
#include <thread>
#include <vector>

using namespace hwdbodbc;
void state(SQLSMALLINT type, SQLHANDLE handle, const char* expected) {
    SQLCHAR code[6]{};
    check(SQLGetDiagRec(type, handle, 1, code, nullptr, nullptr, 0, nullptr) == SQL_SUCCESS, "read diagnostic");
    check(std::strcmp(reinterpret_cast<char*>(code), expected) == 0, "diagnostic state");
}
int main() {
    return run_checks([] {
        SQLHENV env = nullptr;
        SQLHDBC dbc = nullptr;
        check(SQLAllocHandle(SQL_HANDLE_ENV, nullptr, &env) == SQL_SUCCESS, "ENV allocate");
        check(SQLAllocHandle(SQL_HANDLE_DBC, env, &dbc) == SQL_ERROR && !dbc, "version required");
        state(SQL_HANDLE_ENV, env, "HY010");
        check(SQLSetEnvAttr(env, SQL_ATTR_ODBC_VERSION, reinterpret_cast<SQLPOINTER>(SQL_OV_ODBC3_80), 0) == SQL_SUCCESS, "version set");
        check(SQLAllocHandle(SQL_HANDLE_DBC, env, nullptr) == SQL_ERROR, "null allocation output");
        state(SQL_HANDLE_ENV, env, "HY009");
        check(SQLAllocHandle(SQL_HANDLE_DBC, env, &dbc) == SQL_SUCCESS, "DBC allocate");
        check(SQLSetEnvAttr(env, SQL_ATTR_ODBC_VERSION, reinterpret_cast<SQLPOINTER>(SQL_OV_ODBC3), 0) == SQL_ERROR, "version cannot change with DBC");
        check(SQLFreeHandle(SQL_HANDLE_ENV, env) == SQL_ERROR, "parent cannot be freed");
        SQLHSTMT stmt = nullptr;
        check(SQLAllocHandle(SQL_HANDLE_STMT, dbc, &stmt) == SQL_ERROR && !stmt, "disconnected statement allocation");
        state(SQL_HANDLE_DBC, dbc, "08003");
        SQLWCHAR invalid[2] = {0xd800, 0};
        check(SQLConnectW(dbc, invalid, 1, nullptr, 0, nullptr, 0) == SQL_ERROR, "invalid connect unicode");
        state(SQL_HANDLE_DBC, dbc, "22021");
        // 내부 수명 시험만 연결 상태를 주입한다. 실제 서버 로그인 증거와 구분한다.
        auto connection = std::static_pointer_cast<Connection>(find_handle(SQL_HANDLE_DBC, dbc));
        connection->connected = true;
        check(SQLAllocHandle(SQL_HANDLE_STMT, dbc, &stmt) == SQL_SUCCESS, "STMT allocate");
        SQLHDESC explicit_desc = nullptr;
        check(SQLAllocHandle(SQL_HANDLE_DESC, dbc, &explicit_desc) == SQL_SUCCESS, "explicit DESC allocate");
        const auto statement = std::static_pointer_cast<Statement>(find_handle(SQL_HANDLE_STMT, stmt));
        check(statement->cursor_name.size() <= 18 && statement->cursor_name.rfind("SQL_CUR", 0) == 0, "generated cursor name length/prefix");
        for (const auto& desc : statement->descriptors) {
            check(desc->automatic && find_handle(SQL_HANDLE_DESC, desc->id), "automatic DESC registry");
            check(SQLFreeHandle(SQL_HANDLE_DESC, desc->id) == SQL_ERROR, "automatic DESC free rejected");
            state(SQL_HANDLE_DESC, desc->id, "HY017");
        }
        SQLHDESC ard = nullptr;
        SQLINTEGER output_length = -1;
        check(SQLGetStmtAttr(stmt, SQL_ATTR_APP_ROW_DESC, &ard, 0, &output_length) == SQL_SUCCESS, "ARD query");
        check(ard == statement->descriptors[0]->id && output_length == sizeof(SQLHDESC), "ARD identity/width");
        auto& diagnostics = statement->diagnostic;
        diagnostics.append("01004", "첫째 😀", 41, 3, 2);
        diagnostics.append("22003", "Second record.", 42, 4, 5);
        diagnostics.return_code = SQL_SUCCESS_WITH_INFO;
        SQLINTEGER number = -1;
        check(SQLGetDiagField(SQL_HANDLE_STMT, stmt, -99, SQL_DIAG_NUMBER, &number, -1, nullptr) == SQL_SUCCESS && number == 2, "header ignores record/string capacity");
        SQLRETURN result = SQL_ERROR;
        check(SQLGetDiagField(SQL_HANDLE_STMT, stmt, 0, SQL_DIAG_RETURNCODE, &result, 0, nullptr) == SQL_SUCCESS && result == SQL_SUCCESS_WITH_INFO, "diagnostic return code");
        SQLWCHAR message[32]{};
        SQLSMALLINT length = -1;
        SQLINTEGER native = -1;
        check(SQLGetDiagRecW(SQL_HANDLE_STMT, stmt, 1, nullptr, &native, message, 32, &length) == SQL_SUCCESS, "Unicode diagnostic");
        check(native == 41 && utf8(reinterpret_cast<wchar_t*>(message)) == "첫째 😀" && length == 5, "record Unicode/native/length");
        check(SQLGetDiagFieldW(SQL_HANDLE_STMT, stmt, 1, SQL_DIAG_MESSAGE_TEXT, message, 64, &length) == SQL_SUCCESS && length == 10, "DiagField W byte length");
        SQLLEN row = 0;
        SQLINTEGER column = 0;
        check(SQLGetDiagField(SQL_HANDLE_STMT, stmt, 2, SQL_DIAG_ROW_NUMBER, &row, 0, nullptr) == SQL_SUCCESS && row == 4, "diagnostic row SQLLEN");
        check(SQLGetDiagField(SQL_HANDLE_STMT, stmt, 2, SQL_DIAG_COLUMN_NUMBER, &column, 0, nullptr) == SQL_SUCCESS && column == 5, "diagnostic column INTEGER");
        check(SQLGetDiagRecW(SQL_HANDLE_STMT, stmt, 3, nullptr, nullptr, nullptr, 0, nullptr) == SQL_NO_DATA, "diagnostic end");
        check(SQLGetDiagField(SQL_HANDLE_STMT, stmt, 1, -999, nullptr, 0, nullptr) == SQL_ERROR, "invalid diagnostic field");
        check(diagnostics.size() == 2 && diagnostics.return_code == SQL_SUCCESS_WITH_INFO, "queries preserve diagnostics");
        check(SQLFreeHandle(SQL_HANDLE_DBC, dbc) == SQL_ERROR, "connected/child DBC free rejected");
        check(SQLFreeHandle(SQL_HANDLE_DESC, explicit_desc) == SQL_SUCCESS, "explicit DESC free");
        check(SQLFreeHandle(SQL_HANDLE_STMT, stmt) == SQL_SUCCESS, "STMT free");
        check(SQLGetDiagRec(SQL_HANDLE_DESC, ard, 1, nullptr, nullptr, nullptr, 0, nullptr) == SQL_INVALID_HANDLE, "automatic DESC invalidated");
        check(SQLFreeHandle(SQL_HANDLE_STMT, stmt) == SQL_INVALID_HANDLE, "double free");
        connection->connected = false;
        check(SQLFreeHandle(SQL_HANDLE_DBC, dbc) == SQL_SUCCESS, "DBC free");
        for (int i = 0; i < 2000; ++i) {
            SQLHANDLE fresh = nullptr;
            check(SQLAllocHandle(SQL_HANDLE_DBC, env, &fresh) == SQL_SUCCESS && fresh != dbc, "tokens are not reused");
            check(SQLFreeHandle(SQL_HANDLE_DBC, dbc) == SQL_INVALID_HANDLE, "stale token remains invalid");
            check(SQLFreeHandle(SQL_HANDLE_DBC, fresh) == SQL_SUCCESS, "repeat free");
        }
        // 조회/해제 경합에서 객체는 공유 소유권으로 살아 있고 alive 재검사가 차단한다.
        for (int i = 0; i < 100; ++i) {
            SQLHANDLE fresh = nullptr;
            check(SQLAllocHandle(SQL_HANDLE_DBC, env, &fresh) == SQL_SUCCESS, "race allocate");
            std::atomic<bool> valid{true};
            std::thread reader([&] {
                for (int j = 0; j < 100; ++j) {
                    SQLINTEGER count = -1;
                    const auto rc = SQLGetDiagField(SQL_HANDLE_DBC, fresh, 0, SQL_DIAG_NUMBER, &count, 0, nullptr);
                    if (rc != SQL_SUCCESS && rc != SQL_INVALID_HANDLE) valid = false;
                }
            });
            const auto rc = SQLFreeHandle(SQL_HANDLE_DBC, fresh);
            reader.join();
            check(rc == SQL_SUCCESS && valid, "concurrent release/read");
        }
        SQLHDBC final_connection = nullptr;
        check(SQLAllocHandle(SQL_HANDLE_DBC, env, &final_connection) == SQL_SUCCESS, "disconnect lifetime DBC");
        auto final_object = std::static_pointer_cast<Connection>(find_handle(SQL_HANDLE_DBC, final_connection));
        final_object->connected = true; // 수명 검사만 위한 상태 주입이며 네트워크 시험이 아니다.
        SQLHSTMT final_statement = nullptr; SQLHDESC final_descriptor = nullptr;
        check(SQLAllocHandle(SQL_HANDLE_STMT, final_connection, &final_statement) == SQL_SUCCESS, "disconnect lifetime STMT");
        check(SQLAllocHandle(SQL_HANDLE_DESC, final_connection, &final_descriptor) == SQL_SUCCESS, "disconnect lifetime DESC");
        check(SQLDisconnect(final_connection) == SQL_SUCCESS, "disconnect releases all child handles");
        check(SQLFreeHandle(SQL_HANDLE_STMT, final_statement) == SQL_INVALID_HANDLE, "released driver STMT token");
        check(SQLFreeHandle(SQL_HANDLE_DESC, final_descriptor) == SQL_INVALID_HANDLE, "released driver DESC token");
        check(SQLFreeHandle(SQL_HANDLE_DBC, final_connection) == SQL_SUCCESS, "disconnect cleared child count");
        check(SQLFreeHandle(SQL_HANDLE_ENV, env) == SQL_SUCCESS, "ENV final free");
    });
}
