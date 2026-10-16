/**
 * SCRAM-SHA-256 계산 (클라이언트 쪽).
 *
 * 담당
 *  - 인증 메시지(client-first, client-final)의 만들기와 server-first 의 해석
 *  - 클라이언트 증명 만들기와 서버 서명 확인
 *
 * RFC 5802(SCRAM), RFC 7677(SCRAM-SHA-256)을 따른다. 채널 바인딩은 쓰지 않는다(gs2 헤더 `n,,`).
 * 비밀번호는 SASLprep 대신 NFKC 정규화만 한다. ASCII 비밀번호는 둘이 같고, 서버와 같은 규칙이라 서로 어긋나지 않는다.
 * node:crypto 만 쓰는 순수 계산이며 평문 비밀번호는 저장하지 않고 어디에도 남기지 않는다.
 *
 * 관련 사양 : AGENTS.md 상세 4, 8 / rdbms/docs/protocol.md 7절
 * 구현 단계 : 12-2
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

/** 반복 횟수의 상한이다. 악의적인 값으로 드라이버가 오래 묶이지 않게 한다. */
export const MAX_SCRAM_ITERATIONS = 10_000_000;

/** gs2 헤더 `n,,` 의 base64 표기이다. client-final 의 `c=` 값이다. */
const GS2_HEADER_BASE64 = Buffer.from("n,,", "utf8").toString("base64");

/** 비밀번호를 정규화한다. 서버와 같은 결과를 내야 한다. */
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
  for (let i = 0; i < left.length; i++) result[i] = (left[i] as number) ^ (right[i] as number);
  return result;
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

/** SaltedPassword = PBKDF2-HMAC-SHA-256(비밀번호, 솔트, 반복 횟수). */
function saltedPassword(password: string, salt: Buffer, iterations: number): Buffer {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_SCRAM_ITERATIONS) {
    throw new RangeError(`SCRAM iteration count is out of range: ${String(iterations)}.`);
  }
  return pbkdf2Sync(Buffer.from(normalizePassword(password), "utf8"), salt, iterations, 32, "sha256");
}

/** 인증 한 번마다 쓰는 일회용 값이다. 쉼표가 없는 출력 가능 문자만 쓴다. */
export function generateNonce(): string {
  return randomBytes(18).toString("base64");
}

/** 사용자 이름 안의 `=` 와 `,` 를 SCRAM 규칙대로 바꾼다. */
export function escapeUserName(name: string): string {
  return name.replace(/=/g, "=3D").replace(/,/g, "=2C");
}

/** client-first-message-bare 이다. */
export function clientFirstBare(userName: string, clientNonce: string): string {
  return `n=${escapeUserName(userName)},r=${clientNonce}`;
}

/** client-first-message 이다. gs2 헤더 `n,,` 를 앞에 붙인다. */
export function clientFirstMessage(userName: string, clientNonce: string): string {
  return `n,,${clientFirstBare(userName, clientNonce)}`;
}

/** client-final-message-without-proof 이다. */
export function clientFinalWithoutProof(combinedNonce: string): string {
  return `c=${GS2_HEADER_BASE64},r=${combinedNonce}`;
}

/** AuthMessage 이다. 증명과 서명이 이것 위에서 계산된다. */
export function authMessage(clientFirstBareText: string, serverFirstText: string, clientFinalWithoutProofText: string): string {
  return `${clientFirstBareText},${serverFirstText},${clientFinalWithoutProofText}`;
}

/** 서버가 보낸 server-first-message 를 읽는다. 형식이 틀리거나 반복 횟수가 범위 밖이면 null 이다. */
export function parseServerFirst(text: string): { nonce: string; salt: string; iterations: number } | null {
  const match = /^r=([^,]+),s=([^,]+),i=(\d+)(?:,.*)?$/.exec(text);
  if (match === null) return null;
  const iterations = Number(match[3]);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > MAX_SCRAM_ITERATIONS) return null;
  return { nonce: match[1] as string, salt: match[2] as string, iterations };
}

/** ClientProof = ClientKey XOR HMAC(StoredKey, AuthMessage). base64 로 돌려준다. */
export function computeClientProof(password: string, saltBase64: string, iterations: number, message: string): string {
  const salted = saltedPassword(password, Buffer.from(saltBase64, "base64"), iterations);
  const clientKey = hmac(salted, "Client Key");
  const storedKey = sha256(clientKey);
  const signature = hmac(storedKey, message);
  return xor(clientKey, signature).toString("base64");
}

/** 서버가 보낸 서명이 맞는지 본다. 서버가 비밀번호를 아는지 확인하는 것이다. */
export function verifyServerSignature(password: string, saltBase64: string, iterations: number, message: string, signatureBase64: string): boolean {
  const salted = saltedPassword(password, Buffer.from(saltBase64, "base64"), iterations);
  const expected = hmac(hmac(salted, "Server Key"), message);
  return safeEqual(expected, Buffer.from(signatureBase64, "base64"));
}
