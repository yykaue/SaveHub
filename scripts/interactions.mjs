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
  const exportAndRead = async action => {
    const before = await fs.readdir(exportsDir);
    await action(); await idle();
    const created = (await fs.readdir(exportsDir)).filter(name => !before.includes(name));
    assert.equal(created.length, 1, 'Each export creates exactly one outer folder');
    const folder = path.join(exportsDir, created[0]);
    const [index] = await fs.readdir(path.join(folder, '.savehub-exports'));
    const collection = JSON.parse(await fs.readFile(path.join(folder, '.savehub-exports', index), 'utf8'));
    for (const item of collection.snapshots) {
      assert.deepEqual(await fs.readFile(path.join(folder, item.directory, 'saves/progress.dat')), await fs.readFile(path.join(store.snapshotDir(item.manifest.gameId, item.manifest.id), 'payload/saves/progress.dat')));
    }
    return { folder, collection };
  };
  const exportTab = async (name, expectedIds) => {
    const button = page.getByRole('button', { name: '导出全部', exact: true });
    await expect(button).toHaveAttribute('title', new RegExp(`「${name}」.*不受搜索影响`));
    const pickerCalls = await application.evaluate(() => globalThis.__pickerCalls);
    const result = await exportAndRead(() => button.click());
    assert.equal(await application.evaluate(() => globalThis.__pickerCalls), pickerCalls + 1);
    assert.deepEqual(result.collection.snapshots.map(item => item.manifest.id).sort(), [...expectedIds].sort());
    return result;
  };
  const gameState = () => page.evaluate(async id => (await window.savehub.state()).games.find(game => game.id === id), gameA);
  const pickGame = name => page.getByRole('navigation', { name: '游戏列表', exact: true }).getByRole('button', { name: new RegExp(name) }).click();
  const themeButton = page.getByRole('button', { name: '切换主题', exact: true });
  const search = page.getByRole('textbox', { name: '搜索存档', exact: true });
  const dialog = page.getByRole('dialog');
  await expect(rows).toHaveCount(5);
  await pickGame('验证游戏 A');
  await expect(themeButton).toHaveCount(1);
  await expect(page.locator('aside').getByRole('button', { name: '外观与主题', exact: true })).toHaveCount(0);
  await expect.poll(ids).toEqual([protectedSave.id, imported.id, b.id, c.id, a.id]);
  await expect(page.getByRole('columnheader').filter({ has: page.getByRole('button', { name: '创建时间排序', exact: true }) })).toHaveAttribute('aria-sort', 'descending');
  assert.equal((await gameState()).snapshots.length, 6);
  assert.equal((await gameState()).restorePoints.length, 1);
  await expect(page.getByRole('tab', { name: '全部存档', exact: true })).toContainText('5');
  await expect(page.locator('.stat').filter({ has: page.locator('.stat-label', { hasText: /^全部存档$/ }) }).locator('.stat-value')).toContainText('05');
  await expect(page.locator('.snapshots-section h2')).toContainText('05');
  done('All-save tab, timeline and statistics include favorite/protected records, exclude trash/restore points, and keep one theme entry');

  for (const [heading, expected] of [
    ['存档名称', [imported.id, c.id, a.id, b.id, protectedSave.id]], ['存档名称', [protectedSave.id, b.id, a.id, c.id, imported.id]],
    ['创建时间', [protectedSave.id, imported.id, b.id, c.id, a.id]], ['创建时间', [a.id, c.id, b.id, imported.id, protectedSave.id]],
    ['文件大小', [a.id, imported.id, protectedSave.id, c.id, b.id]], ['文件大小', [b.id, protectedSave.id, c.id, imported.id, a.id]],
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
  await expect(page.getByRole('button', { name: '所选保护', exact: true })).toBeDisabled();
  for (const name of ['收藏所选', '取消收藏所选', '收藏全部', '取消收藏全部']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await row(a.id).getByRole('button', { name: /更多操作$/ }).click();
  await expect(page.getByRole('menuitem', { name: '移入回收站', exact: true })).toBeEnabled();
  await page.getByRole('menuitem', { name: '移入回收站', exact: true }).click();
  await expect(dialog.getByRole('note', { name: '包含已收藏存档' })).toContainText('1 份已收藏存档');
  await expect(dialog.getByRole('button', { name: '移入回收站', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await page.screenshot({ path: path.join(screenshots, 'favorite-delete-single.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert(!(await gameState()).snapshots.find(item => item.id === a.id).deletedAt);
  await row(a.id).getByRole('button', { name: /更多操作$/ }).click();
  await page.getByRole('menuitem', { name: '移入回收站', exact: true }).click();
  await dialog.getByRole('button', { name: '移入回收站', exact: true }).click(); await idle();
  assert((await gameState()).snapshots.find(item => item.id === a.id).favorite);
  await page.getByRole('tab', { name: '回收站', exact: true }).click();
  await row(a.id).getByRole('button', { name: '找回', exact: true }).click(); await idle();
  done('A favorite can be deleted through the normal confirmation with a prominent notice and recovered with its star intact');

  await page.getByRole('tab', { name: '已收藏', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await page.getByRole('checkbox', { name: '全选当前列表', exact: true }).check();
  await expect(page.getByRole('button', { name: '所选保护', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '删除所选', exact: true })).toBeDisabled();
  await row(protectedSave.id).getByRole('button', { name: /更多操作$/ }).click();
  await expect(page.getByRole('menuitem', { name: '移入回收站', exact: true })).toBeDisabled();
  await page.getByRole('heading', { name: '验证游戏 A', exact: true }).click();
  await page.getByRole('button', { name: '所选保护', exact: true }).click(); await idle();
  await expect(page.getByRole('button', { name: '所选取消保护', exact: true })).toBeEnabled();
  assert((await gameState()).snapshots.filter(item => [a.id, protectedSave.id].includes(item.id)).every(item => item.protected && item.favorite));
  await page.getByRole('button', { name: '所选取消保护', exact: true }).click(); await idle();
  await expect(page.getByRole('button', { name: '所选保护', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '删除所选', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '所选保护', exact: true }).click(); await idle();
  await expect(page.getByRole('button', { name: '删除所选', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '所选取消保护', exact: true }).click(); await idle();
  assert.equal((await gameState()).snapshots.length, 6);
  done('Selected protection toggles correctly for mixed, entirely unprotected and entirely protected records; protection blocks deletion');

  await page.getByRole('tab', { name: '全部存档', exact: true }).click();
  await expect(rows).toHaveCount(5);
  await row(a.id).getByRole('checkbox').check(); await row(b.id).getByRole('checkbox').check();
  await page.getByRole('button', { name: '删除所选', exact: true }).click();
  await expect(dialog.locator('.batch-confirm-list li')).toHaveCount(2);
  await expect(dialog.locator('.favorite-delete-tag')).toHaveCount(1);
  await expect(dialog.getByRole('note', { name: '包含已收藏存档' })).toContainText('1 份已收藏存档');
  await expect(dialog.getByRole('button', { name: '确认删除 2 份', exact: true })).toBeEnabled();
  await page.screenshot({ path: path.join(screenshots, 'favorite-delete-batch.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal((await gameState()).snapshots.filter(item => item.deletedAt).length, 1);
  await row(b.id).getByRole('checkbox').uncheck(); await row(protectedSave.id).getByRole('checkbox').check();
  await page.getByRole('button', { name: '删除所选', exact: true }).click();
  await expect(dialog.locator('.favorite-delete-tag')).toHaveCount(2);
  await expect(dialog.getByRole('note', { name: '包含已收藏存档' })).toContainText('2 份已收藏存档');
  await dialog.getByRole('button', { name: '确认删除 2 份', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(rows).toHaveCount(3);
  const deletedState = await gameState();
  assert.equal(deletedState.snapshots.length, 6);
  assert.deepEqual(deletedState.snapshots.filter(item => item.deletedAt).map(item => item.id).sort(), [a.id, protectedSave.id, trashed.id].sort());
  assert(deletedState.snapshots.find(item => item.id === a.id).favorite);
  assert(!deletedState.snapshots.find(item => item.id === a.id).protected);
  done('Mixed and favorite-only deletion confirmations count and label starred records without blocking confirmation; cancelling changes nothing');

  await page.getByRole('tab', { name: '回收站', exact: true }).click();
  await expect(rows).toHaveCount(3);
  await row(a.id).getByRole('checkbox').check();
  await row(protectedSave.id).getByRole('checkbox').check();
  await expect(page.getByRole('button', { name: '所选保护', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^全部(取消)?保护$/ })).toHaveCount(0);
  await application.evaluate(({ dialog }, folder) => { globalThis.__pickerCalls = 0; dialog.showOpenDialog = async () => { globalThis.__pickerCalls++; return { canceled: false, filePaths: [folder] }; }; }, exportsDir);
  await page.getByRole('button', { name: '导出所选', exact: true }).click();
  await idle();
  assert.equal(await application.evaluate(() => globalThis.__pickerCalls), 1);
  const [selectedBundleName] = await fs.readdir(exportsDir);
  assert.equal(selectedBundleName, '验证游戏 A-存档导出');
  const selectedBundle = path.join(exportsDir, selectedBundleName);
  const indexDir = path.join(selectedBundle, '.savehub-exports');
  const [selectedIndex] = await fs.readdir(indexDir);
  const selectedCollection = JSON.parse(await fs.readFile(path.join(indexDir, selectedIndex), 'utf8'));
  assert.deepEqual(selectedCollection.snapshots.map(item => item.manifest.id).sort(), [a.id, protectedSave.id].sort());
  assert.equal((await fs.readdir(exportsDir)).length, 1);
  assert.equal((await fs.readdir(selectedBundle)).length, 3);
  for (const item of selectedCollection.snapshots) {
    assert.equal(item.directory, item.manifest.label);
    assert.deepEqual(await fs.readdir(path.join(selectedBundle, item.directory)), ['saves']);
    assert.deepEqual(await fs.readFile(path.join(selectedBundle, item.directory, 'saves/progress.dat')), await fs.readFile(path.join(store.snapshotDir(gameA, item.manifest.id), 'payload/saves/progress.dat')));
  }
  await row(protectedSave.id).getByRole('button', { name: /更多操作$/ }).click();
  await expect(page.getByRole('menuitem', { name: '标记为保护存档', exact: true })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: '标记为保护存档', exact: true })).toHaveAttribute('title', '请先找回存档，再修改保护标记');
  const denied = await page.evaluate(async ({ gameId, id }) => {
    const errors = [];
    for (const batch of [false, true]) {
      try {
        if (batch) await window.savehub.updateSnapshots(gameId, [id], { protected: true });
        else await window.savehub.updateSnapshot(gameId, id, { protected: true });
      } catch (error) { errors.push(error.message); }
    }
    return errors;
  }, { gameId: gameA, id: protectedSave.id });
  assert.equal(denied.length, 2);
  assert(denied.every(message => /先.*找回/.test(message)));
  const markedInTrash = (await gameState()).snapshots.find(item => item.id === protectedSave.id);
  assert(markedInTrash.deletedAt && !markedInTrash.protected);
  await page.getByRole('heading', { name: '验证游戏 A', exact: true }).click();
  await page.getByRole('button', { name: '找回所选', exact: true }).click();
  await expect(rows).toHaveCount(1); await idle();
  await page.getByRole('tab', { name: '已收藏', exact: true }).click();
  await row(protectedSave.id).getByRole('button', { name: /更多操作$/ }).click();
  await expect(page.getByRole('menuitem', { name: '标记为保护存档', exact: true })).toBeEnabled();
  await page.getByRole('menuitem', { name: '标记为保护存档', exact: true }).click(); await idle();
  await page.getByRole('tab', { name: '保护存档', exact: true }).click();
  await expect(rows).toHaveCount(1); await idle();
  assert((await gameState()).snapshots.find(item => item.id === a.id).favorite);
  done('Selected exports create one portable bundle; trash protection is blocked in UI and IPC and becomes available only after recovery');

  await search.fill('没有任何匹配的存档');
  await expect(rows).toHaveCount(0);
  await expect(page.getByRole('button', { name: '全部取消保护', exact: true })).toBeEnabled();
  const protectedExport = await exportTab('保护存档', [protectedSave.id]);
  assert.equal(path.basename(protectedExport.folder), '验证游戏 A-存档导出 (2)');

  await page.getByRole('tab', { name: '已收藏', exact: true }).click();
  await expect(rows).toHaveCount(0);
  await expect(page.getByRole('button', { name: '全部保护', exact: true })).toHaveAttribute('title', /「已收藏」.*2 份/);
  await page.getByRole('button', { name: '全部保护', exact: true }).click(); await idle();
  await expect(page.getByRole('button', { name: '全部取消保护', exact: true })).toBeEnabled();
  assert.deepEqual((await gameState()).snapshots.filter(item => item.protected).map(item => item.id).sort(), [a.id, protectedSave.id].sort());
  await exportTab('已收藏', [a.id, protectedSave.id]);
  await page.getByRole('button', { name: '全部取消保护', exact: true }).click(); await idle();
  assert((await gameState()).snapshots.every(item => !item.protected));
  await page.getByRole('button', { name: '全部保护', exact: true }).click(); await idle();
  await page.getByRole('tab', { name: '保护存档', exact: true }).click();
  await page.getByRole('button', { name: '全部取消保护', exact: true }).click(); await idle();
  assert((await gameState()).snapshots.every(item => !item.protected));
  await expect(page.getByRole('button', { name: '全部保护', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '导出全部', exact: true })).toBeDisabled();
  done('Favorite-tab protection changes only favorites; protected-tab unprotect empties that tab and disables all actions, independently of search');

  await page.getByRole('tab', { name: '全部存档', exact: true }).click();
  await expect(rows).toHaveCount(0);
  await page.getByRole('button', { name: '全部保护', exact: true }).click(); await idle();
  const allProtectedState = await gameState();
  assert.deepEqual(allProtectedState.snapshots.filter(item => item.protected).map(item => item.id).sort(), [a.id, b.id, c.id, imported.id, protectedSave.id].sort());
  assert.deepEqual(allProtectedState.snapshots.filter(item => item.favorite).map(item => item.id).sort(), [a.id, protectedSave.id].sort());
  assert(allProtectedState.restorePoints.every(item => !item.protected));
  assert.equal(allProtectedState.snapshots.find(item => item.id === trashed.id).protected, false);
  const otherGame = await page.evaluate(async id => (await window.savehub.state()).games.find(game => game.id === id), gameB);
  assert(otherGame.snapshots.every(item => !item.protected));
  const allExport = await exportTab('全部存档', [a.id, b.id, c.id, imported.id, protectedSave.id]);
  assert.equal(allExport.collection.snapshots.find(item => item.manifest.id === a.id).directory, a.label);
  await expect(rows).toHaveCount(0);
  await page.getByRole('button', { name: '全部取消保护', exact: true }).click(); await idle();
  await expect(page.getByRole('button', { name: '全部保护', exact: true })).toBeEnabled();
  assert((await gameState()).snapshots.every(item => !item.protected));
  done('All-save-tab protection and export include every active save while excluding trash, restore points and other games');

  await page.getByRole('tab', { name: '回收站', exact: true }).click();
  await expect(rows).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^全部(取消)?保护$/ })).toHaveCount(0);
  const trashExport = await exportTab('回收站', [trashed.id]);
  assert(trashExport.collection.snapshots.every(item => item.manifest.deletedAt));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(indexDir, selectedIndex), 'utf8')), selectedCollection);

  // A game with only trash must still be able to export that tab.
  const otherIds = otherGame.snapshots.map(item => item.id);
  await page.evaluate(async ({ gameId, ids }) => window.savehub.updateSnapshots(gameId, ids, { deleted: true }), { gameId: gameB, ids: otherIds });
  await page.reload(); await pickGame('验证游戏 B');
  await page.getByRole('tab', { name: '全部存档', exact: true }).click();
  await expect(page.getByRole('button', { name: '导出全部', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: '回收站', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^全部(取消)?保护$/ })).toHaveCount(0);
  await exportTab('回收站', otherIds);
  done('Export all follows every tab including trash-only games; trash has no all-protection button and search does not narrow the export');

  const exportedFiles = await fs.readdir(exportsDir);
  await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await page.getByRole('button', { name: '导出全部', exact: true }).click(); await idle();
  assert.deepEqual(await fs.readdir(exportsDir), exportedFiles);
  done('Cancelling the current-tab export creates no output');

  await pickGame('验证游戏 A'); await search.fill('');
  await page.getByRole('tab', { name: '已收藏', exact: true }).click();
  await row(protectedSave.id).getByRole('button', { name: /更多操作$/ }).click();
  await page.getByRole('menuitem', { name: '标记为保护存档', exact: true }).click(); await idle();
  await page.getByRole('tab', { name: '保护存档', exact: true }).click();
  await application.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, exportsDir);
  await row(protectedSave.id).getByRole('button', { name: /更多操作$/ }).click();
  const { folder: singleBundle } = await exportAndRead(() => page.getByRole('menuitem', { name: '导出存档', exact: true }).click());
  assert.deepEqual((await fs.readdir(singleBundle)).sort(), ['.savehub-exports', protectedSave.label].sort());
  await expect(page.locator('.toast')).toContainText(singleBundle);

  await page.getByRole('button', { name: /^读档恢复点/ }).click();
  await expect(dialog.locator('.restore-points-list .restore-point')).toHaveCount(1);
  const { folder: pointBundle, collection: pointCollection } = await exportAndRead(() => dialog.getByRole('button', { name: /^导出恢复点/ }).click());
  assert.equal(pointCollection.snapshots.length, 1);
  assert.equal(pointCollection.snapshots[0].manifest.id, safetyId);
  assert.deepEqual(await fs.readFile(path.join(pointBundle, pointCollection.snapshots[0].directory, 'saves/progress.dat')), recoveryBytes);
  assert.equal((await fs.readdir(exportsDir)).length, 8);
  done('Single-save and restore-point export actions each create their own complete outer folder');
  await dialog.getByRole('button', { name: '恢复', exact: true }).click();
  await dialog.getByRole('checkbox', { name: '我已关闭游戏，并暂停会写入存档的云同步。', exact: true }).check();
  await dialog.getByRole('button', { name: '确认读档', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.deepEqual(await fs.readFile(path.join(sourceA, 'saves/progress.dat')), recoveryBytes);
  assert.equal((await gameState()).snapshots.length, 6);
  assert.equal((await gameState()).restorePoints.length, 2);
  await page.getByRole('button', { name: /^读档恢复点/ }).click();
  await dialog.getByRole('button', { name: /^移除恢复点/ }).first().click();
  await dialog.getByRole('button', { name: '确认移除 1 份', exact: true }).click(); await idle();
  await expect(dialog.locator('.restore-points-group[aria-label="读档恢复点"] .restore-point')).toHaveCount(1);
  await dialog.locator('.removed-points summary').click();
  await dialog.getByRole('button', { name: '找回', exact: true }).click();
  await expect(dialog.locator('.restore-points-list .restore-point')).toHaveCount(2);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  done('Existing automatic restore points remain accessible, restore actual bytes, and can be removed/recovered separately');

  await page.getByRole('tab', { name: '全部存档', exact: true }).click();
  await expect(rows).toHaveCount(5);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 760));
  assert(await page.locator('main').evaluate(element => element.scrollWidth <= element.clientWidth));
  assert(await page.locator('.snapshot-table').evaluate(element => element.scrollWidth <= element.clientWidth));
  await row(a.id).getByRole('checkbox').check();
  await row(c.id).getByRole('checkbox').check();
  await page.locator('main').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: path.join(screenshots, 'batch-selection.png'), animations: 'disabled' });
  done('Selection controls and all table columns fit the minimum 1080 x 760 desktop window');

  await page.getByRole('button', { name: '取消选择', exact: true }).click();
  await row(protectedSave.id).getByRole('checkbox').check();
  for (const [theme, name] of [['ink', '水墨'], ['tech', '科技'], ['cyber', '赛博朋克'], ['glass', '玻璃拟态']]) {
    await themeButton.click();
    await page.getByRole('button', { name: `切换${name}主题`, exact: true }).click(); await idle();
    await themeButton.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const protect = page.getByRole('button', { name: '全部保护', exact: true });
    const unprotect = page.getByRole('button', { name: '所选取消保护', exact: true });
    await expect(protect).toBeEnabled(); await expect(unprotect).toBeEnabled();
    await expect(protect.locator('svg.lucide-shield-check')).toHaveCount(1);
    await expect(unprotect.locator('svg.lucide-shield-off')).toHaveCount(1);
    const colors = await page.locator('.batch-actions .protection-action').evaluateAll(buttons => buttons.map(button => {
      const style = getComputedStyle(button);
      return { color: style.color, background: style.backgroundColor, border: style.borderTopColor };
    }));
    assert.notEqual(colors[0].color, colors[1].color);
    assert.notEqual(colors[0].background, colors[1].background);
    assert.notEqual(colors[0].border, colors[1].border);
    assert(await page.locator('.batch-actions').evaluate(element => element.scrollWidth <= element.clientWidth));
    await page.locator('.batch-toolbar').screenshot({ path: path.join(screenshots, `protection-actions-${theme}.png`), animations: 'disabled' });
  }
  await page.getByRole('button', { name: '所选取消保护', exact: true }).click(); await idle();
  await expect(page.getByRole('button', { name: '所选保护', exact: true }).locator('svg.lucide-shield-check')).toHaveCount(1);
  await page.getByRole('button', { name: '全部保护', exact: true }).click(); await idle();
  await expect(page.getByRole('button', { name: '全部取消保护', exact: true }).locator('svg.lucide-shield-off')).toHaveCount(1);
  done('Protect and unprotect buttons use distinct shield icons and text/background/border colors in all four themes, with matching selected/all actions');

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
