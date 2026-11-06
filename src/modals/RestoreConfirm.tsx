import { Archive, ArrowRight, Folder, History, LoaderCircle, RotateCcw, ShieldCheck } from 'lucide-react';
import { GameGlyph } from '../art';
import { formatBytes, fullDate, gameName } from '../format';
import { t } from '../i18n';
import type { Game, Platform, Snapshot } from '../types';

/**
 * 恢复存档确认对话框组件：清晰展示将被覆盖的目标游戏目录、受影响条目及自动安全备份说明。
 */
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
      <p className="restore-warning">{t('modals.restoreConfirm.gameClosedWarning')}</p>
      <div className="dialog-actions">
        <button className="button secondary" disabled={busy} onClick={onCancel}>
          {t('modals.restoreConfirm.cancelBtn')}
        </button>
        <button className="button primary" disabled={busy} onClick={() => void onConfirm()}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <RotateCcw size={16} />}
          {t('modals.restoreConfirm.confirmBtn')}
        </button>
      </div>
    </>
  );
}
