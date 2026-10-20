package org.duckdns.hjow.helloworlddb.jdbc8.protocol;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.sql.*;
import java.util.*;

/** 요청 직렬화, 인증, 응답 검증과 서버 오류 전달. JDBC 인터페이스에는 의존하지 않는다. */
public final class Protocol {
    private final Transport transport;
    private long next = 1;
    private volatile boolean closed;
    private SQLException failure;
    private Timer heartbeat;
    private int timeout;
    private boolean ready;
    private Map<String, Object> session;
    private final Map<Long, Integer> cursors = new HashMap<Long, Integer>();
    public Protocol(Transport transport, int timeout) { this.transport = transport; this.timeout = timeout; }
    public synchronized void login(String user, String password, String tablespace, String timeZone) throws SQLException {
        try {
            Map<String, Object> hello = request(Json.object("type", "hello", "versions", Arrays.asList(Integer.valueOf(1)), "client", "HelloWorldDB JDBC"), "helloOk");
            if (number(hello, "version") != 1 || !"SCRAM-SHA-256".equals(hello.get("mechanism"))) throw new IOException("Invalid protocol negotiation.");
            int udpTimeout = 0;
            if (transport instanceof UdpTransport) {
                Map<String, Object> udp = map(hello.get("udp"));
                long size = number(udp, "maxPacketSize"), idle = number(udp, "sessionTimeoutMs");
                if (size < 64 || size > 65507 || idle < 0 || idle > Integer.MAX_VALUE) throw new IOException("Invalid UDP negotiation.");
                ((UdpTransport) transport).setPacketSize((int) size); udpTimeout = (int) idle;
            }
            Scram scram = new Scram(user);
            Map<String, Object> start = Json.object("type", "authStart", "mechanism", "SCRAM-SHA-256", "clientFirst", scram.first());
            if (tablespace != null) start.put("tablespace", tablespace);
            if (timeZone != null) start.put("timeZone", timeZone);
            Map<String, Object> challenge = request(start, "authChallenge");
            String finalMessage = scram.finish(password, string(challenge, "serverFirst"));
            Map<String, Object> auth = request(Json.object("type", "authFinish", "clientFinal", finalMessage), "authOk");
            scram.verify(string(auth, "serverFinal")); session = map(auth.get("session"));
            string(session, "user"); string(session, "timeZone"); number(session, "id");
            if (!(session.get("autocommit") instanceof Boolean) || (session.get("tablespace") != null && !(session.get("tablespace") instanceof String))) throw new IOException("Invalid session information.");
            ready = true; transport.setLimit(16777216);
            if (udpTimeout > 0) {
                heartbeat = new Timer("hwdb-udp-ping", true);
                heartbeat.schedule(new TimerTask() { public void run() { try { ping(); } catch (SQLException ignored) { } } }, Math.max(1, udpTimeout / 3), Math.max(1, udpTimeout / 3));
            }
        } catch (IOException e) { throw fail(e); }
        catch (GeneralSecurityException e) { throw fail(e); }
        catch (SQLException e) { abort(); throw e; }
    }
    public Map<String, Object> session() { return session; }
    public synchronized void setTimeout(int ms) { timeout = ms; }
    public synchronized int getTimeout() { return timeout; }
    public synchronized Map<String, Object> execute(String sql, List<Object> params, int fetchSize) throws SQLException {
        Map<String, Object> response = request(Json.object("type", "execute", "sql", sql, "params", params, "fetchSize", Integer.valueOf(fetchSize)), "rows", "ok");
        if ("rows".equals(response.get("type"))) validateRows(response, true, null);
        else if (response.containsKey("rowCount")) try { number(response, "rowCount"); } catch (IOException e) { throw fail(e); }
        return response;
    }
    public synchronized Map<String, Object> fetch(long cursor, int size) throws SQLException {
        Integer width = cursors.get(Long.valueOf(cursor));
        Map<String, Object> result = request(Json.object("type", "fetch", "cursor", Long.valueOf(cursor), "fetchSize", Integer.valueOf(size)), "rows");
        validateRows(result, false, width); if (!Boolean.TRUE.equals(result.get("hasMore"))) cursors.remove(Long.valueOf(cursor)); return result;
    }
    private void validateRows(Map<String, Object> result, boolean columns, Integer width) throws SQLException {
        try {
            if (!(result.get("rows") instanceof List<?>) || !(result.get("hasMore") instanceof Boolean)) throw new IOException("Invalid row response.");
            if (columns) {
                List<Object> metadata = list(result.get("columns")); width = Integer.valueOf(metadata.size());
                for (Object column : metadata) {
                    Map<String, Object> c = map(column); string(c, "name"); string(c, "typeName"); string(c, "declared");
                    for (String field : Arrays.asList("length", "precision", "scale", "fractionalPrecision", "leadingPrecision")) if (c.containsKey(field) && (number(c, field) < 0 || number(c, field) > Integer.MAX_VALUE)) throw new IOException("Invalid column metadata.");
                }
            }
            for (Object row : list(result.get("rows"))) {
                List<Object> values = list(row); if (width != null && values.size() != width.intValue()) throw new IOException("Invalid row width.");
                for (Object value : values) if (value != null && !(value instanceof String || value instanceof Number || value instanceof Boolean)) throw new IOException("Invalid result value.");
            }
            if (Boolean.TRUE.equals(result.get("hasMore")) && number(result, "cursor") < 1) throw new IOException("Invalid result cursor.");
            if (Boolean.TRUE.equals(result.get("hasMore")) && list(result.get("rows")).isEmpty()) throw new IOException("Empty row batch with an open cursor.");
            if (Boolean.TRUE.equals(result.get("hasMore"))) cursors.put(Long.valueOf(number(result, "cursor")), width);
        } catch (IOException e) { throw fail(e); }
    }
    public synchronized void closeCursor(long cursor) throws SQLException { request(Json.object("type", "closeCursor", "cursor", Long.valueOf(cursor)), "cursorClosed"); cursors.remove(Long.valueOf(cursor)); }
    public synchronized void ping() throws SQLException { request(Json.object("type", "ping"), "pong"); }
    public synchronized Map<String, Object> request(Map<String, Object> message, String... expected) throws SQLException {
        if (closed) throw failure != null ? failure : new SQLException("Connection is closed.", "08003");
        long id = next++; message.put("id", Long.valueOf(id));
        byte[] bytes;
        try { bytes = Json.encode(message); }
        catch (IOException e) { throw new SQLException(e.getMessage(), "22021", e); }
        if (bytes.length > (ready ? 16777216 : 65536)) throw new SQLException("Message size limit exceeded.", "54000", 8003);
        try {
            transport.send(bytes);
            Map<String, Object> response = map(Json.decode(transport.receive(timeout)));
            long responseId = number(response, "id"); String type = string(response, "type");
            if (responseId != id && !(responseId == 0 && "error".equals(type))) throw new IOException("Response id mismatch.");
            if ("error".equals(type)) {
                String state = string(response, "sqlState"); if (!state.matches("[A-Z0-9]{5}")) throw new IOException("Invalid SQLSTATE.");
                SQLException error = "0A000".equals(state)
                    ? new SQLFeatureNotSupportedException(string(response, "message"), state, (int) number(response, "code"))
                    : new SQLException(string(response, "message"), state, (int) number(response, "code"));
                if (responseId == 0 || state.startsWith("08") || state.equals("28000") || state.equals("XX000") || !ready) { failure = error; abort(); }
                throw error;
            }
            for (String allowed : expected) if (allowed.equals(type)) return response;
            throw new IOException("Unexpected response type: " + type);
        } catch (UdpTransport.FragmentLimit e) { throw new SQLException(e.getMessage(), "54000", 8003, e); }
        catch (IOException e) { throw fail(e); }
    }
    private SQLException fail(Exception e) {
        failure = e instanceof java.net.SocketTimeoutException ? new SQLTimeoutException(e.getMessage(), "08006", 8006, e) : new SQLException(e.getMessage(), "08006", 8006, e);
        abort(); return failure;
    }
    public boolean isClosed() { return closed; }
    public synchronized void close() throws SQLException {
        if (closed) return;
        try { request(Json.object("type", "close"), "bye"); } finally { abort(); }
    }
    public void abort() { closed = true; if (heartbeat != null) heartbeat.cancel(); transport.close(); }
    @SuppressWarnings("unchecked")
    public static Map<String, Object> map(Object value) throws IOException {
        if (!(value instanceof Map<?, ?>)) throw new IOException("Expected JSON object."); return (Map<String, Object>) value;
    }
    @SuppressWarnings("unchecked")
    public static List<Object> list(Object value) throws IOException {
        if (!(value instanceof List<?>)) throw new IOException("Expected JSON array."); return (List<Object>) value;
    }
    public static String string(Map<String, Object> map, String key) throws IOException {
        Object value = map.get(key); if (!(value instanceof String)) throw new IOException("Invalid field: " + key); return (String) value;
    }
    public static long number(Map<String, Object> map, String key) throws IOException {
        Object value = map.get(key); if (!(value instanceof Long || value instanceof Integer)) throw new IOException("Invalid integer field: " + key); return ((Number) value).longValue();
    }
}
