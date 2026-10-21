#include "hwdbodbc/odbc.hpp"
#include "../helpers/check.hpp"
#include <algorithm>
#include <cstring>
#include <string>

namespace {
SQLWCHAR* w(const std::wstring& text) { return reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(text.c_str())); }
void expect(SQLRETURN result, SQLHSTMT statement, const char* operation) {
    if (SQL_SUCCEEDED(result)) return;
    SQLCHAR state[6]{}, message[1024]{}; SQLINTEGER native = 0;
    SQLGetDiagRec(SQL_HANDLE_STMT, statement, 1, state, &native, message, 1024, nullptr);
    std::cerr << operation << " STATE=" << state << " NATIVE=" << native << " MESSAGE=" << message << '\n'; check(false, operation);
}
void state(SQLHSTMT statement, const char* expected, SQLINTEGER code = 0) {
    SQLCHAR output[6]{}; SQLINTEGER native = 0;
    check(SQLGetDiagRec(SQL_HANDLE_STMT, statement, 1, output, &native, nullptr, 0, nullptr) == SQL_SUCCESS, "prepare error diagnostic");
    if (std::strcmp(reinterpret_cast<char*>(output), expected)) std::cerr << "expected " << expected << " received " << output << '\n';
    check(std::strcmp(reinterpret_cast<char*>(output), expected) == 0 && (!code || native == code), "prepare SQLSTATE/native");
}
void sql(SQLHSTMT statement, const std::wstring& text) { expect(SQLExecDirectW(statement,w(text),SQL_NTS), statement,"direct SQL"); }
void prepare(SQLHSTMT statement, const std::wstring& text) { expect(SQLPrepareW(statement,w(text),SQL_NTS), statement,"SQLPrepareW"); }
SQLINTEGER count(SQLHSTMT statement, const std::wstring& query) {
    sql(statement, query); expect(SQLFetch(statement), statement,"count fetch"); SQLINTEGER value = -1; SQLLEN length = 0;
    expect(SQLGetData(statement,1,SQL_C_SLONG,&value,0,&length), statement,"count data"); expect(SQLCloseCursor(statement),statement,"count close"); return value;
}
std::wstring text(SQLHSTMT statement, SQLUSMALLINT column) {
    SQLWCHAR output[256]{}; SQLLEN length = 0;
    expect(SQLGetData(statement,column,SQL_C_WCHAR,output,sizeof(output),&length),statement,"prepared text data");
    return std::wstring(reinterpret_cast<wchar_t*>(output), static_cast<std::size_t>(length / 2));
}
SQLHSTMT allocate(SQLHDBC connection) { SQLHSTMT statement = nullptr; check(SQLAllocHandle(SQL_HANDLE_STMT,connection,&statement) == SQL_SUCCESS,"prepare STMT allocation"); return statement; }
void reset(SQLHSTMT statement) { expect(SQLFreeStmt(statement,SQL_RESET_PARAMS),statement,"reset parameters"); }
}
void run_prepare_cases(SQLHDBC connection, SQLHENV environment, const std::wstring& connection_string) {
    auto statement = allocate(connection), auxiliary = allocate(connection);
    SQLUINTEGER initial_autocommit = 0;
    check(SQLGetConnectAttr(connection,SQL_ATTR_AUTOCOMMIT,&initial_autocommit,0,nullptr) == SQL_SUCCESS && initial_autocommit == SQL_AUTOCOMMIT_ON,"initial autocommit");
    sql(statement,L"CREATE TABLE Q6_PARAMS (ID INTEGER PRIMARY KEY, TXT VARCHAR(100), N DECIMAL(38,6), B VARBINARY(8), ST TIMESTAMP(6), OPT INTEGER)");
    prepare(statement,L"INSERT INTO Q6_PARAMS VALUES (?, ?, ?, ?, ?, ?)");
    SQLSMALLINT parameters = -1, columns = -1, type = 0, scale = 0, nullable = 0; SQLULEN size = 0;
    expect(SQLNumParams(statement,&parameters),statement,"NumParams INSERT"); check(parameters == 6,"six markers");
    expect(SQLNumResultCols(statement,&columns),statement,"INSERT metadata"); check(columns == 0,"no INSERT result columns");
    expect(SQLDescribeParam(statement,3,&type,&size,&scale,&nullable),statement,"DescribeParam DECIMAL"); check(type == SQL_DECIMAL && size == 38 && scale == 6,"prepared schema numeric metadata");
    check(count(auxiliary,L"SELECT COUNT(*) FROM Q6_PARAMS") == 0,"prepare/describe INSERT has no side effects");
    check(SQLExecute(statement) == SQL_ERROR,"missing binding"); state(statement,"07002");
    SQLINTEGER id = 1; wchar_t value[100] = L"한😀' ? -- {fn UCASE('x')}";
    char decimal[] = "99999999999999999999999999999999.123456";
    unsigned char binary[] = {0,255,0,1}; SQL_TIMESTAMP_STRUCT stamp{2026,10,21,12,34,56,123456000};
    SQLLEN string_length = SQL_NTS, decimal_length = SQL_NTS, binary_length = 4, null_length = SQL_NULL_DATA;
    expect(SQLBindParameter(statement,1,SQL_PARAM_INPUT,SQL_C_SLONG,SQL_INTEGER,10,0,&id,0,nullptr),statement,"bind integer");
    expect(SQLBindParameter(statement,2,SQL_PARAM_INPUT,SQL_C_WCHAR,SQL_WVARCHAR,100,0,value,sizeof(value),&string_length),statement,"bind Unicode");
    expect(SQLBindParameter(statement,3,SQL_PARAM_INPUT,SQL_C_CHAR,SQL_DECIMAL,38,6,decimal,sizeof(decimal),&decimal_length),statement,"bind exact decimal");
    expect(SQLBindParameter(statement,4,SQL_PARAM_INPUT,SQL_C_BINARY,SQL_VARBINARY,8,0,binary,sizeof(binary),&binary_length),statement,"bind binary");
    expect(SQLBindParameter(statement,5,SQL_PARAM_INPUT,SQL_C_TYPE_TIMESTAMP,SQL_TYPE_TIMESTAMP,26,6,&stamp,0,nullptr),statement,"bind timestamp");
    expect(SQLBindParameter(statement,6,SQL_PARAM_INPUT,SQL_C_SLONG,SQL_INTEGER,10,0,nullptr,0,&null_length),statement,"bind NULL without data pointer");
    expect(SQLExecute(statement),statement,"first prepared INSERT"); SQLLEN affected = -1;
    expect(SQLRowCount(statement,&affected),statement,"prepared affected count"); check(affected == 1,"one inserted");
    id = 2; std::fill_n(value,100,L'\0'); const wchar_t next[] = L"바뀐값😀"; std::copy(std::begin(next),std::end(next),value);
    expect(SQLExecute(statement),statement,"same bindings read changed buffer");
    check(count(auxiliary,L"SELECT COUNT(*) FROM Q6_PARAMS") == 2,"two prepared executions");
    sql(auxiliary,L"SELECT TXT,N,B,ST,OPT FROM Q6_PARAMS WHERE ID=1"); expect(SQLFetch(auxiliary),auxiliary,"prepared row fetch");
    check(text(auxiliary,1) == L"한😀' ? -- {fn UCASE('x')}","quotes and SQL syntax remain parameter data");
    check(text(auxiliary,2) == L"99999999999999999999999999999999.123456","server exact decimal roundtrip");
    unsigned char fetched_binary[8]{}; SQLLEN bytes = 0;
    expect(SQLGetData(auxiliary,3,SQL_C_BINARY,fetched_binary,sizeof(fetched_binary),&bytes),auxiliary,"binary roundtrip"); check(bytes == 4 && !std::memcmp(binary,fetched_binary,4),"binary zeros roundtrip");
    check(text(auxiliary,4) == L"2026-10-21 12:34:56.123456","timestamp roundtrip");
    SQLINTEGER nullable_value = 99; expect(SQLGetData(auxiliary,5,SQL_C_SLONG,&nullable_value,0,&bytes),auxiliary,"NULL roundtrip"); check(bytes == SQL_NULL_DATA && nullable_value == 99,"NULL indicator"); expect(SQLCloseCursor(auxiliary),auxiliary,"aux close");
    sql(auxiliary,L"SELECT TXT FROM Q6_PARAMS WHERE ID=2"); expect(SQLFetch(auxiliary),auxiliary,"changed row fetch"); check(text(auxiliary,1) == next,"buffer changes reach server"); expect(SQLCloseCursor(auxiliary),auxiliary,"changed close");

    reset(statement);
    prepare(statement,L"SELECT '?' AS \"?\", CAST(? AS INTEGER) AS I, ? AS S /* ? */ -- ?\n");
    expect(SQLNumParams(statement,&parameters),statement,"quoted marker count"); check(parameters == 2,"quoted and commented markers ignored");
    expect(SQLNumResultCols(statement,&columns),statement,"preexecution result count"); check(columns == 3,"preexecution three columns");
    expect(SQLDescribeColW(statement,2,nullptr,0,nullptr,&type,&size,&scale,&nullable),statement,"DescribeCol before Execute"); check(type == SQL_INTEGER,"CAST result known before Execute");
    expect(SQLDescribeColW(statement,3,nullptr,0,nullptr,&type,&size,&scale,&nullable),statement,"UNKNOWN result before binding"); check(type == SQL_UNKNOWN_TYPE && size == 0,"unknown metadata is not invented");
    check(SQLDescribeParam(statement,2,&type,&size,&scale,&nullable) == SQL_ERROR,"unknown parameter type"); state(statement,"HYC00");
    expect(SQLBindParameter(statement,1,SQL_PARAM_INPUT,SQL_C_SLONG,SQL_INTEGER,10,0,&id,0,nullptr),statement,"bind SELECT integer");
    expect(SQLBindParameter(statement,2,SQL_PARAM_INPUT,SQL_C_WCHAR,SQL_WVARCHAR,100,0,value,sizeof(value),&string_length),statement,"bind SELECT type hint");
    expect(SQLDescribeParam(statement,2,&type,&size,&scale,&nullable),statement,"hinted DescribeParam"); check(type == SQL_WVARCHAR && size == 100,"binding supplies type hint");
    expect(SQLDescribeColW(statement,3,nullptr,0,nullptr,&type,&size,&scale,&nullable),statement,"hinted result before Execute"); check(type == SQL_WVARCHAR && size == 100,"result metadata updated without execution");
    expect(SQLExecute(statement),statement,"prepared SELECT"); expect(SQLFetch(statement),statement,"prepared SELECT fetch");
    check(text(statement,1) == L"?" && text(statement,2) == L"2" && text(statement,3) == next,"prepared SELECT data"); expect(SQLCloseCursor(statement),statement,"prepared SELECT close");
    id = 7; expect(SQLExecute(statement),statement,"execute again after CloseCursor"); expect(SQLFetch(statement),statement,"second SELECT fetch"); check(text(statement,2) == L"7","prepared ID survives CloseCursor"); expect(SQLCloseCursor(statement),statement,"second SELECT close");
    reset(statement);
    for (int i = 0; i < 70; ++i) prepare(statement,L"SELECT 1");
    for (int i = 0; i < 70; ++i) { auto temporary = allocate(connection); prepare(temporary,L"SELECT 1"); check(SQLFreeHandle(SQL_HANDLE_STMT,temporary) == SQL_SUCCESS,"free closes prepared ID"); }
    prepare(statement,L"CREATE TABLE Q6_NEVER (ID INTEGER)");
    expect(SQLNumResultCols(statement,&columns),statement,"prepare DDL metadata"); check(columns == 0,"DDL no result");
    // 같은 이름의 CREATE가 성공하므로 준비 중에 DDL이 실행되지 않았음을 확인한다.
    sql(auxiliary,L"CREATE TABLE Q6_NEVER (ID INTEGER)"); sql(auxiliary,L"DROP TABLE Q6_NEVER");

    SQLHDBC observer = nullptr; check(SQLAllocHandle(SQL_HANDLE_DBC,environment,&observer) == SQL_SUCCESS,"observer DBC");
    check(SQL_SUCCEEDED(SQLDriverConnectW(observer,nullptr,w(connection_string),SQL_NTS,nullptr,0,nullptr,SQL_DRIVER_NOPROMPT)),"observer login");
    auto observed = allocate(observer);
    check(SQLSetConnectAttr(connection,SQL_ATTR_AUTOCOMMIT,reinterpret_cast<SQLPOINTER>(SQL_AUTOCOMMIT_OFF),0) == SQL_SUCCESS,"manual transaction");
    sql(auxiliary,L"INSERT INTO Q6_PARAMS (ID,TXT) VALUES (3,'uncommitted')");
    prepare(statement,L"CREATE TABLE Q6_NO_COMMIT (ID INTEGER)"); expect(SQLNumResultCols(statement,&columns),statement,"describe DDL in transaction");
    check(count(observed,L"SELECT COUNT(*) FROM Q6_PARAMS") == 2,"prepare DDL does not commit prior work");
    SQLUINTEGER current_autocommit = 99; check(SQLGetConnectAttr(connection,SQL_ATTR_AUTOCOMMIT,&current_autocommit,0,nullptr) == SQL_SUCCESS && current_autocommit == SQL_AUTOCOMMIT_OFF,"prepare preserves autocommit");
    sql(auxiliary,L"ROLLBACK"); check(SQLSetConnectAttr(connection,SQL_ATTR_AUTOCOMMIT,reinterpret_cast<SQLPOINTER>(SQL_AUTOCOMMIT_ON),0) == SQL_SUCCESS,"restore autocommit");
    check(count(observed,L"SELECT COUNT(*) FROM Q6_PARAMS") == 2,"rollback preserved by prepare");
    check(SQLFreeHandle(SQL_HANDLE_STMT,observed) == SQL_SUCCESS && SQLDisconnect(observer) == SQL_SUCCESS && SQLFreeHandle(SQL_HANDLE_DBC,observer) == SQL_SUCCESS,"observer cleanup");
    prepare(statement,L"SELECT ID FROM Q6_PARAMS"); sql(auxiliary,L"ALTER TABLE Q6_PARAMS ADD EXTRA INTEGER");
    check(SQLExecute(statement) == SQL_ERROR,"schema invalidates prepared statement"); state(statement,"0A000",8009);
    prepare(statement,L"SELECT ID FROM Q6_PARAMS"); expect(SQLExecute(statement),statement,"reprepare after DDL"); expect(SQLCloseCursor(statement),statement,"reprepared close");
    sql(auxiliary,L"CREATE USER Q6_READER IDENTIFIED BY 'q6Reader' DEFAULT TABLESPACE SYSTEM"); sql(auxiliary,L"GRANT SELECT ON Q6_PARAMS TO Q6_READER");
    const auto uid = connection_string.find(L"UID=SYSTEM;PWD=HelloWorldDB;"); check(uid != std::wstring::npos,"test credentials segment");
    auto restricted = connection_string; restricted.replace(uid, std::wcslen(L"UID=SYSTEM;PWD=HelloWorldDB;"),L"UID=Q6_READER;PWD=q6Reader;");
    SQLHDBC reader = nullptr; check(SQLAllocHandle(SQL_HANDLE_DBC,environment,&reader) == SQL_SUCCESS,"reader DBC");
    check(SQL_SUCCEEDED(SQLDriverConnectW(reader,nullptr,w(restricted),SQL_NTS,nullptr,0,nullptr,SQL_DRIVER_NOPROMPT)),"reader login");
    auto reader_statement = allocate(reader); prepare(reader_statement,L"SELECT ID FROM Q6_PARAMS");
    sql(auxiliary,L"REVOKE SELECT ON Q6_PARAMS FROM Q6_READER"); check(SQLExecute(reader_statement) == SQL_ERROR,"execute rechecks revoked permission"); state(reader_statement,"42501");
    check(SQLFreeHandle(SQL_HANDLE_STMT,reader_statement) == SQL_SUCCESS && SQLDisconnect(reader) == SQL_SUCCESS && SQLFreeHandle(SQL_HANDLE_DBC,reader) == SQL_SUCCESS,"reader cleanup"); sql(auxiliary,L"DROP USER Q6_READER");

    SQLWCHAR converted[256]{}; SQLINTEGER needed = -1;
    const std::wstring escaped = L"SELECT {fn UCASE('한😀')}, {d '2026-10-21'}";
    check(SQLNativeSqlW(connection,w(escaped),SQL_NTS,converted,256,&needed) == SQL_SUCCESS,"SQLNativeSqlW");
    check(std::wstring(reinterpret_cast<wchar_t*>(converted)) == L"SELECT UPPER('한😀'), DATE '2026-10-21'" && needed == static_cast<SQLINTEGER>(std::wcslen(reinterpret_cast<wchar_t*>(converted))),"NativeSQL W units");
    struct { SQLWCHAR text[3]{}; SQLWCHAR canary = 0x5a5a; } short_sql;
    const auto full_length = needed;
    check(SQLNativeSqlW(connection,w(escaped),SQL_NTS,short_sql.text,3,&needed) == SQL_SUCCESS_WITH_INFO
        && needed == full_length && short_sql.text[2] == 0 && short_sql.canary == 0x5a5a,"NativeSql W truncation and code unit length");
    sql(statement,escaped); expect(SQLFetch(statement),statement,"escape query fetch"); check(text(statement,1) == L"한😀" && text(statement,2) == L"2026-10-21","executed escape translation"); expect(SQLCloseCursor(statement),statement,"escape close");
    expect(SQLSetStmtAttr(statement,SQL_ATTR_NOSCAN,reinterpret_cast<SQLPOINTER>(SQL_NOSCAN_ON),0),statement,"NOSCAN on");
    check(SQLExecDirectW(statement,w(escaped),SQL_NTS) == SQL_ERROR,"NOSCAN leaves braces to server");
    expect(SQLSetStmtAttr(statement,SQL_ATTR_NOSCAN,reinterpret_cast<SQLPOINTER>(SQL_NOSCAN_OFF),0),statement,"NOSCAN off");
    reset(statement); id = 4;
    expect(SQLBindParameter(statement,1,SQL_PARAM_INPUT,SQL_C_SLONG,SQL_INTEGER,10,0,&id,0,nullptr),statement,"bind before ExecDirect");
    sql(statement,L"INSERT INTO Q6_PARAMS (ID) VALUES (?)"); check(count(auxiliary,L"SELECT COUNT(*) FROM Q6_PARAMS") == 3,"parameterized ExecDirect");
    check(SQLBindParameter(statement,0,SQL_PARAM_INPUT,SQL_C_SLONG,SQL_INTEGER,10,0,&id,0,nullptr) == SQL_ERROR,"zero ordinal"); state(statement,"07009");
    check(SQLBindParameter(statement,1,SQL_PARAM_OUTPUT,SQL_C_SLONG,SQL_INTEGER,10,0,&id,0,nullptr) == SQL_ERROR,"output unsupported"); state(statement,"HYC00");
    check(SQLBindParameter(statement,1,SQL_PARAM_INPUT,SQL_C_SLONG,SQL_DECIMAL,39,0,&id,0,nullptr) == SQL_ERROR,"invalid precision"); state(statement,"HY104");
    reset(statement);
    SQLCHAR ansi_sql[] = "SELECT {fn ABS(CAST(? AS INTEGER))} AS N";
    expect(SQLPrepare(statement,ansi_sql,SQL_NTS),statement,"ANSI Prepare with escape");
    id = -42; expect(SQLBindParameter(statement,1,SQL_PARAM_INPUT,SQL_C_DEFAULT,SQL_INTEGER,10,0,&id,0,nullptr),statement,"default C input");
    expect(SQLExecute(statement),statement,"ANSI prepared Execute"); expect(SQLFetch(statement),statement,"ANSI prepared Fetch"); check(text(statement,1) == L"42","ANSI Prepare and default C"); expect(SQLCloseCursor(statement),statement,"ANSI prepared close");
    SQLCHAR ansi_native[128]{}; check(SQLNativeSql(connection,ansi_sql,SQL_NTS,ansi_native,128,&needed) == SQL_SUCCESS,"ANSI NativeSql");
    check(std::string(reinterpret_cast<char*>(ansi_native)) == "SELECT ABS(CAST(? AS INTEGER)) AS N","ANSI NativeSql output");
    reset(statement);
    std::wstring interval_query = L"SELECT "; SQL_INTERVAL_STRUCT intervals[13]{};
    for (int i = 0; i < 13; ++i) { if (i) interval_query += L","; interval_query += L"?"; }
    prepare(statement,interval_query);
    for (int i = 0; i < 13; ++i) {
        auto& interval = intervals[i]; interval.interval_type = static_cast<SQLINTERVAL>(i + 1); interval.interval_sign = SQL_TRUE;
        if (i == 0 || i == 1 || i == 6) interval.intval.year_month = {1,2};
        else interval.intval.day_second = {3,4,5,6,123456000};
        expect(SQLBindParameter(statement,static_cast<SQLUSMALLINT>(i + 1),SQL_PARAM_INPUT,static_cast<SQLSMALLINT>(SQL_C_INTERVAL_YEAR + i),
            static_cast<SQLSMALLINT>(SQL_INTERVAL_YEAR + i),0,6,&interval,0,nullptr),statement,"bind native interval");
    }
    expect(SQLExecute(statement),statement,"13 prepared intervals Execute"); expect(SQLFetch(statement),statement,"13 intervals fetch");
    for (int i = 0; i < 13; ++i) {
        SQL_INTERVAL_STRUCT received{}; SQLLEN length = 0;
        expect(SQLGetData(statement,static_cast<SQLUSMALLINT>(i + 1),static_cast<SQLSMALLINT>(SQL_C_INTERVAL_YEAR + i),&received,0,&length),statement,"prepared interval GetData");
        check(length == sizeof(received) && received.interval_type == i + 1 && received.interval_sign == SQL_TRUE,"prepared interval qualifier/sign");
        if (i == 0 || i == 6) check(received.intval.year_month.year == 1,"prepared interval year");
        if (i == 1 || i == 6) check(received.intval.year_month.month == 2,"prepared interval month");
        if (i == 5 || i == 9 || i == 11 || i == 12) check(received.intval.day_second.fraction == 123456000,"prepared interval fractional seconds");
    }
    expect(SQLCloseCursor(statement),statement,"prepared interval close");
    reset(statement);
    sql(auxiliary,L"CREATE TABLE Q6_TZ (TS TIMESTAMP(6) WITH TIME ZONE, TM TIME(3) WITH TIME ZONE)");
    char timestamp_zone[] = "2026-10-21 12:34:56.123456+09:00", time_zone[] = "12:34:56.123+09:00";
    SQLLEN zone_length = SQL_NTS;
    // ODBC에는 표준 offset 구조체가 없으므로 메타데이터와 같은 WVARCHAR로 바인딩한다.
    expect(SQLBindParameter(statement,1,SQL_PARAM_INPUT,SQL_C_CHAR,SQL_WVARCHAR,40,0,timestamp_zone,sizeof(timestamp_zone),&zone_length),statement,"bind timestamp zone before Prepare");
    expect(SQLBindParameter(statement,2,SQL_PARAM_INPUT,SQL_C_CHAR,SQL_WVARCHAR,40,0,time_zone,sizeof(time_zone),&zone_length),statement,"bind time zone before Prepare");
    prepare(statement,L"INSERT INTO Q6_TZ VALUES (?, ?)"); expect(SQLExecute(statement),statement,"timezone bound string Execute");
    sql(auxiliary,L"SELECT TS,TM FROM Q6_TZ"); expect(SQLFetch(auxiliary),auxiliary,"timezone prepared fetch");
    check(text(auxiliary,1) == L"2026-10-21 12:34:56.123456+09:00" && text(auxiliary,2) == L"12:34:56.123+09:00","timezone parameter offsets preserved"); expect(SQLCloseCursor(auxiliary),auxiliary,"timezone close");
    check(SQLFreeHandle(SQL_HANDLE_STMT,statement) == SQL_SUCCESS && SQLFreeHandle(SQL_HANDLE_STMT,auxiliary) == SQL_SUCCESS,"prepared final cleanup");
    std::cout << "ODBC prepare/describe/bind/reexecute/no-side-effects/privilege/invalidation PASS\n";
}
