/**
 * 데이터 타입의 정의.
 *
 * 담당
 *  - 지원하는 타입의 목록과 별칭 (예 : INT → INTEGER, NVARCHAR → VARCHAR)
 *  - 길이, 정밀도, 소수 초 자릿수의 허용 범위와 생략했을 때의 기본값
 *    (예 : VARCHAR 는 65,535, NUMERIC 은 (38,0), TIMESTAMP 는 6)
 *  - 지원하지 않는 타입(CLOB, BLOB, JSON 등)을 가려 SQLSTATE 0A000 으로 알린다.
 *
 * 관련 사양 : AGENTS.md 상세 1-1, 13
 * 구현 단계 : 3단계
 */
