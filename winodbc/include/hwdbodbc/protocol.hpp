#pragma once
#include "hwdbodbc/text.hpp"
#include <nlohmann/json.hpp>
#include <atomic>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <thread>
#include <set>
#include <condition_variable>
#include <chrono>

namespace hwdbodbc {
using Json = nlohmann::json;
using TransportDeadline = std::chrono::steady_clock::time_point;
Json parse_message(std::string_view body);
void validate_response(const Json& message);
std::string string_field(const Json& object, const char* key);
std::uint64_t integer_field(const Json& object, const char* key, std::uint64_t maximum = 9007199254740991ULL);

class Transport {
public:
    virtual ~Transport() = default;
    virtual void send(std::string_view body, TransportDeadline deadline = TransportDeadline::max()) = 0;
    virtual std::string receive(std::size_t limit) = 0;
    virtual void abort() noexcept = 0;
};
std::unique_ptr<Transport> tcp_transport(const std::string& host, unsigned short port, unsigned timeout_seconds,
    TransportDeadline deadline = TransportDeadline::max());

class Scram {
    std::string nonce_;
    std::string first_;
    std::string signature_;
public:
    explicit Scram(const std::string& user);
    ~Scram();
    std::string first() const { return "n,," + first_; }
    std::string challenge(const std::string& server_first, std::string_view password);
    void verify(const std::string& final) const;
};

class Session;
struct OperationControl;
// 실행 mutex와 분리하여 취소 스레드가 요청 ID와 수명만 공유한다.
struct RequestControl {
    std::shared_ptr<Session> session;
    std::shared_ptr<OperationControl> operation;
    std::atomic<std::uint64_t> id{0};
    std::atomic<bool> cancel_requested{false}, cancel_sent{false};
    std::atomic<bool> completed{false}, finished{false};
};
class Session {
    std::unique_ptr<Transport> transport_;
    std::thread reader_;
    std::timed_mutex send_mutex_;
    std::mutex pending_mutex_;
    std::mutex authentication_mutex_;
    std::condition_variable authentication_condition_;
    struct Pending { std::shared_ptr<std::promise<Json>> response; std::shared_ptr<RequestControl> control; };
    std::map<std::uint64_t, Pending> pending_;
    std::uint64_t next_id_ = 1;
    std::atomic<bool> dead_{false};
    std::atomic<bool> authenticated_{false};
    std::exception_ptr failure_;
    void read_loop() noexcept;
    void fail(std::exception_ptr error) noexcept;
public:
    Json information;
    std::set<std::string> capabilities;
    explicit Session(std::unique_ptr<Transport> transport);
    ~Session();
    Session(const Session&) = delete;
    Session& operator=(const Session&) = delete;
    bool dead() const noexcept { return dead_; }
    Json request(Json message, const std::string& expected, unsigned timeout_seconds = 0,
        const std::shared_ptr<RequestControl>& control = {}, unsigned query_timeout_seconds = 0,
        TransportDeadline outer_deadline = TransportDeadline::max());
    void cancel(const std::shared_ptr<RequestControl>& control);
    void login(const std::string& user, std::string_view password, const std::string& tablespace = {},
        const std::string& time_zone = {}, unsigned timeout_seconds = 0, TransportDeadline deadline = TransportDeadline::max());
    void close();
    void abort() noexcept;
};
} // namespace hwdbodbc
