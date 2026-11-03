import { useState } from 'react';
import { Check, Copy, Info, ShieldCheck } from 'lucide-react';
import { formatBytes, fullDate, tr } from './format';
import type { ImportAction, ImportDecision, ImportItem, ImportPlan, ImportReport, Snapshot } from './types';

const canOverwrite = (snapshot: Snapshot) => !snapshot.protected && !snapshot.deletedAt && !snapshot.purgePending && !snapshot.corrupted && snapshot.kind !== 'safety';
const initialTarget = (item: ImportItem) => item.matches.find(canOverwrite) || item.matches[0];
const targetDescription = (snapshot: Snapshot) => `${snapshot.label} · ${fullDate(snapshot.createdAt)} · ${formatBytes(snapshot.bytes)}${snapshot.protected ? tr(' · 已保护', ' · Protected') : ''}${snapshot.deletedAt ? tr(' · 回收站', ' · Trash') : ''}${snapshot.kind === 'safety' ? tr(' · 读档恢复点', ' · Restore Point') : ''}${snapshot.purgePending ? tr(' · 永久删除未完成', ' · Pending Deletion') : ''}`;

export function ImportConflicts({ plan, busy, onCancel, onConfirm }: {
  plan: ImportPlan; busy: boolean; onCancel: () => void; onConfirm: (decisions: ImportDecision[]) => void;
}) {
  const actions: { value: ImportAction; label: string }[] = [
    { value: 'overwrite', label: tr('覆盖', 'Overwrite') }, { value: 'skip', label: tr('跳过', 'Skip') }, { value: 'keep-both', label: tr('两者并存', 'Keep Both') },
  ];
  const duplicates = plan.items.filter(item => item.matches.length);
  const newCount = plan.items.length - duplicates.length;
  const [choices, setChoices] = useState<Record<string, ImportDecision>>(() => Object.fromEntries(duplicates.map(item => [item.id, { itemId: item.id, action: 'skip', targetId: initialTarget(item).id }])));
  const setAction = (item: ImportItem, action: ImportAction) => setChoices(previous => ({ ...previous, [item.id]: { ...previous[item.id], action } }));
  const applyAll = (action: ImportAction) => setChoices(previous => Object.fromEntries(duplicates.map(item => {
    const choice = previous[item.id];
    const target = item.matches.find(snapshot => snapshot.id === choice.targetId && canOverwrite(snapshot)) || initialTarget(item);
    return [item.id, { ...choice, action, targetId: action === 'overwrite' ? target.id : choice.targetId }];
  })));
  const count = (action: ImportAction) => Object.values(choices).filter(choice => choice.action === action).length;
  return <form className="import-conflicts" onSubmit={event => { event.preventDefault(); if (!busy) onConfirm(duplicates.map(item => choices[item.id])); }}>
    <fieldset disabled={busy}>
      <p className="dialog-description">{tr(`发现 ${duplicates.length} 份重复存档`, `Found ${duplicates.length} duplicate save(s)`)}</p>
      <p className="muted">{tr('请为每份存档选择处理方式，选完后统一执行。', 'Choose how to handle each duplicate save, then apply all at once.')}{newCount > 0 && tr(`另有 ${newCount} 份新存档，将在确认后一并导入。`, ` ${newCount} new save(s) will also be imported upon confirmation.`)}</p>
      <div className="import-rules"><p><strong>{tr('覆盖', 'Overwrite')}</strong> {tr('替换指定记录的内容与名称、备注，保留其创建时间和收藏标记。', 'Replaces the target save content, name, and note while keeping its creation time and favorite flag.')}</p><p><strong>{tr('跳过', 'Skip')}</strong> {tr('保留已有记录，本次不导入。', 'Keeps the existing record and skips importing this item.')}</p><p><strong>{tr('两者并存', 'Keep Both')}</strong> {tr('保留已有记录，另存一份带编号的新存档。', 'Keeps the existing record and imports a new numbered save alongside it.')}</p></div>
      <div className="import-bulk" aria-label={tr('批量设置重复存档', 'Bulk set duplicate saves')}>
        <span>{tr('批量设置', 'Bulk Action')}</span>
        <button type="button" className="button secondary" disabled={!duplicates.every(item => item.matches.some(canOverwrite))} onClick={() => applyAll('overwrite')}>{tr('全部覆盖', 'Overwrite All')}</button>
        <button type="button" className="button secondary" onClick={() => applyAll('skip')}>{tr('全部跳过', 'Skip All')}</button>
        <button type="button" className="button secondary" onClick={() => applyAll('keep-both')}>{tr('全部并存', 'Keep Both All')}</button>
      </div>
      <div className="import-conflict-list">
        {duplicates.map((item, index) => {
          const choice = choices[item.id];
          const target = item.matches.find(snapshot => snapshot.id === choice.targetId)!;
          return <section className="import-conflict" key={item.id} data-import-id={item.id} aria-label={tr(`重复存档 ${item.name}`, `Duplicate save ${item.name}`)}>
            <div className="import-conflict-heading"><span>{String(index + 1).padStart(2, '0')}</span><div><h3>{item.name}</h3><small>{tr(`待导入 · ${item.fileCount} 个文件 · ${formatBytes(item.bytes)}`, `Pending import · ${item.fileCount} file(s) · ${formatBytes(item.bytes)}`)}</small></div></div>
            <p className="import-source" title={item.source}>{item.source}</p>
            {item.matches.length > 1 ? <label className="import-target">{tr(`对应已有记录（${item.matches.length} 份）`, `Matching existing saves (${item.matches.length})`)}<select aria-label={tr(`${item.name} 的覆盖目标`, `Overwrite target for ${item.name}`)} value={target.id} onChange={event => {
              const next = item.matches.find(snapshot => snapshot.id === event.target.value)!;
              setChoices(previous => ({ ...previous, [item.id]: { ...previous[item.id], targetId: next.id, action: choice.action === 'overwrite' && !canOverwrite(next) ? 'skip' : choice.action } }));
            }}>{item.matches.map(snapshot => <option value={snapshot.id} key={snapshot.id}>{targetDescription(snapshot)} · {snapshot.id.slice(0, 8)}</option>)}</select></label>
              : <p className="import-existing">{tr('已有：', 'Existing: ')}{targetDescription(target)}</p>}
            {!canOverwrite(target) && <p className="import-protected"><ShieldCheck size={14}/>{tr('该记录不能覆盖，可选择跳过或两者并存。', 'This record cannot be overwritten. Please choose Skip or Keep Both.')}</p>}
            <fieldset className="import-options" aria-label={tr(`${item.name} 的处理方式`, `Action for ${item.name}`)}>
              {actions.map(action => <label key={action.value} className={choice.action === action.value ? 'selected' : undefined}>
                <input type="radio" name={`import-${item.id}`} value={action.value} checked={choice.action === action.value} disabled={action.value === 'overwrite' && !canOverwrite(target)} onChange={() => setAction(item, action.value)}/>{action.label}
              </label>)}
            </fieldset>
          </section>;
        })}
        {plan.failed.length > 0 && <div className="notice error"><Info size={15}/> {tr(`检查时有 ${plan.failed.length} 份无法导入：`, `${plan.failed.length} item(s) could not be prepared for import:`)}{plan.failed.map((item, index) => <p key={index}>{item.name}：{item.error}</p>)}</div>}
      </div>
      <div className="import-confirm-footer">
        <p className="import-choice-summary" role="status">{tr(`新导入 ${newCount} · 覆盖 ${count('overwrite')} · 跳过 ${count('skip')} · 两者并存 ${count('keep-both')}`, `New ${newCount} · Overwrite ${count('overwrite')} · Skip ${count('skip')} · Keep Both ${count('keep-both')}`)}</p>
        <div className="dialog-actions"><button type="button" className="button secondary" onClick={onCancel}>{tr('取消', 'Cancel')}</button><button type="submit" className="button primary"><Check size={15}/>{tr('执行导入', 'Import Now')}</button></div>
      </div>
    </fieldset>
  </form>;
}

export function ImportResult({ report, onClose }: { report: ImportReport; onClose: () => void }) {
  const groups = [
    { key: 'imported', name: tr('新导入', 'Imported'), items: report.imported },
    { key: 'overwritten', name: tr('已覆盖', 'Overwritten'), items: report.overwritten },
    { key: 'kept-both', name: tr('两者并存', 'Kept Both'), items: report.keptBoth },
    { key: 'skipped', name: tr('已跳过', 'Skipped'), items: report.skipped },
  ];
  return <><div className="import-summary">{groups.map(group => <span key={group.key}><strong>{group.items.length}</strong>{group.name}</span>)}<span><strong>{report.failed.length}</strong>{tr('未能导入', 'Failed')}</span></div>
    <p className="muted">{tr('导入源文件已保留。新导入、覆盖和并存的存档可在时光轴中查看。', 'Source files were preserved. Newly imported, overwritten, and coexisting saves are available in the timeline.')}</p>
    {groups.filter(group => group.items.length).map(group => <section className="import-result-group" key={group.key}><h3>{group.name}</h3><div className="report-list">{group.items.map((name, index) => <p key={index}>{group.key === 'kept-both' ? <Copy size={14}/> : <Check size={14}/>}<span>{name}</span></p>)}</div></section>)}
    {report.failed.map((item, index) => <div className="notice error" key={index}><strong>{item.name}</strong><p>{item.error}</p></div>)}
    <div className="dialog-actions"><button className="button primary" onClick={onClose}>{tr('完成', 'Done')}</button></div></>;
}
