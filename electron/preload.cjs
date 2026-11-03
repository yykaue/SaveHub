const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (method, ...args) => {
  const result = await ipcRenderer.invoke(`savehub:${method}`, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.data;
};
contextBridge.exposeInMainWorld('savehub', {
  state: () => invoke('state'),
  setTheme: theme => invoke('setTheme', theme),
  setLanguage: language => invoke('setLanguage', language),
  saveGame: game => invoke('saveGame', game),
  removeGame: (id, undo, deleteRecords) => invoke('removeGame', id, undo, deleteRecords),
  exportGames: (ids, includeSnapshots) => invoke('exportGames', ids, includeSnapshots),
  importGames: () => invoke('importGames'),
  reviewGameImport: (id, decisions) => invoke('reviewGameImport', id, decisions),
  executeGameImport: (id, decisions) => invoke('executeGameImport', id, decisions),
  cancelGameImport: id => invoke('cancelGameImport', id),
  pickDirectory: () => invoke('pickDirectory'),
  pickIcon: () => invoke('pickIcon'),
  saveSnapshot: (id, details) => invoke('saveSnapshot', id, details),
  restoreSnapshot: (gameId, id) => invoke('restoreSnapshot', gameId, id),
  updateSnapshot: (gameId, id, details) => invoke('updateSnapshot', gameId, id, details),
  updateSnapshots: (gameId, ids, details) => invoke('updateSnapshots', gameId, ids, details),
  deleteSnapshots: (gameId, ids) => invoke('deleteSnapshots', gameId, ids),
  verifySnapshot: (gameId, id) => invoke('verifySnapshot', gameId, id),
  importSnapshots: (id, useLegacy) => invoke('importSnapshots', id, useLegacy),
  executeImport: (planId, decisions) => invoke('executeImport', planId, decisions),
  cancelImport: planId => invoke('cancelImport', planId),
  exportSnapshot: (gameId, id) => invoke('exportSnapshot', gameId, id),
  exportSnapshots: (gameId, ids) => invoke('exportSnapshots', gameId, ids),
  openFolder: (kind, id) => invoke('openFolder', kind, id),
  onProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('savehub:progress', listener);
    return () => ipcRenderer.removeListener('savehub:progress', listener);
  },
});
