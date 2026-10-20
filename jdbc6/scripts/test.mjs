import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "./build.mjs";
import { ROOT, BUILD, JAR, filesUnder, compile, requireCompile, command, run, testRuntimes } from "./java-tools.mjs";

export function registerTests(requireMatrix = false) {
  const tools = build();
  const classes = path.join(BUILD, "test-classes");
  requireCompile(compile(tools.javac, filesUnder(path.join(ROOT, "test"), ".java"), classes, JAR, "test-sources.txt"));
  const runtimes = testRuntimes(tools);

  test("배포·시험 클래스가 모두 Java 6 바이트코드(50)이다", () => {
    for (const file of filesUnder(BUILD, ".class")) {
      const header = fs.readFileSync(file);
      assert.equal(header.readUInt32BE(0), 0xcafebabe, file);
      assert.equal(header.readUInt16BE(6), 50, file);
    }
  });

  const newer = runtimes.filter((runtime) => runtime.major > 6 && fs.existsSync(path.join(path.dirname(runtime.executable), process.platform === "win32" ? "javac.exe" : "javac")))
    .sort((a, b) => b.major - a.major)[0];
  test("최신 JDK를 빌드용으로 지정하면 기존 배포본을 지우기 전에 거부한다", {
    skip: newer ? false : "비교할 최신 JDK가 없다.",
  }, () => {
    const before = fs.readFileSync(JAR);
    const result = command(process.execPath, [path.join(ROOT, "scripts", "build.mjs")], {
      env: { ...process.env, HWDB_JAVA6_HOME: path.dirname(path.dirname(newer.executable)) },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /JDK 6/);
    assert.deepEqual(fs.readFileSync(JAR), before);
  });

  const probes = [
    ["자바 6 문법과 API는 컴파일한다", "return new String(new byte[] { 65 }, \"UTF-8\");", true],
    ["자바 7 전용 클래스 사용을 거부한다", "return java.util.Objects.toString(null);", false],
    ["기존 클래스의 자바 8 전용 메서드도 거부한다", "return String.join(\",\", new String[] { \"a\", \"b\" });", false],
    ["JDBC 4.1 전용 메서드를 거부한다", "return ((java.sql.Connection) null).getSchema();", false],
    ["자바 7 다이아몬드 문법을 거부한다", "return new java.util.ArrayList<>();", false],
  ];
  probes.forEach(([title, body, valid], index) => {
    test(title, () => {
      const dir = path.join(BUILD, `probe-${index}-한글 경로`);
      fs.mkdirSync(dir);
      const source = path.join(dir, "ApiProbe.java");
      fs.writeFileSync(source, `public final class ApiProbe { public Object probe() throws Exception { ${body} } }\n`, "utf8");
      const result = compile(tools.javac, [source], dir, JAR, `probe-${index}-sources.txt`);
      if (valid) {
        requireCompile(result);
        assert.ok(fs.existsSync(path.join(dir, "ApiProbe.class")));
      } else {
        assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
        assert.ok(result.stderr.length > 0);
        assert.equal(fs.existsSync(path.join(dir, "ApiProbe.class")), false);
      }
    });
  });

  for (const major of [6, 7, 8]) {
    const found = runtimes.some((runtime) => runtime.major === major);
    test(`시험 환경에 Java ${major} 런타임이 있다`, {
      skip: !requireMatrix && !found ? `HWDB_JAVA${major}_HOME을 지정하면 검증한다.` : false,
    }, () => assert.ok(found, `Java ${major} 런타임이 없다. HWDB_JAVA${major}_HOME을 지정한다.`));
  }

  for (const runtime of runtimes) {
    test(`같은 배포 JAR을 Java ${runtime.version}에서 실행한다 (${runtime.executable})`, () => {
      const before = fs.readFileSync(JAR);
      // 클래스 경로에는 배포 JAR과 별도 시험 클래스만 둔다. Eclipse의 bin 출력은 사용하지 않는다.
      const output = run(runtime.executable, ["-cp", [JAR, classes].join(path.delimiter),
        "org.duckdns.hjow.helloworlddb.jdbc6.BuildEnvironmentTest", JAR]);
      assert.match(output, /PASS: packaged JAR/);
      assert.deepEqual(fs.readFileSync(JAR), before);
      console.log(output.trim());
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) registerTests();
