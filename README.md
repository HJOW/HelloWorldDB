# HelloWorldDB

Node.js 로 간단한 DBMS 개발

# 사용 방법

HelloWorldDB 는 저장소를 `git clone` 하여 직접 빌드해서 사용합니다. 아래 세 단계를 순서대로 따라 하면 됩니다.

- 준비물 : [Git](https://git-scm.com/), **Node.js 22 이상** ([nodejs.org](https://nodejs.org/), `node --version` 으로 확인). 빌드한 결과물은 bun 으로도 실행됩니다.
- 개발 장비는 Windows 11 입니다. 리눅스와 macOS 는 아직 실제 장비에서 확인하지 못했습니다.

## DB 구동

저장소를 내려받아 DB 본체(`rdbms`)를 빌드합니다.

```sh
git clone https://github.com/HJOW/HelloWorldDB.git
cd HelloWorldDB/rdbms
npm install          # 빌드에 필요한 개발 의존성(TypeScript 6)을 받습니다. 실행에는 외부 패키지가 필요 없습니다.
npm run build        # dist/ 에 실행 파일을 만듭니다.
node dist/src/cli/main.js --version     # hwdb 0.1.0
```

DB 를 다루는 명령은 `hwdb` 하나입니다. `rdbms` 디렉토리에서 `npm link` 를 한 번 실행하면 어디서든 `hwdb` 라고 입력할 수 있습니다.
등록하지 않았다면 이후 설명의 `hwdb` 를 `node dist/src/cli/main.js` (bun 으로 실행하려면 `bun dist/src/cli/main.js`) 로 바꿔 입력합니다.

```sh
hwdb start           # DB 를 데몬으로 띄우고 바로 돌아옵니다.
hwdb status          # 구동 여부, 포트, PID 등을 보여 줍니다.
hwdb stop            # 정상 종료합니다.
```

```
HelloWorldDB started. port: 7410, pid: 12345
```

- 데몬은 터미널과 분리되어 돌기 때문에 터미널을 닫아도 계속 실행됩니다. 끌 때는 `hwdb stop` 을 사용합니다. (프로세스를 강제로 끝내지 않는 것을 권합니다)
- 별도 설정 없이 **포트 7410** (TCP 와 UDP 가 같은 번호)으로 구동됩니다. 포트 번호가 곧 인스턴스를 구분하는 이름이며, SID 나 데이터베이스 이름은 없습니다.
- 데이터는 `rdbms/data`, 로그는 `rdbms/logs/helloworlddb.log` 에 생깁니다. `hwdb start` 가 실패하면 원인과 로그 위치를 알려 줍니다.
- 설정을 바꾸려면 `rdbms` 디렉토리에 `config.json` 을 만듭니다. 필요한 키만 적으면 되고 나머지는 기본값입니다. 모든 키를 기본값으로 적은 예시는 `rdbms/config.sample.json` 입니다.
  설정은 구동할 때 한 번만 읽으므로 바꾼 뒤에는 `hwdb stop` 후 `hwdb start` 합니다.

  ```json
  { "port": 7500, "log": { "level": "warn" } }
  ```

- 같은 장비에 DB 를 여러 개 띄우려면 설치 디렉토리(그래서 `config.json` 과 데이터)를 따로 두고 포트 번호를 다르게 합니다.
- 소스를 갱신할 때는 `hwdb stop` 으로 끈 뒤 `git pull`, `npm install`, `npm run build` 를 하고 다시 `hwdb start` 합니다. 1.0 출시 전에는 데이터 파일 형식이 바뀌면 이전 데이터와의 호환을 보장하지 않습니다.

자세한 내용은 [사용 설명서](rdbms/docs/manual.md)에 있습니다.

## 로컬에서 DB 접속, SQL문 사용

DB 를 구동한 장비에서 `hwdb` 로 접속합니다. 옵션 없이 실행하면 사용자명과 비밀번호를 물어봅니다. (비밀번호는 화면에 보이지 않습니다)

```
$ hwdb
Username: SYSTEM
Password:
hwdb>
```

설치 직후의 관리자 계정은 **SYSTEM**, 초기 암호는 **`HelloWorldDB`** 입니다. 알려진 암호이므로 **처음 접속했을 때 가장 먼저 바꿉니다.** 바꾸기 전에는 접속할 때마다 변경을 안내합니다.

```
hwdb> ALTER USER SYSTEM IDENTIFIED BY '새 비밀번호';
User "SYSTEM" altered. (6 ms)
```

문장은 `;` 를 만나면 실행되며 여러 줄에 걸쳐 쓸 수 있습니다. `exit` 또는 `quit` 로 끝내고 `help` 로 도움말을 봅니다. Hello World 는 아래처럼 간단합니다.

```
hwdb> SELECT 'Hello World';
+-------------+
| COL1        |
+-------------+
| Hello World |
+-------------+
1 row (1 ms)
hwdb> CREATE TABLE HELLO (MESSAGE VARCHAR);
Table "HELLO" created. (4 ms)
hwdb> INSERT INTO HELLO VALUES ('Hello World');
INSERT 1 (1 row affected, 4 ms)
hwdb> SELECT * FROM HELLO;
+-------------+
| MESSAGE     |
+-------------+
| Hello World |
+-------------+
1 row (1 ms)
hwdb> exit
```

대화형으로 쓰지 않고 한 번에 실행할 수도 있습니다.

```sh
hwdb -u SYSTEM -e "SELECT 'Hello World'"       # 문장 하나 실행 (비밀번호를 생략하면 물어봅니다)
hwdb -u SYSTEM -f script.sql                    # 파일의 문장을 차례로 실행 (오류가 나면 거기서 멈춥니다)
hwdb -u SYSTEM -p 비밀번호 < script.sql         # 표준 입력으로 실행 (-u 와 -p 가 필요합니다)
```

- 이 장비의 `hwdb` 는 언제나 접속됩니다. 다른 장비에서 접속하는 것과 달리 `CONNECT` 권한이 필요 없습니다. (사용자명과 비밀번호 인증은 똑같이 거칩니다)
- `-p 비밀번호` 는 운영체제의 프로세스 목록에서 다른 사용자에게 보일 수 있습니다. 사람이 접속할 때는 생략하고 물어보게 둡니다.
- 오류는 `ERROR [SQLSTATE:번호] 메시지` 형태로 보여 줍니다. 오류 메시지는 영어이고 번역하지 않으며, SQLSTATE 로 판단합니다.

### 일반 사용자 만들기

SYSTEM 은 관리용입니다. 프로그램이 쓸 사용자는 따로 만들어서 필요한 권한만 줍니다. (다음 단계의 Node.js 프로그램이 이 사용자로 접속합니다)

```sql
CREATE TABLESPACE APP;                                                   -- 데이터 파일 하나가 만들어지는 저장 공간
CREATE USER ALICE IDENTIFIED BY 'alice-password' DEFAULT TABLESPACE APP;
GRANT ALL ON TABLESPACE APP TO ALICE;                                    -- APP 안에서 만들고, 읽고, 쓰고, 지우는 권한
GRANT CONNECT TO ALICE;                                                  -- 다른 장비에서 접속하게 하려면 필요합니다
```

SQL 문법은 [sql-syntax.md](rdbms/docs/sql-syntax.md), 데이터 타입은 [data-types.md](rdbms/docs/data-types.md), 사용자와 권한은 [accounts-and-privileges.md](rdbms/docs/accounts-and-privileges.md), 트랜잭션은 [transactions.md](rdbms/docs/transactions.md) 를 참고하세요.

## Node.js 프로그램에서 DB 접속, SQL문 사용

DB 가 구동 중이고 접속할 사용자가 있어야 합니다. (위의 두 단계) 드라이버(`nodejsDriver`)는 실행에 외부 패키지가 필요 없고, Node.js 22 이상과 bun 에서 동작합니다.

**1. 드라이버를 빌드합니다.** 위에서 `git clone` 한 저장소 안에서 실행합니다.

```sh
cd HelloWorldDB/nodejsDriver
npm install
npm run build
```

**2. 내 프로젝트에 설치합니다.** 내 프로젝트 디렉토리에서 드라이버 디렉토리의 경로를 주어 설치합니다. (경로는 `git clone` 한 위치에 맞게 바꿉니다)

```sh
mkdir myapp
cd myapp
npm init -y
npm install ../HelloWorldDB/nodejsDriver
```

**3. 프로그램을 작성합니다.** `app.mjs`

```js
import { connect, DbError } from "org.duckdns.hjow.helloworlddb.nodejsdriver";

// 호스트와 포트를 생략하면 127.0.0.1 의 7410 번 포트(TCP)로 접속합니다.
const db = await connect({ user: "ALICE", password: "alice-password" });

try {
  await db.query("CREATE TABLE IF NOT EXISTS MEMO (ID INTEGER PRIMARY KEY, TEXT VARCHAR(100), CREATED TIMESTAMP)");
  await db.query("DELETE FROM MEMO");
  await db.query("INSERT INTO MEMO VALUES (?, ?, ?)", [1, "안녕, HelloWorldDB", new Date()]);   // ? 자리에 값을 넘깁니다.

  const result = await db.query("SELECT ID, TEXT FROM MEMO WHERE ID = ?", [1]);
  console.log(result.rows);       // [ [ 1, '안녕, HelloWorldDB' ] ]
  console.log(result.records());  // [ { ID: 1, TEXT: '안녕, HelloWorldDB' } ]

  // 트랜잭션 : 끝나면 커밋하고, 예외가 나면 롤백합니다.
  await db.transaction(async (tx) => {
    await tx.query("INSERT INTO MEMO (ID, TEXT) VALUES (2, '트랜잭션 안에서')");
  });
  console.log((await db.query("SELECT COUNT(*) FROM MEMO")).rows[0][0]);  // 2n  (COUNT 는 BIGINT 라서 bigint 로 옵니다)
} catch (error) {
  if (error instanceof DbError) console.error(error.sqlState, error.message);   // SQLSTATE 5자리와 영문 메시지
  else throw error;
} finally {
  await db.close();
}
```

**4. 실행합니다.**

```sh
node app.mjs         # bun 으로는 bun app.mjs
```

```
[ [ 1, '안녕, HelloWorldDB' ] ]
[ { ID: 1, TEXT: '안녕, HelloWorldDB' } ]
2n
```

- `connect` 의 옵션은 `user`, `password` 만 필수입니다. 다른 장비의 DB 는 `host`, `port` 로 지정하고(`connect({ host: "192.168.0.10", port: 7410, user, password })`), 그 사용자에게 `GRANT CONNECT TO` 가 있어야 합니다.
  접속 정보에 SID 나 데이터베이스 이름은 없습니다. 포트 번호가 인스턴스를 가리킵니다.
- `protocol: "udp"` 로 UDP 접속을, `ssl: true` 로 TLS 접속을 할 수 있습니다. (UDP 구간은 암호화되지 않고, TLS 서버 인증서는 기본으로 검증합니다)
- 값은 `NUMERIC` 은 문자열, `BIGINT` 는 `bigint`, 날짜시간은 문자열, 이진은 `Buffer` 로 옵니다. 정밀도를 잃지 않기 위해서입니다.
- 큰 조회 결과를 나누어 읽는 `stream`, 커넥션 풀 `createPool`, 오류와 옵션의 전체 설명은 [nodejsDriver/README.md](nodejsDriver/README.md) 에 있습니다.
- 드라이버를 고쳐 `git pull` 한 뒤에는 `nodejsDriver` 에서 `npm run build` 를 다시 실행합니다. (내 프로젝트에는 그 디렉토리가 연결되어 있을 뿐이라 다시 설치하지 않아도 됩니다)

# JDBC 드라이버 계획

| 프로젝트 | 자바 지원 범위 | JDBC 인터페이스 |
|---|---|---|
| [jdbc6](jdbc6/PROGRESS.md) | 자바 6~7 기본 대상, 같은 배포본의 자바 8 이상 실행 호환 | 4.0 |
| [jdbc8](jdbc8/PROGRESS.md) | 자바 8 이상 | 4.2 |

자바 5는 지원하지 않습니다. JDBC 개발은 현재 보류 중이며, 공통 프로토콜 코드는 자바 6 범위로 작성합니다. 상세 기준은 [AGENTS.md의 JDBC 드라이버 지원 기준](AGENTS.md#8-1-jdbc-드라이버-지원-기준)을 따릅니다.

# AI 사용

개발에 AI 서비스 (Codex, Claude Code) 를 적극적으로 사용합니다.

# License

   Copyright 2026 HJOW

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
