#pragma once
#include "hwdbodbc/entry_point.hpp"
#include "hwdbodbc/types.hpp"
#include <atomic>
#include <memory>
#include <mutex>
#include <array>
#include <unordered_map>

namespace hwdbodbc {
class Session;
struct RequestControl;
struct ReconnectState;
struct Statement;
struct Handle {
    const SQLSMALLINT type;
    SQLHANDLE id = SQL_NULL_HANDLE;
    std::shared_ptr<Handle> parent;
    std::shared_ptr<std::recursive_mutex> mutex;
    std::atomic<bool> alive{true};
    std::atomic<std::size_t> children{0};
    Diagnostic diagnostic;
    explicit Handle(SQLSMALLINT kind) : type(kind), mutex(std::make_shared<std::recursive_mutex>()) {}
    virtual ~Handle() = default;
};
struct Environment : Handle {
    SQLUINTEGER version = 0;
    Environment() : Handle(SQL_HANDLE_ENV) {}
};
struct Connection : Handle {
    bool connected = false;
    std::string server_name;
    std::shared_ptr<Session> session;
    std::shared_ptr<ReconnectState> reconnect;
    SQLUINTEGER login_timeout = 0;
    SQLUINTEGER connection_timeout = 0;
    SQLUINTEGER metadata_id = SQL_FALSE;
    SQLUINTEGER autocommit = SQL_AUTOCOMMIT_ON;
    SQLUINTEGER fetch_size = 500;
    SQLHWND window = nullptr;
    Connection() : Handle(SQL_HANDLE_DBC) {}
};
enum class DescriptorRole { application, row, parameter };
struct DescriptorRecord {
    bool bound = false;
    SQLSMALLINT type = SQL_C_DEFAULT;
    SQLSMALLINT parameter_type = SQL_PARAM_INPUT;
    SQLPOINTER data = nullptr;
    SQLLEN capacity = 0;
    SQLLEN* indicator = nullptr;
    SQLLEN* octet_length_pointer = nullptr;
    ConversionSpec conversion;
    SQLULEN length = 0;
    SQLINTEGER radix = 0;
    SQLSMALLINT unnamed = SQL_UNNAMED;
    SqlType metadata;
};
struct Descriptor : Handle {
    std::weak_ptr<Statement> owner;
    bool automatic = false;
    DescriptorRole role = DescriptorRole::application;
    std::vector<DescriptorRecord> records;
    SQLULEN array_size = 1;
    SQLULEN bind_type = SQL_BIND_BY_COLUMN;
    SQLLEN* bind_offset = nullptr;
    SQLUSMALLINT* array_status = nullptr;
    SQLULEN* rows_processed = nullptr;
    Descriptor() : Handle(SQL_HANDLE_DESC) {}
};
struct OperationControl { std::atomic<bool> cancelled{false}; };
// 실행 중인 배열 위치와 분할 입력만 소유한다. 앱의 바인딩 주소는 해제하지 않는다.
struct ParameterExecution {
    SQLULEN row = 0, successful = 0;
    SQLLEN affected = 0;
    std::size_t parameter = 0, bytes = 0;
    bool failed = false, warnings = false, row_warning = false, pending = false;
    bool requested = false, supplied = false, null_value = false;
    SQLLEN expected = -1;
    DescriptorRecord binding;
    SqlType target;
    std::vector<unsigned char> input;
    Json parameters = Json::array();
    Diagnostic diagnostic;
};
struct Statement : Handle {
    std::shared_ptr<RequestControl> active_request;
    std::shared_ptr<OperationControl> active_operation;
    std::unique_ptr<ParameterExecution> parameter_execution;
    std::array<std::shared_ptr<Descriptor>, 4> descriptors;
    std::array<std::shared_ptr<Descriptor>, 4> automatic_descriptors;
    bool auto_ipd = false;
    bool prepared_rows = false;
    bool executed = false;
    bool cursor_open = false;
    bool current_row = false;
    bool has_more = false;
    std::uint64_t cursor = 0;
    std::uint64_t prepared = 0;
    std::vector<SqlType> parameter_metadata;
    bool parameter_metadata_dirty = false;
    Json rows = Json::array();
    std::size_t next_row = 0;
    SQLLEN row_count = 0;
    SQLULEN row_number = 0;
    SQLULEN fetched_total = 0;
    SQLULEN max_rows = 0;
    SQLUINTEGER retrieve_data = SQL_RD_ON;
    SQLUINTEGER query_timeout = 0;
    SQLUINTEGER metadata_id = SQL_FALSE;
    SQLUINTEGER noscan = SQL_NOSCAN_OFF;
    std::string cursor_name;
    std::string automatic_cursor_name;
    std::vector<DataStream> streams;
    SQLUSMALLINT last_get_column = 0;
    Statement() : Handle(SQL_HANDLE_STMT) {}
};

// 레지스트리 잠금은 검색/등록에만 쓴다. SQL 요청을 전역으로 직렬화하지 않는다.
std::shared_ptr<Handle> find_handle(SQLSMALLINT type, SQLHANDLE id);
void publish_handles(const std::vector<std::shared_ptr<Handle>>& handles);
void erase_handle(SQLHANDLE id);
void invalidate_connection_children(Connection& connection);
std::vector<std::shared_ptr<Statement>> connection_statements(const Connection& connection);
std::vector<std::shared_ptr<Connection>> environment_connections(const Environment& environment);
std::vector<std::shared_ptr<Descriptor>> connection_descriptors(const Connection& connection);
void settle_local_cancellation(Statement& statement);
SQLRETURN finish_statement_call(Statement& statement, SQLRETURN result);
SQLRETURN allocate_handle(SQLSMALLINT type, SQLHANDLE input, SQLHANDLE* output);
SQLRETURN free_handle(SQLSMALLINT type, SQLHANDLE input);

template<class T, class Function>
SQLRETURN with_handle(SQLSMALLINT type, SQLHANDLE id, bool clear, Function&& function, bool allow_data = false) noexcept {
    return entry_point(nullptr, [&]() -> SQLRETURN {
        auto handle = find_handle(type, id);
        if (!handle) return SQL_INVALID_HANDLE;
        std::lock_guard<std::recursive_mutex> lock(*handle->mutex);
        if (!handle->alive) return SQL_INVALID_HANDLE;
        if (clear) handle->diagnostic.clear();
        auto result = entry_point(clear ? &handle->diagnostic : nullptr,
            [&] {
                if (clear && type == SQL_HANDLE_STMT) settle_local_cancellation(static_cast<Statement&>(*handle));
                if (clear && !allow_data && type == SQL_HANDLE_STMT && static_cast<Statement&>(*handle).parameter_execution)
                    throw DriverError("HY010", "Complete or cancel the data-at-execution operation first.");
                return function(static_cast<T&>(*handle));
            });
        if (clear && type == SQL_HANDLE_STMT)
            result = entry_point(&handle->diagnostic,[&] { return finish_statement_call(static_cast<Statement&>(*handle),result); });
        if (clear) handle->diagnostic.return_code = result;
        return result;
    });
}
} // namespace hwdbodbc
