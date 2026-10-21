#include "hwdbodbc/text.hpp"

namespace hwdbodbc {
namespace {
int text_size(std::size_t size) {
    if (size > static_cast<std::size_t>((std::numeric_limits<int>::max)()))
        throw DriverError("HY090", "String length exceeds the supported range.");
    return static_cast<int>(size);
}
void validate_utf16(std::wstring_view input) {
    for (std::size_t i = 0; i < input.size(); ++i) {
        const auto value = input[i];
        if (value >= 0xd800 && value <= 0xdbff) {
            if (++i == input.size() || input[i] < 0xdc00 || input[i] > 0xdfff)
                throw DriverError("22021", "Invalid UTF-16 sequence.");
        } else if (value >= 0xdc00 && value <= 0xdfff)
            throw DriverError("22021", "Invalid UTF-16 sequence.");
    }
}
}

std::wstring utf16(std::string_view input) {
    if (input.empty()) return {};
    const auto size = text_size(input.size());
    const auto count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(), size, nullptr, 0);
    if (!count) throw DriverError("22021", "Invalid UTF-8 sequence.");
    std::wstring result(static_cast<std::size_t>(count), 0);
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(), size, result.data(), count))
        throw DriverError("22021", "Invalid UTF-8 sequence.");
    return result;
}

std::string utf8(std::wstring_view input) {
    validate_utf16(input);
    if (input.empty()) return {};
    const auto size = text_size(input.size());
    const auto count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, input.data(), size, nullptr, 0, nullptr, nullptr);
    if (!count) throw DriverError("22021", "Invalid UTF-16 sequence.");
    std::string result(static_cast<std::size_t>(count), 0);
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, input.data(), size, result.data(), count, nullptr, nullptr))
        throw DriverError("22021", "Invalid UTF-16 sequence.");
    return result;
}

std::wstring decode_ansi(std::string_view input, UINT page) {
    if (page == CP_UTF8 || (page == CP_ACP && GetACP() == CP_UTF8)) return utf16(input);
    if (input.empty()) return {};
    const auto size = text_size(input.size());
    const auto count = MultiByteToWideChar(page, MB_ERR_INVALID_CHARS, input.data(), size, nullptr, 0);
    if (!count) throw DriverError("22018", "Invalid ANSI character sequence.");
    std::wstring result(static_cast<std::size_t>(count), 0);
    if (!MultiByteToWideChar(page, MB_ERR_INVALID_CHARS, input.data(), size, result.data(), count))
        throw DriverError("22018", "Invalid ANSI character sequence.");
    // ACP 왕복에서 원문이 바뀌는 암묵적 문자 대체도 거부한다.
    if (encode_ansi(result, page) != input) throw DriverError("22018", "ANSI conversion is not reversible.");
    return result;
}

std::string encode_ansi(std::wstring_view input, UINT page) {
    validate_utf16(input);
    if (page == CP_UTF8 || (page == CP_ACP && GetACP() == CP_UTF8)) return utf8(input);
    if (input.empty()) return {};
    const auto size = text_size(input.size());
    BOOL replaced = FALSE;
    const auto count = WideCharToMultiByte(page, WC_NO_BEST_FIT_CHARS, input.data(), size, nullptr, 0, nullptr, &replaced);
    if (!count || replaced) throw DriverError("22018", "Character cannot be represented in the ANSI code page.");
    std::string result(static_cast<std::size_t>(count), 0);
    if (!WideCharToMultiByte(page, WC_NO_BEST_FIT_CHARS, input.data(), size, result.data(), count, nullptr, &replaced) || replaced)
        throw DriverError("22018", "Character cannot be represented in the ANSI code page.");
    return result;
}
} // namespace hwdbodbc
