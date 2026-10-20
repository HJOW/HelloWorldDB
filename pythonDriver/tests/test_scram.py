"""SCRAM-SHA-256 클라이언트 계산을 검증한다.

관련 사양: AGENTS.md 상세 4, 8, 프로토콜 7절. RFC 7677 3절.
구현 단계: PY-2.
"""

import base64
import unittest

from helloworlddb import _scram


RFC_USER = "user"
RFC_PASSWORD = "pencil"
RFC_SALT = "W22ZaJ0SNY7soEsUEjb6gQ=="
RFC_ITERATIONS = 4096
RFC_CLIENT_NONCE = "rOprNGfwEbeRWgbNEkqO"
RFC_COMBINED_NONCE = "rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0"
RFC_CLIENT_PROOF = "dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ="
RFC_SERVER_SIGNATURE = "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4="


class ScramTests(unittest.TestCase):
    def test_rfc7677_vectors(self):
        bare = _scram.client_first_bare(RFC_USER, RFC_CLIENT_NONCE)
        self.assertEqual(bare, "n=user,r=rOprNGfwEbeRWgbNEkqO")
        self.assertEqual(_scram.client_first_message(RFC_USER, RFC_CLIENT_NONCE),
                         "n,,n=user,r=rOprNGfwEbeRWgbNEkqO")
        server_first = "r={0},s={1},i=4096".format(RFC_COMBINED_NONCE, RFC_SALT)
        without_proof = _scram.client_final_without_proof(RFC_COMBINED_NONCE)
        self.assertEqual(without_proof, "c=biws,r={0}".format(RFC_COMBINED_NONCE))
        message = _scram.auth_message(bare, server_first, without_proof)
        self.assertEqual(_scram.compute_client_proof(
            RFC_PASSWORD, RFC_SALT, RFC_ITERATIONS, message), RFC_CLIENT_PROOF)
        self.assertTrue(_scram.verify_server_signature(
            RFC_PASSWORD, RFC_SALT, RFC_ITERATIONS, message, RFC_SERVER_SIGNATURE))
        self.assertFalse(_scram.verify_server_signature(
            "wrong", RFC_SALT, RFC_ITERATIONS, message, RFC_SERVER_SIGNATURE))

    def test_username_escape(self):
        self.assertEqual(_scram.escape_username("a=b,c"), "a=3Db=2Cc")
        self.assertEqual(_scram.client_first_bare("we,ird=name", "nonce123"),
                         "n=we=2Cird=3Dname,r=nonce123")

    def test_parse_server_first(self):
        parsed = _scram.parse_server_first("r=abc123,s=c2FsdA==,i=4096")
        self.assertEqual(parsed, {"nonce": "abc123", "salt": "c2FsdA==", "iterations": 4096})
        for bad in ("r=abc,s=xyz", "r=abc,s=xyz,i=0", "r=abc,s=xyz,i=10000001",
                    "r=abc,s=xyz,i=abc", "nonsense", "", "r=,s=eA==,i=1"):
            self.assertEqual(_scram.parse_server_first(bad), None)
        self.assertEqual(_scram.parse_server_first(None), None)

    def test_iterations_range(self):
        message = "bare,server,without"
        for bad in (0, -1, 10000001, 1.5, "4096"):
            with self.assertRaises(ValueError):
                _scram.compute_client_proof("pw", RFC_SALT, bad, message)
        self.assertFalse(_scram.verify_server_signature("pw", RFC_SALT, 0, message,
                                                        RFC_SERVER_SIGNATURE))

    def test_nonce_has_no_comma(self):
        first = _scram.generate_nonce()
        second = _scram.generate_nonce()
        for nonce in (first, second):
            self.assertTrue(nonce)
            self.assertNotIn(",", nonce)
            base64.b64decode(nonce.encode("ascii"))

    def test_password_nfkc(self):
        self.assertEqual(_scram.normalize_password("e\u0301"), "é")
        message = _scram.auth_message("n=user,r=nonce", "r=nonceXYZ,s=c2FsdA==,i=1000",
                                      "c=biws,r=nonceXYZ")
        first = _scram.compute_client_proof("é", "c2FsdA==", 1000, message)
        second = _scram.compute_client_proof("e\u0301", "c2FsdA==", 1000, message)
        self.assertEqual(first, second)

    def test_bad_base64_is_rejected(self):
        message = "bare,server,without"
        with self.assertRaises(ValueError):
            _scram.compute_client_proof("pw", "!!!", 4096, message)
        self.assertFalse(_scram.verify_server_signature("pw", RFC_SALT, 4096, message, "!!!"))
        self.assertFalse(_scram.verify_server_signature("pw", RFC_SALT, 4096, message, ""))

    def test_type_checks(self):
        with self.assertRaises(TypeError):
            _scram.normalize_password(b"bytes")
        with self.assertRaises(TypeError):
            _scram.escape_username(123)


if __name__ == "__main__":
    unittest.main()
