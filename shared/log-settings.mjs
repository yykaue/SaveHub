export const DEFAULT_LOG_LIMIT_MB = 20;
export const BYTES_PER_MB = 1024 * 1024;
export const MAX_LOG_LIMIT_MB = Math.floor(Number.MAX_SAFE_INTEGER / BYTES_PER_MB);

/** @param {unknown} value */
export function validLogLimit(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_LOG_LIMIT_MB;
}
