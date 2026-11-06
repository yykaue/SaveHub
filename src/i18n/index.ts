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

/** 递归提取嵌套翻译字典的所有点分字符串键路径类型 */
type DotPath<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : T[K] extends Record<string, unknown>
      ? DotPath<T[K], `${Prefix}${K}.`>
      : never;
}[keyof T & string];

export type TranslationKey = DotPath<TranslationSchema>;

/** 规范化语言代码，不支持的值一律回退到默认语言 `'zh'` */
export function normalizeLanguage(value?: string | null): Language {
  return SUPPORTED_LANGUAGES.some((item) => item.code === value) ? (value as Language) : DEFAULT_LANGUAGE;
}

let currentLanguage: Language = normalizeLanguage(
  typeof localStorage !== 'undefined' ? localStorage.getItem('savehub-language') : DEFAULT_LANGUAGE,
);
const listeners = new Set<() => void>();

/** 订阅语言切换事件（配合 React useSyncExternalStore 使用） */
export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 切换当前前端语言并通知所有订阅组件重新渲染 */
export function setLanguage(language: Language) {
  const next = normalizeLanguage(language);
  if (next === currentLanguage) return;
  currentLanguage = next;
  listeners.forEach((listener) => listener());
}

/** 获取当前前端语言代码 */
export function getLanguage(): Language {
  return currentLanguage;
}

/** 获取指定语言的元数据配置 */
export function getLanguageMeta(language: Language = currentLanguage): LanguageMeta {
  const normalized = normalizeLanguage(language);
  return SUPPORTED_LANGUAGES.find((item) => item.code === normalized) || SUPPORTED_LANGUAGES[0];
}

/** 获取循环切换时的下一个语言元数据 */
export function getNextLanguage(language: Language = currentLanguage): LanguageMeta {
  const normalized = normalizeLanguage(language);
  const index = SUPPORTED_LANGUAGES.findIndex((item) => item.code === normalized);
  return SUPPORTED_LANGUAGES[(index + 1) % SUPPORTED_LANGUAGES.length];
}

/** 按点分路径从字典对象中解析文案模板 */
function resolveKey(schema: TranslationSchema, key: string): string | undefined {
  let cursor: unknown = schema;
  for (const segment of key.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

/**
 * 根据点分键与参数字典渲染本地化文案，缺失时自动回退至默认语言或键名本身。
 */
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

/** 获取指定语言的完整字典对象 */
export function getDictionary(language: Language = currentLanguage): TranslationSchema {
  return locales[normalizeLanguage(language)] ?? locales[DEFAULT_LANGUAGE];
}
