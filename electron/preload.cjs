// 由 scripts/generate-preload.mjs 自动生成，请勿手动编辑；如需修改请更新共享 IPC 契约。
const { contextBridge, ipcRenderer } = require('electron');
/** @param {import('../shared/contracts').CommandName} method @param {unknown[]} args */
const invoke = async (method, ...args) => {
  /** @type {import('../shared/contracts').Result<unknown>} */
  const result = await ipcRenderer.invoke('savehub:' + method, ...args);
  if (!result.ok) {
    throw Object.assign(new Error(result.error.message), { code: result.error.code, params: result.error.params });
  }
  return result.data;
};
/** @type {import('../shared/contracts').CommandName[]} */
const METHODS = [
  'state',
  'setTheme',
  'setLanguage',
  'setLogLimitMB',
  'setRestorePointRetention',
  'saveGame',
  'reorderGames',
  'removeGame',
  'exportGames',
  'importGames',
  'reviewGameImport',
  'executeGameImport',
  'cancelGameImport',
  'pickDirectory',
  'pickIcon',
  'saveSnapshot',
  'restoreSnapshot',
  'updateSnapshot',
  'updateSnapshots',
  'deleteSnapshots',
  'verifySnapshot',
  'importSnapshots',
  'executeImport',
  'cancelImport',
  'exportSnapshot',
  'exportSnapshots',
  'openFolder',
];
const bridge = {
  ...Object.fromEntries(
    METHODS.map((method) => [method, (/** @type {unknown[]} */ ...args) => invoke(method, ...args)]),
  ),
  /** @param {(progress: import('../shared/contracts').Progress | null) => void} callback */
  onProgress(callback) {
    /** @param {Electron.IpcRendererEvent} _event @param {import('../shared/contracts').Progress | null} progress */
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('savehub:progress', listener);
    return () => ipcRenderer.removeListener('savehub:progress', listener);
  },
};
contextBridge.exposeInMainWorld('savehub', bridge);
