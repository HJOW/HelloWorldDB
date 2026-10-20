package org.duckdns.hjow.helloworlddb.jdbc8;

import java.io.*;
import java.lang.reflect.Method;
import java.math.*;
import java.sql.*;
import java.util.*;
import org.duckdns.hjow.helloworlddb.jdbc8.protocol.Protocol;

/**
 * 현재 fetch 묶음만 보관하는 전진 전용·읽기 전용 ResultSet이다.
 * <p>서버 커서를 이용해 묶음 단위로 행을 가져오며, 문장에 걸린 최대 행 수를 넘기면
 * 서버 커서를 닫고 끝으로 이동한다. 모든 getter는 현재 행에서 값을 읽어
 * {@link Values}로 목표 자바 종류에 맞게 변환한다.</p>
 */
final class JdbcResultSet extends JdbcProxy {
    /** 소속 문장이다. 메타데이터 보완용이면 {@code null}이다. */
    final JdbcStatement statement;
    /** 결과 컬럼 정의 목록이다. */
    final List<Values.Column> columns;
    /** 현재 보관 중인 행 묶음이다. */
    private List<?> rows;
    /** 묶음 안에서의 위치이다. 다음 행을 읽기 전에는 -1씩 이동한다. */
    private int at = -1;
    /** 지금까지 읽은 행 번호이다. 읽기 전에는 0이다. */
    private int rowNumber;
    /** 서버에서 한 번에 가져오는 묶음 크기이다. */
    private int fetchSize;
    /** 서버 커서 ID이다. 0이면 열린 커서가 없다. */
    private long cursor;
    /** 문장에 걸린 최대 행 수이다. 0이면 제한이 없다. */
    private long maxRows;
    /** 닫힌 뒤에는 요청을 거부하기 위한 표시이다. */
    private boolean closed;
    /** 마지막 행을 지나 끝까지 읽었으면 {@code true}이다. */
    private boolean after;
    /** 마지막으로 읽은 값이 NULL이었으면 {@code true}이다. */
    private boolean wasNull;
    /**
     * 서버 응답에서 결과 집합 프록시를 생성한다.
     *
     * @param s 소속 문장
     * @param r 서버의 행 묶음 응답 맵
     * @param fetch 묶음 크기
     * @param maxRows 최대 행 수. 0이면 제한이 없다
     * @return {@link ResultSet} 프록시
     * @throws SQLException 응답 구조가 올바르지 않을 때
     */
    static JdbcResultSet from(JdbcStatement s, Map<String, Object> r, int fetch, long maxRows) throws SQLException {
        try {
            List<Values.Column> cols = new ArrayList<>(); for (Object c : Protocol.list(r.get("columns"))) cols.add(new Values.Column(Protocol.map(c)));
            JdbcResultSet result = new JdbcResultSet(s, cols, (List<?>) r.get("rows"), fetch); result.maxRows = maxRows;
            result.cursor = Boolean.TRUE.equals(r.get("hasMore")) ? ((Number) r.get("cursor")).longValue() : 0;
            result.create(ResultSet.class); return result;
        } catch (IOException e) { throw new SQLException(e.getMessage(), "08006", 8006, e); }
    }
    /**
     * 서버 연결 없이 메모리 행으로 결과 집합을 만든다.
     * <p>메타데이터 조회 결과를 JDBC 형식으로 반환할 때 사용한다.</p>
     *
     * @param columns 컬럼 정의 목록
     * @param rows 메모리 행 목록
     * @return {@link ResultSet} 프록시
     */
    static ResultSet memory(List<Values.Column> columns, List<List<Object>> rows) { JdbcResultSet r = new JdbcResultSet(null, columns, rows, 500); return r.create(ResultSet.class); }
    /**
     * 결과 집합 객체를 생성한다.
     *
     * @param s 소속 문장. 메모리 결과이면 {@code null}이다
     * @param cols 컬럼 정의 목록
     * @param rows 현재 묶음의 행 목록
     * @param fetch 묶음 크기
     */
    private JdbcResultSet(JdbcStatement s, List<Values.Column> cols, List<?> rows, int fetch) { statement = s; columns = cols; this.rows = rows; fetchSize = fetch; }
    /**
     * 결과 집합이 사용 가능한 상태인지 확인한다.
     *
     * @throws SQLException 닫혔을 때
     */
    private void check() throws SQLException { if (closed) throw new SQLException("ResultSet is closed.", "24000"); if (statement != null) statement.connection.check(); }
    /**
     * {@link ResultSet} 메서드 호출을 처리한다.
     * <p>이동·상태·메타데이터 메서드와 종류별 getter를 구현한다.
     * {@code java.time} 종류로 읽을 때는 TIME의 소수 초를 잃지 않도록 원본 문자열에서 변환한다.</p>
     *
     * @param n 호출된 메서드 이름
     * @param a 호출 인자
     * @param m 호출된 메서드 리플렉션 정보
     * @return 메서드 반환 값
     * @throws Exception 현재 행 없음, 잘못된 컬럼, 변환 실패, 서버 오류 시
     */
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
    /**
     * 컬럼 번호나 이름에서 0부터 시작하는 위치를 찾는다.
     * <p>이름은 대소문자를 구분하지 않는다.</p>
     *
     * @param key 1부터 시작하는 번호 또는 컬럼 이름
     * @return 0부터 시작하는 컬럼 위치
     * @throws SQLException 번호·이름이 유효 범위를 벗어났을 때
     */
    private int index(Object key) throws SQLException {
        if (key instanceof Integer) { int i = (Integer) key - 1; if (i >= 0 && i < columns.size()) return i; }
        else if (key instanceof String) { for (int i = 0; i < columns.size(); i++) if (columns.get(i).name.equalsIgnoreCase((String) key)) return i; }
        throw new SQLException("Invalid column index or label.", "07009");
    }
    /**
     * 다음 행으로 이동한다.
     * <p>묶음을 다 읽으면 서버 커서에서 다음 묶음을 가져오고,
     * 최대 행 수에 도달하면 커서를 닫고 끝으로 이동한다.</p>
     *
     * @return 다음 행이 있으면 {@code true}
     * @throws SQLException 서버 fetch 실패 시
     */
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
    /**
     * 열린 서버 커서를 닫는다.
     *
     * @throws SQLException 커서 닫기 실패 시
     */
    private void releaseCursor() throws SQLException { if (cursor != 0) { long c = cursor; cursor = 0; if (!statement.connection.protocol.isClosed()) statement.connection.protocol.closeCursor(c); } }
    /**
     * 서버 커서를 닫고 행 목록을 비운 뒤 소속 문장에 통지한다.
     *
     * @throws SQLException 커서 닫기 실패 시
     */
    void close() throws SQLException { if (closed) return; closed = true; try { releaseCursor(); } finally { rows = Collections.emptyList(); if (statement != null) statement.resultClosed(this); } }
    /**
     * 이 결과 집합의 컬럼 메타데이터를 생성한다.
     * <p>서버가 주지 않는 스키마·테이블 이름은 빈 문자열로, 널 허용은 알 수 없음으로 보고한다.</p>
     *
     * @return 결과 집합 메타데이터 프록시
     */
    ResultSetMetaData metadata() {
        return new JdbcProxy() {
            /**
             * 결과 집합 메타데이터 메서드 호출을 처리한다.
             *
             * @param n 호출된 메서드 이름
             * @param a 호출 인자
             * @param m 호출된 메서드 리플렉션 정보
             * @return 메서드 반환 값
             * @throws SQLException 잘못된 컬럼 번호나 미지원 항목 조회 시
             */
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
