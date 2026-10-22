#include <winsock2.h>
#include <ws2tcpip.h>
#include "hwdbodbc/protocol.hpp"
#include <chrono>

namespace hwdbodbc {
namespace {
using Clock = std::chrono::steady_clock;
struct Winsock {
    Winsock() { WSADATA data{}; if (WSAStartup(MAKEWORD(2, 2), &data)) throw DriverError("08001", "Winsock initialization failed."); }
    ~Winsock() { WSACleanup(); }
};
class TcpTransport final : public Transport {
    SOCKET socket_ = INVALID_SOCKET;
    std::atomic<bool> stopped_{false};
    void ready(bool write, TransportDeadline deadline) {
        while (!stopped_) {
            if (Clock::now() >= deadline) throw DriverError("HYT01", "Socket transfer timeout expired.");
            fd_set descriptors;
            FD_ZERO(&descriptors);
            FD_SET(socket_, &descriptors);
            timeval timeout{0, 100000};
            const auto rc = select(0, write ? nullptr : &descriptors, write ? &descriptors : nullptr, nullptr, &timeout);
            if (rc > 0) return;
            if (rc < 0) throw DriverError("08S01", "Socket polling failed.", WSAGetLastError());
        }
        throw DriverError("08S01", "Connection was closed.", 8006);
    }
    void transfer(char* data, std::size_t size, bool write, TransportDeadline deadline = TransportDeadline::max()) {
        std::size_t offset = 0;
        while (offset < size) {
            ready(write,deadline);
            const auto count = static_cast<int>((std::min)(size - offset, static_cast<std::size_t>(INT_MAX)));
            const auto rc = write ? ::send(socket_, data + offset, count, 0) : recv(socket_, data + offset, count, 0);
            if (rc > 0) { offset += static_cast<std::size_t>(rc); continue; }
            if (rc < 0 && WSAGetLastError() == WSAEWOULDBLOCK) continue;
            throw DriverError("08S01", "Connection interrupted during frame transfer.", 8006);
        }
    }
public:
    TcpTransport(const std::string& host, unsigned short port, unsigned timeout_seconds, TransportDeadline outer_deadline) {
        static Winsock winsock;
        const auto deadline = (std::min)(outer_deadline,timeout_seconds ? Clock::now() + std::chrono::seconds(timeout_seconds) : TransportDeadline::max());
        const auto name = utf16(host);
        const auto service = std::to_wstring(port);
        ADDRINFOEXW hints{};
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;
        hints.ai_protocol = IPPROTO_TCP;
        PADDRINFOEXW addresses = nullptr;
        struct Event { HANDLE value = CreateEventW(nullptr,TRUE,FALSE,nullptr); ~Event() { if (value) CloseHandle(value); } } event;
        if (!event.value) throw DriverError("HY001", "Could not allocate the name resolution event.");
        OVERLAPPED overlapped{}; overlapped.hEvent = event.value; HANDLE resolver = nullptr;
        auto resolve = GetAddrInfoExW(name.c_str(),service.c_str(),NS_ALL,nullptr,&hints,&addresses,nullptr,&overlapped,nullptr,&resolver);
        bool expired = false;
        if (resolve == WSA_IO_PENDING) {
            const auto remaining = deadline == TransportDeadline::max() ? INFINITE
                : static_cast<DWORD>((std::max)(0LL,std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count()));
            const auto status = WaitForSingleObject(event.value,remaining);
            if (status != WAIT_OBJECT_0) {
                expired = status == WAIT_TIMEOUT;
                GetAddrInfoExCancel(&resolver);
                // 취소는 호출자의 완료 이벤트를 즉시 알리고 공급자 내부 자원은 OS가 회수한다.
                WaitForSingleObject(event.value,INFINITE);
            }
            resolve = GetAddrInfoExOverlappedResult(&overlapped);
        }
        std::unique_ptr<ADDRINFOEXW, decltype(&FreeAddrInfoExW)> guard(addresses, FreeAddrInfoExW);
        if (expired) throw DriverError("HYT01", "Name resolution timeout expired.");
        if (resolve) throw DriverError("08001", "Server address resolution failed.", resolve);
        int last_error = 0;
        for (auto address = addresses; address; address = address->ai_next) {
            if (Clock::now() >= deadline) throw DriverError("HYT01", "Connection timeout expired.");
            const auto candidate = socket(address->ai_family, address->ai_socktype, address->ai_protocol);
            if (candidate == INVALID_SOCKET) { last_error = WSAGetLastError(); continue; }
            bool connected = false;
            u_long nonblocking = 1;
            if (ioctlsocket(candidate, FIONBIO, &nonblocking) == 0) {
                const auto rc = ::connect(candidate, address->ai_addr, static_cast<int>(address->ai_addrlen));
                if (rc == 0) connected = true;
                else if (WSAGetLastError() == WSAEWOULDBLOCK) {
                    while (true) {
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
            if (connected) { socket_ = candidate; break; }
            closesocket(candidate);
        }
        if (socket_ == INVALID_SOCKET) throw DriverError("08001", "Could not connect to the server.", last_error);
        const BOOL enabled = TRUE;
        setsockopt(socket_, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&enabled), sizeof(enabled));
        setsockopt(socket_, SOL_SOCKET, SO_KEEPALIVE, reinterpret_cast<const char*>(&enabled), sizeof(enabled));
    }
    ~TcpTransport() override { abort(); if (socket_ != INVALID_SOCKET) closesocket(socket_); }
    void send(std::string_view body, TransportDeadline deadline) override {
        if (body.empty() || body.size() > 16777216) throw DriverError("54000", "Protocol message size exceeds the limit.", 8003);
        const auto size = static_cast<std::uint32_t>(body.size());
        char header[4];
        for (unsigned i = 0; i < 4; ++i) header[i] = static_cast<char>(size >> ((3 - i) * 8));
        transfer(header, 4, true,deadline);
        transfer(const_cast<char*>(body.data()), body.size(), true,deadline);
    }
    std::string receive(std::size_t limit) override {
        unsigned char header[4]{};
        transfer(reinterpret_cast<char*>(header), 4, false);
        std::uint32_t size = 0;
        for (auto byte : header) size = (size << 8) | byte;
        if (!size || size > limit) throw DriverError("08S01", "Invalid frame length.", 8000);
        std::string body(size, 0);
        transfer(body.data(), size, false);
        return body;
    }
    void abort() noexcept override {
        if (!stopped_.exchange(true) && socket_ != INVALID_SOCKET) shutdown(socket_, SD_BOTH);
    }
};
}
std::unique_ptr<Transport> tcp_transport(const std::string& host, unsigned short port, unsigned timeout_seconds, TransportDeadline deadline) {
    return std::make_unique<TcpTransport>(host, port, timeout_seconds,deadline);
}
} // namespace hwdbodbc
