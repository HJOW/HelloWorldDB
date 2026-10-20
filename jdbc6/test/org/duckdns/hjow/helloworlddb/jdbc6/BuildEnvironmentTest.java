package org.duckdns.hjow.helloworlddb.jdbc6;

import java.io.DataInputStream;
import java.io.File;
import java.util.jar.JarFile;
import java.util.jar.Manifest;

/** 같은 배포 JAR과 시험 클래스를 각 자바 런타임으로 직접 실행한다. */
public final class BuildEnvironmentTest {
    private BuildEnvironmentTest() {
    }

    private static void check(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }

    public static void main(String[] args) throws Exception {
        File artifact = new File(DriverInfo.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        check(artifact.isFile() && artifact.getName().endsWith(".jar"), "The driver must be loaded from the packaged JAR.");
        check(artifact.getCanonicalPath().equals(new File(args[0]).getCanonicalPath()), "An unexpected JAR was loaded.");

        JarFile jar = new JarFile(artifact);
        try {
            Manifest manifest = jar.getManifest();
            check(DriverInfo.NAME.equals(manifest.getMainAttributes().getValue("Implementation-Title")), "Manifest title mismatch.");
            check(DriverInfo.VERSION.equals(manifest.getMainAttributes().getValue("Implementation-Version")), "Manifest version mismatch.");
            check(jar.getJarEntry("META-INF/LICENSE") != null, "Project license is missing.");
            check(jar.getJarEntry("org/duckdns/hjow/helloworlddb/jdbc6/BuildEnvironmentTest.class") == null, "Test classes must not be distributed.");
        } finally {
            jar.close();
        }

        DataInputStream input = new DataInputStream(DriverInfo.class.getResourceAsStream("DriverInfo.class"));
        try {
            check(input.readInt() == 0xCAFEBABE, "Invalid class file.");
            input.readUnsignedShort();
            check(input.readUnsignedShort() == 50, "Java 6 class format is required.");
        } finally {
            input.close();
        }

        // 한글 소스를 UTF-8로 컴파일했는지 런타임의 기본 인코딩과 무관하게 확인한다.
        String korean = "한글";
        check(korean.charAt(0) == 0xD55C && korean.charAt(1) == 0xAE00, "Source encoding is not UTF-8.");
        check(DriverInfo.JDBC_MAJOR_VERSION == 4 && DriverInfo.JDBC_MINOR_VERSION == 0, "JDBC 4.0 is required.");
        System.out.println("PASS: packaged JAR, manifest, Java 6 bytecode, UTF-8 source; java=" + System.getProperty("java.version"));
    }
}
