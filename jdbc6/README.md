# HelloWorldDB JDBC 4.0 드라이버

자바 6~7용 드라이버이며 같은 JAR을 자바 8 이상에서도 사용할 수 있도록 개발한다.
패키지는 `org.duckdns.hjow.helloworlddb.jdbc6`이다.

현재는 **14-1 빌드와 시험 기반**을 구현했다. 생성되는 JAR에는 식별 정보만 들어 있다. DB 접속과 `java.sql.Driver` 구현·자동 등록은 후속 단계이다.
자세한 진행 상황과 다음 작업은 [PROGRESS.md](PROGRESS.md)에 기록한다.

## 빌드

외부 라이브러리와 Maven·Gradle 없이 **JDK 6**의 `javac`, `jar`로 만든다. 빌드·시험 실행기는 Node.js 22 이상을 사용하며, JAR 실행에는 Node.js가 필요하지 않다. `npm install`도 필요하지 않다.

`jdbc6` 디렉토리에서 실행한다.

```powershell
$env:HWDB_JAVA6_HOME = "C:\Program Files\Java\jdk1.6.0_45"
npm.cmd run build
npm.cmd test
npm.cmd run test:matrix
```

자바 6 문법·바이트코드뿐 아니라 **API도 실제 JDK 6으로 제한**한다. 최신 JDK의 `-source`, `-target`만 지정하는 방식은 사용하지 않는다.
소스는 UTF-8로 읽고 생성한 `.class`의 버전이 50인지 검사한다. JDK 6이 아닌 컴파일러를 지정하면 실패한다.

- `src/` : 자바 소스. 기존 Eclipse 프로젝트 설정의 경로를 따른다.
- `test/` : 자바 6으로 컴파일하는 시험 클래스. 배포 JAR에 포함하지 않는다.
- `build/` : 클래스, 소스 목록과 임시 시험 자료.
- `dist/org.duckdns.hjow.helloworlddb.jdbc6-0.1.0.jar` : 배포 JAR.

빌드가 지우고 다시 만드는 경로는 `build/`, `dist/`뿐이다. Eclipse의 `bin/`은 사용하지 않는다.

## 자바 버전별 시험

`npm test`는 발견한 런타임으로 같은 배포 JAR과 시험 클래스를 실행한다. Java 6·7·8 중 없는 환경은 건너뛴 것으로 표시한다.
`npm run test:matrix`는 세 버전 중 하나라도 없으면 실패한다. PATH의 `java`와 `JAVA_HOME`도 추가로 시험한다.

| 환경 변수 | 용도 |
|---|---|
| `HWDB_JAVA6_HOME` | 빌드와 자바 6 시험에 사용하는 JDK. Windows 기본 후보는 `C:\Program Files\Java\jdk1.6.0_45` |
| `HWDB_JAVA7_HOME` | 자바 7 시험용 JDK 또는 JRE |
| `HWDB_JAVA8_HOME` | 자바 8 시험용 JDK 또는 JRE. Windows 기본 후보는 `C:\Program Files\Java\jdk8u432-b06` |
| `HWDB_TEST_JAVA_HOMES` | 추가 시험용 JDK/JRE 목록. Windows에서는 `;`, 그 외에는 `:`로 구분 |

예를 들어 다른 장비에서는 설치 경로를 환경 변수로 지정한다.

```sh
HWDB_JAVA6_HOME=/opt/jdk6 HWDB_JAVA7_HOME=/opt/jdk7 HWDB_JAVA8_HOME=/opt/jdk8 npm run test:matrix
```

시험은 기본값 PATH의 컴파일러를 사용하지 않는다. 자바 7 전용 클래스, 자바 8 전용 메서드, JDBC 4.1 전용 메서드와 자바 7 문법이 실제로 컴파일에 실패하는지도 확인한다.
앞으로 서버 통합 시험도 같은 방식으로 별도 시험 클래스의 `main`을 해당 런타임의 `java -cp`로 호출한다.

`VM-W11-Codex`에서 사용하는 자바 7의 로컬 후보 경로는 `.tools/java7/zulu7.56.0.11-ca-jdk7.0.352-win_x64`이다.
[Azul의 공식 배포본](https://cdn.azul.com/zulu/bin/zulu7.56.0.11-ca-jdk7.0.352-win_x64.zip)을 내려받아 시스템 설정을 바꾸지 않고 압축을 푼다. 빌드·시험 명령은 JDK를 자동으로 내려받지 않는다.
[공식 메타데이터 API](https://docs.azul.com/core/install/metadata-api)에서 확인한 ZIP의 SHA-256은 `a0255d1e29d4ab9d685b698217d9adca6a29b2e493608d4e73feda84e7759085`이다.
`.tools/`와 생성한 빌드 결과는 Git에서 제외한다.
