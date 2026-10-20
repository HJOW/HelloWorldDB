# nodejsDriver 진행 상황

HelloWorldDB 에 접속하는 Node.js 용 드라이버 패키지를 개발하는 프로젝트이다.
사양은 루트의 AGENTS.md 가 기준이다. 이 문서에는 세부 계획, 진행 상황, 인수인계 사항만 적는다.
단계 번호는 AGENTS.md "구현 계획" 의 번호와 같고, "상세 N" 은 AGENTS.md "RDBMS 에 구현되어야 할 사항 (상세)" 의 N번 절을 가리킨다.
사용법은 [README.md](README.md)이다.

## 현재 상태

- 최종 갱신 : 2026-10-20
- 최종 검증(Windows, Node.js 24.22.0 / TypeScript 6.0.3) : `npm test` **116개 모두 통과**, 건너뜀·실패 0(단위 33 + 실제 서버 통합 83). Bun 1.3.14는 12개 파일의 전체 114개를 실행해 113개 통과·1개 건너뜀(기존 구버전 TLS)·실패 0이었고, 초기화 경계 2개를 추가한 `review.test.ts` 7개도 다시 통과했다. 최종 116개 시나리오 중 Bun에서 115개 통과·1개 건너뜀이다. 패키지 배포·Node.js 22.x·다른 OS 검증은 이번에 하지 않았다.
- 2026-10-20 점검 및 수정 : 결과 객체의 특수 컬럼 이름, 풀 생성·종료 경쟁과 초기화, 주석이 든 트랜잭션 문장, 인증 제한 시간, 응답 검증, 소켓 조기 종료, 시험 서버 정리 문제를 재현하고 수정했다. 회귀 시험 16개를 추가했다. 상세는 아래 "코드 점검 및 수정".
- 진행 단계 : **12단계 완료** (12-1 ~ 12-5). 완료 기준 "실제 `rdbms` 를 띄워 수행하는 통합 테스트 통과"를 채웠다.
- 다음 작업 : 없음. (사용자가 정하는 것 : 아래 "미결 사항")
- 구현한 것 : TCP(SSL 포함)와 UDP 접속, 호스트와 포트 번호만으로 대상 지정(생략하면 `127.0.0.1:7410`), SCRAM-SHA-256 인증(서버 nonce·반복 횟수·서버 서명 검증), 문장 실행과 `?` 파라미터 바인딩,
  결과 나누어 받기(`cursor`, 비동기 반복자 `stream`), 트랜잭션 API(`begin`·`commit`·`rollback`·`setAutoCommit`·`transaction`), 접속 종료와 끊김 감지(`close` 이벤트), `DbError`(SQLSTATE·내부 번호·위치), 커넥션 풀, TypeScript 타입 정의, README.
  TLS 서버 인증서는 기본으로 검증하고 인증서 오류 때 100 ms 뒤 최대 2회 재시도한다. UDP 는 신뢰성 계층(수신 확인·재전송·중복 제거·순서 보장·조각)과 세션 유지 ping 을 클라이언트 쪽에서 구현했다.
  외부 패키지에 의존하지 않고 Node.js 내장 모듈(`node:net`, `node:tls`, `node:dgram`, `node:crypto`, `node:events`)만 쓴다.
- 12단계 최초 검증(2026-10-17, Windows, Node.js 24.21.0, bun 1.3.14, TypeScript 6.0.3) :
  - `npm test` **100개 통과**(단위 25 + 통합 75), 건너뜀 0, 실패 0, 약 24초. 통합 시험은 실제 `rdbms` 를 `hwdb start` 로 띄운다. (`connect` 17, `query` 18, `transaction` 9, `pool` 13, `tls` 8, `udp` 10 = 통합 75)
  - bun 1.3.14 로 시험 러너를 돌린 결과(파일마다) : 서버도 bun → 99개 통과·1개 건너뜀(구버전 TLS 시험), 서버를 node 로 → 같은 결과. 실패 0. 남은 서버 프로세스 0.
  - 패키지로 묶어(`npm pack`) 빈 프로젝트에 설치하고 패키지 이름으로 import 한 README 의 Hello World 를 node 와 bun 으로 실행했다. 소비자 쪽 TypeScript 6.0.3(`skipLibCheck: false`)이 타입 정의를 컴파일한다.
  - UDP 는 패킷 15% 유실·10% 중복·지연으로 순서가 뒤바뀌는 프록시를 사이에 끼운 시험(시드 3개)과, 가짜 시계와 시뮬레이터로 20% 유실·중복·순서 뒤바뀜을 일으킨 신뢰성 계층 시험(시드 6개)을 통과한다.
  - RFC 7677 SCRAM-SHA-256 시험 벡터(클라이언트 증명·서버 서명)가 일치한다.
  - 확인하지 못한 것 : Node.js 22.x 장비(이 PC 에는 24.21.0 만 있다), 리눅스·macOS, 실제 자바 6 의 TLS 1.0(드라이버와 무관).

## 작업 규칙

- 작업 항목을 끝내면 `[ ]` 를 `[x]` 로 바꾼다. 묶음이 끝나면 "현재 상태" 와 "작업 이력" 을 갱신한다.
- 사양에 없는 것을 새로 정했으면 "결정 사항" 에 적는다.

## 디렉토리 구성

```
nodejsDriver/
  package.json, tsconfig.json, README.md
  scripts/ensure-rdbms.mjs   npm test 전에 ../rdbms 의 빌드 결과물이 있는지 보고, 없으면 빌드한다
  src/
    index.ts                 공개 API 재노출
    connection.ts            Connection(query, cursor, stream, 트랜잭션, close, 이벤트), QueryResult, Cursor, connect, ConnectOptions
    pool.ts                  Pool, createPool
    values.ts                결과 값 변환(decodeValue)과 파라미터 변환(encodeParam). 타입 대응표
    errors.ts                DbError, ERROR_CODES, connectionFailure
    protocol/
      messages.ts            프로토콜 상수, 응답 타입, encodeMessage, decodeResponse, toDbError
      framing.ts             4바이트 길이 프레임 (TCP)
      scram.ts               SCRAM-SHA-256 클라이언트 계산
      udpReliability.ts      UDP 신뢰성 계층 (패킷 코덱, ACK·재전송·조각·중복 제거)
      protocolConnection.ts  접속 하나의 저수준 프로토콜 (핸드셰이크, 인증, 실행, 요청 id 짝짓기, 서버가 먼저 보낸 오류, UDP 세션 유지)
    transport/
      tcpTransport.ts        MessageTransport 인터페이스, TCP·TLS 전송, 인증서 검증 재시도, SslOptions
      udpTransport.ts        UDP 전송 (dgram 위에서 신뢰성 계층 사용)
  test/
    values.test.ts, protocol.test.ts    단위 시험 (서버 불필요)
    connect.test.ts, query.test.ts, transaction.test.ts, pool.test.ts, tls.test.ts, udp.test.ts    통합 시험 (실제 rdbms)
    helpers/server.ts        TestServer : rdbms 를 임시 디렉토리·빈 포트로 띄우고 끝낸다
    helpers/udpProxy.ts      패킷을 잃고 중복·지연시키는 UDP 프록시
    helpers/udpSim.ts        가짜 시계와 유실·중복·지연 링크
```

의존 방향 : `connection`/`pool` → `protocol/protocolConnection` → `protocol/*`, `transport/*`. `errors` 는 아무것도 import 하지 않는다. `rdbms` 의 코드를 import 하지 않는다.

## 명령

`nodejsDriver` 디렉토리에서 실행한다.

| 명령 | 하는 일 |
|---|---|
| `npm install` | 개발 의존성 설치 (타입스크립트 6, `@types/node`) |
| `npm run build` | `dist` 를 지우고 빌드 (`dist/src`, `dist/test`, 타입 정의) |
| `npm test` | `../rdbms` 가 빌드되어 있는지 확인하고(없으면 빌드) 드라이버를 빌드한 뒤 `node:test` 로 모든 시험을 실행 |
| `node --test dist/test/<파일>.test.js` | 시험 하나만 |
| `bun test --timeout 120000 dist/test/<파일>.test.js` | bun 으로. 파일마다 따로 돌린다. 서버를 node 로 돌리려면 `HWDB_TEST_RUNTIME=<node 경로>` |

## 세부 계획 (12단계) — 모두 완료

### 12-1. 패키지 구성

- [x] `package.json` : `name` 은 `org.duckdns.hjow.helloworlddb.nodejsdriver`(초기 파일의 `nodedriver` 를 지켜야 할 사항 6 에 맞게 고쳤다), `engines.node` 는 `>=22.0.0`. 실행에 필요한 외부 패키지 없이 Node.js 내장 모듈만 쓴다
- [x] TypeScript 로 작성하고(ES 모듈), JavaScript 와 타입 정의(`.d.ts`)를 함께 내보낸다 (`exports`, `types`, `files`)
- [x] 개발 의존성의 타입스크립트는 `rdbms` 와 같이 6 버전으로 둔다 (AGENTS.md 지켜야 할 사항 7). `tsconfig.json` 도 `rdbms` 의 것을 바탕으로 한다
- [x] `node:test` 기반 테스트 구성. 통합 테스트는 `rdbms` 를 임시 데이터 디렉토리와 시험용 포트 번호로 띄워서 수행한다 (`test/helpers/server.ts`, `scripts/ensure-rdbms.mjs`)

### 12-2. 프로토콜 계층

- [x] 메시지 만들기와 읽기 (UTF-8 JSON), 요청 `id` 로 응답 짝짓기 (상세 8)
- [x] TCP 전송 : 길이를 앞에 붙인 프레임 (`node:net`), SSL (`node:tls`)
- [x] SSL 서버 인증서 검증 : 기본으로 검증하고, 신뢰할 CA 지정(`ca`, `servername`)과 검증 끄기(`rejectUnauthorized: false`) 옵션을 둔다. 인증서 오류로 접속에 실패하면 접속을 끊고 100 ms 뒤에 다시 시도하며 재시도는 최대 2회이다(AGENTS.md 상세 8). 시험 : 대기·횟수·원인 코드·재시도하지 않는 경우
- [x] UDP 전송 : 신뢰성 계층의 클라이언트 쪽 (`node:dgram`). 수신 확인, 재전송, 중복 제거, 순서 보장, 분할과 재조립, ping
- [x] 핸드셰이크와 프로토콜 버전 협상
- [x] SCRAM-SHA-256 인증 (`node:crypto`). 서버 nonce·반복 횟수 확인과 서버 서명 검증

### 12-3. 공개 API

- [x] 접속 : 대상은 호스트와 포트 번호만으로 정한다. SID 나 DB 이름에 해당하는 항목은 없다 (상세 15). 둘 다 생략할 수 있고, 생략하면 로컬 장비(`127.0.0.1`)와 7410 을 쓴다. TCP 와 UDP 는 같은 포트 번호를 쓴다
- [x] 문장 실행과 `?` 파라미터 바인딩
- [x] 결과 : 컬럼 메타데이터와 행. 큰 결과는 fetch 단위로 나누어 받고 비동기 반복자로 읽을 수 있다 (`cursor`, `stream`)
- [x] 트랜잭션 : 자동 커밋 전환, 시작, 커밋, 롤백 (`transaction(fn)` 포함)
- [x] 접속 종료, 접속 끊김 감지 (`close()` 의 `{ rolledBack }`, `destroy()`, `close` 이벤트)
- [x] 오류 객체 : SQLSTATE, 내부 오류 번호, 메시지, 위치 (`DbError`)
- [x] 커넥션 풀

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

- [x] 받은 값을 위 표대로 변환
- [x] 파라미터로 넘긴 JavaScript 값을 DB 타입으로 변환 (`Date`, `bigint`, `Buffer` 포함)

### 12-5. 문서와 검증

- [x] README : 설치, 접속, 질의 예제. Hello World 예제는 3줄이다
- [x] 통합 테스트 : TCP, SSL, UDP 각각으로 로그인, 질의, 파라미터, 대량 결과, 트랜잭션, 오류, 접속 끊김
- [x] UDP 는 패킷 유실과 중복을 일부러 일으킨 조건에서도 시험한다
- [x] bun 에서도 동작하는지 확인한다
- 완료 기준 : 실제 `rdbms` 를 띄워 수행하는 통합 테스트 통과. (충족)

## 코드 점검 및 수정 (2026-10-20)

작업 전 기존 `npm test` 100개가 통과했다. 새 회귀 시험 중 최초 14개는 수정 전 코드에서 모두 실패했고, 수정 후 두 가지 풀 초기화 경계를 더 확인했다. 서버는 기존 `rdbms`의 실제 데몬을 임시 디렉토리에서 구동했다. `rdbms` 소스, 사양, 통신 메시지 형식은 변경하지 않았다.

- [x] **D-1 : `records()`가 `"__proto__"` 컬럼을 잃는다.** 일반 객체에 값을 대입하면 프로토타입 설정자를 건드렸다. `Object.fromEntries()`로 일반 객체와 해당 이름의 소유 속성을 함께 보존하며, 중복 이름에는 마지막 값을 남긴다(`review.test.ts`).
- [x] **D-2 : 풀 생성 중 종료·시간 초과로 acquire가 끝나지 않거나 다음 대기자가 방치된다.** 생성 중인 요청을 대기열에서 빼 버려 `close()`가 거부하지 못했고, 첫 요청이 포기한 뒤 접속 생성이 끝나도 다음 요청을 처리하지 않았다. 생성 중인 요청도 추적해 종료 시 즉시 거부하고 늦게 생성된 접속을 다음 대기자에게 전달한다(`poolState.test.ts` 2개). 제한 시간 없는 acquire도 검증한다.
- [x] **D-3 : SQL 주석 때문에 트랜잭션 상태가 틀리고 미커밋 행이 다음 대여로 넘어간다.** `SET /*...*/ AUTOCOMMIT OFF`, 끝 주석, `ROLLBACK /*...*/ TO S`를 잘못 읽었다. 낱말 사이 주석을 건너뛰고 처음 세 낱말로 판정하며 AUTOCOMMIT ON의 자동 커밋도 상태에 반영한다. 실패하거나 아직 응답이 없는 문장은 별도로 표시해 풀에서 초기화한다. 실제 미커밋 행이 다음 대여에서 사라지는지 확인했다.
- [x] **D-4 : 풀 반환 때 남은 커서·USE·타임존이 초기화되지 않는다.** 열린 커서를 추적해 반환 때 닫고, ROLLBACK·자동 커밋·초기 테이블스페이스·타임존을 복원한다. BEGIN 응답 전에 반환해도 초기화 뒤 다음 요청에 전달한다. 기본 테이블스페이스가 없는 세션의 USE는 SQL로 원래 상태를 만들 수 없으므로 접속을 교체한다(`review.test.ts`). 로그인 직후 상태로 복원하지 못하면 접속을 폐기한다.
- [x] **D-5 : `connectTimeoutMs`가 인증 응답 대기에 적용되지 않는다.** hello 뒤의 authStart·authFinish가 요청 제한 시간 미지정 시 끝없이 기다렸다. 연결 시작 시점을 기준으로 남은 시간을 계산해 핸드셰이크와 인증 두 단계에 적용한다. 각 인증 응답을 멈춘 실제 TCP 시험 서버로 검증했다(`protocolReview.test.ts`).
- [x] **D-6 : 잘못된 응답을 받아들이거나 내부 타입 오류로 이어진다.** 지원하지 않는 협상 버전·인증 방식, 깨진 행 배열, 컬럼·커서·세션·오류 필드의 타입과 범위를 확인한다. execute의 컬럼 메타데이터도 필수로 검사한다. 해석 불가능한 응답과 서버의 종료 통지는 접속을 즉시 닫고 기다리는 요청을 DbError로 거부한다. 모르는 추가 필드는 계속 허용한다(`protocolReview.test.ts`).
- [x] **D-7 : 핸들러 등록 전에 닫힌 TCP 소켓의 알림을 잃는다.** 먼저 close 이벤트가 오면 나중에 등록한 핸들러가 닫힘을 받지 못했다. 닫힌 상태와 알림 여부를 분리해 늦게 등록해도 한 번 알리고 닫힌 소켓으로 보내기는 즉시 실패시킨다(`protocolReview.test.ts`).
- [x] **D-8 : 시험 서버 정리가 파일 존재 검사 결과에 따라 종료 요청을 생략한다.** 앞선 rdbms 점검에서 고친 경로와 같은 문제가 도우미에도 있었다. 실제 제어 채널로 정상 종료를 먼저 시도하도록 바꿨다. 채널 경로 조회를 false로 만드는 실제 서버 시험은 수정 전 실패했고, 실패 후에도 제어 토큰을 남겨 정상 종료한다(`cleanup.test.ts`). PID만으로 새로운 종료 대상을 고르는 경로는 추가하지 않았다.

검증 범위 : TCP·TLS·UDP, SCRAM 서명, 값·파라미터, 커서·stream, 트랜잭션, 풀, 패킷 유실·중복과 데몬 정리를 포함한다. 확인하지 못한 Node.js 22.x와 다른 OS의 동작은 아래 미결 사항으로 유지한다. 요청 취소와 서버 전체 결과 스트리밍은 이번 수정 범위에 포함하지 않는다.

## 미결 사항

사용자가 정하거나 장비에서 확인해야 하는 것이다. 개발은 막지 않는다.

- Node.js 22.x 장비에서의 실행 확인. 이번 검증은 24.22.0에서 했다. 쓴 API(`node:net`·`tls`·`dgram`·`crypto`·`events`, `node:test` 의 `after`·`afterEach`)는 22에서 달라지지 않는다고 본다. AGENTS.md 지켜야 할 사항 5에 따라 22.x PC에서 전역 시험을 하고 문제가 있으면 고친다.
- 리눅스·macOS 에서의 시험. (드라이버는 TCP·UDP 만 쓰고 플랫폼에 기대지 않는다. 시험 도우미의 로컬 전용 채널 주소 판정은 유닉스 소켓 경로를 쓴다)
- 소스는 ES 모듈로만 낸다. 배포할 때 CommonJS 결과물도 함께 낼지는 정하지 않았다 (`require()` 로 쓰려면 Node.js 22.12+ 의 `require(esm)` 이 필요하다)
- 날짜시간 값을 `Date` 로 받는 옵션을 둘지. (마이크로초를 담지 못해 지금은 문자열만 준다)
- `Connection.session` 은 로그인 때의 값이다. `USE 테이블스페이스` 로 바꾼 현재 테이블스페이스는 반영하지 않는다. 서버가 변경을 알려 주지 않으므로 필요하면 `SYS_SESSIONS` 를 조회한다.
- 메타데이터 API(`getColumns` 류)는 만들지 않았다. 딕셔너리 뷰(`SYS_TABLES`, `SYS_COLUMNS` 등)를 SQL 로 조회한다. `SYS_COLUMNS` 에 뷰의 컬럼이 없는 한계는 `rdbms/PROGRESS.md` 의 미결 사항이다.
- 조회 결과 전체가 서버 메모리에 한 번 올라온다(서버의 한계, `rdbms/docs/protocol.md` 10절). 드라이버의 `stream` 은 클라이언트 메모리만 아낀다.
- 요청의 취소(실행 중인 문장 중단)는 없다. 요청 제한 시간(`requestTimeoutMs`)을 넘으면 그 요청만 실패하고 서버는 문장을 계속 실행한다.

## 결정 사항

- SSL 서버 인증서는 기본으로 검증한다. 인증서 오류 때 접속을 끊고 100 ms 뒤 최대 2회 다시 시도한다. 사용자 결정(2026-10-15)이며 사양은 AGENTS.md 상세 8 이다.
- **프로토콜 코드는 `rdbms` 에서 옮겨 왔다** (`protocol/framing.ts`, `scram.ts`, `udpReliability.ts`, `transport/*`, `protocol/protocolConnection.ts`). 드라이버가 서버 모듈을 import 하지 않도록 복사했다. 서버와 같은 규칙이므로 **프로토콜 규칙이 바뀌면 양쪽을 함께 고친다**
  (`rdbms/docs/protocol.md` 가 기준이고, 바뀌면 프로토콜 버전을 올리고 이 문서에 알린다). 드라이버에는 서버 쪽 요청 검증과 로컬 전용 채널, 데몬 제어가 없다.
- **API 모양** : `connect(options)` 가 `Connection` 을 돌려준다. `user`, `password` 는 필수(AGENTS.md 상세 13 : 비밀번호는 생략할 수 없다), 나머지는 모두 생략할 수 있다. 호스트 기본은 `localhost` 가 아니라 `127.0.0.1` 이다(`localhost` 는 IPv6 로 먼저 풀릴 수 있는데 서버는 `0.0.0.0` 에 바인드한다).
  행은 컬럼 순서의 배열이고 `result.records()` 가 컬럼 이름 키의 객체로 바꾼다. (컬럼 이름이 겹칠 수 있어 객체를 기본으로 하지 않았다)
- **`DbError.isConnectionError`** : SQLSTATE 클래스 `08` 에 더해 서버가 접속을 끊으며 알리는 `57P01`(서버 종료), `57P05`(유휴 시간 초과)도 "이 접속을 더 쓸 수 없는 오류" 로 본다. 서버가 먼저 끊은 접속에 이어서 보낸 문장은 그 서버 오류(`57P01`·`57P05`)로 거부된다.
- **`close` 이벤트** : 이쪽이 `close()`/`destroy()` 로 끝낸 것은 `null`, 서버가 끊었거나 연결이 끊긴 것은 `DbError` 를 함께 보낸다. (서버가 먼저 보낸 `id: 0` 오류가 있으면 그것이 원인이다)
- **트랜잭션 상태는 성공한 문장에서 가늠한다.** `BEGIN`·`START TRANSACTION`·`COMMIT`·`ROLLBACK`(`ROLLBACK TO` 제외)·`SET AUTOCOMMIT`·DDL 계열을 보고 `inTransaction`, `autoCommit`을 갱신한다. 낱말 사이와 끝의 주석도 처리한다. 서버가 상태를 알려 주지 않으므로 실패·응답 대기 상태는 별도로 표시하며, 풀 반환 때는 필요한 경우 추정 상태와 무관하게 ROLLBACK을 전송한다.
  `transaction(fn)` 은 자동 커밋이 켜져 있으면 `BEGIN`/`COMMIT`/`ROLLBACK`, 꺼져 있으면 `BEGIN` 없이 `COMMIT`/`ROLLBACK` 만 보낸다. (자동 커밋이 꺼진 상태의 `BEGIN` 은 이미 시작된 트랜잭션이 있으면 서버가 `25001` 로 거부한다)
- **커넥션 풀의 기본값** : `max` 5(서버 `maxConnections` 기본 10 이 TCP·UDP 세션 합계라 절반으로), `idleTimeoutMs` 30초, `acquireTimeoutMs` 30초(넘으면 `53300`), `maxLifetimeMs` 제한 없음. 접속은 처음 빌릴 때 만든다. 반환 시 필요한 롤백·커서 정리·자동 커밋·테이블스페이스·타임존 복원이 끝난 뒤 다시 빌려주고, 복원하지 못하면 버린다.
- **파라미터의 `Date`** 는 `toISOString()` (UTC, `Z`)으로 보낸다. 서버가 오프셋이 적힌 문자열을 타임존 없는 타입으로 받으면 세션 타임존의 벽시계 시각으로 옮기고, `WITH TIME ZONE` 에는 입력한 오프셋(`+00:00`)으로 저장한다. (`rdbms/docs/data-types.md`)
- **UDP 와 SSL 은 함께 쓸 수 없다**(`TypeError`). `hwdb --udp --ssl` 와 같은 규칙이다.
- 서버 오류 메시지는 번역하지 않는다. 드라이버가 만드는 오류 메시지도 영문이고 화면 문구가 없으므로 메시지 카탈로그는 두지 않았다. (사용자 결정 2026-10-16 : 화면 문구가 생기면 카탈로그로 분리한다)

## 인수인계 사항

- 프로토콜을 추측해서 구현하지 않는다. [rdbms/docs/protocol.md](../rdbms/docs/protocol.md)(버전 1)가 기준이다. 명세와 서버 동작이 다르면 `rdbms/PROGRESS.md` 에 적고 한쪽으로 맞춘다. 15절의 클라이언트 구현 체크리스트를 따른다.
- 통합 시험은 `rdbms` 가 `../rdbms/dist` 에 빌드되어 있어야 한다(`npm test` 가 확인한다). 시험은 서버를 `test/helpers/server.ts` 의 `TestServer.start()` 로 띄운다. **함정 둘**
  - 시험 프로세스 안에 서버에 접속한 `Connection` 이 열려 있을 때 `TestServer.stop()`·`hwdb()`(`spawnSync`)를 부르면 이벤트 루프가 막혀 접속이 서버의 메시지를 읽지도(UDP 는 ACK 도) 못해 서버 종료가 유예 시간(수십 초)만큼 늦어진다. `stopAsync()`·`hwdbAsync()` 를 쓴다.
  - 서버 정리는 파일 존재 판정과 무관하게 `hwdb stop`을 먼저 시도한다. 이후 강제 종료 후보는 잠금 파일의 PID와 로컬 채널을 함께 확인한다. 끝난 서버의 PID를 운영체제가 다른 프로세스에 줄 수 있으므로 PID만으로 종료하지 않는다. (`rdbms` 도우미와 같은 원칙)
- 서버가 접속 수 상한(`maxConnections`, 기본 10)에 이르면 새 접속이 `53300` 으로 거부된다. 시험이나 풀이 접속을 닫지 않고 쌓아 두면 걸린다. 풀의 `max` 기본값이 5 인 이유이다.
- 서버 동작 가운데 드라이버가 알아낸 것 : (1) 정수 파라미터의 산술(`? + 0`)과 집계(`COUNT(*)`)는 `BIGINT` 로 온다. (2) 서버가 먼저 끊으면 `id: 0` 오류(`57P01`·`57P05`)가 오고 그 뒤 연결이 닫힌다. (3) 열린 커서가 16개를 넘으면 그 `execute` 가 `53400` 이다. (4) 문자열 파라미터의 `CAST(? AS 숫자)` 가 서버 결함으로 `XX000` 이었으나 고쳤다(`rdbms/PROGRESS.md`).
- bun 으로 실행할 때 TLS 클라이언트의 `minVersion`·`maxVersion` 옵션이 적용되지 않고, TLS 가 아닌 서버에 TLS 로 접속하면 오류 코드가 Node.js 와 다르다(인증서가 빈 `ERR_TLS_CERT_ALTNAME_INVALID`). `isCertificateError` 가 이를 처리한다. 구버전 TLS(1.0) 시험은 Node.js 에서만 돈다. 자세한 것은 protocol.md 16절.
- 드라이버는 TCP 와 UDP 로만 접속한다. 로컬 전용 채널과 데몬 제어(구동, 종료, 상태 조회)는 CLI 의 몫이며 드라이버의 범위가 아니다.
- `gui` 는 보류 중이지만 나중에 이 드라이버를 쓰게 된다. 이름이 정해진 공개 API 는 `src/index.ts` 에서 내보내는 것뿐이다.
- 타입 선언 인자의 전체 생략은 DECIMAL/DEC/NUMERIC (10,3), VARCHAR/NVARCHAR 길이 65,535이다. 실제 컬럼의 정밀도/소수 자릿수/길이는 서버 메타데이터(`result.columns`)를 따르며 결과 값을 기본값에 맞춰 재가공하지 않는다. [rdbms 타입 정책](../rdbms/docs/data-types.md)을 참고한다.
- 타입스크립트 6 에서 컴파일되어야 한다(지켜야 할 사항 7). 개발 의존성을 6 으로 묶어 두었다. 7 로 올리지 않는다.

## 작업 이력

- 2026-10-08 : 세부 계획 작성.
- 2026-10-08 : 사양 변경 반영. 패키지명 확정, 포트 번호 하나로 대상 지정(TCP 와 UDP 포트 통합).
- 2026-10-08 : 변경된 타입 기본값과 메타데이터 사용 규칙을 인수인계에 반영했다. 구현 착수 조건은 rdbms 11단계 완료이다.
- 2026-10-16 : `rdbms` 9단계 완료로 프로토콜 명세(`rdbms/docs/protocol.md`)와 클라이언트 참고 코드(`rdbms/src/client`)가 준비되었음을 인수인계에 반영했다.
- 2026-10-16 : `rdbms` 11단계(통합 검증) 완료로 착수 조건을 채웠음을 반영했다. 서버 동작이 바뀐 점(데이터 디렉토리 이동 가능, 인덱스 범위 조건 수정, NULL 타입)은 프로토콜에 영향이 없다.
- 2026-10-17 : **12단계 완료.** `package.json`(패키지 이름을 `nodejsdriver` 로 바로잡음), TypeScript 6 빌드 구성, 프로토콜 계층(메시지·프레임·SCRAM·UDP 신뢰성 계층을 `rdbms` 에서 옮겨 와 드라이버용으로 정리), TCP·TLS·UDP 전송, 공개 API(`connect`, `Connection`, `QueryResult`, `Cursor`, `stream`, 트랜잭션, 이벤트, `DbError`), 값 변환, 커넥션 풀, README 를 작성했다.
  시험 100개(단위 25, 통합 75)가 실제 `rdbms` 로 통과하고, bun 1.3.14 에서도 같다. 패키지를 묶어 설치한 소비자 프로젝트에서 Hello World 와 타입 정의를 확인했다.
  통합 시험이 **서버 결함 하나**(문자열 파라미터의 `CAST(? AS INTEGER)` 가 `XX000`)를 찾아 `rdbms` 에서 고쳤다. 같은 날 `rdbms` 통합 시험 도우미의 데몬 누수와 PID 재사용 문제도 고쳤다(`rdbms/PROGRESS.md`). 커밋은 하지 않았다.
- 2026-10-20 : 코드 점검 항목 D-1 ~ D-8을 수정했다. 기존 시험 100개 통과 후 회귀 14개가 수정 전 실패함을 확인했고 풀 초기화 경계 시험 2개를 더했다. 최종 Node.js 전체 116개 통과·실패 0, Bun은 115개 통과·기존 TLS 1개 건너뜀이다(전체 114개 실행 + 경계 2개가 포함된 회귀 파일 재실행). 시험 후 남은 HelloWorldDB 데몬 0개. README와 두 PROGRESS.md를 갱신했다. 서버 코드와 프로토콜 형식은 바꾸지 않았고 커밋·푸시는 하지 않았다.
