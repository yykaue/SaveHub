import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';
import path from 'node:path';
import { assertDesktopLaunchAllowed, desktopEnvironment } from './desktop-environment.mjs';

// 本地开发启动脚本：先启动 Vite 渲染进程开发服务器，再拉起指向本地隔离目录 .local-data 的 Electron 主进程
await assertDesktopLaunchAllowed();
const server = await createServer();
await server.listen();
/** @type {NodeJS.ProcessEnv} */
const env = desktopEnvironment({
  ...process.env,
  SAVEHUB_DEV_URL: 'http://127.0.0.1:5173/',
  SAVEHUB_DATA_DIR: path.resolve('.local-data'),
});
const child = spawn(/** @type {string} */ (/** @type {unknown} */ (electron)), ['.'], {
  stdio: 'inherit',
  env,
  windowsHide: true,
});
child.once('error', (error) => {
  console.error('Electron 启动失败：', error.message);
});
child.once('close', async (code) => {
  await server.close();
  process.exit(code ?? 1);
});
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
