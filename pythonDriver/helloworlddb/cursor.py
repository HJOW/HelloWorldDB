"""DB-API Cursor이다. 한 문장의 결과와 행 가져오기를 맡는다.

관련 사양: PEP 249, AGENTS.md 상세 8과 10, 프로토콜 10절.
구현 단계: PY-3. 서버 커서는 접속당 16개이므로 다 쓴 커서는 닫는다.
"""

from helloworlddb import errors
from helloworlddb import types


def _describe(column):
    name = column.get("name")
    type_name = column.get("typeName")
    if not isinstance(name, str) or not isinstance(type_name, str):
        raise errors.InterfaceError("Invalid column metadata.", "08P01", 8000, None)
    internal_size = column.get("length")
    if not isinstance(internal_size, int) or isinstance(internal_size, bool):
        internal_size = None
    precision = column.get("precision")
    if not isinstance(precision, int) or isinstance(precision, bool):
        precision = None
    scale = column.get("scale")
    if not isinstance(scale, int) or isinstance(scale, bool):
        scale = None
    return (name, type_name, None, internal_size, precision, scale, None)


class Cursor(object):
    """하나의 커서이다. 스레드 사이에서 공유하지 않는다."""

    def __init__(self, connection):
        self._connection = connection
        self._closed = False
        self.description = None
        self.rowcount = -1
        self.arraysize = 1
        self._columns = []
        self._buffer = []
        self._server_cursor = None
        self._has_more = False

    def _check_open(self):
        if self._closed:
            raise errors.InterfaceError("The cursor is closed.", None, None, None)
        if self._connection.closed:
            raise errors.InterfaceError("The connection is closed.", None, None, None)

    def _close_server_cursor(self):
        cursor = self._server_cursor
        self._server_cursor = None
        self._has_more = False
        if cursor is None:
            return
        try:
            self._connection._wire.close_cursor(cursor)
        except errors.Error:
            pass

    def _take_params(self, parameters):
        if parameters is None:
            return []
        if isinstance(parameters, dict):
            raise errors.ProgrammingError("Parameters must be a sequence.", None, None, None)
        if isinstance(parameters, (str, bytes, bytearray, memoryview)):
            raise errors.ProgrammingError("Parameters must be a sequence.", None, None, None)
        try:
            items = list(parameters)
        except TypeError:
            raise errors.ProgrammingError("Parameters must be a sequence.", None, None, None)
        return [types.encode_param(value, index) for index, value in enumerate(items)]

    def _store_rows(self, response):
        columns = response.get("columns") or []
        raws = response.get("rows") or []
        descriptions = [_describe(column) for column in columns]
        rows = []
        for raw in raws:
            rows.append([types.decode_value(value, columns[index] if index < len(columns) else {})
                         for index, value in enumerate(raw)])
        self._columns = columns
        self.description = descriptions or []
        # 빈 결과라도 조회는 빈 목록 description을 둔다.
        if not descriptions:
            self.description = []
        self._buffer = rows
        self.rowcount = -1
        if response.get("hasMore"):
            self._server_cursor = response.get("cursor")
            self._has_more = True
            if (not isinstance(self._server_cursor, int) or
                    isinstance(self._server_cursor, bool)):
                self._connection._wire.abort()
                raise errors.InterfaceError("Invalid cursor id.", "08P01", 8000, None)
        else:
            self._server_cursor = None
            self._has_more = False

    def _store_ok(self, response):
        count = response.get("rowCount")
        if isinstance(count, int) and not isinstance(count, bool):
            self.rowcount = count
        else:
            self.rowcount = -1
        self.description = None
        self._columns = []
        self._buffer = []
        self._server_cursor = None
        self._has_more = False

    def execute(self, operation, parameters=None):
        self._check_open()
        if not isinstance(operation, str):
            raise errors.ProgrammingError("SQL text must be a string.", None, None, None)
        encoded = self._take_params(parameters)
        fetch_size = self._connection._fetch_size
        self._close_server_cursor()
        response = self._connection._wire.execute_encoded(operation, encoded, fetch_size)
        if response.get("type") == "rows":
            self._store_rows(response)
        else:
            self._store_ok(response)
        return self

    def executemany(self, operation, seq_of_parameters):
        self._check_open()
        if not isinstance(operation, str):
            raise errors.ProgrammingError("SQL text must be a string.", None, None, None)
        try:
            groups = list(seq_of_parameters)
        except TypeError:
            raise errors.ProgrammingError("Parameters must be a sequence of sequences.",
                                          None, None, None)
        if not groups:
            self.description = None
            self.rowcount = -1
            self._buffer = []
            return
        total = 0
        saw_rows = False
        for parameters in groups:
            self.execute(operation, parameters)
            if self.description is not None:
                saw_rows = True
            elif self.rowcount >= 0:
                total += self.rowcount
        if saw_rows:
            self.rowcount = -1
        else:
            self.rowcount = total
        return

    def _fill(self, count):
        while self._has_more and len(self._buffer) < count:
            batch = self._connection._wire.fetch(self._server_cursor,
                                                 self._connection._fetch_size)
            raws = batch.get("rows") or []
            columns = self._columns
            for raw in raws:
                self._buffer.append(
                    [types.decode_value(value, columns[index] if index < len(columns) else {})
                     for index, value in enumerate(raw)])
            if batch.get("hasMore"):
                cursor = batch.get("cursor")
                if (not isinstance(cursor, int) or isinstance(cursor, bool)):
                    self._connection._wire.abort()
                    raise errors.InterfaceError("Invalid cursor id.", "08P01", 8000, None)
                self._server_cursor = cursor
            else:
                self._server_cursor = None
                self._has_more = False

    def fetchone(self):
        self._check_open()
        if self.description is None:
            return None
        self._fill(1)
        if not self._buffer:
            return None
        return self._buffer.pop(0)

    def fetchmany(self, size=None):
        self._check_open()
        if size is None:
            size = self.arraysize
        if (not isinstance(size, int) or isinstance(size, bool) or size < 0):
            raise errors.ProgrammingError("Fetch size must be a non-negative integer.",
                                          None, None, None)
        if self.description is None:
            return []
        self._fill(size)
        taken = self._buffer[0:size]
        del self._buffer[0:size]
        return taken

    def fetchall(self):
        self._check_open()
        if self.description is None:
            return []
        while self._has_more:
            self._fill(len(self._buffer) + 1)
            if not self._has_more:
                break
        taken = self._buffer
        self._buffer = []
        return taken

    def close(self):
        if self._closed:
            return
        try:
            self._close_server_cursor()
        finally:
            self._closed = True
            self._buffer = []

    def setinputsizes(self, *args):
        return

    def setoutputsize(self, size, column=None):
        return

    def callproc(self, procname, parameters=None):
        raise errors.NotSupportedError("Stored procedures are not supported.",
                                       "0A000", 1, None)

    def nextset(self):
        self._check_open()
        return None

    def __iter__(self):
        return self

    def __next__(self):
        row = self.fetchone()
        if row is None:
            raise StopIteration()
        return row

    def __enter__(self):
        self._check_open()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()
        return False

    def __del__(self):
        try:
            if not self._closed:
                self._close_server_cursor()
        except Exception:
            pass
