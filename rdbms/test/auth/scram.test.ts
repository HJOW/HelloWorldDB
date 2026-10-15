/**
 * SCRAM-SHA-256 계산 테스트 (8단계).
 * RFC 7677 의 시험 벡터, 검증 정보 생성과 확인, 증명과 서명의 왕복, 메시지 해석을 본다.
 * 관련 사양 : AGENTS.md 상세 4, 8
 * 구현 단계 : 8단계
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authMessage,
  clientFinalWithoutProof,
  clientFirstBare,
  clientFirstMessage,
  computeClientProof,
  computeServerSignature,
  createVerifier,
  decoyVerifier,
  escapeUserName,
  generateNonce,
  isExpectedChannelBinding,
  normalizePassword,
  parseClientFinal,
  parseClientFirst,
  parseServerFirst,
  serverFirstMessage,
  unescapeUserName,
  verifyClientProof,
  verifyPassword,
  verifyServerSignature,
} from "../../src/auth/scram.js";

// RFC 7677 3절의 예
const RFC_USER = "user";
const RFC_PASSWORD = "pencil";
const RFC_SALT = "W22ZaJ0SNY7soEsUEjb6gQ==";
const RFC_ITERATIONS = 4096;
const RFC_CLIENT_NONCE = "rOprNGfwEbeRWgbNEkqO";
const RFC_COMBINED_NONCE = "rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
const RFC_CLIENT_PROOF = "dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=";
const RFC_SERVER_SIGNATURE = "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=";

test("RFC 7677 의 시험 벡터와 증명, 서명이 일치한다", () => {
  const bare = clientFirstBare(RFC_USER, RFC_CLIENT_NONCE);
  assert.equal(bare, "n=user,r=rOprNGfwEbeRWgbNEkqO");
  assert.equal(clientFirstMessage(RFC_USER, RFC_CLIENT_NONCE), "n,,n=user,r=rOprNGfwEbeRWgbNEkqO");
  const serverFirst = serverFirstMessage(RFC_COMBINED_NONCE, { salt: RFC_SALT, iterations: RFC_ITERATIONS });
  assert.equal(serverFirst, `r=${RFC_COMBINED_NONCE},s=${RFC_SALT},i=4096`);
  const withoutProof = clientFinalWithoutProof(RFC_COMBINED_NONCE);
  assert.equal(withoutProof, `c=biws,r=${RFC_COMBINED_NONCE}`);
  const message = authMessage(bare, serverFirst, withoutProof);

  assert.equal(computeClientProof(RFC_PASSWORD, RFC_SALT, RFC_ITERATIONS, message), RFC_CLIENT_PROOF);

  const verifier = createVerifier(RFC_PASSWORD, { iterations: RFC_ITERATIONS, salt: Buffer.from(RFC_SALT, "base64") });
  assert.equal(verifyClientProof(verifier, message, RFC_CLIENT_PROOF), true);
  assert.equal(computeServerSignature(verifier.serverKey, message), RFC_SERVER_SIGNATURE);
  assert.equal(verifyServerSignature(RFC_PASSWORD, RFC_SALT, RFC_ITERATIONS, message, RFC_SERVER_SIGNATURE), true);
});

test("검증 정보는 솔트와 반복 횟수를 담고 평문 비밀번호를 담지 않는다", () => {
  const verifier = createVerifier("secret-비밀번호", { iterations: 1000 });
  assert.equal(verifier.iterations, 1000);
  assert.equal(Buffer.from(verifier.salt, "base64").length, 16);
  assert.equal(Buffer.from(verifier.storedKey, "base64").length, 32);
  assert.equal(Buffer.from(verifier.serverKey, "base64").length, 32);
  assert.ok(!JSON.stringify(verifier).includes("secret"));
  // 같은 비밀번호라도 솔트가 달라 검증 정보가 다르다.
  const other = createVerifier("secret-비밀번호", { iterations: 1000 });
  assert.notEqual(verifier.salt, other.salt);
  assert.notEqual(verifier.storedKey, other.storedKey);
});

test("비밀번호 확인은 대소문자를 구분하고 틀린 비밀번호를 거부한다", () => {
  const verifier = createVerifier("HelloWorldDB", { iterations: 1000 });
  assert.equal(verifyPassword("HelloWorldDB", verifier), true);
  assert.equal(verifyPassword("helloworlddb", verifier), false);
  assert.equal(verifyPassword("HelloWorldDB ", verifier), false);
  assert.equal(verifyPassword("", verifier), false);
});

test("비밀번호는 NFKC 로 정규화하여 같은 글자의 다른 표기를 같게 본다", () => {
  const composed = "é"; // é
  const decomposed = "é";
  assert.equal(normalizePassword(decomposed), composed);
  const verifier = createVerifier(composed, { iterations: 1000 });
  assert.equal(verifyPassword(decomposed, verifier), true);
});

test("클라이언트와 서버의 전체 교환이 맞고, 틀린 비밀번호의 증명은 거부된다", () => {
  const verifier = createVerifier("p@ss,word=1", { iterations: 2000 });
  const run = (password: string): { accepted: boolean; serverOk: boolean } => {
    const clientNonce = generateNonce();
    const first = clientFirstMessage("SCOTT", clientNonce);
    const parsedFirst = parseClientFirst(first);
    assert.ok(parsedFirst !== null);
    assert.equal(parsedFirst.userName, "SCOTT");
    const combined = parsedFirst.nonce + generateNonce();
    const serverFirst = serverFirstMessage(combined, verifier);
    const parsedServerFirst = parseServerFirst(serverFirst);
    assert.ok(parsedServerFirst !== null);
    assert.equal(parsedServerFirst.nonce, combined);
    const withoutProof = clientFinalWithoutProof(parsedServerFirst.nonce);
    const message = authMessage(parsedFirst.bare, serverFirst, withoutProof);
    const proof = computeClientProof(password, parsedServerFirst.salt, parsedServerFirst.iterations, message);
    const final = `${withoutProof},p=${proof}`;
    const parsedFinal = parseClientFinal(final);
    assert.ok(parsedFinal !== null);
    assert.equal(parsedFinal.nonce, combined);
    assert.equal(isExpectedChannelBinding(parsedFinal.channelBinding), true);
    const accepted = verifyClientProof(verifier, authMessage(parsedFirst.bare, serverFirst, parsedFinal.withoutProof), parsedFinal.proof);
    const signature = computeServerSignature(verifier.serverKey, message);
    const serverOk = verifyServerSignature(password, parsedServerFirst.salt, parsedServerFirst.iterations, message, signature);
    return { accepted, serverOk };
  };
  assert.deepEqual(run("p@ss,word=1"), { accepted: true, serverOk: true });
  assert.equal(run("p@ss,word=2").accepted, false);
});

test("증명은 인증 메시지가 달라지면 통과하지 못한다 (재생 공격 방지)", () => {
  const verifier = createVerifier("pw", { iterations: 1000 });
  const proof = computeClientProof("pw", verifier.salt, verifier.iterations, "message-1");
  assert.equal(verifyClientProof(verifier, "message-1", proof), true);
  assert.equal(verifyClientProof(verifier, "message-2", proof), false);
  assert.equal(verifyClientProof(verifier, "message-1", "AAAA"), false);
  assert.equal(verifyClientProof(verifier, "message-1", ""), false);
});

test("사용자 이름의 = 와 , 는 이스케이프하고 되돌린다", () => {
  assert.equal(escapeUserName("a=b,c"), "a=3Db=2Cc");
  assert.equal(unescapeUserName("a=3Db=2Cc"), "a=b,c");
  assert.equal(unescapeUserName("bad=name"), null);
  const message = clientFirstMessage("we,ird=name", "nonce123");
  assert.equal(parseClientFirst(message)?.userName, "we,ird=name");
});

test("형식이 틀린 메시지는 해석하지 않는다", () => {
  assert.equal(parseClientFirst("y,,n=user,r=abc"), null);
  assert.equal(parseClientFirst("n,,n=,r=abc"), null);
  assert.equal(parseClientFirst("n,,r=abc"), null);
  assert.equal(parseServerFirst("r=abc,s=xyz"), null);
  assert.equal(parseServerFirst("r=abc,s=xyz,i=0"), null);
  assert.equal(parseServerFirst("r=abc,s=xyz,i=99999999999"), null);
  assert.equal(parseClientFinal("c=biws,r=abc"), null);
  assert.equal(isExpectedChannelBinding("eSws"), false);
});

test("없는 사용자의 가짜 검증 정보는 같은 이름에 항상 같은 솔트를 주고 어떤 증명도 통과하지 못한다", () => {
  const secret = Buffer.from("server-run-secret");
  const first = decoyVerifier("NOBODY", secret, 1000);
  const second = decoyVerifier("NOBODY", secret, 1000);
  const other = decoyVerifier("SOMEONE", secret, 1000);
  assert.deepEqual(first, second);
  assert.notEqual(first.salt, other.salt);
  const proof = computeClientProof("any", first.salt, first.iterations, "m");
  assert.equal(verifyClientProof(first, "m", proof), false);
});

test("반복 횟수가 범위를 벗어나면 거부한다", () => {
  assert.throws(() => createVerifier("pw", { iterations: 0 }), RangeError);
  assert.throws(() => createVerifier("pw", { iterations: 1.5 }), RangeError);
});
