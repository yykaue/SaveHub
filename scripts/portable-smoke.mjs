import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SaveStore, atomicJson, within } from '../electron/storage.mjs';
import { assertDesktopLaunchAllowed, desktopEnvironment } from './desktop-environment.mjs';

// NSIS 便携版启动器不会直接向 Playwright 转发 Electron 调试输出；
// 因此等待启动器解压运行后，通过 Chromium 生成的 DevToolsActivePort 文件建立 CDP 连接。
await assertDesktopLaunchAllowed();
const root = path.resolve('.test-data');
await fs.mkdir(root, { recursive: true });
const reused = process.env.SAVEHUB_PORTABLE_TEST_DATA;
const base = reused ? path.resolve(reused) : await fs.mkdtemp(path.join(root, 'portable-'));
assert(within(root, base) && base !== root, 'Only isolated test directories are allowed');
const artifacts = path.resolve('test-results/portable', path.basename(base) + '-' + Date.now());
await fs.mkdir(artifacts, { recursive: true });
const dataDir = path.join(base, 'data');
const store = await new SaveStore(dataDir).init();
if (!store.config.games.length) {
  const source = path.join(base, 'source');
  await fs.mkdir(path.join(source, 'saves'), { recursive: true });
  await fs.writeFile(path.join(source, 'saves', 'progress.dat'), 'portable-fixture-original');
  await store.upsertGame({
    name: '便携版验证游戏',
    subtitle: 'PORTABLE TEST',
    icon: 'ring',
    color: '#8a9270',
    locations: { win32: { root: source, items: ['saves'] }, darwin: { root: '', items: [] } },
    legacyRoot: '',
  });
}
const game = store.config.games.find((game) => !game.deletedAt);
assert(
  game && store.config.games.every((game) => within(base, game.locations.win32.root)),
  'Test must never use real game data',
);
const liveFile = path.join(game.locations.win32.root, 'saves', 'progress.dat');
const original = await fs.readFile(liveFile);
const portFile = path.join(dataDir, 'DevToolsActivePort');
await fs.rm(portFile, { force: true });
const packageInfo = JSON.parse(await fs.readFile('package.json', 'utf8'));
const executable = path.resolve(
  packageInfo.build.directories.output,
  `SaveHub-${packageInfo.version}-Windows-x64-portable.exe`,
);
const env = desktopEnvironment({ ...process.env, SAVEHUB_DATA_DIR: dataDir });
delete env.SAVEHUB_DEV_URL;
const child = spawn(
  executable,
  [
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--enable-logging=file',
    `--log-file=${path.join(base, 'portable.log')}`,
  ],
  { env, stdio: 'ignore', windowsHide: true },
);
let exited = false;
let spawnError;
child.on('exit', () => {
  exited = true;
});
child.on('error', (error) => {
  spawnError = error;
});
let browser;
const checks = [];
const errors = [];
let failure;
const cleanupErrors = [];
try {
  const deadline = Date.now() + 45000;
  let endpoint;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    try {
      const [port, socket] = (await fs.readFile(portFile, 'utf8')).trim().split(/\r?\n/);
      if (/^\d+$/.test(port) && socket?.startsWith('/devtools/browser/')) {
        endpoint = `ws://127.0.0.1:${port}${socket}`;
        break;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (exited) throw new Error('Portable launcher exited before the Electron window became available');
    await delay(200);
  }
  assert(endpoint, 'Portable executable did not expose a window within 45 seconds');
  browser = await chromium.connectOverCDP(endpoint);
  await browser.contexts()[0].tracing.start({ screenshots: true, snapshots: true, sources: true });
  const context = browser.contexts()[0];
  const page = context.pages()[0] || (await context.waitForEvent('page'));
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.getByRole('heading', { name: game.name, exact: true })).toBeVisible();
  const appVersion = await page.evaluate(async () => (await window.savehub.state()).version);
  assert.equal(appVersion, packageInfo.version);
  const currentEntry = (await fs.readFile('dist/index.html', 'utf8')).match(/<script[^>]*src="([^"]+)"/)[1];
  assert.equal(await page.locator('script[type="module"]').getAttribute('src'), currentEntry);
  checks.push('Delivered NSIS portable executable starts the current application version and renderer bundle');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  checks.push('Packaged renderer has no Node globals');

  await page.getByRole('button', { name: /^存档库/ }).click();
  await page.getByRole('button', { name: '创建新存档', exact: true }).click();
  const label = `便携版验证 · ${Date.now()}`;
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '存档名称', exact: true }).fill(label);
  await dialog.getByRole('button', { name: '创建存档', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('textbox', { name: '搜索存档' }).fill(label);
  await expect(page.locator('.snapshot-row')).toHaveCount(1);
  checks.push('Portable executable creates a verified snapshot through the real filesystem bridge');

  await fs.writeFile(liveFile, 'portable-live-progress-before-restore');
  await page.getByRole('button', { name: '读档', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '确认读档', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: '确认读档', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30000 });
  assert.deepEqual(await fs.readFile(liveFile), original);
  const safety = (await store.snapshots(game.id)).find(
    (snapshot) => snapshot.kind === 'safety' && snapshot.label.includes(label),
  );
  assert(safety);
  assert.equal(
    await fs.readFile(path.join(store.snapshotDir(game.id, safety.id), 'payload', 'saves', 'progress.dat'), 'utf8'),
    'portable-live-progress-before-restore',
  );
  checks.push('Portable restore replaces exact bytes and preserves the previous live progress');
  assert.deepEqual(errors, []);
  await page.getByRole('textbox', { name: '搜索存档' }).fill('');
  await page.screenshot({ path: path.join(artifacts, 'portable.png'), animations: 'disabled' });
  await browser.contexts()[0].tracing.stop({ path: path.join(artifacts, 'trace.zip') });
  const session = await browser.newBrowserCDPSession();
  await Promise.race([session.send('Browser.close').catch(() => {}), delay(1000)]);
  await Promise.race([browser.close().catch(() => {}), delay(1000)]);
  browser = undefined;
  for (let count = 0; count < 50 && !exited; count++) await delay(100);
  assert(exited, 'Portable launcher should exit after its application closes');
  checks.push('Portable application and its launcher close cleanly');
  const result = {
    success: true,
    date: new Date().toISOString(),
    executable,
    fixture: 'Isolated synthetic files only',
    checks,
    rendererErrors: errors,
  };
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  failure = error;
  throw error;
} finally {
  if (browser) {
    await browser
      .contexts()[0]
      .tracing.stop({ path: path.join(artifacts, 'trace.zip') })
      .catch((error) => cleanupErrors.push(String(error)));
    const session = await browser.newBrowserCDPSession().catch(() => null);
    if (session) await Promise.race([session.send('Browser.close').catch(() => {}), delay(1000)]);
    await Promise.race([browser.close().catch(() => {}), delay(1000)]);
  }
  if (!exited && child.pid) {
    await new Promise((resolve) => {
      const stop = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      stop.once('exit', resolve);
      stop.once('error', resolve);
    });
  }
  if (!reused && !failure && !process.env.SAVEHUB_KEEP_TEST_DATA) {
    assert(within(root, base) && base !== root);
    await fs
      .rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      .catch((error) => cleanupErrors.push(String(error)));
  }
  await atomicJson(path.join(artifacts, 'run.json'), {
    suite: 'portable',
    success: !failure && !cleanupErrors.length,
    date: new Date().toISOString(),
    executable,
    version: packageInfo.version,
    checks,
    rendererErrors: errors,
    error: failure ? String(failure) : null,
    cleanupErrors,
  }).catch((error) => console.error('Could not write portable report', error));
  console.log(`E2E_REPORT=${path.join(artifacts, 'run.json')}`);
}
if (!failure && cleanupErrors.length) throw new Error(cleanupErrors.join('\n'));
