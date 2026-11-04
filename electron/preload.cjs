const { contextBridge, ipcRenderer } = require('electron');

const invoke = async (method, ...args) => {
  const result = await ipcRenderer.invoke(`savehub:${method}`, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.data;
};

const METHODS = [
  'state',
  'setTheme',
  'setLanguage',
  'saveGame',
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

const bridge = Object.fromEntries(METHODS.map(method => [method, (...args) => invoke(method, ...args)]));
bridge.onProgress = callback => {
  const listener = (_event, progress) => callback(progress);
  ipcRenderer.on('savehub:progress', listener);
  return () => ipcRenderer.removeListener('savehub:progress', listener);
};

contextBridge.exposeInMainWorld('savehub', bridge);
