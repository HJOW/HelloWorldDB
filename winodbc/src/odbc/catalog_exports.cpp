#include "hwdbodbc/catalog.hpp"
#include "hwdbodbc/statement.hpp"

using namespace hwdbodbc;
namespace {
template<class Character>
std::optional<std::string> read_opt(Character* pointer, SQLSMALLINT length) {
    if (!pointer) return std::nullopt;
    if (length < 0 && length != SQL_NTS) throw DriverError("HY090", "Invalid string length.");
    return input_text(pointer, length);
}
template<class Character>
SQLRETURN tables(SQLHSTMT handle, Character* catalog, SQLSMALLINT catalog_len,
    Character* schema, SQLSMALLINT schema_len, Character* table, SQLSMALLINT table_len,
    Character* type, SQLSMALLINT type_len) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        static_cast<void>(statement_connection(statement));
        if (statement.parameter_execution) throw DriverError("HY010", "Complete or cancel parameter data first.");
        catalog_tables_impl(statement, read_opt(catalog, catalog_len), read_opt(schema, schema_len),
            read_opt(table, table_len), read_opt(type, type_len));
        return SQL_SUCCESS;
    });
}
template<class Character>
SQLRETURN columns(SQLHSTMT handle, Character* catalog, SQLSMALLINT catalog_len,
    Character* schema, SQLSMALLINT schema_len, Character* table, SQLSMALLINT table_len,
    Character* column, SQLSMALLINT column_len) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        static_cast<void>(statement_connection(statement));
        if (statement.parameter_execution) throw DriverError("HY010", "Complete or cancel parameter data first.");
        catalog_columns_impl(statement, read_opt(catalog, catalog_len), read_opt(schema, schema_len),
            read_opt(table, table_len), read_opt(column, column_len));
        return SQL_SUCCESS;
    });
}
template<class Character>
SQLRETURN statistics(SQLHSTMT handle, Character* catalog, SQLSMALLINT catalog_len,
    Character* schema, SQLSMALLINT schema_len, Character* table, SQLSMALLINT table_len,
    SQLUSMALLINT unique, SQLUSMALLINT reserved) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        static_cast<void>(statement_connection(statement));
        if (statement.parameter_execution) throw DriverError("HY010", "Complete or cancel parameter data first.");
        catalog_statistics_impl(statement, read_opt(catalog, catalog_len), read_opt(schema, schema_len),
            read_opt(table, table_len), unique, reserved);
        return SQL_SUCCESS;
    });
}
template<class Character>
SQLRETURN special_columns(SQLHSTMT handle, SQLUSMALLINT identifier,
    Character* catalog, SQLSMALLINT catalog_len, Character* schema, SQLSMALLINT schema_len,
    Character* table, SQLSMALLINT table_len, SQLUSMALLINT scope, SQLUSMALLINT nullable) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        static_cast<void>(statement_connection(statement));
        if (statement.parameter_execution) throw DriverError("HY010", "Complete or cancel parameter data first.");
        catalog_special_columns_impl(statement, identifier, read_opt(catalog, catalog_len),
            read_opt(schema, schema_len), read_opt(table, table_len), scope, nullable);
        return SQL_SUCCESS;
    });
}
template<class Character>
SQLRETURN primary_keys(SQLHSTMT handle, Character* catalog, SQLSMALLINT catalog_len,
    Character* schema, SQLSMALLINT schema_len, Character* table, SQLSMALLINT table_len) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        static_cast<void>(statement_connection(statement));
        if (statement.parameter_execution) throw DriverError("HY010", "Complete or cancel parameter data first.");
        // 테이블 이름은 필수이다. 비어 있으면 빈 결과를 낸다.
        auto table_opt = read_opt(table, table_len);
        if (!table_opt || table_opt->empty()) {
            std::vector<SqlType> cols{
                make_catalog_varchar("TABLE_CAT", 128, SQL_NULLABLE),
                make_catalog_varchar("TABLE_SCHEM", 128, SQL_NULLABLE),
                make_catalog_varchar("TABLE_NAME", 128, SQL_NO_NULLS),
                make_catalog_varchar("COLUMN_NAME", 128, SQL_NO_NULLS),
                make_catalog_smallint("KEY_SEQ", SQL_NO_NULLS),
                make_catalog_varchar("PK_NAME", 128, SQL_NULLABLE)};
            catalog_empty_impl(statement, std::move(cols));
            return SQL_SUCCESS;
        }
        catalog_primary_keys_impl(statement, read_opt(catalog, catalog_len), read_opt(schema, schema_len), table_opt);
        return SQL_SUCCESS;
    });
}
template<class Character>
SQLRETURN foreign_keys(SQLHSTMT handle,
    Character* pk_catalog, SQLSMALLINT pk_catalog_len, Character* pk_schema, SQLSMALLINT pk_schema_len, Character* pk_table, SQLSMALLINT pk_table_len,
    Character* fk_catalog, SQLSMALLINT fk_catalog_len, Character* fk_schema, SQLSMALLINT fk_schema_len, Character* fk_table, SQLSMALLINT fk_table_len) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        static_cast<void>(statement_connection(statement));
        if (statement.parameter_execution) throw DriverError("HY010", "Complete or cancel parameter data first.");
        catalog_foreign_keys_impl(statement,
            read_opt(pk_catalog, pk_catalog_len), read_opt(pk_schema, pk_schema_len), read_opt(pk_table, pk_table_len),
            read_opt(fk_catalog, fk_catalog_len), read_opt(fk_schema, fk_schema_len), read_opt(fk_table, fk_table_len));
        return SQL_SUCCESS;
    });
}
template<class Character>
SQLRETURN table_privileges(SQLHSTMT handle, Character* catalog, SQLSMALLINT catalog_len,
    Character* schema, SQLSMALLINT schema_len, Character* table, SQLSMALLINT table_len) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        static_cast<void>(statement_connection(statement));
        if (statement.parameter_execution) throw DriverError("HY010", "Complete or cancel parameter data first.");
        catalog_table_privileges_impl(statement, read_opt(catalog, catalog_len), read_opt(schema, schema_len), read_opt(table, table_len));
        return SQL_SUCCESS;
    });
}
template<class Character>
SQLRETURN column_privileges(SQLHSTMT handle, Character*, SQLSMALLINT, Character*, SQLSMALLINT, Character*, SQLSMALLINT, Character*, SQLSMALLINT) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        static_cast<void>(statement_connection(statement));
        if (statement.parameter_execution) throw DriverError("HY010", "Complete or cancel parameter data first.");
        // 컬럼 단위 권한은 미지원이므로 정의된 빈 결과를 낸다.
        std::vector<SqlType> cols{
            make_catalog_varchar("TABLE_CAT", 128, SQL_NULLABLE),
            make_catalog_varchar("TABLE_SCHEM", 128, SQL_NULLABLE),
            make_catalog_varchar("TABLE_NAME", 128, SQL_NO_NULLS),
            make_catalog_varchar("COLUMN_NAME", 128, SQL_NO_NULLS),
            make_catalog_varchar("GRANTOR", 128, SQL_NULLABLE),
            make_catalog_varchar("GRANTEE", 128, SQL_NO_NULLS),
            make_catalog_varchar("PRIVILEGE", 128, SQL_NO_NULLS),
            make_catalog_varchar("IS_GRANTABLE", 3, SQL_NO_NULLS)};
        catalog_empty_impl(statement, std::move(cols));
        return SQL_SUCCESS;
    });
}
template<class Character>
SQLRETURN procedures(SQLHSTMT handle, Character*, SQLSMALLINT, Character*, SQLSMALLINT, Character*, SQLSMALLINT) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        static_cast<void>(statement_connection(statement));
        if (statement.parameter_execution) throw DriverError("HY010", "Complete or cancel parameter data first.");
        std::vector<SqlType> cols{
            make_catalog_varchar("PROCEDURE_CAT", 128, SQL_NULLABLE),
            make_catalog_varchar("PROCEDURE_SCHEM", 128, SQL_NULLABLE),
            make_catalog_varchar("PROCEDURE_NAME", 128, SQL_NO_NULLS),
            make_catalog_smallint("NUM_INPUT_PARAMS", SQL_NULLABLE),
            make_catalog_smallint("NUM_OUTPUT_PARAMS", SQL_NULLABLE),
            make_catalog_smallint("NUM_RESULT_SETS", SQL_NULLABLE),
            make_catalog_varchar("REMARKS", 254, SQL_NULLABLE),
            make_catalog_smallint("PROCEDURE_TYPE", SQL_NULLABLE)};
        catalog_empty_impl(statement, std::move(cols));
        return SQL_SUCCESS;
    });
}
template<class Character>
SQLRETURN procedure_columns(SQLHSTMT handle, Character*, SQLSMALLINT, Character*, SQLSMALLINT, Character*, SQLSMALLINT, Character*, SQLSMALLINT) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        static_cast<void>(statement_connection(statement));
        if (statement.parameter_execution) throw DriverError("HY010", "Complete or cancel parameter data first.");
        std::vector<SqlType> cols{
            make_catalog_varchar("PROCEDURE_CAT", 128, SQL_NULLABLE),
            make_catalog_varchar("PROCEDURE_SCHEM", 128, SQL_NULLABLE),
            make_catalog_varchar("PROCEDURE_NAME", 128, SQL_NO_NULLS),
            make_catalog_varchar("COLUMN_NAME", 128, SQL_NO_NULLS),
            make_catalog_smallint("COLUMN_TYPE", SQL_NO_NULLS),
            make_catalog_smallint("DATA_TYPE", SQL_NO_NULLS),
            make_catalog_varchar("TYPE_NAME", 128, SQL_NO_NULLS),
            make_catalog_integer("COLUMN_SIZE", SQL_NULLABLE),
            make_catalog_integer("BUFFER_LENGTH", SQL_NULLABLE),
            make_catalog_smallint("DECIMAL_DIGITS", SQL_NULLABLE),
            make_catalog_smallint("NUM_PREC_RADIX", SQL_NULLABLE),
            make_catalog_smallint("NULLABLE", SQL_NO_NULLS),
            make_catalog_varchar("REMARKS", 254, SQL_NULLABLE),
            make_catalog_varchar("COLUMN_DEF", 1024, SQL_NULLABLE),
            make_catalog_smallint("SQL_DATA_TYPE", SQL_NO_NULLS),
            make_catalog_smallint("SQL_DATETIME_SUB", SQL_NULLABLE),
            make_catalog_integer("CHAR_OCTET_LENGTH", SQL_NULLABLE),
            make_catalog_integer("ORDINAL_POSITION", SQL_NO_NULLS),
            make_catalog_varchar("IS_NULLABLE", 3, SQL_NO_NULLS)};
        catalog_empty_impl(statement, std::move(cols));
        return SQL_SUCCESS;
    });
}
} // namespace

extern "C" SQLRETURN SQL_API SQLTables(SQLHSTMT h, SQLCHAR* c, SQLSMALLINT cl, SQLCHAR* s, SQLSMALLINT sl, SQLCHAR* t, SQLSMALLINT tl, SQLCHAR* y, SQLSMALLINT yl) { return tables(h, c, cl, s, sl, t, tl, y, yl); }
extern "C" SQLRETURN SQL_API SQLTablesW(SQLHSTMT h, SQLWCHAR* c, SQLSMALLINT cl, SQLWCHAR* s, SQLSMALLINT sl, SQLWCHAR* t, SQLSMALLINT tl, SQLWCHAR* y, SQLSMALLINT yl) { return tables(h, c, cl, s, sl, t, tl, y, yl); }
extern "C" SQLRETURN SQL_API SQLColumns(SQLHSTMT h, SQLCHAR* c, SQLSMALLINT cl, SQLCHAR* s, SQLSMALLINT sl, SQLCHAR* t, SQLSMALLINT tl, SQLCHAR* n, SQLSMALLINT nl) { return columns(h, c, cl, s, sl, t, tl, n, nl); }
extern "C" SQLRETURN SQL_API SQLColumnsW(SQLHSTMT h, SQLWCHAR* c, SQLSMALLINT cl, SQLWCHAR* s, SQLSMALLINT sl, SQLWCHAR* t, SQLSMALLINT tl, SQLWCHAR* n, SQLSMALLINT nl) { return columns(h, c, cl, s, sl, t, tl, n, nl); }
extern "C" SQLRETURN SQL_API SQLStatistics(SQLHSTMT h, SQLCHAR* c, SQLSMALLINT cl, SQLCHAR* s, SQLSMALLINT sl, SQLCHAR* t, SQLSMALLINT tl, SQLUSMALLINT u, SQLUSMALLINT r) { return statistics(h, c, cl, s, sl, t, tl, u, r); }
extern "C" SQLRETURN SQL_API SQLStatisticsW(SQLHSTMT h, SQLWCHAR* c, SQLSMALLINT cl, SQLWCHAR* s, SQLSMALLINT sl, SQLWCHAR* t, SQLSMALLINT tl, SQLUSMALLINT u, SQLUSMALLINT r) { return statistics(h, c, cl, s, sl, t, tl, u, r); }
extern "C" SQLRETURN SQL_API SQLSpecialColumns(SQLHSTMT h, SQLUSMALLINT id, SQLCHAR* c, SQLSMALLINT cl, SQLCHAR* s, SQLSMALLINT sl, SQLCHAR* t, SQLSMALLINT tl, SQLUSMALLINT sc, SQLUSMALLINT nu) { return special_columns(h, id, c, cl, s, sl, t, tl, sc, nu); }
extern "C" SQLRETURN SQL_API SQLSpecialColumnsW(SQLHSTMT h, SQLUSMALLINT id, SQLWCHAR* c, SQLSMALLINT cl, SQLWCHAR* s, SQLSMALLINT sl, SQLWCHAR* t, SQLSMALLINT tl, SQLUSMALLINT sc, SQLUSMALLINT nu) { return special_columns(h, id, c, cl, s, sl, t, tl, sc, nu); }
extern "C" SQLRETURN SQL_API SQLPrimaryKeys(SQLHSTMT h, SQLCHAR* c, SQLSMALLINT cl, SQLCHAR* s, SQLSMALLINT sl, SQLCHAR* t, SQLSMALLINT tl) { return primary_keys(h, c, cl, s, sl, t, tl); }
extern "C" SQLRETURN SQL_API SQLPrimaryKeysW(SQLHSTMT h, SQLWCHAR* c, SQLSMALLINT cl, SQLWCHAR* s, SQLSMALLINT sl, SQLWCHAR* t, SQLSMALLINT tl) { return primary_keys(h, c, cl, s, sl, t, tl); }
extern "C" SQLRETURN SQL_API SQLForeignKeys(SQLHSTMT h, SQLCHAR* pkc, SQLSMALLINT pkcl, SQLCHAR* pks, SQLSMALLINT pksl, SQLCHAR* pkt, SQLSMALLINT pktl, SQLCHAR* fkc, SQLSMALLINT fkcl, SQLCHAR* fks, SQLSMALLINT fksl, SQLCHAR* fkt, SQLSMALLINT fktl) { return foreign_keys(h, pkc, pkcl, pks, pksl, pkt, pktl, fkc, fkcl, fks, fksl, fkt, fktl); }
extern "C" SQLRETURN SQL_API SQLForeignKeysW(SQLHSTMT h, SQLWCHAR* pkc, SQLSMALLINT pkcl, SQLWCHAR* pks, SQLSMALLINT pksl, SQLWCHAR* pkt, SQLSMALLINT pktl, SQLWCHAR* fkc, SQLSMALLINT fkcl, SQLWCHAR* fks, SQLSMALLINT fksl, SQLWCHAR* fkt, SQLSMALLINT fktl) { return foreign_keys(h, pkc, pkcl, pks, pksl, pkt, pktl, fkc, fkcl, fks, fksl, fkt, fktl); }
extern "C" SQLRETURN SQL_API SQLTablePrivileges(SQLHSTMT h, SQLCHAR* c, SQLSMALLINT cl, SQLCHAR* s, SQLSMALLINT sl, SQLCHAR* t, SQLSMALLINT tl) { return table_privileges(h, c, cl, s, sl, t, tl); }
extern "C" SQLRETURN SQL_API SQLTablePrivilegesW(SQLHSTMT h, SQLWCHAR* c, SQLSMALLINT cl, SQLWCHAR* s, SQLSMALLINT sl, SQLWCHAR* t, SQLSMALLINT tl) { return table_privileges(h, c, cl, s, sl, t, tl); }
extern "C" SQLRETURN SQL_API SQLColumnPrivileges(SQLHSTMT h, SQLCHAR* c, SQLSMALLINT cl, SQLCHAR* s, SQLSMALLINT sl, SQLCHAR* t, SQLSMALLINT tl, SQLCHAR* n, SQLSMALLINT nl) { return column_privileges(h, c, cl, s, sl, t, tl, n, nl); }
extern "C" SQLRETURN SQL_API SQLColumnPrivilegesW(SQLHSTMT h, SQLWCHAR* c, SQLSMALLINT cl, SQLWCHAR* s, SQLSMALLINT sl, SQLWCHAR* t, SQLSMALLINT tl, SQLWCHAR* n, SQLSMALLINT nl) { return column_privileges(h, c, cl, s, sl, t, tl, n, nl); }
extern "C" SQLRETURN SQL_API SQLProcedures(SQLHSTMT h, SQLCHAR* c, SQLSMALLINT cl, SQLCHAR* s, SQLSMALLINT sl, SQLCHAR* p, SQLSMALLINT pl) { return procedures(h, c, cl, s, sl, p, pl); }
extern "C" SQLRETURN SQL_API SQLProceduresW(SQLHSTMT h, SQLWCHAR* c, SQLSMALLINT cl, SQLWCHAR* s, SQLSMALLINT sl, SQLWCHAR* p, SQLSMALLINT pl) { return procedures(h, c, cl, s, sl, p, pl); }
extern "C" SQLRETURN SQL_API SQLProcedureColumns(SQLHSTMT h, SQLCHAR* c, SQLSMALLINT cl, SQLCHAR* s, SQLSMALLINT sl, SQLCHAR* p, SQLSMALLINT pl, SQLCHAR* n, SQLSMALLINT nl) { return procedure_columns(h, c, cl, s, sl, p, pl, n, nl); }
extern "C" SQLRETURN SQL_API SQLProcedureColumnsW(SQLHSTMT h, SQLWCHAR* c, SQLSMALLINT cl, SQLWCHAR* s, SQLSMALLINT sl, SQLWCHAR* p, SQLSMALLINT pl, SQLWCHAR* n, SQLSMALLINT nl) { return procedure_columns(h, c, cl, s, sl, p, pl, n, nl); }
extern "C" SQLRETURN SQL_API SQLGetTypeInfo(SQLHSTMT handle, SQLSMALLINT type) {
    return with_handle<Statement>(SQL_HANDLE_STMT, handle, true, [&](Statement& statement) -> SQLRETURN {
        static_cast<void>(statement_connection(statement));
        if (statement.parameter_execution) throw DriverError("HY010", "Complete or cancel parameter data first.");
        catalog_type_info_impl(statement, type);
        return SQL_SUCCESS;
    });
}
extern "C" SQLRETURN SQL_API SQLGetTypeInfoW(SQLHSTMT handle, SQLSMALLINT type) {
    return SQLGetTypeInfo(handle, type);
}
