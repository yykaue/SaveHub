import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { SaveStore, atomicJson } from '../electron/storage.mjs';
import { runE2E, mockDirectory } from './e2e-harness.mjs';

await runE2E('optimization-interactions', async ({ base, launch, screenshots, done }) => {
  const source = path.join(base, 'source'),
    legacy = path.join(base, 'legacy'),
    destination = path.join(base, 'exports');
  await fs.mkdir(source);
  await fs.mkdir(destination);
  await fs.writeFile(path.join(source, 'save.dat'), 'live-progress');
  const names = [
    'ArchiveFile1-已保护',
    'ArchiveFile2-已收藏',
    'ArchiveFile3-回收站',
    'ArchiveFile4-读档恢复点',
    'ArchiveFile5-已移除的恢复点',
  ];
  for (const [index, name] of names.entries()) {
    const directory = path.join(legacy, name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'save.dat'), Buffer.alloc(16 * 1024 * 1024, 65 + index));
  }
  const store = await new SaveStore(path.join(base, 'data')).init();
  const location = { root: source, items: ['save.dat'] };
  const gameId = await store.upsertGame({ name: '功能优化验证', locations: { win32: location, darwin: location } });
  await store.importLegacy(gameId, legacy);
  const snapshots = (await store.snapshots(gameId)).sort((a, b) => a.label.localeCompare(b.label));
  await store.updateSnapshot(gameId, snapshots[0].id, { protected: true, favorite: true });
  await store.updateSnapshot(gameId, snapshots[1].id, { favorite: true });
  await store.updateSnapshot(gameId, snapshots[2].id, { deleted: true });
  for (const index of [3, 4]) {
    const meta = await store.readSnapshot(gameId, snapshots[index].id);
    meta.kind = 'safety';
    if (index === 4) meta.deletedAt = new Date().toISOString();
    await atomicJson(path.join(store.snapshotDir(gameId, meta.id), 'manifest.json'), meta);
  }
  const application = await launch(store.dataDir);
  const page = await application.firstWindow();
  page.setDefaultTimeout(20000);
  const dialog = page.getByRole('dialog');
  const idle = () => expect(page.locator('.progress-panel')).toHaveCount(0);
  const conflict = (name) => dialog.getByRole('region', { name: `重复存档 ${name}`, exact: true });
  await page.getByRole('button', { name: /^存档库/ }).click();
  await mockDirectory(application, legacy);
  await page.getByRole('button', { name: '导入存档', exact: true }).click();
  await expect(dialog).toHaveAccessibleName('处理重复存档');
  await idle();
  await expect(conflict(names[0]).getByRole('radio', { name: '覆盖', exact: true })).toBeDisabled();
  await expect(conflict(names[0]).getByRole('radio', { name: '跳过', exact: true })).toBeEnabled();
  await expect(conflict(names[0]).getByRole('radio', { name: '两者并存', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: '除保护存档全覆盖', exact: true })).toBeEnabled();
  const protectedItem = conflict(names[0]);
  await expect(protectedItem.locator('.import-state-tags span')).toHaveText(['保护存档', '已收藏']);
  await protectedItem.getByRole('radio', { name: '两者并存', exact: true }).check();
  await expect(protectedItem.locator('.import-state-notice')).toContainText('不能覆盖');
  await expect(protectedItem.locator('.import-state-tags span')).toHaveText(['保护存档', '已收藏']);
  await protectedItem.getByRole('radio', { name: '跳过', exact: true }).check();
  const stateNames = ['已收藏', '回收站', '读档恢复点', '已移除的恢复点'];
  for (let i = 1; i < names.length; i++) {
    const item = conflict(names[i]);
    await expect(item.getByRole('radio', { name: '跳过', exact: true })).toBeChecked();
    await expect(item.locator('.import-state-tags')).toHaveText(stateNames[i - 1]);
    for (const action of ['覆盖', '跳过', '两者并存']) {
      await expect(item.getByRole('radio', { name: action, exact: true })).toBeEnabled();
      await item.getByRole('radio', { name: action, exact: true }).check();
      await expect(item.locator('.import-state-tags')).toHaveText(stateNames[i - 1]);
      if (action === '覆盖') {
        await expect(item.locator('.import-state-notice')).toContainText('保留这些状态');
        if (i >= 3) await expect(item.locator('.import-state-notice')).toContainText('按恢复点保留数量整理');
      } else {
        await expect(item.locator('.import-state-notice')).not.toContainText('覆盖将替换');
      }
    }
  }
  await dialog.getByRole('button', { name: '除保护存档全覆盖', exact: true }).click();
  for (const name of names.slice(1))
    await expect(conflict(name).getByRole('radio', { name: '覆盖', exact: true })).toBeChecked();
  await expect(protectedItem.getByRole('radio', { name: '跳过', exact: true })).toBeChecked();
  await expect(dialog.locator('.import-choice-summary')).toHaveText('新导入 0 · 覆盖 4 · 跳过 1 · 两者并存 0');
  const protectedBefore = await store.readSnapshot(gameId, snapshots[0].id);
  await page.screenshot({ path: path.join(screenshots, 'overwrite-state-warnings.png') });
  done(
    'All five local states stay visible across skip, overwrite and coexistence; bulk overwrite selects all eligible states and excludes protected saves',
  );

  await page.evaluate(() => {
    window.__progressFrames = [];
    const observer = new MutationObserver(() => {
      const bar = document.querySelector('[role="progressbar"]');
      if (bar)
        window.__progressFrames.push({ value: bar.getAttribute('aria-valuenow'), text: bar.parentElement.textContent });
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await dialog.getByRole('button', { name: '执行导入', exact: true }).click();
  await expect(page.getByRole('progressbar')).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, 'import-progress.png') });
  await expect(dialog).toHaveAccessibleName('导入结果');
  await idle();
  await expect(dialog.locator('.import-summary > span').filter({ hasText: '已覆盖' }).locator('strong')).toHaveText(
    '4',
  );
  await expect(dialog.locator('.import-summary > span').filter({ hasText: '已跳过' }).locator('strong')).toHaveText(
    '1',
  );
  await expect(dialog.locator('.import-summary > span').filter({ hasText: '未能导入' }).locator('strong')).toHaveText(
    '0',
  );
  assert.deepEqual(await store.readSnapshot(gameId, snapshots[0].id), protectedBefore);
  let frames = await page.evaluate(() => window.__progressFrames);
  assert(frames.some((p) => p.value !== null && Number(p.value) > 0 && Number(p.value) < 100));
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  const after = (await page.evaluate(() => window.savehub.state())).games.find((game) => game.id === gameId);
  assert(after.snapshots.find((p) => p.id === snapshots[0].id).protected);
  assert(after.snapshots.find((p) => p.id === snapshots[1].id).favorite);
  assert(after.snapshots.find((p) => p.id === snapshots[2].id).deletedAt);
  assert(after.restorePoints.find((p) => p.id === snapshots[4].id).deletedAt);

  await mockDirectory(application, destination);
  await page.evaluate(() => {
    window.__progressFrames = [];
  });
  await page.getByRole('button', { name: '导出全部', exact: true }).click();
  await expect(page.getByRole('progressbar')).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, 'export-progress.png') });
  await idle();
  frames = await page.evaluate(() => window.__progressFrames);
  assert(frames.some((p) => p.value !== null && Number(p.value) > 0 && Number(p.value) < 100));
  assert.equal((await fs.readdir(destination)).length, 1);
  done(
    'Real imports and exports display a determinate progress bar and changing percentages while copying synthetic files',
  );

  await page.getByRole('button', { name: '设置与关于', exact: true }).click();
  const limit = page.getByRole('textbox', { name: '日志总容量（MB）', exact: true });
  await expect(limit).toHaveValue('20');
  await limit.fill('0');
  await page.getByRole('button', { name: '保存日志设置', exact: true }).click();
  await idle();
  assert.equal((await page.evaluate(() => window.savehub.state())).logLimitMB, 0);
  const logFiles = (await fs.readdir(store.logger.logDir, { recursive: true })).filter((file) =>
    /\.(jsonl|log)$/.test(file),
  );
  assert.deepEqual(logFiles, []);
  await page.reload();
  await page.getByRole('button', { name: '设置与关于', exact: true }).click();
  await expect(limit).toHaveValue('0');
  await limit.fill('1');
  await page.getByRole('button', { name: '保存日志设置', exact: true }).click();
  await idle();
  assert.equal(JSON.parse(await fs.readFile(store.configFile, 'utf8')).logLimitMB, 1);
  await page.screenshot({ path: path.join(screenshots, 'log-settings.png') });
  await page.getByRole('button', { name: '切换语言', exact: true }).click();
  await idle();
  await expect(page.getByRole('textbox', { name: 'Total log capacity (MB)', exact: true })).toHaveValue('1');
  await page.getByRole('button', { name: 'Switch language', exact: true }).click();
  await idle();
  done(
    'Log capacity defaults to 20 MB, zero clears retained logs, persists after reload, and Chinese/English settings both work',
  );

  for (const theme of ['ink', 'tech', 'cyber', 'glass']) {
    await page.evaluate((theme) => window.savehub.setTheme(theme), theme);
    await page.reload();
    await page.getByRole('button', { name: /^存档库/ }).click();
    await page
      .locator(`[data-snapshot-id="${snapshots[1].id}"]`)
      .getByRole('button', { name: '读档', exact: true })
      .click();
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '确认读档', exact: true })).toBeEnabled();
    const style = await dialog.locator('.restore-warning').evaluate((element) => ({
      fontSize: parseFloat(getComputedStyle(element).fontSize),
      color: getComputedStyle(element).color,
    }));
    assert(style.fontSize >= 16);
    assert(['rgb(196, 63, 70)', 'rgb(255, 119, 119)'].includes(style.color));
    await page.screenshot({ path: path.join(screenshots, `restore-warning-${theme}.png`), animations: 'disabled' });
    await dialog.getByRole('button', { name: '暂不读档', exact: true }).click();
  }
  assert.equal(await fs.readFile(path.join(source, 'save.dat'), 'utf8'), 'live-progress');
  done('All four themes show the larger red restore warning and enable confirmation without a checkbox');
});
