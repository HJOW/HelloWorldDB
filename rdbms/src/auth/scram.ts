/**
 * SCRAM-SHA-256 계산.
 *
 * 담당
 *  - 비밀번호로부터 검증 정보 만들기 : 솔트, 반복 횟수, StoredKey, ServerKey
 *  - 인증 절차의 계산 : 클라이언트 증명 만들기와 검증, 서버 서명 만들기와 검증
 *  - 인증 메시지(client-first, server-first, client-final)의 만들기와 해석
 *
 * 서버와 클라이언트(client/connection.ts)가 함께 쓰는 순수 계산 모듈이다.
 * 사용자 저장소나 통신에 의존하지 않으며, node:crypto 만 쓴다.
 * 평문 비밀번호는 저장하지 않고 로그에도 남기지 않는다.
 *
 * RFC 5802(SCRAM), RFC 7677(SCRAM-SHA-256)를 따른다. 채널 바인딩은 쓰지 않는다(gs2 헤더 `n,,`).
 * 비밀번호는 SASLprep 대신 NFKC 정규화만 한다. ASCII 비밀번호는 둘이 같고,
 * 서버와 클라이언트가 같은 함수(`normalizePassword`)를 쓰므로 서로 어긋나지 않는다.
 *
 * 관련 사양 : AGENTS.md 상세 4, 8
 * 구현 단계 : 8단계
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

/** 인증 방식의 이름이다. 핸드셰이크에서 협상한다. */
export const SCRAM_MECHANISM = "SCRAM-SHA-256";

/** 새 검증 정보를 만들 때의 반복 횟수이다. RFC 7677 이 권하는 최소값이며 PostgreSQL 의 기본값과 같다. */
export const DEFAULT_SCRAM_ITERATIONS = 4096;

/** 반복 횟수의 상한이다. 악의적인 값으로 서버나 클라이언트가 오래 묶이지 않게 한다. */
export const MAX_SCRAM_ITERATIONS = 10_000_000;

/** gs2 헤더 `n,,` 의 base64 표기이다. client-final 의 `c=` 값이다. */
const GS2_HEADER_BASE64 = Buffer.from("n,,", "utf8").toString("base64");

/** 사용자 저장소에 두는 검증 정보이다. 모든 값은 base64 문자열이다. */
export interface ScramVerifier {
  salt: string;
  iterations: number;
  storedKey: string;
  serverKey: string;
}

/** 비밀번호를 정규화한다. 서버와 클라이언트가 같은 결과를 내야 한다. */
export function normalizePassword(password: string): string {
  return password.normalize("NFKC");
}

function hmac(key: Buffer, data: string | Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

function xor(left: Buffer, right: Buffer): Buffer {
  const result = Buffer.alloc(left.length);
  for (let i = 0; i < left.length; i++) {
    result[i] = (left[i] as number) ^ (right[i] as number);
  }
  return result;
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

/** SaltedPassword = PBKDF2-HMAC-SHA-256(비밀번호, 솔트, 반복 횟수). */
function saltedPassword(password: string, salt: Buffer, iterations: number): Buffer {
  assertIterations(iterations);
  return pbkdf2Sync(Buffer.from(normalizePassword(password), "utf8"), salt, iterations, 32, "sha256");
}

function assertIterations(iterations: number): void {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_SCRAM_ITERATIONS) {
    throw new RangeError(`SCRAM iteration count is out of range: ${String(iterations)}.`);
  }
}

// ---------------------------------------------------------------------------
// 검증 정보
// ---------------------------------------------------------------------------

/** 비밀번호로 검증 정보를 만든다. 솔트는 무작위이고, 시험에서만 `salt` 를 지정한다. */
export function createVerifier(
  password: string,
  options: { iterations?: number; salt?: Buffer } = {},
): ScramVerifier {
  const iterations = options.iterations ?? DEFAULT_SCRAM_ITERATIONS;
  const salt = options.salt ?? randomBytes(16);
  const salted = saltedPassword(password, salt, iterations);
  const clientKey = hmac(salted, "Client Key");
  return {
    salt: salt.toString("base64"),
    iterations,
    storedKey: sha256(clientKey).toString("base64"),
    serverKey: hmac(salted, "Server Key").toString("base64"),
  };
}

/** 비밀번호가 검증 정보와 맞는지 본다. 비교는 상수 시간으로 한다. */
export function verifyPassword(password: string, verifier: ScramVerifier): boolean {
  const salted = saltedPassword(password, Buffer.from(verifier.salt, "base64"), verifier.iterations);
  const storedKey = sha256(hmac(salted, "Client Key"));
  return safeEqual(storedKey, Buffer.from(verifier.storedKey, "base64"));
}

/**
 * 없는 사용자에게 줄 가짜 검증 정보이다. 사용자 이름과 서버가 구동 때 정한 비밀값으로 솔트를 정해,
 * 같은 이름에는 항상 같은 솔트가 나가게 한다. 이렇게 하면 솔트가 달라지는지로 사용자의 존재를 알 수 없다.
 * 이 검증 정보로는 어떤 증명도 통과하지 못한다.
 */
export function decoyVerifier(userName: string, secret: Buffer, iterations = DEFAULT_SCRAM_ITERATIONS): ScramVerifier {
  const salt = hmac(secret, `salt:${userName}`).subarray(0, 16);
  return {
    salt: salt.toString("base64"),
    iterations,
    storedKey: hmac(secret, `stored:${userName}`).toString("base64"),
    serverKey: hmac(secret, `server:${userName}`).toString("base64"),
  };
}

// ---------------------------------------------------------------------------
// 메시지
// ---------------------------------------------------------------------------

/** 인증 한 번마다 쓰는 일회용 값이다. 쉼표가 없는 출력 가능 문자만 쓴다. */
export function generateNonce(): string {
  return randomBytes(18).toString("base64");
}

/** 사용자 이름 안의 `=` 와 `,` 를 SCRAM 규칙대로 바꾼다. */
export function escapeUserName(name: string): string {
  return name.replace(/=/g, "=3D").replace(/,/g, "=2C");
}

/** `escapeUserName` 의 반대이다. 규칙에 어긋나는 `=` 가 있으면 null 이다. */
export function unescapeUserName(text: string): string | null {
  if (/=(?!2C|3D)/.test(text)) return null;
  return text.replace(/=2C/g, ",").replace(/=3D/g, "=");
}

/** client-first-message-bare 이다. */
export function clientFirstBare(userName: string, clientNonce: string): string {
  return `n=${escapeUserName(userName)},r=${clientNonce}`;
}

/** client-first-message 이다. gs2 헤더 `n,,` 를 앞에 붙인다. */
export function clientFirstMessage(userName: string, clientNonce: string): string {
  return `n,,${clientFirstBare(userName, clientNonce)}`;
}

/** server-first-message 이다. */
export function serverFirstMessage(combinedNonce: string, verifier: Pick<ScramVerifier, "salt" | "iterations">): string {
  return `r=${combinedNonce},s=${verifier.salt},i=${String(verifier.iterations)}`;
}

/** client-final-message-without-proof 이다. */
export function clientFinalWithoutProof(combinedNonce: string): string {
  return `c=${GS2_HEADER_BASE64},r=${combinedNonce}`;
}

/** AuthMessage 이다. 증명과 서명이 이것 위에서 계산된다. */
export function authMessage(clientFirstBareText: string, serverFirstText: string, clientFinalWithoutProofText: string): string {
  return `${clientFirstBareText},${serverFirstText},${clientFinalWithoutProofText}`;
}

/** 서버가 보낸 server-first-message 를 읽는다. 형식이 틀리면 null 이다. */
export function parseServerFirst(text: string): { nonce: string; salt: string; iterations: number } | null {
  const match = /^r=([^,]+),s=([^,]+),i=(\d+)(?:,.*)?$/.exec(text);
  if (match === null) return null;
  const iterations = Number(match[3]);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > MAX_SCRAM_ITERATIONS) return null;
  return { nonce: match[1] as string, salt: match[2] as string, iterations };
}

/** 클라이언트가 보낸 client-first-message 를 읽는다. 형식이 틀리면 null 이다. */
export function parseClientFirst(text: string): { userName: string; nonce: string; bare: string } | null {
  if (!text.startsWith("n,,")) return null;
  const bare = text.slice(3);
  const match = /^n=([^,]*),r=([^,]+)(?:,.*)?$/.exec(bare);
  if (match === null) return null;
  const userName = unescapeUserName(match[1] as string);
  if (userName === null || userName.length === 0) return null;
  return { userName, nonce: match[2] as string, bare };
}

/** 클라이언트가 보낸 client-final-message 를 읽는다. 형식이 틀리면 null 이다. */
export function parseClientFinal(text: string): { channelBinding: string; nonce: string; proof: string; withoutProof: string } | null {
  const match = /^(c=([^,]+),r=([^,]+)(?:,[^p][^,]*)*),p=([^,]+)$/.exec(text);
  if (match === null) return null;
  return {
    withoutProof: match[1] as string,
    channelBinding: match[2] as string,
    nonce: match[3] as string,
    proof: match[4] as string,
  };
}

/** 클라이언트가 gs2 헤더를 바꾸지 않았는지 본다. */
export function isExpectedChannelBinding(value: string): boolean {
  return value === GS2_HEADER_BASE64;
}

// ---------------------------------------------------------------------------
// 증명과 서명
// ---------------------------------------------------------------------------

/** 클라이언트 쪽 : ClientProof = ClientKey XOR HMAC(StoredKey, AuthMessage). base64 로 돌려준다. */
export function computeClientProof(password: string, saltBase64: string, iterations: number, message: string): string {
  const salted = saltedPassword(password, Buffer.from(saltBase64, "base64"), iterations);
  const clientKey = hmac(salted, "Client Key");
  const storedKey = sha256(clientKey);
  const signature = hmac(storedKey, message);
  return xor(clientKey, signature).toString("base64");
}

/** 서버 쪽 : 클라이언트 증명이 검증 정보와 맞는지 본다. */
export function verifyClientProof(verifier: ScramVerifier, message: string, proofBase64: string): boolean {
  const proof = Buffer.from(proofBase64, "base64");
  const storedKey = Buffer.from(verifier.storedKey, "base64");
  if (proof.length !== storedKey.length) return false;
  const signature = hmac(storedKey, message);
  const clientKey = xor(proof, signature);
  return safeEqual(sha256(clientKey), storedKey);
}

/** 서버 서명이다. 클라이언트가 서버를 확인하는 데 쓴다. base64 로 돌려준다. */
export function computeServerSignature(serverKeyBase64: string, message: string): string {
  return hmac(Buffer.from(serverKeyBase64, "base64"), message).toString("base64");
}

/** 클라이언트 쪽 : 서버가 보낸 서명이 맞는지 본다. */
export function verifyServerSignature(password: string, saltBase64: string, iterations: number, message: string, signatureBase64: string): boolean {
  const salted = saltedPassword(password, Buffer.from(saltBase64, "base64"), iterations);
  const expected = hmac(hmac(salted, "Server Key"), message);
  return safeEqual(expected, Buffer.from(signatureBase64, "base64"));
}
