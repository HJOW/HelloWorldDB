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
        std::cout << "catalog helpers PASS\n";
    });
}
