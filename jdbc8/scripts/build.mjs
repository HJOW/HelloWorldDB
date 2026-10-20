import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syncProtocol } from './sync-protocol.mjs';
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const BUILD = path.join(ROOT, 'build');
export const DIST = path.join(ROOT, 'dist');
export const JAR = path.join(DIST, 'org.duckdns.hjow.helloworlddb.jdbc8-0.1.0.jar');
export const JAVA8 = process.env.HWDB_JAVA8_HOME || 'C:/Program Files/Java/jdk8u432-b06';
export const JAVA21 = process.env.HWDB_JAVA21_HOME || 'C:/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot';
const ext = process.platform === 'win32' ? '.exe' : '';
export const tool = (home, name) => path.join(home, 'bin', name + ext);
export function run(exe, args, options = {}) {
  const r = spawnSync(exe, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 120000, ...options });
  if (r.error || r.status !== 0) throw new Error(`명령 실패: ${exe}\n${r.stdout || ''}${r.stderr || ''}`, { cause: r.error });
  return r.stdout + r.stderr;
}
export function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.java') ? [path.join(dir, e.name)] : []); }
export function compile(sources, output, cp = output) {
  fs.mkdirSync(output, { recursive: true });
  const list = path.join(BUILD, 'sources.txt');
  fs.writeFileSync(list, sources.map(f => `"${f.replaceAll('\\', '/')}"`).join('\n'), 'utf8');
  return run(tool(JAVA8, 'javac'), ['-J-Dfile.encoding=UTF-8', '-encoding', 'UTF-8', '-source', '1.8', '-target', '1.8', '-Xlint:all', '-Werror', '-classpath', cp, '-d', output, '@' + list]);
}
export function build() {
  if (!/javac 1\.8\./.test(run(tool(JAVA8, 'javac'), ['-version']))) throw new Error('HWDB_JAVA8_HOME에 실제 JDK 8을 지정한다.');
  syncProtocol(true);
  for (const dir of [BUILD, DIST]) {
    // 생성물 경로를 확인한 뒤 같은 파일 API로만 정리한다.
    if (path.dirname(dir) !== path.resolve(ROOT) || (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink())) throw new Error('잘못된 출력 경로');
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
  }
  const classes = path.join(BUILD, 'classes'); compile(files(path.join(ROOT, 'src')), classes);
  const meta = path.join(classes, 'META-INF'); fs.mkdirSync(path.join(meta, 'services'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, '../LICENSE'), path.join(meta, 'LICENSE'));
  fs.writeFileSync(path.join(meta, 'services/java.sql.Driver'), 'org.duckdns.hjow.helloworlddb.jdbc8.Driver\n');
  const manifest = path.join(BUILD, 'MANIFEST.MF');
  fs.writeFileSync(manifest, 'Manifest-Version: 1.0\r\nImplementation-Title: HelloWorldDB JDBC 4.2 Driver\r\nImplementation-Version: 0.1.0\r\n\r\n');
  run(tool(JAVA8, 'jar'), ['cfm', JAR, manifest, '-C', classes, '.']);
  console.log(`빌드 완료: ${JAR}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) build();
