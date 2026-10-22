#!/usr/bin/env bash
# unixODBC 개발 의존성을 준비한다. (UO-0)
#
# 두 경로를 지원한다.
#  1) root 또는 암호 없는 sudo 가 있으면 apt 로 시스템에 설치한다.
#  2) 그렇지 않으면 apt-get download 로 받은 .deb 를 이 프로젝트의 .deps/ 에 풀고
#     CMake 는 pip 바퀴(wheel)를 .deps/python 에 설치한다. 시스템을 바꾸지 않는다.
#
# 사용법: scripts/setup-deps.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPS="${ROOT}/.deps"
mkdir -p "${DEPS}"

log() { printf '[setup-deps] %s\n' "$*"; }
fail() { printf '[setup-deps] 오류: %s\n' "$*" >&2; exit 1; }

if [[ "$(uname -s)" == "Darwin" ]]; then
    fail "macOS 는 Homebrew 로 'brew install cmake unixodbc' 를 먼저 실행한 뒤 다시 부르십시오."
fi
if [[ "$(uname -s)" != "Linux" ]]; then
    fail "Linux 와 macOS 만 지원한다. (현재: $(uname -s))"
fi

command -v g++ >/dev/null 2>&1 || fail "g++ 가 없다. build-essential 을 설치하십시오."
command -v dpkg-deb >/dev/null 2>&1 || fail "dpkg-deb 가 없다. Debian/Ubuntu 계열이 필요하다."

have_system_deps() {
    command -v cmake >/dev/null 2>&1 &&
        { [[ -f /usr/include/sql.h ]] || pkg-config --exists odbc 2>/dev/null; }
}

if have_system_deps; then
    log "시스템에 cmake 와 unixODBC 개발 헤더가 이미 있다. 추가 설치를 건너뛴다."
    exit 0
fi

can_root_install() {
    [[ "$(id -u)" -eq 0 ]] && return 0
    command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null
}

if can_root_install; then
    if [[ "$(id -u)" -eq 0 ]]; then
        SUDO=()
    else
        SUDO=(sudo -n)
    fi
    log "시스템 패키지를 설치한다. (cmake unixodbc unixodbc-dev odbcinst libssl-dev)"
    "${SUDO[@]}" apt-get install -y --no-install-recommends \
        cmake unixodbc unixodbc-dev odbcinst libssl-dev
    log "시스템 설치를 마쳤다. scripts/build-and-test.sh 를 실행하십시오."
    exit 0
fi

log "root 권한이 없어 프로젝트 안(.deps)에 의존성을 둔다."

TRIPLE="$(gcc -dumpmachine)"
[[ -n "${TRIPLE}" ]] || fail "gcc -dumpmachine 결과가 비었다."

mkdir -p "${DEPS}/debs" "${DEPS}/sysroot" "${DEPS}/wheels" "${DEPS}/python"
cd "${DEPS}/debs"
need_download=0
for package in unixodbc unixodbc-common unixodbc-dev odbcinst libodbc2 libodbccr2 libodbcinst2; do
    compgen -G "${package}_*.deb" >/dev/null || need_download=1
done
if [[ "${need_download}" -eq 1 ]]; then
    log "unixODBC 패키지를 내려받는다."
    apt-get download unixodbc unixodbc-common unixodbc-dev odbcinst \
        libodbc2 libodbccr2 libodbcinst2
fi
for archive in ./*.deb; do
    dpkg-deb -x "${archive}" "${DEPS}/sysroot"
done

if [[ ! -x "${DEPS}/python/cmake/data/bin/cmake" ]]; then
    command -v python3 >/dev/null 2>&1 || fail "python3 가 없어 CMake 를 준비할 수 없다."
    if ! ls "${DEPS}/wheels"/cmake-*.whl >/dev/null 2>&1; then
        log "CMake 바퀴를 내려받는다."
        python3 -m pip download --no-deps --only-binary=:all: \
            --dest "${DEPS}/wheels" cmake
    fi
    log "CMake 를 .deps/python 에 설치한다."
    python3 -m pip install --no-deps --no-index --find-links "${DEPS}/wheels" \
        --target "${DEPS}/python" cmake
fi
[[ -x "${DEPS}/python/cmake/data/bin/cmake" ]] || fail "CMake 설치를 확인하지 못했다."

SYSROOT="${DEPS}/sysroot"
ODBC_ROOT="${SYSROOT}/usr"
cat > "${DEPS}/env.sh" <<EOF
# scripts/setup-deps.sh 가 만든 파일이다. 직접 고치지 않는다.
export HWDB_ODBC_ROOT="${ODBC_ROOT}"
export PATH="${DEPS}/python/cmake/data/bin:${ODBC_ROOT}/bin:\${PATH}"
export CMAKE_PREFIX_PATH="${ODBC_ROOT}\${CMAKE_PREFIX_PATH:+:\${CMAKE_PREFIX_PATH}}"
export PKG_CONFIG_PATH="${ODBC_ROOT}/lib/${TRIPLE}/pkgconfig\${PKG_CONFIG_PATH:+:\${PKG_CONFIG_PATH}}"
export LD_LIBRARY_PATH="${ODBC_ROOT}/lib/${TRIPLE}\${LD_LIBRARY_PATH:+:\${LD_LIBRARY_PATH}}"
EOF

log "준비 완료."
log "  unixODBC: ${ODBC_ROOT}"
log "  CMake   : ${DEPS}/python/cmake/data/bin/cmake"
log "  환경 파일: ${DEPS}/env.sh (scripts/build-and-test.sh 가 자동으로 읽는다)"
log "isql 을 직접 실행하려면 '. ${DEPS}/env.sh' 를 먼저 실행한다."
