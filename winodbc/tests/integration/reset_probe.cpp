#include "hwdbodbc/odbc.hpp"
#include "../helpers/check.hpp"
#include <algorithm>
#include <cstring>
#include <filesystem>
#include <iterator>
#include <set>
#include <string>
#include <vector>

// 직접 DLL 시험이다. Manager 전용 reset 속성과, SQLGetFunctions 보고와 실제 export의 일치를 확인한다.
// Manager 풀 시험이나 Manager가 대신 답하는 능력 보고와는 구분한다.
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
    X(SQLGetDescField) X(SQLGetCursorNameW) X(SQLSetCursorNameW) X(SQLGetFunctions) X(SQLGetInfo)
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
    bool exports(const std::string& name) const { return GetProcAddress(module,name.c_str()) != nullptr; }
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
struct ApiName { SQLUSMALLINT id; const char* name; bool wide; };
// 드라이버가 SQLGetFunctions로 true를 보고해야 하는 함수와 export 이름(wide이면 W 이름도)이다. 새 함수를 true로 보고하려면 여기도 추가해야 한다.
const ApiName reported_functions[] = {
    {SQL_API_SQLALLOCHANDLE,"SQLAllocHandle",false}, {SQL_API_SQLFREEHANDLE,"SQLFreeHandle",false}, {SQL_API_SQLSETENVATTR,"SQLSetEnvAttr",false},
    {SQL_API_SQLGETENVATTR,"SQLGetEnvAttr",false}, {SQL_API_SQLGETDIAGREC,"SQLGetDiagRec",true}, {SQL_API_SQLGETDIAGFIELD,"SQLGetDiagField",true},
    {SQL_API_SQLCONNECT,"SQLConnect",true}, {SQL_API_SQLDRIVERCONNECT,"SQLDriverConnect",true}, {SQL_API_SQLDISCONNECT,"SQLDisconnect",false},
    {SQL_API_SQLGETFUNCTIONS,"SQLGetFunctions",false}, {SQL_API_SQLGETCONNECTATTR,"SQLGetConnectAttr",true}, {SQL_API_SQLSETCONNECTATTR,"SQLSetConnectAttr",true},
    {SQL_API_SQLGETSTMTATTR,"SQLGetStmtAttr",true}, {SQL_API_SQLGETINFO,"SQLGetInfo",true}, {SQL_API_SQLEXECDIRECT,"SQLExecDirect",true},
    {SQL_API_SQLNUMRESULTCOLS,"SQLNumResultCols",false}, {SQL_API_SQLROWCOUNT,"SQLRowCount",false}, {SQL_API_SQLDESCRIBECOL,"SQLDescribeCol",true},
    {SQL_API_SQLCOLATTRIBUTE,"SQLColAttribute",true}, {SQL_API_SQLBINDCOL,"SQLBindCol",false}, {SQL_API_SQLFETCH,"SQLFetch",false},
    {SQL_API_SQLFETCHSCROLL,"SQLFetchScroll",false}, {SQL_API_SQLGETDATA,"SQLGetData",false}, {SQL_API_SQLCLOSECURSOR,"SQLCloseCursor",false},
    {SQL_API_SQLFREESTMT,"SQLFreeStmt",false}, {SQL_API_SQLMORERESULTS,"SQLMoreResults",false}, {SQL_API_SQLGETCURSORNAME,"SQLGetCursorName",true},
    {SQL_API_SQLSETCURSORNAME,"SQLSetCursorName",true}, {SQL_API_SQLSETSTMTATTR,"SQLSetStmtAttr",true}, {SQL_API_SQLPREPARE,"SQLPrepare",true},
    {SQL_API_SQLEXECUTE,"SQLExecute",false}, {SQL_API_SQLNUMPARAMS,"SQLNumParams",false}, {SQL_API_SQLDESCRIBEPARAM,"SQLDescribeParam",false},
    {SQL_API_SQLBINDPARAMETER,"SQLBindParameter",false}, {SQL_API_SQLNATIVESQL,"SQLNativeSql",true}, {SQL_API_SQLGETDESCFIELD,"SQLGetDescField",true},
    {SQL_API_SQLSETDESCFIELD,"SQLSetDescField",true}, {SQL_API_SQLGETDESCREC,"SQLGetDescRec",true}, {SQL_API_SQLSETDESCREC,"SQLSetDescRec",false},
    {SQL_API_SQLCOPYDESC,"SQLCopyDesc",false}, {SQL_API_SQLPARAMDATA,"SQLParamData",false}, {SQL_API_SQLPUTDATA,"SQLPutData",false},
    {SQL_API_SQLCANCEL,"SQLCancel",false}, {SQL_API_SQLENDTRAN,"SQLEndTran",false}, {SQL_API_SQLTABLES,"SQLTables",true},
    {SQL_API_SQLCOLUMNS,"SQLColumns",true}, {SQL_API_SQLSTATISTICS,"SQLStatistics",true}, {SQL_API_SQLSPECIALCOLUMNS,"SQLSpecialColumns",true},
    {SQL_API_SQLPRIMARYKEYS,"SQLPrimaryKeys",true}, {SQL_API_SQLFOREIGNKEYS,"SQLForeignKeys",true}, {SQL_API_SQLTABLEPRIVILEGES,"SQLTablePrivileges",true},
    {SQL_API_SQLCOLUMNPRIVILEGES,"SQLColumnPrivileges",true}, {SQL_API_SQLPROCEDURES,"SQLProcedures",true}, {SQL_API_SQLPROCEDURECOLUMNS,"SQLProcedureColumns",true},
    {SQL_API_SQLGETTYPEINFO,"SQLGetTypeInfo",true},
};
// 초기 범위에서 제외한다고 api-support.md가 밝힌 함수이다. 보고도 export도 없어야 한다.
const ApiName excluded_functions[] = {
    {SQL_API_SQLBROWSECONNECT,"SQLBrowseConnect",true}, {SQL_API_SQLBULKOPERATIONS,"SQLBulkOperations",false}, {SQL_API_SQLSETPOS,"SQLSetPos",false},
    {SQL_API_SQLCANCELHANDLE,"SQLCancelHandle",false}, {SQL_API_SQLCOMPLETEASYNC,"SQLCompleteAsync",false},
};
bool bit_set(const std::vector<SQLUSMALLINT>& bitmap, SQLUSMALLINT id) { return (bitmap[id >> 4] & (1U << (id & 15))) != 0; }
// SQLGetFunctions의 세 형태(단일 ID, 배열, ODBC 3 비트맵)가 서로 일치하고 실제 export와도 일치하는지 직접 DLL에서 대조한다.
// 이 대조는 보고와 export의 정합성을 보장한다. 각 함수를 실제로 호출하는 시험은 단위·Manager·통합 시험 쪽에 있다.
void check_function_reporting(Driver& driver, SQLHDBC connection) {
    std::set<SQLUSMALLINT> reported;
    for (SQLUSMALLINT id = 1; id <= 1100; ++id) {
        // SQL_API_ODBC3_ALL_FUNCTIONS(999)는 250개 원소의 비트맵을 쓰는 형태이므로 단일 조회 반복에서 제외한다. 아래에서 따로 시험한다.
        if (id == SQL_API_ODBC3_ALL_FUNCTIONS) continue;
        SQLUSMALLINT supported = 99;
        check(driver.SQLGetFunctions(connection,id,&supported) == SQL_SUCCESS,"single function query succeeds");
        check(supported == SQL_TRUE || supported == SQL_FALSE,"single function answer is a boolean");
        if (supported == SQL_TRUE) reported.insert(id);
    }
    for (const auto& api : reported_functions) {
        if (!reported.count(api.id)) { std::cerr << "not reported: " << api.name << '\n'; check(false,"function with an export is reported as supported"); }
        if (!driver.exports(api.name)) { std::cerr << "not exported: " << api.name << '\n'; check(false,"reported function is exported"); }
        if (api.wide && !driver.exports(std::string(api.name) + "W")) { std::cerr << "not exported: " << api.name << "W\n"; check(false,"reported function has a W export"); }
    }
    for (const auto id : reported) {
        const auto known = std::any_of(std::begin(reported_functions),std::end(reported_functions),[&](const ApiName& api) { return api.id == id; });
        if (!known) std::cerr << "unlisted reported function id " << id << '\n';
        check(known,"every function reported as supported is in the verified table");
    }
    check(reported.size() == std::size(reported_functions),"reported function count matches the table");
    for (const auto& api : excluded_functions) {
        if (reported.count(api.id)) std::cerr << "reported although excluded: " << api.name << '\n';
        check(!reported.count(api.id),"excluded function is not reported");
        check(!driver.exports(api.name) && !driver.exports(std::string(api.name) + "W"),"excluded function is not exported");
    }
    std::vector<SQLUSMALLINT> bitmap(SQL_API_ODBC3_ALL_FUNCTIONS_SIZE,0);
    check(driver.SQLGetFunctions(connection,SQL_API_ODBC3_ALL_FUNCTIONS,bitmap.data()) == SQL_SUCCESS,"ODBC 3 function bitmap");
    for (SQLUSMALLINT id = 1; id <= 1100; ++id) {
        if (id == SQL_API_ODBC3_ALL_FUNCTIONS) continue;
        check(bit_set(bitmap,id) == (reported.count(id) != 0),"bitmap agrees with the single queries");
    }
    SQLUSMALLINT legacy[100]{};
    check(driver.SQLGetFunctions(connection,SQL_API_ALL_FUNCTIONS,legacy) == SQL_SUCCESS,"ODBC 2 function array");
    for (SQLUSMALLINT id = 1; id < 100; ++id) check((legacy[id] == SQL_TRUE) == (reported.count(id) != 0),"legacy array agrees with the single queries");
}
// 유효한 ODBC 속성이지만 지원하지 않는 것은 HYC00(또는 기본값만 받는 01S02), 모르는 식별자는 HY092이다.
void check_unsupported_attributes(Driver& driver, SQLHDBC connection, SQLHSTMT statement) {
    for (const int attribute : {SQL_ATTR_PACKET_SIZE, SQL_ATTR_TRANSLATE_LIB, SQL_ATTR_TRANSLATE_OPTION, SQL_ATTR_ENLIST_IN_DTC}) {
        error(driver,driver.SQLSetConnectAttr(connection,attribute,number(0),0),SQL_HANDLE_DBC,connection,"HYC00");
        SQLUINTEGER value = 0;
        error(driver,driver.SQLGetConnectAttr(connection,attribute,&value,0,nullptr),SQL_HANDLE_DBC,connection,"HYC00");
    }
    error(driver,driver.SQLSetConnectAttr(connection,99999,number(0),0),SQL_HANDLE_DBC,connection,"HY092");
    error(driver,driver.SQLSetStmtAttr(statement,99999,number(0),0),SQL_HANDLE_STMT,statement,"HY092");
    // 키셋 크기와 커서 시뮬레이션은 전진 읽기 커서에 의미가 없다. 기본값만 받고 다른 값은 01S02로 대체했음을 알린다.
    SQLULEN value = 99;
    check(driver.SQLSetStmtAttr(statement,SQL_ATTR_KEYSET_SIZE,number(0),0) == SQL_SUCCESS,"default keyset size is accepted");
    check(driver.SQLSetStmtAttr(statement,SQL_ATTR_KEYSET_SIZE,number(5),0) == SQL_SUCCESS_WITH_INFO,"non-default keyset size is substituted");
    SQLCHAR state[6]{};
    check(driver.SQLGetDiagRec(SQL_HANDLE_STMT,statement,1,state,nullptr,nullptr,0,nullptr) == SQL_SUCCESS && !std::strcmp(reinterpret_cast<char*>(state),"01S02"),"keyset substitution is reported as 01S02");
    expect(driver,driver.SQLGetStmtAttr(statement,SQL_ATTR_KEYSET_SIZE,&value,0,nullptr),SQL_HANDLE_STMT,statement,"keyset size getter");
    check(value == 0,"keyset size stays at the default");
    expect(driver,driver.SQLGetStmtAttr(statement,SQL_ATTR_SIMULATE_CURSOR,&value,0,nullptr),SQL_HANDLE_STMT,statement,"simulate cursor getter");
    check(value == SQL_SC_NON_UNIQUE,"cursor simulation defaults to non unique");
    check(driver.SQLSetStmtAttr(statement,SQL_ATTR_SIMULATE_CURSOR,number(SQL_SC_UNIQUE),0) == SQL_SUCCESS_WITH_INFO,"unique cursor simulation is substituted");
    error(driver,driver.SQLSetStmtAttr(statement,SQL_ATTR_SIMULATE_CURSOR,number(99),0),SQL_HANDLE_STMT,statement,"HY024");
    // 비동기 완료 이벤트는 지원하지 않는다. NULL(해제)만 받는다.
    check(driver.SQLSetStmtAttr(statement,SQL_ATTR_ASYNC_STMT_EVENT,nullptr,0) == SQL_SUCCESS,"clearing the async event is accepted");
    error(driver,driver.SQLSetStmtAttr(statement,SQL_ATTR_ASYNC_STMT_EVENT,number(1),0),SQL_HANDLE_STMT,statement,"HYC00");
    SQLPOINTER event = number(7);
    expect(driver,driver.SQLGetStmtAttr(statement,SQL_ATTR_ASYNC_STMT_EVENT,&event,0,nullptr),SQL_HANDLE_STMT,statement,"async event getter");
    check(event == nullptr,"no async event is registered");
}
// 비동기를 지원하지 않는다는 능력 보고가 드라이버 자신의 답인지 직접 DLL에서 확인한다. Manager 경유 조회는 Manager가 대신 답할 수 있다.
void check_async_reporting(Driver& driver, SQLHDBC connection) {
    SQLUINTEGER value = 99;
    check(driver.SQLGetInfo(connection,SQL_ASYNC_MODE,&value,0,nullptr) == SQL_SUCCESS && value == SQL_AM_NONE,"SQL_ASYNC_MODE reports no asynchronous execution");
    value = 99;
    check(driver.SQLGetInfo(connection,SQL_ASYNC_DBC_FUNCTIONS,&value,0,nullptr) == SQL_SUCCESS && value == SQL_ASYNC_DBC_NOT_CAPABLE,"SQL_ASYNC_DBC_FUNCTIONS reports not capable");
    value = 99;
    check(driver.SQLGetInfo(connection,SQL_ASYNC_NOTIFICATION,&value,0,nullptr) == SQL_SUCCESS && value == SQL_ASYNC_NOTIFICATION_NOT_CAPABLE,"SQL_ASYNC_NOTIFICATION reports not capable");
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
        check_function_reporting(driver,master_connection);
        check_async_reporting(driver,master_connection);
        check_unsupported_attributes(driver,master_connection,master);
        sql(driver,master,L"DROP USER Q8_NULL_RESET"); close(driver,master_connection,master);
        check(driver.SQLFreeHandle(SQL_HANDLE_ENV,environment) == SQL_SUCCESS,"reset ENV free");
        std::cout << "DIRECT DLL reset/rollback/NULL tablespace/timezone/buffers/relogin failure/function reporting PASS\n";
    });
}
