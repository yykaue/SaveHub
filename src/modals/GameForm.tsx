import { useState, type CSSProperties, type FormEvent } from 'react';
import { Check, FolderOpen, Info, LoaderCircle, Monitor, Trash2, Upload } from 'lucide-react';
import { GameGlyph } from '../art';
import { getDictionary, t } from '../i18n';
import { animate } from '../motion';
import type { Bridge, Game, GameInput, Platform } from '../types';

const icons = ['ring', 'spire', 'flame', 'gamepad', 'swords', 'gem', 'ghost', 'rocket'] as const;
const colors = ['#8a9270', '#729486', '#a28167', '#738fb1', '#ab80ae', '#be7976'];

export function GameForm({
  game,
  platform,
  api,
  busy,
  onSave,
  onCancel,
  onDelete,
}: {
  game?: Game;
  platform: Platform;
  api: Bridge;
  busy: boolean;
  onSave: (values: GameInput) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(game?.name || '');
  const [subtitle, setSubtitle] = useState(game?.subtitle || '');
  const [icon, setIcon] = useState(game?.icon || 'gamepad');
  const [color, setColor] = useState(game?.color || colors[0]);
  const [locations, setLocations] = useState(
    game?.locations || { win32: { root: '', items: [] }, darwin: { root: '', items: [] } },
  );
  const [tab, setTab] = useState(platform);
  const [rawItems, setRawItems] = useState({
    win32: (game?.locations.win32.items || []).join('\n'),
    darwin: (game?.locations.darwin.items || []).join('\n'),
  });
  const [legacyRoot, setLegacyRoot] = useState(game?.legacyRoot || '');
  const [error, setError] = useState('');
  const iconNames = getDictionary().modals.gameForm.icons;

  const pick = async (kind: 'icon' | 'directory') => {
    try {
      const value = kind === 'icon' ? await api.pickIcon() : await api.pickDirectory();
      if (value) {
        if (kind === 'icon') setIcon(value);
        else setLocations({ ...locations, [tab]: { ...locations[tab], root: value } });
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onSave({
      id: game?.id,
      name,
      subtitle,
      icon,
      color,
      legacyRoot,
      locations: {
        win32: {
          root: locations.win32.root,
          items: rawItems.win32
            .split('\n')
            .map(item => item.trim())
            .filter(Boolean),
        },
        darwin: {
          root: locations.darwin.root,
          items: rawItems.darwin
            .split('\n')
            .map(item => item.trim())
            .filter(Boolean),
        },
      },
    });
  };

  return (
    <form onSubmit={submit}>
      <fieldset disabled={busy}>
        <div className="game-form-intro">
          <span className="edit-game-icon" style={{ '--game-color': color } as CSSProperties}>
            <GameGlyph icon={icon} size={33} />
          </span>
          <div>
            <p>{t('modals.gameForm.introTitle')}</p>
            <small>{t('modals.gameForm.introDesc')}</small>
          </div>
        </div>
        <div className="form-columns">
          <label className="field">
            <span className="field-label">
              {t('modals.gameForm.nameLabel')} <span className="required-mark">*</span>
            </span>
            <input
              autoComplete="off"
              required
              maxLength={80}
              placeholder={t('modals.gameForm.namePlaceholder')}
              value={name}
              onChange={event => setName(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">{t('modals.gameForm.subtitleLabel')}</span>
            <input
              maxLength={80}
              placeholder={t('modals.gameForm.subtitlePlaceholder')}
              value={subtitle}
              onChange={event => setSubtitle(event.target.value)}
            />
          </label>
        </div>
        <div className="icon-picker">
          <span>{t('modals.gameForm.iconLabel')}</span>
          <div>
            {icons.map(value => (
              <button
                type="button"
                key={value}
                className={icon === value ? 'chosen' : ''}
                aria-label={t('modals.gameForm.iconAria', { name: iconNames[value] })}
                onClick={() => setIcon(value)}
              >
                <GameGlyph icon={value} size={20} />
              </button>
            ))}
            <button
              type="button"
              className="upload-icon"
              title={t('modals.gameForm.uploadIconTitle')}
              onClick={() => void pick('icon')}
            >
              <Upload size={17} />
              {t('modals.gameForm.uploadBtn')}
            </button>
          </div>
        </div>
        <div className="color-picker">
          <span>{t('modals.gameForm.colorLabel')}</span>
          {colors.map(value => (
            <button
              key={value}
              type="button"
              style={{ background: value }}
              aria-label={t('modals.gameForm.colorAria', { color: value })}
              aria-pressed={color === value}
              onClick={() => setColor(value)}
            >
              {color === value && <Check size={13} />}
            </button>
          ))}
        </div>
        <div className="form-divider" />
        <div className="platform-tabs" role="tablist" aria-label={t('modals.gameForm.platformTabsAria')}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'win32'}
            className={tab === 'win32' ? 'active' : ''}
            onClick={() => void animate(() => setTab('win32'))}
          >
            <Monitor size={15} />
            Windows {platform === 'win32' && <small>{t('modals.gameForm.currentOs')}</small>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'darwin'}
            className={tab === 'darwin' ? 'active' : ''}
            onClick={() => void animate(() => setTab('darwin'))}
          >
            <Monitor size={15} />
            macOS <small>Apple Silicon</small>
          </button>
        </div>
        <label className="field">
          <span className="field-label">{t('modals.gameForm.rootDirLabel')}</span>
          <div className="input-with-button">
            <input
              aria-label={t('modals.gameForm.rootDirLabel')}
              placeholder={
                tab === 'win32'
                  ? t('modals.gameForm.rootDirPlaceholderWin')
                  : t('modals.gameForm.rootDirPlaceholderMac')
              }
              value={locations[tab].root}
              onChange={event =>
                setLocations({ ...locations, [tab]: { ...locations[tab], root: event.target.value } })
              }
            />
            <button
              type="button"
              disabled={tab !== platform}
              title={
                tab !== platform
                  ? t('modals.gameForm.browseOtherOsTitle')
                  : t('modals.gameForm.browseFolderTitle')
              }
              onClick={() => void pick('directory')}
            >
              <FolderOpen size={17} />
            </button>
          </div>
        </label>
        <label className="field">
          <span className="field-label">{t('modals.gameForm.backupItemsLabel')}</span>
          <textarea
            rows={3}
            spellCheck={false}
            placeholder={t('modals.gameForm.backupItemsPlaceholder')}
            value={rawItems[tab]}
            onChange={event => setRawItems({ ...rawItems, [tab]: event.target.value })}
          />
          <small>{t('modals.gameForm.backupItemsHint')}</small>
        </label>
        {tab === 'darwin' && (
          <div className="notice compact">
            <Info size={15} />
            <span>{t('modals.gameForm.macWineNotice')}</span>
          </div>
        )}
        <details className="advanced-settings">
          <summary>{t('modals.gameForm.legacyRootSummary')}</summary>
          <label className="field">
            <input
              value={legacyRoot}
              onChange={event => setLegacyRoot(event.target.value)}
              placeholder={t('modals.gameForm.legacyRootPlaceholder')}
            />
            <small>{t('modals.gameForm.legacyRootHint')}</small>
          </label>
        </details>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          {onDelete && (
            <button
              type="button"
              className="text-button danger-text delete-game-button"
              onClick={onDelete}
            >
              <Trash2 size={15} />
              {t('modals.gameForm.removeGameBtn')}
            </button>
          )}
          <button type="button" className="button secondary" onClick={onCancel}>
            {t('modals.cancelBtn')}
          </button>
          <button type="submit" className="button primary">
            {busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
            {t('modals.gameForm.saveGameBtn')}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

