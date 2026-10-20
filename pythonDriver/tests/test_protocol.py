"""프레임과 응답 해석, 파라미터와 오류 매핑을 검증한다.

관련 사양: AGENTS.md 상세 8, 프로토콜 2-1절, 3절, 6절, 9절, 11절.
구현 단계: PY-2. 가짜 바이트로만 검증하며 서버를 띄우지 않는다.
"""

import struct
import unittest

from helloworlddb import _protocol
from helloworlddb import errors
from helloworlddb._protocol import FrameDecoder
from helloworlddb._protocol import decode_response
from helloworlddb._protocol import encode_frame
from helloworlddb._protocol import encode_message
from helloworlddb._tcp import encode_param


def make_body(payload):
    return encode_message(payload)


class FrameTests(unittest.TestCase):
    def test_encode_frame_prefix(self):
        body = b'{"id":1}'
        frame = encode_frame(body)
        self.assertEqual(frame[0:4], struct.pack("!I", len(body)))
        self.assertEqual(frame[4:], body)

    def test_frame_rejects_empty_and_too_large(self):
        with self.assertRaises(ValueError):
            encode_frame(b"")
        with self.assertRaises(errors.OperationalError):
            encode_frame(b"x" * (_protocol.MAX_MESSAGE_BYTES + 1))

    def test_decoder_single_split_and_multiple(self):
        decoder = FrameDecoder(_protocol.MAX_PREAUTH_MESSAGE_BYTES)
        first = make_body({"id": 1, "type": "ping"})
        second = make_body({"id": 2, "type": "ping"})
        frame = encode_frame(first) + encode_frame(second)
        self.assertEqual(decoder.push(frame[0:5]), [])
        bodies = decoder.push(frame[5:7])
        bodies.extend(decoder.push(frame[7:]))
        self.assertEqual(bodies, [first, second])

    def test_decoder_ignores_empty_chunk(self):
        decoder = FrameDecoder(_protocol.MAX_PREAUTH_MESSAGE_BYTES)
        body = make_body({"id": 1, "type": "ping"})
        self.assertEqual(decoder.push(b""), [])
        self.assertEqual(decoder.push(encode_frame(body)), [body])

    def test_decoder_checks_length_before_body(self):
        decoder = FrameDecoder(10)
        with self.assertRaises(_protocol.FrameError):
            decoder.push(struct.pack("!I", 11))
        decoder = FrameDecoder(100)
        with self.assertRaises(_protocol.FrameError):
            decoder.push(struct.pack("!I", 0))
        self.assertEqual(decoder.push(b""), [])

    def test_decoder_limit_follows_authentication(self):
        state = {"authed": False}
        decoder = FrameDecoder(
            lambda: _protocol.MAX_MESSAGE_BYTES if state["authed"] else 64)
        with self.assertRaises(_protocol.FrameError):
            decoder.push(encode_frame(b"x" * 65))
        state["authed"] = True
        decoder = FrameDecoder(
            lambda: _protocol.MAX_MESSAGE_BYTES if state["authed"] else 64)
        self.assertEqual(decoder.push(encode_frame(b"x" * 65)), [b"x" * 65])

    def test_encode_message_size_limit(self):
        with self.assertRaises(errors.OperationalError) as context:
            encode_message({"id": 1, "type": "ping", "pad": "x" * (_protocol.MAX_MESSAGE_BYTES + 1)})
        self.assertEqual(context.exception.sqlstate, "54000")
        self.assertEqual(context.exception.code, 8003)


class ResponseTests(unittest.TestCase):
    def test_hello_ok_roundtrip(self):
        payload = {"id": 3, "type": "helloOk", "version": 1, "server": "hwdb",
                   "mechanism": "SCRAM-SHA-256", "maxMessageBytes": 16777216,
                   "defaultFetchSize": 500, "extra": "ignored"}
        self.assertEqual(decode_response(make_body(payload)), payload)

    def test_rows_ok_and_error(self):
        rows = {"id": 1, "type": "rows", "rows": [[1, "a"]], "hasMore": False}
        self.assertEqual(decode_response(make_body(rows))["rows"], [[1, "a"]])
        ok = {"id": 2, "type": "ok", "message": "done", "rowCount": 3}
        self.assertEqual(decode_response(make_body(ok))["rowCount"], 3)
        error = {"id": 4, "type": "error", "sqlState": "42601", "code": 3000,
                 "message": "Syntax error.", "position": {"line": 1, "column": 2, "offset": 1}}
        parsed = decode_response(make_body(error))
        self.assertEqual(parsed["sqlState"], "42601")
        self.assertEqual(parsed["position"]["column"], 2)

    def test_id_zero_is_allowed(self):
        payload = {"id": 0, "type": "error", "sqlState": "57P01", "code": 6003,
                   "message": "Server shutdown."}
        self.assertEqual(decode_response(make_body(payload))["id"], 0)

    def test_invalid_responses(self):
        for bad in (b"\xff\xfe", b"not json", b"[1,2]", b'{"type":"pong"}',
                    b'{"id":0,"type":"unknown"}', b'{"id":1,"type":"rows","rows":[]}'):
            with self.assertRaises(errors.InterfaceError):
                decode_response(bad)
        with self.assertRaises(errors.InterfaceError):
            decode_response(make_body({"id": 1, "type": "helloOk", "version": 1}))


class ParamTests(unittest.TestCase):
    def test_basic_values(self):
        self.assertEqual(encode_param(None, 0), None)
        self.assertEqual(encode_param(True, 0), True)
        self.assertEqual(encode_param(42, 0), 42)
        self.assertEqual(encode_param("text", 0), "text")
        self.assertEqual(encode_param(1.5, 0), 1.5)

    def test_unsafe_integer_becomes_string(self):
        big = 2 ** 53
        self.assertEqual(encode_param(big, 0), str(big))
        self.assertEqual(encode_param(-(2 ** 53), 0), str(-(2 ** 53)))
        self.assertEqual(encode_param(2 ** 53 - 1, 0), 2 ** 53 - 1)

    def test_binary_values(self):
        self.assertEqual(encode_param(b"\xab\x12", 0), {"binary": "AB12"})
        self.assertEqual(encode_param(bytearray(b"\x00"), 0), {"binary": "00"})
        self.assertEqual(encode_param(memoryview(b"A"), 0), {"binary": "41"})

    def test_rejects_bad_values(self):
        with self.assertRaises(ValueError):
            encode_param(float("inf"), 0)
        with self.assertRaises(ValueError):
            encode_param(float("nan"), 0)
        for bad in (object(), {"a": 1}, [1]):
            with self.assertRaises(TypeError):
                encode_param(bad, 0)


class ErrorMappingTests(unittest.TestCase):
    def test_mapping_table(self):
        cases = (
            ("0A000", errors.NotSupportedError),
            ("08P01", errors.InterfaceError),
            ("08006", errors.OperationalError),
            ("28000", errors.OperationalError),
            ("40P01", errors.OperationalError),
            ("22003", errors.DataError),
            ("22001", errors.DataError),
            ("23503", errors.IntegrityError),
            ("34000", errors.InternalError),
            ("XX000", errors.InternalError),
            ("07001", errors.ProgrammingError),
            ("42601", errors.ProgrammingError),
            ("42501", errors.ProgrammingError),
            ("3F000", errors.ProgrammingError),
            ("99999", errors.DatabaseError),
        )
        for sqlstate, kind in cases:
            error = errors.error_from_response(sqlstate, 1, "message")
            self.assertTrue(isinstance(error, kind), sqlstate)
            self.assertEqual(error.sqlstate, sqlstate)
            self.assertEqual(error.code, 1)

    def test_position_is_kept(self):
        position = {"line": 1, "column": 5, "offset": 4}
        error = errors.error_from_response("42601", 3000, "bad", position)
        self.assertEqual(error.position, position)

    def test_client_errors(self):
        failure = errors.connection_failure("lost")
        self.assertTrue(isinstance(failure, errors.OperationalError))
        self.assertEqual((failure.sqlstate, failure.code), ("08006", 8006))
        violation = errors.protocol_violation("bad")
        self.assertTrue(isinstance(violation, errors.InterfaceError))
        self.assertEqual((violation.sqlstate, violation.code), ("08P01", 8000))


if __name__ == "__main__":
    unittest.main()
