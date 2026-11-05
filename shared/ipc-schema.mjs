import { validLogLimit } from './log-settings.mjs';
/** Runtime checks complement the shared compile-time contract before any handler runs. */
/** @typedef {(value: unknown) => boolean} Validator */
/** @type {Validator} */
const id = (value) => typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value);
/** @type {Validator} */
const bool = (value) => typeof value === 'boolean';
/** @type {Validator} */
const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** @type {Validator} */
const count = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** @param {Validator} check @returns {Validator} */
const optional = (check) => (value) => value === undefined || check(value);
/** @param {Validator} check @returns {Validator} */
const list = (check) => (value) => Array.isArray(value) && value.length <= 10000 && value.every(check);
/** @type {Validator} */
const ids = (value) => list(id)(value) && /** @type {unknown[]} */ (value).length > 0;
/** @param {string[]} values @returns {Validator} */
const oneOf = (values) => (value) => typeof value === 'string' && values.includes(value);
/** @type {Validator} */
const selection = (value) => value === 'all' || ids(value);
/** @type {Validator} */
const details = (value) => {
  if (!object(value)) return false;
  return Object.entries(/** @type {Record<string, unknown>} */ (value)).every(([key, item]) =>
    ['label', 'note'].includes(key)
      ? typeof item === 'string'
      : ['favorite', 'protected', 'deleted'].includes(key) && bool(item),
  );
};
/** @type {Validator} */
const decision = (value) => {
  if (!object(value)) return false;
  const item = /** @type {Record<string, unknown>} */ (value);
  return id(item.itemId) && oneOf(['overwrite', 'skip', 'keep-both'])(item.action) && optional(id)(item.targetId);
};
/** @type {Record<import('./contracts').CommandName, Validator[]>} */
export const IPC_SCHEMA = {
  state: [],
  setTheme: [oneOf(['ink', 'tech', 'cyber', 'glass'])],
  setLanguage: [oneOf(['zh', 'en'])],
  setLogLimitMB: [validLogLimit],
  setRestorePointRetention: [
    (value) =>
      object(value) &&
      Object.keys(/** @type {object} */ (value)).length === 2 &&
      count(/** @type {{ active?: unknown }} */ (value).active) &&
      count(/** @type {{ removed?: unknown }} */ (value).removed),
  ],
  saveGame: [object],
  removeGame: [id, optional(bool), optional(bool)],
  exportGames: [ids, optional(bool)],
  importGames: [],
  reviewGameImport: [id, list(decision)],
  executeGameImport: [
    id,
    list(
      (value) =>
        object(value) &&
        id(/** @type {{ itemId?: unknown }} */ (value).itemId) &&
        list(decision)(/** @type {{ decisions?: unknown }} */ (value).decisions),
    ),
  ],
  cancelGameImport: [id],
  pickDirectory: [],
  pickIcon: [],
  saveSnapshot: [id, details],
  restoreSnapshot: [id, id],
  updateSnapshot: [id, id, details],
  updateSnapshots: [id, selection, details],
  deleteSnapshots: [id, ids],
  verifySnapshot: [id, id],
  importSnapshots: [id, optional(bool)],
  executeImport: [id, list(decision)],
  cancelImport: [id],
  exportSnapshot: [id, id],
  exportSnapshots: [id, selection],
  openFolder: [oneOf(['vault', 'logs', 'game', 'snapshots']), optional(id)],
};

/** @param {import('./contracts').CommandName} name @param {unknown[]} args */
export function validArguments(name, args) {
  const validators = IPC_SCHEMA[name];
  return args.length <= validators.length && validators.every((check, index) => check(args[index]));
}
