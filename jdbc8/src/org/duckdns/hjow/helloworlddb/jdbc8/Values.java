package org.duckdns.hjow.helloworlddb.jdbc8;

import java.math.*;
import java.sql.*;
import java.time.*;
import java.util.*;
import java.util.regex.*;
import org.duckdns.hjow.helloworlddb.jdbc8.protocol.Json;

/** 서버 표기와 JDBC 4.2 값의 변환. 숫자와 소수 초는 문자열을 거쳐 정밀도를 보존한다. */
final class Values {
    private Values() { }
    static int sqlType(String name) {
        switch (name) {
        case "CHAR": case "NCHAR": return Types.CHAR;
        case "VARCHAR": case "NVARCHAR": return Types.VARCHAR;
        case "BINARY": return Types.BINARY; case "VARBINARY": return Types.VARBINARY;
        case "SMALLINT": return Types.SMALLINT; case "INTEGER": case "INT": return Types.INTEGER; case "BIGINT": return Types.BIGINT;
        case "NUMERIC": return Types.NUMERIC; case "DECIMAL": case "DEC": return Types.DECIMAL;
        case "REAL": return Types.REAL; case "FLOAT": case "DOUBLE PRECISION": return Types.DOUBLE;
        case "BOOLEAN": return Types.BOOLEAN; case "DATE": return Types.DATE; case "TIME": return Types.TIME;
        case "TIMESTAMP": return Types.TIMESTAMP; case "TIME WITH TIME ZONE": return Types.TIME_WITH_TIMEZONE;
        case "TIMESTAMP WITH TIME ZONE": return Types.TIMESTAMP_WITH_TIMEZONE; default: return Types.OTHER;
        }
    }
    static Class<?> javaType(int type) {
        switch (type) {
        case Types.CHAR: case Types.VARCHAR: case Types.OTHER: return String.class;
        case Types.BINARY: case Types.VARBINARY: return byte[].class;
        case Types.SMALLINT: case Types.INTEGER: return Integer.class; case Types.BIGINT: return Long.class;
        case Types.NUMERIC: case Types.DECIMAL: return BigDecimal.class;
        case Types.REAL: return Float.class; case Types.DOUBLE: return Double.class; case Types.BOOLEAN: return Boolean.class;
        case Types.DATE: return java.sql.Date.class; case Types.TIME: return Time.class; case Types.TIMESTAMP: return Timestamp.class;
        case Types.TIME_WITH_TIMEZONE: return OffsetTime.class; case Types.TIMESTAMP_WITH_TIMEZONE: return OffsetDateTime.class;
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
        for (int i = 0; i < bytes.length; i++) { out[i * 2] = digits.charAt((bytes[i] & 255) >>> 4); out[i * 2 + 1] = digits.charAt(bytes[i] & 15); }
        return new String(out);
    }
    static Object encode(Object v) throws SQLException {
        if (v == null || v instanceof String || v instanceof Boolean) return v;
        if (v instanceof byte[]) return Json.object("binary", hex((byte[]) v));
        if (v instanceof Byte || v instanceof Short || v instanceof Integer || v instanceof Long || v instanceof BigInteger || v instanceof BigDecimal) return v.toString();
        if (v instanceof Float || v instanceof Double) {
            double d = ((Number) v).doubleValue(); if (!Double.isFinite(d)) throw new SQLException("Non-finite number.", "22003");
            return d == Math.rint(d) && Math.abs(d) > 9007199254740991d ? BigDecimal.valueOf(d).toPlainString() : d;
        }
        if (v instanceof java.sql.Date) return ((java.sql.Date) v).toLocalDate().toString();
        if (v instanceof Time) return ((Time) v).toLocalTime().toString();
        if (v instanceof Timestamp) return ((Timestamp) v).toLocalDateTime().toString().replace('T', ' ');
        if (v instanceof LocalDate || v instanceof LocalTime || v instanceof LocalDateTime || v instanceof OffsetTime || v instanceof OffsetDateTime) return v.toString().replace('T', ' ');
        throw JdbcProxy.unsupported("Parameter type " + v.getClass().getName());
    }
    static Object target(Object value, int type, Integer scale) throws SQLException {
        if (value == null) return null;
        Class<?> cls;
        switch (type) {
        case Types.TINYINT: cls = Byte.class; break; case Types.FLOAT: case Types.DOUBLE: cls = Double.class; break;
        case Types.BIT: cls = Boolean.class; break;
        case Types.NCHAR: case Types.NVARCHAR: case Types.LONGNVARCHAR: case Types.LONGVARCHAR: cls = String.class; break;
        case Types.LONGVARBINARY: cls = byte[].class; break;
        case Types.NULL: return null;
        default: cls = javaType(type); if (cls == Object.class || type == Types.OTHER) throw JdbcProxy.unsupported("SQL type " + type);
        }
        Object converted = convert(value, cls);
        if (converted instanceof BigDecimal && scale != null) converted = ((BigDecimal) converted).setScale(scale, RoundingMode.HALF_UP);
        return converted;
    }
    static BigDecimal decimal(Object v) { return v instanceof Boolean ? (Boolean.TRUE.equals(v) ? BigDecimal.ONE : BigDecimal.ZERO) : new BigDecimal(v.toString()); }
    static Object convert(Object v, Class<?> type) throws SQLException {
        if (type == null) throw JdbcProxy.invalid("Target class is null.");
        if (v == null) return null;
        try {
            if (type == byte[].class && v instanceof byte[]) return ((byte[]) v).clone();
            if (type == String.class) return v instanceof byte[] ? hex((byte[]) v) : v.toString();
            if (type == BigDecimal.class) return decimal(v);
            if (type == Byte.class || type == byte.class) return decimal(v).setScale(0, RoundingMode.DOWN).byteValueExact();
            if (type == Short.class || type == short.class) return decimal(v).setScale(0, RoundingMode.DOWN).shortValueExact();
            if (type == Integer.class || type == int.class) return decimal(v).setScale(0, RoundingMode.DOWN).intValueExact();
            if (type == Long.class || type == long.class) return decimal(v).setScale(0, RoundingMode.DOWN).longValueExact();
            if (type == Float.class || type == float.class) { float f = Float.parseFloat(v.toString()); if (!Float.isFinite(f)) throw new ArithmeticException(); return f; }
            if (type == Double.class || type == double.class) { double d = Double.parseDouble(v.toString()); if (!Double.isFinite(d)) throw new ArithmeticException(); return d; }
            if (type == Boolean.class || type == boolean.class) {
                if (v instanceof Boolean) return v;
                if (v.toString().equalsIgnoreCase("true") || v.toString().equals("1")) return true;
                if (v.toString().equalsIgnoreCase("false") || v.toString().equals("0")) return false;
                throw new IllegalArgumentException();
            }
            if (type == LocalDate.class) {
                if (v instanceof java.sql.Date) return ((java.sql.Date) v).toLocalDate();
                if (v instanceof Timestamp) return ((Timestamp) v).toLocalDateTime().toLocalDate();
                if (v instanceof LocalDateTime) return ((LocalDateTime) v).toLocalDate();
                String text = v.toString().replace(' ', 'T');
                return text.length() == 10 ? LocalDate.parse(text) : LocalDateTime.parse(text).toLocalDate();
            }
            if (type == LocalTime.class) {
                if (v instanceof Time) return ((Time) v).toLocalTime();
                if (v instanceof Timestamp) return ((Timestamp) v).toLocalDateTime().toLocalTime();
                if (v instanceof LocalDateTime) return ((LocalDateTime) v).toLocalTime();
                String text = v.toString().replace(' ', 'T');
                return text.indexOf('T') >= 0 ? LocalDateTime.parse(text).toLocalTime() : LocalTime.parse(text);
            }
            if (type == LocalDateTime.class) {
                if (v instanceof Timestamp) return ((Timestamp) v).toLocalDateTime();
                if (v instanceof java.sql.Date) return ((java.sql.Date) v).toLocalDate().atStartOfDay();
                if (v instanceof LocalDate) return ((LocalDate) v).atStartOfDay();
                return LocalDateTime.parse(v.toString().replace(' ', 'T'));
            }
            if (type == OffsetTime.class) return OffsetTime.parse(v.toString());
            if (type == OffsetDateTime.class) return OffsetDateTime.parse(v.toString().replace(' ', 'T'));
            if (type == java.sql.Date.class) return java.sql.Date.valueOf((LocalDate) convert(v, LocalDate.class));
            if (type == Time.class) return Time.valueOf((LocalTime) convert(v, LocalTime.class));
            if (type == Timestamp.class) return Timestamp.valueOf((LocalDateTime) convert(v, LocalDateTime.class));
            if (type.isInstance(v)) return v;
        } catch (ArithmeticException e) { throw new SQLException("Numeric value out of range.", "22003", e); }
        catch (RuntimeException e) { throw new SQLException("Cannot convert value to " + type.getName(), "22018", e); }
        throw JdbcProxy.unsupported("Conversion to " + type.getName());
    }
    static Object calendarValue(Object v, Calendar calendar, boolean output) throws SQLException {
        if (v == null) return null; if (calendar == null) throw JdbcProxy.invalid("Calendar is null.");
        ZoneId zone = calendar.getTimeZone().toZoneId();
        if (!output) {
            Instant instant = Instant.ofEpochMilli(((java.util.Date) v).getTime()); LocalDateTime local = LocalDateTime.ofInstant(instant, zone);
            if (v instanceof java.sql.Date) return local.toLocalDate(); if (v instanceof Time) return local.toLocalTime();
            return local.withNano(((Timestamp) v).getNanos());
        }
        LocalDateTime local;
        if (v instanceof java.sql.Date) local = ((java.sql.Date) v).toLocalDate().atStartOfDay();
        else if (v instanceof Time) local = LocalDate.of(1970, 1, 1).atTime(((Time) v).toLocalTime());
        else local = ((Timestamp) v).toLocalDateTime();
        long millis = local.atZone(zone).toInstant().toEpochMilli();
        if (v instanceof java.sql.Date) return new java.sql.Date(millis); if (v instanceof Time) return new Time(millis);
        Timestamp timestamp = new Timestamp(millis); timestamp.setNanos(local.getNano()); return timestamp;
    }
    static final class Column {
        final String name, declared, typeName; final int type, precision, scale;
        Column(Map<String, Object> m) {
            name = String.valueOf(m.get("name")); declared = String.valueOf(m.get("declared")); typeName = String.valueOf(m.get("typeName")); type = sqlType(typeName);
            precision = number(m, "length", number(m, "precision", defaultPrecision(type, number(m, "fractionalPrecision", 0))));
            scale = number(m, "scale", number(m, "fractionalPrecision", 0));
        }
        Column(String name, String declared) { this(declaration(name, declared)); }
        private static int number(Map<String, Object> m, String key, int fallback) { return m.get(key) instanceof Number ? ((Number) m.get(key)).intValue() : fallback; }
        private static int defaultPrecision(int type, int f) {
            switch (type) {
            case Types.SMALLINT: return 5; case Types.INTEGER: return 10; case Types.BIGINT: return 19;
            case Types.REAL: return 7; case Types.DOUBLE: return 15; case Types.BOOLEAN: return 1; case Types.DATE: return 10;
            case Types.TIME: return 8 + (f > 0 ? f + 1 : 0); case Types.TIME_WITH_TIMEZONE: return 14 + (f > 0 ? f + 1 : 0);
            case Types.TIMESTAMP: return 19 + (f > 0 ? f + 1 : 0); case Types.TIMESTAMP_WITH_TIMEZONE: return 25 + (f > 0 ? f + 1 : 0); default: return 0;
            }
        }
        private static Map<String, Object> declaration(String name, String declared) {
            String normal = declared.replaceAll("\\([^)]*\\)", "").trim();
            Map<String, Object> m = Json.object("name", name, "typeName", normal, "declared", declared);
            Matcher args = Pattern.compile("\\((\\d+)(?:,\\s*(\\d+))?\\)").matcher(declared);
            if (args.find()) {
                int first = Integer.parseInt(args.group(1));
                if (normal.equals("DECIMAL") || normal.equals("NUMERIC")) { m.put("precision", first); m.put("scale", args.group(2) == null ? 0 : Integer.parseInt(args.group(2))); }
                else if (normal.startsWith("TIME")) m.put("fractionalPrecision", first);
                else m.put("length", first);
            }
            return m;
        }
    }
}
