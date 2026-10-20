package org.duckdns.hjow.helloworlddb.jdbc6;

import java.io.*;
import java.lang.reflect.Method;
import java.math.*;
import java.sql.*;
import java.util.*;
import org.duckdns.hjow.helloworlddb.jdbc6.protocol.Protocol;

/** 서버가 준비 문장을 저장하지 않으므로 SQL과 바인딩 값을 실행 시 함께 보낸다.
 *
 * <p>{@code Statement}와 {@code PreparedStatement}를 하나의 클래스로 구현한다.
 * 준비 문장의 SQL과 물음표 바인딩 값은 클라이언트에 보관하고, 실행할 때마다
 * SQL과 바인딩 값을 함께 서버에 보낸다. 조회 결과는 fetch 단위로 나눠 받는다.</p> */
final class JdbcStatement extends JdbcProxy {
    /** 이 문장이 속한 연결. */
    final JdbcConnection connection;
    /** 준비 문장의 SQL. 일반 문장은 {@code null}이다. */
    final String sql;
    /** 커서 유지 방식. */
    final int holdability;
    /** 물음표 자리에 바인딩된 값. */
    private final Object[] params;
    /** 자리마다 값이 묶였는지 여부. */
    private final boolean[] bound;
    /** 배치 실행에 쌓아 둔 SQL과 바인딩 값 목록. */
    private final List<Batch> batches = new ArrayList<Batch>();
    /** 현재 열린 조회 결과. 없으면 {@code null}이다. */
    private JdbcResultSet result;
    /** 닫힘 여부, 완료 시 자동 닫기, 풀 가능 여부, 가져오기 크기, 질의 제한 시간, 마지막 변경 행 수, 행 수 상한. */
    private boolean closed, closeOnCompletion, poolable; private int fetchSize, timeout; private long updateCount = -1, maxRows;
    /** 연결과 SQL 종류에 맞는 문장 프록시를 만든다.
     *
     * @param c 이 문장이 속한 연결
     * @param sql 준비 문장의 SQL. 일반 문장은 {@code null}이다
     * @param hold 커서 유지 방식
     * @return 일반 문장이면 {@link java.sql.Statement}, 준비 문장이면 {@link java.sql.PreparedStatement} 프록시
     * @throws SQLException 문장을 만들 수 없는 경우 */
    static Statement open(JdbcConnection c, String sql, int hold) throws SQLException {
        if (sql == null) { JdbcStatement s = new JdbcStatement(c, null, hold); return s.create(Statement.class); }
        JdbcStatement s = new JdbcStatement(c, sql, hold); return s.create(PreparedStatement.class);
    }
    /** 문장의 내부 상태를 만들고 바인딩 자리 개수를 센다.
     *
     * @param c 이 문장이 속한 연결
     * @param sql 준비 문장의 SQL. 일반 문장은 {@code null}이다
     * @param hold 커서 유지 방식
     * @throws SQLException 바인딩 자리 개수가 한도를 넘는 경우 */
    private JdbcStatement(JdbcConnection c, String sql, int hold) throws SQLException {
        connection = c; this.sql = sql; holdability = hold; fetchSize = c.options.fetchSize;
        int count = 0; if (sql != null) for (String token : tokens(sql)) if (token.equals("?")) count++;
        if (count > 65535) throw invalid("Too many parameters."); params = new Object[count]; bound = new boolean[count]; c.statements.add(this);
    }
    /** 문장이 닫히지 않았는지 확인한다.
     *
     * @throws SQLException 문장이 닫혔거나 연결이 끊긴 경우 */
    private void check() throws SQLException { connection.check(); if (closed) throw new SQLException("Statement is closed.", "HY010"); }
    /** 프록시로 들어온 {@link java.sql.Statement}·{@link java.sql.PreparedStatement} 호출을 처리한다.
     *
     * <p>실행, 바인딩, 배치, 가져오기 크기·제한 시간·행 수 상한 같은 문장 속성과
     * 결과·경고 조회를 처리한다. 서버가 다중 결과 집합을 지원하지 않으므로
     * 결과는 최대 하나만 유지된다.</p>
     *
     * @param n 호출된 메서드 이름
     * @param a 호출 인자
     * @param method 호출된 메서드 객체
     * @return 호출 결과
     * @throws Exception 문장이 닫혔거나 인자가 잘못되었거나 지원하지 않는 호출인 경우 */
    @Override synchronized Object call(String n, Object[] a, Method method) throws Exception {
        if (n.equals("close")) { close(); return null; }
        if (n.equals("isClosed")) return closed || connection.protocol.isClosed();
        check();
        if (n.equals("execute") || n.equals("executeQuery") || n.equals("executeUpdate") || n.equals("executeLargeUpdate")) {
            String text; List<Object> values;
            if (sql != null) { if (a.length != 0) throw new SQLException("SQL must not be supplied to a PreparedStatement.", "HY010"); text = sql; values = parameters(); }
            else {
                if (a.length == 0 || !(a[0] instanceof String)) throw invalid("SQL is required."); text = (String) a[0]; values = Collections.<Object>emptyList();
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
        if (n.equals("getConnection")) { return connection.proxy; }
        else if (n.equals("getResultSet")) { return result == null ? null : result.proxy; }
        else if (n.equals("getUpdateCount")) { return count(updateCount); }
        else if (n.equals("getLargeUpdateCount")) { return updateCount; }
        else if (n.equals("getMoreResults")) { if (a.length > 0 && (Integer) a[0] == Statement.KEEP_CURRENT_RESULT) throw unsupported("Multiple open results per Statement");
            if (a.length > 0 && (Integer) a[0] != Statement.CLOSE_CURRENT_RESULT && (Integer) a[0] != Statement.CLOSE_ALL_RESULTS) throw invalid("Invalid result disposition.");
            closeResult(); updateCount = -1; return false; }
        else if (n.equals("setFetchSize")) { { int size = (Integer) a[0]; if (size < 0 || size > 100000) throw invalid("Invalid fetch size."); fetchSize = size == 0 ? connection.options.fetchSize : size; return null; } }
        else if (n.equals("getFetchSize")) { return fetchSize; }
        else if (n.equals("setFetchDirection")) { if ((Integer) a[0] != ResultSet.FETCH_FORWARD) throw unsupported("Fetch direction"); return null; }
        else if (n.equals("getFetchDirection")) { return ResultSet.FETCH_FORWARD; }
        else if (n.equals("setQueryTimeout")) { if ((Integer) a[0] < 0) throw invalid("Invalid query timeout."); timeout = (Integer) a[0]; return null; }
        else if (n.equals("getQueryTimeout")) { return timeout; }
        else if (n.equals("setMaxRows") || n.equals("setLargeMaxRows")) { { long limit = ((Number) a[0]).longValue(); if (limit < 0) throw invalid("Invalid row limit."); maxRows = limit; return null; } }
        else if (n.equals("getMaxRows")) { return count(maxRows); }
        else if (n.equals("getLargeMaxRows")) { return maxRows; }
        else if (n.equals("getResultSetType")) { return ResultSet.TYPE_FORWARD_ONLY; }
        else if (n.equals("getResultSetConcurrency")) { return ResultSet.CONCUR_READ_ONLY; }
        else if (n.equals("getResultSetHoldability")) { return holdability; }
        else if (n.equals("getWarnings") || n.equals("clearWarnings")) { return null; }
        else if (n.equals("setPoolable")) { poolable = (Boolean) a[0]; return null; }
        else if (n.equals("isPoolable")) { return poolable; }
        else if (n.equals("closeOnCompletion")) { closeOnCompletion = true; return null; }
        else if (n.equals("isCloseOnCompletion")) { return closeOnCompletion; }
        else if (n.equals("getMaxFieldSize")) { return 0; }
        else if (n.equals("setMaxFieldSize")) { if ((Integer) a[0] != 0) throw unsupported("Field truncation"); return null; }
        else if (n.equals("setEscapeProcessing")) { if ((Boolean) a[0]) throw unsupported("JDBC escape processing"); return null; }
        else if (n.equals("clearParameters")) { requirePrepared(); Arrays.fill(params, null); Arrays.fill(bound, false); return null; }
        else if (n.equals("getParameterMetaData")) { requirePrepared(); return parameterMetaData(); }
        else if (n.equals("getMetaData")) { requirePrepared(); return result == null ? null : result.metadata(); }
        else if (n.equals("addBatch")) { if (sql != null) { if (a.length != 0) throw new SQLException("SQL must not be supplied to a PreparedStatement.", "HY010"); batches.add(new Batch(sql, parameters())); }
            else { if (a.length != 1 || !(a[0] instanceof String)) throw invalid("SQL is required."); batches.add(new Batch((String) a[0], Collections.<Object>emptyList())); }
            return null; }
        else if (n.equals("clearBatch")) { batches.clear(); return null; }
        else if (n.equals("executeBatch") || n.equals("executeLargeBatch")) { {
            long[] counts = new long[batches.size()]; int completed = 0;
            try { for (Batch b : batches) { execute(b.sql, b.params); if (result != null) { closeResult(); throw new SQLException("Batch statement returned rows.", "HY000"); } counts[completed++] = updateCount; } }
            catch (SQLException e) {
                int[] c = new int[completed]; for (int i = 0; i < completed; i++) c[i] = count(counts[i]); throw new BatchUpdateException(e.getMessage(), e.getSQLState(), e.getErrorCode(), c, e);
            } finally { batches.clear(); }
            if (n.equals("executeLargeBatch")) return counts;
            int[] c = new int[counts.length]; for (int i = 0; i < c.length; i++) c[i] = count(counts[i]); return c;
        } }
        else {  throw unsupported(n); }
    }
    /** 준비 문장 전용 동작임을 확인한다.
     *
     * @throws SQLException 일반 문장에 준비 문장 전용 동작을 호출한 경우 */
    private void requirePrepared() throws SQLException { if (sql == null) throw new SQLException("Not a PreparedStatement.", "HY010"); }
    /** 변경 행 수를 {@code int} 범위로 바꾼다. 범위를 넘으면 성공 미확인 값을 쓴다.
     *
     * @param count 서버가 보고한 변경 행 수
     * @return {@code int} 범위의 행 수. 범위를 넘으면 {@code SUCCESS_NO_INFO}이다 */
    private static int count(long count) { return count > Integer.MAX_VALUE ? Statement.SUCCESS_NO_INFO : (int) count; }
    /** SQL과 바인딩 값을 서버에 보내 실행하고 결과를 보관한다.
     *
     * @param text 실행할 SQL 문장
     * @param values 물음표 자리에 바인딩할 값 목록
     * @throws SQLException 실행에 실패한 경우 */
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
    /** 묶인 바인딩 값을 실행 순서대로 모은 목록을 돌려준다.
     *
     * @return 바인딩된 값 목록
     * @throws SQLException 묶지 않은 자리가 있는 경우 */
    private List<Object> parameters() throws SQLException {
        List<Object> values = new ArrayList<Object>(params.length);
        for (int i = 0; i < params.length; i++) { if (!bound[i]) throw new SQLException("Parameter " + (i + 1) + " is not bound.", "07001"); values.add(params[i]); }
        return values;
    }
    /** 주어진 메서드 이름이 바인딩 setter인지 확인한다.
     *
     * @param n 확인할 메서드 이름
     * @return 바인딩 setter이면 {@code true} */
    private static boolean isParameterSetter(String n) {
        return Arrays.asList("setNull", "setBoolean", "setByte", "setShort", "setInt", "setLong", "setFloat", "setDouble", "setBigDecimal", "setString", "setNString", "setBytes", "setDate", "setTime", "setTimestamp", "setObject", "setAsciiStream", "setBinaryStream", "setCharacterStream", "setNCharacterStream").contains(n);
    }
    /** 바인딩 setter 호출을 물음표 자리 값으로 바꾼다.
     *
     * <p>{@code setNull}은 {@code null}로, {@code setObject}의 목표 타입 지정은
     * {@link Values#target}으로, 달력이 있는 날짜시간 setter는
     * {@link Values#calendarValue}로, 스트림 setter는 내용을 모두 읽어
     * 문자열이나 바이트 배열로 바꾼 뒤 서버 전송 형태로 인코딩한다.</p>
     *
     * @param n 호출된 setter 이름
     * @param a 호출 인자(인덱스, 값, 달력 또는 길이 등)
     * @throws Exception 인덱스가 잘못되었거나 값을 바꿀 수 없는 경우 */
    private void bind(String n, Object[] a) throws Exception {
        int index = (Integer) a[0] - 1; if (index < 0 || index >= params.length) throw new SQLException("Invalid parameter index.", "07009");
        Object value = a[1];
        if (n.equals("setNull")) value = null;
        else if (n.equals("setObject") && a.length >= 3) {
            if (a[2] == null) throw invalid("SQL type is null.");
            if (!(a[2] instanceof Integer)) throw unsupported("JDBC 4.2 SQLType");
            Integer target = (Integer) a[2];
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
    /** 준비 문장의 바인딩 자리 정보를 담은 메타데이터를 만든다.
     *
     * <p>서버가 실행 전에는 자리 타입을 알려주지 않으므로(describe 미지원),
     * 자릿수와 입력 전용 모드만 보고하고 타입은 {@code OTHER}·{@code UNKNOWN}으로 둔다.</p>
     *
     * @return 바인딩 자리 메타데이터 프록시 */
    private ParameterMetaData parameterMetaData() {
        return new JdbcProxy() {
            /** 바인딩 자리 메타데이터 호출을 처리한다.
             *
             * @param n 호출된 메서드 이름
             * @param a 호출 인자
             * @param m 호출된 메서드 객체
             * @return 호출 결과
             * @throws SQLException 문장이 닫혔거나 인덱스가 잘못된 경우 */
            @Override Object call(String n, Object[] a, Method m) throws SQLException {
                check(); if (n.equals("getParameterCount")) return params.length;
                int index = (Integer) a[0]; if (index < 1 || index > params.length) throw new SQLException("Invalid parameter index.", "07009");
                if (n.equals("getParameterType")) { return Types.OTHER; }
        else if (n.equals("getParameterTypeName")) { return "UNKNOWN"; }
        else if (n.equals("getParameterClassName")) { return Object.class.getName(); }
        else if (n.equals("getParameterMode")) { return ParameterMetaData.parameterModeIn; }
        else if (n.equals("isNullable")) { return ParameterMetaData.parameterNullableUnknown; }
        else if (n.equals("getPrecision") || n.equals("getScale")) { return 0; }
        else if (n.equals("isSigned")) { return false; }
        else {  throw unsupported(n); }
            }
        }.create(ParameterMetaData.class);
    }
    /** 결과 집합이 닫혔음을 문장에 알린다. 완료 시 자동 닫기가 켜져 있으면 문장도 닫는다.
     *
     * @param r 닫힌 결과 집합
     * @throws SQLException 문장을 닫는 중에 오류가 발생한 경우 */
    void resultClosed(JdbcResultSet r) throws SQLException { if (result == r && closeOnCompletion && !closed) close(); }
    /** 현재 열린 결과 집합이 있으면 닫고 참조를 비운다.
     *
     * @throws SQLException 결과 집합을 닫는 중에 오류가 발생한 경우 */
    private void closeResult() throws SQLException { if (result != null) { JdbcResultSet old = result; result = null; old.close(); } }
    /** 문장을 닫는다. 열린 결과와 쌓인 배치를 함께 정리한다.
     *
     * @throws SQLException 결과 집합을 닫는 중에 오류가 발생한 경우 */
    void close() throws SQLException { if (closed) return; closed = true; try { closeResult(); } finally { batches.clear(); connection.statements.remove(this); } }
    /** 배치 실행에 쌓아 두는 SQL 한 건과 바인딩 값 묶음. */
    private static final class Batch {
        /** 실행할 SQL 문장. */
        final String sql;
        /** 물음표 자리에 바인딩할 값 목록. */
        final List<Object> params;
        /** 배치 항목을 만든다.
         *
         * @param sql 실행할 SQL 문장
         * @param params 바인딩할 값 목록 */
        Batch(String sql, List<Object> params) { this.sql = sql; this.params = params; } }
    /** SQL 문장을 토큰 목록으로 나눈다.
     *
     * <p>주석과 문자열·식별자 리터럴을 건너뛰고, 일반 단어는 대문자로 통일한다.
     * 문장의 첫 단어를 보고 트랜잭션 종료 여부를 판단하는 데 쓴다.</p>
     *
     * @param sql 나눌 SQL 문장
     * @return 토큰 목록
     * @throws SQLException SQL이 {@code null}이거나 주석·리터럴이 끝나지 않은 경우 */
    static List<String> tokens(String sql) throws SQLException {
        if (sql == null) throw invalid("SQL is null.");
        List<String> out = new ArrayList<String>();
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
