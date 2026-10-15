/**
 * 사용자와 권한 문장의 실행.
 *
 * 담당
 *  - CREATE USER, ALTER USER, DROP USER [CASCADE]
 *  - GRANT, REVOKE : 테이블스페이스 수준과 객체(테이블, 뷰) 수준의 권한, 권한 그룹
 *
 * 누가 실행할 수 있는지는 auth/authorizer.ts 가 문장을 실행하기 전에 이미 확인했다.
 * 여기서는 대상이 올바른지(사용자와 객체가 있는지, 그 수준에 줄 수 있는 권한인지)와 실제 변경을 맡는다.
 * 이 문장들은 DDL 과 같이 실행 전후에 자동 커밋되고 롤백할 수 없다. (session/session.ts)
 *
 * DROP USER 규칙 : 접속 중인 사용자는 지울 수 없다. 소유한 객체가 있으면 실패하며 CASCADE 면 함께 지운다.
 * 지운 사용자가 받은 권한·권한 그룹 기록도 지운다. SYSTEM 은 지울 수 없다.
 *
 * 관련 사양 : AGENTS.md 상세 4, 5, 6
 * 구현 단계 : 8단계
 */

import { DbError, ERROR_CODES } from "../common/errors.js";
import type { SourcePosition } from "../common/errors.js";
import type {
  AlterUserStatement,
  CreateUserStatement,
  DropUserStatement,
  Privilege,
  PrivilegeGroupStatement,
  PrivilegeStatement,
} from "../sql/ast.js";
import type { TablespaceManager } from "../catalog/tablespaceManager.js";
import { OBJECT_PRIVILEGES, TABLESPACE_PRIVILEGES, resolveObject } from "../auth/privileges.js";
import type { AccessControl } from "../auth/privileges.js";
import { SYSTEM_USER } from "../auth/users.js";
import type { UserStore } from "../auth/users.js";
import { executeDropTable, executeDropView } from "./ddl.js";

/** 사용자·권한 문장이 쓰는 문맥이다. */
export interface AccountsContext {
  readonly manager: TablespaceManager;
  readonly users: UserStore;
  readonly access: AccessControl;
  /** 지금 접속 중인 세션의 사용자 이름들이다. */
  readonly connectedUsers: () => readonly string[];
  readonly currentTablespace: string;
}

function fail(sqlState: string, code: number, message: string, position?: SourcePosition): never {
  if (position !== undefined) {
    const text = message.replace(/\.$/, "");
    throw new DbError(sqlState, code, `${text} (line ${position.line}, column ${position.column}).`, { position });
  }
  throw new DbError(sqlState, code, message);
}

/** 위치를 알 수 없는 곳에 쓰는 자리 표시용 위치이다. */
const NO_POSITION: SourcePosition = { offset: 0, line: 1, column: 1 };

// ---------------------------------------------------------------------------
// 사용자
// ---------------------------------------------------------------------------

export function executeCreateUser(ctx: AccountsContext, stmt: CreateUserStatement): string {
  ctx.users.create(stmt.name, stmt.password, stmt.defaultTablespace);
  return `User "${stmt.name}" created.`;
}

export function executeAlterUser(ctx: AccountsContext, stmt: AlterUserStatement): string {
  ctx.users.require(stmt.name);
  if (stmt.defaultTablespace !== null && !ctx.manager.has(stmt.defaultTablespace)) {
    fail("3D000", ERROR_CODES.TABLESPACE_NOT_FOUND, `Tablespace does not exist: "${stmt.defaultTablespace}".`);
  }
  if (stmt.password !== null) ctx.users.setPassword(stmt.name, stmt.password);
  if (stmt.defaultTablespace !== null) ctx.users.setDefaultTablespace(stmt.name, stmt.defaultTablespace);
  return `User "${stmt.name}" altered.`;
}

export function executeDropUser(ctx: AccountsContext, stmt: DropUserStatement): string {
  ctx.users.require(stmt.name);
  if (stmt.name === SYSTEM_USER) {
    fail("42501", ERROR_CODES.PROTECTED_ACCOUNT, 'User "SYSTEM" cannot be dropped.');
  }
  if (ctx.connectedUsers().includes(stmt.name)) {
    fail("55006", ERROR_CODES.OBJECT_IN_USE, `User "${stmt.name}" is connected and cannot be dropped.`);
  }
  const owned = ctx.access.objectsOwnedBy(stmt.name);
  if (owned.length > 0 && !stmt.cascade) {
    const first = owned[0];
    fail(
      "55006",
      ERROR_CODES.OBJECT_IN_USE,
      `User "${stmt.name}" owns ${String(owned.length)} object(s), such as "${first?.tablespace}.${first?.name}"; use CASCADE to drop them too.`,
    );
  }
  if (stmt.cascade) {
    // 뷰를 먼저 지우고 테이블을 지운다. CASCADE 로 함께 지워진 객체는 건너뛴다.
    for (const entry of owned.filter((candidate) => candidate.kind === "view")) {
      executeDropView(ctx.manager, entry.tablespace, {
        kind: "DropView",
        name: { tablespace: entry.tablespace, name: entry.name, position: NO_POSITION },
        ifExists: true,
        behavior: "CASCADE",
      });
    }
    for (const entry of owned.filter((candidate) => candidate.kind === "table")) {
      executeDropTable(ctx.manager, entry.tablespace, {
        kind: "DropTable",
        name: { tablespace: entry.tablespace, name: entry.name, position: NO_POSITION },
        ifExists: true,
        behavior: "CASCADE",
      });
    }
  }
  ctx.users.remove(stmt.name);
  return `User "${stmt.name}" dropped.`;
}

// ---------------------------------------------------------------------------
// 권한
// ---------------------------------------------------------------------------

/** 권한을 받거나 회수당할 사용자가 모두 있는지 확인한다. */
function requireUsers(ctx: AccountsContext, names: string[]): void {
  for (const name of names) ctx.users.require(name);
}

export function executeGrantOrRevoke(ctx: AccountsContext, stmt: PrivilegeStatement): string {
  requireUsers(ctx, stmt.users);
  const granting = stmt.kind === "Grant";
  if (stmt.target.kind === "Tablespace") {
    const tablespace = stmt.target.name;
    if (!ctx.manager.has(tablespace)) {
      fail("3D000", ERROR_CODES.TABLESPACE_NOT_FOUND, `Tablespace does not exist: "${tablespace}".`, stmt.target.position);
    }
    const privileges: readonly Privilege[] = stmt.privileges === "ALL" ? TABLESPACE_PRIVILEGES : unique(stmt.privileges);
    if (granting) ctx.access.grant(stmt.users, tablespace, null, privileges);
    else ctx.access.revoke(stmt.users, tablespace, null, privileges);
    return granting ? "Privileges granted." : "Privileges revoked.";
  }

  const { name, objectType } = stmt.target;
  const resolved = resolveObject(ctx.manager, name, ctx.currentTablespace);
  if (resolved.kind === "missing") {
    if (!ctx.manager.has(resolved.tablespace)) {
      fail("3D000", ERROR_CODES.TABLESPACE_NOT_FOUND, `Tablespace does not exist: "${resolved.tablespace}".`, name.position);
    }
    fail("42P01", ERROR_CODES.TABLE_NOT_FOUND, `Object does not exist: "${resolved.tablespace}.${resolved.name}".`, name.position);
  }
  if (resolved.kind === "virtual") {
    fail("42809", ERROR_CODES.READ_ONLY_OBJECT, `"${resolved.name}" is a read-only dictionary object; privileges cannot be managed.`, name.position);
  }
  const entry = resolved.entry;
  if (objectType === "TABLE" && entry.kind !== "table") {
    fail("42P01", ERROR_CODES.TABLE_NOT_FOUND, `"${entry.name}" is a view; use ON VIEW.`, name.position);
  }
  if (objectType === "VIEW" && entry.kind !== "view") {
    fail("42P01", ERROR_CODES.VIEW_NOT_FOUND, `"${entry.name}" is a table; use ON TABLE.`, name.position);
  }
  let privileges: readonly Privilege[];
  if (stmt.privileges === "ALL") {
    privileges = OBJECT_PRIVILEGES;
  } else {
    privileges = unique(stmt.privileges);
    if (privileges.includes("CREATE")) {
      fail("0LP01", ERROR_CODES.INVALID_GRANT_OPERATION, "CREATE can only be granted on a tablespace.", name.position);
    }
  }
  if (granting) ctx.access.grant(stmt.users, entry.tablespace, entry.name, privileges);
  else ctx.access.revoke(stmt.users, entry.tablespace, entry.name, privileges);
  return granting ? "Privileges granted." : "Privileges revoked.";
}

export function executeGrantOrRevokeGroup(ctx: AccountsContext, stmt: PrivilegeGroupStatement): string {
  requireUsers(ctx, stmt.users);
  if (stmt.kind === "GrantGroup") {
    ctx.access.grantGroups(stmt.users, stmt.groups);
    return "Privilege groups granted.";
  }
  ctx.access.revokeGroups(stmt.users, stmt.groups);
  return "Privilege groups revoked.";
}

function unique(privileges: readonly Privilege[]): Privilege[] {
  return [...new Set(privileges)];
}
