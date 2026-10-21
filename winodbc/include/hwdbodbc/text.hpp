#pragma once
#include "hwdbodbc/odbc.hpp"
#include <algorithm>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>

namespace hwdbodbc {
class DriverError : public std::runtime_error {
public:
    std::string state;
    SQLINTEGER native;
    DriverError(const char* code, const char* message, SQLINTEGER number = 0)
        : std::runtime_error(message), state(code), native(number) {}
};

std::wstring utf16(std::string_view input);
std::string utf8(std::wstring_view input);
std::wstring decode_ansi(std::string_view input, UINT page = CP_ACP);
std::string encode_ansi(std::wstring_view input, UINT page = CP_ACP);

template<class Character>
std::string input_text(const Character* value, SQLLEN length) {
    if (length < 0 && length != SQL_NTS) throw DriverError("HY090", "Invalid string length.");
    if (!value) throw DriverError("HY009", "Invalid use of null pointer.");
    const auto count = length == SQL_NTS ? std::char_traits<Character>::length(value)
        : static_cast<std::size_t>(length);
    if (count > static_cast<std::size_t>((std::numeric_limits<int>::max)()))
        throw DriverError("HY090", "String length exceeds the supported range.");
    if constexpr (sizeof(Character) == 2)
        return utf8(std::wstring_view(reinterpret_cast<const wchar_t*>(value), count));
    else
        return utf8(decode_ansi(std::string_view(reinterpret_cast<const char*>(value), count)));
}

enum class LengthUnit { code_units, bytes };

// 인자별 길이 단위를 호출자가 지정한다. 출력 데이터는 항상 NUL로 끝낸다.
template<class Character, class Length>
SQLRETURN output_text(std::string_view value, Character* output, SQLLEN capacity,
    Length* needed, LengthUnit unit = LengthUnit::code_units) {
    if (capacity < 0) throw DriverError("HY090", "Invalid buffer length.");
    const auto wide = utf16(value);
    std::basic_string<Character> encoded;
    if constexpr (sizeof(Character) == 2)
        encoded.assign(reinterpret_cast<const Character*>(wide.data()), wide.size());
    else {
        const auto narrow = encode_ansi(wide);
        encoded.assign(reinterpret_cast<const Character*>(narrow.data()), narrow.size());
    }
    const auto multiplier = unit == LengthUnit::bytes ? sizeof(Character) : 1;
    const auto size = encoded.size() * multiplier;
    if (needed) *needed = static_cast<Length>((std::min)(size,
        static_cast<std::size_t>((std::numeric_limits<Length>::max)())));
    if (!output) return SQL_SUCCESS;
    const auto units = static_cast<std::size_t>(capacity) / multiplier;
    if (units == 0) return encoded.empty() ? SQL_SUCCESS : SQL_SUCCESS_WITH_INFO;
    auto copied = (std::min)(encoded.size(), units - 1);
    if constexpr (sizeof(Character) == 2) {
        // 잘린 출력의 마지막 코드 단위를 단독 high surrogate로 만들지 않는다.
        if (copied < encoded.size() && copied && encoded[copied - 1] >= 0xd800 && encoded[copied - 1] <= 0xdbff)
            --copied;
    } else if (copied < encoded.size()) {
        // ACP의 다중 바이트 문자를 중간에서 자르지 않는다.
        const char* begin = reinterpret_cast<const char*>(encoded.data());
        std::size_t offset = 0;
        while (offset < copied) {
            const auto next = static_cast<std::size_t>(CharNextExA(CP_ACP, begin + offset, 0) - begin);
            if (next > copied) { copied = offset; break; }
            offset = next;
        }
    }
    std::copy_n(encoded.data(), copied, output);
    output[copied] = 0;
    return copied < encoded.size() ? SQL_SUCCESS_WITH_INFO : SQL_SUCCESS;
}
} // namespace hwdbodbc
