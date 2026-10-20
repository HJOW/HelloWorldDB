package org.duckdns.hjow.helloworlddb.jdbc8;

import java.io.*;
import java.lang.reflect.Method;
import java.math.*;
import java.sql.*;
import java.util.*;
import org.duckdns.hjow.helloworlddb.jdbc8.protocol.Protocol;

/**
 * 서버가 준비 문장을 저장하지 않으므로 SQL과 바인딩 값을 실행 시 함께 보내는 문장이다.
 * <p>{@link Statement}와 {@link PreparedStatement}를 모두 구현하며,
 * {@code ?} 자리 표시자의 개수를 생성 시점에 세어 바인딩 여부를 추적한다.
 * 실행할 때마다 이전 결과는 닫고, 서버 응답이 행 묶음이면 결과 집합을,
 * 완료 응답이면 영향 행 수를 보관한다.</p>
 */
final class JdbcStatement extends JdbcProxy {
    /** 소속 연결이다. */
    final JdbcConnection connection;
    /** 준비 문장의 SQL이다. 일반 문장이면 {@code null}이다. */
    final String sql;
    /** 결과 집합 홀드빌리티이다. */
    final int holdability;
    /** 자리 표시자에 인코딩된 바인딩 값이다. */
    private final Object[] params;
    /** 자리 표시자별 바인딩 여부이다. */
    private final boolean[] bound;
    /** 배치 실행을 위해 쌓아 둔 문장 목록이다. */
    private final List<Batch> batches = new ArrayList<>();
    /** 현재 열린 결과 집합이다. 없으면 {@code null}이다. */
    private JdbcResultSet result;
    /** 닫힌 뒤에는 요청을 거부하기 위한 표시이다. */
    private boolean closed;
    /** 결과 집합이 닫히면 문장도 닫을지 여부이다. */
    private boolean closeOnCompletion;
    /** 풀에서 재사용할 수 있다는 힌트이다. */
    private boolean poolable;
    /** 조회 결과의 묶음 크기이다. */
    private int fetchSize;
    /** 문장 단위 실행 제한 시간(초)이다. 0이면 제한이 없다. */
    private int timeout;
    /** 마지막 변경 문장의 영향 행 수이다. 조회 뒤에는 -1이다. */
    private long updateCount = -1;
    /** 조회 결과의 최대 행 수이다. 0이면 제한이 없다. */
    private long maxRows;
    /**
     * 문장 프록시를 연다.
     *
     * @param c 소속 연결
     * @param sql 준비 문장의 SQL. 일반 문장이면 {@code null}이다
     * @param hold 결과 집합 홀드빌리티
     * @return 일반 문장이면 {@link Statement}, 준비 문장이면 {@link PreparedStatement} 프록시
     * @throws SQLException 문장 생성 실패 시
     */
    static Statement open(JdbcConnection c, String sql, int hold) throws SQLException {
        if (sql == null) { JdbcStatement s = new JdbcStatement(c, null, hold); return s.create(Statement.class); }
        JdbcStatement s = new JdbcStatement(c, sql, hold); return s.create(PreparedStatement.class);
    }
    /**
     * 문장 객체를 생성한다.
     * <p>준비 문장의 {@code ?} 개수를 세고 바인딩 배열을 준비한 뒤 연결의 추적 집합에 등록한다.</p>
     *
     * @param c 소속 연결
     * @param sql 준비 문장의 SQL. 일반 문장이면 {@code null}이다
     * @param hold 결과 집합 홀드빌리티
     * @throws SQLException 자리 표시자가 너무 많을 때
     */
    private JdbcStatement(JdbcConnection c, String sql, int hold) throws SQLException {
        connection = c; this.sql = sql; holdability = hold; fetchSize = c.options.fetchSize;
        int count = 0; if (sql != null) for (String token : tokens(sql)) if (token.equals("?")) count++;
        if (count > 65535) throw invalid("Too many parameters."); params = new Object[count]; bound = new boolean[count]; c.statements.add(this);
    }
    /**
     * 문장이 사용 가능한 상태인지 확인한다.
     *
     * @throws SQLException 연결이 닫혔거나 문장이 닫혔을 때
     */
    private void check() throws SQLException { connection.check(); if (closed) throw new SQLException("Statement is closed.", "HY010"); }
    /**
     * {@link Statement}·{@link PreparedStatement} 메서드 호출을 처리한다.
     * <p>실행·배치·파라미터 바인딩·fetch 크기·최대 행 수·결과 조회 등을 구현하며,
     * 준비 문장에 SQL을 직접 넘기거나 지원하지 않는 옵션을 쓰면 오류를 낸다.</p>
     *
     * @param n 호출된 메서드 이름
     * @param a 호출 인자
     * @param method 호출된 메서드 리플렉션 정보
     * @return 메서드 반환 값
     * @throws Exception 잘못된 인자, 상태 위반, 서버 오류 시
     */
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
    /**
     * 준비 문장 전용 기능의 사용 자격을 확인한다.
     *
     * @throws SQLException 일반 문장에서 호출했을 때
     */
    private void requirePrepared() throws SQLException { if (sql == null) throw new SQLException("Not a PreparedStatement.", "HY010"); }
    /**
     * 영향 행 수를 JDBC 반환 범위로 접는다.
     *
     * @param count 실제 영향 행 수
     * @return int 범위를 넘으면 {@code SUCCESS_NO_INFO}, 아니면 같은 값
     */
    private static int count(long count) { return count > Integer.MAX_VALUE ? Statement.SUCCESS_NO_INFO : (int) count; }
    /**
     * 문장을 실행하고 결과 집합이나 영향 행 수를 보관한다.
     * <p>문장 제한 시간이 있으면 그 동안만 프로토콜 제한 시간을 바꾸고,
     * 실행 전에는 이전 결과를 닫는다.</p>
     *
     * @param text 실행할 SQL 문장
     * @param values 바인딩된 파라미터 값 목록
     * @throws SQLException 서버 오류 시
     */
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
    /**
     * 바인딩된 파라미터 값 목록을 반환한다.
     *
     * @return 인코딩된 파라미터 값 목록
     * @throws SQLException 바인딩하지 않은 자리가 있을 때
     */
    private List<Object> parameters() throws SQLException {
        List<Object> values = new ArrayList<>(params.length);
        for (int i = 0; i < params.length; i++) { if (!bound[i]) throw new SQLException("Parameter " + (i + 1) + " is not bound.", "07001"); values.add(params[i]); }
        return values;
    }
    /**
     * 준비 문장의 파라미터 설정 메서드인지 확인한다.
     *
     * @param n 메서드 이름
     * @return 설정 메서드이면 {@code true}
     */
    private static boolean isParameterSetter(String n) {
        return Arrays.asList("setNull", "setBoolean", "setByte", "setShort", "setInt", "setLong", "setFloat", "setDouble", "setBigDecimal", "setString", "setNString", "setBytes", "setDate", "setTime", "setTimestamp", "setObject", "setAsciiStream", "setBinaryStream", "setCharacterStream", "setNCharacterStream").contains(n);
    }
    /**
     * 자리 표시자 하나에 값을 바인딩한다.
     * <p>{@code setNull}, {@code setObject}(SQLType 포함), 달력 인자가 있는 날짜시간,
     * 스트림 종류를 처리한 뒤 서버 전송용 값으로 인코딩한다.</p>
     *
     * @param n 호출된 설정 메서드 이름
     * @param a 호출 인자. 첫 인자는 1부터 시작하는 자리 번호이다
     * @throws Exception 잘못된 자리 번호, 스트림 길이 위반, 변환 실패 시
     */
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
    /**
     * 준비 문장의 파라미터 메타데이터를 생성한다.
     * <p>서버가 자리 표시자의 타입 정보를 제공하지 않으므로 개수만 정확하고,
     * 나머지는 알 수 없음으로 보고한다.</p>
     *
     * @return 파라미터 메타데이터 프록시
     */
    private ParameterMetaData parameterMetaData() {
        return new JdbcProxy() {
            /**
             * 파라미터 메타데이터 메서드 호출을 처리한다.
             *
             * @param n 호출된 메서드 이름
             * @param a 호출 인자
             * @param m 호출된 메서드 리플렉션 정보
             * @return 메서드 반환 값
             * @throws SQLException 잘못된 자리 번호나 미지원 항목 조회 시
             */
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
    /**
     * 결과 집합이 닫혔음을 통지받는다.
     * <p>완료 시 닫기 설정이 켜져 있으면 문장도 함께 닫는다.</p>
     *
     * @param r 닫힌 결과 집합
     * @throws SQLException 문장을 닫는 중 오류가 났을 때
     */
    void resultClosed(JdbcResultSet r) throws SQLException { if (result == r && closeOnCompletion && !closed) close(); }
    /**
     * 현재 결과 집합을 닫고 참조를 비운다.
     *
     * @throws SQLException 결과 집합을 닫는 중 오류가 났을 때
     */
    private void closeResult() throws SQLException { if (result != null) { JdbcResultSet old = result; result = null; old.close(); } }
    /**
     * 배치 목록을 비우고 연결의 추적 집합에서 제거한 뒤 문장을 닫는다.
     *
     * @throws SQLException 현재 결과를 닫는 중 오류가 났을 때
     */
    void close() throws SQLException { if (closed) return; closed = true; try { closeResult(); } finally { batches.clear(); connection.statements.remove(this); } }
    /**
     * 배치 실행을 위해 쌓아 두는 문장 한 개이다.
     */
    private static final class Batch {
        /** 실행할 SQL 문장이다. */
        final String sql;
        /** 바인딩된 파라미터 값 목록이다. */
        final List<Object> params;
        /**
         * 배치 항목을 생성한다.
         *
         * @param sql 실행할 SQL 문장
         * @param params 바인딩된 파라미터 값 목록
         */
        Batch(String sql, List<Object> params) { this.sql = sql; this.params = params; }
    }
    /**
     * SQL을 토큰 목록으로 나눈다.
     * <p>주석과 문자열·인용 식별자를 건너뛰고 키워드 판정에 쓸 대문자 토큰을 만들며,
     * {@code ?} 자리 표시자도 별도 토큰으로 남긴다.</p>
     *
     * @param sql 분석할 SQL 문장
     * @return 대문자화된 키워드·기호 토큰 목록
     * @throws SQLException SQL이 {@code null}이거나 주석·리터럴이 닫히지 않았을 때
     */
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
