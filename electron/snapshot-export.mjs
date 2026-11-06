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
 * 导出单个快照到指定目录，返回生成的导出包目录路径。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} gameId 游戏 ID
 * @param {string} id 快照 ID
 * @param {string} destination 目标父目录绝对路径
 */
export async function exportSnapshot(store, gameId, id, destination) {
  const result = await store.exportSnapshots(gameId, [id], destination);
  return result.folder;
}

/**
 * 解析 v2 命名导出索引目录（`.savehub-exports/*.json`），返回候选快照列表。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} root 包含 `.savehub-exports` 的根目录
 * @param {string} [onlyFolder] 仅匹配指定子文件夹名称（当用户直接选中某个子文件夹导入时使用）
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
 * 探测指定目录是否为 v2 命名导出的单个子目录或整个导出包根目录。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} directory 待探测的目录路径
 */
export async function namedExportCandidates(store, directory) {
  // 单个命名导出子目录内部可能包含游戏自身名为 manifest.json 或 collection.json 的存档文件，
  // 因此优先从父目录的 .savehub-exports 索引定位，再回退到当前目录自身的 .savehub-exports 索引。
  return (
    (await exportIndexCandidates(store, path.dirname(directory), path.basename(directory))) ||
    (await exportIndexCandidates(store, directory))
  );
}

/**
 * 将单个快照的负载复制到目标导出目录，并执行全量哈希复核确保导出数据完整无误。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} gameId 游戏 ID
 * @param {import('./models').Manifest} meta 快照清单对象
 * @param {string} folder 目标导出子目录
 */
export async function writeExport(store, gameId, meta, folder) {
  await copyRecords(
    path.join(store.snapshotDir(gameId, meta.id), 'payload'),
    folder,
    meta.records,
    progressRange(store.onProgress, 0, 80),
    store.lang,
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
 * 批量导出快照到指定目录：
 * 1. 校验所选快照的完整性与目标磁盘剩余空间。
 * 2. 先将所有快照写入目标目录下的隐藏暂存区 `.savehub-export-<batchId>` 并完成哈希校验。
 * 3. 校验全部通过后才创建最终导出包目录，将暂存区文件原子重命名发布，并写入 `.savehub-exports/<batchId>.json` 索引。
 * 4. 若发布中途出错，仅精准清理本次已发布的子目录与空容器，绝不误删目标目录中并发产生的其他文件。
 *
 * @param {import('./storage.mjs').SaveStore} store 存储引擎实例
 * @param {string} gameId 游戏 ID
 * @param {string[] | 'all'} selection 快照 ID 数组或 `'all'`
 * @param {string} destination 目标父目录绝对路径
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
    // 旧版未包裹外层目录的导出可能在子文件夹移走后仍残留索引项；
    // 预留这些名称以防止新建导出包与旧索引中的目录名冲突。
    for (const candidate of (await exportIndexCandidates(store, destination)) || []) {
      existing.add(foldedName(path.basename(candidate.exported)));
    }
    const folder = path.join(
      destination,
      uniqueExportName(`${exportName(game.name, store.lang)}-${store.t('storage.snapshotExportSuffix')}`, existing),
    );
    const indexDir = path.join(folder, EXPORT_INDEX);
    const taken = new Set([EXPORT_INDEX]);
    const directories = metas.map((meta) => uniqueExportName(exportName(meta.label, store.lang), taken));
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
          () => writeExport(store, gameId, meta, path.join(stage, directories[index])),
        );
      }
      // 仅在所有快照负载均完成写入与校验后才创建最终导出目录，绝不覆盖其他进程在预检后创建的同名目录
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
        // 仅使用 rmdir 删除空容器目录，确保并发写入的无关文件不会被误删
        await fs
          .rmdir(indexDir)
          .catch((err) => store.logger.warn('export-index-rmdir-failed', { indexDir, error: err.message }));
        await fs
          .rmdir(folder)
          .catch((err) => store.logger.warn('export-folder-rmdir-failed', { folder, error: err.message }));
      }
      throw error;
    } finally {
      // 带随机 UUID 的专属暂存目录始终位于用户所选导出目录下，无论成功或失败均需清理
      if (!within(destination, stage, store.platform))
        await store.logger.error('export-stage-cleanup-refused', { stage, destination });
      else
        await fs
          .rm(stage, { recursive: true, force: true })
          .catch((err) => store.logger.warn('export-stage-cleanup-failed', { stage, error: err.message }));
    }
  });
}
