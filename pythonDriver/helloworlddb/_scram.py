"""SCRAM-SHA-256 클라이언트 계산.

관련 사양: AGENTS.md 상세 4, 8, 프로토콜 7절. RFC 5802, RFC 7677.
구현 단계: PY-2. 비밀번호는 평문으로 보내지 않고 NFKC로 정규화한다.
"""

import base64
import hashlib
import hmac
import os
import re
import unicodedata

from helloworlddb import _compat


AUTH_MECHANISM = "SCRAM-SHA-256"
DEFAULT_SCRAM_ITERATIONS = 4096
MAX_SCRAM_ITERATIONS = 10000000
GS2_HEADER_BASE64 = base64.b64encode(b"n,,").decode("ascii")

_SERVER_FIRST_PATTERN = re.compile(r"^r=([^,]+),s=([^,]+),i=(\d+)(?:,.*)?$")
_BASE64_PATTERN = re.compile(r"^[A-Za-z0-9+/]*={0,2}$")


def normalize_password(password):
    """비밀번호를 NFKC로 정규화한다. 서버와 같은 결과를 내야 한다."""
    if not isinstance(password, str):
        raise TypeError("A password must be a string.")
    return unicodedata.normalize("NFKC", password)


def _hmac(key, data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hmac.new(key, data, hashlib.sha256).digest()


def _sha256(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).digest()


def _xor(left, right):
    return bytes([a ^ b for a, b in zip(left, right)])


def _assert_iterations(iterations):
    if (not isinstance(iterations, int) or isinstance(iterations, bool) or
            iterations < 1 or iterations > MAX_SCRAM_ITERATIONS):
        raise ValueError("SCRAM iteration count is out of range: {0!r}.".format(iterations))


def generate_nonce():
    """인증마다 쓰는 일회용 값이다. 쉼표가 없는 출력 가능 문자만 쓴다."""
    return base64.b64encode(os.urandom(18)).decode("ascii")


def escape_username(name):
    """사용자 이름 안의 = 와 , 를 SCRAM 규칙대로 바꾼다."""
    if not isinstance(name, str):
        raise TypeError("A user name must be a string.")
    return name.replace("=", "=3D").replace(",", "=2C")


def client_first_bare(username, client_nonce):
    return "n={0},r={1}".format(escape_username(username), client_nonce)


def client_first_message(username, client_nonce):
    return "n,,{0}".format(client_first_bare(username, client_nonce))


def client_final_without_proof(combined_nonce):
    return "c={0},r={1}".format(GS2_HEADER_BASE64, combined_nonce)


def auth_message(client_first_bare_text, server_first_text, client_final_without_proof_text):
    return "{0},{1},{2}".format(client_first_bare_text, server_first_text,
                               client_final_without_proof_text)


def parse_server_first(text):
    """서버가 보낸 server-first를 읽는다. 형식이 틀리면 None이다."""
    if not isinstance(text, str):
        return None
    match = _SERVER_FIRST_PATTERN.match(text)
    if match is None:
        return None
    try:
        iterations = int(match.group(3))
    except ValueError:
        return None
    if iterations < 1 or iterations > MAX_SCRAM_ITERATIONS:
        return None
    return {"nonce": match.group(1), "salt": match.group(2), "iterations": iterations}


def _salted_password(password, salt, iterations):
    _assert_iterations(iterations)
    discount = normalize_password(password).encode("utf-8")
    return _compat.pbkdf2_hmac("sha256", discount, salt, iterations, 32)


def _decode_base64(text):
    if isinstance(text, str):
        try:
            raw = text.encode("ascii")
        except UnicodeEncodeError:
            raise ValueError("Invalid base64.")
        charset = text
    elif isinstance(text, (bytes, bytearray, memoryview)):
        raw = bytes(text)
        try:
            charset = raw.decode("ascii")
        except UnicodeDecodeError:
            raise ValueError("Invalid base64.")
    else:
        raise ValueError("Invalid base64.")
    if len(charset) == 0 or len(charset) % 4 != 0:
        raise ValueError("Invalid base64.")
    if _BASE64_PATTERN.match(charset) is None:
        raise ValueError("Invalid base64.")
    # Padding may only fill the last quantum.
    stripped = charset.rstrip("=")
    if "=" in stripped:
        raise ValueError("Invalid base64.")
    if len(charset) - len(stripped) > 2:
        raise ValueError("Invalid base64.")
    try:
        return base64.b64decode(raw)
    except (TypeError, ValueError):
        raise ValueError("Invalid base64.")


def compute_client_proof(password, salt_base64, iterations, message):
    """ClientProof를 base64로 돌려준다."""
    _assert_iterations(iterations)
    try:
        salt = _decode_base64(salt_base64)
    except (TypeError, ValueError):
        raise ValueError("Invalid SCRAM salt.")
    salted = _salted_password(password, salt, iterations)
    client_key = _hmac(salted, "Client Key")
    stored_key = _sha256(client_key)
    if isinstance(message, str):
        message = message.encode("utf-8")
    signature = _hmac(stored_key, message)
    proof = _xor(client_key, signature)
    return base64.b64encode(proof).decode("ascii")


def verify_server_signature(password, salt_base64, iterations, message, signature_base64):
    """서버가 보낸 서명이 맞는지 본다. 어긋나면 False이다."""
    try:
        _assert_iterations(iterations)
        salt = _decode_base64(salt_base64)
        signature = _decode_base64(signature_base64)
    except (TypeError, ValueError):
        return False
    try:
        salted = _salted_password(password, salt, iterations)
    except (TypeError, ValueError):
        return False
    if isinstance(message, str):
        message = message.encode("utf-8")
    expected = _hmac(_hmac(salted, "Server Key"), message)
    if len(expected) != len(signature):
        return False
    return _compat.compare_digest(expected, signature)
