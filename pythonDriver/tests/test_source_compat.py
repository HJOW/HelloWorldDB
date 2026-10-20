"""AST와 토큰으로 Python 3.2 이후 문법·모듈 유입을 검사한다.

관련 사양: Python 3.2 이상 같은 소스 지원. 구현 단계: PY-1.
실제 3.2 실행을 보조하는 제한된 검사이며 모든 API의 존재를 증명하지 않는다.
"""

import ast
import io
import os
import re
import tokenize
import unittest


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEW_NODES = frozenset((
    "JoinedStr", "FormattedValue", "YieldFrom", "AsyncFunctionDef", "AsyncFor",
    "AsyncWith", "Await", "AnnAssign", "NamedExpr", "Match", "TryStar", "TypeAlias",
))
NEW_MODULES = frozenset((
    "asyncio", "collections.abc", "concurrent.interpreters", "dataclasses", "enum",
    "importlib.metadata", "importlib.resources", "ipaddress", "pathlib", "secrets",
    "selectors", "statistics", "tomllib", "typing", "unittest.mock",
))


def source_files():
    yield os.path.join(ROOT, "setup.py")
    for directory in ("helloworlddb", "tests", "scripts"):
        for parent, directories, filenames in os.walk(os.path.join(ROOT, directory)):
            directories[:] = sorted(d for d in directories if d != "__pycache__")
            for filename in sorted(filenames):
                if filename.endswith(".py"):
                    yield os.path.join(parent, filename)


def source_issues(source, filename="<source>", allowed_imports=()):
    issues = []
    try:
        tree = ast.parse(source, filename=filename)
    except SyntaxError as error:
        return ["{0}:{1}: {2}".format(filename, error.lineno, error.msg)]
    for node in ast.walk(tree):
        kind = type(node).__name__
        if kind in NEW_NODES:
            issues.append("{0}:{1}: {2}".format(filename, node.lineno, kind))
        if isinstance(node, ast.Raise) and node.cause is not None:
            if (getattr(node.cause, "value", object()) is None or
                    getattr(node.cause, "id", None) == "None"):
                issues.append("{0}:{1}: raise from None".format(filename, node.lineno))
        imports = []
        if isinstance(node, ast.Import):
            imports = [entry.name for entry in node.names]
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            imports = [module] + [module + "." + entry.name for entry in node.names]
        for name in imports:
            if name in allowed_imports:
                continue
            if any(name == banned or name.startswith(banned + ".") for banned in NEW_MODULES):
                issues.append("{0}:{1}: import {2}".format(filename, node.lineno, name))
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token[0] == tokenize.STRING and re.match(r"(?i)^u[r]?[\"']", token[1]):
            issues.append("{0}:{1}: unicode literal prefix".format(filename, token[2][0]))
    return issues


class SourceCompatibilityTests(unittest.TestCase):
    def test_project_sources(self):
        issues = []
        for filename in source_files():
            with open(filename, encoding="utf-8") as stream:
                source = stream.read()
            # 3.2용 fallback이 함께 있는 유일한 조건부 import이다.
            allowed = ("collections.abc", "collections.abc.Mapping", "collections.abc.Sequence")
            if filename != os.path.join(ROOT, "helloworlddb", "_compat.py"):
                allowed = ()
            issues.extend(source_issues(source, filename, allowed))
        self.assertEqual(issues, [], "\n".join(issues))

    def test_checker_detects_new_syntax(self):
        samples = (
            "value = f'hello {1}'", "value = u'hello'", "def f():\n    yield from []",
            "async def f():\n    await task()", "value: int = 1",
            "raise ValueError() from None", "if (value := 1): pass",
        )
        for sample in samples:
            self.assertTrue(source_issues(sample), sample)

    def test_checker_detects_new_imports(self):
        for sample in ("import pathlib", "from unittest import mock",
                       "import collections.abc", "from importlib import resources",
                       "import asyncio.subprocess"):
            self.assertTrue(source_issues(sample), sample)

    def test_checker_allows_32_syntax(self):
        sample = "from collections import Mapping\nvalue = b'bytes'\nraise ValueError() from error"
        self.assertEqual(source_issues(sample), [])


if __name__ == "__main__":
    unittest.main()
