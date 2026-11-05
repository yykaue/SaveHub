import { Archive, Clock3, HardDrive, Plus, Settings2, ShieldCheck } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { GameGlyph, Landscape } from '../art';
import { SnapshotList } from '../SnapshotList';
import { dateLabel, formatBytes, gameName, kindLabel } from '../format';
import { t } from '../i18n';
import type { Game, Platform, Snapshot } from '../types';
export function LibraryPage({
  current,
  games,
  saves,
  totalFiles,
  platform,
  busy,
  openSave,
  onEdit,
  snapshotList,
}: {
  current: Game;
  games: Game[];
  saves: Snapshot[];
  totalFiles: number;
  platform: Platform;
  busy: boolean;
  openSave: () => void;
  onEdit: () => void;
  snapshotList: ComponentProps<typeof SnapshotList>;
}) {
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR ADVENTURE, PRESERVED.</div>
          <h1>
            {t('library.headingTitle')}
            <span className="heading-period">{t('library.headingPeriod')}</span>
          </h1>
          <p>{t('library.headingDesc')}</p>
        </div>
        <span className="ink-seal" aria-hidden="true">
          存<br />心
        </span>
      </div>
      <section className="game-hero" aria-label={t('library.heroAria', { name: gameName(current) })}>
        <Landscape kind={current.icon} />
        <div className="hero-shade" />
        <div className="hero-content">
          <div className="hero-kicker">
            <span className="small-line" />
            {t('library.activeGame')}
          </div>
          <div className="hero-title">
            <GameGlyph icon={current.icon} size={30} />
            <h2>{gameName(current)}</h2>
          </div>
          <p className="game-subtitle">{current.subtitle || 'MY NEXT ADVENTURE'}</p>
          <div className="hero-status">
            <span className={`status-dot ${current.pathStatus !== 'ready' ? 'warning' : ''}`} />
            {current.pathStatus === 'ready'
              ? t('library.statusReady')
              : current.pathStatus === 'missing'
                ? t('library.statusMissing')
                : t('library.statusUnconfigured')}
            <span className="hero-status-divider" /> {platform === 'darwin' ? 'macOS · Apple Silicon' : 'Windows'}
          </div>
          <div className="hero-actions">
            <button className="button primary" disabled={!!busy} onClick={openSave}>
              <Plus size={17} />
              {current.pathStatus === 'ready' ? t('library.createNewSave') : t('library.configureSavePath')}
            </button>
            <button className="button subtle" disabled={!!busy} onClick={onEdit}>
              <Settings2 size={15} />
              {t('library.gameSettings')}
            </button>
          </div>
        </div>
        <span className="hero-caption">
          {current.icon === 'ring'
            ? t('library.captionRing')
            : current.icon === 'spire'
              ? t('library.captionSpire')
              : current.icon === 'flame'
                ? t('library.captionFlame')
                : t('library.captionDefault')}
        </span>
        <span className="hero-index">
          {String(games.indexOf(current) + 1).padStart(2, '0')} / {String(games.length).padStart(2, '0')}
        </span>
      </section>
      <section className="stats-row" aria-label={t('library.statsAria')}>
        <Stat
          icon={<Archive size={18} />}
          label={t('library.statTotalSaves')}
          value={String(saves.length).padStart(2, '0')}
          unit={t('library.statTotalSavesUnit')}
        />
        <Stat
          icon={<ShieldCheck size={18} />}
          label={t('library.statRestoreSafety')}
          value={t('library.statRestoreSafetyValue')}
          detail={t('library.statRestoreSafetyDetail')}
        />
        <Stat
          icon={<HardDrive size={18} />}
          label={t('library.statStorage')}
          value={formatBytes(saves.reduce((sum, snapshot) => sum + snapshot.bytes, 0))}
          detail={t('library.statStorageDetail', { count: totalFiles })}
        />
        <Stat
          icon={<Clock3 size={18} />}
          label={t('library.statLatestSave')}
          value={saves[0] ? dateLabel(saves[0].createdAt) : t('library.statLatestSaveEmpty')}
          detail={saves[0] ? kindLabel(saves[0].kind) : t('library.statLatestSaveEmptyDetail')}
        />
      </section>
      <SnapshotList {...snapshotList} />
      <footer className="page-footer">
        <span>SAVE YOUR PROGRESS. KEEP YOUR STORIES.</span>
        <span>{t('library.footerQuote')}</span>
      </footer>
    </>
  );
}
function Stat({
  icon,
  label,
  value,
  unit,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  unit?: string;
  detail?: string;
}) {
  return (
    <div className="stat">
      <div className="stat-label">
        {icon}
        {label}
      </div>
      <div className="stat-value">
        {value}
        {unit && <span>{unit}</span>}
      </div>
      {detail && <small>{detail}</small>}
    </div>
  );
}
