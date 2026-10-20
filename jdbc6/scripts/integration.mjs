import path from 'node:path';
import { child, server, lossy, tls } from '../../jdbc8/scripts/test-support.mjs';
import { build } from './build.mjs';
import { ROOT, BUILD, JAR, compile, filesUnder, requireCompile, testRuntimes, run } from './java-tools.mjs';

const tools = build();
const classes = path.join(BUILD, 'test-classes');
requireCompile(compile(tools.javac, filesUnder(path.join(ROOT, 'test'), '.java'), classes, JAR, 'test-sources.txt'));
const runtimes = testRuntimes(tools);
for (const major of [6, 7, 8, 21]) if (!runtimes.some(r => r.major === major)) throw new Error(`Java ${major} 시험 환경이 필요하다.`);
const cp = [JAR, classes].join(path.delimiter);
let count = 0;
async function java(runtime, args, suffix = '') {
  console.log(`Java ${runtime.version}: ${args.join(' ')}`);
  const output = await child(runtime.executable, ['-Dfile.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8', '-Duser.timezone=Asia/Seoul', '-Dhwdb.test.suffix=' + suffix, '-cp', cp, 'org.duckdns.hjow.helloworlddb.jdbc6.JdbcTest', ...args]);
  console.log(output.trim()); count += Number(/PASSED (\d+)/.exec(output)?.[1] || 0);
}
const rdbms = path.resolve(ROOT, '../rdbms');
run(process.execPath, [path.join(rdbms, 'node_modules/typescript/bin/tsc'), '-p', path.join(rdbms, 'tsconfig.json')], { cwd: rdbms });
for (const runtime of runtimes) await java(runtime, ['unit']);
await server({}, async (url, port) => {
  for (const runtime of runtimes) { await java(runtime, ['integration', url, 'tcp']); await java(runtime, ['integration', url, 'udp']); }
  await lossy(port, async proxy => { for (const runtime of runtimes) await java(runtime, ['integration', `jdbc:helloworlddb://127.0.0.1:${proxy}`, 'udp'], 'LOSS'); });
});
for (const runtime of runtimes) {
  const minVersion = runtime.major === 6 ? 'TLSv1' : 'TLSv1.2';
  await server({ tcp: { ssl: { certPath: tls('server-a.cert.pem'), keyPath: tls('server-a.key.pem'), minVersion } } }, async url => {
    await java(runtime, ['integration', url, 'tls', tls('server-a.cert.pem')]);
  });
  await server({ tcp: { ssl: { certPath: tls('server-other-name.cert.pem'), keyPath: tls('server-other-name.key.pem'), minVersion } } }, async url => {
    await java(runtime, ['tls-reject', url, tls('server-other-name.cert.pem')]);
  });
}
console.log(`jdbc6 실제 서버 시험 ${count}개 통과, 실패·건너뜀 0. 시험 서버 정상 종료.`);
