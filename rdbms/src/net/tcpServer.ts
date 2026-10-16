/**
 * TCP 접속 경로.
 *
 * 담당
 *  - 설정의 `port` 와 `tcp.host` 로 TCP 접속을 받는다. `tcp.enabled` 가 false 면 열지 않는다(서버 조립이 판단한다).
 *    열지 못하면(포트 사용 중 등) 구동에 실패한다. 기본 바인드 `0.0.0.0` 은 IPv4 만 받는다. IPv6 는 `tcp.host` 를 `::` 로 둔다.
 *  - SSL : `tcp.ssl` 의 인증서와 개인키가 설정되어 있으면 포트 전체를 TLS 로 운영한다.
 *    이 때 평문 접속은 받지 않는다. (TLS 핸드셰이크가 아닌 바이트는 연결 단계에서 끊긴다)
 *    인증서와 키는 구동할 때 한 번 읽는다. 읽기 실패와 형식 오류는 구동 실패이다. 암호가 걸린 키는 지원하지 않는다.
 *    인증서 갱신은 재시작해야 반영된다. (config.json 과 같은 규칙)
 *  - TLS 최소 버전 : `tcp.ssl.minVersion` (기본 TLSv1.2). 최대 버전은 제한하지 않는다.
 *    TLSv1.2 보다 낮추면(자바 5, 6 클라이언트 지원) 그 버전에서 쓰는 암호 스위트도 함께 허용하고 구동 로그에 경고를 남긴다.
 *    최신 Node.js 의 OpenSSL 3 은 보안 수준 1 에서 TLS 1.0, 1.1 을 끄므로 이때만 `ciphers` 에 `@SECLEVEL=0` 을 붙인다.
 *  - bun 의 한계(2026-10-16 bun 1.3.14 에서 확인. Node.js 24.22.0 에서는 모두 적용된다) : bun 의 TLS 서버는 `minVersion` 옵션을 적용하지 않고
 *    BoringSSL 의 기본값(TLS 1.2 이상)을 쓴다. `secureContext` 로 주면 인증서가 실리지 않아 핸드셰이크가 모두 실패하므로 쓸 수 없다.
 *    그래서 bun 에서는 기본 설정(`TLSv1.2`)만 그대로 지켜지고, `TLSv1.3` 은 1.2 클라이언트도 받으며, `TLSv1`·`TLSv1.1`(구버전 허용)은 켤 수 없다.
 *    (`@SECLEVEL` 암호 표기도 받지 않는다) 이 경우 구동 로그에 경고를 남긴다. 구버전 TLS 가 필요하면 Node.js 로 구동한다.
 *  - 프레임(framing.ts)으로 메시지를 잘라 메시지 처리기(messageHandler.ts)에 넘긴다. (streamConnection.ts)
 *  - 연결이 끊기면 세션을 끝낸다.
 *  - TLS 핸드셰이크를 끝내지 않는 접속이 자원을 붙잡지 않도록 핸드셰이크 제한 시간을 인증 시간 제한(10초)과 같게 둔다.
 *
 * node:net, node:tls 만 쓴다.
 *
 * 관련 사양 : AGENTS.md 상세 7, 8, 15
 * 구현 단계 : 9단계 (9-6)
 */

import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { normalizeRemoteAddress } from "../common/address.js";
import { StartupError } from "../common/errors.js";
import type { TlsMinVersion } from "../config/config.js";
import { CLOSE_GRACE_MS, serveStream } from "./streamConnection.js";
import type { HandlerEnvironment } from "./messageHandler.js";
import { AUTH_TIMEOUT_MS } from "./protocol.js";

export interface TcpServerOptions {
  host: string;
  port: number;
  /** 둘 다 있으면 TLS 로 운영한다. (config.ts 가 하나만 있는 경우를 구동 실패로 막는다) */
  ssl?: { certPath: string | undefined; keyPath: string | undefined; minVersion: TlsMinVersion };
}

/** TLS 최소 버전이 TLSv1.2 보다 낮아 구버전 TLS 를 허용하는 설정인지 본다. */
export function isLegacyTlsVersion(minVersion: TlsMinVersion): boolean {
  return minVersion === "TLSv1" || minVersion === "TLSv1.1";
}

/** 구버전 TLS 를 허용할 때 쓰는 암호 스위트 지정이다. OpenSSL 3 의 보안 수준을 0 으로 낮춘다. */
export const LEGACY_TLS_CIPHERS = "DEFAULT:@SECLEVEL=0";

/** bun 에서 실행 중인지 본다. TLS 최소 버전의 적용 범위가 런타임마다 달라서 구별한다. */
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export class TcpServer {
  private server: net.Server | tls.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private listening = false;
  private tlsOn = false;

  constructor(
    private readonly env: HandlerEnvironment,
    private readonly options: TcpServerOptions,
  ) {}

  /** TLS 로 운영 중인지 본다. */
  get tlsEnabled(): boolean {
    return this.tlsOn;
  }

  /** 실제로 바인드한 포트이다. 구동 전에는 null 이다. (포트 0 으로 연 시험에서 쓴다) */
  get boundPort(): number | null {
    const address = this.server?.address();
    return typeof address === "object" && address !== null ? address.port : null;
  }

  /** 시험에서만 쓴다. Node.js 의 서버 객체이다. (예 : TLS 서버의 인증서를 중간에 바꾸는 시험) */
  get nodeServer(): net.Server | tls.Server | null {
    return this.server;
  }

  /** 지금 이어진 접속 수이다. */
  get connectionCount(): number {
    return this.sockets.size;
  }

  /**
   * TLS 서버 옵션을 만든다. 최소 버전이 TLSv1.2 보다 낮으면 그 버전의 암호 스위트도 함께 허용하고 경고를 남긴다.
   * 인증서나 키가 잘못되었으면 예외를 던진다. (보안 문맥을 먼저 만들어 보며 확인한다)
   */
  private tlsOptions(cert: Buffer, key: Buffer, minVersion: TlsMinVersion): tls.TlsOptions {
    let ciphers: string | undefined;
    if (!isLegacyTlsVersion(minVersion)) {
      tls.createSecureContext({ cert, key, minVersion });
    } else {
      this.env.logger.warn(
        `The TLS minimum version is ${minVersion}, which is insecure; it is meant for old Java 5/6 clients. Raise tcp.ssl.minVersion when they are no longer needed.`,
      );
      try {
        tls.createSecureContext({ cert, key, minVersion, ciphers: LEGACY_TLS_CIPHERS });
        ciphers = LEGACY_TLS_CIPHERS;
      } catch (error) {
        // 인증서 문제가 아니라 암호 표기 문제인지 구별하기 위해 암호 스위트 없이 다시 만들어 본다. (이것도 실패하면 인증서 문제이다)
        tls.createSecureContext({ cert, key, minVersion });
        this.env.logger.warn(
          `This runtime does not accept the cipher setting "${LEGACY_TLS_CIPHERS}" (${error instanceof Error ? error.message : String(error)}); only the minimum version was lowered, so TLS 1.0/1.1 clients may still be refused.`,
        );
      }
    }
    if (isBun && minVersion === "TLSv1.3") {
      this.env.logger.warn(
        "tcp.ssl.minVersion is TLSv1.3, but bun cannot enforce a minimum version above its default (TLS 1.2): TLS 1.2 clients will still be accepted. Run the daemon with Node.js to enforce it.",
      );
    } else if (isBun && isLegacyTlsVersion(minVersion)) {
      this.env.logger.warn(
        `tcp.ssl.minVersion is ${minVersion}, but bun cannot enable TLS 1.0/1.1: those clients will be refused. Run the daemon with Node.js to accept them.`,
      );
    }
    return { cert, key, minVersion, ...(ciphers === undefined ? {} : { ciphers }), handshakeTimeout: AUTH_TIMEOUT_MS };
  }

  /** 포트를 연다. 열지 못하면 StartupError 이다. */
  async start(): Promise<void> {
    if (this.server !== null) throw new StartupError("The TCP server is already started.");
    const ssl = this.options.ssl;
    const handle = (socket: net.Socket): void => {
      this.sockets.add(socket);
      serveStream(socket, this.env, "tcp", normalizeRemoteAddress(socket.remoteAddress), () => this.sockets.delete(socket));
    };
    let server: net.Server | tls.Server;
    if (ssl !== undefined && ssl.certPath !== undefined && ssl.keyPath !== undefined) {
      let cert: Buffer;
      let key: Buffer;
      try {
        cert = fs.readFileSync(ssl.certPath);
        key = fs.readFileSync(ssl.keyPath);
      } catch (error) {
        throw new StartupError(`Cannot read the SSL certificate or key (${ssl.certPath}, ${ssl.keyPath}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      let tlsOptions: tls.TlsOptions;
      try {
        tlsOptions = this.tlsOptions(cert, key, ssl.minVersion);
      } catch (error) {
        throw new StartupError(`The SSL certificate or key is not usable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      try {
        server = tls.createServer(tlsOptions, handle);
      } catch (error) {
        throw new StartupError(`The TLS server could not be created: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      (server as tls.Server).on("tlsClientError", (error: Error) => {
        // 평문 접속이나 인증서 검증에 실패한 클라이언트이다.
        this.env.logger.debug(`TLS handshake failed: ${error.message}`);
      });
      this.tlsOn = true;
    } else {
      server = net.createServer(handle);
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        reject(
          new StartupError(
            error.code === "EADDRINUSE"
              ? `Cannot open the TCP port ${this.options.host}:${this.options.port}: it is already in use.`
              : `Cannot open the TCP port ${this.options.host}:${this.options.port}: ${error.message}`,
            { cause: error },
          ),
        );
      });
      server.listen({ host: this.options.host, port: this.options.port }, () => resolve());
    });
    server.on("error", (error) => this.env.logger.error(`TCP server error: ${error.message}`));
    this.server = server;
    this.listening = true;
  }

  /** 새 접속 받기를 멈춘다. 이미 맺어진 접속은 유지한다. (콜백은 모든 접속이 끝나야 불리므로 기다리지 않는다) */
  async stopAccepting(): Promise<void> {
    const server = this.server;
    if (server === null || !this.listening) return;
    this.listening = false;
    server.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  /** 남은 접속을 닫는다. 유예 시간 안에 비워지지 않으면 강제로 끊는다. */
  async closeConnections(graceMs: number = CLOSE_GRACE_MS): Promise<void> {
    await this.stopAccepting();
    for (const socket of this.sockets) socket.end();
    const deadline = Date.now() + graceMs;
    while (this.sockets.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const socket of this.sockets) socket.destroy();
    this.server = null;
  }
}
