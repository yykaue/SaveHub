import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// 计算发行目录下所有安装包产物（.exe / .dmg / .zip）的 SHA-256 校验和并生成 SHA256SUMS.txt
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
const directory = path.resolve(process.argv[2] || pkg.build.directories.output);
const files = (await fs.readdir(directory)).filter((name) => /\.(exe|dmg|zip)$/.test(name)).sort();
if (!files.length) throw new Error('No release artifacts found');
const lines = [];
for (const name of files) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path.join(directory, name))) hash.update(bytes);
  lines.push(`${hash.digest('hex')}  ${name}`);
}
await fs.writeFile(path.join(directory, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
console.log(`SHA256SUMS.txt: ${files.length} artifacts`);
