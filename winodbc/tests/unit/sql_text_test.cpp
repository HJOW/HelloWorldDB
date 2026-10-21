#include "hwdbodbc/sql_text.hpp"
#include "../helpers/check.hpp"

using namespace hwdbodbc;
template<class F> void rejects(F&& operation, const char* state) {
    try { operation(); check(false, "expected escape translation error"); }
    catch (const DriverError& error) { check(error.state == state, "escape SQLSTATE"); }
}
int main() {
    return run_checks([] {
        check(native_sql("SELECT {d '2026-10-21'}, {t '12:34:56'}, {ts '2026-10-21 12:34:56.123456'}")
            == "SELECT DATE '2026-10-21', TIME '12:34:56', TIMESTAMP '2026-10-21 12:34:56.123456'", "date/time escapes");
        check(native_sql("SELECT {fn CONCAT({fn UCASE(?)}, '}?')} -- {d '?'}\n/* ? { } */")
            == "SELECT CONCAT(UPPER(?), '}?') -- {d '?'}\n/* ? { } */", "nested escapes and comments");
        check(native_sql("SELECT {fn CONVERT({fn IFNULL(?, 0)}, SQL_INTEGER)}")
            == "SELECT CAST(COALESCE(?, 0) AS INTEGER)", "CONVERT to CAST without execution");
        check(native_sql("SELECT {fn YEAR({d '2026-10-21'})}, {fn NOW()}")
            == "SELECT EXTRACT(YEAR FROM DATE '2026-10-21'), CURRENT_TIMESTAMP", "date extraction/current timestamp");
        check(native_sql("SELECT * FROM {oj A LEFT OUTER JOIN B ON A.ID=B.ID} WHERE A.S LIKE 'a!_%' {escape '!'}")
            == "SELECT * FROM A LEFT OUTER JOIN B ON A.ID=B.ID WHERE A.S LIKE 'a!_%' ESCAPE '!'", "outer join/LIKE escapes");
        check(native_sql("SELECT {fn UCASE('a''{?}b')}, \"?\"") == "SELECT UPPER('a''{?}b'), \"?\"", "quoted braces/questions");
        check(parameter_count("SELECT ?, '?' AS \"?\", 'a''?b', ? -- ?\n/* ? */") == 2, "parameter lexer opaque regions");
        rejects([] { native_sql("SELECT {call P()}"); }, "HYC00");
        rejects([] { native_sql("SELECT {fn UNKNOWN(?)}"); }, "HYC00");
        rejects([] { native_sql("SELECT {fn CONVERT(?, SQL_ARRAY)}"); }, "HYC00");
        rejects([] { native_sql("SELECT {d '2026-10-21'"); }, "42000");
        rejects([] { native_sql("SELECT {fn ABS(1))}"); }, "42000");
        rejects([] { native_sql("SELECT 1 }"); }, "42000");
    });
}
