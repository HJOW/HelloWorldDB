"""HelloWorldDB Python 드라이버의 DB-API 2.0 모듈 수준이다.

관련 사양: PEP 249, AGENTS.md 디렉토리 구조 5, 구현 계획 D.
구현 단계: PY-3. TCP 접속만 지원하며 TLS와 UDP는 NotSupportedError이다.
"""

from helloworlddb import errors as _errors
from helloworlddb.connection import Connection
from helloworlddb.connection import connect
from helloworlddb.cursor import Cursor
from helloworlddb.types import BINARY as _BINARY_TYPE
from helloworlddb.types import Binary
from helloworlddb.types import DATETIME
from helloworlddb.types import Date
from helloworlddb.types import DateFromTicks
from helloworlddb.types import NUMBER
from helloworlddb.types import ROWID
from helloworlddb.types import STRING
from helloworlddb.types import Time
from helloworlddb.types import TimeFromTicks
from helloworlddb.types import Timestamp
from helloworlddb.types import TimestampFromTicks

__version__ = "0.1.0"

apilevel = "2.0"
threadsafety = 2
paramstyle = "qmark"

Error = _errors.Error
InterfaceError = _errors.InterfaceError
DatabaseError = _errors.DatabaseError
DataError = _errors.DataError
OperationalError = _errors.OperationalError
IntegrityError = _errors.IntegrityError
InternalError = _errors.InternalError
ProgrammingError = _errors.ProgrammingError
NotSupportedError = _errors.NotSupportedError

BINARY = _BINARY_TYPE

__all__ = ["__version__", "apilevel", "threadsafety", "paramstyle", "connect",
           "Connection", "Cursor", "Error", "InterfaceError", "DatabaseError",
           "DataError", "OperationalError", "IntegrityError", "InternalError",
           "ProgrammingError", "NotSupportedError", "Date", "Time", "Timestamp",
           "DateFromTicks", "TimeFromTicks", "TimestampFromTicks", "Binary",
           "STRING", "BINARY", "NUMBER", "DATETIME", "ROWID"]
