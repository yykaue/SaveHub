import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { assertNoLinks, cleanItems, missing, safeId, within } from './fs-utils.mjs';

/** 校验读档事务日志（RestoreJournal）的路径合法性、阶段目录边界与操作条目唯一性 @param {import('./storage.mjs').SaveStore} store @param {any} journal @param {string} [file] */
export function validateRestoreJournal(store, journal, file) {
  if (!journal || typeof journal !== 'object') throw store.error('storage.invalidJournalPaths');
  safeId(journal.id, store.lang);
  safeId(journal.gameId, store.lang);
  if (journal.snapshotId !== undefined) safeId(journal.snapshotId, store.lang);
  if (journal.safetyId !== undefined) safeId(journal.safetyId, store.lang);
  if (
    journal.version !== 1 ||
    typeof journal.root !== 'string' ||
    !path.isAbsolute(journal.root) ||
    journal.root === path.parse(journal.root).root ||
    journal.stage !== path.join(journal.root, `.savehub-restore-${journal.id}`) ||
    !['preparing', 'applying', 'committed', 'rolled-back'].includes(journal.status) ||
    !Array.isArray(journal.operations) ||
    (file && path.resolve(file) !== path.join(store.dataDir, 'transactions', `${journal.id}.json`)) ||
    within(store.dataDir, journal.root, store.platform)
  ) {
    throw store.error('storage.invalidJournalPaths');
  }
  const entries = cleanItems(journal.entries, { lang: store.lang });
  const seen = new Set();
  for (const operation of journal.operations) {
    if (
      !operation ||
      !entries.includes(operation.entry) ||
      typeof operation.hadTarget !== 'boolean' ||
      seen.has(operation.entry)
    ) {
      throw store.error('storage.invalidJournalEntry');
    }
    seen.add(operation.entry);
    if (within(path.join(journal.root, operation.entry), store.dataDir, store.platform)) {
      throw store.error('storage.invalidJournalPaths');
    }
  }
  return journal;
}

/**
 * 冻结受未决或损坏事务影响的游戏写入并挂起恢复点自动裁剪：
 * 若事务可关联到具体已知游戏，则将该游戏加入 blockedGames 与 retentionDeferred；
 * 若事务已损坏到无法识别所属游戏，则挂起所有游戏的自动裁剪，防止误删事务依赖的安全恢复点。
 * @param {import('./storage.mjs').SaveStore} store
 * @param {any} journal
 */
function blockAffectedGame(store, journal) {
  if (
    typeof journal?.gameId === 'string' &&
    store.config.games.some((/** @type {any} */ game) => game.id === journal.gameId)
  ) {
    store.blockedGames.add(journal.gameId);
    store.retentionDeferred.add(journal.gameId);
  } else {
    for (const game of store.config.games) store.retentionDeferred.add(game.id);
  }
}

/**
 * 通用事务日志启动恢复框架：
 * 1. 语法或结构损坏的日志移入 quarantine 隔离目录留证（绝不覆盖已有隔离证据，也不假定移动一定成功）；
 * 2. I/O 读取或恢复执行失败时保留原日志与暂存数据，等待下次启动重试，并冻结对应游戏的写操作。
 * @param {import('./storage.mjs').SaveStore} store
 * @param {string} kind
 * @param {(journal: any, file: string) => void} validate
 * @param {(journal: any, file: string) => Promise<void>} recover
 */
export async function recoverJournals(store, kind, validate, recover) {
  const directory = path.join(store.dataDir, kind);
  await assertNoLinks(directory, store.lang);
  let names;
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  const quarantine = path.join(directory, 'quarantine');
  try {
    await assertNoLinks(quarantine, store.lang);
    for (const name of await fs.readdir(quarantine)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(quarantine, name);
      await assertNoLinks(file, store.lang);
      try {
        blockAffectedGame(store, JSON.parse(await fs.readFile(file, 'utf8')));
      } catch {
        // 无法解析的隔离日志仍可能持有安全恢复点依赖，跨重启持续挂起自动清理。
        for (const game of store.config.games) store.retentionDeferred.add(game.id);
      }
    }
  } catch (error) {
    if (!missing(error))
      await store.logger.warn('recovery-quarantine-read-failed', { file: quarantine, error: String(error) });
  }
  for (const name of names.filter((name) => name.endsWith('.json'))) {
    const file = path.join(directory, name);
    let raw;
    try {
      await assertNoLinks(file, store.lang);
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      await store.logger.error('recovery-read-failed', { operation: 'recovery', file, error: String(error) });
      store.recoveryMessages.push(store.t('storage.recoveryReadFailed', { file }));
      // 无法读取的事务日志归属未知，挂起全部游戏的恢复点自动清理直到可读。
      for (const game of store.config.games) store.retentionDeferred.add(game.id);
      continue;
    }
    let journal;
    try {
      journal = JSON.parse(raw);
      validate(journal, file);
    } catch (error) {
      blockAffectedGame(store, journal);
      const target = path.join(quarantine, `${path.basename(name, '.json')}-${Date.now()}-${randomUUID()}.json`);
      let moved = false;
      try {
        await assertNoLinks(quarantine, store.lang);
        await fs.mkdir(quarantine, { recursive: true });
        await store.fault('before-quarantine', { file, target });
        await fs.rename(file, target);
        moved = true;
      } catch (moveError) {
        await store.logger.error('recovery-quarantine-failed', {
          operation: 'recovery',
          file,
          target,
          error: String(moveError),
        });
      }
      await store.logger.error(moved ? 'quarantined-corrupt-journal' : 'corrupt-journal-retained', {
        operation: 'recovery',
        kind,
        file: moved ? target : file,
        error: String(error),
      });
      store.recoveryMessages.push(
        store.t(moved ? 'storage.quarantinedCorruptJournal' : 'storage.quarantineFailed', { name, file }),
      );
      continue;
    }
    try {
      await recover(journal, file);
    } catch (error) {
      blockAffectedGame(store, journal);
      await store.logger.error('recovery-incomplete', {
        operation: 'recovery',
        file,
        gameId: journal.gameId,
        error: String(error),
      });
      store.recoveryMessages.push(store.t('storage.recoveryIncomplete', { file, error: String(error) }));
    }
  }
}
