#include "hwdbodbc/entry_point.hpp"
#include "../helpers/check.hpp"
#include <cstring>

int main() {
    return run_checks([] {
        using hwdbodbc::entry_point;
        hwdbodbc::Diagnostic diagnostic;
        check(entry_point(&diagnostic, []() -> SQLRETURN { return SQL_SUCCESS_WITH_INFO; })
            == SQL_SUCCESS_WITH_INFO, "return code preserved");
        check(entry_point(&diagnostic, []() -> SQLRETURN { throw std::bad_alloc(); })
            == SQL_ERROR, "bad_alloc escaped");
        check(std::strcmp(diagnostic.state.data(), "HY001") == 0, "bad_alloc state");
        check(entry_point(&diagnostic, []() -> SQLRETURN { throw std::runtime_error("secret"); })
            == SQL_ERROR, "std exception escaped");
        check(std::strcmp(diagnostic.state.data(), "HY000") == 0, "std exception state");
        check(std::strstr(diagnostic.message.data(), "secret") == nullptr, "exception text leaked");
        check(entry_point(&diagnostic, []() -> SQLRETURN { throw 42; }) == SQL_ERROR, "unknown exception escaped");
        check(std::strcmp(diagnostic.state.data(), "HY000") == 0, "unknown exception state");
        check(entry_point(nullptr, []() -> SQLRETURN { throw std::bad_alloc(); }) == SQL_ERROR,
            "allocation failure without a handle");
        diagnostic.clear();
        check(diagnostic.state[0] == 0 && diagnostic.message[0] == 0, "diagnostic clear");
    });
}
