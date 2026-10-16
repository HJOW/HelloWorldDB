/**
 * HelloWorldDB Node.js 드라이버의 공개 API.
 *
 *   import { connect } from "org.duckdns.hjow.helloworlddb.nodejsdriver";
 *
 *   const db = await connect({ user: "SYSTEM", password: "..." });
 *   const result = await db.query("SELECT 'Hello World'");
 *   console.log(result.rows[0][0]);
 *   await db.close();
 *
 * 접속 대상은 호스트와 포트 번호뿐이다. (둘 다 생략하면 127.0.0.1 의 7410) SID 나 데이터베이스 이름에 해당하는 항목은 없다.
 * 실행에 필요한 외부 패키지는 없고 Node.js 내장 모듈만 쓴다.
 *
 * 관련 사양 : AGENTS.md 구현 계획 12
 * 구현 단계 : 12-3
 */

export { Connection, Cursor, DEFAULT_HOST, DEFAULT_PORT, QueryResult, connect } from "./connection.js";
export type { CloseResult, ConnectOptions, QueryOptions, ServerInfo, SessionInfo } from "./connection.js";
export { Pool, createPool } from "./pool.js";
export type { PoolOptions, PoolStats } from "./pool.js";
export { DbError, ERROR_CODES } from "./errors.js";
export type { SourcePosition } from "./errors.js";
export type { SslOptions } from "./transport/tcpTransport.js";
export type { Column, Param, Row, Value } from "./values.js";
