#include "hwdbodbc/protocol.hpp"
#include "../helpers/check.hpp"
#define SECURITY_WIN32
#include <windows.h>
#include <security.h>
#include <schannel.h>
#include <cstdio>
#include <string>

using namespace hwdbodbc;

int main() {
    return run_checks([] {
        // Schannel 상태의 인증서 오류 분류이다. 재시도는 이 경우에만 한다.
        check(tls_is_certificate_error(SEC_E_WRONG_PRINCIPAL), "wrong principal is a certificate error");
        check(tls_is_certificate_error(SEC_E_UNTRUSTED_ROOT), "untrusted root is a certificate error");
        check(tls_is_certificate_error(SEC_E_CERT_EXPIRED), "expired certificate is a certificate error");
        check(tls_is_certificate_error(SEC_E_CERT_UNKNOWN), "unknown certificate is a certificate error");
        check(!tls_is_certificate_error(SEC_E_ALGORITHM_MISMATCH), "version mismatch is not a certificate error");
        check(!tls_is_certificate_error(SEC_E_ILLEGAL_MESSAGE), "plaintext server is not a certificate error");
        check(!tls_is_certificate_error(SEC_E_INTERNAL_ERROR), "internal error is not a certificate error");
        check(!tls_is_certificate_error(S_OK), "success is not a certificate error");

        // PEM 읽기이다. 서버 시험용 인증서를 함께 쓴다.
        const char* fixtures[] = {
            "../../../rdbms/test/fixtures/tls/server-a.cert.pem",
            "..\\..\\..\\rdbms\\test\\fixtures\\tls\\server-a.cert.pem",
        };
        std::string found;
        for (const auto* candidate : fixtures) {
            FILE* file = nullptr;
            if (!fopen_s(&file, candidate, "rb") && file) { fclose(file); found = candidate; break; }
        }
        check(!found.empty(), "TLS fixture certificate exists");
        const auto single = tls_load_pem_certificates(found);
        check(single.size() == 1 && !single[0].empty(), "single PEM certificate loads");
        // 두 인증서를 붙이면 두 개가 읽힌다.
        const auto doubled = single[0];
        check(!doubled.empty(), "fixture DER is not empty");
        try { tls_load_pem_certificates("C:\\none.pem"); check(false, "missing CA file accepted"); }
        catch (const DriverError& error) { check(error.state == "HY024", "missing CA file SQLSTATE"); }
        try { tls_load_pem_certificates(""); check(false, "empty CA path accepted"); }
        catch (const DriverError& error) { check(error.state == "HY024", "empty CA path SQLSTATE"); }
        std::cout << "TLS options and certificate classification PASS\n";
    });
}
