import { useEffect, useRef, useState } from 'react';
import { Archive, ArrowDown, ArrowRight, ArrowUp, ArrowUpDown, Download, FileBox, FolderOpen, History, Info, MoreHorizontal, Pencil, RotateCcw, Search, ShieldCheck, ShieldOff, Star, Trash2, Upload, X } from 'lucide-react';
import { dateLabel, formatBytes, getFormatLanguage, kindLabel, tr } from './format';
import type { Game, Snapshot } from './types';

export type Filter = 'all' | 'favorite' | 'protected' | 'trash';
export type SortKey = 'label' | 'createdAt' | 'bytes';
export interface LibraryView { filter: Filter; query: string; sort: { key: SortKey; direction: 'asc' | 'desc' }; selectedIds: string[] }
export const defaultView: LibraryView = { filter: 'all', query: '', sort: { key: 'createdAt', direction: 'desc' }, selectedIds: [] };
export type SnapshotAction = 'detail' | 'edit' | 'verify' | 'export' | 'delete' | 'favorite' | 'protect' | 'restore' | 'recover';
const getFilterLabels = (): Record<Filter, string> => ({
  all: tr('全部存档', 'All Saves'),
  favorite: tr('已收藏', 'Favorites'),
  protected: tr('保护存档', 'Protected'),
  trash: tr('回收站', 'Trash'),
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
  const tabScope = tr(`「${filterLabels[filter]}」标签页的全部 ${tabSnapshots.length} 份存档，不受搜索影响`, `all ${tabSnapshots.length} save(s) in the "${filterLabels[filter]}" tab, regardless of search`);
  const locale = getFormatLanguage() === 'en' ? 'en' : 'zh-CN';
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
    <button className={`sort-heading ${sort.key === key ? 'sorted' : ''}`} onClick={() => changeSort(key)} aria-label={tr(`${label}排序`, `Sort by ${label}`)} title={tr(`按${label}${nextDirection(key) === 'desc' ? '倒序' : '正序'}排列`, `Sort by ${label} (${nextDirection(key) === 'desc' ? 'descending' : 'ascending'})`)}>
      {label}{sort.key !== key ? <ArrowUpDown size={12}/> : sort.direction === 'asc' ? <ArrowUp size={12}/> : <ArrowDown size={12}/>}
    </button>
  </div>;
  const menus = (snapshot: Snapshot) => <div className={`dropdown ${menuAbove ? 'above' : ''}`} role="menu" onClick={event => event.stopPropagation()}>
    <button role="menuitem" onClick={() => action('detail', snapshot)}><Info size={15}/>{tr('存档详情', 'Save Details')}</button>
    <button role="menuitem" disabled={snapshot.corrupted || snapshot.purgePending || busy} onClick={() => action('edit', snapshot)}><Pencil size={15}/>{tr('编辑名称和备注', 'Edit Name & Note')}</button>
    <button role="menuitem" disabled={!!snapshot.deletedAt || snapshot.corrupted || snapshot.purgePending || busy} title={snapshot.deletedAt ? tr('请先找回存档，再修改保护标记', 'Recover this save from Trash before changing protection') : undefined} onClick={() => action('protect', snapshot)}><ShieldCheck size={15}/>{snapshot.protected ? tr('取消保护标记', 'Remove Protection') : tr('标记为保护存档', 'Mark as Protected')}</button>
    <button role="menuitem" disabled={snapshot.corrupted || snapshot.purgePending || busy} onClick={() => action('verify', snapshot)}><ShieldCheck size={15}/>{tr('校验完整性', 'Verify Integrity')}</button>
    <button role="menuitem" disabled={snapshot.corrupted || snapshot.purgePending || busy} onClick={() => action('export', snapshot)}><Download size={15}/>{tr('导出存档', 'Export Save')}</button>
    <div className="menu-divider"/>
    {snapshot.deletedAt && <button role="menuitem" disabled={snapshot.corrupted || snapshot.purgePending || busy} onClick={() => action('recover', snapshot)}><RotateCcw size={15}/>{tr('找回存档', 'Recover Save')}</button>}
    <button role="menuitem" className="danger-text" disabled={snapshot.corrupted || busy || snapshot.protected} title={snapshot.protected ? tr('保护存档不可删除，请先取消保护标记', 'Protected saves cannot be deleted. Unprotect first.') : undefined} onClick={() => action('delete', snapshot)}><Trash2 size={15}/>{snapshot.deletedAt ? tr('永久删除', 'Delete Permanently') : tr('移入回收站', 'Move to Trash')}</button>
  </div>;

  return <section className="snapshots-section">
    <div className="section-heading">
      <div><h2>{tr('存档时光轴', 'Save Timeline')} <span>{String(ordinaryCount).padStart(2, '0')}</span></h2><p>{tr('收藏用于标记；保护存档需先取消保护才能删除。', 'Favorites are for starring; protected saves must be unprotected before deletion.')}</p></div>
      <div className="section-actions">
        <button className="text-button" disabled={busy} onClick={onRestorePoints}><History size={15}/>{tr('读档恢复点', 'Restore Points')} <span className="count-pill">{game.restorePoints.filter(point => !point.deletedAt).length}</span></button>
        <button className="text-button" disabled={busy} onClick={() => onImport(false)}><Upload size={15}/>{tr('导入存档', 'Import Saves')}</button>
        <button className="icon-button" title={tr('打开备份文件夹', 'Open Backup Folder')} aria-label={tr('打开备份文件夹', 'Open Backup Folder')} onClick={onFolder}><FolderOpen size={17}/></button>
      </div>
    </div>
    <div className="list-toolbar">
      <div className="filter-tabs" role="tablist" aria-label={tr('存档筛选', 'Filter saves')}>{([{ id: 'all', text: filterLabels.all }, { id: 'favorite', text: filterLabels.favorite }, { id: 'protected', text: filterLabels.protected }, { id: 'trash', text: filterLabels.trash }] as const).map(tab =>
        <button role="tab" aria-label={tab.text} aria-selected={filter === tab.id} className={filter === tab.id ? 'active' : ''} key={tab.id} onClick={() => onViewChange({ filter: tab.id, selectedIds: [] })}>
          {tab.id === 'favorite' && <Star size={13}/>} {tab.text}<span>{game.snapshots.filter(snapshot => matchesFilter(snapshot, tab.id)).length}</span>
        </button>)}</div>
      <label className="search-field"><Search size={15}/><input placeholder={tr('搜索名称或备注…', 'Search name or notes…')} aria-label={tr('搜索存档', 'Search saves')} value={query} onChange={event => onViewChange({ query: event.target.value, selectedIds: [] })}/>{query && <button title={tr('清空搜索', 'Clear search')} onClick={() => onViewChange({ query: '', selectedIds: [] })}><X size={13}/></button>}</label>
    </div>
    <div className={`batch-toolbar ${selected.length ? 'has-selection' : ''}`}>
      <span className="selection-summary" aria-live="polite">{selected.length ? <>{tr('已选 ', 'Selected ')}<strong>{selected.length}</strong>{tr(' 份', '')}{selectedProtected > 0 && (filter === 'trash' ? tr(' · 含保护存档，需找回并取消保护后才能删除', ' · Includes protected saves (recover and unprotect to delete)') : tr(' · 含保护存档，删除前需取消保护', ' · Includes protected saves (unprotect to delete)'))}</> : filter === 'trash' ? tr('勾选存档，可批量找回、永久删除或导出', 'Select saves to batch recover, permanently delete, or export') : tr('勾选存档，可批量保护、删除或导出', 'Select saves to batch protect, delete, or export')}</span>
      {selected.length > 0 && <button className="text-button clear-selection" disabled={busy} onClick={() => onViewChange({ selectedIds: [] })}>{tr('取消选择', 'Clear Selection')}</button>}
      <div className="batch-actions">
        {filter !== 'trash' && <button className={`button secondary small protection-action ${protectSelected ? 'protect' : 'unprotect'}`} disabled={!selected.length || selectedTrashed || selectedPending || busy} title={selectedTrashed ? tr('请先找回存档，再修改保护标记', 'Recover saves from Trash before changing protection') : undefined} onClick={() => onProtect(selected.map(snapshot => snapshot.id), protectSelected)}>{protectSelected ? <ShieldCheck size={14}/> : <ShieldOff size={14}/>}{protectSelected ? tr('所选保护', 'Protect Selected') : tr('所选取消保护', 'Unprotect Selected')}</button>}
        {filter !== 'trash' && <button className={`button secondary small protection-action ${protectAll ? 'protect' : 'unprotect'}`} disabled={!tabSnapshots.length || busy} title={tr(`${protectAll ? '保护' : '取消保护'}${tabScope}。`, `${protectAll ? 'Protect' : 'Unprotect'} ${tabScope}.`)} onClick={() => onProtect(tabSnapshots.map(snapshot => snapshot.id), protectAll)}>{protectAll ? <ShieldCheck size={14}/> : <ShieldOff size={14}/>}{protectAll ? tr('全部保护', 'Protect All') : tr('全部取消保护', 'Unprotect All')}</button>}
        {filter === 'trash' && <button className="button secondary small" disabled={!selected.length || selectedPending || busy} onClick={() => onRecover(selected.map(snapshot => snapshot.id))}><RotateCcw size={14}/>{tr('找回所选', 'Recover Selected')}</button>}
        <button className="button secondary small danger-text" disabled={!selected.length || busy || selectedProtected > 0} title={selectedProtected ? tr('所选记录含保护存档，请先取消保护标记', 'Selection includes protected saves. Unprotect them first.') : undefined} onClick={() => onDelete(selected)}><Trash2 size={14}/>{filter === 'trash' ? tr('永久删除所选', 'Delete Permanently') : tr('删除所选', 'Delete Selected')}</button>
        <button className="button secondary small" disabled={!selected.length || selectedPending || busy} onClick={() => onExport(selected.map(snapshot => snapshot.id))}><Download size={14}/>{tr('导出所选', 'Export Selected')}</button>
        <button className="button secondary small export-all" disabled={!tabSnapshots.length || busy} title={tr(`导出${tabScope}。`, `Export ${tabScope}.`)} onClick={() => onExport(tabSnapshots.map(snapshot => snapshot.id))}><Download size={14}/>{tr('导出全部', 'Export All')}</button>
      </div>
    </div>
    <div className="snapshot-results">
      {game.legacyCount > 0 && !saves.some(snapshot => snapshot.kind === 'imported') && filter === 'all' && !query && <div className="import-banner"><div className="import-icon"><History size={19}/></div><div><strong>{tr('让过去的冒险，也有归处', 'Bring Your Past Adventures Home')}</strong><p>{tr(`发现 ${game.legacyCount} 个旧存档目录，可从 ArchiveFile 导入。`, `Found ${game.legacyCount} legacy save folder(s) ready to import from ArchiveFile.`)}</p></div><button disabled={busy} onClick={() => onImport(true)}>{tr('导入旧存档', 'Import Legacy Saves')}<ArrowRight size={15}/></button></div>}
      {list.length > 0 ? <div className="snapshot-table" role="table" aria-label={tr('游戏存档列表', 'Game saves list')}>
        <div className="table-header" role="row">
          <div role="columnheader"><SelectionCheckbox checked={allSelected} mixed={selected.length > 0 && !allSelected} disabled={!selectable.length || busy} label={tr('全选当前列表', 'Select all in current list')} onChange={() => onViewChange({ selectedIds: allSelected ? [] : selectable.map(snapshot => snapshot.id) })}/></div>
          {column('label', tr('存档名称', 'Save Name'))}{column('createdAt', tr('创建时间', 'Created'))}{column('bytes', tr('文件大小', 'Size'))}<div role="columnheader" className="table-end">{tr('操作', 'Actions')}</div>
        </div>
        {list.map(snapshot => <div className={`snapshot-row ${snapshot.corrupted ? 'corrupt' : ''} ${view.selectedIds.includes(snapshot.id) ? 'row-selected' : ''}`} key={snapshot.id} role="row" data-snapshot-id={snapshot.id}>
          <div role="cell"><SelectionCheckbox checked={view.selectedIds.includes(snapshot.id)} disabled={snapshot.corrupted || busy} label={tr(`选择 ${snapshot.label}`, `Select ${snapshot.label}`)} onChange={() => selectRow(snapshot)}/></div>
          <div className="snapshot-info" role="cell"><div className={`snapshot-icon ${snapshot.protected ? 'protected' : snapshot.kind}`}>{snapshot.protected ? <ShieldCheck size={20}/> : snapshot.kind === 'imported' ? <FileBox size={20}/> : <Archive size={20}/>}</div><div className="snapshot-name-block"><button className="snapshot-name" onClick={() => action('detail', snapshot)}>{snapshot.label}{snapshot.favorite && <Star size={12} className="star-filled"/>}</button><div className="snapshot-sub"><span className={`kind-badge ${snapshot.kind}`}>{snapshot.corrupted ? tr('校验异常', 'Corrupted') : kindLabel(snapshot.kind)}</span>{snapshot.protected && <span className="state-tag protected">{tr('保护', 'Protected')}</span>}{snapshot.deletedAt && <span className="state-tag trashed">{tr('回收站', 'Trash')}</span>}{snapshot.purgePending && <span className="state-tag danger-text">{tr('永久删除未完成', 'Pending Deletion')}</span>}<span className="snapshot-note">{snapshot.note || tr('这一刻，已为你妥善保留。', 'This moment is safely preserved for you.')}</span></div></div></div>
          <div className="snapshot-time" role="cell" title={snapshot.createdAt}>{dateLabel(snapshot.createdAt)}<small>{snapshot.platform === 'darwin' ? 'macOS' : 'Windows'}</small></div>
          <div className="snapshot-size" role="cell" data-bytes={snapshot.bytes}>{formatBytes(snapshot.bytes)}<small>{tr(`${snapshot.fileCount} 个文件`, `${snapshot.fileCount} file(s)`)}</small></div>
          <div className="snapshot-actions" role="cell">{snapshot.deletedAt ? <button className="load-button" disabled={busy || snapshot.corrupted || snapshot.purgePending} onClick={() => action('recover', snapshot)}><RotateCcw size={14}/>{tr('找回', 'Recover')}</button> : <>
            <button className={`icon-button favorite-button ${snapshot.favorite ? 'is-favorite' : ''}`} aria-label={tr(`${snapshot.favorite ? '取消收藏' : '收藏'} ${snapshot.label}`, `${snapshot.favorite ? 'Unfavorite' : 'Favorite'} ${snapshot.label}`)} title={snapshot.favorite ? tr('取消收藏', 'Unfavorite') : tr('收藏', 'Favorite')} disabled={snapshot.corrupted || snapshot.purgePending || busy} onClick={() => action('favorite', snapshot)}><Star size={16}/></button>
            <button className="load-button" disabled={snapshot.corrupted || busy || game.pathStatus !== 'ready'} onClick={() => action('restore', snapshot)}><RotateCcw size={14}/>{tr('读档', 'Load')}</button>
          </>}<div className="menu-anchor"><button className="icon-button" aria-label={tr(`${snapshot.label} 更多操作`, `More actions for ${snapshot.label}`)} aria-expanded={menu === snapshot.id} title={tr('更多操作', 'More actions')} onClick={event => { event.stopPropagation(); setMenuAbove(event.currentTarget.getBoundingClientRect().bottom + 290 > window.innerHeight); onMenu(menu === snapshot.id ? null : snapshot.id); }}><MoreHorizontal size={19}/></button>{menu === snapshot.id && menus(snapshot)}</div></div>
        </div>)}
      </div> : <div className="empty-state"><div className="empty-orbit"><Archive size={29}/><span/><i/></div><h3>{query ? tr('没有找到匹配的存档', 'No matching saves found') : filter === 'trash' ? tr('回收站是空的', 'Trash is empty') : filter === 'favorite' ? tr('把重要的时刻收藏起来', 'Star your favorite moments') : filter === 'protected' ? tr('为重要存档加上保护标记', 'Protect your important saves') : tr('故事正在开始，存下第一个时刻', 'Your story begins—save your first moment')}</h3><p>{query ? tr('试试其他关键词，或清空搜索条件。', 'Try another keyword or clear the search filter.') : filter === 'trash' ? tr('可多选或全选后找回；在此永久删除会移除真实文件，无法恢复。', 'Select items to recover, or permanently delete them from disk (cannot be undone).') : filter === 'favorite' ? tr('点击存档旁的星标；收藏会保留原来的存档与身份。', 'Click the star next to any save to mark it as a favorite.') : filter === 'protected' ? tr('标记保护后会显示在这里，且必须先取消保护才能删除；不会生成副本。', 'Protected saves appear here and cannot be deleted until unprotected.') : tr('关闭游戏后创建存档，为下一次冒险留下一个起点。', 'Close your game and create a save to mark a starting point for your next adventure.')}</p>{filter === 'all' && !query && <button className="button secondary" disabled={busy} onClick={onCreate}><PlusIcon/>{tr('创建第一份存档', 'Create First Save')}</button>}{query && <button className="text-button" onClick={() => onViewChange({ query: '', selectedIds: [] })}>{tr('清空搜索', 'Clear Search')}</button>}</div>}
    </div>
    <div className="list-footnote"><ShieldCheck size={14}/><span>{tr('自动备份保存在「读档恢复点」，不计入存档数量。', 'Automatic backups are kept in Restore Points and not counted in Total Saves.')}</span><span className="footnote-right">{tr(`当前列表 · ${list.length} 份存档`, `Showing · ${list.length} save(s)`)}</span></div>
  </section>;
}

export function SelectionCheckbox({ checked, mixed = false, disabled, label, onChange }: { checked: boolean; mixed?: boolean; disabled?: boolean; label: string; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <label className="selection-checkbox"><input ref={ref} type="checkbox" checked={checked} aria-label={label} aria-checked={mixed ? 'mixed' : checked} disabled={disabled} onChange={onChange}/></label>;
}

function PlusIcon() { return <span aria-hidden="true" className="plus-icon">＋</span>; }
