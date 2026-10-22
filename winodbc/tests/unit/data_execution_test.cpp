#include "hwdbodbc/statement.hpp"
#include "hwdbodbc/parameters.hpp"
#include "../helpers/check.hpp"
#include <cstring>

using namespace hwdbodbc;
template<class Function> void rejects(Function function, const char* state) {
    try { function(); check(false,"expected data input error"); }
    catch (const DriverError& error) {
        if (error.state != state) std::cerr << error.state << " != " << state << '\n';
        check(error.state == state,"data input SQLSTATE");
    }
}
int main() {
    return run_checks([] {
        Statement statement;
        rejects([&] { put_parameter_data(statement,nullptr,0); },"HY010");
        const auto begin = [&](SQLSMALLINT ctype, SQLSMALLINT sqltype, SQLULEN size) {
            statement.parameter_execution = std::make_unique<ParameterExecution>();
            auto& execution = *statement.parameter_execution;
            execution.pending = true; execution.requested = true;
            execution.binding.type = ctype; execution.target = parameter_type(sqltype,size,0);
        };
        begin(SQL_C_SLONG,SQL_INTEGER,10);
        SQLINTEGER number = 12345;
        check(put_parameter_data(statement,&number,1) == SQL_SUCCESS,"fixed input ignores supplied length");
        check(statement.parameter_execution->input.size() == sizeof(number) && !std::memcmp(statement.parameter_execution->input.data(),&number,sizeof(number)),"fixed input SDK width");
        rejects([&] { put_parameter_data(statement,&number,sizeof(number)); },"HY019");
        begin(SQL_C_WCHAR,SQL_WVARCHAR,3);
        wchar_t unicode[] = L"한😀";
        check(put_parameter_data(statement,unicode,4) == SQL_SUCCESS && put_parameter_data(statement,unicode + 2,2) == SQL_SUCCESS,"surrogate split accepted until final conversion");
        auto& execution = *statement.parameter_execution;
        auto binding = execution.binding; SQLLEN length = static_cast<SQLLEN>(execution.input.size());
        binding.data = execution.input.data(); binding.indicator = &length; binding.octet_length_pointer = &length;
        Diagnostic diagnostic;
        check(parameter_value(binding,execution.target,diagnostic) == "한😀","strict final Unicode reconstruction");
        rejects([&] { put_parameter_data(statement,unicode,1); },"HY090");
        begin(SQL_C_BINARY,SQL_VARBINARY,2);
        unsigned char bytes[] = {0,255,0};
        rejects([&] { put_parameter_data(statement,bytes,3); },"22001");
        check(statement.parameter_execution->input.empty(),"overflow does not modify input");
        rejects([&] { put_parameter_data(statement,bytes,SQL_NTS); },"HY090");
        rejects([&] { put_parameter_data(statement,nullptr,1); },"HY009");
        rejects([&] { put_parameter_data(statement,bytes,-7); },"HY090");
        rejects([&] { put_parameter_data(statement,nullptr,SQL_DEFAULT_PARAM); },"07S01");
        check(put_parameter_data(statement,nullptr,SQL_NULL_DATA) == SQL_SUCCESS,"NULL input");
        rejects([&] { put_parameter_data(statement,bytes,0); },"HY020");
        begin(SQL_C_CHAR,SQL_VARCHAR,65535);
        auto& limited = *statement.parameter_execution;
        limited.expected = 2;
        rejects([&] { put_parameter_data(statement,bytes,3); },"22001");
        limited.expected = -1; limited.bytes = 16U * 1024U * 1024U;
        rejects([&] { put_parameter_data(statement,bytes,1); },"22001");
        limited.bytes = 0;
        rejects([&] { put_parameter_data(statement,reinterpret_cast<SQLPOINTER>(1),16U * 1024U * 1024U + 1); },"22001");
        limited.requested = false;
        rejects([&] { put_parameter_data(statement,bytes,0); },"HY010");
    });
}
