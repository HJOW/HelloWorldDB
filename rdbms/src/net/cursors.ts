/**
 * 커서 저장소. 접속 하나가 가진다.
 *
 * 담당
 *  - 큰 조회 결과를 나누어 보내기 위해 남은 행을 쥐어 둔다. 결과의 행은 문장이 실행된 시점에 복사된 것이라
 *    커밋, 롤백, 새 문장과 무관하게 유효하다. ("홀더블" 의미)
 *  - 접속 하나가 동시에 열어 둘 수 있는 커서는 16개이다. 넘으면 53400 이다. 서버가 커서를 위해 쥐는 메모리를 제한하기 위함이다.
 *  - 커서 번호는 접속 안에서 1부터 늘어난다. 접속이 끝나면 모두 버린다.
 *
 * 한계 : 결과 전체가 서버 메모리에 한 번 올라온다. (6단계 실행기의 성질. docs/communication-design.md 5절)
 *
 * 관련 사양 : AGENTS.md 상세 8
 * 구현 단계 : 9단계 (9-4)
 */

import { DbError, ERROR_CODES } from "../common/errors.js";
import type { DataType } from "../types/dataType.js";
import type { SqlValue } from "../types/value.js";
import { MAX_OPEN_CURSORS } from "./protocol.js";

export interface OpenCursor {
  dispose?: () => void;
  readonly id: number;
  readonly types: readonly DataType[];
  readonly rows: readonly (readonly SqlValue[])[];
  /** 다음에 보낼 행 번호이다. */
  next: number;
}

export class CursorStore {
  private readonly cursors = new Map<number, OpenCursor>();
  private seq = 0;

  /** 열려 있는 커서 수이다. */
  get size(): number {
    return this.cursors.size;
  }

  /** 새 커서를 연다. 이미 16개가 열려 있으면 53400 이다. */
  open(types: readonly DataType[], rows: readonly (readonly SqlValue[])[], next: number, dispose?: () => void): number {
    if (this.cursors.size >= MAX_OPEN_CURSORS) {
      throw new DbError(
        "53400",
        ERROR_CODES.CONFIGURATION_LIMIT_EXCEEDED,
        `Too many open cursors: at most ${MAX_OPEN_CURSORS} per connection.`,
      );
    }
    this.seq++;
    this.cursors.set(this.seq, { id: this.seq, types, rows, next, dispose });
    return this.seq;
  }

  get(id: number): OpenCursor | undefined {
    return this.cursors.get(id);
  }

  /** 커서를 닫는다. 이미 없는 커서를 닫는 것은 오류가 아니다. */
  close(id: number): void {
    this.cursors.get(id)?.dispose?.();
    this.cursors.delete(id);
  }

  /** 모든 커서를 버린다. */
  clear(): void {
    for (const cursor of this.cursors.values()) cursor.dispose?.();
    this.cursors.clear();
  }
}
