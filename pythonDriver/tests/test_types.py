"""DB-API 값 변환과 타입 객체, 생성자를 검증한다. 서버를 띄우지 않는다.

관련 사양: AGENTS.md 상세 1, 프로토콜 8절과 9절, rdbms/docs/data-types.md.
구현 단계: PY-3.
"""

import datetime
import decimal
import unittest

from helloworlddb import errors
from helloworlddb import types


def column(name, type_name, **extra):
    meta = {"name": name, "typeName": type_name, "declared": type_name}
    meta.update(extra)
    return meta


class ConstructorTests(unittest.TestCase):
    def test_date_time_timestamp(self):
        self.assertEqual(types.Date(2026, 10, 15), datetime.date(2026, 10, 15))
        self.assertEqual(types.Time(13, 5, 7), datetime.time(13, 5, 7))
        self.assertEqual(types.Timestamp(2026, 10, 15, 13, 5, 7),
                         datetime.datetime(2026, 10, 15, 13, 5, 7))

    def test_from_ticks(self):
        import time
        now = int(time.time())
        self.assertEqual(types.DateFromTicks(now), datetime.date.fromtimestamp(now))
        self.assertEqual(types.TimestampFromTicks(now), datetime.datetime.fromtimestamp(now))

    def test_binary(self):
        self.assertEqual(types.Binary(b"ab"), b"ab")
        self.assertEqual(types.Binary(bytearray(b"ab")), b"ab")
        self.assertEqual(types.Binary(memoryview(b"ab")), b"ab")
        self.assertEqual(types.Binary("ab"), b"ab")
        with self.assertRaises(TypeError):
            types.Binary(42)


class TypeObjectTests(unittest.TestCase):
    def test_comparison(self):
        self.assertTrue(types.STRING == "VARCHAR")
        self.assertTrue("VARCHAR" == types.STRING)
        self.assertTrue("CHAR" == types.STRING)
        self.assertFalse(types.STRING == "INTEGER")
        self.assertFalse("INTEGER" == types.STRING)
        self.assertTrue(types.STRING != "INTEGER")
        self.assertTrue(types.NUMBER == "BIGINT")
        self.assertTrue(types.NUMBER == "DECIMAL")
        self.assertTrue(types.DATETIME == "TIMESTAMP WITH TIME ZONE")
        self.assertTrue(types.BINARY == "VARBINARY")
        self.assertFalse(types.ROWID == "VARCHAR")
        self.assertTrue(types.STRING == types.STRING)
        self.assertFalse(types.STRING == types.NUMBER)
        self.assertFalse(types.STRING == 42)

    def test_exact_name_kept(self):
        self.assertEqual("TIMESTAMP WITH TIME ZONE", "TIMESTAMP WITH TIME ZONE")


class DecodeTests(unittest.TestCase):
    def test_null_and_passthrough(self):
        self.assertEqual(types.decode_value(None, column("A", "INTEGER")), None)
        self.assertEqual(types.decode_value("x", column("A", "UNKNOWN TYPE")), "x")

    def test_char_varchar(self):
        self.assertEqual(types.decode_value("ab  ", column("A", "CHAR")), "ab  ")
        self.assertEqual(types.decode_value("", column("A", "VARCHAR")), "")
        with self.assertRaises(errors.InterfaceError):
            types.decode_value(42, column("A", "VARCHAR"))

    def test_binary(self):
        self.assertEqual(types.decode_value("AB12", column("A", "VARBINARY")), b"\xab\x12")
        self.assertEqual(types.decode_value("ab12", column("A", "BINARY")), b"\xab\x12")
        with self.assertRaises(errors.InterfaceError):
            types.decode_value("ZZ", column("A", "BINARY"))
        with self.assertRaises(errors.InterfaceError):
            types.decode_value(42, column("A", "BINARY"))

    def test_integers(self):
        self.assertEqual(types.decode_value(42, column("A", "INTEGER")), 42)
        self.assertEqual(types.decode_value(-5, column("A", "SMALLINT")), -5)
        self.assertEqual(types.decode_value("5000000000", column("A", "BIGINT")), 5000000000)
        self.assertEqual(types.decode_value("-9223372036854775808", column("A", "BIGINT")),
                         -9223372036854775808)
        self.assertEqual(types.decode_value("9223372036854775807", column("A", "BIGINT")),
                         9223372036854775807)
        with self.assertRaises(errors.InterfaceError):
            types.decode_value(True, column("A", "INTEGER"))
        with self.assertRaises(errors.InterfaceError):
            types.decode_value(1.5, column("A", "INTEGER"))
        with self.assertRaises(errors.InterfaceError):
            types.decode_value("abc", column("A", "BIGINT"))

    def test_decimal_keeps_scale(self):
        value = types.decode_value("1.50", column("A", "DECIMAL"))
        self.assertTrue(isinstance(value, decimal.Decimal))
        self.assertEqual(value, decimal.Decimal("1.50"))
        self.assertEqual(str(value), "1.50")
        with self.assertRaises(errors.InterfaceError):
            types.decode_value(1.5, column("A", "DECIMAL"))

    def test_float_and_boolean(self):
        self.assertEqual(types.decode_value(1.5, column("A", "DOUBLE PRECISION")), 1.5)
        self.assertEqual(types.decode_value(True, column("A", "BOOLEAN")), True)
        with self.assertRaises(errors.InterfaceError):
            types.decode_value(1, column("A", "BOOLEAN"))
        with self.assertRaises(errors.InterfaceError):
            types.decode_value(True, column("A", "REAL"))

    def test_date_bounds(self):
        self.assertEqual(types.decode_value("0001-01-01", column("A", "DATE")),
                         datetime.date(1, 1, 1))
        self.assertEqual(types.decode_value("9999-12-31", column("A", "DATE")),
                         datetime.date(9999, 12, 31))
        with self.assertRaises(errors.InterfaceError):
            types.decode_value("2026-13-01", column("A", "DATE"))
        with self.assertRaises(errors.InterfaceError):
            types.decode_value("15/10/2026", column("A", "DATE"))

    def test_time(self):
        self.assertEqual(types.decode_value("13:05:07", column("A", "TIME")),
                         datetime.time(13, 5, 7))
        self.assertEqual(types.decode_value("13:05:07.25", column("A", "TIME")),
                         datetime.time(13, 5, 7, 250000))
        zoned = types.decode_value("13:05:07+09:00", column("A", "TIME WITH TIME ZONE"))
        self.assertEqual(zoned.utcoffset(), datetime.timedelta(hours=9))
        self.assertEqual((zoned.hour, zoned.minute, zoned.second), (13, 5, 7))
        with self.assertRaises(errors.InterfaceError):
            types.decode_value("13:05:07+09:00", column("A", "TIME"))
        with self.assertRaises(errors.InterfaceError):
            types.decode_value("13:05:07", column("A", "TIME WITH TIME ZONE"))
        with self.assertRaises(errors.InterfaceError):
            types.decode_value("25:00:00", column("A", "TIME"))

    def test_timestamp(self):
        value = types.decode_value("2026-10-15 13:05:07.25", column("A", "TIMESTAMP"))
        self.assertEqual(value, datetime.datetime(2026, 10, 15, 13, 5, 7, 250000))
        self.assertEqual(value.tzinfo, None)
        zoned = types.decode_value("2026-10-15T13:05:07Z",
                                   column("A", "TIMESTAMP WITH TIME ZONE"))
        self.assertEqual(zoned.utcoffset(), datetime.timedelta(0))
        zoned2 = types.decode_value("2026-10-15 13:05:07.123456+0900",
                                    column("A", "TIMESTAMP WITH TIME ZONE"))
        self.assertEqual(zoned2.utcoffset(), datetime.timedelta(hours=9))
        self.assertEqual(zoned2.microsecond, 123456)
        with self.assertRaises(errors.InterfaceError):
            types.decode_value("2026-10-15", column("A", "TIMESTAMP"))

    def test_interval_day_time(self):
        meta = column("A", "INTERVAL", startField="DAY", endField="SECOND")
        self.assertEqual(types.decode_value("3 04:05:06.500000", meta),
                         datetime.timedelta(days=3, hours=4, minutes=5, seconds=6,
                                            microseconds=500000))
        self.assertEqual(types.decode_value("-3 04:05:06.500000", meta),
                         -datetime.timedelta(days=3, hours=4, minutes=5, seconds=6,
                                             microseconds=500000))
        hour_only = column("A", "INTERVAL", startField="HOUR", endField="MINUTE")
        self.assertEqual(types.decode_value("04:05", hour_only),
                         datetime.timedelta(hours=4, minutes=5))
        day_only = column("A", "INTERVAL", startField="DAY", endField="DAY")
        self.assertEqual(types.decode_value("17", day_only), datetime.timedelta(days=17))
        with self.assertRaises(errors.InterfaceError):
            types.decode_value("04:99", hour_only)
        with self.assertRaises(errors.InterfaceError):
            types.decode_value("abc", meta)

    def test_interval_year_month_stays_string(self):
        meta = column("A", "INTERVAL", startField="YEAR", endField="MONTH")
        self.assertEqual(types.decode_value("1-02", meta), "1-02")
        self.assertEqual(types.decode_value("-3", column("A", "INTERVAL", startField="YEAR",
                                                         endField="YEAR")), "-3")
        with self.assertRaises(errors.InterfaceError):
            types.decode_value("1-13", meta)


class EncodeTests(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(types.encode_param(None, 0), None)
        self.assertEqual(types.encode_param(True, 0), True)
        self.assertEqual(types.encode_param(42, 0), 42)
        big = 2 ** 53
        self.assertEqual(types.encode_param(big, 0), str(big))
        self.assertEqual(types.encode_param("text", 0), "text")
        self.assertEqual(types.encode_param(1.5, 0), 1.5)
        self.assertEqual(types.encode_param(b"\xab\x12", 0), {"binary": "AB12"})
        with self.assertRaises(errors.ProgrammingError):
            types.encode_param(object(), 0)
        with self.assertRaises(errors.ProgrammingError):
            types.encode_param({"binary": "AB"}, 0)

    def test_rejects_non_finite(self):
        with self.assertRaises(errors.DataError):
            types.encode_param(float("inf"), 0)
        with self.assertRaises(errors.DataError):
            types.encode_param(float("nan"), 0)
        with self.assertRaises(errors.DataError):
            types.encode_param(decimal.Decimal("NaN"), 0)
        with self.assertRaises(errors.DataError):
            types.encode_param(decimal.Decimal("Infinity"), 0)

    def test_decimal_keeps_plain_form(self):
        self.assertEqual(types.encode_param(decimal.Decimal("1.50"), 0), "1.50")
        self.assertEqual(types.encode_param(decimal.Decimal("1E+3"), 0), "1000")

    def test_dates(self):
        self.assertEqual(types.encode_param(datetime.date(2026, 10, 15), 0), "2026-10-15")
        self.assertEqual(types.encode_param(datetime.time(13, 5, 7), 0), "13:05:07")
        self.assertEqual(types.encode_param(datetime.datetime(2026, 10, 15, 13, 5, 7, 250000),
                                            0), "2026-10-15 13:05:07.250000")
        zoned = datetime.datetime(2026, 10, 15, 13, 5, 7,
                                  tzinfo=datetime.timezone(datetime.timedelta(hours=9)))
        self.assertEqual(types.encode_param(zoned, 0), "2026-10-15 13:05:07+09:00")
        self.assertTrue(isinstance(types.encode_param(datetime.date(2026, 1, 1), 0), str))

    def test_datetime_before_date(self):
        value = datetime.datetime(2026, 10, 15)
        self.assertIn(" ", types.encode_param(value, 0))

    def test_bad_offset(self):
        class HalfZone(datetime.tzinfo):
            def utcoffset(self, _):
                return datetime.timedelta(seconds=90)

        with self.assertRaises(errors.DataError):
            types.encode_param(datetime.time(1, 2, tzinfo=HalfZone()), 0)

    def test_timedelta(self):
        value = datetime.timedelta(days=3, hours=4, minutes=5, seconds=6,
                                   microseconds=500000)
        self.assertEqual(types.encode_param(value, 0), "3 04:05:06.500000")
        self.assertEqual(types.encode_param(datetime.timedelta(0), 0), "0 00:00:00")
        self.assertEqual(types.encode_param(-datetime.timedelta(seconds=1), 0),
                         "-0 00:00:01")


if __name__ == "__main__":
    unittest.main()
