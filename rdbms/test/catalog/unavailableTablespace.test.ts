/** 카탈로그 해석에 실패한 테이블스페이스의 자원 정리를 실제 파일로 검증한다. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { TablespaceManager } from "../../src/catalog/tablespaceManager.js";
import { openTablespace } from "../../src/storage/format/format.js";
import { PageFile } from "../../src/storage/pageFile.js";
import { tempDir } from "../exec/helpers.js";

test("카탈로그 JSON이 손상된 일반 테이블스페이스는 파일을 닫고 나머지만 구동한다", (t) => {
  const dir = tempDir(t);
  const initial = TablespaceManager.open(dir);
  initial.createTablespace("APP", null, null);
  initial.close();
  const damaged = openTablespace(path.join(dir, "APP.hwdb"));
  const batch = damaged.begin();
  batch.setCatalog(Buffer.from("{", "utf8"));
  batch.commit();
  damaged.close();

  // 실제로 연 파일을 추적한다. 시험이 실패하더라도 파일과 정적 메서드를 반드시 복구한다.
  const openFile = PageFile.open;
  let opened: PageFile | undefined;
  let manager: TablespaceManager | undefined;
  PageFile.open = (filePath) => {
    const file = openFile(filePath);
    if (filePath === path.join(dir, "APP.hwdb")) opened = file;
    return file;
  };
  try {
    manager = TablespaceManager.open(dir, { onWarning: () => {} });
    assert.equal(manager.listStatus().find((entry) => entry.name === "APP")?.available, false);
    assert.equal(manager.listStatus().find((entry) => entry.name === "SYSTEM")?.available, true);
    assert.ok(opened);
    assert.throws(() => opened!.readPage(0), /Data file is closed/);
  } finally {
    PageFile.open = openFile;
    manager?.close();
    opened?.close();
  }
});
