#include "hwdbodbc/protocol.hpp"
#include <bcrypt.h>
#include <wincrypt.h>
#include <charconv>
#include <array>

namespace hwdbodbc {
namespace {
using Bytes = std::array<unsigned char, 32>;
void success(NTSTATUS status) { if (status < 0) throw DriverError("HY000", "Cryptographic operation failed."); }
struct Provider {
    BCRYPT_ALG_HANDLE handle = nullptr;
    explicit Provider(bool hmac) { success(BCryptOpenAlgorithmProvider(&handle, BCRYPT_SHA256_ALGORITHM, nullptr, hmac ? BCRYPT_ALG_HANDLE_HMAC_FLAG : 0)); }
    ~Provider() { if (handle) BCryptCloseAlgorithmProvider(handle, 0); }
};
template<class T> struct Wipe {
    T& value;
    ~Wipe() { if (!value.empty()) SecureZeroMemory(value.data(), value.size() * sizeof(typename T::value_type)); }
};
Bytes hash(std::string_view data, std::string_view key = {}, bool hmac = false) {
    Provider provider(hmac);
    Bytes result{};
    success(BCryptHash(provider.handle, reinterpret_cast<PUCHAR>(const_cast<char*>(key.data())),
        static_cast<ULONG>(key.size()), reinterpret_cast<PUCHAR>(const_cast<char*>(data.data())),
        static_cast<ULONG>(data.size()), result.data(), static_cast<ULONG>(result.size())));
    return result;
}
std::string view_bytes(const Bytes& data) { return std::string(reinterpret_cast<const char*>(data.data()), data.size()); }
std::string base64(std::string_view data) {
    DWORD length = 0;
    if (!CryptBinaryToStringA(reinterpret_cast<const BYTE*>(data.data()), static_cast<DWORD>(data.size()),
        CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &length)) throw DriverError("HY000", "Base64 encoding failed.");
    std::string result(length, 0);
    if (!CryptBinaryToStringA(reinterpret_cast<const BYTE*>(data.data()), static_cast<DWORD>(data.size()),
        CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, result.data(), &length)) throw DriverError("HY000", "Base64 encoding failed.");
    result.resize(length);
    return result;
}
std::string unbase64(const std::string& data) {
    DWORD length = 0;
    if (!CryptStringToBinaryA(data.data(), static_cast<DWORD>(data.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT,
        nullptr, &length, nullptr, nullptr)) throw DriverError("08006", "Invalid SCRAM salt.", 8006);
    std::string result(length, 0);
    if (!CryptStringToBinaryA(data.data(), static_cast<DWORD>(data.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT,
        reinterpret_cast<BYTE*>(result.data()), &length, nullptr, nullptr) || base64(result) != data)
        throw DriverError("08006", "Invalid SCRAM salt.", 8006);
    return result;
}
std::map<char, std::string> attributes(const std::string& text) {
    std::map<char, std::string> result;
    std::size_t offset = 0;
    while (offset < text.size()) {
        const auto comma = text.find(',', offset);
        const auto end = comma == std::string::npos ? text.size() : comma;
        if (end - offset < 3 || text[offset + 1] != '=' || !result.emplace(text[offset], text.substr(offset + 2, end - offset - 2)).second)
            throw DriverError("08006", "Invalid SCRAM attributes.", 8006);
        offset = end + 1;
    }
    if (result.count('m')) throw DriverError("08006", "Unsupported mandatory SCRAM extension.", 8006);
    return result;
}
}
Scram::Scram(const std::string& user) {
    std::array<unsigned char, 24> random{};
    success(BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG));
    nonce_ = base64(std::string_view(reinterpret_cast<const char*>(random.data()), random.size()));
    std::string escaped;
    for (const auto byte : user) {
        if (byte == '=') escaped += "=3D";
        else if (byte == ',') escaped += "=2C";
        else escaped += byte;
    }
    first_ = "n=" + escaped + ",r=" + nonce_;
}
Scram::~Scram() { if (!signature_.empty()) SecureZeroMemory(signature_.data(), signature_.size()); }
std::string Scram::challenge(const std::string& server_first, std::string_view password) {
    const auto fields = attributes(server_first);
    if (!fields.count('r') || !fields.count('s') || !fields.count('i')) throw DriverError("08006", "Incomplete SCRAM challenge.", 8006);
    const auto& nonce = fields.at('r');
    if (nonce.size() <= nonce_.size() || nonce.compare(0, nonce_.size(), nonce_) != 0)
        throw DriverError("08006", "SCRAM server nonce verification failed.", 8006);
    unsigned iterations = 0;
    const auto& iteration_text = fields.at('i');
    const auto conversion = std::from_chars(iteration_text.data(), iteration_text.data() + iteration_text.size(), iterations);
    if (conversion.ec != std::errc() || conversion.ptr != iteration_text.data() + iteration_text.size() || iterations < 1 || iterations > 10000000)
        throw DriverError("08006", "Invalid SCRAM iteration count.", 8006);
    auto wide = utf16(password);
    Wipe<std::wstring> wide_wipe{wide};
    std::wstring normalized;
    Wipe<std::wstring> normalized_wipe{normalized};
    if (!wide.empty()) {
        int length = NormalizeString(NormalizationKC, wide.data(), static_cast<int>(wide.size()), nullptr, 0);
        if (length <= 0) throw DriverError("22021", "Password normalization failed.");
        for (;;) {
            normalized.resize(static_cast<std::size_t>(length));
            const auto actual = NormalizeString(NormalizationKC, wide.data(), static_cast<int>(wide.size()), normalized.data(), length);
            if (actual > 0) { normalized.resize(static_cast<std::size_t>(actual)); break; }
            if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || actual >= 0) throw DriverError("22021", "Password normalization failed.");
            length = -actual;
        }
    }
    auto secret = utf8(normalized);
    Wipe<std::string> secret_wipe{secret};
    const auto salt = unbase64(fields.at('s'));
    if (salt.empty() || salt.size() > 65536) throw DriverError("08006", "Invalid SCRAM salt length.", 8006);
    Provider provider(true);
    Bytes salted{};
    Wipe<Bytes> salted_wipe{salted};
    success(BCryptDeriveKeyPBKDF2(provider.handle, reinterpret_cast<PUCHAR>(secret.data()), static_cast<ULONG>(secret.size()),
        reinterpret_cast<PUCHAR>(const_cast<char*>(salt.data())), static_cast<ULONG>(salt.size()), iterations,
        salted.data(), static_cast<ULONG>(salted.size()), 0));
    auto salted_text = view_bytes(salted);
    Wipe<std::string> salted_text_wipe{salted_text};
    auto client_key = hash("Client Key", salted_text, true);
    Wipe<Bytes> client_key_wipe{client_key};
    auto client_key_text = view_bytes(client_key);
    Wipe<std::string> client_key_text_wipe{client_key_text};
    auto stored_key = hash(client_key_text);
    Wipe<Bytes> stored_key_wipe{stored_key};
    auto stored_key_text = view_bytes(stored_key);
    Wipe<std::string> stored_key_text_wipe{stored_key_text};
    const auto final = "c=biws,r=" + nonce;
    const auto auth = first_ + "," + server_first + "," + final;
    auto client_signature = hash(auth, stored_key_text, true);
    Wipe<Bytes> client_signature_wipe{client_signature};
    auto server_key = hash("Server Key", salted_text, true);
    Wipe<Bytes> server_key_wipe{server_key};
    auto server_key_text = view_bytes(server_key);
    Wipe<std::string> server_key_text_wipe{server_key_text};
    auto server_signature = hash(auth, server_key_text, true);
    Wipe<Bytes> server_signature_wipe{server_signature};
    signature_ = base64(std::string_view(reinterpret_cast<char*>(server_signature.data()), server_signature.size()));
    for (std::size_t i = 0; i < client_key.size(); ++i) client_key[i] ^= client_signature[i];
    return final + ",p=" + base64(std::string_view(reinterpret_cast<char*>(client_key.data()), client_key.size()));
}
void Scram::verify(const std::string& final) const {
    const auto fields = attributes(final);
    if (!fields.count('v') || fields.count('e') || signature_.empty()) throw DriverError("08006", "SCRAM server signature verification failed.", 8006);
    const auto& signature = fields.at('v');
    unsigned difference = static_cast<unsigned>(signature.size() ^ signature_.size());
    for (std::size_t i = 0; i < signature_.size(); ++i) difference |= static_cast<unsigned char>(signature_[i])
        ^ static_cast<unsigned char>(i < signature.size() ? signature[i] : 0);
    if (difference) throw DriverError("08006", "SCRAM server signature verification failed.", 8006);
}
} // namespace hwdbodbc
