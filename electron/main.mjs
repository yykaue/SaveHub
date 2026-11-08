import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Menu, protocol } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { SaveStore } from './storage.mjs';
import { AppError, serializeError } from './errors.mjs';
import { IPC_SCHEMA, validArguments } from '../shared/ipc-schema.mjs';
import { translate } from './i18n.mjs';
import { iconResponse } from './game-icons.mjs';

// 注册自定义特权协议 savehub-icon://，用于向渲染进程安全提供游戏自定义图标流，避免在 IPC 状态中内联大体积 Base64
protocol.registerSchemesAsPrivileged([
  { scheme: 'savehub-icon', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.dirname(here);
const developmentURL = !app.isPackaged ? process.env.SAVEHUB_DEV_URL : undefined;
const rendererURL = developmentURL || pathToFileURL(path.join(project, 'dist', 'index.html')).href;
if (process.env.SAVEHUB_DATA_DIR) app.setPath('userData', path.resolve(process.env.SAVEHUB_DATA_DIR));
app.setName('SaveHub');
app.setAppUserModelId('app.savehub.desktop');

/** @type {BrowserWindow | undefined} */
let window;
/** @type {SaveStore | undefined} */
let store;
let lastProgressTime = 0;

/**
 * 根据当前存储库语言配置翻译文案。
 *
 * @param {string} key 翻译键
 * @param {Record<string, string | number>} [params] 插值参数
 */
const t = (key, params) => translate(store?.config?.language, key, params);

// 确保应用单实例运行，防止多个进程并发读写同一存档库导致事务冲突
const locked = app.requestSingleInstanceLock();
if (!locked) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      store = new SaveStore(app.getPath('userData'), {
        onProgress: (progress) => {
          const now = Date.now();
          const isFinal = !progress || Boolean(progress.total && progress.completed >= progress.total);
          // 限制非终态进度推送频率至最多每 80ms 一次，防止高频文件复制阻塞 IPC 通道
          if (!isFinal && now - lastProgressTime < 80) return;
          lastProgressTime = isFinal ? 0 : now;
          if (window && !window.isDestroyed()) window.webContents.send('savehub:progress', progress);
        },
      });
      try {
        await store.init();
      } catch (error) {
        const problem = /** @type {Error & { code?: string; recoveryAvailable?: boolean }} */ (error);
        if (problem.code !== 'LIBRARY_CORRUPT' || !problem.recoveryAvailable) throw error;
        const answer = await dialog.showMessageBox({
          type: 'warning',
          title: t('dialogs.restoreLibraryTitle'),
          message: t('dialogs.restoreLibraryMessage'),
          detail: t('dialogs.restoreLibraryDetail'),
          buttons: [t('dialogs.restoreLibraryConfirm'), t('dialogs.cancel')],
          defaultId: 1,
          cancelId: 1,
        });
        if (answer.response !== 0) throw error;
        await store.init([], { recoverPrevious: true });
      }
      registerHandlers();
      protocol.handle('savehub-icon', (request) =>
        store ? iconResponse(store, request.url) : new Response(null, { status: 503 }),
      );
      createWindow();
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((error) => {
      dialog.showErrorBox(t('dialogs.startupErrorTitle'), /** @type {Error} */ (error).message);
      app.quit();
    });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', (event) => {
  if (store?.busy) {
    event.preventDefault();
    dialog.showMessageBox({ type: 'info', message: t('dialogs.busyQuitMessage'), detail: t('dialogs.busyQuitDetail') });
  }
});

/**
 * 根据当前系统平台与语言更新应用原生菜单（macOS 保留标准编辑与窗口菜单，Windows 隐藏菜单栏）。
 */
function updateApplicationMenu() {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { label: 'SaveHub', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] },
        {
          label: t('menu.edit'),
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
          ],
        },
        { label: t('menu.window'), submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
      ]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }
}

/**
 * 创建主窗口并收紧安全边界（启用 sandbox、contextIsolation，禁止打开新窗口、外部导航及任何设备权限请求）。
 */
function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1060,
    minHeight: 720,
    title: 'SaveHub',
    backgroundColor: '#f6f5f0',
    icon: path.join(project, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f6f5f000', symbolColor: '#75786d', height: 38 },
    trafficLightPosition: { x: 18, y: 13 },
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererURL) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on('close', (event) => {
    if (store?.busy && window) {
      event.preventDefault();
      dialog.showMessageBox(window, {
        type: 'info',
        message: t('dialogs.busyCloseMessage'),
        detail: t('dialogs.busyCloseDetail'),
      });
    }
  });
  window.once('ready-to-show', () => window?.show());
  window.loadURL(rendererURL);
  updateApplicationMenu();
}

/**
 * 注册所有 IPC 命令处理器，并在入口处统一强制执行：
 * 1. 调用来源 Frame 与 URL 校验（防止非受信任页面调用）；
 * 2. 基于 `IPC_SCHEMA` 的运行时参数白名单校验；
 * 3. 操作分类日志记录与结构化错误序列化；
 * 4. 启动时全量比对已注册处理器与 `IPC_SCHEMA` 的契约一致性。
 */
function registerHandlers() {
  if (!store) return;
  const activeStore = store;
  const registered = new Set();
  /**
   * @template {import('../shared/contracts').CommandName} K
   * @param {K} name 命令名称
   * @param {(...args: Parameters<import('../shared/contracts').Commands[K]>) => ReturnType<import('../shared/contracts').Commands[K]> | Awaited<ReturnType<import('../shared/contracts').Commands[K]>>} handler 处理函数
   */
  const register = (name, handler) => {
    registered.add(name);
    ipcMain.handle(`savehub:${name}`, async (event, ...args) => {
      try {
        if (
          !window ||
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url !== rendererURL
        ) {
          throw new Error(t('ipc.untrustedOrigin'));
        }
        if (!validArguments(name, args)) throw new AppError('errors.invalidArguments', undefined, activeStore.lang);
        const parameters = /** @type {Parameters<import('../shared/contracts').Commands[K]>} */ (args);
        const update = name === 'updateSnapshot' || name === 'updateSnapshots';
        const changes = update ? /** @type {{ deleted?:boolean }} */ (args[2]) : undefined;
        const operation = update
          ? changes?.deleted === false
            ? 'recover'
            : changes?.deleted === true
              ? 'delete'
              : 'settings'
          : name;
        return {
          ok: true,
          data:
            name === 'state'
              ? await handler(...parameters)
              : await activeStore.logger.run(operation, async () => handler(...parameters), {
                  method: name,
                  ...(typeof args[0] === 'string' && /Snapshot|Folder|Game/.test(name) ? { gameId: args[0] } : {}),
                  ...(name.endsWith('Snapshot') && typeof args[1] === 'string' ? { snapshotId: args[1] } : {}),
                }),
        };
      } catch (error) {
        const message = /** @type {Error} */ (error).message || t('ipc.operationFailed');
        await activeStore.logger.warn('ipc-error', { method: name, error: message });
        return { ok: false, error: serializeError(error, activeStore.lang) };
      }
    });
  };
  /**
   * 弹出系统目录选择对话框。
   *
   * @param {string} title 对话框标题
   */
  const chooseFolder = async (title) => {
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, { title, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  };
  register('state', async () => ({ ...(await activeStore.state()), version: app.getVersion() }));
  register('setTheme', (theme) => activeStore.setTheme(theme));
  register('setRestorePointRetention', (value) => activeStore.setRestorePointRetention(value));
  register('setLogLimitMB', (value) => activeStore.setLogLimitMB(value));
  register('setLanguage', async (language) => {
    await activeStore.setLanguage(language);
    updateApplicationMenu();
  });
  register('saveGame', (game) => activeStore.upsertGame(game));
  register('reorderGames', (ids) => activeStore.reorderGames(ids));
  register('removeGame', (id, undo = false, deleteRecords = false) => activeStore.removeGame(id, undo, deleteRecords));
  register('exportGames', async (ids, includeSnapshots = false) => {
    const directory = await chooseFolder(t('dialogs.pickGameExportDir'));
    return directory ? activeStore.exportGames(ids, directory, includeSnapshots) : null;
  });
  register('importGames', async () => {
    const directory = await chooseFolder(t('dialogs.pickGameImportDir'));
    return directory ? activeStore.prepareGameImport(directory) : null;
  });
  register('reviewGameImport', (id, decisions) => activeStore.reviewGameImport(id, decisions));
  register('executeGameImport', (id, decisions) => activeStore.executeGameImport(id, decisions));
  register('cancelGameImport', (id) => activeStore.cancelGameImport(id));
  register('pickDirectory', () => chooseFolder(t('dialogs.pickSaveDir')));
  register('pickIcon', async () => {
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, {
      title: t('dialogs.pickGameIcon'),
      properties: ['openFile'],
      filters: [{ name: t('dialogs.imageFilterName'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'ico'] }],
    });
    if (result.canceled) return null;
    let icon = nativeImage.createFromPath(result.filePaths[0]);
    if (icon.isEmpty()) throw new Error(t('dialogs.invalidImage'));
    const { width, height } = icon.getSize();
    if (Math.max(width, height) > 512) icon = icon.resize(width > height ? { width: 512 } : { height: 512 });
    return icon.toDataURL();
  });
  register('saveSnapshot', (id, details) => activeStore.createSnapshot(id, details));
  register('restoreSnapshot', (gameId, id) => activeStore.restoreSnapshot(gameId, id));
  register('updateSnapshot', (gameId, id, details) => activeStore.updateSnapshot(gameId, id, details));
  register('updateSnapshots', (gameId, ids, details) => activeStore.updateSnapshots(gameId, ids, details));
  register('deleteSnapshots', (gameId, ids) => activeStore.deleteSnapshots(gameId, ids));
  register('verifySnapshot', (gameId, id) => activeStore.verifySnapshot(gameId, id));
  register('importSnapshots', async (id, useLegacy) => {
    const game = activeStore.game(id);
    const directory = useLegacy && game.legacyRoot ? game.legacyRoot : await chooseFolder(t('dialogs.pickImportDir'));
    return directory ? activeStore.prepareImport(id, directory) : null;
  });
  register('executeImport', (planId, decisions) => activeStore.executeImport(planId, decisions));
  register('cancelImport', (planId) => activeStore.cancelImport(planId));
  register('exportSnapshot', async (gameId, id) => {
    const directory = await chooseFolder(t('dialogs.pickExportDir'));
    return directory ? activeStore.exportSnapshot(gameId, id, directory) : null;
  });
  register('exportSnapshots', async (gameId, ids) => {
    activeStore.game(gameId);
    const directory = await chooseFolder(t('dialogs.pickBatchExportDir'));
    return directory ? activeStore.exportSnapshots(gameId, ids, directory) : null;
  });
  register('openFolder', async (kind, gameId) => {
    let directory;
    if (kind === 'vault') directory = activeStore.dataDir;
    else if (kind === 'logs') {
      directory = activeStore.logger.logDir;
      await mkdir(directory, { recursive: true });
    } else if (kind === 'game') {
      if (!gameId) throw new AppError('errors.invalidArguments', undefined, activeStore.lang);
      directory = (await activeStore.location(activeStore.game(gameId))).root;
    } else if (kind === 'snapshots') {
      if (!gameId) throw new AppError('errors.invalidArguments', undefined, activeStore.lang);
      directory = path.join(activeStore.gameDir(activeStore.game(gameId).id), 'snapshots');
      await mkdir(directory, { recursive: true });
    } else throw new Error(t('ipc.unsupportedFolderKind'));
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  });
  if (
    registered.size !== Object.keys(IPC_SCHEMA).length ||
    Object.keys(IPC_SCHEMA).some((name) => !registered.has(name))
  ) {
    throw new Error('IPC handlers do not match the shared contract');
  }
}
