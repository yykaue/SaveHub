import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { assertNoLinks, atomicJson, safeId } from './fs-utils.mjs';
import { normalizeRetention } from './retention.mjs';
import { AppError } from './errors.mjs';

/** @param {any} value @returns {import('./models').LibraryConfig} */
export function validateLibrary(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.games)) throw new AppError('storage.invalidConfigFormat');
  const ids = new Set();
  for (const game of value.games) {
    if (!game || typeof game !== 'object') throw new AppError('storage.invalidConfigFormat');
    safeId(game.id);
    if (ids.has(game.id) || typeof game.name !== 'string' || !game.locations || typeof game.locations !== 'object') {
      throw new AppError('storage.invalidConfigFormat');
    }
    ids.add(game.id);
    for (const platform of ['win32', 'darwin']) {
      const location = game.locations[platform];
      if (!location || typeof location.root !== 'string' || !Array.isArray(location.items))
        throw new AppError('storage.invalidConfigFormat');
    }
    if (game.restorePointRetention !== undefined) normalizeRetention(game.restorePointRetention, true);
  }
  if (value.restorePointRetention !== undefined) normalizeRetention(value.restorePointRetention);
  return value;
}

/** @param {string} file */
export async function readLibrary(file) {
  await assertNoLinks(file);
  return validateLibrary(JSON.parse(await fs.readFile(file, 'utf8')));
}

/** Explicit startup recovery, never silently replaces a damaged library. @param {string} file */
export async function recoverPreviousLibrary(file) {
  const previous = await readLibrary(`${file}.previous`);
  await assertNoLinks(file);
  const preserved = `${file}.corrupt-${Date.now()}-${randomUUID()}`;
  await fs.copyFile(file, preserved, fs.constants.COPYFILE_EXCL);
  await atomicJson(file, previous);
  return { config: previous, preserved };
}
