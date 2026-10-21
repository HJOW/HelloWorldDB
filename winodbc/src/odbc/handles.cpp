#include "hwdbodbc/handles.hpp"
#include "hwdbodbc/statement.hpp"
#include <limits>

namespace hwdbodbc {
namespace {
struct Registry {
    std::mutex mutex;
    std::unordered_map<SQLHANDLE, std::shared_ptr<Handle>> handles;
    std::uintptr_t next = 0x10000;
    std::uint64_t next_cursor_name = 1;
};
Registry& registry() { static Registry value; return value; }
}

std::shared_ptr<Handle> find_handle(SQLSMALLINT type, SQLHANDLE id) {
    auto& registry_value = registry();
    std::lock_guard<std::mutex> lock(registry_value.mutex);
    const auto found = registry_value.handles.find(id);
    if (found == registry_value.handles.end() || found->second->type != type) return {};
    return found->second;
}

void publish_handles(const std::vector<std::shared_ptr<Handle>>& handles) {
    auto& registry_value = registry();
    std::lock_guard<std::mutex> lock(registry_value.mutex);
    std::size_t published = 0;
    try {
        for (const auto& handle : handles) {
            // 토큰을 재사용하지 않아 해제된 주소가 새 객체를 가리키는 ABA 문제를 막는다.
            if (registry_value.next > (std::numeric_limits<std::uintptr_t>::max)() - 16)
                throw std::bad_alloc();
            handle->id = reinterpret_cast<SQLHANDLE>(registry_value.next);
            registry_value.next += 16;
            if (handle->type == SQL_HANDLE_STMT) {
                if (registry_value.next_cursor_name >= (1ULL << 55)) throw std::bad_alloc();
                auto value = registry_value.next_cursor_name++;
                const char alphabet[] = "0123456789ABCDEFGHIJKLMNOPQRSTUV";
                char digits[11]{}; std::size_t count = 0;
                do { digits[count++] = alphabet[value % 32]; value /= 32; } while (value);
                auto& name = static_cast<Statement&>(*handle).cursor_name;
                name.assign("SQL_CUR");
                while (count) name += digits[--count];
            }
            registry_value.handles.emplace(handle->id, handle);
            ++published;
        }
    } catch (...) {
        for (std::size_t i = 0; i < published; ++i) registry_value.handles.erase(handles[i]->id);
        throw;
    }
}

void erase_handle(SQLHANDLE id) {
    auto& registry_value = registry();
    std::lock_guard<std::mutex> lock(registry_value.mutex);
    registry_value.handles.erase(id);
}
void invalidate_connection_children(Connection& connection) {
    auto& registry_value = registry();
    std::lock_guard<std::mutex> lock(registry_value.mutex);
    for (auto iterator = registry_value.handles.begin(); iterator != registry_value.handles.end();) {
        if (iterator->second->parent.get() != &connection) { ++iterator; continue; }
        iterator->second->alive = false;
        iterator = registry_value.handles.erase(iterator);
    }
    connection.children = 0;
}
std::vector<std::shared_ptr<Statement>> connection_statements(const Connection& connection) {
    auto& registry_value = registry();
    std::lock_guard<std::mutex> lock(registry_value.mutex);
    std::vector<std::shared_ptr<Statement>> result;
    for (const auto& item : registry_value.handles)
        if (item.second->type == SQL_HANDLE_STMT && item.second->parent.get() == &connection)
            result.push_back(std::static_pointer_cast<Statement>(item.second));
    return result;
}

SQLRETURN allocate_handle(SQLSMALLINT type, SQLHANDLE input, SQLHANDLE* output) {
    return entry_point(nullptr, [&]() -> SQLRETURN {
        if (output) *output = SQL_NULL_HANDLE;
        if (type == SQL_HANDLE_ENV) {
            if (input) return SQL_INVALID_HANDLE;
            if (!output) return SQL_ERROR;
            auto environment = std::make_shared<Environment>();
            publish_handles({environment});
            *output = environment->id;
            return SQL_SUCCESS;
        }
        const auto parent_type = type == SQL_HANDLE_DBC ? SQL_HANDLE_ENV : SQL_HANDLE_DBC;
        if (type != SQL_HANDLE_DBC && type != SQL_HANDLE_STMT && type != SQL_HANDLE_DESC)
            return SQL_INVALID_HANDLE;
        return with_handle<Handle>(static_cast<SQLSMALLINT>(parent_type), input, true, [&](Handle& parent) -> SQLRETURN {
            if (!output) throw DriverError("HY009", "Invalid use of null pointer.");
            if (type == SQL_HANDLE_DBC && !static_cast<Environment&>(parent).version)
                throw DriverError("HY010", "Set the ODBC version before allocating a connection.");
            if (type != SQL_HANDLE_DBC && !static_cast<Connection&>(parent).connected)
                throw DriverError("08003", "Connection is not open.");
            auto parent_pointer = find_handle(parent.type, parent.id);
            std::shared_ptr<Handle> child;
            std::vector<std::shared_ptr<Handle>> group;
            if (type == SQL_HANDLE_DBC) child = std::make_shared<Connection>();
            else if (type == SQL_HANDLE_DESC) child = std::make_shared<Descriptor>();
            else {
                auto statement = std::make_shared<Statement>();
                statement->cursor_name.reserve(18);
                statement->metadata_id = static_cast<Connection&>(parent).metadata_id;
                for (std::size_t i = 0; i < statement->descriptors.size(); ++i) {
                    auto descriptor = std::make_shared<Descriptor>();
                    descriptor->automatic = true;
                    descriptor->role = i == 2 ? DescriptorRole::row : i == 3 ? DescriptorRole::parameter : DescriptorRole::application;
                    descriptor->parent = parent_pointer;
                    descriptor->mutex = parent.mutex;
                    descriptor->owner = statement;
                    statement->descriptors[i] = descriptor;
                    statement->automatic_descriptors[i] = descriptor;
                    group.push_back(descriptor);
                }
                child = statement;
            }
            child->parent = parent_pointer;
            if (type != SQL_HANDLE_DBC) child->mutex = parent.mutex;
            group.push_back(child);
            publish_handles(group);
            ++parent.children;
            *output = child->id;
            return SQL_SUCCESS;
        });
    });
}

SQLRETURN free_handle(SQLSMALLINT type, SQLHANDLE input) {
    return with_handle<Handle>(type, input, true, [&](Handle& handle) -> SQLRETURN {
        if (type == SQL_HANDLE_DESC && static_cast<Descriptor&>(handle).automatic)
            throw DriverError("HY017", "An automatically allocated descriptor cannot be freed explicitly.");
        if (handle.children.load() || (type == SQL_HANDLE_DBC && static_cast<Connection&>(handle).connected))
            throw DriverError("HY010", "Handle has active children or an open connection.");
        if (type == SQL_HANDLE_STMT) {
            release_statement(static_cast<Statement&>(handle));
            for (const auto& descriptor : static_cast<Statement&>(handle).automatic_descriptors) {
                descriptor->alive = false;
                erase_handle(descriptor->id);
            }
        }
        if (type == SQL_HANDLE_DESC) {
            for (const auto& statement : connection_statements(static_cast<Connection&>(*handle.parent))) {
                for (std::size_t i = 0; i < 2; ++i) if (statement->descriptors[i].get() == &handle) {
                    statement->descriptors[i] = statement->automatic_descriptors[i];
                    statement->parameter_metadata_dirty = true;
                }
            }
        }
        handle.alive = false;
        erase_handle(input);
        if (handle.parent) --handle.parent->children;
        return SQL_SUCCESS;
    });
}
} // namespace hwdbodbc
