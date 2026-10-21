#pragma once
#include "hwdbodbc/handles.hpp"

namespace hwdbodbc {
SqlType parameter_type(SQLSMALLINT type, SQLULEN size, SQLSMALLINT scale, SQLINTEGER leading_precision = 2);
Json parameter_value(const DescriptorRecord& application, const SqlType& target, Diagnostic& diagnostic,
    SQLULEN offset = 0, SQLINTEGER number = SQL_COLUMN_NUMBER_UNKNOWN);
}
