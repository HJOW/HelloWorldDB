"""같은 시험을 지정된 Python 인터프리터마다 실행한다.

관련 사양: Python 3.2 이상 같은 소스 검증, PC별 경로는 인자로 전달.
구현 단계: PY-1. 실행기 자체도 3.2에서 동작한다.
"""

import argparse
import json
import os
import subprocess
import sys


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def interpreters(arguments, environment):
    if arguments:
        return arguments
    value = environment.get("HWDB_TEST_PYTHONS")
    if value is None:
        return [sys.executable]
    result = json.loads(value)
    if (not isinstance(result, list) or not result or
            not all(isinstance(item, str) and item for item in result)):
        raise ValueError("HWDB_TEST_PYTHONS must be a nonempty JSON array of paths.")
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run tests with each Python executable.")
    parser.add_argument("--python", action="append", dest="pythons",
                        help="Python executable (repeatable).")
    parser.add_argument("--pattern", default="test*.py", help="unittest file pattern.")
    options = parser.parse_args(argv)
    try:
        paths = interpreters(options.pythons, os.environ)
    except ValueError as error:
        parser.error(str(error))
    failed = False
    for executable in paths:
        print("Running tests: {0}".format(executable))
        sys.stdout.flush()
        try:
            status = subprocess.call(
                [executable, "-m", "unittest", "discover", "-s", "tests",
                 "-p", options.pattern, "-v"], cwd=ROOT)
        except OSError as error:
            print("Cannot execute {0}: {1}".format(executable, error), file=sys.stderr)
            status = 1
        if status != 0:
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
