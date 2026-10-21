#include "hwdbodbc/descriptor.hpp"
#include "../helpers/check.hpp"
#include <cstring>
#include <thread>

using namespace hwdbodbc;
namespace {
SQLPOINTER value(SQLLEN number) { return reinterpret_cast<SQLPOINTER>(number); }
void state(SQLSMALLINT type, SQLHANDLE handle, const char* expected) {
    SQLCHAR output[6]{}; check(SQLGetDiagRec(type,handle,1,output,nullptr,nullptr,0,nullptr) == SQL_SUCCESS,"descriptor diagnostic");
    if (std::strcmp(reinterpret_cast<char*>(output),expected)) std::cerr << output << " != " << expected << '\n';
    check(!std::strcmp(reinterpret_cast<char*>(output),expected),"descriptor SQLSTATE");
}
SQLHDBC connection(SQLHENV environment) {
    SQLHDBC id = nullptr; check(SQLAllocHandle(SQL_HANDLE_DBC,environment,&id) == SQL_SUCCESS,"DBC allocate");
    // 네트워크 없는 내부 descriptor 시험만 연결 상태를 주입한다.
    std::static_pointer_cast<Connection>(find_handle(SQL_HANDLE_DBC,id))->connected = true; return id;
}
}
int main() {
    return run_checks([] {
        SQLHENV environment = nullptr; check(SQLAllocHandle(SQL_HANDLE_ENV,nullptr,&environment) == SQL_SUCCESS,"ENV allocate");
        check(SQLSetEnvAttr(environment,SQL_ATTR_ODBC_VERSION,value(SQL_OV_ODBC3_80),0) == SQL_SUCCESS,"ODBC version");
        auto first_connection = connection(environment), second_connection = connection(environment);
        SQLHSTMT first = nullptr, second = nullptr; SQLHDESC shared = nullptr, copy = nullptr;
        check(SQLAllocHandle(SQL_HANDLE_STMT,first_connection,&first) == SQL_SUCCESS && SQLAllocHandle(SQL_HANDLE_STMT,first_connection,&second) == SQL_SUCCESS,"STMT allocate");
        check(SQLAllocHandle(SQL_HANDLE_DESC,first_connection,&shared) == SQL_SUCCESS && SQLAllocHandle(SQL_HANDLE_DESC,first_connection,&copy) == SQL_SUCCESS,"DESC allocate");
        SQLHDESC ard = nullptr, ipd = nullptr, ird = nullptr;
        check(SQLGetStmtAttr(first,SQL_ATTR_APP_ROW_DESC,&ard,0,nullptr) == SQL_SUCCESS,"automatic ARD");
        check(SQLGetStmtAttr(first,SQL_ATTR_IMP_PARAM_DESC,&ipd,0,nullptr) == SQL_SUCCESS && SQLGetStmtAttr(first,SQL_ATTR_IMP_ROW_DESC,&ird,0,nullptr) == SQL_SUCCESS,"implementation descriptors");
        SQLSMALLINT small = -1;
        check(SQLGetDescField(shared,0,SQL_DESC_COUNT,&small,0,nullptr) == SQL_SUCCESS && small == 0,"empty explicit descriptor");
        check(SQLGetDescField(shared,-1,SQL_DESC_ALLOC_TYPE,&small,0,nullptr) == SQL_SUCCESS && small == SQL_DESC_ALLOC_USER,"header ignores record number");
        check(SQLGetDescRec(shared,1,nullptr,0,nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,nullptr) == SQL_NO_DATA,"record beyond count");
        check(SQLGetDescField(ird,0,SQL_DESC_COUNT,&small,0,nullptr) == SQL_ERROR,"unpopulated IRD"); state(SQL_HANDLE_DESC,ird,"HY007");
        check(SQLSetDescField(ird,1,SQL_DESC_TYPE,value(SQL_INTEGER),0) == SQL_ERROR,"IRD type is read-only"); state(SQL_HANDLE_DESC,ird,"HY016");
        SQLULEN processed = 9;
        check(SQLSetDescField(ird,0,SQL_DESC_ROWS_PROCESSED_PTR,&processed,0) == SQL_SUCCESS,"IRD header remains writable");
        SQLULEN* processed_pointer = nullptr; check(SQLGetDescField(ird,0,SQL_DESC_ROWS_PROCESSED_PTR,&processed_pointer,0,nullptr) == SQL_SUCCESS && processed_pointer == &processed,"IRD header pointer identity");
        SQLINTEGER data = 123, original = 7; SQLLEN indicator = 0, octets = sizeof(data);
        check(SQLSetDescRec(ard,1,SQL_C_SLONG,0,sizeof(original),0,0,&original,&octets,&indicator) == SQL_SUCCESS,"original automatic binding");
        check(SQLSetDescRec(shared,1,SQL_C_SLONG,0,sizeof(data),0,0,&data,&octets,&indicator) == SQL_SUCCESS,"SetDescRec binding");
        SQLPOINTER address = nullptr; check(SQLGetDescField(shared,1,SQL_DESC_DATA_PTR,&address,0,nullptr) == SQL_SUCCESS && address == &data,"get application buffer address");
        check(SQLSetStmtAttr(first,SQL_ATTR_APP_ROW_DESC,shared,0) == SQL_SUCCESS && SQLSetStmtAttr(second,SQL_ATTR_APP_ROW_DESC,shared,0) == SQL_SUCCESS,"share descriptor");
        check(SQLSetStmtAttr(first,SQL_ATTR_APP_ROW_DESC,ard,0) == SQL_SUCCESS,"restore through original automatic handle");
        check(SQLGetDescField(ard,1,SQL_DESC_DATA_PTR,&address,0,nullptr) == SQL_SUCCESS && address == &original,"restored automatic binding is preserved");
        const auto application_parameter = std::static_pointer_cast<Statement>(find_handle(SQL_HANDLE_STMT,first))->automatic_descriptors[1]->id;
        check(SQLSetStmtAttr(first,SQL_ATTR_APP_ROW_DESC,application_parameter,0) == SQL_ERROR,"automatic descriptor cannot change roles"); state(SQL_HANDLE_STMT,first,"HY017");
        check(SQLSetStmtAttr(first,SQL_ATTR_APP_ROW_DESC,shared,0) == SQL_SUCCESS,"reassociate explicit handle");
        check(SQLSetStmtAttr(first,SQL_ATTR_ROW_ARRAY_SIZE,value(3),0) == SQL_SUCCESS,"StmtAttr writes descriptor");
        struct { SQLULEN result = 0; SQLULEN canary = 0x12345; } array_size;
        SQLINTEGER bytes = 0;
        check(SQLGetDescField(shared,0,SQL_DESC_ARRAY_SIZE,&array_size.result,0,&bytes) == SQL_SUCCESS && array_size.result == 3 && bytes == sizeof(SQLULEN) && array_size.canary == 0x12345,"SQLULEN header width");
        SQLULEN second_size = 0; check(SQLGetStmtAttr(second,SQL_ATTR_ROW_ARRAY_SIZE,&second_size,0,nullptr) == SQL_SUCCESS && second_size == 3,"shared header observed by second STMT");
        check(SQLSetDescField(shared,0,SQL_DESC_ARRAY_SIZE,value(0),0) == SQL_ERROR,"array size zero"); state(SQL_HANDLE_DESC,shared,"HY024");
        check(SQLSetDescField(shared,0,SQL_DESC_BIND_TYPE,value(64),0) == SQL_SUCCESS,"row-wise stride");
        struct { SQLUINTEGER result = 0; SQLUINTEGER canary = 0xabcdef; } bind_type;
        check(SQLGetDescField(shared,0,SQL_DESC_BIND_TYPE,&bind_type.result,0,&bytes) == SQL_SUCCESS && bind_type.result == 64 && bytes == 4 && bind_type.canary == 0xabcdef,"descriptor BIND_TYPE remains 32 bit");
        check(SQLCopyDesc(shared,copy) == SQL_SUCCESS,"copy descriptor");
        check(SQLGetDescField(copy,1,SQL_DESC_DATA_PTR,&address,0,nullptr) == SQL_SUCCESS && address == &data,"copy preserves application address");
        check(SQLGetDescField(copy,0,SQL_DESC_ALLOC_TYPE,&small,0,nullptr) == SQL_SUCCESS && small == SQL_DESC_ALLOC_USER,"copy preserves allocation ownership");
        check(SQLSetDescField(copy,1,SQL_DESC_CONCISE_TYPE,value(SQL_C_NUMERIC),0) == SQL_SUCCESS,"change type");
        check(SQLGetDescField(copy,1,SQL_DESC_DATA_PTR,&address,0,nullptr) == SQL_SUCCESS && !address,"type change unbinds data");
        check(SQLSetDescField(copy,1,SQL_DESC_PRECISION,value(0),0) == SQL_SUCCESS,"incomplete descriptor can be assembled");
        check(SQLSetDescField(copy,1,SQL_DESC_DATA_PTR,&data,0) == SQL_ERROR,"DATA_PTR consistency check"); state(SQL_HANDLE_DESC,copy,"HY021");
        check(SQLSetDescField(copy,1,SQL_DESC_PRECISION,value(38),0) == SQL_SUCCESS && SQLSetDescField(copy,1,SQL_DESC_SCALE,value(-2),0) == SQL_SUCCESS,"numeric precision and negative scale");
        SQL_NUMERIC_STRUCT numeric{};
        check(SQLSetDescField(copy,1,SQL_DESC_DATA_PTR,&numeric,0) == SQL_SUCCESS,"bind completed numeric record");
        check(SQLSetDescField(copy,1,SQL_DESC_TYPE,value(SQL_INTERVAL),0) == SQL_SUCCESS && SQLSetDescField(copy,1,SQL_DESC_DATETIME_INTERVAL_CODE,value(SQL_CODE_DAY_TO_SECOND),0) == SQL_SUCCESS,"interval general and subtype");
        check(SQLGetDescField(copy,1,SQL_DESC_CONCISE_TYPE,&small,0,nullptr) == SQL_SUCCESS && small == SQL_C_INTERVAL_DAY_TO_SECOND,"interval concise type");
        check(SQLSetDescField(copy,1,SQL_DESC_TYPE,value(SQL_DATETIME),0) == SQL_SUCCESS && SQLSetDescField(copy,1,SQL_DESC_DATETIME_INTERVAL_CODE,value(SQL_CODE_TIMESTAMP),0) == SQL_SUCCESS,"datetime general and subtype");
        check(SQLGetDescField(copy,1,SQL_DESC_CONCISE_TYPE,&small,0,nullptr) == SQL_SUCCESS && small == SQL_C_TYPE_TIMESTAMP,"datetime concise type");
        wchar_t parameter_name[] = L"매개😀";
        check(SQLSetDescFieldW(ipd,1,SQL_DESC_NAME,parameter_name,sizeof(parameter_name) - 2) == SQL_SUCCESS,"IPD W name byte length");
        struct { SQLWCHAR text[3]{}; SQLWCHAR canary = 0x5a5a; } short_name;
        check(SQLGetDescFieldW(ipd,1,SQL_DESC_NAME,short_name.text,sizeof(short_name.text),&bytes) == SQL_SUCCESS_WITH_INFO && bytes == 8 && short_name.text[2] == 0 && short_name.canary == 0x5a5a,"GetDescFieldW byte length and canary");
        check(SQLGetDescFieldW(ipd,1,SQL_DESC_NAME,short_name.text,5,&bytes) == SQL_ERROR,"GetDescFieldW rejects odd byte capacity"); state(SQL_HANDLE_DESC,ipd,"HY090");
        SQLSMALLINT name_length = 0; SQLLEN record_length = -1;
        check(SQLGetDescRecW(ipd,1,short_name.text,3,&name_length,nullptr,nullptr,&record_length,nullptr,nullptr,nullptr) == SQL_SUCCESS_WITH_INFO && name_length == 4,"GetDescRecW code units");
        check(SQLSetDescFieldW(ipd,1,SQL_DESC_NAME,parameter_name,3) == SQL_ERROR,"odd W descriptor length"); state(SQL_HANDLE_DESC,ipd,"HY090");
        check(SQLSetDescField(ipd,1,SQL_DESC_INDICATOR_PTR,&indicator,0) == SQL_ERROR,"IPD cannot own application indicator"); state(SQL_HANDLE_DESC,ipd,"HY091");
        const auto first_statement = std::static_pointer_cast<Statement>(find_handle(SQL_HANDLE_STMT,first));
        accept_result(*first_statement,Json{{"type","rows"},{"columns",Json::array({Json{{"name","값😀"},{"typeName","DECIMAL"},{"declared","DECIMAL(38,6)"},{"precision",38},{"scale",6}}})},{"rows",Json::array()},{"hasMore",false}});
        check(SQLGetDescField(ird,1,SQL_DESC_PRECISION,&small,0,nullptr) == SQL_SUCCESS && small == 38,"populated IRD precision");
        check(SQLCopyDesc(ird,ipd) == SQL_SUCCESS,"copy implementation result to parameters");
        check(SQLGetDescField(ipd,1,SQL_DESC_SCALE,&small,0,nullptr) == SQL_SUCCESS && small == 6,"copied parameter scale");
        check(SQLGetDescField(ipd,1,SQL_DESC_NULLABLE,&small,0,nullptr) == SQL_SUCCESS && small == SQL_NULLABLE,"dynamic parameter is nullable independently of result UNKNOWN");
        check(SQLCopyDesc(ipd,ird) == SQL_ERROR,"copy target IRD rejected"); state(SQL_HANDLE_DESC,ird,"HY016");
        SQLHDESC foreign = nullptr; check(SQLAllocHandle(SQL_HANDLE_DESC,second_connection,&foreign) == SQL_SUCCESS,"other DBC descriptor");
        check(SQLSetStmtAttr(second,SQL_ATTR_APP_PARAM_DESC,foreign,0) == SQL_ERROR,"cross-connection association rejected"); state(SQL_HANDLE_STMT,second,"HY024");
        // 서로 반대 방향의 복사도 DBC 잠금을 순서 없이 기다리지 않는다.
        std::thread forward([&] { for (int i = 0; i < 100; ++i) check(SQLCopyDesc(shared,foreign) == SQL_SUCCESS,"cross DBC forward copy"); });
        std::thread backward([&] { for (int i = 0; i < 100; ++i) check(SQLCopyDesc(foreign,shared) == SQL_SUCCESS,"cross DBC backward copy"); });
        forward.join(); backward.join();
        check(SQLFreeHandle(SQL_HANDLE_STMT,first) == SQL_SUCCESS,"STMT free leaves explicit descriptor alive");
        check(SQLGetDescField(shared,0,SQL_DESC_ALLOC_TYPE,&small,0,nullptr) == SQL_SUCCESS,"shared descriptor survives STMT");
        check(SQLFreeHandle(SQL_HANDLE_DESC,shared) == SQL_SUCCESS,"free associated explicit descriptor");
        SQLHDESC restored = nullptr;
        check(SQLGetStmtAttr(second,SQL_ATTR_APP_ROW_DESC,&restored,0,nullptr) == SQL_SUCCESS && restored != shared,"free restores automatic descriptor");
        check(SQLFreeHandle(SQL_HANDLE_STMT,second) == SQL_SUCCESS && SQLFreeHandle(SQL_HANDLE_DESC,copy) == SQL_SUCCESS && SQLFreeHandle(SQL_HANDLE_DESC,foreign) == SQL_SUCCESS,"descriptor cleanup");
        for (const auto id : {first_connection,second_connection}) {
            std::static_pointer_cast<Connection>(find_handle(SQL_HANDLE_DBC,id))->connected = false;
            check(SQLFreeHandle(SQL_HANDLE_DBC,id) == SQL_SUCCESS,"DBC cleanup");
        }
        check(SQLFreeHandle(SQL_HANDLE_ENV,environment) == SQL_SUCCESS,"ENV cleanup");
        unsigned char storage[32]{}; SQLINTEGER expected = 42; std::memcpy(storage + 8,&expected,sizeof(expected));
        Descriptor descriptor; descriptor.bind_type = 4; SQLLEN offset = -4; descriptor.bind_offset = &offset;
        DescriptorRecord record; record.type = SQL_C_SLONG; record.data = storage + 4;
        const auto resolved = binding_record(descriptor,record,2,SQL_C_SLONG);
        check(resolved.data == storage + 8,"signed bind offset and row stride");
        try { binding_record(descriptor,record,(std::numeric_limits<SQLULEN>::max)(),SQL_C_SLONG); check(false,"overflow expected"); }
        catch (const DriverError& error) { check(error.state == "HY090","stride overflow SQLSTATE"); }
    });
}
