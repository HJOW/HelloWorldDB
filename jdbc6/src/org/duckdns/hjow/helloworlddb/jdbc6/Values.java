package org.duckdns.hjow.helloworlddb.jdbc6;

import java.math.*;
import java.sql.*;
import java.util.*;
import java.util.regex.*;
import org.duckdns.hjow.helloworlddb.jdbc6.protocol.Json;

/** Java 6 표준 API만 사용하는 값 변환. 오프셋 원문은 getString으로 보존한다. */
final class Values {
    private Values() { }
    static int sqlType(String name) {
        if (name.equals("CHAR") || name.equals("NCHAR")) return Types.CHAR;
        if (name.equals("VARCHAR") || name.equals("NVARCHAR")) return Types.VARCHAR;
        if (name.equals("BINARY")) return Types.BINARY; if (name.equals("VARBINARY")) return Types.VARBINARY;
        if (name.equals("SMALLINT")) return Types.SMALLINT; if (name.equals("INTEGER") || name.equals("INT")) return Types.INTEGER;
        if (name.equals("BIGINT")) return Types.BIGINT; if (name.equals("NUMERIC")) return Types.NUMERIC;
        if (name.equals("DECIMAL") || name.equals("DEC")) return Types.DECIMAL; if (name.equals("REAL")) return Types.REAL;
        if (name.equals("DOUBLE PRECISION") || name.equals("FLOAT")) return Types.DOUBLE; if (name.equals("BOOLEAN")) return Types.BOOLEAN;
        if (name.equals("DATE")) return Types.DATE; if (name.startsWith("TIME ") || name.equals("TIME")) return Types.TIME;
        if (name.startsWith("TIMESTAMP")) return Types.TIMESTAMP; return Types.OTHER;
    }
    static Class<?> javaType(int type) {
        switch (type) {
        case Types.CHAR: case Types.VARCHAR: case Types.OTHER: return String.class;
        case Types.BINARY: case Types.VARBINARY: return byte[].class;
        case Types.SMALLINT: case Types.INTEGER: return Integer.class; case Types.BIGINT: return Long.class;
        case Types.NUMERIC: case Types.DECIMAL: return BigDecimal.class;
        case Types.REAL: return Float.class; case Types.DOUBLE: return Double.class; case Types.BOOLEAN: return Boolean.class;
        case Types.DATE: return java.sql.Date.class; case Types.TIME: return Time.class; case Types.TIMESTAMP: return Timestamp.class;
        default: return Object.class;
        }
    }
    static Object decode(Object value, int type) throws SQLException {
        if (value == null) return null;
        if (type == Types.BINARY || type == Types.VARBINARY) {
            String s = value.toString(); if (!s.matches("(?:[0-9A-Fa-f]{2})*")) throw new SQLException("Invalid binary value.", "22018");
            byte[] bytes = new byte[s.length() / 2]; for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16); return bytes;
        }
        return convert(value, javaType(type));
    }
    static String hex(byte[] bytes) {
        char[] out = new char[bytes.length * 2]; String digits = "0123456789ABCDEF";
        for (int i = 0; i < bytes.length; i++) { out[i * 2] = digits.charAt((bytes[i] & 255) >>> 4); out[i * 2 + 1] = digits.charAt(bytes[i] & 15); } return new String(out);
    }
    static Object encode(Object v) throws SQLException {
        if (v == null || v instanceof String || v instanceof Boolean) return v;
        if (v instanceof byte[]) return Json.object("binary", hex((byte[]) v));
        if (v instanceof Byte || v instanceof Short || v instanceof Integer || v instanceof Long || v instanceof BigInteger || v instanceof BigDecimal) return v.toString();
        if (v instanceof Float || v instanceof Double) {
            double d = ((Number) v).doubleValue(); if (Double.isNaN(d) || Double.isInfinite(d)) throw new SQLException("Non-finite number.", "22003");
            return d == Math.rint(d) && Math.abs(d) > 9007199254740991d ? BigDecimal.valueOf(d).toPlainString() : Double.valueOf(d);
        }
        if (v instanceof java.sql.Date || v instanceof Time || v instanceof Timestamp) return v.toString();
        throw JdbcProxy.unsupported("Parameter type " + v.getClass().getName());
    }
    static Object target(Object value, int type, Integer scale) throws SQLException {
        if (value == null) return null; Class<?> cls;
        switch (type) {
        case Types.TINYINT: cls = Byte.class; break; case Types.FLOAT: case Types.DOUBLE: cls = Double.class; break;
        case Types.BIT: cls = Boolean.class; break;
        case Types.NCHAR: case Types.NVARCHAR: case Types.LONGNVARCHAR: case Types.LONGVARCHAR: cls = String.class; break;
        case Types.LONGVARBINARY: cls = byte[].class; break; case Types.NULL: return null;
        default: cls = javaType(type); if (cls == Object.class || type == Types.OTHER) throw JdbcProxy.unsupported("SQL type " + type);
        }
        Object converted = convert(value, cls);
        if (converted instanceof BigDecimal && scale != null) converted = ((BigDecimal) converted).setScale(scale.intValue(), RoundingMode.HALF_UP); return converted;
    }
    private static BigDecimal decimal(Object v) { return v instanceof Boolean ? (Boolean.TRUE.equals(v) ? BigDecimal.ONE : BigDecimal.ZERO) : new BigDecimal(v.toString()); }
    static Object convert(Object v, Class<?> type) throws SQLException {
        if (type == null) throw JdbcProxy.invalid("Target class is null."); if (v == null) return null;
        try {
            if (type == byte[].class && v instanceof byte[]) return ((byte[]) v).clone();
            if (type == String.class) return v instanceof byte[] ? hex((byte[]) v) : v.toString();
            if (type == BigDecimal.class) return decimal(v);
            if (type == Byte.class || type == byte.class) return Byte.valueOf(decimal(v).setScale(0, RoundingMode.DOWN).byteValueExact());
            if (type == Short.class || type == short.class) return Short.valueOf(decimal(v).setScale(0, RoundingMode.DOWN).shortValueExact());
            if (type == Integer.class || type == int.class) return Integer.valueOf(decimal(v).setScale(0, RoundingMode.DOWN).intValueExact());
            if (type == Long.class || type == long.class) return Long.valueOf(decimal(v).setScale(0, RoundingMode.DOWN).longValueExact());
            if (type == Float.class || type == float.class) { float f = Float.parseFloat(v.toString()); if (Float.isNaN(f) || Float.isInfinite(f)) throw new ArithmeticException(); return Float.valueOf(f); }
            if (type == Double.class || type == double.class) { double d = Double.parseDouble(v.toString()); if (Double.isNaN(d) || Double.isInfinite(d)) throw new ArithmeticException(); return Double.valueOf(d); }
            if (type == Boolean.class || type == boolean.class) {
                if (v instanceof Boolean) return v;
                if (v.toString().equalsIgnoreCase("true") || v.toString().equals("1")) return Boolean.TRUE;
                if (v.toString().equalsIgnoreCase("false") || v.toString().equals("0")) return Boolean.FALSE; throw new IllegalArgumentException();
            }
            if (type == Timestamp.class || type == Time.class || type == java.sql.Date.class) {
                if (v instanceof Timestamp && type == Timestamp.class) { Timestamp t = (Timestamp) v; Timestamp copy = new Timestamp(t.getTime()); copy.setNanos(t.getNanos()); return copy; }
                if (v instanceof Time && type == Time.class) return new Time(((Time) v).getTime());
                if (v instanceof java.sql.Date && type == java.sql.Date.class) return new java.sql.Date(((java.sql.Date) v).getTime());
                return temporal(v.toString(), type);
            }
            if (type.isInstance(v)) return v;
        } catch (ArithmeticException e) { throw new SQLException("Numeric value out of range.", "22003", e); }
        catch (RuntimeException e) { throw new SQLException("Cannot convert value to " + type.getName(), "22018", e); }
        throw JdbcProxy.unsupported("Conversion to " + type.getName());
    }
    private static Object temporal(String text, Class<?> type) {
        text = text.replace('T', ' ');
        Matcher m = Pattern.compile("(?:(\\d{4})-(\\d{2})-(\\d{2})(?: )?)?(?:(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d{1,9}))?)?([+-]\\d{2}:\\d{2}|Z)?").matcher(text);
        if (!m.matches() || m.group(1) == null && m.group(4) == null) throw new IllegalArgumentException();
        int year = m.group(1) == null ? 1970 : Integer.parseInt(m.group(1)), month = m.group(2) == null ? 1 : Integer.parseInt(m.group(2)), day = m.group(3) == null ? 1 : Integer.parseInt(m.group(3));
        int hour = m.group(4) == null ? 0 : Integer.parseInt(m.group(4)), minute = m.group(5) == null ? 0 : Integer.parseInt(m.group(5)), second = m.group(6) == null ? 0 : Integer.parseInt(m.group(6));
        String fraction = m.group(7); int nanos = fraction == null ? 0 : Integer.parseInt((fraction + "000000000").substring(0, 9));
        if (year < 1 || year > 9999 || type == java.sql.Date.class && m.group(1) == null || type == Time.class && m.group(4) == null) throw new IllegalArgumentException();
        TimeZone zone = TimeZone.getDefault(); String offset = m.group(8);
        if (offset != null) {
            if (offset.equals("Z")) zone = TimeZone.getTimeZone("UTC");
            else { int h = Integer.parseInt(offset.substring(1, 3)), min = Integer.parseInt(offset.substring(4, 6)); if (h > 14 || min > 59 || h == 14 && min != 0) throw new IllegalArgumentException(); zone = new SimpleTimeZone((h * 60 + min) * 60000 * (offset.charAt(0) == '-' ? -1 : 1), "input"); }
        }
        Calendar cal = Calendar.getInstance(zone); cal.clear(); cal.setLenient(false); cal.set(year, month - 1, day, hour, minute, second); cal.getTimeInMillis();
        if (type == java.sql.Date.class) { cal.set(Calendar.HOUR_OF_DAY, 0); cal.set(Calendar.MINUTE, 0); cal.set(Calendar.SECOND, 0); return new java.sql.Date(cal.getTimeInMillis()); }
        if (type == Time.class) { cal.set(Calendar.YEAR, 1970); cal.set(Calendar.MONTH, 0); cal.set(Calendar.DAY_OF_MONTH, 1); return new Time(cal.getTimeInMillis()); }
        Timestamp ts = new Timestamp(cal.getTimeInMillis()); ts.setNanos(nanos); return ts;
    }
    static Object calendarValue(Object value, Calendar calendar, boolean output) throws SQLException {
        if (value == null) return null; if (calendar == null) throw JdbcProxy.invalid("Calendar is null.");
        Calendar source = Calendar.getInstance(output ? TimeZone.getDefault() : calendar.getTimeZone()); source.setTimeInMillis(((java.util.Date) value).getTime());
        Calendar target = Calendar.getInstance(output ? calendar.getTimeZone() : TimeZone.getDefault()); target.clear(); target.setLenient(false);
        target.set(source.get(Calendar.YEAR), source.get(Calendar.MONTH), source.get(Calendar.DAY_OF_MONTH), source.get(Calendar.HOUR_OF_DAY), source.get(Calendar.MINUTE), source.get(Calendar.SECOND));
        long millis = target.getTimeInMillis();
        if (value instanceof java.sql.Date) return new java.sql.Date(millis); if (value instanceof Time) return new Time(millis);
        Timestamp ts = new Timestamp(millis); ts.setNanos(((Timestamp) value).getNanos()); return ts;
    }
    static final class Column {
        final String name, declared, typeName; final int type, precision, scale;
        Column(Map<String, Object> m) {
            name = String.valueOf(m.get("name")); declared = String.valueOf(m.get("declared")); typeName = String.valueOf(m.get("typeName")); type = sqlType(typeName);
            precision = number(m, "length", number(m, "precision", defaultPrecision(type, number(m, "fractionalPrecision", 0)))); scale = number(m, "scale", number(m, "fractionalPrecision", 0));
        }
        Column(String name, String declared) { this(declaration(name, declared)); }
        private static int number(Map<String, Object> m, String key, int fallback) { return m.get(key) instanceof Number ? ((Number) m.get(key)).intValue() : fallback; }
        private static int defaultPrecision(int type, int f) {
            switch (type) {
            case Types.SMALLINT: return 5; case Types.INTEGER: return 10; case Types.BIGINT: return 19; case Types.REAL: return 7; case Types.DOUBLE: return 15; case Types.BOOLEAN: return 1; case Types.DATE: return 10;
            case Types.TIME: return 8 + (f > 0 ? f + 1 : 0); case Types.TIMESTAMP: return 19 + (f > 0 ? f + 1 : 0); default: return 0;
            }
        }
        private static Map<String, Object> declaration(String name, String declared) {
            String normal = declared.replaceAll("\\([^)]*\\)", "").trim(); Map<String, Object> m = Json.object("name", name, "typeName", normal, "declared", declared);
            Matcher args = Pattern.compile("\\((\\d+)(?:,\\s*(\\d+))?\\)").matcher(declared);
            if (args.find()) { int first = Integer.parseInt(args.group(1));
                if (normal.equals("DECIMAL") || normal.equals("NUMERIC")) { m.put("precision", Integer.valueOf(first)); m.put("scale", Integer.valueOf(args.group(2) == null ? 0 : Integer.parseInt(args.group(2)))); }
                else if (normal.startsWith("TIME")) m.put("fractionalPrecision", Integer.valueOf(first)); else m.put("length", Integer.valueOf(first));
            }
            return m;
        }
    }
}
