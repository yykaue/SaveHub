/**
 * 将嵌套的文件/记录子进度映射为单调递增的批次总百分比。
 * 当子任务缺少 total 时保持当前百分比不变，同时继续透传当前正在处理的文件名详情。
 * @param {(progress: import('../shared/contracts').Progress | null) => void} report
 * @param {number} start
 * @param {number} end
 * @param {string} [prefix]
 */
export function progressRange(report, start, end, prefix = '') {
  let percent = start;
  return (/** @type {import('../shared/contracts').Progress | null} */ progress) => {
    if (!progress) return;
    const value = progress.percent ?? (progress.total ? (100 * progress.completed) / progress.total : 0);
    percent = Math.max(percent, start + (Math.max(0, Math.min(100, value)) / 100) * (end - start));
    report({ ...progress, percent, detail: [prefix, progress.detail].filter(Boolean).join(' · ') });
  };
}

/**
 * 在存储引擎互斥写锁下组合游戏整包、快照与文件复制的多级进度区间，并在退出时恢复上层进度回调。
 * @template T
 * @param {import('./storage.mjs').SaveStore} store
 * @param {import('../shared/contracts').ProgressPhase} phase
 * @param {string} detail
 * @param {number} start
 * @param {number} end
 * @param {() => Promise<T>} action
 * @returns {Promise<T>}
 */
export async function progressTask(store, phase, detail, start, end, action) {
  const report = store.onProgress;
  store.onProgress = progressRange(report, start, end, detail);
  try {
    store.onProgress({ phase, detail: '', completed: 0, percent: 0 });
    const result = await action();
    store.onProgress({ phase, detail: '', completed: 1, total: 1, percent: 100 });
    return result;
  } finally {
    store.onProgress = report;
  }
}
