"""HelloWorldDB 서버 오류를 PEP 249 예외 계층으로 바꾼다.

관련 사양: AGENTS.md 상세 0, 8, 프로토콜 11절.
구현 단계: PY-2 (예외 계층은 PY-3에서 공개 API로 쓴다).
서버 메시지는 번역하지 않고 sqlstate와 code로 판단한다.
"""

class Error(Exception):
    """모든 드라이버 오류의 뿌리이다. sqlstate, code, position을 둔다."""

    def __init__(self, message, sqlstate=None, code=None, position=None):
        Exception.__init__(self, message)
        self.sqlstate = sqlstate
        self.code = code
        self.position = position
        self.cause = None


class InterfaceError(Error):
    """프로토콜 위반과 드라이버의 잘못된 사용이다."""


class DatabaseError(Error):
    """서버가 알린 데이터베이스 오류의 뿌리이다."""


class DataError(DatabaseError):
    """22xxx 전부이다."""


class OperationalError(DatabaseError):
    """접속, 인증, 자원과 한도, 잠금과 종료이다."""


class IntegrityError(DatabaseError):
    """23502, 23503, 23505이다."""


class InternalError(DatabaseError):
    """트랜잭션 상태, 커서 없음, 내부 오류이다."""


class ProgrammingError(DatabaseError):
    """파라미터, 문법, 이름, 권한과 객체 오류이다."""


class NotSupportedError(DatabaseError):
    """0A000이다."""


def error_from_response(sqlstate, code, message, position=None):
    """서버 오류 응답을 매핑표에 따라 예외로 바꾼다. 모르면 DatabaseError이다."""
    if sqlstate == "0A000":
        return NotSupportedError(message, sqlstate, code, position)
    if sqlstate == "08P01":
        return InterfaceError(message, sqlstate, code, position)
    if sqlstate in ("08001", "08003", "08006", "28000", "40001", "40P01",
                    "53300", "53400", "54000", "54001", "54011",
                    "55006", "55P03", "57P01", "57P05", "58030"):
        return OperationalError(message, sqlstate, code, position)
    if isinstance(sqlstate, str) and sqlstate.startswith("22"):
        return DataError(message, sqlstate, code, position)
    if sqlstate in ("23502", "23503", "23505"):
        return IntegrityError(message, sqlstate, code, position)
    if sqlstate in ("25001", "25P01", "34000", "XX000", "XX001"):
        return InternalError(message, sqlstate, code, position)
    if (sqlstate in ("07001", "0LP01", "21000", "3B001", "3D000", "3F000") or
            (isinstance(sqlstate, str) and sqlstate.startswith("42"))):
        return ProgrammingError(message, sqlstate, code, position)
    return DatabaseError(message, sqlstate, code, position)


def connection_failure(message, cause=None):
    """끊김과 제한 시간이다. SQLSTATE 08006, 내부 번호 8006. 서버는 보내지 않는다."""
    error = OperationalError(message, "08006", 8006, None)
    error.cause = cause
    return error


def protocol_violation(message, cause=None):
    """프로토콜 위반이다. SQLSTATE 08P01, 내부 번호 8000. 접속을 끊는다."""
    error = InterfaceError(message, "08P01", 8000, None)
    error.cause = cause
    return error


def connection_rejected(message, cause=None):
    """접속을 맺지 못함이다. SQLSTATE 08001, 내부 번호 8007. TLS용으로 둔다."""
    error = OperationalError(message, "08001", 8007, None)
    error.cause = cause
    return error
