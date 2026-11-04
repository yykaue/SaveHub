import { useState } from 'react';
import { Archive, ArrowRight, Folder, History, LoaderCircle, RotateCcw, ShieldCheck } from 'lucide-react';
import { GameGlyph } from '../art';
import { formatBytes, fullDate, gameName } from '../format';
import { t } from '../i18n';
import type { Game, Platform, Snapshot } from '../types';

export function RestoreConfirm({
  snapshot,
  game,
  platform,
  busy,
  onConfirm,
  onCancel,
}: {
  snapshot: Snapshot;
  game: Game;
  platform: Platform;
  busy: boolean;
  onConfirm: () => Promise<unknown>;
  onCancel: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);

  return (
    <>
      <div className="restore-card">
        <div className="dialog-symbol">
          <History size={27} />
        </div>
        <h3>{snapshot.label}</h3>
        <p>
          {fullDate(snapshot.createdAt)} · {formatBytes(snapshot.bytes)}
        </p>
      </div>
      <div className="restore-flow">
        <span>
          <Archive size={18} />
          {t('modals.restoreConfirm.selectedSave')}
        </span>
        <ArrowRight size={17} />
        <span>
          <GameGlyph icon={game.icon} size={18} />
          {gameName(game)}
        </span>
      </div>
      <div className="path-display compact">
        <Folder size={15} />
        <code>{game.locations[platform].root}</code>
      </div>
      <div className="notice">
        <ShieldCheck size={19} />
        <span>{t('modals.restoreConfirm.safetyNotice')}</span>
      </div>
      <p className="muted small-text">
        {t('modals.restoreConfirm.replaceSummary', {
          entries: snapshot.entries.join(t('modals.restoreConfirm.entrySeparator')),
        })}
      </p>
      <label className="confirm-checkbox">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy}
          onChange={event => setConfirmed(event.target.checked)}
        />
        <span>{t('modals.restoreConfirm.confirmCheckbox')}</span>
      </label>
      <div className="dialog-actions">
        <button className="button secondary" disabled={busy} onClick={onCancel}>
          {t('modals.restoreConfirm.cancelBtn')}
        </button>
        <button className="button primary" disabled={!confirmed || busy} onClick={() => void onConfirm()}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <RotateCcw size={16} />}
          {t('modals.restoreConfirm.confirmBtn')}
        </button>
      </div>
    </>
  );
}

