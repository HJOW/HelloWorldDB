#include "hwdbodbc/odbc.hpp"
#include "../helpers/check.hpp"
#include <array>
#include <algorithm>
#include <cstring>
#include <limits>
#include <string>
#include <vector>
#include <cmath>

namespace {
void expect(SQLRETURN result, SQLHSTMT statement, const char* operation) {
    if (!SQL_SUCCEEDED(result)) {
        SQLCHAR state[6]{}, text[1024]{};
        SQLINTEGER native = 0;
        SQLGetDiagRec(SQL_HANDLE_STMT, statement, 1, state, &native, text, 1024, nullptr);
        std::cerr << operation << " STATE=" << state << " NATIVE=" << native << " MESSAGE=" << text << '\n';
        check(false, operation);
    }
}
void state(SQLHSTMT statement, const char* expected) {
    SQLCHAR output[6]{};
    check(SQLGetDiagRec(SQL_HANDLE_STMT, statement, 1, output, nullptr, nullptr, 0, nullptr) == SQL_SUCCESS, "statement diagnostic");
    if (std::strcmp(reinterpret_cast<const char*>(output), expected)) std::cerr << "expected " << expected << ", received " << output << '\n';
    check(std::strcmp(reinterpret_cast<const char*>(output), expected) == 0, "statement SQLSTATE");
}
void execute(SQLHSTMT statement, const std::wstring& sql) {
    expect(SQLExecDirectW(statement, reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(sql.c_str())), static_cast<SQLINTEGER>(sql.size())), statement, "SQLExecDirectW");
}
std::wstring text(SQLHSTMT statement, SQLUSMALLINT column) {
    SQLWCHAR buffer[256]{};
    SQLLEN length = -1;
    const auto result = SQLGetData(statement, column, SQL_C_WCHAR, buffer, sizeof(buffer), &length);
    expect(result, statement, "SQLGetData(WCHAR)");
    check(result == SQL_SUCCESS && length != SQL_NULL_DATA, "complete nonnull W text");
    return reinterpret_cast<wchar_t*>(buffer);
}
template<class T> T scalar(SQLHSTMT statement, SQLUSMALLINT column, SQLSMALLINT type) {
    struct Output { T value{}; unsigned char canary[16]{}; } output;
    std::fill_n(output.canary, 16, static_cast<unsigned char>(0x5a));
    SQLLEN length = -1;
    // 고정 타입은 BufferLength가 아니라 SDK 구조체 크기만큼 쓴다.
    expect(SQLGetData(statement, column, type, &output.value, 0, &length), statement, "SQLGetData(fixed)");
    check(length == sizeof(T) && std::all_of(std::begin(output.canary), std::end(output.canary), [](auto byte) { return byte == 0x5a; }), "fixed output length/canary");
    return output.value;
}
void close(SQLHSTMT statement) { expect(SQLCloseCursor(statement), statement, "SQLCloseCursor"); }
}

void run_query_cases(SQLHDBC connection) {
    SQLHSTMT statement = nullptr;
    check(SQLAllocHandle(SQL_HANDLE_STMT, connection, &statement) == SQL_SUCCESS, "query STMT allocate");
    execute(statement, L"SELECT 'Hello World' AS MESSAGE");
    SQLSMALLINT count = -1;
    expect(SQLNumResultCols(statement, &count), statement, "SQLNumResultCols"); check(count == 1, "Hello World column count");
    expect(SQLFetch(statement), statement, "SQLFetch Hello World"); check(text(statement, 1) == L"Hello World", "Hello World");
    check(SQLFetch(statement) == SQL_NO_DATA && SQLFetch(statement) == SQL_NO_DATA, "repeated end of cursor");
    check(SQLMoreResults(statement) == SQL_NO_DATA, "one statement has no additional result");
    // MoreResults의 NO_DATA 뒤에는 Manager가 미실행 상태에서 HY010을 낸다.
    check(SQLFetch(statement) == SQL_ERROR, "fetch after result completion"); state(statement, "HY010");

    SQLHSTMT other = nullptr;
    check(SQLAllocHandle(SQL_HANDLE_STMT, connection, &other) == SQL_SUCCESS, "named cursor STMT");
    SQLWCHAR generated[64]{}; SQLSMALLINT generated_length = 0;
    expect(SQLGetCursorNameW(other, generated, 64, &generated_length), other, "generated cursor name");
    check(generated_length <= 18 && std::wstring(reinterpret_cast<wchar_t*>(generated)).rfind(L"SQL_CUR", 0) == 0, "generated name conforms");
    const wchar_t* cursor_name = L"커서😀";
    expect(SQLSetCursorNameW(statement, reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(cursor_name)), SQL_NTS), statement, "set cursor name");
    check(SQLSetCursorNameW(other, reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(cursor_name)), SQL_NTS) == SQL_ERROR, "duplicate cursor name"); state(other, "3C000");
    struct { SQLWCHAR value[3]{}; SQLWCHAR canary = 0x5a5a; } short_name;
    SQLSMALLINT cursor_length = 0;
    check(SQLGetCursorNameW(statement, short_name.value, 3, &cursor_length) == SQL_SUCCESS_WITH_INFO
        && cursor_length == 4 && short_name.value[2] == 0 && short_name.canary == 0x5a5a, "cursor W length/canary");
    execute(statement, L"SELECT 1 AS \"별칭😀\"");
    SQLSMALLINT label_length = 0;
    check(SQLDescribeColW(statement, 1, short_name.value, 3, &label_length, nullptr, nullptr, nullptr, nullptr) == SQL_SUCCESS_WITH_INFO
        && label_length == 4 && short_name.value[2] == 0 && short_name.canary == 0x5a5a, "DescribeCol W code units");
    check(SQLColAttributeW(statement, 1, SQL_DESC_NAME, short_name.value, 6, &label_length, nullptr) == SQL_SUCCESS_WITH_INFO
        && label_length == 8 && short_name.value[2] == 0 && short_name.canary == 0x5a5a, "ColAttribute W byte length");
    close(statement);
    const wchar_t* quoted_lower = L"\"CaseSensitive\"", *quoted_upper = L"\"CASESENSITIVE\"";
    expect(SQLSetCursorNameW(statement, reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(quoted_lower)), SQL_NTS), statement, "quoted cursor lower");
    expect(SQLSetCursorNameW(other, reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(quoted_upper)), SQL_NTS), other, "quoted cursor upper distinct");
    check(SQLFreeHandle(SQL_HANDLE_STMT, other) == SQL_SUCCESS, "named cursor STMT free");

    execute(statement, L"CREATE TABLE Q5_BATCH (ID INTEGER PRIMARY KEY, TXT VARCHAR)");
    execute(statement, L"INSERT INTO Q5_BATCH VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d'),(5,'e'),(6,'f'),(7,'g'),(8,'h'),(9,'i')");
    SQLLEN affected = -1;
    expect(SQLRowCount(statement, &affected), statement, "insert row count"); check(affected == 9, "insert nine rows");
    execute(statement, L"UPDATE Q5_BATCH SET TXT = 'changed'");
    expect(SQLRowCount(statement, &affected), statement, "update row count"); check(affected == 9, "update nine rows");
    expect(SQLNumResultCols(statement, &count), statement, "DML result columns"); check(count == 0, "DML has no columns");

    const std::wstring all_types =
        L"SELECT CAST('ab' AS CHAR(5)) AS C, CAST('한😀' AS VARCHAR(20)) AS S, X'00FF0001' AS B, "
        L"CAST(-32768 AS SMALLINT) AS SM, CAST(2147483647 AS INTEGER) AS I, CAST('9223372036854775807' AS BIGINT) AS BG, "
        L"CAST('99999999999999999999999999999999.123456' AS DECIMAL(38,6)) AS N, CAST(3.25 AS REAL) AS R, "
        L"CAST(1.23456789012345 AS DOUBLE PRECISION) AS D, TRUE AS BO, DATE '0001-01-01' AS DT, "
        L"TIME '23:59:59.123456' AS TM, TIMESTAMP '9999-12-31 23:59:59.123456' AS TS, "
        L"CAST('2026-10-21 12:34:56.123456+09:00' AS TIMESTAMP(6) WITH TIME ZONE) AS TZ, "
        L"INTERVAL '1-02' YEAR TO MONTH AS YM, INTERVAL '3 04:05:06.123456' DAY TO SECOND AS DS, "
        L"CAST(123 AS NUMERIC(9)) AS NP, CAST('default' AS VARCHAR) AS VD, CAST(12.345 AS DECIMAL) AS ND, "
        L"CAST('한글' AS NVARCHAR) AS NV, CAST(X'00FF' AS BINARY(4)) AS FB, "
        L"CAST('12:34:56.123+09:00' AS TIME(3) WITH TIME ZONE) AS TTZ";
    execute(statement, all_types);
    expect(SQLNumResultCols(statement, &count), statement, "all types column count"); check(count == 22, "all types");
    SQLWCHAR name[64]{}; SQLSMALLINT name_length, sql_type, scale, nullable; SQLULEN column_size;
    expect(SQLDescribeColW(statement, 7, name, 64, &name_length, &sql_type, &column_size, &scale, &nullable), statement, "DECIMAL metadata");
    check(sql_type == SQL_DECIMAL && column_size == 38 && scale == 6, "declared DECIMAL metadata");
    expect(SQLDescribeColW(statement, 17, name, 64, &name_length, &sql_type, &column_size, &scale, &nullable), statement, "NUMERIC metadata");
    check(column_size == 9 && scale == 0, "NUMERIC(p) scale zero");
    expect(SQLDescribeColW(statement, 18, name, 64, &name_length, &sql_type, &column_size, &scale, &nullable), statement, "VARCHAR default metadata");
    check(sql_type == SQL_WVARCHAR && column_size == 65535, "VARCHAR default length");
    expect(SQLDescribeColW(statement, 19, name, 64, &name_length, &sql_type, &column_size, &scale, &nullable), statement, "DECIMAL default metadata");
    check(column_size == 10 && scale == 3, "DECIMAL default (10,3)");
    expect(SQLFetch(statement), statement, "all types fetch");
    check(text(statement, 1) == L"ab   " && text(statement, 2) == L"한😀", "fixed padding and Unicode");
    std::array<unsigned char, 5> bytes{}; bytes[4] = 0x5a; SQLLEN length = -1;
    expect(SQLGetData(statement, 3, SQL_C_BINARY, bytes.data(), 4, &length), statement, "binary data");
    check(length == 4 && bytes[0] == 0 && bytes[1] == 255 && bytes[2] == 0 && bytes[3] == 1 && bytes[4] == 0x5a, "binary zeros and canary");
    check(scalar<SQLSMALLINT>(statement, 4, SQL_C_SSHORT) == -32768, "SMALLINT minimum");
    check(scalar<SQLINTEGER>(statement, 5, SQL_C_SLONG) == 2147483647, "INTEGER maximum");
    check(scalar<SQLBIGINT>(statement, 6, SQL_C_SBIGINT) == 9223372036854775807LL, "BIGINT maximum");
    check(text(statement, 7) == L"99999999999999999999999999999999.123456", "38 digit decimal exact string");
    check(scalar<float>(statement, 8, SQL_C_FLOAT) == 3.25F, "REAL");
    check(std::abs(scalar<double>(statement, 9, SQL_C_DOUBLE) - 1.23456789012345) < 1e-14, "DOUBLE");
    check(scalar<unsigned char>(statement, 10, SQL_C_BIT) == 1, "BOOLEAN");
    check(scalar<SQL_DATE_STRUCT>(statement, 11, SQL_C_TYPE_DATE).year == 1, "DATE year 0001");
    check(scalar<SQL_TIME_STRUCT>(statement, 12, SQL_C_TYPE_TIME).second == 59, "TIME with fractional warning");
    state(statement, "01S07");
    check(scalar<SQL_TIMESTAMP_STRUCT>(statement, 13, SQL_C_TYPE_TIMESTAMP).fraction == 123456000, "TIMESTAMP microseconds");
    check(text(statement, 14) == L"2026-10-21 12:34:56.123456+09:00", "timestamp offset preserved");
    const auto ym = scalar<SQL_INTERVAL_STRUCT>(statement, 15, SQL_C_INTERVAL_YEAR_TO_MONTH);
    check(ym.intval.year_month.year == 1 && ym.intval.year_month.month == 2, "year/month interval");
    const auto ds = scalar<SQL_INTERVAL_STRUCT>(statement, 16, SQL_C_INTERVAL_DAY_TO_SECOND);
    check(ds.intval.day_second.day == 3 && ds.intval.day_second.fraction == 123456000, "day/second interval");
    check(text(statement, 17) == L"123" && text(statement, 18) == L"default" && text(statement, 19) == L"12.345"
        && text(statement, 20) == L"한글", "default/explicit types");
    expect(SQLGetData(statement, 21, SQL_C_BINARY, bytes.data(), 4, &length), statement, "fixed binary");
    check(length == 4 && bytes[0] == 0 && bytes[1] == 255 && bytes[2] == 0 && bytes[3] == 0, "fixed binary padding");
    check(text(statement, 22) == L"12:34:56.123+09:00", "time offset preserved");
    close(statement);

    execute(statement, L"SELECT CAST(123.456 AS DECIMAL(10,3)) AS N"); expect(SQLFetch(statement), statement, "numeric fetch");
    const auto numeric = scalar<SQL_NUMERIC_STRUCT>(statement, 1, SQL_C_NUMERIC);
    check(numeric.precision == 38 && numeric.scale == 0 && numeric.sign == 1 && numeric.val[0] == 123 && numeric.val[1] == 0, "numeric default scale without floating point");
    state(statement, "01S07"); close(statement);

    const std::array<std::wstring, 13> intervals{{L"INTERVAL '12' YEAR", L"INTERVAL '12' MONTH", L"INTERVAL '12' DAY",
        L"INTERVAL '12' HOUR", L"INTERVAL '12' MINUTE", L"INTERVAL '12.123456' SECOND", L"INTERVAL '1-02' YEAR TO MONTH",
        L"INTERVAL '3 04' DAY TO HOUR", L"INTERVAL '3 04:05' DAY TO MINUTE", L"INTERVAL '3 04:05:06.123456' DAY TO SECOND",
        L"INTERVAL '4:05' HOUR TO MINUTE", L"INTERVAL '4:05:06.123456' HOUR TO SECOND", L"INTERVAL '5:06.123456' MINUTE TO SECOND"}};
    std::wstring interval_query = L"SELECT ";
    for (std::size_t i = 0; i < intervals.size(); ++i) { if (i) interval_query += L", "; interval_query += intervals[i]; }
    execute(statement, interval_query); expect(SQLFetch(statement), statement, "all interval qualifiers fetch");
    for (std::size_t i = 0; i < intervals.size(); ++i) {
        const auto interval = scalar<SQL_INTERVAL_STRUCT>(statement, static_cast<SQLUSMALLINT>(i + 1), SQL_C_DEFAULT);
        check(interval.interval_type == static_cast<SQLINTERVAL>(i + 1), "interval qualifier default C type");
        if (i == 0) check(interval.intval.year_month.year == 12, "YEAR interval");
        if (i == 1) check(interval.intval.year_month.month == 12, "MONTH interval");
        if (i == 2) check(interval.intval.day_second.day == 12, "DAY interval");
        if (i == 3) check(interval.intval.day_second.hour == 12, "HOUR interval");
        if (i == 4) check(interval.intval.day_second.minute == 12, "MINUTE interval");
        if (i == 5 || i == 9 || i == 11 || i == 12) check(interval.intval.day_second.fraction == 123456000, "interval microsecond precision");
    }
    close(statement);

    execute(statement, L"SELECT CAST(NULL AS VARCHAR(10)) AS N, CAST('' AS VARCHAR(10)) AS E, X'' AS B");
    SQLWCHAR null_buffer[8]{};
    expect(SQLBindCol(statement, 1, SQL_C_WCHAR, null_buffer, sizeof(null_buffer), nullptr), statement, "NULL bind without indicator");
    check(SQLFetch(statement) == SQL_ERROR, "NULL without indicator fails"); state(statement, "22002");
    expect(SQLFreeStmt(statement, SQL_UNBIND), statement, "UNBIND"); close(statement);
    execute(statement, L"SELECT CAST(NULL AS VARCHAR(10)) AS N, CAST('' AS VARCHAR(10)) AS E, X'' AS B");
    SQLLEN null_indicator = 0;
    expect(SQLBindCol(statement, 1, SQL_C_WCHAR, null_buffer, sizeof(null_buffer), &null_indicator), statement, "NULL bind");
    expect(SQLFetch(statement), statement, "NULL fetch"); check(null_indicator == SQL_NULL_DATA, "NULL distinct from empty");
    check(SQLGetData(statement, 1, SQL_C_WCHAR, null_buffer, sizeof(null_buffer), &length) == SQL_ERROR, "bound GetData rejected"); state(statement, "07009");
    check(text(statement, 2).empty(), "empty string preserved");
    expect(SQLGetData(statement, 3, SQL_C_BINARY, bytes.data(), 1, &length), statement, "empty binary"); check(length == 0, "empty binary preserved");
    check(SQLGetData(statement, 2, SQL_C_WCHAR, null_buffer, sizeof(null_buffer), &length) == SQL_ERROR, "backward GetData rejected"); state(statement, "07009");
    expect(SQLFreeStmt(statement, SQL_UNBIND), statement, "UNBIND after NULL"); close(statement);

    execute(statement, L"SELECT 'abcd' AS S");
    struct { SQLWCHAR value[2]{}; SQLWCHAR canary = 0x5a5a; } short_value;
    SQLLEN short_length = -1;
    expect(SQLBindCol(statement, 1, SQL_C_WCHAR, short_value.value, 4, &short_length), statement, "short binding");
    check(SQLFetch(statement) == SQL_SUCCESS_WITH_INFO && short_length == 8 && short_value.value[0] == 'a'
        && short_value.value[1] == 0 && short_value.canary == 0x5a5a, "bound truncation warning/canary"); state(statement, "01004");
    SQLLEN diagnostic_row = -1; SQLINTEGER diagnostic_column = -1;
    expect(SQLGetDiagField(SQL_HANDLE_STMT, statement, 1, SQL_DIAG_ROW_NUMBER, &diagnostic_row, 0, nullptr), statement, "bound truncation diagnostic row");
    expect(SQLGetDiagField(SQL_HANDLE_STMT, statement, 1, SQL_DIAG_COLUMN_NUMBER, &diagnostic_column, 0, nullptr), statement, "bound truncation diagnostic column");
    check(diagnostic_row == 1 && diagnostic_column == 1, "bound warning location");
    expect(SQLFreeStmt(statement, SQL_UNBIND), statement, "UNBIND short binding"); close(statement);

    std::wstring long_value;
    for (int i = 0; i < 20000; ++i) long_value += L"한😀";
    execute(statement, L"SELECT '" + long_value + L"' AS LONG_VALUE"); expect(SQLFetch(statement), statement, "large response fetch");
    SQLWCHAR chunk[512]{}; std::wstring reconstructed;
    for (;;) {
        const auto remaining = static_cast<SQLLEN>((long_value.size() - reconstructed.size()) * 2);
        const auto rc = SQLGetData(statement, 1, SQL_C_WCHAR, chunk, sizeof(chunk), &length);
        expect(rc, statement, "partial SQLGetData"); check(length == remaining, "partial remaining byte length");
        reconstructed += reinterpret_cast<wchar_t*>(chunk);
        if (rc == SQL_SUCCESS) break;
        state(statement, "01004");
    }
    check(reconstructed == long_value, "long Unicode text reconstructed");
    check(SQLGetData(statement, 1, SQL_C_WCHAR, chunk, sizeof(chunk), &length) == SQL_NO_DATA, "partial retrieval end"); close(statement);

    execute(statement, L"SELECT ID, TXT FROM Q5_BATCH ORDER BY ID");
    SQLINTEGER bound_id = 0; SQLLEN bound_length = 0; SQLULEN fetched = 0; SQLUSMALLINT status = 99;
    expect(SQLBindCol(statement, 1, SQL_C_SLONG, &bound_id, 0, &bound_length), statement, "BindCol integer");
    expect(SQLSetStmtAttr(statement, SQL_ATTR_ROWS_FETCHED_PTR, &fetched, 0), statement, "rows fetched pointer");
    expect(SQLSetStmtAttr(statement, SQL_ATTR_ROW_STATUS_PTR, &status, 0), statement, "row status pointer");
    for (int i = 1; i <= 9; ++i) {
        expect(SQLFetchScroll(statement, SQL_FETCH_NEXT, 999), statement, "FetchScroll NEXT ignores offset");
        check(bound_id == i && bound_length == 4 && fetched == 1 && status == SQL_ROW_SUCCESS, "bound value and row status");
        check(text(statement, 2) == L"changed", "unbound column after bound column");
    }
    check(SQLFetch(statement) == SQL_NO_DATA && fetched == 0 && status == SQL_ROW_NOROW, "end row status");
    expect(SQLFreeStmt(statement, SQL_UNBIND), statement, "UNBIND batch"); close(statement);

    std::vector<SQLHSTMT> cursors;
    for (int i = 0; i < 17; ++i) {
        SQLHSTMT cursor = nullptr;
        check(SQLAllocHandle(SQL_HANDLE_STMT, connection, &cursor) == SQL_SUCCESS, "cursor limit STMT allocate");
        cursors.push_back(cursor);
        const std::wstring sql = L"SELECT A.ID FROM Q5_BATCH A CROSS JOIN Q5_BATCH B CROSS JOIN Q5_BATCH C";
        const auto rc = SQLExecDirectW(cursor, reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(sql.c_str())), SQL_NTS);
        if (i < 16) expect(rc, cursor, "open cursor within limit");
        else { check(rc == SQL_ERROR, "seventeenth server cursor rejected"); state(cursor, "53400"); }
    }
    execute(statement, L"COMMIT"); execute(statement, L"ROLLBACK");
    for (int i = 0; i < 729; ++i) expect(SQLFetch(cursors[0]), cursors[0], "holdable cursor across commit/rollback and server fetch");
    check(SQLFetch(cursors[0]) == SQL_NO_DATA, "holdable cursor final row");
    for (auto cursor : cursors) check(SQLFreeHandle(SQL_HANDLE_STMT, cursor) == SQL_SUCCESS, "STMT free closes its server cursor");
    execute(statement, L"DELETE FROM Q5_BATCH WHERE ID=9"); expect(SQLRowCount(statement, &affected), statement, "delete row count"); check(affected == 1, "delete one row");
    check(SQLFreeHandle(SQL_HANDLE_STMT, statement) == SQL_SUCCESS, "query STMT final free");
    std::cout << "ODBC SQL/types/partial data/cursor limit PASS\n";
}
