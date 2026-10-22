/**
 * UO-1 빌드 골격이다.
 *
 * 아직 ODBC 진입점(SQL*)을 구현하지 않았다. 이 파일의 목적은 다음을 실제 산출물로 확인하는 것이다.
 *  - 드라이버 .so 가 unixODBC Manager 에 링크하지 않고도 만들어지는가
 *  - 기본 가시성이 hidden 이고 version script 로 내보낼 심볼만 노출되는가
 *  - SONAME 과 dlopen 경로가 시험에서 확인되는가
 *
 * UO-2 에서 이 파일을 핸들·진단 구현으로 바꾸고 SQL* 심볼을 exports.map 에 추가한다.
 */
#include "hwdbodbc/odbc.hpp"
#include "hwdbodbc/version.hpp"

namespace hwdb::odbc::detail {

/** 내부 심볼이다. version script 가 숨기는지 ABI 시험에서 확인한다. */
const char *internal_hidden_probe() { return "hidden"; }

} // namespace hwdb::odbc::detail

extern "C" {

/** 드라이버가 로드됐는지와 빌드 식별자를 확인하는 진단용 심볼이다. */
HWDB_ODBC_EXPORT const char *hwdb_odbc_build_id(void) {
    // 숨김 심볼을 실제로 참조해 링커가 제거하지 않게 한다.
    (void)hwdb::odbc::detail::internal_hidden_probe();
    return HWDB_ODBC_BUILD_ID;
}

} // extern "C"
