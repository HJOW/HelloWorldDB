#include "hwdbodbc/odbc.hpp"
#include "../helpers/check.hpp"
#include <cstring>
#include <string>
#include <vector>

namespace {
SQLWCHAR* wide(const wchar_t* text) { return reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(text)); }
void expect(SQLRETURN result, SQLHSTMT statement, const char* operation) {
    if (SQL_SUCCEEDED(result)) return;
    SQLCHAR state[6]{}, message[1024]{};
    SQLGetDiagRec(SQL_HANDLE_STMT,statement,1,state,nullptr,message,1024,nullptr);
    std::cerr << operation << " " << state << " " << message << '\n'; check(false,operation);
}
void error(SQLRETURN result, SQLHSTMT statement, const char* expected) {
    check(result == SQL_ERROR,"data operation must fail"); SQLCHAR state[6]{};
    check(SQLGetDiagRec(SQL_HANDLE_STMT,statement,1,state,nullptr,nullptr,0,nullptr) == SQL_SUCCESS,"data diagnostic");
    if (std::strcmp(reinterpret_cast<char*>(state),expected)) std::cerr << state << " != " << expected << '\n';
    check(!std::strcmp(reinterpret_cast<char*>(state),expected),"data SQLSTATE");
}
void sql(SQLHSTMT statement, const wchar_t* text) { expect(SQLExecDirectW(statement,wide(text),SQL_NTS),statement,"data direct SQL"); }
void prepare(SQLHSTMT statement, const wchar_t* text) { expect(SQLPrepareW(statement,wide(text),SQL_NTS),statement,"data prepare"); }
void bind(SQLHSTMT statement, SQLUSMALLINT index, SQLSMALLINT ctype, SQLSMALLINT sqltype, SQLULEN size, SQLPOINTER token, SQLLEN capacity, SQLLEN* length) {
    expect(SQLBindParameter(statement,index,SQL_PARAM_INPUT,ctype,sqltype,size,0,token,capacity,length),statement,"data bind");
}
void token(SQLHSTMT statement, SQLPOINTER expected) {
    static int call = 0; ++call;
    SQLPOINTER actual = nullptr; const auto result = SQLParamData(statement,&actual);
    if (result != SQL_NEED_DATA || actual != expected) {
        SQLCHAR state[6]{}, message[1024]{}; SQLGetDiagRec(SQL_HANDLE_STMT,statement,1,state,nullptr,message,1024,nullptr);
        std::cerr << "TOKEN call=" << call << " result=" << result << " actual=" << actual << " expected=" << expected << " " << state << " " << message << '\n';
    }
    check(result == SQL_NEED_DATA && actual == expected,"requested parameter token");
}
void cancel(SQLHSTMT statement) { expect(SQLCancel(statement),statement,"local input cancel"); }
std::wstring text(SQLHSTMT statement, SQLUSMALLINT column) {
    SQLWCHAR buffer[257]{}; SQLLEN length = 0; std::wstring output;
    for (;;) {
        const auto result = SQLGetData(statement,column,SQL_C_WCHAR,buffer,sizeof(buffer),&length);
        if (result == SQL_NO_DATA) break;
        expect(result,statement,"data text fetch"); output += reinterpret_cast<wchar_t*>(buffer);
        if (result == SQL_SUCCESS) break;
    }
    return output;
}
}
void run_data_cases(SQLHDBC connection) {
    SQLHSTMT statement = nullptr, query = nullptr;
    check(SQLAllocHandle(SQL_HANDLE_STMT,connection,&statement) == SQL_SUCCESS && SQLAllocHandle(SQL_HANDLE_STMT,connection,&query) == SQL_SUCCESS,"data STMT allocation");
    sql(query,L"CREATE TABLE Q7_DATA (ID INTEGER PRIMARY KEY, TXT VARCHAR, B VARBINARY)");
    prepare(statement,L"INSERT INTO Q7_DATA VALUES (?, ?, ?)");
    SQLINTEGER id = 1; SQLLEN id_length = SQL_DATA_AT_EXEC, text_length = SQL_LEN_DATA_AT_EXEC(6), binary_length = SQL_DATA_AT_EXEC;
    int text_token = 0, binary_token = 0;
    bind(statement,1,SQL_C_SLONG,SQL_INTEGER,10,&id,0,&id_length);
    bind(statement,2,SQL_C_WCHAR,SQL_WVARCHAR,65535,&text_token,0,&text_length);
    bind(statement,3,SQL_C_BINARY,SQL_VARBINARY,65535,&binary_token,0,&binary_length);
    SQLPOINTER value = nullptr;
    error(SQLParamData(statement,&value),statement,"HY010");
    error(SQLPutData(statement,&id,sizeof(id)),statement,"HY010");
    check(SQLExecute(statement) == SQL_NEED_DATA,"Execute enters NEED_DATA");
    token(statement,&id); expect(SQLPutData(statement,&id,0),statement,"fixed C type ignores byte length");
    token(statement,&text_token);
    const wchar_t unicode[] = L"한😀";
    // surrogate 쌍 중간에서 조각을 나누되 최종 문자열은 엄격하게 검증한다.
    expect(SQLPutData(statement,wide(unicode),4),statement,"first Unicode fragment");
    expect(SQLPutData(statement,wide(unicode + 2),2),statement,"second Unicode fragment");
    token(statement,&binary_token); unsigned char binary[] = {0,255,0,42};
    expect(SQLPutData(statement,binary,1),statement,"binary first fragment");
    expect(SQLPutData(statement,binary + 1,3),statement,"binary final fragment");
    expect(SQLParamData(statement,&value),statement,"final ParamData executes");
    SQLLEN affected = 0; expect(SQLRowCount(statement,&affected),statement,"streamed row count"); check(affected == 1,"streamed insert row count");
    sql(query,L"SELECT TXT,B FROM Q7_DATA WHERE ID=1"); expect(SQLFetch(query),query,"streamed row fetch"); check(text(query,1) == unicode,"Unicode reconstructed");
    unsigned char actual[4]{}; SQLLEN length = 0; expect(SQLGetData(query,2,SQL_C_BINARY,actual,4,&length),query,"binary roundtrip");
    check(length == 4 && !std::memcmp(actual,binary,4),"binary zero bytes preserved"); expect(SQLCloseCursor(query),query,"streamed cursor close");

    // NULL과 빈 문자열은 각각 다른 값이다.
    id_length = 0; id = 2; text_length = SQL_DATA_AT_EXEC;
    check(SQLExecute(statement) == SQL_NEED_DATA,"second streamed execute"); token(statement,&text_token);
    expect(SQLPutData(statement,nullptr,SQL_NULL_DATA),statement,"streamed NULL");
    token(statement,&binary_token); expect(SQLPutData(statement,nullptr,0),statement,"empty binary"); expect(SQLParamData(statement,&value),statement,"NULL insert");
    id = 3; check(SQLExecute(statement) == SQL_NEED_DATA,"empty text execute"); token(statement,&text_token);
    expect(SQLPutData(statement,nullptr,0),statement,"empty Unicode"); token(statement,&binary_token);
    expect(SQLPutData(statement,nullptr,SQL_NULL_DATA),statement,"binary NULL"); expect(SQLParamData(statement,&value),statement,"empty text insert");
    sql(query,L"SELECT COUNT(*) FROM Q7_DATA WHERE TXT IS NULL"); expect(SQLFetch(query),query,"NULL count fetch"); check(text(query,1) == L"1","empty text differs from NULL"); expect(SQLCloseCursor(query),query,"NULL count close");

    id = 4; text_length = SQL_LEN_DATA_AT_EXEC(4);
    check(SQLExecute(statement) == SQL_NEED_DATA,"length mismatch execute"); token(statement,&text_token);
    expect(SQLPutData(statement,wide(L"x"),2),statement,"short input"); error(SQLParamData(statement,&value),statement,"22026");
    check(SQLExecute(statement) == SQL_NEED_DATA,"reexecute after short input"); token(statement,&text_token);
    error(SQLPutData(statement,wide(L"xxx"),6),statement,"22001"); cancel(statement);
    text_length = SQL_DATA_AT_EXEC;
    check(SQLExecute(statement) == SQL_NEED_DATA,"cancel before first ParamData"); cancel(statement);
    error(SQLParamData(statement,&value),statement,"HY010");
    check(SQLExecute(statement) == SQL_NEED_DATA,"cancel in input"); token(statement,&text_token); expect(SQLPutData(statement,wide(L"partial"),SQL_NTS),statement,"cancelled input"); cancel(statement);
    // 취소 뒤 원래 준비 문장과 앱의 바인딩은 재사용할 수 있다.
    std::wstring large(60000,L'한');
    check(SQLExecute(statement) == SQL_NEED_DATA,"large value execute"); token(statement,&text_token);
    for (std::size_t offset = 0; offset < large.size(); offset += 1000)
        expect(SQLPutData(statement,wide(large.c_str() + offset),2000),statement,"large value fragment");
    token(statement,&binary_token); expect(SQLPutData(statement,binary,4),statement,"large row binary"); expect(SQLParamData(statement,&value),statement,"large input commit");
    sql(query,L"SELECT TXT FROM Q7_DATA WHERE ID=4"); expect(SQLFetch(query),query,"large result fetch"); check(text(query,1) == large,"large input reconstructed exactly"); expect(SQLCloseCursor(query),query,"large cursor close");

    expect(SQLFreeStmt(statement,SQL_RESET_PARAMS),statement,"reset streaming bindings");
    prepare(statement,L"INSERT INTO Q7_DATA (ID,TXT) VALUES (?,?)");
    SQLINTEGER ids[3] = {10,10,12}; SQLLEN lengths[3] = {SQL_DATA_AT_EXEC,SQL_DATA_AT_EXEC,SQL_DATA_AT_EXEC};
    char tokens[3]{}; SQLUSMALLINT statuses[3]{}; SQLULEN processed = 0;
    expect(SQLSetStmtAttr(statement,SQL_ATTR_PARAMSET_SIZE,reinterpret_cast<SQLPOINTER>(3),0),statement,"streamed array size");
    expect(SQLSetStmtAttr(statement,SQL_ATTR_PARAM_STATUS_PTR,statuses,0),statement,"streamed statuses");
    expect(SQLSetStmtAttr(statement,SQL_ATTR_PARAMS_PROCESSED_PTR,&processed,0),statement,"streamed processed");
    bind(statement,1,SQL_C_SLONG,SQL_INTEGER,10,ids,0,nullptr);
    bind(statement,2,SQL_C_CHAR,SQL_VARCHAR,20,tokens,1,lengths);
    check(SQLExecute(statement) == SQL_NEED_DATA,"streamed array Execute");
    for (int row = 0; row < 3; ++row) {
        token(statement,tokens + row); check(processed == static_cast<SQLULEN>(row + 1),"current streamed array set");
        char item[] = "value"; expect(SQLPutData(statement,item,5),statement,"array fragment");
    }
    check(SQLParamData(statement,&value) == SQL_SUCCESS_WITH_INFO,"streamed array partial failure");
    check(processed == 3 && statuses[0] == SQL_PARAM_SUCCESS && statuses[1] == SQL_PARAM_ERROR && statuses[2] == SQL_PARAM_SUCCESS,"streamed array PK error status");
    expect(SQLRowCount(statement,&affected),statement,"streamed array row count"); check(affected == 2,"streamed array successful count");
    check(SQLFreeHandle(SQL_HANDLE_STMT,statement) == SQL_SUCCESS && SQLFreeHandle(SQL_HANDLE_STMT,query) == SQL_SUCCESS,"streaming statements cleanup");
    std::cout << "ODBC data-at-execution/Unicode/binary/NULL/arrays/cancel PASS\n";
}
