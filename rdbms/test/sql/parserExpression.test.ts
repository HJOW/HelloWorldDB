/**
 * 담당 : 식의 구문 분석. 연산자 우선순위, 조건, CASE, CAST, 함수 호출, 리터럴, 파라미터.
 * 관련 사양 : AGENTS.md 상세 0, 1-4, 1-5.
 * 구현 단계 : 4단계.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStatement } from "../../src/sql/parser.js";
import { assertSqlStateAt, assertSyntaxError, assertUnsupported, expression as e, query } from "./helpers.js";

test("사칙연산과 연결 연산자의 우선순위", () => {
  assert.equal(e("1 + 2 * 3"), "(+ 1 (* 2 3))");
  assert.equal(e("1 * 2 + 3"), "(+ (* 1 2) 3)");
  assert.equal(e("1 - 2 - 3"), "(- (- 1 2) 3)");
  assert.equal(e("8 / 4 / 2"), "(/ (/ 8 4) 2)");
  assert.equal(e("(1 + 2) * 3"), "(* (+ 1 2) 3)");
  assert.equal(e("a || b || c"), "(|| (|| A B) C)");
  assert.equal(e("a || b + c"), "(+ (|| A B) C)");
  assert.equal(e("a + b * c || d"), "(|| (+ A (* B C)) D)");
  assert.equal(e("((((a))))"), "A");
});

test("단항 부호 : 수 리터럴에는 합쳐지고 그 밖에는 연산으로 남는다", () => {
  assert.equal(e("-5"), "-5");
  assert.equal(e("+5"), "5");
  assert.equal(e("- -5"), "5");
  assert.equal(e("-1.5"), "-1.5:DECIMAL");
  assert.equal(e("-1e3"), "-1e3:FLOAT");
  assert.equal(e("-2147483648"), "-2147483648");
  assert.equal(e("-a"), "(- A)");
  assert.equal(e("+a"), "(+ A)");
  assert.equal(e("- - a"), "(- (- A))");
  assert.equal(e("-(1 + 2)"), "(- (+ 1 2))");
  assert.equal(e("1 - -2"), "(- 1 -2)");
  assert.equal(e("a - -b"), "(- A (- B))");
  assert.equal(e("-a * b"), "(* (- A) B)");
  assert.equal(e("2 * -3"), "(* 2 -3)");
});

test("논리 연산자 : OR 보다 AND, AND 보다 NOT 이 먼저 묶인다", () => {
  assert.equal(e("a OR b AND c"), "(OR A (AND B C))");
  assert.equal(e("a AND b OR c"), "(OR (AND A B) C)");
  // 같은 연산자가 이어지면 피연산자를 나란히 담는다. 괄호로 묶은 것은 따로 남는다.
  assert.equal(e("a OR b OR c"), "(OR A B C)");
  assert.equal(e("a AND b AND c AND d"), "(AND A B C D)");
  assert.equal(e("a OR b AND c AND d OR e"), "(OR A (AND B C D) E)");
  assert.equal(e("(a OR b) OR c"), "(OR (OR A B) C)");
  assert.equal(e("a AND (b AND c)"), "(AND A (AND B C))");
  assert.equal(e("NOT a AND b"), "(AND (NOT A) B)");
  assert.equal(e("NOT a = b"), "(NOT (= A B))");
  assert.equal(e("NOT NOT a"), "(NOT (NOT A))");
  assert.equal(e("NOT (a OR b)"), "(NOT (OR A B))");
  assert.equal(e("a = 1 AND b <> 2 OR c >= 3"), "(OR (AND (= A 1) (<> B 2)) (>= C 3))");
});

test("비교 연산자. != 는 <> 와 같다", () => {
  assert.equal(e("a = b"), "(= A B)");
  assert.equal(e("a <> b"), "(<> A B)");
  assert.equal(e("a != b"), "(<> A B)");
  assert.equal(e("a < b"), "(< A B)");
  assert.equal(e("a <= b"), "(<= A B)");
  assert.equal(e("a > b"), "(> A B)");
  assert.equal(e("a >= b"), "(>= A B)");
  assert.equal(e("a + 1 < b * 2"), "(< (+ A 1) (* B 2))");
  assert.equal(e("a || 'x' = b"), "(= (|| A 'x') B)");
});

test("IS NULL, IS TRUE 와 그 부정", () => {
  assert.equal(e("a IS NULL"), "(IS-NULL A)");
  assert.equal(e("a IS NOT NULL"), "(IS-NOT-NULL A)");
  assert.equal(e("a + 1 IS NULL"), "(IS-NULL (+ A 1))");
  assert.equal(e("a IS TRUE"), "(IS-TRUE A)");
  assert.equal(e("a IS NOT FALSE"), "(IS-NOT-FALSE A)");
  assert.equal(e("a IS UNKNOWN"), "(IS-UNKNOWN A)");
  assert.equal(e("a = b IS NOT TRUE"), "(IS-NOT-TRUE (= A B))");
  assert.equal(e("NOT a IS NULL"), "(NOT (IS-NULL A))");
  assert.equal(e("a IS NULL OR b IS NOT NULL"), "(OR (IS-NULL A) (IS-NOT-NULL B))");
  assertSyntaxError("SELECT a IS 1", { line: 1, column: 13 });
  assertUnsupported("SELECT a IS DISTINCT FROM b");
  assertUnsupported("SELECT a IS NOT DISTINCT FROM b");
});

test("BETWEEN 의 AND 는 논리 연산자와 구별된다", () => {
  assert.equal(e("a BETWEEN 1 AND 10"), "(BETWEEN A 1 10)");
  assert.equal(e("a NOT BETWEEN 1 AND 10"), "(NOT-BETWEEN A 1 10)");
  assert.equal(e("a BETWEEN 1 AND 10 AND b = 2"), "(AND (BETWEEN A 1 10) (= B 2))");
  assert.equal(e("a BETWEEN b + 1 AND c * 2 OR d"), "(OR (BETWEEN A (+ B 1) (* C 2)) D)");
  assert.equal(e("NOT a BETWEEN 1 AND 2"), "(NOT (BETWEEN A 1 2))");
  assertSyntaxError("SELECT a BETWEEN 1", { line: 1, column: 19 });
  assertSyntaxError("SELECT a BETWEEN 1 OR 2");
  assertUnsupported("SELECT a BETWEEN SYMMETRIC 1 AND 2");
});

test("IN 은 값 목록과 서브쿼리를 받는다", () => {
  assert.equal(e("a IN (1, 2, 3)"), "(IN A 1 2 3)");
  assert.equal(e("a NOT IN ('x')"), "(NOT-IN A 'x')");
  assert.equal(e("a IN (b + 1, ?)"), "(IN A (+ B 1) ?1)");
  assert.equal(e("a IN (SELECT id FROM t)"), "(IN A {SELECT ID FROM T})");
  assert.equal(e("a NOT IN (SELECT id FROM t WHERE x = 1)"), "(NOT-IN A {SELECT ID FROM T WHERE (= X 1)})");
  assert.equal(e("a IN (SELECT 1 UNION SELECT 2)"), "(IN A {(UNION SELECT 1 SELECT 2)})");
  // 괄호를 한 겹 더 두른 서브쿼리는 값 하나짜리 목록이다.
  assert.equal(e("a IN ((SELECT 1))"), "(IN A {SELECT 1})");
  assert.equal(e("a IN (1) AND b IN (2)"), "(AND (IN A 1) (IN B 2))");
  assertSyntaxError("SELECT a IN ()", { line: 1, column: 14 });
  assertSyntaxError("SELECT a IN 1", { line: 1, column: 13 });
  assertSyntaxError("SELECT a NOT 1");
});

test("LIKE 와 ESCAPE", () => {
  assert.equal(e("a LIKE 'x%'"), "(LIKE A 'x%')");
  assert.equal(e("a NOT LIKE 'x%'"), "(NOT-LIKE A 'x%')");
  assert.equal(e("a LIKE 'x!%' ESCAPE '!'"), "(LIKE A 'x!%' ESCAPE '!')");
  assert.equal(e("a LIKE b || '%' AND c"), "(AND (LIKE A (|| B '%')) C)");
  assert.equal(e("a LIKE ? ESCAPE ?"), "(LIKE A ?1 ESCAPE ?2)");
});

test("서브쿼리 : 스칼라, EXISTS, ANY, ALL", () => {
  assert.equal(e("(SELECT 1)"), "{SELECT 1}");
  assert.equal(e("(SELECT MAX(a) FROM t) + 1"), "(+ {SELECT (MAX A) FROM T} 1)");
  assert.equal(e("EXISTS (SELECT 1 FROM t WHERE t.a = u.a)"), "(EXISTS {SELECT 1 FROM T WHERE (= T.A U.A)})");
  assert.equal(e("NOT EXISTS (SELECT 1)"), "(NOT (EXISTS {SELECT 1}))");
  assert.equal(e("a = ANY (SELECT b FROM t)"), "(= ANY A {SELECT B FROM T})");
  assert.equal(e("a < SOME (SELECT b FROM t)"), "(< ANY A {SELECT B FROM T})");
  assert.equal(e("a >= ALL (SELECT b FROM t)"), "(>= ALL A {SELECT B FROM T})");
  assert.equal(e("a != ALL (SELECT b FROM t)"), "(<> ALL A {SELECT B FROM T})");
  // 괄호가 겹칠 때 : 질의로 읽을 수 있으면 질의, 아니면 식이다.
  assert.equal(e("((SELECT 1))"), "{SELECT 1}");
  assert.equal(e("((SELECT 1) + 1)"), "(+ {SELECT 1} 1)");
  assert.equal(e("((SELECT 1) UNION (SELECT 2))"), "{(UNION SELECT 1 SELECT 2)}");
  assert.equal(e("(((SELECT a FROM t ORDER BY a FETCH FIRST ROW ONLY)) * 2)"), "(* {SELECT A FROM T ORDER A FETCH -} 2)");
  assertSyntaxError("SELECT EXISTS 1");
  assertSyntaxError("SELECT a = ANY (1, 2)");
  assertUnsupported("SELECT (1, 2) = (1, 2)", { line: 1, column: 10 });
});

test("CASE : 단순형과 검색형", () => {
  assert.equal(e("CASE WHEN a > 0 THEN 'p' WHEN a < 0 THEN 'n' ELSE 'z' END"),
    "(CASE (WHEN (> A 0) 'p') (WHEN (< A 0) 'n') (ELSE 'z'))");
  assert.equal(e("CASE a WHEN 1 THEN 'one' WHEN 2 THEN 'two' END"), "(CASE A (WHEN 1 'one') (WHEN 2 'two'))");
  assert.equal(e("CASE WHEN a THEN CASE WHEN b THEN 1 END END"), "(CASE (WHEN A (CASE (WHEN B 1))))");
  assert.equal(e("CASE a + 1 WHEN b THEN c ELSE NULL END + 1"), "(+ (CASE (+ A 1) (WHEN B C) (ELSE NULL)) 1)");
  assertSyntaxError("SELECT CASE END");
  assertSyntaxError("SELECT CASE a ELSE 1 END");
  assertSyntaxError("SELECT CASE WHEN a THEN 1");
  assertSyntaxError("SELECT CASE WHEN a 1 END");
});

test("CAST 는 타입 이름과 인자를 타입 정의로 해석한다", () => {
  assert.equal(e("CAST(a AS INTEGER)"), "(CAST A INTEGER)");
  assert.equal(e("CAST(a AS INT)"), "(CAST A INTEGER)");
  assert.equal(e("CAST('1' AS DECIMAL)"), "(CAST '1' DECIMAL(10,3))");
  assert.equal(e("CAST(a AS NUMERIC(5))"), "(CAST A DECIMAL(5,0))");
  assert.equal(e("CAST(a AS DEC(12, 4))"), "(CAST A DECIMAL(12,4))");
  assert.equal(e("CAST(a AS VARCHAR)"), "(CAST A VARCHAR(65535))");
  assert.equal(e("CAST(a AS CHARACTER VARYING(10))"), "(CAST A VARCHAR(10))");
  assert.equal(e("CAST(a AS NATIONAL CHARACTER VARYING (10))"), "(CAST A VARCHAR(10))");
  assert.equal(e("CAST(a AS NCHAR VARYING(3))"), "(CAST A VARCHAR(3))");
  assert.equal(e("CAST(a AS CHAR)"), "(CAST A CHAR(1))");
  assert.equal(e("CAST(a AS NATIONAL CHAR(4))"), "(CAST A CHAR(4))");
  assert.equal(e("CAST(a AS BINARY VARYING(8))"), "(CAST A VARBINARY(8))");
  assert.equal(e("CAST(a AS DOUBLE PRECISION)"), "(CAST A DOUBLE PRECISION)");
  assert.equal(e("CAST(a AS FLOAT(24))"), "(CAST A REAL)");
  assert.equal(e("CAST(a AS FLOAT)"), "(CAST A DOUBLE PRECISION)");
  assert.equal(e("CAST(a AS BOOLEAN)"), "(CAST A BOOLEAN)");
  assert.equal(e("CAST(a AS DATE)"), "(CAST A DATE)");
  assert.equal(e("CAST(a AS TIME)"), "(CAST A TIME(0))");
  assert.equal(e("CAST(a AS TIME(3) WITH TIME ZONE)"), "(CAST A TIME(3) WITH TIME ZONE)");
  assert.equal(e("CAST(a AS TIMESTAMP)"), "(CAST A TIMESTAMP(6))");
  assert.equal(e("CAST(a AS TIMESTAMP WITHOUT TIME ZONE)"), "(CAST A TIMESTAMP(6))");
  assert.equal(e("CAST(a AS TIMESTAMP(0) WITH TIME ZONE)"), "(CAST A TIMESTAMP(0) WITH TIME ZONE)");
  assert.equal(e("CAST(a AS INTERVAL YEAR TO MONTH)"), "(CAST A INTERVAL YEAR(2) TO MONTH)");
  assert.equal(e("CAST(a AS INTERVAL DAY(5) TO SECOND(3))"), "(CAST A INTERVAL DAY(5) TO SECOND(3))");
  assert.equal(e("CAST(a AS INTERVAL SECOND)"), "(CAST A INTERVAL SECOND(2,6))");
  assert.equal(e("CAST(a AS INTERVAL SECOND(4))"), "(CAST A INTERVAL SECOND(4,6))");
  assert.equal(e("CAST(a AS INTERVAL SECOND(4, 2))"), "(CAST A INTERVAL SECOND(4,2))");
  assert.equal(e("CAST(a + 1 AS BIGINT) * 2"), "(* (CAST (+ A 1) BIGINT) 2)");
});

test("타입 이름의 오류 : 지원하지 않는 타입은 0A000, 잘못된 인자는 22023", () => {
  for (const typeName of ["CLOB", "BLOB", "NCLOB", "JSON", "XML", "TEXT", "CHARACTER LARGE OBJECT", "BINARY LARGE OBJECT",
    "NATIONAL CHARACTER LARGE OBJECT", "DECFLOAT", "MYTYPE"]) {
    assertUnsupported(`SELECT CAST(a AS ${typeName})`, { line: 1, column: 18 });
  }
  for (const typeName of ["VARCHAR(0)", "VARCHAR(65536)", "CHAR(2001)", "DECIMAL(39)", "DECIMAL(5,6)", "TIME(7)",
    "INTEGER(5)", "FLOAT(54)", "INTERVAL YEAR TO DAY", "INTERVAL DAY(10)", "INTERVAL DAY TO SECOND(7)",
    "INTERVAL DAY(2) TO HOUR(2)", "DATE(3)"]) {
    assertSqlStateAt(`SELECT CAST(a AS ${typeName})`, "22023", { line: 1, column: 18 });
  }
  assertSyntaxError("SELECT CAST(a AS VARCHAR(MAX))");
  assertSyntaxError("SELECT CAST(a AS VARCHAR(1.5))");
  assertSyntaxError("SELECT CAST(a AS DECIMAL(10,))");
  assertSyntaxError("SELECT CAST(a AS )");
  assertSyntaxError("SELECT CAST(a AS DOUBLE)");
  assertSyntaxError("SELECT CAST(a AS NATIONAL VARCHAR)");
  assertSyntaxError("SELECT CAST(a AS INTERVAL)");
  assertSyntaxError("SELECT CAST(a, INTEGER)");
  assertSyntaxError("SELECT CAST(a AS TIME WITH ZONE)");
});

test("리터럴", () => {
  assert.equal(e("NULL"), "NULL");
  assert.equal(e("TRUE"), "TRUE");
  assert.equal(e("false"), "FALSE");
  assert.equal(e("'Hello World'"), "'Hello World'");
  assert.equal(e("''"), "''");
  assert.equal(e("N'국문'"), "'국문'");
  assert.equal(e("X'0a0B'"), "X'0A0B'");
  assert.equal(e("42"), "42");
  assert.equal(e("99999999999999999999999999999999999999999"), "99999999999999999999999999999999999999999");
  assert.equal(e("1.50"), "1.50:DECIMAL");
  assert.equal(e(".5"), ".5:DECIMAL");
  assert.equal(e("1e3"), "1e3:FLOAT");
  assert.equal(e("DATE '2026-01-01'"), "DATE'2026-01-01'");
  assert.equal(e("TIME '12:34:56'"), "TIME'12:34:56'");
  assert.equal(e("TIMESTAMP '2026-01-01 12:34:56.789'"), "TIMESTAMP'2026-01-01 12:34:56.789'");
  assert.equal(e("TIMESTAMP WITH TIME ZONE '2026-01-01 00:00:00+09:00'"), "TIMESTAMP WITH TIME ZONE'2026-01-01 00:00:00+09:00'");
  assert.equal(e("TIME WITHOUT TIME ZONE '12:00:00'"), "TIME WITHOUT TIME ZONE'12:00:00'");
  // 형식이 맞는지는 실행할 때 본다.
  assert.equal(e("DATE 'not a date'"), "DATE'not a date'");
});

test("INTERVAL 리터럴", () => {
  assert.equal(e("INTERVAL '1' DAY"), "INTERVAL'1' DAY");
  assert.equal(e("INTERVAL '1-2' YEAR TO MONTH"), "INTERVAL'1-2' YEAR TO MONTH");
  assert.equal(e("INTERVAL '3 04:05:06.789' DAY(3) TO SECOND(3)"), "INTERVAL'3 04:05:06.789' DAY(3) TO SECOND(3)");
  assert.equal(e("INTERVAL '5.5' SECOND(3, 1)"), "INTERVAL'5.5' SECOND(3,1)");
  assert.equal(e("INTERVAL '100' HOUR(3)"), "INTERVAL'100' HOUR(3)");
  // 부호는 문자열 앞에 합친다.
  assert.equal(e("INTERVAL -'5' DAY"), "INTERVAL'-5' DAY");
  assert.equal(e("INTERVAL '-5' DAY"), "INTERVAL'-5' DAY");
  assert.equal(e("INTERVAL -'-5' DAY"), "INTERVAL'5' DAY");
  assert.equal(e("INTERVAL +'5' DAY"), "INTERVAL'5' DAY");
  assert.equal(e("INTERVAL - '+5' DAY"), "INTERVAL'-5' DAY");
  assert.equal(e("d + INTERVAL '1' MONTH * 2"), "(+ D (* INTERVAL'1' MONTH 2))");
  assertSyntaxError("SELECT INTERVAL '1'", { line: 1, column: 20 });
  assertSyntaxError("SELECT INTERVAL '1' WEEK");
  assertSqlStateAt("SELECT INTERVAL '1' MONTH TO DAY", "22023");
  assertSqlStateAt("SELECT INTERVAL '1' DAY(10)", "22023");
  assertSqlStateAt("SELECT INTERVAL '1' HOUR TO HOUR", "22023");
});

test("타입 이름으로도 쓰는 단어는 컬럼 이름으로 쓸 수 있다", () => {
  assert.equal(e("date"), "DATE");
  assert.equal(e("time + 1"), "(+ TIME 1)");
  assert.equal(e("t.timestamp"), "T.TIMESTAMP");
  assert.equal(e("interval"), "INTERVAL");
  assert.equal(e("interval * 2"), "(* INTERVAL 2)");
  assert.equal(e("year"), "YEAR");
  assert.equal(e("value"), "VALUE");
  assert.equal(e("key || name"), "(|| KEY NAME)");
  assert.equal(e("user"), "USER");
  assert.equal(e("message"), "MESSAGE");
});

test("컬럼 참조", () => {
  assert.equal(e("a"), "A");
  assert.equal(e("t.a"), "T.A");
  assert.equal(e("ts.t.a"), "TS.T.A");
  assert.equal(e('"lower"."Mixed Case"'), "lower.Mixed Case");
  assert.equal(e('"select"'), "select");
  assertSyntaxError("SELECT a.b.c.d", { line: 1, column: 8 });
  assertSyntaxError("SELECT a. FROM t");
  assertSyntaxError("SELECT 1 + t.*");
  assertSyntaxError("SELECT a FROM t WHERE select = 1", { line: 1, column: 23 });
});

test("함수 호출", () => {
  assert.equal(e("UPPER(a)"), "(UPPER A)");
  assert.equal(e("NVL(a, 'x')"), "(NVL A 'x')");
  assert.equal(e("COALESCE(a, b, c)"), "(COALESCE A B C)");
  assert.equal(e("TO_CHAR(d, 'YYYY-MM-DD HH24:MI:SS')"), "(TO_CHAR D 'YYYY-MM-DD HH24:MI:SS')");
  assert.equal(e("TO_DATE('2026-01-01')"), "(TO_DATE '2026-01-01')");
  assert.equal(e("NOW()"), "(NOW)");
  assert.equal(e("ROUND(a / b, 2) * 100"), "(* (ROUND (/ A B) 2) 100)");
  assert.equal(e("REPLACE(LOWER(a), 'x', '')"), "(REPLACE (LOWER A) 'x' '')");
  assert.equal(e("MOD(a, 2) = 0"), "(= (MOD A 2) 0)");
  assert.equal(e('"myFunc"(1)'), "(myFunc 1)");
  assertSyntaxError("SELECT UPPER(a");
  assertSyntaxError("SELECT UPPER(a,)");
  assertSyntaxError("SELECT UPPER(*)");
  assertUnsupported("SELECT pkg.func(1)", { line: 1, column: 8 });
});

test("집계 함수", () => {
  assert.equal(e("COUNT(*)"), "(COUNT *)");
  assert.equal(e("COUNT(a)"), "(COUNT A)");
  assert.equal(e("COUNT(DISTINCT a)"), "(COUNT DISTINCT A)");
  assert.equal(e("COUNT(ALL a)"), "(COUNT A)");
  assert.equal(e("SUM(a * b)"), "(SUM (* A B))");
  assert.equal(e("AVG(DISTINCT a) + MIN(b) - MAX(c)"), "(- (+ (AVG DISTINCT A) (MIN B)) (MAX C))");
  assertSyntaxError("SELECT COUNT(DISTINCT *)");
  assertSyntaxError("SELECT COUNT(*, a)");
});

test("인자를 키워드로 구분하는 함수 : EXTRACT, TRIM, SUBSTRING, POSITION", () => {
  assert.equal(e("EXTRACT(YEAR FROM d)"), "(EXTRACT YEAR D)");
  assert.equal(e("EXTRACT(second FROM d + INTERVAL '1' DAY)"), "(EXTRACT SECOND (+ D INTERVAL'1' DAY))");
  assert.equal(e("EXTRACT(TIMEZONE_HOUR FROM d)"), "(EXTRACT TIMEZONE_HOUR D)");
  assertSyntaxError("SELECT EXTRACT(WEEK FROM d)", { line: 1, column: 16 });
  assertSyntaxError("SELECT EXTRACT(YEAR, d)");

  assert.equal(e("TRIM(a)"), "(TRIM BOTH - A)");
  assert.equal(e("TRIM('x' FROM a)"), "(TRIM BOTH 'x' A)");
  assert.equal(e("TRIM(BOTH FROM a)"), "(TRIM BOTH - A)");
  assert.equal(e("TRIM(LEADING '0' FROM a)"), "(TRIM LEADING '0' A)");
  assert.equal(e("TRIM(TRAILING FROM a || b)"), "(TRIM TRAILING - (|| A B))");
  // LEADING 같은 단어가 컬럼 이름으로 쓰인 경우
  assert.equal(e("TRIM(leading)"), "(TRIM BOTH - LEADING)");
  assertSyntaxError("SELECT TRIM(LEADING 'x' a)");
  assertSyntaxError("SELECT TRIM()");

  assert.equal(e("SUBSTRING(a FROM 2)"), "(SUBSTRING A 2)");
  assert.equal(e("SUBSTRING(a FROM 2 FOR 3)"), "(SUBSTRING A 2 3)");
  assert.equal(e("SUBSTRING(a, 2, 3)"), "(SUBSTRING A 2 3)");
  assert.equal(e("SUBSTRING(a || b FROM n + 1 FOR m)"), "(SUBSTRING (|| A B) (+ N 1) M)");
  assert.equal(e("SUBSTR(a, 2, 3)"), "(SUBSTR A 2 3)");

  assert.equal(e("POSITION('b' IN a)"), "(POSITION 'b' A)");
  assert.equal(e("POSITION(x || 'b' IN a || c) > 0"), "(> (POSITION (|| X 'b') (|| A C)) 0)");
  assertSyntaxError("SELECT POSITION('b', a)");
});

test("괄호 없이 쓰는 함수", () => {
  assert.equal(e("CURRENT_DATE"), "(CURRENT_DATE)");
  assert.equal(e("CURRENT_TIME"), "(CURRENT_TIME)");
  assert.equal(e("CURRENT_TIMESTAMP"), "(CURRENT_TIMESTAMP)");
  assert.equal(e("CURRENT_TIMESTAMP(3)"), "(CURRENT_TIMESTAMP 3)");
  assert.equal(e("LOCALTIME(0)"), "(LOCALTIME 0)");
  assert.equal(e("LOCALTIMESTAMP"), "(LOCALTIMESTAMP)");
  assert.equal(e("CURRENT_USER"), "(CURRENT_USER)");
  assert.equal(e("CURRENT_DATE()"), "(CURRENT_DATE)");
  assert.equal(e("CURRENT_DATE - 1"), "(- (CURRENT_DATE) 1)");
  assertSyntaxError("SELECT CURRENT_DATE(3)");
  assertSyntaxError("SELECT CURRENT_TIMESTAMP(a)");
});

test("파라미터는 나타난 순서대로 1 부터 번호를 받는다", () => {
  assert.equal(e("? + ?"), "(+ ?1 ?2)");
  assert.equal(parseStatement("SELECT 1").parameterCount, 0);
  assert.equal(parseStatement("SELECT ? FROM t WHERE a = ? AND b IN (?, ?) ORDER BY ?").parameterCount, 5);
  assert.equal(query("SELECT ? FROM t WHERE a = ? AND b IN (SELECT ? FROM u) FETCH FIRST ? ROWS ONLY"),
    "{SELECT ?1 FROM T WHERE (AND (= A ?2) (IN B {SELECT ?3 FROM U})) FETCH ?4}");
  // 괄호를 질의로 읽어 보다가 되돌린 경우에도 번호가 밀리지 않는다.
  assert.equal(e("((SELECT ?) + ?)"), "(+ {SELECT ?1} ?2)");
  assert.equal(parseStatement("SELECT ((SELECT ?) + ?), ?").parameterCount, 3);
  assert.equal(parseStatement("INSERT INTO t VALUES (?, ?, DEFAULT)").parameterCount, 2);
  // 문자열이나 주석 안의 ? 는 파라미터가 아니다.
  assert.equal(parseStatement("SELECT '?', ? /* ? */ -- ?").parameterCount, 1);
});

test("윈도우 함수와 그에 딸린 절은 지원하지 않는다", () => {
  assertUnsupported("SELECT ROW_NUMBER() OVER (ORDER BY a) FROM t", { line: 1, column: 21 });
  assertUnsupported("SELECT SUM(a) OVER (PARTITION BY b) FROM t");
  assertUnsupported("SELECT COUNT(*) FILTER (WHERE a > 0) FROM t");
  assertUnsupported("SELECT LISTAGG(a, ',') WITHIN GROUP (ORDER BY a) FROM t");
  // OVER 를 별칭으로 쓴 것은 윈도우 함수가 아니다.
  assert.equal(query("SELECT COUNT(*) over FROM t"), "{SELECT (COUNT *) AS OVER FROM T}");
});

test("식이 올 자리의 문법 오류", () => {
  assertSyntaxError("SELECT", { line: 1, column: 7 });
  assertSyntaxError("SELECT 1 +", { line: 1, column: 11 });
  assertSyntaxError("SELECT (1 + 2", { line: 1, column: 14 });
  assertSyntaxError("SELECT 1 2", { line: 1, column: 10 });
  assertSyntaxError("SELECT )", { line: 1, column: 8 });
  assertSyntaxError("SELECT a = = b", { line: 1, column: 12 });
  assertSyntaxError("SELECT * FROM t WHERE a AND", { line: 1, column: 28 });
  assertSyntaxError("SELECT DEFAULT", { line: 1, column: 8 }, /DEFAULT can only be used/);
  assertSyntaxError("SELECT FROM t", { line: 1, column: 8 });
  assertSyntaxError("SELECT a,, b", { line: 1, column: 10 });
});
