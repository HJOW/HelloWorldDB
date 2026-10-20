"""호환 계층의 계산 결과와 OS별 분기를 검증한다.

관련 사양: Python 3.2 이상, SCRAM-SHA-256. 구현 단계: PY-1.
"""

import errno
import hashlib
import os
import socket
import sys
import tempfile
import time
import unittest

from helloworlddb import _compat as compat


class CompatTests(unittest.TestCase):
    def test_monotonic_includes_sleep(self):
        start = compat.monotonic()
        time.sleep(0.04)
        self.assertGreaterEqual(compat.monotonic() - start, 0.02)

    def test_legacy_clock_includes_sleep(self):
        clock = compat._legacy_monotonic()
        start = clock()
        time.sleep(0.04)
        self.assertGreaterEqual(clock() - start, 0.02)

    def test_digest_comparison(self):
        for compare in (compat.compare_digest, compat._compare_digest_fallback):
            for left, right, expected in (
                    (b"abc", b"abc", True), (b"abc", b"abd", False),
                    (b"abc", b"xbc", False), (b"abc", b"ab", False),
                    (b"", b"", True), (b"", b"a", False),
                    ("abc", "abc", True), ("abc", "abd", False),
                    (bytearray(b"abc"), b"abc", True),
                    (memoryview(b"abc"), b"abc", True)):
                self.assertEqual(compare(left, right), expected)
            for left, right in ((b"abc", "abc"), ("한글", "한글"), (1, 1)):
                with self.assertRaises(TypeError):
                    compare(left, right)

    def test_pbkdf2_rfc7914_sha256(self):
        # RFC 7914 11절. 64바이트여서 두 HMAC 블록을 모두 검증한다.
        expected = (
            "55AC046E56E3089FEC1691C22544B605F94185216DDE0465E68B9D57C20DACBC"
            "49CA9CCCF179B645991664B39D77EF317C71B845B1E30BD509112041D3A19783")
        for derive in (compat.pbkdf2_hmac, compat._pbkdf2_hmac_fallback):
            self.assertEqual(compat.hexlify(derive("sha256", b"passwd", b"salt", 1, 64)),
                             expected)

    def test_pbkdf2_rfc7914_repeated_rounds(self):
        expected = (
            "4DDCD8F60B98BE21830CEE5EF22701F9641A4418D04C0414AEFF08876B34AB56"
            "A1D425A1225833549ADB841B51C9B3176A272BDEBBA1D078478F62B397F33C8D")
        self.assertEqual(compat.hexlify(compat._pbkdf2_hmac_fallback(
            "sha256", b"Password", b"NaCl", 80000, 64)), expected)

    def test_pbkdf2_binary_inputs_and_default_length(self):
        for length in (None, 1, 31, 32, 33, 64):
            actual = compat._pbkdf2_hmac_fallback(
                "sha256", b"pa\x00ss", b"sa\x00lt", 17, length)
            self.assertEqual(len(actual), 32 if length is None else length)
            if hasattr(hashlib, "pbkdf2_hmac"):
                self.assertEqual(actual, hashlib.pbkdf2_hmac(
                    "sha256", b"pa\x00ss", b"sa\x00lt", 17, length))

    def test_pbkdf2_validation(self):
        derive = compat._pbkdf2_hmac_fallback
        for iterations in (0, -1):
            with self.assertRaises(ValueError):
                derive("sha256", b"p", b"s", iterations)
        for length in (0, -1):
            with self.assertRaises(ValueError):
                derive("sha256", b"p", b"s", 1, length)
        for password in ("text", 2, None):
            with self.assertRaises(TypeError):
                derive("sha256", password, b"s", 1)
        with self.assertRaises(TypeError):
            derive("sha256", b"p", b"s", 1.5)
        with self.assertRaises(OverflowError):
            derive("sha256", b"p", b"s", 1, 2 ** 32 * 32)

    def test_hex_roundtrip(self):
        for value in (b"", b"\x00\x01\xab\xff", bytearray(b"bytes"), memoryview(b"view")):
            encoded = compat.hexlify(value)
            self.assertEqual(encoded, encoded.upper())
            self.assertEqual(compat.unhexlify(encoded), bytes(value))
            self.assertEqual(compat.unhexlify(encoded.encode("ascii")), bytes(value))
        for value in ("A", "GG", "AA BB"):
            with self.assertRaises((ValueError, compat.binascii.Error)):
                compat.unhexlify(value)
        with self.assertRaises(UnicodeEncodeError):
            compat.unhexlify("한글")

    def test_collection_aliases(self):
        self.assertIsInstance({}, compat.Mapping)
        self.assertIsInstance([], compat.Sequence)

    def test_socket_error_codes(self):
        for number in (errno.EINTR, 10004):
            self.assertTrue(compat.is_interrupted(socket.error(number, "interrupted")))
        for number in (errno.EAGAIN, errno.EWOULDBLOCK, 10035):
            self.assertTrue(compat.is_would_block(socket.error(number, "would block")))
        for number in (errno.ECONNREFUSED, errno.EHOSTUNREACH, 10061, 10065):
            self.assertTrue(compat.is_unreachable(socket.error(number, "unreachable")))
            self.assertTrue(compat.is_connection_lost(socket.error(number, "unreachable")))
        for number in (errno.ECONNRESET, errno.EPIPE, 10054, 10053):
            self.assertTrue(compat.is_connection_lost(socket.error(number, "reset")))
        self.assertFalse(compat.is_connection_lost(socket.error(errno.EINTR, "interrupted")))
        self.assertIsNone(compat.socket_error_code(Exception("unknown")))

    def test_windows_error_takes_priority(self):
        error = socket.error(errno.EINVAL, "WSA reset")
        error.winerror = 10054
        self.assertEqual(compat.socket_error_code(error), 10054)
        self.assertTrue(compat.is_connection_lost(error))

    def test_which_handles_paths_and_extensions(self):
        self.assertEqual(compat.which(sys.executable), sys.executable)
        self.assertIsNone(compat.which(""))
        self.assertIsNone(compat.which("hwdb-nonexistent-executable", path=""))
        with tempfile.TemporaryDirectory(prefix="hwdb-which-") as directory:
            filename = "example.exe" if os.name == "nt" else "example"
            executable = os.path.join(directory, filename)
            with open(executable, "wb") as stream:
                stream.write(b"test")
            os.chmod(executable, 0o700)
            self.assertEqual(os.path.normcase(compat.which("example", directory)),
                             os.path.normcase(executable))
            self.assertIsNone(compat.which(directory))


if __name__ == "__main__":
    unittest.main()
