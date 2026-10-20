package org.duckdns.hjow.helloworlddb.jdbc6.protocol;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.text.Normalizer;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** SCRAM-SHA-256과 Java 6에서도 같은 결과를 내는 PBKDF2/base64 구현. */
public final class Scram {
    private static final String ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    private final String nonce;
    private final String bare;
    private byte[] expected;
    public Scram(String user) {
        byte[] bytes = new byte[18]; new SecureRandom().nextBytes(bytes);
        nonce = base64(bytes); bare = "n=" + user.replace("=", "=3D").replace(",", "=2C") + ",r=" + nonce;
    }
    public String first() { return "n,," + bare; }
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
    public void verify(String serverFinal) throws IOException {
        if (!serverFinal.startsWith("v=") || expected == null || !MessageDigest.isEqual(expected, unbase64(serverFinal.substring(2))))
            throw new IOException("SCRAM server signature mismatch.");
        java.util.Arrays.fill(expected, (byte) 0); expected = null;
    }
    private static byte[] hmac(byte[] key, byte[] data) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(key.length == 0 ? new byte[1] : key, "HmacSHA256")); return mac.doFinal(data);
    }
    public static byte[] pbkdf2(byte[] password, byte[] salt, int rounds) throws GeneralSecurityException {
        if (rounds < 1 || rounds > 10000000) throw new IllegalArgumentException("Invalid iterations.");
        byte[] block = new byte[salt.length + 4]; System.arraycopy(salt, 0, block, 0, salt.length); block[block.length - 1] = 1;
        Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(password.length == 0 ? new byte[1] : password, "HmacSHA256"));
        byte[] u = mac.doFinal(block), out = u.clone();
        for (int n = 1; n < rounds; n++) { u = mac.doFinal(u); for (int i = 0; i < out.length; i++) out[i] ^= u[i]; }
        return out;
    }
    public static String base64(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < bytes.length; i += 3) {
            int n = (bytes[i] & 255) << 16 | (i + 1 < bytes.length ? (bytes[i + 1] & 255) << 8 : 0) | (i + 2 < bytes.length ? bytes[i + 2] & 255 : 0);
            out.append(ALPHABET.charAt(n >>> 18)).append(ALPHABET.charAt(n >>> 12 & 63));
            out.append(i + 1 < bytes.length ? ALPHABET.charAt(n >>> 6 & 63) : '=').append(i + 2 < bytes.length ? ALPHABET.charAt(n & 63) : '=');
        }
        return out.toString();
    }
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
