// 日志容量默认上限（20 MB）、字节换算常量及最大允许上限（1024 MB = 1 GB）
export const DEFAULT_LOG_LIMIT_MB = 20;
export const BYTES_PER_MB = 1024 * 1024;
export const MAX_LOG_LIMIT_MB = 1024;

/** 校验日志容量设置是否为合法非负整数（0 表示禁用并清空日志） @param {unknown} value */
export function validLogLimit(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_LOG_LIMIT_MB;
}
