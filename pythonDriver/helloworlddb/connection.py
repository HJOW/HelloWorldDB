"""DB-API Connection과 connect()이다. TCP 전송 위를 감싼다.

관련 사양: PEP 249, AGENTS.md 상세 8, 10과 15, 프로토콜 5절부터 7절.
구현 단계: PY-3. PY-3에서는 TCP만 쓰며 TLS와 UDP는 NotSupportedError이다.
자동 커밋은 처음에 꺼둔다 (PEP 249). 서버의 기본은 켜짐이다.
"""

import threading as _threading

from helloworlddb import _tcp
from helloworlddb import errors
from helloworlddb.cursor import Cursor

Error = errors.Error
InterfaceError = errors.InterfaceError
DatabaseError = errors.DatabaseError
DataError = errors.DataError
OperationalError = errors.OperationalError
IntegrityError = errors.IntegrityError
InternalError = errors.InternalError
ProgrammingError = errors.ProgrammingError
NotSupportedError = errors.NotSupportedError


def _normalize_tablespace(name):
    if len(name) >= 2 and name[0:1] == '"' and name[-1:] == '"':
        return name[1:-1].replace('""', '"')
    return name.upper()


def _check_timeout(value, name):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        raise errors.ProgrammingError("{0} must be a positive number.".format(name),
                                      None, None, None)
    return value


class Connection(object):
    """DB-API 접속 하나이다. 스레드가 공유할 수 있고 요청은 순서대로 처리한다."""

    Error = errors.Error
    InterfaceError = errors.InterfaceError
    DatabaseError = errors.DatabaseError
    DataError = errors.DataError
    OperationalError = errors.OperationalError
    IntegrityError = errors.IntegrityError
    InternalError = errors.InternalError
    ProgrammingError = errors.ProgrammingError
    NotSupportedError = errors.NotSupportedError

    def __init__(self, wire, session, autocommit, fetch_size):
        self._wire = wire
        self._lock = _threading.Lock()
        self._closed = False
        self._cursors = []
        self._autocommit = bool(autocommit)
        self._fetch_size = fetch_size
        info = session or {}
        self._tablespace = info.get("tablespace")
        self._time_zone = info.get("timeZone")
        self._user = info.get("user")

    @property
    def closed(self):
        return self._closed

    @property
    def autocommit(self):
        return self._autocommit

    @autocommit.setter
    def autocommit(self, value):
        self.set_autocommit(value)

    @property
    def tablespace(self):
        return self._tablespace

    @property
    def time_zone(self):
        return self._time_zone

    def _check_open(self):
        if self._closed:
            raise errors.InterfaceError("The connection is closed.", None, None, None)

    def cursor(self):
        self._lock.acquire()
        try:
            self._check_open()
            cursor = Cursor(self)
            self._cursors.append(cursor)
            return cursor
        finally:
            self._lock.release()

    def _run(self, sql):
        cursor = self.cursor()
        try:
            cursor.execute(sql)
        finally:
            cursor.close()

    def commit(self):
        self._check_open()
        self._run("COMMIT")

    def rollback(self):
        self._check_open()
        self._run("ROLLBACK")

    def set_autocommit(self, value):
        self._check_open()
        enabled = bool(value)
        self._run("SET AUTOCOMMIT ON" if enabled else "SET AUTOCOMMIT OFF")
        self._autocommit = enabled

    def close(self):
        self._lock.acquire()
        try:
            if self._closed:
                return
            self._closed = True
            cursors = list(self._cursors)
            self._cursors = []
        finally:
            self._lock.release()
        for cursor in cursors:
            try:
                cursor.close()
            except errors.Error:
                pass
        try:
            self._wire.close()
        except errors.Error:
            pass

    def __enter__(self):
        self._check_open()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        if exc_type is None:
            self.commit()
        else:
            try:
                self.rollback()
            except errors.Error:
                pass
        return False

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass


def connect(host="127.0.0.1", port=7410, user=None, password=None, tablespace=None,
            time_zone=None, udp=False, ssl=False, ssl_ca=None, ssl_verify=True,
            autocommit=False, fetch_size=None, connect_timeout=10, timeout=None):
    """서버에 접속하고 DB-API Connection을 돌려준다. 대상은 호스트와 포트뿐이다."""
    if udp:
        raise errors.NotSupportedError("UDP is not supported yet.", "0A000", 1, None)
    if ssl:
        raise errors.NotSupportedError("TLS is not supported yet.", "0A000", 1, None)
    if ssl_ca is not None or ssl_verify is not True:
        if ssl_ca is not None and ssl_verify is not True:
            raise errors.ProgrammingError("ssl_ca and ssl_verify=False cannot be combined.",
                                          None, None, None)
        raise errors.ProgrammingError("SSL options need ssl=True.", None, None, None)
    if udp and ssl:
        raise errors.ProgrammingError("udp and ssl cannot be combined.", None, None, None)
    if not isinstance(host, str) or not host:
        raise errors.ProgrammingError("A host must be a nonempty string.", None, None, None)
    if (not isinstance(port, int) or isinstance(port, bool) or port < 1 or port > 65535):
        raise errors.ProgrammingError("A port must be an integer of 1 to 65535.",
                                      None, None, None)
    if user is None or password is None:
        raise errors.ProgrammingError("user and password are required.", None, None, None)
    if not isinstance(user, str) or not user:
        raise errors.ProgrammingError("A user name must be a nonempty string.",
                                      None, None, None)
    if not isinstance(password, str):
        raise errors.ProgrammingError("A password must be a string.", None, None, None)
    sending_tablespace = None
    if tablespace is not None:
        if not isinstance(tablespace, str) or not tablespace:
            raise errors.ProgrammingError("A tablespace must be a nonempty string.",
                                          None, None, None)
        sending_tablespace = _normalize_tablespace(tablespace)
    if time_zone is not None and (not isinstance(time_zone, str) or not time_zone):
        raise errors.ProgrammingError("A time zone must be a nonempty string.",
                                      None, None, None)
    if fetch_size is not None:
        if (not isinstance(fetch_size, int) or isinstance(fetch_size, bool) or
                fetch_size < 1):
            raise errors.ProgrammingError("fetch_size must be an integer of 1 or more.",
                                          None, None, None)
    connect_timeout = _check_timeout(connect_timeout, "connect_timeout")
    timeout = _check_timeout(timeout, "timeout")
    try:
        wire = _tcp.connect(host, port, connect_timeout or 10, timeout)
    except errors.Error:
        raise
    except (TypeError, ValueError) as error:
        raise errors.ProgrammingError(str(error), None, None, None)
    try:
        session = wire.login(user, password, sending_tablespace, time_zone)
    except errors.Error:
        wire.abort()
        raise
    connection = Connection(wire, session, True, fetch_size)
    if not autocommit:
        try:
            wire.execute("SET AUTOCOMMIT OFF", [], None)
        except errors.Error:
            wire.abort()
            raise
        connection._autocommit = False
    return connection
