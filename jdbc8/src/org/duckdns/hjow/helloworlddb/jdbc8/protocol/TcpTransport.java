package org.duckdns.hjow.helloworlddb.jdbc8.protocol;

import java.io.*;
import java.net.*;
import java.security.*;
import java.security.cert.*;
import java.util.*;
import javax.net.ssl.*;

/**
 * TCP 프레임과 TLS 검증을 담당하는 전송 구현이다.
 * <p>4바이트 빅엔디언 길이에 JSON 본문을 붙인 프레임으로 메시지를 주고받는다.
 * 인증서 오류만 새 연결에서 100 ms 간격으로 최대 두 번 재시도하며,
 * 재시도 때도 인증서 검증을 그대로 유지한다.</p>
 */
public final class TcpTransport implements Transport {
    /** 연결된 TCP(또는 TLS) 소켓이다. */
    private final Socket socket;
    /** 길이·본문을 읽는 입력 스트림이다. */
    private final DataInputStream in;
    /** 길이·본문을 쓰는 출력 스트림이다. */
    private final DataOutputStream out;
    /** 수신·송신 한 메시지당 최대 바이트 수이다. */
    private volatile int limit = 65536;
    /**
     * 연결된 소켓으로 전송 객체를 만든다.
     *
     * @param socket 이미 연결된 소켓
     * @throws IOException 스트림을 열 수 없을 때
     */
    private TcpTransport(Socket socket) throws IOException { this.socket = socket; in = new DataInputStream(socket.getInputStream()); out = new DataOutputStream(socket.getOutputStream()); }
    /**
     * 서버에 TCP(필요하면 TLS)로 연결한다.
     * <p>소켓 연결 제한 시간과 읽기 제한 시간에 같은 값을 쓰며,
     * TLS를 쓰면 지원하는 TLS 프로토콜만 활성화한 뒤 핸드셰이크한다.
     * 인증서 경로 문제로 인한 오류는 최대 세 번까지 시도한다.</p>
     *
     * @param host 접속할 호스트명 또는 IP 주소
     * @param port 접속할 포트 번호
     * @param timeout 연결·읽기 제한 시간(밀리초)
     * @param ssl {@code true}이면 TLS로 연결한다
     * @param ca 서버 검증에 쓸 CA 인증서(PEM) 경로. {@code null}이면 기본 CA를 쓴다
     * @param verify {@code false}이면 서버 인증서 검증을 끈다
     * @return 연결된 전송 객체
     * @throws IOException 연결·핸드셰이크 실패 시
     * @throws GeneralSecurityException SSL 컨텍스트 구성 실패 시
     */
    public static TcpTransport open(String host, int port, int timeout, boolean ssl, String ca, boolean verify) throws IOException, GeneralSecurityException {
        for (int attempt = 1; ; attempt++) {
            Socket s = new Socket();
            try {
                s.connect(new InetSocketAddress(host, port), timeout); s.setSoTimeout(timeout); s.setTcpNoDelay(true); s.setKeepAlive(true);
                if (ssl) {
                    s = context(ca, verify).getSocketFactory().createSocket(s, host, port, true);
                    SSLSocket tls = (SSLSocket) s;
                    List<String> enabled = new ArrayList<String>();
                    for (String protocol : tls.getSupportedProtocols()) if (protocol.startsWith("TLS")) enabled.add(protocol);
                    tls.setEnabledProtocols(enabled.toArray(new String[enabled.size()]));
                    tls.startHandshake();
                    if (verify) try { verifyHost(host, (X509Certificate) tls.getSession().getPeerCertificates()[0]); }
                    catch (CertificateException e) { SSLHandshakeException error = new SSLHandshakeException("TLS certificate hostname mismatch."); error.initCause(e); throw error; }
                }
                return new TcpTransport(s);
            } catch (IOException e) {
                try { s.close(); } catch (IOException ignored) { }
                if (!certificateError(e)) throw e;
                if (attempt >= 3) throw new CertificateFailure("TLS certificate verification failed after 3 attempts.", e);
                try { Thread.sleep(100); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new IOException("TLS retry interrupted.", interrupted); }
            } catch (GeneralSecurityException e) { try { s.close(); } catch (IOException ignored) { } throw e; }
        }
    }
    /**
     * 예외 사슬에 인증서 관련 원인이 있는지 확인한다.
     *
     * @param e 검사할 예외
     * @return 인증서 오류가 원인이면 {@code true}
     */
    private static boolean certificateError(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) if (t instanceof CertificateException || t instanceof CertPathValidatorException) return true;
        return false;
    }
    /**
     * 서버 인증서가 접속 호스트와 일치하는지 확인한다.
     * <p>IP는 SAN의 IP 항목, DNS 이름은 SAN의 DNS 항목과 대조하고,
     * DNS SAN이 없을 때만 CN을 확인한다. 와일드카드 {@code "*.예시"}는 한 단계만 허용한다.</p>
     *
     * @param host 접속한 호스트명 또는 IP
     * @param cert 서버가 제시한 인증서
     * @throws CertificateException 호스트와 일치하지 않을 때
     */
    private static void verifyHost(String host, X509Certificate cert) throws CertificateException {
        boolean ip = host.indexOf(':') >= 0 || host.matches("[0-9.]+"); boolean dnsSan = false;
        Collection<List<?>> names = cert.getSubjectAlternativeNames();
        if (names != null) for (List<?> name : names) {
            if (Integer.valueOf(7).equals(name.get(0)) && ip) {
                try { if (InetAddress.getByName(host).equals(InetAddress.getByName(String.valueOf(name.get(1))))) return; }
                catch (UnknownHostException ignored) { }
            }
            if (Integer.valueOf(2).equals(name.get(0)) && !ip) { dnsSan = true; if (dnsMatch(host, String.valueOf(name.get(1)))) return; }
        }
        if (!ip && !dnsSan) try {
            javax.naming.ldap.LdapName dn = new javax.naming.ldap.LdapName(cert.getSubjectX500Principal().getName());
            for (javax.naming.ldap.Rdn rdn : dn.getRdns()) if (rdn.getType().equalsIgnoreCase("CN") && dnsMatch(host, String.valueOf(rdn.getValue()))) return;
        } catch (javax.naming.InvalidNameException e) { throw new CertificateException(e); }
        throw new CertificateException("Certificate does not match the target host.");
    }
    /**
     * DNS 호스트명과 인증서 패턴을 비교한다.
     *
     * @param host 접속 호스트명
     * @param pattern 인증서의 DNS 이름 패턴
     * @return 일치하면 {@code true}
     */
    private static boolean dnsMatch(String host, String pattern) {
        host = host.toLowerCase(Locale.US); pattern = pattern.toLowerCase(Locale.US);
        if (pattern.startsWith("*.")) { int dot = host.indexOf('.'); return dot > 0 && pattern.substring(1).equals(host.substring(dot)); }
        return host.equals(pattern);
    }
    /**
     * TLS 검증용 SSL 컨텍스트를 만든다.
     *
     * @param ca CA 인증서(PEM) 경로. {@code null}이면 기본 신뢰 저장소를 쓴다
     * @param verify {@code false}이면 검증을 끄는 임시 신뢰 관리자를 쓴다
     * @return 초기화된 SSL 컨텍스트
     * @throws GeneralSecurityException 키·신뢰 관리자 구성 실패 시
     * @throws IOException CA 파일을 읽을 수 없을 때
     */
    private static SSLContext context(String ca, boolean verify) throws GeneralSecurityException, IOException {
        TrustManager[] managers = null;
        if (!verify) managers = new TrustManager[] { new X509TrustManager() {
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            public void checkClientTrusted(X509Certificate[] chain, String auth) { }
            public void checkServerTrusted(X509Certificate[] chain, String auth) { }
        } };
        else if (ca != null) {
            KeyStore keys = KeyStore.getInstance(KeyStore.getDefaultType()); keys.load(null, null);
            InputStream stream = new FileInputStream(ca);
            try {
                int index = 0;
                for (java.security.cert.Certificate cert : CertificateFactory.getInstance("X.509").generateCertificates(stream)) keys.setCertificateEntry("ca" + index++, cert);
                if (index == 0) throw new CertificateException("Empty CA file.");
            } finally { stream.close(); }
            TrustManagerFactory tm = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); tm.init(keys); managers = tm.getTrustManagers();
        }
        SSLContext context = SSLContext.getInstance("TLS"); context.init(null, managers, null); return context;
    }
    /**
     * 메시지 크기 한도를 설정한다.
     *
     * @param limit 한 메시지당 최대 바이트 수
     */
    public void setLimit(int limit) { this.limit = limit; }
    /**
     * 길이 접두사와 함께 메시지 하나를 전송한다.
     *
     * @param message 전송할 메시지 본문
     * @throws IOException 빈 메시지, 한도 초과, 전송 실패 시
     */
    public void send(byte[] message) throws IOException {
        if (message.length == 0 || message.length > limit) throw new IOException("Message size limit exceeded.");
        out.writeInt(message.length); out.write(message); out.flush();
    }
    /**
     * 길이 접두사를 읽고 본문 한 개를 수신한다.
     *
     * @param timeoutMs 수신 대기 제한 시간(밀리초). 0이면 제한 없이 기다린다
     * @return 수신한 메시지 본문
     * @throws IOException 프레임 오류, 시간 초과, 연결 종료 시
     */
    public byte[] receive(int timeoutMs) throws IOException {
        long deadline = timeoutMs == 0 ? Long.MAX_VALUE : System.nanoTime() + timeoutMs * 1000000L;
        byte[] header = new byte[4]; read(header, deadline);
        int size = (header[0] & 255) << 24 | (header[1] & 255) << 16 | (header[2] & 255) << 8 | header[3] & 255;
        if (size < 1 || size > limit) throw new IOException("Invalid frame length.");
        byte[] bytes = new byte[size]; read(bytes, deadline); return bytes;
    }
    /**
     * 마감 시각까지 버퍼를 채운다.
     *
     * @param bytes 읽은 바이트를 담을 버퍼
     * @param deadline 나노초 기준 마감 시각. 제한이 없으면 최대값이다
     * @throws IOException 시간 초과나 연결 종료 시
     */
    private void read(byte[] bytes, long deadline) throws IOException {
        int at = 0;
        while (at < bytes.length) {
            long remaining = deadline == Long.MAX_VALUE ? 0 : Math.max(1, (deadline - System.nanoTime()) / 1000000L);
            if (deadline != Long.MAX_VALUE && System.nanoTime() >= deadline) throw new SocketTimeoutException("Response timed out.");
            socket.setSoTimeout((int) Math.min(Integer.MAX_VALUE, remaining));
            int n = in.read(bytes, at, bytes.length - at); if (n < 0) throw new EOFException("Connection closed."); at += n;
        }
    }
    /**
     * 소켓을 닫는다.
     * <p>오류가 나도 전달하지 않는다.</p>
     */
    public void close() { try { socket.close(); } catch (IOException ignored) { } }
    /**
     * 인증서 검증이 세 번의 시도 후에도 실패했음을 알리는 오류이다.
     * <p>드라이버는 이 종류를 SQLSTATE {@code 08001}로 변환한다.</p>
     */
    public static final class CertificateFailure extends IOException {
        /** 직렬화 버전 식별자이다. */
        private static final long serialVersionUID = 1L;
        /**
         * 인증서 실패 오류를 생성한다.
         *
         * @param message 오류 메시지
         * @param cause 원인이 된 인증서·입출력 오류
         */
        CertificateFailure(String message, Throwable cause) { super(message, cause); }
    }
}
