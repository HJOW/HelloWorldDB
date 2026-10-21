// WO-0의 계약 누락과 SDK 불일치 검사이다. 드라이버 실행 시험은 아니다.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const project = fileURLToPath(new URL('../', import.meta.url));
const read = relative => readFileSync(path.join(project, relative), 'utf8');
const api = read('docs/api-support.md');
const verification = read('docs/verification.md');
const types = read('docs/type-mapping.md');
const server = read('docs/server-dependencies.md');
const report = JSON.parse(read('build/wo0/environment.json'));
const functions = [...api.matchAll(/^\| (SQL\w+) \| (B(?:\/W)?|DM) \| (.+)$/gm)]
  .map(([, name, exports, rest]) => ({ name, exports, rest }));
const planned = functions.filter(row => row.exports !== 'DM');
const sdk = report.sdks.find(item => item.headers.every(header => header.exists));
assert.ok(sdk, '현재 PC의 Windows SDK를 다시 조회해야 한다.');
const sdkText = sdk.headers.map(header => readFileSync(header.path, 'utf8')).join('\n');
const testIds = new Set([...verification.matchAll(/^\| (T-[A-Z]+) \|/gm)].map(match => match[1]));

test('01 현재 호스트의 조회 결과만 사용한다', () => {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.computer.toLowerCase(), hostname().toLowerCase(), '다른 PC의 환경 기록을 재사용하면 안 된다.');
  assert.ok(!Number.isNaN(Date.parse(report.capturedAt)));
  assert.equal(process.platform, 'win32');
});

test('02 x86/x64 MSVC·SDK 도구와 라이브러리가 실제로 존재한다', () => {
  for (const arch of ['x86', 'x64']) {
    const found = report.visualStudio.flatMap(vs => vs.toolchains)
      .flatMap(toolchain => toolchain.architectures).find(item => item.target === arch);
    assert.ok(found, `${arch} 도구 미설치`);
    for (const name of ['compiler', 'linker', 'dumpbin', 'crt']) {
      assert.equal(found[name].exists, true, found[name].path);
      assert.ok(existsSync(found[name].path), found[name].path);
    }
    const libraries = sdk.libraries.filter(item => item.path.includes(`\\${arch}\\`));
    assert.equal(libraries.length, 8);
    assert.ok(libraries.every(item => item.exists && existsSync(item.path)));
  }
  for (const toolName of ['cmake', 'ctest', 'node']) {
    const tool = report.tools.find(item => item.name === toolName);
    assert.equal(tool?.exists, true, `${toolName} 미설치`);
    assert.equal(tool.exitCode, 0);
    assert.ok(tool.output.length > 0);
  }
});

test('03 두 Driver Manager/관리자의 PE 비트 수가 경로와 맞는다', () => {
  assert.equal(report.managers.length, 4);
  for (const item of report.managers) {
    assert.equal(item.exists, true);
    assert.equal(item.machine, item.path.includes('SysWOW64') ? '0x014C' : '0x8664');
  }
});

test('04 문서와 스크립트는 올바른 UTF-8이고 로컬 링크가 유효하다', () => {
  const files = [];
  const visit = dir => {
    for (const name of readdirSync(dir)) {
      if (['build', 'dist'].includes(name)) continue;
      const target = path.join(dir, name);
      if (statSync(target).isDirectory()) visit(target);
      else files.push(target);
    }
  };
  visit(project);
  for (const file of files) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
    if (!file.endsWith('.md')) continue;
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1];
      if (/^https?:|^#/.test(link)) continue;
      assert.ok(existsSync(path.resolve(path.dirname(file), link.split('#')[0])), `${file}: ${link}`);
    }
  }
});

test('05 Core 함수와 Manager 담당 함수가 빠짐없이 분리된다', () => {
  // 공식 Core 함수 목록의 독립 검토 기준이다. 지원표에서 자동 생성하지 않는다.
  const core = `SQLAllocHandle SQLBindCol SQLBindParameter SQLCancel SQLCloseCursor
    SQLColAttribute SQLColumns SQLConnect SQLCopyDesc SQLDataSources SQLDescribeCol
    SQLDisconnect SQLDriverConnect SQLDrivers SQLEndTran SQLExecDirect SQLExecute
    SQLFetch SQLFetchScroll SQLFreeHandle SQLFreeStmt SQLGetConnectAttr SQLGetCursorName
    SQLGetData SQLGetDescField SQLGetDescRec SQLGetDiagField SQLGetDiagRec SQLGetEnvAttr
    SQLGetFunctions SQLGetInfo SQLGetStmtAttr SQLGetTypeInfo SQLNativeSql SQLNumParams
    SQLNumResultCols SQLParamData SQLPrepare SQLPutData SQLRowCount SQLSetConnectAttr
    SQLSetCursorName SQLSetDescField SQLSetDescRec SQLSetEnvAttr SQLSetStmtAttr
    SQLSpecialColumns SQLStatistics SQLTables`.split(/\s+/).filter(Boolean);
  const names = new Set(functions.map(row => row.name));
  assert.equal(names.size, functions.length, '함수 행 중복');
  for (const name of core) assert.ok(names.has(name), `Core 누락: ${name}`);
  for (const name of ['SQLDrivers', 'SQLDataSources']) {
    assert.equal(functions.find(row => row.name === name)?.exports, 'DM');
  }
});

test('06 계획한 함수·W export와 속성·descriptor 상수가 실제 SDK에 있다', () => {
  for (const row of planned) {
    assert.match(sdkText, new RegExp(`\\b${row.name}\\s*\\(`), row.name);
    if (row.exports === 'B/W') assert.match(sdkText, new RegExp(`\\b${row.name}W\\s*\\(`), `${row.name}W`);
  }
  const constants = new Set(api.match(/\bSQL_(?:ATTR|DESC)_[A-Z0-9_]+\b/g));
  for (const name of constants) assert.ok(sdkText.includes(name), `SDK에 없는 상수: ${name}`);
});

test('07 함수별 단계·상태/오류·시험 ID의 연결이 있다', () => {
  assert.ok(planned.length >= 50);
  for (const row of planned) {
    assert.match(row.rest, /WO-\d+/, row.name);
    const cells = row.rest.split('|').map(cell => cell.trim());
    assert.ok(cells[1]?.length > 0, `${row.name} 호출 형태 누락`);
    assert.ok(cells[2]?.length > 0, `${row.name} 진단 누락`);
    assert.ok([...row.rest.matchAll(/T-[A-Z]+/g)].length > 0, row.name);
  }
  for (const doc of [api, types, server]) {
    for (const [id] of doc.matchAll(/\bT-[A-Z]+\b/g)) assert.ok(testIds.has(id), `미정의 시험: ${id}`);
  }
});

test('08 필수 속성·descriptor의 배열/offset/포인터 계약이 있다', () => {
  const required = `SQL_ATTR_ODBC_VERSION SQL_ATTR_RESET_CONNECTION SQL_ATTR_ASYNC_DBC_FUNCTIONS_ENABLE
    SQL_ATTR_APP_ROW_DESC SQL_ATTR_APP_PARAM_DESC SQL_ATTR_IMP_ROW_DESC SQL_ATTR_IMP_PARAM_DESC
    SQL_ATTR_ROW_ARRAY_SIZE SQL_ATTR_ROW_BIND_TYPE SQL_ATTR_ROW_BIND_OFFSET_PTR
    SQL_ATTR_ROW_STATUS_PTR SQL_ATTR_ROWS_FETCHED_PTR SQL_ATTR_PARAMSET_SIZE
    SQL_ATTR_PARAM_BIND_TYPE SQL_ATTR_PARAM_BIND_OFFSET_PTR SQL_ATTR_PARAM_STATUS_PTR
    SQL_ATTR_PARAMS_PROCESSED_PTR SQL_ATTR_PARAM_OPERATION_PTR SQL_DESC_ARRAY_SIZE
    SQL_DESC_ARRAY_STATUS_PTR SQL_DESC_BIND_OFFSET_PTR SQL_DESC_BIND_TYPE SQL_DESC_COUNT
    SQL_DESC_ROWS_PROCESSED_PTR SQL_DESC_DATA_PTR SQL_DESC_INDICATOR_PTR
    SQL_DESC_OCTET_LENGTH_PTR SQL_DESC_PRECISION SQL_DESC_SCALE SQL_DESC_PARAMETER_TYPE`;
  for (const name of required.split(/\s+/).filter(Boolean)) assert.ok(api.includes(name), name);
  const fields = new Set(api.match(/\bSQL_DESC_[A-Z0-9_]+\b/g));
  assert.ok(fields.size >= 40, 'descriptor 필드 검토가 불완전하다.');
});

test('09 서버가 선언한 모든 wire 타입과 확장 capability를 다룬다', () => {
  const source = readFileSync(path.join(project, '../rdbms/src/net/protocol.ts'), 'utf8');
  const definitions = readFileSync(path.join(project, '../rdbms/src/types/dataType.ts'), 'utf8');
  const names = new Set([...definitions.matchAll(/^  name: ([^;\n]+);/gm)]
    .flatMap(match => [...match[1].matchAll(/"([A-Z ]+)"/g)].map(item => item[1])));
  assert.ok(names.size >= 17, '서버 DataType.name 정의 변경을 검토해야 한다.');
  const mapped = new Set([...types.matchAll(/^\| ([A-Z ]+) \|/gm)].map(match => match[1]));
  for (const name of names) assert.ok(mapped.has(name), `대응표 행 누락: ${name}`);
  const capabilities = source.match(/export const CAPABILITIES = \[([^\]]+)\]/);
  assert.ok(capabilities);
  for (const [, name] of capabilities[1].matchAll(/"([^"]+)"/g)) assert.ok(server.includes(name), name);
  for (const request of ['prepare', 'describe', 'executePrepared', 'closePrepared', 'cancel']) {
    assert.ok(server.includes(request), request);
  }
});

test('10 API마다 W 길이를 구분하고 호스트별 설치 증거 규칙을 유지한다', () => {
  assert.match(api, /SQLGetInfo, SQLColAttribute.*바이트/);
  assert.match(api, /SQLConnect, DriverConnect, ExecDirect, Prepare, NativeSql.*UTF-16 코드 단위/);
  assert.match(api, /SQLGetData\/SQLBindCol\/SQLBindParameter\/SQLPutData.*바이트/);
  const environment = read('docs/environment.md');
  assert.ok(environment.includes('VM-W11-Codex'));
  assert.ok(environment.includes('다른 PC'));
  assert.ok(environment.includes('호스트명'));
  assert.ok(environment.includes('미설치'));
  assert.ok(read('scripts/inspect-environment.ps1').includes('computer = $env:COMPUTERNAME'));
});
