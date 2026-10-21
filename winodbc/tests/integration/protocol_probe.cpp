#include "hwdbodbc/protocol.hpp"
#include "../helpers/check.hpp"
#include <iostream>

using namespace hwdbodbc;
int main(int argc, char** argv) {
    try {
        check(argc == 3, "usage: hwdb_protocol_probe PORT scenario");
        const auto port = static_cast<unsigned short>(std::stoul(argv[1]));
        const std::string scenario = argv[2];
        Session session(tcp_transport("127.0.0.1", port, 3));
        if (scenario == "hello") {
            const auto result = session.request({{"type", "hello"}, {"versions", {1}}}, "helloOk", 2);
            check(integer_field(result, "version") == 1, "hello response");
            std::cout << "PASS hello\n";
            return 0;
        }
        if (scenario == "wrong") {
            try { session.login("SYSTEM", "wrong-test-password", {}, {}, 3); }
            catch (const DriverError& error) {
                check(error.state == "28000" && error.native == 7000, "wrong password diagnostic");
                std::cout << "PASS wrong password\n";
                return 0;
            }
            check(false, "wrong password accepted");
        }
        session.login(scenario == "nullspace" ? "NO_DEFAULT" : "SYSTEM",
            scenario == "nfkc" ? "Ａ①가\u0301😀" : scenario == "nullspace" ? "no-default-test" : "HelloWorldDB", {}, {}, 3);
        if (scenario == "auth") { session.close(); std::cout << "PASS auth\n"; return 0; }
        if (scenario == "nullspace") check(session.information["tablespace"].is_null(), "null default tablespace");
        const auto result = session.request({{"type", "execute"}, {"sql", "SELECT 1"}}, "result", 3);
        check(result["rows"] == Json::array({Json::array({1})}), "SELECT 1 result");
        if (scenario == "basic") {
            session.request({{"type", "execute"}, {"sql", "CREATE USER NO_DEFAULT IDENTIFIED BY 'no-default-test'"}}, "result", 3);
            session.request({{"type", "execute"}, {"sql", "CREATE TABLE PROTO_TEST (ID INTEGER PRIMARY KEY, TXT VARCHAR)"}}, "result", 3);
            for (int i = 0; i < 9; ++i)
                session.request({{"type", "execute"}, {"sql", "INSERT INTO PROTO_TEST VALUES (?, ?)"}, {"params", {i, "한글😀"}}}, "result", 3);
            auto rows = session.request({{"type", "execute"}, {"sql", "SELECT * FROM PROTO_TEST ORDER BY ID"}, {"fetchSize", 3}}, "result", 3);
            std::size_t count = rows["rows"].size();
            while (rows["hasMore"].get<bool>()) {
                rows = session.request({{"type", "fetch"}, {"cursor", rows["cursor"]}, {"fetchSize", 3}}, "rows", 3);
                count += rows["rows"].size();
            }
            check(count == 9, "fetch multiple batches");
            auto early = session.request({{"type", "execute"}, {"sql", "SELECT * FROM PROTO_TEST"}, {"fetchSize", 1}}, "result", 3);
            session.request({{"type", "closeCursor"}, {"cursor", early["cursor"]}}, "cursorClosed", 3);
            try { session.request({{"type", "execute"}, {"sql", "SELECT MISSING_COLUMN FROM PROTO_TEST"}}, "result", 3); check(false, "missing column accepted"); }
            catch (const DriverError& error) { check(error.state == "42703", "SQL diagnostic preserved"); }
            session.request({{"type", "ping"}}, "pong", 3);
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
