package org.duckdns.hjow.helloworlddb.jdbc6;

import java.math.*;
import java.sql.*;
import java.util.*;
import java.util.regex.*;
import org.duckdns.hjow.helloworlddb.jdbc6.protocol.Json;

/** Java 6 표준 API만 사용하는 값 변환. 오프셋 원문은 getString으로 보존한다.
 *
 * <p>HelloWorldDB 서버의 타입 이름과 JDBC 타입 코드 사이의 대응,
 * 서버가 보낸 JSON 값과 자바 객체 사이의 변환을 맡는다.
 * BIGINT는 정밀도 손실을 막기 위해 문자열로 주고받고,
 * WITH TIME ZONE 값의 오프셋 표기는 {@code getString} 계열에서 원문대로 돌려준다.
 * 모든 메서드는 정적이며 상태를 가지지 않는다.</p> */
final class Values {
    /** 인스턴스를 만들 수 없도록 막는 전용 생성자. */
    private Values() { }
    /** 서버의 타입 이름으로부터 JDBC 타입 코드를 구한다.
     *
     * @param name 서버 컬럼 메타데이터의 타입 이름(예: {@code VARCHAR}, {@code TIMESTAMP WITH TIME ZONE})
     * @return 대응하는 {@link java.sql.Types} 코드. 알 수 없는 타입은 {@code OTHER}이다 */
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
    /** JDBC 타입 코드로부터 값을 담을 자바 클래스를 구한다.
     *
     * @param type {@link java.sql.Types} 코드
     * @return 값을 담는 자바 클래스 */
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
    /** 서버가 보낸 JSON 값을 주어진 JDBC 타입의 자바 객체로 바꾼다.
     *
     * <p>이진 타입은 16진 문자열을 바이트 배열로 풀고, 나머지는
     * {@link #convert(Object, Class)}로 목표 클래스에 맞게 바꾼다.</p>
     *
     * @param value 서버가 보낸 JSON 값. {@code null}일 수 있다
     * @param type {@link java.sql.Types} 코드
     * @return 변환된 자바 객체. 입력이 {@code null}이면 {@code null}이다
     * @throws SQLException 값이 올바르지 않거나 바꿀 수 없는 경우 */
    static Object decode(Object value, int type) throws SQLException {
        if (value == null) return null;
        if (type == Types.BINARY || type == Types.VARBINARY) {
            String s = value.toString(); if (!s.matches("(?:[0-9A-Fa-f]{2})*")) throw new SQLException("Invalid binary value.", "22018");
            byte[] bytes = new byte[s.length() / 2]; for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16); return bytes;
        }
        return convert(value, javaType(type));
    }
    /** 바이트 배열을 대문자 16진 문자열로 바꾼다.
     *
     * @param bytes 바꿀 바이트 배열
     * @return 16진 문자열(대문자). 서버의 이진 값 표현과 같다 */
    static String hex(byte[] bytes) {
        char[] out = new char[bytes.length * 2]; String digits = "0123456789ABCDEF";
        for (int i = 0; i < bytes.length; i++) { out[i * 2] = digits.charAt((bytes[i] & 255) >>> 4); out[i * 2 + 1] = digits.charAt(bytes[i] & 15); } return new String(out);
    }
    /** 바인딩할 자바 값을 서버가 받는 JSON 표현으로 바꾼다.
     *
     * <p>문자열과 논리값은 그대로 두고, 바이트 배열은 16진 문자열을 담은 객체로,
     * 정수 계열과 {@link java.math.BigInteger}, {@link java.math.BigDecimal}은 10진 문자열로 바꾼다.
     * 날짜시간 값은 {@code toString} 형태의 문자열로 보낸다.</p>
     *
     * @param v 바인딩할 자바 값. {@code null}일 수 있다
     * @return 서버에 보낼 JSON 값
     * @throws SQLException 무한대·NaN 같은 보낼 수 없는 값이거나 지원하지 않는 종류인 경우 */
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
    /** {@code setObject}로 받은 값을 목표 SQL 타입에 맞게 바꾼다.
     *
     * <p>JDBC 4.0의 {@code setObject(인덱스, 값, 목표타입[, 자릿수])} 처리에 쓰며,
     * NUMERIC 계열에 자릿수가 지정되면 반올림을 적용한다.</p>
     *
     * @param value 바꿀 값. {@code null}일 수 있다
     * @param type 목표 {@link java.sql.Types} 코드
     * @param scale NUMERIC 계열의 소수 자릿수. {@code null}이면 자릿수 조정을 하지 않는다
     * @return 목표 타입에 맞게 바뀐 값
     * @throws SQLException 목표 타입을 지원하지 않는 경우 */
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
    /** 임의의 값을 10진 정확 연산용 {@link java.math.BigDecimal}로 바꾼다.
     *
     * @param v 바꿀 값. 논리값은 1 또는 0으로 바꾼다
     * @return 바뀐 10진수 */
    private static BigDecimal decimal(Object v) { return v instanceof Boolean ? (Boolean.TRUE.equals(v) ? BigDecimal.ONE : BigDecimal.ZERO) : new BigDecimal(v.toString()); }
    /** 값을 목표 자바 클래스로 바꾼다.
     *
     * <p>문자열, 정수·부동소수·논리값, 날짜·시각·타임스탬프 사이의 변환을 처리한다.
     * WITH TIME ZONE 값의 오프셋과 소수 초는 문자열 변환에서 원문대로 유지된다.</p>
     *
     * @param v 바꿀 값. {@code null}일 수 있다
     * @param type 목표 클래스
     * @return 바뀐 값. 입력이 {@code null}이면 {@code null}이다
     * @throws SQLException 목표 클래스가 {@code null}이거나 값 범위를 넘거나 바꿀 수 없는 경우 */
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
    /** 날짜·시각 문자열을 목표 날짜시간 클래스의 객체로 해석한다.
     *
     * <p>{@code YYYY-MM-DD}, {@code HH:MI:SS}, 두 형식을 합친 형태와
     * 뒤에 붙는 시간대 오프셋({@code +HH:MM} 또는 {@code Z})을 받는다.
     * 소수 초는 최대 9자리까지 나노초로 보관한다.</p>
     *
     * @param text 해석할 날짜·시각 문자열
     * @param type 목표 클래스({@code Date}, {@code Time}, {@code Timestamp} 중 하나)
     * @return 해석된 날짜시간 객체 */
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
    /** 날짜시간 값을 주어진 달력의 시간대로 옮긴 값을 구한다.
     *
     * <p>{@code getDate}, {@code getTime}, {@code getTimestamp}의 달력 지정 호출과
     * {@code setDate}, {@code setTime}, {@code setTimestamp}의 달력 지정 호출에 함께 쓰며,
     * 읽을 때와 쓸 때의 달력 적용 방향이 반대이다.</p>
     *
     * @param value 옮길 날짜시간 값
     * @param calendar 적용할 달력
     * @param output {@code true}이면 결과값을 달력 시간대로, {@code false}이면 입력값을 달력 시간대로 해석한다
     * @return 시간대를 옮긴 날짜시간 객체. 입력이 {@code null}이면 {@code null}이다
     * @throws SQLException 달력이 {@code null}인 경우 */
    static Object calendarValue(Object value, Calendar calendar, boolean output) throws SQLException {
        if (value == null) return null; if (calendar == null) throw JdbcProxy.invalid("Calendar is null.");
        Calendar source = Calendar.getInstance(output ? TimeZone.getDefault() : calendar.getTimeZone()); source.setTimeInMillis(((java.util.Date) value).getTime());
        Calendar target = Calendar.getInstance(output ? calendar.getTimeZone() : TimeZone.getDefault()); target.clear(); target.setLenient(false);
        target.set(source.get(Calendar.YEAR), source.get(Calendar.MONTH), source.get(Calendar.DAY_OF_MONTH), source.get(Calendar.HOUR_OF_DAY), source.get(Calendar.MINUTE), source.get(Calendar.SECOND));
        long millis = target.getTimeInMillis();
        if (value instanceof java.sql.Date) return new java.sql.Date(millis); if (value instanceof Time) return new Time(millis);
        Timestamp ts = new Timestamp(millis); ts.setNanos(((Timestamp) value).getNanos()); return ts;
    }
    /** 서버 컬럼 메타데이터와 {@link java.sql.ResultSetMetaData}에 쓸 컬럼 설명.
     *
     * <p>서버가 보낸 컬럼 정보 맵이나 {@code 이름}/{@code 선언 문자열}로부터
     * JDBC에 필요한 타입 코드, 정밀도, 자릿수를 계산하여 보관한다.</p> */
    static final class Column {
        /** 컬럼 이름, 서버 선언 원문, 정규화된 타입 이름. */
        final String name, declared, typeName;
        /** JDBC 타입 코드, 정밀도(표시 길이), 소수 자릿수. */
        final int type, precision, scale, nullable;
        /** 서버 응답의 컬럼 정보 맵으로부터 설명을 만든다.
         *
         * @param m 서버가 보낸 컬럼 정보 맵 */
        Column(Map<String, Object> m) {
            name = String.valueOf(m.get("name")); declared = String.valueOf(m.get("declared")); typeName = String.valueOf(m.get("typeName")); type = sqlType(typeName);
            precision = number(m, "length", number(m, "precision", defaultPrecision(type, number(m, "fractionalPrecision", 0)))); scale = number(m, "scale", number(m, "fractionalPrecision", 0));
            nullable = "YES".equals(m.get("nullable")) ? ResultSetMetaData.columnNullable : "NO".equals(m.get("nullable")) ? ResultSetMetaData.columnNoNulls : ResultSetMetaData.columnNullableUnknown;
        }
        /** 컬럼 이름과 선언 문자열로부터 설명을 만든다.
         *
         * @param name 컬럼 이름
         * @param declared {@code VARCHAR(100)} 같은 타입 선언 문자열 */
        Column(String name, String declared) { this(declaration(name, declared)); }
        /** 맵에서 정수 값을 읽는다. 값이 없거나 숫자가 아니면 기본값을 돌려준다.
         *
         * @param m 값을 읽을 맵
         * @param key 읽을 키
         * @param fallback 기본값
         * @return 읽은 정수값 또는 기본값 */
        private static int number(Map<String, Object> m, String key, int fallback) { return m.get(key) instanceof Number ? ((Number) m.get(key)).intValue() : fallback; }
        /** 서버가 길이를 주지 않은 타입의 기본 표시 길이를 구한다.
         *
         * @param type JDBC 타입 코드
         * @param f 소수 초 자릿수
         * @return 기본 정밀도(표시 길이) */
        private static int defaultPrecision(int type, int f) {
            switch (type) {
            case Types.SMALLINT: return 5; case Types.INTEGER: return 10; case Types.BIGINT: return 19; case Types.REAL: return 7; case Types.DOUBLE: return 15; case Types.BOOLEAN: return 1; case Types.DATE: return 10;
            case Types.TIME: return 8 + (f > 0 ? f + 1 : 0); case Types.TIMESTAMP: return 19 + (f > 0 ? f + 1 : 0); default: return 0;
            }
        }
        /** 선언 문자열을 서버 응답과 같은 형태의 컬럼 정보 맵으로 바꾼다.
         *
         * @param name 컬럼 이름
         * @param declared 타입 선언 문자열
         * @return 이름, 타입 이름, 길이·정밀도·자릿수를 담은 맵 */
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
