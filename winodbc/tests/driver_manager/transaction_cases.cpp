#include "hwdbodbc/odbc.hpp"
#include "../helpers/check.hpp"
#include <atomic>
#include <chrono>
#include <cstring>
#include <future>
#include <functional>
#include <string>
#include <thread>

namespace {
SQLWCHAR* wide(const std::wstring& text) { return reinterpret_cast<SQLWCHAR*>(const_cast<wchar_t*>(text.c_str())); }
SQLPOINTER number(SQLULEN value) { return reinterpret_cast<SQLPOINTER>(value); }
void expect(SQLRETURN result, SQLSMALLINT type, SQLHANDLE handle, const char* operation) {
    if (SQL_SUCCEEDED(result)) return;
    SQLCHAR state[6]{}, message[1024]{}; SQLGetDiagRec(type,handle,1,state,nullptr,message,1024,nullptr);
    std::cerr << operation << " " << state << " " << message << '\n'; check(false,operation);
}
void error(SQLRETURN result, SQLHSTMT statement, const char* expected) {
    check(result == SQL_ERROR,"transaction operation must fail"); SQLCHAR state[6]{}; SQLINTEGER native = 0;
    check(SQLGetDiagRec(SQL_HANDLE_STMT,statement,1,state,&native,nullptr,0,nullptr) == SQL_SUCCESS,"transaction diagnostic");
    if (std::strcmp(reinterpret_cast<char*>(state),expected)) std::cerr << state << " != " << expected << '\n';
    check(!std::strcmp(reinterpret_cast<char*>(state),expected),"transaction SQLSTATE");
    if (!std::strcmp(expected,"HY008") || !std::strcmp(expected,"HYT00")) check(native == 8010,"server cancellation native code preserved");
}
SQLHSTMT allocate(SQLHDBC connection) { SQLHSTMT result = nullptr; expect(SQLAllocHandle(SQL_HANDLE_STMT,connection,&result),SQL_HANDLE_DBC,connection,"transaction STMT"); return result; }
SQLHDBC connect(SQLHENV environment, const std::wstring& settings) {
    SQLHDBC result = nullptr; check(SQLAllocHandle(SQL_HANDLE_DBC,environment,&result) == SQL_SUCCESS,"transaction DBC");
    expect(SQLDriverConnectW(result,nullptr,wide(settings),SQL_NTS,nullptr,0,nullptr,SQL_DRIVER_NOPROMPT),SQL_HANDLE_DBC,result,"transaction second connection"); return result;
}
void autocommit(SQLHDBC connection, SQLULEN value) { expect(SQLSetConnectAttr(connection,SQL_ATTR_AUTOCOMMIT,number(value),0),SQL_HANDLE_DBC,connection,"transaction autocommit"); }
void sql(SQLHSTMT statement, const std::wstring& text) { expect(SQLExecDirectW(statement,wide(text),SQL_NTS),SQL_HANDLE_STMT,statement,"transaction SQL"); }
SQLINTEGER scalar(SQLHSTMT statement, const std::wstring& text) {
    sql(statement,text); expect(SQLFetch(statement),SQL_HANDLE_STMT,statement,"transaction scalar fetch"); SQLINTEGER value = 0; SQLLEN length = 0;
    expect(SQLGetData(statement,1,SQL_C_SLONG,&value,0,&length),SQL_HANDLE_STMT,statement,"transaction scalar data");
    expect(SQLCloseCursor(statement),SQL_HANDLE_STMT,statement,"transaction scalar close"); return value;
}
void end(SQLHDBC connection, SQLSMALLINT action) { expect(SQLEndTran(SQL_HANDLE_DBC,connection,action),SQL_HANDLE_DBC,connection,"DBC transaction completion"); }
void close(SQLHDBC connection, SQLHSTMT statement) {
    check(SQLFreeHandle(SQL_HANDLE_STMT,statement) == SQL_SUCCESS,"transaction STMT cleanup");
    expect(SQLDisconnect(connection),SQL_HANDLE_DBC,connection,"transaction disconnect"); check(SQLFreeHandle(SQL_HANDLE_DBC,connection) == SQL_SUCCESS,"transaction DBC cleanup");
}
SQLRETURN cancel_running(SQLHSTMT statement, const std::wstring& query, const std::function<void()>& before_cancel = {}) {
    std::promise<void> entered; auto started = entered.get_future();
    auto result = std::async(std::launch::async,[&] { entered.set_value(); return SQLExecDirectW(statement,wide(query),SQL_NTS); });
    started.wait(); check(result.wait_for(std::chrono::milliseconds(150)) == std::future_status::timeout,"query still running before cancel");
    if (before_cancel) before_cancel();
    const auto begin = std::chrono::steady_clock::now();
    const auto cancelled = SQLCancel(statement);
    check(std::chrono::steady_clock::now() - begin < std::chrono::seconds(3),"Cancel does not wait for execution mutex");
    check(result.wait_for(std::chrono::seconds(5)) == std::future_status::ready,"cancelled execution completes promptly");
    check(cancelled == SQL_SUCCESS,"server cancel acknowledgement"); return result.get();
}
}
void run_transaction_cases(SQLHDBC connection, SQLHENV environment, const std::wstring& settings) {
    auto statement = allocate(connection);
    auto observer_connection = connect(environment,settings), observer = allocate(observer_connection);
    sql(statement,L"CREATE TABLE Q8_TX (ID INTEGER PRIMARY KEY,N INTEGER)");
    autocommit(connection,SQL_AUTOCOMMIT_OFF); sql(statement,L"INSERT INTO Q8_TX VALUES (1,10)");
    check(scalar(observer,L"SELECT COUNT(*) FROM Q8_TX") == 0,"uncommitted insert hidden");
    end(connection,SQL_COMMIT); check(scalar(observer,L"SELECT N FROM Q8_TX WHERE ID=1") == 10,"commit visible");
    sql(statement,L"UPDATE Q8_TX SET N=20 WHERE ID=1"); end(connection,SQL_ROLLBACK);
    check(scalar(observer,L"SELECT N FROM Q8_TX WHERE ID=1") == 10,"rollback restores value");
    sql(statement,L"INSERT INTO Q8_TX VALUES (2,20)"); sql(statement,L"CREATE TABLE Q8_DDL (ID INTEGER)"); end(connection,SQL_ROLLBACK);
    check(scalar(observer,L"SELECT COUNT(*) FROM Q8_TX") == 2,"DDL commits preceding DML");
    sql(statement,L"SELECT ID FROM Q8_TX ORDER BY ID"); expect(SQLFetch(statement),SQL_HANDLE_STMT,statement,"cursor before commit");
    end(connection,SQL_COMMIT); expect(SQLFetch(statement),SQL_HANDLE_STMT,statement,"cursor survives commit");
    expect(SQLCloseCursor(statement),SQL_HANDLE_STMT,statement,"preserved cursor close");
    auto temporary_connection = connect(environment,settings), temporary = allocate(temporary_connection);
    autocommit(temporary_connection,SQL_AUTOCOMMIT_OFF); sql(temporary,L"INSERT INTO Q8_TX VALUES (3,30)"); close(temporary_connection,temporary);
    check(scalar(observer,L"SELECT COUNT(*) FROM Q8_TX WHERE ID=3") == 0,"disconnect rolls back");

    auto second_connection = connect(environment,settings), second = allocate(second_connection);
    autocommit(second_connection,SQL_AUTOCOMMIT_OFF);
    sql(statement,L"INSERT INTO Q8_TX VALUES (10,100)"); sql(second,L"INSERT INTO Q8_TX VALUES (20,200)");
    expect(SQLEndTran(SQL_HANDLE_ENV,environment,SQL_COMMIT),SQL_HANDLE_ENV,environment,"ENV commit all connections");
    check(scalar(observer,L"SELECT COUNT(*) FROM Q8_TX WHERE ID IN (10,20)") == 2,"ENV commits independent transactions");
    sql(statement,L"INSERT INTO Q8_TX VALUES (11,110)"); sql(second,L"INSERT INTO Q8_TX VALUES (21,210)");
    expect(SQLEndTran(SQL_HANDLE_ENV,environment,SQL_ROLLBACK),SQL_HANDLE_ENV,environment,"ENV rollback all connections");
    check(scalar(observer,L"SELECT COUNT(*) FROM Q8_TX WHERE ID IN (11,21)") == 0,"ENV rollback visible");

    // 앞선 트랜잭션 변경을 유지하면서 잠금 대기 문장 하나만 취소한다.
    sql(statement,L"UPDATE Q8_TX SET N=30 WHERE ID=1");
    sql(second,L"INSERT INTO Q8_TX VALUES (30,300)");
    error(cancel_running(second,L"UPDATE Q8_TX SET N=99 WHERE ID=1"),second,"HY008");
    check(scalar(second,L"SELECT N FROM Q8_TX WHERE ID=30") == 300,"prior uncommitted change survives cancellation");
    end(second_connection,SQL_COMMIT); end(connection,SQL_ROLLBACK);
    check(scalar(observer,L"SELECT N FROM Q8_TX WHERE ID=1") == 10 && scalar(observer,L"SELECT N FROM Q8_TX WHERE ID=30") == 300,"only cancelled statement rolled back");

    sql(statement,L"UPDATE Q8_TX SET N=40 WHERE ID=1");
    expect(SQLSetStmtAttr(second,SQL_ATTR_QUERY_TIMEOUT,number(1),0),SQL_HANDLE_STMT,second,"query timeout set");
    error(SQLExecDirectW(second,wide(L"UPDATE Q8_TX SET N=99 WHERE ID=1"),SQL_NTS),second,"HYT00");
    check(scalar(second,L"SELECT 42") == 42,"query timeout leaves synchronized session usable");
    expect(SQLSetStmtAttr(second,SQL_ATTR_QUERY_TIMEOUT,number(0),0),SQL_HANDLE_STMT,second,"query timeout clear");
    expect(SQLSetConnectAttr(second_connection,SQL_ATTR_CONNECTION_TIMEOUT,number(1),0),SQL_HANDLE_DBC,second_connection,"connection timeout set");
    error(SQLExecDirectW(second,wide(L"UPDATE Q8_TX SET N=99 WHERE ID=1"),SQL_NTS),second,"HYT01");
    expect(SQLSetConnectAttr(second_connection,SQL_ATTR_CONNECTION_TIMEOUT,number(0),0),SQL_HANDLE_DBC,second_connection,"connection timeout clear");
    check(scalar(second,L"SELECT 43") == 43,"connection timeout cancellation synchronized"); end(connection,SQL_ROLLBACK); end(second_connection,SQL_ROLLBACK);

    sql(statement,L"CREATE TABLE Q8_CPU (ID INTEGER PRIMARY KEY)");
    std::wstring values = L"INSERT INTO Q8_CPU VALUES ";
    for (int i = 0; i < 500; ++i) { if (i) values += L","; values += L"(" + std::to_wstring(i) + L")"; }
    sql(statement,values); end(connection,SQL_COMMIT);
    auto same_connection = allocate(second_connection); std::future<SQLRETURN> serialized;
    error(cancel_running(second,L"SELECT COUNT(*) FROM Q8_CPU A CROSS JOIN Q8_CPU B CROSS JOIN Q8_CPU C",[&] {
        serialized = std::async(std::launch::async,[&] { return SQLExecDirectW(same_connection,wide(L"SELECT 47"),SQL_NTS); });
        check(serialized.wait_for(std::chrono::milliseconds(100)) == std::future_status::timeout,"same DBC statements serialize");
        const auto begin = std::chrono::steady_clock::now();
        check(scalar(observer,L"SELECT 48") == 48,"other DBC progresses during CPU execution");
        check(std::chrono::steady_clock::now() - begin < std::chrono::seconds(2),"different DBC has no global execution lock");
    }),second,"HY008");
    check(serialized.wait_for(std::chrono::seconds(3)) == std::future_status::ready,"same DBC waiter resumes after cancel");
    expect(serialized.get(),SQL_HANDLE_STMT,same_connection,"serialized statement completed");
    expect(SQLFetch(same_connection),SQL_HANDLE_STMT,same_connection,"serialized result fetch");
    SQLINTEGER serialized_value = 0; SQLLEN serialized_length = 0;
    expect(SQLGetData(same_connection,1,SQL_C_SLONG,&serialized_value,0,&serialized_length),SQL_HANDLE_STMT,same_connection,"serialized result data");
    check(serialized_value == 47,"cancel does not steal or cancel another statement response");
    check(SQLFreeHandle(SQL_HANDLE_STMT,same_connection) == SQL_SUCCESS,"serialized statement cleanup");
    check(scalar(second,L"SELECT 44") == 44,"CPU cancellation session reuse");
    // 완료 후의 취소가 다음 문장에 적용되지 않는다.
    for (int i = 0; i < 12; ++i) {
        check(scalar(second,L"SELECT 45") == 45,"query before late cancellation");
        check(SQLCancel(second) == SQL_SUCCESS,"idle cancel succeeds");
        check(scalar(second,L"SELECT 46") == 46,"late cancellation does not affect next operation");
    }
    end(second_connection,SQL_ROLLBACK); close(second_connection,second); close(observer_connection,observer);
    end(connection,SQL_ROLLBACK); autocommit(connection,SQL_AUTOCOMMIT_ON);
    check(SQLFreeHandle(SQL_HANDLE_STMT,statement) == SQL_SUCCESS,"transaction primary cleanup");
    std::cout << "ODBC transactions/ENV/cursor/lock+CPU cancel/timeouts/reuse PASS\n";
}
