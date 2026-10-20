package org.duckdns.hjow.helloworlddb.jdbc6;

import java.lang.reflect.Method;
import java.sql.*;
import java.util.*;
import java.util.concurrent.Executor;
import org.duckdns.hjow.helloworlddb.jdbc6.protocol.Protocol;

/** 세션 하나를 나타내는 Connection. 현재 세션 정보는 딕셔너리에서 읽는다.
 *
 * <p>열린 TCP·UDP 연결 위의 서버 세션을 감싼 JDBC 연결이다.
 * 자동 커밋 여부와 트랜잭션 상태는 {@code SYSTEM.SYS_SESSIONS} 딕셔너리 조회를 통해
 * 서버의 실제 값을 읽어오며, 문장 실행은 세션 단위로 순서대로 처리한다.
 * 모든 공개 동작은 동적 프록시를 거쳐 {@link #call}에서 분기된다.</p> */
final class JdbcConnection extends JdbcProxy {
    /** 서버와 주고받는 프로토콜 처리기. */
    final Protocol protocol;
    /** 접속 시 확정된 연결 옵션(가져오기 크기, 제한 시간 등). */
    final Driver.Options options;
    /** 이 연결에서 열린 문장들의 집합. 연결을 닫을 때 함께 닫는다. */
    final Set<JdbcStatement> statements = new HashSet<JdbcStatement>();
    /** 이 연결에서 만든 저장점들의 집합. 커밋·롤백 시 비운다. */
    private final Set<Point> points = new HashSet<Point>();
    /** 닫힘 여부와 저장점 일련번호, 커서 유지 방식. */
    private boolean closed; private int nextPoint, holdability = ResultSet.HOLD_CURSORS_OVER_COMMIT;
    /** 프로토콜 처리기와 연결 옵션으로부터 JDBC 연결 프록시를 만든다.
     *
     * @param p 서버와 연결된 프로토콜 처리기
     * @param o 접속 시 확정된 연결 옵션
     * @return 외부에 공개할 {@link java.sql.Connection} 프록시 */
    static Connection open(Protocol p, Driver.Options o) { return new JdbcConnection(p, o).create(Connection.class); }
    /** JDBC 연결의 내부 상태를 만든다.
     *
     * @param p 서버와 연결된 프로토콜 처리기
     * @param o 접속 시 확정된 연결 옵션 */
    private JdbcConnection(Protocol p, Driver.Options o) { protocol = p; options = o; }
    /** 연결이 닫히지 않았는지 확인한다.
     *
     * @throws SQLException 연결이 닫혔거나 전송이 끊긴 경우 */
    void check() throws SQLException { if (closed || protocol.isClosed()) throw new SQLException("Connection is closed.", "08003"); }
    /** SQL 문장을 서버에 보내고 원시 응답을 돌려준다.
     *
     * <p>트랜잭션을 끝내는 문장(COMMIT, ROLLBACK, 자동 커밋 변경과
     * 커밋을 동반하는 DDL·GRANT·REVOKE)이 성공하면 보관 중인 저장점을 비운다.</p>
     *
     * @param sql 실행할 SQL 문장
     * @param params 물음표 자리에 바인딩할 값 목록
     * @param fetch 조회 결과를 나눠 받을 묶음 크기
     * @return 서버의 실행 응답(행 묶음 또는 영향받은 행 수)
     * @throws SQLException 연결이 닫혔거나 실행에 실패한 경우 */
    Map<String, Object> execute(String sql, List<Object> params, int fetch) throws SQLException {
        check(); Map<String, Object> result = protocol.execute(sql, params, fetch);
        List<String> tokens = JdbcStatement.tokens(sql);
        if (!tokens.isEmpty() && Arrays.asList("COMMIT", "ROLLBACK", "CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "REVOKE").contains(tokens.get(0))) {
            if (!(tokens.get(0).equals("ROLLBACK") && tokens.size() > 1 && tokens.get(1).equals("TO"))) points.clear();
        }
        if (tokens.size() >= 2 && tokens.get(0).equals("SET") && tokens.get(1).equals("AUTOCOMMIT")) points.clear();
        return result;
    }
    /** 바인딩 값 없이 SQL 명령 한 개를 실행하고 결과를 버린다.
     *
     * @param sql 실행할 SQL 명령
     * @throws SQLException 연결이 닫혔거나 실행에 실패한 경우 */
    void command(String sql) throws SQLException { execute(sql, Collections.<Object>emptyList(), 1); }
    /** {@code SYSTEM.SYS_SESSIONS}에서 현재 세션의 행을 읽는다.
     *
     * @return 현재 세션 행(테이블스페이스명, 자동 커밋 여부, 트랜잭션 여부 순)
     * @throws SQLException 세션이 서버에 더 이상 없는 경우 */
    private List<?> session() throws SQLException {
        Map<String, Object> r = protocol.execute("SELECT TABLESPACE_NAME, AUTOCOMMIT, IN_TRANSACTION FROM SYSTEM.SYS_SESSIONS WHERE SESSION_ID = ?", Collections.singletonList(protocol.session().get("id")), 1);
        List<?> rows = (List<?>) r.get("rows"); if (rows.isEmpty()) throw new SQLException("Session no longer exists.", "08003"); return (List<?>) rows.get(0);
    }
    /** 서버 딕셔너리에서 읽은 현재 자동 커밋 모드를 돌려준다.
     *
     * @return 자동 커밋이 켜져 있으면 {@code true}
     * @throws SQLException 세션 조회에 실패한 경우 */
    boolean autoCommit() throws SQLException { return "YES".equals(session().get(1)); }
    /** 프록시로 들어온 {@link java.sql.Connection} 호출을 실제 동작으로 연결한다.
     *
     * <p>닫기, 유효성 검사, 문장 만들기, 자동 커밋·격리 수준·저장점 같은
     * 트랜잭션 제어, 스키마(현재 테이블스페이스) 변경, 메타데이터 조회를 처리한다.
     * 서버가 준비 문장을 저장하지 않으므로 {@code prepareStatement}는 SQL을 담은
     * 클라이언트 쪽 문장을 만든다.</p>
     *
     * @param n 호출된 메서드 이름
     * @param a 호출 인자
     * @param method 호출된 메서드 객체
     * @return 호출 결과
     * @throws Exception 연결이 닫혔거나 인자가 잘못되었거나 지원하지 않는 호출인 경우 */
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
        if (n.equals("abort")) { if (a[0] == null) throw invalid("Executor is null."); ((Executor) a[0]).execute(new Runnable() { public void run() { protocol.abort(); closed = true; } }); return null; }
        if (n.equals("setClientInfo")) {
            Properties failed = new Properties(); if (a.length == 2) failed.setProperty(String.valueOf(a[0]), String.valueOf(a[1])); else if (a[0] != null) failed.putAll((Properties) a[0]);
            if (!failed.isEmpty()) throw new SQLClientInfoException("Client info is unsupported.", "0A000", Collections.<String, ClientInfoStatus>emptyMap()); return null;
        }
        check();
        if (n.equals("createStatement") || n.equals("prepareStatement")) { {
            int offset = n.equals("createStatement") ? 0 : 1;
            if (offset == 1 && (a.length == 0 || a[0] == null)) throw invalid("SQL is null.");
            if (a.length - offset == 1) { if (!(a[offset] instanceof Integer) || (Integer) a[offset] != Statement.NO_GENERATED_KEYS) throw unsupported("Generated keys"); }
            if (a.length - offset >= 2) {
                if (!(a[offset] instanceof Integer) || (Integer) a[offset] != ResultSet.TYPE_FORWARD_ONLY || (Integer) a[offset + 1] != ResultSet.CONCUR_READ_ONLY) throw unsupported("ResultSet type/concurrency");
            }
            int hold = a.length - offset == 3 ? (Integer) a[offset + 2] : holdability; validateHold(hold);
            return JdbcStatement.open(this, offset == 1 ? (String) a[0] : null, hold);
        } }
        else if (n.equals("getAutoCommit")) { return autoCommit(); }
        else if (n.equals("setAutoCommit")) { if ((Boolean) a[0] != autoCommit()) command("SET AUTOCOMMIT " + ((Boolean) a[0] ? "ON" : "OFF")); return null; }
        else if (n.equals("commit")) { if (autoCommit()) throw new SQLException("Auto-commit is enabled.", "25000"); command("COMMIT"); return null; }
        else if (n.equals("rollback")) { {
            if (autoCommit()) throw new SQLException("Auto-commit is enabled.", "25000");
            if (a.length == 0) command("ROLLBACK"); else { Point p = point(a[0]); command("ROLLBACK TO SAVEPOINT " + quote(p.sqlName)); for (Iterator<Point> it = points.iterator(); it.hasNext();) if (it.next().id > p.id) it.remove(); } return null;
        } }
        else if (n.equals("setSavepoint")) { {
            if (autoCommit()) throw new SQLException("Auto-commit is enabled.", "25000");
            if (!"YES".equals(session().get(2))) command("BEGIN");
            int id = ++nextPoint; String name = a.length == 0 ? null : (String) a[0];
            if (a.length > 0 && (name == null || name.isEmpty())) throw invalid("Invalid savepoint name.");
            Point p = new Point(id, name); command("SAVEPOINT " + quote(p.sqlName)); for (Iterator<Point> it = points.iterator(); it.hasNext();) if (it.next().sqlName.equals(p.sqlName)) it.remove(); points.add(p); return p;
        } }
        else if (n.equals("releaseSavepoint")) { { Point p = point(a[0]); command("RELEASE SAVEPOINT " + quote(p.sqlName)); points.remove(p); return null; } }
        else if (n.equals("getTransactionIsolation")) { return Connection.TRANSACTION_READ_COMMITTED; }
        else if (n.equals("setTransactionIsolation")) { if ((Integer) a[0] != Connection.TRANSACTION_READ_COMMITTED) throw unsupported("Transaction isolation"); return null; }
        else if (n.equals("getSchema")) { return session().get(0); }
        else if (n.equals("setSchema")) { if (a[0] != null) command("USE " + quote((String) a[0])); return null; }
        else if (n.equals("getCatalog")) { return null; }
        else if (n.equals("setCatalog")) { if (a[0] != null) throw unsupported("Catalogs"); return null; }
        else if (n.equals("isReadOnly")) { return false; }
        else if (n.equals("setReadOnly")) { if ((Boolean) a[0]) throw unsupported("Read-only sessions"); return null; }
        else if (n.equals("getHoldability")) { return holdability; }
        else if (n.equals("setHoldability")) { validateHold((Integer) a[0]); holdability = (Integer) a[0]; return null; }
        else if (n.equals("getMetaData")) { return JdbcDatabaseMetaData.open(this); }
        else if (n.equals("nativeSQL")) { return a[0]; }
        else if (n.equals("getWarnings") || n.equals("clearWarnings")) { return null; }
        else if (n.equals("getClientInfo")) { return a.length == 0 ? new Properties() : null; }
        else if (n.equals("getNetworkTimeout")) { return protocol.getTimeout(); }
        else if (n.equals("setNetworkTimeout")) { if (a[0] == null || (Integer) a[1] < 0) throw invalid("Invalid network timeout."); protocol.setTimeout((Integer) a[1]); return null; }
        else if (n.equals("getTypeMap")) { return new HashMap<String, Class<?>>(); }
        else if (n.equals("setTypeMap")) { if (a[0] == null) throw invalid("Type map is null."); if (!((Map<?, ?>) a[0]).isEmpty()) throw unsupported("Custom type maps"); return null; }
        else {  throw unsupported(n); }
    }
    /** 커서 유지 방식이 서버에서 지원하는 값인지 검사한다.
     *
     * @param hold 검사할 유지 방식
     * @throws SQLException {@code HOLD_CURSORS_OVER_COMMIT}이 아닌 경우 */
    static void validateHold(int hold) throws SQLException { if (hold != ResultSet.HOLD_CURSORS_OVER_COMMIT) throw unsupported("Cursor holdability"); }
    /** 호출자가 넘긴 저장점이 이 연결에서 만든 것인지 확인한다.
     *
     * @param p 확인할 저장점 객체
     * @return 확인된 내부 저장점
     * @throws SQLException 다른 연결의 저장점이거나 이미 해제된 경우 */
    private Point point(Object p) throws SQLException { if (!(p instanceof Point) || !points.contains(p)) throw new SQLException("Invalid savepoint.", "3B001"); return (Point) p; }
    /** 연결을 닫는다. 열린 문장을 먼저 닫고 서버 세션을 종료한다.
     *
     * @throws SQLException 문장을 닫는 중에 오류가 발생한 경우 */
    private void close() throws SQLException {
        if (closed) return; SQLException error = null;
        try { for (JdbcStatement s : new ArrayList<JdbcStatement>(statements)) try { s.close(); } catch (SQLException e) { error = e; } }
        finally { try { protocol.close(); } finally { closed = true; points.clear(); } }
        if (error != null) throw error;
    }
    /** 서버 저장점과 연결되는 JDBC 저장점. 이름이 없으면 일련번호로 식별한다. */
    private static final class Point implements Savepoint {
        /** 저장점 일련번호. 이름 없는 저장점의 식별에 쓴다. */
        final int id;
        /** 호출자가 지정한 저장점 이름. 이름 없이 만들면 {@code null}이다. */
        final String name;
        /** 서버에 보낼 저장점 이름. 이름이 없으면 {@code HWDB_JDBC_SP_일련번호}이다. */
        final String sqlName;
        /** 저장점의 내부 상태를 만든다.
         *
         * @param id 저장점 일련번호
         * @param name 저장점 이름. 이름 없이 만들면 {@code null}이다 */
        Point(int id, String name) { this.id = id; this.name = name; sqlName = name == null ? "HWDB_JDBC_SP_" + id : name; }
        /** 이름 없는 저장점의 일련번호를 돌려준다.
         *
         * @return 저장점 일련번호
         * @throws SQLException 이름 있는 저장점인 경우 */
        @Override public int getSavepointId() throws SQLException { if (name != null) throw new SQLException("Named savepoint.", "HY000"); return id; }
        /** 이름 있는 저장점의 이름을 돌려준다.
         *
         * @return 저장점 이름
         * @throws SQLException 이름 없는 저장점인 경우 */
        @Override public String getSavepointName() throws SQLException { if (name == null) throw new SQLException("Unnamed savepoint.", "HY000"); return name; }
    }
}
