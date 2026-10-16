/**
 * `hwdb` 화면 문구의 카탈로그와 언어 선택 테스트 (9단계, 사용자 결정 2026-10-16).
 * 지금은 영어뿐이지만, 다른 언어를 더해도 호출하는 쪽이 바뀌지 않는지를 가짜 언어 카탈로그로 확인한다.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { INITIAL_PASSWORD_WARNING } from "../../src/daemon/server.js";
import {
  DEFAULT_LOCALE,
  availableLocales,
  checkCatalog,
  detectLocale,
  formatMessage,
  getLocale,
  normalizeLocale,
  placeholdersOf,
  registerCatalog,
  resolveLocale,
  setLocale,
  t,
} from "../../src/cli/i18n.js";
import { EN_MESSAGES } from "../../src/cli/messages/en.js";

const HWDB = fileURLToPath(new URL("../../src/cli/main.js", import.meta.url));

test("기본 언어는 영어이고 문구를 키로 꺼낸다", () => {
  assert.equal(getLocale(), DEFAULT_LOCALE);
  assert.deepEqual(availableLocales(), ["en"]);
  assert.equal(t("common.yes"), "yes");
  assert.equal(t("status.port", { value: 7410 }), "port: 7410");
  assert.equal(t("start.failed", { reason: "boom" }), "hwdb start: boom");
});

test("채우지 않은 {이름} 자리는 그대로 남고, 값이 없는 자리를 만들지 않는다", () => {
  assert.equal(formatMessage("a {x} b {y}", { x: 1 }), "a 1 b {y}");
  assert.equal(formatMessage("no params"), "no params");
  assert.deepEqual(placeholdersOf("{b} {a} {a} {1}"), ["a", "b"]);
});

test("영어 카탈로그의 모든 키는 영어 점검을 통과하고, 사용법에는 자리 표시자가 없다", () => {
  assert.deepEqual(checkCatalog(EN_MESSAGES), []);
  assert.deepEqual(placeholdersOf(EN_MESSAGES["usage.text"]), []);
  // 같은 문구를 두 곳에서 따로 적지 않는다 : 서버 로그의 경고와 화면 경고가 같은 영어 문구이다.
  assert.equal(EN_MESSAGES["warning.initialPassword"], INITIAL_PASSWORD_WARNING);
});

test("언어 이름을 정규화한다", () => {
  assert.equal(normalizeLocale("ko_KR.UTF-8"), "ko-kr");
  assert.equal(normalizeLocale("ko-KR"), "ko-kr");
  assert.equal(normalizeLocale("en_US.UTF-8@euro"), "en-us");
  assert.equal(normalizeLocale("C"), null);
  assert.equal(normalizeLocale("POSIX"), null);
  assert.equal(normalizeLocale(""), null);
  assert.equal(normalizeLocale(undefined), null);
});

test("등록된 카탈로그가 없는 언어는 영어이다", () => {
  assert.equal(resolveLocale(["ko_KR.UTF-8", "fr_FR"]), "en");
  assert.equal(detectLocale({ LANG: "ko_KR.UTF-8" }), "en");
  assert.equal(detectLocale({}), "en");
  assert.equal(setLocale("ja_JP"), "en");
  assert.equal(t("common.no"), "no");
});

test("새 언어를 등록하면 선택 규칙과 호출하는 쪽을 고치지 않고 쓸 수 있다", (context) => {
  context.after(() => setLocale("en"));
  // 가짜 언어 : 일부 키만 있다. 빠진 키는 영어로 채워진다.
  const fake = { "common.yes": "YES-ZZ", "status.port": "PORT-ZZ {value}" };
  assert.deepEqual(checkCatalog(fake), []);
  registerCatalog("zz", fake);
  assert.ok(availableLocales().includes("zz"));

  assert.equal(setLocale("zz_ZZ.UTF-8"), "zz", "지역이 붙은 이름은 언어 이름으로 찾는다");
  assert.equal(t("common.yes"), "YES-ZZ");
  assert.equal(t("status.port", { value: 1 }), "PORT-ZZ 1");
  assert.equal(t("common.no"), "no", "카탈로그에 없는 키는 영어이다");

  // 환경 변수 우선순위 : HWDB_LANG > LC_ALL > LC_MESSAGES > LANG
  assert.equal(detectLocale({ HWDB_LANG: "zz", LANG: "en_US" }), "zz");
  assert.equal(detectLocale({ LANG: "zz_ZZ", LC_ALL: "C" }), "zz");
  assert.equal(detectLocale({ LC_ALL: "en_US", LANG: "zz" }), "en");
  assert.equal(detectLocale({ HWDB_LANG: "unknown", LANG: "zz" }), "zz", "등록되지 않은 후보는 건너뛴다");
});

test("카탈로그 점검은 없는 키와 어긋난 자리 표시자를 찾아낸다", () => {
  const problems = checkCatalog({
    "status.port": "PORT {valeu}",
    "no.such.key": "x",
    "common.yes": "ok",
  } as never);
  assert.equal(problems.length, 2);
  assert.ok(problems.some((line) => line.startsWith("unknown key: no.such.key")));
  assert.ok(problems.some((line) => line.startsWith("placeholders differ: status.port")));
});

test("영어 카탈로그는 바꿀 수 없고, 잘못된 언어 이름은 등록할 수 없다", () => {
  assert.throws(() => registerCatalog("en", {}), RangeError);
  assert.throws(() => registerCatalog("C", {}), RangeError);
  assert.equal(resolveLocale(["en_US.UTF-8"]), "en", "en_US 는 영어 카탈로그로 풀린다");
});

test("hwdb --help 는 카탈로그의 사용법을 그대로 낸다", () => {
  const result = spawnSync(process.execPath, [HWDB, "--help"], {
    encoding: "utf8",
    env: { ...process.env, HWDB_LANG: "ko" },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, EN_MESSAGES["usage.text"]);
});
