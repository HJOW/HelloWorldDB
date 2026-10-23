#pragma once
#include "hwdbodbc/text.hpp"
#include <nlohmann/json.hpp>
#include <atomic>
#include <condition_variable>
#include <chrono>
#include <cstdint>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <thread>
#include <vector>

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

// TLS(Schannel) 접속 설정이다. 검증은 기본으로 켠다.
struct TlsOptions {
    bool verify = true;
    // SSLCA 파일에서 읽은 DER 인증서들이다. 비어 있으면 Windows 시스템 저장소를 신뢰한다.
    std::vector<std::vector<std::uint8_t>> caCertificates;
    // 접속 대상 호스트이다. 인증서 이름 검증과 SNI에 쓴다.
    std::string serverName;
};
// Schannel로 TCP에 연결하고 TLS 핸드셰이크와 인증서 검증을 마친 전송을 돌려준다.
// 인증서 오류이면 100 ms 뒤 새 연결로 최대 2회 다시 시도한다(연결 시도는 최대 3번).
// 인증서 오류가 아닌 실패(연결 거부, 시간 초과, 평문 서버 등)는 바로 실패한다.
std::unique_ptr<Transport> tls_transport(const std::string& host, unsigned short port, unsigned timeout_seconds,
    TransportDeadline deadline, TlsOptions options);
// Schannel 오류가 인증서 오류인지 본다. 재시도는 이 경우에만 한다.
bool tls_is_certificate_error(long status) noexcept;
// PEM 파일의 인증서들을 DER로 읽는다. 파일이 없거나 인증서가 없으면 HY024이다.
std::vector<std::vector<std::uint8_t>> tls_load_pem_certificates(const std::string& path);

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
