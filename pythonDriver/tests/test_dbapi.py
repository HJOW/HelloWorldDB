"""DB-API 2.0 계층을 검증한다. 규약은 단위로, 동작은 실제 rdbms로 본다.

관련 사양: PEP 249, AGENTS.md 상세 8과 10, 프로토콜 5절부터 11절.
구현 단계: PY-3.
"""

import datetime
import decimal
import threading
import unittest

import helloworlddb
from helloworlddb import errors


class ModuleTests(unittest.TestCase):
    def test_module_attributes(self):
        self.assertEqual(helloworlddb.apilevel, "2.0")
        self.assertEqual(helloworlddb.threadsafety, 2)
        self.assertEqual(helloworlddb.paramstyle, "qmark")

    def test_exceptions_present(self):
        for name in ("Error", "InterfaceError", "DatabaseError", "DataError",
                     "OperationalError", "IntegrityError", "InternalError",
                     "ProgrammingError", "NotSupportedError"):
            self.assertTrue(issubclass(getattr(helloworlddb, name), Exception), name)
        self.assertTrue(issubclass(helloworlddb.ProgrammingError, helloworlddb.DatabaseError))
        self.assertTrue(issubclass(helloworlddb.InterfaceError, helloworlddb.Error))

    def test_constructors_and_types(self):
        self.assertEqual(helloworlddb.Date(2026, 1, 2), datetime.date(2026, 1, 2))
        self.assertEqual(helloworlddb.Binary(b"a"), b"a")
        for name in ("STRING", "BINARY", "NUMBER", "DATETIME", "ROWID"):
            self.assertTrue(hasattr(helloworlddb, name), name)

    def test_error_mapping(self):
        error = errors.error_from_response("0A000", 1, "nope")
        self.assertTrue(isinstance(error, helloworlddb.NotSupportedError))
        error = errors.error_from_response("28000", 7000, "auth")
        self.assertTrue(isinstance(error, helloworlddb.OperationalError))
        self.assertEqual(error.sqlstate, "28000")
        self.assertEqual(error.code, 7000)


class ConnectValidationTests(unittest.TestCase):
    def test_missing_credentials(self):
        with self.assertRaises(helloworlddb.ProgrammingError):
            helloworlddb.connect()
        with self.assertRaises(helloworlddb.ProgrammingError):
            helloworlddb.connect(user="SYSTEM")
        with self.assertRaises(helloworlddb.ProgrammingError):
            helloworlddb.connect(user="", password="x")

    def test_unsupported_transports(self):
        with self.assertRaises(helloworlddb.NotSupportedError):
            helloworlddb.connect(user="a", password="b", udp=True)
        with self.assertRaises(helloworlddb.NotSupportedError):
            helloworlddb.connect(user="a", password="b", ssl=True)

    def test_bad_option_combinations(self):
        with self.assertRaises(helloworlddb.ProgrammingError):
            helloworlddb.connect(user="a", password="b", ssl_ca="ca.pem")
        with self.assertRaises(helloworlddb.ProgrammingError):
            helloworlddb.connect(user="a", password="b", ssl_verify=False)

    def test_bad_values(self):
        with self.assertRaises(helloworlddb.ProgrammingError):
            helloworlddb.connect(host="", user="a", password="b")
        with self.assertRaises(helloworlddb.ProgrammingError):
            helloworlddb.connect(port=0, user="a", password="b")
        with self.assertRaises(helloworlddb.ProgrammingError):
            helloworlddb.connect(user="a", password="b", fetch_size=0)

    def test_unreachable_is_operational(self):
        with self.assertRaises(helloworlddb.OperationalError) as context:
            helloworlddb.connect("127.0.0.1", 1, user="a", password="b",
                                 connect_timeout=2)
        self.assertEqual(context.exception.sqlstate, "08006")


class DbApiIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from tests.rdbms_instance import prerequisites
        prerequisites()

    def make_connection(self, instance, **options):
        options.setdefault("user", "SYSTEM")
        options.setdefault("password", "HelloWorldDB")
        return helloworlddb.connect("127.0.0.1", instance.port, **options)

    def test_hello_world(self):
        from tests.rdbms_instance import RdbmsInstance
        instance = RdbmsInstance()
        with instance:
            connection = self.make_connection(instance, autocommit=True)
            try:
                self.assertFalse(connection.autocommit is False)
                cursor = connection.cursor()
                try:
                    cursor.execute("SELECT 'Hello World'")
                    self.assertEqual(cursor.fetchall(), [["Hello World"]])
                    self.assertEqual(cursor.rowcount, -1)
                finally:
                    cursor.close()
            finally:
                connection.close()

    def test_autocommit_starts_off(self):
        from tests.rdbms_instance import RdbmsInstance
        instance = RdbmsInstance()
        with instance:
            first = self.make_connection(instance)
            second = self.make_connection(instance, autocommit=True)
            try:
                self.assertFalse(first.autocommit)
                self.assertTrue(second.autocommit)
                cursor = first.cursor()
                try:
                    cursor.execute("CREATE TABLE AC (ID INTEGER PRIMARY KEY)")
                    cursor.execute("INSERT INTO AC VALUES (1)")
                    other = second.cursor()
                    try:
                        other.execute("SELECT ID FROM AC ORDER BY ID")
                        self.assertEqual(other.fetchall(), [])
                    finally:
                        other.close()
                    first.commit()
                    third = second.cursor()
                    try:
                        third.execute("SELECT ID FROM AC ORDER BY ID")
                        self.assertEqual(third.fetchall(), [[1]])
                    finally:
                        third.close()
                finally:
                    cursor.close()
            finally:
                first.close()
                second.close()

    def test_rollback(self):
        from tests.rdbms_instance import RdbmsInstance
        instance = RdbmsInstance()
        with instance:
            connection = self.make_connection(instance)
            try:
                cursor = connection.cursor()
                try:
                    cursor.execute("CREATE TABLE RB (ID INTEGER PRIMARY KEY)")
                    connection.commit()
                    cursor.execute("INSERT INTO RB VALUES (7)")
                    connection.rollback()
                    cursor.execute("SELECT ID FROM RB")
                    self.assertEqual(cursor.fetchall(), [])
                finally:
                    cursor.close()
            finally:
                connection.close()

    def test_connection_context_manager(self):
        from tests.rdbms_instance import RdbmsInstance
        instance = RdbmsInstance()
        with instance:
            connection = self.make_connection(instance)
            try:
                with connection:
                    cursor = connection.cursor()
                    try:
                        cursor.execute("CREATE TABLE CTX (ID INTEGER PRIMARY KEY)")
                    finally:
                        cursor.close()
                cursor = connection.cursor()
                try:
                    cursor.execute("SELECT ID FROM CTX")
                    self.assertEqual(cursor.fetchall(), [])
                finally:
                    cursor.close()
                try:
                    with connection:
                        cursor = connection.cursor()
                        try:
                            cursor.execute("INSERT INTO CTX VALUES (1)")
                            raise RuntimeError("boom")
                        finally:
                            cursor.close()
                except RuntimeError:
                    pass
                cursor = connection.cursor()
                try:
                    cursor.execute("SELECT ID FROM CTX")
                    self.assertEqual(cursor.fetchall(), [])
                finally:
                    cursor.close()
            finally:
                connection.close()

    def test_cursor_fetch_and_iteration(self):
        from tests.rdbms_instance import RdbmsInstance
        instance = RdbmsInstance()
        with instance:
            connection = self.make_connection(instance, autocommit=True)
            try:
                cursor = connection.cursor()
                try:
                    cursor.execute("CREATE TABLE FT (ID INTEGER PRIMARY KEY)")
                    cursor.executemany("INSERT INTO FT VALUES (?)", [[1], [2], [3]])
                    cursor.execute("SELECT ID FROM FT ORDER BY ID")
                    cursor.arraysize = 2
                    self.assertEqual(cursor.fetchmany(), [[1], [2]])
                    self.assertEqual(cursor.fetchone(), [3])
                    self.assertEqual(cursor.fetchone(), None)
                    cursor.execute("SELECT ID FROM FT ORDER BY ID")
                    seen = [row for row in cursor]
                    self.assertEqual(seen, [[1], [2], [3]])
                    self.assertEqual(cursor.fetchall(), [])
                finally:
                    cursor.close()
            finally:
                connection.close()

    def test_description_and_rowcount(self):
        from tests.rdbms_instance import RdbmsInstance
        instance = RdbmsInstance()
        with instance:
            connection = self.make_connection(instance, autocommit=True)
            try:
                cursor = connection.cursor()
                try:
                    cursor.execute("CREATE TABLE DC (NAME VARCHAR(100), AMT DECIMAL(10,3))")
                    cursor.execute("INSERT INTO DC VALUES ('a', '1.50')")
                    self.assertEqual(cursor.rowcount, 1)
                    cursor.execute("SELECT NAME, AMT FROM DC")
                    self.assertEqual(cursor.rowcount, -1)
                    name_desc, amt_desc = cursor.description
                    self.assertEqual(len(name_desc), 7)
                    self.assertEqual(name_desc[0], "NAME")
                    self.assertTrue(name_desc[1] == helloworlddb.STRING)
                    self.assertTrue("VARCHAR" == name_desc[1])
                    self.assertEqual(name_desc[3], 100)
                    self.assertEqual(name_desc[6], None)
                    self.assertTrue(amt_desc[1] == helloworlddb.NUMBER)
                    self.assertEqual((amt_desc[4], amt_desc[5]), (10, 3))
                    self.assertEqual(cursor.fetchall(), [["a", decimal.Decimal("1.50")]])
                finally:
                    cursor.close()
            finally:
                connection.close()

    def test_executemany_rowcount(self):
        from tests.rdbms_instance import RdbmsInstance
        instance = RdbmsInstance()
        with instance:
            connection = self.make_connection(instance, autocommit=True)
            try:
                cursor = connection.cursor()
                try:
                    cursor.execute("CREATE TABLE EM (ID INTEGER PRIMARY KEY)")
                    cursor.executemany("INSERT INTO EM VALUES (?)", [[1], [2], [3]])
                    self.assertEqual(cursor.rowcount, 3)
                    cursor.executemany("INSERT INTO EM VALUES (?)", [])
                    self.assertEqual(cursor.rowcount, -1)
                finally:
                    cursor.close()
            finally:
                connection.close()

    def test_cursor_misc(self):
        from tests.rdbms_instance import RdbmsInstance
        instance = RdbmsInstance()
        with instance:
            connection = self.make_connection(instance, autocommit=True)
            try:
                cursor = connection.cursor()
                try:
                    self.assertEqual(cursor.setinputsizes(10), None)
                    self.assertEqual(cursor.setoutputsize(10), None)
                    self.assertEqual(cursor.nextset(), None)
                    with self.assertRaises(helloworlddb.NotSupportedError):
                        cursor.callproc("whatever")
                    with cursor:
                        cursor.execute("SELECT 1")
                    with self.assertRaises(helloworlddb.InterfaceError):
                        cursor.execute("SELECT 1")
                finally:
                    cursor.close()
            finally:
                connection.close()

    def test_errors(self):
        from tests.rdbms_instance import RdbmsInstance
        instance = RdbmsInstance()
        with instance:
            connection = self.make_connection(instance, autocommit=True)
            try:
                cursor = connection.cursor()
                try:
                    with self.assertRaises(helloworlddb.ProgrammingError) as context:
                        cursor.execute("SELECT * FROM NO_SUCH_TABLE_XYZ")
                    self.assertTrue(context.exception.sqlstate.startswith("42"))
                    with self.assertRaises(helloworlddb.ProgrammingError):
                        cursor.execute("SELECT ?", [1, 2])
                    with self.assertRaises(helloworlddb.ProgrammingError):
                        cursor.execute("SELECT 1", {"a": 1})
                    with self.assertRaises(helloworlddb.ProgrammingError):
                        cursor.execute("SELECT 1", "not-a-sequence")
                    with self.assertRaises(helloworlddb.DataError):
                        cursor.execute("SELECT 1 + ?", [1e16])
                    cursor.execute("SELECT 1")
                    self.assertEqual(cursor.fetchall(), [[1]])
                finally:
                    cursor.close()
            finally:
                connection.close()

    def test_closed_usage(self):
        from tests.rdbms_instance import RdbmsInstance
        instance = RdbmsInstance()
        with instance:
            connection = self.make_connection(instance, autocommit=True)
            cursor = connection.cursor()
            cursor.close()
            with self.assertRaises(helloworlddb.InterfaceError):
                cursor.execute("SELECT 1")
            with self.assertRaises(helloworlddb.InterfaceError):
                cursor.fetchone()
            connection.close()
            with self.assertRaises(helloworlddb.InterfaceError):
                connection.cursor()
            with self.assertRaises(helloworlddb.InterfaceError):
                connection.commit()

    def test_tablespace_option(self):
        from tests.rdbms_instance import RdbmsInstance
        instance = RdbmsInstance()
        with instance:
            connection = self.make_connection(instance, autocommit=True, tablespace="system")
            try:
                self.assertEqual(connection.tablespace, "SYSTEM")
                cursor = connection.cursor()
                try:
                    cursor.execute("SELECT 'Hello World'")
                    self.assertEqual(cursor.fetchall(), [["Hello World"]])
                finally:
                    cursor.close()
            finally:
                connection.close()

    def test_fetch_size_cursor(self):
        from tests.rdbms_instance import RdbmsInstance
        instance = RdbmsInstance()
        with instance:
            connection = self.make_connection(instance, autocommit=True, fetch_size=2)
            try:
                cursor = connection.cursor()
                try:
                    cursor.execute("CREATE TABLE PG (ID INTEGER PRIMARY KEY)")
                    cursor.executemany("INSERT INTO PG VALUES (?)",
                                       [[1], [2], [3], [4], [5]])
                    cursor.execute("SELECT ID FROM PG ORDER BY ID")
                    self.assertEqual(cursor.fetchall(), [[1], [2], [3], [4], [5]])
                finally:
                    cursor.close()
            finally:
                connection.close()

    def test_types_roundtrip(self):
        from tests.rdbms_instance import RdbmsInstance
        instance = RdbmsInstance()
        with instance:
            connection = self.make_connection(instance, autocommit=True)
            try:
                cursor = connection.cursor()
                try:
                    cursor.execute("CREATE TABLE TT (D DATE, T TIME, TS TIMESTAMP, "
                                   "TZ TIMESTAMP WITH TIME ZONE, B VARBINARY(10), "
                                   "N DECIMAL(10,3), G BOOLEAN, V VARCHAR, I BIGINT)")
                    day = datetime.date(2026, 10, 15)
                    moment = datetime.datetime(2026, 10, 15, 13, 5, 7, 250000)
                    zoned = datetime.datetime(2026, 10, 15, 13, 5, 7, tzinfo=datetime.timezone(
                        datetime.timedelta(hours=9)))
                    cursor.execute("INSERT INTO TT VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                                   [day, datetime.time(13, 5, 7), moment, zoned, b"\xab\x12",
                                    decimal.Decimal("1.50"), True, "", 5000000000])
                    cursor.execute("SELECT D, T, TS, TZ, B, N, G, V, I FROM TT")
                    row = cursor.fetchone()
                    self.assertEqual(row[0], day)
                    self.assertEqual(row[1], datetime.time(13, 5, 7))
                    self.assertEqual(row[2], moment)
                    self.assertEqual(row[3], zoned)
                    self.assertEqual(row[4], b"\xab\x12")
                    self.assertEqual(row[5], decimal.Decimal("1.50"))
                    self.assertEqual(row[6], True)
                    self.assertEqual(row[7], "")
                    self.assertEqual(row[8], 5000000000)
                    self.assertTrue(cursor.description[5][1] == helloworlddb.NUMBER)
                    self.assertTrue(cursor.description[3][1] == helloworlddb.DATETIME)
                finally:
                    cursor.close()
            finally:
                connection.close()

    def test_interval_roundtrip(self):
        from tests.rdbms_instance import RdbmsInstance
        instance = RdbmsInstance()
        with instance:
            connection = self.make_connection(instance, autocommit=True)
            try:
                cursor = connection.cursor()
                try:
                    cursor.execute("CREATE TABLE IV (A INTERVAL DAY TO SECOND, "
                                   "B INTERVAL YEAR TO MONTH)")
                    delta = datetime.timedelta(days=3, hours=4, minutes=5, seconds=6,
                                               microseconds=500000)
                    cursor.execute("INSERT INTO IV VALUES (?, ?)", [delta, "1-02"])
                    cursor.execute("SELECT A, B FROM IV")
                    row = cursor.fetchone()
                    self.assertEqual(row[0], delta)
                    self.assertEqual(row[1], "1-02")
                finally:
                    cursor.close()
            finally:
                connection.close()

    def test_shared_connection_threads(self):
        from tests.rdbms_instance import RdbmsInstance
        instance = RdbmsInstance()
        with instance:
            connection = self.make_connection(instance, autocommit=True)
            failures = []
            try:
                cursor = connection.cursor()
                try:
                    cursor.execute("CREATE TABLE TH (ID INTEGER PRIMARY KEY)")
                    cursor.executemany("INSERT INTO TH VALUES (?)", [[1], [2], [3]])
                finally:
                    cursor.close()

                def worker(_):
                    try:
                        cursor = connection.cursor()
                        try:
                            cursor.execute("SELECT ID FROM TH ORDER BY ID")
                            self.assertEqual(cursor.fetchall(), [[1], [2], [3]])
                        finally:
                            cursor.close()
                    except Exception as error:  # noqa: BLE001 (recorded below)
                        failures.append(error)

                threads = []
                for number in range(5):
                    thread = threading.Thread(target=worker, args=(number,))
                    thread.daemon = True
                    threads.append(thread)
                    thread.start()
                for thread in threads:
                    thread.join(10)
                self.assertEqual(failures, [])
            finally:
                connection.close()


if __name__ == "__main__":
    unittest.main()
