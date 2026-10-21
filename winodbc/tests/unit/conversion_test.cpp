#include "hwdbodbc/types.hpp"
#include "../helpers/check.hpp"
#include <cstring>

using namespace hwdbodbc;
template<class F> void rejects(F&& operation, const char* state) {
    try { operation(); check(false, "expected conversion error"); }
    catch (const DriverError& error) { check(error.state == state, "conversion SQLSTATE"); }
}
SqlType type(const char* name) {
    Json metadata{{"name", "V"}, {"declared", name}, {"typeName", name}};
    if (std::string(name) == "VARCHAR") metadata["length"] = 65535;
    if (std::string(name) == "VARBINARY") metadata["length"] = 100;
    if (std::string(name) == "DECIMAL") { metadata["precision"] = 38; metadata["scale"] = 6; }
    if (std::string(name).find("TIME") == 0) metadata["fractionalPrecision"] = 6;
    return sql_type(metadata);
}
int main() {
    return run_checks([] {
        Diagnostic diagnostic;
        const auto varchar = type("VARCHAR"), bigint = type("BIGINT"), numeric = type("DECIMAL");
        check(varchar.size == 65535 && varchar.octets == 262140, "code points differ from UTF16 octet capacity");
        struct { SQLBIGINT value = 0; SQLBIGINT canary = 123456; } signed_value;
        SQLLEN length = 0;
        check(convert_value("-9223372036854775808", bigint, SQL_C_SBIGINT, &signed_value.value, 0, &length, diagnostic) == SQL_SUCCESS
            && signed_value.value == (std::numeric_limits<SQLBIGINT>::min)() && signed_value.canary == 123456 && length == 8, "BIGINT minimum and fixed C width");
        rejects([&] { convert_value("9223372036854775808", bigint, SQL_C_SBIGINT, &signed_value.value, 8, &length, diagnostic); }, "22003");
        SQLUBIGINT unsigned_value = 0;
        check(convert_value("18446744073709551615", numeric, SQL_C_UBIGINT, &unsigned_value, 0, &length, diagnostic) == SQL_SUCCESS
            && unsigned_value == (std::numeric_limits<SQLUBIGINT>::max)(), "unsigned 64 bit exact conversion");
        rejects([&] { convert_value("-1", numeric, SQL_C_UBIGINT, &unsigned_value, 0, &length, diagnostic); }, "22003");
        check(convert_value("-12.9", numeric, SQL_C_SBIGINT, &signed_value.value, 0, &length, diagnostic) == SQL_SUCCESS_WITH_INFO && signed_value.value == -12, "integer fractional truncation");
        check(convert_value("  +12  ", varchar, SQL_C_SBIGINT, &signed_value.value, 0, &length, diagnostic) == SQL_SUCCESS && signed_value.value == 12, "padded numeric character conversion");
        float floating = 0;
        rejects([&] { convert_value("1e-100", varchar, SQL_C_FLOAT, &floating, 0, &length, diagnostic); }, "22003");
        unsigned char bit = 0;
        rejects([&] { convert_value("-0.5", numeric, SQL_C_BIT, &bit, 0, &length, diagnostic); }, "22003");
        bool truncated = false;
        const auto full = numeric_struct("-99999999999999999999999999999999.123456", 38, 6, truncated);
        check(!truncated && numeric_text(full) == "-99999999999999999999999999999999.123456", "exact 38 digit signed numeric");
        check(numeric_text(numeric_struct("0.00000000000000000000000000000000000001", 38, 38, truncated))
            == "0.00000000000000000000000000000000000001", "scale 38 exact numeric");
        check(numeric_text(numeric_struct("-0.000", 38, 3, truncated)) == "0.000", "numeric negative zero normalized");
        check(numeric_text(numeric_struct("12345", 38, -2, truncated)) == "12300" && truncated, "negative output scale");
        rejects([&] { numeric_struct("999999999999999999999999999999999999999", 38, 0, truncated); }, "22003");
        rejects([&] { numeric_struct("one", 38, 0, truncated); }, "22018");
        SQL_NUMERIC_STRUCT output_numeric{};
        check(convert_value("123.456", numeric, SQL_C_NUMERIC, &output_numeric, 1, &length, diagnostic) == SQL_SUCCESS_WITH_INFO
            && numeric_text(output_numeric) == "123" && output_numeric.precision == 38 && output_numeric.scale == 0, "SQL_C_NUMERIC default precision/scale");
        ConversionSpec specification; specification.scale = 6;
        check(convert_value("123.456", numeric, SQL_C_NUMERIC, &output_numeric, 1, &length, diagnostic, nullptr, specification) == SQL_SUCCESS
            && numeric_text(output_numeric) == "123.456000", "descriptor numeric scale");
        SQLWCHAR numeric_text_buffer[5]{};
        rejects([&] { convert_value("123.456", numeric, SQL_C_WCHAR, numeric_text_buffer, 6, &length, diagnostic); }, "22003");
        check(convert_value("123.456", numeric, SQL_C_WCHAR, numeric_text_buffer, 8, &length, diagnostic) == SQL_SUCCESS_WITH_INFO
            && std::wstring(reinterpret_cast<wchar_t*>(numeric_text_buffer)) == L"123", "only fractional numeric text may truncate");
        const std::string source = "가😀나";
        DataStream stream;
        struct { SQLWCHAR data[3]{}; SQLWCHAR canary = 0x5a5a; } wide;
        std::wstring reconstructed;
        check(convert_value(source, varchar, SQL_C_WCHAR, wide.data, 6, &length, diagnostic, &stream) == SQL_SUCCESS_WITH_INFO && length == 8
            && wide.data[0] == L'가' && wide.data[1] == 0 && wide.canary == 0x5a5a, "partial W retrieval preserves surrogate boundary");
        reconstructed += reinterpret_cast<wchar_t*>(wide.data);
        check(convert_value(source, varchar, SQL_C_WCHAR, wide.data, 6, &length, diagnostic, &stream) == SQL_SUCCESS_WITH_INFO && length == 6, "remaining byte length before current chunk");
        reconstructed += reinterpret_cast<wchar_t*>(wide.data);
        check(convert_value(source, varchar, SQL_C_WCHAR, wide.data, 6, &length, diagnostic, &stream) == SQL_SUCCESS && length == 2, "last partial chunk");
        reconstructed += reinterpret_cast<wchar_t*>(wide.data);
        check(utf8(reconstructed) == source, "reconstructed Unicode");
        length = -99;
        check(convert_value(source, varchar, SQL_C_WCHAR, wide.data, 6, &length, diagnostic, &stream) == SQL_NO_DATA && length == -99, "after last chunk no data/unchanged indicator");
        unsigned char bytes[2]{255,255};
        stream = {};
        check(convert_value("0001FF", type("VARBINARY"), SQL_C_BINARY, bytes, 2, &length, diagnostic, &stream) == SQL_SUCCESS_WITH_INFO
            && length == 3 && bytes[0] == 0 && bytes[1] == 1, "binary embedded zero");
        check(convert_value("0001FF", type("VARBINARY"), SQL_C_BINARY, bytes, 2, &length, diagnostic, &stream) == SQL_SUCCESS && length == 1 && bytes[0] == 255, "binary final chunk");
        stream = {};
        check(convert_value("", varchar, SQL_C_WCHAR, wide.data, 6, &length, diagnostic, &stream) == SQL_SUCCESS && length == 0 && wide.data[0] == 0, "empty string distinct from NULL");
        check(convert_value(nullptr, varchar, SQL_C_WCHAR, wide.data, 6, &length, diagnostic) == SQL_SUCCESS && length == SQL_NULL_DATA, "NULL indicator");
        rejects([&] { convert_value(nullptr, varchar, SQL_C_WCHAR, wide.data, 6, nullptr, diagnostic); }, "22002");
        rejects([&] { convert_value(source, varchar, 30000, wide.data, 6, &length, diagnostic); }, "HY003");
        SQL_TIMESTAMP_STRUCT timestamp{};
        check(convert_value("2024-02-29 23:59:59.123456", type("TIMESTAMP"), SQL_C_TYPE_TIMESTAMP,
            &timestamp, 0, &length, diagnostic) == SQL_SUCCESS && timestamp.year == 2024 && timestamp.fraction == 123456000, "timestamp microseconds to nanoseconds");
        rejects([&] { convert_value("2023-02-29", type("DATE"), SQL_C_TYPE_TIMESTAMP, &timestamp, 0, &length, diagnostic); }, "22007");
        SQL_TIME_STRUCT time{};
        check(convert_value("12:34:56.123456", type("TIME"), SQL_C_TYPE_TIME, &time, 0, &length, diagnostic) == SQL_SUCCESS_WITH_INFO
            && time.hour == 12 && time.second == 56, "TIME_STRUCT fractional warning");
        check(convert_value("12:34:56.123456", type("TIME"), SQL_C_TYPE_TIMESTAMP, &timestamp, 0, &length, diagnostic) == SQL_SUCCESS
            && timestamp.year > 0 && timestamp.hour == 12 && timestamp.fraction == 123456000, "time to timestamp current date");
        auto interval_type = sql_type({{"name","IV"},{"typeName","INTERVAL"},{"declared","INTERVAL DAY(3) TO SECOND(6)"},
            {"startField","DAY"},{"endField","SECOND"},{"leadingPrecision",3},{"fractionalPrecision",6}});
        SQL_INTERVAL_STRUCT interval{};
        check(convert_value("-12 03:04:05.123456", interval_type, SQL_C_INTERVAL_DAY_TO_SECOND,
            &interval, 0, &length, diagnostic) == SQL_SUCCESS && interval.interval_sign == SQL_TRUE
            && interval.intval.day_second.day == 12 && interval.intval.day_second.fraction == 123456000, "interval structure");
        rejects([&] { convert_value("123 03:04:05.123456", interval_type, SQL_C_INTERVAL_DAY_TO_SECOND, &interval, 0, &length, diagnostic); }, "22015");
    });
}
