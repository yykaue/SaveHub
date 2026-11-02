import { useState } from 'react';
import { Check, Copy, Info, ShieldCheck } from 'lucide-react';
import { formatBytes, fullDate } from './format';
import type { ImportAction, ImportDecision, ImportItem, ImportPlan, ImportReport, Snapshot } from './types';

const actions: { value: ImportAction; label: string }[] = [
  { value: 'overwrite', label: '覆盖' }, { value: 'skip', label: '跳过' }, { value: 'keep-both', label: '两者并存' },
];
const canOverwrite = (snapshot: Snapshot) => !snapshot.protected && !snapshot.deletedAt && !snapshot.purgePending && !snapshot.corrupted && snapshot.kind !== 'safety';
const initialTarget = (item: ImportItem) => item.matches.find(canOverwrite) || item.matches[0];
const targetDescription = (snapshot: Snapshot) => `${snapshot.label} · ${fullDate(snapshot.createdAt)} · ${formatBytes(snapshot.bytes)}${snapshot.protected ? ' · 已保护' : ''}${snapshot.deletedAt ? ' · 回收站' : ''}${snapshot.kind === 'safety' ? ' · 读档恢复点' : ''}${snapshot.purgePending ? ' · 永久删除未完成' : ''}`;

export function ImportConflicts({ plan, busy, onCancel, onConfirm }: {
  plan: ImportPlan; busy: boolean; onCancel: () => void; onConfirm: (decisions: ImportDecision[]) => void;
}) {
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
      <p className="dialog-description">发现 {duplicates.length} 份重复存档</p>
      <p className="muted">请为每份存档选择处理方式，选完后统一执行。{newCount > 0 && `另有 ${newCount} 份新存档，将在确认后一并导入。`}</p>
      <div className="import-rules"><p><strong>覆盖</strong> 替换指定记录的内容与名称、备注，保留其创建时间和收藏标记。</p><p><strong>跳过</strong> 保留已有记录，本次不导入。</p><p><strong>两者并存</strong> 保留已有记录，另存一份带编号的新存档。</p></div>
      <div className="import-bulk" aria-label="批量设置重复存档">
        <span>批量设置</span>
        <button type="button" className="button secondary" disabled={!duplicates.every(item => item.matches.some(canOverwrite))} onClick={() => applyAll('overwrite')}>全部覆盖</button>
        <button type="button" className="button secondary" onClick={() => applyAll('skip')}>全部跳过</button>
        <button type="button" className="button secondary" onClick={() => applyAll('keep-both')}>全部并存</button>
      </div>
      <div className="import-conflict-list">
        {duplicates.map((item, index) => {
          const choice = choices[item.id];
          const target = item.matches.find(snapshot => snapshot.id === choice.targetId)!;
          return <section className="import-conflict" key={item.id} data-import-id={item.id} aria-label={`重复存档 ${item.name}`}>
            <div className="import-conflict-heading"><span>{String(index + 1).padStart(2, '0')}</span><div><h3>{item.name}</h3><small>待导入 · {item.fileCount} 个文件 · {formatBytes(item.bytes)}</small></div></div>
            <p className="import-source" title={item.source}>{item.source}</p>
            {item.matches.length > 1 ? <label className="import-target">对应已有记录（{item.matches.length} 份）<select aria-label={`${item.name} 的覆盖目标`} value={target.id} onChange={event => {
              const next = item.matches.find(snapshot => snapshot.id === event.target.value)!;
              setChoices(previous => ({ ...previous, [item.id]: { ...previous[item.id], targetId: next.id, action: choice.action === 'overwrite' && !canOverwrite(next) ? 'skip' : choice.action } }));
            }}>{item.matches.map(snapshot => <option value={snapshot.id} key={snapshot.id}>{targetDescription(snapshot)} · {snapshot.id.slice(0, 8)}</option>)}</select></label>
              : <p className="import-existing">已有：{targetDescription(target)}</p>}
            {!canOverwrite(target) && <p className="import-protected"><ShieldCheck size={14}/>该记录不能覆盖，可选择跳过或两者并存。</p>}
            <fieldset className="import-options" aria-label={`${item.name} 的处理方式`}>
              {actions.map(action => <label key={action.value} className={choice.action === action.value ? 'selected' : undefined}>
                <input type="radio" name={`import-${item.id}`} value={action.value} checked={choice.action === action.value} disabled={action.value === 'overwrite' && !canOverwrite(target)} onChange={() => setAction(item, action.value)}/>{action.label}
              </label>)}
            </fieldset>
          </section>;
        })}
        {plan.failed.length > 0 && <div className="notice error"><Info size={15}/> 检查时有 {plan.failed.length} 份无法导入：{plan.failed.map((item, index) => <p key={index}>{item.name}：{item.error}</p>)}</div>}
      </div>
      <div className="import-confirm-footer">
        <p className="import-choice-summary" role="status">新导入 {newCount} · 覆盖 {count('overwrite')} · 跳过 {count('skip')} · 两者并存 {count('keep-both')}</p>
        <div className="dialog-actions"><button type="button" className="button secondary" onClick={onCancel}>取消</button><button type="submit" className="button primary"><Check size={15}/>执行导入</button></div>
      </div>
    </fieldset>
  </form>;
}

export function ImportResult({ report, onClose }: { report: ImportReport; onClose: () => void }) {
  const groups = [{ name: '新导入', items: report.imported }, { name: '已覆盖', items: report.overwritten }, { name: '两者并存', items: report.keptBoth }, { name: '已跳过', items: report.skipped }];
  return <><div className="import-summary">{groups.map(group => <span key={group.name}><strong>{group.items.length}</strong>{group.name}</span>)}<span><strong>{report.failed.length}</strong>未能导入</span></div>
    <p className="muted">导入源文件已保留。新导入、覆盖和并存的存档可在时光轴中查看。</p>
    {groups.filter(group => group.items.length).map(group => <section className="import-result-group" key={group.name}><h3>{group.name}</h3><div className="report-list">{group.items.map((name, index) => <p key={index}>{group.name === '两者并存' ? <Copy size={14}/> : <Check size={14}/>}<span>{name}</span></p>)}</div></section>)}
    {report.failed.map((item, index) => <div className="notice error" key={index}><strong>{item.name}</strong><p>{item.error}</p></div>)}
    <div className="dialog-actions"><button className="button primary" onClick={onClose}>完成</button></div></>;
}
