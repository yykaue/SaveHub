import zh from '../shared/locales/zh.json' with { type: 'json' };
import en from '../shared/locales/en.json' with { type: 'json' };
export const LANGUAGES = ['zh', 'en'];
export const DEFAULT_LANGUAGE = 'zh';

export const locales = { zh, en };

let currentBackendLanguage = DEFAULT_LANGUAGE;

/**
 * 规范化语言代码（仅支持 `'zh'` 与 `'en'`，默认回退为 `'zh'`）。
 *
 * @param {string} [language] 待规范化的语言代码
 * @returns {import('../shared/contracts').Language}
 */
export function normalizeLanguage(language) {
  return language === 'en' ? 'en' : 'zh';
}

/**
 * 设置主进程默认兜底语言。
 *
 * @param {string} [language] 语言代码
 */
export function setBackendLanguage(language) {
  currentBackendLanguage = normalizeLanguage(language);
  return currentBackendLanguage;
}

/**
 * 获取主进程当前默认语言。
 */
export function getBackendLanguage() {
  return currentBackendLanguage;
}

/**
 * 按点分路径解析多语言字典并替换 `{token}` 占位符，缺失时自动回退至默认语言或键名本身。
 *
 * @param {string | undefined} language 目标语言代码
 * @param {string} key 点分路径翻译键
 * @param {Record<string, string | number>} [params] 模板插值参数
 */
export function translate(language, key, params = {}) {
  const lang = normalizeLanguage(language ?? currentBackendLanguage);
  const resolve = (/** @type {any} */ dict, /** @type {string} */ pathKey) =>
    pathKey.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), dict);
  const template = resolve(/** @type {any} */ (locales)[lang], key) ?? resolve(locales[DEFAULT_LANGUAGE], key) ?? key;
  if (typeof template !== 'string') return String(key);
  return template.replace(/\{(\w+)\}/g, (_, token) =>
    params[token] !== undefined ? String(params[token]) : `{${token}}`,
  );
}
