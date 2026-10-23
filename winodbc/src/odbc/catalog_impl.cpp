#include "hwdbodbc/catalog.hpp"
#include "hwdbodbc/descriptor.hpp"
#include "hwdbodbc/statement.hpp"
#include <algorithm>
#include <cctype>
#include <map>
#include <set>

namespace hwdbodbc {
namespace {
template<class Character>
std::optional<std::string> read_name(Character* pointer, SQLSMALLINT length) {
    if (!pointer) return std::nullopt;
    if (length < 0 && length != SQL_NTS) throw DriverError("HY090", "Invalid string length.");
    return input_text(pointer, length);
}
bool empty_opt(const std::optional<std::string>& value) {
    return !value || value->empty();
}
bool no_catalog_filter(const std::optional<std::string>& catalog) {
    if (!catalog || catalog->empty() || *catalog == "%") return true;
    return false;
}
// 패턴 값 인자(SQLTables, SQLColumns, SQLTablePrivileges의 스키마·테이블 이름 등)의 비교이다.
bool matches_filter(const std::string& value, const std::optional<std::string>& pattern, bool metadata_id) {
    if (!pattern || pattern->empty()) return true;
    if (metadata_id) return catalog_match(value, *pattern, true);
    if (*pattern == "%") return true;
    return catalog_match(value, *pattern, false);
}
// 일반 인자(SQLStatistics, SQLSpecialColumns, SQLPrimaryKeys, SQLForeignKeys)의 비교이다. ODBC 규약상 패턴이 아니므로
// ORDER_ITEMS 같은 이름의 _가 다른 테이블 ORDERXITEMS와 섞이지 않게 문자 그대로 비교한다. NULL과 빈 문자열은 필터 없음이다.
bool matches_ordinary(const std::string& value, const std::optional<std::string>& argument, bool metadata_id) {
    if (!argument || argument->empty()) return true;
    return catalog_ordinary_match(value, *argument, metadata_id);
}
bool effective_metadata_id(Statement& statement) {
    if (statement.metadata_id == SQL_TRUE) return true;
    auto& connection = static_cast<Connection&>(*statement.parent);
    return connection.metadata_id == SQL_TRUE;
}
std::string json_string(const Json& value) {
    if (value.is_string()) return value.get<std::string>();
    if (value.is_number()) {
        if (value.is_number_integer()) return std::to_string(value.get<long long>());
        return value.dump();
    }
    if (value.is_boolean()) return value.get<bool>() ? "1" : "0";
    return "";
}
long long json_integer(const Json& value) {
    if (value.is_number_integer()) return value.get<long long>();
    if (value.is_number()) return static_cast<long long>(value.get<double>());
    if (value.is_string()) return std::stoll(value.get<std::string>());
    return 0;
}
bool json_is_null(const Json& value) { return value.is_null(); }
std::vector<std::string> parse_table_types(const std::optional<std::string>& input) {
    if (!input || input->empty() || *input == "%") return {"TABLE", "VIEW"};
    std::vector<std::string> result;
    std::string current;
    bool quoted = false;
    for (std::size_t i = 0; i <= input->size(); ++i) {
        const char c = i < input->size() ? (*input)[i] : ',';
        if (c == '\'') { quoted = !quoted; continue; }
        if ((c == ',' && !quoted) || i == input->size()) {
            std::string item;
            for (auto ch : current) if (ch != ' ' && ch != '\t' && ch != '\r' && ch != '\n') item += ch;
            std::string upper;
            for (auto ch : item) upper += static_cast<char>(ch >= 'a' && ch <= 'z' ? ch - 'a' + 'A' : ch);
            if (!upper.empty()) result.push_back(upper);
            current.clear();
        } else current += c;
    }
    return result;
}
bool table_type_allows(const std::vector<std::string>& types, const std::string& candidate) {
    return std::find(types.begin(), types.end(), candidate) != types.end();
}
// 서버 SYS 행의 TABLESPACE/TABLE/컬럼 값을 읽는다. 위치는 호출자가 고정한다.
} // namespace

void catalog_tables_impl(Statement& statement,
    std::optional<std::string> catalog, std::optional<std::string> schema,
    std::optional<std::string> table, std::optional<std::string> type) {
    const bool metadata_id = effective_metadata_id(statement);
    auto& connection = static_cast<Connection&>(*statement.parent);
    const bool catalog_empty = empty_opt(catalog);
    const bool schema_empty = empty_opt(schema);
    const bool table_empty = empty_opt(table);
    const bool type_empty = empty_opt(type);
    // 특수 호출: 카탈로그/스키마/테이블 종류 목록이다.
    if (catalog && *catalog == "%" && schema_empty && table_empty && type_empty) {
        std::vector<SqlType> columns{make_catalog_varchar("TABLE_CAT", 128, SQL_NULLABLE)};
        set_catalog_result(statement, std::move(columns), Json::array());
        return;
    }
    if (schema && *schema == "%" && catalog_empty && table_empty && type_empty) {
        auto rows = fetch_all_rows(connection, "SELECT TABLESPACE_NAME FROM SYSTEM.SYS_TABLESPACES");
        Json out = Json::array();
        std::set<std::string> seen;
        for (const auto& row : rows) {
            if (row.size() < 1 || json_is_null(row[0])) continue;
            const std::string name = json_string(row[0]);
            // 사용 불가 테이블스페이스는 스키마 목록에서 제외한다.
            if (!seen.insert(name).second) continue;
            out.push_back(Json::array({name}));
        }
        std::sort(out.begin(), out.end(), [](const Json& a, const Json& b) { return a[0].get<std::string>() < b[0].get<std::string>(); });
        std::vector<SqlType> columns{make_catalog_varchar("TABLE_SCHEM", 128, SQL_NO_NULLS)};
        set_catalog_result(statement, std::move(columns), std::move(out));
        return;
    }
    if (type && *type == "%" && catalog_empty && schema_empty && table_empty) {
        Json out = Json::array({Json::array({"TABLE"}), Json::array({"VIEW"})});
        std::vector<SqlType> columns{make_catalog_varchar("TABLE_TYPE", 128, SQL_NO_NULLS)};
        set_catalog_result(statement, std::move(columns), std::move(out));
        return;
    }
    if (!no_catalog_filter(catalog)) {
        std::vector<SqlType> columns{
            make_catalog_varchar("TABLE_CAT", 128, SQL_NULLABLE),
            make_catalog_varchar("TABLE_SCHEM", 128, SQL_NULLABLE),
            make_catalog_varchar("TABLE_NAME", 128, SQL_NO_NULLS),
            make_catalog_varchar("TABLE_TYPE", 128, SQL_NO_NULLS),
            make_catalog_varchar("REMARKS", 254, SQL_NULLABLE)};
        set_catalog_result(statement, std::move(columns), Json::array());
        return;
    }
    const auto allowed = parse_table_types(type);
    auto tables = fetch_all_rows(connection, "SELECT TABLESPACE_NAME, TABLE_NAME, OWNER FROM SYSTEM.SYS_TABLES");
    auto views = fetch_all_rows(connection, "SELECT TABLESPACE_NAME, VIEW_NAME, OWNER FROM SYSTEM.SYS_VIEWS");
    Json out = Json::array();
    auto matches = [&](const std::string& schem, const std::string& name) {
        if (!matches_filter(schem, schema, metadata_id)) return false;
        if (!matches_filter(name, table, metadata_id)) return false;
        return true;
    };
    if (table_type_allows(allowed, "TABLE")) {
        for (const auto& row : tables) {
            if (row.size() < 2) continue;
            const std::string schem = json_is_null(row[0]) ? "" : json_string(row[0]);
            const std::string name = json_is_null(row[1]) ? "" : json_string(row[1]);
            if (!matches(schem, name)) continue;
            out.push_back(Json::array({nullptr, schem, name, "TABLE", nullptr}));
        }
    }
    if (table_type_allows(allowed, "VIEW")) {
        for (const auto& row : views) {
            if (row.size() < 2) continue;
            const std::string schem = json_is_null(row[0]) ? "" : json_string(row[0]);
            const std::string name = json_is_null(row[1]) ? "" : json_string(row[1]);
            if (!matches(schem, name)) continue;
            out.push_back(Json::array({nullptr, schem, name, "VIEW", nullptr}));
        }
    }
    std::sort(out.begin(), out.end(), [](const Json& a, const Json& b) {
        const std::string at = a[3].get<std::string>(), bt = b[3].get<std::string>();
        if (at != bt) return at < bt;
        const std::string as = a[1].get<std::string>(), bs = b[1].get<std::string>();
        if (as != bs) return as < bs;
        return a[2].get<std::string>() < b[2].get<std::string>();
    });
    std::vector<SqlType> columns{
        make_catalog_varchar("TABLE_CAT", 128, SQL_NULLABLE),
        make_catalog_varchar("TABLE_SCHEM", 128, SQL_NULLABLE),
        make_catalog_varchar("TABLE_NAME", 128, SQL_NO_NULLS),
        make_catalog_varchar("TABLE_TYPE", 128, SQL_NO_NULLS),
        make_catalog_varchar("REMARKS", 254, SQL_NULLABLE)};
    set_catalog_result(statement, std::move(columns), std::move(out));
}

void catalog_columns_impl(Statement& statement,
    std::optional<std::string> catalog, std::optional<std::string> schema,
    std::optional<std::string> table, std::optional<std::string> column) {
    const bool metadata_id = effective_metadata_id(statement);
    auto& connection = static_cast<Connection&>(*statement.parent);
    if (!no_catalog_filter(catalog)) {
        std::vector<SqlType> cols{
            make_catalog_varchar("TABLE_CAT", 128, SQL_NULLABLE),
            make_catalog_varchar("TABLE_SCHEM", 128, SQL_NULLABLE),
            make_catalog_varchar("TABLE_NAME", 128, SQL_NO_NULLS),
            make_catalog_varchar("COLUMN_NAME", 128, SQL_NO_NULLS),
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
        set_catalog_result(statement, std::move(cols), Json::array());
        return;
    }
    auto rows = fetch_all_rows(connection,
        "SELECT TABLESPACE_NAME, TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM SYSTEM.SYS_COLUMNS");
    Json out = Json::array();
    for (const auto& row : rows) {
        if (row.size() < 7) continue;
        const std::string schem = json_is_null(row[0]) ? "" : json_string(row[0]);
        const std::string tname = json_is_null(row[1]) ? "" : json_string(row[1]);
        const std::string cname = json_is_null(row[2]) ? "" : json_string(row[2]);
        if (!matches_filter(schem, schema, metadata_id)) continue;
        if (!matches_filter(tname, table, metadata_id)) continue;
        if (!matches_filter(cname, column, metadata_id)) continue;
        const long long ordinal = json_integer(row[3]);
        const std::string declared = json_is_null(row[4]) ? "" : json_string(row[4]);
        const std::string nullable_text = json_is_null(row[5]) ? "YES" : json_string(row[5]);
        const bool has_default = !json_is_null(row[6]);
        const std::string def = has_default ? json_string(row[6]) : "";
        const auto info = catalog_type_info(declared);
        const SQLSMALLINT data_type = info.sql_type;
        const SQLSMALLINT sql_data_type = (data_type >= SQL_TYPE_DATE && data_type <= SQL_TYPE_TIMESTAMP) || (data_type >= SQL_INTERVAL_YEAR && data_type <= SQL_INTERVAL_MINUTE_TO_SECOND)
            ? (data_type >= SQL_INTERVAL_YEAR ? SQL_INTERVAL : SQL_DATETIME) : data_type;
        SQLSMALLINT datetime_sub = 0;
        bool datetime_null = true;
        if (data_type == SQL_TYPE_DATE) { datetime_sub = SQL_CODE_DATE; datetime_null = false; }
        else if (data_type == SQL_TYPE_TIME) { datetime_sub = SQL_CODE_TIME; datetime_null = false; }
        else if (data_type == SQL_TYPE_TIMESTAMP) { datetime_sub = SQL_CODE_TIMESTAMP; datetime_null = false; }
        else if (data_type >= SQL_INTERVAL_YEAR && data_type <= SQL_INTERVAL_MINUTE_TO_SECOND) { datetime_sub = static_cast<SQLSMALLINT>(data_type - 100); datetime_null = false; }
        SQLSMALLINT nullable = SQL_NULLABLE_UNKNOWN;
        std::string is_nullable = "YES";
        if (nullable_text == "NO") { nullable = SQL_NO_NULLS; is_nullable = "NO"; }
        else if (nullable_text == "YES") { nullable = SQL_NULLABLE; is_nullable = "YES"; }
        const long long column_size = static_cast<long long>(info.column_size);
        const long long buffer_length = static_cast<long long>(info.buffer_length);
        Json decimal_digits = info.decimal_nullable ? Json(nullptr) : Json(static_cast<long long>(info.decimal_digits));
        Json radix = info.radix_nullable ? Json(nullptr) : Json(static_cast<long long>(info.radix));
        Json char_octet = (data_type == SQL_WCHAR || data_type == SQL_WVARCHAR || data_type == SQL_BINARY || data_type == SQL_VARBINARY)
            ? Json(buffer_length) : Json(nullptr);
        Json datetime_json = datetime_null ? Json(nullptr) : Json(static_cast<long long>(datetime_sub));
        Json def_json = has_default ? Json(def) : Json(nullptr);
        // ODBC 순서: CAT, SCHEM, TABLE, COLUMN, DATA_TYPE, TYPE_NAME, COLUMN_SIZE, BUFFER_LENGTH,
        // DECIMAL_DIGITS, NUM_PREC_RADIX, NULLABLE, REMARKS, COLUMN_DEF, SQL_DATA_TYPE,
        // SQL_DATETIME_SUB, CHAR_OCTET_LENGTH, ORDINAL_POSITION, IS_NULLABLE
        out.push_back(Json::array({nullptr, schem, tname, cname,
            static_cast<long long>(data_type), info.type_name,
            column_size, buffer_length, decimal_digits, radix,
            static_cast<long long>(nullable), nullptr, def_json,
            static_cast<long long>(sql_data_type), datetime_json, char_octet,
            ordinal, is_nullable}));
    }
    std::sort(out.begin(), out.end(), [](const Json& a, const Json& b) {
        const std::string as = a[1].get<std::string>(), bs = b[1].get<std::string>();
        if (as != bs) return as < bs;
        const std::string at = a[2].get<std::string>(), bt = b[2].get<std::string>();
        if (at != bt) return at < bt;
        return a[16].get<long long>() < b[16].get<long long>();
    });
    std::vector<SqlType> cols{
        make_catalog_varchar("TABLE_CAT", 128, SQL_NULLABLE),
        make_catalog_varchar("TABLE_SCHEM", 128, SQL_NULLABLE),
        make_catalog_varchar("TABLE_NAME", 128, SQL_NO_NULLS),
        make_catalog_varchar("COLUMN_NAME", 128, SQL_NO_NULLS),
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
    set_catalog_result(statement, std::move(cols), std::move(out));
}

void catalog_statistics_impl(Statement& statement,
    std::optional<std::string> catalog, std::optional<std::string> schema,
    std::optional<std::string> table, SQLUSMALLINT unique, SQLUSMALLINT reserved) {
    if (unique != SQL_INDEX_UNIQUE && unique != SQL_INDEX_ALL) throw DriverError("HY024", "Invalid unique value for SQLStatistics.");
    if (reserved != SQL_ENSURE && reserved != SQL_QUICK) throw DriverError("HY101", "Invalid reserved value for SQLStatistics.");
    const bool metadata_id = effective_metadata_id(statement);
    auto& connection = static_cast<Connection&>(*statement.parent);
    std::vector<SqlType> cols{
        make_catalog_varchar("TABLE_CAT", 128, SQL_NULLABLE),
        make_catalog_varchar("TABLE_SCHEM", 128, SQL_NULLABLE),
        make_catalog_varchar("TABLE_NAME", 128, SQL_NO_NULLS),
        make_catalog_smallint("NON_UNIQUE", SQL_NO_NULLS),
        make_catalog_varchar("INDEX_QUALIFIER", 128, SQL_NULLABLE),
        make_catalog_varchar("INDEX_NAME", 128, SQL_NULLABLE),
        make_catalog_smallint("TYPE", SQL_NO_NULLS),
        make_catalog_smallint("ORDINAL_POSITION", SQL_NULLABLE),
        make_catalog_varchar("COLUMN_NAME", 128, SQL_NULLABLE),
        make_catalog_varchar("ASC_OR_DESC", 1, SQL_NULLABLE),
        make_catalog_integer("CARDINALITY", SQL_NULLABLE),
        make_catalog_integer("PAGES", SQL_NULLABLE),
        make_catalog_varchar("FILTER_CONDITION", 1024, SQL_NULLABLE)};
    if (!no_catalog_filter(catalog)) { set_catalog_result(statement, std::move(cols), Json::array()); return; }
    // 스키마와 테이블 이름은 패턴이 아닌 일반 인자이다. 이름을 주면 그 테이블만, 비우면 가시적인 모든 테이블을 대상으로 한다.
    auto indexes = fetch_all_rows(connection, "SELECT TABLESPACE_NAME, INDEX_NAME, TABLE_NAME, IS_UNIQUE FROM SYSTEM.SYS_INDEXES");
    auto columns = fetch_all_rows(connection, "SELECT TABLESPACE_NAME, INDEX_NAME, ORDINAL_POSITION, COLUMN_NAME, IS_DESCENDING FROM SYSTEM.SYS_INDEX_COLUMNS");
    std::map<std::pair<std::string, std::string>, std::vector<Json>> by_index;
    for (const auto& row : columns) {
        if (row.size() < 5) continue;
        const std::string schem = json_is_null(row[0]) ? "" : json_string(row[0]);
        const std::string iname = json_is_null(row[1]) ? "" : json_string(row[1]);
        by_index[{schem, iname}].push_back(row);
    }
    Json out = Json::array();
    for (const auto& row : indexes) {
        if (row.size() < 4) continue;
        const std::string schem = json_is_null(row[0]) ? "" : json_string(row[0]);
        const std::string iname = json_is_null(row[1]) ? "" : json_string(row[1]);
        const std::string tname = json_is_null(row[2]) ? "" : json_string(row[2]);
        const std::string unique_text = json_is_null(row[3]) ? "NO" : json_string(row[3]);
        const bool is_unique = unique_text == "YES";
        if (unique == SQL_INDEX_UNIQUE && !is_unique) continue;
        if (!matches_ordinary(schem, schema, metadata_id)) continue;
        if (!matches_ordinary(tname, table, metadata_id)) continue;
        const auto found = by_index.find({schem, iname});
        if (found == by_index.end()) continue;
        auto parts = found->second;
        std::sort(parts.begin(), parts.end(), [](const Json& a, const Json& b) { return json_integer(a[2]) < json_integer(b[2]); });
        for (const auto& part : parts) {
            const long long ordinal = json_integer(part[2]);
            const std::string cname = json_is_null(part[3]) ? "" : json_string(part[3]);
            const std::string desc = json_is_null(part[4]) ? "NO" : json_string(part[4]);
            out.push_back(Json::array({nullptr, schem, tname,
                is_unique ? 0 : 1, nullptr, iname,
                static_cast<long long>(SQL_INDEX_OTHER), ordinal, cname,
                desc == "YES" ? "D" : "A", nullptr, nullptr, nullptr}));
        }
    }
    std::sort(out.begin(), out.end(), [](const Json& a, const Json& b) {
        if (a[1].get<std::string>() != b[1].get<std::string>()) return a[1].get<std::string>() < b[1].get<std::string>();
        if (a[2].get<std::string>() != b[2].get<std::string>()) return a[2].get<std::string>() < b[2].get<std::string>();
        if (a[5].get<std::string>() != b[5].get<std::string>()) return a[5].get<std::string>() < b[5].get<std::string>();
        return a[7].get<long long>() < b[7].get<long long>();
    });
    // TYPE=0인 테이블 통계 행은 서버에 통계가 없어 제공하지 않는다.
    set_catalog_result(statement, std::move(cols), std::move(out));
}

void catalog_special_columns_impl(Statement& statement, SQLUSMALLINT identifier,
    std::optional<std::string> catalog, std::optional<std::string> schema,
    std::optional<std::string> table, SQLUSMALLINT scope, SQLUSMALLINT nullable) {
    if (identifier != SQL_BEST_ROWID && identifier != SQL_ROWVER) throw DriverError("HY024", "Invalid identifier type for SQLSpecialColumns.");
    if (scope != SQL_SCOPE_CURROW && scope != SQL_SCOPE_TRANSACTION && scope != SQL_SCOPE_SESSION) throw DriverError("HY024", "Invalid scope for SQLSpecialColumns.");
    std::vector<SqlType> cols{
        make_catalog_smallint("SCOPE", SQL_NULLABLE),
        make_catalog_varchar("COLUMN_NAME", 128, SQL_NO_NULLS),
        make_catalog_smallint("DATA_TYPE", SQL_NO_NULLS),
        make_catalog_varchar("TYPE_NAME", 128, SQL_NO_NULLS),
        make_catalog_integer("COLUMN_SIZE", SQL_NULLABLE),
        make_catalog_integer("BUFFER_LENGTH", SQL_NULLABLE),
        make_catalog_smallint("DECIMAL_DIGITS", SQL_NULLABLE),
        make_catalog_smallint("PSEUDO_COLUMN", SQL_NO_NULLS)};
    if (identifier == SQL_ROWVER) { set_catalog_result(statement, std::move(cols), Json::array()); return; }
    if (!no_catalog_filter(catalog)) { set_catalog_result(statement, std::move(cols), Json::array()); return; }
    const bool metadata_id = effective_metadata_id(statement);
    auto& connection = static_cast<Connection&>(*statement.parent);
    // BEST_ROWID는 PK 컬럼이다. 테이블 지정이 없거나 패턴이면 일치하는 테이블의 PK를 모두 반환한다.
    auto constraints = fetch_all_rows(connection, "SELECT TABLESPACE_NAME, CONSTRAINT_NAME, TABLE_NAME, CONSTRAINT_TYPE FROM SYSTEM.SYS_CONSTRAINTS");
    auto constraint_columns = fetch_all_rows(connection, "SELECT TABLESPACE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION, COLUMN_NAME FROM SYSTEM.SYS_CONSTRAINT_COLUMNS");
    auto columns = fetch_all_rows(connection, "SELECT TABLESPACE_NAME, TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, DATA_TYPE, IS_NULLABLE FROM SYSTEM.SYS_COLUMNS");
    std::map<std::pair<std::string, std::string>, std::vector<std::string>> pk_of;
    for (const auto& row : constraints) {
        if (row.size() < 4) continue;
        if (json_is_null(row[3]) || json_string(row[3]) != "PRIMARY KEY") continue;
        const std::string schem = json_is_null(row[0]) ? "" : json_string(row[0]);
        const std::string cname = json_is_null(row[1]) ? "" : json_string(row[1]);
        const std::string tname = json_is_null(row[2]) ? "" : json_string(row[2]);
        pk_of[{schem, cname}].push_back(tname);
        (void)tname;
    }
    std::map<std::tuple<std::string, std::string, long long>, std::string> pk_order;
    for (const auto& row : constraint_columns) {
        if (row.size() < 4) continue;
        const std::string schem = json_is_null(row[0]) ? "" : json_string(row[0]);
        const std::string cname = json_is_null(row[1]) ? "" : json_string(row[1]);
        const long long ordinal = json_integer(row[2]);
        const std::string col = json_is_null(row[3]) ? "" : json_string(row[3]);
        pk_order[{schem, cname, ordinal}] = col;
    }
    std::map<std::pair<std::string, std::string>, std::string> column_declared;
    for (const auto& row : columns) {
        if (row.size() < 5) continue;
        const std::string schem = json_is_null(row[0]) ? "" : json_string(row[0]);
        const std::string tname = json_is_null(row[1]) ? "" : json_string(row[1]);
        const std::string cname = json_is_null(row[2]) ? "" : json_string(row[2]);
        const std::string declared = json_is_null(row[4]) ? "" : json_string(row[4]);
        column_declared[{schem + "." + tname, cname}] = declared;
        // 스키마·테이블 키는 아래에서 PK와 대조한다.
        (void)schem; (void)tname;
    }
    // PK 이름에서 테이블을 역으로 찾는다.
    std::map<std::pair<std::string, std::string>, std::string> constraint_table;
    for (const auto& row : constraints) {
        if (row.size() < 4) continue;
        if (json_string(row[3]) != "PRIMARY KEY") continue;
        constraint_table[{json_string(row[0]), json_string(row[1])}] = json_string(row[2]);
    }
    Json out = Json::array();
    for (const auto& [key, col] : pk_order) {
        const auto& [schem, cname, ordinal] = key;
        const auto table_it = constraint_table.find({schem, cname});
        if (table_it == constraint_table.end()) continue;
        const std::string tname = table_it->second;
        if (!matches_ordinary(schem, schema, metadata_id)) continue;
        if (!matches_ordinary(tname, table, metadata_id)) continue;
        const auto declared_it = column_declared.find({schem + "." + tname, col});
        const std::string declared = declared_it == column_declared.end() ? "INTEGER" : declared_it->second;
        const auto info = catalog_type_info(declared);
        Json decimal_digits = info.decimal_nullable ? Json(nullptr) : Json(static_cast<long long>(info.decimal_digits));
        out.push_back(Json::array({
            static_cast<long long>(SQL_SCOPE_SESSION), col,
            static_cast<long long>(info.sql_type), info.type_name,
            static_cast<long long>(info.column_size), static_cast<long long>(info.buffer_length),
            decimal_digits, static_cast<long long>(SQL_PC_NOT_PSEUDO)}));
        (void)ordinal;
    }
    // SCOPE 인자는 요구하는 "최소" 범위이고 돌려주는 rowid의 범위는 더 넓어도 된다. PK는 SESSION 범위로 보고하므로
    // CURROW와 TRANSACTION 요청에도 같은 PK 컬럼을 돌려준다. (빈 결과를 내면 이 범위를 요청하는 앱이 행 식별자를 잃는다.)
    // PK는 NOT NULL이므로 nullable 인자(SQL_NO_NULLS 포함)와 무관하게 모든 행이 조건을 만족한다.
    (void)scope; (void)nullable;
    set_catalog_result(statement, std::move(cols), std::move(out));
}

void catalog_primary_keys_impl(Statement& statement,
    std::optional<std::string> catalog, std::optional<std::string> schema, std::optional<std::string> table) {
    std::vector<SqlType> cols{
        make_catalog_varchar("TABLE_CAT", 128, SQL_NULLABLE),
        make_catalog_varchar("TABLE_SCHEM", 128, SQL_NULLABLE),
        make_catalog_varchar("TABLE_NAME", 128, SQL_NO_NULLS),
        make_catalog_varchar("COLUMN_NAME", 128, SQL_NO_NULLS),
        make_catalog_smallint("KEY_SEQ", SQL_NO_NULLS),
        make_catalog_varchar("PK_NAME", 128, SQL_NULLABLE)};
    if (!no_catalog_filter(catalog)) { set_catalog_result(statement, std::move(cols), Json::array()); return; }
    const bool metadata_id = effective_metadata_id(statement);
    auto& connection = static_cast<Connection&>(*statement.parent);
    auto constraints = fetch_all_rows(connection, "SELECT TABLESPACE_NAME, CONSTRAINT_NAME, TABLE_NAME, CONSTRAINT_TYPE FROM SYSTEM.SYS_CONSTRAINTS");
    auto constraint_columns = fetch_all_rows(connection, "SELECT TABLESPACE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION, COLUMN_NAME FROM SYSTEM.SYS_CONSTRAINT_COLUMNS");
    std::map<std::pair<std::string, std::string>, std::string> table_of;
    for (const auto& row : constraints) {
        if (row.size() < 4) continue;
        if (json_is_null(row[3]) || json_string(row[3]) != "PRIMARY KEY") continue;
        table_of[{json_string(row[0]), json_string(row[1])}] = json_string(row[2]);
    }
    Json out = Json::array();
    for (const auto& row : constraint_columns) {
        if (row.size() < 4) continue;
        const std::string schem = json_is_null(row[0]) ? "" : json_string(row[0]);
        const std::string cname = json_is_null(row[1]) ? "" : json_string(row[1]);
        const auto table_it = table_of.find({schem, cname});
        if (table_it == table_of.end()) continue;
        const std::string tname = table_it->second;
        if (!matches_ordinary(schem, schema, metadata_id)) continue;
        if (!matches_ordinary(tname, table, metadata_id)) continue;
        out.push_back(Json::array({nullptr, schem, tname, json_string(row[3]), json_integer(row[2]), cname}));
    }
    std::sort(out.begin(), out.end(), [](const Json& a, const Json& b) {
        if (a[1].get<std::string>() != b[1].get<std::string>()) return a[1].get<std::string>() < b[1].get<std::string>();
        if (a[2].get<std::string>() != b[2].get<std::string>()) return a[2].get<std::string>() < b[2].get<std::string>();
        return a[4].get<long long>() < b[4].get<long long>();
    });
    set_catalog_result(statement, std::move(cols), std::move(out));
}

void catalog_foreign_keys_impl(Statement& statement,
    std::optional<std::string> pk_catalog, std::optional<std::string> pk_schema, std::optional<std::string> pk_table,
    std::optional<std::string> fk_catalog, std::optional<std::string> fk_schema, std::optional<std::string> fk_table) {
    std::vector<SqlType> cols{
        make_catalog_varchar("PKTABLE_CAT", 128, SQL_NULLABLE),
        make_catalog_varchar("PKTABLE_SCHEM", 128, SQL_NULLABLE),
        make_catalog_varchar("PKTABLE_NAME", 128, SQL_NO_NULLS),
        make_catalog_varchar("PKCOLUMN_NAME", 128, SQL_NO_NULLS),
        make_catalog_varchar("FKTABLE_CAT", 128, SQL_NULLABLE),
        make_catalog_varchar("FKTABLE_SCHEM", 128, SQL_NULLABLE),
        make_catalog_varchar("FKTABLE_NAME", 128, SQL_NO_NULLS),
        make_catalog_varchar("FKCOLUMN_NAME", 128, SQL_NO_NULLS),
        make_catalog_smallint("KEY_SEQ", SQL_NO_NULLS),
        make_catalog_smallint("UPDATE_RULE", SQL_NULLABLE),
        make_catalog_smallint("DELETE_RULE", SQL_NULLABLE),
        make_catalog_varchar("FK_NAME", 128, SQL_NULLABLE),
        make_catalog_varchar("PK_NAME", 128, SQL_NULLABLE),
        make_catalog_smallint("DEFERRABILITY", SQL_NULLABLE)};
    if (!no_catalog_filter(pk_catalog) || !no_catalog_filter(fk_catalog)) {
        set_catalog_result(statement, std::move(cols), Json::array());
        return;
    }
    const bool metadata_id = effective_metadata_id(statement);
    auto& connection = static_cast<Connection&>(*statement.parent);
    auto constraints = fetch_all_rows(connection, "SELECT TABLESPACE_NAME, CONSTRAINT_NAME, TABLE_NAME, CONSTRAINT_TYPE, REFERENCED_TABLE, DELETE_RULE, UPDATE_RULE FROM SYSTEM.SYS_CONSTRAINTS");
    auto constraint_columns = fetch_all_rows(connection, "SELECT TABLESPACE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION, COLUMN_NAME, REFERENCED_COLUMN FROM SYSTEM.SYS_CONSTRAINT_COLUMNS");
    // FK별로 PK 테이블·컬럼을 찾는다. 같은 테이블스페이스만 참조할 수 있고, PK 컬럼은 FK 컬럼 행의 REFERENCED_COLUMN이다.
    Json out = Json::array();
    auto rule_code = [](const std::string& rule) -> long long {
        if (rule == "CASCADE") return SQL_CASCADE;
        if (rule == "SET NULL") return SQL_SET_NULL;
        if (rule == "RESTRICT") return SQL_RESTRICT;
        return SQL_NO_ACTION;
    };
    for (const auto& row : constraints) {
        if (row.size() < 7) continue;
        if (json_string(row[3]) != "FOREIGN KEY") continue;
        const std::string fk_schem = json_string(row[0]);
        const std::string fk_name = json_string(row[1]);
        const std::string fk_tname = json_string(row[2]);
        const std::string ref_table = json_is_null(row[4]) ? "" : json_string(row[4]);
        const std::string delete_rule = json_is_null(row[5]) ? "NO ACTION" : json_string(row[5]);
        const std::string update_rule = json_is_null(row[6]) ? "NO ACTION" : json_string(row[6]);
        const std::string pk_schem = fk_schem;
        const std::string pk_tname = ref_table;
        if (!matches_ordinary(pk_schem, pk_schema, metadata_id)) continue;
        if (!matches_ordinary(pk_tname, pk_table, metadata_id)) continue;
        if (!matches_ordinary(fk_schem, fk_schema, metadata_id)) continue;
        if (!matches_ordinary(fk_tname, fk_table, metadata_id)) continue;
        // 이 FK의 컬럼 목록을 순서대로 찾는다.
        std::vector<Json> parts;
        for (const auto& crow : constraint_columns) {
            if (crow.size() < 5) continue;
            if (json_string(crow[0]) != fk_schem || json_string(crow[1]) != fk_name) continue;
            parts.push_back(crow);
        }
        std::sort(parts.begin(), parts.end(), [](const Json& a, const Json& b) { return json_integer(a[2]) < json_integer(b[2]); });
        // PK 이름은 참조 테이블의 PRIMARY KEY 제약조건 이름이다.
        std::string pk_name;
        for (const auto& prow : constraints) {
            if (json_string(prow[3]) != "PRIMARY KEY") continue;
            if (json_string(prow[0]) != pk_schem || json_string(prow[2]) != pk_tname) continue;
            pk_name = json_string(prow[1]);
            break;
        }
        for (const auto& part : parts) {
            const long long seq = json_integer(part[2]);
            const std::string fk_col = json_string(part[3]);
            const std::string pk_col = json_is_null(part[4]) ? "" : json_string(part[4]);
            out.push_back(Json::array({nullptr, pk_schem, pk_tname, pk_col,
                nullptr, fk_schem, fk_tname, fk_col,
                seq, rule_code(update_rule), rule_code(delete_rule),
                fk_name, pk_name.empty() ? Json(nullptr) : Json(pk_name),
                static_cast<long long>(SQL_NOT_DEFERRABLE)}));
        }
    }
    std::sort(out.begin(), out.end(), [](const Json& a, const Json& b) {
        for (int i : {1, 2, 5, 6, 8}) {
            std::string av = a[i].is_string() ? a[i].get<std::string>() : "";
            std::string bv = b[i].is_string() ? b[i].get<std::string>() : "";
            if (av != bv) return av < bv;
            long long an = a[i].is_number() ? a[i].get<long long>() : 0;
            long long bn = b[i].is_number() ? b[i].get<long long>() : 0;
            if (an != bn) return an < bn;
        }
        return false;
    });
    set_catalog_result(statement, std::move(cols), std::move(out));
}

void catalog_table_privileges_impl(Statement& statement,
    std::optional<std::string> catalog, std::optional<std::string> schema, std::optional<std::string> table) {
    std::vector<SqlType> cols{
        make_catalog_varchar("TABLE_CAT", 128, SQL_NULLABLE),
        make_catalog_varchar("TABLE_SCHEM", 128, SQL_NULLABLE),
        make_catalog_varchar("TABLE_NAME", 128, SQL_NO_NULLS),
        make_catalog_varchar("GRANTOR", 128, SQL_NULLABLE),
        make_catalog_varchar("GRANTEE", 128, SQL_NO_NULLS),
        make_catalog_varchar("PRIVILEGE", 128, SQL_NO_NULLS),
        make_catalog_varchar("IS_GRANTABLE", 3, SQL_NO_NULLS)};
    if (!no_catalog_filter(catalog)) { set_catalog_result(statement, std::move(cols), Json::array()); return; }
    const bool metadata_id = effective_metadata_id(statement);
    auto& connection = static_cast<Connection&>(*statement.parent);
    auto rows = fetch_all_rows(connection, "SELECT GRANTEE, TABLESPACE_NAME, OBJECT_NAME, PRIVILEGE FROM SYSTEM.SYS_PRIVILEGES");
    Json out = Json::array();
    for (const auto& row : rows) {
        if (row.size() < 4) continue;
        const std::string grantee = json_string(row[0]);
        const std::string schem = json_is_null(row[1]) ? "" : json_string(row[1]);
        const bool tablespace_level = json_is_null(row[2]);
        const std::string oname = tablespace_level ? "" : json_string(row[2]);
        const std::string priv = json_string(row[3]);
        // 테이블스페이스 수준 권한은 그 안의 모든 테이블에 적용되지만 목록에서는
        // OBJECT_NAME이 있는 행만 테이블 권한으로 낸다. 테이블스페이스 수준은
        // 스키마 필터가 맞으면 TABLES 수준 권한으로 펼치지 않고 제외한다.
        // (OFFICER/DBA 등의 포괄 권한은 SYS_PRIVILEGES에 개별 행이 없으므로 여기서도 안 보인다.)
        if (tablespace_level) continue;
        if (!matches_filter(schem, schema, metadata_id)) continue;
        if (!matches_filter(oname, table, metadata_id)) continue;
        out.push_back(Json::array({nullptr, schem, oname, nullptr, grantee, priv, "NO"}));
    }
    std::sort(out.begin(), out.end(), [](const Json& a, const Json& b) {
        for (int i : {1, 2, 4, 5}) {
            const std::string av = a[i].get<std::string>(), bv = b[i].get<std::string>();
            if (av != bv) return av < bv;
        }
        return false;
    });
    set_catalog_result(statement, std::move(cols), std::move(out));
}

void catalog_empty_impl(Statement& statement, std::vector<SqlType> columns) {
    set_catalog_result(statement, std::move(columns), Json::array());
}

void catalog_type_info_impl(Statement& statement, SQLSMALLINT data_type) {
    if (data_type != SQL_ALL_TYPES && (data_type < SQL_CHAR || data_type > SQL_INTERVAL_MINUTE_TO_SECOND) &&
        data_type != SQL_UNKNOWN_TYPE && data_type != SQL_DECIMAL && data_type != SQL_NUMERIC) {
        // 정의되지 않은 SQL 타입은 HY004이다. 미지원이 아니라 잘못된 값이다.
        bool known = data_type == SQL_WCHAR || data_type == SQL_WVARCHAR || data_type == SQL_BINARY ||
            data_type == SQL_VARBINARY || data_type == SQL_SMALLINT || data_type == SQL_INTEGER ||
            data_type == SQL_BIGINT || data_type == SQL_REAL || data_type == SQL_DOUBLE ||
            data_type == SQL_BIT || data_type == SQL_TYPE_DATE || data_type == SQL_TYPE_TIME ||
            data_type == SQL_TYPE_TIMESTAMP;
        if (!known) throw DriverError("HY004", "Invalid SQL data type for SQLGetTypeInfo.");
    }
    struct Row { std::string name; SQLSMALLINT sql; SQLULEN size; std::string prefix; std::string suffix; std::string params; SQLSMALLINT nullable; SQLSMALLINT sensitive; SQLSMALLINT searchable; SQLSMALLINT unsigned_attr; SQLSMALLINT fixed; SQLSMALLINT auto_unique; std::string local; SQLSMALLINT min_scale; SQLSMALLINT max_scale; SQLSMALLINT sql_data; SQLSMALLINT sub; SQLINTEGER radix; SQLSMALLINT interval_precision; };
    const std::vector<Row> all{
        {"CHAR", SQL_WCHAR, 2000, "'", "'", "length", SQL_NULLABLE, SQL_TRUE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "CHAR", 0, 0, SQL_WCHAR, 0, 0, 0},
        {"VARCHAR", SQL_WVARCHAR, 65535, "'", "'", "length", SQL_NULLABLE, SQL_TRUE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "VARCHAR", 0, 0, SQL_WVARCHAR, 0, 0, 0},
        {"BINARY", SQL_BINARY, 2000, "X'", "'", "length", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "BINARY", 0, 0, SQL_BINARY, 0, 0, 0},
        {"VARBINARY", SQL_VARBINARY, 65535, "X'", "'", "length", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "VARBINARY", 0, 0, SQL_VARBINARY, 0, 0, 0},
        {"SMALLINT", SQL_SMALLINT, 5, "", "", "", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "SMALLINT", 0, 0, SQL_SMALLINT, 0, 10, 0},
        {"INTEGER", SQL_INTEGER, 10, "", "", "", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "INTEGER", 0, 0, SQL_INTEGER, 0, 10, 0},
        {"BIGINT", SQL_BIGINT, 19, "", "", "", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "BIGINT", 0, 0, SQL_BIGINT, 0, 10, 0},
        {"DECIMAL", SQL_DECIMAL, 38, "", "", "precision,scale", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "DECIMAL", 0, 38, SQL_DECIMAL, 0, 10, 0},
        {"NUMERIC", SQL_NUMERIC, 38, "", "", "precision,scale", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "NUMERIC", 0, 38, SQL_NUMERIC, 0, 10, 0},
        {"REAL", SQL_REAL, 7, "", "", "", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "REAL", 0, 0, SQL_REAL, 0, 2, 0},
        {"DOUBLE PRECISION", SQL_DOUBLE, 15, "", "", "", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "DOUBLE PRECISION", 0, 0, SQL_DOUBLE, 0, 2, 0},
        {"BOOLEAN", SQL_BIT, 1, "", "", "", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "BOOLEAN", 0, 0, SQL_BIT, 0, 0, 0},
        {"DATE", SQL_TYPE_DATE, 10, "'", "'", "", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "DATE", 0, 0, SQL_DATETIME, SQL_CODE_DATE, 0, 0},
        {"TIME", SQL_TYPE_TIME, 15, "'", "'", "fractional precision", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "TIME", 0, 6, SQL_DATETIME, SQL_CODE_TIME, 0, 0},
        {"TIMESTAMP", SQL_TYPE_TIMESTAMP, 32, "'", "'", "fractional precision", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "TIMESTAMP", 0, 6, SQL_DATETIME, SQL_CODE_TIMESTAMP, 0, 0},
        {"TIME WITH TIME ZONE", SQL_WVARCHAR, 21, "'", "'", "fractional precision", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "TIME WITH TIME ZONE", 0, 6, SQL_WVARCHAR, 0, 0, 0},
        {"TIMESTAMP WITH TIME ZONE", SQL_WVARCHAR, 38, "'", "'", "fractional precision", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "TIMESTAMP WITH TIME ZONE", 0, 6, SQL_WVARCHAR, 0, 0, 0},
        {"INTERVAL YEAR", SQL_INTERVAL_YEAR, 11, "'", "'", "leading precision", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "INTERVAL YEAR", 0, 0, SQL_INTERVAL, SQL_CODE_YEAR, 0, 2},
        {"INTERVAL MONTH", SQL_INTERVAL_MONTH, 11, "'", "'", "leading precision", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "INTERVAL MONTH", 0, 0, SQL_INTERVAL, SQL_CODE_MONTH, 0, 2},
        {"INTERVAL DAY", SQL_INTERVAL_DAY, 11, "'", "'", "leading precision", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "INTERVAL DAY", 0, 0, SQL_INTERVAL, SQL_CODE_DAY, 0, 2},
        {"INTERVAL HOUR", SQL_INTERVAL_HOUR, 11, "'", "'", "leading precision", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "INTERVAL HOUR", 0, 0, SQL_INTERVAL, SQL_CODE_HOUR, 0, 2},
        {"INTERVAL MINUTE", SQL_INTERVAL_MINUTE, 11, "'", "'", "leading precision", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "INTERVAL MINUTE", 0, 0, SQL_INTERVAL, SQL_CODE_MINUTE, 0, 2},
        {"INTERVAL SECOND", SQL_INTERVAL_SECOND, 18, "'", "'", "leading, fractional", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "INTERVAL SECOND", 0, 6, SQL_INTERVAL, SQL_CODE_SECOND, 0, 2},
        {"INTERVAL YEAR TO MONTH", SQL_INTERVAL_YEAR_TO_MONTH, 14, "'", "'", "leading precision", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "INTERVAL YEAR TO MONTH", 0, 0, SQL_INTERVAL, SQL_CODE_YEAR_TO_MONTH, 0, 2},
        {"INTERVAL DAY TO HOUR", SQL_INTERVAL_DAY_TO_HOUR, 17, "'", "'", "leading precision", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "INTERVAL DAY TO HOUR", 0, 0, SQL_INTERVAL, SQL_CODE_DAY_TO_HOUR, 0, 2},
        {"INTERVAL DAY TO MINUTE", SQL_INTERVAL_DAY_TO_MINUTE, 20, "'", "'", "leading precision", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "INTERVAL DAY TO MINUTE", 0, 0, SQL_INTERVAL, SQL_CODE_DAY_TO_MINUTE, 0, 2},
        {"INTERVAL DAY TO SECOND", SQL_INTERVAL_DAY_TO_SECOND, 27, "'", "'", "leading, fractional", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "INTERVAL DAY TO SECOND", 0, 6, SQL_INTERVAL, SQL_CODE_DAY_TO_SECOND, 0, 2},
        {"INTERVAL HOUR TO MINUTE", SQL_INTERVAL_HOUR_TO_MINUTE, 14, "'", "'", "leading precision", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "INTERVAL HOUR TO MINUTE", 0, 0, SQL_INTERVAL, SQL_CODE_HOUR_TO_MINUTE, 0, 2},
        {"INTERVAL HOUR TO SECOND", SQL_INTERVAL_HOUR_TO_SECOND, 21, "'", "'", "leading, fractional", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "INTERVAL HOUR TO SECOND", 0, 6, SQL_INTERVAL, SQL_CODE_HOUR_TO_SECOND, 0, 2},
        {"INTERVAL MINUTE TO SECOND", SQL_INTERVAL_MINUTE_TO_SECOND, 18, "'", "'", "leading, fractional", SQL_NULLABLE, SQL_FALSE, SQL_SEARCHABLE, SQL_FALSE, SQL_FALSE, SQL_FALSE, "INTERVAL MINUTE TO SECOND", 0, 6, SQL_INTERVAL, SQL_CODE_MINUTE_TO_SECOND, 0, 2},
    };
    Json out = Json::array();
    for (const auto& row : all) {
        if (data_type != SQL_ALL_TYPES && data_type != row.sql) continue;
        Json prefix = row.prefix.empty() ? Json(nullptr) : Json(row.prefix);
        Json suffix = row.suffix.empty() ? Json(nullptr) : Json(row.suffix);
        Json params = row.params.empty() ? Json(nullptr) : Json(row.params);
        out.push_back(Json::array({row.name, static_cast<long long>(row.sql),
            static_cast<long long>(row.size), prefix, suffix, params,
            static_cast<long long>(row.nullable), static_cast<long long>(row.sensitive),
            static_cast<long long>(row.searchable), static_cast<long long>(row.unsigned_attr),
            static_cast<long long>(row.fixed), static_cast<long long>(row.auto_unique),
            row.local, static_cast<long long>(row.min_scale), static_cast<long long>(row.max_scale),
            static_cast<long long>(row.sql_data), static_cast<long long>(row.sub),
            static_cast<long long>(row.radix), static_cast<long long>(row.interval_precision)}));
    }
    std::vector<SqlType> cols{
        make_catalog_varchar("TYPE_NAME", 128, SQL_NO_NULLS),
        make_catalog_smallint("DATA_TYPE", SQL_NO_NULLS),
        make_catalog_integer("COLUMN_SIZE", SQL_NULLABLE),
        make_catalog_varchar("LITERAL_PREFIX", 128, SQL_NULLABLE),
        make_catalog_varchar("LITERAL_SUFFIX", 128, SQL_NULLABLE),
        make_catalog_varchar("CREATE_PARAMS", 128, SQL_NULLABLE),
        make_catalog_smallint("NULLABLE", SQL_NO_NULLS),
        make_catalog_smallint("CASE_SENSITIVE", SQL_NO_NULLS),
        make_catalog_smallint("SEARCHABLE", SQL_NO_NULLS),
        make_catalog_smallint("UNSIGNED_ATTRIBUTE", SQL_NULLABLE),
        make_catalog_smallint("FIXED_PREC_SCALE", SQL_NO_NULLS),
        make_catalog_smallint("AUTO_UNIQUE_VALUE", SQL_NULLABLE),
        make_catalog_varchar("LOCAL_TYPE_NAME", 128, SQL_NULLABLE),
        make_catalog_smallint("MINIMUM_SCALE", SQL_NULLABLE),
        make_catalog_smallint("MAXIMUM_SCALE", SQL_NULLABLE),
        make_catalog_smallint("SQL_DATA_TYPE", SQL_NO_NULLS),
        make_catalog_smallint("SQL_DATETIME_SUB", SQL_NULLABLE),
        make_catalog_integer("NUM_PREC_RADIX", SQL_NULLABLE),
        make_catalog_smallint("INTERVAL_PRECISION", SQL_NULLABLE)};
    set_catalog_result(statement, std::move(cols), std::move(out));
}
} // namespace hwdbodbc
