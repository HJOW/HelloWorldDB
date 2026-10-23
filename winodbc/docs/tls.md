# TLS 전송

WO-10의 구현 규칙이다. [서버 규약 2-2절](../../rdbms/docs/protocol.md#2-2-tls-tcp)과
[클라이언트 검증 규칙](../../rdbms/docs/protocol.md#2-2-tls-tcp)을 Schannel로 구현한다.
OpenSSL DLL을 추가하지 않으며 `secur32.lib`·`crypt32.lib`(Windows 제공)만 쓴다.

## 전송 연결

- `tls_transport()`는 TCP 연결 뒤 TLS 핸드셰이크와 인증서 검증을 마친 `Transport`를 돌려준다.
  이후의 `send`·`receive`는 평문 프레임(4바이트 길이 + JSON)을 TLS 레코드로 암호화·복호화할 뿐
  메시지 규약·세션·인증·권한 동작은 평문 TCP와 같다.
- DNS 조회·연결·핸드셰이크에 로그인 제한 시간을 누적 적용한다. 단계마다 새로 시작하지 않는다.
- TLS 1.2와 1.3 클라이언트로 협상한다(`SP_PROT_TLS1_2_CLIENT | SP_PROT_TLS1_3_CLIENT`).
  구버전 TLS 요구(자바 6용 `TLSv1` 낮춤)는 이 드라이버에 추가하지 않는다. 서버 기본값(TLSv1.2 이상)과 시험한다.
- `SSL`은 TCP에만 적용된다. `Transport=UDP`와 함께 지정하면 `HYC00`으로 거부한다. UDP 구간은 암호화하지 않는다.

## 인증서 검증

- 검증을 기본으로 켠다. 끄는 것은 `SSLVERIFY=false` 명시 옵션에서만 허용한다.
- 검증은 수동 경로로 한다. Schannel 자동 검증을 켜지 않고(`SCH_CRED_MANUAL_CRED_VALIDATION`)
  체인을 직접 만들고 SSL 정책으로 확인한다. "Schannel 암호화가 켜짐"만으로 검증을 마쳤다고 판단하지 않는다.
  - `SSLCA`가 없으면 시스템 저장소를 신뢰한다. 지정하면 그 PEM 파일의 인증서들만 배타적 루트로 신뢰하고
    시스템 저장소는 쓰지 않는다(Node.js `ca` 지정과 같은 뜻이다). 시스템 저장소를 임의로 수정하지 않는다.
  - 체인 엔진은 `hExclusiveRoot` 방식이며, 정책은 `CERT_CHAIN_POLICY_SSL`에 접속 호스트를 넣어
    유효 기간·호스트 이름(SAN·CN)을 확인한다. IP 접속(`127.0.0.1` 등)은 IP SAN과 대조한다.
  - CryptoAPI가 기간의 앞뒤를 구분하지 않고 `CERT_E_EXPIRED`를 돌려주므로 방향은
    `CertVerifyTimeValidity`로 직접 확인해 만료(`CERT_HAS_EXPIRED`)와 시작 전(`CERT_NOT_YET_VALID`)을 구분한다.
- 접속 문자열 규칙이다.
  - `SSL=true` 없이 `SSLCA`를 지정하면 `HY024`이다. `SSL=true` 없이 `SSLVERIFY=false`도 `HY024`이다.
  - `SSLCA`와 `SSLVERIFY=false`를 함께 지정하면 `HY024`이다(검증할 CA를 지정하면서 검증을 끄는 것은 모순이다).
- 비밀번호·SCRAM 비밀키와 마찬가지로 인증서·개인키 내용, PEM 경로, 검증 결과의 원문을 로그·진단에 남기지 않는다.
  최종 실패 메시지는 시도 횟수와 원인 코드(`CERT_HAS_EXPIRED` 등)만 싣는다.

## 재시도

- 인증서 오류에만 새 연결로 100 ms 뒤 최대 2회 다시 시도한다(연결 시도는 최대 3번). 재시도에서도 검증은 그대로 한다.
  - 재시도 대상: 체인 정책 실패(신뢰 없음·이름 불일치·만료·시작 전·체인 오류)와
    핸드셰이크의 Schannel 인증서 상태(`SEC_E_WRONG_PRINCIPAL`, `SEC_E_UNTRUSTED_ROOT`,
    `SEC_E_CERT_EXPIRED`, `SEC_E_CERT_UNKNOWN`).
  - 재시도하지 않는 실패: 연결 거부·시간 초과·연결 끊김·평문 서버(`SEC_E_ILLEGAL_MESSAGE` 등)·TLS 버전 불일치.
- 최종 실패는 `08001`(내부 번호 8007)이며 메시지에 시도 횟수와 원인 코드를 싣는다.
  인증서 오류가 아닌 실패도 `08001`/8007로 끝내되 재시도하지 않고(`1회 시도`) 원인을 메시지에 남긴다.
- 재시도 시점에는 `hello`·사용자 이름·비밀번호가 서버에 가지 않았다(검증은 핸드셰이크 안에서 끝난다).

## 송수신과 수명

- 송신할 길이는 `EncryptMessage`가 갱신한 헤더·데이터·트레일러 버퍼 크기의 합이다. `SecPkgContext_StreamSizes`의 `cbTrailer`는 최대값이어서
  CBC 계열 스위트처럼 패딩이 달라지면 실제 트레일러가 더 짧을 수 있고, 고정값으로 보내면 레코드 뒤에 남은 바이트가 붙어 상대가 레코드를 거부한다.
  서버 기본 스위트(AES-GCM·ChaCha20)에서는 두 값이 같아 시험으로는 드러나지 않으므로 이 규칙은 코드 검토로 확인한다.
- 송신은 평문을 `cbMaximumMessage` 단위로 나누어 `EncryptMessage`로 보내고,
  수신은 `DecryptMessage`로 풀어 프레임 단위로 돌려준다. 분할 TLS 레코드·남는 입력(`SECBUFFER_EXTRA`)·
  미완성 메시지(`SEC_E_INCOMPLETE_MESSAGE`)를 처리한다. 재협상(`SEC_I_RENEGOTIATE`)은 지원하지 않고
  연결 오류(`08S01`)로 끝낸다. 서버는 재협상을 요구하지 않는다.
  종료 알림(`SEC_I_CONTEXT_EXPIRED`, close_notify)이 완성된 메시지와 같은 수신 묶음에 오면
  메시지를 먼저 돌려주고 연결 종료로 처리한다. 서버는 `bye`를 보낸 뒤 소켓을 닫으므로
  두 레코드가 합쳐져 오는 경우가 있으며 이때 `bye`를 버리면 닫기가 실패한다.
- 종료는 TCP와 같이 소켓 종료로 하며 별도 close_notify 왕복을 요구하지 않는다. 서버(Node.js TLS)도 이를 허용한다.
- `abort()`는 진행 중인 select·recv를 깨우고, 소멸자에서 컨텍스트·자격 증명·소켓을 순서대로 닫는다.
  읽기 스레드가 먼저 끝나므로(`Session`이 join 뒤에 전송 객체를 버린다) use-after-free가 없다.

## 알려진 한계

- 핸드셰이크가 끝나는 입력 묶음 뒤에 응용 데이터(`SECBUFFER_EXTRA`)가 붙어 오면 그 바이트를 전송 객체로 넘기지 않는다. HelloWorldDB 서버는 클라이언트의 첫 요청 전에는 아무것도 보내지 않으므로
  현재 서버와는 발생하지 않는다. 다른 서버를 대상으로 삼거나 서버가 먼저 메시지를 보내도록 바뀌면 남는 입력을 `encrypted_`로 넘겨 먼저 복호화해야 한다.
- 인증서 폐기(CRL·OCSP) 확인은 하지 않는다. 서버 TLS 규약(protocol.md 2-2절)도 요구하지 않는다.
- `SSLCA`는 자체 서명 루트(또는 신뢰 루트)를 담은 PEM을 가정한다. 중간 인증서만 담은 파일은 신뢰 루트로 쓰지 못한다.

## 검증 경로

- `tests/unit/tls_test.cpp`(T-TLS 일부): 인증서 오류 분류·PEM 읽기·옵션 조합 오류. 네트워크를 쓰지 않는다.
- `tests/unit/connection_test.cpp`: `SSLCA` 없는 `SSL`·검증 끄기 없는 `SSL` 조합의 `HY024`, 서버 없는 TLS 접속의 `08001`.
- `tests/driver_manager/tls_probe.cpp` + `tests/integration/protocol.test.mjs`의 TLS 8개(T-TLS):
  가짜 TLS/평문 서버의 연결 수 세기로 재시도 횟수를 확정한다(인증서 오류 3회, 평문·거부 1회).
  실제 `rdbms` TLS 서버로 CA 지정 접속의 CRUD·분할 fetch·커밋/롤백·잠금 취소와 검증 끄기 접속을 확인한다.
  만료·시작 전 인증서는 `test/fixtures/tls/`의 자체 서명 인증서로 확인한다.
