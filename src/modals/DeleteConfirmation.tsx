import { Star, Trash2 } from 'lucide-react';
import { t } from '../i18n';
import type { Snapshot } from '../types';

export function DeleteConfirmation({
  snapshots,
  permanent,
  busy,
  onCancel,
  onConfirm,
}: {
  snapshots: Snapshot[];
  permanent: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const points = snapshots.every((snapshot) => snapshot.kind === 'safety');
  const destination = points ? t('modals.deleteConfirm.destRemovedPoints') : t('modals.deleteConfirm.destTrash');
  const label = permanent
    ? t('modals.deleteConfirm.btnPermanent', { count: snapshots.length })
    : points
      ? t('modals.deleteConfirm.btnRemovePoints', { count: snapshots.length })
      : snapshots.length === 1
        ? t('modals.deleteConfirm.btnMoveSingle')
        : t('modals.deleteConfirm.btnDeleteBatch', { count: snapshots.length });

  return (
    <>
      <p className="dialog-description">
        {permanent
          ? t('modals.deleteConfirm.descPermanent', { count: snapshots.length })
          : t('modals.deleteConfirm.descSoft', { count: snapshots.length, destination })}
      </p>
      {permanent && (
        <div className="notice permanent-delete-warning" role="note">
          <Trash2 size={19} />
          <div>
            <strong>{t('modals.deleteConfirm.permanentWarningTitle')}</strong>
            <p>{t('modals.deleteConfirm.permanentWarningDesc')}</p>
          </div>
        </div>
      )}
      <FavoriteDeleteNotice snapshots={snapshots} permanent={permanent} />
      <ul className="batch-confirm-list">
        {snapshots.map((snapshot) => (
          <li key={snapshot.id} className={snapshot.favorite ? 'favorite-delete-item' : undefined}>
            {snapshot.label}
            {snapshot.favorite && (
              <span className="favorite-delete-tag">
                <Star size={12} />
                {t('modals.deleteConfirm.favoriteTag')}
              </span>
            )}
          </li>
        ))}
      </ul>
      {!permanent && <p className="muted">{t('modals.deleteConfirm.softFootnote', { destination })}</p>}
      <div className="dialog-actions">
        <button className="button secondary" disabled={busy} onClick={onCancel}>
          {t('modals.cancelBtn')}
        </button>
        <button
          className="button danger"
          disabled={busy || snapshots.some((snapshot) => snapshot.protected)}
          onClick={onConfirm}
        >
          {label}
        </button>
      </div>
    </>
  );
}

export function FavoriteDeleteNotice({ snapshots, permanent = false }: { snapshots: Snapshot[]; permanent?: boolean }) {
  const count = snapshots.filter((snapshot) => snapshot.favorite).length;
  if (!count) return null;
  return (
    <div className="notice favorite-delete-warning" role="note" aria-label={t('modals.deleteConfirm.favWarningAria')}>
      <Star size={22} />
      <div>
        <strong>{t('modals.deleteConfirm.favWarningTitle', { count })}</strong>
        <p>
          {t(permanent ? 'modals.deleteConfirm.favWarningPermanentDesc' : 'modals.deleteConfirm.favWarningSoftDesc')}
        </p>
      </div>
    </div>
  );
}
