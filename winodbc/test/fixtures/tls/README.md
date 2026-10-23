# TLS 시험용 인증서

WO-10 시험이 쓰는 자체 서명 인증서와 개인키이다. **시험 전용 키이며 실제 서비스에 쓰지 않는다.**
`server-a` 계열은 [서버 시험용 인증서](../../../../rdbms/test/fixtures/tls/README.md)를 그대로 참조하며 이 디렉토리에 복사하지 않는다.
여기에는 기간 검증용으로 만료·시작 전 인증서만 둔다. 모두 RSA 2048, SHA-256 서명, CN=localhost, SAN `DNS:localhost, IP:127.0.0.1, IP:::1`이다.

| 파일 | 유효 기간 | 용도 |
|---|---|---|
| `server-expired.cert.pem`, `server-expired.key.pem` | 과거 1년 (생성 시점 기준 -3년 ~ -2년) | 만료 인증서 거부·재시도 시험. 같은 인증서를 SSLCA로 신뢰해도 기간 오류로 실패해야 한다 |
| `server-future.cert.pem`, `server-future.key.pem` | 미래 1년 (생성 시점 기준 +1년 ~ +2년) | 시작 전 인증서 거부 시험. 용도는 만료와 같으며 같은 코드 경로를 확인한다 |

기간 검증은 Schannel 수동 검증(`CertVerifyCertificateChainPolicy`의 SSL 정책)에서 수행한다.
"암호화가 켜짐"만으로는 검증을 마쳤다고 판단하지 않는다.

## 다시 만드는 방법

Windows PowerShell 5.1 이상과 Git 동봉 OpenSSL이 필요하다.
아래 명령의 날짜는 실행 시점을 기준으로 하므로 다시 만들면 `notBefore`/`notAfter`가 달라지지만
시험은 만료/미래 여부만 보므로 그대로 통과해야 한다.

```powershell
$pw = ConvertTo-SecureString 'hwdb-tls-test' -AsPlainText -Force
$san = @('2.5.29.17={text}DNS=localhost&IPAddress=127.0.0.1&IPAddress=::1')
$exp = New-SelfSignedCertificate -Subject 'CN=localhost' -TextExtension $san `
  -NotBefore ((Get-Date).AddYears(-3)) -NotAfter ((Get-Date).AddYears(-2)) `
  -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 `
  -HashAlgorithm SHA256 -KeyExportPolicy Exportable
$fut = New-SelfSignedCertificate -Subject 'CN=localhost' -TextExtension $san `
  -NotBefore ((Get-Date).AddYears(1)) -NotAfter ((Get-Date).AddYears(2)) `
  -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 `
  -HashAlgorithm SHA256 -KeyExportPolicy Exportable
Export-PfxCertificate -Cert $exp -FilePath $env:TEMP\hwdb-exp.pfx -Password $pw
Export-PfxCertificate -Cert $fut -FilePath $env:TEMP\hwdb-fut.pfx -Password $pw
& 'C:\Program Files\Git\usr\bin\openssl.exe' pkcs12 -in $env:TEMP\hwdb-exp.pfx `
  -out server-expired.cert.pem -nokeys -passin pass:hwdb-tls-test
& 'C:\Program Files\Git\usr\bin\openssl.exe' pkcs12 -in $env:TEMP\hwdb-exp.pfx `
  -out server-expired.key.pem -nodes -nocerts -passin pass:hwdb-tls-test
& 'C:\Program Files\Git\usr\bin\openssl.exe' pkcs12 -in $env:TEMP\hwdb-fut.pfx `
  -out server-future.cert.pem -nokeys -passin pass:hwdb-tls-test
& 'C:\Program Files\Git\usr\bin\openssl.exe' pkcs12 -in $env:TEMP\hwdb-fut.pfx `
  -out server-future.key.pem -nodes -nocerts -passin pass:hwdb-tls-test
```

확인 명령:

```powershell
& 'C:\Program Files\Git\usr\bin\openssl.exe' x509 -in server-expired.cert.pem -noout -subject -dates -ext subjectAltName
```

사용이 끝난 PFX와 인증서 저장소의 시험 항목은 반드시 제거한다.
