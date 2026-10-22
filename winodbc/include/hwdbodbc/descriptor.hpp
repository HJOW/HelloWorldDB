#pragma once
#include "hwdbodbc/statement.hpp"

namespace hwdbodbc {
void check_descriptor_mutation(const Descriptor& descriptor);
SQLSMALLINT descriptor_general_type(SQLSMALLINT concise);
SQLSMALLINT descriptor_subtype(SQLSMALLINT concise);
void descriptor_concise_type(DescriptorRecord& record, SQLSMALLINT type, bool application);
void descriptor_sql_metadata(DescriptorRecord& record, const SqlType& metadata);
SqlType descriptor_parameter_type(const DescriptorRecord& record);
void descriptor_changed(Descriptor& descriptor);
void descriptor_read_metadata(Descriptor& descriptor);
void associate_descriptor(Statement& statement, std::size_t index, SQLHDESC id);
void validate_descriptor_record(const DescriptorRecord& record, bool application);
DescriptorRecord binding_record(const Descriptor& descriptor, const DescriptorRecord& record, SQLULEN row, SQLSMALLINT default_c);
void validate_array_address(SQLPOINTER pointer, SQLULEN count, std::size_t width);
}
