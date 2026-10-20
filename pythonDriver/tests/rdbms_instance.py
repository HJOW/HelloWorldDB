"""임시 설치에서 실제 hwdb start/stop을 실행하는 통합 시험 도우미이다.

관련 사양: AGENTS.md 상세 7, 8, 14, 15, 프로토콜 15~16절.
구현 단계: PY-1. 서버 제품 코드를 가져오지 않고 빌드된 CLI만 실행한다.
"""

import atexit
from collections import namedtuple
import json
import os
import random
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest

from helloworlddb._compat import which


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CommandResult = namedtuple("CommandResult", "returncode stdout stderr")
_instances = set()


def run_process(arguments, cwd=None, env=None, timeout=40):
    """3.2에서도 출력을 회수하며 자식 명령에 제한 시간을 둔다."""
    options = {}
    if os.name == "nt":
        options["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    with open(os.devnull, "rb") as devnull:
        process = subprocess.Popen(arguments, cwd=cwd, env=env, stdin=devnull,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   **options)
        expired = threading.Event()

        def terminate():
            if process.poll() is None:
                expired.set()
                try:
                    process.kill()
                except OSError:
                    pass

        timer = threading.Timer(timeout, terminate)
        timer.daemon = True
        timer.start()
        try:
            stdout, stderr = process.communicate()
        except BaseException:
            terminate()
            process.communicate()
            raise
        finally:
            timer.cancel()
            timer.join()
    if expired.is_set():
        raise RuntimeError("Command timed out: {0}".format(arguments[0]))
    return CommandResult(process.returncode, stdout.decode("utf-8", "replace"),
                         stderr.decode("utf-8", "replace"))


def prerequisites(node=None, rdbms_dir=None):
    node = node or os.environ.get("HWDB_TEST_NODE", "node")
    executable = which(node)
    if executable is None:
        raise unittest.SkipTest("Node.js is unavailable: {0}".format(node))
    directory = rdbms_dir or os.environ.get(
        "HWDB_TEST_RDBMS_DIR", os.path.join(os.path.dirname(ROOT), "rdbms"))
    cli = os.path.abspath(os.path.join(directory, "dist", "src", "cli", "main.js"))
    if not os.path.isfile(cli):
        raise unittest.SkipTest("Build rdbms first (npm run build): {0}".format(cli))
    version = run_process([executable, "--version"], timeout=10)
    if version.returncode != 0:
        raise RuntimeError("Cannot read Node.js version: {0}".format(version.stderr))
    major = int(version.stdout.strip().lstrip("v").split(".")[0])
    if major < 22:
        raise unittest.SkipTest("Node.js 22 or later is required.")
    return executable, cli


def port_is_free(port):
    """TCP·UDP를 모두 확인하고 Windows 제외 포트도 bind 실패로 거른다."""
    for host in ("0.0.0.0", "127.0.0.1"):
        for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
            probe = socket.socket(socket.AF_INET, kind)
            try:
                if os.name == "nt":
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
                probe.bind((host, port))
                if kind == socket.SOCK_STREAM:
                    probe.listen(1)
            except socket.error:
                return False
            finally:
                probe.close()
    return True


def free_port():
    for attempt in range(200):
        if attempt < 3:
            probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            finally:
                probe.close()
        else:
            port = random.SystemRandom().randint(20000, 44999)
        if port_is_free(port):
            return port
    raise RuntimeError("Cannot find a free TCP and UDP port.")


def _merge(target, source):
    for key, value in source.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _merge(target[key], value)
        else:
            target[key] = value


class RdbmsInstance(object):
    """실패하면 진단용 파일을 남기고, 정상 종료 뒤에만 임시 설치를 지운다."""

    def __init__(self, config=None, node=None, rdbms_dir=None):
        self.node, self.cli = prerequisites(node, rdbms_dir)
        self.port = free_port()
        self.config = {
            "port": self.port, "dataDir": "./data",
            "tcp": {"enabled": True, "host": "127.0.0.1"},
            "udp": {"enabled": True, "host": "127.0.0.1"},
            "log": {"dir": "./logs", "level": "warn"},
        }
        _merge(self.config, config or {})
        if (self.config.get("port") != self.port or
                self.config.get("dataDir") != "./data" or
                not isinstance(self.config.get("log"), dict) or
                self.config["log"].get("dir") != "./logs"):
            raise ValueError("The helper owns port, dataDir and log.dir.")
        self.install_dir = tempfile.mkdtemp(prefix="hwdb-python-")
        self._owned_dir = os.path.realpath(self.install_dir)
        self.closed = False
        self._needs_stop = False
        try:
            with open(os.path.join(self.install_dir, "config.json"), "w",
                      encoding="utf-8") as stream:
                json.dump(self.config, stream, ensure_ascii=False)
        except BaseException:
            self.close()
            raise
        _instances.add(self)

    @property
    def lock_path(self):
        return os.path.join(self.install_dir, "data", "helloworlddb.lock")

    def command(self, *arguments):
        if self.closed:
            raise RuntimeError("The test installation is closed.")
        environment = os.environ.copy()
        environment["HWDB_INSTALL_DIR"] = self.install_dir
        environment["HWDB_LANG"] = "en"
        return run_process([self.node, self.cli] + list(arguments), cwd=ROOT,
                           env=environment)

    def start(self):
        # 시작 명령 실패·중단 때도 stop을 시도하도록 먼저 표시한다.
        self._needs_stop = True
        try:
            result = self.command("start", "--timeout", "15")
            if result.returncode != 0:
                # CLI는 구동 실패 시 자식을 정리하고 돌아온다. 설정 검사에서
                # 실패해 잠금 파일조차 없으면 stop도 같은 설정 오류가 난다.
                self._needs_stop = os.path.isfile(self.lock_path)
                raise RuntimeError("hwdb start failed: {0}{1}".format(
                    result.stdout, result.stderr))
            return self
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.closed:
            return
        if self._needs_stop:
            result = self.command("stop", "--timeout", "15")
            if result.returncode != 0:
                raise RuntimeError("hwdb stop failed; installation kept at {0}: {1}{2}".format(
                    self.install_dir, result.stdout, result.stderr))
            self._needs_stop = False
        # 삭제 대상은 이 인스턴스가 직접 만든 절대 경로와 같아야 한다.
        if os.path.realpath(self.install_dir) != self._owned_dir:
            raise RuntimeError("The test installation path changed; refusing cleanup.")
        shutil.rmtree(self.install_dir)
        self.closed = True
        _instances.discard(self)

    def __enter__(self):
        return self.start()

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()


def _cleanup():
    for instance in list(_instances):
        try:
            instance.close()
        except Exception as error:
            print("Test installation cleanup failed: {0}".format(error), file=sys.stderr)


atexit.register(_cleanup)
