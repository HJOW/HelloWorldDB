/**
 * 담당 : v1 내부 페이지 접근 규약. SQL과 무관한 바이트열만 다룬다.
 * 관련 사양 : AGENTS.md 상세 3, 10.
 * 구현 단계 : 2단계.
 */
import type { PageKind } from "./pages.js";

export interface ReadContext {
  page(id: number, kind?: PageKind, owner?: number): Buffer;
}
/**
 * 힙 하나의 빈자리 지도이다. 메모리에만 있고 파일 포맷이 아니다.
 * 지도는 힌트일 뿐이어서, 쓸 때마다 실제 페이지를 읽어 검증하므로 틀려도 데이터는 안전하다.
 *  - candidates : 행을 넣을 빈자리가 있을 것으로 보는 페이지 번호들 (체인 순서로 훑어 모으고, 삭제로 빈 페이지는 뒤에 붙는다)
 *  - tail : 페이지 체인의 마지막 페이지 번호 (새 페이지를 이을 곳)
 */
export interface HeapSpace {
  candidates: Set<number>;
  tail: number;
}
export interface WriteContext extends ReadContext {
  write(id: number, page: Buffer): void;
  allocate(kind: PageKind, owner: number): number;
  free(id: number): void;
  /** 이 힙의 빈자리 지도를 돌려준다. 아직 없으면 undefined 이다. */
  heapSpace(root: number): HeapSpace | undefined;
  /** 빈자리 지도를 둔다. undefined 이면 지운다. 배치가 롤백되면 그 배치가 건드린 힙의 지도는 버려진다. */
  setHeapSpace(root: number, space: HeapSpace | undefined): void;
}
