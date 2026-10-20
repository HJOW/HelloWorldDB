package org.duckdns.hjow.helloworlddb.jdbc6;

/** 드라이버의 식별 정보. JDBC 구현 단계에서 메타데이터와 함께 사용한다. */
public final class DriverInfo {
    public static final String NAME = "HelloWorldDB JDBC 4.0 Driver";
    public static final String VERSION = "0.1.0";
    public static final int JDBC_MAJOR_VERSION = 4;
    public static final int JDBC_MINOR_VERSION = 0;

    private DriverInfo() {
    }
}
