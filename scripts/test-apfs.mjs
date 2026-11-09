import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withinOnDisk } from '../electron/fs-utils.mjs';
const run = promisify(execFile);
assert(process.platform === 'darwin' && process.arch === 'arm64', 'This verification requires Apple Silicon');
const root = path.resolve('.test-data');
await fs.mkdir(root, { recursive: true });
const base = await fs.mkdtemp(path.join(root, 'apfs-'));
const checks = [];
try {
  for (const [format, sensitive] of [
    ['APFS', false],
    ['Case-sensitive APFS', true],
  ]) {
    const mount = path.join(base, sensitive ? 'sensitive' : 'insensitive'),
      image = path.join(base, `${sensitive}.dmg`);
    await fs.mkdir(mount);
    await run('hdiutil', ['create', '-size', '128m', '-fs', format, '-volname', 'SaveHub test', image]);
    await run('hdiutil', ['attach', image, '-mountpoint', mount, '-nobrowse']);
    try {
      await fs.mkdir(path.join(mount, 'Game'));
      if (sensitive) {
        await fs.mkdir(path.join(mount, 'game'));
        assert.equal(await withinOnDisk(path.join(mount, 'Game'), path.join(mount, 'game'), 'darwin'), false);
      } else assert.equal(await withinOnDisk(path.join(mount, 'Game'), path.join(mount, 'game'), 'darwin'), true);
      await fs.mkdir(path.join(mount, 'Game', 'saves'));
      assert.equal(await withinOnDisk(path.join(mount, 'Game'), path.join(mount, 'Game', 'saves'), 'darwin'), true);
      checks.push({ format, success: true });
    } finally {
      await run('hdiutil', ['detach', mount]);
    }
  }
  await fs.mkdir('test-results', { recursive: true });
  await fs.writeFile(
    'test-results/apfs.json',
    JSON.stringify({ success: true, date: new Date().toISOString(), checks, fixture: base }, null, 2),
  );
} finally {
  if (!process.env.SAVEHUB_KEEP_TEST_DATA) {
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
