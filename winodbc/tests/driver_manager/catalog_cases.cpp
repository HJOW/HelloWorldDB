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

using Row = std::vector<std::wstring>;
// 열린 카탈로그 결과의 모든 행에서 지정한 열(오름차순)을 문자열로 읽고 커서를 닫는다.
std::vector<Row> collect(SQLHSTMT statement, std::initializer_list<SQLUSMALLINT> columns) {
    std::vector<Row> rows;
    SQLRETURN result = SQL_SUCCESS;
    while ((result = SQLFetch(statement)) == SQL_SUCCESS || result == SQL_SUCCESS_WITH_INFO) {
        Row row;
        for (const auto column : columns) row.push_back(gettext(statement, column));
        rows.push_back(std::move(row));
    }
    check(result == SQL_NO_DATA, "catalog fetch ends with SQL_NO_DATA");
    close_cursor(statement);
    return rows;
}
// 지정한 열이 값과 같은 행만 남긴다.
std::vector<Row> where(const std::vector<Row>& rows, std::size_t column, const std::wstring& value) {
    std::vector<Row> result;
    for (const auto& row : rows) if (row.at(column) == value) result.push_back(row);
    return result;
}
// 시험 사용자로 접속한다. settings는 SYSTEM 접속 문자열이며 UID 앞의 DRIVER/Server/Port 부분만 재사용한다.
SQLHDBC connect_as(SQLHENV environment, const std::wstring& settings, const std::wstring& user, const std::wstring& password) {
    const auto position = settings.find(L"UID=");
    check(position != std::wstring::npos, "catalog connection string has UID");
    const auto text = settings.substr(0, position) + L"UID=" + user + L";PWD=" + password + L";";
    SQLHDBC result = nullptr;
    check(SQLAllocHandle(SQL_HANDLE_DBC, environment, &result) == SQL_SUCCESS, "catalog user DBC");
    expect_dbc(SQLDriverConnectW(result, nullptr, wide(text), SQL_NTS, nullptr, 0, nullptr, SQL_DRIVER_NOPROMPT), result, "catalog user login");
    return result;
}
void disconnect(SQLHDBC connection, SQLHSTMT statement) {
    check(SQLFreeHandle(SQL_HANDLE_STMT, statement) == SQL_SUCCESS, "catalog user STMT free");
    expect_dbc(SQLDisconnect(connection), connection, "catalog user disconnect");
    check(SQLFreeHandle(SQL_HANDLE_DBC, connection) == SQL_SUCCESS, "catalog user DBC free");
}
bool starts_with(const std::wstring& text, const std::wstring& prefix) { return text.compare(0, prefix.size(), prefix) == 0; }
std::size_t count_prefixed(const std::vector<Row>& rows, std::size_t column, const std::wstring& prefix) {
    std::size_t count = 0;
    for (const auto& row : rows) if (starts_with(row.at(column), prefix)) ++count;
    return count;
}
std::vector<Row> tables_of(SQLHSTMT statement, const std::wstring& name_pattern) {
    expect_stmt(SQLTablesW(statement, wide(L""), 0, wide(L""), 0, wide(name_pattern), SQL_NTS, wide(L""), 0), statement, "catalog user SQLTables");
    return collect(statement, {2, 3, 4});
}
std::vector<Row> columns_of(SQLHSTMT statement, const std::wstring& table) {
    expect_stmt(SQLColumnsW(statement, wide(L""), 0, wide(L""), 0, wide(table), SQL_NTS, wide(L""), 0), statement, "catalog user SQLColumns");
    return collect(statement, {3, 4, 6});
}
std::vector<Row> primary_keys_of(SQLHSTMT statement, const std::wstring& table) {
    expect_stmt(SQLPrimaryKeysW(statement, wide(L""), 0, wide(L""), 0, wide(table), SQL_NTS), statement, "catalog user SQLPrimaryKeys");
    return collect(statement, {3, 4, 5});
}
std::vector<Row> statistics_of(SQLHSTMT statement, const std::wstring& table) {
    expect_stmt(SQLStatisticsW(statement, wide(L""), 0, wide(L""), 0, wide(table), SQL_NTS, SQL_INDEX_ALL, SQL_ENSURE), statement, "catalog user SQLStatistics");
    return collect(statement, {3, 6, 8, 9, 10});
}
std::vector<Row> special_columns_of(SQLHSTMT statement, SQLUSMALLINT scope, const std::wstring& table) {
    expect_stmt(SQLSpecialColumnsW(statement, SQL_BEST_ROWID, wide(L""), 0, wide(L""), 0, wide(table), SQL_NTS, scope, SQL_NULLABLE), statement, "catalog user SQLSpecialColumns");
    return collect(statement, {1, 2, 3});
}
// 실행이 주어진 SQLSTATE로 실패하는지 본다.
void expect_failure(SQLHSTMT statement, const std::wstring& text, const char* state) {
    check(SQLExecDirectW(statement, wide(text), SQL_NTS) == SQL_ERROR, "catalog user statement must fail");
    stmt_state(statement, state);
}
long long scalar_of(SQLHSTMT statement, const std::wstring& text) {
    sql(statement, text);
    check(SQLFetch(statement) == SQL_SUCCESS, "catalog scalar fetch");
    const auto value = getint(statement, 1);
    close_cursor(statement);
    return value;
}

// 복합 키·DESC 인덱스·특수 식별자·타입 인자 생략/명시·일반 인자의 정확한 비교를 확인한다. 기본 단계가 만든 Q9_VIEW 등을 이어서 쓴다.
void run_catalog_shape_cases(SQLHSTMT statement) {
    sql(statement, L"CREATE TABLE Q9_COMP_P (A INTEGER, B INTEGER, TXT VARCHAR, PRIMARY KEY (B, A))");
    sql(statement, L"CREATE TABLE Q9_COMP_C (ID INTEGER PRIMARY KEY, PA INTEGER, PB INTEGER, FOREIGN KEY (PB, PA) REFERENCES Q9_COMP_P (B, A))");
    sql(statement, L"CREATE INDEX Q9_COMP_IDX ON Q9_COMP_C (PB DESC, PA)");

    // 복합 PK는 컬럼 정의 순서(A, B)가 아니라 제약조건 순서(B, A)가 KEY_SEQ이다.
    {
        const auto keys = primary_keys_of(statement, L"Q9_COMP_P");
        check(keys.size() == 2, "composite primary key has two rows");
        check(keys[0][1] == L"B" && keys[0][2] == L"1" && keys[1][1] == L"A" && keys[1][2] == L"2", "composite primary key follows the constraint order");
    }
    // 복합 FK는 KEY_SEQ마다 참조되는 PK 컬럼과 FK 컬럼이 짝지어진다. 어느 쪽 테이블로 물어도 같은 행이다.
    for (const bool by_fk_table : {true, false}) {
        if (by_fk_table)
            expect_stmt(SQLForeignKeysW(statement, wide(L""), 0, wide(L""), 0, wide(L""), 0, wide(L""), 0, wide(L""), 0, wide(L"Q9_COMP_C"), SQL_NTS), statement, "composite FK by FK table");
        else
            expect_stmt(SQLForeignKeysW(statement, wide(L""), 0, wide(L""), 0, wide(L"Q9_COMP_P"), SQL_NTS, wide(L""), 0, wide(L""), 0, wide(L""), 0), statement, "composite FK by PK table");
        const auto fk = collect(statement, {3, 4, 7, 8, 9, 10, 11, 12, 13});
        check(fk.size() == 2, "composite foreign key has two rows");
        check(fk[0][0] == L"Q9_COMP_P" && fk[0][1] == L"B" && fk[0][2] == L"Q9_COMP_C" && fk[0][3] == L"PB" && fk[0][4] == L"1", "composite FK pair 1");
        check(fk[1][0] == L"Q9_COMP_P" && fk[1][1] == L"A" && fk[1][2] == L"Q9_COMP_C" && fk[1][3] == L"PA" && fk[1][4] == L"2", "composite FK pair 2");
        check(fk[0][5] == std::to_wstring(SQL_NO_ACTION) && fk[0][6] == std::to_wstring(SQL_NO_ACTION), "default FK rules are NO ACTION");
        check(fk[0][7] == fk[1][7] && fk[0][7] != L"<NULL>" && fk[0][8] != L"<NULL>", "FK and PK names are reported");
    }
    // DESC 인덱스: 컬럼마다 ASC_OR_DESC가 다르고 ORDINAL_POSITION이 정의 순서이다.
    {
        const auto stats = where(statistics_of(statement, L"Q9_COMP_C"), 1, L"Q9_COMP_IDX");
        check(stats.size() == 2, "composite index has two columns");
        check(stats[0][2] == L"1" && stats[0][3] == L"PB" && stats[0][4] == L"D", "first index column is descending");
        check(stats[1][2] == L"2" && stats[1][3] == L"PA" && stats[1][4] == L"A", "second index column is ascending");
    }
    // 특수 식별자: 공백, $, 예약어 이름은 따옴표로 만든 그대로 보존된다.
    sql(statement, L"CREATE TABLE \"Q9 Mixed$Name\" (\"select\" INTEGER PRIMARY KEY, \"Val Col\" DECIMAL)");
    {
        const auto columns = columns_of(statement, L"Q9 Mixed$Name");
        check(columns.size() == 2 && columns[0][1] == L"select" && columns[1][1] == L"Val Col", "quoted identifiers are preserved");
        const auto keys = primary_keys_of(statement, L"Q9 Mixed$Name");
        check(keys.size() == 1 && keys[0][1] == L"select", "primary key of a quoted identifier table");
        // 식별자 모드: 따옴표 없는 이름은 대문자로 접히므로 대소문자가 섞인 이름과 맞지 않는다.
        expect_stmt(SQLSetStmtAttr(statement, SQL_ATTR_METADATA_ID, reinterpret_cast<SQLPOINTER>(SQL_TRUE), 0), statement, "identifier mode on");
        expect_stmt(SQLColumnsW(statement, wide(L""), 0, wide(L""), 0, wide(L"\"Q9 Mixed$Name\""), SQL_NTS, wide(L""), 0), statement, "quoted identifier argument");
        check(collect(statement, {4}).size() == 2, "quoted identifier argument matches");
        expect_stmt(SQLColumnsW(statement, wide(L""), 0, wide(L""), 0, wide(L"q9 mixed$name"), SQL_NTS, wide(L""), 0), statement, "folded identifier argument");
        check(collect(statement, {4}).empty(), "unquoted identifier folds to upper case and misses a mixed case name");
        expect_stmt(SQLColumnsW(statement, wide(L""), 0, wide(L""), 0, wide(L"q9_parent"), SQL_NTS, wide(L"id"), SQL_NTS), statement, "folded plain identifier");
        check(collect(statement, {4}).size() == 1, "unquoted identifier folds to upper case and matches");
        expect_stmt(SQLSetStmtAttr(statement, SQL_ATTR_METADATA_ID, reinterpret_cast<SQLPOINTER>(SQL_FALSE), 0), statement, "identifier mode off");
    }
    // 타입 인자 생략과 명시는 서버가 확정한 선언 그대로 ODBC 크기·자릿수가 된다.
    sql(statement, L"CREATE TABLE Q9_TYPES (C1 CHAR, C2 VARCHAR, C3 DECIMAL, C4 DECIMAL(7), C5 NUMERIC(12,4), C6 TIMESTAMP, C7 TIMESTAMP(0), C8 TIME, C9 TIMESTAMP(3) WITH TIME ZONE)");
    {
        expect_stmt(SQLColumnsW(statement, wide(L""), 0, wide(L""), 0, wide(L"Q9_TYPES"), SQL_NTS, wide(L""), 0), statement, "type argument columns");
        // 4 COLUMN_NAME, 5 DATA_TYPE, 7 COLUMN_SIZE, 9 DECIMAL_DIGITS
        const auto columns = collect(statement, {4, 5, 7, 9});
        check(columns.size() == 9, "all type columns are listed");
        // 문자 타입의 DECIMAL_DIGITS는 해당 없음(NULL)이다.
        const std::wstring none = L"<NULL>";
        const auto expected = [&](std::size_t index, int type, int size, const std::wstring& digits, const char* what) {
            const auto& row = columns.at(index);
            if (row[1] != std::to_wstring(type) || row[2] != std::to_wstring(size) || row[3] != digits)
                std::wcerr << what << L": type=" << row[1] << L" size=" << row[2] << L" digits=" << row[3] << L'\n';
            check(row[1] == std::to_wstring(type) && row[2] == std::to_wstring(size) && row[3] == digits, what);
        };
        expected(0, SQL_WCHAR, 1, none, "CHAR without length is CHAR(1)");
        expected(1, SQL_WVARCHAR, 65535, none, "VARCHAR without length is 65535");
        expected(2, SQL_DECIMAL, 10, L"3", "DECIMAL without arguments is (10,3)");
        expected(3, SQL_DECIMAL, 7, L"0", "DECIMAL(p) has scale 0");
        expected(4, SQL_DECIMAL, 12, L"4", "NUMERIC(p,s) is reported as DECIMAL(p,s)");
        expected(5, SQL_TYPE_TIMESTAMP, 26, L"6", "TIMESTAMP defaults to 6 fractional digits");
        expected(6, SQL_TYPE_TIMESTAMP, 19, L"0", "TIMESTAMP(0) keeps zero fractional digits");
        expected(7, SQL_TYPE_TIME, 8, L"0", "TIME defaults to 0 fractional digits");
        expected(8, SQL_WVARCHAR, 29, L"3", "TIMESTAMP(3) WITH TIME ZONE is exposed as a string");
        // 카탈로그의 자릿수·타입은 실행 결과 메타데이터(SQLDescribeCol)와 같아야 한다.
        sql(statement, L"SELECT C1, C2, C3, C4, C5, C6, C7, C8, C9 FROM Q9_TYPES");
        for (SQLUSMALLINT column = 1; column <= 9; ++column) {
            SQLWCHAR name[64]{}; SQLSMALLINT name_length = 0, type = 0, digits = 0, nullable = 0; SQLULEN size = 0;
            expect_stmt(SQLDescribeColW(statement, column, name, 64, &name_length, &type, &size, &digits, &nullable), statement, "describe type column");
            const auto& row = columns.at(column - 1);
            // 카탈로그가 해당 없음(NULL)으로 보고한 자릿수는 결과 메타데이터에서 0이다.
            const auto catalog_digits = row[3] == none ? std::wstring(L"0") : row[3];
            if (row[1] != std::to_wstring(type) || catalog_digits != std::to_wstring(digits))
                std::wcerr << L"C" << column << L": catalog type=" << row[1] << L" digits=" << row[3] << L" result type=" << type << L" digits=" << digits << L'\n';
            check(row[1] == std::to_wstring(type), "catalog data type equals result set data type");
            check(catalog_digits == std::to_wstring(digits), "catalog decimal digits equal result set decimal digits");
        }
        close_cursor(statement);
    }
    // SQL_BEST_ROWID: 요청한 범위는 최소 범위이며 PK(SESSION 범위)는 어느 요청도 만족한다.
    for (const int scope : {SQL_SCOPE_CURROW, SQL_SCOPE_TRANSACTION, SQL_SCOPE_SESSION}) {
        const auto rowid = special_columns_of(statement, static_cast<SQLUSMALLINT>(scope), L"Q9_COMP_P");
        check(rowid.size() == 2, "best rowid is returned for every minimum scope");
        check(rowid[0][1] == L"B" && rowid[1][1] == L"A", "best rowid lists the composite primary key in order");
        check(std::stoi(rowid[0][0]) >= scope, "returned scope is not narrower than requested");
    }
    // 일반 인자는 패턴이 아니다. Q9_AB의 _ 가 Q9XAB와 맞아서는 안 되지만 패턴 값 인자(SQLTables)는 맞아야 한다.
    sql(statement, L"CREATE TABLE Q9_AB (ID INTEGER PRIMARY KEY)");
    sql(statement, L"CREATE TABLE Q9XAB (ID INTEGER PRIMARY KEY)");
    sql(statement, L"CREATE TABLE Q9_AB_CHILD (ID INTEGER PRIMARY KEY, P INTEGER REFERENCES Q9_AB)");
    sql(statement, L"CREATE TABLE Q9XAB_CHILD (ID INTEGER PRIMARY KEY, P INTEGER REFERENCES Q9XAB)");
    {
        const auto matched = tables_of(statement, L"Q9_AB");
        check(where(matched, 1, L"Q9_AB").size() == 1 && where(matched, 1, L"Q9XAB").size() == 1, "table name pattern treats _ as a wildcard");
        const auto keys = primary_keys_of(statement, L"Q9_AB");
        check(keys.size() == 1 && keys[0][0] == L"Q9_AB", "primary key lookup does not treat _ as a wildcard");
        const auto stats = statistics_of(statement, L"Q9_AB");
        check(!stats.empty() && count_prefixed(stats, 0, L"Q9XAB") == 0, "statistics lookup does not treat _ as a wildcard");
        const auto rowid = special_columns_of(statement, SQL_SCOPE_SESSION, L"Q9_AB");
        check(rowid.size() == 1, "special columns lookup does not treat _ as a wildcard");
        expect_stmt(SQLForeignKeysW(statement, wide(L""), 0, wide(L""), 0, wide(L"Q9_AB"), SQL_NTS, wide(L""), 0, wide(L""), 0, wide(L""), 0), statement, "FK lookup by PK table");
        const auto fk = collect(statement, {3, 7});
        check(fk.size() == 1 && fk[0][0] == L"Q9_AB" && fk[0][1] == L"Q9_AB_CHILD", "foreign key lookup does not treat _ as a wildcard");
    }
    sql(statement, L"DROP TABLE Q9XAB_CHILD");
    sql(statement, L"DROP TABLE Q9_AB_CHILD");
    sql(statement, L"DROP TABLE Q9XAB");
    sql(statement, L"DROP TABLE Q9_AB");
    sql(statement, L"DROP TABLE Q9_TYPES");
    sql(statement, L"DROP TABLE \"Q9 Mixed$Name\"");
    sql(statement, L"DROP TABLE Q9_COMP_C");
    sql(statement, L"DROP TABLE Q9_COMP_P");
}

// 권한이 다른 사용자가 보는 카탈로그와 실제 실행 가능 범위가 일치하는지 확인한다.
// 아무 권한 없는(기본 테이블스페이스도 없는) 사용자, 뷰 권한만 있는 사용자, 테이블스페이스 수준 SELECT 사용자이다.
void run_catalog_visibility_cases(SQLHDBC connection, SQLHSTMT statement, SQLHENV environment, const std::wstring& settings) {
    sql(statement, L"CREATE USER Q9_LIMITED IDENTIFIED BY 'q9-limited'");
    sql(statement, L"CREATE USER Q9_VIEWER IDENTIFIED BY 'q9-viewer'");
    sql(statement, L"GRANT SELECT ON VIEW Q9_VIEW TO Q9_VIEWER");
    sql(statement, L"CREATE USER Q9_READER IDENTIFIED BY 'q9-reader' DEFAULT TABLESPACE SYSTEM");
    sql(statement, L"GRANT SELECT ON TABLESPACE SYSTEM TO Q9_READER");
    // 비교 기준: SYSTEM(DBA)은 Q9_ 객체를 모두 본다.
    {
        const auto all = tables_of(statement, L"Q9_%");
        check(where(all, 1, L"Q9_PARENT").size() == 1 && where(all, 1, L"Q9_CHILD").size() == 1 && where(all, 1, L"Q9_VIEW").size() == 1, "DBA sees every Q9 object");
    }
    // 1) 권한이 없고 기본 테이블스페이스도 없는 사용자는 SYSTEM의 Q9 객체를 탐색에서 볼 수 없고 실행도 못 한다.
    {
        auto session = connect_as(environment, settings, L"Q9_LIMITED", L"q9-limited");
        auto limited = allocate(session);
        char user[64]{}; SQLSMALLINT length = 0;
        expect_dbc(SQLGetInfo(session, SQL_USER_NAME, user, sizeof(user), &length), session, "limited user name");
        check(std::string(user) == "Q9_LIMITED", "connected as the limited user");
        check(count_prefixed(tables_of(limited, L"Q9_%"), 1, L"Q9_") == 0, "limited user sees no Q9 table or view");
        check(columns_of(limited, L"Q9_PARENT").empty() && columns_of(limited, L"Q9_VIEW").empty(), "limited user sees no Q9 columns");
        check(primary_keys_of(limited, L"Q9_PARENT").empty(), "limited user sees no primary key");
        check(statistics_of(limited, L"Q9_CHILD").empty(), "limited user sees no index");
        check(special_columns_of(limited, SQL_SCOPE_CURROW, L"Q9_PARENT").empty(), "limited user sees no row identifier");
        expect_stmt(SQLForeignKeysW(limited, wide(L""), 0, wide(L""), 0, wide(L""), 0, wide(L""), 0, wide(L""), 0, wide(L"Q9_CHILD"), SQL_NTS), limited, "limited FK");
        check(collect(limited, {3}).empty(), "limited user sees no foreign key");
        expect_stmt(SQLTablePrivilegesW(limited, wide(L""), 0, wide(L""), 0, wide(L"Q9_%"), SQL_NTS), limited, "limited privileges");
        check(collect(limited, {3}).empty(), "limited user sees no privilege rows for Q9 objects");
        expect_stmt(SQLTablesW(limited, wide(L""), 0, wide(L"%"), SQL_NTS, wide(L""), 0, wide(L""), 0), limited, "limited schemas");
        check(where(collect(limited, {1}), 0, L"SYSTEM").empty(), "limited user does not see the SYSTEM tablespace");
        // 탐색에 보이지 않는 것은 실행도 안 된다.
        expect_failure(limited, L"SELECT COUNT(*) FROM SYSTEM.Q9_PARENT", "42501");
        expect_failure(limited, L"SELECT COUNT(*) FROM SYSTEM.Q9_VIEW", "42501");
        disconnect(session, limited);
    }
    // 2) 뷰 권한만 있는 사용자는 뷰와 그 컬럼만 보고, 기반 테이블은 보지도 읽지도 못한다.
    {
        auto session = connect_as(environment, settings, L"Q9_VIEWER", L"q9-viewer");
        auto viewer = allocate(session);
        const auto visible = tables_of(viewer, L"Q9_%");
        check(count_prefixed(visible, 1, L"Q9_") == 1 && where(visible, 1, L"Q9_VIEW").size() == 1 && visible[0][2] == L"VIEW", "view-only user sees just the view");
        const auto view_columns = columns_of(viewer, L"Q9_VIEW");
        check(view_columns.size() == 2 && view_columns[0][1] == L"ID" && view_columns[1][1] == L"NAME", "view-only user sees the view columns");
        check(columns_of(viewer, L"Q9_PARENT").empty(), "view-only user does not see base table columns");
        check(primary_keys_of(viewer, L"Q9_PARENT").empty() && statistics_of(viewer, L"Q9_PARENT").empty(), "view-only user does not see base table keys or indexes");
        expect_stmt(SQLTablePrivilegesW(viewer, wide(L""), 0, wide(L""), 0, wide(L"Q9_VIEW"), SQL_NTS), viewer, "viewer privileges");
        const auto grants = collect(viewer, {3, 5, 6});
        check(grants.size() == 1 && grants[0][1] == L"Q9_VIEWER" && grants[0][2] == L"SELECT", "view-only user sees its own grant");
        // 뷰 권한이 있으면 기반 테이블 권한 없이 뷰를 읽을 수 있고, 기반 테이블은 읽을 수 없다. 탐색 결과와 같다.
        check(scalar_of(viewer, L"SELECT COUNT(*) FROM SYSTEM.Q9_VIEW") == 2, "view-only user reads through the view");
        expect_failure(viewer, L"SELECT COUNT(*) FROM SYSTEM.Q9_PARENT", "42501");
        disconnect(session, viewer);
    }
    // 3) 테이블스페이스 수준 SELECT 사용자는 그 안의 모든 테이블과 뷰를 보고 읽는다. 기본 테이블스페이스가 있어도 권한은 따로이다.
    {
        auto session = connect_as(environment, settings, L"Q9_READER", L"q9-reader");
        auto reader = allocate(session);
        const auto visible = tables_of(reader, L"Q9_%");
        check(where(visible, 1, L"Q9_PARENT").size() == 1 && where(visible, 1, L"Q9_CHILD").size() == 1 && where(visible, 1, L"Q9_VIEW").size() == 1, "tablespace reader sees every Q9 object");
        check(columns_of(reader, L"Q9_PARENT").size() == 2 && primary_keys_of(reader, L"Q9_PARENT").size() == 1, "tablespace reader sees columns and keys");
        expect_stmt(SQLTablesW(reader, wide(L""), 0, wide(L"%"), SQL_NTS, wide(L""), 0, wide(L""), 0), reader, "reader schemas");
        check(!where(collect(reader, {1}), 0, L"SYSTEM").empty(), "tablespace reader sees the SYSTEM tablespace");
        check(scalar_of(reader, L"SELECT COUNT(*) FROM SYSTEM.Q9_PARENT") == 2, "tablespace reader reads the table");
        disconnect(session, reader);
    }
    sql(statement, L"DROP USER Q9_READER");
    sql(statement, L"DROP USER Q9_VIEWER");
    sql(statement, L"DROP USER Q9_LIMITED");
    (void)connection;
}
}

void run_catalog_cases(SQLHDBC connection, SQLHENV environment, const std::wstring& settings) {
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

    run_catalog_shape_cases(statement);
    run_catalog_visibility_cases(connection, statement, environment, settings);

    sql(statement, L"DROP VIEW Q9_VIEW");
    sql(statement, L"DROP TABLE Q9_CHILD");
    sql(statement, L"DROP TABLE Q9_PARENT");
    check(SQLFreeHandle(SQL_HANDLE_STMT, other) == SQL_SUCCESS, "catalog other free");
    check(SQLFreeHandle(SQL_HANDLE_STMT, statement) == SQL_SUCCESS, "catalog statement free");
    std::cout << "ODBC catalog/info/typeinfo/MoreResults PASS\n";
}
