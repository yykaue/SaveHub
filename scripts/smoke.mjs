import { _electron as electron, expect } from '@playwright/test';
import electronPath from 'electron';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SaveStore, atomicJson, within } from '../electron/storage.mjs';
import { makePresets } from '../electron/presets.mjs';

const root = path.resolve('.test-data');
await fs.mkdir(root, { recursive: true });
const base = await fs.mkdtemp(path.join(root, 'ui-'));
const dataDir = path.join(base, 'data');
const screenshots = path.resolve('docs', 'screenshots');
await fs.mkdir(screenshots, { recursive: true });
const presets = await makePresets();
for (const game of presets) {
  const source = path.join(base, 'sources', game.id);
  await fs.mkdir(path.join(source, 'saves'), { recursive: true });
  await fs.writeFile(path.join(source, 'saves', 'progress.dat'), Buffer.alloc(4 * 1024 * 1024, 65));
  game.locations = { win32: { root: source, items: ['saves'] }, darwin: { root: source, items: ['saves'] } };
  game.legacyRoot = '';
}
const store = await new SaveStore(dataDir).init(presets);
const sampleNames = ['风暴之外 · 新的旅程', '抵达王城 · 初见黄金树', '挑战之前 · 留住这一刻'];
let sample;
for (const [index, label] of sampleNames.entries()) {
  sample = await store.createSnapshot('elden-ring', { label, note: ['一周目 · 宁姆格福，故事从这里开始', '一周目 · 王城罗德尔，向黄金树进发', '一周目 · 黄金树大教堂，准备迎接新的挑战'][index] });
  const meta = await store.readSnapshot('elden-ring', sample.id);
  meta.createdAt = new Date(Date.now() - (3 - index) * 86400000).toISOString();
  if (index === 2) meta.favorite = true;
  await atomicJson(path.join(store.snapshotDir('elden-ring', sample.id), 'manifest.json'), meta);
}
await store.restoreSnapshot('elden-ring', sample.id);
await store.createSnapshot('slay-the-spire', { label: '第三幕 · 向心脏进发', note: '铁甲战士，准备最后一战。' });
await store.createSnapshot('dark-souls-2', { label: '如蜜 · 篝火旁', note: '旅程的起点。' });

const env = { ...process.env, SAVEHUB_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SAVEHUB_DEV_URL;
let application;
const errors = [];
const checks = [];
try {
  application = await electron.launch({ executablePath: process.env.SAVEHUB_TEST_EXECUTABLE || electronPath, args: process.env.SAVEHUB_TEST_EXECUTABLE ? [] : ['.'], env, timeout: 45000 });
  const page = await application.firstWindow();
  await page.getByRole('button', { name: /^存档库/ }).click();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('.snapshot-row');
  await expect(page.getByRole('heading', { name: '艾尔登法环', exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  checks.push('Electron renderer loads with context isolation and no Node globals');
  const appIcon = await application.evaluate(({ nativeImage }, filename) => {
    const icon = nativeImage.createFromPath(filename);
    return { empty: icon.isEmpty(), ...icon.getSize() };
  }, path.resolve('build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'));
  assert(!appIcon.empty && appIcon.width >= 16 && appIcon.height >= 16);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', /.+/);
  checks.push('Application icon decodes natively and the shared SaveHub logo is configured as the favicon');

  for (const theme of ['ink', 'tech', 'cyber', 'glass']) {
    const names = { ink: '水墨', tech: '科技', cyber: '赛博朋克', glass: '玻璃拟态' };
    await page.getByRole('button', { name: '切换主题', exact: true }).click();
    await page.getByRole('button', { name: `切换${names[theme]}主题`, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('.progress-panel')).toHaveCount(0);
    await page.getByRole('button', { name: '切换主题', exact: true }).click();
    const brand = page.locator('.brand .savehub-logo');
    await expect(brand).toBeVisible();
    await expect.poll(() => brand.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    await page.mouse.move(800, 30);
    await page.screenshot({ path: path.join(screenshots, `${theme}.png`), animations: 'disabled' });
    checks.push(`${theme} theme renders and persists`);
  }

  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await page.getByRole('button', { name: '切换水墨主题', exact: true }).click();
  await expect(page.locator('.progress-panel')).toHaveCount(0);
  await page.screenshot({ path: path.join(screenshots, 'themes.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await page.getByRole('button', { name: '创建新存档', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '存档名称', exact: true }).fill('UI 测试 · 创建并恢复');
  await dialog.getByRole('textbox', { name: /给未来的自己留句话/ }).fill('此记录只使用隔离测试文件。');
  await dialog.getByRole('button', { name: '创建存档', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'UI 测试 · 创建并恢复', exact: true })).toBeVisible();
  checks.push('Create snapshot through actual preload and filesystem IPC');

  await page.getByRole('textbox', { name: '搜索存档' }).fill('UI 测试');
  await expect(page.locator('.snapshot-row')).toHaveCount(1);
  await page.getByRole('button', { name: '收藏 UI 测试 · 创建并恢复', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消收藏 UI 测试 · 创建并恢复', exact: true })).toBeVisible();
  checks.push('Search and favorite persist');

  const liveSave = path.join(presets[0].locations[process.platform].root, 'saves', 'progress.dat');
  await fs.writeFile(liveSave, 'live-before-restore');
  await page.getByRole('button', { name: '读档', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '确认读档', exact: true })).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '确认读档', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30000 });
  assert.equal((await fs.stat(liveSave)).size, 4 * 1024 * 1024);
  const safety = (await store.snapshots('elden-ring')).find(snapshot => snapshot.kind === 'safety' && snapshot.label.includes('UI 测试'));
  assert(safety);
  assert.equal(await fs.readFile(path.join(store.snapshotDir('elden-ring', safety.id), 'payload', 'saves', 'progress.dat'), 'utf8'), 'live-before-restore');
  checks.push('Restore confirmation, actual bytes replaced, and safety snapshot verified');

  await page.getByRole('button', { name: 'UI 测试 · 创建并恢复 更多操作', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '移入回收站', exact: true })).toBeEnabled();
  await page.getByRole('menuitem', { name: '移入回收站', exact: true }).click();
  await expect(dialog.getByRole('note', { name: '包含已收藏存档' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '移入回收站', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '移入回收站', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('tab', { name: '回收站', exact: true }).click();
  await expect(page.getByRole('button', { name: 'UI 测试 · 创建并恢复', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '找回', exact: true }).click();
  await expect(page.locator('.snapshot-row')).toHaveCount(0);
  checks.push('Snapshot trash and recovery');

  await page.getByRole('button', { name: '全部游戏', exact: true }).click();
  await page.locator('main').getByRole('button', { name: '添加游戏', exact: true }).click();
  await dialog.getByRole('textbox', { name: /游戏名称/ }).fill('自动化测试游戏');
  await dialog.getByRole('textbox', { name: '副标题', exact: true }).fill('TEST WORLD');
  await dialog.getByRole('button', { name: '宝石图标', exact: true }).click();
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, path.resolve('build/icon.png'));
  await dialog.getByRole('button', { name: '上传', exact: true }).click();
  await expect(dialog.locator('.edit-game-icon img')).toBeVisible();
  await application.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, presets[0].locations[process.platform].root);
  await dialog.getByTitle('浏览文件夹', { exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '游戏存档根目录', exact: true })).toHaveValue(presets[0].locations[process.platform].root);
  await dialog.getByRole('textbox', { name: /要备份的文件或目录/ }).fill('saves');
  const macOSTab = dialog.getByRole('tab', { name: /macOS/ });
  await macOSTab.click();
  await expect(macOSTab).toHaveAttribute('aria-selected', 'true');
  const macOSRoot = dialog.getByRole('textbox', { name: '游戏存档根目录', exact: true });
  await macOSRoot.fill('/Users/example/Library/Application Support/Test');
  await expect(macOSRoot).toHaveValue('/Users/example/Library/Application Support/Test');
  await dialog.getByRole('textbox', { name: /要备份的文件或目录/ }).fill('saves');
  await dialog.getByRole('button', { name: '保存游戏', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '自动化测试游戏', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /自动化测试游戏 0 份存档/ }).click();
  await page.getByRole('button', { name: '游戏设置', exact: true }).click();
  await dialog.getByRole('button', { name: '删除游戏', exact: true }).click();
  await dialog.getByRole('button', { name: '删除游戏', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '设置与关于', exact: true }).click();
  await page.getByRole('button', { name: '找回项目', exact: true }).click();
  await expect(page.getByRole('button', { name: /自动化测试游戏 0 份存档/ })).toBeVisible();
  checks.push('Native directory picker, custom image import, dual-platform configuration, game removal and recovery');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 760));
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: /^Save Library/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch language', exact: true })).toHaveText('EN');
  await page.getByRole('button', { name: /^Save Library/ }).click();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && Array.from(document.querySelectorAll('.button, .filter-tabs button, .sort-heading, .load-button')).every(el => el.scrollWidth <= el.clientWidth + 1)));
  await page.getByRole('button', { name: 'Switch language', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByRole('button', { name: /^存档库/ })).toBeVisible();
  checks.push('Bilingual Chinese/English switching from Settings and toolbar (default Chinese)');

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 760));
  await page.getByRole('button', { name: /^存档库/ }).click();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: path.join(screenshots, 'compact.png') });
  checks.push('1080 x 760 window has no horizontal overflow');

  await application.close(); application = undefined;
  const reopened = await new SaveStore(dataDir).init();
  const persisted = await reopened.state();
  assert.equal(persisted.theme, 'ink');
  assert.equal(persisted.language, 'zh');
  const custom = persisted.games.find(game => game.name === '自动化测试游戏');
  assert(custom && !custom.deletedAt && custom.icon.startsWith('data:image/png;base64,'));
  assert.equal(custom.locations.darwin.root, '/Users/example/Library/Application Support/Test');
  assert.deepEqual(errors, []);
  await atomicJson(path.join(screenshots, 'verification.json'), { date: new Date().toISOString(), fixture: 'Isolated synthetic game files; no real game data modified.', checks, rendererErrors: errors });
  console.log(JSON.stringify({ success: true, checks, screenshots }, null, 2));
} finally {
  if (application) await application.close().catch(() => {});
  if (!process.env.SAVEHUB_KEEP_TEST_DATA) { assert(within(root, base) && base !== root); await fs.rm(base, { recursive: true, force: true }); }
}
