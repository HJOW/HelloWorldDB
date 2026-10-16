# nodejsDriver 진행 상황

HelloWorldDB 에 접속하는 Node.js 용 드라이버 패키지를 개발하는 프로젝트이다.
사양은 루트의 AGENTS.md 가 기준이다. 이 문서에는 세부 계획, 진행 상황, 인수인계 사항만 적는다.
단계 번호는 AGENTS.md "구현 계획" 의 번호와 같고, "상세 N" 은 AGENTS.md "RDBMS 에 구현되어야 할 사항 (상세)" 의 N번 절을 가리킨다.

## 현재 상태

- 최종 갱신 : 2026-10-16
- 진행 단계 : 착수 전 (코드 없음)
- 착수 조건 : `rdbms` 11단계 완료. 프로토콜 명세 문서는 `rdbms` 9단계에서 확정되어 있다(2026-10-16): [rdbms/docs/protocol.md](../rdbms/docs/protocol.md). 클라이언트 구현의 참고 코드도 `rdbms/src/client` 에 있다.
- 다음 작업 : 12-1 패키지 구성

## 작업 규칙

- 작업 항목을 끝내면 `[ ]` 를 `[x]` 로 바꾼다. 묶음이 끝나면 "현재 상태" 와 "작업 이력" 을 갱신한다.
- 사양에 없는 것을 새로 정했으면 "결정 사항" 에 적는다.

## 세부 계획 (12단계)

### 12-1. 패키지 구성

- [ ] `package.json` : `name` 은 `org.duckdns.hjow.helloworlddb.nodejsdriver`, `engines.node` 는 `>=22.0.0`. 실행에 필요한 외부 패키지 없이 Node.js 내장 모듈만 쓴다
- [ ] TypeScript 로 작성하고(ES 모듈), JavaScript 와 타입 정의를 함께 내보낸다
- [ ] 개발 의존성의 타입스크립트는 `rdbms` 와 같이 6 버전으로 둔다 (AGENTS.md 지켜야 할 사항 7). `tsconfig.json` 도 `rdbms` 의 것을 바탕으로 한다
- [ ] `node:test` 기반 테스트 구성. 통합 테스트는 `rdbms` 를 임시 데이터 디렉토리와 시험용 포트 번호로 띄워서 수행한다

### 12-2. 프로토콜 계층

- [ ] 메시지 만들기와 읽기 (UTF-8 JSON), 요청 `id` 로 응답 짝짓기 (상세 8)
- [ ] TCP 전송 : 길이를 앞에 붙인 프레임 (`node:net`), SSL (`node:tls`)
- [ ] SSL 서버 인증서 검증 : 기본으로 검증하고, 신뢰할 CA 지정과 검증 끄기 옵션을 둔다. 인증서 오류로 접속에 실패하면 접속을 끊고 100 ms 뒤에 다시 시도하며 재시도는 최대 2회이다(AGENTS.md 상세 8). `rdbms` 9단계(9-6)가 `client/connection.ts` 에 같은 동작을 구현할 예정이므로 그것을 출발점으로 삼는다 (`rdbms/docs/communication-design.md` 12-1절)
- [ ] UDP 전송 : 신뢰성 계층의 클라이언트 쪽 (`node:dgram`). 수신 확인, 재전송, 중복 제거, 순서 보장, 분할과 재조립, ping
- [ ] 핸드셰이크와 프로토콜 버전 협상
- [ ] SCRAM-SHA-256 인증 (`node:crypto`)

### 12-3. 공개 API

- [ ] 접속 : 대상은 호스트와 포트 번호만으로 정한다. SID 나 DB 이름에 해당하는 항목은 없다 (상세 15). 둘 다 생략할 수 있고, 생략하면 로컬 장비와 7410 을 쓴다. TCP 와 UDP 는 같은 포트 번호를 쓴다
- [ ] 문장 실행과 `?` 파라미터 바인딩
- [ ] 결과 : 컬럼 메타데이터와 행. 큰 결과는 fetch 단위로 나누어 받고 비동기 반복자로 읽을 수 있다
- [ ] 트랜잭션 : 자동 커밋 전환, 시작, 커밋, 롤백
- [ ] 접속 종료, 접속 끊김 감지
- [ ] 오류 객체 : SQLSTATE, 내부 오류 번호, 메시지
- [ ] 커넥션 풀

### 12-4. 타입 대응

| DB 타입 | JavaScript 값 |
|---|---|
| CHAR, VARCHAR | `string` |
| BINARY, VARBINARY | `Buffer` |
| SMALLINT, INTEGER | `number` |
| BIGINT | `bigint` |
| NUMERIC, DECIMAL | `string` (자릿수를 잃지 않기 위함) |
| REAL, DOUBLE PRECISION, FLOAT | `number` |
| BOOLEAN | `boolean` |
| DATE, TIME, TIMESTAMP, INTERVAL | `string` (`Date` 는 마이크로초를 담지 못한다) |
| NULL | `null` |

- [ ] 받은 값을 위 표대로 변환
- [ ] 파라미터로 넘긴 JavaScript 값을 DB 타입으로 변환 (`Date`, `bigint`, `Buffer` 포함)

### 12-5. 문서와 검증

- [ ] README : 설치, 접속, 질의 예제. Hello World 예제는 몇 줄 안에 끝나야 한다
- [ ] 통합 테스트 : TCP, SSL, UDP 각각으로 로그인, 질의, 파라미터, 대량 결과, 트랜잭션, 오류, 접속 끊김
- [ ] UDP 는 패킷 유실과 중복을 일부러 일으킨 조건에서도 시험한다
- [ ] bun 에서도 동작하는지 확인한다
- 완료 기준 : 실제 `rdbms` 를 띄워 수행하는 통합 테스트 통과.

## 미결 사항

- 소스는 ES 모듈로 작성한다. 배포할 때 CommonJS 결과물도 함께 낼지는 정하지 않았다
- 날짜시간 값을 `Date` 로 받는 옵션을 둘지

## 결정 사항

- SSL 서버 인증서는 기본으로 검증한다. 인증서 오류 때 접속을 끊고 100 ms 뒤 최대 2회 다시 시도한다. 사용자 결정(2026-10-15)이며 사양은 AGENTS.md 상세 8 이다.

## 인수인계 사항

- 프로토콜을 추측해서 구현하지 않는다. [rdbms/docs/protocol.md](../rdbms/docs/protocol.md)(버전 1)가 기준이다. 명세와 서버 동작이 다르면 `rdbms/PROGRESS.md` 에 적고 한쪽으로 맞춘다. 15절의 클라이언트 구현 체크리스트를 따른다.
- `rdbms/src/client` 가 같은 프로토콜의 클라이언트 코드를 이미 가지고 있다(9단계). `Connection`(핸드셰이크, SCRAM 과 서버 서명·nonce 검증, 실행, 커서, ping, 제어 요청), `transports.ts`(로컬 채널·TCP·TLS, 서버 인증서 검증과 재시도 `isCertificateError`·`SslOptions`), `udpTransport.ts`(UDP, 서버의 패킷 크기에 맞춤, FIN), 그리고 공유 모듈 `net/protocol.ts`·`net/framing.ts`·`net/udpReliability.ts`·`auth/scram.ts` 이다. 프로토콜 계층은 이 코드를 출발점으로 삼고, 서버 모듈(`session`, `exec`, `catalog` 등)을 import 하지 않는 원칙을 지킨다.
  결과의 값은 JSON 값 그대로이다. 12-4 의 타입 변환(`bigint`, `Buffer`, 문자열 등)이 이 드라이버의 몫이다. 파라미터는 BIGINT·NUMERIC·날짜시간을 문자열로 보내고, 안전 정수를 넘는 정수는 반드시 문자열로 보낸다(서버는 `22003` 으로 거부한다).
- 화면에 보이는 문구가 있다면 서버 오류 메시지는 번역하지 않고(영문 고정, `sqlState` 와 `code` 가 번역의 열쇠) 드라이버 자신의 문구만 카탈로그로 분리한다. `rdbms` 의 `hwdb` 와 같은 원칙이다(사용자 결정 2026-10-16). 지금은 영어만 낸다.
- bun 으로 실행할 때 TLS 클라이언트의 `minVersion`·`maxVersion` 옵션이 적용되지 않고, TLS 가 아닌 서버에 TLS 로 접속하면 오류 코드가 Node.js 와 다르다(인증서가 빈 `ERR_TLS_CERT_ALTNAME_INVALID`). `isCertificateError` 가 이를 처리한다. 자세한 것은 protocol.md 16절.
- 드라이버는 TCP 와 UDP 로만 접속한다. 로컬 전용 채널과 데몬 제어(구동, 종료, 상태 조회)는 CLI 의 몫이며 드라이버의 범위가 아니다.
- `gui` 는 보류 중이지만 나중에 이 드라이버를 쓰게 된다.
- 타입 선언 인자의 전체 생략은 DECIMAL/DEC/NUMERIC (10,3), VARCHAR/NVARCHAR 길이 65,535이다. 실제 컬럼의 정밀도/소수 자릿수/길이는 서버 메타데이터를 따르며 결과 값을 기본값에 맞춰 재가공하지 않는다. [rdbms 타입 정책](../rdbms/docs/data-types.md)을 참고한다.

## 작업 이력

- 2026-10-08 : 세부 계획 작성.
- 2026-10-08 : 사양 변경 반영. 패키지명 확정, 포트 번호 하나로 대상 지정(TCP 와 UDP 포트 통합).
- 2026-10-08 : 변경된 타입 기본값과 메타데이터 사용 규칙을 인수인계에 반영했다. 구현 착수 조건은 rdbms 11단계 완료이다.
- 2026-10-16 : `rdbms` 9단계 완료로 프로토콜 명세(`rdbms/docs/protocol.md`)와 클라이언트 참고 코드(`rdbms/src/client`)가 준비되었음을 인수인계에 반영했다. 착수 조건은 그대로 `rdbms` 11단계 완료이다.
