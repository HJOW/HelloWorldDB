package org.duckdns.hjow.helloworlddb.jdbc8;

import java.lang.reflect.*;
import java.sql.*;

/**
 * 인터페이스의 지원하지 않는 메서드도 항상 명시적인 JDBC 오류를 내도록 하는 동적 프록시 기반 클래스이다.
 * <p>{@link Connection}, {@link Statement}, {@link ResultSet} 등의 JDBC 인터페이스를
 * {@link Proxy}로 구현하고, 메서드 이름으로 분기하는 {@link #call}로 실제 동작을 처리한다.
 * {@link Object} 메서드와 {@code unwrap}/{@code isWrapperFor}는 공통으로 처리한다.</p>
 */
abstract class JdbcProxy implements InvocationHandler {
    /**
     * 이 프록시가 감싸고 있는 실제 JDBC 인터페이스 인스턴스이다.
     * <p>외부에는 이 필드가 아닌 프록시 객체가 반환된다.</p>
     */
    Object proxy;
    /**
     * 현재 객체를 지정한 JDBC 인터페이스의 프록시로 감싼다.
     *
     * @param <T> 감쌀 JDBC 인터페이스 종류
     * @param type 감쌀 인터페이스 클래스
     * @return 프록시 인스턴스
     */
    final <T> T create(Class<T> type) { proxy = Proxy.newProxyInstance(Driver.class.getClassLoader(), new Class<?>[] { type }, this); return type.cast(proxy); }
    /**
     * 프록시 호출의 실제 진입점이다.
     *
     * @param p 프록시 객체
     * @param method 호출된 메서드
     * @param args 호출 인자
     * @return 메서드 반환 값
     * @throws Throwable JDBC 오류
     */
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
    /**
     * 메서드 이름으로 분기하는 실제 구현이다.
     * <p>하위 클래스에서 JDBC 인터페이스별로 오버라이드한다.</p>
     *
     * @param name 호출된 메서드 이름
     * @param args 호출 인자(빈 배열일 수 있다)
     * @param method 호출된 메서드 리플렉션 정보
     * @return 메서드 반환 값
     * @throws Exception JDBC 오류를 포함한 모든 처리 오류
     */
    abstract Object call(String name, Object[] args, Method method) throws Exception;
    /**
     * 지원하지 않는 JDBC 기능을 알리는 오류를 생성한다.
     *
     * @param name 지원하지 않는 기능·메서드 이름
     * @return SQLSTATE {@code 0A000}의 {@link SQLFeatureNotSupportedException}
     */
    static SQLFeatureNotSupportedException unsupported(String name) { return new SQLFeatureNotSupportedException("Unsupported JDBC feature: " + name, "0A000"); }
    /**
     * 잘못된 인자 값을 알리는 오류를 생성한다.
     *
     * @param message 오류 메시지
     * @return SQLSTATE {@code 22023}의 {@link SQLException}
     */
    static SQLException invalid(String message) { return new SQLException(message, "22023"); }
    /**
     * 식별자를 큰따옴표로 감싸 인용한다.
     *
     * @param identifier 테이블·컬럼 등의 식별자
     * @return 큰따옴표로 감싼 식별자
     * @throws SQLException 식별자가 비어 있을 때
     */
    static String quote(String identifier) throws SQLException { if (identifier == null || identifier.isEmpty()) throw invalid("Empty identifier."); return "\"" + identifier.replace("\"", "\"\"") + "\""; }
}
