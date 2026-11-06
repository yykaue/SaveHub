import { validLogLimit } from './log-settings.mjs';
/** 在进入任何 IPC 业务处理器前执行运行时入参校验，与编译期类型契约形成双重防護。 */
/** @typedef {(value: unknown) => boolean} Validator */
/** 校验安全标识符（仅允许小写字母、数字与连字符，防止路径穿越） @type {Validator} */
const id = (value) => typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value);
/** @type {Validator} */
const bool = (value) => typeof value === 'boolean';
/** @type {Validator} */
const str = (value) => typeof value === 'string';
/** 校验非空普通对象（排除 null 与数组） @type {Validator} */
const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** 校验非负安全整数 @type {Validator} */
const count = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** @param {Validator} check @returns {Validator} */
const optional = (check) => (value) => value === undefined || check(value);
/** 校验有界数组（上限 10000 项，防止超大数组耗尽内存） @param {Validator} check @returns {Validator} */
const list = (check) => (value) => Array.isArray(value) && value.length <= 10000 && value.every(check);
/** @type {Validator} */
const ids = (value) => list(id)(value) && /** @type {unknown[]} */ (value).length > 0;
/** @param {string[]} values @returns {Validator} */
const oneOf = (values) => (value) => typeof value === 'string' && values.includes(value);
/** @type {Validator} */
const selection = (value) => value === 'all' || ids(value);
/** 校验单平台存档目录配置 @type {Validator} */
const platformLocation = (value) =>
  object(value) &&
  str(/** @type {{ root?: unknown }} */ (value).root) &&
  list(str)(/** @type {{ items?: unknown }} */ (value).items);
/** 校验游戏级恢复点保留策略覆盖项（允许省略字段以继承全局默认值） @type {Validator} */
const partialRetention = (value) =>
  object(value) &&
  Object.entries(/** @type {Record<string, unknown>} */ (value)).every(
    ([key, item]) => ['active', 'removed'].includes(key) && optional(count)(item),
  );
/** 校验创建或更新游戏时的完整配置入参 @type {Validator} */
const gameInput = (value) => {
  if (!object(value)) return false;
  const item = /** @type {Record<string, unknown>} */ (value);
  const locations = /** @type {Record<string, unknown>} */ (item.locations);
  return (
    optional(id)(item.id) &&
    str(item.name) &&
    optional(str)(item.subtitle) &&
    optional(str)(item.icon) &&
    optional(str)(item.color) &&
    optional(str)(item.legacyRoot) &&
    optional(partialRetention)(item.restorePointRetention) &&
    object(locations) &&
    platformLocation(locations.win32) &&
    platformLocation(locations.darwin)
  );
};
/** 校验新建存档入参（仅允许名称与备注，禁止在创建时注入受保护或已删除状态） @type {Validator} */
const snapshotInput = (value) => {
  if (!object(value)) return false;
  return Object.entries(/** @type {Record<string, unknown>} */ (value)).every(
    ([key, item]) => ['label', 'note'].includes(key) && str(item),
  );
};
/** 校验单条存档元数据更新入参 @type {Validator} */
const details = (value) => {
  if (!object(value)) return false;
  return Object.entries(/** @type {Record<string, unknown>} */ (value)).every(([key, item]) =>
    ['label', 'note'].includes(key)
      ? typeof item === 'string'
      : ['favorite', 'protected', 'deleted'].includes(key) && bool(item),
  );
};
/** 校验批量更新存档状态入参（仅允许批量修改保护标记或软删除标记） @type {Validator} */
const batchDetails = (value) => {
  if (!object(value)) return false;
  return Object.entries(/** @type {Record<string, unknown>} */ (value)).every(
    ([key, item]) => ['protected', 'deleted'].includes(key) && bool(item),
  );
};
/** 校验导入冲突决策项 @type {Validator} */
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
  saveGame: [gameInput],
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
  saveSnapshot: [id, snapshotInput],
  restoreSnapshot: [id, id],
  updateSnapshot: [id, id, details],
  updateSnapshots: [id, selection, batchDetails],
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
