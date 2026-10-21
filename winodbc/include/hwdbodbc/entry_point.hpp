#pragma once

#include "hwdbodbc/odbc.hpp"
#include <array>
#include <exception>
#include <new>
#include <utility>

namespace hwdbodbc {

// OOM 처리 자체가 메모리를 할당하지 않도록 초기 진단은 고정 버퍼에 둔다.
// 다중 레코드와 모든 핸들에 대한 진단 수명은 WO-2에서 확장한다.
struct Diagnostic {
    std::array<char, 6> state{};
    std::array<char, 256> message{};
    SQLINTEGER native_error = 0;

    void clear() noexcept { state[0] = '\0'; message[0] = '\0'; native_error = 0; }

    SQLRETURN set(const char* code, const char* text) noexcept {
        for (std::size_t i = 0; i < 5; ++i) state[i] = code[i];
        state[5] = '\0';
        std::size_t i = 0;
        while (text[i] && i + 1 < message.size()) {
            message[i] = text[i];
            ++i;
        }
        message[i] = '\0';
        native_error = 0;
        return SQL_ERROR;
    }
};

// 이 경계는 C++ 예외만 처리한다. 잘못된 앱 포인터에 대한 SEH를 숨기지 않는다.
template<class Function>
SQLRETURN entry_point(Diagnostic* diagnostic, Function&& function) noexcept {
    try {
        return std::forward<Function>(function)();
    } catch (const std::bad_alloc&) {
        if (diagnostic) diagnostic->set("HY001", "Memory allocation error.");
    } catch (const std::exception&) {
        if (diagnostic) diagnostic->set("HY000", "Internal driver error.");
    } catch (...) {
        if (diagnostic) diagnostic->set("HY000", "Unexpected driver error.");
    }
    return SQL_ERROR;
}

} // namespace hwdbodbc
