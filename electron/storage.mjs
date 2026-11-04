import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { DEFAULT_LANGUAGE, LANGUAGES, normalizeLanguage, setBackendLanguage, translate } from './i18n.mjs';
import {
  EXPORT_INDEX,
  assertDiskSpace,
  assertNoLinks,
  assertTreeNoLinks,
  atomicJson,
  cleanItems,
  commitSnapshotDirectory,
  copyRecords,
  equal,
  exportName,
  fingerprint,
  foldedName,
  inventory,
  missing,
  publicSnapshot,
  safeId,
  signature,
  statBigIntMaybe,
  statMaybe,
  uniqueExportName,
  validateManifest,
  within,
} from './fs-utils.mjs';
import {
  executeGameImport,
  exportGames,
  normalizeGame,
  prepareGameImport,
  purgeGame,
  purgeGameSnapshots,
  removeGame,
  reviewGameImport,
} from './game-transfer.mjs';
import { Logger } from './logger.mjs';

export {
  LANGUAGES,
  assertDiskSpace,
  assertNoLinks,
  assertTreeNoLinks,
  atomicJson,
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
};
export const THEMES = ['ink', 'tech', 'cyber', 'glass'];
export const DEFAULT_MAX_RESTORE_POINTS = 20;

export class SaveStore {
  /**
   * @param {string} dataDir
   * @param {{ platform?: string; onProgress?: (p: any) => void; fault?: (phase: string, data?: any) => Promise<void>; maxRestorePoints?: number }} [options]
   */
  constructor(
    dataDir,
    { platform = process.platform, onProgress = () => {}, fault = async () => {}, maxRestorePoints = DEFAULT_MAX_RESTORE_POINTS } = {},
  ) {
    this.dataDir = path.resolve(dataDir);
    this.vault = path.join(this.dataDir, 'vault');
    this.configFile = path.join(this.dataDir, 'library.json');
    this.platform = platform;
    this.onProgress = onProgress;
    this.fault = fault;
    this.maxRestorePoints = maxRestorePoints;
    this.busy = false;
    /** @type {any} */
    this.config = null;
    /** @type {any} */
    this.pendingImport = null;
    /** @type {any} */
    this.pendingGameImport = null;
    /** @type {string[]} */
    this.recoveryMessages = [];
    /** @type {Map<string, { statSignature: string; meta: any }>} */
    this.manifestCache = new Map();
    this.logger = new Logger(this.dataDir);
  }

  get lang() {
    return this.config?.language;
  }

  /**
   * @param {string} key
   * @param {Record<string, string | number>} [params]
   */
  t(key, params) {
    return translate(this.lang, key, params);
  }

  /**
   * @param {string} gameId
   * @param {string} id
   */
  invalidateSnapshotCache(gameId, id) {
    this.manifestCache.delete(`${gameId}/${id}`);
  }

  /**
   * @param {string} gameId
   */
  invalidateGameCache(gameId) {
    const prefix = `${gameId}/`;
    for (const key of this.manifestCache.keys()) {
      if (key.startsWith(prefix)) this.manifestCache.delete(key);
    }
  }

  /**
   * @param {any[]} [presets]
   */
  async init(presets = []) {
    await assertNoLinks(this.dataDir);
    await fs.mkdir(this.vault, { recursive: true });
    try {
      this.config = JSON.parse(await fs.readFile(this.configFile, 'utf8'));
      if (this.config.version !== 1 || !Array.isArray(this.config.games)) {
        throw new Error(this.t('storage.invalidConfigFormat'));
      }
      if (!LANGUAGES.includes(this.config.language)) this.config.language = DEFAULT_LANGUAGE;
      setBackendLanguage(this.config.language);
      this.config.games.forEach((/** @type {any} */ game) => safeId(game.id, this.lang));
    } catch (error) {
      if (!missing(error)) {
        const message = this.t('storage.corruptLibrary', {
          file: this.configFile,
          error: /** @type {Error} */ (error).message,
        });
        await this.logger.error('corrupt-library-config', { file: this.configFile, error: /** @type {Error} */ (error).message });
        throw new Error(message);
      }
      this.config = { version: 1, theme: 'ink', language: DEFAULT_LANGUAGE, games: presets };
      setBackendLanguage(this.config.language);
      await this.saveConfig();
    }
    await this.recoverTransactions();
    for (const game of this.config.games.filter((/** @type {any} */ game) => game.purgeGamePending || game.purgeSnapshotsPending)) {
      // Older snapshot-only cleanup intents retain their original scope.
      try {
        await (game.purgeGamePending ? purgeGame(this, game.id) : purgeGameSnapshots(this, game.id));
      } catch (error) {
        const errMessage = /** @type {Error} */ (error).message;
        await this.logger.warn('pending-game-cleanup-incomplete', { gameId: game.id, error: errMessage });
        this.recoveryMessages.push(this.t('storage.gameCleanupPendingRecovery', { name: game.name, error: errMessage }));
      }
    }
    await this.recoverImportReplacements();
    return this;
  }

  /**
   * @template T
   * @param {() => Promise<T>} action
   * @returns {Promise<T>}
   */
  async exclusive(action) {
    if (this.busy) throw new Error(this.t('storage.operationBusy'));
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
      this.onProgress(null);
    }
  }

  /**
   * @param {string} id
   * @param {boolean} [includeDeleted]
   */
  game(id, includeDeleted = false) {
    safeId(id, this.lang);
    const game = this.config.games.find((/** @type {any} */ item) => item.id === id && (includeDeleted || !item.deletedAt));
    if (!game) throw new Error(this.t('storage.gameNotFound'));
    return game;
  }

  /**
   * @param {string} id
   */
  gameDir(id) {
    return path.join(this.vault, safeId(id, this.lang));
  }

  /**
   * @param {string} gameId
   * @param {string} id
   */
  snapshotDir(gameId, id) {
    return path.join(this.gameDir(gameId), 'snapshots', safeId(id, this.lang));
  }

  async saveConfig() {
    if (await statMaybe(this.configFile)) await fs.copyFile(this.configFile, `${this.configFile}.previous`);
    await atomicJson(this.configFile, this.config);
  }

  /**
   * @param {string} gameId
   * @param {boolean} [includeDeleted]
   */
  async snapshots(gameId, includeDeleted = false) {
    const directory = path.join(this.gameDir(gameId), 'snapshots');
    const result = [];
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const ids = new Set(entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name));
    for (const entry of entries) {
      const match = entry.name.match(/^\.purge-([a-z0-9-]{1,64})\.json$/);
      if (match && entry.isFile()) ids.add(match[1]);
    }
    for (const id of ids) {
      try {
        const meta = await this.readSnapshot(gameId, id);
        if (includeDeleted || !meta.deletedAt) result.push(publicSnapshot(meta));
      } catch (error) {
        result.push({
          id,
          gameId,
          label: this.t('storage.corruptedLabel', { id: id.slice(0, 8) }),
          kind: 'manual',
          corrupted: true,
          error: /** @type {Error} */ (error).message,
          createdAt: '',
          bytes: 0,
          fileCount: 0,
          entries: [],
        });
      }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async state() {
    const games = await Promise.all(
      this.config.games.map(async (/** @type {any} */ game) => {
        const location = game.locations[this.platform];
        let pathStatus = 'unconfigured';
        if (location?.root && location?.items.length) {
          try {
            await this.location(game);
            pathStatus = 'ready';
          } catch {
            pathStatus = 'missing';
          }
        }
        let legacyCount = 0;
        if (game.legacyRoot) {
          try {
            legacyCount = (await fs.readdir(game.legacyRoot, { withFileTypes: true })).filter(
              item => item.isDirectory() && item.name.startsWith('ArchiveFile'),
            ).length;
          } catch {
            /* Optional legacy folder. */
          }
        }
        const stored = await this.snapshots(game.id, true);
        return {
          ...game,
          snapshots: stored.filter(snapshot => snapshot.kind !== 'safety'),
          restorePoints: stored.filter(snapshot => snapshot.kind === 'safety'),
          pathStatus,
          legacyCount,
        };
      }),
    );
    return {
      games,
      theme: this.config.theme,
      language: normalizeLanguage(this.config.language),
      platform: this.platform,
      dataDir: this.dataDir,
      recoveryMessages: this.recoveryMessages,
    };
  }

  /**
   * @param {string} theme
   */
  async setTheme(theme) {
    return this.exclusive(async () => {
      if (!THEMES.includes(theme)) throw new Error(this.t('storage.unknownTheme'));
      this.config.theme = theme;
      await this.saveConfig();
    });
  }

  /**
   * @param {string} language
   */
  async setLanguage(language) {
    return this.exclusive(async () => {
      if (!LANGUAGES.includes(language)) throw new Error(this.t('storage.unknownLanguage'));
      this.config.language = language;
      setBackendLanguage(language);
      await this.saveConfig();
    });
  }

  /**
   * @param {any} input
   */
  async upsertGame(input) {
    return this.exclusive(async () => {
      const game = normalizeGame(input, input?.id ? this.game(input.id) : null, this.lang);
      await this.commitGame(game);
      return game.id;
    });
  }

  /**
   * @param {any} game
   */
  async commitGame(game) {
    const previous = this.config;
    const games = previous.games.filter((/** @type {any} */ item) => item.id !== game.id);
    const index = previous.games.findIndex((/** @type {any} */ item) => item.id === game.id);
    games.splice(index < 0 ? games.length : index, 0, game);
    this.config = { ...previous, games };
    try {
      await this.saveConfig();
    } catch (error) {
      this.config = previous;
      throw error;
    }
    // library.json is authoritative; a failed cache write cannot undo a committed game.
    await atomicJson(path.join(this.gameDir(game.id), 'game.json'), game).catch(err =>
      this.logger.warn('game-cache-write-failed', { gameId: game.id, error: err.message }),
    );
  }

  /**
   * @param {string} id
   */
  async forgetGame(id) {
    safeId(id, this.lang);
    const previous = this.config;
    this.config = { ...previous, games: previous.games.filter((/** @type {any} */ game) => game.id !== id) };
    try {
      await this.saveConfig();
    } catch (error) {
      this.config = previous;
      throw error;
    }
  }

  /**
   * @param {string} id
   * @param {boolean} [undo]
   * @param {boolean} [deleteRecords]
   */
  async removeGame(id, undo = false, deleteRecords = false) {
    return this.exclusive(() => removeGame(this, id, undo, deleteRecords));
  }

  /**
   * @param {string[]} ids
   * @param {string} destination
   * @param {boolean} [includeSnapshots]
   */
  async exportGames(ids, destination, includeSnapshots = false) {
    return this.exclusive(() => exportGames(this, ids, destination, includeSnapshots));
  }

  /**
   * @param {string} directory
   */
  async prepareGameImport(directory) {
    return this.exclusive(() => prepareGameImport(this, directory));
  }

  /**
   * @param {string} planId
   * @param {any[]} decisions
   */
  async reviewGameImport(planId, decisions) {
    return this.exclusive(() => reviewGameImport(this, planId, decisions));
  }

  /**
   * @param {string} planId
   * @param {any[]} decisions
   */
  async executeGameImport(planId, decisions) {
    return this.exclusive(() => executeGameImport(this, planId, decisions));
  }

  /**
   * @param {string} planId
   */
  cancelGameImport(planId) {
    if (this.pendingGameImport?.id === planId) this.pendingGameImport = null;
  }

  /**
   * @param {any} game
   * @param {string[]} [entriesOverride]
   */
  async location(game, entriesOverride) {
    const location = game.locations[this.platform];
    if (!location?.root || !path.isAbsolute(location.root)) {
      throw new Error(this.t('storage.unconfiguredRoot'));
    }
    const root = path.resolve(location.root);
    if (root === path.parse(root).root) throw new Error(this.t('storage.diskRootForbidden'));
    await assertNoLinks(root, this.lang);
    const rootStat = await statMaybe(root);
    if (!rootStat?.isDirectory()) throw new Error(this.t('storage.gameDirMissing', { root }));
    const entries = cleanItems(entriesOverride || location.items, { lang: this.lang });
    for (const entry of entries) {
      const target = path.join(root, entry);
      if (within(target, this.dataDir, this.platform) || within(this.dataDir, target, this.platform)) {
        throw new Error(this.t('storage.overlapWithVault'));
      }
      await assertNoLinks(target, this.lang);
    }
    return { root, entries };
  }

  /**
   * @param {string} gameId
   * @param {{ label?: string; note?: string }} [options]
   */
  async createSnapshot(gameId, options = {}) {
    return this.exclusive(async () => {
      const game = this.game(gameId);
      const { root, entries } = await this.location(game);
      return publicSnapshot(await this.capture(game, root, entries, { label: options.label, note: options.note, kind: 'manual' }));
    });
  }

  /**
   * @param {any} game
   * @param {string} root
   * @param {string[]} entries
   * @param {any} [options]
   */
  async capture(
    game,
    root,
    entries,
    { label, note = '', kind = 'manual', allowMissing = false, origin, favorite = false, protected: protectedTag = false, expectedFingerprint, replace, metadata } = {},
  ) {
    if (typeof label !== 'string' || !label.trim() || label.length > 100) {
      throw new Error(this.t('storage.labelLength'));
    }
    if (typeof note !== 'string' || note.length > 2000) {
      throw new Error(this.t('storage.noteLength'));
    }
    await assertNoLinks(root, this.lang);
    const source = await inventory(root, entries, { allowMissing, progress: this.onProgress, lang: this.lang });
    if (expectedFingerprint && fingerprint(source) !== expectedFingerprint) {
      throw new Error(this.t('storage.importSourceChangedAfterConfirm'));
    }
    const totalBytes = source.records.reduce((total, record) => total + (record.size || 0), 0);
    await assertDiskSpace(this.vault, totalBytes, this.lang);
    const id = randomUUID();
    const stage = path.join(this.gameDir(game.id), 'snapshots', `.pending-${id}`);
    const destination = this.snapshotDir(game.id, id);
    try {
      await copyRecords(root, path.join(stage, 'payload'), source.records, this.onProgress);
      const copied = await inventory(path.join(stage, 'payload'), entries, { allowMissing: true, lang: this.lang });
      const sourceAfter = await inventory(root, entries, { allowMissing, lang: this.lang });
      if (signature(source) !== signature(copied) || signature(source) !== signature(sourceAfter)) {
        throw new Error(this.t('storage.backupChangedOrVerifyFailed'));
      }
      const meta = {
        version: 1,
        id,
        gameId: game.id,
        label: label.trim(),
        note: note.trim(),
        kind,
        createdAt: new Date().toISOString(),
        platform: this.platform,
        entries,
        favorite: Boolean(favorite),
        protected: Boolean(protectedTag),
        records: source.records,
        absent: source.absent,
        fingerprint: fingerprint(source),
        fileCount: source.records.filter(record => record.type === 'file').length,
        bytes: totalBytes,
        ...(origin ? { origin } : {}),
        ...(metadata || {}),
        ...(replace ? { id: replace.id, createdAt: replace.createdAt, favorite: replace.favorite, protected: replace.protected } : {}),
      };
      validateManifest(meta, this.lang);
      await atomicJson(path.join(stage, 'manifest.json'), meta);
      if (replace) {
        await this.replaceImportedSnapshot(game.id, replace, stage, id);
        this.invalidateSnapshotCache(game.id, replace.id);
      } else {
        await commitSnapshotDirectory(stage, destination);
        this.invalidateSnapshotCache(game.id, id);
      }
      return meta;
    } finally {
      // A pending replacement journal owns its stage until rollback/recovery finishes.
      if (!replace || !(await statMaybe(path.join(this.dataDir, 'import-transactions', `${id}.json`)))) {
        await fs.rm(stage, { recursive: true, force: true }).catch(err =>
          this.logger.warn('capture-stage-cleanup-failed', { stage, error: err.message }),
        );
      }
    }
  }

  /**
   * @param {string} gameId
   * @param {string} id
   */
  async readSnapshot(gameId, id) {
    const folder = this.snapshotDir(gameId, id);
    await assertNoLinks(folder, this.lang);
    const marker = path.join(path.dirname(folder), `.purge-${id}.json`);
    await assertNoLinks(marker, this.lang);
    const markerStat = await statBigIntMaybe(marker);
    const pending = Boolean(markerStat);
    const file = pending ? marker : path.join(folder, 'manifest.json');
    await assertNoLinks(file, this.lang);
    const fileStat = pending ? markerStat : await statBigIntMaybe(file);
    const cacheKey = `${gameId}/${id}`;
    const statSignature = fileStat
      ? `${pending ? 'p' : 'm'}:${fileStat.ino}:${fileStat.size}:${fileStat.mtimeNs}:${fileStat.ctimeNs}`
      : '';
    if (statSignature) {
      const cached = this.manifestCache.get(cacheKey);
      if (cached && cached.statSignature === statSignature) {
        return structuredClone(cached.meta);
      }
    }
    const meta = validateManifest(JSON.parse(await fs.readFile(file, 'utf8')), this.lang);
    if (meta.id !== id || meta.gameId !== gameId) throw new Error(this.t('storage.snapshotIdentityMismatch'));
    if (pending && (!meta.deletedAt || !meta.purgePending)) throw new Error(this.t('storage.invalidPurgeRecord'));
    if (statSignature) {
      this.manifestCache.set(cacheKey, { statSignature, meta: structuredClone(meta) });
    }
    return meta;
  }

  /**
   * @param {string} gameId
   * @param {string} id
   */
  async verifySnapshot(gameId, id) {
    return this.exclusive(async () => {
      const meta = await this.verify(gameId, id);
      return { fileCount: meta.fileCount, bytes: meta.bytes };
    });
  }

  /**
   * @param {string} gameId
   * @param {string} id
   */
  async verify(gameId, id) {
    const meta = await this.readSnapshot(gameId, id);
    if (meta.purgePending) throw new Error(this.t('storage.cannotReadPurging'));
    const actual = await inventory(path.join(this.snapshotDir(gameId, id), 'payload'), meta.entries, {
      allowMissing: true,
      progress: this.onProgress,
      lang: this.lang,
    });
    if (signature(actual) !== signature(meta)) {
      throw new Error(this.t('storage.integrityCheckFailed'));
    }
    return meta;
  }

  /**
   * @param {string} gameId
   * @param {string} id
   * @param {any} changes
   */
  async updateSnapshot(gameId, id, changes) {
    return this.exclusive(async () => {
      this.game(gameId);
      const meta = await this.readSnapshot(gameId, id);
      if (meta.purgePending) throw new Error(this.t('storage.cannotModifyPurging'));
      if (changes.deleted && (meta.protected || changes.protected)) {
        throw new Error(this.t('storage.protectedCannotDelete'));
      }
      if ('label' in changes) {
        if (typeof changes.label !== 'string' || !changes.label.trim() || changes.label.length > 100) {
          throw new Error(this.t('storage.updateLabelLength'));
        }
        meta.label = changes.label.trim();
      }
      if ('note' in changes) {
        if (typeof changes.note !== 'string' || changes.note.length > 2000) {
          throw new Error(this.t('storage.updateNoteLength'));
        }
        meta.note = changes.note;
      }
      if ('favorite' in changes) meta.favorite = Boolean(changes.favorite);
      if ('protected' in changes) {
        if (meta.kind === 'safety') throw new Error(this.t('storage.safetyCannotProtect'));
        if (meta.deletedAt) throw new Error(this.t('storage.recoverBeforeProtect'));
        meta.protected = Boolean(changes.protected);
      }
      if ('deleted' in changes) {
        if (changes.deleted) meta.deletedAt = new Date().toISOString();
        else delete meta.deletedAt;
      }
      await atomicJson(path.join(this.snapshotDir(gameId, id), 'manifest.json'), meta);
      this.invalidateSnapshotCache(gameId, id);
    });
  }

  /**
   * @param {unknown} ids
   * @returns {string[]}
   */
  validateSelection(ids) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 10000) {
      throw new Error(this.t('storage.selectionCountRange'));
    }
    const unique = [...new Set(ids.map(id => safeId(id, this.lang)))];
    if (unique.length !== ids.length) throw new Error(this.t('storage.duplicateSelection'));
    return unique;
  }

  /**
   * @param {string} gameId
   * @param {string[] | 'all'} selection
   * @param {any} changes
   */
  async updateSnapshots(gameId, selection, changes) {
    return this.exclusive(async () => {
      this.game(gameId);
      const keys = Object.keys(changes || {});
      if (keys.length !== 1 || !['deleted', 'protected'].includes(keys[0]) || typeof changes[keys[0]] !== 'boolean') {
        throw new Error(this.t('storage.unsupportedBatchMark'));
      }
      if (selection === 'all' && keys[0] !== 'protected') {
        throw new Error(this.t('storage.allSelectionOnlyProtect'));
      }
      const ids =
        selection === 'all'
          ? (await this.snapshots(gameId)).filter(meta => meta.kind !== 'safety').map(meta => meta.id)
          : selection;
      if (selection === 'all' && ids.length === 0) return { updated: [], failed: [] };
      const selected = this.validateSelection(ids);
      // Validate ownership and every manifest before changing the first item.
      const metas = [];
      for (const id of selected) metas.push(await this.readSnapshot(gameId, id));
      if (metas.some(meta => meta.purgePending)) throw new Error(this.t('storage.batchContainsPurging'));
      if (changes.deleted && metas.some(meta => meta.protected)) {
        throw new Error(this.t('storage.batchContainsProtected'));
      }
      if ('protected' in changes && metas.some(meta => meta.kind === 'safety')) {
        throw new Error(this.t('storage.safetyCannotProtect'));
      }
      if ('protected' in changes && metas.some(meta => meta.deletedAt)) {
        throw new Error(this.t('storage.batchContainsTrashForProtect'));
      }
      /** @type {{ updated: string[]; failed: { id: string; label: string; error: string }[] }} */
      const report = { updated: [], failed: [] };
      const timestamp = new Date().toISOString();
      for (const meta of metas) {
        try {
          await this.fault('before-batch-mark', { gameId, id: meta.id, ...changes });
          if ('protected' in changes) meta.protected = changes.protected;
          else if (changes.deleted) meta.deletedAt = timestamp;
          else delete meta.deletedAt;
          await atomicJson(path.join(this.snapshotDir(gameId, meta.id), 'manifest.json'), meta);
          this.invalidateSnapshotCache(gameId, meta.id);
          report.updated.push(meta.id);
        } catch (error) {
          report.failed.push({ id: meta.id, label: meta.label, error: /** @type {Error} */ (error).message });
        }
      }
      return report;
    });
  }

  /**
   * @param {string} gameId
   * @param {string[]} ids
   */
  async deleteSnapshots(gameId, ids) {
    return this.exclusive(async () => {
      this.game(gameId);
      const selected = this.validateSelection(ids);
      const root = path.resolve(this.gameDir(gameId), 'snapshots');
      const items = [];
      // Preflight the whole selection before marking or deleting any files.
      for (const id of selected) {
        const meta = await this.readSnapshot(gameId, id);
        if (!meta.deletedAt) throw new Error(this.t('storage.purgeOnlyDeleted'));
        if (meta.protected) throw new Error(this.t('storage.protectedCannotDelete'));
        const folder = this.snapshotDir(gameId, id),
          stage = path.join(root, `.purging-${id}`),
          marker = path.join(root, `.purge-${id}.json`);
        for (const target of [folder, stage, marker]) {
          if (path.dirname(path.resolve(target)) !== root || !within(this.vault, target, this.platform)) {
            throw new Error(this.t('storage.purgeOutOfBounds'));
          }
          await assertNoLinks(target, this.lang);
        }
        const original = await statMaybe(folder),
          staged = await statMaybe(stage);
        if ((original && staged) || (staged && !meta.purgePending)) {
          throw new Error(this.t('storage.purgeStageConflict'));
        }
        await assertTreeNoLinks(folder, this.lang);
        await assertTreeNoLinks(stage, this.lang);
        items.push({ meta, folder, stage, marker });
      }
      /** @type {{ updated: string[]; failed: { id: string; label: string; error: string }[] }} */
      const report = { updated: [], failed: [] };
      for (const { meta, folder, stage, marker } of items) {
        try {
          await this.fault('before-purge', { gameId, id: meta.id });
          // Keep the intent outside the directory being physically removed, so an
          // interrupted/partial deletion remains visible and can only be retried.
          await atomicJson(marker, { ...meta, purgePending: true });
          this.invalidateSnapshotCache(gameId, meta.id);
          if (await statMaybe(folder)) await commitSnapshotDirectory(folder, stage);
          await assertTreeNoLinks(stage, this.lang);
          await this.fault('before-purge-remove', { gameId, id: meta.id, stage });
          await fs.rm(stage, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
          await fs.rm(marker, { force: true });
          this.invalidateSnapshotCache(gameId, meta.id);
          report.updated.push(meta.id);
          this.onProgress({
            phase: 'deleting',
            completed: report.updated.length + report.failed.length,
            total: items.length,
            detail: meta.label,
          });
        } catch (error) {
          this.invalidateSnapshotCache(gameId, meta.id);
          report.failed.push({ id: meta.id, label: meta.label, error: /** @type {Error} */ (error).message });
        }
      }
      return report;
    });
  }

  /**
   * Prunes excess automatic safety restore points beyond maxRestorePoints.
   * Never removes favorited, protected, trashed, or pending-purge records.
   * @param {string} gameId
   * @param {string} [keepId]
   */
  async pruneRestorePoints(gameId, keepId) {
    const limit = Number.isInteger(this.config?.maxRestorePoints) ? this.config.maxRestorePoints : this.maxRestorePoints;
    if (!Number.isFinite(limit) || limit <= 0) return;
    const all = await this.snapshots(gameId, true);
    const activeSafety = all
      .filter(s => s.kind === 'safety' && !s.deletedAt && !s.protected && !s.favorite && !s.purgePending && !s.corrupted)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (activeSafety.length <= limit) return;
    const excess = activeSafety.slice(limit).filter(s => s.id !== keepId);
    for (const old of excess) {
      try {
        const folder = this.snapshotDir(gameId, old.id);
        await assertTreeNoLinks(folder, this.lang);
        await fs.rm(folder, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
        this.invalidateSnapshotCache(gameId, old.id);
        await this.logger.info('pruned-safety-restore-point', { gameId, id: old.id });
      } catch (err) {
        await this.logger.warn('prune-safety-restore-point-failed', {
          gameId,
          id: old.id,
          error: /** @type {Error} */ (err).message,
        });
      }
    }
  }

  /**
   * @param {string} gameId
   * @param {string} id
   */
  async restoreSnapshot(gameId, id) {
    return this.exclusive(async () => {
      const game = this.game(gameId);
      const meta = await this.verify(gameId, id);
      if (meta.deletedAt) throw new Error(this.t('storage.recoverBeforeRestore'));
      const { root, entries } = await this.location(game);
      if (!equal([...entries].sort(), [...meta.entries].sort())) {
        throw new Error(this.t('storage.restoreEntriesMismatch'));
      }
      await assertDiskSpace(root, meta.bytes, this.lang);
      const safety = await this.capture(game, root, entries, {
        label: this.t('storage.beforeRestoreLabel', { label: meta.label }).slice(0, 100),
        note: this.t('storage.beforeRestoreNote'),
        kind: 'safety',
        allowMissing: true,
      });
      const transactionId = randomUUID();
      const stage = path.join(root, `.savehub-restore-${transactionId}`);
      const journalFile = path.join(this.dataDir, 'transactions', `${transactionId}.json`);
      /** @type {{ version: number; id: string; gameId: string; snapshotId: string; safetyId: string; root: string; stage: string; entries: string[]; operations: { entry: string; hadTarget: boolean }[]; status: string }} */
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
      try {
        await copyRecords(path.join(this.snapshotDir(gameId, id), 'payload'), path.join(stage, 'next'), meta.records, this.onProgress);
        const staged = await inventory(path.join(stage, 'next'), entries, { allowMissing: true, lang: this.lang });
        if (signature(staged) !== signature(meta)) {
          throw new Error(this.t('storage.restoreStageVerifyFailed'));
        }
        const current = await inventory(root, entries, { allowMissing: true, lang: this.lang });
        if (signature(current) !== signature(safety)) {
          throw new Error(this.t('storage.liveChangedBeforeRestore'));
        }
        journal.status = 'applying';
        await atomicJson(journalFile, journal);
        journalWritten = true;
        for (const entry of entries) {
          await assertNoLinks(path.join(root, entry), this.lang);
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
          this.onProgress({ phase: 'restoring', completed: journal.operations.length, total: entries.length, detail: entry });
          await this.fault('after-install', { entry, journal });
        }
        const restored = await inventory(root, entries, { allowMissing: true, lang: this.lang });
        if (signature(restored) !== signature(meta)) {
          throw new Error(this.t('storage.postRestoreVerifyFailed'));
        }
        journal.status = 'committed';
        await atomicJson(journalFile, journal);
        // Once committed, cleanup failures must not turn a successful restore into a rollback.
        try {
          await fs.rm(stage, { recursive: true, force: true });
          await fs.rm(journalFile, { force: true });
        } catch (cleanupError) {
          /* Retain committed journal so the next startup can finish cleanup. */
          await this.logger.warn('restore-stage-cleanup-deferred', {
            transactionId,
            error: /** @type {Error} */ (cleanupError).message,
          });
        }
        await this.pruneRestorePoints(gameId, safety.id);
        await this.logger.info('restore-committed', { gameId, snapshotId: id, safetyId: safety.id });
        return { safetyId: safety.id, label: meta.label };
      } catch (error) {
        const errMessage = /** @type {Error} */ (error).message;
        if (journalWritten) {
          try {
            await this.rollback(journal, journalFile);
            await this.logger.warn('restore-rolled-back', { gameId, snapshotId: id, error: errMessage });
          } catch (rollbackError) {
            const rbMessage = /** @type {Error} */ (rollbackError).message;
            await this.logger.error('restore-rollback-failed', { gameId, snapshotId: id, error: errMessage, rollbackError: rbMessage });
            throw new Error(this.t('storage.restoreRollbackFailed', { rollbackError: rbMessage, safetyId: safety.id }));
          }
        } else {
          await fs.rm(stage, { recursive: true, force: true }).catch(err =>
            this.logger.warn('restore-uncommitted-stage-cleanup-failed', { stage, error: err.message }),
          );
        }
        throw new Error(this.t('storage.restoreAborted', { error: errMessage }));
      }
    });
  }

  /**
   * @param {any} journal
   * @param {string} journalFile
   */
  async rollback(journal, journalFile) {
    safeId(journal.id, this.lang);
    safeId(journal.gameId, this.lang);
    const expectedStage = path.join(journal.root, `.savehub-restore-${journal.id}`);
    if (
      journal.version !== 1 ||
      !path.isAbsolute(journal.root) ||
      path.resolve(journal.stage) !== expectedStage ||
      !Array.isArray(journal.operations)
    ) {
      throw new Error(this.t('storage.invalidJournalPaths'));
    }
    const entries = cleanItems(journal.entries, { lang: this.lang });
    await assertNoLinks(journal.root, this.lang);
    await assertNoLinks(journal.stage, this.lang);
    for (const operation of [...journal.operations].reverse()) {
      if (!entries.includes(operation.entry) || typeof operation.hadTarget !== 'boolean') {
        throw new Error(this.t('storage.invalidJournalEntry'));
      }
      const target = path.join(journal.root, operation.entry);
      const previous = path.join(journal.stage, 'previous', operation.entry);
      const next = path.join(journal.stage, 'next', operation.entry);
      await assertNoLinks(target, this.lang);
      await assertNoLinks(previous, this.lang);
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

  async recoverTransactions() {
    const directory = path.join(this.dataDir, 'transactions');
    let names;
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const journalFile = path.join(directory, name);
      let journal;
      try {
        journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
      } catch (error) {
        const quarantineDir = path.join(directory, 'quarantine');
        await fs.mkdir(quarantineDir, { recursive: true });
        await fs.rename(journalFile, path.join(quarantineDir, name)).catch(() => {});
        await this.logger.error('quarantined-corrupt-restore-journal', {
          name,
          error: /** @type {Error} */ (error).message,
        });
        this.recoveryMessages.push(this.t('storage.quarantinedCorruptJournal', { name }));
        continue;
      }
      if (journal.status === 'rolled-back') continue;
      if (journal.status === 'committed') {
        safeId(journal.id, this.lang);
        if (journal.stage !== path.join(journal.root, `.savehub-restore-${journal.id}`)) {
          throw new Error(this.t('storage.invalidTransactionStage'));
        }
        await assertNoLinks(journal.stage, this.lang);
        await fs.rm(journal.stage, { recursive: true, force: true });
        await fs.rm(journalFile, { force: true });
      } else {
        await this.rollback(journal, journalFile);
        await this.logger.info('recovered-interrupted-restore', { id: journal.id });
        this.recoveryMessages.push(this.t('storage.recoveredInterruptedRestore'));
      }
    }
  }

  /**
   * @param {any} journal
   */
  importReplacementPaths(journal) {
    if (journal.version !== 1 || !['prepared', 'committed'].includes(journal.status)) {
      throw new Error(this.t('storage.invalidImportReplaceJournal'));
    }
    const token = safeId(journal.token, this.lang),
      gameId = safeId(journal.gameId, this.lang),
      id = safeId(journal.id, this.lang);
    const root = path.join(this.gameDir(gameId), 'snapshots');
    return {
      target: this.snapshotDir(gameId, id),
      stage: path.join(root, `.pending-${token}`),
      previous: path.join(root, `.replaced-${token}`),
      file: path.join(this.dataDir, 'import-transactions', `${token}.json`),
    };
  }

  /**
   * @param {any} journal
   */
  async finishImportReplacement(journal) {
    const { target, stage, previous, file } = this.importReplacementPaths(journal);
    for (const location of [target, stage, previous, file]) await assertNoLinks(location, this.lang);
    if (journal.status === 'prepared' && (await statMaybe(previous))) {
      if (await statMaybe(target)) {
        if (await statMaybe(stage)) throw new Error(this.t('storage.importReplaceStageConflict'));
        await commitSnapshotDirectory(target, stage);
      }
      await commitSnapshotDirectory(previous, target);
    }
    if (!(await statMaybe(target))) throw new Error(this.t('storage.importReplaceTargetMissing'));
    for (const directory of [stage, previous]) {
      await assertTreeNoLinks(directory, this.lang);
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    }
    await fs.rm(file, { force: true });
    this.invalidateSnapshotCache(journal.gameId, journal.id);
  }

  /**
   * @param {string} gameId
   * @param {any} original
   * @param {string} stage
   * @param {string} token
   */
  async replaceImportedSnapshot(gameId, original, stage, token) {
    const current = await this.readSnapshot(gameId, original.id);
    if (!equal(current, original)) {
      throw new Error(this.t('storage.importReplaceTargetChanged'));
    }
    if (current.protected || current.deletedAt || current.purgePending || current.kind === 'safety') {
      throw new Error(this.t('storage.importReplaceTargetForbidden'));
    }
    const journal = { version: 1, token, gameId, id: original.id, status: 'prepared' };
    const locations = this.importReplacementPaths(journal);
    if (stage !== locations.stage) throw new Error(this.t('storage.importReplaceInvalidStage'));
    await assertTreeNoLinks(locations.target, this.lang);
    if (await statMaybe(locations.previous)) throw new Error(this.t('storage.importReplaceBackupExists'));
    await this.fault('before-import-replace', { gameId, id: original.id });
    await atomicJson(locations.file, journal);
    try {
      await commitSnapshotDirectory(locations.target, locations.previous);
      await this.fault('after-import-backup', { gameId, id: original.id });
      await commitSnapshotDirectory(stage, locations.target);
      await this.fault('after-import-install', { gameId, id: original.id });
      await atomicJson(locations.file, { ...journal, status: 'committed' });
    } catch (error) {
      const errMessage = /** @type {Error} */ (error).message;
      try {
        await this.finishImportReplacement(journal);
      } catch (rollbackError) {
        const rbMessage = /** @type {Error} */ (rollbackError).message;
        await this.logger.error('import-replace-rollback-failed', {
          gameId,
          id: original.id,
          error: errMessage,
          rollbackError: rbMessage,
        });
        throw new Error(this.t('storage.importReplaceRollbackFailed', { error: errMessage, rollbackError: rbMessage }));
      }
      throw new Error(this.t('storage.importReplaceAborted', { error: errMessage }));
    }
    // Once committed, cleanup failure must not misreport the successful replacement.
    // The persisted journal lets startup finish removing the previous copy.
    await this.finishImportReplacement({ ...journal, status: 'committed' }).catch(err =>
      this.logger.warn('import-replace-cleanup-deferred', { gameId, id: original.id, error: err.message }),
    );
  }

  async recoverImportReplacements() {
    const directory = path.join(this.dataDir, 'import-transactions');
    await assertNoLinks(directory, this.lang);
    let files;
    try {
      files = await fs.readdir(directory);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    for (const name of files.filter(name => name.endsWith('.json'))) {
      const file = path.join(directory, name);
      await assertNoLinks(file, this.lang);
      let journal;
      try {
        journal = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch (error) {
        const quarantineDir = path.join(directory, 'quarantine');
        await fs.mkdir(quarantineDir, { recursive: true });
        await fs.rename(file, path.join(quarantineDir, name)).catch(() => {});
        await this.logger.error('quarantined-corrupt-import-journal', {
          name,
          error: /** @type {Error} */ (error).message,
        });
        this.recoveryMessages.push(this.t('storage.quarantinedCorruptJournal', { name }));
        continue;
      }
      if (this.importReplacementPaths(journal).file !== file) {
        throw new Error(this.t('storage.importReplaceIdentityMismatch'));
      }
      // Explicit game cleanup owns these payloads; never resurrect them on restart.
      if (this.config.games.some((/** @type {any} */ game) => game.id === journal.gameId && (game.purgeGamePending || game.purgeSnapshotsPending))) {
        continue;
      }
      await this.finishImportReplacement(journal);
      if (journal.status === 'prepared') {
        await this.logger.info('recovered-interrupted-import-replace', { gameId: journal.gameId, id: journal.id });
        this.recoveryMessages.push(this.t('storage.recoveredInterruptedImportReplace'));
      }
    }
  }

  /**
   * @param {any} candidate
   * @param {any[]} snapshots
   */
  importMatches(candidate, snapshots) {
    const key = (/** @type {string} */ value) =>
      this.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    // An imported directory identifies a save even when its contents have changed.
    // Equal contents in distinct source directories may be intentional checkpoints.
    return snapshots.filter(
      snapshot =>
        (snapshot.origin?.path && key(snapshot.origin.path) === key(candidate.source)) ||
        (candidate.bundle &&
          candidate.meta &&
          (snapshot.id === candidate.meta.id ||
            (snapshot.origin?.gameId === candidate.meta.gameId && snapshot.origin?.snapshotId === candidate.meta.id))),
    );
  }

  /**
   * @param {string} gameId
   * @param {string} directory
   */
  async prepareImport(gameId, directory) {
    return this.exclusive(async () => {
      const plan = await this.prepareImportPlan(gameId, directory);
      return structuredClone({
        id: plan.id,
        gameId,
        directory,
        failed: plan.failed,
        items: plan.items.map((/** @type {any} */ item) => ({
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
   * @param {string} planId
   */
  cancelImport(planId) {
    if (this.pendingImport?.id === planId) this.pendingImport = null;
  }

  /**
   * @param {string} gameId
   * @param {string} directory
   * @param {{ game?: any; bundle?: boolean }} [options]
   */
  async prepareImportPlan(gameId, directory, { game = this.game(gameId), bundle = false } = {}) {
    if (!bundle) this.pendingImport = null;
    const entries = cleanItems(game.locations[this.platform]?.items || [], { allowEmpty: bundle, lang: this.lang });
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
      throw new Error(this.t('storage.pickLegacyDirRequired'));
    }
    directory = path.resolve(directory);
    await assertNoLinks(directory, this.lang);
    if (within(this.dataDir, directory, this.platform) || within(directory, this.dataDir, this.platform)) {
      throw new Error(this.t('storage.cannotImportFromVault'));
    }
    const manifestFile = path.join(directory, 'manifest.json');
    const collectionFile = path.join(directory, 'collection.json');
    /** @type {{ id: string; gameId: string; entries: string[]; directory: string; items: any[]; failed: { name: string; error: string }[]; bundle: boolean; indexHash?: string }} */
    const plan = { id: randomUUID(), gameId, entries, directory, items: [], failed: [], bundle };
    const existing = await this.snapshots(gameId, true);
    /** @type {any[]} */
    let candidates;
    const namedExports = await this.namedExportCandidates(directory);
    if (namedExports) {
      candidates = namedExports;
    } else if (await statMaybe(collectionFile)) {
      await assertNoLinks(collectionFile, this.lang);
      const collection = JSON.parse(await fs.readFile(collectionFile, 'utf8'));
      if (collection.version !== 1 || collection.type !== 'savehub-collection') {
        throw new Error(this.t('storage.invalidCollectionManifest'));
      }
      candidates = this.validateSelection(collection.snapshots).map(id => ({
        name: id,
        id,
        exported: path.join(directory, `SaveHub-${id}`),
      }));
    } else if (await statMaybe(manifestFile)) {
      candidates = [{ name: path.basename(directory), exported: directory }];
    } else {
      const children = await fs.readdir(directory, { withFileTypes: true });
      candidates = children
        .filter(item => item.isDirectory() && item.name.startsWith('ArchiveFile'))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
        .map(item => ({ name: item.name, source: path.join(directory, item.name) }));
      if (!candidates.length) candidates = [{ name: path.basename(directory), source: directory }];
    }
    if (candidates.length > 10000) throw new Error(this.t('storage.maxImportCandidates'));
    for (const [index, candidate] of candidates.entries()) {
      this.onProgress({ phase: 'checking', completed: index, total: candidates.length, detail: candidate.name });
      try {
        if (candidate.exported) {
          const manifest = path.join(candidate.exported, 'manifest.json');
          if (!candidate.meta) await assertNoLinks(manifest, this.lang);
          const meta = candidate.meta || validateManifest(JSON.parse(await fs.readFile(manifest, 'utf8')), this.lang);
          if (candidate.id && candidate.id !== meta.id) {
            throw new Error(this.t('storage.exportIdMismatch'));
          }
          candidate.name = meta.label;
          if (!bundle && !equal([...meta.entries].sort(), [...entries].sort())) {
            throw new Error(this.t('storage.exportEntriesMismatch'));
          }
          if (
            bundle &&
            (!['manual', 'imported', 'safety'].includes(meta.kind) ||
              !['win32', 'darwin'].includes(meta.platform) ||
              !Number.isFinite(Date.parse(meta.createdAt)) ||
              (meta.deletedAt && !Number.isFinite(Date.parse(meta.deletedAt))) ||
              meta.purgePending)
          ) {
            throw new Error(this.t('storage.bundleSnapshotInvalidState'));
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
        const data = await inventory(candidate.source, candidate.entries || entries, {
          allowMissing: Boolean(candidate.allowMissing),
          lang: this.lang,
        });
        if (candidate.meta && signature(data) !== signature(candidate.meta)) {
          throw new Error(this.t('storage.exportIntegrityFailed'));
        }
        plan.items.push({
          ...candidate,
          id: randomUUID(),
          fingerprint: fingerprint(data),
          bytes: data.records.reduce((total, record) => total + (record.size || 0), 0),
          fileCount: data.records.filter(record => record.type === 'file').length,
          matches: this.importMatches(candidate, existing),
        });
      } catch (error) {
        plan.failed.push({ name: candidate.name, error: /** @type {Error} */ (error).message });
      }
    }
    if (!bundle) this.pendingImport = plan;
    return plan;
  }

  /**
   * @param {string} planId
   * @param {any[]} decisions
   */
  async executeImport(planId, decisions) {
    return this.exclusive(() => this.executeImportPlan(planId, decisions));
  }

  /**
   * @param {string} planId
   * @param {any[]} decisions
   */
  async executeImportPlan(planId, decisions) {
    const plan = this.pendingImport;
    if (!plan || plan.id !== planId) throw new Error(this.t('storage.importPlanExpired'));
    const game = this.game(plan.gameId);
    const choices = await this.validateImportPlan(plan, decisions);
    this.pendingImport = null; // An execution token is single use, including partial failure.
    return this.applyImportPlan(plan, choices, game);
  }

  /**
   * @param {any} plan
   * @param {any[]} decisions
   */
  async validateImportPlan(plan, decisions) {
    if (!plan.bundle && !equal(cleanItems(this.game(plan.gameId).locations[this.platform]?.items || [], { lang: this.lang }), plan.entries)) {
      throw new Error(this.t('storage.gameConfigChangedDuringImport'));
    }
    const duplicates = plan.items.filter((/** @type {any} */ item) => item.matches.length);
    if (!Array.isArray(decisions) || decisions.length !== duplicates.length) {
      throw new Error(this.t('storage.missingDuplicateDecisions'));
    }
    const choices = new Map(),
      targets = new Set();
    for (const decision of decisions) {
      const item = duplicates.find((/** @type {any} */ item) => item.id === decision?.itemId);
      if (!item || choices.has(item.id) || !['overwrite', 'skip', 'keep-both'].includes(decision.action)) {
        throw new Error(this.t('storage.invalidDuplicateDecision'));
      }
      if (decision.action === 'overwrite') {
        const target = item.matches.find((/** @type {any} */ snapshot) => snapshot.id === decision.targetId);
        if (!target || targets.has(target.id)) {
          throw new Error(this.t('storage.duplicateOverwriteTarget'));
        }
        if (target.protected || target.deletedAt || target.purgePending || target.kind === 'safety') {
          throw new Error(this.t('storage.protectedTrashSafetyCannotOverwrite'));
        }
        targets.add(target.id);
      }
      choices.set(item.id, decision);
    }
    // Reject stale library decisions before committing any item in the batch.
    const existing = await this.snapshots(plan.gameId, true);
    for (const item of plan.items) {
      if (!equal(this.importMatches(item, existing), item.matches)) {
        throw new Error(this.t('storage.duplicateMatchesChanged'));
      }
    }
    return choices;
  }

  /**
   * @param {any} plan
   * @param {Map<string, any>} choices
   * @param {any} game
   */
  async applyImportPlan(plan, choices, game) {
    const existing = await this.snapshots(game.id, true);
    /** @type {{ imported: string[]; overwritten: string[]; keptBoth: string[]; skipped: string[]; failed: { name: string; error: string }[] }} */
    const report = { imported: [], overwritten: [], keptBoth: [], skipped: [], failed: [...plan.failed] };
    const names = new Set([
      ...existing.map(item => foldedName(item.label)),
      ...plan.items.map((/** @type {any} */ item) => foldedName(item.name.slice(0, 100))),
    ]);
    for (const [index, item] of plan.items.entries()) {
      this.onProgress({ phase: 'importing', completed: index, total: plan.items.length, detail: item.name });
      const choice = choices.get(item.id);
      if (choice?.action === 'skip') {
        report.skipped.push(item.name);
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
        const replace = choice?.action === 'overwrite' ? await this.readSnapshot(game.id, choice.targetId) : undefined;
        if (replace && !equal(publicSnapshot(replace), item.matches.find((/** @type {any} */ target) => target.id === replace.id))) {
          throw new Error(this.t('storage.overwriteTargetChanged'));
        }
        await this.capture(game, item.source, item.entries || plan.entries, {
          label,
          note: item.note || this.t('storage.importedFromNote', { source: item.source }),
          kind: 'imported',
          allowMissing: Boolean(item.allowMissing),
          origin: {
            path: item.source,
            ...(item.bundle ? { gameId: item.meta.gameId, snapshotId: item.meta.id } : {}),
          },
          favorite: item.favorite,
          protected: item.protected,
          expectedFingerprint: item.fingerprint,
          replace,
          metadata: item.bundle
            ? {
                kind: item.meta.kind,
                platform: item.meta.platform,
                createdAt: item.meta.createdAt,
                ...(item.meta.deletedAt ? { deletedAt: item.meta.deletedAt } : {}),
              }
            : undefined,
        });
        names.add(foldedName(label));
        if (choice?.action === 'overwrite') report.overwritten.push(item.name);
        else if (choice?.action === 'keep-both') report.keptBoth.push(label);
        else report.imported.push(item.name);
      } catch (error) {
        report.failed.push({ name: item.name, error: /** @type {Error} */ (error).message });
      }
    }
    return report;
  }

  // Non-interactive callers retain the conservative default of skipping duplicates.
  // The desktop UI always uses prepareImport + explicit per-item decisions.
  /**
   * @param {string} gameId
   * @param {string} directory
   */
  async importLegacy(gameId, directory) {
    return this.exclusive(async () => {
      const plan = await this.prepareImportPlan(gameId, directory);
      return this.executeImportPlan(
        plan.id,
        plan.items.filter(item => item.matches.length).map(item => ({ itemId: item.id, action: 'skip' })),
      );
    });
  }

  /**
   * @param {string} gameId
   * @param {string} id
   * @param {string} destination
   */
  async exportSnapshot(gameId, id, destination) {
    const result = await this.exportSnapshots(gameId, [id], destination);
    return result.folder;
  }

  /**
   * @param {string} root
   * @param {string} [onlyFolder]
   */
  async exportIndexCandidates(root, onlyFolder) {
    const indexDir = path.join(root, EXPORT_INDEX);
    await assertNoLinks(indexDir, this.lang);
    if (!(await statMaybe(indexDir))?.isDirectory()) return null;
    const candidates = [];
    const seen = new Set();
    for (const file of (await fs.readdir(indexDir)).filter(file => file.endsWith('.json')).sort()) {
      await assertNoLinks(path.join(indexDir, file), this.lang);
      const index = JSON.parse(await fs.readFile(path.join(indexDir, file), 'utf8'));
      if (
        index.version !== 2 ||
        index.type !== 'savehub-collection' ||
        !Array.isArray(index.snapshots) ||
        !index.snapshots.length ||
        index.snapshots.length > 10000
      ) {
        throw new Error(this.t('storage.invalidNamedExportIndex'));
      }
      for (const item of index.snapshots) {
        const [name] = cleanItems([item.directory], { lang: this.lang });
        if (name.includes('/') || foldedName(name) === EXPORT_INDEX || seen.has(foldedName(name))) {
          throw new Error(this.t('storage.invalidOrDuplicateExportDir'));
        }
        seen.add(foldedName(name));
        if (onlyFolder && name !== onlyFolder) continue;
        const meta = validateManifest(item.manifest, this.lang);
        candidates.push({ name: meta.label, id: meta.id, meta, exported: path.join(root, name) });
      }
    }
    return candidates.length ? candidates : null;
  }

  /**
   * @param {string} directory
   */
  async namedExportCandidates(directory) {
    // A single named folder can contain arbitrary game files named manifest.json or collection.json.
    return (
      (await this.exportIndexCandidates(path.dirname(directory), path.basename(directory))) ||
      (await this.exportIndexCandidates(directory))
    );
  }

  /**
   * @param {string} gameId
   * @param {any} meta
   * @param {string} folder
   */
  async writeExport(gameId, meta, folder) {
    await copyRecords(path.join(this.snapshotDir(gameId, meta.id), 'payload'), folder, meta.records, this.onProgress);
    const copy = await inventory(folder, meta.entries, { allowMissing: true, lang: this.lang });
    if (signature(copy) !== signature(meta)) throw new Error(this.t('storage.exportWriteVerifyFailed'));
  }

  /**
   * @param {string} gameId
   * @param {string[] | 'all'} selection
   * @param {string} destination
   */
  async exportSnapshots(gameId, selection, destination) {
    return this.exclusive(async () => {
      const game = this.game(gameId);
      const ids =
        selection === 'all'
          ? (await this.snapshots(gameId)).filter(meta => ['manual', 'imported'].includes(meta.kind)).map(meta => meta.id)
          : selection;
      const selected = this.validateSelection(ids);
      if (typeof destination !== 'string' || !path.isAbsolute(destination)) {
        throw new Error(this.t('storage.pickExportDirRequired'));
      }
      await assertNoLinks(destination, this.lang);
      if (within(this.dataDir, destination, this.platform)) {
        throw new Error(this.t('storage.exportDirInsideVault'));
      }
      const metas = [];
      for (const id of selected) metas.push(await this.verify(gameId, id));
      const totalBytes = metas.reduce((sum, meta) => sum + (meta.bytes || 0), 0);
      await assertDiskSpace(destination, totalBytes, this.lang);
      const batchId = randomUUID();
      const stage = path.join(destination, `.savehub-export-${batchId}`);
      const existing = new Set((await fs.readdir(destination)).map(foldedName));
      // Old unwrapped exports may retain index entries after a named folder is moved.
      // Reserve those names so importing the new bundle cannot resolve to an old entry.
      for (const candidate of (await this.exportIndexCandidates(destination)) || []) {
        existing.add(foldedName(path.basename(candidate.exported)));
      }
      const folder = path.join(destination, uniqueExportName(`${exportName(game.name)}-存档导出`, existing));
      const indexDir = path.join(folder, EXPORT_INDEX);
      const taken = new Set([EXPORT_INDEX]);
      const directories = metas.map(meta => uniqueExportName(exportName(meta.label), taken));
      const published = [];
      const indexFile = path.join(indexDir, `${batchId}.json`);
      let folderCreated = false;
      await fs.mkdir(stage);
      try {
        for (const [index, meta] of metas.entries()) {
          this.onProgress({ phase: 'exporting', completed: index, total: metas.length, detail: meta.label });
          await this.writeExport(gameId, meta, path.join(stage, directories[index]));
        }
        // Claim a fresh bundle only after all payloads are verified. Never replace
        // a folder created by another process after our name preflight.
        await this.fault('before-export-bundle-publish', { folder });
        await fs.mkdir(folder);
        folderCreated = true;
        await fs.mkdir(indexDir);
        for (const name of directories) {
          const target = path.join(folder, name),
            source = path.join(stage, name);
          await this.fault('before-export-publish', { directory: name, folder });
          await fs.mkdir(target);
          published.push(target);
          for (const child of await fs.readdir(source)) {
            await fs.rename(path.join(source, child), path.join(target, child));
          }
        }
        await atomicJson(indexFile, {
          version: 2,
          type: 'savehub-collection',
          gameId,
          gameName: game.name,
          exportedAt: new Date().toISOString(),
          snapshots: metas.map((manifest, index) => ({ directory: directories[index], manifest })),
        });
        return { folder, count: metas.length, directories, indexFile };
      } catch (error) {
        for (const target of published) {
          if (
            !within(destination, folder, this.platform) ||
            folder === destination ||
            !within(folder, target, this.platform) ||
            target === folder
          ) {
            throw new Error(this.t('storage.exportCleanupOutOfBounds'));
          }
          await fs.rm(target, { recursive: true, force: true });
        }
        if (folderCreated) {
          // Remove only empty containers so concurrent, unrelated files survive.
          await fs.rmdir(indexDir).catch(err => this.logger.warn('export-index-rmdir-failed', { indexDir, error: err.message }));
          await fs.rmdir(folder).catch(err => this.logger.warn('export-folder-rmdir-failed', { folder, error: err.message }));
        }
        throw error;
      } finally {
        // This uniquely named, owned staging folder is always inside the chosen destination.
        if (!within(destination, stage, this.platform)) throw new Error(this.t('storage.exportStageOutOfBounds'));
        await fs.rm(stage, { recursive: true, force: true }).catch(err =>
          this.logger.warn('export-stage-cleanup-failed', { stage, error: err.message }),
        );
      }
    });
  }
}
