package org.duckdns.hjow.helloworlddb.jdbc6;

import java.net.URI;
import java.net.URLDecoder;
import java.sql.*;
import java.util.*;
import java.util.logging.Logger;
import org.duckdns.hjow.helloworlddb.jdbc6.protocol.*;

/** Java 6 이상용 JDBC 4.0 드라이버. 서비스 로딩과 명시적 로딩을 모두 지원한다. */
public final class Driver implements java.sql.Driver {
    public static final String PREFIX = "jdbc:helloworlddb:";
    static { try { DriverManager.registerDriver(new Driver()); } catch (SQLException e) { throw new ExceptionInInitializerError(e); } }
    @Override public boolean acceptsURL(String url) { return url != null && url.startsWith(PREFIX); }
    @Override public Connection connect(String url, Properties info) throws SQLException {
        if (!acceptsURL(url)) return null;
        Options o = new Options(url, info);
        Protocol protocol = null;
        try {
            Transport transport = o.udp ? new UdpTransport(o.host, o.port) : TcpTransport.open(o.host, o.port, o.connectTimeout, o.ssl, o.ca, o.verify);
            protocol = new Protocol(transport, o.connectTimeout);
            protocol.login(o.user, o.password, o.tablespace, o.timeZone); protocol.setTimeout(o.timeout);
            return JdbcConnection.open(protocol, o);
        } catch (SQLException e) { if (protocol != null) protocol.abort(); throw e; }
        catch (Exception e) {
            if (protocol != null) protocol.abort();
            throw new SQLException(e.getMessage(), e instanceof TcpTransport.CertificateFailure ? "08001" : "08006", e instanceof TcpTransport.CertificateFailure ? 8007 : 8006, e);
        }
    }
    @Override public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) throws SQLException {
        List<DriverPropertyInfo> list = new ArrayList<DriverPropertyInfo>();
        for (String key : Options.KEYS) {
            DriverPropertyInfo p = new DriverPropertyInfo(key, key.equals("password") ? null : info == null ? null : info.getProperty(key));
            p.required = key.equals("user"); p.description = "HelloWorldDB connection property: " + key; list.add(p);
        }
        return list.toArray(new DriverPropertyInfo[0]);
    }
    @Override public int getMajorVersion() { return 0; }
    @Override public int getMinorVersion() { return 1; }
    @Override public boolean jdbcCompliant() { return false; }
    public Logger getParentLogger() { return Logger.getLogger("org.duckdns.hjow.helloworlddb.jdbc6"); }
    static final class Options {
        static final List<String> KEYS = Arrays.asList("user", "password", "transport", "ssl", "sslCa", "sslVerify", "connectTimeoutMs", "socketTimeoutMs", "fetchSize", "tablespace", "timeZone");
        final String url, host, user, password, ca, tablespace, timeZone;
        final int port, connectTimeout, timeout, fetchSize; final boolean udp, ssl, verify;
        Options(String url, Properties input) throws SQLException {
            this.url = url;
            Properties p = new Properties(); if (input != null) p.putAll(input);
            try {
                URI uri = new URI(url.substring(5));
                if (!uri.getScheme().equals("helloworlddb") || uri.getHost() == null || uri.getUserInfo() != null || uri.getFragment() != null
                    || (uri.getPath() != null && !uri.getPath().isEmpty() && !uri.getPath().equals("/"))) throw new IllegalArgumentException();
                host = uri.getHost().replace("[", "").replace("]", ""); port = uri.getPort() == -1 ? 7410 : uri.getPort();
                if (port < 1 || port > 65535) throw new IllegalArgumentException();
                if (uri.getRawQuery() != null) for (String pair : uri.getRawQuery().split("&", -1)) {
                    String[] kv = pair.split("=", 2); if (kv.length != 2) throw new IllegalArgumentException();
                    p.setProperty(URLDecoder.decode(kv[0], "UTF-8"), URLDecoder.decode(kv[1], "UTF-8"));
                }
                for (String key : p.stringPropertyNames()) if (!KEYS.contains(key)) throw new SQLException("Unknown connection property: " + key, "08001");
                user = p.getProperty("user"); password = p.getProperty("password", "");
                if (user == null || user.isEmpty()) throw new SQLException("The user property is required.", "28000");
                String transport = p.getProperty("transport", "tcp");
                if (!transport.equals("tcp") && !transport.equals("udp")) throw new IllegalArgumentException();
                udp = transport.equals("udp"); ssl = bool(p, "ssl", false); verify = bool(p, "sslVerify", true); ca = p.getProperty("sslCa");
                if (udp && ssl || (ca != null || !verify) && !ssl || ca != null && !verify) throw new IllegalArgumentException();
                connectTimeout = integer(p, "connectTimeoutMs", DriverManager.getLoginTimeout() > 0 ? (int) Math.min(Integer.MAX_VALUE, DriverManager.getLoginTimeout() * 1000L) : 10000, 1, Integer.MAX_VALUE);
                timeout = integer(p, "socketTimeoutMs", 30000, 0, Integer.MAX_VALUE); fetchSize = integer(p, "fetchSize", 500, 1, 100000);
                tablespace = p.getProperty("tablespace"); timeZone = p.getProperty("timeZone");
            } catch (SQLException e) { throw e; } catch (Exception e) { throw new SQLException("Invalid HelloWorldDB URL or connection properties.", "08001", e); }
        }
        private static boolean bool(Properties p, String key, boolean fallback) {
            String value = p.getProperty(key, String.valueOf(fallback));
            if (!value.equals("true") && !value.equals("false")) throw new IllegalArgumentException(); return Boolean.parseBoolean(value);
        }
        private static int integer(Properties p, String key, int fallback, int min, int max) {
            int n = Integer.parseInt(p.getProperty(key, String.valueOf(fallback))); if (n < min || n > max) throw new IllegalArgumentException(); return n;
        }
    }
}
