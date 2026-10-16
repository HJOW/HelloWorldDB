# HelloWorldDB 사용 설명서

HelloWorldDB 는 Node.js 나 bun 으로 돌아가는 단순한 구조의 RDBMS 이다. 이 문서는 서버를 설치하고, 데몬으로 띄우고, 접속하고, 설정하고, 백업하는 방법을 순서대로 설명한다.
SQL 문법은 [sql-syntax.md](sql-syntax.md), 데이터 타입은 [data-types.md](data-types.md), 사용자와 권한은 [accounts-and-privileges.md](accounts-and-privileges.md), 트랜잭션은 [transactions.md](transactions.md)를 본다.
`hwdb` 명령의 세부 동작은 [cli.md](cli.md), 드라이버를 만드는 사람을 위한 통신 규격은 [protocol.md](protocol.md)이다.

## 1. 준비물과 설치

- **Node.js 22 이상** 또는 **bun**. 같은 빌드 결과물이 둘 다에서 돈다. (개발 장비는 Windows 11, Node.js 24, bun 1.3 이다. 리눅스와 macOS 는 아직 실제 장비에서 확인하지 못했다)
- 빌드할 때만 TypeScript 6 와 `@types/node` 가 필요하다. 실행할 때는 외부 패키지가 필요 없다.

```sh
cd rdbms
npm install            # 빌드용 개발 의존성을 받는다
npm run build          # dist/ 에 JavaScript 를 만든다
node dist/src/cli/main.js --version     # hwdb 0.1.0
```

`hwdb` 를 어디서든 쓰려면 `npm link` 로 전역 명령으로 등록한다. (`package.json` 의 `bin` 이 `dist/src/cli/main.js` 를 가리킨다) 이 문서는 이후 `hwdb` 로 적는다.
등록하지 않았으면 `node dist/src/cli/main.js` 로, bun 으로 돌릴 때는 `bun dist/src/cli/main.js` 로 바꿔 읽는다.

**설치 디렉토리** 는 `rdbms` 디렉토리이다. `hwdb` 는 자신이 속한 설치 디렉토리의 [config.json](#4-설정-configjson)을 읽고, 데이터(`./data`)와 로그(`./logs`)도 기본으로 그 아래에 둔다.
데몬은 `hwdb start` 를 실행한 런타임(Node.js 면 Node.js, bun 이면 bun)으로 돈다.

## 2. 빠른 시작

```sh
hwdb start                                   # 데몬을 띄우고 바로 돌아온다
hwdb -u SYSTEM -p HelloWorldDB -e "SELECT 'Hello World'"
hwdb stop                                    # 정상 종료
```

```
HelloWorldDB started. port: 7410, pid: 12345
+-------------+
| COL1        |
+-------------+
| Hello World |
+-------------+
1 row (1 ms)
```

테이블을 만들어 보려면 `hwdb` 만 실행해 접속한다. 사용자명과 비밀번호를 물어본다.

```
$ hwdb
Username: SYSTEM
Password:
hwdb> CREATE TABLE HELLO (MESSAGE VARCHAR);
hwdb> INSERT INTO HELLO VALUES ('Hello World');
hwdb> SELECT * FROM HELLO;
hwdb> exit
```

문장은 `;` 를 만나면 실행되고 여러 줄에 걸쳐 쓸 수 있다. 파일이나 표준 입력으로 스크립트를 실행할 수도 있다. (`hwdb -u SYSTEM -p ... -f script.sql`, `hwdb -u SYSTEM -p ... < script.sql`)

## 3. 데몬 구동, 종료, 상태

| 명령 | 하는 일 | 종료 코드 |
|---|---|---|
| `hwdb start` | 데몬을 터미널과 분리된 프로세스로 띄운다. 접속을 받을 수 있게 되면 포트 번호와 PID 를 알리고 바로 끝난다. 터미널을 닫아도 데몬은 계속 돈다 | 성공 0, 실패 1 (이미 구동 중이면 그 사실만 알리고 0) |
| `hwdb stop` | 정상 종료를 요청하고 프로세스가 사라질 때까지 기다린다 | 성공 0, 실패 1 (구동 중이 아니면 그 사실만 알리고 0) |
| `hwdb status` | 구동 여부, 포트, PID, 구동 시각, 버전, 데이터 디렉토리, TCP·UDP 사용 여부, 세션 수를 보여 준다 | 구동 중 0, 아니면 1 |

- `--timeout <초>` 는 `start` 와 `stop` 이 기다리는 제한 시간이다. 기본은 30초이다.
- `hwdb start --foreground` 는 분리하지 않고 현재 터미널에서 실행한다. 서비스 관리자(systemd, Windows 서비스 래퍼 등)에 등록하거나 문제를 볼 때 쓴다. Ctrl-C(SIGINT), SIGTERM 또는 다른 터미널의 `hwdb stop` 으로 끝난다.
- 구동에 실패하면 원인(예 : 포트 사용 중, 잘못된 config.json)과 로그 파일 경로를 보여 주고 1로 끝난다. 데몬의 출력은 `<log.dir>/helloworlddb.log`(기본 `./logs/helloworlddb.log`)에 남는다.
- **정상 종료를 권한다.** `hwdb stop` 은 진행 중인 트랜잭션을 롤백하고 데이터 파일에 정상 종료 표시를 남긴다. 프로세스를 강제로 끝내면 다음 구동에서 경고가 나온다(8절).
- 같은 데이터 디렉토리는 데몬 하나만 쓸 수 있다. 데이터 디렉토리의 `helloworlddb.lock` 이 이를 지킨다. 비정상 종료로 이 파일이 남았더라도 적힌 PID 의 프로세스가 없으면 구동 중이 아닌 것으로 보고 덮어쓴다.
- `stop` 과 `status` 는 DB 계정 없이 데이터 디렉토리를 읽을 수 있는 운영체제 사용자가 할 수 있다. (잠금 파일의 제어 토큰을 쓴다) 원격에서는 데몬을 끌 수 없다.

## 4. 설정 (config.json)

설치 디렉토리의 `config.json` 으로 서버를 설정한다. **파일이 없어도 되고**, 필요한 키만 적으면 나머지는 기본값이다. 모든 키를 기본값으로 적은 예시가 [config.sample.json](../config.sample.json)이다.

- 구동할 때 **한 번만** 읽는다. 바꾼 내용은 `hwdb stop` 후 `hwdb start` 해야 적용된다.
- 상대 경로는 config.json 이 있는 디렉토리를 기준으로 한다. (실행한 현재 디렉토리가 아니다)
- 모르는 키는 구동 로그에 경고를 남기고 무시한다. 값이 올바르지 않으면(예 : `maxConnections` 가 0) 구동에 실패하고 원인을 알린다.

| 키 | 기본값 | 설명 |
|---|---|---|
| `port` | `7410` | 인스턴스의 포트 번호. TCP 와 UDP 가 같은 번호를 쓰고, 로컬 전용 채널의 주소도 이 번호로 정해진다(7절) |
| `dataDir` | `"./data"` | 데이터 파일 디렉토리 |
| `maxConnections` | `10` | TCP, UDP 접속의 동시 세션 수 상한. 넘으면 새 접속은 거부된다. 로컬 전용 채널은 세지 않는다 |
| `timeZone` | `"local"` | 세션의 기본 타임존. `"local"`(서버 OS), `"+09:00"`, `"Asia/Seoul"` 형태. 세션에서 `SET TIME ZONE` 으로 바꿀 수 있다 |
| `tcp.enabled` | `true` | TCP 접속 사용 여부 |
| `tcp.host` | `"0.0.0.0"` | TCP 바인드 주소. 이 장비에서만 쓰려면 `"127.0.0.1"` |
| `tcp.ssl.certPath` | 없음 | SSL 인증서(PEM) 경로. `keyPath` 와 **함께** 적어야 한다 |
| `tcp.ssl.keyPath` | 없음 | SSL 개인키(PEM) 경로 |
| `tcp.ssl.minVersion` | `"TLSv1.2"` | 허용할 TLS 최소 버전. `"TLSv1"`, `"TLSv1.1"`, `"TLSv1.2"`, `"TLSv1.3"` 중 하나 |
| `udp.enabled` | `true` | UDP 접속 사용 여부 |
| `udp.host` | `"0.0.0.0"` | UDP 바인드 주소 |
| `udp.maxPacketSize` | `1200` | UDP 패킷 하나의 최대 크기(바이트). 64 이상 65,507 이하 |
| `udp.sessionTimeoutMs` | `60000` | UDP 세션에서 이 시간 동안 수신이 없으면 세션을 끝낸다. 0 이면 제한이 없고 구동 로그에 경고가 남는다 |
| `transaction.lockTimeoutMs` | `30000` | 행 잠금을 기다리는 제한 시간. 넘으면 그 문장이 `55P03` 으로 끝난다 |
| `session.idleTimeoutMs` | `0` | 이 시간 동안 아무것도 하지 않은 세션을 닫는다. 0 이면 제한이 없다 |
| `log.level` | `"info"` | `error`, `warn`, `info`, `debug` |
| `log.dir` | `"./logs"` | 로그 디렉토리 |

예 : 포트를 바꾸고 SSL 을 켜고 로그를 줄인다.

```json
{
  "port": 7500,
  "tcp": { "ssl": { "certPath": "./certs/server.cert.pem", "keyPath": "./certs/server.key.pem" } },
  "log": { "level": "warn" }
}
```

TCP 와 UDP 를 모두 끄면(`"tcp": { "enabled": false }, "udp": { "enabled": false }`) 이 장비의 `hwdb` 로만 접속할 수 있다. 로컬 전용 채널은 설정과 무관하게 항상 열린다.

### 4-1. SSL

`tcp.ssl.certPath` 와 `keyPath` 를 모두 적으면 **TCP 포트 전체가 TLS** 가 되고 평문 TCP 접속은 받지 않는다. 하나만 적으면 구동에 실패한다.
`hwdb -h <주소> --ssl` 로 접속하면 서버 인증서를 기본으로 검증한다. 자체 서명 인증서를 쓰는 서버는 `--ssl-ca <인증서 파일>` 로 그 인증서를 신뢰하게 한다.
검증을 끄는 `--ssl-no-verify` 는 안전하지 않으니 시험에서만 쓴다. 인증서 오류로 접속에 실패하면 100 ms 뒤 최대 2회 다시 시도하고(검증은 그대로 한다) 실패를 알린다.

- **UDP 구간은 암호화하지 않는다.** SSL 은 TCP 에만 적용된다. 민감한 데이터는 TLS 를 켠 TCP 로 접속한다.
- TLS 1.2 를 쓸 수 없는 오래된 클라이언트(자바 6 등)를 받아야 하면 `tcp.ssl.minVersion` 을 `"TLSv1"` 로 낮춘다. 그 버전의 암호 스위트도 함께 허용되고 구동 로그에 경고가 남는다. 이 서버는 자바 5 를 지원하지 않는다.
- bun 으로 서버를 돌리면 TLS 최소 버전을 설정대로 적용하지 못한다. 기본(`TLSv1.2`)만 지켜지고 구버전 허용은 켤 수 없다. 구동 로그의 경고를 확인한다. ([protocol.md](protocol.md) 16절)

## 5. 처음 설치한 뒤에 할 일 (초기 암호 변경)

설치하면 관리자 계정 **SYSTEM**(초기 암호 `HelloWorldDB`)이 DBA 권한 그룹과 함께 만들어져 있다. 암호가 알려져 있으니 **가장 먼저 바꾼다.** 초기 암호 그대로이면 `hwdb start` 와 `hwdb` 접속이 계속 변경을 안내하고 로그에 경고를 남긴다.

```sh
hwdb start
hwdb                                     # Username: SYSTEM  Password: HelloWorldDB
hwdb> ALTER USER SYSTEM IDENTIFIED BY '새 비밀번호';
hwdb> exit
```

- 이 장비의 `hwdb` 는 **항상** 접속된다. TCP 와 UDP 를 껐거나 `maxConnections` 가 찼거나 CONNECT 권한이 없어도 된다. (로컬 전용 채널을 쓴다. 사용자명과 비밀번호 인증은 그대로 거친다)
- SYSTEM 에는 CONNECT 권한 그룹이 없어서 **처음에는 원격에서 접속되지 않는다.** 원격 관리가 필요하면 `GRANT CONNECT TO SYSTEM`. 다른 장비에서 접속할 사용자에게도 CONNECT 가 필요하다.
- 비밀번호는 평문으로 저장하거나 로그에 남기지 않는다. 검증 정보(SCRAM-SHA-256)만 저장한다.
- 명령행에 `-p 비밀번호` 를 쓰면 운영체제의 프로세스 목록에서 다른 사용자에게 보일 수 있다. 사람이 접속할 때는 `-p` 를 빼고 물어보게 둔다.

### 일반 사용자를 만들어 쓰기

```sql
CREATE TABLESPACE APP;
CREATE USER ALICE IDENTIFIED BY 'alice-password' DEFAULT TABLESPACE APP;
GRANT ALL ON TABLESPACE APP TO ALICE;     -- APP 안에서 만들고 읽고 쓰고 지우는 권한
GRANT CONNECT TO ALICE;                    -- 다른 장비에서도 접속하게 하려면
```

테이블스페이스는 데이터 파일 하나(`<dataDir>/APP.hwdb`)이고 테이블, 뷰, 인덱스를 자기 안에 모두 가진다. 권한과 권한 그룹(CONNECT, OFFICER, DBA)은 [accounts-and-privileges.md](accounts-and-privileges.md)를 본다.

## 6. SQL 접속 (`hwdb`)

| 하고 싶은 일 | 명령 |
|---|---|
| 이 장비에서 대화형으로 접속 | `hwdb` |
| 문장 하나 실행 | `hwdb -u 사용자 -p 비밀번호 -e "SELECT 1"` |
| 파일의 문장 실행 | `hwdb -u 사용자 -p 비밀번호 -f script.sql` |
| 다른 장비에 TCP 로 접속 | `hwdb -h 서버주소 -P 7410 -u 사용자` |
| TLS 로 접속 | `hwdb -h 서버주소 --ssl --ssl-ca server.cert.pem -u 사용자` |
| UDP 로 접속 | `hwdb -h 서버주소 --udp -u 사용자` |
| 다른 인스턴스(포트)에 접속 | `hwdb -P 7500` |
| 시작 테이블스페이스 지정 | `hwdb -t APP` |

- 옵션을 모두 생략할 수 있다. 사용자명과 비밀번호는 물어보고(비밀번호는 화면에 보이지 않는다), 접속 대상은 이 장비의 로컬 전용 채널이다. `-h` 를 주면 그 주소에 TCP 로 접속한다.
- 대화형 모드의 프롬프트는 `hwdb> ` 이고 `exit`, `quit` 로 끝낸다. `help` 로 도움말을 본다. 커밋하지 않은 변경이 있는 채로 끝나면 롤백됐다고 알려 준다.
- 스크립트 모드(`-e`, `-f`, 표준 입력)에서는 오류가 나면 그 문장에서 멈추고 종료 코드 1로 끝난다. 표준 입력이 터미널이 아니면 `-u` 와 `-p` 를 반드시 준다.
- 조회 결과는 표이고 끝에 행 수와 소요 시간이 붙는다. 오류는 `ERROR [SQLSTATE:내부번호] 메시지` 이다. 오류 메시지는 영어이고 번역하지 않는다. 오류는 SQLSTATE 로 판단한다.
- 화면 문구(안내, 표 머리글)의 언어는 환경 변수 `HWDB_LANG`, `LC_ALL`, `LC_MESSAGES`, `LANG` 순으로 고른다. 지금은 영어만 있다.

모든 옵션과 조합 규칙은 [cli.md](cli.md)이다. 서버에 접속하는 **Node.js 드라이버** 는 다음 단계(12단계)에서 만든다.

## 7. 여러 인스턴스 (SID 대신 포트 번호)

SID 나 데이터베이스 이름은 없다. **인스턴스는 포트 번호로 구분한다.** 한 장비에 여러 개를 띄우려면 인스턴스마다 설치 디렉토리(그래서 config.json 과 데이터 디렉토리)를 따로 두고 포트 번호를 다르게 한다.

```sh
# 빌드한 rdbms 를 data/, logs/ 만 빼고 rdbms2 로 복사한다(또는 따로 설치한다). rdbms2/config.json 은 { "port": 7500 }
(cd rdbms2 && hwdb start)          # 7500 으로 구동
hwdb status                        # 7410 인스턴스
hwdb -P 7500                       # 7500 인스턴스에 접속
```

- 같은 포트 번호의 인스턴스를 둘 띄울 수 없다. 두 번째는 "포트 번호가 같은 인스턴스가 이미 있을 수 있다" 는 오류로 구동에 실패하고 첫 번째에는 영향이 없다.
- 같은 데이터 디렉토리를 두 인스턴스가 쓸 수도 없다.
- 포트 번호는 인스턴스를 가리키는 이름일 뿐 데이터에 묶이지 않는다. `config.json` 의 `port` 를 바꾸고 재시작하면 같은 데이터를 새 포트 번호로 서비스한다.
- 로컬 전용 채널의 주소는 포트로 정해진다 : Windows 의 네임드 파이프 `\\.\pipe\helloworlddb-<포트>`, 그 외의 유닉스 도메인 소켓 `/tmp/helloworlddb-<포트>.sock`.

## 8. 백업과 복구

초기 버전에는 백업·복원 명령, 내보내기·가져오기, 로그 기반 복구가 **없다.** 백업은 파일 복사이다.

1. `hwdb stop` 으로 정상 종료한다. (실행 중에 복사한 파일은 일관되지 않을 수 있다)
2. 데이터 디렉토리(기본 `./data`)를 통째로 복사한다. 설정도 보관하려면 `config.json` 도 함께 복사한다.
3. 복원은 복사본을 데이터 디렉토리로 두고 `hwdb start` 한다. 다른 위치나 다른 포트의 인스턴스에 그대로 옮겨도 된다. (데이터 파일의 경로는 데이터 디렉토리 기준으로 기록된다)
   `CREATE TABLESPACE ... DATAFILE 경로` 로 데이터 디렉토리 밖에 만든 테이블스페이스는 절대 경로가 기록되므로 그 파일도 따로 백업하고, 복원할 때 같은 경로에 둔다.

비정상 종료(프로세스 강제 종료, 정전)를 겪은 뒤 구동하면 정상 종료 표시와 페이지 체크섬으로 이를 알아채고 **경고 로그** 를 남긴다. 자동 복구는 하지 않는다.
커밋하지 않은 변경은 데이터 파일에 쓰지 않으므로 남지 않지만, 커밋하는 도중에 중단되었다면 그 트랜잭션이 일부만 반영되었을 수 있다. 중요한 데이터는 정상 종료 상태의 백업을 따로 보관한다.
손상되었거나 없는 테이블스페이스는 사용할 수 없는 상태로 두고 나머지를 정상 구동한다. SYSTEM 테이블스페이스가 그런 경우에는 구동에 실패한다.

## 9. 문제 해결

| 증상 | 원인과 조치 |
|---|---|
| `hwdb start` 가 "Cannot open the local-only channel ... already in use" 로 실패 | 같은 포트 번호의 인스턴스가 이미 떠 있다(다른 설치 디렉토리일 수 있다). `config.json` 의 `port` 를 서로 다르게 한다 |
| `hwdb start` 가 "Data directory is already in use by process N" 로 실패 | 그 데이터 디렉토리로 구동 중인 데몬이 있다. 다른 `dataDir` 를 쓰거나 먼저 `hwdb stop` 한다 |
| `hwdb start` 가 "Invalid config value ..." 로 실패 | config.json 의 값이 올바르지 않다. 메시지에 키 이름이 나온다 |
| `hwdb` 가 "cannot connect to the instance on port N through the local-only channel. If the daemon is not running, start it with: hwdb start" 로 끝난다 | 그 포트의 데몬이 떠 있지 않다. `hwdb start`. 다른 인스턴스라면 `-P` 로 포트를 준다 |
| 다른 장비에서 접속이 `28000` "User is not allowed to connect remotely; the CONNECT privilege group is required." 로 거절된다 | 사용자에게 CONNECT 권한 그룹이 없다(`GRANT CONNECT TO 사용자`). 연결 자체가 안 되면 방화벽, `tcp.host`·`udp.host`, `tcp.enabled`·`udp.enabled` 를 본다 |
| 새 접속이 `53300` 으로 거부된다 | TCP, UDP 세션이 `maxConnections` 에 이르렀다. 값을 올리고 재시작하거나 쓰지 않는 세션을 닫는다. 이 장비의 `hwdb` 는 영향받지 않는다 |
| `--ssl` 접속이 인증서 오류(`08001`)로 실패 | 서버 인증서를 신뢰하지 못한다. 자체 서명이면 `--ssl-ca <인증서>`. 인증서의 이름과 접속 주소가 맞는지도 본다 |
| TLS 포트에 평문으로 접속하면 연결이 끊긴다 | `tcp.ssl` 을 켜면 TCP 포트 전체가 TLS 이다. 클라이언트도 `--ssl` 을 쓴다 |
| `55P03` (잠금 대기 초과) | 다른 트랜잭션이 같은 행을 오래 잡고 있다. 트랜잭션을 짧게 하거나 `transaction.lockTimeoutMs` 를 늘린다. 문장만 실패하고 트랜잭션은 유지된다 |
| `40P01` (교착 상태) | 서로의 행을 기다리다 한쪽이 롤백되었다. 그 트랜잭션을 다시 시도한다 |
| `57P05` (유휴 세션 종료) | `session.idleTimeoutMs` 가 지나 서버가 세션을 닫았다. 다시 접속한다 |
| 구동 로그에 "not shut down cleanly" | 직전에 비정상 종료되었다. 8절 |
| `hwdb status` 가 "running: no" 와 `note:` 를 보여 준다 | 잠금 파일의 PID 는 살아 있는데 데몬이 답하지 않는다. 멈춘 데몬이거나 PID 를 다른 프로그램이 쓰는 중이다. 확인한 뒤 필요하면 잠금 파일(`<dataDir>/helloworlddb.lock`)을 지우고 다시 구동한다 |

로그는 `<log.dir>/helloworlddb.log` 이다. `log.level` 을 `debug` 로 바꾸면 더 자세히 남는다. 비밀번호는 어떤 수준에서도 남지 않는다.

## 10. 지원 범위와 알아 둘 점

- SQL : ANSI 데이터 타입(CLOB, BLOB 제외), 테이블·뷰·인덱스 DDL, 질의(조인, 집계, 서브쿼리, 집합 연산), DML, 트랜잭션(READ COMMITTED, 세이브포인트, 행 잠금, 교착 감지), PK·FK·NOT NULL, Oracle 호환 함수 `NVL`, `TO_CHAR`, `TO_DATE`.
- 초기 버전에 없는 것 : CLOB·BLOB, 시퀀스·IDENTITY, 트리거, 저장 프로시저, 구체화 뷰, 파티션, `WITH`(CTE), 윈도우 함수, `MERGE`, 컬럼 타입 변경, `UNIQUE`·`CHECK` 제약조건, 사용자 정의 권한 그룹, 백업·복구 명령, UDP 구간 암호화. 지원하지 않는 문법은 조용히 무시하지 않고 SQLSTATE `0A000` 오류를 낸다.
- 캐릭터셋은 UTF-8 이다. 저장 데이터, SQL 문장, 통신 메시지 모두 UTF-8 이고 올바르지 않은 바이트열은 오류이다.
- 실행 계획은 규칙 기반이다. WHERE 가 인덱스 앞쪽 컬럼의 동등 또는 범위 조건이면 인덱스를 쓴다. 통계 정보를 쓰지 않는다.
- 조회 결과는 서버와 클라이언트가 한 번 메모리에 모은다. 아주 큰 조회는 메모리를 많이 쓴다.
- 테이블스페이스 데이터 파일에는 포맷 버전이 적혀 있다. 지금은 1.0 출시 전이라 포맷이 바뀌면 호환성을 보장하지 않을 수 있다. 업그레이드 기능은 없고, 필요하면 재생성한다.
- 동시 접속은 10개 세션으로 시험했다. ([verification.md](verification.md))
