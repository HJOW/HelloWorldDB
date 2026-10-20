import { child, server, lossy, tls } from './test-support.mjs';
import path from 'node:path';
import { build, compile, files, ROOT, BUILD, JAR, JAVA8, JAVA21, tool, run } from './build.mjs';
import { syncProtocol } from './sync-protocol.mjs';

build(); syncProtocol(true);
const classes = path.join(BUILD, 'test-classes'); compile(files(path.join(ROOT, 'test')), classes, JAR);
const runtimes = [JAVA8, JAVA21];
const cp = [JAR, classes].join(path.delimiter);
let total = 0;
const rdbms = path.resolve(ROOT, '../rdbms');
async function java(home, args, suffix = '') {
  console.log(run(tool(home, 'java'), ['-version']).trim());
  const output = await child(tool(home, 'java'), ['-Dfile.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8', '-Duser.timezone=Asia/Seoul', '-Dhwdb.test.suffix=' + suffix, '-cp', cp, 'org.duckdns.hjow.helloworlddb.jdbc8.DriverTest', ...args]);
  console.log(output.trim()); total += Number(/PASSED (\d+)/.exec(output)?.[1] || 0);
}
// 서버 소스 변경 후 오래된 dist로 시험하는 일을 막기 위해 항상 다시 빌드한다.
const tsc = path.join(rdbms, 'node_modules/typescript/bin/tsc');
run(process.execPath, [tsc, '-p', path.join(rdbms, 'tsconfig.json')], { cwd: rdbms });
// 공유 파일은 실제 Java 6 API와 문법으로도 검증한다.
console.log(run(process.execPath, [path.resolve(ROOT, '../jdbc6/scripts/build.mjs')]).trim());
for (const home of runtimes) await java(home, ['unit', JAR]);
await server({}, async (url, port) => {
  for (const home of runtimes) { await java(home, ['integration', url, 'tcp']); await java(home, ['integration', url, 'udp']); }
  await lossy(port, async proxy => { for (const home of runtimes) await java(home, ['integration', `jdbc:helloworlddb://127.0.0.1:${proxy}`, 'udp'], 'LOSS'); });
});
await server({ tcp: { ssl: { certPath: tls('server-a.cert.pem'), keyPath: tls('server-a.key.pem') } } }, async url => {
  for (const home of runtimes) await java(home, ['integration', url, 'tls', tls('server-a.cert.pem')]);
});
await server({ tcp: { ssl: { certPath: tls('server-other-name.cert.pem'), keyPath: tls('server-other-name.key.pem') } } }, async url => {
  for (const home of runtimes) await java(home, ['tls-reject', url, tls('server-other-name.cert.pem')]);
});
console.log(`전체 Java 시험 ${total}개 통과, 실패·건너뜀 0. 시험 서버 정상 종료.`);
