import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('release build scripts do not publish artifacts implicitly', () => {
  for (const script of ['dist:win', 'dist:mac']) {
    assert.match(packageJson.scripts[script], /electron-builder .*--publish never$/);
  }
});
