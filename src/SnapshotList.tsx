import { useEffect, useRef, useState } from 'react';
import { Archive, ArrowDown, ArrowRight, ArrowUp, ArrowUpDown, Download, FileBox, FolderOpen, History, Info, MoreHorizontal, Pencil, RotateCcw, Search, ShieldCheck, ShieldOff, Star, Trash2, Upload, X } from 'lucide-react';
import { dateLabel, formatBytes, kinds } from './format';
import type { Game, Snapshot } from './types';

export type Filter = 'all' | 'favorite' | 'protected' | 'trash';
export type SortKey = 'label' | 'createdAt' | 'bytes';
export interface LibraryView { filter: Filter; query: string; sort: { key: SortKey; direction: 'asc' | 'desc' }; selectedIds: string[] }
export const defaultView: LibraryView = { filter: 'all', query: '', sort: { key: 'createdAt', direction: 'desc' }, selectedIds: [] };
export type SnapshotAction = 'detail' | 'edit' | 'verify' | 'export' | 'delete' | 'favorite' | 'protect' | 'restore' | 'recover';
const filterLabels: Record<Filter, string> = { all: '全部存档', favorite: '已收藏', protected: '保护存档', trash: '回收站' };

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
  const saves = game.snapshots.filter(snapshot => !snapshot.deletedAt);
  const tabSnapshots = game.snapshots.filter(snapshot => matchesFilter(snapshot, filter));
  const tabScope = `「${filterLabels[filter]}」标签页的全部 ${tabSnapshots.length} 份存档，不受搜索影响`;
  const list = tabSnapshots.filter(snapshot => `${snapshot.label} ${snapshot.note || ''}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => {
    let comparison;
    if (sort.key === 'label') comparison = a.label.localeCompare(b.label, 'zh-CN', { numeric: true, sensitivity: 'base' });
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
    <button className={`sort-heading ${sort.key === key ? 'sorted' : ''}`} onClick={() => changeSort(key)} aria-label={`${label}排序`} title={`按${label}${nextDirection(key) === 'desc' ? '倒序' : '正序'}排列`}>
      {label}{sort.key !== key ? <ArrowUpDown size={12}/> : sort.direction === 'asc' ? <ArrowUp size={12}/> : <ArrowDown size={12}/>}
    </button>
  </div>;
  const menus = (snapshot: Snapshot) => <div className={`dropdown ${menuAbove ? 'above' : ''}`} role="menu" onClick={event => event.stopPropagation()}>
    <button role="menuitem" onClick={() => action('detail', snapshot)}><Info size={15}/>存档详情</button>
    <button role="menuitem" disabled={snapshot.corrupted || snapshot.purgePending || busy} onClick={() => action('edit', snapshot)}><Pencil size={15}/>编辑名称和备注</button>
    <button role="menuitem" disabled={!!snapshot.deletedAt || snapshot.corrupted || snapshot.purgePending || busy} title={snapshot.deletedAt ? '请先找回存档，再修改保护标记' : undefined} onClick={() => action('protect', snapshot)}><ShieldCheck size={15}/>{snapshot.protected ? '取消保护标记' : '标记为保护存档'}</button>
    <button role="menuitem" disabled={snapshot.corrupted || snapshot.purgePending || busy} onClick={() => action('verify', snapshot)}><ShieldCheck size={15}/>校验完整性</button>
    <button role="menuitem" disabled={snapshot.corrupted || snapshot.purgePending || busy} onClick={() => action('export', snapshot)}><Download size={15}/>导出存档</button>
    <div className="menu-divider"/>
    {snapshot.deletedAt && <button role="menuitem" disabled={snapshot.corrupted || snapshot.purgePending || busy} onClick={() => action('recover', snapshot)}><RotateCcw size={15}/>找回存档</button>}
    <button role="menuitem" className="danger-text" disabled={snapshot.corrupted || busy || snapshot.protected} title={snapshot.protected ? '保护存档不可删除，请先取消保护标记' : undefined} onClick={() => action('delete', snapshot)}><Trash2 size={15}/>{snapshot.deletedAt ? '永久删除' : '移入回收站'}</button>
  </div>;

  return <section className="snapshots-section">
    <div className="section-heading">
      <div><h2>存档时光轴 <span>{String(ordinaryCount).padStart(2, '0')}</span></h2><p>收藏用于标记；保护存档需先取消保护才能删除。</p></div>
      <div className="section-actions">
        <button className="text-button" disabled={busy} onClick={onRestorePoints}><History size={15}/>读档恢复点 <span className="count-pill">{game.restorePoints.filter(point => !point.deletedAt).length}</span></button>
        <button className="text-button" disabled={busy} onClick={() => onImport(false)}><Upload size={15}/>导入存档</button>
        <button className="icon-button" title="打开备份文件夹" aria-label="打开备份文件夹" onClick={onFolder}><FolderOpen size={17}/></button>
      </div>
    </div>
    <div className="list-toolbar">
      <div className="filter-tabs" role="tablist" aria-label="存档筛选">{([{ id: 'all', text: '全部存档' }, { id: 'favorite', text: '已收藏' }, { id: 'protected', text: '保护存档' }, { id: 'trash', text: '回收站' }] as const).map(tab =>
        <button role="tab" aria-label={tab.text} aria-selected={filter === tab.id} className={filter === tab.id ? 'active' : ''} key={tab.id} onClick={() => onViewChange({ filter: tab.id, selectedIds: [] })}>
          {tab.id === 'favorite' && <Star size={13}/>} {tab.text}<span>{game.snapshots.filter(snapshot => matchesFilter(snapshot, tab.id)).length}</span>
        </button>)}</div>
      <label className="search-field"><Search size={15}/><input placeholder="搜索名称或备注…" aria-label="搜索存档" value={query} onChange={event => onViewChange({ query: event.target.value, selectedIds: [] })}/>{query && <button title="清空搜索" onClick={() => onViewChange({ query: '', selectedIds: [] })}><X size={13}/></button>}</label>
    </div>
    <div className={`batch-toolbar ${selected.length ? 'has-selection' : ''}`}>
      <span className="selection-summary" aria-live="polite">{selected.length ? <>已选 <strong>{selected.length}</strong> 份{selectedProtected > 0 && (filter === 'trash' ? ' · 含保护存档，需找回并取消保护后才能删除' : ' · 含保护存档，删除前需取消保护')}</> : filter === 'trash' ? '勾选存档，可批量找回、永久删除或导出' : '勾选存档，可批量保护、删除或导出'}</span>
      {selected.length > 0 && <button className="text-button clear-selection" disabled={busy} onClick={() => onViewChange({ selectedIds: [] })}>取消选择</button>}
      <div className="batch-actions">
        <button className={`button secondary small protection-action ${protectSelected ? 'protect' : 'unprotect'}`} disabled={filter === 'trash' || !selected.length || selectedTrashed || selectedPending || busy} title={filter === 'trash' || selectedTrashed ? '请先找回存档，再修改保护标记' : undefined} onClick={() => onProtect(selected.map(snapshot => snapshot.id), protectSelected)}>{protectSelected ? <ShieldCheck size={14}/> : <ShieldOff size={14}/>}{protectSelected ? '所选保护' : '所选取消保护'}</button>
        {filter !== 'trash' && <button className={`button secondary small protection-action ${protectAll ? 'protect' : 'unprotect'}`} disabled={!tabSnapshots.length || busy} title={`${protectAll ? '保护' : '取消保护'}${tabScope}。`} onClick={() => onProtect(tabSnapshots.map(snapshot => snapshot.id), protectAll)}>{protectAll ? <ShieldCheck size={14}/> : <ShieldOff size={14}/>}{protectAll ? '全部保护' : '全部取消保护'}</button>}
        {filter === 'trash' && <button className="button secondary small" disabled={!selected.length || selectedPending || busy} onClick={() => onRecover(selected.map(snapshot => snapshot.id))}><RotateCcw size={14}/>找回所选</button>}
        <button className="button secondary small danger-text" disabled={!selected.length || busy || selectedProtected > 0} title={selectedProtected ? '所选记录含保护存档，请先取消保护标记' : undefined} onClick={() => onDelete(selected)}><Trash2 size={14}/>{filter === 'trash' ? '永久删除所选' : '删除所选'}</button>
        <button className="button secondary small" disabled={!selected.length || selectedPending || busy} onClick={() => onExport(selected.map(snapshot => snapshot.id))}><Download size={14}/>导出所选</button>
        <button className="button secondary small export-all" disabled={!tabSnapshots.length || busy} title={`导出${tabScope}。`} onClick={() => onExport(tabSnapshots.map(snapshot => snapshot.id))}><Download size={14}/>导出全部</button>
      </div>
    </div>
    <div className="snapshot-results">
      {game.legacyCount > 0 && !saves.some(snapshot => snapshot.kind === 'imported') && filter === 'all' && !query && <div className="import-banner"><div className="import-icon"><History size={19}/></div><div><strong>让过去的冒险，也有归处</strong><p>发现 {game.legacyCount} 个旧存档目录，可从 ArchiveFile 导入。</p></div><button disabled={busy} onClick={() => onImport(true)}>导入旧存档<ArrowRight size={15}/></button></div>}
      {list.length > 0 ? <div className="snapshot-table" role="table" aria-label="游戏存档列表">
        <div className="table-header" role="row">
          <div role="columnheader"><SelectionCheckbox checked={allSelected} mixed={selected.length > 0 && !allSelected} disabled={!selectable.length || busy} label="全选当前列表" onChange={() => onViewChange({ selectedIds: allSelected ? [] : selectable.map(snapshot => snapshot.id) })}/></div>
          {column('label', '存档名称')}{column('createdAt', '创建时间')}{column('bytes', '文件大小')}<div role="columnheader" className="table-end">操作</div>
        </div>
        {list.map(snapshot => <div className={`snapshot-row ${snapshot.corrupted ? 'corrupt' : ''} ${view.selectedIds.includes(snapshot.id) ? 'row-selected' : ''}`} key={snapshot.id} role="row" data-snapshot-id={snapshot.id}>
          <div role="cell"><SelectionCheckbox checked={view.selectedIds.includes(snapshot.id)} disabled={snapshot.corrupted || busy} label={`选择 ${snapshot.label}`} onChange={() => selectRow(snapshot)}/></div>
          <div className="snapshot-info" role="cell"><div className={`snapshot-icon ${snapshot.protected ? 'protected' : snapshot.kind}`}>{snapshot.protected ? <ShieldCheck size={20}/> : snapshot.kind === 'imported' ? <FileBox size={20}/> : <Archive size={20}/>}</div><div className="snapshot-name-block"><button className="snapshot-name" onClick={() => action('detail', snapshot)}>{snapshot.label}{snapshot.favorite && <Star size={12} className="star-filled"/>}</button><div className="snapshot-sub"><span className={`kind-badge ${snapshot.kind}`}>{snapshot.corrupted ? '校验异常' : kinds[snapshot.kind]}</span>{snapshot.protected && <span className="state-tag protected">保护</span>}{snapshot.deletedAt && <span className="state-tag trashed">回收站</span>}{snapshot.purgePending && <span className="state-tag danger-text">永久删除未完成</span>}<span className="snapshot-note">{snapshot.note || '这一刻，已为你妥善保留。'}</span></div></div></div>
          <div className="snapshot-time" role="cell" title={snapshot.createdAt}>{dateLabel(snapshot.createdAt)}<small>{snapshot.platform === 'darwin' ? 'macOS' : 'Windows'}</small></div>
          <div className="snapshot-size" role="cell" data-bytes={snapshot.bytes}>{formatBytes(snapshot.bytes)}<small>{snapshot.fileCount} 个文件</small></div>
          <div className="snapshot-actions" role="cell">{snapshot.deletedAt ? <button className="load-button" disabled={busy || snapshot.corrupted || snapshot.purgePending} onClick={() => action('recover', snapshot)}><RotateCcw size={14}/>找回</button> : <>
            <button className={`icon-button favorite-button ${snapshot.favorite ? 'is-favorite' : ''}`} aria-label={`${snapshot.favorite ? '取消收藏' : '收藏'} ${snapshot.label}`} title={snapshot.favorite ? '取消收藏' : '收藏'} disabled={snapshot.corrupted || snapshot.purgePending || busy} onClick={() => action('favorite', snapshot)}><Star size={16}/></button>
            <button className="load-button" disabled={snapshot.corrupted || busy || game.pathStatus !== 'ready'} onClick={() => action('restore', snapshot)}><RotateCcw size={14}/>读档</button>
          </>}<div className="menu-anchor"><button className="icon-button" aria-label={`${snapshot.label} 更多操作`} aria-expanded={menu === snapshot.id} title="更多操作" onClick={event => { event.stopPropagation(); setMenuAbove(event.currentTarget.getBoundingClientRect().bottom + 290 > window.innerHeight); onMenu(menu === snapshot.id ? null : snapshot.id); }}><MoreHorizontal size={19}/></button>{menu === snapshot.id && menus(snapshot)}</div></div>
        </div>)}
      </div> : <div className="empty-state"><div className="empty-orbit"><Archive size={29}/><span/><i/></div><h3>{query ? '没有找到匹配的存档' : filter === 'trash' ? '回收站是空的' : filter === 'favorite' ? '把重要的时刻收藏起来' : filter === 'protected' ? '为重要存档加上保护标记' : '故事正在开始，存下第一个时刻'}</h3><p>{query ? '试试其他关键词，或清空搜索条件。' : filter === 'trash' ? '可多选或全选后找回；在此永久删除会移除真实文件，无法恢复。' : filter === 'favorite' ? '点击存档旁的星标；收藏会保留原来的存档与身份。' : filter === 'protected' ? '标记保护后会显示在这里，且必须先取消保护才能删除；不会生成副本。' : '关闭游戏后创建存档，为下一次冒险留下一个起点。'}</p>{filter === 'all' && !query && <button className="button secondary" disabled={busy} onClick={onCreate}><PlusIcon/>创建第一份存档</button>}{query && <button className="text-button" onClick={() => onViewChange({ query: '', selectedIds: [] })}>清空搜索</button>}</div>}
    </div>
    <div className="list-footnote"><ShieldCheck size={14}/><span>自动备份保存在「读档恢复点」，不计入存档数量。</span><span className="footnote-right">当前列表 · {list.length} 份存档</span></div>
  </section>;
}

export function SelectionCheckbox({ checked, mixed = false, disabled, label, onChange }: { checked: boolean; mixed?: boolean; disabled?: boolean; label: string; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <label className="selection-checkbox"><input ref={ref} type="checkbox" checked={checked} aria-label={label} aria-checked={mixed ? 'mixed' : checked} disabled={disabled} onChange={onChange}/></label>;
}

function PlusIcon() { return <span aria-hidden="true" className="plus-icon">＋</span>; }
