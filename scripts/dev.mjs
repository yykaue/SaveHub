import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';
import path from 'node:path';

// 本地开发启动脚本：先启动 Vite 渲染进程开发服务器，再拉起指向本地隔离目录 .local-data 的 Electron 主进程
const server = await createServer();
await server.listen();
/** @type {NodeJS.ProcessEnv} */
const env = {
  ...process.env,
  SAVEHUB_DEV_URL: 'http://127.0.0.1:5173/',
  SAVEHUB_DATA_DIR: path.resolve('.local-data'),
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(/** @type {string} */ (/** @type {unknown} */ (electron)), ['.'], {
  stdio: 'inherit',
  env,
  windowsHide: true,
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code || 0);
});
process.on('SIGINT', () => child.kill());
