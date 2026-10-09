/**
 * 구문 트리의 정의.
 *
 * 담당
 *  - 문장과 식을 나타내는 노드의 타입 :
 *    질의(SELECT), DML, DDL, 트랜잭션 문장, 테이블스페이스, 사용자, 권한 문장,
 *    세션 문장(USE, SET TIME ZONE, SET AUTOCOMMIT)
 *  - 생략된 부분은 "생략됨"(null 또는 false)으로 남긴다. 기본값을 채우는 것은 실행 쪽의 일이다.
 *    단, 데이터 타입은 파서가 types/dataType.ts 로 해석한 정의(DataType)를 그대로 담는다.
 *
 * 타입 정의만 둔다. 파서가 만들고 exec 가 읽는다.
 * 이름은 정규화된 형태이다. 따옴표 없는 식별자는 대문자, 큰따옴표로 감싼 식별자는 적힌 그대로이다.
 *
 * 관련 사양 : AGENTS.md 상세 1, 3, 4, 5, 6, 10
 * 구현 단계 : 4단계
 */

import type { SourcePosition } from "../common/errors.js";
import type { DataType, IntervalField } from "../types/dataType.js";

export type { SourcePosition };

/** `[테이블스페이스명.]객체명`. 테이블스페이스명을 생략하면 null 이다. */
export interface ObjectName {
  tablespace: string | null;
  name: string;
  position: SourcePosition;
}

// ---------------------------------------------------------------------------
// 식
// ---------------------------------------------------------------------------

export type ComparisonOperator = "=" | "<>" | "<" | "<=" | ">" | ">=";
export type ArithmeticOperator = "+" | "-" | "*" | "/";
export type BinaryOperator = ArithmeticOperator | "||" | ComparisonOperator;

/** INTERVAL 리터럴에 적힌 한정자. 적지 않은 정밀도는 null 이다. */
export interface IntervalQualifier {
  startField: IntervalField;
  /** 단일 필드이면 null. */
  endField: IntervalField | null;
  leadingPrecision: number | null;
  fractionalPrecision: number | null;
}

interface NodeBase {
  position: SourcePosition;
}

export interface NullLiteral extends NodeBase {
  kind: "Literal";
  type: "NULL";
}

export interface BooleanLiteral extends NodeBase {
  kind: "Literal";
  type: "BOOLEAN";
  value: boolean;
}

/** 문자열 리터럴. 타입은 문맥이 정한다. */
export interface StringLiteral extends NodeBase {
  kind: "Literal";
  type: "STRING";
  value: string;
}

/** 이진 리터럴 `X'0A0B'`. hex 는 대문자 16진 숫자이다. */
export interface BinaryLiteral extends NodeBase {
  kind: "Literal";
  type: "BINARY";
  hex: string;
}

/**
 * 수 리터럴. 적힌 표기를 그대로 둔다.
 * INTEGER 는 숫자만, DECIMAL 은 소수점이 있는 것, FLOAT 는 지수 표기이다.
 */
export interface NumberLiteral extends NodeBase {
  kind: "Literal";
  type: "INTEGER" | "DECIMAL" | "FLOAT";
  text: string;
}

/** `DATE '...'`, `TIME '...'`, `TIMESTAMP '...'`. withTimeZone 이 null 이면 문자열의 오프셋 유무로 정한다. */
export interface DatetimeLiteral extends NodeBase {
  kind: "Literal";
  type: "DATE" | "TIME" | "TIMESTAMP";
  text: string;
  withTimeZone: boolean | null;
}

/** `INTERVAL [부호] '...' 한정자`. 부호는 text 맨 앞에 합쳐 둔다. */
export interface IntervalLiteral extends NodeBase {
  kind: "Literal";
  type: "INTERVAL";
  text: string;
  qualifier: IntervalQualifier;
}

export type Literal =
  | NullLiteral
  | BooleanLiteral
  | StringLiteral
  | BinaryLiteral
  | NumberLiteral
  | DatetimeLiteral
  | IntervalLiteral;

/** `?` 파라미터. index 는 문장 안에서 나타난 순서이며 1 부터 센다. */
export interface ParameterExpression extends NodeBase {
  kind: "Parameter";
  index: number;
}

/** 컬럼 참조. qualifier 는 `[]`, `[테이블]`, `[테이블스페이스, 테이블]` 중 하나이다. */
export interface ColumnExpression extends NodeBase {
  kind: "Column";
  qualifier: string[];
  name: string;
}

export interface UnaryExpression extends NodeBase {
  kind: "Unary";
  operator: "+" | "-" | "NOT";
  operand: Expression;
}

export interface BinaryExpression extends NodeBase {
  kind: "Binary";
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
}

/**
 * AND, OR. 같은 연산자가 이어진 것은 피연산자를 나란히 담는다. (`a AND b AND c` 는 피연산자 셋)
 * 조건이 수천 개 이어져도 트리가 깊어지지 않게 하기 위함이다. 피연산자는 둘 이상이다.
 */
export interface LogicalExpression extends NodeBase {
  kind: "Logical";
  operator: "AND" | "OR";
  operands: Expression[];
}

export interface IsNullExpression extends NodeBase {
  kind: "IsNull";
  operand: Expression;
  negated: boolean;
}

/** `IS [NOT] { TRUE | FALSE | UNKNOWN }`. value 가 null 이면 UNKNOWN 이다. */
export interface IsBooleanExpression extends NodeBase {
  kind: "IsBoolean";
  operand: Expression;
  value: boolean | null;
  negated: boolean;
}

export interface BetweenExpression extends NodeBase {
  kind: "Between";
  operand: Expression;
  low: Expression;
  high: Expression;
  negated: boolean;
}

export interface InListExpression extends NodeBase {
  kind: "InList";
  operand: Expression;
  items: Expression[];
  negated: boolean;
}

export interface InSubqueryExpression extends NodeBase {
  kind: "InSubquery";
  operand: Expression;
  query: Query;
  negated: boolean;
}

export interface LikeExpression extends NodeBase {
  kind: "Like";
  operand: Expression;
  pattern: Expression;
  escape: Expression | null;
  negated: boolean;
}

export interface ExistsExpression extends NodeBase {
  kind: "Exists";
  query: Query;
}

/** `식 비교연산자 { ANY | ALL } (서브쿼리)`. SOME 은 ANY 로 담는다. */
export interface QuantifiedExpression extends NodeBase {
  kind: "Quantified";
  operator: ComparisonOperator;
  quantifier: "ANY" | "ALL";
  operand: Expression;
  query: Query;
}

/** 스칼라 서브쿼리. */
export interface SubqueryExpression extends NodeBase {
  kind: "Subquery";
  query: Query;
}

/** CASE. operand 가 있으면 단순형, null 이면 검색형이다. */
export interface CaseExpression extends NodeBase {
  kind: "Case";
  operand: Expression | null;
  branches: { when: Expression; then: Expression }[];
  otherwise: Expression | null;
}

export interface CastExpression extends NodeBase {
  kind: "Cast";
  operand: Expression;
  dataType: DataType;
}

/**
 * 함수 호출. 집계 함수와 `CURRENT_DATE` 같은 괄호 없는 함수도 여기에 담는다.
 *  - `COUNT(*)` 는 star 가 true 이고 인자가 없다.
 *  - `SUBSTRING(x FROM a FOR b)` 는 인자 [x, a, b], `POSITION(a IN b)` 는 인자 [a, b] 로 담는다.
 */
export interface FunctionExpression extends NodeBase {
  kind: "Function";
  name: string;
  arguments: Expression[];
  distinct: boolean;
  star: boolean;
}

export type ExtractField =
  | "YEAR"
  | "MONTH"
  | "DAY"
  | "HOUR"
  | "MINUTE"
  | "SECOND"
  | "TIMEZONE_HOUR"
  | "TIMEZONE_MINUTE";

export interface ExtractExpression extends NodeBase {
  kind: "Extract";
  field: ExtractField;
  operand: Expression;
}

/** `TRIM([{ LEADING | TRAILING | BOTH }] [문자] FROM 식)`. 뗄 문자를 생략하면 null(공백)이다. */
export interface TrimExpression extends NodeBase {
  kind: "Trim";
  side: "LEADING" | "TRAILING" | "BOTH";
  characters: Expression | null;
  operand: Expression;
}

/** `DEFAULT`. INSERT 의 VALUES 와 UPDATE 의 SET 에서 값 자리에만 올 수 있다. */
export interface DefaultExpression extends NodeBase {
  kind: "Default";
}

export type Expression =
  | Literal
  | ParameterExpression
  | ColumnExpression
  | UnaryExpression
  | BinaryExpression
  | LogicalExpression
  | IsNullExpression
  | IsBooleanExpression
  | BetweenExpression
  | InListExpression
  | InSubqueryExpression
  | LikeExpression
  | ExistsExpression
  | QuantifiedExpression
  | SubqueryExpression
  | CaseExpression
  | CastExpression
  | FunctionExpression
  | ExtractExpression
  | TrimExpression
  | DefaultExpression;

// ---------------------------------------------------------------------------
// 질의
// ---------------------------------------------------------------------------

/** 선택 목록의 `*` 또는 `테이블.*`. qualifier 는 컬럼 참조와 같은 형태이다. */
export interface StarItem {
  kind: "Star";
  qualifier: string[];
  position: SourcePosition;
}

export interface ExpressionItem {
  kind: "Expression";
  expression: Expression;
  alias: string | null;
}

export type SelectItem = StarItem | ExpressionItem;

export interface TableReferenceTable {
  kind: "Table";
  name: ObjectName;
  alias: string | null;
}

/** FROM 절의 인라인 뷰. */
export interface TableReferenceDerived {
  kind: "Derived";
  query: Query;
  alias: string | null;
  /** 별칭 뒤에 적은 컬럼 이름 목록. 생략하면 null. */
  columns: string[] | null;
  position: SourcePosition;
}

export type JoinType = "INNER" | "LEFT" | "RIGHT" | "FULL" | "CROSS";

/** 조인. CROSS 는 on 과 using 이 모두 null 이고, 그 밖에는 둘 중 하나가 있다. */
export interface TableReferenceJoin {
  kind: "Join";
  type: JoinType;
  left: TableReference;
  right: TableReference;
  on: Expression | null;
  using: string[] | null;
}

export type TableReference = TableReferenceTable | TableReferenceDerived | TableReferenceJoin;

export interface Select {
  kind: "Select";
  distinct: boolean;
  items: SelectItem[];
  /** 쉼표로 나열한 테이블 참조. FROM 절을 생략하면 빈 배열이다. */
  from: TableReference[];
  where: Expression | null;
  groupBy: Expression[];
  having: Expression | null;
}

export interface SetOperation {
  kind: "SetOperation";
  operator: "UNION" | "INTERSECT" | "EXCEPT";
  /** UNION ALL 일 때만 true. */
  all: boolean;
  left: QueryBody;
  right: QueryBody;
}

/** 질의의 몸통. 괄호로 감싼 질의가 자신의 ORDER BY 나 행 수 제한을 가지면 Query 로 남는다. */
export type QueryBody = Select | SetOperation | Query;

export interface OrderItem {
  expression: Expression;
  descending: boolean;
  nulls: "FIRST" | "LAST" | null;
}

/** 행 수 제한. `FETCH FIRST ROW ONLY` 처럼 개수를 생략하면 count 가 null(1행)이다. */
export interface FetchClause {
  count: Expression | null;
}

export interface Query {
  kind: "Query";
  body: QueryBody;
  orderBy: OrderItem[];
  offset: Expression | null;
  fetch: FetchClause | null;
  forUpdate: boolean;
}

// ---------------------------------------------------------------------------
// DML
// ---------------------------------------------------------------------------

export type InsertSource =
  | { kind: "Values"; rows: Expression[][] }
  | { kind: "Query"; query: Query }
  | { kind: "DefaultValues" };

export interface InsertStatement {
  kind: "Insert";
  target: ObjectName;
  columns: string[] | null;
  source: InsertSource;
}

export interface Assignment {
  column: string;
  value: Expression;
}

export interface UpdateStatement {
  kind: "Update";
  target: ObjectName;
  alias: string | null;
  assignments: Assignment[];
  where: Expression | null;
}

export interface DeleteStatement {
  kind: "Delete";
  target: ObjectName;
  alias: string | null;
  where: Expression | null;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

export type ReferentialAction = "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL";

export interface ForeignKeyReference {
  table: ObjectName;
  /** 참조 컬럼 목록. 생략하면 null(대상 테이블의 PK). */
  columns: string[] | null;
  onDelete: ReferentialAction | null;
  onUpdate: ReferentialAction | null;
}

export interface ColumnDefinition {
  name: string;
  dataType: DataType;
  default: Expression | null;
  notNull: boolean;
  /** 컬럼에 붙여 적은 PRIMARY KEY. name 은 `CONSTRAINT 이름` 으로 적은 이름이며 생략하면 null. */
  primaryKey: { name: string | null } | null;
  /** 컬럼에 붙여 적은 REFERENCES. */
  references: (ForeignKeyReference & { name: string | null }) | null;
}

export interface PrimaryKeyConstraint {
  kind: "PrimaryKey";
  name: string | null;
  columns: string[];
}

export interface ForeignKeyConstraint {
  kind: "ForeignKey";
  name: string | null;
  columns: string[];
  reference: ForeignKeyReference;
}

export type TableConstraint = PrimaryKeyConstraint | ForeignKeyConstraint;

export interface CreateTableStatement {
  kind: "CreateTable";
  name: ObjectName;
  ifNotExists: boolean;
  columns: ColumnDefinition[];
  constraints: TableConstraint[];
}

export type AlterColumnChange =
  | { kind: "SetDefault"; expression: Expression }
  | { kind: "DropDefault" }
  | { kind: "SetNotNull" }
  | { kind: "DropNotNull" };

export type AlterTableAction =
  | { kind: "AddColumn"; column: ColumnDefinition }
  | { kind: "DropColumn"; column: string }
  | { kind: "AlterColumn"; column: string; change: AlterColumnChange }
  | { kind: "RenameColumn"; column: string; newName: string }
  | { kind: "RenameTable"; newName: string }
  | { kind: "AddConstraint"; constraint: TableConstraint }
  | { kind: "DropConstraint"; name: string };

export interface AlterTableStatement {
  kind: "AlterTable";
  name: ObjectName;
  action: AlterTableAction;
}

export type DropBehavior = "RESTRICT" | "CASCADE";

export interface DropTableStatement {
  kind: "DropTable";
  name: ObjectName;
  ifExists: boolean;
  behavior: DropBehavior | null;
}

export interface TruncateTableStatement {
  kind: "TruncateTable";
  name: ObjectName;
}

export interface CreateViewStatement {
  kind: "CreateView";
  name: ObjectName;
  orReplace: boolean;
  columns: string[] | null;
  query: Query;
  /** `AS` 뒤에 적힌 질의의 원문. 카탈로그에 뷰 정의로 남길 때 쓴다. */
  queryText: string;
}

export interface DropViewStatement {
  kind: "DropView";
  name: ObjectName;
  ifExists: boolean;
  behavior: DropBehavior | null;
}

export interface IndexColumn {
  name: string;
  descending: boolean;
}

export interface CreateIndexStatement {
  kind: "CreateIndex";
  /** 인덱스 이름. 생략하면 null 이며 자동으로 부여된다. */
  name: ObjectName | null;
  table: ObjectName;
  columns: IndexColumn[];
}

export interface DropIndexStatement {
  kind: "DropIndex";
  name: ObjectName;
}

// ---------------------------------------------------------------------------
// 테이블스페이스, 사용자, 권한
// ---------------------------------------------------------------------------

export interface CreateTablespaceStatement {
  kind: "CreateTablespace";
  name: string;
  dataFile: string | null;
  /** `CHARACTER SET` 에 적은 이름(대문자). 생략하면 null. */
  characterSet: string | null;
}

export interface DropTablespaceStatement {
  kind: "DropTablespace";
  name: string;
  includingContents: boolean;
}

export interface CreateUserStatement {
  kind: "CreateUser";
  name: string;
  password: string;
  defaultTablespace: string | null;
}

/** `ALTER USER`. 비밀번호와 기본 테이블스페이스 중 적은 것만 값이 있다. */
export interface AlterUserStatement {
  kind: "AlterUser";
  name: string;
  password: string | null;
  defaultTablespace: string | null;
}

export interface DropUserStatement {
  kind: "DropUser";
  name: string;
  cascade: boolean;
}

export type Privilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "CREATE" | "ALTER" | "DROP";
export type PrivilegeGroup = "CONNECT" | "OFFICER" | "DBA";

/** 권한을 걸 대상. 객체는 `TABLE`, `VIEW` 를 적지 않으면 objectType 이 null 이다. */
export type PrivilegeTarget =
  | { kind: "Tablespace"; name: string; position: SourcePosition }
  | { kind: "Object"; objectType: "TABLE" | "VIEW" | null; name: ObjectName };

/** GRANT, REVOKE 의 권한. `ALL [PRIVILEGES]` 는 "ALL" 이다. */
export interface PrivilegeStatement {
  kind: "Grant" | "Revoke";
  privileges: Privilege[] | "ALL";
  target: PrivilegeTarget;
  users: string[];
}

/** 권한 그룹의 GRANT, REVOKE. */
export interface PrivilegeGroupStatement {
  kind: "GrantGroup" | "RevokeGroup";
  groups: PrivilegeGroup[];
  users: string[];
}

// ---------------------------------------------------------------------------
// 트랜잭션과 세션
// ---------------------------------------------------------------------------

/** `BEGIN`, `START TRANSACTION` */
export interface BeginStatement {
  kind: "Begin";
}

export interface CommitStatement {
  kind: "Commit";
}

/** `ROLLBACK [TO [SAVEPOINT] 이름]`. 전체 롤백이면 savepoint 가 null 이다. */
export interface RollbackStatement {
  kind: "Rollback";
  savepoint: string | null;
}

export interface SavepointStatement {
  kind: "Savepoint";
  name: string;
}

export interface ReleaseSavepointStatement {
  kind: "ReleaseSavepoint";
  name: string;
}

export interface SetAutocommitStatement {
  kind: "SetAutocommit";
  value: boolean;
}

/** `SET TRANSACTION ISOLATION LEVEL READ COMMITTED`. 지원하는 격리 수준은 하나뿐이다. */
export interface SetTransactionStatement {
  kind: "SetTransaction";
  isolationLevel: "READ COMMITTED";
}

export interface UseStatement {
  kind: "Use";
  tablespace: string;
}

/** `SET TIME ZONE`. zone 은 `local`, `+09:00` 같은 오프셋, `Asia/Seoul` 같은 지역 이름이다. */
export interface SetTimeZoneStatement {
  kind: "SetTimeZone";
  zone: string;
}

export type Statement =
  | Query
  | InsertStatement
  | UpdateStatement
  | DeleteStatement
  | CreateTableStatement
  | AlterTableStatement
  | DropTableStatement
  | TruncateTableStatement
  | CreateViewStatement
  | DropViewStatement
  | CreateIndexStatement
  | DropIndexStatement
  | CreateTablespaceStatement
  | DropTablespaceStatement
  | CreateUserStatement
  | AlterUserStatement
  | DropUserStatement
  | PrivilegeStatement
  | PrivilegeGroupStatement
  | BeginStatement
  | CommitStatement
  | RollbackStatement
  | SavepointStatement
  | ReleaseSavepointStatement
  | SetAutocommitStatement
  | SetTransactionStatement
  | UseStatement
  | SetTimeZoneStatement;

/** 구문 분석의 결과. */
export interface ParsedStatement {
  statement: Statement;
  /** 문장 안의 `?` 파라미터 수. */
  parameterCount: number;
}
