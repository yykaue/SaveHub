import { translate } from './i18n.mjs';

/** 携带多语言错误码与模板参数的业务异常类 */
export class AppError extends Error {
  /** @param {string} code @param {Record<string, string | number>} [params] @param {string} [language] */
  constructor(code, params = {}, language) {
    super(translate(language, code, params));
    this.name = 'AppError';
    this.code = code;
    this.params = params;
  }
}

/** 将业务异常或底层 Node.js 文件系统错误序列化为统一的跨进程错误结构 @param {unknown} error @param {string} [language] */
export function serializeError(error, language) {
  if (error instanceof AppError) return { code: error.code, params: error.params, message: error.message };
  const value = /** @type {NodeJS.ErrnoException} */ (error);
  const codes = /** @type {Record<string, string>} */ ({
    EACCES: 'errors.denied',
    EPERM: 'errors.denied',
    ENOENT: 'errors.missing',
    ENOSPC: 'errors.diskFull',
    EBUSY: 'errors.busy',
  });
  const code = codes[value?.code || ''] || 'errors.unexpected';
  /** @type {Record<string, string | number>} */
  const params =
    code === 'errors.unexpected' ? { message: value?.message || String(error) } : { path: value?.path || '' };
  return { code, params, message: translate(language, code, params) };
}
