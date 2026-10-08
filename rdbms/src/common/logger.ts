/**
 * 로그.
 *
 * 담당
 *  - 레벨(error, warn, info, debug)에 따른 로그 기록. 설정의 `log.level`, `log.dir` 을 따른다.
 *  - 데몬은 터미널과 분리되어 있으므로 로그 파일이 유일한 출력이다.
 *    포그라운드로 구동했을 때는 터미널에도 함께 출력한다.
 *  - 비밀번호가 로그에 남지 않게 한다. SQL 문장을 기록할 때 `IDENTIFIED BY` 뒤의 값도 가린다.
 *
 * 관련 사양 : AGENTS.md 상세 4, 7, 14-1
 * 구현 단계 : 1단계
 */

import fs from "node:fs";
import path from "node:path";
import type { LogLevel } from "../config/config.js";
import { LOG_FILE_NAME } from "./instance.js";

/** 로그 파일에 쓰는 한 줄의 형태이다. */
function formatLine(level: LogLevel, message: string): string {
  return `${new Date().toISOString()} [${level}] ${message}\n`;
}

/**
 * 로그에 남기면 안 되는 값을 가린다.
 * - `IDENTIFIED BY '비밀번호'` 뒤의 값을 `'***'` 로 바꾼다.
 * - `IDENTIFIED BY "비밀번호"` 형태도 함께 가린다.
 */
export function sanitizeLogMessage(message: string): string {
  return message
    .replace(/IDENTIFIED\s+BY\s+'(?:[^']|'')*'/gi, "IDENTIFIED BY '***'")
    .replace(/IDENTIFIED\s+BY\s+"(?:[^"]|"")*"/gi, 'IDENTIFIED BY "***"');
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export interface LoggerOptions {
  level: LogLevel;
  dir: string;
  /** 참이면 파일과 함께 터미널에도 출력한다. 포그라운드 구동용이다. */
  foreground: boolean;
}

export interface Logger {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
  /** 파일 스트림을 닫는다. 정상 종료 때 반드시 호출한다. */
  close(): Promise<void>;
}

/** 로그 디렉토리를 만들고 파일에 덧붙이는 로거를 만든다. */
export function createLogger(options: LoggerOptions): Logger {
  fs.mkdirSync(options.dir, { recursive: true });
  const filePath = path.join(options.dir, LOG_FILE_NAME);
  const stream = fs.createWriteStream(filePath, { flags: "a", encoding: "utf8" });

  const shouldWrite = (level: LogLevel): boolean => LEVEL_ORDER[level] <= LEVEL_ORDER[options.level];

  const write = (level: LogLevel, message: string): void => {
    if (!shouldWrite(level)) {
      return;
    }
    const line = formatLine(level, sanitizeLogMessage(message));
    stream.write(line);
    if (options.foreground) {
      if (level === "error" || level === "warn") {
        process.stderr.write(line);
      } else {
        process.stdout.write(line);
      }
    }
  };

  return {
    error: (message: string): void => {
      write("error", message);
    },
    warn: (message: string): void => {
      write("warn", message);
    },
    info: (message: string): void => {
      write("info", message);
    },
    debug: (message: string): void => {
      write("debug", message);
    },
    close: (): Promise<void> =>
      new Promise<void>((resolve) => {
        stream.end(() => {
          resolve();
        });
      }),
  };
}
