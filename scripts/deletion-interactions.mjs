import { expect } from '@playwright/test';

import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SaveStore, atomicJson } from '../electron/storage.mjs';
import { runE2E } from './e2e-harness.mjs';

await runE2E('deletion-interactions', async (harness) => {
  const { base, screenshots, errors, checks, done } = harness;
  const source = path.join(base, 'game');
  await fs.mkdir(path.join(source, 'saves'), { recursive: true });
  await fs.writeFile(path.join(source, 'saves/progress.dat'), 'live-game-progress');
  await fs.writeFile(path.join(source, 'unmanaged.txt'), 'keep-unmanaged-file');
  const dataDir = path.join(base, 'data');
  let pendingId;
  const store = await new SaveStore(dataDir, {
    fault: async (phase, item) => {
      if (phase === 'before-purge-remove' && item.id === pendingId) {
        await fs.rm(path.join(item.stage, 'manifest.json'));
        throw new Error('模拟永久删除中断');
      }
    },
  }).init();
  const gameId = await store.upsertGame({
    name: '删除与找回验证',
    icon: 'ring',
    color: '#8a9270',
    legacyRoot: '',
    locations: { win32: { root: source, items: ['saves'] }, darwin: { root: source, items: ['saves'] } },
  });
  const kept = await store.createSnapshot(gameId, { label: '保护记录' });
  await store.updateSnapshot(gameId, kept.id, { protected: true });
  const saves = [];
  for (const label of ['收藏记录 A', '普通记录 B', '普通记录 C'])
    saves.push(await store.createSnapshot(gameId, { label }));
  await store.updateSnapshot(gameId, saves[0].id, { favorite: true });
  await store.updateSnapshots(
    gameId,
    saves.map((item) => item.id),
    { deleted: true },
  );
  const pending = await store.createSnapshot(gameId, { label: '中断后待清理' });
  pendingId = pending.id;
  await store.updateSnapshot(gameId, pending.id, { deleted: true });
  assert.equal((await store.deleteSnapshots(gameId, [pending.id])).failed.length, 1);
  const points = [];
  for (const index of [1, 2, 3]) {
    const { safetyId } = await store.restoreSnapshot(gameId, kept.id);
    await store.updateSnapshot(gameId, safetyId, { label: `恢复点 ${index}` });
    points.push(await store.readSnapshot(gameId, safetyId));
  }
  await store.setTheme('ink');
  let application, page;

  application = await harness.launch(dataDir);
  page = await application.firstWindow();
  await page.getByRole('button', { name: /^存档库/ }).click();
  page.setDefaultTimeout(15000);
  const dialog = page.getByRole('dialog');
  const rows = page.locator('.snapshot-row');
  const row = (id) => page.locator(`[data-snapshot-id="${id}"]`);
  const idle = () => expect(page.locator('.progress-panel')).toHaveCount(0);
  const tab = (name) => page.getByRole('tab', { name, exact: true }).click();
  const all = page.getByRole('checkbox', { name: '全选当前列表', exact: true });
  const active = () => dialog.locator('.restore-points-group[aria-label="读档恢复点"]');
  const removed = () => dialog.locator('.restore-points-group[aria-label="已移除的恢复点"]');
  const openRemoved = async () => {
    if ((await dialog.locator('.removed-points').getAttribute('open')) === null)
      await dialog.locator('.removed-points summary').click();
  };
  const noFile = (id) => assert.rejects(fs.stat(store.snapshotDir(gameId, id)), { code: 'ENOENT' });
  const confirm = async (label) => {
    await dialog.getByRole('button', { name: label, exact: true }).click();
    await idle();
  };

  await expect(rows).toHaveCount(1);
  await expect(row(kept.id)).toBeVisible();
  await tab('回收站');
  await expect(rows).toHaveCount(4);
  await expect(page.getByRole('button', { name: /^全部(取消)?保护$/ })).toHaveCount(0);
  await expect(row(pending.id)).toContainText('永久删除未完成');
  await expect(row(pending.id).getByRole('button', { name: '找回', exact: true })).toBeDisabled();
  await row(pending.id).getByRole('checkbox').check();
  await expect(page.getByRole('button', { name: /^所选(取消)?保护$/ })).toHaveCount(0);
  for (const name of ['找回所选', '导出所选'])
    await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '永久删除所选', exact: true }).click();
  await expect(dialog).toContainText('永久删除，无法恢复');
  await confirm('确认永久删除 1 份');
  await expect(rows).toHaveCount(3);
  await noFile(pending.id);
  assert(
    !(await fs.readdir(path.dirname(store.snapshotDir(gameId, pending.id)))).some((name) => name.includes(pending.id)),
  );
  done(
    'Interrupted deletion stays visible after restart, cannot be recovered or edited, and retry removes its remaining files',
  );

  await row(saves[0].id).getByRole('checkbox').check();
  await row(saves[1].id).getByRole('checkbox').check();
  await expect(all).toHaveAttribute('aria-checked', 'mixed');
  await page.getByRole('button', { name: '永久删除所选', exact: true }).click();
  await expect(dialog.locator('.batch-confirm-list li')).toHaveCount(2);
  await expect(dialog.getByRole('note', { name: '包含已收藏存档' })).toContainText('1 份已收藏存档');
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '确认永久删除 2 份', exact: true })).toBeEnabled();
  await page.screenshot({ path: path.join(screenshots, 'permanent-delete-confirm.png'), animations: 'disabled' });
  await confirm('取消');
  await expect(dialog).toHaveCount(0);
  for (const item of saves) await store.verify(gameId, item.id);
  await page.getByRole('button', { name: '找回所选', exact: true }).click();
  await idle();
  await expect(rows).toHaveCount(1);
  await tab('全部存档');
  await expect(rows).toHaveCount(3);
  for (const item of saves.slice(0, 2)) await row(item.id).getByRole('checkbox').check();
  await page.getByRole('button', { name: '删除所选', exact: true }).click();
  await confirm('确认删除 2 份');
  await tab('回收站');
  await expect(rows).toHaveCount(3);
  await all.check();
  await page.getByRole('button', { name: '找回所选', exact: true }).click();
  await idle();
  await expect(rows).toHaveCount(0);
  await tab('全部存档');
  await expect(rows).toHaveCount(4);
  assert.equal((await store.readSnapshot(gameId, saves[0].id)).favorite, true);
  done(
    'Trash supports selected and select-all recovery; cancelling permanent deletion preserves files and favorite flags',
  );

  await all.check();
  await expect(page.getByRole('button', { name: '删除所选', exact: true })).toBeDisabled();
  await row(kept.id).getByRole('checkbox').uncheck();
  await page.getByRole('button', { name: '删除所选', exact: true }).click();
  await confirm('确认删除 3 份');
  await tab('回收站');
  await expect(rows).toHaveCount(3);
  for (const item of saves.slice(0, 2)) await row(item.id).getByRole('checkbox').check();
  await page.getByRole('button', { name: '永久删除所选', exact: true }).click();
  await confirm('确认永久删除 2 份');
  await expect(rows).toHaveCount(1);
  for (const item of saves.slice(0, 2)) await noFile(item.id);
  await store.verify(gameId, saves[2].id);
  await all.check();
  await page.getByRole('button', { name: '永久删除所选', exact: true }).click();
  await confirm('确认永久删除 1 份');
  await expect(rows).toHaveCount(0);
  await noFile(saves[2].id);
  done(
    'Trash selected deletion removes only selected directories, and select-all physically empties the rest after confirmation',
  );

  await page.getByRole('button', { name: /^读档恢复点/ }).click();
  await expect(active().locator('.restore-point')).toHaveCount(3);
  for (const item of points.slice(0, 2))
    await active()
      .getByRole('checkbox', { name: `选择恢复点 ${item.label}`, exact: true })
      .check();
  await expect(active().getByRole('checkbox', { name: '全选读档恢复点', exact: true })).toHaveAttribute(
    'aria-checked',
    'mixed',
  );
  await active().getByRole('button', { name: '移除所选', exact: true }).click();
  await expect(dialog).toContainText('已移除的恢复点');
  await confirm('取消');
  for (const item of points.slice(0, 2))
    await expect(active().getByRole('checkbox', { name: `选择恢复点 ${item.label}`, exact: true })).toBeChecked();
  await active().getByRole('button', { name: '移除所选', exact: true }).click();
  await confirm('确认移除 2 份');
  await expect(active().locator('.restore-point')).toHaveCount(1);
  await openRemoved();
  await expect(removed().locator('.restore-point')).toHaveCount(2);
  for (const item of points) await store.verify(gameId, item.id);
  await removed()
    .getByRole('checkbox', { name: `选择恢复点 ${points[0].label}`, exact: true })
    .check();
  await removed().getByRole('button', { name: '找回所选', exact: true }).click();
  await idle();
  await expect(active().locator('.restore-point')).toHaveCount(2);
  await removed().getByRole('checkbox', { name: '全选已移除的恢复点', exact: true }).check();
  await removed().getByRole('button', { name: '找回所选', exact: true }).click();
  await idle();
  await expect(active().locator('.restore-point')).toHaveCount(3);
  await expect(removed().locator('.restore-point')).toHaveCount(0);
  done(
    'Restore-point subset removal is reversible, cancel preserves selection, and removed points support subset and select-all recovery',
  );

  await active().getByRole('checkbox', { name: '全选读档恢复点', exact: true }).check();
  await active().getByRole('button', { name: '移除所选', exact: true }).click();
  await confirm('确认移除 3 份');
  await expect(active().locator('.restore-point')).toHaveCount(0);
  await openRemoved();
  await expect(removed().locator('.restore-point')).toHaveCount(3);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 760));
  assert(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth));
  await page.screenshot({ path: path.join(screenshots, 'restore-points-bulk.png'), animations: 'disabled' });
  for (const item of points.slice(0, 2))
    await removed()
      .getByRole('checkbox', { name: `选择恢复点 ${item.label}`, exact: true })
      .check();
  await removed().getByRole('button', { name: '永久删除所选', exact: true }).click();
  await confirm('确认永久删除 2 份');
  await openRemoved();
  await expect(removed().locator('.restore-point')).toHaveCount(1);
  for (const item of points.slice(0, 2)) await noFile(item.id);
  await store.verify(gameId, points[2].id);
  await removed().getByRole('checkbox', { name: '全选已移除的恢复点', exact: true }).check();
  await removed().getByRole('button', { name: '永久删除所选', exact: true }).click();
  await confirm('确认永久删除 1 份');
  await openRemoved();
  await expect(removed().locator('.restore-point')).toHaveCount(0);
  await noFile(points[2].id);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  done(
    'Restore points support select-all removal; removed points support selected and select-all physical deletion at minimum window size',
  );

  // Reproduce an older version's protected trash record without bypassing the new API guard.
  await atomicJson(path.join(store.snapshotDir(gameId, kept.id), 'manifest.json'), {
    ...(await store.readSnapshot(gameId, kept.id)),
    deletedAt: new Date().toISOString(),
  });
  await expect
    .poll(() =>
      page.evaluate(
        async ({ gameId, id }) =>
          (await window.savehub.state()).games
            .find((game) => game.id === gameId)
            .snapshots.find((snapshot) => snapshot.id === id)?.deletedAt,
        { gameId, id: kept.id },
      ),
    )
    .toBeTruthy();
  await page.reload();
  await page.getByRole('button', { name: /^存档库/ }).click();
  await tab('回收站');
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^全部(取消)?保护$/ })).toHaveCount(0);
  await all.check();
  await expect(page.getByRole('button', { name: '永久删除所选', exact: true })).toBeDisabled();
  await row(kept.id)
    .getByRole('button', { name: /更多操作$/ })
    .click();
  await expect(page.getByRole('menuitem', { name: '永久删除', exact: true })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: '取消保护标记', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^所选(取消)?保护$/ })).toHaveCount(0);
  await page.getByRole('menuitem', { name: '找回存档', exact: true }).click();
  await idle();
  await tab('保护存档');
  await expect(rows).toHaveCount(1);
  await row(kept.id)
    .getByRole('button', { name: /更多操作$/ })
    .click();
  await page.getByRole('menuitem', { name: '取消保护标记', exact: true }).click();
  await idle();
  await tab('全部存档');
  await all.check();
  await page.getByRole('button', { name: '删除所选', exact: true }).click();
  await confirm('移入回收站');
  await tab('回收站');
  await all.check();
  await page.getByRole('button', { name: '永久删除所选', exact: true }).click();
  await confirm('确认永久删除 1 份');
  await expect(rows).toHaveCount(0);
  assert.deepEqual(await fs.readdir(path.dirname(store.snapshotDir(gameId, kept.id))), []);
  assert.equal(await fs.readFile(path.join(source, 'saves/progress.dat'), 'utf8'), 'live-game-progress');
  assert.equal(await fs.readFile(path.join(source, 'unmanaged.txt'), 'utf8'), 'keep-unmanaged-file');
  done(
    'Legacy protected trash records require recovery before unprotecting and deleting; all live game files remain unchanged',
  );

  assert.deepEqual(errors, []);
  const report = {
    success: true,
    date: new Date().toISOString(),
    executable: process.env.SAVEHUB_TEST_EXECUTABLE || 'Electron development runtime',
    fixture: 'Isolated synthetic saves; permanent deletion never touches real game data.',
    checks,
    rendererErrors: errors,
  };
  await atomicJson(path.join(screenshots, 'deletion-verification.json'), report);
  console.log(JSON.stringify(report, null, 2));
});
