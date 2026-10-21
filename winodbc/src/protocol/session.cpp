#include "hwdbodbc/protocol.hpp"

namespace hwdbodbc {
Session::Session(std::unique_ptr<Transport> transport) : transport_(std::move(transport)) {
    reader_ = std::thread([this] { read_loop(); });
}
Session::~Session() { abort(); if (reader_.joinable()) reader_.join(); }
void Session::fail(std::exception_ptr error) noexcept {
    {
        std::lock_guard<std::mutex> lock(authentication_mutex_);
        dead_ = true;
    }
    authentication_condition_.notify_all();
    transport_->abort();
    std::lock_guard<std::mutex> lock(pending_mutex_);
    if (!failure_) failure_ = error;
    for (auto& item : pending_) {
        try { item.second->set_exception(failure_); } catch (...) {}
    }
    pending_.clear();
}
void Session::abort() noexcept {
    try { throw DriverError("08S01", "Connection was closed.", 8006); }
    catch (...) { fail(std::current_exception()); }
}
void Session::read_loop() noexcept {
    try {
        while (!dead_) {
            const auto message = parse_message(transport_->receive(authenticated_ ? 16777216 : 65536));
            validate_response(message);
            const auto id = integer_field(message, "id");
            const auto type = string_field(message, "type");
            const std::set<std::string> known{"helloOk", "authChallenge", "authOk", "rows", "ok", "prepared", "description",
                "preparedClosed", "cancelAck", "cursorClosed", "pong", "bye", "error"};
            if (!known.count(type)) throw DriverError("08S01", "Unknown protocol response type.", 8000);
            if (id == 0) {
                if (type != "error") throw DriverError("08S01", "Unexpected unsolicited response.", 8000);
                const auto state = string_field(message, "sqlState");
                const auto text = string_field(message, "message");
                throw DriverError(state.c_str(), text.c_str(), static_cast<SQLINTEGER>(integer_field(message, "code", INT_MAX)));
            }
            std::shared_ptr<std::promise<Json>> promise;
            {
                std::lock_guard<std::mutex> lock(pending_mutex_);
                const auto found = pending_.find(id);
                if (found == pending_.end()) throw DriverError("08S01", "Response id does not match a pending request.", 8000);
                promise = found->second;
                pending_.erase(found);
            }
            promise->set_value(message);
            if (type == "authOk") {
                // 서버 서명을 검증하기 전에는 다음 프레임을 읽거나 인증 후 크기로 할당하지 않는다.
                std::unique_lock<std::mutex> lock(authentication_mutex_);
                authentication_condition_.wait(lock, [&] { return authenticated_.load() || dead_.load(); });
            }
        }
    } catch (...) { fail(std::current_exception()); }
}
Json Session::request(Json message, const std::string& expected, unsigned timeout_seconds) {
    auto promise = std::make_shared<std::promise<Json>>();
    auto future = promise->get_future();
    {
        std::lock_guard<std::mutex> send_lock(send_mutex_);
        {
            std::lock_guard<std::mutex> lock(pending_mutex_);
            if (failure_) std::rethrow_exception(failure_);
            if (dead_ || next_id_ > 9007199254740991ULL) throw DriverError("08S01", "Connection is no longer usable.", 8006);
            message["id"] = next_id_;
            pending_.emplace(next_id_++, promise);
        }
        try {
            const auto body = message.dump();
            if (body.size() > (authenticated_ ? 16777216U : 65536U)) throw DriverError("54000", "Protocol message size exceeds the limit.", 8003);
            transport_->send(body);
        } catch (...) { fail(std::current_exception()); throw; }
    }
    if (timeout_seconds && future.wait_for(std::chrono::seconds(timeout_seconds)) == std::future_status::timeout) {
        try { throw DriverError("HYT01", "Response timeout expired."); }
        catch (...) { fail(std::current_exception()); throw; }
    }
    auto result = future.get();
    const auto type = string_field(result, "type");
    if (type == "error") {
        const auto state = string_field(result, "sqlState");
        if (state.size() != 5 || state.find_first_not_of("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ") != std::string::npos) {
            abort(); throw DriverError("08S01", "Invalid server SQLSTATE.", 8000);
        }
        const auto text = string_field(result, "message");
        throw DriverError(state.c_str(), text.c_str(), static_cast<SQLINTEGER>(integer_field(result, "code", INT_MAX)));
    }
    if (type != expected && !(expected == "result" && (type == "rows" || type == "ok"))) {
        abort(); throw DriverError("08S01", "Unexpected response for request.", 8000);
    }
    return result;
}
void Session::login(const std::string& user, std::string_view password, const std::string& tablespace,
    const std::string& time_zone, unsigned timeout_seconds) {
    try {
        const auto hello = request({{"type", "hello"}, {"versions", {1}}, {"mechanisms", {"SCRAM-SHA-256"}}, {"client", "HelloWorldDB winodbc"}}, "helloOk", timeout_seconds);
        if (integer_field(hello, "version") != 1 || string_field(hello, "mechanism") != "SCRAM-SHA-256"
            || integer_field(hello, "maxMessageBytes") != 16777216)
            throw DriverError("08006", "Server protocol negotiation failed.", 8006);
        if (hello.contains("capabilities")) {
            if (!hello["capabilities"].is_array()) throw DriverError("08S01", "Invalid capabilities list.", 8000);
            for (const auto& item : hello["capabilities"]) {
                if (!item.is_string()) throw DriverError("08S01", "Invalid capability name.", 8000);
                capabilities.insert(item.get<std::string>());
            }
        }
        Scram scram(user);
        Json start{{"type", "authStart"}, {"mechanism", "SCRAM-SHA-256"}, {"clientFirst", scram.first()}};
        if (!tablespace.empty()) start["tablespace"] = tablespace;
        if (!time_zone.empty()) start["timeZone"] = time_zone;
        const auto challenge = request(start, "authChallenge", timeout_seconds);
        const auto proof = scram.challenge(string_field(challenge, "serverFirst"), password);
        const auto finish = request({{"type", "authFinish"}, {"clientFinal", proof}}, "authOk", timeout_seconds);
        scram.verify(string_field(finish, "serverFinal"));
        const auto session = finish.find("session");
        if (session == finish.end() || !session->is_object() || !session->contains("tablespace")
            || (!(*session)["tablespace"].is_null() && !(*session)["tablespace"].is_string())
            || !session->contains("autocommit") || !(*session)["autocommit"].is_boolean())
            throw DriverError("08S01", "Invalid session information.", 8000);
        static_cast<void>(integer_field(*session, "id"));
        static_cast<void>(string_field(*session, "user"));
        static_cast<void>(string_field(*session, "timeZone"));
        information = *session;
        {
            std::lock_guard<std::mutex> lock(authentication_mutex_);
            authenticated_ = true;
        }
        authentication_condition_.notify_all();
    } catch (...) { abort(); throw; }
}
void Session::close() {
    if (!dead_) {
        try { static_cast<void>(request({{"type", "close"}}, "bye", 5)); }
        catch (...) { abort(); throw; }
    }
    abort();
}
} // namespace hwdbodbc
