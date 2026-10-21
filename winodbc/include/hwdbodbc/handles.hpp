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
struct Statement;
struct Handle {
    const SQLSMALLINT type;
    SQLHANDLE id = SQL_NULL_HANDLE;
    std::shared_ptr<Handle> parent;
    std::shared_ptr<std::recursive_mutex> mutex;
    bool alive = true;
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
struct Statement : Handle {
    std::array<std::shared_ptr<Descriptor>, 4> descriptors;
    std::array<std::shared_ptr<Descriptor>, 4> automatic_descriptors;
    bool auto_ipd = false;
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
SQLRETURN allocate_handle(SQLSMALLINT type, SQLHANDLE input, SQLHANDLE* output);
SQLRETURN free_handle(SQLSMALLINT type, SQLHANDLE input);

template<class T, class Function>
SQLRETURN with_handle(SQLSMALLINT type, SQLHANDLE id, bool clear, Function&& function) noexcept {
    return entry_point(nullptr, [&]() -> SQLRETURN {
        auto handle = find_handle(type, id);
        if (!handle) return SQL_INVALID_HANDLE;
        std::lock_guard<std::recursive_mutex> lock(*handle->mutex);
        if (!handle->alive) return SQL_INVALID_HANDLE;
        if (clear) handle->diagnostic.clear();
        const auto result = entry_point(clear ? &handle->diagnostic : nullptr,
            [&] { return function(static_cast<T&>(*handle)); });
        if (clear) handle->diagnostic.return_code = result;
        return result;
    });
}
} // namespace hwdbodbc
