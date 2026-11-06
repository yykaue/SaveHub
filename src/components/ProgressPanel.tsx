import { LoaderCircle } from 'lucide-react';
import { t } from '../i18n';
import type { Progress } from '../types';

export function ProgressPanel({ label, progress }: { label: string; progress: Progress | null }) {
  const value = progress?.percent ?? (progress?.total ? (100 * progress.completed) / progress.total : undefined);
  const percent = value === undefined ? undefined : Math.floor(Math.max(0, Math.min(100, value)));
  const phases: Record<Progress['phase'], string> = {
    checking: t('progress.checking'),
    copying: t('progress.copying'),
    restoring: t('progress.restoring'),
    deleting: t('progress.deleting'),
    importing: t('progress.importing'),
    exporting: t('progress.exporting'),
    pruning: t('progress.pruning'),
  };
  return (
    <div className="progress-panel" role="status">
      <LoaderCircle size={23} className="spin" />
      <div>
        <strong>{label}</strong>
        <p>{(progress?.phase && phases[progress.phase]) || t('app.preparingProgress')}</p>
        {progress?.detail && <p title={progress.detail}>{progress.detail}</p>}
      </div>
      <span>{percent === undefined ? t('progress.preparing') : `${percent}%`}</span>
      <div
        className={`progress-bar${percent === undefined ? ' indeterminate' : ''}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <i style={{ width: percent === undefined ? '35%' : `${percent}%` }} />
      </div>
    </div>
  );
}
