package org.duckdns.hjow.helloworlddb.jdbc6;

import java.lang.reflect.Method;
import java.sql.*;
import java.util.*;
import java.util.concurrent.Executor;
import org.duckdns.hjow.helloworlddb.jdbc6.protocol.Protocol;

/** 세션 하나를 나타내는 Connection. 현재 세션 정보는 딕셔너리에서 읽는다. */
final class JdbcConnection extends JdbcProxy {
    final Protocol protocol; final Driver.Options options;
    final Set<JdbcStatement> statements = new HashSet<JdbcStatement>();
    private final Set<Point> points = new HashSet<Point>();
    private boolean closed; private int nextPoint, holdability = ResultSet.HOLD_CURSORS_OVER_COMMIT;
    static Connection open(Protocol p, Driver.Options o) { return new JdbcConnection(p, o).create(Connection.class); }
    private JdbcConnection(Protocol p, Driver.Options o) { protocol = p; options = o; }
    void check() throws SQLException { if (closed || protocol.isClosed()) throw new SQLException("Connection is closed.", "08003"); }
    Map<String, Object> execute(String sql, List<Object> params, int fetch) throws SQLException {
        check(); Map<String, Object> result = protocol.execute(sql, params, fetch);
        List<String> tokens = JdbcStatement.tokens(sql);
        if (!tokens.isEmpty() && Arrays.asList("COMMIT", "ROLLBACK", "CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "REVOKE").contains(tokens.get(0))) {
            if (!(tokens.get(0).equals("ROLLBACK") && tokens.size() > 1 && tokens.get(1).equals("TO"))) points.clear();
        }
        if (tokens.size() >= 2 && tokens.get(0).equals("SET") && tokens.get(1).equals("AUTOCOMMIT")) points.clear();
        return result;
    }
    void command(String sql) throws SQLException { execute(sql, Collections.<Object>emptyList(), 1); }
    private List<?> session() throws SQLException {
        Map<String, Object> r = protocol.execute("SELECT TABLESPACE_NAME, AUTOCOMMIT, IN_TRANSACTION FROM SYSTEM.SYS_SESSIONS WHERE SESSION_ID = ?", Collections.singletonList(protocol.session().get("id")), 1);
        List<?> rows = (List<?>) r.get("rows"); if (rows.isEmpty()) throw new SQLException("Session no longer exists.", "08003"); return (List<?>) rows.get(0);
    }
    boolean autoCommit() throws SQLException { return "YES".equals(session().get(1)); }
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
    static void validateHold(int hold) throws SQLException { if (hold != ResultSet.HOLD_CURSORS_OVER_COMMIT) throw unsupported("Cursor holdability"); }
    private Point point(Object p) throws SQLException { if (!(p instanceof Point) || !points.contains(p)) throw new SQLException("Invalid savepoint.", "3B001"); return (Point) p; }
    private void close() throws SQLException {
        if (closed) return; SQLException error = null;
        try { for (JdbcStatement s : new ArrayList<JdbcStatement>(statements)) try { s.close(); } catch (SQLException e) { error = e; } }
        finally { try { protocol.close(); } finally { closed = true; points.clear(); } }
        if (error != null) throw error;
    }
    private static final class Point implements Savepoint {
        final int id; final String name, sqlName;
        Point(int id, String name) { this.id = id; this.name = name; sqlName = name == null ? "HWDB_JDBC_SP_" + id : name; }
        @Override public int getSavepointId() throws SQLException { if (name != null) throw new SQLException("Named savepoint.", "HY000"); return id; }
        @Override public String getSavepointName() throws SQLException { if (name == null) throw new SQLException("Unnamed savepoint.", "HY000"); return name; }
    }
}
