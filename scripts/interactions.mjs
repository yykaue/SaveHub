import { _electron as electron, expect } from '@playwright/test';
import electronPath from 'electron';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SaveStore, atomicJson, within } from '../electron/storage.mjs';

// Exercise real renderer/preload/IPC against disposable files, never real saves.
const root = path.resolve('.test-data');
await fs.mkdir(root, { recursive: true });
const base = await fs.mkdtemp(path.join(root, 'interactions-'));
const screenshots = path.resolve('docs/screenshots');
await fs.mkdir(screenshots, { recursive: true });
const dataDir = path.join(base, 'data');
const store = await new SaveStore(dataDir).init();
const sourceA = path.join(base, 'game-a'), sourceB = path.join(base, 'game-b');
for (const source of [sourceA, sourceB]) {
  await fs.mkdir(path.join(source, 'saves'), { recursive: true });
  await fs.writeFile(path.join(source, 'saves/progress.dat'), Buffer.alloc(32, 65));
}
const gameInput = (name, source) => ({ name, subtitle: 'INTERACTION TEST', icon: 'ring', color: '#8a9270', legacyRoot: '', locations: { win32: { root: source, items: ['saves'] }, darwin: { root: source, items: ['saves'] } } });
const gameA = await store.upsertGame(gameInput('验证游戏 A', sourceA));
const gameB = await store.upsertGame(gameInput('验证游戏 B', sourceB));
const records = [];
for (const [label, size, day] of [['记录 2', 32, 1], ['记录 10', 96, 3], ['记录 1', 64, 2]]) {
  await fs.writeFile(path.join(sourceA, 'saves/progress.dat'), Buffer.alloc(size, day));
  const snapshot = await store.createSnapshot(gameA, { label, note: '排序和选择验证' });
  const meta = await store.readSnapshot(gameA, snapshot.id);
  meta.createdAt = `2026-01-0${day}T00:00:00.000Z`;
  await atomicJson(path.join(store.snapshotDir(gameA, snapshot.id), 'manifest.json'), meta);
  records.push(snapshot);
}
const [a, b, c] = records;
await store.updateSnapshot(gameA, a.id, { favorite: true });
const protectedSave = await store.createSnapshot(gameA, { label: '受保护记录' });
await store.updateSnapshot(gameA, protectedSave.id, { favorite: true, protected: true });
const trashed = await store.createSnapshot(gameA, { label: '已回收记录' });
await store.updateSnapshot(gameA, trashed.id, { deleted: true });
const importSource = path.join(base, '导入记录');
await fs.mkdir(path.join(importSource, 'saves'), { recursive: true });
await fs.writeFile(path.join(importSource, 'saves/progress.dat'), Buffer.alloc(48, 4));
await store.importLegacy(gameA, importSource);
const imported = (await store.snapshots(gameA)).find(item => item.kind === 'imported');
const importedMeta = await store.readSnapshot(gameA, imported.id);
importedMeta.createdAt = '2026-01-04T00:00:00.000Z';
await atomicJson(path.join(store.snapshotDir(gameA, imported.id), 'manifest.json'), importedMeta);
const { safetyId } = await store.restoreSnapshot(gameA, a.id);
const recoveryBytes = await fs.readFile(path.join(store.snapshotDir(gameA, safetyId), 'payload/saves/progress.dat'));
await store.createSnapshot(gameB, { label: '游戏 B 的记录' });
await store.setTheme('glass');
const exportsDir = path.join(base, 'exports'); await fs.mkdir(exportsDir);

const env = { ...process.env, SAVEHUB_DATA_DIR: dataDir };
delete env.ELECTRON_RUN_AS_NODE; delete env.SAVEHUB_DEV_URL;
let application, page;
const errors = [], checks = [];
const done = message => { checks.push(message); console.log(`PASS ${message}`); };
try {
  application = await electron.launch({ executablePath: process.env.SAVEHUB_TEST_EXECUTABLE || electronPath, args: process.env.SAVEHUB_TEST_EXECUTABLE ? [] : ['.'], env, timeout: 45000 });
  page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(12000);
  const route = page.locator('.route-content');
  const rows = page.locator('.snapshot-row');
  const row = id => page.locator(`[data-snapshot-id="${id}"]`);
  const ids = () => rows.evaluateAll(elements => elements.map(element => element.dataset.snapshotId));
  const idle = () => expect(page.locator('.progress-panel')).toHaveCount(0);
  const gameState = () => page.evaluate(async id => (await window.savehub.state()).games.find(game => game.id === id), gameA);
  const pickGame = name => page.getByRole('navigation', { name: '游戏列表', exact: true }).getByRole('button', { name: new RegExp(name) }).click();
  const themeButton = page.getByRole('button', { name: '切换主题', exact: true });
  const search = page.getByRole('textbox', { name: '搜索存档', exact: true });
  const dialog = page.getByRole('dialog');
  await expect(rows).toHaveCount(4);
  await pickGame('验证游戏 A');
  await expect(themeButton).toHaveCount(1);
  await expect(page.locator('aside').getByRole('button', { name: '外观与主题', exact: true })).toHaveCount(0);
  await expect.poll(ids).toEqual([imported.id, b.id, c.id, a.id]);
  await expect(page.getByRole('columnheader').filter({ has: page.getByRole('button', { name: '创建时间排序', exact: true }) })).toHaveAttribute('aria-sort', 'descending');
  assert.equal((await gameState()).snapshots.length, 6);
  assert.equal((await gameState()).restorePoints.length, 1);
  done('Only the top-right theme entry remains; ordinary saves exclude protected, trashed and automatic records');

  for (const [heading, expected] of [
    ['存档名称', [imported.id, c.id, a.id, b.id]], ['存档名称', [b.id, a.id, c.id, imported.id]],
    ['创建时间', [imported.id, b.id, c.id, a.id]], ['创建时间', [a.id, c.id, b.id, imported.id]],
    ['文件大小', [a.id, imported.id, c.id, b.id]], ['文件大小', [b.id, c.id, imported.id, a.id]],
  ]) {
    await page.getByRole('button', { name: `${heading}排序`, exact: true }).click();
    await expect.poll(ids).toEqual(expected);
  }
  done('All three table headers sort ascending and descending, with numeric-aware names and default newest first');

  await search.fill('记录 1');
  await expect(rows).toHaveCount(2);
  await row(c.id).getByRole('checkbox').check();
  await expect(page.getByRole('checkbox', { name: '全选当前列表', exact: true })).toHaveAttribute('aria-checked', 'mixed');
  await page.evaluate(() => {
    window.__transitionCount = 0;
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = (...args) => { window.__transitionCount++; return start(...args); };
  });
  for (const choice of [null, '玻璃拟态', '科技']) {
    const scrollTop = await page.locator('main').evaluate(element => { element.scrollTop = 180; return element.scrollTop; });
    await themeButton.click();
    await expect(route).toHaveAttribute('data-page', 'themes');
    if (choice) { await page.getByRole('button', { name: `切换${choice}主题`, exact: true }).click(); await idle(); }
    await themeButton.click();
    await expect(route).toHaveAttribute('data-page', 'library');
    await expect(page.getByRole('heading', { name: '验证游戏 A', exact: true })).toBeVisible();
    await expect(search).toHaveValue('记录 1');
    await expect(row(c.id).getByRole('checkbox')).toBeChecked();
    await expect.poll(ids).toEqual([b.id, c.id]);
    await expect.poll(() => page.locator('main').evaluate(element => element.scrollTop)).toBe(scrollTop);
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'tech');
  for (const [label, target] of [['全部游戏', 'games'], ['设置与关于', 'settings']]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(route).toHaveAttribute('data-page', target);
    await themeButton.click(); await expect(route).toHaveAttribute('data-page', 'themes');
    await themeButton.click(); await expect(route).toHaveAttribute('data-page', target);
  }
  await pickGame('验证游戏 B');
  await expect(search).toHaveValue('');
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole('checkbox', { name: '全选当前列表', exact: true })).not.toBeChecked();
  await themeButton.click(); await expect(route).toHaveAttribute('data-page', 'themes');
  await themeButton.click(); await expect(page.getByRole('heading', { name: '验证游戏 B', exact: true })).toBeVisible();
  await pickGame('验证游戏 A');
  await expect(search).toHaveValue('记录 1');
  await expect(row(c.id).getByRole('checkbox')).toBeChecked();
  done('Theme toggles return to every previous route with the same game, query, sort, selection and scroll, including unchanged themes');

  assert(await page.evaluate(() => window.__transitionCount) >= 12);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const transitions = await page.evaluate(() => window.__transitionCount);
  await page.getByRole('button', { name: '全部游戏', exact: true }).click();
  await expect(route).toHaveAttribute('data-page', 'games');
  await pickGame('验证游戏 A'); await expect(route).toHaveAttribute('data-page', 'library');
  assert.equal(await page.evaluate(() => window.__transitionCount), transitions);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  done('Page changes use native transitions and honor the operating-system reduced-motion setting');

  await search.fill('');
  await expect(page.getByRole('checkbox', { name: '全选当前列表', exact: true })).not.toBeChecked();
  await row(a.id).getByRole('button', { name: /更多操作$/ }).click();
  await page.getByRole('menuitem', { name: '标记为保护存档', exact: true }).click();
  await idle(); await expect(rows).toHaveCount(3);
  await page.getByRole('tab', { name: '保护存档', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(row(a.id)).toBeVisible();
  await page.getByRole('tab', { name: '已收藏', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(row(a.id)).toBeVisible();
  assert.equal((await gameState()).snapshots.length, 6);
  await page.getByRole('tab', { name: '保护存档', exact: true }).click();
  await page.getByRole('checkbox', { name: '全选当前列表', exact: true }).check();
  await expect(row(a.id).getByRole('checkbox')).toBeChecked();
  await expect(row(protectedSave.id).getByRole('checkbox')).toBeChecked();
  await page.getByRole('button', { name: '删除所选', exact: true }).click();
  await expect(dialog.locator('.batch-confirm-list li')).toHaveCount(2);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal((await gameState()).snapshots.filter(item => item.deletedAt).length, 1);
  await page.getByRole('button', { name: '删除所选', exact: true }).click();
  await dialog.getByRole('button', { name: '确认删除 2 份', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(rows).toHaveCount(0);
  const deletedState = await gameState();
  assert.equal(deletedState.snapshots.length, 6);
  assert.deepEqual(deletedState.snapshots.filter(item => item.deletedAt).map(item => item.id).sort(), [a.id, protectedSave.id, trashed.id].sort());
  assert(deletedState.snapshots.find(item => item.id === a.id).favorite);
  assert(deletedState.snapshots.find(item => item.id === a.id).protected);
  done('Protection and favorites share original IDs; selected deletion is reversible and the confirmation lists exactly those saves');

  await page.getByRole('tab', { name: '回收站', exact: true }).click();
  await expect(rows).toHaveCount(3);
  await row(a.id).getByRole('checkbox').check();
  await row(protectedSave.id).getByRole('checkbox').check();
  await application.evaluate(({ dialog }, folder) => { globalThis.__pickerCalls = 0; dialog.showOpenDialog = async () => { globalThis.__pickerCalls++; return { canceled: false, filePaths: [folder] }; }; }, exportsDir);
  await page.getByRole('button', { name: '导出所选', exact: true }).click();
  await idle();
  assert.equal(await application.evaluate(() => globalThis.__pickerCalls), 1);
  const [selectedFolder] = await fs.readdir(exportsDir);
  const selectedCollection = JSON.parse(await fs.readFile(path.join(exportsDir, selectedFolder, 'collection.json'), 'utf8'));
  assert.deepEqual(selectedCollection.snapshots.sort(), [a.id, protectedSave.id].sort());
  assert.equal((await fs.readdir(path.join(exportsDir, selectedFolder))).length, 3);
  await row(protectedSave.id).getByRole('button', { name: /更多操作$/ }).click();
  await page.getByRole('menuitem', { name: '取消保护标记', exact: true }).click();
  await idle();
  await expect(page.getByText('已取消保护标记。', { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(3);
  let markedInTrash = (await gameState()).snapshots.find(item => item.id === protectedSave.id);
  assert(markedInTrash.deletedAt && !markedInTrash.protected);
  await row(protectedSave.id).getByRole('button', { name: /更多操作$/ }).click();
  await page.getByRole('menuitem', { name: '标记为保护存档', exact: true }).click();
  await idle();
  markedInTrash = (await gameState()).snapshots.find(item => item.id === protectedSave.id);
  assert(markedInTrash.deletedAt && markedInTrash.protected);
  await page.getByRole('button', { name: '找回所选', exact: true }).click();
  await expect(rows).toHaveCount(1); await idle();
  await page.getByRole('tab', { name: '保护存档', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await row(a.id).getByRole('button', { name: /更多操作$/ }).click();
  await page.getByRole('menuitem', { name: '取消保护标记', exact: true }).click();
  await expect(rows).toHaveCount(1); await idle();
  assert((await gameState()).snapshots.find(item => item.id === a.id).favorite);
  done('Selected exports use one folder picker; bulk recovery preserves favorite/protection flags and unprotect returns the same save');

  await search.fill('没有任何匹配的存档');
  await expect(rows).toHaveCount(0);
  await page.getByRole('button', { name: '导出全部存档', exact: true }).click(); await idle();
  assert.equal(await application.evaluate(() => globalThis.__pickerCalls), 2);
  const allFolder = (await fs.readdir(exportsDir)).find(name => name !== selectedFolder);
  const allCollection = JSON.parse(await fs.readFile(path.join(exportsDir, allFolder, 'collection.json'), 'utf8'));
  assert.deepEqual(allCollection.snapshots.sort(), [a.id, b.id, c.id, imported.id].sort());
  await search.fill('');
  await row(protectedSave.id).getByRole('checkbox').check();
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await page.getByRole('button', { name: '导出所选', exact: true }).click(); await idle();
  assert.equal((await fs.readdir(exportsDir)).length, 2);
  done('Export all ignores the current search/filter and exports only ordinary saves; cancelling export creates no output');

  await page.getByRole('button', { name: /^读档恢复点/ }).click();
  await expect(dialog.locator('.restore-points-list .restore-point')).toHaveCount(1);
  await dialog.getByRole('button', { name: '恢复', exact: true }).click();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '确认读档', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.deepEqual(await fs.readFile(path.join(sourceA, 'saves/progress.dat')), recoveryBytes);
  assert.equal((await gameState()).snapshots.length, 6);
  assert.equal((await gameState()).restorePoints.length, 2);
  await page.getByRole('button', { name: /^读档恢复点/ }).click();
  await dialog.getByRole('button', { name: /^移除恢复点/ }).first().click();
  await expect(dialog.locator('.restore-points-list .restore-point')).toHaveCount(1);
  await dialog.locator('.removed-points summary').click();
  await dialog.getByRole('button', { name: '找回', exact: true }).click();
  await expect(dialog.locator('.restore-points-list .restore-point')).toHaveCount(2);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  done('Existing automatic restore points remain accessible, restore actual bytes, and can be removed/recovered separately');

  await page.getByRole('tab', { name: '全部存档', exact: true }).click();
  await expect(rows).toHaveCount(4);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 760));
  assert(await page.locator('main').evaluate(element => element.scrollWidth <= element.clientWidth));
  assert(await page.locator('.snapshot-table').evaluate(element => element.scrollWidth <= element.clientWidth));
  await row(a.id).getByRole('checkbox').check();
  await row(c.id).getByRole('checkbox').check();
  await page.locator('main').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: path.join(screenshots, 'batch-selection.png'), animations: 'disabled' });
  done('Selection controls and all table columns fit the minimum 1080 x 760 desktop window');

  assert.deepEqual(errors, []);
  const report = { success: true, date: new Date().toISOString(), executable: process.env.SAVEHUB_TEST_EXECUTABLE || 'Electron development runtime', fixture: 'Isolated synthetic saves; no real game data modified.', checks, rendererErrors: errors };
  await atomicJson(path.join(screenshots, 'interaction-verification.json'), report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(screenshots, 'interaction-failure.png'), animations: 'disabled' }).catch(() => {});
  console.error(`Fixture: ${base}`);
  throw error;
} finally {
  if (application) await application.close().catch(() => {});
  if (!process.env.SAVEHUB_KEEP_TEST_DATA) { assert(within(root, base) && base !== root); await fs.rm(base, { recursive: true, force: true }); }
}
