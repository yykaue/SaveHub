import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Menu } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { SaveStore } from './storage.mjs';
import { makePresets } from './presets.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.dirname(here);
const developmentURL = !app.isPackaged ? process.env.SAVEHUB_DEV_URL : undefined;
const rendererURL = developmentURL || pathToFileURL(path.join(project, 'dist', 'index.html')).href;
if (process.env.SAVEHUB_DATA_DIR) app.setPath('userData', path.resolve(process.env.SAVEHUB_DATA_DIR));
app.setName('SaveHub');
app.setAppUserModelId('app.savehub.desktop');
let window, store;
let lastProgressTime = 0;

const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    store = new SaveStore(app.getPath('userData'), {
      onProgress: progress => {
        const now = Date.now();
        if (progress && now - lastProgressTime < 80) return;
        lastProgressTime = now;
        if (window && !window.isDestroyed()) window.webContents.send('savehub:progress', progress);
      },
    });
    await store.init(await makePresets());
    registerHandlers();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch(error => { dialog.showErrorBox('SaveHub 无法启动', error.message); app.quit(); });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => { if (store?.busy) { event.preventDefault(); dialog.showMessageBox({ type: 'info', message: '正在完成存档操作', detail: '请等待当前操作完成后退出，进度会显示在窗口底部。' }); } });

function createWindow() {
  window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 1060, minHeight: 720,
    title: 'SaveHub', backgroundColor: '#f6f5f0',
    icon: path.join(project, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    show: false, titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f6f5f000', symbolColor: '#75786d', height: 38 },
    trafficLightPosition: { x: 18, y: 13 },
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== rendererURL) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on('close', event => { if (store.busy) { event.preventDefault(); dialog.showMessageBox(window, { type: 'info', message: '存档操作进行中', detail: '请等待当前操作完成后再关闭窗口。' }); } });
  window.once('ready-to-show', () => window.show());
  window.loadURL(rendererURL);
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'SaveHub', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    ]));
  } else Menu.setApplicationMenu(null);
}

function registerHandlers() {
  const register = (name, handler) => ipcMain.handle(`savehub:${name}`, async (event, ...args) => {
    try {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== rendererURL) throw new Error('请求来源不受信任。');
      return { ok: true, data: await handler(...args) };
    } catch (error) { return { ok: false, error: error.message || '操作失败，请重试。' }; }
  });
  const chooseFolder = async title => {
    const result = await dialog.showOpenDialog(window, { title, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  };
  register('state', async () => ({ ...await store.state(), version: app.getVersion() }));
  register('setTheme', theme => store.setTheme(theme));
  register('saveGame', game => store.upsertGame(game));
  register('removeGame', (id, undo) => store.removeGame(id, Boolean(undo)));
  register('pickDirectory', () => chooseFolder('选择存档目录'));
  register('pickIcon', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择游戏图标', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'ico'] }] });
    if (result.canceled) return null;
    let icon = nativeImage.createFromPath(result.filePaths[0]);
    if (icon.isEmpty()) throw new Error('无法读取这张图片，请使用 PNG 或 JPEG 格式。');
    const { width, height } = icon.getSize();
    if (Math.max(width, height) > 512) icon = icon.resize(width > height ? { width: 512 } : { height: 512 });
    return icon.toDataURL();
  });
  register('saveSnapshot', (id, details) => store.createSnapshot(id, details));
  register('restoreSnapshot', (gameId, id) => store.restoreSnapshot(gameId, id));
  register('updateSnapshot', (gameId, id, details) => store.updateSnapshot(gameId, id, details));
  register('updateSnapshots', (gameId, ids, details) => store.updateSnapshots(gameId, ids, details));
  register('deleteSnapshots', (gameId, ids) => store.deleteSnapshots(gameId, ids));
  register('verifySnapshot', (gameId, id) => store.verifySnapshot(gameId, id));
  register('importSnapshots', async (id, useLegacy) => {
    const game = store.game(id);
    const directory = useLegacy && game.legacyRoot ? game.legacyRoot : await chooseFolder('选择包含 ArchiveFile 存档的目录，或 SaveHub 导出目录');
    return directory ? store.prepareImport(id, directory) : null;
  });
  register('executeImport', (planId, decisions) => store.executeImport(planId, decisions));
  register('cancelImport', planId => store.cancelImport(planId));
  register('exportSnapshot', async (gameId, id) => {
    const directory = await chooseFolder('选择存档导出位置');
    return directory ? store.exportSnapshot(gameId, id, directory) : null;
  });
  register('exportSnapshots', async (gameId, ids) => {
    store.game(gameId);
    const directory = await chooseFolder('选择存档的统一导出位置');
    return directory ? store.exportSnapshots(gameId, ids, directory) : null;
  });
  register('openFolder', async (kind, gameId) => {
    let directory;
    if (kind === 'vault') directory = store.dataDir;
    else if (kind === 'game') directory = (await store.location(store.game(gameId))).root;
    else if (kind === 'snapshots') { directory = path.join(store.gameDir(store.game(gameId).id), 'snapshots'); await mkdir(directory, { recursive: true }); }
    else throw new Error('不支持的目录类型。');
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  });
}
