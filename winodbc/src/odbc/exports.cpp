#include "hwdbodbc/entry_point.hpp"
#include <algorithm>
#include <cstring>
#include <memory>
#include <mutex>
#include <unordered_map>

namespace {
using hwdbodbc::Diagnostic;
using hwdbodbc::entry_point;

struct Environment {
    Diagnostic diagnostic;
    SQLUINTEGER version = 0;
};

struct Registry {
    std::mutex mutex;
    std::unordered_map<SQLHANDLE, std::unique_ptr<Environment>> environments;
};

Registry& registry() {
    // 최초 API 호출 시 초기화한다. DllMain에서 수행하지 않는다.
    static Registry value;
    return value;
}

template<class Function>
SQLRETURN with_environment(SQLHANDLE handle, bool clear, Function&& function) noexcept {
    return entry_point(nullptr, [&]() -> SQLRETURN {
        auto& handles = registry();
        std::lock_guard<std::mutex> lock(handles.mutex);
        const auto found = handles.environments.find(handle);
        if (found == handles.environments.end()) return SQL_INVALID_HANDLE;
        auto& environment = *found->second;
        if (clear) environment.diagnostic.clear();
        return entry_point(&environment.diagnostic, [&] { return function(environment); });
    });
}

template<class Character>
SQLRETURN diagnostic_record(SQLSMALLINT type, SQLHANDLE handle, SQLSMALLINT record,
    Character* state, SQLINTEGER* native, Character* text,
    SQLSMALLINT capacity, SQLSMALLINT* length) noexcept {
    if (type != SQL_HANDLE_ENV) return SQL_INVALID_HANDLE;
    return with_environment(handle, false, [&](Environment& environment) -> SQLRETURN {
        if (record <= 0 || capacity < 0) return SQL_ERROR;
        const auto& diagnostic = environment.diagnostic;
        if (record != 1 || diagnostic.state[0] == '\0') return SQL_NO_DATA;
        if (state) {
            for (std::size_t i = 0; i < diagnostic.state.size(); ++i)
                state[i] = static_cast<Character>(diagnostic.state[i]);
        }
        if (native) *native = diagnostic.native_error;
        const auto needed = static_cast<SQLSMALLINT>(std::strlen(diagnostic.message.data()));
        if (length) *length = needed;
        // WO-1 진단은 영문 ASCII만 사용한다. 일반 문자열 변환은 WO-2이다.
        if (text && capacity > 0) {
            const auto copied = static_cast<SQLSMALLINT>(std::min<int>(needed, capacity - 1));
            for (SQLSMALLINT i = 0; i < copied; ++i)
                text[i] = static_cast<Character>(diagnostic.message[static_cast<std::size_t>(i)]);
            text[copied] = 0;
        }
        return text && needed >= capacity ? SQL_SUCCESS_WITH_INFO : SQL_SUCCESS;
    });
}
} // namespace

extern "C" SQLRETURN SQL_API SQLAllocHandle(SQLSMALLINT type, SQLHANDLE input, SQLHANDLE* output) {
    return entry_point(nullptr, [&]() -> SQLRETURN {
        if (output) *output = SQL_NULL_HANDLE;
        if (type == SQL_HANDLE_ENV) {
            if (input != SQL_NULL_HANDLE) return SQL_INVALID_HANDLE;
            if (!output) return SQL_ERROR;
            auto environment = std::make_unique<Environment>();
            auto& handles = registry();
            std::lock_guard<std::mutex> lock(handles.mutex);
            const auto handle = static_cast<SQLHANDLE>(environment.get());
            handles.environments.emplace(handle, std::move(environment));
            *output = handle;
            return SQL_SUCCESS;
        }
        if (type != SQL_HANDLE_DBC) return SQL_INVALID_HANDLE;
        return with_environment(input, true, [&](Environment& environment) -> SQLRETURN {
            if (!output) return environment.diagnostic.set("HY009", "Invalid use of null pointer.");
            // 연결 핸들 성공 스텁을 제공하지 않는다. ENV만 ABI 시험용으로 동작한다.
            return environment.diagnostic.set("HY000", "Connection handles are not implemented in this prototype.");
        });
    });
}

extern "C" SQLRETURN SQL_API SQLFreeHandle(SQLSMALLINT type, SQLHANDLE handle) {
    return entry_point(nullptr, [&]() -> SQLRETURN {
        if (type != SQL_HANDLE_ENV) return SQL_INVALID_HANDLE;
        auto& handles = registry();
        std::lock_guard<std::mutex> lock(handles.mutex);
        return handles.environments.erase(handle) == 1 ? SQL_SUCCESS : SQL_INVALID_HANDLE;
    });
}

extern "C" SQLRETURN SQL_API SQLSetEnvAttr(SQLHENV handle, SQLINTEGER attribute,
    SQLPOINTER value, SQLINTEGER) {
    return with_environment(handle, true, [&](Environment& environment) -> SQLRETURN {
        const auto numeric = reinterpret_cast<std::uintptr_t>(value);
        if (attribute == SQL_ATTR_ODBC_VERSION) {
            if (numeric != SQL_OV_ODBC2 && numeric != SQL_OV_ODBC3 && numeric != SQL_OV_ODBC3_80)
                return environment.diagnostic.set("HY024", "Invalid attribute value.");
            environment.version = static_cast<SQLUINTEGER>(numeric);
            return SQL_SUCCESS;
        }
        if (attribute == SQL_ATTR_OUTPUT_NTS) {
            if (numeric == SQL_TRUE) return SQL_SUCCESS;
            if (numeric == SQL_FALSE) return environment.diagnostic.set("HYC00", "Non-terminated output is not supported.");
            return environment.diagnostic.set("HY024", "Invalid attribute value.");
        }
        return environment.diagnostic.set("HY092", "Invalid attribute identifier.");
    });
}

extern "C" SQLRETURN SQL_API SQLGetEnvAttr(SQLHENV handle, SQLINTEGER attribute,
    SQLPOINTER value, SQLINTEGER, SQLINTEGER* length) {
    return with_environment(handle, true, [&](Environment& environment) -> SQLRETURN {
        if (attribute != SQL_ATTR_ODBC_VERSION && attribute != SQL_ATTR_OUTPUT_NTS)
            return environment.diagnostic.set("HY092", "Invalid attribute identifier.");
        if (!value) return environment.diagnostic.set("HY009", "Invalid use of null pointer.");
        *static_cast<SQLUINTEGER*>(value) = attribute == SQL_ATTR_ODBC_VERSION ? environment.version : SQL_TRUE;
        if (length) *length = sizeof(SQLUINTEGER);
        return SQL_SUCCESS;
    });
}

extern "C" SQLRETURN SQL_API SQLGetDiagRec(SQLSMALLINT type, SQLHANDLE handle,
    SQLSMALLINT record, SQLCHAR* state, SQLINTEGER* native, SQLCHAR* text,
    SQLSMALLINT capacity, SQLSMALLINT* length) {
    return diagnostic_record(type, handle, record, state, native, text, capacity, length);
}

extern "C" SQLRETURN SQL_API SQLGetDiagRecW(SQLSMALLINT type, SQLHANDLE handle,
    SQLSMALLINT record, SQLWCHAR* state, SQLINTEGER* native, SQLWCHAR* text,
    SQLSMALLINT capacity, SQLSMALLINT* length) {
    return diagnostic_record(type, handle, record, state, native, text, capacity, length);
}
