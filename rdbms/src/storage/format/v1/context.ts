/**
 * 담당 : v1 내부 페이지 접근 규약. SQL과 무관한 바이트열만 다룬다.
 * 관련 사양 : AGENTS.md 상세 3, 10.
 * 구현 단계 : 2단계.
 */
import type { PageKind } from "./pages.js";

export interface ReadContext {
  page(id: number, kind?: PageKind, owner?: number): Buffer;
}
export interface WriteContext extends ReadContext {
  write(id: number, page: Buffer): void;
  allocate(kind: PageKind, owner: number): number;
  free(id: number): void;
}
