import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';

import {
  assertDiskBudgets,
  assertNoLinks,
  assertTreeNoLinks,
  atomicJson,
  cleanItems,
  copyRecords,
  equal,
  inventory,
  safeId,
  signature,
  statMaybe,
} from './fs-utils.mjs';

import { recoverJournals, validateRestoreJournal } from './recovery.mjs';

/**
 * 暂存区签名（仅比对路径、类型与字节大小，不包含 mtimeMs）。
 * 因为 copyRecords 通过 fs.utimes 恢复时间戳时可能丢失亚毫秒精度（如 APFS），
 * 暂存区与快照 manifest 的预检不应因时间戳亚毫秒截断而误报失败。
 */
const stageSignature = (/** @type {{ absent: string[]; records: any[] }} */ value) =>
  JSON.stringify({
    absent: value.absent,
    records: value.records.map(({ path: file, type, size }) => ({ path: file, type, size })),
  });

/**
 * 元数据签名（包含路径、类型、字节大小与 mtimeMs）。
 * 用于快速比对安全备份后实时游戏目录是否在准备阶段被外部进程修改，避免重复计算全量 SHA-256。
 */
const metadataSignature = (/** @type {{ absent: string[]; records: any[] }} */ value) =>
  JSON.stringify({
    absent: value.absent,
    records: value.records.map(({ path: file, type, size, mtimeMs }) => ({ path: file, type, size, mtimeMs })),
  });

/**
 * 事务性恢复存档快照：
 * 1. 校验目标快照完整性与配置项一致性，并预估游戏目录与存储库的磁盘空间预算。
 * 2. 自动为当前实时存档创建 safety 恢复点备份。
 * 3. 将目标快照复制到游戏目录下的隐藏暂存区 `.savehub-restore-<txId>/next` 并校验元数据签名。
 * 4. 持久化事务日志（status = 'applying'），按条目将原文件移入 `previous`、新文件移入目标位置，每步更新日志。
 * 5. 对恢复后的实时存档执行全量 SHA-256 签名校验，通过后标记 `committed` 并清理暂存区与事务日志。
 * 6. 若提交前任意步骤失败，则基于事务日志逆序回滚；若回滚也失败，则将该游戏加入 `blockedGames` 熔断名单。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} gameId 游戏 ID
 * @param {string} id 待恢复的快照 ID
 */
export async function restoreSnapshot(store, gameId, id) {
  return store.exclusive(async () => {
    const game = store.game(gameId);
    store.assertGameWritable(gameId);
    const meta = await store.verify(gameId, id);
    if (meta.deletedAt) throw store.error('storage.recoverBeforeRestore');
    const { root, entries } = await store.location(game);
    if (!equal([...entries].sort(), [...meta.entries].sort())) {
      throw store.error('storage.restoreEntriesMismatch');
    }
    // 先仅扫描文件大小，避免与后续 safety 备份重复做全量哈希计算
    const currentSize = await inventory(root, entries, { allowMissing: true, hash: false, lang: store.lang });
    await assertDiskBudgets(
      [
        { directory: root, bytes: meta.bytes },
        { directory: store.vault, bytes: currentSize.records.reduce((sum, record) => sum + (record.size || 0), 0) },
      ],
      store.lang,
    );
    const safety = await store.capture(game, root, entries, {
      label: store.t('storage.beforeRestoreLabel', { label: meta.label }).slice(0, 100),
      note: store.t('storage.beforeRestoreNote'),
      kind: 'safety',
      allowMissing: true,
      initialSource: currentSize,
      skipDiskCheck: true,
    });
    const transactionId = randomUUID();
    const stage = path.join(root, `.savehub-restore-${transactionId}`);
    const journalFile = path.join(store.dataDir, 'transactions', `${transactionId}.json`);
    /** @type {import('./models').RestoreJournal} */
    const journal = {
      version: 1,
      id: transactionId,
      gameId,
      snapshotId: id,
      safetyId: safety.id,
      root,
      stage,
      entries,
      operations: [],
      status: 'preparing',
    };
    let journalWritten = false;
    let committed = false;
    try {
      await copyRecords(
        path.join(store.snapshotDir(gameId, id), 'payload'),
        path.join(stage, 'next'),
        meta.records,
        store.onProgress,
        store.lang,
      );
      const staged = await inventory(path.join(stage, 'next'), entries, {
        allowMissing: true,
        hash: false,
        lang: store.lang,
      });
      if (stageSignature(staged) !== stageSignature(meta)) {
        throw store.error('storage.restoreStageVerifyFailed');
      }
      const current = await inventory(root, entries, { allowMissing: true, hash: false, lang: store.lang });
      if (metadataSignature(current) !== metadataSignature(safety)) {
        throw store.error('storage.liveChangedBeforeRestore');
      }
      journal.status = 'applying';
      await atomicJson(journalFile, journal);
      journalWritten = true;
      for (const entry of entries) {
        await assertNoLinks(path.join(root, entry), store.lang);
        const target = path.join(root, entry),
          previous = path.join(stage, 'previous', entry),
          next = path.join(stage, 'next', entry);
        const hadTarget = Boolean(await statMaybe(target));
        journal.operations.push({ entry, hadTarget });
        await atomicJson(journalFile, journal);
        if (hadTarget) {
          await fs.mkdir(path.dirname(previous), { recursive: true });
          await fs.rename(target, previous);
        }
        if (await statMaybe(next)) {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.rename(next, target);
        }
        store.onProgress({
          phase: 'restoring',
          completed: journal.operations.length,
          total: entries.length,
          detail: entry,
        });
        await store.fault('after-install', { entry, journal });
      }
      const restored = await inventory(root, entries, { allowMissing: true, lang: store.lang });
      if (signature(restored) !== signature(meta)) {
        throw store.error('storage.postRestoreVerifyFailed');
      }
      journal.status = 'committed';
      await atomicJson(journalFile, journal);
      committed = true;
      // 一旦事务标记为 committed，后续清理失败绝不能触发回滚而破坏已成功恢复的存档
      try {
        await fs.rm(stage, { recursive: true, force: true });
        await fs.rm(journalFile, { force: true });
      } catch (cleanupError) {
        // 保留已提交的事务日志，交由下次启动时的 recoverTransactions 完成残留清理
        await store.logger.warn('restore-stage-cleanup-deferred', {
          transactionId,
          error: /** @type {Error} */ (cleanupError).message,
        });
      }
      await store.pruneRestorePoints(gameId);
      await store.logger.info('restore-committed', { gameId, snapshotId: id, safetyId: safety.id });
      return { safetyId: safety.id, label: meta.label };
    } catch (error) {
      const errMessage = /** @type {Error} */ (error).message;
      if (committed) {
        // 提交后的非核心维护操作（如 pruneRestorePoints）报错仅记录告警，不影响读档成功结果
        await store.logger.warn('restore-post-commit-maintenance-failed', {
          gameId,
          snapshotId: id,
          error: errMessage,
        });
        return { safetyId: safety.id, label: meta.label };
      }
      if (journalWritten) {
        try {
          await rollback(store, journal, journalFile);
          await store.logger.warn('restore-rolled-back', { gameId, snapshotId: id, error: errMessage });
        } catch (rollbackError) {
          store.blockedGames.add(gameId);
          store.retentionDeferred.add(gameId);
          const rbMessage = /** @type {Error} */ (rollbackError).message;
          await store.logger.error('restore-rollback-failed', {
            gameId,
            snapshotId: id,
            error: errMessage,
            rollbackError: rbMessage,
          });
          throw store.error('storage.restoreRollbackFailed', { rollbackError: rbMessage, safetyId: safety.id });
        }
      } else {
        await fs
          .rm(stage, { recursive: true, force: true })
          .catch((err) => store.logger.warn('restore-uncommitted-stage-cleanup-failed', { stage, error: err.message }));
      }
      await store.pruneRestorePoints(gameId);
      throw store.error('storage.restoreAborted', { error: errMessage });
    }
  });
}

/**
 * 逆序回滚未提交的恢复事务，将 `stage/previous` 中的原存档还原回游戏目录，
 * 并将损坏或半写入的目标文件隔离至 `stage/failed` 供排查。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {import('./models').RestoreJournal} journal 恢复事务日志对象
 * @param {string} journalFile 事务日志文件路径
 */
export async function rollback(store, journal, journalFile) {
  validateRestoreJournal(store, journal, journalFile);
  safeId(journal.id, store.lang);
  safeId(journal.gameId, store.lang);
  const expectedStage = path.join(journal.root, `.savehub-restore-${journal.id}`);
  if (
    journal.version !== 1 ||
    !path.isAbsolute(journal.root) ||
    path.resolve(journal.stage) !== expectedStage ||
    !Array.isArray(journal.operations)
  ) {
    throw store.error('storage.invalidJournalPaths');
  }
  const entries = cleanItems(journal.entries, { lang: store.lang });
  await assertNoLinks(journal.root, store.lang);
  await assertNoLinks(journal.stage, store.lang);
  for (const operation of [...journal.operations].reverse()) {
    if (!entries.includes(operation.entry) || typeof operation.hadTarget !== 'boolean') {
      throw store.error('storage.invalidJournalEntry');
    }
    const target = path.join(journal.root, operation.entry);
    const previous = path.join(journal.stage, 'previous', operation.entry);
    const next = path.join(journal.stage, 'next', operation.entry);
    await assertNoLinks(target, store.lang);
    await assertNoLinks(previous, store.lang);
    if (await statMaybe(previous)) {
      if (await statMaybe(target)) {
        const failed = path.join(journal.stage, 'failed', operation.entry);
        await fs.mkdir(path.dirname(failed), { recursive: true });
        await fs.rename(target, failed);
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(previous, target);
    } else if (!operation.hadTarget && !(await statMaybe(next)) && (await statMaybe(target))) {
      const failed = path.join(journal.stage, 'failed', operation.entry);
      await fs.mkdir(path.dirname(failed), { recursive: true });
      await fs.rename(target, failed);
    }
  }
  journal.status = 'rolled-back';
  await atomicJson(journalFile, journal);
  // 保留失败的暂存负载与事务日志以便故障诊断，原始游戏存档此时已安全还原
}

/**
 * 启动时扫描并恢复所有未完成的读档事务日志：
 * - 已回滚（rolled-back）：跳过，保留日志现场；
 * - 已提交（committed）：完成残留暂存目录与日志文件的清理；
 * - 未完成（preparing / applying）：执行逆序回滚并向前端推送恢复通知。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 */
export async function recoverTransactions(store) {
  await recoverJournals(
    store,
    'transactions',
    (journal, file) => validateRestoreJournal(store, journal, file),
    async (journal, file) => {
      if (journal.status === 'rolled-back') return;
      if (journal.status === 'committed') {
        await assertNoLinks(journal.stage, store.lang);
        await assertTreeNoLinks(journal.stage, store.lang);
        await fs.rm(journal.stage, { recursive: true, force: true });
        await fs.rm(file, { force: true });
      } else {
        await rollback(store, journal, file);
        await store.logger.info('recovered-interrupted-restore', { operation: 'recovery', id: journal.id });
        store.recoveryMessages.push(store.t('storage.recoveredInterruptedRestore'));
      }
    },
  );
}
