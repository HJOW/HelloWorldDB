// Schannel TLS 전송이다. TCP 소켓 위에 TLS를 얹어 공통 Transport로 제공한다.
//
// - 핸드셰이크는 블로킹으로 수행하고 DNS·연결·핸드셰이크에 로그인 제한 시간을 누적 적용한다.
// - 인증서 검증은 수동으로 한다. 시스템 저장소 또는 SSLCA의 PEM을 배타적 루트로 쓰는
//   체인 엔진으로 체인을 만들고 SSL 정책으로 기간·이름을 확인한다.
//   "암호화가 켜짐"만으로 검증을 마쳤다고 판단하지 않는다.
// - 검증 끄기는 명시 옵션에서만 허용한다.
// - 인증서 오류에만 100 ms 뒤 새 연결로 최대 2회 다시 시도한다. 그 밖의 실패는 바로 실패한다.
#include <winsock2.h>
#include <ws2tcpip.h>
#define SECURITY_WIN32
#include <security.h>
#include <schannel.h>
#include <wincrypt.h>
#include "hwdbodbc/protocol.hpp"
#include <chrono>
#include <cstdio>
#include <cstring>
#include <thread>
#include <vector>

namespace hwdbodbc {
namespace {
using Clock = std::chrono::steady_clock;

struct Winsock {
    Winsock() { WSADATA data{}; if (WSAStartup(MAKEWORD(2, 2), &data)) throw DriverError("08001", "Winsock initialization failed."); }
    ~Winsock() { WSACleanup(); }
};

// 인증서 오류로 다시 시도할 때 던진다. 최종 오류는 08001/8007로 바꾼다.
struct TlsCertFailure {
    std::string cause;
    std::string detail;
};

[[noreturn]] void throw_cert_failure(const std::string& cause, const std::string& detail) {
    throw TlsCertFailure{cause, detail};
}

std::string status_text(long status) {
    char text[32]{};
    std::snprintf(text, sizeof(text), "0x%08lX", static_cast<unsigned long>(status));
    return text;
}

struct SocketGuard {
    SOCKET value = INVALID_SOCKET;
    explicit SocketGuard(SOCKET socket) : value(socket) {}
    ~SocketGuard() { if (value != INVALID_SOCKET) closesocket(value); }
    SocketGuard(const SocketGuard&) = delete;
    SocketGuard& operator=(const SocketGuard&) = delete;
    SOCKET release() { const SOCKET socket = value; value = INVALID_SOCKET; return socket; }
};

struct CredGuard {
    CredHandle value{};
    bool owned = false;
    CredGuard() = default;
    ~CredGuard() { if (owned) FreeCredentialsHandle(&value); }
    CredGuard(const CredGuard&) = delete;
    CredGuard& operator=(const CredGuard&) = delete;
    CredHandle release() { owned = false; return value; }
};

struct ContextGuard {
    CtxtHandle value{};
    bool owned = false;
    ContextGuard() = default;
    ~ContextGuard() { if (owned) DeleteSecurityContext(&value); }
    ContextGuard(const ContextGuard&) = delete;
    ContextGuard& operator=(const ContextGuard&) = delete;
    CtxtHandle release() { owned = false; return value; }
};

struct CertStoreGuard {
    HCERTSTORE value = nullptr;
    explicit CertStoreGuard(HCERTSTORE store) : value(store) {}
    ~CertStoreGuard() { if (value) CertCloseStore(value, 0); }
    CertStoreGuard(const CertStoreGuard&) = delete;
    CertStoreGuard& operator=(const CertStoreGuard&) = delete;
};

struct CertContextGuard {
    PCCERT_CONTEXT value = nullptr;
    explicit CertContextGuard(PCCERT_CONTEXT context) : value(context) {}
    ~CertContextGuard() { if (value) CertFreeCertificateContext(value); }
    CertContextGuard(const CertContextGuard&) = delete;
    CertContextGuard& operator=(const CertContextGuard&) = delete;
};

struct ChainGuard {
    PCCERT_CHAIN_CONTEXT value = nullptr;
    explicit ChainGuard(PCCERT_CHAIN_CONTEXT chain) : value(chain) {}
    ~ChainGuard() { if (value) CertFreeCertificateChain(value); }
    ChainGuard(const ChainGuard&) = delete;
    ChainGuard& operator=(const ChainGuard&) = delete;
};

struct ChainEngineGuard {
    HCERTCHAINENGINE value = nullptr;
    explicit ChainEngineGuard(HCERTCHAINENGINE engine) : value(engine) {}
    ~ChainEngineGuard() { if (value) CertFreeCertificateChainEngine(value); }
    ChainEngineGuard(const ChainEngineGuard&) = delete;
    ChainEngineGuard& operator=(const ChainEngineGuard&) = delete;
};

void wait_writable(SOCKET socket, TransportDeadline deadline, std::atomic<bool>& stopped) {
    while (!stopped.load()) {
        if (Clock::now() >= deadline) throw DriverError("HYT01", "Socket transfer timeout expired.");
        fd_set descriptors;
        FD_ZERO(&descriptors);
        FD_SET(socket, &descriptors);
        timeval timeout{0, 100000};
        const auto rc = select(0, nullptr, &descriptors, nullptr, &timeout);
        if (rc > 0) return;
        if (rc < 0) throw DriverError("08S01", "Socket polling failed.", WSAGetLastError());
    }
    throw DriverError("08S01", "Connection was closed.", 8006);
}

void wait_readable(SOCKET socket, TransportDeadline deadline, std::atomic<bool>& stopped) {
    while (!stopped.load()) {
        if (Clock::now() >= deadline) throw DriverError("HYT01", "Socket transfer timeout expired.");
        fd_set descriptors;
        FD_ZERO(&descriptors);
        FD_SET(socket, &descriptors);
        timeval timeout{0, 100000};
        const auto rc = select(0, &descriptors, nullptr, nullptr, &timeout);
        if (rc > 0) return;
        if (rc < 0) throw DriverError("08S01", "Socket polling failed.", WSAGetLastError());
    }
    throw DriverError("08S01", "Connection was closed.", 8006);
}

// 성공하면 받은 바이트 수, 정상 종료이면 0을 돌려준다.
// 핸드셰이크 중의 끊김·리셋은 연결 수립 실패(08001)이며 인증서 오류가 아니므로 재시도하지 않는다.
int raw_receive(SOCKET socket, char* data, std::size_t size, TransportDeadline deadline, std::atomic<bool>& stopped, bool handshake) {
    for (;;) {
        wait_readable(socket, deadline, stopped);
        const auto count = static_cast<int>((std::min)(size, static_cast<std::size_t>(INT_MAX)));
        const auto rc = recv(socket, data, count, 0);
        if (rc > 0) return rc;
        if (rc == 0) {
            if (handshake) throw DriverError("08001", "The server closed the connection during the TLS handshake.", 8007);
            return 0;
        }
        if (WSAGetLastError() == WSAEWOULDBLOCK) continue;
        if (handshake) throw DriverError("08001", "TLS handshake failed: the connection was reset.", 8007);
        throw DriverError("08S01", "Connection interrupted during transfer.", 8006);
    }
}

// tcp.cpp의 연결과 같은 제한 시간 규칙이다. DNS·연결에 outer_deadline을 누적 적용한다.
SOCKET tcp_connect(const std::string& host, unsigned short port, unsigned timeout_seconds, TransportDeadline outer_deadline, std::atomic<bool>& stopped) {
    static Winsock winsock;
    const auto deadline = (std::min)(outer_deadline, timeout_seconds ? Clock::now() + std::chrono::seconds(timeout_seconds) : TransportDeadline::max());
    const auto name = utf16(host);
    const auto service = std::to_wstring(port);
    ADDRINFOEXW hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;
    PADDRINFOEXW addresses = nullptr;
    struct Event { HANDLE value = CreateEventW(nullptr, TRUE, FALSE, nullptr); ~Event() { if (value) CloseHandle(value); } } event;
    if (!event.value) throw DriverError("HY001", "Could not allocate the name resolution event.");
    OVERLAPPED overlapped{}; overlapped.hEvent = event.value; HANDLE resolver = nullptr;
    auto resolve = GetAddrInfoExW(name.c_str(), service.c_str(), NS_ALL, nullptr, &hints, &addresses, nullptr, &overlapped, nullptr, &resolver);
    bool expired = false;
    if (resolve == WSA_IO_PENDING) {
        const auto remaining = deadline == TransportDeadline::max() ? INFINITE
            : static_cast<DWORD>((std::max)(0LL, std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count()));
        const auto status = WaitForSingleObject(event.value, remaining);
        if (status != WAIT_OBJECT_0) {
            expired = status == WAIT_TIMEOUT;
            GetAddrInfoExCancel(&resolver);
            WaitForSingleObject(event.value, INFINITE);
        }
        resolve = GetAddrInfoExOverlappedResult(&overlapped);
    }
    std::unique_ptr<ADDRINFOEXW, decltype(&FreeAddrInfoExW)> guard(addresses, FreeAddrInfoExW);
    if (expired) throw DriverError("HYT01", "Name resolution timeout expired.");
    if (resolve) throw DriverError("08001", "Server address resolution failed.", resolve);
    int last_error = 0;
    for (auto address = addresses; address; address = address->ai_next) {
        if (Clock::now() >= deadline || stopped.load()) throw DriverError("HYT01", "Connection timeout expired.");
        const auto candidate = socket(address->ai_family, address->ai_socktype, address->ai_protocol);
        if (candidate == INVALID_SOCKET) { last_error = WSAGetLastError(); continue; }
        bool connected = false;
        u_long nonblocking = 1;
        if (ioctlsocket(candidate, FIONBIO, &nonblocking) == 0) {
            const auto rc = ::connect(candidate, address->ai_addr, static_cast<int>(address->ai_addrlen));
            if (rc == 0) connected = true;
            else if (WSAGetLastError() == WSAEWOULDBLOCK) {
                while (!stopped.load()) {
                    fd_set writable, errors;
                    FD_ZERO(&writable); FD_SET(candidate, &writable);
                    FD_ZERO(&errors); FD_SET(candidate, &errors);
                    timeval timeout{0, 100000};
                    const auto selected = select(0, nullptr, &writable, &errors, &timeout);
                    if (selected < 0) { last_error = WSAGetLastError(); break; }
                    if (selected > 0) {
                        int socket_error = 0;
                        int length = sizeof(socket_error);
                        if (getsockopt(candidate, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&socket_error), &length))
                            socket_error = WSAGetLastError();
                        connected = socket_error == 0;
                        last_error = socket_error;
                        break;
                    }
                    if (Clock::now() >= deadline) {
                        closesocket(candidate);
                        throw DriverError("HYT01", "Connection timeout expired.");
                    }
                }
            } else last_error = WSAGetLastError();
        } else last_error = WSAGetLastError();
        if (connected) {
            const BOOL enabled = TRUE;
            setsockopt(candidate, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&enabled), sizeof(enabled));
            setsockopt(candidate, SOL_SOCKET, SO_KEEPALIVE, reinterpret_cast<const char*>(&enabled), sizeof(enabled));
            return candidate;
        }
        closesocket(candidate);
    }
    throw DriverError("08001", "Could not connect to the server.", last_error);
}

void validate_certificate(PCCERT_CONTEXT remote, const TlsOptions& options) {
    // 체인 엔진: SSLCA가 있으면 그 저장소를 배타적 루트로만 신뢰하고, 없으면 시스템 저장소를 쓴다.
    CertStoreGuard extra(CertOpenStore(CERT_STORE_PROV_MEMORY, 0, 0, CERT_STORE_CREATE_NEW_FLAG, nullptr));
    if (!extra.value) throw DriverError("HY000", "Could not open the certificate store.");
    for (const auto& der : options.caCertificates) {
        PCCERT_CONTEXT added = nullptr;
        if (!CertAddEncodedCertificateToStore(extra.value, X509_ASN_ENCODING, const_cast<BYTE*>(der.data()),
                static_cast<DWORD>(der.size()), CERT_STORE_ADD_ALWAYS, &added))
            throw DriverError("HY000", "Could not load the CA certificate.");
        CertFreeCertificateContext(added);
    }
    ChainEngineGuard engine(nullptr);
    HCERTSTORE engine_extra = nullptr;
    if (!options.caCertificates.empty()) {
        CERT_CHAIN_ENGINE_CONFIG config{};
        config.cbSize = sizeof(config);
        config.hExclusiveRoot = extra.value;
        HCERTCHAINENGINE created = nullptr;
        if (!CertCreateCertificateChainEngine(&config, &created))
            throw DriverError("HY000", "Could not create the certificate chain engine.", static_cast<SQLINTEGER>(GetLastError()));
        engine.value = created;
        engine_extra = extra.value;
    }
    CERT_CHAIN_PARA para{};
    para.cbSize = sizeof(para);
    PCCERT_CHAIN_CONTEXT chain = nullptr;
    if (!CertGetCertificateChain(engine.value, remote, nullptr, engine_extra, &para,
            CERT_CHAIN_CACHE_END_CERT, nullptr, &chain))
        throw_cert_failure("CHAIN_BUILD_FAILED", "could not build the server certificate chain");
    ChainGuard chain_guard(chain);
    const auto server = utf16(options.serverName);
    HTTPSPolicyCallbackData https{};
    https.cbStruct = sizeof(https);
    https.cbSize = sizeof(https);
    https.dwAuthType = AUTHTYPE_SERVER;
    https.fdwChecks = 0;
    https.pwszServerName = const_cast<wchar_t*>(server.c_str());
    CERT_CHAIN_POLICY_PARA policy{};
    policy.cbSize = sizeof(policy);
    policy.pvExtraPolicyPara = &https;
    CERT_CHAIN_POLICY_STATUS status{};
    status.cbSize = sizeof(status);
    if (!CertVerifyCertificateChainPolicy(CERT_CHAIN_POLICY_SSL, chain, &policy, &status))
        throw_cert_failure("POLICY_CHECK_FAILED", "could not verify the server certificate chain");
    if (status.dwError == S_OK) return;
    const DWORD code = static_cast<DWORD>(status.dwError);
    if (code == CERT_E_EXPIRED) {
        // CryptoAPI는 기간의 앞뒤를 구분하지 않고 EXPIRED를 돌려준다. 방향을 직접 확인한다.
        const LONG when = CertVerifyTimeValidity(nullptr, remote->pCertInfo);
        if (when < 0)
            throw_cert_failure("CERT_NOT_YET_VALID", "the server certificate is not yet valid");
        throw_cert_failure("CERT_HAS_EXPIRED", "the server certificate has expired");
    }
    if (code == CERT_E_VALIDITYPERIODNESTING)
        throw_cert_failure("CERT_NOT_YET_VALID", "the server certificate chain validity does not nest");
    if (code == CERT_E_CN_NO_MATCH)
        throw_cert_failure("ERR_TLS_CERT_ALTNAME_INVALID",
            "the server certificate name does not match the connection target " + options.serverName);
    if (code == CERT_E_UNTRUSTEDROOT)
        throw_cert_failure("SELF_SIGNED_CERT_IN_CHAIN", "the server certificate chain is not trusted");
    char text[64]{};
    std::snprintf(text, sizeof(text), "0x%08lX", static_cast<unsigned long>(code));
    throw_cert_failure("CERT_UNTRUSTED", std::string("the server certificate chain is not valid (") + text + ")");
}

class TlsTransport final : public Transport {
    SOCKET socket_ = INVALID_SOCKET;
    CredHandle credential_{};
    CtxtHandle context_{};
    SecPkgContext_StreamSizes sizes_{};
    std::atomic<bool> stopped_{false};
    std::vector<char> encrypted_;
    std::string decrypted_;

    void raw_send_all(const char* data, std::size_t size, TransportDeadline deadline) {
        std::size_t offset = 0;
        while (offset < size) {
            wait_writable(socket_, deadline, stopped_);
            const auto count = static_cast<int>((std::min)(size - offset, static_cast<std::size_t>(INT_MAX)));
            const auto rc = ::send(socket_, data + offset, count, 0);
            if (rc > 0) { offset += static_cast<std::size_t>(rc); continue; }
            if (rc < 0 && WSAGetLastError() == WSAEWOULDBLOCK) continue;
            throw DriverError("08S01", "Connection interrupted during transfer.", 8006);
        }
    }

    int raw_recv_some(char* data, std::size_t size) {
        for (;;) {
            wait_readable(socket_, TransportDeadline::max(), stopped_);
            const auto count = static_cast<int>((std::min)(size, static_cast<std::size_t>(INT_MAX)));
            const auto rc = recv(socket_, data, count, 0);
            if (rc > 0) return rc;
            if (rc == 0) return 0;
            if (WSAGetLastError() == WSAEWOULDBLOCK) continue;
            throw DriverError("08S01", "Connection interrupted during transfer.", 8006);
        }
    }

public:
    TlsTransport(SOCKET socket, CredHandle credential, CtxtHandle context, SecPkgContext_StreamSizes sizes)
        : socket_(socket), credential_(credential), context_(context), sizes_(sizes) {}
    ~TlsTransport() override {
        abort();
        if (socket_ != INVALID_SOCKET) closesocket(socket_);
        DeleteSecurityContext(&context_);
        FreeCredentialsHandle(&credential_);
    }
    void send(std::string_view body, TransportDeadline deadline) override {
        if (body.empty() || body.size() > 16777216) throw DriverError("54000", "Protocol message size exceeds the limit.", 8003);
        const auto size = static_cast<std::uint32_t>(body.size());
        std::string frame(4 + body.size(), 0);
        for (unsigned i = 0; i < 4; ++i) frame[i] = static_cast<char>(size >> ((3 - i) * 8));
        std::memcpy(frame.data() + 4, body.data(), body.size());
        std::size_t offset = 0;
        std::vector<char> message(sizes_.cbHeader + sizes_.cbMaximumMessage + sizes_.cbTrailer);
        while (offset < frame.size()) {
            const auto chunk = (std::min)(static_cast<std::size_t>(sizes_.cbMaximumMessage), frame.size() - offset);
            SecBuffer buffers[4]{};
            buffers[0].BufferType = SECBUFFER_STREAM_HEADER;
            buffers[0].cbBuffer = sizes_.cbHeader;
            buffers[0].pvBuffer = message.data();
            buffers[1].BufferType = SECBUFFER_DATA;
            buffers[1].cbBuffer = static_cast<unsigned long>(chunk);
            buffers[1].pvBuffer = message.data() + sizes_.cbHeader;
            buffers[2].BufferType = SECBUFFER_STREAM_TRAILER;
            buffers[2].cbBuffer = sizes_.cbTrailer;
            buffers[2].pvBuffer = message.data() + sizes_.cbHeader + chunk;
            buffers[3].BufferType = SECBUFFER_EMPTY;
            SecBufferDesc desc{SECBUFFER_VERSION, 4, buffers};
            std::memcpy(message.data() + sizes_.cbHeader, frame.data() + offset, chunk);
            if (EncryptMessage(&context_, 0, &desc, 0) != SEC_E_OK)
                throw DriverError("08S01", "Could not encrypt the TLS record.", 8006);
            // EncryptMessage가 헤더·데이터·트레일러 크기를 실제 값으로 갱신한다. CBC 계열 스위트는 패딩 때문에
            // 트레일러가 cbTrailer보다 짧을 수 있어 고정값으로 보내면 뒤에 쓰레기 바이트가 붙어 레코드가 깨진다.
            raw_send_all(message.data(), buffers[0].cbBuffer + buffers[1].cbBuffer + buffers[2].cbBuffer, deadline);
            offset += chunk;
        }
    }
    std::string receive(std::size_t limit) override {
        // 복호화된 평문에서 완성된 프레임이 있으면 꺼낸다. 본문 길이가 0인 메시지는 없으므로
        // 빈 문자열 반환은 "아직 미완성"과 같다. 길이가 한도를 넘으면 위반이다.
        auto complete = [&]() -> std::string {
            if (decrypted_.size() < 4) return {};
            std::uint32_t size = 0;
            for (int i = 0; i < 4; ++i) size = (size << 8) | static_cast<unsigned char>(decrypted_[i]);
            if (!size || size > limit) throw DriverError("08S01", "Invalid frame length.", 8000);
            if (decrypted_.size() < 4 + size) return {};
            std::string body = decrypted_.substr(4, size);
            decrypted_.erase(0, 4 + size);
            return body;
        };
        for (;;) {
            if (auto body = complete(); !body.empty()) return body;
            char chunk[16384];
            const int received = raw_recv_some(chunk, sizeof(chunk));
            if (!received) {
                // FIN 뒤에 완성된 메시지가 남아 있으면 먼저 돌려준다.
                if (auto body = complete(); !body.empty()) return body;
                throw DriverError("08S01", "Connection interrupted during frame transfer.", 8006);
            }
            encrypted_.insert(encrypted_.end(), chunk, chunk + received);
            for (;;) {
                if (encrypted_.empty()) break;
                SecBuffer buffers[4]{};
                buffers[0].BufferType = SECBUFFER_DATA;
                buffers[0].cbBuffer = static_cast<unsigned long>(encrypted_.size());
                buffers[0].pvBuffer = encrypted_.data();
                buffers[1].BufferType = SECBUFFER_EMPTY;
                buffers[2].BufferType = SECBUFFER_EMPTY;
                buffers[3].BufferType = SECBUFFER_EMPTY;
                SecBufferDesc desc{SECBUFFER_VERSION, 4, buffers};
                ULONG quality = 0;
                const auto status = DecryptMessage(&context_, &desc, 0, &quality);
                if (status == SEC_E_INCOMPLETE_MESSAGE) break;
                if (status == SEC_I_CONTEXT_EXPIRED) {
                    // close_notify와 완성된 메시지가 함께 온 경우 메시지를 버리지 않는다.
                    if (auto body = complete(); !body.empty()) return body;
                    throw DriverError("08S01", "Connection interrupted during frame transfer.", 8006);
                }
                if (status == SEC_I_RENEGOTIATE)
                    throw DriverError("08S01", "TLS renegotiation is not supported.", 8006);
                if (status != SEC_E_OK)
                    throw DriverError("08S01", "Could not decrypt the TLS record.", 8006);
                SecBuffer* data = nullptr;
                SecBuffer* extra = nullptr;
                for (auto& buffer : buffers) {
                    if (buffer.BufferType == SECBUFFER_DATA) data = &buffer;
                    if (buffer.BufferType == SECBUFFER_EXTRA) extra = &buffer;
                }
                if (data && data->cbBuffer)
                    decrypted_.append(static_cast<const char*>(data->pvBuffer), data->cbBuffer);
                if (extra && extra->cbBuffer) {
                    const auto kept = static_cast<std::size_t>(extra->cbBuffer);
                    encrypted_.erase(encrypted_.begin(), encrypted_.end() - static_cast<std::ptrdiff_t>(kept));
                } else {
                    encrypted_.clear();
                }
            }
        }
    }
    void abort() noexcept override {
        if (!stopped_.exchange(true) && socket_ != INVALID_SOCKET) shutdown(socket_, SD_BOTH);
    }
};

} // namespace

bool tls_is_certificate_error(long status) noexcept {
    switch (status) {
    case SEC_E_WRONG_PRINCIPAL:
    case SEC_E_CERT_EXPIRED:
    case SEC_E_CERT_UNKNOWN:
    case SEC_E_UNTRUSTED_ROOT:
        return true;
    default:
        return false;
    }
}

std::vector<std::vector<std::uint8_t>> tls_load_pem_certificates(const std::string& path) {
    if (path.empty()) throw DriverError("HY024", "Invalid CA certificate path.");
    // 경로와 내용을 로그·진단에 남기지 않는다. 존재 여부만으로 판단하지 않고 해석까지 확인한다.
    HANDLE file = CreateFileA(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) throw DriverError("HY024", "Could not read the CA certificate file.");
    std::string text;
    char chunk[4096];
    DWORD read = 0;
    while (ReadFile(file, chunk, sizeof(chunk), &read, nullptr) && read) text.append(chunk, read);
    CloseHandle(file);
    std::vector<std::vector<std::uint8_t>> certificates;
    const std::string begin = "-----BEGIN CERTIFICATE-----";
    const std::string end = "-----END CERTIFICATE-----";
    std::size_t position = 0;
    while ((position = text.find(begin, position)) != std::string::npos) {
        const auto body = position + begin.size();
        const auto stop = text.find(end, body);
        if (stop == std::string::npos) throw DriverError("HY024", "Invalid CA certificate file.");
        DWORD decoded = 0;
        if (!CryptStringToBinaryA(text.data() + body, static_cast<DWORD>(stop - body),
                CRYPT_STRING_BASE64, nullptr, &decoded, nullptr, nullptr) || !decoded)
            throw DriverError("HY024", "Invalid CA certificate file.");
        std::vector<std::uint8_t> der(decoded);
        DWORD length = decoded;
        if (!CryptStringToBinaryA(text.data() + body, static_cast<DWORD>(stop - body),
                CRYPT_STRING_BASE64, der.data(), &length, nullptr, nullptr))
            throw DriverError("HY024", "Invalid CA certificate file.");
        der.resize(length);
        certificates.push_back(std::move(der));
        position = stop + end.size();
    }
    if (certificates.empty()) throw DriverError("HY024", "Invalid CA certificate file.");
    return certificates;
}

std::unique_ptr<Transport> tls_transport(const std::string& host, unsigned short port, unsigned timeout_seconds,
    TransportDeadline deadline, TlsOptions options) {
    if (options.serverName.empty()) options.serverName = host;
    std::string last_cause = "unknown error";
    std::string last_detail = "the TLS handshake failed";
    for (int attempt = 1; attempt <= 3; ++attempt) {
        try {
            std::atomic<bool> stopped{false};
            SocketGuard socket(tcp_connect(host, port, timeout_seconds, deadline, stopped));
            SCHANNEL_CRED credential{};
            credential.dwVersion = SCHANNEL_CRED_VERSION;
            credential.grbitEnabledProtocols = SP_PROT_TLS1_2_CLIENT | SP_PROT_TLS1_3_CLIENT;
            credential.dwFlags = SCH_CRED_MANUAL_CRED_VALIDATION;
            CredGuard cred;
            TimeStamp expiry{};
            if (AcquireCredentialsHandleW(nullptr, const_cast<wchar_t*>(UNISP_NAME_W),
                    SECPKG_CRED_OUTBOUND, nullptr, &credential, nullptr, nullptr, &cred.value, &expiry) != SEC_E_OK)
                throw DriverError("HY000", "Could not initialize TLS credentials.");
            cred.owned = true;
            const auto target = utf16(options.serverName.empty() ? host : options.serverName);
            ContextGuard context;
            bool have_context = false;
            std::vector<char> input;
            const DWORD request = ISC_REQ_SEQUENCE_DETECT | ISC_REQ_REPLAY_DETECT | ISC_REQ_CONFIDENTIALITY |
                ISC_REQ_ALLOCATE_MEMORY | ISC_REQ_STREAM;
            for (;;) {
                SecBuffer out_buffers[1]{};
                out_buffers[0].BufferType = SECBUFFER_TOKEN;
                SecBufferDesc out_desc{SECBUFFER_VERSION, 1, out_buffers};
                SecBuffer in_buffers[2]{};
                in_buffers[0].BufferType = SECBUFFER_TOKEN;
                in_buffers[0].cbBuffer = static_cast<unsigned long>(input.size());
                in_buffers[0].pvBuffer = input.empty() ? nullptr : input.data();
                in_buffers[1].BufferType = SECBUFFER_EMPTY;
                SecBufferDesc in_desc{SECBUFFER_VERSION, 2, in_buffers};
                DWORD attributes = 0;
                TimeStamp context_expiry{};
                const auto status = InitializeSecurityContextW(&cred.value, have_context ? &context.value : nullptr,
                    const_cast<wchar_t*>(target.c_str()), request, 0, SECURITY_NATIVE_DREP,
                    input.empty() ? nullptr : &in_desc, 0, &context.value, &out_desc, &attributes, &context_expiry);
                if (out_buffers[0].cbBuffer && out_buffers[0].pvBuffer) {
                    try {
                        std::size_t sent = 0;
                        while (sent < out_buffers[0].cbBuffer) {
                            wait_writable(socket.value, deadline, stopped);
                            const auto count = static_cast<int>((std::min)(
                                static_cast<std::size_t>(out_buffers[0].cbBuffer) - sent,
                                static_cast<std::size_t>(INT_MAX)));
                            const auto rc = ::send(socket.value,
                                static_cast<const char*>(out_buffers[0].pvBuffer) + sent, count, 0);
                            if (rc > 0) { sent += static_cast<std::size_t>(rc); continue; }
                            if (rc < 0 && WSAGetLastError() == WSAEWOULDBLOCK) continue;
                            throw DriverError("08S01", "Connection interrupted during the TLS handshake.", 8006);
                        }
                    } catch (...) { FreeContextBuffer(out_buffers[0].pvBuffer); throw; }
                    FreeContextBuffer(out_buffers[0].pvBuffer);
                }
                if (status == SEC_E_OK) {
                    have_context = true;
                    context.owned = true;
                    break;
                }
                if (status == SEC_I_CONTINUE_NEEDED) {
                    have_context = true;
                    context.owned = true;
                    if (in_buffers[1].BufferType == SECBUFFER_EXTRA && in_buffers[1].cbBuffer <= input.size()) {
                        const auto extra = static_cast<std::size_t>(in_buffers[1].cbBuffer);
                        input.erase(input.begin(), input.end() - static_cast<std::ptrdiff_t>(extra));
                    } else {
                        input.clear();
                    }
                    char chunk[16384];
                    const int received = raw_receive(socket.value, chunk, sizeof(chunk), deadline, stopped, true);
                    input.insert(input.end(), chunk, chunk + received);
                    continue;
                }
                if (status == SEC_E_INCOMPLETE_MESSAGE) {
                    char chunk[16384];
                    const int received = raw_receive(socket.value, chunk, sizeof(chunk), deadline, stopped, true);
                    input.insert(input.end(), chunk, chunk + received);
                    continue;
                }
                if (tls_is_certificate_error(static_cast<long>(status)))
                    throw TlsCertFailure{status_text(static_cast<long>(status)), "the TLS handshake reported a certificate error"};
                throw DriverError("08001",
                    "TLS handshake failed (" + status_text(static_cast<long>(status)) + ").", 8007);
            }
            SecPkgContext_StreamSizes sizes{};
            if (QueryContextAttributesW(&context.value, SECPKG_ATTR_STREAM_SIZES, &sizes) != SEC_E_OK)
                throw DriverError("08001", "Could not query TLS stream sizes.", 8007);
            PCCERT_CONTEXT remote = nullptr;
            if (QueryContextAttributesW(&context.value, SECPKG_ATTR_REMOTE_CERT_CONTEXT, &remote) != SEC_E_OK || !remote)
                throw DriverError("08001", "The server did not present a certificate.", 8007);
            CertContextGuard remote_guard(remote);
            if (options.verify) validate_certificate(remote, options);
            auto transport = std::make_unique<TlsTransport>(socket.release(), cred.release(), context.release(), sizes);
            return transport;
        } catch (const TlsCertFailure& failure) {
            last_cause = failure.cause;
            last_detail = failure.detail;
            if (attempt >= 3)
                throw DriverError("08001",
                    "The server certificate could not be verified (" + last_cause + ") after 3 attempts: " + last_detail + ".", 8007);
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }
    throw DriverError("08001",
        "The server certificate could not be verified (" + last_cause + ") after 3 attempts: " + last_detail + ".", 8007);
}

} // namespace hwdbodbc
