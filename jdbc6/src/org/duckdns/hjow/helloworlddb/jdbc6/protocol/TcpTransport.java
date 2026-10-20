package org.duckdns.hjow.helloworlddb.jdbc6.protocol;

import java.io.*;
import java.net.*;
import java.security.*;
import java.security.cert.*;
import java.util.*;
import javax.net.ssl.*;

/** TCP 프레임과 TLS 검증. 인증서 오류만 새 연결에서 두 번 재시도한다. */
public final class TcpTransport implements Transport {
    private final Socket socket;
    private final DataInputStream in;
    private final DataOutputStream out;
    private int limit = 65536;
    private TcpTransport(Socket socket) throws IOException { this.socket = socket; in = new DataInputStream(socket.getInputStream()); out = new DataOutputStream(socket.getOutputStream()); }
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
    private static boolean certificateError(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) if (t instanceof CertificateException || t instanceof CertPathValidatorException) return true;
        return false;
    }
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
    private static boolean dnsMatch(String host, String pattern) {
        host = host.toLowerCase(Locale.US); pattern = pattern.toLowerCase(Locale.US);
        if (pattern.startsWith("*.")) { int dot = host.indexOf('.'); return dot > 0 && pattern.substring(1).equals(host.substring(dot)); }
        return host.equals(pattern);
    }
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
    public void setLimit(int limit) { this.limit = limit; }
    public void send(byte[] message) throws IOException {
        if (message.length == 0 || message.length > limit) throw new IOException("Message size limit exceeded.");
        out.writeInt(message.length); out.write(message); out.flush();
    }
    public byte[] receive(int timeoutMs) throws IOException {
        long deadline = timeoutMs == 0 ? Long.MAX_VALUE : System.nanoTime() + timeoutMs * 1000000L;
        byte[] header = new byte[4]; read(header, deadline);
        int size = (header[0] & 255) << 24 | (header[1] & 255) << 16 | (header[2] & 255) << 8 | header[3] & 255;
        if (size < 1 || size > limit) throw new IOException("Invalid frame length.");
        byte[] bytes = new byte[size]; read(bytes, deadline); return bytes;
    }
    private void read(byte[] bytes, long deadline) throws IOException {
        int at = 0;
        while (at < bytes.length) {
            long remaining = deadline == Long.MAX_VALUE ? 0 : Math.max(1, (deadline - System.nanoTime()) / 1000000L);
            if (deadline != Long.MAX_VALUE && System.nanoTime() >= deadline) throw new SocketTimeoutException("Response timed out.");
            socket.setSoTimeout((int) Math.min(Integer.MAX_VALUE, remaining));
            int n = in.read(bytes, at, bytes.length - at); if (n < 0) throw new EOFException("Connection closed."); at += n;
        }
    }
    public void close() { try { socket.close(); } catch (IOException ignored) { } }
    public static final class CertificateFailure extends IOException {
        private static final long serialVersionUID = 1L;
        CertificateFailure(String message, Throwable cause) { super(message, cause); }
    }
}
