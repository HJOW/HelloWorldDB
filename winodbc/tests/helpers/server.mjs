// 서버 소스를 바꾸지 않고 현재 체크아웃을 winodbc 내부에 빌드한다.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../../', import.meta.url);
const server = new URL('../rdbms/', root);
const output = new URL('build/server/', root);
const result = spawnSync(process.execPath, [fileURLToPath(new URL('node_modules/typescript/bin/tsc', server)),
  '-p', fileURLToPath(new URL('tsconfig.json', server)), '--outDir', fileURLToPath(output)],
  { windowsHide: true, encoding: 'utf8' });
if (result.error || result.status !== 0) throw new Error(`시험 서버 빌드 실패: ${result.error ?? result.stdout + result.stderr}`);
fs.writeFileSync(new URL('package.json', output), '{"type":"module"}\n');
export const { Server } = await import(new URL('src/daemon/server.js', output));
export const { loadConfig } = await import(new URL('src/config/config.js', output));
