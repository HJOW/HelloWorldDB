"""패키지 메타데이터와 소스 밖에서의 빌드 결과 import를 검증한다.

관련 사양: Python 3.2 이상, 외부 실행 의존 없음. 구현 단계: PY-1.
3.2에서는 실제 distutils fallback을, 최신 환경에서는 setuptools 경로를 쓴다.
"""

import os
import sys
import tempfile
import unittest

import helloworlddb
from tests.rdbms_instance import ROOT, run_process


class PackageTests(unittest.TestCase):
    def test_metadata(self):
        result = run_process([sys.executable, "setup.py", "--name", "--version"], cwd=ROOT)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip().splitlines(),
                         ["org.duckdns.hjow.helloworlddb.pythondriver", helloworlddb.__version__])

    def test_build_imports_without_source_tree(self):
        with tempfile.TemporaryDirectory(prefix="hwdb-package-") as directory:
            base = os.path.join(directory, "build")
            result = run_process([sys.executable, "setup.py", "build", "--build-base", base],
                                 cwd=ROOT)
            self.assertEqual(result.returncode, 0, result.stderr)
            environment = os.environ.copy()
            environment["PYTHONPATH"] = os.path.join(base, "lib")
            script = ("import helloworlddb; from helloworlddb import _compat; "
                      "print(helloworlddb.__version__); print(helloworlddb.__file__); "
                      "print(len(_compat.pbkdf2_hmac('sha256', b'p', b's', 1)))")
            imported = run_process([sys.executable, "-c", script], cwd=directory, env=environment)
            self.assertEqual(imported.returncode, 0, imported.stderr)
            lines = imported.stdout.strip().splitlines()
            self.assertEqual(lines[0], helloworlddb.__version__)
            self.assertTrue(os.path.realpath(lines[1]).startswith(os.path.realpath(base) + os.sep))
            self.assertEqual(lines[2], "32")


if __name__ == "__main__":
    unittest.main()
