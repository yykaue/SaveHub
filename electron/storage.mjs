import * as restore_transaction from './restore-transaction.mjs';
import * as snapshot_import from './snapshot-import.mjs';
import * as snapshot_export from './snapshot-export.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { DEFAULT_LANGUAGE, LANGUAGES, normalizeLanguage, setBackendLanguage, translate } from './i18n.mjs';
import {
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
  withinOnDisk,
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
import { progressRange } from './progress.mjs';
import { DEFAULT_LOG_LIMIT_MB, BYTES_PER_MB, validLogLimit } from '../shared/log-settings.mjs';
import {
  DEFAULT_RETENTION,
  effectiveRetention,
  normalizeRetention,
  retentionCount,
  pruneRestorePoints,
  validateRecoveryCount,
} from './retention.mjs';

import { SummaryCache } from './summary-cache.mjs';
import { AppError } from './errors.mjs';
import { readLibrary, recoverPreviousLibrary } from './library-config.mjs';
import { publicIcon } from './game-icons.mjs';

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
export const DEFAULT_MAX_RESTORE_POINTS = DEFAULT_RETENTION.active;

/**
 * SaveHub 核心存储与事务协调中心：
 * 管理本地保险库目录（vault）、全局配置（library.json）、快照摘要缓存（manifestCache）、
 * 互斥写锁（exclusive）以及启动时的未决事务恢复与恢复点队列裁剪。
 */
export class SaveStore {
  /**
   * @param {string} dataDir
   * @param {{ platform?: string; onProgress?: (p: import('../shared/contracts').Progress | null) => void; fault?: (phase: string, data?: any) => Promise<void>; maxRestorePoints?: number }} [options]
   */
  constructor(
    dataDir,
    {
      platform = process.platform,
      onProgress = () => {},
      fault = async () => {},
      maxRestorePoints = DEFAULT_MAX_RESTORE_POINTS,
    } = {},
  ) {
    this.dataDir = path.resolve(dataDir);
    this.vault = path.join(this.dataDir, 'vault');
    this.configFile = path.join(this.dataDir, 'library.json');
    if (platform !== 'win32' && platform !== 'darwin')
      throw new Error('SaveHub supports Windows and macOS Apple Silicon only.');
    /** @type {import('../shared/contracts').Platform} */
    this.platform = platform;
    this.onProgress = onProgress;
    this.fault = fault;
    this.maxRestorePoints = maxRestorePoints;
    /** @type {Set<string>} */
    this.blockedGames = new Set();
    /** @type {Set<string>} */
    this.retentionDeferred = new Set();
    this.busy = false;
    /** @type {import('./models').LibraryConfig} */
    this.config = {
      version: 1,
      games: [],
      theme: 'ink',
      language: DEFAULT_LANGUAGE,
      restorePointRetention: { ...DEFAULT_RETENTION },
      logLimitMB: DEFAULT_LOG_LIMIT_MB,
    };
    /** @type {import('./models').InternalImportPlan | null} */
    this.pendingImport = null;
    /** @type {any} */
    this.pendingGameImport = null;
    /** @type {string[]} */
    this.recoveryMessages = [];
    this.manifestCache = new SummaryCache();
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

  /** @param {string} code @param {Record<string, string | number>} [params] */
  error(code, params) {
    return new AppError(code, params, this.lang);
  }

  /**
   * @param {string} gameId
   * @param {string} id
   */
  invalidateSnapshotCache(gameId, id) {
    this.manifestCache.delete(`${gameId}/${id}`);
    this.manifestCache.delete(`${gameId}/list`);
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
   * @param {{ recoverPrevious?: boolean }} [options]
   */
  async init(presets = [], { recoverPrevious = false } = {}) {
    await assertNoLinks(this.dataDir);
    await fs.mkdir(this.vault, { recursive: true });
    try {
      if (recoverPrevious) {
        const recovery = await recoverPreviousLibrary(this.configFile);
        this.config = recovery.config;
        this.recoveryMessages.push(this.t('storage.libraryRecovered', { file: recovery.preserved }));
      } else this.config = await readLibrary(this.configFile);
      if (this.config.version !== 1 || !Array.isArray(this.config.games)) {
        throw this.error('storage.invalidConfigFormat');
      }
      if (!LANGUAGES.includes(this.config.language)) this.config.language = DEFAULT_LANGUAGE;
      setBackendLanguage(this.config.language);
      this.config.games.forEach((game) => {
        safeId(game.id, this.lang);
        if (game.restorePointRetention) normalizeRetention(game.restorePointRetention, true, this.lang);
      });
    } catch (error) {
      if (!missing(error)) {
        const message = this.t('storage.corruptLibrary', {
          file: this.configFile,
          error: /** @type {Error} */ (error).message,
        });
        await this.logger.error('corrupt-library-config', {
          file: this.configFile,
          error: /** @type {Error} */ (error).message,
        });
        const recoveryAvailable = await readLibrary(`${this.configFile}.previous`).then(
          () => true,
          () => false,
        );
        throw Object.assign(new Error(message), { code: 'LIBRARY_CORRUPT', recoveryAvailable });
      }
      this.config = {
        version: 1,
        theme: 'ink',
        language: DEFAULT_LANGUAGE,
        games: presets,
        restorePointRetention: { active: this.maxRestorePoints, removed: DEFAULT_RETENTION.removed },
        logLimitMB: DEFAULT_LOG_LIMIT_MB,
      };
      setBackendLanguage(this.config.language);
      await this.saveConfig();
    }
    if (!this.config.restorePointRetention) {
      this.config.restorePointRetention = { ...DEFAULT_RETENTION };
      delete this.config.maxRestorePoints;
      await this.saveConfig();
    } else normalizeRetention(this.config.restorePointRetention, false, this.lang);
    if (this.config.logLimitMB === undefined) {
      this.config.logLimitMB = DEFAULT_LOG_LIMIT_MB;
      await this.saveConfig();
    }
    await this.logger.setMaxBytes(this.config.logLimitMB * BYTES_PER_MB).catch(() => {});
    await restore_transaction.recoverTransactions(this);
    for (const game of this.config.games.filter((game) => game.purgeGamePending || game.purgeSnapshotsPending)) {
      // 旧版仅清理快照的挂起意图（purgeSnapshotsPending）在启动恢复时保持其原有清理范围。
      try {
        await (game.purgeGamePending ? purgeGame(this, game.id) : purgeGameSnapshots(this, game.id));
      } catch (error) {
        const errMessage = /** @type {Error} */ (error).message;
        await this.logger.warn('pending-game-cleanup-incomplete', { gameId: game.id, error: errMessage });
        this.recoveryMessages.push(
          this.t('storage.gameCleanupPendingRecovery', { name: game.name, error: errMessage }),
        );
      }
    }
    await snapshot_import.recoverImportReplacements(this);
    for (const game of this.config.games) {
      if (!game.deletedAt && !game.purgeGamePending && !game.purgeSnapshotsPending)
        await this.pruneRestorePoints(game.id);
    }
    await this.logger.info('startup', {
      operation: 'startup',
      phase: 'committed',
      result: 'success',
      blockedGames: [...this.blockedGames],
    });
    return this;
  }

  /**
   * 全局串行写操作互斥锁：拒绝并发写请求，并在任务结束时重置进度面板状态。
   * @template T
   * @param {() => Promise<T>} action
   * @returns {Promise<T>}
   */
  async exclusive(action) {
    if (this.busy) throw this.error('storage.operationBusy');
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
      try {
        this.onProgress(null);
      } catch (error) {
        await this.logger.warn('progress-notification-failed', { error: String(error) });
      }
    }
  }

  /**
   * @param {string} id
   * @param {boolean} [includeDeleted]
   */
  game(id, includeDeleted = false) {
    safeId(id, this.lang);
    const game = this.config.games.find((item) => item.id === id && (includeDeleted || !item.deletedAt));
    if (!game) throw this.error('storage.gameNotFound');
    return game;
  }

  /** 校验游戏是否可写：当游戏存在未决或回滚失败的恢复事务时拒绝一切修改 @param {string} gameId */
  assertGameWritable(gameId) {
    if (this.blockedGames.has(gameId)) throw this.error('storage.gameRecoveryBlocked');
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
   * @returns {Promise<import('../src/types').Snapshot[]>}
   */
  async snapshots(gameId, includeDeleted = false) {
    const directory = path.join(this.gameDir(gameId), 'snapshots');
    await assertNoLinks(directory, this.lang);
    const directoryStat = await statBigIntMaybe(directory);
    if (!directoryStat) return [];
    const directorySignature = `${directoryStat.ino}:${directoryStat.mtimeNs}:${directoryStat.ctimeNs}`;
    const cached = this.manifestCache.get(`${gameId}/list`);
    // 内部写入会同步主动失效缓存；外部直接修改目录的列表刷新延迟不超过 1 秒，且所有写操作与校验始终重读完整 manifest。
    if (cached?.signature === directorySignature && Date.now() - cached.time < 1000) {
      /** @type {import('../shared/contracts').Snapshot[]} */
      const items = cached.ids.map((/** @type {string} */ id) => this.manifestCache.get(`${gameId}/${id}`)?.meta);
      if (items.every(Boolean)) return structuredClone(items.filter((item) => includeDeleted || !item.deletedAt));
    }
    /** @type {import('../shared/contracts').Snapshot[]} */
    const result = [];
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const ids = new Set(
      entries
        .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.'))
        .map((entry) => entry.name),
    );
    const purgeIds = new Set();
    for (const entry of entries) {
      const match = entry.name.match(/^\.purge-([a-z0-9-]{1,64})\.json$/);
      if (match && (entry.isFile() || entry.isSymbolicLink())) {
        ids.add(match[1]);
        purgeIds.add(match[1]);
      }
    }
    const orderedIds = [...ids];
    for (let offset = 0; offset < orderedIds.length; offset += 8) {
      await Promise.all(
        orderedIds.slice(offset, offset + 8).map(async (id) => {
          try {
            const meta = await this.readSnapshot(gameId, id, true, {
              trustedParent: true,
              hasPurgeMarker: purgeIds.has(id),
            });
            result.push(meta);
          } catch (error) {
            /** @type {import('../shared/contracts').Snapshot} */
            const damaged = {
              id,
              gameId,
              label: this.t('storage.corruptedLabel', { id: id.slice(0, 8) }),
              note: '',
              kind: 'manual',
              platform: this.platform,
              corrupted: true,
              error: /** @type {Error} */ (error).message,
              createdAt: '',
              updatedAt: '',
              bytes: 0,
              fileCount: 0,
              entries: [],
              absent: [],
            };
            result.push(damaged);
            this.manifestCache.set(`${gameId}/${id}`, { meta: damaged, statSignature: '' });
          }
        }),
      );
    }
    result.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    this.manifestCache.set(`${gameId}/list`, {
      signature: directorySignature,
      ids: result.map((item) => item.id),
      time: Date.now(),
    });
    return structuredClone(result.filter((item) => includeDeleted || !item.deletedAt));
  }

  /** @returns {Promise<Omit<import('../shared/contracts').AppState, 'version'>>} */
  async state() {
    const games = await Promise.all(
      this.config.games.map(async (game) => {
        const location = game.locations[this.platform];
        /** @type {import('../shared/contracts').Game['pathStatus']} */
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
        if (game.legacyRoot && !game.deletedAt) {
          try {
            legacyCount = (await fs.readdir(game.legacyRoot, { withFileTypes: true })).filter(
              (item) => item.isDirectory() && item.name.startsWith('ArchiveFile'),
            ).length;
          } catch {
            /* 旧版备份目录为可选项，不存在或不可读时静默忽略。 */
          }
        }
        const stored = await this.snapshots(game.id, true);
        return {
          ...game,
          icon: publicIcon(game),
          restorePointRetentionEffective: effectiveRetention(this, game.id),
          recoveryBlocked: this.blockedGames.has(game.id),
          snapshots: stored.filter((snapshot) => snapshot.kind !== 'safety'),
          restorePoints: stored.filter((snapshot) => snapshot.kind === 'safety'),
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
      restorePointRetention: { ...this.config.restorePointRetention },
      logLimitMB: this.config.logLimitMB,
    };
  }

  /** @param {{ active: number; removed: number }} input */
  async setRestorePointRetention(input) {
    return this.exclusive(async () => {
      normalizeRetention(input, false, this.lang);
      const next = {
        active: retentionCount(input.active, this.lang),
        removed: retentionCount(input.removed, this.lang),
      };
      const previous = this.config;
      this.config = { ...previous, restorePointRetention: next };
      try {
        await this.saveConfig();
      } catch (error) {
        this.config = previous;
        throw error;
      }
      for (const game of this.config.games) if (!game.deletedAt) await this.pruneRestorePoints(game.id);
    });
  }

  /** @param {number} value */
  async setLogLimitMB(value) {
    return this.exclusive(async () => {
      if (!validLogLimit(value)) throw this.error('logs.invalidLimit');
      const previous = this.config;
      this.config = { ...previous, logLimitMB: value };
      try {
        await this.saveConfig();
      } catch (error) {
        this.config = previous;
        throw error;
      }
      await this.logger.setMaxBytes(value * BYTES_PER_MB);
    });
  }

  /**
   * @param {import('../shared/contracts').Theme} theme
   */
  async setTheme(theme) {
    return this.exclusive(async () => {
      if (!THEMES.includes(theme)) throw this.error('storage.unknownTheme');
      this.config.theme = theme;
      await this.saveConfig();
    });
  }

  /**
   * @param {import('../shared/contracts').Language} language
   */
  async setLanguage(language) {
    return this.exclusive(async () => {
      if (!LANGUAGES.includes(language)) throw this.error('storage.unknownLanguage');
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
      this.assertGameWritable(game.id);
      await this.commitGame(game);
      await this.pruneRestorePoints(game.id);
      return game.id;
    });
  }

  /**
   * 仅调整给定游戏所占位置的顺序，保留筛选之外的游戏和全部配置。
   * @param {string[]} ids
   */
  async reorderGames(ids) {
    return this.exclusive(async () => {
      if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || new Set(ids).size !== ids.length)
        throw this.error('errors.invalidArguments');
      const previous = this.config;
      const byId = new Map(previous.games.map((game) => [game.id, game]));
      const ordered = ids.map((id) => {
        safeId(id, this.lang);
        const game = byId.get(id);
        if (!game) throw this.error('storage.gameNotFound');
        return game;
      });
      const selected = new Set(ids);
      let index = 0;
      const games = previous.games.map((game) => (selected.has(game.id) ? ordered[index++] : game));
      if (games.every((game, position) => game === previous.games[position])) return;
      this.config = { ...previous, games };
      try {
        await this.saveConfig();
      } catch (error) {
        this.config = previous;
        throw error;
      }
    });
  }

  /**
   * @param {import('./models').StoredGame} game
   */
  async commitGame(game) {
    const previous = this.config;
    const games = previous.games.filter((item) => item.id !== game.id);
    const index = previous.games.findIndex((item) => item.id === game.id);
    games.splice(index < 0 ? games.length : index, 0, game);
    this.config = { ...previous, games };
    try {
      await this.saveConfig();
    } catch (error) {
      this.config = previous;
      throw error;
    }
    // library.json 是唯一权威数据源；游戏目录下的 game.json 缓存写入失败不回滚已提交的配置。
    await atomicJson(path.join(this.gameDir(game.id), 'game.json'), game).catch((err) =>
      this.logger.warn('game-cache-write-failed', { gameId: game.id, error: err.message }),
    );
  }

  /**
   * @param {string} id
   */
  async forgetGame(id) {
    safeId(id, this.lang);
    const previous = this.config;
    this.config = { ...previous, games: previous.games.filter((game) => game.id !== id) };
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
   * @param {import('../shared/contracts').ImportDecision[]} decisions
   */
  async reviewGameImport(planId, decisions) {
    return this.exclusive(() => reviewGameImport(this, planId, decisions));
  }

  /**
   * @param {string} planId
   * @param {import('../shared/contracts').GameSnapshotDecision[]} decisions
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
   * @param {import('./models').StoredGame} game
   * @param {string[]} [entriesOverride]
   */
  async location(game, entriesOverride) {
    const location = game.locations[this.platform];
    if (!location?.root || !path.isAbsolute(location.root)) {
      throw this.error('storage.unconfiguredRoot');
    }
    const root = path.resolve(location.root);
    if (root === path.parse(root).root) throw this.error('storage.diskRootForbidden');
    await assertNoLinks(root, this.lang);
    const rootStat = await statMaybe(root);
    if (!rootStat?.isDirectory()) throw this.error('storage.gameDirMissing', { root });
    const entries = cleanItems(entriesOverride || location.items, { lang: this.lang });
    for (const entry of entries) {
      const target = path.join(root, entry);
      if (
        (await withinOnDisk(target, this.dataDir, this.platform)) ||
        (await withinOnDisk(this.dataDir, target, this.platform))
      ) {
        throw this.error('storage.overlapWithVault');
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
      this.assertGameWritable(gameId);
      const { root, entries } = await this.location(game);
      return publicSnapshot(
        await this.capture(game, root, entries, { label: options.label, note: options.note, kind: 'manual' }),
      );
    });
  }

  /**
   * 采集并校验游戏存档快照的核心流水线：
   * 1. 预检源路径无符号链接且游戏可写，扫描源目录并检查保险库磁盘空间；
   * 2. 将源文件流式复制到临时暂存目录 `.pending-<id>/payload` 并计算 SHA-256；
   * 3. 重新扫描暂存目录与源目录，双向比对签名以防备份期间游戏正在写入导致数据撕裂；
   * 4. 生成并校验 `manifest.json`，最后原子提交目录（或走覆盖导入的两阶段替换事务）。
   * @param {import('./models').StoredGame} game
   * @param {string} root
   * @param {string[]} entries
   * @param {{
   *   label?: string;
   *   note?: string;
   *   kind?: string;
   *   allowMissing?: boolean;
   *   origin?: { path?: string; gameId?: string; snapshotId?: string };
   *   favorite?: boolean;
   *   protected?: boolean;
   *   expectedFingerprint?: string;
   *   replace?: import('./models').Manifest;
   *   metadata?: Record<string, any>;
   *   initialSource?: import('./models').Inventory;
   *   skipDiskCheck?: boolean;
   * }} [options]
   */
  async capture(
    game,
    root,
    entries,
    {
      label,
      note = '',
      kind = 'manual',
      allowMissing = false,
      origin,
      favorite = false,
      protected: protectedTag = false,
      expectedFingerprint,
      replace,
      metadata,
      initialSource,
      skipDiskCheck = false,
    } = {},
  ) {
    if (typeof label !== 'string' || !label.trim() || label.length > 100) {
      throw this.error('storage.labelLength');
    }
    if (typeof note !== 'string' || note.length > 2000) {
      throw this.error('storage.noteLength');
    }
    await assertNoLinks(root, this.lang);
    this.assertGameWritable(game.id);
    const source = initialSource
      ? { absent: [...initialSource.absent], records: initialSource.records.map((record) => ({ ...record })) }
      : await inventory(root, entries, {
          allowMissing,
          progress: progressRange(this.onProgress, 0, 10),
          lang: this.lang,
          hash: false,
        });
    const totalBytes = source.records.reduce((total, record) => total + (record.size || 0), 0);
    if (!skipDiskCheck) await assertDiskSpace(this.vault, totalBytes, this.lang);
    const id = randomUUID();
    const stage = path.join(this.gameDir(game.id), 'snapshots', `.pending-${id}`);
    const destination = this.snapshotDir(game.id, id);
    try {
      source.records = await copyRecords(
        root,
        path.join(stage, 'payload'),
        source.records,
        progressRange(this.onProgress, 10, 70),
        this.lang,
      );
      if (expectedFingerprint && fingerprint(source) !== expectedFingerprint) {
        throw this.error('storage.importSourceChangedAfterConfirm');
      }
      this.onProgress({ phase: 'checking', detail: label, completed: 0, percent: 70 });
      const copied = await inventory(path.join(stage, 'payload'), entries, {
        allowMissing: true,
        lang: this.lang,
        progress: progressRange(this.onProgress, 70, 85),
      });
      this.onProgress({ phase: 'checking', detail: label, completed: 0, percent: 85 });
      const sourceAfter = await inventory(root, entries, {
        allowMissing,
        lang: this.lang,
        progress: progressRange(this.onProgress, 85, 95),
      });
      if (signature(source) !== signature(copied) || signature(source) !== signature(sourceAfter)) {
        throw this.error('storage.backupChangedOrVerifyFailed');
      }
      const meta = {
        version: 1,
        id,
        gameId: game.id,
        label: label.trim(),
        note: note.trim(),
        kind,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        platform: this.platform,
        entries,
        favorite: Boolean(favorite),
        protected: Boolean(protectedTag),
        records: source.records,
        absent: source.absent,
        fingerprint: fingerprint(source),
        fileCount: source.records.filter((record) => record.type === 'file').length,
        bytes: totalBytes,
        ...(origin ? { origin } : {}),
        ...(metadata || {}),
        ...(replace
          ? {
              id: replace.id,
              createdAt: replace.createdAt,
              updatedAt: new Date().toISOString(),
              favorite: replace.favorite,
              protected: replace.protected,
              kind: replace.kind,
              deletedAt: replace.deletedAt,
            }
          : {}),
      };
      validateManifest(meta, this.lang);
      await atomicJson(path.join(stage, 'manifest.json'), meta);
      if (replace) {
        await snapshot_import.replaceImportedSnapshot(this, game.id, replace, stage, id);
        this.invalidateSnapshotCache(game.id, replace.id);
      } else {
        await commitSnapshotDirectory(stage, destination);
        this.invalidateSnapshotCache(game.id, id);
      }
      this.onProgress({ phase: 'copying', detail: label, completed: 1, total: 1, percent: 100 });
      return meta;
    } finally {
      // 未决的导入覆盖事务日志（import-transactions）持有其暂存目录所有权，直到回滚或恢复流程完成。
      if (!replace || !(await statMaybe(path.join(this.dataDir, 'import-transactions', `${id}.json`)))) {
        await fs
          .rm(stage, { recursive: true, force: true })
          .catch((err) => this.logger.warn('capture-stage-cleanup-failed', { stage, error: err.message }));
      }
    }
  }

  /** @overload @param {string} gameId @param {string} id @param {false} [summaryOnly] @param {{ trustedParent?: boolean; hasPurgeMarker?: boolean }} [options] @returns {Promise<import('./models').Manifest>} */
  /** @overload @param {string} gameId @param {string} id @param {true} summaryOnly @param {{ trustedParent?: boolean; hasPurgeMarker?: boolean }} [options] @returns {Promise<Omit<import('./models').Manifest, 'records'>>} */
  /**
   * @param {string} gameId
   * @param {string} id
   * @param {boolean} [summaryOnly]
   * @param {{ trustedParent?: boolean; hasPurgeMarker?: boolean }} [options]
   */
  async readSnapshot(gameId, id, summaryOnly = false, options = {}) {
    const folder = this.snapshotDir(gameId, id);
    const parentDir = path.dirname(folder);
    if (!options.trustedParent) await assertNoLinks(parentDir, this.lang);
    const folderStat = await statBigIntMaybe(folder);
    if (folderStat?.isSymbolicLink()) throw this.error('storage.symlinkNotSupported', { path: folder });
    const marker = path.join(parentDir, `.purge-${id}.json`);
    const markerStat = options.hasPurgeMarker === false ? null : await statBigIntMaybe(marker);
    if (markerStat?.isSymbolicLink()) throw this.error('storage.symlinkNotSupported', { path: marker });
    const pending = Boolean(markerStat);
    const file = pending ? marker : path.join(folder, 'manifest.json');
    const fileStat = pending ? markerStat : await statBigIntMaybe(file);
    if (fileStat?.isSymbolicLink()) throw this.error('storage.symlinkNotSupported', { path: file });
    const cacheKey = `${gameId}/${id}`;
    const statSignature = fileStat
      ? `${pending ? 'p' : 'm'}:${fileStat.ino}:${fileStat.size}:${fileStat.mtimeNs}:${fileStat.ctimeNs}`
      : '';
    if (summaryOnly && statSignature) {
      const cached = this.manifestCache.get(cacheKey);
      if (cached && cached.statSignature === statSignature) {
        return structuredClone(cached.meta);
      }
    }
    const meta = validateManifest(JSON.parse(await fs.readFile(file, 'utf8')), this.lang);
    if (meta.id !== id || meta.gameId !== gameId) throw this.error('storage.snapshotIdentityMismatch');
    if (pending && (!meta.deletedAt || !meta.purgePending)) throw this.error('storage.invalidPurgeRecord');
    if (statSignature) {
      this.manifestCache.set(cacheKey, { statSignature, meta: publicSnapshot(meta) });
    }
    return summaryOnly ? publicSnapshot(meta) : meta;
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
    if (meta.purgePending) throw this.error('storage.cannotReadPurging');
    const actual = await inventory(path.join(this.snapshotDir(gameId, id), 'payload'), meta.entries, {
      allowMissing: true,
      progress: this.onProgress,
      lang: this.lang,
    });
    if (signature(actual) !== signature(meta)) {
      throw this.error('storage.integrityCheckFailed');
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
      this.assertGameWritable(gameId);
      const meta = await this.readSnapshot(gameId, id);
      if (changes?.deleted === false) validateRecoveryCount(this, gameId, [meta]);
      if (meta.purgePending) throw this.error('storage.cannotModifyPurging');
      if (changes.deleted && (meta.protected || changes.protected)) {
        throw this.error('storage.protectedCannotDelete');
      }
      if ('label' in changes) {
        if (typeof changes.label !== 'string' || !changes.label.trim() || changes.label.length > 100) {
          throw this.error('storage.updateLabelLength');
        }
        meta.label = changes.label.trim();
      }
      if ('note' in changes) {
        if (typeof changes.note !== 'string' || changes.note.length > 2000) {
          throw this.error('storage.updateNoteLength');
        }
        meta.note = changes.note;
      }
      if ('favorite' in changes) meta.favorite = Boolean(changes.favorite);
      if ('protected' in changes) {
        if (meta.kind === 'safety') throw this.error('storage.safetyCannotProtect');
        if (meta.deletedAt) throw this.error('storage.recoverBeforeProtect');
        meta.protected = Boolean(changes.protected);
      }
      if ('deleted' in changes) {
        if (changes.deleted) meta.deletedAt = new Date().toISOString();
        else delete meta.deletedAt;
      }
      meta.updatedAt = new Date().toISOString();
      await atomicJson(path.join(this.snapshotDir(gameId, id), 'manifest.json'), meta);
      this.invalidateSnapshotCache(gameId, id);
      if (meta.kind === 'safety') await this.pruneRestorePoints(gameId);
    });
  }

  /**
   * @param {unknown} ids
   * @returns {string[]}
   */
  validateSelection(ids) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 10000) {
      throw this.error('storage.selectionCountRange');
    }
    const unique = [...new Set(ids.map((id) => safeId(id, this.lang)))];
    if (unique.length !== ids.length) throw this.error('storage.duplicateSelection');
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
      this.assertGameWritable(gameId);
      const keys = Object.keys(changes || {});
      if (keys.length !== 1 || !['deleted', 'protected'].includes(keys[0]) || typeof changes[keys[0]] !== 'boolean') {
        throw this.error('storage.unsupportedBatchMark');
      }
      if (selection === 'all' && keys[0] !== 'protected') {
        throw this.error('storage.allSelectionOnlyProtect');
      }
      const ids =
        selection === 'all'
          ? (await this.snapshots(gameId)).filter((meta) => meta.kind !== 'safety').map((meta) => meta.id)
          : selection;
      if (selection === 'all' && ids.length === 0) return { updated: [], failed: [] };
      const selected = this.validateSelection(ids);
      // 在修改任何一条记录前，预先校验全部选中快照的归属、存在性及状态约束。
      const metas = [];
      for (const id of selected) metas.push(await this.readSnapshot(gameId, id));
      if (changes.deleted === false) validateRecoveryCount(this, gameId, metas);
      if (metas.some((meta) => meta.purgePending)) throw this.error('storage.batchContainsPurging');
      if (changes.deleted && metas.some((meta) => meta.protected)) {
        throw this.error('storage.batchContainsProtected');
      }
      if ('protected' in changes && metas.some((meta) => meta.kind === 'safety')) {
        throw this.error('storage.safetyCannotProtect');
      }
      if ('protected' in changes && metas.some((meta) => meta.deletedAt)) {
        throw this.error('storage.batchContainsTrashForProtect');
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
          meta.updatedAt = timestamp;
          await atomicJson(path.join(this.snapshotDir(gameId, meta.id), 'manifest.json'), meta);
          this.invalidateSnapshotCache(gameId, meta.id);
          report.updated.push(meta.id);
        } catch (error) {
          report.failed.push({ id: meta.id, label: meta.label, error: /** @type {Error} */ (error).message });
        }
      }
      if (metas.some((meta) => meta.kind === 'safety')) await this.pruneRestorePoints(gameId);
      return report;
    });
  }

  /**
   * @param {string} gameId
   * @param {string[]} ids
   */
  async deleteSnapshots(gameId, ids) {
    return this.exclusive(() => this.purgeSnapshots(gameId, ids));
  }

  /** @param {string} gameId @param {string[]} ids @param {boolean} [automatic] */
  async purgeSnapshots(gameId, ids, automatic = false) {
    this.game(gameId);
    this.assertGameWritable(gameId);
    const selected = this.validateSelection(ids);
    const root = path.resolve(this.gameDir(gameId), 'snapshots');
    const items = [];
    // 在标记或物理删除任何文件前，对所有选中快照执行完整预检（含符号链接树检查）。
    for (const id of selected) {
      const meta = await this.readSnapshot(gameId, id);
      if (!meta.deletedAt) throw this.error('storage.purgeOnlyDeleted');
      if (meta.protected && !(automatic && meta.kind === 'safety')) throw this.error('storage.protectedCannotDelete');
      const folder = this.snapshotDir(gameId, id),
        stage = path.join(root, `.purging-${id}`),
        marker = path.join(root, `.purge-${id}.json`);
      for (const target of [folder, stage, marker]) {
        if (path.dirname(path.resolve(target)) !== root || !within(this.vault, target, this.platform)) {
          throw this.error('storage.purgeOutOfBounds');
        }
        await assertNoLinks(target, this.lang);
      }
      const original = await statMaybe(folder),
        staged = await statMaybe(stage);
      if ((original && staged) || (staged && !meta.purgePending)) {
        throw this.error('storage.purgeStageConflict');
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
        // 将删除意图标记文件保存在待物理移除目录外部，确保中断或部分删除后仍可见且只能继续重试删除。
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
  }

  /** @param {string} gameId */
  async pruneRestorePoints(gameId) {
    try {
      await this.fault('before-retention', { gameId });
      return await pruneRestorePoints(this, gameId);
    } catch (error) {
      // 恢复点队列裁剪属于事务提交后的维护步骤，绝不能因裁剪失败而回滚已提交的存档。
      await this.logger.warn('prune-deferred', {
        operation: 'prune',
        gameId,
        error: /** @type {Error} */ (error).message,
      });
      return { movedCount: 0, purgedCount: 0 };
    }
  }

  /**
   * @param {string} gameId
   * @param {string} id
   */
  async restoreSnapshot(gameId, id) {
    return restore_transaction.restoreSnapshot(this, gameId, id);
  }

  /**
   * @param {any} journal
   */
  async finishImportReplacement(journal) {
    return snapshot_import.finishImportReplacement(this, journal);
  }

  /**
   * @param {string} gameId
   * @param {string} directory
   */
  async prepareImport(gameId, directory) {
    return snapshot_import.prepareImport(this, gameId, directory);
  }

  /**
   * @param {string} planId
   */
  cancelImport(planId) {
    return snapshot_import.cancelImport(this, planId);
  }

  /**
   * @param {string} gameId
   * @param {string} directory
   * @param {{ game?: import('./models').StoredGame; bundle?: boolean }} [options]
   */
  async prepareImportPlan(gameId, directory, { game = this.game(gameId), bundle = false } = {}) {
    return snapshot_import.prepareImportPlan(this, gameId, directory, { game, bundle });
  }

  /**
   * @param {string} planId
   * @param {import('../shared/contracts').ImportDecision[]} decisions
   */
  async executeImport(planId, decisions) {
    return snapshot_import.executeImport(this, planId, decisions);
  }

  /**
   * @param {string} planId
   * @param {import('../shared/contracts').ImportDecision[]} decisions
   */
  async executeImportPlan(planId, decisions) {
    return snapshot_import.executeImportPlan(this, planId, decisions);
  }

  // 非交互式调用方保留跳过重复项的保守默认策略；桌面端 UI 始终使用 prepareImport + 逐项显式决策。
  /**
   * @param {string} gameId
   * @param {string} directory
   */
  async importLegacy(gameId, directory) {
    return snapshot_import.importLegacy(this, gameId, directory);
  }

  /**
   * @param {string} gameId
   * @param {string} id
   * @param {string} destination
   */
  async exportSnapshot(gameId, id, destination) {
    return snapshot_export.exportSnapshot(this, gameId, id, destination);
  }

  /**
   * @param {string} gameId
   * @param {string[] | 'all'} selection
   * @param {string} destination
   */
  async exportSnapshots(gameId, selection, destination) {
    return snapshot_export.exportSnapshots(this, gameId, selection, destination);
  }
}
