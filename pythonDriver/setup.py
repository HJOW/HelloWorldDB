"""Python 3.2와 최신 빌드 도구에 맞게 순수 Python 패키지를 구성한다.

관련 사양: AGENTS.md 구현 계획 D, 패키지 이름 규칙.
구현 단계: PY-1. setuptools가 없는 3.2에서는 distutils로 물러선다.
"""

import os
import sys

try:
    from setuptools import setup
    HAS_SETUPTOOLS = True
except ImportError:
    from distutils.core import setup
    HAS_SETUPTOOLS = False


def main():
    if sys.version_info < (3, 2):
        raise RuntimeError("Python 3.2 or later is required.")
    root = os.path.dirname(os.path.abspath(__file__))
    os.chdir(root)
    with open("README.md", encoding="utf-8") as stream:
        description = stream.read()
    options = dict(
        name="org.duckdns.hjow.helloworlddb.pythondriver",
        version="0.1.0",
        description="HelloWorldDB Python driver",
        long_description=description,
        packages=["helloworlddb"],
        license="Apache-2.0",
        classifiers=[
            "Development Status :: 2 - Pre-Alpha",
            "Programming Language :: Python :: 3",
            "Programming Language :: Python :: 3 :: Only",
            "Operating System :: OS Independent",
        ],
    )
    if HAS_SETUPTOOLS:
        options.update(python_requires=">=3.2", install_requires=[],
                       long_description_content_type="text/markdown")
    setup(**options)


if __name__ == "__main__":
    main()
