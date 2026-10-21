# 의존성 결정과 배포 정책

2026-10-21 WO-0 결정이다. 실제 설치 증거는 [호스트별 환경](environment.md)을 따른다. 아래의 버전 선정은 라이브러리 도입·컴파일 성공 기록과 구분한다.

| 용도 | 선택·버전 | 라이선스·배포 | 도입 단계 |
|---|---|---|---|
| C++ 빌드 | C++17, MSVC v143 / Windows SDK | Microsoft 도구·SDK 약관. SDK 헤더나 import lib를 제품 패키지에 복사하지 않음 | WO-1 |
| CRT | Release `/MT`, Debug `/MTd`, DLL 경계에서 메모리 할당·해제 쌍 유지 | Microsoft 정적 런타임 재배포 조건 준수. Debug 런타임 배포 안 함. 별도 VC Redistributable 설치를 기본 요구하지 않음 | WO-1/12 |
| JSON | **nlohmann/json 3.12.0** 단일 헤더, `nlohmann::json`, 기본 예외 켬 | MIT. `third_party/nlohmann/`에 원본·LICENSE.MIT·SHA-256 보관, 빌드 중 다운로드 없음 | 도입·네이티브 빌드·파서 시험 완료 |
| 정수·정확한 소수 | 외부 라이브러리 없음. int64, 부호·scale·10진 숫자열과 16바이트 정수 변환 | 이 프로젝트 구현. MSVC에 없는 `__int128`을 요구하지 않음 | WO-5/6 |
| 네트워크 | Winsock 2, `ws2_32.lib` | Windows OS 제공, DLL 동봉 안 함 | WO-3/11 |
| SCRAM 암호 연산 | Windows CNG, `bcrypt.lib` | Windows OS 제공 | WO-3 |
| UTF-8/UTF-16·NFKC | Win32 변환·`NormalizeString(NormalizationKC)`, `normaliz.lib` | Windows OS 제공 | WO-2/3 |
| TLS·인증서 | Schannel·CryptoAPI, `secur32.lib`, `crypt32.lib` | Windows OS 제공, OpenSSL DLL 추가 안 함 | WO-10 |
| ODBC | 시스템 `odbc32.dll`, setup은 `odbccp32.dll` | Windows 제공. 드라이버 DLL이 Manager의 같은 이름 함수를 다시 호출하지 않음 | WO-1/12 |

JSON 버전과 MIT 조건은 [공식 3.12.0 릴리스](https://github.com/nlohmann/json/releases/tag/v3.12.0), [해당 태그의 라이선스](https://raw.githubusercontent.com/nlohmann/json/v3.12.0/LICENSE.MIT)를 확인했다. 도입 시 소스와 바이너리 배포의 제3자 고지에 저작권·라이선스 전문을 포함한다.

JSON은 BIGINT·DECIMAL·날짜시간을 문자열로 유지한다. JSON 정수의 signed/unsigned와 안전 정수 범위를 검사한 뒤 변환하며 `get<double>()`를 공통 경로로 사용하지 않는다. REAL/DOUBLE만 유한한 부동소수로 처리한다. parser callback/SAX로 객체별 중복 키를 거부하고, 깊이 64와 인증 전 64KiB/후 16MiB 한도를 검사한다. 중복 키와 과도한 깊이 거부는 클라이언트의 입력 방어 정책이다. 모르는 선택 필드는 무시하지만 알려진 필드의 잘못된 타입과 모르는 응답 type은 프로토콜 오류이다. 이 정책의 실제 시험은 T-PROTO이다.

DECIMAL 변환은 최대 38자리의 절댓값·부호·scale을 따로 보관한다. SQL_NUMERIC_STRUCT의 little-endian 16바이트 값과 10진 문자열 사이를 작은 정수의 곱셈/나눗셈으로 바꾸고 범위를 확인한다. double·strtod·로캘 의존 통화 포맷을 거치지 않는다. SQL 엔진의 사칙연산을 드라이버에 복제하지 않는다. T-TYPE에서 ±BIGINT 경계·38자리·scale 0/38·음수 0·반올림/오버플로를 검증한다.

SCRAM은 [BCryptDeriveKeyPBKDF2](https://learn.microsoft.com/en-us/windows/win32/api/bcrypt/nf-bcrypt-bcryptderivekeypbkdf2)의 SHA-256 HMAC, BCryptGenRandom, SHA-256으로 구성한다. nonce 연장·반복 수·서버 서명을 검증하고 키를 비밀 메모리로 취급한다. [NormalizeString](https://learn.microsoft.com/en-us/windows/win32/api/winnls/nf-winnls-normalizestring)의 NFKC 결과는 서버 Node.js와 Unicode 버전 차이가 있을 수 있으므로 WO-3에서 조합/호환 문자·신규 문자 벡터를 대조한다. 문서 선정만으로 인증 호환 성공을 선언하지 않는다.

Windows API를 고정 버전의 재배포 DLL로 취급하지 않는다. 실제 시험마다 OS/SDK/시스템 파일 버전을 호스트명과 함께 기록한다. Node.js 22 이상은 문서 검사·임시 서버 시험용이며, 설치된 드라이버는 Node.js·JVM·Python을 실행하지 않는다. 소스 재사용 시 저장소의 라이선스 조건도 확인하고, 프로젝트 전체 라이선스의 신규 지정은 이 단계에서 하지 않는다.
