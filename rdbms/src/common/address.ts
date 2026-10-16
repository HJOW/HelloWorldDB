/**
 * 네트워크 주소 판정.
 *
 * 담당
 *  - 루프백 주소인지 판정한다 : `127.0.0.0/8`, `::1`, IPv4 로 매핑된 루프백(`::ffff:127.x.x.x`).
 *    TCP, UDP 접속의 상대 주소가 루프백이면 "로컬 접속" 으로 본다. (사양 상세 6)
 *  - 소켓이 알려 주는 상대 주소를 기록용으로 다듬는다 : IPv4 로 매핑된 IPv6 주소(`::ffff:1.2.3.4`)는 `1.2.3.4` 로 적는다.
 *
 * 서버 장비의 비루프백 주소(LAN IP 등)는 같은 장비에서 접속해도 루프백이 아니므로 원격으로 본다.
 * node:net 외에는 의존하지 않는다.
 *
 * 관련 사양 : AGENTS.md 상세 6
 * 구현 단계 : 9단계 (9-3)
 */

import { isIP } from "node:net";

/** IPv6 주소를 16비트 8묶음으로 풀어 돌려준다. 형식이 틀리면 null 이다. 끝의 IPv4 표기(`::ffff:1.2.3.4`)도 받는다. */
function parseIpv6(text: string): number[] | null {
  let address = text;
  // 끝의 점 표기 IPv4 를 16비트 두 묶음으로 바꾼다.
  const lastColon = address.lastIndexOf(":");
  const tail = address.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = tail.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    const high = ((octets[0] as number) << 8) | (octets[1] as number);
    const low = ((octets[2] as number) << 8) | (octets[3] as number);
    address = `${address.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const piece of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0] as string);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = toGroups(halves[1] as string);
  if (rest === null || head.length + rest.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest];
}

/**
 * 루프백 주소인지 본다. 주소가 없거나(null, undefined) 형식이 틀리면 false 이다.
 * IPv6 의 영역 표기(`fe80::1%eth0`)는 떼고 본다.
 */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (typeof address !== "string") return false;
  let text = address.trim().toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const version = isIP(text);
  if (version === 4) return text.split(".")[0] === "127";
  if (version === 6) {
    const groups = parseIpv6(text);
    if (groups === null) return false;
    const leadingZeros = groups.slice(0, 5).every((group) => group === 0);
    // ::1
    if (leadingZeros && groups[5] === 0 && groups[6] === 0 && groups[7] === 1) return true;
    // ::ffff:127.x.x.x (IPv4 로 매핑된 루프백)
    return leadingZeros && groups[5] === 0xffff && (groups[6] as number) >> 8 === 127;
  }
  return false;
}

/**
 * 소켓이 알려 준 상대 주소를 세션 기록(SYS_SESSIONS 의 CLIENT_ADDRESS)에 적을 형태로 다듬는다.
 * IPv4 로 매핑된 IPv6 주소(`::ffff:1.2.3.4`)는 IPv4 로, IPv6 영역 표기(`%eth0`)는 뗀다. 주소가 없으면 null 이다.
 * 루프백 판정은 다듬기 전후가 같으므로 판정에는 어느 쪽을 써도 된다.
 */
export function normalizeRemoteAddress(address: string | null | undefined): string | null {
  if (typeof address !== "string" || address === "") return null;
  let text = address;
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text);
  return mapped === null ? text : (mapped[1] as string);
}
