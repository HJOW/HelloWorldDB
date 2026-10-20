"""TCP 프레임과 JSON 메시지를 만들고 읽는다.

관련 사양: AGENTS.md 상세 8, 프로토콜 2-1절, 3절, 5절, 6절, 9절, 11절.
구현 단계: PY-2. 전송 소켓은 다루지 않고 바이트와 dict만 다룬다.
길이는 본문을 모으기 전에 검사한다 (인증 전 64 KiB, 후 16 MiB).
"""

import json
import struct

from helloworlddb import _compat
from helloworlddb.errors import OperationalError
from helloworlddb.errors import protocol_violation


PROTOCOL_VERSION = 1
AUTH_MECHANISM = "SCRAM-SHA-256"
MAX_MESSAGE_BYTES = 16 * 1024 * 1024
MAX_PREAUTH_MESSAGE_BYTES = 64 * 1024
FRAME_HEADER_BYTES = 4
MAX_PARAMETERS = 65535
SERVER_MESSAGE_ID = 0

REQUEST_TYPES = frozenset((
    "hello", "authStart", "authFinish", "execute", "fetch",
    "closeCursor", "ping", "close", "control",
))

RESPONSE_TYPES = frozenset((
    "helloOk", "authChallenge", "authOk", "rows", "ok",
    "cursorClosed", "pong", "bye", "status", "stopping", "error",
))

_SAFE_INT_MIN = -(2 ** 53 - 1)
_SAFE_INT_MAX = 2 ** 53 - 1


class FrameError(Exception):
    """프레임 규칙을 어긴 입력이다. 호출자는 접속을 끊는다."""

    def __init__(self, message):
        Exception.__init__(self, message)
        self.sqlstate = "08P01"
        self.code = 8000
        self.position = None
        self.cause = None


def encode_message(message):
    """dict를 UTF-8 JSON 본문으로 바꾼다. 16 MiB를 넘으면 54000이다."""
    if not isinstance(message, dict):
        raise TypeError("A message must be a dict.")
    text = json.dumps(message, separators=(",", ":"), ensure_ascii=False)
    body = text.encode("utf-8")
    if len(body) > MAX_MESSAGE_BYTES:
        raise OperationalError(
            "Message is too large: {0} bytes (limit {1}).".format(len(body), MAX_MESSAGE_BYTES),
            "54000", 8003, None)
    return body


def _invalid_response(reason):
    return protocol_violation("Invalid response from the server: {0}".format(reason))


def decode_response(body):
    """응답 본문을 읽는다. 봉투와 핵심 필드만 보고 모르는 필드는 둔다."""
    if isinstance(body, (bytearray, memoryview)):
        body = bytes(body)
    if not isinstance(body, bytes):
        raise TypeError("A response body must be bytes.")
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as error:
        raise _invalid_response("Response is not valid UTF-8 JSON.")
    try:
        parsed = json.loads(text)
    except ValueError:
        raise _invalid_response("Response is not valid UTF-8 JSON.")
    if not isinstance(parsed, dict):
        raise _invalid_response("Response must be a JSON object.")
    message_id = parsed.get("id")
    if (not isinstance(message_id, int) or isinstance(message_id, bool) or
            message_id < 0):
        raise _invalid_response("Response needs an integer id.")
    message_type = parsed.get("type")
    if not isinstance(message_type, str) or message_type not in RESPONSE_TYPES:
        raise _invalid_response("Unknown response type.")
    if message_type == "helloOk":
        if (not isinstance(parsed.get("version"), int) or
                isinstance(parsed.get("version"), bool) or
                not isinstance(parsed.get("maxMessageBytes"), int)):
            raise _invalid_response("Response helloOk has an invalid field.")
    elif message_type == "authChallenge":
        if not isinstance(parsed.get("serverFirst"), str):
            raise _invalid_response("Response authChallenge has an invalid field.")
    elif message_type == "authOk":
        if (not isinstance(parsed.get("serverFinal"), str) or
                not isinstance(parsed.get("session"), dict)):
            raise _invalid_response("Response authOk has an invalid field.")
    elif message_type == "rows":
        if (not isinstance(parsed.get("rows"), list) or
                not isinstance(parsed.get("hasMore"), bool)):
            raise _invalid_response("Response rows has an invalid field.")
    elif message_type == "ok":
        if not isinstance(parsed.get("message"), str):
            raise _invalid_response("Response ok has an invalid field.")
    elif message_type == "error":
        if (not isinstance(parsed.get("sqlState"), str) or
                not isinstance(parsed.get("code"), int) or
                isinstance(parsed.get("code"), bool) or
                not isinstance(parsed.get("message"), str)):
            raise _invalid_response("Response error has an invalid field.")
    elif message_type == "status":
        if (not isinstance(parsed.get("running"), bool) or
                not isinstance(parsed.get("port"), int)):
            raise _invalid_response("Response status has an invalid field.")
    return parsed


def encode_frame(body):
    """본문 앞에 4바이트 길이를 붙인다. 비었거나 16 MiB를 넘으면 오류이다."""
    if isinstance(body, (bytearray, memoryview)):
        body = bytes(body)
    if not isinstance(body, bytes):
        raise TypeError("A frame body must be bytes.")
    if len(body) == 0:
        raise ValueError("A frame body must not be empty.")
    if len(body) > MAX_MESSAGE_BYTES:
        raise OperationalError(
            "A frame body is too large: {0} bytes (limit {1}).".format(len(body), MAX_MESSAGE_BYTES),
            "54000", 8003, None)
    return struct.pack("!I", len(body)) + body


class FrameDecoder(object):
    """이어 받는 프레임을 메시지마다 잘라 낸다. 접속마다 하나를 둔다."""

    def __init__(self, max_bytes):
        self._max_bytes = max_bytes
        self._buffer = bytearray()
        self._expected = -1
        self._failed = False

    def _limit(self):
        if callable(self._max_bytes):
            return self._max_bytes()
        return self._max_bytes

    def _fail(self, message):
        self._failed = True
        self._buffer = bytearray()
        self._expected = -1
        return FrameError(message)

    @property
    def buffered_bytes(self):
        return len(self._buffer)

    def push(self, chunk):
        """들어온 바이트를 넣고 완성된 본문들의 목록을 돌려준다."""
        if self._failed:
            return []
        if isinstance(chunk, (bytearray, memoryview)):
            chunk = bytes(chunk)
        if not isinstance(chunk, bytes):
            raise TypeError("A frame chunk must be bytes.")
        if len(chunk) == 0:
            return []
        self._buffer.extend(chunk)
        bodies = []
        while True:
            if self._expected < 0:
                if len(self._buffer) < FRAME_HEADER_BYTES:
                    return bodies
                length = struct.unpack("!I", bytes(self._buffer[0:4]))[0]
                limit = self._limit()
                if length == 0:
                    raise self._fail("Frame length is zero.")
                if length > limit:
                    raise self._fail(
                        "Frame is too large: {0} bytes (limit {1}).".format(length, limit))
                self._expected = length
                del self._buffer[0:4]
            if len(self._buffer) < self._expected:
                return bodies
            body = bytes(self._buffer[0:self._expected])
            del self._buffer[0:self._expected]
            self._expected = -1
            bodies.append(body)
