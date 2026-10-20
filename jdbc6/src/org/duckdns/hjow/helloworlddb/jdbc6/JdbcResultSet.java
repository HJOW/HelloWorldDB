package org.duckdns.hjow.helloworlddb.jdbc6;

import java.io.*;
import java.lang.reflect.Method;
import java.math.*;
import java.sql.*;
import java.util.*;
import org.duckdns.hjow.helloworlddb.jdbc6.protocol.Protocol;

/** 현재 fetch 묶음만 보관하는 전진 전용·읽기 전용 ResultSet. */
final class JdbcResultSet extends JdbcProxy {
    final JdbcStatement statement; final List<Values.Column> columns;
    private List<?> rows; private int at = -1, rowNumber, fetchSize; private long cursor, maxRows;
    private boolean closed, after, wasNull;
    static JdbcResultSet from(JdbcStatement s, Map<String, Object> r, int fetch, long maxRows) throws SQLException {
        try {
            List<Values.Column> cols = new ArrayList<Values.Column>(); for (Object c : Protocol.list(r.get("columns"))) cols.add(new Values.Column(Protocol.map(c)));
            JdbcResultSet result = new JdbcResultSet(s, cols, (List<?>) r.get("rows"), fetch); result.maxRows = maxRows;
            result.cursor = Boolean.TRUE.equals(r.get("hasMore")) ? ((Number) r.get("cursor")).longValue() : 0;
            result.create(ResultSet.class); return result;
        } catch (IOException e) { throw new SQLException(e.getMessage(), "08006", 8006, e); }
    }
    static ResultSet memory(List<Values.Column> columns, List<List<Object>> rows) { JdbcResultSet r = new JdbcResultSet(null, columns, rows, 500); return r.create(ResultSet.class); }
    private JdbcResultSet(JdbcStatement s, List<Values.Column> cols, List<?> rows, int fetch) { statement = s; columns = cols; this.rows = rows; fetchSize = fetch; }
    private void check() throws SQLException { if (closed) throw new SQLException("ResultSet is closed.", "24000"); if (statement != null) statement.connection.check(); }
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
    private int index(Object key) throws SQLException {
        if (key instanceof Integer) { int i = (Integer) key - 1; if (i >= 0 && i < columns.size()) return i; }
        else if (key instanceof String) { for (int i = 0; i < columns.size(); i++) if (columns.get(i).name.equalsIgnoreCase((String) key)) return i; }
        throw new SQLException("Invalid column index or label.", "07009");
    }
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
    private void releaseCursor() throws SQLException { if (cursor != 0) { long c = cursor; cursor = 0; if (!statement.connection.protocol.isClosed()) statement.connection.protocol.closeCursor(c); } }
    void close() throws SQLException { if (closed) return; closed = true; try { releaseCursor(); } finally { rows = Collections.<Object>emptyList(); if (statement != null) statement.resultClosed(this); } }
    ResultSetMetaData metadata() {
        return new JdbcProxy() {
            @Override Object call(String n, Object[] a, Method m) throws SQLException {
                if (n.equals("getColumnCount")) return columns.size();
                Values.Column c = columns.get(index(a[0]));
                if (n.equals("getColumnLabel") || n.equals("getColumnName")) { return c.name; }
        else if (n.equals("getColumnType")) { return c.type; }
        else if (n.equals("getColumnTypeName")) { return c.typeName; }
        else if (n.equals("getColumnClassName")) { return Values.javaType(c.type).getName(); }
        else if (n.equals("getPrecision")) { return c.precision; }
        else if (n.equals("getScale")) { return c.scale; }
        else if (n.equals("getColumnDisplaySize")) { return c.precision + (c.scale > 0 ? 2 : 1); }
        else if (n.equals("isNullable")) { return ResultSetMetaData.columnNullableUnknown; }
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
