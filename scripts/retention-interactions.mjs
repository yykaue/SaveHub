import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { SaveStore, atomicJson } from '../electron/storage.mjs';
import { runE2E } from './e2e-harness.mjs';

await runE2E('retention', async (harness) => {
  const { base, done, screenshots } = harness;
  const root = path.join(base, 'live');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'save.dat'), 'fixture');
  const store = await new SaveStore(path.join(base, 'data')).init();
  await store.setRestorePointRetention({ active: 2, removed: 15 });
  const id = await store.upsertGame({
    name: '保留规则验证',
    subtitle: 'RETENTION',
    icon: 'ring',
    color: '#8a9270',
    legacyRoot: '',
    locations: { win32: { root, items: ['save.dat'] }, darwin: { root, items: ['save.dat'] } },
  });
  for (let i = 0; i < 5; i++) {
    const record = await store.capture(store.game(id), root, ['save.dat'], {
      label: `恢复点 ${i + 1}`,
      kind: 'safety',
    });
    record.createdAt = new Date(2020, 0, 5 - i).toISOString();
    record.updatedAt = new Date(2021, 0, i + 1).toISOString();
    await atomicJson(path.join(store.snapshotDir(id, record.id), 'manifest.json'), record);
  }
  await store.pruneRestorePoints(id);
  const application = await harness.launch(store.dataDir),
    page = await application.firstWindow();
  const idle = () => expect(page.locator('.progress-panel')).toHaveCount(0);
  const points = async () => {
    await page.getByRole('button', { name: /^存档库/ }).click();
    await page.getByRole('button', { name: /^读档恢复点/ }).click();
    await page.locator('.removed-points summary').click();
    return page.locator('.removed-points .restore-points-group');
  };
  let removed = await points();
  await expect(page.locator('.restore-points-group').first().locator('.restore-point strong')).toHaveText([
    '恢复点 5',
    '恢复点 4',
  ]);
  await removed.locator('.restore-point-toolbar input').check();
  await expect(removed.getByRole('alert')).toContainText('本次选择 3 条');
  await expect(removed.getByRole('button', { name: '找回所选', exact: true })).toBeDisabled();
  const before = JSON.stringify(await store.snapshots(id, true));
  const rejected = await page.evaluate(async (gameId) => {
    const state = await window.savehub.state();
    const game = state.games.find((game) => game.id === gameId);
    try {
      await window.savehub.updateSnapshots(
        gameId,
        game.restorePoints.filter((point) => point.deletedAt).map((point) => point.id),
        { deleted: false },
      );
      return null;
    } catch (error) {
      return error.message;
    }
  }, id);
  assert(rejected?.includes('3'));
  assert.equal(JSON.stringify(await store.snapshots(id, true)), before);
  done('Modified-time ordering and oversized recovery are enforced in UI and IPC without partial writes');
  await removed.locator('.restore-point input').last().uncheck();
  await removed.getByRole('button', { name: '找回所选', exact: true }).click();
  await idle();
  await expect
    .poll(async () =>
      (await page.locator('.restore-points-group').first().locator('.restore-point strong').allTextContents()).sort(),
    )
    .toEqual(['恢复点 2', '恢复点 3']);
  store.invalidateGameCache(id);
  const recovered = (await store.snapshots(id, true)).filter((point) => !point.deletedAt);
  assert(recovered.every((point) => Date.parse(point.updatedAt) > Date.now() - 60000));
  done('A valid batch recovers into a full queue, refreshes modification time and evicts older records');
  await page.getByRole('dialog').getByRole('button', { name: '关闭对话框', exact: true }).click();
  await page.getByRole('button', { name: '设置与关于', exact: true }).click();
  const active = page.getByRole('textbox', { name: '读档恢复点', exact: true });
  await active.fill('0');
  await page.getByRole('button', { name: '保存保留设置', exact: true }).click();
  await idle();
  removed = await points();
  await expect(removed.getByRole('alert')).toContainText('0');
  for (const button of await removed.getByRole('button', { name: '找回', exact: true }).all())
    await expect(button).toBeDisabled();
  await removed.locator('.restore-point-toolbar input').check();
  await expect(removed.getByRole('button', { name: '找回所选', exact: true })).toBeDisabled();
  await page.screenshot({ path: path.join(screenshots, 'zero-retention.png'), animations: 'disabled' });
  done('Global zero retention persists and disables both single and batch recovery');
  await harness.close(application);
  const emptyApplication = await harness.launch(path.join(base, 'empty')),
    empty = await emptyApplication.firstWindow();
  await expect(empty.locator('.catalog-game')).toHaveCount(0);
  await empty.getByRole('button', { name: '添加游戏', exact: true }).first().click();
  await empty.getByRole('combobox', { name: '可选游戏模板' }).selectOption('slay-the-spire');
  await expect(empty.getByRole('dialog').getByRole('textbox', { name: '游戏名称' })).toHaveValue('杀戮尖塔');
  assert(
    !(await empty.locator('input').evaluateAll((inputs) => inputs.map((input) => input.value).join('\n'))).includes(
      'D:\\Steam',
    ),
  );
  await empty.screenshot({ path: path.join(screenshots, 'empty-library-template.png'), animations: 'disabled' });
  done('Fresh installations start empty and templates never inject author-specific paths');
});
