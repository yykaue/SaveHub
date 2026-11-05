/**
 * Map nested file/record progress into one monotonically increasing batch percentage.
 * Unknown totals keep the current percentage while still showing the current file.
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
 * Scopes compose across game bundles, snapshots and file copies under the store write lock.
 * @template T
 * @param {import('./storage.mjs').SaveStore} store
 * @param {string} phase
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
