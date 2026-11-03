import type { Language, Snapshot } from './types';

let currentLanguage: Language = (typeof localStorage !== 'undefined' && localStorage.getItem('savehub-language') === 'en') ? 'en' : 'zh';
export const setFormatLanguage = (language: Language) => { currentLanguage = language === 'en' ? 'en' : 'zh'; };
export const getFormatLanguage = (): Language => currentLanguage;
export const tr = (zh: string, en: string, language: Language = currentLanguage) => language === 'en' ? en : zh;

export const kinds: Record<Snapshot['kind'], string> = { manual: '手动创建', safety: '自动恢复点', imported: '导入存档' };
const englishKinds: Record<Snapshot['kind'], string> = { manual: 'Manual Save', safety: 'Restore Point', imported: 'Imported Save' };
export const kindLabel = (kind: Snapshot['kind'], language: Language = currentLanguage) => language === 'en' ? englishKinds[kind] : kinds[kind];

const presetEnglishNames: Record<string, { name: string; defaultZh: string }> = {
  'elden-ring': { name: 'Elden Ring', defaultZh: '艾尔登法环' },
  'slay-the-spire': { name: 'Slay the Spire', defaultZh: '杀戮尖塔' },
  'dark-souls-2': { name: 'Dark Souls II', defaultZh: '黑暗之魂 II' },
};
export const gameName = (game: { id: string; name: string }, language: Language = currentLanguage) => {
  if (language === 'en') {
    const preset = presetEnglishNames[game.id];
    if (preset && game.name === preset.defaultZh) return preset.name;
  }
  return game.name;
};

export const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1073741824 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1073741824).toFixed(2)} GB`;
export const dateLabel = (value: string, language: Language = currentLanguage) =>
  value
    ? new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
    : tr('无法读取', 'Unreadable', language);
export const fullDate = (value: string, language: Language = currentLanguage) =>
  value
    ? new Date(value).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN', { hour12: false })
    : tr('未知', 'Unknown', language);
