import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { format, resolveConfig } from 'prettier';
import { IPC_SCHEMA } from '../shared/ipc-schema.mjs';

// 根据 shared/ipc-schema.mjs 自动生成或校验 electron/preload.cjs 桥接脚本
const source = `// 由 scripts/generate-preload.mjs 自动生成，请勿手动编辑；如需修改请更新共享 IPC 契约。
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
const METHODS = ${JSON.stringify(Object.keys(IPC_SCHEMA))};
const bridge = {
  ...Object.fromEntries(METHODS.map(method => [method, (/** @type {unknown[]} */ ...args) => invoke(method, ...args)])),
  /** @param {(progress: import('../shared/contracts').Progress | null) => void} callback */
  onProgress(callback) {
    /** @param {Electron.IpcRendererEvent} _event @param {import('../shared/contracts').Progress | null} progress */
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('savehub:progress', listener);
    return () => ipcRenderer.removeListener('savehub:progress', listener);
  },
};
contextBridge.exposeInMainWorld('savehub', bridge);
`;
const file = 'electron/preload.cjs';
const expected = await format(source, { ...(await resolveConfig(file)), parser: 'babel' });
if (process.argv.includes('--check'))
  assert.equal(await fs.readFile(file, 'utf8'), expected, 'Regenerate preload: pnpm generate:preload');
else await fs.writeFile(file, expected);
