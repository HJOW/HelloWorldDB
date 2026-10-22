#include "hwdbodbc/statement.hpp"

namespace hwdbodbc {
void settle_local_cancellation(Statement& statement) {
    const auto operation = std::atomic_load(&statement.active_operation);
    if (operation && operation->cancelled && !std::atomic_load(&statement.active_request)) {
        statement.parameter_execution.reset(); statement.diagnostic.clear();
        std::atomic_store(&statement.active_operation,std::shared_ptr<OperationControl>{});
    }
}
void end_transaction(Connection& connection, SQLSMALLINT completion) {
    if (!connection.connected || !connection.session) throw DriverError("08003", "Connection is not open.");
    if (completion != SQL_COMMIT && completion != SQL_ROLLBACK) throw DriverError("HY012", "Invalid transaction completion type.");
    for (const auto& statement : connection_statements(connection)) {
        settle_local_cancellation(*statement);
        if (statement->parameter_execution) throw DriverError("HY010", "Complete or cancel parameter data before ending the transaction.");
    }
    if (connection.autocommit == SQL_AUTOCOMMIT_ON) return;
    try { connection.session->request({{"type","execute"},{"sql",completion == SQL_COMMIT ? "COMMIT" : "ROLLBACK"}},"result",connection.connection_timeout); }
    catch (const DriverError& error) {
        if (connection.session->dead()) throw DriverError("08007","Transaction completion could not be determined [original state " + error.state + "].",error.native);
        throw;
    }
}
}
using namespace hwdbodbc;
extern "C" SQLRETURN SQL_API SQLEndTran(SQLSMALLINT type, SQLHANDLE handle, SQLSMALLINT completion) {
    if (type == SQL_HANDLE_DBC) return with_handle<Connection>(type,handle,true,[&](Connection& connection) -> SQLRETURN {
        end_transaction(connection,completion); return SQL_SUCCESS;
    });
    if (type != SQL_HANDLE_ENV) return SQL_INVALID_HANDLE;
    return with_handle<Environment>(type,handle,true,[&](Environment& environment) -> SQLRETURN {
        if (completion != SQL_COMMIT && completion != SQL_ROLLBACK) throw DriverError("HY012", "Invalid transaction completion type.");
        bool failed = false;
        for (const auto& connection : environment_connections(environment)) {
            const auto result = with_handle<Connection>(SQL_HANDLE_DBC,connection->id,true,[&](Connection& current) -> SQLRETURN {
                if (current.connected) end_transaction(current,completion); return SQL_SUCCESS;
            });
            if (!SQL_SUCCEEDED(result)) { failed = true; environment.diagnostic.append("25S01","An environment connection did not complete its transaction; inspect its connection diagnostics."); }
        }
        return failed ? SQL_ERROR : SQL_SUCCESS;
    });
}
extern "C" SQLRETURN SQL_API SQLCancel(SQLHSTMT id) {
    return entry_point(nullptr,[&]() -> SQLRETURN {
        const auto statement = std::static_pointer_cast<Statement>(find_handle(SQL_HANDLE_STMT,id));
        if (!statement || !statement->alive) return SQL_INVALID_HANDLE;
        const auto operation = std::atomic_load(&statement->active_operation);
        if (!operation) return SQL_SUCCESS;
        operation->cancelled = true;
        if (const auto control = std::atomic_load(&statement->active_request); control && control->operation == operation) {
            // 다른 스레드의 실행 취소는 실행 측 진단을 지우거나 자신의 진단을 게시하지 않는다.
            control->session->cancel(control); return SQL_SUCCESS;
        }
        std::unique_lock<std::recursive_mutex> lock(*statement->mutex,std::try_to_lock);
        if (!lock.owns_lock()) return SQL_SUCCESS;
        if (!statement->alive) return SQL_INVALID_HANDLE;
        if (std::atomic_load(&statement->active_operation) == operation) settle_local_cancellation(*statement);
        return SQL_SUCCESS;
    });
}
