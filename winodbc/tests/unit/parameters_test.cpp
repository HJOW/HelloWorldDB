#include "hwdbodbc/parameters.hpp"
#include "../helpers/check.hpp"
#include <cstring>

using namespace hwdbodbc;
template<class F> void rejects(F&& operation, const char* state) {
    try { operation(); check(false, "expected parameter error"); }
    catch (const DriverError& error) { check(error.state == state, "parameter SQLSTATE"); }
}
int main() {
    return run_checks([] {
        Diagnostic diagnostic;
        DescriptorRecord binding; binding.bound = true; SQLLEN length = SQL_NTS; binding.indicator = &length;
        SQLBIGINT integer = (std::numeric_limits<SQLBIGINT>::max)(); binding.type = SQL_C_SBIGINT; binding.data = &integer;
        check(parameter_value(binding, parameter_type(SQL_BIGINT, 19, 0), diagnostic) == "9223372036854775807", "BIGINT exact string");
        integer = 7; check(parameter_value(binding, parameter_type(SQL_INTEGER, 10, 0), diagnostic) == 7, "read buffer at each execution");
        integer = 2147483648LL; rejects([&] { parameter_value(binding, parameter_type(SQL_INTEGER, 10, 0), diagnostic); }, "22003");
        wchar_t wide[] = L"한😀\0끝"; binding.type = SQL_C_WCHAR; binding.data = wide; length = sizeof(wide) - 2;
        check(parameter_value(binding, parameter_type(SQL_WVARCHAR, 5, 0), diagnostic) == std::string("한😀\0끝", 11), "WCHAR bytes and embedded NUL");
        rejects([&] { parameter_value(binding, parameter_type(SQL_WVARCHAR, 3, 0), diagnostic); }, "22001");
        length = 3; rejects([&] { parameter_value(binding, parameter_type(SQL_WVARCHAR, 5, 0), diagnostic); }, "HY090");
        unsigned char bytes[] = {0,255,0,1}; binding.type = SQL_C_BINARY; binding.data = bytes; length = 4;
        check(parameter_value(binding, parameter_type(SQL_VARBINARY, 4, 0), diagnostic) == Json{{"binary","00FF0001"}}, "binary wire object");
        check(parameter_value(binding, parameter_type(SQL_BINARY, 6, 0), diagnostic) == Json{{"binary","00FF00010000"}}, "fixed binary padding");
        binding.type = SQL_C_DEFAULT; binding.indicator = nullptr; binding.capacity = 4;
        check(parameter_value(binding, parameter_type(SQL_VARBINARY, 4, 0), diagnostic) == Json{{"binary","00FF0001"}}, "default binary C type and absent indicator");
        binding.type = SQL_C_BINARY; binding.indicator = &length;
        length = 0; check(parameter_value(binding, parameter_type(SQL_VARBINARY, 4, 0), diagnostic) == Json{{"binary",""}}, "empty binary");
        length = SQL_NULL_DATA; binding.data = nullptr; check(parameter_value(binding, parameter_type(SQL_INTEGER, 10, 0), diagnostic).is_null(), "NULL does not read data");
        length = SQL_DEFAULT_PARAM; rejects([&] { parameter_value(binding, parameter_type(SQL_INTEGER, 10, 0), diagnostic); }, "07S01");
        char decimal[] = "99999999999999999999999999999999.123456"; binding.type = SQL_C_CHAR; binding.data = decimal; length = SQL_NTS;
        check(parameter_value(binding, parameter_type(SQL_DECIMAL, 38, 6), diagnostic) == decimal, "38 digit decimal no double");
        char fraction[] = "123.456"; binding.data = fraction; diagnostic.clear();
        rejects([&] { parameter_value(binding, parameter_type(SQL_NUMERIC, 8, 2), diagnostic); }, "22001");
        check(diagnostic.size() == 0, "character precision error does not leave a getter warning");
        char overflow[] = "2147483648"; binding.data = overflow;
        rejects([&] { parameter_value(binding, parameter_type(SQL_INTEGER, 10, 0), diagnostic); }, "22001");
        char hex_text[] = "00ffA"; binding.data = hex_text;
        check(parameter_value(binding,parameter_type(SQL_VARBINARY,4,0),diagnostic) == Json{{"binary","00FF"}}, "character to binary hex pairs and odd final byte");
        char invalid_hex[] = "0G"; binding.data = invalid_hex;
        rejects([&] { parameter_value(binding,parameter_type(SQL_VARBINARY,4,0),diagnostic); },"22018");
        SQL_TIMESTAMP_STRUCT stamp{2026,10,21,12,34,56,123456789}; binding.type = SQL_C_TYPE_TIMESTAMP; binding.data = &stamp; diagnostic.clear();
        rejects([&] { parameter_value(binding,parameter_type(SQL_TYPE_TIMESTAMP,26,6),diagnostic); }, "22008");
        stamp.fraction = 123456000;
        check(parameter_value(binding, parameter_type(SQL_TYPE_TIMESTAMP, 26, 6), diagnostic) == "2026-10-21 12:34:56.123456" && diagnostic.size() == 0, "timestamp precision preserved");
        rejects([&] { parameter_value(binding,parameter_type(SQL_TYPE_DATE,10,0),diagnostic); }, "22008");
        stamp.month = 13; rejects([&] { parameter_value(binding, parameter_type(SQL_TYPE_TIMESTAMP, 26, 6), diagnostic); }, "22007");
        SQL_INTERVAL_STRUCT interval{}; interval.interval_type = SQL_IS_DAY_TO_SECOND; interval.interval_sign = SQL_TRUE;
        interval.intval.day_second = {12,3,4,5,123456000}; binding.type = SQL_C_INTERVAL_DAY_TO_SECOND; binding.data = &interval; diagnostic.clear();
        check(parameter_value(binding, parameter_type(SQL_INTERVAL_DAY_TO_SECOND, 0, 6), diagnostic) == "-12 3:4:5.123456", "native interval wire string");
        rejects([&] { parameter_type(SQL_DECIMAL, 39, 0); }, "HY104");
        rejects([&] { parameter_type(SQL_TYPE_TIMESTAMP, 26, 7); }, "HY104");
        rejects([&] { parameter_type(SQL_GUID, 0, 0); }, "HYC00");
        rejects([&] { parameter_type(-32760, 0, 0); }, "HY004");
        struct UnsignedInput { SQLUBIGINT value; } unsigned_input{18446744073709551615ULL};
        binding.type = SQL_C_UBIGINT; binding.data = &unsigned_input.value; length = 0;
        check(parameter_value(binding, parameter_type(SQL_DECIMAL, 20, 0), diagnostic) == "18446744073709551615", "unsigned 64 bit exact input");
        rejects([&] { parameter_value(binding, parameter_type(SQL_BIGINT, 19, 0), diagnostic); }, "22003");
        bool truncated = false; auto numeric = numeric_struct("-12345678901234567890123456789012.345678",38,6,truncated);
        binding.type = SQL_C_NUMERIC; binding.data = &numeric;
        check(parameter_value(binding, parameter_type(SQL_DECIMAL,38,6),diagnostic) == "-12345678901234567890123456789012.345678", "native numeric exact input");
        SQL_DATE_STRUCT date{1,1,1}; binding.type = SQL_C_TYPE_DATE; binding.data = &date;
        check(parameter_value(binding,parameter_type(SQL_TYPE_DATE,10,0),diagnostic) == "0001-01-01", "date boundary input");
        SQL_TIME_STRUCT time{23,59,59}; binding.type = SQL_C_TYPE_TIME; binding.data = &time;
        check(parameter_value(binding,parameter_type(SQL_TYPE_TIME,8,0),diagnostic) == "23:59:59", "native time input");
        unsigned char bit = 1; binding.type = SQL_C_BIT; binding.data = &bit;
        check(parameter_value(binding,parameter_type(SQL_BIT,1,0),diagnostic) == true, "boolean wire value");
        bit = 2; rejects([&] { parameter_value(binding,parameter_type(SQL_BIT,1,0),diagnostic); },"22003");
        double floating = 1.23456789012345; binding.type = SQL_C_DOUBLE; binding.data = &floating;
        check(parameter_value(binding,parameter_type(SQL_DOUBLE,15,0),diagnostic) == floating,"double wire value");
        floating = (std::numeric_limits<double>::infinity)(); rejects([&] { parameter_value(binding,parameter_type(SQL_DOUBLE,15,0),diagnostic); },"22003");
        floating = 123.456; diagnostic.clear();
        check(parameter_value(binding,parameter_type(SQL_DECIMAL,8,2),diagnostic) == "123.45" && diagnostic.size() == 1,"native numeric fractional truncation may warn");
        floating = 0.5; rejects([&] { parameter_value(binding,parameter_type(SQL_BIT,1,0),diagnostic); },"22001");
        binding.type = SQL_C_CHAR; char invalid_date[] = "2026-13-01"; binding.data = invalid_date; length = SQL_NTS;
        rejects([&] { parameter_value(binding,parameter_type(SQL_TYPE_DATE,10,0),diagnostic); },"22018");
        unsigned char unaligned[sizeof(SQLINTEGER) + 1]{}; SQLINTEGER unaligned_value = -123;
        std::memcpy(unaligned + 1,&unaligned_value,sizeof(unaligned_value)); binding.type = SQL_C_SLONG; binding.data = unaligned; binding.indicator = nullptr;
        check(parameter_value(binding,parameter_type(SQL_INTEGER,10,0),diagnostic,1) == -123,"unaligned input and binding offset");
        rejects([&] { parameter_value(binding,parameter_type(SQL_INTEGER,10,0),diagnostic,(std::numeric_limits<SQLULEN>::max)()); },"HY090");
    });
}
