"""DB-API 값 변환과 타입 객체, 날짜 생성자를 제공한다.

관련 사양: AGENTS.md 상세 1, 8, 프로토콜 8절과 9절, rdbms/docs/data-types.md.
구현 단계: PY-3. 수신은 컬럼 메타데이터의 typeName으로, 송신은 Python 값의 형으로 바꾼다.
"""

import datetime as _datetime
import decimal as _decimal
import re as _re

from helloworlddb import _compat
from helloworlddb import errors


class TypeObject(object):
    """PEP 249 타입 객체이다. 정확한 타입 이름 문자열과 == 로 비교된다."""

    def __init__(self, *values):
        self._values = frozenset(values)

    def __eq__(self, other):
        if isinstance(other, TypeObject):
            return self._values == other._values
        if isinstance(other, str):
            return other in self._values
        return NotImplemented

    def __ne__(self, other):
        result = self.__eq__(other)
        if result is NotImplemented:
            return result
        return not result

    def __hash__(self):
        return hash(self._values)

    def __repr__(self):
        return "TypeObject({0})".format(sorted(self._values))


STRING = TypeObject("CHAR", "VARCHAR")
BINARY = TypeObject("BINARY", "VARBINARY")
NUMBER = TypeObject("SMALLINT", "INTEGER", "BIGINT", "DECIMAL",
                    "REAL", "DOUBLE PRECISION")
DATETIME = TypeObject("DATE", "TIME", "TIME WITH TIME ZONE",
                      "TIMESTAMP", "TIMESTAMP WITH TIME ZONE")
ROWID = TypeObject()


def Date(year, month, day):
    return _datetime.date(year, month, day)


def Time(hour, minute, second=0, microsecond=0, tzinfo=None):
    return _datetime.time(hour, minute, second, microsecond, tzinfo)


def Timestamp(year, month, day, hour=0, minute=0, second=0, microsecond=0, tzinfo=None):
    return _datetime.datetime(year, month, day, hour, minute, second, microsecond, tzinfo)


def DateFromTicks(ticks):
    return _datetime.date.fromtimestamp(ticks)


def TimeFromTicks(ticks):
    return _datetime.datetime.fromtimestamp(ticks).timetz()


def TimestampFromTicks(ticks):
    return _datetime.datetime.fromtimestamp(ticks)


def Binary(value):
    if isinstance(value, str):
        return value.encode("utf-8")
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value)
    raise TypeError("Binary value must be bytes-like or a string.")


def _bad_value(message):
    return errors.InterfaceError(message, "08P01", 8000, None)


_DATE_RE = _re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_TIME_RE = _re.compile(r"^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?"
                      r"(Z|[+-]\d{2}:?\d{2}|[+-]\d{2}|[+-]\d{4})?$")
_STAMP_RE = _re.compile(r"^(\d{4})-(\d{2})-(\d{2})[ T]"
                       r"(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?"
                       r"(Z|[+-]\d{2}:?\d{2}|[+-]\d{2}|[+-]\d{4})?$")


def _parse_offset(text):
    if text is None:
        return None
    if text == "Z":
        return _datetime.timezone.utc
    sign = 1 if text[0:1] == "+" else -1
    digits = text[1:].replace(":", "")
    if len(digits) == 2:
        hours, minutes = int(digits), 0
    elif len(digits) == 4:
        hours, minutes = int(digits[0:2]), int(digits[2:4])
    else:
        raise ValueError("Bad offset.")
    if hours > 23 or minutes > 59:
        raise ValueError("Offset out of range.")
    return _datetime.timezone(sign * _datetime.timedelta(hours=hours, minutes=minutes))


def _fraction_to_micros(digits):
    if digits is None:
        return 0
    return int((digits + "000000")[0:6])


def _decode_date(raw):
    if not isinstance(raw, str):
        raise _bad_value("DATE value must be a string.")
    match = _DATE_RE.match(raw)
    if match is None:
        raise _bad_value("Invalid DATE value: {0!r}.".format(raw))
    try:
        return _datetime.date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        raise _bad_value("DATE value out of range: {0!r}.".format(raw))


def _decode_time_parts(raw, pattern, what):
    if not isinstance(raw, str):
        raise _bad_value("{0} value must be a string.".format(what))
    match = pattern.match(raw)
    if match is None:
        raise _bad_value("Invalid {0} value: {1!r}.".format(what, raw))
    return match


def _build_time(match, raw, what, with_zone):
    hour, minute = int(match.group(1)), int(match.group(2))
    second = int(match.group(3)) if match.group(3) is not None else 0
    micros = _fraction_to_micros(match.group(4))
    zone_text = match.group(5)
    if with_zone and zone_text is None:
        raise _bad_value("{0} value misses an offset: {1!r}.".format(what, raw))
    if not with_zone and zone_text is not None:
        raise _bad_value("{0} value must not have an offset: {1!r}.".format(what, raw))
    try:
        zone = _parse_offset(zone_text)
    except ValueError:
        raise _bad_value("Invalid {0} offset: {1!r}.".format(what, raw))
    try:
        return _datetime.time(hour, minute, second, micros, zone)
    except ValueError:
        raise _bad_value("{0} value out of range: {1!r}.".format(what, raw))


def _decode_time(raw, with_zone):
    match = _decode_time_parts(raw, _TIME_RE, "TIME")
    return _build_time(match, raw, "TIME", with_zone)


def _decode_timestamp(raw, with_zone):
    match = _decode_time_parts(raw, _STAMP_RE, "TIMESTAMP")
    try:
        day = _datetime.date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        raise _bad_value("TIMESTAMP value out of range: {0!r}.".format(raw))
    hour, minute = int(match.group(4)), int(match.group(5))
    second = int(match.group(6)) if match.group(6) is not None else 0
    micros = _fraction_to_micros(match.group(7))
    zone_text = match.group(8)
    if with_zone and zone_text is None:
        raise _bad_value("TIMESTAMP value misses an offset: {0!r}.".format(raw))
    if not with_zone and zone_text is not None:
        raise _bad_value("TIMESTAMP value must not have an offset: {0!r}.".format(raw))
    try:
        zone = _parse_offset(zone_text)
    except ValueError:
        raise _bad_value("Invalid TIMESTAMP offset: {0!r}.".format(raw))
    try:
        return _datetime.datetime(day.year, day.month, day.day, hour, minute, second,
                                  micros, zone)
    except ValueError:
        raise _bad_value("TIMESTAMP value out of range: {0!r}.".format(raw))


_DAYTIME_ORDER = ("DAY", "HOUR", "MINUTE", "SECOND")
_TRAILING_LIMIT = {"MONTH": 11, "HOUR": 23, "MINUTE": 59, "SECOND": 59}
_FIELD_MICROS = {"DAY": 86400000000, "HOUR": 3600000000, "MINUTE": 60000000, "SECOND": 1000000}


def _fields_between(start, end):
    order = ("YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND")
    try:
        return order[order.index(start):order.index(end) + 1]
    except ValueError:
        return []


def _decode_interval(raw, column):
    if not isinstance(raw, str):
        raise _bad_value("INTERVAL value must be a string.")
    start = column.get("startField")
    end = column.get("endField")
    if start in ("YEAR", "MONTH"):
        return _decode_interval_year_month(raw, start, end)
    if start is None or end is None:
        # 한정자를 모르면 day-time으로 읽되 실패하면 원문을 둔다.
        try:
            return _decode_interval_day_time(raw, "DAY", "SECOND")
        except errors.InterfaceError:
            return raw
    return _decode_interval_day_time(raw, start, end)


def _decode_interval_year_month(raw, start, end):
    text = raw.strip()
    negative = False
    if text[0:1] in ("+", "-"):
        negative = text[0:1] == "-"
        text = text[1:].strip()
    if start == end:
        if not _re.match(r"^\d+$", text):
            raise _bad_value("Invalid INTERVAL value: {0!r}.".format(raw))
        months = int(text) * (12 if start == "YEAR" else 1)
    else:
        match = _re.match(r"^(\d+)-(\d+)$", text)
        if match is None:
            raise _bad_value("Invalid INTERVAL value: {0!r}.".format(raw))
        if len(match.group(1)) > 18:
            raise _bad_value("INTERVAL value out of range: {0!r}.".format(raw))
        trailing = int(match.group(2))
        if trailing > 11:
            raise _bad_value("INTERVAL value out of range: {0!r}.".format(raw))
        months = int(match.group(1)) * 12 + trailing
    if negative:
        months = -months
    if start == "YEAR" and end == "YEAR":
        return "{0}{1}".format("-" if months < 0 else "", abs(months) // 12)
    if start == "MONTH" and end == "MONTH":
        return "{0}{1}".format("-" if months < 0 else "", abs(months))
    absolute = abs(months)
    text = "{0}-{1:02d}".format(absolute // 12, absolute % 12)
    return "-" + text if months < 0 else text


def _decode_interval_day_time(raw, start, end):
    fields = [name for name in _fields_between(start, end) if name in _DAYTIME_ORDER]
    if not fields:
        raise _bad_value("Invalid INTERVAL qualifier: {0!r}/{1!r}.".format(start, end))
    text = raw.strip()
    negative = False
    if text[0:1] in ("+", "-"):
        negative = text[0:1] == "-"
        text = text[1:].strip()
    pattern = "^"
    for index, name in enumerate(fields):
        if index > 0:
            pattern += r"\s+" if fields[index - 1] == "DAY" else ":"
        pattern += r"(\d+)"
        if name == "SECOND":
            pattern += r"(?:\.(\d{1,9}))?"
    pattern += "$"
    match = _re.match(pattern, text)
    if match is None:
        raise _bad_value("Invalid INTERVAL value: {0!r}.".format(raw))
    micros = 0
    groups = match.groups()
    for index, name in enumerate(fields):
        digits = groups[index]
        if len(digits) > 18 and index == 0:
            raise _bad_value("INTERVAL value out of range: {0!r}.".format(raw))
        value = int(digits)
        if index > 0 and value > _TRAILING_LIMIT[name]:
            raise _bad_value("INTERVAL value out of range: {0!r}.".format(raw))
        micros += value * _FIELD_MICROS[name]
    if fields[-1] == "SECOND" and groups[len(fields)]:
        micros += _fraction_to_micros(groups[len(fields)])
    if negative:
        micros = -micros
    try:
        return _datetime.timedelta(microseconds=micros)
    except OverflowError:
        raise _bad_value("INTERVAL value out of range: {0!r}.".format(raw))


def decode_value(raw, column):
    """서버 JSON 값을 컬럼 타입에 맞는 Python 값으로 바꾼다."""
    if raw is None:
        return None
    name = column.get("typeName")
    if name in ("CHAR", "VARCHAR"):
        if not isinstance(raw, str):
            raise _bad_value("Character value must be a string.")
        return raw
    if name in ("BINARY", "VARBINARY"):
        if not isinstance(raw, str):
            raise _bad_value("Binary value must be a hex string.")
        try:
            return _compat.unhexlify(raw)
        except (TypeError, ValueError):
            raise _bad_value("Invalid binary value.")
    if name in ("SMALLINT", "INTEGER"):
        if isinstance(raw, bool) or not isinstance(raw, int):
            raise _bad_value("Integer value must be a JSON number.")
        return raw
    if name == "BIGINT":
        if isinstance(raw, bool):
            raise _bad_value("BIGINT value must be a decimal string.")
        try:
            return int(raw)
        except (TypeError, ValueError):
            raise _bad_value("Invalid BIGINT value: {0!r}.".format(raw))
    if name == "DECIMAL":
        if isinstance(raw, bool) or not isinstance(raw, str):
            raise _bad_value("DECIMAL value must be a decimal string.")
        try:
            return _decimal.Decimal(raw)
        except _decimal.InvalidOperation:
            raise _bad_value("Invalid DECIMAL value: {0!r}.".format(raw))
    if name in ("REAL", "DOUBLE PRECISION"):
        if isinstance(raw, bool):
            raise _bad_value("Float value must be a JSON number.")
        if isinstance(raw, (int, float)):
            return float(raw)
        if isinstance(raw, str):
            try:
                return float(raw)
            except ValueError:
                raise _bad_value("Invalid float value: {0!r}.".format(raw))
        raise _bad_value("Float value must be a JSON number.")
    if name == "BOOLEAN":
        if not isinstance(raw, bool):
            raise _bad_value("Boolean value must be true or false.")
        return raw
    if name == "DATE":
        return _decode_date(raw)
    if name == "TIME":
        return _decode_time(raw, False)
    if name == "TIME WITH TIME ZONE":
        return _decode_time(raw, True)
    if name == "TIMESTAMP":
        return _decode_timestamp(raw, False)
    if name == "TIMESTAMP WITH TIME ZONE":
        return _decode_timestamp(raw, True)
    if name == "INTERVAL":
        return _decode_interval(raw, column)
    return raw


def _offset_minutes(value, index):
    try:
        offset = value.utcoffset()
    except ValueError:
        raise errors.DataError(
            "Parameter {0} has a non-minute offset.".format(index + 1), None, None, None)
    if offset is None:
        return None
    try:
        seconds = offset.total_seconds()
    except AttributeError:
        seconds = offset.days * 86400 + offset.seconds + offset.microseconds / 1000000.0
    if seconds % 60 != 0:
        raise errors.DataError(
            "Parameter {0} has a non-minute offset.".format(index + 1), None, None, None)
    return seconds


def encode_param(value, index):
    """Python 값을 서버 Param으로 바꾼다. 모르면 ProgrammingError, 값 오류는 DataError이다."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        if -(2 ** 53 - 1) <= value <= 2 ** 53 - 1:
            return value
        return str(value)
    if isinstance(value, float):
        if value != value or value == float("inf") or value == float("-inf"):
            raise errors.DataError(
                "Parameter {0} is not a finite number.".format(index + 1), None, None, None)
        return value
    if isinstance(value, str):
        return value
    if isinstance(value, _decimal.Decimal):
        if value.is_nan() or value.is_infinite():
            raise errors.DataError(
                "Parameter {0} is not a finite number.".format(index + 1), None, None, None)
        return format(value, "f")
    if isinstance(value, _datetime.datetime):
        _offset_minutes(value, index)
        return value.isoformat(sep=" ")
    if isinstance(value, _datetime.date):
        return value.isoformat()
    if isinstance(value, _datetime.time):
        _offset_minutes(value, index)
        return value.isoformat()
    if isinstance(value, _datetime.timedelta):
        return _format_timedelta(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"binary": _compat.hexlify(value)}
    raise errors.ProgrammingError(
        "Parameter {0} has an unsupported type.".format(index + 1), None, None, None)


def _format_timedelta(value):
    micros = (value.days * 86400 + value.seconds) * 1000000 + value.microseconds
    sign = ""
    if micros < 0:
        sign = "-"
        micros = -micros
    days, rest = divmod(micros, 86400000000)
    hours, rest = divmod(rest, 3600000000)
    minutes, rest = divmod(rest, 60000000)
    seconds, micros = divmod(rest, 1000000)
    if micros:
        return "{0}{1} {2:02d}:{3:02d}:{4:02d}.{5:06d}".format(sign, days, hours, minutes,
                                                              seconds, micros)
    return "{0}{1} {2:02d}:{3:02d}:{4:02d}".format(sign, days, hours, minutes, seconds)
