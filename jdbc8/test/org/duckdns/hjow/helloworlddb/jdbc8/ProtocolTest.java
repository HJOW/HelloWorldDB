package org.duckdns.hjow.helloworlddb.jdbc8;

import java.io.*;
import java.net.*;
import java.sql.*;
import java.util.*;
import org.duckdns.hjow.helloworlddb.jdbc8.protocol.*;

/** 잘못된 서버 응답이 JDBC 호출자에게 런타임 예외나 무한 대기를 만들지 않는지 확인한다. */
final class ProtocolTest {
    private ProtocolTest() { }
    static void run() throws Exception {
        DriverTest.test("응답 ID·종류·JSON·행 너비 검증과 연결 종료", () -> {
            List<byte[]> responses = Arrays.asList(
                Json.encode(Json.object("id", 2, "type", "pong")),
                Json.encode(Json.object("id", 1, "type", "unknown")),
                "[]".getBytes("UTF-8"), new byte[] { (byte) 0xff });
            for (byte[] response : responses) {
                Fake f = new Fake(response); Protocol p = new Protocol(f, 100);
                DriverTest.state("08006", () -> p.request(Json.object("type", "ping"), "pong")); DriverTest.ok(f.closed && p.isClosed());
            }
            Fake f = new Fake(Json.encode(Json.object("id", 1, "type", "rows", "columns", Collections.singletonList(Json.object("name", "X", "typeName", "INTEGER", "declared", "INTEGER")), "rows", Collections.singletonList(Arrays.asList(1, 2)), "hasMore", false)));
            Protocol p = new Protocol(f, 100); DriverTest.state("08006", () -> p.execute("SELECT 1", Collections.emptyList(), 1)); DriverTest.ok(p.isClosed());
        });
        DriverTest.test("서버 발신 id 0의 SQLSTATE·번호 보존", () -> {
            Fake f = new Fake(Json.encode(Json.object("id", 0, "type", "error", "sqlState", "57P01", "code", 6003, "message", "Server shutting down.")));
            Protocol p = new Protocol(f, 100);
            try { p.ping(); throw new AssertionError(); } catch (SQLException e) { DriverTest.equal("57P01", e.getSQLState()); DriverTest.equal(6003, e.getErrorCode()); DriverTest.equal("Server shutting down.", e.getMessage()); }
            DriverTest.ok(p.isClosed()); DriverTest.state("57P01", p::ping);
        });
        DriverTest.test("TCP 조각난 프레임·합쳐진 프레임·수신 한도", () -> {
            peer(out -> {
                out.writeByte(0); out.flush(); out.write(new byte[] { 0, 0, 2, '{', '}', 0, 0, 0, 2, '[', ']' }); out.flush();
            }, t -> { DriverTest.equal("{}", new String(t.receive(1000), "UTF-8")); DriverTest.equal("[]", new String(t.receive(1000), "UTF-8")); });
            for (int length : new int[] { 0, -1, 65537 }) peer(out -> { out.writeInt(length); out.flush(); }, t -> DriverTest.io(() -> t.receive(1000)));
            peer(out -> { out.writeInt(3); out.writeByte('{'); out.flush(); }, t -> DriverTest.io(() -> t.receive(1000)));
        });
        DriverTest.test("응답 시간 초과는 SQLTimeoutException과 연결 종료", () -> {
            Fake f = new Fake(new byte[0]) { @Override public byte[] receive(int timeout) throws IOException { throw new SocketTimeoutException("Test timeout."); } };
            Protocol p = new Protocol(f, 1);
            try { p.ping(); throw new AssertionError(); } catch (SQLTimeoutException e) { DriverTest.equal("08006", e.getSQLState()); DriverTest.equal(8006, e.getErrorCode()); }
            DriverTest.ok(p.isClosed());
        });
    }
    interface Send { void send(DataOutputStream out) throws Exception; }
    interface Receive { void receive(TcpTransport transport) throws Exception; }
    private static void peer(Send send, Receive receive) throws Exception {
        try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            Thread worker = new Thread(() -> { try (Socket socket = server.accept()) { send.send(new DataOutputStream(socket.getOutputStream())); } catch (Exception e) { throw new RuntimeException(e); } });
            worker.setDaemon(true); worker.start();
            TcpTransport t = TcpTransport.open("127.0.0.1", server.getLocalPort(), 1000, false, null, true);
            try { receive.receive(t); } finally { t.close(); worker.join(2000); DriverTest.ok(!worker.isAlive()); }
        }
    }
    private static class Fake implements Transport {
        final byte[] response; boolean closed;
        Fake(byte[] response) { this.response = response; }
        @Override public void send(byte[] bytes) { }
        @Override public byte[] receive(int timeout) throws IOException { return response; }
        @Override public void setLimit(int limit) { }
        @Override public void close() { closed = true; }
    }
}
