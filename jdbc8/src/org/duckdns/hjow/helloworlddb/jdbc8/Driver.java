package org.duckdns.hjow.helloworlddb.jdbc8;

import java.net.URI;
import java.net.URLDecoder;
import java.sql.*;
import java.util.*;
import java.util.logging.Logger;
import org.duckdns.hjow.helloworlddb.jdbc8.protocol.*;

/**
 * Java 8 이상용 JDBC 4.2 드라이버이다.
 * <p>서비스 로딩과 명시적 로딩을 모두 지원하며,
 * {@code jdbc:helloworlddb://호스트[:포트][?옵션]} 형식의 URL을 처리한다.
 * 접속 정보에 SID나 데이터베이스 이름은 없으며 호스트와 포트 번호만으로
 * 인스턴스를 지정한다.</p>
 */
public final class Driver implements java.sql.Driver {
    /**
     * 이 드라이버가 처리하는 JDBC URL 접두사이다.
     */
    public static final String PREFIX = "jdbc:helloworlddb:";
    /** 클래스 로딩 시점에 드라이버를 등록한다. */
    static { try { DriverManager.registerDriver(new Driver()); } catch (SQLException e) { throw new ExceptionInInitializerError(e); } }
    /**
     * URL을 이 드라이버가 처리할 수 있는지 확인한다.
     *
     * @param url 확인할 JDBC URL
     * @return 접두사가 일치하면 {@code true}
     * @throws SQLException 오류가 나지 않으며 선언만 한다
     */
    @Override public boolean acceptsURL(String url) { return url != null && url.startsWith(PREFIX); }
    /**
     * URL과 접속 속성으로 서버에 연결한다.
     * <p>전송로(TCP/UDP)를 열고 핸드셰이크·인증 뒤
     * {@link JdbcConnection}을 반환한다. 실패하면 연 연결을 끊는다.</p>
     *
     * @param url JDBC URL
     * @param info 사용자명, 비밀번호, 전송·TLS·제한 시간 등의 접속 속성
     * @return 연결된 {@link Connection}. URL이 대상이 아니면 {@code null}
     * @throws SQLException URL 오류, 인증 실패, 접속 실패 시
     */
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
    /**
     * 연결 속성 목록과 현재 값을 설명한다.
     *
     * @param url JDBC URL
     * @param info 호출자가 준 접속 속성
     * @return 각 접속 키에 대한 설명 배열
     * @throws SQLException URL 파싱 실패 시
     */
    @Override public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) throws SQLException {
        List<DriverPropertyInfo> list = new ArrayList<>();
        for (String key : Options.KEYS) {
            DriverPropertyInfo p = new DriverPropertyInfo(key, key.equals("password") ? null : info == null ? null : info.getProperty(key));
            p.required = key.equals("user"); p.description = "HelloWorldDB connection property: " + key; list.add(p);
        }
        return list.toArray(new DriverPropertyInfo[0]);
    }
    /**
     * 드라이버 주 버전을 반환한다.
     *
     * @return 주 버전 0
     */
    @Override public int getMajorVersion() { return 0; }
    /**
     * 드라이버 부 버전을 반환한다.
     *
     * @return 부 버전 1
     */
    @Override public int getMinorVersion() { return 1; }
    /**
     * JDBC 완전 준수 여부를 반환한다.
     *
     * @return 완전 준수를 주장하지 않으므로 항상 {@code false}
     */
    @Override public boolean jdbcCompliant() { return false; }
    /**
     * 드라이버 로그의 부모 로거를 반환한다.
     *
     * @return 드라이버 패키지의 로거
     */
    @Override public Logger getParentLogger() { return Logger.getLogger("org.duckdns.hjow.helloworlddb.jdbc8"); }
    /**
     * JDBC URL과 접속 속성을 파싱한 결과이다.
     * <p>호스트, 포트, 사용자, 전송 방식, TLS, 제한 시간, fetch 크기,
     * 현재 테이블스페이스와 타임존을 보관한다.</p>
     */
    static final class Options {
        /** 허용되는 접속 속성 키 목록이다. */
        static final List<String> KEYS = Arrays.asList("user", "password", "transport", "ssl", "sslCa", "sslVerify", "sslMinVersion", "connectTimeoutMs", "socketTimeoutMs", "fetchSize", "tablespace", "timeZone");
        /** TLS 최소 버전. 기본 TLSv1.2 이며 Java 6 사용자는 TLSv1 을 명시한다. (J-6) */
        final String sslMinVersion;

        /**
         * URL 질의의 키나 값을 퍼센트 디코딩한다. {@code +} 는 공백이 아니라 문자 그대로 {@code +} 이다.
         * 공백은 {@code %20} 으로 적는다. (J-5 : 비밀번호의 {@code +} 가 바뀌지 않게 한다)
         */
        static String decodeQuery(String text) throws java.io.UnsupportedEncodingException {
            return URLDecoder.decode(text.replace("+", "%2B"), "UTF-8");
        }
        /** 원본 JDBC URL이다. */
        final String url;
        /** 접속 호스트이다. */
        final String host;
        /** 접속 사용자명이다. */
        final String user;
        /** 접속 비밀번호이다. */
        final String password;
        /** 서버 검증용 CA 인증서 경로이다. {@code null}이면 기본 CA를 쓴다. */
        final String ca;
        /** 접속 직후의 현재 테이블스페이스이다. {@code null}이면 지정하지 않는다. */
        final String tablespace;
        /** 세션 타임존이다. {@code null}이면 지정하지 않는다. */
        final String timeZone;
        /** 접속 포트 번호이다. */
        final int port;
        /** 연결 제한 시간(밀리초)이다. */
        final int connectTimeout;
        /** 소켓 응답 대기 제한 시간(밀리초)이다. */
        final int timeout;
        /** 조회 결과의 기본 묶음 크기이다. */
        final int fetchSize;
        /** {@code true}이면 UDP 전송로를 쓴다. */
        final boolean udp;
        /** {@code true}이면 TLS로 연결한다. */
        final boolean ssl;
        /** {@code true}이면 서버 인증서를 검증한다. */
        final boolean verify;
        /**
         * URL과 속성에서 접속 옵션을 파싱한다.
         *
         * @param url JDBC URL
         * @param input 호출자가 준 접속 속성. {@code null}일 수 있다
         * @throws SQLException 필수 사용자 누락, 알 수 없는 속성, 형식 오류 시
         */
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
        /**
         * 불리언 속성을 읽는다.
         *
         * @param p 속성 맵
         * @param key 키 이름
         * @param fallback 값이 없을 때의 기본값
         * @return 파싱된 불리언 값
         */
        private static boolean bool(Properties p, String key, boolean fallback) {
            String value = p.getProperty(key, String.valueOf(fallback));
            if (!value.equals("true") && !value.equals("false")) throw new IllegalArgumentException(); return Boolean.parseBoolean(value);
        }
        /**
         * 정수 속성을 읽고 범위를 검사한다.
         *
         * @param p 속성 맵
         * @param key 키 이름
         * @param fallback 값이 없을 때의 기본값
         * @param min 허용 최소값
         * @param max 허용 최대값
         * @return 파싱된 정수 값
         */
        private static int integer(Properties p, String key, int fallback, int min, int max) {
            int n = Integer.parseInt(p.getProperty(key, String.valueOf(fallback))); if (n < min || n > max) throw new IllegalArgumentException(); return n;
        }
    }
}
