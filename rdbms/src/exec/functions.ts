/**
 * 내장 함수.
 *
 * 담당
 *  - 집계 함수 : COUNT, SUM, AVG, MIN, MAX (DISTINCT 포함)
 *  - ANSI 함수 : UPPER, LOWER, TRIM, SUBSTRING, POSITION, CHAR_LENGTH, EXTRACT, COALESCE, NULLIF,
 *    CURRENT_DATE, CURRENT_TIMESTAMP, CURRENT_USER 등
 *  - 표준은 아니지만 널리 쓰이는 함수 : LENGTH, SUBSTR, REPLACE, LTRIM, RTRIM, CONCAT, ROUND
 *  - Oracle 호환 함수 : NVL, TO_CHAR, TO_DATE
 *    날짜 형식 요소(YYYY, MM, DD, HH24, MI, SS, FF1~FF6 등)와 숫자 형식 요소(9, 0, ., ,, FM)의 해석 포함.
 *    형식을 생략하면 ISO 8601 형태를 쓴다. TO_DATE 는 TIMESTAMP(0) 을 돌려준다.
 *  - 함수 이름으로 구현을 찾는 등록부, 인자의 개수와 타입 검사
 *
 * 관련 사양 : AGENTS.md 상세 1-5
 * 구현 단계 : 6단계
 */
