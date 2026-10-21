#include "hwdbodbc/protocol.hpp"
#include "../helpers/check.hpp"

using namespace hwdbodbc;
int main() {
    return run_checks([] {
        auto rejects = [](const std::string& text) {
            try { parse_message(text); check(false, "invalid JSON accepted"); }
            catch (const DriverError&) {}
        };
        check(parse_message("{\"a\":9223372036854775807}")["a"].get<std::int64_t>() == INT64_MAX, "JSON integer precision");
        rejects("{\"a\":1,\"a\":2}");
        rejects("{\"a\":{\"b\":1,\"b\":2}}");
        rejects("{\"a\":\"\\ud800\"}");
        rejects("[]");
        check(parse_message("{}").empty(), "empty object parses before envelope validation");
        rejects(std::string("{\"a\":") + std::string(70, '[') + "0" + std::string(70, ']') + "}");
        check(integer_field(parse_message("{\"id\":9007199254740991}"), "id") == 9007199254740991ULL, "safe integer boundary");
        for (const auto& text : {"{\"id\":-1}", "{\"id\":9007199254740992}", "{\"id\":1.5}", "{\"id\":\"1\"}"}) {
            try { integer_field(parse_message(text), "id"); check(false, "invalid id accepted"); }
            catch (const DriverError&) {}
        }
        for (const auto& message : std::vector<Json>{
            {{"id",1},{"type","rows"},{"rows",{{1}}},{"hasMore","false"}},
            {{"id",1},{"type","rows"},{"rows",Json::array()},{"hasMore",true},{"cursor",1}},
            {{"id",1},{"type","rows"},{"rows",Json::array()},{"hasMore",false},{"cursor","bad"}},
            {{"id",1},{"type","ok"},{"message","OK"},{"rowCount",-1}},
            {{"id",1},{"type","error"},{"sqlState","bad"},{"code",1},{"message","Invalid"}},
            {{"id",1},{"type","error"},{"sqlState","42000"},{"code",1},{"message","Invalid"},{"position","bad"}},
            {{"id",1},{"type","cancelAck"},{"targetId",2},{"status","invalid"}} }) {
            try { validate_response(message); check(false, "invalid response accepted"); }
            catch (const DriverError& error) { check(error.state == "08S01", "response validation diagnostic"); }
        }
        Scram scram("user=,한글");
        const auto first = scram.first();
        check(first.rfind("n,,n=user=3D=2C한글,r=", 0) == 0, "SCRAM username escaping");
        const auto nonce = first.substr(first.find(",r=") + 3);
        for (const auto* count : {"0", "10000001", "-1", "not-a-number"}) {
            try { scram.challenge("r=" + nonce + "SERVER,s=c2FsdA==,i=" + count, "password"); check(false, "invalid SCRAM iterations accepted"); }
            catch (const DriverError& error) { check(error.state == "08006", "SCRAM iteration diagnostic"); }
        }
    });
}
