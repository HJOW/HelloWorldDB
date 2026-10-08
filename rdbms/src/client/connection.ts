/**
 * 클라이언트 쪽 프로토콜 구현.
 *
 * 담당
 *  - 세 접속 경로로 서버에 연결한다 : 로컬 전용 채널, TCP (SSL 포함), UDP
 *  - 핸드셰이크와 프로토콜 버전 협상, SCRAM-SHA-256 인증
 *  - 문장 실행과 `?` 파라미터 전달, 결과를 fetch 단위로 나누어 받기, 커서 닫기, ping, 접속 종료
 *  - 데몬 제어 요청 (상태 조회, 종료) 보내기
 *
 * CLI 와 테스트가 함께 쓴다. 나중에 `nodejsDriver` 의 출발점이 되므로,
 * 서버 쪽 모듈(session, exec, catalog 등)을 import 하지 않는다.
 * 서버와 공유하는 것은 프로토콜 정의뿐이다 :
 * net/protocol.ts, net/framing.ts, net/udpReliability.ts, auth/scram.ts
 *
 * 관련 사양 : AGENTS.md 상세 8
 * 구현 단계 : 9단계
 */
