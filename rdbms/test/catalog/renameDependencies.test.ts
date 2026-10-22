/**
 * 테이블 이름 변경과 의존 뷰의 시험 (2026-10-22 점검 R-3).
 * 의존하는 뷰가 있는 테이블은 이름을 바꿀 수 없고(DROP TABLE RESTRICT 와 같은 기준), 뷰를 지운 뒤에는 바꿀 수 있다.
 * 관련 사양 : AGENTS.md 상세 1-3, 3, 11
 * 구현 단계 : 5단계(점검 보완)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { openTestDb, selectStrings, setupApp, state, tempDir } from "../exec/helpers.js";

test("뷰가 의존하는 테이블은 이름을 바꿀 수 없고, 뷰를 지운 뒤에만 바꾼다 (R-3)", (t) => {
  const dir = tempDir(t);
  let db = openTestDb(dir);
  let session = db.createSession({});
  try {
    session.execute("CREATE TABLESPACE APP");
    session.execute("USE APP");
    session.execute("CREATE TABLE P (ID INTEGER PRIMARY KEY, V VARCHAR(10))");
    session.execute("INSERT INTO P VALUES (1, 'a')");
    session.execute("CREATE VIEW PV AS SELECT ID, V FROM P WHERE ID > 0");
    // 중첩 뷰와 컬럼 별칭을 함께 둔다.
    session.execute("CREATE VIEW PV2 (K) AS SELECT ID FROM PV");

    // 직접 의존하는 뷰가 있으면 이름을 바꾸지 않는다. 뷰는 옛 이름이 아니라 그대로 동작해야 한다.
    assert.throws(() => session.execute("ALTER TABLE P RENAME TO P2"), state("55006"));
    assert.deepEqual(selectStrings(session.execute("SELECT * FROM PV2")).rows, [["1"]]);
    assert.deepEqual(selectStrings(session.execute("SELECT * FROM PV")).rows, [["1", "a"]]);

    // 재구동 뒤에도 같은 상태이며 여전히 이름을 바꿀 수 없다.
    db.close();
    db = openTestDb(dir);
    session = db.createSession({ tablespace: "APP" });
    assert.deepEqual(selectStrings(session.execute("SELECT * FROM PV2")).rows, [["1"]]);
    assert.throws(() => session.execute("ALTER TABLE P RENAME TO P2"), state("55006"));

    // 뷰를 모두 지운 뒤에는 이름을 바꿀 수 있고, 옛 이름은 다시 쓸 수 있다.
    session.execute("DROP VIEW PV2");
    assert.throws(() => session.execute("ALTER TABLE P RENAME TO P2"), state("55006"));
    session.execute("DROP VIEW PV");
    session.execute("ALTER TABLE P RENAME TO P2");
    assert.deepEqual(selectStrings(session.execute("SELECT ID, V FROM P2")).rows, [["1", "a"]]);
    session.execute("CREATE TABLE P (ID INTEGER)");
    assert.deepEqual(selectStrings(session.execute("SELECT COUNT(*) FROM P")).rows, [["0"]]);

    // 새 이름으로 만든 뷰는 DROP TABLE RESTRICT 가 막고, CASCADE 는 뷰까지 지운다.
    session.execute("CREATE VIEW P2V AS SELECT ID FROM P2");
    assert.throws(() => session.execute("DROP TABLE P2"), state("55006"));
    session.execute("DROP TABLE P2 CASCADE");
    assert.throws(() => session.execute("SELECT * FROM P2V"), state("42P01"));
  }
  finally {
    db.close();
  }
});
