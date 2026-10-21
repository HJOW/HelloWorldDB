#pragma once
#include "hwdbodbc/connection.hpp"

namespace hwdbodbc {
Connection& statement_connection(Statement& statement);
void close_statement_cursor(Statement& statement);
void finish_statement_result(Statement& statement);
void accept_result(Statement& statement, const Json& response);
void release_statement(Statement& statement);
void release_prepared(Statement& statement);
void prepare_statement(Statement& statement, const std::string& sql);
void describe_prepared(Statement& statement);
SQLRETURN execute_prepared(Statement& statement);
SQLRETURN fetch_rows(Statement& statement);
SQLRETURN get_statement_attribute(Statement& statement, SQLINTEGER attribute, SQLPOINTER output, SQLINTEGER* length);
}
