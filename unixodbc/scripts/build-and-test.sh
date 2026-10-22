#!/usr/bin/env bash
# unixODBC 드라이버를 빌드하고 시험한다.
#
# 사용법:
#   scripts/build-and-test.sh            # dev(Debug) 프리셋
#   scripts/build-and-test.sh release
#   scripts/build-and-test.sh asan       # AddressSanitizer + UBSan
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

PRESET="${1:-dev}"
case "${PRESET}" in
    dev | release | asan) ;;
    *)
        printf '알 수 없는 프리셋: %s (dev, release, asan 중 하나)\n' "${PRESET}" >&2
        exit 2
        ;;
esac

if [[ -f "${ROOT}/.deps/env.sh" ]]; then
    # shellcheck disable=SC1091
    . "${ROOT}/.deps/env.sh"
fi

command -v cmake >/dev/null 2>&1 || {
    printf 'cmake 가 없다. scripts/setup-deps.sh 를 먼저 실행하십시오.\n' >&2
    exit 1
}
command -v node >/dev/null 2>&1 || {
    printf 'Node.js 22 이상이 필요하다. (시험 실행기)\n' >&2
    exit 1
}

printf '[build] 프리셋: %s\n' "${PRESET}"
cmake --preset "${PRESET}"
cmake --build --preset "${PRESET}"
ctest --preset "${PRESET}"

printf '[build] 완료. 산출물: %s/build/%s\n' "${ROOT}" "${PRESET}"
