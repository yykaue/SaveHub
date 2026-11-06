import { DEFAULT_LANGUAGE, getDictionary, getLanguage, getLanguageMeta, t } from './i18n';
import type { Language, Snapshot } from './types';

/** 获取快照类型的本地化标签 */
export const kindLabel = (kind: Snapshot['kind'], language: Language = getLanguage()) =>
  getDictionary(language).format.kinds[kind];

/**
 * 获取游戏显示名称：若该游戏为内置预设且用户未修改过默认名称，则随界面语言动态返回本地化预设名称。
 */
export const gameName = (game: { id: string; name: string }, language: Language = getLanguage()) => {
  const defaultPresets = getDictionary(DEFAULT_LANGUAGE).format.presetGames as Record<string, string | undefined>;
  const localizedPresets = getDictionary(language).format.presetGames as Record<string, string | undefined>;
  if (defaultPresets[game.id] && game.name === defaultPresets[game.id] && localizedPresets[game.id]) {
    return localizedPresets[game.id]!;
  }
  return game.name;
};

/** 将字节数格式化为人类可读的容量字符串（B / KB / MB / GB） */
export const formatBytes = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : bytes < 1073741824
        ? `${(bytes / 1048576).toFixed(1)} MB`
        : `${(bytes / 1073741824).toFixed(2)} GB`;

/** 格式化为简短月日时分标签（MM-DD HH:mm） */
export const dateLabel = (value: string, language: Language = getLanguage()) =>
  value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(getLanguageMeta(language).dateLocale, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(value))
    : t('format.unreadableDate', undefined, language);

/** 格式化为完整本地化日期时间字符串 */
export const fullDate = (value: string, language: Language = getLanguage()) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString(getLanguageMeta(language).dateLocale, { hour12: false })
    : t('format.unknownDate', undefined, language);
