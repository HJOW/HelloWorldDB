/**
 * 카탈로그 : DB 객체의 정의를 보관한다.
 *
 * 담당
 *  - 테이블, 컬럼, 뷰, 인덱스, 제약조건(PK, NOT NULL, FK)의 정의와 소유자를 저장하고 조회한다.
 *  - 객체의 정의는 그 객체가 속한 테이블스페이스의 데이터 파일 안에 둔다.
 *  - 이름 해석 : `[테이블스페이스명.]객체명`. 테이블스페이스명을 생략하면 세션의 현재 테이블스페이스
 *  - 이름공간 규칙 : 테이블과 뷰는 이름공간 하나를 함께 쓴다.
 *    인덱스 이름과 제약조건 이름은 각각 테이블스페이스 안에서 유일해야 한다.
 *  - 의존 관계 추적 : 어떤 FK 와 뷰가 어떤 테이블과 컬럼을 참조하는지. RESTRICT 와 CASCADE 판정에 쓴다.
 *
 * 관련 사양 : AGENTS.md 상세 0, 1-3, 3, 11
 * 구현 단계 : 5단계
 */

import { DbError, ERROR_CODES, withPosition } from "../common/errors.js";
import type { SourcePosition } from "../common/errors.js";
import type { Tablespace, StorageBatch } from "../storage/format/format.js";
import { corrupt } from "../storage/errors.js";
import { formatDataType } from "../types/dataType.js";
import type { DataType } from "../types/dataType.js";
import type {
  Expression,
  ForeignKeyReference,
  ObjectName,
  Query,
  ReferentialAction,
  TableConstraint,
} from "../sql/ast.js";
import { decodeUtf8, encodeUtf8 } from "../types/codec.js";

// ---------------------------------------------------------------------------
// 저장되는 정의의 형태
// ---------------------------------------------------------------------------

/** 컬럼 정의의 저장 형태이다. */
export interface StoredColumn {
  name: string;
  dataType: DataType;
  /** DEFAULT 식의 원문. 표시용이며 실행(6단계)이 다시 해석한다. */
  defaultText: string | null;
  /** DEFAULT 식의 구문 트리. JSON 으로 그대로 저장한다. */
  defaultExpr: Expression | null;
  notNull: boolean;
}

/** 테이블 정의의 저장 형태이다. */
export interface StoredTable {
  name: string;
  owner: string;
  columns: StoredColumn[];
  heapRoot: number;
  pkName: string | null;
  pkColumns: string[];
  pkIndexRoot: number | null;
}

/** 제약조건 정의의 저장 형태이다. PK 와 FK 만 둔다. NOT NULL 은 컬럼 속성이다. */
export interface StoredConstraint {
  name: string;
  table: string;
  kind: "PRIMARY KEY" | "FOREIGN KEY";
  columns: string[];
  refTable: string | null;
  refColumns: string[] | null;
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
  indexRoot: number | null;
}

/** 인덱스 정의의 저장 형태이다. 일반 인덱스만 둔다. PK 유일 인덱스는 제약조건 쪽에 둔다. */
export interface StoredIndex {
  name: string;
  table: string;
  columns: { name: string; descending: boolean }[];
  indexRoot: number;
  unique: boolean;
}

/** 뷰 정의의 저장 형태이다. */
export interface StoredView {
  name: string;
  owner: string;
  columns: string[];
  queryText: string;
  dependencies: { tablespace: string; name: string }[];
}

/** 테이블스페이스 하나의 카탈로그이다. SYSTEM 은 system 항목을 함께 가진다. */
export interface CatalogData {
  version: 1;
  tables: Record<string, StoredTable>;
  views: Record<string, StoredView>;
  indexes: Record<string, StoredIndex>;
  constraints: Record<string, StoredConstraint>;
  nextIndexSeq: number;
  nextFkSeq: number;
  system?: SystemRegistry;
}

/** SYSTEM 테이블스페이스에 두는 서버 전체 정보이다. 사용자와 권한은 8단계에서 채운다. */
export interface SystemRegistry {
  tablespaces: Record<string, TablespaceRecord>;
}

/** 테이블스페이스 목록의 한 행이다. dataFile 은 절대 경로로 둔다. */
export interface TablespaceRecord {
  name: string;
  dataFile: string;
  characterSet: string;
  formatVersion: number;
}

// ---------------------------------------------------------------------------
// 오류 생성
// ---------------------------------------------------------------------------

function catalogError(sqlState: string, code: number, message: string, position?: SourcePosition): DbError {
  const error = new DbError(sqlState, code, message);
  return position === undefined ? error : withPosition(error, position);
}

function tablespaceMissing(name: string, position?: SourcePosition): DbError {
  return catalogError("3D000", ERROR_CODES.TABLESPACE_NOT_FOUND, `Tablespace does not exist: "${name}".`, position);
}

function tableMissing(name: string, position?: SourcePosition): DbError {
  return catalogError("42P01", ERROR_CODES.TABLE_NOT_FOUND, `Table does not exist: "${name}".`, position);
}

function viewMissing(name: string, position?: SourcePosition): DbError {
  return catalogError("42P01", ERROR_CODES.VIEW_NOT_FOUND, `View does not exist: "${name}".`, position);
}

function objectMissing(name: string, position?: SourcePosition): DbError {
  return catalogError("42P01", ERROR_CODES.TABLE_NOT_FOUND, `Object does not exist: "${name}".`, position);
}

// ---------------------------------------------------------------------------
// 이름 규칙
// ---------------------------------------------------------------------------

/** 식별자의 코드 포인트 수를 센다. */
function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** SYSTEM 에서 예약된 이름인지 본다. SYS_ 로 시작하거나 DUAL 이다. */
export function isReservedSystemName(name: string): boolean {
  return name === "DUAL" || name.startsWith("SYS_");
}

/** 예약 여부를 확인한다. SYSTEM 테이블스페이스의 객체에만 적용한다. */
export function assertNotReserved(tablespace: string, name: string, position?: SourcePosition): void {
  if (tablespace === "SYSTEM" && isReservedSystemName(name)) {
    throw catalogError(
      "42602",
      ERROR_CODES.RESERVED_NAME,
      `Name is reserved in the SYSTEM tablespace: "${name}".`,
      position,
    );
  }
}

/** 테이블과 뷰가 이름공간 하나를 함께 쓰는지 확인한다. */
export function objectExists(data: CatalogData, name: string): boolean {
  return data.tables[name] !== undefined || data.views[name] !== undefined;
}

// ---------------------------------------------------------------------------
// 카탈로그 바이트의 읽기와 쓰기
// ---------------------------------------------------------------------------

/** 비어 있는 카탈로그를 만든다. */
export function emptyCatalog(): CatalogData {
  return { version: 1, tables: {}, views: {}, indexes: {}, constraints: {}, nextIndexSeq: 1, nextFkSeq: 1 };
}

/** 비어 있는 SYSTEM 카탈로그를 만든다. 테이블스페이스 목록을 함께 가진다. */
export function emptySystemCatalog(): CatalogData {
  const data = emptyCatalog();
  data.system = { tablespaces: {} };
  return data;
}

/** 저장된 바이트열을 카탈로그로 되돌린다. 비어 있으면 빈 카탈로그이다. */
export function parseCatalog(bytes: Buffer | null, tablespaceName: string): CatalogData {
  if (bytes === null) {
    return tablespaceName === "SYSTEM" ? emptySystemCatalog() : emptyCatalog();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch {
    throw corrupt(`Catalog of tablespace "${tablespaceName}" is corrupted.`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw corrupt(`Catalog of tablespace "${tablespaceName}" is corrupted.`);
  }
  const data = parsed as Partial<CatalogData>;
  if (data.version !== 1) {
    throw corrupt(`Catalog of tablespace "${tablespaceName}" has an unsupported version.`);
  }
  // 빠진 항목은 빈 값으로 채운다. 앞으로 항목이 늘어나도 읽을 수 있게 하기 위함이다.
  return {
    version: 1,
    tables: data.tables ?? {},
    views: data.views ?? {},
    indexes: data.indexes ?? {},
    constraints: data.constraints ?? {},
    nextIndexSeq: data.nextIndexSeq ?? 1,
    nextFkSeq: data.nextFkSeq ?? 1,
    ...(data.system !== undefined ? { system: data.system } : {}),
    ...(tablespaceName === "SYSTEM" && data.system === undefined ? { system: { tablespaces: {} } } : {}),
  };
}

/** 카탈로그를 저장용 바이트열로 바꾼다. */
export function serializeCatalog(data: CatalogData): Buffer {
  return encodeUtf8(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// 타입 일치와 식 원문
// ---------------------------------------------------------------------------

/** FK 검사용으로 두 타입이 같은지 본다. 표시 표기가 같으면 같은 타입으로 본다. */
export function dataTypesMatch(left: DataType, right: DataType): boolean {
  return formatDataType(left) === formatDataType(right);
}

/** DEFAULT 식을 원문으로 적는다. 카탈로그 표시용이며 실행은 구문 트리를 쓴다. */
export function expressionText(expr: Expression): string {
  // 구문 트리를 다시 SQL 로 적는 일은 6단계의 몫이다. 지금은 종류만 남긴다.
  switch (expr.kind) {
    case "Literal":
      if (expr.type === "STRING") return `'${expr.value.replace(/'/g, "''")}'`;
      if (expr.type === "NULL") return "NULL";
      if (expr.type === "BOOLEAN") return expr.value ? "TRUE" : "FALSE";
      if (expr.type === "BINARY") return `X'${expr.hex}'`;
      return expr.text;
    case "Parameter":
      return "?";
    case "Default":
      return "DEFAULT";
    default:
      return "(expression)";
  }
}

// ---------------------------------------------------------------------------
// 질의에서 참조하는 테이블 모으기
// ---------------------------------------------------------------------------

/** 뷰가 참조하는 객체를 모은다. 인라인 뷰와 서브쿼리 안까지 모두 본다. */
export function collectReferencedObjects(query: Query): ObjectName[] {
  const found: ObjectName[] = [];
  const stack: object[] = [query];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const current = stack.pop() as Record<string, unknown>;
    if (current === null || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item as object);
      continue;
    }
    // 테이블 참조는 이름만 모으고 별칭과 컬럼 목록은 내려가지 않는다.
    if ((current as { kind?: string }).kind === "Table") {
      const table = current as unknown as { name: ObjectName };
      found.push(table.name);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (key === "position" || child === null || typeof child !== "object") continue;
      stack.push(child as object);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// 테이블스페이스 안의 카탈로그 저장소
// ---------------------------------------------------------------------------

/**
 * 테이블스페이스 하나의 카탈로그를 메모리에 들고 저장 파일에 쓴다.
 * 행 데이터는 아직 없으므로(6단계) 정의만 다룬다. 저장은 배치 하나로 묶는다.
 */
export class CatalogStore {
  constructor(
    readonly tablespaceName: string,
    readonly space: Tablespace,
    data: CatalogData,
  ) {
    this.data = data;
  }

  data: CatalogData;

  /** 저장 파일의 카탈로그 영역에 지금 메모리의 내용을 쓴다. */
  save(): void {
    const batch: StorageBatch = this.space.begin();
    try {
      batch.setCatalog(serializeCatalog(this.data));
      batch.commit();
    } catch (error) {
      try {
        batch.rollback();
      } catch {
        // 롤백 실패는 원래 오류를 가리지 않는다.
      }
      throw error;
    }
  }

  /** 힙 하나를 만들고 그 루트를 돌려준다. 만든 배치는 호출자가 커밋한다. */
  createHeapIn(batch: StorageBatch): number {
    return batch.createHeap();
  }

  /** 일반 B+Tree 인덱스 하나를 만들고 그 루트를 돌려준다. */
  createIndexIn(batch: StorageBatch, unique: boolean): number {
    return batch.createIndex({ unique });
  }

  /** 테이블을 찾는다. 없으면 오류이다. */
  requireTable(name: string, position?: SourcePosition): StoredTable {
    const table = this.data.tables[name];
    if (table === undefined) throw tableMissing(`${this.tablespaceName}.${name}`, position);
    return table;
  }

  /** 테이블 또는 뷰를 찾는다. 없으면 오류이다. */
  requireObject(name: string, position?: SourcePosition): StoredTable | StoredView {
    const table = this.data.tables[name];
    if (table !== undefined) return table;
    const view = this.data.views[name];
    if (view !== undefined) return view;
    throw objectMissing(`${this.tablespaceName}.${name}`, position);
  }

  /** 자동 인덱스 이름을 짓는다. IX_테이블명_순번이다. */
  nextIndexName(tableName: string): string {
    for (;;) {
      const candidate = `IX_${tableName}_${this.data.nextIndexSeq}`;
      this.data.nextIndexSeq++;
      if (this.data.indexes[candidate] === undefined) return candidate;
    }
  }

  /** 자동 FK 이름을 짓는다. FK_테이블명_순번이다. */
  nextFkName(tableName: string): string {
    for (;;) {
      const candidate = `FK_${tableName}_${this.data.nextFkSeq}`;
      this.data.nextFkSeq++;
      if (this.data.constraints[candidate] === undefined) return candidate;
    }
  }

  /** 제약조건 이름이 비었는지 확인한다. 비었으면 자동 이름을 돌려준다. */
  resolveConstraintName(
    wanted: string | null,
    kind: "PRIMARY KEY" | "FOREIGN KEY",
    tableName: string,
    position?: SourcePosition,
  ): string {
    if (wanted !== null) {
      if (this.data.constraints[wanted] !== undefined) {
        throw catalogError("42710", ERROR_CODES.CONSTRAINT_EXISTS, `Constraint already exists: "${wanted}".`, position);
      }
      assertNotReserved(this.tablespaceName, wanted, position);
      return wanted;
    }
    if (kind === "PRIMARY KEY") {
      const candidate = `PK_${tableName}`;
      if (this.data.constraints[candidate] !== undefined) {
        throw catalogError(
          "42710",
          ERROR_CODES.CONSTRAINT_EXISTS,
          `Constraint already exists: "${candidate}".`,
          position,
        );
      }
      return candidate;
    }
    return this.nextFkName(tableName);
  }

  /** 어떤 FK 가 이 테이블을 참조하는지 모은다. 같은 테이블스페이스 안만 본다. */
  findReferencingForeignKeys(tableName: string): StoredConstraint[] {
    return Object.values(this.data.constraints).filter(
      (constraint) => constraint.kind === "FOREIGN KEY" && constraint.refTable === tableName,
    );
  }

  /** 어떤 컬럼을 PK, FK, 인덱스가 쓰는지 본다. */
  isColumnUsed(tableName: string, columnName: string): { used: boolean; reason: string } {
    const table = this.data.tables[tableName];
    if (table !== undefined && table.pkColumns.includes(columnName)) {
      return { used: true, reason: `primary key "${table.pkName ?? ""}"` };
    }
    for (const constraint of Object.values(this.data.constraints)) {
      if (constraint.table === tableName && constraint.columns.includes(columnName)) {
        return { used: true, reason: `constraint "${constraint.name}"` };
      }
      if (
        constraint.kind === "FOREIGN KEY" &&
        constraint.refTable === tableName &&
        (constraint.refColumns ?? []).includes(columnName)
      ) {
        return { used: true, reason: `constraint "${constraint.name}"` };
      }
    }
    for (const index of Object.values(this.data.indexes)) {
      if (index.table === tableName && index.columns.some((column) => column.name === columnName)) {
        return { used: true, reason: `index "${index.name}"` };
      }
    }
    return { used: false, reason: "" };
  }

  /** 테이블 정의를 저장하고 파일에 쓴다. 호출 전에 data 를 모두 고쳐 둔다. */
  persist(): void {
    this.save();
  }
}

/** 테이블 제약조건 목록에서 PK 가 둘인지 본다. */
export function assertSinglePrimaryKey(
  inlinePkCount: number,
  tableConstraints: TableConstraint[],
  position?: SourcePosition,
): void {
  const tablePkCount = tableConstraints.filter((constraint) => constraint.kind === "PrimaryKey").length;
  if (inlinePkCount + tablePkCount > 1) {
    throw catalogError(
      "42P16",
      ERROR_CODES.INVALID_TABLE_DEFINITION,
      "A table cannot have more than one primary key.",
      position,
    );
  }
}

/** 참조동작의 생략값을 채운다. null 이면 NO ACTION 이다. */
export function resolveAction(action: ReferentialAction | null): ReferentialAction {
  return action ?? "NO ACTION";
}

/** FK 참조를 해석한다. 컬럼 목록 생략은 대상 PK, 동작 생략은 NO ACTION 이다. */
export function resolveReference(
  reference: ForeignKeyReference,
  target: StoredTable,
  position?: SourcePosition,
): { columns: string[]; onDelete: ReferentialAction; onUpdate: ReferentialAction } {
  const columns = reference.columns ?? [...target.pkColumns];
  if (target.pkName === null || target.pkColumns.length === 0) {
    throw catalogError(
      "42P16",
      ERROR_CODES.INVALID_TABLE_DEFINITION,
      `Referenced table "${target.name}" has no primary key.`,
      position,
    );
  }
  if (columns.length !== target.pkColumns.length) {
    throw catalogError(
      "42P16",
      ERROR_CODES.INVALID_TABLE_DEFINITION,
      "Foreign key column count must match the referenced primary key.",
      position,
    );
  }
  return { columns, onDelete: resolveAction(reference.onDelete), onUpdate: resolveAction(reference.onUpdate) };
}
