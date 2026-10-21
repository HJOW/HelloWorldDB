#include "hwdbodbc/odbc.hpp"
#include "../helpers/check.hpp"
#include <algorithm>
#include <array>
#include <cstring>
#include <cstddef>
#include <string>

namespace {
SQLPOINTER number(SQLULEN value) { return reinterpret_cast<SQLPOINTER>(value); }
SQLWCHAR* wide(const std::wstring& value) { return reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(value.c_str())); }
template<class T> T* member(void* structure, std::size_t offset) { return reinterpret_cast<T*>(static_cast<unsigned char*>(structure) + offset); }
std::wstring packed_text(const void* pointer, std::size_t capacity) {
    std::wstring value;
    for (std::size_t i = 0; i < capacity; ++i) { wchar_t unit = 0; std::memcpy(&unit,static_cast<const unsigned char*>(pointer) + i * 2,2); if (!unit) break; value += unit; }
    return value;
}
void expect(SQLRETURN result, SQLSMALLINT type, SQLHANDLE handle, const char* operation) {
    if (SQL_SUCCEEDED(result)) return;
    SQLCHAR state[6]{}, message[1024]{}; SQLINTEGER native = 0;
    SQLGetDiagRec(type,handle,1,state,&native,message,1024,nullptr);
    std::cerr << operation << " STATE=" << state << " NATIVE=" << native << " MESSAGE=" << message << '\n'; check(false,operation);
}
void state(SQLHSTMT statement, const char* expected, SQLLEN row = 0, SQLINTEGER column = 0) {
    SQLCHAR actual[6]{}; check(SQLGetDiagRec(SQL_HANDLE_STMT,statement,1,actual,nullptr,nullptr,0,nullptr) == SQL_SUCCESS,"array diagnostic");
    if (std::strcmp(reinterpret_cast<char*>(actual),expected)) std::cerr << actual << " != " << expected << '\n';
    check(!std::strcmp(reinterpret_cast<char*>(actual),expected),"array SQLSTATE");
    if (row) { SQLLEN actual_row = 0; check(SQLGetDiagField(SQL_HANDLE_STMT,statement,1,SQL_DIAG_ROW_NUMBER,&actual_row,0,nullptr) == SQL_SUCCESS && actual_row == row,"array diagnostic row"); }
    if (column) { SQLINTEGER actual_column = 0; check(SQLGetDiagField(SQL_HANDLE_STMT,statement,1,SQL_DIAG_COLUMN_NUMBER,&actual_column,0,nullptr) == SQL_SUCCESS && actual_column == column,"array diagnostic column"); }
}
void sql(SQLHSTMT statement, const std::wstring& value) { expect(SQLExecDirectW(statement,wide(value),SQL_NTS),SQL_HANDLE_STMT,statement,"array direct SQL"); }
void prepare(SQLHSTMT statement, const std::wstring& value) { expect(SQLPrepareW(statement,wide(value),SQL_NTS),SQL_HANDLE_STMT,statement,"array Prepare"); }
void attribute(SQLHSTMT statement, SQLINTEGER field, SQLPOINTER value) { expect(SQLSetStmtAttr(statement,field,value,0),SQL_HANDLE_STMT,statement,"array SetStmtAttr"); }
SQLHSTMT allocate(SQLHDBC connection) { SQLHSTMT result = nullptr; check(SQLAllocHandle(SQL_HANDLE_STMT,connection,&result) == SQL_SUCCESS,"array STMT"); return result; }
SQLHDESC descriptor(SQLHSTMT statement, SQLINTEGER field) { SQLHDESC result = nullptr; expect(SQLGetStmtAttr(statement,field,&result,0,nullptr),SQL_HANDLE_STMT,statement,"Get descriptor"); return result; }
void set(SQLHDESC descriptor, SQLSMALLINT record, SQLSMALLINT field, SQLPOINTER value) { expect(SQLSetDescField(descriptor,record,field,value,0),SQL_HANDLE_DESC,descriptor,"SetDescField"); }
SQLINTEGER count(SQLHSTMT statement, const std::wstring& query) {
    sql(statement,query); expect(SQLFetch(statement),SQL_HANDLE_STMT,statement,"array count fetch"); SQLINTEGER value = -1; SQLLEN length = 0;
    expect(SQLGetData(statement,1,SQL_C_SLONG,&value,0,&length),SQL_HANDLE_STMT,statement,"array count data"); expect(SQLCloseCursor(statement),SQL_HANDLE_STMT,statement,"array count close"); return value;
}
#pragma pack(push,1)
struct PackedRow { unsigned char prefix; SQLINTEGER id; SQLLEN id_length; SQLWCHAR text[4]; SQLLEN indicator; SQLLEN octets; unsigned char canary; };
struct PackedParameter { unsigned char prefix; SQLINTEGER id; SQLLEN id_length; SQLWCHAR text[8]; SQLLEN indicator; SQLLEN octets; unsigned char canary; };
#pragma pack(pop)
}
void run_descriptor_cases(SQLHDBC connection) {
    std::cout << "descriptor: column rowsets\n";
    auto statement = allocate(connection), other = allocate(connection);
    sql(statement,L"CREATE TABLE Q7_ROWS (ID INTEGER PRIMARY KEY, TXT VARCHAR(100), N DECIMAL(38,6))");
    sql(statement,L"INSERT INTO Q7_ROWS VALUES (1,'abcdef',1.234567),(2,NULL,2.345678),(3,'한😀',3),(4,'tail',4),(5,'last',5)");
    SQLINTEGER ids[3]{}; SQLLEN id_lengths[3]{}, text_lengths[3]{}; SQLWCHAR texts[3][16]{};
    SQLUSMALLINT statuses[3]{}; SQLULEN fetched = 99;
    attribute(statement,SQL_ATTR_ROW_ARRAY_SIZE,number(3)); attribute(statement,SQL_ATTR_ROWS_FETCHED_PTR,&fetched); attribute(statement,SQL_ATTR_ROW_STATUS_PTR,statuses);
    expect(SQLBindCol(statement,1,SQL_C_SLONG,ids,0,id_lengths),SQL_HANDLE_STMT,statement,"column-wise integer binding");
    expect(SQLBindCol(statement,2,SQL_C_WCHAR,texts,sizeof(texts[0]),text_lengths),SQL_HANDLE_STMT,statement,"column-wise Unicode binding");
    sql(statement,L"SELECT ID,TXT FROM Q7_ROWS ORDER BY ID");
    expect(SQLFetch(statement),SQL_HANDLE_STMT,statement,"first column rowset");
    check(fetched == 3 && ids[0] == 1 && ids[1] == 2 && ids[2] == 3 && text_lengths[1] == SQL_NULL_DATA,"column-wise values and NULL indicator array");
    check(std::wstring(reinterpret_cast<wchar_t*>(texts[2])) == L"한😀" && std::all_of(std::begin(statuses),std::end(statuses),[](auto status) { return status == SQL_ROW_SUCCESS; }),"column-wise Unicode and statuses");
    SQLULEN row_number = 0; expect(SQLGetStmtAttr(statement,SQL_ATTR_ROW_NUMBER,&row_number,0,nullptr),SQL_HANDLE_STMT,statement,"rowset number"); check(row_number == 1,"row number is first row of rowset");
    SQLINTEGER data = 0; SQLLEN length = 0;
    check(SQLGetData(statement,1,SQL_C_SLONG,&data,0,&length) == SQL_ERROR,"GetData rowset restriction");
    expect(SQLFetch(statement),SQL_HANDLE_STMT,statement,"last partial rowset");
    check(fetched == 2 && ids[0] == 4 && ids[1] == 5 && ids[2] == 3 && statuses[2] == SQL_ROW_NOROW,"partial rowset leaves unused application buffer unchanged");
    expect(SQLGetStmtAttr(statement,SQL_ATTR_ROW_NUMBER,&row_number,0,nullptr),SQL_HANDLE_STMT,statement,"last rowset number"); check(row_number == 4,"last rowset first number");
    check(SQLFetch(statement) == SQL_NO_DATA && fetched == 0 && statuses[0] == SQL_ROW_NOROW && statuses[1] == SQL_ROW_NOROW,"rowset end");
    expect(SQLCloseCursor(statement),SQL_HANDLE_STMT,statement,"column rowset close");
    attribute(statement,SQL_ATTR_MAX_ROWS,number(4)); sql(statement,L"SELECT ID,TXT FROM Q7_ROWS ORDER BY ID");
    expect(SQLFetch(statement),SQL_HANDLE_STMT,statement,"max rows first rowset"); check(fetched == 3,"max rows first count");
    expect(SQLFetch(statement),SQL_HANDLE_STMT,statement,"max rows partial rowset"); check(fetched == 1 && ids[0] == 4 && statuses[1] == SQL_ROW_NOROW,"max rows limits total rows across rowsets");
    check(SQLFetch(statement) == SQL_NO_DATA && fetched == 0,"max rows end"); expect(SQLCloseCursor(statement),SQL_HANDLE_STMT,statement,"max rows close"); attribute(statement,SQL_ATTR_MAX_ROWS,number(0));
    expect(SQLBindCol(statement,2,SQL_C_WCHAR,nullptr,0,nullptr),SQL_HANDLE_STMT,statement,"unbind second column");
    sql(statement,L"SELECT CASE WHEN ID=2 THEN 'bad' ELSE CAST(ID AS VARCHAR(10)) END AS X FROM Q7_ROWS ORDER BY ID");
    check(SQLFetch(statement) == SQL_SUCCESS_WITH_INFO,"rowset mixed conversion success"); state(statement,"22018",2,1);
    check(fetched == 3 && statuses[0] == SQL_ROW_SUCCESS && statuses[1] == SQL_ROW_ERROR && statuses[2] == SQL_ROW_SUCCESS,"mixed row conversion statuses"); expect(SQLCloseCursor(statement),SQL_HANDLE_STMT,statement,"mixed conversion close");
    sql(statement,L"SELECT 'bad' AS X FROM Q7_ROWS"); check(SQLFetch(statement) == SQL_ERROR,"all rows fail conversion");
    check(fetched == 3 && statuses[0] == SQL_ROW_ERROR && statuses[1] == SQL_ROW_ERROR && statuses[2] == SQL_ROW_ERROR,"all row errors still count processed rows"); expect(SQLCloseCursor(statement),SQL_HANDLE_STMT,statement,"all row errors close");

    PackedRow packed[4]{}; for (auto& row : packed) { row.prefix = 0x5a; row.canary = 0xa5; row.id = -99; row.octets = 777; }
    std::cout << "descriptor: packed rowsets\n";
    SQLLEN offset = sizeof(PackedRow);
    attribute(statement,SQL_ATTR_ROW_BIND_TYPE,number(sizeof(PackedRow))); attribute(statement,SQL_ATTR_ROW_BIND_OFFSET_PTR,&offset);
    expect(SQLBindCol(statement,1,SQL_C_SLONG,member<SQLINTEGER>(packed,offsetof(PackedRow,id)),0,member<SQLLEN>(packed,offsetof(PackedRow,id_length))),SQL_HANDLE_STMT,statement,"packed integer binding");
    expect(SQLBindCol(statement,2,SQL_C_WCHAR,member<SQLWCHAR>(packed,offsetof(PackedRow,text)),sizeof(packed[0].text),member<SQLLEN>(packed,offsetof(PackedRow,indicator))),SQL_HANDLE_STMT,statement,"packed text binding");
    auto ard = descriptor(statement,SQL_ATTR_APP_ROW_DESC);
    set(ard,2,SQL_DESC_OCTET_LENGTH_PTR,member<SQLLEN>(packed,offsetof(PackedRow,octets)));
    sql(statement,L"SELECT ID,TXT FROM Q7_ROWS ORDER BY ID");
    check(SQLFetch(statement) == SQL_SUCCESS_WITH_INFO,"packed first rowset has truncation"); state(statement,"01004",1,2);
    check(fetched == 3 && packed[0].id == -99 && packed[1].id == 1 && packed[2].id == 2 && packed[3].id == 3,"packed stride plus offset");
    check(packed_text(packed[1].text,4) == L"abc" && packed[1].indicator == 0 && packed[1].octets == 12,"separate nonnull indicator and octet length");
    check(packed[2].indicator == SQL_NULL_DATA && packed[2].octets == 777 && packed_text(packed[3].text,4) == L"한😀","separate NULL indicator and surrogate preservation");
    check(statuses[0] == SQL_ROW_SUCCESS_WITH_INFO && statuses[1] == SQL_ROW_SUCCESS && statuses[2] == SQL_ROW_SUCCESS,"packed row statuses");
    for (const auto& row : packed) check(row.prefix == 0x5a && row.canary == 0xa5,"packed canaries");
    expect(SQLCloseCursor(statement),SQL_HANDLE_STMT,statement,"packed close");
    attribute(statement,SQL_ATTR_ROW_BIND_TYPE,number(SQL_BIND_BY_COLUMN)); attribute(statement,SQL_ATTR_ROW_BIND_OFFSET_PTR,nullptr); attribute(statement,SQL_ATTR_ROW_ARRAY_SIZE,number(1));
    expect(SQLFreeStmt(statement,SQL_UNBIND),SQL_HANDLE_STMT,statement,"unbind rowset");
    SQLINTEGER shared_value = 0; SQLLEN shared_length = 0;
    std::cout << "descriptor: shared ARD\n";
    expect(SQLBindCol(statement,1,SQL_C_SLONG,&shared_value,0,&shared_length),SQL_HANDLE_STMT,statement,"shared source binding");
    SQLHDESC shared = nullptr; check(SQLAllocHandle(SQL_HANDLE_DESC,connection,&shared) == SQL_SUCCESS,"explicit shared ARD");
    expect(SQLCopyDesc(ard,shared),SQL_HANDLE_DESC,shared,"copy actual binding");
    attribute(statement,SQL_ATTR_APP_ROW_DESC,shared); attribute(other,SQL_ATTR_APP_ROW_DESC,shared);
    sql(statement,L"SELECT ID FROM Q7_ROWS WHERE ID=1"); expect(SQLFetch(statement),SQL_HANDLE_STMT,statement,"shared first fetch"); check(shared_value == 1,"copied binding used by first STMT");
    sql(other,L"SELECT ID FROM Q7_ROWS WHERE ID=4"); expect(SQLFetch(other),SQL_HANDLE_STMT,other,"shared second fetch"); check(shared_value == 4,"same descriptor buffer used by second STMT");
    expect(SQLCloseCursor(statement),SQL_HANDLE_STMT,statement,"shared first close"); expect(SQLCloseCursor(other),SQL_HANDLE_STMT,other,"shared second close");
    // 해제 직후 Manager 조회의 별도 재현 경로를 남긴다. 드라이버 자동 복원은 단위 시험에서도 검사한다.
    if (!GetEnvironmentVariableW(L"HWDB_DESC_FREE_REGRESSION",nullptr,0)) {
        attribute(statement,SQL_ATTR_APP_ROW_DESC,nullptr); attribute(other,SQL_ATTR_APP_ROW_DESC,nullptr);
    }
    check(SQLFreeHandle(SQL_HANDLE_DESC,shared) == SQL_SUCCESS,"free shared ARD");
    std::cout << "descriptor: freed shared ARD\n";
    std::cout << "descriptor: restore first handle\n";
    check(descriptor(statement,SQL_ATTR_APP_ROW_DESC) != shared,"Manager restores first automatic descriptor");
    std::cout << "descriptor: restore second handle\n";
    check(descriptor(other,SQL_ATTR_APP_ROW_DESC) != shared,"Manager restores second automatic descriptor");
    std::cout << "descriptor: unbind restored automatic\n";
    expect(SQLFreeStmt(statement,SQL_UNBIND),SQL_HANDLE_STMT,statement,"unbind restored automatic buffer");
    std::cout << "descriptor: query AUTO_IPD\n";
    SQLUINTEGER auto_ipd = SQL_FALSE; expect(SQLGetConnectAttr(connection,SQL_ATTR_AUTO_IPD,&auto_ipd,0,nullptr),SQL_HANDLE_DBC,connection,"AUTO_IPD support"); check(auto_ipd == SQL_TRUE,"server supports automatic IPD");
    std::cout << "descriptor: automatic IPD\n";
    attribute(statement,SQL_ATTR_ENABLE_AUTO_IPD,number(SQL_TRUE)); prepare(statement,L"INSERT INTO Q7_ROWS VALUES (?, ?, ?)");
    auto ipd = descriptor(statement,SQL_ATTR_IMP_PARAM_DESC); SQLSMALLINT parameter_count = 0, precision = 0, scale = 0;
    expect(SQLGetDescField(ipd,0,SQL_DESC_COUNT,&parameter_count,0,nullptr),SQL_HANDLE_DESC,ipd,"automatic IPD count"); check(parameter_count == 3,"automatic parameter count");
    expect(SQLGetDescField(ipd,3,SQL_DESC_PRECISION,&precision,0,nullptr),SQL_HANDLE_DESC,ipd,"automatic IPD precision");
    expect(SQLGetDescField(ipd,3,SQL_DESC_SCALE,&scale,0,nullptr),SQL_HANDLE_DESC,ipd,"automatic IPD scale"); check(precision == 38 && scale == 6,"automatic schema numeric metadata");
    check(SQLFreeHandle(SQL_HANDLE_STMT,statement) == SQL_SUCCESS && SQLFreeHandle(SQL_HANDLE_STMT,other) == SQL_SUCCESS,"descriptor actual STMT cleanup");

    statement = allocate(connection); other = allocate(connection);
    std::cout << "descriptor: parameter arrays\n";
    sql(other,L"CREATE TABLE Q7_PARAMS (ID INTEGER PRIMARY KEY, TXT VARCHAR(20))");
    prepare(statement,L"INSERT INTO Q7_PARAMS VALUES (?, ?)");
    SQLINTEGER input_ids[4] = {1,1,3,4}; SQLWCHAR input_texts[4][16]{}; SQLLEN input_lengths[4] = {SQL_NTS,SQL_NTS,SQL_NTS,SQL_NTS};
    const wchar_t* input_values[] = {L"one",L"duplicate",L"세😀",L"ignored"};
    for (int i = 0; i < 4; ++i) std::copy_n(input_values[i],std::wcslen(input_values[i]) + 1,reinterpret_cast<wchar_t*>(input_texts[i]));
    SQLUSMALLINT param_status[4]{}, operation[4] = {SQL_PARAM_PROCEED,SQL_PARAM_PROCEED,SQL_PARAM_PROCEED,SQL_PARAM_IGNORE}; SQLULEN processed = 99;
    attribute(statement,SQL_ATTR_PARAMSET_SIZE,number(4)); attribute(statement,SQL_ATTR_PARAMS_PROCESSED_PTR,&processed); attribute(statement,SQL_ATTR_PARAM_STATUS_PTR,param_status); attribute(statement,SQL_ATTR_PARAM_OPERATION_PTR,operation);
    expect(SQLBindParameter(statement,1,SQL_PARAM_INPUT,SQL_C_SLONG,SQL_INTEGER,10,0,input_ids,0,nullptr),SQL_HANDLE_STMT,statement,"bind column parameter integers");
    expect(SQLBindParameter(statement,2,SQL_PARAM_INPUT,SQL_C_WCHAR,SQL_WVARCHAR,20,0,input_texts,sizeof(input_texts[0]),input_lengths),SQL_HANDLE_STMT,statement,"bind column parameter strings");
    check(SQLExecute(statement) == SQL_SUCCESS_WITH_INFO,"parameter array partial success"); state(statement,"23505",2);
    check(processed == 4 && param_status[0] == SQL_PARAM_SUCCESS && param_status[1] == SQL_PARAM_ERROR && param_status[2] == SQL_PARAM_SUCCESS && param_status[3] == SQL_PARAM_UNUSED,"parameter array actual statuses");
    SQLLEN affected = -1; expect(SQLRowCount(statement,&affected),SQL_HANDLE_STMT,statement,"array affected count"); check(affected == 2 && count(other,L"SELECT COUNT(*) FROM Q7_PARAMS") == 2,"array affected sum and actual rows");
    check(SQLExecute(statement) == SQL_ERROR,"all proceeded parameter sets fail"); state(statement,"23505",1);
    check(processed == 4 && param_status[0] == SQL_PARAM_ERROR && param_status[1] == SQL_PARAM_ERROR && param_status[2] == SQL_PARAM_ERROR && param_status[3] == SQL_PARAM_UNUSED,"all failed parameter statuses");
    std::fill_n(operation,4,static_cast<SQLUSMALLINT>(SQL_PARAM_IGNORE)); expect(SQLExecute(statement),SQL_HANDLE_STMT,statement,"all ignored sets");
    expect(SQLRowCount(statement,&affected),SQL_HANDLE_STMT,statement,"all ignored row count"); check(processed == 4 && affected == 0 && std::all_of(std::begin(param_status),std::end(param_status),[](auto status) { return status == SQL_PARAM_UNUSED; }),"all ignored does not execute SQL");
    operation[0] = operation[1] = operation[2] = SQL_PARAM_PROCEED;
    input_ids[0] = 5; input_ids[1] = 6; input_ids[2] = 7; input_lengths[2] = SQL_NULL_DATA;
    expect(SQLExecute(statement),SQL_HANDLE_STMT,statement,"array rereads changed buffers"); check(processed == 4 && count(other,L"SELECT COUNT(*) FROM Q7_PARAMS") == 5,"second array execution");
    PackedParameter parameters[4]{};
    std::cout << "descriptor: packed parameters\n";
    for (auto& parameter : parameters) { parameter.prefix = 0x5a; parameter.canary = 0xa5; parameter.octets = SQL_NTS; }
    parameters[1].id = 10; parameters[2].id = 10; parameters[3].id = 12; parameters[3].indicator = SQL_NULL_DATA;
    const wchar_t first_text[] = L"packed"; std::memcpy(parameters[1].text,first_text,sizeof(first_text));
    std::memcpy(parameters[2].text,first_text,sizeof(first_text));
    SQLLEN parameter_offset = sizeof(PackedParameter);
    attribute(statement,SQL_ATTR_PARAMSET_SIZE,number(3)); attribute(statement,SQL_ATTR_PARAM_BIND_TYPE,number(sizeof(PackedParameter))); attribute(statement,SQL_ATTR_PARAM_BIND_OFFSET_PTR,&parameter_offset); attribute(statement,SQL_ATTR_PARAM_OPERATION_PTR,nullptr);
    expect(SQLBindParameter(statement,1,SQL_PARAM_INPUT,SQL_C_SLONG,SQL_INTEGER,10,0,member<SQLINTEGER>(parameters,offsetof(PackedParameter,id)),0,member<SQLLEN>(parameters,offsetof(PackedParameter,id_length))),SQL_HANDLE_STMT,statement,"packed parameter integer");
    expect(SQLBindParameter(statement,2,SQL_PARAM_INPUT,SQL_C_WCHAR,SQL_WVARCHAR,20,0,member<SQLWCHAR>(parameters,offsetof(PackedParameter,text)),sizeof(parameters[0].text),member<SQLLEN>(parameters,offsetof(PackedParameter,indicator))),SQL_HANDLE_STMT,statement,"packed parameter text");
    set(descriptor(statement,SQL_ATTR_APP_PARAM_DESC),2,SQL_DESC_OCTET_LENGTH_PTR,member<SQLLEN>(parameters,offsetof(PackedParameter,octets)));
    check(SQLExecute(statement) == SQL_SUCCESS_WITH_INFO,"packed parameter partial success"); state(statement,"23505",2);
    check(processed == 3 && param_status[0] == SQL_PARAM_SUCCESS && param_status[1] == SQL_PARAM_ERROR && param_status[2] == SQL_PARAM_SUCCESS,"packed parameter states");
    check(count(other,L"SELECT COUNT(*) FROM Q7_PARAMS") == 7 && count(other,L"SELECT COUNT(*) FROM Q7_PARAMS WHERE ID=12 AND TXT IS NULL") == 1,"packed parameter values and NULL");
    for (const auto& parameter : parameters) check(parameter.prefix == 0x5a && parameter.canary == 0xa5,"input buffers remain application owned");
    prepare(statement,L"SELECT CAST(? AS INTEGER)"); check(SQLExecute(statement) == SQL_ERROR,"SELECT parameter arrays are explicitly unsupported"); state(statement,"HYC00");
    SQLUINTEGER array_selects = 0, array_counts = 0;
    expect(SQLGetInfo(connection,SQL_PARAM_ARRAY_SELECTS,&array_selects,0,nullptr),SQL_HANDLE_DBC,connection,"parameter array SELECT capability");
    expect(SQLGetInfo(connection,SQL_PARAM_ARRAY_ROW_COUNTS,&array_counts,0,nullptr),SQL_HANDLE_DBC,connection,"parameter array row count capability");
    check(array_selects == SQL_PAS_NO_SELECT && array_counts == SQL_PARC_NO_BATCH,"array info matches actual behavior");
    check(SQLFreeHandle(SQL_HANDLE_STMT,statement) == SQL_SUCCESS && SQLFreeHandle(SQL_HANDLE_STMT,other) == SQL_SUCCESS,"array final cleanup");
    std::cout << "ODBC descriptor sharing/row arrays/packed offsets/parameter arrays PASS\n";
}
