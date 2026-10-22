package org.duckdns.hjow.helloworlddb.jdbc8;

import java.lang.reflect.Method;
import java.sql.*;
import java.util.*;
import java.util.concurrent.Executor;
import org.duckdns.hjow.helloworlddb.jdbc8.protocol.Protocol;

/**
 * 세션 하나를 나타내는 Connection이다. 현재 세션 정보는 딕셔너리에서 읽는다.
 * <p>자동 커밋 여부와 현재 테이블스페이스는 서버의 {@code SYSTEM.SYS_SESSIONS} 뷰에서 읽으며,
 * 트랜잭션·세이브포인트 문장은 서버로 그대로 전달한다. 닫힌 연결과 끊긴 전송로에서는
 * 모든 요청 전에 오류를 낸다.</p>
 */
final class JdbcConnection extends JdbcProxy {
    /** 서버와 주고받는 프로토콜 객체이다. */
    final Protocol protocol;
    /** 파싱된 접속 옵션이다. */
    final Driver.Options options;
    /** 이 연결에서 열린 문장들의 집합이다. 연결 종료 때 함께 닫는다. */
    /** 열린 문장이다. 여러 스레드가 문장을 열고 닫으므로 동기화 집합으로 둔다. (ConcurrentHashMap.newKeySet 은 Java 8 API 이다) */
    final Set<JdbcStatement> statements = Collections.synchronizedSet(new HashSet<JdbcStatement>());
    /** 현재 트랜잭션에서 만든 세이브포인트들의 집합이다. */
    private final Set<Point> points = new HashSet<>();
    /** {@code close()} 뒤에는 요청을 거부하기 위한 표시이다. */
    private boolean closed;
    /** 다음 세이브포인트에 붙일 순번이다. */
    private int nextPoint;
    /** 커밋 뒤 커서를 유지하는 홀드빌리티 설정이다. */
    private int holdability = ResultSet.HOLD_CURSORS_OVER_COMMIT;
    /**
     * 프로토콜과 옵션으로 연결 프록시를 연다.
     *
     * @param p 인증된 프로토콜 객체
     * @param o 파싱된 접속 옵션
     * @return {@link Connection} 프록시
     */
    static Connection open(Protocol p, Driver.Options o) { return new JdbcConnection(p, o).create(Connection.class); }
    /**
     * 연결 객체를 생성한다.
     *
     * @param p 인증된 프로토콜 객체
     * @param o 파싱된 접속 옵션
     */
    private JdbcConnection(Protocol p, Driver.Options o) { protocol = p; options = o; }
    /**
     * 연결이 사용 가능한 상태인지 확인한다.
     *
     * @throws SQLException 닫혔거나 전송로가 끊겼을 때
     */
    void check() throws SQLException { if (closed || protocol.isClosed()) throw new SQLException("Connection is closed.", "08003"); }
    /**
     * SQL 문장을 실행하고 트랜잭션 경계 문장이면 세이브포인트 기록을 정리한다.
     * <p>{@code COMMIT}, {@code ROLLBACK}, DDL 등은 트랜잭션을 끝내므로
     * 보관 중인 세이브포인트를 비운다.</p>
     *
     * @param sql 실행할 SQL 문장
     * @param params 바인딩할 파라미터 값 목록
     * @param fetch 조회 결과의 묶음 크기
     * @return 서버 응답 맵
     * @throws SQLException 연결 종료나 서버 오류 시
     */
    Map<String, Object> execute(String sql, List<Object> params, int fetch) throws SQLException {
        check(); Map<String, Object> result = protocol.execute(sql, params, fetch);
        executed(sql);
        return result;
    }
    /** 일반 실행과 준비 문장 실행에 같은 트랜잭션 경계 기록을 적용한다. */
    void executed(String sql) throws SQLException {
        List<String> tokens = JdbcStatement.tokens(sql);
        if (!tokens.isEmpty() && Arrays.asList("COMMIT", "ROLLBACK", "CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "REVOKE").contains(tokens.get(0))) {
            if (!(tokens.get(0).equals("ROLLBACK") && tokens.size() > 1 && tokens.get(1).equals("TO"))) points.clear();
        }
        if (tokens.size() >= 2 && tokens.get(0).equals("SET") && tokens.get(1).equals("AUTOCOMMIT")) points.clear();
    }
    /**
     * 결과가 필요 없는 관리 문장을 실행한다.
     *
     * @param sql 실행할 SQL 문장
     * @throws SQLException 연결 종료나 서버 오류 시
     */
    void command(String sql) throws SQLException { execute(sql, Collections.emptyList(), 1); }
    /**
     * 현재 세션의 행을 딕셔너리에서 읽는다.
     *
     * @return 테이블스페이스명, 자동 커밋 여부, 트랜잭션 여부 순의 행
     * @throws SQLException 세션이 사라졌을 때
     */
    private List<?> session() throws SQLException {
        Map<String, Object> r = protocol.execute("SELECT TABLESPACE_NAME, AUTOCOMMIT, IN_TRANSACTION FROM SYSTEM.SYS_SESSIONS WHERE SESSION_ID = ?", Collections.singletonList(protocol.session().get("id")), 1);
        List<?> rows = (List<?>) r.get("rows"); if (rows.isEmpty()) throw new SQLException("Session no longer exists.", "08003"); return (List<?>) rows.get(0);
    }
    /**
     * 서버 기준의 자동 커밋 여부를 반환한다.
     *
     * @return 자동 커밋이면 {@code true}
     * @throws SQLException 세션 조회 실패 시
     */
    boolean autoCommit() throws SQLException { return "YES".equals(session().get(1)); }
    /**
     * {@link Connection} 메서드 호출을 처리한다.
     * <p>문장 생성, 자동 커밋·격리 수준·스키마·홀드빌리티·세이브포인트·롤백 등을
     * 서버 문장과 세션 조회로 구현한다. 생성된 문장은 추적 집합에 등록된다.</p>
     *
     * @param n 호출된 메서드 이름
     * @param a 호출 인자
     * @param method 호출된 메서드 리플렉션 정보
     * @return 메서드 반환 값
     * @throws Exception 잘못된 인자, 상태 위반, 서버 오류 시
     */
    @Override synchronized Object call(String n, Object[] a, Method method) throws Exception {
        if (n.equals("close")) { close(); return null; }
        if (n.equals("isClosed")) return closed || protocol.isClosed();
        if (n.equals("isValid")) {
            if ((Integer) a[0] < 0) throw invalid("Invalid validation timeout.");
            if (closed || protocol.isClosed()) return false;
            int old = protocol.getTimeout();
            try { protocol.setTimeout((int) Math.min(Integer.MAX_VALUE, (Integer) a[0] * 1000L)); protocol.ping(); return true; }
            catch (SQLException e) { return false; } finally { protocol.setTimeout(old); }
        }
        if (n.equals("abort")) { if (a[0] == null) throw invalid("Executor is null."); ((Executor) a[0]).execute(() -> { protocol.abort(); closed = true; }); return null; }
        if (n.equals("setClientInfo")) {
            Properties failed = new Properties(); if (a.length == 2) failed.setProperty(String.valueOf(a[0]), String.valueOf(a[1])); else if (a[0] != null) failed.putAll((Properties) a[0]);
            if (!failed.isEmpty()) throw new SQLClientInfoException("Client info is unsupported.", "0A000", Collections.emptyMap()); return null;
        }
        check();
        switch (n) {
        case "createStatement": case "prepareStatement": {
            int offset = n.equals("createStatement") ? 0 : 1;
            if (offset == 1 && (a.length == 0 || a[0] == null)) throw invalid("SQL is null.");
            if (a.length - offset == 1) { if (!(a[offset] instanceof Integer) || (Integer) a[offset] != Statement.NO_GENERATED_KEYS) throw unsupported("Generated keys"); }
            if (a.length - offset >= 2) {
                if (!(a[offset] instanceof Integer) || (Integer) a[offset] != ResultSet.TYPE_FORWARD_ONLY || (Integer) a[offset + 1] != ResultSet.CONCUR_READ_ONLY) throw unsupported("ResultSet type/concurrency");
            }
            int hold = a.length - offset == 3 ? (Integer) a[offset + 2] : holdability; validateHold(hold);
            return JdbcStatement.open(this, offset == 1 ? (String) a[0] : null, hold);
        }
        case "getAutoCommit": return autoCommit();
        case "setAutoCommit": if ((Boolean) a[0] != autoCommit()) command("SET AUTOCOMMIT " + ((Boolean) a[0] ? "ON" : "OFF")); return null;
        case "commit": if (autoCommit()) throw new SQLException("Auto-commit is enabled.", "25000"); command("COMMIT"); return null;
        case "rollback": {
            if (autoCommit()) throw new SQLException("Auto-commit is enabled.", "25000");
            if (a.length == 0) command("ROLLBACK"); else { Point p = point(a[0]); command("ROLLBACK TO SAVEPOINT " + quote(p.sqlName)); points.removeIf(x -> x.id > p.id); } return null;
        }
        case "setSavepoint": {
            if (autoCommit()) throw new SQLException("Auto-commit is enabled.", "25000");
            if (!"YES".equals(session().get(2))) command("BEGIN");
            int id = ++nextPoint; String name = a.length == 0 ? null : (String) a[0];
            if (a.length > 0 && (name == null || name.isEmpty())) throw invalid("Invalid savepoint name.");
            Point p = new Point(id, name); command("SAVEPOINT " + quote(p.sqlName)); points.removeIf(x -> x.sqlName.equals(p.sqlName)); points.add(p); return p;
        }
        case "releaseSavepoint": { Point p = point(a[0]); command("RELEASE SAVEPOINT " + quote(p.sqlName)); points.remove(p); return null; }
        case "getTransactionIsolation": return Connection.TRANSACTION_READ_COMMITTED;
        case "setTransactionIsolation": if ((Integer) a[0] != Connection.TRANSACTION_READ_COMMITTED) throw unsupported("Transaction isolation"); return null;
        case "getSchema": return session().get(0);
        case "setSchema": if (a[0] != null) command("USE " + quote((String) a[0])); return null;
        case "getCatalog": return null;
        case "setCatalog": if (a[0] != null) throw unsupported("Catalogs"); return null;
        case "isReadOnly": return false;
        case "setReadOnly": if ((Boolean) a[0]) throw unsupported("Read-only sessions"); return null;
        case "getHoldability": return holdability;
        case "setHoldability": validateHold((Integer) a[0]); holdability = (Integer) a[0]; return null;
        case "getMetaData": return JdbcDatabaseMetaData.open(this);
        case "nativeSQL": return a[0];
        case "getWarnings": case "clearWarnings": return null;
        case "getClientInfo": return a.length == 0 ? new Properties() : null;
        case "getNetworkTimeout": return protocol.getTimeout();
        case "setNetworkTimeout": if (a[0] == null || (Integer) a[1] < 0) throw invalid("Invalid network timeout."); protocol.setTimeout((Integer) a[1]); return null;
        case "getTypeMap": return new HashMap<String, Class<?>>();
        case "setTypeMap": if (a[0] == null) throw invalid("Type map is null."); if (!((Map<?, ?>) a[0]).isEmpty()) throw unsupported("Custom type maps"); return null;
        default: throw unsupported(n);
        }
    }
    /**
     * 홀드빌리티 값이 지원되는지 검사한다.
     *
     * @param hold 검사할 홀드빌리티 값
     * @throws SQLException 커밋 뒤 커서 유지가 아닐 때
     */
    static void validateHold(int hold) throws SQLException { if (hold != ResultSet.HOLD_CURSORS_OVER_COMMIT) throw unsupported("Cursor holdability"); }
    /**
     * 인자로 받은 세이브포인트가 이 연결의 것인지 확인한다.
     *
     * @param p 세이브포인트 객체
     * @return 같은 연결의 세이브포인트
     * @throws SQLException 다른 연결의 객체나 잘못된 종류일 때
     */
    private Point point(Object p) throws SQLException { if (!(p instanceof Point) || !points.contains(p)) throw new SQLException("Invalid savepoint.", "3B001"); return (Point) p; }
    /**
     * 열린 문장을 모두 닫고 전송로를 끊는다.
     * <p>문장을 닫다 오류가 나도 연결 종료는 계속하며, 첫 오류를 다시 던진다.</p>
     *
     * @throws SQLException 열린 문장을 닫는 중 오류가 났을 때
     */
    private void close() throws SQLException {
        if (closed) return; SQLException error = null;
        // 문장이 다른 스레드에서 닫히며 집합을 바꿀 수 있으므로, 복사는 집합의 모니터를 잡고 한다. (J-4)
        List<JdbcStatement> open;
        synchronized (statements) { open = new ArrayList<JdbcStatement>(statements); }
        try { for (JdbcStatement s : open) try { s.close(); } catch (SQLException e) { error = e; } }
        finally { try { protocol.close(); } finally { closed = true; points.clear(); } }
        if (error != null) throw error;
    }
    /**
     * 이름·무명 세이브포인트를 나타낸다.
     * <p>무명 세이브포인트는 서버에 {@code HWDB_JDBC_SP_번호} 이름으로 만든다.</p>
     */
    private static final class Point implements Savepoint {
        /** 생성 순서대로 붙는 식별자이다. */
        final int id;
        /** 사용자가 지정한 이름이다. 무명이면 {@code null}이다. */
        final String name;
        /** 서버에 전달하는 실제 이름이다. */
        final String sqlName;
        /**
         * 세이브포인트를 생성한다.
         *
         * @param id 순번 식별자
         * @param name 사용자 지정 이름. 무명이면 {@code null}이다
         */
        Point(int id, String name) { this.id = id; this.name = name; sqlName = name == null ? "HWDB_JDBC_SP_" + id : name; }
        /**
         * 무명 세이브포인트의 식별자를 반환한다.
         *
         * @return 순번 식별자
         * @throws SQLException 이름 있는 세이브포인트일 때
         */
        @Override public int getSavepointId() throws SQLException { if (name != null) throw new SQLException("Named savepoint.", "HY000"); return id; }
        /**
         * 이름 있는 세이브포인트의 이름을 반환한다.
         *
         * @return 사용자 지정 이름
         * @throws SQLException 무명 세이브포인트일 때
         */
        @Override public String getSavepointName() throws SQLException { if (name == null) throw new SQLException("Unnamed savepoint.", "HY000"); return name; }
    }
}
