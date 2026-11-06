import { expect } from '@playwright/test';

import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SaveStore, atomicJson } from '../electron/storage.mjs';
import { runE2E } from './e2e-harness.mjs';

await runE2E('import-interactions', async (harness) => {
  const { base, screenshots, errors, checks, done } = harness;
  const source = path.join(base, 'live'),
    legacy = path.join(base, 'legacy');
  await fs.mkdir(path.join(source, 'saves'), { recursive: true });
  await fs.writeFile(path.join(source, 'saves/progress.dat'), 'live-game-untouched');
  const names = ['ArchiveFile1-王城门前', 'ArchiveFile2-地下墓地', 'ArchiveFile3-雪原营地', 'ArchiveFile4-巨龙山顶'];
  const addSource = async (name, value) => {
    const directory = path.join(legacy, name);
    await fs.mkdir(path.join(directory, 'saves'), { recursive: true });
    await fs.writeFile(path.join(directory, 'saves/progress.dat'), value);
    return directory;
  };
  for (const [index, name] of names.entries()) await addSource(name, `original-${index}`);
  const store = await new SaveStore(path.join(base, 'data')).init();
  const location = { root: source, items: ['saves'] };
  const gameId = await store.upsertGame({
    name: '重复导入验证',
    subtitle: 'ISOLATED IMPORT TEST',
    icon: 'ring',
    color: '#8a9270',
    legacyRoot: legacy,
    locations: { win32: location, darwin: location },
  });
  await store.importLegacy(gameId, legacy);
  const originals = (await store.snapshots(gameId)).sort((a, b) => a.label.localeCompare(b.label));
  await store.updateSnapshot(gameId, originals[0].id, { favorite: true });
  await store.updateSnapshot(gameId, originals[3].id, { protected: true });
  const originalMetas = await Promise.all(originals.map((item) => store.readSnapshot(gameId, item.id)));
  await fs.writeFile(path.join(legacy, names[0], 'saves/progress.dat'), 'updated-overwrite');
  await fs.writeFile(path.join(legacy, names[2], 'saves/progress.dat'), 'updated-coexist');
  const newName = 'ArchiveFile5-全新进度';
  await addSource(newName, 'new-save');
  await fs.mkdir(path.join(legacy, 'ArchiveFileBroken'));
  const payload = (item) => path.join(store.snapshotDir(gameId, item.id), 'payload/saves/progress.dat');
  let application, page;

  application = await harness.launch(store.dataDir);
  page = await application.firstWindow();
  await page.getByRole('button', { name: /^存档库/ }).click();
  page.setDefaultTimeout(12000);
  await expect(page.locator('.snapshot-row')).toHaveCount(4);
  await application.evaluate(({ dialog }, directory) => {
    globalThis.__importDirectory = directory;
    globalThis.__importPickerCalls = 0;
    dialog.showOpenDialog = async () => {
      globalThis.__importPickerCalls++;
      return {
        canceled: !globalThis.__importDirectory,
        filePaths: globalThis.__importDirectory ? [globalThis.__importDirectory] : [],
      };
    };
  }, legacy);
  const dialog = page.getByRole('dialog');
  const conflict = (name) => dialog.getByRole('region', { name: `重复存档 ${name}`, exact: true });
  const idle = () => expect(page.locator('.progress-panel')).toHaveCount(0);
  const openImport = async (directory = legacy) => {
    await application.evaluate((_, value) => {
      globalThis.__importDirectory = value;
    }, directory);
    await page.getByRole('button', { name: '导入存档', exact: true }).click();
    await expect(dialog).toHaveAccessibleName('处理重复存档');
    await idle();
  };
  const untouched = async () => {
    assert.equal((await store.snapshots(gameId, true)).length, 4);
    for (const [index, original] of originals.entries()) {
      assert.deepEqual(await store.readSnapshot(gameId, original.id), originalMetas[index]);
      assert.equal(await fs.readFile(payload(original), 'utf8'), `original-${index}`);
    }
  };
  await openImport();
  await expect(dialog.locator('.import-conflict')).toHaveCount(4);
  await expect(dialog).toContainText('另有 1 份新存档');
  await expect(dialog).toContainText('ArchiveFileBroken');
  const overwriteUnprotected = dialog.getByRole('button', { name: '除保护存档全覆盖', exact: true });
  await expect(overwriteUnprotected).toBeEnabled();
  for (const name of names)
    await expect(conflict(name).getByRole('radio', { name: '跳过', exact: true })).toBeChecked();
  await expect(conflict(names[3]).getByRole('radio', { name: '覆盖', exact: true })).toBeDisabled();
  await overwriteUnprotected.click();
  for (const name of names.slice(0, 3))
    await expect(conflict(name).getByRole('radio', { name: '覆盖', exact: true })).toBeChecked();
  await expect(conflict(names[3]).getByRole('radio', { name: '跳过', exact: true })).toBeChecked();
  await expect(dialog.locator('.import-choice-summary')).toHaveText('新导入 1 · 覆盖 3 · 跳过 1 · 两者并存 0');
  await dialog.getByRole('button', { name: '全部并存', exact: true }).click();
  for (const name of names)
    await expect(conflict(name).getByRole('radio', { name: '两者并存', exact: true })).toBeChecked();
  await overwriteUnprotected.click();
  for (const name of names.slice(0, 3))
    await expect(conflict(name).getByRole('radio', { name: '覆盖', exact: true })).toBeChecked();
  await expect(conflict(names[3]).getByRole('radio', { name: '两者并存', exact: true })).toBeChecked();
  await expect(dialog.locator('.import-choice-summary')).toHaveText('新导入 1 · 覆盖 3 · 跳过 0 · 两者并存 1');
  await dialog.getByRole('button', { name: '全部跳过', exact: true }).click();
  await conflict(names[0]).getByRole('radio', { name: '覆盖', exact: true }).check();
  await conflict(names[2]).getByRole('radio', { name: '两者并存', exact: true }).check();
  await expect(dialog.locator('.import-choice-summary')).toHaveText('新导入 1 · 覆盖 1 · 跳过 2 · 两者并存 1');
  await untouched();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await untouched();
  done(
    'One dialog lists every conflict, supports independent and bulk choices, and defers both duplicates and new saves until confirmation',
  );

  await openImport(path.join(legacy, names[3]));
  await expect(overwriteUnprotected).toBeDisabled();
  await expect(dialog.locator('.import-protected-tag')).toHaveText('保护存档');
  await expect(dialog.locator('.import-state-notice')).toContainText('不能覆盖');
  await dialog.getByRole('button', { name: '全部并存', exact: true }).click();
  await expect(overwriteUnprotected).toBeDisabled();
  await expect(dialog.locator('.import-protected-tag')).toHaveText('保护存档');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await untouched();
  done(
    'Bulk overwrite excludes protected targets, preserves their skip/keep-both choices, and is disabled when all targets are protected',
  );

  await openImport();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await untouched();
  await openImport();
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await untouched();
  await openImport();
  await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(dialog).toHaveCount(0);
  await untouched();
  done('Cancel, Escape, close and backdrop dismissal leave every original and pending new save unchanged');

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1060, 720));
  const themeNames = { ink: '水墨', tech: '科技', cyber: '赛博朋克', glass: '玻璃拟态' };
  for (const [theme, name] of Object.entries(themeNames)) {
    await page.getByRole('button', { name: '切换主题', exact: true }).click();
    await page.getByRole('button', { name: `切换${name}主题`, exact: true }).click();
    await idle();
    await page.getByRole('button', { name: '切换主题', exact: true }).click();
    await openImport();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(dialog.getByRole('button', { name: '执行导入', exact: true })).toBeInViewport();
    const dimensions = await dialog.evaluate((element) => ({
      top: element.getBoundingClientRect().top,
      bottom: element.getBoundingClientRect().bottom,
      height: innerHeight,
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    assert(dimensions.top >= 0 && dimensions.bottom <= dimensions.height && dimensions.scrollWidth <= dimensions.width);
    await page.screenshot({ path: path.join(screenshots, `import-conflicts-${theme}.png`), animations: 'disabled' });
    await conflict(names[3]).locator('.import-state-notice').scrollIntoViewIfNeeded();
    await expect(conflict(names[3]).locator('.import-protected-tag')).toBeInViewport();
    await expect(dialog.getByRole('button', { name: '执行导入', exact: true })).toBeInViewport();
    await page.screenshot({ path: path.join(screenshots, `import-protected-${theme}.png`), animations: 'disabled' });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  await untouched();
  done('Conflict dialog, scrollable rows and final action remain usable at the minimum window size in all four themes');

  await page.getByRole('button', { name: '切换语言', exact: true }).click();
  await idle();
  await page.getByRole('button', { name: 'Import Saves', exact: true }).click();
  await expect(dialog).toHaveAccessibleName('Resolve Duplicate Saves');
  await idle();
  await expect(dialog.getByRole('button', { name: 'Overwrite All Except Protected', exact: true })).toBeInViewport();
  await expect(dialog.locator('.import-protected-tag')).toHaveText('Protected Save');
  await expect(dialog.getByRole('button', { name: 'Import Now', exact: true })).toBeInViewport();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Switch language', exact: true }).click();
  await idle();
  done('Protected state labels and the longer bulk overwrite label work in English at minimum window size');

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  const calls = await application.evaluate(() => globalThis.__importPickerCalls);
  // The legacy banner is intentionally hidden once active imports exist; exercise
  // its preload/IPC directory branch without changing that established UI rule.
  const legacyPlan = await page.evaluate((id) => window.savehub.importSnapshots(id, true), gameId);
  assert.equal(legacyPlan.items.filter((item) => item.matches.length).length, 4);
  await page.evaluate((id) => window.savehub.cancelImport(id), legacyPlan.id);
  assert.equal(await application.evaluate(() => globalThis.__importPickerCalls), calls);
  await openImport();
  await conflict(names[0]).getByRole('radio', { name: '覆盖', exact: true }).check();
  await conflict(names[2]).getByRole('radio', { name: '两者并存', exact: true }).check();
  await untouched();
  await dialog.getByRole('button', { name: '执行导入', exact: true }).click();
  await expect(dialog).toHaveAccessibleName('导入结果');
  await idle();
  const expectedCounts = { 新导入: '1', 已覆盖: '1', 两者并存: '1', 已跳过: '2', 未能导入: '1' };
  for (const [label, count] of Object.entries(expectedCounts))
    await expect(dialog.locator('.import-summary > span').filter({ hasText: label }).locator('strong')).toHaveText(
      count,
    );
  const after = await store.snapshots(gameId, true);
  assert.equal(after.length, 6);
  assert.equal(await fs.readFile(payload(originals[0]), 'utf8'), 'updated-overwrite');
  assert.equal((await store.readSnapshot(gameId, originals[0].id)).createdAt, originalMetas[0].createdAt);
  assert((await store.readSnapshot(gameId, originals[0].id)).favorite);
  for (const index of [1, 2, 3]) {
    assert.deepEqual(await store.readSnapshot(gameId, originals[index].id), originalMetas[index]);
    assert.equal(await fs.readFile(payload(originals[index]), 'utf8'), `original-${index}`);
  }
  const copy = after.find((item) => item.label === `${names[2]} (2)`);
  assert(copy && copy.id !== originals[2].id);
  assert.equal(await fs.readFile(payload(copy), 'utf8'), 'updated-coexist');
  assert.equal(await fs.readFile(payload(after.find((item) => item.label === newName)), 'utf8'), 'new-save');
  await page.screenshot({ path: path.join(screenshots, 'import-results.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  done(
    'Legacy directory checks avoid the picker; mixed UI decisions commit once with the correct reports, IDs, bytes, flags and skipped saves',
  );

  await openImport(path.join(legacy, names[2]));
  await expect(dialog.locator('.import-conflict')).toHaveCount(1);
  await expect(conflict(names[2]).getByRole('combobox')).toHaveCount(1);
  await conflict(names[2]).getByRole('combobox').selectOption(copy.id);
  await dialog.getByRole('button', { name: '全部覆盖', exact: true }).click();
  await expect(conflict(names[2]).getByRole('combobox')).toHaveValue(copy.id);
  await expect(conflict(names[2]).getByRole('radio', { name: '覆盖', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: '执行导入', exact: true }).click();
  await expect(dialog).toHaveAccessibleName('导入结果');
  await idle();
  assert.equal((await store.snapshots(gameId)).length, 6);
  assert.equal(await fs.readFile(payload(originals[2]), 'utf8'), 'original-2');
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await openImport(path.join(legacy, names[0]));
  await dialog.getByRole('button', { name: '全部覆盖', exact: true }).click();
  await expect(conflict(names[0]).getByRole('radio', { name: '覆盖', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  done('A single duplicate uses the same dialog and multiple existing copies require an explicit overwrite target');

  await page.evaluate(({ gameId, id }) => window.savehub.updateSnapshot(gameId, id, { protected: true }), {
    gameId,
    id: originals[2].id,
  });
  await openImport();
  const multipleTargets = conflict(names[2]);
  await multipleTargets.getByRole('combobox').selectOption(copy.id);
  await multipleTargets.getByRole('radio', { name: '覆盖', exact: true }).check();
  await multipleTargets.getByRole('combobox').selectOption(originals[2].id);
  await expect(multipleTargets.getByRole('radio', { name: '跳过', exact: true })).toBeChecked();
  await expect(multipleTargets.locator('.import-protected-tag')).toHaveText('保护存档');
  await overwriteUnprotected.click();
  await expect(multipleTargets.getByRole('combobox')).toHaveValue(originals[2].id);
  await expect(multipleTargets.getByRole('radio', { name: '跳过', exact: true })).toBeChecked();
  await expect(conflict(names[0]).getByRole('radio', { name: '覆盖', exact: true })).toBeChecked();
  await multipleTargets.getByRole('combobox').selectOption(copy.id);
  await expect(multipleTargets.locator('.import-state-notice')).toHaveCount(0);
  await overwriteUnprotected.click();
  await expect(multipleTargets.getByRole('combobox')).toHaveValue(copy.id);
  await expect(multipleTargets.getByRole('radio', { name: '覆盖', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.evaluate(({ gameId, id }) => window.savehub.updateSnapshot(gameId, id, { protected: false }), {
    gameId,
    id: originals[2].id,
  });
  assert.equal(await fs.readFile(payload(originals[2]), 'utf8'), 'original-2');
  done(
    'Changing duplicate targets refreshes state badges; bulk overwrite preserves the explicitly selected protected target',
  );

  const fresh = await addSource('独立的新存档', 'fresh-import');
  await application.evaluate((_, directory) => {
    globalThis.__importDirectory = directory;
  }, fresh);
  await page.getByRole('button', { name: '导入存档', exact: true }).click();
  await expect(dialog).toHaveAccessibleName('导入结果');
  await idle();
  await expect(dialog.locator('.import-summary > span').filter({ hasText: '新导入' }).locator('strong')).toHaveText(
    '1',
  );
  assert.equal((await store.snapshots(gameId)).length, 7);
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await application.evaluate(() => {
    globalThis.__importDirectory = null;
  });
  await page.getByRole('button', { name: '导入存档', exact: true }).click();
  await idle();
  await expect(dialog).toHaveCount(0);
  assert.equal((await store.snapshots(gameId)).length, 7);
  done('Non-conflicting imports still finish directly and canceling the native directory picker has no effects');

  for (const snapshot of await store.snapshots(gameId)) await store.verifySnapshot(gameId, snapshot.id);
  assert.equal(await fs.readFile(path.join(source, 'saves/progress.dat'), 'utf8'), 'live-game-untouched');
  assert.equal(await fs.readFile(path.join(legacy, names[0], 'saves/progress.dat'), 'utf8'), 'updated-overwrite');
  assert.equal(await fs.readFile(path.join(legacy, names[2], 'saves/progress.dat'), 'utf8'), 'updated-coexist');
  assert.deepEqual(errors, []);
  const report = {
    success: true,
    date: new Date().toISOString(),
    executable: process.env.SAVEHUB_TEST_EXECUTABLE || 'Electron development runtime',
    fixture: 'Isolated synthetic files; no real game saves.',
    checks,
    rendererErrors: errors,
  };
  await atomicJson(path.join(screenshots, 'import-verification.json'), report);
  console.log(JSON.stringify(report, null, 2));
});
