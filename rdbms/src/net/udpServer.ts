/**
 * UDP 접속 경로.
 *
 * 담당
 *  - 설정의 `port` 와 `udp.host` 로 UDP 패킷을 받는다. `udp.enabled` 가 false 면 열지 않는다.
 *    포트 번호는 TCP 와 같다.
 *  - 세션 식별 : 핸드셰이크 때 세션 ID 를 발급하고, 세션 ID 와 클라이언트 주소로 세션을 찾는다.
 *  - `udp.sessionTimeoutMs` 동안 수신이 없으면 세션을 끝낸다. 클라이언트는 ping 으로 세션을 유지한다.
 *  - 신뢰성 계층(udpReliability.ts)이 조립한 메시지를 메시지 처리기(messageHandler.ts)에 넘긴다.
 *
 * UDP 구간은 암호화하지 않는다. node:dgram 만 쓴다.
 *
 * 관련 사양 : AGENTS.md 상세 7, 8, 15
 * 구현 단계 : 9단계
 */
