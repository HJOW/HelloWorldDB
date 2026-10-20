package org.duckdns.hjow.helloworlddb.jdbc6.protocol;

import java.io.*;
import java.net.*;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.concurrent.*;

/** 수신 스레드가 유휴 상태에도 ACK와 재전송을 처리하는 UDP 신뢰성 계층. */
public final class UdpTransport implements Transport, Runnable {
    private final DatagramSocket socket;
    private final BlockingQueue<Object> incoming = new LinkedBlockingQueue<Object>(64);
    private final Object lock = new Object();
    private volatile boolean closed;
    private volatile int limit = 65536;
    private int packetSize = 1200, session, expected = 1, next = 1;
    private byte[][] fragments;
    private int received, total;
    private Outgoing sending;
    private double srtt, variance, rto = 300;
    private final Thread worker;
    public UdpTransport(String host, int port) throws IOException {
        socket = new DatagramSocket();
        try { socket.connect(InetAddress.getByName(host), port); socket.setSoTimeout(20); }
        catch (IOException e) { socket.close(); throw e; }
        worker = new Thread(this, "hwdb-udp-receiver"); worker.setDaemon(true); worker.start();
    }
    public void setPacketSize(int size) { synchronized (lock) { packetSize = Math.min(packetSize, size); } }
    public void setLimit(int size) { limit = size; }
    public void send(byte[] bytes) throws IOException {
        synchronized (lock) {
            if (closed) throw new IOException("UDP connection closed.");
            if (bytes.length < 1 || bytes.length > limit) throw new IOException("Message size limit exceeded.");
            if (sending != null) throw new IOException("Previous UDP message is not acknowledged.");
            int count = (bytes.length + packetSize - 21) / (packetSize - 20);
            if (count > 65535) throw new FragmentLimit();
            if (next == 0) throw new IOException("UDP sequence exhausted.");
            sending = new Outgoing(bytes, count, next++, packetSize - 20); tick();
        }
    }
    public byte[] receive(int timeoutMs) throws IOException {
        try {
            Object item = timeoutMs == 0 ? incoming.take() : incoming.poll(timeoutMs, TimeUnit.MILLISECONDS);
            if (item == null) throw new SocketTimeoutException("UDP response timed out.");
            if (item instanceof IOException) throw (IOException) item;
            return (byte[]) item;
        } catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IOException("UDP receive interrupted.", e); }
    }
    public void run() {
        byte[] buffer = new byte[65535];
        try {
            while (!closed) {
                DatagramPacket datagram = new DatagramPacket(buffer, buffer.length);
                try { socket.receive(datagram); synchronized (lock) { accept(Arrays.copyOf(buffer, datagram.getLength())); } }
                catch (SocketTimeoutException ignored) { }
                synchronized (lock) { tick(); }
            }
        } catch (IOException e) { if (!closed) { incoming.offer(e); close(); } }
    }
    private void packet(int flags, int seq, int index, int count, byte[] data) throws IOException {
        ByteBuffer b = ByteBuffer.allocate(20 + data.length);
        b.putShort((short) 0x4857).put((byte) 1).put((byte) flags).putInt(session).putInt(seq)
            .putShort((short) index).putShort((short) count).putInt(expected - 1).put(data);
        socket.send(new DatagramPacket(b.array(), b.array().length));
    }
    private void accept(byte[] bytes) throws IOException {
        if (bytes.length < 20 || bytes.length > packetSize) return;
        ByteBuffer b = ByteBuffer.wrap(bytes);
        if (b.getShort() != (short) 0x4857 || b.get() != 1) return;
        int flags = b.get() & 255, id = b.getInt(), seq = b.getInt(), index = b.getShort() & 65535, count = b.getShort() & 65535, ack = b.getInt();
        if ((flags & ~31) != 0 || flags == 0) return;
        boolean data = (flags & 4) != 0;
        if (data ? count == 0 || index >= count || bytes.length == 20 : bytes.length != 20) return;
        if (session == 0) { if (id == 0 || (flags & 1) == 0) return; session = id; }
        if (id != session) return;
        if ((flags & 16) != 0) throw new IOException("UDP peer reset the session.");
        if ((flags & 8) != 0) { if ((flags & 2) == 0) packet(10, 0, 0, 0, new byte[0]); throw new IOException("UDP peer closed the session."); }
        if (sending != null && unsigned(ack) >= unsigned(sending.seq)) sending = null;
        if ((flags & 2) != 0 && sending != null && seq == sending.seq && index < sending.parts.length) {
            if (!sending.acked[index] && sending.sent[index] != 0) {
                sending.acked[index] = true;
                if (sending.retries[index] == 0) sample((System.nanoTime() - sending.sent[index]) / 1000000.0);
                sending.done++;
                if (sending.done == sending.parts.length) sending = null;
            }
        }
        if (!data) return;
        if (unsigned(seq) > unsigned(expected)) return;
        if (seq == expected) {
            if (fragments == null) fragments = new byte[count][];
            if (fragments.length != count) throw new IOException("Inconsistent UDP fragment count.");
            if (fragments[index] == null) {
                int n = bytes.length - 20;
                if (total + n > limit) throw new IOException("UDP message size limit exceeded.");
                fragments[index] = Arrays.copyOfRange(bytes, 20, bytes.length); total += n; received++;
            }
            if (received == count) {
                ByteArrayOutputStream out = new ByteArrayOutputStream(total);
                for (byte[] part : fragments) out.write(part);
                if (!incoming.offer(out.toByteArray())) throw new IOException("UDP receive queue limit exceeded.");
                expected++; fragments = null; total = 0; received = 0;
            }
        }
        packet(2 | ((flags & 1) != 0 ? 1 : 0), seq, index, 0, new byte[0]);
    }
    private static long unsigned(int n) { return n & 0xffffffffL; }
    private void sample(double time) {
        if (srtt == 0) { srtt = time; variance = time / 2; }
        else { variance = .75 * variance + .25 * Math.abs(srtt - time); srtt = .875 * srtt + .125 * time; }
        rto = Math.max(50, Math.min(3000, srtt + Math.max(1, 4 * variance)));
    }
    private void tick() throws IOException {
        if (sending == null) return;
        int outstanding = 0;
        for (int i = 0; i < sending.parts.length; i++) if (!sending.acked[i] && sending.sent[i] != 0) outstanding++;
        long now = System.nanoTime();
        for (int i = 0; i < sending.parts.length; i++) {
            if (sending.acked[i]) continue;
            if (sending.sent[i] == 0) { if (outstanding >= 32) break; outstanding++; sending.delay[i] = rto; }
            else {
                if ((now - sending.sent[i]) / 1000000.0 < sending.delay[i]) continue;
                if (sending.retries[i]++ >= 10) throw new IOException("UDP retransmission limit exceeded.");
                sending.delay[i] = Math.min(3000, sending.delay[i] * 2);
            }
            packet(4 | (sending.seq == 1 ? 1 : 0), sending.seq, i, sending.parts.length, sending.parts[i]); sending.sent[i] = now;
        }
    }
    public void close() {
        synchronized (lock) {
            if (closed) return;
            try { if (session != 0) packet(8, 0, 0, 0, new byte[0]); } catch (IOException ignored) { }
            closed = true; socket.close(); incoming.offer(new IOException("UDP connection closed."));
        }
    }
    private static final class Outgoing {
        final byte[][] parts; final int seq; final long[] sent; final int[] retries; final double[] delay; final boolean[] acked; int done;
        Outgoing(byte[] bytes, int count, int seq, int payload) {
            this.seq = seq; parts = new byte[count][]; sent = new long[count]; retries = new int[count]; delay = new double[count]; acked = new boolean[count];
            for (int i = 0; i < count; i++) parts[i] = Arrays.copyOfRange(bytes, i * payload, Math.min(bytes.length, (i + 1) * payload));
        }
    }
    public static final class FragmentLimit extends IOException {
        private static final long serialVersionUID = 1L;
        FragmentLimit() { super("UDP fragment limit exceeded."); }
    }
}
