#pragma once
#include "hwdbodbc/handles.hpp"
#include "hwdbodbc/protocol.hpp"
#include <map>

namespace hwdbodbc {
using Options = std::map<std::string, std::string>;
Options parse_connection_string(std::string_view text);
std::string connection_string(const Options& options);
unsigned option_integer(const Options& options, const char* name, unsigned fallback, unsigned minimum, unsigned maximum);
bool option_boolean(const Options& options, const char* name, bool fallback);
void open_connection(Connection& connection, Options& options);
}
