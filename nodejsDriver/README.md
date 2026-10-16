# HelloWorldDB Node.js 드라이버

[HelloWorldDB](../rdbms) 에 접속하는 Node.js 용 드라이버이다. TCP(SSL 포함)와 UDP 로 접속하고, 실행에 필요한 외부 패키지 없이 Node.js 내장 모듈만 쓴다.
Node.js 22 이상과 bun 에서 동작한다. TypeScript 타입 정의를 함께 내보낸다.

- 패키지 이름 : `org.duckdns.hjow.helloworlddb.nodejsdriver`
- 접속 대상은 **호스트와 포트 번호**뿐이다. SID 나 데이터베이스 이름에 해당하는 항목은 없다. 둘 다 생략하면 `127.0.0.1` 의 `7410` 이다.
- TCP 와 UDP 는 같은 포트 번호를 쓴다.
- 서버의 오류 메시지는 번역하지 않는다(영문). 오류는 `sqlState` 와 `code` 로 판단한다.

## 설치

```sh
npm install org.duckdns.hjow.helloworlddb.nodejsdriver
```

이 저장소에서 쓸 때는 `nodejsDriver` 디렉토리에서 `npm install` 한 뒤 `npm run build` 하면 `dist` 에 JavaScript 와 타입 정의(`.d.ts`)가 만들어진다.

## Hello World

```js
import { connect } from "org.duckdns.hjow.helloworlddb.nodejsdriver";

const db = await connect({ user: "SYSTEM", password: "내 비밀번호" });
const result = await db.query("SELECT 'Hello World'");
console.log(result.rows[0][0]); // Hello World
await db.close();
```

HelloWorldDB 를 처음 설치했다면 SYSTEM 계정의 초기 암호는 `HelloWorldDB` 이고, 설치 직후에는 **같은 장비(루프백)에서만** 접속된다.
서버 장비에서 `hwdb` 로 접속해 암호를 바꾸는 것이 표준 절차이다. (`ALTER USER SYSTEM IDENTIFIED BY '새 비밀번호'`) 다른 장비에서 접속하려면 그 사용자에게 `GRANT CONNECT TO 사용자` 가 필요하다.

## 접속

```js
import { connect } from "org.duckdns.hjow.helloworlddb.nodejsdriver";

const db = await connect({
  host: "192.168.0.10",   // 생략하면 127.0.0.1
  port: 7410,             // 생략하면 7410
  protocol: "tcp",        // "tcp"(기본) 또는 "udp"
  user: "SCOTT",
  password: "tiger",
  tablespace: "APP",      // 접속 직후의 현재 테이블스페이스. 생략하면 사용자의 기본 테이블스페이스
  ssl: true,              // TCP 에서 TLS 사용. 서버 인증서를 검증한다
});
```

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `host` | `127.0.0.1` | 서버 주소 |
| `port` | `7410` | 포트 번호. TCP 와 UDP 가 같은 번호를 쓴다 |
| `protocol` | `"tcp"` | `"udp"` 는 암호화되지 않으므로 신뢰할 수 있는 네트워크에서만 쓴다 |
| `user`, `password` | (필수) | 비밀번호는 SCRAM-SHA-256 으로 인증하며 평문으로 오가지 않는다. 드라이버는 서버의 서명도 확인한다 |
| `tablespace` | 사용자의 기본 테이블스페이스 | 식별자 규칙을 따른다. 따옴표 없이 쓰면 대문자로 본다 |
| `timeZone` | 서버 설정 | 세션 타임존 (`"+09:00"`, `"Asia/Seoul"`) |
| `ssl` | 없음 | `true` 또는 TLS 옵션 객체. TCP 에서만 쓴다 (UDP 와 함께 쓰면 오류) |
| `connectTimeoutMs` | `10000` | 연결과 로그인의 제한 시간 |
| `requestTimeoutMs` | 제한 없음 | 요청 하나가 응답을 기다리는 제한 시간. 문장이 잠금을 기다리면 서버 설정(기본 30초)만큼 걸릴 수 있다 |
| `fetchSize` | 서버 기본(500) | 조회 결과를 나누어 받는 묶음의 행 수 |

로그인한 세션의 정보는 `db.session`(`id`, `user`, `tablespace`, `timeZone`, `autocommit`), 서버 정보는 `db.serverInfo` 이다.
**기본 테이블스페이스가 없는 사용자의 `session.tablespace` 는 `null`** 이다. 이때는 객체 이름에 테이블스페이스명을 붙이거나 `USE 테이블스페이스` 를 먼저 실행한다.

### SSL

서버 인증서는 **기본으로 검증**한다. 자체 서명 인증서를 쓰는 서버라면 그 인증서(PEM)를 `ca` 로 알려 준다.

```js
import fs from "node:fs";

const db = await connect({
  user: "SCOTT", password: "tiger",
  ssl: { ca: fs.readFileSync("server.cert.pem") },
});
```

| `ssl` 옵션 | 설명 |
|---|---|
| `ca` | 신뢰할 CA 인증서(PEM). 생략하면 Node.js 기본 CA |
| `rejectUnauthorized` | `false` 이면 검증을 끈다. **위험하다.** 명시했을 때만 끈다 |
| `servername` | 인증서의 이름을 확인할 대상. 기본은 접속 호스트 |
| `certRetries`, `certRetryDelayMs` | 인증서 오류 때 재시도 횟수(기본 2)와 대기(기본 100 ms) |
| `onCertRetry` | 재시도 직전에 부르는 함수 |
| `minVersion`, `maxVersion`, `ciphers` | TLS 버전과 암호 스위트 |

**인증서 오류로 접속에 실패하면 접속을 끊고 100 ms 뒤에 다시 시도하며, 재시도는 최대 2회**이다. 재시도에서도 검증은 그대로 한다.
모두 실패하면 `sqlState` `08001`(`code` 8007)이다. 연결 거부, 시간 초과 같은 다른 실패에는 재시도하지 않는다.

## 문장 실행

```js
const r = await db.query("SELECT ID, NAME FROM EMP WHERE DEPT_ID = ? AND SAL > ?", [3, "1000.50"]);
r.columns;   // [{ name: "ID", typeName: "INTEGER", declared: "INTEGER" }, ...]
r.rows;      // [[1, "Ann"], [2, "Bob"]]  컬럼 순서의 배열
r.records(); // [{ ID: 1, NAME: "Ann" }, ...]  컬럼 이름을 키로 하는 객체 (같은 이름이 둘이면 뒤의 것)
r.rowCount;  // 조회면 행 수, DML 이면 영향받은 행 수, DDL 이면 null
r.message;   // 조회가 아닌 문장의 완료 메시지
```

- 문장 하나만 실행한다. 끝의 `;` 는 있어도 없어도 된다.
- `?` 는 파라미터로 바인딩된다. 파라미터는 문장의 일부가 아니라 값이므로 SQL 주입이 일어나지 않는다.
- `query` 는 **조회 결과 전체를 메모리에 모아서** 돌려준다. 아주 큰 결과는 아래의 `stream` 이나 `cursor` 로 나누어 읽는다.

### 타입 대응

| DB 타입 | JavaScript 값 (결과) | JavaScript 값 (파라미터) |
|---|---|---|
| `CHAR`, `VARCHAR` | `string` | `string` |
| `BINARY`, `VARBINARY` | `Buffer` | `Buffer`, `Uint8Array` |
| `SMALLINT`, `INTEGER` | `number` | `number` |
| `BIGINT` | `bigint` | `bigint`, `number`, `string` |
| `NUMERIC`, `DECIMAL` | `string` (자릿수를 잃지 않기 위함) | `string`, `number` |
| `REAL`, `DOUBLE PRECISION`, `FLOAT` | `number` | `number` |
| `BOOLEAN` | `boolean` | `boolean` |
| `DATE`, `TIME`, `TIMESTAMP`, `INTERVAL` (`WITH TIME ZONE` 포함) | `string` (`Date` 는 마이크로초를 담지 못한다) | `string`, `Date` |
| `NULL` | `null` | `null`, `undefined` |

- `COUNT(*)`, `SUM` 같은 집계와 파라미터 산술(`? + 0`)은 `BIGINT` 이므로 `bigint` 로 온다.
- `Date` 파라미터는 UTC 시각을 가리키는 ISO 8601 문자열(`2026-10-16T12:34:56.789Z`)로 보낸다. `TIMESTAMP WITH TIME ZONE` 에는 그 시각이 `+00:00` 으로 저장되고,
  타임존 없는 `TIMESTAMP` 에는 **세션 타임존의 벽시계 시각**으로 옮겨져 저장된다.
- 안전 정수(±2^53-1)를 넘는 정수는 JSON 숫자로 보내면 정밀도를 잃으므로 드라이버가 문자열로 보낸다. `bigint` 를 쓰는 것이 가장 정확하다.
- 날짜시간 값은 서버의 표기 그대로(`2026-10-16 12:34:56.123456`)이다. 필요하면 `new Date(...)` 로 직접 바꾼다.

### 큰 결과 나누어 읽기

```js
// 행을 하나씩 비동기 반복자로. 중간에 멈추면(break, 예외) 서버의 커서를 닫는다.
for await (const row of db.stream("SELECT * FROM BIG_TABLE", [], { fetchSize: 1000 })) {
  console.log(row);
}

// 묶음 단위로. 처음 받은 묶음부터 차례로 돌려주고, 끝까지 읽으면 빈 배열이다.
const cursor = await db.cursor("SELECT * FROM BIG_TABLE", [], { fetchSize: 1000 });
for (let rows = await cursor.fetch(); rows.length > 0; rows = await cursor.fetch()) {
  process(rows);
}
await cursor.close(); // 더 필요 없을 때도 닫는다
```

한 접속이 동시에 열어 둘 수 있는 커서는 16개이다. (넘으면 `53400`) 커밋과 롤백은 커서를 무효로 만들지 않는다.

## 트랜잭션

자동 커밋이 기본이다. `BEGIN` 으로 트랜잭션을 시작하고, 자동 커밋을 끄면 첫 문장에서 자동으로 시작한다.

```js
await db.begin();
await db.query("UPDATE ACCOUNT SET BAL = BAL - 100 WHERE ID = 1");
await db.query("UPDATE ACCOUNT SET BAL = BAL + 100 WHERE ID = 2");
await db.commit();     // 또는 await db.rollback()

await db.setAutoCommit(false); // SET AUTOCOMMIT OFF

// 한 번에 감싸기 : 끝나면 커밋하고, 예외를 던지면 롤백한 뒤 그 예외를 다시 던진다.
const total = await db.transaction(async (tx) => {
  await tx.query("INSERT INTO LOG VALUES (?)", ["start"]);
  return (await tx.query("SELECT COUNT(*) FROM LOG")).rows[0][0];
});
```

- 세이브포인트는 SQL 로 쓴다. (`SAVEPOINT S`, `ROLLBACK TO SAVEPOINT S`)
- 문장이 실패해도 그 문장만 되돌리고 트랜잭션은 유지된다.
- DDL, `GRANT`, `REVOKE`, 사용자·테이블스페이스 관리 문장은 실행 전후에 자동으로 커밋된다.
- 같은 행을 바꾸려는 트랜잭션은 행 잠금으로 순서가 정해진다. 서버의 `transaction.lockTimeoutMs`(기본 30초)를 넘으면 그 문장이 `55P03` 으로 끝난다.
  교착이 감지되면 한쪽 트랜잭션이 `40P01` 로 롤백된다. (이때 서버가 이미 롤백했으므로 같은 접속에서 다시 시도하면 된다)
- 접속이 끊기면 커밋하지 않은 변경은 롤백된다. `close()` 는 `{ rolledBack }` 으로 그런 변경이 있었는지 알려 준다.
- 한 접속은 세션 하나이고 동시에 트랜잭션 하나만 가진다. `transaction()` 이 도는 동안 같은 접속으로 보낸 다른 문장도 같은 트랜잭션에 들어간다.
  여러 일을 동시에 하려면 접속을 나누거나 커넥션 풀을 쓴다.

## 커넥션 풀

```js
import { createPool } from "org.duckdns.hjow.helloworlddb.nodejsdriver";

const pool = createPool({ user: "SCOTT", password: "tiger", max: 5 });

const r = await pool.query("SELECT 1");                     // 빌리고 돌려주는 일을 알아서
await pool.transaction(async (tx) => { /* ... */ });        // 트랜잭션도 마찬가지

const conn = await pool.acquire();                          // 직접 빌릴 때는 반드시 돌려준다
try {
  await conn.query("...");
} finally {
  conn.release();
}

await pool.close();
```

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `max` | `5` | 동시에 열어 둘 접속의 최대 수. 서버의 `maxConnections`(기본 10, TCP·UDP 세션 합계)보다 작게 둔다 |
| `idleTimeoutMs` | `30000` | 놀고 있는 접속을 닫기까지의 시간. 0 이면 닫지 않는다 |
| `acquireTimeoutMs` | `30000` | 접속을 빌리려고 기다리는 제한 시간. 넘으면 `53300`. 0 이면 끝까지 기다린다 |
| `maxLifetimeMs` | `0` | 접속 하나를 쓸 수 있는 최대 시간. 0 이면 제한 없음 |

접속 옵션(`host`, `port`, `user` 등)은 `connect` 와 같다. 돌려받은 접속은 **로그인 직후의 상태로 되돌린다**(커밋하지 않은 트랜잭션은 롤백, 바꾼 자동 커밋은 되돌림).
끊긴 접속(서버가 유휴 시간 초과로 끊거나 서버가 내려간 경우)은 풀에서 빠지고 다음에 빌릴 때 새로 만든다.
`pool.close()` 는 놀고 있는 접속을 바로 닫고 빌려 간 접속은 돌려받는 대로 닫는다. `pool.close({ force: true })` 는 빌려 간 접속도 바로 끊는다.

## 오류

모든 오류는 `DbError` 이다.

```js
import { DbError } from "org.duckdns.hjow.helloworlddb.nodejsdriver";

try {
  await db.query("INSERT INTO T VALUES (1)");
} catch (e) {
  if (e instanceof DbError) {
    e.sqlState; // "23505"  ANSI SQLSTATE 5자리
    e.code;     // 1004     서버의 내부 오류 번호
    e.message;  // 영문 메시지 (번역하지 않는다)
    e.position; // { line, column, offset }  문법 오류처럼 위치를 알 수 있을 때만
    e.isConnectionError; // 이 접속을 더 쓸 수 없는 오류인가 (연결 끊김, 서버 종료, 유휴 시간 초과)
  }
}
```

| SQLSTATE | 뜻 |
|---|---|
| `28000` | 인증 실패 (없는 사용자와 틀린 비밀번호를 구분하지 않는다), CONNECT 권한 없이 원격에서 접속 |
| `42501` | 권한 없음 |
| `23505`, `23502`, `23503` | 중복 키, NOT NULL 위반, 외래 키 위반 |
| `55P03`, `40P01` | 잠금 대기 초과, 교착 상태로 롤백됨 |
| `08006` | 연결 실패, 끊김, 응답 시간 초과 (드라이버가 만드는 오류) |
| `08001` | TLS 서버 인증서 검증 실패 (재시도를 모두 쓴 뒤) |
| `53300` | 접속 수가 `maxConnections` 에 이름 / 풀에서 접속을 빌리지 못함 |
| `57P01`, `57P05` | 서버 종료, 유휴 시간 초과로 서버가 접속을 끊음 |
| `0A000` | 지원하지 않는 문법이나 기능 |

접속이 끊기면 `Connection` 이 `close` 이벤트를 낸다. 오류 때문에 끊겼으면 그 `DbError` 가 함께 온다. (`db.close()` 나 `db.destroy()` 로 직접 끊으면 `null`)

```js
db.on("close", (error) => console.log(error ? `끊김: ${error.sqlState}` : "닫힘"));
```

## 지원하지 않는 것

- 로컬 전용 채널과 데몬 제어(구동, 종료, 상태 조회)는 `hwdb` 명령의 몫이며 드라이버의 범위가 아니다.
- 날짜시간 값을 `Date` 로 받는 옵션은 없다. (마이크로초를 담지 못한다)
- 서버가 조회 결과를 메모리에 모아 두고 나누어 보내므로, 아주 큰 결과 전체의 스트리밍은 서버의 한계를 따른다. ([rdbms/docs/protocol.md](../rdbms/docs/protocol.md) 10절)

## 시험

```sh
npm install
npm test        # rdbms 가 빌드되어 있지 않으면 먼저 빌드한 뒤, 단위 시험과 실제 rdbms 를 띄우는 통합 시험을 돌린다
```

통합 시험은 이 저장소의 형제 디렉토리 `../rdbms` 를 `hwdb start` 로 띄워(임시 디렉토리, 빈 포트) 수행한다. 서버를 돌리는 런타임은 환경 변수 `HWDB_TEST_RUNTIME` 으로 고른다.
bun 으로 시험하려면 `npm run build` 뒤에 `bun test dist/test/<파일>.test.js` 를 파일마다 실행한다.

## 문서

- 프로토콜 명세(드라이버의 기준) : [rdbms/docs/protocol.md](../rdbms/docs/protocol.md)
- 타입과 값의 규칙 : [rdbms/docs/data-types.md](../rdbms/docs/data-types.md)
- SQL 문법 : [rdbms/docs/sql-syntax.md](../rdbms/docs/sql-syntax.md)
- 서버 사용 설명서 : [rdbms/docs/manual.md](../rdbms/docs/manual.md)
