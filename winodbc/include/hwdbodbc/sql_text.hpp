#pragma once
#include "hwdbodbc/text.hpp"

namespace hwdbodbc {
// 값이나 식을 실행하지 않고 ODBC escape의 문법만 서버 SQL로 바꾼다.
std::string native_sql(std::string_view input);
std::size_t parameter_count(std::string_view input);
}
