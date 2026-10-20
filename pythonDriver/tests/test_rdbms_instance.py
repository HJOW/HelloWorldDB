"""임시 서버의 구동·정리와 의존 환경 누락을 검증한다.

관련 사양: AGENTS.md 상세 8, 14, 15. 구현 단계: PY-1.
SQL 예제는 서버 CLI의 동작을 확인하며 Python 드라이버 접속 시험은 아니다.
"""

import os
import socket
import sys
import tempfile
import unittest

from tests.rdbms_instance import (CommandResult, RdbmsInstance, free_port,
                                  port_is_free, prerequisites, run_process)


class InstanceUtilityTests(unittest.TestCase):
    def test_missing_node_skips(self):
        with self.assertRaises(unittest.SkipTest):
            prerequisites(node="hwdb-node-does-not-exist")

    def test_missing_build_skips(self):
        with tempfile.TemporaryDirectory(prefix="hwdb-no-build-") as directory:
            with self.assertRaises(unittest.SkipTest):
                prerequisites(rdbms_dir=directory)

    def test_process_timeout(self):
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            run_process([sys.executable, "-c", "import time; time.sleep(10)"], timeout=0.1)

    def test_process_collects_output_and_status(self):
        result = run_process([sys.executable, "-c",
                              "import sys; print('hello'); sys.stderr.write('error'); sys.exit(2)"])
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout.strip(), "hello")
        self.assertEqual(result.stderr, "error")

    def test_free_port_checks_tcp_and_udp(self):
        port = free_port()
        self.assertGreater(port, 0)
        for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
            probe = socket.socket(socket.AF_INET, kind)
            try:
                probe.bind(("127.0.0.1", port))
                if kind == socket.SOCK_STREAM:
                    probe.listen(1)
                self.assertFalse(port_is_free(port))
            finally:
                probe.close()


class RdbmsInstanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        prerequisites()

    def test_lifecycle_and_tcp_cli_query(self):
        instance = RdbmsInstance()
        directory = instance.install_dir
        with instance:
            self.assertTrue(os.path.isfile(instance.lock_path))
            status = instance.command("status")
            self.assertEqual(status.returncode, 0, status.stderr)
            self.assertIn(str(instance.port), status.stdout)
            result = instance.command("-h", "127.0.0.1", "-P", str(instance.port),
                                      "-u", "SYSTEM", "-p", "HelloWorldDB",
                                      "-e", "SELECT '안녕하세요' AS GREETING")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("안녕하세요", result.stdout)
        self.assertTrue(instance.closed)
        self.assertFalse(os.path.exists(directory))
        instance.close()

    def test_exception_in_body_cleans_server(self):
        instance = RdbmsInstance()
        directory = instance.install_dir
        with self.assertRaisesRegex(ValueError, "test body"):
            with instance:
                raise ValueError("test body")
        self.assertFalse(os.path.exists(directory))

    def test_startup_failure_cleans_installation(self):
        instance = RdbmsInstance({"tcp": {"enabled": "invalid"}})
        directory = instance.install_dir
        with self.assertRaisesRegex(RuntimeError, "hwdb start failed"):
            instance.start()
        self.assertTrue(instance.closed)
        self.assertFalse(os.path.exists(directory))

    def test_cleanup_failure_keeps_installation_for_retry(self):
        instance = RdbmsInstance()
        original = instance.command
        instance.command = lambda *args: CommandResult(1, "", "injected failure")
        instance._needs_stop = True
        try:
            with self.assertRaisesRegex(RuntimeError, "installation kept"):
                instance.close()
            self.assertFalse(instance.closed)
            self.assertTrue(os.path.isdir(instance.install_dir))
        finally:
            instance.command = original
            instance.close()

    def test_helper_rejects_external_data_directory(self):
        with self.assertRaisesRegex(ValueError, "owns port"):
            RdbmsInstance({"dataDir": "../unrelated"})

    def test_cleanup_rejects_changed_directory(self):
        instance = RdbmsInstance()
        original = instance.install_dir
        try:
            with tempfile.TemporaryDirectory(prefix="hwdb-unrelated-") as other:
                instance.install_dir = other
                with self.assertRaisesRegex(RuntimeError, "path changed"):
                    instance.close()
                self.assertTrue(os.path.isdir(other))
        finally:
            instance.install_dir = original
            instance.close()


if __name__ == "__main__":
    unittest.main()
