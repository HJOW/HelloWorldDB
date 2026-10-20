package org.duckdns.hjow.helloworlddb.jdbc8;

import java.io.*;
import java.math.*;
import java.nio.file.*;
import java.sql.*;
import java.time.*;
import java.util.*;
import java.util.jar.*;
import org.duckdns.hjow.helloworlddb.jdbc8.protocol.*;

/** 배포 JAR만 클래스 경로에 두고 실행하는 단위·실제 서버 시험. */
public final class DriverTest {
    private static int passed;
    private DriverTest() { }
    interface Check { void run() throws Exception; }
    static void test(String name, Check c) throws Exception { c.run(); passed++; System.out.println("PASS " + name); }
    static void equal(Object expected, Object actual) { if (!Objects.deepEquals(expected, actual)) throw new AssertionError("expected=" + expected + " actual=" + actual); }
    static void ok(boolean v) { if (!v) throw new AssertionError(); }
    static void state(String state, Check c) throws Exception {
        try { c.run(); throw new AssertionError("Expected SQLSTATE " + state); } catch (SQLException e) { equal(state, e.getSQLState()); if (state.equals("0A000")) ok(e instanceof SQLFeatureNotSupportedException); }
    }
    static void io(Check c) throws Exception { try { c.run(); throw new AssertionError("Expected IOException"); } catch (IOException expected) { } }
    static Properties credentials() { Properties p = new Properties(); p.setProperty("user", "SYSTEM"); p.setProperty("password", "HelloWorldDB"); return p; }
    public static void main(String[] args) throws Exception {
        if (args[0].equals("unit")) unit(args[1]);
        else if (args[0].equals("tls-reject")) tlsReject(args[1], args[2]);
        else integration(args[1], args[2], args.length > 3 ? args[3] : "");
        System.out.println("PASSED " + passed);
    }
    private static void unit(String jar) throws Exception {
        ProtocolTest.run();
        test("JAR 서비스 등록·라이선스·Java 8 바이트코드", () -> {
            try (JarFile file = new JarFile(jar)) {
                ok(file.getEntry("META-INF/LICENSE") != null); ok(file.getEntry("META-INF/services/java.sql.Driver") != null);
                Enumeration<JarEntry> entries = file.entries();
                while (entries.hasMoreElements()) {
                    JarEntry e = entries.nextElement(); ok(!e.getName().contains("DriverTest"));
                    if (e.getName().endsWith(".class")) try (DataInputStream in = new DataInputStream(file.getInputStream(e))) { equal(0xcafebabe, in.readInt()); in.readUnsignedShort(); equal(52, in.readUnsignedShort()); }
                }
            }
            equal("org.duckdns.hjow.helloworlddb.jdbc8.Driver", DriverManager.getDriver("jdbc:helloworlddb://localhost").getClass().getName());
        });
        test("JSON 정밀도·유니코드·빈 문자열·NULL 왕복", () -> {
            Map<String, Object> value = Json.object("한글😀", Arrays.asList("", null, true, 123L, new BigDecimal("0.0000000000000000001")), "escape", "\n\t\"\\");
            equal(value, Json.decode(Json.encode(value)));
        });
        test("잘못된 UTF-8·JSON·서러게이트 거부", () -> {
            io(() -> Json.decode(new byte[] { (byte) 0xc0, (byte) 0x80 }));
            for (String invalid : Arrays.asList("[1,]", "{\"a\":1,\"a\":2}", "01", "true false", "\"\\uD800\"", "\"\\u+123\"", "\"x\ny\"")) io(() -> Json.decode(invalid.getBytes("UTF-8")));
            io(() -> Json.encode("\ud800")); io(() -> Json.encode(Double.NaN));
        });
        test("PBKDF2-HMAC-SHA256 표준 벡터·base64", () -> {
            equal("120FB6CFFCF8B32C43E7225256C4F837A86548C92CCC35480805987CB70BE17B", Values.hex(Scram.pbkdf2("password".getBytes("UTF-8"), "salt".getBytes("UTF-8"), 1)));
            for (int i = 0; i < 200; i++) { byte[] b = new byte[i]; new Random(i).nextBytes(b); equal(Base64.getEncoder().encodeToString(b), Scram.base64(b)); equal(b, Scram.unbase64(Scram.base64(b))); }
            io(() -> Scram.unbase64("Zh==")); io(() -> Scram.unbase64("invalid"));
        });
        test("SQL 파라미터 위치가 문자열·식별자·주석을 제외", () -> {
            List<String> tokens = JdbcStatement.tokens("/* ? */ SELECT '?', \"?\", ?, 'a''?' -- ?\n, ?"); equal(2L, tokens.stream().filter(t -> t.equals("?")).count());
        });
        test("URL·속성·SSL 조합 검증", () -> {
            Driver d = new Driver(); ok(!d.acceptsURL(null)); equal(null, d.connect("jdbc:other://localhost", credentials()));
            for (String bad : Arrays.asList("jdbc:helloworlddb://host/db", "jdbc:helloworlddb://host:0", "jdbc:helloworlddb://host?ssl=maybe", "jdbc:helloworlddb://host?transport=udp&ssl=true", "jdbc:helloworlddb://host?sslCa=x", "jdbc:helloworlddb://host?unknown=x")) state("08001", () -> new Driver.Options(bad, credentials()));
            Driver.Options o = new Driver.Options("jdbc:helloworlddb://[::1]:7411?tablespace=%ED%95%9C%EA%B8%80", credentials()); equal("::1", o.host); equal("한글", o.tablespace);
        });
        test("타입 변환 범위·숫자 정밀도·미지원 값", () -> {
            equal(Long.MAX_VALUE, Values.decode("9223372036854775807", Types.BIGINT));
            equal(new BigDecimal("99999999999999999999999999999.123456789"), Values.decode("99999999999999999999999999999.123456789", Types.DECIMAL));
            equal("9223372036854775807", Values.encode(Long.MAX_VALUE)); state("22003", () -> Values.convert("2147483648", Integer.class));
            state("22003", () -> Values.encode(Double.POSITIVE_INFINITY)); state("0A000", () -> Values.encode(new Object())); state("22018", () -> Values.decode("A", Types.BINARY));
            equal(new BigDecimal("1.24"), Values.target("1.235", Types.DECIMAL, 2));
        });
        test("SCRAM nonce·반복수·서버 서명 검증", () -> {
            Scram s = new Scram("a,b=c"); ok(s.first().contains("a=2Cb=3Dc"));
            io(() -> s.finish("p", "r=bad,s=c2FsdA==,i=1"));
            String nonce = s.first().substring(s.first().lastIndexOf("r=") + 2);
            io(() -> s.finish("p", "r=" + nonce + "x,s=c2FsdA==,i=10000001"));
            s.finish("p", "r=" + nonce + "x,s=c2FsdA==,i=1"); io(() -> s.verify("v=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="));
        });
    }
    private static void tlsReject(String url, String ca) throws Exception {
        test("기본 TLS 신뢰 검증 실패", () -> { long start = System.nanoTime(); state("08001", () -> DriverManager.getConnection(url + "?ssl=true", credentials())); ok((System.nanoTime() - start) / 1000000 >= 180); });
        test("신뢰한 CA도 호스트 이름 불일치 거부", () -> { Properties p = credentials(); p.setProperty("ssl", "true"); p.setProperty("sslCa", ca); state("08001", () -> DriverManager.getConnection(url, p)); });
        test("명시적 검증 끄기", () -> { Properties p = credentials(); p.setProperty("ssl", "true"); p.setProperty("sslVerify", "false"); try (Connection c = DriverManager.getConnection(url, p)) { ok(c.isValid(2)); } });
    }
    private static void integration(String url, String transport, String ca) throws Exception {
        Properties props = credentials(); props.setProperty("fetchSize", "3");
        if (transport.equals("udp")) props.setProperty("transport", "udp");
        if (transport.equals("tls")) { props.setProperty("ssl", "true"); props.setProperty("sslCa", ca); }
        try (Connection c = DriverManager.getConnection(url, props)) {
            String space = "J" + System.getProperty("java.specification.version").replace(".", "") + transport.toUpperCase(Locale.ROOT) + System.getProperty("hwdb.test.suffix", "");
            try (Statement s = c.createStatement()) { s.execute("CREATE TABLESPACE " + space); }
            c.setSchema(space);
            test("서비스 로딩·JDBC 버전·래퍼·기본 속성", () -> {
                ok(c.isValid(2)); equal(true, c.getAutoCommit()); equal(space, c.getSchema()); equal(null, c.getCatalog());
                equal(4, c.getMetaData().getJDBCMajorVersion()); equal(2, c.getMetaData().getJDBCMinorVersion()); equal(c, c.unwrap(Connection.class)); ok(c.isWrapperFor(Connection.class));
                equal(Connection.TRANSACTION_READ_COMMITTED, c.getTransactionIsolation()); state("0A000", () -> c.setTransactionIsolation(Connection.TRANSACTION_SERIALIZABLE));
            });
            test("DDL·PreparedStatement·JDBC 4.2 SQLType·파라미터 메타데이터", () -> {
                try (Statement s = c.createStatement()) { equal(0, s.executeUpdate("CREATE TABLE Q (ID INTEGER PRIMARY KEY, V VARCHAR, N DECIMAL, TS TIMESTAMP(6))")); }
                try (PreparedStatement p = c.prepareStatement("INSERT INTO Q VALUES (?, ?, ?, ?)")) {
                    equal(4, p.getParameterMetaData().getParameterCount()); equal(Types.OTHER, p.getParameterMetaData().getParameterType(1));
                    state("07001", p::executeUpdate); state("07009", () -> p.setInt(5, 1));
                    p.setObject(1, 1, JDBCType.INTEGER); p.setNString(2, "안녕😀"); p.setBigDecimal(3, new BigDecimal("1.2345")); p.setObject(4, LocalDateTime.of(2026, 10, 20, 12, 34, 56, 123456000)); equal(1, p.executeUpdate());
                    p.clearParameters(); state("07001", p::executeUpdate);
                }
                try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT * FROM Q")) {
                    ok(r.next()); equal(1, r.getInt("id")); equal("안녕😀", r.getNString("V")); equal(new BigDecimal("1.235"), r.getBigDecimal(3)); equal(123456000, r.getTimestamp(4).getNanos()); ok(!r.next());
                    ResultSetMetaData m = r.getMetaData(); equal(65535, m.getPrecision(2)); equal(10, m.getPrecision(3)); equal(3, m.getScale(3)); equal(6, m.getScale(4));
                }
            });
            test("모든 DB 타입과 java.time 타입의 정밀 왕복", () -> {
                try (Statement s = c.createStatement()) { s.execute("CREATE TABLE TYPES_TEST (C CHAR(4), V VARCHAR(10), B BINARY(3), VB VARBINARY(8), SI SMALLINT, I INTEGER, BI BIGINT, N NUMERIC(38,9), R REAL, D DOUBLE PRECISION, BO BOOLEAN, DT DATE, TM TIME(6), TS TIMESTAMP(6), TZ TIME(6) WITH TIME ZONE, TSZ TIMESTAMP(6) WITH TIME ZONE, IV INTERVAL DAY TO SECOND(6))"); }
                Object[] values = { "한😀", "", new byte[] { 0, (byte) 255 }, new byte[] { 0, 17, (byte) 255 }, -32768, Integer.MAX_VALUE, Long.MAX_VALUE, new BigDecimal("99999999999999999999999999999.123456789"), 1.25f, 2.125d, true,
                    LocalDate.of(2026, 10, 20), LocalTime.of(12, 34, 56, 123456000), LocalDateTime.of(2026, 10, 20, 12, 34, 56, 123456000), OffsetTime.parse("12:34:56.123456+09:00"), OffsetDateTime.parse("2026-10-20T12:34:56.123456-03:30"), "3 04:05:06.123456" };
                try (PreparedStatement p = c.prepareStatement("INSERT INTO TYPES_TEST VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")) { for (int i = 0; i < values.length; i++) p.setObject(i + 1, values[i]); equal(1, p.executeUpdate()); }
                try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT * FROM TYPES_TEST")) {
                    ok(r.next()); equal("한😀  ", r.getString(1)); equal("", r.getObject(2)); equal(new byte[] { 0, (byte) 255, 0 }, r.getBytes(3));
                    for (int i = 3; i <= 10; i++) equal(values[i], r.getObject(i + 1));
                    equal(java.sql.Date.valueOf((LocalDate) values[11]), r.getObject(12)); equal(values[11], r.getObject(12, LocalDate.class));
                    equal(Time.valueOf((LocalTime) values[12]), r.getObject(13)); equal(values[12], r.getObject(13, LocalTime.class));
                    equal(values[13], r.getObject(14, LocalDateTime.class)); equal(Timestamp.valueOf((LocalDateTime) values[13]), r.getObject(14));
                    equal(values[14], r.getObject(15)); equal(values[15], r.getObject(16)); equal(values[16], r.getObject(17));
                    equal(Types.TIME_WITH_TIMEZONE, r.getMetaData().getColumnType(15)); equal(OffsetDateTime.class.getName(), r.getMetaData().getColumnClassName(16));
                }
            });
            test("NULL·wasNull·라벨·변환 오류", () -> {
                try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT CAST(NULL AS INTEGER) AS N, '' AS EMPTY, CAST(2147483648 AS BIGINT) AS BIG")) {
                    state("24000", () -> r.getInt(1)); ok(r.next()); equal(0, r.getInt("n")); ok(r.wasNull()); equal(null, r.getObject(1, Integer.class)); equal("", r.getString(2)); ok(!r.wasNull()); state("22003", () -> r.getInt(3)); state("07009", () -> r.getString(0));
                }
            });
            test("배치·fetch·대형 UTF-8 메시지·커서 닫기", () -> {
                String large = String.join("", Collections.nCopies(20000, "한"));
                try (PreparedStatement p = c.prepareStatement("INSERT INTO Q VALUES (?, ?, ?, ?)")) {
                    for (int i = 2; i <= 40; i++) { p.setInt(1, i); p.setString(2, i == 2 ? large : "row" + i); p.setNull(3, Types.DECIMAL); p.setTimestamp(4, Timestamp.valueOf("2026-10-20 12:34:56.123456")); p.addBatch(); }
                    int[] counts = p.executeBatch(); equal(39, counts.length); for (int i : counts) equal(1, i);
                }
                try (Statement s = c.createStatement()) {
                    s.setFetchSize(1); try (ResultSet r = s.executeQuery("SELECT ID, V FROM Q ORDER BY ID")) { int count = 0; while (r.next()) { count++; equal(count, r.getInt(1)); if (count == 2) equal(large, r.getString(2)); } equal(40, count); }
                    s.setMaxRows(5); try (ResultSet r = s.executeQuery("SELECT * FROM Q ORDER BY ID")) { int count = 0; while (r.next()) count++; equal(5, count); }
                    s.setMaxRows(0); for (int i = 0; i < 20; i++) try (ResultSet r = s.executeQuery("SELECT * FROM Q")) { ok(r.next()); }
                    ResultSet old = s.executeQuery("SELECT * FROM Q"); s.executeQuery("SELECT 1").close(); ok(old.isClosed());
                }
            });
            test("커밋·롤백·세이브포인트·홀더블 결과", () -> {
                c.setAutoCommit(false);
                try (Statement s = c.createStatement()) {
                    s.executeUpdate("UPDATE Q SET V = 'committed' WHERE ID = 1"); c.commit();
                    s.executeUpdate("UPDATE Q SET V = 'before' WHERE ID = 1"); Savepoint p = c.setSavepoint(); s.executeUpdate("UPDATE Q SET V = 'after' WHERE ID = 1"); c.rollback(p); c.releaseSavepoint(p);
                    try (ResultSet r = s.executeQuery("SELECT V FROM Q WHERE ID = 1")) { ok(r.next()); equal("before", r.getString(1)); }
                    c.rollback(); state("3B001", () -> c.rollback(p));
                    Savepoint named = c.setSavepoint("한글\"point"); equal("한글\"point", named.getSavepointName()); c.releaseSavepoint(named);
                    try (ResultSet r = s.executeQuery("SELECT ID FROM Q ORDER BY ID")) { ok(r.next()); c.commit(); int count = 1; while (r.next()) count++; equal(40, count); }
                } finally { c.rollback(); c.setAutoCommit(true); }
                state("25000", c::commit); state("25000", c::setSavepoint);
            });
            test("서버 SQLSTATE·내부 번호·오류 뒤 연결 재사용·배치 일부 성공", () -> {
                try (Statement s = c.createStatement()) {
                    try { s.executeUpdate("INSERT INTO Q (ID) VALUES (1)"); throw new AssertionError(); } catch (SQLException e) { equal("23505", e.getSQLState()); ok(e.getErrorCode() > 0); }
                    ok(c.isValid(2)); s.addBatch("INSERT INTO Q (ID) VALUES (101)"); s.addBatch("INSERT INTO Q (ID) VALUES (1)"); s.addBatch("INSERT INTO Q (ID) VALUES (102)");
                    try { s.executeBatch(); throw new AssertionError(); } catch (BatchUpdateException e) { equal("23505", e.getSQLState()); equal(new int[] { 1 }, e.getUpdateCounts()); }
                    try (ResultSet r = s.executeQuery("SELECT COUNT(*) FROM Q WHERE ID = 102")) { ok(r.next()); equal(0L, r.getLong(1)); }
                }
            });
            test("메타데이터 테이블·컬럼·PK·FK·인덱스·타입", () -> {
                try (Statement s = c.createStatement()) { s.execute("CREATE TABLE CHILD (ID INTEGER PRIMARY KEY, P INTEGER REFERENCES Q (ID) ON DELETE CASCADE)"); s.execute("CREATE INDEX IX_CHILD ON CHILD (P DESC)"); }
                DatabaseMetaData m = c.getMetaData();
                try (ResultSet r = m.getSchemas(null, space)) { ok(r.next()); equal(space, r.getString("TABLE_SCHEM")); ok(!r.next()); }
                try (ResultSet r = m.getTables(null, space, "Q", new String[] { "TABLE" })) { ok(r.next()); equal("Q", r.getString("TABLE_NAME")); ok(!r.next()); }
                try (ResultSet r = m.getColumns(null, space, "Q", "%")) { int count = 0; while (r.next()) { count++; if (r.getString("COLUMN_NAME").equals("N")) { equal(10, r.getInt("COLUMN_SIZE")); equal(3, r.getInt("DECIMAL_DIGITS")); } } equal(4, count); }
                try (ResultSet r = m.getPrimaryKeys(null, space, "Q")) { ok(r.next()); equal("ID", r.getString("COLUMN_NAME")); equal(1, r.getInt("KEY_SEQ")); }
                try (ResultSet r = m.getImportedKeys(null, space, "CHILD")) { ok(r.next()); equal("Q", r.getString("PKTABLE_NAME")); equal(DatabaseMetaData.importedKeyCascade, r.getInt("DELETE_RULE")); }
                try (ResultSet r = m.getIndexInfo(null, space, "CHILD", false, false)) { int count = 0; while (r.next()) { count++; if (r.getString("INDEX_NAME").equals("IX_CHILD")) equal("D", r.getString("ASC_OR_DESC")); } equal(2, count); }
                try (ResultSet r = m.getTypeInfo()) { int count = 0; while (r.next()) count++; equal(17, count); }
            });
            test("Calendar 날짜시간·타입 지정 setObject·스트림", () -> {
                Calendar utc = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
                Timestamp ts = Timestamp.from(Instant.parse("2026-10-20T12:34:56.123456Z"));
                try (PreparedStatement p = c.prepareStatement("UPDATE Q SET V=?, N=?, TS=? WHERE ID=1")) {
                    p.setCharacterStream(1, new StringReader("reader한글")); p.setObject(2, "12.3456", Types.DECIMAL, 2); p.setTimestamp(3, ts, utc); equal(1, p.executeUpdate());
                }
                try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT V,N,TS FROM Q WHERE ID=1")) { ok(r.next()); equal("reader한글", r.getString(1)); equal(new BigDecimal("12.350"), r.getBigDecimal(2)); equal(ts, r.getTimestamp(3, utc)); }
            });
            test("사용자 권한·기본 테이블스페이스 없음·뷰 메타데이터 가시성", () -> {
                String user = space + "_U";
                try (Statement s = c.createStatement()) { s.execute("CREATE USER " + user + " IDENTIFIED BY 'test-password'"); s.execute("CREATE VIEW VW AS SELECT ID, V FROM Q"); s.execute("GRANT SELECT ON VW TO " + user); }
                Properties limited = new Properties(); limited.putAll(props); limited.setProperty("user", user); limited.setProperty("password", "test-password");
                try (Connection other = DriverManager.getConnection(url, limited)) {
                    equal(null, other.getSchema());
                    try (ResultSet r = other.getMetaData().getTables(null, space, "%", null)) { ok(r.next()); equal("VW", r.getString("TABLE_NAME")); ok(!r.next()); }
                    try (Statement s = other.createStatement()) { state("42501", () -> s.executeQuery("SELECT * FROM " + space + ".Q")); try (ResultSet r = s.executeQuery("SELECT * FROM " + space + ".VW")) { ok(r.next()); } }
                    try (ResultSet r = other.getMetaData().getTablePrivileges(null, space, "VW")) { ok(r.next()); equal(user, r.getString("GRANTEE")); equal("SELECT", r.getString("PRIVILEGE")); }
                    try (ResultSet r = other.getMetaData().getColumns(null, space, "VW", "%")) { ok(r.next()); equal("ID", r.getString("COLUMN_NAME")); equal(DatabaseMetaData.columnNullableUnknown, r.getInt("NULLABLE")); equal("", r.getString("IS_NULLABLE")); ok(r.next()); equal("V", r.getString("COLUMN_NAME")); ok(!r.next()); }
                    try (ResultSet r = other.getMetaData().getColumns(null, space, "VW", "V")) { ok(r.next()); equal("V", r.getString("COLUMN_NAME")); equal(2, r.getInt("ORDINAL_POSITION")); ok(!r.next()); }
                    try (ResultSet r = other.getMetaData().getColumns(null, space, "VW", "MISSING")) { ok(!r.next()); }
                }
                try (Statement s = c.createStatement()) { s.execute("DROP USER " + user); }
            });
            test("명시한 NUMERIC 정밀도·특수 식별자 패턴", () -> {
                try (Statement s = c.createStatement()) { s.execute("CREATE TABLE \"A_%\" (N NUMERIC(12), V NVARCHAR(25))"); }
                try (ResultSet r = c.getMetaData().getColumns(null, space, "A\\_\\%", "%")) { ok(r.next()); equal(12, r.getInt("COLUMN_SIZE")); equal(0, r.getInt("DECIMAL_DIGITS")); ok(r.next()); equal(25, r.getInt("COLUMN_SIZE")); ok(!r.next()); }
                state("22023", () -> c.prepareStatement(null));
                try (PreparedStatement p = c.prepareStatement("SELECT ?")) {
                    state("HY000", () -> p.setCharacterStream(1, new Reader() { @Override public int read(char[] buffer, int offset, int length) throws IOException { throw new IOException("Test failure."); } @Override public void close() { } }));
                }
            });
            test("미지원 기능은 0A000·수명 종료", () -> {
                state("0A000", () -> c.prepareCall("CALL X()")); state("0A000", c::createBlob); state("0A000", () -> c.createStatement(ResultSet.TYPE_SCROLL_INSENSITIVE, ResultSet.CONCUR_READ_ONLY));
                try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT 1")) { state("0A000", r::previous); state("0A000", () -> r.updateInt(1, 2)); state("0A000", s::getGeneratedKeys); }
                Statement s = c.createStatement(); s.closeOnCompletion(); ResultSet r = s.executeQuery("SELECT 1"); r.close(); ok(s.isClosed());
                Statement other = c.createStatement(); other.close(); state("HY010", () -> other.execute("SELECT 1"));
            });
            if (transport.equals("udp")) test("UDP 유휴 ping으로 세션 유지", () -> { Thread.sleep(1400); ok(c.isValid(2)); });
        }
    }
}
