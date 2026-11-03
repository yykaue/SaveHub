import { useEffect, useRef, useState } from 'react';
import { Archive, ArrowDown, ArrowRight, ArrowUp, ArrowUpDown, Download, FileBox, FolderOpen, History, Info, MoreHorizontal, Pencil, RotateCcw, Search, ShieldCheck, ShieldOff, Star, Trash2, Upload, X } from 'lucide-react';
import { dateLabel, formatBytes, kindLabel } from './format';
import { getLanguageMeta, t } from './i18n';
import type { Game, Snapshot } from './types';

export type Filter = 'all' | 'favorite' | 'protected' | 'trash';
export type SortKey = 'label' | 'createdAt' | 'bytes';
export interface LibraryView { filter: Filter; query: string; sort: { key: SortKey; direction: 'asc' | 'desc' }; selectedIds: string[] }
export const defaultView: LibraryView = { filter: 'all', query: '', sort: { key: 'createdAt', direction: 'desc' }, selectedIds: [] };
export type SnapshotAction = 'detail' | 'edit' | 'verify' | 'export' | 'delete' | 'favorite' | 'protect' | 'restore' | 'recover';
const getFilterLabels = (): Record<Filter, string> => ({
  all: t('snapshots.filterAll'),
  favorite: t('snapshots.filterFavorite'),
  protected: t('snapshots.filterProtected'),
  trash: t('snapshots.filterTrash'),
});

export function matchesFilter(snapshot: Snapshot, filter: Filter) {
  if (snapshot.kind === 'safety') return false;
  if (filter === 'trash') return Boolean(snapshot.deletedAt);
  if (snapshot.deletedAt) return false;
  if (filter === 'favorite') return Boolean(snapshot.favorite);
  if (filter === 'protected') return Boolean(snapshot.protected);
  return true;
}

export function SnapshotList({ game, view, busy, menu, onMenu, onViewChange, onAction, onImport, onFolder, onCreate, onRestorePoints, onExport, onDelete, onRecover, onProtect }: {
  game: Game; view: LibraryView; busy: boolean; menu: string | null;
  onMenu: (id: string | null) => void; onViewChange: (changes: Partial<LibraryView>) => void;
  onAction: (action: SnapshotAction, snapshot: Snapshot) => void;
  onImport: (legacy?: boolean) => void; onFolder: () => void; onCreate: () => void; onRestorePoints: () => void;
  onExport: (ids: string[]) => void; onDelete: (snapshots: Snapshot[]) => void; onRecover: (ids: string[]) => void;
  onProtect: (ids: string[], protectedTag: boolean) => void;
}) {
  const { filter, query, sort } = view;
  const [menuAbove, setMenuAbove] = useState(false);
  const filterLabels = getFilterLabels();
  const saves = game.snapshots.filter(snapshot => !snapshot.deletedAt);
  const tabSnapshots = game.snapshots.filter(snapshot => matchesFilter(snapshot, filter));
  const tabScope = t('snapshots.tabScopeDesc', { tab: filterLabels[filter], count: tabSnapshots.length });
  const locale = getLanguageMeta().dateLocale;
  const list = tabSnapshots.filter(snapshot => `${snapshot.label} ${snapshot.note || ''}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => {
    let comparison;
    if (sort.key === 'label') comparison = a.label.localeCompare(b.label, locale, { numeric: true, sensitivity: 'base' });
    else if (sort.key === 'bytes') comparison = a.bytes - b.bytes;
    else comparison = a.createdAt.localeCompare(b.createdAt);
    return comparison * (sort.direction === 'asc' ? 1 : -1) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
  });
  const selectable = list.filter(snapshot => !snapshot.corrupted);
  const selected = selectable.filter(snapshot => view.selectedIds.includes(snapshot.id));
  const allSelected = selectable.length > 0 && selected.length === selectable.length;
  const ordinaryCount = game.snapshots.filter(snapshot => matchesFilter(snapshot, 'all')).length;
  const selectedProtected = selected.filter(snapshot => snapshot.protected).length;
  const selectedPending = selected.some(snapshot => snapshot.purgePending);
  const selectedTrashed = selected.some(snapshot => snapshot.deletedAt);
  const protectSelected = !selected.length || selectedProtected !== selected.length;
  const protectAll = !tabSnapshots.length || !tabSnapshots.every(snapshot => snapshot.protected);
  const nextDirection = (key: SortKey) => key === sort.key ? sort.direction === 'asc' ? 'desc' : 'asc' : key === 'createdAt' ? 'desc' : 'asc';
  const changeSort = (key: SortKey) => onViewChange({ sort: { key, direction: nextDirection(key) } });
  const selectRow = (snapshot: Snapshot) => onViewChange({ selectedIds: view.selectedIds.includes(snapshot.id) ? view.selectedIds.filter(id => id !== snapshot.id) : [...view.selectedIds, snapshot.id] });
  const action = (name: SnapshotAction, snapshot: Snapshot) => { onMenu(null); onAction(name, snapshot); };
  const column = (key: SortKey, label: string) => <div role="columnheader" aria-sort={sort.key === key ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
    <button className={`sort-heading ${sort.key === key ? 'sorted' : ''}`} onClick={() => changeSort(key)} aria-label={t('snapshots.sortAria', { label })} title={t(nextDirection(key) === 'desc' ? 'snapshots.sortDescTitle' : 'snapshots.sortAscTitle', { label })}>
      {label}{sort.key !== key ? <ArrowUpDown size={12}/> : sort.direction === 'asc' ? <ArrowUp size={12}/> : <ArrowDown size={12}/>}
    </button>
  </div>;
  const menus = (snapshot: Snapshot) => <div className={`dropdown ${menuAbove ? 'above' : ''}`} role="menu" onClick={event => event.stopPropagation()}>
    <button role="menuitem" onClick={() => action('detail', snapshot)}><Info size={15}/>{t('snapshots.menuDetail')}</button>
    <button role="menuitem" disabled={snapshot.corrupted || snapshot.purgePending || busy} onClick={() => action('edit', snapshot)}><Pencil size={15}/>{t('snapshots.menuEdit')}</button>
    <button role="menuitem" disabled={!!snapshot.deletedAt || snapshot.corrupted || snapshot.purgePending || busy} title={snapshot.deletedAt ? t('snapshots.recoverFromTrashBeforeProtectTitle') : undefined} onClick={() => action('protect', snapshot)}><ShieldCheck size={15}/>{snapshot.protected ? t('snapshots.menuUnprotect') : t('snapshots.menuProtect')}</button>
    <button role="menuitem" disabled={snapshot.corrupted || snapshot.purgePending || busy} onClick={() => action('verify', snapshot)}><ShieldCheck size={15}/>{t('snapshots.menuVerify')}</button>
    <button role="menuitem" disabled={snapshot.corrupted || snapshot.purgePending || busy} onClick={() => action('export', snapshot)}><Download size={15}/>{t('snapshots.menuExport')}</button>
    <div className="menu-divider"/>
    {snapshot.deletedAt && <button role="menuitem" disabled={snapshot.corrupted || snapshot.purgePending || busy} onClick={() => action('recover', snapshot)}><RotateCcw size={15}/>{t('snapshots.menuRecover')}</button>}
    <button role="menuitem" className="danger-text" disabled={snapshot.corrupted || busy || snapshot.protected} title={snapshot.protected ? t('snapshots.menuDeleteProtectedTitle') : undefined} onClick={() => action('delete', snapshot)}><Trash2 size={15}/>{snapshot.deletedAt ? t('snapshots.menuDeletePermanently') : t('snapshots.menuMoveToTrash')}</button>
  </div>;

  return <section className="snapshots-section">
    <div className="section-heading">
      <div><h2>{t('snapshots.sectionTitle')} <span>{String(ordinaryCount).padStart(2, '0')}</span></h2><p>{t('snapshots.sectionDesc')}</p></div>
      <div className="section-actions">
        <button className="text-button" disabled={busy} onClick={onRestorePoints}><History size={15}/>{t('snapshots.restorePointsBtn')} <span className="count-pill">{game.restorePoints.filter(point => !point.deletedAt).length}</span></button>
        <button className="text-button" disabled={busy} onClick={() => onImport(false)}><Upload size={15}/>{t('snapshots.importSavesBtn')}</button>
        <button className="icon-button" title={t('snapshots.openBackupFolder')} aria-label={t('snapshots.openBackupFolder')} onClick={onFolder}><FolderOpen size={17}/></button>
      </div>
    </div>
    <div className="list-toolbar">
      <div className="filter-tabs" role="tablist" aria-label={t('snapshots.filterAria')}>{([{ id: 'all', text: filterLabels.all }, { id: 'favorite', text: filterLabels.favorite }, { id: 'protected', text: filterLabels.protected }, { id: 'trash', text: filterLabels.trash }] as const).map(tab =>
        <button role="tab" aria-label={tab.text} aria-selected={filter === tab.id} className={filter === tab.id ? 'active' : ''} key={tab.id} onClick={() => onViewChange({ filter: tab.id, selectedIds: [] })}>
          {tab.id === 'favorite' && <Star size={13}/>} {tab.text}<span>{game.snapshots.filter(snapshot => matchesFilter(snapshot, tab.id)).length}</span>
        </button>)}</div>
      <label className="search-field"><Search size={15}/><input placeholder={t('snapshots.searchPlaceholder')} aria-label={t('snapshots.searchAria')} value={query} onChange={event => onViewChange({ query: event.target.value, selectedIds: [] })}/>{query && <button title={t('snapshots.clearSearchTitle')} onClick={() => onViewChange({ query: '', selectedIds: [] })}><X size={13}/></button>}</label>
    </div>
    <div className={`batch-toolbar ${selected.length ? 'has-selection' : ''}`}>
      <span className="selection-summary" aria-live="polite">{selected.length ? <>{t('snapshots.batchSelectedPrefix')}<strong>{selected.length}</strong>{t('snapshots.batchSelectedSuffix')}{selectedProtected > 0 && (filter === 'trash' ? t('snapshots.batchProtectedTrashHint') : t('snapshots.batchProtectedHint'))}</> : filter === 'trash' ? t('snapshots.batchIdleTrashHint') : t('snapshots.batchIdleHint')}</span>
      {selected.length > 0 && <button className="text-button clear-selection" disabled={busy} onClick={() => onViewChange({ selectedIds: [] })}>{t('snapshots.clearSelection')}</button>}
      <div className="batch-actions">
        {filter !== 'trash' && <button className={`button secondary small protection-action ${protectSelected ? 'protect' : 'unprotect'}`} disabled={!selected.length || selectedTrashed || selectedPending || busy} title={selectedTrashed ? t('snapshots.recoverFromTrashBeforeProtectTitle') : undefined} onClick={() => onProtect(selected.map(snapshot => snapshot.id), protectSelected)}>{protectSelected ? <ShieldCheck size={14}/> : <ShieldOff size={14}/>}{protectSelected ? t('snapshots.protectSelected') : t('snapshots.unprotectSelected')}</button>}
        {filter !== 'trash' && <button className={`button secondary small protection-action ${protectAll ? 'protect' : 'unprotect'}`} disabled={!tabSnapshots.length || busy} title={t(protectAll ? 'snapshots.protectAllTitle' : 'snapshots.unprotectAllTitle', { scope: tabScope })} onClick={() => onProtect(tabSnapshots.map(snapshot => snapshot.id), protectAll)}>{protectAll ? <ShieldCheck size={14}/> : <ShieldOff size={14}/>}{protectAll ? t('snapshots.protectAll') : t('snapshots.unprotectAll')}</button>}
        {filter === 'trash' && <button className="button secondary small" disabled={!selected.length || selectedPending || busy} onClick={() => onRecover(selected.map(snapshot => snapshot.id))}><RotateCcw size={14}/>{t('snapshots.recoverSelected')}</button>}
        <button className="button secondary small danger-text" disabled={!selected.length || busy || selectedProtected > 0} title={selectedProtected ? t('snapshots.deleteSelectedProtectedTitle') : undefined} onClick={() => onDelete(selected)}><Trash2 size={14}/>{filter === 'trash' ? t('snapshots.deletePermanentlySelected') : t('snapshots.deleteSelected')}</button>
        <button className="button secondary small" disabled={!selected.length || selectedPending || busy} onClick={() => onExport(selected.map(snapshot => snapshot.id))}><Download size={14}/>{t('snapshots.exportSelected')}</button>
        <button className="button secondary small export-all" disabled={!tabSnapshots.length || busy} title={t('snapshots.exportAllTitle', { scope: tabScope })} onClick={() => onExport(tabSnapshots.map(snapshot => snapshot.id))}><Download size={14}/>{t('snapshots.exportAll')}</button>
      </div>
    </div>
    <div className="snapshot-results">
      {game.legacyCount > 0 && !saves.some(snapshot => snapshot.kind === 'imported') && filter === 'all' && !query && <div className="import-banner"><div className="import-icon"><History size={19}/></div><div><strong>{t('snapshots.legacyBannerTitle')}</strong><p>{t('snapshots.legacyBannerDesc', { count: game.legacyCount })}</p></div><button disabled={busy} onClick={() => onImport(true)}>{t('snapshots.importLegacyBtn')}<ArrowRight size={15}/></button></div>}
      {list.length > 0 ? <div className="snapshot-table" role="table" aria-label={t('snapshots.tableAria')}>
        <div className="table-header" role="row">
          <div role="columnheader"><SelectionCheckbox checked={allSelected} mixed={selected.length > 0 && !allSelected} disabled={!selectable.length || busy} label={t('snapshots.selectAllCurrent')} onChange={() => onViewChange({ selectedIds: allSelected ? [] : selectable.map(snapshot => snapshot.id) })}/></div>
          {column('label', t('snapshots.colName'))}{column('createdAt', t('snapshots.colCreatedAt'))}{column('bytes', t('snapshots.colSize'))}<div role="columnheader" className="table-end">{t('snapshots.colActions')}</div>
        </div>
        {list.map(snapshot => <div className={`snapshot-row ${snapshot.corrupted ? 'corrupt' : ''} ${view.selectedIds.includes(snapshot.id) ? 'row-selected' : ''}`} key={snapshot.id} role="row" data-snapshot-id={snapshot.id}>
          <div role="cell"><SelectionCheckbox checked={view.selectedIds.includes(snapshot.id)} disabled={snapshot.corrupted || busy} label={t('snapshots.selectRowAria', { label: snapshot.label })} onChange={() => selectRow(snapshot)}/></div>
          <div className="snapshot-info" role="cell"><div className={`snapshot-icon ${snapshot.protected ? 'protected' : snapshot.kind}`}>{snapshot.protected ? <ShieldCheck size={20}/> : snapshot.kind === 'imported' ? <FileBox size={20}/> : <Archive size={20}/>}</div><div className="snapshot-name-block"><button className="snapshot-name" onClick={() => action('detail', snapshot)}>{snapshot.label}{snapshot.favorite && <Star size={12} className="star-filled"/>}</button><div className="snapshot-sub"><span className={`kind-badge ${snapshot.kind}`}>{snapshot.corrupted ? t('snapshots.badgeCorrupted') : kindLabel(snapshot.kind)}</span>{snapshot.protected && <span className="state-tag protected">{t('snapshots.badgeProtected')}</span>}{snapshot.deletedAt && <span className="state-tag trashed">{t('snapshots.badgeTrash')}</span>}{snapshot.purgePending && <span className="state-tag danger-text">{t('snapshots.badgePurgePending')}</span>}<span className="snapshot-note">{snapshot.note || t('snapshots.defaultNote')}</span></div></div></div>
          <div className="snapshot-time" role="cell" title={snapshot.createdAt}>{dateLabel(snapshot.createdAt)}<small>{snapshot.platform === 'darwin' ? 'macOS' : 'Windows'}</small></div>
          <div className="snapshot-size" role="cell" data-bytes={snapshot.bytes}>{formatBytes(snapshot.bytes)}<small>{t('snapshots.fileCount', { count: snapshot.fileCount })}</small></div>
          <div className="snapshot-actions" role="cell">{snapshot.deletedAt ? <button className="load-button" disabled={busy || snapshot.corrupted || snapshot.purgePending} onClick={() => action('recover', snapshot)}><RotateCcw size={14}/>{t('snapshots.recoverBtn')}</button> : <>
            <button className={`icon-button favorite-button ${snapshot.favorite ? 'is-favorite' : ''}`} aria-label={t(snapshot.favorite ? 'snapshots.unfavoriteAria' : 'snapshots.favoriteAria', { label: snapshot.label })} title={snapshot.favorite ? t('snapshots.unfavoriteTitle') : t('snapshots.favoriteTitle')} disabled={snapshot.corrupted || snapshot.purgePending || busy} onClick={() => action('favorite', snapshot)}><Star size={16}/></button>
            <button className="load-button" disabled={snapshot.corrupted || busy || game.pathStatus !== 'ready'} onClick={() => action('restore', snapshot)}><RotateCcw size={14}/>{t('snapshots.loadBtn')}</button>
          </>}<div className="menu-anchor"><button className="icon-button" aria-label={t('snapshots.moreActionsAria', { label: snapshot.label })} aria-expanded={menu === snapshot.id} title={t('snapshots.moreActionsTitle')} onClick={event => { event.stopPropagation(); setMenuAbove(event.currentTarget.getBoundingClientRect().bottom + 290 > window.innerHeight); onMenu(menu === snapshot.id ? null : snapshot.id); }}><MoreHorizontal size={19}/></button>{menu === snapshot.id && menus(snapshot)}</div></div>
        </div>)}
      </div> : <div className="empty-state"><div className="empty-orbit"><Archive size={29}/><span/><i/></div><h3>{query ? t('snapshots.emptySearchTitle') : filter === 'trash' ? t('snapshots.emptyTrashTitle') : filter === 'favorite' ? t('snapshots.emptyFavoriteTitle') : filter === 'protected' ? t('snapshots.emptyProtectedTitle') : t('snapshots.emptyAllTitle')}</h3><p>{query ? t('snapshots.emptySearchDesc') : filter === 'trash' ? t('snapshots.emptyTrashDesc') : filter === 'favorite' ? t('snapshots.emptyFavoriteDesc') : filter === 'protected' ? t('snapshots.emptyProtectedDesc') : t('snapshots.emptyAllDesc')}</p>{filter === 'all' && !query && <button className="button secondary" disabled={busy} onClick={onCreate}><PlusIcon/>{t('snapshots.createFirstSave')}</button>}{query && <button className="text-button" onClick={() => onViewChange({ query: '', selectedIds: [] })}>{t('snapshots.clearSearchBtn')}</button>}</div>}
    </div>
    <div className="list-footnote"><ShieldCheck size={14}/><span>{t('snapshots.footnoteLeft')}</span><span className="footnote-right">{t('snapshots.footnoteRight', { count: list.length })}</span></div>
  </section>;
}

export function SelectionCheckbox({ checked, mixed = false, disabled, label, onChange }: { checked: boolean; mixed?: boolean; disabled?: boolean; label: string; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <label className="selection-checkbox"><input ref={ref} type="checkbox" checked={checked} aria-label={label} aria-checked={mixed ? 'mixed' : checked} disabled={disabled} onChange={onChange}/></label>;
}

function PlusIcon() { return <span aria-hidden="true" className="plus-icon">＋</span>; }
