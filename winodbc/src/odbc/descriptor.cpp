#include "hwdbodbc/descriptor.hpp"
#include "hwdbodbc/parameters.hpp"
#include <cstring>

namespace hwdbodbc {
SQLSMALLINT descriptor_subtype(SQLSMALLINT concise) {
    if (concise >= SQL_INTERVAL_YEAR && concise <= SQL_INTERVAL_MINUTE_TO_SECOND) return static_cast<SQLSMALLINT>(concise - 100);
    if (concise == SQL_TYPE_DATE || concise == SQL_C_DATE) return SQL_CODE_DATE;
    if (concise == SQL_TYPE_TIME || concise == SQL_C_TIME) return SQL_CODE_TIME;
    if (concise == SQL_TYPE_TIMESTAMP || concise == SQL_C_TIMESTAMP) return SQL_CODE_TIMESTAMP;
    return 0;
}
SQLSMALLINT descriptor_general_type(SQLSMALLINT concise) {
    if (concise >= SQL_INTERVAL_YEAR && concise <= SQL_INTERVAL_MINUTE_TO_SECOND) return SQL_INTERVAL;
    return descriptor_subtype(concise) ? SQL_DATETIME : concise;
}
void descriptor_sql_metadata(DescriptorRecord& record, const SqlType& metadata) {
    record.metadata = metadata; record.type = metadata.sql_type; record.length = metadata.size;
    record.capacity = metadata.octets;
    record.conversion.precision = static_cast<SQLSMALLINT>(metadata.interval_code || metadata.sql_type == SQL_TYPE_TIMESTAMP || metadata.sql_type == SQL_TYPE_TIME
        ? metadata.scale : metadata.sql_type == SQL_REAL ? 24 : metadata.sql_type == SQL_DOUBLE ? 53
        : metadata.sql_type == SQL_SMALLINT || metadata.sql_type == SQL_INTEGER || metadata.sql_type == SQL_BIGINT || metadata.sql_type == SQL_DECIMAL || metadata.sql_type == SQL_NUMERIC ? metadata.size : 0);
    record.conversion.scale = metadata.interval_code || metadata.sql_type == SQL_TYPE_TIMESTAMP || metadata.sql_type == SQL_TYPE_TIME ? 0 : metadata.scale;
    record.conversion.fractional_precision = metadata.scale; record.conversion.leading_precision = metadata.leading_precision;
    record.unnamed = metadata.name.empty() ? SQL_UNNAMED : SQL_NAMED;
    record.radix = metadata.sql_type == SQL_REAL || metadata.sql_type == SQL_DOUBLE ? 2
        : metadata.sql_type == SQL_SMALLINT || metadata.sql_type == SQL_INTEGER || metadata.sql_type == SQL_BIGINT || metadata.sql_type == SQL_DECIMAL || metadata.sql_type == SQL_NUMERIC ? 10 : 0;
}
void descriptor_concise_type(DescriptorRecord& record, SQLSMALLINT type, bool application) {
    if (type == SQL_C_DATE) type = SQL_TYPE_DATE;
    else if (type == SQL_C_TIME) type = SQL_TYPE_TIME;
    else if (type == SQL_C_TIMESTAMP) type = SQL_TYPE_TIMESTAMP;
    if (application) {
        if (!valid_c_type(type)) throw DriverError("HY021", "Invalid application descriptor data type.");
        record.type = type; record.length = 0; record.radix = 0; record.conversion = {};
        if (type == SQL_C_FLOAT || type == SQL_C_DOUBLE) { record.conversion.precision = type == SQL_C_FLOAT ? 24 : 53; record.radix = 2; }
        else if (type == SQL_C_NUMERIC) record.radix = 10;
        else if (type == SQL_C_TINYINT || type == SQL_C_STINYINT || type == SQL_C_UTINYINT) { record.conversion.precision = 3; record.radix = 10; }
        else if (type == SQL_C_SHORT || type == SQL_C_SSHORT || type == SQL_C_USHORT) { record.conversion.precision = 5; record.radix = 10; }
        else if (type == SQL_C_LONG || type == SQL_C_SLONG || type == SQL_C_ULONG) { record.conversion.precision = 10; record.radix = 10; }
        else if (type == SQL_C_SBIGINT || type == SQL_C_UBIGINT) { record.conversion.precision = type == SQL_C_SBIGINT ? 19 : 20; record.radix = 10; }
        else if (type >= SQL_C_INTERVAL_YEAR && type <= SQL_C_INTERVAL_MINUTE_TO_SECOND) record.conversion.precision = 6;
        else if (type == SQL_C_TYPE_TIMESTAMP) record.conversion.precision = 6;
        else record.conversion.precision = 0;
    } else {
        const auto metadata = parameter_type(type, type == SQL_NUMERIC || type == SQL_DECIMAL ? 38 : 0, 0);
        const auto name = record.metadata.name;
        descriptor_sql_metadata(record, metadata); record.type = type; record.metadata.name = name; record.unnamed = name.empty() ? SQL_UNNAMED : SQL_NAMED;
    }
}
SqlType descriptor_parameter_type(const DescriptorRecord& record) {
    const bool numeric = record.type == SQL_NUMERIC || record.type == SQL_DECIMAL;
    const bool fractional = record.type == SQL_TYPE_TIME || record.type == SQL_TYPE_TIMESTAMP || (record.type >= SQL_INTERVAL_YEAR && record.type <= SQL_INTERVAL_MINUTE_TO_SECOND);
    auto result = parameter_type(record.type, numeric ? static_cast<SQLULEN>(record.conversion.precision) : record.length,
        fractional ? record.conversion.precision : record.conversion.scale, record.conversion.leading_precision);
    result.name = record.metadata.name; result.nullable = record.metadata.nullable; return result;
}
void validate_descriptor_record(const DescriptorRecord& record, bool application) {
    if (!application) { static_cast<void>(descriptor_parameter_type(record)); return; }
    if (!valid_c_type(record.type)) throw DriverError("HY021", "Invalid application descriptor data type.");
    if (record.capacity < 0) throw DriverError("HY021", "Descriptor octet length cannot be negative.");
    if (record.type == SQL_C_NUMERIC && (record.conversion.precision < 1 || record.conversion.precision > 38 || record.conversion.scale < -128 || record.conversion.scale > 127))
        throw DriverError("HY021", "Invalid application numeric precision or scale.");
    if (record.type >= SQL_C_INTERVAL_YEAR && record.type <= SQL_C_INTERVAL_MINUTE_TO_SECOND) {
        if (record.conversion.leading_precision < 1 || record.conversion.leading_precision > 9 || record.conversion.precision < 0 || record.conversion.precision > 6)
            throw DriverError("HY021", "Invalid application interval precision.");
    }
}
void descriptor_changed(Descriptor& descriptor) {
    for (const auto& statement : connection_statements(static_cast<Connection&>(*descriptor.parent)))
        if (statement->descriptors[1].get() == &descriptor || statement->descriptors[3].get() == &descriptor) statement->parameter_metadata_dirty = true;
}
void descriptor_read_metadata(Descriptor& descriptor) {
    if (descriptor.role != DescriptorRole::row) return;
    const auto statement = descriptor.owner.lock();
    if (!statement || (!statement->prepared && !statement->executed)) throw DriverError("HY007", "No SQL statement has been prepared or executed.");
    if (statement->prepared && !statement->executed) describe_prepared(*statement);
}
void associate_descriptor(Statement& statement, std::size_t index, SQLHDESC id) {
    if (index > 1) throw DriverError("HY017", "Implementation descriptors cannot be associated explicitly.");
    if (!id) statement.descriptors[index] = statement.automatic_descriptors[index];
    else {
        const auto handle = find_handle(SQL_HANDLE_DESC, id);
        if (!handle) throw DriverError("HY024", "Invalid descriptor handle.");
        auto descriptor = std::static_pointer_cast<Descriptor>(handle);
        if (descriptor->parent != statement.parent || !descriptor->alive) throw DriverError("HY024", "Descriptor belongs to another connection.");
        if (descriptor->automatic && descriptor != statement.automatic_descriptors[index])
            throw DriverError("HY017", "An automatic descriptor can only restore its original association.");
        statement.descriptors[index] = std::move(descriptor);
    }
    statement.parameter_metadata_dirty = true;
}
namespace {
SQLPOINTER binding_address(SQLPOINTER pointer, SQLULEN stride, SQLULEN row, SQLLEN offset) {
    if (!pointer) return nullptr;
    const auto maximum = (std::numeric_limits<std::uintptr_t>::max)();
    if (row && stride > maximum / row) throw DriverError("HY090", "Binding stride multiplication overflow.");
    const auto delta = stride * row;
    auto address = reinterpret_cast<std::uintptr_t>(pointer);
    if (offset < 0) {
        const auto magnitude = static_cast<SQLULEN>(-(offset + 1)) + 1;
        if (magnitude > address) throw DriverError("HY090", "Binding offset underflow.");
        address -= magnitude;
    } else {
        if (static_cast<SQLULEN>(offset) > maximum - address) throw DriverError("HY090", "Binding offset overflow.");
        address += static_cast<SQLULEN>(offset);
    }
    if (delta > maximum - address) throw DriverError("HY090", "Binding address overflow.");
    return reinterpret_cast<SQLPOINTER>(address + delta);
}
}
DescriptorRecord binding_record(const Descriptor& descriptor, const DescriptorRecord& record, SQLULEN row, SQLSMALLINT default_c) {
    DescriptorRecord result = record;
    SQLLEN offset = 0; if (descriptor.bind_offset) std::memcpy(&offset, descriptor.bind_offset, sizeof(offset));
    const auto type = record.type == SQL_C_DEFAULT ? default_c : record.type;
    const auto fixed = fixed_c_size(type);
    if (!fixed && record.capacity < 0) throw DriverError("HY090", "Invalid variable binding size.");
    const auto data_stride = descriptor.bind_type ? descriptor.bind_type : fixed ? static_cast<SQLULEN>(fixed) : static_cast<SQLULEN>(record.capacity);
    const auto indicator_stride = descriptor.bind_type ? descriptor.bind_type : static_cast<SQLULEN>(sizeof(SQLLEN));
    result.data = binding_address(record.data, data_stride, row, offset);
    result.indicator = static_cast<SQLLEN*>(binding_address(record.indicator, indicator_stride, row, offset));
    result.octet_length_pointer = static_cast<SQLLEN*>(binding_address(record.octet_length_pointer, indicator_stride, row, offset));
    result.conversion.fractional_precision = record.conversion.precision;
    return result;
}
void validate_array_address(SQLPOINTER pointer, SQLULEN count, std::size_t width) {
    if (!pointer || !count) return;
    const auto address = reinterpret_cast<std::uintptr_t>(pointer), maximum = (std::numeric_limits<std::uintptr_t>::max)();
    if (count > maximum / width || count * width - 1 > maximum - address) throw DriverError("HY090", "Array pointer range overflows the address space.");
}
} // namespace hwdbodbc
