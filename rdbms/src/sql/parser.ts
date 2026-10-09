/**
 * 구문 분석.
 *
 * 담당
 *  - 토큰을 읽어 구문 트리(ast.ts)를 만든다. 한 번에 문장 하나만 받는다.
 *  - 식 : 연산자 우선순위, CASE, CAST, 함수 호출, 서브쿼리
 *  - 생략 규칙 : 없어도 뜻이 정해지는 키워드와 절은 모두 생략할 수 있어야 한다.
 *    (예 : INSERT 의 INTO, DELETE 의 FROM, 문장 끝의 `;`)
 *  - 지원하지 않는 문법(UNIQUE, CHECK, WITH, MERGE, 윈도우 함수 등)은
 *    문법 오류가 아니라 SQLSTATE 0A000 으로 알린다.
 *  - 문법 오류에는 줄과 칸 위치를 담는다.
 *
 * 이름이 실제로 있는지, 타입이 맞는지는 보지 않는다. 그것은 exec/analyzer.ts 의 몫이다.
 * 단, 데이터 타입의 이름과 인자는 types/dataType.ts 로 바로 해석하여 정의(DataType)로 담는다.
 *
 * 받아들이는 문법과 예약어는 docs/sql-syntax.md 에 정리했다.
 *
 * 관련 사양 : AGENTS.md 상세 1, 3, 4, 5, 6, 10, 13, 16
 * 구현 단계 : 4단계
 */

import { DbError, isDbError, withPosition } from "../common/errors.js";
import type { SourcePosition } from "../common/errors.js";
import { resolveDataType, resolveIntervalType } from "../types/dataType.js";
import type { DataType, IntervalField } from "../types/dataType.js";
import type * as ast from "./ast.js";
import { syntaxError, tokenize, tooComplex, unsupportedSyntax } from "./lexer.js";
import type { Token } from "./lexer.js";

/**
 * 예약어. 큰따옴표로 감싸야 식별자로 쓸 수 있다.
 * 문장과 절의 구조를 정하는 단어만 예약하고, 타입 이름이나 함수 이름 같은 나머지 키워드는 문맥으로 구별한다.
 */
export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  "ALL", "ALTER", "AND", "ANY", "AS", "ASC", "BETWEEN", "BY", "CASE", "CAST", "CHECK", "CONSTRAINT", "CREATE",
  "CROSS", "CURRENT_DATE", "CURRENT_TIME", "CURRENT_TIMESTAMP", "CURRENT_USER", "DEFAULT", "DELETE", "DESC",
  "DISTINCT", "DROP", "ELSE", "END", "ESCAPE", "EXCEPT", "EXISTS", "FALSE", "FETCH", "FOR", "FOREIGN", "FROM",
  "FULL", "GRANT", "GROUP", "HAVING", "IN", "INNER", "INSERT", "INTERSECT", "INTO", "IS", "JOIN", "LEFT", "LIKE",
  "LIMIT", "LOCALTIME", "LOCALTIMESTAMP", "NATURAL", "NOT", "NULL", "OFFSET", "ON", "OR", "ORDER", "OUTER",
  "PRIMARY", "REFERENCES", "REVOKE", "RIGHT", "SELECT", "SET", "SOME", "TABLE", "THEN", "TO", "TRUE", "UNION",
  "UNIQUE", "UPDATE", "USING", "VALUES", "WHEN", "WHERE", "WITH",
]);

/** 괄호로 감싼 질의 바로 뒤에 올 때 질의가 이어지는 것으로 보는 단어. */
const QUERY_CONTINUATIONS: ReadonlySet<string> = new Set([
  "UNION", "INTERSECT", "EXCEPT", "ORDER", "LIMIT", "OFFSET", "FETCH", "FOR",
]);

const COMPARISON_OPERATORS: ReadonlyMap<string, ast.ComparisonOperator> = new Map([
  ["=", "="], ["<>", "<>"], ["!=", "<>"], ["<", "<"], ["<=", "<="], [">", ">"], [">=", ">="],
]);

const INTERVAL_FIELDS: ReadonlySet<string> = new Set(["YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND"]);

const EXTRACT_FIELDS: ReadonlySet<string> = new Set([
  "YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND", "TIMEZONE_HOUR", "TIMEZONE_MINUTE",
]);

/** 괄호 없이 쓰는 함수. 값이 true 이면 소수 초 자릿수 인자를 받는다. */
const NILADIC_FUNCTIONS: ReadonlyMap<string, boolean> = new Map([
  ["CURRENT_DATE", false], ["CURRENT_USER", false], ["CURRENT_TIME", true], ["CURRENT_TIMESTAMP", true],
  ["LOCALTIME", true], ["LOCALTIMESTAMP", true],
]);

const PRIVILEGES: ReadonlySet<string> = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP"]);
const PRIVILEGE_GROUPS: ReadonlySet<string> = new Set(["CONNECT", "OFFICER", "DBA"]);
/** 다른 DBMS 에는 있지만 이 RDBMS 에는 없는 권한. 문법 오류가 아니라 0A000 으로 알린다. */
const UNSUPPORTED_PRIVILEGES: ReadonlySet<string> = new Set([
  "REFERENCES", "EXECUTE", "USAGE", "INDEX", "TRIGGER", "TRUNCATE", "TEMPORARY", "TEMP",
]);

/** 초기 버전에서 지원하지 않는 문장의 첫 단어. (상세 12, 16) */
const UNSUPPORTED_STATEMENTS: ReadonlyMap<string, string> = new Map([
  ["WITH", "WITH (common table expression)"],
  ["MERGE", "MERGE"],
  ["CALL", "CALL"],
  ["EXECUTE", "EXECUTE"],
  ["PREPARE", "PREPARE"],
  ["DEALLOCATE", "DEALLOCATE"],
  ["DECLARE", "DECLARE"],
  ["EXPLAIN", "EXPLAIN"],
  ["ANALYZE", "ANALYZE"],
  ["LOCK", "LOCK"],
  ["COMMENT", "COMMENT"],
  ["RENAME", "RENAME"],
  ["BACKUP", "BACKUP"],
  ["RESTORE", "RESTORE"],
  ["EXPORT", "EXPORT"],
  ["IMPORT", "IMPORT"],
  ["SHOW", "SHOW"],
  ["DESCRIBE", "DESCRIBE"],
  ["VALUES", "VALUES as a query"],
]);

/** CREATE, ALTER, DROP 뒤에 올 수 있지만 지원하지 않는 객체 종류. */
const UNSUPPORTED_OBJECTS: ReadonlySet<string> = new Set([
  "SEQUENCE", "TRIGGER", "PROCEDURE", "FUNCTION", "SYNONYM", "MATERIALIZED", "ROLE", "SCHEMA", "DATABASE",
  "DOMAIN", "TYPE", "PACKAGE", "GLOBAL", "LOCAL", "TEMPORARY", "TEMP", "PUBLIC", "BITMAP", "PROFILE", "DIRECTORY",
  "COLLATION", "ASSERTION", "SESSION", "SYSTEM", "EXTENSION",
]);

/**
 * 겹쳐 들어갈 수 있는 깊이의 상한. 괄호, 서브쿼리, 함수 인자, CASE, NOT, 단항 부호가 여기에 든다.
 * 파서는 재귀로 읽고 한 겹에 호출 스택을 여러 칸 쓰므로, Node.js 와 bun 의 기본 스택에서 넘치지 않는 값으로 둔다.
 */
export const MAX_NESTING_DEPTH = 200;

/**
 * 구문 트리 깊이의 상한. `a + b + c + ...` 처럼 길게 이어진 연산은 왼쪽으로 깊어지는 트리가 되므로
 * 겹친 깊이와 별도로 센다. (AND, OR 은 피연산자를 나란히 담으므로 깊어지지 않는다)
 * 구문 트리를 재귀로 순회하는 뒤 단계의 코드는 이 깊이까지 스택이 넘치지 않아야 한다.
 */
export const MAX_TREE_DEPTH = 1_000;

/**
 * 구문 트리의 깊이를 재귀 없이 확인한다. 상한을 넘으면 54001 이다.
 * 객체 하나가 한 층이고 배열은 층으로 세지 않는다.
 */
function assertTreeDepth(statement: ast.Statement): void {
  const start: SourcePosition = { offset: 0, line: 1, column: 1 };
  const stack: { value: object; depth: number; position: SourcePosition }[] = [
    { value: statement, depth: 1, position: start },
  ];
  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    const { value, depth } = entry;
    const own = (value as { position?: SourcePosition }).position;
    const position = own ?? entry.position;
    if (depth > MAX_TREE_DEPTH) {
      throw tooComplex(`Statement is too complex: expression tree is deeper than ${MAX_TREE_DEPTH} levels`, position);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "position" || typeof child !== "object" || child === null) continue;
      stack.push({ value: child as object, depth: Array.isArray(child) ? depth : depth + 1, position });
    }
  }
}

/** 괄호로 감싼 것을 읽은 결과. 괄호들 뒤가 SELECT 일 때, 끝까지 읽어야 질의인지 아닌지 정해진다. */
type Parenthesized<T> = { query: ast.Query } | { other: T };

interface QueryLookahead {
  /** 연달아 나온 여는 괄호의 수. */
  depth: number;
  /** 괄호들 바로 뒤가 SELECT 인지. */
  isQuery: boolean;
}

class Parser {
  private readonly sql: string;
  private readonly tokens: Token[];
  private index = 0;
  private parameterCount = 0;
  /** 겹쳐 들어간 깊이. nested() 가 관리한다. */
  private depth = 0;
  /** 이미 읽어 둔 맨 앞의 식. 괄호를 읽고 나서야 식의 일부임을 알게 된 경우에 쓴다. parsePrimary 가 꺼내 간다. */
  private pendingPrimary: ast.Expression | null = null;

  constructor(sql: string) {
    this.sql = sql;
    this.tokens = tokenize(sql);
  }

  // -------------------------------------------------------------------------
  // 토큰 다루기
  // -------------------------------------------------------------------------

  private get current(): Token {
    return this.tokens[this.index] as Token;
  }

  private peek(offset: number): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)] as Token;
  }

  private advance(): Token {
    const token = this.current;
    if (token.kind !== "END") this.index++;
    return token;
  }

  /** 문장의 끝에 이르렀는지. (속성 접근으로 비교하면 타입이 좁혀져 뒤의 비교가 막히므로 메서드로 둔다) */
  private atEnd(token: Token = this.current): boolean {
    return token.kind === "END";
  }

  /** 바로 앞 토큰이 끝난 offset. */
  private get previousEnd(): number {
    return this.index === 0 ? 0 : (this.tokens[this.index - 1] as Token).end;
  }

  private isWord(word: string, token: Token = this.current): boolean {
    return token.kind === "WORD" && token.text === word;
  }

  private acceptWord(word: string): boolean {
    if (!this.isWord(word)) return false;
    this.index++;
    return true;
  }

  private expectWord(word: string): Token {
    if (!this.isWord(word)) throw this.unexpected(word);
    return this.advance();
  }

  private isSymbol(symbol: string, token: Token = this.current): boolean {
    return token.kind === "SYMBOL" && token.text === symbol;
  }

  private acceptSymbol(symbol: string): boolean {
    if (!this.isSymbol(symbol)) return false;
    this.index++;
    return true;
  }

  private expectSymbol(symbol: string): Token {
    if (!this.isSymbol(symbol)) throw this.unexpected(`"${symbol}"`);
    return this.advance();
  }

  /** 식별자로 쓸 수 있는 토큰인지 본다. 큰따옴표로 감싼 것이거나 예약어가 아닌 단어이다. */
  private isIdentifier(token: Token = this.current): boolean {
    return token.kind === "QUOTED" || (token.kind === "WORD" && !RESERVED_WORDS.has(token.text));
  }

  private describe(token: Token): string {
    switch (token.kind) {
      case "END": return "end of statement";
      case "WORD": return `"${token.text}"`;
      case "QUOTED": return `identifier "${token.text}"`;
      case "STRING": return "string literal";
      case "HEX": return "binary literal";
      case "NUMBER": return `number ${token.text}`;
      case "PARAMETER": return '"?"';
      case "SYMBOL": return `"${token.text}"`;
    }
  }

  private unexpected(expected?: string): DbError {
    const found = this.describe(this.current);
    return syntaxError(
      expected === undefined ? `Unexpected ${found}` : `Unexpected ${found}; expected ${expected}`,
      this.current.position,
    );
  }

  private unsupported(what: string, token: Token = this.current): DbError {
    return unsupportedSyntax(`${what} is not supported`, token.position);
  }

  /** 타입 해석처럼 위치를 모르는 곳에서 난 오류에 위치를 붙인다. */
  private located<T>(position: SourcePosition, action: () => T): T {
    try {
      return action();
    } catch (error) {
      throw isDbError(error) ? withPosition(error, position) : error;
    }
  }

  /**
   * 겹쳐 들어가는 구문을 읽는 동안 깊이를 센다. 괄호, 서브쿼리, 함수 인자, NOT, 단항 부호가 모두 여기에 든다.
   * 재귀로 읽으므로 깊이를 제한하지 않으면 스택이 넘친다. 넘으면 54001 로 알린다.
   */
  private nested<T>(action: () => T): T {
    if (this.depth >= MAX_NESTING_DEPTH) {
      throw tooComplex(`Statement is nested too deeply (more than ${MAX_NESTING_DEPTH} levels)`, this.current.position);
    }
    this.depth++;
    try {
      return action();
    } finally {
      this.depth--;
    }
  }

  /** 여는 괄호들 뒤가 질의인지 본다. 괄호 안에서 WITH 로 시작하는 질의는 지원하지 않는다. */
  private lookaheadQuery(): QueryLookahead {
    let depth = 0;
    while (this.isSymbol("(", this.peek(depth))) depth++;
    const first = this.peek(depth);
    if (depth > 0 && this.isWord("WITH", first)) throw this.unsupported("WITH (common table expression)", first);
    return { depth, isQuery: this.isWord("SELECT", first) };
  }

  /** `WINDOW 이름 AS (...)`. 테이블 별칭으로 잘못 읽지 않도록 미리 알아본다. */
  private isWindowClause(): boolean {
    return this.isWord("WINDOW") && this.isIdentifier(this.peek(1)) && this.isWord("AS", this.peek(2));
  }

  // -------------------------------------------------------------------------
  // 이름
  // -------------------------------------------------------------------------

  private parseIdentifier(what: string): string {
    const token = this.current;
    if (token.kind === "QUOTED") {
      this.index++;
      return token.text;
    }
    if (token.kind === "WORD") {
      if (RESERVED_WORDS.has(token.text)) {
        throw syntaxError(
          `Reserved word "${token.text}" cannot be used as ${what}; enclose it in double quotes to use it as an identifier`,
          token.position,
        );
      }
      this.index++;
      return token.text;
    }
    throw this.unexpected(what);
  }

  /** `[테이블스페이스명.]객체명` */
  private parseObjectName(what: string): ast.ObjectName {
    const position = this.current.position;
    const first = this.parseIdentifier(what);
    if (!this.acceptSymbol(".")) {
      return { tablespace: null, name: first, position };
    }
    const second = this.parseIdentifier(what);
    if (this.isSymbol(".")) {
      throw syntaxError("Object name has too many parts; expected [tablespace.]name", this.current.position);
    }
    return { tablespace: first, name: second, position };
  }

  /** `(이름, ...)` */
  private parseIdentifierList(what: string): string[] {
    this.expectSymbol("(");
    const names = [this.parseIdentifier(what)];
    while (this.acceptSymbol(",")) names.push(this.parseIdentifier(what));
    this.expectSymbol(")");
    return names;
  }

  /** `[AS] 별칭`. AS 없이 적을 때는 예약어가 아닌 단어만 별칭으로 본다. */
  private parseOptionalAlias(): string | null {
    if (this.acceptWord("AS")) return this.parseIdentifier("an alias");
    return this.isIdentifier() ? this.parseIdentifier("an alias") : null;
  }

  private parseUnsignedInteger(what: string): number {
    const token = this.current;
    if (token.kind !== "NUMBER" || token.numberKind !== "INTEGER") throw this.unexpected(what);
    this.index++;
    return Number(token.text);
  }

  private parseStringLiteral(what: string): string {
    const token = this.current;
    if (token.kind !== "STRING") throw this.unexpected(what);
    this.index++;
    return token.text;
  }

  // -------------------------------------------------------------------------
  // 문장
  // -------------------------------------------------------------------------

  parse(): ast.ParsedStatement {
    if (this.atEnd() || (this.isSymbol(";") && this.atEnd(this.peek(1)))) {
      throw syntaxError("Empty statement", this.current.position);
    }
    const statement = this.parseStatement();
    if (this.acceptSymbol(";")) {
      if (!this.atEnd()) {
        throw syntaxError("Only one statement can be executed per request", this.current.position);
      }
    } else if (!this.atEnd()) {
      throw this.unexpected("end of statement");
    }
    assertTreeDepth(statement);
    return { statement, parameterCount: this.parameterCount };
  }

  private parseStatement(): ast.Statement {
    const token = this.current;
    if (this.isSymbol("(")) return this.parseQuery();
    if (token.kind !== "WORD") throw this.unexpected("a statement");
    switch (token.text) {
      case "SELECT": return this.parseQuery();
      case "INSERT": return this.parseInsert();
      case "UPDATE": return this.parseUpdate();
      case "DELETE": return this.parseDelete();
      case "CREATE": return this.parseCreate();
      case "ALTER": return this.parseAlter();
      case "DROP": return this.parseDrop();
      case "TRUNCATE": return this.parseTruncate();
      case "GRANT": return this.parseGrantOrRevoke("Grant");
      case "REVOKE": return this.parseGrantOrRevoke("Revoke");
      case "BEGIN": return this.parseBegin();
      case "START": return this.parseStartTransaction();
      case "COMMIT": return this.parseCommit();
      case "ROLLBACK": return this.parseRollback();
      case "SAVEPOINT": return this.parseSavepoint();
      case "RELEASE": return this.parseReleaseSavepoint();
      case "SET": return this.parseSet();
      case "USE": return this.parseUse();
      default: {
        const unsupported = UNSUPPORTED_STATEMENTS.get(token.text);
        if (unsupported !== undefined) throw this.unsupported(unsupported);
        throw this.unexpected("a statement");
      }
    }
  }

  // -------------------------------------------------------------------------
  // 질의
  // -------------------------------------------------------------------------

  /**
   * 질의 식 : 몸통 [ORDER BY] [행 수 제한] [FOR UPDATE]
   * first 는 이미 읽어 둔 맨 앞의 항(괄호로 감싼 질의)이다.
   */
  private parseQuery(first?: ast.QueryBody): ast.Query {
    return this.nested(() => this.parseQueryUnguarded(first));
  }

  private parseQueryUnguarded(first?: ast.QueryBody): ast.Query {
    const body = this.parseQueryBody(first);
    const query: ast.Query = { kind: "Query", body, orderBy: [], offset: null, fetch: null, forUpdate: false };
    let extended = false;
    if (this.acceptWord("ORDER")) {
      this.expectWord("BY");
      query.orderBy = this.parseOrderBy();
      extended = true;
    }
    if (this.parseRowLimit(query)) extended = true;
    if (this.isWord("FOR")) {
      this.parseForUpdate();
      query.forUpdate = true;
      extended = true;
    }
    // 괄호로 감싼 질의에 덧붙인 절이 없으면 안쪽 질의를 그대로 쓴다.
    return !extended && body.kind === "Query" ? body : query;
  }

  /** UNION, EXCEPT 는 왼쪽부터 묶고, INTERSECT 가 이들보다 먼저 묶인다. */
  private parseQueryBody(first?: ast.QueryBody): ast.QueryBody {
    let left = this.parseQueryTerm(first);
    while (this.isWord("UNION") || this.isWord("EXCEPT")) {
      const operator = this.advance().text as "UNION" | "EXCEPT";
      const all = this.parseSetQuantifier(operator);
      left = { kind: "SetOperation", operator, all, left, right: this.parseQueryTerm() };
    }
    return left;
  }

  private parseQueryTerm(first?: ast.QueryBody): ast.QueryBody {
    let left = first ?? this.parseQueryPrimary();
    while (this.isWord("INTERSECT")) {
      this.index++;
      const all = this.parseSetQuantifier("INTERSECT");
      left = { kind: "SetOperation", operator: "INTERSECT", all, left, right: this.parseQueryPrimary() };
    }
    return left;
  }

  /** 괄호로 감쌌던 질의를 더 큰 질의의 항으로 쓴다. 덧붙인 절이 없으면 몸통만 쓴다. */
  private asQueryBody(query: ast.Query): ast.QueryBody {
    const plain = query.orderBy.length === 0 && query.offset === null && query.fetch === null && !query.forUpdate;
    return plain ? query.body : query;
  }

  /** 괄호로 감싼 질의 뒤에 질의가 이어지는지 본다. (집합 연산, 정렬, 행 수 제한, FOR UPDATE) */
  private continuesQuery(): boolean {
    const token = this.current;
    return token.kind === "WORD" && QUERY_CONTINUATIONS.has(token.text);
  }

  private parseSetQuantifier(operator: string): boolean {
    if (this.isWord("ALL")) {
      if (operator !== "UNION") throw this.unsupported(`${operator} ALL`);
      this.index++;
      return true;
    }
    this.acceptWord("DISTINCT");
    return false;
  }

  private parseQueryPrimary(): ast.QueryBody {
    if (this.acceptSymbol("(")) {
      const query = this.parseQuery();
      this.expectSymbol(")");
      return this.asQueryBody(query);
    }
    if (this.isWord("SELECT")) return this.parseSelect();
    if (this.isWord("WITH")) throw this.unsupported("WITH (common table expression)");
    if (this.isWord("VALUES")) throw this.unsupported("VALUES as a query");
    throw this.unexpected("SELECT");
  }

  private parseSelect(): ast.Select {
    this.expectWord("SELECT");
    let distinct = false;
    if (this.acceptWord("DISTINCT")) distinct = true;
    else this.acceptWord("ALL");

    const items = [this.parseSelectItem()];
    while (this.acceptSymbol(",")) items.push(this.parseSelectItem());
    if (this.isWord("INTO")) throw this.unsupported("SELECT INTO");

    const from: ast.TableReference[] = [];
    if (this.acceptWord("FROM")) {
      from.push(this.parseTableReference());
      while (this.acceptSymbol(",")) from.push(this.parseTableReference());
    }
    const where = this.acceptWord("WHERE") ? this.parseExpression() : null;

    const groupBy: ast.Expression[] = [];
    if (this.acceptWord("GROUP")) {
      this.expectWord("BY");
      do {
        if ((this.isWord("ROLLUP") || this.isWord("CUBE")) && this.isSymbol("(", this.peek(1))) {
          throw this.unsupported(this.current.text);
        }
        if (this.isWord("GROUPING") && this.isWord("SETS", this.peek(1))) throw this.unsupported("GROUPING SETS");
        groupBy.push(this.parseExpression());
      } while (this.acceptSymbol(","));
    }
    const having = this.acceptWord("HAVING") ? this.parseExpression() : null;
    if (this.isWindowClause()) throw this.unsupported("WINDOW clause");
    return { kind: "Select", distinct, items, from, where, groupBy, having };
  }

  private parseSelectItem(): ast.SelectItem {
    const position = this.current.position;
    if (this.acceptSymbol("*")) return { kind: "Star", qualifier: [], position };
    // 테이블.* 또는 테이블스페이스.테이블.*
    if (this.isIdentifier() && this.isSymbol(".", this.peek(1))) {
      if (this.isSymbol("*", this.peek(2))) {
        const qualifier = [this.parseIdentifier("a table name")];
        this.index += 2;
        return { kind: "Star", qualifier, position };
      }
      if (this.isIdentifier(this.peek(2)) && this.isSymbol(".", this.peek(3)) && this.isSymbol("*", this.peek(4))) {
        const tablespace = this.parseIdentifier("a tablespace name");
        this.index++;
        const table = this.parseIdentifier("a table name");
        this.index += 2;
        return { kind: "Star", qualifier: [tablespace, table], position };
      }
    }
    const expression = this.parseExpression();
    return { kind: "Expression", expression, alias: this.parseOptionalAlias() };
  }

  /** first 는 이미 읽어 둔 맨 앞의 테이블 참조이다. */
  private parseTableReference(first?: ast.TableReference): ast.TableReference {
    return this.nested(() => this.parseTableReferenceUnguarded(first));
  }

  private parseTableReferenceUnguarded(first?: ast.TableReference): ast.TableReference {
    let left = first ?? this.parseTablePrimary();
    for (;;) {
      if (this.isWord("NATURAL")) throw this.unsupported("NATURAL JOIN");
      if (this.acceptWord("CROSS")) {
        this.expectWord("JOIN");
        left = { kind: "Join", type: "CROSS", left, right: this.parseTablePrimary(), on: null, using: null };
        continue;
      }
      let type: ast.JoinType;
      if (this.acceptWord("JOIN")) {
        type = "INNER";
      } else if (this.acceptWord("INNER")) {
        this.expectWord("JOIN");
        type = "INNER";
      } else if (this.isWord("LEFT") || this.isWord("RIGHT") || this.isWord("FULL")) {
        type = this.advance().text as ast.JoinType;
        this.acceptWord("OUTER");
        this.expectWord("JOIN");
      } else {
        return left;
      }
      const right = this.parseTablePrimary();
      if (this.acceptWord("ON")) {
        left = { kind: "Join", type, left, right, on: this.parseExpression(), using: null };
      } else if (this.acceptWord("USING")) {
        left = { kind: "Join", type, left, right, on: null, using: this.parseIdentifierList("a column name") };
      } else {
        throw this.unexpected("ON or USING");
      }
    }
  }

  private parseTablePrimary(): ast.TableReference {
    const position = this.current.position;
    if (this.isWord("LATERAL") && this.isSymbol("(", this.peek(1))) throw this.unsupported("LATERAL");
    if (this.isSymbol("(")) {
      if (!this.lookaheadQuery().isQuery) {
        // 괄호로 감싼 조인
        this.index++;
        const inner = this.parseTableReference();
        this.expectSymbol(")");
        return inner;
      }
      const result = this.parseParenthesizedTable();
      return "query" in result ? this.finishDerivedTable(result.query, position) : result.other;
    }
    const name = this.parseObjectName("a table name");
    return { kind: "Table", name, alias: this.isWindowClause() ? null : this.parseOptionalAlias() };
  }

  /** 인라인 뷰의 별칭과 컬럼 이름 목록. 괄호로 감싼 질의는 이미 읽었다. */
  private finishDerivedTable(query: ast.Query, position: SourcePosition): ast.TableReferenceDerived {
    const alias = this.isWindowClause() ? null : this.parseOptionalAlias();
    const columns = alias !== null && this.isSymbol("(") ? this.parseIdentifierList("a column name") : null;
    return { kind: "Derived", query, alias, columns, position };
  }

  /**
   * FROM 절에서 여는 괄호들 뒤가 SELECT 인 것을 읽는다. 닫는 괄호까지 읽는다.
   * 인라인 뷰가 될 질의이면 query 를, 괄호로 감싼 조인이면 other 를 돌려준다.
   * 맨 안쪽은 반드시 질의이고, 바깥 괄호는 그 뒤에 무엇이 이어지는지로 정해진다.
   *   ((SELECT 1))                    질의
   *   ((SELECT 1) UNION (SELECT 2))   질의
   *   ((SELECT 1) A CROSS JOIN B)     안쪽 질의를 인라인 뷰로 쓰는 조인
   */
  private parseParenthesizedTable(): Parenthesized<ast.TableReference> {
    return this.nested(() => {
      this.expectSymbol("(");
      if (!this.isSymbol("(")) {
        const query = this.parseQuery();
        this.expectSymbol(")");
        return { query };
      }
      const innerPosition = this.current.position;
      const inner = this.parseParenthesizedTable();
      let first: ast.TableReference;
      if ("query" in inner) {
        if (this.acceptSymbol(")")) return inner;
        if (this.continuesQuery()) {
          const query = this.parseQuery(this.asQueryBody(inner.query));
          this.expectSymbol(")");
          return { query };
        }
        first = this.finishDerivedTable(inner.query, innerPosition);
      } else {
        first = inner.other;
      }
      const other = this.parseTableReference(first);
      this.expectSymbol(")");
      return { other };
    });
  }

  private parseOrderBy(): ast.OrderItem[] {
    const items: ast.OrderItem[] = [];
    do {
      const expression = this.parseExpression();
      let descending = false;
      if (this.acceptWord("DESC")) descending = true;
      else this.acceptWord("ASC");
      let nulls: ast.OrderItem["nulls"] = null;
      if (this.isWord("NULLS") && (this.isWord("FIRST", this.peek(1)) || this.isWord("LAST", this.peek(1)))) {
        this.index++;
        nulls = this.advance().text as "FIRST" | "LAST";
      }
      items.push({ expression, descending, nulls });
    } while (this.acceptSymbol(","));
    return items;
  }

  /**
   * 행 수 제한. ANSI 의 `OFFSET n [ROW | ROWS]`, `FETCH { FIRST | NEXT } [m] { ROW | ROWS } ONLY` 와
   * `LIMIT m [OFFSET n]` 을 받는다. 절의 순서는 가리지 않는다.
   */
  private parseRowLimit(query: ast.Query): boolean {
    let found = false;
    for (;;) {
      const token = this.current;
      if (this.isWord("LIMIT")) {
        if (query.fetch !== null) throw syntaxError("Row limit is specified more than once", token.position);
        this.index++;
        query.fetch = { count: this.parseAdditive() };
        if (this.isSymbol(",")) throw this.unsupported("LIMIT offset, count");
      } else if (this.isWord("OFFSET")) {
        if (query.offset !== null) throw syntaxError("OFFSET is specified more than once", token.position);
        this.index++;
        query.offset = this.parseAdditive();
        if (!this.acceptWord("ROW")) this.acceptWord("ROWS");
      } else if (this.isWord("FETCH")) {
        if (query.fetch !== null) throw syntaxError("Row limit is specified more than once", token.position);
        this.index++;
        if (!this.acceptWord("FIRST") && !this.acceptWord("NEXT")) throw this.unexpected("FIRST or NEXT");
        const count = this.isWord("ROW") || this.isWord("ROWS") ? null : this.parseAdditive();
        if (this.isWord("PERCENT")) throw this.unsupported("FETCH ... PERCENT");
        if (!this.acceptWord("ROW") && !this.acceptWord("ROWS")) throw this.unexpected("ROW or ROWS");
        if (this.isWord("WITH")) throw this.unsupported("FETCH ... WITH TIES");
        this.expectWord("ONLY");
        query.fetch = { count };
      } else {
        return found;
      }
      found = true;
    }
  }

  private parseForUpdate(): void {
    this.expectWord("FOR");
    if (!this.isWord("UPDATE")) {
      if (this.isWord("SHARE") || this.isWord("READ")) throw this.unsupported(`FOR ${this.current.text}`);
      throw this.unexpected("UPDATE");
    }
    this.index++;
    if (this.isWord("OF") || this.isWord("NOWAIT") || this.isWord("WAIT") || this.isWord("SKIP")) {
      throw this.unsupported(`FOR UPDATE ${this.current.text}`);
    }
  }

  // -------------------------------------------------------------------------
  // 식
  // -------------------------------------------------------------------------

  /**
   * first 는 이미 읽어 둔 맨 앞의 식이다. 괄호로 감싼 것을 읽고 나서야 식의 일부임을 알게 된 경우에 쓴다.
   * 그 식은 다음에 parsePrimary 가 불릴 때 나오므로, 그 사이의 NOT 과 단항 부호 처리는 건너뛴다.
   */
  private parseExpression(first?: ast.Expression): ast.Expression {
    if (first !== undefined) this.pendingPrimary = first;
    return this.nested(() => this.parseOr());
  }

  /** OR 로 이어진 것은 피연산자를 나란히 담는다. 위치는 첫 OR 의 위치이다. */
  private parseOr(): ast.Expression {
    const first = this.parseAnd();
    if (!this.isWord("OR")) return first;
    const position = this.current.position;
    const operands = [first];
    while (this.acceptWord("OR")) operands.push(this.parseAnd());
    return { kind: "Logical", operator: "OR", operands, position };
  }

  /** AND 로 이어진 것은 피연산자를 나란히 담는다. 위치는 첫 AND 의 위치이다. */
  private parseAnd(): ast.Expression {
    const first = this.parseNot();
    if (!this.isWord("AND")) return first;
    const position = this.current.position;
    const operands = [first];
    while (this.acceptWord("AND")) operands.push(this.parseNot());
    return { kind: "Logical", operator: "AND", operands, position };
  }

  private parseNot(): ast.Expression {
    if (this.pendingPrimary === null && this.isWord("NOT")) {
      const position = this.advance().position;
      return { kind: "Unary", operator: "NOT", operand: this.nested(() => this.parseNot()), position };
    }
    return this.parsePredicate();
  }

  /** 비교, IS, BETWEEN, IN, LIKE */
  private parsePredicate(): ast.Expression {
    let left = this.parseAdditive();
    for (;;) {
      const token = this.current;
      const position = token.position;
      const comparison = token.kind === "SYMBOL" ? COMPARISON_OPERATORS.get(token.text) : undefined;
      if (comparison !== undefined) {
        this.index++;
        if (this.isWord("ANY") || this.isWord("SOME") || this.isWord("ALL")) {
          const quantifier = this.advance().text === "ALL" ? "ALL" : "ANY";
          this.expectSymbol("(");
          const query = this.parseQuery();
          this.expectSymbol(")");
          left = { kind: "Quantified", operator: comparison, quantifier, operand: left, query, position };
        } else {
          left = { kind: "Binary", operator: comparison, left, right: this.parseAdditive(), position };
        }
        continue;
      }
      if (this.acceptWord("IS")) {
        const negated = this.acceptWord("NOT");
        if (this.acceptWord("NULL")) {
          left = { kind: "IsNull", operand: left, negated, position };
        } else if (this.isWord("TRUE") || this.isWord("FALSE") || this.isWord("UNKNOWN")) {
          const word = this.advance().text;
          const value = word === "UNKNOWN" ? null : word === "TRUE";
          left = { kind: "IsBoolean", operand: left, value, negated, position };
        } else if (this.isWord("DISTINCT")) {
          throw this.unsupported("IS DISTINCT FROM");
        } else {
          throw this.unexpected("NULL, TRUE, FALSE or UNKNOWN");
        }
        continue;
      }
      let negated = false;
      if (this.isWord("NOT")) {
        const next = this.peek(1);
        if (!this.isWord("BETWEEN", next) && !this.isWord("IN", next) && !this.isWord("LIKE", next)) return left;
        this.index++;
        negated = true;
      }
      if (this.acceptWord("BETWEEN")) {
        if (this.isWord("SYMMETRIC")) throw this.unsupported("BETWEEN SYMMETRIC");
        const low = this.parseAdditive();
        this.expectWord("AND");
        left = { kind: "Between", operand: left, low, high: this.parseAdditive(), negated, position };
      } else if (this.acceptWord("IN")) {
        this.expectSymbol("(");
        if (this.isWord("WITH")) throw this.unsupported("WITH (common table expression)");
        if (this.isWord("SELECT")) {
          left = { kind: "InSubquery", operand: left, query: this.parseQuery(), negated, position };
        } else {
          const items = [this.parseExpression()];
          while (this.acceptSymbol(",")) items.push(this.parseExpression());
          left = { kind: "InList", operand: left, items, negated, position };
        }
        this.expectSymbol(")");
      } else if (this.acceptWord("LIKE")) {
        const pattern = this.parseAdditive();
        const escape = this.acceptWord("ESCAPE") ? this.parseAdditive() : null;
        left = { kind: "Like", operand: left, pattern, escape, negated, position };
      } else {
        return left;
      }
    }
  }

  /** `+`, `-`, `||` */
  private parseAdditive(): ast.Expression {
    let left = this.parseMultiplicative();
    while (this.isSymbol("+") || this.isSymbol("-") || this.isSymbol("||")) {
      const token = this.advance();
      const operator = token.text as "+" | "-" | "||";
      left = { kind: "Binary", operator, left, right: this.parseMultiplicative(), position: token.position };
    }
    return left;
  }

  /** `*`, `/` */
  private parseMultiplicative(): ast.Expression {
    let left = this.parseUnary();
    while (this.isSymbol("*") || this.isSymbol("/")) {
      const token = this.advance();
      const operator = token.text as "*" | "/";
      left = { kind: "Binary", operator, left, right: this.parseUnary(), position: token.position };
    }
    return left;
  }

  private parseUnary(): ast.Expression {
    if (this.pendingPrimary !== null || (!this.isSymbol("+") && !this.isSymbol("-"))) return this.parsePrimary();
    const token = this.advance();
    const operand = this.nested(() => this.parseUnary());
    // 부호가 붙은 수 리터럴은 하나의 리터럴로 합친다. (예 : -2147483648 이 INTEGER 범위에 들도록)
    if (operand.kind === "Literal" && (operand.type === "INTEGER" || operand.type === "DECIMAL" || operand.type === "FLOAT")) {
      if (token.text === "+") return { ...operand, position: token.position };
      const text = operand.text.startsWith("-") ? operand.text.slice(1) : `-${operand.text}`;
      return { ...operand, text, position: token.position };
    }
    return { kind: "Unary", operator: token.text as "+" | "-", operand, position: token.position };
  }

  private parsePrimary(): ast.Expression {
    if (this.pendingPrimary !== null) {
      const pending = this.pendingPrimary;
      this.pendingPrimary = null;
      return pending;
    }
    const token = this.current;
    const position = token.position;
    switch (token.kind) {
      case "NUMBER":
        this.index++;
        return { kind: "Literal", type: token.numberKind ?? "INTEGER", text: token.text, position };
      case "STRING":
        this.index++;
        return { kind: "Literal", type: "STRING", value: token.text, position };
      case "HEX":
        this.index++;
        return { kind: "Literal", type: "BINARY", hex: token.text, position };
      case "PARAMETER":
        this.index++;
        this.parameterCount++;
        return { kind: "Parameter", index: this.parameterCount, position };
      case "QUOTED":
        return this.parseColumnOrFunction();
      case "SYMBOL":
        if (token.text === "(") return this.parseParenthesized();
        throw this.unexpected("an expression");
      case "END":
        throw this.unexpected("an expression");
      case "WORD":
        break;
    }

    switch (token.text) {
      case "NULL":
        this.index++;
        return { kind: "Literal", type: "NULL", position };
      case "TRUE":
      case "FALSE":
        this.index++;
        return { kind: "Literal", type: "BOOLEAN", value: token.text === "TRUE", position };
      case "CASE":
        return this.parseCase();
      case "CAST":
        return this.parseCast();
      case "EXISTS": {
        this.index++;
        this.expectSymbol("(");
        const query = this.parseQuery();
        this.expectSymbol(")");
        return { kind: "Exists", query, position };
      }
      case "DEFAULT":
        throw syntaxError("DEFAULT can only be used as a value in INSERT ... VALUES or UPDATE ... SET", position);
      case "DATE":
        if (this.peek(1).kind === "STRING") {
          this.index++;
          return { kind: "Literal", type: "DATE", text: this.advance().text, withTimeZone: null, position };
        }
        break;
      case "TIME":
      case "TIMESTAMP": {
        const literal = this.parseDatetimeLiteral(token.text);
        if (literal !== null) return literal;
        break;
      }
      case "INTERVAL": {
        const next = this.peek(1);
        const signed = (this.isSymbol("+", next) || this.isSymbol("-", next)) && this.peek(2).kind === "STRING";
        if (next.kind === "STRING" || signed) return this.parseIntervalLiteral();
        break;
      }
      default:
        break;
    }
    if (NILADIC_FUNCTIONS.has(token.text)) return this.parseNiladicFunction();
    if (RESERVED_WORDS.has(token.text)) throw this.unexpected("an expression");
    return this.parseColumnOrFunction();
  }

  /** `TIME '...'`, `TIMESTAMP '...'`. `WITH TIME ZONE`, `WITHOUT TIME ZONE` 을 사이에 둘 수 있다. */
  private parseDatetimeLiteral(type: "TIME" | "TIMESTAMP"): ast.DatetimeLiteral | null {
    const position = this.current.position;
    if (this.peek(1).kind === "STRING") {
      this.index++;
      return { kind: "Literal", type, text: this.advance().text, withTimeZone: null, position };
    }
    const zone = this.peek(1);
    if (
      (this.isWord("WITH", zone) || this.isWord("WITHOUT", zone)) &&
      this.isWord("TIME", this.peek(2)) &&
      this.isWord("ZONE", this.peek(3)) &&
      this.peek(4).kind === "STRING"
    ) {
      this.index += 4;
      return { kind: "Literal", type, text: this.advance().text, withTimeZone: zone.text === "WITH", position };
    }
    return null;
  }

  /** `INTERVAL [+ | -] '...' 한정자` */
  private parseIntervalLiteral(): ast.IntervalLiteral {
    const position = this.expectWord("INTERVAL").position;
    let negative = false;
    if (this.acceptSymbol("-")) negative = true;
    else this.acceptSymbol("+");
    let text = this.parseStringLiteral("an interval string").trim();
    if (negative) text = text.startsWith("-") ? text.slice(1).trimStart() : `-${text.replace(/^\+\s*/, "")}`;
    const qualifier = this.parseIntervalQualifier(position);
    return { kind: "Literal", type: "INTERVAL", text, qualifier, position };
  }

  /**
   * `시작[(선행 정밀도)] [TO 종료[(소수 초 자릿수)]]`. 단일 SECOND 는 `SECOND[(선행 정밀도[, 소수 초 자릿수])]`
   * position 은 한정자가 틀렸을 때 오류에 적을 위치(INTERVAL 키워드)이다.
   */
  private parseIntervalQualifier(position: SourcePosition): ast.IntervalQualifier {
    const start = this.current;
    if (start.kind !== "WORD" || !INTERVAL_FIELDS.has(start.text)) {
      throw this.unexpected("an interval field (YEAR, MONTH, DAY, HOUR, MINUTE or SECOND)");
    }
    this.index++;
    const qualifier: ast.IntervalQualifier = {
      startField: start.text as IntervalField,
      endField: null,
      leadingPrecision: null,
      fractionalPrecision: null,
    };
    if (this.acceptSymbol("(")) {
      qualifier.leadingPrecision = this.parseUnsignedInteger("a precision");
      if (qualifier.startField === "SECOND" && this.acceptSymbol(",")) {
        qualifier.fractionalPrecision = this.parseUnsignedInteger("a precision");
      }
      this.expectSymbol(")");
    }
    if (this.isWord("TO") && this.peek(1).kind === "WORD" && INTERVAL_FIELDS.has(this.peek(1).text)) {
      this.index++;
      qualifier.endField = this.advance().text as IntervalField;
      if (this.acceptSymbol("(")) {
        qualifier.fractionalPrecision = this.parseUnsignedInteger("a precision");
        this.expectSymbol(")");
      }
    }
    // 필드 조합과 정밀도의 범위를 여기서 확인한다.
    this.located(position, () => this.resolveInterval(qualifier));
    return qualifier;
  }

  private resolveInterval(qualifier: ast.IntervalQualifier): DataType {
    return resolveIntervalType(
      qualifier.startField,
      qualifier.endField ?? undefined,
      qualifier.leadingPrecision ?? undefined,
      qualifier.fractionalPrecision ?? undefined,
    );
  }

  /** 여는 괄호로 시작하는 식 : 스칼라 서브쿼리이거나 괄호로 감싼 식이다. */
  private parseParenthesized(): ast.Expression {
    const position = this.current.position;
    if (!this.lookaheadQuery().isQuery) {
      this.index++;
      return this.finishGroupedExpression(this.parseExpression());
    }
    const result = this.parseParenthesizedExpression();
    return "query" in result ? { kind: "Subquery", query: result.query, position } : result.other;
  }

  /** 괄호로 감싼 식의 닫는 괄호. 쉼표로 나열한 행 값은 지원하지 않는다. */
  private finishGroupedExpression(inner: ast.Expression): ast.Expression {
    if (this.isSymbol(",")) throw this.unsupported("Row value constructor");
    this.expectSymbol(")");
    return inner;
  }

  /**
   * 식에서 여는 괄호들 뒤가 SELECT 인 것을 읽는다. 닫는 괄호까지 읽는다.
   * 스칼라 서브쿼리가 될 질의이면 query 를, 괄호로 감싼 식이면 other 를 돌려준다.
   * 맨 안쪽은 반드시 질의이고, 바깥 괄호는 그 뒤에 무엇이 이어지는지로 정해진다.
   *   ((SELECT 1))                    질의
   *   ((SELECT 1) UNION (SELECT 2))   질의
   *   ((SELECT 1) + 1)                안쪽 질의를 스칼라 서브쿼리로 쓰는 식
   */
  private parseParenthesizedExpression(): Parenthesized<ast.Expression> {
    return this.nested(() => {
      this.expectSymbol("(");
      if (!this.isSymbol("(")) {
        const query = this.parseQuery();
        this.expectSymbol(")");
        return { query };
      }
      const innerPosition = this.current.position;
      const inner = this.parseParenthesizedExpression();
      let first: ast.Expression;
      if ("query" in inner) {
        if (this.acceptSymbol(")")) return inner;
        if (this.continuesQuery()) {
          const query = this.parseQuery(this.asQueryBody(inner.query));
          this.expectSymbol(")");
          return { query };
        }
        first = { kind: "Subquery", query: inner.query, position: innerPosition };
      } else {
        first = inner.other;
      }
      return { other: this.finishGroupedExpression(this.parseExpression(first)) };
    });
  }

  private parseCase(): ast.CaseExpression {
    const position = this.expectWord("CASE").position;
    const operand = this.isWord("WHEN") ? null : this.parseExpression();
    const branches: ast.CaseExpression["branches"] = [];
    while (this.acceptWord("WHEN")) {
      const when = this.parseExpression();
      this.expectWord("THEN");
      branches.push({ when, then: this.parseExpression() });
    }
    if (branches.length === 0) throw this.unexpected("WHEN");
    const otherwise = this.acceptWord("ELSE") ? this.parseExpression() : null;
    this.expectWord("END");
    return { kind: "Case", operand, branches, otherwise, position };
  }

  private parseCast(): ast.CastExpression {
    const position = this.expectWord("CAST").position;
    this.expectSymbol("(");
    const operand = this.parseExpression();
    this.expectWord("AS");
    const dataType = this.parseDataType();
    this.expectSymbol(")");
    return { kind: "Cast", operand, dataType, position };
  }

  /** `CURRENT_DATE` 처럼 괄호 없이 쓰는 함수. 빈 괄호나 소수 초 자릿수를 붙여도 된다. */
  private parseNiladicFunction(): ast.FunctionExpression {
    const token = this.advance();
    const expression: ast.FunctionExpression = {
      kind: "Function", name: token.text, arguments: [], distinct: false, star: false, position: token.position,
    };
    if (this.acceptSymbol("(")) {
      if (!this.isSymbol(")")) {
        if (NILADIC_FUNCTIONS.get(token.text) !== true) throw this.unexpected('")"');
        const precision = this.current;
        this.parseUnsignedInteger("a fractional seconds precision");
        expression.arguments.push({ kind: "Literal", type: "INTEGER", text: precision.text, position: precision.position });
      }
      this.expectSymbol(")");
    }
    return expression;
  }

  private parseColumnOrFunction(): ast.Expression {
    const first = this.current;
    const position = first.position;
    const parts = [this.parseIdentifier("an expression")];
    if (this.isSymbol("(")) return this.parseFunctionCall(parts[0] as string, first);
    while (this.acceptSymbol(".")) {
      if (this.isSymbol("*")) {
        throw syntaxError('"*" can only be used in the select list or in COUNT(*)', this.current.position);
      }
      parts.push(this.parseIdentifier("a column name"));
    }
    if (parts.length > 3) {
      throw syntaxError("Column reference has too many parts; expected [[tablespace.]table.]column", position);
    }
    if (this.isSymbol("(")) throw this.unsupported("Qualified function name", first);
    const name = parts.pop() as string;
    return { kind: "Column", qualifier: parts, name, position };
  }

  private parseFunctionCall(name: string, nameToken: Token): ast.Expression {
    const position = nameToken.position;
    this.expectSymbol("(");
    if (nameToken.kind === "WORD") {
      const special = this.parseSpecialFunction(name, position);
      if (special !== null) {
        this.rejectWindowClause();
        return special;
      }
    }
    const expression: ast.FunctionExpression = {
      kind: "Function", name, arguments: [], distinct: false, star: false, position,
    };
    if (this.isSymbol("*")) {
      if (name !== "COUNT") throw this.unexpected("an expression");
      this.index++;
      expression.star = true;
    } else if (!this.isSymbol(")")) {
      if (this.acceptWord("DISTINCT")) expression.distinct = true;
      else this.acceptWord("ALL");
      expression.arguments.push(this.parseExpression());
      while (this.acceptSymbol(",")) expression.arguments.push(this.parseExpression());
    }
    this.expectSymbol(")");
    this.rejectWindowClause();
    return expression;
  }

  /** 인자를 키워드로 구분하는 함수 : EXTRACT, TRIM, SUBSTRING, POSITION. 여는 괄호는 이미 읽었다. */
  private parseSpecialFunction(name: string, position: SourcePosition): ast.Expression | null {
    switch (name) {
      case "EXTRACT": {
        const field = this.current;
        if (field.kind !== "WORD" || !EXTRACT_FIELDS.has(field.text)) throw this.unexpected("a datetime field");
        this.index++;
        this.expectWord("FROM");
        const operand = this.parseExpression();
        this.expectSymbol(")");
        return { kind: "Extract", field: field.text as ast.ExtractField, operand, position };
      }
      case "TRIM": {
        let side: ast.TrimExpression["side"] = "BOTH";
        let explicitSide = false;
        const word = this.current;
        if (
          (this.isWord("LEADING") || this.isWord("TRAILING") || this.isWord("BOTH")) &&
          !this.isSymbol(")", this.peek(1)) && !this.isSymbol(",", this.peek(1))
        ) {
          side = word.text as ast.TrimExpression["side"];
          explicitSide = true;
          this.index++;
        }
        let characters: ast.Expression | null = null;
        let operand: ast.Expression;
        if (explicitSide && this.acceptWord("FROM")) {
          operand = this.parseExpression();
        } else {
          const first = this.parseExpression();
          if (this.acceptWord("FROM")) {
            characters = first;
            operand = this.parseExpression();
          } else if (explicitSide) {
            throw this.unexpected("FROM");
          } else {
            operand = first;
          }
        }
        this.expectSymbol(")");
        return { kind: "Trim", side, characters, operand, position };
      }
      case "SUBSTRING": {
        const args = [this.parseExpression()];
        if (this.acceptWord("FROM")) {
          args.push(this.parseExpression());
          if (this.acceptWord("FOR")) args.push(this.parseExpression());
        } else {
          while (this.acceptSymbol(",")) args.push(this.parseExpression());
        }
        this.expectSymbol(")");
        return { kind: "Function", name, arguments: args, distinct: false, star: false, position };
      }
      case "POSITION": {
        // `IN` 을 구분자로 읽어야 하므로 양쪽 인자는 비교 연산 없이 읽는다.
        const needle = this.parseAdditive();
        this.expectWord("IN");
        const haystack = this.parseAdditive();
        this.expectSymbol(")");
        return { kind: "Function", name, arguments: [needle, haystack], distinct: false, star: false, position };
      }
      default:
        return null;
    }
  }

  /** 윈도우 함수와 그에 딸린 절은 지원하지 않는다. (상세 16) */
  private rejectWindowClause(): void {
    // `COUNT(*) over FROM T` 처럼 OVER 를 별칭으로 쓴 경우는 뒤가 여는 괄호가 아니다.
    if (this.isWord("OVER") && this.isSymbol("(", this.peek(1))) throw this.unsupported("Window function (OVER)");
    if (this.isWord("FILTER") && this.isSymbol("(", this.peek(1))) throw this.unsupported("FILTER clause");
    if (this.isWord("WITHIN") && this.isWord("GROUP", this.peek(1))) throw this.unsupported("WITHIN GROUP");
  }

  // -------------------------------------------------------------------------
  // 데이터 타입
  // -------------------------------------------------------------------------

  /** `(n)` 또는 `(p, s)`. 없으면 빈 배열이다. */
  private parseTypeParameters(): number[] {
    if (!this.acceptSymbol("(")) return [];
    const parameters = [this.parseUnsignedInteger("a type parameter")];
    while (this.acceptSymbol(",")) parameters.push(this.parseUnsignedInteger("a type parameter"));
    this.expectSymbol(")");
    return parameters;
  }

  /** 타입 이름과 인자를 읽어 타입 정의로 해석한다. 지원하지 않는 타입은 0A000, 잘못된 인자는 22023 이다. */
  private parseDataType(): DataType {
    const start = this.current;
    if (start.kind !== "WORD") throw this.unexpected("a data type");
    this.index++;
    let name = start.text;
    const largeObject = (): void => {
      if (this.isWord("LARGE") && this.isWord("OBJECT", this.peek(1))) {
        throw unsupportedSyntax(`${name} LARGE OBJECT is not supported`, start.position);
      }
    };

    switch (name) {
      case "INTERVAL": {
        return this.resolveInterval(this.parseIntervalQualifier(start.position));
      }
      case "CHARACTER":
      case "CHAR":
      case "NCHAR":
        largeObject();
        if (this.acceptWord("VARYING")) name += " VARYING";
        break;
      case "NATIONAL":
        if (this.acceptWord("CHARACTER")) name = "NATIONAL CHARACTER";
        else if (this.acceptWord("CHAR")) name = "NATIONAL CHAR";
        else throw this.unexpected("CHARACTER or CHAR");
        largeObject();
        if (this.acceptWord("VARYING")) name += " VARYING";
        break;
      case "BINARY":
        largeObject();
        if (this.acceptWord("VARYING")) name = "BINARY VARYING";
        break;
      case "DOUBLE":
        this.expectWord("PRECISION");
        name = "DOUBLE PRECISION";
        break;
      case "TIME":
      case "TIMESTAMP": {
        const parameters = this.parseTypeParameters();
        if (this.isWord("WITH") && this.isWord("TIME", this.peek(1))) {
          this.index += 2;
          this.expectWord("ZONE");
          name += " WITH TIME ZONE";
        } else if (this.isWord("WITHOUT") && this.isWord("TIME", this.peek(1))) {
          this.index += 2;
          this.expectWord("ZONE");
        }
        return this.located(start.position, () => resolveDataType(name, ...parameters));
      }
      default:
        break;
    }
    const parameters = this.parseTypeParameters();
    return this.located(start.position, () => resolveDataType(name, ...parameters));
  }

  // -------------------------------------------------------------------------
  // DML
  // -------------------------------------------------------------------------

  /** 값 자리. INSERT 의 VALUES 와 UPDATE 의 SET 에서는 `DEFAULT` 도 올 수 있다. */
  private parseValueOrDefault(): ast.Expression {
    if (this.isWord("DEFAULT")) return { kind: "Default", position: this.advance().position };
    return this.parseExpression();
  }

  private parseInsert(): ast.InsertStatement {
    this.expectWord("INSERT");
    if (this.isWord("ALL")) throw this.unsupported("INSERT ALL");
    this.acceptWord("INTO");
    const target = this.parseObjectName("a table name");
    // 여는 괄호 뒤가 SELECT 이면 컬럼 목록이 아니라 괄호로 감싼 질의이다.
    const columns = this.isSymbol("(") && !this.lookaheadQuery().isQuery
      ? this.parseIdentifierList("a column name")
      : null;

    let source: ast.InsertSource;
    if (this.acceptWord("VALUES")) {
      const rows: ast.Expression[][] = [];
      do {
        this.expectSymbol("(");
        const row = [this.parseValueOrDefault()];
        while (this.acceptSymbol(",")) row.push(this.parseValueOrDefault());
        this.expectSymbol(")");
        rows.push(row);
      } while (this.acceptSymbol(","));
      source = { kind: "Values", rows };
    } else if (this.isWord("DEFAULT")) {
      this.index++;
      this.expectWord("VALUES");
      source = { kind: "DefaultValues" };
    } else if (this.isWord("SELECT") || this.isSymbol("(")) {
      source = { kind: "Query", query: this.parseQuery() };
    } else {
      throw this.unexpected("VALUES, DEFAULT VALUES or SELECT");
    }
    this.rejectDmlExtensions();
    return { kind: "Insert", target, columns, source };
  }

  private rejectDmlExtensions(): void {
    if (this.isWord("RETURNING")) throw this.unsupported("RETURNING");
    if (this.isWord("ON")) throw this.unsupported("ON CONFLICT / ON DUPLICATE KEY");
  }

  private parseUpdate(): ast.UpdateStatement {
    this.expectWord("UPDATE");
    const target = this.parseObjectName("a table name");
    const alias = this.parseOptionalAlias();
    this.expectWord("SET");
    const assignments: ast.Assignment[] = [];
    do {
      if (this.isSymbol("(")) throw this.unsupported("Multiple-column assignment");
      const column = this.parseIdentifier("a column name");
      if (this.isSymbol(".")) {
        throw syntaxError("Column name in SET must not be qualified", this.current.position);
      }
      this.expectSymbol("=");
      assignments.push({ column, value: this.parseValueOrDefault() });
    } while (this.acceptSymbol(","));
    if (this.isWord("FROM")) throw this.unsupported("UPDATE ... FROM");
    const where = this.acceptWord("WHERE") ? this.parseExpression() : null;
    this.rejectDmlExtensions();
    return { kind: "Update", target, alias, assignments, where };
  }

  private parseDelete(): ast.DeleteStatement {
    this.expectWord("DELETE");
    this.acceptWord("FROM");
    const target = this.parseObjectName("a table name");
    const alias = this.parseOptionalAlias();
    if (this.isWord("USING")) throw this.unsupported("DELETE ... USING");
    const where = this.acceptWord("WHERE") ? this.parseExpression() : null;
    this.rejectDmlExtensions();
    return { kind: "Delete", target, alias, where };
  }

  // -------------------------------------------------------------------------
  // DDL
  // -------------------------------------------------------------------------

  private parseCreate(): ast.Statement {
    this.expectWord("CREATE");
    if (this.isWord("OR")) {
      this.index++;
      this.expectWord("REPLACE");
      if (!this.isWord("VIEW")) {
        if (this.current.kind === "WORD" && UNSUPPORTED_OBJECTS.has(this.current.text)) {
          throw this.unsupported(`CREATE OR REPLACE ${this.current.text}`);
        }
        throw this.unexpected("VIEW");
      }
      this.index++;
      return this.parseCreateView(true);
    }
    const token = this.current;
    if (token.kind === "WORD") {
      switch (token.text) {
        case "TABLE":
          this.index++;
          return this.parseCreateTable();
        case "VIEW":
          this.index++;
          return this.parseCreateView(false);
        case "INDEX":
          this.index++;
          return this.parseCreateIndex();
        case "UNIQUE":
          throw this.unsupported("CREATE UNIQUE INDEX");
        case "TABLESPACE":
          this.index++;
          return this.parseCreateTablespace();
        case "USER":
          this.index++;
          return this.parseCreateUser();
        default:
          if (UNSUPPORTED_OBJECTS.has(token.text)) throw this.unsupported(`CREATE ${token.text}`);
      }
    }
    throw this.unexpected("TABLE, VIEW, INDEX, TABLESPACE or USER");
  }

  private parseCreateTable(): ast.CreateTableStatement {
    let ifNotExists = false;
    if (this.isWord("IF") && this.isWord("NOT", this.peek(1))) {
      this.index += 2;
      this.expectWord("EXISTS");
      ifNotExists = true;
    }
    const name = this.parseObjectName("a table name");
    if (this.isWord("AS")) throw this.unsupported("CREATE TABLE ... AS SELECT");
    const open = this.expectSymbol("(");
    const columns: ast.ColumnDefinition[] = [];
    const constraints: ast.TableConstraint[] = [];
    do {
      if (this.isConstraintStart()) constraints.push(this.parseTableConstraint());
      else columns.push(this.parseColumnDefinition());
    } while (this.acceptSymbol(","));
    this.expectSymbol(")");
    if (columns.length === 0) throw syntaxError("A table must have at least one column", open.position);
    if (this.isWord("PARTITION")) throw this.unsupported("Partitioning");
    if (this.isWord("AS")) throw this.unsupported("CREATE TABLE ... AS SELECT");
    return { kind: "CreateTable", name, ifNotExists, columns, constraints };
  }

  private isConstraintStart(): boolean {
    return (
      this.isWord("CONSTRAINT") || this.isWord("PRIMARY") || this.isWord("FOREIGN") ||
      this.isWord("UNIQUE") || this.isWord("CHECK")
    );
  }

  /** UNIQUE, CHECK 는 지원하지 않는 제약조건이다. (상세 11) */
  private rejectUnsupportedConstraint(): void {
    if (this.isWord("UNIQUE") || this.isWord("CHECK")) throw this.unsupported(`${this.current.text} constraint`);
  }

  private parseTableConstraint(): ast.TableConstraint {
    const name = this.acceptWord("CONSTRAINT") ? this.parseIdentifier("a constraint name") : null;
    this.rejectUnsupportedConstraint();
    if (this.acceptWord("PRIMARY")) {
      this.expectWord("KEY");
      return { kind: "PrimaryKey", name, columns: this.parseIdentifierList("a column name") };
    }
    if (this.acceptWord("FOREIGN")) {
      this.expectWord("KEY");
      const columns = this.parseIdentifierList("a column name");
      this.expectWord("REFERENCES");
      return { kind: "ForeignKey", name, columns, reference: this.parseForeignKeyReference() };
    }
    throw this.unexpected("PRIMARY KEY or FOREIGN KEY");
  }

  /** `테이블 [(컬럼, ...)] [ON DELETE 동작] [ON UPDATE 동작]`. REFERENCES 는 이미 읽었다. */
  private parseForeignKeyReference(): ast.ForeignKeyReference {
    const table = this.parseObjectName("a table name");
    const columns = this.isSymbol("(") ? this.parseIdentifierList("a column name") : null;
    const reference: ast.ForeignKeyReference = { table, columns, onDelete: null, onUpdate: null };
    if (this.isWord("MATCH")) throw this.unsupported("MATCH");
    while (this.isWord("ON")) {
      const on = this.advance();
      let key: "onDelete" | "onUpdate";
      if (this.acceptWord("DELETE")) key = "onDelete";
      else if (this.acceptWord("UPDATE")) key = "onUpdate";
      else throw this.unexpected("DELETE or UPDATE");
      if (reference[key] !== null) {
        throw syntaxError("Referential action is specified more than once", on.position);
      }
      reference[key] = this.parseReferentialAction();
    }
    if (this.isWord("DEFERRABLE") || this.isWord("INITIALLY")) throw this.unsupported("Deferrable constraint");
    if (this.isWord("NOT") && this.isWord("DEFERRABLE", this.peek(1))) this.index += 2;
    return reference;
  }

  private parseReferentialAction(): ast.ReferentialAction {
    if (this.acceptWord("CASCADE")) return "CASCADE";
    if (this.acceptWord("RESTRICT")) return "RESTRICT";
    if (this.acceptWord("NO")) {
      this.expectWord("ACTION");
      return "NO ACTION";
    }
    if (this.acceptWord("SET")) {
      if (this.isWord("DEFAULT")) throw this.unsupported("SET DEFAULT referential action");
      this.expectWord("NULL");
      return "SET NULL";
    }
    throw this.unexpected("NO ACTION, RESTRICT, CASCADE or SET NULL");
  }

  private parseColumnDefinition(): ast.ColumnDefinition {
    const name = this.parseIdentifier("a column name");
    const dataType = this.parseDataType();
    const column: ast.ColumnDefinition = {
      name, dataType, default: null, notNull: false, primaryKey: null, references: null,
    };
    let nullable = false;
    for (;;) {
      const token = this.current;
      const duplicate = (what: string): DbError =>
        syntaxError(`${what} is specified more than once for column "${name}"`, token.position);

      if (this.isWord("DEFAULT")) {
        if (column.default !== null) throw duplicate("DEFAULT");
        this.index++;
        column.default = this.parseAdditive();
        continue;
      }
      if (this.isWord("GENERATED") || this.isWord("IDENTITY") || this.isWord("AUTO_INCREMENT")) {
        throw this.unsupported("IDENTITY column");
      }
      if (this.isWord("COLLATE")) throw this.unsupported("COLLATE");

      const constraintName = this.acceptWord("CONSTRAINT") ? this.parseIdentifier("a constraint name") : null;
      this.rejectUnsupportedConstraint();
      if (this.isWord("NOT") && this.isWord("NULL", this.peek(1))) {
        this.index += 2;
        column.notNull = true;
      } else if (this.acceptWord("NULL")) {
        nullable = true;
      } else if (this.acceptWord("PRIMARY")) {
        this.expectWord("KEY");
        if (column.primaryKey !== null) throw duplicate("PRIMARY KEY");
        column.primaryKey = { name: constraintName };
      } else if (this.acceptWord("REFERENCES")) {
        if (column.references !== null) throw duplicate("REFERENCES");
        column.references = { ...this.parseForeignKeyReference(), name: constraintName };
      } else if (constraintName !== null) {
        throw this.unexpected("NOT NULL, PRIMARY KEY or REFERENCES");
      } else {
        break;
      }
      if (column.notNull && nullable) {
        throw syntaxError(`Column "${name}" is declared both NULL and NOT NULL`, token.position);
      }
    }
    return column;
  }

  private parseCreateView(orReplace: boolean): ast.CreateViewStatement {
    if (this.isWord("IF") && this.isWord("NOT", this.peek(1))) throw this.unsupported("CREATE VIEW IF NOT EXISTS");
    const name = this.parseObjectName("a view name");
    const columns = this.isSymbol("(") ? this.parseIdentifierList("a column name") : null;
    this.expectWord("AS");
    const start = this.current;
    const parametersBefore = this.parameterCount;
    const query = this.parseQuery();
    if (this.parameterCount !== parametersBefore) {
      throw syntaxError("Parameters cannot be used in a view definition", start.position);
    }
    const queryText = this.sql.slice(start.position.offset, this.previousEnd);
    if (this.isWord("WITH")) throw this.unsupported("WITH CHECK OPTION");
    return { kind: "CreateView", name, orReplace, columns, query, queryText };
  }

  private parseCreateIndex(): ast.CreateIndexStatement {
    if (this.isWord("IF") && this.isWord("NOT", this.peek(1))) throw this.unsupported("CREATE INDEX IF NOT EXISTS");
    const name = this.isWord("ON") ? null : this.parseObjectName("an index name");
    this.expectWord("ON");
    const table = this.parseObjectName("a table name");
    if (this.isWord("USING")) throw this.unsupported("Index method (USING)");
    this.expectSymbol("(");
    const columns: ast.IndexColumn[] = [];
    do {
      if (this.isSymbol("(")) throw this.unsupported("Function-based index");
      const column = this.parseIdentifier("a column name");
      if (this.current.kind === "SYMBOL" && !this.isSymbol(",") && !this.isSymbol(")")) {
        throw this.unsupported("Function-based index");
      }
      let descending = false;
      if (this.acceptWord("DESC")) descending = true;
      else this.acceptWord("ASC");
      if (this.isWord("NULLS")) throw this.unsupported("NULLS FIRST / NULLS LAST in an index");
      columns.push({ name: column, descending });
    } while (this.acceptSymbol(","));
    this.expectSymbol(")");
    if (this.isWord("WHERE")) throw this.unsupported("Partial index");
    return { kind: "CreateIndex", name, table, columns };
  }

  private parseCreateTablespace(): ast.CreateTablespaceStatement {
    const statement: ast.CreateTablespaceStatement = {
      kind: "CreateTablespace",
      name: this.parseIdentifier("a tablespace name"),
      dataFile: null,
      characterSet: null,
    };
    for (;;) {
      const token = this.current;
      if (this.isWord("DATAFILE")) {
        if (statement.dataFile !== null) throw syntaxError("DATAFILE is specified more than once", token.position);
        this.index++;
        statement.dataFile = this.parseStringLiteral("a data file path");
      } else if (this.isWord("CHARACTER")) {
        if (statement.characterSet !== null) {
          throw syntaxError("CHARACTER SET is specified more than once", token.position);
        }
        this.index++;
        this.expectWord("SET");
        statement.characterSet = this.current.kind === "STRING"
          ? this.advance().text.toUpperCase()
          : this.parseIdentifier("a character set name").toUpperCase();
      } else {
        return statement;
      }
    }
  }

  /** `IDENTIFIED BY '비밀번호'`. 비밀번호는 문자열 리터럴이어야 한다. */
  private parsePassword(): string {
    this.expectWord("IDENTIFIED");
    this.expectWord("BY");
    return this.parseStringLiteral("a password string");
  }

  private parseCreateUser(): ast.CreateUserStatement {
    const name = this.parseIdentifier("a user name");
    const password = this.parsePassword();
    let defaultTablespace: string | null = null;
    if (this.acceptWord("DEFAULT")) {
      this.expectWord("TABLESPACE");
      defaultTablespace = this.parseIdentifier("a tablespace name");
    }
    return { kind: "CreateUser", name, password, defaultTablespace };
  }

  private parseAlter(): ast.Statement {
    this.expectWord("ALTER");
    if (this.acceptWord("TABLE")) return this.parseAlterTable();
    if (this.acceptWord("USER")) return this.parseAlterUser();
    const token = this.current;
    if (token.kind === "WORD" && (UNSUPPORTED_OBJECTS.has(token.text) || ["TABLESPACE", "INDEX", "VIEW"].includes(token.text))) {
      throw this.unsupported(`ALTER ${token.text}`);
    }
    throw this.unexpected("TABLE or USER");
  }

  private parseAlterTable(): ast.AlterTableStatement {
    const name = this.parseObjectName("a table name");
    return { kind: "AlterTable", name, action: this.parseAlterTableAction() };
  }

  private parseAlterTableAction(): ast.AlterTableAction {
    if (this.acceptWord("ADD")) {
      if (this.isConstraintStart()) return { kind: "AddConstraint", constraint: this.parseTableConstraint() };
      this.acceptColumnKeyword();
      return { kind: "AddColumn", column: this.parseColumnDefinition() };
    }
    if (this.acceptWord("DROP")) {
      if (this.acceptWord("CONSTRAINT")) {
        return { kind: "DropConstraint", name: this.parseIdentifier("a constraint name") };
      }
      if (this.isWord("PRIMARY")) throw this.unsupported("DROP PRIMARY KEY; use DROP CONSTRAINT");
      this.acceptColumnKeyword();
      const column = this.parseIdentifier("a column name");
      if (this.isWord("CASCADE")) throw this.unsupported("DROP COLUMN ... CASCADE");
      this.acceptWord("RESTRICT");
      return { kind: "DropColumn", column };
    }
    if (this.acceptWord("ALTER")) {
      this.acceptColumnKeyword();
      const column = this.parseIdentifier("a column name");
      return { kind: "AlterColumn", column, change: this.parseAlterColumnChange() };
    }
    if (this.acceptWord("RENAME")) {
      if (this.acceptWord("TO")) return { kind: "RenameTable", newName: this.parseIdentifier("a table name") };
      this.acceptColumnKeyword();
      const column = this.parseIdentifier("a column name");
      this.expectWord("TO");
      return { kind: "RenameColumn", column, newName: this.parseIdentifier("a column name") };
    }
    if (this.isWord("MODIFY")) throw this.unsupported("ALTER TABLE ... MODIFY");
    throw this.unexpected("ADD, DROP, ALTER or RENAME");
  }

  /** `COLUMN` 은 생략할 수 있다. 컬럼 이름이 COLUMN 인 경우와 구별하려고 뒤에 이름이 이어지는지 본다. */
  private acceptColumnKeyword(): void {
    if (this.isWord("COLUMN") && this.isIdentifier(this.peek(1))) this.index++;
  }

  private parseAlterColumnChange(): ast.AlterColumnChange {
    if (this.acceptWord("SET")) {
      if (this.acceptWord("DEFAULT")) return { kind: "SetDefault", expression: this.parseAdditive() };
      if (this.acceptWord("NOT")) {
        this.expectWord("NULL");
        return { kind: "SetNotNull" };
      }
      if (this.isWord("DATA")) throw this.unsupported("Changing a column data type");
      throw this.unexpected("DEFAULT or NOT NULL");
    }
    if (this.acceptWord("DROP")) {
      if (this.acceptWord("DEFAULT")) return { kind: "DropDefault" };
      if (this.acceptWord("NOT")) {
        this.expectWord("NULL");
        return { kind: "DropNotNull" };
      }
      throw this.unexpected("DEFAULT or NOT NULL");
    }
    if (this.isWord("TYPE")) throw this.unsupported("Changing a column data type");
    throw this.unexpected("SET or DROP");
  }

  private parseAlterUser(): ast.AlterUserStatement {
    const statement: ast.AlterUserStatement = {
      kind: "AlterUser", name: this.parseIdentifier("a user name"), password: null, defaultTablespace: null,
    };
    for (;;) {
      const token = this.current;
      if (this.isWord("IDENTIFIED")) {
        if (statement.password !== null) throw syntaxError("Password is specified more than once", token.position);
        statement.password = this.parsePassword();
      } else if (this.isWord("DEFAULT")) {
        if (statement.defaultTablespace !== null) {
          throw syntaxError("DEFAULT TABLESPACE is specified more than once", token.position);
        }
        this.index++;
        this.expectWord("TABLESPACE");
        statement.defaultTablespace = this.parseIdentifier("a tablespace name");
      } else if (statement.password === null && statement.defaultTablespace === null) {
        throw this.unexpected("IDENTIFIED BY or DEFAULT TABLESPACE");
      } else {
        return statement;
      }
    }
  }

  private parseDrop(): ast.Statement {
    this.expectWord("DROP");
    if (this.acceptWord("TABLE")) {
      const ifExists = this.parseIfExists();
      const name = this.parseObjectName("a table name");
      return { kind: "DropTable", name, ifExists, behavior: this.parseDropBehavior() };
    }
    if (this.acceptWord("VIEW")) {
      const ifExists = this.parseIfExists();
      const name = this.parseObjectName("a view name");
      return { kind: "DropView", name, ifExists, behavior: this.parseDropBehavior() };
    }
    if (this.acceptWord("INDEX")) {
      return { kind: "DropIndex", name: this.parseObjectName("an index name") };
    }
    if (this.acceptWord("TABLESPACE")) {
      const name = this.parseIdentifier("a tablespace name");
      let includingContents = false;
      if (this.acceptWord("INCLUDING")) {
        this.expectWord("CONTENTS");
        includingContents = true;
        // 데이터 파일은 항상 함께 지우므로 Oracle 의 `AND DATAFILES` 는 적어도 뜻이 같다.
        if (this.acceptWord("AND")) this.expectWord("DATAFILES");
      }
      return { kind: "DropTablespace", name, includingContents };
    }
    if (this.acceptWord("USER")) {
      const name = this.parseIdentifier("a user name");
      return { kind: "DropUser", name, cascade: this.acceptWord("CASCADE") };
    }
    const token = this.current;
    if (token.kind === "WORD" && UNSUPPORTED_OBJECTS.has(token.text)) throw this.unsupported(`DROP ${token.text}`);
    throw this.unexpected("TABLE, VIEW, INDEX, TABLESPACE or USER");
  }

  private parseIfExists(): boolean {
    if (!this.isWord("IF") || !this.isWord("EXISTS", this.peek(1))) return false;
    this.index += 2;
    return true;
  }

  private parseDropBehavior(): ast.DropBehavior | null {
    if (this.acceptWord("RESTRICT")) return "RESTRICT";
    if (this.acceptWord("CASCADE")) return "CASCADE";
    return null;
  }

  private parseTruncate(): ast.TruncateTableStatement {
    this.expectWord("TRUNCATE");
    this.acceptWord("TABLE");
    return { kind: "TruncateTable", name: this.parseObjectName("a table name") };
  }

  // -------------------------------------------------------------------------
  // 권한
  // -------------------------------------------------------------------------

  private parseGrantOrRevoke(kind: "Grant" | "Revoke"): ast.PrivilegeStatement | ast.PrivilegeGroupStatement {
    this.index++;
    const connector = kind === "Grant" ? "TO" : "FROM";
    if (kind === "Revoke" && this.isWord("GRANT") && this.isWord("OPTION", this.peek(1))) {
      throw this.unsupported("GRANT OPTION FOR");
    }

    let privileges: ast.Privilege[] | "ALL" | null = null;
    const groups: ast.PrivilegeGroup[] = [];
    if (this.acceptWord("ALL")) {
      this.acceptWord("PRIVILEGES");
      privileges = "ALL";
    } else {
      const list: ast.Privilege[] = [];
      do {
        const token = this.current;
        if (token.kind !== "WORD") throw this.unexpected("a privilege or a privilege group");
        if (PRIVILEGES.has(token.text)) {
          list.push(token.text as ast.Privilege);
        } else if (PRIVILEGE_GROUPS.has(token.text)) {
          groups.push(token.text as ast.PrivilegeGroup);
        } else if (UNSUPPORTED_PRIVILEGES.has(token.text)) {
          throw this.unsupported(`Privilege ${token.text}`);
        } else if (RESERVED_WORDS.has(token.text)) {
          throw this.unexpected("a privilege or a privilege group");
        } else {
          throw this.unsupported("User-defined privilege group (role)");
        }
        this.index++;
        if (this.isSymbol("(")) throw this.unsupported("Column privilege");
      } while (this.acceptSymbol(","));
      if (groups.length > 0 && list.length > 0) {
        throw syntaxError("Privileges and privilege groups cannot be mixed in one statement", this.current.position);
      }
      if (list.length > 0) privileges = list;
    }

    if (privileges === null) {
      this.expectWord(connector);
      const users = this.parseUserList();
      this.rejectGrantOptions(kind);
      return { kind: kind === "Grant" ? "GrantGroup" : "RevokeGroup", groups, users };
    }

    this.expectWord("ON");
    const target = this.parsePrivilegeTarget();
    this.expectWord(connector);
    const users = this.parseUserList();
    this.rejectGrantOptions(kind);
    return { kind, privileges, target, users };
  }

  /** `TABLESPACE 이름` 또는 `[TABLE | VIEW] [테이블스페이스명.]객체명` */
  private parsePrivilegeTarget(): ast.PrivilegeTarget {
    // 종류를 뜻하는 단어 뒤에 이름이 이어질 때만 종류로 본다. (이름이 VIEW, TABLESPACE 인 객체와 구별)
    const followedByName = this.isIdentifier(this.peek(1));
    if (this.isWord("TABLESPACE") && followedByName) {
      this.index++;
      const position = this.current.position;
      return { kind: "Tablespace", name: this.parseIdentifier("a tablespace name"), position };
    }
    let objectType: "TABLE" | "VIEW" | null = null;
    if (this.isWord("TABLE")) {
      this.index++;
      objectType = "TABLE";
    } else if (this.isWord("VIEW") && followedByName) {
      this.index++;
      objectType = "VIEW";
    }
    return { kind: "Object", objectType, name: this.parseObjectName("an object name") };
  }

  private parseUserList(): string[] {
    const users: string[] = [];
    do {
      if (this.isWord("PUBLIC")) throw this.unsupported("PUBLIC");
      users.push(this.parseIdentifier("a user name"));
    } while (this.acceptSymbol(","));
    return users;
  }

  /** 부여받은 권한을 다시 부여하는 기능과 그에 딸린 문법은 지원하지 않는다. (상세 5) */
  private rejectGrantOptions(kind: "Grant" | "Revoke"): void {
    if (kind === "Grant" && this.isWord("WITH")) throw this.unsupported("WITH GRANT OPTION");
    if (kind === "Revoke" && (this.isWord("CASCADE") || this.isWord("RESTRICT"))) {
      throw this.unsupported(`REVOKE ... ${this.current.text}`);
    }
  }

  // -------------------------------------------------------------------------
  // 트랜잭션과 세션
  // -------------------------------------------------------------------------

  private parseBegin(): ast.BeginStatement {
    this.expectWord("BEGIN");
    if (!this.acceptWord("WORK")) this.acceptWord("TRANSACTION");
    this.parseTransactionModes();
    return { kind: "Begin" };
  }

  private parseStartTransaction(): ast.BeginStatement {
    this.expectWord("START");
    this.expectWord("TRANSACTION");
    this.parseTransactionModes();
    return { kind: "Begin" };
  }

  /** 격리 수준은 READ COMMITTED 하나만 지원한다. 그 밖의 트랜잭션 속성은 0A000 이다. */
  private parseTransactionModes(): void {
    if (this.isWord("ISOLATION")) this.parseIsolationLevel();
    if (this.isWord("READ") && (this.isWord("ONLY", this.peek(1)) || this.isWord("WRITE", this.peek(1)))) {
      throw this.unsupported("Transaction access mode");
    }
  }

  private parseIsolationLevel(): void {
    this.expectWord("ISOLATION");
    this.expectWord("LEVEL");
    const start = this.current;
    if (this.acceptWord("READ")) {
      if (this.acceptWord("COMMITTED")) return;
      if (this.isWord("UNCOMMITTED")) throw this.unsupported("Isolation level READ UNCOMMITTED", start);
      throw this.unexpected("COMMITTED");
    }
    if (this.isWord("REPEATABLE") || this.isWord("SERIALIZABLE") || this.isWord("SNAPSHOT")) {
      throw this.unsupported(`Isolation level ${start.text}`, start);
    }
    throw this.unexpected("READ COMMITTED");
  }

  private rejectChain(): void {
    if (this.isWord("AND")) throw this.unsupported("AND CHAIN");
  }

  private parseCommit(): ast.CommitStatement {
    this.expectWord("COMMIT");
    this.acceptWord("WORK");
    this.rejectChain();
    return { kind: "Commit" };
  }

  /** `SAVEPOINT` 는 생략할 수 있다. 세이브포인트 이름이 SAVEPOINT 인 경우와 구별하려고 뒤에 이름이 이어지는지 본다. */
  private acceptSavepointKeyword(): void {
    if (this.isWord("SAVEPOINT") && this.isIdentifier(this.peek(1))) this.index++;
  }

  private parseRollback(): ast.RollbackStatement {
    this.expectWord("ROLLBACK");
    this.acceptWord("WORK");
    this.rejectChain();
    if (!this.acceptWord("TO")) return { kind: "Rollback", savepoint: null };
    this.acceptSavepointKeyword();
    return { kind: "Rollback", savepoint: this.parseIdentifier("a savepoint name") };
  }

  private parseSavepoint(): ast.SavepointStatement {
    this.expectWord("SAVEPOINT");
    return { kind: "Savepoint", name: this.parseIdentifier("a savepoint name") };
  }

  private parseReleaseSavepoint(): ast.ReleaseSavepointStatement {
    this.expectWord("RELEASE");
    this.acceptSavepointKeyword();
    return { kind: "ReleaseSavepoint", name: this.parseIdentifier("a savepoint name") };
  }

  private parseUse(): ast.UseStatement {
    this.expectWord("USE");
    return { kind: "Use", tablespace: this.parseIdentifier("a tablespace name") };
  }

  private parseSet(): ast.Statement {
    this.expectWord("SET");
    if (this.acceptWord("AUTOCOMMIT")) {
      if (!this.acceptSymbol("=")) this.acceptWord("TO");
      const token = this.current;
      const text = token.kind === "WORD" || token.kind === "NUMBER" ? token.text : "";
      if (text === "ON" || text === "TRUE" || text === "1") {
        this.index++;
        return { kind: "SetAutocommit", value: true };
      }
      if (text === "OFF" || text === "FALSE" || text === "0") {
        this.index++;
        return { kind: "SetAutocommit", value: false };
      }
      throw this.unexpected("ON or OFF");
    }
    if (this.isWord("TIME") && this.isWord("ZONE", this.peek(1))) {
      this.index += 2;
      return { kind: "SetTimeZone", zone: this.parseTimeZoneValue() };
    }
    if (this.acceptWord("TRANSACTION")) {
      if (!this.isWord("ISOLATION")) {
        if (this.isWord("READ")) throw this.unsupported("Transaction access mode");
        throw this.unexpected("ISOLATION LEVEL");
      }
      this.parseIsolationLevel();
      return { kind: "SetTransaction", isolationLevel: "READ COMMITTED" };
    }
    if (this.isWord("SESSION") || this.isWord("ROLE") || this.isWord("SCHEMA") || this.isWord("CONSTRAINTS")) {
      throw this.unsupported(`SET ${this.current.text}`);
    }
    throw this.unexpected("AUTOCOMMIT, TIME ZONE or TRANSACTION");
  }

  /** `'Asia/Seoul'`, `'+09:00'`, `LOCAL`, `INTERVAL '+09:00' HOUR TO MINUTE` */
  private parseTimeZoneValue(): string {
    if (this.current.kind === "STRING") return this.advance().text;
    if (this.acceptWord("LOCAL")) return "local";
    if (this.isWord("INTERVAL")) {
      const literal = this.parseIntervalLiteral();
      const { startField, endField } = literal.qualifier;
      const match = /^([+-])?\s*(\d{1,2}):(\d{2})$/.exec(literal.text);
      if (startField !== "HOUR" || endField !== "MINUTE" || match === null) {
        throw syntaxError("Time zone displacement must be INTERVAL '[+|-]HH:MM' HOUR TO MINUTE", literal.position);
      }
      return `${match[1] ?? "+"}${(match[2] as string).padStart(2, "0")}:${match[3] as string}`;
    }
    throw this.unexpected("a time zone string, LOCAL or INTERVAL");
  }
}

/**
 * SQL 문장 하나를 구문 트리로 만든다. 문장 끝의 `;` 는 있어도 되고 없어도 된다.
 *  - 문법이 틀리면 42601 (위치 포함), 식별자가 너무 길면 42622
 *  - 너무 깊이 겹쳤거나 연산이 너무 길게 이어져 한도를 넘으면 54001
 *  - 지원하지 않는 문법이나 타입은 0A000, 타입 인자가 잘못되면 22023
 */
export function parseStatement(sql: string): ast.ParsedStatement {
  return new Parser(sql).parse();
}
