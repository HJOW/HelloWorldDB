package org.duckdns.hjow.helloworlddb.jdbc6;

import java.net.URI;
import java.net.URLDecoder;
import java.sql.*;
import java.util.*;
import java.util.logging.Logger;
import org.duckdns.hjow.helloworlddb.jdbc6.protocol.*;

/** Java 6 이상용 JDBC 4.0 드라이버. 서비스 로딩과 명시적 로딩을 모두 지원한다.
 *
 * <p>연결 주소(URL)는 {@code jdbc:helloworlddb://호스트[:포트][?속성]} 형태이며
 * SID나 데이터베이스 이름은 사용하지 않고 호스트와 포트 번호만으로 대상을 정한다.
 * 현재 테이블스페이스는 {@code tablespace} 속성으로 지정한다.
 * 드라이버 클래스가 처음 적재될 때 {@link java.sql.DriverManager}에 스스로 등록되므로
 * 서비스 자동 등록과 {@code Class.forName} 명시적 적재를 모두 사용할 수 있다.</p> */
public final class Driver implements java.sql.Driver {
    /** 이 드라이버가 처리하는 연결 주소의 접두사. */
    public static final String PREFIX = "jdbc:helloworlddb:";
    /** 드라이버를 {@link java.sql.DriverManager}에 등록하는 정적 초기화 블록.
     *
     * <p>클래스 적재 시 한 번 실행되며, 등록에 실패하면
     * {@link ExceptionInInitializerError}를 던져 적재 자체를 실패시킨다.</p> */
    static { try { DriverManager.registerDriver(new Driver()); } catch (SQLException e) { throw new ExceptionInInitializerError(e); } }
    /** 주어진 연결 주소가 이 드라이버의 형식인지 확인한다.
     *
     * @param url 확인할 연결 주소. {@code null}일 수 있다
     * @return 주소가 {@link #PREFIX}로 시작하면 {@code true}, 아니면 {@code false} */
    @Override public boolean acceptsURL(String url) { return url != null && url.startsWith(PREFIX); }
    /** 연결 주소와 속성을 해석하여 HelloWorldDB 서버에 접속하고 인증한다.
     *
     * <p>{@code transport} 속성이 {@code udp}이면 UDP로, 아니면 TCP로 연결한다.
     * TCP에 {@code ssl} 속성을 켜면 TLS로 연결한다.
     * SCRAM-SHA-256 인증을 마친 뒤 현재 테이블스페이스와 시간대를 적용하고
     * 새 JDBC 연결 객체를 돌려준다.</p>
     *
     * @param url 연결 주소. {@link #acceptsURL(String)}이 {@code false}이면 {@code null}을 돌려준다
     * @param info 사용자명, 비밀번호, 전송 방식, 시간 제한 등의 연결 속성
     * @return 접속된 JDBC 연결. 이 드라이버의 주소가 아니면 {@code null}
     * @throws SQLException 주소 형식이 잘못되었거나 접속·인증에 실패한 경우 */
    @Override public Connection connect(String url, Properties info) throws SQLException {
        if (!acceptsURL(url)) return null;
        Options o = new Options(url, info);
        Protocol protocol = null;
        try {
            Transport transport = o.udp ? new UdpTransport(o.host, o.port) : TcpTransport.open(o.host, o.port, o.connectTimeout, o.ssl, o.ca, o.verify, o.sslMinVersion);
            protocol = new Protocol(transport, o.connectTimeout);
            protocol.login(o.user, o.password, o.tablespace, o.timeZone); protocol.setTimeout(o.timeout);
            return JdbcConnection.open(protocol, o);
        } catch (SQLException e) { if (protocol != null) protocol.abort(); throw e; }
        catch (Exception e) {
            if (protocol != null) protocol.abort();
            throw new SQLException(e.getMessage(), e instanceof TcpTransport.CertificateFailure ? "08001" : "08006", e instanceof TcpTransport.CertificateFailure ? 8007 : 8006, e);
        }
    }
    /** 연결에 사용할 수 있는 속성 목록과 현재 값을 설명한다.
     *
     * @param url 연결 주소. 속성 해석에는 쓰이지 않는다
     * @param info 현재 설정된 연결 속성. {@code null}일 수 있다
     * @return 지원하는 속성 키마다 만든 {@link DriverPropertyInfo} 배열
     * @throws SQLException 속성 처리에 실패한 경우 */
    @Override public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) throws SQLException {
        List<DriverPropertyInfo> list = new ArrayList<DriverPropertyInfo>();
        for (String key : Options.KEYS) {
            DriverPropertyInfo p = new DriverPropertyInfo(key, key.equals("password") ? null : info == null ? null : info.getProperty(key));
            p.required = key.equals("user"); p.description = "HelloWorldDB connection property: " + key; list.add(p);
        }
        return list.toArray(new DriverPropertyInfo[0]);
    }
    /** 드라이버 주 버전을 돌려준다.
     *
     * @return 드라이버 주 버전(0) */
    @Override public int getMajorVersion() { return 0; }
    /** 드라이버 부 버전을 돌려준다.
     *
     * @return 드라이버 부 버전(1) */
    @Override public int getMinorVersion() { return 1; }
    /** JDBC 완전 준수 여부를 돌려준다.
     *
     * @return 완전 준수를 주장하지 않으므로 항상 {@code false} */
    @Override public boolean jdbcCompliant() { return false; }
    /** 이 드라이버가 사용하는 로거를 돌려준다.
     *
     * <p>JDBC 4.0의 {@code java.sql.Driver}에는 없는 메서드이며,
     * 상위 자바 런타임(JDBC 4.1 이상)에서 호출될 때를 대비하여 제공한다.</p>
     *
     * @return 드라이버 패키지의 {@link Logger} */
    public Logger getParentLogger() { return Logger.getLogger("org.duckdns.hjow.helloworlddb.jdbc6"); }
    /** 연결 주소와 속성을 해석한 결과. {@link Driver#connect}가 검증한 값을 보관한다. */
    static final class Options {
        /** 지원하는 연결 속성 이름 목록. */
        static final List<String> KEYS = Arrays.asList("user", "password", "transport", "ssl", "sslCa", "sslVerify", "sslMinVersion", "connectTimeoutMs", "socketTimeoutMs", "fetchSize", "tablespace", "timeZone");

        /**
         * URL 질의의 키나 값을 퍼센트 디코딩한다. {@code +} 는 공백이 아니라 문자 그대로 {@code +} 이다.
         * 공백은 {@code %20} 으로 적는다. (J-5 : 비밀번호의 {@code +} 가 바뀌지 않게 한다)
         */
        static String decodeQuery(String text) throws java.io.UnsupportedEncodingException {
            return URLDecoder.decode(text.replace("+", "%2B"), "UTF-8");
        }

        /** 원본 연결 주소, 접속 호스트, 사용자명, 비밀번호, CA 경로, 현재 테이블스페이스, 시간대. */
        final String url, host, user, password, ca, tablespace, timeZone;
        /** TLS 최소 버전. 기본 TLSv1.2 이며 Java 6 사용자는 TLSv1 을 명시한다. (J-6) */
        final String sslMinVersion;
        /** 포트 번호, 접속 제한 시간, 소켓 제한 시간, fetch 크기. */
        final int port, connectTimeout, timeout, fetchSize;
        /** UDP 사용, SSL 사용, 서버 인증서 검증 여부. */
        final boolean udp, ssl, verify;
        /** 연결 주소와 속성을 해석하고 유효성을 검사하여 보관한다.
         *
         * @param url 연결 주소 원문
         * @param input 호출자가 넘긴 연결 속성. {@code null}일 수 있다
         * @throws SQLException 주소 형식이 잘못되었거나 필수 속성이 없거나 알 수 없는 속성이 있는 경우 */
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
                    p.setProperty(decodeQuery(kv[0]), decodeQuery(kv[1]));
                }
                for (String key : p.stringPropertyNames()) if (!KEYS.contains(key)) throw new SQLException("Unknown connection property: " + key, "08001");
                user = p.getProperty("user"); password = p.getProperty("password", "");
                if (user == null || user.isEmpty()) throw new SQLException("The user property is required.", "28000");
                String transport = p.getProperty("transport", "tcp");
                if (!transport.equals("tcp") && !transport.equals("udp")) throw new IllegalArgumentException();
                udp = transport.equals("udp"); ssl = bool(p, "ssl", false); verify = bool(p, "sslVerify", true); ca = p.getProperty("sslCa");
                sslMinVersion = p.getProperty("sslMinVersion", TcpTransport.DEFAULT_TLS_MIN_VERSION);
                if (!TcpTransport.isTlsVersion(sslMinVersion)) throw new IllegalArgumentException();
                if (udp && ssl || (ca != null || !verify) && !ssl || ca != null && !verify) throw new IllegalArgumentException();
                connectTimeout = integer(p, "connectTimeoutMs", DriverManager.getLoginTimeout() > 0 ? (int) Math.min(Integer.MAX_VALUE, DriverManager.getLoginTimeout() * 1000L) : 10000, 1, Integer.MAX_VALUE);
                timeout = integer(p, "socketTimeoutMs", 30000, 0, Integer.MAX_VALUE); fetchSize = integer(p, "fetchSize", 500, 1, 100000);
                tablespace = p.getProperty("tablespace"); timeZone = p.getProperty("timeZone");
            } catch (SQLException e) { throw e; } catch (Exception e) { throw new SQLException("Invalid HelloWorldDB URL or connection properties.", "08001", e); }
        }
        /** 논리값 속성을 읽는다. {@code true}나 {@code false}가 아니면 예외를 낸다.
         *
         * @param p 속성 집합
         * @param key 속성 이름
         * @param fallback 속성이 없을 때의 기본값
         * @return 해석된 논리값 */
        private static boolean bool(Properties p, String key, boolean fallback) {
            String value = p.getProperty(key, String.valueOf(fallback));
            if (!value.equals("true") && !value.equals("false")) throw new IllegalArgumentException(); return Boolean.parseBoolean(value);
        }
        /** 정수 속성을 읽고 허용 범위 안에 드는지 검사한다.
         *
         * @param p 속성 집합
         * @param key 속성 이름
         * @param fallback 속성이 없을 때의 기본값
         * @param min 허용 최소값
         * @param max 허용 최대값
         * @return 해석된 정수값 */
        private static int integer(Properties p, String key, int fallback, int min, int max) {
            int n = Integer.parseInt(p.getProperty(key, String.valueOf(fallback))); if (n < min || n > max) throw new IllegalArgumentException(); return n;
        }
    }
}
