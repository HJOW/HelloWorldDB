#include "hwdbodbc/text.hpp"
#include "../helpers/check.hpp"
#include <array>

using namespace hwdbodbc;
template<class F> void rejects(F&& f, const char* state) {
    try { f(); check(false, "expected text conversion error"); }
    catch (const DriverError& error) { check(error.state == state, "text error state"); }
}
int main() {
    return run_checks([] {
        const std::string value = "한글😀";
        const auto wide = utf16(value);
        check(wide.size() == 4 && utf8(wide) == value, "Korean/emoji round trip");
        const std::wstring embedded(L"가\0나", 3);
        check(utf16(utf8(embedded)) == embedded, "embedded NUL preserved");
        check(input_text(reinterpret_cast<const SQLWCHAR*>(embedded.data()), 3) == utf8(embedded), "explicit length");
        check(input_text(reinterpret_cast<const SQLWCHAR*>(embedded.data()), SQL_NTS) == "가", "NTS stops at NUL");
        rejects([] { utf16(std::string("\xc0\xaf", 2)); }, "22021");
        rejects([] { utf16(std::string("\xed\xa0\x80", 3)); }, "22021");
        rejects([] { utf16(std::string("\xf4\x90\x80\x80", 4)); }, "22021");
        rejects([] { utf8(std::wstring(1, 0xd800)); }, "22021");
        rejects([] { utf8(std::wstring(1, 0xdc00)); }, "22021");
        rejects([] { input_text<SQLWCHAR>(nullptr, 0); }, "HY009");
        SQLWCHAR empty = 0;
        rejects([&] { input_text(&empty, -2); }, "HY090");
        struct { SQLWCHAR data[5]{}; SQLWCHAR canary = 0x5a5a; } output;
        SQLSMALLINT length = -1;
        check(output_text(value, output.data, 5, &length) == SQL_SUCCESS && length == 4, "W code unit length");
        check(output.canary == 0x5a5a && output.data[4] == 0, "W exact buffer/canary");
        check(output_text(value, output.data, 10, &length, LengthUnit::bytes) == SQL_SUCCESS && length == 8, "W byte length");
        check(output_text(value, output.data, 4, &length) == SQL_SUCCESS_WITH_INFO, "short emoji output");
        check(output.data[2] == 0 && output.canary == 0x5a5a, "no lone surrogate at output boundary");
        output.data[0] = 0x5a5a;
        check(output_text(value, output.data, 0, &length) == SQL_SUCCESS_WITH_INFO && output.data[0] == 0x5a5a, "zero buffer untouched");
        check(output_text<SQLWCHAR>(value, nullptr, 0, &length) == SQL_SUCCESS && length == 4, "length only");
        check(output_text(value, output.data, 9, &length, LengthUnit::bytes) == SQL_SUCCESS_WITH_INFO, "odd byte capacity rounds down");
        rejects([&] { output_text(value, output.data, -1, &length); }, "HY090");
        check(encode_ansi(L"café", 1252) == std::string("caf\xe9", 4), "explicit Windows code page");
        check(decode_ansi(std::string("caf\xe9", 4), 1252) == L"café", "ANSI inverse");
        rejects([] { encode_ansi(L"한😀", 1252); }, "22018");
        rejects([] { decode_ansi(std::string("\x81", 1), 932); }, "22018");
        check(encode_ansi(wide, CP_UTF8) == value && decode_ansi(value, CP_UTF8) == wide, "UTF8 system code page");
    });
}
