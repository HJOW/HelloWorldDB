/**
 * 로컬 전용 채널.
 *
 * 담당
 *  - 같은 장비의 `hwdb` 명령이 쓰는 접속 경로를 연다.
 *    Windows 는 네임드 파이프, 그 외는 유닉스 도메인 소켓이며 주소는 포트 번호로 정해진다. (common/instance.ts)
 *  - 설정과 무관하게 항상 연다. `tcp`, `udp`, SSL 설정의 영향을 받지 않는다. 열지 못하면 구동에 실패한다.
 *    같은 포트 번호의 다른 인스턴스가 이미 쓰고 있으면 구동에 실패하며, 메시지에 "포트 번호가 인스턴스의 식별자" 임을 알린다.
 *  - 이 채널로 들어온 접속임을 표시하여 넘긴다. 그래야 항상 로컬 접속으로 판정하고,
 *    `maxConnections` 에서 빼고, 데몬 제어 요청을 받을 수 있다.
 *  - 유닉스 소켓의 안전 : 소켓 파일을 만들 때 umask 를 0177 로 두어 만들어지는 순간부터 권한이 0600 이다(접속 사이의 틈이 없다).
 *    구동할 때 경로에 파일이 남아 있으면 연결을 시도해 본다. 연결이 거부되면 비정상 종료로 남은 죽은 소켓이므로 지우고,
 *    연결되면 다른 프로세스가 쓰는 중이므로 구동에 실패한다. 정상 종료 때 소켓 파일을 지운다.
 *  - 프레임(framing.ts)으로 메시지를 잘라 메시지 처리기(messageHandler.ts)에 넘긴다. (streamConnection.ts)
 *
 * 장비 밖으로 나가지 않으므로 암호화하지 않는다. 사용자명과 비밀번호 인증은 다른 경로와 똑같이 거친다.
 * Linux 소켓 권한·비정상 종료·중복 구동은 실제 프로세스 시험으로 검증한다. macOS는 추가 검증 대상이다.
 *
 * 관련 사양 : AGENTS.md 상세 6, 8, 14, 15
 * 구현 단계 : 9단계 (9-5)
 */

import fs from "node:fs";
import net from "node:net";
import { StartupError } from "../common/errors.js";
import { getLocalChannelAddress } from "../common/instance.js";
import { CLOSE_GRACE_MS, serveStream } from "./streamConnection.js";
import type { HandlerEnvironment } from "./messageHandler.js";

/** 경로의 소켓 파일에 연결해 보고 살아 있는지 판정한다. (유닉스 전용) */
export function probeSocketFile(address: string): Promise<"alive" | "stale" | "none"> {
  return new Promise((resolve) => {
    if (!fs.existsSync(address)) {
      resolve("none");
      return;
    }
    const probe = net.connect(address);
    const timer = setTimeout(() => {
      probe.destroy();
      // 응답이 없으면 누군가 쓰는 중으로 본다. 함부로 지우지 않는다.
      resolve("alive");
    }, 1000);
    probe.once("connect", () => {
      clearTimeout(timer);
      probe.destroy();
      resolve("alive");
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // ECONNREFUSED : 소켓 파일은 있는데 듣는 프로세스가 없다. 죽은 소켓이다.
      resolve(error.code === "ECONNREFUSED" || error.code === "ENOTSOCK" ? "stale" : "alive");
    });
  });
}

export class LocalChannelServer {
  readonly address: string;
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private listening = false;
  /** 이 서버가 만든 소켓의 식별자이다. 시작 실패나 주소 재사용 때 다른 서버의 파일을 지우지 않는다. */
  private socketIdentity: { dev: number; ino: number } | null = null;

  constructor(
    private readonly env: HandlerEnvironment,
    readonly port: number,
  ) {
    this.address = getLocalChannelAddress(port);
  }

  /** 채널을 연다. 열지 못하면 StartupError 이다. */
  async start(): Promise<void> {
    if (this.server !== null) throw new StartupError("The local-only channel is already started.");
    if (process.platform !== "win32") {
      const state = await probeSocketFile(this.address);
      if (state === "alive") throw this.inUseError();
      if (state === "stale") {
        this.env.logger.warn(`Removing a stale socket file left by an earlier run: ${this.address}`);
        fs.rmSync(this.address, { force: true });
      }
    }
    const server = net.createServer((socket) => {
      this.sockets.add(socket);
      serveStream(socket, this.env, "local", null, () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        // 같은 이름의 채널이 이미 있을 때의 오류 코드가 런타임마다 다르다. (Node.js 는 EADDRINUSE, bun 은 코드 없이 "Failed to listen")
        // 그래서 열지 못한 모든 경우에 "포트 번호가 인스턴스의 식별자" 임을 함께 알린다.
        reject(this.inUseError(error));
      });
      // 소켓 파일은 listen 안에서 동기로 만들어지므로 그 동안만 umask 를 좁히면 만들어지는 순간부터 0600 이다.
      const previousMask = process.platform === "win32" ? null : process.umask(0o177);
      try {
        server.listen(this.address, () => resolve());
      } catch (error) {
        reject(new StartupError(`Cannot open the local-only channel ${this.address}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
      } finally {
        if (previousMask !== null) process.umask(previousMask);
      }
    });
    server.on("error", (error) => this.env.logger.error(`Local-only channel error: ${error.message}`));
    this.server = server;
    this.listening = true;
    if (process.platform !== "win32") {
      const stat = fs.lstatSync(this.address);
      this.socketIdentity = { dev: stat.dev, ino: stat.ino };
    }
  }

  private inUseError(cause?: unknown): StartupError {
    const reason = cause instanceof Error ? ` (${cause.message})` : "";
    return new StartupError(
      `Cannot open the local-only channel ${this.address}${reason}: it is probably already in use. ` +
        `The port number (${this.port}) identifies the instance, so another instance with the same port number is likely running. ` +
        "Give each instance its own installation directory and port number.",
      cause === undefined ? undefined : { cause },
    );
  }

  /**
   * 새 접속 받기를 멈춘다. 이미 맺어진 접속은 유지한다.
   * `net.Server.close` 의 콜백은 모든 접속이 끝나야 불리므로 기다리지 않는다. 듣기는 호출 즉시 멈춘다.
   */
  async stopAccepting(): Promise<void> {
    const server = this.server;
    if (server === null || !this.listening) return;
    this.listening = false;
    server.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  /** 남은 접속을 닫는다. 유예 시간 안에 비워지지 않으면 강제로 끊는다. 소켓 파일은 지운다. */
  async closeConnections(graceMs: number = CLOSE_GRACE_MS): Promise<void> {
    await this.stopAccepting();
    for (const socket of this.sockets) socket.end();
    const deadline = Date.now() + graceMs;
    while (this.sockets.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const socket of this.sockets) socket.destroy();
    this.server = null;
    const identity = this.socketIdentity;
    this.socketIdentity = null;
    if (identity !== null) {
      try {
        const stat = fs.lstatSync(this.address);
        if (stat.isSocket() && stat.dev === identity.dev && stat.ino === identity.ino) {
          fs.rmSync(this.address, { force: true });
        }
      } catch (error) {
        // Node.js가 close 때 이미 소켓 파일을 지웠으면 추가 정리가 필요 없다.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  /** 지금 이어진 접속 수이다. */
  get connectionCount(): number {
    return this.sockets.size;
  }
}
