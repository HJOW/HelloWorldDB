package org.duckdns.hjow.helloworlddb.jdbc8.protocol;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.sql.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 요청 직렬화, 인증, 응답 검증과 서버 오류 전달을 담당한다. JDBC 인터페이스에는 의존하지 않는다.
 * <p>HelloWorldDB JSON 메시지 프로토콜의 핸드셰이크, SCRAM-SHA-256 인증,
 * 문장 실행·fetch·커서 닫기·ping·종료를 순서대로 처리한다.
 * 취소는 일반 실행 대기를 우회하고, 단일 수신 스레드가 ID별 응답을 배분한다.
 * 요청에는 증가하는 ID를 붙여 응답과 짝짓고, 서버 오류는 SQLSTATE와 함께
 * {@link SQLException}으로 전달한다.</p>
 */
public final class Protocol {
    /** 메시지를 주고받는 하위 전송로이다. */
    private final Transport transport;
    /** 다음 요청에 붙일 메시지 ID이다. 1부터 시작한다. */
    private final AtomicLong next = new AtomicLong(1);
    /** 일반 요청과 취소 요청은 송신만 공유하며 응답은 단일 수신 스레드가 분배한다. */
    private final Object sending = new Object();
    private final Map<Long, Request> pending = new ConcurrentHashMap<Long, Request>();
    private volatile Set<String> capabilities = Collections.emptySet();
    /** 오류나 종료 뒤에 요청을 거부하기 위한 표시이다. */
    private volatile boolean closed;
    /** 연결 단위 치명 오류가 있으면 보관했다가 이후 요청에 다시 던진다. */
    private volatile SQLException failure;
    /** UDP 세션 유지를 위한 주기 ping 타이머이다. */
    private Timer heartbeat;
    /** 응답 대기 제한 시간(밀리초)이다. */
    private volatile int timeout;
    /** 인증이 끝나 정상 요청을 보낼 수 있으면 {@code true}이다. */
    private volatile boolean ready;
    /** 인증 뒤 서버가 준 세션 정보이다. */
    private Map<String, Object> session;
    /** 열린 서버 커서 ID와 행 너비의 대응표이다. */
    private final Map<Long, Integer> cursors = new HashMap<Long, Integer>();
    /**
     * 전송로 위에 프로토콜 객체를 생성한다.
     *
     * @param transport 사용할 전송 구현(TCP 또는 UDP)
     * @param timeout 응답 대기 제한 시간(밀리초)
     */
    public Protocol(Transport transport, int timeout) {
        this.transport = transport; this.timeout = timeout;
        Thread reader = new Thread(new Runnable() { public void run() { receiveResponses(); } }, "hwdb-response-reader");
        reader.setDaemon(true); reader.start();
    }

    /** 응답 대기와 취소가 공유하는 요청별 수명이다. 이전 요청 ID를 다음 실행에 재사용하지 않는다. */
    public static final class Request {
        /** 다른 연결의 요청 객체를 취소 대상으로 쓰지 못하게 한다. */
        private final Protocol owner;
        /** 연결 안의 요청 ID와 허용되는 최종 응답 종류이다. */
        private final long id;
        private final String[] expected;
        /** 단일 수신 스레드가 기록하는 완료 상태이다. 해당 요청 모니터로 보호한다. */
        private Map<String, Object> response;
        private SQLException error;
        private boolean done;
        private Request(Protocol owner, long id, String[] expected) { this.owner = owner; this.id = id; this.expected = expected; }
        public synchronized boolean isDone() { return done; }
        private synchronized void complete(Map<String, Object> value, SQLException problem) {
            if (done) return; response = value; error = problem; done = true; notifyAll();
        }
    }

    /** 같은 소켓을 여러 대기자가 읽지 않도록 모든 응답을 이 경로에서만 수신한다. */
    private void receiveResponses() {
        try {
            while (!closed) {
                Map<String, Object> response = map(Json.decode(transport.receive(0)));
                long id = number(response, "id"); String type = string(response, "type");
                if (id == 0 && "error".equals(type)) { failure = serverError(response); abort(); return; }
                Request request = pending.remove(Long.valueOf(id));
                if (request == null) throw new IOException("Unexpected response id.");
                request.complete(response, null);
                // 종료 응답을 전달한 뒤 TLS 소켓을 다시 읽어 정상 정리와 경합하지 않는다.
                if ("bye".equals(type)) return;
            }
        } catch (IOException e) { if (!closed) fail(e); }
    }

    /** 서버가 광고한 선택 기능만 사용한다. */
    public boolean supports(String feature) { return capabilities.contains(feature); }
    /** 기능 없는 서버에 확장 요청을 보내기 전에 명시적인 미지원 오류를 준다. */
    private void requireFeature(String feature) throws SQLException {
        if (!supports(feature)) throw new SQLFeatureNotSupportedException("Server does not support " + feature + ".", "0A000", 1);
    }
    /**
     * 핸드셰이크와 SCRAM-SHA-256 인증으로 세션을 연다.
     * <p>프로토콜 버전 1과 인증 방식을 협상하고, UDP이면 최대 패킷 크기와
     * 세션 유지 시간을 받아 전송로와 주기 ping에 반영한다.
     * 인증이 끝나면 메시지 크기 한도를 16 MB로 올린다.</p>
     *
     * @param user 사용자명
     * @param password 평문 비밀번호. NFKC 정규화 뒤 챌린지-응답에만 쓰인다
     * @param tablespace 접속 직후의 현재 테이블스페이스. {@code null}이면 지정하지 않는다
     * @param timeZone 세션 타임존. {@code null}이면 지정하지 않는다
     * @throws SQLException 협상 실패, 인증 실패, 입출력 오류 시
     */
    public synchronized void login(String user, String password, String tablespace, String timeZone) throws SQLException {
        try {
            Map<String, Object> hello = request(Json.object("type", "hello", "versions", Arrays.asList(Integer.valueOf(1)), "client", "HelloWorldDB JDBC"), "helloOk");
            if (number(hello, "version") != 1 || !"SCRAM-SHA-256".equals(hello.get("mechanism"))) throw new IOException("Invalid protocol negotiation.");
            if (hello.containsKey("capabilities")) {
                Set<String> features = new HashSet<String>();
                for (Object feature : list(hello.get("capabilities"))) {
                    if (!(feature instanceof String)) throw new IOException("Invalid capabilities."); features.add((String) feature);
                }
                capabilities = Collections.unmodifiableSet(features);
            }
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
    /**
     * 인증 뒤 서버가 준 세션 정보를 반환한다.
     *
     * @return 사용자, 타임존, 자동 커밋 여부 등을 담은 세션 맵
     */
    public Map<String, Object> session() { return session; }
    /**
     * 응답 대기 제한 시간을 설정한다.
     *
     * @param ms 밀리초 단위의 제한 시간. 0이면 제한 없이 기다린다
     */
    public synchronized void setTimeout(int ms) { timeout = ms; }
    /**
     * 현재 응답 대기 제한 시간을 반환한다.
     *
     * @return 밀리초 단위의 제한 시간
     */
    public synchronized int getTimeout() { return timeout; }
    /**
     * SQL 문장을 파라미터와 함께 실행한다.
     *
     * @param sql 실행할 SQL 문장
     * @param params 물음표 자리 표시자에 바인딩할 값 목록
     * @param fetchSize 조회 결과의 한 묶음 크기
     * @return 조회이면 행 묶음, 변경이면 영향 행 수를 담은 응답 맵
     * @throws SQLException 서버 오류나 응답 검증 실패 시
     */
    public synchronized Map<String, Object> execute(String sql, List<Object> params, int fetchSize) throws SQLException {
        Map<String, Object> response = request(Json.object("type", "execute", "sql", sql, "params", params, "fetchSize", Integer.valueOf(fetchSize)), "rows", "ok");
        if ("rows".equals(response.get("type"))) validateRows(response, true, null);
        else if (response.containsKey("rowCount")) try { number(response, "rowCount"); } catch (IOException e) { throw fail(e); }
        return response;
    }

    /** 실행 없는 준비·설명·해제 요청이다. 기존 서버에는 전송하지 않는다. */
    public synchronized Map<String, Object> prepare(String sql) throws SQLException {
        requireFeature("prepareDescribe");
        Map<String, Object> response = request(Json.object("type", "prepare", "sql", sql), "prepared");
        validateDescription(response, null); return response;
    }
    /** 준비 문장의 메타데이터를 값 실행 없이 다시 분석한다. */
    public synchronized Map<String, Object> describe(long statement, List<Object> hints) throws SQLException {
        requireFeature("prepareDescribe");
        Map<String, Object> message = Json.object("type", "describe", "statement", Long.valueOf(statement));
        if (hints != null) message.put("parameterTypes", hints);
        Map<String, Object> response = request(message, "description");
        validateDescription(response, Long.valueOf(statement)); return response;
    }
    /** 결과 커서와 별도로 준비 문장을 해제한다. */
    public synchronized void closePrepared(long statement) throws SQLException {
        requireFeature("prepareDescribe"); request(Json.object("type", "closePrepared", "statement", Long.valueOf(statement)), "preparedClosed");
    }
    /** 분석 응답도 행 응답과 같은 수준으로 필드·자리 순서를 확인한다. */
    private void validateDescription(Map<String, Object> response, Long expected) throws SQLException {
        try {
            long statement = number(response, "statement"), count = number(response, "parameterCount");
            if (statement < 1 || count < 0 || count > 65535 || (expected != null && statement != expected.longValue())) throw new IOException("Invalid statement description.");
            String kind = string(response, "resultKind"); List<Object> parameters = list(response.get("parameters")), columns = list(response.get("columns"));
            if (parameters.size() != count || !(kind.equals("rows") || kind.equals("ok")) || (kind.equals("ok") && !columns.isEmpty())) throw new IOException("Invalid description shape.");
            int index = 0;
            for (Object item : parameters) if (number(map(item), "index") != ++index) throw new IOException("Invalid parameter index.");
            List<Object> all = new ArrayList<Object>(parameters); all.addAll(columns);
            for (Object item : all) {
                Map<String, Object> column = map(item); string(column, "name"); string(column, "typeName"); string(column, "declared");
                if (column.containsKey("nullable") && !Arrays.asList("YES", "NO", "UNKNOWN").contains(column.get("nullable"))) throw new IOException("Invalid nullability.");
                for (String field : Arrays.asList("length", "precision", "scale", "fractionalPrecision", "leadingPrecision")) if (column.containsKey(field) && (number(column, field) < 0 || number(column, field) > Integer.MAX_VALUE)) throw new IOException("Invalid type dimensions.");
            }
        } catch (IOException e) { throw fail(e); }
    }
    /** 요청 ID를 먼저 보관한 뒤 원래 실행의 최종 응답을 기다릴 수 있게 한다. */
    public synchronized Request startExecute(String sql, Long statement, List<Object> params, int fetchSize) throws SQLException {
        Map<String, Object> message = Json.object("type", statement == null ? "execute" : "executePrepared", "params", params, "fetchSize", Integer.valueOf(fetchSize));
        if (statement == null) message.put("sql", sql); else { requireFeature("prepareDescribe"); message.put("statement", statement); }
        return startRequest(message, new String[] { "rows", "ok" });
    }
    /** 원래 실행의 최종 응답을 기다리고 결과 필드를 검증한다. */
    public synchronized Map<String, Object> finishExecute(Request request) throws SQLException {
        Map<String, Object> response = awaitResponse(request);
        if ("rows".equals(response.get("type"))) validateRows(response, true, null);
        else if (response.containsKey("rowCount")) try { number(response, "rowCount"); } catch (IOException e) { throw fail(e); }
        return response;
    }
    /** 실행 대기 잠금을 우회한다. 접수 응답은 원래 실행의 최종 응답을 대신하지 않는다. */
    public String cancel(Request target) throws SQLException {
        requireFeature("cancel");
        if (target != null && target.owner != this) throw new SQLException("Cancellation target belongs to another connection.", "22023");
        if (target == null || target.isDone()) return "notRunning";
        Map<String, Object> response = awaitResponse(startRequest(Json.object("type", "cancel", "targetId", Long.valueOf(target.id)), new String[] { "cancelAck" }));
        try {
            String status = string(response, "status");
            if (number(response, "targetId") != target.id || !Arrays.asList("accepted", "notRunning", "tooLate").contains(status)) throw new IOException("Invalid cancellation response.");
            return status;
        } catch (IOException e) { throw fail(e); }
    }
    /**
     * 열린 커서에서 다음 행 묶음을 가져온다.
     *
     * @param cursor 서버 커서 ID
     * @param size 가져올 묶음 크기
     * @return 행 묶음 응답 맵
     * @throws SQLException 서버 오류나 응답 검증 실패 시
     */
    public synchronized Map<String, Object> fetch(long cursor, int size) throws SQLException {
        Integer width = cursors.get(Long.valueOf(cursor));
        Map<String, Object> result = request(Json.object("type", "fetch", "cursor", Long.valueOf(cursor), "fetchSize", Integer.valueOf(size)), "rows");
        validateRows(result, false, width); if (!Boolean.TRUE.equals(result.get("hasMore"))) cursors.remove(Long.valueOf(cursor)); return result;
    }
    /**
     * 행 묶음 응답의 구조를 검증한다.
     * <p>컬럼 메타데이터, 행 너비, 값 종류, 커서 ID의 일관성을 확인하고,
     * 커서가 열려 있으면 추적표에 등록한다.</p>
     *
     * @param result 서버 응답 맵
     * @param columns {@code true}이면 컬럼 정의를 함께 검증한다
     * @param width 행 너비. 첫 묶음에서는 컬럼 수에서 구한다
     * @throws SQLException 구조가 올바르지 않을 때
     */
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
    /**
     * 서버 커서를 닫는다.
     *
     * @param cursor 닫을 커서 ID
     * @throws SQLException 서버 오류 시
     */
    public synchronized void closeCursor(long cursor) throws SQLException { request(Json.object("type", "closeCursor", "cursor", Long.valueOf(cursor)), "cursorClosed"); cursors.remove(Long.valueOf(cursor)); }
    /**
     * 연결 유지를 위한 ping을 보낸다.
     * <p>UDP 세션 시간 초과를 막기 위해 주기적으로도 호출된다.</p>
     *
     * @throws SQLException 서버 오류나 시간 초과 시
     */
    public synchronized void ping() throws SQLException { request(Json.object("type", "ping"), "pong"); }
    /**
     * 메시지 하나를 보내고 기대한 종류의 응답을 받는다.
     * <p>요청에 ID를 붙이고 응답 ID·종류·SQLSTATE를 검증한다.
     * 서버 오류는 SQLSTATE와 내부 번호를 살려 변환하며,
     * 연결 단위 오류 뒤에는 연결을 끊는다.</p>
     *
     * @param message 전송할 요청 맵. 호출 뒤에 ID가 추가된다
     * @param expected 허용되는 응답 종류 목록
     * @return 서버 응답 맵
     * @throws SQLException 서버 오류, 형식 오류, 입출력·시간 초과 시
     */
    public synchronized Map<String, Object> request(Map<String, Object> message, String... expected) throws SQLException {
        return awaitResponse(startRequest(message, expected));
    }

    /** 송신과 대기 등록만 수행하며 실행 대기 중 취소 송신도 허용한다. */
    private Request startRequest(Map<String, Object> message, String[] expected) throws SQLException {
        if (closed) throw failure != null ? failure : new SQLException("Connection is closed.", "08003");
        long id = next.getAndIncrement(); message.put("id", Long.valueOf(id));
        byte[] bytes;
        try { bytes = Json.encode(message); }
        catch (IOException e) { throw new SQLException(e.getMessage(), "22021", e); }
        if (bytes.length > (ready ? 16777216 : 65536)) throw new SQLException("Message size limit exceeded.", "54000", 8003);
        Request request = new Request(this, id, expected);
        pending.put(Long.valueOf(id), request);
        try {
            synchronized (sending) {
                if (closed) throw failure != null ? failure : new SQLException("Connection is closed.", "08003");
                transport.send(bytes);
            }
            return request;
        } catch (UdpTransport.FragmentLimit e) { pending.remove(Long.valueOf(id)); throw new SQLException(e.getMessage(), "54000", 8003, e); }
        catch (IOException e) { throw fail(e); }
        catch (SQLException e) { pending.remove(Long.valueOf(id)); throw e; }
    }

    /** 전용 수신 경로가 배분한 응답을 기다린다. 통신 제한 시간은 연결 단위 실패이다. */
    private Map<String, Object> awaitResponse(Request request) throws SQLException {
        try {
            long deadline = timeout == 0 ? Long.MAX_VALUE : System.nanoTime() + timeout * 1000000L;
            synchronized (request) {
                while (!request.done) {
                    long remaining = deadline == Long.MAX_VALUE ? Long.MAX_VALUE : deadline - System.nanoTime();
                    if (remaining <= 0) throw new java.net.SocketTimeoutException("Response timed out.");
                    try { request.wait(deadline == Long.MAX_VALUE ? 0 : Math.max(1, remaining / 1000000L)); }
                    catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new IOException("Response wait interrupted.", e); }
                }
                if (request.error != null) throw request.error;
            }
            Map<String, Object> response = request.response;
            String type = string(response, "type");
            if ("error".equals(type)) {
                SQLException error = serverError(response); String state = error.getSQLState();
                if (state.startsWith("08") || state.equals("28000") || state.equals("XX000") || !ready) { failure = error; abort(); }
                throw error;
            }
            for (String allowed : request.expected) if (allowed.equals(type)) return response;
            throw new IOException("Unexpected response type: " + type);
        } catch (IOException e) { throw fail(e); }
    }
    /** 서버 SQLSTATE와 내부 번호를 JDBC 예외에 보존한다. */
    private static SQLException serverError(Map<String, Object> response) throws IOException {
        String state = string(response, "sqlState"); if (!state.matches("[A-Z0-9]{5}")) throw new IOException("Invalid SQLSTATE.");
        return "0A000".equals(state)
            ? new SQLFeatureNotSupportedException(string(response, "message"), state, (int) number(response, "code"))
            : new SQLException(string(response, "message"), state, (int) number(response, "code"));
    }
    /**
     * 전송·보안 오류를 연결 단위 실패로 기록하고 연결을 끊는다.
     *
     * @param e 원인이 된 예외. 소켓 시간 초과이면 시간 초과 오류로 변환한다
     * @return 호출자에게 던질 {@link SQLException}
     */
    private SQLException fail(Exception e) {
        failure = e instanceof java.net.SocketTimeoutException ? new SQLTimeoutException(e.getMessage(), "08006", 8006, e) : new SQLException(e.getMessage(), "08006", 8006, e);
        abort(); return failure;
    }
    /**
     * 연결이 닫혔는지 확인한다.
     *
     * @return 닫혔으면 {@code true}
     */
    public boolean isClosed() { return closed; }
    /**
     * 정상 종료 메시지를 보내고 연결을 닫는다.
     *
     * @throws SQLException 종료 메시지 전송 실패 시
     */
    public synchronized void close() throws SQLException {
        if (closed) return;
        try { request(Json.object("type", "close"), "bye"); } finally { abort(); }
    }
    /**
     * 하트비트 타이머를 멈추고 전송로를 닫는다.
     * <p>이미 닫힌 상태에서 호출해도 오류 없이 넘어간다.</p>
     */
    public void abort() {
        closed = true; if (heartbeat != null) heartbeat.cancel(); transport.close();
        SQLException error = failure != null ? failure : new SQLException("Connection is closed.", "08003");
        for (Request request : pending.values()) request.complete(null, error);
        pending.clear();
    }
    /**
     * 값이 JSON 객체인지 확인하고 맵으로 변환한다.
     *
     * @param value 검사할 값
     * @return 같은 맵
     * @throws IOException 객체가 아닐 때
     */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> map(Object value) throws IOException {
        if (!(value instanceof Map<?, ?>)) throw new IOException("Expected JSON object."); return (Map<String, Object>) value;
    }
    /**
     * 값이 JSON 배열인지 확인하고 리스트로 변환한다.
     *
     * @param value 검사할 값
     * @return 같은 리스트
     * @throws IOException 배열이 아닐 때
     */
    @SuppressWarnings("unchecked")
    public static List<Object> list(Object value) throws IOException {
        if (!(value instanceof List<?>)) throw new IOException("Expected JSON array."); return (List<Object>) value;
    }
    /**
     * 맵에서 문자열 필드를 읽는다.
     *
     * @param map 읽을 맵
     * @param key 필드 이름
     * @return 필드 값
     * @throws IOException 필드가 없거나 문자열이 아닐 때
     */
    public static String string(Map<String, Object> map, String key) throws IOException {
        Object value = map.get(key); if (!(value instanceof String)) throw new IOException("Invalid field: " + key); return (String) value;
    }
    /**
     * 맵에서 정수 필드를 읽는다.
     *
     * @param map 읽을 맵
     * @param key 필드 이름
     * @return 필드 값
     * @throws IOException 필드가 없거나 정수가 아닐 때
     */
    public static long number(Map<String, Object> map, String key) throws IOException {
        Object value = map.get(key); if (!(value instanceof Long || value instanceof Integer)) throw new IOException("Invalid integer field: " + key); return ((Number) value).longValue();
    }
}
