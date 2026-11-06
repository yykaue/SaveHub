import { AppError } from './errors.mjs';
import path from 'node:path';
import { atomicJson } from './fs-utils.mjs';

export const DEFAULT_RETENTION = Object.freeze({ active: 5, removed: 15 });

/** @param {unknown} value @param {string} [lang] */
export function retentionCount(value, lang) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AppError('retention.invalidCount', undefined, lang);
  }
  return value;
}

/**
 * @param {unknown} input
 * @param {boolean} [inherit]
 * @param {string} [lang]
 * @returns {{ active?: number; removed?: number }}
 */
export function normalizeRetention(input, inherit = false, lang) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('retention.invalidCount', undefined, lang);
  }
  const values = /** @type {Record<string, unknown>} */ (input);
  if (Object.keys(values).some((key) => !['active', 'removed'].includes(key))) {
    throw new AppError('retention.invalidCount', undefined, lang);
  }
  /** @type {{ active?: number; removed?: number }} */
  const result = {};
  for (const key of /** @type {const} */ (['active', 'removed'])) {
    if (inherit && values[key] === undefined) continue;
    result[key] = retentionCount(values[key], lang);
  }
  return result;
}

/** @param {import('./storage.mjs').SaveStore} store @param {string} gameId */
export function effectiveRetention(store, gameId) {
  const overrides = store.game(gameId, true).restorePointRetention || {};
  return {
    active: overrides.active ?? store.config.restorePointRetention.active,
    removed: overrides.removed ?? store.config.restorePointRetention.removed,
  };
}

/** @param {import('./storage.mjs').SaveStore} store @param {string} gameId @param {any[]} metas */
export function validateRecoveryCount(store, gameId, metas) {
  const count = metas.filter((meta) => meta.kind === 'safety' && meta.deletedAt).length;
  if (!count) return;
  const { active } = effectiveRetention(store, gameId);
  if (active === 0) throw store.error('retention.recoveryDisabled');
  if (count > active) throw store.error('retention.recoveryLimit', { count, limit: active });
}

/** @param {{ updatedAt?: string; createdAt: string; id: string }} a @param {{ updatedAt?: string; createdAt: string; id: string }} b */
export function oldestFirst(a, b) {
  return (a.updatedAt || a.createdAt).localeCompare(b.updatedAt || b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * Called only under the store write lock, after transactions have finished.
 * Automatic moves preserve updatedAt: queue maintenance is not a user edit.
 * @param {import('./storage.mjs').SaveStore} store
 * @param {string} gameId
 */
export async function pruneRestorePoints(store, gameId) {
  if (store.blockedGames.has(gameId) || store.retentionDeferred.has(gameId)) return { movedCount: 0, purgedCount: 0 };
  const limits = effectiveRetention(store, gameId);
  const all = (await store.snapshots(gameId, true)).filter((meta) => meta.kind === 'safety' && !meta.corrupted);
  const active = all.filter((meta) => !meta.deletedAt && !meta.purgePending).sort(oldestFirst);
  const removed = all.filter((meta) => meta.deletedAt);
  let movedCount = 0;
  for (const item of active.slice(0, Math.max(0, active.length - limits.active))) {
    const meta = await store.readSnapshot(gameId, item.id);
    meta.deletedAt = new Date().toISOString();
    await atomicJson(path.join(store.snapshotDir(gameId, item.id), 'manifest.json'), meta);
    store.invalidateSnapshotCache(gameId, item.id);
    removed.push(meta);
    movedCount++;
    await store.logger.info('prune-moved', { operation: 'prune', gameId, id: item.id });
  }
  // Retry persisted intents even when this queue is now below its limit.
  const pending = removed.filter((meta) => meta.purgePending);
  const candidates = removed.filter((meta) => !meta.purgePending).sort(oldestFirst);
  const excess = candidates.slice(0, Math.max(0, candidates.length - Math.max(0, limits.removed - pending.length)));
  const ids = [...pending, ...excess].map((meta) => meta.id);
  let purgedCount = 0;
  if (ids.length) {
    const report = await store.purgeSnapshots(gameId, ids, true);
    purgedCount = report.updated.length;
    for (const failure of report.failed) {
      await store.logger.warn('prune-delete-deferred', { operation: 'prune', gameId, ...failure });
    }
  }
  return { movedCount, purgedCount };
}
