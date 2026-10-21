// 빌드된 PE를 읽어 export와 실제 import 의존성을 독립 검사한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const project = fileURLToPath(new URL('../', import.meta.url));
const expectedExports = [
  'SQLAllocHandle', 'SQLFreeHandle', 'SQLGetDiagRec', 'SQLGetDiagRecW', 'SQLGetEnvAttr', 'SQLSetEnvAttr',
  'SQLGetDiagField', 'SQLGetDiagFieldW', 'SQLGetStmtAttr', 'SQLGetStmtAttrW', 'SQLConnect', 'SQLConnectW',
  'SQLDriverConnect', 'SQLDriverConnectW', 'SQLGetConnectAttr', 'SQLGetConnectAttrW', 'SQLSetConnectAttr', 'SQLSetConnectAttrW',
  'SQLDisconnect', 'SQLGetInfo', 'SQLGetInfoW', 'SQLGetFunctions',
  'SQLExecDirect', 'SQLExecDirectW', 'SQLNumResultCols', 'SQLRowCount', 'SQLDescribeCol', 'SQLDescribeColW',
  'SQLColAttribute', 'SQLColAttributeW', 'SQLBindCol', 'SQLFetch', 'SQLFetchScroll', 'SQLGetData', 'SQLCloseCursor',
  'SQLFreeStmt', 'SQLMoreResults', 'SQLGetCursorName', 'SQLGetCursorNameW', 'SQLSetCursorName', 'SQLSetCursorNameW',
  'SQLSetStmtAttr', 'SQLSetStmtAttrW',
  'SQLPrepare', 'SQLPrepareW', 'SQLExecute', 'SQLNumParams', 'SQLDescribeParam', 'SQLBindParameter', 'SQLNativeSql', 'SQLNativeSqlW',
  'SQLGetDescField', 'SQLGetDescFieldW', 'SQLSetDescField', 'SQLSetDescFieldW', 'SQLGetDescRec', 'SQLGetDescRecW', 'SQLSetDescRec', 'SQLCopyDesc',
].sort();

function readPe(filename) {
  const data = readFileSync(filename);
  assert.equal(data.readUInt16LE(0), 0x5a4d, filename);
  const pe = data.readUInt32LE(0x3c);
  assert.equal(data.readUInt32LE(pe), 0x4550, filename);
  const machine = data.readUInt16LE(pe + 4);
  const sectionsCount = data.readUInt16LE(pe + 6);
  const optionalSize = data.readUInt16LE(pe + 20);
  const optional = pe + 24;
  const magic = data.readUInt16LE(optional);
  assert.ok(magic === 0x10b || magic === 0x20b);
  const directories = optional + (magic === 0x20b ? 112 : 96);
  const sections = Array.from({ length: sectionsCount }, (_, index) => {
    const offset = optional + optionalSize + index * 40;
    return {
      rva: data.readUInt32LE(offset + 12),
      size: data.readUInt32LE(offset + 16),
      raw: data.readUInt32LE(offset + 20),
    };
  });
  const position = rva => {
    const section = sections.find(item => rva >= item.rva && rva - item.rva < item.size);
    assert.ok(section, `RVA ${rva}: ${filename}`);
    const offset = section.raw + rva - section.rva;
    assert.ok(offset < data.length);
    return offset;
  };
  const string = rva => {
    const start = position(rva);
    const end = data.indexOf(0, start);
    assert.ok(end >= start);
    return data.toString('ascii', start, end);
  };
  const exports = [];
  const exportRva = data.readUInt32LE(directories);
  if (exportRva) {
    const table = position(exportRva);
    const count = data.readUInt32LE(table + 24);
    const names = position(data.readUInt32LE(table + 32));
    for (let index = 0; index < count; ++index) exports.push(string(data.readUInt32LE(names + index * 4)));
  }
  const imports = [];
  const importRva = data.readUInt32LE(directories + 8);
  if (importRva) {
    for (let entry = position(importRva); data.readUInt32LE(entry + 12); entry += 20)
      imports.push(string(data.readUInt32LE(entry + 12)).toLowerCase());
  }
  return { filename, machine, magic, exports: exports.sort(), imports };
}

for (const architecture of ['x86', 'x64']) {
  for (const configuration of ['Debug', 'Release']) {
    test(`T-ABI PE ${architecture}/${configuration}: machine·export·CRT·Manager 분리`, () => {
      const directory = path.join(project, 'build', architecture, 'bin', configuration);
      const binaries = ['hwdbodbc.dll', 'hwdb_abi_probe.exe', 'hwdb_dm_probe.exe', 'hwdb_boundary_test.exe']
        .map(name => readPe(path.join(directory, name)));
      for (const binary of binaries) {
        assert.equal(binary.machine, architecture === 'x64' ? 0x8664 : 0x014c, binary.filename);
        assert.equal(binary.magic, architecture === 'x64' ? 0x20b : 0x10b, binary.filename);
        assert.ok(!binary.imports.some(name => /^(?:msvcp|msvcr|vcruntime|ucrtbased?|api-ms-win-crt)/i.test(name)),
          `정적 CRT 위반: ${binary.filename}: ${binary.imports}`);
        assert.ok(!binary.imports.includes('hwdbodbc.dll'), `직접 링크 금지: ${binary.filename}`);
      }
      assert.deepEqual(binaries[0].exports, expectedExports);
      assert.ok(!binaries[0].imports.includes('odbc32.dll'), '드라이버가 Manager에 역의존한다.');
      assert.ok(!binaries[1].imports.includes('odbc32.dll'), '직접 로드 앱이 Manager에 링크됐다.');
      assert.ok(binaries[2].imports.includes('odbc32.dll'), 'Manager 시험 앱의 import가 없다.');
      assert.ok(!binaries[3].imports.includes('odbc32.dll'));
    });
  }
}
