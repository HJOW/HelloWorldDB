"""TCP로 HelloWorldDB 서버와 주고받는 저수준 접속이다.

관련 사양: AGENTS.md 상세 8, 프로토콜 2-1절, 3절부터 7절, 10절, 11절.
구현 단계: PY-2. DB-API는 PY-3에서 이 위를 감싼다.
한 접속에서 동시에 요청 하나만 두며 스레드 잠금으로 순서대로 처리한다.
"""

import socket
import threading

from helloworlddb import _compat
from helloworlddb import _scram
from helloworlddb._protocol import AUTH_MECHANISM
from helloworlddb._protocol import FrameDecoder
from helloworlddb._protocol import MAX_MESSAGE_BYTES
from helloworlddb._protocol import MAX_PREAUTH_MESSAGE_BYTES
from helloworlddb._protocol import PROTOCOL_VERSION
from helloworlddb._protocol import decode_response
from helloworlddb._protocol import encode_frame
from helloworlddb._protocol import encode_message
from helloworlddb.errors import connection_failure
from helloworlddb.errors import error_from_response


_SAFE_INT_MIN = -(2 ** 53 - 1)
_SAFE_INT_MAX = 2 ** 53 - 1
_CLOSE_TIMEOUT = 2.0


def encode_param(value, index):
    """Python 값을 서버 Param으로 바꾼다. 모르면 TypeError이다."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        if _SAFE_INT_MIN <= value <= _SAFE_INT_MAX:
            return value
        return str(value)
    if isinstance(value, float):
        if value != value or value == float("inf") or value == float("-inf"):
            raise ValueError("Parameter {0} is not a finite number.".format(index + 1))
        return value
    if isinstance(value, str):
        return value
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"binary": _compat.hexlify(value)}
    raise TypeError("Parameter {0} has an unsupported type.".format(index + 1))


def _send_all(sock, data):
    view = bytes(data)
    offset = 0
    while offset < len(view):
        try:
            sent = sock.send(view[offset:])
        except socket.error as error:
            if _compat.is_interrupted(error):
                continue
            raise
        if sent == 0:
            raise socket.error("The connection was closed while sending.")
        offset += sent


def _recv_chunk(sock):
    while True:
        try:
            return sock.recv(65536)
        except socket.timeout:
            raise
        except socket.error as error:
            if _compat.is_interrupted(error):
                continue
            raise


class TcpConnection(object):
    """TCP 프레임 위에서 요청과 응답을 주고받는다."""

    def __init__(self, sock, client_name, connect_timeout, timeout, hello_info):
        self._sock = sock
        self._client_name = client_name
        self._connect_timeout = connect_timeout
        self._timeout = timeout
        self._hello = hello_info
        self._session = None
        self._next_id = 2
        self._lock = threading.Lock()
        self._closed = False
        self._closed_error = None
        self._authenticated = False
        self._decoder = FrameDecoder(self._limit)
        self._ready = []

    def _limit(self):
        if self._authenticated:
            return MAX_MESSAGE_BYTES
        return MAX_PREAUTH_MESSAGE_BYTES

    @property
    def hello_info(self):
        return self._hello

    @property
    def session(self):
        return self._session

    @property
    def closed(self):
        return self._closed

    def _fail_closed(self, error):
        if self._closed_error is None:
            self._closed_error = error
        self._closed = True
        try:
            self._sock.close()
        except socket.error:
            pass
        return error

    def _recv_one(self, timeout):
        if self._ready:
            return self._ready.pop(0)
        if timeout is None:
            deadline = None
        else:
            deadline = _compat.monotonic() + timeout
        while True:
            if deadline is None:
                try:
                    self._sock.settimeout(None)
                except socket.error:
                    pass
            else:
                remaining = deadline - _compat.monotonic()
                if remaining <= 0:
                    raise connection_failure(
                        "No response from the server within {0} ms.".format(int(timeout * 1000)))
                try:
                    self._sock.settimeout(remaining)
                except socket.error:
                    pass
            try:
                chunk = _recv_chunk(self._sock)
            except socket.timeout:
                raise connection_failure(
                    "No response from the server within {0} ms.".format(int(timeout * 1000)))
            except socket.error as error:
                # RST 등 소켓 오류도 DB-API 예외로 바꾸고 접속을 닫는다. (P-1)
                raise self._fail_closed(connection_failure(
                    "The connection was lost while receiving.", error))
            if chunk == b"":
                raise self._fail_closed(connection_failure("The connection was closed."))
            try:
                bodies = self._decoder.push(chunk)
            except Exception as error:
                raise self._fail_closed(connection_failure(
                    "Invalid frame from the server: {0}".format(error), error))
            if bodies:
                self._ready.extend(bodies[1:])
                return bodies[0]

    def _request(self, payload, timeout=_CLOSE_TIMEOUT):
        """payload(dict, id 없음)를 보내고 같은 id의 응답 dict를 돌려준다."""
        # NOTE: timeout 기본값은 close()용이다. 다른 호출은 명시한다.
        self._lock.acquire()
        try:
            if self._closed:
                raise self._closed_error or connection_failure("The connection is closed.")
            message_id = self._next_id
            self._next_id += 1
            payload = dict(payload)
            payload["id"] = message_id
            try:
                body = encode_message(payload)
            except Exception as error:
                raise error
            try:
                _send_all(self._sock, encode_frame(body))
            except socket.error as error:
                raise self._fail_closed(connection_failure(
                    "The connection was closed while sending.", error))
            if timeout is None:
                deadline = None
            else:
                deadline = _compat.monotonic() + timeout
            while True:
                if deadline is None:
                    remaining = None
                else:
                    remaining = deadline - _compat.monotonic()
                    if remaining <= 0:
                        raise connection_failure(
                            "No response from the server within {0} ms.".format(int(timeout * 1000)))
                try:
                    raw = self._recv_one(remaining)
                except Exception:
                    raise
                try:
                    response = decode_response(raw)
                except Exception as error:
                    raise self._fail_closed(error)
                response_id = response.get("id")
                if response_id == 0:
                    if response.get("type") == "error":
                        server_error = error_from_response(
                            response.get("sqlState"), response.get("code"),
                            response.get("message"), response.get("position"))
                        raise self._fail_closed(server_error)
                    raise self._fail_closed(connection_failure(
                        "The server closed the connection."))
                if response_id != message_id:
                    continue
                if response.get("type") == "error":
                    raise error_from_response(
                        response.get("sqlState"), response.get("code"),
                        response.get("message"), response.get("position"))
                return response
        finally:
            self._lock.release()

    def _expect(self, expected_type, payload, timeout):
        response = self._request(payload, timeout)
        if response.get("type") != expected_type:
            self.abort()
            raise connection_failure(
                "Unexpected response \"{0}\" to \"{1}\".".format(response.get("type"), payload.get("type")))
        return response

    def login(self, user, password, tablespace=None, time_zone=None):
        """SCRAM-SHA-256으로 로그인한다. 서버 서명을 검증해 서버를 확인한다."""
        if not isinstance(user, str):
            raise TypeError("A user name must be a string.")
        if not isinstance(password, str):
            raise TypeError("A password must be a string.")
        if tablespace is not None and not isinstance(tablespace, str):
            raise TypeError("A tablespace must be a string.")
        if time_zone is not None and not isinstance(time_zone, str):
            raise TypeError("A time zone must be a string.")
        client_nonce = _scram.generate_nonce()
        payload = {"type": "authStart", "mechanism": AUTH_MECHANISM,
                   "clientFirst": _scram.client_first_message(user, client_nonce)}
        if tablespace is not None:
            payload["tablespace"] = tablespace
        if time_zone is not None:
            payload["timeZone"] = time_zone
        try:
            challenge = self._expect("authChallenge", payload, self._connect_timeout)
        except Exception as error:
            self.abort()
            raise error
        parsed = _scram.parse_server_first(challenge.get("serverFirst"))
        if (parsed is None or not parsed["nonce"].startswith(client_nonce) or
                len(parsed["nonce"]) == len(client_nonce)):
            self.abort()
            raise connection_failure("The server sent an invalid SCRAM challenge.")
        bare = _scram.client_first_bare(user, client_nonce)
        without_proof = _scram.client_final_without_proof(parsed["nonce"])
        message = _scram.auth_message(bare, challenge.get("serverFirst"), without_proof)
        try:
            proof = _scram.compute_client_proof(password, parsed["salt"],
                                                parsed["iterations"], message)
        except ValueError as error:
            self.abort()
            raise connection_failure("The server sent an invalid SCRAM challenge.", error)
        try:
            done = self._expect(
                "authOk",
                {"type": "authFinish",
                 "clientFinal": "{0},p={1}".format(without_proof, proof)},
                self._connect_timeout)
        except Exception as error:
            self.abort()
            raise error
        server_final = done.get("serverFinal")
        if not isinstance(server_final, str) or not server_final.startswith("v="):
            self.abort()
            raise connection_failure(
                "The server could not prove that it knows the password; the connection was dropped.")
        signature = server_final[2:]
        if not signature or not _scram.verify_server_signature(
                password, parsed["salt"], parsed["iterations"], message, signature):
            self.abort()
            raise connection_failure(
                "The server could not prove that it knows the password; the connection was dropped.")
        self._authenticated = True
        self._session = done.get("session")
        return self._session

    def execute(self, sql, params=None, fetch_size=None):
        """문장 하나를 실행한다. 조회는 rows, 아니면 ok 응답을 그대로 돌려준다."""
        if not isinstance(sql, str):
            raise TypeError("SQL text must be a string.")
        if params is None:
            encoded = []
        elif isinstance(params, dict):
            raise TypeError("Parameters must be a sequence.")
        else:
            try:
                items = list(params)
            except TypeError:
                raise TypeError("Parameters must be a sequence.")
            encoded = [encode_param(value, index) for index, value in enumerate(items)]
        return self.execute_encoded(sql, encoded, fetch_size)

    def execute_encoded(self, sql, encoded, fetch_size=None):
        """이미 Param으로 바꾼 값으로 실행한다. DB-API 계층이 쓴다."""
        if fetch_size is not None:
            if (not isinstance(fetch_size, int) or isinstance(fetch_size, bool) or
                    fetch_size < 1):
                raise ValueError("fetch_size must be an integer of 1 or more.")
        payload = {"type": "execute", "sql": sql, "params": encoded}
        if fetch_size is not None:
            payload["fetchSize"] = fetch_size
        return self._expect_rows_or_ok(payload)

    def _expect_rows_or_ok(self, payload):
        response = self._request(payload, self._timeout)
        if response.get("type") in ("rows", "ok"):
            return response
        self.abort()
        raise connection_failure(
            "Unexpected response \"{0}\" to \"execute\".".format(response.get("type")))

    def fetch(self, cursor, fetch_size=None):
        if (not isinstance(cursor, int) or isinstance(cursor, bool) or cursor < 1):
            raise ValueError("A cursor must be an integer of 1 or more.")
        if fetch_size is not None:
            if (not isinstance(fetch_size, int) or isinstance(fetch_size, bool) or
                    fetch_size < 1):
                raise ValueError("fetch_size must be an integer of 1 or more.")
        payload = {"type": "fetch", "cursor": cursor}
        if fetch_size is not None:
            payload["fetchSize"] = fetch_size
        response = self._request(payload, self._timeout)
        if response.get("type") != "rows":
            self.abort()
            raise connection_failure(
                "Unexpected response \"{0}\" to \"fetch\".".format(response.get("type")))
        return response

    def close_cursor(self, cursor):
        if (not isinstance(cursor, int) or isinstance(cursor, bool) or cursor < 1):
            raise ValueError("A cursor must be an integer of 1 or more.")
        self._expect("cursorClosed", {"type": "closeCursor", "cursor": cursor}, self._timeout)

    def ping(self):
        self._expect("pong", {"type": "ping"}, self._timeout)

    def close(self):
        """bye를 받고 접속을 끝낸다. rolledBack 여부를 dict로 돌려준다."""
        self._lock.acquire()
        locked = True
        try:
            if self._closed:
                return {"rolledBack": False}
        finally:
            if locked:
                self._lock.release()
        try:
            response = self._request({"type": "close"}, _CLOSE_TIMEOUT)
            rolled = isinstance(response, dict) and response.get("type") == "bye" and \
                response.get("rolledBack") is True
        except Exception:
            rolled = False
        self.abort()
        return {"rolledBack": bool(rolled)}

    def abort(self):
        self._closed = True
        if self._closed_error is None:
            self._closed_error = connection_failure("The connection is closed.")
        try:
            self._sock.close()
        except socket.error:
            pass

    def __del__(self):
        try:
            self.abort()
        except Exception:
            pass


def connect(host="127.0.0.1", port=7410, connect_timeout=10, timeout=None,
            client_name="helloworlddb-python"):
    """TCP로 연결하고 hello까지 마친다. 로그인은 login()으로 따로 한다."""
    if not isinstance(host, str) or not host:
        raise ValueError("A host must be a nonempty string.")
    if not isinstance(port, int) or isinstance(port, bool) or port < 1 or port > 65535:
        raise ValueError("A port must be an integer of 1 to 65535.")
    if connect_timeout is not None:
        if not isinstance(connect_timeout, (int, float)) or connect_timeout <= 0:
            raise ValueError("connect_timeout must be a positive number.")
    if timeout is not None:
        if not isinstance(timeout, (int, float)) or timeout <= 0:
            raise ValueError("timeout must be a positive number.")
    if not isinstance(client_name, str) or not client_name:
        raise ValueError("A client name must be a nonempty string.")
    try:
        sock = socket.create_connection((host, port), connect_timeout or 10)
    except socket.error as error:
        raise connection_failure("Cannot connect to {0}:{1}: {2}".format(host, port, error), error)
    try:
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except socket.error:
        pass
    connection = TcpConnection(sock, client_name, connect_timeout or 10, timeout, None)
    try:
        response = connection._expect(
            "helloOk",
            {"type": "hello", "versions": [PROTOCOL_VERSION], "client": client_name},
            connect_timeout or 10)
    except Exception as error:
        connection.abort()
        raise error
    if response.get("version") != PROTOCOL_VERSION:
        connection.abort()
        raise connection_failure("The server uses an unsupported protocol version.")
    if response.get("mechanism") != AUTH_MECHANISM:
        connection.abort()
        raise connection_failure("The server uses an unsupported mechanism.")
    connection._hello = response
    return connection
