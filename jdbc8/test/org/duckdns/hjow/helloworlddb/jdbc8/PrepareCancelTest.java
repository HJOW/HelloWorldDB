package org.duckdns.hjow.helloworlddb.jdbc8;

import java.math.BigDecimal;
import java.sql.*;
import java.util.Properties;
import java.util.concurrent.*;

/** 실제 JDBC 4.2 API로 준비 문장·분석·취소·제한 시간과 연결 재사용을 검증한다. */
final class PrepareCancelTest {
    private PrepareCancelTest() { }
    private static void ok(boolean condition) { if (!condition) throw new AssertionError(); }
    private static void equal(Object expected, Object actual) {
        if (expected == null ? actual != null : !expected.equals(actual)) throw new AssertionError("expected=" + expected + " actual=" + actual);
    }
    private static void command(Connection c, String sql) throws SQLException {
        Statement s = c.createStatement(); try { s.execute(sql); } finally { s.close(); }
    }
    private static int scalar(Connection c, String sql) throws SQLException {
        Statement s = c.createStatement(); try { ResultSet r = s.executeQuery(sql); try { ok(r.next()); return r.getInt(1); } finally { r.close(); } } finally { s.close(); }
    }
    static int run(String url, String mode, String ca, boolean legacy) throws Exception {
        Properties props = new Properties(); props.setProperty("user", "SYSTEM"); props.setProperty("password", "HelloWorldDB");
        if (mode.equals("udp")) props.setProperty("transport", "udp");
        if (mode.equals("tls")) { props.setProperty("ssl", "true"); props.setProperty("sslCa", ca); }
        Connection c = DriverManager.getConnection(url, props);
        try {
            if (legacy) {
                PreparedStatement p = c.prepareStatement("SELECT CAST(? AS INTEGER)");
                try {
                    equal(Integer.valueOf(Types.OTHER), Integer.valueOf(p.getParameterMetaData().getParameterType(1)));
                    equal(null, p.getMetaData()); p.setString(1, "42");
                    ResultSet r = p.executeQuery(); try { ok(r.next()); equal(Integer.valueOf(42), Integer.valueOf(r.getInt(1))); } finally { r.close(); }
                    try { p.cancel(); throw new AssertionError(); } catch (SQLFeatureNotSupportedException e) { equal("0A000", e.getSQLState()); }
                    p.setQueryTimeout(1);
                    try { p.executeQuery(); throw new AssertionError(); } catch (SQLFeatureNotSupportedException e) { equal("0A000", e.getSQLState()); }
                    ok(c.isValid(2));
                } finally { p.close(); }
                System.out.println("PASS capabilities가 없는 서버의 기존 실행·미지원 진단"); return 1;
            }
            String space = "PC8_" + System.getProperty("java.specification.version").replace(".", "") + mode.toUpperCase(java.util.Locale.US) + System.getProperty("hwdb.test.suffix", "");
            command(c, "CREATE TABLESPACE " + space); command(c, "USE " + space);
            command(c, "CREATE TABLE T (N INTEGER PRIMARY KEY, V INTEGER)");
            StringBuilder seed = new StringBuilder("INSERT INTO T VALUES ");
            for (int i = 0; i < 120; i++) { if (i > 0) seed.append(','); seed.append('(').append(i).append(",0)"); }
            command(c, seed.toString());

            PreparedStatement p = c.prepareStatement("SELECT CAST(? AS DECIMAL(12,0)) AS N");
            try {
                ResultSetMetaData result = p.getMetaData(); ParameterMetaData params = p.getParameterMetaData();
                equal("N", result.getColumnName(1)); equal(Integer.valueOf(12), Integer.valueOf(result.getPrecision(1)));
                equal(Integer.valueOf(0), Integer.valueOf(result.getScale(1))); equal(Integer.valueOf(Types.DECIMAL), Integer.valueOf(params.getParameterType(1)));
                equal(Integer.valueOf(ResultSetMetaData.columnNullableUnknown), Integer.valueOf(result.isNullable(1)));
                for (int i = 0; i < 3; i++) { p.setBigDecimal(1, new BigDecimal("12345678901")); ResultSet r = p.executeQuery(); try { ok(r.next()); equal(new BigDecimal("12345678901"), r.getBigDecimal(1)); } finally { r.close(); } }
            } finally { p.close(); }
            p = c.prepareStatement("SELECT ? AS X");
            try {
                equal("UNKNOWN", p.getParameterMetaData().getParameterTypeName(1)); equal(Integer.valueOf(0), Integer.valueOf(p.getMetaData().getPrecision(1)));
                p.setInt(1, 42); equal(Integer.valueOf(Types.INTEGER), Integer.valueOf(p.getMetaData().getColumnType(1)));
                ResultSet r = p.executeQuery(); try { ok(r.next()); equal(Integer.valueOf(42), Integer.valueOf(r.getInt(1))); } finally { r.close(); }
                p.clearParameters(); equal("UNKNOWN", p.getMetaData().getColumnTypeName(1));
            } finally { p.close(); }
            System.out.println("PASS 실행 전 컬럼·파라미터·UNKNOWN·바인딩 힌트·반복 실행");

            int before = scalar(c, "SELECT COUNT(*) FROM T");
            c.setAutoCommit(false); command(c, "INSERT INTO T VALUES (-2, 88)");
            p = c.prepareStatement("INSERT INTO T VALUES (999, ?)"); try { equal(null, p.getMetaData()); } finally { p.close(); }
            p = c.prepareStatement("CREATE TABLE NEVER_CREATED (N INTEGER)"); try { equal(null, p.getMetaData()); } finally { p.close(); }
            equal(Integer.valueOf(before + 1), Integer.valueOf(scalar(c, "SELECT COUNT(*) FROM T"))); c.rollback();
            equal(Integer.valueOf(before), Integer.valueOf(scalar(c, "SELECT COUNT(*) FROM T"))); c.setAutoCommit(true);
            try { command(c, "SELECT * FROM NEVER_CREATED"); throw new AssertionError(); } catch (SQLException e) { equal("42P01", e.getSQLState()); }
            for (int i = 0; i < 70; i++) { p = c.prepareStatement("SELECT 1"); p.close(); }
            p = c.prepareStatement("SELECT * FROM T");
            try { command(c, "CREATE TABLE INVALIDATES (N INTEGER)"); try { p.getMetaData(); throw new AssertionError(); } catch (SQLException e) { equal("0A000", e.getSQLState()); } } finally { p.close(); }
            System.out.println("PASS DML·DDL 분석의 무부작용·수동 트랜잭션 보존·해제·DDL 무효화");

            String cpu = "SELECT A.N FROM T A CROSS JOIN T B CROSS JOIN T C CROSS JOIN T D ORDER BY A.N";
            p = c.prepareStatement(cpu);
            try { SQLException cancelled = cancel(c, p); equal("57014", cancelled.getSQLState()); ok(!(cancelled instanceof SQLTimeoutException)); ok(c.isValid(2)); p.cancel(); }
            finally { p.close(); }
            Statement timed = c.createStatement();
            try {
                timed.setQueryTimeout(1);
                try { timed.executeQuery(cpu); throw new AssertionError(); }
                catch (SQLTimeoutException e) { equal("57014", e.getSQLState()); equal(Integer.valueOf(8010), Integer.valueOf(e.getErrorCode())); }
                timed.setQueryTimeout(0); ResultSet r = timed.executeQuery("SELECT 1"); try { ok(r.next()); } finally { r.close(); }
            } finally { timed.close(); }
            final PreparedStatement closing = c.prepareStatement(cpu);
            final CountDownLatch closeStarted = new CountDownLatch(1);
            ExecutorService closeWorker = Executors.newSingleThreadExecutor();
            Future<SQLException> closeResult = closeWorker.submit(new Callable<SQLException>() { public SQLException call() {
                closeStarted.countDown();
                try { closing.execute(); return null; } catch (SQLException e) { return e; }
            } });
            try {
                ok(closeStarted.await(3, TimeUnit.SECONDS)); Thread.sleep(100); closing.close();
                SQLException error = closeResult.get(10, TimeUnit.SECONDS); ok(error != null); ok("57014".equals(error.getSQLState()) || "HY010".equals(error.getSQLState())); ok(c.isValid(2));
            } finally { closeResult.cancel(true); closeWorker.shutdownNow(); ok(closeWorker.awaitTermination(3, TimeUnit.SECONDS)); closing.close(); }
            System.out.println("PASS CPU 준비 질의의 다른 스레드 취소·질의 제한 시간·연결 재사용");

            Connection blocker = DriverManager.getConnection(url, props);
            try {
                command(blocker, "USE " + space); blocker.setAutoCommit(false); command(blocker, "UPDATE T SET V=9 WHERE N=0");
                c.setAutoCommit(false); command(c, "INSERT INTO T VALUES (-1,77)");
                p = c.prepareStatement("UPDATE T SET V=1 WHERE N=0");
                try { equal("57014", cancel(c, p).getSQLState()); } finally { p.close(); }
                equal(Integer.valueOf(77), Integer.valueOf(scalar(c, "SELECT V FROM T WHERE N=-1"))); c.commit(); blocker.rollback(); c.setAutoCommit(true);
                equal(Integer.valueOf(77), Integer.valueOf(scalar(c, "SELECT V FROM T WHERE N=-1")));
            } finally { blocker.close(); }
            System.out.println("PASS 잠금 대기 취소는 연결·앞선 수동 트랜잭션 변경을 보존");
            jdbc42(c);
            return 6;
        } finally { c.close(); }
    }
    /** 미정 자리의 Java 8 타입 힌트와 정확한 시간·숫자 왕복을 검증한다. */
    private static void jdbc42(Connection c) throws Exception {
        Object[] values = {
            java.time.LocalDate.parse("2026-10-20"),
            java.time.LocalTime.parse("12:34:56.123456"),
            java.time.LocalDateTime.parse("2026-10-20T12:34:56.123456"),
            java.time.OffsetTime.parse("12:34:56.123456+09:00"),
            java.time.OffsetDateTime.parse("2026-10-20T12:34:56.123456-03:30")
        };
        int[] types = { Types.DATE, Types.TIME, Types.TIMESTAMP, Types.TIME_WITH_TIMEZONE, Types.TIMESTAMP_WITH_TIMEZONE };
        try (PreparedStatement p = c.prepareStatement("SELECT ? AS X")) {
            equal(Object.class.getName(), p.getMetaData().getColumnClassName(1));
            for (int i = 0; i < values.length; i++) {
                p.setObject(1, values[i]);
                equal(Integer.valueOf(types[i]), Integer.valueOf(p.getMetaData().getColumnType(1)));
                try (ResultSet rows = p.executeQuery()) { ok(rows.next()); equal(values[i], rows.getObject(1, values[i].getClass())); }
            }
            p.setObject(1, null, JDBCType.TIMESTAMP_WITH_TIMEZONE);
            equal(Integer.valueOf(Types.TIMESTAMP_WITH_TIMEZONE), Integer.valueOf(p.getParameterMetaData().getParameterType(1)));
            equal(java.time.OffsetDateTime.class.getName(), p.getMetaData().getColumnClassName(1));
            try (ResultSet rows = p.executeQuery()) { ok(rows.next()); equal(null, rows.getObject(1)); ok(rows.wasNull()); }
            BigDecimal number = new BigDecimal("12345678901234567890123456789.123456789");
            p.setObject(1, number, JDBCType.DECIMAL, 9);
            equal(Integer.valueOf(38), Integer.valueOf(p.getMetaData().getPrecision(1)));
            equal(Integer.valueOf(9), Integer.valueOf(p.getParameterMetaData().getScale(1)));
            try (ResultSet rows = p.executeQuery()) { ok(rows.next()); equal(number, rows.getBigDecimal(1)); }
            try { p.setObject(1, new BigDecimal("0.000000000000000000000000000000000000001")); throw new AssertionError(); }
            catch (SQLDataException e) { equal("22003", e.getSQLState()); }
            try (ResultSet rows = p.executeQuery()) { ok(rows.next()); equal(number, rows.getBigDecimal(1)); }
        }
        System.out.println("PASS SQLType·java.time·오프셋·NULL·38자리 숫자 힌트와 실패한 바인딩 보존");
        command(c, "CREATE TABLE B42 (ID INTEGER PRIMARY KEY, V INTEGER)");
        command(c, "INSERT INTO B42 VALUES (1,0)");
        try (PreparedStatement p = c.prepareStatement("UPDATE B42 SET V=V+1 WHERE ? > ?")) {
            p.setObject(1, 10, JDBCType.INTEGER); p.setObject(2, 2, JDBCType.INTEGER); p.addBatch();
            p.setString(1, "10"); p.setString(2, "2"); p.addBatch();
            long[] counts = p.executeLargeBatch();
            ok(java.util.Arrays.equals(new long[] {1,0}, counts));
        }
        equal(Integer.valueOf(1), Integer.valueOf(scalar(c, "SELECT V FROM B42 WHERE ID=1")));
        try (PreparedStatement p = c.prepareStatement("INSERT INTO B42 VALUES (?,?)")) {
            p.setObject(1, 2, JDBCType.INTEGER); p.setInt(2, 2); p.addBatch();
            p.setInt(1, 1); p.addBatch();
            try { p.executeLargeBatch(); throw new AssertionError(); }
            catch (BatchUpdateException e) { equal("23505", e.getSQLState()); ok(java.util.Arrays.equals(new long[] {1}, e.getLargeUpdateCounts())); }
        }
        System.out.println("PASS executeLargeBatch의 바인딩 타입 스냅샷·숫자/문자 비교·부분 실패 long 행 수");
    }

    /** 제한 시간 안에 취소를 보내며 실패한 시험의 작업 스레드도 확실히 정리한다. */
    private static SQLException cancel(Connection c, final PreparedStatement statement) throws Exception {
        ExecutorService executor = Executors.newSingleThreadExecutor();
        final CountDownLatch started = new CountDownLatch(1);
        Future<SQLException> work = executor.submit(new Callable<SQLException>() { public SQLException call() {
            started.countDown();
            try { statement.execute(); return null; } catch (SQLException e) { return e; }
        } });
        try {
            ok(started.await(3, TimeUnit.SECONDS)); Thread.sleep(100);
            for (int i = 0; i < 50 && !work.isDone(); i++) { statement.cancel(); Thread.sleep(20); }
            SQLException error = work.get(10, TimeUnit.SECONDS); ok(error != null); ok(c.isValid(2)); return error;
        } finally { work.cancel(true); executor.shutdownNow(); ok(executor.awaitTermination(3, TimeUnit.SECONDS)); }
    }
}
