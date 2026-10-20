// JAR만 복사한 별도 Java 8 앱에서 서비스 등록·메타데이터·JDBC 4.2 바인딩을 확인한다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { child, server, tls } from './test-support.mjs';
import { build, ROOT, JAR, JAVA8, JAVA21, tool, run } from './build.mjs';

build();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hwdb-jdbc8-consumer-'));
let count = 0;
try {
  const jar = path.join(directory, path.basename(JAR)); fs.copyFileSync(JAR, jar);
  const source = path.join(directory, 'Consumer.java');
  fs.writeFileSync(source, `import java.sql.*;
import java.util.Properties;
import java.math.BigDecimal;
import java.time.OffsetDateTime;
public final class Consumer {
  public static void main(String[] args) throws Exception {
    Properties options = new Properties(); options.setProperty("user", "SYSTEM"); options.setProperty("password", "HelloWorldDB");
    if (args[1].equals("udp")) options.setProperty("transport", "udp");
    if (args[1].equals("tls")) { options.setProperty("ssl", "true"); options.setProperty("sslCa", args[2]); }
    try (Connection connection = DriverManager.getConnection(args[0], options)) {
      if (connection.getMetaData().getJDBCMinorVersion() != 2) throw new AssertionError();
      try (ResultSet tables = connection.getMetaData().getTables(null, "SYSTEM", "%", null)) { if (!tables.next()) throw new AssertionError(); }
      try (ResultSet columns = connection.getMetaData().getColumns(null, "SYSTEM", "DUAL", "%")) { if (!columns.next()) throw new AssertionError(); }
      try (PreparedStatement statement = connection.prepareStatement("SELECT CAST(? AS DECIMAL(12,0)) AS N")) {
        if (statement.getMetaData().getPrecision(1) != 12 || statement.getParameterMetaData().getPrecision(1) != 12) throw new AssertionError();
        statement.setObject(1, new BigDecimal("12345678901"), JDBCType.DECIMAL); statement.setQueryTimeout(2);
        try (ResultSet rows = statement.executeQuery()) { if (!rows.next() || !new BigDecimal("12345678901").equals(rows.getBigDecimal(1)) || rows.next()) throw new AssertionError(); }
      }
      try (PreparedStatement statement = connection.prepareStatement("SELECT ?")) {
        OffsetDateTime time = OffsetDateTime.parse("2026-10-20T12:34:56.123456+09:00");
        statement.setObject(1, time, JDBCType.TIMESTAMP_WITH_TIMEZONE);
        if (statement.getMetaData().getColumnType(1) != Types.TIMESTAMP_WITH_TIMEZONE) throw new AssertionError();
        try (ResultSet rows = statement.executeQuery()) { if (!rows.next() || !time.equals(rows.getObject(1, OffsetDateTime.class))) throw new AssertionError(); }
      }
      if (!connection.isValid(2)) throw new AssertionError();
    }
    System.out.println("PASSED consumer");
  }
}
`, 'utf8');
  run(tool(JAVA8, 'javac'), ['-encoding', 'UTF-8', '-source', '1.8', '-target', '1.8', '-cp', jar, '-d', directory, source], { cwd: directory });
  const rdbms = path.resolve(ROOT, '../rdbms');
  run(process.execPath, [path.join(rdbms, 'node_modules/typescript/bin/tsc'), '-p', path.join(rdbms, 'tsconfig.json')], { cwd: rdbms });
  async function consumer(home, url, mode) {
    const output = await child(tool(home, 'java'), ['-cp', [jar, directory].join(path.delimiter), 'Consumer', url, mode, tls('server-a.cert.pem')], { cwd: directory });
    assert.match(output, /PASSED consumer/); count++; console.log(`${home} ${mode}: 독립 소비자 통과`);
  }
  await server({}, async url => { for (const home of [JAVA8, JAVA21]) { await consumer(home, url, 'tcp'); await consumer(home, url, 'udp'); } });
  await server({ tcp: { ssl: { certPath: tls('server-a.cert.pem'), keyPath: tls('server-a.key.pem') } } },
    async url => { for (const home of [JAVA8, JAVA21]) await consumer(home, url, 'tls'); });
  console.log(`jdbc8 독립 소비자 ${count}개 통과, 실패·건너뜀 0.`);
} finally {
  const absolute = path.resolve(directory);
  assert.equal(path.dirname(absolute), path.resolve(os.tmpdir())); assert.ok(path.basename(absolute).startsWith('hwdb-jdbc8-consumer-'));
  fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
