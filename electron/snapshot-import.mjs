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

/**
 * @param {import('./storage.mjs').SaveStore} store

 * @param {any} journal
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
 * @param {import('./storage.mjs').SaveStore} store

 * @param {any} journal
    */
export async function finishImportReplacement(store, journal) {
  const { target, stage, previous, file } = store.importReplacementPaths(journal);
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
 * @param {import('./storage.mjs').SaveStore} store

 * @param {string} gameId
   * @param {import('./models').Manifest} original
   * @param {string} stage
   * @param {string} token
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
  const locations = store.importReplacementPaths(journal);
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
    const errMessage =
      /**
       * @type {Error} */ (error).message;
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
  // Once committed, cleanup failure must not misreport the successful replacement.
  // The persisted journal lets startup finish removing the previous copy.
  await store
    .finishImportReplacement({ ...journal, status: 'committed' })
    .catch((err) =>
      store.logger.warn('import-replace-cleanup-deferred', { gameId, id: original.id, error: err.message }),
    );
}

/**
 * @param {import('./storage.mjs').SaveStore} store
 */
export async function recoverImportReplacements(store) {
  await recoverJournals(
    store,
    'import-transactions',
    (journal, file) => {
      if (store.importReplacementPaths(journal).file !== file)
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
 * @param {import('./storage.mjs').SaveStore} store

   * @param {any} candidate
   * @param {any[]} snapshots
    */
export function importMatches(store, candidate, snapshots) {
  const key = (
    /**
     * @type {string} */ value,
  ) => (store.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  // An imported directory identifies a save even when its contents have changed.
  // Equal contents in distinct source directories may be intentional checkpoints.
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
 * @param {import('./storage.mjs').SaveStore} store

   * @param {string} gameId
   * @param {string} directory
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
 * @param {import('./storage.mjs').SaveStore} store

   * @param {string} planId
    */
export function cancelImport(store, planId) {
  if (store.pendingImport?.id === planId) store.pendingImport = null;
}

/**
 * @param {import('./storage.mjs').SaveStore} store

 * @param {string} gameId
   * @param {string} directory
   * @param {{ game?: import('./models').StoredGame; bundle?: boolean }} [options]
    */
export async function prepareImportPlan(store, gameId, directory, { game = store.game(gameId), bundle = false } = {}) {
  if (!bundle) store.pendingImport = null;
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
  /**
   * @type {import('./models').InternalImportPlan} */
  const plan = { id: randomUUID(), gameId, entries, directory, items: [], failed: [], bundle };
  const existing = await store.snapshots(gameId, true);
  /** @type {any[]} */
  let candidates;
  const namedExports = await store.namedExportCandidates(directory);
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
        matches: store.importMatches(candidate, existing),
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
 * @param {import('./storage.mjs').SaveStore} store

   * @param {string} planId
   * @param {import('../shared/contracts').ImportDecision[]} decisions
    */
export async function executeImport(store, planId, decisions) {
  return store.exclusive(() => store.executeImportPlan(planId, decisions));
}

/**
 * @param {import('./storage.mjs').SaveStore} store

 * @param {string} planId
   * @param {import('../shared/contracts').ImportDecision[]} decisions
    */
export async function executeImportPlan(store, planId, decisions) {
  const plan = store.pendingImport;
  if (!plan || plan.id !== planId) throw store.error('storage.importPlanExpired');
  const game = store.game(plan.gameId);
  const choices = await store.validateImportPlan(plan, decisions);
  store.pendingImport = null; // An execution token is single use, including partial failure.
  const report = await progressTask(store, 'importing', '', 0, 95, () => store.applyImportPlan(plan, choices, game));
  // Enforce both queues only after every import/overwrite/skip has finished.
  await progressTask(store, 'pruning', '', 95, 100, () => store.pruneRestorePoints(game.id));
  return report;
}

/**
 * @param {import('./storage.mjs').SaveStore} store

 * @param {import('./models').InternalImportPlan} plan
   * @param {import('../shared/contracts').ImportDecision[]} decisions
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
  // Reject stale library decisions before committing any item in the batch.
  store.invalidateGameCache(plan.gameId);
  const existing = await store.snapshots(plan.gameId, true);
  for (const item of plan.items) {
    if (!equal(store.importMatches(item, existing), item.matches)) {
      throw store.error('storage.duplicateMatchesChanged');
    }
  }
  return choices;
}

/**
 * @param {import('./storage.mjs').SaveStore} store

   * @param {import('./models').InternalImportPlan} plan
   * @param {import('./models').ImportChoices} choices
   * @param {import('./models').StoredGame} game
    */
export async function applyImportPlan(store, plan, choices, game) {
  const existing = await store.snapshots(game.id, true);
  /**
   * @type {{ imported: string[]; overwritten: string[]; keptBoth: string[]; skipped: string[]; failed: { name: string; error: string }[] }} */
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
 * @param {import('./storage.mjs').SaveStore} store

   * @param {string} gameId
   * @param {string} directory
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
