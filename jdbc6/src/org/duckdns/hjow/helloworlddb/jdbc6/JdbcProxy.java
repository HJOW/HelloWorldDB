package org.duckdns.hjow.helloworlddb.jdbc6;

import java.lang.reflect.*;
import java.sql.*;

/** 인터페이스의 지원하지 않는 메서드도 항상 명시적인 JDBC 오류를 내도록 한다.
 *
 * <p>JDBC 인터페이스를 동적 프록시로 구현하기 위한 뼈대이다.
 * {@code Object} 메서드와 {@code Wrapper} 메서드는 여기서 처리하고,
 * 나머지 호출은 하위 클래스의 {@link #call(String, Object[], java.lang.reflect.Method)}로 넘긴다.
 * 상위 자바 런타임에 추가된 JDBC 메서드가 들어와도 프록시가 그대로 받아내므로
 * {@code AbstractMethodError} 없이 동작한다.</p> */
abstract class JdbcProxy implements InvocationHandler {
    /** 동적 프록시로 만든 외부 공개 객체. 하위 클래스가 만든 뒤 보관한다. */
    Object proxy;
    /** 주어진 JDBC 인터페이스의 동적 프록시를 만들고 {@link #proxy}에 보관한다.
     *
     * @param <T> 만들 인터페이스 종류
     * @param type 만들 인터페이스의 클래스 객체
     * @return 새로 만든 프록시 객체 */
    final <T> T create(Class<T> type) { proxy = Proxy.newProxyInstance(Driver.class.getClassLoader(), new Class<?>[] { type }, this); return type.cast(proxy); }
    /** 프록시로 들어온 모든 호출을 분배한다.
     *
     * <p>{@code toString}, {@code hashCode}, {@code equals}는 프록시 자체 기준으로 처리하고,
     * {@code isWrapperFor}와 {@code unwrap}은 JDBC 래퍼 규약대로 처리한다.
     * 그 밖의 호출은 {@link #call}에 넘기며, {@link java.sql.SQLException}이 아닌
     * 예외는 SQLSTATE {@code HY000}으로 감싼다.</p>
     *
     * @param p 호출된 프록시 객체
     * @param method 호출된 메서드
     * @param args 호출 인자. 없으면 {@code null}이다
     * @return 호출 결과
     * @throws Throwable 하위 구현이 던진 예외 */
    @Override public final Object invoke(Object p, Method method, Object[] args) throws Throwable {
        String name = method.getName(); Object[] a = args == null ? new Object[0] : args;
        if (method.getDeclaringClass() == Object.class) {
            if (name.equals("toString")) return getClass().getSimpleName();
            if (name.equals("hashCode")) return System.identityHashCode(p);
            if (name.equals("equals")) return p == a[0];
        }
        if (name.equals("isWrapperFor") || name.equals("unwrap")) {
            boolean match = a[0] instanceof Class<?> && ((Class<?>) a[0]).isInstance(p);
            if (name.equals("isWrapperFor")) return match;
            if (match) return p; throw new SQLException("Not a wrapper for the requested interface.", "HY000");
        }
        try { return call(name, a, method); }
        catch (SQLException e) { throw e; }
        catch (Exception e) { throw new SQLException("JDBC operation failed: " + name, "HY000", e); }
    }
    /** 하위 클래스가 실제 JDBC 호출을 처리하는 분기 메서드.
     *
     * @param name 호출된 메서드 이름
     * @param args 호출 인자. 없으면 빈 배열이다
     * @param method 호출된 메서드 객체
     * @return 호출 결과
     * @throws Exception 처리 실패. {@link java.sql.SQLException}은 그대로 전달된다 */
    abstract Object call(String name, Object[] args, Method method) throws Exception;
    /** 지원하지 않는 기능에 쓸 JDBC 4.0 오류를 만든다.
     *
     * @param name 지원하지 않는 기능의 이름
     * @return SQLSTATE {@code 0A000}의 {@link SQLFeatureNotSupportedException} */
    static SQLFeatureNotSupportedException unsupported(String name) { return new SQLFeatureNotSupportedException("Unsupported JDBC feature: " + name, "0A000"); }
    /** 잘못된 인자에 쓸 JDBC 오류를 만든다.
     *
     * @param message 오류 메시지
     * @return SQLSTATE {@code 22023}의 {@link SQLException} */
    static SQLException invalid(String message) { return new SQLException(message, "22023"); }
    /** 식별자를 큰따옴표로 감싸 SQL에 안전히 넣을 수 있게 한다.
     *
     * @param identifier 감쌀 식별자
     * @return 큰따옴표로 감싼 식별자. 안의 큰따옴표는 두 개로 늘린다
     * @throws SQLException 식별자가 {@code null}이거나 빈 문자열인 경우 */
    static String quote(String identifier) throws SQLException { if (identifier == null || identifier.isEmpty()) throw invalid("Empty identifier."); return "\"" + identifier.replace("\"", "\"\"") + "\""; }
}
