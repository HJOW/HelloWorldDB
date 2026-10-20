// JDBC 4.2 준비 문장·타입 힌트·취소를 실제 JDK 8 빌드로 검증한다.
import path from 'node:path';
import net from 'node:net';
import { child, server, lossy, tls } from './test-support.mjs';
import { build, compile, files, ROOT, BUILD, JAR, JAVA8, JAVA21, tool, run } from './build.mjs';

build();
const classes = path.join(BUILD, 'test-classes'); compile(files(path.join(ROOT, 'test')), classes, JAR);
const requested = process.env.HWDB_JDBC_TEST_MAJORS?.split(',').map(Number);
const runtimes = [{ home: JAVA8, major: 8 }, { home: JAVA21, major: 21 }].filter(runtime => !requested || requested.includes(runtime.major));
if (!runtimes.length) throw new Error('실행할 자바 시험 환경이 없다.');
const cp = [JAR, classes].join(path.delimiter);
const rdbms = path.resolve(ROOT, '../rdbms');
run(process.execPath, [path.join(rdbms, 'node_modules/typescript/bin/tsc'), '-p', path.join(rdbms, 'tsconfig.json')], { cwd: rdbms });
let count = 0;
async function java(runtime, args, suffix = '') {
  console.log(run(tool(runtime.home, 'java'), ['-version']).trim());
  const output = await child(tool(runtime.home, 'java'), ['-Dfile.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8', '-Duser.timezone=Asia/Seoul', '-Dhwdb.test.suffix=' + suffix,
    '-cp', cp, 'org.duckdns.hjow.helloworlddb.jdbc8.DriverTest', ...args]);
  console.log(output.trim()); count += Number(/PASSED (\d+)/.exec(output)?.[1] || 0);
}
await server({}, async (url, port) => {
  for (const runtime of runtimes) { await java(runtime, ['extensions', url, 'tcp']); await java(runtime, ['extensions', url, 'udp']); }
  await lossy(port, async proxy => { for (const runtime of runtimes) await java(runtime, ['extensions', `jdbc:helloworlddb://127.0.0.1:${proxy}`, 'udp'], 'LOSS'); });
  await legacy(port, async url => { for (const runtime of runtimes) await java(runtime, ['legacy', url, 'tcp']); });
});
await server({ tcp: { ssl: { certPath: tls('server-a.cert.pem'), keyPath: tls('server-a.key.pem') } } },
  async url => { for (const runtime of runtimes) await java(runtime, ['extensions', url, 'tls', tls('server-a.cert.pem')]); });
console.log(`jdbc8 확장 서버 시험 ${count}개 통과, 실패·건너뜀 0.`);

/** helloOk의 capabilities를 제거한 연결에서 클라이언트가 새 요청을 보내지 않는지 확인한다. */
async function legacy(port, body) {
  const sockets = new Set(); const requests = [];
  const proxy = net.createServer(client => {
    const upstream = net.connect(port, '127.0.0.1'); sockets.add(client); sockets.add(upstream);
    for (const [source, destination, outbound] of [[client, upstream, true], [upstream, client, false]]) {
      let buffer = Buffer.alloc(0);
      source.on('data', bytes => {
        buffer = Buffer.concat([buffer, bytes]);
        while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE() + 4) {
          const size = buffer.readUInt32BE(); const message = JSON.parse(buffer.subarray(4, 4 + size).toString('utf8')); buffer = buffer.subarray(4 + size);
          if (outbound) requests.push(message.type); else if (message.type === 'helloOk') delete message.capabilities;
          const data = Buffer.from(JSON.stringify(message)); const header = Buffer.alloc(4); header.writeUInt32BE(data.length); destination.write(Buffer.concat([header, data]));
        }
      });
      source.on('error', () => destination.destroy()); source.on('close', () => { sockets.delete(source); destination.destroy(); });
    }
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  try {
    await body(`jdbc:helloworlddb://127.0.0.1:${proxy.address().port}`);
    if (requests.some(type => ['prepare', 'describe', 'executePrepared', 'closePrepared', 'cancel'].includes(type))) throw new Error('기능 없는 서버에 확장 요청을 보냈다.');
  } finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve)); }
}
