/**
 * 터미널 입력 도우미 테스트 (10단계). 가짜 터미널 스트림으로 논리를 본다.
 *  - 비밀번호 입력은 화면에 되울리지 않고, 백스페이스·Ctrl-C·Ctrl-D·화살표 같은 이스케이프 열을 처리하며, 끝나면 원시 모드를 되돌린다.
 *  - 줄 입력은 줄과 입력 끝을 구분해서 내준다.
 *  - 표준 입력 전체 읽기는 올바르지 않은 UTF-8 을 오류로 처리하고 BOM 을 뗀다.
 * 실제 터미널(TTY)에서의 동작은 자동으로 확인할 수 없어 PROGRESS.md 의 수동 확인 기록을 따른다.
 * 관련 사양 : AGENTS.md 상세 2, 14-2
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { askLine, askSecret, createReadlineSource, decodeUtf8Strict, readAllStdin } from "../../src/cli/terminal.js";
import type { TerminalInput } from "../../src/cli/terminal.js";

/** 원시 모드를 지원하는 가짜 터미널 입력이다. */
class FakeTty extends PassThrough {
  isTTY = true;
  isRaw = false;
  readonly rawCalls: boolean[] = [];
  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawCalls.push(mode);
    return this;
  }
}

function sink(): { write(text: string): void; text(): string } {
  const chunks: string[] = [];
  return { write: (text) => void chunks.push(text), text: () => chunks.join("") };
}

/** 이벤트가 처리되도록 한 번 양보한다. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("비밀번호는 화면에 되울리지 않고 Enter 로 끝낸다", async () => {
  const input = new FakeTty();
  const output = sink();
  const answer = askSecret("Password: ", input as unknown as TerminalInput, output);
  await tick();
  input.write("s3cret");
  await tick();
  input.write("\r");
  assert.equal(await answer, "s3cret");
  assert.equal(output.text(), "Password: \n", "입력한 글자가 화면에 나가지 않는다");
  assert.deepEqual(input.rawCalls, [true, false], "원시 모드를 켰다가 되돌린다");
});

test("비밀번호 프롬프트를 출력하기 전에 숨김 모드와 입력 처리가 준비된다", async () => {
  const input = new FakeTty();
  const output = sink();
  const answer = askSecret("Password: ", input as unknown as TerminalInput, {
    write(text: string): void {
      output.write(text);
      if (text === "Password: ") {
        assert.equal(input.isRaw, true, "프롬프트가 보일 때 터미널 되울림이 이미 꺼져 있어야 한다");
        input.emit("data", "immediate-secret\r");
      }
    },
  });
  assert.equal(await answer, "immediate-secret");
  assert.equal(output.text(), "Password: \n");
  assert.deepEqual(input.rawCalls, [true, false]);
});

test("글자를 한 번에 붙여 넣거나 한 글자씩 받아도 같다", async () => {
  for (const chunks of [["abc\r"], ["a", "b", "c", "\r"], ["ab", "c\n"]]) {
    const input = new FakeTty();
    const answer = askSecret("> ", input as unknown as TerminalInput, sink());
    await tick();
    for (const chunk of chunks) {
      input.write(chunk);
      await tick();
    }
    assert.equal(await answer, "abc", JSON.stringify(chunks));
  }
});

test("백스페이스는 한 글자(코드 포인트)를 지운다", async () => {
  const input = new FakeTty();
  const answer = askSecret("> ", input as unknown as TerminalInput, sink());
  await tick();
  input.write("ab\u007fc\b\b한😀\u007f글\r");
  assert.equal(await answer, "한글");
});

test("비어 있을 때의 백스페이스는 아무 일도 없다", async () => {
  const input = new FakeTty();
  const answer = askSecret("> ", input as unknown as TerminalInput, sink());
  await tick();
  input.write("\u007f\u007fx\r");
  assert.equal(await answer, "x");
});

test("화살표 같은 이스케이프 열은 버린다", async () => {
  const input = new FakeTty();
  const answer = askSecret("> ", input as unknown as TerminalInput, sink());
  await tick();
  input.write("a\u001b[Ab\u001b[1;5Cc\u001bOPd\r");
  assert.equal(await answer, "abcd");
});

test("이스케이프 열이 두 조각으로 나뉘어 와도 버린다", async () => {
  const input = new FakeTty();
  const answer = askSecret("> ", input as unknown as TerminalInput, sink());
  await tick();
  input.write("a\u001b");
  await tick();
  input.write("[");
  await tick();
  input.write("Bz\r");
  assert.equal(await answer, "az");
});

test("Ctrl-C 는 취소(null)이고 원시 모드를 되돌린다", async () => {
  const input = new FakeTty();
  const answer = askSecret("> ", input as unknown as TerminalInput, sink());
  await tick();
  input.write("abc\u0003");
  assert.equal(await answer, null);
  assert.deepEqual(input.rawCalls, [true, false]);
});

test("Ctrl-D 는 비어 있으면 취소, 글자가 있으면 무시한다", async () => {
  const empty = new FakeTty();
  const first = askSecret("> ", empty as unknown as TerminalInput, sink());
  await tick();
  empty.write("\u0004");
  assert.equal(await first, null);

  const typed = new FakeTty();
  const second = askSecret("> ", typed as unknown as TerminalInput, sink());
  await tick();
  typed.write("ab\u0004c\r");
  assert.equal(await second, "abc");
});

test("제어 문자는 비밀번호에 들어가지 않고 빈 비밀번호도 받는다", async () => {
  const input = new FakeTty();
  const answer = askSecret("> ", input as unknown as TerminalInput, sink());
  await tick();
  input.write("\u0001\u0002\t\r");
  assert.equal(await answer, "");
});

test("Enter 뒤에 온 글자는 읽지 않는다", async () => {
  const input = new FakeTty();
  const answer = askSecret("> ", input as unknown as TerminalInput, sink());
  await tick();
  input.write("pw\rleftover");
  assert.equal(await answer, "pw");
});

test("원시 모드를 지원하지 않는 터미널이면 보이는 채로 받지 않고 오류를 던진다", async () => {
  const input = new PassThrough();
  const output = sink();
  await assert.rejects(askSecret("Password: ", input as unknown as TerminalInput, output), /does not support hidden input/);
  assert.equal(output.text(), "", "프롬프트도 내지 않는다");
});

test("한 줄 질문은 답을 돌려주고, 입력이 끝나면 null 이다", async () => {
  const answered = new PassThrough();
  const text = sink();
  const answer = askLine("Username: ", answered as unknown as TerminalInput, text);
  answered.write("scott\n");
  assert.equal(await answer, "scott");
  assert.match(text.text(), /Username: /);

  const closed = new PassThrough();
  const none = askLine("Username: ", closed as unknown as TerminalInput, sink());
  closed.end();
  assert.equal(await none, null);
});

test("줄 입력은 줄을 하나씩 내주고 입력이 끝나면 eof 이다", async () => {
  const input = new PassThrough();
  const output = sink();
  const source = createReadlineSource(input as unknown as TerminalInput, output);
  // 읽기를 먼저 걸어 두고 줄을 넣는다. (이미 들어와 있던 줄은 프롬프트 없이 바로 내준다)
  const first = source.readLine("hwdb> ");
  input.write("first\n");
  assert.deepEqual(await first, { kind: "line", text: "first" });
  const second = source.readLine("    -> ");
  input.write("second\n");
  assert.deepEqual(await second, { kind: "line", text: "second" });
  input.end();
  assert.deepEqual(await source.readLine("hwdb> "), { kind: "eof" });
  assert.deepEqual(await source.readLine("hwdb> "), { kind: "eof" }, "끝난 뒤에도 eof 이다");
  source.close();
  source.close();
  assert.match(output.text(), /hwdb> /, "프롬프트를 낸다");
  assert.match(output.text(), /    -> /, "이어지는 줄의 프롬프트를 낸다");
});

test("줄 입력은 미리 들어온 여러 줄을 순서대로 내준다 (붙여 넣기)", async () => {
  const input = new PassThrough();
  const source = createReadlineSource(input as unknown as TerminalInput, sink());
  input.write("a\nb\nc\n");
  input.end();
  const lines: string[] = [];
  for (;;) {
    const read = await source.readLine("> ");
    if (read.kind !== "line") break;
    lines.push(read.text);
  }
  assert.deepEqual(lines, ["a", "b", "c"]);
});

test("표준 입력 전체를 UTF-8 로 읽는다", async () => {
  const input = new PassThrough();
  input.write(Buffer.from("SELECT '한", "utf8").subarray(0, 10));
  input.write(Buffer.from("SELECT '한", "utf8").subarray(10));
  input.end("글';");
  assert.equal(await readAllStdin(input), "SELECT '한글';");
});

test("올바르지 않은 UTF-8 은 오류이고 맨 앞의 BOM 은 뗀다", async () => {
  const bad = new PassThrough();
  bad.end(Buffer.from([0x53, 0xe9, 0x27]));
  await assert.rejects(readAllStdin(bad));
  assert.throws(() => decodeUtf8Strict(Buffer.from([0xc3, 0x28])));
  assert.equal(decodeUtf8Strict(Buffer.from([0xef, 0xbb, 0xbf, 0x41])), "A");
  assert.equal(decodeUtf8Strict(Buffer.alloc(0)), "");
});
