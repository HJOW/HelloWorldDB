#!/usr/bin/env node
/**
 * 현재 호스트의 개발 환경을 조회해 JSON 한 파일로 남긴다. (UO-0)
 *
 * 이 스크립트는 **설치 여부를 확인**할 뿐, 드라이버 실행 시험이 아니다.
 * 다른 PC의 기록을 재사용하지 않도록 호스트명·조회 시각을 함께 남긴다.
 *
 * 사용법:
 *   node scripts/inspect-environment.mjs --output build/dev/uo0/environment.json \
 *        --abi-probe build/dev/hwdb_odbc_env_probe
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, hostname, platform, release } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArguments(argv) {
  const options = { output: 'build/dev/uo0/environment.json', abiProbe: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output') options.output = argv[++index];
    else if (argument === '--abi-probe') options.abiProbe = argv[++index];
    else throw new Error(`알 수 없는 인자: ${argument}`);
  }
  return options;
}

function which(name) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (directory.length === 0) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 다음 경로를 본다.
    }
  }
  return null;
}

function run(name, args = ['--version']) {
  const executable = which(name);
  if (executable === null) return { name, path: null, exists: false, exitCode: null, output: '' };
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 20_000 });
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return {
    name,
    path: executable,
    exists: true,
    exitCode: result.status,
    output: text.slice(0, 800),
  };
}

function osName() {
  try {
    const text = readFileSync('/etc/os-release', 'utf8');
    const match = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(text);
    if (match !== null) return match[1];
  } catch {
    // /etc/os-release 가 없는 플랫폼이다.
  }
  if (platform() === 'darwin') {
    const result = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' });
    return `macOS ${(result.stdout ?? '').trim()}`;
  }
  return `${platform()} ${release()}`;
}

function pkgConfig(variable) {
  const tool = which('pkg-config');
  if (tool === null) return null;
  const result = spawnSync(tool, variable, { encoding: 'utf8', timeout: 20_000 });
  if (result.status !== 0) return null;
  const text = (result.stdout ?? '').trim();
  return text.length === 0 ? null : text;
}

function headerDirectories() {
  const candidates = [
    pkgConfig(['--variable=includedir', 'odbc']),
    process.env.HWDB_ODBC_ROOT ? path.join(process.env.HWDB_ODBC_ROOT, 'include') : null,
    '/usr/include',
    '/usr/local/include',
    '/opt/homebrew/include',
    '/opt/local/include',
  ].filter(value => typeof value === 'string' && value.length > 0);
  const seen = new Set();
  const result = [];
  for (const directory of candidates) {
    const normalized = path.resolve(directory);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const headers = ['sql.h', 'sqlext.h', 'sqltypes.h', 'sqlucode.h'].map(name => ({
      name,
      path: path.join(normalized, name),
      exists: existsSync(path.join(normalized, name)),
    }));
    result.push({ directory: normalized, headers, complete: headers.every(item => item.exists) });
  }
  return result;
}

function odbcLibraries() {
  const found = new Set();
  const libdir = pkgConfig(['--variable=libdir', 'odbc']);
  if (libdir !== null) {
    for (const name of ['libodbc.so', 'libodbc.so.2', 'libodbc.dylib', 'libodbc.2.dylib']) {
      const candidate = path.join(libdir, name);
      if (existsSync(candidate)) found.add(candidate);
    }
  }
  for (const root of [process.env.HWDB_ODBC_ROOT, '/usr', '/usr/local', '/opt/homebrew']) {
    if (typeof root !== 'string' || root.length === 0) continue;
    for (const name of ['libodbc.so.2', 'libodbc.so', 'libodbc.2.dylib', 'libodbc.dylib']) {
      for (const directory of ['lib', 'lib64', 'lib/x86_64-linux-gnu', 'lib/aarch64-linux-gnu']) {
        const candidate = path.join(root, directory, name);
        if (existsSync(candidate)) found.add(candidate);
      }
    }
  }
  const ldconfig = which('ldconfig');
  if (ldconfig !== null) {
    const result = spawnSync(ldconfig, ['-p'], { encoding: 'utf8', timeout: 20_000 });
    for (const line of (result.stdout ?? '').split('\n')) {
      if (line.includes('libodbc.so.2')) {
        const candidate = line.trim().split(/\s+=>\s+/)[1];
        if (candidate !== undefined && existsSync(candidate)) found.add(candidate);
      }
    }
  }
  return [...found].sort();
}

function gitCommit(projectRoot) {
  const git = which('git');
  if (git === null) return null;
  const result = spawnSync(git, ['-C', projectRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  const text = (result.stdout ?? '').trim();
  return result.status === 0 && text.length > 0 ? text : null;
}

function abiFacts(probe) {
  if (probe === null) return null;
  if (!existsSync(probe)) throw new Error(`ABI 조회 실행 파일이 없다: ${probe}`);
  const result = spawnSync(probe, [], { encoding: 'utf8', timeout: 20_000 });
  if (result.status !== 0) {
    throw new Error(`ABI 조회가 실패했다(${result.status}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

const options = parseArguments(process.argv.slice(2));
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const headers = headerDirectories();
const completeHeader = headers.find(item => item.complete) ?? null;
const tools = [
  run('cmake'),
  run('ctest'),
  run('make'),
  run('cc'),
  run('c++'),
  run('node'),
  run('pkg-config', ['--modversion', 'odbc']),
  run('isql', ['--version']),
  run('iusql', ['--version']),
  run('odbcinst', ['--version']),
  run('odbc_config', ['--version']),
];

const report = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  host: {
    computer: hostname(),
    platform: platform(),
    arch,
    release: release(),
    osName: osName(),
    node: process.version,
    nonRoot: typeof process.getuid === 'function' ? process.getuid() !== 0 : null,
  },
  project: {
    root: projectRoot,
    version: '0.1.0',
    gitCommit: gitCommit(projectRoot),
    localDeps: existsSync(path.join(projectRoot, '.deps')),
  },
  tools,
  unixodbc: {
    pkgConfigVersion: pkgConfig(['--modversion', 'odbc']),
    headerDir: completeHeader?.directory ?? null,
    headers: headers,
    libraries: odbcLibraries(),
  },
  abi: abiFacts(options.abiProbe),
};

const outputPath = path.resolve(options.output);
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

const missing = tools.filter(tool => !tool.exists).map(tool => tool.name);
console.log(`환경 기록: ${outputPath}`);
console.log(`호스트: ${report.host.computer} / ${report.host.osName} / ${report.host.arch}`);
console.log(`unixODBC 헤더: ${report.unixodbc.headerDir ?? '미발견'}`);
console.log(`unixODBC 라이브러리: ${report.unixodbc.libraries.join(', ') || '미발견'}`);
console.log(`필수 도구 누락: ${missing.length === 0 ? '없음' : missing.join(', ')}`);
