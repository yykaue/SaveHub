import type { CSSProperties } from 'react';
import { ArrowRight, Download, FolderOpen, LayoutGrid, List, Plus, RotateCcw, Search, Settings2, Trash2, Upload } from 'lucide-react';
import { GameGlyph, Landscape } from './art';
import { formatBytes, gameName } from './format';
import { t } from './i18n';
import type { Game, Platform } from './types';

export interface GamesView { layout: 'cards' | 'list'; query: string; removed: boolean; selectedIds: string[] }
interface GameActions {
  busy: boolean; onExport: (games: Game[]) => void; onEdit: (game: Game) => void;
  onDelete: (game: Game) => void; onOpen: (id: string) => void; onRecover: (game: Game) => void;
}
const pending = (game: Game) => Boolean(game.purgeGamePending || game.purgeSnapshotsPending);
const records = (game: Game) => [...game.snapshots, ...game.restorePoints];
const recordSummary = (game: Game) => t('games.records', {
  count: records(game).length, size: formatBytes(records(game).reduce((total, save) => total + save.bytes, 0)),
});

export function AllGames({ games, platform, view, onViewChange, onAdd, onImport, ...actions }: GameActions & {
  games: Game[]; platform: Platform; view: GamesView; onViewChange: (changes: Partial<GamesView>) => void;
  onAdd: () => void; onImport: () => void;
}) {
  const { busy, onExport, onEdit, onOpen } = actions;
  const active = games.filter(game => !game.deletedAt);
  const shown = games.filter(game => Boolean(game.deletedAt) === view.removed &&
    (gameName(game) + ' ' + game.subtitle).toLocaleLowerCase().includes(view.query.toLocaleLowerCase().trim()));
  const selection = active.filter(game => view.selectedIds.includes(game.id));
  const toggle = (id: string) => onViewChange({ selectedIds: view.selectedIds.includes(id)
    ? view.selectedIds.filter(item => item !== id) : [...view.selectedIds, id] });
  const select = (game: Game) => !view.removed && <input type="checkbox" aria-label={t('games.select', { name: gameName(game) })}
    checked={view.selectedIds.includes(game.id)} disabled={busy} onChange={() => toggle(game.id)}/>;
  return <div className="all-games" data-layout={view.layout}>
    <div className="page-heading standalone"><div className="eyebrow">A HOME FOR EVERY WORLD.</div><h1>{t('games.headingTitle')}</h1><p>{t('games.headingDesc')}</p></div>
    <div className="management-actions">
      <button className="button primary" disabled={busy} onClick={onAdd}><Plus size={16}/>{t('games.add')}</button>
      <button className="button secondary" disabled={busy} onClick={onImport}><Upload size={16}/>{t('games.import')}</button>
      <button className="button secondary" disabled={busy || !active.length} onClick={() => onExport(selection.length ? selection : active)}><Download size={16}/>{t(selection.length ? 'games.exportSelected' : 'games.exportAll')}</button>
      <div className="game-view-switch" role="group" aria-label={t('games.viewMode')}>
        <button aria-pressed={view.layout === 'cards'} onClick={() => onViewChange({ layout: 'cards' })}><LayoutGrid size={16}/>{t('games.cardView')}</button>
        <button aria-pressed={view.layout === 'list'} onClick={() => onViewChange({ layout: 'list' })}><List size={16}/>{t('games.listView')}</button>
      </div>
      <span>{t(selection.length ? 'games.selected' : 'games.count', { count: selection.length || active.length })}</span>
    </div>
    <div className="management-filters">
      <div className="management-tabs" role="group" aria-label={t('sidebar.allGames')}>
        <button aria-pressed={!view.removed} onClick={() => onViewChange({ removed: false })}>{t('games.active')} <span>{active.length}</span></button>
        <button aria-pressed={view.removed} onClick={() => onViewChange({ removed: true })}>{t('games.removed')} <span>{games.length - active.length}</span></button>
      </div>
      <label className="management-search"><Search size={16}/><input aria-label={t('games.search')} placeholder={t('games.search')} value={view.query} onChange={event => onViewChange({ query: event.target.value })}/></label>
    </div>
    <p className="muted small-text management-hint">{t('games.recordHint')}</p>
    {!view.removed && shown.length > 0 && <label className="confirm-checkbox management-select-all"><input type="checkbox" disabled={busy} checked={shown.every(game => view.selectedIds.includes(game.id))}
      onChange={event => onViewChange({ selectedIds: event.target.checked ? [...new Set([...view.selectedIds, ...shown.map(game => game.id)])]
        : view.selectedIds.filter(id => !shown.some(game => game.id === id)) })}/>{t('games.selectAll')}</label>}
    {view.layout === 'cards' ? <div className="game-grid">{shown.map(game => <article className="game-card catalog-game" key={game.id} data-game-id={game.id}>
      <div className="game-card-art"><Landscape kind={game.icon}/><span className="game-card-symbol"><GameGlyph icon={game.icon} size={28}/></span>
        {!view.removed && <><label className="catalog-selection">{select(game)}</label><button className="icon-button" aria-label={t('games.edit', { name: gameName(game) })} title={t('games.edit', { name: gameName(game) })} disabled={busy} onClick={() => onEdit(game)}><Settings2 size={17}/></button></>}
      </div>
      <div className="game-card-body"><span className="eyebrow">{game.subtitle || 'YOUR OWN WORLD'}</span><h2>{gameName(game)}</h2>
        <p><span className={'status-dot' + (game.pathStatus !== 'ready' ? ' warning' : '')}/>{t(game.pathStatus === 'ready' ? 'games.statusReady' : 'games.statusRequired')}<span>{t('sidebar.gameSaveCount', { count: game.snapshots.filter(save => !save.deletedAt).length })}</span></p>
        <small className="catalog-records">{recordSummary(game)}</small>
        {pending(game) && <strong className="danger-text catalog-records">{t('games.pending')}</strong>}
        {!view.removed && <button className="button secondary" disabled={busy} onClick={() => onOpen(game.id)}>{t('games.openLibrary')}<ArrowRight size={15}/></button>}
        <div className="game-card-actions"><Actions game={game} card {...actions}/></div>
      </div>
    </article>)}{!view.removed && !view.query.trim() && <button className="new-game-card" disabled={busy} onClick={onAdd}><span><Plus size={25}/></span><strong>{t('games.nextWorld')}</strong><p>{t('games.addFavoriteGame')}</p></button>}</div>
      : <div className="management-list">{shown.map(game => <article className="management-game catalog-game" key={game.id} data-game-id={game.id}>
        {select(game)}<span className="game-glyph" style={{ '--game-color': game.color } as CSSProperties}><GameGlyph icon={game.icon} size={24}/></span>
        <div className="management-game-info"><h2>{gameName(game)}</h2><p>{game.subtitle || 'YOUR OWN WORLD'}</p><code title={game.locations[platform].root}>{game.locations[platform].root || t('games.missingPath')}</code><small>{recordSummary(game)}</small>{pending(game) && <strong className="danger-text">{t('games.pending')}</strong>}</div>
        <div className="management-game-actions"><Actions game={game} {...actions}/></div>
      </article>)}</div>}
    {!shown.length && <div className="quiet-empty">{t('games.empty')}</div>}
  </div>;
}

function Actions({ game, card, busy, onOpen, onEdit, onExport, onDelete, onRecover }: GameActions & { game: Game; card?: boolean }) {
  return <>{game.deletedAt ? <button className="button secondary small" disabled={busy} onClick={() => pending(game) ? onDelete(game) : onRecover(game)}><RotateCcw size={14}/>{t(pending(game) ? 'games.retry' : 'games.restore')}</button>
    : <>{!card && <><button className="button secondary small" disabled={busy} onClick={() => onOpen(game.id)}><FolderOpen size={14}/>{t('games.open')}</button><button className="icon-button" aria-label={t('games.edit', { name: gameName(game) })} title={t('games.edit', { name: gameName(game) })} disabled={busy} onClick={() => onEdit(game)}><Settings2 size={17}/></button></>}
      <button className="icon-button" aria-label={t('games.exportOne', { name: gameName(game) })} title={t('games.export')} disabled={busy} onClick={() => onExport([game])}><Download size={17}/></button></>}
    {!pending(game) && <button className="icon-button danger-text" aria-label={t('games.delete', { name: gameName(game) })} title={t('games.deleteTitle')} disabled={busy} onClick={() => onDelete(game)}><Trash2 size={17}/></button>}
  </>;
}
