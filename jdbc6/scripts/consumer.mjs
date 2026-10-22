// 저장소의 시험 클래스 없이 배포 JAR만 복사한 Java 6 소비자 앱을 실행한다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { child, server, tls } from '../../jdbc8/scripts/test-support.mjs';
import { build } from './build.mjs';
import { ROOT, JAR, run, testRuntimes } from './java-tools.mjs';

const tools = build();
const runtimes = testRuntimes(tools);
for (const major of [6, 7, 8, 21]) if (!runtimes.some(runtime => runtime.major === major)) throw new Error(`Java ${major} 시험 환경이 필요하다.`);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hwdb-jdbc6-consumer-'));
let count = 0;
try {
  const jar = path.join(directory, path.basename(JAR)); fs.copyFileSync(JAR, jar);
  const source = path.join(directory, 'Consumer.java');
  fs.writeFileSync(source, `import java.sql.*;
import java.util.Properties;
import java.math.BigDecimal;
public final class Consumer {
  public static void main(String[] args) throws Exception {
    Properties options = new Properties();
    options.setProperty("user", "SYSTEM"); options.setProperty("password", "HelloWorldDB");
    if (args[1].equals("udp")) options.setProperty("transport", "udp");
    if (args[1].equals("tls")) {
      options.setProperty("ssl", "true"); options.setProperty("sslCa", args[2]);
      // Java 6 에는 TLSv1.2 가 없으므로, 그 런타임의 사용자는 최소 버전을 명시한다. (J-6)
      if ("1.6".equals(System.getProperty("java.specification.version"))) options.setProperty("sslMinVersion", "TLSv1");
    }
    Connection connection = DriverManager.getConnection(args[0], options);
    try {
      PreparedStatement statement = connection.prepareStatement("SELECT CAST(? AS DECIMAL(12,0)) AS N");
      try {
        if (statement.getMetaData().getPrecision(1) != 12 || statement.getParameterMetaData().getPrecision(1) != 12) throw new AssertionError();
        statement.setBigDecimal(1, new BigDecimal("12345678901")); statement.setQueryTimeout(2);
        ResultSet rows = statement.executeQuery();
        try { if (!rows.next() || !new BigDecimal("12345678901").equals(rows.getBigDecimal(1)) || rows.next()) throw new AssertionError(); }
        finally { rows.close(); }
      } finally { statement.close(); }
      if (!connection.isValid(2)) throw new AssertionError();
    } finally { connection.close(); }
    System.out.println("PASSED consumer");
  }
}
`, 'utf8');
  run(tools.javac, ['-encoding', 'UTF-8', '-cp', jar, '-d', directory, source], { cwd: directory });
  const rdbms = path.resolve(ROOT, '../rdbms');
  run(process.execPath, [path.join(rdbms, 'node_modules/typescript/bin/tsc'), '-p', path.join(rdbms, 'tsconfig.json')], { cwd: rdbms });
  async function consumer(runtime, url, mode) {
    const output = await child(runtime.executable, ['-cp', [jar, directory].join(path.delimiter), 'Consumer', url, mode, tls('server-a.cert.pem')], { cwd: directory });
    assert.match(output, /PASSED consumer/); count++; console.log(`Java ${runtime.version} ${mode}: 독립 소비자 통과`);
  }
  await server({}, async url => { for (const runtime of runtimes) { await consumer(runtime, url, 'tcp'); await consumer(runtime, url, 'udp'); } });
  await server({ tcp: { ssl: { certPath: tls('server-a.cert.pem'), keyPath: tls('server-a.key.pem'), minVersion: 'TLSv1' } } },
    async url => { for (const runtime of runtimes) await consumer(runtime, url, 'tls'); });
  console.log(`jdbc6 독립 소비자 ${count}개 통과, 실패·건너뜀 0.`);
} finally {
  const absolute = path.resolve(directory);
  assert.equal(path.dirname(absolute), path.resolve(os.tmpdir())); assert.ok(path.basename(absolute).startsWith('hwdb-jdbc6-consumer-'));
  fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
