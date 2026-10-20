import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
export function syncProtocol(check = false) {
  const prefix = 'org/duckdns/hjow/helloworlddb';
  const source = path.resolve(root, `../jdbc6/src/${prefix}/jdbc6/protocol`);
  const target = path.join(root, `src/${prefix}/jdbc8/protocol`);
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(source).filter(n => n.endsWith('.java'))) {
    const expected = fs.readFileSync(path.join(source, name), 'utf8').replaceAll('.jdbc6.protocol', '.jdbc8.protocol');
    if (check) {
      if (!fs.existsSync(path.join(target, name)) || fs.readFileSync(path.join(target, name), 'utf8') !== expected) throw new Error(`공통 코드 불일치: ${name}`);
    } else fs.writeFileSync(path.join(target, name), expected, 'utf8');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) syncProtocol(process.argv.includes('--check'));
