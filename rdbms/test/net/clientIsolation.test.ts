/**
 * 클라이언트와 공유 모듈의 의존 범위 시험 (9단계).
 * `client/*` 와 서버·클라이언트가 함께 쓰는 모듈은 서버 쪽 모듈(session, exec, catalog, storage, txn, types, sql 등)을 import 하지 않는다.
 * 그래야 12단계의 `nodejsDriver` 가 이 코드를 출발점으로 가져가도 서버 코드를 끌고 가지 않는다. (PROGRESS.md "모듈 사이의 의존 방향")
 * 관련 사양 : AGENTS.md 상세 8
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SRC = fileURLToPath(new URL("../../../src/", import.meta.url));

/** 파일이 import 하는 모듈 지정자를 모두 모은다. (`import ... from "x"`, `export ... from "x"`, `import("x")`) */
function importsOf(file: string): string[] {
  const text = fs.readFileSync(path.join(SRC, file), "utf8");
  const specifiers = new Set<string>();
  // 문장 맨 앞의 import, export ... from, 동적 import(). (문자열 안의 `from("...")` 같은 것은 세지 않는다)
  for (const match of text.matchAll(/^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)) specifiers.add(match[1] as string);
  for (const match of text.matchAll(/^[ \t]*import\s*["']([^"']+)["']/gm)) specifiers.add(match[1] as string);
  for (const match of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) specifiers.add(match[1] as string);
  return [...specifiers];
}

/** 상대 경로 지정자를 `src` 기준의 파일 경로(확장자 제외)로 바꾼다. node: 같은 내장 모듈은 그대로이다. */
function resolveSpecifier(fromFile: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier)).replace(/\.js$/, "");
}

const CLIENT_FILES = fs.readdirSync(path.join(SRC, "client")).filter((name) => name.endsWith(".ts")).map((name) => `client/${name}`);

/** 서버와 클라이언트가 함께 쓰는 모듈이다. 서버 모듈을 import 하지 않는다. */
const SHARED_FILES = ["net/protocol.ts", "net/framing.ts", "net/udpReliability.ts", "auth/scram.ts"];

/** 클라이언트와 공유 모듈이 쓸 수 있는 프로젝트 안의 모듈이다. */
const ALLOWED_PROJECT_MODULES = new Set([
  "common/errors",
  "common/instance",
  "net/protocol",
  "net/framing",
  "net/udpReliability",
  "auth/scram",
]);

function checkFile(file: string): void {
  const dir = path.posix.dirname(file);
  for (const specifier of importsOf(file)) {
    const resolved = resolveSpecifier(file, specifier);
    if (!specifier.startsWith(".")) {
      assert.match(resolved, /^node:/, `${file}: 외부 패키지를 import 하지 않는다 (${specifier})`);
      continue;
    }
    const sameDir = path.posix.dirname(resolved) === dir && dir === "client";
    assert.ok(
      sameDir || ALLOWED_PROJECT_MODULES.has(resolved),
      `${file} 가 허용되지 않은 모듈을 import 한다: ${specifier} (→ ${resolved})`,
    );
  }
}

test("클라이언트는 서버 모듈을 import 하지 않는다", () => {
  assert.ok(CLIENT_FILES.length >= 3, "client 아래 파일을 찾아야 한다");
  for (const file of CLIENT_FILES) checkFile(file);
});

test("서버와 클라이언트가 함께 쓰는 모듈은 서버 모듈을 import 하지 않는다", () => {
  for (const file of SHARED_FILES) {
    for (const specifier of importsOf(file)) {
      const resolved = resolveSpecifier(file, specifier);
      if (!specifier.startsWith(".")) {
        assert.match(resolved, /^node:/, `${file}: 외부 패키지를 import 하지 않는다 (${specifier})`);
        continue;
      }
      assert.ok(ALLOWED_PROJECT_MODULES.has(resolved), `${file} 가 허용되지 않은 모듈을 import 한다: ${specifier} (→ ${resolved})`);
    }
  }
});

test("import 추출이 실제로 동작한다 (시험 장치 확인)", () => {
  const imports = importsOf("client/connection.ts").map((specifier) => resolveSpecifier("client/connection.ts", specifier));
  assert.ok(imports.includes("net/protocol"));
  assert.ok(imports.includes("auth/scram"));
  assert.ok(imports.includes("client/transports"));
});

test("통신 서버 모듈은 session 과 auth/scram 과 common 외의 서버 내부(exec, catalog, storage 등)를 직접 부르지 않는다", () => {
  const forbidden = ["exec/", "catalog/", "storage/", "txn/", "sql/", "types/"];
  const serverNet = fs
    .readdirSync(path.join(SRC, "net"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `net/${name}`);
  const allowedTypes = new Set(["net/resultEncoder.ts", "net/cursors.ts"]); // 값 → JSON 변환과 커서(결과 행의 타입)는 타입 시스템의 타입을 쓴다. (서버 전용 모듈)
  for (const file of serverNet) {
    for (const specifier of importsOf(file)) {
      const resolved = resolveSpecifier(file, specifier);
      for (const prefix of forbidden) {
        if (resolved.startsWith(prefix)) {
          assert.ok(allowedTypes.has(file) && prefix === "types/", `${file} 가 ${prefix} 를 직접 import 한다 (${specifier})`);
        }
      }
    }
  }
});
