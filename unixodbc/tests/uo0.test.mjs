/**
 * UO-0 환경·계약 시험이다. **드라이버 실행 시험이 아니다.**
 *
 * 확인하는 것:
 *  - 이 호스트에서 실제로 조회한 환경 JSON 과 문서가 일치하는가
 *  - unixODBC 헤더·SQLWCHAR ABI 가 이 프로젝트의 전제와 맞는가
 *  - API 표가 ODBC Core 함수를 빠짐없이 담고, 단계·시험 ID와 연결되는가
 *  - 서버 타입·기능(capability)이 대응표에 모두 있는가
 *  - 문서가 올바른 UTF-8 이고 로컬 링크가 유효한가
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const read = relative => readFileSync(path.join(project, relative), 'utf8');
const envPath = process.env.HWDB_ODBC_ENVIRONMENT ?? path.join(project, 'build', 'dev', 'uo0', 'environment.json');
const env = JSON.parse(readFileSync(envPath, 'utf8'));

const api = read('docs/api-support.md');
const verification = read('docs/verification.md');
const types = read('docs/type-mapping.md');
const server = read('docs/server-dependencies.md');
const design = read('docs/design.md');
const progress = read('PROGRESS.md');
const readme = read('README.md');

const headerText = ['sql.h', 'sqlext.h', 'sqltypes.h', 'sqlucode.h']
  .map(name => path.join(env.unixodbc.headerDir, name))
  .filter(candidate => existsSync(candidate))
  .map(candidate => readFileSync(candidate, 'utf8'))
  .join('\n');

const functions = [...api.matchAll(/^\| (SQL\w+) \| (B(?:\/W)?|DM) \| (.+)$/gm)].map(([, name, exports, rest]) => ({
  name,
  exports,
  rest,
}));

test('01 현재 호스트의 조회 결과만 사용하고 필수 도구가 동작한다', () => {
  assert.equal(env.schemaVersion, 1);
  assert.ok(!Number.isNaN(Date.parse(env.capturedAt)));
  assert.equal(env.host.computer.toLowerCase(), hostname().toLowerCase(), '다른 PC의 환경 기록을 재사용하면 안 된다.');
  assert.ok(['linux', 'darwin'].includes(env.host.platform));
  for (const name of ['cmake', 'ctest', 'make', 'cc', 'c++', 'node', 'pkg-config']) {
    const tool = env.tools.find(item => item.name === name);
    assert.ok(tool?.exists, `${name} 미설치`);
    assert.equal(tool.exitCode, 0, `${name} 실행 실패`);
  }
  assert.equal(env.abi.pointerSize, process.arch.includes('64') ? 8 : 4);
  assert.match(env.project.version, /^\d+\.\d+\.\d+$/);
});

test('02 unixODBC 헤더·라이브러리와 ABI 전제가 맞는다', () => {
  assert.ok(env.unixodbc.headerDir, 'unixODBC 헤더를 찾지 못했다.');
  for (const name of ['sql.h', 'sqlext.h', 'sqltypes.h', 'sqlucode.h']) {
    assert.ok(existsSync(path.join(env.unixodbc.headerDir, name)), name);
  }
  assert.ok(env.unixodbc.libraries.length > 0, 'libodbc 를 찾지 못했다.');
  assert.match(env.unixodbc.pkgConfigVersion ?? '', /^2\./);
  assert.equal(env.abi.odbc.specMajor, 3);
  assert.match(env.abi.odbc.specString, /^03\./);
  assert.match(env.abi.odbc.odbcver, /^0x0?380$/);
  assert.ok([2, 4].includes(env.abi.odbc.sqlwcharSize));
  assert.equal(env.abi.odbc.sqlwcharIsUtf16, env.abi.odbc.sqlwcharSize === 2);
  assert.ok(Number(env.abi.compiler.cplusplus) >= 201703);
});

test('03 문서는 올바른 UTF-8 이고 로컬 링크가 유효하다', () => {
  const files = [];
  const visit = directory => {
    for (const name of readdirSync(directory)) {
      if (['build', 'dist', '.deps', '.git'].includes(name)) continue;
      const target = path.join(directory, name);
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
      if (/^https?:|^#|^mailto:/.test(link)) continue;
      const target = path.resolve(path.dirname(file), link.split('#')[0]);
      assert.ok(existsSync(target), `${file}: 깨진 링크 ${link}`);
    }
  }
});

test('04 API 표가 ODBC Core 함수를 빠짐없이 단계·시험과 연결한다', () => {
  // 공식 Core 목록의 독립 사본이다. API 표에서 자동 생성하지 않는다.
  const core = `SQLAllocHandle SQLBindCol SQLBindParameter SQLCancel SQLCloseCursor SQLColAttribute
    SQLColumns SQLConnect SQLCopyDesc SQLDataSources SQLDescribeCol SQLDisconnect SQLDriverConnect
    SQLDrivers SQLEndTran SQLExecDirect SQLExecute SQLFetch SQLFetchScroll SQLFreeHandle SQLFreeStmt
    SQLGetConnectAttr SQLGetCursorName SQLGetData SQLGetDescField SQLGetDescRec SQLGetDiagField
    SQLGetDiagRec SQLGetEnvAttr SQLGetFunctions SQLGetInfo SQLGetStmtAttr SQLGetTypeInfo SQLNativeSql
    SQLNumParams SQLNumResultCols SQLParamData SQLPrepare SQLPutData SQLRowCount SQLSetConnectAttr
    SQLSetCursorName SQLSetDescField SQLSetDescRec SQLSetEnvAttr SQLSetStmtAttr SQLSpecialColumns
    SQLStatistics SQLTables`.split(/\s+/).filter(Boolean);

  const names = new Set(functions.map(row => row.name));
  assert.equal(names.size, functions.length, 'API 표에 중복 행이 있다.');
  for (const name of core) assert.ok(names.has(name), `Core 누락: ${name}`);
  for (const name of ['SQLDrivers', 'SQLDataSources']) {
    assert.equal(functions.find(row => row.name === name)?.exports, 'DM');
  }

  for (const row of functions.filter(item => item.exports !== 'DM')) {
    assert.match(row.rest, /UO-\d+/, `${row.name} 단계 누락`);
    assert.match(row.rest, /T-[A-Z]+/, `${row.name} 시험 ID 누락`);
    const cells = row.rest.split('|').map(cell => cell.trim());
    assert.ok(cells.length >= 5, `${row.name} 열 누락`);
    assert.ok(cells[0].includes('UO-'), `${row.name} 단계 열`);
    assert.ok(cells[1].length > 0, `${row.name} 호출 형태 열`);
    assert.ok(cells[2].length > 0, `${row.name} 진단 열`);
    assert.match(cells[3], /T-[A-Z]+/, `${row.name} 시험 열`);
    assert.match(headerText, new RegExp(`\\b${row.name}\\s*\\(`), `${row.name} 헤더 원형`);
    if (row.exports === 'B/W') {
      assert.match(headerText, new RegExp(`\\b${row.name}W\\s*\\(`), `${row.name}W 헤더 원형`);
    }
  }
});

test('05 문서가 언급한 ODBC 상수와 속성이 실제 unixODBC 헤더에 있다', () => {
  for (const [file, text] of [['api-support.md', api], ['type-mapping.md', types], ['design.md', design]]) {
    const constants = new Set(text.match(/\bSQL_[A-Z0-9_]+\b/g) ?? []);
    // 함수 이름은 상수가 아니다.
    const functionsInHeaders = new Set(functions.map(row => row.name));
    for (const name of constants) {
      if (functionsInHeaders.has(name)) continue;
      assert.ok(headerText.includes(name), `${file}: 헤더에 없는 상수 ${name}`);
    }
  }
});

test('06 서버의 모든 타입과 확장 capability 를 다룬다', () => {
  const definitions = readFileSync(path.join(project, '../rdbms/src/types/dataType.ts'), 'utf8');
  const names = new Set(
    [...definitions.matchAll(/^  name: ([^;\n]+);/gm)].flatMap(match =>
      [...match[1].matchAll(/"([A-Z ]+)"/g)].map(item => item[1]),
    ),
  );
  assert.ok(names.size >= 17, '서버 DataType.name 정의가 바뀌었다. 대응표를 확인해야 한다.');
  const mapped = new Set([...types.matchAll(/^\| ([A-Z ]+) \|/gm)].map(match => match[1]));
  for (const name of names) assert.ok(mapped.has(name), `타입 대응 누락: ${name}`);
  assert.ok(mapped.has('UNKNOWN'));

  const source = readFileSync(path.join(project, '../rdbms/src/net/protocol.ts'), 'utf8');
  const capabilities = source.match(/export const CAPABILITIES = \[([^\]]+)\]/);
  assert.ok(capabilities, '서버 CAPABILITIES 정의를 찾지 못했다.');
  for (const [, name] of capabilities[1].matchAll(/"([^"]+)"/g)) {
    assert.ok(server.includes(name), `capability 대응 누락: ${name}`);
  }
  for (const request of ['hello', 'authStart', 'authFinish', 'execute', 'prepare', 'describe', 'executePrepared', 'closePrepared', 'cancel', 'fetch', 'closeCursor']) {
    assert.ok(server.includes(request), `서버 요청 누락: ${request}`);
  }
});

test('07 계획 문서에 UO-0 ~ UO-13 단계와 작업 체크리스트가 있다', () => {
  for (let stage = 0; stage <= 13; stage += 1) {
    assert.match(progress, new RegExp(`^### UO-${stage}\\.`, 'm'), `UO-${stage} 절 누락`);
  }
  assert.match(progress, /^## 4\. 전체 작업 순서/m);
  assert.match(progress, /^## 5\. 단계별 구현 절차/m);
  assert.match(progress, /\| UO-13 \|/);
  assert.match(progress, /- \[x\]/);
  assert.match(progress, /- \[ \]/);
  assert.match(progress, /2026-10-22/);
  assert.match(progress, /아직 ODBC 함수/);
});

test('08 모든 시험 ID가 검증 기록에 정의되고 중복이 없다', () => {
  const defined = [...verification.matchAll(/^\| (T-[A-Z]+) \|/gm)].map(match => match[1]);
  assert.equal(new Set(defined).size, defined.length, '시험 ID 중복');
  assert.ok(defined.length >= 25, '시험 ID 정의가 부족하다.');
  for (const document of [api, types, server, design, progress]) {
    for (const [id] of document.matchAll(/\bT-[A-Z]+\b/g)) {
      assert.ok(defined.includes(id), `정의되지 않은 시험 ID: ${id}`);
    }
  }
});

test('09 Unix 빌드·시험 기반이 갖추어졌고 호스트 경로를 코드에 박지 않았다', () => {
  for (const file of ['CMakeLists.txt', 'CMakePresets.json', 'scripts/setup-deps.sh', 'scripts/build-and-test.sh', 'scripts/inspect-environment.mjs']) {
    assert.ok(existsSync(path.join(project, file)), `${file} 없음`);
  }
  const cmake = read('CMakeLists.txt');
  assert.match(cmake, /find_package\(ODBC REQUIRED\)/);
  assert.match(cmake, /-fvisibility=hidden/);
  assert.match(cmake, /--version-script/);
  assert.match(cmake, /hwdb_odbc_abi_probe/);
  for (const file of ['scripts/setup-deps.sh', 'scripts/build-and-test.sh', 'scripts/inspect-environment.mjs']) {
    const text = read(file);
    assert.ok(!/\/home\/[A-Za-z0-9_.-]+/.test(text), `${file}: 호스트 절대 경로가 박혀 있다.`);
  }
  for (const preset of ['dev', 'release', 'asan']) {
    assert.ok(read('CMakePresets.json').includes(`"name": "${preset}"`), `${preset} 프리셋 누락`);
  }
  assert.match(read('.gitignore'), /^\/build\/$/m);
  assert.match(read('.gitignore'), /^\/\.deps\/$/m);
});

test('10 드라이버가 아직 골격임을 문서가 숨기지 않는다', () => {
  assert.match(readme, /아직 ODBC 함수/);
  assert.match(readme, /골격/);
  assert.match(progress, /UO-0/);
  assert.ok(existsSync(path.join(project, 'src/odbc/scaffold.cpp')));
});
