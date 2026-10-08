/**
 * config.json 읽기 테스트 (1단계, 상세 7).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../../src/config/config.js";
import { StartupError } from "../../src/common/errors.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hwdb-config-"));
}

function writeConfig(dir: string, value: unknown): void {
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(value), "utf8");
}

test("파일이 없으면 전부 기본값이다", () => {
  const dir = makeTempDir();
  const { config, warnings } = loadConfig(dir);
  assert.equal(warnings.length, 0);
  assert.equal(config.configFilePath, null);
  assert.equal(config.port, 7410);
  assert.equal(config.dataDir, path.resolve(dir, "./data"));
  assert.equal(config.maxConnections, 10);
  assert.equal(config.timeZone, "local");
  assert.equal(config.tcp.enabled, true);
  assert.equal(config.tcp.host, "0.0.0.0");
  assert.equal(config.tcp.ssl.minVersion, "TLSv1.2");
  assert.equal(config.udp.enabled, true);
  assert.equal(config.udp.host, "0.0.0.0");
  assert.equal(config.udp.maxPacketSize, 1200);
  assert.equal(config.udp.sessionTimeoutMs, 60000);
  assert.equal(config.transaction.lockTimeoutMs, 30000);
  assert.equal(config.session.idleTimeoutMs, 0);
  assert.equal(config.log.level, "info");
  assert.equal(config.log.dir, path.resolve(dir, "./logs"));
});

test("필요한 키만 적으면 나머지는 기본값이다", () => {
  const dir = makeTempDir();
  writeConfig(dir, { port: 7420, log: { level: "debug" } });
  const { config } = loadConfig(dir);
  assert.equal(config.port, 7420);
  assert.equal(config.log.level, "debug");
  assert.equal(config.dataDir, path.resolve(dir, "./data"));
  assert.notEqual(config.configFilePath, null);
});

test("모르는 키는 경고를 남기고 무시한다", () => {
  const dir = makeTempDir();
  writeConfig(dir, { port: 7410, unknownKey: 1, tcp: { unknownInner: true } });
  const { config, warnings } = loadConfig(dir);
  assert.equal(config.port, 7410);
  assert.ok(warnings.some((message) => message.includes("unknownKey")));
  assert.ok(warnings.some((message) => message.includes("tcp.unknownInner")));
});

test("상대 경로는 config.json 기준 디렉토리로 푼다", () => {
  const dir = makeTempDir();
  writeConfig(dir, {
    dataDir: "./mydata",
    log: { dir: "./mylogs" },
    tcp: { ssl: { certPath: "./cert.pem", keyPath: "./key.pem" } },
  });
  const { config } = loadConfig(dir);
  assert.equal(config.dataDir, path.resolve(dir, "./mydata"));
  assert.equal(config.log.dir, path.resolve(dir, "./mylogs"));
  assert.equal(config.tcp.ssl.certPath, path.resolve(dir, "./cert.pem"));
  assert.equal(config.tcp.ssl.keyPath, path.resolve(dir, "./key.pem"));
});

test("tcp와 udp를 둘 다 끄는 것은 허용된다", () => {
  const dir = makeTempDir();
  writeConfig(dir, { tcp: { enabled: false }, udp: { enabled: false } });
  const { config } = loadConfig(dir);
  assert.equal(config.tcp.enabled, false);
  assert.equal(config.udp.enabled, false);
});

test("값이 올바르지 않으면 구동에 실패한다", () => {
  const badCases: unknown[] = [
    { port: 0 },
    { port: 70000 },
    { maxConnections: 0 },
    { tcp: { enabled: "yes" } },
    { tcp: { ssl: { certPath: "./a.pem" } } },
    { tcp: { ssl: { minVersion: "TLSv9" } } },
    { udp: { maxPacketSize: 0 } },
    { log: { level: "verbose" } },
    { log: { dir: "" } },
  ];
  for (const bad of badCases) {
    const dir = makeTempDir();
    writeConfig(dir, bad);
    assert.throws(() => loadConfig(dir), StartupError, JSON.stringify(bad));
  }
});

test("JSON이 아니면 구동에 실패한다", () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "config.json"), "{ not json", "utf8");
  assert.throws(() => loadConfig(dir), StartupError);
});
