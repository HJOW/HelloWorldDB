# TLS 시험용 인증서

통신 시험(`test/net`)이 쓰는 자체 서명 인증서와 개인키이다. **시험 전용 키이며 실제 서비스에 쓰지 않는다.**
유효 기간을 약 100년으로 잡아 시험이 만료로 깨지지 않게 했다. 모두 RSA 2048 이고 SHA-256 서명이다. (구버전 TLS 시험에서도 쓸 수 있게 RSA 로 했다)

| 파일 | 이름(CN) | 주체 대체 이름(SAN) | 용도 |
|---|---|---|---|
| `server-a.cert.pem`, `server-a.key.pem` | `localhost` | `localhost`, `127.0.0.1`, `::1` | 클라이언트가 `ca` 로 신뢰하는 서버 인증서 |
| `server-b.cert.pem`, `server-b.key.pem` | `localhost` | `localhost`, `127.0.0.1`, `::1` | A 와 같은 이름의 다른 인증서. A 만 신뢰하는 클라이언트에게는 신뢰할 수 없는 인증서 |
| `server-other-name.cert.pem`, `server-other-name.key.pem` | `other.example` | `other.example` | 신뢰하더라도 접속 대상(`localhost`, `127.0.0.1`)의 이름과 맞지 않는 인증서 |

## 다시 만드는 방법

OpenSSL 1.1.1 이상이 필요하다. (Git Bash 에서는 `-subj` 가 경로로 바뀌지 않게 `MSYS_NO_PATHCONV=1` 을 붙인다)

```sh
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 36500 \
  -keyout server-a.key.pem -out server-a.cert.pem \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1"

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 36500 \
  -keyout server-b.key.pem -out server-b.cert.pem \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1"

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 36500 \
  -keyout server-other-name.key.pem -out server-other-name.cert.pem \
  -subj "/CN=other.example" -addext "subjectAltName=DNS:other.example"
```

다시 만들면 인증서의 지문이 바뀌지만 시험은 지문에 기대지 않으므로 그대로 통과해야 한다.
