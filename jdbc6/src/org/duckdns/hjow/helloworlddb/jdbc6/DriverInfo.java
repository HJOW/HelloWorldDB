package org.duckdns.hjow.helloworlddb.jdbc6;

/** 드라이버의 식별 정보. JDBC 4.0 메타데이터와 버전 확인에 함께 사용한다.
 *
 * <p>드라이버 이름, 버전, JDBC 기준 버전(4.0)을 상수로 제공한다.
 * 인스턴스를 만들 수 없으며 모든 멤버는 정적이다.</p> */
public final class DriverInfo {
    /** 드라이버의 표시 이름. */
    public static final String NAME = "HelloWorldDB JDBC 4.0 Driver";
    /** 드라이버의 버전 문자열. */
    public static final String VERSION = "0.1.0";
    /** 지원하는 JDBC 주 버전. JDBC 4.0 기준이므로 4이다. */
    public static final int JDBC_MAJOR_VERSION = 4;
    /** 지원하는 JDBC 부 버전. JDBC 4.0 기준이므로 0이다. */
    public static final int JDBC_MINOR_VERSION = 0;

    /** 외부에서 인스턴스를 만들 수 없도록 막는 전용 생성자. */
    private DriverInfo() {
    }
}
