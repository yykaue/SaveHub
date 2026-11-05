import zh from '../shared/locales/zh.json' with { type: 'json' };
import en from '../shared/locales/en.json' with { type: 'json' };
export const LANGUAGES = ['zh', 'en'];
export const DEFAULT_LANGUAGE = 'zh';

export const locales = { zh, en };

let currentBackendLanguage = DEFAULT_LANGUAGE;

/**
 * @param {string} [language]
 * @returns {import('../shared/contracts').Language}
 */
export function normalizeLanguage(language) {
  return language === 'en' ? 'en' : 'zh';
}

/**
 * @param {string} [language]
 */
export function setBackendLanguage(language) {
  currentBackendLanguage = normalizeLanguage(language);
  return currentBackendLanguage;
}

export function getBackendLanguage() {
  return currentBackendLanguage;
}

/**
 * @param {string | undefined} language
 * @param {string} key
 * @param {Record<string, string | number>} [params]
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
