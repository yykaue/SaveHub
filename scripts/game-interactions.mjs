import { expect } from '@playwright/test';

import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SaveStore, atomicJson } from '../electron/storage.mjs';
import { runE2E } from './e2e-harness.mjs';

await runE2E('game-interactions', async (harness) => {
  const { base, screenshots, errors, checks, done } = harness;
  const source = path.join(base, 'live'),
    destination = path.join(base, 'output'),
    incomingRoot = path.join(base, 'incoming');
  for (const directory of [path.join(source, 'saves'), destination, incomingRoot])
    await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(source, 'saves', 'progress.dat'), 'live-untouched');
  const store = await new SaveStore(path.join(base, 'data'), { platform: 'win32' }).init();
  const input = {
    name: '雪原之旅',
    subtitle: 'FROZEN JOURNEY',
    icon: 'ring',
    color: '#8a9270',
    legacyRoot: '',
    locations: { win32: { root: source, items: ['saves'] }, darwin: { root: '', items: [] } },
  };
  const gameId = await store.upsertGame(input),
    extraId = await store.upsertGame({ ...input, name: '星际漫游', icon: 'rocket' });
  const thirdId = await store.upsertGame({ ...input, name: '峡谷远征', subtitle: 'CANYON EXPEDITION', icon: 'swords' });
  await store.createSnapshot(gameId, { label: '普通记录', note: 'Original note' });
  const protectedSave = await store.createSnapshot(gameId, { label: '保护记录', note: '' });
  const trash = await store.createSnapshot(gameId, { label: '回收站记录', note: '' });
  await store.updateSnapshot(gameId, protectedSave.id, { protected: true, favorite: true });
  await store.updateSnapshot(gameId, trash.id, { deleted: true });
  await store.capture(store.game(gameId), source, ['saves'], { label: '读档恢复点', kind: 'safety' });
  const originalGame = structuredClone(store.game(gameId));
  const incoming = (await store.exportGames([gameId, extraId], incomingRoot, true)).folder;
  const external = await new SaveStore(path.join(base, 'external'), { platform: 'win32' }).init();
  const newId = await external.upsertGame({ ...input, name: '月下城堡', icon: 'ghost' });
  const newBundle = (await external.exportGames([newId], incomingRoot)).folder;
  await fs.cp(path.join(newBundle, '月下城堡'), path.join(incoming, '月下城堡'), { recursive: true });
  const incomingIndex = JSON.parse(await fs.readFile(path.join(incoming, 'games.json'), 'utf8'));
  incomingIndex.games.push('月下城堡');
  await atomicJson(path.join(incoming, 'games.json'), incomingIndex);
  let application, page;
  const diskGames = async () => JSON.parse(await fs.readFile(store.configFile, 'utf8')).games;

  application = await harness.launch(store.dataDir);
  page = await application.firstWindow();
  page.setDefaultTimeout(12000);
  await expect(page.locator('.app-shell')).toBeVisible();
  await application.evaluate(({ dialog }, directory) => {
    globalThis.__gameDirectory = directory;
    dialog.showOpenDialog = async () => ({
      canceled: !globalThis.__gameDirectory,
      filePaths: globalThis.__gameDirectory ? [globalThis.__gameDirectory] : [],
    });
  }, destination);
  const dialog = page.getByRole('dialog');
  const idle = () => expect(page.locator('.progress-panel')).toHaveCount(0);
  const pick = (directory) =>
    application.evaluate((_, value) => {
      globalThis.__gameDirectory = value;
    }, directory);
  const row = (id) => page.locator(`.catalog-game[data-game-id="${id}"]`);
  const navigation = page.getByRole('navigation', { name: '主导航', exact: true });
  await expect(navigation.getByRole('button').first()).toHaveAccessibleName('全部游戏');
  await expect(navigation.getByRole('button', { name: '游戏管理', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-page="games"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: '你的世界，都在这里。', exact: true })).toBeVisible();
  await expect(page.locator('.all-games .page-heading > p')).toHaveText('每个游戏独立管理，让不同的冒险各得其所。');
  await expect(page.locator('.all-games')).toHaveAttribute('data-layout', 'cards');
  await expect(page.locator('.game-card.catalog-game')).toHaveCount(3);
  const visibleOrder = () => page.locator('.catalog-game').evaluateAll((rows) => rows.map((row) => row.dataset.gameId));
  const checkOrder = async (ids) => {
    await expect.poll(visibleOrder).toEqual(ids);
    await expect.poll(async () => (await diskGames()).map((game) => game.id)).toEqual(ids);
    await expect
      .poll(() =>
        page.locator('.game-nav > button').evaluateAll((buttons) => buttons.map((button) => button.dataset.gameId)),
      )
      .toEqual(ids);
    await idle();
  };
  await row(thirdId)
    .locator('.game-reorder-handle')
    .dragTo(row(gameId), { targetPosition: { x: 8, y: 80 } });
  await checkOrder([thirdId, gameId, extraId]);
  const lastCard = await row(extraId).boundingBox();
  assert(lastCard);
  await row(thirdId)
    .locator('.game-reorder-handle')
    .dragTo(row(extraId), { targetPosition: { x: lastCard.width - 8, y: 80 } });
  await checkOrder([gameId, extraId, thirdId]);
  await row(thirdId)
    .locator('.game-reorder-handle')
    .dragTo(row(gameId), { targetPosition: { x: 8, y: 80 } });
  await checkOrder([thirdId, gameId, extraId]);
  await page.getByRole('checkbox', { name: '选择游戏 雪原之旅', exact: true }).check();
  await row(extraId)
    .locator('.game-card-art')
    .dragTo(row(thirdId), { sourcePosition: { x: 90, y: 80 }, targetPosition: { x: 8, y: 80 } });
  await checkOrder([extraId, thirdId, gameId]);
  await row(gameId)
    .getByRole('button', { name: '进入存档库', exact: true })
    .dragTo(row(extraId), { targetPosition: { x: 8, y: 80 } });
  await checkOrder([extraId, thirdId, gameId]);
  await row(extraId)
    .locator('.game-reorder-handle')
    .dragTo(row(thirdId), { targetPosition: { x: 8, y: 80 } });
  await checkOrder([thirdId, extraId, gameId]);
  await row(extraId)
    .locator('.game-reorder-handle')
    .dragTo(row(thirdId), { targetPosition: { x: lastCard.width - 8, y: 80 } });
  await checkOrder([extraId, thirdId, gameId]);
  await expect(page.getByRole('checkbox', { name: '选择游戏 雪原之旅', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: '选择游戏 雪原之旅', exact: true }).uncheck();
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  await expect(page.locator('.management-game')).toHaveCount(3);
  await expect.poll(visibleOrder).toEqual([extraId, thirdId, gameId]);
  await row(gameId).dragTo(row(extraId), { sourcePosition: { x: 140, y: 18 }, targetPosition: { x: 140, y: 8 } });
  await checkOrder([gameId, extraId, thirdId]);
  await row(thirdId)
    .locator('.game-reorder-handle')
    .dragTo(row(gameId), { targetPosition: { x: 140, y: 8 } });
  await checkOrder([thirdId, gameId, extraId]);
  await row(gameId).locator('.game-reorder-handle').press('Home');
  await checkOrder([gameId, thirdId, extraId]);
  await expect(row(gameId).locator('.game-reorder-handle')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await checkOrder([thirdId, gameId, extraId]);
  await page.keyboard.press('ArrowUp');
  await checkOrder([gameId, thirdId, extraId]);
  await page.getByRole('textbox', { name: '搜索游戏名称或副标题' }).fill('FROZEN');
  await expect(page.locator('.catalog-game')).toHaveCount(2);
  await row(extraId)
    .locator('.game-reorder-handle')
    .dragTo(row(gameId), { targetPosition: { x: 140, y: 8 } });
  await expect.poll(visibleOrder).toEqual([extraId, gameId]);
  await idle();
  await page.getByRole('textbox', { name: '搜索游戏名称或副标题' }).fill('');
  await checkOrder([extraId, thirdId, gameId]);
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  await checkOrder([extraId, thirdId, gameId]);
  const handle = row(gameId).locator('.game-reorder-handle');
  await handle.hover();
  await page.mouse.down();
  await row(extraId).hover();
  await row(extraId).hover();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('[data-dragging], [data-drop-position]')).toHaveCount(0);
  await checkOrder([extraId, thirdId, gameId]);
  await row(gameId).locator('.game-reorder-handle').press('Home');
  await checkOrder([gameId, extraId, thirdId]);
  const lastRow = await row(thirdId).boundingBox();
  assert(lastRow);
  await row(gameId)
    .locator('.game-reorder-handle')
    .dragTo(row(thirdId), { targetPosition: { x: 140, y: lastRow.height - 8 } });
  await checkOrder([extraId, thirdId, gameId]);
  await row(gameId).locator('.game-reorder-handle').press('Home');
  await checkOrder([gameId, extraId, thirdId]);
  done(
    'Native dragging of cards, rows and handles persists game order and synchronizes the sidebar; search retains hidden positions, selection survives, reload retains order, keyboard ordering works and Escape cancels without writes',
  );
  await expect(page.getByRole('heading', { name: '你的世界，都在这里。', exact: true })).toBeVisible();
  done(
    'All Games is the default home and first workspace menu; the duplicate management menu is gone and both original presentation styles are available',
  );
  await expect(page.locator('.catalog-game')).toHaveCount(3);
  await page.getByRole('textbox', { name: '搜索游戏名称或副标题' }).fill('雪原');
  await expect(page.locator('.catalog-game')).toHaveCount(1);
  await page.getByRole('textbox', { name: '搜索游戏名称或副标题' }).fill('');
  await page.getByRole('checkbox', { name: '选择游戏 雪原之旅', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择游戏 星际漫游', exact: true }).check();
  await page.getByRole('textbox', { name: '搜索游戏名称或副标题' }).fill('雪原');
  await page.getByRole('button', { name: '卡片视图', exact: true }).click();
  await expect(page.locator('.game-card.catalog-game')).toHaveCount(1);
  await expect(page.getByRole('checkbox', { name: '选择游戏 雪原之旅', exact: true })).toBeChecked();
  await expect(page.getByRole('textbox', { name: '搜索游戏名称或副标题' })).toHaveValue('雪原');
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '选择游戏 雪原之旅', exact: true })).toBeChecked();
  await page.getByRole('textbox', { name: '搜索游戏名称或副标题' }).fill('');
  await page.getByRole('button', { name: '卡片视图', exact: true }).click();
  done(
    'Card/list switching preserves search and cross-view selection while exposing the same edit, import, export and delete actions',
  );
  await page.getByRole('button', { name: '导出所选', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: '一并导出存档记录' })).not.toBeChecked();
  await expect(dialog.locator('.batch-confirm-list li')).toHaveCount(2);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.deepEqual(await fs.readdir(destination), []);
  done(
    'Game management search and selection work; selected export preview defaults to settings only and cancel writes nothing',
  );

  await row(gameId).getByRole('button', { name: '编辑游戏 雪原之旅' }).click();
  await dialog.getByRole('textbox', { name: '副标题' }).fill('LOCAL CONFIGURATION');
  await dialog.getByRole('button', { name: '保存游戏', exact: true }).click();
  await idle();
  await expect(page.locator('[data-page="games"]')).toBeVisible();
  assert.equal((await diskGames()).find((game) => game.id === gameId).subtitle, 'LOCAL CONFIGURATION');
  done('Editing a game from management saves settings and stays on the management page');

  await row(gameId).getByRole('button', { name: '编辑游戏 雪原之旅' }).click();
  await dialog.getByRole('button', { name: '导出游戏', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: '一并导出存档记录' })).not.toBeChecked();
  await dialog.getByRole('button', { name: '导出游戏', exact: true }).click();
  await idle();
  await expect(dialog).toHaveCount(0);
  const defaultBundle = path.join(destination, (await fs.readdir(destination))[0]);
  assert.deepEqual(await fs.readdir(path.join(defaultBundle, '雪原之旅')), ['game.json']);
  await row(gameId).getByRole('button', { name: '导出游戏 雪原之旅', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: '一并导出存档记录' })).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: '一并导出存档记录' }).check();
  await dialog.getByRole('button', { name: '导出游戏', exact: true }).click();
  await idle();
  const combined = path.join(destination, '雪原之旅-游戏导出 (2)', '雪原之旅');
  const combinedConfig = JSON.parse(await fs.readFile(path.join(combined, 'game.json'), 'utf8'));
  assert.equal(combinedConfig.snapshotCount, 4);
  done(
    'Export from game settings reuses the same confirmation and real IPC as the catalog; configuration-only export is the default and all four record types are included when explicitly checked',
  );

  await row(gameId).getByRole('button', { name: '删除游戏 雪原之旅', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: '一并永久删除该游戏的全部存档记录' })).not.toBeChecked();
  await dialog.getByRole('button', { name: '删除游戏', exact: true }).click();
  await idle();
  assert.equal((await store.snapshots(gameId, true)).length, 4);
  await page.getByRole('button', { name: '已删除游戏', exact: false }).click();
  await row(gameId).getByRole('button', { name: '找回游戏' }).click();
  await idle();
  await page.getByRole('button', { name: '当前游戏', exact: false }).click();
  await expect(row(gameId)).toBeVisible();
  done(
    'Default deletion retains protected, trashed and safety records; the deleted-games view restores the game and records',
  );

  const chooseGames = async () => {
    await pick(incoming);
    await page.getByRole('button', { name: '导入游戏', exact: true }).click();
    await idle();
    await expect(dialog).toHaveAccessibleName('导入游戏配置');
    await expect(dialog.locator('.game-import-list .import-conflict')).toHaveCount(3);
    await dialog.getByRole('button', { name: '全部并存', exact: true }).click();
    await expect(dialog.getByRole('radio', { name: '两者并存', exact: true }).first()).toBeChecked();
    await dialog.getByRole('button', { name: '全部跳过', exact: true }).click();
    const main = dialog.getByRole('region', { name: '重复游戏 雪原之旅', exact: true });
    await main.getByRole('radio', { name: '覆盖', exact: true }).check();
  };
  await chooseGames();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  assert.equal((await diskGames()).length, 3);
  await chooseGames();
  await dialog.getByRole('button', { name: '下一步：检查存档', exact: true }).click();
  await idle();
  await expect(dialog).toHaveAccessibleName('确认游戏与存档导入');
  await expect(dialog.locator('.import-conflict')).toHaveCount(4);
  const conflict = (name) => dialog.getByRole('region', { name: `重复存档 雪原之旅 / ${name}`, exact: true });
  await expect(conflict('保护记录').getByRole('radio', { name: '覆盖', exact: true })).toBeDisabled();
  await expect(conflict('保护记录').locator('.import-protected-tag')).toHaveText('保护存档');
  for (const name of ['回收站记录', '读档恢复点']) {
    await expect(conflict(name).getByRole('radio', { name: '覆盖', exact: true })).toBeEnabled();
    await expect(conflict(name).locator('.import-state-notice')).toBeVisible();
    await conflict(name).getByRole('radio', { name: '覆盖', exact: true }).check();
    await expect(conflict(name).locator('.import-state-notice')).toContainText('保留这些状态');
    await conflict(name).getByRole('radio', { name: '跳过', exact: true }).check();
    await expect(conflict(name).locator('.import-state-notice')).toBeVisible();
  }
  await dialog.getByRole('button', { name: '除保护存档全覆盖', exact: true }).click();
  for (const name of ['普通记录', '回收站记录', '读档恢复点'])
    await expect(conflict(name).getByRole('radio', { name: '覆盖', exact: true })).toBeChecked();
  await expect(conflict('保护记录').getByRole('radio', { name: '跳过', exact: true })).toBeChecked();
  await conflict('保护记录').getByRole('radio', { name: '两者并存', exact: true }).check();
  assert.equal((await diskGames()).length, 3);
  assert.equal((await store.snapshots(gameId, true)).length, 4);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal((await diskGames()).find((game) => game.id === gameId).subtitle, 'LOCAL CONFIGURATION');
  done(
    'Game choices and save choices are separate previews; cancellation at either stage retains all configurations and records',
  );

  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1060, 720));
  await chooseGames();
  await dialog.getByRole('button', { name: '下一步：检查存档', exact: true }).click();
  await idle();
  await conflict('普通记录').getByRole('radio', { name: '覆盖', exact: true }).check();
  await conflict('保护记录').getByRole('radio', { name: '两者并存', exact: true }).check();
  await expect(dialog.getByRole('button', { name: '执行导入', exact: true })).toBeInViewport();
  await page.screenshot({ path: path.join(screenshots, 'game-import-review.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: '执行导入', exact: true }).click();
  await idle();
  await expect(dialog).toHaveAccessibleName('游戏导入结果');
  await expect(dialog).toContainText('保护记录 (2)');
  const after = await diskGames();
  assert.equal(after.length, 4);
  assert.equal(after.find((game) => game.id === gameId).subtitle, input.subtitle);
  assert.equal(after.find((game) => game.id === gameId).createdAt, originalGame.createdAt);
  assert.equal((await store.snapshots(gameId, true)).length, 5);
  assert((await store.readSnapshot(gameId, protectedSave.id)).protected);
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  done(
    'At minimum window size, a mixed game/save import executes once: config overwrite, game skip/new import and independent save overwrite/skip/coexistence',
  );

  await pick(null);
  await page.getByRole('button', { name: '导入游戏', exact: true }).click();
  await idle();
  await expect(dialog).toHaveCount(0);
  await chooseGames();
  await dialog
    .getByRole('region', { name: '重复游戏 雪原之旅', exact: true })
    .getByRole('radio', { name: '两者并存', exact: true })
    .check();
  await dialog.getByRole('button', { name: '下一步：检查存档', exact: true }).click();
  await idle();
  await expect(dialog.locator('.import-conflict')).toHaveCount(0);
  await dialog.getByRole('button', { name: '执行导入', exact: true }).click();
  await idle();
  await expect(dialog).toContainText('雪原之旅 (2)');
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  const copy = (await diskGames()).find((game) => game.name === '雪原之旅 (2)');
  assert(copy && copy.id !== gameId);
  assert.equal((await store.snapshots(copy.id, true)).length, 4);
  done(
    'Native picker cancel changes nothing; keeping both games creates a separate numbered game with its own bundled saves',
  );

  await row(gameId).getByRole('button', { name: '删除游戏 雪原之旅', exact: true }).click();
  await dialog.getByRole('checkbox', { name: '一并永久删除该游戏的全部存档记录' }).check();
  await expect(dialog).toContainText('整个游戏资料库目录及 5 份记录');
  await expect(dialog).toContainText('物理删除游戏配置');
  await expect(dialog).toContainText('受保护');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await store.snapshots(gameId, true)).length, 5);
  await row(gameId).getByRole('button', { name: '删除游戏 雪原之旅', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: '一并永久删除该游戏的全部存档记录' })).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: '一并永久删除该游戏的全部存档记录' }).check();
  await dialog.getByRole('button', { name: '彻底删除游戏及存档', exact: true }).click();
  await idle();
  await assert.rejects(fs.stat(store.gameDir(gameId)), { code: 'ENOENT' });
  assert(!(await diskGames()).some((game) => game.id === gameId));
  assert(!(await page.evaluate(() => window.savehub.state())).games.some((game) => game.id === gameId));
  assert.equal((await store.snapshots(copy.id, true)).length, 4);
  await page.getByRole('button', { name: '已删除游戏', exact: false }).click();
  await expect(row(gameId)).toHaveCount(0);
  await expect(page.locator('.quiet-empty')).toContainText('没有符合条件的游戏');
  await page.getByRole('button', { name: '当前游戏', exact: false }).click();
  done(
    'Explicit permanent deletion removes settings from memory and disk and the entire game vault directory; the game cannot be recovered and other games retain their records',
  );

  const themes = { ink: '水墨', tech: '科技', cyber: '赛博朋克', glass: '玻璃拟态' };
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  if (await page.locator('.toast').count()) await page.locator('.toast button').click();
  for (const [layout, label] of [
    ['cards', '卡片视图'],
    ['list', '列表视图'],
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('.all-games')).toHaveAttribute('data-layout', layout);
    await page.screenshot({ path: path.join(screenshots, 'all-games-' + layout + '.png'), animations: 'disabled' });
  }
  await page.getByRole('textbox', { name: '搜索游戏名称或副标题' }).fill('雪原之旅 (2)');
  await page.getByRole('checkbox', { name: '选择游戏 雪原之旅 (2)', exact: true }).check();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1060, 720));
  for (const [theme, name] of Object.entries(themes)) {
    for (const [layout, label] of [
      ['cards', '卡片视图'],
      ['list', '列表视图'],
    ]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.getByRole('button', { name: '切换主题', exact: true }).click();
      await page.getByRole('button', { name: '切换' + name + '主题', exact: true }).click();
      await idle();
      await page.getByRole('button', { name: '切换主题', exact: true }).click();
      await expect(page.locator('[data-page="games"]')).toBeVisible();
      await expect(page.locator('.all-games')).toHaveAttribute('data-layout', layout);
      await expect(page.getByRole('textbox', { name: '搜索游戏名称或副标题' })).toHaveValue('雪原之旅 (2)');
      await expect(page.getByRole('checkbox', { name: '选择游戏 雪原之旅 (2)', exact: true })).toBeChecked();
      await page.screenshot({
        path: path.join(screenshots, 'all-games-' + theme + '-' + layout + '.png'),
        animations: 'disabled',
      });
      assert.equal(
        await page
          .locator('.catalog-game')
          .evaluateAll((rows) => rows.filter((row) => row.scrollWidth > row.clientWidth + 1).length),
        0,
      );
      if (layout === 'list') {
        await row(copy.id).getByRole('button', { name: '编辑游戏 雪原之旅 (2)', exact: true }).click();
        await dialog.getByRole('button', { name: '导出游戏', exact: true }).scrollIntoViewIfNeeded();
        await expect(dialog.getByRole('button', { name: '导出游戏', exact: true })).toBeInViewport();
        assert(await dialog.locator('.dialog-actions').evaluate((footer) => footer.scrollWidth <= footer.clientWidth));
        await page.screenshot({
          path: path.join(screenshots, 'game-settings-' + theme + '-zh.png'),
          animations: 'disabled',
        });
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
      }
    }
  }
  await page.getByRole('button', { name: '切换语言', exact: true }).click();
  await idle();
  await expect(page.getByRole('button', { name: 'All Games', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'All Your Worlds, Right Here.', exact: true })).toBeVisible();
  await expect(page.locator('.all-games .page-heading > p')).toHaveText(
    'Each game is managed independently, giving every adventure its own space.',
  );
  await page.screenshot({ path: path.join(screenshots, 'all-games-heading-en.png'), animations: 'disabled' });
  await row(copy.id).getByRole('button', { name: 'Edit game 雪原之旅 (2)', exact: true }).click();
  await dialog.getByRole('button', { name: 'Export Games', exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole('button', { name: 'Export Games', exact: true })).toBeInViewport();
  assert(await dialog.locator('.dialog-actions').evaluate((footer) => footer.scrollWidth <= footer.clientWidth));
  await page.screenshot({ path: path.join(screenshots, 'game-settings-en.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Export Games', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Include save records', exact: true })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.reload();
  await expect(page.locator('[data-page="games"]')).toBeVisible();
  await expect(page.locator('.all-games')).toHaveAttribute('data-layout', 'list');
  await expect(
    page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button').first(),
  ).toHaveAccessibleName('All Games');
  await expect(page.getByRole('heading', { name: 'All Your Worlds, Right Here.', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Switch language', exact: true }).click();
  await idle();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByRole('heading', { name: '你的世界，都在这里。', exact: true })).toBeVisible();
  await expect(page.locator('.all-games .page-heading > p')).toHaveText('每个游戏独立管理，让不同的冒险各得其所。');
  await expect(
    page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button').first(),
  ).toHaveAccessibleName('全部游戏');
  await page.screenshot({ path: path.join(screenshots, 'all-games-heading-zh.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '卡片视图', exact: true }).click();
  await expect(page.getByRole('heading', { name: '你的世界，都在这里。', exact: true })).toBeVisible();
  assert(!(await diskGames()).some((game) => game.id === gameId));
  done(
    'Both styles work in all four themes at 1060×720; headings and descriptions switch accurately between Chinese and English, English persists after reload, and the view preference is retained',
  );

  assert.equal(await fs.readFile(path.join(source, 'saves', 'progress.dat'), 'utf8'), 'live-untouched');
  assert.deepEqual(errors, []);
  const report = {
    success: true,
    date: new Date().toISOString(),
    fixture: 'Isolated synthetic data; no user game library modified.',
    checks,
    rendererErrors: errors,
  };
  await atomicJson(path.join(screenshots, 'game-management-verification.json'), report);
  console.log(JSON.stringify(report, null, 2));
});
