import { Download, History, RotateCcw, Trash2 } from 'lucide-react';
import { formatBytes, fullDate } from './format';
import { t } from './i18n';
import { SelectionCheckbox } from './SnapshotList';
import type { Snapshot, RestorePointRetention } from './types';

export type PointSelection = { active: string[]; removed: string[] };

export function RestorePoints({
  points,
  selection,
  busy,
  canRestore,
  retention,
  onSelect,
  onRestore,
  onExport,
  onDelete,
  onRecover,
}: {
  points: Snapshot[];
  selection: PointSelection;
  busy: boolean;
  canRestore: boolean;
  retention: RestorePointRetention;
  onSelect: (group: keyof PointSelection, ids: string[]) => void;
  onRestore: (snapshot: Snapshot) => void;
  onExport: (snapshot: Snapshot) => void;
  onDelete: (snapshots: Snapshot[]) => void;
  onRecover: (ids: string[]) => void;
}) {
  function group(removed: boolean) {
    const key = removed ? 'removed' : 'active';
    const rows = points
      .filter((point) => Boolean(point.deletedAt) === removed)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    const selectable = rows.filter((point) => !point.corrupted);
    const selected = selectable.filter((point) => selection[key].includes(point.id));
    const allSelected = selectable.length > 0 && selected.length === selectable.length;
    const containsProtected = selected.some((point) => point.protected);
    const containsPending = selected.some((point) => point.purgePending);
    const title = removed ? t('restorePoints.removedTitle') : t('restorePoints.activeTitle');
    const recoveryError =
      retention.active === 0
        ? t('retention.recoveryDisabled')
        : selected.length > retention.active
          ? t('retention.recoveryLimit', { count: selected.length, limit: retention.active })
          : '';
    return (
      <section className="restore-points-group" aria-label={title}>
        <div className="restore-point-toolbar">
          <label>
            <SelectionCheckbox
              label={t('restorePoints.selectAllAria', { title })}
              checked={allSelected}
              mixed={selected.length > 0 && !allSelected}
              disabled={busy || !selectable.length}
              onChange={() => onSelect(key, allSelected ? [] : selectable.map((point) => point.id))}
            />
            {t('restorePoints.selectAllLabel')}
          </label>
          <span aria-live="polite">
            {t('restorePoints.selectedCount', { selected: selected.length, total: selectable.length })}
          </span>
          {removed && (
            <button
              className="button secondary small"
              title={recoveryError || undefined}
              disabled={busy || !selected.length || containsPending || !!recoveryError}
              onClick={() => onRecover(selected.map((point) => point.id))}
            >
              <RotateCcw size={14} />
              {t('restorePoints.recoverSelected')}
            </button>
          )}
          <button
            className="button secondary small danger-text"
            disabled={busy || !selected.length || containsProtected}
            title={containsProtected ? t('restorePoints.protectedCannotDeleteTitle') : undefined}
            onClick={() => onDelete(selected)}
          >
            <Trash2 size={14} />
            {removed ? t('restorePoints.deletePermanentlySelected') : t('restorePoints.removeSelected')}
          </button>
        </div>
        {removed && recoveryError && (
          <p className="form-error" role="alert">
            {recoveryError}
          </p>
        )}
        <div className="restore-points-list">
          {rows.map((point) => (
            <div className="restore-point" key={point.id}>
              <SelectionCheckbox
                label={t('restorePoints.selectPointAria', { label: point.label })}
                checked={selected.some((item) => item.id === point.id)}
                disabled={busy || point.corrupted}
                onChange={() =>
                  onSelect(
                    key,
                    selection[key].includes(point.id)
                      ? selection[key].filter((id) => id !== point.id)
                      : [...selection[key], point.id],
                  )
                }
              />
              <History size={18} />
              <div>
                <strong>{point.label}</strong>
                <small>
                  {t('retention.modified')}：{fullDate(point.updatedAt)} · {formatBytes(point.bytes)}
                  {point.purgePending ? t('restorePoints.purgePendingNote') : ''}
                </small>
              </div>
              {removed ? (
                <button
                  className="load-button"
                  title={retention.active === 0 ? t('retention.recoveryDisabled') : undefined}
                  disabled={busy || point.corrupted || point.purgePending || retention.active === 0}
                  onClick={() => onRecover([point.id])}
                >
                  <RotateCcw size={14} />
                  {t('restorePoints.recoverBtn')}
                </button>
              ) : (
                <>
                  <button
                    className="load-button"
                    disabled={busy || point.corrupted || !canRestore}
                    onClick={() => onRestore(point)}
                  >
                    <RotateCcw size={14} />
                    {t('restorePoints.restoreBtn')}
                  </button>
                  <button
                    className="icon-button"
                    aria-label={t('restorePoints.exportPointAria', { label: point.label })}
                    disabled={busy || point.corrupted}
                    onClick={() => onExport(point)}
                  >
                    <Download size={15} />
                  </button>
                </>
              )}
              <button
                className="icon-button danger-text"
                aria-label={t(removed ? 'restorePoints.deletePointPermanentlyAria' : 'restorePoints.removePointAria', {
                  label: point.label,
                })}
                disabled={busy || point.corrupted || point.protected}
                onClick={() => onDelete([point])}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {!rows.length && (
            <div className="quiet-empty">
              {removed ? t('restorePoints.emptyRemoved') : t('restorePoints.emptyActive')}
            </div>
          )}
        </div>
      </section>
    );
  }
  return (
    <>
      <p className="form-description">{t('restorePoints.description')}</p>
      <p className="muted">{t('retention.limits', { active: retention.active, removed: retention.removed })}</p>
      {group(false)}
      <details className="removed-points">
        <summary>
          {t('restorePoints.removedSummary', { count: points.filter((point) => point.deletedAt).length })}
        </summary>
        <p className="muted">{t('restorePoints.removedDesc')}</p>
        {group(true)}
      </details>
    </>
  );
}
