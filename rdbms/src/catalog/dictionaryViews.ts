/**
 * 딕셔너리 뷰.
 *
 * 담당
 *  - 드라이버와 DB툴이 메타데이터를 조회하는 뷰를 SYSTEM 테이블스페이스에 제공한다 :
 *    SYS_TABLESPACES, SYS_USERS, SYS_TABLES, SYS_COLUMNS, SYS_VIEWS, SYS_INDEXES, SYS_INDEX_COLUMNS,
 *    SYS_CONSTRAINTS, SYS_CONSTRAINT_COLUMNS, SYS_PRIVILEGES, SYS_GROUP_GRANTS, SYS_SESSIONS
 *  - 읽기 전용이다. DDL 이나 DML 로 직접 고칠 수 없다.
 *  - 모든 사용자가 조회할 수 있되, 자신이 권한을 가진 객체의 행만 보인다. DBA 는 전부 본다. (8단계)
 *  - 비밀번호 검증 정보는 누구에게도 보여 주지 않는다.
 *  - `SYS_` 로 시작하는 이름과 `DUAL` 은 SYSTEM 테이블스페이스에서 예약한다.
 *
 * 관련 사양 : AGENTS.md 상세 3
 * 구현 단계 : 5단계(뷰 제공), 8단계(권한에 따른 행 가시성)
 */
