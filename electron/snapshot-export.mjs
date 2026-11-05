import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { progressRange, progressTask } from './progress.mjs';

import {
  EXPORT_INDEX,
  assertDiskSpace,
  assertNoLinks,
  atomicJson,
  cleanItems,
  copyRecords,
  exportName,
  foldedName,
  inventory,
  signature,
  statMaybe,
  uniqueExportName,
  validateManifest,
  within,
  withinOnDisk,
} from './fs-utils.mjs';

/**
 * @param {import('./storage.mjs').SaveStore} store

 * @param {string} gameId
   * @param {string} id
   * @param {string} destination
    */
export async function exportSnapshot(store, gameId, id, destination) {
  const result = await store.exportSnapshots(gameId, [id], destination);
  return result.folder;
}

/**
 * @param {import('./storage.mjs').SaveStore} store

 * @param {string} root
   * @param {string} [onlyFolder]
    */
export async function exportIndexCandidates(store, root, onlyFolder) {
  const indexDir = path.join(root, EXPORT_INDEX);
  await assertNoLinks(indexDir, store.lang);
  if (!(await statMaybe(indexDir))?.isDirectory()) return null;
  const candidates = [];
  const seen = new Set();
  for (const file of (await fs.readdir(indexDir)).filter((file) => file.endsWith('.json')).sort()) {
    await assertNoLinks(path.join(indexDir, file), store.lang);
    const index = JSON.parse(await fs.readFile(path.join(indexDir, file), 'utf8'));
    if (
      index.version !== 2 ||
      index.type !== 'savehub-collection' ||
      !Array.isArray(index.snapshots) ||
      !index.snapshots.length ||
      index.snapshots.length > 10000
    ) {
      throw store.error('storage.invalidNamedExportIndex');
    }
    for (const item of index.snapshots) {
      const [name] = cleanItems([item.directory], { lang: store.lang });
      if (name.includes('/') || foldedName(name) === EXPORT_INDEX || seen.has(foldedName(name))) {
        throw store.error('storage.invalidOrDuplicateExportDir');
      }
      seen.add(foldedName(name));
      if (onlyFolder && name !== onlyFolder) continue;
      const meta = validateManifest(item.manifest, store.lang);
      candidates.push({ name: meta.label, id: meta.id, meta, exported: path.join(root, name) });
    }
  }
  return candidates.length ? candidates : null;
}

/**
 * @param {import('./storage.mjs').SaveStore} store

 * @param {string} directory
    */
export async function namedExportCandidates(store, directory) {
  // A single named folder can contain arbitrary game files named manifest.json or collection.json.
  return (
    (await store.exportIndexCandidates(path.dirname(directory), path.basename(directory))) ||
    (await store.exportIndexCandidates(directory))
  );
}

/**
 * @param {import('./storage.mjs').SaveStore} store

 * @param {string} gameId
   * @param {import('./models').Manifest} meta
   * @param {string} folder
    */
export async function writeExport(store, gameId, meta, folder) {
  await copyRecords(
    path.join(store.snapshotDir(gameId, meta.id), 'payload'),
    folder,
    meta.records,
    progressRange(store.onProgress, 0, 80),
  );
  store.onProgress({ phase: 'checking', detail: meta.label, completed: 0, percent: 80 });
  const copy = await inventory(folder, meta.entries, {
    allowMissing: true,
    lang: store.lang,
    progress: progressRange(store.onProgress, 80, 100),
  });
  if (signature(copy) !== signature(meta)) throw store.error('storage.exportWriteVerifyFailed');
}

/**
 * @param {import('./storage.mjs').SaveStore} store

 * @param {string} gameId
   * @param {string[] | 'all'} selection
   * @param {string} destination
    */
export async function exportSnapshots(store, gameId, selection, destination) {
  return store.exclusive(async () => {
    const game = store.game(gameId);
    const ids =
      selection === 'all'
        ? (await store.snapshots(gameId))
            .filter((meta) => ['manual', 'imported'].includes(meta.kind))
            .map((meta) => meta.id)
        : selection;
    const selected = store.validateSelection(ids);
    if (typeof destination !== 'string' || !path.isAbsolute(destination)) {
      throw store.error('storage.pickExportDirRequired');
    }
    await assertNoLinks(destination, store.lang);
    if (await withinOnDisk(store.dataDir, destination, store.platform)) {
      throw store.error('storage.exportDirInsideVault');
    }
    const metas = [];
    for (const [index, id] of selected.entries()) {
      metas.push(
        await progressTask(
          store,
          'checking',
          '',
          (20 * index) / selected.length,
          (20 * (index + 1)) / selected.length,
          () => store.verify(gameId, id),
        ),
      );
    }
    const totalBytes = metas.reduce((sum, meta) => sum + (meta.bytes || 0), 0);
    await assertDiskSpace(destination, totalBytes, store.lang);
    const batchId = randomUUID();
    const stage = path.join(destination, `.savehub-export-${batchId}`);
    const existing = new Set((await fs.readdir(destination)).map(foldedName));
    // Old unwrapped exports may retain index entries after a named folder is moved.
    // Reserve those names so importing the new bundle cannot resolve to an old entry.
    for (const candidate of (await store.exportIndexCandidates(destination)) || []) {
      existing.add(foldedName(path.basename(candidate.exported)));
    }
    const folder = path.join(destination, uniqueExportName(`${exportName(game.name)}-存档导出`, existing));
    const indexDir = path.join(folder, EXPORT_INDEX);
    const taken = new Set([EXPORT_INDEX]);
    const directories = metas.map((meta) => uniqueExportName(exportName(meta.label), taken));
    const published = [];
    const indexFile = path.join(indexDir, `${batchId}.json`);
    let folderCreated = false;
    await fs.mkdir(stage);
    try {
      for (const [index, meta] of metas.entries()) {
        await progressTask(
          store,
          'exporting',
          meta.label,
          20 + (70 * index) / metas.length,
          20 + (70 * (index + 1)) / metas.length,
          () => store.writeExport(gameId, meta, path.join(stage, directories[index])),
        );
      }
      // Claim a fresh bundle only after all payloads are verified. Never replace
      // a folder created by another process after our name preflight.
      await store.fault('before-export-bundle-publish', { folder });
      await fs.mkdir(folder);
      folderCreated = true;
      await fs.mkdir(indexDir);
      for (const [index, name] of directories.entries()) {
        const target = path.join(folder, name),
          source = path.join(stage, name);
        await store.fault('before-export-publish', { directory: name, folder });
        await fs.mkdir(target);
        published.push(target);
        for (const child of await fs.readdir(source)) {
          await fs.rename(path.join(source, child), path.join(target, child));
        }
        store.onProgress({
          phase: 'exporting',
          detail: name,
          completed: index + 1,
          total: directories.length,
          percent: 90 + (9 * (index + 1)) / directories.length,
        });
      }
      await atomicJson(indexFile, {
        version: 2,
        type: 'savehub-collection',
        gameId,
        gameName: game.name,
        exportedAt: new Date().toISOString(),
        snapshots: metas.map((manifest, index) => ({ directory: directories[index], manifest })),
      });
      store.onProgress({
        phase: 'exporting',
        detail: game.name,
        completed: metas.length,
        total: metas.length,
        percent: 100,
      });
      return { folder, count: metas.length, directories, indexFile };
    } catch (error) {
      for (const target of published) {
        if (
          !within(destination, folder, store.platform) ||
          folder === destination ||
          !within(folder, target, store.platform) ||
          target === folder
        ) {
          throw store.error('storage.exportCleanupOutOfBounds');
        }
        await fs.rm(target, { recursive: true, force: true });
      }
      if (folderCreated) {
        // Remove only empty containers so concurrent, unrelated files survive.
        await fs
          .rmdir(indexDir)
          .catch((err) => store.logger.warn('export-index-rmdir-failed', { indexDir, error: err.message }));
        await fs
          .rmdir(folder)
          .catch((err) => store.logger.warn('export-folder-rmdir-failed', { folder, error: err.message }));
      }
      throw error;
    } finally {
      // This uniquely named, owned staging folder is always inside the chosen destination.
      if (!within(destination, stage, store.platform))
        await store.logger.error('export-stage-cleanup-refused', { stage, destination });
      else
        await fs
          .rm(stage, { recursive: true, force: true })
          .catch((err) => store.logger.warn('export-stage-cleanup-failed', { stage, error: err.message }));
    }
  });
}
