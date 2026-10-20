import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, BUILD, DIST, JAR, PACKAGE, java6Tools, resetOutput, filesUnder, compile, requireCompile, run } from "./java-tools.mjs";

export function build() {
  // 최신 JDK의 -target 옵션에 의존하지 않고 실제 JDK 6의 API로 컴파일한다.
  const tools = java6Tools();
  resetOutput(BUILD);
  resetOutput(DIST);
  const sources = filesUnder(path.join(ROOT, "src"), ".java");
  if (!sources.length) throw new Error("컴파일할 자바 소스가 없다.");
  const classes = path.join(BUILD, "classes");
  requireCompile(compile(tools.javac, sources, classes, classes, "main-sources.txt"));
  const meta = path.join(classes, "META-INF");
  fs.mkdirSync(meta);
  fs.copyFileSync(path.join(ROOT, "..", "LICENSE"), path.join(meta, "LICENSE"));
  fs.mkdirSync(path.join(meta, "services"));
  fs.writeFileSync(path.join(meta, "services", "java.sql.Driver"), "org.duckdns.hjow.helloworlddb.jdbc6.Driver\n", "utf8");
  const manifest = path.join(BUILD, "MANIFEST.MF");
  fs.writeFileSync(manifest, ["Manifest-Version: 1.0", "Implementation-Title: HelloWorldDB JDBC 4.0 Driver",
    `Implementation-Version: ${PACKAGE.version}`, "Implementation-Vendor: HJOW", "", ""].join("\r\n"), "utf8");
  run(tools.jar, ["cfm", JAR, manifest, "-C", classes, "."]);
  console.log(`빌드 완료: ${JAR}`);
  return tools;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) build();
