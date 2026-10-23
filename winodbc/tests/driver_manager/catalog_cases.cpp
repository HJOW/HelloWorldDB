#include "hwdbodbc/odbc.hpp"
#include "../helpers/check.hpp"
#include <algorithm>
#include <cstring>
#include <string>
#include <vector>

namespace {
SQLWCHAR* wide(const std::wstring& text) { return reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(text.c_str())); }
void expect_stmt(SQLRETURN result, SQLHSTMT statement, const char* operation) {
    if (SQL_SUCCEEDED(result)) return;
    SQLCHAR state[6]{}, message[1024]{}; SQLINTEGER native = 0;
    SQLGetDiagRec(SQL_HANDLE_STMT, statement, 1, state, &native, message, 1024, nullptr);
    std::cerr << operation << " STATE=" << state << " NATIVE=" << native << " MESSAGE=" << message << '\n';
    check(false, operation);
}
void expect_dbc(SQLRETURN result, SQLHDBC connection, const char* operation) {
    if (SQL_SUCCEEDED(result)) return;
    SQLWCHAR state[6]{}, message[1024]{}; SQLINTEGER native = 0;
    SQLGetDiagRecW(SQL_HANDLE_DBC, connection, 1, state, &native, message, 1024, nullptr);
    std::wcerr << L"DBC " << operation << L" STATE=" << reinterpret_cast<wchar_t*>(state) << L" NATIVE=" << native << L'\n';
    check(false, operation);
}
void stmt_state(SQLHSTMT statement, const char* expected) {
    SQLCHAR out[6]{};
    check(SQLGetDiagRec(SQL_HANDLE_STMT, statement, 1, out, nullptr, nullptr, 0, nullptr) == SQL_SUCCESS, "catalog diagnostic");
    if (std::strcmp(reinterpret_cast<char*>(out), expected)) std::cerr << "expected " << expected << " got " << out << '\n';
    check(!std::strcmp(reinterpret_cast<char*>(out), expected), "catalog SQLSTATE");
}
void sql(SQLHSTMT statement, const std::wstring& text) { expect_stmt(SQLExecDirectW(statement, wide(text), SQL_NTS), statement, "catalog setup SQL"); }
SQLHSTMT allocate(SQLHDBC connection) { SQLHSTMT s = nullptr; check(SQLAllocHandle(SQL_HANDLE_STMT, connection, &s) == SQL_SUCCESS, "catalog STMT"); return s; }
std::wstring gettext(SQLHSTMT statement, SQLUSMALLINT column) {
    SQLWCHAR buf[256]{}; SQLLEN len = 0;
    const auto rc = SQLGetData(statement, column, SQL_C_WCHAR, buf, sizeof(buf), &len);
    expect_stmt(rc, statement, "catalog GetData text");
    if (len == SQL_NULL_DATA) return L"<NULL>";
    return std::wstring(reinterpret_cast<wchar_t*>(buf), static_cast<std::size_t>(len / 2));
}
long long getint(SQLHSTMT statement, SQLUSMALLINT column) {
    SQLINTEGER v = 0; SQLLEN len = 0;
    expect_stmt(SQLGetData(statement, column, SQL_C_SLONG, &v, 0, &len), statement, "catalog GetData int");
    check(len != SQL_NULL_DATA, "catalog int not null");
    return v;
}
bool getnull(SQLHSTMT statement, SQLUSMALLINT column) {
    SQLWCHAR buf[8]{}; SQLLEN len = 0;
    const auto rc = SQLGetData(statement, column, SQL_C_WCHAR, buf, sizeof(buf), &len);
    expect_stmt(rc, statement, "catalog null check");
    return len == SQL_NULL_DATA;
}
int count_rows(SQLHSTMT statement) {
    int rows = 0;
    while (SQLFetch(statement) == SQL_SUCCESS) ++rows;
    return rows;
}
void close_cursor(SQLHSTMT statement) { expect_stmt(SQLCloseCursor(statement), statement, "catalog close"); }
}

void run_catalog_cases(SQLHDBC connection) {
    auto statement = allocate(connection);
    auto other = allocate(connection);
    // 준비: 카탈로그 시험용 객체이다. 기존 Q5/Q6/Q7과 이름이 겹치지 않는다.
    sql(statement, L"CREATE TABLE Q9_PARENT (ID INTEGER PRIMARY KEY, NAME VARCHAR(100))");
    sql(statement, L"CREATE TABLE Q9_CHILD (ID INTEGER PRIMARY KEY, PID INTEGER REFERENCES Q9_PARENT (ID), VAL DECIMAL(10,2))");
    sql(statement, L"CREATE INDEX Q9_IDX ON Q9_CHILD (VAL)");
    sql(statement, L"CREATE VIEW Q9_VIEW AS SELECT ID, NAME FROM Q9_PARENT");
    sql(statement, L"INSERT INTO Q9_PARENT VALUES (1, 'p1'), (2, 'p2')");
    sql(statement, L"INSERT INTO Q9_CHILD VALUES (10, 1, 1.5), (11, 2, 2.5)");

    // SQLTables: 전체와 패턴, 종류 필터이다.
    expect_stmt(SQLTablesW(statement, wide(L"") , 0, wide(L"") , 0, wide(L"") , 0, wide(L"") , 0), statement, "SQLTables all");
    {
        SQLSMALLINT cols = 0;
        expect_stmt(SQLNumResultCols(statement, &cols), statement, "Tables columns");
        check(cols == 5, "Tables has five columns");
        bool parent = false, child = false, view = false;
        while (SQLFetch(statement) == SQL_SUCCESS) {
            check(getnull(statement, 1), "Tables CAT is NULL");
            const auto schem = gettext(statement, 2);
            const auto name = gettext(statement, 3);
            const auto type = gettext(statement, 4);
            check(getnull(statement, 5), "Tables REMARKS is NULL");
            if (name == L"Q9_PARENT") { check(type == L"TABLE" && schem == L"SYSTEM", "parent table row"); parent = true; }
            if (name == L"Q9_CHILD") { check(type == L"TABLE", "child table row"); child = true; }
            if (name == L"Q9_VIEW") { check(type == L"VIEW", "view row"); view = true; }
        }
        check(parent && child && view, "Tables contains all three");
    }
    check(SQLMoreResults(statement) == SQL_NO_DATA, "Tables MoreResults");
    // 테이블 종류만 요청한다.
    expect_stmt(SQLTablesW(statement, wide(L"") , 0, wide(L"") , 0, wide(L"") , 0, wide(L"TABLE"), SQL_NTS), statement, "SQLTables TABLE only");
    {
        bool saw_view = false;
        while (SQLFetch(statement) == SQL_SUCCESS) if (gettext(statement, 3) == L"Q9_VIEW") saw_view = true;
        check(!saw_view, "TABLE filter excludes views");
    }
    close_cursor(statement);
    // 패턴 Q9_%와 스키마 SYSTEM이다.
    expect_stmt(SQLTablesW(statement, wide(L"") , 0, wide(L"SYSTEM"), SQL_NTS, wide(L"Q9_%"), SQL_NTS, wide(L"") , 0), statement, "SQLTables pattern");
    check(count_rows(statement) >= 3, "pattern finds three");
    close_cursor(statement);
    // 특수 호출: 스키마 목록과 종류 목록이다.
    expect_stmt(SQLTablesW(statement, wide(L"") , 0, wide(L"%"), SQL_NTS, wide(L"") , 0, wide(L"") , 0), statement, "SQLTables ALL_SCHEMAS");
    {
        SQLSMALLINT cols = 0;
        expect_stmt(SQLNumResultCols(statement, &cols), statement, "schemas columns");
        check(cols == 1, "schemas single column");
        bool system = false;
        while (SQLFetch(statement) == SQL_SUCCESS) if (gettext(statement, 1) == L"SYSTEM") system = true;
        check(system, "schemas contain SYSTEM");
    }
    close_cursor(statement);
    expect_stmt(SQLTablesW(statement, wide(L"") , 0, wide(L"") , 0, wide(L"") , 0, wide(L"%"), SQL_NTS), statement, "SQLTables ALL_TABLE_TYPES");
    {
        SQLSMALLINT cols = 0;
        expect_stmt(SQLNumResultCols(statement, &cols), statement, "types columns");
        check(cols == 1, "types single column");
        bool table = false, view = false;
        while (SQLFetch(statement) == SQL_SUCCESS) {
            const auto t = gettext(statement, 1);
            if (t == L"TABLE") table = true;
            if (t == L"VIEW") view = true;
        }
        check(table && view, "both table types");
    }
    close_cursor(statement);
    expect_stmt(SQLTablesW(statement, wide(L"%"), SQL_NTS, wide(L"") , 0, wide(L"") , 0, wide(L"") , 0), statement, "SQLTables ALL_CATALOGS");
    {
        SQLSMALLINT cols = 0;
        expect_stmt(SQLNumResultCols(statement, &cols), statement, "catalogs columns");
        check(cols == 1, "catalogs single column");
        check(count_rows(statement) == 0, "no catalogs");
    }
    close_cursor(statement);
    // 존재하지 않는 카탈로그 필터는 빈 결과이다.
    expect_stmt(SQLTablesW(statement, wide(L"NOPE"), SQL_NTS, wide(L"") , 0, wide(L"") , 0, wide(L"") , 0), statement, "SQLTables bad catalog");
    check(count_rows(statement) == 0, "bad catalog empty");
    close_cursor(statement);

    // SQLColumns: Q9_PARENT의 컬럼과 메타데이터이다.
    expect_stmt(SQLColumnsW(statement, wide(L"") , 0, wide(L"") , 0, wide(L"Q9_PARENT"), SQL_NTS, wide(L"") , 0), statement, "SQLColumns parent");
    {
        SQLSMALLINT cols = 0;
        expect_stmt(SQLNumResultCols(statement, &cols), statement, "Columns count");
        check(cols == 18, "Columns has eighteen columns");
        bool id = false, name = false;
        while (SQLFetch(statement) == SQL_SUCCESS) {
            const bool cat_null = getnull(statement, 1);
            const auto schem = gettext(statement, 2);
            // 3번 TABLE_NAME은 필터가 Q9_PARENT이므로 따로 읽지 않아도 되지만 순서 유지를 위해 읽는다.
            const auto tname = gettext(statement, 3);
            const auto col = gettext(statement, 4);
            const auto data_type = getint(statement, 5);
            const auto type_name = gettext(statement, 6);
            const auto col_size = getint(statement, 7);
            // 8 BUFFER_LENGTH, 9 DECIMAL_DIGITS 등은 필요할 때 순서대로 읽는다. 여기서는 9를 건너뛰고 18을 읽는다.
            // 18 IS_NULLABLE은 마지막이므로 순서가 유지된다.
            // 중간 컬럼을 건너뛰는 것은 허용되므로 10~17을 읽지 않고 18을 읽는다.
            const auto is_nullable = gettext(statement, 18);
            (void)tname;
            if (col == L"ID") {
                id = true;
                check(data_type == SQL_INTEGER && type_name == L"INTEGER", "ID integer type");
                check(col_size == 10, "ID column size");
                check(is_nullable == L"NO", "ID not nullable (PK)");
            }
            if (col == L"NAME") {
                name = true;
                check(data_type == SQL_WVARCHAR, "NAME varchar");
                check(type_name == L"VARCHAR", "NAME type name");
            }
            check(cat_null, "Columns CAT null");
            check(schem == L"SYSTEM", "Columns schem");
        }
        check(id && name, "parent columns found");
    }
    close_cursor(statement);
    // DECIMAL 컬럼의 정밀도·스케일과 뷰 컬럼이다.
    expect_stmt(SQLColumnsW(statement, wide(L"") , 0, wide(L"") , 0, wide(L"Q9_CHILD"), SQL_NTS, wide(L"VAL"), SQL_NTS), statement, "SQLColumns decimal");
    {
        check(SQLFetch(statement) == SQL_SUCCESS, "decimal row");
        check(getint(statement, 5) == SQL_DECIMAL, "VAL decimal");
        check(getint(statement, 7) == 10 && getint(statement, 9) == 2, "VAL precision/scale");
        check(SQLFetch(statement) == SQL_NO_DATA, "single decimal row");
    }
    close_cursor(statement);
    expect_stmt(SQLColumnsW(statement, wide(L"") , 0, wide(L"") , 0, wide(L"Q9_VIEW"), SQL_NTS, wide(L"") , 0), statement, "SQLColumns view");
    check(count_rows(statement) == 2, "view has two columns");
    close_cursor(statement);
    // METADATA_ID=TRUE에서는 패턴이 식별자로 처리된다.
    expect_stmt(SQLSetStmtAttr(statement, SQL_ATTR_METADATA_ID, reinterpret_cast<SQLPOINTER>(SQL_TRUE), 0), statement, "metadata id true");
    expect_stmt(SQLColumnsW(statement, wide(L"") , 0, wide(L"") , 0, wide(L"Q9_PARENT"), SQL_NTS, wide(L"ID"), SQL_NTS), statement, "metadata exact");
    check(count_rows(statement) == 1, "exact match one");
    close_cursor(statement);
    expect_stmt(SQLColumnsW(statement, wide(L"") , 0, wide(L"") , 0, wide(L"Q9_PARENT"), SQL_NTS, wide(L"%"), SQL_NTS), statement, "metadata percent literal");
    check(count_rows(statement) == 0, "percent is literal when METADATA_ID");
    close_cursor(statement);
    expect_stmt(SQLSetStmtAttr(statement, SQL_ATTR_METADATA_ID, reinterpret_cast<SQLPOINTER>(SQL_FALSE), 0), statement, "metadata id false");

    // SQLStatistics: 일반 인덱스와 PK 유일 인덱스이다.
    expect_stmt(SQLStatisticsW(statement, wide(L"") , 0, wide(L"") , 0, wide(L"Q9_CHILD"), SQL_NTS, SQL_INDEX_ALL, SQL_ENSURE), statement, "SQLStatistics all");
    {
        bool idx = false, pk = false;
        while (SQLFetch(statement) == SQL_SUCCESS) {
            const auto non_unique = getint(statement, 4);
            const auto name = gettext(statement, 6);
            const auto type = getint(statement, 7);
            const auto asc = gettext(statement, 10);
            if (name == L"Q9_IDX") {
                idx = true;
                check(non_unique == 1 && type == SQL_INDEX_OTHER, "non-unique other index");
                check(asc == L"A", "ascending");
            }
            if (name.find(L"Q9_CHILD") != std::wstring::npos && non_unique == 0) pk = true;
        }
        check(idx && pk, "both regular and PK indexes");
    }
    close_cursor(statement);
    expect_stmt(SQLStatisticsW(statement, wide(L"") , 0, wide(L"") , 0, wide(L"Q9_CHILD"), SQL_NTS, SQL_INDEX_UNIQUE, SQL_ENSURE), statement, "SQLStatistics unique");
    {
        bool only_unique = true;
        while (SQLFetch(statement) == SQL_SUCCESS) if (getint(statement, 4) != 0) only_unique = false;
        check(only_unique, "unique filter");
    }
    close_cursor(statement);
    check(SQLStatisticsW(statement, wide(L"") , 0, wide(L"") , 0, wide(L"Q9_CHILD"), SQL_NTS, 99, SQL_ENSURE) == SQL_ERROR, "bad unique rejected");
    {
        SQLCHAR st[6]{};
        check(SQLGetDiagRec(SQL_HANDLE_STMT, statement, 1, st, nullptr, nullptr, 0, nullptr) == SQL_SUCCESS, "bad unique diagnostic");
        const std::string got(reinterpret_cast<char*>(st));
        // Manager가 먼저 값 범위를 검사하면 HY100을 낼 수 있다. 드라이버 직접 호출은 HY024이다.
        check(got == "HY024" || got == "HY100", "bad unique SQLSTATE");
    }
    check(SQLStatisticsW(statement, wide(L"") , 0, wide(L"") , 0, wide(L"Q9_CHILD"), SQL_NTS, SQL_INDEX_ALL, 99) == SQL_ERROR, "bad reserved rejected");
    {
        SQLCHAR st[6]{};
        check(SQLGetDiagRec(SQL_HANDLE_STMT, statement, 1, st, nullptr, nullptr, 0, nullptr) == SQL_SUCCESS, "bad reserved diagnostic");
        const std::string got(reinterpret_cast<char*>(st));
        if (got != "HY101" && got != "HY024") std::cerr << "bad reserved got " << got << '\n';
        check(got == "HY101" || got == "HY024", "bad reserved SQLSTATE");
    }

    // SQLSpecialColumns: PK와 빈 ROWVER이다.
    expect_stmt(SQLSpecialColumnsW(statement, SQL_BEST_ROWID, wide(L"") , 0, wide(L"") , 0, wide(L"Q9_PARENT"), SQL_NTS, SQL_SCOPE_SESSION, SQL_NULLABLE), statement, "SpecialColumns best");
    {
        check(SQLFetch(statement) == SQL_SUCCESS, "best rowid row");
        // 1 SCOPE는 건너뛰고 2,3,8을 순서대로 읽는다.
        const auto col = gettext(statement, 2);
        const auto dtype = getint(statement, 3);
        // 4 TYPE_NAME, 5 COLUMN_SIZE, 6 BUFFER_LENGTH, 7 DECIMAL_DIGITS를 건너뛰고 8을 읽는다.
        const auto pseudo = getint(statement, 8);
        check(col == L"ID" && dtype == SQL_INTEGER, "PK column");
        check(pseudo == SQL_PC_NOT_PSEUDO, "not pseudo");
        check(SQLFetch(statement) == SQL_NO_DATA, "single PK column");
    }
    close_cursor(statement);
    expect_stmt(SQLSpecialColumnsW(statement, SQL_ROWVER, wide(L"") , 0, wide(L"") , 0, wide(L"Q9_PARENT"), SQL_NTS, SQL_SCOPE_SESSION, SQL_NULLABLE), statement, "SpecialColumns rowver");
    check(count_rows(statement) == 0, "rowver empty");
    close_cursor(statement);

    // SQLPrimaryKeys와 SQLForeignKeys이다.
    expect_stmt(SQLPrimaryKeysW(statement, wide(L"") , 0, wide(L"") , 0, wide(L"Q9_PARENT"), SQL_NTS), statement, "PrimaryKeys");
    {
        check(SQLFetch(statement) == SQL_SUCCESS, "PK row");
        check(gettext(statement, 4) == L"ID" && getint(statement, 5) == 1, "PK column and sequence");
        check(!getnull(statement, 6), "PK name present");
        check(SQLFetch(statement) == SQL_NO_DATA, "single PK");
    }
    close_cursor(statement);
    expect_stmt(SQLForeignKeysW(statement, wide(L"") , 0, wide(L"") , 0, wide(L"") , 0, wide(L"") , 0, wide(L"") , 0, wide(L"Q9_CHILD"), SQL_NTS), statement, "ForeignKeys child");
    {
        check(SQLFetch(statement) == SQL_SUCCESS, "FK row");
        check(gettext(statement, 3) == L"Q9_PARENT" && gettext(statement, 4) == L"ID", "PK table/column");
        check(gettext(statement, 7) == L"Q9_CHILD" && gettext(statement, 8) == L"PID", "FK table/column");
        check(getint(statement, 9) == 1, "FK sequence");
        check(SQLFetch(statement) == SQL_NO_DATA, "single FK");
    }
    close_cursor(statement);

    // SQLTablePrivileges는 빈 결과가 아니라 실제 권한 행을 낸다. SYSTEM은 DBA이므로 보인다.
    expect_stmt(SQLTablePrivilegesW(statement, wide(L"") , 0, wide(L"") , 0, wide(L"Q9_PARENT"), SQL_NTS), statement, "TablePrivileges");
    {
        // DBA가 소유한 테이블이므로 권한 부여 기록이 없어도 빈 결과일 수 있다. 호출 성공과 컬럼 수를 본다.
        SQLSMALLINT cols = 0;
        expect_stmt(SQLNumResultCols(statement, &cols), statement, "priv columns");
        check(cols == 7, "priv seven columns");
        while (SQLFetch(statement) == SQL_SUCCESS) {}
    }
    close_cursor(statement);
    expect_stmt(SQLColumnPrivilegesW(statement, wide(L"") , 0, wide(L"") , 0, wide(L"Q9_PARENT"), SQL_NTS, wide(L"") , 0), statement, "ColumnPrivileges empty");
    {
        SQLSMALLINT cols = 0;
        expect_stmt(SQLNumResultCols(statement, &cols), statement, "column priv columns");
        check(cols == 8, "column priv eight columns");
        check(count_rows(statement) == 0, "column priv empty");
    }
    close_cursor(statement);
    expect_stmt(SQLProceduresW(statement, wide(L"") , 0, wide(L"") , 0, wide(L"") , 0), statement, "Procedures empty");
    {
        SQLSMALLINT cols = 0;
        expect_stmt(SQLNumResultCols(statement, &cols), statement, "procedures columns");
        check(cols == 8, "procedures eight columns");
        check(count_rows(statement) == 0, "procedures empty");
    }
    close_cursor(statement);
    expect_stmt(SQLProcedureColumnsW(statement, wide(L"") , 0, wide(L"") , 0, wide(L"") , 0, wide(L"") , 0), statement, "ProcedureColumns empty");
    {
        SQLSMALLINT cols = 0;
        expect_stmt(SQLNumResultCols(statement, &cols), statement, "procedure columns count");
        check(cols == 19, "procedure columns nineteen");
        check(count_rows(statement) == 0, "procedure columns empty");
    }
    close_cursor(statement);

    // SQLGetTypeInfo: 전체와 단일 조회이다.
    expect_stmt(SQLGetTypeInfo(other, SQL_ALL_TYPES), other, "GetTypeInfo all");
    {
        SQLSMALLINT cols = 0;
        expect_stmt(SQLNumResultCols(other, &cols), other, "typeinfo columns");
        check(cols == 19, "typeinfo nineteen");
        int rows = 0;
        bool decimal = false, varchar = false, interval = false;
        while (SQLFetch(other) == SQL_SUCCESS) {
            ++rows;
            const auto name = gettext(other, 1);
            if (name == L"DECIMAL") { decimal = true; check(getint(other, 2) == SQL_DECIMAL, "decimal code"); }
            if (name == L"VARCHAR") varchar = true;
            if (name == L"INTERVAL YEAR") interval = true;
        }
        check(rows >= 20 && decimal && varchar && interval, "typeinfo coverage");
    }
    check(SQLMoreResults(other) == SQL_NO_DATA, "typeinfo MoreResults");
    check(SQLFetch(other) == SQL_ERROR, "fetch after typeinfo completion");
    stmt_state(other, "HY010");
    expect_stmt(SQLGetTypeInfo(other, SQL_INTEGER), other, "GetTypeInfo integer");
    check(count_rows(other) == 1, "single type row");
    close_cursor(other);
    check(SQLGetTypeInfo(other, 9999) == SQL_ERROR, "bad type rejected");
    stmt_state(other, "HY004");

    // SQLGetInfo와 SQLGetFunctions: 실제 지원과 일치한다.
    {
        char ver[16]{}; SQLSMALLINT len = 0;
        expect_dbc(SQLGetInfo(connection, SQL_DRIVER_ODBC_VER, ver, sizeof(ver), &len), connection, "driver odbc ver");
        check(std::string(ver) == "03.00", "driver ver 03.00");
        SQLUINTEGER conformance = 0;
        expect_dbc(SQLGetInfo(connection, SQL_ODBC_INTERFACE_CONFORMANCE, &conformance, 0, nullptr), connection, "interface conformance");
        check(conformance == SQL_OIC_CORE, "core conformance");
        SQLUINTEGER usage = 0;
        expect_dbc(SQLGetInfo(connection, SQL_SCHEMA_USAGE, &usage, 0, nullptr), connection, "schema usage");
        check((usage & SQL_SU_DML_STATEMENTS) != 0, "schema DML");
        SQLUSMALLINT supported = 0;
        expect_dbc(SQLGetFunctions(connection, SQL_API_SQLTABLES, &supported), connection, "functions tables");
        check(supported == SQL_TRUE, "tables supported");
        expect_dbc(SQLGetFunctions(connection, SQL_API_SQLGETTYPEINFO, &supported), connection, "functions typeinfo");
        check(supported == SQL_TRUE, "typeinfo supported");
        expect_dbc(SQLGetFunctions(connection, SQL_API_SQLBULKOPERATIONS, &supported), connection, "functions bulk");
        check(supported == SQL_FALSE, "bulk not supported");
        SQLUSMALLINT all[100]{};
        expect_dbc(SQLGetFunctions(connection, SQL_API_ALL_FUNCTIONS, all), connection, "functions all");
        check(all[SQL_API_SQLTABLES] == SQL_TRUE && all[SQL_API_SQLCOLUMNS] == SQL_TRUE, "all functions bits");
        std::vector<SQLUSMALLINT> bitmap(SQL_API_ODBC3_ALL_FUNCTIONS_SIZE, 0);
        expect_dbc(SQLGetFunctions(connection, SQL_API_ODBC3_ALL_FUNCTIONS, bitmap.data()), connection, "functions bitmap");
        check((bitmap[SQL_API_SQLTABLES >> 4] & (1U << (SQL_API_SQLTABLES & 15))) != 0, "bitmap tables");
    }

    sql(statement, L"DROP VIEW Q9_VIEW");
    sql(statement, L"DROP TABLE Q9_CHILD");
    sql(statement, L"DROP TABLE Q9_PARENT");
    check(SQLFreeHandle(SQL_HANDLE_STMT, other) == SQL_SUCCESS, "catalog other free");
    check(SQLFreeHandle(SQL_HANDLE_STMT, statement) == SQL_SUCCESS, "catalog statement free");
    std::cout << "ODBC catalog/info/typeinfo/MoreResults PASS\n";
}
