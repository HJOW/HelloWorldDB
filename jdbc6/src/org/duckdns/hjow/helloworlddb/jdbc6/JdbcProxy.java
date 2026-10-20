package org.duckdns.hjow.helloworlddb.jdbc6;

import java.lang.reflect.*;
import java.sql.*;

/** 인터페이스의 지원하지 않는 메서드도 항상 명시적인 JDBC 오류를 내도록 한다. */
abstract class JdbcProxy implements InvocationHandler {
    Object proxy;
    final <T> T create(Class<T> type) { proxy = Proxy.newProxyInstance(Driver.class.getClassLoader(), new Class<?>[] { type }, this); return type.cast(proxy); }
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
    abstract Object call(String name, Object[] args, Method method) throws Exception;
    static SQLFeatureNotSupportedException unsupported(String name) { return new SQLFeatureNotSupportedException("Unsupported JDBC feature: " + name, "0A000"); }
    static SQLException invalid(String message) { return new SQLException(message, "22023"); }
    static String quote(String identifier) throws SQLException { if (identifier == null || identifier.isEmpty()) throw invalid("Empty identifier."); return "\"" + identifier.replace("\"", "\"\"") + "\""; }
}
