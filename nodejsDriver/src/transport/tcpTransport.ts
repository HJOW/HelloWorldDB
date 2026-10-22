/**
 * 전송 계층의 공통 인터페이스와 TCP(TLS 포함) 전송.
 *
 * 담당
 *  - `MessageTransport` : 접속 경로와 무관하게 `Connection` 이 아는 것은 이 인터페이스뿐이다. (TCP, UDP)
 *  - TCP, TLS : 프레임(protocol/framing.ts)으로 메시지를 주고받는다. TLS 는 서버 인증서를 기본으로 검증한다.
 *    인증서 오류로 연결에 실패하면 연결을 닫고 `certRetryDelayMs`(기본 100 ms) 뒤에 새 연결로 다시 시도하며,
 *    재시도는 `certRetries`(기본 2)번까지이다. 재시도에서도 검증은 그대로 한다. 인증서 오류가 아닌 실패에는 적용하지 않는다.
 *    모든 시도가 실패하면 08001(내부 번호 8007)이고 메시지에 시도 횟수와 원인 코드를 싣는다.
 *
 * 드라이버는 TCP 와 UDP 로만 접속한다. 로컬 전용 채널은 CLI 의 몫이다. (AGENTS.md 상세 8, 15)
 *
 * 관련 사양 : AGENTS.md 상세 8 / rdbms/docs/protocol.md 2-1, 2-2절
 * 구현 단계 : 12-2
 */

import net from "node:net";
import tls from "node:tls";
import { DbError, ERROR_CODES, connectionFailure } from "../errors.js";
import { FrameDecoder, FrameError, encodeFrame } from "../protocol/framing.js";
import { MAX_MESSAGE_BYTES, PRE_AUTH_MAX_MESSAGE_BYTES } from "../protocol/messages.js";

/** 메시지 하나씩 주고받는 전송 계층이다. */
export interface MessageTransport {
  /** 메시지 본문 하나를 보낸다. */
  send(body: Buffer): void;
  /** 보낸 것을 내보낸 뒤 접속을 닫는다. */
  close(): void;
  /** 받은 메시지와 닫힘의 알림을 받을 함수를 정한다. 연결 직후 한 번 부른다. */
  setHandlers(handlers: TransportHandlers): void;
  /** `helloOk` 를 받은 직후에 부른다. UDP 전송이 서버의 패킷 크기에 맞추는 데 쓴다. */
  onHello?(info: { udp?: { sessionTimeoutMs: number; maxPacketSize: number } }): void;
  /** 로그인을 마친 뒤에 부른다. 이때부터 메시지 크기 한도가 인증 후 값(16 MiB)으로 바뀐다. */
  onAuthenticated?(): void;
}

export interface TransportHandlers {
  onMessage(body: Buffer): void;
  /** 접속이 끝났다. 오류 때문이면 그 오류가 있다. 한 번만 불린다. */
  onClose(error: Error | null): void;
}

/** TLS 옵션이다. 서버 인증서는 기본으로 검증한다. */
export interface SslOptions {
  /** 신뢰할 CA(PEM)이다. 생략하면 Node.js 기본 CA 이다. 자체 서명 인증서를 쓰는 서버는 그 인증서를 지정한다. */
  ca?: string | Buffer | Array<string | Buffer>;
  /** 서버 인증서 검증 여부이다. 기본 true. false 는 검증을 끄는 것(위험)이며 명시했을 때만 쓴다. */
  rejectUnauthorized?: boolean;
  /** 인증서의 호스트 이름을 확인할 대상이다. 기본은 접속 호스트이다. */
  servername?: string;
  /** 인증서 오류 때의 재시도 횟수이다. 기본 2. 0 이면 재시도하지 않는다. */
  certRetries?: number;
  /** 재시도 전의 대기(ms)이다. 기본 100. */
  certRetryDelayMs?: number;
  /** 재시도하기 직전에 부른다. `attempt` 는 지금 하려는 재시도의 번호(1부터), `maxAttempts` 는 재시도의 최대 횟수이다. */
  onCertRetry?(info: { attempt: number; maxAttempts: number; error: Error }): void;
  /** 쓸 TLS 의 가장 낮은 버전이다. */
  minVersion?: "TLSv1" | "TLSv1.1" | "TLSv1.2" | "TLSv1.3";
  /** 쓸 TLS 의 가장 높은 버전이다. */
  maxVersion?: "TLSv1" | "TLSv1.1" | "TLSv1.2" | "TLSv1.3";
  /** OpenSSL 암호 스위트 지정이다. (구버전 TLS 시험에서 `DEFAULT:@SECLEVEL=0`) */
  ciphers?: string;
}

/** 시험에서만 바꾸는 내부 옵션이다. 공개 API 가 아니다. */
export interface InternalTransportOptions {
  /** 인증서 재시도 대기에 쓰는 함수이다. */
  sleep?: (ms: number) => Promise<void>;
}

/** TLS 서버 인증서 검증에 실패한 오류의 코드 집합이다. (재시도 대상) */
const CERTIFICATE_ERROR_CODES: ReadonlySet<string> = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
  "CERT_REVOKED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * 인증서 검증 오류인지 본다. 재시도는 이 오류에만 한다. 연결 거부, 시간 초과, 연결 끊김, TLS 버전 불일치는 해당하지 않는다.
 * 호스트 이름 불일치(`ERR_TLS_CERT_ALTNAME_INVALID`)는 서버가 인증서를 실제로 보냈을 때만 인증서 오류로 본다.
 * bun 은 TLS 가 아닌 서버에 TLS 로 접속하면 인증서가 비어 있는 채로 이 코드를 내므로(Node.js 는 ERR_SSL_WRONG_VERSION_NUMBER),
 * 인증서가 빈 객체이면 인증서 오류가 아니다.
 */
export function isCertificateError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string" || !CERTIFICATE_ERROR_CODES.has(code)) return false;
  const cert = (error as { cert?: unknown }).cert;
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID" && typeof cert === "object" && cert !== null && Object.keys(cert).length === 0) return false;
  return true;
}

/** 연결이 거부되었거나 서버가 없는 오류인지 본다. */
export function isConnectionRefused(error: unknown): boolean {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "ECONNREFUSED" || code === "ENOENT";
}

/** 스트림 소켓을 프레임 단위 전송 계층으로 감싼다. */
export function streamTransport(socket: net.Socket): MessageTransport {
  // 인증 전에는 작은 한도를 쓰고, 로그인이 끝나면 onAuthenticated 가 큰 한도로 바꾼다.
  let maxBytes = PRE_AUTH_MAX_MESSAGE_BYTES;
  const decoder = new FrameDecoder(() => maxBytes);
  let handlers: TransportHandlers | null = null;
  let closed = false;
  let closeNotified = false;
  let failure: Error | null = null;
  const buffered: Buffer[] = [];

  const notifyClose = (): void => {
    if (!closed || handlers === null || closeNotified) return;
    closeNotified = true;
    handlers.onClose(failure);
  };

  const deliver = (chunk: Buffer): void => {
    try {
      decoder.push(chunk, (body) => handlers?.onMessage(body));
    } catch (error) {
      failure = error instanceof FrameError ? connectionFailure(`Invalid frame from the server: ${error.message}`) : (error as Error);
      socket.destroy();
    }
  };

  socket.on("data", (chunk: Buffer) => {
    if (handlers === null) buffered.push(chunk);
    else deliver(chunk);
  });
  socket.on("error", (error: Error) => {
    failure ??= connectionFailure(`Connection error: ${error.message}`, error);
  });
  socket.once("close", () => {
    if (closed) return;
    closed = true;
    notifyClose();
  });
  return {
    send(body: Buffer): void {
      if (socket.destroyed || !socket.writable) throw connectionFailure("The connection is closed.");
      socket.write(encodeFrame(body));
    },
    close(): void {
      if (socket.destroyed) return;
      socket.end();
      const timer = setTimeout(() => socket.destroy(), 2000);
      timer.unref();
      socket.once("close", () => clearTimeout(timer));
    },
    setHandlers(next: TransportHandlers): void {
      handlers = next;
      for (const chunk of buffered.splice(0)) deliver(chunk);
      if (socket.destroyed) closed = true;
      notifyClose();
    },
    onAuthenticated(): void {
      maxBytes = MAX_MESSAGE_BYTES;
    },
  };
}

function waitConnected(socket: net.Socket, event: "connect" | "secureConnect", timeoutMs: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(connectionFailure(`Timed out connecting to ${what}.`));
    }, timeoutMs);
    const onError = (error: Error): void => {
      clearTimeout(timer);
      reject(error);
    };
    socket.once("error", onError);
    socket.once(event, () => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolve();
    });
  });
}

function describeCertificateError(error: Error): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : error.message;
}

async function connectTcpOnce(host: string, port: number, ssl: SslOptions | undefined, timeoutMs: number): Promise<MessageTransport> {
  const what = `${host}:${port}`;
  if (ssl === undefined) {
    const socket = net.connect({ host, port });
    try {
      await waitConnected(socket, "connect", timeoutMs, what);
    } catch (error) {
      socket.destroy();
      throw error;
    }
    return streamTransport(socket);
  }
  const options: tls.ConnectionOptions = {
    host,
    port,
    // 검증은 기본으로 켠다. 끄려면 rejectUnauthorized: false 를 명시해야 한다.
    rejectUnauthorized: ssl.rejectUnauthorized ?? true,
  };
  if (ssl.ca !== undefined) options.ca = ssl.ca;
  // IP 주소는 SNI 로 쓸 수 없으므로(Node.js 가 경고한다) 이름일 때만 servername 을 준다. 검증 대상은 둘 다 host 이다.
  const servername = ssl.servername ?? (net.isIP(host) === 0 ? host : undefined);
  if (servername !== undefined) options.servername = servername;
  if (ssl.minVersion !== undefined) options.minVersion = ssl.minVersion;
  if (ssl.maxVersion !== undefined) options.maxVersion = ssl.maxVersion;
  if (ssl.ciphers !== undefined) options.ciphers = ssl.ciphers;
  const socket = tls.connect(options);
  try {
    await waitConnected(socket, "secureConnect", timeoutMs, what);
  } catch (error) {
    socket.destroy();
    throw error;
  }
  return streamTransport(socket);
}

/**
 * TCP(`ssl` 이 있으면 TLS)로 연결한다.
 * TLS 에서 인증서 오류가 나면 위에 적은 규칙으로 다시 시도한다. 다시 시도하는 동안 서버에는 어떤 메시지도 가지 않았다.
 * (인증서 검증은 TLS 핸드셰이크 안에서 끝나므로 hello, 사용자명, 비밀번호는 아직 보내지 않았다)
 */
export async function connectTcp(
  host: string,
  port: number,
  ssl: SslOptions | undefined,
  timeoutMs: number,
  internal: InternalTransportOptions = {},
): Promise<MessageTransport> {
  const sleep = internal.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const retries = Math.max(0, Math.floor(ssl?.certRetries ?? 2));
  const delayMs = ssl?.certRetryDelayMs ?? 100;
  const maxAttempts = retries + 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return await connectTcpOnce(host, port, ssl, timeoutMs);
    } catch (error) {
      if (error instanceof DbError) throw error;
      const failure = error as Error;
      if (ssl !== undefined && isCertificateError(failure)) {
        if (attempt < maxAttempts) {
          ssl.onCertRetry?.({ attempt, maxAttempts: retries, error: failure });
          await sleep(delayMs);
          continue;
        }
        throw new DbError(
          "08001",
          ERROR_CODES.CONNECTION_REJECTED,
          `The server certificate could not be verified (${describeCertificateError(failure)}) after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${failure.message}`,
          { cause: failure },
        );
      }
      throw connectionFailure(`Cannot connect to ${host}:${port}: ${failure.message}`, failure);
    }
  }
}
