#include "hwdbodbc/odbc.hpp"
#include "../helpers/check.hpp"
#include <cstring>
#include <filesystem>
#include <string>

// Manager 전용 reset 속성을 직접 DLL에서 시험한다. Manager 풀 시험과 구분한다.
class Driver {
    HMODULE module = nullptr;
    template<class Function> void resolve(Function& function, const char* name) {
        const auto address = GetProcAddress(module,name); check(address != nullptr,name);
        static_assert(sizeof(function) == sizeof(address)); std::memcpy(&function,&address,sizeof(function));
    }
public:
#define HWDB_APIS(X) X(SQLAllocHandle) X(SQLFreeHandle) X(SQLSetEnvAttr) X(SQLDriverConnectW) X(SQLDisconnect) \
    X(SQLSetConnectAttr) X(SQLGetConnectAttr) X(SQLGetDiagRec) X(SQLExecDirectW) X(SQLPrepareW) X(SQLExecute) \
    X(SQLBindParameter) X(SQLBindCol) X(SQLFetch) X(SQLGetData) X(SQLCloseCursor) X(SQLGetStmtAttr) X(SQLSetStmtAttr) \
    X(SQLGetDescField) X(SQLGetCursorNameW) X(SQLSetCursorNameW)
#define HWDB_DECLARE(name) decltype(&::name) name = nullptr;
    HWDB_APIS(HWDB_DECLARE)
#undef HWDB_DECLARE
    explicit Driver(const wchar_t* path) {
        module = LoadLibraryExW(std::filesystem::absolute(path).c_str(),nullptr,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
        check(module != nullptr,"reset DLL load");
#define HWDB_RESOLVE(name) resolve(name,#name);
        HWDB_APIS(HWDB_RESOLVE)
#undef HWDB_RESOLVE
    }
    ~Driver() { if (module) FreeLibrary(module); }
#undef HWDB_APIS
};
namespace {
SQLWCHAR* wide(const std::wstring& value) { return reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(value.c_str())); }
SQLPOINTER number(SQLULEN value) { return reinterpret_cast<SQLPOINTER>(value); }
void expect(Driver& driver, SQLRETURN result, SQLSMALLINT type, SQLHANDLE handle, const char* operation) {
    if (SQL_SUCCEEDED(result)) return;
    SQLCHAR state[6]{}, message[1024]{}; driver.SQLGetDiagRec(type,handle,1,state,nullptr,message,1024,nullptr);
    std::cerr << operation << " " << state << " " << message << '\n'; check(false,operation);
}
void error(Driver& driver, SQLRETURN result, SQLSMALLINT type, SQLHANDLE handle, const char* expected) {
    check(result == SQL_ERROR,"reset operation error"); SQLCHAR state[6]{};
    check(driver.SQLGetDiagRec(type,handle,1,state,nullptr,nullptr,0,nullptr) == SQL_SUCCESS,"reset diagnostic");
    if (std::strcmp(reinterpret_cast<char*>(state),expected)) std::cerr << state << " != " << expected << '\n';
    check(!std::strcmp(reinterpret_cast<char*>(state),expected),"reset SQLSTATE");
}
SQLHDBC connect(Driver& driver, SQLHENV environment, const std::wstring& settings) {
    SQLHDBC result = nullptr; check(driver.SQLAllocHandle(SQL_HANDLE_DBC,environment,&result) == SQL_SUCCESS,"reset DBC allocate");
    expect(driver,driver.SQLDriverConnectW(result,nullptr,wide(settings),SQL_NTS,nullptr,0,nullptr,SQL_DRIVER_NOPROMPT),SQL_HANDLE_DBC,result,"reset login"); return result;
}
SQLHSTMT allocate(Driver& driver, SQLHDBC connection) { SQLHSTMT result = nullptr; check(driver.SQLAllocHandle(SQL_HANDLE_STMT,connection,&result) == SQL_SUCCESS,"reset STMT allocate"); return result; }
void sql(Driver& driver, SQLHSTMT statement, const std::wstring& query) { expect(driver,driver.SQLExecDirectW(statement,wide(query),SQL_NTS),SQL_HANDLE_STMT,statement,"reset SQL"); }
std::wstring scalar(Driver& driver, SQLHSTMT statement, const std::wstring& query) {
    sql(driver,statement,query); expect(driver,driver.SQLFetch(statement),SQL_HANDLE_STMT,statement,"reset scalar fetch");
    SQLWCHAR text[256]{}; SQLLEN length = 0;
    expect(driver,driver.SQLGetData(statement,1,SQL_C_WCHAR,text,sizeof(text),&length),SQL_HANDLE_STMT,statement,"reset scalar data");
    expect(driver,driver.SQLCloseCursor(statement),SQL_HANDLE_STMT,statement,"reset scalar close"); return reinterpret_cast<wchar_t*>(text);
}
void close(Driver& driver, SQLHDBC connection, SQLHSTMT statement) {
    check(driver.SQLFreeHandle(SQL_HANDLE_STMT,statement) == SQL_SUCCESS,"reset STMT free");
    expect(driver,driver.SQLDisconnect(connection),SQL_HANDLE_DBC,connection,"reset disconnect"); check(driver.SQLFreeHandle(SQL_HANDLE_DBC,connection) == SQL_SUCCESS,"reset DBC free");
}
}
int wmain(int argc, wchar_t** argv) {
    return run_checks([&] {
        check(argc == 3,"usage: hwdb_reset_probe DRIVER PORT"); Driver driver(argv[1]);
        SQLHENV environment = nullptr; check(driver.SQLAllocHandle(SQL_HANDLE_ENV,nullptr,&environment) == SQL_SUCCESS,"reset ENV");
        check(driver.SQLSetEnvAttr(environment,SQL_ATTR_ODBC_VERSION,number(SQL_OV_ODBC3_80),0) == SQL_SUCCESS,"reset version");
        const auto base = L"Server=127.0.0.1;Port=" + std::wstring(argv[2]) + L";";
        auto master_connection = connect(driver,environment,base + L"UID=SYSTEM;PWD=HelloWorldDB;"), master = allocate(driver,master_connection);
        sql(driver,master,L"CREATE TABLE Q8_RESET (ID INTEGER PRIMARY KEY)");
        sql(driver,master,L"CREATE USER Q8_NULL_RESET IDENTIFIED BY 'null-reset-test'");
        sql(driver,master,L"GRANT SELECT,INSERT ON SYSTEM.Q8_RESET TO Q8_NULL_RESET");
        auto user_connection = connect(driver,environment,base + L"UID=Q8_NULL_RESET;PWD=null-reset-test;"), user = allocate(driver,user_connection);
        expect(driver,driver.SQLSetCursorNameW(user,wide(L"reset_custom"),SQL_NTS),SQL_HANDLE_STMT,user,"reset custom cursor name");
        const std::wstring null_space = L"SELECT COUNT(*) FROM SYSTEM.SYS_SESSIONS WHERE USER_NAME='Q8_NULL_RESET' AND TABLESPACE_NAME IS NULL";
        check(scalar(driver,user,null_space) == L"1","initial default tablespace is NULL");
        const auto original_time = scalar(driver,user,L"SELECT CURRENT_TIMESTAMP"); check(original_time.size() > 6,"timestamp includes zone");
        const auto original_zone = original_time.substr(original_time.size() - 6);
        sql(driver,user,L"USE SYSTEM"); sql(driver,user,L"SET TIME ZONE '+02:30'");
        expect(driver,driver.SQLSetConnectAttr(user_connection,SQL_ATTR_AUTOCOMMIT,number(SQL_AUTOCOMMIT_OFF),0),SQL_HANDLE_DBC,user_connection,"reset manual commit");
        sql(driver,user,L"INSERT INTO SYSTEM.Q8_RESET VALUES (1)");
        auto prepared = allocate(driver,user_connection);
        expect(driver,driver.SQLPrepareW(prepared,wide(L"INSERT INTO SYSTEM.Q8_RESET VALUES (?)"),SQL_NTS),SQL_HANDLE_STMT,prepared,"reset prepare");
        SQLINTEGER parameter = 2; expect(driver,driver.SQLBindParameter(prepared,1,SQL_PARAM_INPUT,SQL_C_SLONG,SQL_INTEGER,10,0,&parameter,0,nullptr),SQL_HANDLE_STMT,prepared,"reset parameter binding");
        SQLINTEGER output = 777; SQLLEN length = 0;
        expect(driver,driver.SQLBindCol(user,1,SQL_C_SLONG,&output,0,&length),SQL_HANDLE_STMT,user,"reset column binding");
        sql(driver,user,L"SELECT ID FROM SYSTEM.Q8_RESET");
        expect(driver,driver.SQLSetStmtAttr(user,SQL_ATTR_QUERY_TIMEOUT,number(4),0),SQL_HANDLE_STMT,user,"reset statement timeout");
        error(driver,driver.SQLSetConnectAttr(user_connection,SQL_ATTR_RESET_CONNECTION,number(0),0),SQL_HANDLE_DBC,user_connection,"HY024");
        expect(driver,driver.SQLSetConnectAttr(user_connection,SQL_ATTR_RESET_CONNECTION,number(SQL_RESET_CONNECTION_YES),0),SQL_HANDLE_DBC,user_connection,"physical reset reauthentication");
        check(output == 777,"reset never frees or overwrites application buffers");
        SQLWCHAR cursor_name[129]{};
        expect(driver,driver.SQLGetCursorNameW(user,cursor_name,129,nullptr),SQL_HANDLE_STMT,user,"reset cursor name getter");
        check(std::wstring(reinterpret_cast<wchar_t*>(cursor_name)).rfind(L"SQL_CUR",0) == 0,"custom cursor name reset");
        SQLUINTEGER autocommit = 0; expect(driver,driver.SQLGetConnectAttr(user_connection,SQL_ATTR_AUTOCOMMIT,&autocommit,0,nullptr),SQL_HANDLE_DBC,user_connection,"reset autocommit getter");
        check(autocommit == SQL_AUTOCOMMIT_ON,"reset restores autocommit");
        SQLULEN timeout = 99; expect(driver,driver.SQLGetStmtAttr(user,SQL_ATTR_QUERY_TIMEOUT,&timeout,0,nullptr),SQL_HANDLE_STMT,user,"reset query timeout getter"); check(timeout == 0,"statement timeout reset");
        SQLHDESC descriptor = nullptr; expect(driver,driver.SQLGetStmtAttr(user,SQL_ATTR_APP_ROW_DESC,&descriptor,0,nullptr),SQL_HANDLE_STMT,user,"reset ARD");
        SQLSMALLINT count = -1; expect(driver,driver.SQLGetDescField(descriptor,0,SQL_DESC_COUNT,&count,0,nullptr),SQL_HANDLE_DESC,descriptor,"reset binding count"); check(count == 0,"bindings cleared");
        error(driver,driver.SQLFetch(user),SQL_HANDLE_STMT,user,"24000"); error(driver,driver.SQLExecute(prepared),SQL_HANDLE_STMT,prepared,"HY010");
        check(scalar(driver,master,L"SELECT COUNT(*) FROM Q8_RESET") == L"0","reset rolls back old transaction");
        check(scalar(driver,user,null_space) == L"1","reset restores NULL tablespace by fresh login");
        const auto fresh_time = scalar(driver,user,L"SELECT CURRENT_TIMESTAMP"); check(fresh_time.substr(fresh_time.size() - 6) == original_zone,"reset restores default time zone");
        // 암호 변경 뒤 재인증 실패는 이전 세션을 풀에 남기지 않는다.
        sql(driver,master,L"ALTER USER Q8_NULL_RESET IDENTIFIED BY 'changed-reset-test'");
        error(driver,driver.SQLSetConnectAttr(user_connection,SQL_ATTR_RESET_CONNECTION,number(SQL_RESET_CONNECTION_YES),0),SQL_HANDLE_DBC,user_connection,"28000");
        SQLUINTEGER dead = SQL_CD_FALSE; expect(driver,driver.SQLGetConnectAttr(user_connection,SQL_ATTR_CONNECTION_DEAD,&dead,0,nullptr),SQL_HANDLE_DBC,user_connection,"failed reset dead flag"); check(dead == SQL_CD_TRUE,"failed reset discarded");
        error(driver,driver.SQLExecDirectW(user,wide(L"SELECT 1"),SQL_NTS),SQL_HANDLE_STMT,user,"08S01");
        check(driver.SQLFreeHandle(SQL_HANDLE_STMT,prepared) == SQL_SUCCESS,"reset prepared handle free"); close(driver,user_connection,user);
        sql(driver,master,L"DROP USER Q8_NULL_RESET"); close(driver,master_connection,master);
        check(driver.SQLFreeHandle(SQL_HANDLE_ENV,environment) == SQL_SUCCESS,"reset ENV free");
        std::cout << "DIRECT DLL reset/rollback/NULL tablespace/timezone/buffers/relogin failure PASS\n";
    });
}
