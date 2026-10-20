package org.duckdns.hjow.helloworlddb.jdbc6.protocol;
import java.io.IOException;

/**
 * 메시지 경계와 크기 한도를 보존하는 전송 계층 인터페이스이다.
 * <p>TCP와 UDP 구현이 이 계약을 공유하며, 상위 프로토콜 계층은
 * 구현 종류와 관계없이 메시지 단위로 송수신한다.</p>
 */
public interface Transport {
    /**
     * 메시지 하나를 전송한다.
     * <p>호출자가 전달한 바이트 배열 전체가 하나의 메시지로 취급되며,
     * 하위 전송로가 조각내더라도 받는 쪽에서는 하나로 합쳐진다.</p>
     *
     * @param message 전송할 메시지 본문. 비어 있거나 크기 한도를 넘으면 안 된다
     * @throws IOException 전송 중 오류가 발생하거나 한도를 위반한 경우
     */
    void send(byte[] message) throws IOException;
    /**
     * 메시지 하나를 수신한다.
     *
     * @param timeoutMs 수신 대기 제한 시간(밀리초). 0이면 제한 없이 기다린다
     * @return 수신한 메시지 본문 한 개
     * @throws IOException 수신 실패, 시간 초과, 연결 종료 시
     */
    byte[] receive(int timeoutMs) throws IOException;
    /**
     * 한 메시지의 최대 허용 크기를 설정한다.
     * <p>인증 전에는 작은 값으로, 인증 뒤에는 서버와 합의된 값으로 바꾼다.</p>
     *
     * @param limit 바이트 단위의 최대 메시지 크기
     */
    void setLimit(int limit);
    /**
     * 전송로를 닫고 관련 자원을 해제한다.
     * <p>이미 닫힌 상태에서 호출해도 오류 없이 넘어간다.</p>
     */
    void close();
}
