package org.duckdns.hjow.helloworlddb.jdbc6;

import java.io.*;
import java.lang.reflect.*;
import java.math.*;
import java.sql.*;
import java.util.*;
import org.duckdns.hjow.helloworlddb.jdbc6.protocol.*;

/** Java 6으로 컴파일한 같은 시험 클래스를 모든 지원 런타임에서 실행한다. */
public final class JdbcTest {
    private static int passed;
    private JdbcTest() { }
    private static void ok(boolean condition) { if (!condition) throw new AssertionError(); }
    private static void eq(Object expected, Object actual) {
        if (expected instanceof byte[] && actual instanceof byte[]) { ok(Arrays.equals((byte[]) expected, (byte[]) actual)); return; }
        if (expected == null ? actual != null : !expected.equals(actual)) throw new AssertionError("expected=" + expected + " actual=" + actual);
    }
    private static void pass(String name) { passed++; System.out.println("PASS " + name); }
    private static Properties options(String mode, String ca) {
        Properties p = new Properties(); p.setProperty("user", "SYSTEM"); p.setProperty("password", "HelloWorldDB"); p.setProperty("fetchSize", "3");
        if (mode.equals("udp")) p.setProperty("transport", "udp");
        if (mode.startsWith("tls")) { p.setProperty("ssl", "true"); if (ca.length() > 0) p.setProperty("sslCa", ca); } return p;
    }
    public static void main(String[] args) throws Exception {
        if (args[0].equals("unit")) unit();
        else if (args[0].equals("tls-reject")) reject(args[1], args[2]);
        else integration(args[1], args[2], args.length > 3 ? args[3] : "");
        System.out.println("PASSED " + passed);
    }
    private static void unit() throws Exception {
        eq("org.duckdns.hjow.helloworlddb.jdbc6.Driver", DriverManager.getDriver("jdbc:helloworlddb://localhost").getClass().getName());
        eq(null, new Driver().connect("jdbc:other://localhost", new Properties())); pass("JDBC 4.0 자동 등록·다른 URL 거부");
        Map<String, Object> value = Json.object("한글😀", Arrays.<Object>asList("", null, Boolean.TRUE, Long.valueOf(123), new BigDecimal("0.000000000000000001")));
        eq(value, Json.decode(Json.encode(value)));
        for (String bad : Arrays.asList("[1,]", "{\"a\":1,\"a\":2}", "\"\\uD800\"", "\"\\u+123\"", "01")) {
            try { Json.decode(bad.getBytes("UTF-8")); throw new AssertionError(); } catch (IOException expected) { }
        }
        try { Json.decode(new byte[] { (byte) 0xff }); throw new AssertionError(); } catch (IOException expected) { }
        pass("공통 JSON·UTF-8·숫자 정밀도·서러게이트 검증");
        eq("120FB6CFFCF8B32C43E7225256C4F837A86548C92CCC35480805987CB70BE17B", Values.hex(Scram.pbkdf2("password".getBytes("UTF-8"), "salt".getBytes("UTF-8"), 1)));
        for (int i = 0; i < 100; i++) { byte[] b = new byte[i]; new Random(i).nextBytes(b); eq(b, Scram.unbase64(Scram.base64(b))); } pass("Java 6 PBKDF2·base64 계산");
        eq(Long.valueOf(Long.MAX_VALUE), Values.decode("9223372036854775807", Types.BIGINT));
        eq(new BigDecimal("99999999999999999999999999999.123456789"), Values.decode("99999999999999999999999999999.123456789", Types.DECIMAL));
        try { Values.convert("2147483648", Integer.class); throw new AssertionError(); } catch (SQLException e) { eq("22003", e.getSQLState()); }
        try { Values.convert("2026-02-30", java.sql.Date.class); throw new AssertionError(); } catch (SQLException e) { eq("22018", e.getSQLState()); }
        int markers = 0; for (String token : JdbcStatement.tokens("SELECT '?', \"?\", ? /* ? */ -- ?\n, ?")) if (token.equals("?")) markers++;
        eq(Integer.valueOf(2), Integer.valueOf(markers)); pass("타입 범위·날짜 검증·SQL 파라미터 위치");
        final boolean[] closed = { false };
        Protocol protocol = new Protocol(new Transport() {
            public void send(byte[] b) { }
            public byte[] receive(int timeout) throws IOException { return Json.encode(Json.object("id", 0, "type", "error", "sqlState", "57P01", "code", 6003, "message", "Server shutting down.")); }
            public void setLimit(int limit) { }
            public void close() { closed[0] = true; }
        }, 100);
        try { protocol.ping(); throw new AssertionError(); } catch (SQLException e) { eq("57P01", e.getSQLState()); eq(Integer.valueOf(6003), Integer.valueOf(e.getErrorCode())); }
        ok(closed[0]); pass("서버 발신 오류 보존·연결 종료");
    }
    private static void reject(String url, String ca) throws Exception {
        try { DriverManager.getConnection(url, options("tls", "")); throw new AssertionError(); } catch (SQLException e) { eq("08001", e.getSQLState()); eq(Integer.valueOf(8007), Integer.valueOf(e.getErrorCode())); } pass("기본 TLS 신뢰 검증 실패");
        try { DriverManager.getConnection(url, options("tls", ca)); throw new AssertionError(); } catch (SQLException e) { eq("08001", e.getSQLState()); } pass("TLS 인증서 호스트 이름 불일치 거부");
        Properties p = options("tls", ""); p.setProperty("sslVerify", "false"); Connection c = DriverManager.getConnection(url, p);
        try { ok(c.isValid(2)); } finally { c.close(); } pass("명시적 TLS 검증 끄기");
    }
    private static void integration(String url, String mode, String ca) throws Exception {
        Properties props = options(mode, ca); Connection c = DriverManager.getConnection(url, props);
        String space = "J6_" + System.getProperty("java.specification.version").replace(".", "") + mode.toUpperCase(Locale.US) + System.getProperty("hwdb.test.suffix", "");
        try {
            Statement setup = c.createStatement(); try { setup.execute("CREATE TABLESPACE " + space); setup.execute("USE " + space); setup.execute("CREATE TABLE Q (ID INTEGER PRIMARY KEY, V VARCHAR, N NUMERIC(38,9), TS TIMESTAMP(6))"); } finally { setup.close(); }
            ok(c.isValid(2)); ok(c.getAutoCommit()); eq(c, c.unwrap(Connection.class)); ok(c.isWrapperFor(Connection.class)); eq(Integer.valueOf(4), Integer.valueOf(c.getMetaData().getJDBCMajorVersion())); eq(Integer.valueOf(0), Integer.valueOf(c.getMetaData().getJDBCMinorVersion())); pass("JDBC 버전 4.0·래퍼·세션·isValid");
            PreparedStatement p = c.prepareStatement("INSERT INTO Q VALUES (?,?,?,?)");
            try {
                eq(Integer.valueOf(4), Integer.valueOf(p.getParameterMetaData().getParameterCount()));
                try { p.executeUpdate(); throw new AssertionError(); } catch (SQLException e) { eq("07001", e.getSQLState()); }
                p.setInt(1, 1); p.setNString(2, "안녕😀"); p.setBigDecimal(3, new BigDecimal("99999999999999999999999999999.123456789")); p.setTimestamp(4, Timestamp.valueOf("2026-10-20 12:34:56.123456")); eq(Integer.valueOf(1), Integer.valueOf(p.executeUpdate()));
            } finally { p.close(); }
            Statement s = c.createStatement();
            try {
                ResultSet r = s.executeQuery("SELECT * FROM Q"); try { ok(r.next()); eq("안녕😀", r.getString("v")); eq(new BigDecimal("99999999999999999999999999999.123456789"), r.getBigDecimal(3)); eq(Integer.valueOf(123456000), Integer.valueOf(r.getTimestamp(4).getNanos())); eq(Integer.valueOf(65535), Integer.valueOf(r.getMetaData().getPrecision(2))); eq(Integer.valueOf(38), Integer.valueOf(r.getMetaData().getPrecision(3))); } finally { r.close(); }
            } finally { s.close(); } pass("파라미터·메타데이터·고정소수·마이크로초 왕복");
            types(c); pass("모든 DB 타입·오프셋·SQL 날짜시간·NULL 왕복");
            StringBuilder large = new StringBuilder(); for (int i = 0; i < 20000; i++) large.append('한');
            p = c.prepareStatement("INSERT INTO Q VALUES (?,?,?,?)"); try {
                for (int i = 2; i <= 40; i++) { p.setInt(1, i); p.setString(2, i == 2 ? large.toString() : "row" + i); p.setNull(3, Types.DECIMAL); p.setNull(4, Types.TIMESTAMP); p.addBatch(); }
                int[] counts = p.executeBatch(); eq(Integer.valueOf(39), Integer.valueOf(counts.length)); for (int count : counts) eq(Integer.valueOf(1), Integer.valueOf(count));
            } finally { p.close(); }
            s = c.createStatement(); try {
                s.setFetchSize(1); ResultSet r = s.executeQuery("SELECT ID,V FROM Q ORDER BY ID"); try { int count = 0; while (r.next()) { count++; eq(Integer.valueOf(count), Integer.valueOf(r.getInt(1))); if (count == 2) eq(large.toString(), r.getString(2)); } eq(Integer.valueOf(40), Integer.valueOf(count)); } finally { r.close(); }
                s.setMaxRows(5); r = s.executeQuery("SELECT * FROM Q"); try { int count = 0; while (r.next()) count++; eq(Integer.valueOf(5), Integer.valueOf(count)); } finally { r.close(); }
                s.setMaxRows(0); for (int i = 0; i < 20; i++) { r = s.executeQuery("SELECT * FROM Q"); r.close(); }
            } finally { s.close(); } pass("배치·fetch·대형 UTF-8·커서 자원 정리");
            transactions(c); pass("커밋·롤백·세이브포인트·홀더블 결과");
            metadata(c, space); pass("스키마·테이블·컬럼·PK·FK·인덱스 메타데이터");
            s = c.createStatement(); try {
                try { s.execute("INSERT INTO Q (ID) VALUES (1)"); throw new AssertionError(); } catch (SQLException e) { eq("23505", e.getSQLState()); ok(e.getErrorCode() > 0); }
                s.addBatch("INSERT INTO Q (ID) VALUES (101)"); s.addBatch("INSERT INTO Q (ID) VALUES (1)");
                try { s.executeBatch(); throw new AssertionError(); } catch (BatchUpdateException e) { eq(Integer.valueOf(1), Integer.valueOf(e.getUpdateCounts().length)); eq("23505", e.getSQLState()); }
                try { c.createBlob(); throw new AssertionError(); } catch (SQLFeatureNotSupportedException e) { eq("0A000", e.getSQLState()); }
                try { c.prepareCall("CALL X()"); throw new AssertionError(); } catch (SQLFeatureNotSupportedException e) { eq("0A000", e.getSQLState()); }
                ResultSet r = s.executeQuery("SELECT CAST(NULL AS INTEGER) AS N, '' AS EMPTY"); try { ok(r.next()); eq(Integer.valueOf(0), Integer.valueOf(r.getInt("N"))); ok(r.wasNull()); eq("", r.getString(2)); ok(!r.wasNull()); try { r.previous(); throw new AssertionError(); } catch (SQLFeatureNotSupportedException e) { eq("0A000", e.getSQLState()); } } finally { r.close(); }
                ok(c.isValid(2));
            } finally { s.close(); } pass("서버 오류·배치 부분 실패·미지원 기능·NULL");
            privileges(c, url, props, space); pass("기본 테이블스페이스 없음·뷰 권한·메타데이터 가시성");
            calendar(c); pass("Calendar·스트림·정밀도 명시 setObject");
            modern(c, space); pass("상위 런타임 JDBC 메서드 호환 처리");
            if (mode.equals("udp")) { Thread.sleep(1400); ok(c.isValid(2)); pass("UDP 유휴 ping으로 세션 유지"); }
        } finally { c.close(); }
        ok(c.isClosed());
    }
    private static void types(Connection c) throws Exception {
        Statement s = c.createStatement(); try { s.execute("CREATE TABLE TYPES_TEST (C CHAR(4), V VARCHAR(10), B BINARY(3), VB VARBINARY(8), SI SMALLINT, I INTEGER, BI BIGINT, N NUMERIC(38,9), R REAL, D DOUBLE PRECISION, BO BOOLEAN, DT DATE, TM TIME(6), TS TIMESTAMP(6), TZ TIME(6) WITH TIME ZONE, TSZ TIMESTAMP(6) WITH TIME ZONE, IV INTERVAL DAY TO SECOND(6))"); } finally { s.close(); }
        Object[] values = { "한😀", "", new byte[] { 0, (byte) 255 }, new byte[] { 0, 17, (byte) 255 }, Integer.valueOf(-32768), Integer.valueOf(Integer.MAX_VALUE), Long.valueOf(Long.MAX_VALUE), new BigDecimal("99999999999999999999999999999.123456789"), Float.valueOf(1.25f), Double.valueOf(2.125d), Boolean.TRUE,
            java.sql.Date.valueOf("2026-10-20"), "12:34:56.123456", Timestamp.valueOf("2026-10-20 12:34:56.123456"), "12:34:56.123456+09:00", "2026-10-20 12:34:56.123456-03:30", "3 04:05:06.123456" };
        PreparedStatement p = c.prepareStatement("INSERT INTO TYPES_TEST VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"); try { for (int i = 0; i < values.length; i++) p.setObject(i + 1, values[i]); p.executeUpdate(); } finally { p.close(); }
        s = c.createStatement(); try { ResultSet r = s.executeQuery("SELECT * FROM TYPES_TEST"); try {
            ok(r.next()); eq("한😀  ", r.getString(1)); eq("", r.getObject(2)); eq(new byte[] { 0, (byte) 255, 0 }, r.getBytes(3));
            for (int i = 3; i <= 11; i++) eq(values[i], r.getObject(i + 1));
            eq(Time.valueOf("12:34:56"), r.getTime(13)); eq(values[13], r.getObject(14)); eq(values[14], r.getString(15)); eq(values[15], r.getString(16)); eq(values[16], r.getObject(17));
            eq(Integer.valueOf(Types.TIME), Integer.valueOf(r.getMetaData().getColumnType(15))); eq(Integer.valueOf(Types.TIMESTAMP), Integer.valueOf(r.getMetaData().getColumnType(16)));
            eq("TIME WITH TIME ZONE", r.getMetaData().getColumnTypeName(15)); eq(Integer.valueOf(123456000), Integer.valueOf(r.getTimestamp(16).getNanos()));
            Calendar utc = Calendar.getInstance(TimeZone.getTimeZone("UTC")); utc.clear(); utc.set(2026, 9, 20, 16, 4, 56); utc.set(Calendar.MILLISECOND, 123); eq(Long.valueOf(utc.getTimeInMillis()), Long.valueOf(r.getTimestamp(16).getTime()));
        } finally { r.close(); } } finally { s.close(); }
    }
    private static void transactions(Connection c) throws Exception {
        c.setAutoCommit(false); Statement s = c.createStatement();
        try {
            s.execute("UPDATE Q SET V='committed' WHERE ID=1"); c.commit(); s.execute("UPDATE Q SET V='before' WHERE ID=1"); Savepoint p = c.setSavepoint(); s.execute("UPDATE Q SET V='after' WHERE ID=1"); c.rollback(p); c.releaseSavepoint(p);
            ResultSet r = s.executeQuery("SELECT V FROM Q WHERE ID=1"); try { ok(r.next()); eq("before", r.getString(1)); } finally { r.close(); }
            c.rollback(); try { c.rollback(p); throw new AssertionError(); } catch (SQLException e) { eq("3B001", e.getSQLState()); }
            p = c.setSavepoint("한글\"point"); eq("한글\"point", p.getSavepointName()); c.releaseSavepoint(p);
            r = s.executeQuery("SELECT ID FROM Q ORDER BY ID"); try { ok(r.next()); c.commit(); int count = 1; while (r.next()) count++; eq(Integer.valueOf(40), Integer.valueOf(count)); } finally { r.close(); }
        } finally { s.close(); c.rollback(); c.setAutoCommit(true); }
    }
    private static void metadata(Connection c, String space) throws Exception {
        Statement s = c.createStatement(); try { s.execute("CREATE TABLE CHILD (ID INTEGER PRIMARY KEY, P INTEGER REFERENCES Q (ID) ON DELETE CASCADE)"); s.execute("CREATE INDEX IX_CHILD ON CHILD (P DESC)"); s.execute("CREATE TABLE \"A_%\" (N NUMERIC(12), V NVARCHAR(25))"); } finally { s.close(); }
        DatabaseMetaData m = c.getMetaData(); ResultSet r = m.getSchemas(); try { boolean found = false; while (r.next()) if (space.equals(r.getString("TABLE_SCHEM"))) found = true; ok(found); } finally { r.close(); }
        r = m.getTables(null, space, "Q", new String[] { "TABLE" }); try { ok(r.next()); eq("Q", r.getString("TABLE_NAME")); ok(!r.next()); } finally { r.close(); }
        r = m.getColumns(null, space, "A\\_\\%", "%"); try { ok(r.next()); eq(Integer.valueOf(12), Integer.valueOf(r.getInt("COLUMN_SIZE"))); eq(Integer.valueOf(0), Integer.valueOf(r.getInt("DECIMAL_DIGITS"))); ok(r.next()); eq(Integer.valueOf(25), Integer.valueOf(r.getInt("COLUMN_SIZE"))); } finally { r.close(); }
        r = m.getPrimaryKeys(null, space, "Q"); try { ok(r.next()); eq("ID", r.getString("COLUMN_NAME")); } finally { r.close(); }
        r = m.getImportedKeys(null, space, "CHILD"); try { ok(r.next()); eq("Q", r.getString("PKTABLE_NAME")); eq(Integer.valueOf(DatabaseMetaData.importedKeyCascade), Integer.valueOf(r.getInt("DELETE_RULE"))); } finally { r.close(); }
        r = m.getIndexInfo(null, space, "CHILD", false, false); try { int count = 0; while (r.next()) count++; eq(Integer.valueOf(2), Integer.valueOf(count)); } finally { r.close(); }
        r = m.getTypeInfo(); try { int count = 0; while (r.next()) count++; eq(Integer.valueOf(17), Integer.valueOf(count)); } finally { r.close(); }
    }
    private static void privileges(Connection c, String url, Properties props, String space) throws Exception {
        String user = space + "_U"; Statement s = c.createStatement(); try { s.execute("CREATE USER " + user + " IDENTIFIED BY 'test-password'"); s.execute("CREATE VIEW VW AS SELECT ID,V FROM Q"); s.execute("GRANT SELECT ON VW TO " + user); } finally { s.close(); }
        Properties limited = new Properties(); limited.putAll(props); limited.setProperty("user", user); limited.setProperty("password", "test-password"); Connection other = DriverManager.getConnection(url, limited);
        try {
            Statement query = other.createStatement(); try {
                ResultSet r = query.executeQuery("SELECT TABLESPACE_NAME FROM SYSTEM.SYS_SESSIONS WHERE USER_NAME = CURRENT_USER"); try { ok(r.next()); eq(null, r.getString(1)); } finally { r.close(); }
                try { query.executeQuery("SELECT * FROM " + space + ".Q"); throw new AssertionError(); } catch (SQLException e) { eq("42501", e.getSQLState()); }
                r = query.executeQuery("SELECT * FROM " + space + ".VW"); try { ok(r.next()); } finally { r.close(); }
            } finally { query.close(); }
            ResultSet r = other.getMetaData().getTables(null, space, "%", null); try { ok(r.next()); eq("VW", r.getString("TABLE_NAME")); ok(!r.next()); } finally { r.close(); }
            r = other.getMetaData().getColumns(null, space, "VW", "%"); try { ok(r.next()); eq("ID", r.getString("COLUMN_NAME")); ok(r.next()); eq("V", r.getString("COLUMN_NAME")); ok(!r.next()); } finally { r.close(); }
        } finally { other.close(); }
        s = c.createStatement(); try { s.execute("DROP USER " + user); } finally { s.close(); }
    }
    private static void calendar(Connection c) throws Exception {
        Calendar utc = Calendar.getInstance(TimeZone.getTimeZone("UTC")); utc.clear(); utc.set(2026, 9, 20, 12, 34, 56); Timestamp ts = new Timestamp(utc.getTimeInMillis()); ts.setNanos(123456000);
        PreparedStatement p = c.prepareStatement("UPDATE Q SET V=?,N=?,TS=? WHERE ID=1"); try { p.setCharacterStream(1, new StringReader("reader한글")); p.setObject(2, "12.3456", Types.DECIMAL, 2); p.setTimestamp(3, ts, utc); p.executeUpdate(); } finally { p.close(); }
        Statement s = c.createStatement(); try { ResultSet r = s.executeQuery("SELECT V,N,TS FROM Q WHERE ID=1"); try { ok(r.next()); eq("reader한글", r.getString(1)); eq(new BigDecimal("12.350000000"), r.getBigDecimal(2)); eq(ts, r.getTimestamp(3, utc)); } finally { r.close(); } } finally { s.close(); }
    }
    private static void modern(Connection c, String space) throws Exception {
        try { Method schema = Connection.class.getMethod("getSchema"); eq(space, schema.invoke(c)); } catch (NoSuchMethodException java6) { }
        Statement s = c.createStatement(); try {
            try { Statement.class.getMethod("closeOnCompletion").invoke(s); ResultSet r = s.executeQuery("SELECT 1"); r.close(); ok(s.isClosed()); } catch (NoSuchMethodException java6) { }
        } finally { s.close(); }
        try { Driver.class.getMethod("getParentLogger").invoke(new Driver()); } catch (InvocationTargetException e) { throw new AssertionError(e.getCause()); }
        eq(Integer.valueOf(0), Integer.valueOf(c.getMetaData().getJDBCMinorVersion()));
    }
}
