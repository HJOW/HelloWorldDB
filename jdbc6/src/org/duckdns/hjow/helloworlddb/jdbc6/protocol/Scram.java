package org.duckdns.hjow.helloworlddb.jdbc6.protocol;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.text.Normalizer;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * SCRAM-SHA-256 클라이언트와 Java 6에서도 같은 결과를 내는 보조 구현이다.
 * <p>비밀번호를 평문으로 보내지 않고 챌린지-응답으로 인증하며,
 * PBKDF2와 base64를 직접 구현하여 실행 환경의 자바 버전에 관계없이
 * 같은 인증 결과를 낸다.</p>
 */
public final class Scram {
    /** base64 인코딩에 쓰는 64자 알파벳이다. */
    private static final String ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    /** 이번 인증에서 생성한 클라이언트 논스이다. */
    private final String nonce;
    /** 서버에 처음 보내는 베어 메시지({@code n=...,r=...})이다. */
    private final String bare;
    /** 서버 최종 메시지를 검증할 때 비교할 서버 서명이다. */
    private byte[] expected;
    /**
     * 사용자명으로 SCRAM 클라이언트 상태를 생성한다.
     * <p>18바이트 난수에서 논스를 만들고 첫 메시지 본문을 미리 구성한다.</p>
     *
     * @param user 인증할 사용자명. 서버의 SASL 이름 규칙에 맞게 이스케이프된다
     */
    public Scram(String user) {
        byte[] bytes = new byte[18]; new SecureRandom().nextBytes(bytes);
        nonce = base64(bytes); bare = "n=" + user.replace("=", "=3D").replace(",", "=2C") + ",r=" + nonce;
    }
    /**
     * 서버에 보낼 첫 클라이언트 메시지를 반환한다.
     *
     * @return {@code "n,,"} 접두사가 붙은 GS2 헤더 포함 첫 메시지
     */
    public String first() { return "n,," + bare; }
    /**
     * 서버 챌린지를 검증하고 최종 클라이언트 메시지를 만든다.
     * <p>서버 논스 접두사, 솔트, 반복 횟수를 검사한 뒤 PBKDF2로 유도한 키로
     * 클라이언트 증명을 계산한다. 유도한 임시 키는 사용 뒤 0으로 지운다.</p>
     *
     * @param password 사용자의 평문 비밀번호. NFKC 정규화 뒤 UTF-8로 사용된다
     * @param serverFirst 서버가 보낸 첫 챌린지 문자열
     * @return 서버에 보낼 최종 메시지
     * @throws IOException 챌린지 형식, 반복 횟수, 솔트가 올바르지 않을 때
     * @throws GeneralSecurityException HMAC·다이제스트 연산이 실패할 때
     */
    public String finish(String password, String serverFirst) throws IOException, GeneralSecurityException {
        String[] a = serverFirst.split(",", -1);
        if (a.length != 3 || !a[0].startsWith("r=" + nonce) || a[0].length() <= nonce.length() + 2
            || !a[1].startsWith("s=") || !a[2].matches("i=[0-9]+")) throw new IOException("Invalid SCRAM challenge.");
        int rounds;
        try { rounds = Integer.parseInt(a[2].substring(2)); } catch (NumberFormatException e) { throw new IOException("Invalid SCRAM iterations.", e); }
        if (rounds < 1 || rounds > 10000000) throw new IOException("Invalid SCRAM iterations.");
        byte[] salt = unbase64(a[1].substring(2));
        if (salt.length == 0) throw new IOException("Empty SCRAM salt.");
        byte[] key = pbkdf2(Normalizer.normalize(password, Normalizer.Form.NFKC).getBytes("UTF-8"), salt, rounds);
        String finalBare = "c=biws," + a[0];
        byte[] message = (bare + "," + serverFirst + "," + finalBare).getBytes("UTF-8");
        byte[] client = hmac(key, "Client Key".getBytes("UTF-8"));
        byte[] signature = hmac(MessageDigest.getInstance("SHA-256").digest(client), message);
        expected = hmac(hmac(key, "Server Key".getBytes("UTF-8")), message);
        for (int i = 0; i < client.length; i++) client[i] ^= signature[i];
        java.util.Arrays.fill(key, (byte) 0);
        return finalBare + ",p=" + base64(client);
    }
    /**
     * 서버 최종 메시지의 서명을 검증한다.
     * <p>검증 뒤에는 저장된 기대 서명을 0으로 지워 재사용할 수 없게 한다.</p>
     *
     * @param serverFinal 서버가 보낸 최종 메시지({@code v=...} 형식)
     * @throws IOException 서명이 없거나 일치하지 않을 때
     */
    public void verify(String serverFinal) throws IOException {
        if (!serverFinal.startsWith("v=") || expected == null || !MessageDigest.isEqual(expected, unbase64(serverFinal.substring(2))))
            throw new IOException("SCRAM server signature mismatch.");
        java.util.Arrays.fill(expected, (byte) 0); expected = null;
    }
    /**
     * HMAC-SHA-256을 계산한다.
     *
     * @param key HMAC 키. 빈 키는 0 바이트 하나로 대체한다
     * @param data 인증할 데이터
     * @return 32바이트 MAC 값
     * @throws GeneralSecurityException 암호 연산자를 구할 수 없을 때
     */
    private static byte[] hmac(byte[] key, byte[] data) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(key.length == 0 ? new byte[1] : key, "HmacSHA256")); return mac.doFinal(data);
    }
    /**
     * PBKDF2-HMAC-SHA-256으로 키를 유도한다.
     *
     * @param password NFKC 정규화·UTF-8 변환된 비밀번호 바이트
     * @param salt 서버가 준 솔트
     * @param rounds 반복 횟수. 1 이상 1000만 이하이어야 한다
     * @return 유도된 32바이트 키
     * @throws GeneralSecurityException 암호 연산자를 구할 수 없을 때
     */
    public static byte[] pbkdf2(byte[] password, byte[] salt, int rounds) throws GeneralSecurityException {
        if (rounds < 1 || rounds > 10000000) throw new IllegalArgumentException("Invalid iterations.");
        byte[] block = new byte[salt.length + 4]; System.arraycopy(salt, 0, block, 0, salt.length); block[block.length - 1] = 1;
        Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(password.length == 0 ? new byte[1] : password, "HmacSHA256"));
        byte[] u = mac.doFinal(block), out = u.clone();
        for (int n = 1; n < rounds; n++) { u = mac.doFinal(u); for (int i = 0; i < out.length; i++) out[i] ^= u[i]; }
        return out;
    }
    /**
     * 바이트 배열을 base64 문자열로 인코딩한다.
     *
     * @param bytes 인코딩할 바이트
     * @return 패딩을 포함한 표준 base64 문자열
     */
    public static String base64(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < bytes.length; i += 3) {
            int n = (bytes[i] & 255) << 16 | (i + 1 < bytes.length ? (bytes[i + 1] & 255) << 8 : 0) | (i + 2 < bytes.length ? bytes[i + 2] & 255 : 0);
            out.append(ALPHABET.charAt(n >>> 18)).append(ALPHABET.charAt(n >>> 12 & 63));
            out.append(i + 1 < bytes.length ? ALPHABET.charAt(n >>> 6 & 63) : '=').append(i + 2 < bytes.length ? ALPHABET.charAt(n & 63) : '=');
        }
        return out.toString();
    }
    /**
     * base64 문자열을 디코딩한다.
     * <p>정규형이 아닌 인코딩(잘못된 패딩 등)은 거부한다.</p>
     *
     * @param s base64 문자열
     * @return 디코딩된 바이트
     * @throws IOException 형식이 올바르지 않거나 정규형이 아닐 때
     */
    public static byte[] unbase64(String s) throws IOException {
        if (!s.matches("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?")) throw new IOException("Invalid base64.");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int i = 0; i < s.length(); i += 4) {
            int n = ALPHABET.indexOf(s.charAt(i)) << 18 | ALPHABET.indexOf(s.charAt(i + 1)) << 12
                | Math.max(0, ALPHABET.indexOf(s.charAt(i + 2))) << 6 | Math.max(0, ALPHABET.indexOf(s.charAt(i + 3)));
            out.write(n >>> 16); if (s.charAt(i + 2) != '=') out.write(n >>> 8); if (s.charAt(i + 3) != '=') out.write(n);
        }
        byte[] b = out.toByteArray(); if (!base64(b).equals(s)) throw new IOException("Non-canonical base64."); return b;
    }
}
