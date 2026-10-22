#include "hwdbodbc/descriptor.hpp"
#include <cstring>

using namespace hwdbodbc;
namespace {
template<class Character>
SQLRETURN get_field(SQLHDESC handle, SQLSMALLINT number, SQLSMALLINT field, SQLPOINTER output, SQLINTEGER capacity, SQLINTEGER* length) {
    return with_handle<Descriptor>(SQL_HANDLE_DESC,handle,true,[&](Descriptor& descriptor) -> SQLRETURN {
        const bool application = descriptor.role == DescriptorRole::application;
        const auto put = [&](auto value) -> SQLRETURN {
            if (output) std::memcpy(output,&value,sizeof(value));
            if (length) *length = static_cast<SQLINTEGER>(sizeof(value)); return SQL_SUCCESS;
        };
        switch (field) {
        case SQL_DESC_ALLOC_TYPE: return put(static_cast<SQLSMALLINT>(descriptor.automatic ? SQL_DESC_ALLOC_AUTO : SQL_DESC_ALLOC_USER));
        case SQL_DESC_ARRAY_SIZE: if (application) return put(descriptor.array_size); break;
        case SQL_DESC_BIND_TYPE: if (application) return put(static_cast<SQLUINTEGER>(descriptor.bind_type)); break;
        case SQL_DESC_BIND_OFFSET_PTR: if (application) return put(descriptor.bind_offset); break;
        case SQL_DESC_ARRAY_STATUS_PTR: return put(descriptor.array_status);
        case SQL_DESC_ROWS_PROCESSED_PTR: if (!application) return put(descriptor.rows_processed); break;
        case SQL_DESC_COUNT:
            descriptor_read_metadata(descriptor); return put(static_cast<SQLSMALLINT>(descriptor.records.size()));
        default: goto record;
        }
        throw DriverError("HY091","Descriptor header field is not defined for this descriptor.");
    record:
        descriptor_read_metadata(descriptor);
        if (number <= 0) throw DriverError("07009","Invalid descriptor record number.");
        if (static_cast<std::size_t>(number) > descriptor.records.size()) return SQL_NO_DATA;
        const auto& record = descriptor.records[number - 1]; const auto& metadata = record.metadata;
        const auto string = [&](const std::string& value) {
            if constexpr (sizeof(Character) == 2) { if (capacity % 2) throw DriverError("HY090","Wide descriptor buffer length must be even."); }
            const auto result = output_text(value,static_cast<Character*>(output),capacity,length,LengthUnit::bytes);
            if (result == SQL_SUCCESS_WITH_INFO) descriptor.diagnostic.append("01004","Descriptor field was truncated."); return result;
        };
        switch (field) {
        case SQL_DESC_CONCISE_TYPE: return put(record.type);
        case SQL_DESC_TYPE: return put(descriptor_general_type(record.type));
        case SQL_DESC_DATETIME_INTERVAL_CODE: return put(descriptor_subtype(record.type));
        case SQL_DESC_DATETIME_INTERVAL_PRECISION: return put(record.conversion.leading_precision);
        case SQL_DESC_LENGTH: return put(record.length);
        case SQL_DESC_OCTET_LENGTH: return put(record.capacity);
        case SQL_DESC_PRECISION: return put(record.conversion.precision);
        case SQL_DESC_SCALE: return put(record.conversion.scale);
        case SQL_DESC_NUM_PREC_RADIX: return put(record.radix);
        case SQL_DESC_DATA_PTR: if (application) return put(record.data); break;
        case SQL_DESC_INDICATOR_PTR: if (application) return put(record.indicator); break;
        case SQL_DESC_OCTET_LENGTH_PTR: if (application) return put(record.octet_length_pointer); break;
        case SQL_DESC_PARAMETER_TYPE: if (descriptor.role == DescriptorRole::parameter) return put(record.parameter_type); break;
        case SQL_DESC_NAME: if (!application) return string(metadata.name); break;
        case SQL_DESC_UNNAMED: if (!application) return put(record.unnamed); break;
        case SQL_DESC_NULLABLE: if (!application) return put(descriptor.role == DescriptorRole::parameter ? static_cast<SQLSMALLINT>(SQL_NULLABLE) : metadata.nullable); break;
        case SQL_DESC_UNSIGNED: if (!application) return put(static_cast<SQLSMALLINT>(SQL_FALSE)); break;
        case SQL_DESC_TYPE_NAME: case SQL_DESC_LOCAL_TYPE_NAME: if (!application) return string(metadata.type_name); break;
        case SQL_DESC_CASE_SENSITIVE:
            if (!application) return put(static_cast<SQLINTEGER>(record.type == SQL_WCHAR || record.type == SQL_WVARCHAR)); break;
        case SQL_DESC_FIXED_PREC_SCALE: case SQL_DESC_ROWVER:
            if (!application) return put(static_cast<SQLSMALLINT>(SQL_FALSE)); break;
        default:
            if (descriptor.role != DescriptorRole::row) break;
            switch (field) {
            case SQL_DESC_LABEL: return string(metadata.name);
            case SQL_DESC_BASE_COLUMN_NAME: case SQL_DESC_BASE_TABLE_NAME: case SQL_DESC_CATALOG_NAME:
            case SQL_DESC_SCHEMA_NAME: case SQL_DESC_TABLE_NAME: return string("");
            case SQL_DESC_LITERAL_PREFIX: case SQL_DESC_LITERAL_SUFFIX:
                return string(record.type == SQL_WCHAR || record.type == SQL_WVARCHAR || descriptor_general_type(record.type) == SQL_DATETIME ? "'" : "");
            case SQL_DESC_AUTO_UNIQUE_VALUE: return put(static_cast<SQLINTEGER>(SQL_FALSE));
            case SQL_DESC_DISPLAY_SIZE: return put(metadata.display_size);
            case SQL_DESC_SEARCHABLE: return put(static_cast<SQLSMALLINT>(SQL_PRED_SEARCHABLE));
            case SQL_DESC_UPDATABLE: return put(static_cast<SQLSMALLINT>(SQL_ATTR_READONLY));
            default: break;
            }
        }
        throw DriverError("HY091","Descriptor field is not defined for this descriptor.");
    });
}
SQLSMALLINT small_value(SQLPOINTER input) {
    const auto value = reinterpret_cast<SQLLEN>(input);
    if (value < (std::numeric_limits<SQLSMALLINT>::min)() || value > (std::numeric_limits<SQLSMALLINT>::max)()) throw DriverError("HY021","Descriptor value exceeds SQLSMALLINT range.");
    return static_cast<SQLSMALLINT>(value);
}
SQLINTEGER integer_value(SQLPOINTER input) {
    const auto value = reinterpret_cast<SQLLEN>(input);
    if (value < (std::numeric_limits<SQLINTEGER>::min)() || value > (std::numeric_limits<SQLINTEGER>::max)()) throw DriverError("HY021","Descriptor value exceeds SQLINTEGER range.");
    return static_cast<SQLINTEGER>(value);
}
void set_type(DescriptorRecord& record, SQLSMALLINT value, SQLSMALLINT subtype, bool application) {
    if (value == SQL_DATETIME) {
        if (subtype < SQL_CODE_DATE || subtype > SQL_CODE_TIMESTAMP) throw DriverError("HY021","Invalid datetime subtype.");
        value = static_cast<SQLSMALLINT>(90 + subtype);
    } else if (value == SQL_INTERVAL) {
        if (subtype < SQL_CODE_YEAR || subtype > SQL_CODE_MINUTE_TO_SECOND) throw DriverError("HY021","Invalid interval subtype.");
        value = static_cast<SQLSMALLINT>(100 + subtype);
    }
    descriptor_concise_type(record,value,application);
}
void finish_field_change(Descriptor& descriptor, SQLSMALLINT number, DescriptorRecord record, bool check_consistency) {
    if (check_consistency) validate_descriptor_record(record,descriptor.role == DescriptorRole::application);
    if (descriptor.records.size() < static_cast<std::size_t>(number)) descriptor.records.resize(number);
    descriptor.records[number - 1] = std::move(record); descriptor_changed(descriptor);
}
template<class Character>
SQLRETURN set_field(SQLHDESC handle, SQLSMALLINT number, SQLSMALLINT field, SQLPOINTER input, SQLINTEGER length) {
    return with_handle<Descriptor>(SQL_HANDLE_DESC,handle,true,[&](Descriptor& descriptor) -> SQLRETURN {
        check_descriptor_mutation(descriptor);
        const bool application = descriptor.role == DescriptorRole::application;
        const auto value = reinterpret_cast<SQLULEN>(input);
        switch (field) {
        case SQL_DESC_ALLOC_TYPE: throw DriverError("HY091","Descriptor allocation type is read-only.");
        case SQL_DESC_ARRAY_STATUS_PTR: descriptor.array_status = static_cast<SQLUSMALLINT*>(input); return SQL_SUCCESS;
        case SQL_DESC_ROWS_PROCESSED_PTR:
            if (application) throw DriverError("HY091","Application descriptors have no processed-count pointer.");
            descriptor.rows_processed = static_cast<SQLULEN*>(input); return SQL_SUCCESS;
        case SQL_DESC_ARRAY_SIZE:
            if (!application) throw DriverError("HY091","Implementation descriptors have no array size.");
            if (!value || value > (std::numeric_limits<SQLULEN>::max)() / sizeof(SQLUSMALLINT)) throw DriverError("HY024","Invalid descriptor array size.");
            descriptor.array_size = value; return SQL_SUCCESS;
        case SQL_DESC_BIND_TYPE:
            if (!application) throw DriverError("HY091","Implementation descriptors have no binding type.");
            if (value > (std::numeric_limits<SQLUINTEGER>::max)()) throw DriverError("HY024","Binding type exceeds the descriptor SQLUINTEGER range.");
            descriptor.bind_type = value; return SQL_SUCCESS;
        case SQL_DESC_BIND_OFFSET_PTR:
            if (!application) throw DriverError("HY091","Implementation descriptors have no binding offset.");
            descriptor.bind_offset = static_cast<SQLLEN*>(input); return SQL_SUCCESS;
        case SQL_DESC_COUNT: {
            if (descriptor.role == DescriptorRole::row) throw DriverError("HY016","Implementation row metadata is read-only.");
            const auto count = small_value(input); if (count < 0) throw DriverError("HY021","Descriptor count cannot be negative.");
            descriptor.records.resize(static_cast<std::size_t>(count)); descriptor_changed(descriptor); return SQL_SUCCESS;
        }
        default: break;
        }
        if (descriptor.role == DescriptorRole::row) throw DriverError("HY016","Implementation row metadata is read-only.");
        if (number <= 0) throw DriverError("07009","Invalid descriptor record number.");
        DescriptorRecord record = static_cast<std::size_t>(number) <= descriptor.records.size() ? descriptor.records[number - 1] : DescriptorRecord{};
        bool consistency = false, unbind = false;
        switch (field) {
        case SQL_DESC_CONCISE_TYPE: descriptor_concise_type(record,small_value(input),application); unbind = true; break;
        case SQL_DESC_TYPE: {
            const auto type = small_value(input);
            const auto subtype = descriptor_general_type(record.type) == type ? descriptor_subtype(record.type) : static_cast<SQLSMALLINT>(1);
            set_type(record,type,subtype,application); unbind = true; break;
        }
        case SQL_DESC_DATETIME_INTERVAL_CODE:
            if (!descriptor_subtype(record.type)) throw DriverError("HY021","Data type has no datetime or interval subtype.");
            set_type(record,descriptor_general_type(record.type),small_value(input),application); unbind = true; break;
        case SQL_DESC_DATETIME_INTERVAL_PRECISION: record.conversion.leading_precision = integer_value(input); unbind = true; break;
        case SQL_DESC_LENGTH: record.length = value; unbind = true; break;
        case SQL_DESC_OCTET_LENGTH:
            record.capacity = reinterpret_cast<SQLLEN>(input); if (record.capacity < 0) throw DriverError("HY021","Octet length cannot be negative."); unbind = true; break;
        case SQL_DESC_PRECISION: record.conversion.precision = small_value(input); record.conversion.fractional_precision = record.conversion.precision; unbind = true; break;
        case SQL_DESC_SCALE: record.conversion.scale = small_value(input); unbind = true; break;
        case SQL_DESC_NUM_PREC_RADIX: record.radix = integer_value(input); unbind = true; break;
        case SQL_DESC_DATA_PTR:
            consistency = input != nullptr;
            if (application) { record.data = input; record.bound = input != nullptr; }
            break;
        case SQL_DESC_INDICATOR_PTR:
            if (!application) throw DriverError("HY091","Implementation parameters have no indicator pointer.");
            record.indicator = static_cast<SQLLEN*>(input); if (input) record.bound = true; break;
        case SQL_DESC_OCTET_LENGTH_PTR:
            if (!application) throw DriverError("HY091","Implementation parameters have no octet-length pointer.");
            record.octet_length_pointer = static_cast<SQLLEN*>(input); if (input) record.bound = true; break;
        case SQL_DESC_PARAMETER_TYPE:
            if (application) throw DriverError("HY091","Application descriptors have no parameter direction.");
            if (small_value(input) != SQL_PARAM_INPUT) throw DriverError("HYC00","Only input parameters are supported.");
            record.parameter_type = SQL_PARAM_INPUT; break;
        case SQL_DESC_NAME: {
            if (application) throw DriverError("HY091","Application descriptors have no name field.");
            auto units = length;
            if constexpr (sizeof(Character) == 2) { if (length >= 0 && length % 2) throw DriverError("HY090","Wide descriptor name length must be even."); if (length >= 0) units /= 2; }
            record.metadata.name = input_text(static_cast<Character*>(input),units); record.unnamed = SQL_NAMED; break;
        }
        case SQL_DESC_UNNAMED:
            if (application) throw DriverError("HY091","Application descriptors have no name field.");
            if (small_value(input) != SQL_UNNAMED) throw DriverError("HY024","Set a parameter name through SQL_DESC_NAME.");
            record.metadata.name.clear(); record.unnamed = SQL_UNNAMED; break;
        default: throw DriverError("HY091","Descriptor field is undefined or read-only.");
        }
        if (application && unbind) { record.data = nullptr; record.bound = false; }
        finish_field_change(descriptor,number,std::move(record),consistency);
        if (application && field == SQL_DESC_DATA_PTR && !input)
            while (!descriptor.records.empty() && !descriptor.records.back().bound) descriptor.records.pop_back();
        return SQL_SUCCESS;
    });
}
template<class Character>
SQLRETURN get_record(SQLHDESC handle, SQLSMALLINT number, Character* name, SQLSMALLINT capacity, SQLSMALLINT* needed, SQLSMALLINT* type,
    SQLSMALLINT* subtype, SQLLEN* octets, SQLSMALLINT* precision, SQLSMALLINT* scale, SQLSMALLINT* nullable) {
    return with_handle<Descriptor>(SQL_HANDLE_DESC,handle,true,[&](Descriptor& descriptor) -> SQLRETURN {
        if (capacity < 0) throw DriverError("HY090","Invalid descriptor name buffer length.");
        descriptor_read_metadata(descriptor);
        if (number <= 0) throw DriverError("07009","Invalid descriptor record number.");
        if (static_cast<std::size_t>(number) > descriptor.records.size()) return SQL_NO_DATA;
        const auto& record = descriptor.records[number - 1];
        if (type) *type = descriptor_general_type(record.type);
        if (subtype) *subtype = descriptor_subtype(record.type);
        if (octets) *octets = record.capacity;
        if (precision) *precision = record.conversion.precision;
        if (scale) *scale = record.conversion.scale;
        if (nullable) *nullable = descriptor.role == DescriptorRole::application ? SQL_NULLABLE_UNKNOWN : descriptor.role == DescriptorRole::parameter ? SQL_NULLABLE : record.metadata.nullable;
        const auto result = output_text(descriptor.role == DescriptorRole::application ? "" : record.metadata.name,name,capacity,needed);
        if (result == SQL_SUCCESS_WITH_INFO) descriptor.diagnostic.append("01004","Descriptor name was truncated."); return result;
    });
}
}
extern "C" SQLRETURN SQL_API SQLGetDescField(SQLHDESC handle, SQLSMALLINT number, SQLSMALLINT field, SQLPOINTER output, SQLINTEGER capacity, SQLINTEGER* length) { return get_field<SQLCHAR>(handle,number,field,output,capacity,length); }
extern "C" SQLRETURN SQL_API SQLGetDescFieldW(SQLHDESC handle, SQLSMALLINT number, SQLSMALLINT field, SQLPOINTER output, SQLINTEGER capacity, SQLINTEGER* length) { return get_field<SQLWCHAR>(handle,number,field,output,capacity,length); }
extern "C" SQLRETURN SQL_API SQLSetDescField(SQLHDESC handle, SQLSMALLINT number, SQLSMALLINT field, SQLPOINTER input, SQLINTEGER length) { return set_field<SQLCHAR>(handle,number,field,input,length); }
extern "C" SQLRETURN SQL_API SQLSetDescFieldW(SQLHDESC handle, SQLSMALLINT number, SQLSMALLINT field, SQLPOINTER input, SQLINTEGER length) { return set_field<SQLWCHAR>(handle,number,field,input,length); }
extern "C" SQLRETURN SQL_API SQLGetDescRec(SQLHDESC handle, SQLSMALLINT number, SQLCHAR* name, SQLSMALLINT capacity, SQLSMALLINT* needed, SQLSMALLINT* type, SQLSMALLINT* subtype, SQLLEN* octets, SQLSMALLINT* precision, SQLSMALLINT* scale, SQLSMALLINT* nullable) { return get_record(handle,number,name,capacity,needed,type,subtype,octets,precision,scale,nullable); }
extern "C" SQLRETURN SQL_API SQLGetDescRecW(SQLHDESC handle, SQLSMALLINT number, SQLWCHAR* name, SQLSMALLINT capacity, SQLSMALLINT* needed, SQLSMALLINT* type, SQLSMALLINT* subtype, SQLLEN* octets, SQLSMALLINT* precision, SQLSMALLINT* scale, SQLSMALLINT* nullable) { return get_record(handle,number,name,capacity,needed,type,subtype,octets,precision,scale,nullable); }
extern "C" SQLRETURN SQL_API SQLSetDescRec(SQLHDESC handle, SQLSMALLINT number, SQLSMALLINT type, SQLSMALLINT subtype, SQLLEN octets, SQLSMALLINT precision, SQLSMALLINT scale, SQLPOINTER data, SQLLEN* length, SQLLEN* indicator) {
    return with_handle<Descriptor>(SQL_HANDLE_DESC,handle,true,[&](Descriptor& descriptor) -> SQLRETURN {
        check_descriptor_mutation(descriptor);
        if (descriptor.role == DescriptorRole::row) throw DriverError("HY016","Implementation row metadata is read-only.");
        if (number <= 0) throw DriverError("07009","Invalid descriptor record number.");
        DescriptorRecord record; if (static_cast<std::size_t>(number) <= descriptor.records.size()) record = descriptor.records[number - 1];
        const bool application = descriptor.role == DescriptorRole::application;
        set_type(record,type,subtype,application);
        record.capacity = octets; record.conversion.precision = precision; record.conversion.fractional_precision = precision; record.conversion.scale = scale;
        if (application) { record.data = data; record.indicator = indicator; record.octet_length_pointer = length; record.bound = data || indicator || length; }
        finish_field_change(descriptor,number,std::move(record),data != nullptr); return SQL_SUCCESS;
    });
}
extern "C" SQLRETURN SQL_API SQLCopyDesc(SQLHDESC source_id, SQLHDESC target_id) {
    return entry_point(nullptr,[&]() -> SQLRETURN {
        const auto source = std::static_pointer_cast<Descriptor>(find_handle(SQL_HANDLE_DESC,source_id));
        const auto target = std::static_pointer_cast<Descriptor>(find_handle(SQL_HANDLE_DESC,target_id));
        if (!source || !target) return SQL_INVALID_HANDLE;
        const auto copy = [&]() -> SQLRETURN {
            if (!source->alive || !target->alive) return SQL_INVALID_HANDLE;
            target->diagnostic.clear();
            const auto result = entry_point(&target->diagnostic,[&]() -> SQLRETURN {
                check_descriptor_mutation(*target);
                if (target->role == DescriptorRole::row) throw DriverError("HY016","Implementation row metadata is read-only.");
                descriptor_read_metadata(*source);
                if (source == target) return SQL_SUCCESS;
                auto records = source->records;
                target->records = std::move(records); target->array_status = source->array_status;
                // 목적지에서 쓰지 않는 필드도 ALLOC_TYPE 외에는 원본 값을 복사한다.
                target->array_size = source->array_size; target->bind_type = source->bind_type; target->bind_offset = source->bind_offset;
                target->rows_processed = source->rows_processed;
                descriptor_changed(*target); return SQL_SUCCESS;
            });
            target->diagnostic.return_code = result; return result;
        };
        if (source->mutex == target->mutex) { std::lock_guard<std::recursive_mutex> lock(*target->mutex); return copy(); }
        std::scoped_lock lock(*source->mutex,*target->mutex); return copy();
    });
}
