package org.duckdns.hjow.helloworlddb.jdbc8;

import java.math.*;
import java.sql.*;
import java.time.*;
import java.util.*;
import java.util.regex.*;
import org.duckdns.hjow.helloworlddb.jdbc8.protocol.Json;

/**
 * 서버 표기와 JDBC 4.2 값의 변환을 담당한다. 숫자와 소수 초는 문자열을 거쳐 정밀도를 보존한다.
 * <p>서버는 BIGINT·NUMERIC·날짜시간·이진을 문자열(16진 포함)로 보내며,
 * 이 클래스는 {@link Types}와 {@code java.time} 종류 사이의 양방향 변환을 맡는다.
 * TIME의 소수 초는 {@code java.sql.Time}을 거치지 않고 원본 문자열에서 읽어 정밀도 손실을 막는다.</p>
 */
final class Values {
    /** 인스턴스 생성을 막는 전용 생성자이다. */
    private Values() { }
    /**
     * 서버 타입 이름에서 JDBC 타입 번호로 변환한다.
     *
     * @param name 서버가 보낸 타입 이름(예: {@code VARCHAR}, {@code TIMESTAMP WITH TIME ZONE})
     * @return {@link Types} 상수. 알 수 없는 이름은 {@code OTHER}이다
     */
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
    /**
     * JDBC 타입 번호에서 기본 자바 클래스로 변환한다.
     *
     * @param type {@link Types} 상수
     * @return 해당 타입의 기본 자바 클래스. 타임존 포함 타입은 {@code java.time} 종류이다
     */
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
    /**
     * 서버 원시 값을 해당 컬럼의 JDBC 기본 자바 값으로 디코딩한다.
     * <p>이진 타입은 16진 문자열을 바이트 배열로 바꾸고, 나머지는 기본 클래스로 변환한다.</p>
     *
     * @param value 서버가 보낸 원시 값
     * @param type {@link Types} 상수
     * @return 디코딩된 자바 값. 입력이 {@code null}이면 {@code null}이다
     * @throws SQLException 16진 형식이 올바르지 않을 때
     */
    static Object decode(Object value, int type) throws SQLException {
        if (value == null) return null;
        if (type == Types.BINARY || type == Types.VARBINARY) {
            String s = value.toString(); if (!s.matches("(?:[0-9A-Fa-f]{2})*")) throw new SQLException("Invalid binary value.", "22018");
            byte[] bytes = new byte[s.length() / 2]; for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16); return bytes;
        }
        return convert(value, javaType(type));
    }
    /**
     * 바이트 배열을 대문자 16진 문자열로 변환한다.
     *
     * @param bytes 변환할 바이트 배열
     * @return 16진 문자열
     */
    static String hex(byte[] bytes) {
        char[] out = new char[bytes.length * 2]; String digits = "0123456789ABCDEF";
        for (int i = 0; i < bytes.length; i++) { out[i * 2] = digits.charAt((bytes[i] & 255) >>> 4); out[i * 2 + 1] = digits.charAt(bytes[i] & 15); }
        return new String(out);
    }
    /**
     * JDBC 바인딩 값을 서버에 보낼 JSON 표현으로 인코딩한다.
     * <p>정수와 소수는 문자열로 보내 정밀도를 보존하며, 부동소수는 무한·비수를 거부한다.
     * 날짜시간은 공백 구분 ISO 형태로, {@code java.time} 종류도 같은 규칙으로 보낸다.</p>
     *
     * @param v 바인딩할 자바 값
     * @return 서버 전송용 값. 이진은 {@code {"binary":16진}} 객체로 감싼다
     * @throws SQLException 지원하지 않는 종류나 무한·비수일 때
     */
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
    /**
     * {@code setObject}의 값을 대상 SQL 종류에 맞게 변환한다.
     * <p>별칭 종류(TINYINT, LONGVARCHAR 등)를 기본 종류로 접은 뒤 변환하고,
     * {@link BigDecimal}에 스케일이 지정되면 반올림한다.</p>
     *
     * @param value 원본 값
     * @param type 대상 {@link Types} 번호
     * @param scale 소수 자릿수. {@code null}이면 스케일을 조정하지 않는다
     * @return 변환된 값. 입력이 {@code null}이면 {@code null}이다
     * @throws SQLException 지원하지 않는 종류나 변환 실패 시
     */
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
    /**
     * 임의의 값을 10진 문자열을 거쳐 {@link BigDecimal}로 변환한다.
     *
     * @param v 원본 값
     * @return 변환된 10진수
     */
    static BigDecimal decimal(Object v) { return v instanceof Boolean ? (Boolean.TRUE.equals(v) ? BigDecimal.ONE : BigDecimal.ZERO) : new BigDecimal(v.toString()); }
    /**
     * 값을 지정한 자바 클래스로 변환한다.
     * <p>숫자는 10진을 거쳐 오버플로를 검사하고, 날짜시간은 {@code java.time}과
     * {@code java.sql} 종류 사이를 공백·{@code T} 구분 모두 받아 변환한다.
     * 타임존 포함 타입은 오프셋 문자열 그대로 파싱한다.</p>
     *
     * @param v 원본 값. {@code null}이면 {@code null}을 반환한다
     * @param type 목표 클래스
     * @return 변환된 값
     * @throws SQLException 목표 클래스가 {@code null}이거나, 범위 초과·형식 오류·미지원 변환일 때
     */
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
    /**
     * 날짜시간 값과 달력 기준대 사이의 변환을 처리한다.
     * <p>{@code setDate/setTime/setTimestamp}의 달력 인자와
     * {@code getDate/getTime/getTimestamp}의 달력 인자를 모두 지원한다.</p>
     *
     * @param v 원본 날짜시간 값
     * @param calendar 변환 기준이 되는 달력. {@code null}이면 오류이다
     * @param output {@code true}이면 DB 값에서 달력 기준으로, {@code false}이면 입력 값을 달력 기준으로 읽는다
     * @return 변환된 날짜시간 값
     * @throws SQLException 달력이 {@code null}일 때
     */
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
    /**
     * 서버 컬럼 메타데이터 한 개를 해석한 결과이다.
     * <p>표시 크기·정밀도·스케일의 JDBC 메타데이터 계산에 사용한다.</p>
     */
    static final class Column {
        /** 결과 집합에 노출되는 컬럼 이름이다. */
        final String name;
        /** 서버가 보낸 원래 선언 문자열(예: {@code VARCHAR(100)})이다. */
        final String declared;
        /** 정규화된 타입 이름이다. */
        final String typeName;
        /** {@link Types} 상수이다. */
        final int type;
        /** 표시 크기·정밀도이다. */
        final int precision;
        /** 소수 자릿수이다. */
        final int scale;
        /**
         * 서버 응답 맵에서 컬럼 정보를 읽는다.
         *
         * @param m 서버가 보낸 컬럼 정의 맵
         */
        Column(Map<String, Object> m) {
            name = String.valueOf(m.get("name")); declared = String.valueOf(m.get("declared")); typeName = String.valueOf(m.get("typeName")); type = sqlType(typeName);
            precision = number(m, "length", number(m, "precision", defaultPrecision(type, number(m, "fractionalPrecision", 0))));
            scale = number(m, "scale", number(m, "fractionalPrecision", 0));
        }
        /**
         * 이름과 선언 문자열에서 컬럼 정보를 만든다.
         * <p>메타데이터 보완용으로 {@code DatabaseMetaData}에서 사용한다.</p>
         *
         * @param name 컬럼 이름
         * @param declared 선언 문자열(예: {@code DECIMAL(10,3)})
         */
        Column(String name, String declared) { this(declaration(name, declared)); }
        /**
         * 숫자 필드를 읽는다.
         *
         * @param m 읽을 맵
         * @param key 필드 이름
         * @param fallback 값이 없을 때의 기본값
         * @return 숫자 필드 값 또는 기본값
         */
        private static int number(Map<String, Object> m, String key, int fallback) { return m.get(key) instanceof Number ? ((Number) m.get(key)).intValue() : fallback; }
        /**
         * 타입별 기본 정밀도를 계산한다.
         *
         * @param type {@link Types} 상수
         * @param f 소수 초 자릿수
         * @return 표시 크기로 쓸 정밀도
         */
        private static int defaultPrecision(int type, int f) {
            switch (type) {
            case Types.SMALLINT: return 5; case Types.INTEGER: return 10; case Types.BIGINT: return 19;
            case Types.REAL: return 7; case Types.DOUBLE: return 15; case Types.BOOLEAN: return 1; case Types.DATE: return 10;
            case Types.TIME: return 8 + (f > 0 ? f + 1 : 0); case Types.TIME_WITH_TIMEZONE: return 14 + (f > 0 ? f + 1 : 0);
            case Types.TIMESTAMP: return 19 + (f > 0 ? f + 1 : 0); case Types.TIMESTAMP_WITH_TIMEZONE: return 25 + (f > 0 ? f + 1 : 0); default: return 0;
            }
        }
        /**
         * 이름·선언 문자열을 서버 응답과 같은 맵 형태로 만든다.
         *
         * @param name 컬럼 이름
         * @param declared 선언 문자열
         * @return 서버 응답 형식의 컬럼 정의 맵
         */
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
