export const LANGUAGES = ['zh', 'en'];
export const DEFAULT_LANGUAGE = 'zh';

const locales = {
  zh: {
    menu: {
      edit: '编辑',
      window: '窗口',
    },
    dialogs: {
      startupErrorTitle: 'SaveHub 无法启动',
      busyQuitMessage: '正在完成存档操作',
      busyQuitDetail: '请等待当前操作完成后退出，进度会显示在窗口底部。',
      busyCloseMessage: '存档操作进行中',
      busyCloseDetail: '请等待当前操作完成后再关闭窗口。',
      pickSaveDir: '选择存档目录',
      pickGameIcon: '选择游戏图标',
      imageFilterName: '图片',
      invalidImage: '无法读取这张图片，请使用 PNG 或 JPEG 格式。',
      pickImportDir: '选择包含 ArchiveFile 存档的目录，或 SaveHub 导出目录',
      pickExportDir: '选择存档导出位置',
      pickBatchExportDir: '选择存档的统一导出位置',
    },
    ipc: {
      untrustedOrigin: '请求来源不受信任。',
      operationFailed: '操作失败，请重试。',
      unsupportedFolderKind: '不支持的目录类型。',
    },
    storage: {
      corruptedLabel: '损坏的存档 · {id}',
      unknownTheme: '未知主题。',
      unknownLanguage: '未知语言。',
      beforeRestoreLabel: '读档前 · {label}',
      beforeRestoreNote: '恢复前自动创建。可用这份存档撤销本次读档。',
      importedFromNote: '导入自 {source}',
    },
  },
  en: {
    menu: {
      edit: 'Edit',
      window: 'Window',
    },
    dialogs: {
      startupErrorTitle: 'SaveHub Failed to Start',
      busyQuitMessage: 'Save operation in progress',
      busyQuitDetail: 'Please wait for the current operation to finish before quitting. Progress is shown at the bottom of the window.',
      busyCloseMessage: 'Save operation in progress',
      busyCloseDetail: 'Please wait for the current operation to finish before closing the window.',
      pickSaveDir: 'Select Save Directory',
      pickGameIcon: 'Select Game Icon',
      imageFilterName: 'Images',
      invalidImage: 'Unable to read this image. Please use PNG or JPEG format.',
      pickImportDir: 'Select a folder containing ArchiveFile saves or a SaveHub export folder',
      pickExportDir: 'Select Export Destination',
      pickBatchExportDir: 'Select Batch Export Destination',
    },
    ipc: {
      untrustedOrigin: 'Untrusted request origin.',
      operationFailed: 'Operation failed, please try again.',
      unsupportedFolderKind: 'Unsupported folder type.',
    },
    storage: {
      corruptedLabel: 'Corrupted save · {id}',
      unknownTheme: 'Unknown theme.',
      unknownLanguage: 'Unknown language.',
      beforeRestoreLabel: 'Before restore · {label}',
      beforeRestoreNote: 'Created automatically before restoring. Use this restore point to undo the restore.',
      importedFromNote: 'Imported from {source}',
    },
  },
};

export function normalizeLanguage(language) {
  return LANGUAGES.includes(language) ? language : DEFAULT_LANGUAGE;
}

export function translate(language, key, params = {}) {
  const lang = normalizeLanguage(language);
  const resolve = (dict, pathKey) => pathKey.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), dict);
  const template = resolve(locales[lang], key) ?? resolve(locales[DEFAULT_LANGUAGE], key) ?? key;
  if (typeof template !== 'string') return String(key);
  return template.replace(/\{(\w+)\}/g, (_, token) => (params[token] !== undefined ? String(params[token]) : `{${token}}`));
}

