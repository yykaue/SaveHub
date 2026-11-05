import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { getLanguage, getLanguageMeta, normalizeLanguage, setLanguage, subscribeLanguage, t } from '../i18n';
import { animate } from '../motion';
import type { AppState, Progress } from '../types';
export function useSaveHub(onStart: () => void, onClose: () => void) {
  const api = window.savehub;
  useSyncExternalStore(subscribeLanguage, getLanguage);
  const [state, setState] = useState<AppState | null>(null);
  const [bootError, setBootError] = useState('');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const refresh = useCallback(async () => {
    if (!api) return;
    const next = await api.state();
    const lang = normalizeLanguage(next.language);
    setLanguage(lang);
    localStorage.setItem('savehub-language', lang);
    document.documentElement.lang = getLanguageMeta(lang).htmlLang;
    document.title = t('app.documentTitle', undefined, lang);
    await animate(() => {
      setState(next);
      document.documentElement.dataset.theme = next.theme;
    });
    return next;
  }, [api]);

  useEffect(() => {
    refresh()
      .then((next) => {
        if (next?.recoveryMessages.length) setToast({ text: next.recoveryMessages.join('\n') });
      })
      .catch((error) => setBootError(error.message));
    return api?.onProgress((next) => {
      // Keep the last completed progress visible until the result and refreshed state arrive.
      if (next) setProgress(next);
    });
  }, [refresh, api]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.error ? 14000 : 6500);
    return () => clearTimeout(timer);
  }, [toast]);

  const perform = async <T>(label: string, action: () => Promise<T>, success?: string, close = false) => {
    if (busy) return null;
    setProgress(null);
    setBusy(label);
    onStart();
    try {
      const result = await action();
      await refresh();
      if (success) setToast({ text: success });
      if (close) onClose();
      return result;
    } catch (error) {
      await refresh().catch(() => {});
      setToast({ text: error instanceof Error ? error.message : t('messages.operationFailed'), error: true });
      return null;
    } finally {
      setBusy('');
      setProgress(null);
    }
  };

  return { api, state, bootError, busy, progress, toast, setToast, refresh, perform };
}
