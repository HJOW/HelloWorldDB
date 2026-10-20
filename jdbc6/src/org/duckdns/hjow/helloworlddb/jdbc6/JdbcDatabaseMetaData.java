package org.duckdns.hjow.helloworlddb.jdbc6;

import java.lang.reflect.Method;
import java.sql.*;
import java.util.*;
import java.util.regex.Pattern;
import org.duckdns.hjow.helloworlddb.jdbc6.protocol.Protocol;

/** SYSTEM 딕셔너리의 가시성 규칙을 그대로 사용하는 JDBC 메타데이터.
 *
 * <p>테이블, 컬럼, 키, 인덱스, 권한 정보는 {@code SYSTEM.SYS_*} 딕셔너리 뷰를
 * 조회하여 구하며, 서버의 권한 가시성 규칙이 그대로 적용된다.
 * 저장 프로시저와 카탈로그처럼 서버가 지원하지 않는 항목은 빈 결과를 돌려준다.
 * 모든 공개 동작은 동적 프록시를 거쳐 {@link #call}에서 분기된다.</p> */
final class JdbcDatabaseMetaData extends JdbcProxy {
    /** 시스템 테이블로 취급하는 딕셔너리 뷰와 {@code DUAL}의 이름 목록. */
    private static final List<String> SYSTEM_OBJECTS = Arrays.asList("DUAL", "SYS_TABLESPACES", "SYS_USERS", "SYS_TABLES", "SYS_COLUMNS", "SYS_VIEWS", "SYS_INDEXES", "SYS_INDEX_COLUMNS", "SYS_CONSTRAINTS", "SYS_CONSTRAINT_COLUMNS", "SYS_PRIVILEGES", "SYS_GROUP_GRANTS", "SYS_SESSIONS");
    /** 두 객체가 같은지 확인한다. 둘 다 {@code null}이면 같다고 본다.
     *
     * @param a 비교할 첫 번째 객체
     * @param b 비교할 두 번째 객체
     * @return 두 값이 같으면 {@code true} */
    private static boolean equal(Object a, Object b) { return a == null ? b == null : a.equals(b); }
    /** 조회된 행 목록을 지정 필드와 숫자 필드 순으로 정렬한다.
     *
     * @param rows 정렬할 행 목록. 제자리에서 정렬된다
     * @param fields 문자열로 비교할 필드 위치 배열
     * @param numeric 숫자로 비교할 필드 위치. 음수이면 숫자 비교를 하지 않는다 */
    private static void sort(List<List<Object>> rows, final int[] fields, final int numeric) {
        Collections.sort(rows, new Comparator<List<Object>>() { public int compare(List<Object> a, List<Object> b) {
            for (int field : fields) { int d = String.valueOf(a.get(field)).compareTo(String.valueOf(b.get(field))); if (d != 0) return d; }
            if (numeric < 0) return 0; long x = ((Number) a.get(numeric)).longValue(), y = ((Number) b.get(numeric)).longValue(); return x < y ? -1 : x == y ? 0 : 1;
        } });
    }
    /** 이 메타데이터가 속한 연결. */
    private final JdbcConnection c;
    /** 메타데이터의 내부 상태를 만든다.
     *
     * @param c 이 메타데이터가 속한 연결 */
    private JdbcDatabaseMetaData(JdbcConnection c) { this.c = c; }
    /** 연결으로부터 데이터베이스 메타데이터 프록시를 만든다.
     *
     * @param c 이 메타데이터가 속한 연결
     * @return 외부에 공개할 {@link java.sql.DatabaseMetaData} 프록시 */
    static DatabaseMetaData open(JdbcConnection c) { return new JdbcDatabaseMetaData(c).create(DatabaseMetaData.class); }
    /** 프록시로 들어온 {@link java.sql.DatabaseMetaData} 호출을 처리한다.
     *
     * <p>드라이버·제품 버전(JDBC 4.0, 제품 0.1.0), 식별자·검색 규칙,
     * 지원 기능 여부와 함께 스키마·테이블·컬럼·키·인덱스·권한·타입 조회를 제공한다.
     * 테이블스페이스는 스키마 이름으로 대응한다.</p>
     *
     * @param n 호출된 메서드 이름
     * @param a 호출 인자
     * @param m 호출된 메서드 객체
     * @return 호출 결과
     * @throws Exception 연결이 닫혔거나 인자가 잘못되었거나 지원하지 않는 호출인 경우 */
    @Override Object call(String n, Object[] a, Method m) throws Exception {
        c.check();
        if (n.equals("getConnection")) { return c.proxy; }
        else if (n.equals("getJDBCMajorVersion")) { return 4; }
        else if (n.equals("getJDBCMinorVersion")) { return 0; }
        else if (n.equals("getDriverName")) { return "HelloWorldDB JDBC 4.0 Driver"; }
        else if (n.equals("getDriverVersion")) { return "0.1.0"; }
        else if (n.equals("getDriverMajorVersion") || n.equals("getDatabaseMajorVersion")) { return 0; }
        else if (n.equals("getDriverMinorVersion") || n.equals("getDatabaseMinorVersion")) { return 1; }
        else if (n.equals("getDatabaseProductName")) { return "HelloWorldDB"; }
        else if (n.equals("getDatabaseProductVersion")) { return "0.1.0"; }
        else if (n.equals("getURL")) { return c.options.url.replaceAll("(?i)([?&]password=)[^&]*", "$1"); }
        else if (n.equals("getUserName")) { return c.protocol.session().get("user"); }
        else if (n.equals("getIdentifierQuoteString")) { return "\""; }
        else if (n.equals("getSearchStringEscape")) { return "\\"; }
        else if (n.equals("getSchemaTerm")) { return "tablespace"; }
        else if (n.equals("getCatalogTerm")) { return ""; }
        else if (n.equals("getProcedureTerm")) { return "procedure"; }
        else if (n.equals("getCatalogSeparator")) { return "."; }
        else if (n.equals("getSQLKeywords")) { return "USE,NVL,TO_CHAR,TO_DATE,LIMIT,TABLESPACE,OFFICER,CONNECT,DBA"; }
        else if (n.equals("getNumericFunctions")) { return "ABS,MOD,CEIL,FLOOR,POWER,SQRT,ROUND"; }
        else if (n.equals("getStringFunctions")) { return "UPPER,LOWER,TRIM,SUBSTRING,POSITION,CHAR_LENGTH,OCTET_LENGTH,LENGTH,SUBSTR,REPLACE,LTRIM,RTRIM,CONCAT"; }
        else if (n.equals("getSystemFunctions")) { return "COALESCE,NULLIF,CURRENT_USER,NVL"; }
        else if (n.equals("getTimeDateFunctions")) { return "CURRENT_DATE,CURRENT_TIME,CURRENT_TIMESTAMP,LOCALTIME,LOCALTIMESTAMP,EXTRACT,TO_DATE,TO_CHAR"; }
        else if (n.equals("getExtraNameCharacters")) { return "_$"; }
        else if (n.equals("getDefaultTransactionIsolation")) { return Connection.TRANSACTION_READ_COMMITTED; }
        else if (n.equals("getResultSetHoldability")) { return ResultSet.HOLD_CURSORS_OVER_COMMIT; }
        else if (n.equals("getSQLStateType")) { return DatabaseMetaData.sqlStateSQL; }
        else if (n.equals("getRowIdLifetime")) { return RowIdLifetime.ROWID_UNSUPPORTED; }
        else if (n.equals("getMaxColumnNameLength") || n.equals("getMaxSchemaNameLength") || n.equals("getMaxTableNameLength") || n.equals("getMaxUserNameLength")) { return 128; }
        else if (n.equals("getMaxColumnsInTable")) { return 1000; }
        else if (n.equals("getMaxColumnsInIndex")) { return 16; }
        else if (n.equals("getMaxConnections")) { return 0; }
        else if (n.equals("getMaxStatements")) { return 0; }
        else if (n.equals("getMaxCharLiteralLength") || n.equals("getMaxBinaryLiteralLength") || n.equals("getMaxStatementLength")) { return 16777216; }
        else if (n.equals("getMaxIndexLength") || n.equals("getMaxRowSize") || n.equals("getMaxColumnsInSelect") || n.equals("getMaxColumnsInGroupBy") || n.equals("getMaxColumnsInOrderBy") || n.equals("getMaxTablesInSelect") || n.equals("getMaxCatalogNameLength") || n.equals("getMaxProcedureNameLength") || n.equals("getMaxCursorNameLength")) { return 0; }
        else if (n.equals("isReadOnly") || n.equals("allProceduresAreCallable") || n.equals("usesLocalFiles") || n.equals("usesLocalFilePerTable") || n.equals("isCatalogAtStart")) { return false; }
        else if (n.equals("allTablesAreSelectable")) { return false; }
        else if (n.equals("nullsAreSortedHigh") || n.equals("storesUpperCaseIdentifiers") || n.equals("storesMixedCaseQuotedIdentifiers") || n.equals("supportsMixedCaseQuotedIdentifiers")) { return true; }
        else if (n.equals("nullsAreSortedLow") || n.equals("nullsAreSortedAtStart") || n.equals("nullsAreSortedAtEnd") || n.equals("storesLowerCaseIdentifiers") || n.equals("storesMixedCaseIdentifiers") || n.equals("supportsMixedCaseIdentifiers") || n.equals("storesUpperCaseQuotedIdentifiers") || n.equals("storesLowerCaseQuotedIdentifiers")) { return false; }
        else if (n.equals("supportsTransactionIsolationLevel")) { return (Integer) a[0] == Connection.TRANSACTION_READ_COMMITTED; }
        else if (n.equals("supportsResultSetType")) { return (Integer) a[0] == ResultSet.TYPE_FORWARD_ONLY; }
        else if (n.equals("supportsResultSetConcurrency")) { return (Integer) a[0] == ResultSet.TYPE_FORWARD_ONLY && (Integer) a[1] == ResultSet.CONCUR_READ_ONLY; }
        else if (n.equals("supportsResultSetHoldability")) { return (Integer) a[0] == ResultSet.HOLD_CURSORS_OVER_COMMIT; }
        else if (n.equals("supportsConvert")) { return false; }
        else if (n.equals("getSchemas")) { return schemas(a); }
        else if (n.equals("getCatalogs")) { return table(new String[] { "TABLE_CAT" }, new String[] { "VARCHAR(128)" }, Collections.<List<Object>>emptyList()); }
        else if (n.equals("getTableTypes")) { List<List<Object>> types = new ArrayList<List<Object>>(); for (String type : Arrays.asList("TABLE", "VIEW", "SYSTEM TABLE")) types.add(row(type)); return table(new String[] { "TABLE_TYPE" }, new String[] { "VARCHAR(32)" }, types); }
        else if (n.equals("getTables")) { return tables(a); }
        else if (n.equals("getColumns")) { return columns(a); }
        else if (n.equals("getPrimaryKeys")) { return primaryKeys(a); }
        else if (n.equals("getImportedKeys") || n.equals("getExportedKeys") || n.equals("getCrossReference")) { return foreignKeys(n, a); }
        else if (n.equals("getIndexInfo")) { return indexes(a); }
        else if (n.equals("getTypeInfo")) { return typeInfo(); }
        else if (n.equals("getTablePrivileges")) { return privileges(a); }
        else if (n.equals("getProcedures")) { return table(new String[] { "PROCEDURE_CAT", "PROCEDURE_SCHEM", "PROCEDURE_NAME", "RESERVED1", "RESERVED2", "RESERVED3", "REMARKS", "PROCEDURE_TYPE", "SPECIFIC_NAME" }, new String[] { "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "SMALLINT", "VARCHAR" }, Collections.<List<Object>>emptyList()); }
        else if (n.equals("getClientInfoProperties")) { return table(new String[] { "NAME", "MAX_LEN", "DEFAULT_VALUE", "DESCRIPTION" }, new String[] { "VARCHAR", "INTEGER", "VARCHAR", "VARCHAR" }, Collections.<List<Object>>emptyList()); }
        else if (n.equals("getSuperTables")) { return table(new String[] { "TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "SUPERTABLE_NAME" }, new String[] { "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR" }, Collections.<List<Object>>emptyList()); }
        else {   }
        if (Arrays.asList("supportsTransactions", "supportsSavepoints", "supportsBatchUpdates", "supportsUnion", "supportsUnionAll", "supportsOuterJoins", "supportsFullOuterJoins", "supportsLimitedOuterJoins", "supportsCorrelatedSubqueries", "supportsSubqueriesInComparisons", "supportsSubqueriesInExists", "supportsSubqueriesInIns", "supportsSubqueriesInQuantifieds", "supportsGroupBy", "supportsGroupByUnrelated", "supportsExpressionsInOrderBy", "supportsOrderByUnrelated", "supportsColumnAliasing", "supportsTableCorrelationNames", "supportsDifferentTableCorrelationNames", "supportsNonNullableColumns", "supportsLikeEscapeClause", "supportsAlterTableWithAddColumn", "supportsAlterTableWithDropColumn", "supportsSchemasInDataManipulation", "supportsSchemasInTableDefinitions", "supportsSchemasInIndexDefinitions", "supportsSchemasInPrivilegeDefinitions", "dataDefinitionCausesTransactionCommit", "dataDefinitionIgnoredInTransactions", "supportsOpenCursorsAcrossCommit", "supportsOpenCursorsAcrossRollback", "supportsOpenStatementsAcrossCommit", "supportsOpenStatementsAcrossRollback", "supportsDataManipulationTransactionsOnly", "nullPlusNonNullIsNull").contains(n)) return !n.equals("dataDefinitionIgnoredInTransactions");
        if (m.getReturnType() == boolean.class) return false;
        throw unsupported(n);
    }
    /** {@code SYSTEM} 딕셔너리 뷰 전체를 행 맵 목록으로 읽는다.
     *
     * <p>fetch를 반복하여 모든 묶음을 모으며, 열린 커서는 반드시 닫는다.</p>
     *
     * @param name 읽을 딕셔너리 뷰 이름(예: {@code SYS_TABLES})
     * @return 컬럼 이름을 키로 하는 행 맵 목록
     * @throws Exception 조회에 실패한 경우 */
    private List<Map<String, Object>> dictionary(String name) throws Exception {
        Map<String, Object> response = c.protocol.execute("SELECT * FROM SYSTEM." + name, Collections.<Object>emptyList(), 500);
        List<Object> columns = Protocol.list(response.get("columns")); List<Map<String, Object>> result = new ArrayList<Map<String, Object>>(); long cursor = 0;
        try {
            for (;;) {
                cursor = Boolean.TRUE.equals(response.get("hasMore")) ? ((Number) response.get("cursor")).longValue() : 0;
                for (Object r : Protocol.list(response.get("rows"))) {
                    List<Object> values = Protocol.list(r); Map<String, Object> item = new HashMap<String, Object>();
                    for (int i = 0; i < columns.size(); i++) item.put((String) Protocol.map(columns.get(i)).get("name"), values.get(i)); result.add(item);
                }
                if (cursor == 0) return result; response = c.protocol.fetch(cursor, 500);
            }
        } finally { if (cursor != 0 && !c.protocol.isClosed()) c.protocol.closeCursor(cursor); }
    }
    /** 카탈로그 인자가 비었는지 확인한다. 서버는 카탈로그를 두지 않으므로 비어 있어야 한다.
     *
     * @param value 확인할 카탈로그 인자
     * @return {@code null}이거나 빈 문자열이면 {@code true} */
    private static boolean catalog(Object value) { return value == null || value.equals(""); }
    /** 메타데이터 조회에서 정확히 일치 조건을 검사한다. 기대값이 {@code null}이면 통과한다.
     *
     * @param expected 기대값. {@code null}이면 어떤 값이든 통과한다
     * @param value 실제 값
     * @return 조건을 만족하면 {@code true} */
    private static boolean exact(Object expected, Object value) { return expected == null || expected.equals(value); }
    /** 메타데이터 조회의 LIKE 패턴 조건을 검사한다. {@code \%}, {@code \_} 이스케이프를 지원한다.
     *
     * @param pattern LIKE 패턴. {@code null}이면 어떤 값이든 통과한다
     * @param value 실제 값
     * @return 패턴에 맞으면 {@code true} */
    private static boolean like(Object pattern, Object value) {
        if (pattern == null) return true; if (value == null) return false;
        String s = pattern.toString(); StringBuilder regex = new StringBuilder("(?s)");
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i); if (ch == '\\' && i + 1 < s.length()) regex.append(Pattern.quote(String.valueOf(s.charAt(++i))));
            else if (ch == '%') regex.append(".*"); else if (ch == '_') regex.append('.'); else regex.append(Pattern.quote(String.valueOf(ch)));
        }
        return value.toString().matches(regex.toString());
    }
    /** 결과 행 한 개를 만든다.
     *
     * @param values 행에 담을 값 목록
     * @return 값 목록으로 만든 행 */
    static List<Object> row(Object... values) { return Arrays.asList(values); }
    /** 컬럼 이름과 선언 목록, 행 목록으로부터 메모리 결과 집합을 만든다.
     *
     * @param names 결과 컬럼 이름 배열
     * @param types 결과 컬럼 선언 배열
     * @param rows 행 목록
     * @return 메모리 {@link java.sql.ResultSet} 프록시 */
    private static ResultSet table(String[] names, String[] types, List<List<Object>> rows) {
        List<Values.Column> columns = new ArrayList<Values.Column>(); for (int i = 0; i < names.length; i++) columns.add(new Values.Column(names[i], types[i])); return JdbcResultSet.memory(columns, rows);
    }
    /** 테이블스페이스 목록을 스키마 목록으로 돌려준다.
     *
     * @param a {@code getSchemas} 호출 인자(카탈로그, 스키마 패턴)
     * @return 스키마 목록 결과 집합
     * @throws Exception 딕셔너리 조회에 실패한 경우 */
    private ResultSet schemas(Object[] a) throws Exception {
        List<List<Object>> rows = new ArrayList<List<Object>>();
        if (a.length == 0 || catalog(a[0])) for (Map<String, Object> t : dictionary("SYS_TABLESPACES")) if (a.length == 0 || like(a[1], t.get("TABLESPACE_NAME"))) rows.add(row(t.get("TABLESPACE_NAME"), null));
        sort(rows, new int[] { 0 }, -1);
        return table(new String[] { "TABLE_SCHEM", "TABLE_CATALOG" }, new String[] { "VARCHAR(128)", "VARCHAR(128)" }, rows);
    }
    /** 테이블과 뷰, 시스템 테이블 목록을 돌려준다.
     *
     * @param a {@code getTables} 호출 인자(카탈로그, 스키마 패턴, 이름 패턴, 종류 목록)
     * @return 테이블 목록 결과 집합
     * @throws Exception 딕셔너리 조회에 실패한 경우 */
    private ResultSet tables(Object[] a) throws Exception {
        List<List<Object>> rows = new ArrayList<List<Object>>(); List<?> types = a[3] == null ? null : Arrays.asList((String[]) a[3]);
        if (catalog(a[0])) for (String view : Arrays.asList("SYS_TABLES", "SYS_VIEWS")) for (Map<String, Object> t : dictionary(view)) {
            String type = view.equals("SYS_TABLES") ? "TABLE" : "VIEW"; Object name = t.get(view.equals("SYS_TABLES") ? "TABLE_NAME" : "VIEW_NAME");
            if (like(a[1], t.get("TABLESPACE_NAME")) && like(a[2], name) && (types == null || types.contains(type))) rows.add(row(null, t.get("TABLESPACE_NAME"), name, type, "", null, null, null, null, null));
        }
        if (catalog(a[0]) && like(a[1], "SYSTEM") && (types == null || types.contains("SYSTEM TABLE"))) for (String name : SYSTEM_OBJECTS) if (like(a[2], name)) rows.add(row(null, "SYSTEM", name, "SYSTEM TABLE", "", null, null, null, null, null));
        sort(rows, new int[] { 3, 1, 2 }, -1);
        return table(new String[] { "TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "TABLE_TYPE", "REMARKS", "TYPE_CAT", "TYPE_SCHEM", "TYPE_NAME", "SELF_REFERENCING_COL_NAME", "REF_GENERATION" }, Collections.nCopies(10, "VARCHAR(128)").toArray(new String[0]), rows);
    }
    /** 테이블과 뷰의 컬럼 목록을 돌려준다.
     *
     * <p>테이블 컬럼은 {@code SYS_COLUMNS}에서 읽고, 딕셔너리에 없는 뷰의 컬럼은
     * 해당 뷰에 빈 조회를 보내 결과 메타데이터로 보완한다.</p>
     *
     * @param a {@code getColumns} 호출 인자(카탈로그, 스키마 패턴, 테이블 패턴, 컬럼 패턴)
     * @return 컬럼 목록 결과 집합
     * @throws Exception 딕셔너리 조회에 실패한 경우 */
    private ResultSet columns(Object[] a) throws Exception {
        List<List<Object>> rows = new ArrayList<List<Object>>();
        if (catalog(a[0])) for (Map<String, Object> col : dictionary("SYS_COLUMNS")) {
            if (!like(a[1], col.get("TABLESPACE_NAME")) || !like(a[2], col.get("TABLE_NAME")) || !like(a[3], col.get("COLUMN_NAME"))) continue;
            Values.Column type = new Values.Column((String) col.get("COLUMN_NAME"), (String) col.get("DATA_TYPE"));
            boolean text = type.type == Types.CHAR || type.type == Types.VARCHAR;
            rows.add(row(null, col.get("TABLESPACE_NAME"), col.get("TABLE_NAME"), col.get("COLUMN_NAME"), type.type, type.typeName, type.precision, null, type.scale, 10,
                "YES".equals(col.get("IS_NULLABLE")) ? DatabaseMetaData.columnNullable : DatabaseMetaData.columnNoNulls, "", col.get("COLUMN_DEFAULT"), null, null, text ? type.precision * 4 : null,
                col.get("ORDINAL_POSITION"), col.get("IS_NULLABLE"), null, null, null, null, "NO", "NO"));
        }
        if (catalog(a[0])) {
            // SYS_COLUMNS에 없는 뷰의 컬럼은 행을 읽지 않는 SELECT의 결과 메타데이터로 보완한다.
            for (Map<String, Object> view : dictionary("SYS_VIEWS")) if (like(a[1], view.get("TABLESPACE_NAME")) && like(a[2], view.get("VIEW_NAME")))
                viewColumns(rows, (String) view.get("TABLESPACE_NAME"), (String) view.get("VIEW_NAME"), a[3]);
            if (like(a[1], "SYSTEM")) for (String name : SYSTEM_OBJECTS) if (like(a[2], name)) viewColumns(rows, "SYSTEM", name, a[3]);
        }
        sort(rows, new int[] { 1, 2 }, 16);
        return table(new String[] { "TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "COLUMN_NAME", "DATA_TYPE", "TYPE_NAME", "COLUMN_SIZE", "BUFFER_LENGTH", "DECIMAL_DIGITS", "NUM_PREC_RADIX", "NULLABLE", "REMARKS", "COLUMN_DEF", "SQL_DATA_TYPE", "SQL_DATETIME_SUB", "CHAR_OCTET_LENGTH", "ORDINAL_POSITION", "IS_NULLABLE", "SCOPE_CATALOG", "SCOPE_SCHEMA", "SCOPE_TABLE", "SOURCE_DATA_TYPE", "IS_AUTOINCREMENT", "IS_GENERATEDCOLUMN" },
            new String[] { "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "INTEGER", "VARCHAR", "INTEGER", "INTEGER", "INTEGER", "INTEGER", "INTEGER", "VARCHAR", "VARCHAR", "INTEGER", "INTEGER", "INTEGER", "INTEGER", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "SMALLINT", "VARCHAR", "VARCHAR" }, rows);
    }
    /** 뷰에 빈 조회를 보내 컬럼 정보를 모아 행 목록에 더한다.
     *
     * @param rows 모으는 행 목록
     * @param schema 뷰가 속한 테이블스페이스
     * @param name 뷰 이름
     * @param pattern 컬럼 이름 패턴
     * @throws Exception 조회에 실패한 경우 */
    private void viewColumns(List<List<Object>> rows, String schema, String name, Object pattern) throws Exception {
        Map<String, Object> response;
        try { response = c.protocol.execute("SELECT * FROM " + quote(schema) + "." + quote(name) + " WHERE 1 = 0", Collections.<Object>emptyList(), 1); }
        catch (SQLException e) { if (e.getSQLState().equals("42501")) return; throw e; }
        int ordinal = 0;
        for (Object raw : Protocol.list(response.get("columns"))) {
            Values.Column type = new Values.Column(Protocol.map(raw)); ordinal++;
            if (!like(pattern, type.name)) continue;
            rows.add(row(null, schema, name, type.name, type.type, type.typeName, type.precision, null, type.scale, 10,
                DatabaseMetaData.columnNullableUnknown, "", null, null, null, type.type == Types.CHAR || type.type == Types.VARCHAR ? type.precision * 4 : null,
                ordinal, "", null, null, null, null, "NO", "NO"));
        }
    }
    /** 테이블의 기본 키 컬럼 목록을 돌려준다.
     *
     * @param a {@code getPrimaryKeys} 호출 인자(카탈로그, 스키마, 테이블)
     * @return 기본 키 목록 결과 집합
     * @throws Exception 딕셔너리 조회에 실패한 경우 */
    private ResultSet primaryKeys(Object[] a) throws Exception {
        List<List<Object>> rows = new ArrayList<List<Object>>(); List<Map<String, Object>> cols = dictionary("SYS_CONSTRAINT_COLUMNS");
        if (catalog(a[0])) for (Map<String, Object> k : dictionary("SYS_CONSTRAINTS")) if ("PRIMARY KEY".equals(k.get("CONSTRAINT_TYPE")) && exact(a[1], k.get("TABLESPACE_NAME")) && exact(a[2], k.get("TABLE_NAME")))
            for (Map<String, Object> col : cols) if (same(k, col, "CONSTRAINT_NAME")) rows.add(row(null, k.get("TABLESPACE_NAME"), k.get("TABLE_NAME"), col.get("COLUMN_NAME"), col.get("ORDINAL_POSITION"), k.get("CONSTRAINT_NAME")));
        sort(rows, new int[] { 3 }, -1);
        return table(new String[] { "TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "COLUMN_NAME", "KEY_SEQ", "PK_NAME" }, new String[] { "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "SMALLINT", "VARCHAR" }, rows);
    }
    /** 두 딕셔너리 행이 같은 테이블스페이스의 같은 제약조건인지 확인한다.
     *
     * @param a 비교할 첫 번째 행
     * @param b 비교할 두 번째 행
     * @param key 제약조건 이름 키
     * @return 같은 제약조건이면 {@code true} */
    private static boolean same(Map<String, Object> a, Map<String, Object> b, String key) { return equal(a.get("TABLESPACE_NAME"), b.get("TABLESPACE_NAME")) && equal(a.get(key), b.get(key)); }
    /** 외래 키 목록을 돌려준다. 가져오기·내보내기·교차 참조 조회에 함께 쓴다.
     *
     * @param n 호출된 메서드 이름. 조회 방향을 정한다
     * @param a 외래 키 조회 호출 인자
     * @return 외래 키 목록 결과 집합
     * @throws Exception 딕셔너리 조회에 실패한 경우 */
    private ResultSet foreignKeys(String n, Object[] a) throws Exception {
        List<List<Object>> rows = new ArrayList<List<Object>>(); List<Map<String, Object>> keys = dictionary("SYS_CONSTRAINTS"), cols = dictionary("SYS_CONSTRAINT_COLUMNS");
        if (catalog(a[0]) && (a.length != 6 || catalog(a[3]))) for (Map<String, Object> k : keys) if ("FOREIGN KEY".equals(k.get("CONSTRAINT_TYPE"))) {
            boolean exported = n.equals("getExportedKeys") || n.equals("getCrossReference");
            if (!exact(a[1], k.get("TABLESPACE_NAME")) || !exact(a[2], k.get(exported ? "REFERENCED_TABLE" : "TABLE_NAME"))) continue;
            if (a.length == 6 && (!exact(a[4], k.get("TABLESPACE_NAME")) || !exact(a[5], k.get("TABLE_NAME")))) continue;
            Object pk = null; for (Map<String, Object> parent : keys) if ("PRIMARY KEY".equals(parent.get("CONSTRAINT_TYPE")) && equal(parent.get("TABLESPACE_NAME"), k.get("TABLESPACE_NAME")) && equal(parent.get("TABLE_NAME"), k.get("REFERENCED_TABLE"))) pk = parent.get("CONSTRAINT_NAME");
            for (Map<String, Object> col : cols) if (same(k, col, "CONSTRAINT_NAME")) rows.add(row(null, k.get("TABLESPACE_NAME"), k.get("REFERENCED_TABLE"), col.get("REFERENCED_COLUMN"), null, k.get("TABLESPACE_NAME"), k.get("TABLE_NAME"), col.get("COLUMN_NAME"), col.get("ORDINAL_POSITION"), rule(k.get("UPDATE_RULE")), rule(k.get("DELETE_RULE")), k.get("CONSTRAINT_NAME"), pk, DatabaseMetaData.importedKeyNotDeferrable));
        }
        sort(rows, new int[] { n.equals("getImportedKeys") ? 2 : 6, 11 }, 8);
        return table(new String[] { "PKTABLE_CAT", "PKTABLE_SCHEM", "PKTABLE_NAME", "PKCOLUMN_NAME", "FKTABLE_CAT", "FKTABLE_SCHEM", "FKTABLE_NAME", "FKCOLUMN_NAME", "KEY_SEQ", "UPDATE_RULE", "DELETE_RULE", "FK_NAME", "PK_NAME", "DEFERRABILITY" }, new String[] { "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "SMALLINT", "SMALLINT", "SMALLINT", "VARCHAR", "VARCHAR", "SMALLINT" }, rows);
    }
    /** 서버의 참조 동작 문자열을 JDBC 외래 키 규칙 코드로 바꾼다.
     *
     * @param r 서버 참조 동작(예: {@code CASCADE}, {@code SET NULL})
     * @return 대응하는 {@link java.sql.DatabaseMetaData} 외래 키 규칙 코드 */
    private static int rule(Object r) { if ("CASCADE".equals(r)) return DatabaseMetaData.importedKeyCascade; if ("SET NULL".equals(r)) return DatabaseMetaData.importedKeySetNull; if ("RESTRICT".equals(r)) return DatabaseMetaData.importedKeyRestrict; return DatabaseMetaData.importedKeyNoAction; }
    /** 테이블의 인덱스 목록을 돌려준다.
     *
     * @param a {@code getIndexInfo} 호출 인자(카탈로그, 스키마, 테이블, 유일 여부, 정확도)
     * @return 인덱스 목록 결과 집합
     * @throws Exception 딕셔너리 조회에 실패한 경우 */
    private ResultSet indexes(Object[] a) throws Exception {
        List<List<Object>> rows = new ArrayList<List<Object>>(); List<Map<String, Object>> cols = dictionary("SYS_INDEX_COLUMNS");
        if (catalog(a[0])) for (Map<String, Object> i : dictionary("SYS_INDEXES")) if (exact(a[1], i.get("TABLESPACE_NAME")) && exact(a[2], i.get("TABLE_NAME")) && (!(Boolean) a[3] || "YES".equals(i.get("IS_UNIQUE"))))
            for (Map<String, Object> col : cols) if (same(i, col, "INDEX_NAME")) rows.add(row(null, i.get("TABLESPACE_NAME"), i.get("TABLE_NAME"), !"YES".equals(i.get("IS_UNIQUE")), null, i.get("INDEX_NAME"), DatabaseMetaData.tableIndexOther, col.get("ORDINAL_POSITION"), col.get("COLUMN_NAME"), "YES".equals(col.get("IS_DESCENDING")) ? "D" : "A", 0L, 0L, null));
        sort(rows, new int[] { 3, 5 }, 7);
        return table(new String[] { "TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "NON_UNIQUE", "INDEX_QUALIFIER", "INDEX_NAME", "TYPE", "ORDINAL_POSITION", "COLUMN_NAME", "ASC_OR_DESC", "CARDINALITY", "PAGES", "FILTER_CONDITION" }, new String[] { "VARCHAR", "VARCHAR", "VARCHAR", "BOOLEAN", "VARCHAR", "VARCHAR", "SMALLINT", "SMALLINT", "VARCHAR", "CHAR", "BIGINT", "BIGINT", "VARCHAR" }, rows);
    }
    /** 테이블의 권한 목록을 돌려준다.
     *
     * @param a {@code getTablePrivileges} 호출 인자(카탈로그, 스키마 패턴, 테이블 패턴)
     * @return 권한 목록 결과 집합
     * @throws Exception 딕셔너리 조회에 실패한 경우 */
    private ResultSet privileges(Object[] a) throws Exception {
        List<List<Object>> rows = new ArrayList<List<Object>>();
        if (catalog(a[0])) for (Map<String, Object> p : dictionary("SYS_PRIVILEGES")) if (p.get("OBJECT_NAME") != null && like(a[1], p.get("TABLESPACE_NAME")) && like(a[2], p.get("OBJECT_NAME"))) rows.add(row(null, p.get("TABLESPACE_NAME"), p.get("OBJECT_NAME"), null, p.get("GRANTEE"), p.get("PRIVILEGE"), "NO"));
        return table(new String[] { "TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "GRANTOR", "GRANTEE", "PRIVILEGE", "IS_GRANTABLE" }, Collections.nCopies(7, "VARCHAR").toArray(new String[0]), rows);
    }
    /** 서버가 지원하는 데이터 타입 목록을 돌려준다.
     *
     * <p>문자, 이진, 정수, 고정소수, 부동소수, 논리, 날짜시간, 기간 타입과
     * 정밀도·리터럴·검색 가능 여부 같은 속성을 함께 제공한다.</p>
     *
     * @return 타입 정보 결과 집합 */
    private ResultSet typeInfo() {
        List<List<Object>> rows = new ArrayList<List<Object>>();
        for (String name : Arrays.asList("CHAR", "VARCHAR", "BINARY", "VARBINARY", "SMALLINT", "INTEGER", "BIGINT", "DECIMAL", "REAL", "DOUBLE PRECISION", "BOOLEAN", "DATE", "TIME", "TIME WITH TIME ZONE", "TIMESTAMP", "TIMESTAMP WITH TIME ZONE", "INTERVAL")) {
            int type = Values.sqlType(name); boolean text = type == Types.CHAR || type == Types.VARCHAR;
            int precision = text || type == Types.BINARY || type == Types.VARBINARY ? (name.equals("CHAR") || name.equals("BINARY") ? 2000 : 65535) : type == Types.DECIMAL ? 38 : new Values.Column("", name).precision;
            rows.add(row(name, type, precision, "'", "'", text || type == Types.BINARY || type == Types.VARBINARY ? "length" : type == Types.DECIMAL ? "precision,scale" : null, DatabaseMetaData.typeNullable, text, DatabaseMetaData.typeSearchable, false, type == Types.DECIMAL, false, null, 0, type == Types.DECIMAL ? 38 : name.startsWith("TIME") ? 6 : 0, null, null, 10));
        }
        sort(rows, new int[0], 1);
        return table(new String[] { "TYPE_NAME", "DATA_TYPE", "PRECISION", "LITERAL_PREFIX", "LITERAL_SUFFIX", "CREATE_PARAMS", "NULLABLE", "CASE_SENSITIVE", "SEARCHABLE", "UNSIGNED_ATTRIBUTE", "FIXED_PREC_SCALE", "AUTO_INCREMENT", "LOCAL_TYPE_NAME", "MINIMUM_SCALE", "MAXIMUM_SCALE", "SQL_DATA_TYPE", "SQL_DATETIME_SUB", "NUM_PREC_RADIX" }, new String[] { "VARCHAR", "INTEGER", "INTEGER", "VARCHAR", "VARCHAR", "VARCHAR", "SMALLINT", "BOOLEAN", "SMALLINT", "BOOLEAN", "BOOLEAN", "BOOLEAN", "VARCHAR", "SMALLINT", "SMALLINT", "INTEGER", "INTEGER", "INTEGER" }, rows);
    }
}
