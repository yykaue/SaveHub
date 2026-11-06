import { AppError } from './errors.mjs';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import {
  atomicJson,
  assertDiskSpace,
  assertNoLinks,
  assertTreeNoLinks,
  cleanItems,
  commitSnapshotDirectory,
  equal,
  exportName,
  fingerprint,
  foldedName,
  inventory,
  safeId,
  statMaybe,
  uniqueExportName,
  within,
  withinOnDisk,
} from './fs-utils.mjs';

import { normalizeRetention } from './retention.mjs';
import { publicIcon } from './game-icons.mjs';
import { progressTask } from './progress.mjs';
import { exportIndexCandidates, writeExport } from './snapshot-export.mjs';
import { applyImportPlan, importReplacementPaths, validateImportPlan } from './snapshot-import.mjs';

const digest = (/** @type {string} */ text) => createHash('sha256').update(text).digest('hex');
const emptyReport = () => ({
  imported: /** @type {string[]} */ ([]),
  overwritten: /** @type {string[]} */ ([]),
  keptBoth: /** @type {string[]} */ ([]),
  skipped: /** @type {string[]} */ ([]),
  failed: /** @type {{ name: string; error: string }[]} */ ([]),
});
const publicGame = (/** @type {any} */ game) => structuredClone(game);
const publicSavePlan = (/** @type {any} */ plan) => ({
  id: plan.id,
  gameId: plan.gameId,
  directory: plan.directory,
  failed: plan.failed,
  items: plan.items.map((/** @type {any} */ { id, name, source, bytes, fileCount, matches }) => ({
    id,
    name,
    source,
    bytes,
    fileCount,
    matches,
  })),
});

/**
 * 校验并规范化游戏配置输入（名称长度、双平台路径与条目、图标格式及体积、恢复点保留策略）。
 *
 * @param {any} input 原始游戏配置输入
 * @param {any} [existing] 已存在的游戏配置对象（更新或覆盖时传入）
 * @param {string} [lang] 语言代码
 * @returns {import('./models').StoredGame}
 */
export function normalizeGame(input, existing = null, lang = undefined) {
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) {
    throw new AppError('gameTransfer.gameNameLength', undefined, lang);
  }
  /** @type {Record<'win32' | 'darwin', { root: string; items: string[] }>} */
  const locations = { win32: { root: '', items: [] }, darwin: { root: '', items: [] } };
  for (const platform of /** @type {const} */ (['win32', 'darwin'])) {
    const location = input.locations?.[platform] || { root: '', items: [] };
    if (typeof location.root !== 'string' || location.root.length > 4096) {
      throw new AppError('gameTransfer.invalidGameRoot', undefined, lang);
    }
    locations[platform] = { root: location.root.trim(), items: cleanItems(location.items, { allowEmpty: true, lang }) };
  }
  const icon =
    typeof existing?.icon === 'string' && input.icon === publicIcon(existing)
      ? existing.icon
      : typeof input.icon === 'string'
        ? input.icon
        : 'gamepad';
  if (
    !['ring', 'spire', 'flame', 'gamepad', 'swords', 'gem', 'ghost', 'rocket'].includes(icon) &&
    !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(icon)
  ) {
    throw new AppError('gameTransfer.invalidGameIconFormat', undefined, lang);
  }
  if (icon.length > 3_000_000) throw new AppError('gameTransfer.gameIconTooLarge', undefined, lang);
  return {
    ...existing,
    id: existing?.id || randomUUID(),
    name: input.name.trim(),
    subtitle: typeof input.subtitle === 'string' ? input.subtitle.trim().slice(0, 80) : '',
    icon,
    color: /^#[a-f0-9]{6}$/i.test(input.color) ? input.color : '#8a9270',
    locations,
    legacyRoot: typeof input.legacyRoot === 'string' ? input.legacyRoot.trim().slice(0, 4096) : '',
    createdAt: existing?.createdAt || new Date().toISOString(),
    restorePointRetention:
      input.restorePointRetention === undefined
        ? existing?.restorePointRetention || {}
        : normalizeRetention(input.restorePointRetention, true, lang),
  };
}

/**
 * 物理清空已软删除游戏的所有快照目录及相关导入事务日志，但保留游戏元数据本身。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} id 游戏 ID
 */
export async function purgeGameSnapshots(store, id) {
  const game = store.game(id, true);
  if (!game.deletedAt || !game.purgeSnapshotsPending) throw store.error('gameTransfer.gamePurgeSnapshotsNotConfirmed');
  const directory = path.resolve(store.gameDir(id), 'snapshots');
  if (
    !within(store.vault, directory, store.platform) ||
    directory === path.resolve(store.vault) ||
    path.dirname(directory) !== path.resolve(store.gameDir(id))
  ) {
    throw store.error('gameTransfer.gamePurgeSnapshotsOutOfBounds');
  }
  await assertTreeNoLinks(directory, store.lang);
  const journals = await gameImportJournals(store, id);
  await store.fault('before-game-purge-remove', { gameId: id, directory });
  await fs.rm(directory, { recursive: true, force: true });
  for (const file of journals) await fs.rm(file, { force: true });
  store.invalidateGameCache(id);
  const next = { ...game };
  delete next.purgeSnapshotsPending;
  await store.commitGame(next);
  await store.logger.info('purge-game-snapshots', { gameId: id });
}

/**
 * 彻底物理删除已软删除且标记为 `purgeGamePending` 的游戏整个目录及全局配置项。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} id 游戏 ID
 */
export async function purgeGame(store, id) {
  const game = store.game(id, true);
  store.assertGameWritable(id);
  if (!game.deletedAt || !game.purgeGamePending) throw store.error('gameTransfer.gamePurgeNotConfirmed');
  const directory = path.resolve(store.gameDir(id));
  if (
    path.dirname(directory) !== path.resolve(store.vault) ||
    directory === path.resolve(store.vault) ||
    !within(store.vault, directory, store.platform)
  ) {
    throw store.error('gameTransfer.gamePurgeOutOfBounds');
  }
  await assertTreeNoLinks(directory, store.lang);
  const journals = await gameImportJournals(store, id);
  await store.fault('before-game-purge-remove', { gameId: id, directory });
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  for (const file of journals) await fs.rm(file, { force: true });
  store.invalidateGameCache(id);
  await store.fault('before-game-config-delete', { gameId: id });
  // 直接从全局配置中移除该游戏，避免向已删除的游戏目录再次写入 game.json
  await store.forgetGame(id);
  await store.logger.info('purge-game', { gameId: id });
}

/**
 * 查找指定游戏关联的所有导入替换事务日志文件路径。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} gameId 游戏 ID
 */
async function gameImportJournals(store, gameId) {
  const directory = path.join(store.dataDir, 'import-transactions');
  await assertNoLinks(directory, store.lang);
  if (!(await statMaybe(directory))) return [];
  const result = [];
  for (const name of (await fs.readdir(directory)).filter((name) => name.endsWith('.json'))) {
    const file = path.join(directory, name);
    await assertNoLinks(file, store.lang);
    const journal = JSON.parse(await fs.readFile(file, 'utf8'));
    if (journal.gameId !== gameId) continue;
    if (importReplacementPaths(store, journal).file !== file)
      throw store.error('storage.importReplaceIdentityMismatch');
    result.push(file);
  }
  return result;
}

/**
 * 软删除、恢复或彻底删除游戏：
 * - 彻底删除时采用两阶段提交：先将 `purgeGamePending = true` 持久化到配置中，再执行物理删除，保证崩溃后可重试。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} id 游戏 ID
 * @param {boolean} undo 是否恢复已软删除的游戏
 * @param {boolean} deleteRecords 是否彻底删除游戏及其所有快照记录
 */
export async function removeGame(store, id, undo, deleteRecords) {
  if (typeof undo !== 'boolean' || typeof deleteRecords !== 'boolean' || (undo && deleteRecords)) {
    throw store.error('gameTransfer.invalidGameDeleteOptions');
  }
  const game = store.game(id, true);
  store.assertGameWritable(id);
  const pending = game.purgeGamePending || game.purgeSnapshotsPending;
  if (undo && pending) throw store.error('gameTransfer.cannotUndoPendingPurge');
  if (pending && !deleteRecords) throw store.error('gameTransfer.mustRetryPendingPurge');
  if (deleteRecords && game.purgeGamePending) return purgeGame(store, id);
  const next = { ...game };
  if (undo) delete next.deletedAt;
  else next.deletedAt = next.deletedAt || new Date().toISOString();
  if (deleteRecords) {
    // 在持久化删除意图前先检查符号链接；标记写入后若中途崩溃可在启动或下次调用时安全重试
    await assertTreeNoLinks(store.gameDir(id), store.lang);
    next.purgeGamePending = true;
    delete next.purgeSnapshotsPending;
  }
  await store.commitGame(next);
  if (deleteRecords) await purgeGame(store, id);
}

/**
 * 批量导出游戏配置（可选附带所有快照）到指定目录：
 * - 先在 `.savehub-games-<uuid>` 暂存区完成所有 `game.json` 与快照负载的写入和哈希校验；
 * - 全部校验通过后才创建最终导出包目录并原子发布，失败时安全回滚本次已发布内容。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string[]} ids 待导出的游戏 ID 列表
 * @param {string} destination 目标父目录绝对路径
 * @param {boolean} includeSnapshots 是否同时导出游戏下的所有快照
 */
export async function exportGames(store, ids, destination, includeSnapshots) {
  if (typeof includeSnapshots !== 'boolean') throw store.error('gameTransfer.invalidGameExportOptions');
  const selected = store.validateSelection(ids);
  if (selected.length > 1000) throw store.error('gameTransfer.maxGameExportCount');
  const games = selected.map((id) => store.game(id));
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) {
    throw store.error('storage.pickExportDirRequired');
  }
  destination = path.resolve(destination);
  await assertNoLinks(destination, store.lang);
  if (await withinOnDisk(store.dataDir, destination, store.platform)) {
    throw store.error('gameTransfer.cannotExportGamesIntoVault');
  }
  const names = new Set((await fs.readdir(destination)).map(foldedName));
  const folder = path.join(
    destination,
    uniqueExportName(
      `${games.length === 1 ? exportName(games[0].name, store.lang) : 'SaveHub'}-${store.t('gameTransfer.gameExportSuffix')}`,
      names,
    ),
  );
  const stage = path.join(destination, `.savehub-games-${randomUUID()}`);
  const directories = /** @type {string[]} */ ([]),
    taken = new Set(['games.json']),
    published = [];
  let owned = false,
    snapshotCount = 0;
  await fs.mkdir(stage);
  try {
    for (const [gameIndex, game] of games.entries()) {
      await progressTask(
        store,
        'exporting',
        game.name,
        (90 * gameIndex) / games.length,
        (90 * (gameIndex + 1)) / games.length,
        async () => {
          const directory = uniqueExportName(exportName(game.name, store.lang), taken);
          directories.push(directory);
          const target = path.join(stage, directory);
          const config = normalizeGame(game, { id: game.id, createdAt: game.createdAt }, store.lang);
          const snapshots = includeSnapshots ? await store.snapshots(game.id, true) : [];
          if (snapshots.length > 10000) throw store.error('gameTransfer.maxSingleGameSnapshotsExport');
          const totalBytes = snapshots.reduce((sum, item) => sum + (item.bytes || 0), 0);
          await assertDiskSpace(destination, totalBytes, store.lang);
          await atomicJson(path.join(target, 'game.json'), {
            version: 1,
            type: 'savehub-game',
            game: config,
            includesSnapshots: includeSnapshots,
            snapshotCount: snapshots.length,
          });
          if (includeSnapshots) {
            const records = /** @type {{ directory: string; manifest: import('./models').Manifest }[]} */ ([]),
              used = new Set(['.savehub-exports']);
            for (const [index, snapshot] of snapshots.entries()) {
              await progressTask(
                store,
                'exporting',
                snapshot.label,
                (100 * index) / snapshots.length,
                (100 * (index + 1)) / snapshots.length,
                async () => {
                  const meta = await progressTask(store, 'checking', '', 0, 20, () =>
                    store.verify(game.id, snapshot.id),
                  );
                  const name = uniqueExportName(exportName(meta.label, store.lang), used);
                  await progressTask(store, 'exporting', '', 20, 100, () =>
                    writeExport(store, game.id, meta, path.join(target, 'snapshots', name)),
                  );
                  records.push({ directory: name, manifest: meta });
                  snapshotCount++;
                },
              );
            }
            // 没有快照的空游戏也是合法的整包导出，无需生成空的 collection.json
            if (records.length) {
              await atomicJson(path.join(target, 'snapshots', '.savehub-exports', 'collection.json'), {
                version: 2,
                type: 'savehub-collection',
                gameId: game.id,
                snapshots: records,
              });
            }
          }
        },
      );
    }
    await atomicJson(path.join(stage, 'games.json'), {
      version: 1,
      type: 'savehub-games',
      exportedAt: new Date().toISOString(),
      games: directories,
    });
    await store.fault('before-game-export-publish', { folder });
    await fs.mkdir(folder);
    owned = true;
    const publishedNames = await fs.readdir(stage);
    for (const [index, name] of publishedNames.entries()) {
      const target = path.join(folder, name);
      await store.fault('before-game-export-entry-publish', { folder, name, target });
      if ((await fs.lstat(path.join(stage, name))).isDirectory()) {
        await commitSnapshotDirectory(path.join(stage, name), target);
        published.push(target);
      } else {
        const handle = await fs.open(target, 'wx');
        published.push(target);
        try {
          await handle.writeFile(await fs.readFile(path.join(stage, name)));
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      store.onProgress({
        phase: 'exporting',
        detail: name,
        completed: index + 1,
        total: publishedNames.length,
        percent: 90 + (9 * (index + 1)) / publishedNames.length,
      });
    }
    store.onProgress({ phase: 'exporting', detail: '', completed: games.length, total: games.length, percent: 100 });
    return { folder, count: games.length, snapshotCount };
  } catch (error) {
    for (const target of published) {
      if (
        !within(folder, target, store.platform) ||
        target === folder ||
        !within(destination, folder, store.platform)
      ) {
        throw store.error('gameTransfer.gameExportCleanupOutOfBounds');
      }
      await fs.rm(target, { recursive: true, force: true });
    }
    if (owned)
      await fs
        .rmdir(folder)
        .catch((err) => store.logger.warn('export-games-rmdir-failed', { folder, error: err.message }));
    throw error;
  } finally {
    if (!within(destination, stage, store.platform) || stage === destination) {
      await store.logger.error('export-games-stage-cleanup-refused', { stage, destination });
    } else
      await fs
        .rm(stage, { recursive: true, force: true })
        .catch((err) => store.logger.warn('export-games-stage-cleanup-failed', { stage, error: err.message }));
  }
}

/**
 * 查找本地库中与待导入游戏冲突（相同 ID、相同导入源 ID 或忽略大小写同名）的游戏列表。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {any} item 待导入游戏条目
 */
function matches(store, item) {
  return store.config.games
    .filter(
      (/** @type {any} */ game) =>
        game.id === item.game.id ||
        game.importOrigin?.id === item.game.id ||
        foldedName(game.name.trim()) === foldedName(item.game.name.trim()),
    )
    .map(publicGame);
}

/**
 * 读取并校验单个游戏导出目录中的 `game.json` 元数据及其文本 SHA-256 摘要。
 *
 * @param {string} directory 单个游戏导出目录
 * @param {string} [lang] 语言代码
 */
async function readBundle(directory, lang) {
  const file = path.join(directory, 'game.json');
  await assertNoLinks(file, lang);
  const text = await fs.readFile(file, 'utf8');
  if (Buffer.byteLength(text) > 4_000_000) throw new AppError('gameTransfer.gameConfigFileTooLarge', undefined, lang);
  const data = JSON.parse(text);
  if (data.version !== 1 || data.type !== 'savehub-game' || typeof data.includesSnapshots !== 'boolean') {
    throw new AppError('gameTransfer.invalidGameExportFormat', undefined, lang);
  }
  if (
    !Number.isSafeInteger(data.snapshotCount) ||
    data.snapshotCount < 0 ||
    data.snapshotCount > 10000 ||
    (!data.includesSnapshots && data.snapshotCount !== 0)
  ) {
    throw new AppError('gameTransfer.invalidBundleSnapshotCount', undefined, lang);
  }
  safeId(data.game?.id, lang);
  const game = normalizeGame(data.game, { id: data.game.id, createdAt: data.game.createdAt }, lang);
  if (!Number.isFinite(Date.parse(game.createdAt)))
    throw new AppError('gameTransfer.invalidGameCreatedAt', undefined, lang);
  return {
    game,
    file,
    hash: digest(text),
    includesSnapshots: data.includesSnapshots,
    snapshotCount: data.snapshotCount,
  };
}

/**
 * 游戏导入第 1 阶段（Prepare）：
 * 扫描游戏导出目录（支持多游戏包 `games.json` 或单游戏目录 `game.json`），检测本地同名/同 ID 游戏冲突。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} directory 导入源目录
 */
export async function prepareGameImport(store, directory) {
  store.pendingGameImport = null;
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw store.error('gameTransfer.pickGameImportDirRequired');
  }
  directory = path.resolve(directory);
  await assertNoLinks(directory, store.lang);
  if (
    (await withinOnDisk(store.dataDir, directory, store.platform)) ||
    (await withinOnDisk(directory, store.dataDir, store.platform))
  ) {
    throw store.error('gameTransfer.cannotImportGameFromVault');
  }
  let directories = [directory];
  const index = path.join(directory, 'games.json');
  if (await statMaybe(index)) {
    await assertNoLinks(index, store.lang);
    const data = JSON.parse(await fs.readFile(index, 'utf8'));
    if (
      data.version !== 1 ||
      data.type !== 'savehub-games' ||
      !Array.isArray(data.games) ||
      !data.games.length ||
      data.games.length > 1000
    ) {
      throw store.error('gameTransfer.invalidGamesBundleIndex');
    }
    const entries = data.games.map((/** @type {string} */ name) => cleanItems([name], { lang: store.lang })[0]);
    if (
      entries.some((/** @type {string} */ name) => name.includes('/')) ||
      new Set(entries.map(foldedName)).size !== entries.length
    ) {
      throw store.error('gameTransfer.invalidOrDuplicateGamesBundleDir');
    }
    directories = entries.map((/** @type {string} */ name) => path.join(directory, name));
  }
  /** @type {{ id: string; directory: string; items: any[]; failed: { name: string; error: string }[]; review: any }} */
  const plan = { id: randomUUID(), directory, items: [], failed: [], review: null };
  const seen = new Set();
  for (const [index, folder] of directories.entries()) {
    store.onProgress({ phase: 'checking', detail: path.basename(folder), completed: index, total: directories.length });
    try {
      const bundle = await readBundle(folder, store.lang);
      if (seen.has(bundle.game.id) || seen.has(`name:${foldedName(bundle.game.name)}`)) {
        throw store.error('gameTransfer.duplicateGameInBundle');
      }
      seen.add(bundle.game.id);
      seen.add(`name:${foldedName(bundle.game.name)}`);
      /** @type {any} */
      const item = { ...bundle, id: randomUUID(), directory: folder };
      item.matches = matches(store, item);
      plan.items.push(item);
    } catch (error) {
      plan.failed.push({ name: path.basename(folder), error: /** @type {Error} */ (error).message });
    } finally {
      store.onProgress({
        phase: 'checking',
        detail: path.basename(folder),
        completed: index + 1,
        total: directories.length,
      });
    }
  }
  store.pendingGameImport = plan;
  return structuredClone({
    id: plan.id,
    directory,
    failed: plan.failed,
    items: plan.items.map((item) => ({
      id: item.id,
      game: item.game,
      source: item.directory,
      includesSnapshots: item.includesSnapshots,
      matches: item.matches,
    })),
  });
}

/**
 * 获取并校验当前挂起的游戏导入计划。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} id 游戏导入计划 ID
 */
function requirePlan(store, id) {
  if (!store.pendingGameImport || store.pendingGameImport.id !== id) {
    throw store.error('gameTransfer.gameImportPlanExpired');
  }
  return store.pendingGameImport;
}

/**
 * 复核导入源目录中的 `game.json` 哈希及本地冲突匹配列表是否在交互期间发生改变。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {any} plan 游戏导入计划
 */
async function checkGames(store, plan) {
  for (const [index, item] of plan.items.entries()) {
    const data = await readBundle(item.directory, store.lang);
    if (data.hash !== item.hash) throw store.error('gameTransfer.gameImportSourceChanged');
    if (!equal(matches(store, item), item.matches)) throw store.error('gameTransfer.gameConfigOrMatchesChanged');
    store.onProgress({ phase: 'checking', detail: item.game.name, completed: index + 1, total: plan.items.length });
  }
}

/**
 * 游戏导入第 2 阶段（Review）：
 * 根据用户对游戏冲突的决策（覆盖、跳过、保留两者），确定每个游戏的最终目标对象，
 * 并进一步扫描附带的 `snapshots/` 目录以生成快照级冲突计划。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} planId 游戏导入计划 ID
 * @param {any[]} decisions 游戏级冲突决策列表
 */
export async function reviewGameImport(store, planId, decisions) {
  const plan = requirePlan(store, planId);
  plan.review = null;
  await progressTask(store, 'checking', '', 0, 5, () => checkGames(store, plan));
  const duplicates = plan.items.filter((/** @type {any} */ item) => item.matches.length);
  if (!Array.isArray(decisions) || decisions.length !== duplicates.length) {
    throw store.error('gameTransfer.missingGameDuplicateDecisions');
  }
  const choices = new Map(),
    targets = new Set();
  for (const choice of decisions) {
    const item = duplicates.find((/** @type {any} */ item) => item.id === choice?.itemId);
    if (!item || choices.has(item.id) || !['overwrite', 'skip', 'keep-both'].includes(choice.action)) {
      throw store.error('gameTransfer.invalidGameDuplicateDecision');
    }
    if (choice.action === 'overwrite') {
      const target = item.matches.find((/** @type {any} */ game) => game.id === choice.targetId);
      if (!target || targets.has(target.id) || target.purgeGamePending || target.purgeSnapshotsPending) {
        throw store.error('gameTransfer.invalidGameOverwriteTarget');
      }
      store.assertGameWritable(target.id);
      targets.add(target.id);
    }
    choices.set(item.id, structuredClone(choice));
  }
  const taken = new Set([
    ...store.config.games.map((/** @type {any} */ game) => foldedName(game.name)),
    ...plan.items.map((/** @type {any} */ item) => foldedName(item.game.name)),
  ]);
  const resolved = [],
    failed = [...plan.failed];
  for (const [itemIndex, item] of plan.items.entries()) {
    const choice = choices.get(item.id);
    if (choice?.action === 'skip') {
      resolved.push({ item, action: 'skip' });
      continue;
    }
    const target = choice?.action === 'overwrite' ? store.game(choice.targetId, true) : null;
    const game = normalizeGame(item.game, target || { id: randomUUID(), createdAt: item.game.createdAt }, store.lang);
    delete game.deletedAt;
    if (choice?.action === 'keep-both') {
      let number = 2,
        name;
      do {
        const suffix = ` (${number++})`;
        name = item.game.name.slice(0, 80 - suffix.length) + suffix;
      } while (taken.has(foldedName(name)));
      game.name = name;
    }
    taken.add(foldedName(game.name));
    game.importOrigin = { id: item.game.id };
    let snapshotPlan = null;
    const source = path.join(item.directory, 'snapshots');
    if (item.includesSnapshots && item.snapshotCount > 0) {
      // 游戏导出包内仅允许经过校验的 v2 命名导出索引格式
      if (!(await exportIndexCandidates(store, source))) {
        throw store.error('gameTransfer.missingBundleSnapshotIndex');
      }
      snapshotPlan = await progressTask(
        store,
        'checking',
        game.name,
        5 + (95 * itemIndex) / plan.items.length,
        5 + (95 * (itemIndex + 1)) / plan.items.length,
        () => store.prepareImportPlan(game.id, source, { game, bundle: true }),
      );
      if (
        snapshotPlan.items.length + snapshotPlan.failed.length !== item.snapshotCount ||
        snapshotPlan.items.some((/** @type {any} */ save) => save.meta.gameId !== item.game.id)
      ) {
        throw store.error('gameTransfer.bundleSnapshotCountOrOwnerMismatch');
      }
      // 记录索引文件原始字节哈希，防止在 review 与 execute 之间篡改快照元数据
      snapshotPlan.indexHash = await indexHash(source, store.lang);
      failed.push(
        ...snapshotPlan.failed.map((/** @type {any} */ error) => ({ ...error, name: `${game.name} / ${error.name}` })),
      );
    }
    resolved.push({ item, action: choice?.action || 'import', game, snapshotPlan });
  }
  plan.review = { id: randomUUID(), resolved };
  store.onProgress({
    phase: 'checking',
    detail: '',
    completed: plan.items.length,
    total: plan.items.length,
    percent: 100,
  });
  return structuredClone({
    id: plan.review.id,
    planId,
    failed,
    games: resolved.map((entry) => ({
      itemId: entry.item.id,
      name: entry.game?.name || entry.item.game.name,
      action: entry.action,
      snapshots: entry.snapshotPlan ? publicSavePlan(entry.snapshotPlan) : null,
    })),
  });
}

/**
 * 计算 `.savehub-exports/*.json` 索引文件的联合 SHA-256 摘要，用于防篡改校验。
 *
 * @param {string} directory 包含 `.savehub-exports` 的快照目录
 * @param {string} [lang] 语言代码
 */
async function indexHash(directory, lang) {
  const root = path.join(directory, '.savehub-exports');
  await assertNoLinks(root, lang);
  const parts = [];
  for (const file of (await fs.readdir(root)).filter((name) => name.endsWith('.json')).sort()) {
    await assertNoLinks(path.join(root, file), lang);
    parts.push([file, await fs.readFile(path.join(root, file), 'utf8')]);
  }
  return digest(JSON.stringify(parts));
}

/**
 * 游戏导入第 3 阶段（Execute）：
 * 1. 复核所有游戏配置、快照索引哈希及快照源文件指纹未发生并发变动。
 * 2. 逐个提交游戏配置并执行关联的快照导入计划。
 * 3. 所有游戏与快照导入完毕后，统一对本次导入涉及的游戏执行恢复点保留策略清理。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} reviewId 审查阶段生成的令牌 ID
 * @param {any[]} decisions 每个游戏的快照级冲突决策列表
 */
export async function executeGameImport(store, reviewId, decisions) {
  const plan = store.pendingGameImport,
    review = plan?.review;
  if (!review || review.id !== reviewId) throw store.error('gameTransfer.gameImportReviewExpired');
  await progressTask(store, 'checking', '', 0, 5, () => checkGames(store, plan));
  const expected = review.resolved.filter((/** @type {any} */ entry) => entry.snapshotPlan);
  if (!Array.isArray(decisions) || decisions.length !== expected.length) {
    throw store.error('gameTransfer.missingGameSaveDecisions');
  }
  const saveChoices = new Map();
  for (const [decisionIndex, decision] of decisions.entries()) {
    const entry = expected.find((/** @type {any} */ entry) => entry.item.id === decision?.itemId);
    if (!entry || saveChoices.has(entry.item.id)) throw store.error('gameTransfer.invalidGameSaveDecision');
    const snapshotPlan = entry.snapshotPlan;
    if ((await indexHash(snapshotPlan.directory, store.lang)) !== snapshotPlan.indexHash) {
      throw store.error('gameTransfer.bundleSnapshotIndexChanged');
    }
    const choices = await validateImportPlan(store, snapshotPlan, decision.decisions);
    for (const [itemIndex, item] of snapshotPlan.items.entries()) {
      if (choices.get(item.id)?.action === 'skip') continue;
      const start = (decisionIndex + itemIndex / snapshotPlan.items.length) / decisions.length;
      const end = (decisionIndex + (itemIndex + 1) / snapshotPlan.items.length) / decisions.length;
      const data = await progressTask(store, 'checking', item.name, 5 + 15 * start, 5 + 15 * end, () =>
        inventory(item.source, item.entries, {
          allowMissing: Boolean(item.allowMissing),
          lang: store.lang,
          progress: store.onProgress,
        }),
      );
      if (fingerprint(data) !== item.fingerprint) throw store.error('gameTransfer.bundleSnapshotSourceChanged');
    }
    saveChoices.set(entry.item.id, choices);
  }
  store.pendingGameImport = null;
  /** @type {{ games: ReturnType<typeof emptyReport>; snapshots: { gameName: string; report: any }[] }} */
  const report = { games: emptyReport(), snapshots: [] };
  const importedGameIds = new Set();
  report.games.failed.push(...plan.failed);
  for (const [index, entry] of review.resolved.entries()) {
    if (entry.action === 'skip') {
      report.games.skipped.push(entry.item.game.name);
      continue;
    }
    try {
      await progressTask(
        store,
        'importing',
        entry.game.name,
        20 + (75 * index) / review.resolved.length,
        20 + (75 * (index + 1)) / review.resolved.length,
        async () => {
          store.assertGameWritable(entry.game.id);
          await store.commitGame(entry.game);
          importedGameIds.add(entry.game.id);
          report.games[
            entry.action === 'overwrite' ? 'overwritten' : entry.action === 'keep-both' ? 'keptBoth' : 'imported'
          ].push(entry.game.name);
          if (entry.snapshotPlan) {
            report.snapshots.push({
              gameName: entry.game.name,
              report: await applyImportPlan(store, entry.snapshotPlan, saveChoices.get(entry.item.id), entry.game),
            });
          }
        },
      );
    } catch (error) {
      report.games.failed.push({ name: entry.game.name, error: /** @type {Error} */ (error).message });
    }
  }
  // 待所有游戏与快照全部导入完毕后，统一清理自动恢复点与回收站队列
  await progressTask(store, 'pruning', '', 95, 100, async () => {
    for (const id of importedGameIds) await store.pruneRestorePoints(id);
  });
  return report;
}
