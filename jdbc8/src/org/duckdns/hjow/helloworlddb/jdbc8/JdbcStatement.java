package org.duckdns.hjow.helloworlddb.jdbc8;

import java.io.*;
import java.lang.reflect.Method;
import java.math.*;
import java.sql.*;
import java.time.*;
import java.util.*;
import org.duckdns.hjow.helloworlddb.jdbc8.protocol.Protocol;

/**
 * 서버의 선택 기능에 따라 준비 문장·실행 전 분석·요청별 취소를 제공하는 문장이다.
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
    /** 서버 준비 문장과 미정 파라미터의 바인딩 힌트이다. */
    private final Long prepared;
    /** 서버가 추론하지 못한 자리의 선택적 타입 힌트이다. */
    private final Object[] hints;
    /** 컬럼·CAST 문맥으로 이미 타입이 정해진 자리인지 나타낸다. */
    private final boolean[] inferred;
    /** 마지막으로 서버 분석에 성공한 힌트 목록이다. */
    private List<Object> appliedHints;
    /** 취소 스레드와 공유하는 현재 실행 요청이다. */
    private volatile Active active;
    /** 배치 실행을 위해 쌓아 둔 문장 목록이다. */
    private final List<Batch> batches = new ArrayList<>();
    /** 현재 열린 결과 집합이다. 없으면 {@code null}이다. */
    private JdbcResultSet result;
    /** 닫힌 뒤에는 요청을 거부하기 위한 표시이다. */
    private volatile boolean closed, closing;
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
     * <p>자리 표시자와 바인딩 배열을 준비하고, 지원 서버에서는 실행 없이 문장을 준비한다.</p>
     *
     * @param c 소속 연결
     * @param sql 준비 문장의 SQL. 일반 문장이면 {@code null}이다
     * @param hold 결과 집합 홀드빌리티
     * @throws SQLException 자리 표시자가 너무 많을 때
     */
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
    /**
     * 문장이 사용 가능한 상태인지 확인한다.
     *
     * @throws SQLException 연결이 닫혔거나 문장이 닫혔을 때
     */
    private void check() throws SQLException { connection.check(); if (closed || closing) throw new SQLException("Statement is closed.", "HY010"); }
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
    @Override Object call(String n, Object[] a, Method method) throws Exception {
        if (n.equals("cancel")) { check(); Active running = active; connection.protocol.cancel(running == null ? null : running.request); return null; }
        if (n.equals("close")) { close(); return null; }
        synchronized (this) { return callLocked(n, a, method); }
    }
    /** 일반 호출을 직렬화하며 취소와 close는 실행 응답 대기를 우회한다. */
    private Object callLocked(String n, Object[] a, Method method) throws Exception {
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
        // int 로 된 행 수 제한은 넘치면 Integer.MAX_VALUE 로 포화한다. (SUCCESS_NO_INFO 는 갱신 개수 전용이다. J-3)
        case "getMaxRows": return maxRows > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) maxRows;
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
        case "clearParameters": requirePrepared(); Arrays.fill(params, null); Arrays.fill(bound, false); Arrays.fill(hints, null); return null;
        case "getParameterMetaData": requirePrepared(); return parameterMetaData();
        case "getMetaData": {
            requirePrepared();
            if (prepared == null) return result == null ? null : result.metadata();
            Map<String, Object> description = description(Arrays.asList(hints.clone()));
            return "rows".equals(description.get("resultKind")) ? JdbcResultSet.metadata(columns(description, "columns")) : null;
        }
        case "addBatch":
            if (sql != null) { if (a.length != 0) throw new SQLException("SQL must not be supplied to a PreparedStatement.", "HY010"); batches.add(new Batch(sql, parameters(), Arrays.asList(hints.clone()))); }
            else { if (a.length != 1 || !(a[0] instanceof String)) throw invalid("SQL is required."); batches.add(new Batch((String) a[0], Collections.emptyList(), null)); }
            return null;
        case "clearBatch": batches.clear(); return null;
        case "executeBatch": case "executeLargeBatch": {
            long[] counts = new long[batches.size()]; int completed = 0;
            try { for (Batch b : batches) { execute(b.sql, b.params, b.hints); if (result != null) { closeResult(); throw new SQLException("Batch statement returned rows.", "HY000"); } counts[completed++] = updateCount; } }
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
     * <p>서버 실행 요청별로 취소·질의 제한 시간을 관리하며 실행 전에 이전 결과를 닫는다.</p>
     *
     * @param text 실행할 SQL 문장
     * @param values 바인딩된 파라미터 값 목록
     * @throws SQLException 서버 오류 시
     */
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
        Object encoded = Values.encode(value);
        Object typeHint = inferred[index] ? null : hint(n, a, value);
        params[index] = encoded; bound[index] = true; hints[index] = typeHint;
    }
    /** 타입을 모르는 자리만 JDBC 바인딩 문맥으로 보완한다. 알려진 컬럼 문맥은 바꾸지 않는다. */
    private static String hint(String setter, Object[] args, Object value) throws SQLException {
        if (value instanceof BigDecimal && ((BigDecimal) value).scale() > 38) throw new SQLDataException("Decimal scale exceeds the server limit.", "22003");
        int type = Types.OTHER;
        if (setter.equals("setNull")) {
            // setNull(int, int) 과 setNull(int, SQLType) 을 모두 받는다. (J-1)
            Object supplied = args[1];
            Integer number = supplied instanceof SQLType ? ((SQLType) supplied).getVendorTypeNumber() : (Integer) supplied;
            if (number == null) throw unsupported("Unknown SQLType");
            type = number.intValue();
        }
        else if (setter.equals("setObject") && args.length >= 3) {
            Object supplied = args[2];
            Integer number = supplied instanceof SQLType ? ((SQLType) supplied).getVendorTypeNumber() : (Integer) supplied;
            if (number == null) throw unsupported("Unknown SQLType");
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
        else if (value instanceof LocalDate) type = Types.DATE;
        else if (value instanceof LocalTime) type = Types.TIME;
        else if (value instanceof LocalDateTime) type = Types.TIMESTAMP;
        else if (value instanceof OffsetTime) type = Types.TIME_WITH_TIMEZONE;
        else if (value instanceof OffsetDateTime) type = Types.TIMESTAMP_WITH_TIMEZONE;
        switch (type) {
        case Types.TINYINT: case Types.SMALLINT: return "SMALLINT"; case Types.INTEGER: return "INTEGER"; case Types.BIGINT: return "BIGINT";
        case Types.NUMERIC: case Types.DECIMAL: return "DECIMAL(38," + (value instanceof BigDecimal ? Math.max(0, Math.min(38, ((BigDecimal) value).scale())) : 0) + ")";
        case Types.FLOAT: case Types.DOUBLE: return "DOUBLE PRECISION"; case Types.REAL: return "REAL";
        case Types.BIT: case Types.BOOLEAN: return "BOOLEAN";
        case Types.CHAR: case Types.NCHAR: case Types.VARCHAR: case Types.NVARCHAR: case Types.LONGVARCHAR: case Types.LONGNVARCHAR: return "VARCHAR";
        case Types.BINARY: case Types.VARBINARY: case Types.LONGVARBINARY: return "VARBINARY";
        case Types.TIME_WITH_TIMEZONE: return "TIME(6) WITH TIME ZONE";
        case Types.TIMESTAMP_WITH_TIMEZONE: return "TIMESTAMP(6) WITH TIME ZONE";
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
    /** 실행 전 파라미터 분석을 제공하며 문맥이 없는 타입만 UNKNOWN으로 보존한다. */
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
    /** 늦은 취소와 타이머는 해당 실행 요청에만 적용한다. */
    private static final class Active {
        /** 원래 실행의 최종 응답과 취소 대상 ID를 공유하는 요청이다. */
        final Protocol.Request request;
        /** 이 요청의 질의 제한 시간이 지나 취소를 보냈는지 나타낸다. */
        volatile boolean timedOut;
        /** 실행 요청별로 새 상태를 만들어 늦은 타이머의 영향을 제한한다. */
        Active(Protocol.Request request) { this.request = request; }
    }
    /**
     * 배치 실행을 위해 쌓아 두는 문장 한 개이다.
     */
    private static final class Batch {
        /** 실행할 SQL 문장이다. */
        final String sql;
        /** 바인딩된 파라미터 값 목록이다. */
        final List<Object> params;
        /** 배치를 추가할 때의 타입 힌트이다. */
        final List<Object> hints;
        /**
         * 배치 항목을 생성한다.
         *
         * @param sql 실행할 SQL 문장
         * @param params 바인딩된 파라미터 값 목록
         * @param hints 배치를 추가할 때의 타입 힌트
         */
        Batch(String sql, List<Object> params, List<Object> hints) { this.sql = sql; this.params = params; this.hints = hints; }
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
