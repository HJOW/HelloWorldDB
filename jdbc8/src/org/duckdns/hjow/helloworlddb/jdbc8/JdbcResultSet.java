package org.duckdns.hjow.helloworlddb.jdbc8;

import java.io.*;
import java.lang.reflect.Method;
import java.math.*;
import java.sql.*;
import java.util.*;
import org.duckdns.hjow.helloworlddb.jdbc8.protocol.Protocol;

/** 현재 fetch 묶음만 보관하는 전진 전용·읽기 전용 ResultSet. */
final class JdbcResultSet extends JdbcProxy {
    final JdbcStatement statement; final List<Values.Column> columns;
    private List<?> rows; private int at = -1, rowNumber, fetchSize; private long cursor, maxRows;
    private boolean closed, after, wasNull;
    static JdbcResultSet from(JdbcStatement s, Map<String, Object> r, int fetch, long maxRows) throws SQLException {
        try {
            List<Values.Column> cols = new ArrayList<>(); for (Object c : Protocol.list(r.get("columns"))) cols.add(new Values.Column(Protocol.map(c)));
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
        switch (n) {
        case "next": return next();
        case "wasNull": return wasNull;
        case "findColumn": return index(a[0]) + 1;
        case "getMetaData": return metadata();
        case "getStatement": return statement == null ? null : statement.proxy;
        case "getType": return ResultSet.TYPE_FORWARD_ONLY;
        case "getConcurrency": return ResultSet.CONCUR_READ_ONLY;
        case "getHoldability": return ResultSet.HOLD_CURSORS_OVER_COMMIT;
        case "getRow": return after || rowNumber == 0 ? 0 : rowNumber;
        case "isBeforeFirst": return rowNumber == 0 && !rows.isEmpty();
        case "isAfterLast": return after && rowNumber > 0;
        case "isFirst": return rowNumber == 1 && !after;
        case "isLast": return !after && rowNumber > 0 && cursor == 0 && at == rows.size() - 1;
        case "getFetchDirection": return ResultSet.FETCH_FORWARD;
        case "setFetchDirection": if ((Integer) a[0] != ResultSet.FETCH_FORWARD) throw unsupported(n); return null;
        case "getFetchSize": return fetchSize;
        case "setFetchSize": if ((Integer) a[0] < 0 || (Integer) a[0] > 100000) throw invalid("Invalid fetch size."); fetchSize = (Integer) a[0] == 0 ? 500 : (Integer) a[0]; return null;
        case "getWarnings": case "clearWarnings": return null;
        case "rowUpdated": case "rowInserted": case "rowDeleted": return false;
        default: break;
        }
        Class<?> target = null;
        switch (n) {
        case "getString": case "getNString": target = String.class; break;
        case "getBoolean": target = Boolean.class; break; case "getByte": target = Byte.class; break;
        case "getShort": target = Short.class; break; case "getInt": target = Integer.class; break; case "getLong": target = Long.class; break;
        case "getFloat": target = Float.class; break; case "getDouble": target = Double.class; break;
        case "getBigDecimal": target = BigDecimal.class; break; case "getBytes": target = byte[].class; break;
        case "getDate": target = java.sql.Date.class; break; case "getTime": target = Time.class; break; case "getTimestamp": target = Timestamp.class; break;
        case "getAsciiStream": case "getCharacterStream": case "getNCharacterStream": target = String.class; break;
        case "getBinaryStream": target = byte[].class; break;
        case "getObject": break;
        default: throw unsupported(n);
        }
        int index = index(a[0]);
        if (rowNumber == 0 || after || at < 0 || at >= rows.size()) throw new SQLException("No current row.", "24000");
        List<?> row = (List<?>) rows.get(at); if (row.size() != columns.size()) throw new SQLException("Invalid row width.", "08006");
        Object raw = row.get(index); wasNull = raw == null;
        Object value;
        if (n.equals("getObject")) {
            if (a.length == 2 && a[1] instanceof Class<?>) {
                Class<?> type = (Class<?>) a[1];
                Object source = type.getName().startsWith("java.time.") ? raw : Values.decode(raw, columns.get(index).type);
                value = Values.convert(source, type);
            }
            else {
                if (a.length == 2 && (!(a[1] instanceof Map<?, ?>) || !((Map<?, ?>) a[1]).isEmpty())) throw unsupported("Custom type maps");
                value = Values.decode(raw, columns.get(index).type);
            }
        } else {
            // java.time으로 읽을 때 TIME의 소수 초를 java.sql.Time을 거치며 잃지 않는다.
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
    void close() throws SQLException { if (closed) return; closed = true; try { releaseCursor(); } finally { rows = Collections.emptyList(); if (statement != null) statement.resultClosed(this); } }
    ResultSetMetaData metadata() {
        return new JdbcProxy() {
            @Override Object call(String n, Object[] a, Method m) throws SQLException {
                if (n.equals("getColumnCount")) return columns.size();
                Values.Column c = columns.get(index(a[0]));
                switch (n) {
                case "getColumnLabel": case "getColumnName": return c.name;
                case "getColumnType": return c.type; case "getColumnTypeName": return c.typeName;
                case "getColumnClassName": return Values.javaType(c.type).getName();
                case "getPrecision": return c.precision; case "getScale": return c.scale;
                case "getColumnDisplaySize": return c.precision + (c.scale > 0 ? 2 : 1);
                case "isNullable": return ResultSetMetaData.columnNullableUnknown;
                case "isAutoIncrement": case "isCurrency": case "isWritable": case "isDefinitelyWritable": return false;
                case "isReadOnly": case "isSearchable": return true;
                case "isCaseSensitive": return c.type == Types.CHAR || c.type == Types.VARCHAR;
                case "isSigned": return Arrays.asList(Types.SMALLINT, Types.INTEGER, Types.BIGINT, Types.NUMERIC, Types.DECIMAL, Types.REAL, Types.DOUBLE).contains(c.type);
                case "getSchemaName": case "getTableName": case "getCatalogName": return "";
                default: throw unsupported(n);
                }
            }
        }.create(ResultSetMetaData.class);
    }
}
