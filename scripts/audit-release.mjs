import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const asar = appBuilderRequire('@electron/asar');
const sourcePackage = JSON.parse(await fs.readFile('package.json', 'utf8'));
const release = path.resolve(sourcePackage.build.directories.output);
const archive = path.join(release, 'win-unpacked/resources/app.asar');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [];
async function walk(directory) {
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) await walk(file); else files.push(file.replaceAll(path.sep, '/'));
  }
}
await walk('electron'); await walk('dist'); files.push('build/icon.png');
const sourceMatches = [];
for (const file of files) {
  const source = await fs.readFile(file);
  const packed = asar.extractFile(archive, file.split('/').join(path.sep));
  assert.equal(hash(source), hash(packed), `Packaged source differs: ${file}`);
  sourceMatches.push({ file, sha256: hash(source) });
}
const packedPackage = JSON.parse(asar.extractFile(archive, 'package.json').toString());
for (const key of ['name', 'version', 'main']) assert.equal(packedPackage[key], sourcePackage[key]);
const artifacts = [];
for (const line of (await fs.readFile(path.join(release, 'SHA256SUMS.txt'), 'utf8')).trim().split(/\r?\n/)) {
  const [, expected, relative] = line.match(/^([a-f0-9]{64})\s+(.+)$/);
  const bytes = await fs.readFile(path.join(release, relative));
  assert.equal(hash(bytes), expected, `Artifact changed: ${relative}`);
  artifacts.push({ file: relative, bytes: bytes.length, sha256: expected });
}
const result = { success: true, version: sourcePackage.version, date: new Date().toISOString(), sourceMatches, artifacts };
await fs.writeFile('docs/release-audit.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
