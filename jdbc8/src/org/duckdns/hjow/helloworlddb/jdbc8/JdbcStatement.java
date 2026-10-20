package org.duckdns.hjow.helloworlddb.jdbc8;

import java.io.*;
import java.lang.reflect.Method;
import java.math.*;
import java.sql.*;
import java.util.*;
import org.duckdns.hjow.helloworlddb.jdbc8.protocol.Protocol;

/** 서버가 준비 문장을 저장하지 않으므로 SQL과 바인딩 값을 실행 시 함께 보낸다. */
final class JdbcStatement extends JdbcProxy {
    final JdbcConnection connection; final String sql; final int holdability;
    private final Object[] params; private final boolean[] bound;
    private final List<Batch> batches = new ArrayList<>();
    private JdbcResultSet result;
    private boolean closed, closeOnCompletion, poolable; private int fetchSize, timeout; private long updateCount = -1, maxRows;
    static Statement open(JdbcConnection c, String sql, int hold) throws SQLException {
        if (sql == null) { JdbcStatement s = new JdbcStatement(c, null, hold); return s.create(Statement.class); }
        JdbcStatement s = new JdbcStatement(c, sql, hold); return s.create(PreparedStatement.class);
    }
    private JdbcStatement(JdbcConnection c, String sql, int hold) throws SQLException {
        connection = c; this.sql = sql; holdability = hold; fetchSize = c.options.fetchSize;
        int count = 0; if (sql != null) for (String token : tokens(sql)) if (token.equals("?")) count++;
        if (count > 65535) throw invalid("Too many parameters."); params = new Object[count]; bound = new boolean[count]; c.statements.add(this);
    }
    private void check() throws SQLException { connection.check(); if (closed) throw new SQLException("Statement is closed.", "HY010"); }
    @Override synchronized Object call(String n, Object[] a, Method method) throws Exception {
        if (n.equals("close")) { close(); return null; }
        if (n.equals("isClosed")) return closed || connection.protocol.isClosed();
        check();
        if (n.equals("execute") || n.equals("executeQuery") || n.equals("executeUpdate") || n.equals("executeLargeUpdate")) {
            String text; List<Object> values;
            if (sql != null) { if (a.length != 0) throw new SQLException("SQL must not be supplied to a PreparedStatement.", "HY010"); text = sql; values = parameters(); }
            else {
                if (a.length == 0 || !(a[0] instanceof String)) throw invalid("SQL is required."); text = (String) a[0]; values = Collections.emptyList();
                if (a.length > 1 && (!(a[1] instanceof Integer) || (Integer) a[1] != Statement.NO_GENERATED_KEYS)) throw unsupported("Generated keys");
            }
            execute(text, values);
            if (n.equals("execute")) return result != null;
            if (n.equals("executeQuery")) { if (result == null) throw new SQLException("The statement did not return rows.", "02000"); return result.proxy; }
            if (result != null) { result.close(); result = null; throw new SQLException("The statement returned rows.", "HY000"); }
            if (n.equals("executeLargeUpdate")) return updateCount;
            return count(updateCount);
        }
        if (sql != null && n.startsWith("set") && a.length >= 2 && a[0] instanceof Integer && isParameterSetter(n)) { bind(n, a); return null; }
        switch (n) {
        case "getConnection": return connection.proxy;
        case "getResultSet": return result == null ? null : result.proxy;
        case "getUpdateCount": return count(updateCount);
        case "getLargeUpdateCount": return updateCount;
        case "getMoreResults":
            if (a.length > 0 && (Integer) a[0] == Statement.KEEP_CURRENT_RESULT) throw unsupported("Multiple open results per Statement");
            if (a.length > 0 && (Integer) a[0] != Statement.CLOSE_CURRENT_RESULT && (Integer) a[0] != Statement.CLOSE_ALL_RESULTS) throw invalid("Invalid result disposition.");
            closeResult(); updateCount = -1; return false;
        case "setFetchSize": { int size = (Integer) a[0]; if (size < 0 || size > 100000) throw invalid("Invalid fetch size."); fetchSize = size == 0 ? connection.options.fetchSize : size; return null; }
        case "getFetchSize": return fetchSize;
        case "setFetchDirection": if ((Integer) a[0] != ResultSet.FETCH_FORWARD) throw unsupported("Fetch direction"); return null;
        case "getFetchDirection": return ResultSet.FETCH_FORWARD;
        case "setQueryTimeout": if ((Integer) a[0] < 0) throw invalid("Invalid query timeout."); timeout = (Integer) a[0]; return null;
        case "getQueryTimeout": return timeout;
        case "setMaxRows": case "setLargeMaxRows": { long limit = ((Number) a[0]).longValue(); if (limit < 0) throw invalid("Invalid row limit."); maxRows = limit; return null; }
        case "getMaxRows": return count(maxRows);
        case "getLargeMaxRows": return maxRows;
        case "getResultSetType": return ResultSet.TYPE_FORWARD_ONLY;
        case "getResultSetConcurrency": return ResultSet.CONCUR_READ_ONLY;
        case "getResultSetHoldability": return holdability;
        case "getWarnings": case "clearWarnings": return null;
        case "setPoolable": poolable = (Boolean) a[0]; return null;
        case "isPoolable": return poolable;
        case "closeOnCompletion": closeOnCompletion = true; return null;
        case "isCloseOnCompletion": return closeOnCompletion;
        case "getMaxFieldSize": return 0;
        case "setMaxFieldSize": if ((Integer) a[0] != 0) throw unsupported("Field truncation"); return null;
        case "setEscapeProcessing": if ((Boolean) a[0]) throw unsupported("JDBC escape processing"); return null;
        case "clearParameters": requirePrepared(); Arrays.fill(params, null); Arrays.fill(bound, false); return null;
        case "getParameterMetaData": requirePrepared(); return parameterMetaData();
        case "getMetaData": requirePrepared(); return result == null ? null : result.metadata();
        case "addBatch":
            if (sql != null) { if (a.length != 0) throw new SQLException("SQL must not be supplied to a PreparedStatement.", "HY010"); batches.add(new Batch(sql, parameters())); }
            else { if (a.length != 1 || !(a[0] instanceof String)) throw invalid("SQL is required."); batches.add(new Batch((String) a[0], Collections.emptyList())); }
            return null;
        case "clearBatch": batches.clear(); return null;
        case "executeBatch": case "executeLargeBatch": {
            long[] counts = new long[batches.size()]; int completed = 0;
            try { for (Batch b : batches) { execute(b.sql, b.params); if (result != null) { closeResult(); throw new SQLException("Batch statement returned rows.", "HY000"); } counts[completed++] = updateCount; } }
            catch (SQLException e) {
                if (n.equals("executeLargeBatch")) throw new BatchUpdateException(e.getMessage(), e.getSQLState(), e.getErrorCode(), Arrays.copyOf(counts, completed), e);
                int[] c = new int[completed]; for (int i = 0; i < completed; i++) c[i] = count(counts[i]); throw new BatchUpdateException(e.getMessage(), e.getSQLState(), e.getErrorCode(), c, e);
            } finally { batches.clear(); }
            if (n.equals("executeLargeBatch")) return counts;
            int[] c = new int[counts.length]; for (int i = 0; i < c.length; i++) c[i] = count(counts[i]); return c;
        }
        default: throw unsupported(n);
        }
    }
    private void requirePrepared() throws SQLException { if (sql == null) throw new SQLException("Not a PreparedStatement.", "HY010"); }
    private static int count(long count) { return count > Integer.MAX_VALUE ? Statement.SUCCESS_NO_INFO : (int) count; }
    private void execute(String text, List<Object> values) throws SQLException {
        closeResult(); updateCount = -1;
        Map<String, Object> r;
        synchronized (connection.protocol) {
            int old = connection.protocol.getTimeout();
            try {
                if (timeout > 0) connection.protocol.setTimeout((int) Math.min(Integer.MAX_VALUE, timeout * 1000L));
                r = connection.execute(text, values, fetchSize);
            } finally { connection.protocol.setTimeout(old); }
        }
        if (r.get("type").equals("rows")) result = JdbcResultSet.from(this, r, fetchSize, maxRows);
        else updateCount = r.get("rowCount") instanceof Number ? ((Number) r.get("rowCount")).longValue() : 0;
    }
    private List<Object> parameters() throws SQLException {
        List<Object> values = new ArrayList<>(params.length);
        for (int i = 0; i < params.length; i++) { if (!bound[i]) throw new SQLException("Parameter " + (i + 1) + " is not bound.", "07001"); values.add(params[i]); }
        return values;
    }
    private static boolean isParameterSetter(String n) {
        return Arrays.asList("setNull", "setBoolean", "setByte", "setShort", "setInt", "setLong", "setFloat", "setDouble", "setBigDecimal", "setString", "setNString", "setBytes", "setDate", "setTime", "setTimestamp", "setObject", "setAsciiStream", "setBinaryStream", "setCharacterStream", "setNCharacterStream").contains(n);
    }
    private void bind(String n, Object[] a) throws Exception {
        int index = (Integer) a[0] - 1; if (index < 0 || index >= params.length) throw new SQLException("Invalid parameter index.", "07009");
        Object value = a[1];
        if (n.equals("setNull")) value = null;
        else if (n.equals("setObject") && a.length >= 3) {
            if (a[2] == null) throw invalid("SQL type is null.");
            Integer target = a[2] instanceof SQLType ? ((SQLType) a[2]).getVendorTypeNumber() : (Integer) a[2];
            if (target == null) throw unsupported("Unknown SQLType"); value = Values.target(value, target, a.length == 4 ? (Integer) a[3] : null);
        } else if ((n.equals("setDate") || n.equals("setTime") || n.equals("setTimestamp")) && a.length == 3) value = Values.calendarValue(value, (Calendar) a[2], false);
        else if (n.endsWith("Stream")) {
            long length = a.length == 3 ? ((Number) a[2]).longValue() : -1;
            if (length < -1 || length > 16777216) throw invalid("Invalid stream length.");
            if (value != null) {
                if (value instanceof InputStream) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream(); InputStream in = (InputStream) value;
                    for (long i = 0; length < 0 || i < length; i++) { int b = in.read(); if (b < 0) { if (length >= 0) throw new SQLException("Stream is shorter than declared.", "22001"); break; } if (out.size() >= 16777216) throw invalid("Stream size limit exceeded."); out.write(b); }
                    value = n.equals("setAsciiStream") ? new String(out.toByteArray(), "US-ASCII") : out.toByteArray();
                } else {
                    StringBuilder out = new StringBuilder(); Reader reader = (Reader) value;
                    for (long i = 0; length < 0 || i < length; i++) { int c = reader.read(); if (c < 0) { if (length >= 0) throw new SQLException("Stream is shorter than declared.", "22001"); break; } if (out.length() >= 16777216) throw invalid("Stream size limit exceeded."); out.append((char) c); }
                    value = out.toString();
                }
            }
        }
        params[index] = Values.encode(value); bound[index] = true;
    }
    private ParameterMetaData parameterMetaData() {
        return new JdbcProxy() {
            @Override Object call(String n, Object[] a, Method m) throws SQLException {
                check(); if (n.equals("getParameterCount")) return params.length;
                int index = (Integer) a[0]; if (index < 1 || index > params.length) throw new SQLException("Invalid parameter index.", "07009");
                switch (n) {
                case "getParameterType": return Types.OTHER; case "getParameterTypeName": return "UNKNOWN";
                case "getParameterClassName": return Object.class.getName(); case "getParameterMode": return ParameterMetaData.parameterModeIn;
                case "isNullable": return ParameterMetaData.parameterNullableUnknown; case "getPrecision": case "getScale": return 0; case "isSigned": return false;
                default: throw unsupported(n);
                }
            }
        }.create(ParameterMetaData.class);
    }
    void resultClosed(JdbcResultSet r) throws SQLException { if (result == r && closeOnCompletion && !closed) close(); }
    private void closeResult() throws SQLException { if (result != null) { JdbcResultSet old = result; result = null; old.close(); } }
    void close() throws SQLException { if (closed) return; closed = true; try { closeResult(); } finally { batches.clear(); connection.statements.remove(this); } }
    private static final class Batch { final String sql; final List<Object> params; Batch(String sql, List<Object> params) { this.sql = sql; this.params = params; } }
    static List<String> tokens(String sql) throws SQLException {
        if (sql == null) throw invalid("SQL is null.");
        List<String> out = new ArrayList<>();
        for (int i = 0; i < sql.length();) {
            char c = sql.charAt(i);
            if (Character.isWhitespace(c)) { i++; continue; }
            if (c == '-' && i + 1 < sql.length() && sql.charAt(i + 1) == '-') { i += 2; while (i < sql.length() && sql.charAt(i) != '\n') i++; continue; }
            if (c == '/' && i + 1 < sql.length() && sql.charAt(i + 1) == '*') { int end = sql.indexOf("*/", i + 2); if (end < 0) throw new SQLException("Unterminated SQL comment.", "42000"); i = end + 2; continue; }
            if (c == '\'' || c == '"') {
                char quote = c; StringBuilder token = new StringBuilder(); i++; boolean ended = false;
                while (i < sql.length()) { c = sql.charAt(i++); if (c == quote) { if (i < sql.length() && sql.charAt(i) == quote) { i++; token.append(c); } else { ended = true; break; } } else token.append(c); }
                if (!ended) throw new SQLException("Unterminated SQL literal or identifier.", "42000"); out.add(quote == '\'' ? "'" : "\"" + token); continue;
            }
            if (Character.isLetterOrDigit(c) || c == '_') { int start = i++; while (i < sql.length() && (Character.isLetterOrDigit(sql.charAt(i)) || "_$".indexOf(sql.charAt(i)) >= 0)) i++; out.add(sql.substring(start, i).toUpperCase(Locale.ROOT)); }
            else { out.add(String.valueOf(c)); i++; }
        }
        return out;
    }
}
