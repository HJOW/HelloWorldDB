/**
 * 질의 실행.
 *
 * 담당
 *  - 실행 계획(planner.ts)을 따라 행을 만들어 낸다 :
 *    전체 스캔과 인덱스 스캔, 조건, 조인(INNER, LEFT, RIGHT, FULL, CROSS), GROUP BY 와 HAVING,
 *    DISTINCT, 정렬, 집합 연산(UNION, INTERSECT, EXCEPT), 행 수 제한
 *  - 서브쿼리 : 스칼라, 인라인 뷰, IN, EXISTS, ANY, ALL, 상관 서브쿼리
 *  - FROM 절이 없는 SELECT 는 행 하나짜리 결과를 낸다.
 *  - SELECT ... FOR UPDATE 는 읽은 행에 잠금을 건다. (txn/lockManager.ts)
 *  - 결과를 한꺼번에 만들지 않고, 요청하는 만큼씩 꺼내 갈 수 있게 한다.
 *
 * 식의 계산은 expression.ts, 함수는 functions.ts 에 맡긴다.
 *
 * 관련 사양 : AGENTS.md 상세 1-4
 * 구현 단계 : 6단계
 */
