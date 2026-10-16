/**
 * `hwdb` 화면 문구의 다국어 처리 기반.
 *
 * 담당
 *  - 메시지 카탈로그 등록, 언어 선택, 키로 문구 꺼내기(`t`), `{이름}` 채우기
 *  - 언어 이름 해석 : `ko_KR.UTF-8`, `ko-KR`, `ko` 처럼 적힌 값을 등록된 카탈로그 중 가장 알맞은 것으로 고른다.
 *    없으면 영어이다.
 *  - 카탈로그 점검(`checkCatalog`) : 영어에 없는 키, 영어와 다른 `{이름}` 을 찾아낸다. 새 언어를 더할 때 시험에서 쓴다.
 *
 * 지금은 영어 카탈로그만 있다. (사용자 결정 2026-10-16) 다른 언어를 더하려면
 *  1. `messages/<언어>.ts` 에 같은 키로 문구를 적는다. (일부 키만 있어도 된다. 빠진 키는 영어로 보인다)
 *  2. 이 모듈의 `registerCatalog("<언어>", 카탈로그)` 로 등록한다. (`hwdb` 시작 시 등록하는 곳은 아래 `registerBuiltinCatalogs`)
 *  3. `checkCatalog` 시험을 더한다.
 * 선택 규칙과 호출하는 쪽은 바꿀 필요가 없다.
 *
 * DB 오류 메시지와 서버 로그는 이 모듈을 쓰지 않는다. 영문으로 고정이다. (AGENTS.md 상세 0)
 * 이 모듈은 다른 모듈을 import 하지 않는다. (영어 카탈로그의 타입만 가져온다)
 *
 * 관련 사양 : AGENTS.md 상세 14
 * 구현 단계 : 9단계 (사용자 결정 2026-10-16)
 */

import { EN_MESSAGES } from "./messages/en.js";
import type { MessageKey } from "./messages/en.js";

export type { MessageKey } from "./messages/en.js";

/** 한 언어의 카탈로그이다. 일부 키만 있어도 된다. */
export type MessageCatalog = Readonly<Partial<Record<MessageKey, string>>>;

/** 기본 언어이다. 모든 키가 있는 유일한 카탈로그이다. */
export const DEFAULT_LOCALE = "en";

const catalogs = new Map<string, MessageCatalog>([[DEFAULT_LOCALE, EN_MESSAGES]]);
let currentLocale = DEFAULT_LOCALE;

/** 언어 이름을 정규화한다. `ko_KR.UTF-8@x` → `ko-kr`. 비어 있거나 `C`, `POSIX` 면 null 이다. */
export function normalizeLocale(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const cut = raw.split(/[.@]/)[0] ?? "";
  const name = cut.trim().replace(/_/g, "-").toLowerCase();
  if (name === "" || name === "c" || name === "posix") return null;
  return name;
}

/** 카탈로그를 등록한다. 같은 언어를 다시 등록하면 바꾼다. 영어는 바꿀 수 없다. */
export function registerCatalog(locale: string, catalog: MessageCatalog): void {
  const name = normalizeLocale(locale);
  if (name === null) throw new RangeError(`Invalid locale name: "${locale}".`);
  if (name === DEFAULT_LOCALE) throw new RangeError("The English catalog cannot be replaced.");
  catalogs.set(name, catalog);
}

/** 등록된 언어 이름 목록이다. (정규화된 이름, 영어 포함) */
export function availableLocales(): string[] {
  return [...catalogs.keys()];
}

/**
 * 후보 언어 이름 중 처음으로 쓸 수 있는 것을 고른다. `ko-kr` 이 없으면 `ko` 를 본다. 모두 없으면 영어이다.
 * 환경 변수 순서처럼 우선순위가 높은 것부터 넘긴다.
 */
export function resolveLocale(candidates: ReadonlyArray<string | undefined>): string {
  for (const candidate of candidates) {
    const name = normalizeLocale(candidate);
    if (name === null) continue;
    if (catalogs.has(name)) return name;
    const language = name.split("-")[0] ?? "";
    if (catalogs.has(language)) return language;
  }
  return DEFAULT_LOCALE;
}

/** 환경에서 언어를 고른다. `HWDB_LANG` 이 가장 앞서고, 그 다음은 `LC_ALL`, `LC_MESSAGES`, `LANG` 순서이다. */
export function detectLocale(env: Readonly<Record<string, string | undefined>>): string {
  return resolveLocale([env["HWDB_LANG"], env["LC_ALL"], env["LC_MESSAGES"], env["LANG"]]);
}

/** 이후의 `t` 가 쓸 언어를 정한다. 등록되지 않은 언어는 영어가 된다. 정해진 언어 이름을 돌려준다. */
export function setLocale(locale: string | undefined): string {
  currentLocale = resolveLocale([locale]);
  return currentLocale;
}

export function getLocale(): string {
  return currentLocale;
}

/** `hwdb` 가 시작할 때 환경에서 언어를 골라 정한다. */
export function initLocaleFromEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): string {
  registerBuiltinCatalogs();
  return setLocale(detectLocale(env));
}

/**
 * 제품에 들어 있는 언어 카탈로그를 등록하는 곳이다. 지금은 영어뿐이라 할 일이 없다.
 * 언어를 더하면 `registerCatalog("ko", KO_MESSAGES)` 같은 줄을 여기에 넣는다.
 */
export function registerBuiltinCatalogs(): void {
  // 영어는 처음부터 들어 있다.
}

/** 문구 안의 `{이름}` 자리를 값으로 채운다. 값이 없는 자리는 그대로 둔다. */
export function formatMessage(template: string, params?: Readonly<Record<string, string | number | boolean>>): string {
  if (params === undefined) return template;
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** 현재 언어로 문구를 꺼낸다. 그 언어에 키가 없으면 영어로 채운다. */
export function t(key: MessageKey, params?: Readonly<Record<string, string | number | boolean>>): string {
  const template = catalogs.get(currentLocale)?.[key] ?? EN_MESSAGES[key];
  return formatMessage(template, params);
}

/** 문구 안의 `{이름}` 목록이다. 카탈로그 점검에 쓴다. */
export function placeholdersOf(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) names.add(match[1] as string);
  return [...names].sort();
}

/**
 * 카탈로그가 영어와 어긋난 곳을 찾는다. 새 언어를 더할 때 시험에서 이 목록이 비어 있어야 한다.
 *  - 영어에 없는 키 (오타이거나 쓰이지 않는 문구)
 *  - 영어와 `{이름}` 이 다른 문구 (값이 채워지지 않거나 남는다)
 * 빠진 키는 오류가 아니다. 영어로 채워진다.
 */
export function checkCatalog(catalog: MessageCatalog): string[] {
  const problems: string[] = [];
  for (const [key, text] of Object.entries(catalog)) {
    if (!Object.hasOwn(EN_MESSAGES, key)) {
      problems.push(`unknown key: ${key}`);
      continue;
    }
    const english = placeholdersOf(EN_MESSAGES[key as MessageKey]);
    const own = placeholdersOf(text);
    if (english.join(",") !== own.join(",")) {
      problems.push(`placeholders differ: ${key} (en: ${english.join(",")}; this: ${own.join(",")})`);
    }
  }
  return problems;
}
