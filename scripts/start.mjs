import { spawn } from 'node:child_process';
import electron from 'electron';
import { assertDesktopLaunchAllowed, desktopEnvironment } from './desktop-environment.mjs';

await assertDesktopLaunchAllowed();
const env = desktopEnvironment();
delete env.SAVEHUB_DEV_URL;
const child = spawn(String(electron), ['.', ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
  windowsHide: true,
});
const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.once('error', (error) => {
  console.error('Electron 启动失败：', error.message);
  process.exitCode = 1;
});
child.once('close', (code) => {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  process.exitCode = code ?? 1;
});
