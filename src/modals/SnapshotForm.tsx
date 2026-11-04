import { useState } from 'react';
import { Archive, Info, LoaderCircle } from 'lucide-react';
import { dateLabel } from '../format';
import { t } from '../i18n';
import type { Snapshot } from '../types';

export function SnapshotForm({
  snapshot,
  busy,
  onSave,
  onCancel,
}: {
  snapshot?: Snapshot;
  busy: boolean;
  onSave: (values: { label: string; note: string }) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(
    snapshot?.label ||
      `${t('modals.snapshotForm.defaultLabelPrefix')} · ${dateLabel(new Date().toISOString())}`,
  );
  const [note, setNote] = useState(snapshot?.note || '');

  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        void onSave({ label, note });
      }}
    >
      <fieldset disabled={busy}>
        <p className="form-description">
          {t(snapshot ? 'modals.snapshotForm.editDesc' : 'modals.snapshotForm.createDesc')}
        </p>
        <label className="field">
          <span className="field-label">{t('modals.snapshotForm.nameLabel')}</span>
          <input
            required
            maxLength={100}
            value={label}
            onChange={event => setLabel(event.target.value)}
            placeholder={t('modals.snapshotForm.namePlaceholder')}
          />
        </label>
        <label className="field">
          <span className="field-label">
            {t('modals.snapshotForm.noteLabel')}{' '}
            <span className="optional">{t('modals.snapshotForm.optional')}</span>
          </span>
          <textarea
            rows={4}
            maxLength={2000}
            value={note}
            onChange={event => setNote(event.target.value)}
            placeholder={t('modals.snapshotForm.notePlaceholder')}
          />
        </label>
        {!snapshot && (
          <div className="notice">
            <Info size={17} />
            <span>{t('modals.snapshotForm.closeGameNotice')}</span>
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onCancel}>
            {t('modals.cancelBtn')}
          </button>
          <button className="button primary" type="submit">
            {busy ? <LoaderCircle size={16} className="spin" /> : <Archive size={16} />}{' '}
            {t(snapshot ? 'modals.snapshotForm.saveChangesBtn' : 'modals.snapshotForm.createSaveBtn')}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

