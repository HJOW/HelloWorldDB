// Node.js는 빌드·시험만 조정한다. 배포 JAR의 실행에는 필요하지 않다.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const BUILD = path.join(ROOT, "build");
export const DIST = path.join(ROOT, "dist");
export const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
export const JAR = path.join(DIST, `${PACKAGE.name}-${PACKAGE.version}.jar`);
const EXE = process.platform === "win32" ? ".exe" : "";

export function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 120_000, ...options,
  });
  if (result.error) throw new Error(`실행 실패: ${executable}`, { cause: result.error });
  return result;
}

export function run(executable, args, options) {
  const result = command(executable, args, options);
  if (result.status !== 0) {
    throw new Error(`명령 실패(${result.status}): ${executable}\n${result.stdout}${result.stderr}`);
  }
  return `${result.stdout}${result.stderr}`;
}

export function javaVersion(executable) {
  const output = run(executable, ["-version"]);
  const version = /(?:java|openjdk) version "([^"]+)"/.exec(output)?.[1];
  if (!version) throw new Error(`자바 버전을 읽을 수 없다: ${executable}\n${output}`);
  const major = Number(version.startsWith("1.") ? version.split(".")[1] : version.split(".")[0]);
  if (!Number.isInteger(major) || major < 6) throw new Error(`지원하지 않는 자바 버전: ${version}`);
  return { executable, version, major };
}

export function java6Tools() {
  const home = process.env.HWDB_JAVA6_HOME || (process.platform === "win32" ? "C:/Program Files/Java/jdk1.6.0_45" : "");
  if (!home) throw new Error("JDK 6 설치 경로를 HWDB_JAVA6_HOME으로 지정해야 한다.");
  const java = path.resolve(home, "bin", `java${EXE}`);
  const javac = path.resolve(home, "bin", `javac${EXE}`);
  const jar = path.resolve(home, "bin", `jar${EXE}`);
  if (javaVersion(java).major !== 6 || !/^javac 1\.6\./m.test(run(javac, ["-version"]))) {
    throw new Error("빌드에는 JDK 6의 java와 javac가 필요하다. HWDB_JAVA6_HOME을 확인한다.");
  }
  if (!fs.existsSync(jar)) throw new Error(`jar 도구가 없다: ${jar}`);
  return { java, javac, jar };
}

export function filesUnder(directory, suffix) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    // 외부 디렉토리를 가리키는 링크는 따라가지 않는다.
    return entry.isDirectory() ? filesUnder(full, suffix) : entry.isFile() && full.endsWith(suffix) ? [full] : [];
  }).sort();
}

/** 지우는 경로는 이 프로젝트가 생성하는 출력 디렉토리로 한정한다. */
export function resetOutput(directory) {
  const absolute = path.resolve(directory);
  if (absolute !== BUILD && absolute !== DIST) throw new Error(`출력 디렉토리가 아니다: ${absolute}`);
  if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) throw new Error(`출력 경로가 링크이다: ${absolute}`);
  fs.rmSync(absolute, { recursive: true, force: true });
  fs.mkdirSync(absolute, { recursive: true });
}

export function compile(javac, files, output, classpath, listName) {
  fs.mkdirSync(output, { recursive: true });
  const listPath = path.join(BUILD, listName);
  fs.writeFileSync(listPath, files.map((file) => {
    if (/["\r\n]/.test(file)) throw new Error(`지원하지 않는 소스 경로: ${file}`);
    return `"${file.replaceAll("\\", "/")}"`;
  }).join("\n"), "utf8");
  // 소스 목록 파일의 한글 경로도 운영체제의 기본 인코딩과 무관하게 읽는다.
  return command(javac, ["-J-Dfile.encoding=UTF-8", "-encoding", "UTF-8", "-source", "1.6", "-target", "1.6", "-Xlint:all", "-Werror",
    "-classpath", classpath, "-d", output, `@${listPath}`]);
}

export function requireCompile(result) {
  if (result.status !== 0) throw new Error(`자바 6 컴파일 실패\n${result.stdout}${result.stderr}`);
}

/** 명시한 환경 변수는 오타나 실행 실패를 숨기지 않는다. 없는 기본 후보만 건너뛴다. */
export function testRuntimes(tools) {
  const homes = [
    ["HWDB_JAVA7_HOME", process.platform === "win32" ? path.join(ROOT, ".tools", "java7", "zulu7.56.0.11-ca-jdk7.0.352-win_x64") : "", 7],
    ["HWDB_JAVA8_HOME", process.platform === "win32" ? "C:/Program Files/Java/jdk8u432-b06" : "", 8],
  ];
  const candidates = [tools.java];
  for (const [key, fallback, expectedMajor] of homes) {
    const home = process.env[key] || fallback;
    if (!home) continue;
    const executable = path.resolve(home, "bin", `java${EXE}`);
    if (process.env[key] || fs.existsSync(executable)) {
      if (javaVersion(executable).major !== expectedMajor) throw new Error(`${key}에는 Java ${expectedMajor} 설치 경로를 지정해야 한다.`);
      candidates.push(executable);
    }
  }
  if (process.env.HWDB_TEST_JAVA_HOMES) {
    for (const home of process.env.HWDB_TEST_JAVA_HOMES.split(path.delimiter).filter(Boolean)) {
      candidates.push(path.resolve(home, "bin", `java${EXE}`));
    }
  }
  if (process.env.JAVA_HOME) candidates.push(path.resolve(process.env.JAVA_HOME, "bin", `java${EXE}`));
  // PATH의 java도 시험하되 JAVA_HOME과 같은 설치본이면 중복 실행하지 않는다.
  const onPath = (process.env.PATH || "").split(path.delimiter)
    .map((entry) => path.join(entry.replace(/^"|"$/g, ""), `java${EXE}`))
    .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (onPath) candidates.push(onPath);
  return [...new Set(candidates.map((candidate) => fs.realpathSync(candidate)))].map(javaVersion);
}
