# pythonDriver 진행 상황

HelloWorldDB 에 접속하는 Python 용 드라이버를 개발하는 프로젝트이다. **Python 3.2 이상**을 지원하고 **DB-API 2.0(PEP 249)** 을 지킨다. (AGENTS.md "디렉토리 구조 및 개별 목표" 5번)
사양은 루트의 AGENTS.md 가 기준이다. 이 문서에는 세부 계획, 진행 상황, 인수인계 사항만 적는다.
"상세 N" 은 AGENTS.md "RDBMS 에 구현되어야 할 사항 (상세)" 의 N번 절을 가리킨다.
이 프로젝트는 AGENTS.md 의 "구현 계획"(A, B, C)에 아직 단계가 없다. 그래서 아래의 단계 번호는 이 문서 안에서만 쓰는 **PY-1 ~ PY-6** 이다.

## 현재 상태

- 최종 갱신 : 2026-10-16
- 진행 단계 : 계획 작성 (코드 없음)
- 이 PC 의 Python : **3.2 는 `C:\Python\Py302\python.exe`**, 최신은 3.13.1 (`C:\Python\python.exe`, PATH 의 `python`). 2026-10-16 에 직접 실행해 확인했다. "이 PC 의 시험 환경" 절을 본다
- 착수 조건 : (1) `rdbms` 11단계 완료. 프로토콜 명세 [rdbms/docs/protocol.md](../rdbms/docs/protocol.md)(버전 1)와 참고 클라이언트 `rdbms/src/client` 는 이미 있다. (2) 사용자가 일정(`nodejsDriver` 와의 선후)을 정하고 AGENTS.md "구현 계획"에 이 프로젝트의 단계를 더한다. "미결 사항" 1.
- 다음 작업 : 사용자 확인이 필요한 "미결 사항" 1, 2 를 정한 뒤 PY-1 (패키지 구성과 호환 계층). Python 3.2 시험 환경(미결 사항 3)은 이 PC 에서 해결되었다

## 작업 규칙

- 작업 항목을 끝내면 `[ ]` 를 `[x]` 로 바꾼다. 묶음(PY-n)이 끝나면 "현재 상태" 와 "작업 이력" 을 갱신한다.
- 사양에 없는 것을 새로 정했으면 "결정 사항" 에 적는다. 사양 자체를 바꿔야 하면 AGENTS.md 를 먼저 고친다.
- 소스와 문서는 UTF-8, 주석과 답변은 한국어로 쓴다 (AGENTS.md 지켜야 할 사항 1, 2). 파일마다 맨 위 주석(docstring)에 담당 범위, 관련 사양, 구현 단계를 적는다. `rdbms` 와 같은 방식이다.
- 실행에도 시험에도 **표준 라이브러리만** 쓴다 (외부 패키지 의존 최소, AGENTS.md 공통 방침). 시험은 `unittest` 이다.
- 프로토콜을 추측해서 구현하지 않는다. [rdbms/docs/protocol.md](../rdbms/docs/protocol.md) 15절의 클라이언트 체크리스트를 따른다. 명세와 서버 동작이 다르면 `rdbms/PROGRESS.md` 에 적고 한쪽으로 맞춘다.
- git commit, push 는 하지 않는다 (AGENTS.md 지켜야 할 사항 3).

## 범위

- 한다 : TCP(SSL 포함)와 UDP 접속, 인증(SCRAM-SHA-256), 문장 실행과 `?` 파라미터, 결과 나누어 받기, 트랜잭션, 타입 변환, DB-API 2.0 의 모듈·`Connection`·`Cursor`·예외·타입 객체.
- 하지 않는다 : 로컬 전용 채널(네임드 파이프, 유닉스 소켓)과 데몬 제어(구동, 종료, 상태 조회)는 CLI(`hwdb`)의 몫이다. `nodejsDriver` 와 같은 원칙이다.
  `asyncio` 용 비동기 API(Python 3.2 에는 `asyncio` 가 없다), ORM·SQLAlchemy 방언, 서버 쪽 변경은 이 계획의 범위 밖이다.
- 지원 Python : 3.2 이상 모든 버전. 한 소스로 3.2 부터 최신 안정판까지 돈다. (이 PC 에는 하한 3.2 와 최신 3.13.1 이 모두 있다. 아래 "이 PC 의 시험 환경")

## 이 PC 의 시험 환경

| 구분 | 경로 | 버전 | 비고 |
|---|---|---|---|
| 하한 | `C:\Python\Py302\python.exe` | 3.2 (r32:88445, 2011-02-20, MSC v.1500 64비트) | OpenSSL **1.0.0a**(2010-06), `unicodedata` 6.0.0, **pip·setuptools 없음**(`distutils` 는 있음) |
| 최신 | `C:\Python\python.exe` (PATH 의 `python`) | 3.13.1 | OpenSSL 3.0.15 |

- 이 경로는 **이 PC 에만 해당**한다. 소스와 시험에 경로를 적지 않는다. 다른 장비에서도 돌 수 있게, 인터프리터 경로를 인자나 환경 변수로 받아 버전마다 전체 시험을 돌리는 실행 스크립트를 PY-1 에서 만든다.
- 3.2 로 직접 확인한 것 (2026-10-16. 읽기 전용 조사 스크립트로 확인)
  - **없다** : `time.monotonic`·`perf_counter`, `hmac.compare_digest`, `hashlib.pbkdf2_hmac`, `collections.abc`, `unittest.mock`, `unittest.TestCase.subTest`, `selectors`, `enum`, `pathlib`, `typing`, `ipaddress`, `shutil.which`, `subprocess.DEVNULL`·`run`, `str.casefold`, `bytes.hex`, `datetime.timestamp`·`fromisoformat`,
    `ConnectionResetError`·`FileNotFoundError`, `json.JSONDecodeError`, `ssl.create_default_context`, `ssl.PROTOCOL_TLS`, `ssl.PROTOCOL_TLSv1_1`·`PROTOCOL_TLSv1_2`, `SSLContext.check_hostname`·`minimum_version`, `venv`, `asyncio`
  - **된다** : `ssl.SSLContext`, `OP_NO_SSLv2`·`OP_NO_SSLv3`, `ssl.match_hostname`(DNS 이름만), `datetime.timezone`, `int.to_bytes`·`from_bytes`, `concurrent.futures`, `socket` 과 `tempfile.TemporaryDirectory` 의 컨텍스트 관리자, `os.makedirs(exist_ok=True)`, `Thread.daemon` 속성, `functools.lru_cache`, `{}` 자동 번호, `unicodedata.normalize("NFKC")`,
    `hmac.new`+`hashlib.sha256`, `binascii.hexlify`, `assertRaisesRegex`, UDP 소켓의 `select.select`. `json.loads` 는 `bytes` 를 거부한다(`str` 만 받음)
  - **`ssl.match_hostname` 은 IP 주소 SAN 을 비교하지 못한다** : SAN 에 `127.0.0.1` 이 있는 인증서도 `127.0.0.1` 로 검증하면 `CertificateError`. 3.2 로 하는 TLS 시험은 인증서의 DNS 이름(`localhost`)으로 접속하거나 PY-4 의 보완 구현이 필요하다
  - **이 3.2 는 TLS 1.1·1.2 를 못 한다**(OpenSSL 1.0.0a). 이 PC 의 3.2 로 SSL 을 시험하려면 서버의 `tcp.ssl.minVersion` 을 `TLSv1` 로 낮춰야 한다 (서버는 구버전을 허용하면 암호 스위트도 함께 허용하고 구동 로그에 경고한다). 3.13 은 서버 기본 설정(`TLSv1.2`)으로 시험한다
  - **pip 와 setuptools 가 없다** : 이 3.2 에는 설치 시험이 불가능하다. 시험은 설치하지 않고 소스 트리(작업 디렉토리 `pythonDriver`)에서 `C:\Python\Py302\python.exe -m unittest discover -s tests` 로 돌린다 (PY-1 에서 실제로 되는지 확인). `setup.py` 는 `setuptools` 를 가져오지 못하면 `distutils.core` 로 물러서게 쓴다
  - 통합 시험이 `rdbms` 를 띄우는 부분은 Node.js 가 필요하며, 그 도우미는 3.2 에서 도는 `subprocess` 만 쓴다 (`DEVNULL` 은 `open(os.devnull)` 로)

## 세부 계획

순서의 이유 : 쓸 수 있는 드라이버를 빨리 얻도록 TCP 로 DB-API 까지 끝낸 뒤(PY-3), TLS 와 UDP 를 더한다. UDP 의 신뢰성 계층(PY-5)이 가장 크고 위험하지만 가장 덜 쓰이므로 마지막에 둔다.
접속 경로는 전송 계층 인터페이스(`send(메시지)`, `recv() → 메시지`, `close()`) 뒤에 숨겨 DB-API 계층이 경로를 모르게 한다.

### PY-1. 패키지 구성과 호환 계층

- [ ] 디렉토리 구성 : `helloworlddb/`(패키지), `tests/`, `setup.py`, `README.md`, `.gitignore`(`__pycache__`, `build`, `dist`, `*.egg-info`). 이름은 "미결 사항" 2 가 정해지면 확정한다
- [ ] `setup.py` : `python_requires=">=3.2"`, 외부 의존 없음, 순수 파이썬(`py3-none-any`) 휠. `setup.py` 자체도 3.2 문법으로 쓰고, `setuptools` 가 없으면 `distutils.core` 로 물러선다 (이 PC 의 3.2 에는 setuptools 가 없다)
- [ ] 버전별 시험 실행 스크립트 : 인터프리터 경로를 인자나 환경 변수로 받아 같은 시험을 여러 버전으로 돌린다. 이 PC 에서는 `C:\Python\Py302\python.exe` 와 `python`(3.13.1). 경로를 소스에 적지 않는다
- [ ] `_compat.py` : 버전 차이를 한곳에서 흡수한다. 다른 모듈은 이것만 통해 쓴다 (아래 "Python 3.2 범위 주의 목록")
  `monotonic()`, `compare_digest()`, `pbkdf2_hmac()`(3.4 미만은 순수 파이썬), `hexlify`/`unhexlify`, `collections.abc`, 소켓 오류 분류(errno 기반), `which()`
- [ ] `unittest` 구성 : `python -m unittest discover -s tests` 가 3.2 에서 돈다. `unittest.mock`, `subTest` 를 쓰지 않는다
- [ ] 소스 호환성 시험 `tests/test_source_compat.py` : 소스 전체를 `ast` 와 `tokenize` 로 읽어 3.2 에 없는 문법(f-문자열, `yield from`, `async`/`await`, 변수 주석, `u''` 접두, `raise ... from None`)과 import(3.2 에 없는 표준 모듈)를 찾는다. 3.2 인터프리터가 없는 장비에서도 이 시험이 최소한을 지킨다 (이 PC 에서는 실제 3.2 로도 전체 시험을 돈다)
- [ ] 통합 시험 도우미 `tests/rdbms_instance.py` : 임시 설치 디렉토리에 시험용 포트의 config.json 을 쓰고 `rdbms` 를 `hwdb start` 로 띄웠다가 `hwdb stop` 으로 끝낸다 (`HWDB_INSTALL_DIR` 환경 변수. [rdbms/docs/cli.md](../rdbms/docs/cli.md) 1절).
  `node` 와 빌드된 `rdbms/dist` 가 없으면 통합 시험을 건너뛰고 이유를 보여 준다. TCP·UDP 가 모두 비어 있는 포트를 고른다 (Windows 의 제외 포트 범위 때문. `rdbms/test/net/helpers.ts` 의 `freePort`)

### PY-2. 프로토콜 코어 (TCP)

- [ ] 프레임 : 본문 길이(uint32 빅엔디언) + UTF-8 JSON. 길이는 본문을 모으기 **전에** 검사한다 (인증 전 64 KiB, 후 16 MiB). 한 번에 여러 메시지가 오거나 나뉘어 와도 처리한다 (상세 8, 프로토콜 2-1)
- [ ] 메시지 : 요청 `id`(1부터) 와 응답 짝짓기, `id: 0` 의 서버 오류(서버 종료 `57P01`, 유휴 시간 초과 `57P05`)로 접속 닫힘 처리, 끊기면 `08006`. 한 접속에서 동시에 요청 하나만 둔다 (아래 "동시성")
- [ ] 핸드셰이크와 버전 협상 (`versions: [1]`, `helloOk` 확인)
- [ ] SCRAM-SHA-256 (프로토콜 7절) : 사용자 이름 이스케이프(`=2C`, `=3D`), 난수 nonce(`os.urandom`), 비밀번호는 **NFKC 정규화**(SASLprep 아님), PBKDF2-HMAC-SHA256,
  서버 nonce 가 자기 nonce 로 시작하고 더 긴지, 반복 횟수 1 ~ 10,000,000, 서버 서명 검증(상수 시간 비교). 하나라도 어긋나면 접속을 끊고 `08006`. RFC 7677 시험 벡터로 검증한다
- [ ] 실행 `execute`(`fetchSize` 선택), `fetch`, `closeCursor`, `ping`, `close`(응답 `bye.rolledBack` 을 기록해 둔다)
- [ ] 오류 응답을 예외로 : `sqlState`, `code`, `message`, `position`(줄·칸·offset)을 예외 속성으로 싣는다 (예외 계층은 PY-3)
- [ ] 연결 제한 시간, 응답 제한 시간 옵션 (문장이 잠금을 기다리면 서버 설정 `transaction.lockTimeoutMs`(기본 30초)까지 걸리므로 응답 제한 시간의 기본은 없음)
- [ ] 시험 : 가짜 서버(소켓 쌍)로 프레임·부분 읽기·크기 초과·검증 실패를 단위 시험하고, 실제 `rdbms` 로 로그인·질의·대량 결과·오류를 통합 시험한다

### PY-3. DB-API 2.0 계층

- [ ] 모듈 수준 : `apilevel = "2.0"`, `threadsafety = 2`, `paramstyle = "qmark"`(서버의 `?` 와 같다), `connect()`, 예외 클래스 전부, 생성자(`Date`, `Time`, `Timestamp`, `DateFromTicks`, `TimeFromTicks`, `TimestampFromTicks`, `Binary`), 타입 객체(`STRING`, `BINARY`, `NUMBER`, `DATETIME`, `ROWID`)
- [ ] 예외 계층과 SQLSTATE 매핑 (아래 "예외 매핑"). 드라이버 자신이 내는 오류는 `InterfaceError`(닫힌 접속·커서 사용 등), `ProgrammingError`(파라미터 개수·형 오류)
- [ ] `Connection` : `cursor()`, `commit()`, `rollback()`, `close()`, `autocommit` 속성, `tablespace`·`time_zone`·`closed` 속성, 컨텍스트 관리자(`with`. 끝에서 커밋 또는 롤백, 닫지는 않음), 예외 클래스를 속성으로 노출(PEP 249 확장)
  **자동 커밋은 처음에 끈다** (PEP 249 : 처음에는 꺼져 있어야 한다). 접속 직후 `SET AUTOCOMMIT OFF` 를 보낸다. `connect(autocommit=True)` 로 켤 수 있다. 서버의 기본은 켜짐이므로 이 차이를 README 에 적는다
- [ ] `Cursor` : `execute`, `executemany`(서버가 한 요청에 한 문장만 받으므로 행마다 `execute`), `fetchone`, `fetchmany`(`arraysize`), `fetchall`, `description`(7항목. 질의 결과에는 NULL 허용 여부가 없으므로 `null_ok` 는 `None`), `rowcount`, `arraysize`,
  `close`, `setinputsizes`·`setoutputsize`(무동작), `callproc`(`NotSupportedError`), `nextset`(`None`), 반복(`for row in cursor`), 컨텍스트 관리자
- [ ] 결과 나누어 받기 : 첫 묶음 뒤의 행은 `fetch` 로 필요할 때 가져온다. **서버 커서는 접속당 16개**이므로 같은 `Cursor` 의 새 `execute`, `close`, 객체 소멸(`__del__`) 때 남은 서버 커서를 `closeCursor` 한다. 접속을 닫으면 서버가 모두 버린다
- [ ] 타입 변환 (아래 "타입 대응") : 받은 값 → Python 값, 파라미터 → 서버 `Param`. 컬럼 메타데이터(`typeName`, `startField`, `endField` 등)에 따라 바꾼다
- [ ] `connect()` 옵션 (아래 "연결 옵션")
- [ ] 시험 : PEP 249 항목별 시험(모듈 속성, 예외 계층, 각 메서드의 규약, 트랜잭션 의미), 타입 왕복 시험, 오류 매핑 시험. 서버가 모든 SQLSTATE 를 내는 시나리오를 만들기 어려우므로 매핑 표 자체는 단위 시험으로 확인한다

### PY-4. TLS

- [ ] `ssl` 모듈로 TCP 를 TLS 로 감싼다. 서버 인증서는 **기본으로 검증**한다. 신뢰할 CA 지정(`ssl_ca`)과 검증 끄기(`ssl_verify=False`)를 함께 제공한다 (상세 8)
- [ ] **재시도 규칙** : 인증서 오류로 핸드셰이크가 실패하면 연결을 닫고 100 ms 뒤 새 연결로 다시 시도한다. 최대 2회. 재시도에서도 검증은 그대로 한다. 인증서 오류가 아닌 실패(연결 거부, 시간 초과, 끊김, TLS 버전 불일치, 서버가 TLS 가 아님)에는 재시도하지 않는다. 모두 실패하면 `08001` 에 해당하는 `OperationalError`(내부 번호 8007)이고 메시지에 시도 횟수와 원인을 싣는다 (프로토콜 2-2절)
- [ ] 인증서 오류 분류 : Python 버전마다 예외가 다르다 (`ssl.SSLError` 의 `reason`/`verify_code`, `ssl.CertificateError`, 3.7+ 의 `ssl.SSLCertVerificationError`). 한곳에서 "인증서 오류인가" 를 판정한다
- [ ] 호스트 이름 검증 : `SSLContext.check_hostname`(3.4+)이 있으면 그것을, 없으면 `ssl.match_hostname`(3.2 ~ 3.11)을 쓴다. 3.12 부터 `match_hostname` 이 없고, 3.2 ~ 3.4 는 IP 주소 SAN 을 비교하지 못한다 (3.5 에서 추가. 이 PC 의 3.2 에서 실패를 확인했다). IP 로 접속하는 구버전을 위한 보완을 구현 때 버전별로 확인해 정한다
- [ ] TLS 버전 : 3.2 ~ 3.5 는 `PROTOCOL_SSLv23` 과 `OP_NO_SSLv2`·`OP_NO_SSLv3`, 3.6+ 는 `PROTOCOL_TLS`, 3.7+ 는 `PROTOCOL_TLS_CLIENT` 와 `minimum_version` 으로 맞춘다. 옛 Python 이 링크한 OpenSSL 이 TLS 1.2 를 못 하면 서버의 `tcp.ssl.minVersion` 을 `TLSv1` 로 낮춰야 한다 (자바 6 과 같은 문제. 사용 설명서에 적는다). **이 PC 의 3.2 는 OpenSSL 1.0.0a 라 TLS 1.2 를 못 하는 것을 확인했다.** 3.2 의 SSL 시험은 서버를 `TLSv1` 로 낮춘 설정으로, 3.13 은 기본 설정(`TLSv1.2`)으로 한다
- [ ] 시험 : `rdbms/test/fixtures/tls/` 의 시험용 인증서로 신뢰하는 CA, 신뢰하지 않는 인증서(재시도 2회 뒤 실패), 이름이 다른 인증서, 검증 끄기, 평문 서버에 TLS 접속
- [ ] 이 PC 의 3.2 : 서버가 `TLSv1` 설정에서 이 클라이언트(OpenSSL 1.0.0a)의 TLS 1.0 접속을 실제로 받는지, 시험용 인증서(RSA 2048, SHA-256 서명)를 이 클라이언트가 검증하는지 확인한다. 어긋나면 `rdbms/PROGRESS.md` 에 적는다

### PY-5. UDP

신뢰성 계층의 클라이언트 쪽이다 (프로토콜 2-4절, 참고 구현 `rdbms/src/net/udpReliability.ts`, `rdbms/src/client/udpTransport.ts`).

- [ ] 패킷 코덱 : 헤더 20바이트(매직 `0x4857`, 버전 1, 플래그 `SYN`·`ACK`·`DATA`·`FIN`·`RST`, 세션 번호, `seq`, `fragIndex`, `fragCount`, `ackSeq`). 해석할 수 없는 패킷은 조용히 버린다
- [ ] 송신자 : 한 번에 메시지 하나만 전송 중, 메시지당 미확인 조각 32개, 조각별 재전송 타이머(RFC 6298 RTO. 초기 300 ms, 50 ms ~ 3 s, 재전송마다 2배, Karn), 한 조각이 10번 재전송되고도 ACK 가 없으면 접속 실패(`08006`), 누적 확인(`ackSeq`)
- [ ] 수신자 : `expectedSeq`, 조각 표, 중복(`seq < expectedSeq`)은 버리되 ACK 는 다시 보냄, 조각마다 즉시 ACK, 조각 수·누적 크기 한도 검사
- [ ] 세션 : 첫 메시지 `SYN|DATA`(`sessionId` 0, `seq` 1), 서버의 첫 패킷에서 세션 번호를 배움, 다른 번호는 버림, `RST`/`FIN` 이면 접속 끝, 닫을 때 `FIN`
- [ ] 패킷 크기 : 처음 1200, `helloOk.udp.maxPacketSize` 와 비교해 작은 값. 조각 수가 65,535 를 넘는 메시지는 보내지 않고 `54000`
- [ ] 세션 유지 : 유휴 상태에서 `sessionTimeoutMs / 3` 마다 `ping` (`helloOk.udp.sessionTimeoutMs`). `ping` 은 서버의 유휴 세션 종료를 되돌리지 않는다
- [ ] 구조 : 상태 기계로 쓰고 **시계와 패킷 통로를 주입**할 수 있게 한다 (`rdbms` 의 시험 방식). 가짜 시계와 유실·중복·지연·순서 뒤바뀜을 일으키는 시뮬레이터로 결정적인 시험을 한다 (시드를 바꿔 여러 번)
- [ ] 서로 맞는지의 시험 : `rdbms` 의 TypeScript 구현이 만든 패킷 바이트를 고정 자료(`tests/fixtures`)로 보관해 Python 코덱이 같은 바이트를 만들고 읽는지 본다. 자료를 만드는 방법을 같이 적는다
- [ ] 연결된 UDP 소켓에서 "도달 불가" 오류(ICMP. Windows 는 `WSAECONNRESET`)를 처음 응답을 받기 전이면 서버가 없는 것으로 본다 (소켓 오류는 errno 로 분류. 3.2 에는 `ConnectionResetError` 가 없다)
- [ ] 통합 시험 : 실제 `rdbms` 와 손실·중복 프록시(`rdbms/test/net/udpProxy.ts` 를 본뜬 Python 프록시)로 유실 15 ~ 25 %, 중복 10 ~ 100 % 에서 로그인·질의·3,000행 결과·트랜잭션이 통과해야 한다

### PY-6. 문서와 검증

- [ ] README : 설치, 접속, 질의, 트랜잭션, SSL, UDP 의 주의, 오류 처리 예제. **Hello World 예제는 몇 줄 안에 끝나야 한다** (AGENTS.md 개요 13). 자동 커밋 기본값이 서버와 다른 점, DDL 이 자동으로 커밋되는 점(상세 10), 첫 접속 때 SYSTEM 초기 암호를 바꾸는 절차를 적는다
- [ ] 통합 테스트 : TCP, SSL, UDP 각각으로 로그인, 질의, 파라미터, 대량 결과, 트랜잭션(커밋·롤백·세이브포인트), 오류(문법, 제약, 권한, 교착·잠금 시간 초과), 접속 끊김(서버 종료 중 요청)
- [ ] 동시성 : 한 접속을 여러 스레드가 공유(`threadsafety = 2`), 스레드마다 접속을 따로 연 10개 접속이 같은 테이블에 조회·변경 (상세 9)
- [ ] 타입 왕복 시험 : 타입별 경계값(BIGINT 최소·최대, `DECIMAL(38,s)`, 빈 문자열과 NULL, 날짜 0001-01-01 ~ 9999-12-31, 마이크로초, 시간대, INTERVAL, 이진, 안전 정수를 넘는 정수 파라미터)
- [ ] 3.2(`C:\Python\Py302`)와 최신 3.13.1 에서 같은 소스로 전체 시험 통과 (이 PC). 다른 장비에서 3.2 를 구하지 못하면 가장 낮게 구한 버전과 `test_source_compat` 으로 대신하고 그 한계를 이 문서에 적는다
- [ ] 휠과 소스 배포본을 만들어 최신 Python 의 깨끗한 가상 환경에 설치해 Hello World 를 실행한다. 이 PC 의 3.2 에는 pip 이 없어 설치 시험을 못 하므로 소스 트리 실행(`distutils` 로 `setup.py` 가 도는지 포함)으로 대신한다
- 완료 기준 : 실제 `rdbms` 를 띄워 수행하는 통합 테스트 통과(TCP, SSL, UDP. UDP 는 유실·중복 조건 포함). PEP 249 항목별 시험 통과. 3.2 와 최신 Python 에서 같은 소스 통과.

## 설계 초안 (확정 전)

사용자가 달리 정하지 않으면 이대로 진행한다. 정해지면 "결정 사항" 으로 옮긴다.

### 패키지 이름과 구성

- 배포 이름(`setup.py` 의 `name`) : `org.duckdns.hjow.helloworlddb.pythondriver` (AGENTS.md 지켜야 할 사항 6 의 규칙을 따른 것. pip 은 `-` 로 바꾸어 다룬다). import 이름 : `helloworlddb`.
  규칙 6 이 Node.js 와 자바만 말하므로 Python 에 어떻게 적용할지는 "미결 사항" 2.
- 모듈 : `__init__.py`(DB-API 모듈 수준), `connection.py`, `cursor.py`, `errors.py`(예외와 SQLSTATE 매핑), `types.py`(변환, 생성자, 타입 객체), `_protocol.py`(메시지, 프레임), `_scram.py`, `_tcp.py`, `_tls.py`, `_udp.py`(패킷 코덱, 신뢰성 계층, 전송), `_compat.py`
  의존 방향 : `_compat` ← 나머지. `connection` 이 전송 계층 인터페이스만 안다. `errors` 와 `types` 는 전송 계층을 모른다.

### 동시성

- `threadsafety = 2` : 스레드가 모듈과 `Connection` 을 공유할 수 있고 `Cursor` 는 공유하지 않는다. `Connection` 이 요청 단위로 잠금을 잡는다. 프로토콜은 한 접속의 요청을 순서대로 처리하므로 한 번에 요청 하나로 충분하다.
- TCP 는 블로킹 소켓과 읽기 루프이다. 별도 스레드가 없다. 서버가 먼저 보내는 `id: 0` 오류는 다음 요청의 읽기에서 만나 그 오류를 올린다.
- UDP 는 재전송 타이머와 ACK 처리가 필요하므로, 응답을 기다리는 호출이 `select` 로 소켓을 읽다가 다음 RTO 시각에 깨어나 재전송하는 방식(호출 스레드가 직접 돌린다)으로 한다. 세션 유지용 `ping` 만 데몬 스레드가 보낸다 (같은 잠금 아래에서, 사용 중이면 건너뜀). 3.2 에는 `selectors` 가 없으므로 `select.select` 를 쓴다.

### 연결 옵션

`connect(host="127.0.0.1", port=7410, user=None, password=None, tablespace=None, time_zone=None, udp=False, ssl=False, ssl_ca=None, ssl_verify=True, autocommit=False, fetch_size=None, connect_timeout=10, timeout=None)`

- 접속 대상은 호스트와 포트 번호만이다. SID 나 DB 이름에 해당하는 항목은 없다 (상세 15). `host`, `port` 는 생략할 수 있다. `user`, `password` 는 필요하다.
- `tablespace` : 접속 직후의 현재 테이블스페이스. `hwdb -t` 와 같이 SQL 식별자 규칙으로 바꾸어 보낸다 (따옴표 없으면 대문자, 큰따옴표면 그대로. 프로토콜의 `authStart.tablespace` 는 저장된 이름 그대로를 받는다. 루트 PROGRESS.md "공통 인수인계 사항"). 사용자 이름은 서버가 대문자로 찾아 주므로 바꾸지 않는다.
- `udp=True` 와 `ssl=True` 는 함께 쓸 수 없다 (SSL 은 TCP 에만 적용된다). `ssl_ca` 와 `ssl_verify=False` 도 함께 쓸 수 없다. `rdbms` 의 `hwdb` 옵션 규칙과 같다.
- 현재 테이블스페이스가 없는 세션(`tablespace` 가 `None`)이 있다. 이름에 테이블스페이스를 붙이지 않은 문장은 서버가 `3F000` 으로 거부하며 `ProgrammingError` 이다.

### 예외 매핑

PEP 249 의 계층(`Error` → `InterfaceError`, `DatabaseError` → `DataError`·`OperationalError`·`IntegrityError`·`InternalError`·`ProgrammingError`·`NotSupportedError`)을 따르고, 모든 `Error` 에 `sqlstate`, `code`(서버의 내부 오류 번호), `position`(줄·칸·offset, 없으면 `None`)을 둔다. 서버 메시지는 번역하지 않는다.
서버가 실제로 내는 SQLSTATE 기준이다. 그 밖(표에 없는 값)은 `DatabaseError` 이다.

| 예외 | SQLSTATE |
|---|---|
| `NotSupportedError` | `0A000` |
| `InterfaceError` | `08P01`(프로토콜 위반), 드라이버의 잘못된 사용 |
| `OperationalError` | `08001`·`08003`·`08006`(접속), `28000`(인증), `40001`·`40P01`(롤백된 트랜잭션. 같은 접속에서 다시 시도), `53300`·`53400`·`54000`·`54001`·`54011`(자원·한도), `55006`·`55P03`(사용 중·잠금 시간 초과), `57P01`·`57P05`(서버 종료·유휴 종료), `58030`(입출력) |
| `DataError` | `22xxx` 전부 (범위 초과, 형식 오류, 0 으로 나눔, 길이 초과 등) |
| `IntegrityError` | `23502`·`23503`·`23505` |
| `InternalError` | `25001`·`25P01`(트랜잭션 상태), `34000`(커서 없음), `XX000`·`XX001` |
| `ProgrammingError` | `07001`(파라미터 개수), `0LP01`·`21000`, `3B001`(없는 세이브포인트), `3D000`·`3F000`(없는 테이블스페이스·현재 테이블스페이스 없음), `42xxx`(문법, 이름, 권한 `42501`, 객체 없음·중복) |

### 타입 대응

수신은 컬럼 메타데이터의 `typeName` 으로, 송신은 Python 값의 형으로 바꾼다. 날짜시간은 Python 의 `datetime` 이 마이크로초와 0001 ~ 9999 년을 담으므로 정밀도를 잃지 않는다 (`nodejsDriver` 의 `Date` 와 다르다).

| DB 타입 | 받을 때 | 보낼 때 |
|---|---|---|
| CHAR, VARCHAR (NCHAR, NVARCHAR 포함) | `str` | `str` |
| BINARY, VARBINARY | `bytes` (서버는 대문자 16진 문자열) | `bytes`·`bytearray`·`memoryview` → `{"binary": "AB12"}` |
| SMALLINT, INTEGER, BIGINT | `int` (BIGINT 는 문자열로 옴) | `int`. 안전 정수(±2^53-1)를 넘으면 **문자열**로 (서버는 JSON 숫자로 온 큰 정수를 `22003` 으로 거부한다) |
| NUMERIC, DECIMAL | `decimal.Decimal` (자릿수 유지. `"1.50"` → `Decimal("1.50")`) | `Decimal` → 지수 없는 문자열. NaN·무한대는 `DataError` |
| REAL, DOUBLE PRECISION, FLOAT | `float` | `float` (유한한 값만) |
| BOOLEAN | `bool` | `bool` (`int` 보다 먼저 판정) |
| DATE | `datetime.date` | `date` |
| TIME(p) | `datetime.time` | `time` |
| TIME WITH TIME ZONE | 오프셋이 있는 `time` (`datetime.timezone`) | 오프셋이 있는 `time` |
| TIMESTAMP(p) | `datetime.datetime` | `datetime` |
| TIMESTAMP WITH TIME ZONE | 오프셋이 있는 `datetime` | 오프셋이 있는 `datetime` (분 단위가 아닌 오프셋은 `DataError`) |
| INTERVAL 일-시간 계열 | `datetime.timedelta` (한정자 `startField`/`endField` 로 `D HH:MM:SS.ffffff` 형태를 읽음. 음수는 앞의 `-`) | `timedelta` → INTERVAL 문자열 (서버가 받는 형태를 PY-3 에서 확인) |
| INTERVAL 연-월 계열 | (미결 사항 4) 표준 표기 `str` (`"1-02"`, `"-3"`) | `str` |
| NULL | `None` | `None` |

- 모르는 형의 파라미터는 `ProgrammingError` 이다. 파라미터는 순서열(qmark)만 받고, 딕셔너리는 `ProgrammingError` 이다.
- 타입 객체 : `STRING`(CHAR, VARCHAR), `BINARY`(BINARY, VARBINARY), `NUMBER`(정수·고정소수·부동소수), `DATETIME`(DATE, TIME, TIMESTAMP, 시간대 있는 것 포함), `ROWID`(해당 타입 없음). `description` 의 `type_code` 는 이들과 `==` 로 비교된다. 정확한 타입 이름이 필요하면 `type_code` 가 정규 타입 이름(`"VARCHAR"`, `"TIMESTAMP WITH TIME ZONE"`)을 담는다.
- `description` 의 `internal_size` 는 컬럼 메타데이터의 `length`, `precision`·`scale` 도 거기서 가져온다. 선언 인자를 모두 생략한 DECIMAL 은 (10,3), VARCHAR 는 65,535 이지만 이 값은 서버 메타데이터를 따르며 드라이버가 기본값으로 바꾸지 않는다 ([rdbms 타입 정책](../rdbms/docs/data-types.md)).
- `rowcount` : DML 은 서버의 `rowCount`, 그 밖은 `-1`. 조회는 `-1` 이다 (PEP 249 가 정한 "알 수 없음").

## Python 3.2 범위 주의 목록

3.2 에서 쓸 수 없는 것 중 실수하기 쉬운 것들이다 (Python 문서의 "New in version" 표기 기준. 이 PC 의 3.2 로 주요 항목을 직접 확인했다 : "이 PC 의 시험 환경". 구현 때 `test_source_compat` 이 일부를 기계로 검사한다).
`jdbc6` 의 "자바 6 범위 주의 목록" 과 같은 역할이다.

- 문법 : 문자열 `u''` 접두(3.3), `yield from`(3.3), `raise ... from None`(3.3), `async`/`await`(3.5), f-문자열(3.6), 변수 주석(3.6). 암묵적 네임스페이스 패키지(3.3)가 없으므로 모든 디렉토리에 `__init__.py` 를 둔다
- 표준 라이브러리 (3.3 이후) : `time.monotonic`·`perf_counter`, `hmac.compare_digest`, `collections.abc`(3.2 는 `collections.Mapping` 등), `unittest.mock`, `ipaddress`, `shutil.which`, `subprocess.DEVNULL`, `print(flush=)`, `Thread(daemon=)`(속성 `thread.daemon = True` 는 쓸 수 있다), `ConnectionError`·`FileNotFoundError` 등 OS 오류 하위 클래스(3.2 는 `socket.error`/`IOError` 와 `errno`), `str.casefold`, `datetime.timestamp()`
- 표준 라이브러리 (3.4 이후) : `hashlib.pbkdf2_hmac`, `selectors`, `enum`, `pathlib`, `ssl.create_default_context`, `SSLContext.check_hostname`, `unittest` 의 `subTest`
- 표준 라이브러리 (3.5 이후) : `typing`, `bytes.hex()`, `json.JSONDecodeError`(그 전에는 `ValueError`), `subprocess.run`, `bytes` 의 `%` 서식, `ssl.match_hostname` 의 IP 주소 비교, EINTR 자동 재시도(PEP 475 : 그 전에는 시그널이 소켓 호출을 `EINTR` 로 끊을 수 있어 직접 다시 시도한다)
- 3.6 이후 : `secrets`, `ssl.PROTOCOL_TLS`. 3.7 이후 : `datetime.fromisoformat`, `SSLContext.minimum_version`, `PROTOCOL_TLS_CLIENT`. 날짜시간 문자열은 직접 해석한다
- 3.2 에서 되는 것 : `ssl.SSLContext`·`match_hostname`, `datetime.timezone`, `int.to_bytes`/`from_bytes`, `concurrent.futures`, `socket` 과 `tempfile.TemporaryDirectory` 의 컨텍스트 관리자, `unittest` 의 `assertRaisesRegex`·`skipIf`·`setUpClass`, `os.makedirs(exist_ok=True)`, `functools.lru_cache`, `str.format` 의 `{}` 자동 번호
- 새 Python 에서 사라진 것 : `ssl.wrap_socket`·`ssl.match_hostname`·`distutils`·`asyncore`·`imp`(3.12), `unittest` 의 `assertEquals`·`assertRaisesRegexp` 같은 옛 별칭(3.12), `unittest.makeSuite`(3.13), `collections.Mapping`(3.10), `Thread.isAlive`(3.9), `time.clock`(3.8). 3.2 에서 되는 이름(`assertEqual`, `assertRaisesRegex`, `is_alive`)을 쓰고 `ssl` 은 버전을 나누어 쓴다
- 문자 인코딩은 `"utf-8"` 을 명시한다. `json.loads` 는 `str` 만 받으므로(3.6 부터 `bytes`) 먼저 디코딩한다
- 3.2 의 `unicodedata` 는 오래된 유니코드 버전이다 (이 PC 의 3.2 는 6.0.0). 서버의 비밀번호 정규화(NFKC)와 결과가 달라질 수 있는 문자는 "미결 사항" 6 을 본다

## 미결 사항

사용자 확인이 필요한 것은 (확인) 으로 표시했다. 권장안을 같이 적었다.

1. (확인) **일정과 순서**. AGENTS.md "구현 계획" 에 이 프로젝트의 단계가 없다. 권장 : `rdbms` 11단계 뒤에 `nodejsDriver`(12단계)와 병행하거나 그 다음에 착수하고, 정해지면 AGENTS.md 에 절을 더한다. 프로토콜을 한 번 더 써 보면 명세 보완점이 나오므로 `nodejsDriver` 를 먼저 하는 편이 낫다.
2. (확인) **패키지 이름**. 지켜야 할 사항 6 은 Node.js 와 자바만 말한다. 권장 : 배포 이름은 규칙 6 을 따르고 import 이름은 짧게 `helloworlddb`. 규칙을 import 이름에도 적용하면 `org/duckdns/hjow/helloworlddb/pythondriver/` 로 5단계 중첩 패키지가 되고, 3.2 에는 네임스페이스 패키지가 없어 각 단계에 `pkgutil.extend_path` 가 필요하다. 정해지면 AGENTS.md 의 규칙 6 에 Python 을 적는다.
3. **Python 3.2 시험 환경** — *이 PC 에서는 해결* : `C:\Python\Py302\python.exe`(3.2, OpenSSL 1.0.0a, pip·setuptools 없음). "이 PC 의 시험 환경" 절을 본다. 이 PC 가 아닌 장비(다른 개발자의 PC, 자동 시험 환경)에서 3.2 를 구하는 방법은 정하지 않았다. 못 구하면 `test_source_compat` 과 구할 수 있는 가장 낮은 버전으로 대신하고 한계를 적는다.
4. **연-월 INTERVAL 의 Python 표현**. 연-월은 `timedelta` 로 나타낼 수 없다. 권장 : 첫 버전은 표준 표기 `str`. 필요해지면 `years`·`months` 를 가진 작은 클래스를 더한다.
5. **옛 Python 의 TLS**. 이 PC 의 3.2 는 OpenSSL 1.0.0a 라 **TLS 1.2 를 못 하는 것을 확인했다**(`PROTOCOL_TLSv1_2` 가 없다). 그래서 이 3.2 의 SSL 시험에는 서버의 `tcp.ssl.minVersion=TLSv1` 이 필요하다. 남은 확인 : 서버가 그 설정에서 이 클라이언트의 TLS 1.0 접속을 실제로 받는지, 이 클라이언트가 시험용 인증서를 검증하는지(PY-4) (서버는 구버전을 허용하면 암호 스위트도 함께 허용하고 구동 로그에 경고한다. 같은 확인 항목이 [jdbc6/PROGRESS.md](../jdbc6/PROGRESS.md)의 미결 사항에 있다).
6. **NFKC 정규화의 유니코드 버전 차이**. 비ASCII 비밀번호가 서버(Node.js)와 3.2 의 `unicodedata`(이 PC 에서 확인한 버전은 6.0.0)에서 다르게 정규화되는 문자가 있을 수 있다. ASCII 는 같다. 구현 때 시험하고 문서에 적는다.
7. **DB-API 준수 시험 틀**. 널리 쓰이는 비공식 `dbapi20.py` 를 쓸지. 라이선스를 확인하기 전에는 저장소에 넣지 않는다. 쓰지 않으면 PEP 249 항목별 시험을 직접 쓴다 (PY-3).
8. **커넥션 풀과 비동기 API**. DB-API 밖이다. `nodejsDriver` 에는 풀이 있지만 여기서는 첫 버전 범위에서 뺐다. 필요해지면 별도 작업으로 한다 (비동기는 3.5 이상 전용 선택 모듈이 될 것이다).
9. `float` 파라미터가 JSON 에서 정수처럼 보이는 경우(`3.0`, `1e16`)를 서버가 어떻게 해석하는지 PY-3 에서 확인한다 (정수 숫자는 안전 정수 범위를 넘으면 `22003` 이다). 어긋나면 `rdbms/PROGRESS.md` 에 적는다.

## 결정 사항

사양 또는 이전 사용자 결정에서 온 것이다.

- Python 3.2 이상을 지원하고 DB-API 표준을 지킨다 (AGENTS.md 디렉토리 구조 5번).
- 접속은 TCP 와 UDP 이다. 대상은 호스트와 포트 번호만이다 (상세 8, 15). 로컬 전용 채널과 데몬 제어는 CLI 의 몫이다.
- SSL 서버 인증서는 기본으로 검증한다. 인증서 오류 때 접속을 끊고 100 ms 뒤 최대 2회 다시 시도한다. 신뢰할 CA 지정과 검증 끄기 옵션을 둔다. 사용자 결정(2026-10-15)이며 사양은 AGENTS.md 상세 8 이다.
- 서버 오류 메시지는 번역하지 않는다(영문 고정, `sqlState` 와 `code` 가 열쇠). 드라이버 자신의 오류 메시지도 영어이다. 이 드라이버는 화면에 문구를 내지 않으므로 메시지 카탈로그는 두지 않는다 (사용자 결정 2026-10-16 의 원칙. 드라이버와 DB툴도 같은 원칙).
- 외부 패키지에 의존하지 않는다 (AGENTS.md 공통 방침).

## 인수인계 사항

- 이 PC 에서 Python 3.2 는 `C:\Python\Py302\python.exe` 이다. `C:\Python` 은 3.13.1 의 설치 디렉토리(PATH 에 있음)이고 `Py302` 는 그 아래에 따로 둔 3.2 이다. 3.2 를 실행할 때는 전체 경로를 쓴다 (`python` 은 3.13.1 이다).
  이 경로는 이 PC 에만 해당하므로 소스·시험·스크립트에 적지 않고 인자나 환경 변수로 받는다. 3.2 에는 pip·setuptools 가 없어 의존 패키지를 설치할 수 없으므로 표준 라이브러리만 쓰는 방침이 곧 필수 조건이다.
- 프로토콜의 기준은 [rdbms/docs/protocol.md](../rdbms/docs/protocol.md)(버전 1)이다. 구현 전에 15절의 클라이언트 체크리스트와 16절의 알려진 한계를 읽는다. 필드를 더하는 것은 버전을 올리지 않으므로 모르는 필드는 무시한다.
- 같은 프로토콜의 참고 클라이언트 : `rdbms/src/client/connection.ts`(핸드셰이크, SCRAM, 실행, 커서, `ping`, 닫기), `transports.ts`(TCP·TLS, 인증서 오류 판정과 재시도), `udpTransport.ts`(UDP 전송), `rdbms/src/net/udpReliability.ts`(패킷 코덱, 송신자·수신자, RTO), `rdbms/src/auth/scram.ts`(SCRAM 계산).
  서버 모듈을 import 하지 않는 클라이언트라서 Python 으로 옮기기 좋다. 거꾸로 이 드라이버가 서버 모듈을 참고하는 일은 없다.
- 값 표현 : 결과의 값은 JSON 값 그대로 온다 (BIGINT·NUMERIC·날짜시간·INTERVAL 은 문자열, 이진은 대문자 16진 문자열, 나머지는 JSON 기본 타입. 프로토콜 8절). 실제 타입은 `rows.columns` 의 `typeName` 이다. 날짜시간 문자열 형식은 [rdbms/docs/data-types.md](../rdbms/docs/data-types.md)와 `rdbms/src/types/datetime.ts` 의 `formatInterval` 등을 본다 (INTERVAL 은 한정자에 따라 `D HH:MM:SS.f`, `Y-MM`, `D` 처럼 달라진다).
- 인증 : SCRAM-SHA-256 은 비밀번호를 SASLprep 대신 **NFKC** 로 정규화하고 서버 기본 반복 횟수는 4096 이다. 채널 바인딩은 쓰지 않는다(gs2 헤더 `n,,`, `c=biws`). 인증 실패는 사용자 없음·비밀번호 틀림이 같은 오류(`28000`)이며 서버가 접속을 끊는다.
- 서버 규칙 중 드라이버가 알아야 할 것 : 한 요청에 문장 하나, 커서는 접속당 16개, 요청 대기열 64개, 파라미터 65,535개, 메시지 16 MiB(인증 전 64 KiB). 문장 오류는 접속을 끊지 않고, 교착(`40P01`)이면 서버가 이미 롤백했으며 같은 접속으로 다시 시도한다.
  DDL·GRANT·REVOKE·사용자·테이블스페이스 문장은 실행 전후에 자동 커밋된다 (상세 10). 격리 수준은 READ COMMITTED 하나이다.
- 권한 : SYSTEM 계정은 CONNECT 권한 그룹이 없어 처음에는 **루프백 주소에서만** 접속된다. 시험은 `127.0.0.1` 로 한다. 원격 접속은 `GRANT CONNECT` 가 필요하다 ([rdbms/docs/accounts-and-privileges.md](../rdbms/docs/accounts-and-privileges.md)). SYSTEM 의 초기 암호는 `HelloWorldDB` 이다.
- 시험 자료 : TLS 시험용 인증서 `rdbms/test/fixtures/tls/`(자체 서명, `localhost`·`127.0.0.1`·`::1`. 사용법은 그 디렉토리의 README), UDP 손실 시험의 방식은 `rdbms/test/net/udpSim.ts`(가짜 시계와 시뮬레이터)와 `udpProxy.ts`(실제 소켓용 손실 프록시).
  `rdbms` 는 빌드된 결과(`rdbms/dist`)로 띄운다. (`npm run build`. Node.js 22 이상 또는 bun)
- `rdbms` 는 `hwdb start` 로 데몬을 띄우고 `hwdb stop` 으로 끝낸다. 시험용 설치 디렉토리는 `HWDB_INSTALL_DIR` 로 바꾼다 ([rdbms/docs/cli.md](../rdbms/docs/cli.md)). 같은 포트 번호의 인스턴스를 둘 띄울 수 없으므로 시험마다 빈 포트를 고른다.
- DECIMAL/DEC/NUMERIC 의 선언 인자를 모두 생략하면 (10,3), VARCHAR/NVARCHAR 의 최대·기본 길이는 65,535 이다. 실제 컬럼의 길이·정밀도·소수 자릿수는 서버 메타데이터를 따르고 결과 값을 기본값에 맞춰 다시 가공하지 않는다.
- `gui` 는 보류 중이며 `nodejsDriver` 를 쓴다. 이 드라이버를 쓰는 프로젝트는 아직 없다.

## 작업 이력

- 2026-10-16 : 개발 계획 작성. AGENTS.md 와 `rdbms` 프로토콜 명세, SCRAM·UDP 참고 구현, 타입 문서를 읽고 PY-1 ~ PY-6 으로 나누었다. DB-API 2.0 대응, 예외 매핑, 타입 대응, Python 3.2 범위 주의 목록, 미결 사항을 정리했다. 코드는 없다.
- 2026-10-16 : 이 PC 의 Python 3.2 가 `C:\Python\Py302\python.exe` 에 있음을 반영했다(사용자 안내). 실제로 실행해 3.2 / OpenSSL 1.0.0a / `unicodedata` 6.0.0 / pip·setuptools 없음을 확인하고, 계획의 3.2 가정(없는 것·되는 것 목록, `match_hostname` 의 IP 주소 SAN 비교 실패)을 직접 검증했다.
  "이 PC 의 시험 환경" 절을 더하고 PY-1(버전별 시험 실행 스크립트, `setup.py` 의 `distutils` 대비), PY-4(이 3.2 는 TLS 1.2 불가 → 서버 `TLSv1` 로 시험), PY-6(3.2·3.13 양쪽 통과, 설치 시험은 3.13 만), 미결 사항 3·5·6 을 고쳤다.
