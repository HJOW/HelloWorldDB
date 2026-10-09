/**
 * 담당 : 질의(SELECT)의 구문 분석. 선택 목록, FROM 과 조인, 조건, 묶기, 집합 연산, 정렬, 행 수 제한.
 * 관련 사양 : AGENTS.md 상세 1-4, 13.
 * 구현 단계 : 4단계.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DbError } from "../../src/common/errors.js";
import type * as ast from "../../src/sql/ast.js";
import { MAX_NESTING_DEPTH, MAX_TREE_DEPTH, parseStatement } from "../../src/sql/parser.js";
import { assertSyntaxError, assertTooComplex, assertUnsupported, parse, query as q } from "./helpers.js";

test("Hello World : FROM 절 없는 질의와 가장 단순한 조회", () => {
  assert.equal(q("SELECT 'Hello World'"), "{SELECT 'Hello World'}");
  assert.equal(q("SELECT * FROM HELLO"), "{SELECT * FROM HELLO}");
  assert.equal(q("select 1 + 1"), "{SELECT (+ 1 1)}");
  assert.equal(q("SELECT 1 FROM SYSTEM.DUAL"), "{SELECT 1 FROM SYSTEM.DUAL}");
  // 문장 끝의 세미콜론은 있어도 되고 없어도 된다.
  assert.deepEqual(parse("SELECT 1;"), parse("SELECT 1"));
  assert.deepEqual(parse("  SELECT 1  ;  -- 끝"), parse("SELECT 1"));
});

test("질의의 구문 트리 : 생략한 부분은 비어 있는 채로 남는다", () => {
  assert.deepEqual(parse("SELECT a FROM t"), {
    kind: "Query",
    body: {
      kind: "Select",
      distinct: false,
      items: [{ kind: "Expression", expression: { kind: "Column", qualifier: [], name: "A" }, alias: null }],
      from: [{ kind: "Table", name: { tablespace: null, name: "T" }, alias: null }],
      where: null,
      groupBy: [],
      having: null,
    },
    orderBy: [],
    offset: null,
    fetch: null,
    forUpdate: false,
  });
});

test("선택 목록 : *, 테이블.*, 별칭", () => {
  assert.equal(q("SELECT * FROM t"), "{SELECT * FROM T}");
  assert.equal(q("SELECT t.* FROM t"), "{SELECT T.* FROM T}");
  assert.equal(q("SELECT app.t.*, u.id FROM app.t, u"), "{SELECT APP.T.*, U.ID FROM APP.T, U}");
  assert.equal(q("SELECT *, a FROM t"), "{SELECT *, A FROM T}");
  assert.equal(q("SELECT a AS x, b y, c FROM t"), "{SELECT A AS X, B AS Y, C FROM T}");
  assert.equal(q('SELECT a AS "별 칭", b "select" FROM t'), "{SELECT A AS 별 칭, B AS select FROM T}");
  assert.equal(q("SELECT a + 1 total, COUNT(*) cnt FROM t"), "{SELECT (+ A 1) AS TOTAL, (COUNT *) AS CNT FROM T}");
  assert.equal(q("SELECT DISTINCT a, b FROM t"), "{SELECT DISTINCT A, B FROM T}");
  assert.equal(q("SELECT ALL a FROM t"), "{SELECT A FROM T}");
  // 예약어가 아닌 키워드는 별칭으로 쓸 수 있다.
  assert.equal(q("SELECT a date, b key, c first FROM t"), "{SELECT A AS DATE, B AS KEY, C AS FIRST FROM T}");
  assertSyntaxError("SELECT a AS FROM t", { line: 1, column: 13 }, /Reserved word "FROM"/);
  assertSyntaxError("SELECT a AS 'x' FROM t");
  assertSyntaxError("SELECT t.*.* FROM t");
  assertUnsupported("SELECT a INTO b FROM t");
});

test("FROM : 테이블스페이스를 붙인 이름, 별칭, 쉼표 나열", () => {
  assert.equal(q("SELECT * FROM app.orders"), "{SELECT * FROM APP.ORDERS}");
  assert.equal(q("SELECT * FROM orders o"), "{SELECT * FROM ORDERS AS O}");
  assert.equal(q("SELECT * FROM orders AS o, app.users u"), "{SELECT * FROM ORDERS AS O, APP.USERS AS U}");
  assert.equal(q('SELECT * FROM "My Space"."주문 테이블" x'), "{SELECT * FROM My Space.주문 테이블 AS X}");
  assertSyntaxError("SELECT * FROM a.b.c", { line: 1, column: 18 }, /too many parts/);
  assertSyntaxError("SELECT * FROM", { line: 1, column: 14 });
  assertSyntaxError("SELECT * FROM t,", { line: 1, column: 17 });
  assertSyntaxError("SELECT * FROM 'T'");
  assertSyntaxError("SELECT * FROM t AS", { line: 1, column: 19 });
});

test("조인 : INNER 와 OUTER 는 생략할 수 있다", () => {
  assert.equal(q("SELECT * FROM a JOIN b ON a.id = b.id"), "{SELECT * FROM (INNER A B ON (= A.ID B.ID))}");
  assert.equal(q("SELECT * FROM a INNER JOIN b ON a.id = b.id"), "{SELECT * FROM (INNER A B ON (= A.ID B.ID))}");
  assert.equal(q("SELECT * FROM a LEFT JOIN b ON a.id = b.id"), "{SELECT * FROM (LEFT A B ON (= A.ID B.ID))}");
  assert.equal(q("SELECT * FROM a LEFT OUTER JOIN b ON a.id = b.id"), "{SELECT * FROM (LEFT A B ON (= A.ID B.ID))}");
  assert.equal(q("SELECT * FROM a RIGHT JOIN b USING (id)"), "{SELECT * FROM (RIGHT A B USING(ID))}");
  assert.equal(q("SELECT * FROM a FULL OUTER JOIN b USING (id, kind)"), "{SELECT * FROM (FULL A B USING(ID,KIND))}");
  assert.equal(q("SELECT * FROM a CROSS JOIN b"), "{SELECT * FROM (CROSS A B)}");
  // 조인은 왼쪽부터 묶인다.
  assert.equal(
    q("SELECT * FROM a x JOIN b y ON x.id = y.id LEFT JOIN c z ON y.id = z.id CROSS JOIN d"),
    "{SELECT * FROM (CROSS (LEFT (INNER A AS X B AS Y ON (= X.ID Y.ID)) C AS Z ON (= Y.ID Z.ID)) D)}",
  );
  // 괄호로 묶는 순서를 바꿀 수 있다.
  assert.equal(
    q("SELECT * FROM a JOIN (b JOIN c ON b.id = c.id) ON a.id = b.id"),
    "{SELECT * FROM (INNER A (INNER B C ON (= B.ID C.ID)) ON (= A.ID B.ID))}",
  );
  assert.equal(q("SELECT * FROM a, b JOIN c ON b.id = c.id"), "{SELECT * FROM A, (INNER B C ON (= B.ID C.ID))}");
  assertSyntaxError("SELECT * FROM a JOIN b", { line: 1, column: 23 }, /expected ON or USING/);
  assertSyntaxError("SELECT * FROM a LEFT b ON 1 = 1");
  assertSyntaxError("SELECT * FROM a CROSS JOIN b ON 1 = 1");
  assertSyntaxError("SELECT * FROM a JOIN b USING id");
  assertUnsupported("SELECT * FROM a NATURAL JOIN b", { line: 1, column: 17 });
  assertUnsupported("SELECT * FROM a, LATERAL (SELECT 1) x");
});

test("FROM 절의 인라인 뷰", () => {
  assert.equal(q("SELECT * FROM (SELECT a FROM t) x"), "{SELECT * FROM {SELECT A FROM T} AS X}");
  assert.equal(q("SELECT * FROM (SELECT a, b FROM t) AS x (c, d)"), "{SELECT * FROM {SELECT A, B FROM T} AS X(C,D)}");
  // 별칭은 생략할 수 있다.
  assert.equal(q("SELECT * FROM (SELECT 1)"), "{SELECT * FROM {SELECT 1}}");
  assert.equal(
    q("SELECT * FROM (SELECT a FROM t ORDER BY a FETCH FIRST 3 ROWS ONLY) x JOIN u ON x.a = u.a"),
    "{SELECT * FROM (INNER {SELECT A FROM T ORDER A FETCH 3} AS X U ON (= X.A U.A))}",
  );
  assert.equal(q("SELECT * FROM (SELECT 1 UNION SELECT 2) x"), "{SELECT * FROM {(UNION SELECT 1 SELECT 2)} AS X}");
  // 괄호가 겹친 경우 : 질의이면 인라인 뷰, 아니면 괄호로 감싼 조인이다.
  assert.equal(q("SELECT * FROM ((SELECT 1) UNION (SELECT 2)) x"), "{SELECT * FROM {(UNION SELECT 1 SELECT 2)} AS X}");
  assert.equal(q("SELECT * FROM ((SELECT 1)) x"), "{SELECT * FROM {SELECT 1} AS X}");
  assert.equal(
    q("SELECT * FROM ((SELECT 1) a CROSS JOIN b) CROSS JOIN c"),
    "{SELECT * FROM (CROSS (CROSS {SELECT 1} AS A B) C)}",
  );
  assertSyntaxError("SELECT * FROM (SELECT 1", { line: 1, column: 24 });
  assertSyntaxError("SELECT * FROM ()");
});

test("WHERE, GROUP BY, HAVING", () => {
  assert.equal(q("SELECT * FROM t WHERE a = 1 AND b IS NULL"), "{SELECT * FROM T WHERE (AND (= A 1) (IS-NULL B))}");
  assert.equal(q("SELECT a, COUNT(*) FROM t GROUP BY a"), "{SELECT A, (COUNT *) FROM T GROUP A}");
  assert.equal(
    q("SELECT a, b, SUM(c) FROM t WHERE c > 0 GROUP BY a, UPPER(b) HAVING SUM(c) > 10 AND a <> 'x'"),
    "{SELECT A, B, (SUM C) FROM T WHERE (> C 0) GROUP A, (UPPER B) HAVING (AND (> (SUM C) 10) (<> A 'x'))}",
  );
  // GROUP BY 없이 HAVING 만 쓸 수 있다.
  assert.equal(q("SELECT COUNT(*) FROM t HAVING COUNT(*) > 0"), "{SELECT (COUNT *) FROM T HAVING (> (COUNT *) 0)}");
  assert.equal(q("SELECT 1 WHERE 1 = 1"), "{SELECT 1 WHERE (= 1 1)}");
  assertSyntaxError("SELECT * FROM t GROUP a", { line: 1, column: 23 });
  assertSyntaxError("SELECT * FROM t WHERE a = 1 WHERE b = 2");
  assertSyntaxError("SELECT * FROM t HAVING a GROUP BY a");
  assertUnsupported("SELECT a, SUM(b) FROM t GROUP BY ROLLUP (a)");
  assertUnsupported("SELECT a, SUM(b) FROM t GROUP BY CUBE (a, b)");
  assertUnsupported("SELECT a, SUM(b) FROM t GROUP BY GROUPING SETS ((a), ())");
});

test("집합 연산 : INTERSECT 가 UNION, EXCEPT 보다 먼저 묶인다", () => {
  assert.equal(q("SELECT 1 UNION SELECT 2"), "{(UNION SELECT 1 SELECT 2)}");
  assert.equal(q("SELECT 1 UNION ALL SELECT 2"), "{(UNION ALL SELECT 1 SELECT 2)}");
  assert.equal(q("SELECT 1 UNION DISTINCT SELECT 2"), "{(UNION SELECT 1 SELECT 2)}");
  assert.equal(q("SELECT 1 INTERSECT SELECT 2"), "{(INTERSECT SELECT 1 SELECT 2)}");
  assert.equal(q("SELECT 1 EXCEPT SELECT 2"), "{(EXCEPT SELECT 1 SELECT 2)}");
  assert.equal(q("SELECT 1 UNION SELECT 2 EXCEPT SELECT 3"), "{(EXCEPT (UNION SELECT 1 SELECT 2) SELECT 3)}");
  assert.equal(q("SELECT 1 UNION SELECT 2 INTERSECT SELECT 3"), "{(UNION SELECT 1 (INTERSECT SELECT 2 SELECT 3))}");
  assert.equal(q("SELECT 1 INTERSECT SELECT 2 UNION SELECT 3"), "{(UNION (INTERSECT SELECT 1 SELECT 2) SELECT 3)}");
  assert.equal(q("(SELECT 1 UNION SELECT 2) INTERSECT SELECT 3"), "{(INTERSECT (UNION SELECT 1 SELECT 2) SELECT 3)}");
  assert.equal(
    q("SELECT a FROM t WHERE a > 0 UNION ALL SELECT b FROM u GROUP BY b"),
    "{(UNION ALL SELECT A FROM T WHERE (> A 0) SELECT B FROM U GROUP B)}",
  );
  assertSyntaxError("SELECT 1 UNION", { line: 1, column: 15 });
  assertSyntaxError("SELECT 1 UNION 2");
  assertUnsupported("SELECT 1 INTERSECT ALL SELECT 2", { line: 1, column: 20 });
  assertUnsupported("SELECT 1 EXCEPT ALL SELECT 2");
  assertUnsupported("SELECT 1 UNION VALUES (2)");
});

test("ORDER BY : ASC 는 생략할 수 있고 NULL 의 위치를 정할 수 있다", () => {
  assert.equal(q("SELECT * FROM t ORDER BY a"), "{SELECT * FROM T ORDER A}");
  assert.equal(q("SELECT * FROM t ORDER BY a ASC, b DESC, c"), "{SELECT * FROM T ORDER A, B DESC, C}");
  assert.equal(
    q("SELECT * FROM t ORDER BY a NULLS FIRST, b DESC NULLS LAST, c ASC NULLS FIRST"),
    "{SELECT * FROM T ORDER A NULLS FIRST, B DESC NULLS LAST, C NULLS FIRST}",
  );
  assert.equal(q("SELECT a, b FROM t ORDER BY 2, UPPER(a) DESC, a + b"), "{SELECT A, B FROM T ORDER 2, (UPPER A) DESC, (+ A B)}");
  // 집합 연산 뒤의 ORDER BY 는 전체 결과에 걸린다.
  assert.equal(q("SELECT a FROM t UNION SELECT a FROM u ORDER BY 1"), "{(UNION SELECT A FROM T SELECT A FROM U) ORDER 1}");
  // 괄호 안의 ORDER BY 는 그 질의에만 걸린다.
  assert.equal(
    q("(SELECT a FROM t ORDER BY a LIMIT 1) UNION ALL (SELECT a FROM u ORDER BY a DESC LIMIT 1) ORDER BY 1"),
    "{(UNION ALL {SELECT A FROM T ORDER A FETCH 1} {SELECT A FROM U ORDER A DESC FETCH 1}) ORDER 1}",
  );
  assert.equal(q("(SELECT a FROM t ORDER BY a)"), "{SELECT A FROM T ORDER A}");
  assert.equal(q("((SELECT a FROM t))"), "{SELECT A FROM T}");
  // NULLS 를 컬럼 이름으로 쓴 경우
  assert.equal(q("SELECT * FROM t ORDER BY nulls"), "{SELECT * FROM T ORDER NULLS}");
  assertSyntaxError("SELECT * FROM t ORDER a", { line: 1, column: 23 });
  assertSyntaxError("SELECT * FROM t ORDER BY", { line: 1, column: 25 });
  assertSyntaxError("SELECT * FROM t ORDER BY a NULLS");
  assertSyntaxError("SELECT * FROM t ORDER BY a DESC ASC");
  assertSyntaxError("SELECT a FROM t ORDER BY a UNION SELECT a FROM u");
});

test("행 수 제한 : ANSI 문법과 LIMIT", () => {
  assert.equal(q("SELECT * FROM t FETCH FIRST 10 ROWS ONLY"), "{SELECT * FROM T FETCH 10}");
  assert.equal(q("SELECT * FROM t FETCH NEXT 1 ROW ONLY"), "{SELECT * FROM T FETCH 1}");
  // 개수를 생략하면 한 행이다.
  assert.equal(q("SELECT * FROM t FETCH FIRST ROW ONLY"), "{SELECT * FROM T FETCH -}");
  assert.equal(q("SELECT * FROM t OFFSET 5 ROWS"), "{SELECT * FROM T OFFSET 5}");
  assert.equal(q("SELECT * FROM t OFFSET 1 ROW"), "{SELECT * FROM T OFFSET 1}");
  assert.equal(q("SELECT * FROM t OFFSET 5"), "{SELECT * FROM T OFFSET 5}");
  assert.equal(
    q("SELECT * FROM t ORDER BY a OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY"),
    "{SELECT * FROM T ORDER A OFFSET 20 FETCH 10}",
  );
  assert.equal(q("SELECT * FROM t LIMIT 10"), "{SELECT * FROM T FETCH 10}");
  assert.equal(q("SELECT * FROM t LIMIT 10 OFFSET 20"), "{SELECT * FROM T OFFSET 20 FETCH 10}");
  assert.equal(q("SELECT * FROM t OFFSET 20 LIMIT 10"), "{SELECT * FROM T OFFSET 20 FETCH 10}");
  assert.equal(q("SELECT * FROM t LIMIT ? OFFSET ?"), "{SELECT * FROM T OFFSET ?2 FETCH ?1}");
  assert.equal(q("SELECT * FROM t FETCH FIRST 2 + 3 ROWS ONLY"), "{SELECT * FROM T FETCH (+ 2 3)}");
  assert.equal(q("SELECT 1 UNION SELECT 2 LIMIT 1"), "{(UNION SELECT 1 SELECT 2) FETCH 1}");
  assertSyntaxError("SELECT * FROM t FETCH 10 ROWS ONLY", { line: 1, column: 23 });
  assertSyntaxError("SELECT * FROM t FETCH FIRST 10 ONLY");
  assertSyntaxError("SELECT * FROM t FETCH FIRST 10 ROWS", { line: 1, column: 36 });
  assertSyntaxError("SELECT * FROM t LIMIT");
  assertSyntaxError("SELECT * FROM t LIMIT 1 LIMIT 2", { line: 1, column: 25 }, /more than once/);
  assertSyntaxError("SELECT * FROM t LIMIT 1 FETCH FIRST ROW ONLY");
  assertSyntaxError("SELECT * FROM t OFFSET 1 OFFSET 2");
  assertSyntaxError("SELECT * FROM t LIMIT 1 ORDER BY a");
  assertUnsupported("SELECT * FROM t LIMIT 5, 10");
  assertUnsupported("SELECT * FROM t FETCH FIRST 10 PERCENT ROWS ONLY");
  assertUnsupported("SELECT * FROM t FETCH FIRST 10 ROWS WITH TIES");
});

test("FOR UPDATE", () => {
  assert.equal(q("SELECT * FROM t FOR UPDATE"), "{SELECT * FROM T FOR UPDATE}");
  assert.equal(
    q("SELECT * FROM t WHERE id = 1 ORDER BY id FETCH FIRST ROW ONLY FOR UPDATE"),
    "{SELECT * FROM T WHERE (= ID 1) ORDER ID FETCH - FOR UPDATE}",
  );
  assertSyntaxError("SELECT * FROM t FOR", { line: 1, column: 20 });
  assertSyntaxError("SELECT * FROM t FOR UPDATE ORDER BY a");
  assertUnsupported("SELECT * FROM t FOR SHARE");
  assertUnsupported("SELECT * FROM t FOR UPDATE OF t");
  assertUnsupported("SELECT * FROM t FOR UPDATE NOWAIT");
  assertUnsupported("SELECT * FROM t FOR UPDATE SKIP LOCKED");
});

test("상관 서브쿼리와 여러 겹의 질의", () => {
  assert.equal(
    q("SELECT d.name, (SELECT COUNT(*) FROM emp e WHERE e.dept_id = d.id) cnt FROM dept d WHERE EXISTS (SELECT 1 FROM emp e WHERE e.dept_id = d.id AND e.salary > ALL (SELECT avg_salary FROM stats))"),
    "{SELECT D.NAME, {SELECT (COUNT *) FROM EMP AS E WHERE (= E.DEPT_ID D.ID)} AS CNT FROM DEPT AS D"
      + " WHERE (EXISTS {SELECT 1 FROM EMP AS E WHERE (AND (= E.DEPT_ID D.ID) (> ALL E.SALARY {SELECT AVG_SALARY FROM STATS}))})}",
  );
});

test("여러 줄에 걸친 질의의 오류 위치는 줄과 칸으로 알려 준다", () => {
  const sql = "SELECT a,\n       b\n  FROM t\n WHERE a = \n ORDER BY b";
  assertSyntaxError(sql, { line: 5, column: 2 }, /Unexpected "ORDER"; expected an expression \(line 5, column 2\)\.$/);
  assertSyntaxError("SELECT *\r\nFROM t\r\nWHERE (a = 1", { line: 3, column: 13 });
  assertSyntaxError("-- 주석\n/* 여러 줄\n주석 */ SELEKT 1", { line: 3, column: 7 });
  // 한글과 탭이 섞여도 칸은 글자 수로 센다.
  assertSyntaxError("SELECT '가나다',\t,", { line: 1, column: 15 });
});

test("지원하지 않는 질의 문법은 문법 오류가 아니라 0A000 이다", () => {
  assertUnsupported("WITH x AS (SELECT 1) SELECT * FROM x", { line: 1, column: 1 });
  assertUnsupported("SELECT * FROM (WITH x AS (SELECT 1) SELECT * FROM x) y");
  assertUnsupported("VALUES (1), (2)", { line: 1, column: 1 });
  assertUnsupported("SELECT * FROM t WINDOW w AS (PARTITION BY a)");
});

test("괄호가 겹친 곳은 되돌려 읽지 않고 한 번에 질의인지 식인지 정한다", () => {
  // 맨 안쪽은 질의이고, 바깥 괄호는 그 뒤에 무엇이 이어지는지로 정해진다.
  assert.equal(q("SELECT (((SELECT 1)))"), "{SELECT {SELECT 1}}");
  assert.equal(q("SELECT (((SELECT 1) UNION (SELECT 2)) ORDER BY 1)"), "{SELECT {(UNION SELECT 1 SELECT 2) ORDER 1}}");
  assert.equal(q("SELECT (((SELECT 1) + 1) * 2)"), "{SELECT (* (+ {SELECT 1} 1) 2)}");
  assert.equal(q("SELECT ((SELECT 1) = (SELECT 2))"), "{SELECT (= {SELECT 1} {SELECT 2})}");
  assert.equal(q("SELECT ((SELECT a FROM t) IS NULL OR ((SELECT 2)) > 1)"),
    "{SELECT (OR (IS-NULL {SELECT A FROM T}) (> {SELECT 2} 1))}");
  assert.equal(q("SELECT ((SELECT 1) LIMIT 1)"), "{SELECT {SELECT 1 FETCH 1}}");
  // 이미 읽은 서브쿼리 앞에는 NOT 이나 부호가 올 수 없으므로, 뒤따르는 연산자는 이항 연산이다.
  assert.equal(q("SELECT ((SELECT 1) - 1)"), "{SELECT (- {SELECT 1} 1)}");
  assert.equal(q("SELECT ((SELECT a) NOT IN (1, 2))"), "{SELECT (NOT-IN {SELECT A} 1 2)}");
  assert.equal(q("SELECT * FROM (((SELECT 1))) x"), "{SELECT * FROM {SELECT 1} AS X}");
  assert.equal(q("SELECT * FROM (((SELECT 1) a JOIN b ON 1 = 1) JOIN c ON 2 = 2) JOIN d ON 3 = 3"),
    "{SELECT * FROM (INNER (INNER (INNER {SELECT 1} AS A B ON (= 1 1)) C ON (= 2 2)) D ON (= 3 3))}");
  assert.equal(q("SELECT * FROM ((SELECT 1) EXCEPT (SELECT 2) ORDER BY 1) x"),
    "{SELECT * FROM {(EXCEPT SELECT 1 SELECT 2) ORDER 1} AS X}");
  assertSyntaxError("SELECT ((SELECT 1) (SELECT 2))");
  assertSyntaxError("SELECT ((SELECT 1) + )");
  assertSyntaxError("SELECT * FROM ((SELECT 1) + 1) x");
  assertUnsupported("SELECT ((SELECT 1), 2)");

  // 여러 겹으로 섞여도 걸리는 시간은 길이에 비례한다. (되돌려 읽으면 깊이에 지수적으로 늘어난다)
  let nested = "1";
  for (let i = 0; i < 30; i++) nested = `((SELECT ${nested}) + 1)`;
  const started = performance.now();
  assert.equal(parse(`SELECT ${nested}`).kind, "Query");
  assert.ok(performance.now() - started < 1_000);
});

test("너무 깊이 겹친 문장은 스택이 넘치기 전에 54001 로 알린다", () => {
  const within = MAX_NESTING_DEPTH - 10;
  const beyond = MAX_NESTING_DEPTH + 10;
  const shapes: ((depth: number) => string)[] = [
    (depth) => `SELECT ${"(".repeat(depth)}1${")".repeat(depth)}`,
    (depth) => `SELECT ${"NOT ".repeat(depth)}a`,
    (depth) => `SELECT ${"- ".repeat(depth)}a`,
    (depth) => `SELECT ${"UPPER(".repeat(depth)}a${")".repeat(depth)}`,
    (depth) => `SELECT ${"CASE WHEN a THEN ".repeat(depth)}1${" END".repeat(depth)}`,
    (depth) => `SELECT * FROM ${"(".repeat(depth)}t${")".repeat(depth)}`,
    (depth) => `${"(".repeat(depth)}SELECT 1${")".repeat(depth)}`,
  ];
  for (const shape of shapes) {
    assert.equal(parse(shape(within)).kind, "Query");
    assertTooComplex(shape(beyond), /nested too deeply/);
    // 아주 깊어도 RangeError 가 아니라 같은 오류이다.
    assertTooComplex(shape(20_000), /nested too deeply/);
  }
  assertTooComplex(`SELECT ${"(".repeat(20_000)}SELECT 1${")".repeat(20_000)}`, /nested too deeply/);
  assertTooComplex(`SELECT * FROM ${"(".repeat(20_000)}SELECT 1${")".repeat(20_000)}`, /nested too deeply/);
});

test("길기만 하고 깊지 않은 문장은 한도에 걸리지 않는다", () => {
  // AND, OR 은 피연산자를 나란히 담으므로 아무리 길어도 트리가 깊어지지 않는다.
  const conditions = Array.from({ length: 20_000 }, (_, index) => `a = ${index}`);
  const and = parseStatement(`SELECT * FROM t WHERE ${conditions.join(" AND ")}`).statement as ast.Query;
  const where = (and.body as ast.Select).where;
  assert.equal(where?.kind, "Logical");
  assert.equal(where?.kind === "Logical" ? where.operands.length : 0, 20_000);
  assert.equal(parseStatement(`SELECT * FROM t WHERE ${conditions.join(" OR ")}`).statement.kind, "Query");
  const values = Array.from({ length: 20_000 }, (_, index) => index);
  assert.equal(parseStatement(`SELECT * FROM t WHERE a IN (${values.join(", ")})`).statement.kind, "Query");
  assert.equal(parseStatement(`INSERT INTO t VALUES ${values.map((value) => `(${value}, 'x')`).join(", ")}`).statement.kind, "Insert");
  assert.equal(parseStatement(`SELECT ${values.join(", ")}`).statement.kind, "Query");
});

test("연산이 길게 이어져 구문 트리가 깊어지면 54001 로 알린다", () => {
  // `a + b + c + ...` 는 왼쪽으로 깊어지는 트리가 된다. 뒤 단계의 재귀 순회가 감당할 수 있는 깊이로 제한한다.
  const terms = (count: number, separator: string): string =>
    Array.from({ length: count }, (_, index) => `c${index}`).join(separator);
  const within = MAX_TREE_DEPTH - 20;
  const beyond = MAX_TREE_DEPTH + 20;
  for (const separator of [" + ", " * ", " || "]) {
    assert.equal(parse(`SELECT ${terms(within, separator)}`).kind, "Query");
    assertTooComplex(`SELECT ${terms(beyond, separator)}`, /expression tree is deeper than/);
    assertTooComplex(`SELECT ${terms(50_000, separator)}`, /expression tree is deeper than/);
  }
  const selects = (count: number): string => Array.from({ length: count }, (_, index) => `SELECT ${index}`).join(" UNION ALL ");
  assert.equal(parse(selects(within)).kind, "Query");
  assertTooComplex(selects(beyond));
  const joins = (count: number): string =>
    `SELECT * FROM t0 ${Array.from({ length: count }, (_, index) => `JOIN t${index + 1} USING (id)`).join(" ")}`;
  assert.equal(parse(joins(within)).kind, "Query");
  assertTooComplex(joins(beyond));
  // 오류는 한도를 넘은 지점의 위치를 가리킨다.
  assert.throws(() => parseStatement(`SELECT 1\nFROM t\nWHERE x = ${terms(beyond, " + ")}`), (error) =>
    error instanceof DbError && error.sqlState === "54001" && error.position?.line === 3);
});
