/**
 * 딕셔너리 뷰.
 *
 * 담당
 *  - 드라이버와 DB툴이 메타데이터를 조회하는 뷰를 SYSTEM 테이블스페이스에 제공한다 :
 *    SYS_TABLESPACES, SYS_USERS, SYS_TABLES, SYS_COLUMNS, SYS_VIEWS, SYS_INDEXES, SYS_INDEX_COLUMNS,
 *    SYS_CONSTRAINTS, SYS_CONSTRAINT_COLUMNS, SYS_PRIVILEGES, SYS_GROUP_GRANTS, SYS_SESSIONS
 *  - 읽기 전용이다. DDL 이나 DML 로 직접 고칠 수 없다.
 *  - 모든 사용자가 조회할 수 있되, 자신이 권한을 가진 객체의 행만 보인다. DBA 는 전부 본다. (8단계)
 *  - 비밀번호 검증 정보는 누구에게도 보여 주지 않는다.
 *  - `SYS_` 로 시작하는 이름과 `DUAL` 은 SYSTEM 테이블스페이스에서 예약한다.
 *
 * 관련 사양 : AGENTS.md 상세 3
 * 구현 단계 : 5단계(뷰 제공), 8단계(권한에 따른 행 가시성)
 */

import { DbError, ERROR_CODES } from "../common/errors.js";
import { formatDataType, varcharType, integerType } from "../types/dataType.js";
import type { DataType } from "../types/dataType.js";
import type { SqlValue } from "../types/value.js";
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
      ];
    default:
      throw new DbError("42P01", ERROR_CODES.TABLE_NOT_FOUND, `Dictionary view does not exist: "${viewName}".`);
  }
}

/** 딕셔너리 뷰인지 본다. */
export function isDictionaryView(name: string): boolean {
  return (DICTIONARY_VIEW_NAMES as readonly string[]).includes(name);
}

/**
 * 딕셔너리 뷰의 행을 만든다.
 * 5단계에서는 권한 가시성을 적용하지 않고 모두 보여 준다. (8단계에서 좁힌다)
 * 사용자와 권한, 세션 뷰는 아직 비어 있다.
 */
export function getDictionaryRows(manager: TablespaceManager, viewName: string): SqlValue[][] {
  switch (viewName) {
    case "SYS_TABLESPACES": {
      return manager.listStatus().map((status) => [
        status.name,
        status.dataFile,
        BigInt(status.formatVersion),
        status.characterSet,
        status.available ? "AVAILABLE" : "UNAVAILABLE",
      ]);
    }
    case "SYS_USERS": {
      // 사용자 계정은 8단계에서 만든다. 지금은 비어 있다.
      return [];
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
          rows.push([name, index.name, index.table, index.unique ? "YES" : "NO"]);
        }
        // PK 유일 인덱스는 제약조건 쪽에 있으므로 함께 보여 준다.
        for (const constraint of Object.values(catalog.data.constraints)) {
          if (constraint.kind === "PRIMARY KEY") {
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
          index.columns.forEach((column, position) => {
            rows.push([name, index.name, BigInt(position + 1), column.name, column.descending ? "YES" : "NO"]);
          });
        }
        for (const constraint of Object.values(catalog.data.constraints)) {
          if (constraint.kind === "PRIMARY KEY") {
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
          constraint.columns.forEach((columnName, position) => {
            const ref = constraint.refColumns?.[position] ?? null;
            rows.push([name, constraint.name, BigInt(position + 1), columnName, ref]);
          });
        }
      }
      rows.sort(compareRows);
      return rows;
    }
    case "SYS_PRIVILEGES":
    case "SYS_GROUP_GRANTS":
    case "SYS_SESSIONS": {
      // 8단계(권한)와 9단계(세션)에서 채운다.
      return [];
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
