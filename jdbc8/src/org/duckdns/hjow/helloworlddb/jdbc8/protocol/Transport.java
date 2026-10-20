package org.duckdns.hjow.helloworlddb.jdbc8.protocol;
import java.io.IOException;

/** 메시지 경계와 한도를 보존하는 전송 인터페이스. */
public interface Transport {
    void send(byte[] message) throws IOException;
    byte[] receive(int timeoutMs) throws IOException;
    void setLimit(int limit);
    void close();
}
