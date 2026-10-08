/**
 * TCP 접속 경로.
 *
 * 담당
 *  - 설정의 `port` 와 `tcp.host` 로 TCP 접속을 받는다. `tcp.enabled` 가 false 면 열지 않는다.
 *  - SSL : `tcp.ssl` 의 인증서와 개인키가 설정되어 있으면 포트 전체를 TLS 로 운영한다.
 *    이 때 평문 접속은 받지 않는다.
 *  - TLS 최소 버전 : `tcp.ssl.minVersion` (기본 TLSv1.2).
 *    낮추면 그 버전에서 쓰는 암호 스위트도 함께 허용하고 구동 로그에 경고를 남긴다.
 *  - 프레임(framing.ts)으로 메시지를 잘라 메시지 처리기(messageHandler.ts)에 넘긴다.
 *  - 연결이 끊기면 세션을 끝낸다.
 *
 * node:net, node:tls 만 쓴다.
 *
 * 관련 사양 : AGENTS.md 상세 7, 8, 15
 * 구현 단계 : 9단계
 */
