package org.duckdns.hjow.helloworlddb.jdbc6.protocol;

import java.io.*;
import java.net.*;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.ArrayDeque;
import java.util.concurrent.*;

/**
 * 수신 스레드가 유휴 상태에도 ACK와 재전송을 처리하는 UDP 신뢰성 계층이다.
 * <p>매직 넘버·버전·세션 ID·순번·조각 번호로 패킷을 식별하고,
 * 수신 확인(ACK), 재전송, 중복 제거, 순서 보장을 제공한다.
 * 송신은 한 번에 메시지 하나씩 처리하며, RTT 측정값으로 재전송 간격을 조절한다.</p>
 */
public final class UdpTransport implements Transport, Runnable {
    /** 패킷을 주고받는 UDP 소켓이다. */
    private final DatagramSocket socket;
    /** 완성된 메시지나 비동기 오류를 넘기는 수신 큐이다. */
    private final BlockingQueue<Object> incoming = new LinkedBlockingQueue<Object>(64);
    /** 송수신 상태와 타이머를 보호하는 잠금이다. */
    private final Object lock = new Object();
    /** 닫힌 뒤에는 송수신을 거부하기 위한 표시이다. */
    private volatile boolean closed;
    /** 한 메시지당 최대 바이트 수이다. */
    private volatile int limit = 65536;
    /** 패킷 하나의 최대 크기(헤더 포함)이다. */
    private int packetSize = 1200;
    /** 핸드셰이크 때 서버가 발급한 세션 식별자이다. */
    private int session;
    /** 다음에 받을 것으로 기대하는 순번이다. */
    private int expected = 1;
    /** 다음에 송신할 때 쓸 순번이다. */
    private int next = 1;
    /** 현재 조립 중인 메시지의 조각 저장소이다. */
    private byte[][] fragments;
    /** 조립 중인 메시지의 수신 조각 수이다. */
    private int received;
    /** 조립 중인 메시지의 누적 바이트 수이다. */
    private int total;
    /** 확인 응답을 기다리는 송신 중인 메시지이다. {@code null}이면 유휴 상태이다. */
    private Outgoing sending;
    /** 실행 요청의 ACK를 기다리는 동안 도착한 취소 요청도 순서대로 전송한다. */
    private final ArrayDeque<Outgoing> outgoing = new ArrayDeque<Outgoing>();
    /** 평활화된 왕복 시간 추정치(밀리초)이다. */
    private double srtt;
    /** 왕복 시간 편차 추정치이다. */
    private double variance;
    /** 다음 재전송까지의 대기 시간(밀리초)이다. 초기값 300이다. */
    private double rto = 300;
    /** 패킷 수신과 재전송 타이머를 돌리는 수신 스레드이다. */
    private final Thread worker;
    /**
     * 서버 주소에 연결된 UDP 전송 객체를 생성한다.
     * <p>수신 스레드를 데몬으로 시작하므로 호출자가 따로 정리하지 않아도
     * JVM 종료를 막지 않는다.</p>
     *
     * @param host 서버 호스트명 또는 IP 주소
     * @param port 서버 포트 번호
     * @throws IOException 소켓 생성·연결 실패 시
     */
    public UdpTransport(String host, int port) throws IOException {
        socket = new DatagramSocket();
        try { socket.connect(InetAddress.getByName(host), port); socket.setSoTimeout(20); }
        catch (IOException e) { socket.close(); throw e; }
        worker = new Thread(this, "hwdb-udp-receiver"); worker.setDaemon(true); worker.start();
    }
    /**
     * 패킷 크기 상한을 낮춘다.
     * <p>서버 핸드셰이크에서 알려준 최대 패킷 크기를 반영하기 위해 사용하며,
     * 현재 값보다 키우지는 않는다.</p>
     *
     * @param size 서버가 허용하는 패킷 최대 크기
     */
    public void setPacketSize(int size) { synchronized (lock) { packetSize = Math.min(packetSize, size); } }
    /**
     * 한 메시지당 최대 바이트 수를 설정한다.
     *
     * @param size 바이트 단위의 최대 메시지 크기
     */
    public void setLimit(int size) { limit = size; }
    /**
     * 메시지 하나를 조각내어 송신 큐에 올린다.
     * <p>확인 응답을 기다리는 동안의 취소 요청도 큐에 넣고 메시지 순서대로 전송한다.</p>
     *
     * @param bytes 전송할 메시지 본문
     * @throws IOException 닫힌 상태, 크기 위반, 미확인 메시지 존재, 조각 한도 초과 시
     */
    public void send(byte[] bytes) throws IOException {
        synchronized (lock) {
            if (closed) throw new IOException("UDP connection closed.");
            if (bytes.length < 1 || bytes.length > limit) throw new IOException("Message size limit exceeded.");
            if (outgoing.size() >= 64) throw new IOException("UDP send queue limit exceeded.");
            int count = (bytes.length + packetSize - 21) / (packetSize - 20);
            if (count > 65535) throw new FragmentLimit();
            if (next == 0) throw new IOException("UDP sequence exhausted.");
            outgoing.addLast(new Outgoing(bytes, count, next++, packetSize - 20)); tick();
        }
    }
    /**
     * 완성된 메시지 하나를 수신 큐에서 꺼낸다.
     *
     * @param timeoutMs 대기 제한 시간(밀리초). 0이면 제한 없이 기다린다
     * @return 완성된 메시지 본문 한 개
     * @throws IOException 시간 초과, 인터럽트, 수신 스레드의 오류 전파 시
     */
    public byte[] receive(int timeoutMs) throws IOException {
        try {
            Object item = timeoutMs == 0 ? incoming.take() : incoming.poll(timeoutMs, TimeUnit.MILLISECONDS);
            if (item == null) throw new SocketTimeoutException("UDP response timed out.");
            if (item instanceof IOException) throw (IOException) item;
            return (byte[]) item;
        } catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IOException("UDP receive interrupted.", e); }
    }
    /**
     * 수신 스레드의 본체이다.
     * <p>20 ms 단위로 패킷을 받아 처리하고, 받을 패킷이 없어도
     * 재전송 타이머를 진전시킨다.</p>
     */
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
    /**
     * 패킷 헤더를 붙여 한 조각을 전송한다.
     *
     * @param flags 패킷 종류·세션 플래그
     * @param seq 메시지 순번
     * @param index 조각 번호
     * @param count 전체 조각 수
     * @param data 조각 본문
     * @throws IOException 소켓 전송 실패 시
     */
    private void packet(int flags, int seq, int index, int count, byte[] data) throws IOException {
        ByteBuffer b = ByteBuffer.allocate(20 + data.length);
        b.putShort((short) 0x4857).put((byte) 1).put((byte) flags).putInt(session).putInt(seq)
            .putShort((short) index).putShort((short) count).putInt(expected - 1).put(data);
        socket.send(new DatagramPacket(b.array(), b.array().length));
    }
    /**
     * 수신한 패킷 하나를 검증하고 상태에 반영한다.
     * <p>세션 확정, ACK 처리, 조각 조립, 중복 제거, 순서 보장을 수행하고,
     * 데이터 패킷에는 확인 응답을 보낸다.</p>
     *
     * @param bytes 수신한 패킷 전체(헤더 포함)
     * @throws IOException 세션 리셋, 종료, 조각 수 불일치, 크기·큐 한도 초과 시
     */
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
    /**
     * 부호 없는 32비트 비교를 위해 정수를 long으로 변환한다.
     *
     * @param n 순번 값
     * @return 부호 없는 값
     */
    private static long unsigned(int n) { return n & 0xffffffffL; }
    /**
     * 재전송 없이 확인된 조각의 왕복 시간을 표본으로 RTO를 갱신한다.
     * <p>Karn 규칙에 따라 재전송된 조각은 표본에서 제외하며, 50~3000 ms 범위로 고정한다.</p>
     *
     * @param time 측정된 왕복 시간(밀리초)
     */
    private void sample(double time) {
        if (srtt == 0) { srtt = time; variance = time / 2; }
        else { variance = .75 * variance + .25 * Math.abs(srtt - time); srtt = .875 * srtt + .125 * time; }
        rto = Math.max(50, Math.min(3000, srtt + Math.max(1, 4 * variance)));
    }
    /**
     * 미확인 조각 중 전송 시점이 된 것을 다시 보낸다.
     * <p>처음 보내는 조각은 동시에 32개까지만 내보내고, 재전송은 지수 백오프로
     * 간격을 늘리며 한 조각당 10회를 넘으면 오류로 처리한다.</p>
     *
     * @throws IOException 재전송 한도 초과 시
     */
    private void tick() throws IOException {
        if (sending == null) sending = outgoing.pollFirst();
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
    /**
     * 전송로를 닫는다.
     * <p>세션이 있으면 종료 패킷을 보내고 소켓을 닫은 뒤,
     * 대기 중인 수신자에게 종료 오류를 전달한다.</p>
     */
    public void close() {
        synchronized (lock) {
            if (closed) return;
            try { if (session != 0) packet(8, 0, 0, 0, new byte[0]); } catch (IOException ignored) { }
            closed = true; sending = null; outgoing.clear(); socket.close(); incoming.offer(new IOException("UDP connection closed."));
        }
    }
    /**
     * 확인 응답을 기다리는 송신 중 메시지의 조각 상태이다.
     */
    private static final class Outgoing {
        /** 조각별 본문이다. */
        final byte[][] parts;
        /** 메시지 순번이다. */
        final int seq;
        /** 조각별 마지막 전송 시각(나노초)이다. */
        final long[] sent;
        /** 조각별 재전송 횟수이다. */
        final int[] retries;
        /** 조각별 다음 재전송 대기 시간(밀리초)이다. */
        final double[] delay;
        /** 조각별 확인 응답 수신 여부이다. */
        final boolean[] acked;
        /** 확인 응답을 받은 조각 수이다. */
        int done;
        /**
         * 송신 중 메시지 상태를 생성한다.
         *
         * @param bytes 원본 메시지 전체
         * @param count 전체 조각 수
         * @param seq 메시지 순번
         * @param payload 조각당 최대 본문 크기
         */
        Outgoing(byte[] bytes, int count, int seq, int payload) {
            this.seq = seq; parts = new byte[count][]; sent = new long[count]; retries = new int[count]; delay = new double[count]; acked = new boolean[count];
            for (int i = 0; i < count; i++) parts[i] = Arrays.copyOfRange(bytes, i * payload, Math.min(bytes.length, (i + 1) * payload));
        }
    }
    /**
     * 조각 수가 65535개를 넘어 메시지를 보낼 수 없음을 알리는 오류이다.
     */
    public static final class FragmentLimit extends IOException {
        /** 직렬화 버전 식별자이다. */
        private static final long serialVersionUID = 1L;
        /** 기본 메시지로 오류를 생성한다. */
        FragmentLimit() { super("UDP fragment limit exceeded."); }
    }
}
