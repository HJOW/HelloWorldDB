"""TCP 프로토콜 코어를 검증한다. 가짜 서버와 실제 rdbms를 함께 쓴다.

관련 사양: AGENTS.md 상세 8, 프로토콜 2-1절, 3절부터 7절, 10절, 11절.
구현 단계: PY-2. DB-API는 PY-3이다.
"""

import base64
import hashlib
import hmac
import json
import socket
import struct
import threading
import time
import unittest

from helloworlddb import _compat
from helloworlddb import _scram
from helloworlddb import _tcp
from helloworlddb import errors
from helloworlddb._protocol import FrameDecoder
from helloworlddb._protocol import encode_frame
from helloworlddb._protocol import encode_message


RFC_SALT = "W22ZaJ0SNY7soEsUEjb6gQ=="
RFC_ITERATIONS = 4096
RFC_PASSWORD = "pencil"


def server_send(conn, payload):
    body = encode_message(payload)
    conn.sendall(encode_frame(body))


def server_send_raw(conn, data):
    conn.sendall(data)


def server_read(conn, decoder):
    while True:
        chunk = conn.recv(65536)
        if chunk == b"":
            raise AssertionError("Client closed the connection.")
        bodies = decoder.push(chunk)
        if bodies:
            return json.loads(bodies[0].decode("utf-8"))


def start_fake_server(handler):
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    done = threading.Event()

    def run():
        try:
            conn, _ = listener.accept()
            conn.settimeout(5)
            try:
                handler(conn)
            finally:
                try:
                    conn.close()
                except socket.error:
                    pass
        finally:
            try:
                listener.close()
            except socket.error:
                pass
            done.set()

    thread = threading.Thread(target=run)
    thread.daemon = True
    thread.start()
    return port, thread, done


def hello_exchange(conn, request_id=1):
    decoder = FrameDecoder(16777216)
    request = server_read(conn, decoder)
    assert request["type"] == "hello"
    server_send(conn, {"id": request["id"], "type": "helloOk", "version": 1,
                       "server": "fake", "mechanism": "SCRAM-SHA-256",
                       "maxMessageBytes": 16777216, "defaultFetchSize": 500})
    return decoder, request


def compute_server_signature(password, salt_b64, iterations, message):
    salt = base64.b64decode(salt_b64.encode("ascii"))
    norm = _scram.normalize_password(password).encode("utf-8")
    salted = _compat.pbkdf2_hmac("sha256", norm, salt, iterations, 32)
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    if isinstance(message, str):
        message = message.encode("utf-8")
    return base64.b64encode(hmac.new(server_key, message, hashlib.sha256).digest()).decode("ascii")


def full_login_script(password=RFC_PASSWORD, salt=RFC_SALT, iterations=RFC_ITERATIONS,
                      nonce_suffix="ServerPart123", fail_with=None):
    def handler(conn):
        decoder, _ = hello_exchange(conn)
        request = server_read(conn, decoder)
        assert request["type"] == "authStart"
        first = request["clientFirst"]
        assert first.startswith("n,,")
        bare = first[3:]
        client_nonce = bare.split(",r=", 1)[1]
        combined = client_nonce + nonce_suffix
        server_first = "r={0},s={1},i={2}".format(combined, salt, iterations)
        server_send(conn, {"id": request["id"], "type": "authChallenge",
                           "serverFirst": server_first})
        finish = server_read(conn, decoder)
        assert finish["type"] == "authFinish"
        if fail_with is not None:
            server_send(conn, {"id": finish["id"], "type": "error",
                               "sqlState": fail_with[0], "code": fail_with[1],
                               "message": fail_with[2]})
            return
        without_proof = _scram.client_final_without_proof(combined)
        message = _scram.auth_message(bare, server_first, without_proof)
        signature = compute_server_signature(password, salt, iterations, message)
        server_send(conn, {"id": finish["id"], "type": "authOk",
                           "serverFinal": "v={0}".format(signature),
                           "session": {"id": 1, "user": "SYSTEM", "tablespace": "SYSTEM",
                                       "timeZone": "Asia/Seoul", "autocommit": True}})
        # Keep the connection open for further scripted messages.
        decoder2 = decoder
        while True:
            try:
                request = server_read(conn, decoder2)
            except AssertionError:
                return
            if request["type"] == "ping":
                server_send(conn, {"id": request["id"], "type": "pong"})
            elif request["type"] == "close":
                server_send(conn, {"id": request["id"], "type": "bye"})
                return
            elif request["type"] == "execute":
                server_send(conn, {"id": request["id"], "type": "ok",
                                   "message": "done", "rowCount": 1})
            elif request["type"] == "closeCursor":
                server_send(conn, {"id": request["id"], "type": "cursorClosed"})
            else:
                server_send(conn, {"id": request["id"], "type": "error",
                                   "sqlState": "08P01", "code": 8000, "message": "Unexpected."})
                return
    return handler


class FakeServerTests(unittest.TestCase):
    def test_hello_success(self):
        def handler(conn):
            hello_exchange(conn)

        port, thread, done = start_fake_server(handler)
        connection = _tcp.connect("127.0.0.1", port, connect_timeout=5)
        try:
            self.assertEqual(connection.hello_info["version"], 1)
            self.assertEqual(connection.hello_info["mechanism"], "SCRAM-SHA-256")
        finally:
            connection.abort()
        self.assertTrue(done.wait(5))

    def test_hello_version_mismatch(self):
        def handler(conn):
            decoder = FrameDecoder(16777216)
            request = server_read(conn, decoder)
            server_send(conn, {"id": request["id"], "type": "error",
                               "sqlState": "0A000", "code": 1, "message": "No common version."})

        port, thread, done = start_fake_server(handler)
        with self.assertRaises(errors.NotSupportedError) as context:
            _tcp.connect("127.0.0.1", port, connect_timeout=5)
        self.assertEqual(context.exception.sqlstate, "0A000")
        self.assertTrue(done.wait(5))

    def test_hello_wrong_type_closes(self):
        def handler(conn):
            decoder = FrameDecoder(16777216)
            request = server_read(conn, decoder)
            server_send(conn, {"id": request["id"], "type": "pong"})

        port, thread, done = start_fake_server(handler)
        with self.assertRaises(errors.Error) as context:
            _tcp.connect("127.0.0.1", port, connect_timeout=5)
        self.assertEqual(context.exception.sqlstate, "08006")
        self.assertTrue(done.wait(5))

    def test_login_success_and_ping(self):
        port, thread, done = start_fake_server(full_login_script())
        connection = _tcp.connect("127.0.0.1", port, connect_timeout=5)
        try:
            session = connection.login("SYSTEM", RFC_PASSWORD)
            self.assertEqual(session["user"], "SYSTEM")
            connection.ping()
            result = connection.execute("SELECT 1")
            self.assertEqual(result["type"], "ok")
            closing = connection.close()
            self.assertEqual(closing, {"rolledBack": False})
        finally:
            connection.abort()
        self.assertTrue(done.wait(5))

    def test_login_bad_nonce(self):
        def handler(conn):
            decoder, _ = hello_exchange(conn)
            request = server_read(conn, decoder)
            server_send(conn, {"id": request["id"], "type": "authChallenge",
                               "serverFirst": "r=unrelated,s=c2FsdA==,i=4096"})

        port, thread, done = start_fake_server(handler)
        connection = _tcp.connect("127.0.0.1", port, connect_timeout=5)
        try:
            with self.assertRaises(errors.OperationalError) as context:
                connection.login("SYSTEM", RFC_PASSWORD)
            self.assertEqual(context.exception.sqlstate, "08006")
            self.assertTrue(connection.closed)
        finally:
            connection.abort()
        self.assertTrue(done.wait(5))

    def test_login_bad_iterations(self):
        def handler(conn):
            decoder, _ = hello_exchange(conn)
            request = server_read(conn, decoder)
            bare = request["clientFirst"][3:]
            nonce = bare.split(",r=", 1)[1]
            server_send(conn, {"id": request["id"], "type": "authChallenge",
                               "serverFirst": "r={0}XYZ,s=c2FsdA==,i=0".format(nonce)})

        port, thread, done = start_fake_server(handler)
        connection = _tcp.connect("127.0.0.1", port, connect_timeout=5)
        try:
            with self.assertRaises(errors.OperationalError) as context:
                connection.login("SYSTEM", RFC_PASSWORD)
            self.assertEqual(context.exception.sqlstate, "08006")
        finally:
            connection.abort()
        self.assertTrue(done.wait(5))

    def test_login_bad_signature(self):
        def handler(conn):
            decoder, _ = hello_exchange(conn)
            request = server_read(conn, decoder)
            bare = request["clientFirst"][3:]
            nonce = bare.split(",r=", 1)[1]
            combined = nonce + "ServerPart123"
            server_send(conn, {"id": request["id"], "type": "authChallenge",
                               "serverFirst": "r={0},s={1},i=4096".format(combined, RFC_SALT)})
            finish = server_read(conn, decoder)
            server_send(conn, {"id": finish["id"], "type": "authOk",
                               "serverFinal": "v=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                               "session": {"id": 1, "user": "SYSTEM", "tablespace": "SYSTEM",
                                           "timeZone": "UTC", "autocommit": True}})

        port, thread, done = start_fake_server(handler)
        connection = _tcp.connect("127.0.0.1", port, connect_timeout=5)
        try:
            with self.assertRaises(errors.OperationalError) as context:
                connection.login("SYSTEM", RFC_PASSWORD)
            self.assertEqual(context.exception.sqlstate, "08006")
        finally:
            connection.abort()
        self.assertTrue(done.wait(5))

    def test_login_failure_is_operational(self):
        port, thread, done = start_fake_server(
            full_login_script(fail_with=("28000", 7000, "Authentication failed.")))
        connection = _tcp.connect("127.0.0.1", port, connect_timeout=5)
        try:
            with self.assertRaises(errors.OperationalError) as context:
                connection.login("SYSTEM", "wrong")
            self.assertEqual(context.exception.sqlstate, "28000")
            self.assertEqual(context.exception.code, 7000)
        finally:
            connection.abort()
        self.assertTrue(done.wait(5))

    def test_execute_error_keeps_connection(self):
        def handler(conn):
            decoder, _ = hello_exchange(conn)
            login_request = server_read(conn, decoder)
            bare = login_request["clientFirst"][3:]
            nonce = bare.split(",r=", 1)[1]
            combined = nonce + "S"
            server_first = "r={0},s={1},i=4096".format(combined, RFC_SALT)
            server_send(conn, {"id": login_request["id"], "type": "authChallenge",
                               "serverFirst": server_first})
            finish = server_read(conn, decoder)
            message = _scram.auth_message(
                bare, server_first, _scram.client_final_without_proof(combined))
            signature = compute_server_signature(RFC_PASSWORD, RFC_SALT, 4096, message)
            server_send(conn, {"id": finish["id"], "type": "authOk",
                               "serverFinal": "v={0}".format(signature),
                               "session": {"id": 1, "user": "SYSTEM", "tablespace": "SYSTEM",
                                           "timeZone": "UTC", "autocommit": True}})
            first = server_read(conn, decoder)
            server_send(conn, {"id": first["id"], "type": "error", "sqlState": "42601",
                               "code": 3000, "message": "Syntax error.",
                               "position": {"line": 1, "column": 3, "offset": 2}})
            second = server_read(conn, decoder)
            self.assertEqual(second["type"], "ping")
            server_send(conn, {"id": second["id"], "type": "pong"})

        port, thread, done = start_fake_server(handler)
        connection = _tcp.connect("127.0.0.1", port, connect_timeout=5)
        try:
            connection.login("SYSTEM", RFC_PASSWORD)
            with self.assertRaises(errors.ProgrammingError) as context:
                connection.execute("BAD SQL")
            self.assertEqual(context.exception.sqlstate, "42601")
            self.assertEqual(context.exception.position["column"], 3)
            connection.ping()
        finally:
            connection.abort()
        self.assertTrue(done.wait(5))

    def test_id_zero_error_closes(self):
        def handler(conn):
            decoder, _ = hello_exchange(conn)
            login_request = server_read(conn, decoder)
            bare = login_request["clientFirst"][3:]
            nonce = bare.split(",r=", 1)[1]
            combined = nonce + "S"
            server_first = "r={0},s={1},i=4096".format(combined, RFC_SALT)
            server_send(conn, {"id": login_request["id"], "type": "authChallenge",
                               "serverFirst": server_first})
            finish = server_read(conn, decoder)
            message = _scram.auth_message(
                bare, server_first, _scram.client_final_without_proof(combined))
            signature = compute_server_signature(RFC_PASSWORD, RFC_SALT, 4096, message)
            server_send(conn, {"id": finish["id"], "type": "authOk",
                               "serverFinal": "v={0}".format(signature),
                               "session": {"id": 1, "user": "SYSTEM", "tablespace": "SYSTEM",
                                           "timeZone": "UTC", "autocommit": True}})
            execute = server_read(conn, decoder)
            server_send(conn, {"id": 0, "type": "error", "sqlState": "57P01",
                               "code": 6003, "message": "Server shutdown."})

        port, thread, done = start_fake_server(handler)
        connection = _tcp.connect("127.0.0.1", port, connect_timeout=5)
        try:
            connection.login("SYSTEM", RFC_PASSWORD)
            with self.assertRaises(errors.OperationalError) as context:
                connection.execute("SELECT 1")
            self.assertEqual(context.exception.sqlstate, "57P01")
            self.assertTrue(connection.closed)
        finally:
            connection.abort()
        self.assertTrue(done.wait(5))

    def test_disconnect_becomes_08006(self):
        def handler(conn):
            decoder, _ = hello_exchange(conn)
            login_request = server_read(conn, decoder)
            bare = login_request["clientFirst"][3:]
            nonce = bare.split(",r=", 1)[1]
            combined = nonce + "S"
            server_first = "r={0},s={1},i=4096".format(combined, RFC_SALT)
            server_send(conn, {"id": login_request["id"], "type": "authChallenge",
                               "serverFirst": server_first})
            finish = server_read(conn, decoder)
            message = _scram.auth_message(
                bare, server_first, _scram.client_final_without_proof(combined))
            signature = compute_server_signature(RFC_PASSWORD, RFC_SALT, 4096, message)
            server_send(conn, {"id": finish["id"], "type": "authOk",
                               "serverFinal": "v={0}".format(signature),
                               "session": {"id": 1, "user": "SYSTEM", "tablespace": "SYSTEM",
                                           "timeZone": "UTC", "autocommit": True}})
            # Close without answering the next request.
            server_read(conn, decoder)
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except socket.error:
                pass

        port, thread, done = start_fake_server(handler)
        connection = _tcp.connect("127.0.0.1", port, connect_timeout=5)
        try:
            connection.login("SYSTEM", RFC_PASSWORD)
            with self.assertRaises(errors.OperationalError) as context:
                connection.execute("SELECT 1")
            self.assertEqual(context.exception.sqlstate, "08006")
        finally:
            connection.abort()
        self.assertTrue(done.wait(5))

    def test_split_frame_one_byte_at_a_time(self):
        def handler(conn):
            decoder = FrameDecoder(16777216)
            request = server_read(conn, decoder)
            body = encode_message({"id": request["id"], "type": "helloOk", "version": 1,
                                   "server": "fake", "mechanism": "SCRAM-SHA-256",
                                   "maxMessageBytes": 16777216, "defaultFetchSize": 500})
            frame = encode_frame(body)
            for index in range(len(frame)):
                server_send_raw(conn, frame[index:index + 1])
                time.sleep(0.001)

        port, thread, done = start_fake_server(handler)
        connection = _tcp.connect("127.0.0.1", port, connect_timeout=5)
        try:
            self.assertEqual(connection.hello_info["version"], 1)
        finally:
            connection.abort()
        self.assertTrue(done.wait(5))

    def test_request_timeout_keeps_connection(self):
        def handler(conn):
            decoder, _ = hello_exchange(conn)
            login_request = server_read(conn, decoder)
            bare = login_request["clientFirst"][3:]
            nonce = bare.split(",r=", 1)[1]
            combined = nonce + "S"
            server_first = "r={0},s={1},i=4096".format(combined, RFC_SALT)
            server_send(conn, {"id": login_request["id"], "type": "authChallenge",
                               "serverFirst": server_first})
            finish = server_read(conn, decoder)
            message = _scram.auth_message(
                bare, server_first, _scram.client_final_without_proof(combined))
            signature = compute_server_signature(RFC_PASSWORD, RFC_SALT, 4096, message)
            server_send(conn, {"id": finish["id"], "type": "authOk",
                               "serverFinal": "v={0}".format(signature),
                               "session": {"id": 1, "user": "SYSTEM", "tablespace": "SYSTEM",
                                           "timeZone": "UTC", "autocommit": True}})
            first = server_read(conn, decoder)
            time.sleep(0.6)
            server_send(conn, {"id": first["id"], "type": "pong"})
            second = server_read(conn, decoder)
            server_send(conn, {"id": second["id"], "type": "pong"})

        port, thread, done = start_fake_server(handler)
        connection = _tcp.connect("127.0.0.1", port, connect_timeout=5, timeout=0.2)
        try:
            connection.login("SYSTEM", RFC_PASSWORD)
            with self.assertRaises(errors.OperationalError) as context:
                connection.ping()
            self.assertEqual(context.exception.sqlstate, "08006")
            connection._timeout = 5
            connection.ping()
        finally:
            connection.abort()
        self.assertTrue(done.wait(5))

    def test_close_reports_rolled_back(self):
        def handler(conn):
            decoder, _ = hello_exchange(conn)
            login_request = server_read(conn, decoder)
            bare = login_request["clientFirst"][3:]
            nonce = bare.split(",r=", 1)[1]
            combined = nonce + "S"
            server_first = "r={0},s={1},i=4096".format(combined, RFC_SALT)
            server_send(conn, {"id": login_request["id"], "type": "authChallenge",
                               "serverFirst": server_first})
            finish = server_read(conn, decoder)
            message = _scram.auth_message(
                bare, server_first, _scram.client_final_without_proof(combined))
            signature = compute_server_signature(RFC_PASSWORD, RFC_SALT, 4096, message)
            server_send(conn, {"id": finish["id"], "type": "authOk",
                               "serverFinal": "v={0}".format(signature),
                               "session": {"id": 1, "user": "SYSTEM", "tablespace": "SYSTEM",
                                           "timeZone": "UTC", "autocommit": True}})
            closing = server_read(conn, decoder)
            self.assertEqual(closing["type"], "close")
            server_send(conn, {"id": closing["id"], "type": "bye", "rolledBack": True})

        port, thread, done = start_fake_server(handler)
        connection = _tcp.connect("127.0.0.1", port, connect_timeout=5)
        try:
            connection.login("SYSTEM", RFC_PASSWORD)
            self.assertEqual(connection.close(), {"rolledBack": True})
            self.assertTrue(connection.closed)
        finally:
            connection.abort()
        self.assertTrue(done.wait(5))


class RealServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from tests.rdbms_instance import prerequisites
        prerequisites()

    def test_login_query_and_errors(self):
        from tests.rdbms_instance import RdbmsInstance
        instance = RdbmsInstance()
        with instance:
            connection = _tcp.connect("127.0.0.1", instance.port, connect_timeout=10)
            try:
                session = connection.login("SYSTEM", "HelloWorldDB")
                self.assertEqual(session["user"], "SYSTEM")
                hello = connection.execute("SELECT 'Hello World' AS GREETING")
                self.assertEqual(hello["type"], "rows")
                self.assertEqual(hello["rows"], [["Hello World"]])
                created = connection.execute("CREATE TABLE HELLO (MESSAGE VARCHAR)")
                self.assertEqual(created["type"], "ok")
                inserted = connection.execute(
                    "INSERT INTO HELLO VALUES ('Hello World')")
                self.assertEqual(inserted["type"], "ok")
                selected = connection.execute("SELECT * FROM HELLO")
                self.assertEqual(selected["rows"], [["Hello World"]])
                with self.assertRaises(errors.ProgrammingError):
                    connection.execute("SELECT * FROM NO_SUCH_TABLE_XYZ")
                connection.ping()
                closing = connection.close()
                self.assertTrue(isinstance(closing, dict))
            finally:
                connection.abort()

    def test_login_failure(self):
        from tests.rdbms_instance import RdbmsInstance
        instance = RdbmsInstance()
        with instance:
            connection = _tcp.connect("127.0.0.1", instance.port, connect_timeout=10)
            try:
                with self.assertRaises(errors.OperationalError) as context:
                    connection.login("SYSTEM", "wrong-password")
                self.assertEqual(context.exception.sqlstate, "28000")
            finally:
                connection.abort()

    def test_large_results_use_cursor(self):
        from tests.rdbms_instance import RdbmsInstance
        instance = RdbmsInstance()
        with instance:
            connection = _tcp.connect("127.0.0.1", instance.port, connect_timeout=10)
            try:
                connection.login("SYSTEM", "HelloWorldDB")
                connection.execute("CREATE TABLE BIGTEST (ID INTEGER PRIMARY KEY, NAME VARCHAR)")
                for number in range(10):
                    connection.execute(
                        "INSERT INTO BIGTEST VALUES (?, ?)", [number, "name-{0}".format(number)])
                first = connection.execute("SELECT ID FROM BIGTEST ORDER BY ID", [], 3)
                self.assertEqual(first["type"], "rows")
                self.assertTrue(first["hasMore"])
                self.assertTrue(first.get("cursor"))
                gathered = list(first["rows"])
                cursor = first.get("cursor")
                columns = first.get("columns")
                while True:
                    batch = connection.fetch(cursor, 3)
                    gathered.extend(batch["rows"])
                    if not batch["hasMore"]:
                        cursor = batch.get("cursor")
                        break
                    cursor = batch.get("cursor")
                self.assertEqual(len(gathered), 10)
                self.assertEqual(gathered[0], [0])
                if cursor is not None:
                    connection.close_cursor(cursor)
                self.assertTrue(columns)
            finally:
                connection.abort()


if __name__ == "__main__":
    unittest.main()
