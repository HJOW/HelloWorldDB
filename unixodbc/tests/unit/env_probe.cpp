/**
 * 컴파일 시점의 ABI 사실을 JSON 하나로 출력한다.
 *
 * `scripts/inspect-environment.mjs` 가 이 출력을 environment.json 의 `abi` 에 넣고,
 * `tests/uo0.test.mjs` 가 문서·헤더 계약과 대조한다.
 * 호스트 도구·unixODBC 설치 정보는 Node 스크립트가 모은다.
 */
#include "hwdbodbc/odbc.hpp"

#include <cstddef>
#include <iomanip>
#include <iostream>
#include <string>

#if !defined(SQL_OV_ODBC3_80)
#error "ODBC 3.8 상수(SQL_OV_ODBC3_80)가 없는 헤더이다. unixODBC 2.3 이상이 필요하다."
#endif

namespace {

std::string escape(const std::string &value) {
    std::string result;
    result.reserve(value.size() + 8);
    for (const char ch : value) {
        switch (ch) {
        case '\\': result += "\\\\"; break;
        case '"': result += "\\\""; break;
        case '\n': result += "\\n"; break;
        case '\r': result += "\\r"; break;
        case '\t': result += "\\t"; break;
        default:
            if (static_cast<unsigned char>(ch) < 0x20) {
                result += '?';
            } else {
                result += ch;
            }
            break;
        }
    }
    return result;
}

const char *compilerName() {
#if defined(__clang__)
    return "clang";
#elif defined(__GNUC__)
    return "gcc";
#else
    return "unknown";
#endif
}

bool littleEndian() {
    const unsigned int value = 1;
    return *reinterpret_cast<const unsigned char *>(&value) == 1;
}

} // namespace

int main() {
    std::cout << "{\n";
    std::cout << "  \"schemaVersion\": 1,\n";
    std::cout << "  \"compiler\": {\"name\": \"" << compilerName() << "\", \"version\": \"" << escape(__VERSION__)
              << "\", \"cplusplus\": " << static_cast<long>(__cplusplus) << "},\n";
    std::cout << "  \"pointerSize\": " << sizeof(void *) << ",\n";
    std::cout << "  \"longSize\": " << sizeof(long) << ",\n";
    std::cout << "  \"sqlulenSize\": " << sizeof(SQLULEN) << ",\n";
    std::cout << "  \"endianness\": \"" << (littleEndian() ? "little" : "big") << "\",\n";
    std::cout << "  \"odbc\": {\n";
    std::cout << "    \"odbcver\": \"0x" << std::hex << std::setw(4) << std::setfill('0') << ODBCVER << std::dec
              << "\",\n";
    std::cout << "    \"specMajor\": " << SQL_SPEC_MAJOR << ",\n";
    std::cout << "    \"specMinor\": " << SQL_SPEC_MINOR << ",\n";
    std::cout << "    \"specString\": \"" << SQL_SPEC_STRING << "\",\n";
    std::cout << "    \"sqlwcharSize\": " << sizeof(SQLWCHAR) << ",\n";
    std::cout << "    \"sqlwcharIsUtf16\": " << (sizeof(SQLWCHAR) == 2 ? "true" : "false") << ",\n";
#if defined(SQL_WCHART_CONVERT)
    std::cout << "    \"wchartConvert\": true\n";
#else
    std::cout << "    \"wchartConvert\": false\n";
#endif
    std::cout << "  }\n";
    std::cout << "}\n";
    return 0;
}
