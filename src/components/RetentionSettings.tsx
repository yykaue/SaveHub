import { useState } from 'react';
import { t } from '../i18n';
import type { RestorePointRetention } from '../types';

export type RetentionDraft = { active: string | null; removed: string | null };
export const retentionDraft = (value: Partial<RestorePointRetention>): RetentionDraft => ({
  active: value.active === undefined ? null : String(value.active),
  removed: value.removed === undefined ? null : String(value.removed),
});

export function retentionValues(draft: RetentionDraft): Partial<RestorePointRetention> {
  const result: Partial<RestorePointRetention> = {};
  for (const key of ['active', 'removed'] as const) {
    const raw = draft[key];
    if (raw === null) continue;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(t('retention.invalidCount'));
    result[key] = Number(raw);
  }
  return result;
}

export function RetentionFields({
  value,
  onChange,
  defaults,
  inherit = false,
}: {
  value: RetentionDraft;
  onChange: (value: RetentionDraft) => void;
  defaults: RestorePointRetention;
  inherit?: boolean;
}) {
  return (
    <div className="retention-fields">
      {(['active', 'removed'] as const).map((key) => (
        <div className="retention-field" key={key}>
          <label className="field">
            <span className="field-label">{t(`retention.${key}`)}</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]+"
              required
              aria-label={t(`retention.${key}`)}
              disabled={inherit && value[key] === null}
              value={value[key] ?? String(defaults[key])}
              onChange={(event) => onChange({ ...value, [key]: event.target.value })}
            />
          </label>
          {inherit && (
            <label className="retention-inherit">
              <input
                type="checkbox"
                checked={value[key] === null}
                onChange={(event) => onChange({ ...value, [key]: event.target.checked ? null : String(defaults[key]) })}
              />
              {t('retention.inherit')} ·{' '}
              {t('retention.effective', { count: value[key] === null ? defaults[key] : Number(value[key]) || 0 })}
            </label>
          )}
        </div>
      ))}
    </div>
  );
}

export function RetentionSettings({
  value,
  busy,
  onSave,
}: {
  value: RestorePointRetention;
  busy: boolean;
  onSave: (value: RestorePointRetention) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(() => retentionDraft(value));
  const [error, setError] = useState('');
  return (
    <section className="settings-card">
      <h2>{t('retention.title')}</h2>
      <p>{t('retention.description')}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          try {
            const next = retentionValues(draft);
            if (next.active === undefined || next.removed === undefined) throw new Error(t('retention.invalidCount'));
            void onSave({ active: next.active, removed: next.removed }).catch((reason) => setError(String(reason)));
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        }}
      >
        <fieldset disabled={busy}>
          <RetentionFields value={draft} onChange={setDraft} defaults={value} />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button secondary">
            {t('retention.save')}
          </button>
        </fieldset>
      </form>
    </section>
  );
}
