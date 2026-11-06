import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';

import {
  assertNoLinks,
  assertTreeNoLinks,
  atomicJson,
  cleanItems,
  commitSnapshotDirectory,
  equal,
  fingerprint,
  foldedName,
  inventory,
  publicSnapshot,
  safeId,
  signature,
  statMaybe,
  validateManifest,
  withinOnDisk,
} from './fs-utils.mjs';

import { recoverJournals } from './recovery.mjs';
import { progressTask } from './progress.mjs';
import { namedExportCandidates } from './snapshot-export.mjs';

/**
 * 根据导入覆盖替换事务日志计算目标快照目录、暂存目录、备份目录与日志文件路径。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {any} journal 导入替换事务日志
 */
export function importReplacementPaths(store, journal) {
  if (
    !journal ||
    typeof journal !== 'object' ||
    journal.version !== 1 ||
    !['prepared', 'committed'].includes(journal.status)
  ) {
    throw store.error('storage.invalidImportReplaceJournal');
  }
  const token = safeId(journal.token, store.lang),
    gameId = safeId(journal.gameId, store.lang),
    id = safeId(journal.id, store.lang);
  const root = path.join(store.gameDir(gameId), 'snapshots');
  return {
    target: store.snapshotDir(gameId, id),
    stage: path.join(root, `.pending-${token}`),
    previous: path.join(root, `.replaced-${token}`),
    file: path.join(store.dataDir, 'import-transactions', `${token}.json`),
  };
}

/**
 * 完成或回滚导入覆盖替换事务：
 * - 若状态仍为 `prepared` 且存在 `.replaced-<token>` 备份，则将原快照目录恢复回 `target`；
 * - 确认 `target` 存在后，清理 `.pending-<token>`、`.replaced-<token>` 及事务日志文件，并失效对应缓存。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {any} journal 导入替换事务日志
 */
export async function finishImportReplacement(store, journal) {
  const { target, stage, previous, file } = importReplacementPaths(store, journal);
  for (const location of [target, stage, previous, file]) await assertNoLinks(location, store.lang);
  if (journal.status === 'prepared' && (await statMaybe(previous))) {
    if (await statMaybe(target)) {
      if (await statMaybe(stage)) throw store.error('storage.importReplaceStageConflict');
      await commitSnapshotDirectory(target, stage);
    }
    await commitSnapshotDirectory(previous, target);
  }
  if (!(await statMaybe(target))) throw store.error('storage.importReplaceTargetMissing');
  for (const directory of [stage, previous]) {
    await assertTreeNoLinks(directory, store.lang);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
  await fs.rm(file, { force: true });
  store.invalidateSnapshotCache(journal.gameId, journal.id);
}

/**
 * 事务性替换已有快照（用于导入冲突时选择 `overwrite`）：
 * 1. 校验原快照未被并发修改且未处于受保护或待清除状态。
 * 2. 写入 `prepared` 事务日志，将原快照目录移至 `.replaced-<token>`，再将 `.pending-<token>` 移至目标位置。
 * 3. 更新日志为 `committed` 并清理备份目录；若中途失败则调用 `finishImportReplacement` 自动还原原快照。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} gameId 游戏 ID
 * @param {import('./models').Manifest} original 准备替换的目标快照清单
 * @param {string} stage 已写入新快照数据的 `.pending-<token>` 目录
 * @param {string} token 事务唯一标识
 */
export async function replaceImportedSnapshot(store, gameId, original, stage, token) {
  const current = await store.readSnapshot(gameId, original.id);
  if (!equal(current, original)) {
    throw store.error('storage.importReplaceTargetChanged');
  }
  if (current.protected || current.purgePending) {
    throw store.error('storage.importReplaceTargetForbidden');
  }
  const journal = { version: 1, token, gameId, id: original.id, status: 'prepared' };
  const locations = importReplacementPaths(store, journal);
  if (stage !== locations.stage) throw store.error('storage.importReplaceInvalidStage');
  await assertTreeNoLinks(locations.target, store.lang);
  if (await statMaybe(locations.previous)) throw store.error('storage.importReplaceBackupExists');
  await store.fault('before-import-replace', { gameId, id: original.id });
  await atomicJson(locations.file, journal);
  try {
    await commitSnapshotDirectory(locations.target, locations.previous);
    await store.fault('after-import-backup', { gameId, id: original.id });
    await commitSnapshotDirectory(stage, locations.target);
    await store.fault('after-import-install', { gameId, id: original.id });
    await atomicJson(locations.file, { ...journal, status: 'committed' });
  } catch (error) {
    const errMessage = /** @type {Error} */ (error).message;
    try {
      await store.finishImportReplacement(journal);
    } catch (rollbackError) {
      const rbMessage = /** @type {Error} */ (rollbackError).message;
      await store.logger.error('import-replace-rollback-failed', {
        gameId,
        id: original.id,
        error: errMessage,
        rollbackError: rbMessage,
      });
      throw store.error('storage.importReplaceRollbackFailed', { error: errMessage, rollbackError: rbMessage });
    }
    throw store.error('storage.importReplaceAborted', { error: errMessage });
  }
  // 一旦事务标记为 committed，清理失败不应影响替换成功的结果；残留日志会在下次启动时继续清理
  await store
    .finishImportReplacement({ ...journal, status: 'committed' })
    .catch((err) =>
      store.logger.warn('import-replace-cleanup-deferred', { gameId, id: original.id, error: err.message }),
    );
}

/**
 * 启动时扫描并恢复未完成的导入覆盖替换事务日志。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 */
export async function recoverImportReplacements(store) {
  await recoverJournals(
    store,
    'import-transactions',
    (journal, file) => {
      if (importReplacementPaths(store, journal).file !== file)
        throw store.error('storage.importReplaceIdentityMismatch');
    },
    async (journal) => {
      if (
        store.config.games.some(
          (game) => game.id === journal.gameId && (game.purgeGamePending || game.purgeSnapshotsPending),
        )
      )
        return;
      await store.finishImportReplacement(journal);
      if (journal.status === 'prepared') {
        await store.logger.info('recovered-interrupted-import-replace', {
          operation: 'recovery',
          gameId: journal.gameId,
          id: journal.id,
        });
        store.recoveryMessages.push(store.t('storage.recoveredInterruptedImportReplace'));
      }
    },
  );
}

/**
 * 查找现有快照列表中与待导入候选项冲突（同源路径或同导出快照 ID）的快照。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {any} candidate 待导入候选条目
 * @param {any[]} snapshots 当前游戏已有快照列表
 */
export function importMatches(store, candidate, snapshots) {
  const key = (/** @type {string} */ value) =>
    store.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  // 导入源目录路径唯一标识一个存档来源（即使内容已更新）；而不同源目录中相同内容可能是用户有意保留的检查点
  return snapshots.filter(
    (snapshot) =>
      (snapshot.origin?.path && key(snapshot.origin.path) === key(candidate.source)) ||
      (candidate.bundle &&
        candidate.meta &&
        (snapshot.id === candidate.meta.id ||
          (snapshot.origin?.gameId === candidate.meta.gameId && snapshot.origin?.snapshotId === candidate.meta.id))),
  );
}

/**
 * 扫描指定目录并生成前端可见的快照导入计划。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} gameId 游戏 ID
 * @param {string} directory 待扫描的导入源目录
 */
export async function prepareImport(store, gameId, directory) {
  return store.exclusive(async () => {
    const plan = await store.prepareImportPlan(gameId, directory);
    return structuredClone({
      id: plan.id,
      gameId,
      directory,
      failed: plan.failed,
      items: plan.items.map((item) => ({
        id: item.id,
        name: item.name,
        source: item.source,
        bytes: item.bytes,
        fileCount: item.fileCount,
        matches: item.matches,
      })),
    });
  });
}

/**
 * 取消挂起的快照导入计划。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} planId 导入计划 ID
 */
export function cancelImport(store, planId) {
  if (store.pendingImport?.id === planId) store.pendingImport = null;
}

/**
 * 内部快照导入计划构建逻辑，支持识别 4 种目录结构：
 * 1. v2 命名导出包（包含 `.savehub-exports/*.json`）；
 * 2. v1 批量导出包（包含 `collection.json` 与 `SaveHub-<id>` 子目录）；
 * 3. v1 单快照导出目录（包含 `manifest.json` 与 `payload/`）；
 * 4. 传统备份目录（包含 `ArchiveFile*` 子目录或直接作为存档根目录）。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} gameId 游戏 ID
 * @param {string} directory 导入源目录
 * @param {{ game?: import('./models').StoredGame; bundle?: boolean }} [options] 选项（bundle=true 表示隶属于游戏整包导入）
 */
export async function prepareImportPlan(store, gameId, directory, { game = store.game(gameId), bundle = false } = {}) {
  if (!bundle) {
    store.assertGameWritable(game.id);
    store.pendingImport = null;
  }
  const entries = cleanItems(game.locations[store.platform]?.items || [], { allowEmpty: bundle, lang: store.lang });
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw store.error('storage.pickLegacyDirRequired');
  }
  directory = path.resolve(directory);
  await assertNoLinks(directory, store.lang);
  if (
    (await withinOnDisk(store.dataDir, directory, store.platform)) ||
    (await withinOnDisk(directory, store.dataDir, store.platform))
  ) {
    throw store.error('storage.cannotImportFromVault');
  }
  const manifestFile = path.join(directory, 'manifest.json');
  const collectionFile = path.join(directory, 'collection.json');
  /** @type {import('./models').InternalImportPlan} */
  const plan = { id: randomUUID(), gameId, entries, directory, items: [], failed: [], bundle };
  const existing = await store.snapshots(gameId, true);
  /** @type {any[]} */
  let candidates;
  const namedExports = await namedExportCandidates(store, directory);
  if (namedExports) {
    candidates = namedExports;
  } else if (await statMaybe(collectionFile)) {
    await assertNoLinks(collectionFile, store.lang);
    const collection = JSON.parse(await fs.readFile(collectionFile, 'utf8'));
    if (collection.version !== 1 || collection.type !== 'savehub-collection') {
      throw store.error('storage.invalidCollectionManifest');
    }
    candidates = store.validateSelection(collection.snapshots).map((id) => ({
      name: id,
      id,
      exported: path.join(directory, `SaveHub-${id}`),
    }));
  } else if (await statMaybe(manifestFile)) {
    candidates = [{ name: path.basename(directory), exported: directory }];
  } else {
    const children = await fs.readdir(directory, { withFileTypes: true });
    candidates = children
      .filter((item) => item.isDirectory() && item.name.startsWith('ArchiveFile'))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
      .map((item) => ({ name: item.name, source: path.join(directory, item.name) }));
    if (!candidates.length) candidates = [{ name: path.basename(directory), source: directory }];
  }
  if (candidates.length > 10000) throw store.error('storage.maxImportCandidates');
  for (const [index, candidate] of candidates.entries()) {
    store.onProgress({ phase: 'checking', completed: index, total: candidates.length, detail: candidate.name });
    try {
      if (candidate.exported) {
        const manifest = path.join(candidate.exported, 'manifest.json');
        if (!candidate.meta) await assertNoLinks(manifest, store.lang);
        const meta = candidate.meta || validateManifest(JSON.parse(await fs.readFile(manifest, 'utf8')), store.lang);
        if (candidate.id && candidate.id !== meta.id) {
          throw store.error('storage.exportIdMismatch');
        }
        candidate.name = meta.label;
        if (!bundle && !equal([...meta.entries].sort(), [...entries].sort())) {
          throw store.error('storage.exportEntriesMismatch');
        }
        if (
          bundle &&
          (!['manual', 'imported', 'safety'].includes(meta.kind) ||
            !['win32', 'darwin'].includes(meta.platform) ||
            !Number.isFinite(Date.parse(meta.createdAt)) ||
            (meta.deletedAt && !Number.isFinite(Date.parse(meta.deletedAt))) ||
            meta.purgePending)
        ) {
          throw store.error('storage.bundleSnapshotInvalidState');
        }
        candidate.bundle = bundle;
        candidate.entries = bundle ? meta.entries : entries;
        candidate.source = candidate.meta ? candidate.exported : path.join(candidate.exported, 'payload');
        candidate.allowMissing = meta.absent.length > 0;
        candidate.meta = meta;
        candidate.note = meta.note;
        candidate.favorite = meta.favorite;
        candidate.protected = meta.protected;
      }
      const data = await progressTask(
        store,
        'checking',
        candidate.name,
        (100 * index) / candidates.length,
        (100 * (index + 1)) / candidates.length,
        () =>
          inventory(candidate.source, candidate.entries || entries, {
            allowMissing: Boolean(candidate.allowMissing),
            lang: store.lang,
            progress: store.onProgress,
          }),
      );
      if (candidate.meta && signature(data) !== signature(candidate.meta)) {
        throw store.error('storage.exportIntegrityFailed');
      }
      plan.items.push({
        ...candidate,
        id: randomUUID(),
        fingerprint: fingerprint(data),
        bytes: data.records.reduce((total, record) => total + (record.size || 0), 0),
        fileCount: data.records.filter((record) => record.type === 'file').length,
        matches: importMatches(store, candidate, existing),
      });
    } catch (error) {
      plan.failed.push({ name: candidate.name, error: /** @type {Error} */ (error).message });
    } finally {
      store.onProgress({ phase: 'checking', completed: index + 1, total: candidates.length, detail: candidate.name });
    }
  }
  if (!bundle) store.pendingImport = plan;
  return plan;
}

/**
 * 在互斥锁保护下执行已准备好的快照导入计划。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} planId 导入计划 ID
 * @param {import('../shared/contracts').ImportDecision[]} decisions 冲突处理决策列表
 */
export async function executeImport(store, planId, decisions) {
  return store.exclusive(() => store.executeImportPlan(planId, decisions));
}

/**
 * 校验并执行挂起的快照导入计划，全部导入完成后统一执行恢复点保留策略清理。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} planId 导入计划 ID
 * @param {import('../shared/contracts').ImportDecision[]} decisions 冲突处理决策列表
 */
export async function executeImportPlan(store, planId, decisions) {
  const plan = store.pendingImport;
  if (!plan || plan.id !== planId) throw store.error('storage.importPlanExpired');
  const game = store.game(plan.gameId);
  store.assertGameWritable(game.id);
  const choices = await validateImportPlan(store, plan, decisions);
  store.pendingImport = null; // 导入计划令牌为一次性消费，即使中途部分失败也不可重放
  const report = await progressTask(store, 'importing', '', 0, 95, () => applyImportPlan(store, plan, choices, game));
  // 仅在批次内所有导入/覆盖/跳过操作全部完成后，才统一执行恢复点与回收站保留策略清理
  const pruned = await progressTask(store, 'pruning', '', 95, 100, () => store.pruneRestorePoints(game.id));
  if (pruned && (pruned.movedCount || pruned.purgedCount)) {
    report.pruned = pruned;
  }
  return report;
}

/**
 * 校验用户提交的冲突决策是否完整、目标快照是否合法，并复核库内冲突匹配集合是否发生并发变动。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {import('./models').InternalImportPlan} plan 内部导入计划
 * @param {import('../shared/contracts').ImportDecision[]} decisions 冲突处理决策列表
 */
export async function validateImportPlan(store, plan, decisions) {
  if (
    !plan.bundle &&
    !equal(
      cleanItems(store.game(plan.gameId).locations[store.platform]?.items || [], { lang: store.lang }),
      plan.entries,
    )
  ) {
    throw store.error('storage.gameConfigChangedDuringImport');
  }
  const duplicates = plan.items.filter((item) => item.matches.length);
  if (!Array.isArray(decisions) || decisions.length !== duplicates.length) {
    throw store.error('storage.missingDuplicateDecisions');
  }
  const choices = new Map(),
    targets = new Set();
  for (const decision of decisions) {
    const item = duplicates.find((item) => item.id === decision?.itemId);
    if (!item || choices.has(item.id) || !['overwrite', 'skip', 'keep-both'].includes(decision.action)) {
      throw store.error('storage.invalidDuplicateDecision');
    }
    if (decision.action === 'overwrite') {
      const target = item.matches.find((snapshot) => snapshot.id === decision.targetId);
      if (!target || targets.has(target.id)) {
        throw store.error('storage.duplicateOverwriteTarget');
      }
      if (target.protected || target.purgePending || target.corrupted) {
        throw store.error('storage.importReplaceTargetForbidden');
      }
      targets.add(target.id);
    }
    choices.set(item.id, decision);
  }
  // 在提交批次中的任何条目之前，重新扫描库内快照以拒绝基于过期冲突列表做出的决策
  store.invalidateGameCache(plan.gameId);
  const existing = await store.snapshots(plan.gameId, true);
  for (const item of plan.items) {
    if (!equal(importMatches(store, item, existing), item.matches)) {
      throw store.error('storage.duplicateMatchesChanged');
    }
  }
  return choices;
}

/**
 * 按冲突处理决策逐条执行快照捕获（新增、覆盖替换或自动重命名保留两者）。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {import('./models').InternalImportPlan} plan 内部导入计划
 * @param {import('./models').ImportChoices} choices 决策映射表
 * @param {import('./models').StoredGame} game 目标游戏对象
 */
export async function applyImportPlan(store, plan, choices, game) {
  const existing = await store.snapshots(game.id, true);
  /** @type {import('../shared/contracts').ImportReport} */
  const report = { imported: [], overwritten: [], keptBoth: [], skipped: [], failed: [...plan.failed] };
  const names = new Set([
    ...existing.map((item) => foldedName(item.label)),
    ...plan.items.map((item) => foldedName(item.name.slice(0, 100))),
  ]);
  for (const [index, item] of plan.items.entries()) {
    store.onProgress({ phase: 'importing', completed: index, total: plan.items.length, detail: item.name });
    const choice = choices.get(item.id);
    if (choice?.action === 'skip') {
      report.skipped.push(item.name);
      store.onProgress({ phase: 'importing', completed: index + 1, total: plan.items.length, detail: item.name });
      continue;
    }
    try {
      let label = item.name.slice(0, 100);
      if (choice?.action === 'keep-both') {
        let number = 2;
        do {
          const suffix = ` (${number++})`;
          label = item.name.slice(0, 100 - suffix.length) + suffix;
        } while (names.has(foldedName(label)));
      }
      if (choice?.action === 'overwrite' && !choice.targetId) throw store.error('storage.invalidDuplicateDecision');
      const replace =
        choice?.action === 'overwrite' && choice.targetId
          ? await store.readSnapshot(game.id, choice.targetId)
          : undefined;
      if (
        replace &&
        !equal(
          publicSnapshot(replace),
          item.matches.find((target) => target.id === replace.id),
        )
      ) {
        throw store.error('storage.overwriteTargetChanged');
      }
      await progressTask(
        store,
        'importing',
        item.name,
        (100 * index) / plan.items.length,
        (100 * (index + 1)) / plan.items.length,
        () =>
          store.capture(game, item.source, item.entries || plan.entries, {
            label,
            note: item.note || store.t('storage.importedFromNote', { source: item.source }),
            kind: 'imported',
            allowMissing: Boolean(item.allowMissing),
            origin: {
              path: item.source,
              ...(item.bundle && item.meta ? { gameId: item.meta.gameId, snapshotId: item.meta.id } : {}),
            },
            favorite: item.favorite,
            protected: item.protected,
            expectedFingerprint: item.fingerprint,
            replace,
            metadata:
              item.meta && (item.bundle || item.meta.kind === 'safety')
                ? {
                    kind: item.meta.kind,
                    platform: item.meta.platform,
                    createdAt: item.meta.createdAt,
                    updatedAt: item.meta.updatedAt || item.meta.createdAt,
                    ...(item.meta.deletedAt ? { deletedAt: item.meta.deletedAt } : {}),
                  }
                : undefined,
          }),
      );
      names.add(foldedName(label));
      if (choice?.action === 'overwrite') report.overwritten.push(item.name);
      else if (choice?.action === 'keep-both') report.keptBoth.push(label);
      else report.imported.push(item.name);
    } catch (error) {
      report.failed.push({ name: item.name, error: /** @type {Error} */ (error).message });
    } finally {
      store.onProgress({ phase: 'importing', completed: index + 1, total: plan.items.length, detail: item.name });
    }
  }
  return report;
}

/**
 * 快捷导入传统备份目录（对所有已存在的冲突项自动采用 `skip` 策略）。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} gameId 游戏 ID
 * @param {string} directory 传统备份目录路径
 */
export async function importLegacy(store, gameId, directory) {
  return store.exclusive(async () => {
    const plan = await store.prepareImportPlan(gameId, directory);
    return store.executeImportPlan(
      plan.id,
      plan.items.filter((item) => item.matches.length).map((item) => ({ itemId: item.id, action: 'skip' })),
    );
  });
}
