import {
  ArrowRight,
  CheckCheck,
  ExternalLink,
  Folder,
  HardDrive,
  History,
  Languages,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { Logo } from '../art';
import { formatBytes } from '../format';
import { SUPPORTED_LANGUAGES, t } from '../i18n';
import { RetentionSettings } from '../components/RetentionSettings';
import { LogSettings } from '../components/LogSettings';
import type { AppState, Language, RestorePointRetention } from '../types';

/**
 * 全局设置页面：包含界面语言切换、恢复点保留策略、日志容量上限、存储库路径概览及已移除游戏管理入口。
 */
export function SettingsPage({
  state,
  busy,
  storageBytes,
  onLanguage,
  onOpen,
  onRetention,
  onLogLimit,
  onRemovedGames,
  onHelp,
}: {
  state: AppState;
  busy: boolean;
  storageBytes: number;
  onLanguage: (language: Language) => void;
  onOpen: (kind: 'vault' | 'logs') => void;
  onRetention: (value: RestorePointRetention) => Promise<unknown>;
  onLogLimit: (value: number) => Promise<unknown>;
  onRemovedGames: () => void;
  onHelp: () => void;
}) {
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR SAVES. YOUR DEVICE.</div>
          <h1>{t('settings.headingTitle')}</h1>
          <p>{t('settings.headingDesc')}</p>
        </div>
      </div>
      <section className="settings-card">
        <h2>
          <Languages size={20} />
          {t('settings.languageTitle')}
        </h2>
        <p>{t('settings.languageDesc')}</p>
        <div className="language-options" role="group" aria-label={t('settings.languageGroupAria')}>
          {SUPPORTED_LANGUAGES.map((item) => (
            <button
              key={item.code}
              type="button"
              className={`button ${state.language === item.code ? 'primary' : 'secondary'} small`}
              aria-pressed={state.language === item.code}
              disabled={busy}
              onClick={() => onLanguage(item.code)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </section>
      <RetentionSettings
        key={`${state.restorePointRetention.active}/${state.restorePointRetention.removed}`}
        value={state.restorePointRetention}
        busy={busy}
        onSave={onRetention}
      />
      <LogSettings
        key={state.logLimitMB}
        value={state.logLimitMB}
        busy={busy}
        onSave={onLogLimit}
        onOpen={() => onOpen('logs')}
      />
      <section className="settings-card">
        <h2>
          <HardDrive size={20} />
          {t('settings.vaultTitle')}
        </h2>
        <p>{t('settings.vaultDesc')}</p>
        <div className="path-display">
          <Folder size={17} />
          <code>{state.dataDir}</code>
          <button className="icon-button" title={t('settings.openVault')} onClick={() => onOpen('vault')}>
            <ExternalLink size={16} />
          </button>
        </div>
        <div className="settings-metrics">
          <span>{t('settings.metricGames', { count: state.games.length })}</span>
          <span>{t('settings.metricStorage', { size: formatBytes(storageBytes) })}</span>
          <span>{state.platform === 'darwin' ? 'macOS / Apple Silicon' : 'Windows'}</span>
        </div>
      </section>
      <section className="settings-card">
        <h2>
          <ShieldCheck size={20} />
          {t('settings.safetyTitle')}
        </h2>
        <div className="protection-grid">
          <div>
            <CheckCheck size={22} />
            <strong>{t('settings.safetyIntegrityTitle')}</strong>
            <p>{t('settings.safetyIntegrityDesc')}</p>
          </div>
          <div>
            <History size={22} />
            <strong>{t('settings.safetyAutoBackupTitle')}</strong>
            <p>{t('settings.safetyAutoBackupDesc')}</p>
          </div>
          <div>
            <RotateCcw size={22} />
            <strong>{t('settings.safetyRollbackTitle')}</strong>
            <p>{t('settings.safetyRollbackDesc')}</p>
          </div>
        </div>
      </section>
      <section className="settings-card">
        <h2>
          <Trash2 size={20} />
          {t('settings.removedGamesTitle')}
        </h2>
        <p>{t('settings.removedGamesDesc')}</p>
        <button className="button secondary" onClick={onRemovedGames}>
          {t('settings.manageRemovedGames')}
        </button>
      </section>
      <div className="about-line">
        <Logo small />
        <strong>SaveHub</strong>
        <span>v{state.version}</span>
        <span>Windows & macOS Apple Silicon</span>
        <button className="text-button" onClick={onHelp}>
          {t('toolbar.userGuide')}
          <ArrowRight size={14} />
        </button>
      </div>
    </>
  );
}
