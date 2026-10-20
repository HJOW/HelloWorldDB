# HelloWorldDB Python 드라이버

Python 3.2 이상에서 사용할 DB-API 2.0 드라이버를 개발합니다. 배포 이름은
`org.duckdns.hjow.helloworlddb.pythondriver`, import 이름은 `helloworlddb`입니다.
실행과 시험은 표준 라이브러리만 사용합니다.

현재 **PY-1(패키지 구성과 호환 계층)** 단계입니다. 패키지 버전과 내부 호환 함수를
제공하며, **접속 함수와 DB-API는 아직 없습니다**. 다음 단계는 TCP 프로토콜 코어입니다.
전체 작업 목록은 [PROGRESS.md](PROGRESS.md)에 있습니다.

```python
import helloworlddb
print(helloworlddb.__version__)
```

시험은 `pythonDriver` 디렉토리에서 실행합니다.

```sh
python -m unittest discover -s tests -v
python scripts/run_tests.py --python /path/to/python3.2 --python /path/to/python
```

PowerShell에서는 공백이 있는 실행 파일 경로를 따옴표로 감쌉니다. PC별 Python 경로는
코드에 고정하지 않고 `--python`을 반복해 전달합니다. 인자가 없으면
`HWDB_TEST_PYTHONS` 환경 변수의 **JSON 배열**을 읽고, 둘 다 없으면 현재 인터프리터를 씁니다.
실행기는 한 버전이 실패해도 나머지를 실행하며, 하나라도 실패하면 종료 코드 1을 반환합니다.

통합 시험은 형제 디렉토리의 `rdbms`가 빌드되어 있어야 합니다.

```sh
cd ../rdbms
npm run build
cd ../pythonDriver
python -m unittest discover -s tests -v
```

`tests/rdbms_instance.py`는 TCP·UDP가 모두 비어 있는 포트와 임시 설치 디렉토리를 만들고
실제 `hwdb start`·`hwdb stop`을 실행합니다. Node.js 22 이상이나 빌드 결과가 없으면
통합 시험을 이유와 함께 건너뜁니다. `HWDB_TEST_NODE`로 Node.js 실행 파일,
`HWDB_TEST_RDBMS_DIR`로 별도의 RDBMS 패키지 루트를 지정할 수 있습니다.
정상 종료에 실패하면 설치 디렉토리를 보존해 재시도할 수 있게 합니다.
현재 SQL 확인은 서버 CLI를 통해 수행하며 Python 드라이버의 통신 검증은 후속 단계입니다.

개발용 설치와 배포본 생성은 setuptools가 있는 최신 Python에서 수행합니다.

```sh
python -m pip install --no-build-isolation .
python setup.py sdist bdist_wheel
```

휠은 `py3-none-any`인 순수 Python 배포본입니다. 빌드에는 setuptools와 wheel이 필요하며
패키지 실행에는 추가 의존성이 없습니다. setuptools가 없는 Python 3.2에서는 `setup.py`가
`distutils.core`를 사용합니다. 예를 들어 `python setup.py --name`이나 `build`를 실행할 수
있으며, pip이 없는 환경의 시험은 설치 없이 소스 트리에서 실행합니다.

호환 계층은 가능한 경우 표준 함수를 쓰고, 3.2에서는 HMAC 기반 PBKDF2와 내용에 따른
조기 종료 없는 서명 비교를 사용합니다. 단조 시계는 OS 시계를 사용하므로 벽시계 변경에
기대지 않습니다. Windows에서 실제 검증하며 다른 OS의 구버전 시계는 별도 실행 검증이
필요합니다. 소스 호환성 검사는 실제 Python 3.2 실행을 보조하며 모든 API 호환을 증명하지는 않습니다.

구현 참고 자료: [PEP 418](https://peps.python.org/pep-0418/),
[RFC 7914의 PBKDF2-HMAC-SHA-256 시험 벡터](https://www.rfc-editor.org/rfc/rfc7914.html#section-11),
[HelloWorldDB 프로토콜](../rdbms/docs/protocol.md).
