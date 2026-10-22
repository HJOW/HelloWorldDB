/**
 * 드라이버 .so 를 직접 dlopen 해서 다음을 확인한다. (unixODBC Manager 경유 시험은 UO-1 후반·UO-4)
 *
 *  - 라이브러리를 실제로 열 수 있다.
 *  - 빌드 식별자 심볼이 보인다.
 *  - version script 가 내부 심볼을 숨긴다.
 *
 * 사용법: hwdb_odbc_abi_probe <libhwdbodbc.so 경로>
 */
#include <cstdio>
#include <cstring>
#include <string>

#include <dlfcn.h>

namespace {

int failures = 0;

void check(bool condition, const std::string &what) {
    if (condition) {
        std::printf("ok   %s\n", what.c_str());
    } else {
        std::printf("FAIL %s\n", what.c_str());
        ++failures;
    }
}

} // namespace

int main(int argc, char **argv) {
    if (argc != 2) {
        std::fprintf(stderr, "사용법: %s <libhwdbodbc.so 경로>\n", argv[0]);
        return 2;
    }
    const char *path = argv[1];

    dlerror();
    void *library = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (library == nullptr) {
        std::fprintf(stderr, "FAIL dlopen(%s): %s\n", path, dlerror());
        return 1;
    }
    check(true, std::string("dlopen ") + path);

    dlerror();
    using BuildId = const char *(*)();
    auto buildId = reinterpret_cast<BuildId>(dlsym(library, "hwdb_odbc_build_id"));
    check(buildId != nullptr, "hwdb_odbc_build_id 심볼이 보인다");
    if (buildId != nullptr) {
        const char *value = buildId();
        check(value != nullptr && std::strstr(value, "HelloWorldDB") != nullptr,
              "빌드 식별자가 HelloWorldDB 를 포함한다");
    }

    dlerror();
    void *hidden = dlsym(library, "internal_hidden_probe");
    check(hidden == nullptr, "내부 심볼은 내보내지 않는다");

    dlclose(library);
    if (failures != 0) {
        std::printf("%d개 검사 실패\n", failures);
        return 1;
    }
    std::printf("모든 ABI 검사 통과\n");
    return 0;
}
