import type { Language } from '../types';
import zh, { type TranslationSchema } from './locales/zh';
import en from './locales/en';

export type { TranslationSchema };

export interface LanguageMeta {
  code: Language;
  label: string;
  shortLabel: string;
  htmlLang: string;
  dateLocale: string;
}

export const SUPPORTED_LANGUAGES: readonly LanguageMeta[] = [
  { code: 'zh', label: '简体中文', shortLabel: '中文', htmlLang: 'zh-CN', dateLocale: 'zh-CN' },
  { code: 'en', label: 'English', shortLabel: 'EN', htmlLang: 'en', dateLocale: 'en-US' },
] as const;

export const DEFAULT_LANGUAGE: Language = 'zh';

const locales: Record<Language, TranslationSchema> = {
  zh,
  en,
};

type DotPath<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : T[K] extends Record<string, unknown>
      ? DotPath<T[K], `${Prefix}${K}.`>
      : never;
}[keyof T & string];

export type TranslationKey = DotPath<TranslationSchema>;

export function normalizeLanguage(value?: string | null): Language {
  return SUPPORTED_LANGUAGES.some((item) => item.code === value) ? (value as Language) : DEFAULT_LANGUAGE;
}

let currentLanguage: Language = normalizeLanguage(
  typeof localStorage !== 'undefined' ? localStorage.getItem('savehub-language') : DEFAULT_LANGUAGE,
);
const listeners = new Set<() => void>();

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setLanguage(language: Language) {
  const next = normalizeLanguage(language);
  if (next === currentLanguage) return;
  currentLanguage = next;
  listeners.forEach((listener) => listener());
}

export function getLanguage(): Language {
  return currentLanguage;
}

export function getLanguageMeta(language: Language = currentLanguage): LanguageMeta {
  const normalized = normalizeLanguage(language);
  return SUPPORTED_LANGUAGES.find((item) => item.code === normalized) || SUPPORTED_LANGUAGES[0];
}

export function getNextLanguage(language: Language = currentLanguage): LanguageMeta {
  const normalized = normalizeLanguage(language);
  const index = SUPPORTED_LANGUAGES.findIndex((item) => item.code === normalized);
  return SUPPORTED_LANGUAGES[(index + 1) % SUPPORTED_LANGUAGES.length];
}

function resolveKey(schema: TranslationSchema, key: string): string | undefined {
  let cursor: unknown = schema;
  for (const segment of key.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

export function t(
  key: TranslationKey,
  params?: Record<string, string | number>,
  language: Language = currentLanguage,
): string {
  const normalized = normalizeLanguage(language);
  const template = resolveKey(locales[normalized], key) ?? resolveKey(locales[DEFAULT_LANGUAGE], key) ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, token: string) =>
    params[token] !== undefined ? String(params[token]) : `{${token}}`,
  );
}

export function getDictionary(language: Language = currentLanguage): TranslationSchema {
  return locales[normalizeLanguage(language)] ?? locales[DEFAULT_LANGUAGE];
}
