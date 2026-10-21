#pragma once

#include "hwdbodbc/odbc.hpp"
#include <array>
#include <exception>
#include <new>
#include <utility>
#include <string>
#include <vector>
#include "hwdbodbc/text.hpp"

namespace hwdbodbc {

struct DiagnosticRecord {
    std::string state;
    std::string message;
    SQLINTEGER native_error = 0;
    SQLLEN row = SQL_ROW_NUMBER_UNKNOWN;
    SQLINTEGER column = SQL_COLUMN_NUMBER_UNKNOWN;
};

// 정상 진단은 가변 길이 목록, 예외 처리의 비상 진단은 할당 없는 고정 버퍼이다.
struct Diagnostic {
    std::array<char, 6> state{};
    std::array<char, 256> message{};
    SQLINTEGER native_error = 0;
    std::vector<DiagnosticRecord> records;
    SQLRETURN return_code = SQL_SUCCESS;
    SQLLEN row_count = 0;
    SQLLEN cursor_row_count = 0;
    std::string dynamic_function;
    SQLINTEGER dynamic_function_code = SQL_DIAG_UNKNOWN_STATEMENT;

    void clear() noexcept {
        state[0] = '\0'; message[0] = '\0'; native_error = 0;
        records.clear(); return_code = SQL_SUCCESS;
    }

    void append(std::string code, std::string text, SQLINTEGER number = 0,
        SQLLEN row = SQL_ROW_NUMBER_UNKNOWN, SQLINTEGER column = SQL_COLUMN_NUMBER_UNKNOWN) {
        records.push_back({std::move(code), std::move(text), number, row, column});
    }

    std::size_t size() const noexcept { return state[0] ? 1 : records.size(); }
    DiagnosticRecord record(std::size_t index) const {
        if (state[0]) return {state.data(), message.data(), native_error};
        return records.at(index);
    }

    SQLRETURN set(const char* code, const char* text) noexcept {
        records.clear();
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
    } catch (const DriverError& error) {
        if (diagnostic) {
            try { diagnostic->append(error.state, error.what(), error.native); }
            catch (...) { diagnostic->set("HY001", "Memory allocation error."); }
        }
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
