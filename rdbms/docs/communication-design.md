# 통신 계층 설계 (9단계)

9단계(통신)의 작업 설계 문서이다. **9단계는 2026-10-16 에 구현을 마쳤다.** 구현된 프로토콜의 규칙은 [protocol.md](protocol.md)가 기준이고,
이 문서는 구조, 작업 순서, 그렇게 정한 이유의 기록으로 남는다. 구현하면서 설계와 달라진 점은 20절에 모았다. 사양은 AGENTS.md 상세 6, 7, 8, 9, 14, 15 이고,
이 문서는 그 사양을 어떤 구조와 순서로 구현할지, 사양이 정하지 않은 부분을 어떻게 정할지를 적었다.

- 읽는 사람 : 통신 계층을 유지보수할 개발자와 프로토콜 명세를 기준으로 Node.js·Python·JDBC·ODBC 드라이버를 개발할 사람
- JDBC 지원 기준(2026-10-16 반영) : `jdbc6`는 자바 6~7용 JDBC 4.0이며 자바 8 이상에서도 사용 가능해야 한다. `jdbc8`은 자바 8 이상용 JDBC 4.2이다. 자바 5는 지원하지 않으며, 두 JDBC 드라이버의 공통 프로토콜 코드는 자바 6 범위로 작성한다. 서버 프로토콜은 공통이다 (AGENTS.md 상세 8-1).
- 상태 : 구현 완료. 4절(메시지 규약)과 8-4절(UDP 패킷)은 `docs/protocol.md` 로 옮겨 확정했다. 확정 뒤에는 `protocol.md` 가 기준이고, 이 문서는 구조와 작업 순서의 기록이다. 두 문서가 어긋나면 `protocol.md` 를 따른다.
- 설계 중 사용자가 정할 5건은 2026-10-15 에 결정되었고 19절에 기록했다. 그중 사양을 보충하는 것(클라이언트 TLS 검증과 재시도, `udp.maxPacketSize` 범위, `udp.sessionTimeoutMs = 0`)은 AGENTS.md 상세 7, 8 에 반영했다.

## 1. 목표와 범위

완료 기준(AGENTS.md 구현 계획 9단계) : 테스트용 클라이언트로 **세 접속 경로(로컬 전용 채널, TCP, UDP) 모두에서** 로그인, 질의, 대량 결과 수신, 트랜잭션이 동작한다.
UDP 는 패킷 유실과 중복을 일부러 일으킨 조건에서도 통과해야 한다.

범위 안
- 메시지 프로토콜과 명세 문서, 서버 쪽 메시지 처리기, 클라이언트 쪽 프로토콜 구현(`client/connection.ts`)
- 로컬 전용 채널, TCP(SSL 포함), UDP(신뢰성 계층 포함) 세 접속 경로
- SCRAM-SHA-256 인증, 로컬 접속 판정, CONNECT 검사, `maxConnections`
- 큰 결과의 나누어 보내기(커서), 유휴 세션 종료, 연결이 끊긴 세션의 롤백
- 데몬 제어 요청(상태 조회, 종료)의 서버 쪽 처리와 정상 종료 순서에 통신 닫기 끼워 넣기

범위 밖 (다른 단계)
- `hwdb` 명령의 사용자 인터페이스, 데몬을 분리된 프로세스로 띄우기 : 10단계
- 네트워크를 거친 10개 세션 동시성, 두 인스턴스 동시 구동, 개요 항목별 시나리오 : 11단계
- 드라이버의 커넥션 풀, 타입 변환 정책 : 12단계. 이 단계에서는 `client/connection.ts` 가 드라이버의 출발점이 되도록 서버 모듈을 import 하지 않게 만드는 데까지만 한다.
- 문장 취소(cancel), 서버가 먼저 보내는 알림, 압축, UDP 구간 암호화(AGENTS.md 16), 클라이언트 인증서 인증

## 2. 전체 구조

```
          ┌──────────── daemon/server.ts (조립, 구동·종료 순서) ────────────┐
          │                                                                 │
 클라이언트 │  localChannelServer   tcpServer(+TLS)        udpServer          │
 (hwdb,   │   named pipe / unix    net / tls              dgram             │
  드라이버) │        │                  │                    │               │
          │   framing.ts           framing.ts          udpReliability.ts     │
          │   (4바이트 길이)        (4바이트 길이)       (조각·ACK·재전송)       │
          │        └──────────────┬────┴────────────────────┘               │
          │            ConnectionEndpoint (3-1절)                           │
          │                  messageHandler.ts   ← 접속 하나당 하나          │
          │          (상태 기계, 인증, 커서, 제어 요청, JSON 검증)              │
          │                       │                                         │
          │        Database.connect / Session.executeAsync / users          │
          └─────────────────────────────────────────────────────────────────┘
```

- 소켓을 다루는 곳은 세 접속 경로 모듈뿐이다. 메시지 처리기는 소켓을 모르고, 접속 경로 모듈은 SQL 을 모른다. 둘 사이는 `ConnectionEndpoint` 인터페이스 하나로 잇는다(3-1절).
- 의존 방향은 PROGRESS.md 의 규칙을 지킨다. `net` 은 `session` 과 `auth/scram` 만 부르고 `exec`, `catalog` 를 직접 부르지 않는다.
  구동·종료에 대한 요청(상태 조회, 종료)은 `daemon/server.ts` 가 주입하는 `ControlPort` 인터페이스로 받아 `net` 이 `daemon` 을 import 하지 않게 한다.
- 서버와 클라이언트가 함께 쓰는 것은 `net/protocol.ts`(메시지 타입, 상수), `net/framing.ts`, `net/udpReliability.ts`, `auth/scram.ts` 뿐이다. 서버에서만 쓰는 값 변환은 `net/resultEncoder.ts` 로 따로 둔다(4-5, 4-6절).

### 2-1. 모듈별 책임

| 파일 | 책임 | 상태 |
|---|---|---|
| `net/protocol.ts` | 프로토콜 버전, 메시지 타입 정의, 상수(크기 한도, 기본 fetch 크기), 메시지 검증 함수 | 뼈대 → 구현 |
| `net/resultEncoder.ts` | `SqlValue` → JSON 값, `DataType` → 컬럼 메타데이터, 파라미터 JSON → `SqlValue`. 서버 전용 | **새 파일** |
| `net/framing.ts` | 길이 접두 프레임의 인코더와 점진 디코더. 크기 한도 검사 | 뼈대 → 구현 |
| `net/messageHandler.ts` | 접속 하나의 상태 기계, 메시지 검증, 인증, 문장 실행, 커서, 제어 요청, 오류 변환 | 뼈대 → 구현 |
| `net/cursors.ts` | 접속 하나의 커서 저장소(남은 행, 한도) | **새 파일** |
| `net/connectionLimits.ts` | 인증 전 접속 수 제한, 인증 시간 제한, 인증 실패 지연 | **새 파일** |
| `net/localChannelServer.ts` | 이름 있는 파이프 / 유닉스 소켓 서버, 잔여 소켓 정리 | 뼈대 → 구현 |
| `net/tcpServer.ts` | `net`/`tls` 서버, TLS 옵션, 소켓 설정 | 뼈대 → 구현 |
| `net/udpReliability.ts` | 패킷 코덱, 송신자와 수신자 상태 기계, 타이머. 소켓을 모르고 통로를 주입받는다 | 뼈대 → 구현 |
| `net/udpServer.ts` | `dgram` 소켓, 세션 표, 세션 시간 제한 | 뼈대 → 구현 |
| `client/connection.ts` | 세 경로 클라이언트, 요청-응답 짝짓기, 인증, 커서 | 뼈대 → 구현 |
| `session/session.ts` (`Database`) | `Database.connect`(접속 제한과 CONNECT 검사), 세션의 접속 경로 표시 | 수정 |
| `daemon/server.ts` | 세 접속 경로 열기와 닫기, 정상 종료 순서에 통신 닫기 추가, 제어 포트 제공 | 수정 |

## 3. 접속 수명 주기

접속 하나는 상태 기계 하나를 가진다. 상태에 맞지 않는 메시지는 프로토콜 위반(`08P01`)으로 오류를 보내고 접속을 끊는다.
인증 전에는 핸드셰이크와 인증 메시지만 받는다(사양 8).

```
            hello              authStart            authFinish(성공)
  NEW ───────────────▶ GREETED ───────────▶ CHALLENGED ───────────────▶ READY
   │                      │  ▲                   │                        │
   │                      │  └──── control ──┐   │ authFinish(실패)       │ execute, fetch,
   │                      │   (로컬 채널만)  ─┘   ▼                        │ closeCursor, ping
   │                      │                  오류를 보내고 접속 종료        │
   └──────────────────────┴───────────── close / 전송 끊김 / 시간 초과 ─────┴──▶ CLOSED
```

- `NEW` : 접속만 되었고 아무것도 받지 않았다. 인증 시간 제한(10초, 상수)이 시작된다. `GREETED`, `CHALLENGED` 에서도 같은 시간 제한이 이어지며, `READY` 가 되면 해제한다.
- `GREETED` : 프로토콜 버전을 협상했다. `authStart` 또는 `control`(로컬 전용 채널에서만)을 받을 수 있다.
- `CHALLENGED` : SCRAM 서버 첫 메시지를 보냈다. `authFinish` 만 받는다.
- `READY` : 세션이 있다. `execute`, `fetch`, `closeCursor`, `ping`, `close`와 선택 기능의 준비·설명·실행·해제·취소 요청을 받는다. 인증 메시지를 다시 받으면 위반이다. 확정 메시지는 [protocol.md](protocol.md) 5·17절을 따른다.
- `CLOSED` : 세션을 닫았다. 커밋하지 않은 변경은 롤백되고 잠금이 풀린다(`Session.close`, 7단계).
- 인증이 실패하면 오류를 보내고 **접속을 끊는다.** 같은 접속으로 다시 시도하는 것은 허용하지 않는다. 다시 접속해야 하므로 무차별 대입이 느려진다(13절).
- 접속 하나의 일반 요청은 도착 순서대로 처리한다. 앞 요청이 실행·잠금 대기 중이면 뒤 요청은 대기열에 둔다(상한 64개, 넘으면 `53400`으로 끊는다). `close`와 READY 상태의 `cancel`은 대기열을 건너뛰어 바로 처리한다.

### 3-1. 메시지 처리기와 접속 경로의 경계

접속 경로 모듈(로컬 채널, TCP, UDP)이 접속마다 `MessageHandler` 를 하나 만들고, 아래 인터페이스로만 주고받는다. 처리기는 소켓, 프레임, 패킷을 모른다.

```ts
/** 접속 경로 모듈이 처리기에 제공하는 것 */
interface ConnectionEndpoint {
  readonly channel: "local" | "tcp" | "udp";
  readonly remoteAddress: string | null;   // local 이면 null
  send(body: Buffer): void;                // 응답 메시지 하나(JSON 본문). 프레임·조각 나누기는 경로 모듈이 한다
  close(): void;                           // 보낸 것을 모두 내보낸 뒤 접속을 닫는다
}

/** 처리기가 접속 경로 모듈에 제공하는 것 */
class MessageHandler {
  constructor(env: HandlerEnvironment, endpoint: ConnectionEndpoint);
  get maxBodyBytes(): number;   // 지금 상태에서 받을 수 있는 메시지의 최대 크기. 인증 전 64 KiB, 인증 후 16 MiB
  receive(body: Buffer): void;  // 프레임 해석이나 조각 재조립이 끝난 메시지 본문 하나. 안에서 도착 순서대로 처리한다
  dispose(): void;              // 접속이 사라졌을 때 부른다. 세션을 닫고(롤백) 커서와 타이머를 정리한다
}

/** 구동할 때 server.ts 가 만들어 모든 접속에 공통으로 넘기는 것 */
interface HandlerEnvironment {
  database: Database;
  control: ControlPort | null;   // 9절의 ControlPort. 제어 요청을 받을 수 없는 구성(시험 등)이면 null
  limits: ConnectionLimits;      // 인증 전 접속 수, 인증 시간 제한, 실패 지연 (net/connectionLimits.ts)
  logger: Logger;
}
```

- 프레임 디코더는 본문 길이를 읽자마자 `handler.maxBodyBytes` 와 비교한다. 인증을 마치면 한도가 바뀌므로 상태를 처리기가 가진다.
- `receive` 는 동기로 요청을 대기열에 넣고 바로 돌아온다. 처리는 내부 약속 사슬이 도착 순서대로 한다.
- `send` 로 나간 본문의 크기가 16 MiB 를 넘지 않음은 처리기가 책임진다(5-1절).

## 4. 메시지 규약

### 4-1. 봉투

모든 메시지는 UTF-8 JSON 객체 하나이다. 최대 크기는 16 MiB(16,777,216바이트)이며 프레임(8-1절)이나 UDP 재조립(8-4절) 단계에서 가려낸다.

```json
{ "id": 7, "type": "execute", "sql": "SELECT 1" }
```

| 필드 | 설명 |
|---|---|
| `id` | 요청마다 클라이언트가 붙이는 양의 정수(1부터). 응답은 같은 `id` 를 싣는다. `0` 은 서버가 먼저 보내는 메시지(7-4절의 종료 통지)에 쓴다. |
| `type` | 메시지 종류. 문자열. 요청과 응답의 종류 이름은 겹치지 않는다. |
| 그 밖 | 종류마다 정해진 필드. **모르는 필드는 무시한다**(앞으로 필드를 더해도 이전 클라이언트가 동작한다). 모르는 `type` 은 위반이다. |

- 필드 이름은 camelCase 이다. 문자열 안의 SQL 과 데이터는 JSON 이스케이프 규칙을 따른다.
- 서버는 JSON 을 해석한 뒤 종류별 검증 함수로 필드의 타입과 범위를 모두 확인한다. 검증을 통과하기 전에는 어떤 필드도 쓰지 않는다. 외부 스키마 라이브러리는 쓰지 않는다.
- 해석할 수 없는 JSON, 객체가 아닌 최상위 값, `id` 가 없는 요청은 `08P01` 이고 접속을 끊는다. 필드 값만 틀린 요청(예 : `fetchSize` 가 음수)은 `22023` 으로 그 요청만 실패시키고 접속은 유지한다.

### 4-2. 프로토콜 버전 협상

- 이 문서의 프로토콜은 **버전 1** 이다.
- 클라이언트는 `hello` 에 지원하는 버전 목록을 싣는다. 서버는 공통 버전 중 가장 큰 것을 `helloOk.version` 으로 돌려준다. 공통 버전이 없으면 `0A000`(내부 번호 1)로 알리고 끊는다.
- 프로토콜을 바꾸면 버전을 올리고 영향을 받는 드라이버 프로젝트의 PROGRESS.md 에 알린다. 필드 추가는 버전을 올리지 않는다(모르는 필드 무시 규칙). 필드의 뜻을 바꾸거나 지우면 버전을 올린다.

### 4-3. 요청 메시지

| `type` | 필드 | 받을 수 있는 상태 | 설명 |
|---|---|---|---|
| `hello` | `versions: number[]`, `client?: string`, `mechanisms?: string[]` | NEW | 버전과 인증 방식 협상. `mechanisms` 를 생략하면 `["SCRAM-SHA-256"]` |
| `authStart` | `mechanism: "SCRAM-SHA-256"`, `clientFirst: string`, `tablespace?: string`, `timeZone?: string` | GREETED | SCRAM client-first-message. `tablespace` 는 접속 직후의 현재 테이블스페이스(CLI 의 `-t`), `timeZone` 은 세션 타임존 |
| `authFinish` | `clientFinal: string` | CHALLENGED | SCRAM client-final-message |
| `execute` | `sql: string`, `params?: Param[]`, `fetchSize?: number` | READY | 문장 하나 실행. 한 번에 문장 하나만 보낸다 |
| `fetch` | `cursor: number`, `fetchSize?: number` | READY | 커서의 다음 행 묶음 |
| `closeCursor` | `cursor: number` | READY | 커서 닫기 |
| `ping` | (없음) | READY | 세션 유지 확인. 유휴 시간을 되돌리지 않는다(8-4절) |
| `close` | (없음) | NEW 를 뺀 모든 상태 | 정상적인 접속 종료. 응답을 보낸 뒤 서버가 접속을 닫는다 |
| `control` | `action: "status" \| "stop"`, `token: string` | GREETED (로컬 전용 채널만) | 데몬 제어. 10절 |

### 4-4. 응답 메시지

| `type` | 필드 | 응답하는 요청 |
|---|---|---|
| `helloOk` | `version`, `server: string`, `mechanism: "SCRAM-SHA-256"`, `maxMessageBytes`, `defaultFetchSize`, `udp?: { sessionTimeoutMs, maxPacketSize }` | `hello` |
| `authChallenge` | `serverFirst: string` | `authStart` |
| `authOk` | `serverFinal: string`, `session: SessionInfo` | `authFinish` |
| `rows` | `columns: ColumnMeta[]`, `rows: Value[][]`, `cursor?: number`, `hasMore: boolean` | `execute`, `fetch` (조회 결과) |
| `ok` | `message: string`, `rowCount?: number` | `execute` (조회가 아닌 문장) |
| `cursorClosed` | (없음) | `closeCursor` |
| `pong` | (없음) | `ping` |
| `bye` | (없음) | `close` |
| `status` | `running, port, pid, startedAt, version, dataDir, tcpEnabled, udpEnabled, sessionCount` | `control` + `status` |
| `stopping` | (없음) | `control` + `stop` |
| `error` | 4-7절 | 어느 요청에든 |

- `SessionInfo` : `{ id: number, user: string, tablespace: string \| null, timeZone: string, autocommit: boolean }`. 현재 테이블스페이스가 없는 사용자의 `tablespace` 는 `null` 이다(8단계).
- `serverFinal` 은 SCRAM 의 server-final-message(`v=<서버 서명>`)이다. 클라이언트는 이것을 검증해 서버를 확인한다(`verifyServerSignature`).
- `rows` 의 `fetch` 응답에도 `columns` 를 다시 싣지 않는다. 첫 응답(`execute`)에서만 싣고, `fetch` 응답은 `columns` 를 생략한다(`rows`, `cursor`, `hasMore` 만).

### 4-5. 값 표현

사양 8 : 정밀도를 잃지 않도록 BIGINT, NUMERIC, 날짜시간, INTERVAL 은 문자열로, 이진 값은 16진 문자열로 보내고 나머지는 JSON 기본 타입을 쓴다. 실제 타입은 컬럼 메타데이터에 적는다.
문자열 표기는 `types/value.ts` 의 `formatValue` 와 같고([data-types.md](data-types.md)), 이미 구현되어 있어 서버는 이 함수를 그대로 쓴다.

| 타입 | JSON 값 | 예 |
|---|---|---|
| NULL | `null` | `null` |
| `CHAR`, `VARCHAR`(`NCHAR`, `NVARCHAR` 포함) | 문자열 | `"Hello World"` |
| `BINARY`, `VARBINARY` | 대문자 16진 문자열 | `"AB12"` |
| `SMALLINT`, `INTEGER` | JSON 숫자 | `42` |
| `BIGINT` | 10진 문자열 | `"5000000000"` |
| `NUMERIC`, `DECIMAL` | 10진 문자열(소수 자릿수 유지) | `"1.50"` |
| `REAL`, `DOUBLE PRECISION` | JSON 숫자 (NaN, 무한대는 값이 될 수 없다) | `1.5` |
| `BOOLEAN` | `true`, `false` | `true` |
| `DATE` | `YYYY-MM-DD` | `"2026-10-15"` |
| `TIME` | `HH:MM:SS[.ffffff]` (선언 자릿수), `WITH TIME ZONE` 은 `+09:00` 을 붙임 | `"13:05:07"` |
| `TIMESTAMP` | `YYYY-MM-DD HH:MM:SS[.ffffff]` (선언 자릿수), `WITH TIME ZONE` 은 `+09:00` 을 붙임 | `"2026-10-15 13:05:07.250"` |
| `INTERVAL` | `formatInterval` 표기 | `"1-02"`, `"3 04:05:06.500000"` |

행은 컬럼 순서의 배열이다(`rows: [[1, "a"], [2, null]]`). 컬럼 이름을 행마다 반복하지 않는다.

### 4-6. 컬럼 메타데이터

`ColumnMeta` 는 값을 해석하고 JDBC 메타데이터를 만드는 데 필요한 정보를 모두 가진다. 서버의 `DataType` 에서 만든다(`resultEncoder.ts`).

| 필드 | 설명 |
|---|---|
| `name` | 컬럼 이름 |
| `typeName` | 정규 타입 이름. `SMALLINT`, `INTEGER`, `BIGINT`, `DECIMAL`, `REAL`, `DOUBLE PRECISION`, `CHAR`, `VARCHAR`, `BINARY`, `VARBINARY`, `BOOLEAN`, `DATE`, `TIME`, `TIME WITH TIME ZONE`, `TIMESTAMP`, `TIMESTAMP WITH TIME ZONE`, `INTERVAL` |
| `declared` | 선언 표기(`formatDataType`). 예 : `DECIMAL(10,3)`, `VARCHAR(100)` |
| `length` | 문자·이진 타입의 길이 |
| `precision`, `scale` | `DECIMAL` |
| `fractionalPrecision` | `TIME`, `TIMESTAMP`, `INTERVAL` 의 소수 초 자릿수 |
| `startField`, `endField`, `leadingPrecision` | `INTERVAL` |

해당하지 않는 필드는 생략한다. 컬럼의 NULL 허용 여부는 질의 결과에서는 알 수 없으므로 싣지 않는다(실제 테이블의 정의는 `SYS_COLUMNS` 로 본다).

### 4-7. 오류 응답

```json
{ "id": 7, "type": "error", "sqlState": "42501", "code": 7001, "message": "Permission denied: SELECT on \"APP.T\".", "position": { "line": 1, "column": 15, "offset": 14 } }
```

- `sqlState`, `code`, `message` 는 `DbError` 의 것을 그대로 싣는다. `position` 은 있을 때만 싣는다(문법 오류는 항상 있다. PROGRESS.md 공통 인수인계 사항). 메시지는 영문이다(사양 0).
- `DbError` 가 아닌 예외는 세션이 이미 `XX000` 으로 바꾼다. 통신 계층의 예상 밖 예외도 `XX000` 으로 보내고 접속은 끊는다. 스택이나 내부 경로는 응답에 싣지 않고 로그에만 남긴다.
- 문장 오류(문법, 권한, 제약 위반, 잠금 대기 초과, 교착 등)는 **접속을 끊지 않는다.** 교착(`40P01`)은 서버가 그 트랜잭션을 이미 롤백했지만 세션은 그대로이므로 클라이언트는 같은 접속에서 다시 시도한다(7단계 규칙).
- 접속을 끊는 경우는 다음뿐이다. 응답으로 `error` 를 보내고 닫는다.
  - 클라이언트 잘못 : `08P01` 프로토콜 위반, `28000` 인증 실패, CONNECT 거부, `maxConnections` 초과, 인증 시간 초과(이때는 응답 없이 닫는다)
  - 서버 사정 : 내부 오류 `XX000`
  - 서버가 먼저 끊는 경우(서버 종료 `57P01`, 유휴 시간 초과 `57P05`)는 요청에 대한 응답이 아니므로 `id: 0` 인 `error` 를 보내고 닫는다.

### 4-8. 파라미터

`execute.params` 의 원소(`Param`)는 다음 중 하나이다. 서버는 기존 `Session.execute` 의 규칙(문자열은 문맥 타입으로 해석, 그 밖은 `assignValue`)을 그대로 쓴다.

| JSON | 서버가 만드는 값 |
|---|---|
| `null` | NULL |
| `true`, `false` | BOOLEAN |
| 정수 숫자(안전 정수 범위) | `bigint` |
| 소수 숫자 | `number`(배정도) |
| 문자열 | 타입 없는 문자열. 컬럼·식의 타입으로 해석한다. **BIGINT 와 NUMERIC, 날짜시간은 문자열로 보내는 것이 정확하다** |
| `{ "binary": "AB12" }` | `Buffer` (16진 문자열) |

- JSON 숫자는 안전 정수 범위(±2^53-1)를 넘으면 정밀도를 잃으므로, 드라이버는 그 범위를 넘는 정수를 문자열로 보내야 한다. 서버는 안전 정수를 벗어난 JSON 숫자를 `22003` 으로 거부한다(조용히 반올림하지 않는다).
- 개수가 `?` 와 맞지 않으면 기존대로 `07001` 이다.

## 5. 결과 전달과 커서

2026-10-20 후속 구현에서 네트워크 결과는 실행 시점의 행을 임시 파일에 보관하도록 바꾸었다. 단순 스캔·필터·투영·행 제한·CROSS JOIN은 지연 순회하고, 복합 질의는 중간 결과를 메모리에 구체화할 수 있다. 실행은 주기적으로 제어를 돌려 취소와 다른 연결의 요청을 처리한다. 확정 규약은 [protocol.md](protocol.md) 10·17절이다.

- 조회 결과가 한 묶음(5-1절)에 다 들어가면 `rows`(`hasMore: false`)로 끝난다. 아니면 첫 묶음과 함께 `cursor` 번호(접속 안에서 1부터 늘어나는 정수)와 `hasMore: true` 를 보내고 나머지 행을 커서 저장소(`net/cursors.ts`)에 둔다.
- `fetch` 는 다음 묶음을 보낸다. 마지막 묶음이면 `hasMore: false` 로 알리고 커서는 서버가 지운다. 그 뒤의 `fetch` 는 `34000`(커서 없음)이다.
- `closeCursor` 는 남은 행을 버린다. 이미 없는 커서를 닫는 것은 오류가 아니다.
- 커서는 접속이 끝나면 모두 버린다. 커밋과 롤백은 커서를 무효로 만들지 않는다(결과는 문장이 실행된 시점의 행을 복사해 둔 것이다 — "홀더블" 의미). 새 `execute` 도 열려 있는 커서를 닫지 않는다.
- 접속 하나가 동시에 열어 둘 수 있는 커서는 16개이다. 넘으면 `53400`(구성 한도 초과)으로 실행을 거부한다. 결과 파일·핸들의 수를 제한하며, 마지막 fetch·닫기·접속 종료 때 정리한다.

### 5-1. 묶음 크기

- 행 수 : 요청의 `fetchSize` 가 있으면 그것, 없으면 `defaultFetchSize`(500). 상한은 100,000 이고 넘으면 상한으로 줄인다. 0 이하이면 `22023`.
- 바이트 : 행을 하나씩 JSON 으로 인코딩하며 쌓다가 묶음이 **1 MiB** 를 넘기 직전에 멈춘다. 행 수를 못 채워도 멈춘다. 묶음에는 항상 행이 하나 이상 들어간다.
- 행 하나만으로 한 메시지에 들어가지 않으면(`16 MiB` 에서 봉투 여유를 뺀 값 초과) 그 `execute` 는 `54000`(처리 한도 초과)으로 실패한다. `VARCHAR` 가 65,535자이고 컬럼이 최대 1,000개이므로 이론상 가능하다.
- 인코딩한 행의 크기는 `Buffer.byteLength` 로 센다. 같은 인코딩 결과를 그대로 메시지에 이어 붙여 두 번 인코딩하지 않는다.

한계: 정렬·집계·DISTINCT·집합 연산 등 중간 결과의 메모리 사용량까지 제한하는 외부 연산은 제공하지 않는다. 미커밋 트랜잭션 오버레이도 메모리를 사용한다.

## 6. 인증

SCRAM-SHA-256 교환의 서버 쪽 순서이다(`auth/scram.ts` 의 함수를 그대로 쓴다. RFC 7677 시험 벡터로 검증되어 있다).

```
클라이언트                                              서버
  hello {versions}                          ─────────▶
                                            ◀─────────  helloOk
  authStart {clientFirst, tablespace?}      ─────────▶  parseClientFirst
                                                        verifierOf(사용자) 또는 decoyVerifier
                                            ◀─────────  authChallenge {serverFirst}
  authFinish {clientFinal}                  ─────────▶  parseClientFinal, nonce·channel binding 확인
                                                        verifyClientProof
                                                        (성공) 로컬 판정 → CONNECT 검사 → 접속 수 제한 → 세션 생성
                                            ◀─────────  authOk {serverFinal, session}
```

- 서버 nonce 는 `generateNonce()` 로 만들어 클라이언트 nonce 뒤에 붙인다(`combined`). `clientFinal` 의 nonce 가 `combined` 와 다르거나 채널 바인딩이 `biws` 가 아니면 인증 실패이다.
- 없는 사용자는 `decoyVerifier(이름, 구동 때 정한 비밀값)` 로 같은 절차를 끝까지 진행한다. 마지막 응답이 "인증 실패" 로 같고, 솔트가 같은 이름에는 항상 같아 존재 여부를 알 수 없다.
  (한계 : 사용자 계정이 다른 반복 횟수로 만들어졌으면 가짜 검증 정보의 반복 횟수와 달라 구별될 수 있다. 계정을 모두 기본 횟수로 만들면 문제가 없고, 횟수를 바꾸는 것은 config.json 키가 아니므로 운영에서는 해당 없다.)
- 인증 실패 응답은 `28000` "Authentication failed." 하나이다(사용자 없음, 비밀번호 틀림, nonce 불일치 모두).
- 인증이 성공한 뒤의 거부는 인증 실패와 구별되는 오류이다. 비밀번호를 맞게 낸 사람에게만 알려지기 때문이다.
  - 로컬이 아닌데 CONNECT 가 없다 : `28000` 이지만 내부 번호 7006, 메시지 "User is not allowed to connect remotely; …"
  - `maxConnections` 초과 : `53300`(`too_many_connections`, 새 번호 8001)
- 세션 생성은 `Database.connect`(7-3절) 한 곳에서 한다. 접속 경로 모듈이 `createSession` 을 직접 부르지 않는다.
- 비밀번호는 어디에도 평문으로 오가지 않는다. 암호화되지 않은 TCP 와 UDP 에서도 같다. 단, 이후의 SQL 문장과 결과는 TLS 가 아니면 평문이다(UDP 는 항상 평문).

## 7. 세션과 접속 정책

### 7-1. 로컬 접속 판정

로그인 시점에 한 번 정한다(사양 6).

| 접속 경로 | 로컬 여부 |
|---|---|
| 로컬 전용 채널 | 항상 로컬 |
| TCP, UDP | 상대 주소가 `127.0.0.0/8`, `::1`, 그리고 IPv4 로 매핑된 루프백(`::ffff:127.x.x.x`)이면 로컬 |

- 서버 장비의 비루프백 주소(LAN IP 등)로 같은 장비에서 접속하면 **원격** 으로 본다. 사양이 루프백 주소만 로컬로 정했기 때문이다. 이 장비에서 항상 되어야 하는 접속은 로컬 전용 채널(`hwdb`)이다.
- UDP 의 상대 주소는 위조될 수 있다. 운영체제는 보통 외부 인터페이스에서 들어온 루프백 출발지 패킷을 버리지만 보장되지 않는다. 이 한계는 문서에 적고, UDP 가 애초에 암호화되지 않는다는 점과 같이 알린다.

### 7-2. 접속 수 제한

- `maxConnections` 는 **인증을 마친 TCP·UDP 세션 수** 의 상한이다. 로컬 전용 채널의 세션은 세지 않는다(사양 9).
- 인증 전 접속은 이 수에 넣지 않고 따로 제한한다 : 동시에 `max(16, 2 × maxConnections)` 개까지, 인증 시간 제한 10초. 넘는 새 접속은 바로 닫는다(오류 메시지를 보내지 않는다 — 불필요한 응답을 만들지 않기 위함).
  이렇게 하면 인증하지 않는 접속 폭주가 정상 사용자의 자리를 차지하지 못하면서 서버 자원도 묶이지 않는다.
- 확인은 두 곳에서 한다. `hello` 를 받을 때 이미 가득 차 있으면 일찍 거절(`53300`)하고, 세션을 만드는 `Database.connect` 가 마지막으로 확인한다(그 사이 다른 접속이 들어왔을 수 있다. 서버는 한 스레드이므로 이 확인은 원자적이다).

### 7-3. `Database.connect` (8단계 인수인계 사항의 이행)

8단계는 `createSession`(인증이 끝난 접속용)과 `assertMayConnect` 를 넘겼다. 접속 경로 모듈마다 이 둘을 따로 부르면 빠뜨릴 수 있으므로, 9단계에서 하나로 묶는다.

```ts
database.connect({
  user, tablespace?, timeZone?,
  channel: "local" | "tcp" | "udp",
  remoteAddress: string | null,   // local 이면 null
})  // → Session. 실패 시 28000 (CONNECT 없음, 7006) 또는 53300 (접속 수 초과, 8001)
```

- 로컬 판정(7-1)을 안에서 한다 : `channel === "local"` 이거나 `remoteAddress` 가 루프백. `assertMayConnect(user, local)` 를 부른다.
- `channel !== "local"` 이면 `maxConnections` 를 확인한다. `DatabaseOptions.maxConnections` 를 새로 받는다(기본 제한 없음. 데몬이 `config.maxConnections` 를 넘긴다).
- 세션에 `channel`, `remoteAddress` 를 기록한다. `SessionInfo` 에 넣고 `SYS_SESSIONS` 에 `CHANNEL`(`LOCAL`/`TCP`/`UDP`), `CLIENT_ADDRESS` 컬럼을 **끝에** 더한다(기존 열 순서를 바꾸지 않는다. 19절 결정 2).
- 기존 `createSession` 은 시험과 내부용으로 남긴다. `channel` 은 기본 `"local"` 이다.

### 7-4. 세션 종료 시나리오

| 상황 | 동작 |
|---|---|
| 클라이언트가 `close` 를 보냄 | `bye` 응답 후 세션 닫기(롤백), 접속 닫기 |
| TCP/로컬 연결이 끊김(`close`/`error`) | 세션 닫기. 진행 중이던 문장의 잠금 대기는 `Session.close` 가 취소한다 |
| UDP 에서 `udp.sessionTimeoutMs` 동안 수신 없음 | 세션 닫기. 문장을 실행 중인 세션은 시간 제한을 적용하지 않는다 |
| `session.idleTimeoutMs` 초과 | `SessionManager.sweepIdle` 이 세션을 닫으면 `onClose("idle")` 로 알려 받아 `id: 0` 오류(`57P05`)를 보내고 접속을 닫는다 |
| 서버 정상 종료 | 9절의 순서. 세션은 `onClose("shutdown")` 로 알려 받아 `id: 0` 오류(`57P01`)를 보내고 닫는다 |
| 인증 시간 초과 | 오류 없이 접속을 닫는다 |

- 모든 경로에서 `Session.close` 가 롤백과 잠금 해제를 하므로, 통신 계층의 책임은 "접속이 사라지면 반드시 `close` 를 부른다" 이다. 접속 하나당 정리 함수를 한 곳(`MessageHandler.dispose`)에 두고 모든 종료 경로가 거기로 모이게 한다.

## 8. 접속 경로별 설계

### 8-1. 프레임 (로컬 전용 채널과 TCP 공통)

`본문 길이(uint32, 빅엔디언)` + `JSON 본문`이 메시지 하나이다(사양 8).

- 디코더는 들어오는 조각을 모아 길이 4바이트를 읽고 본문 길이만큼 모이면 메시지 하나를 내보낸다. 한 번의 `data` 에 여러 메시지가 오거나 한 메시지가 여러 번에 나뉘어 오는 경우를 모두 처리한다.
- **본문을 모으기 전에 길이를 검사한다.** 한도를 넘으면 본문을 받지 않고 `08P01` 로 접속을 끊는다. 한도는 인증 전 64 KiB, 인증 후 16 MiB 이다(인증 전 메시지는 모두 작으므로 폭주로 메모리를 쓰게 하지 못한다).
- 본문이 모이는 동안의 버퍼는 `Buffer.concat` 반복 대신 조각 목록으로 쥐고 완성 때 한 번 합친다. 길이 0 인 본문은 위반이다.
- 보내기 : `socket.write` 가 `false` 를 돌려주면 `drain` 까지 그 접속의 요청 처리를 멈춘다(3절의 대기열 상한과 맞물려 메모리 폭주를 막는다).
- 소켓 옵션 : `setNoDelay(true)`(작은 메시지의 지연 제거), `setKeepAlive(true, 30_000)`(끊어진 상대 감지). 읽기 유휴 제한은 두지 않는다(세션 유휴는 `session.idleTimeoutMs` 가 한다).

### 8-2. TCP 와 TLS

- 바인드 : `tcp.host` : `config.port`. `tcp.enabled=false` 면 열지 않는다. 열지 못하면(포트 사용 중 등) 구동에 실패한다(사양 7).
  기본값 `0.0.0.0` 은 IPv4 만 받는다. IPv6 로 받으려면 `tcp.host` 를 `::` 로 둔다. (클라이언트가 `localhost` 를 `::1` 로 풀어도 Node.js 의 `autoSelectFamily` 로 IPv4 에 다시 시도한다.)
- TLS : `tcp.ssl.certPath` 와 `keyPath` 가 모두 있으면 `tls.createServer` 로 **포트 전체를 TLS 로** 운영한다. 평문 접속은 받지 않는다(TLS 핸드셰이크가 아닌 바이트는 연결 단계에서 끊긴다). 하나만 있으면 구동 실패(이미 `config.ts` 가 검사한다).
  인증서와 키는 구동 때 한 번 읽는다. 읽기 실패와 형식 오류는 구동 실패이다. 암호가 걸린 키는 지원하지 않는다(config 에 passphrase 키가 없다).
- 최소 버전 : `minVersion = tcp.ssl.minVersion`(기본 `TLSv1.2`). 최대 버전은 제한하지 않는다.
- **구버전 TLS(`TLSv1`, `TLSv1.1`)** : TLS 1.2를 쓸 수 없는 자바 6 클라이언트를 받기 위한 설정이다(사양 8). 최신 Node.js의 OpenSSL 3은 보안 수준 1에서 TLS 1.0/1.1을 끄므로, `minVersion`이 `TLSv1.2`보다 낮을 때만 `ciphers`에 `@SECLEVEL=0`을 붙이고(예 : `DEFAULT:@SECLEVEL=0`) 구동 로그에 경고를 남긴다. 사양의 "그 버전에서 쓰는 암호 스위트도 함께 허용"에 해당한다.
  - 실제 동작은 OpenSSL 빌드에 달려 있다. 구현 단계에서 (a) Node.js `tls.connect({ maxVersion: 'TLSv1' })`로 서버에 붙는 시험과 (b) 가능하면 `openssl s_client -tls1`로 확인한다. 안 되는 환경이면 시험을 건너뛰고 문서에 환경 조건을 적는다. 실제 자바 6 접속 확인은 `jdbc6` 단계의 몫이다(PROGRESS.md 미결 사항 그대로).
- 인증서 갱신은 재시작해야 반영된다(config.json 과 같은 규칙).
- 클라이언트가 서버 인증서를 검증하는 방법과, 인증서 오류 때 다시 시도하는 규칙은 12-1절에 있다.
- 시험용 인증서 : 자체 서명 인증서와 키를 `test/fixtures/tls/` 에 두고 만드는 명령(`openssl req -x509 …`)을 같은 폴더의 README 에 적는다. 유효 기간은 길게(약 100년) 잡아 시험이 만료로 깨지지 않게 한다. 시험 전용 키이며 실제 서비스에 쓰지 않는다고 적는다.

### 8-3. 로컬 전용 채널

- 주소 : `getLocalChannelAddress(port)`(`common/instance.ts`). Windows 는 `\\.\pipe\helloworlddb-<포트>`, 그 외는 `/tmp/helloworlddb-<포트>.sock`.
- 설정(`tcp`, `udp`, SSL)과 무관하게 항상 연다. 열지 못하면 구동에 실패한다(같은 포트의 다른 인스턴스가 이미 쓰고 있을 때 포함 — 오류 메시지에 "포트 번호는 인스턴스의 식별자" 임을 알린다).
- 이 채널로 들어온 접속은 `channel: "local"` 로 표시된다. 로컬 판정이 항상 참이고, `maxConnections` 에서 빠지며, `control` 요청을 받을 수 있다.
- **유닉스 소켓의 안전** : 소켓 파일의 권한을 `0600` 으로 만든다. 만드는 방법(`listen` 직후 `fs.chmod`, 임시 `umask`, 사적인 디렉토리에서 만든 뒤 옮기기)은 접속 사이의 틈이 없는 쪽으로 구현 때 시험하여 고른다.
  클라이언트는 연결하기 전에 소켓 파일의 소유자가 자기 uid 인지 확인한다. `/tmp` 에서 남이 같은 이름을 미리 만들어 둔 경우 제어 토큰이 새는 것을 막기 위함이다. Windows 의 네임드 파이프는 기본 접근 제어를 따른다.
- **잔여 소켓 파일** : 구동할 때 경로에 파일이 남아 있으면 연결을 시도한다. `ECONNREFUSED` 면 죽은 소켓이므로 지우고 다시 연다. 연결되면 다른 프로세스가 쓰는 중이므로 구동 실패이다(데이터 디렉토리 잠금 파일이 같은 데이터를 막지만, 다른 설치 디렉토리가 같은 포트를 쓰는 경우는 이 검사로 막는다 — 사양 15). 정상 종료 때 소켓 파일을 지운다.
- 프레임과 메시지 처리기는 TCP 와 같다. 암호화하지 않는다.

### 8-4. UDP 신뢰성 계층

UDP 는 유실, 중복, 순서 뒤바뀜이 있고 패킷 크기에 제한이 있다. 메시지 단위의 전달을 보장하는 계층을 `udpReliability.ts` 에 둔다.

#### 패킷 레이아웃 (빅엔디언, 헤더 20바이트)

| 오프셋 | 크기 | 필드 | 설명 |
|---|---|---|---|
| 0 | 2 | `magic` | `0x4857` (`HW`). 다르면 버린다(응답하지 않는다) |
| 2 | 1 | `version` | 전송 계층 버전. 1. 다르면 버린다 |
| 3 | 1 | `flags` | 비트 : `0x01 SYN`(세션 열기), `0x02 ACK`, `0x04 DATA`, `0x08 FIN`(세션 닫기), `0x10 RST`(알 수 없는 세션) |
| 4 | 4 | `sessionId` | 서버가 발급한 세션 번호. 세션을 열기 전의 클라이언트 `SYN` 은 0 |
| 8 | 4 | `seq` | 메시지 번호. DATA 는 보내는 쪽이 방향별로 1부터 늘린다. ACK 는 확인하는 메시지의 번호 |
| 12 | 2 | `fragIndex` | 조각 번호(0부터). ACK 는 확인하는 조각의 번호 |
| 14 | 2 | `fragCount` | 그 메시지의 전체 조각 수(1 이상). ACK 에서는 0 |
| 16 | 4 | `ackSeq` | 이 패킷을 보내는 쪽이 **끝까지 받은** 상대 메시지의 가장 큰 번호(누적 확인). 없으면 0 |
| 20 | n | payload | DATA 의 조각 본문 |

- 사양의 헤더 항목(매직 넘버, 프로토콜 버전, 세션 ID, 순번, 조각 번호와 전체 조각 수, 플래그)을 모두 담고, 누적 확인(`ackSeq`)을 더했다.
- 패킷 하나의 최대 크기는 `udp.maxPacketSize`(기본 1200) 이다. 조각 본문은 `maxPacketSize - 20` 바이트까지이다.
  이 값의 범위는 64 이상 65,507 이하로 config 검증에 더한다(19절 결정 4. 지금은 1 이상이면 통과하므로 헤더도 못 담는 값이 가능하다).
- 메시지 하나는 최대 16 MiB 이므로 `fragCount`(uint16, 최대 65,535)로 충분하다. 기본값에서는 약 14,200 조각이다. 조각 수가 한도를 넘는 메시지는 보내기 전에 `54000` 으로 거부한다.

#### 세션 열기

1. 클라이언트가 `SYN|DATA`(`sessionId=0`, `seq=1`)로 `hello` 메시지를 보낸다.
2. 서버는 주소(IP:포트)로 대기 중인 세션이 있는지 찾는다. 있으면 같은 `SYN` 의 재전송이므로 같은 응답을 다시 보낸다. 없으면 **암호학적 난수로 0 이 아닌 32비트 세션 번호** 를 발급하고 세션을 만든다(인증 전 제한 안에서).
3. 서버는 `SYN|DATA|ACK`(`sessionId=<발급한 번호>`, `seq=1`, `ackSeq=1`)로 `helloOk` 를 돌려준다. 이 응답은 요청보다 크지 않게(`helloOk` 는 작다) 만들어 증폭 공격에 쓰이지 못하게 한다.
4. 이후의 모든 패킷은 `sessionId` 를 싣고, 서버는 `sessionId` **와** 출발지 주소가 모두 맞을 때만 받아들인다. 주소가 다르면 응답 없이 버린다(출발지 변경이 필요한 NAT 환경은 지원하지 않는다). 모르는 `sessionId` 에는 `RST` 로 답한다(20바이트 헤더뿐이라 증폭이 없다).
5. 세션을 닫을 때는 `FIN` 을 보내고 `ACK` 를 받는다(받지 못해도 시간 제한으로 정리). `FIN` 을 받으면 서버는 세션을 닫고(롤백) `ACK` 한다.

#### 송신자 (방향마다 하나)

- 규칙 : **한 번에 메시지 하나만 전송 중으로 둔다.** 전송 중이란 "모든 조각의 ACK 를 받지 못한" 상태이다. 다음 메시지는 대기열에서 기다린다. 요청-응답이 한 번에 하나씩이라 처리량 손실이 없고, 수신 쪽이 항상 `seq == expected` 한 가지 경우만 다루면 되어 순서 보장이 단순해진다. 응답 대기와는 무관하다(요청 메시지의 ACK 는 즉시 오므로 `ping` 은 오래 걸리는 문장 뒤에도 보낼 수 있다).
- 창 : 한 메시지 안에서 동시에 미확인으로 둘 수 있는 조각은 최대 32개(상수). 조각마다 ACK 가 오면 창이 움직인다.
- 재전송 : 조각마다 보낸 시각을 기록하고, 재전송 제한 시간(RTO) 안에 ACK 가 없으면 그 조각을 다시 보낸다. RTO 는 RFC 6298 방식으로 구한다 — 재전송하지 않은 조각의 왕복 시간만 표본으로 쓰고(Karn), 초기값 300 ms, 하한 50 ms, 상한 3 s, 재전송마다 2배(상한까지).
  한 조각이 10번 재전송되고도 ACK 가 없으면 상대가 사라진 것으로 보고 세션을 실패시킨다. 서버는 세션을 닫고(롤백), 클라이언트는 `08006` 오류를 올린다.
- 누적 확인 : 상대 패킷의 `ackSeq` 가 현재 메시지 번호 이상이면 남은 조각의 ACK 가 유실되었어도 메시지 전송을 끝낸 것으로 본다.

#### 수신자 (방향마다 하나)

- 상태 : `expectedSeq`(다음에 완성할 메시지 번호, 처음 1), 현재 메시지의 조각 표, 이미 받은 조각 수와 바이트 수.
- `DATA` 를 받으면
  - `seq < expectedSeq` : 이미 전달한 메시지의 중복이다. 조각은 버리되 **ACK 는 다시 보낸다**(상대의 ACK 가 유실되어 재전송한 경우).
  - `seq == expectedSeq` : 조각을 저장한다. 이미 있는 조각이면 중복이므로 무시하되 ACK 는 보낸다. `fragCount` 가 처음 본 값과 다르거나 한도를 넘으면 위반이다. 모든 조각이 모이면 순서대로 이어 붙여 메시지 하나로 **위로 전달** 하고 `expectedSeq` 를 올린다.
  - `seq > expectedSeq` : 송신자 규칙상 올 수 없다(이전 메시지가 모두 확인되어야 다음을 보낸다). 버린다.
- 조각마다 즉시 `ACK`(`seq`, `fragIndex`, `ackSeq`)를 보낸다. 메시지가 완성되면 `ackSeq` 가 올라간다. 지연 ACK 는 쓰지 않는다(구현이 단순하고 왕복이 짧다).
- 재조립 메모리 : 세션당 하나의 메시지만 조립하므로 한도는 16 MiB 이다. 인증 전 세션은 64 KiB 로 줄인다(8-1과 같다). 한도를 넘는 `fragCount` 나 누적 바이트는 세션을 끊는다.
- 전달 순서는 메시지 번호 순서와 같다. 위에 한 번에 한 메시지만 올라가므로 별도의 정렬이 필요 없다.

#### 시간 제한

- `udp.sessionTimeoutMs`(기본 60,000) 동안 그 세션의 유효한 패킷(ACK 포함)이 하나도 없으면 서버가 세션을 닫는다. 문장을 실행하는 중인 세션은 제외한다.
  `0` 은 시간 제한 없음으로 해석하고(`session.idleTimeoutMs` 와 같은 규칙, 19절 결정 3) 구동 로그에 경고한다. 죽은 클라이언트의 세션이 쌓일 수 있기 때문이다.
- 클라이언트 라이브러리는 유휴 상태에서 `sessionTimeoutMs / 3` 마다 `ping` 메시지를 보낸다(`helloOk.udp.sessionTimeoutMs` 로 값을 안다). `ping` 은 `session.lastActivity` 를 되돌리지 않으므로 `session.idleTimeoutMs` 는 그대로 적용된다.
- 인증 전 세션(`SYN` 만 받고 인증을 못 끝낸)은 10초 뒤에 지운다.

#### 주입 가능한 구조

`udpReliability.ts` 는 소켓을 직접 열지 않는다. 통로와 시계를 주입받는다.

```ts
interface PacketPort { send(packet: Buffer): void }          // 한 상대에게 보낸다
interface Clock { now(): number; setTimer(ms: number, fn: () => void): { cancel(): void } }
class ReliableEndpoint {
  constructor(port: PacketPort, clock: Clock, options: { maxPacketSize, onMessage(buf: Buffer): void, onFailure(error: Error): void })
  sendMessage(buf: Buffer): void       // 대기열에 넣는다
  receivePacket(packet: Buffer): void  // 소켓에서 받은 패킷을 넣는다
}
```

- 서버는 세션마다 `ReliableEndpoint` 하나를 두고 `PacketPort` 를 `dgram` 소켓의 `send(packet, port, address)` 로 만든다. 클라이언트도 같은 클래스를 쓴다.
- 시험에서는 가짜 시계(시간을 손으로 흘림)와 **유실·중복·지연·순서 뒤바뀜을 일으키는 시뮬레이터**를 두 끝점 사이에 끼운다. 시뮬레이터는 시드가 있는 난수로 결정적으로 동작하여 실패 사례를 재현할 수 있다(14절).

### 8-5. UDP 서버

- `dgram.createSocket({ type: 'udp4' | 'udp6' })`(`udp.host` 로 정함) 소켓 하나를 `config.port` 에 바인드한다.
- 세션 표 : `sessionId → { endpoint, address, port, handler, lastReceived }`, 대기 세션 표 : `"주소:포트" → 세션`.
- 패킷을 받으면 헤더를 검사하고(`magic`, `version`, 길이) 세션을 찾아 `endpoint.receivePacket` 에 넘긴다. 잘못된 패킷은 조용히 버린다. 오류 응답 패킷은 `RST` 뿐이다.
- Windows 에서 상대가 없을 때 ICMP "포트 도달 불가" 로 `dgram` 소켓에 `ECONNRESET` 오류가 올라올 수 있다. 소켓 `error` 를 세션이 아니라 소켓 단위로 받아 로그만 남기고 소켓을 닫지 않는다.
- 세션 시간 제한 점검은 1초 주기 타이머 하나로 한다(`unref`).

## 9. 서버 조립과 구동·종료

`daemon/server.ts` 가 다음을 한다(구성 요소를 서로 잇는 일은 이 파일에서만 한다는 규칙).

구동 순서 (사양 14-1, 9)
1. 잠금 파일 확보 → `Database.open`(`maxConnections` 와 타임존 등 전달) — 기존과 같다.
2. **로컬 전용 채널 열기**(항상). 실패하면 구동 실패.
3. TCP 열기(`tcp.enabled`). 켜 둔 포트를 열 수 없으면 구동 실패.
4. UDP 열기(`udp.enabled`). 켜 둔 포트를 열 수 없으면 구동 실패.
5. 구동 로그 : 열린 경로와 포트, TLS 사용 여부와 최소 버전(구버전이면 경고), 초기 암호 경고(8단계).
6. 구동이 끝났음을 알린다(`hwdb start` 가 기다리는 신호 — 10단계).
(어느 단계에서 실패하든 이미 연 것은 닫고, 데이터베이스를 닫고, 잠금 파일을 지운다. 현재 `Server.start` 의 실패 처리와 같은 규칙이다.)

정상 종료 순서 (사양 12 : 새 접속 차단 → 진행 중인 트랜잭션 롤백 → 데이터 파일 반영 → 정상 종료 표시)
1. TCP 와 UDP 의 **새 접속 받기를 멈춘다**(리스너를 닫는다. 기존 접속은 유지). 로컬 전용 채널도 새 접속은 막되, 종료를 요청한 접속의 응답은 보낼 수 있게 둔다.
2. `Database.close()` : 새 세션을 막고 모든 세션을 닫는다(롤백, 잠금 해제, 잠금 대기 취소). 이어서 테이블스페이스를 닫아 정상 종료 표시를 쓴다. 세션이 닫히며 `onClose("shutdown")` 로 접속마다 `57P01` 오류가 나간다.
3. 남은 소켓을 모두 닫고(일정 시간 안에 비워지지 않으면 강제로 `destroy`), 로컬 채널의 소켓 파일을 지운다.
4. 잠금 파일 제거.

- `control stop` 요청을 처리하는 접속은 `stopping` 응답을 **쓰고 flush 한 뒤** 종료 절차를 시작한다(응답 없이 끊겨 `hwdb stop` 이 기다리지 않게). 실제 완료는 `hwdb stop` 이 프로세스가 사라지는 것을 기다려 확인한다(14-1).
- 종료 절차는 한 번만 실행한다(`stop` 요청과 신호가 겹쳐도).

`ControlPort` (daemon → net 으로 주입)

```ts
interface ControlPort {
  controlToken(): string                // 잠금 파일의 제어 토큰
  status(): ServerStatus                // 기존 Server.getStatus()
  requestStop(): void                   // 종료 절차를 비동기로 시작한다
}
```

## 10. 데몬 제어 요청

- `control` 은 **로컬 전용 채널의 `GREETED` 상태에서만** 받는다. 다른 접속 경로와 다른 상태에서는 `42501`(내부 번호 7001) 오류이다. 사양 8의 "인증 전에는 핸드셰이크와 인증 메시지만 받는다" 에 대한 예외로, 제어 토큰이 인증을 대신한다(DB 계정 인증은 거치지 않는다 — 사양 14-1).
- 제어 토큰은 잠금 파일의 값과 상수 시간 비교(`crypto.timingSafeEqual`)로 확인한다. 틀리면 `28000`(7000, 인증 실패와 같은 메시지)이다. 토큰 틀림은 접속을 끊는다.
- `action: "status"` → `status` 응답(`Server.getStatus()` 의 필드). `action: "stop"` → `stopping` 응답 후 `requestStop()`.
- 제어 요청은 `maxConnections` 와 인증 전 접속 수 제한을 받지 않는다(로컬 전용 채널이므로).
- 로그에는 토큰을 남기지 않는다.

## 11. 오류 번호

8000 번대를 9단계에 배정한다(안). 한 번 정한 번호는 바꾸지 않으므로 구현 첫 작업에서 확정한다.

| 번호 | SQLSTATE | 뜻 |
|---|---|---|
| 8000 | `08P01` | 프로토콜 위반 (JSON 오류, 알 수 없는 `type`, 상태에 맞지 않는 메시지, 크기 초과, 잘못된 프레임) |
| 8001 | `53300` | 접속 수 초과 (`maxConnections`) |
| 8002 | `57P05` | 유휴 시간 초과로 서버가 세션을 끊음 |
| 8003 | `54000` | 처리 한도 초과 (행 하나가 메시지에 안 들어감, UDP 조각 수 초과) |
| 8004 | `34000` | 커서가 없음 |
| 8005 | `53400` | 구성 한도 초과 (열린 커서 16개, 대기열 64개) |
| 8006 | `08006` | 연결 실패 — **클라이언트가 만드는 오류** (UDP 재전송 한도, 연결 끊김, 응답 시간 초과). 서버는 보내지 않는다 |
| 8007 | `08001` | 접속을 맺지 못함 : TLS 서버 인증서 검증 실패 — **클라이언트가 만드는 오류**. 12-1절의 재시도를 모두 쓰고도 실패했을 때이며 메시지에 시도 횟수와 원인 코드를 싣는다 |

앞 단계의 번호를 다시 쓰는 것 : 인증 실패 `28000`(7000), CONNECT 거부 `28000`(7006), 권한 없음 `42501`(7001), 서버 종료 `57P01`(6003), 프로토콜 버전 불일치 `0A000`(1), 잘못된 필드 값 `22023`, 파라미터 개수 `07001`(5008).

## 12. 클라이언트 라이브러리 (`client/connection.ts`)

CLI 와 테스트가 쓰고, 12단계에서 `nodejsDriver` 의 출발점이 된다. 서버 모듈을 import 하지 않는다.

```ts
type Target =
  | { kind: "local"; port: number }
  | { kind: "tcp"; host: string; port: number; ssl?: SslOptions }   // ssl 을 주면 TLS. 12-1절
  | { kind: "udp"; host: string; port: number };

interface SslOptions {
  ca?: string | Buffer | Array<string | Buffer>;   // 신뢰할 CA(PEM). 생략하면 Node.js 기본 CA
  rejectUnauthorized?: boolean;                    // 기본 true. false 는 검증을 끄는 것이며 명시했을 때만
  servername?: string;                             // 인증서의 호스트 이름 검증 대상. 기본은 host
  certRetries?: number;                            // 인증서 오류 때의 재시도 횟수. 기본 2, 0 이면 재시도 없음
  certRetryDelayMs?: number;                       // 재시도 전 대기. 기본 100
  onCertRetry?(info: { attempt: number; maxAttempts: number; error: Error }): void;   // 재시도 알림(CLI 가 화면에 표시)
}

const connection = await Connection.open(target);      // 연결 + hello 협상
await connection.login({ user, password, tablespace?, timeZone? });   // SCRAM
const result = await connection.execute(sql, params, { fetchSize? }); // { kind: "rows" | "ok", ... }
const more = await connection.fetch(cursor);
await connection.closeCursor(cursor);
await connection.ping();
await connection.close();
await connection.control("status" | "stop", token);   // 로컬 채널만
```

- 안쪽은 **전송 계층 추상화** 하나이다 : `MessageTransport { send(buf), onMessage, onClose, close() }`. 구현이 둘이다. 스트림용(로컬 채널과 TCP, `framing.ts`)과 UDP 용(`ReliableEndpoint`).
  요청-응답 짝짓기(`id` 로 대기 중인 약속 표), 서버가 먼저 보낸 `id: 0` 오류 처리, 연결이 끊기면 대기 중인 모든 요청을 `08006` 으로 실패시키는 일은 전송과 무관하게 한곳에 둔다.
- 결과의 값은 **JSON 값 그대로** 돌려준다(프로토콜 값 표현 그대로 문자열이나 숫자). 타입 변환(`bigint`, 날짜 객체 등)은 `nodejsDriver`(12단계)의 정책이다. 이 단계의 클라이언트는 CLI 가 표시하기에 충분한 형태까지만 한다.
- `execute` 는 첫 묶음과 `cursor`, `hasMore` 를 그대로 돌려주고, 나머지는 호출자가 `fetch` 로 가져가는 낮은 수준의 API 이다. 전체를 모아 주는 헬퍼(`fetchAll`)를 얇게 하나 더 둔다.
- 시간 제한 : 요청마다 선택적 제한 시간을 둔다(기본 없음 — 문장이 잠금을 기다리면 30초까지 걸릴 수 있다). UDP 는 재전송 한도(8-4)에서 스스로 실패한다.
- TLS 서버 인증서 검증은 기본 켬이고, 인증서 오류가 나면 접속을 끊고 100 ms 뒤에 최대 2번 다시 시도한다(12-1절, 19절 결정 1).

### 12-1. TLS 서버 인증서 검증과 재시도

사용자 결정(2026-10-15). 사양에는 AGENTS.md 상세 8 의 TCP 항목으로 반영했다. `hwdb --ssl`(10단계)과 `nodejsDriver`(12단계), 앞으로의 JDBC 가 모두 같은 규칙을 따른다.

- **검증은 기본으로 켠다.** `SslOptions.rejectUnauthorized` 의 기본값은 `true` 이다. 서버 인증서가 신뢰하는 CA 에서 발급되었고, 유효 기간이 맞고, 접속 대상의 이름(`servername`, 기본은 `host`)이 인증서의 이름과 맞아야 한다.
  자체 서명 인증서를 쓰는 서버에는 그 인증서(또는 발급한 CA)를 `ca` 로 지정하면 된다. `rejectUnauthorized: false` 로 검증을 끌 수 있지만 명시했을 때만이고, 끈 연결에는 아래 재시도가 필요 없다(인증서 오류가 나지 않는다).
- **재시도 규칙** : 인증서 오류로 TLS 핸드셰이크가 실패하면 ① 그 연결을 닫고 ② `certRetryDelayMs`(기본 100 ms) 기다린 뒤 ③ **새 연결** 로 다시 시도한다. 재시도는 `certRetries`(기본 2)번까지이므로 한 번의 접속에서 연결 시도는 **최대 3번** 이다.
  모든 시도가 실패하면 마지막 오류를 원인으로 `08001`(내부 번호 8007)을 올린다. 메시지에 시도 횟수와 원인 코드(예 : `DEPTH_ZERO_SELF_SIGNED_CERT`)를 싣는다. `certRetries: 0` 이면 재시도하지 않는다.
- **재시도에서도 검증은 그대로 한다.** 시도마다 처음부터 같은 옵션으로 검증하며, 실패한 뒤에 검증을 끄거나 느슨하게 하는 일은 없다. 재시도는 일시적인 인증서 문제(서버가 인증서를 교체하는 순간 등)를 넘기기 위한 것이다.
- **재시도 대상은 인증서 오류뿐이다.** `tls.connect` 가 내는 인증서 검증 오류 코드에 한정한다 : `CERT_HAS_EXPIRED`, `CERT_NOT_YET_VALID`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `UNABLE_TO_GET_ISSUER_CERT`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `CERT_UNTRUSTED`, `CERT_REVOKED`, `ERR_TLS_CERT_ALTNAME_INVALID`.
  정확한 집합은 `isCertificateError(error)` 한 곳에 두고 구현 때 Node.js 와 bun 에서 확인한다. 연결 거부(`ECONNREFUSED`), 시간 초과, 연결 끊김, TLS 버전 불일치, 서버가 TLS 가 아닌 경우는 재시도하지 않고 바로 실패한다.
- **안전성** : 인증서 검증은 TLS 핸드셰이크 안에서 끝나므로, 재시도 시점에는 `hello`, 아이디, 비밀번호를 비롯해 어떤 메시지도 보내지 않았다. 재시도로 자격 증명이 새거나 부작용이 생기지 않는다.
- **알림** : 재시도하기 직전에 `onCertRetry({ attempt, maxAttempts, error })` 를 부른다. `hwdb` 는 이것으로 표준 오류에 한 줄(예 : `certificate error (DEPTH_ZERO_SELF_SIGNED_CERT); retrying 1/2 ...`)을 보이고, 최종 실패에서는 원인과 해결 방법(신뢰할 CA 지정, 검증 끄기)을 안내한다.
  CLI 에서 CA 를 지정하거나 검증을 끄는 옵션의 이름은 10단계에서 정한다. 사양 14-2 의 옵션 표에는 `--ssl` 만 있으므로 그때 AGENTS.md 의 표를 먼저 고친다.
- **소요 시간** : 실패가 확실한 경우(자체 서명 인증서를 `ca` 없이 접속)에도 접속 시도 세 번과 대기 두 번(200 ms)을 거친 뒤에 오류가 난다.
- 시험을 위해 대기는 내부 옵션(`sleep(ms)` 주입)으로 바꿀 수 있게 한다. 공개 API 는 아니다.

## 13. 로그와 보안 고려

- 로그 : 접속 열림·닫힘(경로, 주소, 사용자, 이유), 인증 실패(사용자 이름과 주소. 비밀번호와 SCRAM 값은 남기지 않는다), 프로토콜 위반, 유휴·시간 초과 종료는 `info`/`warn`. 문장 본문은 `debug` 수준에서만, 기존 `sanitizeLogMessage` 를 거쳐 남긴다(비밀번호가 든 `CREATE USER` 등).
- 인증 실패 응답은 모두 같은 메시지이지만 서버 로그에는 실제 원인(사용자 없음 / 비밀번호 틀림 / nonce 불일치)을 `debug` 로 구별해 남긴다.
- 인증 실패 뒤에는 응답 전에 고정 지연(200 ms)을 둔다(이벤트 루프를 막지 않는 타이머). 무차별 대입 속도를 늦춘다. 접속 단위 제한(실패 즉시 끊기)과 함께, 주소별 제한은 이 단계에서 하지 않는다.
- 이벤트 루프 : 문장 실행은 동기이므로 오래 걸리는 문장 하나가 다른 접속의 ACK 처리와 응답을 늦춘다. UDP 의 RTO 가 헛되이 만료될 수 있으나 재전송 후 중복은 무시되므로 결과는 맞다. 알려진 한계로 적는다.
- 위조·폭주 : UDP 패킷은 자유롭게 위조될 수 있다. 세션 번호가 32비트 난수이고 주소까지 맞아야 하므로 무작위 대입은 현실적이지 않지만, 경로상의 공격자는 평문을 본다. UDP 는 신뢰할 수 있는 네트워크에서 쓰라고 문서에 적는다.

## 14. 테스트 계획

모두 `node:test` 이고 bun 에서도 돌려 본다(구동·종료·세 경로의 로그인과 질의).

| 구분 | 내용 |
|---|---|
| 프레임 | 한 번에 여러 메시지, 메시지가 쪼개져 도착, 1바이트씩 도착, 길이 0, 한도 초과(인증 전 64 KiB, 후 16 MiB), 본문 모으기 전 거부 |
| 값 인코딩 | 모든 타입의 JSON 표현(경계값 포함: BIGINT 최대, NUMERIC 38자리, 6자리 소수 초, 시간대, 이진), NULL, 컬럼 메타데이터, 파라미터 해석(안전 정수 초과 거부, `{binary}`) |
| 메시지 처리기(소켓 없이) | 상태 기계의 모든 전이와 위반, SCRAM 성공·실패·없는 사용자·nonce 불일치, 응답 형태가 사용자 유무와 무관, CONNECT·`maxConnections`, 문장 오류 뒤 접속 유지, 커서(묶음, 마지막 묶음, 닫기, 없는 커서, 16개 한도), 행 하나가 큰 경우, `close` 와 롤백, 교착 오류 뒤 접속 유지, `control` 의 권한 |
| 로컬 전용 채널 | 클라이언트로 로그인·질의·대량 결과·트랜잭션(커밋, 롤백, 세이브포인트), `tcp.enabled=false` 와 `udp.enabled=false` 에서도 접속, `maxConnections` 가 찬 상태에서도 접속, 소켓 파일 정리, 같은 포트 두 번째 구동 거부 |
| TCP | 위와 같은 시나리오, 루프백은 로컬 / (가능하면) 비루프백은 원격 판정, 연결 끊김 시 롤백과 잠금 해제, 인증 전 시간 초과, 인증 전 접속 수 제한 |
| TLS | 자체 서명 인증서로 접속(`ca` 지정), 평문 접속 거부, `minVersion` 설정, (환경이 되면) `TLSv1` 허용 |
| TLS 클라이언트 검증과 재시도 (12-1절) | ① 검증 켬 + `ca` 없음 + 자체 서명 서버 : 서버가 핸드셰이크 실패를 **3번** 보고, 클라이언트는 `08001`(8007)로 실패하며 메시지에 시도 횟수 3 과 원인 코드가 있다. 대기는 주입한 `sleep` 이 100 ms 로 두 번 불린다. ② `ca` 지정 : 첫 시도에 성공(재시도 0). ③ `rejectUnauthorized: false` : 첫 시도에 성공. ④ `certRetries: 0` : 시도 1번 뒤 실패. ⑤ 서버가 첫 연결에는 신뢰할 수 없는 인증서, 둘째 연결부터 신뢰하는 인증서를 내는 경우(`setSecureContext` 로 전환) : 재시도 1번 만에 성공하고 `onCertRetry` 가 한 번 불린다. ⑥ 호스트 이름 불일치(`ERR_TLS_CERT_ALTNAME_INVALID`)도 재시도 대상. ⑦ 포트가 닫힘(`ECONNREFUSED`), 평문 서버, TLS 버전 불일치 : 재시도 없이 바로 실패(시도 1번). ⑧ 모든 재시도에서 `hello` 등 어떤 메시지도 서버에 도착하지 않았다 |
| UDP 신뢰성(소켓 없이) | 가짜 시계와 시뮬레이터로 : 유실 0 ~ 50%, 중복, 지연, 순서 뒤바뀜, ACK 만 유실, 1조각 ~ 수천 조각 메시지, 16 MiB 메시지, 동시에 양방향 전송, 재전송 한도 초과 시 실패. 무작위 시드를 100개 이상 돌려 모든 메시지가 한 번씩 순서대로 전달되는지 확인한다 |
| UDP 서버 | 실제 `dgram` 소켓 + 중간에 패킷을 떨어뜨리고 복제하는 프록시 소켓을 끼워 로그인·질의·대량 결과·트랜잭션. 세션 시간 제한, 위조 주소 패킷 무시, 모르는 세션에 `RST`, 인증 전 세션 정리 |
| 서버 조립 | 구동 순서(로컬 채널 실패 시 구동 실패, TCP 포트 사용 중), 정상 종료 순서(새 접속 거부 → 롤백 → 소켓 정리), `control status`/`stop`, 토큰 오류, 종료 요청과 신호의 겹침 |
| 보안·견고성 | 무작위·잘린·거대한 입력(프레임, JSON, UDP 패킷)을 흘려 서버가 죽거나 메모리를 폭주하지 않는지, 인증 전 메시지 제한, 로그에 비밀번호·토큰이 없는지 |

## 15. 작업 분해와 순서

앞 작업의 결과에 뒤 작업이 기대므로 번호 순서로 진행한다. 작업마다 테스트와 함께 끝내고, 끝날 때 PROGRESS.md 를 갱신한다.

| 번호 | 작업 | 산출물 | 완료 기준 |
|---|---|---|---|
| 9-1 | 프로토콜 명세 확정 | `docs/protocol.md`(이 문서 4, 8-4절을 옮겨 확정), `net/protocol.ts` 타입·검증, `errors.ts` 의 8000번대, `net/resultEncoder.ts` | 값·메타데이터·파라미터 변환 시험 통과. 문서와 코드의 메시지 표가 일치 |
| 9-2 | 프레임 | `net/framing.ts` | 프레임 시험 통과 |
| 9-3 | 접속 정책과 `Database.connect` | `session.ts` 수정, `SessionInfo` 와 `SYS_SESSIONS` 에 `CHANNEL`, `CLIENT_ADDRESS` 열 추가(확정, 19절), `DatabaseOptions.maxConnections` | CONNECT·로컬 판정·접속 수 제한 시험, 새 열 시험, 기존 시험 통과 |
| 9-4 | 메시지 처리기 | `net/messageHandler.ts`, `net/cursors.ts`, `net/connectionLimits.ts` | 소켓 없는 처리기 시험 통과(가짜 `ConnectionEndpoint`) |
| 9-5 | 로컬 전용 채널 + 클라이언트 기본 | `net/localChannelServer.ts`, `client/connection.ts`(스트림 전송) | 로컬 채널로 로그인·질의·대량 결과·트랜잭션 |
| 9-6 | TCP + TLS | `net/tcpServer.ts`, 시험용 인증서, 클라이언트 TLS 옵션과 검증·재시도(12-1절, `isCertificateError`, `SslOptions`) | TCP·TLS 시나리오와 14절의 TLS 클라이언트 검증·재시도 시험 통과 |
| 9-7 | UDP 신뢰성 계층 | `net/udpReliability.ts` + 시뮬레이터 | 유실·중복·순서 시험 통과 |
| 9-8 | UDP 서버 + 클라이언트 UDP 전송 | `net/udpServer.ts`, `client/connection.ts`(UDP 전송) | 실제 소켓 + 손실 프록시로 시나리오 통과 |
| 9-9 | 서버 조립과 제어 | `daemon/server.ts` 수정, `ControlPort`, 정상 종료 순서 | 서버 조립 시험 통과, 데몬 시험 갱신 |
| 9-10 | 마무리 점검 | config 검증 보강(`udp.maxPacketSize` 64 ~ 65,507, `udp.sessionTimeoutMs = 0` 구동 경고), bun 확인(인증서 오류 코드 포함), 문서·PROGRESS 갱신 | 9단계 완료 기준 전부 + bun 에서 세 경로 로그인과 질의 |

9-5 가 끝나면 `hwdb`(10단계)가 필요로 하는 최소한의 클라이언트가 생기므로, 10단계의 일부는 9-6 ~ 9-8 과 병행할 수 있다.

## 16. 위험과 미결 사항

- **구버전 TLS** : `@SECLEVEL=0` 로 TLS 1.0/1.1 을 켜도 OpenSSL 빌드에 따라 안 될 수 있다. 9-6 에서 환경별로 확인하고 결과를 문서에 적는다(PROGRESS.md 미결 사항과 같은 항목).
- **bun** : 네임드 파이프, `tls` 최소 버전, `dgram` 의 동작이 Node.js 와 같은지 9-10 에서 확인한다. 다르면 해당 기능만 bun 에서 제한된다고 문서에 적는다.
  특히 TLS 인증서 검증 오류의 `error.code` 가 Node.js 와 다를 수 있다. 다르면 12-1절의 재시도가 bun 에서 동작하지 않으므로 `isCertificateError` 가 두 런타임의 코드를 모두 알아야 한다.
- **TLS 재시도의 성격** : 인증서가 틀린 서버는 재시도해도 계속 틀리므로 대개 접속 시도 3번과 대기 200 ms 가 낭비로 끝난다. 결정(19절)대로 두되, 재시도가 검증을 느슨하게 하지 않는다는 점(12-1절)을 시험으로 고정한다.
- **Node.js 22** : 검증 환경은 24.x 이다. 22.x 에서 `net`/`tls`/`dgram` API 차이는 없다고 보지만 22.x 장비에서 전역 확인이 필요하다(지켜야 할 사항 5).
- **메모리** : 네트워크 결과는 파일에 보관하지만 복합 질의의 중간 결과와 미커밋 오버레이는 메모리를 사용할 수 있다(5절 한계).
- **이벤트 루프 점유** : 13절의 한계. 장문의 문장이 있으면 UDP 지연이 생긴다.
- **UDP 처리량** : 창이 32조각으로 고정이라 왕복이 긴 망에서는 느리다. 정확성에는 영향이 없고, 필요하면 창을 키우거나 AIMD 를 넣을 수 있다.
- **IPv6** : 기본 바인드가 IPv4 이므로 `::1` 로만 풀리는 환경에서는 `tcp.host` 설정이 필요하다.

## 17. 사양과의 대응 확인

| 사양(AGENTS.md) | 설계 위치 |
|---|---|
| 개요 8 TCP·UDP 접속, config 로 제어 | 8-2, 8-4, 8-5, 9 |
| 개요 8 SSL 인증서 TCP 보안 통신, 구 TLS | 8-2 |
| 개요 9 동시 접근, 최대 10명 | 3(대기열), 7-2, 14(11단계에서 네트워크 시험) |
| 개요 14, 15 데몬, 포트 번호가 인스턴스 | 8-3(주소), 9, 10 |
| 상세 6 CONNECT, 로컬 접속 판정 | 6, 7-1, 7-3 |
| 상세 8 메시지(종류, id, 16MB, fetch, 값 표현) | 4, 5 |
| 상세 8 SCRAM, 인증 전 제한, 같은 오류 | 3, 6 |
| 상세 8 TCP 프레임, TLS 전용, 최소 버전 | 8-1, 8-2 |
| 상세 8 클라이언트의 TLS 서버 인증서 검증과 재시도(2회) | 12-1 |
| 상세 7 `udp.maxPacketSize` 범위, `udp.sessionTimeoutMs = 0` | 8-4, 15(9-10) |
| 상세 14-2 `--ssl` | 12-1 (CLI 옵션 이름은 10단계) |
| 상세 8 UDP 패킷 헤더, ACK·재전송·중복 제거·순서·분할·세션 | 8-4 |
| 상세 8 로컬 전용 채널(설정 무관, maxConnections 제외, 제어 요청) | 7-2, 8-3, 10 |
| 상세 9 `maxConnections`, 데이터 디렉토리 하나에 데몬 하나 | 7-2, 8-3 |
| 상세 12 정상 종료 순서 | 9 |
| 상세 14-1 제어 권한(토큰, 로컬 채널만) | 10 |
| 상세 15 인스턴스 식별 | 8-3 |

## 18. 이 설계가 정한, 사양에 없던 것

사양이 정하지 않아 이 문서에서 정했다. 구현하며 바꾸게 되면 이 문서와 PROGRESS.md 의 결정 사항을 함께 고친다.
(사용자가 정한 것은 19절에 따로 있고, 그중 사양을 보충하는 부분은 AGENTS.md 에 반영했다.)

- 메시지 이름과 필드, 봉투(`id`, `type`), 모르는 필드 무시, 버전 협상 방식, `id: 0` 서버 먼저 보내기
- 인증 실패 시 접속 종료, 실패 응답 전 지연 200 ms, 인증 전 시간 제한 10초, 인증 전 접속 수 제한 `max(16, 2 × maxConnections)`, 인증 전 메시지 64 KiB
- 커서 모델(홀더블, 16개 한도), 기본 fetch 크기 500, 묶음 1 MiB 소프트 한도
- UDP 패킷 레이아웃의 `ackSeq`, 조각 창 32, RTO 값, 재전송 10회, 메시지 단위 stop-and-wait, 세션 번호 발급과 주소 고정
- 로컬 채널 제어 요청이 `GREETED` 에서 토큰으로 인증되는 예외
- `Database.connect` 하나로 접속 정책을 모으기

## 19. 결정 기록

설계 중 사용자가 정해야 했던 5건과 그 결과이다. 2026-10-15 에 1 ~ 4번은 사용자가 확정했고, 5번은 별도 의견이 없어 권장안을 그대로 쓴다. 바꾸려면 구현 전에 알려 주세요.

| 번호 | 결정 | 내용 | 상태 |
|---|---|---|---|
| 1 | 클라이언트의 TLS 서버 인증서 검증 | **기본으로 검증한다.** 인증서 오류로 접속에 실패하면 접속을 끊고 100 ms 뒤에 다시 시도하며, 재시도는 최대 2회(연결 시도는 최대 3번)이다. 접속용 CLI 와 드라이버가 함께 따른다. 상세는 12-1절. AGENTS.md 상세 8 에 반영 | 사용자 확정 (권장안에 재시도를 더함) |
| 2 | `SYS_SESSIONS` 에 `CHANNEL`, `CLIENT_ADDRESS` 열 추가 | 추가한다. 기존 열 순서는 바꾸지 않고 끝에 더한다(7-3절, 9-3) | 사용자 확정 (제안대로) |
| 3 | `udp.sessionTimeoutMs = 0` 의 뜻 | 시간 제한 없음 + 구동 로그 경고(8-4절). AGENTS.md 상세 7 에 반영 | 사용자 확정 (제안대로) |
| 4 | `udp.maxPacketSize` 범위 | 64 이상 65,507 이하. config 검증에 더한다(9-10). AGENTS.md 상세 7 에 반영 | 사용자 확정 (제안대로) |
| 5 | 인증 실패 시 접속 종료와 200 ms 지연 | 접속을 끊고 응답 전에 200 ms 늦춘다(3, 13절) | 별도 의견 없음 → 권장안 유지 |

1번에서 사용자 결정으로 권장안과 달라진 부분은 **재시도** 이다. 권장안은 검증 기본 켬과 옵션 제공까지였고, 인증서 오류 때 접속을 끊고 100 ms 뒤 최대 2번 다시 시도하는 규칙은 사용자가 더했다.

## 20. 구현하면서 달라진 점 (2026-10-16)

설계와 다르게 구현했거나 설계에 없던 것을 더했다. 프로토콜의 규칙은 [protocol.md](protocol.md)에 반영되어 있다.

- **`ConnectionEndpoint.close(options?)`** : `{ flush: false }` 를 줄 수 있다. 보낼 응답이 없는 종료(인증 시간 초과)에서 UDP 가 상대의 ACK 를 기다리느라 세션이 남지 않게 한다. `MessageHandler.busy` 도 더했다(UDP 서버가 문장 실행 중인 세션을 시간 제한에서 빼는 데 쓴다).
- **사용자 이름 해석** : 서버는 정확히 같은 이름을 먼저 찾고, 없으면 대문자로 바꾼 이름을 찾는다. (따옴표 없는 식별자가 대문자로 저장되므로 `-u system` 이 동작하게 하기 위함. 설계에는 없었다)
- **`Server.stopRequested`** : `ControlPort.requestStop()` 은 종료 절차를 직접 시작하지 않고 이 약속을 푼다. 종료 절차는 그것을 기다리는 `runForeground`(데몬 본체)가 시작한다. 신호와 겹쳐도 `Server.stop()` 이 한 번만 실행한다.
- **`net/streamConnection.ts`** 를 더했다. 로컬 전용 채널과 TCP 가 소켓을 처리기에 잇는 코드를 함께 쓴다. (프레임 해석, 보내기 밀림, 정리)
- **`net.Server.close()` 의 콜백은 모든 접속이 끝나야 불린다.** 그래서 `stopAccepting()` 은 콜백을 기다리지 않고 듣기만 즉시 멈춘다. 접속 닫기는 `closeConnections()` 가 따로 한다.
- **Windows 네임드 파이프** : 듣기를 멈춘 뒤에도 기존 접속이 남아 있으면 새 연결은 거부되지 않고 대기하다가 클라이언트의 연결 제한 시간에 실패한다. (유닉스는 `ECONNREFUSED`)
- **UDP 증폭 억제** : 서버가 처음 보내는 응답이 한 번도 확인되지 않은 동안의 재전송 한도를 4번으로 낮추었다(`unconfirmedRetransmitLimit`). 설계는 "응답을 요청보다 크지 않게" 였으나 `helloOk` 가 `hello` 보다 크므로 재전송 한도로 막는다.
- **UDP 세션 번호 규칙 보강** : 인증을 마친 세션이 있는 주소에서 새 `SYN` 이 오면 새 접속으로 보고 옛 세션을 닫는다. 클라이언트는 서버의 첫 패킷(ACK 포함)에서 세션 번호를 배운다. 서버가 상대의 `SYN` 에 답하는 ACK 에도 `SYN` 을 붙인다.
- **UDP 클라이언트의 ping** 은 전송 계층이 아니라 `Connection` 이 한다. 요청 `id` 를 `Connection` 이 관리하기 때문이다. 전송 계층은 `onHello` 로 서버의 패킷 크기를 받는다.
- **연결 제한 시간** : `Connection.open` 이 `hello` 의 응답을 연결 제한 시간(기본 10초) 안에 받지 못하면 실패한다. UDP 에서 서버가 없을 때 재전송 한도(약 25초)를 다 기다리지 않게 한다.
- **인증서 오류 판정 보강** : 호스트 이름 불일치(`ERR_TLS_CERT_ALTNAME_INVALID`)는 서버가 인증서를 실제로 보냈을 때만 인증서 오류로 본다. bun 은 TLS 가 아닌 서버에 TLS 로 접속하면 인증서가 빈 채로 이 코드를 낸다.
- **bun 의 TLS 한계** : bun 의 TLS 서버는 `minVersion` 을 적용하지 않는다(기본 TLS 1.2 이상으로 고정). `secureContext` 로 주면 인증서가 실리지 않아 쓸 수 없다. 그래서 bun 에서는 `TLSv1.2` 만 설정대로 지켜지고, `TLSv1.3` 과 구버전 허용은 구동 로그에 경고를 남긴다. 자세한 것은 protocol.md 16절.
- **`udp.maxPacketSize` 검증**(64 ~ 65,507)과 `udp.sessionTimeoutMs = 0` 의 구동 경고는 `config/config.ts` 에서 한다. 경고는 `loadConfig` 의 `warnings` 로 나가 구동 로그에 남는다.
- **SYS_SESSIONS** 에 `CHANNEL`(`LOCAL`/`TCP`/`UDP`), `CLIENT_ADDRESS`(IPv4 로 매핑된 IPv6 는 IPv4 로 적는다)를 끝에 더했다. (19절 결정 2)
- **시험 환경의 포트** : Windows 는 TCP 와 UDP 에 서로 다른 제외 포트 범위를 두므로, 시험의 `freePort()` 는 두 프로토콜과 두 바인드 주소(`0.0.0.0`, `127.0.0.1`)를 모두 확인하고 필요하면 무작위 포트로 건너뛴다. 데몬을 구동하는 시험은 기본 포트(7410)를 쓰지 않는다. (시험 파일이 병렬로 돌고, 인스턴스는 포트로 구분되므로)
