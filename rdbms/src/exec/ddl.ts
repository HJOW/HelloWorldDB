/**
 * 객체 정의 변경 : 테이블, 뷰, 인덱스의 DDL.
 *
 * 담당
 *  - CREATE TABLE, ALTER TABLE(컬럼 추가와 삭제, DEFAULT 와 NOT NULL 변경, 이름 변경, 제약조건 추가와 삭제), DROP TABLE
 *  - CREATE VIEW (OR REPLACE 포함), DROP VIEW
 *  - CREATE INDEX, DROP INDEX. PK 를 만들 때 유일 인덱스를 자동으로 만든다.
 *  - 생략한 이름의 자동 부여 : PK_테이블명, FK_테이블명_순번, IX_테이블명_순번
 *  - RESTRICT 와 CASCADE : 다른 테이블의 FK 나 뷰가 참조하는 객체의 삭제 처리
 *  - 이미 데이터가 있는 테이블에 제약조건을 추가할 때 기존 데이터 검사
 *  - 실행 전후의 자동 커밋
 *
 * 정의의 저장은 catalog/catalog.ts 에 맡긴다.
 * 테이블스페이스, 사용자, 권한 문장은 각각 catalog/tablespaceManager.ts, auth/users.ts, auth/privileges.ts 가 맡는다.
 *
 * 관련 사양 : AGENTS.md 상세 1-3, 10, 11
 * 구현 단계 : 5단계
 */
