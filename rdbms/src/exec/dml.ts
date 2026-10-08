/**
 * 데이터 변경 : INSERT, UPDATE, DELETE, TRUNCATE.
 *
 * 담당
 *  - INSERT (VALUES 여러 행, INSERT ... SELECT), UPDATE, DELETE, TRUNCATE
 *  - 컬럼의 DEFAULT 적용
 *  - 제약조건 검사 : NOT NULL, PK(유일성), FK. 검사는 문장이 끝나는 시점에 한다.
 *  - FK 참조동작 : NO ACTION, RESTRICT, CASCADE, SET NULL
 *  - 변경한 행에 딸린 인덱스를 함께 고친다.
 *  - 갱신 가능한 뷰를 통한 변경을 기반 테이블의 변경으로 바꾼다.
 *  - 변경할 행에 잠금을 건다. (txn/lockManager.ts)
 *  - 문장이 실패하면 그 문장이 한 변경만 되돌릴 수 있게 한다. (txn/transaction.ts)
 *
 * TRUNCATE 는 DDL 처럼 실행 전후에 자동으로 커밋된다.
 *
 * 관련 사양 : AGENTS.md 상세 1-3, 1-4, 10, 11
 * 구현 단계 : 6단계
 */
