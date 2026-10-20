package org.duckdns.hjow.helloworlddb.jdbc8;

import java.lang.reflect.Method;
import java.sql.*;
import java.util.*;
import java.util.regex.Pattern;
import org.duckdns.hjow.helloworlddb.jdbc8.protocol.Protocol;

/** SYSTEM 딕셔너리의 가시성 규칙을 그대로 사용하는 JDBC 메타데이터. */
final class JdbcDatabaseMetaData extends JdbcProxy {
    private static final List<String> SYSTEM_OBJECTS = Arrays.asList("DUAL", "SYS_TABLESPACES", "SYS_USERS", "SYS_TABLES", "SYS_COLUMNS", "SYS_VIEWS", "SYS_INDEXES", "SYS_INDEX_COLUMNS", "SYS_CONSTRAINTS", "SYS_CONSTRAINT_COLUMNS", "SYS_PRIVILEGES", "SYS_GROUP_GRANTS", "SYS_SESSIONS");
    private final JdbcConnection c;
    private JdbcDatabaseMetaData(JdbcConnection c) { this.c = c; }
    static DatabaseMetaData open(JdbcConnection c) { return new JdbcDatabaseMetaData(c).create(DatabaseMetaData.class); }
    @Override Object call(String n, Object[] a, Method m) throws Exception {
        c.check();
        switch (n) {
        case "getConnection": return c.proxy;
        case "getJDBCMajorVersion": return 4; case "getJDBCMinorVersion": return 2;
        case "getDriverName": return "HelloWorldDB JDBC 4.2 Driver"; case "getDriverVersion": return "0.1.0";
        case "getDriverMajorVersion": case "getDatabaseMajorVersion": return 0;
        case "getDriverMinorVersion": case "getDatabaseMinorVersion": return 1;
        case "getDatabaseProductName": return "HelloWorldDB"; case "getDatabaseProductVersion": return "0.1.0";
        case "getURL": return c.options.url.replaceAll("(?i)([?&]password=)[^&]*", "$1");
        case "getUserName": return c.protocol.session().get("user");
        case "getIdentifierQuoteString": return "\"";
        case "getSearchStringEscape": return "\\";
        case "getSchemaTerm": return "tablespace"; case "getCatalogTerm": return ""; case "getProcedureTerm": return "procedure";
        case "getCatalogSeparator": return ".";
        case "getSQLKeywords": return "USE,NVL,TO_CHAR,TO_DATE,LIMIT,TABLESPACE,OFFICER,CONNECT,DBA";
        case "getNumericFunctions": return "ABS,MOD,CEIL,FLOOR,POWER,SQRT,ROUND";
        case "getStringFunctions": return "UPPER,LOWER,TRIM,SUBSTRING,POSITION,CHAR_LENGTH,OCTET_LENGTH,LENGTH,SUBSTR,REPLACE,LTRIM,RTRIM,CONCAT";
        case "getSystemFunctions": return "COALESCE,NULLIF,CURRENT_USER,NVL";
        case "getTimeDateFunctions": return "CURRENT_DATE,CURRENT_TIME,CURRENT_TIMESTAMP,LOCALTIME,LOCALTIMESTAMP,EXTRACT,TO_DATE,TO_CHAR";
        case "getExtraNameCharacters": return "_$";
        case "getDefaultTransactionIsolation": return Connection.TRANSACTION_READ_COMMITTED;
        case "getResultSetHoldability": return ResultSet.HOLD_CURSORS_OVER_COMMIT;
        case "getSQLStateType": return DatabaseMetaData.sqlStateSQL;
        case "getRowIdLifetime": return RowIdLifetime.ROWID_UNSUPPORTED;
        case "getMaxColumnNameLength": case "getMaxSchemaNameLength": case "getMaxTableNameLength": case "getMaxUserNameLength": return 128;
        case "getMaxColumnsInTable": return 1000; case "getMaxColumnsInIndex": return 16;
        case "getMaxConnections": return 0; case "getMaxStatements": return 0;
        case "getMaxCharLiteralLength": case "getMaxBinaryLiteralLength": case "getMaxStatementLength": return 16777216;
        case "getMaxIndexLength": case "getMaxRowSize": case "getMaxColumnsInSelect": case "getMaxColumnsInGroupBy": case "getMaxColumnsInOrderBy": case "getMaxTablesInSelect": case "getMaxCatalogNameLength": case "getMaxProcedureNameLength": case "getMaxCursorNameLength": return 0;
        case "isReadOnly": case "allProceduresAreCallable": case "usesLocalFiles": case "usesLocalFilePerTable": case "isCatalogAtStart": return false;
        case "allTablesAreSelectable": return false;
        case "nullsAreSortedHigh": case "storesUpperCaseIdentifiers": case "storesMixedCaseQuotedIdentifiers": case "supportsMixedCaseQuotedIdentifiers": return true;
        case "nullsAreSortedLow": case "nullsAreSortedAtStart": case "nullsAreSortedAtEnd": case "storesLowerCaseIdentifiers": case "storesMixedCaseIdentifiers": case "supportsMixedCaseIdentifiers": case "storesUpperCaseQuotedIdentifiers": case "storesLowerCaseQuotedIdentifiers": return false;
        case "supportsTransactionIsolationLevel": return (Integer) a[0] == Connection.TRANSACTION_READ_COMMITTED;
        case "supportsResultSetType": return (Integer) a[0] == ResultSet.TYPE_FORWARD_ONLY;
        case "supportsResultSetConcurrency": return (Integer) a[0] == ResultSet.TYPE_FORWARD_ONLY && (Integer) a[1] == ResultSet.CONCUR_READ_ONLY;
        case "supportsResultSetHoldability": return (Integer) a[0] == ResultSet.HOLD_CURSORS_OVER_COMMIT;
        case "supportsConvert": return false;
        case "getSchemas": return schemas(a);
        case "getCatalogs": return table(new String[] { "TABLE_CAT" }, new String[] { "VARCHAR(128)" }, Collections.emptyList());
        case "getTableTypes": return table(new String[] { "TABLE_TYPE" }, new String[] { "VARCHAR(32)" }, Arrays.asList(row("TABLE"), row("VIEW"), row("SYSTEM TABLE")));
        case "getTables": return tables(a);
        case "getColumns": return columns(a);
        case "getPrimaryKeys": return primaryKeys(a);
        case "getImportedKeys": case "getExportedKeys": case "getCrossReference": return foreignKeys(n, a);
        case "getIndexInfo": return indexes(a);
        case "getTypeInfo": return typeInfo();
        case "getTablePrivileges": return privileges(a);
        case "getProcedures": return table(new String[] { "PROCEDURE_CAT", "PROCEDURE_SCHEM", "PROCEDURE_NAME", "RESERVED1", "RESERVED2", "RESERVED3", "REMARKS", "PROCEDURE_TYPE", "SPECIFIC_NAME" }, new String[] { "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "SMALLINT", "VARCHAR" }, Collections.emptyList());
        case "getClientInfoProperties": return table(new String[] { "NAME", "MAX_LEN", "DEFAULT_VALUE", "DESCRIPTION" }, new String[] { "VARCHAR", "INTEGER", "VARCHAR", "VARCHAR" }, Collections.emptyList());
        case "getSuperTables": return table(new String[] { "TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "SUPERTABLE_NAME" }, new String[] { "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR" }, Collections.emptyList());
        default: break;
        }
        if (Arrays.asList("supportsTransactions", "supportsSavepoints", "supportsBatchUpdates", "supportsUnion", "supportsUnionAll", "supportsOuterJoins", "supportsFullOuterJoins", "supportsLimitedOuterJoins", "supportsCorrelatedSubqueries", "supportsSubqueriesInComparisons", "supportsSubqueriesInExists", "supportsSubqueriesInIns", "supportsSubqueriesInQuantifieds", "supportsGroupBy", "supportsGroupByUnrelated", "supportsExpressionsInOrderBy", "supportsOrderByUnrelated", "supportsColumnAliasing", "supportsTableCorrelationNames", "supportsDifferentTableCorrelationNames", "supportsNonNullableColumns", "supportsLikeEscapeClause", "supportsAlterTableWithAddColumn", "supportsAlterTableWithDropColumn", "supportsSchemasInDataManipulation", "supportsSchemasInTableDefinitions", "supportsSchemasInIndexDefinitions", "supportsSchemasInPrivilegeDefinitions", "dataDefinitionCausesTransactionCommit", "dataDefinitionIgnoredInTransactions", "supportsOpenCursorsAcrossCommit", "supportsOpenCursorsAcrossRollback", "supportsOpenStatementsAcrossCommit", "supportsOpenStatementsAcrossRollback", "supportsDataManipulationTransactionsOnly", "nullPlusNonNullIsNull").contains(n)) return !n.equals("dataDefinitionIgnoredInTransactions");
        if (m.getReturnType() == boolean.class) return false;
        throw unsupported(n);
    }
    private List<Map<String, Object>> dictionary(String name) throws Exception {
        Map<String, Object> response = c.protocol.execute("SELECT * FROM SYSTEM." + name, Collections.emptyList(), 500);
        List<Object> columns = Protocol.list(response.get("columns")); List<Map<String, Object>> result = new ArrayList<>(); long cursor = 0;
        try {
            for (;;) {
                cursor = Boolean.TRUE.equals(response.get("hasMore")) ? ((Number) response.get("cursor")).longValue() : 0;
                for (Object r : Protocol.list(response.get("rows"))) {
                    List<Object> values = Protocol.list(r); Map<String, Object> item = new HashMap<>();
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
        List<Values.Column> columns = new ArrayList<>(); for (int i = 0; i < names.length; i++) columns.add(new Values.Column(names[i], types[i])); return JdbcResultSet.memory(columns, rows);
    }
    private ResultSet schemas(Object[] a) throws Exception {
        List<List<Object>> rows = new ArrayList<>();
        if (a.length == 0 || catalog(a[0])) for (Map<String, Object> t : dictionary("SYS_TABLESPACES")) if (a.length == 0 || like(a[1], t.get("TABLESPACE_NAME"))) rows.add(row(t.get("TABLESPACE_NAME"), null));
        rows.sort(Comparator.comparing(r -> String.valueOf(r.get(0))));
        return table(new String[] { "TABLE_SCHEM", "TABLE_CATALOG" }, new String[] { "VARCHAR(128)", "VARCHAR(128)" }, rows);
    }
    private ResultSet tables(Object[] a) throws Exception {
        List<List<Object>> rows = new ArrayList<>(); List<?> types = a[3] == null ? null : Arrays.asList((String[]) a[3]);
        if (catalog(a[0])) for (String view : Arrays.asList("SYS_TABLES", "SYS_VIEWS")) for (Map<String, Object> t : dictionary(view)) {
            String type = view.equals("SYS_TABLES") ? "TABLE" : "VIEW"; Object name = t.get(view.equals("SYS_TABLES") ? "TABLE_NAME" : "VIEW_NAME");
            if (like(a[1], t.get("TABLESPACE_NAME")) && like(a[2], name) && (types == null || types.contains(type))) rows.add(row(null, t.get("TABLESPACE_NAME"), name, type, "", null, null, null, null, null));
        }
        if (catalog(a[0]) && like(a[1], "SYSTEM") && (types == null || types.contains("SYSTEM TABLE"))) for (String name : SYSTEM_OBJECTS) if (like(a[2], name)) rows.add(row(null, "SYSTEM", name, "SYSTEM TABLE", "", null, null, null, null, null));
        rows.sort(Comparator.comparing(r -> r.get(3) + "\u0000" + r.get(1) + "\u0000" + r.get(2)));
        return table(new String[] { "TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "TABLE_TYPE", "REMARKS", "TYPE_CAT", "TYPE_SCHEM", "TYPE_NAME", "SELF_REFERENCING_COL_NAME", "REF_GENERATION" }, Collections.nCopies(10, "VARCHAR(128)").toArray(new String[0]), rows);
    }
    private ResultSet columns(Object[] a) throws Exception {
        List<List<Object>> rows = new ArrayList<>();
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
        rows.sort(Comparator.comparing((List<Object> r) -> r.get(1) + "\u0000" + r.get(2)).thenComparingLong(r -> ((Number) r.get(16)).longValue()));
        return table(new String[] { "TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "COLUMN_NAME", "DATA_TYPE", "TYPE_NAME", "COLUMN_SIZE", "BUFFER_LENGTH", "DECIMAL_DIGITS", "NUM_PREC_RADIX", "NULLABLE", "REMARKS", "COLUMN_DEF", "SQL_DATA_TYPE", "SQL_DATETIME_SUB", "CHAR_OCTET_LENGTH", "ORDINAL_POSITION", "IS_NULLABLE", "SCOPE_CATALOG", "SCOPE_SCHEMA", "SCOPE_TABLE", "SOURCE_DATA_TYPE", "IS_AUTOINCREMENT", "IS_GENERATEDCOLUMN" },
            new String[] { "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "INTEGER", "VARCHAR", "INTEGER", "INTEGER", "INTEGER", "INTEGER", "INTEGER", "VARCHAR", "VARCHAR", "INTEGER", "INTEGER", "INTEGER", "INTEGER", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "SMALLINT", "VARCHAR", "VARCHAR" }, rows);
    }
    private void viewColumns(List<List<Object>> rows, String schema, String name, Object pattern) throws Exception {
        Map<String, Object> response;
        try { response = c.protocol.execute("SELECT * FROM " + quote(schema) + "." + quote(name) + " WHERE 1 = 0", Collections.emptyList(), 1); }
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
        List<List<Object>> rows = new ArrayList<>(); List<Map<String, Object>> cols = dictionary("SYS_CONSTRAINT_COLUMNS");
        if (catalog(a[0])) for (Map<String, Object> k : dictionary("SYS_CONSTRAINTS")) if ("PRIMARY KEY".equals(k.get("CONSTRAINT_TYPE")) && exact(a[1], k.get("TABLESPACE_NAME")) && exact(a[2], k.get("TABLE_NAME")))
            for (Map<String, Object> col : cols) if (same(k, col, "CONSTRAINT_NAME")) rows.add(row(null, k.get("TABLESPACE_NAME"), k.get("TABLE_NAME"), col.get("COLUMN_NAME"), col.get("ORDINAL_POSITION"), k.get("CONSTRAINT_NAME")));
        rows.sort(Comparator.comparing(r -> String.valueOf(r.get(3))));
        return table(new String[] { "TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "COLUMN_NAME", "KEY_SEQ", "PK_NAME" }, new String[] { "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "SMALLINT", "VARCHAR" }, rows);
    }
    private static boolean same(Map<String, Object> a, Map<String, Object> b, String key) { return Objects.equals(a.get("TABLESPACE_NAME"), b.get("TABLESPACE_NAME")) && Objects.equals(a.get(key), b.get(key)); }
    private ResultSet foreignKeys(String n, Object[] a) throws Exception {
        List<List<Object>> rows = new ArrayList<>(); List<Map<String, Object>> keys = dictionary("SYS_CONSTRAINTS"), cols = dictionary("SYS_CONSTRAINT_COLUMNS");
        if (catalog(a[0]) && (a.length != 6 || catalog(a[3]))) for (Map<String, Object> k : keys) if ("FOREIGN KEY".equals(k.get("CONSTRAINT_TYPE"))) {
            boolean exported = n.equals("getExportedKeys") || n.equals("getCrossReference");
            if (!exact(a[1], k.get("TABLESPACE_NAME")) || !exact(a[2], k.get(exported ? "REFERENCED_TABLE" : "TABLE_NAME"))) continue;
            if (a.length == 6 && (!exact(a[4], k.get("TABLESPACE_NAME")) || !exact(a[5], k.get("TABLE_NAME")))) continue;
            Object pk = null; for (Map<String, Object> parent : keys) if ("PRIMARY KEY".equals(parent.get("CONSTRAINT_TYPE")) && Objects.equals(parent.get("TABLESPACE_NAME"), k.get("TABLESPACE_NAME")) && Objects.equals(parent.get("TABLE_NAME"), k.get("REFERENCED_TABLE"))) pk = parent.get("CONSTRAINT_NAME");
            for (Map<String, Object> col : cols) if (same(k, col, "CONSTRAINT_NAME")) rows.add(row(null, k.get("TABLESPACE_NAME"), k.get("REFERENCED_TABLE"), col.get("REFERENCED_COLUMN"), null, k.get("TABLESPACE_NAME"), k.get("TABLE_NAME"), col.get("COLUMN_NAME"), col.get("ORDINAL_POSITION"), rule(k.get("UPDATE_RULE")), rule(k.get("DELETE_RULE")), k.get("CONSTRAINT_NAME"), pk, DatabaseMetaData.importedKeyNotDeferrable));
        }
        rows.sort(Comparator.comparing((List<Object> r) -> r.get(n.equals("getImportedKeys") ? 2 : 6) + "\u0000" + r.get(11)).thenComparingLong(r -> ((Number) r.get(8)).longValue()));
        return table(new String[] { "PKTABLE_CAT", "PKTABLE_SCHEM", "PKTABLE_NAME", "PKCOLUMN_NAME", "FKTABLE_CAT", "FKTABLE_SCHEM", "FKTABLE_NAME", "FKCOLUMN_NAME", "KEY_SEQ", "UPDATE_RULE", "DELETE_RULE", "FK_NAME", "PK_NAME", "DEFERRABILITY" }, new String[] { "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "SMALLINT", "SMALLINT", "SMALLINT", "VARCHAR", "VARCHAR", "SMALLINT" }, rows);
    }
    private static int rule(Object r) { if ("CASCADE".equals(r)) return DatabaseMetaData.importedKeyCascade; if ("SET NULL".equals(r)) return DatabaseMetaData.importedKeySetNull; if ("RESTRICT".equals(r)) return DatabaseMetaData.importedKeyRestrict; return DatabaseMetaData.importedKeyNoAction; }
    private ResultSet indexes(Object[] a) throws Exception {
        List<List<Object>> rows = new ArrayList<>(); List<Map<String, Object>> cols = dictionary("SYS_INDEX_COLUMNS");
        if (catalog(a[0])) for (Map<String, Object> i : dictionary("SYS_INDEXES")) if (exact(a[1], i.get("TABLESPACE_NAME")) && exact(a[2], i.get("TABLE_NAME")) && (!(Boolean) a[3] || "YES".equals(i.get("IS_UNIQUE"))))
            for (Map<String, Object> col : cols) if (same(i, col, "INDEX_NAME")) rows.add(row(null, i.get("TABLESPACE_NAME"), i.get("TABLE_NAME"), !"YES".equals(i.get("IS_UNIQUE")), null, i.get("INDEX_NAME"), DatabaseMetaData.tableIndexOther, col.get("ORDINAL_POSITION"), col.get("COLUMN_NAME"), "YES".equals(col.get("IS_DESCENDING")) ? "D" : "A", 0L, 0L, null));
        rows.sort(Comparator.comparing((List<Object> r) -> r.get(3) + "\u0000" + r.get(5)).thenComparingLong(r -> ((Number) r.get(7)).longValue()));
        return table(new String[] { "TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "NON_UNIQUE", "INDEX_QUALIFIER", "INDEX_NAME", "TYPE", "ORDINAL_POSITION", "COLUMN_NAME", "ASC_OR_DESC", "CARDINALITY", "PAGES", "FILTER_CONDITION" }, new String[] { "VARCHAR", "VARCHAR", "VARCHAR", "BOOLEAN", "VARCHAR", "VARCHAR", "SMALLINT", "SMALLINT", "VARCHAR", "CHAR", "BIGINT", "BIGINT", "VARCHAR" }, rows);
    }
    private ResultSet privileges(Object[] a) throws Exception {
        List<List<Object>> rows = new ArrayList<>();
        if (catalog(a[0])) for (Map<String, Object> p : dictionary("SYS_PRIVILEGES")) if (p.get("OBJECT_NAME") != null && like(a[1], p.get("TABLESPACE_NAME")) && like(a[2], p.get("OBJECT_NAME"))) rows.add(row(null, p.get("TABLESPACE_NAME"), p.get("OBJECT_NAME"), null, p.get("GRANTEE"), p.get("PRIVILEGE"), "NO"));
        return table(new String[] { "TABLE_CAT", "TABLE_SCHEM", "TABLE_NAME", "GRANTOR", "GRANTEE", "PRIVILEGE", "IS_GRANTABLE" }, Collections.nCopies(7, "VARCHAR").toArray(new String[0]), rows);
    }
    private ResultSet typeInfo() {
        List<List<Object>> rows = new ArrayList<>();
        for (String name : Arrays.asList("CHAR", "VARCHAR", "BINARY", "VARBINARY", "SMALLINT", "INTEGER", "BIGINT", "DECIMAL", "REAL", "DOUBLE PRECISION", "BOOLEAN", "DATE", "TIME", "TIME WITH TIME ZONE", "TIMESTAMP", "TIMESTAMP WITH TIME ZONE", "INTERVAL")) {
            int type = Values.sqlType(name); boolean text = type == Types.CHAR || type == Types.VARCHAR;
            int precision = text || type == Types.BINARY || type == Types.VARBINARY ? (name.equals("CHAR") || name.equals("BINARY") ? 2000 : 65535) : type == Types.DECIMAL ? 38 : new Values.Column("", name).precision;
            rows.add(row(name, type, precision, "'", "'", text || type == Types.BINARY || type == Types.VARBINARY ? "length" : type == Types.DECIMAL ? "precision,scale" : null, DatabaseMetaData.typeNullable, text, DatabaseMetaData.typeSearchable, false, type == Types.DECIMAL, false, null, 0, type == Types.DECIMAL ? 38 : name.startsWith("TIME") ? 6 : 0, null, null, 10));
        }
        rows.sort(Comparator.comparingInt(r -> (Integer) r.get(1)));
        return table(new String[] { "TYPE_NAME", "DATA_TYPE", "PRECISION", "LITERAL_PREFIX", "LITERAL_SUFFIX", "CREATE_PARAMS", "NULLABLE", "CASE_SENSITIVE", "SEARCHABLE", "UNSIGNED_ATTRIBUTE", "FIXED_PREC_SCALE", "AUTO_INCREMENT", "LOCAL_TYPE_NAME", "MINIMUM_SCALE", "MAXIMUM_SCALE", "SQL_DATA_TYPE", "SQL_DATETIME_SUB", "NUM_PREC_RADIX" }, new String[] { "VARCHAR", "INTEGER", "INTEGER", "VARCHAR", "VARCHAR", "VARCHAR", "SMALLINT", "BOOLEAN", "SMALLINT", "BOOLEAN", "BOOLEAN", "BOOLEAN", "VARCHAR", "SMALLINT", "SMALLINT", "INTEGER", "INTEGER", "INTEGER" }, rows);
    }
}
