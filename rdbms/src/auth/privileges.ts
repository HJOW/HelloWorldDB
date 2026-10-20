/**
 * 권한과 권한 그룹.
 *
 * 담당
 *  - 부여 기록의 저장 : 테이블스페이스 수준, 객체(테이블, 뷰) 수준, 권한 그룹. 각 수준의 기록은 서로 독립이다.
 *  - 권한 판정 : 권한 그룹, 테이블스페이스 수준, 객체 수준, 소유자 자격 중 하나로든 있으면 허용한다.
 *  - 권한 그룹 : CONNECT(원격 접속), OFFICER(SYSTEM 제외 전체), DBA(전부. CONNECT 는 포함하지 않음)
 *  - 뷰 권한 규칙 : 뷰에 권한이 있으면 뷰가 참조하는 테이블의 권한은 검사하지 않는다.
 *    뷰 소유자 본인은 따로 받은 뷰 권한이 없으면 기반 객체에 대한 자기 권한으로 검사한다.
 *  - GRANT, REVOKE 를 실행할 자격 : DBA, 테이블 소유자, (조건을 채운) 뷰 소유자
 *  - 객체가 바뀔 때의 기록 정리 : 이름 변경은 기록이 따라가고, 삭제된 객체와 테이블스페이스의 기록은 지운다.
 *  - 딕셔너리 뷰의 가시성 판정 : 자신이 권한을 가진 객체의 행만 보인다.
 *
 * 문장마다 필요한 권한(예 : CREATE INDEX 는 테이블의 ALTER, TRUNCATE 는 DROP)은 auth/authorizer.ts 가 정한다.
 * 이 모듈은 "이 사용자가 이 객체에 이 권한을 가졌는가" 에만 답한다.
 *
 * WITH GRANT OPTION, 컬럼 단위 권한, PUBLIC, 사용자 정의 권한 그룹은 지원하지 않는다.
 *
 * 관련 사양 : AGENTS.md 상세 5, 6
 * 구현 단계 : 8단계
 */

import { DbError, ERROR_CODES } from "../common/errors.js";
import { objectKey } from "../common/objectKey.js";
import type { SourcePosition } from "../common/errors.js";
import type { ObjectName, Privilege, PrivilegeGroup } from "../sql/ast.js";
import type { SystemRegistry, StoredPrivilege } from "../catalog/catalog.js";
import type { TablespaceManager } from "../catalog/tablespaceManager.js";
import { isDictionaryView } from "../catalog/dictionaryViews.js";
import type { DictionaryAccess } from "../catalog/dictionaryViews.js";
import { SYSTEM_USER } from "./users.js";

/** 테이블스페이스 수준에서 줄 수 있는 권한이다. `ALL` 은 이 전부를 뜻한다. */
export const TABLESPACE_PRIVILEGES: readonly Privilege[] = ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP"];

/** 객체(테이블, 뷰) 수준에서 줄 수 있는 권한이다. CREATE 는 해당 없음이다. */
export const OBJECT_PRIVILEGES: readonly Privilege[] = ["SELECT", "INSERT", "UPDATE", "DELETE", "ALTER", "DROP"];

/** 권한 그룹의 표시 순서이다. */
export const GROUP_ORDER: readonly PrivilegeGroup[] = ["CONNECT", "OFFICER", "DBA"];

/** 테이블스페이스 이름 규칙이 예약하는 SYSTEM 테이블스페이스의 이름이다. */
const SYSTEM_TABLESPACE = "SYSTEM";

/** 카탈로그에 있는 테이블 또는 뷰 하나이다. */
export interface ObjectEntry {
  kind: "table" | "view";
  tablespace: string;
  name: string;
  owner: string;
  /** 뷰가 참조하는 객체이다. 테이블이면 빈 배열이다. */
  dependencies: { tablespace: string; name: string }[];
}

/** 이름이 가리키는 대상이다. */
export type ResolvedObject =
  | { kind: "object"; entry: ObjectEntry }
  /** DUAL 과 딕셔너리 뷰. 모든 사용자가 읽을 수 있고 고칠 수 없다. */
  | { kind: "virtual"; tablespace: string; name: string }
  /** 카탈로그에 없다. 실행 단계가 "없음" 오류를 낸다. */
  | { kind: "missing"; tablespace: string; name: string };

/** SYSTEM 이 가상으로 제공하는 DUAL 과 딕셔너리 뷰인지 본다. */
export function isVirtualName(tablespace: string, name: string): boolean {
  return tablespace === SYSTEM_TABLESPACE && (name === "DUAL" || isDictionaryView(name));
}

/** 카탈로그에서 테이블 또는 뷰를 찾는다. 사용 불가 상태의 테이블스페이스나 없는 객체는 null 이다. */
export function lookupObject(manager: TablespaceManager, tablespace: string, name: string): ObjectEntry | null {
  if (!manager.has(tablespace)) return null;
  let catalog;
  try {
    catalog = manager.requireCatalog(tablespace);
  } catch {
    return null;
  }
  const table = catalog.data.tables[name];
  if (table !== undefined) {
    return { kind: "table", tablespace, name, owner: table.owner, dependencies: [] };
  }
  const view = catalog.data.views[name];
  if (view !== undefined) {
    return { kind: "view", tablespace, name, owner: view.owner, dependencies: view.dependencies };
  }
  return null;
}

/**
 * 문장에 적힌 객체 이름이 가리키는 대상을 정한다. 이름 해석 규칙은 exec/analyzer.ts 의 `bindSource` 와 같다 :
 * 사용자 객체가 먼저이고, 없으면 DUAL 과 딕셔너리 뷰로 푼다.
 * 현재 테이블스페이스가 없는데 테이블스페이스명도 생략했으면(가상 객체가 아닐 때) 3F000 이다.
 */
export function resolveObject(manager: TablespaceManager, name: ObjectName, currentTablespace: string): ResolvedObject {
  if (name.tablespace === null && currentTablespace === "") {
    if (name.name === "DUAL" || isDictionaryView(name.name)) {
      return { kind: "virtual", tablespace: SYSTEM_TABLESPACE, name: name.name };
    }
    throw noCurrentTablespace(name.position);
  }
  const tablespace = name.tablespace ?? currentTablespace;
  const entry = lookupObject(manager, tablespace, name.name);
  if (entry !== null) return { kind: "object", entry };
  if (name.name === "DUAL" || (isDictionaryView(name.name) && (tablespace === SYSTEM_TABLESPACE || name.tablespace === null))) {
    return { kind: "virtual", tablespace: SYSTEM_TABLESPACE, name: name.name };
  }
  return { kind: "missing", tablespace, name: name.name };
}

/** 현재 테이블스페이스가 없을 때의 오류이다. */
export function noCurrentTablespace(position?: SourcePosition): DbError {
  const message = "No current tablespace is selected; qualify the name with a tablespace or run USE first.";
  if (position === undefined) return new DbError("3F000", ERROR_CODES.NO_CURRENT_TABLESPACE, message);
  return new DbError(
    "3F000",
    ERROR_CODES.NO_CURRENT_TABLESPACE,
    `${message.replace(/\.$/, "")} (line ${position.line}, column ${position.column}).`,
    { position },
  );
}

/** 권한이 없을 때의 오류이다. 메시지는 영문으로 적는다. */
export function permissionDenied(what: string, position?: SourcePosition): DbError {
  const message = `Permission denied: ${what}.`;
  if (position === undefined) return new DbError("42501", ERROR_CODES.INSUFFICIENT_PRIVILEGE, message);
  return new DbError(
    "42501",
    ERROR_CODES.INSUFFICIENT_PRIVILEGE,
    `${message.replace(/\.$/, "")} (line ${position.line}, column ${position.column}).`,
    { position },
  );
}

/** 권한 부여와 판정을 맡는다. SYSTEM 카탈로그의 레지스트리를 직접 고치고 바로 저장한다. */
export class AccessControl {
  constructor(private readonly manager: TablespaceManager) {}

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

  // -------------------------------------------------------------------------
  // 권한 그룹
  // -------------------------------------------------------------------------

  /** 명시적으로 부여받은 권한 그룹이다. 표시 순서로 돌려준다. */
  groupsOf(user: string): PrivilegeGroup[] {
    const granted = this.registry.groups[user] ?? [];
    return GROUP_ORDER.filter((group) => granted.includes(group));
  }

  /** DBA 인지 본다. */
  isDba(user: string): boolean {
    return (this.registry.groups[user] ?? []).includes("DBA");
  }

  /** 권한 그룹을 가졌는지 본다. DBA 는 OFFICER 를 포함하고 CONNECT 는 포함하지 않는다. */
  hasGroup(user: string, group: PrivilegeGroup): boolean {
    const granted = this.registry.groups[user] ?? [];
    if (granted.includes(group)) return true;
    return group === "OFFICER" && granted.includes("DBA");
  }

  /** GRANT 권한그룹. 이미 가진 그룹은 그대로 둔다. */
  grantGroups(users: string[], groups: PrivilegeGroup[]): void {
    for (const user of users) {
      const granted = new Set(this.registry.groups[user] ?? []);
      for (const group of groups) granted.add(group);
      this.registry.groups[user] = GROUP_ORDER.filter((group) => granted.has(group));
    }
    this.save();
  }

  /** REVOKE 권한그룹. 가진 적 없는 그룹은 오류 없이 넘어간다. SYSTEM 의 DBA 는 회수할 수 없다. */
  revokeGroups(users: string[], groups: PrivilegeGroup[]): void {
    if (users.includes(SYSTEM_USER) && groups.includes("DBA")) {
      throw new DbError("42501", ERROR_CODES.PROTECTED_ACCOUNT, 'DBA cannot be revoked from user "SYSTEM".');
    }
    for (const user of users) {
      const granted = this.registry.groups[user];
      if (granted === undefined) continue;
      const remaining = granted.filter((group) => !groups.includes(group));
      if (remaining.length === 0) delete this.registry.groups[user];
      else this.registry.groups[user] = remaining;
    }
    this.save();
  }

  // -------------------------------------------------------------------------
  // 권한 부여 기록
  // -------------------------------------------------------------------------

  /** 모든 부여 기록이다. */
  records(): readonly StoredPrivilege[] {
    return this.registry.privileges;
  }

  /** 명시적으로 부여한 권한 기록을 더한다. 같은 기록이 이미 있으면 그대로 둔다. */
  grant(grantees: string[], tablespace: string, object: string | null, privileges: readonly Privilege[]): void {
    const records = this.registry.privileges;
    for (const grantee of grantees) {
      for (const privilege of privileges) {
        const exists = records.some(
          (record) =>
            record.grantee === grantee &&
            record.tablespace === tablespace &&
            record.object === object &&
            record.privilege === privilege,
        );
        if (!exists) records.push({ grantee, tablespace, object, privilege });
      }
    }
    this.save();
  }

  /** 권한 기록을 지운다. 부여된 적 없는 권한은 오류 없이 넘어간다. */
  revoke(grantees: string[], tablespace: string, object: string | null, privileges: readonly Privilege[]): void {
    this.registry.privileges = this.registry.privileges.filter(
      (record) =>
        !(
          grantees.includes(record.grantee) &&
          record.tablespace === tablespace &&
          record.object === object &&
          privileges.includes(record.privilege)
        ),
    );
    this.save();
  }

  // -------------------------------------------------------------------------
  // 판정
  // -------------------------------------------------------------------------

  /**
   * 테이블스페이스 수준의 권한이 있는지 본다.
   * DBA 는 전부, OFFICER 는 SYSTEM 을 제외한 모든 테이블스페이스의 전부, 그 밖은 부여받은 기록으로 판정한다.
   */
  hasTablespacePrivilege(user: string, tablespace: string, privilege: Privilege): boolean {
    if (this.isDba(user)) return true;
    if (this.hasGroup(user, "OFFICER") && tablespace !== SYSTEM_TABLESPACE) return true;
    return this.registry.privileges.some(
      (record) =>
        record.grantee === user && record.tablespace === tablespace && record.object === null && record.privilege === privilege,
    );
  }

  /** 객체 수준의 기록이 있는지 본다. 테이블스페이스 수준과 권한 그룹은 보지 않는다. */
  hasObjectRecord(user: string, tablespace: string, object: string, privilege: Privilege): boolean {
    return this.registry.privileges.some(
      (record) =>
        record.grantee === user &&
        record.tablespace === tablespace &&
        record.object === object &&
        record.privilege === privilege,
    );
  }

  /** 권한 그룹이나 부여 기록으로 받은 권한이 있는지 본다. 소유자 자격은 보지 않는다. */
  hasGranted(user: string, privilege: Privilege, tablespace: string, object: string): boolean {
    return this.hasTablespacePrivilege(user, tablespace, privilege) || this.hasObjectRecord(user, tablespace, object, privilege);
  }

  /**
   * 사용자가 객체(테이블, 뷰)에 대해 권한을 가졌는지 본다.
   *  - 권한 그룹, 테이블스페이스 수준, 객체 수준 중 하나로 받았으면 허용한다.
   *  - 테이블 소유자는 그 테이블의 모든 권한을 가진다.
   *  - 뷰 소유자는 그 뷰의 ALTER, DROP 을 가진다. SELECT, INSERT, UPDATE, DELETE 는 위에서 받은 것이 없을 때에 한해
   *    뷰가 참조하는 모든 객체에 대한 본인의 권한으로 판정한다.
   *  - 뷰를 통한 접근에서는 뷰에 권한이 있으면 기반 테이블의 권한을 보지 않는다. (받은 경우는 위에서 이미 허용했다)
   */
  can(user: string, privilege: Privilege, tablespace: string, object: string, visiting: Set<string> = new Set()): boolean {
    if (isVirtualName(tablespace, object)) return privilege === "SELECT";
    if (this.hasGranted(user, privilege, tablespace, object)) return true;
    const entry = lookupObject(this.manager, tablespace, object);
    if (entry === null || entry.owner !== user) return false;
    if (entry.kind === "table") return true;
    if (privilege === "ALTER" || privilege === "DROP") return true;
    const key = objectKey(tablespace, object);
    if (visiting.has(key)) return false;
    visiting.add(key);
    const allowed = entry.dependencies.every((dependency) =>
      this.can(user, privilege, dependency.tablespace, dependency.name, visiting),
    );
    visiting.delete(key);
    return allowed;
  }

  /** 객체에 대해 SELECT, INSERT, UPDATE, DELETE, ALTER, DROP 중 하나라도 가졌는지 본다. 딕셔너리 뷰의 가시성에 쓴다. */
  canSeeObject(user: string, tablespace: string, object: string): boolean {
    if (this.isDba(user)) return true;
    return OBJECT_PRIVILEGES.some((privilege) => this.can(user, privilege, tablespace, object));
  }

  /** 테이블스페이스에 권한이나 소유 객체가 하나라도 있는지 본다. 딕셔너리 뷰의 가시성에 쓴다. */
  canSeeTablespace(user: string, tablespace: string): boolean {
    if (this.isDba(user)) return true;
    if (this.hasGroup(user, "OFFICER") && tablespace !== SYSTEM_TABLESPACE) return true;
    if (this.registry.privileges.some((record) => record.grantee === user && record.tablespace === tablespace)) return true;
    return this.objectsOwnedBy(user).some((entry) => entry.tablespace === tablespace);
  }

  /** 권한 부여 기록을 볼 수 있는지 본다. DBA, 권한을 받은 사람, 그 객체의 소유자가 볼 수 있다. */
  canSeePrivilege(user: string, record: StoredPrivilege): boolean {
    if (this.isDba(user) || record.grantee === user) return true;
    if (record.object === null) return false;
    return lookupObject(this.manager, record.tablespace, record.object)?.owner === user;
  }

  /** 딕셔너리 뷰가 사용자에게 보여 줄 행을 정하는 판정자를 만든다. */
  dictionaryAccess(user: string): DictionaryAccess {
    return {
      user,
      isDba: this.isDba(user),
      canSeeObject: (tablespace, name) => this.canSeeObject(user, tablespace, name),
      canSeeTablespace: (tablespace) => this.canSeeTablespace(user, tablespace),
      canSeePrivilege: (record) => this.canSeePrivilege(user, record),
    };
  }

  /** GRANT, REVOKE 를 할 수 있는지 본다. 테이블스페이스 수준은 DBA 만 한다. */
  canGrantOnObject(user: string, entry: ObjectEntry): boolean {
    if (this.isDba(user)) return true;
    if (entry.owner !== user) return false;
    if (entry.kind === "table") return true;
    // 뷰 소유자는 뷰가 (간접으로라도) 참조하는 모든 객체의 소유자이기도 해야 한다.
    return this.referencedObjects(entry).every((referenced) => referenced.owner === user);
  }

  /** 뷰가 직접·간접으로 참조하는 테이블과 뷰를 모은다. DUAL 과 딕셔너리 뷰는 빼고, 자기 자신은 넣지 않는다. */
  referencedObjects(view: ObjectEntry): ObjectEntry[] {
    const found = new Map<string, ObjectEntry>();
    const visit = (entry: ObjectEntry): void => {
      for (const dependency of entry.dependencies) {
        if (isVirtualName(dependency.tablespace, dependency.name)) continue;
        const key = objectKey(dependency.tablespace, dependency.name);
        if (found.has(key) || key === objectKey(view.tablespace, view.name)) continue;
        const referenced = lookupObject(this.manager, dependency.tablespace, dependency.name);
        if (referenced === null) continue;
        found.set(key, referenced);
        visit(referenced);
      }
    };
    visit(view);
    return [...found.values()];
  }

  /** 사용자가 소유한 테이블과 뷰를 모든 사용 가능한 테이블스페이스에서 모은다. */
  objectsOwnedBy(user: string): ObjectEntry[] {
    const owned: ObjectEntry[] = [];
    for (const tablespace of this.manager.listNames()) {
      let catalog;
      try {
        catalog = this.manager.requireCatalog(tablespace);
      } catch {
        continue;
      }
      for (const table of Object.values(catalog.data.tables)) {
        if (table.owner === user) owned.push({ kind: "table", tablespace, name: table.name, owner: user, dependencies: [] });
      }
      for (const view of Object.values(catalog.data.views)) {
        if (view.owner === user) {
          owned.push({ kind: "view", tablespace, name: view.name, owner: user, dependencies: view.dependencies });
        }
      }
    }
    return owned;
  }

  // -------------------------------------------------------------------------
  // 기록 정리
  // -------------------------------------------------------------------------

  /** 객체 이름이 바뀌면 그 객체의 권한 기록이 새 이름을 따라가게 한다. */
  renameObject(tablespace: string, oldName: string, newName: string): void {
    let changed = false;
    for (const record of this.registry.privileges) {
      if (record.tablespace === tablespace && record.object === oldName) {
        record.object = newName;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /**
   * 사라진 객체와 테이블스페이스의 권한 기록을 지운다. DDL 이 끝날 때마다 부른다.
   * 사용 불가 상태라 카탈로그를 읽을 수 없는 테이블스페이스의 기록은 있는지 알 수 없으므로 남긴다.
   * 지운 기록 수를 돌려준다.
   */
  pruneStaleRecords(): number {
    const before = this.registry.privileges.length;
    this.registry.privileges = this.registry.privileges.filter((record) => {
      if (!this.manager.has(record.tablespace)) return false;
      if (record.object === null) return true;
      let catalog;
      try {
        catalog = this.manager.requireCatalog(record.tablespace);
      } catch {
        return true;
      }
      return catalog.data.tables[record.object] !== undefined || catalog.data.views[record.object] !== undefined;
    });
    const removed = before - this.registry.privileges.length;
    if (removed > 0) this.save();
    return removed;
  }
}
