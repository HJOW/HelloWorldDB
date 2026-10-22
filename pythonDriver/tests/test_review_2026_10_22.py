"""2026-10-22 점검에서 찾은 결함(P-1 ~ P-6)의 회귀 시험이다.

대부분은 가짜 소켓이나 스텁으로 결정적으로 만든다. P-2 와 P-3 은 실제 rdbms 데몬으로 확인한다.
관련 사양: PEP 249, AGENTS.md 상세 8, 프로토콜 8절과 10절.
구현 단계: PY-3 (점검 보완)
"""

import json
import socket
import struct
import unittest

from helloworlddb import _protocol
from helloworlddb import _tcp
from helloworlddb import errors
from helloworlddb.cursor import Cursor
from helloworlddb.connection import Connection


def _response(payload):
    return json.dumps(payload).encode("utf-8")


class FakeSocket(object):
    """정해진 응답을 주거나 지정한 소켓 오류를 내는 소켓이다."""

    def __init__(self, recv_error=None):
        self._recv_error = recv_error
        self.sent = []
        self.closed = False

    def send(self, data):
        self.sent.append(bytes(data))
        return len(data)

    def sendall(self, data):
        self.sent.append(bytes(data))

    def recv(self, size):
        if self._recv_error is not None:
            raise self._recv_error
        return b""

    def settimeout(self, value):
        pass

    def setsockopt(self, *args):
        pass

    def close(self):
        self.closed = True

    def shutdown(self, how):
        pass


class StubWire(object):
    """Cursor 가 쓰는 와이어 객체의 흉내이다. 서버 응답을 차례로 돌려준다."""

    def __init__(self, responses=None, fetches=None):
        self._responses = list(responses or [])
        self._fetches = fetches if callable(fetches) else list(fetches or [])
        self.aborted = 0
        self.closed_cursors = []

    def execute_encoded(self, sql, params, fetch_size):
        return self._responses.pop(0)

    def fetch(self, cursor, size):
        if callable(self._fetches):
            return self._fetches()
        return self._fetches.pop(0)

    def close_cursor(self, cursor):
        self.closed_cursors.append(cursor)

    def abort(self):
        self.aborted += 1


class StubConnection(object):
    def __init__(self, wire):
        self._wire = wire
        self._fetch_size = 500
        self.closed = False

    def _forget_cursor(self, cursor):
        pass


class ResetSocketTests(unittest.TestCase):
    """P-1 : RST 등 소켓 오류는 DB-API 예외로 바뀌고 접속은 닫힌다."""

    def test_reset_while_waiting_for_a_response_is_an_operational_error(self):
        sock = FakeSocket(recv_error=socket.error(104, "Connection reset by peer"))
        connection = _tcp.TcpConnection(sock, "test", 5, None, None)
        with self.assertRaises(errors.OperationalError) as context:
            connection.execute("SELECT 1")
        self.assertIsInstance(context.exception, errors.Error)
        self.assertEqual(context.exception.sqlstate, "08006")
        self.assertTrue(connection.closed)
        self.assertTrue(sock.closed, "소켓을 닫는다")

    def test_reset_during_hello_is_an_operational_error(self):
        sock = FakeSocket(recv_error=socket.error(104, "Connection reset by peer"))
        connection = _tcp.TcpConnection(sock, "test", 5, 5, None)
        with self.assertRaises(errors.Error) as context:
            connection._expect("helloOk", {"type": "hello", "versions": [1], "client": "test"}, 5)
        self.assertNotIsInstance(context.exception, socket.error)
        self.assertTrue(connection.closed)


class ResponseShapeTests(unittest.TestCase):
    """P-4 : rows 응답의 columns 와 행 모양을 검사하고, 어긋나면 접속을 끊는 프로토콜 위반이다."""

    def _decode(self, payload):
        return _protocol.decode_response(_response(payload))

    def test_valid_rows_response_is_accepted(self):
        response = self._decode({"id": 3, "type": "rows", "columns": [
            {"name": "A", "typeName": "INTEGER"}], "rows": [[1], [2]], "hasMore": False})
        self.assertEqual(response["rows"], [[1], [2]])

    def test_columns_must_be_a_list_of_named_objects(self):
        for bad in ("AB", [1], [{"name": 1, "typeName": "INTEGER"}], [{"name": "A"}]):
            with self.assertRaises(errors.InterfaceError):
                self._decode({"id": 3, "type": "rows", "columns": bad, "rows": [], "hasMore": False})

    def test_rows_must_match_the_column_count(self):
        columns = [{"name": "A", "typeName": "INTEGER"}, {"name": "B", "typeName": "VARCHAR"}]
        for bad in ([[1]], [[1, "x", "extra"]], ["AB"]):
            with self.assertRaises(errors.InterfaceError):
                self._decode({"id": 3, "type": "rows", "columns": columns, "rows": bad, "hasMore": False})


class ExecuteStateTests(unittest.TestCase):
    """P-2 : 실패한 execute 는 이전 결과를 남기지 않는다. (실제 데몬)"""

    def test_failed_execute_clears_the_previous_result(self):
        from tests.rdbms_instance import RdbmsInstance, prerequisites
        prerequisites()
        instance = RdbmsInstance()
        with instance:
            connection = _tcp.connect("127.0.0.1", instance.port, connect_timeout=10)
            try:
                connection.login("SYSTEM", "HelloWorldDB")
                wire = connection
                db = Connection(wire, connection.session, True, 500)
                cursor = db.cursor()
                try:
                    cursor.execute("SELECT 1 UNION ALL SELECT 2")
                    self.assertEqual(cursor.fetchone(), [1])
                    with self.assertRaises(errors.Error):
                        cursor.execute("SELECT no_such_column_xyz FROM DUAL")
                    self.assertIsNone(cursor.description)
                    self.assertEqual(cursor.rowcount, -1)
                    # 결과 집합이 없으므로 fetch 는 옛 행이 아니라 오류이다. (P-5)
                    with self.assertRaises(errors.ProgrammingError):
                        cursor.fetchone()
                    with self.assertRaises(errors.ProgrammingError):
                        cursor.fetchall()
                finally:
                    cursor.close()
                db.close()
            finally:
                connection.abort()


class ConnectionCursorRegistryTests(unittest.TestCase):
    """P-3 : 닫은 커서는 접속의 목록에서 빠진다. (실제 데몬)"""

    def test_cursors_do_not_accumulate_across_commits(self):
        from tests.rdbms_instance import RdbmsInstance, prerequisites
        prerequisites()
        instance = RdbmsInstance()
        with instance:
            connection = _tcp.connect("127.0.0.1", instance.port, connect_timeout=10)
            try:
                connection.login("SYSTEM", "HelloWorldDB")
                db = Connection(connection, connection.session, False, 500)
                for _ in range(20):
                    db.commit()
                    db.rollback()
                self.assertEqual(len(db._cursors), 0, "문장마다 만든 커서가 남지 않는다")
                user = db.cursor()
                self.assertEqual(len(db._cursors), 1)
                user.close()
                self.assertEqual(len(db._cursors), 0)
                db.close()
            finally:
                connection.abort()


class FetchStateTests(unittest.TestCase):
    """P-5 : 결과 집합이 없으면 fetch 는 오류이다. (스텁)"""

    def test_fetch_without_a_result_set_is_a_programming_error(self):
        cursor = Cursor(StubConnection(StubWire()))
        with self.assertRaises(errors.ProgrammingError):
            cursor.fetchone()
        with self.assertRaises(errors.ProgrammingError):
            cursor.fetchmany(2)
        with self.assertRaises(errors.ProgrammingError):
            cursor.fetchall()

    def test_dml_result_has_no_fetch(self):
        wire = StubWire(responses=[{"id": 2, "type": "ok", "message": "INSERT 1", "rowCount": 1}])
        cursor = Cursor(StubConnection(wire))
        cursor.execute("INSERT INTO T VALUES (1)")
        self.assertEqual(cursor.rowcount, 1)
        with self.assertRaises(errors.ProgrammingError):
            cursor.fetchall()

    def test_empty_select_still_fetches_an_empty_list(self):
        wire = StubWire(responses=[{"id": 2, "type": "rows", "columns": [{"name": "A", "typeName": "INTEGER"}],
                                    "rows": [], "hasMore": False}])
        cursor = Cursor(StubConnection(wire))
        cursor.execute("SELECT A FROM T")
        self.assertEqual(cursor.fetchall(), [])


class EmptyBatchTests(unittest.TestCase):
    """P-6 : 빈 묶음에 hasMore 가 이어지면 프로토콜 위반이고 접속을 끊는다. (스텁)"""

    def test_empty_batch_with_more_rows_stops_the_loop_and_aborts(self):
        wire = StubWire(responses=[{"id": 2, "type": "rows", "columns": [{"name": "A", "typeName": "INTEGER"}],
                                    "rows": [[1]], "cursor": 9, "hasMore": True}],
                        fetches=lambda: {"id": 3, "type": "rows", "rows": [], "cursor": 9, "hasMore": True})
        cursor = Cursor(StubConnection(wire))
        cursor.execute("SELECT A FROM T")
        with self.assertRaises(errors.InterfaceError):
            cursor.fetchall()
        self.assertEqual(wire.aborted, 1)

    def test_empty_first_batch_with_more_rows_is_a_violation(self):
        wire = StubWire(responses=[{"id": 2, "type": "rows", "columns": [{"name": "A", "typeName": "INTEGER"}],
                                    "rows": [], "cursor": 9, "hasMore": True}])
        cursor = Cursor(StubConnection(wire))
        with self.assertRaises(errors.InterfaceError):
            cursor.execute("SELECT A FROM T")
        self.assertEqual(wire.aborted, 1)

    def test_fetch_rows_must_match_the_stored_columns(self):
        wire = StubWire(responses=[{"id": 2, "type": "rows", "columns": [{"name": "A", "typeName": "INTEGER"}],
                                    "rows": [[1]], "cursor": 9, "hasMore": True}],
                        fetches=[{"id": 3, "type": "rows", "rows": [[2, 3]], "hasMore": False}])
        cursor = Cursor(StubConnection(wire))
        cursor.execute("SELECT A FROM T")
        with self.assertRaises(errors.InterfaceError):
            cursor.fetchall()
        self.assertEqual(wire.aborted, 1)


if __name__ == "__main__":
    unittest.main()
