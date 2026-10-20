package org.duckdns.hjow.helloworlddb.jdbc6;

import java.io.*;
import java.lang.reflect.Method;
import java.math.*;
import java.sql.*;
import java.util.*;
import org.duckdns.hjow.helloworlddb.jdbc6.protocol.Protocol;

/** 현재 fetch 묶음만 보관하는 전진 전용·읽기 전용 ResultSet.
 *
 * <p>서버 커서에서 fetch 크기 단위로 행 묶음을 나눠 받아 현재 묶음만 메모리에 둔다.
 * 앞으로만 이동할 수 있으며, 행이 더 있으면 서버에 fetch를 요청한다.
 * 다 읽은 서버 커서는 닫아서 서버 자원을 돌려준다.
 * 모든 공개 동작은 동적 프록시를 거쳐 {@link #call}에서 분기된다.</p> */
final class JdbcResultSet extends JdbcProxy {
    /** 이 결과를 만든 문장. 메타데이터 조회용은 {@code null}이다. */
    final JdbcStatement statement;
    /** 결과의 컬럼 설명 목록. */
    final List<Values.Column> columns;
    /** 현재 fetch 묶음의 행 목록. */
    private List<?> rows;
    /** 묶음 안의 위치, 지금까지 읽은 행 번호, 가져오기 크기, 서버 커서, 행 수 상한. */
    private int at = -1, rowNumber, fetchSize; private long cursor, maxRows;
    /** 닫힘 여부, 마지막 뒤 도달 여부, 마지막 읽은 값이 NULL이었는지 여부. */
    private boolean closed, after, wasNull;
    /** 서버 실행 응답으로부터 결과 집합 프록시를 만든다.
     *
     * @param s 이 결과를 만든 문장
     * @param r 서버의 행 응답(컬럼, 행, 커서 정보 포함)
     * @param fetch 다음 묶음을 요청할 때의 fetch 크기
     * @param maxRows 읽을 최대 행 수. 0이면 제한이 없다
     * @return 외부에 공개할 {@link java.sql.ResultSet} 프록시
     * @throws SQLException 응답 형식이 잘못된 경우 */
    static JdbcResultSet from(JdbcStatement s, Map<String, Object> r, int fetch, long maxRows) throws SQLException {
        try {
            List<Values.Column> cols = new ArrayList<Values.Column>(); for (Object c : Protocol.list(r.get("columns"))) cols.add(new Values.Column(Protocol.map(c)));
            JdbcResultSet result = new JdbcResultSet(s, cols, (List<?>) r.get("rows"), fetch); result.maxRows = maxRows;
            result.cursor = Boolean.TRUE.equals(r.get("hasMore")) ? ((Number) r.get("cursor")).longValue() : 0;
            result.create(ResultSet.class); return result;
        } catch (IOException e) { throw new SQLException(e.getMessage(), "08006", 8006, e); }
    }
    /** 메타데이터 조회용 메모리 결과 집합을 만든다.
     *
     * @param columns 컬럼 설명 목록
     * @param rows 메모리에 보관할 행 목록
     * @return 외부에 공개할 {@link java.sql.ResultSet} 프록시 */
    static ResultSet memory(List<Values.Column> columns, List<List<Object>> rows) { JdbcResultSet r = new JdbcResultSet(null, columns, rows, 500); return r.create(ResultSet.class); }
    /** 결과 집합의 내부 상태를 만든다.
     *
     * @param s 이 결과를 만든 문장. 메타데이터 조회용은 {@code null}이다
     * @param cols 컬럼 설명 목록
     * @param rows 현재 묶음의 행 목록
     * @param fetch 다음 묶음을 요청할 때의 fetch 크기 */
    private JdbcResultSet(JdbcStatement s, List<Values.Column> cols, List<?> rows, int fetch) { statement = s; columns = cols; this.rows = rows; fetchSize = fetch; }
    /** 결과 집합이 닫히지 않았는지 확인한다.
     *
     * @throws SQLException 결과 집합이 닫힌 경우 */
    private void check() throws SQLException { if (closed) throw new SQLException("ResultSet is closed.", "24000"); if (statement != null) statement.connection.check(); }
    /** 프록시로 들어온 {@link java.sql.ResultSet} 호출을 처리한다.
     *
     * <p>행 이동, 현재 행의 타입별 값 읽기, 메타데이터와 속성 조회를 처리한다.
     * 값을 읽을 때는 서버 전송값을 {@link Values}로 목표 타입에 맞게 바꾸며,
     * 오프셋 표기는 {@code getString} 계열에서 원문대로 돌려준다.
     * 갱신·삽입·삭제와 스크롤 관련 호출은 지원하지 않는다.</p>
     *
     * @param n 호출된 메서드 이름
     * @param a 호출 인자
     * @param m 호출된 메서드 객체
     * @return 호출 결과
     * @throws Exception 결과 집합이 닫혔거나 위치·인자가 잘못되었거나 지원하지 않는 호출인 경우 */
    @Override synchronized Object call(String n, Object[] a, Method m) throws Exception {
        if (n.equals("close")) { close(); return null; }
        if (n.equals("isClosed")) return closed || statement != null && statement.connection.protocol.isClosed();
        check();
        if (n.equals("next")) { return next(); }
        else if (n.equals("wasNull")) { return wasNull; }
        else if (n.equals("findColumn")) { return index(a[0]) + 1; }
        else if (n.equals("getMetaData")) { return metadata(); }
        else if (n.equals("getStatement")) { return statement == null ? null : statement.proxy; }
        else if (n.equals("getType")) { return ResultSet.TYPE_FORWARD_ONLY; }
        else if (n.equals("getConcurrency")) { return ResultSet.CONCUR_READ_ONLY; }
        else if (n.equals("getHoldability")) { return ResultSet.HOLD_CURSORS_OVER_COMMIT; }
        else if (n.equals("getRow")) { return after || rowNumber == 0 ? 0 : rowNumber; }
        else if (n.equals("isBeforeFirst")) { return rowNumber == 0 && !rows.isEmpty(); }
        else if (n.equals("isAfterLast")) { return after && rowNumber > 0; }
        else if (n.equals("isFirst")) { return rowNumber == 1 && !after; }
        else if (n.equals("isLast")) { return !after && rowNumber > 0 && cursor == 0 && at == rows.size() - 1; }
        else if (n.equals("getFetchDirection")) { return ResultSet.FETCH_FORWARD; }
        else if (n.equals("setFetchDirection")) { if ((Integer) a[0] != ResultSet.FETCH_FORWARD) throw unsupported(n); return null; }
        else if (n.equals("getFetchSize")) { return fetchSize; }
        else if (n.equals("setFetchSize")) { if ((Integer) a[0] < 0 || (Integer) a[0] > 100000) throw invalid("Invalid fetch size."); fetchSize = (Integer) a[0] == 0 ? 500 : (Integer) a[0]; return null; }
        else if (n.equals("getWarnings") || n.equals("clearWarnings")) { return null; }
        else if (n.equals("rowUpdated") || n.equals("rowInserted") || n.equals("rowDeleted")) { return false; }
        else {   }
        Class<?> target = null;
        if (n.equals("getString") || n.equals("getNString")) { target = String.class;  }
        else if (n.equals("getBoolean")) { target = Boolean.class;  }
        else if (n.equals("getByte")) { target = Byte.class;  }
        else if (n.equals("getShort")) { target = Short.class;  }
        else if (n.equals("getInt")) { target = Integer.class;  }
        else if (n.equals("getLong")) { target = Long.class;  }
        else if (n.equals("getFloat")) { target = Float.class;  }
        else if (n.equals("getDouble")) { target = Double.class;  }
        else if (n.equals("getBigDecimal")) { target = BigDecimal.class;  }
        else if (n.equals("getBytes")) { target = byte[].class;  }
        else if (n.equals("getDate")) { target = java.sql.Date.class;  }
        else if (n.equals("getTime")) { target = Time.class;  }
        else if (n.equals("getTimestamp")) { target = Timestamp.class;  }
        else if (n.equals("getAsciiStream") || n.equals("getCharacterStream") || n.equals("getNCharacterStream")) { target = String.class;  }
        else if (n.equals("getBinaryStream")) { target = byte[].class;  }
        else if (n.equals("getObject")) {  }
        else {  throw unsupported(n); }
        int index = index(a[0]);
        if (rowNumber == 0 || after || at < 0 || at >= rows.size()) throw new SQLException("No current row.", "24000");
        List<?> row = (List<?>) rows.get(at); if (row.size() != columns.size()) throw new SQLException("Invalid row width.", "08006");
        Object raw = row.get(index); wasNull = raw == null;
        Object value;
        if (n.equals("getObject")) {
            if (a.length == 2 && a[1] instanceof Class<?>) {
                Class<?> type = (Class<?>) a[1];
                Object source = Values.decode(raw, columns.get(index).type);
                value = Values.convert(source, type);
            }
            else {
                if (a.length == 2 && (!(a[1] instanceof Map<?, ?>) || !((Map<?, ?>) a[1]).isEmpty())) throw unsupported("Custom type maps");
                value = Values.decode(raw, columns.get(index).type);
            }
        } else {
            // 오프셋과 소수 초의 원래 표기는 getString에서 보존한다.
            Object source = columns.get(index).type == Types.BINARY || columns.get(index).type == Types.VARBINARY ? Values.decode(raw, columns.get(index).type) : raw;
            value = Values.convert(source, target);
            if (value != null && n.equals("getBigDecimal") && a.length == 2) value = ((BigDecimal) value).setScale((Integer) a[1], RoundingMode.HALF_UP);
            if ((n.equals("getDate") || n.equals("getTime") || n.equals("getTimestamp")) && a.length == 2) value = Values.calendarValue(value, (Calendar) a[1], true);
            if (value != null && n.equals("getBinaryStream")) value = new ByteArrayInputStream((byte[]) value);
            if (value != null && n.equals("getAsciiStream")) value = new ByteArrayInputStream(((String) value).getBytes("US-ASCII"));
            if (value != null && (n.equals("getCharacterStream") || n.equals("getNCharacterStream"))) value = new StringReader((String) value);
        }
        if (value == null && m.getReturnType().isPrimitive()) {
            if (target == Boolean.class) return false; if (target == Byte.class) return (byte) 0; if (target == Short.class) return (short) 0;
            if (target == Integer.class) return 0; if (target == Long.class) return 0L; if (target == Float.class) return 0f; if (target == Double.class) return 0d;
        }
        return value;
    }
    /** 컬럼 인덱스나 이름으로부터 0부터 시작하는 컬럼 위치를 구한다.
     *
     * @param key 1부터 시작하는 인덱스 또는 컬럼 이름(대소문자 무시)
     * @return 0부터 시작하는 컬럼 위치
     * @throws SQLException 인덱스나 이름이 유효하지 않은 경우 */
    private int index(Object key) throws SQLException {
        if (key instanceof Integer) { int i = (Integer) key - 1; if (i >= 0 && i < columns.size()) return i; }
        else if (key instanceof String) { for (int i = 0; i < columns.size(); i++) if (columns.get(i).name.equalsIgnoreCase((String) key)) return i; }
        throw new SQLException("Invalid column index or label.", "07009");
    }
    /** 다음 행으로 이동한다. 현재 묶음을 다 읽으면 서버에 다음 묶음을 요청한다.
     *
     * @return 다음 행이 있으면 {@code true}, 더 이상 없으면 {@code false}
     * @throws SQLException 서버 fetch에 실패한 경우 */
    private boolean next() throws SQLException {
        if (after) return false;
        if (maxRows > 0 && rowNumber >= maxRows) { releaseCursor(); after = true; return false; }
        while (++at >= rows.size()) {
            if (cursor == 0) { after = true; return false; }
            Map<String, Object> r = statement.connection.protocol.fetch(cursor, fetchSize);
            rows = (List<?>) r.get("rows"); at = -1;
            cursor = Boolean.TRUE.equals(r.get("hasMore")) ? ((Number) r.get("cursor")).longValue() : 0;
        }
        rowNumber++; return true;
    }
    /** 서버 커서를 닫고 서버 자원을 돌려준다. 이미 닫혔으면 아무 일도 하지 않는다.
     *
     * @throws SQLException 커서를 닫는 중에 오류가 발생한 경우 */
    private void releaseCursor() throws SQLException { if (cursor != 0) { long c = cursor; cursor = 0; if (!statement.connection.protocol.isClosed()) statement.connection.protocol.closeCursor(c); } }
    /** 결과 집합을 닫는다. 남은 서버 커서를 닫고 문장에 닫힘을 알린다.
     *
     * @throws SQLException 서버 커서를 닫는 중에 오류가 발생한 경우 */
    void close() throws SQLException { if (closed) return; closed = true; try { releaseCursor(); } finally { rows = Collections.<Object>emptyList(); if (statement != null) statement.resultClosed(this); } }
    /** 이 결과의 컬럼 정보를 담은 {@link java.sql.ResultSetMetaData}를 만든다.
     *
     * @return 컬럼 개수, 타입, 정밀도, 표시 길이를 담은 메타데이터 프록시 */
    ResultSetMetaData metadata() {
        return metadata(columns);
    }
    /** 실행 전 분석에도 실제 결과와 같은 컬럼 메타데이터 구현을 사용한다. */
    static ResultSetMetaData metadata(final List<Values.Column> columns) {
        return new JdbcProxy() {
            /** 컬럼 메타데이터 조회 호출을 처리한다.
             *
             * @param n 호출된 메서드 이름
             * @param a 호출 인자
             * @param m 호출된 메서드 객체
             * @return 호출 결과
             * @throws SQLException 컬럼 위치가 잘못되었거나 지원하지 않는 호출인 경우 */
            @Override Object call(String n, Object[] a, Method m) throws SQLException {
                if (n.equals("getColumnCount")) return columns.size();
                int index = ((Integer) a[0]).intValue() - 1;
                if (index < 0 || index >= columns.size()) throw new SQLException("Invalid column index.", "07009");
                Values.Column c = columns.get(index);
                if (n.equals("getColumnLabel") || n.equals("getColumnName")) { return c.name; }
        else if (n.equals("getColumnType")) { return c.type; }
        else if (n.equals("getColumnTypeName")) { return c.typeName; }
        else if (n.equals("getColumnClassName")) { return "UNKNOWN".equals(c.typeName) ? Object.class.getName() : Values.javaType(c.type).getName(); }
        else if (n.equals("getPrecision")) { return c.precision; }
        else if (n.equals("getScale")) { return c.scale; }
        else if (n.equals("getColumnDisplaySize")) { return c.precision + (c.scale > 0 ? 2 : 1); }
        else if (n.equals("isNullable")) { return c.nullable; }
        else if (n.equals("isAutoIncrement") || n.equals("isCurrency") || n.equals("isWritable") || n.equals("isDefinitelyWritable")) { return false; }
        else if (n.equals("isReadOnly") || n.equals("isSearchable")) { return true; }
        else if (n.equals("isCaseSensitive")) { return c.type == Types.CHAR || c.type == Types.VARCHAR; }
        else if (n.equals("isSigned")) { return Arrays.asList(Types.SMALLINT, Types.INTEGER, Types.BIGINT, Types.NUMERIC, Types.DECIMAL, Types.REAL, Types.DOUBLE).contains(c.type); }
        else if (n.equals("getSchemaName") || n.equals("getTableName") || n.equals("getCatalogName")) { return ""; }
        else {  throw unsupported(n); }
            }
        }.create(ResultSetMetaData.class);
    }
}
