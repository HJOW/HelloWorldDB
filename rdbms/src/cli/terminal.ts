/**
 * 터미널 입력.
 *
 * 담당
 *  - 한 줄 질문(사용자명) : `askLine`
 *  - 화면에 보이지 않는 입력(비밀번호) : `askSecret`. 터미널을 원시 모드로 바꾸어 글자를 하나씩 받고 화면에 되울리지 않는다.
 *    백스페이스로 지울 수 있고 Ctrl-C 로 취소한다. 화살표 같은 이스케이프 열은 버린다.
 *  - 대화형 모드의 줄 입력 : `LineSource`. 줄을 하나씩 받고 Ctrl-C(`interrupt`)와 입력 끝(`eof`)을 구분해서 알려 준다.
 *    `node:readline` 의 줄 편집과 입력 이력(위/아래 화살표)을 쓴다.
 *  - 표준 입력 전체 읽기(`readAllStdin`) : 스크립트 모드가 파이프로 받은 입력을 읽는다.
 *
 * 입력과 출력 스트림을 인자로 받으므로 sqlShell.ts 의 시험은 이 모듈 대신 가짜 입력을 끼워 넣는다.
 * 이 모듈의 터미널 동작은 실제 터미널이 있어야 확인할 수 있어 자동 시험에서는 가짜 스트림으로 논리만 본다.
 *
 * 관련 사양 : AGENTS.md 상세 14-2
 * 구현 단계 : 10단계
 */

import readline from "node:readline";

/** 줄 입력의 결과이다. */
export type LineRead = { kind: "line"; text: string } | { kind: "eof" } | { kind: "interrupt" };

/** 대화형 모드가 줄을 받아 가는 곳이다. */
export interface LineSource {
  /** 프롬프트를 보여 주고 줄 하나를 받는다. */
  readLine(prompt: string): Promise<LineRead>;
  /** 입력을 닫는다. */
  close(): void;
}

/** 쓸 수 있는 출력이다. */
export interface TextOutput {
  write(text: string): unknown;
}

/** 터미널로 쓰는 입력 스트림이 갖춰야 하는 것이다. */
export interface TerminalInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
}

/** 한 줄을 묻는다. Ctrl-C 나 입력 끝이면 null 이다. */
export function askLine(prompt: string, input: TerminalInput, output: TextOutput): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output: output as NodeJS.WritableStream, terminal: input.isTTY === true });
    let answered = false;
    rl.question(prompt, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
    rl.once("SIGINT", () => rl.close());
    rl.once("close", () => {
      if (!answered) {
        output.write("\n");
        resolve(null);
      }
    });
  });
}

/**
 * 화면에 보이지 않게 한 줄을 묻는다. Ctrl-C 나 (아무것도 입력하지 않은 상태의) Ctrl-D 면 null 이다.
 * 터미널이 원시 모드를 지원하지 않으면 보이는 채로 받는 것은 안전하지 않으므로 오류를 던진다.
 */
export function askSecret(prompt: string, input: TerminalInput, output: TextOutput): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (typeof input.setRawMode !== "function") {
      reject(new Error("The terminal does not support hidden input."));
      return;
    }
    output.write(prompt);
    const wasRaw = input.isRaw === true;
    const value: string[] = [];
    let skipEscape = false;

    const finish = (result: string | null): void => {
      input.removeListener("data", onData);
      try {
        input.setRawMode?.(wasRaw);
      } finally {
        (input as { pause?: () => void }).pause?.();
      }
      output.write("\n");
      resolve(result);
    };

    const onData = (chunk: string | Buffer): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const character of text) {
        if (skipEscape) {
          // ESC 뒤의 `[` 나 `O` 로 시작하는 열은 마지막 글자(@ ~ ~)까지 버린다.
          if (character >= "@" && character <= "~" && character !== "[" && character !== "O") skipEscape = false;
          continue;
        }
        if (character === "\r" || character === "\n") return finish(value.join(""));
        if (character === "\u0003") return finish(null); // Ctrl-C
        if (character === "\u0004") {
          // Ctrl-D : 비어 있으면 취소, 아니면 무시한다.
          if (value.length === 0) return finish(null);
          continue;
        }
        if (character === "\u001b") {
          skipEscape = true;
          continue;
        }
        if (character === "\u007f" || character === "\b") {
          value.pop();
          continue;
        }
        if (character < " ") continue;
        value.push(character);
      }
    };

    (input as { setEncoding?: (encoding: string) => void }).setEncoding?.("utf8");
    input.setRawMode(true);
    (input as { resume?: () => void }).resume?.();
    input.on("data", onData);
  });
}

/** 터미널에서 줄을 받는 `LineSource` 이다. 입력 이력은 이 프로세스가 사는 동안만 둔다. */
export function createReadlineSource(input: TerminalInput, output: TextOutput): LineSource {
  const rl = readline.createInterface({ input, output: output as NodeJS.WritableStream, terminal: input.isTTY === true, historySize: 200 });
  const queue: LineRead[] = [];
  let waiter: ((read: LineRead) => void) | null = null;
  let closed = false;

  const deliver = (read: LineRead): void => {
    if (waiter !== null) {
      const resolve = waiter;
      waiter = null;
      resolve(read);
    } else {
      queue.push(read);
    }
  };
  rl.on("line", (text) => deliver({ kind: "line", text }));
  rl.on("SIGINT", () => deliver({ kind: "interrupt" }));
  rl.on("close", () => {
    closed = true;
    deliver({ kind: "eof" });
  });

  return {
    readLine(prompt: string): Promise<LineRead> {
      const next = queue.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (closed) return Promise.resolve({ kind: "eof" });
      rl.setPrompt(prompt);
      rl.prompt();
      return new Promise<LineRead>((resolve) => {
        waiter = resolve;
      });
    },
    close(): void {
      if (!closed) rl.close();
    },
  };
}

/** 표준 입력을 끝까지 읽어 UTF-8 로 해석한다. 올바르지 않은 UTF-8 이면 오류를 던진다. (상세 2) */
export async function readAllStdin(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer));
  }
  return decodeUtf8Strict(Buffer.concat(chunks));
}

/** 올바른 UTF-8 만 받는다. 맨 앞의 BOM 은 뗀다. */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
