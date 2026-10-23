#include "hwdbodbc/catalog.hpp"
#include "../helpers/check.hpp"
#include <string>

int main() {
    return run_checks([] {
        // 패턴 일치: % _ 와일드카드와 이스케이프이다.
        check(hwdbodbc::catalog_match("Q9_PARENT", "Q9_%", false), "prefix pattern");
        check(!hwdbodbc::catalog_match("Q9_PARENT", "Q9_%", true), "metadata literal percent");
        check(hwdbodbc::catalog_match("Q9_PARENT", "Q9_PARENT", true), "metadata exact");
        check(hwdbodbc::catalog_match("A%B", "A\\%B", false), "escaped percent");
        check(hwdbodbc::catalog_match("A_B", "A\\_B", false), "escaped underscore");
        check(hwdbodbc::catalog_match("ABC", "A_C", false), "underscore single");
        check(!hwdbodbc::catalog_match("AC", "A_C", false), "underscore requires one");
        check(hwdbodbc::catalog_match("", "%", false), "percent matches empty");
        check(hwdbodbc::catalog_match("", "", false), "empty pattern matches empty");
        // 선언 해석: 기본/정밀도/타임존/INTERVAL이다.
        {
            const auto varchar = hwdbodbc::parse_declared_type("VARCHAR(20)");
            check(varchar.base == "VARCHAR" && varchar.length == 20, "varchar length");
            const auto dec_default = hwdbodbc::parse_declared_type("DECIMAL(10,3)");
            check(dec_default.base == "DECIMAL" && dec_default.precision == 10 && dec_default.scale == 3, "decimal precision");
            const auto num = hwdbodbc::parse_declared_type("DECIMAL(9,0)");
            check(num.base == "DECIMAL" && num.scale == 0, "numeric scale zero");
            const auto ts = hwdbodbc::parse_declared_type("TIMESTAMP(6) WITH TIME ZONE");
            check(ts.base == "TIMESTAMP" && ts.with_time_zone && ts.fractional == 6, "timestamp tz");
            const auto ym = hwdbodbc::parse_declared_type("INTERVAL YEAR(2) TO MONTH");
            check(ym.base == "INTERVAL" && ym.start_field == "YEAR" && ym.end_field == "MONTH", "interval year-month");
            const auto ds = hwdbodbc::parse_declared_type("INTERVAL DAY(2) TO SECOND(6)");
            check(ds.start_field == "DAY" && ds.end_field == "SECOND" && ds.fractional == 6, "interval day-second");
        }
        // 타입 정보: ODBC 코드와 크기이다.
        {
            const auto varchar = hwdbodbc::catalog_type_info("VARCHAR(20)");
            check(varchar.sql_type == SQL_WVARCHAR && varchar.column_size == 20, "varchar typeinfo");
            const auto dec = hwdbodbc::catalog_type_info("DECIMAL(10,2)");
            check(dec.sql_type == SQL_DECIMAL && dec.column_size == 10 && dec.decimal_digits == 2, "decimal typeinfo");
            const auto integer = hwdbodbc::catalog_type_info("INTEGER");
            check(integer.sql_type == SQL_INTEGER && integer.column_size == 10, "integer typeinfo");
            const auto ts = hwdbodbc::catalog_type_info("TIMESTAMP(6)");
            check(ts.sql_type == SQL_TYPE_TIMESTAMP, "timestamp typeinfo");
            const auto tstz = hwdbodbc::catalog_type_info("TIMESTAMP(6) WITH TIME ZONE");
            check(tstz.sql_type == SQL_WVARCHAR, "timestamptz exposed as wide varchar");
            const auto ym = hwdbodbc::catalog_type_info("INTERVAL YEAR(2) TO MONTH");
            check(ym.sql_type == SQL_INTERVAL_YEAR_TO_MONTH, "interval typeinfo");
        }
        // 소수 초 자릿수: 서버는 항상 TIMESTAMP(p)로 적는다. 0은 명시한 값이며 생략 기본값 6과 다르다.
        {
            const auto p6 = hwdbodbc::catalog_type_info("TIMESTAMP(6)");
            check(p6.column_size == 26 && p6.decimal_digits == 6, "timestamp(6) size and digits");
            const auto p0 = hwdbodbc::catalog_type_info("TIMESTAMP(0)");
            check(p0.sql_type == SQL_TYPE_TIMESTAMP && p0.column_size == 19 && p0.decimal_digits == 0, "timestamp(0) is not the default 6");
            const auto p3 = hwdbodbc::catalog_type_info("TIMESTAMP(3)");
            check(p3.column_size == 23 && p3.decimal_digits == 3, "timestamp(3) size and digits");
            const auto omitted = hwdbodbc::catalog_type_info("TIMESTAMP");
            check(omitted.column_size == 26 && omitted.decimal_digits == 6, "omitted timestamp precision defaults to 6");
            const auto tz0 = hwdbodbc::catalog_type_info("TIMESTAMP(0) WITH TIME ZONE");
            check(tz0.sql_type == SQL_WVARCHAR && tz0.column_size == 25 && tz0.decimal_digits == 0, "timestamp(0) with time zone");
            const auto tz6 = hwdbodbc::catalog_type_info("TIMESTAMP(6) WITH TIME ZONE");
            check(tz6.column_size == 32 && tz6.decimal_digits == 6, "timestamp(6) with time zone");
            const auto t0 = hwdbodbc::catalog_type_info("TIME(0)");
            check(t0.sql_type == SQL_TYPE_TIME && t0.column_size == 8 && t0.decimal_digits == 0, "time(0)");
            const auto t6 = hwdbodbc::catalog_type_info("TIME(6)");
            check(t6.column_size == 15 && t6.decimal_digits == 6, "time(6)");
            check(hwdbodbc::parse_declared_type("TIMESTAMP(0)").has_fractional, "explicit zero precision is recorded");
            check(!hwdbodbc::parse_declared_type("TIMESTAMP").has_fractional, "omitted precision is recorded");
        }
        // 식별자 인자(METADATA_ID=TRUE)와 일반 인자(FALSE)의 비교 규칙이다.
        {
            using hwdbodbc::catalog_identifier_equals;
            using hwdbodbc::catalog_ordinary_match;
            check(catalog_identifier_equals("Q9_PARENT", "q9_parent"), "unquoted identifier folds to upper case");
            check(catalog_identifier_equals("Q9_PARENT", "Q9_PARENT   "), "trailing spaces are ignored");
            check(!catalog_identifier_equals("Q9_PARENT", "Q9%"), "percent is literal in identifier mode");
            check(catalog_identifier_equals("lower", "\"lower\""), "quoted identifier keeps case");
            check(!catalog_identifier_equals("LOWER", "\"lower\""), "quoted identifier is case sensitive");
            check(!catalog_identifier_equals("lower", "lower"), "unquoted lower case does not match a lower case name");
            check(catalog_identifier_equals("a\"b", "\"a\"\"b\""), "doubled quote inside a quoted identifier");
            check(catalog_identifier_equals("Q9 Mixed$Name", "\"Q9 Mixed$Name\""), "special characters inside quotes");
            // 일반 인자는 패턴이 아니다. _ 가 다른 글자와 맞아서는 안 된다.
            check(catalog_ordinary_match("ORDER_ITEMS", "ORDER_ITEMS", false), "ordinary exact match");
            check(!catalog_ordinary_match("ORDERXITEMS", "ORDER_ITEMS", false), "underscore is not a wildcard for an ordinary argument");
            check(!catalog_ordinary_match("ORDER_ITEMS", "ORDER%", false), "percent is not a wildcard for an ordinary argument");
            check(!catalog_ordinary_match("ORDER_ITEMS", "order_items", false), "ordinary argument is case sensitive");
            check(catalog_ordinary_match("ORDER_ITEMS", "order_items", true), "identifier mode folds an ordinary argument");
        }
        std::cout << "catalog helpers PASS\n";
    });
}
