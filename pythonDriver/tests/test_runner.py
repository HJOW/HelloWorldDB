"""시험 실행기의 경로 전달과 실패 상태 전파를 검증한다.

관련 사양: PC별 Python 경로를 인자나 환경 변수로 받는다. 구현 단계: PY-1.
"""

import json
import os
import sys
import unittest

from scripts import run_tests


class RunnerTests(unittest.TestCase):
    def test_default_uses_current_interpreter(self):
        self.assertEqual(run_tests.interpreters(None, {}), [sys.executable])

    def test_arguments_override_environment(self):
        self.assertEqual(run_tests.interpreters(["chosen"], {"HWDB_TEST_PYTHONS": "broken"}),
                         ["chosen"])

    def test_json_preserves_spaces(self):
        paths = [os.path.join("folder with spaces", "python"), "python"]
        self.assertEqual(run_tests.interpreters(None, {"HWDB_TEST_PYTHONS": json.dumps(paths)}), paths)

    def test_invalid_environment_is_rejected(self):
        for value in ("not JSON", '"python"', "[]", '[""]', "[null]", "[3]"):
            with self.assertRaises(ValueError):
                run_tests.interpreters(None, {"HWDB_TEST_PYTHONS": value})

    def test_all_versions_run_after_one_fails(self):
        original = run_tests.subprocess.call
        calls = []

        def call(arguments, cwd):
            calls.append((arguments, cwd))
            return 1 if arguments[0] == "first" else 0

        run_tests.subprocess.call = call
        try:
            self.assertEqual(run_tests.main(["--python", "first", "--python", "second",
                                             "--pattern", "test_compat.py"]), 1)
        finally:
            run_tests.subprocess.call = original
        self.assertEqual([entry[0][0] for entry in calls], ["first", "second"])
        self.assertEqual(calls[1][0][-2:], ["test_compat.py", "-v"])
        self.assertEqual(calls[1][1], run_tests.ROOT)


if __name__ == "__main__":
    unittest.main()
