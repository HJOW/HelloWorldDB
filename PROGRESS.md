# HelloWorldDB 전체 진행 상황

프로젝트 전체에 걸친 진행 상황과 공통 인수인계 사항을 적는다.
사양과 구현 계획은 AGENTS.md 가 기준이고, 프로젝트별 세부 계획과 진행 상황은 각 디렉토리의 PROGRESS.md 에 있다.

## 현재 상태

- 최종 갱신 : 2026-10-08
- 사양(AGENTS.md 의 개요와 상세)과 구현 계획을 세웠다. 구현은 아직 시작하지 않았다.
- 지금 진행할 범위는 `rdbms` 와 `nodejsDriver` 이다. JDBC(`jdbc8`, `jdbc5`)와 GUI DB툴(`gui`)은 보류했다.
- 다음 작업 : `rdbms` 1단계 (프로젝트 기반)

## 프로젝트별 상태

단계 번호는 AGENTS.md "구현 계획" 의 번호이다.

| 프로젝트 | 패키지명 | 단계 | 상태 | 착수 조건 | 세부 계획 |
|---|---|---|---|---|---|
| `rdbms` | `org.duckdns.hjow.helloworlddb.rdbms` | 1 ~ 11 | 착수 전 | 없음 | [rdbms/PROGRESS.md](rdbms/PROGRESS.md) |
| `nodejsDriver` | `org.duckdns.hjow.helloworlddb.nodejsdriver` | 12 | 착수 전 | 11단계 완료 | [nodejsDriver/PROGRESS.md](nodejsDriver/PROGRESS.md) |
| `jdbc8` | `org.duckdns.hjow.helloworlddb.jdbc8` | 없음 | 보류 | 계획부터 다시 정한다 | [jdbc8/PROGRESS.md](jdbc8/PROGRESS.md) |
| `jdbc5` | `org.duckdns.hjow.helloworlddb.jdbc5` | 없음 | 보류 | 계획부터 다시 정한다 | [jdbc5/PROGRESS.md](jdbc5/PROGRESS.md) |
| `gui` | `org.duckdns.hjow.helloworlddb.gui` | 없음 | 보류 | 계획부터 다시 정한다 | [gui/PROGRESS.md](gui/PROGRESS.md) |

## 공통 인수인계 사항

- 보류한 프로젝트의 PROGRESS.md 에는 보류 전에 잡아 둔 세부 계획이 초안으로 남아 있다. 확정된 계획이 아니므로 그대로 착수하지 않는다.
- RDBMS 사양 중 보류한 프로젝트를 위한 부분(자바 5, 6 용 TLS 최소 버전 설정, 메타데이터 조회용 딕셔너리 뷰)은 `rdbms` 에서 그대로 구현한다.
- 프로토콜 명세는 `rdbms` 9단계에서 `rdbms/docs` 에 작성한다. 모든 드라이버가 이 문서를 기준으로 삼는다.
  프로토콜을 바꾸면 프로토콜 버전을 올리고, 영향을 받는 드라이버 프로젝트의 PROGRESS.md 에 알린다.
- 명령은 `hwdb` 하나이다. `hwdb start`, `hwdb stop`, `hwdb status` 로 데몬을 제어하고, `hwdb` 로 SQL 접속을 한다. 서버 실행 파일을 따로 두지 않는다.
- 인스턴스는 포트 번호로 구분한다. SID 나 DB 이름은 없으며, TCP 와 UDP 가 같은 포트 번호를 쓴다.
- `rdbms` 의 CLI 는 `nodejsDriver` 보다 먼저 만들어지므로 자체 클라이언트 코드를 가진다. `nodejsDriver` 는 그 코드를 출발점으로 삼을 수 있다.
- SYSTEM 계정은 CONNECT 없이 만들어지므로 처음에는 로컬에서만 접속된다. 설치 후 관리자가 서버 장비에서 `hwdb` 로 접속해 초기 암호를 바꾸는 것이 표준 절차이다.

## 사용자 확인이 필요한 사항

지금 진행할 범위(`rdbms`, `nodejsDriver`)에는 없다.
보류한 프로젝트의 확인 사항(자바 빌드와 시험 환경, UI 프레임워크 등)은 각 PROGRESS.md 의 "미결 사항" 에 있으며, 보류를 풀 때 확인한다.

## 작업 이력

- 2026-10-08 : AGENTS.md 에 상세 사양과 구현 계획 작성.
- 2026-10-08 : 사양 변경 반영. 통신 방식을 HTTP 웹소켓에서 TCP 로 변경, 접속용 CLI 와 로컬 전용 채널 추가, 문법 생략 원칙 추가. 프로젝트별 PROGRESS.md 작성.
- 2026-10-08 : 사양 변경 반영. 데몬 구동과 CLI 를 통한 구동, 종료, 상태 조회 추가. SID 대신 포트 번호로 인스턴스를 식별하도록 명시하고 TCP 와 UDP 포트를 하나로 통합. 패키지명 규칙 확정. JDBC 와 GUI DB툴 보류.
