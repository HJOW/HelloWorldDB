package org.duckdns.hjow.helloworlddb.jdbc6;

import java.io.*;
import java.lang.reflect.Method;
import java.math.*;
import java.sql.*;
import java.util.*;
import org.duckdns.hjow.helloworlddb.jdbc6.protocol.Protocol;

/** 서버 선택 기능에 따라 준비 문장·실행 전 메타데이터와 요청별 취소를 제공한다.
 *
 * <p>{@code Statement}와 {@code PreparedStatement}를 하나의 클래스로 구현한다.
 * 기능 없는 서버에는 기존 SQL 실행을 유지하며 조회 결과는 fetch 단위로 나눠 받는다.</p> */
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
    /** 서버 준비 문장 ID와 미정 파라미터의 선택적 타입 힌트이다. */
    private final Long prepared;
    private final Object[] hints;
    private final boolean[] inferred;
    private List<Object> appliedHints;
    private volatile Active active;
    /** 배치 실행에 쌓아 둔 SQL과 바인딩 값 목록. */
    private final List<Batch> batches = new ArrayList<Batch>();
    /** 현재 열린 조회 결과. 없으면 {@code null}이다. */
    private JdbcResultSet result;
    /** 닫힘 여부, 완료 시 자동 닫기, 풀 가능 여부, 가져오기 크기, 질의 제한 시간, 마지막 변경 행 수, 행 수 상한. */
    private volatile boolean closed, closing;
    private boolean closeOnCompletion, poolable; private int fetchSize, timeout; private long updateCount = -1, maxRows;
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
        if (count > 65535) throw invalid("Too many parameters.");
        Map<String, Object> description = sql != null && c.protocol.supports("prepareDescribe") ? c.protocol.prepare(sql) : null;
        try {
            prepared = description == null ? null : Long.valueOf(Protocol.number(description, "statement"));
            if (description != null && Protocol.number(description, "parameterCount") != count) throw new IOException("Parameter count mismatch.");
            params = new Object[count]; bound = new boolean[count]; hints = new Object[count]; inferred = new boolean[count];
            if (description != null) {
                List<Object> parameters = Protocol.list(description.get("parameters"));
                if (parameters.size() != count) throw new IOException("Invalid parameter description.");
                for (int i = 0; i < count; i++) inferred[i] = !"UNKNOWN".equals(Protocol.map(parameters.get(i)).get("typeName"));
            }
        } catch (IOException e) { throw new SQLException(e.getMessage(), "08006", 8006, e); }
        c.statements.add(this);
    }
    /** 문장이 닫히지 않았는지 확인한다.
     *
     * @throws SQLException 문장이 닫혔거나 연결이 끊긴 경우 */
    private void check() throws SQLException { connection.check(); if (closed || closing) throw new SQLException("Statement is closed.", "HY010"); }
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
    @Override Object call(String n, Object[] a, Method method) throws Exception {
        if (n.equals("cancel")) { check(); Active running = active; connection.protocol.cancel(running == null ? null : running.request); return null; }
        if (n.equals("close")) { close(); return null; }
        synchronized (this) { return callLocked(n, a, method); }
    }
    /** 취소를 제외한 문장 호출은 순서대로 처리한다. */
    private Object callLocked(String n, Object[] a, Method method) throws Exception {
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
        // int 로 된 행 수 제한은 넘치면 Integer.MAX_VALUE 로 포화한다. (SUCCESS_NO_INFO 는 갱신 개수 전용이다. J-3)
        else if (n.equals("getMaxRows")) { return maxRows > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) maxRows; }
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
        else if (n.equals("clearParameters")) { requirePrepared(); Arrays.fill(params, null); Arrays.fill(bound, false); Arrays.fill(hints, null); return null; }
        else if (n.equals("getParameterMetaData")) { requirePrepared(); return parameterMetaData(); }
        else if (n.equals("getMetaData")) { requirePrepared();
            if (prepared == null) return result == null ? null : result.metadata();
            Map<String, Object> description = description(Arrays.asList(hints.clone()));
            return "rows".equals(description.get("resultKind")) ? JdbcResultSet.metadata(columns(description, "columns")) : null;
        }
        else if (n.equals("addBatch")) { if (sql != null) { if (a.length != 0) throw new SQLException("SQL must not be supplied to a PreparedStatement.", "HY010"); batches.add(new Batch(sql, parameters(), Arrays.asList(hints.clone()))); }
            else { if (a.length != 1 || !(a[0] instanceof String)) throw invalid("SQL is required."); batches.add(new Batch((String) a[0], Collections.<Object>emptyList(), null)); }
            return null; }
        else if (n.equals("clearBatch")) { batches.clear(); return null; }
        else if (n.equals("executeBatch") || n.equals("executeLargeBatch")) { {
            long[] counts = new long[batches.size()]; int completed = 0;
            try { for (Batch b : batches) { execute(b.sql, b.params, b.hints); if (result != null) { closeResult(); throw new SQLException("Batch statement returned rows.", "HY000"); } counts[completed++] = updateCount; } }
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
        execute(text, values, Arrays.asList(hints.clone()));
    }
    /** 실행 요청별 상태를 보관하고 제한 시간은 연결 종료 대신 서버 취소로 처리한다. */
    private void execute(String text, List<Object> values, List<Object> typeHints) throws SQLException {
        closeResult(); updateCount = -1;
        Map<String, Object> r;
        synchronized (connection.protocol) {
            if (timeout > 0 && !connection.protocol.supports("cancel")) throw unsupported("Server query timeout");
            if (prepared != null && !typeHints.equals(appliedHints)) description(typeHints);
            if (closing) throw new SQLException("Statement is closed.", "HY010");
            final Active running = new Active(connection.protocol.startExecute(text, prepared, values, fetchSize));
            active = running;
            Timer timer = timeout > 0 ? new Timer("hwdb-query-timeout", true) : null;
            if (timer != null) timer.schedule(new TimerTask() { public void run() {
                if (active != running || running.request.isDone()) return;
                running.timedOut = true;
                try { connection.protocol.cancel(running.request); } catch (SQLException ignored) { }
            } }, timeout * 1000L);
            try {
                if (closing && connection.protocol.supports("cancel")) connection.protocol.cancel(running.request);
                r = connection.protocol.finishExecute(running.request); connection.executed(text);
            } catch (SQLException e) {
                if (running.timedOut && "57014".equals(e.getSQLState())) throw new SQLTimeoutException(e.getMessage(), e.getSQLState(), e.getErrorCode(), e);
                throw e;
            } finally { if (timer != null) timer.cancel(); active = null; }
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
            Integer target = typeNumber(a[2]);
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
        if (!inferred[index]) hints[index] = hint(n, a, value);
    }
    /**
     * 타입 번호 또는 JDBC 4.2 의 {@code SQLType} 에서 타입 번호를 읽는다. (J-1)
     * jdbc6 은 Java 6 에서 컴파일되어 {@code java.sql.SQLType} 을 직접 참조할 수 없으므로, 그 객체의 {@code getVendorTypeNumber} 를 리플렉션으로 부른다.
     *
     * @param supplied 호출 인자. {@code Integer} 또는 {@code SQLType} 이어야 한다
     * @return 타입 번호. 알 수 없으면 {@code null}
     * @throws SQLException 타입 번호를 읽을 수 없는 객체일 때 (0A000)
     */
    static Integer typeNumber(Object supplied) throws SQLException {
        if (supplied == null || supplied instanceof Integer) return (Integer) supplied;
        try {
            return (Integer) supplied.getClass().getMethod("getVendorTypeNumber").invoke(supplied);
        } catch (Exception e) {
            throw JdbcProxy.unsupported("JDBC 4.2 SQLType");
        }
    }

    /** 타입을 모르는 자리만 JDBC 바인딩 문맥으로 보완한다. 알려진 컬럼 문맥은 바꾸지 않는다. */
    private static String hint(String setter, Object[] args, Object value) throws SQLException {
        if (value instanceof BigDecimal && ((BigDecimal) value).scale() > 38) throw new SQLDataException("Decimal scale exceeds the server limit.", "22003");
        int type = Types.OTHER;
        if (setter.equals("setNull") || (setter.equals("setObject") && args.length >= 3)) {
            Integer number = typeNumber(args[setter.equals("setNull") ? 1 : 2]);
            if (number == null) throw JdbcProxy.unsupported("Unknown SQLType");
            type = number.intValue();
        }
        else if (value instanceof Byte || value instanceof Short) type = Types.SMALLINT;
        else if (value instanceof Integer) type = Types.INTEGER;
        else if (value instanceof Long || value instanceof BigInteger) type = Types.BIGINT;
        else if (value instanceof BigDecimal) {
            BigDecimal number = (BigDecimal) value; int scale = Math.max(0, Math.min(38, number.scale()));
            return "DECIMAL(38," + scale + ")";
        }
        else if (value instanceof Float) type = Types.REAL;
        else if (value instanceof Double) type = Types.DOUBLE;
        else if (value instanceof Boolean) type = Types.BOOLEAN;
        else if (value instanceof String) type = Types.VARCHAR;
        else if (value instanceof byte[]) type = Types.VARBINARY;
        else if (value instanceof Timestamp) type = Types.TIMESTAMP;
        else if (value instanceof Time) type = Types.TIME;
        else if (value instanceof java.sql.Date) type = Types.DATE;
        switch (type) {
        case Types.TINYINT: case Types.SMALLINT: return "SMALLINT"; case Types.INTEGER: return "INTEGER"; case Types.BIGINT: return "BIGINT";
        case Types.NUMERIC: case Types.DECIMAL: return "DECIMAL(38," + (value instanceof BigDecimal ? Math.max(0, Math.min(38, ((BigDecimal) value).scale())) : 0) + ")";
        case Types.FLOAT: case Types.DOUBLE: return "DOUBLE PRECISION"; case Types.REAL: return "REAL";
        case Types.BIT: case Types.BOOLEAN: return "BOOLEAN";
        case Types.CHAR: case Types.NCHAR: case Types.VARCHAR: case Types.NVARCHAR: case Types.LONGVARCHAR: case Types.LONGNVARCHAR: return "VARCHAR";
        case Types.BINARY: case Types.VARBINARY: case Types.LONGVARBINARY: return "VARBINARY";
        case Types.DATE: return "DATE"; case Types.TIME: return "TIME(6)"; case Types.TIMESTAMP: return "TIMESTAMP(6)"; default: return null;
        }
    }
    /** 분석에 성공한 힌트만 다음 반복 실행에 재사용한다. */
    private Map<String, Object> description(List<Object> typeHints) throws SQLException {
        Map<String, Object> description = connection.protocol.describe(prepared.longValue(), typeHints);
        appliedHints = new ArrayList<Object>(typeHints); return description;
    }
    /** 검증된 서버 분석 응답을 JDBC 컬럼 설명으로 바꾼다. */
    private static List<Values.Column> columns(Map<String, Object> description, String key) throws SQLException {
        try {
            List<Values.Column> columns = new ArrayList<Values.Column>();
            for (Object value : Protocol.list(description.get(key))) columns.add(new Values.Column(Protocol.map(value)));
            return columns;
        } catch (IOException e) { throw new SQLException(e.getMessage(), "08006", 8006, e); }
    }
    /** 준비 문장의 바인딩 자리 정보를 담은 메타데이터를 만든다.
     *
     * <p>서버의 실행 전 분석을 사용하고 모르는 정보는 OTHER·UNKNOWN으로 보존한다.
     * 선택 기능이 없는 서버에는 기존 자리 개수와 미정 타입을 제공한다.</p>
     *
     * @return 바인딩 자리 메타데이터 프록시 */
    private ParameterMetaData parameterMetaData() throws SQLException {
        final List<Values.Column> types = prepared == null ? null : columns(description(Arrays.asList(hints.clone())), "parameters");
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
                Values.Column type = types == null ? new Values.Column("PARAM" + index, "UNKNOWN") : types.get(index - 1);
                if (n.equals("getParameterType")) { return type.type; }
        else if (n.equals("getParameterTypeName")) { return type.typeName; }
        else if (n.equals("getParameterClassName")) { return "UNKNOWN".equals(type.typeName) ? Object.class.getName() : Values.javaType(type.type).getName(); }
        else if (n.equals("getParameterMode")) { return ParameterMetaData.parameterModeIn; }
        else if (n.equals("isNullable")) { return type.nullable; }
        else if (n.equals("getPrecision")) { return type.precision; }
        else if (n.equals("getScale")) { return type.scale; }
        else if (n.equals("isSigned")) { return Arrays.asList(Types.SMALLINT, Types.INTEGER, Types.BIGINT, Types.NUMERIC, Types.DECIMAL, Types.REAL, Types.DOUBLE).contains(type.type); }
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
    void close() throws SQLException {
        if (closed) return;
        closing = true;
        Active running = active;
        SQLException cancellation = null;
        if (running != null && !running.request.isDone() && connection.protocol.supports("cancel")) {
            try { connection.protocol.cancel(running.request); } catch (SQLException e) { cancellation = e; }
        }
        synchronized (this) {
            if (!closed) {
                closed = true;
                try { closeResult(); }
                finally { try { if (prepared != null && !connection.protocol.isClosed()) connection.protocol.closePrepared(prepared.longValue()); }
                    finally { batches.clear(); connection.statements.remove(this); } }
            }
        }
        if (cancellation != null) throw cancellation;
    }
    /** 늦은 타이머·취소는 이 실행 객체에만 적용한다. */
    private static final class Active {
        final Protocol.Request request;
        volatile boolean timedOut;
        Active(Protocol.Request request) { this.request = request; }
    }
    /** 배치 실행에 쌓아 두는 SQL 한 건과 바인딩 값 묶음. */
    private static final class Batch {
        /** 실행할 SQL 문장. */
        final String sql;
        /** 물음표 자리에 바인딩할 값 목록. */
        final List<Object> params;
        /** 배치를 추가한 시점의 타입 힌트 사본이다. */
        final List<Object> hints;
        /** 배치 항목을 만든다.
         *
         * @param sql 실행할 SQL 문장
         * @param params 바인딩할 값 목록 */
        Batch(String sql, List<Object> params, List<Object> hints) { this.sql = sql; this.params = params; this.hints = hints; } }
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
