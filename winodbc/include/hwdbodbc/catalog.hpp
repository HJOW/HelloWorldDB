#pragma once
#include "hwdbodbc/handles.hpp"
#include <optional>
#include <string>
#include <vector>

namespace hwdbodbc {
// 카탈로그 결과의 컬럼 정의와 행을 STMT에 올린다. 서버 커서 없이 로컬 결과이다.
void set_catalog_result(Statement& statement, std::vector<SqlType> columns, Json rows);
// METADATA_ID가 참일 때의 식별자 비교. 따옴표 없는 식별자는 대문자로 접고, 큰따옴표 식별자는 그대로 비교한다.
bool catalog_identifier_equals(const std::string& value, const std::string& argument);
// 패턴이 아닌 일반 인자의 비교. 거짓이면 %, _ 도 문자 그대로 두고 대소문자까지 정확히 같아야 하며, 참이면 식별자 규칙이다.
bool catalog_ordinary_match(const std::string& value, const std::string& argument, bool metadata_id);
// 패턴 일치. metadata_id가 참이면 식별자 비교, 거짓이면 % _ 와일드카드이다.
bool catalog_match(const std::string& value, const std::string& pattern, bool metadata_id, char escape = '\\');
// NULL 포인터 인자를 허용하는 카탈로그 문자열 읽기. NULL이면 nullopt이다.
std::optional<std::string> catalog_string_input(const void* pointer, SQLINTEGER length, bool wide);
// 서버 딕셔너리 조회를 모두 가져온다.
Json fetch_all_rows(Connection& connection, const std::string& sql);
// DECLARE 문자열을 해석해 ODBC 카탈로그에 필요한 정보를 만든다.
struct ParsedDeclared {
    std::string base;
    bool with_time_zone = false;
    std::string start_field;
    std::string end_field;
    long long length = 0;
    long long precision = 0;
    long long scale = 0;
    long long fractional = 0;
    long long leading = 2;
    // TIME/TIMESTAMP에 소수 초 자릿수가 명시되었는지. 0으로 명시한 TIMESTAMP(0)과 생략(기본 6)을 구분한다.
    bool has_fractional = false;
    bool has_length = false;
    bool has_precision = false;
    bool has_scale = false;
};
ParsedDeclared parse_declared_type(const std::string& declared);
struct CatalogTypeInfo {
    SQLSMALLINT sql_type = SQL_UNKNOWN_TYPE;
    std::string type_name;
    SQLULEN column_size = 0;
    SQLLEN buffer_length = 0;
    SQLSMALLINT decimal_digits = 0;
    bool decimal_nullable = true;
    SQLSMALLINT radix = 0;
    bool radix_nullable = true;
    SQLSMALLINT nullable = SQL_NULLABLE;
    SQLSMALLINT interval_code = 0;
    SQLINTEGER leading_precision = 0;
    bool leading_nullable = true;
};
CatalogTypeInfo catalog_type_info(const std::string& declared);
SqlType make_catalog_varchar(const std::string& name, SQLULEN length, SQLSMALLINT nullable);
SqlType make_catalog_smallint(const std::string& name, SQLSMALLINT nullable);
SqlType make_catalog_integer(const std::string& name, SQLSMALLINT nullable);
void catalog_tables_impl(Statement& statement,
    std::optional<std::string> catalog, std::optional<std::string> schema,
    std::optional<std::string> table, std::optional<std::string> type);
void catalog_columns_impl(Statement& statement,
    std::optional<std::string> catalog, std::optional<std::string> schema,
    std::optional<std::string> table, std::optional<std::string> column);
void catalog_statistics_impl(Statement& statement,
    std::optional<std::string> catalog, std::optional<std::string> schema,
    std::optional<std::string> table, SQLUSMALLINT unique, SQLUSMALLINT reserved);
void catalog_special_columns_impl(Statement& statement, SQLUSMALLINT identifier,
    std::optional<std::string> catalog, std::optional<std::string> schema,
    std::optional<std::string> table, SQLUSMALLINT scope, SQLUSMALLINT nullable);
void catalog_primary_keys_impl(Statement& statement,
    std::optional<std::string> catalog, std::optional<std::string> schema, std::optional<std::string> table);
void catalog_foreign_keys_impl(Statement& statement,
    std::optional<std::string> pk_catalog, std::optional<std::string> pk_schema, std::optional<std::string> pk_table,
    std::optional<std::string> fk_catalog, std::optional<std::string> fk_schema, std::optional<std::string> fk_table);
void catalog_table_privileges_impl(Statement& statement,
    std::optional<std::string> catalog, std::optional<std::string> schema, std::optional<std::string> table);
void catalog_empty_impl(Statement& statement, std::vector<SqlType> columns);
void catalog_type_info_impl(Statement& statement, SQLSMALLINT data_type);
}
