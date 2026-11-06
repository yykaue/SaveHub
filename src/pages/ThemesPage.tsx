import { Check, Sparkles } from 'lucide-react';
import { t } from '../i18n';
import type { Theme } from '../types';
/** 获取所有可用视觉主题的本地化描述元数据 */
export const getThemes = (): { id: Theme; name: string; english: string; caption: string; description: string }[] => [
  {
    id: 'ink',
    name: t('themes.inkName'),
    english: 'INK & PAPER',
    caption: t('themes.inkCaption'),
    description: t('themes.inkDesc'),
  },
  {
    id: 'tech',
    name: t('themes.techName'),
    english: 'LUMINOUS',
    caption: t('themes.techCaption'),
    description: t('themes.techDesc'),
  },
  {
    id: 'cyber',
    name: t('themes.cyberName'),
    english: 'NEON CITY',
    caption: t('themes.cyberCaption'),
    description: t('themes.cyberDesc'),
  },
  {
    id: 'glass',
    name: t('themes.glassName'),
    english: 'SOFT GLASS',
    caption: t('themes.glassCaption'),
    description: t('themes.glassDesc'),
  },
];

export function ThemesPage({
  themeId,
  busy,
  onTheme,
}: {
  themeId: Theme;
  busy: boolean;
  onTheme: (theme: Theme) => void;
}) {
  const themes = getThemes();
  return (
    <>
      <PageHeading
        eyebrow="A DIFFERENT WAY TO FEEL."
        title={t('themes.headingTitle')}
        description={t('themes.headingDesc')}
      />
      <div className="theme-grid">
        {themes.map((theme) => (
          <button
            key={theme.id}
            className={`theme-card ${themeId === theme.id ? 'chosen' : ''}`}
            disabled={!!busy}
            onClick={() => onTheme(theme.id)}
            aria-label={t('themes.switchThemeAria', { name: theme.name })}
            aria-pressed={themeId === theme.id}
          >
            <div className={`theme-preview preview-${theme.id}`}>
              <div className="mini-sidebar">
                <i />
                <i />
                <i />
                <i />
              </div>
              <div className="mini-workspace">
                <div className="mini-title" />
                <div className="mini-hero">
                  <span>{theme.caption}</span>
                  <div className="mini-moon" />
                </div>
                <div className="mini-stats">
                  <i />
                  <i />
                  <i />
                </div>
                <div className="mini-row" />
                <div className="mini-row" />
              </div>
              <span className="preview-label">{theme.english}</span>
            </div>
            <div className="theme-card-copy">
              <div>
                <h2>{theme.name}</h2>
                <span>{theme.english}</span>
              </div>
              <span className={`theme-check ${themeId === theme.id ? 'checked' : ''}`}>
                {themeId === theme.id && <Check size={14} />}
              </span>
              <p>{theme.description}</p>
            </div>
          </button>
        ))}
      </div>
      <div className="theme-note">
        <Sparkles size={19} />
        <div>
          <strong>{t('themes.noteTitle')}</strong>
          <p>{t('themes.noteDesc')}</p>
        </div>
        <span>
          {themes.find((theme) => theme.id === themeId)?.name} · {t('themes.activeStatus')}
        </span>
      </div>
    </>
  );
}
function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <div className="page-heading standalone">
      <div className="eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}
