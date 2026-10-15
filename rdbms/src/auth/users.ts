/**
 * 사용자 계정.
 *
 * 담당
 *  - 사용자 정보의 저장과 조회 : 이름, 비밀번호 검증 정보, 기본 테이블스페이스. SYSTEM 테이블스페이스에 둔다.
 *  - CREATE USER, ALTER USER(비밀번호, 기본 테이블스페이스), DROP USER 가 쓰는 저장 동작
 *  - 이름 규칙 : 권한 그룹 이름(CONNECT, OFFICER, DBA)은 사용자명으로 쓸 수 없다.
 *  - SYSTEM 계정 보호 : 삭제할 수 없다. (DBA 회수 금지는 권한 쪽에서 막는다)
 *  - 최초 구동 시 SYSTEM 계정 만들기 : 암호 HelloWorldDB, 권한 그룹 DBA, 기본 테이블스페이스 SYSTEM
 *  - 비밀번호 확인과, SYSTEM 계정이 초기 암호 그대로인지 판정. (구동 로그와 `hwdb` 의 경고에 쓴다)
 *
 * 실행 자격(누가 이 문장을 실행할 수 있는가)은 auth/authorizer.ts 가 판정하고,
 * 소유 객체 삭제처럼 DDL 이 얽힌 DROP USER 의 실행은 exec/accounts.ts 가 맡는다.
 * 비밀번호는 SCRAM-SHA-256 검증 정보로만 저장한다. 평문은 저장하지 않고 오류 메시지와 로그에도 쓰지 않는다.
 *
 * 관련 사양 : AGENTS.md 상세 4
 * 구현 단계 : 8단계
 */

import { DbError, ERROR_CODES } from "../common/errors.js";
import type { SourcePosition } from "../common/errors.js";
import type { SystemRegistry, StoredUser } from "../catalog/catalog.js";
import type { TablespaceManager } from "../catalog/tablespaceManager.js";
import { DEFAULT_SCRAM_ITERATIONS, createVerifier, verifyPassword } from "./scram.js";
import type { ScramVerifier } from "./scram.js";

/** 기본 제공 관리자 계정의 이름이다. */
export const SYSTEM_USER = "SYSTEM";

/** SYSTEM 계정의 초기 암호이다. 설치 후 바꾸는 것이 표준 절차이다. */
export const INITIAL_SYSTEM_PASSWORD = "HelloWorldDB";

/** 사용자명으로 쓸 수 없는 권한 그룹 이름이다. */
export const PRIVILEGE_GROUP_NAMES: readonly string[] = ["CONNECT", "OFFICER", "DBA"];

function fail(sqlState: string, code: number, message: string, position?: SourcePosition): never {
  if (position !== undefined) {
    const text = message.replace(/\.$/, "");
    throw new DbError(sqlState, code, `${text} (line ${position.line}, column ${position.column}).`, { position });
  }
  throw new DbError(sqlState, code, message);
}

/** 사용자 저장소이다. SYSTEM 카탈로그의 레지스트리를 직접 고치고 바로 저장한다. */
export class UserStore {
  /** 없는 사용자의 비밀번호 확인에도 같은 계산을 하게 하는 가짜 검증 정보이다. 응답 시간으로 존재를 알 수 없게 한다. */
  private readonly decoy: ScramVerifier;

  constructor(
    private readonly manager: TablespaceManager,
    private readonly iterations: number = DEFAULT_SCRAM_ITERATIONS,
  ) {
    this.decoy = createVerifier("decoy-password-never-matches", { iterations });
  }

  private get registry(): SystemRegistry {
    const system = this.manager.systemCatalog();
    if (system.data.system === undefined) {
      throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, "SYSTEM registry is missing.");
    }
    return system.data.system;
  }

  private save(): void {
    this.manager.systemCatalog().save();
  }

  /** 데이터 디렉토리에 SYSTEM 계정이 없으면 만든다. 이미 있으면 아무것도 하지 않는다. */
  ensureSystemAccount(): boolean {
    const registry = this.registry;
    if (registry.users[SYSTEM_USER] !== undefined) return false;
    registry.users[SYSTEM_USER] = {
      name: SYSTEM_USER,
      defaultTablespace: "SYSTEM",
      verifier: createVerifier(INITIAL_SYSTEM_PASSWORD, { iterations: this.iterations }),
      createdAt: new Date().toISOString(),
    };
    registry.groups[SYSTEM_USER] = ["DBA"];
    this.save();
    return true;
  }

  has(name: string): boolean {
    return this.registry.users[name] !== undefined;
  }

  get(name: string): StoredUser | undefined {
    return this.registry.users[name];
  }

  /** 모든 사용자를 이름 순서로 돌려준다. */
  list(): StoredUser[] {
    return Object.values(this.registry.users).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  }

  /** 없는 사용자이면 오류를 던진다. */
  require(name: string, position?: SourcePosition): StoredUser {
    const user = this.registry.users[name];
    if (user === undefined) {
      fail("42704", ERROR_CODES.USER_NOT_FOUND, `User does not exist: "${name}".`, position);
    }
    return user;
  }

  /** CREATE USER. 기본 테이블스페이스는 있는 것이어야 한다. */
  create(name: string, password: string, defaultTablespace: string | null, position?: SourcePosition): void {
    if (PRIVILEGE_GROUP_NAMES.includes(name)) {
      fail("42602", ERROR_CODES.RESERVED_NAME, `A privilege group name cannot be used as a user name: "${name}".`, position);
    }
    if (this.registry.users[name] !== undefined) {
      fail("42710", ERROR_CODES.USER_EXISTS, `User already exists: "${name}".`, position);
    }
    assertPassword(password, position);
    this.assertTablespace(defaultTablespace, position);
    this.registry.users[name] = {
      name,
      defaultTablespace,
      verifier: createVerifier(password, { iterations: this.iterations }),
      createdAt: new Date().toISOString(),
    };
    this.save();
  }

  /** ALTER USER ... IDENTIFIED BY. */
  setPassword(name: string, password: string, position?: SourcePosition): void {
    const user = this.require(name, position);
    assertPassword(password, position);
    user.verifier = createVerifier(password, { iterations: this.iterations });
    this.save();
  }

  /** ALTER USER ... DEFAULT TABLESPACE. */
  setDefaultTablespace(name: string, tablespace: string, position?: SourcePosition): void {
    const user = this.require(name, position);
    this.assertTablespace(tablespace, position);
    user.defaultTablespace = tablespace;
    this.save();
  }

  /**
   * 사용자 기록과 그 사용자가 받은 권한·권한 그룹 기록을 지운다. SYSTEM 은 지울 수 없다.
   * 접속 중인지, 소유한 객체가 있는지는 호출자(exec/accounts.ts)가 먼저 확인한다.
   */
  remove(name: string, position?: SourcePosition): void {
    if (name === SYSTEM_USER) {
      fail("42501", ERROR_CODES.PROTECTED_ACCOUNT, 'User "SYSTEM" cannot be dropped.', position);
    }
    this.require(name, position);
    const registry = this.registry;
    delete registry.users[name];
    delete registry.groups[name];
    registry.privileges = registry.privileges.filter((record) => record.grantee !== name);
    this.save();
  }

  /** 지워진 테이블스페이스를 기본 테이블스페이스로 쓰던 사용자를 "기본 테이블스페이스 없음" 으로 바꾼다. 바뀐 수를 돌려준다. */
  clearMissingDefaultTablespaces(): number {
    let changed = 0;
    for (const user of Object.values(this.registry.users)) {
      if (user.defaultTablespace !== null && !this.manager.has(user.defaultTablespace)) {
        user.defaultTablespace = null;
        changed++;
      }
    }
    if (changed > 0) this.save();
    return changed;
  }

  /**
   * 비밀번호가 맞는지 본다. 사용자가 없으면 가짜 검증 정보로 같은 계산을 하고 false 를 돌려준다.
   * 호출자는 없는 사용자와 틀린 비밀번호를 구분하지 않고 같은 오류를 내야 한다.
   */
  verify(name: string, password: string): boolean {
    const user = this.registry.users[name];
    if (user === undefined) {
      verifyPassword(password, this.decoy);
      return false;
    }
    return verifyPassword(password, user.verifier);
  }

  /** 사용자의 SCRAM 검증 정보이다. 없는 사용자이면 undefined 이다. (통신 계층의 인증이 쓴다) */
  verifierOf(name: string): ScramVerifier | undefined {
    const user = this.registry.users[name];
    return user === undefined ? undefined : { ...user.verifier };
  }

  /** SYSTEM 계정이 초기 암호 그대로인지 본다. */
  isInitialSystemPassword(): boolean {
    const user = this.registry.users[SYSTEM_USER];
    if (user === undefined) return false;
    return verifyPassword(INITIAL_SYSTEM_PASSWORD, user.verifier);
  }

  private assertTablespace(tablespace: string | null, position?: SourcePosition): void {
    if (tablespace !== null && !this.manager.has(tablespace)) {
      fail("3D000", ERROR_CODES.TABLESPACE_NOT_FOUND, `Tablespace does not exist: "${tablespace}".`, position);
    }
  }
}

/** 비밀번호는 비어 있을 수 없다. */
function assertPassword(password: string, position?: SourcePosition): void {
  if (password.length === 0) {
    fail("22023", ERROR_CODES.INVALID_PASSWORD, "Password must not be empty.", position);
  }
}
