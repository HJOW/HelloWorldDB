# 계정과 권한 (8단계)

사용자 계정, 인증용 비밀번호 검증 정보, 권한, 권한 그룹, 문장별 권한 검사의 구조와 규칙을 한곳에 모은 문서이다.
사양은 AGENTS.md 상세 4, 5, 6 이고, 사양이 정하지 않아 구현에서 정한 사항은 "구현에서 정한 사항" 절에 따로 적었다.

## 1. 저장

사용자, 권한, 권한 그룹 부여 내역은 SYSTEM 테이블스페이스의 카탈로그(`catalog.system`, JSON)에 둔다. 테이블스페이스 목록과 같은 곳이다.

| 항목 | 형태 |
|---|---|
| `users` | 사용자 이름 → `{ name, defaultTablespace, verifier, createdAt }` |
| `privileges` | `{ grantee, tablespace, object, privilege }` 목록. 권한 하나가 기록 하나이며 `object` 가 null 이면 테이블스페이스 수준 |
| `groups` | 사용자 이름 → 명시적으로 부여받은 권한 그룹(`CONNECT`, `OFFICER`, `DBA`) |

- 카탈로그를 읽을 때 빠진 항목은 빈 값으로 채운다(`normalizeSystemRegistry`). 그래서 이 항목이 없던 이전 데이터 디렉토리도 그대로 열린다.
  포맷 번호는 올리지 않았다(개요 3 의 1.0 출시 전 예외).
- 객체의 소유자는 각 테이블스페이스 카탈로그의 테이블·뷰 정의(`owner`)에 있다. 객체를 만든 사용자가 소유자이다.
- 비밀번호는 평문으로 저장하지 않는다. `verifier` 는 SCRAM-SHA-256 검증 정보 `{ salt, iterations, storedKey, serverKey }`(모두 base64)이다.
- 저장은 DDL 과 같다. 문장이 끝나면 SYSTEM 카탈로그를 바로 쓴다. 사용자·권한 문장도 실행 전후에 자동 커밋되고 롤백할 수 없다.

## 2. 비밀번호와 SCRAM-SHA-256

`auth/scram.ts` 는 서버와 클라이언트가 함께 쓰는 순수 계산 모듈이다. RFC 5802, RFC 7677 을 따르며 RFC 7677 의 시험 벡터로 검증한다(`test/auth/scram.test.ts`).

- 검증 정보 만들기 : `SaltedPassword = PBKDF2-HMAC-SHA-256(비밀번호, 솔트, 반복 횟수)`, `StoredKey = SHA-256(HMAC(SaltedPassword, "Client Key"))`, `ServerKey = HMAC(SaltedPassword, "Server Key")`.
- 반복 횟수의 기본값은 **4096** 이다(RFC 7677 의 권고 최소값, PostgreSQL 의 기본값). `Database.open` 의 `scramIterations` 로 바꿀 수 있고 config.json 의 키는 아니다.
  검증 정보에 반복 횟수를 함께 저장하므로 기본값을 올려도 이전 계정은 그대로 통한다.
- 비밀번호는 SASLprep 대신 NFKC 정규화만 한다. ASCII 비밀번호에서는 둘이 같고, 서버와 클라이언트가 같은 함수(`normalizePassword`)를 쓰므로 어긋나지 않는다.
- 채널 바인딩은 쓰지 않는다(gs2 헤더 `n,,`).
- 9단계가 쓸 메시지 함수를 함께 제공한다 : `clientFirstMessage`, `serverFirstMessage`, `clientFinalWithoutProof`, `authMessage`, `computeClientProof`, `verifyClientProof`, `computeServerSignature`, `verifyServerSignature`, 각 메시지의 해석기.
- 없는 사용자의 인증 시도에는 `decoyVerifier(사용자, 서버 비밀값)` 를 쓴다. 같은 이름에는 항상 같은 솔트가 나가고 어떤 증명도 통과하지 못한다. 솔트나 응답 시간으로 사용자의 존재를 알 수 없게 하기 위함이다.
- 비밀번호는 오류 메시지와 로그에 남기지 않는다.

`Database.login(사용자, 비밀번호, { local })` 은 프로세스 안에서 비밀번호로 접속하는 입구이다(통신 계층의 SCRAM 교환이 붙기 전의 내부 시험과 로컬 용도).

- 사용자가 없는 경우와 비밀번호가 틀린 경우는 구분하지 않고 같은 오류(`28000`, "Authentication failed.")를 낸다. 없는 사용자도 같은 계산을 한다.
- `local: false`(원격)이면 비밀번호가 맞은 뒤에 CONNECT 권한 그룹을 확인한다. 없으면 `28000`(내부 번호 7006)이다. 로컬은 CONNECT 와 상관없이 받는다.
- `createSession({ user })` 는 이미 인증을 거친 접속(통신 계층의 인증 뒤, 로컬 CLI, 내부 시험)을 위한 것이며 비밀번호를 확인하지 않는다. 사용자는 있어야 한다.

## 3. 사용자 문장

| 문장 | 규칙 |
|---|---|
| `CREATE USER u IDENTIFIED BY 'pw' [DEFAULT TABLESPACE ts]` | DBA 만. 이름이 권한 그룹 이름이면 `42602`, 이미 있으면 `42710`, 빈 비밀번호는 `22023`, 없는 테이블스페이스는 `3D000` |
| `ALTER USER u IDENTIFIED BY 'pw'` | 자기 자신은 누구나. 다른 사용자는 DBA 만 |
| `ALTER USER u DEFAULT TABLESPACE ts` | DBA 만 (자기 자신도) |
| `DROP USER u [CASCADE]` | DBA 만. SYSTEM 은 삭제 불가(`42501`). 접속 중이면 `55006`. 소유 객체가 있으면 `55006`, `CASCADE` 면 소유한 뷰와 테이블을 `CASCADE` 로 함께 삭제 |

- 새 사용자는 아무 권한이 없다. 로컬 로그인만 된다. 기본 테이블스페이스를 지정해도 그 테이블스페이스의 권한이 생기지 않는다.
- 사용자를 삭제하면 그 사용자가 받은 권한과 권한 그룹 기록도 지운다. 같은 이름으로 다시 만들어도 이어받지 않는다.
- **SYSTEM 계정** : `Database.open` 이 데이터 디렉토리에 SYSTEM 계정이 없으면 만든다(암호 `HelloWorldDB`, 권한 그룹 DBA, 기본 테이블스페이스 SYSTEM).
  삭제할 수 없고 DBA 를 회수할 수 없다. 초기 암호 그대로인지는 `Database.isInitialSystemPassword()` 로 알 수 있고, 데몬은 구동 로그에 경고를 남긴다(`INITIAL_PASSWORD_WARNING`).
  CLI(10단계)가 같은 판정으로 SYSTEM 로그인 때 안내를 보인다.

### 현재 테이블스페이스가 없는 상태

기본 테이블스페이스가 없는 사용자의 세션은 현재 테이블스페이스가 없다(`NO_TABLESPACE`, 빈 문자열). 이때

- 테이블스페이스명이 없는 객체 이름은 `3F000`(내부 번호 7005)이다. `USE ts` 를 하거나 이름에 테이블스페이스명을 붙인다.
- `SELECT 'Hello World'`, `DUAL`, 딕셔너리 뷰는 이름을 붙이지 않아도 된다.
- `SYS_SESSIONS.TABLESPACE_NAME` 은 NULL 이다.
- 사용자의 기본 테이블스페이스가 `DROP TABLESPACE` 로 사라지면 그 사용자는 이 상태가 된다.

## 4. 권한

### 4-1. 수준과 종류

| 권한 | 테이블스페이스 수준 | 객체 수준 (테이블, 뷰) |
|---|---|---|
| `SELECT`, `INSERT`, `UPDATE`, `DELETE` | 그 안의 모든 테이블과 뷰(나중에 만든 것 포함) | 해당 객체 |
| `CREATE` | 테이블, 뷰 생성 | 줄 수 없음(`0LP01`) |
| `ALTER` | 그 안의 모든 객체 변경 | 테이블 : `ALTER TABLE`, 인덱스 생성과 삭제. 뷰 : `CREATE OR REPLACE VIEW` |
| `DROP` | 그 안의 모든 객체 삭제 | 테이블 : `DROP TABLE`, `TRUNCATE`. 뷰 : `DROP VIEW` |

`ALL` 은 그 수준에서 줄 수 있는 전부(테이블스페이스 7개, 객체 6개)이며 기록은 권한 하나마다 따로 남는다.

### 4-2. 판정

사용자가 객체에 권한을 가졌는지는 다음 중 하나라도 맞으면 허용이다(`AccessControl.can`).

1. DBA 권한 그룹
2. OFFICER 권한 그룹이고 테이블스페이스가 SYSTEM 이 아님
3. 테이블스페이스 수준 부여 기록
4. 객체 수준 부여 기록
5. 소유자 자격 : 테이블 소유자는 그 테이블의 모든 권한. 뷰 소유자는 그 뷰의 `ALTER`, `DROP`
6. 뷰 소유자가 위의 1 ~ 4 로 받은 뷰 권한이 없는 `SELECT`·`INSERT`·`UPDATE`·`DELETE` : 뷰가 참조하는 모든 객체에 대한 본인의 권한으로 판정(재귀)

각 수준의 부여 기록은 서로 독립이다. 테이블스페이스 수준 권한을 회수해도 객체 수준으로 따로 부여한 권한은 남는다. 반대도 같다.

권한 변경은 접속 중인 세션에도 **다음 문장부터** 바로 적용된다. 검사는 문장을 실행하기 전에, 비동기 실행에서 잠금을 기다렸다가 문장을 다시 시도할 때마다 한다.

### 4-3. 뷰 권한 규칙

- 뷰에 권한이 있으면 뷰가 참조하는 테이블 각각의 권한은 검사하지 않는다. 예를 들어 뷰 `VIEW_SAMPLE1` 에 `UPDATE` 가 있으면 기반 테이블에 권한이 없어도 그 뷰로 `UPDATE` 할 수 있다(`test/auth/privileges.test.ts`의 개요 5 예시).
  구현은 문장에 **적힌** 객체만 검사하고 뷰를 펼친 안쪽은 검사하지 않는 방식이다. 뷰 안의 서브쿼리와 조인이 읽는 객체도 뷰 정의자의 권한으로 읽는 셈이다.
- 뷰를 만들려면 테이블스페이스의 `CREATE` 와 뷰가 참조하는 **모든** 객체(서브쿼리, 조인, 다른 뷰 포함)에 대한 `SELECT` 가 있어야 한다.
- 뷰 소유자 본인이 따로 부여받은 뷰 권한이 없을 때는 기반 객체에 대한 본인의 권한으로 검사한다. 뷰를 만든 것만으로 기반 테이블에 없던 권한이 생기지 않게 하기 위함이다.
  기반 테이블의 권한을 잃으면 자기 뷰도 쓸 수 없다.
- `CREATE OR REPLACE VIEW` 로 이미 있는 뷰를 바꾸려면 그 뷰의 `ALTER` 가 필요하고(없는 뷰를 새로 만드는 것이면 `CREATE`), 소유자는 바뀌지 않는다.

### 4-4. GRANT, REVOKE 실행 자격

| 대상 | 실행할 수 있는 사용자 |
|---|---|
| 테이블스페이스 수준 | DBA 만 |
| 테이블 | DBA, 그 테이블의 소유자 |
| 뷰 | DBA, 그 뷰의 소유자. 단, 뷰가 직접·간접으로 참조하는 모든 테이블과 뷰의 소유자이기도 해야 함 |
| 권한 그룹 | DBA 만 |

- `WITH GRANT OPTION`(받은 권한을 다시 주기), 사용자 간 상속, 컬럼 단위 권한, `PUBLIC` 대상, 사용자 정의 권한 그룹은 지원하지 않는다(`0A000`).
- 받는 사용자와 대상 객체는 있어야 한다. 사용자가 없으면 `42704`, 객체가 없으면 `42P01`, `ON TABLE` 인데 뷰이거나 그 반대이면 `42P01`, 딕셔너리 뷰이면 `42809` 이다.
- 부여된 적 없는 권한을 회수하면 오류 없이 넘어간다. 이미 있는 권한을 다시 주어도 기록은 하나이다.

### 4-5. 권한 그룹

| 그룹 | 의미 |
|---|---|
| `CONNECT` | 원격 접속 허용. 로컬 접속(로컬 전용 채널, 루프백 주소)은 이 그룹과 상관없이 항상 받는다. 회수해도 이미 맺어진 세션은 끊지 않는다 |
| `OFFICER` | SYSTEM 을 제외한 모든 테이블스페이스(나중에 만든 것 포함)에 테이블스페이스 수준 `ALL`. GRANT·REVOKE 와 사용자·테이블스페이스 관리는 포함하지 않는다 |
| `DBA` | 모든 권한. OFFICER 를 포함하고 CONNECT 는 포함하지 않는다. 그래서 SYSTEM 계정도 원격 접속에는 `GRANT CONNECT TO SYSTEM` 이 필요하다 |

DBA 가 OFFICER 를 포함하는 것은 기록으로 펼치지 않고 판정 때 계산한다. 따라서 `SYS_GROUP_GRANTS` 에는 명시적으로 부여한 그룹만 나오고, DBA 에게서 `OFFICER` 를 회수하는 것은 할 일이 없다.

## 5. 문장별 권한 검사

`auth/authorizer.ts` 가 구문 트리를 보고 문장이 실행되기 전에 필요한 권한을 모두 확인한다. 권한이 모자라면 문장은 시작도 하지 않고 `42501`(내부 번호 7001)로 끝난다.
DDL 계열(사용자·권한 문장 포함)은 진행 중인 트랜잭션을 자동 커밋하기 **전에** 확인한다. 거부된 문장이 트랜잭션을 커밋하지 않는다.

| 문장 | 필요한 권한 |
|---|---|
| `SELECT` | 적힌 모든 테이블과 뷰(서브쿼리, 인라인 뷰, 조인, 집합 연산 포함)의 `SELECT`. `FOR UPDATE` 가 붙으면 그 질의의 FROM 에 적힌 테이블의 `UPDATE` 도 필요 |
| `INSERT` / `UPDATE` / `DELETE` | 대상의 `INSERT` / `UPDATE` / `DELETE`. `INSERT ... SELECT` 의 원천, 식 안의 서브쿼리가 읽는 다른 객체의 `SELECT` |
| `CREATE TABLE` | 테이블스페이스의 `CREATE`. FK 가 참조하는 테이블(자기 자신 제외)의 `SELECT` |
| `CREATE VIEW` | 테이블스페이스의 `CREATE`(기존 뷰를 `OR REPLACE` 하면 그 뷰의 `ALTER`)와 참조하는 모든 객체의 `SELECT` |
| `ALTER TABLE` | 테이블의 `ALTER`. FK 를 더하면 참조되는 테이블의 `SELECT` |
| `CREATE INDEX`, `DROP INDEX` | 테이블의 `ALTER` |
| `DROP TABLE`, `DROP VIEW`, `TRUNCATE` | 대상의 `DROP` |
| `CREATE TABLESPACE`, `DROP TABLESPACE`, `CREATE USER`, `DROP USER`, 권한 그룹의 `GRANT`·`REVOKE` | DBA |
| `ALTER USER` | 자기 비밀번호는 누구나, 그 밖은 DBA |
| `GRANT`, `REVOKE` | 4-4 |
| `USE`, `SET ...`, 트랜잭션 문장, `DUAL`, 딕셔너리 뷰 읽기 | 없음 |

- 없는 객체는 권한 검사가 거부하지 않고 지나가며 실행 단계가 "없음" 오류(`42P01`, `3D000`)를 낸다. `IF EXISTS` 도 그대로 동작한다.
  (그래서 권한이 없는 객체와 없는 객체는 오류 번호로 구별된다. PostgreSQL 과 같은 동작이다.)
- 현재 테이블스페이스가 없는데 테이블스페이스명도 없는 이름은 `3F000` 이다.

## 6. 딕셔너리 뷰의 가시성

딕셔너리 뷰는 모든 사용자가 조회할 수 있고 읽기 전용이다. 보이는 행은 다음과 같다. DBA 는 전부 본다.

| 뷰 | 일반 사용자에게 보이는 행 |
|---|---|
| `SYS_TABLES`, `SYS_COLUMNS` | `SELECT`·`INSERT`·`UPDATE`·`DELETE`·`ALTER`·`DROP` 중 하나라도 가진(소유 포함) 테이블 |
| `SYS_VIEWS` | 같은 기준의 뷰 |
| `SYS_INDEXES`, `SYS_INDEX_COLUMNS`, `SYS_CONSTRAINTS`, `SYS_CONSTRAINT_COLUMNS` | 보이는 테이블에 딸린 것 |
| `SYS_TABLESPACES` | 테이블스페이스 수준 권한이 있거나 그 안에 권한이 있는 객체나 소유 객체가 있는 테이블스페이스 |
| `SYS_PRIVILEGES` | 자신이 받은 기록, 자신이 소유한 객체에 부여된 기록 |
| `SYS_USERS`, `SYS_GROUP_GRANTS`, `SYS_SESSIONS` | 자기 것만 |

`SYS_USERS` 에는 비밀번호 정보가 없다. 열은 `USER_NAME`, `DEFAULT_TABLESPACE` 뿐이고 검증 정보는 딕셔너리 뷰의 원천에 넘기지도 않는다.

## 7. 기록 정리

DDL 이 끝날 때마다(`Session.cleanupAfterDdl`) 다음을 한다.

- 사라진 객체와 테이블스페이스의 권한 기록을 지운다(`AccessControl.pruneStaleRecords`). 객체를 지우면 그 객체의 권한 기록도 지워지고, 같은 이름으로 다시 만들어도 이어받지 않는다.
  사용 불가 상태라 읽을 수 없는 테이블스페이스의 기록은 있는지 알 수 없으므로 남긴다.
- 지워진 테이블스페이스를 기본으로 쓰던 사용자는 기본 테이블스페이스가 없는 상태가 된다(`UserStore.clearMissingDefaultTablespaces`).
- 테이블 이름을 바꾸면(`ALTER TABLE ... RENAME TO`) 권한 기록이 새 이름을 따라간다(`AccessControl.renameObject`).

## 8. 구현에서 정한 사항

사양이 정하지 않아 구현에서 정했다. 바꿔야 하면 이 문서와 PROGRESS.md 의 결정 사항을 함께 고친다.

- 대상의 컬럼을 `WHERE` 나 `SET` 에서 읽는 `UPDATE`·`DELETE` 에는 `SELECT` 를 요구하지 않는다. 사양 개요 5 의 "뷰에 UPDATE 권한이 있으면 UPDATE 가 가능해야 한다" 를 그대로 따르기 위함이다.
- `SELECT ... FOR UPDATE` 는 행을 잠그므로 `UPDATE` 도 요구한다(PostgreSQL 과 같음).
- `DROP ... CASCADE` 로 함께 지워지는 FK 제약조건과 의존 뷰에는 별도 권한을 보지 않는다. 대상 객체의 `DROP` 만 본다.
- `USE ts` 는 권한 없이 할 수 있다. 객체 접근은 객체마다 검사하기 때문이다.
- 테이블스페이스 수준 `GRANT` 는 DBA 만 한다. 사양 5 의 "테이블스페이스 수준 권한은 DBA 만 부여, 회수할 수 있다" 대로이다.
- 객체 수준 `CREATE` 를 주려 하면 `0LP01`(PostgreSQL 의 invalid_grant_operation)이다.
- 자기 자신의 기본 테이블스페이스 변경은 DBA 만 한다. 사양이 자기 비밀번호만 허용했기 때문이다.
- 빈 비밀번호는 거부한다.
- 인증 실패 메시지는 영문 "Authentication failed." 하나이다.

**사용자 확인(2026-10-16)** : 위 규칙은 사용자가 점검을 요청했고 "사양이 정하지 않은 부분은 보편적인 RDBMS 의 동작을 따른다" 로 정해졌다. 규칙을 하나씩 견주어 보면 다음과 같아 코드를 바꾸지 않았다.

| 규칙 | 견줌 |
|---|---|
| 대상 컬럼을 읽는 `UPDATE`·`DELETE` 에 `SELECT` 를 요구하지 않음 | Oracle 의 기본 동작과 같다. (PostgreSQL, MySQL 은 읽는 컬럼에 `SELECT` 를 요구한다) AGENTS.md 개요 5 의 "뷰에 `UPDATE` 권한이 있으면 그 뷰로 `UPDATE` 가능" 을 조건 없이 지키려면 요구하지 않는 쪽이어야 한다 |
| `SELECT ... FOR UPDATE` 는 `UPDATE` 도 요구 | PostgreSQL 과 같다. MySQL 도 `SELECT` 에 더해 `UPDATE`, `DELETE`, `LOCK TABLES` 중 하나를 요구한다 |
| `DROP ... CASCADE` 로 함께 지워지는 객체에 별도 권한 없음 | PostgreSQL, Oracle 과 같다(대상 객체의 `DROP` 만 본다) |
| `USE` 는 권한 없이 가능 | MySQL 은 데이터베이스에 대한 어떤 권한을 요구하지만, 여기서는 테이블스페이스가 이름 공간을 겸하고 객체 접근을 객체마다 검사하므로 `USE` 자체는 권한을 보지 않는다 |
| 권한 없음(`42501`)과 객체 없음(`42P01`)을 구별 | PostgreSQL 과 같다 |
| 빈 비밀번호 거부 | Oracle 과 같다. 인증 실패 메시지를 하나로 하는 것은 계정 존재를 숨기는 보편적인 관행이다 |

앞으로 이 영역에서 사양이 정하지 않은 세부는 같은 원칙(Oracle, PostgreSQL, MySQL 의 공통 동작)을 따른다. 세 DBMS 가 다르면 개요와 상세의 명시 문구를 먼저 지키고 이 절에 이유를 적는다.

## 9. 오류 번호

7000 번대를 8단계에 배정했다.

| 번호 | SQLSTATE | 뜻 |
|---|---|---|
| 7000 | `28000` | 인증 실패 (없는 사용자와 틀린 비밀번호가 같음) |
| 7001 | `42501` | 권한 없음 |
| 7002 | `42710` | 사용자가 이미 있음 |
| 7003 | `42704` | 사용자가 없음 |
| 7004 | `0LP01` | 그 수준에 줄 수 없는 권한 (객체 수준 CREATE) |
| 7005 | `3F000` | 현재 테이블스페이스가 없음 |
| 7006 | `28000` | CONNECT 없이 원격 접속 |
| 7007 | `22023` | 올바르지 않은 비밀번호 (빈 값) |
| 7008 | `42501` | 보호되는 계정 (SYSTEM 삭제, SYSTEM 의 DBA 회수) |

그 밖에 `42602`(권한 그룹 이름으로 사용자 생성), `55006`(접속 중이거나 객체를 소유한 사용자 삭제), `42809`(딕셔너리 뷰 대상 GRANT)는 앞 단계의 번호를 쓴다.

## 10. 이어받을 때

- 통신 계층(9단계)은 접속마다 SCRAM 교환을 하고 성공하면 `database.createSession({ user, tablespace })` 로 세션을 만든다. 교환에는 `database.users.verifierOf(이름)` 의 검증 정보를 쓰고,
  없는 사용자에게는 `decoyVerifier` 를 쓴다. 원격 접속이면 세션을 만들기 전에 `database.assertMayConnect(사용자, local)` 로 CONNECT 를 확인한다.
  (`Database.login` 은 평문 비밀번호를 받으므로 프로세스 안에서만 쓴다.)
- 새 문장 종류를 추가할 때는 `auth/authorizer.ts` 의 `authorizeStatement` 에 필요한 권한을 정하고, `session.ts` 의 `statementClass` 에 분류를 넣는다. 둘 다 빠지면 컴파일이 실패한다(`never` 검사).
- 문장 실행기가 객체를 읽는 새 경로를 만들면 그 경로가 `authorizer.ts` 가 보는 `Table` 참조와 같은 객체만 읽는지 확인한다. 뷰 안쪽은 정의자의 권한이므로 검사하지 않는다.
