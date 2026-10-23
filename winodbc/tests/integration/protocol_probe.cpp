#include "hwdbodbc/protocol.hpp"
#include "../helpers/check.hpp"
#include <iostream>

using namespace hwdbodbc;
int main(int argc, char** argv) {
    try {
        check(argc == 3, "usage: hwdb_protocol_probe PORT scenario");
        const auto port = static_cast<unsigned short>(std::stoul(argv[1]));
        const std::string scenario = argv[2];
        // 일반 시나리오의 요청 제한 시간이다. 제한 시간 동작을 시험하는 경로(login-budget, *-timeout 등)는 아래에서 값을 따로 쓴다.
        // fsync가 느린 VM에서 DDL 한 건이 3초를 넘어도 이 시험이 실패하지 않게 넉넉하게 둔다.
        const unsigned step = 10;
        Session session(tcp_transport("127.0.0.1", port, 3));
        if (scenario == "hello") {
            const auto result = session.request({{"type", "hello"}, {"versions", {1}}}, "helloOk", 2);
            check(integer_field(result, "version") == 1, "hello response");
            std::cout << "PASS hello\n";
            return 0;
        }
        if (scenario == "wrong") {
            try { session.login("SYSTEM", "wrong-test-password", {}, {}, step); }
            catch (const DriverError& error) {
                check(error.state == "28000" && error.native == 7000, "wrong password diagnostic");
                std::cout << "PASS wrong password\n";
                return 0;
            }
            check(false, "wrong password accepted");
        }
        if (scenario == "login-budget") {
            session.login("SYSTEM","HelloWorldDB",{},{},1);
            check(false,"cumulative authentication timeout was not enforced");
        }
        if (scenario == "query-timeout" || scenario == "cancel-desync" || scenario == "timeout-completed" || scenario == "send-timeout") {
            session.login("SYSTEM","HelloWorldDB",{},{},3);
            auto control = std::make_shared<RequestControl>();
            try {
                const auto response = session.request({{"type","execute"},{"sql",scenario == "send-timeout" ? std::string(12U * 1024U * 1024U,' ') : "SELECT 1"}},"result",0,control,1);
                check(scenario == "timeout-completed" && response["rows"] == Json::array({Json::array({1})}),"normal completion survives a late timeout cancel");
            } catch (const DriverError& error) {
                check(scenario != "timeout-completed" && error.state == "HYT00","query timeout SQLSTATE");
                if (scenario == "query-timeout") check(error.native == 8010,"cancel native error preserved");
            }
            check(control->finished && control->completed,"request control completes before returning");
            check(session.dead() == (scenario == "cancel-desync" || scenario == "send-timeout"),"only unsynchronized cancellation or send failure discards the connection");
            if (!session.dead()) {
                const auto response = session.request({{"type","execute"},{"sql","SELECT 2"}},"result",2);
                check(response["rows"] == Json::array({Json::array({2})}),"following request keeps its own response"); session.close();
            }
            std::cout << "PASS " << scenario << '\n'; return 0;
        }
        session.login(scenario == "nullspace" ? "NO_DEFAULT" : "SYSTEM",
            scenario == "nfkc" ? "Ａ①가\u0301😀" : scenario == "nullspace" ? "no-default-test" : "HelloWorldDB", {}, {}, step);
        if (scenario == "auth") { session.close(); std::cout << "PASS auth\n"; return 0; }
        if (scenario == "nullspace") check(session.information["tablespace"].is_null(), "null default tablespace");
        const auto result = session.request({{"type", "execute"}, {"sql", "SELECT 1"}}, "result", step);
        check(result["rows"] == Json::array({Json::array({1})}), "SELECT 1 result");
        if (scenario == "basic") {
            session.request({{"type", "execute"}, {"sql", "CREATE USER NO_DEFAULT IDENTIFIED BY 'no-default-test'"}}, "result", step);
            session.request({{"type", "execute"}, {"sql", "CREATE TABLE PROTO_TEST (ID INTEGER PRIMARY KEY, TXT VARCHAR)"}}, "result", step);
            for (int i = 0; i < 9; ++i)
                session.request({{"type", "execute"}, {"sql", "INSERT INTO PROTO_TEST VALUES (?, ?)"}, {"params", {i, "한글😀"}}}, "result", step);
            auto rows = session.request({{"type", "execute"}, {"sql", "SELECT * FROM PROTO_TEST ORDER BY ID"}, {"fetchSize", 3}}, "result", step);
            std::size_t count = rows["rows"].size();
            while (rows["hasMore"].get<bool>()) {
                rows = session.request({{"type", "fetch"}, {"cursor", rows["cursor"]}, {"fetchSize", 3}}, "rows", step);
                count += rows["rows"].size();
            }
            check(count == 9, "fetch multiple batches");
            auto early = session.request({{"type", "execute"}, {"sql", "SELECT * FROM PROTO_TEST"}, {"fetchSize", 1}}, "result", step);
            session.request({{"type", "closeCursor"}, {"cursor", early["cursor"]}}, "cursorClosed", step);
            try { session.request({{"type", "execute"}, {"sql", "SELECT MISSING_COLUMN FROM PROTO_TEST"}}, "result", step); check(false, "missing column accepted"); }
            catch (const DriverError& error) { check(error.state == "42703", "SQL diagnostic preserved"); }
            session.request({{"type", "ping"}}, "pong", step);
        }
        session.close();
        std::cout << "PASS " << scenario << '\n';
        return 0;
    } catch (const DriverError& error) {
        // 비밀이나 서버의 원문을 출력하지 않는다. 결함 주입 시험은 상태/번호만 비교한다.
        std::cerr << "STATE=" << error.state << " NATIVE=" << error.native << '\n';
        return 2;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
