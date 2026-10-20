package org.duckdns.hjow.helloworlddb.jdbc6;

import java.lang.reflect.Method;
import java.sql.*;
import java.util.*;
import java.util.regex.Pattern;
import org.duckdns.hjow.helloworlddb.jdbc6.protocol.Protocol;

/** SYSTEM 딕셔너리의 가시성 규칙을 그대로 사용하는 JDBC 메타데이터. */
final class JdbcDatabaseMetaData extends JdbcProxy {
    private static final List<String> SYSTEM_OBJECTS = Arrays.asList("DUAL", "SYS_TABLESPACES", "SYS_USERS", "SYS_TABLES", "SYS_COLUMNS", "SYS_VIEWS", "SYS_INDEXES", "SYS_INDEX_COLUMNS", "SYS_CONSTRAINTS", "SYS_CONSTRAINT_COLUMNS", "SYS_PRIVILEGES", "SYS_GROUP_GRANTS", "SYS_SESSIONS");
    private static boolean equal(Object a, Object b) { return a == null ? b == null : a.equals(b); }
    private static void sort(List<List<Object>> rows, final int[] fields, final int numeric) {
        Collections.sort(rows, new Comparator<List<Object>>() { public int compare(List<Object> a, List<Object> b) {
            for (int field : fields) { int d = String.valueOf(a.get(field)).compareTo(String.valueOf(b.get(field))); if (d != 0) return d; }
            if (numeric < 0) return 0; long x = ((Number) a.get(numeric)).longValue(), y = ((Number) b.get(numeric)).longValue(); return x < y ? -1 : x == y ? 0 : 1;
        } });
    }
    private final JdbcConnection c;
    private JdbcDatabaseMetaData(JdbcConnection c) { this.c = c; }
    static DatabaseMetaData open(JdbcConnection c) { return new JdbcDatabaseMetaData(c).create(DatabaseMetaData.class); }
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
    private static boolean catalog(Object value) { return value == null || value.equals(""); }
    private static boolean exact(Object expected, Object value) { return expected == null || expected.equals(value); }
    private static boolean like(Object pattern, Object value) {
        if (pattern == null) return true; if (value == null) return false;
        String s = pattern.toString(); StringBuilder regex = new StringBuilder("(?s)");
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i); if (ch == '\\' && i + 1 < s.length()) regex.append(Pattern.quote(String.valueOf(s.charAt(++i))));
            else if (ch == '%') regex.append(".*"); else if (ch == '_') regex.append('.'); else regex.append(Pattern.quote(String.valueOf(ch)));
        }
        return value.toString().matches(regex.toString());
    }
    static List<Object> row(Object... values) { return Arrays.asList(values); }
    private static ResultSet table(String[] names, String[] types, List<List<Object>> rows) {
        List<Values.Column> columns = new ArrayList<Values.Column>(); for (int i = 0; i < names.length; i++) columns.add(new Values.Column(names[i], types[i])); return JdbcResultSet.memory(columns, rows);
    }
    private ResultSet schemas(Object[] a) throws Exception {
        List<List<Object>> rows = new ArrayList<List<Object>>();
        if (a.length == 0 || catalog(a[0])) for (Map<String, Object> t : dictionary("SYS_TABLESPACES")) if (a.length == 0 || like(a[1], t.get("TABLESPACE_NAME"))) rows.add(row(t.get("TABLESPACE_NAME"), null));
        sort(rows, new int[] { 0 }, -1);
        return table(new String[] { "TABLE_SCHEM", "TABLE_CATALOG" }, new String[] { "VARCHAR(128)", "VARCHAR(128)" }, rows);
    }
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
    private ResultSet primaryKeys(Object[] a) throws Exception {
        List<List<Object>> rows = new ArrayList<List<Object>>(); List<Map<String, Object>> cols = dictionary("SYS_CONSTRAINT_COLUMNS");
        if (catalog(a[0])) for (Map<String, Object> k : dictionary("SYS_CONSTRAINTS")) if ("PRIMARY KEY".equals(k.get("CONSTRAINT_TYPE")) && exact(a[1], k.get("TABLESPACE_NAME")) && exact(a[2], k.get("TABLE_NAME")))
            for (Map<String, Object> col : cols) if (same(k, col, "CONSTRAINT_NAME")) rows.add(row(null, k.get("TABLESPACE_NAME"), k.get("TABLE_NAME"), col.get("COLUMN_NAME"), col.get("ORDINAL_POSITION"), k.get("CONSTRAINT_NAME")));
        sort(rows, new int[] { 3 }, -1);
        return table(new String[] { "TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "COLUMN_NAME", "KEY_SEQ", "PK_NAME" }, new String[] { "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "SMALLINT", "VARCHAR" }, rows);
    }
    private static boolean same(Map<String, Object> a, Map<String, Object> b, String key) { return equal(a.get("TABLESPACE_NAME"), b.get("TABLESPACE_NAME")) && equal(a.get(key), b.get(key)); }
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
    private static int rule(Object r) { if ("CASCADE".equals(r)) return DatabaseMetaData.importedKeyCascade; if ("SET NULL".equals(r)) return DatabaseMetaData.importedKeySetNull; if ("RESTRICT".equals(r)) return DatabaseMetaData.importedKeyRestrict; return DatabaseMetaData.importedKeyNoAction; }
    private ResultSet indexes(Object[] a) throws Exception {
        List<List<Object>> rows = new ArrayList<List<Object>>(); List<Map<String, Object>> cols = dictionary("SYS_INDEX_COLUMNS");
        if (catalog(a[0])) for (Map<String, Object> i : dictionary("SYS_INDEXES")) if (exact(a[1], i.get("TABLESPACE_NAME")) && exact(a[2], i.get("TABLE_NAME")) && (!(Boolean) a[3] || "YES".equals(i.get("IS_UNIQUE"))))
            for (Map<String, Object> col : cols) if (same(i, col, "INDEX_NAME")) rows.add(row(null, i.get("TABLESPACE_NAME"), i.get("TABLE_NAME"), !"YES".equals(i.get("IS_UNIQUE")), null, i.get("INDEX_NAME"), DatabaseMetaData.tableIndexOther, col.get("ORDINAL_POSITION"), col.get("COLUMN_NAME"), "YES".equals(col.get("IS_DESCENDING")) ? "D" : "A", 0L, 0L, null));
        sort(rows, new int[] { 3, 5 }, 7);
        return table(new String[] { "TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "NON_UNIQUE", "INDEX_QUALIFIER", "INDEX_NAME", "TYPE", "ORDINAL_POSITION", "COLUMN_NAME", "ASC_OR_DESC", "CARDINALITY", "PAGES", "FILTER_CONDITION" }, new String[] { "VARCHAR", "VARCHAR", "VARCHAR", "BOOLEAN", "VARCHAR", "VARCHAR", "SMALLINT", "SMALLINT", "VARCHAR", "CHAR", "BIGINT", "BIGINT", "VARCHAR" }, rows);
    }
    private ResultSet privileges(Object[] a) throws Exception {
        List<List<Object>> rows = new ArrayList<List<Object>>();
        if (catalog(a[0])) for (Map<String, Object> p : dictionary("SYS_PRIVILEGES")) if (p.get("OBJECT_NAME") != null && like(a[1], p.get("TABLESPACE_NAME")) && like(a[2], p.get("OBJECT_NAME"))) rows.add(row(null, p.get("TABLESPACE_NAME"), p.get("OBJECT_NAME"), null, p.get("GRANTEE"), p.get("PRIVILEGE"), "NO"));
        return table(new String[] { "TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "GRANTOR", "GRANTEE", "PRIVILEGE", "IS_GRANTABLE" }, Collections.nCopies(7, "VARCHAR").toArray(new String[0]), rows);
    }
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
