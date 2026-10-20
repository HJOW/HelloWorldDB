/**
 * 딕셔너리 뷰.
 *
 * 담당
 *  - 드라이버와 DB툴이 메타데이터를 조회하는 뷰를 SYSTEM 테이블스페이스에 제공한다 :
 *    SYS_TABLESPACES, SYS_USERS, SYS_TABLES, SYS_COLUMNS, SYS_VIEWS, SYS_INDEXES, SYS_INDEX_COLUMNS,
 *    SYS_CONSTRAINTS, SYS_CONSTRAINT_COLUMNS, SYS_PRIVILEGES, SYS_GROUP_GRANTS, SYS_SESSIONS
 *  - 읽기 전용이다. DDL 이나 DML 로 직접 고칠 수 없다.
 *  - 모든 사용자가 조회할 수 있되, 자신이 권한을 가진 객체의 행만 보인다. DBA 는 전부 본다. (8단계)
 *    SYS_USERS, SYS_PRIVILEGES, SYS_GROUP_GRANTS, SYS_SESSIONS 는 DBA 가 아니면 자기 것만 보인다.
 *  - 비밀번호 검증 정보는 누구에게도 보여 주지 않는다.
 *  - `SYS_` 로 시작하는 이름과 `DUAL` 은 SYSTEM 테이블스페이스에서 예약한다.
 *
 * 관련 사양 : AGENTS.md 상세 3
 * 구현 단계 : 5단계(뷰 제공), 7단계(SYS_SESSIONS), 8단계(권한에 따른 행 가시성), 9단계(SYS_SESSIONS 에 CHANNEL, CLIENT_ADDRESS)
 */

import { DbError, ERROR_CODES } from "../common/errors.js";
import { formatDataType, varcharType, integerType } from "../types/dataType.js";
import type { DataType } from "../types/dataType.js";
import type { SqlValue } from "../types/value.js";
import type { SessionInfo } from "../session/sessionManager.js";
import type { StoredPrivilege } from "./catalog.js";
import type { TablespaceManager } from "./tablespaceManager.js";

/** 딕셔너리 뷰의 이름 목록이다. */
export const DICTIONARY_VIEW_NAMES: readonly string[] = [
  "SYS_TABLESPACES",
  "SYS_USERS",
  "SYS_TABLES",
  "SYS_COLUMNS",
  "SYS_VIEWS",
  "SYS_INDEXES",
  "SYS_INDEX_COLUMNS",
  "SYS_CONSTRAINTS",
  "SYS_CONSTRAINT_COLUMNS",
  "SYS_PRIVILEGES",
  "SYS_GROUP_GRANTS",
  "SYS_SESSIONS",
];

/** 딕셔너리 뷰의 컬럼 정의이다. */
export interface DictionaryColumn {
  name: string;
  dataType: DataType;
}

function varchar(length: number): DataType {
  return varcharType(length);
}

function integer(): DataType {
  return integerType(32);
}

/** 뷰마다 컬럼 목록을 돌려준다. 없으면 오류이다. */
export function getDictionaryColumns(viewName: string): DictionaryColumn[] {
  switch (viewName) {
    case "SYS_TABLESPACES":
      return [
        { name: "TABLESPACE_NAME", dataType: varchar(128) },
        { name: "DATAFILE", dataType: varchar(1024) },
        { name: "FORMAT_VERSION", dataType: integer() },
        { name: "CHARACTER_SET", dataType: varchar(16) },
        { name: "STATUS", dataType: varchar(16) },
      ];
    case "SYS_USERS":
      return [
        { name: "USER_NAME", dataType: varchar(128) },
        { name: "DEFAULT_TABLESPACE", dataType: varchar(128) },
      ];
    case "SYS_TABLES":
      return [
        { name: "TABLESPACE_NAME", dataType: varchar(128) },
        { name: "TABLE_NAME", dataType: varchar(128) },
        { name: "OWNER", dataType: varchar(128) },
        { name: "COLUMN_COUNT", dataType: integer() },
      ];
    case "SYS_COLUMNS":
      return [
        { name: "TABLESPACE_NAME", dataType: varchar(128) },
        { name: "TABLE_NAME", dataType: varchar(128) },
        { name: "COLUMN_NAME", dataType: varchar(128) },
        { name: "ORDINAL_POSITION", dataType: integer() },
        { name: "DATA_TYPE", dataType: varchar(256) },
        { name: "IS_NULLABLE", dataType: varchar(3) },
        { name: "COLUMN_DEFAULT", dataType: varchar(1024) },
      ];
    case "SYS_VIEWS":
      return [
        { name: "TABLESPACE_NAME", dataType: varchar(128) },
        { name: "VIEW_NAME", dataType: varchar(128) },
        { name: "OWNER", dataType: varchar(128) },
        { name: "DEFINITION", dataType: varchar(65535) },
      ];
    case "SYS_INDEXES":
      return [
        { name: "TABLESPACE_NAME", dataType: varchar(128) },
        { name: "INDEX_NAME", dataType: varchar(128) },
        { name: "TABLE_NAME", dataType: varchar(128) },
        { name: "IS_UNIQUE", dataType: varchar(3) },
      ];
    case "SYS_INDEX_COLUMNS":
      return [
        { name: "TABLESPACE_NAME", dataType: varchar(128) },
        { name: "INDEX_NAME", dataType: varchar(128) },
        { name: "ORDINAL_POSITION", dataType: integer() },
        { name: "COLUMN_NAME", dataType: varchar(128) },
        { name: "IS_DESCENDING", dataType: varchar(3) },
      ];
    case "SYS_CONSTRAINTS":
      return [
        { name: "TABLESPACE_NAME", dataType: varchar(128) },
        { name: "CONSTRAINT_NAME", dataType: varchar(128) },
        { name: "TABLE_NAME", dataType: varchar(128) },
        { name: "CONSTRAINT_TYPE", dataType: varchar(16) },
        { name: "REFERENCED_TABLE", dataType: varchar(128) },
        { name: "DELETE_RULE", dataType: varchar(16) },
        { name: "UPDATE_RULE", dataType: varchar(16) },
      ];
    case "SYS_CONSTRAINT_COLUMNS":
      return [
        { name: "TABLESPACE_NAME", dataType: varchar(128) },
        { name: "CONSTRAINT_NAME", dataType: varchar(128) },
        { name: "ORDINAL_POSITION", dataType: integer() },
        { name: "COLUMN_NAME", dataType: varchar(128) },
        { name: "REFERENCED_COLUMN", dataType: varchar(128) },
      ];
    case "SYS_PRIVILEGES":
      return [
        { name: "GRANTEE", dataType: varchar(128) },
        { name: "TABLESPACE_NAME", dataType: varchar(128) },
        { name: "OBJECT_NAME", dataType: varchar(128) },
        { name: "PRIVILEGE", dataType: varchar(16) },
      ];
    case "SYS_GROUP_GRANTS":
      return [
        { name: "GRANTEE", dataType: varchar(128) },
        { name: "GROUP_NAME", dataType: varchar(128) },
      ];
    case "SYS_SESSIONS":
      return [
        { name: "SESSION_ID", dataType: integer() },
        { name: "USER_NAME", dataType: varchar(128) },
        { name: "TABLESPACE_NAME", dataType: varchar(128) },
        { name: "AUTOCOMMIT", dataType: varchar(3) },
        { name: "IN_TRANSACTION", dataType: varchar(3) },
        // 9단계에서 끝에 더했다. 기존 열의 순서는 바꾸지 않는다.
        { name: "CHANNEL", dataType: varchar(5) },
        { name: "CLIENT_ADDRESS", dataType: varchar(64) },
      ];
    default:
      throw new DbError("42P01", ERROR_CODES.TABLE_NOT_FOUND, `Dictionary view does not exist: "${viewName}".`);
  }
}

/** 딕셔너리 뷰인지 본다. */
export function isDictionaryView(name: string): boolean {
  return (DICTIONARY_VIEW_NAMES as readonly string[]).includes(name);
}

/** 조회하는 사용자에게 어떤 행이 보이는지 정하는 판정자이다. 없으면 모든 행이 보인다(내부 사용). */
export interface DictionaryAccess {
  readonly user: string;
  /** DBA 이면 모든 행이 보인다. */
  readonly isDba: boolean;
  /** 테이블 또는 뷰에 대한 권한이 하나라도 있는지(소유 포함). */
  canSeeObject(tablespace: string, name: string): boolean;
  /** 테이블스페이스에 대한 권한이나 소유 객체가 있는지. */
  canSeeTablespace(tablespace: string): boolean;
  /** 권한 부여 기록을 볼 수 있는지. 받은 사람이거나 그 객체의 소유자이다. */
  canSeePrivilege(record: StoredPrivilege): boolean;
}

/** 테이블스페이스 카탈로그 밖에서 오는 딕셔너리 뷰의 원천이다. */
export interface DictionarySources {
  /** 실행기에서 행 없이 분석한 뷰의 컬럼이다. 카탈로그가 실행기를 import하지 않도록 주입한다. */
  viewColumns?: (tablespace: string, view: string) => readonly { name: string; dataType: DataType; nullable: "YES" | "NO" | "UNKNOWN" }[];
  /** SYS_SESSIONS 에 보일 세션 현황이다. */
  sessions?: readonly SessionInfo[];
  /** SYS_USERS 에 보일 사용자이다. 비밀번호 검증 정보는 넘기지 않는다. */
  users?: readonly { name: string; defaultTablespace: string | null }[];
  /** SYS_PRIVILEGES 에 보일 권한 부여 기록이다. */
  privileges?: readonly StoredPrivilege[];
  /** SYS_GROUP_GRANTS 에 보일 권한 그룹 부여 내역이다. 사용자 이름 → 그룹들. */
  groups?: Readonly<Record<string, readonly string[]>>;
  /** 행의 가시성을 정하는 판정자이다. */
  access?: DictionaryAccess;
}

/**
 * 딕셔너리 뷰의 행을 만든다.
 * `sources.access` 가 있으면 그 사용자가 권한을 가진 객체의 행만 만든다. (DBA 는 전부)
 */
export function getDictionaryRows(
  manager: TablespaceManager,
  viewName: string,
  sources: DictionarySources = {},
): SqlValue[][] {
  const access = sources.access;
  const seesAll = access === undefined || access.isDba;
  const objectVisible = (tablespace: string, name: string): boolean =>
    seesAll || (access as DictionaryAccess).canSeeObject(tablespace, name);
  switch (viewName) {
    case "SYS_TABLESPACES": {
      return manager
        .listStatus()
        .filter((status) => seesAll || (access as DictionaryAccess).canSeeTablespace(status.name))
        .map((status) => [
        status.name,
        status.dataFile,
        BigInt(status.formatVersion),
        status.characterSet,
        status.available ? "AVAILABLE" : "UNAVAILABLE",
      ]);
    }
    case "SYS_USERS": {
      return (sources.users ?? [])
        .filter((user) => seesAll || user.name === (access as DictionaryAccess).user)
        .map((user) => [user.name, user.defaultTablespace]);
    }
    case "SYS_TABLES": {
      const rows: SqlValue[][] = [];
      for (const name of manager.listNames()) {
        let catalog;
        try {
          catalog = manager.requireCatalog(name);
        } catch {
          continue;
        }
        for (const table of Object.values(catalog.data.tables)) {
          if (!objectVisible(name, table.name)) continue;
          rows.push([name, table.name, table.owner, BigInt(table.columns.length)]);
        }
      }
      rows.sort(compareRows);
      return rows;
    }
    case "SYS_COLUMNS": {
      const rows: SqlValue[][] = [];
      for (const name of manager.listNames()) {
        let catalog;
        try {
          catalog = manager.requireCatalog(name);
        } catch {
          continue;
        }
        for (const table of Object.values(catalog.data.tables)) {
          if (!objectVisible(name, table.name)) continue;
          table.columns.forEach((column, index) => {
            rows.push([
              name,
              table.name,
              column.name,
              BigInt(index + 1),
              formatDataType(column.dataType),
              column.notNull ? "NO" : "YES",
              column.defaultText,
            ]);
          });
        }
        for (const view of Object.values(catalog.data.views)) {
          if (!objectVisible(name, view.name)) continue;
          for (const [index, column] of (sources.viewColumns?.(name, view.name) ?? []).entries()) {
            rows.push([name, view.name, column.name, BigInt(index + 1), formatDataType(column.dataType), column.nullable, null]);
          }
        }
      }
      rows.sort(compareRows);
      return rows;
    }
    case "SYS_VIEWS": {
      const rows: SqlValue[][] = [];
      for (const name of manager.listNames()) {
        let catalog;
        try {
          catalog = manager.requireCatalog(name);
        } catch {
          continue;
        }
        for (const view of Object.values(catalog.data.views)) {
          if (!objectVisible(name, view.name)) continue;
          rows.push([name, view.name, view.owner, view.queryText]);
        }
      }
      rows.sort(compareRows);
      return rows;
    }
    case "SYS_INDEXES": {
      const rows: SqlValue[][] = [];
      for (const name of manager.listNames()) {
        let catalog;
        try {
          catalog = manager.requireCatalog(name);
        } catch {
          continue;
        }
        for (const index of Object.values(catalog.data.indexes)) {
          if (!objectVisible(name, index.table)) continue;
          rows.push([name, index.name, index.table, index.unique ? "YES" : "NO"]);
        }
        // PK 유일 인덱스는 제약조건 쪽에 있으므로 함께 보여 준다.
        for (const constraint of Object.values(catalog.data.constraints)) {
          if (constraint.kind === "PRIMARY KEY" && objectVisible(name, constraint.table)) {
            rows.push([name, constraint.name, constraint.table, "YES"]);
          }
        }
      }
      rows.sort(compareRows);
      return rows;
    }
    case "SYS_INDEX_COLUMNS": {
      const rows: SqlValue[][] = [];
      for (const name of manager.listNames()) {
        let catalog;
        try {
          catalog = manager.requireCatalog(name);
        } catch {
          continue;
        }
        for (const index of Object.values(catalog.data.indexes)) {
          if (!objectVisible(name, index.table)) continue;
          index.columns.forEach((column, position) => {
            rows.push([name, index.name, BigInt(position + 1), column.name, column.descending ? "YES" : "NO"]);
          });
        }
        for (const constraint of Object.values(catalog.data.constraints)) {
          if (constraint.kind === "PRIMARY KEY" && objectVisible(name, constraint.table)) {
            constraint.columns.forEach((columnName, position) => {
              rows.push([name, constraint.name, BigInt(position + 1), columnName, "NO"]);
            });
          }
        }
      }
      rows.sort(compareRows);
      return rows;
    }
    case "SYS_CONSTRAINTS": {
      const rows: SqlValue[][] = [];
      for (const name of manager.listNames()) {
        let catalog;
        try {
          catalog = manager.requireCatalog(name);
        } catch {
          continue;
        }
        for (const constraint of Object.values(catalog.data.constraints)) {
          if (!objectVisible(name, constraint.table)) continue;
          rows.push([
            name,
            constraint.name,
            constraint.table,
            constraint.kind,
            constraint.refTable,
            constraint.onDelete,
            constraint.onUpdate,
          ]);
        }
      }
      rows.sort(compareRows);
      return rows;
    }
    case "SYS_CONSTRAINT_COLUMNS": {
      const rows: SqlValue[][] = [];
      for (const name of manager.listNames()) {
        let catalog;
        try {
          catalog = manager.requireCatalog(name);
        } catch {
          continue;
        }
        for (const constraint of Object.values(catalog.data.constraints)) {
          if (!objectVisible(name, constraint.table)) continue;
          constraint.columns.forEach((columnName, position) => {
            const ref = constraint.refColumns?.[position] ?? null;
            rows.push([name, constraint.name, BigInt(position + 1), columnName, ref]);
          });
        }
      }
      rows.sort(compareRows);
      return rows;
    }
    case "SYS_SESSIONS": {
      // 현재 접속 중인 세션이다. DBA 가 아니면 자기 세션만 보인다. 현재 테이블스페이스가 없으면 NULL 이다.
      return (sources.sessions ?? [])
        .filter((session) => seesAll || session.user === (access as DictionaryAccess).user)
        .map((session) => [
          BigInt(session.id),
          session.user,
          session.tablespace === "" ? null : session.tablespace,
          session.autocommit ? "YES" : "NO",
          session.inTransaction ? "YES" : "NO",
          session.channel.toUpperCase(),
          session.clientAddress,
        ]);
    }
    case "SYS_PRIVILEGES": {
      // 테이블스페이스 수준 기록은 OBJECT_NAME 이 NULL 이다.
      const rows = (sources.privileges ?? [])
        .filter((record) => seesAll || (access as DictionaryAccess).canSeePrivilege(record))
        .map((record): SqlValue[] => [record.grantee, record.tablespace, record.object, record.privilege]);
      rows.sort(compareRows);
      return rows;
    }
    case "SYS_GROUP_GRANTS": {
      const rows: SqlValue[][] = [];
      for (const [grantee, groups] of Object.entries(sources.groups ?? {})) {
        if (!seesAll && grantee !== (access as DictionaryAccess).user) continue;
        for (const group of groups) rows.push([grantee, group]);
      }
      rows.sort(compareRows);
      return rows;
    }
    default:
      throw new DbError("42P01", ERROR_CODES.TABLE_NOT_FOUND, `Dictionary view does not exist: "${viewName}".`);
  }
}

function textOf(value: SqlValue): string {
  if (value === null) return "";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  return String(value);
}

function compareRows(left: SqlValue[], right: SqlValue[]): number {
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const a = textOf(left[i] as SqlValue);
    const b = textOf(right[i] as SqlValue);
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return left.length - right.length;
}
