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
        if (item.second.control) item.second.control->completed = true;
        try { item.second.response->set_exception(failure_); } catch (...) {}
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
            Pending pending;
            {
                std::lock_guard<std::mutex> lock(pending_mutex_);
                const auto found = pending_.find(id);
                if (found == pending_.end()) throw DriverError("08S01", "Response id does not match a pending request.", 8000);
                pending = found->second;
                pending_.erase(found);
            }
            if (pending.control) pending.control->completed = true;
            pending.response->set_value(message);
            if (type == "authOk") {
                // 서버 서명을 검증하기 전에는 다음 프레임을 읽거나 인증 후 크기로 할당하지 않는다.
                std::unique_lock<std::mutex> lock(authentication_mutex_);
                authentication_condition_.wait(lock, [&] { return authenticated_.load() || dead_.load(); });
            }
        }
    } catch (...) { fail(std::current_exception()); }
}
void Session::cancel(const std::shared_ptr<RequestControl>& control) {
    control->cancel_requested = true;
    if (control->completed || control->finished) return;
    if (!capabilities.count("cancel")) throw DriverError("HYC00", "The server does not support cancellation.");
    const auto id = control->id.load();
    if (!id) return; // 전송 직전의 취소는 원래 요청을 보낸 스레드가 처리한다.
    if (control->cancel_sent.exchange(true)) return;
    try {
        for (unsigned attempt = 0; attempt < 20 && !control->completed && !control->finished; ++attempt) {
            const auto response = request({{"type","cancel"},{"targetId",id}},"cancelAck",2);
            if (integer_field(response,"targetId") != id) { abort(); throw DriverError("08S01", "Cancellation response identity mismatch.",8000); }
            const auto status = string_field(response,"status");
            if (status == "accepted" || status == "tooLate") return;
            if (status != "notRunning") { abort(); throw DriverError("08S01", "Invalid cancellation status.",8000); }
            // 서버가 실행 대기열에서 막 꺼내는 경합에서 같은 ID만 다시 취소한다.
            if (!control->completed) std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        control->cancel_sent = false;
    } catch (...) { control->cancel_sent = false; throw; }
}
Json Session::request(Json message, const std::string& expected, unsigned timeout_seconds,
    const std::shared_ptr<RequestControl>& control, unsigned query_timeout_seconds, TransportDeadline outer_deadline) {
    struct Finish { std::shared_ptr<RequestControl> control; ~Finish() { if (control) control->finished = true; } } finish{control};
    const bool query_limit = query_timeout_seconds && (!timeout_seconds || query_timeout_seconds <= timeout_seconds);
    const auto timeout = query_limit ? query_timeout_seconds : timeout_seconds;
    const char* timeout_state = query_limit ? "HYT00" : "HYT01";
    const auto deadline = (std::min)(outer_deadline,timeout ? std::chrono::steady_clock::now() + std::chrono::seconds(timeout) : TransportDeadline::max());
    auto promise = std::make_shared<std::promise<Json>>();
    auto future = promise->get_future();
    {
        std::unique_lock<std::timed_mutex> send_lock(send_mutex_,std::defer_lock);
        if (deadline == TransportDeadline::max()) send_lock.lock();
        else if (!send_lock.try_lock_until(deadline)) {
            try { throw DriverError(timeout_state,"Timed out waiting for the protocol sender; connection discarded."); }
            catch (...) { fail(std::current_exception()); throw; }
        }
        {
            std::lock_guard<std::mutex> lock(pending_mutex_);
            if (failure_) std::rethrow_exception(failure_);
            if (dead_ || next_id_ > 9007199254740991ULL) throw DriverError("08S01", "Connection is no longer usable.", 8006);
            message["id"] = next_id_;
            if (control) control->id = next_id_;
            pending_.emplace(next_id_++, Pending{promise,control});
        }
        try {
            const auto body = message.dump();
            if (body.size() > (authenticated_ ? 16777216U : 65536U)) throw DriverError("54000", "Protocol message size exceeds the limit.", 8003);
            transport_->send(body,deadline);
        } catch (const DriverError& error) {
            fail(std::current_exception());
            if (query_limit && error.state == "HYT01") throw DriverError("HYT00","Timed out sending the statement; connection discarded.",error.native);
            throw;
        } catch (...) { fail(std::current_exception()); throw; }
    }
    if (control && control->cancel_requested) cancel(control);
    bool expired = false, cancel_failed = false;
    if (deadline != TransportDeadline::max() && future.wait_until(deadline) == std::future_status::timeout) {
        expired = true;
        if (control) {
            try { cancel(control); } catch (...) { cancel_failed = true; }
            if (future.wait_for(std::chrono::seconds(2)) != std::future_status::ready) {
                try { throw DriverError(timeout_state,"Operation timed out before completion could be determined; connection discarded."); }
                catch (...) { fail(std::current_exception()); throw; }
            }
        } else {
            try { throw DriverError("HYT01", "Response timeout expired."); }
            catch (...) { fail(std::current_exception()); throw; }
        }
    }
    Json result;
    try { result = future.get(); }
    catch (const DriverError& error) {
        if (expired && cancel_failed && (error.state == "HYT01" || error.state == "08S01"))
            throw DriverError(timeout_state,"Operation timed out while synchronizing cancellation; connection discarded [original state " + error.state + "].",error.native);
        throw;
    }
    const auto type = string_field(result, "type");
    if (type == "error") {
        const auto state = string_field(result, "sqlState");
        if (state.size() != 5 || state.find_first_not_of("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ") != std::string::npos) {
            abort(); throw DriverError("08S01", "Invalid server SQLSTATE.", 8000);
        }
        const auto text = string_field(result, "message");
        if (control && state == "57014")
            throw DriverError(expired ? timeout_state : "HY008",text + " [original state 57014].",static_cast<SQLINTEGER>(integer_field(result,"code",INT_MAX)));
        throw DriverError(state.c_str(), text.c_str(), static_cast<SQLINTEGER>(integer_field(result, "code", INT_MAX)));
    }
    if (type != expected && !(expected == "result" && (type == "rows" || type == "ok"))) {
        abort(); throw DriverError("08S01", "Unexpected response for request.", 8000);
    }
    return result;
}
void Session::login(const std::string& user, std::string_view password, const std::string& tablespace,
    const std::string& time_zone, unsigned timeout_seconds, TransportDeadline outer_deadline) {
    try {
        const auto deadline = (std::min)(outer_deadline,timeout_seconds ? std::chrono::steady_clock::now() + std::chrono::seconds(timeout_seconds) : TransportDeadline::max());
        const auto handshake = [&](Json message, const char* expected) { return request(std::move(message),expected,0,{},0,deadline); };
        const auto hello = handshake({{"type", "hello"}, {"versions", {1}}, {"mechanisms", {"SCRAM-SHA-256"}}, {"client", "HelloWorldDB winodbc"}}, "helloOk");
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
        const auto challenge = handshake(start, "authChallenge");
        const auto proof = scram.challenge(string_field(challenge, "serverFirst"), password);
        const auto finish = handshake({{"type", "authFinish"}, {"clientFinal", proof}}, "authOk");
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
