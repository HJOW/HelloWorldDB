/**
 * 문장별 권한 검사.
 *
 * 담당
 *  - 문장을 실행하기 전에 구문 트리를 보고, 그 문장을 실행하는 데 필요한 권한을 정해 확인한다.
 *    권한이 모자라면 문장은 실행되지 않고 42501 로 끝난다. (문장이 시작된 뒤에 부분적으로 거부되지 않는다)
 *  - 문장에 적힌 객체만 검사한다. 뷰는 펼치지 않는다. 뷰에 권한이 있으면 뷰가 참조하는 테이블의 권한은 보지 않는다.
 *    (뷰 소유자 본인의 예외는 AccessControl.can 이 처리한다)
 *  - 없는 객체는 여기서 거부하지 않고 지나간다. 실행 단계가 "없음" 오류를 낸다. (IF EXISTS 도 그대로 동작한다)
 *
 * 문장마다 필요한 권한
 *  - SELECT : 문장에 적힌 모든 테이블과 뷰(서브쿼리, 인라인 뷰 포함)에 SELECT.
 *    FOR UPDATE 가 붙으면 그 질의의 FROM 에 적힌 테이블에는 UPDATE 도 필요하다. (행을 잠그기 때문)
 *  - INSERT, UPDATE, DELETE : 대상에 INSERT, UPDATE, DELETE. 대상의 컬럼을 WHERE 나 SET 에서 읽는 데는 SELECT 가 필요 없다.
 *    INSERT ... SELECT 의 원천과 식 안의 서브쿼리가 읽는 다른 객체에는 SELECT 가 필요하다.
 *  - CREATE TABLE : 테이블스페이스의 CREATE. FK 가 참조하는 테이블에 SELECT.
 *  - CREATE VIEW : 테이블스페이스의 CREATE(이미 있는 뷰를 OR REPLACE 하면 그 뷰의 ALTER)와 뷰가 참조하는 모든 객체의 SELECT.
 *  - ALTER TABLE : 테이블의 ALTER. FK 를 더하면 참조되는 테이블의 SELECT.
 *  - CREATE INDEX, DROP INDEX : 테이블의 ALTER.
 *  - DROP TABLE, DROP VIEW, TRUNCATE : 대상의 DROP.
 *  - CREATE TABLESPACE, DROP TABLESPACE, CREATE USER, DROP USER, 다른 사용자의 ALTER USER, 권한 그룹의 GRANT·REVOKE : DBA.
 *    자기 비밀번호를 바꾸는 ALTER USER 는 누구나 한다.
 *  - GRANT, REVOKE (권한) : 테이블스페이스 수준은 DBA. 객체 수준은 DBA, 테이블 소유자, (뷰가 참조하는 모든 객체를 소유한) 뷰 소유자.
 *  - USE, SET, 트랜잭션 문장 : 권한이 필요 없다.
 *
 * CASCADE 로 함께 지워지는 FK 와 의존 뷰는 별도 권한을 보지 않는다. 대상 객체의 DROP 만 본다.
 *
 * 관련 사양 : AGENTS.md 상세 5, 6
 * 구현 단계 : 8단계
 */

import { DbError, ERROR_CODES } from "../common/errors.js";
import type { SourcePosition } from "../common/errors.js";
import type { ForeignKeyReference, ObjectName, Privilege, Query, Statement, TableReference } from "../sql/ast.js";
import type { TablespaceManager } from "../catalog/tablespaceManager.js";
import { AccessControl, lookupObject, noCurrentTablespace, permissionDenied, resolveObject } from "./privileges.js";

/** 권한 검사에 필요한 문맥이다. */
export interface AuthContext {
  readonly access: AccessControl;
  readonly manager: TablespaceManager;
  readonly user: string;
  /** 세션의 현재 테이블스페이스. 없으면 빈 문자열이다. */
  readonly currentTablespace: string;
}

/** 문장을 실행해도 되는지 확인한다. 안 되면 DbError(42501 등)를 던진다. */
export function authorizeStatement(env: AuthContext, stmt: Statement): void {
  switch (stmt.kind) {
    case "Query":
      requireReads(env, stmt);
      return;
    case "Insert":
      requireObject(env, stmt.target, ["INSERT"]);
      if (stmt.source.kind === "Query") requireReads(env, stmt.source.query);
      else if (stmt.source.kind === "Values") requireReads(env, stmt.source.rows);
      return;
    case "Update":
      requireObject(env, stmt.target, ["UPDATE"]);
      requireReads(env, [stmt.assignments, stmt.where]);
      return;
    case "Delete":
      requireObject(env, stmt.target, ["DELETE"]);
      requireReads(env, stmt.where);
      return;
    case "CreateTable": {
      requireTablespacePrivilege(env, stmt.name, "CREATE");
      const selfSpace = stmt.name.tablespace ?? env.currentTablespace;
      for (const column of stmt.columns) {
        if (column.references !== null) requireReference(env, column.references, selfSpace, stmt.name.name);
      }
      for (const constraint of stmt.constraints) {
        if (constraint.kind === "ForeignKey") requireReference(env, constraint.reference, selfSpace, stmt.name.name);
      }
      return;
    }
    case "AlterTable": {
      requireObject(env, stmt.name, ["ALTER"]);
      if (stmt.action.kind === "AddConstraint" && stmt.action.constraint.kind === "ForeignKey") {
        const selfSpace = stmt.name.tablespace ?? env.currentTablespace;
        requireReference(env, stmt.action.constraint.reference, selfSpace, stmt.name.name);
      }
      return;
    }
    case "DropTable":
    case "DropView":
    case "TruncateTable":
      requireObject(env, stmt.name, ["DROP"]);
      return;
    case "CreateView": {
      const tablespace = requireTablespaceName(env, stmt.name);
      const existing = lookupObject(env.manager, tablespace, stmt.name.name);
      if (existing !== null && existing.kind === "view" && stmt.orReplace) {
        requireObject(env, stmt.name, ["ALTER"]);
      } else {
        requireTablespacePrivilege(env, stmt.name, "CREATE");
      }
      requireReads(env, stmt.query);
      return;
    }
    case "CreateIndex":
      requireObject(env, stmt.table, ["ALTER"]);
      return;
    case "DropIndex": {
      const tablespace = stmt.name.tablespace ?? env.currentTablespace;
      if (tablespace === "") throw noCurrentTablespace(stmt.name.position);
      if (!env.manager.has(tablespace)) return;
      let catalog;
      try {
        catalog = env.manager.requireCatalog(tablespace);
      } catch {
        return;
      }
      const index = catalog.data.indexes[stmt.name.name];
      if (index === undefined) return;
      requireObject(env, { tablespace, name: index.table, position: stmt.name.position }, ["ALTER"]);
      return;
    }
    case "CreateTablespace":
    case "DropTablespace":
      requireDba(env, stmt.kind === "CreateTablespace" ? "CREATE TABLESPACE" : "DROP TABLESPACE");
      return;
    case "CreateUser":
      requireDba(env, "CREATE USER");
      return;
    case "DropUser":
      requireDba(env, "DROP USER");
      return;
    case "AlterUser":
      // 자기 비밀번호는 누구나 바꾼다. 그 밖의 변경은 DBA 만 한다.
      if (stmt.name === env.user && stmt.password !== null && stmt.defaultTablespace === null) return;
      requireDba(env, stmt.name === env.user ? "ALTER USER (default tablespace)" : "ALTER USER");
      return;
    case "GrantGroup":
    case "RevokeGroup":
      requireDba(env, stmt.kind === "GrantGroup" ? "GRANT privilege group" : "REVOKE privilege group");
      return;
    case "Grant":
    case "Revoke": {
      const verb = stmt.kind === "Grant" ? "GRANT" : "REVOKE";
      if (stmt.target.kind === "Tablespace") {
        // 테이블스페이스 수준 권한은 DBA 만 부여하고 회수한다.
        if (!env.access.isDba(env.user)) {
          throw permissionDenied(`${verb} on tablespace "${stmt.target.name}" requires the DBA privilege group`, stmt.target.position);
        }
        return;
      }
      const resolved = resolveObject(env.manager, stmt.target.name, env.currentTablespace);
      if (resolved.kind !== "object") return; // 없는 객체와 가상 객체는 실행 단계가 오류로 알린다.
      if (!env.access.canGrantOnObject(env.user, resolved.entry)) {
        throw permissionDenied(
          `${verb} on "${resolved.entry.tablespace}.${resolved.entry.name}" requires the DBA privilege group or ownership`,
          stmt.target.name.position,
        );
      }
      return;
    }
    case "Use":
    case "SetTimeZone":
    case "SetAutocommit":
    case "SetTransaction":
    case "Begin":
    case "Commit":
    case "Rollback":
    case "Savepoint":
    case "ReleaseSavepoint":
      return;
    default: {
      const exhaustive: never = stmt;
      throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, `Unsupported statement: ${JSON.stringify(exhaustive)}.`);
    }
  }
}

// ---------------------------------------------------------------------------
// 확인 도우미
// ---------------------------------------------------------------------------

function requireDba(env: AuthContext, what: string): void {
  if (!env.access.isDba(env.user)) {
    throw permissionDenied(`${what} requires the DBA privilege group`);
  }
}

/** 객체 이름의 테이블스페이스를 정한다. 생략했는데 현재 테이블스페이스도 없으면 3F000 이다. */
function requireTablespaceName(env: AuthContext, name: ObjectName): string {
  const tablespace = name.tablespace ?? env.currentTablespace;
  if (tablespace === "") throw noCurrentTablespace(name.position);
  return tablespace;
}

/** 테이블스페이스 수준 권한(CREATE)을 확인한다. 없는 테이블스페이스는 실행 단계가 오류로 알린다. */
function requireTablespacePrivilege(env: AuthContext, name: ObjectName, privilege: Privilege): void {
  const tablespace = requireTablespaceName(env, name);
  if (!env.manager.has(tablespace)) return;
  if (!env.access.hasTablespacePrivilege(env.user, tablespace, privilege)) {
    throw permissionDenied(`${privilege} on tablespace "${tablespace}"`, name.position);
  }
}

/** 객체(테이블 또는 뷰) 하나에 대한 권한을 확인한다. 없는 객체와 가상 객체는 지나간다. */
function requireObject(
  env: AuthContext,
  name: ObjectName,
  privileges: readonly Privilege[],
  position: SourcePosition = name.position,
): void {
  const resolved = resolveObject(env.manager, name, env.currentTablespace);
  if (resolved.kind !== "object") return;
  const { tablespace, name: objectName } = resolved.entry;
  for (const privilege of privileges) {
    if (!env.access.can(env.user, privilege, tablespace, objectName)) {
      throw permissionDenied(`${privilege} on "${tablespace}.${objectName}"`, position);
    }
  }
}

/** FK 가 참조하는 테이블에 SELECT 가 있는지 본다. 만들고 있는 테이블 자신을 참조하는 것은 검사하지 않는다. */
function requireReference(env: AuthContext, reference: ForeignKeyReference, selfSpace: string, selfName: string): void {
  const tablespace = reference.table.tablespace ?? selfSpace;
  if (tablespace === selfSpace && reference.table.name === selfName) return;
  requireObject(env, reference.table, ["SELECT"]);
}

// ---------------------------------------------------------------------------
// 읽는 객체 모으기
// ---------------------------------------------------------------------------

/**
 * 구문 트리 안에서 읽는 테이블과 뷰(`kind: "Table"` 인 참조)를 모두 찾아 SELECT 를 확인한다.
 * 서브쿼리와 인라인 뷰 안까지 내려간다. FOR UPDATE 가 붙은 질의의 FROM 에 적힌 테이블은 UPDATE 도 확인한다.
 */
function requireReads(env: AuthContext, root: unknown): void {
  const lockedTables = new Set<object>();
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    const node = current as { kind?: unknown; [key: string]: unknown };
    if (node.kind === "Query" && node["forUpdate"] === true) {
      markFromTables((node as unknown as Query).body, lockedTables);
    }
    if (node.kind === "Table") {
      const reference = node as unknown as { name: ObjectName };
      requireObject(env, reference.name, lockedTables.has(node) ? ["SELECT", "UPDATE"] : ["SELECT"]);
      continue;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "position" || child === null || typeof child !== "object") continue;
      stack.push(child);
    }
  }
}

/** 질의 몸통의 FROM 에 직접 적힌 테이블 참조를 표시한다. 인라인 뷰 안쪽은 표시하지 않는다. */
function markFromTables(body: Query["body"], marked: Set<object>): void {
  if (body.kind === "Query") {
    markFromTables(body.body, marked);
    return;
  }
  if (body.kind !== "Select") return;
  const visit = (reference: TableReference): void => {
    if (reference.kind === "Table") marked.add(reference);
    else if (reference.kind === "Join") {
      visit(reference.left);
      visit(reference.right);
    }
  };
  for (const reference of body.from) visit(reference);
}
