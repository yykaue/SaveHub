import { Download, History, RotateCcw, Trash2 } from 'lucide-react';
import { formatBytes, fullDate, tr } from './format';
import { SelectionCheckbox } from './SnapshotList';
import type { Snapshot } from './types';

export type PointSelection = { active: string[]; removed: string[] };

export function RestorePoints({ points, selection, busy, canRestore, onSelect, onRestore, onExport, onDelete, onRecover }: {
  points: Snapshot[];
  selection: PointSelection;
  busy: boolean;
  canRestore: boolean;
  onSelect: (group: keyof PointSelection, ids: string[]) => void;
  onRestore: (snapshot: Snapshot) => void;
  onExport: (snapshot: Snapshot) => void;
  onDelete: (snapshots: Snapshot[]) => void;
  onRecover: (ids: string[]) => void;
}) {
  function group(removed: boolean) {
    const key = removed ? 'removed' : 'active';
    const rows = points.filter(point => Boolean(point.deletedAt) === removed);
    const selectable = rows.filter(point => !point.corrupted);
    const selected = selectable.filter(point => selection[key].includes(point.id));
    const allSelected = selectable.length > 0 && selected.length === selectable.length;
    const containsProtected = selected.some(point => point.protected);
    const containsPending = selected.some(point => point.purgePending);
    const title = removed ? tr('已移除的恢复点', 'Removed Restore Points') : tr('读档恢复点', 'Restore Points');
    return <section className="restore-points-group" aria-label={title}>
      <div className="restore-point-toolbar">
        <label><SelectionCheckbox label={tr(`全选${title}`, `Select all ${title}`)} checked={allSelected} mixed={selected.length > 0 && !allSelected} disabled={busy || !selectable.length} onChange={() => onSelect(key, allSelected ? [] : selectable.map(point => point.id))}/>{tr('全选', 'Select All')}</label>
        <span aria-live="polite">{tr(`已选 ${selected.length} / ${selectable.length} 份`, `Selected ${selected.length} / ${selectable.length}`)}</span>
        {removed && <button className="button secondary small" disabled={busy || !selected.length || containsPending} onClick={() => onRecover(selected.map(point => point.id))}><RotateCcw size={14}/>{tr('找回所选', 'Recover Selected')}</button>}
        <button className="button secondary small danger-text" disabled={busy || !selected.length || containsProtected} title={containsProtected ? tr('保护存档不可删除，请先取消保护标记', 'Protected saves cannot be deleted. Unprotect them first.') : undefined} onClick={() => onDelete(selected)}><Trash2 size={14}/>{removed ? tr('永久删除所选', 'Delete Permanently') : tr('移除所选', 'Remove Selected')}</button>
      </div>
      <div className="restore-points-list">
        {rows.map(point => <div className="restore-point" key={point.id}>
          <SelectionCheckbox label={tr(`选择恢复点 ${point.label}`, `Select restore point ${point.label}`)} checked={selected.some(item => item.id === point.id)} disabled={busy || point.corrupted} onChange={() => onSelect(key, selection[key].includes(point.id) ? selection[key].filter(id => id !== point.id) : [...selection[key], point.id])}/>
          <History size={18}/><div><strong>{point.label}</strong><small>{fullDate(point.createdAt)} · {formatBytes(point.bytes)}{point.purgePending ? tr(' · 永久删除未完成，只能继续清理', ' · Deletion incomplete, retry to finish') : ''}</small></div>
          {removed
            ? <button className="load-button" disabled={busy || point.corrupted || point.purgePending} onClick={() => onRecover([point.id])}><RotateCcw size={14}/>{tr('找回', 'Recover')}</button>
            : <><button className="load-button" disabled={busy || point.corrupted || !canRestore} onClick={() => onRestore(point)}><RotateCcw size={14}/>{tr('恢复', 'Restore')}</button><button className="icon-button" aria-label={tr(`导出恢复点 ${point.label}`, `Export restore point ${point.label}`)} disabled={busy || point.corrupted} onClick={() => onExport(point)}><Download size={15}/></button></>}
          <button className="icon-button danger-text" aria-label={tr(`${removed ? '永久删除恢复点' : '移除恢复点'} ${point.label}`, `${removed ? 'Permanently delete restore point' : 'Remove restore point'} ${point.label}`)} disabled={busy || point.corrupted || point.protected} onClick={() => onDelete([point])}><Trash2 size={15}/></button>
        </div>)}
        {!rows.length && <div className="quiet-empty">{removed ? tr('没有已移除的恢复点。', 'No removed restore points.') : tr('还没有读档恢复点。第一次读档前会自动创建。', 'No restore points yet. One is created automatically before your first restore.')}</div>}
      </div>
    </section>;
  }
  return <>
    <p className="form-description">{tr('每次读档前自动保存当前进度，保存成功后才继续读档。恢复点单独管理，不计入全部存档。', 'Current progress is automatically backed up and verified before every restore. Restore points are managed separately and not counted toward Total Saves.')}</p>
    {group(false)}
    <details className="removed-points"><summary>{tr(`已移除的恢复点（${points.filter(point => point.deletedAt).length}）`, `Removed Restore Points (${points.filter(point => point.deletedAt).length})`)}</summary><p className="muted">{tr('可多选或全选后找回。在此永久删除会从磁盘移除文件，无法恢复。', 'Select items to recover, or permanently delete them from disk (cannot be undone).')}</p>{group(true)}</details>
  </>;
}
