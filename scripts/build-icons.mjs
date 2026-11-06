import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const script = fileURLToPath(import.meta.url);
const project = path.dirname(path.dirname(script));
const sizes = [16, 24, 32, 48, 64, 128, 256];

if (!process.versions.electron) {
  const { default: executable } = await import('electron');
  const temporaryRoot = path.join(project, '.test-data');
  await fs.mkdir(temporaryRoot, { recursive: true });
  const profile = await fs.mkdtemp(path.join(temporaryRoot, 'icon-render-'));
  const env = { ...process.env, SAVEHUB_ICON_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const child = spawn(executable, [script], { cwd: project, env, stdio: 'inherit', windowsHide: true });
    const timeout = setTimeout(() => {
      console.error('Icon rendering timed out.');
      child.kill();
    }, 30000);
    try {
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      });
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    assert(path.dirname(profile) === temporaryRoot);
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
} else {
  const { app, BrowserWindow, nativeImage } = await import('electron');
  app.setPath('userData', process.env.SAVEHUB_ICON_DATA_DIR);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('force-color-profile', 'srgb');
  let window;
  // 等待 Electron 完成 ESM 入口求值后再响应 app.whenReady，通过离屏渲染将 SVG 光栅化为 PNG 与多尺寸 ICO
  app.whenReady().then(async () => {
    try {
      window = new BrowserWindow({
        width: 1024,
        height: 1024,
        useContentSize: true,
        frame: false,
        show: false,
        transparent: true,
        webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      const source = await fs.readFile(path.join(project, 'build/icon.svg'), 'utf8');
      const html = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;background:transparent;width:100%;height:100%;overflow:hidden}svg{display:block;width:100%;height:100%}</style></head><body>${source}</body></html>`;
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const master = await window.webContents.capturePage();
      assert.deepEqual(master.getSize(), { width: 1024, height: 1024 });
      assert.equal(master.toBitmap()[3], 0, 'The icon must preserve transparent corners');
      const png = master.toPNG();
      const frames = sizes.map((size) => master.resize({ width: size, height: size, quality: 'best' }).toPNG());
      const header = Buffer.alloc(6 + frames.length * 16);
      header.writeUInt16LE(1, 2);
      header.writeUInt16LE(frames.length, 4);
      let offset = header.length;
      for (const [index, frame] of frames.entries()) {
        const size = sizes[index],
          entry = 6 + index * 16;
        assert.deepEqual(nativeImage.createFromBuffer(frame).getSize(), { width: size, height: size });
        header[entry] = header[entry + 1] = size === 256 ? 0 : size;
        header.writeUInt16LE(1, entry + 4);
        header.writeUInt16LE(32, entry + 6);
        header.writeUInt32LE(frame.length, entry + 8);
        header.writeUInt32LE(offset, entry + 12);
        offset += frame.length;
      }
      const ico = Buffer.concat([header, ...frames]);
      // 先完成全部尺寸渲染与校验，再通过临时文件原子替换产物
      for (const [name, bytes] of [
        ['icon.png', png],
        ['icon.ico', ico],
      ]) {
        const output = path.join(project, 'build', name);
        await fs.writeFile(`${output}.tmp`, bytes);
        await fs.rename(`${output}.tmp`, output);
      }
      const screenshots = path.join(project, 'docs/screenshots');
      await fs.mkdir(screenshots, { recursive: true });
      await fs.writeFile(
        path.join(screenshots, 'savehub-logo.png'),
        master.resize({ width: 256, height: 256, quality: 'best' }).toPNG(),
      );
      console.log(
        JSON.stringify(
          { source: 'build/icon.svg', png: { size: 1024, bytes: png.length }, ico: { sizes, bytes: ico.length } },
          null,
          2,
        ),
      );
      window.destroy();
      app.exit(0);
    } catch (error) {
      console.error(error);
      if (window && !window.isDestroyed()) window.destroy();
      app.exit(1);
    }
  });
}
