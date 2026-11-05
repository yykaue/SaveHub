import { DEFAULT_LANGUAGE, getDictionary, getLanguage, getLanguageMeta, t } from './i18n';
import type { Language, Snapshot } from './types';

export const kindLabel = (kind: Snapshot['kind'], language: Language = getLanguage()) =>
  getDictionary(language).format.kinds[kind];

export const gameName = (game: { id: string; name: string }, language: Language = getLanguage()) => {
  const defaultPresets = getDictionary(DEFAULT_LANGUAGE).format.presetGames as Record<string, string | undefined>;
  const localizedPresets = getDictionary(language).format.presetGames as Record<string, string | undefined>;
  if (defaultPresets[game.id] && game.name === defaultPresets[game.id] && localizedPresets[game.id]) {
    return localizedPresets[game.id]!;
  }
  return game.name;
};

export const formatBytes = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : bytes < 1073741824
        ? `${(bytes / 1048576).toFixed(1)} MB`
        : `${(bytes / 1073741824).toFixed(2)} GB`;

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

export const fullDate = (value: string, language: Language = getLanguage()) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString(getLanguageMeta(language).dateLocale, { hour12: false })
    : t('format.unknownDate', undefined, language);
