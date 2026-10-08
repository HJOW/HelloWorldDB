/**
 * 설정 파일 (config.json).
 *
 * 담당
 *  - 설정 항목의 타입과 기본값. AGENTS.md 상세 7 의 표가 기준이다.
 *  - config.json 읽기. 위치는 설치 디렉토리(패키지 루트)이며, 파일이 없으면 전부 기본값을 쓴다.
 *  - 적지 않은 키는 기본값으로 채운다.
 *  - 값 검증. 올바르지 않으면 구동에 실패시킨다.
 *    (예 : `tcp.ssl` 의 인증서와 개인키 경로 중 하나만 있는 경우)
 *  - 모르는 키는 경고만 남기고 무시한다.
 *  - 상대 경로는 config.json 이 있는 디렉토리를 기준으로 푼다.
 *
 * 데몬과 CLI 가 함께 쓴다. 구동할 때 한 번만 읽으며, 실행 중에 다시 읽지 않는다.
 *
 * 관련 사양 : AGENTS.md 상세 7
 * 구현 단계 : 1단계
 */

import fs from "node:fs";
import path from "node:path";
import { StartupError } from "../common/errors.js";
import { DEFAULT_PORT } from "../common/instance.js";

/** 허용할 TLS 최소 버전. */
export type TlsMinVersion = "TLSv1" | "TLSv1.1" | "TLSv1.2" | "TLSv1.3";

/** 로그 레벨. */
export type LogLevel = "error" | "warn" | "info" | "debug";

const TLS_MIN_VERSIONS: readonly TlsMinVersion[] = ["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"];
const LOG_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug"];

/** TCP 의 SSL 설정. 경로가 둘 다 있으면 TLS 로 운영하고, 하나만 있으면 구동에 실패한다. */
export interface TcpSslConfig {
  certPath?: string;
  keyPath?: string;
  minVersion: TlsMinVersion;
}

export interface TcpConfig {
  enabled: boolean;
  host: string;
  ssl: TcpSslConfig;
}

export interface UdpConfig {
  enabled: boolean;
  host: string;
  maxPacketSize: number;
  sessionTimeoutMs: number;
}

export interface TransactionConfig {
  lockTimeoutMs: number;
}

export interface SessionConfig {
  idleTimeoutMs: number;
}

export interface LogConfig {
  level: LogLevel;
  dir: string;
}

/**
 * 구동에 쓰는 설정. 상대 경로(config.json 기준)는 절대 경로로 풀려 있다.
 * installDir 은 config.json 이 있는 디렉토리이며, configFilePath 는 파일이 없을 때 null 이다.
 */
export interface ResolvedConfig {
  installDir: string;
  configFilePath: string | null;
  port: number;
  dataDir: string;
  maxConnections: number;
  timeZone: string;
  tcp: TcpConfig;
  udp: UdpConfig;
  transaction: TransactionConfig;
  session: SessionConfig;
  log: LogConfig;
}

export interface LoadedConfig {
  config: ResolvedConfig;
  /** 모르는 키에 대한 경고. 호출자가 로그로 남긴다. 메시지는 영문이다. */
  warnings: string[];
}

/** config.json 파일의 이름. */
export const CONFIG_FILE_NAME = "config.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string, options?: { cause?: unknown }): never {
  throw new StartupError(message, options);
}

/** 상대 경로를 config.json 기준 디렉토리로 푼다. 절대 경로와 빈 값은 그대로 둔다. */
function resolveConfigPath(baseDir: string, value: string): string {
  if (value === "" || path.isAbsolute(value)) {
    return value;
  }
  return path.resolve(baseDir, value);
}

/**
 * 설치 디렉토리의 config.json 을 읽는다.
 * 파일이 없으면 전부 기본값으로 돌려준다.
 * 값이 올바르지 않으면 StartupError 를 던진다.
 */
export function loadConfig(installDir: string): LoadedConfig {
  const baseDir = path.resolve(installDir);
  const configFilePath = path.join(baseDir, CONFIG_FILE_NAME);
  const warnings: string[] = [];

  let raw: unknown = {};
  let found = false;
  try {
    const rawText = fs.readFileSync(configFilePath, "utf8");
    // Windows 메모장 등이 붙이는 BOM 이 있으면 떼고 해석한다.
    const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
    found = true;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (error) {
      fail(`Invalid config file (not JSON): ${configFilePath}`, { cause: error });
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      raw = {};
    } else if (error instanceof StartupError) {
      throw error;
    } else {
      fail(`Cannot read config file: ${configFilePath}`, { cause: error });
    }
  }

  if (!isRecord(raw)) {
    fail(`Invalid config file (object expected): ${configFilePath}`);
  }
  const root = raw as Record<string, unknown>;

  // 기본값. AGENTS.md 상세 7 의 표와 같다.
  let port = DEFAULT_PORT;
  let dataDir = path.resolve(baseDir, "./data");
  let maxConnections = 10;
  let timeZone = "local";
  let tcpEnabled = true;
  let tcpHost = "0.0.0.0";
  let tcpCertPath: string | undefined;
  let tcpKeyPath: string | undefined;
  let tcpMinVersion: TlsMinVersion = "TLSv1.2";
  let udpEnabled = true;
  let udpHost = "0.0.0.0";
  let udpMaxPacketSize = 1200;
  let udpSessionTimeoutMs = 60000;
  let lockTimeoutMs = 30000;
  let idleTimeoutMs = 0;
  let logLevel: LogLevel = "info";
  let logDir = path.resolve(baseDir, "./logs");

  const knownRootKeys = new Set([
    "port",
    "dataDir",
    "maxConnections",
    "timeZone",
    "tcp",
    "udp",
    "transaction",
    "session",
    "log",
  ]);

  for (const key of Object.keys(root)) {
    if (!knownRootKeys.has(key)) {
      warnings.push(`Unknown config key "${key}"; ignored.`);
    }
  }

  if (root["port"] !== undefined) {
    const value = root["port"];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
      fail(`Invalid config value: "port" must be an integer between 1 and 65535.`);
    }
    port = value;
  }

  if (root["dataDir"] !== undefined) {
    const value = root["dataDir"];
    if (typeof value !== "string" || value.length === 0) {
      fail(`Invalid config value: "dataDir" must be a non-empty string.`);
    }
    dataDir = resolveConfigPath(baseDir, value);
  }

  if (root["maxConnections"] !== undefined) {
    const value = root["maxConnections"];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      fail(`Invalid config value: "maxConnections" must be an integer >= 1.`);
    }
    maxConnections = value;
  }

  if (root["timeZone"] !== undefined) {
    const value = root["timeZone"];
    if (typeof value !== "string" || value.length === 0) {
      fail(`Invalid config value: "timeZone" must be a non-empty string.`);
    }
    timeZone = value;
  }

  if (root["tcp"] !== undefined) {
    const value = root["tcp"];
    if (!isRecord(value)) {
      fail(`Invalid config value: "tcp" must be an object.`);
    }
    const knownKeys = new Set(["enabled", "host", "ssl"]);
    for (const key of Object.keys(value)) {
      if (!knownKeys.has(key)) {
        warnings.push(`Unknown config key "tcp.${key}"; ignored.`);
      }
    }
    if (value["enabled"] !== undefined) {
      if (typeof value["enabled"] !== "boolean") {
        fail(`Invalid config value: "tcp.enabled" must be a boolean.`);
      }
      tcpEnabled = value["enabled"];
    }
    if (value["host"] !== undefined) {
      if (typeof value["host"] !== "string" || value["host"].length === 0) {
        fail(`Invalid config value: "tcp.host" must be a non-empty string.`);
      }
      tcpHost = value["host"];
    }
    if (value["ssl"] !== undefined) {
      const ssl = value["ssl"];
      if (!isRecord(ssl)) {
        fail(`Invalid config value: "tcp.ssl" must be an object.`);
      }
      const knownSslKeys = new Set(["certPath", "keyPath", "minVersion"]);
      for (const key of Object.keys(ssl)) {
        if (!knownSslKeys.has(key)) {
          warnings.push(`Unknown config key "tcp.ssl.${key}"; ignored.`);
        }
      }
      if (ssl["certPath"] !== undefined) {
        if (typeof ssl["certPath"] !== "string" || ssl["certPath"].length === 0) {
          fail(`Invalid config value: "tcp.ssl.certPath" must be a non-empty string.`);
        }
        tcpCertPath = resolveConfigPath(baseDir, ssl["certPath"]);
      }
      if (ssl["keyPath"] !== undefined) {
        if (typeof ssl["keyPath"] !== "string" || ssl["keyPath"].length === 0) {
          fail(`Invalid config value: "tcp.ssl.keyPath" must be a non-empty string.`);
        }
        tcpKeyPath = resolveConfigPath(baseDir, ssl["keyPath"]);
      }
      if (ssl["minVersion"] !== undefined) {
        if (typeof ssl["minVersion"] !== "string" || !isTlsMinVersion(ssl["minVersion"])) {
          fail(`Invalid config value: "tcp.ssl.minVersion" must be one of "TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3".`);
        }
        tcpMinVersion = ssl["minVersion"];
      }
    }
  }

  if (root["udp"] !== undefined) {
    const value = root["udp"];
    if (!isRecord(value)) {
      fail(`Invalid config value: "udp" must be an object.`);
    }
    const knownKeys = new Set(["enabled", "host", "maxPacketSize", "sessionTimeoutMs"]);
    for (const key of Object.keys(value)) {
      if (!knownKeys.has(key)) {
        warnings.push(`Unknown config key "udp.${key}"; ignored.`);
      }
    }
    if (value["enabled"] !== undefined) {
      if (typeof value["enabled"] !== "boolean") {
        fail(`Invalid config value: "udp.enabled" must be a boolean.`);
      }
      udpEnabled = value["enabled"];
    }
    if (value["host"] !== undefined) {
      if (typeof value["host"] !== "string" || value["host"].length === 0) {
        fail(`Invalid config value: "udp.host" must be a non-empty string.`);
      }
      udpHost = value["host"];
    }
    if (value["maxPacketSize"] !== undefined) {
      const packetSize = value["maxPacketSize"];
      if (typeof packetSize !== "number" || !Number.isInteger(packetSize) || packetSize < 1) {
        fail(`Invalid config value: "udp.maxPacketSize" must be an integer >= 1.`);
      }
      udpMaxPacketSize = packetSize;
    }
    if (value["sessionTimeoutMs"] !== undefined) {
      const timeout = value["sessionTimeoutMs"];
      if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 0) {
        fail(`Invalid config value: "udp.sessionTimeoutMs" must be an integer >= 0.`);
      }
      udpSessionTimeoutMs = timeout;
    }
  }

  if (root["transaction"] !== undefined) {
    const value = root["transaction"];
    if (!isRecord(value)) {
      fail(`Invalid config value: "transaction" must be an object.`);
    }
    for (const key of Object.keys(value)) {
      if (key !== "lockTimeoutMs") {
        warnings.push(`Unknown config key "transaction.${key}"; ignored.`);
      }
    }
    if (value["lockTimeoutMs"] !== undefined) {
      const timeout = value["lockTimeoutMs"];
      if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 0) {
        fail(`Invalid config value: "transaction.lockTimeoutMs" must be an integer >= 0.`);
      }
      lockTimeoutMs = timeout;
    }
  }

  if (root["session"] !== undefined) {
    const value = root["session"];
    if (!isRecord(value)) {
      fail(`Invalid config value: "session" must be an object.`);
    }
    for (const key of Object.keys(value)) {
      if (key !== "idleTimeoutMs") {
        warnings.push(`Unknown config key "session.${key}"; ignored.`);
      }
    }
    if (value["idleTimeoutMs"] !== undefined) {
      const timeout = value["idleTimeoutMs"];
      if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 0) {
        fail(`Invalid config value: "session.idleTimeoutMs" must be an integer >= 0.`);
      }
      idleTimeoutMs = timeout;
    }
  }

  if (root["log"] !== undefined) {
    const value = root["log"];
    if (!isRecord(value)) {
      fail(`Invalid config value: "log" must be an object.`);
    }
    for (const key of Object.keys(value)) {
      if (key !== "level" && key !== "dir") {
        warnings.push(`Unknown config key "log.${key}"; ignored.`);
      }
    }
    if (value["level"] !== undefined) {
      if (typeof value["level"] !== "string" || !isLogLevel(value["level"])) {
        fail(`Invalid config value: "log.level" must be one of "error", "warn", "info", "debug".`);
      }
      logLevel = value["level"];
    }
    if (value["dir"] !== undefined) {
      if (typeof value["dir"] !== "string" || value["dir"].length === 0) {
        fail(`Invalid config value: "log.dir" must be a non-empty string.`);
      }
      logDir = resolveConfigPath(baseDir, value["dir"]);
    }
  }

  const hasCert = tcpCertPath !== undefined;
  const hasKey = tcpKeyPath !== undefined;
  if (hasCert !== hasKey) {
    fail(`Invalid config value: "tcp.ssl.certPath" and "tcp.ssl.keyPath" must be set together.`);
  }

  const config: ResolvedConfig = {
    installDir: baseDir,
    configFilePath: found ? configFilePath : null,
    port,
    dataDir,
    maxConnections,
    timeZone,
    tcp: {
      enabled: tcpEnabled,
      host: tcpHost,
      ssl: {
        minVersion: tcpMinVersion,
        ...(hasCert === true && tcpCertPath !== undefined ? { certPath: tcpCertPath } : {}),
        ...(hasKey === true && tcpKeyPath !== undefined ? { keyPath: tcpKeyPath } : {}),
      },
    },
    udp: {
      enabled: udpEnabled,
      host: udpHost,
      maxPacketSize: udpMaxPacketSize,
      sessionTimeoutMs: udpSessionTimeoutMs,
    },
    transaction: {
      lockTimeoutMs,
    },
    session: {
      idleTimeoutMs,
    },
    log: {
      level: logLevel,
      dir: logDir,
    },
  };
  return { config, warnings };
}

function isTlsMinVersion(value: string): value is TlsMinVersion {
  return (TLS_MIN_VERSIONS as readonly string[]).includes(value);
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
