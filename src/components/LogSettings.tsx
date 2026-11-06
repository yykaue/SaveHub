import { useState } from 'react';
import { t } from '../i18n';
import { validLogLimit } from '../../shared/log-settings.mjs';

/**
 * 运行日志容量上限配置卡片组件（支持设置分类日志总容量上限及快速打开日志目录）。
 */
export function LogSettings({
  value,
  busy,
  onSave,
  onOpen,
}: {
  value: number;
  busy: boolean;
  onSave: (value: number) => Promise<unknown>;
  onOpen: () => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState('');
  return (
    <section className="settings-card">
      <h2>{t('logs.title')}</h2>
      <p>{t('settings.logsDesc')}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          if (!/^\d+$/.test(draft) || !validLogLimit(Number(draft))) {
            setError(t('logs.invalidLimit'));
            return;
          }
          void onSave(Number(draft)).catch((reason) => setError(String(reason)));
        }}
      >
        <fieldset disabled={busy}>
          <label className="field log-limit-field">
            <span className="field-label">{t('logs.limitLabel')}</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]+"
              required
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <p className="muted">{t('logs.zeroHint')}</p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="settings-actions">
            <button type="submit" className="button secondary">
              {t('logs.save')}
            </button>
            <button type="button" className="button secondary" onClick={onOpen}>
              {t('settings.openLogs')}
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
