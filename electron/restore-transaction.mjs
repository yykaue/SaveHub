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

const stageSignature = (/** @type {{ absent: string[]; records: any[] }} */ value) =>
  JSON.stringify({
    absent: value.absent,
    records: value.records.map(({ path: file, type, size }) => ({ path: file, type, size })),
  });

const metadataSignature = (/** @type {{ absent: string[]; records: any[] }} */ value) =>
  JSON.stringify({
    absent: value.absent,
    records: value.records.map(({ path: file, type, size, mtimeMs }) => ({ path: file, type, size, mtimeMs })),
  });

/**
 * @param {import('./storage.mjs').SaveStore} store

 * @param {string} gameId
   * @param {string} id
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
    /**
     * @type {import('./models').RestoreJournal} */
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
      // Once committed, cleanup failures must not turn a successful restore into a rollback.
      try {
        await fs.rm(stage, { recursive: true, force: true });
        await fs.rm(journalFile, { force: true });
      } catch (cleanupError) {
        /* Retain committed journal so the next startup can finish cleanup. */
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
 * @param {import('./storage.mjs').SaveStore} store

   * @param {import('./models').RestoreJournal} journal
   * @param {string} journalFile
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
  // Keep the failed payload and journal for diagnosis; the original game files are restored.
}

/**
 * @param {import('./storage.mjs').SaveStore} store

 * */
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
