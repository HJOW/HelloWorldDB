"""Python 3.2 이후의 시계, 암호 계산, 바이트와 OS 차이를 흡수한다.

관련 사양: AGENTS.md 상세 8, Python 3.2 이상 지원.
구현 단계: PY-1. 외부 패키지 없이 후속 전송 계층과 SCRAM에서 사용한다.
"""

import binascii
import errno
import hashlib
import hmac
import operator
import os
import struct
import sys
import time

try:
    from collections.abc import Mapping, Sequence
except ImportError:
    from collections import Mapping, Sequence


def _legacy_monotonic():
    """PEP 418의 OS 시계로 3.2를 보완한다. 벽시계로 대체하지 않는다."""
    import ctypes
    import ctypes.util

    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        if hasattr(kernel, "GetTickCount64"):
            ticks = kernel.GetTickCount64
            ticks.argtypes = []
            ticks.restype = ctypes.c_ulonglong
            return lambda: ticks() / 1000.0
        # Vista 이전 Windows에서는 성능 카운터를 쓴다.
        frequency = ctypes.c_longlong()
        query_frequency = kernel.QueryPerformanceFrequency
        query_frequency.argtypes = [ctypes.POINTER(ctypes.c_longlong)]
        query_frequency.restype = ctypes.c_int
        if not query_frequency(ctypes.byref(frequency)):
            raise ctypes.WinError(ctypes.get_last_error())
        counter = kernel.QueryPerformanceCounter
        counter.argtypes = [ctypes.POINTER(ctypes.c_longlong)]
        counter.restype = ctypes.c_int

        def windows_clock():
            value = ctypes.c_longlong()
            if not counter(ctypes.byref(value)):
                raise ctypes.WinError(ctypes.get_last_error())
            return value.value / float(frequency.value)

        return windows_clock

    library = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        class Timebase(ctypes.Structure):
            _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]

        timebase = Timebase()
        info = library.mach_timebase_info
        info.argtypes = [ctypes.POINTER(Timebase)]
        info.restype = ctypes.c_int
        if info(ctypes.byref(timebase)) != 0 or timebase.denom == 0:
            raise RuntimeError("Cannot read the monotonic clock timebase.")
        ticks = library.mach_absolute_time
        ticks.argtypes = []
        ticks.restype = ctypes.c_uint64
        factor = timebase.numer / float(timebase.denom) / 1000000000.0
        return lambda: ticks() * factor

    clock_id = None
    for prefix, value in (("linux", 1), ("freebsd", 4), ("openbsd", 3),
                          ("netbsd", 3), ("sunos", 4)):
        if sys.platform.startswith(prefix):
            clock_id = value
            break
    if clock_id is None:
        raise RuntimeError("No monotonic clock for Python 3.2 on this OS.")
    if not hasattr(library, "clock_gettime"):
        name = ctypes.util.find_library("rt")
        if name is None:
            raise RuntimeError("Cannot load clock_gettime.")
        library = ctypes.CDLL(name, use_errno=True)

    class Timespec(ctypes.Structure):
        _fields_ = [("tv_sec", ctypes.c_long), ("tv_nsec", ctypes.c_long)]

    gettime = library.clock_gettime
    gettime.argtypes = [ctypes.c_int, ctypes.POINTER(Timespec)]
    gettime.restype = ctypes.c_int

    def posix_clock():
        value = Timespec()
        if gettime(clock_id, ctypes.byref(value)) != 0:
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code))
        return value.tv_sec + value.tv_nsec / 1000000000.0

    posix_clock()
    return posix_clock


monotonic = getattr(time, "monotonic", None)
if monotonic is None:
    monotonic = _legacy_monotonic()


def _bytes(value):
    if not isinstance(value, (bytes, bytearray, memoryview)):
        raise TypeError("A bytes-like value is required.")
    return bytes(value)


def _compare_digest_fallback(left, right):
    """같은 길이의 값에서 내용에 따른 조기 종료 없이 비교한다."""
    if isinstance(left, str) and isinstance(right, str):
        try:
            left, right = left.encode("ascii"), right.encode("ascii")
        except UnicodeEncodeError:
            raise TypeError("Digest strings must contain ASCII only.")
    else:
        left, right = _bytes(left), _bytes(right)
    result = len(left) ^ len(right)
    for a, b in zip(left, right):
        result |= a ^ b
    return result == 0


compare_digest = getattr(hmac, "compare_digest", _compare_digest_fallback)


def _pbkdf2_hmac_fallback(hash_name, password, salt, iterations, dklen=None):
    """RFC 8018의 PBKDF2를 HMAC 복사와 정수 XOR로 계산한다."""
    password, salt = _bytes(password), _bytes(salt)
    iterations = operator.index(iterations)
    if iterations <= 0:
        raise ValueError("Iterations must be positive.")
    size = hashlib.new(hash_name).digest_size
    if dklen is None:
        dklen = size
    dklen = operator.index(dklen)
    if dklen <= 0:
        raise ValueError("Derived key length must be positive.")
    if dklen > (2 ** 32 - 1) * size:
        raise OverflowError("Derived key is too long.")
    base = hmac.new(password, digestmod=lambda data=b"": hashlib.new(hash_name, data))

    def digest(value):
        calculation = base.copy()
        calculation.update(value)
        return calculation.digest()

    blocks = []
    for number in range(1, (dklen + size - 1) // size + 1):
        current = digest(salt + struct.pack("!I", number))
        total = int.from_bytes(current, "big")
        for unused in range(iterations - 1):
            current = digest(current)
            total ^= int.from_bytes(current, "big")
        blocks.append(total.to_bytes(size, "big"))
    return b"".join(blocks)[:dklen]


pbkdf2_hmac = getattr(hashlib, "pbkdf2_hmac", _pbkdf2_hmac_fallback)


def hexlify(value):
    """프로토콜의 대문자 16진 문자열로 바꾼다."""
    return binascii.hexlify(_bytes(value)).decode("ascii").upper()


def unhexlify(value):
    if isinstance(value, str):
        value = value.encode("ascii")
    return binascii.unhexlify(_bytes(value))


def socket_error_code(error):
    """옛 socket.error와 Windows WSA 오류를 같은 방식으로 읽는다."""
    for name in ("winerror", "errno"):
        value = getattr(error, name, None)
        if isinstance(value, int):
            return value
    args = getattr(error, "args", ())
    return args[0] if args and isinstance(args[0], int) else None


def is_interrupted(error):
    return socket_error_code(error) in (errno.EINTR, 10004)


def is_would_block(error):
    return socket_error_code(error) in (errno.EAGAIN, errno.EWOULDBLOCK, 10035)


def is_unreachable(error):
    return socket_error_code(error) in (
        errno.ECONNREFUSED, errno.EHOSTUNREACH, errno.ENETUNREACH,
        10061, 10065, 10051)


def is_connection_lost(error):
    return is_unreachable(error) or socket_error_code(error) in (
        errno.ECONNRESET, errno.ECONNABORTED, errno.ENOTCONN, errno.EPIPE,
        10054, 10053, 10057, 10058)


def which(command, path=None):
    """PATH와 Windows PATHEXT에서 실행 파일을 찾는다."""
    if not command:
        return None
    windows = os.name == "nt"
    extensions = [""]
    if windows:
        suffixes = os.environ.get("PATHEXT", ".COM;.EXE;.BAT;.CMD").split(os.pathsep)
        if not any(command.lower().endswith(s.lower()) for s in suffixes if s):
            extensions += [s for s in suffixes if s]
    if os.path.dirname(command):
        directories = [""]
    else:
        if path is None:
            path = os.environ.get("PATH", os.defpath)
        directories = path.split(os.pathsep)
    for directory in directories:
        candidate = os.path.join(directory.strip('"'), command)
        for extension in extensions:
            filename = candidate + extension
            if os.path.isfile(filename) and os.access(filename, os.X_OK):
                return filename
    return None
